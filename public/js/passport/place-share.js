// @ts-check
/* ============================================================================
   MapUnite — share a place with friends (WhatsApp or any app)
   ==============================================================================
   From a place on the map (a named place's popup, a searched destination, or a
   long-press on the map), the rider gets a small sheet:
     - the place's name (editable) and kind: fuel, repair, viewpoint, food,
       stay, other;
     - an optional note ("Good place to stop", "Entrance is on the side lane");
     - "Add coordinates to the message" (off unless the place has no name):
       the link already opens the spot, so the numbers are only for when a
       name isn't enough;
     - a PREVIEW of exactly what will be sent, then Share (the phone's share
       menu, js/passport/share-out.js) or Copy.
   The link: MapUnite's own (/?place=lat,lng&n=name&c=kind, opened by this
   file: a pin with the name and note) when the app has a public address,
   otherwise an OpenStreetMap link. It shares a PLACE, never the rider's live
   location, and nothing goes to MapUnite's server.

   MUPlaceShare.core.compose(...) is pure and tested (test/passport/).
   ============================================================================ */
"use strict";

const MUPlaceShareCore = (() => {
    const CATEGORIES = Object.freeze([
        ["fuel", "Fuel station", "⛽"], ["repair", "Repair shop", "🔧"], ["viewpoint", "Viewpoint", "🏞"], ["food", "Food stop", "🍴"],
        ["stay", "Place to stay", "🛏"], ["health", "Hospital / clinic", "✚"], ["other", "Place", "📍"]
    ]);
    const catOf = (/** @type {string} */ c) => CATEGORIES.find((x) => x[0] === c) || CATEGORIES[CATEGORIES.length - 1];
    /** From the map's place kinds (js/mapdetail.js) to a share category. @param {string} kind */
    function categoryFromKind(kind) {
        return ({ fuel: "fuel", service: "repair", attraction: "viewpoint", park: "viewpoint", food: "food", lodging: "stay", health: "health" })[kind] || "other";
    }
    const clean = (/** @type {any} */ s, /** @type {number} */ n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
    const ok = (/** @type {number} */ lat, /** @type {number} */ lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

    /**
     * The link that opens the place. MapUnite's own when the app has a public https address, else OpenStreetMap.
     * @param {{ lat: number, lng: number, name?: string, category?: string, note?: string }} p @param {string} origin
     */
    function linkFor(p, origin) {
        const lat = p.lat.toFixed(5), lng = p.lng.toFixed(5);
        const pub = /^https:\/\/(?!localhost\b|127\.|10\.|192\.168\.)[^/\s]+$/.test(origin || "");
        if (!pub) return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
        const q = new URLSearchParams({ place: `${lat},${lng}` });
        if (p.name) q.set("n", clean(p.name, 60));
        if (p.category && p.category !== "other") q.set("c", p.category);
        if (p.note) q.set("note", clean(p.note, 140));
        return `${origin}/?${q.toString()}`;
    }

    /**
     * What will be shared. Pure.
     * @param {{ lat: number, lng: number, name?: string, category?: string, note?: string, includeCoords?: boolean }} p
     * @param {{ origin?: string }} [o]
     * @returns {{ ok: boolean, title: string, text: string, url: string, coords: boolean }}
     */
    function compose(p, o = {}) {
        if (!p || !ok(p.lat, p.lng)) return { ok: false, title: "", text: "", url: "", coords: false };
        const name = clean(p.name, 60), note = clean(p.note, 140);
        const [cat, label, icon] = catOf(p.category || "other");
        const coords = Boolean(p.includeCoords) || !name;                  // a place with no name needs its numbers
        const url = linkFor({ lat: p.lat, lng: p.lng, name, category: cat, note }, o.origin || "");
        const head = name ? `${icon} ${name}${cat !== "other" ? ` (${label})` : ""}` : `${icon} ${cat !== "other" ? label : "A place"}`;
        const lines = [head];
        if (note) lines.push(note);
        lines.push(url);
        if (coords) lines.push(`${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`);
        lines.push("Shared from MapUnite");
        return { ok: true, title: name || label, text: lines.join("\n"), url, coords };
    }

    /**
     * A shared link opened in the app: ?place=lat,lng&n=…&c=…&note=… → the place, or null. Pure.
     * @param {string} search location.search
     */
    function parseLink(search) {
        let q;
        try { q = new URLSearchParams(search || ""); } catch (e) { return null; }
        const m = /^(-?\d{1,2}(?:\.\d{1,7})?),(-?\d{1,3}(?:\.\d{1,7})?)$/.exec(q.get("place") || "");
        if (!m) return null;
        const lat = Number(m[1]), lng = Number(m[2]);
        if (!ok(lat, lng)) return null;
        const c = q.get("c") || "other";
        return { lat, lng, name: clean(q.get("n"), 60), category: CATEGORIES.some((x) => x[0] === c) ? c : "other", note: clean(q.get("note"), 140) };
    }

    return { CATEGORIES, categoryFromKind, compose, linkFor, parseLink };
})();

const MUPlaceShare = (() => {
    const C = MUPlaceShareCore;
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : null);
    if (!W || !W.document) return { core: C };
    const lmap = () => (typeof map !== "undefined" ? map : null);
    const origin = () => {
        const o = typeof MU_SERVER_ORIGIN === "string" && MU_SERVER_ORIGIN ? MU_SERVER_ORIGIN : (W.location && /^https:/.test(W.location.origin) ? W.location.origin : "");
        return o;
    };
    const COUNT_KEY = "mu.passport.placesShared.v1";
    const h = (/** @type {string} */ tag, /** @type {Record<string, any>} */ a = {}, /** @type {Array<any>} */ kids = []) => {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(a)) {
            if (v == null || v === false) continue;
            if (k === "class") el.className = v; else if (k === "text") el.textContent = v;
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? "" : String(v));
        }
        for (const c of kids) if (c != null && c !== false) el.append(c);
        return el;
    };

    let modal = null;
    /** @param {{ lat: number, lng: number, name?: string, category?: string, kind?: string }} place */
    function open(place) {
        if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return;
        if (modal) modal.remove();
        const state = { lat: place.lat, lng: place.lng, name: place.name || "", category: place.category || C.categoryFromKind(place.kind || ""), note: "", includeCoords: !place.name };
        const preview = h("pre", { class: "pp-preview", "aria-live": "polite" });
        const status = h("p", { class: "pp-status", role: "status" });
        const name = /** @type {HTMLInputElement} */ (h("input", { class: "pp-input", type: "text", maxlength: "60", value: state.name, placeholder: "Name of the place", "aria-label": "Place name" }));
        const cat = /** @type {HTMLSelectElement} */ (h("select", { class: "pp-input", "aria-label": "What kind of place" }, C.CATEGORIES.map(([v, label, icon]) => h("option", { value: v, text: `${icon} ${label}` }))));
        cat.value = state.category;
        const note = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "pp-input", maxlength: "140", rows: "2", placeholder: "Optional note, e.g. Good place to stop · entrance is on the side lane", "aria-label": "Your note" }));
        const coords = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", class: "switch", id: "pp-coords" }));
        coords.checked = state.includeCoords;
        const refresh = () => {
            Object.assign(state, { name: name.value, category: cat.value, note: note.value, includeCoords: coords.checked });
            const c = C.compose(state, { origin: origin() });
            preview.textContent = c.text;
            coords.disabled = !state.name.trim();
            if (coords.disabled) coords.checked = true;
            return c;
        };
        for (const el of [name, cat, note]) el.addEventListener("input", refresh);
        coords.addEventListener("change", refresh);
        const done = (/** @type {{ how: string }} */ r) => {
            status.textContent = W.MUShareOut ? W.MUShareOut.said(r) : "";
            if (r.how === "native" || r.how === "web" || r.how === "copied") {
                try { localStorage.setItem(COUNT_KEY, String((Number(localStorage.getItem(COUNT_KEY)) || 0) + 1)); } catch (e) { /* private mode */ }
                document.dispatchEvent(new CustomEvent("mu:place-shared", { detail: { category: state.category } }));
            }
        };
        const share = async () => { const c = refresh(); if (!c.ok) return; done(W.MUShareOut ? await W.MUShareOut.text({ title: c.title, text: c.text }) : { how: "failed" }); };
        const copy = async () => {
            const c = refresh();
            try { await navigator.clipboard.writeText(c.text); done({ how: "copied" }); } catch (e) { status.textContent = "Couldn't copy here: select the preview and copy it."; }
        };
        const close = () => { if (modal) { modal.remove(); modal = null; } };
        modal = h("div", { class: "modal pp-modal", role: "dialog", "aria-modal": "true", "aria-label": "Share a place", onclick: (/** @type {MouseEvent} */ e) => { if (e.target === modal) close(); } }, [
            h("div", { class: "modal-card pp-card" }, [
                h("button", { class: "close-modal", type: "button", "aria-label": "Close", text: "✕", onclick: close }),
                h("h2", { text: "Share this place" }),
                h("p", { class: "pp-sub", text: "Goes through your phone's share menu: WhatsApp, Telegram or any app. You see the message first; MapUnite doesn't send it anywhere itself." }),
                h("label", { class: "pp-label", text: "Name" }), name,
                h("label", { class: "pp-label", text: "Kind of place" }), cat,
                h("label", { class: "pp-label", text: "Note (optional)" }), note,
                h("label", { class: "pp-row", for: "pp-coords" }, [h("span", { text: "Add coordinates to the message" }), coords]),
                h("p", { class: "pp-label", text: "Preview: this is exactly what will be shared" }), preview,
                h("div", { class: "pp-actions" }, [
                    h("button", { type: "button", class: "btn-primary-nav", text: "Share", onclick: share }),
                    h("button", { type: "button", class: "btn-secondary-nav", text: "Copy", onclick: copy })
                ]),
                status
            ])
        ]);
        document.body.append(modal);
        modal.style.display = "flex";
        refresh();
        name.focus();
    }

    // ------------------------------------------------------------ entry points
    // any element with class mu-share-place and data-lat/lng/name/kind (map popups, the search result) opens the sheet
    document.addEventListener("click", (e) => {
        const b = e.target && /** @type {any} */ (e.target).closest ? /** @type {any} */ (e.target).closest(".mu-share-place") : null;
        if (!b) return;
        e.preventDefault();
        open({ lat: Number(b.dataset.lat), lng: Number(b.dataset.lng), name: b.dataset.name || "", kind: b.dataset.kind || "" });
    });
    const esc = (/** @type {string} */ s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c] || c));
    /** The HTML of a "Share" button for a popup. @param {{ lat: number, lng: number, name?: string, kind?: string }} p */
    function button(p) {
        return `<button type="button" class="mu-share-place" data-lat="${p.lat}" data-lng="${p.lng}" data-name="${esc(p.name || "")}" data-kind="${esc(p.kind || "")}">Share place</button>`;
    }
    function wireMap() {
        const m = lmap();
        if (!m) return;
        // long-press (contextmenu) on the map: share that spot, never while a drive is running
        m.on("contextmenu", (/** @type {any} */ e) => {
            if (W.NavCamera && W.NavCamera.active) return;
            const ll = e.latlng;
            W.L.popup({ closeButton: false }).setLatLng(ll).setContent(`<div class="pp-pop">This spot<br>${button({ lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) })}</div>`).openOn(m);
        });
        // a shared link opened in the app: drop a pin with the name and note
        const p = C.parseLink(W.location ? W.location.search : "");
        if (p) {
            const [, label, icon] = C.CATEGORIES.find((x) => x[0] === p.category) || C.CATEGORIES[C.CATEGORIES.length - 1];
            const html = `<div class="pp-pop"><strong>${icon} ${esc(p.name || label)}</strong>${p.note ? `<br>${esc(p.note)}` : ""}<br><small>Shared with you · MapUnite</small></div>`;
            W.L.marker([p.lat, p.lng]).addTo(m).bindPopup(html).openPopup();
            m.setView([p.lat, p.lng], 16);
        }
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireMap); else wireMap();

    return { core: C, open, button, get sharedCount() { try { return Number(localStorage.getItem(COUNT_KEY)) || 0; } catch (e) { return 0; } } };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).MUPlaceShare = MUPlaceShare;
if (typeof module === "object" && module.exports) module.exports = { MUPlaceShareCore };
