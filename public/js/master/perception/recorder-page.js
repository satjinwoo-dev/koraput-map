// @ts-check
/* ============================================================================
   MapUnite — Road data recorder page (recorder.html)
   ==============================================================================
   Drives the MapUnitePerception plugin as owner "recorder": start the camera,
   aim and calibrate the mount, record a ride (2 fps frames + IMU + GNSS), mark
   hazards. All screen text is plain English; units SI (m/s, m, MB).

   describe(status) turns a plugin status into the words on screen; it is pure,
   so node tests cover it. boot() wires the page when it runs in a browser.
   ============================================================================ */
(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    else {
        const W = /** @type {any} */ (root);
        const M = W.MUMaster || (W.MUMaster = {});
        (M.perception || (M.perception = {})).recorderPage = api;
        if (W.document) {
            if (W.document.readyState === "loading") W.document.addEventListener("DOMContentLoaded", () => api.boot(W));
            else api.boot(W);
        }
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const THERMAL_WORDS = { none: "Cool", light: "Warm", moderate: "Hot", severe: "Very hot", critical: "Too hot" };
    const QUALITY_WORDS = { night: "dark", "low-light": "low light", glare: "glare", blur: "blurry", occluded: "blocked", "mount-moved": "mount moved", "rain-on-lens": "rain on lens", fog: "fog" };

    /** @param {number} b */
    function fmtBytes(b) {
        if (!Number.isFinite(b) || b <= 0) return "0 MB";
        const mb = b / 1048576;
        return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
    }
    /** @param {number} ms */
    function fmtDuration(ms) {
        if (!Number.isFinite(ms) || ms < 0) return "–";
        const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
        return h ? `${h} h ${String(m).padStart(2, "0")} min` : m ? `${m} min ${String(ss).padStart(2, "0")} s` : `${ss} s`;
    }
    /** @param {any} v @param {number} [d] */
    const num = (v, d = 1) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : null);

    /**
     * Plugin status → screen words.
     * @param {any} st status from the plugin (or null when the camera is off)
     * @param {number} now epoch ms
     */
    function describe(st, now) {
        const off = !st || !st.running;
        const rec = (st && st.recording) || {};
        /** @type {{ text: string, tone: string }} */
        let chip = { text: "Camera off", tone: "" };
        if (!off) {
            if (rec.active) chip = { text: "Recording", tone: "rec" };
            else if (st.paused) chip = { text: "Paused", tone: "warn" };
            else if ((st.cameraFps || 0) < 5) chip = { text: "Starting…", tone: "warn" };
            else chip = { text: "Camera on", tone: "ok" };
        }
        const cam = st && st.camera;
        const s = (st && st.sensors) || {};
        const q = (st && st.quality) || {};
        const reasons = Array.isArray(q.reasons) ? q.reasons.map((/** @type {string} */ r) => /** @type {any} */ (QUALITY_WORDS)[r] || r) : [];
        const usable = typeof q.usable === "number" ? q.usable : null;
        const gpsSub = off ? "–"
            : !s.gnss ? (s.gnssWhy ? capital(s.gnssWhy) : "No GPS")
            : s.gnssAgeMs === null || s.gnssAgeMs === undefined ? "Waiting for a fix…"
            : s.gnssAgeMs > 3000 ? `Last fix ${Math.round(s.gnssAgeMs / 1000)} s ago`
            : `± ${num(s.speedSigma) ?? "?"} m/s`;
        return {
            chip,
            fps: off ? "–" : `${num(st.cameraFps, 0) ?? "0"} fps`,
            cam: off ? "Not started" : cam ? `${cam.width} × ${cam.height}, ${cam.focus}` : "Opening the camera…",
            thermal: off ? "–" : /** @type {any} */ (THERMAL_WORDS)[st.thermal] || st.thermal || "–",
            battery: off ? "–" : `${st.batteryPct >= 0 ? `Battery ${st.batteryPct} %` : "Battery –"}${st.charging ? ", charging" : ""}${st.thermalCapFps < 30 ? `, capped at ${st.thermalCapFps} fps` : ""}`,
            speed: off ? "–" : s.gnss && s.gnssAgeMs !== null && s.gnssAgeMs !== undefined ? `${num(s.speedMs) ?? "0.0"} m/s` : "–",
            gps: gpsSub,
            quality: off || usable === null ? "–" : usable >= 0.7 ? "Good" : usable >= 0.4 ? "Fair" : "Poor",
            qualityWhy: off ? "–" : reasons.length ? capital(reasons.join(", ")) : "Clear",
            calibration: st && st.calibration
                ? `Calibrated: camera tilt ${num(st.calibration.pitchDeg)}°, roll ${num(st.calibration.rollDeg)}°${st.calibration.mountHeightM ? `, height ${num(st.calibration.mountHeightM, 2)} m` : ""}.`
                : "Not calibrated. Put the bike on its stand on level ground, then tap Calibrate and keep still for 2 seconds.",
            recording: Boolean(rec.active),
            frames: String(rec.frames || 0),
            duration: rec.active && rec.startedAtMs ? fmtDuration(now - rec.startedAtMs) : rec.frames ? "Last ride" : "–",
            size: fmtBytes(rec.bytes || 0),
            free: rec.freeMB === null || rec.freeMB === undefined ? "–" : `${fmtBytes(rec.freeMB * 1048576)} free`,
            imu: String(rec.imuRows || 0),
            gnss: `${rec.gnssRows || 0} GPS fixes, ${rec.events || 0} marks`,
            faces: `${rec.facesBlurred || 0} ${rec.facesBlurred === 1 ? "face" : "faces"}`,
            dir: rec.dir || null
        };
    }

    /** @param {string} s */
    function capital(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

    // ---------------------------------------------------------------- the page

    /** @param {any} W window */
    function boot(W) {
        const doc = W.document;
        const $ = (/** @type {string} */ id) => doc.getElementById(id);
        if (!$("rec-root")) return;
        const NP = W.MUMaster && W.MUMaster.perception && W.MUMaster.perception.native;
        const P = NP ? NP.connect(W, { owner: "recorder" }) : { available: false };
        /** @type {any} */ let status = null;
        let pollTimer = 0, previewTimer = 0, previewBusy = false, busy = false;

        const toast = (/** @type {string} */ msg, tone = "") => {
            const t = $("rec-toast");
            t.textContent = msg; t.dataset.tone = tone; t.classList.add("show");
            clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 3500);
        };
        const fail = (/** @type {any} */ e) => toast((e && e.message) || "Something went wrong.", "error");
        const set = (/** @type {string} */ id, /** @type {string} */ text) => { const el = $(id); if (el && el.textContent !== text) el.textContent = text; };

        function render() {
            const v = describe(status, Date.now());
            const chip = $("rec-chip");
            set("rec-chip", v.chip.text); chip.dataset.tone = v.chip.tone;
            set("rec-fps", v.fps); set("rec-cam", v.cam);
            set("rec-thermal", v.thermal); set("rec-battery", v.battery);
            set("rec-speed", v.speed); set("rec-gps", v.gps);
            set("rec-quality", v.quality); set("rec-quality-why", v.qualityWhy);
            set("rec-cal", v.calibration);
            set("rec-frames", v.frames); set("rec-duration", v.duration);
            set("rec-size", v.size); set("rec-free", v.free);
            set("rec-imu", v.imu); set("rec-gnss", v.gnss); set("rec-faces", v.faces);
            const dir = $("rec-dir");
            dir.hidden = !v.dir; if (v.dir) set("rec-dir", `Saved in ${v.dir}`);
            const running = Boolean(status && status.running);
            // one camera button at a time: Start when off, Stop when on
            $("rec-start").hidden = running;
            $("rec-stop").hidden = !running;
            $("rec-start").disabled = !P.available || busy;
            $("rec-stop").disabled = busy || v.recording;
            $("rec-stop").title = v.recording ? "Stop recording first" : "";
            $("rec-preview-btn").disabled = !running;
            $("rec-calibrate").disabled = !running || busy;
            const tg = $("rec-toggle");
            tg.disabled = !running || busy;
            tg.textContent = v.recording ? "Stop recording" : "Start recording";
            tg.className = v.recording ? "danger big" : "primary big";
            $("rec-scenario").disabled = v.recording;
            for (const b of doc.querySelectorAll("#rec-marks button")) b.disabled = !v.recording;
        }

        async function refresh() {
            if (!P.available) return;
            try { status = await P.status(); } catch (e) { /* keep last */ }
            render();
        }
        function startPolling() { stopPolling(); pollTimer = W.setInterval(refresh, 1000); }
        function stopPolling() { if (pollTimer) W.clearInterval(pollTimer); pollTimer = 0; }

        async function run(/** @type {() => Promise<void>} */ fn) {
            if (busy) return;
            busy = true; render();
            try { await fn(); } catch (e) { fail(e); } finally { busy = false; await refresh(); }
        }

        $("rec-start").addEventListener("click", () => run(async () => {
            status = await P.start({ targetFps: 30, scenario: $("rec-scenario").value });
            startPolling();
            toast("Camera on. Check the view, then start recording.");
        }));
        $("rec-stop").addEventListener("click", () => run(async () => {
            hidePreview();
            await P.stop();
            stopPolling();
            status = null;
        }));
        $("rec-calibrate").addEventListener("click", () => run(async () => {
            toast("Keep the bike still for 2 seconds…");
            const h = parseFloat(String($("rec-height").value).replace(",", "."));
            await P.calibrate(Number.isFinite(h) ? { mountHeightM: h } : {});
            toast("Calibrated.");
        }));
        $("rec-toggle").addEventListener("click", () => run(async () => {
            if (status && status.recording && status.recording.active) {
                const s = await P.stopRecording();
                toast(`Saved ${s.frames} frames (${fmtBytes(s.bytes)}).`);
            } else {
                await P.startRecording({ intervalMs: 500, note: $("rec-note").value });
                toast("Recording. Ride safe.");
            }
        }));
        for (const b of doc.querySelectorAll("#rec-marks button")) {
            b.addEventListener("click", async () => {
                try { if (await P.mark(b.dataset.mark)) toast(`Marked: ${b.textContent}`); } catch (e) { fail(e); }
            });
        }

        // mount preview: a fresh frame every 1.5 s while open and visible
        function hidePreview() { if (previewTimer) W.clearInterval(previewTimer); previewTimer = 0; $("rec-preview").hidden = true; $("rec-preview-btn").textContent = "Check the view"; }
        async function grab() {
            if (previewBusy || doc.hidden) return;
            previewBusy = true;
            try { $("rec-preview-img").src = await P.preview(); } catch (e) { /* next try */ } finally { previewBusy = false; }
        }
        $("rec-preview-btn").addEventListener("click", () => {
            if (previewTimer) { hidePreview(); return; }
            $("rec-preview").hidden = false;
            $("rec-preview-btn").textContent = "Hide the view";
            grab();
            previewTimer = W.setInterval(grab, 1500);
        });

        if (P.available && typeof P.onState === "function") {
            P.onState((/** @type {any} */ s) => {
                if (!s) return;
                if (s.state === "recording-stopped" && s.reason === "storage") toast("Recording stopped: the phone is almost full.", "error");
                else if (s.state === "stalled") toast("The camera stopped sending frames. Another app may be using it.", "error");
                else if (s.state === "thermal" && (s.thermal === "severe" || s.thermal === "critical")) toast("The phone is very hot: the camera slows down to cool it.", "error");
                else if (s.state === "error") toast(s.message || "Camera error.", "error");
                refresh();
            });
        }

        $("rec-unavailable").hidden = Boolean(P.available);
        render();
        // the camera may already be running (e.g. the road agent holds it)
        refresh().then(() => { if (status && status.running) startPolling(); });
        doc.addEventListener("visibilitychange", () => { if (!doc.hidden) refresh(); });
    }

    return { describe, fmtBytes, fmtDuration, boot };
});
