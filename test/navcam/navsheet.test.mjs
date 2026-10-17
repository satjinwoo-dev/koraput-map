// The drive sheet (public/js/navsheet.js): while driving it shrinks to the trip numbers + Stop, like Google Maps'
// navigation; a swipe up or a tap opens the rest, a swipe down or the handle closes it. The route preview keeps it open.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

/** Just enough DOM for navsheet.js: one sheet with a stats row and a controls row. */
function fakeDom() {
    const mk = (cls = "") => {
        const set = new Set(cls.split(" ").filter(Boolean));
        const listeners = {};
        const attrs = {};
        return {
            isConnected: true, hidden: false, scrollTop: 0, children: [], className: cls, type: "",
            classList: { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)) },
            setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: (k) => attrs[k],
            addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
            fire(t, e = {}) { for (const f of listeners[t] || []) f({ stopPropagation() {}, target: this, ...e }); },
            prepend(c) { this.children.unshift(c); }, closest: () => null
        };
    };
    const stats = mk("nav-stats"), sheet = mk("nav-bottom-sheet");
    sheet.querySelector = (q) => (q === ".nav-stats" ? stats : null);
    let resizes = 0;
    const document = { getElementById: (id) => (id === "nav-bottom-sheet" ? sheet : null), createElement: () => mk() };
    const window = { dispatchEvent: () => { resizes++; } };
    const ctx = vm.createContext({ document, window, Event: class { constructor(t) { this.type = t; } }, Date });
    vm.runInContext(read("public/js/navsheet.js"), ctx);
    return { NavSheet: ctx.window.NavSheet, sheet, stats, resizes: () => resizes };
}

test("route preview: the full sheet, no handle; a drive collapses it; the handle and the numbers open it", () => {
    const { NavSheet, sheet, stats, resizes } = fakeDom();
    NavSheet.reset();
    const handle = sheet.children[0];
    assert.equal(handle.className, "nav-sheet-handle");
    assert.equal(handle.hidden, true, "no handle in the preview");
    assert.equal(sheet.classList.contains("is-collapsed"), false);

    NavSheet.collapse();
    assert.equal(NavSheet.collapsed, true);
    assert.equal(sheet.classList.contains("is-collapsed"), true);
    assert.equal(handle.hidden, false);
    assert.equal(handle.getAttribute("aria-expanded"), "false");
    assert.ok(resizes() >= 2, "the camera and HUD are told to re-measure");

    handle.fire("click");
    assert.equal(NavSheet.collapsed, false);
    assert.equal(handle.getAttribute("aria-expanded"), "true");
    assert.equal(sheet.classList.contains("is-expanded"), true, "opened mid-drive: drawn above the HUD");
    handle.fire("click");
    assert.equal(NavSheet.collapsed, true);
    stats.fire("click");
    assert.equal(NavSheet.collapsed, false, "tapping the numbers opens it");

    NavSheet.reset();
    assert.equal(sheet.classList.contains("is-collapsed"), false);
    assert.equal(handle.hidden, true);
});

test("swipes: up opens, down closes only from the top of the sheet (not mid-scroll)", () => {
    const { NavSheet, sheet } = fakeDom();
    NavSheet.collapse();
    const t = (y) => ({ touches: [{ clientY: y }] });
    sheet.fire("touchstart", t(700)); sheet.fire("touchmove", t(690)); sheet.fire("touchend");
    assert.equal(NavSheet.collapsed, true, "10 px is not a swipe");
    sheet.fire("touchstart", t(700)); sheet.fire("touchmove", t(660)); sheet.fire("touchend");
    assert.equal(NavSheet.collapsed, false, "swiped up: open");
    sheet.scrollTop = 120;
    sheet.fire("touchstart", t(300)); sheet.fire("touchmove", t(360)); sheet.fire("touchend");
    assert.equal(NavSheet.collapsed, false, "scrolling back up the content doesn't close it");
    sheet.scrollTop = 0;
    sheet.fire("touchstart", t(300)); sheet.fire("touchmove", t(340)); sheet.fire("touchend");
    assert.equal(NavSheet.collapsed, true, "swiped down from the top: closed");
    // not driving: swipes do nothing
    NavSheet.reset();
    sheet.fire("touchstart", t(300)); sheet.fire("touchmove", t(340)); sheet.fire("touchend");
    assert.equal(sheet.classList.contains("is-collapsed"), false);
});

test("wiring: loaded before navigation.js, precached, collapsed on Start, reset on preview and Stop; collapsed CSS keeps numbers + controls", () => {
    const html = read("public/index.html");
    const ns = html.indexOf('<script src="js/navsheet.js'), nav = html.indexOf('<script src="js/navigation.js');
    assert.ok(ns > 0 && nav > ns);
    assert.match(html, /\.nav-bottom-sheet\.is-collapsed > :not\(\.nav-sheet-handle\):not\(\.nav-stats\):not\(\.controls-row\) \{ display: none !important; \}/);
    assert.ok(read("public/sw.js").includes('"/js/navsheet.js"'));
    const navjs = read("public/js/navigation.js");
    const start = navjs.indexOf("startBtn.onclick");
    assert.ok(navjs.indexOf("NavSheet.collapse()") > start, "collapses when the drive starts");
    assert.ok(navjs.lastIndexOf("NavSheet.reset()", start) > 0, "the preview resets it");
    assert.ok(navjs.indexOf("NavSheet.reset()", navjs.indexOf("function stopDrive")) > 0, "Stop resets it");
});
