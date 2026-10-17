package io.github.dank391.dingdong;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import java.lang.ref.WeakReference;

/** Android requires an ongoing media-projection foreground notification during screen sharing. */
public final class ProjectionService extends Service {
    private static final String CHANNEL = "dingdong-screen-sharing";
    private static final String START = "io.github.dank391.dingdong.START_PROJECTION";
    private static final String STOP = "io.github.dank391.dingdong.STOP_PROJECTION";
    private static final String SESSION = "session";
    private static final int NOTIFICATION = 45002;
    private static WeakReference<ScreenCaptureBridge> bridge = new WeakReference<>(null);
    private static WeakReference<ProjectionService> current = new WeakReference<>(null);
    private static String requestedSession = "";
    private String sessionId = "";

    static void start(Context context, ScreenCaptureBridge capture, String id) {
        bridge = new WeakReference<>(capture);
        requestedSession = id;
        Intent intent = new Intent(context, ProjectionService.class).setAction(START).putExtra(SESSION, id);
        context.startForegroundService(intent);
    }

    static void finish(String id) {
        ProjectionService service = current.get();
        if (service != null && id.equals(service.sessionId)) service.end();
        if (id.equals(requestedSession)) {
            bridge.clear();
            requestedSession = "";
        }
    }

    @Override public void onCreate() {
        super.onCreate();
        current = new WeakReference<>(this);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Screen sharing", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("叮咚共享屏幕时显示，可在此停止。");
            manager.createNotificationChannel(channel);
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            end();
            return START_NOT_STICKY;
        }
        String id = intent.getStringExtra(SESSION);
        ScreenCaptureBridge capture = bridge.get();
        if (STOP.equals(intent.getAction())) {
            if (id != null && id.equals(sessionId)) {
                if (capture != null) capture.onServiceStopped(id);
                end();
            }
            return START_NOT_STICKY;
        }
        if (!START.equals(intent.getAction()) || id == null || !id.equals(requestedSession)
                || capture == null || !capture.isCurrent(id)) {
            end();
            return START_NOT_STICKY;
        }
        sessionId = id;
        Intent stop = new Intent(this, ProjectionService.class).setAction(STOP).putExtra(SESSION, id);
        PendingIntent stopAction = PendingIntent.getService(this, NOTIFICATION, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentTitle("叮咚正在共享屏幕")
                .setContentText("Your screen is being shared. Tap Stop to end sharing.")
                .setCategory(Notification.CATEGORY_SERVICE)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_pause, "Stop", stopAction).build());
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch != null) {
            builder.setContentIntent(PendingIntent.getActivity(this, 0, launch,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        }
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION, builder.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            } else {
                startForeground(NOTIFICATION, builder.build());
            }
            capture.onForegroundReady(id);
        } catch (RuntimeException exception) {
            capture.onServiceStopped(id);
            end();
        }
        return START_NOT_STICKY;
    }

    private void end() {
        String id = sessionId;
        sessionId = "";
        if (id.equals(requestedSession)) {
            bridge.clear();
            requestedSession = "";
        }
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override public void onDestroy() {
        String id = sessionId;
        ScreenCaptureBridge capture = bridge.get();
        sessionId = "";
        if (current.get() == this) current.clear();
        if (id.equals(requestedSession)) {
            bridge.clear();
            requestedSession = "";
        }
        if (!id.isEmpty() && capture != null) capture.onServiceStopped(id);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) {
        return null;
    }
}
