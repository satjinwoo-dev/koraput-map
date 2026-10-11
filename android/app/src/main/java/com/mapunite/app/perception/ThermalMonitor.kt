package com.mapunite.app.perception

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import java.util.concurrent.Executor

/*
 * Phone heat and battery, for perf.thermal and the governors.
 *
 *   Android 10+ : PowerManager thermal status (none … shutdown), pushed by a listener
 *   Android 11+ : thermal headroom forecast (1.0 = throttling starts), polled ≤ 1 per 10 s
 *                 (Android returns NaN when asked more often)
 *   older       : battery temperature as a rough stand-in
 *
 * Mapped to the contract words: none, light, moderate, severe, critical
 * (EMERGENCY and SHUTDOWN are reported as critical).
 */
class ThermalMonitor(private val ctx: Context) {

    @Volatile var thermal: String = "none"; private set
    @Volatile var headroom: Double = Double.NaN; private set
    @Volatile var batteryPct: Int = -1; private set
    @Volatile var charging: Boolean = false; private set
    @Volatile var batteryTempC: Double = Double.NaN; private set

    private val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
    private var listener: Any? = null
    private var onChange: ((String) -> Unit)? = null
    private var lastHeadroomMs = 0L

    fun start(executor: Executor, onChange: (String) -> Unit) {
        this.onChange = onChange
        if (Build.VERSION.SDK_INT >= 29) {
            thermal = mapStatus(pm.currentThermalStatus)
            val l = PowerManager.OnThermalStatusChangedListener { status -> set(mapStatus(status)) }
            pm.addThermalStatusListener(executor, l)
            listener = l
        }
        poll(System.currentTimeMillis())
    }

    fun stop() {
        if (Build.VERSION.SDK_INT >= 29) (listener as? PowerManager.OnThermalStatusChangedListener)?.let { pm.removeThermalStatusListener(it) }
        listener = null
        onChange = null
    }

    /** Call about once a second: battery, plus headroom every 10 s, plus the temperature fallback. */
    fun poll(nowMs: Long) {
        val b = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))  // sticky: no receiver kept
        if (b != null) {
            val level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
            if (level >= 0 && scale > 0) batteryPct = level * 100 / scale
            val plugged = b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)
            charging = plugged != 0
            val t = b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
            if (t != Int.MIN_VALUE) batteryTempC = t / 10.0
        }
        if (Build.VERSION.SDK_INT >= 30 && nowMs - lastHeadroomMs >= 10_000) {
            lastHeadroomMs = nowMs
            val h = pm.getThermalHeadroom(10).toDouble()   // forecast 10 s ahead
            if (h.isFinite()) headroom = h
        }
        if (Build.VERSION.SDK_INT < 29 && batteryTempC.isFinite()) {
            set(when {
                batteryTempC >= 52 -> "critical"
                batteryTempC >= 48 -> "severe"
                batteryTempC >= 45 -> "moderate"
                batteryTempC >= 41 -> "light"
                else -> "none"
            })
        }
    }

    private fun set(level: String) {
        if (level == thermal) return
        thermal = level
        onChange?.invoke(level)
    }

    private fun mapStatus(s: Int): String = when (s) {
        PowerManager.THERMAL_STATUS_NONE -> "none"
        PowerManager.THERMAL_STATUS_LIGHT -> "light"
        PowerManager.THERMAL_STATUS_MODERATE -> "moderate"
        PowerManager.THERMAL_STATUS_SEVERE -> "severe"
        else -> "critical"   // CRITICAL, EMERGENCY, SHUTDOWN
    }
}
