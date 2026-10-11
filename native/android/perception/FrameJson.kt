package com.mapunite.app.perception

/*
 * PerceptionFrame contract v1 → JSON text (pure Kotlin, no Android, no org.json).
 *
 * Written by hand so it is fast at 10 Hz, has no dependency, and can be unit-tested
 * on a plain JVM against the JS validator (contract.js). Output shape:
 *
 *   { v, t, seq, model{id,version,calib}, perf{fps,latencyMs,thermal,delegate},
 *     ego{speedMs,speedSigma,headingDeg,pitchDeg,rollDeg,lat?,lng?,posSigmaM?},
 *     quality{usable,reasons[]}, objects[], hazards[], relations[] }
 *
 * Numbers are rounded (3 decimals; confidences 3; positions 7) to keep frames small.
 * NaN or infinite values never reach JSON: required fields fall back to a safe value
 * (and a sigma that says "don't trust this"), optional fields become null.
 */
object FrameJson {

    fun encode(f: FrameData): String {
        val simulated = f.output.simulatedEgo != null
        val ego = f.output.simulatedEgo ?: f.ego
        val sb = StringBuilder(512 + 160 * (f.output.objects.size + f.output.hazards.size))
        sb.append("{\"v\":").append(CONTRACT_VERSION)
        sb.append(",\"t\":").append(f.tEpochMs)
        sb.append(",\"seq\":").append(f.seq)

        sb.append(",\"model\":{\"id\":").str(f.model.id)
            .append(",\"version\":").str(f.model.version)
            .append(",\"calib\":").str(f.model.calib).append('}')

        sb.append(",\"perf\":{\"fps\":").num(f.perf.fps, 1, 0.0)
            .append(",\"latencyMs\":").num(f.perf.latencyMs, 1, 0.0)
            .append(",\"thermal\":").str(if (f.perf.thermal in Classes.THERMAL) f.perf.thermal else "none")
            .append(",\"delegate\":").str(f.perf.delegate).append('}')

        val speedOk = ego.speedMs.isFinite() && ego.speedSigma.isFinite()
        sb.append(",\"ego\":{\"speedMs\":").num(if (speedOk) ego.speedMs else 0.0, 2, 0.0)
            .append(",\"speedSigma\":").num(if (speedOk) ego.speedSigma.coerceAtLeast(0.0) else 30.0, 2, 30.0)
            .append(",\"headingDeg\":").numOrNull(ego.headingDeg, 1)
            .append(",\"pitchDeg\":").num(ego.pitchDeg, 1, 0.0)
            .append(",\"rollDeg\":").num(ego.rollDeg, 1, 0.0)
        if (!simulated && ego.lat != null && ego.lng != null && ego.lat.isFinite() && ego.lng.isFinite()) {
            sb.append(",\"lat\":").num(ego.lat, 7, 0.0)
                .append(",\"lng\":").num(ego.lng, 7, 0.0)
                .append(",\"posSigmaM\":").numOrNull(ego.posSigmaM, 1)
        }
        sb.append('}')

        val usable = if (f.quality.usable.isFinite()) f.quality.usable.coerceIn(0.0, 1.0) else 0.0
        sb.append(",\"quality\":{\"usable\":").num(usable, 3, 0.0).append(",\"reasons\":[")
        f.quality.reasons.filter { it in Classes.QUALITY }.forEachIndexed { i, r -> if (i > 0) sb.append(','); sb.str(r) }
        sb.append("]}")

        sb.append(",\"objects\":[")
        var first = true
        for (o in f.output.objects) {
            if (o.cls !in Classes.OBJECTS || !o.distM.isFinite() || !o.closingMs.isFinite()) continue
            if (!first) sb.append(','); first = false
            sb.append("{\"id\":").append(o.id)
                .append(",\"cls\":").str(o.cls)
                .append(",\"conf\":").num(o.conf.coerceIn(0.0, 1.0), 3, 0.0)
                .append(",\"box\":").box(o.box)
                .append(",\"distM\":").num(o.distM, 2, 0.0)
                .append(",\"distSigma\":").num(o.distSigma.coerceAtLeast(0.0), 2, 99.0)
                .append(",\"closingMs\":").num(o.closingMs, 2, 0.0)
                .append(",\"closingSigma\":").num(o.closingSigma.coerceAtLeast(0.0), 2, 99.0)
                .append(",\"ttcS\":").numOrNull(o.ttcS?.takeIf { it >= 0 }, 2)
                .append(",\"lane\":").str(if (o.lane in Classes.LANES) o.lane else "unknown")
                .append('}')
        }
        sb.append(']')

        sb.append(",\"hazards\":[")
        first = true
        for (h in f.output.hazards) {
            if (h.cls !in Classes.HAZARDS || !h.distM.isFinite() || !h.lateralM.isFinite()) continue
            if (!first) sb.append(','); first = false
            sb.append("{\"id\":").append(h.id)
                .append(",\"cls\":").str(h.cls)
                .append(",\"conf\":").num(h.conf.coerceIn(0.0, 1.0), 3, 0.0)
                .append(",\"box\":").box(h.box)
                .append(",\"distM\":").num(h.distM, 2, 0.0)
                .append(",\"distSigma\":").num(h.distSigma.coerceAtLeast(0.0), 2, 99.0)
                .append(",\"lateralM\":").num(h.lateralM, 2, 0.0)
                .append(",\"lateralSigma\":").num(h.lateralSigma.coerceAtLeast(0.0), 2, 99.0)
                .append(",\"sizeM\":").numOrNull(h.sizeM, 2)
                .append('}')
        }
        sb.append(']')

        val ids = f.output.objects.map { it.id }.toSet()
        sb.append(",\"relations\":[")
        first = true
        for (r in f.output.relations) {
            if (r.rel !in Classes.RELATIONS || r.subj !in ids) continue
            if (!first) sb.append(','); first = false
            sb.append("{\"subj\":").append(r.subj)
                .append(",\"rel\":").str(r.rel)
                .append(",\"obj\":")
            if (r.obj == null) sb.append("null") else if (r.obj.toIntOrNull() != null) sb.append(r.obj) else sb.str(r.obj)
            sb.append(",\"conf\":").num(r.conf.coerceIn(0.0, 1.0), 3, 0.0).append('}')
        }
        sb.append("]}")
        return sb.toString()
    }

    // ---------------------------------------------------------------- helpers

    private fun StringBuilder.str(s: String): StringBuilder {
        append('"')
        for (c in s) when {
            c == '"' -> append("\\\"")
            c == '\\' -> append("\\\\")
            c < ' ' -> append(String.format("\\u%04x", c.code))
            else -> append(c)
        }
        return append('"')
    }

    private fun round(v: Double, digits: Int): Double {
        var p = 1.0
        repeat(digits) { p *= 10.0 }
        return Math.round(v * p) / p
    }

    private fun StringBuilder.num(v: Double, digits: Int, fallback: Double): StringBuilder {
        val x = if (v.isFinite()) round(v, digits) else fallback
        // whole numbers without ".0" keep frames short; JSON accepts both
        return if (x == Math.rint(x) && Math.abs(x) < 1e15) append(x.toLong()) else append(x)
    }

    private fun StringBuilder.numOrNull(v: Double?, digits: Int): StringBuilder =
        if (v == null || !v.isFinite()) append("null") else num(v, digits, 0.0)

    private fun StringBuilder.box(b: Box): StringBuilder {
        val c = b.clamped()
        append('[').num(c.x, 4, 0.0).append(',').num(c.y, 4, 0.0).append(',')
        // rounding must never turn a tiny box into width 0 (the contract rejects it)
        append(Math.max(0.0001, round(c.w, 4))).append(',').append(Math.max(0.0001, round(c.h, 4)))
        return append(']')
    }
}
