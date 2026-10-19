/* ============================================================================
   MapUnite — a shared place, opened
   ==============================================================================
   A link from "Share place" (js/passport/place-share.js) opens here:
     - a glass pin with the place's kind, and a card: its name, the note, who
       shared it, and the road from you (distance and time, the route drawn
       on the map once your position is known);
     - Navigate: the usual route preview, then Start;
     - when the sharer allowed it: "Pair with Satyam?". Pairing asks the
       sharer on their phone (they say yes or no); once paired, both phones
       are asked who's riding (js/pin/pillion.js).
   Nothing is sent anywhere until the rider taps Pair or Navigate.
   ============================================================================ */
"use strict";

const SharedPlace = (() => {
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : null);
    const C = (() => { try { return typeof MUPlaceShareCore !== "undefined" ? MUPlaceShareCore : null; } catch (e) { return null; } })();   // a global of place-share.js
    if (!W || !W.document || !C) return {};
    const lmap = () => { try { return typeof map !== "undefined" ? map : null; } catch (e) { return null; } };
    const sock = () => { try { return typeof socket !== "undefined" ? socket : null; } catch (e) { return null; } };
    const here = () => { try { return typeof myCoords !== "undefined" && myCoords && Number.isFinite(myCoords.lat) ? myCoords : null; } catch (e) { return null; } };
    const osrm = () => { try { return typeof OSRM_BASE !== "undefined" ? OSRM_BASE : "https://router.project-osrm.org"; } catch (e) { return "https://router.project-osrm.org"; } };
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
    const km = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);
    const mins = (s) => { const m = Math.max(1, Math.round(s / 60)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`; };
    /** The link without "inv" (so a reload doesn't ask again). */
    function dropInvite() { try { const u = new URL(W.location.href); u.searchParams.delete("inv"); history.replaceState(history.state, "", u.toString()); } catch (e) { /* sandboxed */ } }

    let p = null, layers = [], card = null, routeData = null;
    function clearLayers() { const m = lmap(); for (const l of layers) { try { m.removeLayer(l); } catch (e) { /* gone */ } } layers = []; }
    function close() { clearLayers(); if (card) { card.classList.remove("in"); const c = card; setTimeout(() => c.remove(), 220); card = null; } }

    async function route(line) {
        const me = here();
        if (!me) { line.textContent = "Turn on your location to see the road from you."; return null; }
        line.textContent = "Finding the road from you…";
        const url = `${osrm()}/route/v1/driving/${me.lng},${me.lat};${p.lng},${p.lat}?overview=full&geometries=geojson&steps=true`;
        let j = null;
        try { j = typeof RoutePrefs !== "undefined" && RoutePrefs.fetchRoute ? await RoutePrefs.fetchRoute(url) : await (await fetch(url)).json(); } catch (e) { j = null; }
        const r = j && Array.isArray(j.routes) && j.routes[0];
        if (!r) { line.textContent = "Couldn't find a road route right now. Navigate will try again."; return null; }
        routeData = r;
        const m = lmap(), pts = r.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
        clearLayers();
        layers.push(W.L.polyline(pts, { color: "#1546a0", weight: 12, opacity: 1, lineCap: "round", lineJoin: "round", interactive: false }).addTo(m));
        layers.push(W.L.polyline(pts, { color: "#4b8df8", weight: 7, opacity: 1, lineCap: "round", lineJoin: "round", interactive: false, className: "spl-route" }).addTo(m));
        layers.push(W.L.circleMarker(pts[0], { radius: 7, color: "#fff", weight: 3, fillColor: "#1a6dff", fillOpacity: 1, interactive: false }).addTo(m));
        pin();
        m.fitBounds(W.L.latLngBounds(pts), { paddingTopLeft: [50, 150], paddingBottomRight: [110, 330] });   // clear of the search bar, the tools column and the card
        line.textContent = `${km(r.distance)} · ${mins(r.duration)} by road from you`;
        return r;
    }
    function pin() {
        const [, label, icon] = C.CATEGORIES.find((x) => x[0] === p.category) || C.CATEGORIES[C.CATEGORIES.length - 1];
        const mk = W.L.marker([p.lat, p.lng], {
            icon: W.L.divIcon({ className: "spl-pin", html: `<i class="spl-pulse"></i><span class="spl-bub"><span class="spl-e">${icon}</span></span>`, iconSize: [56, 64], iconAnchor: [28, 60] }),
            zIndexOffset: 900, title: p.name || label, keyboard: false
        }).addTo(lmap());
        layers.push(mk);
    }

    function show() {
        const m = lmap();
        if (!m || !W.L) return;
        const [, label, icon] = C.CATEGORIES.find((x) => x[0] === p.category) || C.CATEGORIES[C.CATEGORIES.length - 1];
        pin();
        m.setView([p.lat, p.lng], 15);
        const line = h("p", { class: "spl-route-line", text: "" });
        const nav = h("button", { type: "button", class: "spl-go", text: "🧭 Navigate", onclick: async () => {
            const r = routeData || await route(line);
            if (!r || typeof startSearchNavigation !== "function") return;
            const rd = r; close(); startSearchNavigation(p.lat, p.lng, p.name || label, rd);
        } });
        card = h("div", { class: "spl-card", role: "dialog", "aria-label": `Shared place: ${p.name || label}` }, [
            h("button", { type: "button", class: "spl-x", "aria-label": "Close", text: "✕", onclick: close }),
            h("div", { class: "spl-head" }, [h("span", { class: "spl-ic", "aria-hidden": "true", text: icon }), h("div", {}, [h("b", { class: "spl-name", text: p.name || label }), h("span", { class: "spl-kind", text: p.name ? label : "Shared place" })])]),
            p.by ? h("div", { class: "spl-by" }, [h("span", { class: "spl-av", "aria-hidden": "true", text: p.by.slice(0, 1).toUpperCase() }), h("span", { text: `Shared by ${p.by}` })]) : null,
            p.note ? h("p", { class: "spl-note", text: `“${p.note}”` }) : null,
            line,
            h("div", { class: "spl-actions" }, [nav, h("button", { type: "button", class: "spl-b", text: "Show the route", onclick: () => route(line) })])
        ]);
        document.body.append(card);
        requestAnimationFrame(() => card && card.classList.add("in"));
        // the road from you, as soon as your position is known (up to 20 s)
        let tries = 0;
        const wait = () => { if (!card) return; if (here()) route(line); else if (++tries < 40) setTimeout(wait, 500); else line.textContent = "Turn on your location to see the road from you."; };
        wait();
        if (p.invite && p.by) setTimeout(askPair, 1600);
    }

    // ---------------------------------------------------------------- "Pair with …?"
    function askPair() {
        const name = p.by;
        let sheet = null;
        const closeSheet = () => { if (sheet) { sheet.classList.remove("in"); const s = sheet; setTimeout(() => s.remove(), 200); sheet = null; } };
        const status = h("p", { class: "pin-sub spl-st", role: "status" });
        const pairBtn = h("button", { type: "button", class: "gp-item", onclick: () => request() }, [h("span", { class: "gp-ic", "aria-hidden": "true", text: "🏍️" }), h("span", { class: "gp-tx" }, [h("b", { text: `Pair with ${name}` }), h("small", { text: "Rider & pillion: the map shows you as one bike, and you choose who rides." })])]);
        sheet = h("div", { class: "gp-menu", role: "dialog", "aria-label": `Pair with ${name}?` }, [h("div", { class: "gp-card" }, [
            h("div", { class: "pin-grab" }),
            h("h2", { class: "gp-h", text: `Pair with ${name}?` }),
            h("p", { class: "pin-sub", text: `${name} shared this place with you. Going to pick them up, or riding together? ${name} will be asked on their phone.` }),
            pairBtn, status,
            h("button", { type: "button", class: "pin-cancel", text: "Not now", onclick: () => { dropInvite(); closeSheet(); } })
        ])]);
        sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });
        document.body.append(sheet);
        requestAnimationFrame(() => sheet && sheet.classList.add("in"));
        function request() {
            const s = sock();
            if (!s || !s.connected) { status.textContent = "Not connected. Try again in a moment."; return; }
            pairBtn.disabled = true;
            status.textContent = `Asking ${name}… They'll see it on their phone.`;
            const onPaired = (d) => { if (d && d.paired) { cleanup(); dropInvite(); closeSheet(); } };
            const onNo = (d) => { cleanup(); status.textContent = `${(d && d.name) || name} said not now.`; pairBtn.disabled = false; };
            const cleanup = () => { s.off("pairUpdate", onPaired); s.off("pairDeclined", onNo); clearTimeout(t); };
            const t = setTimeout(() => { cleanup(); status.textContent = `No answer from ${name} yet. Try again later.`; pairBtn.disabled = false; }, 125000);
            s.on("pairUpdate", onPaired); s.on("pairDeclined", onNo);
            s.emit("pairRequest", { token: p.invite }, (r) => {
                if (r && r.ok) return;
                cleanup(); pairBtn.disabled = false;
                status.textContent = ({
                    offline: `${name} isn't online right now. Try again later.`, expired: "This invite has run out (it lasts 24 hours).",
                    "own-invite": "That's your own place.", "no-device": "Set up your profile first.", "too-fast": "One moment, then try again."
                })[r && r.reason] || "Couldn't ask right now.";
            });
        }
    }

    function boot() {
        p = C.parseLink(W.location ? W.location.search : "");
        if (!p) return;
        const go = () => { if (lmap() && W.L) show(); else setTimeout(go, 300); };
        go();
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
    return { get place() { return p; }, close };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).SharedPlace = SharedPlace;
