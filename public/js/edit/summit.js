// @ts-check
/* ============================================================================
   MapUnite Ride Edit — "Summit Cut": the editing agent's decisions (pure)
   ==============================================================================
   The house style and rules of the Summit Cut system prompt
   (lib/master/prompts/summit-cut.md), done on the phone:

     plan(input)          → an Edit Decision List in the prompt's JSON schema (§12)
     qc(edl, input)       → the self-check (§13): cuts on beat, effect counts, the
                            arc, adjacent scales, text safe zones, duration …
     repair(edl, input)   → an EDL from anywhere (the AI director online) made
                            safe to render: cuts snapped to beats, sources inside
                            their clips, effects over their limits dropped, no gaps
     feedback(input, ask) → §14: change only what was asked ("slower", "more
                            effects", "another look", "remove this shot" …)
     frameAt(edl, t)      → what the renderer draws at time t

   What the agent knows about each clip comes from edit-engine.js (sharpness,
   motion, light, colour, sky and earth tones, the person's size and position
   when the on-phone person model ran, and the clip's real frame rate), and
   the music's beats from beats.js. Nothing is guessed that isn't measured:
   with no person model, effects that need a cut-out are skipped (§14); slow
   motion only where the clip has the frames for it (no duplicated frames:
   the slowest rate is 30 ÷ the clip's fps).
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else /** @type {any} */ (root).MUSummit = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const FPS = 30;
    /** §7 max per edit. */
    const MAX = Object.freeze({ invert_flash: 3, white_flash: 2, speed_ramp: 3, whip_blur: 2, glitch_slices: 3, box_panels: 3, frame_resize: 4, subject_clone: 1,
        ghost_silhouette: 2, text_behind_subject: 2, hud_overlay: 1, rotated_frame: 1, fade_white: 1, lens_flare: 2, camera_shake: 3, monochrome_shot: 1 });
    const EFFECTS = ["invert_flash", "white_flash", "camera_shake", "hud_overlay", "lens_flare", "ghost_silhouette", "subject_clone", "text_behind_subject"];
    const TRANSITIONS = ["cut", "whip_blur", "glitch_slices", "box_panels", "frame_resize", "fade_white", "fade_black"];
    const TEXT_STYLES = ["sans_white", "serif_red", "keyword_red_fill", "keyword_outline"];

    /** §3 presets: the look, the pace (shot lengths in beats per section) and which effects it uses. */
    const PRESETS = Object.freeze({
        A_CINEMATIC_SUMMIT: {
            key: "A", label: "Cinematic Summit", bpm: 124, mono: false, text: false,
            grade: { lut: "teal_cream", contrast: 10, saturation: 15, vignette: -30, grain: 10, black_point: 6 },
            pace: { hook: [1, 0.5, 0.5, 1], build: [1, 1, 0.5, 1, 0.5], peak: [0.5, 0.5, 1, 0.5, 0.5], support: 4 },
            fx: { invert_flash: 1, white_flash: 1, whip_blur: 2, speed_ramp: 3, hud_overlay: 1, lens_flare: 2, camera_shake: 2, monochrome_shot: 1 },
            ending: "fade_black", why: "colour footage with sky and movement: a hype edit with one black-and-white beat, a viewfinder on a wide, and a whip into the hero"
        },
        B_MONOCHROME_RITUAL: {
            key: "B", label: "Monochrome Ritual", bpm: 100, mono: true, text: false,
            grade: { lut: "mono_film", contrast: 30, saturation: -100, vignette: -15, grain: 18, black_point: 0 },
            pace: { hook: [1, 1, 1, 1], build: [2, 1, 2, 1], peak: [1, 0.5, 0.5, 1, 0.5], support: 4 },
            fx: { invert_flash: 3, frame_resize: 4, rotated_frame: 1, fade_white: 1, subject_clone: 1, speed_ramp: 2, camera_shake: 1 },
            ending: "collapse", why: "soft or grey footage: black and white, a jump-cut ritual, flashes on the beat and a picture window that changes shape"
        },
        C_KINETIC_GLITCH_STORY: {
            key: "C", label: "Kinetic Glitch Story", bpm: 128, mono: false, text: true,
            grade: { lut: "teal_orange", contrast: 20, saturation: 25, vignette: -15, grain: 6, black_point: 3 },
            pace: { hook: [1, 1, 1], build: [1, 1, 1, 1, 1], peak: [0.5, 0.5, 1, 0.5, 0.5, 1], support: 4 },
            fx: { glitch_slices: 3, box_panels: 2, ghost_silhouette: 2, text_behind_subject: 1, invert_flash: 1, whip_blur: 1, white_flash: 1, lens_flare: 1, camera_shake: 1, speed_ramp: 2 },
            ending: "fade_black", why: "words to say or strong blue-against-orange colour: the line builds word by word on the beat, with glitch slices and box reveals"
        }
    });
    const PRESET_KEYS = /** @type {Array<keyof typeof PRESETS>} */ (Object.keys(PRESETS));

    const r3 = (x) => Math.round(x * 1000) / 1000;
    const fr = (x) => Math.round(x * FPS) / FPS;
    const frT = (x) => r3(fr(x));
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    const fin = (x) => typeof x === "number" && Number.isFinite(x);
    function rng(seed) { let a = (seed >>> 0) || 1; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
    const ranks = (v) => { const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const out = new Array(v.length).fill(0.5); idx.forEach(([, i], k) => { out[i] = v.length > 1 ? k / (v.length - 1) : 0.5; }); return out; };
    const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

    // ------------------------------------------------------------------ §2 analysis
    /** Shot scale from the person's share of the frame, or the sky when there's no person. */
    function scaleOf(s) {
        if (fin(s.subj) && s.subj > 0.004) return s.subj > 0.3 ? "close" : s.subj > 0.1 ? "medium" : s.subj > 0.03 ? "wide" : "extreme_wide";
        if (fin(s.sky) && s.sky > 0.55) return "extreme_wide";
        if (fin(s.sky) && s.sky > 0.3) return "wide";
        return "medium";
    }
    const WIDE = new Set(["wide", "extreme_wide"]);

    /**
     * The usable moments (§2): windows of 0.3–3 s in each clip, each photo whole, scored 0–10 on impact,
     * sharpness, stability and composition. Under 5 is discarded unless it's all there is.
     * @param {any[]} media
     */
    function moments(media) {
        const all = [];
        media.forEach((m) => (m.samples || []).forEach((s, k) => all.push({ m, k, s })));
        if (!all.length) return [];
        const R = { motion: ranks(all.map((x) => x.s.motion || 0)), sharp: ranks(all.map((x) => x.s.sharp || 0)), color: ranks(all.map((x) => x.s.color || 0)) };
        all.forEach((x, i) => {
            const exposure = 1 - Math.min(1, Math.abs((x.s.bright ?? 0.5) - 0.5) * 2.2);
            const prev = x.m.samples[x.k - 1], next = x.m.samples[x.k + 1];
            // shake: motion that jumps around between neighbouring samples, with a soft picture
            const jitter = prev && next ? Math.abs((x.s.motion || 0) - ((prev.motion || 0) + (next.motion || 0)) / 2) : 0;
            const stability = clamp(1 - jitter * 4 - (R.sharp[i] < 0.2 && (x.s.motion || 0) > 0.25 ? 0.4 : 0), 0, 1);
            const thirds = fin(x.s.cx) ? 1 - Math.min(Math.abs(x.s.cx - 1 / 3), Math.abs(x.s.cx - 2 / 3), Math.abs(x.s.cx - 0.5)) * 3 : 0.6;
            const comp = clamp(0.6 * exposure + 0.25 * thirds + 0.15 * R.color[i], 0, 1);
            x.impact = x.m.kind === "photo" ? 4 + 4 * R.color[i] : 10 * R.motion[i];
            x.sharp = 10 * R.sharp[i]; x.stability = 10 * stability; x.composition = 10 * comp;
            x.score = 0.3 * x.impact + 0.3 * x.sharp + 0.15 * x.stability + 0.25 * x.composition;
            if (exposure < 0.15) x.score -= 2;                                         // blown out or black
        });
        const out = [];
        for (const m of media) {
            const mine = all.filter((x) => x.m === m);
            if (!mine.length) continue;
            if (m.kind === "photo") {
                const x = mine[0];
                out.push({ key: `${m.id}@0`, asset: m.id, kind: "photo", t0: 0, t1: Infinity, center: 0, score: r3(x.score), impact: x.impact, sky: x.s.sky || 0, earth: x.s.earth || 0,
                    bright: x.s.bright ?? 0.5, scale: scaleOf(x.s), subject: fin(x.s.subj) && x.s.subj > 0.004, cx: fin(x.s.cx) ? x.s.cx : 0.5, cy: fin(x.s.cy) ? x.s.cy : 0.45, fps: FPS, mask: Boolean(m.mask) });
                continue;
            }
            const dur = Math.max(0.3, m.duration || 0);
            const taken = [];
            for (const x of [...mine].sort((a, b) => b.score - a.score)) {
                if (taken.some((t) => Math.abs(t.s.t - x.s.t) < 1.2)) continue;
                taken.push(x);
                if (taken.length >= Math.max(1, Math.round(dur / 2))) break;
            }
            for (const x of taken) {
                const t0 = clamp(x.s.t - 1.2, 0, Math.max(0, dur - 0.3)), t1 = clamp(x.s.t + 1.8, t0 + 0.3, dur - 0.04);
                out.push({ key: `${m.id}@${r3(x.s.t)}`, asset: m.id, kind: "video", t0: r3(t0), t1: r3(Math.max(t0 + 0.3, t1)), center: x.s.t, score: r3(x.score), impact: x.impact, sky: x.s.sky || 0,
                    earth: x.s.earth || 0, bright: x.s.bright ?? 0.5, scale: scaleOf(x.s), subject: fin(x.s.subj) && x.s.subj > 0.004, cx: fin(x.s.cx) ? x.s.cx : 0.5, cy: fin(x.s.cy) ? x.s.cy : 0.45,
                    fps: fin(m.fps) && m.fps > 0 ? m.fps : FPS, mask: false });
            }
        }
        const good = out.filter((w) => w.score >= 5);
        return (good.length >= 3 ? good : out).sort((a, b) => b.score - a.score);
    }

    /** §14 "Unsure of preset" from the footage: B for grey/overcast, C for words or blue-against-orange, else A. */
    function choosePreset(media, brief = {}) {
        if (brief.preset && PRESETS[brief.preset]) return { preset: brief.preset, why: `${PRESETS[brief.preset].label}: your choice.` };
        const s = media.flatMap((m) => m.samples || []);
        const color = mean(s.map((x) => x.color || 0)), sky = mean(s.map((x) => x.sky || 0)), earth = mean(s.map((x) => x.earth || 0));
        if (s.length && color < 0.12) return { preset: "B_MONOCHROME_RITUAL", why: `Monochrome Ritual: ${PRESETS.B_MONOCHROME_RITUAL.why}.` };
        if (brief.caption || (sky > 0.18 && earth > 0.12)) return { preset: "C_KINETIC_GLITCH_STORY", why: `Kinetic Glitch Story: ${PRESETS.C_KINETIC_GLITCH_STORY.why}.` };
        return { preset: "A_CINEMATIC_SUMMIT", why: `Cinematic Summit: ${PRESETS.A_CINEMATIC_SUMMIT.why}.` };
    }

    // ------------------------------------------------------------------ §4 music
    /** The beat grid on the edit's own clock (0 = the music's first transient) and where the edit ends (a bar end). */
    function grid(music, target) {
        const start = music.beats.find((b) => b >= (music.firstOnset || 0) - 0.02) ?? 0;
        const beats = music.beats.filter((b) => b >= start).map((b) => r3(b - start));
        const downs = (music.downbeats || []).filter((b) => b >= start).map((b) => r3(b - start));
        const room = (music.duration || Infinity) - start;
        // a phrase ending: the downbeat nearest the target, two bars at a time where possible, inside the song
        const bars = downs.filter((d) => d >= 8 && d <= room + 0.01);
        let end = bars.reduce((b, d) => (Math.abs(d - target) < Math.abs(b - target) ? d : b), bars[0] ?? Math.min(target, room));
        if (!bars.length) end = beats.filter((b) => b <= Math.min(target, room)).pop() ?? target;
        const B = beats.filter((b) => b <= end + 1e-6);
        // cuts may also land on the half-beat (§4)
        const cuts = [];
        B.forEach((b, i) => { cuts.push(b); if (i + 1 < B.length) cuts.push(r3((b + B[i + 1]) / 2)); });
        return { start: r3(start), beats: B, cuts, downs: downs.filter((d) => d <= end + 1e-6), end: frT(end), beat: music.bpm > 0 ? 60 / music.bpm : 0.5, drops: (music.drops || []).map((d) => r3(d - start)).filter((d) => d > 0 && d < end) };
    }
    /** The beat nearest t. */
    const nearest = (beats, t) => beats.reduce((b, x) => (Math.abs(x - t) < Math.abs(b - t) ? x : b), beats[0] ?? t);

    // ------------------------------------------------------------------ the plan
    /**
     * @param {{ media: any[], music: any, brief?: any, ride?: any }} input
     *   media[]: { id, kind, duration, fps, w, h, mask, samples: [{ t, bright, color, sharp, motion, sky?, earth?, subj?, cx?, cy? }] }
     *   music: beats.js analyze() / synthetic() + { track_id }
     *   brief: { preset?, durationS?, aspect?: "9:16"|"16:9", caption?, seed?, pace? (1 = normal, 1.4 slower, 0.7 faster), fx? (1, 0.5 fewer, 1.5 more), pins?, exclude? }
     *   ride: { title, km, topKmh, place, signoff? } (only real figures)
     */
    function plan(input) {
        const brief = input.brief || {};
        const media = (input.media || []).filter((m) => m && m.id);
        const seed = brief.seed || 1, rnd = rng(seed * 2654435761);
        const choice = choosePreset(media, brief);
        const P = PRESETS[choice.preset];
        const exclude = new Set(brief.exclude || []);
        let pool = moments(media).filter((w) => !exclude.has(w.key));
        // §14: too little footage → a shorter edit, not padding
        const usable = pool.reduce((s, w) => s + (w.kind === "photo" ? 1.5 : Math.min(3, w.t1 - w.t0)), 0);
        let target = clamp(brief.durationS || 15, 8, 60);
        const short = usable < 5;
        if (short) target = Math.min(target, 9);
        const G = grid(input.music, target);
        const T = G.end;
        const aspect = brief.aspect === "16:9" ? "16:9" : "9:16";
        const pace = clamp(brief.pace || 1, 0.5, 2), fxK = clamp(brief.fx ?? 1, 0, 2);
        const budget = {};
        for (const k of Object.keys(MAX)) budget[k] = Math.min(MAX[k], Math.round((P.fx[k] || 0) * fxK));
        const used = Object.fromEntries(Object.keys(MAX).map((k) => [k, 0]));
        const take = (k) => (used[k] < budget[k] ? (used[k]++, true) : false);

        // §2 hook and hero
        // the hook starts mid-action: a moving clip with the rider close beats a still photo
        const subjectFirst = (w) => (w.subject ? 2 : 0) + (w.scale === "close" ? 2 : w.scale === "medium" ? 1 : 0) + (w.kind === "video" ? 2.5 : 0);
        const hook = [...pool].sort((a, b) => (subjectFirst(b) + b.impact / 3 + b.score / 3) - (subjectFirst(a) + a.impact / 3 + a.score / 3))[0] || null;
        const heroPool = pool.filter((w) => w !== hook && (w.kind === "photo" || w.t1 - w.t0 >= 1.5));
        const heroRank = (w) => (WIDE.has(w.scale) ? 3 : 0) + w.sky * 3 + w.score / 2 + (w.kind === "video" && mediaDur(media, w.asset) - w.t0 >= 2.5 ? 1 : 0);
        const hero = [...heroPool].sort((a, b) => heroRank(b) - heroRank(a))[0] || hook;

        // §5 sections on beats; the resolve holds the hero ≥ 2 s (≤ 4 s, a supporting wide before it if longer)
        const at = (share) => nearest(G.beats, T * share);
        const hookEnd = Math.max(at(0.12), G.beats[1] ?? 0.5);
        const buildEnd = Math.max(at(0.45), hookEnd + G.beat);
        let resolveAt = at(0.8);
        if (T - resolveAt < 2) resolveAt = G.beats.filter((b) => b <= T - 2).pop() ?? Math.max(0, T - 2);
        const peakStart = G.drops.find((d) => d > hookEnd && d < resolveAt) ?? buildEnd;
        const sections = [["hook", 0, hookEnd], ["build", hookEnd, Math.min(peakStart, resolveAt)], ["peak", Math.min(peakStart, resolveAt), resolveAt], ["resolve", resolveAt, T]];

        // the cuts: each section's pattern of beats, scaled by pace, landing on the grid (beats and half-beats).
        // "Each shot shows something new": with few moments the pace eases off rather than repeating footage.
        const distinct = pool.length;
        // the footage sets the base pace; the rider's "slower" / "faster" scales it from there
        let base = 1;
        while (cutSlots(base).length > Math.max(6, Math.ceil(distinct * 1.3)) && base < 3) base *= 1.2;
        const slots = cutSlots(base * pace);
        function cutSlots(pc) {
        /** @type {Array<{ section: string, t0: number, t1: number }>} */ const slots = [];
        for (const [name, a, b] of sections) {
            if (b - a < 1e-6) continue;
            if (name === "resolve") {
                const heroLen = Math.min(4, b - a);
                if (b - a - heroLen >= 1.2) slots.push({ section: name, t0: a, t1: nearest(G.beats, b - heroLen) });
                slots.push({ section: name, t0: slots.length && slots[slots.length - 1].section === "resolve" ? slots[slots.length - 1].t1 : a, t1: b });
                continue;
            }
            const pat = P.pace[name];
            let t = a, k = 0, aim = a;
            while (t < b - 1e-6) {
                const want = pat[k % pat.length] * G.beat * pc;
                k++;
                aim += want;                                       // a running aim, so 1.35 beats a cut averages out to 1.35, not 1
                // a half-beat cut only where the pattern asks for it; otherwise whole beats
                const grid2 = want < G.beat * 0.75 ? G.cuts : G.beats;
                let next = nearest(grid2.filter((x) => x > t + 4 / FPS - 1e-6), aim);
                if (!(next > t)) next = b;
                if (next > b || b - next < 4 / FPS) next = b;
                slots.push({ section: name, t0: t, t1: next });
                t = next;
            }
        }
        return slots;
        }

        // §5/§6 who goes where: the hook first, the hero last, scales alternating, ≤ 2 photos in a row, nothing twice
        const usedKeys = new Set();
        const pins = brief.pins || {};
        /** @type {any[]} */ const picks = [];
        const lenOf = (s) => s.t1 - s.t0;
        // a clip fits a slot when there's footage for the whole shot from where its moment starts
        const fits = (w, s) => w.kind === "photo" || mediaDur(media, w.asset) - w.t0 >= lenOf(s) + 0.02;
        const byKey = new Map(pool.map((w) => [w.key, w]));
        // Preset B: the hook is one continuous action told in jump cuts (same framing, 0.3–0.8 s skipped each time)
        const hookSlots = slots.filter((x) => x.section === "hook");
        const ritual = P.key === "B" && hook && hook.kind === "video" && hookSlots.length >= 2 &&
            mediaDur(media, hook.asset) >= hookSlots.reduce((a, x) => a + lenOf(x) + 0.55, 0) ? hook : null;
        let jumpAt = ritual ? Math.max(0, Math.min(ritual.t0, mediaDur(media, ritual.asset) - hookSlots.reduce((a, x) => a + lenOf(x) + 0.55, 0))) : 0;
        slots.forEach((s, i) => {
            const last = i === slots.length - 1;
            if (ritual && s.section === "hook") {
                usedKeys.add(ritual.key);
                picks.push({ s, w: ritual, reframe: false, jump: r3(jumpAt) });
                jumpAt += lenOf(s) + 0.3 + rnd() * 0.5;
                return;
            }
            const pin = pins[i] && byKey.get(pins[i]);
            let w = pin && fits(pin, s) ? pin : null;
            if (!w && i === 0 && hook && fits(hook, s)) w = hook;
            if (!w && last && hero && !usedKeys.has(hero.key) && fits(hero, s)) w = hero;
            if (!w) {
                const prev = picks[i - 1], prev2 = picks[i - 2];
                const cand = pool.filter((x) => !usedKeys.has(x.key) && x !== hero && fits(x, s));
                const rank = (x) => {
                    let r = x.score;
                    if (prev && prev.w.scale === x.scale) r -= 4;                         // §5 alternate shot scale
                    if (prev && prev.w.asset === x.asset) r -= 3;
                    if (x.kind === "photo" && prev && prev.w.kind === "photo" && prev2 && prev2.w.kind === "photo") r -= 20;   // §8
                    if (s.section === "peak") r += x.impact / 2 + (x.kind === "video" ? 2 : 0);
                    if (s.section === "build" && !WIDE.has(x.scale)) r += 1.5;              // details and mediums establish the world
                    if (s.section === "resolve") r += (WIDE.has(x.scale) ? 3 : 0) + x.sky * 3;
                    return r + rnd() * 0.5;
                };
                w = cand.sort((a, b) => rank(b) - rank(a))[0] || null;
                // nothing new left: the same footage re-framed (§14), never the same moment the same way
                if (!w) {
                    const again = pool.filter((x) => fits(x, s) && (!prev || x.key !== prev.w.key));
                    w = again.sort((a, b) => b.score - a.score)[Math.floor(rnd() * Math.min(3, again.length))] || pool[0] || null;
                    if (w) picks.push({ s, w, reframe: true });
                    return;
                }
            }
            if (w) usedKeys.add(w.key);
            picks.push({ s, w, reframe: Boolean(w && usedKeys.has(w.key) && picks.some((p) => p.w && p.w.key === w.key)) });
        });

        // §7 the timeline items
        const tl = [];
        let resize = { w: 1, h: 1 };
        const RESIZES = aspect === "9:16" ? [{ w: 1, h: 0.7 }, { w: 1, h: 0.3 }, { w: 0.82, h: 0.62 }, { w: 1, h: 1 }] : [{ w: 0.7, h: 1 }, { w: 1, h: 0.42 }, { w: 0.62, h: 0.82 }, { w: 1, h: 1 }];
        let resizeK = 0, monoDone = false, rotDone = false;
        picks.forEach((p, i) => {
            const { s, w } = p;
            const d = s.t1 - s.t0;
            const isHero = i === picks.length - 1;
            const onBeat = G.beats.findIndex((b) => Math.abs(b - s.t0) < 0.02);
            const isDown = G.downs.some((x) => Math.abs(x - s.t0) < 0.02);
            const item = {
                index: i, section: s.section, asset_id: w ? w.asset : "", source_in_s: 0, source_out_s: 0,
                timeline_in_s: frT(s.t0), timeline_out_s: frT(s.t1), on_beat_index: onBeat,
                speed: [{ t: 0, rate: 1, ease: "linear" }], interpolation: "none",
                transform: { crop_center: [w ? r3(clamp(w.cx, 0.2, 0.8)) : 0.5, w ? r3(clamp(w.cy, 0.25, 0.7)) : 0.5], scale_start: 1, scale_end: 1.03, position_drift: [0, 0], rotation_deg: 0,
                    frame_window: { start: [resize.w, resize.h], end: [resize.w, resize.h], ease: "easeOut" } },
                parallax_2_5d: false, grade_override: { monochrome: P.mono, exposure: 0, notes: "" },
                effects: /** @type {any[]} */ ([]), transition_out: { type: "cut", duration_frames: 0, direction: "none", params: {} },
                text: /** @type {any[]} */ ([]), audio: { keep_clip_audio: false, gain_db: -12 }
            };
            if (!w) { tl.push(item); return; }
            // push-in on photos, wides and the hero; drift toward where the subject looks (its side of the frame)
            const strong = w.kind === "photo" || WIDE.has(w.scale) || isHero;
            item.transform.scale_start = r3(p.reframe ? 1.12 : 1);
            item.transform.scale_end = r3(p.reframe ? 1.04 : strong ? 1.06 + rnd() * 0.06 : 1.02 + rnd() * 0.02);
            item.transform.position_drift = [r3((w.cx < 0.5 ? -1 : 1) * (0.01 + rnd() * 0.02)), r3((rnd() - 0.5) * 0.01)];
            if (w.kind === "photo" && w.mask) item.parallax_2_5d = true;
            // the source: around the window's peak, cut on action (the movement already started)
            if (w.kind === "video") {
                let rateMin = 1;
                const ramp = s.section !== "resolve" && w.impact >= 7 && w.fps >= 50 && d >= 0.8 && take("speed_ramp");
                if (ramp) {
                    rateMin = r3(Math.max(0.25, FPS / w.fps));
                    item.speed = [{ t: 0, rate: 1, ease: "cubic" }, { t: r3(d * 0.25), rate: rateMin, ease: "cubic" }, { t: r3(d * 0.7), rate: rateMin, ease: "cubic" }, { t: r3(d), rate: 1.4, ease: "cubic" }];
                }
                const need = sourceSpan(item.speed, d);
                const room = mediaDur(media, w.asset) - need - 0.02;
                const start = fin(p.jump) ? clamp(p.jump, 0, Math.max(0, room)) : clamp(w.center - need * 0.4, Math.min(w.t0, Math.max(0, room)), Math.max(0, room));
                item.source_in_s = r3(start);
                item.source_out_s = r3(Math.min(start + need, mediaDur(media, w.asset) - 0.02));
            } else { item.source_in_s = 0; item.source_out_s = r3(d); }
            // §9: Preset A's one black-and-white shot (in the build)
            if (P.key === "A" && s.section === "build" && !monoDone && i > 1 && take("monochrome_shot")) { item.grade_override = { monochrome: true, exposure: 0, notes: "the one black-and-white beat" }; monoDone = true; }
            // §7 effects at the cut (on the beat), one per shot
            const fx = (type, frames, params = {}) => item.effects.push({ type, start_s: item.timeline_in_s, duration_frames: frames, params });
            if (P.key === "B" && s.section === "build" && !rotDone && !isHero && d >= G.beat * 0.9 && take("rotated_frame")) { item.transform.rotation_deg = 90; rotDone = true; }
            if (s.section === "peak" && Math.abs(s.t0 - sections[2][1]) < 0.02 && take("white_flash")) fx("white_flash", 6, { stops: 2.5 });
            else if ((s.section === "peak" || s.section === "hook" || (P.key === "B" && s.section === "build")) && isDown && i > 0 && take("invert_flash")) fx("invert_flash", P.mono ? 1 : 2, { desaturate: P.mono ? 0 : 0.5 });
            else if (P.key === "A" && WIDE.has(w.scale) && (s.section === "build" || s.section === "peak") && d >= 0.9 && take("hud_overlay")) fx("hud_overlay", Math.round(d * FPS), { lines: hudLines(input.ride) });
            else if ((P.key === "A" || P.key === "C") && w.sky >= 0.35 && w.bright >= 0.5 && d >= 0.6 && take("lens_flare")) fx("lens_flare", Math.round(d * FPS), { opacity: 0.3 });
            else if (s.section === "peak" && w.impact >= 8 && isDown && take("camera_shake")) fx("camera_shake", 3, { px: 4 });
            else if (P.key === "C" && w.subject && i > 0 && (media.find((m) => m.id === w.asset) || {}).mask && take("ghost_silhouette")) fx("ghost_silhouette", 5, { opacity: 0.8, blur_px: 14 });
            tl.push(item);
        });

        // §7 transitions (outgoing), each landing its next cut on the beat
        for (let i = 0; i < tl.length - 1; i++) {
            const a = tl[i], b = tl[i + 1], wa = picks[i].w, wb = picks[i + 1].w;
            const nextIsHero = i + 1 === tl.length - 1;
            const set = (type, frames, direction = "none", params = {}) => { a.transition_out = { type, duration_frames: frames, direction, params }; };
            const len = (a.timeline_out_s - a.timeline_in_s) * FPS;
            if (P.key === "A" && nextIsHero && len >= 10 && take("whip_blur")) set("whip_blur", 8, wa && wa.cx < 0.5 ? "left" : "right", { blur_px: 90 });
            else if (P.key === "B" && b.section !== a.section && a.section === "hook" && take("fade_white")) set("fade_white", 12);
            else if (P.key === "B" && (b.section !== a.section || (b.section === "peak" && i % 3 === 0)) && resizeK < RESIZES.length - 1 && used.frame_resize < budget.frame_resize - 1 && take("frame_resize")) {
                const to = RESIZES[resizeK++ % RESIZES.length];
                set("frame_resize", 10, "none", { to: [to.w, to.h] });
                for (let k = i + 1; k < tl.length; k++) tl[k].transform.frame_window = { start: [resize.w, resize.h], end: [to.w, to.h], ease: "easeOut" };
                for (let k = i + 2; k < tl.length; k++) tl[k].transform.frame_window = { start: [to.w, to.h], end: [to.w, to.h], ease: "easeOut" };
                resize = to;
            }
            else if (P.key === "C" && b.section === "peak" && len >= 5 && (a.section !== "peak" || i % 2 === 1) && wa && wa.scale === "close" && take("box_panels")) set("box_panels", 9, "none", { panels: 2 });
            else if (P.key === "C" && b.section === "peak" && len >= 5 && take("glitch_slices")) set("glitch_slices", 6, "right", { strips: 5, rgb_px: 3 });
            else if (P.key !== "B" && a.section === "peak" && wa && wb && wa.impact >= 7 && wb.impact >= 7 && len >= 10 && take("whip_blur")) set("whip_blur", 8, wa.cx < 0.5 ? "left" : "right", { blur_px: 80 });
        }
        // the ending: A/C fade to black over 1–1.5 s; B collapses the window and holds black ≥ 0.5 s
        const last = tl[tl.length - 1];
        if (last) {
            last.transform.scale_start = 1; last.transform.scale_end = r3(Math.max(last.transform.scale_end, 1.08));
            if (P.ending === "collapse") {
                used.frame_resize = Math.min(MAX.frame_resize, used.frame_resize + 1);                     // the loop above kept one move for this
                last.transition_out = { type: "frame_resize", duration_frames: 12, direction: "none", params: { to: [0, 0], hold_black_s: 0.6 } };
            } else last.transition_out = { type: "fade_black", duration_frames: Math.round(clamp((last.timeline_out_s - last.timeline_in_s) * 0.4, 1, 1.5) * FPS), direction: "none", params: {} };
        }
        // Preset B's subject clones over a wide shot in the peak (needs the person model)
        if (P.key === "B" && budget.subject_clone > 0) {
            const cut = media.filter((m) => m.mask);
            const host = tl.find((it, i) => it.section === "peak" && picks[i].w && WIDE.has(picks[i].w.scale) && it.timeline_out_s - it.timeline_in_s >= G.beat * 0.9);
            if (cut.length && host && take("subject_clone")) {
                const n = Math.min(3, Math.max(1, Math.floor((host.timeline_out_s - host.timeline_in_s) / (G.beat * 0.5))));
                host.effects = [{ type: "subject_clone", start_s: host.timeline_in_s, duration_frames: Math.round((host.timeline_out_s - host.timeline_in_s) * FPS),
                    params: { copies: Array.from({ length: n }, (_, k) => ({ asset_id: cut[k % cut.length].id, at: [r3(0.25 + 0.25 * k), r3(0.62 - 0.04 * k)], scale: r3(0.55 - 0.1 * k), invert: k % 2 === 1, appear_s: frT(host.timeline_in_s + k * G.beat * 0.5) })) } }];
            }
        }

        // §10 typography: the line word by word on the beat (C, or a caption), then a keyword at the peak
        const words = textLine(brief, input.ride, P);
        if (words.length) placeText(tl, picks, G, T, words, P, budget, used, media);
        // a short sign-off the rider asked for (the ride in the edit): the final 1.5 s
        if (last && input.ride && input.ride.signoff) last.text.push({ content: input.ride.signoff, start_s: frT(G.cuts.find((c) => c >= Math.max(last.timeline_in_s, T - 1.5) - 1e-6) ?? last.timeline_in_s), end_s: frT(T - 0.2), style: "sans_white", position: [0.5, 0.74], size_pct: 3.4, behind_subject: false, animation: "cut_in" });

        const edl = {
            project: {
                preset: choice.preset, aspect_ratio: aspect, resolution: aspect === "9:16" ? [1080, 1920] : [1920, 1080], fps: FPS, duration_s: T,
                music: { track_id: String(input.music.track_id || `agent:${P.key}`), start_s: G.start, end_s: r3(G.start + T), fade_in_s: 0.15, fade_out_s: r3(clamp(T * 0.08, 0.8, 1.5)), bpm: input.music.bpm },
                global_grade: { ...P.grade },
                reasoning: reasoning(choice, picks, tl, short, T, target)
            },
            timeline: tl,
            qc_report: { cuts_on_beat_pct: 100, black_frame_check: "pass", max_upscale_pct: 0, effect_counts: {}, issues_and_fixes: /** @type {string[]} */ ([]) }
        };
        if (short) edl.qc_report.issues_and_fixes.push(`Only ${Math.round(usable)} s of usable footage: the edit is ${T.toFixed(1)} s instead of padding it.`);
        if (!media.some((m) => m.mask)) edl.qc_report.issues_and_fixes.push("No person cut-outs (the person model didn't run or found nobody): clone, ghost and text-behind effects skipped.");
        const r = qc(edl, input);
        edl.qc_report = { ...r, issues_and_fixes: [...edl.qc_report.issues_and_fixes, ...r.issues_and_fixes] };
        return edl;
    }

    const mediaDur = (media, id) => { const m = media.find((x) => x.id === id); return m && m.kind === "video" ? m.duration : Infinity; };
    /** Source seconds a speed curve consumes over d seconds of timeline. */
    function sourceSpan(speed, d) {
        const ks = (speed && speed.length ? speed : [{ t: 0, rate: 1 }]).slice().sort((a, b) => a.t - b.t);
        let s = 0;
        const step = 1 / 120;
        for (let t = 0; t < d; t += step) s += rateAt(ks, t) * Math.min(step, d - t);
        return s;
    }
    /** The rate at local time t (cubic ease between keyframes). */
    function rateAt(ks, t) {
        if (!ks.length) return 1;
        if (t <= ks[0].t) return ks[0].rate;
        for (let i = 1; i < ks.length; i++) {
            if (t <= ks[i].t) {
                const a = ks[i - 1], b = ks[i], u = (t - a.t) / Math.max(1e-6, b.t - a.t);
                const e = b.ease === "linear" ? u : u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
                return a.rate + (b.rate - a.rate) * e;
            }
        }
        return ks[ks.length - 1].rate;
    }
    /** Source time at local t. */
    function sourceAt(item, local) { return item.source_in_s + sourceSpan(item.speed, local); }

    function hudLines(ride) {
        const l = ["REC ●"];
        if (ride && fin(ride.km)) l.push(`${ride.km >= 10 ? Math.round(ride.km) : ride.km.toFixed(1)} KM`);
        if (ride && fin(ride.topKmh) && ride.topKmh > 0) l.push(`TOP ${Math.round(ride.topKmh)} KM/H`);
        l.push("30 FPS");
        return l;
    }

    const STOP = new Set("a an the of to in on at for and or but is are was were be you your i we my our it this that with do if what so just".split(" "));
    const DEFAULT_LINES = ["Some roads you don't ride, they ride you", "Leave the map, find the road", "Every mile is a story worth the dust", "Chase the horizon until it chases you"];
    /** The words: the rider's caption, else (Preset C) a line from the ride's real figures or a stock line. */
    function textLine(brief, ride, P) {
        if (brief.noText) return [];
        let line = String(brief.caption || "").replace(/\s+/g, " ").trim();
        if (!line && !P.text) return [];
        if (!line && ride && fin(ride.km) && ride.km >= 1) line = `${ride.km >= 10 ? Math.round(ride.km) : ride.km.toFixed(1)} km ${ride.place ? `through ${ride.place}` : "of open road"}, one ride`;
        if (!line) line = DEFAULT_LINES[Math.abs(brief.seed || 1) % DEFAULT_LINES.length];
        return line.split(" ").filter(Boolean).slice(0, 14);
    }

    /** §10: word-by-word on beats over the build, 2–5 lines, red serif emphasis; then one keyword at the peak. */
    function placeText(tl, picks, G, T, words, P, budget, used, media) {
        const build = tl.filter((it) => it.section === "build" || it.section === "hook");
        if (!build.length) return;
        const t0 = Math.max(build[0].timeline_in_s, tl[0].timeline_out_s);                  // after the hook's first shot
        const beats = G.beats.filter((b) => b >= t0 - 1e-6 && b < T - 1.5);
        if (beats.length < 2) return;
        const step = words.length > beats.length ? 1 : beats.length >= words.length * 2 && words.length <= 6 ? 2 : 1;
        const times = beats.filter((_, i) => i % step === 0).slice(0, words.length);
        // the sequence clears all at once on the first cut after the last word (and before the resolve)
        const lastWord = times[times.length - 1];
        const clearAt = (tl.find((it) => it.timeline_in_s > lastWord + 1e-6) || {}).timeline_in_s || Math.min(T - 1.5, lastWord + G.beat * 2);
        // keep away from the face: the text sits opposite the subject's vertical half (safe zone 12–80 %)
        const firstShot = picks[tl.indexOf(build[0])];
        const cy = firstShot && firstShot.w ? firstShot.w.cy : 0.45;
        const yBase = cy < 0.5 ? 0.6 : 0.2, perLine = words.length <= 4 ? 2 : 3;
        const content = words.slice(0, times.length);
        const emphasis = new Set(content.map((w, i) => [w, i]).filter(([w]) => !STOP.has(w.toLowerCase()) && w.length > 3).sort((a, b) => b[0].length - a[0].length).slice(0, Math.min(2, Math.ceil(content.length / perLine))).map(([, i]) => i));
        const host = tl.find((it) => it.timeline_in_s <= t0 + 1e-6 && it.timeline_out_s > t0) || build[0];
        content.forEach((w, i) => {
            const line = Math.floor(i / perLine), col = i % perLine, n = Math.min(perLine, content.length - line * perLine);
            host.text.push({ content: w, start_s: frT(times[i]), end_s: frT(clearAt), style: emphasis.has(i) ? "serif_red" : "sans_white",
                position: [r3(0.5 + (col - (n - 1) / 2) * 0.24), r3(Math.min(0.78, yBase + line * 0.065))], size_pct: 5.5, behind_subject: false, animation: i % 2 ? "scale_in_3f" : "cut_in" });
        });
        // the keyword: the longest word that isn't filler, big, at the peak's first downbeat
        const kw = [...words].filter((w) => !STOP.has(w.toLowerCase())).sort((a, b) => b.length - a.length)[0];
        const peak = tl.filter((it) => it.section === "peak");
        const kHost = peak.find((it, k) => k > 0 && G.downs.some((d) => Math.abs(d - it.timeline_in_s) < 0.02)) || peak[1] || peak[0];
        if (kw && kHost && kHost.timeline_out_s <= T - 1.5) {
            const w = picks[tl.indexOf(kHost)] && picks[tl.indexOf(kHost)].w;
            const m = w && media.find((x) => x.id === w.asset);
            const behind = Boolean(w && w.kind === "photo" && m && m.mask && used.text_behind_subject < budget.text_behind_subject);
            if (behind) used.text_behind_subject++;
            kHost.text.push({ content: kw.replace(/[^\p{L}\p{N}'-]/gu, "").toUpperCase(), start_s: kHost.timeline_in_s, end_s: kHost.timeline_out_s, style: kHost.index % 2 ? "keyword_outline" : "keyword_red_fill",
                position: [w ? r3(clamp(w.cx, 0.3, 0.7)) : 0.5, w ? r3(clamp(w.cy + 0.1, 0.3, 0.72)) : 0.5], size_pct: 12, behind_subject: behind, animation: "scale_in_3f" });
            if (behind) kHost.effects.push({ type: "text_behind_subject", start_s: kHost.timeline_in_s, duration_frames: Math.round((kHost.timeline_out_s - kHost.timeline_in_s) * FPS), params: {} });
        }
    }

    function reasoning(choice, picks, tl, short, T, target) {
        const hero = picks[picks.length - 1] && picks[picks.length - 1].w;
        const hook = picks[0] && picks[0].w;
        const bits = [choice.why.replace(/: your choice\.$/, " (your choice)."),
            `Hook on ${hook ? (hook.scale === "close" ? "a close" : hook.subject ? "the rider" : "the strongest moving") + " shot" : "a title"}, build on ${tl.filter((x) => x.section === "build").length} beat cuts, peak at the music's ${tl.some((x) => x.section === "peak") ? "drop" : "middle"}, resolve on the hero.`,
            hero ? `Hero: ${WIDE.has(hero.scale) ? "the widest" : "the best"} shot, held ${(tl[tl.length - 1].timeline_out_s - tl[tl.length - 1].timeline_in_s).toFixed(1)} s with a slow push and a fade.` : "",
            short ? `Short on footage, so ${T.toFixed(1)} s instead of ${target} s.` : ""];
        return bits.filter(Boolean).join(" ");
    }

    // ------------------------------------------------------------------ §13 self-check
    /**
     * @param {any} edl @param {{ media: any[], music: any }} input
     * @returns {{ cuts_on_beat_pct: number, black_frame_check: string, max_upscale_pct: number, effect_counts: Record<string, number>, issues_and_fixes: string[], ok: boolean, failures: string[] }}
     */
    function qc(edl, input) {
        const tl = edl.timeline || [], T = edl.project.duration_s, fails = [];
        const G = grid(input.music, T);
        const onBeat = (t) => G.cuts.some((b) => Math.abs(b - t) <= 1 / FPS + 1e-6) || Math.abs(t - T) < 1e-6;
        const cuts = tl.slice(1).map((x) => x.timeline_in_s);
        const pct = cuts.length ? Math.round((cuts.filter(onBeat).length / cuts.length) * 100) : 100;
        if (pct < 100) fails.push(`${100 - pct}% of cuts off the beat`);
        // gaps, overlaps, the end
        let black = "pass";
        if (!tl.length || Math.abs(tl[0].timeline_in_s) > 1e-6) { black = "fail"; fails.push("the edit doesn't start at 0"); }
        for (let i = 1; i < tl.length; i++) if (Math.abs(tl[i].timeline_in_s - tl[i - 1].timeline_out_s) > 1e-6) { black = "fail"; fails.push(`gap or overlap before shot ${i}`); }
        if (tl.length && Math.abs(tl[tl.length - 1].timeline_out_s - T) > 0.2) fails.push("the timeline doesn't end at duration_s");
        if (tl.some((x) => !x.asset_id)) { black = "fail"; fails.push("a shot without footage (black frames)"); }
        // sources inside their clips
        for (const it of tl) {
            const d = mediaDur(input.media, it.asset_id);
            if (it.source_in_s < -1e-6 || it.source_out_s > d + 0.05) fails.push(`shot ${it.index} reads past its clip`);
            else if (d !== Infinity && it.source_out_s - it.source_in_s < sourceSpan(it.speed, it.timeline_out_s - it.timeline_in_s) - 0.06) fails.push(`shot ${it.index}: its clip runs out (a frozen frame)`);
            if ((it.timeline_out_s - it.timeline_in_s) * FPS < 4 - 1e-6) fails.push(`shot ${it.index} is under 4 frames`);
        }
        // effect counts
        const counts = /** @type {Record<string, number>} */ ({});
        for (const it of tl) {
            for (const e of it.effects || []) counts[e.type] = (counts[e.type] || 0) + 1;
            if (it.transition_out && it.transition_out.type !== "cut" && it.transition_out.type !== "fade_black") counts[it.transition_out.type] = (counts[it.transition_out.type] || 0) + 1;
            if (it.speed && it.speed.length > 1) counts.speed_ramp = (counts.speed_ramp || 0) + 1;
            if (it.transform && it.transform.rotation_deg) counts.rotated_frame = (counts.rotated_frame || 0) + 1;
            if (it.grade_override && it.grade_override.monochrome && edl.project.preset !== "B_MONOCHROME_RITUAL") counts.monochrome_shot = (counts.monochrome_shot || 0) + 1;
            if ((it.effects || []).length > 1 && !(it.effects.length === 2 && it.effects.some((e) => e.type === "text_behind_subject"))) fails.push(`shot ${it.index} stacks ${it.effects.length} effects`);
        }
        for (const [k, n] of Object.entries(counts)) if (MAX[k] !== undefined && n > MAX[k]) fails.push(`${k}: ${n} (max ${MAX[k]})`);
        // the arc and the hero
        const secs = tl.map((x) => x.section);
        if (secs[0] !== "hook" || secs[secs.length - 1] !== "resolve") fails.push("the arc doesn't run hook → resolve");
        const last = tl[tl.length - 1];
        if (last && last.timeline_out_s - last.timeline_in_s < 2 - 1e-6 && T >= 8) fails.push("the hero shot is held under 2 s");
        if (last && !["fade_black", "frame_resize"].includes(last.transition_out && last.transition_out.type)) fails.push("the edit doesn't fade out");
        // text
        let lineHosts = new Set(), keywords = 0;
        for (const it of tl) for (const x of it.text || []) {
            if (x.style.startsWith("keyword")) keywords++;
            else if (!(it === tl[tl.length - 1] && x.size_pct <= 4)) lineHosts.add(it.index);           // the sign-off doesn't count
            const [, y] = x.position || [0.5, 0.5];
            if (y < 0.12 || y > 0.8) fails.push(`text "${x.content}" outside the safe zone`);
            if (x.start_s > T - 1.5 && !(last && it === last && x.size_pct <= 4)) fails.push(`text "${x.content}" in the final 1.5 s`);
            if (!onBeat(x.start_s) && x.start_s !== it.timeline_in_s) fails.push(`text "${x.content}" off the beat`);
        }
        if (lineHosts.size + keywords > 2) fails.push("more than 2 text sequences");
        // adjacent same footage (a weaker check than scale + angle when there's no person model)
        for (let i = 1; i < tl.length; i++) if (tl[i].asset_id === tl[i - 1].asset_id && Math.abs(tl[i].source_in_s - tl[i - 1].source_out_s) < 0.05 && edl.project.preset !== "B_MONOCHROME_RITUAL") fails.push(`shots ${i - 1} and ${i} are one continuous take`);
        const ups = tl.map((x) => Math.max(x.transform ? x.transform.scale_start : 1, x.transform ? x.transform.scale_end : 1));
        return { cuts_on_beat_pct: pct, black_frame_check: black, max_upscale_pct: Math.round((Math.max(1, ...ups) - 1) * 100), effect_counts: counts, issues_and_fixes: fails.map((f) => `FAIL: ${f}`), ok: fails.length === 0, failures: fails };
    }

    // ------------------------------------------------------------------ an EDL from elsewhere, made safe
    /**
     * The AI director's EDL (or any) → one that renders: shapes checked, cuts snapped to beats, the timeline
     * contiguous and ending at duration_s, sources inside their clips, unknown types dropped, limits enforced.
     * Returns null when there's nothing usable (the phone's own plan is used instead).
     * @param {any} raw @param {{ media: any[], music: any, brief?: any }} input
     */
    function repair(raw, input) {
        if (!raw || typeof raw !== "object" || !Array.isArray(raw.timeline) || !raw.project) return null;
        const fixes = [];
        const preset = PRESETS[raw.project.preset] ? raw.project.preset : choosePreset(input.media, input.brief || {}).preset;
        const T0 = clamp(Number(raw.project.duration_s) || (input.brief && input.brief.durationS) || 15, 6, 60);
        const G = grid(input.music, T0);
        const T = G.end;
        if (Math.abs(T - T0) > 0.05) fixes.push(`duration ${T0} s → ${T} s (ends on a bar)`);
        const ids = new Set(input.media.map((m) => m.id));
        let items = raw.timeline.filter((x) => x && ids.has(String(x.asset_id))).sort((a, b) => (Number(a.timeline_in_s) || 0) - (Number(b.timeline_in_s) || 0));
        if (items.length < raw.timeline.length) fixes.push(`${raw.timeline.length - items.length} shot(s) with unknown footage dropped`);
        if (!items.length) return null;
        // cuts on the beat, at least 4 frames apart; the last ends at T
        const cuts = [0];
        for (let i = 1; i < items.length; i++) {
            const c = nearest(G.cuts.filter((b) => b > cuts[cuts.length - 1] + 4 / FPS - 1e-6 && b < T - 0.5), Number(items[i].timeline_in_s) || 0);
            if (c > cuts[cuts.length - 1]) cuts.push(c); else { items.splice(i, 1); i--; fixes.push("a shot too short to keep was merged"); }
        }
        const counts = Object.fromEntries(Object.keys(MAX).map((k) => [k, 0]));
        const ok = (k) => (MAX[k] === undefined ? true : counts[k] < MAX[k] ? (counts[k]++, true) : false);
        const tl = items.map((x, i) => {
            const t0 = frT(cuts[i]), t1 = frT(i + 1 < cuts.length ? cuts[i + 1] : T), d = t1 - t0;
            const m = input.media.find((y) => y.id === String(x.asset_id));
            const speed = Array.isArray(x.speed) && x.speed.length ? x.speed.filter((k) => fin(k.t) && fin(k.rate)).map((k) => ({ t: r3(clamp(k.t, 0, d)), rate: r3(clamp(k.rate, m && m.kind === "video" ? Math.min(1, Math.max(0.25, FPS / (m.fps || FPS))) : 1, 2)), ease: k.ease || "cubic" })) : [{ t: 0, rate: 1, ease: "linear" }];
            const sp = speed.length ? speed : [{ t: 0, rate: 1, ease: "linear" }];
            if (sp.length > 1 && !ok("speed_ramp")) sp.splice(1);
            const need = sourceSpan(sp, d);
            const dur = m && m.kind === "video" ? m.duration : Infinity;
            let sin = clamp(Number(x.source_in_s) || 0, 0, Math.max(0, dur - need - 0.02));
            if (m && m.kind === "video" && need > dur) { sin = 0; fixes.push(`shot ${i}: its clip is shorter than the shot`); }
            const tr = x.transform || {};
            const fw = tr.frame_window && Array.isArray(tr.frame_window.start) ? tr.frame_window : { start: [1, 1], end: [1, 1], ease: "easeOut" };
            const effects = (Array.isArray(x.effects) ? x.effects : []).filter((e) => e && EFFECTS.includes(e.type)).slice(0, 1).filter((e) => ok(e.type))
                .map((e) => ({ type: e.type, start_s: t0, duration_frames: clamp(Math.round(Number(e.duration_frames) || 2), 1, Math.round(d * FPS)), params: e.params && typeof e.params === "object" ? e.params : {} }));
            const tro = x.transition_out && TRANSITIONS.includes(x.transition_out.type) ? x.transition_out : { type: "cut" };
            let transition = { type: tro.type, duration_frames: clamp(Math.round(Number(tro.duration_frames) || 0), 0, Math.max(0, Math.round(d * FPS) - 1)), direction: tro.direction || "none", params: tro.params || {} };
            if (transition.type !== "cut" && transition.type !== "fade_black" && !ok(transition.type)) transition = { type: "cut", duration_frames: 0, direction: "none", params: {} };
            const text = (Array.isArray(x.text) ? x.text : []).filter((w) => w && typeof w.content === "string" && w.content.trim()).slice(0, 14).map((w) => ({
                content: w.content.slice(0, 40), start_s: frT(nearest([t0, ...G.cuts.filter((c) => c > t0 && c < t1)], clamp(Number(w.start_s) || t0, t0, t1))), end_s: frT(clamp(Number(w.end_s) || t1, t0, T)), style: TEXT_STYLES.includes(w.style) ? w.style : "sans_white",
                position: [r3(clamp(Number((w.position || [])[0]) || 0.5, 0.08, 0.92)), r3(clamp(Number((w.position || [])[1]) || 0.5, 0.12, 0.8))], size_pct: clamp(Number(w.size_pct) || 5.5, 2.5, 14),
                behind_subject: Boolean(w.behind_subject && m && m.mask), animation: w.animation === "scale_in_3f" ? "scale_in_3f" : "cut_in" }));
            return {
                index: i, section: ["hook", "build", "peak", "resolve"].includes(x.section) ? x.section : t0 < T * 0.12 ? "hook" : t0 < T * 0.45 ? "build" : t0 < T * 0.8 ? "peak" : "resolve",
                asset_id: String(x.asset_id), source_in_s: r3(sin), source_out_s: r3(Math.min(dur, sin + need)), timeline_in_s: t0, timeline_out_s: t1,
                on_beat_index: G.beats.findIndex((b) => Math.abs(b - t0) < 0.02), speed: sp, interpolation: "none",
                transform: { crop_center: [r3(clamp(Number((tr.crop_center || [])[0]) || 0.5, 0, 1)), r3(clamp(Number((tr.crop_center || [])[1]) || 0.5, 0, 1))], scale_start: r3(clamp(Number(tr.scale_start) || 1, 1, 1.15)), scale_end: r3(clamp(Number(tr.scale_end) || 1.03, 1, 1.15)),
                    position_drift: [r3(clamp(Number((tr.position_drift || [])[0]) || 0, -0.05, 0.05)), r3(clamp(Number((tr.position_drift || [])[1]) || 0, -0.05, 0.05))],
                    rotation_deg: Number(tr.rotation_deg) === 90 && ok("rotated_frame") ? 90 : 0,
                    frame_window: { start: [clamp(Number(fw.start[0]) || 1, 0, 1), clamp(Number(fw.start[1]) || 1, 0, 1)], end: [clamp(Number((fw.end || fw.start)[0]) || 1, 0, 1), clamp(Number((fw.end || fw.start)[1]) || 1, 0, 1)], ease: fw.ease || "easeOut" } },
                parallax_2_5d: Boolean(x.parallax_2_5d && m && m.mask), grade_override: { monochrome: Boolean(x.grade_override && x.grade_override.monochrome), exposure: clamp(Number(x.grade_override && x.grade_override.exposure) || 0, -1, 1), notes: "" },
                effects, transition_out: transition, text, audio: { keep_clip_audio: false, gain_db: -12 }
            };
        });
        const last = tl[tl.length - 1];
        if (!["fade_black", "frame_resize"].includes(last.transition_out.type)) { last.transition_out = { type: "fade_black", duration_frames: 36, direction: "none", params: {} }; fixes.push("added the fade to black"); }
        last.section = "resolve"; tl[0].section = "hook";
        const P = PRESETS[preset];
        const edl = {
            project: { preset, aspect_ratio: (input.brief && input.brief.aspect) === "16:9" ? "16:9" : "9:16", resolution: (input.brief && input.brief.aspect) === "16:9" ? [1920, 1080] : [1080, 1920], fps: FPS, duration_s: T,
                music: { track_id: String(input.music.track_id || `agent:${P.key}`), start_s: G.start, end_s: r3(G.start + T), fade_in_s: 0.15, fade_out_s: 1.2, bpm: input.music.bpm },
                global_grade: { ...P.grade }, reasoning: String(raw.project.reasoning || "").slice(0, 600) },
            timeline: tl, qc_report: { cuts_on_beat_pct: 100, black_frame_check: "pass", max_upscale_pct: 0, effect_counts: {}, issues_and_fixes: [] }
        };
        const r = qc(edl, input);
        edl.qc_report = { ...r, issues_and_fixes: [...fixes.map((f) => `FIXED: ${f}`), ...r.issues_and_fixes] };
        return edl;
    }

    // ------------------------------------------------------------------ §14 feedback
    /**
     * Change only what was asked; everything else (the seed, the clips, the length) stays.
     * @param {any} brief @param {{ ask: string, value?: any, edl?: any }} f
     */
    function feedback(brief, f) {
        const b = { ...(brief || {}) };
        const ex = new Set(b.exclude || []), pins = { ...(b.pins || {}) };
        switch (f.ask) {
            case "slower": b.pace = clamp((b.pace || 1) * 1.35, 0.5, 2); break;
            case "faster": b.pace = clamp((b.pace || 1) / 1.35, 0.5, 2); break;
            case "more_fx": b.fx = clamp((b.fx ?? 1) + 0.5, 0, 2); break;
            case "less_fx": b.fx = clamp((b.fx ?? 1) - 0.5, 0, 2); break;
            case "look": if (PRESETS[f.value]) b.preset = f.value; break;
            case "take": b.seed = (b.seed || 1) + 1; break;
            case "length": b.durationS = clamp(Number(f.value) || 15, 8, 60); break;
            case "text": b.caption = String(f.value || ""); b.noText = !f.value; break;
            case "drop": if (f.value) ex.add(String(f.value)); break;
            case "pin": if (f.value && Number.isInteger(f.value.index)) pins[f.value.index] = String(f.value.key); break;
            default: break;
        }
        b.exclude = [...ex]; b.pins = pins;
        return b;
    }

    // ------------------------------------------------------------------ what to draw
    const easeOut = (u) => 1 - Math.pow(1 - u, 3), easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
    /**
     * @param {any} edl @param {number} t timeline seconds
     */
    function frameAt(edl, t) {
        const tl = edl.timeline, T = edl.project.duration_s;
        t = clamp(t, 0, T - 1e-4);
        let i = 0;
        while (i < tl.length - 1 && t >= tl[i + 1].timeline_in_s - 1e-9) i++;
        const it = tl[i], next = tl[i + 1] || null;
        const local = t - it.timeline_in_s, d = it.timeline_out_s - it.timeline_in_s, u = clamp(local / Math.max(1e-6, d), 0, 1);
        const tr = it.transform;
        const fw = tr.frame_window, fwU = easeOut(clamp(local / (10 / FPS), 0, 1));
        const win = [fw.start[0] + (fw.end[0] - fw.start[0]) * fwU, fw.start[1] + (fw.end[1] - fw.start[1]) * fwU];
        // the outgoing transition: its last N frames, mixing toward the next shot
        const to = it.transition_out || { type: "cut", duration_frames: 0 };
        const tN = (to.duration_frames || 0) / FPS;
        let trans = null;
        if (to.type !== "cut" && tN > 0 && local >= d - tN - 1e-9) {
            const p = clamp((local - (d - tN)) / tN, 0, 1);
            trans = { type: to.type, p, direction: to.direction || "none", params: to.params || {}, next };
        }
        // the ending: B collapses the window then holds black
        let black = 0;
        if (to.type === "frame_resize" && !next) {
            const hold = Number(to.params && to.params.hold_black_s) || 0.5, cN = tN;
            const cStart = d - hold - cN;
            if (local >= cStart) { const p = clamp((local - cStart) / Math.max(1e-6, cN), 0, 1); win[0] *= 1 - easeInOut(p); win[1] *= 1 - easeInOut(p); }
            if (local >= d - hold) black = 1;
            trans = null;
        }
        const effects = (it.effects || []).map((e) => {
            const el = t - e.start_s, len = (e.duration_frames || 1) / FPS;
            return el >= -1e-9 && el < Math.max(len, e.type === "white_flash" ? 6 / FPS : len) ? { ...e, p: clamp(el / Math.max(len, 1e-6), 0, 1), el } : null;
        }).filter(Boolean);
        const text = (it.text || []).filter((x) => t >= x.start_s - 1e-9 && t < x.end_s).map((x) => ({ ...x, age: t - x.start_s }));
        // previous shots' text sequences that are still on screen (a line spans several shots until it clears)
        for (let k = 0; k < i; k++) for (const x of tl[k].text || []) if (t >= x.start_s && t < x.end_s) text.push({ ...x, age: t - x.start_s });
        return {
            i, item: it, next, local, u, d,
            sourceT: sourceAt(it, local), rate: rateAt((it.speed || []).slice().sort((a, b) => a.t - b.t), local),
            scale: tr.scale_start + (tr.scale_end - tr.scale_start) * easeInOut(u), drift: [tr.position_drift[0] * u, tr.position_drift[1] * u], rotation: tr.rotation_deg || 0,
            window: win, trans, effects, text, black,
            fadeIn: clamp(t / 0.15, 0, 1), musicT: edl.project.music.start_s + t
        };
    }

    return { FPS, MAX, PRESETS, PRESET_KEYS, moments, choosePreset, grid, plan, qc, repair, feedback, frameAt, sourceAt, sourceSpan, rateAt, scaleOf };
});
