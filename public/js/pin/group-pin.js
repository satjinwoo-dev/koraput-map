/* ============================================================================
   MapUnite group PIN — a 4-digit password to join a group ride
   ==============================================================================
   The server gives every group ride a 4-digit PIN when it starts. Only the
   riders in it see the PIN (to share it); everyone else must type it to join:
     - tapping "Join Trip" on the ride shown on the map opens the PIN pad;
     - "Join with a PIN" in the Group menu finds the ride by its PIN alone.
   Wrong PINs: 5 tries per phone in 10 minutes; after 20 wrong tries against one
   ride its PIN changes and the host is told. The host can make a new PIN.
   The Group menu (the 🏁 button) also starts a ride and pairs rider + pillion.
   ============================================================================ */
"use strict";

const GroupPin = (() => {
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : null);
    if (!W || !W.document) return {};
    const sock = () => { try { return typeof socket !== "undefined" ? socket : null; } catch (e) { return null; } };
    let pending = false;
    const MSG = {
        "wrong-pin": (e) => `Wrong PIN. ${e.triesLeft} ${e.triesLeft === 1 ? "try" : "tries"} left.`,
        "too-many-tries": () => "Too many wrong tries. Wait 10 minutes and try again.",
        "no-trip": () => "No group ride with that PIN right now.",
        "bad-pin": () => "The PIN is 4 digits.",
        "already-in-trip": () => "You're already in a group ride: leave it first.",
        "pin-required": () => "This ride needs its PIN."
    };
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

    /** One join attempt: in (tripData with me in it) or why not (tripError). */
    function attempt(tripId, pin) {
        const s = sock();
        if (!s) return Promise.resolve({ ok: false, message: "Not connected." });
        return new Promise((resolve) => {
            let done = false;
            const finish = (r) => { if (done) return; done = true; clearTimeout(t); s.off("tripData", onData); s.off("tripError", onErr); resolve(r); };
            const onData = (trip) => { if (trip && trip.members && trip.members.some((m) => m.id === s.id)) finish({ ok: true, trip }); };
            const onErr = (e) => { const f = MSG[e && e.reason]; finish({ ok: false, message: f ? f(e) : "Couldn't join that ride." }); };
            const t = setTimeout(() => finish({ ok: false, message: "No answer from the server. Check your connection." }), 7000);
            s.on("tripData", onData); s.on("tripError", onErr);
            s.emit("joinTrip", tripId ? { tripId, pin } : { pin });
        });
    }
    /** The PIN pad for a ride (tripId) or for any ride with that PIN. @param {{ tripId?: string, name?: string }} [o] */
    async function join(o = {}) {
        if (typeof PinPad === "undefined" || !PinPad.ask) return;
        pending = true;
        let joined = null;
        await PinPad.ask({
            title: o.name ? `Join “${o.name}”` : "Join a group ride",
            subtitle: "Enter the group's 4-digit PIN. The host and every rider in the group can see it.",
            successTitle: "You're in", successText: "Riding together. The group is on your map.",
            verify: async (pin) => { const r = await attempt(o.tripId, pin); if (r.ok) joined = r.trip; return r; }
        });
        pending = false;
        return joined;
    }

    /** The PIN in the trip panel, for the riders in it: digits, Share, and New PIN for the host. @param {any} trip @param {boolean} isHost */
    function row(trip, isHost) {
        if (!trip || !trip.pin) return null;
        const share = () => PinPad.shareText(`Join my MapUnite group ride "${trip.name}": Group → Join with a PIN → ${trip.pin}`).then((r) => { if (r === "copied" && typeof showToast === "function") showToast("📋 Group PIN copied."); });
        return h("div", { class: "gp-row", id: "trip-pin-row" }, [
            h("span", { class: "gp-l", text: "Group PIN" }),
            h("span", { class: "gp-digits", "aria-label": `Group PIN ${trip.pin.split("").join(" ")}` }, trip.pin.split("").map((d) => h("b", { text: d }))),
            h("button", { type: "button", class: "gp-b", text: "Share", onclick: share }),
            isHost ? h("button", { type: "button", class: "gp-b ghost", title: "Make a new PIN: the old one stops working", "aria-label": "Make a new group PIN", text: "↻", onclick: () => { const s = sock(); if (s) s.emit("renewTripPin"); } }) : null
        ]);
    }
    /** Put the PIN row under the trip title (members), or take it away. @param {any} trip */
    function renderRow(trip) {
        const old = document.getElementById("trip-pin-row");
        if (old) old.remove();
        const s = sock();
        if (!trip || !s || !trip.pin || !trip.members.some((m) => m.id === s.id)) return;
        const r = row(trip, trip.hostId === s.id);
        const panel = document.getElementById("trip-panel");
        const head = panel && panel.querySelector(".modal-row");
        if (r && head) head.after(r);
    }

    // ---------------------------------------------------------------- the Group menu (🏁)
    let menuEl = null;
    /** @param {{ start: () => void }} o */
    function menu(o) {
        if (menuEl) { menuEl.remove(); menuEl = null; return; }
        const close = () => { if (menuEl) { menuEl.classList.remove("in"); const m = menuEl; setTimeout(() => m.remove(), 200); menuEl = null; } };
        const pair = typeof Pillion !== "undefined" && Pillion.status ? Pillion.status() : null;
        const item = (icon, title, sub, fn) => h("button", { type: "button", class: "gp-item", onclick: () => { close(); fn(); } }, [h("span", { class: "gp-ic", "aria-hidden": "true", text: icon }), h("span", { class: "gp-tx" }, [h("b", { text: title }), h("small", { text: sub })])]);
        menuEl = h("div", { class: "gp-menu", role: "dialog", "aria-label": "Group" }, [
            h("div", { class: "gp-card" }, [
                h("div", { class: "pin-grab" }),
                h("h2", { class: "gp-h", text: "Ride together" }),
                item("🏁", "Start a group ride", "Tap the map for where you're going. You get a 4-digit PIN to share.", o.start),
                item("🔢", "Join with a PIN", "Type the group's 4-digit PIN.", () => join({})),
                item("🏍️", "Rider & pillion", pair && pair.paired ? `Paired with ${pair.partner.name}${pair.role ? ` · you're the ${pair.role}` : ""}` : "Two phones, one bike: pair with a 4-digit code.", () => { if (typeof Pillion !== "undefined") Pillion.open(); }),
                h("button", { type: "button", class: "pin-cancel", text: "Close", onclick: close })
            ])
        ]);
        menuEl.addEventListener("click", (e) => { if (e.target === menuEl) close(); });
        document.body.append(menuEl);
        requestAnimationFrame(() => menuEl && menuEl.classList.add("in"));
    }

    return { join, attempt, row, renderRow, menu, get pending() { return pending; }, MSG };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).GroupPin = GroupPin;
