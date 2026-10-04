// @ts-check
/* ============================================================================
   MapUnite curator — the admin tool for riders' "add my bike" requests
   ==============================================================================
   MUCurator.app.mount(root, { contract, search, physics, units, silhouettes,
                               draftLib, apiLib, catalog, loadBundle, storage })

   The queue on the left (requests, most-asked first, with the class the rider
   picked); on the right, one request at a time:
     1. Is it already in the catalogue? Likely matches from the same search the
        app uses; "Same bike" closes the request as a duplicate.
     2. The data file, as a form generated from the contract: identity, picture
        (https only, with a live preview), sources, every value in its published
        unit with its source and confidence, fuel approvals.
     3. Live checks while typing: the contract's own validator (errors block
        approval, warnings don't) and the physics preview — km/L (Wh/km) at 40,
        60 and 80 km/h against the class default, the eco band, the physics' top
        speed against the published one, and range on a tank / charge.
     4. Approve (server re-validates, writes data/bikes/variants or pending/,
        rebuilds), Save draft, Download JSON, Reject (with a reason the rider
        never sees), Same bike.
   Drafts are also kept in this browser so nothing typed is lost.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUCurator || (/** @type {any} */ (root).MUCurator = {}); ns.app = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const DRAFTS_KEY = "mu.curator.drafts.v1";
    const SVG_NS = "http://www.w3.org/2000/svg";
    /**
     * @template {keyof HTMLElementTagNameMap} K
     * @param {K} tag @param {Record<string, any>} [attrs] @param {Array<Node|string|null|false|undefined>} [kids]
     * @returns {HTMLElementTagNameMap[K]}
     */
    function h(tag, attrs = {}, kids = []) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v === undefined || v === null || v === false) continue;
            if (k === "class") el.className = v;
            else if (k === "text") el.textContent = v;
            else if (k === "html") el.innerHTML = v;                 // static, trusted markup only (icons, silhouettes)
            else if (k === "style") el.setAttribute("style", v);
            else if (k === "value") /** @type {any} */ (el).value = v;
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? "" : String(v));
        }
        for (const c of kids) if (c !== null && c !== false && c !== undefined) el.append(c);
        return el;
    }
    function s(tag, attrs = {}) { const el = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v)); return el; }
    const ago = (ts) => { const m = Math.max(0, Math.round((Date.now() - ts) / 60000)); return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
    const today = () => new Date().toISOString().slice(0, 10);
    const ICON = {
        check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`,
        alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5M12 18h.01"/></svg>`,
        x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
        plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
        search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`
    };

    /**
     * @param {HTMLElement} root
     * @param {{ contract: any, search: any, physics: any, units: any, silhouettes?: any, draftLib: any, apiLib: any,
     *   catalog: () => Promise<any>, loadBundle: (hash: string) => Promise<any>, storage?: Storage|null, apiBase?: string }} deps
     */
    function mount(root, deps) {
        const C = deps.contract, D = deps.draftLib, U = deps.units;
        const storage = deps.storage !== undefined ? deps.storage : (() => { try { return globalThis.localStorage; } catch { return null; } })();
        const session = (() => { try { return globalThis.sessionStorage; } catch { return null; } })();
        let api = deps.apiLib.createLocalApi(storage);
        let index = null, ref = null, requests = [], tab = "queued", query = "", selected = null, draft = null, result = null, pv = null;
        const classRt = new Map();
        let validateTimer = null, saveTimer = null;
        root.classList.add("cu");

        // ---------------- drafts kept in this browser ----------------
        const readDrafts = () => { try { const o = JSON.parse((storage && storage.getItem(DRAFTS_KEY)) || "{}"); return o && typeof o === "object" ? o : {}; } catch { return {}; } };
        const writeDraft = (id, d) => { const o = readDrafts(); if (d) o[id] = { at: Date.now(), draft: d }; else delete o[id]; try { if (storage) storage.setItem(DRAFTS_KEY, JSON.stringify(o)); } catch { /* full */ } };

        // ---------------- shell ----------------
        const conn = h("span", { class: "cu-conn", role: "status" });
        const tokenIn = h("input", { class: "cu-input cu-token", type: "password", placeholder: "Admin token", autocomplete: "off", "aria-label": "Admin token" });
        const fileIn = h("input", { type: "file", accept: "application/json,.json", hidden: true, onchange: importFile });
        const top = h("header", { class: "cu-top" }, [
            h("div", { class: "cu-brand" }, [h("span", { class: "cu-dot", "aria-hidden": "true" }), h("strong", { text: "MapUnite" }), h("span", { text: "Bike curator" })]),
            conn,
            h("form", { class: "cu-connect", onsubmit: (e) => { e.preventDefault(); connect(tokenIn.value.trim()); } }, [tokenIn, h("button", { type: "submit", class: "cu-btn-ghost", text: "Connect" })]),
            h("button", { type: "button", class: "cu-btn-ghost", text: "Import requests…", onclick: () => fileIn.click() }), fileIn
        ]);
        const listEl = h("div", { class: "cu-list", role: "listbox", "aria-label": "Requests" });
        const tabsEl = h("div", { class: "cu-tabs", role: "tablist" });
        const searchIn = h("input", { class: "cu-input", type: "search", placeholder: "Filter requests", "aria-label": "Filter requests", oninput: () => { query = searchIn.value.trim().toLowerCase(); renderList(); } });
        const side = h("aside", { class: "cu-side" }, [tabsEl, h("div", { class: "cu-search" }, [h("span", { class: "cu-i", "aria-hidden": "true", html: ICON.search }), searchIn]), listEl]);
        const main = h("main", { class: "cu-main" });
        root.replaceChildren(top, h("div", { class: "cu-layout" }, [side, main]));

        // ---------------- connect / load ----------------
        async function connect(token) {
            const base = deps.apiBase !== undefined ? deps.apiBase : location.origin;
            if (token) { try { if (session) session.setItem("mu.curator.token", token); } catch { /* blocked */ } }
            const server = deps.apiLib.createCuratorApi({ base, token: token || null });
            setConn("busy", "Connecting…");
            try {
                requests = await server.list("all");
                api = server;
                setConn("ok", "Connected");
                try { ref = await server.reference(); } catch { ref = null; }
            } catch (e) {
                api = deps.apiLib.createLocalApi(storage);
                requests = await api.list("all");
                try { ref = await api.reference(); } catch { ref = null; }
                setConn("off", `Offline mode · ${/** @type {Error} */ (e).message}`);
            }
            renderAll();
        }
        function setConn(kind, text) { conn.dataset.kind = kind; conn.textContent = text; }
        async function importFile() {
            const f = fileIn.files && fileIn.files[0];
            if (!f) return;
            try {
                const json = JSON.parse(await f.text());
                const local = api.mode === "local" ? api : deps.apiLib.createLocalApi(storage);
                const n = local.importJson(json);
                if (api.mode === "local") { requests = await api.list("all"); try { ref = await api.reference(); } catch { /* none */ } }
                setConn(api.mode === "local" ? "off" : "ok", `${api.mode === "local" ? "Offline mode" : "Connected"} · imported ${n} request${n === 1 ? "" : "s"}`);
                renderAll();
            } catch (e) { setConn("err", `Couldn't read that file: ${/** @type {Error} */ (e).message}`); }
            fileIn.value = "";
        }

        // ---------------- list ----------------
        const TABS = [["queued", "Queued"], ["drafted", "Drafts"], ["done", "Done"]];
        const inTab = (r) => (tab === "done" ? ["approved", "rejected", "duplicate"].includes(r.status) : r.status === tab || (tab === "queued" && !r.status));
        function renderAll() { renderList(); if (selected) select(selected.id, true); else renderEmpty(); }
        function renderList() {
            const drafts = readDrafts();
            tabsEl.replaceChildren(...TABS.map(([k, label]) => {
                const n = requests.filter((r) => (k === "done" ? ["approved", "rejected", "duplicate"].includes(r.status) : (r.status || "queued") === k || (k === "drafted" && drafts[r.id] && (r.status || "queued") === "queued"))).length;
                return h("button", { type: "button", role: "tab", class: "cu-tab", "aria-selected": String(tab === k), onclick: () => { tab = k; renderList(); } }, [label, h("span", { class: "cu-count", text: String(n) })]);
            }));
            const rows = requests.filter((r) => (tab === "drafted" ? (r.status === "drafted" || (drafts[r.id] && (r.status || "queued") === "queued")) : inTab(r)))
                .filter((r) => !query || r.description.toLowerCase().includes(query));
            listEl.replaceChildren(...(rows.length ? rows.map((r) => h("button", {
                type: "button", role: "option", class: `cu-item${selected && selected.id === r.id ? " is-on" : ""}`, "aria-selected": String(!!(selected && selected.id === r.id)), "data-id": r.id,
                onclick: () => select(r.id)
            }, [
                h("span", { class: "cu-item-t", text: r.description }),
                h("span", { class: "cu-item-m" }, [
                    r.classKey && index ? h("span", { class: "cu-chip", text: (index.classes.find((c) => c.key === r.classKey) || { title: r.classKey }).title }) : null,
                    h("span", { text: `${r.count > 1 ? `asked ${r.count}× · ` : ""}${ago(r.createdAt)}` }),
                    drafts[r.id] ? h("span", { class: "cu-chip is-draft", text: "draft" }) : null,
                    r.status && r.status !== "queued" && r.status !== "drafted" ? h("span", { class: `cu-chip is-${r.status}`, text: r.status }) : null
                ])
            ])) : [h("p", { class: "cu-muted cu-list-empty", text: requests.length ? "Nothing here." : "No requests yet. Connect to the server, or import a requests file." })]));
        }
        function renderEmpty() {
            main.replaceChildren(h("div", { class: "cu-empty" }, [
                h("h2", { text: "Pick a request" }),
                h("p", { text: "Riders ask for bikes that aren't in the catalogue from the bike picker. Each request becomes a reviewed data file: sourced, in published units, checked by the same validator as the build, and previewed through the physics before it ships." }),
                h("p", { class: "cu-muted", text: "Keys: J / K next and previous request, Ctrl+S save draft." })
            ]));
        }

        // ---------------- one request ----------------
        async function select(id, keepDraft = false) {
            const r = requests.find((x) => x.id === id);
            if (!r) return;
            selected = r;
            renderList();
            const saved = readDrafts()[id];
            if (!keepDraft || !draft) draft = (saved && saved.draft) || r.draft || D.newDraft(C, r, index ? index.makes || [...new Set(index.rows.map((x) => x.make))] : [], today());
            await ensureClass(draft.classKey);
            renderDetail();
            revalidate(true);
        }
        async function ensureClass(key) {
            if (classRt.has(key) || !index) return classRt.get(key);
            const cls = index.classes.find((c) => c.key === key);
            const b = cls ? await deps.loadBundle(cls.bundle).catch(() => null) : null;
            classRt.set(key, b);
            return b;
        }

        const fieldRows = new Map();          // path → { row, msg }
        let railEl = null, railChecks = null, railPhys = null, approveBtn = null, jsonPre = null;

        function renderDetail() {
            fieldRows.clear();
            const r = selected;
            const matches = index ? index.search(r.description, { limit: 5 }) : [];
            const header = h("section", { class: "cu-req" }, [
                h("div", { class: "cu-req-main" }, [
                    h("p", { class: "cu-kicker", text: `Request · ${r.count > 1 ? `asked ${r.count} times · ` : ""}first ${ago(r.createdAt)}` }),
                    h("h1", { class: "cu-req-t", text: `“${r.description}”` }),
                    r.classKey ? h("p", { class: "cu-muted", text: `The rider picked the closest type: ${index ? (index.classes.find((c) => c.key === r.classKey) || { title: r.classKey }).title : r.classKey}` }) : null
                ]),
                h("div", { class: "cu-matches" }, [
                    h("h2", { class: "cu-h", text: matches.length ? "Already in the catalogue?" : "No close match in the catalogue" }),
                    ...matches.map((m) => h("div", { class: "cu-match" }, [
                        deps.silhouettes ? h("span", { class: "cu-sil", "aria-hidden": "true", html: deps.silhouettes.silhouette(m.classKey) }) : null,
                        h("span", { class: "cu-match-t" }, [h("strong", { text: `${m.make} ${m.model}` }), h("span", { text: [m.variant, U.size(m), U.years(m)].filter(Boolean).join(" · ") })]),
                        h("button", { type: "button", class: "cu-btn-ghost cu-sm", text: "Same bike", onclick: () => resolveDuplicate(m) })
                    ]))
                ])
            ]);
            const sections = h("div", { class: "cu-form" });
            sections.append(identitySection(), pictureSection(), sourcesSection());
            for (const sec of D.formSections(C, draft.powertrain)) sections.append(valuesSection(sec));
            sections.append(notesSection(), reviewSection());
            railChecks = h("div", { class: "cu-checks", "aria-live": "polite" });
            railPhys = h("div", { class: "cu-phys" });
            approveBtn = h("button", { type: "button", class: "cu-btn", text: api.mode === "local" ? "Approve & download" : "Approve", onclick: approve });
            railEl = h("aside", { class: "cu-rail", "aria-label": "Checks" }, [
                h("div", { class: "cu-rail-card" }, [h("h2", { class: "cu-h", text: "Checks" }), railChecks]),
                h("div", { class: "cu-rail-card" }, [h("h2", { class: "cu-h", text: "Physics preview" }), railPhys]),
                h("div", { class: "cu-rail-actions" }, [
                    approveBtn,
                    h("div", { class: "cu-row-btns" }, [
                        h("button", { type: "button", class: "cu-btn-ghost", text: "Save draft", onclick: () => saveDraft(true) }),
                        h("button", { type: "button", class: "cu-btn-ghost", text: "Download JSON", onclick: download })
                    ]),
                    h("details", { class: "cu-reject" }, [
                        h("summary", { class: "cu-btn-danger", text: "Reject…" }),
                        h("form", { class: "cu-reject-form", onsubmit: (e) => { e.preventDefault(); reject(/** @type {HTMLTextAreaElement} */ (e.currentTarget.querySelector("textarea")).value); } }, [
                            h("label", { class: "cu-label", for: "cu-reject-why", text: "Why? (kept for the team; the rider doesn't see it)" }),
                            h("textarea", { id: "cu-reject-why", class: "cu-input", rows: "2", required: true, placeholder: "Not sold in India · not a two-wheeler · not enough information" }),
                            h("button", { type: "submit", class: "cu-btn-danger", text: "Reject this request" })
                        ])
                    ])
                ])
            ]);
            main.replaceChildren(header, h("div", { class: "cu-work" }, [sections, railEl]));
        }

        // ---------------- sections ----------------
        function section(title, id, kids, hint) {
            return h("section", { class: "cu-sec", id: `cu-sec-${id}`, "aria-labelledby": `cu-h-${id}` }, [h("h2", { class: "cu-h", id: `cu-h-${id}`, text: title }), hint ? h("p", { class: "cu-hint", text: hint }) : null, ...kids]);
        }
        function textRow(label, value, onInput, o = {}) {
            const id = `cu-f-${Math.random().toString(36).slice(2, 8)}`;
            const input = o.select
                ? h("select", { id, class: "cu-input", onchange: (e) => onInput(e.currentTarget.value) }, o.select.map(([v, t]) => h("option", { value: v, text: t, selected: String(v) === String(value) })))
                : h("input", { id, class: "cu-input", type: o.type || "text", value: value ?? "", placeholder: o.placeholder || "", inputmode: o.inputmode, list: o.list, oninput: (e) => onInput(e.currentTarget.value) });
            const row = h("div", { class: "cu-field" }, [h("label", { for: id, class: "cu-label", text: label }), input, o.help ? h("p", { class: "cu-help", text: o.help }) : null, h("p", { class: "cu-msg", hidden: true })]);
            if (o.path) fieldRows.set(o.path, { row, msg: /** @type {HTMLElement} */ (row.querySelector(".cu-msg")) });
            return row;
        }
        function identitySection() {
            const idn = draft.identity;
            const classes = index ? index.classes.map((c) => [c.key, `${c.title} (${c.key})`]) : [[draft.classKey, draft.classKey]];
            const idOut = h("code", { class: "cu-id", text: draft.id || "–" });
            const set = (k, v) => { idn[k] = v; draft.id = D.slugId(idn); idOut.textContent = draft.id || "–"; changed(); };
            const yearN = (v) => (v === "" ? null : Number(v));
            return section("Identity", "identity", [
                h("div", { class: "cu-grid2" }, [
                    textRow("Make", idn.make, (v) => set("make", v), { path: "identity.make" }),
                    textRow("Model", idn.model, (v) => set("model", v), { path: "identity.model" }),
                    textRow("Variant", idn.variant, (v) => set("variant", v), { path: "identity.variant", placeholder: "e.g. Street, 2023 (OBD-2B)" }),
                    textRow("Market", idn.market, (v) => set("market", v.toUpperCase()), { path: "identity.market", placeholder: "IN" }),
                    textRow("On sale from (year)", idn.yearFrom, (v) => set("yearFrom", yearN(v)), { path: "identity.yearFrom", inputmode: "numeric" }),
                    textRow("Until (year, empty if on sale)", idn.yearTo ?? "", (v) => set("yearTo", yearN(v)), { path: "identity.yearTo", inputmode: "numeric" }),
                    textRow("Also called (comma-separated)", (idn.aliases || []).join(", "), (v) => { idn.aliases = v.split(",").map((x) => x.trim()).filter(Boolean); changed(); }, { path: "identity.aliases" }),
                    textRow("Class", draft.classKey, async (v) => {
                        const [pt, seg] = v.split(".");
                        const ptChanged = pt !== draft.powertrain;
                        draft.classKey = v; draft.powertrain = pt; draft.segment = seg;
                        if (ptChanged) { draft.transmission = { kind: { v: C.TRANSMISSION_FOR[pt] } }; for (const g of ["engine", "motor", "battery", "emission"]) delete draft[g]; if (pt === "ev") delete draft.fuel; else draft.fuel = draft.fuel || { compat: [] }; }
                        await ensureClass(v);
                        renderDetail(); revalidate(true);
                    }, { select: classes, path: "classKey" })
                ]),
                h("p", { class: "cu-help" }, ["File: ", h("code", { text: "data/bikes/variants/" }), idOut, h("code", { text: ".json" })])
            ]);
        }
        function sourceSelect(value, onChange) {
            return h("select", { class: "cu-input cu-src", "aria-label": "Source", onchange: (e) => onChange(e.currentTarget.value) }, [
                h("option", { value: "", text: "source…" }),
                ...draft.sources.map((x) => h("option", { value: x.id, text: x.id, selected: x.id === value }))
            ]);
        }
        function confInput(value, onChange) {
            return h("input", { class: "cu-input cu-conf", type: "number", min: "0", max: "1", step: "0.05", value: Number.isFinite(value) ? String(value) : "", placeholder: "conf", "aria-label": "Confidence (0 to 1)", oninput: (e) => onChange(e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value)) });
        }
        function pictureSection() {
            const img = draft.image || {};
            const prev = h("div", { class: "cu-pic" }, [deps.silhouettes ? h("span", { class: "cu-sil cu-sil-lg", "aria-hidden": "true", html: deps.silhouettes.silhouette(draft.classKey) }) : null]);
            const info = h("p", { class: "cu-help" });
            const showPrev = (url) => {
                prev.querySelectorAll("img").forEach((x) => x.remove());
                prev.classList.remove("has-photo");
                info.textContent = "";
                if (!url) return;
                if (!/^https:\/\//.test(url)) { info.textContent = "Must be an https URL (the app's pages are https)."; return; }
                const im = h("img", { src: url, alt: "", referrerpolicy: "no-referrer", decoding: "async" });
                im.addEventListener("load", () => { prev.classList.add("has-photo"); info.textContent = `${im.naturalWidth} × ${im.naturalHeight}${im.naturalWidth < im.naturalHeight ? " · portrait: the picker shows landscape best" : ""}${im.naturalWidth < 480 ? " · small: 640 px wide or more looks sharper" : ""}`; });
                im.addEventListener("error", () => { info.textContent = "This picture didn't load (wrong URL, or the host blocks hot-linking)."; im.remove(); });
                prev.append(im);
            };
            const setImg = (k, v) => {
                const cur = draft.image || {};
                cur[k] = v || undefined;
                if (!cur.url) delete draft.image; else draft.image = Object.fromEntries(Object.entries(cur).filter(([, x]) => x !== undefined && x !== ""));
                if (k === "url") showPrev(v);
                changed();
            };
            const urlRow = textRow("Picture URL (https)", img.url || "", (v) => setImg("url", v.trim()), { path: "image.url", placeholder: "https://cdn…/bike.webp", type: "url" });
            const srcRow = h("div", { class: "cu-field" }, [h("span", { class: "cu-label", text: "Picture source" }), sourceSelect(img.src || "", (v) => setImg("src", v))]);
            fieldRows.set("image.src", { row: srcRow, msg: srcRow.appendChild(h("p", { class: "cu-msg", hidden: true })) });
            const sec = section("Picture", "picture", [h("div", { class: "cu-pic-row" }, [prev, h("div", { class: "cu-pic-fields" }, [urlRow, srcRow, textRow("Credit (if the publisher asks)", img.credit || "", (v) => setImg("credit", v), { path: "image.credit" }), info])])], "Required to approve. Becomes image_url in the catalogue, so the picker shows the real bike straight away. Use pictures you're licensed to use, ideally on your own CDN.");
            showPrev(img.url || "");
            return sec;
        }
        function sourcesSection() {
            const list = h("div", { class: "cu-sources" });
            const draw = () => {
                list.replaceChildren(...draft.sources.map((src, i) => {
                    const upd = (k, v) => {
                        src[k] = v || undefined;
                        if (k === "title" || k === "publisher") { const old = src.id; src.id = D.sourceId(src, draft.sources.filter((x) => x !== src).map((x) => x.id)); if (old !== src.id) renameSource(old, src.id); }
                        Object.keys(src).forEach((kk) => src[kk] === undefined && delete src[kk]);
                        changed();
                    };
                    const row = h("div", { class: "cu-source" }, [
                        h("div", { class: "cu-source-top" }, [
                            h("select", { class: "cu-input", "aria-label": "Kind", onchange: (e) => upd("kind", e.currentTarget.value) }, C.SOURCE_KINDS.filter((k) => k !== "class_prior").map((k) => h("option", { value: k, text: k.replace("_", " "), selected: k === src.kind }))),
                            h("input", { class: "cu-input", placeholder: "Title, e.g. Avenger 220 Street product page", value: src.title || "", "aria-label": "Title", oninput: (e) => upd("title", e.currentTarget.value) }),
                            h("button", { type: "button", class: "cu-icon-btn", "aria-label": "Remove source", html: ICON.x, onclick: () => { draft.sources.splice(i, 1); draw(); changed(); } })
                        ]),
                        h("div", { class: "cu-source-grid" }, [
                            h("input", { class: "cu-input", placeholder: "https://…", type: "url", value: src.url || "", "aria-label": "URL", oninput: (e) => upd("url", e.currentTarget.value.trim()) }),
                            h("input", { class: "cu-input", placeholder: "Publisher", value: src.publisher || "", "aria-label": "Publisher", oninput: (e) => upd("publisher", e.currentTarget.value) }),
                            h("input", { class: "cu-input", type: "date", value: src.retrieved || today(), "aria-label": "Retrieved", oninput: (e) => upd("retrieved", e.currentTarget.value) }),
                            h("input", { class: "cu-input", placeholder: "Note (needed for derived / estimated / community)", value: src.note || "", "aria-label": "Note", oninput: (e) => upd("note", e.currentTarget.value) })
                        ]),
                        h("p", { class: "cu-help", text: `id: ${src.id} · confidence cap ${C.CONF_CAP[src.kind] ?? 1}` }),
                        h("p", { class: "cu-msg", hidden: true })
                    ]);
                    fieldRows.set(`sources[${i}]`, { row, msg: /** @type {HTMLElement} */ (row.querySelector(".cu-msg")) });
                    return row;
                }));
            };
            draw();
            return section("Sources", "sources", [list, h("button", { type: "button", class: "cu-btn-ghost cu-add", onclick: () => {
                const s0 = { id: "", kind: "manufacturer", title: "", url: "", publisher: draft.identity.make || "", retrieved: today() };
                s0.id = D.sourceId(s0, draft.sources.map((x) => x.id));
                draft.sources.push(s0); draw(); changed();
                renderDetailKeepScroll();
            } }, [h("span", { class: "cu-i", "aria-hidden": "true", html: ICON.plus }), "Add a source"])], "Every value points at one of these. A source can't be more certain than its kind allows (press and aggregators: 0.8).");
        }
        function renameSource(oldId, newId) {
            for (const g of ["engine", "motor", "battery", "transmission", "chassis", "emission", "fuel"]) {
                if (!draft[g]) continue;
                for (const v of Object.values(draft[g])) if (v && v.src === oldId) v.src = newId;
                if (g === "fuel" && Array.isArray(draft.fuel.compat)) for (const c of draft.fuel.compat) if (c.src === oldId) c.src = newId;
            }
            if (draft.image && draft.image.src === oldId) draft.image.src = newId;
        }
        function renderDetailKeepScroll() { const y = main.scrollTop; renderDetail(); main.scrollTop = y; revalidate(true); }

        function valuesSection(sec) {
            const rows = sec.fields.filter((f) => !f.fixed).map((f) => valueRow(f));
            if (sec.key === "fuel" && draft.powertrain !== "ev") rows.push(fuelCompat());
            return section(sec.title, sec.key, [h("div", { class: "cu-values" }, rows)], sec.key === "fuel" ? "Fuel advice is decided by the contract: only certified (or compatible) fuels from the manufacturer or a manual, at confidence 0.7 or more, are recommended in the app." : null);
        }
        function valueRow(f) {
            const cur = D.getValue(draft, f.path) || {};
            const id = `cu-v-${f.path.replace(".", "-")}`;
            let input;
            const meta = () => ({ src: srcSel.value || undefined, conf: confEl.value === "" ? undefined : Number(confEl.value) });
            const firstSrc = () => (draft.sources[0] ? draft.sources[0] : null);
            const commit = (raw) => {
                let v;
                if (f.type === "c") v = f.enumV && f.enumV.includes(true) ? (raw === "" ? "" : raw === "true") : raw;
                else if (f.type === "qa") v = String(raw).split(/[,\s]+/).filter(Boolean).map((x) => Number(x.replace(",", ".")));
                else v = raw === "" ? "" : Number(String(raw).replace(",", "."));
                const m = meta();
                if (v !== "" && !m.src && firstSrc()) { m.src = firstSrc().id; srcSel.value = m.src; }
                if (v !== "" && m.conf === undefined && m.src) { const k = (draft.sources.find((x) => x.id === m.src) || {}).kind; m.conf = D.defaultConf(C, k); confEl.value = String(m.conf); }
                D.setValue(draft, f.path, v, { ...m, unit: f.type === "c" ? undefined : f.unit, basis: f.extra && f.extra.basis ? (basisSel ? basisSel.value : "kerb") : undefined });
                changed();
            };
            if (f.type === "c" && f.enumV) input = h("select", { id, class: "cu-input", onchange: (e) => commit(e.currentTarget.value) }, [h("option", { value: "", text: "–" }), ...f.enumV.map((v) => h("option", { value: String(v), text: String(v).replace("_", " "), selected: cur.v !== undefined && String(cur.v) === String(v) }))]);
            else if (f.type === "c") {
                const listId = f.suggest ? `${id}-list` : undefined;
                input = h("input", { id, class: "cu-input", value: cur.v ?? "", list: listId, placeholder: f.path.endsWith("Tyre") ? "e.g. 140/70-17" : "", oninput: (e) => commit(e.currentTarget.value.trim()) });
                if (f.suggest) input = h("span", { class: "cu-combo" }, [input, h("datalist", { id: listId }, f.suggest.map((x) => h("option", { value: x })))]);
            } else input = h("input", { id, class: "cu-input cu-num", inputmode: f.type === "qa" ? "text" : "decimal", value: cur.v === undefined ? "" : Array.isArray(cur.v) ? cur.v.join(", ") : String(cur.v), placeholder: f.type === "qa" ? "3.083, 1.938, 1.428, 1.173, 1.000" : f.range ? `${f.range[0]}–${f.range[1]}` : "", oninput: (e) => commit(e.currentTarget.value.trim()) });
            const srcSel = sourceSelect(cur.src || "", () => { if (D.getValue(draft, f.path)) { const c = D.getValue(draft, f.path); c.src = srcSel.value || undefined; if (!c.src) delete c.src; changed(); } });
            const confEl = confInput(cur.conf, (v) => { const c = D.getValue(draft, f.path); if (c) { if (v === undefined) delete c.conf; else c.conf = v; changed(); } });
            let basisSel = null;
            if (f.extra && f.extra.basis) basisSel = h("select", { class: "cu-input cu-basis", "aria-label": "Mass basis", onchange: () => { const c = D.getValue(draft, f.path); if (c) { c.basis = basisSel.value; changed(); } } }, f.extra.basis.map((b) => h("option", { value: b, text: b, selected: (cur.basis || "kerb") === b })));
            const more = h("details", { class: "cu-more" }, [h("summary", { text: "note" }),
                h("input", { class: "cu-input", placeholder: "Note: conversions, conflicts, caveats", value: cur.note || "", "aria-label": `${f.label} note`, oninput: (e) => { const c = D.getValue(draft, f.path); if (c) { if (e.currentTarget.value) c.note = e.currentTarget.value; else delete c.note; changed(); } } }),
                f.type === "q" ? h("input", { class: "cu-input cu-num", placeholder: "± tolerance", value: cur.tol ?? "", "aria-label": `${f.label} tolerance`, inputmode: "decimal", oninput: (e) => { const c = D.getValue(draft, f.path); if (c) { const t = e.currentTarget.value; if (t === "") delete c.tol; else c.tol = Number(t); changed(); } } }) : null
            ]);
            if (cur.note || cur.tol !== undefined) more.open = true;
            let helper = null;
            if (f.path.endsWith(".peakPower")) {
                const pIn = h("input", { class: "cu-input cu-num", placeholder: "46", inputmode: "decimal", "aria-label": "Published power" });
                const pU = h("select", { class: "cu-input", "aria-label": "Published unit" }, ["PS", "hp", "bhp"].map((u) => h("option", { value: u, text: u })));
                helper = h("details", { class: "cu-more cu-conv" }, [h("summary", { text: "published in PS or hp?" }), pIn, pU, h("button", { type: "button", class: "cu-btn-ghost cu-sm", text: "Convert", onclick: () => {
                    const v = Number(pIn.value.replace(",", "."));
                    if (!(v > 0)) return;
                    const c = D.convertPower(v, /** @type {any} */ (pU.value));
                    /** @type {HTMLInputElement} */ (row.querySelector(".cu-num")).value = String(c.kw);
                    commit(String(c.kw));
                    const cell = D.getValue(draft, f.path); if (cell) { cell.note = c.note; changed(); }
                    renderDetailKeepScroll();
                } })]);
            }
            const row = h("div", { class: `cu-value${f.required ? " is-req" : ""}` }, [
                h("label", { for: id, class: "cu-label", title: f.doc }, [f.label, f.required ? h("span", { class: "cu-req-dot", "aria-label": "required", text: "*" }) : f.recommended ? h("span", { class: "cu-rec", text: "recommended" }) : null]),
                h("span", { class: "cu-value-in" }, [input, f.unitLabel ? h("span", { class: "cu-unit", text: f.unitLabel }) : null, basisSel]),
                srcSel, confEl, more, helper,
                h("p", { class: "cu-msg", hidden: true })
            ]);
            fieldRows.set(f.path, { row, msg: /** @type {HTMLElement} */ (row.querySelector(":scope > .cu-msg")) });
            return row;
        }
        function fuelCompat() {
            draft.fuel = draft.fuel || { compat: [] };
            const box = h("div", { class: "cu-compat" });
            const draw = () => {
                box.replaceChildren(h("span", { class: "cu-label", text: "Fuel approvals" }), ...draft.fuel.compat.map((c, i) => h("div", { class: "cu-compat-row" }, [
                    h("select", { class: "cu-input", "aria-label": "Fuel", onchange: (e) => { c.fuel = e.currentTarget.value; changed(); } }, D.FUELS.map((x) => h("option", { value: x, text: x, selected: x === c.fuel }))),
                    h("select", { class: "cu-input", "aria-label": "Status", onchange: (e) => { c.status = e.currentTarget.value; changed(); } }, C.FUEL_STATUS.map((x) => h("option", { value: x, text: x.replace("_", " "), selected: x === c.status }))),
                    sourceSelect(c.src || "", (v) => { c.src = v; changed(); }),
                    confInput(c.conf, (v) => { if (v === undefined) delete c.conf; else c.conf = v; changed(); }),
                    h("input", { class: "cu-input", placeholder: "Note, e.g. the manual's exact words", value: c.note || "", "aria-label": "Note", oninput: (e) => { if (e.currentTarget.value) c.note = e.currentTarget.value; else delete c.note; changed(); } }),
                    h("button", { type: "button", class: "cu-icon-btn", "aria-label": "Remove", html: ICON.x, onclick: () => { draft.fuel.compat.splice(i, 1); draw(); changed(); } })
                ])), h("button", { type: "button", class: "cu-btn-ghost cu-add", onclick: () => {
                    const src = draft.sources.find((x) => C.AUTHORITATIVE_KINDS.includes(x.kind)) || draft.sources[0];
                    draft.fuel.compat.push({ fuel: "E20", status: "certified", src: src ? src.id : "", conf: src ? D.defaultConf(C, src.kind) : 0.9 }); draw(); changed();
                } }, [h("span", { class: "cu-i", "aria-hidden": "true", html: ICON.plus }), "Add a fuel"]));
                const msg = h("p", { class: "cu-msg", hidden: true });
                box.append(msg);
                fieldRows.set("fuel.compat", { row: box, msg });
            };
            draw();
            return box;
        }
        function notesSection() {
            const ta = h("textarea", { class: "cu-input cu-notes", rows: "3", placeholder: "One note per line: what was verified, what wasn't, why a confidence is lowered.", oninput: (e) => { draft.notes = e.currentTarget.value.split("\n").map((x) => x.trim()).filter(Boolean); changed(); } });
            ta.value = (draft.notes || []).join("\n");
            return section("Notes", "notes", [ta]);
        }
        function reviewSection() {
            jsonPre = h("pre", { class: "cu-json" });
            return section("The file", "json", [h("details", { class: "cu-json-wrap" }, [h("summary", { text: "Show the JSON that will be saved" }), jsonPre])]);
        }

        // ---------------- change → save + validate ----------------
        function changed() {
            clearTimeout(saveTimer); saveTimer = setTimeout(() => saveDraft(false), 800);
            revalidate(false);
        }
        function clean(d) { return JSON.parse(JSON.stringify(d)); }
        function revalidate(now) {
            clearTimeout(validateTimer);
            validateTimer = setTimeout(runChecks, now ? 0 : 280);
        }
        function runChecks() {
            if (!draft) return;
            const d = clean(draft);
            try { result = C.validateBundle(d, ref || {}); } catch (e) { result = { ok: false, errors: [{ path: "", code: "crash", message: /** @type {Error} */ (e).message }], warnings: [] }; }
            // Approval rules on top of the contract: an approved bike must have a picture (image_url).
            const extra = D.approvalErrors(d);
            if (extra.length) result = { ...result, ok: false, errors: [...extra, ...(result.errors || [])] };
            const crt = classRt.get(draft.classKey) || null;
            try { pv = D.preview(deps.physics, D.toRuntime(C, d, crt), crt); } catch (e) { pv = { ok: false, error: /** @type {Error} */ (e).message }; }
            paintChecks();
            if (jsonPre) jsonPre.textContent = JSON.stringify(d, null, 2);
        }
        function rowFor(path) {
            if (fieldRows.has(path)) return fieldRows.get(path);
            const m = path.match(/^sources\[(\d+)\]/); if (m && fieldRows.has(`sources[${m[1]}]`)) return fieldRows.get(`sources[${m[1]}]`);
            const two = path.split(".").slice(0, 2).join(".").replace(/\[\d+\]$/, "");
            if (fieldRows.has(two)) return fieldRows.get(two);
            if (path.startsWith("fuel.compat")) return fieldRows.get("fuel.compat");
            return null;
        }
        function paintChecks() {
            for (const { row, msg } of fieldRows.values()) { row.classList.remove("is-error", "is-warn"); if (msg) { msg.hidden = true; msg.textContent = ""; } }
            const errs = result ? result.errors : [], warns = result ? result.warnings : [];
            for (const [list, cls] of [[warns, "is-warn"], [errs, "is-error"]]) for (const it of list) {
                const r = rowFor(it.path);
                if (!r) continue;
                r.row.classList.remove("is-warn"); r.row.classList.add(cls);
                if (r.msg) { r.msg.hidden = false; r.msg.textContent = r.msg.textContent ? `${r.msg.textContent} · ${it.message}` : it.message; }
            }
            const item = (it, kind) => h("li", { class: `cu-check is-${kind}` }, [h("span", { class: "cu-i", "aria-hidden": "true", html: ICON.alert }), h("button", { type: "button", class: "cu-check-t", onclick: () => jump(it.path) }, [h("code", { text: it.path || "file" }), " ", it.path && it.message.startsWith(`${it.path} `) ? it.message.slice(it.path.length + 1) : it.message])]);
            railChecks.replaceChildren(...[      // replaceChildren would print "null"
                h("p", { class: `cu-verdict ${errs.length ? "is-error" : "is-ok"}` }, [h("span", { class: "cu-i", "aria-hidden": "true", html: errs.length ? ICON.alert : ICON.check }), errs.length ? `${errs.length} error${errs.length === 1 ? "" : "s"} to fix` : "Passes the contract", warns.length ? h("span", { class: "cu-muted", text: ` · ${warns.length} warning${warns.length === 1 ? "" : "s"}` }) : null]),
                ref ? null : h("p", { class: "cu-help", text: "Fuel and emission rules need the reference tables: they're checked again on the server when you approve." }),
                h("ul", { class: "cu-check-list" }, [...errs.slice(0, 12).map((x) => item(x, "error")), ...warns.slice(0, 6).map((x) => item(x, "warn"))]),
                errs.length > 12 ? h("p", { class: "cu-help", text: `…and ${errs.length - 12} more` }) : null
            ].filter(Boolean));
            approveBtn.disabled = errs.length > 0;
            paintPhysics();
        }
        function jump(path) {
            const r = rowFor(path);
            if (!r) return;
            r.row.scrollIntoView({ block: "center", behavior: "smooth" });
            const f = r.row.querySelector("input, select, textarea"); if (f) setTimeout(() => /** @type {HTMLElement} */ (f).focus(), 300);
        }
        function paintPhysics() {
            if (!pv || !pv.ok) { railPhys.replaceChildren(h("p", { class: "cu-help", text: pv && pv.error ? `Not enough data for the physics yet: ${pv.error}` : "Fill in the engine, gearing, tyre and mass to see the physics." })); return; }
            const unit = pv.ev ? "Wh/km" : "km/L";
            const fmt = (x) => (x === null ? "–" : U.num(x, pv.ev ? 0 : 1));
            // sparkline: this bike vs the class default
            const W = 260, H = 96, pad = 4;
            const vals = pv.curve.map((p) => p[1]).filter((x) => x !== null);
            const max = Math.max(1, ...vals.map((x) => Math.min(x, (pv.eco && pv.eco.best ? pv.eco.best : x) * 1.5)));
            const kmhMax = pv.curve.length ? pv.curve[pv.curve.length - 1][0] : 120;
            const X = (k) => pad + (k / kmhMax) * (W - 2 * pad), Y = (v) => H - pad - (Math.min(v, max) / max) * (H - 2 * pad);
            const path = pv.curve.reduce((acc, [k, v]) => (v === null ? { d: acc.d, open: false } : { d: `${acc.d}${acc.open ? "L" : "M"}${X(k).toFixed(1)} ${Y(v).toFixed(1)}`, open: true }), { d: "", open: false }).d;
            const svg = s("svg", { class: "cu-spark", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": `${unit} by speed` });
            if (pv.eco) svg.append(s("rect", { x: X(pv.eco.low), y: 0, width: Math.max(2, X(pv.eco.high) - X(pv.eco.low)), height: H, class: "cu-spark-eco" }));
            svg.append(s("line", { x1: 0, x2: W, y1: H - pad, y2: H - pad, class: "cu-spark-base" }), s("path", { d: path, class: "cu-spark-line" }));
            const rows = pv.at.map((a, i) => {
                const c = pv.classAt ? pv.classAt[i].value : null;
                const diff = a.value !== null && c ? (a.value / c - 1) : null;
                return h("tr", {}, [h("th", { scope: "row", text: `${a.kmh} km/h` }), h("td", { text: fmt(a.value) }), h("td", { class: "cu-muted", text: c ? fmt(c) : "–" }), h("td", { class: diff !== null && Math.abs(diff) > 0.35 ? "cu-flag" : "cu-muted", text: diff === null ? "" : `${diff >= 0 ? "+" : "−"}${U.num(Math.abs(diff) * 100, 0)} %` })]);
            });
            const topOff = pv.published && pv.top ? pv.top / pv.published - 1 : null;
            railPhys.replaceChildren(...[
                svg,
                h("p", { class: "cu-help", text: pv.eco ? `Eco band ${U.num(pv.eco.low, 0)}–${U.num(pv.eco.high, 0)} km/h, about ${fmt(pv.eco.best)} ${unit} at best` : "No eco band" }),
                h("table", { class: "cu-table" }, [h("thead", {}, [h("tr", {}, [h("th", { text: "" }), h("th", { text: unit }), h("th", { text: "class" }), h("th", { text: "" })])]), h("tbody", {}, rows)]),
                h("p", { class: topOff !== null && Math.abs(topOff) > 0.15 ? "cu-flag" : "cu-help", text: `Top speed: physics ${U.num(pv.top, 0)} km/h${pv.published ? ` · published ${U.num(pv.published, 0)} (${topOff >= 0 ? "+" : "−"}${U.num(Math.abs(topOff) * 100, 0)} %)` : ""}` }),
                pv.range ? h("p", { class: "cu-help", text: `Range at the eco band: about ${U.num(pv.range / 1000, 0)} km on a ${pv.ev ? "full charge" : "full tank"}` }) : null,
                pv.flags.length ? h("details", { class: "cu-more" }, [h("summary", { text: `${pv.flags.length} value${pv.flags.length === 1 ? "" : "s"} from the class default` }), h("ul", { class: "cu-flags" }, pv.flags.map((f) => h("li", { text: f })))]) : null,
                h("p", { class: "cu-help", text: "A gap of more than 35 % from the class, or 15 % on top speed, usually means a typo or a wrong unit." })
            ].filter(Boolean));
        }

        // ---------------- actions ----------------
        async function saveDraft(explicit) {
            if (!selected || !draft) return;
            writeDraft(selected.id, clean(draft));
            if (explicit) {
                try { await api.saveDraft(selected.id, clean(draft)); flash("Draft saved"); selected.status = selected.status === "queued" || !selected.status ? "drafted" : selected.status; renderList(); }
                catch (e) { flash(`Saved in this browser. The server said: ${/** @type {Error} */ (e).message}`, true); }
            }
        }
        function download() {
            if (!draft) return;
            const blob = new Blob([JSON.stringify(clean(draft), null, 2) + "\n"], { type: "application/json" });
            const a = h("a", { href: URL.createObjectURL(blob), download: `${draft.id || "bike"}.json` });
            document.body.append(a); a.click(); a.remove();
        }
        async function approve() {
            if (!result || result.errors.length || D.approvalErrors(draft).length) return;
            approveBtn.disabled = true;
            try {
                const res = await api.approve(selected.id, clean(draft));
                if (res && res.location === "download") download();
                selected.status = "approved";
                writeDraft(selected.id, null);
                flash(res.location === "pending" ? `Saved to pending/: ${((res.errors || [])[0] || {}).message || "blocked by a rule"}` : res.location === "download" ? "Approved: commit the downloaded file to data/bikes/variants/ and rebuild." : `Approved: ${res.id} is in the catalogue.`);
                next();
            } catch (e) {
                const errs = e && /** @type {any} */ (e).body && /** @type {any} */ (e).body.errors;
                flash(`Not approved: ${/** @type {Error} */ (e).message}${errs && errs.length ? ` (${errs[0].path}: ${errs[0].message})` : ""}`, true);
                approveBtn.disabled = false;
            }
        }
        async function reject(reason) {
            reason = String(reason || "").trim();
            if (!reason) return;
            try { await api.reject(selected.id, reason); selected.status = "rejected"; writeDraft(selected.id, null); flash("Rejected"); next(); }
            catch (e) { flash(`Couldn't reject: ${/** @type {Error} */ (e).message}`, true); }
        }
        async function resolveDuplicate(m) {
            try { await api.duplicate(selected.id, m.id); selected.status = "duplicate"; writeDraft(selected.id, null); flash(`Marked as ${m.make} ${m.model}`); next(); }
            catch (e) { flash(`Couldn't update: ${/** @type {Error} */ (e).message}`, true); }
        }
        function next() {
            renderList();
            const rest = requests.filter((r) => inTab(r));
            if (rest.length) select(rest[0].id); else { selected = null; draft = null; renderEmpty(); }
        }
        const toast = h("div", { class: "cu-toast", role: "status", "aria-live": "polite", hidden: true });
        root.append(toast);
        let toastTimer = null;
        function flash(text, bad = false) { toast.textContent = text; toast.hidden = false; toast.classList.toggle("is-bad", bad); clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, bad ? 7000 : 3500); }

        document.addEventListener("keydown", (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveDraft(true); return; }
            const t = /** @type {HTMLElement} */ (e.target);
            if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
            if (e.key !== "j" && e.key !== "k") return;
            const rows = [...listEl.querySelectorAll(".cu-item")];
            const i = rows.findIndex((x) => x.classList.contains("is-on"));
            const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "j" ? 1 : -1)))];
            if (n) select(/** @type {HTMLElement} */ (n).dataset.id);
        });

        // ---------------- start ----------------
        (async () => {
            setConn("busy", "Loading the catalogue…");
            try { index = new deps.search.CatalogIndex(await deps.catalog()); } catch (e) { setConn("err", `Catalogue unavailable: ${/** @type {Error} */ (e).message}`); }
            let token = "";
            try { token = (session && session.getItem("mu.curator.token")) || ""; } catch { token = ""; }
            tokenIn.value = token;
            await connect(token);
        })();

        return { select, get draft() { return draft; }, get result() { return result; }, get preview() { return pv; }, connect };
    }

    return { DRAFTS_KEY, mount };
});
