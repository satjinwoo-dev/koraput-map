// @ts-check
"use strict";
/* ============================================================================
   MapUnite Ride Edit (server) — the AI director: "Summit Cut"
   ==============================================================================
   POST /api/master/edit-direct  { brief, media, music, ride? } → { ok, edl, engine }

   The rider's phone measures the clips and the music (js/edit/edit-engine.js,
   beats.js) and sends ONLY those numbers: sharpness, motion, light, colour,
   sky/earth share, the person's size and place, frame rates, beat times. No
   photo, frame or sound leaves the phone. The reasoning engines
   (lib/master/llm.js: Gemini → Groq → local Ollama, all free) get the Summit
   Cut system prompt (prompts/summit-cut.md, verbatim) plus a short note on
   this app's renderer, and answer with the Edit Decision List as JSON.

   The answer is checked here only for being JSON with a timeline; the phone
   repairs it against the real beats and clips (summit.js repair: cuts snapped
   to beats, sources inside clips, limits enforced) before playing it, and uses
   its own plan when no engine is ready.
   ============================================================================ */
const fs = require("fs");
const path = require("path");

const PROMPT = (() => { try { return fs.readFileSync(path.join(__dirname, "prompts", "summit-cut.md"), "utf8"); } catch { return ""; } })();
const APP_NOTE = `
---
## THIS APP (MapUnite Ride Edit) — what the renderer can do

- Input analysis per media item: samples[] at times t (s) with bright (0–1), color (colourfulness 0–1), sharp (0–1), motion (0–1, change since the previous sample), sky (share of the frame that is sky), earth (share that is orange/red earth), and — only when the on-phone person model ran — subj (person's share of the frame), cx, cy (person centre, 0–1). mask: true means a clean cut-out of the person exists (needed for subject_clone, ghost_silhouette, text_behind_subject, parallax_2_5d). fps is the clip's real frame rate.
- No optical-flow interpolation exists: set "interpolation": "none" and never use a rate below 30 ÷ the clip's fps (a 30 fps clip plays at 1.0×; 60 fps can go to 0.5×; 120 fps to 0.25×).
- music.beats are the cut points (seconds from the start of the song); the timeline starts at music.start_s = the first beat at or after firstOnset. Cuts may also fall on half-beats.
- Asset ids are the media[].id values. Photos have duration 0 (use any source range).
- The output must be ONLY the JSON object of §12. No markdown fences, no comments.
`;

const num = (x, lo, hi) => { const n = Number(x); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null; };
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Only the numbers the prompt needs, bounded (≤ 30 clips × 40 samples, ≤ 600 beats). */
function cleanInput(b) {
    const brief = b && typeof b.brief === "object" && b.brief ? b.brief : {};
    const media = (Array.isArray(b && b.media) ? b.media : []).slice(0, 30).map((m) => ({
        id: String(m && m.id || "").replace(/[^\w.-]/g, "").slice(0, 24), kind: m && m.kind === "photo" ? "photo" : "video",
        duration: num(m && m.duration, 0, 3600) || 0, fps: num(m && m.fps, 1, 480) || 30, w: num(m && m.w, 1, 20000) || 0, h: num(m && m.h, 1, 20000) || 0, mask: Boolean(m && m.mask),
        samples: (Array.isArray(m && m.samples) ? m.samples : []).slice(0, 40).map((s) => {
            const o = { t: r3(num(s && s.t, 0, 3600) || 0) };
            for (const k of ["bright", "color", "sharp", "motion", "sky", "earth", "subj", "cx", "cy"]) { const v = num(s && s[k], 0, 1); if (v !== null) o[k] = r3(v); }
            return o;
        })
    })).filter((m) => m.id);
    const mu = b && typeof b.music === "object" && b.music ? b.music : {};
    const times = (a, n) => (Array.isArray(a) ? a : []).slice(0, n).map((x) => num(x, 0, 3600)).filter((x) => x !== null).map(r3);
    const music = { bpm: num(mu.bpm, 40, 240) || 120, beats: times(mu.beats, 600), downbeats: times(mu.downbeats, 160), drops: times(mu.drops, 16), firstOnset: num(mu.firstOnset, 0, 3600) || 0, duration: num(mu.duration, 0, 3600) || 0, energy: (Array.isArray(mu.energy) ? mu.energy : []).slice(0, 256).map((x) => r3(num(x, 0, 1) || 0)), energyStep: num(mu.energyStep, 0.05, 2) || 0.25 };
    const ride = b && b.ride && typeof b.ride === "object" ? { km: num(b.ride.km, 0, 5000), topKmh: num(b.ride.topKmh, 0, 400), place: typeof b.ride.place === "string" ? b.ride.place.slice(0, 40) : null } : null;
    const PRESETS = ["A_CINEMATIC_SUMMIT", "B_MONOCHROME_RITUAL", "C_KINETIC_GLITCH_STORY"];
    return {
        brief: { preset: PRESETS.includes(brief.preset) ? brief.preset : null, durationS: num(brief.durationS, 6, 60) || 15, aspect: brief.aspect === "16:9" ? "16:9" : "9:16", caption: typeof brief.caption === "string" ? brief.caption.slice(0, 120) : "" },
        media, music, ride
    };
}

/** The first JSON object in a reply (engines sometimes wrap it in a fence). */
function parseEdl(text) {
    if (typeof text !== "string") return null;
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try { const j = JSON.parse(text.slice(a, b + 1)); return j && j.project && Array.isArray(j.timeline) && j.timeline.length ? j : null; } catch { return null; }
}

/** @param {{ engines: { reason: Function, configured: () => boolean } }} o */
function createEditDirector(o) {
    async function handle(body) {
        if (!PROMPT) return { status: 503, json: { ok: false, reason: "no-prompt" } };
        const input = cleanInput(body || {});
        if (!input.media.length || input.music.beats.length < 8) return { status: 400, json: { ok: false, reason: "bad-input" } };
        if (!o.engines.configured()) return { status: 503, json: { ok: false, reason: "no-engine" } };
        const r = await o.engines.reason({
            system: `${PROMPT}\n${APP_NOTE}`,
            prompt: `Make the edit. INPUT (JSON):\n${JSON.stringify(input)}`,
            deadlineMs: 45000, maxTokens: 8192,
            accept: (/** @type {string} */ t) => parseEdl(t) !== null
        });
        if (!r.ok) return { status: 503, json: { ok: false, reason: "no-answer", tried: r.tried } };
        return { status: 200, json: { ok: true, engine: r.engine, edl: parseEdl(r.text) } };
    }
    return { handle };
}

module.exports = { createEditDirector, cleanInput, parseEdl, PROMPT };
