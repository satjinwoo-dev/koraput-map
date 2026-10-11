// @ts-check
/* ============================================================================
   MapUnite Master AI — Mood agent ("mood"): the music, the mood, the next song
   ==============================================================================
   Watches what's playing in any music app (capability "media": Android media
   sessions through the MapUniteMedia plugin) and, per track, asks our server
   (/api/master/music, lib/master/music.js) for its mood (valence: sad ↔ happy,
   energy: calm ↔ intense) and what could come next. The session's mood is a
   moving average of the last tracks (α = 0.4), shared as state.mood.

   WHAT THE NEXT SONG SHOULD DO (the target sent to the server):
     energise  the fatigue check said moderate/high in the last hour, or the ride
               is past 2 h and the music is drowsy (energy < −0.3)
     calm      stress is high (state.affect.stress ≥ 0.6: jams, hard braking, rain)
     keep      otherwise: more of the same
   SAYS (advice, so "Bhai, ek baat bolun?" first, and only when the gate allows):
     music.energise / music.calm / music.suggest    at most once per 20 min
     music.access-needed   once a week while notification access is off, only when stopped

   RESPECT, as the rider asked:
     - "gaane suggest mat kar" / "no music tips" → task.music-mute → silent for
       the rest of the ride (or the minutes asked); "music tips on" undoes it;
     - two declined suggestions in a row → silent for an hour (and the brain's
       interest policy learns it over weeks: cognition.js);
     - it only SUGGESTS. It changes the track only when the rider says so
       (task.music-control: "agla gaana" → next).
   Inferring mood from music is a hint, not a diagnosis; nothing here is
   stored beyond the session's last 5 tracks and the mute setting.
   ============================================================================ */
(function (root, factory) {
    // geo.js and phrases-radar.js load before this file (index.html); in Node they're required
    if (typeof module === "object" && module.exports) module.exports = factory(require("../geo.js"), require("../phrases-radar.js"));
    else {
        const M = /** @type {any} */ (root).MUMaster || (/** @type {any} */ (root).MUMaster = {});
        const def = factory(M.geo, M.phrasesRadar);
        if (typeof M.define === "function") M.define(def); else (M._pending || (M._pending = [])).push(def);
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function (/** @type {any} */ GEO, /** @type {any} */ PHRASES) {
    "use strict";

    const words = () => PHRASES.WORDS;

    return {
        id: "mood",
        version: "1.0.0",
        apiVersion: 1,
        description: "Reads the mood of the music playing and suggests what to play next, when welcome.",
        requires: ["master-api", "media"],
        defaults: { suggestEveryMs: 1200000, alpha: 0.4, declineMuteMs: 3600000, accessAskEveryMs: 7 * 86400000, minConfidence: 0.3, timeoutMs: 8000 },

        /** @param {any} ctx */
        start(ctx) {
            const WD = words();
            const cfg = ctx.config;
            const api = ctx.caps.get("master-api");
            const media = ctx.caps.get("media");
            /** @type {{ valence: number, energy: number, label: string, confidence: number }|null} */ let mood = null;
            /** @type {any[]} */ const history = [];
            let lastKey = "", lastSuggestAt = -Infinity, declines = 0;
            let mutedUntil = Number(ctx.store.get("mutedUntil", 0)) || 0;

            const ride = () => ctx.bus.last("state.ride") || {};
            function target() {
                const f = ctx.bus.last("state.fatigue");
                if (f && (f.level === "high" || f.level === "moderate") && ctx.now() - (f.at || 0) < 3600000) return "energise";
                const a = ctx.bus.last("state.affect");
                if (a && a.stress >= 0.6) return "calm";
                if ((ride().ridingSec || 0) > 7200 && mood && mood.energy < -0.3) return "energise";
                return "keep";
            }

            async function onTrack(/** @type {any} */ t) {
                if (!t || !t.playing) return;
                const key = `${t.artist}|${t.title}`.toLowerCase();
                if (key === lastKey) return;
                lastKey = key;
                const want = target();
                const r = await api.post("/music", { title: t.title, artist: t.artist, target: want }, { timeoutMs: cfg.timeoutMs, signal: ctx.signal });
                if (!r.ok) return;
                const m = r.data.mood;
                if (m && m.confidence > 0) {
                    mood = mood
                        ? { valence: mood.valence + cfg.alpha * (m.valence - mood.valence), energy: mood.energy + cfg.alpha * (m.energy - mood.energy), label: m.label, confidence: Math.max(mood.confidence * 0.8, m.confidence) }
                        : { valence: m.valence, energy: m.energy, label: m.label, confidence: m.confidence };
                }
                history.push({ title: t.title, artist: t.artist, mood: m && m.label });
                if (history.length > 5) history.shift();
                ctx.setState("mood", { at: ctx.now(), track: { title: t.title, artist: t.artist, app: t.app }, mood, target: want, recent: history.slice() });
                maybeSuggest(want, r.data.suggestions || []);
            }

            /** @param {string} want @param {Array<{ title: string, artist: string }>} list */
            function maybeSuggest(want, list) {
                const t = ctx.now();
                if (t < mutedUntil || t - lastSuggestAt < cfg.suggestEveryMs || !mood || mood.confidence < cfg.minConfidence) return;
                const heard = new Set(history.map((h) => `${h.artist}|${h.title}`.toLowerCase()));
                const pick = list.find((s) => !heard.has(`${s.artist}|${s.title}`.toLowerCase()));
                if (!pick) return;
                lastSuggestAt = t;
                const md = WD.mood[mood.label] || WD.mood.happy;
                const kind = want === "energise" ? "music.energise" : want === "calm" ? "music.calm" : "music.suggest";
                ctx.report(kind, { severity: "advice", key: "music.suggest", category: "music", data: { song: pick.title, artist: pick.artist, mood: md.desi, screen: { song: pick.artist ? `${pick.title} · ${pick.artist}` : pick.title, mood: md.plain } }, ttlMs: 120000, cooldownMs: cfg.suggestEveryMs });
            }

            // two "nahi" in a row → an hour of silence
            ctx.bus.subscribe("master.decision", (/** @type {any} */ d) => {
                if (!d || d.source !== "mood") return;
                if (d.action === "declined") { if (++declines >= 2) { mutedUntil = ctx.now() + cfg.declineMuteMs; declines = 0; } }
                else if (d.action === "spoken") declines = 0;
            });

            ctx.bus.handle("task.music-mute", (/** @type {any} */ q) => {
                const minutes = q && Number.isFinite(q.minutes) ? q.minutes : null;
                if (q && q.on === false) mutedUntil = 0;
                else mutedUntil = ctx.now() + (minutes ? minutes * 60000 : 6 * 3600000);
                ctx.store.set("mutedUntil", mutedUntil);
                return { mutedUntil };
            });
            ctx.bus.handle("task.music-control", async (/** @type {any} */ q) => ({ ok: await media.control(q && q.action) }));

            const offs = [media.onTrack(ctx.wrap(onTrack))];
            ctx.onStop(() => offs.forEach((off) => off()));

            // notification access: ask once a week, only when stopped
            ctx.timers.setInterval(async () => {
                if (media.access()) return;
                await media.refresh();
                if (media.access()) return;
                const r = ride();
                if (r.active && (r.speedMs || 0) > 1) return;
                const lastAsk = Number(ctx.store.get("accessAskedAt", 0)) || 0;
                if (Date.now() - lastAsk < cfg.accessAskEveryMs) return;
                ctx.store.set("accessAskedAt", Date.now());
                ctx.report("music.access-needed", { severity: "advice", key: "music.access", category: "music" });
            }, 60000);
            const now = media.current();
            if (now) onTrack(now);
        }
    };
});
