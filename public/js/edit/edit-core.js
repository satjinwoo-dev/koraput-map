// @ts-check
/* ============================================================================
   MapUnite Ride Edit — the editing agent's decisions (pure, no DOM)
   ==============================================================================
   The rider gives photos and videos from a ride; the agent watches them
   (edit-analyze.js measures each one: light, colour, sharpness, motion, at
   many points in a clip) and makes an edit in one of three looks, learnt from
   the reference reels:
     cinematic  teal-and-orange grade, cuts on every beat after a held opening,
                white and negative flash frames, a camera viewfinder on a hero
                shot, slow motion on the best moving shots;
     mono       black and white with grain, long held shots that shrink into
                a small window and vanish, bursts of tiny cuts with negative
                flashes, letterbox bars;
     kinetic    punchy colour, big words that land on the beat (red bold and
                white italic), glitch strips, split panels.
   The ride is part of the edit: an opening title, the real figures (distance,
   moving time, eco score: only what the ride summary has; nothing made up),
   the route drawing itself, and an end card.

   analysisScore(), pickMoments(), chooseStyle(), storyLines(), plan(),
   frameAt() are pure and tested (test/edit/).
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else /** @type {any} */ (root).MUEditCore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /** The three looks: tempo, how long shots hold (in beats), and how often each effect comes. */
    const STYLES = Object.freeze({
        cinematic: { label: "Cinematic", bpm: 124, intro: 4, body: [1, 1, 2, 1, 1, 0.5, 0.5, 1, 2, 1, 1, 3], flash: 0.35, invert: 0.12, glitch: 0, shrink: 0, split: 0, hud: 1, slowmo: 0.25, grade: "teal" },
        mono: { label: "Mono", bpm: 100, intro: 4, body: [4, 3, 0.25, 0.25, 0.25, 0.25, 5, 3, 0.5, 0.5, 4], flash: 0.08, invert: 0.3, glitch: 0, shrink: 0.45, split: 0, hud: 0, slowmo: 0.15, grade: "mono" },
        kinetic: { label: "Kinetic", bpm: 128, intro: 4, body: [1, 1, 2, 1, 0.5, 0.5, 1, 1, 2, 1], flash: 0.12, invert: 0.06, glitch: 0.3, shrink: 0, split: 0.12, hud: 0, slowmo: 0.1, grade: "punch" }
    });

    /** Seeded random (mulberry32): the same seed gives the same edit. @param {number} seed */
    function rng(seed) {
        let a = (seed >>> 0) || 1;
        return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    }

    /**
     * How good a moment looks: sharp, moving, colourful, well exposed (each 0–1, already normalised).
     * @param {{ sharp: number, motion: number, color: number, bright: number }} s
     */
    function analysisScore(s) {
        const exposure = 1 - Math.min(1, Math.abs((s.bright ?? 0.5) - 0.5) * 2);
        return 0.35 * (s.sharp ?? 0) + 0.25 * (s.motion ?? 0) + 0.2 * (s.color ?? 0) + 0.2 * exposure;
    }
    /** Rank-normalise one metric over all samples, so very dark or very sharp phones don't skew it. @param {number[]} v */
    function ranks(v) {
        const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
        const out = new Array(v.length).fill(0);
        idx.forEach(([, i], k) => { out[i] = v.length > 1 ? k / (v.length - 1) : 0.5; });
        return out;
    }

    /**
     * The best moments in the rider's media: windows in each video (not overlapping), and each photo.
     * @param {Array<{ kind: "video"|"photo", duration?: number, samples: Array<{ t: number, sharp: number, motion: number, color: number, bright: number }> }>} media
     * @param {{ windowS?: number }} [o]
     * @returns {Array<{ m: number, kind: "video"|"photo", inS: number, maxS: number, score: number, motion: number }>}
     */
    function pickMoments(media, o = {}) {
        const W = o.windowS || 2.4;
        const all = [];
        media.forEach((md, m) => (md.samples || []).forEach((s, k) => all.push({ m, k, s })));
        if (!all.length) return [];
        const nr = { sharp: ranks(all.map((x) => x.s.sharp)), motion: ranks(all.map((x) => x.s.motion)), color: ranks(all.map((x) => x.s.color)) };
        all.forEach((x, i) => { x.score = analysisScore({ sharp: nr.sharp[i], motion: nr.motion[i], color: nr.color[i], bright: x.s.bright }); x.motionN = nr.motion[i]; });
        const out = [];
        media.forEach((md, m) => {
            const mine = all.filter((x) => x.m === m);
            if (md.kind === "photo") { const x = mine[0]; if (x) out.push({ m, kind: "photo", inS: 0, maxS: 6, score: x.score, motion: 0 }); return; }
            const dur = Math.max(0.5, md.duration || 0);
            // a window's score: its samples' mean; take the best, block what it overlaps, repeat
            const wins = mine.map((x) => {
                const inS = Math.max(0, Math.min(dur - Math.min(W, dur), x.s.t - W / 2));
                const inside = mine.filter((y) => y.s.t >= inS && y.s.t <= inS + W);
                return { inS, score: inside.reduce((a, y) => a + y.score, 0) / Math.max(1, inside.length), motion: inside.reduce((a, y) => a + y.motionN, 0) / Math.max(1, inside.length) };
            }).sort((a, b) => b.score - a.score);
            const taken = [];
            const most = Math.max(1, Math.round(dur / (W * 1.5)));
            for (const w of wins) {
                if (taken.length >= most) break;
                if (taken.some((t) => Math.abs(t.inS - w.inS) < W)) continue;
                taken.push(w);
            }
            for (const w of taken) out.push({ m, kind: "video", inS: Math.round(w.inS * 100) / 100, maxS: Math.min(W * 1.6, dur - w.inS), score: w.score, motion: w.motion });
        });
        return out.sort((a, b) => b.score - a.score);
    }

    /**
     * The agent's look for these clips, and why.
     * @param {Array<{ kind: string, samples: Array<{ color: number, motion: number }> }>} media
     * @returns {{ style: "cinematic"|"mono"|"kinetic", why: string }}
     */
    function chooseStyle(media) {
        const s = media.flatMap((m) => m.samples || []);
        if (!s.length) return { style: "kinetic", why: "Kinetic: big words and your ride's figures carry it." };
        const color = s.reduce((a, x) => a + (x.color || 0), 0) / s.length, motion = s.reduce((a, x) => a + (x.motion || 0), 0) / s.length;
        const videos = media.filter((m) => m.kind === "video").length;
        if (color < 0.12) return { style: "mono", why: "Mono: your shots are soft in colour, so black and white with held frames suits them." };
        if (videos >= Math.max(2, media.length / 2) && motion > 0.05) return { style: "cinematic", why: "Cinematic: lots of movement in your clips, cut on every beat with flashes." };
        return { style: "kinetic", why: "Kinetic: colourful shots and a few clips: big words on the beat, glitches and split panels." };
    }

    const WORDS = [
        ["SOME", "roads", "you just", "RIDE"], ["CHASE", "the", "horizon"], ["NO", "map", "for", "this"], ["MILES", "of", "nothing", "but", "US"],
        ["WIND", "in", "the", "MOUNTAINS"], ["LEFT", "the city", "BEHIND"]
    ];
    const fmtKm = (/** @type {number} */ m) => (m >= 10000 ? `${Math.round(m / 1000)}` : `${(m / 1000).toFixed(1)}`);
    const fmtDur = (/** @type {number} */ s) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} H ${String(m % 60).padStart(2, "0")} MIN` : `${m} MIN`; };
    /**
     * The words in the edit: the ride's own title and figures (only when the summary has them), and the look's words.
     * @param {any} card the ride card (js/share/card-model.js buildCard) or null
     * @param {{ caption?: string, seed?: number }} [o]
     */
    function storyLines(card, o = {}) {
        const r = rng((o.seed || 1) * 7 + 3);
        const stats = [];
        if (card && card.distance >= 200) stats.push({ big: fmtKm(card.distance), small: "KM" });
        if (card && card.moving >= 120) stats.push({ big: fmtDur(card.moving).split(" ").slice(0, 2).join(" "), small: fmtDur(card.moving).split(" ").slice(2).join(" ") || "RIDING" });
        if (card && Number.isFinite(card.ecoScore) && card.ecoScore !== null) stats.push({ big: String(Math.round(card.ecoScore * 100)), small: "ECO SCORE" });          // the card keeps it 0–1
        const cap = String(o.caption || "").replace(/\s+/g, " ").trim().slice(0, 60);
        const words = cap ? cap.split(" ").slice(0, 6) : WORDS[Math.floor(r() * WORDS.length)];
        const date = card && Number.isFinite(card.startedAt) ? new Date(card.startedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }).toUpperCase() : "";
        return {
            title: card && card.title ? String(card.title).toUpperCase() : "THE RIDE",
            sub: [card && card.place ? String(card.place).toUpperCase() : "", date].filter(Boolean).join(" · "),
            stats, words, end: "MAPUNITE"
        };
    }

    /**
     * The edit: a timeline of shots on a beat grid. Pure.
     * @param {{ media: any[], card?: any, style?: "cinematic"|"mono"|"kinetic", targetS?: number, aspect?: "story"|"wide", seed?: number,
     *   caption?: string, route?: boolean }} o
     */
    function plan(o) {
        const S = STYLES[o.style || "kinetic"];
        const r = rng((o.seed || 1) * 2654435761);
        const beat = 60 / S.bpm, target = Math.max(8, Math.min(90, o.targetS || 20));
        const moments = /** @type {Array<ReturnType<typeof pickMoments>[number] & { used?: boolean }>} */ (pickMoments(o.media || []));
        const lines = storyLines(o.card || null, { caption: o.caption, seed: o.seed });
        const hasRoute = o.route !== false && o.card && o.card.route && Array.isArray(o.card.route.pts) && o.card.route.pts.length > 3;
        /** @type {any[]} */ const shots = [];
        let t = 0, mi = 0, lastM = -1, bodyK = 0;
        const nextMoment = (/** @type {boolean} */ wantMotion) => {
            if (!moments.length) return null;
            // the best not-yet-used moment, not the same file twice in a row; reuse in order once all are used
            let pool = moments.filter((x, i) => !x.used && x.m !== lastM);
            if (wantMotion) { const mv = pool.filter((x) => x.kind === "video"); if (mv.length) pool = mv; }
            if (!pool.length) { moments.forEach((x) => { x.used = false; }); pool = moments.filter((x) => x.m !== lastM); if (!pool.length) pool = moments; }
            const x = pool[0]; x.used = true; lastM = x.m; mi++;
            return x;
        };
        const add = (/** @type {any} */ s) => { s.at = Math.round(t * 1000) / 1000; s.durS = Math.round(s.durS * 1000) / 1000; shots.push(s); t += s.durS; };
        const fxFor = (/** @type {number} */ k) => ({
            flash: r() < S.flash ? "white" : r() < S.invert ? "invert" : null,
            glitch: r() < S.glitch, shrink: S.shrink > 0 && r() < S.shrink, zoom: [1.04 + r() * 0.04, 1.1 + r() * 0.08], pan: [(r() - 0.5) * 0.06, (r() - 0.5) * 0.06],
            speed: 1, hud: false, tilt: S.grade === "mono" && r() < 0.15 ? (r() - 0.5) * 6 : 0
        });
        // 1. opening: the strongest moment, held, with the ride's title
        const first = nextMoment(true);
        add({ kind: first ? "media" : "card", m: first ? first.m : -1, mk: first ? first.kind : null, inS: first ? first.inS : 0, durS: S.intro * beat,
            fx: { ...fxFor(0), flash: null, glitch: false, shrink: false, speed: first && first.kind === "video" && S.slowmo ? 0.7 : 1 }, text: { kind: "title", lines: [lines.title, lines.sub].filter(Boolean) } });
        // 2. the body on the beat, the figures woven in, the look's words on a held shot
        const endS = 3.6 + (hasRoute ? 3 * beat * 2 : 0);
        const statAt = new Set(lines.stats.map((_, i) => Math.round(((i + 1) / (lines.stats.length + 1)) * 10)));
        let wordsDone = false, statI = 0, step = 0;
        while (t < target - endS && step < 200) {
            step++;
            const k = S.body[bodyK % S.body.length]; bodyK++;
            const slot = Math.round(((t) / Math.max(1, target - endS)) * 10);
            const x = nextMoment(k <= 1);
            const fx = fxFor(bodyK);
            if (x && x.kind === "video" && k >= 2 && r() < S.slowmo / 0.4) fx.speed = 0.6;           // slow motion on held moving shots
            if (S.hud && k >= 2 && !shots.some((s) => s.fx && s.fx.hud)) fx.hud = true;
            const shot = { kind: x ? "media" : "card", m: x ? x.m : -1, mk: x ? x.kind : null, inS: x ? x.inS : 0, durS: Math.max(0.12, k * beat), fx, text: null };
            if (statI < lines.stats.length && statAt.has(slot) && k >= 1) { shot.durS = Math.max(shot.durS, 2 * beat); shot.text = { kind: "stat", ...lines.stats[statI++] }; shot.fx.glitch = false; shot.fx.shrink = false; }
            else if (!wordsDone && t > (target - endS) * 0.35 && (o.style === "kinetic" || !o.style || o.caption)) { wordsDone = true; shot.durS = Math.max(4, lines.words.length) * beat; shot.text = { kind: "words", words: lines.words }; shot.fx.glitch = false; shot.fx.shrink = false; }
            if (S.split && r() < S.split && moments.length > 2 && !shot.text) { shot.fx.split = 3; shot.extra = [nextMoment(false), nextMoment(false)].filter(Boolean).map((y) => ({ m: y.m, mk: y.kind, inS: y.inS })); }
            add(shot);
        }
        // the figures not yet shown come here, one beat pair each
        while (statI < lines.stats.length) { const x = nextMoment(false); add({ kind: x ? "media" : "card", m: x ? x.m : -1, mk: x ? x.kind : null, inS: x ? x.inS : 0, durS: 2 * beat, fx: { ...fxFor(0), glitch: false, shrink: false, flash: "white" }, text: { kind: "stat", ...lines.stats[statI++] } }); }
        // 3. the route drawing itself, then the end card
        if (hasRoute) add({ kind: "route", m: -1, mk: null, inS: 0, durS: 6 * beat, fx: { flash: "white", glitch: false, shrink: false, zoom: [1, 1], pan: [0, 0], speed: 1 }, text: { kind: "route", big: o.card && o.card.distance >= 200 ? `${fmtKm(o.card.distance)} KM` : "" } });
        const last = nextMoment(false);
        add({ kind: last ? "media" : "card", m: last ? last.m : -1, mk: last ? last.kind : null, inS: last ? last.inS : 0, durS: Math.max(2.4, 5 * beat), fx: { ...fxFor(0), flash: S.flash ? "white" : null, glitch: false, shrink: false, speed: 1 }, text: { kind: "end", lines: [lines.end, lines.title] } });
        return { style: o.style || "kinetic", look: S, bpm: S.bpm, beat, aspect: o.aspect || "story", size: o.aspect === "wide" ? [1920, 1080] : [1080, 1920], shots, duration: Math.round(t * 1000) / 1000, lines };
    }

    /**
     * What to draw at time t. Pure.
     * @param {ReturnType<typeof plan>} p @param {number} t seconds
     */
    function frameAt(p, t) {
        const sh = p.shots;
        let i = 0;
        while (i < sh.length - 1 && t >= sh[i + 1].at) i++;
        const s = sh[i];
        const local = Math.max(0, t - s.at), u = Math.min(1, local / Math.max(0.001, s.durS));
        const fx = s.fx || {};
        const z = fx.zoom || [1, 1], pan = fx.pan || [0, 0];
        const flashA = fx.flash && local < 0.12 ? 1 - local / 0.12 : 0;
        const shrink = fx.shrink && u > 0.55 ? Math.max(0.28, 1 - (u - 0.55) / 0.45 * 0.72) : 1;
        const words = s.text && s.text.kind === "words" ? Math.min(s.text.words.length, Math.floor(local / p.beat) + 1) : 0;
        return {
            i, shot: s, u, local,
            mediaT: s.inS + local * (fx.speed || 1),
            zoom: z[0] + (z[1] - z[0]) * u, panX: pan[0] * u, panY: pan[1] * u,
            flash: fx.flash === "white" ? flashA : 0, invert: fx.flash === "invert" && local < 0.1,
            glitch: Boolean(fx.glitch) && (local < 0.16 || (u > 0.5 && u < 0.56)),
            shrink, words,
            beatPulse: Math.max(0, 1 - ((t % p.beat) / p.beat) * 4)
        };
    }

    return { STYLES, rng, analysisScore, pickMoments, chooseStyle, storyLines, plan, frameAt };
});
