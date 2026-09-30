"use strict";

/* ============================================================================
   MapUnite client — js/deadreckoning.js
   ==============================================================================
   Tunnel mode: IMU dead reckoning, the estimated-position marker and its
   uncertainty circle/ellipse.

   Classic scripts sharing one global scope (no bundler, no build step),
   loaded by index.html in this order: core → voice → gps → navigation → smartdrive → groupnav → privacy → analytics → deadreckoning → presence → controls → chat → memories → calls → sos → pwa → skunkworks → radio → convoy → boot.
   ============================================================================ */

// ============================================================================
// PHASE 4 — IMU DEAD RECKONING (roadmap Sections 5 + 14)
// ============================================================================
// Keeps the rider's marker moving through tunnels, deep cuttings and canopy
// when GPS drops out, and says honestly how wrong it might be.
//
// Why NOT "integrate the accelerometer twice": a phone accelerometer's bias
// after gravity removal is ~0.05–0.2 m/s². Integrated twice, 0.1 m/s² is
// already 180 m off after 60 s, and the mount's tilt error makes it worse.
// Every production sat-nav does something narrower instead, and so does this:
//
//   HEADING  — the browser's relative `deviceorientation` (the OS's own
//              gyro+accelerometer fusion, no magnetometer, so steel and
//              rebar in a tunnel can't pull it) gives the heading CHANGE of a
//              device-fixed horizontal axis. Anchored to the last GPS course,
//              that is the vehicle heading. Fallback: the raw gyro rate
//              projected on gravity, with sign/scale/bias fitted against GPS
//              course changes (handles iOS's inverted gravity sign and
//              browsers that report rad/s). Last resort: hold the heading.
//   SPEED    — last GPS speed, adjusted only by clear accelerations along the
//              vehicle's forward axis. Which way is "forward" in the phone
//              depends on how it's mounted, so it's LEARNED: a small
//              recursive least-squares fit of GPS acceleration against the
//              horizontal accelerometer components while GPS is good.
//              Accelerations inside a ±0.35 m/s² deadband are treated as bias.
//   ROUTE    — when a route is known (navigation, or your leg of a group
//              trip) the estimate advances ALONG the route line instead of
//              free-flying, which is how car sat-navs handle tunnels. The
//              inertial heading still watches: a sustained turn the route
//              doesn't have means you left it, and the estimate unsnaps.
//   HONESTY  — the uncertainty radius grows with time, speed and heading
//              source, a coarse network fix pulls the estimate in (1-D
//              Kalman blend), and at 5 min or 1.5 km of uncertainty it stops
//              pretending. When GPS returns, the real error is measured and
//              logged ("estimate was 38 m off after 1:12").
//
// The core below is DOM-free (createDeadReckoner) so the same code runs in
// the tunnel simulation used to test it; DeadReckoning further down is the
// browser glue (sensors, permission, map, island, voice, server).
const DR_CFG = Object.freeze({
    goodFixAccM: 35,          // a fix this accurate ends an outage and feeds calibration
    coarseFixAccM: 60,        // worse than this during a drive = "no real GPS"
    outageAfterMs: 4000,      // no good fix for this long while moving = GPS outage
    minSpeedKmh: 12,          // don't dead-reckon a parked car or a walk
    maxDurationMs: 300000,    // after 5 min an estimate is fiction — stop
    maxRadiusM: 1500,         // ...or once the uncertainty is this large
    calWindowMs: 1800,        // calibration sample length (GPS accel from ~2 s of speed change)
    snapMaxM: 40,             // last fix must be this close to the route to snap to it
    snapHeadingDeg: 50,       // ...and heading the same way
    unsnapTurnDeg: 55,        // inertial turn the route doesn't have -> leave the route
    unsnapHoldMs: 4000,
    accelDeadbandMs2: 0.35,   // forward accel below this is treated as sensor bias
    basisTiltDeg: 25,         // phone re-mounted -> relearn its axes
    orientStdDeg: 12,         // orientation heading trusted when offset spread is below this
    logMax: 10
});

const DRMath = {
    D2R: Math.PI / 180,
    wrap180(d) { return ((((d + 180) % 360) + 360) % 360) - 180; },
    wrap360(d) { return ((d % 360) + 360) % 360; },
    dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
    cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; },
    unit(a) { const n = Math.hypot(a[0], a[1], a[2]); return n > 1e-9 ? [a[0] / n, a[1] / n, a[2] / n] : null; },
    vec(o) { return o && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z) ? [o.x, o.y, o.z] : null; },
    // W3C DeviceOrientation: R = Rz(alpha)·Rx(beta)·Ry(gamma) maps DEVICE
    // coordinates to the EARTH frame (x = east, y = north, z = up). The same
    // matrix works for the relative frame, whose "north" is arbitrary.
    rotation(alpha, beta, gamma) {
        const r = DRMath.D2R;
        const cX = Math.cos(beta * r), sX = Math.sin(beta * r);
        const cY = Math.cos(gamma * r), sY = Math.sin(gamma * r);
        const cZ = Math.cos(alpha * r), sZ = Math.sin(alpha * r);
        return [
            cZ * cY - sZ * sX * sY, -cX * sZ, cY * sZ * sX + cZ * sY,
            cY * sZ + cZ * sX * sY, cZ * cX, sZ * sY - cZ * cY * sX,
            -cX * sY, sX, cX * cY
        ];
    },
    // Compass-style heading (clockwise from the frame's north) of a device-fixed vector.
    headingOf(R, v) {
        const e = R[0] * v[0] + R[1] * v[1] + R[2] * v[2];
        const n = R[3] * v[0] + R[4] * v[1] + R[5] * v[2];
        if (Math.hypot(e, n) < 0.5) return null;          // vector nearly vertical: heading undefined
        return DRMath.wrap360(Math.atan2(e, n) / DRMath.D2R);
    },
    distM(lat1, lng1, lat2, lng2) {
        const r = DRMath.D2R;
        const x = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lng2 - lng1) * r / 2) ** 2;
        return 12742000 * Math.asin(Math.sqrt(Math.min(1, x)));
    },
    bearing(lat1, lng1, lat2, lng2) {
        const r = DRMath.D2R;
        const y = Math.sin((lng2 - lng1) * r) * Math.cos(lat2 * r);
        const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng2 - lng1) * r);
        return DRMath.wrap360(Math.atan2(y, x) / r);
    },
    // Short-step move (a 1 s step is metres to tens of metres — planar is exact enough).
    move(lat, lng, headingDeg, distM) {
        const r = DRMath.D2R;
        const dN = distM * Math.cos(headingDeg * r), dE = distM * Math.sin(headingDeg * r);
        return { lat: lat + dN / 111320, lng: lng + dE / (111320 * Math.max(0.01, Math.cos(lat * r))) };
    },
    // Recursive least squares with exponential forgetting: y ≈ θ·x.
    rls(n, lambda, p0 = 1000) {
        const P = []; for (let i = 0; i < n; i++) { P.push(new Array(n).fill(0)); P[i][i] = p0; }
        return { n, lambda, p0, theta: new Array(n).fill(0), P, count: 0, mse: null };
    },
    rlsUpdate(m, x, y) {
        const n = m.n, P = m.P;
        const Px = new Array(n).fill(0);
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Px[i] += P[i][j] * x[j];
        let denom = m.lambda, pred = 0;
        for (let i = 0; i < n; i++) { denom += x[i] * Px[i]; pred += m.theta[i] * x[i]; }
        const err = y - pred;
        for (let i = 0; i < n; i++) m.theta[i] += (Px[i] / denom) * err;
        let trace = 0;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { P[i][j] = (P[i][j] - (Px[i] * Px[j]) / denom) / m.lambda; if (i === j) trace += P[i][j]; }
        // Forgetting without excitation lets P blow up ("wind-up"): cap it.
        if (trace > m.p0 * n) { const k = (m.p0 * n) / trace; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) P[i][j] *= k; }
        m.count++;
        m.mse = m.mse == null ? err * err : 0.92 * m.mse + 0.08 * err * err;
        return err;
    },
    // Route polyline [[lat,lng],...] -> cumulative metres, for arc-length moves.
    prepareRoute(path) {
        if (!Array.isArray(path) || path.length < 2) return null;
        const pts = path.map((p) => (Array.isArray(p) ? { lat: p[0], lng: p[1] } : { lat: p.lat, lng: p.lng })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
        if (pts.length < 2) return null;
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + DRMath.distM(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng));
        return { pts, cum, total: cum[cum.length - 1] };
    },
    projectOnRoute(route, lat, lng) {
        const r = DRMath.D2R, cosLat = Math.cos(lat * r);
        const X = (p) => [(p.lng - lng) * 111320 * cosLat, (p.lat - lat) * 110540];
        let best = null;
        for (let i = 0; i < route.pts.length - 1; i++) {
            const [ax, ay] = X(route.pts[i]), [bx, by] = X(route.pts[i + 1]);
            const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
            let t = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0;
            t = Math.max(0, Math.min(1, t));
            const d = Math.hypot(ax + t * dx, ay + t * dy);
            if (!best || d < best.d) best = { d, i, t };
        }
        const segLen = route.cum[best.i + 1] - route.cum[best.i];
        return { distM: best.d, s: route.cum[best.i] + best.t * segLen, idx: best.i };
    },
    pointAtS(route, s) {
        const S = Math.max(0, Math.min(route.total, s));
        let i = 0;
        while (i < route.cum.length - 2 && route.cum[i + 1] < S) i++;
        const a = route.pts[i], b = route.pts[i + 1];
        const seg = route.cum[i + 1] - route.cum[i];
        const t = seg > 0 ? (S - route.cum[i]) / seg : 0;
        return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, bearing: DRMath.bearing(a.lat, a.lng, b.lat, b.lng), atEnd: S >= route.total - 0.5 };
    }
};

// env: { routeProvider(): [[lat,lng],...] | null, allowed(): boolean }
function createDeadReckoner(env = {}) {
    const M = DRMath, C = DR_CFG;
    const routeProvider = typeof env.routeProvider === "function" ? env.routeProvider : () => null;
    const allowed = typeof env.allowed === "function" ? env.allowed : () => true;
    const newAcc = () => ({ dt: 0, h1: 0, h2: 0, yaw: 0, yawDt: 0 });

    const st = {
        g: null, lastMotionT: 0, basis: null, driftSince: null, motionSamples: 0, hasLinear: false, hasGyro: false,
        orient: null,
        calAcc: newAcc(), tickAcc: newAcc(), calStart: null,
        fwd: M.rls(3, 0.995), fwdExcite: 0,
        gyro: M.rls(2, 0.995), gyroExcite: 0,
        off: { c: 0, s: 0, n: 0, varDeg: 900 },
        lastGood: null, speeds: [],
        outage: null, log: []
    };

    // ---- sensors -------------------------------------------------------------
    function buildBasis(up) {
        // Reference = the device axis most perpendicular to gravity, projected
        // onto the horizontal plane. Fixed in the DEVICE, so it turns with the
        // vehicle as long as the mount doesn't change.
        const absU = up.map(Math.abs);
        const k = absU.indexOf(Math.min(...absU));
        const ref = [0, 0, 0]; ref[k] = 1;
        const d = M.dot(ref, up);
        const e1 = M.unit([ref[0] - d * up[0], ref[1] - d * up[1], ref[2] - d * up[2]]);
        st.basis = { up: up.slice(), e1, e2: M.cross(up, e1) };
    }
    function resetMountCalibration() {
        st.fwd = M.rls(3, 0.995); st.fwdExcite = 0;
        st.off = { c: 0, s: 0, n: 0, varDeg: 900 };
    }
    function onMotion(ev) {
        const t = ev.t;
        let dt = st.lastMotionT ? (t - st.lastMotionT) / 1000 : 0;
        st.lastMotionT = t;
        if (!(dt > 0 && dt < 0.25)) dt = 0;                   // first sample or a gap: don't integrate across it
        const aig = M.vec(ev.aig);
        if (!aig) return;
        const lin = M.vec(ev.lin);
        st.hasLinear = st.hasLinear || Boolean(lin);
        const gRaw = lin ? [aig[0] - lin[0], aig[1] - lin[1], aig[2] - lin[2]] : aig;
        if (!st.g) st.g = gRaw.slice();
        else {
            const a = dt / ((lin ? 0.25 : 1.5) + dt);
            for (let i = 0; i < 3; i++) st.g[i] += a * (gRaw[i] - st.g[i]);
        }
        const up = M.unit(st.g);
        if (!up) return;
        if (!st.basis) buildBasis(up);
        else {
            const ang = Math.acos(Math.max(-1, Math.min(1, M.dot(up, st.basis.up)))) / M.D2R;
            if (ang > C.basisTiltDeg) {
                if (!st.driftSince) st.driftSince = t;
                else if (t - st.driftSince > 3000) { buildBasis(up); resetMountCalibration(); st.driftSince = null; }
            } else st.driftSince = null;
        }
        const la = lin || [aig[0] - st.g[0], aig[1] - st.g[1], aig[2] - st.g[2]];
        const h1 = M.dot(la, st.basis.e1), h2 = M.dot(la, st.basis.e2);
        const rr = ev.rr;
        const yaw = rr && Number.isFinite(rr.alpha) && Number.isFinite(rr.beta) && Number.isFinite(rr.gamma)
            ? rr.beta * up[0] + rr.gamma * up[1] + rr.alpha * up[2] : null;   // spec: alpha about z, beta about x, gamma about y
        if (yaw != null) st.hasGyro = true;
        st.motionSamples++;
        for (const acc of [st.calAcc, st.tickAcc]) {
            acc.dt += dt; acc.h1 += h1 * dt; acc.h2 += h2 * dt;
            if (yaw != null) { acc.yaw += yaw * dt; acc.yawDt += dt; }
        }
    }
    function onOrientation(ev) {
        if (![ev.alpha, ev.beta, ev.gamma].every(Number.isFinite)) return;
        st.orient = { alpha: ev.alpha, beta: ev.beta, gamma: ev.gamma, t: ev.t };
    }
    function psiO(t) {
        if (!st.orient || !st.basis || t - st.orient.t > 1500) return null;
        return M.headingOf(M.rotation(st.orient.alpha, st.orient.beta, st.orient.gamma), st.basis.e1);
    }

    // ---- calibration status --------------------------------------------------
    function fwdReady() {
        const th = st.fwd.theta, gain = Math.hypot(th[0], th[1]);
        // Needs the browser's gravity-free `acceleration`: with only
        // accelerationIncludingGravity, a low-passed gravity estimate absorbs
        // sustained braking and the fit can't be trusted (simulated: 7x worse).
        return st.hasLinear && st.fwdExcite >= 8 && gain > 0.5 && gain < 2 && st.fwd.mse != null && st.fwd.mse < 0.5;
    }
    function gyroReady() {
        const k = Math.abs(st.gyro.theta[0]);
        const plausible = (k > 0.5 && k < 2) || (k > 28 && k < 115);   // deg/s, or a browser reporting rad/s
        return st.gyroExcite >= 6 && plausible && st.gyro.mse != null && st.gyro.mse < 9;
    }
    function orientReady() {
        return st.off.n >= 12 && Math.sqrt(st.off.varDeg) < C.orientStdDeg;
    }
    function headingSource() {
        return orientReady() ? "orientation" : gyroReady() ? "gyro" : "hold";
    }

    // ---- GPS side ----------------------------------------------------------------
    function describeFix(fix) {
        const prev = st.lastGood;
        let speed = Number.isFinite(fix.speed) && fix.speed >= 0 ? fix.speed : null;
        let course = Number.isFinite(fix.heading) && speed != null && speed > 1.5 ? M.wrap360(fix.heading) : null;
        if (prev) {
            const dt = (fix.t - prev.t) / 1000;
            const d = M.distM(prev.lat, prev.lng, fix.lat, fix.lng);
            if (speed == null && dt > 0.4 && dt < 6) speed = d / dt;
            if (course == null && d > 6 && dt < 6) course = M.bearing(prev.lat, prev.lng, fix.lat, fix.lng);
        }
        return { lat: fix.lat, lng: fix.lng, acc: fix.acc, t: fix.t, speed, course, psiO: psiO(fix.t) };
    }
    function calibrate(g) {
        // Orientation-heading consistency: offset = GPS course - device heading.
        if (g.course != null && g.speed != null && g.speed > 4 && g.psiO != null) {
            const o = M.wrap180(g.course - g.psiO) * M.D2R;
            const w = st.off.n < 10 ? 1 / (st.off.n + 1) : 0.1;
            st.off.c = (1 - w) * st.off.c + w * Math.cos(o);
            st.off.s = (1 - w) * st.off.s + w * Math.sin(o);
            const mean = Math.atan2(st.off.s, st.off.c);
            const resid = M.wrap180((o - mean) / M.D2R);
            st.off.varDeg = st.off.n === 0 ? 400 : (1 - w) * st.off.varDeg + w * resid * resid;
            st.off.n++;
        }
        const s0 = st.calStart;
        if (!s0) { st.calStart = g; st.calAcc = newAcc(); return; }
        const win = g.t - s0.t;
        if (win < C.calWindowMs) return;
        const acc = st.calAcc;
        if (win < 6000 && acc.dt > 0.5 * (win / 1000) && g.speed != null && s0.speed != null) {
            const aGps = (g.speed - s0.speed) / (win / 1000);
            M.rlsUpdate(st.fwd, [acc.h1 / acc.dt, acc.h2 / acc.dt, 1], aGps);
            if (Math.abs(aGps) > 0.6) st.fwdExcite++;
            if (acc.yawDt > 0.5 * (win / 1000) && g.course != null && s0.course != null && g.speed > 4 && s0.speed > 4) {
                const rate = M.wrap180(g.course - s0.course) / (win / 1000);
                M.rlsUpdate(st.gyro, [acc.yaw / acc.yawDt, 1], rate);
                if (Math.abs(rate) > 3) st.gyroExcite++;
            }
        }
        st.calStart = g;
        st.calAcc = newAcc();
    }
    // Speed at the tunnel mouth: the LATEST GPS speed (a median of recent
    // speeds lags while accelerating — simulated: 1.8 m/s low = 300 m over
    // 3 min), unless it disagrees with that median by more than 2 m/s.
    function movingSpeed() {
        if (!st.speeds.length) return 0;
        const s = st.speeds.slice().sort((a, b) => a - b);
        const med = s[Math.floor(s.length / 2)], last = st.speeds[st.speeds.length - 1];
        return Math.abs(last - med) <= 2 ? last : med;
    }

    // ---- outage lifecycle ------------------------------------------------------
    function startOutage(t, reason) {
        const g = st.lastGood;
        if (!g || !allowed() || t - g.t > 60000) return false;
        // No live motion data (no sensors, page in the background, desktop):
        // that would be blind extrapolation, not dead reckoning — don't.
        if (!st.lastMotionT || t - st.lastMotionT > 5000) return false;
        const v0 = movingSpeed();
        if (v0 * 3.6 < C.minSpeedKmh) return false;
        let psi0 = g.course;
        if (psi0 == null) { for (let i = st.recent.length - 1; i >= 0 && psi0 == null; i--) psi0 = st.recent[i].course; }
        const o = {
            reason, startT: g.t, lastT: g.t, lat: g.lat, lng: g.lng, v: v0, v0, psi: psi0, psi0,
            aLp: 0, dist: 0, rBase: Math.max(5, g.acc || 10), tBase: g.t, distBase: 0,
            inertial: 0, psiO0: g.psiO, offset: st.off.n ? Math.atan2(st.off.s, st.off.c) / M.D2R : null, route: null, s: 0, routePsi0: null, mismatchSince: null, trail: [],
            source: headingSource(), fwd: fwdReady(), lost: false, lostAt: null, radius: Math.max(5, g.acc || 10), endOfRoute: false
        };
        const path = routeProvider();
        const route = path ? M.prepareRoute(path) : null;
        if (route) {
            const pr = M.projectOnRoute(route, g.lat, g.lng);
            const segB = M.pointAtS(route, pr.s + 0.5).bearing;
            if (pr.distM <= C.snapMaxM && (psi0 == null || Math.abs(M.wrap180(segB - psi0)) <= C.snapHeadingDeg)) {
                o.route = route; o.s = pr.s; o.routePsi0 = segB; o.psi = segB;
                const p = M.pointAtS(route, pr.s);
                o.lat = p.lat; o.lng = p.lng;
            }
        }
        if (o.psi == null) return false;                       // no direction known and no route: can't estimate
        // st.tickAcc already holds the motion since the last good fix (reset
        // there), which is exactly the span the first propagate() covers.
        st.outage = o;
        return true;
    }
    function inertialDelta(o, acc, t, dt) {
        // Heading CHANGE since the outage began, from the best inertial source.
        if (o.source === "orientation") {
            // psiO + the offset learned over many fixes is a better absolute
            // heading than one noisy GPS course at the tunnel mouth.
            const now = psiO(t);
            if (now != null && o.offset != null && o.psi0 != null) return { ok: true, delta: M.wrap180(now + o.offset - o.psi0) };
            if (now != null && o.psiO0 != null) return { ok: true, delta: M.wrap180(now - o.psiO0) };
        }
        if ((o.source === "gyro" || o.source === "orientation") && gyroReady() && acc.yawDt > 0.2) {
            const [k, c] = st.gyro.theta;
            o.inertial += (k * (acc.yaw / acc.yawDt) + c) * dt;
            return { ok: true, delta: o.inertial };
        }
        return { ok: false, delta: 0 };
    }
    function grow(o, T) {
        // ~1-sigma growth model, tuned in the tunnel simulation (see tests).
        const sv = o.fwd ? 0.3 + 0.04 * o.v0 : 1.0 + 0.12 * o.v0;          // m/s speed error
        const along = sv * T;
        let cross;
        if (o.route) cross = 10;
        else {
            const sPsi = Math.min(90, o.source === "orientation" ? 3 + 0.05 * T : o.source === "gyro" ? 5 + 0.1 * T : 8 + 1.2 * T);
            cross = (o.dist - o.distBase) * Math.sin(sPsi * M.D2R) * 0.7;
        }
        // Batch 1: keep the two directions apart for the ellipse — speed error
        // stretches the estimate ALONG the direction of travel, heading error
        // widens it ACROSS. `radius` (their combination) is unchanged.
        o.semiAlong = Math.hypot(o.rBase, along);
        o.semiCross = Math.hypot(o.rBase, cross);
        return Math.hypot(o.rBase, along, cross);
    }
    function propagate(t) {
        const o = st.outage;
        const dt = (t - o.lastT) / 1000;
        if (!(dt > 0)) return;
        o.lastT = t;
        const acc = st.tickAcc; st.tickAcc = newAcc();

        // Speed: hold, adjusted by clear forward accelerations.
        if (o.fwd && acc.dt > 0.2) {
            const th = st.fwd.theta;
            const aF = th[0] * (acc.h1 / acc.dt) + th[1] * (acc.h2 / acc.dt) + th[2];
            o.aLp += (Math.min(1, dt) / (1 + Math.min(1, dt))) * (aF - o.aLp);
            if (Math.abs(o.aLp) > C.accelDeadbandMs2) o.v += o.aLp * dt;
        }
        o.v = Math.max(0, Math.min(o.v, 45, Math.max(o.v0 * 1.6, o.v0 + 8)));

        const inert = inertialDelta(o, acc, t, dt);
        const step = o.v * dt;
        o.dist += step;
        if (o.route) {
            const from = { lat: o.lat, lng: o.lng };
            o.s += step;
            const p = M.pointAtS(o.route, o.s);
            o.lat = p.lat; o.lng = p.lng; o.psi = p.bearing; o.endOfRoute = p.atEnd;
            if (inert.ok) {
                const routeDelta = M.wrap180(p.bearing - o.routePsi0);
                const diff = Math.abs(M.wrap180(inert.delta - routeDelta));
                // Short trail of (position, step, inertial heading) so an
                // unsnap can rewind to where the paths actually split.
                o.trail.push({ from, step, delta: inert.delta, diff });
                if (o.trail.length > 40) o.trail.shift();
                if (diff > C.unsnapTurnDeg) {
                    if (!o.mismatchSince) o.mismatchSince = t;
                    else if (t - o.mismatchSince > C.unsnapHoldMs) {
                        // The route says straight, the vehicle turned: we left
                        // the route. Rewind to the last step where route and
                        // inertial heading still agreed and re-fly from there.
                        let k = o.trail.length - 1;
                        while (k > 0 && o.trail[k].diff > 10) k--;
                        let pos = o.trail[k].from;
                        for (let j = k; j < o.trail.length; j++) pos = M.move(pos.lat, pos.lng, M.wrap360(o.psi0 + o.trail[j].delta), o.trail[j].step);
                        o.lat = pos.lat; o.lng = pos.lng;
                        o.route = null; o.trail = []; o.psi = M.wrap360(o.psi0 + inert.delta);
                        o.rBase = Math.max(25, o.radius); o.tBase = t; o.distBase = o.dist;
                    }
                } else o.mismatchSince = null;
            }
        } else {
            if (inert.ok && o.psi0 != null) o.psi = M.wrap360(o.psi0 + inert.delta);
            const p = M.move(o.lat, o.lng, o.psi, step);
            o.lat = p.lat; o.lng = p.lng;
        }
        o.radius = grow(o, (t - o.tBase) / 1000);
        // On a known route only the along-track error grows, so a long
        // highway tunnel (Atal, Chenani–Nashri: ~9 km) can be followed longer.
        const maxMs = o.route ? C.maxDurationMs * 3 : C.maxDurationMs;
        if (t - o.startT > maxMs || o.radius > C.maxRadiusM) { o.lost = true; o.lostAt = t; }
    }
    function measurementUpdate(fix) {
        // A coarse (cell/Wi-Fi) fix is still information: blend it in when
        // it's tighter than the estimate (isotropic 1-D Kalman update).
        const o = st.outage;
        const r = o.radius, a = Math.max(1, fix.acc);
        if (!(a < r * 1.5)) return;
        const w = (r * r) / (r * r + a * a);
        o.lat += w * (fix.lat - o.lat);
        o.lng += w * (fix.lng - o.lng);
        o.rBase = Math.sqrt((r * r * a * a) / (r * r + a * a));
        o.tBase = fix.t; o.distBase = o.dist; o.radius = o.rBase;
        o.semiAlong = o.semiCross = o.rBase;
        if (o.route) {
            const pr = M.projectOnRoute(o.route, o.lat, o.lng);
            if (pr.distM > 60) o.route = null;
            else { o.s = pr.s; const p = M.pointAtS(o.route, o.s); o.lat = p.lat; o.lng = p.lng; }
        }
        if (o.lost && o.radius < C.maxRadiusM) { o.lost = false; o.lostAt = null; }
    }
    function endOutage(g) {
        const o = st.outage;
        const summary = {
            at: g.t, startedAt: o.startT, durationMs: g.t - o.startT,
            errorM: Math.round(M.distM(o.lat, o.lng, g.lat, g.lng)), radiusM: Math.round(o.radius),
            distanceM: Math.round(o.dist), source: o.route ? "route" : o.source, lost: o.lost, reason: o.reason
        };
        st.log.unshift(summary);
        if (st.log.length > C.logMax) st.log.length = C.logMax;
        st.outage = null;
        return summary;
    }
    function estimate(t) {
        const o = st.outage;
        if (!o) return null;
        return {
            lat: o.lat, lng: o.lng, radius: Math.round(o.radius), speedKmh: Math.round(o.v * 3.6 * 10) / 10,
            semiAlongM: Math.round(o.semiAlong || o.radius), semiCrossM: Math.round(o.semiCross || o.radius),
            // The along/cross split is only trustworthy with a real heading
            // source AND calibrated forward acceleration (tested in the tunnel
            // simulation: without them the ellipse under-covered the truth).
            axesReliable: Boolean(o.fwd && (o.route || o.source === "orientation" || o.source === "gyro")),
            heading: o.psi == null ? null : Math.round(o.psi), source: o.route ? "route" : o.source,
            elapsedMs: t - o.startT, lost: o.lost, endOfRoute: Boolean(o.endOfRoute)
        };
    }

    st.recent = [];
    return {
        onMotion, onOrientation,
        // fix: {lat, lng, acc, speed (m/s|null), heading (deg|null), t}
        onFix(fix) {
            if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return { verdict: "use" };
            const acc = Number.isFinite(fix.acc) ? fix.acc : 9999;
            if (acc <= C.goodFixAccM) {
                const g = describeFix({ ...fix, acc });
                const ended = st.outage ? endOutage(g) : null;
                calibrate(g);
                st.lastGood = g;
                st.recent.push(g); if (st.recent.length > 5) st.recent.shift();
                if (g.speed != null) { st.speeds.push(g.speed); if (st.speeds.length > 3) st.speeds.shift(); }
                st.tickAcc = newAcc();
                return { verdict: "use", ended };
            }
            if (st.outage) { measurementUpdate({ ...fix, acc }); return { verdict: "suppress" }; }
            if (acc > C.coarseFixAccM && startOutage(fix.t, "coarse-fix")) {
                propagate(fix.t);
                measurementUpdate({ ...fix, acc });
                return { verdict: "suppress", started: true };
            }
            return { verdict: "use" };
        },
        tick(t) {
            const o = st.outage;
            if (o) {
                if (!o.lost) propagate(t);
                return { estimate: estimate(t) };
            }
            const g = st.lastGood;
            if (g && t - g.t > C.outageAfterMs && startOutage(t, "no-fix")) {
                propagate(t);
                return { started: true, estimate: estimate(t) };
            }
            return {};
        },
        active() { return Boolean(st.outage); },
        cancel() { st.outage = null; },
        estimate,
        status() {
            return {
                sensors: { motion: st.motionSamples > 0, linear: st.hasLinear, gyro: st.hasGyro, orientation: Boolean(st.orient) },
                heading: headingSource(), speed: fwdReady() ? "accelerometer" : "hold",
                orientStdDeg: st.off.n ? Math.round(Math.sqrt(st.off.varDeg)) : null, orientSamples: st.off.n,
                fwdExcite: st.fwdExcite, gyroExcite: st.gyroExcite,
                gyroGain: gyroReady() ? Math.round(st.gyro.theta[0] * 100) / 100 : null
            };
        },
        log() { return st.log.slice(); },
        setLog(l) { if (Array.isArray(l)) st.log = l.slice(0, C.logMax); },
        _state: st
    };
}
// ---- end dead-reckoning core ----

// Browser glue: sensors, iOS permission, the 1 Hz loop, and what the rider
// sees and hears. Sensors only run during a drive / group trip in a vehicle
// mode — never in the background of a walk or a parked phone.
const DeadReckoning = {
    KEY_ENABLED: "mu_dr_enabled",
    KEY_LOG: "mu_dr_log",
    enabled: true,
    core: null,
    listening: false,
    permission: "unknown",            // "unknown" | "granted" | "denied" | "not-needed"
    tickTimer: null,
    motionEvents: 0,
    listenStartedAt: 0,
    lastEmitTs: 0,
    lastPointTs: 0,
    lastEstimate: null,
    lostAnnounced: false,
    permissionOffered: false,

    init() {
        try { this.enabled = localStorage.getItem(this.KEY_ENABLED) !== "0"; } catch (e) { /* storage blocked: keep default */ }
        this.permission = this.needsPermission() ? "unknown" : "not-needed";
        this.core = createDeadReckoner({
            routeProvider: () => this.routePath(),
            allowed: () => this.enabled && this.listening && this.vehicleMode()
        });
        try { this.core.setLog(JSON.parse(localStorage.getItem(this.KEY_LOG) || "[]")); } catch (e) { /* corrupt log: start fresh */ }
        this.handleMotion = this.handleMotion.bind(this);
        this.handleOrientation = this.handleOrientation.bind(this);
        this.bindUI();
        document.addEventListener("mu:drive-state", () => this.updateSensors());
        this.updateSensors();
    },

    supported() { return typeof window.DeviceMotionEvent !== "undefined"; },
    needsPermission() { return typeof window.DeviceMotionEvent !== "undefined" && typeof window.DeviceMotionEvent.requestPermission === "function"; },
    vehicleMode() { return (window.currentTravelMode || "bike") !== "walk"; },
    wanted() { return this.enabled && this.supported() && this.vehicleMode() && isDriving(); },

    updateSensors() {
        if (this.wanted() && this.permission !== "denied") {
            if (this.permission === "unknown") { this.offerPermission(); return; }
            this.startSensors();
        } else {
            this.stopSensors();
        }
        this.renderStatus();
    },

    startSensors() {
        if (this.listening) return;
        window.addEventListener("devicemotion", this.handleMotion);
        window.addEventListener("deviceorientation", this.handleOrientation);
        this.listening = true;
        this.listenStartedAt = Date.now();
        clearInterval(this.tickTimer);
        this.tickTimer = setInterval(() => this.tick(), 1000);
    },

    stopSensors() {
        if (!this.listening) return;
        window.removeEventListener("devicemotion", this.handleMotion);
        window.removeEventListener("deviceorientation", this.handleOrientation);
        this.listening = false;
        clearInterval(this.tickTimer);
        this.tickTimer = null;
        // Drive over mid-tunnel: drop the estimate rather than leave a
        // "GPS lost" state nobody will ever clear.
        if (this.core && this.core.active()) {
            this.core.cancel();
            this.finishUi();
            islandHide("dr");
        }
    },

    // iOS 13+: motion access must be requested from a tap. Offer it on the
    // island when a drive starts (and from settings) — never nag in a loop.
    offerPermission() {
        if (this.permissionOffered) return;
        this.permissionOffered = true;
        islandShow({
            id: "dr-perm", kind: "info", icon: "🧭", title: "Allow motion access?",
            sub: "Keeps your position moving in tunnels when GPS drops", ttl: 12000, haptic: false,
            action: { label: "Allow", onClick: () => this.requestPermission() }
        });
    },

    async requestPermission() {
        try {
            const m = await window.DeviceMotionEvent.requestPermission();
            let o = "granted";
            if (window.DeviceOrientationEvent && typeof window.DeviceOrientationEvent.requestPermission === "function") {
                o = await window.DeviceOrientationEvent.requestPermission();
            }
            this.permission = m === "granted" ? "granted" : "denied";
            if (o !== "granted" && m === "granted") console.warn("[DR] orientation denied — heading falls back to the gyroscope");
        } catch (e) {
            this.permission = "denied";
        }
        islandHide("dr-perm");
        this.updateSensors();
    },

    handleMotion(e) {
        this.motionEvents++;
        this.core.onMotion({ t: Date.now(), aig: e.accelerationIncludingGravity, lin: e.acceleration, rr: e.rotationRate });
    },

    handleOrientation(e) {
        this.core.onOrientation({ t: Date.now(), alpha: e.alpha, beta: e.beta, gamma: e.gamma });
    },

    // The route to snap to while GPS is gone: active navigation first, then
    // my own leg of the group trip, then my meetup route.
    routePath() {
        if (navState.active && Array.isArray(navState.routePath) && navState.routePath.length > 1) return navState.routePath;
        const mine = (layer, id) => {
            let found = null;
            layer.eachLayer((l) => {
                if (!found && l.memberId === id && typeof l.getLatLngs === "function") {
                    const ll = l.getLatLngs();
                    if (Array.isArray(ll) && ll.length > 1) found = ll.map((p) => [p.lat, p.lng]);
                }
            });
            return found;
        };
        if (currentTrip && Array.isArray(currentTrip.members) && currentTrip.members.some((m) => m.id === socket.id)) {
            const r = mine(tripRoutesLayer, socket.id);
            if (r) return r;
        }
        if (GroupNavigation.active) return mine(GroupNavigation.layerGroup, "me");
        return null;
    },

    // Called from startGPS() for EVERY fix. "suppress" = a coarse fix during
    // an outage: the estimate already absorbed it, don't jump the marker.
    onGpsFix(p) {
        if (!this.core || !this.enabled) return "use";
        const c = p && p.coords;
        if (!c) return "use";
        const res = this.core.onFix({
            lat: Number(c.latitude), lng: Number(c.longitude), acc: Number(c.accuracy),
            speed: c.speed == null ? null : Number(c.speed), heading: c.heading == null ? null : Number(c.heading), t: Date.now()
        });
        if (res.ended) this.onOutageEnd(res.ended);
        if (res.verdict === "suppress") {
            const est = this.core.estimate(Date.now());
            if (res.started) this.onOutageStart(est);
            if (est) this.apply(est);
        }
        return res.verdict;
    },

    // The navigation watch sees the same raw fixes: while estimating (or at
    // speed), a coarse network fix must not yank the nav marker or trigger
    // a reroute off a 900 m error circle.
    shouldIgnoreNavFix(pos) {
        const acc = pos && pos.coords ? Number(pos.coords.accuracy) : NaN;
        if (!this.core || !this.enabled) return false;
        if (this.core.active()) return !(acc <= DR_CFG.goodFixAccM);
        return this.listening && acc > DR_CFG.coarseFixAccM;
    },

    tick() {
        if (!this.core) return;
        const res = this.core.tick(Date.now());
        if (res.started) this.onOutageStart(res.estimate);
        if (res.estimate) this.apply(res.estimate);
    },

    apply(est) {
        this.lastEstimate = est;
        applyEstimatedPosition(est);
        if (est.lost && !this.lostAnnounced) {
            this.lostAnnounced = true;
            islandShow({ id: "dr", kind: "sensor", icon: "❓", title: "Position uncertain", sub: `No GPS for ${fmtClock(est.elapsedMs)} — last estimate shown`, ttl: 0, sticky: true, priority: 52, haptic: false });
            voiceAnnounce("Still no GPS. Your position on the map is only a rough guess now.", { priority: 45, key: "dr-lost", cooldownMs: 300000, category: "nav", drivingOnly: true });
        } else if (!est.lost) {
            islandShow({ id: "dr", kind: "sensor", icon: "🛰", title: "GPS lost — estimating", sub: this.subFor(est), meta: fmtClock(est.elapsedMs), ttl: 0, sticky: true, priority: 50, haptic: false });
        }
        const chip = $("dr-chip");
        if (chip) {
            chip.hidden = false;
            const t = $("dr-chip-text");
            if (t) t.textContent = est.lost ? "Position uncertain" : `Estimated · ±${formatDistanceShort(est.radius)}`;
            chip.dataset.state = est.lost ? "lost" : "est";
        }
    },

    subFor(est) {
        const r = `±${formatDistanceShort(est.radius)}`;
        if (est.source === "route") return `Following your route · ${r}`;
        if (est.source === "orientation" || est.source === "gyro") return `Motion sensors · ${r}`;
        return `Last speed & heading · ${r}`;
    },

    onOutageStart(est) {
        this.lostAnnounced = false;
        voiceAnnounce("GPS signal lost. Estimating your position.", { priority: 45, key: "dr-start", cooldownMs: 120000, category: "nav", drivingOnly: true });
        if (est) this.apply(est);
    },

    onOutageEnd(summary) {
        this.finishUi();
        this.persistLog();
        const offBy = summary.lost ? "Estimate had given up" : `Estimate was ${formatDistanceShort(summary.errorM)} off`;
        islandShow({ id: "dr", kind: "safe", icon: "🛰", title: "GPS back", sub: `${offBy} after ${fmtClock(summary.durationMs)}`, ttl: 5000, sticky: false, haptic: false });
        voiceAnnounce("GPS is back.", { priority: 35, key: "dr-end", cooldownMs: 60000, category: "nav", drivingOnly: true });
        this.renderStatus();
    },

    finishUi() {
        this.lastEstimate = null;
        this.lostAnnounced = false;
        setOwnMarkerEstimated(false);
        const chip = $("dr-chip");
        if (chip) chip.hidden = true;
        if (myCoords && myCoords.est) { myCoords.est = false; }
    },

    persistLog() {
        try { localStorage.setItem(this.KEY_LOG, JSON.stringify(this.core.log())); } catch (e) { /* quota: the log is a nicety */ }
    },

    clearLocal() {
        try { localStorage.removeItem(this.KEY_LOG); } catch (e) { /* ignore */ }
        if (this.core) this.core.setLog([]);
        this.renderStatus();
    },

    bindUI() {
        const toggle = $("dr-toggle");
        if (toggle) {
            toggle.checked = this.enabled;
            toggle.addEventListener("change", () => {
                this.enabled = toggle.checked;
                try { localStorage.setItem(this.KEY_ENABLED, this.enabled ? "1" : "0"); } catch (e) { /* ignore */ }
                this.updateSensors();
            });
        }
        const perm = $("dr-permission-btn");
        if (perm) perm.addEventListener("click", () => this.requestPermission());
        const settingsBtn = $("profile-open-btn");
        if (settingsBtn) settingsBtn.addEventListener("click", () => setTimeout(() => this.renderStatus(), 0));
    },

    statusText() {
        if (!this.supported()) return "This browser has no motion sensors, so tunnel mode isn't available here.";
        if (!this.enabled) return "Off — the map freezes at your last GPS fix when the signal drops.";
        if (this.permission === "denied") return "Motion access was declined. On iPhone: Settings › Safari › Motion & Orientation Access, then reopen the app.";
        if (!this.listening) return this.vehicleMode() ? "Starts on its own when a drive or group trip begins." : "Off while walking — it models a vehicle, not footsteps.";
        if (!this.motionEvents) return Date.now() - this.listenStartedAt > 3000 ? "No motion data from this device — tunnel mode will hold your last speed and heading." : "Starting motion sensors…";
        const s = this.core.status();
        const heading = s.heading === "orientation" ? "heading from motion sensors ✓" : s.heading === "gyro" ? "heading from gyroscope ✓" : "heading: still learning (a few turns at speed)";
        const speed = s.speed === "accelerometer" ? "speed from accelerometer ✓" : !s.sensors.linear ? "speed: last GPS speed (no linear-acceleration sensor)" : "speed: still learning (a few speed-ups and stops)";
        return `Ready — ${heading}; ${speed}.`;
    },

    renderStatus() {
        const st = $("dr-status");
        if (st) st.textContent = this.statusText();
        const perm = $("dr-permission-btn");
        if (perm) perm.hidden = !(this.needsPermission() && this.permission !== "granted" && this.enabled);
        const list = $("dr-log");
        if (!list || !this.core) return;
        list.textContent = "";
        const log = this.core.log().slice(0, 5);
        if (!log.length) {
            const li = document.createElement("li");
            li.className = "dr-log-empty";
            li.textContent = "No GPS outages recorded yet.";
            list.appendChild(li);
            return;
        }
        log.forEach((e) => {
            const li = document.createElement("li");
            const when = new Date(e.at);
            const day = localDateKey(when) === localDateKey(new Date()) ? "Today" : when.toLocaleDateString([], { day: "numeric", month: "short" });
            const b = document.createElement("b");
            b.textContent = e.lost ? "gave up" : `off by ${formatDistanceShort(e.errorM)}`;
            li.append(`${day} ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${fmtClock(e.durationMs)} without GPS · ${formatDistanceShort(e.distanceM)} · `, b);
            list.appendChild(li);
        });
    }
};

// "1:07" / "12 s" — elapsed time for the island meta and the outage log.
function fmtClock(ms) {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (s < 60) return `${s} s`;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---- estimated-position rendering ------------------------------------------
// A dead-reckoned position moves the marker, the speed dial, the ride log and
// the squad's view of you — but NOT the persisted breadcrumb trail
// (koraput_history), which stays GPS-only.
let ownMarkerEstimated = false;
function setOwnMarkerEstimated(on) {
    if (ownMarkerEstimated === on) return;
    ownMarkerEstimated = on;
    const el = ownMarker && typeof ownMarker.getElement === "function" ? ownMarker.getElement() : null;
    if (el) el.classList.toggle("dr-est", on);
    if (accuracyCircle && typeof accuracyCircle.setStyle === "function") {
        accuracyCircle.setStyle(on
            ? { color: "#ff9f0a", weight: 2, dashArray: "6 6", fillOpacity: 0.07 }
            : { color: "#10b981", weight: 2, dashArray: null, opacity: 1, fillOpacity: 0.15 });
    }
    if (!on) clearUncertaintyEllipse();              // a real fix: back to the plain accuracy circle
}

// Direction-aware uncertainty (roadmap Section 5 / 28 #3): during a GPS
// outage the estimate is drawn as an ellipse — long axis along the direction
// of travel (speed error), short/long across it (heading error) — instead of
// a falsely round circle. Semi-axes are ~1σ in metres from DeadReckoning.
let uncertaintyEllipse = null;
function ellipseLatLngs(lat, lng, semiAlongM, semiCrossM, headingDeg, n = 36) {
    const h = (Number.isFinite(headingDeg) ? headingDeg : 0) * Math.PI / 180;
    const ux = Math.sin(h), uy = Math.cos(h);          // along-track unit (east, north)
    const vx = Math.cos(h), vy = -Math.sin(h);         // cross-track unit
    const mLat = 110540, mLng = 111320 * Math.cos(lat * Math.PI / 180);
    const pts = [];
    for (let i = 0; i < n; i++) {
        const t = (i / n) * 2 * Math.PI, a = semiAlongM * Math.cos(t), b = semiCrossM * Math.sin(t);
        pts.push([lat + (a * uy + b * vy) / mLat, lng + (a * ux + b * vx) / mLng]);
    }
    return pts;
}
function drawUncertaintyEllipse(est) {
    const directional = est.axesReliable === true && Number.isFinite(est.heading) && Number.isFinite(est.semiAlongM) && Number.isFinite(est.semiCrossM);
    if (!directional || typeof L.polygon !== "function") { clearUncertaintyEllipse(); return false; }
    // 1.51σ per axis = the 68% confidence ellipse in 2-D (√χ²₂(0.68)) — the
    // same "about two times in three" the circle stood for, in a truer shape.
    const K68 = 1.51;
    const pts = ellipseLatLngs(est.lat, est.lng, est.semiAlongM * K68, est.semiCrossM * K68, est.heading);
    if (!uncertaintyEllipse) uncertaintyEllipse = L.polygon(pts, { color: "#ff9f0a", weight: 2, dashArray: "6 6", fillOpacity: 0.07, interactive: false, className: "dr-ellipse" }).addTo(map);
    else uncertaintyEllipse.setLatLngs(pts);
    uncertaintyEllipse.muAxes = { along: est.semiAlongM, cross: est.semiCrossM, heading: est.heading };
    return true;
}
function clearUncertaintyEllipse() {
    if (uncertaintyEllipse) { map.removeLayer(uncertaintyEllipse); uncertaintyEllipse = null; }
}

function applyEstimatedPosition(est) {
    if (!est || !validCoord(est.lat, est.lng)) return;
    const alt = myCoords ? myCoords.alt : null;
    myCoords = { lat: est.lat, lng: est.lng, alt, speedKmh: est.speedKmh, est: true, accuracy: est.radius, heading: est.heading };
    if (!ownMarker) ownMarker = L.marker([est.lat, est.lng], { icon: ownIcon(), zIndexOffset: 1000 }).addTo(map);
    else ownMarker.setLatLng([est.lat, est.lng]);
    if (!accuracyCircle) accuracyCircle = L.circle([est.lat, est.lng], { radius: est.radius, color: "#ff9f0a", weight: 2, dashArray: "6 6", fillOpacity: 0.07 }).addTo(map);
    else { accuracyCircle.setLatLng([est.lat, est.lng]); accuracyCircle.setRadius(est.radius); }
    setOwnMarkerEstimated(true);
    // Ellipse when the direction is known; the circle stays (invisible) as the
    // fallback and for code that reads its radius.
    const ellipse = drawUncertaintyEllipse(est);
    if (accuracyCircle && typeof accuracyCircle.setStyle === "function") accuracyCircle.setStyle(ellipse ? { opacity: 0, fillOpacity: 0 } : { opacity: 1, color: "#ff9f0a", weight: 2, dashArray: "6 6", fillOpacity: 0.07 });
    followIfOn(est.lat, est.lng);

    // Speed dial shows the estimate, flagged low-confidence; no alerts fire on it.
    if (!est.lost) SmartDrive.checkSafetyLimits(est.speedKmh, 0.3);

    const now = Date.now();
    if (SmartDrive.trip.active && !est.lost && now - SmartDrive.trip.lastPointTs >= 5000) {
        SmartDrive.trip.points.push({ ts: now, lat: est.lat, lng: est.lng, speedKmh: est.speedKmh, accuracy: est.radius });
        SmartDrive.trip.lastPointTs = now;
        if (SmartDrive.trip.points.length > 2000) SmartDrive.trip.points.shift();
    }
    // Urban tunnels often keep mobile data: the squad sees the estimate,
    // marked as one (server: est + accuracy; geofences skip estimates).
    if (socket.connected && !est.lost && now - DeadReckoning.lastEmitTs >= 3000) {
        DeadReckoning.lastEmitTs = now;
        emitLocation({ lat: est.lat, lng: est.lng, alt, speedKmh: est.speedKmh, accuracy: est.radius, weather: myWeather, est: true });
    }
    document.dispatchEvent(new CustomEvent("mu:dr-position", { detail: est }));
    updateFriendBadges();
}
