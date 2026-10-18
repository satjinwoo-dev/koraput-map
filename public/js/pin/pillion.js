/* ============================================================================
   MapUnite rider + pillion — two phones on one bike, paired with a 4-digit code
   ==============================================================================
   One phone shows a code (10 minutes, one use); the other types it. Then BOTH
   are asked "Who's riding?" (either can answer; either can swap later):
     - on the map, everyone sees one bike: the rider's marker with "+1", the
       pillion's own marker tucked under it;
     - on the rider's phone the trip's fuel estimate counts the pillion;
     - in a group ride the pillion is listed with the rider.
   The pairing lives on the server while it runs and comes back after a
   reconnect (the same phone); "Unpair" ends it.
   ============================================================================ */
"use strict";

const Pillion = (() => {
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : null);
    if (!W || !W.document) return {};
    const sock = () => { try { return typeof socket !== "undefined" ? socket : null; } catch (e) { return null; } };
    const toast = (m, ms) => { try { if (typeof showToast === "function") showToast(m, ms); } catch (e) { /* no toasts */ } };
    /** @type {{ paired: boolean, partner?: { name: string, id: string|null, online: boolean }, role?: "rider"|"pillion"|null, askRole?: boolean }} */
    let st = { paired: false };
    let showing = null, chooser = null, listening = false;
    const MSG = {
        "wrong-code": (r) => `That code didn't match. ${r.triesLeft} ${r.triesLeft === 1 ? "try" : "tries"} left.`,
        "too-many-tries": () => "Too many wrong tries. Wait 10 minutes.",
        "own-code": () => "That's this phone's own code: type it on the other phone.",
        "no-device": () => "Set up your profile first.",
        "bad-code": () => "The code is 4 digits."
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
    const emitAck = (ev, data) => new Promise((resolve) => {
        const s = sock();
        if (!s) return resolve({ ok: false, reason: "offline" });
        const t = setTimeout(() => resolve({ ok: false, reason: "timeout" }), 7000);
        s.emit(ev, data, (r) => { clearTimeout(t); resolve(r || { ok: false }); });
    });

    function listen() {
        const s = sock();
        if (!s || listening) return;
        listening = true;
        // someone opened a place this phone shared and asks to pair (js/passport/shared-place.js): yes or no
        s.on("pairAsk", (d) => {
            if (!d || !d.reqId) return;
            const answer = async (accept) => { close(); const r = await emitAck("pairAnswer", { reqId: d.reqId, accept }); if (!r.ok && accept) toast("That request has run out."); };
            const m = h("div", { class: "gp-menu", role: "dialog", "aria-label": `${d.from} wants to pair` }, [h("div", { class: "gp-card" }, [
                h("div", { class: "pin-grab" }),
                h("h2", { class: "gp-h", text: `${d.from} wants to pair with you` }),
                h("p", { class: "pin-sub", text: `${d.from} opened the place you shared. Pair as rider & pillion? Then you both choose who rides.` }),
                h("div", { class: "pl-pair" }, [
                    h("button", { type: "button", class: "pl-who on", onclick: () => answer(true) }, [h("span", { class: "pl-ic", "aria-hidden": "true", text: "🤝" }), h("b", { text: "Pair" }), h("small", { text: `with ${d.from}` })]),
                    h("button", { type: "button", class: "pl-who", onclick: () => answer(false) }, [h("span", { class: "pl-ic", "aria-hidden": "true", text: "✋" }), h("b", { text: "Not now" }), h("small", { text: "They'll be told" })])
                ])
            ])]);
            const close = () => { m.classList.remove("in"); setTimeout(() => m.remove(), 200); };
            document.body.append(m);
            requestAnimationFrame(() => m.classList.add("in"));
            setTimeout(() => { if (m.isConnected) close(); }, 120000);
        });
        s.on("pairUpdate", (d) => {
            const prev = st;
            st = d && d.paired ? d : { paired: false };
            if (st.paired && showing) { showing.close(); showing = null; }
            if (st.paired && st.askRole) openChooser();
            if (st.paired && st.role && chooser) closeChooser();
            if (st.paired && st.role && (!prev.paired || prev.role !== st.role)) {
                toast(st.role === "rider" ? `🏍️ You're riding · ${st.partner.name} is your pillion` : `🧍 You're the pillion · ${st.partner.name} is riding`, 4500);
                document.dispatchEvent(new CustomEvent("mu:pillion", { detail: { role: st.role, partner: st.partner.name } }));
            }
            if (!st.paired && prev.paired) {
                toast(`Unpaired from ${prev.partner ? prev.partner.name : "your partner"}.`, 3500);
                document.dispatchEvent(new CustomEvent("mu:pillion", { detail: { role: null } }));
            }
        });
    }

    // ---------------------------------------------------------------- "Who's riding?"
    function closeChooser() { if (chooser) { chooser.classList.remove("in"); const c = chooser; setTimeout(() => c.remove(), 200); chooser = null; } }
    function openChooser() {
        if (chooser || !st.paired) return;
        const pick = async (rider) => { const r = await emitAck("pairRole", { rider }); if (!r.ok) toast("Couldn't save that. Try again."); };
        const card = (who, icon, title, sub, rider, on) => h("button", { type: "button", class: `pl-who${on ? " on" : ""}`, onclick: () => pick(rider) }, [h("span", { class: "pl-ic", "aria-hidden": "true", text: icon }), h("b", { text: title }), h("small", { text: sub })]);
        chooser = h("div", { class: "gp-menu", role: "dialog", "aria-label": "Who's riding?" }, [
            h("div", { class: "gp-card" }, [
                h("div", { class: "pin-grab" }),
                h("h2", { class: "gp-h", text: "Who's riding?" }),
                h("p", { class: "pin-sub", text: `You and ${st.partner ? st.partner.name : "your partner"} are on one bike. Either of you can answer, and swap later.` }),
                h("div", { class: "pl-pair" }, [
                    card("me", "🏍️", "Me", "I'm riding", "me", st.role === "rider"),
                    card("partner", "🧍", st.partner ? st.partner.name : "Partner", "is riding", "partner", st.role === "pillion")
                ]),
                h("button", { type: "button", class: "pin-cancel", text: "Later", onclick: closeChooser })
            ])
        ]);
        document.body.append(chooser);
        requestAnimationFrame(() => chooser && chooser.classList.add("in"));
    }

    // ---------------------------------------------------------------- pairing
    async function showCode() {
        const r = await emitAck("pairCreate", {});
        if (!r.ok || !r.code) { toast(MSG[r.reason] ? MSG[r.reason](r) : "Couldn't make a code right now."); return; }
        showing = PinPad.show({
            title: "Your pairing code", code: r.code, expiresAt: r.expiresAt,
            subtitle: "On the other phone: 🏁 Group → Rider & pillion → I have a code.",
            note: "Waiting for the other phone…",
            actions: [{ label: "Share", primary: true, onClick: (c) => PinPad.shareText(`MapUnite rider & pillion code: ${c}`) }],
            onClose: () => { showing = null; }
        });
    }
    function enterCode() {
        PinPad.ask({
            title: "Enter the code", subtitle: "The 4-digit code on your partner's phone.",
            successTitle: "Paired", successText: "Now say who's riding.",
            verify: async (pin) => { const r = await emitAck("pairJoin", { code: pin }); return r.ok ? { ok: true } : { ok: false, message: MSG[r.reason] ? MSG[r.reason](r) : "Couldn't pair right now." }; }
        });
    }

    /** The Rider & pillion sheet: pair, or (paired) who rides, swap, unpair. */
    function open() {
        listen();
        const close = () => { m.classList.remove("in"); setTimeout(() => m.remove(), 200); };
        const item = (icon, title, sub, fn) => h("button", { type: "button", class: "gp-item", onclick: () => { close(); fn(); } }, [h("span", { class: "gp-ic", "aria-hidden": "true", text: icon }), h("span", { class: "gp-tx" }, [h("b", { text: title }), h("small", { text: sub })])]);
        const body = st.paired ? [
            h("div", { class: "pl-status" }, [
                h("span", { class: "pl-badge", text: st.role === "rider" ? "🏍️" : st.role === "pillion" ? "🧍" : "🔗" }),
                h("span", {}, [h("b", { text: `Paired with ${st.partner.name}` }), h("small", { text: st.role ? (st.role === "rider" ? "You're riding" : `You're the pillion · ${st.partner.name} is riding`) : "Not decided who's riding" })])
            ]),
            item("🔄", st.role ? "Swap rider and pillion" : "Say who's riding", st.role ? `Make ${st.role === "rider" ? st.partner.name : "me"} the rider` : "Ask on both phones", () => (st.role ? emitAck("pairRole", { rider: st.role === "rider" ? "partner" : "me" }) : openChooser())),
            item("✂️", "Unpair", "Two separate riders again", () => emitAck("pairLeave", {}))
        ] : [
            h("p", { class: "pin-sub", text: "Two phones on one bike. Pair them so the map shows one bike, and say who's riding." }),
            item("🔢", "Show my code", "The other phone types it", showCode),
            item("⌨️", "I have a code", "Type the code from the other phone", enterCode)
        ];
        const m = h("div", { class: "gp-menu", role: "dialog", "aria-label": "Rider & pillion" }, [h("div", { class: "gp-card" }, [h("div", { class: "pin-grab" }), h("h2", { class: "gp-h", text: "Rider & pillion" }), ...body, h("button", { type: "button", class: "pin-cancel", text: "Close", onclick: () => close() })])]);
        m.addEventListener("click", (e) => { if (e.target === m) close(); });
        document.body.append(m);
        requestAnimationFrame(() => m.classList.add("in"));
    }

    // start listening once the socket exists (core.js makes it)
    const boot = () => { if (sock()) listen(); else setTimeout(boot, 500); };
    boot();
    return { open, status: () => ({ ...st }), openChooser };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).Pillion = Pillion;
