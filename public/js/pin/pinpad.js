/* ============================================================================
   MapUnite PIN pad — 4-digit codes, entered and shown
   ==============================================================================
   PinPad.ask({ title, subtitle, verify, successTitle, successText })
     → Promise<string|null>. Four boxes (type, paste, or the phone's one-time-code
     fill). When the fourth digit lands, the digits lift off into a ring that
     turns while the code is checked (verify(pin) → { ok, message }):
       right → the tiles go green, gather into one, a tick and a burst;
       wrong → back into the row, a shake, the reason, try again.
   PinPad.show({ title, code, subtitle, note, expiresAt, actions })
     → { update(code), close() }. A code to share, big, in glass tiles, with
     an optional countdown and buttons (Copy, Share…).
   PinCore (pure, tested): clean(), row(), ring().
   ============================================================================ */
"use strict";

const PinCore = (() => {
    /** Digits only, at most n. @param {string} v @param {number} [n] */
    const clean = (v, n = 4) => String(v || "").replace(/\D+/g, "").slice(0, n);
    /** Box centres in a row, around 0. @param {number} n @param {number} size @param {number} gap */
    const row = (n, size, gap) => Array.from({ length: n }, (_, i) => ({ x: (i - (n - 1) / 2) * (size + gap), y: 0 }));
    /** Box centres on a ring, the first at the top, clockwise. @param {number} n @param {number} r */
    const ring = (n, r) => Array.from({ length: n }, (_, i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; return { x: Math.round(Math.cos(a) * r * 100) / 100, y: Math.round(Math.sin(a) * r * 100) / 100 }; });
    return { clean, row, ring };
})();

const PinPad = (() => {
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : null);
    if (!W || !W.document) return { core: PinCore };
    const N = 4, SIZE = 52, GAP = 12, R = 62;
    const reduce = () => { try { return W.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } };
    const wait = (ms) => new Promise((r) => setTimeout(r, reduce() ? Math.min(ms, 60) : ms));
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
    const place = (el, p, rot = 0) => { el.style.transform = `translate(-50%, -50%) translate(${p.x}px, ${p.y}px) rotate(${rot}deg)`; };

    /**
     * @param {{ title: string, subtitle?: string, verify: (pin: string) => Promise<{ ok: boolean, message?: string }>,
     *   successTitle?: string, successText?: string, foot?: string }} o
     * @returns {Promise<string|null>}
     */
    function ask(o) {
        return new Promise((resolve) => {
            const boxes = Array.from({ length: N }, (_, i) => h("div", { class: "pin-box", "data-i": String(i) }, [h("span", { class: "pin-d" })]));
            const spin = h("div", { class: "pin-spin" }, boxes);
            const input = /** @type {HTMLInputElement} */ (h("input", { class: "pin-input", type: "text", inputmode: "numeric", pattern: "[0-9]*", autocomplete: "one-time-code", maxlength: String(N), "aria-label": o.title }));
            const stage = h("div", { class: "pin-stage" }, [h("div", { class: "pin-ring", "aria-hidden": "true" }), h("div", { class: "pin-dot", "aria-hidden": "true" }), spin, h("div", { class: "pin-done", "aria-hidden": "true" }, [h("div", { class: "pin-check" })]), input]);
            const title = h("h2", { class: "pin-title", text: o.title });
            const sub = h("p", { class: "pin-sub", text: o.subtitle || "" });
            const err = h("p", { class: "pin-err", role: "alert" });
            const cancel = h("button", { type: "button", class: "pin-cancel", text: "Cancel" });
            const card = h("div", { class: "pin-card", role: "dialog", "aria-modal": "true", "aria-label": o.title }, [h("div", { class: "pin-grab" }), title, sub, stage, err, o.foot ? h("p", { class: "pin-foot", text: o.foot }) : null, cancel]);
            const ov = h("div", { class: "pin-overlay" }, [card]);
            document.body.append(ov);
            const rows = PinCore.row(N, SIZE, GAP), rings = PinCore.ring(N, R);
            boxes.forEach((b, i) => place(b, rows[i]));
            let busy = false, closed = false;
            input.focus();                                  // at once: the first digit typed must not be lost
            requestAnimationFrame(() => { ov.classList.add("in"); if (document.activeElement !== input) input.focus(); });

            function paint() {
                const v = input.value;
                boxes.forEach((b, i) => {
                    /** @type {HTMLElement} */ (b.firstChild).textContent = v[i] || "";
                    b.classList.toggle("filled", Boolean(v[i]));
                    b.classList.toggle("caret", !busy && i === v.length && document.activeElement === input);
                });
            }
            function close(v) {
                if (closed) return;
                closed = true;
                ov.classList.remove("in");
                setTimeout(() => ov.remove(), reduce() ? 0 : 220);
                resolve(v);
            }
            async function submit(pin) {
                busy = true; paint();
                err.textContent = "";
                stage.classList.add("orbit");
                boxes.forEach((b, i) => place(b, rings[i], (i % 2 ? 1 : -1) * 12));
                let r;
                try { [r] = await Promise.all([o.verify(pin), wait(900)]); } catch (e) { r = { ok: false, message: "Couldn't check the code. Try again." }; }
                if (closed) return;
                if (r && r.ok) {
                    stage.classList.add("ok");
                    await wait(450);
                    stage.classList.add("done");
                    boxes.forEach((b) => place(b, { x: 0, y: 0 }, 0));
                    burst(stage);
                    title.textContent = o.successTitle || "Verified";
                    title.classList.add("ok");
                    sub.textContent = o.successText || "";
                    await wait(1300);
                    close(pin);
                    return;
                }
                stage.classList.remove("orbit");
                stage.classList.add("bad");
                boxes.forEach((b, i) => place(b, rows[i]));
                err.textContent = (r && r.message) || "That code didn't work.";
                await wait(650);
                stage.classList.remove("bad");
                input.value = ""; busy = false;
                paint(); input.focus();
            }
            input.addEventListener("input", () => {
                if (busy) { input.value = input.value.slice(0, N); return; }
                input.value = PinCore.clean(input.value, N);
                err.textContent = "";
                paint();
                if (input.value.length === N) submit(input.value);
            });
            input.addEventListener("focus", paint); input.addEventListener("blur", paint);
            stage.addEventListener("click", () => input.focus());
            cancel.addEventListener("click", () => close(null));
            ov.addEventListener("click", (e) => { if (e.target === ov && !busy) close(null); });
            ov.addEventListener("keydown", (e) => { if (e.key === "Escape" && !busy) close(null); });
            paint();
        });
    }
    /** A burst of mint sparks round the tick. @param {HTMLElement} stage */
    function burst(stage) {
        if (reduce()) return;
        for (let i = 0; i < 16; i++) {
            const a = (i / 16) * Math.PI * 2 + Math.random() * 0.4, d = 46 + Math.random() * 34;
            const s = h("i", { class: "pin-spark", "aria-hidden": "true" });
            s.style.setProperty("--dx", `${Math.cos(a) * d}px`); s.style.setProperty("--dy", `${Math.sin(a) * d}px`);
            s.style.animationDelay = `${Math.random() * 120}ms`;
            stage.append(s);
            setTimeout(() => s.remove(), 1400);
        }
    }

    /**
     * A code to share, in glass tiles.
     * @param {{ title: string, code: string, subtitle?: string, note?: string, expiresAt?: number,
     *   actions?: Array<{ label: string, onClick: (code: string) => void, primary?: boolean }>, onClose?: () => void }} o
     */
    function show(o) {
        let code = PinCore.clean(o.code, N), timer = 0;
        const tiles = h("div", { class: "pin-show", "aria-label": `Code ${code.split("").join(" ")}` });
        const draw = () => { tiles.replaceChildren(...code.split("").map((c, i) => h("span", { class: "pin-tile", style: `animation-delay:${i * 70}ms`, text: c }))); tiles.setAttribute("aria-label", `Code ${code.split("").join(" ")}`); };
        draw();
        const left = h("p", { class: "pin-sub pin-left" });
        const tick = () => {
            if (!o.expiresAt) return;
            const s = Math.max(0, Math.round((o.expiresAt - Date.now()) / 1000));
            left.textContent = s ? `Works for ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} more` : "This code has run out: make a new one.";
            if (!s && timer) { clearInterval(timer); timer = 0; }
        };
        const card = h("div", { class: "pin-card", role: "dialog", "aria-modal": "true", "aria-label": o.title }, [
            h("div", { class: "pin-grab" }), h("h2", { class: "pin-title", text: o.title }), o.subtitle ? h("p", { class: "pin-sub", text: o.subtitle }) : null,
            tiles, left, o.note ? h("p", { class: "pin-foot", text: o.note }) : null,
            h("div", { class: "pin-actions" }, [...(o.actions || []).map((a) => h("button", { type: "button", class: `pin-btn${a.primary ? " primary" : ""}`, text: a.label, onclick: () => a.onClick(code) })),
                h("button", { type: "button", class: "pin-btn", text: "Close", onclick: () => close() })])
        ]);
        const ov = h("div", { class: "pin-overlay" }, [card]);
        document.body.append(ov);
        requestAnimationFrame(() => ov.classList.add("in"));
        tick(); if (o.expiresAt) timer = W.setInterval(tick, 1000);
        let closed = false;
        function close() {
            if (closed) return;
            closed = true;
            if (timer) clearInterval(timer);
            ov.classList.remove("in");
            setTimeout(() => ov.remove(), reduce() ? 0 : 220);
            if (o.onClose) o.onClose();
        }
        ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
        return { update(c) { code = PinCore.clean(c, N); draw(); }, close, get open() { return !closed; } };
    }

    /** Share a code through the phone's share sheet, else copy it. @param {string} text */
    async function shareText(text) {
        try { if (W.MUShareOut && W.MUShareOut.available && W.MUShareOut.available()) { await W.MUShareOut.text({ text }); return "shared"; } } catch (e) { /* fall through */ }
        try { if (navigator.share) { await navigator.share({ text }); return "shared"; } } catch (e) { if (e && e.name === "AbortError") return "cancelled"; }
        try { await navigator.clipboard.writeText(text); return "copied"; } catch (e) { return "failed"; }
    }

    return { core: PinCore, ask, show, shareText };
})();

if (typeof window !== "undefined") { /** @type {any} */ (window).PinPad = PinPad; /** @type {any} */ (window).PinCore = PinCore; }
if (typeof module === "object" && module.exports) module.exports = { PinCore };
