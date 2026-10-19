package androidx.core.app;
public class NotificationCompat {
  public static final int PRIORITY_DEFAULT = 0, PRIORITY_LOW = -1, PRIORITY_HIGH = 1, PRIORITY_MIN = -2, PRIORITY_MAX = 2;
  public static final int VISIBILITY_PUBLIC = 1, VISIBILITY_PRIVATE = 0, VISIBILITY_SECRET = -1;
  public static final String CATEGORY_NAVIGATION = "navigation", CATEGORY_SERVICE = "service", CATEGORY_TRANSPORT = "transport", CATEGORY_PROGRESS = "progress", CATEGORY_STATUS = "status";
  public static final int FOREGROUND_SERVICE_IMMEDIATE = 1, FOREGROUND_SERVICE_DEFAULT = 0, FOREGROUND_SERVICE_DEFERRED = 2;
  public static abstract class Style { }
  public static class BigTextStyle extends Style { public BigTextStyle() {} public BigTextStyle bigText(CharSequence c) { return this; } public BigTextStyle setBigContentTitle(CharSequence c) { return this; } public BigTextStyle setSummaryText(CharSequence c) { return this; } }
  public static class Action { public Action(int icon, CharSequence title, android.app.PendingIntent intent) {} public static final class Builder { public Builder(int icon, CharSequence title, android.app.PendingIntent intent) {} public Action build() { return null; } } }
  public static class Builder {
    public Builder(android.content.Context c, String channelId) {}
    public Builder setSmallIcon(int i) { return this; }
    public Builder setLargeIcon(android.graphics.Bitmap b) { return this; }
    public Builder setContentTitle(CharSequence c) { return this; }
    public Builder setContentText(CharSequence c) { return this; }
    public Builder setSubText(CharSequence c) { return this; }
    public Builder setStyle(Style s) { return this; }
    public Builder setOngoing(boolean b) { return this; }
    public Builder setOnlyAlertOnce(boolean b) { return this; }
    public Builder setSilent(boolean b) { return this; }
    public Builder setShowWhen(boolean b) { return this; }
    public Builder setWhen(long w) { return this; }
    public Builder setUsesChronometer(boolean b) { return this; }
    public Builder setAutoCancel(boolean b) { return this; }
    public Builder setPriority(int p) { return this; }
    public Builder setCategory(String c) { return this; }
    public Builder setVisibility(int v) { return this; }
    public Builder setColor(int c) { return this; }
    public Builder setColorized(boolean b) { return this; }
    public Builder setProgress(int max, int progress, boolean indeterminate) { return this; }
    public Builder setContentIntent(android.app.PendingIntent p) { return this; }
    public Builder setDeleteIntent(android.app.PendingIntent p) { return this; }
    public Builder addAction(int icon, CharSequence title, android.app.PendingIntent p) { return this; }
    public Builder addAction(Action a) { return this; }
    public Builder setForegroundServiceBehavior(int b) { return this; }
    public Builder setRequestPromotedOngoing(boolean b) { return this; }
    public Builder setShortCriticalText(String s) { return this; }
    public Builder setTicker(CharSequence c) { return this; }
    public Builder setNumber(int n) { return this; }
    public Builder setLocalOnly(boolean b) { return this; }
    public Builder setGroup(String g) { return this; }
    public android.app.Notification build() { return null; }
  }
}