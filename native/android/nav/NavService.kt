package com.mapunite.app.nav

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

/*
 * The live navigation notification, like a car navigator's: the turn arrow on a mint tile,
 * "200 m · Turn left onto NH-26", the next step, "Arrive 5:19 PM · 12 km · 18 min", a
 * progress bar, and "Stop". Silent, updated in place (onlyAlertOnce), dark-teal colourised.
 *
 * A foreground service of type "location" while navigating: it keeps the app's process (and
 * the WebView that follows the GPS) at foreground priority when the rider is in another app,
 * so the turns keep coming. It starts only from the open app (NavPipPlugin.start), which
 * Android allows with the normal "while using the app" location permission.
 * If Android refuses the foreground service (Android 12+ rules, a missing permission), the
 * same notification is posted on its own: the rider still sees the turns.
 */
class NavService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                NavPipPlugin.onNotificationAction("stop")
                stopForegroundCompat()
                stopSelf()
                running = false
                return START_NOT_STICKY
            }
            else -> {
                val n = build(this, latest)
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
                    else startForeground(ID, n)
                    running = true
                } catch (e: Exception) {
                    // not allowed as a foreground service here: the notification alone
                    running = false
                    post(this, n)
                    stopSelf()
                }
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() { running = false; super.onDestroy() }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
    }

    companion object {
        private const val CHANNEL = "mu_nav"
        private const val ID = 4207
        private const val ACTION_SHOW = "com.mapunite.app.nav.SHOW"
        private const val ACTION_STOP = "com.mapunite.app.nav.STOP"
        @Volatile private var running = false
        @Volatile private var latest: JSONObject = JSONObject()

        /** Show or update the notification with this card. */
        fun show(ctx: Context, card: JSONObject) {
            latest = card
            ensureChannel(ctx)
            if (running) { post(ctx, build(ctx, card)); return }
            val i = Intent(ctx, NavService::class.java).setAction(ACTION_SHOW)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
            } catch (e: Exception) {
                post(ctx, build(ctx, card))
            }
        }

        fun hide(ctx: Context) {
            running = false
            try { ctx.stopService(Intent(ctx, NavService::class.java)) } catch (e: Exception) { /* not running */ }
            NotificationManagerCompat.from(ctx).cancel(ID)
        }

        private fun post(ctx: Context, n: Notification) {
            try { NotificationManagerCompat.from(ctx).notify(ID, n) } catch (e: SecurityException) { /* notifications not allowed (Android 13+) */ }
        }

        private fun ensureChannel(ctx: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
            if (nm.getNotificationChannel(CHANNEL) != null) return
            val ch = NotificationChannel(CHANNEL, "Navigation", NotificationManager.IMPORTANCE_LOW)
            ch.description = "The next turn while you navigate"
            ch.setShowBadge(false)
            ch.setSound(null, null)
            ch.enableVibration(false)
            nm.createNotificationChannel(ch)
        }

        private fun build(ctx: Context, c: JSONObject): Notification {
            ensureChannel(ctx)
            val distance = c.optString("distance", "")
            val instruction = c.optString("instruction", "Navigating")
            val then = c.optString("then", "")
            val eta = c.optString("eta", "")
            val left = c.optString("left", "")
            val turn = c.optString("turn", "straight")
            val title = listOf(distance, instruction).filter { it.isNotBlank() }.joinToString(" · ")
            val sub = listOf(if (eta.isNotBlank()) "Arrive $eta" else "", left).filter { it.isNotBlank() }.joinToString(" · ")

            val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.apply { addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT) }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
            val open = launch?.let { PendingIntent.getActivity(ctx, 1, it, flags) }
            val stop = PendingIntent.getService(ctx, 2, Intent(ctx, NavService::class.java).setAction(ACTION_STOP), flags)

            val b = NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_map)
                .setLargeIcon(turnBitmap(turn))
                .setContentTitle(title)
                .setContentText(if (then.isNotBlank()) then else sub)
                .setSubText(if (then.isNotBlank()) sub else null)
                .setStyle(NotificationCompat.BigTextStyle().bigText(listOf(then, sub).filter { it.isNotBlank() }.joinToString("\n")).setBigContentTitle(title))
                .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setShowWhen(false)
                .setColor(Color.parseColor("#0E3B38"))
                .setColorized(true)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .addAction(0, "Stop", stop)
            if (open != null) b.setContentIntent(open)
            val p = c.optDouble("progress", Double.NaN)
            if (!p.isNaN()) b.setProgress(1000, (p.coerceIn(0.0, 1.0) * 1000).toInt(), false)
            return b.build()
        }

        /** The turn arrow on a mint-to-indigo tile (the same shapes as navpip-core.js arrowPath). */
        private fun turnBitmap(kind: String): Bitmap {
            val size = 192
            val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val cv = Canvas(bmp)
            val tile = Paint(Paint.ANTI_ALIAS_FLAG)
            tile.shader = LinearGradient(0f, 0f, size.toFloat(), size.toFloat(), Color.parseColor("#34E0B4"), Color.parseColor("#4F46E5"), Shader.TileMode.CLAMP)
            cv.drawRoundRect(RectF(0f, 0f, size.toFloat(), size.toFloat()), 44f, 44f, tile)
            val k = 152f / 100f
            val ox = 20f; val oy = 20f
            fun x(v: Float) = ox + v * k
            fun y(v: Float) = oy + v * k
            val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.STROKE; strokeWidth = 11f * k; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND; setShadowLayer(6f, 0f, 2f, 0x55000000) }
            val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.FILL; setShadowLayer(6f, 0f, 2f, 0x55000000) }
            if (kind == "arrive") {
                val pin = Path()
                pin.addArc(RectF(x(30f), y(22f), x(70f), y(62f)), 180f, 180f)
                pin.lineTo(x(50f), y(88f)); pin.close()
                cv.drawPath(pin, fill)
                cv.drawCircle(x(50f), y(42f), 8f * k, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#0E7C6B") })
                return bmp
            }
            val shaft = Path()
            val head: List<FloatArray>
            if (kind == "uturn") {
                shaft.moveTo(x(62f), y(86f)); shaft.lineTo(x(62f), y(40f))
                shaft.arcTo(RectF(x(38f), y(28f), x(62f), y(52f)), 0f, -180f)
                shaft.lineTo(x(38f), y(58f))
                head = listOf(floatArrayOf(26f, 50f), floatArrayOf(38f, 68f), floatArrayOf(50f, 50f))
            } else {
                val deg = mapOf("slight-left" to -45.0, "left" to -90.0, "sharp-left" to -135.0, "slight-right" to 45.0, "right" to 90.0, "sharp-right" to 135.0)[kind] ?: 0.0
                val r = Math.toRadians(deg)
                val pts = if (deg == 0.0) listOf(floatArrayOf(50f, 88f), floatArrayOf(50f, 24f))
                    else listOf(floatArrayOf(50f, 88f), floatArrayOf(50f, 52f), floatArrayOf((50 + sin(r) * 30).toFloat(), (52 - cos(r) * 30).toFloat()))
                shaft.moveTo(x(pts[0][0]), y(pts[0][1]))
                for (i in 1 until pts.size) shaft.lineTo(x(pts[i][0]), y(pts[i][1]))
                val end = pts.last(); val prev = pts[pts.size - 2]
                val ang = atan2((end[1] - prev[1]).toDouble(), (end[0] - prev[0]).toDouble())
                val hl = 16.0; val hw = 14.0
                val tx = end[0] + cos(ang) * hl * 0.6; val ty = end[1] + sin(ang) * hl * 0.6
                val bx = end[0] - cos(ang) * hl * 0.4; val by = end[1] - sin(ang) * hl * 0.4
                head = listOf(floatArrayOf((bx + sin(ang) * hw).toFloat(), (by - cos(ang) * hw).toFloat()), floatArrayOf(tx.toFloat(), ty.toFloat()), floatArrayOf((bx - sin(ang) * hw).toFloat(), (by + cos(ang) * hw).toFloat()))
            }
            cv.drawPath(shaft, stroke)
            val hp = Path()
            hp.moveTo(x(head[0][0]), y(head[0][1])); hp.lineTo(x(head[1][0]), y(head[1][1])); hp.lineTo(x(head[2][0]), y(head[2][1])); hp.close()
            cv.drawPath(hp, fill)
            return bmp
        }
    }
}
