/* ============================================================================
   MapUnite Ride Edit — the Summit Cut editing agent's screen
   ==============================================================================
   RideEdit.open({ card })   from the ride recap ("🎬 Edit a video"), with the
   ride's card (js/share/card-model.js: privacy-trimmed, real figures only), or
   with no ride at all.
     1. the rider adds photos and videos (they stay on the phone);
     2. picks a look (or lets the agent pick), a length, a format, the music
        (the look's own track, or their song: its beats are found on the
        phone), optional words, and who directs: the agent on the phone, or
        the AI director online (the Summit Cut system prompt on the server's
        free engines; it gets measurements only, never a picture);
     3. "Let the agent edit": it watches every clip (and finds the rider in
        them, on the phone), says what it found and decided, plans the edit
        as the prompt's JSON Edit Decision List, checks it (§13) and plays it;
     4. feedback that changes only what was asked (slower, faster, more or
        fewer effects, another take, another look), a timeline to remove or
        swap any shot, Save / Share the video, and the EDL itself as JSON.
   ============================================================================ */
"use strict";

const RideEdit = (() => {
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : null);
    if (!W || !W.document) return {};
    const S = () => W.MUSummit, E = () => W.MUEditEngine, Bt = () => W.MUEditBeats;
    const KEY = "mu.edit.v2";
    const h = (tag, a = {}, kids = []) => {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(a)) {
            if (v == null || v === false) continue;
            if (k === "class") el.className = v; else if (k === "text") el.textContent = v; else if (k === "style") el.style.cssText = v;
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? "" : String(v));
        }
        for (const c of [].concat(kids)) if (c != null && c !== false) el.append(c);
        return el;
    };
    const DEF = { style: "auto", length: 15, aspect: "9:16", music: "preset", director: "phone", person: true };
    const prefs = (() => { try { return { ...DEF, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch (e) { return { ...DEF }; } })();
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) { /* private mode */ } };
    const LOOKS = [["auto", "✨ Agent picks"], ["A_CINEMATIC_SUMMIT", "🏔 Cinematic Summit"], ["B_MONOCHROME_RITUAL", "◐ Monochrome Ritual"], ["C_KINETIC_GLITCH_STORY", "⚡ Kinetic Glitch"]];
    const SECTION = { hook: "#ff5a5f", build: "#ffb020", peak: "#c6f432", resolve: "#5ad1ff" };
    let root = null;

    /** @param {{ card?: any }} [o] */
    function open(o = {}) {
        if (root) root.remove();
        const card = o.card || null;
        const st = { media: /** @type {any[]} */ ([]), busy: false, seed: 1, player: null, edl: null, brief: null, song: null, withRide: Boolean(card), words: "", nextId: 0 };
        const thumbs = h("div", { class: "re-thumbs" });
        const fileIn = /** @type {HTMLInputElement} */ (h("input", { type: "file", accept: "image/*,video/*", multiple: true, hidden: true }));
        const musicIn = /** @type {HTMLInputElement} */ (h("input", { type: "file", accept: "audio/*", hidden: true }));
        const log = h("ol", { class: "re-log", "aria-live": "polite" });
        const canvas = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "re-canvas", "aria-label": "Your edit" }));
        const stage = h("div", { class: "re-stage", hidden: true }, [canvas]);
        const status = h("p", { class: "re-status", role: "status" });
        const goBtn = h("button", { type: "button", class: "re-go", text: "✨ Let the agent edit", onclick: () => runAgent() });
        const playBtn = h("button", { type: "button", class: "re-b", text: "▶ Play", onclick: () => { if (st.player) st.player.play(); } });
        const saveBtn = h("button", { type: "button", class: "re-b primary", text: "⬇ Save video", onclick: () => exportVideo("save") });
        const shareBtn = h("button", { type: "button", class: "re-b", text: "↗ Share", onclick: () => exportVideo("share") });
        const edlBtn = h("button", { type: "button", class: "re-b", text: "{ } Edit list (JSON)", onclick: () => saveEdl() });
        const results = h("div", { class: "re-actions", hidden: true }, [playBtn, saveBtn, shareBtn, edlBtn]);
        const fb = (label, ask, value) => h("button", { type: "button", class: "re-chip", text: label, onclick: () => again({ ask, value }) });
        const feedbackRow = h("div", { class: "re-row", hidden: true }, [h("span", { class: "re-lbl", text: "Tell the agent" }), h("div", { class: "re-chips" }, [
            fb("🐢 Slower", "slower"), fb("⚡ Faster", "faster"), fb("✨ More effects", "more_fx"), fb("🧘 Fewer effects", "less_fx"), fb("🎲 Another take", "take"), fb("🎨 Another look", "look", "next")
        ])]);
        const strip = h("div", { class: "re-strip", hidden: true });
        const shotMenu = h("div", { class: "re-shotmenu", hidden: true });
        const qcBox = h("details", { class: "re-qc", hidden: true });

        const chips = (label, opts, get, set) => h("div", { class: "re-row" }, [h("span", { class: "re-lbl", text: label }), h("div", { class: "re-chips", role: "radiogroup", "aria-label": label }, opts.map(([v, t]) => {
            const b = h("button", { type: "button", class: "re-chip", role: "radio", "aria-checked": String(get() === v), text: t, onclick: () => { set(v); for (const x of b.parentElement.children) x.setAttribute("aria-checked", String(x === b)); save(); } });
            return b;
        }))]);
        const wordsIn = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "re-input", maxlength: "90", placeholder: "Words (optional), e.g. Some roads you just ride", "aria-label": "Words in the edit" }));
        wordsIn.addEventListener("input", () => { st.words = wordsIn.value; });
        const personRow = h("label", { class: "re-ride" }, [
            h("span", { class: "re-ride-ic", "aria-hidden": "true", text: "🧍" }),
            h("span", { class: "re-ride-tx" }, [h("b", { text: "Find me in the shots" }), h("small", { text: "On the phone (a 250 KB model): clones, ghosts, words behind you, moving photos." })]),
            (() => { const c = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", class: "switch", "aria-label": "Find me in the shots" })); c.checked = prefs.person; c.addEventListener("change", () => { prefs.person = c.checked; save(); }); return c; })()
        ]);

        function drawThumbs() {
            thumbs.replaceChildren(...st.media.map((m, i) => h("div", { class: "re-th" }, [
                m.thumb ? h("img", { src: m.thumb, alt: "" }) : h("span", { class: "re-wait", text: m.progress ? `${Math.round(m.progress * 100)}%` : "…" }),
                m.kind === "video" && m.duration ? h("span", { class: "re-dur", text: `${Math.round(m.duration)}s${m.fps >= 50 ? ` · ${m.fps}fps` : ""}` }) : null,
                m.mask ? h("span", { class: "re-you", title: "You were found in this shot", text: "🧍" }) : null,
                h("button", { type: "button", class: "re-rm", "aria-label": `Remove ${m.name}`, text: "✕", onclick: () => { st.media.splice(i, 1); drawThumbs(); } })
            ])), h("button", { type: "button", class: "re-add", onclick: () => fileIn.click() }, [h("span", { text: "＋" }), h("small", { text: st.media.length ? "Add more" : "Add photos & videos" })]));
        }
        fileIn.addEventListener("change", async () => {
            const files = [...(fileIn.files || [])].slice(0, 30 - st.media.length);
            fileIn.value = "";
            for (const f of files) {
                const slot = { id: `m${st.nextId++}`, name: f.name, kind: /^video/.test(f.type) ? "video" : "photo", thumb: "", duration: 0, pending: true, progress: 0 };
                st.media.push(slot); drawThumbs();
                const a = await E().analyze(f, { person: prefs.person, progress: (p) => { slot.progress = p; if (Math.round(p * 10) !== Math.round((p - 0.05) * 10)) drawThumbs(); } });
                const i = st.media.indexOf(slot);
                if (i < 0) continue;
                if (a) st.media[i] = { ...a, id: slot.id }; else st.media.splice(i, 1);
                drawThumbs();
            }
        });
        musicIn.addEventListener("change", async () => {
            const f = musicIn.files && musicIn.files[0];
            if (!f) return;
            status.textContent = `Listening to ${f.name}…`;
            try { st.song = await E().songBeats(f); status.textContent = `🎵 ${f.name}: ${Math.round(st.song.beats.bpm)} BPM, ${st.song.beats.drops.length ? `drop at ${st.song.beats.drops[0].toFixed(1)} s` : "no big drop"}.`; }
            catch (e) { status.textContent = "That song couldn't be read here. Try an MP3 or M4A."; st.song = null; }
        });

        const step = (text, cls) => { const li = h("li", { class: `re-step${cls ? ` ${cls}` : ""}` }, [h("span", { class: "re-dot", "aria-hidden": "true" }), h("span", { text })]); log.append(li); requestAnimationFrame(() => li.classList.add("in")); return li; };
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const ready = () => st.media.filter((m) => !m.pending);
        const assets = () => Object.fromEntries(ready().map((m) => [m.id, m]));
        const ride = () => {
            if (!card || !st.withRide) return null;
            const km = card.distance >= 200 ? card.distance / 1000 : null;
            return { km, topKmh: card.maxSpeed > 0 ? card.maxSpeed * 3.6 : null, place: card.place || null, title: card.title || null, signoff: km ? `MAPUNITE · ${km >= 10 ? Math.round(km) : km.toFixed(1)} KM` : "MAPUNITE" };
        };
        function musicFor(brief) {
            if (prefs.music === "song" && st.song) return st.song.beats;
            const preset = brief.preset || S().choosePreset(ready(), brief).preset;
            return { ...Bt().synthetic(S().PRESETS[preset].bpm, Math.max(20, (brief.durationS || 15) + 6)), track_id: `agent:${preset}` };
        }

        async function runAgent() {
            if (st.busy) return;
            const media = ready();
            if (!media.length) { status.textContent = "Add a few photos or clips first."; return; }
            if (st.media.some((m) => m.pending)) { status.textContent = "Still watching the last clip… one moment."; return; }
            st.busy = true; goBtn.disabled = true; log.replaceChildren(); status.textContent = "";
            const vids = media.filter((m) => m.kind === "video"), pics = media.length - vids.length;
            step(`Watched ${[vids.length ? `${vids.length} clip${vids.length === 1 ? "" : "s"}` : "", pics ? `${pics} photo${pics === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ")}: sharpness, light, colour, movement${vids.some((v) => v.fps >= 50) ? `, ${vids.filter((v) => v.fps >= 50).length} shot at 50+ fps (slow motion possible)` : ""}.`);
            await sleep(300);
            const found = media.filter((m) => m.mask).length;
            step(prefs.person ? (found ? `Found you in ${found} shot${found === 1 ? "" : "s"}: cut-outs ready.` : W.MUEditSegment && W.MUEditSegment.ready ? "No person found clearly enough to cut out: those effects are skipped." : "The person model didn't load here: cut-out effects are skipped.") : "Person finding is off: cut-out effects are skipped.");
            await sleep(250);
            const brief = { preset: prefs.style === "auto" ? null : prefs.style, durationS: prefs.length, aspect: prefs.aspect, caption: st.words, seed: st.seed, pace: 1, fx: 1 };
            st.brief = brief;
            const pick = S().choosePreset(media, brief);
            step(pick.why);
            await sleep(250);
            const mus = musicFor(brief);
            step(prefs.music === "song" && st.song ? `Your song: ${Math.round(mus.bpm)} BPM, ${mus.beats.length} beats, ${mus.downbeats.length} bars; the edit starts on its first hit and ends on a bar.` : `The ${S().PRESETS[pick.preset].label} track: ${mus.bpm} BPM, intro → build → drop → outro, made on the phone.`);
            await sleep(250);
            await direct(brief, mus);
            st.busy = false; goBtn.disabled = false;
        }

        /** Plan (or ask the AI director), check, show, play. */
        async function direct(brief, mus) {
            const media = ready();
            let edl = null;
            if (prefs.director === "ai") {
                const li = step("Asking the AI director (Summit Cut prompt) — sending measurements only…");
                try {
                    const base = W.MU_SERVER_ORIGIN || "";
                    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 55000);
                    const r = await fetch(`${base}/api/master/edit-direct`, { method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
                        body: JSON.stringify({ brief, media: media.map((m) => ({ id: m.id, kind: m.kind, duration: m.duration, fps: m.fps, w: m.w, h: m.h, mask: m.mask, samples: m.samples })), music: mus, ride: ride() }) });
                    clearTimeout(timer);
                    const j = await r.json();
                    if (j && j.ok && j.edl) {
                        edl = S().repair(j.edl, { media, music: mus, brief });
                        if (edl && edl.qc_report.failures.length) { step(`The director's edit failed the check (${edl.qc_report.failures[0]}): the phone's agent cuts it instead.`); edl = null; }
                        else if (edl) li.lastChild.textContent = `The AI director (${j.engine}) cut it; the phone checked and fixed it: ${edl.qc_report.issues_and_fixes.filter((x) => x.startsWith("FIXED")).length || "no"} fixes.`;
                    } else step(j && j.reason === "no-engine" ? "No AI engine is set up on the server: the phone's agent cuts it." : "The AI director didn't answer in time: the phone's agent cuts it.");
                } catch (e) { step("Couldn't reach the AI director (offline?): the phone's agent cuts it."); }
            }
            if (!edl) edl = S().plan({ media, music: mus, brief, ride: ride() });
            st.edl = edl;
            const P = S().PRESETS[edl.project.preset];
            step(edl.project.reasoning);
            const qc = edl.qc_report;
            const fxN = Object.values(qc.effect_counts).reduce((a, b) => a + b, 0);
            step(`Checked (§13): ${qc.cuts_on_beat_pct}% of ${edl.timeline.length - 1} cuts on the beat, ${fxN} effects within their limits, hero held ${(edl.timeline.at(-1).timeline_out_s - edl.timeline.at(-1).timeline_in_s).toFixed(1)} s, ${edl.project.duration_s.toFixed(1)} s on a bar.${qc.ok ? " ✓" : ` ${qc.failures.length} issue(s).`}`, qc.ok ? "ok" : "warn");
            qcBox.hidden = false;
            qcBox.replaceChildren(h("summary", { text: `Edit report · ${P.label}` }), h("ul", {}, [
                ...Object.entries(qc.effect_counts).map(([k, n]) => h("li", { text: `${k.replace(/_/g, " ")}: ${n}` })),
                ...qc.issues_and_fixes.map((x) => h("li", { class: "re-issue", text: x }))
            ]));
            build(mus);
        }
        function build(mus) {
            if (st.player) st.player.stop();
            st.player = E().createPlayer(canvas, st.edl, assets(), { music: prefs.music === "song" && st.song ? st.song.buffer : null, ride: ride() });
            stage.hidden = false; results.hidden = false; feedbackRow.hidden = false; strip.hidden = false;
            stage.classList.toggle("wide", st.edl.project.aspect_ratio === "16:9");
            drawStrip(mus);
            st.player.play();
        }
        /** The timeline: every shot, its section's colour, tap to remove or swap it. */
        function drawStrip(mus) {
            const T = st.edl.project.duration_s, a = assets();
            strip.replaceChildren(...st.edl.timeline.map((it, i) => {
                const m = a[it.asset_id];
                return h("button", { type: "button", class: "re-shot", style: `flex:${(it.timeline_out_s - it.timeline_in_s) / T};--c:${SECTION[it.section]}`, title: `${it.section} · ${(it.timeline_out_s - it.timeline_in_s).toFixed(2)} s`,
                    onclick: () => openShot(i, mus) }, [m && m.thumb ? h("img", { src: m.thumb, alt: "" }) : null]);
            }));
        }
        function openShot(i, mus) {
            const it = st.edl.timeline[i];
            const key = momentKey(it);
            shotMenu.hidden = false;
            shotMenu.replaceChildren(h("span", { text: `Shot ${i + 1} · ${it.section} · ${(it.timeline_out_s - it.timeline_in_s).toFixed(2)} s${it.effects.length ? ` · ${it.effects[0].type.replace(/_/g, " ")}` : ""}` }),
                h("button", { type: "button", class: "re-chip", text: "✕ Never use this moment", onclick: () => { shotMenu.hidden = true; if (key) again({ ask: "drop", value: key }); } }),
                h("button", { type: "button", class: "re-chip", text: "⇄ Swap for another", onclick: () => {
                    shotMenu.hidden = true;
                    const used = new Set(st.edl.timeline.map(momentKey));
                    const next = S().moments(ready()).find((w) => !used.has(w.key));
                    if (next) again({ ask: "pin", value: { index: i, key: next.key } }); else status.textContent = "Every moment is already in the edit.";
                } }),
                h("button", { type: "button", class: "re-chip", text: "Close", onclick: () => { shotMenu.hidden = true; } }));
            void mus;
        }
        /** Which measured moment a shot came from (the window around its source time). */
        function momentKey(it) {
            const ws = S().moments(ready()).filter((w) => w.asset === it.asset_id);
            const w = ws.find((x) => x.kind === "photo" || (it.source_in_s >= x.t0 - 1.3 && it.source_in_s <= x.t1));
            return w ? w.key : null;
        }
        async function again(f) {
            if (!st.brief || st.busy) return;
            st.busy = true;
            if (f.ask === "look" && f.value === "next") {
                const keys = S().PRESET_KEYS, cur = st.edl.project.preset;
                f = { ask: "look", value: keys[(keys.indexOf(cur) + 1) % keys.length] };
            }
            st.brief = S().feedback(st.brief, f);
            if (f.ask === "take") st.seed = st.brief.seed;
            log.replaceChildren();
            step(({ slower: "Slower: longer holds, everything else the same.", faster: "Faster: quicker cuts, everything else the same.", more_fx: "More effects, within the style's limits.", less_fx: "Fewer effects: more restraint.", take: `Another take (take ${st.brief.seed}): same clips, different choices.`, look: `Another look: ${S().PRESETS[st.brief.preset].label}.`, drop: "That moment is out; the rest re-cut around it.", pin: "Swapped that shot; the rest stays." })[f.ask] || "Re-cut.");
            await direct(st.brief, musicFor(st.brief));
            st.busy = false;
        }
        async function exportVideo(how) {
            if (!st.player || st.busy) return;
            st.busy = true;
            for (const b of [saveBtn, shareBtn, playBtn, edlBtn]) b.disabled = true;
            status.textContent = "Making the video… (it plays through once, in real time)";
            try {
                const r = await st.player.record((f) => { status.textContent = `Making the video… ${Math.round(f * 100)}%`; });
                const ext = r.type.includes("mp4") ? "mp4" : "webm";
                const name = `mapunite-summit-cut-${new Date().toISOString().slice(0, 10)}.${ext}`;
                if (how === "share" && W.MUShareOut) {
                    const out = await W.MUShareOut.image({ blob: r.blob, fileName: name, title: "My ride", text: "Made with MapUnite" });
                    status.textContent = W.MUShareOut.said(out) || "Ready.";
                } else if (W.MUShareOut && W.MUShareOut.save) {
                    const out = await W.MUShareOut.save({ blob: r.blob, fileName: name, title: "My ride" });     // the gallery inside the Android app
                    status.textContent = W.MUShareOut.said(out) || `Saved: ${name}`;
                } else {
                    const url = URL.createObjectURL(r.blob), a = document.createElement("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
                    status.textContent = `Saved: ${name}`;
                }
            } catch (e) { status.textContent = "This phone's browser can't record video. Try the MapUnite app or Chrome."; }
            st.busy = false;
            for (const b of [saveBtn, shareBtn, playBtn, edlBtn]) b.disabled = false;
        }
        async function saveEdl() {
            if (!st.edl) return;
            const blob = new Blob([JSON.stringify(st.edl, null, 2)], { type: "application/json" });
            const name = `summit-cut-edl-${new Date().toISOString().slice(0, 10)}.json`;
            if (W.MUShareOut && W.MUShareOut.save) { const r = await W.MUShareOut.save({ blob, fileName: name }); status.textContent = W.MUShareOut.said(r) || `Saved: ${name}`; return; }
            const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
        }

        const rideRow = card ? h("label", { class: "re-ride" }, [
            h("span", { class: "re-ride-ic", "aria-hidden": "true", text: "🏍️" }),
            h("span", { class: "re-ride-tx" }, [h("b", { text: card.title || "Your ride" }), h("small", { text: [card.distance >= 200 ? `${(card.distance / 1000).toFixed(card.distance >= 10000 ? 0 : 1)} km` : "", card.maxSpeed > 0 ? `top ${Math.round(card.maxSpeed * 3.6)} km/h` : "", "in the viewfinder and the sign-off"].filter(Boolean).join(" · ") })]),
            (() => { const c = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", class: "switch", "aria-label": "Put my ride in the edit" })); c.checked = st.withRide; c.addEventListener("change", () => { st.withRide = c.checked; }); return c; })()
        ]) : null;

        root = h("div", { class: "re-modal", role: "dialog", "aria-modal": "true", "aria-label": "Ride Edit" }, [h("div", { class: "re-card" }, [
            h("header", { class: "re-head" }, [
                h("div", {}, [h("h2", { class: "re-title" }, [h("span", { text: "🎬 Ride Edit" }), h("span", { class: "re-badge", text: "Summit Cut" })]),
                    h("p", { class: "re-sub", text: "Give it your photos and clips. It finds the best moments, cuts them on the beat with a hook, a build, a peak and a hero ending, and checks its own edit. Everything stays on your phone." })]),
                h("button", { type: "button", class: "re-x", "aria-label": "Close", text: "✕", onclick: close })
            ]),
            thumbs, fileIn, rideRow, personRow,
            chips("Look", LOOKS, () => prefs.style, (v) => { prefs.style = v; }),
            chips("Length", [[10, "10 s"], [15, "15 s"], [20, "20 s"], [30, "30 s"]], () => prefs.length, (v) => { prefs.length = v; }),
            chips("Format", [["9:16", "Reel 9:16"], ["16:9", "Wide 16:9"]], () => prefs.aspect, (v) => { prefs.aspect = v; }),
            chips("Music", [["preset", "🥁 The look's track"], ["song", "🎵 My song"]], () => prefs.music, (v) => { prefs.music = v; if (v === "song") musicIn.click(); }),
            chips("Director", [["phone", "📱 Agent on the phone"], ["ai", "🤖 AI director (online)"]], () => prefs.director, (v) => { prefs.director = v; }),
            musicIn, wordsIn, goBtn, log, stage, results, feedbackRow, strip, shotMenu, qcBox, status
        ])]);
        root.addEventListener("click", (e) => { if (e.target === root) close(); });
        document.body.append(root);
        requestAnimationFrame(() => root && root.classList.add("in"));
        drawThumbs();
        function close() { if (st.player) st.player.stop(); for (const m of st.media) if (m.url) { try { URL.revokeObjectURL(m.url); } catch (e) { /* gone */ } } if (root) { root.remove(); root = null; } }
        return { close, state: st, addFiles: (files) => { const dt = new DataTransfer(); for (const f of files) dt.items.add(f); fileIn.files = dt.files; fileIn.dispatchEvent(new Event("change")); } };
    }

    return { open };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).RideEdit = RideEdit;
