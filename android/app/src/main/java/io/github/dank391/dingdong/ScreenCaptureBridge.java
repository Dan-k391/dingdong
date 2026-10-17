package io.github.dank391.dingdong;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Rect;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.webkit.WebView;

import androidx.webkit.JavaScriptReplyProxy;

import org.json.JSONException;
import org.json.JSONObject;
import org.webrtc.DataChannel;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpParameters;
import org.webrtc.RtpSender;
import org.webrtc.ScreenCapturerAndroid;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/** Supplies a native display track to the existing VDO publisher, without replacing its signaling. */
public final class ScreenCaptureBridge {
    public static final int CAPTURE_REQUEST = 45002;
    private static boolean webRtcInitialized;
    private final Activity activity;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService rtc = Executors.newSingleThreadExecutor(runnable ->
            new Thread(runnable, "DischordScreenCapture"));
    private Session active;
    // A cancelled Android consent dialog can still return later; never apply that result to a retry.
    private Session awaitingConsent;
    private boolean closed;

    public ScreenCaptureBridge(Activity activity, WebView webView) {
        this.activity = activity;
    }

    public void handle(JSONObject message, JavaScriptReplyProxy reply) {
        onUi(() -> handleOnUi(message, reply));
    }

    private void handleOnUi(JSONObject message, JavaScriptReplyProxy reply) {
        String type = message.optString("type");
        String id = message.optString("id");
        if (closed || !id.matches("[A-Za-z0-9_-]{1,80}")) return;
        if ("screen-start".equals(type)) {
            if (active != null || awaitingConsent != null) {
                post(reply, error(id, "InvalidStateError", "A screen-share request is already open."));
                return;
            }
            String offer = message.optString("sdp");
            if (offer.length() > 262144 || !offer.contains("m=video ") || offer.contains("m=audio ")) {
                post(reply, error(id, "TypeError", "Invalid screen-capture offer."));
                return;
            }
            Session session = new Session(id, offer, message.optJSONObject("video"), reply);
            displaySize(session);
            active = session;
            awaitingConsent = session;
            session.timeout = () -> fail(session, "AbortError", "Screen sharing timed out. Please try again.");
            ui.postDelayed(session.timeout, 120000);
            try {
                MediaProjectionManager manager = (MediaProjectionManager)
                        activity.getSystemService(Activity.MEDIA_PROJECTION_SERVICE);
                if (manager == null) throw new IllegalStateException("Screen capture is unavailable.");
                activity.startActivityForResult(manager.createScreenCaptureIntent(), CAPTURE_REQUEST);
            } catch (RuntimeException exception) {
                awaitingConsent = null;
                fail(session, "NotSupportedError", "Android could not open the screen-sharing chooser.");
            }
            return;
        }
        Session session = active;
        if (session == null || !session.id.equals(id) || session.stopped) return;
        switch (type) {
            case "screen-stop":
                stop(session, "Screen sharing stopped.", null);
                break;
            case "screen-ice": {
                JSONObject candidate = message.optJSONObject("candidate");
                if (candidate == null) return;
                String sdp = candidate.optString("candidate");
                int line = candidate.optInt("sdpMLineIndex", -1);
                String mid = candidate.optString("sdpMid", "0");
                if (sdp.isEmpty() || sdp.length() > 8192 || line < 0 || line > 16) return;
                IceCandidate ice = new IceCandidate(mid, line, sdp);
                runRtc(session, () -> {
                    if (session.stopped) return;
                    if (!session.remoteDescriptionSet || session.peer == null) {
                        if (session.remoteCandidates.size() < 128) session.remoteCandidates.add(ice);
                    } else {
                        session.peer.addIceCandidate(ice);
                    }
                });
                break;
            }
            case "screen-constraints": {
                JSONObject video = message.optJSONObject("video");
                String requestId = message.optString("requestId");
                if (video == null || !requestId.matches("[A-Za-z0-9_-]{1,80}")) return;
                runRtc(session, () -> {
                    if (session.stopped || session.capturer == null) return;
                    try {
                        configure(session, video, true);
                        JSONObject result = configuration(session, "screen-config");
                        put(result, "requestId", requestId);
                        send(session, result);
                    } catch (RuntimeException exception) {
                        JSONObject result = configuration(session, "screen-constraints-error");
                        put(result, "requestId", requestId);
                        put(result, "name", "OverconstrainedError");
                        put(result, "message", "This screen-capture setting is not supported by your device.");
                        send(session, result);
                    }
                });
                break;
            }
            default:
                break;
        }
    }

    public boolean onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != CAPTURE_REQUEST) return false;
        onUi(() -> {
            Session session = awaitingConsent;
            awaitingConsent = null;
            if (session == null || session != active || session.stopped || closed) return;
            if (resultCode != Activity.RESULT_OK || data == null) {
                fail(session, "NotAllowedError", "Screen sharing was cancelled.");
                return;
            }
            session.permission = data;
            try {
                ProjectionService.start(activity, this, session.id);
            } catch (RuntimeException exception) {
                fail(session, "NotAllowedError", "Android could not start the screen-sharing service.");
            }
        });
        return true;
    }

    boolean isCurrent(String id) {
        return !closed && active != null && !active.stopped && active.id.equals(id);
    }

    void onForegroundReady(String id) {
        onUi(() -> {
            Session session = active;
            if (!isCurrent(id) || session == null || session.permission == null || session.serviceReady) return;
            session.serviceReady = true;
            ui.removeCallbacks(session.timeout);
            session.timeout = () -> fail(session, "AbortError", "The screen-capture connection did not start. Please try again.");
            ui.postDelayed(session.timeout, 45000);
            runRtc(session, () -> begin(session));
        });
    }

    void onServiceStopped(String id) {
        onUi(() -> {
            if (isCurrent(id)) stop(active, "Screen sharing stopped by Android.", null);
        });
    }

    private void begin(Session session) {
        if (session.stopped) return;
        try {
            synchronized (ScreenCaptureBridge.class) {
                if (!webRtcInitialized) {
                    PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions
                            .builder(activity.getApplicationContext()).createInitializationOptions());
                    webRtcInitialized = true;
                }
            }
            session.egl = EglBase.create();
            PeerConnectionFactory.Options options = new PeerConnectionFactory.Options();
            options.networkIgnoreMask = 0;
            session.factory = PeerConnectionFactory.builder().setOptions(options)
                    .setVideoEncoderFactory(new DefaultVideoEncoderFactory(session.egl.getEglBaseContext(), true, true))
                    .setVideoDecoderFactory(new DefaultVideoDecoderFactory(session.egl.getEglBaseContext()))
                    .createPeerConnectionFactory();
            PeerConnection.RTCConfiguration config = new PeerConnection.RTCConfiguration(Collections.emptyList());
            config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
            config.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY;
            config.enableIceGatheringOnAnyAddressPorts = true;
            session.peer = session.factory.createPeerConnection(config, observer(session));
            if (session.peer == null) throw new IllegalStateException("Local capture peer could not be created.");
            // The bridge carries video only; microphone audio remains in the normal VDO voice publisher.
            session.peer.setAudioRecording(false);
            session.peer.setAudioPlayout(false);
            session.source = session.factory.createVideoSource(true);
            session.texture = SurfaceTextureHelper.create("DischordScreenTexture", session.egl.getEglBaseContext());
            session.capturer = new ScreenCapturerAndroid(session.permission, new MediaProjection.Callback() {
                @Override public void onStop() {
                    onUi(() -> stop(session, "Screen sharing stopped by Android.", null));
                }

                @Override public void onCapturedContentResize(int width, int height) {
                    if (width < 1 || height < 1) return;
                    runRtc(session, () -> {
                        if (session.stopped || session.capturer == null) return;
                        session.sourceWidth = width;
                        session.sourceHeight = height;
                        try {
                            configure(session, true);
                            send(session, configuration(session, "screen-config"));
                        } catch (RuntimeException exception) {
                            // Keep the last working format if a device cannot resize it.
                            // A rotation must not consume another consent or end the share.
                            send(session, configuration(session, "screen-config"));
                        }
                    });
                }
            });
            session.capturer.initialize(session.texture, activity.getApplicationContext(), session.source.getCapturerObserver());
            configure(session, false);
            session.track = session.factory.createVideoTrack("dischord-screen-" + session.id, session.source);
            session.sender = session.peer.addTrack(session.track, Collections.singletonList("dischord-native-screen"));
            // A fresh consent Intent is consumed exactly once for this session.
            session.capturer.startCapture(session.width, session.height, session.fps);
            session.permission = null;
            if (session.stopped) return;
            send(session, configuration(session, "screen-config"));
            session.peer.setRemoteDescription(new SimpleSdpObserver() {
                @Override public void onSetSuccess() {
                    runRtc(session, () -> {
                        if (session.stopped) return;
                        session.remoteDescriptionSet = true;
                        for (IceCandidate candidate : session.remoteCandidates) session.peer.addIceCandidate(candidate);
                        session.remoteCandidates.clear();
                        session.peer.createAnswer(new SimpleSdpObserver() {
                            @Override public void onCreateSuccess(SessionDescription answer) {
                                runRtc(session, () -> setAnswer(session, answer));
                            }
                            @Override public void onCreateFailure(String reason) {
                                fail(session, "OperationError", "The screen-capture answer could not be created.");
                            }
                        }, new MediaConstraints());
                    });
                }
                @Override public void onSetFailure(String reason) {
                    fail(session, "OperationError", "The screen-capture offer could not be accepted.");
                }
            }, new SessionDescription(SessionDescription.Type.OFFER, session.offer));
        } catch (RuntimeException | UnsatisfiedLinkError exception) {
            fail(session, "NotReadableError", "Your device could not start screen capture. Please try again.");
        }
    }

    private void setAnswer(Session session, SessionDescription answer) {
        if (session.stopped || session.peer == null) return;
        session.peer.setLocalDescription(new SimpleSdpObserver() {
            @Override public void onSetSuccess() {
                runRtc(session, () -> {
                    if (session.stopped) return;
                    updateSender(session);
                    JSONObject message = base("screen-answer", session.id);
                    put(message, "sdp", answer.description);
                    send(session, message);
                });
            }
            @Override public void onSetFailure(String reason) {
                fail(session, "OperationError", "The screen-capture answer could not be applied.");
            }
        }, answer);
    }

    private PeerConnection.Observer observer(Session session) {
        return new PeerConnection.Observer() {
            @Override public void onSignalingChange(PeerConnection.SignalingState state) { }
            @Override public void onIceConnectionChange(PeerConnection.IceConnectionState state) {
                if (state == PeerConnection.IceConnectionState.FAILED) {
                    fail(session, "NetworkError", "The local screen-capture connection failed.");
                }
            }
            @Override public void onConnectionChange(PeerConnection.PeerConnectionState state) {
                onUi(() -> {
                    if (session != active || session.stopped) return;
                    if (state == PeerConnection.PeerConnectionState.CONNECTED) {
                        ui.removeCallbacks(session.timeout);
                        if (session.disconnected != null) ui.removeCallbacks(session.disconnected);
                    } else if (state == PeerConnection.PeerConnectionState.DISCONNECTED) {
                        if (session.disconnected != null) ui.removeCallbacks(session.disconnected);
                        session.disconnected = () -> fail(session, "NetworkError", "The local screen-capture connection was interrupted.");
                        ui.postDelayed(session.disconnected, 10000);
                    } else if (state == PeerConnection.PeerConnectionState.FAILED) {
                        fail(session, "NetworkError", "The local screen-capture connection failed.");
                    }
                });
            }
            @Override public void onIceConnectionReceivingChange(boolean receiving) { }
            @Override public void onIceGatheringChange(PeerConnection.IceGatheringState state) { }
            @Override public void onIceCandidate(IceCandidate candidate) {
                JSONObject message = base("screen-ice", session.id);
                JSONObject ice = new JSONObject();
                put(ice, "candidate", candidate.sdp);
                put(ice, "sdpMid", candidate.sdpMid);
                put(ice, "sdpMLineIndex", candidate.sdpMLineIndex);
                put(message, "candidate", ice);
                send(session, message);
            }
            @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) { }
            @Override public void onAddStream(MediaStream stream) { }
            @Override public void onRemoveStream(MediaStream stream) { }
            @Override public void onDataChannel(DataChannel channel) { channel.close(); }
            @Override public void onRenegotiationNeeded() { }
        };
    }

    private void displaySize(Session session) {
        if (Build.VERSION.SDK_INT >= 30) {
            Rect bounds = activity.getWindowManager().getMaximumWindowMetrics().getBounds();
            session.sourceWidth = bounds.width();
            session.sourceHeight = bounds.height();
        } else {
            DisplayMetrics metrics = new DisplayMetrics();
            activity.getWindowManager().getDefaultDisplay().getRealMetrics(metrics);
            session.sourceWidth = metrics.widthPixels;
            session.sourceHeight = metrics.heightPixels;
        }
    }

    private void configure(Session session, boolean resize) {
        configure(session, session.video, resize);
    }

    private void configure(Session session, JSONObject video, boolean resize) {
        double maxWidth = constraint(video, "width", session.sourceWidth, 2, 8192);
        double maxHeight = constraint(video, "height", session.sourceHeight, 2, 8192);
        // VDO quality presets describe landscape bounds; keep their equivalent quality in portrait.
        if (session.sourceHeight > session.sourceWidth && maxWidth > maxHeight) {
            double swap = maxWidth;
            maxWidth = maxHeight;
            maxHeight = swap;
        }
        double scale = Math.min(1, Math.min(maxWidth / session.sourceWidth, maxHeight / session.sourceHeight));
        CaptureFormat desired = new CaptureFormat(
                Math.max(2, ((int) Math.round(session.sourceWidth * scale)) & ~1),
                Math.max(2, ((int) Math.round(session.sourceHeight * scale)) & ~1),
                (int) constraint(video, "frameRate", 60, 1, 60),
                (int) constraint(video, "bitrate", 12000, 500, 40000) * 1000,
                contentHint(video));
        CaptureFormat previous = new CaptureFormat(session);
        boolean resizeDisplay = resize && (desired.width != previous.width || desired.height != previous.height);
        try {
            // The pinned capturer resizes the existing VirtualDisplay on Android 12+.
            // Never stop/start MediaProjection or reuse its consent for quality changes.
            if (resizeDisplay) session.capturer.changeCaptureFormat(desired.width, desired.height, desired.fps);
            // ScreenCapturerAndroid ignores its FPS argument; source and sender enforce it.
            session.source.adaptOutputFormat(desired.width, desired.height, desired.fps);
            if (!updateSender(session, desired)) throw new IllegalStateException("Capture encoder rejected the settings.");
        } catch (RuntimeException exception) {
            if (previous.width > 0 && previous.height > 0) {
                // A failed update leaves the existing share alive in its previous format.
                if (resizeDisplay) safely(() -> session.capturer.changeCaptureFormat(previous.width, previous.height, previous.fps));
                safely(() -> session.source.adaptOutputFormat(previous.width, previous.height, previous.fps));
                safely(() -> updateSender(session, previous));
            }
            throw exception;
        }
        session.width = desired.width;
        session.height = desired.height;
        session.fps = desired.fps;
        session.bitrate = desired.bitrate;
        session.contentHint = desired.contentHint;
        session.video = video;
        session.configurationRevision++;
    }

    private boolean updateSender(Session session) {
        return updateSender(session, new CaptureFormat(session));
    }

    private boolean updateSender(Session session, CaptureFormat format) {
        if (session.sender == null || session.stopped) return true;
        RtpParameters parameters = session.sender.getParameters();
        if (parameters.encodings.isEmpty()) return true;
        parameters.degradationPreference = "motion".equals(format.contentHint)
                ? RtpParameters.DegradationPreference.MAINTAIN_FRAMERATE
                : RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION;
        for (RtpParameters.Encoding encoding : parameters.encodings) {
            encoding.maxFramerate = format.fps;
            // Leave enough headroom in this local bridge for VDO's second encode.
            encoding.maxBitrateBps = Math.max(6000000, format.bitrate);
        }
        return session.sender.setParameters(parameters);
    }

    private static String contentHint(JSONObject video) {
        String hint = video == null ? "motion" : video.optString("contentHint", "motion");
        return "detail".equals(hint) || "text".equals(hint) ? hint : "motion";
    }

    private static double constraint(JSONObject video, String key, double fallback, double min, double max) {
        Object value = video == null ? null : video.opt(key);
        double requested = fallback;
        if (value instanceof Number) {
            requested = ((Number) value).doubleValue();
        } else if (value instanceof JSONObject) {
            JSONObject bounds = (JSONObject) value;
            requested = bounds.optDouble("ideal", bounds.optDouble("exact", bounds.optDouble("max", fallback)));
            requested = Math.min(requested, bounds.optDouble("max", requested));
        }
        return Double.isFinite(requested) ? Math.max(min, Math.min(max, requested)) : fallback;
    }

    private static JSONObject configuration(Session session, String type) {
        JSONObject message = base(type, session.id);
        put(message, "width", session.width);
        put(message, "height", session.height);
        put(message, "frameRate", session.fps);
        put(message, "bitrate", session.bitrate / 1000);
        put(message, "contentHint", session.contentHint);
        put(message, "revision", session.configurationRevision);
        put(message, "displaySurface", "monitor");
        return message;
    }

    private void fail(Session session, String name, String message) {
        onUi(() -> stop(session, message, name));
    }

    private void stop(Session session, String message, String name) {
        if (session == null || session.stopped) return;
        session.stopped = true;
        if (active == session) active = null;
        if (session.timeout != null) ui.removeCallbacks(session.timeout);
        if (session.disconnected != null) ui.removeCallbacks(session.disconnected);
        JSONObject result = name == null ? base("screen-stopped", session.id) : error(session.id, name, message);
        put(result, "message", message);
        post(session.reply, result);
        runRtc(session, () -> {
            release(session);
            onUi(() -> ProjectionService.finish(session.id));
        });
    }

    private static void release(Session session) {
        // Disposal runs on our executor after observer callbacks have unwound.
        safely(() -> { if (session.capturer != null) session.capturer.stopCapture(); });
        safely(() -> { if (session.peer != null) session.peer.dispose(); });
        safely(() -> { if (session.track != null) session.track.dispose(); });
        safely(() -> { if (session.capturer != null) session.capturer.dispose(); });
        safely(() -> { if (session.texture != null) session.texture.dispose(); });
        safely(() -> { if (session.source != null) session.source.dispose(); });
        safely(() -> { if (session.factory != null) session.factory.dispose(); });
        safely(() -> { if (session.egl != null) session.egl.release(); });
        session.permission = null;
        session.remoteCandidates.clear();
    }

    private static void safely(Runnable runnable) {
        try { runnable.run(); } catch (RuntimeException ignored) { }
    }

    /** Navigation stops capture, while retaining any pending chooser so its late result is discarded. */
    public void reset() {
        onUi(() -> {
            if (closed) return;
            if (active != null) stop(active, "Screen sharing stopped.", null);
        });
    }

    public void close() {
        onUi(() -> {
            if (closed) return;
            closed = true;
            if (active != null) stop(active, "Screen sharing stopped.", null);
            awaitingConsent = null;
            rtc.shutdown();
        });
    }

    private void send(Session session, JSONObject message) {
        onUi(() -> { if (!session.stopped && !closed) post(session.reply, message); });
    }

    private static void post(JavaScriptReplyProxy reply, JSONObject message) {
        try { reply.postMessage(message.toString()); } catch (RuntimeException ignored) { }
    }

    private void onUi(Runnable runnable) {
        if (Looper.myLooper() == Looper.getMainLooper()) runnable.run(); else ui.post(runnable);
    }

    private void runRtc(Session session, Runnable runnable) {
        try {
            rtc.execute(() -> {
                try {
                    runnable.run();
                } catch (RuntimeException | LinkageError exception) {
                    fail(session, "NotReadableError", "Your device could not continue screen capture. Please try again.");
                }
            });
        } catch (RejectedExecutionException ignored) { }
    }

    private static JSONObject base(String type, String id) {
        JSONObject message = new JSONObject();
        put(message, "type", type);
        put(message, "id", id);
        return message;
    }

    private static JSONObject error(String id, String name, String text) {
        JSONObject message = base("screen-error", id);
        put(message, "name", name);
        put(message, "message", text);
        return message;
    }

    private static void put(JSONObject message, String key, Object value) {
        try { message.put(key, value); } catch (JSONException ignored) { }
    }

    private static class SimpleSdpObserver implements SdpObserver {
        @Override public void onCreateSuccess(SessionDescription description) { }
        @Override public void onSetSuccess() { }
        @Override public void onCreateFailure(String reason) { }
        @Override public void onSetFailure(String reason) { }
    }

    private static final class Session {
        final String id;
        final String offer;
        final JavaScriptReplyProxy reply;
        final List<IceCandidate> remoteCandidates = new ArrayList<>();
        volatile boolean stopped;
        volatile JSONObject video;
        Intent permission;
        Runnable timeout;
        Runnable disconnected;
        boolean serviceReady;
        boolean remoteDescriptionSet;
        int sourceWidth;
        int sourceHeight;
        int width;
        int height;
        int fps;
        int bitrate;
        String contentHint = "motion";
        int configurationRevision;
        EglBase egl;
        PeerConnectionFactory factory;
        PeerConnection peer;
        SurfaceTextureHelper texture;
        ScreenCapturerAndroid capturer;
        VideoSource source;
        VideoTrack track;
        RtpSender sender;

        Session(String id, String offer, JSONObject video, JavaScriptReplyProxy reply) {
            this.id = id;
            this.offer = offer;
            this.video = video;
            this.reply = reply;
        }
    }

    private static final class CaptureFormat {
        final int width;
        final int height;
        final int fps;
        final int bitrate;
        final String contentHint;

        CaptureFormat(Session session) {
            this(session.width, session.height, session.fps, session.bitrate, session.contentHint);
        }

        CaptureFormat(int width, int height, int fps, int bitrate, String contentHint) {
            this.width = width;
            this.height = height;
            this.fps = fps;
            this.bitrate = bitrate;
            this.contentHint = contentHint;
        }
    }
}
