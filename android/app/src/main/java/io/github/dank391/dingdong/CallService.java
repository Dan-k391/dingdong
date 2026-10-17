package io.github.dank391.dingdong;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/** Keeps permitted microphone/camera capture visible while the user switches apps. */
public final class CallService extends Service {
    public static Runnable stopCall;
    private static final String CHANNEL = "dingdong_calls";
    @Override public void onCreate() {
        super.onCreate();
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(CHANNEL, "Voice and video calls", NotificationManager.IMPORTANCE_LOW));
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        if ("stop".equals(intent.getAction())) {
            if (stopCall != null) stopCall.run();
            stopSelf(); return START_NOT_STICKY;
        }
        boolean audio = intent.getBooleanExtra("audio", false) && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        boolean video = intent.getBooleanExtra("video", false) && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        if (!audio && !video) { stopSelf(); return START_NOT_STICKY; }
        PendingIntent open = PendingIntent.getActivity(this, 110, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 111, new Intent(this, CallService.class).setAction("stop"), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("叮咚通话已连接").setContentText(video ? "正在使用麦克风和摄像头" : "正在使用麦克风")
            .setContentIntent(open).setOngoing(true).setCategory(Notification.CATEGORY_CALL)
            .addAction(new Notification.Action.Builder(null, "Disconnect", stop).build()).build();
        int type = (audio ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0) | (video ? ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA : 0);
        try {
            if (Build.VERSION.SDK_INT >= 30) startForeground(1202, notification, type);
            else startForeground(1202, notification);
        } catch (RuntimeException error) { stopSelf(); }
        return START_NOT_STICKY;
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onDestroy() { stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy(); }
}
