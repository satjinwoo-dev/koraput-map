package com.mapunite.app.radar

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.telephony.CellSignalStrengthCdma
import android.telephony.CellSignalStrengthGsm
import android.telephony.CellSignalStrengthLte
import android.telephony.CellSignalStrengthNr
import android.telephony.CellSignalStrengthTdscdma
import android.telephony.CellSignalStrengthWcdma
import android.telephony.TelephonyManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

/*
 * MapUniteRadio: radio-level signal for the Master AI's link agent
 * (public/js/master/agents/link-agent.js, provider in public/js/master/providers.js).
 *
 *   start({ intervalMs = 2000 })   → {}        emits "radio" events every intervalMs (min 1000)
 *   stop()                         → {}
 *   snapshot()                     → RadioSample
 *
 * RadioSample = { t, transport: "cellular"|"wifi"|"ethernet"|"none", gen: "2g"|"3g"|"4g"|"5g"|"unknown",
 *                 level: 0..4, dbm, rsrp, rsrq, sinr, wifiRssi, downKbps, upKbps, metered }
 *   dBm / dB / kbit/s; a field the phone can't measure is null (JSONObject.NULL).
 *
 * PERMISSIONS: none at runtime. TelephonyManager.getSignalStrength() (API 28+) and
 * NetworkCapabilities need only ACCESS_NETWORK_STATE (a normal, install-time
 * permission Capacitor already declares). We deliberately do NOT read the cell's
 * identity or location (that would need location permission and isn't needed).
 * Below API 28 the cellular fields are null; the bandwidth half of the agent still works.
 *
 * Register in MainActivity: registerPlugin(com.mapunite.app.radar.RadioPlugin.class);
 */
@CapacitorPlugin(name = "MapUniteRadio")
class RadioPlugin : Plugin() {

    private val main = Handler(Looper.getMainLooper())
    private var intervalMs = 2000L
    private var running = false

    private val tick = object : Runnable {
        override fun run() {
            if (!running) return
            try { notifyListeners("radio", sample()) } catch (e: Exception) { /* a vendor ROM threw: skip this sample */ }
            main.postDelayed(this, intervalMs)
        }
    }

    @PluginMethod
    fun start(call: PluginCall) {
        intervalMs = (call.getInt("intervalMs", 2000) ?: 2000).coerceIn(1000, 60000).toLong()
        if (!running) { running = true; main.post(tick) }
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        running = false
        main.removeCallbacks(tick)
        call.resolve()
    }

    @PluginMethod
    fun snapshot(call: PluginCall) {
        try { call.resolve(sample()) } catch (e: Exception) { call.reject("radio unavailable: ${e.message}") }
    }

    override fun handleOnDestroy() {
        running = false
        main.removeCallbacks(tick)
        super.handleOnDestroy()
    }

    private fun sample(): JSObject {
        val o = JSObject()
        o.put("t", System.currentTimeMillis())
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
        val transport = when {
            caps == null -> "none"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "none"
        }
        o.put("transport", transport)
        o.put("downKbps", caps?.linkDownstreamBandwidthKbps ?: JSONObject.NULL)
        o.put("upKbps", caps?.linkUpstreamBandwidthKbps ?: JSONObject.NULL)
        o.put("metered", caps?.let { !it.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) } ?: JSONObject.NULL)
        // Wi-Fi RSSI without location permission: NetworkCapabilities.getSignalStrength (API 29+)
        val wifiRssi = if (transport == "wifi" && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) caps?.signalStrength?.takeIf { it != NetworkCapabilities.SIGNAL_STRENGTH_UNSPECIFIED } else null
        o.put("wifiRssi", wifiRssi ?: JSONObject.NULL)

        var gen = "unknown"
        var level: Int? = null
        var dbm: Int? = null
        var rsrp: Int? = null
        var rsrq: Int? = null
        var sinr: Int? = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
            val ss = try { tm.signalStrength } catch (e: SecurityException) { null }
            if (ss != null) {
                level = ss.level
                // the strongest serving cell, newest technology first
                val cells = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ss.cellSignalStrengths else emptyList()
                val nr = cells.filterIsInstance<CellSignalStrengthNr>().firstOrNull()
                val lte = cells.filterIsInstance<CellSignalStrengthLte>().firstOrNull()
                val umts = cells.firstOrNull { it is CellSignalStrengthWcdma || it is CellSignalStrengthTdscdma }
                val legacy = cells.firstOrNull { it is CellSignalStrengthGsm || it is CellSignalStrengthCdma }
                when {
                    nr != null -> { gen = "5g"; rsrp = valid(nr.ssRsrp); rsrq = valid(nr.ssRsrq); sinr = valid(nr.ssSinr); dbm = valid(nr.dbm) }
                    lte != null -> { gen = "4g"; rsrp = valid(lte.rsrp); rsrq = valid(lte.rsrq); sinr = valid(lte.rssnr); dbm = valid(lte.dbm) }
                    umts != null -> { gen = "3g"; dbm = valid(umts.dbm) }
                    legacy != null -> { gen = "2g"; dbm = valid(legacy.dbm) }
                }
            }
        }
        o.put("gen", gen)
        o.put("level", level ?: JSONObject.NULL)
        o.put("dbm", dbm ?: JSONObject.NULL)
        o.put("rsrp", rsrp ?: JSONObject.NULL)
        o.put("rsrq", rsrq ?: JSONObject.NULL)
        o.put("sinr", sinr ?: JSONObject.NULL)
        return o
    }

    /** Android reports "unavailable" as Integer.MAX_VALUE (CellInfo.UNAVAILABLE). */
    private fun valid(v: Int): Int? = if (v == Int.MAX_VALUE || v == Int.MIN_VALUE) null else v
}
