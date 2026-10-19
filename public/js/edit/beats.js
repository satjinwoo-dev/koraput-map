// @ts-check
/* ============================================================================
   MapUnite Ride Edit — the music's beat, on the phone (pure)
   ==============================================================================
   analyze(pcm, sampleRate) → { bpm, beats[], downbeats[], energy[], drops[], firstOnset, duration }

   What a beat tracker like librosa does, small enough for a phone:
     1. onset strength: spectral flux (the rise in each frequency band from one
        23 ms frame to the next, log-compressed, half-wave rectified), every
        ~11.6 ms;
     2. tempo and phase: a comb over that curve for every tempo 70–180 BPM (¼ BPM
        steps), weighted toward the 90–140 that edits are cut to;
     3. beats: the comb's teeth, each
        moved to the strongest onset within ±45 ms (a live drummer drifts);
     4. downbeats: of the 4 possible bar phases, the one whose beats carry the
        most low-band (kick) energy;
     5. energy curve (every 0.25 s, each the loudness of the second around it, 0–1) and drops: a downbeat where the energy
        jumps well above the 2 s before it.
   synthetic(bpm, duration, o) gives the same shape for the agent's own beat.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else /** @type {any} */ (root).MUEditBeats = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const N = 1024, HOP = 512;

    /** In-place radix-2 FFT. @param {Float64Array} re @param {Float64Array} im */
    function fft(re, im) {
        const n = re.length;
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
            for (let i = 0; i < n; i += len) {
                let cr = 1, ci = 0;
                for (let k = 0; k < len / 2; k++) {
                    const ur = re[i + k], ui = im[i + k];
                    const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
                    re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
                    const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
                }
            }
        }
    }

    /**
     * Onset strength (spectral flux) and low-band energy per hop.
     * @param {Float32Array} pcm mono @param {number} sr
     */
    function onsets(pcm, sr) {
        const frames = Math.max(0, Math.floor((pcm.length - N) / HOP) + 1);
        const flux = new Float64Array(frames), low = new Float64Array(frames), rms = new Float64Array(frames);
        const win = new Float64Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
        const re = new Float64Array(N), im = new Float64Array(N);
        let prev = new Float64Array(N / 2), cur = new Float64Array(N / 2);
        const lowBin = Math.max(2, Math.round(150 / (sr / N)));
        // ~24 log-spaced bands (30 Hz – Nyquist), each weighted equally, like a mel spectrogram: a hi-hat's
        // noise fills many bins but few bands, so it can't outvote the kick and snare that carry the beat
        const NB = 24, f0 = 30, f1 = sr / 2, band = new Int16Array(N / 2).fill(-1), bandN = new Float64Array(NB);
        for (let k = 1; k < N / 2; k++) {
            const hz = k * sr / N;
            if (hz < f0) continue;
            const b = Math.min(NB - 1, Math.floor(Math.log(hz / f0) / Math.log(f1 / f0) * NB));
            band[k] = b; bandN[b]++;
        }
        const bandSum = new Float64Array(NB);
        for (let f = 0; f < frames; f++) {
            const off = f * HOP;
            let e = 0;
            for (let i = 0; i < N; i++) { const x = pcm[off + i] || 0; re[i] = x * win[i]; im[i] = 0; e += x * x; }
            rms[f] = Math.sqrt(e / N);
            fft(re, im);
            let lo = 0;
            bandSum.fill(0);
            for (let k = 1; k < N / 2; k++) {
                const m = Math.log1p(100 * Math.hypot(re[k], im[k]));
                cur[k] = m;
                const d = m - prev[k];
                if (d > 0 && band[k] >= 0) bandSum[band[k]] += d;
                if (k <= lowBin) lo += m;
            }
            let sum = 0;
            for (let b = 0; b < NB; b++) if (bandN[b]) sum += bandSum[b] / bandN[b];
            flux[f] = sum; low[f] = lo;
            const t = prev; prev = cur; cur = t;
        }
        // remove the slow trend so loud passages don't swamp the beat
        const out = new Float64Array(frames), W = 16;
        for (let f = 0; f < frames; f++) {
            let s = 0, n = 0;
            for (let k = Math.max(0, f - W); k <= Math.min(frames - 1, f + W); k++) { s += flux[k]; n++; }
            out[f] = Math.max(0, flux[f] - s / n);
        }
        return { onset: out, low, rms, hopS: HOP / sr };
    }

    /** The beat preference: a log-Gaussian around ~118 BPM (edits are cut to 90–140), 0.55 at the edges. @param {number} bpm */
    const prefer = (bpm) => 0.55 + 0.45 * Math.exp(-0.5 * Math.pow(Math.log2(bpm / 118) / 0.6, 2));

    /**
     * Tempo and phase together: a comb of teeth every P hops collects the onset strength at its teeth (±1 hop);
     * the comb with the most, weighted by the preference, wins. More teeth (a faster tempo) collect more when every
     * beat is strong, so a half tempo can't win; a double tempo (the off-beat hi-hats) is out of range.
     * @param {Float64Array} onset @param {number} hopS @returns {{ period: number, phase: number }}
     */
    function tempo(onset, hopS) {
        const at = (x) => { const c = Math.round(x); return Math.max(onset[c - 1] || 0, onset[c] || 0, onset[c + 1] || 0); };
        let best = { period: 60 / 120 / hopS, phase: 0, score: -1 };
        for (let bpm = 70; bpm <= 180; bpm += 0.25) {
            const P = 60 / bpm / hopS;
            let bs = -1, bp = 0;
            for (let ph = 0; ph < P; ph += 1) {
                let sum = 0;
                for (let x = ph; x < onset.length; x += P) sum += at(x);
                if (sum > bs) { bs = sum; bp = ph; }
            }
            const sc = bs * prefer(bpm) / (onset.length * hopS);
            if (sc > best.score) best = { period: P, phase: bp, score: sc };
        }
        return { period: best.period, phase: best.phase };
    }

    /**
     * @param {Float32Array} pcm mono samples @param {number} sampleRate
     * @returns {{ bpm: number, beats: number[], downbeats: number[], energy: number[], energyStep: number, drops: number[], firstOnset: number, duration: number }}
     */
    function analyze(pcm, sampleRate) {
        const duration = pcm.length / sampleRate;
        const { onset, low, rms, hopS } = onsets(pcm, sampleRate);
        if (onset.length < 64) return synthetic(120, duration);
        const { period, phase: bestPh } = tempo(onset, hopS);
        // the beats, each moved to the strongest onset within ±45 ms
        const tol = Math.max(1, Math.round(0.045 / hopS));
        const beatsH = [];
        for (let x = bestPh; x < onset.length; x += period) {
            const c = Math.round(x);
            let bi = c, bv = -1;
            for (let k = Math.max(0, c - tol); k <= Math.min(onset.length - 1, c + tol); k++) if (onset[k] > bv) { bv = onset[k]; bi = k; }
            beatsH.push(bv > 0 ? bi : c);
        }
        // a hop index marks the frame start; the onset sits at its centre
        // (measured on synthetic kicks: the flux peaks about half a window after the hop's start)
        const toT = (h) => Math.round((h * hopS + (N / 2) / sampleRate + hopS / 2) * 1000) / 1000;
        const beats = beatsH.map(toT).filter((t) => t >= 0 && t <= duration);
        // downbeats: the bar phase with the most kick energy
        let bar = 0, barS = -Infinity;
        for (let p = 0; p < 4; p++) {
            let s = 0;
            for (let i = p; i < beatsH.length; i += 4) { let m = 0; for (let k = 0; k < 4; k++) m = Math.max(m, low[beatsH[i] + k] || 0); s += m; }
            if (s > barS) { barS = s; bar = p; }
        }
        const downbeats = beats.filter((_, i) => i % 4 === bar);
        // energy curve every 0.25 s, 0–1
        // (each point is the loudness of the second around it: a 0.25 s block can fall between two kicks)
        const step = 0.25, per = Math.max(1, Math.round(step / hopS)), half = Math.round(0.5 / hopS);
        const energy = [];
        for (let i = 0; i < rms.length; i += per) {
            let s = 0, n = 0;
            for (let k = Math.max(0, i - half); k < Math.min(rms.length, i + half); k++) { s += rms[k]; n++; }
            energy.push(s / Math.max(1, n));
        }
        const emax = Math.max(1e-9, ...energy);
        for (let i = 0; i < energy.length; i++) energy[i] = Math.round((energy[i] / emax) * 1000) / 1000;
        // drops: a downbeat where the next second is ≥ 1.6× the 2 s before it, and loud
        const drops = [];
        for (const d of downbeats) {
            const i = Math.round(d / step);
            const before = energy.slice(Math.max(0, i - 8), i), after = energy.slice(i, i + 4);
            if (before.length < 4 || !after.length) continue;
            const b = before.reduce((a, x) => a + x, 0) / before.length, a2 = after.reduce((a, x) => a + x, 0) / after.length;
            if (a2 > 0.5 && a2 >= 1.6 * Math.max(0.05, b) && (!drops.length || d - drops[drops.length - 1] > 4)) drops.push(d);
        }
        // the first real transient (never cut before it)
        const thr = 0.3 * Math.max(...onset);
        let fo = 0;
        for (let i = 0; i < onset.length; i++) if (onset[i] >= thr) { fo = i; break; }
        return { bpm: Math.round((60 / (period * hopS)) * 10) / 10, beats, downbeats, energy, energyStep: step, drops, firstOnset: toT(fo), duration };
    }

    /**
     * The same shape for a beat the app makes itself: an intro, a build, a drop and an outro over `duration`.
     * @param {number} bpm @param {number} duration @param {{ dropAt?: number }} [o] dropAt: seconds
     */
    function synthetic(bpm, duration, o = {}) {
        const beat = 60 / bpm, beats = [];
        for (let t = 0; t <= duration + 1e-9; t += beat) beats.push(Math.round(t * 1000) / 1000);
        const downbeats = beats.filter((_, i) => i % 4 === 0);
        const dropAt = Number.isFinite(o.dropAt) ? /** @type {number} */ (o.dropAt) : duration * 0.45;
        const drop = downbeats.reduce((b, d) => (Math.abs(d - dropAt) < Math.abs(b - dropAt) ? d : b), downbeats[0] || 0);
        const step = 0.25, energy = [];
        for (let t = 0; t < duration; t += step) energy.push(t < drop ? Math.round((0.3 + 0.4 * (t / Math.max(drop, 0.01))) * 1000) / 1000 : t > duration - 1.5 ? 0.5 : 1);
        return { bpm, beats, downbeats, energy, energyStep: step, drops: [drop], firstOnset: 0, duration };
    }

    return { analyze, synthetic, onsets, tempo, fft };
});
