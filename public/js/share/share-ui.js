// @ts-check
/* ============================================================================
   MapUnite share — the post-ride share sheet
   ==============================================================================
   MUShare.ui.createShareSheet(root, deps) → { open(summary), close, render }

   Ride Recap Studio. Pops up when a ride ends (or from "Share ride" in the trip
   summary); nothing leaves the phone until the rider taps Share or Save:
     - a live preview of the card (the real canvas, scaled to fit);
     - a style: Lens (refractive liquid glass, the default), Gauge (a glass
       instrument dial), Poster (huge condensed type), Bento (grid of tiles),
       Glass (frosted panels), Verse (comic halftone/glitch) or Minimal;
     - Story (9:16) or Post (4:5);
     - Add photo: picked from the phone, drawn onto the card and never uploaded;
       because it's redrawn, the exported PNG carries none of the photo's EXIF
       (no GPS location, no camera details);
     - a caption (≤ 80 characters);
     - "Map behind the route" (the real map of the line's area, js/share/basemap.js);
     - "Hide where I started and finished" (on by default) with two sliders:
       how much of the start and of the finish is hidden (0 – 3 km, 400 m by
       default; 0 shows the exact point, the rider's choice);
     - "Show the town name" (off by default) and "Show the cost";
     - motion: "Play motion" (the line draws itself, the figures count up, the
       tiles slide in) and "Save motion video" (a ~5 s clip, MP4 where the
       phone records it, else WebM, shared like the image);
     - Share (the system share sheet, with the PNG, where the browser supports
       sharing files), Save image (download), Copy image (clipboard, where
       supported);
     - "Show this after every ride" (remembered on this phone).
   The image is drawn on the phone; nothing is uploaded.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUShare || (/** @type {any} */ (root).MUShare = {}); ns.ui = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const PREFS_KEY = "mu.share.v1";
    /**
     * @template {keyof HTMLElementTagNameMap} K
     * @param {K} tag @param {Record<string, any>} [attrs] @param {Array<Node|string|null|false>} [kids]
     * @returns {HTMLElementTagNameMap[K]}
     */
    function h(tag, attrs = {}, kids = []) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v === undefined || v === null || v === false) continue;
            if (k === "class") el.className = v;
            else if (k === "text") el.textContent = v;
            else if (k === "html") el.innerHTML = v;
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? "" : String(v));
        }
        for (const c of kids) if (c !== null && c !== false) el.append(c);
        return el;
    }
    const ICON = {
        share: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>`,
        save: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>`,
        copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>`,
        x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`
    };

    /** @param {Storage|null} st */
    function loadPrefs(st) {
        const d = { format: "story", template: "lens", privacy: true, trimStart: 400, trimEnd: 400, map: true, showPlace: false, showCost: true, auto: true };
        try {
            const p = JSON.parse((st && st.getItem(PREFS_KEY)) || "{}") || {};
            if (p.format === "post" || p.format === "story") d.format = p.format;
            const t = p.template === "classic" ? "bento" : p.template === "photo" ? "glass" : p.template;   // the old names
            if (["lens", "gauge", "poster", "bento", "glass", "verse", "minimal"].includes(t)) d.template = t;
            for (const k of ["privacy", "map", "showPlace", "showCost", "auto"]) if (typeof p[k] === "boolean") d[k] = p[k];
            for (const k of ["trimStart", "trimEnd"]) if (Number.isFinite(p[k])) d[k] = Math.max(0, Math.min(3000, Math.round(p[k] / 100) * 100));
        } catch { /* defaults */ }
        return d;
    }
    function savePrefs(st, p) { try { if (st) st.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* blocked */ } }

    /** A file name like mapunite-evening-ride-2026-10-04.png @param {any} card */
    function fileName(card) {
        const d = new Date(card.startedAt);
        const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return `mapunite-${card.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${ymd}.png`;
    }

    /**
     * @param {HTMLElement} root
     * @param {{ model: any, render: any, units: any, storage?: Storage|null, onClose?: () => void, nav?: any, fonts?: any, shareOut?: any, styles?: any, basemap?: any }} deps
     *   shareOut: js/passport/share-out.js (the phone's share menu, also inside the Android app)
     */
    function createShareSheet(root, deps) {
        const U = deps.units;
        const storage = deps.storage !== undefined ? deps.storage : (() => { try { return globalThis.localStorage; } catch { return null; } })();
        const nav = deps.nav || (typeof navigator !== "undefined" ? navigator : null);
        const prefs = loadPrefs(storage);
        let summary = null, card = null, blobUrl = null, photo = null, caption = "";
        root.classList.add("sh");

        const canvas = h("canvas", { class: "sh-canvas", role: "img", "aria-label": "Your ride card" });
        const status = h("p", { class: "sh-status", role: "status", "aria-live": "polite" });
        const seg = (items, get, set, label = "Card size") => h("div", { class: "sh-seg", role: "radiogroup", "aria-label": label }, items.map(([v, label]) => h("button", { type: "button", role: "radio", class: "sh-seg-btn", "data-v": v, "aria-checked": String(get() === v), text: label, onclick: (e) => {
            set(v);
            for (const b of /** @type {HTMLElement} */ (e.currentTarget).parentElement.children) b.setAttribute("aria-checked", String(b.getAttribute("data-v") === v));
        } })));
        const toggle = (label, key) => {
            const id = `sh-${key}-${Math.random().toString(36).slice(2, 6)}`;
            const input = h("input", { type: "checkbox", id, class: "switch", onchange: (e) => { prefs[key] = /** @type {HTMLInputElement} */ (e.currentTarget).checked; savePrefs(storage, prefs); if (key === "privacy") syncTrims(); if (key !== "auto") build(); } });
            input.checked = !!prefs[key];
            return h("label", { class: "sh-toggle", for: id }, [h("span", { text: label }), input]);
        };
        const canShareFiles = !!(nav && typeof nav.canShare === "function" && typeof File === "function" && (() => { try { return nav.canShare({ files: [new File([new Blob([""], { type: "image/png" })], "x.png", { type: "image/png" })] }); } catch { return false; } })());
        const canCopy = !!(nav && nav.clipboard && typeof nav.clipboard.write === "function" && typeof globalThis.ClipboardItem === "function");
        const shareOut = deps.shareOut || null;
        const canShare = canShareFiles || Boolean(shareOut && shareOut.available());
        // the rider's photo: read on the phone, drawn onto the card, never stored or uploaded
        const fileIn = /** @type {HTMLInputElement} */ (h("input", { type: "file", accept: "image/*", class: "sh-file", "aria-label": "Choose a photo", onchange: async (e) => {
            const f = /** @type {HTMLInputElement} */ (e.currentTarget).files && /** @type {HTMLInputElement} */ (e.currentTarget).files[0];
            if (!f) return;
            try {
                photo = typeof createImageBitmap === "function" ? await createImageBitmap(f, { imageOrientation: "from-image" }) : await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(f); });
                if (!["verse", "lens", "gauge", "poster"].includes(prefs.template)) prefs.template = "lens";
                savePrefs(storage, prefs); syncTemplate(); build();
                photoBtn.textContent = "Change photo"; removeBtn.hidden = false;
            } catch { status.textContent = "Couldn't read that photo."; }
            fileIn.value = "";
        } }));
        const photoBtn = h("button", { type: "button", class: "sh-btn-ghost", text: "Add photo", onclick: () => fileIn.click() });
        const removeBtn = h("button", { type: "button", class: "sh-btn-ghost", text: "Remove photo", hidden: true, onclick: () => { photo = null; photoBtn.textContent = "Add photo"; removeBtn.hidden = true; build(); } });
        const captionIn = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "sh-caption", maxlength: "80", placeholder: "Add a caption (optional)", "aria-label": "Caption", oninput: (e) => { caption = /** @type {HTMLInputElement} */ (e.currentTarget).value; build(); } }));
        const templates = seg([["lens", "Lens"], ["gauge", "Gauge"], ["poster", "Poster"], ["bento", "Bento"], ["glass", "Glass"], ["verse", "Verse"], ["minimal", "Minimal"]], () => prefs.template, (v) => {
            prefs.template = v; savePrefs(storage, prefs);
            build();
        }, "Card style");
        // where the line starts and ends: the rider moves each end (0 m = exactly where the ride began / ended)
        const trimText = (/** @type {number} */ m, /** @type {string} */ which) => (m === 0 ? `${which}: shown exactly where it was` : `${which}: first ${m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`} hidden`.replace("first", which === "Finish" ? "last" : "first"));
        const slider = (/** @type {"trimStart"|"trimEnd"} */ key, /** @type {string} */ which) => {
            const out = h("span", { class: "sh-trim-v", text: trimText(prefs[key], which) });
            const input = /** @type {HTMLInputElement} */ (h("input", { type: "range", min: "0", max: "3000", step: "100", class: "sh-range", "aria-label": `${which}: metres hidden`, oninput: (e) => {
                prefs[key] = Number(/** @type {HTMLInputElement} */ (e.currentTarget).value); out.textContent = trimText(prefs[key], which);
                savePrefs(storage, prefs); build();
            } }));
            input.value = String(prefs[key]);
            return h("label", { class: "sh-trim" }, [out, input]);
        };
        const trims = h("div", { class: "sh-trims" }, [slider("trimStart", "Start"), slider("trimEnd", "Finish")]);
        const syncTrims = () => { trims.hidden = !prefs.privacy; };
        // motion: the line draws itself, the figures count up, the tiles slide in — preview it, or save it as a clip
        const canRecord = typeof canvas.captureStream === "function" && typeof globalThis.MediaRecorder === "function";
        const playBtn = h("button", { type: "button", class: "sh-btn-ghost", text: "▶ Play motion", onclick: () => play() });
        const videoBtn = h("button", { type: "button", class: "sh-btn-ghost", text: "Save motion video", hidden: !canRecord, onclick: () => record() });
        // Ride Edit (js/edit/): the editing agent makes a reel from the rider's own photos and clips, with this ride in it
        const editBtn = h("button", { type: "button", class: "sh-btn", text: "🎬 Edit a video with my clips", hidden: !canRecord, onclick: () => { if (globalThis.RideEdit && globalThis.RideEdit.open) globalThis.RideEdit.open({ card }); } });
        // Ride Story (js/story/): the whole ride as a moving dashboard, when the riding dashboard recorded it
        const storyId = () => (summary && summary.trip && Number(summary.trip.startedAt)) || (card && card.startedAt) || 0;
        const storyBtn = h("button", { type: "button", class: "sh-btn sh-story", text: "📊 Full ride story", hidden: true, onclick: () => { const RS = /** @type {any} */ (globalThis).RideStory; if (RS && RS.open) { close(); RS.open(storyId()); } } });
        const syncTemplate = () => { for (const b of templates.children) b.setAttribute("aria-checked", String(b.getAttribute("data-v") === prefs.template)); };
        const actions = h("div", { class: "sh-actions" }, [
            canShare && !canShareFiles ? h("button", { type: "button", class: "sh-btn", onclick: share }, [h("span", { class: "sh-i", "aria-hidden": "true", html: ICON.share }), "Share"]) : null,
            canShareFiles ? h("button", { type: "button", class: "sh-btn", onclick: share }, [h("span", { class: "sh-i", "aria-hidden": "true", html: ICON.share }), "Share"]) : null,
            h("button", { type: "button", class: canShare ? "sh-btn-ghost" : "sh-btn", onclick: save }, [h("span", { class: "sh-i", "aria-hidden": "true", html: ICON.save }), "Save image"]),
            canCopy ? h("button", { type: "button", class: "sh-btn-ghost", onclick: copy }, [h("span", { class: "sh-i", "aria-hidden": "true", html: ICON.copy }), "Copy"]) : null
        ]);
        root.replaceChildren(
            h("header", { class: "sh-head" }, [
                h("div", {}, [h("h2", { class: "sh-title", text: "Ride recap" }), h("p", { class: "sh-sub", text: "Made on your phone. Nothing is uploaded or posted until you share it." })]),
                h("button", { type: "button", class: "sh-close", "aria-label": "Close", html: ICON.x, onclick: () => close() })
            ]),
            h("div", { class: "sh-body" }, [
                h("div", { class: "sh-preview" }, [canvas]),
                h("div", { class: "sh-side" }, [
                    templates,
                    seg([["story", "Story 9:16"], ["post", "Post 4:5"]], () => prefs.format, (v) => { prefs.format = v; savePrefs(storage, prefs); build(); }),
                    h("div", { class: "sh-photo" }, [photoBtn, removeBtn, fileIn]),
                    h("p", { class: "sh-sub", text: "Your photo is redrawn onto the card, so its location data isn't in the image." }),
                    captionIn,
                    h("div", { class: "sh-opts" }, [toggle("Map behind the route", "map"), toggle("Hide where I started and finished", "privacy"), trims, toggle("Show the town name", "showPlace"), toggle("Show the cost", "showCost"), toggle("Show this after every ride", "auto")]),
                    h("div", { class: "sh-photo" }, [playBtn, videoBtn]),
                    editBtn, storyBtn,
                    actions, status
                ])
            ])
        );

        let token = 0, map = null, anim = 0;
        const drawOpts = (/** @type {number|undefined} */ t = undefined) => ({ template: prefs.template, format: prefs.format, showCost: prefs.showCost, units: U, photo, map, t });
        const paint = (/** @type {number|undefined} */ t = undefined) => {
            const draw = typeof deps.render.drawTemplate === "function" ? deps.render.drawTemplate : deps.render.drawCard;
            draw(canvas, card, drawOpts(t));
        };
        async function build() {
            if (!summary) return;
            const my = ++token;
            if (anim) { cancelAnimationFrame(anim); anim = 0; }
            card = deps.model.buildCard(summary, { privacy: prefs.privacy, trimStart: prefs.trimStart, trimEnd: prefs.trimEnd, showPlace: prefs.showPlace, caption });
            if (deps.fonts && typeof deps.fonts.load === "function") {
                try { await Promise.race([Promise.all(["800 80px Sora", "700 40px Sora", "500 30px Inter", "700 24px Inter", "200 100px Inter", "300 40px Inter", "400 100px Anton"].map((f) => deps.fonts.load(f))), new Promise((r) => setTimeout(r, 1200))]); } catch { /* system fonts */ }
            }
            if (my !== token) return;
            // the real map behind the line: only the area of the (trimmed) line, fetched once and cached
            map = null;
            const ST = deps.styles || /** @type {any} */ (globalThis).MUShare && /** @type {any} */ (globalThis).MUShare.styles;
            const BM = deps.basemap || /** @type {any} */ (globalThis).MUShare && /** @type {any} */ (globalThis).MUShare.basemap;
            const spec = prefs.map && ST && BM && card.routeGeo && card.routeGeo.length > 1 ? ST.mapSpec(prefs.template, prefs.format, Boolean(photo)) : null;
            if (spec) {
                paint();                                                   // the card at once, the map when it's in
                status.textContent = "Loading the map…";
                try { map = await BM.render(card.routeGeo, spec.w, spec.h, spec); } catch { map = null; }
                if (my !== token) return;
                status.textContent = map ? "" : "Map not available offline here: the line is shown on its own.";
            } else status.textContent = "";
            paint();
            canvas.dataset.format = prefs.format;
            canvas.setAttribute("aria-label", `${card.title}: ${U.num(card.distance / 1000, 1)} km${card.ecoScore !== null ? `, eco score ${Math.round(card.ecoScore * 100)}` : ""}${card.saved ? `, ${U.num(card.saved.share * 100, 0)} % less fuel than usual` : ""}`);
        }

        const MOTION_MS = 4200, HOLD_MS = 900;
        /** The motion on the preview: about 4 s, then it rests on the finished card. @param {((t: number) => void)|null} [onFrame] */
        function play(onFrame = null) {
            if (!card) return Promise.resolve();
            if (anim) cancelAnimationFrame(anim);
            return new Promise((resolve) => {
                const t0 = performance.now();
                const step = (now) => {
                    const t = (now - t0) / MOTION_MS;
                    paint(Math.min(1, t));
                    if (onFrame) onFrame(t);
                    if (now - t0 < MOTION_MS + HOLD_MS) anim = requestAnimationFrame(step);
                    else { anim = 0; paint(); resolve(undefined); }
                };
                anim = requestAnimationFrame(step);
            });
        }
        /** Record the motion as a short clip (MP4 where the phone can, else WebM) and share or save it. */
        async function record() {
            if (!canRecord || !card) return;
            const types = ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
            const mime = types.find((x) => { try { return globalThis.MediaRecorder.isTypeSupported(x); } catch { return false; } }) || "";
            let rec;
            try { rec = new globalThis.MediaRecorder(canvas.captureStream(30), mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : undefined); } catch { status.textContent = "This phone can't record the motion."; return; }
            const chunks = [];
            rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
            const done = new Promise((r) => { rec.onstop = r; });
            videoBtn.disabled = true; playBtn.disabled = true;
            status.textContent = "Recording the motion…";
            rec.start(250);
            await play();
            rec.stop();
            await done;
            videoBtn.disabled = false; playBtn.disabled = false;
            const type = (rec.mimeType || mime || "video/webm").split(";")[0];
            const blob = new Blob(chunks, { type });
            const name = fileName(card).replace(/\.png$/, type === "video/mp4" ? ".mp4" : ".webm");
            if (shareOut) {
                const r = await shareOut.image({ blob, fileName: name, title: card.title, text: `${card.title} · ${U.num(card.distance / 1000, 1)} km with MapUnite` });
                status.textContent = shareOut.said(r) + (type === "video/webm" ? " (WebM: some apps want MP4)" : "");
            } else {
                const url = URL.createObjectURL(blob);
                const a = h("a", { href: url, download: name }); document.body.append(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 4000);
                status.textContent = "Saved to your downloads.";
            }
        }
        const toBlob = () => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make the image"))), "image/png"));

        async function share() {
            if (shareOut && !canShareFiles) {
                try { const r = await shareOut.image({ blob: /** @type {Blob} */ (await toBlob()), fileName: fileName(card), title: card.title, text: `${card.title} · ${U.num(card.distance / 1000, 1)} km with MapUnite` }); status.textContent = shareOut.said(r); } catch { status.textContent = "Sharing didn't work here."; }
                return;
            }
            try {
                const blob = await toBlob();
                const file = new File([/** @type {Blob} */ (blob)], fileName(card), { type: "image/png" });
                await nav.share({ files: [file], title: card.title, text: `${card.title} · ${U.num(card.distance / 1000, 1)} km with MapUnite` });
                status.textContent = "Shared.";
            } catch (e) { if (/** @type {any} */ (e).name !== "AbortError") { status.textContent = "Sharing didn't work here. Saving the image instead."; save(); } }
        }
        async function save() {
            try {
                const blob = await toBlob();
                if (blobUrl) URL.revokeObjectURL(blobUrl);
                blobUrl = URL.createObjectURL(/** @type {Blob} */ (blob));
                const a = h("a", { href: blobUrl, download: fileName(card) });
                document.body.append(a); a.click(); a.remove();
                status.textContent = "Saved to your downloads.";
            } catch (e) { status.textContent = /** @type {Error} */ (e).message; }
        }
        async function copy() {
            try {
                const blob = await toBlob();
                await nav.clipboard.write([new globalThis.ClipboardItem({ "image/png": blob })]);
                status.textContent = "Copied. Paste it into any app.";
            } catch { status.textContent = "Copying images isn't allowed here. Use Save image."; }
        }

        function open(s) {
            if (s !== summary) { caption = ""; captionIn.value = ""; photo = null; photoBtn.textContent = "Add photo"; removeBtn.hidden = true; syncTemplate(); }
            syncTrims();
            summary = s;
            try { const RS = /** @type {any} */ (globalThis).RideStory; storyBtn.hidden = !(RS && RS.has && RS.has(storyId())); } catch { storyBtn.hidden = true; }
            root.hidden = false;
            build();
            const c = root.querySelector(".sh-close"); if (c) /** @type {HTMLElement} */ (c).focus();
        }
        function close() { if (anim) { cancelAnimationFrame(anim); anim = 0; } root.hidden = true; if (deps.onClose) deps.onClose(); }

        return { open, close, render: build, play, record, get card() { return card; }, get prefs() { return prefs; }, get map() { return map; }, canvas };
    }

    return { PREFS_KEY, loadPrefs, fileName, createShareSheet };
});
