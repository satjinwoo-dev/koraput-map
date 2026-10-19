/* ============================================================================
   MapUnite — the phone's Back button closes what's open, not the app
   ==============================================================================
   MUBack.handle() → true when it closed something

   The top-most open sheet, screen or dialog (the Ride Story, Ride Edit, a PIN
   pad, a modal, a menu …) is closed the way the rider would close it: its
   Close / Cancel button, else Escape, else a tap on its backdrop.

     - Android app: MainActivity asks MUBack first. Nothing open → navigating:
       the small window (picture-in-picture); otherwise the app goes to the
       background like Home (a ride keeps recording). It never closes the app.
     - Android Chrome and the installed web app: while something is open, a
       history entry is held, so the Back gesture closes it instead of leaving
       the page.
   ============================================================================ */
"use strict";

const MUBack = (() => {
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : null);
    if (!W || !W.document) return { handle: () => false, top: () => null };
    const LAYERS = ".modal, [role=\"dialog\"], [aria-modal=\"true\"], .rs-modal, .re-modal, .gp-menu";
    const CLOSERS = "[aria-label=\"Close\" i], .rs-x, .re-x, .spl-x, .sh-close, .rds-close, .close-modal, .pin-cancel, [data-close], .gp-cancel";

    function shown(el) {
        if (!el || !el.isConnected || el.hidden || el.closest("[hidden]")) return false;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }
    /** The stacking z-index of an element (its own or the nearest positioned ancestor's). */
    function zOf(el) {
        for (let e = el; e && e !== document.body; e = e.parentElement) {
            const z = Number.parseInt(getComputedStyle(e).zIndex, 10);
            if (Number.isFinite(z)) return z;
        }
        return 0;
    }
    /** The open layer on top, or null. */
    function top() {
        let best = null, bz = -Infinity;
        document.querySelectorAll(LAYERS).forEach((el) => {
            // a dialog inside another open layer counts as that layer
            if (el.parentElement && el.parentElement.closest(LAYERS) && shown(el.parentElement.closest(LAYERS))) return;
            if (!shown(el)) return;
            const z = zOf(el);
            if (z >= bz) { bz = z; best = el; }                        // later in the page wins a tie
        });
        return best;
    }
    function handle() {
        const el = top();
        if (!el) return false;
        const btn = [...el.querySelectorAll(CLOSERS)].find((b) => shown(b) && !b.disabled);
        if (btn) { btn.click(); return true; }
        const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
        el.dispatchEvent(esc);
        if (!esc.defaultPrevented && shown(el) && !el.classList.contains("closing")) el.dispatchEvent(new MouseEvent("click", { bubbles: true }));   // a backdrop tap
        return true;
    }

    // ---- browsers: hold one history entry while something is open --------------
    const native = () => { try { const C = W.capacitorExports && W.capacitorExports.Capacitor; return Boolean(C && C.isNativePlatform && C.isNativePlatform()); } catch (e) { return false; } };
    const touch = () => { try { return W.matchMedia("(pointer: coarse)").matches; } catch (e) { return false; } };
    let armed = false, skip = false, timer = 0;
    function sync() {
        timer = 0;
        if (native()) return;
        const open = Boolean(top());
        if (open && !armed) { try { history.pushState({ ...(history.state || {}), muBack: true }, ""); armed = true; } catch (e) { /* sandboxed */ } }
        else if (!open && armed && history.state && history.state.muBack) { skip = true; armed = false; history.back(); }   // closed by a tap: drop the held entry
    }
    function boot() {
        if (!touch() || typeof MutationObserver !== "function") return;
        new MutationObserver(() => { if (!timer) timer = setTimeout(sync, 120); }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden"] });
        W.addEventListener("popstate", () => {
            if (skip) { skip = false; return; }
            if (!armed) return;
            armed = false;
            if (handle()) setTimeout(sync, 400);                       // something else still open: hold again
        });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
    return { handle, top };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).MUBack = MUBack;
