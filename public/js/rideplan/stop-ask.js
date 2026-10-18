/* ============================================================================
   MapUnite — "Did you stop at …?" after a ride (rider ratings, opt-in)
   ==============================================================================
   When a ride ends ("mu:trip-end"), the phone looks at its own track for long
   stops: 10 minutes or more within ~80 m, not the start or the end of the ride.
   A stop is NOT a visit (traffic, a closed gate, a friend's house): nothing is
   rated or sent because of it. It only lets the app ASK, later, once the ride
   is over and the rider isn't driving:
       "You stopped for 18 min around 10:42. Was it at one of these?"
   with the OpenStreetMap places within 150 m of the stop (from our server,
   /api/master/ratings/candidates, which keeps nothing). Only if the rider picks
   a place AND gives 👍 / 👎 (with optional tags from a fixed list) is anything
   sent: the place's OSM id, the verdict and the tags, under a random rater
   token made on this phone. Never the ride, never the time.
   "Not now" asks again in 6 hours; "Don't ask about this stop" forgets it;
   "Stop asking me" turns the whole thing off. Pending stops are forgotten after
   7 days. Kept on this phone: localStorage "mu.stopask.v1".
   StopAskCore (pure, tested): findStops(), raterToken().
   ============================================================================ */
"use strict";

const StopAskCore = (() => {
    const R = 6371008.8, RAD = Math.PI / 180;
    const dist = (a, b) => {
        const dLat = (b.lat - a.lat) * RAD, dLng = (b.lng - a.lng) * RAD;
        const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
    };
    /**
     * Long stops in a ride's track: ≥ minMs within radiusM of where the stop began, not touching the first or last
     * point (leaving home, arriving). Pure.
     * @param {Array<{ ts: number, lat: number, lng: number }>} pts
     * @param {{ minMs?: number, radiusM?: number, max?: number }} [o]
     * @returns {Array<{ lat: number, lng: number, startTs: number, endTs: number, durMin: number }>}
     */
    function findStops(pts, o = {}) {
        const minMs = o.minMs ?? 10 * 60000, radiusM = o.radiusM ?? 80, max = o.max ?? 3;
        const p = (pts || []).filter((x) => x && Number.isFinite(x.ts) && Number.isFinite(x.lat) && Number.isFinite(x.lng));
        const out = [];
        let i = 0;
        while (i < p.length) {
            let j = i + 1;
            while (j < p.length && dist(p[i], p[j]) <= radiusM) j++;
            const last = j - 1;
            if (last > i && p[last].ts - p[i].ts >= minMs) {
                if (i > 0 && last < p.length - 1) {
                    const seg = p.slice(i, last + 1);
                    out.push({ lat: seg.reduce((a, x) => a + x.lat, 0) / seg.length, lng: seg.reduce((a, x) => a + x.lng, 0) / seg.length, startTs: p[i].ts, endTs: p[last].ts, durMin: Math.round((p[last].ts - p[i].ts) / 60000) });
                }
                i = j;
            } else i++;
        }
        return out.sort((a, b) => b.durMin - a.durMin).slice(0, max).sort((a, b) => a.startTs - b.startTs);
    }
    /** A random rater token (base64url, 32 chars). @param {{ getRandomValues: (a: Uint8Array) => Uint8Array }} cryptoObj */
    function raterToken(cryptoObj) {
        const b = cryptoObj.getRandomValues(new Uint8Array(24));
        let s = "";
        for (const x of b) s += String.fromCharCode(x);
        return (typeof btoa === "function" ? btoa(s) : Buffer.from(s, "binary").toString("base64")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    return { findStops, raterToken };
})();

const StopAsk = (() => {
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : null);
    if (!W || !W.document) return { core: StopAskCore };
    const C = StopAskCore;
    const KEY = "mu.stopask.v1", DAY = 86400000;
    const TAGS = { good: [["clean", "Clean"], ["good-food", "Good food"], ["fair-price", "Fair price"], ["friendly", "Friendly"], ["honest-work", "Honest work"], ["quick", "Quick"], ["safe-parking", "Safe parking"], ["clean-toilets", "Clean toilets"]],
        bad: [["dirty", "Dirty"], ["overcharged", "Overcharged"], ["rude", "Rude"], ["poor-work", "Poor work"], ["slow", "Slow"], ["unsafe", "Unsafe"]] };

    function load() { try { const s = JSON.parse(localStorage.getItem(KEY) || "{}"); return { off: s.off === true, rater: typeof s.rater === "string" ? s.rater : null, pending: Array.isArray(s.pending) ? s.pending : [] }; } catch (e) { return { off: false, rater: null, pending: [] }; } }
    function save(st) { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* private mode */ } }
    const api = (p) => `${W.MU_SERVER_ORIGIN || W.location.origin}/api/master/ratings/${p}`;
    const post = async (p, body) => { try { const r = await fetch(api(p), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return await r.json(); } catch (e) { return null; } };
    const driving = () => { try { return (typeof navState !== "undefined" && navState.active) || (typeof SmartDrive !== "undefined" && SmartDrive.trip && SmartDrive.trip.active); } catch (e) { return false; } };
    const time = (ms) => new Date(ms).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
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

    // a ride ended: remember its long stops (rounded to ~11 m), ask later
    document.addEventListener("mu:trip-end", (e) => {
        const st = load();
        if (st.off) return;
        const d = /** @type {CustomEvent} */ (e).detail || {};
        const stops = C.findStops(d.points || []);
        const t = Date.now();
        for (const s of stops) st.pending.push({ id: `${s.startTs}`, lat: Math.round(s.lat * 1e4) / 1e4, lng: Math.round(s.lng * 1e4) / 1e4, at: s.startTs, durMin: s.durMin, added: t, snooze: t + 2 * 60000 });
        st.pending = st.pending.filter((p) => t - p.added < 7 * DAY).slice(-6);
        save(st);
    });

    let card = null, sheet = null;
    function dropStop(id) { const st = load(); st.pending = st.pending.filter((p) => p.id !== id); save(st); }
    function snooze(id) { const st = load(); const p = st.pending.find((x) => x.id === id); if (p) p.snooze = Date.now() + 6 * 3600000; save(st); }
    function closeAll() { if (card) { card.remove(); card = null; } if (sheet) { sheet.remove(); sheet = null; } }

    function check() {
        if (card || sheet || driving() || document.hidden) return;
        const st = load();
        if (st.off) return;
        const t = Date.now();
        st.pending = st.pending.filter((p) => t - p.added < 7 * DAY);
        const p = st.pending.find((x) => x.snooze <= t);
        if (!p) return;
        card = h("div", { class: "sa-card", role: "dialog", "aria-label": "A question about your last ride" }, [
            h("p", { class: "sa-q", text: `On your last ride you stopped for ${p.durMin} min around ${time(p.at)}. Was it at a place you'd like to rate for other riders?` }),
            h("div", { class: "sa-row" }, [
                h("button", { type: "button", class: "sa-btn primary", text: "Tell us", onclick: () => ask(p) }),
                h("button", { type: "button", class: "sa-btn", text: "Not now", onclick: () => { snooze(p.id); closeAll(); } }),
                h("button", { type: "button", class: "sa-btn", text: "Don't ask about this stop", onclick: () => { dropStop(p.id); closeAll(); } })
            ]),
            h("button", { type: "button", class: "sa-link", text: "Stop asking me after rides", onclick: () => { const s = load(); s.off = true; s.pending = []; save(s); closeAll(); } })
        ]);
        document.body.append(card);
    }

    async function ask(p) {
        if (card) { card.remove(); card = null; }
        const body = h("div", { class: "sa-body" }, [h("p", { class: "sa-q", text: "Looking up places near that stop…" })]);
        sheet = h("div", { class: "sa-sheet", role: "dialog", "aria-modal": "true", "aria-label": "Did you stop here?" }, [body]);
        document.body.append(sheet);
        const res = await post("candidates", { lat: p.lat, lng: p.lng });
        const places = res && res.ok ? res.places : null;
        if (!places) { body.replaceChildren(h("p", { class: "sa-q", text: "Couldn't look that up right now. We'll ask again later." }), h("button", { type: "button", class: "sa-btn", text: "OK", onclick: () => { snooze(p.id); closeAll(); } })); return; }
        if (!places.length) { dropStop(p.id); body.replaceChildren(h("p", { class: "sa-q", text: "No mapped places near that stop, so there's nothing to rate. Thanks!" }), h("button", { type: "button", class: "sa-btn", text: "OK", onclick: closeAll })); return; }
        body.replaceChildren(
            h("p", { class: "sa-q", text: `Did you stop at one of these? (${p.durMin} min around ${time(p.at)})` }),
            ...places.map((pl) => h("button", { type: "button", class: "sa-place", onclick: () => rate(p, pl) }, [h("b", { text: pl.name }), h("span", { text: `${pl.cat === "food" ? "Food" : pl.cat === "fuel" ? "Fuel" : pl.cat === "hotel" ? "Stay" : pl.cat === "hospital" ? "Hospital" : "Mechanic"} · ${pl.distanceM} m from where you stopped` })])),
            h("button", { type: "button", class: "sa-btn", text: "None of these", onclick: () => { dropStop(p.id); closeAll(); } }),
            h("button", { type: "button", class: "sa-link", text: "Not now", onclick: () => { snooze(p.id); closeAll(); } })
        );
    }

    function rate(p, pl) {
        const body = sheet.querySelector(".sa-body");
        let up = null; const picked = new Set();
        const tags = h("div", { class: "sa-tags" });
        const send = h("button", { type: "button", class: "sa-btn primary", text: "Send", disabled: true, onclick: async () => {
            const st = load();
            if (!st.rater) { st.rater = C.raterToken(W.crypto); save(st); }
            send.disabled = true;
            const r = await post("submit", { v: 1, rater: load().rater, place: { id: pl.id, cat: pl.cat }, up, tags: [...picked] });
            dropStop(p.id);
            body.replaceChildren(h("p", { class: "sa-q", text: r && r.ok ? `Thanks! Shared anonymously: other riders will see how riders rate ${pl.name} once a few have.` : r && r.reason === "rated-recently" ? "You rated this place recently: thanks, that one still counts." : "Couldn't send it right now. Sorry, this stop won't be asked again." }), h("button", { type: "button", class: "sa-btn", text: "Done", onclick: closeAll }));
        } });
        const verdict = (v) => {
            up = v; picked.clear(); send.disabled = false;
            for (const b of body.querySelectorAll(".sa-v")) b.setAttribute("aria-pressed", String(b.dataset.v === String(v)));
            tags.replaceChildren(...(v ? TAGS.good : TAGS.bad).map(([id, label]) => h("button", { type: "button", class: "sa-tag", "aria-pressed": "false", text: label, onclick: (e) => {
                if (picked.has(id)) picked.delete(id); else if (picked.size < 4) picked.add(id);
                e.currentTarget.setAttribute("aria-pressed", String(picked.has(id)));
            } })));
        };
        body.replaceChildren(
            h("p", { class: "sa-q", text: `How was ${pl.name}?` }),
            h("div", { class: "sa-row" }, [h("button", { type: "button", class: "sa-btn sa-v", "data-v": "true", "aria-pressed": "false", text: "👍 Good", onclick: () => verdict(true) }), h("button", { type: "button", class: "sa-btn sa-v", "data-v": "false", "aria-pressed": "false", text: "👎 Not good", onclick: () => verdict(false) })]),
            tags,
            h("p", { class: "sa-note", text: "Only the place, your 👍/👎 and these tags are sent, under a random code made on this phone. Not your ride, not the time." }),
            h("div", { class: "sa-row" }, [send, h("button", { type: "button", class: "sa-btn", text: "Cancel", onclick: () => { snooze(p.id); closeAll(); } })])
        );
    }

    setInterval(check, 60000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) setTimeout(check, 1500); });
    document.addEventListener("mu:drive-state", () => { if (driving()) closeAll(); else setTimeout(check, 3000); });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(check, 5000)); else setTimeout(check, 5000);

    return { core: C, check, closeAll };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).StopAsk = StopAsk;
if (typeof module === "object" && module.exports) module.exports = { StopAskCore };
