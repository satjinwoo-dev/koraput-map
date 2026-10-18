/* ============================================================================
   MapUnite Ride Edit — watching the clips, and drawing the edit
   ==============================================================================
   MUEditEngine.analyze(file)   → the measurements edit-core.js decides from:
       for a video, ~2 samples a second (up to 40): light, colour
       (Hasler–Süsstrunk), sharpness (variance of the Laplacian), motion
       (change since the previous sample); for a photo, one. Plus a thumbnail.
   MUEditEngine.createPlayer(canvas, plan, assets, opts)
       draws the plan frame by frame (edit-core.js frameAt): the grade of the
       look, zoom and drift, flashes, negatives, glitch strips, shrinking
       frames, letterbox, split panels, the viewfinder, the words, the ride's
       figures counting up, the route drawing itself, the end card; with an
       original beat made in the browser (or the rider's own music).
       play() previews; record() makes the video (MP4 where the phone can,
       else WebM), in real time, all on the phone. Nothing is uploaded.
   ============================================================================ */
"use strict";

const MUEditEngine = (() => {
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : null);
    if (!W || !W.document) return {};
    const C = W.MUEditCore;
    const DISPLAY = '"Sora", "Inter", system-ui, sans-serif', SERIF = 'Georgia, "Times New Roman", serif';

    // ---------------------------------------------------------------- measuring
    function metrics(ctx, w, h) {
        const d = ctx.getImageData(0, 0, w, h).data, n = w * h, L = new Float32Array(n);
        let sum = 0, rgS = 0, rgQ = 0, ybS = 0, ybQ = 0;
        for (let i = 0, p = 0; p < n; i += 4, p++) {
            const r = d[i], g = d[i + 1], b = d[i + 2];
            const l = 0.299 * r + 0.587 * g + 0.114 * b; L[p] = l; sum += l;
            const rg = r - g, yb = 0.5 * (r + g) - b;
            rgS += rg; rgQ += rg * rg; ybS += yb; ybQ += yb * yb;
        }
        const mr = rgS / n, my = ybS / n;
        const sr = Math.sqrt(Math.max(0, rgQ / n - mr * mr)), sy = Math.sqrt(Math.max(0, ybQ / n - my * my));
        const colorful = Math.sqrt(sr * sr + sy * sy) + 0.3 * Math.sqrt(mr * mr + my * my);
        let lap = 0, lapQ = 0, m = 0;
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
            const p = y * w + x, v = 4 * L[p] - L[p - 1] - L[p + 1] - L[p - w] - L[p + w];
            lap += v; lapQ += v * v; m++;
        }
        const lm = lap / Math.max(1, m);
        return { L, bright: sum / n / 255, color: Math.min(1, colorful / 110), sharp: Math.min(1, (lapQ / Math.max(1, m) - lm * lm) / 1800) };
    }
    const once = (el, ev, ms = 4000) => new Promise((res) => { const t = setTimeout(res, ms); el.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true }); });

    /**
     * @param {File} file @param {(f: number) => void} [progress]
     * @returns {Promise<{ kind: "video"|"photo", name: string, url: string, duration: number, w: number, h: number, samples: any[], thumb: string, el?: any, bitmap?: any }|null>}
     */
    async function analyze(file, progress) {
        const url = URL.createObjectURL(file);
        const cv = document.createElement("canvas"), ctx = /** @type {CanvasRenderingContext2D} */ (cv.getContext("2d", { willReadFrequently: true }));
        const thumbCv = document.createElement("canvas"), tctx = /** @type {CanvasRenderingContext2D} */ (thumbCv.getContext("2d"));
        const fit = (w, h, max) => { const k = max / Math.max(w, h); return [Math.max(8, Math.round(w * k)), Math.max(8, Math.round(h * k))]; };
        if (/^image\//.test(file.type)) {
            let bmp;
            try { bmp = await createImageBitmap(file); } catch (e) { return null; }
            const [w, h] = fit(bmp.width, bmp.height, 96);
            cv.width = w; cv.height = h; ctx.drawImage(bmp, 0, 0, w, h);
            const mt = metrics(ctx, w, h);
            const [tw, th] = fit(bmp.width, bmp.height, 220); thumbCv.width = tw; thumbCv.height = th; tctx.drawImage(bmp, 0, 0, tw, th);
            if (progress) progress(1);
            return { kind: "photo", name: file.name, url, duration: 0, w: bmp.width, h: bmp.height, bitmap: bmp, thumb: thumbCv.toDataURL("image/jpeg", 0.7), samples: [{ t: 0, bright: mt.bright, color: mt.color, sharp: mt.sharp, motion: 0 }] };
        }
        if (!/^video\//.test(file.type)) return null;
        const v = document.createElement("video");
        v.muted = true; v.playsInline = true; v.preload = "auto"; v.crossOrigin = "anonymous"; v.src = url;
        await once(v, "loadedmetadata", 8000);
        if (!(v.duration > 0) || !v.videoWidth) return null;
        const dur = Number.isFinite(v.duration) ? v.duration : 10;
        const [w, h] = fit(v.videoWidth, v.videoHeight, 96);
        cv.width = w; cv.height = h;
        const n = Math.max(3, Math.min(40, Math.round(dur / 0.5)));
        const samples = []; let prev = null;
        for (let i = 0; i < n; i++) {
            const t = Math.min(dur - 0.05, (i + 0.5) * dur / n);
            v.currentTime = t;
            await once(v, "seeked", 3000);
            ctx.drawImage(v, 0, 0, w, h);
            const mt = metrics(ctx, w, h);
            let motion = 0;
            if (prev) { let dsum = 0; for (let p = 0; p < mt.L.length; p++) dsum += Math.abs(mt.L[p] - prev[p]); motion = Math.min(1, dsum / mt.L.length / 60); }
            prev = mt.L;
            samples.push({ t: Math.round(t * 100) / 100, bright: mt.bright, color: mt.color, sharp: mt.sharp, motion });
            if (i === Math.floor(n / 2)) { const [tw, th] = fit(v.videoWidth, v.videoHeight, 220); thumbCv.width = tw; thumbCv.height = th; tctx.drawImage(v, 0, 0, tw, th); }
            if (progress) progress((i + 1) / n);
        }
        if (samples.length > 1) samples[0].motion = samples[1].motion;
        return { kind: "video", name: file.name, url, duration: dur, w: v.videoWidth, h: v.videoHeight, el: v, thumb: thumbCv.toDataURL("image/jpeg", 0.7), samples };
    }

    // ---------------------------------------------------------------- the beat (original, made here)
    function beatTrack(ac, dest, plan, t0) {
        const beat = plan.beat, end = t0 + plan.duration;
        const master = ac.createGain(); master.gain.value = 0.8; master.connect(dest);
        master.gain.setValueAtTime(0.8, Math.max(t0, end - 1.6)); master.gain.linearRampToValueAtTime(0.0001, end);
        const noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate); const nd = noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
        const kick = (t, g = 1) => { const o = ac.createOscillator(), a = ac.createGain(); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.14); a.gain.setValueAtTime(0.9 * g, t); a.gain.exponentialRampToValueAtTime(0.001, t + 0.28); o.connect(a).connect(master); o.start(t); o.stop(t + 0.3); };
        const hat = (t, g = 0.18) => { const s = ac.createBufferSource(), f = ac.createBiquadFilter(), a = ac.createGain(); s.buffer = noise; f.type = "highpass"; f.frequency.value = 7000; a.gain.setValueAtTime(g, t); a.gain.exponentialRampToValueAtTime(0.001, t + 0.05); s.connect(f).connect(a).connect(master); s.start(t, Math.random() * 0.5, 0.06); };
        const bass = (t, f0, len) => { const o = ac.createOscillator(), a = ac.createGain(), lp = ac.createBiquadFilter(); o.type = "sawtooth"; o.frequency.value = f0; lp.type = "lowpass"; lp.frequency.value = 380; a.gain.setValueAtTime(0.0001, t); a.gain.linearRampToValueAtTime(0.22, t + 0.02); a.gain.exponentialRampToValueAtTime(0.001, t + len); o.connect(lp).connect(a).connect(master); o.start(t); o.stop(t + len + 0.05); };
        const whoosh = (t) => { const s = ac.createBufferSource(), f = ac.createBiquadFilter(), a = ac.createGain(); s.buffer = noise; f.type = "bandpass"; f.Q.value = 0.8; f.frequency.setValueAtTime(400, t - 0.3); f.frequency.exponentialRampToValueAtTime(5000, t); a.gain.setValueAtTime(0.0001, t - 0.3); a.gain.linearRampToValueAtTime(0.25, t - 0.02); a.gain.exponentialRampToValueAtTime(0.001, t + 0.12); s.connect(f).connect(a).connect(master); s.start(Math.max(ac.currentTime, t - 0.3), 0, 0.45); };
        const notes = plan.style === "mono" ? [41.2, 41.2, 36.7, 49] : [55, 55, 49, 65.4];   // a minor-ish loop, one note a bar
        const intro = plan.shots[0] ? plan.shots[0].durS : 0;
        for (let k = 0, t = t0; t < end - 0.05; k++, t = t0 + k * beat / 2) {
            const onBeat = k % 2 === 0, bar = Math.floor(k / 8);
            if (t < t0 + intro) { if (onBeat && k % 4 === 0) kick(t, 0.6); continue; }                   // a quiet opening
            if (onBeat) kick(t, plan.style === "mono" ? 0.8 : 1);
            if (plan.style !== "mono" || !onBeat) hat(t, onBeat ? 0.08 : 0.16);
            if (k % 8 === 0) bass(t, notes[bar % notes.length], beat * 3.6);
        }
        for (const s of plan.shots) if (s.fx && s.fx.flash) whoosh(t0 + s.at);
    }

    // ---------------------------------------------------------------- drawing
    /** cover-fit a source into a rect with zoom and drift */
    function cover(ctx, src, sw, sh, x, y, w, h, zoom = 1, px = 0, py = 0, tilt = 0) {
        if (!src || !sw || !sh) return;
        const k = Math.max(w / sw, h / sh) * zoom, dw = sw * k, dh = sh * k;
        ctx.save();
        ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
        ctx.translate(x + w / 2 + px * w, y + h / 2 + py * h);
        if (tilt) ctx.rotate(tilt * Math.PI / 180);
        try { ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh); } catch (e) { /* a frame not ready */ }
        ctx.restore();
    }
    const supportsFilter = (() => { try { const c = document.createElement("canvas").getContext("2d"); return Boolean(c && "filter" in c); } catch (e) { return false; } })();
    const FILTER = { teal: "contrast(1.14) saturate(1.22) brightness(1.02)", mono: "grayscale(1) contrast(1.38) brightness(0.96)", punch: "contrast(1.16) saturate(1.5)" };
    let grainCv = null;
    function grain() {
        if (grainCv) return grainCv;
        grainCv = document.createElement("canvas"); grainCv.width = grainCv.height = 256;
        const g = /** @type {CanvasRenderingContext2D} */ (grainCv.getContext("2d")), id = g.createImageData(256, 256);
        for (let i = 0; i < id.data.length; i += 4) { const v = 128 + (Math.random() - 0.5) * 120; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
        g.putImageData(id, 0, 0);
        return grainCv;
    }
    function grade(ctx, look, w, h) {
        ctx.save();
        if (look === "mono") {
            if (!supportsFilter) { ctx.globalCompositeOperation = "saturation"; ctx.fillStyle = "#808080"; ctx.fillRect(0, 0, w, h); }
            ctx.globalCompositeOperation = "overlay"; ctx.globalAlpha = 0.16;
            const g = grain(), ox = Math.random() * 256, oy = Math.random() * 256;
            ctx.translate(-ox, -oy); ctx.fillStyle = /** @type {any} */ (ctx.createPattern(g, "repeat")); ctx.fillRect(0, 0, w + 256, h + 256);
        } else if (look === "teal") {
            ctx.globalCompositeOperation = "soft-light"; ctx.fillStyle = "rgba(0,110,130,0.55)"; ctx.fillRect(0, 0, w, h);
            const r = ctx.createRadialGradient(w * 0.55, h * 0.4, 0, w * 0.55, h * 0.4, Math.max(w, h) * 0.7);
            r.addColorStop(0, "rgba(255,150,70,0.35)"); r.addColorStop(1, "rgba(255,150,70,0)");
            ctx.globalCompositeOperation = "overlay"; ctx.fillStyle = r; ctx.fillRect(0, 0, w, h);
        } else {
            ctx.globalCompositeOperation = "soft-light"; ctx.fillStyle = "rgba(255,90,40,0.18)"; ctx.fillRect(0, 0, w, h);
        }
        ctx.restore();
        // vignette
        ctx.save();
        const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
        v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, look === "mono" ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0.45)");
        ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);
        ctx.restore();
    }
    function hud(ctx, w, h, t) {
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = Math.max(2, w / 360);
        const m = w * 0.06, L = w * 0.07;
        for (const [x, y, dx, dy] of [[m, m, 1, 1], [w - m, m, -1, 1], [m, h - m, 1, -1], [w - m, h - m, -1, -1]]) { ctx.beginPath(); ctx.moveTo(x, y + dy * L); ctx.lineTo(x, y); ctx.lineTo(x + dx * L, y); ctx.stroke(); }
        ctx.beginPath(); ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.06, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(w / 2 - w * 0.1, h / 2); ctx.lineTo(w / 2 - w * 0.07, h / 2); ctx.moveTo(w / 2 + w * 0.07, h / 2); ctx.lineTo(w / 2 + w * 0.1, h / 2); ctx.stroke();
        ctx.fillStyle = "#ff3b30"; ctx.beginPath(); ctx.arc(m + w * 0.02, m + w * 0.045, w * 0.012, 0, Math.PI * 2); if (Math.floor(t * 2) % 2 === 0) ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.font = `600 ${Math.round(w * 0.028)}px ui-monospace, monospace`; ctx.textBaseline = "middle";
        const tc = `00:${String(Math.floor(t)).padStart(2, "0")}:${String(Math.floor((t % 1) * 30)).padStart(2, "0")}`;
        ctx.fillText(`REC  ${tc}`, m + w * 0.045, m + w * 0.045);
        ctx.textAlign = "right"; ctx.fillText("MAPUNITE CAM", w - m - w * 0.01, m + w * 0.045);
        ctx.restore();
    }
    function glitch(ctx, w, h, seed) {
        const r = C.rng(seed);
        const snap = document.createElement("canvas"); snap.width = w; snap.height = h;
        const s = /** @type {CanvasRenderingContext2D} */ (snap.getContext("2d")); s.drawImage(ctx.canvas, 0, 0);
        const strips = 7;
        for (let k = 0; k < strips; k++) {
            const y = Math.floor(r() * h), sh = Math.floor(h * (0.03 + r() * 0.1)), dx = (r() - 0.5) * w * 0.18;
            ctx.drawImage(snap, 0, y, w, sh, dx, y, w, sh);
            if (r() < 0.5) { ctx.save(); ctx.globalCompositeOperation = "screen"; ctx.globalAlpha = 0.35; ctx.fillStyle = r() < 0.5 ? "#ff2a2a" : "#00e5ff"; ctx.fillRect(0, y, w, sh); ctx.restore(); }
        }
    }
    const fitFont = (ctx, text, weight, family, maxW, start) => { let s = start; ctx.font = `${weight} ${s}px ${family}`; while (s > 12 && ctx.measureText(text).width > maxW) { s -= 4; ctx.font = `${weight} ${s}px ${family}`; } return s; };
    function drawText(ctx, w, h, f, plan) {
        const tx = f.shot.text;
        if (!tx) return;
        const look = plan.look.grade, red = "#e3262f";
        ctx.save(); ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
        ctx.shadowColor = "rgba(0,0,0,0.55)"; ctx.shadowBlur = w * 0.02;
        const pop = (age) => 1 + Math.max(0, 0.25 - age) * 1.4;
        if (tx.kind === "title" || tx.kind === "end") {
            const a = Math.min(1, f.local / 0.35);
            ctx.globalAlpha = a;
            const t1 = tx.lines[0] || "";
            const s = fitFont(ctx, t1, 900, DISPLAY, w * 0.86, Math.round(w * (look === "mono" ? 0.11 : 0.13)));
            ctx.fillStyle = "#fff";
            if (look !== "mono") ctx.letterSpacing = `${Math.round(s * 0.04)}px`;
            ctx.fillText(t1, w / 2, h * (tx.kind === "end" ? 0.5 : 0.78));
            if (tx.lines[1]) { ctx.font = `600 ${Math.round(w * 0.034)}px ${DISPLAY}`; ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.letterSpacing = `${Math.round(w * 0.006)}px`; ctx.fillText(tx.lines[1], w / 2, h * (tx.kind === "end" ? 0.5 : 0.78) + s * 0.55); }
        } else if (tx.kind === "stat") {
            const m = /^(\d+(?:\.\d+)?)(.*)$/.exec(tx.big || "");
            const k = Math.min(1, f.local / Math.max(0.3, f.shot.durS * 0.5));
            const shown = m ? `${(Number(m[1]) * (1 - Math.pow(1 - k, 3))).toFixed(m[1].includes(".") ? 1 : 0)}${m[2]}` : tx.big;
            const s = fitFont(ctx, tx.big, 900, DISPLAY, w * 0.86, Math.round(w * 0.3));
            ctx.font = `900 ${s}px ${DISPLAY}`;
            ctx.fillStyle = look === "punch" ? red : "#fff";
            ctx.save(); ctx.translate(w / 2, h * 0.56); ctx.scale(pop(f.local), pop(f.local)); ctx.fillText(shown, 0, 0); ctx.restore();
            ctx.font = `700 ${Math.round(w * 0.05)}px ${DISPLAY}`; ctx.fillStyle = "#fff"; ctx.letterSpacing = `${Math.round(w * 0.012)}px`;
            ctx.fillText(tx.small || "", w / 2, h * 0.56 + w * 0.09);
        } else if (tx.kind === "words") {
            const ws = tx.words.slice(0, f.words);
            ctx.textAlign = "left";
            let y = h * 0.34;
            ws.forEach((word, i) => {
                const strong = i % 2 === 0;
                const age = f.local - i * plan.beat;
                const fam = strong ? DISPLAY : SERIF, wt = strong ? 900 : "italic 600";
                const s = fitFont(ctx, strong ? word.toUpperCase() : word, wt, fam, w * 0.8, Math.round(w * (strong ? 0.15 : 0.1)));
                ctx.save(); ctx.translate(w * 0.1, y + s); ctx.scale(pop(age), pop(age));
                ctx.fillStyle = strong ? red : "#fff"; ctx.font = `${wt} ${s}px ${fam}`;
                ctx.fillText(strong ? word.toUpperCase() : word, 0, 0); ctx.restore();
                y += s * 1.08;
            });
        } else if (tx.kind === "route" && tx.big) {
            ctx.font = `900 ${Math.round(w * 0.12)}px ${DISPLAY}`; ctx.fillStyle = "#fff"; ctx.fillText(tx.big, w / 2, h * 0.86);
        }
        ctx.restore();
    }
    function drawRoute(ctx, w, h, f, card, look) {
        const g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, look === "mono" ? "#111" : "#06141c"); g.addColorStop(1, look === "mono" ? "#2a2a2a" : "#1b1240");
        ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
        const pts = card && card.route && card.route.pts;
        if (!pts || pts.length < 2) return;
        const box = Math.min(w, h) * 0.78, ox = (w - box) / 2, oy = (h - box) / 2 - h * 0.04;
        const n = Math.max(2, Math.floor(pts.length * Math.min(1, f.u * 1.4)));
        ctx.save();
        ctx.lineCap = "round"; ctx.lineJoin = "round";
        for (const [lw, col, blur] of [[w * 0.03, look === "mono" ? "rgba(255,255,255,.18)" : "rgba(52,224,180,.25)", w * 0.03], [w * 0.012, look === "mono" ? "#fff" : "#34e0b4", 0]]) {
            ctx.shadowColor = look === "mono" ? "#fff" : "#34e0b4"; ctx.shadowBlur = blur; ctx.strokeStyle = col; ctx.lineWidth = lw;
            ctx.beginPath(); for (let i = 0; i < n; i++) { const x = ox + pts[i][0] * box, y = oy + pts[i][1] * box; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); } ctx.stroke();
        }
        const [ex, ey] = pts[n - 1];
        ctx.shadowBlur = w * 0.03; ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(ox + ex * box, oy + ey * box, w * 0.016, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
    }

    /**
     * @param {HTMLCanvasElement} canvas @param {any} plan @param {any[]} assets the analysed media (same order as plan.media)
     * @param {{ card?: any, music?: AudioBuffer|null, beat?: boolean }} [opts]
     */
    function createPlayer(canvas, plan, assets, opts = {}) {
        const [W0, H0] = plan.aspect === "wide" ? [1280, 720] : [720, 1280];
        canvas.width = W0; canvas.height = H0;
        const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
        let raf = 0, t0 = 0, playing = false, ac = null, lastShot = -1;
        const look = plan.look.grade;
        const srcOf = (m) => { const a = assets[m]; if (!a) return null; return a.kind === "video" ? { src: a.el, w: a.w, h: a.h, video: a.el } : { src: a.bitmap, w: a.w, h: a.h }; };
        function prime(i) {
            const s = plan.shots[i];
            if (!s || s.kind !== "media") return;
            const a = srcOf(s.m);
            if (a && a.video) { try { a.video.pause(); a.video.currentTime = s.inS; } catch (e) { /* not seekable */ } }
        }
        function startShot(i) {
            const s = plan.shots[i];
            for (const a of assets) if (a && a.kind === "video" && a.el) { try { if (!s || s.m !== assets.indexOf(a)) a.el.pause(); } catch (e) { /* ok */ } }
            if (!s || s.kind !== "media") return;
            const a = srcOf(s.m);
            if (a && a.video) {
                try { if (Math.abs(a.video.currentTime - s.inS) > 0.25) a.video.currentTime = s.inS; a.video.playbackRate = s.fx && s.fx.speed ? s.fx.speed : 1; a.video.play().catch(() => {}); } catch (e) { /* ok */ }
            }
            for (const x of s.extra || []) { const b = srcOf(x.m); if (b && b.video) { try { b.video.currentTime = x.inS; } catch (e) { /* ok */ } } }
        }
        function draw(t) {
            const f = C.frameAt(plan, Math.max(0, Math.min(plan.duration - 0.001, t)));
            if (f.i !== lastShot) { lastShot = f.i; if (playing) { startShot(f.i); prime(f.i + 1); } }
            const w = W0, h = H0, s = f.shot;
            ctx.save();
            ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
            if (supportsFilter) ctx.filter = FILTER[look] || "none";
            if (s.kind === "route") drawRoute(ctx, w, h, f, opts.card, look);
            else if (s.kind === "card") { const g = ctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, look === "mono" ? "#0d0d0d" : "#0b2a2a"); g.addColorStop(1, look === "mono" ? "#333" : "#25155a"); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); }
            else if (s.fx && s.fx.split && s.extra && s.extra.length) {
                const all = [{ m: s.m }, ...s.extra], n = all.length, k = Math.min(1, f.local / 0.3);
                all.forEach((x, j) => {
                    const a = srcOf(x.m); if (!a) return;
                    const pw = w / n, off = (1 - k) * (j % 2 ? -1 : 1) * h * 0.3;
                    cover(ctx, a.src, a.w, a.h, j * pw + 4, off + 4, pw - 8, h - 8, f.zoom);
                });
            } else {
                const a = srcOf(s.m);
                if (a) {
                    const sc = f.shrink, rw = w * sc, rh = h * sc;
                    cover(ctx, a.src, a.w, a.h, (w - rw) / 2, (h - rh) / 2, rw, rh, f.zoom, f.panX, f.panY, s.fx && s.fx.tilt);
                }
            }
            ctx.filter = "none";
            ctx.restore();
            grade(ctx, look, w, h);
            if (look === "mono") { const bar = h * 0.07 * Math.min(1, f.local / 0.3); ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, bar); ctx.fillRect(0, h - bar, w, bar); }
            if (s.fx && s.fx.hud) hud(ctx, w, h, t);
            if (f.glitch) glitch(ctx, w, h, Math.floor(t * 30) + f.i * 97);
            drawText(ctx, w, h, f, plan);
            if (f.flash > 0) { ctx.save(); ctx.globalAlpha = f.flash; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); ctx.restore(); }
            if (f.invert) { ctx.save(); ctx.globalCompositeOperation = "difference"; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); ctx.restore(); }
            return f;
        }
        function audio() {
            const AC = W.AudioContext || W.webkitAudioContext;
            if (!AC) return null;
            ac = new AC();
            const dest = ac.createMediaStreamDestination(), out = ac.createGain();
            out.connect(dest); out.connect(ac.destination);
            const at = ac.currentTime + 0.08;
            if (opts.music) {
                const src = ac.createBufferSource(), g = ac.createGain(); src.buffer = opts.music; g.gain.setValueAtTime(0.9, at); g.gain.setValueAtTime(0.9, at + Math.max(0, plan.duration - 1.6)); g.gain.linearRampToValueAtTime(0.0001, at + plan.duration);
                src.connect(g).connect(out); src.start(at, 0, plan.duration);
            } else if (opts.beat !== false) beatTrack(ac, out, plan, at);
            return { dest, at };
        }
        function stop() {
            playing = false;
            if (raf) cancelAnimationFrame(raf);
            raf = 0;
            for (const a of assets) if (a && a.el) { try { a.el.pause(); } catch (e) { /* ok */ } }
            if (ac) { try { ac.close(); } catch (e) { /* ok */ } ac = null; }
        }
        /** Preview (with sound). @param {(t: number) => void} [onTick] */
        function play(onTick) {
            stop();
            const au = audio();
            playing = true; lastShot = -1;
            prime(0);
            t0 = performance.now() + 80;
            const loop = (now) => {
                if (!playing) return;
                const t = (now - t0) / 1000;
                if (t >= plan.duration) { draw(plan.duration - 0.001); stop(); if (onTick) onTick(plan.duration); return; }
                draw(Math.max(0, t));
                if (onTick) onTick(t);
                raf = requestAnimationFrame(loop);
            };
            raf = requestAnimationFrame(loop);
            return au;
        }
        /** Record the video (real time). @param {(f: number) => void} [progress] @returns {Promise<{ blob: Blob, type: string }>} */
        function record(progress) {
            return new Promise((resolve, reject) => {
                if (typeof canvas.captureStream !== "function" || typeof W.MediaRecorder !== "function") { reject(new Error("no-recorder")); return; }
                // H.264 MP4 plays everywhere (WhatsApp, iPhones); otherwise WebM, before an MP4 that would hold VP9
                const types = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
                const type = types.find((x) => { try { return W.MediaRecorder.isTypeSupported(x); } catch (e) { return false; } }) || "";
                const stream = canvas.captureStream(30);
                const au = play((t) => { if (progress) progress(Math.min(1, t / plan.duration)); if (t >= plan.duration) setTimeout(() => { try { rec.stop(); } catch (e) { /* stopped */ } }, 150); });
                if (au && au.dest) for (const tr of au.dest.stream.getAudioTracks()) stream.addTrack(tr);
                const chunks = [];
                const rec = new W.MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 8_000_000 } : undefined);
                rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
                rec.onstop = () => { const t = (type || "video/webm").split(";")[0]; resolve({ blob: new Blob(chunks, { type: t }), type: t }); };
                rec.onerror = (e) => reject(e);
                rec.start(250);
            });
        }
        draw(0.4);
        return { play, stop, record, draw, get playing() { return playing; } };
    }

    return { analyze, createPlayer };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).MUEditEngine = MUEditEngine;
