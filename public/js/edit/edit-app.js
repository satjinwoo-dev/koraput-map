/* ============================================================================
   MapUnite Ride Edit — the editing agent's screen
   ==============================================================================
   RideEdit.open({ card })   from the ride recap ("🎬 Edit a video"), with the
   ride's card (js/share/card-model.js: already trimmed for privacy, real
   figures only), or with no ride at all.
     1. the rider adds photos and videos (they stay on the phone);
     2. picks a look (or lets the agent pick), a length, a format, music
        (the agent's own beat, their own song, or none), optional words;
     3. "Let the agent edit": it watches every clip, says what it found and
        decided, then shows the edit;
     4. Play, Save video, Share, or "Another take" (a new edit from the same
        clips).
   ============================================================================ */
"use strict";

const RideEdit = (() => {
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : null);
    if (!W || !W.document) return {};
    const C = () => W.MUEditCore, E = () => W.MUEditEngine;
    const KEY = "mu.edit.v1";
    const h = (tag, a = {}, kids = []) => {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(a)) {
            if (v == null || v === false) continue;
            if (k === "class") el.className = v; else if (k === "text") el.textContent = v;
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? "" : String(v));
        }
        for (const c of kids) if (c != null && c !== false) el.append(c);
        return el;
    };
    const prefs = (() => { try { return { style: "auto", length: 20, aspect: "story", music: "beat", ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch (e) { return { style: "auto", length: 20, aspect: "story", music: "beat" }; } })();
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ style: prefs.style, length: prefs.length, aspect: prefs.aspect, music: prefs.music })); } catch (e) { /* private mode */ } };
    let root = null;

    /** @param {{ card?: any }} [o] */
    function open(o = {}) {
        if (root) root.remove();
        const card = o.card || null;
        const st = { media: /** @type {any[]} */ ([]), busy: false, seed: 1, player: null, plan: null, music: /** @type {AudioBuffer|null} */ (null), withRide: Boolean(card), words: "" };
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
        const againBtn = h("button", { type: "button", class: "re-b", text: "🔁 Another take", onclick: () => { st.seed++; build(true); } });
        const results = h("div", { class: "re-actions", hidden: true }, [playBtn, saveBtn, shareBtn, againBtn]);
        const chips = (label, opts, get, set) => h("div", { class: "re-row" }, [h("span", { class: "re-lbl", text: label }), h("div", { class: "re-chips", role: "radiogroup", "aria-label": label }, opts.map(([v, t]) => {
            const b = h("button", { type: "button", class: "re-chip", role: "radio", "aria-checked": String(get() === v), text: t, onclick: () => { set(v); for (const x of b.parentElement.children) x.setAttribute("aria-checked", String(x === b)); save(); } });
            return b;
        }))]);
        const wordsIn = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "re-input", maxlength: "60", placeholder: "Optional words, e.g. Koraput to Araku", "aria-label": "Words in the edit" }));
        wordsIn.addEventListener("input", () => { st.words = wordsIn.value; });

        function drawThumbs() {
            thumbs.replaceChildren(...st.media.map((m, i) => h("div", { class: "re-th" }, [
                m.thumb ? h("img", { src: m.thumb, alt: "" }) : h("span", { class: "re-wait", text: "…" }),
                m.kind === "video" ? h("span", { class: "re-dur", text: `${Math.round(m.duration)}s` }) : null,
                h("button", { type: "button", class: "re-rm", "aria-label": `Remove ${m.name}`, text: "✕", onclick: () => { st.media.splice(i, 1); drawThumbs(); } })
            ])), h("button", { type: "button", class: "re-add", onclick: () => fileIn.click() }, [h("span", { text: "＋" }), h("small", { text: st.media.length ? "Add more" : "Add photos & videos" })]));
        }
        fileIn.addEventListener("change", async () => {
            const files = [...(fileIn.files || [])].slice(0, 30 - st.media.length);
            fileIn.value = "";
            for (const f of files) {
                const slot = { name: f.name, kind: /^video/.test(f.type) ? "video" : "photo", thumb: "", duration: 0, pending: true };
                st.media.push(slot); drawThumbs();
                const a = await E().analyze(f);
                const i = st.media.indexOf(slot);
                if (i < 0) continue;
                if (a) st.media[i] = a; else st.media.splice(i, 1);
                drawThumbs();
            }
        });
        musicIn.addEventListener("change", async () => {
            const f = musicIn.files && musicIn.files[0];
            if (!f) return;
            try { const AC = W.AudioContext || W.webkitAudioContext; const ac = new AC(); st.music = await ac.decodeAudioData(await f.arrayBuffer()); ac.close(); status.textContent = `Music: ${f.name}`; } catch (e) { status.textContent = "That song couldn't be read here. Try an MP3 or M4A."; st.music = null; }
        });

        const step = (text) => { const li = h("li", { class: "re-step" }, [h("span", { class: "re-dot", "aria-hidden": "true" }), h("span", { text })]); log.append(li); requestAnimationFrame(() => li.classList.add("in")); return li; };
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        async function runAgent() {
            if (st.busy) return;
            const ready = st.media.filter((m) => !m.pending);
            if (!ready.length && !(card && st.withRide)) { status.textContent = "Add a few photos or clips first (or keep your ride in)."; return; }
            st.busy = true; goBtn.disabled = true; log.replaceChildren(); status.textContent = "";
            const vids = ready.filter((m) => m.kind === "video").length, pics = ready.length - vids;
            step(`Watching ${[vids ? `${vids} clip${vids === 1 ? "" : "s"}` : "", pics ? `${pics} photo${pics === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ") || "your ride"}…`);
            await sleep(450);
            const moments = C().pickMoments(ready);
            if (ready.length) step(`Found ${moments.length} good moment${moments.length === 1 ? "" : "s"}: the sharpest, steadiest, best-lit parts${vids ? ", and where things move" : ""}.`);
            await sleep(450);
            const pick = prefs.style === "auto" ? C().chooseStyle(ready) : { style: prefs.style, why: `${C().STYLES[prefs.style].label}: your choice.` };
            st.style = pick.style;
            step(pick.why);
            await sleep(400);
            if (card && st.withRide) {
                const l = C().storyLines(card, {});
                step(`Your ride goes in: ${[l.title.toLowerCase(), ...l.stats.map((s) => `${s.big} ${s.small}`.toLowerCase())].join(" · ")}${card.route ? ", and the route draws itself" : ""}.`);
                await sleep(400);
            }
            step(`Cutting to ${C().STYLES[st.style].bpm} beats a minute, about ${prefs.length} seconds${prefs.music === "beat" ? ", with the agent's own beat" : prefs.music === "mine" && st.music ? ", to your song" : ""}.`);
            await sleep(300);
            build(false);
            step("Done. Play it, save it, or ask for another take.");
            st.busy = false; goBtn.disabled = false;
        }
        function build(again) {
            if (st.player) st.player.stop();
            const ready = st.media.filter((m) => !m.pending);
            const style = st.style || (prefs.style === "auto" ? C().chooseStyle(ready).style : prefs.style);
            st.plan = C().plan({ media: ready, card: st.withRide ? card : null, style, targetS: prefs.length, aspect: prefs.aspect, seed: st.seed, caption: st.words });
            st.player = E().createPlayer(canvas, st.plan, ready, { card: st.withRide ? card : null, music: prefs.music === "mine" ? st.music : null, beat: prefs.music !== "none" });
            stage.hidden = false; results.hidden = false;
            stage.classList.toggle("wide", prefs.aspect === "wide");
            if (again) { log.replaceChildren(); step(`Another take: same clips, different cuts (take ${st.seed}).`); }
            st.player.play();
        }
        async function exportVideo(how) {
            if (!st.player || st.busy) return;
            st.busy = true;
            for (const b of [saveBtn, shareBtn, againBtn, playBtn]) b.disabled = true;
            status.textContent = "Making the video… (it plays through once, in real time)";
            try {
                const r = await st.player.record((f) => { status.textContent = `Making the video… ${Math.round(f * 100)}%`; });
                const ext = r.type.includes("mp4") ? "mp4" : "webm";
                const name = `mapunite-ride-edit-${new Date().toISOString().slice(0, 10)}.${ext}`;
                if (how === "share" && W.MUShareOut) {
                    const out = await W.MUShareOut.image({ blob: r.blob, fileName: name, title: "My ride", text: "Made with MapUnite" });
                    status.textContent = W.MUShareOut.said(out) || "Ready.";
                } else {
                    const url = URL.createObjectURL(r.blob), a = document.createElement("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
                    status.textContent = `Saved: ${name}`;
                }
                st.lastVideo = r;
            } catch (e) { status.textContent = "This phone's browser can't record video. Try the MapUnite app or Chrome."; }
            st.busy = false;
            for (const b of [saveBtn, shareBtn, againBtn, playBtn]) b.disabled = false;
        }

        const rideRow = card ? h("label", { class: "re-ride" }, [
            h("span", { class: "re-ride-ic", "aria-hidden": "true", text: "🏍️" }),
            h("span", { class: "re-ride-tx" }, [h("b", { text: card.title || "Your ride" }), h("small", { text: [card.distance >= 200 ? `${(card.distance / 1000).toFixed(card.distance >= 10000 ? 0 : 1)} km` : "", card.moving >= 60 ? `${Math.round(card.moving / 60)} min riding` : ""].filter(Boolean).join(" · ") || "Your last ride" })]),
            (() => { const c = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", class: "switch", "aria-label": "Put my ride in the edit" })); c.checked = st.withRide; c.addEventListener("change", () => { st.withRide = c.checked; }); return c; })()
        ]) : h("p", { class: "re-sub", text: "No ride attached: the edit is made from your photos and clips." });

        root = h("div", { class: "re-modal", role: "dialog", "aria-modal": "true", "aria-label": "Ride Edit" }, [h("div", { class: "re-card" }, [
            h("header", { class: "re-head" }, [
                h("div", {}, [h("h2", { class: "re-title" }, [h("span", { text: "🎬 Ride Edit" }), h("span", { class: "re-badge", text: "agent" })]), h("p", { class: "re-sub", text: "Give it your photos and clips from the ride. It watches them, picks the best moments and cuts them to a beat with your ride in it. Everything stays on your phone." })]),
                h("button", { type: "button", class: "re-x", "aria-label": "Close", text: "✕", onclick: close })
            ]),
            thumbs, fileIn, rideRow,
            chips("Look", [["auto", "✨ Agent's pick"], ["cinematic", "🎞 Cinematic"], ["mono", "◐ Mono"], ["kinetic", "Aa Kinetic"]], () => prefs.style, (v) => { prefs.style = v; st.style = null; }),
            chips("Length", [[15, "15 s"], [20, "20 s"], [30, "30 s"], [45, "45 s"]], () => prefs.length, (v) => { prefs.length = v; }),
            chips("Format", [["story", "Story 9:16"], ["wide", "Wide 16:9"]], () => prefs.aspect, (v) => { prefs.aspect = v; }),
            chips("Music", [["beat", "🥁 Agent's beat"], ["mine", "🎵 My song"], ["none", "🔇 None"]], () => prefs.music, (v) => { prefs.music = v; if (v === "mine") musicIn.click(); }),
            musicIn, wordsIn, goBtn, log, stage, results, status
        ])]);
        root.addEventListener("click", (e) => { if (e.target === root) close(); });
        document.body.append(root);
        requestAnimationFrame(() => root && root.classList.add("in"));
        drawThumbs();
        function close() { if (st.player) st.player.stop(); for (const m of st.media) if (m.url) { try { URL.revokeObjectURL(m.url); } catch (e) { /* gone */ } } if (root) { root.remove(); root = null; } }
        return { close, state: st };
    }

    return { open };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).RideEdit = RideEdit;
