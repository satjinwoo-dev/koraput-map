/* ============================================================================
   MapUnite Ride Edit — watching the clips, and rendering the Summit Cut EDL
   ==============================================================================
   MUEditEngine.analyze(file, { person })   → what summit.js decides from:
       for a video ~2 samples a second (≤ 40): light, colour (Hasler–
       Süsstrunk), sharpness (variance of the Laplacian), motion, the share of
       sky (blue/cyan or bright overcast in the upper half) and of warm earth
       (orange/red), and the clip's real frame rate (requestVideoFrameCallback);
       with the person model (segment.js): the person's size and position,
       and a cut-out of them for clones, ghosts and text behind them.
   MUEditEngine.createPlayer(canvas, edl, assets, { music, synth, ride })
       plays the EDL frame by frame (summit.js frameAt): the preset's grade,
       push-ins and drift, speed ramps, the picture window resizing, rotated
       frames, 2.5D photos, flashes, shake, the viewfinder, flares, clones,
       ghosts, whip-blur / glitch-slice / box-panel / white / black transitions,
       word-by-word text; with the rider's song or the preset's own track.
       play() previews; record() makes the video (H.264 MP4 where the phone's
       recorder has it, else WebM), in real time, on the phone. Nothing uploaded.
   ============================================================================ */
"use strict";

const MUEditEngine = (() => {
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : null);
    if (!W || !W.document) return {};
    const S = () => W.MUSummit, Bt = () => W.MUEditBeats, Seg = () => W.MUEditSegment;
    const FPS = 30;

    // ================================================================ measuring
    function metrics(ctx, w, h) {
        const d = ctx.getImageData(0, 0, w, h).data, n = w * h, L = new Float32Array(n);
        let sum = 0, rgS = 0, rgQ = 0, ybS = 0, ybQ = 0, sky = 0, earth = 0;
        for (let i = 0, p = 0; p < n; i += 4, p++) {
            const r = d[i], g = d[i + 1], b = d[i + 2];
            const l = 0.299 * r + 0.587 * g + 0.114 * b;
            L[p] = l; sum += l;
            const rg = r - g, yb = 0.5 * (r + g) - b;
            rgS += rg; rgQ += rg * rg; ybS += yb; ybQ += yb * yb;
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx ? (mx - mn) / mx : 0, v = mx / 255;
            let hue = 0;
            if (mx !== mn) { hue = mx === r ? ((g - b) / (mx - mn)) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4; hue *= 60; if (hue < 0) hue += 360; }
            const upper = p < n * 0.5;
            if (upper && ((hue >= 170 && hue <= 250 && sat > 0.12 && v > 0.35) || (sat < 0.12 && v > 0.78))) sky++;      // blue/cyan, or bright overcast
            if (((hue <= 40 || hue >= 345) && sat > 0.3 && v > 0.25)) earth++;
        }
        const mrg = rgS / n, myb = ybS / n;
        const sd = Math.sqrt(Math.max(0, rgQ / n - mrg * mrg) + Math.max(0, ybQ / n - myb * myb)), mu = Math.sqrt(mrg * mrg + myb * myb);
        const color = Math.min(1, (sd + 0.3 * mu) / 110);
        let lap = 0, lapQ = 0, m = 0;
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
            const p = y * w + x;
            const v = 4 * L[p] - L[p - 1] - L[p + 1] - L[p - w] - L[p + w];
            lap += v; lapQ += v * v; m++;
        }
        const variance = m ? lapQ / m - (lap / m) * (lap / m) : 0;
        return { L, bright: sum / n / 255, color, sharp: Math.min(1, Math.sqrt(Math.max(0, variance)) / 60), sky: sky / n, earth: earth / n };
    }
    /** Black bars baked into the picture (a letterboxed export): the rows/columns at the edges that stay black. */
    function bars(ctx, w, h) {
        const d = ctx.getImageData(0, 0, w, h).data;
        const row = (y) => { let s = 0; for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; s += d[i] + d[i + 1] + d[i + 2]; } return s / (w * 3); };
        const col = (x) => { let s = 0; for (let y = 0; y < h; y++) { const i = (y * w + x) * 4; s += d[i] + d[i + 1] + d[i + 2]; } return s / (h * 3); };
        let top = 0, bot = h - 1, left = 0, right = w - 1;
        while (top < h * 0.4 && row(top) < 10) top++;
        while (bot > h * 0.6 && row(bot) < 10) bot--;
        while (left < w * 0.4 && col(left) < 10) left++;
        while (right > w * 0.6 && col(right) < 10) right--;
        return [left / w, top / h, (right + 1) / w, (bot + 1) / h];
    }
    /** The picture without the person (their outline filled from a heavy blur of what's around them): the 2.5D background. */
    function cleanPlate(bmp, sw, sh, m) {
        const k = Math.min(1, 1280 / Math.max(sw, sh)), w = Math.round(sw * k), h = Math.round(sh * k);
        const plate = document.createElement("canvas"); plate.width = w; plate.height = h;
        const p = /** @type {CanvasRenderingContext2D} */ (plate.getContext("2d"));
        p.drawImage(bmp, 0, 0, w, h);
        const fill = document.createElement("canvas"); fill.width = w; fill.height = h;
        const f = /** @type {CanvasRenderingContext2D} */ (fill.getContext("2d"));
        f.filter = `blur(${Math.round(Math.max(w, h) * 0.04)}px)`; f.drawImage(bmp, 0, 0, w, h); f.filter = "none";
        // the person's area, grown and softened, cut from the blur and laid over the picture
        f.globalCompositeOperation = "destination-in"; f.filter = `blur(${Math.round(Math.max(w, h) * 0.015)}px)`;
        for (const [dx, dy] of [[0, 0], [-6, 0], [6, 0], [0, -6], [0, 6]]) f.drawImage(m.canvas, dx * w / 256, dy * h / 256, w, h);
        f.filter = "none";
        p.drawImage(fill, 0, 0);
        return plate;
    }
    const once = (el, ev, ms) => new Promise((res) => { let done = false; const f = () => { if (done) return; done = true; el.removeEventListener(ev, f); res(true); }; el.addEventListener(ev, f); setTimeout(() => { if (!done) { done = true; el.removeEventListener(ev, f); res(false); } }, ms); });

    /** The clip's real frame rate: the median gap between decoded frames while it plays muted for ~0.7 s. */
    async function frameRate(v) {
        if (typeof v.requestVideoFrameCallback !== "function") return FPS;
        const times = [];
        return new Promise((resolve) => {
            let stop = false;
            const cb = (_now, meta) => { if (stop) return; times.push(meta.mediaTime); if (times.length < 24) v.requestVideoFrameCallback(cb); else finish(); };
            const finish = () => {
                if (stop) return; stop = true; try { v.pause(); } catch (e) { /* ok */ }
                // a slow decoder drops frames, which only makes gaps longer: the short end of the gaps is the clip's own rate
                const d = times.slice(1).map((t, i) => t - times[i]).filter((x) => x > 0.001).sort((a, b) => a - b);
                const gap = d.length ? d[Math.floor(d.length * 0.15)] : 1 / FPS;
                resolve(Math.max(10, Math.min(240, Math.round(1 / gap))));
            };
            v.requestVideoFrameCallback(cb);
            v.currentTime = Math.min(0.5, (v.duration || 1) / 3);
            v.play().catch(() => finish());
            setTimeout(finish, 1500);
        });
    }

    /**
     * @param {File} file @param {{ person?: boolean, progress?: (f: number) => void }} [o]
     */
    async function analyze(file, o = {}) {
        const url = URL.createObjectURL(file);
        const cv = document.createElement("canvas"), ctx = /** @type {CanvasRenderingContext2D} */ (cv.getContext("2d", { willReadFrequently: true }));
        const thumbCv = document.createElement("canvas"), tctx = /** @type {CanvasRenderingContext2D} */ (thumbCv.getContext("2d"));
        const fit = (w, h, max) => { const k = max / Math.max(w, h); return [Math.max(8, Math.round(w * k)), Math.max(8, Math.round(h * k))]; };
        const person = o.person && Seg() && Seg().load ? await Seg().load() : false;
        const withPerson = (sample, src, sw, sh) => {
            if (!person) return null;
            const m = Seg().mask(src, sw, sh);
            if (!m) return null;
            if (m.area > 0.004) Object.assign(sample, { subj: Math.round(m.area * 1000) / 1000, cx: Math.round(m.cx * 1000) / 1000, cy: Math.round(m.cy * 1000) / 1000 });
            return m;
        };
        if (/^image\//.test(file.type)) {
            let bmp;
            try { bmp = await createImageBitmap(file); } catch (e) { return null; }
            const [w, h] = fit(bmp.width, bmp.height, 96);
            cv.width = w; cv.height = h; ctx.drawImage(bmp, 0, 0, w, h);
            const crop = bars(ctx, w, h);
            const mt = metrics(ctx, w, h);
            const sample = { t: 0, bright: mt.bright, color: mt.color, sharp: mt.sharp, motion: 0, sky: r3(mt.sky), earth: r3(mt.earth) };
            const m = withPerson(sample, bmp, bmp.width, bmp.height);
            const cut = m && m.area > 0.004 ? Seg().cutout(bmp, bmp.width, bmp.height, m) : null;
            if (cut) cut.plate = cleanPlate(bmp, bmp.width, bmp.height, m);
            const [tw, th] = fit(bmp.width, bmp.height, 220); thumbCv.width = tw; thumbCv.height = th; tctx.drawImage(bmp, 0, 0, tw, th);
            if (o.progress) o.progress(1);
            return { kind: "photo", name: file.name, url, duration: 0, fps: FPS, w: bmp.width, h: bmp.height, crop, bitmap: bmp, thumb: thumbCv.toDataURL("image/jpeg", 0.7), samples: [sample], mask: Boolean(cut), cut, maskCanvas: m && m.canvas };
        }
        if (!/^video\//.test(file.type)) return null;
        const v = document.createElement("video");
        v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
        await once(v, "loadedmetadata", 8000);
        if (!(v.duration > 0) || !v.videoWidth) return null;
        const dur = Number.isFinite(v.duration) ? v.duration : 10;
        const fps = await frameRate(v);
        const [w, h] = fit(v.videoWidth, v.videoHeight, 96);
        cv.width = w; cv.height = h;
        const n = Math.max(3, Math.min(40, Math.round(dur / 0.5)));
        const samples = []; let prev = null, best = null, crop = [0, 0, 1, 1];
        const personEvery = Math.max(1, Math.round(n / 6));                       // the person model on ~6 frames per clip
        for (let i = 0; i < n; i++) {
            const t = Math.min(dur - 0.05, (i + 0.5) * dur / n);
            v.currentTime = t;
            await once(v, "seeked", 3000);
            ctx.drawImage(v, 0, 0, w, h);
            const mt = metrics(ctx, w, h);
            let motion = 0;
            if (prev) { let dsum = 0; for (let p = 0; p < mt.L.length; p++) dsum += Math.abs(mt.L[p] - prev[p]); motion = Math.min(1, dsum / mt.L.length / 60); }
            prev = mt.L;
            const sample = { t: Math.round(t * 100) / 100, bright: mt.bright, color: mt.color, sharp: mt.sharp, motion, sky: r3(mt.sky), earth: r3(mt.earth) };
            if (i % personEvery === 0) {
                const m = withPerson(sample, v, v.videoWidth, v.videoHeight);
                if (m && m.area > 0.02 && (!best || m.area * mt.sharp > best.score)) best = { score: m.area * mt.sharp, cut: Seg().cutout(v, v.videoWidth, v.videoHeight, m) };
            }
            samples.push(sample);
            if (i === Math.floor(n / 2)) { crop = bars(ctx, w, h); const [tw, th] = fit(v.videoWidth, v.videoHeight, 220); thumbCv.width = tw; thumbCv.height = th; tctx.drawImage(v, 0, 0, tw, th); }
            if (o.progress) o.progress((i + 1) / n);
        }
        if (samples.length > 1) samples[0].motion = samples[1].motion;
        // the person's size between the frames the model saw: carried from the nearest one
        const seen = samples.filter((s) => s.subj !== undefined);
        if (seen.length) for (const s of samples) if (s.subj === undefined) { const nb = seen.reduce((b, x) => (Math.abs(x.t - s.t) < Math.abs(b.t - s.t) ? x : b)); if (Math.abs(nb.t - s.t) < 2) Object.assign(s, { subj: nb.subj, cx: nb.cx, cy: nb.cy }); }
        return { kind: "video", name: file.name, url, duration: dur, fps, w: v.videoWidth, h: v.videoHeight, crop, el: v, thumb: thumbCv.toDataURL("image/jpeg", 0.7), samples, mask: Boolean(best && best.cut), cut: best ? best.cut : null };
    }
    const r3 = (x) => Math.round(x * 1000) / 1000;

    // ================================================================ the preset's own track
    /**
     * An original track on the edit's beat grid, arranged to the plan: a quiet intro under the hook, hats and a
     * riser through the build, the drop on the peak, a tail under the resolve. Made here (WebAudio): no library.
     */
    function track(ac, dest, edl, at) {
        const T = edl.project.duration_s, bpm = edl.project.music.bpm || 120, beat = 60 / bpm;
        const key = edl.project.preset[0];
        const peak = edl.timeline.find((x) => x.section === "peak"), resolve = edl.timeline.find((x) => x.section === "resolve");
        const dropT = peak ? peak.timeline_in_s : T * 0.45, endT = resolve ? resolve.timeline_in_s : T * 0.8;
        const master = ac.createGain(); master.gain.setValueAtTime(0.0001, at); master.gain.linearRampToValueAtTime(0.85, at + 0.15);
        master.gain.setValueAtTime(0.85, at + T - edl.project.music.fade_out_s); master.gain.linearRampToValueAtTime(0.0001, at + T);
        master.connect(dest);
        const noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate); const nd = noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
        const env = (g, t, a, peakV, d) => { g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peakV, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); };
        const kick = (t, v = 1) => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.setValueAtTime(key === "B" ? 110 : 150, t); o.frequency.exponentialRampToValueAtTime(key === "B" ? 38 : 45, t + 0.16); env(g, t, 0.003, 0.95 * v, 0.32); o.connect(g).connect(master); o.start(t); o.stop(t + 0.4); };
        const hit = (t, v, f0, len, type = "highpass") => { const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(); s.buffer = noise; f.type = type; f.frequency.value = f0; env(g, t, 0.002, v, len); s.connect(f).connect(g).connect(master); s.start(t, Math.random() * 0.5, len + 0.05); };
        const clap = (t, v = 0.5) => { hit(t, v, 1500, 0.12, "bandpass"); hit(t + 0.012, v * 0.6, 1800, 0.1, "bandpass"); };
        const bass = (t, f0, len, v = 0.25) => { const o = ac.createOscillator(), lp = ac.createBiquadFilter(), g = ac.createGain(); o.type = "sawtooth"; o.frequency.value = f0; lp.type = "lowpass"; lp.frequency.value = key === "C" ? 600 : 380; env(g, t, 0.01, v, len); o.connect(lp).connect(g).connect(master); o.start(t); o.stop(t + len + 0.1); };
        const pad = (t, freqs, len, v = 0.05) => { for (const f0 of freqs) { const o = ac.createOscillator(), g = ac.createGain(); o.type = "triangle"; o.frequency.value = f0; g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + len * 0.3); g.gain.linearRampToValueAtTime(0.0001, t + len); o.connect(g).connect(master); o.start(t); o.stop(t + len + 0.05); } };
        const riser = (t0, t1) => { const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(); s.buffer = noise; s.loop = true; f.type = "bandpass"; f.Q.value = 1.2; f.frequency.setValueAtTime(300, t0); f.frequency.exponentialRampToValueAtTime(7000, t1); g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(0.22, t1 - 0.02); g.gain.linearRampToValueAtTime(0.0001, t1 + 0.01); s.connect(f).connect(g).connect(master); s.start(t0); s.stop(t1 + 0.05); };
        const boom = (t) => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(30, t + 1.2); env(g, t, 0.005, 0.9, 1.3); o.connect(g).connect(master); o.start(t); o.stop(t + 1.5); hit(t, 0.35, 200, 0.6, "lowpass"); };
        const roots = key === "B" ? [41.2, 41.2, 36.7, 49] : key === "C" ? [55, 65.4, 49, 58.3] : [55, 55, 49, 65.4];
        const chords = key === "B" ? [[110, 130.8, 164.8]] : [[220, 261.6, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6], [196, 246.9, 329.6]];
        for (let k = 0, t = 0; t < T - 0.05; k++, t = k * beat / 2) {
            const on = k % 2 === 0, bi = Math.floor(k / 2), bar = Math.floor(bi / 4), when = at + t;
            const sec = t < (edl.timeline[1] ? edl.timeline[1].timeline_in_s : beat * 4) ? "intro" : t < dropT ? "build" : t < endT ? "drop" : "tail";
            if (bi % 4 === 0 && on && (sec !== "drop" || bar % 2 === 0)) pad(when, chords[bar % chords.length], beat * 4 * (sec === "tail" ? 2 : 1), sec === "tail" ? 0.07 : 0.04);
            if (sec === "intro") { if (on && bi % 2 === 0) kick(when, 0.5); continue; }
            if (sec === "tail") { if (on && bi % 4 === 0) kick(when, 0.6); continue; }
            if (on) kick(when, sec === "drop" ? 1 : 0.8);
            if (on && bi % 2 === 1 && (key !== "B" || sec === "drop")) clap(when, sec === "drop" ? 0.5 : 0.3);
            if (!on || sec === "drop") hit(when, key === "C" && sec === "drop" && k % 3 === 0 ? 0.22 : on ? 0.06 : 0.12, 7000, key === "B" ? 0.03 : 0.05);
            if (on && bi % 4 === 0) bass(when, roots[bar % roots.length], beat * (sec === "drop" ? 0.9 : 3.6), sec === "drop" ? 0.28 : 0.18);
            if (sec === "drop" && on && bi % 4 !== 0 && key !== "B") bass(when, roots[bar % roots.length] * (bi % 2 ? 1 : 2), beat * 0.45, 0.16);
        }
        if (dropT > beat * 4) { riser(at + Math.max(0, dropT - beat * 4), at + dropT); boom(at + dropT); }
        // a whoosh under each whip, glitch and box transition
        for (const it of edl.timeline) if (["whip_blur", "glitch_slices", "box_panels"].includes(it.transition_out.type)) riser(at + it.timeline_out_s - it.transition_out.duration_frames / FPS - 0.1, at + it.timeline_out_s);
    }

    // ================================================================ drawing
    const LOOK = {
        A: { filter: "contrast(1.1) saturate(1.15) brightness(1.03)", shadow: "rgba(14,92,104,0.22)", high: "rgba(255,214,170,0.14)", lift: "rgb(15,17,19)", vignette: 0.32, grain: 0.1 },
        B: { filter: "grayscale(1) contrast(1.38) brightness(0.95)", shadow: null, high: null, lift: null, vignette: 0.16, grain: 0.18 },
        C: { filter: "saturate(1.35) contrast(1.2) brightness(1.02)", shadow: "rgba(0,110,130,0.18)", high: "rgba(255,120,60,0.08)", lift: "rgb(8,10,12)", vignette: 0.16, grain: 0.06 }
    };
    let grainCv = null;
    function grainLayer() {
        if (grainCv) return grainCv;
        grainCv = document.createElement("canvas"); grainCv.width = grainCv.height = 256;
        const g = /** @type {CanvasRenderingContext2D} */ (grainCv.getContext("2d")), img = g.createImageData(256, 256);
        for (let i = 0; i < img.data.length; i += 4) { const v = 128 + (Math.random() - 0.5) * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
        g.putImageData(img, 0, 0);
        return grainCv;
    }
    const easeIO = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2), easeO = (u) => 1 - Math.pow(1 - u, 3);
    const DISPLAY = '"Inter", system-ui, sans-serif', SERIF = '"Playfair Display", Georgia, "Times New Roman", serif', HEAVY = '"Anton", "Bebas Neue", Impact, sans-serif';

    /**
     * @param {HTMLCanvasElement} canvas @param {any} edl @param {Record<string, any>} assets by id
     * @param {{ music?: AudioBuffer|null, ride?: any, onEnd?: () => void }} [opts]
     */
    function createPlayer(canvas, edl, assets, opts = {}) {
        const wide = edl.project.aspect_ratio === "16:9";
        const [CW, CH] = wide ? [1280, 720] : [720, 1280];
        canvas.width = CW; canvas.height = CH;
        const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
        const key = edl.project.preset[0], look = LOOK[key] || LOOK.A;
        const off = document.createElement("canvas"); off.width = CW; off.height = CH;
        const octx = /** @type {CanvasRenderingContext2D} */ (off.getContext("2d"));
        let raf = 0, t0 = 0, playing = false, ac = null, lastI = -1;

        // two video elements per clip: the next shot (often the same clip, jump-cut) waits paused at its frame
        const pool = new Map();
        const occurrence = edl.timeline.map((it, i) => edl.timeline.slice(0, i).filter((x) => x.asset_id === it.asset_id).length % 2);
        function elFor(i) {
            const it = edl.timeline[i]; if (!it) return null;
            const a = assets[it.asset_id]; if (!a || a.kind !== "video") return null;
            if (!pool.has(it.asset_id)) {
                const second = document.createElement("video"); second.muted = true; second.playsInline = true; second.preload = "auto"; second.src = a.url;
                pool.set(it.asset_id, [a.el, second]);
            }
            return pool.get(it.asset_id)[occurrence[i]];
        }
        function prime(i) {
            const it = edl.timeline[i], v = elFor(i);
            if (!it || !v) return;
            try { v.pause(); if (Math.abs(v.currentTime - it.source_in_s) > 0.03) v.currentTime = it.source_in_s; } catch (e) { /* not seekable yet */ }
        }
        function start(i) {
            for (const [, els] of pool) for (const e of els) if (e !== elFor(i) && e !== elFor(i + 1)) { try { e.pause(); } catch (x) { /* ok */ } }
            const it = edl.timeline[i], v = elFor(i);
            if (v && it) { try { if (Math.abs(v.currentTime - it.source_in_s) > 0.12) v.currentTime = it.source_in_s; v.play().catch(() => {}); } catch (e) { /* ok */ } }
            prime(i + 1);
        }

        /** Draw shot i (at local time `local`) into the frame window; returns the subject's place for effects. */
        function drawShot(c, i, f, local, extra = {}) {
            const it = edl.timeline[i]; if (!it) return;
            const a = assets[it.asset_id]; if (!a) return;
            const src = a.kind === "video" ? elFor(i) || a.el : a.bitmap;
            // the picture without any baked-in black bars
            const cr = a.crop || [0, 0, 1, 1];
            const sx = a.w * cr[0], sy = a.h * cr[1], sw = a.w * (cr[2] - cr[0]), sh = a.h * (cr[3] - cr[1]);
            const tr = it.transform;
            const d = it.timeline_out_s - it.timeline_in_s, u = Math.max(0, Math.min(1, local / Math.max(1e-6, d)));
            const sc = (tr.scale_start + (tr.scale_end - tr.scale_start) * easeIO(u)) * (extra.scale || 1);
            const win = extra.window || tr.frame_window.end;
            let ww = CW * win[0], wh = CH * win[1];
            if (ww < 1 || wh < 1) return;
            const wx = (CW - ww) / 2 + (extra.dx || 0), wy = (CH - wh) / 2 + (extra.dy || 0);
            const rot = tr.rotation_deg === 90;                       // the shot turned sideways inside its window
            c.save();
            c.beginPath(); c.rect(wx, wy, ww, wh); c.clip();
            c.translate(wx + ww / 2, wy + wh / 2);
            if (rot) c.rotate(Math.PI / 2);
            const bw = rot ? wh : ww, bh = rot ? ww : wh;
            const k = Math.max(bw / sw, bh / sh) * sc, dw = sw * k, dh = sh * k;
            // keep the subject (crop centre) as near the window centre as the cover allows, then drift
            const cx = tr.crop_center[0], cy = tr.crop_center[1];
            const maxX = (dw - bw) / 2, maxY = (dh - bh) / 2;
            const ox = Math.max(-maxX, Math.min(maxX, (0.5 - cx) * dw)) + tr.position_drift[0] * u * bw, oy = Math.max(-maxY, Math.min(maxY, (0.5 - cy) * dh * 0.6)) + tr.position_drift[1] * u * bh;
            const shake = extra.shake ? [(Math.random() - 0.5) * extra.shake * 2, (Math.random() - 0.5) * extra.shake * 2] : [0, 0];
            try {
                const part = (img, iw, ih, x, y, w2, h2) => c.drawImage(img, iw * cr[0], ih * cr[1], iw * (cr[2] - cr[0]), ih * (cr[3] - cr[1]), x, y, w2, h2);
                if (extra.onlySubject) { if (a.cut && a.cut.canvas) part(a.cut.canvas, a.cut.canvas.width, a.cut.canvas.height, -dw / 2 + ox, -dh / 2 + oy, dw, dh); }
                else if (it.parallax_2_5d && a.cut && a.cut.canvas && a.cut.plate) {
                    // 2.5D: the background without the rider (the clean plate) moves 3 % and is 2 % bigger, so no edge shows; the rider stays
                    part(a.cut.plate, a.cut.plate.width, a.cut.plate.height, -dw * 1.02 / 2 + ox + shake[0] - tr.position_drift[0] * u * bw * 2, -dh * 1.02 / 2 + oy + shake[1], dw * 1.02, dh * 1.02);
                    part(a.cut.canvas, a.cut.canvas.width, a.cut.canvas.height, -dw / 2 + ox + shake[0], -dh / 2 + oy + shake[1], dw, dh);
                } else c.drawImage(src, sx, sy, sw, sh, -dw / 2 + ox + shake[0], -dh / 2 + oy + shake[1], dw, dh);
            } catch (e) { /* a frame not decoded yet */ }
            c.restore();
            return { wx, wy, ww, wh, dw, dh, ox, oy, rot };
        }

        function grade(c, mono) {
            const lk = mono && key !== "B" ? LOOK.B : look;
            // the colour itself was filtered while drawing; here the overlays: teal shadows, warm highlights, lifted blacks, vignette, grain
            c.save();
            if (lk.shadow) { c.globalCompositeOperation = "soft-light"; c.fillStyle = lk.shadow; c.fillRect(0, 0, CW, CH); }
            if (lk.high) { c.globalCompositeOperation = "soft-light"; const g = c.createLinearGradient(0, 0, 0, CH); g.addColorStop(0, lk.high); g.addColorStop(0.6, "rgba(0,0,0,0)"); c.fillStyle = g; c.fillRect(0, 0, CW, CH); }
            if (lk.lift) { c.globalCompositeOperation = "lighten"; c.fillStyle = lk.lift; c.fillRect(0, 0, CW, CH); }
            c.globalCompositeOperation = "source-over";
            const v = c.createRadialGradient(CW / 2, CH / 2, Math.min(CW, CH) * 0.35, CW / 2, CH / 2, Math.max(CW, CH) * 0.75);
            v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, `rgba(0,0,0,${lk.vignette})`);
            c.fillStyle = v; c.fillRect(0, 0, CW, CH);
            c.globalCompositeOperation = "overlay"; c.globalAlpha = lk.grain;
            const gr = grainLayer();
            const gx = Math.random() * 256, gy = Math.random() * 256;
            c.translate(-gx, -gy); c.fillStyle = /** @type {any} */ (c.createPattern(gr, "repeat")); c.fillRect(gx, gy, CW + 256, CH + 256);
            c.restore();
        }

        function hud(c, lines, age) {
            const a = Math.min(1, age / 0.12) * (age < 0.2 && Math.floor(age * 30) % 2 ? 0.5 : 1);
            c.save(); c.globalAlpha = 0.72 * a; c.strokeStyle = "#fff"; c.fillStyle = "#fff"; c.lineWidth = 2;
            const m = CW * 0.07, L = CW * 0.08;
            for (const [x, y, dx, dy] of [[m, m * 1.6, 1, 1], [CW - m, m * 1.6, -1, 1], [m, CH - m * 1.6, 1, -1], [CW - m, CH - m * 1.6, -1, -1]]) { c.beginPath(); c.moveTo(x, y + dy * L); c.lineTo(x, y); c.lineTo(x + dx * L, y); c.stroke(); }
            c.beginPath(); c.arc(CW / 2, CH / 2, CW * 0.05, 0, Math.PI * 2); c.stroke();
            c.beginPath(); c.moveTo(CW / 2 - CW * 0.08, CH / 2); c.lineTo(CW / 2 - CW * 0.055, CH / 2); c.moveTo(CW / 2 + CW * 0.055, CH / 2); c.lineTo(CW / 2 + CW * 0.08, CH / 2); c.stroke();
            c.font = `600 ${Math.round(CH * 0.017)}px ui-monospace, "SFMono-Regular", Menlo, monospace`; c.textBaseline = "top";
            const txt = (lines || []).join("  •  ");
            c.fillText(txt, m + 8, m * 1.6 + 10);
            if (Math.floor(age * 2) % 2 === 0) { c.fillStyle = "#ff3b30"; c.beginPath(); c.arc(m + 2, m * 1.6 + 10 + CH * 0.009, CH * 0.006, 0, Math.PI * 2); c.fill(); }
            c.restore();
        }
        function flare(c, p) {
            c.save(); c.globalCompositeOperation = "screen"; c.globalAlpha = 0.32;
            const x = CW * (0.85 - 0.15 * p), y = CH * 0.12;
            const g = c.createRadialGradient(x, y, 0, x, y, CW * 0.7);
            g.addColorStop(0, "rgba(255,220,170,0.95)"); g.addColorStop(0.2, "rgba(255,170,90,0.35)"); g.addColorStop(1, "rgba(255,150,80,0)");
            c.fillStyle = g; c.fillRect(0, 0, CW, CH);
            c.globalAlpha = 0.16; c.strokeStyle = "rgba(255,200,140,1)"; c.lineWidth = CW * 0.006;
            c.beginPath(); c.arc(CW - x, CH - y * 2, CW * 0.06, 0, Math.PI * 2); c.stroke();
            c.restore();
        }
        function sprite(c, cut, x, y, scale, opts2 = {}) {
            if (!cut || !cut.canvas) return;
            const h = CH * scale, w = h * cut.canvas.width / cut.canvas.height;
            c.save();
            c.globalAlpha = opts2.alpha ?? 1;
            if (opts2.white || opts2.blur) {
                const tmp = document.createElement("canvas"); tmp.width = cut.canvas.width; tmp.height = cut.canvas.height;
                const t2 = /** @type {CanvasRenderingContext2D} */ (tmp.getContext("2d"));
                t2.drawImage(cut.canvas, 0, 0); t2.globalCompositeOperation = "source-in"; t2.fillStyle = "#fff"; t2.fillRect(0, 0, tmp.width, tmp.height);
                if (opts2.blur) c.filter = `blur(${opts2.blur}px)`;
                c.drawImage(tmp, x - w / 2, y - h / 2, w, h);
            } else c.drawImage(cut.canvas, x - w / 2, y - h / 2, w, h);
            c.restore();
        }

        // word-by-word text: each line laid out with all its words (so they don't jump), the revealed ones drawn
        function drawText(c, f, only) {
            const all = only ? f.text.filter(only) : f.text;
            if (!all.length) return;
            const lines = new Map();
            for (const x of all) {
                if (x.style.startsWith("keyword")) continue;
                const host = edl.timeline.find((it) => (it.text || []).some((y) => y.start_s === x.start_s && y.content === x.content));
                const k = `${x.position[1]}|${x.end_s}`;
                if (!lines.has(k)) lines.set(k, { y: x.position[1], words: (host ? host.text : []).filter((y) => y.position[1] === x.position[1] && y.end_s === x.end_s && !y.style.startsWith("keyword")) });
            }
            for (const { y, words } of lines.values()) {
                const sizes = words.map((w) => Math.round(CH * w.size_pct / 100 * (w.style === "serif_red" ? 1.08 : 1)));
                const fonts = words.map((w, i) => (w.style === "serif_red" ? `italic 700 ${sizes[i]}px ${SERIF}` : `600 ${sizes[i]}px ${DISPLAY}`));
                const widths = words.map((w, i) => { c.font = fonts[i]; return c.measureText(w.content).width; });
                const gap = CH * 0.012, total = widths.reduce((a, b) => a + b, 0) + gap * (words.length - 1);
                let x = Math.max(CW * 0.06, (CW - total) / 2);
                words.forEach((w, i) => {
                    const on = all.find((v) => v.start_s === w.start_s && v.content === w.content);
                    if (on) {
                        const sc = on.animation === "scale_in_3f" ? 1 + 0.05 * Math.max(0, 1 - on.age * FPS / 3) : 1;
                        c.save(); c.font = fonts[i]; c.textBaseline = "middle"; c.fillStyle = w.style === "serif_red" ? "#C8102E" : "#fff";
                        c.shadowColor = "rgba(0,0,0,0.45)"; c.shadowBlur = 12;
                        c.translate(x + widths[i] / 2, CH * y); c.scale(sc, sc); c.fillText(w.content, -widths[i] / 2, 0); c.restore();
                    }
                    x += widths[i] + gap;
                });
            }
            for (const x of all.filter((v) => v.style.startsWith("keyword"))) {
                const size = Math.round(CH * x.size_pct / 100), sc = x.animation === "scale_in_3f" ? 1 + 0.05 * Math.max(0, 1 - x.age * FPS / 3) : 1;
                c.save(); c.font = `400 ${size}px ${HEAVY}`; c.textAlign = "center"; c.textBaseline = "middle";
                let fs = size; while (c.measureText(x.content).width > CW * 0.9 && fs > 20) { fs -= 4; c.font = `400 ${fs}px ${HEAVY}`; }
                c.translate(CW * x.position[0], CH * x.position[1]); c.scale(sc, sc);
                if (x.style === "keyword_outline") { c.lineWidth = 3; c.strokeStyle = "#fff"; c.strokeText(x.content, 0, 0); }
                else { c.fillStyle = "#E10600"; c.fillText(x.content, 0, 0); }
                c.restore();
            }
        }

        function frame(t) {
            const f = S().frameAt(edl, t);
            if (f.i !== lastI) { lastI = f.i; if (playing) start(f.i); }
            const it = f.item, mono = it.grade_override && it.grade_override.monochrome;
            // keep the playing clip on the edit's clock and speed curve
            const v = elFor(f.i);
            if (v && playing) {
                try {
                    if (Math.abs(v.playbackRate - f.rate) > 0.02) v.playbackRate = Math.max(0.0625, f.rate);
                    if (Math.abs(v.currentTime - f.sourceT) > 0.25) v.currentTime = f.sourceT;
                } catch (e) { /* ok */ }
            }
            const c = octx;
            c.save(); c.fillStyle = "#000"; c.fillRect(0, 0, CW, CH);
            c.filter = mono ? LOOK.B.filter : look.filter;
            const shake = f.effects.find((e) => e.type === "camera_shake");
            const tr = f.trans;
            if (tr && tr.type === "whip_blur" && tr.next) {
                // out: slide + blur toward the motion; in: from the same side, un-blurring
                const dir = tr.direction === "left" ? -1 : 1, out = tr.p < 0.5, q = out ? easeIO(tr.p * 2) : 1 - easeIO((tr.p - 0.5) * 2);
                const taps = 7, span = CW * 0.18 * q;
                for (let k = 0; k < taps; k++) {
                    c.globalAlpha = 1 / (k + 1) * (k === 0 ? 1 : 0.85);
                    const dx = (out ? 1 : -1) * dir * (CW * 0.35 * q + span * k / taps);
                    if (out) drawShot(c, f.i, f, f.local, { window: f.window, dx });
                    else drawShot(c, f.i + 1, f, 0, { window: tr.next.transform.frame_window.start, dx });
                }
                c.globalAlpha = 1;
            } else {
                drawShot(c, f.i, f, f.local, { window: f.window, shake: shake ? (shake.params.px || 4) : 0 });
            }
            c.filter = "none";
            c.restore();
            // transitions that bring the next shot in over this one
            if (tr && tr.next && tr.type === "glitch_slices") {
                const n = tr.params.strips || 5, rnd = mulberry(Math.floor(t * FPS) + f.i * 31);
                for (let k = 0; k < n; k++) {
                    if (rnd() > Math.min(1, tr.p * 1.6)) continue;
                    const y0 = (k / n) * CH, h = CH / n + 1, dx = (1 - tr.p) * (rnd() - 0.5) * 0.5 * CW;
                    c.save(); c.beginPath(); c.rect(0, y0, CW, h); c.clip(); c.filter = mono ? LOOK.B.filter : look.filter;
                    drawShot(c, f.i + 1, f, 0, { window: tr.next.transform.frame_window.start, dx });
                    c.filter = "none"; c.globalCompositeOperation = "screen"; c.globalAlpha = 0.35;
                    c.fillStyle = "rgba(255,0,60,1)"; c.fillRect(dx + (tr.params.rgb_px || 3), y0, CW, h);
                    c.restore();
                }
            } else if (tr && tr.next && tr.type === "box_panels") {
                const n = tr.params.panels || 2;
                for (let k = 0; k < n; k++) {
                    const appear = Math.min(1, Math.max(0, (tr.p - k * 0.18) / 0.35));
                    if (!appear) continue;
                    const bw = CW * (0.36 + 0.06 * k), bh = bw * (k % 2 ? 1.2 : 0.85), x = CW * (k % 2 ? 0.58 : 0.12), y = CH * (0.25 + 0.22 * k);
                    const s = 0.7 + 0.3 * easeO(appear);
                    c.save(); c.beginPath(); c.rect(x + bw * (1 - s) / 2, y + bh * (1 - s) / 2, bw * s, bh * s); c.clip(); c.filter = mono ? LOOK.B.filter : look.filter;
                    drawShot(c, f.i + 1, f, 0, { window: tr.next.transform.frame_window.start });
                    c.restore();
                    c.save(); c.strokeStyle = "rgba(255,255,255,0.9)"; c.lineWidth = 3; c.strokeRect(x + bw * (1 - s) / 2, y + bh * (1 - s) / 2, bw * s, bh * s); c.restore();
                }
                if (tr.p > 0.82) { c.save(); c.filter = mono ? LOOK.B.filter : look.filter; drawShot(c, f.i + 1, f, 0, { window: tr.next.transform.frame_window.start }); c.restore(); }
            }
            // subject effects
            for (const e of f.effects) {
                if (e.type === "subject_clone") for (const cp of e.params.copies || []) {
                    if (t < cp.appear_s) continue;
                    const a = assets[cp.asset_id];
                    sprite(c, a && a.cut, CW * cp.at[0], CH * cp.at[1], cp.scale, { white: cp.invert });
                }
                if (e.type === "ghost_silhouette") {
                    const prev = edl.timeline[f.i - 1], a = prev && assets[prev.asset_id];
                    if (a && a.cut) sprite(c, a.cut, CW * (a.cut.cx || 0.5), CH * (a.cut.cy || 0.5), 0.8, { white: true, blur: e.params.blur_px || 14, alpha: (e.params.opacity || 0.8) * (1 - e.p) });
                }
            }
            grade(c, mono);
            // text, then the subject on top when the text sits behind them
            // the sign-off (small text on the last shot) is drawn again over the closing fade, so it reads on black
            const last = f.i === edl.timeline.length - 1, signoff = (x) => last && x.size_pct <= 4;
            drawText(c, f);
            const behind = f.effects.find((e) => e.type === "text_behind_subject");
            if (behind) { const a = assets[it.asset_id]; if (a && a.cut) { c.save(); c.filter = mono ? LOOK.B.filter : look.filter; drawShot(c, f.i, f, f.local, { window: f.window, onlySubject: true }); c.restore(); } }
            for (const e of f.effects) {
                if (e.type === "hud_overlay") hud(c, e.params.lines, e.el);
                if (e.type === "lens_flare") flare(c, e.p);
                if (e.type === "white_flash") { const k = e.el * FPS; const a = k < 2 ? 0.85 : Math.max(0, 0.85 * (1 - (k - 2) / 4)); if (a > 0) { c.save(); c.globalCompositeOperation = "screen"; c.globalAlpha = a; c.fillStyle = "#fff"; c.fillRect(0, 0, CW, CH); c.restore(); } }
                if (e.type === "invert_flash" && e.el < e.duration_frames / FPS) {
                    c.save(); c.globalCompositeOperation = "difference"; c.fillStyle = "#fff"; c.fillRect(0, 0, CW, CH);
                    if (e.params.desaturate) { c.globalCompositeOperation = "saturation"; c.globalAlpha = e.params.desaturate; c.fillStyle = "#808080"; c.fillRect(0, 0, CW, CH); }
                    c.restore();
                }
            }
            if (tr && tr.type === "fade_white") { c.save(); c.globalAlpha = 0.95 * easeIO(tr.p); c.fillStyle = "#fff"; c.fillRect(0, 0, CW, CH); c.restore(); }
            if (tr && tr.type === "fade_black") { c.save(); c.globalAlpha = easeIO(tr.p); c.fillStyle = "#000"; c.fillRect(0, 0, CW, CH); c.restore(); }
            if (f.black) { c.fillStyle = "#000"; c.fillRect(0, 0, CW, CH); }
            if (last && (f.black || (tr && /^fade/.test(tr.type)))) drawText(c, f, signoff);
            ctx.drawImage(off, 0, 0);
            return f;
        }
        function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }

        function audio() {
            const AC = W.AudioContext || W.webkitAudioContext;
            if (!AC) return null;
            ac = new AC();
            const dest = ac.createMediaStreamDestination(), out = ac.createGain();
            out.connect(dest); out.connect(ac.destination);
            const at = ac.currentTime + 0.08, T = edl.project.duration_s, mu = edl.project.music;
            if (opts.music) {
                const src = ac.createBufferSource(), g = ac.createGain(); src.buffer = opts.music;
                g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(0.95, at + mu.fade_in_s);
                g.gain.setValueAtTime(0.95, at + Math.max(0, T - mu.fade_out_s)); g.gain.linearRampToValueAtTime(0.0001, at + T);
                src.connect(g).connect(out); src.start(at, mu.start_s, T + 0.05);
            } else track(ac, out, edl, at);
            return { dest, at };
        }
        function stop() {
            playing = false;
            if (raf) cancelAnimationFrame(raf);
            raf = 0;
            for (const [, els] of pool) for (const e of els) { try { e.pause(); } catch (x) { /* ok */ } }
            for (const a of Object.values(assets)) if (a && a.el) { try { a.el.pause(); } catch (x) { /* ok */ } }
            if (ac) { try { ac.close(); } catch (e) { /* ok */ } ac = null; }
        }
        /** Preview with sound. @param {(t: number) => void} [onTick] */
        function play(onTick) {
            stop();
            const au = audio();
            playing = true; lastI = -1;
            prime(0);
            t0 = performance.now() + 80;
            const T = edl.project.duration_s;
            const loop = (now) => {
                if (!playing) return;
                const t = (now - t0) / 1000;
                if (t >= T) { frame(T - 0.001); stop(); if (onTick) onTick(T); if (opts.onEnd) opts.onEnd(); return; }
                frame(Math.max(0, t));
                if (onTick) onTick(t);
                raf = requestAnimationFrame(loop);
            };
            raf = requestAnimationFrame(loop);
            return au;
        }
        /** Record the edit (real time). @param {(f: number) => void} [progress] @returns {Promise<{ blob: Blob, type: string }>} */
        function record(progress) {
            return new Promise((resolve, reject) => {
                if (typeof canvas.captureStream !== "function" || typeof W.MediaRecorder !== "function") { reject(new Error("no-recorder")); return; }
                // H.264 MP4 plays everywhere (WhatsApp, iPhones); otherwise WebM, before an MP4 that would hold VP9
                const types = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
                const type = types.find((x) => { try { return W.MediaRecorder.isTypeSupported(x); } catch (e) { return false; } }) || "";
                const stream = canvas.captureStream(FPS);
                const T = edl.project.duration_s;
                const au = play((t) => { if (progress) progress(Math.min(1, t / T)); if (t >= T) setTimeout(() => { try { rec.stop(); } catch (e) { /* stopped */ } }, 150); });
                if (au && au.dest) for (const tr of au.dest.stream.getAudioTracks()) stream.addTrack(tr);
                const chunks = [];
                const rec = new W.MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 8_000_000 } : undefined);
                rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
                rec.onstop = () => { const tt = (type || "video/webm").split(";")[0]; resolve({ blob: new Blob(chunks, { type: tt }), type: tt }); };
                rec.onerror = (e) => reject(e);
                rec.start(250);
            });
        }
        frame(Math.min(0.4, edl.project.duration_s / 2));
        return { play, stop, record, frame, get playing() { return playing; } };
    }

    /** The rider's song: decoded, its beats found (beats.js). */
    async function songBeats(file) {
        const AC = W.AudioContext || W.webkitAudioContext;
        const ac = new AC();
        try {
            const buf = await ac.decodeAudioData(await file.arrayBuffer());
            // mono at 22.05 kHz for the beat tracker (an OfflineAudioContext resamples)
            const sr = 22050, len = Math.ceil(buf.duration * sr);
            const off = new (W.OfflineAudioContext || W.webkitOfflineAudioContext)(1, len, sr);
            const s = off.createBufferSource(); s.buffer = buf; s.connect(off.destination); s.start();
            const mono = await off.startRendering();
            return { buffer: buf, beats: { ...Bt().analyze(mono.getChannelData(0), sr), track_id: `user:${file.name}`.slice(0, 80) } };
        } finally { try { ac.close(); } catch (e) { /* ok */ } }
    }

    return { analyze, createPlayer, songBeats, metrics };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).MUEditEngine = MUEditEngine;
