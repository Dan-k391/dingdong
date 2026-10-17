package io.github.dank391.dingdong;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;

public final class MainActivity extends Activity {
    private static final String SITE = "https://dan-k391.github.io/dingdong/";
    private static final int PICK_FILES = 45001, MEDIA_PERMISSIONS = 45004;
    private WebView webView;
    private FrameLayout root;
    private View offline, fullScreenView;
    private WebChromeClient.CustomViewCallback fullScreenCallback;
    private NativeFiles files;
    private ScreenCaptureBridge screens;
    private ValueCallback<Uri[]> fileChoice;
    private PermissionRequest mediaRequest;
    private final ArrayDeque<PermissionRequest> mediaQueue = new ArrayDeque<>();
    private final Map<String, boolean[]> mediaSessions = new HashMap<>();
    private boolean destroying, awaitingMediaPermission, loadFailed;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        // One inset policy on every supported Android version, including SDK 35's
        // enforced edge-to-edge mode. The root draws the dark system-bar backing.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightStatusBars(false);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightNavigationBars(false);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attributes);
        }
        if (Build.VERSION.SDK_INT >= 29) {
            getWindow().setStatusBarContrastEnforced(false);
            getWindow().setNavigationBarContrastEnforced(false);
        }
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(43,45,49));
        setContentView(root);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets keyboard = insets.getInsets(WindowInsetsCompat.Type.ime());
            // Bars and the keyboard overlap; adding them would leave extra space.
            view.setPadding(Math.max(bars.left, keyboard.left), Math.max(bars.top, keyboard.top),
                Math.max(bars.right, keyboard.right), Math.max(bars.bottom, keyboard.bottom));
            // The WebView already fits inside this padding. Forwarding the same
            // insets lets Chromium apply a second CSS safe area on some devices.
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(root);
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(49,51,56));
        root.addView(webView, new FrameLayout.LayoutParams(-1,-1));
        files = new NativeFiles(this);
        screens = new ScreenCaptureBridge(this, webView);
        android.webkit.WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setBuiltInZoomControls(false);
        if (Build.VERSION.SDK_INT >= 26) settings.setSafeBrowsingEnabled(true);
        android.webkit.CookieManager.getInstance().setAcceptCookie(true);
        android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        configureClients();
        configureBridge();
        CallService.stopCall = () -> runOnUiThread(() -> {
            if (!destroying) webView.evaluateJavascript("window.dispatchEvent(new Event('dischord-android-call-stop'))", null);
            mediaSessions.clear();
            stopService(new Intent(this, CallService.class));
        });
        String destination = isSite(getIntent().getData()) ? getIntent().getData().toString() : SITE;
        webView.loadUrl(destination);
    }

    private static boolean isSite(Uri url) {
        if (url == null || !"https".equals(url.getScheme()) || !"dan-k391.github.io".equals(url.getHost()) || url.getUserInfo() != null) return false;
        return Arrays.asList("/dingdong/", "/dingdong", "/dingdong/index.html").contains(url.getPath()) && (url.getPort() == -1 || url.getPort() == 443);
    }
    private static boolean origin(Uri url, String host) {
        return url != null && "https".equals(url.getScheme()) && host.equals(url.getHost()) && (url.getPort() == -1 || url.getPort() == 443);
    }
    private boolean hosted() { return !destroying && isSite(Uri.parse(webView.getUrl() == null ? "" : webView.getUrl())); }
    private String asset(String name) throws IOException {
        try (InputStream input = getAssets().open(name)) {
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
            return bytes.toString(StandardCharsets.UTF_8.name());
        }
    }
    private void configureBridge() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Toast.makeText(this, "Update Android System WebView to enable native screen sharing and downloads.", Toast.LENGTH_LONG).show();
            return;
        }
        WebViewCompat.addWebMessageListener(webView, "DischordNative", new HashSet<>(Arrays.asList("https://dan-k391.github.io", "https://vdo.ninja")),
            (view, message, sourceOrigin, mainFrame, reply) -> {
                if (!hosted()) return;
                String raw = message.getData();
                if (raw == null || raw.length() > 200000) return;
                try {
                    JSONObject request = new JSONObject(raw);
                    String type = request.optString("type");
                    if (mainFrame && origin(sourceOrigin, "dan-k391.github.io") && type.startsWith("file-")) files.handle(request, reply);
                    else if (!mainFrame && origin(sourceOrigin, "vdo.ninja") && type.startsWith("screen-")) screens.handle(request, reply);
                    else if (!mainFrame && origin(sourceOrigin, "vdo.ninja") && "media-state".equals(type)) {
                        String scope = request.optString("scope");
                        if (scope.length() < 16 || scope.length() > 128 || mediaSessions.size() > 32) return;
                        boolean audio = request.optBoolean("audio"), video = request.optBoolean("video");
                        if (audio || video) mediaSessions.put(scope, new boolean[]{audio, video}); else mediaSessions.remove(scope);
                        updateCallService();
                    }
                } catch (Exception ignored) { }
            });
        try {
            WebViewCompat.addDocumentStartJavaScript(webView, asset("native-app.js") + "\n" + asset("native-files.js"), new HashSet<>(Arrays.asList("https://dan-k391.github.io")));
            WebViewCompat.addDocumentStartJavaScript(webView, asset("native-media.js") + "\n" + asset("native-screen.js"), new HashSet<>(Arrays.asList("https://vdo.ninja")));
        } catch (IOException error) { throw new IllegalStateException("Missing Android adapter assets", error); }
    }
    private void updateCallService() {
        boolean audio = false, video = false;
        for (boolean[] flags : mediaSessions.values()) { audio |= flags[0]; video |= flags[1]; }
        audio &= checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        video &= checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        if (!audio && !video) { stopService(new Intent(this, CallService.class)); return; }
        Intent intent = new Intent(this, CallService.class).putExtra("audio", audio).putExtra("video", video);
        try { startForegroundService(intent); } catch (RuntimeException ignored) { }
    }
    private void resetSessions() {
        if (files != null) files.reset();
        if (screens != null) { if (destroying) screens.close(); else screens.reset(); }
        mediaSessions.clear(); stopService(new Intent(this, CallService.class));
        if (fileChoice != null) { fileChoice.onReceiveValue(null); fileChoice = null; }
        if (mediaRequest != null) { mediaRequest.deny(); mediaRequest = null; }
        while (!mediaQueue.isEmpty()) mediaQueue.poll().deny();
    }
    private void configureClients() {
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                if (isSite(request.getUrl())) return false;
                if (request.hasGesture()) external(request.getUrl());
                return true;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) { loadFailed = false; resetSessions(); }
            @Override public void onPageFinished(WebView view, String url) { if (!loadFailed && isSite(Uri.parse(url)) && offline != null) offline.setVisibility(View.GONE); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) { loadFailed = true; showOffline(); }
            }
            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                destroying = true; resetSessions(); files.close(); view.destroy();
                Toast.makeText(MainActivity.this, "Android WebView 已停止，请重新打开叮咚。", Toast.LENGTH_LONG).show();
                finish(); return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (!hosted() || !(origin(request.getOrigin(), "vdo.ninja") || origin(request.getOrigin(), "dan-k391.github.io"))) { request.deny(); return; }
                    mediaQueue.add(request); processMediaPermission();
                });
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                mediaQueue.remove(request);
                if (mediaRequest == request) { mediaRequest = null; if (!awaitingMediaPermission) processMediaPermission(); }
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (!hosted()) return false;
                if (fileChoice != null) fileChoice.onReceiveValue(null);
                fileChoice = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                String[] accept = params.getAcceptTypes();
                if (accept.length == 1 && accept[0].contains("/") && !accept[0].contains(",")) intent.setType(accept[0]);
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(intent, PICK_FILES); }
                catch (RuntimeException error) { fileChoice.onReceiveValue(null); fileChoice = null; }
                return true;
            }
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullScreenView != null) { callback.onCustomViewHidden(); return; }
                fullScreenView = view; fullScreenCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(-1,-1));
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            }
            @Override public void onHideCustomView() { hideFullscreen(); }
        });
        webView.setDownloadListener((url, userAgent, disposition, mimeType, length) -> {
            // Blob originals are handled by the bounded native-files adapter.
            Uri destination = Uri.parse(url);
            if ("https".equals(destination.getScheme())) external(destination);
        });
    }
    private void processMediaPermission() {
        if (mediaRequest != null || awaitingMediaPermission || destroying) return;
        PermissionRequest request = mediaQueue.poll();
        if (request == null) return;
        mediaRequest = request;
        ArrayList<String> missing = new ArrayList<>();
        for (String resource : request.getResources()) {
            String permission = PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) ? Manifest.permission.RECORD_AUDIO : PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource) ? Manifest.permission.CAMERA : null;
            if (permission != null && checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED && !missing.contains(permission)) missing.add(permission);
        }
        if (missing.isEmpty()) finishMediaPermission();
        else { awaitingMediaPermission = true; requestPermissions(missing.toArray(new String[0]), MEDIA_PERMISSIONS); }
    }
    private void finishMediaPermission() {
        PermissionRequest request = mediaRequest; mediaRequest = null;
        if (request != null) {
            ArrayList<String> granted = new ArrayList<>();
            if (hosted()) for (String resource : request.getResources()) {
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) granted.add(resource);
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource) && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) granted.add(resource);
            }
            if (granted.isEmpty()) request.deny(); else request.grant(granted.toArray(new String[0]));
        }
        processMediaPermission();
    }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == MEDIA_PERMISSIONS) { awaitingMediaPermission = false; finishMediaPermission(); }
    }
    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (screens.onActivityResult(code, result, data) || files.onActivityResult(code, result, data)) return;
        if (code == PICK_FILES && fileChoice != null) {
            ArrayList<Uri> selected = new ArrayList<>();
            if (result == RESULT_OK && data != null) {
                if (data.getClipData() != null) for (int i=0; i<data.getClipData().getItemCount(); i++) {
                    Uri uri = data.getClipData().getItemAt(i).getUri();
                    if ("content".equals(uri.getScheme())) selected.add(uri);
                }
                else if (data.getData() != null && "content".equals(data.getData().getScheme())) selected.add(data.getData());
            }
            fileChoice.onReceiveValue(selected.isEmpty() ? null : selected.toArray(new Uri[0])); fileChoice = null;
        }
    }
    private void external(Uri url) {
        if (!Arrays.asList("https", "http", "mailto").contains(url.getScheme())) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, url)); } catch (RuntimeException ignored) { }
    }
    private void showOffline() {
        if (offline == null) {
            LinearLayout box = new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); box.setGravity(Gravity.CENTER);
            box.setPadding(32,32,32,32); box.setBackgroundColor(Color.rgb(49,51,56));
            TextView text = new TextView(this); text.setText("叮咚需要网络连接。\n请连接网络后重试。"); text.setTextColor(Color.WHITE); text.setGravity(Gravity.CENTER);
            Button retry = new Button(this); retry.setText("Retry"); retry.setOnClickListener(v -> { offline.setVisibility(View.GONE); webView.loadUrl(SITE); });
            box.addView(text); box.addView(retry); offline = box; root.addView(box, new FrameLayout.LayoutParams(-1,-1));
        }
        offline.setVisibility(View.VISIBLE);
    }
    private void hideFullscreen() {
        if (fullScreenView == null) return;
        root.removeView(fullScreenView); fullScreenView = null;
        fullScreenCallback.onCustomViewHidden(); fullScreenCallback = null;
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
    }
    @Override public void onBackPressed() {
        if (fullScreenView != null) { hideFullscreen(); return; }
        webView.evaluateJavascript("(() => {const m=document.getElementById('modalBack');if(m&&!m.classList.contains('hidden')&&m.dataset.dismiss){document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true;}if(document.body.classList.contains('channels-open')||document.body.classList.contains('members-open')){document.getElementById('mobileBackdrop').click();return true;}return false;})()", handled -> {
            if ("true".equals(handled) || destroying) return;
            if (webView.canGoBack()) webView.goBack(); else moveTaskToBack(true);
        });
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent);
        if (!isSite(intent.getData())) return;
        if (hosted() && intent.getData().getFragment() != null) webView.evaluateJavascript("location.hash=" + JSONObject.quote(intent.getData().getFragment()), null);
        else webView.loadUrl(intent.getData().toString());
    }
    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        // Rotation, fold/unfold and multi-window changes resize the existing
        // WebView without reloading active voice or screen-sharing sessions.
        ViewCompat.requestApplyInsets(root);
    }
    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused && root != null) ViewCompat.requestApplyInsets(root);
    }
    @Override protected void onDestroy() {
        destroying = true; resetSessions();
        CallService.stopCall = null;
        if (files != null) files.close();
        if (webView != null) { root.removeView(webView); webView.destroy(); }
        super.onDestroy();
    }
}
