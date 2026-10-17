// @ts-check
/* ============================================================================
   MapUnite RoadPulse — the post-ride review (Confirmed Decision 2)
   ==============================================================================
   After a ride, the rider sees what the phone detected on a small map and in a
   short list, and decides, in a few taps:

     ✅ Haan tha / ❌ Nahi tha      each detected pothole, speed breaker or rough stretch
     Halka · Medium · Bada          its severity
     drag the marker                its place (a confirmed one)
     + Missed one                   add one the sensor missed: tap the map
     Mila / Nahi mila / Pata nahi   hazards it was WARNED about ("did you find it?")
     Not sure what this was         unknown ones (strong, one wheel only), unreviewed by default
     Small bumps (hidden)           minor ones, collapsed, unreviewed by default
     ☐ share "ridden, nothing felt" for this ride (anonymous cells)
     [ Publish N reports ]  [ Skip ]

   Private by default: nothing is shared unless the rider taps Publish, and then
   only the confirmed reports and the votes (sync.publish → a random 0–2 h delay,
   never from a private zone). The ride's route, start, end, home and history
   never leave the phone. Confirming or removing also updates the phone's own
   road log at once (a rider observation), so a wrong detection stops being
   warned even when sharing is off.

   Opens by itself when a ride ends (state.ride → inactive) if there is
   something to review; a chip "Review last ride" stays until it's done or
   skipped (7 days). Pure parts (tested in Node): buildReview(), toPublish().
   The sheet is drawn with textContent only; the map needs Leaflet (L), and
   without it the list still works (adding a missed one needs the map).
   ============================================================================ */
(function (root, factory) {
    const lib = factory();
    if (typeof module === "object" && module.exports) module.exports = lib;
    else {
        const W = /** @type {any} */ (root);
        (W.MUMaster || (W.MUMaster = {})).rideReview = lib;
        if (W.document) {
            if (W.document.readyState === "loading") W.document.addEventListener("DOMContentLoaded", () => lib.mount(W));
            else lib.mount(W);
        }
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const RIDE_KEY = "mu.master.dynamics.review.ride";     // written by agents/dynamics-agent.js (store "review.ride")
    const DONE_KEY = "mu.roadsense.review.done";
    const KEEP_MS = 7 * 86400000;
    const SEVERITY = Object.freeze({ 1: "Halka", 2: "Medium", 3: "Bada" });
    const TITLES = Object.freeze({ pothole: "Pothole", speed_breaker: "Speed breaker", bump: "Pothole or hump", rough: "Rough road", broken_patch: "Broken patch" });

    /**
     * What there is to review for a ride. Pure.
     * @param {{ startedAt: number, endedAt: number|null, items: any[], warned: any[] }|null} ride
     * @param {{ hazards?: any[] }} [o] hazards: the published ones the sync keeps (for what the warned ones were)
     */
    function buildReview(ride, o = {}) {
        if (!ride || !Array.isArray(ride.items)) return null;
        const byId = new Map((o.hazards || []).map((h) => [h.id, h]));
        const placed = ride.items.filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng));
        const items = placed.filter((x) => !x.minor && !x.unknown);
        const unknown = placed.filter((x) => x.unknown);
        const minor = placed.filter((x) => x.minor && !x.unknown);
        // "did you find it?" only for published hazards (they can take a vote), not the rider's own
        const asks = (ride.warned || []).filter((w) => w.community && byId.has(w.roadsenseId) && !byId.get(w.roadsenseId).mine)
            .map((w) => ({ hazard: w.roadsenseId, t: w.t, lat: w.lat, lng: w.lng, type: byId.get(w.roadsenseId).type }));
        return { startedAt: ride.startedAt, endedAt: ride.endedAt, items, unknown, minor, asks, empty: !items.length && !unknown.length && !minor.length && !asks.length };
    }

    /**
     * The rider's decisions → what goes to the server (sync.publish) and to the phone's own log. Pure.
     *   decisions.items[key] = { verdict: "found"|"not_found", severity?, lat?, lng?, publish?: boolean }   (key = item id)
     *   decisions.asks[hazard] = "found"|"not_found"|"unsure"
     *   decisions.added = [{ type, severity, lat, lng }]                                                    (missed ones)
     *   decisions.shareClear = true → the ride's smooth passes may go up
     * @param {any} review @param {any} decisions
     */
    function toPublish(review, decisions) {
        const d = decisions || {};
        const reports = [], votes = [], local = [];
        const idOf = (/** @type {string} */ key) => `r${review.startedAt}.${String(key).replace(/[^A-Za-z0-9_.-]/g, "")}`.slice(0, 64);
        for (const it of [...review.items, ...(review.unknown || []), ...review.minor]) {
            const x = d.items && d.items[it.id];
            if (!x || (x.verdict !== "found" && x.verdict !== "not_found")) continue;
            const moved = Number.isFinite(x.lat) && Number.isFinite(x.lng);
            const lat = moved ? x.lat : it.lat, lng = moved ? x.lng : it.lng;
            const type = it.kind === "rough" ? "rough" : it.hazard;
            local.push({ type: type === "rough" ? "rough" : type, t: it.t, lat, lng, present: x.verdict === "found" });
            if (x.verdict !== "found" || x.publish === false) continue;
            reports.push({
                id: idOf(it.id), type, severity: [1, 2, 3].includes(x.severity) ? x.severity : Math.max(1, Math.min(3, it.severity || 2)),
                lat, lng, sigmaM: moved ? 10 : (Number.isFinite(it.posSigmaM) ? it.posSigmaM : 10),
                heading: Number.isFinite(it.heading) ? Math.round(((it.heading % 360) + 360) % 360) % 360 : null, t: it.t, source: "sensor"
            });
        }
        (d.added || []).forEach((/** @type {any} */ a, /** @type {number} */ i) => {
            if (!a || !Number.isFinite(a.lat) || !Number.isFinite(a.lng) || !["pothole", "speed_breaker", "rough"].includes(a.type)) return;
            const t = review.endedAt || review.startedAt;
            local.push({ type: a.type, t, lat: a.lat, lng: a.lng, present: true });
            if (a.publish === false) return;
            reports.push({ id: idOf(`m${i}`), type: a.type, severity: [1, 2, 3].includes(a.severity) ? a.severity : 2, lat: a.lat, lng: a.lng, sigmaM: 15, heading: null, t, source: "manual" });
        });
        for (const q of review.asks) {
            const v = d.asks && d.asks[q.hazard];
            if (v === "found" || v === "not_found" || v === "unsure") votes.push({ hazard: q.hazard, verdict: v, t: q.t });
        }
        return { reports, votes, local, cover: d.shareClear && review.endedAt ? { from: review.startedAt, to: review.endedAt } : null };
    }

    // ------------------------------------------------------------------ the sheet

    /** @param {any} W */
    function mount(W) {
        const doc = W.document;
        if (!doc || mount.done) return;
        mount.done = true;
        const read = (/** @type {string} */ k, /** @type {any} */ f) => { try { const v = W.localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch (e) { return f; } };
        const write = (/** @type {string} */ k, /** @type {any} */ v) => { try { W.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full / private */ } };
        const live = () => (W.MUMaster && W.MUMaster.live) || null;
        const capOf = (/** @type {string} */ id) => { const l = live(); return l && l.caps && l.caps.has(id) ? l.caps.get(id) : null; };
        const h = (/** @type {string} */ tag, /** @type {string} */ cls, /** @type {string} */ text = "") => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

        const pending = () => {
            const ride = read(RIDE_KEY, null);
            if (!ride || !ride.endedAt || Date.now() - ride.endedAt > KEEP_MS) return null;
            if ((read(DONE_KEY, []) || []).includes(ride.startedAt)) return null;
            const sync = capOf("roadsense-sync");
            const rv = buildReview(ride, { hazards: sync ? sync.hazards() : [] });
            return rv && !rv.empty ? rv : null;
        };
        const markDone = (/** @type {number} */ startedAt) => write(DONE_KEY, [...(read(DONE_KEY, []) || []), startedAt].slice(-50));

        const chip = h("button", "rp-chip", "Review last ride");
        chip.type = "button"; chip.id = "rp-review-chip"; chip.hidden = true;
        doc.body.append(chip);
        const refreshChip = () => { const rv = pending(); chip.hidden = !rv; if (rv) chip.textContent = `Review last ride · ${rv.items.length + rv.unknown.length + rv.asks.length}`; };

        /** @type {HTMLElement|null} */ let sheet = null;
        /** @type {any} */ let lmap = null;

        function close() { if (lmap) { try { lmap.remove(); } catch (e) { /* gone */ } lmap = null; } if (sheet) sheet.remove(); sheet = null; refreshChip(); }

        function open() {
            const rv = pending();
            if (!rv) { refreshChip(); return; }
            close();
            /** @type {any} */ const dec = { items: {}, asks: {}, added: [], shareClear: true };
            sheet = h("div", "rp-sheet");
            sheet.id = "rp-review";
            sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true"); sheet.setAttribute("aria-labelledby", "rp-title");
            const head = h("div", "rp-head");
            const title = h("h2", "rp-title", "Ride review"); title.id = "rp-title";
            const skip = h("button", "rp-skip", "Skip"); skip.type = "button";
            head.append(title, skip);
            const sub = h("p", "rp-sub", "Your ride stays private. Only the reports you publish are shared: the spot, its direction, kind and severity. Never your route, start, end or home.");
            const mapBox = h("div", "rp-map"); mapBox.id = "rp-map";
            const list = h("div", "rp-list");
            const foot = h("div", "rp-foot");
            sheet.append(head, sub, mapBox, list, foot);
            doc.body.append(sheet);

            // ---- the map (Leaflet if present)
            /** @type {Map<string, any>} */ const markers = new Map();
            let addMode = /** @type {any} */ (null);
            if (W.L && typeof W.L.map === "function") {
                const L = W.L;
                lmap = L.map(mapBox, { zoomControl: false, attributionControl: true });
                L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
                    maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics | Map data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
                }).addTo(lmap);
                const pts = [];
                const dot = (/** @type {string} */ color) => L.divIcon({ className: "", html: `<span class="rp-dot" style="background:${color}"></span>`, iconSize: [18, 18], iconAnchor: [9, 9] });
                for (const it of rv.items) {
                    if (it.kind === "rough" && Array.isArray(it.points) && it.points.length > 1) L.polyline(it.points, { color: "#ffb020", weight: 6, opacity: 0.9 }).addTo(lmap);
                    const m = L.marker([it.lat, it.lng], { icon: dot(it.kind === "rough" ? "#ffb020" : "#ff4d4f"), draggable: true, title: TITLES[/** @type {keyof typeof TITLES} */ (it.hazard)] || "Hazard" }).addTo(lmap);
                    m.on("dragend", () => { const p = m.getLatLng(); dec.items[it.id] = { ...(dec.items[it.id] || { verdict: "found" }), lat: p.lat, lng: p.lng }; render(); });
                    markers.set(it.id, m); pts.push([it.lat, it.lng]);
                }
                for (const q of rv.asks) { L.marker([q.lat, q.lng], { icon: dot("#4da3ff"), title: "Reported by other riders" }).addTo(lmap); pts.push([q.lat, q.lng]); }
                for (const it of [...rv.unknown, ...rv.minor]) pts.push([it.lat, it.lng]);
                if (pts.length) lmap.fitBounds(pts, { padding: [24, 24], maxZoom: 17 });
                lmap.on("click", (/** @type {any} */ ev) => {
                    if (!addMode) return;
                    const a = { ...addMode, lat: ev.latlng.lat, lng: ev.latlng.lng };
                    dec.added.push(a);
                    L.marker([a.lat, a.lng], { icon: dot("#ff4d4f") }).addTo(lmap);
                    addMode = null; render();
                });
                setTimeout(() => { if (lmap) lmap.invalidateSize(); }, 50);
            } else mapBox.hidden = true;

            const choice = (/** @type {string} */ label, /** @type {boolean} */ on, /** @type {() => void} */ fn, cls = "") => {
                const b = h("button", `rp-btn ${cls}${on ? " rp-on" : ""}`, label); b.type = "button"; b.setAttribute("aria-pressed", String(on)); b.addEventListener("click", fn); return b;
            };
            const when = (/** @type {number} */ t) => new Date(t).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

            /** one detected item @param {any} it */
            function card(it) {
                const x = dec.items[it.id] || {};
                const c = h("div", "rp-card");
                const t = h("div", "rp-card-title", `${TITLES[/** @type {keyof typeof TITLES} */ (it.hazard)] || "Hazard"} · ${when(it.t)}${it.kind === "rough" && it.lengthM ? ` · ${Math.round(it.lengthM)} m` : ""}`);
                const row = h("div", "rp-row");
                row.append(
                    choice("✅ Haan tha", x.verdict === "found", () => { dec.items[it.id] = { ...x, verdict: "found" }; render(); }),
                    choice("❌ Nahi tha", x.verdict === "not_found", () => { dec.items[it.id] = { ...x, verdict: "not_found" }; render(); })
                );
                c.append(t, row);
                if (x.verdict === "found") {
                    const sev = h("div", "rp-row");
                    for (const n of [1, 2, 3]) sev.append(choice(SEVERITY[/** @type {1|2|3} */ (n)], (x.severity || it.severity) === n, () => { dec.items[it.id] = { ...x, severity: n }; render(); }, "rp-chipbtn"));
                    const pub = h("label", "rp-check");
                    const cb = /** @type {HTMLInputElement} */ (h("input", "")); cb.type = "checkbox"; cb.checked = x.publish !== false;
                    cb.addEventListener("change", () => { dec.items[it.id] = { ...x, publish: cb.checked }; render(); });
                    pub.append(cb, doc.createTextNode(" Make this report public"));
                    c.append(sev, pub);
                    if (lmap) c.append(h("p", "rp-hint", Number.isFinite(x.lat) ? "Moved on the map." : "Wrong spot? Drag its marker on the map."));
                }
                c.addEventListener("click", (ev) => { if (lmap && markers.has(it.id) && !(/** @type {any} */ (ev.target)).closest("button,input,label")) lmap.setView(markers.get(it.id).getLatLng(), 17); });
                return c;
            }

            function render() {
                list.replaceChildren();
                if (rv.items.length) list.append(h("h3", "rp-h3", `Detected on this ride · ${rv.items.length}`));
                for (const it of rv.items) list.append(card(it));
                if (rv.unknown.length) {
                    list.append(h("h3", "rp-h3", "Not sure what these were (one wheel only). Was it a hazard?"));
                    for (const it of rv.unknown) list.append(card(it));
                }
                if (rv.minor.length) {
                    const det = /** @type {HTMLDetailsElement} */ (h("details", "rp-minor"));
                    det.append(h("summary", "", `${rv.minor.length} small bump${rv.minor.length === 1 ? "" : "s"} (hidden: probably nothing)`));
                    for (const it of rv.minor) det.append(card(it));
                    list.append(det);
                }
                if (rv.asks.length) {
                    list.append(h("h3", "rp-h3", "Other riders reported these. Did you find them?"));
                    for (const q of rv.asks) {
                        const v = dec.asks[q.hazard];
                        const c = h("div", "rp-card");
                        c.append(h("div", "rp-card-title", `${TITLES[/** @type {keyof typeof TITLES} */ (q.type)] || "Hazard"} · ${when(q.t)}`));
                        const row = h("div", "rp-row");
                        for (const [val, label] of [["found", "Mila"], ["not_found", "Nahi mila"], ["unsure", "Pata nahi"]]) row.append(choice(label, v === val, () => { dec.asks[q.hazard] = val; render(); }));
                        c.append(row);
                        list.append(c);
                    }
                }
                // a missed one: pick a kind, then tap the map
                const add = h("div", "rp-add");
                if (lmap) {
                    if (addMode) add.append(h("p", "rp-hint rp-strong", `Tap the map where the ${addMode.type === "rough" ? "rough road" : addMode.type === "speed_breaker" ? "speed breaker" : "pothole"} was.`));
                    else for (const [type, label] of [["pothole", "+ Missed pothole"], ["speed_breaker", "+ Missed breaker"], ["rough", "+ Missed rough road"]]) add.append(choice(label, false, () => { addMode = { type, severity: 2 }; render(); }, "rp-chipbtn"));
                    if (dec.added.length) add.append(h("p", "rp-hint", `${dec.added.length} added by you.`));
                } else add.append(h("p", "rp-hint", "Adding a missed one needs the map, which couldn't load."));
                list.append(add);

                // the footer: what will be shared
                const out = toPublish(rv, dec);
                const sync = capOf("roadsense-sync");
                const sharing = Boolean(sync && sync.consent());
                foot.replaceChildren();
                const clear = h("label", "rp-check");
                const cb = /** @type {HTMLInputElement} */ (h("input", "")); cb.type = "checkbox"; cb.checked = dec.shareClear;
                cb.addEventListener("change", () => { dec.shareClear = cb.checked; });
                clear.append(cb, doc.createTextNode(" Also share where this ride felt no bumps (anonymous, per ~200 m)"));
                const n = out.reports.length + out.votes.length;
                const go = h("button", "rp-publish", sharing ? (n ? `Publish ${n} report${n === 1 ? "" : "s"}` : "Done") : "Save on this phone");
                go.type = "button";
                go.addEventListener("click", () => finish(true));
                if (sharing) foot.append(clear);
                else foot.append(h("p", "rp-hint", "Community road reports are off (Settings), so nothing will be shared. Your answers still correct this phone's own warnings."));
                foot.append(go);
            }

            /** @param {boolean} save */
            function finish(save) {
                if (save) {
                    const out = toPublish(rv, dec);
                    // the phone's own log, at once: a confirmed spot is stronger, a removed one stops being warned
                    const log = capOf("roadsense");
                    if (log) { for (const x of out.local) { try { log.add({ ...x, source: "rider", rider: "self", conf: 0.8 }); } catch (e) { /* bad point */ } } try { log.save(); } catch (e) { /* storage */ } }
                    const sync = capOf("roadsense-sync");
                    if (sync && sync.consent()) {
                        if (out.reports.length || out.votes.length) sync.publish({ reports: out.reports, votes: out.votes });
                        if (out.cover) sync.approveCover(out.cover.from, out.cover.to);
                    }
                }
                markDone(rv.startedAt);
                close();
            }
            skip.addEventListener("click", () => finish(false));
            render();
            const first = sheet.querySelector("button.rp-btn");
            if (first) /** @type {HTMLElement} */ (first).focus();
        }

        chip.addEventListener("click", open);
        let riding = false;
        doc.addEventListener("mu:master-ride", (/** @type {any} */ e) => {
            const active = Boolean(e.detail && e.detail.active);
            if (riding && !active) setTimeout(open, 1500);        // the agent writes the ride's detections as it stops
            riding = active;
            if (active) { close(); chip.hidden = true; }
        });
        refreshChip();
    }
    /** @type {boolean} */ mount.done = false;

    return { buildReview, toPublish, mount, RIDE_KEY, DONE_KEY };
});
