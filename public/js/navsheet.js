/* ============================================================================
   MapUnite drive sheet — collapses to one compact row while driving
   ==============================================================================
   Like Google Maps' navigation: once a drive starts, #nav-bottom-sheet shrinks
   to the trip numbers (time, distance, arrival) and the Stop / voice buttons,
   so the map gets the screen. Everything else in it (bike choice, trip
   energy, Road Truth, …) is one swipe or tap away:
     - swipe the sheet up, or tap the handle or the numbers: it opens (and
       scrolls, if it's taller than the screen);
     - swipe it down (from its top, not mid-scroll), or tap the handle: it
       closes again.
   Before the drive (the route preview) the sheet stays open, as before.

   NavSheet.collapse()   when a drive starts (js/navigation.js)
   NavSheet.reset()      for a new route preview and when the drive ends

   Nothing here touches an existing element id; the handle button is added by
   this file. After every change it fires a window "resize" so the navigation
   camera and the SmartDrive HUD re-measure the free map.
   ============================================================================ */
"use strict";

const NavSheet = (() => {
    const SWIPE_PX = 28;                    // a drag this far up / down opens / closes
    let sheet = null, handle = null, driving = false, open = true;
    let drag = null;                        // { y, scrollTop, moved }

    function ensure() {
        if (sheet && sheet.isConnected) return sheet;
        sheet = document.getElementById("nav-bottom-sheet");
        if (!sheet) return null;
        handle = document.createElement("button");
        handle.type = "button";
        handle.className = "nav-sheet-handle";
        handle.setAttribute("aria-controls", "nav-bottom-sheet");
        handle.addEventListener("click", (e) => { e.stopPropagation(); if (!justSwiped()) set(!open); });
        sheet.prepend(handle);
        sheet.classList.add("has-handle");
        // tapping the numbers opens it too
        const stats = sheet.querySelector(".nav-stats");
        if (stats) stats.addEventListener("click", () => { if (driving && !open && !justSwiped()) set(true); });
        // touch events keep coming while the sheet scrolls natively (pointer events get cancelled), so a swipe
        // down at the top of an open, scrolled sheet is still seen; the mouse uses pointer events
        sheet.addEventListener("touchstart", (e) => down(e.target, e.touches[0].clientY), { passive: true });
        sheet.addEventListener("touchmove", (e) => move(e.touches[0].clientY), { passive: true });
        sheet.addEventListener("touchend", up, { passive: true });
        sheet.addEventListener("touchcancel", up, { passive: true });
        sheet.addEventListener("pointerdown", (e) => { if (e.pointerType === "mouse") down(e.target, e.clientY); });
        sheet.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") move(e.clientY); });
        sheet.addEventListener("pointerup", (e) => { if (e.pointerType === "mouse") up(); });
        return sheet;
    }

    let swipedAt = 0;
    const justSwiped = () => Date.now() - swipedAt < 450;
    function down(target, y) {
        if (!driving || (target.closest && target.closest("button:not(.nav-sheet-handle), a, input, select, textarea, [role=button]"))) return;
        drag = { y, scrollTop: sheet.scrollTop, moved: false };
    }
    function move(y) {
        if (!drag || drag.moved) return;
        const dy = y - drag.y;
        if (dy <= -SWIPE_PX && !open) { drag.moved = true; swipedAt = Date.now(); set(true); }
        else if (dy >= SWIPE_PX && open && drag.scrollTop <= 0 && sheet.scrollTop <= 0) { drag.moved = true; swipedAt = Date.now(); set(false); }
    }
    function up() { drag = null; }

    function render() {
        if (!ensure()) return;
        const collapsed = driving && !open;
        sheet.classList.toggle("is-collapsed", collapsed);
        sheet.classList.toggle("is-expanded", driving && open);
        handle.hidden = !driving;
        handle.setAttribute("aria-expanded", String(!collapsed));
        handle.setAttribute("aria-label", collapsed ? "Show more: bike, trip and road details" : "Show less");
        if (collapsed) sheet.scrollTop = 0;
        try { window.dispatchEvent(new Event("resize")); } catch (e) { /* old browser */ }
    }
    function set(v) { if (open === v) return; open = v; render(); }

    return {
        /** A drive started: shrink to the compact row. */
        collapse() { driving = true; open = false; render(); },
        /** Route preview or drive ended: the full sheet, no handle. */
        reset() { driving = false; open = true; render(); },
        expand() { set(true); },
        get collapsed() { return driving && !open; }
    };
})();

if (typeof window !== "undefined") window.NavSheet = NavSheet;
