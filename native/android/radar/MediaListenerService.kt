package com.mapunite.app.radar

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/*
 * The component Android requires before an app may read OTHER apps' media
 * sessions (MediaSessionManager.getActiveSessions). It reads no notifications
 * itself: both callbacks are empty. The rider switches it on once in
 * Settings → Notification access (MediaPlugin.openAccessSettings()).
 *
 * Declared in AndroidManifest.xml (inside <application>, see
 * native/android/AndroidManifest.additions.xml):
 *   <service android:name="com.mapunite.app.radar.MediaListenerService"
 *            android:label="@string/app_name"
 *            android:exported="true"
 *            android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE">
 *       <intent-filter><action android:name="android.service.notification.NotificationListenerService" /></intent-filter>
 *   </service>
 */
class MediaListenerService : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification?) { /* not used: we only need media sessions */ }
    override fun onNotificationRemoved(sbn: StatusBarNotification?) { /* not used */ }
}
