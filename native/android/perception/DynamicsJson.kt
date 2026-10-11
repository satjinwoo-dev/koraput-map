package com.mapunite.app.perception

/*
 * DynamicsFrame contract v1 → JSON text (pure Kotlin). One frame per second:
 *
 *   { v: 1, kind: "dynamics", t (epoch ms), seq,
 *     ego: { speedMs, speedSigma, headingDeg, lat?, lng?, posSigmaM? },
 *     longMs2, longMinMs2, longMaxMs2,       longitudinal acceleration over the last second (2 Hz low-pass)
 *     vertRmsMs2, braking, imuHz,
 *     events:   [{ id, type: hard_brake|hard_accel|jolt, t, durS, peakMs2, speedFromMs, speedToMs, dvImuMs, lat, lng, headingDeg, conf, source }],
 *     segments: [{ t, distM, rmsMs2, refRmsMs2, cls: smooth|fair|rough|very_rough, speedMs, lat, lng, headingDeg }] }
 *
 * Validated in JS by public/js/master/perception/dynamics.js.
 */
object DynamicsJson {
    const val VERSION = 1

    fun encode(t: Long, seq: Long, ego: EgoState, s: DynamicsCore.Summary, toEpochMs: (Long) -> Long): String {
        val sb = StringBuilder(256 + 220 * (s.events.size + s.segments.size))
        sb.append("{\"v\":").append(VERSION).append(",\"kind\":\"dynamics\",\"t\":").append(t).append(",\"seq\":").append(seq)
        val speedOk = ego.speedMs.isFinite() && ego.speedSigma.isFinite()
        sb.append(",\"ego\":{\"speedMs\":").num(if (speedOk) ego.speedMs else 0.0, 2)
            .append(",\"speedSigma\":").num(if (speedOk) ego.speedSigma else 30.0, 2)
            .append(",\"headingDeg\":").numOrNull(ego.headingDeg, 1)
        if (ego.lat != null && ego.lng != null && ego.lat.isFinite() && ego.lng.isFinite()) {
            sb.append(",\"lat\":").num(ego.lat, 7).append(",\"lng\":").num(ego.lng, 7).append(",\"posSigmaM\":").numOrNull(ego.posSigmaM, 1)
        }
        sb.append('}')
        sb.append(",\"longMs2\":").num(s.longMeanMs2, 2).append(",\"longMinMs2\":").num(s.longMinMs2, 2).append(",\"longMaxMs2\":").num(s.longMaxMs2, 2)
        sb.append(",\"vertRmsMs2\":").num(s.vertRmsMs2, 2).append(",\"braking\":").append(s.braking).append(",\"imuHz\":").num(s.imuHz, 0)
        sb.append(",\"events\":[")
        s.events.forEachIndexed { i, e ->
            if (i > 0) sb.append(',')
            sb.append("{\"id\":").append(e.id).append(",\"type\":\"").append(e.type).append('"')
                .append(",\"t\":").append(toEpochMs(e.tNs)).append(",\"durS\":").num(e.durS, 2).append(",\"peakMs2\":").num(e.peakMs2, 2)
                .append(",\"speedFromMs\":").numOrNull(e.speedFromMs, 2).append(",\"speedToMs\":").numOrNull(e.speedToMs, 2)
                .append(",\"dvImuMs\":").num(e.dvImuMs, 2)
                .append(",\"lat\":").numOrNull(e.lat, 7).append(",\"lng\":").numOrNull(e.lng, 7).append(",\"headingDeg\":").numOrNull(e.headingDeg, 1)
                .append(",\"conf\":").num(e.conf, 2).append(",\"source\":\"").append(e.source).append("\"}")
        }
        sb.append("],\"segments\":[")
        s.segments.forEachIndexed { i, g ->
            if (i > 0) sb.append(',')
            sb.append("{\"t\":").append(toEpochMs(g.tNs)).append(",\"distM\":").num(g.distM, 1).append(",\"rmsMs2\":").num(g.rmsMs2, 2)
                .append(",\"refRmsMs2\":").num(g.refRmsMs2, 2).append(",\"cls\":\"").append(g.cls).append('"')
                .append(",\"speedMs\":").num(g.speedMs, 2)
                .append(",\"lat\":").numOrNull(g.lat, 7).append(",\"lng\":").numOrNull(g.lng, 7).append(",\"headingDeg\":").numOrNull(g.headingDeg, 1)
                .append('}')
        }
        sb.append("]}")
        return sb.toString()
    }

    private fun round(v: Double, digits: Int): Double { var p = 1.0; repeat(digits) { p *= 10.0 }; return Math.round(v * p) / p }
    private fun StringBuilder.num(v: Double, digits: Int): StringBuilder {
        val x = if (v.isFinite()) round(v, digits) else 0.0
        return if (x == Math.rint(x) && Math.abs(x) < 1e15) append(x.toLong()) else append(x)
    }
    private fun StringBuilder.numOrNull(v: Double?, digits: Int): StringBuilder = if (v == null || !v.isFinite()) append("null") else num(v, digits)
}
