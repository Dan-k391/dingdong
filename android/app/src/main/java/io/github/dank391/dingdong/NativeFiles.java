package io.github.dank391.dingdong;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.util.Base64;

import androidx.webkit.JavaScriptReplyProxy;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

/** Streams only explicitly accepted downloads to the document selected by the user. */
public final class NativeFiles implements AutoCloseable {
    public static final int REQUEST_CREATE_DOCUMENT = 45003;
    private static final int CHUNK_BYTES = 64 * 1024;
    private static final int MAX_BASE64 = ((CHUNK_BYTES + 2) / 3) * 4;
    private static final long MAX_SAFE_INTEGER = 9007199254740991L;
    private static final Pattern REQUEST_ID = Pattern.compile("[A-Za-z0-9_-]{1,96}");
    private static final Pattern TOKEN = Pattern.compile("[a-f0-9-]{36}");
    private static final Pattern MIME = Pattern.compile("[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+");
    private static final Pattern BASE64 = Pattern.compile("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?");
    private final Activity activity;
    private final ContentResolver resolver;
    private final Handler main = new Handler(Looper.getMainLooper());
    // Per-chunk acknowledgements and a bounded executor prevent whole-file IPC buffering.
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(1, 1, 0L,
            TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(4));
    private final ConcurrentHashMap<String, Session> sessions = new ConcurrentHashMap<>();
    private PendingPicker picker;
    private volatile boolean closed;

    public NativeFiles(Activity activity) {
        this.activity = activity;
        this.resolver = activity.getContentResolver();
    }

    private static final class PendingPicker {
        final String id;
        final String name;
        final JavaScriptReplyProxy reply;
        boolean cancelled;
        PendingPicker(String id, String name, JavaScriptReplyProxy reply) {
            this.id = id;
            this.name = name;
            this.reply = reply;
        }
    }

    private static final class Session {
        final String token = UUID.randomUUID().toString();
        final Uri uri;
        final AtomicBoolean busy = new AtomicBoolean();
        volatile boolean stopped;
        volatile boolean opened;
        volatile boolean committed;
        volatile OutputStream output;
        long position;
        Session(Uri uri) { this.uri = uri; }
    }

    public void handle(JSONObject message, JavaScriptReplyProxy reply) {
        String id = message.optString("id", "");
        if (!REQUEST_ID.matcher(id).matches()) return;
        if (closed) {
            failure(reply, id, "InvalidStateError", "The download host is closed.");
            return;
        }
        try {
            String type = message.getString("type");
            if ("file-pick".equals(type)) {
                pick(message, reply, id);
                return;
            }
            String token = message.getString("token");
            Session session = TOKEN.matcher(token).matches() ? sessions.get(token) : null;
            if (session == null || session.stopped) {
                failure(reply, id, "InvalidStateError", "This download destination is no longer available.");
                return;
            }
            if ("file-abort".equals(type)) {
                abort(session, reply, id);
                return;
            }
            if (!session.busy.compareAndSet(false, true)) {
                failure(reply, id, "InvalidStateError", "Wait for the previous file operation to finish.");
                return;
            }
            try {
                switch (type) {
                    case "file-open":
                        submit(session, reply, id, () -> open(session));
                        break;
                    case "file-write": {
                        long position = integer(message, "position");
                        String data = message.getString("data");
                        if (data.length() > MAX_BASE64 || !BASE64.matcher(data).matches()) {
                            throw new IllegalArgumentException("Invalid download chunk.");
                        }
                        byte[] bytes = Base64.decode(data, Base64.NO_WRAP);
                        if (bytes.length > CHUNK_BYTES ||
                                !Base64.encodeToString(bytes, Base64.NO_WRAP).equals(data)) {
                            throw new IllegalArgumentException("Invalid download chunk.");
                        }
                        submit(session, reply, id, () -> write(session, position, bytes));
                        break;
                    }
                    case "file-close": {
                        long position = integer(message, "position");
                        submit(session, reply, id, () -> finish(session, position));
                        break;
                    }
                    default:
                        throw new IllegalArgumentException("Unsupported file operation.");
                }
            } catch (JSONException | IllegalArgumentException error) {
                session.busy.set(false);
                failure(reply, id, "DataError", error.getMessage());
            }
        } catch (JSONException error) {
            failure(reply, id, "DataError", "Invalid file request.");
        }
    }

    private void pick(JSONObject message, JavaScriptReplyProxy reply, String id) {
        if (picker != null || sessions.size() >= 2) {
            failure(reply, id, "InvalidStateError", "Finish or cancel the current download first.");
            return;
        }
        String name = safeName(message.optString("name", "download"));
        String mime = message.optString("mime", "application/octet-stream");
        if (mime.length() > 127 || !MIME.matcher(mime).matches()) mime = "application/octet-stream";
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, name);
        intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        picker = new PendingPicker(id, name, reply);
        try {
            activity.startActivityForResult(intent, REQUEST_CREATE_DOCUMENT);
        } catch (RuntimeException error) {
            picker = null;
            failure(reply, id, "NotSupportedError", "The device could not open a save destination.");
        }
    }

    public boolean onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_CREATE_DOCUMENT) return false;
        PendingPicker selected = picker;
        picker = null;
        Uri uri = resultCode == Activity.RESULT_OK && data != null ? data.getData() : null;
        if (selected == null || selected.cancelled || closed) {
            if (uri != null && "content".equals(uri.getScheme())) discardUri(uri);
            return true;
        }
        if (uri == null) {
            failure(selected.reply, selected.id, "AbortError", "Download cancelled.");
        } else if (!"content".equals(uri.getScheme())) {
            failure(selected.reply, selected.id, "SecurityError", "Choose a document provider to save this file.");
        } else {
            Session session = new Session(uri);
            sessions.put(session.token, session);
            JSONObject result = new JSONObject();
            try {
                result.put("token", session.token);
                result.put("name", selected.name);
            } catch (JSONException ignored) { }
            success(selected.reply, selected.id, result);
        }
        return true;
    }

    private interface Operation { JSONObject run() throws IOException; }

    private void submit(Session session, JavaScriptReplyProxy reply, String id, Operation operation) {
        try {
            worker.execute(() -> {
                try {
                    if (!session.committed && (session.stopped || closed)) throw new IOException("Download cancelled.");
                    JSONObject result = operation.run();
                    if (!session.committed && (session.stopped || closed)) throw new IOException("Download cancelled.");
                    success(reply, id, result);
                } catch (IOException | RuntimeException error) {
                    boolean cancelled = session.stopped || closed;
                    session.stopped = true;
                    sessions.remove(session.token, session);
                    discard(session);
                    failure(reply, id, cancelled ? "AbortError" : "NotReadableError",
                            cancelled ? "Download cancelled." : "The device could not write this file.");
                } finally {
                    session.busy.set(false);
                }
            });
        } catch (RejectedExecutionException error) {
            session.busy.set(false);
            failure(reply, id, "InvalidStateError", "The device is busy saving another file.");
        }
    }

    private JSONObject open(Session session) throws IOException {
        if (session.opened) throw new IOException("The destination is already open.");
        OutputStream output = resolver.openOutputStream(session.uri, "wt");
        if (output == null) throw new IOException("The destination could not be opened.");
        session.output = output;
        session.opened = true;
        if (session.stopped || closed) throw new IOException("Download cancelled.");
        return new JSONObject();
    }

    private JSONObject write(Session session, long position, byte[] bytes) throws IOException {
        if (!session.opened || session.output == null || position != session.position ||
                session.position > MAX_SAFE_INTEGER - bytes.length) {
            throw new IOException("Invalid sequential write position.");
        }
        session.output.write(bytes);
        session.position += bytes.length;
        JSONObject result = new JSONObject();
        try { result.put("position", session.position); } catch (JSONException ignored) { }
        return result;
    }

    private JSONObject finish(Session session, long position) throws IOException {
        if (!session.opened || session.output == null || position != session.position) {
            throw new IOException("The destination is incomplete.");
        }
        session.output.flush();
        session.output.close();
        session.output = null;
        if (session.stopped || closed) throw new IOException("Download cancelled.");
        session.committed = true;
        sessions.remove(session.token, session);
        return new JSONObject();
    }

    private void abort(Session session, JavaScriptReplyProxy reply, String id) {
        session.stopped = true;
        sessions.remove(session.token, session);
        try {
            worker.execute(() -> {
                discard(session);
                success(reply, id, new JSONObject());
            });
        } catch (RejectedExecutionException error) {
            // The current operation observes stopped and cleans up before acknowledging.
            failure(reply, id, "InvalidStateError", "The device is still cancelling the download.");
        }
    }

    private void discard(Session session) {
        if (session.committed) return;
        OutputStream output = session.output;
        session.output = null;
        if (output != null) {
            try { output.close(); } catch (IOException ignored) { }
        }
        deleteDocument(session.uri);
    }

    private void deleteDocument(Uri uri) {
        try { DocumentsContract.deleteDocument(resolver, uri); } catch (Exception ignored) {
            // Providers that do not support deletion may retain a user-chosen partial document.
        }
    }

    private void discardUri(Uri uri) {
        try { worker.execute(() -> deleteDocument(uri)); } catch (RejectedExecutionException ignored) { }
    }

    /** Cancel page-owned sessions before navigation. No broad storage grant is retained. */
    public void reset() {
        if (picker != null && !picker.cancelled) {
            picker.cancelled = true;
            failure(picker.reply, picker.id, "AbortError", "Download cancelled because the page changed.");
        }
        for (Session session : new ArrayList<>(sessions.values())) {
            session.stopped = true;
            sessions.remove(session.token, session);
            try { worker.execute(() -> discard(session)); } catch (RejectedExecutionException ignored) { }
        }
    }

    @Override public void close() {
        if (closed) return;
        closed = true;
        reset();
        // Submitted cleanup runs after the current bounded disk operation.
        worker.shutdown();
    }

    private static long integer(JSONObject message, String key) throws JSONException {
        Object value = message.get(key);
        if (!(value instanceof Number)) throw new JSONException("Invalid write position.");
        double number = ((Number) value).doubleValue();
        if (!Double.isFinite(number) || number < 0 || number > MAX_SAFE_INTEGER || Math.floor(number) != number) {
            throw new JSONException("Invalid write position.");
        }
        return (long) number;
    }

    private static String safeName(String raw) {
        if (raw.length() > 4096) raw = raw.substring(0, 4096);
        String name = raw.replaceAll("[\\p{Cntrl}\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069/\\\\:*?\"<>|]", "_").trim();
        if (name.length() > 255) name = name.substring(0, 255);
        name = name.replaceAll("[ .]+$", "");
        return name.isEmpty() || name.equals(".") || name.equals("..") ? "download" : name;
    }

    private void success(JavaScriptReplyProxy reply, String id, JSONObject result) {
        JSONObject response = new JSONObject();
        try {
            response.put("id", id);
            response.put("ok", true);
            response.put("result", result);
        } catch (JSONException ignored) { }
        post(reply, response);
    }

    private void failure(JavaScriptReplyProxy reply, String id, String name, String text) {
        JSONObject response = new JSONObject();
        JSONObject error = new JSONObject();
        try {
            error.put("name", name);
            error.put("message", text == null ? "The file operation failed." : text);
            response.put("id", id);
            response.put("ok", false);
            response.put("error", error);
        } catch (JSONException ignored) { }
        post(reply, response);
    }

    private void post(JavaScriptReplyProxy reply, JSONObject response) {
        main.post(() -> {
            try { reply.postMessage(response.toString()); } catch (RuntimeException ignored) {
                // The originating document can disappear while disk I/O finishes.
            }
        });
    }
}
