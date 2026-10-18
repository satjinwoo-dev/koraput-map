// Navigation, minimized (public/js/navpip/): what the small window and the live notification say, when they
// update, the turn arrow's shapes, and the wiring (web, service worker, Android plugin, MainActivity, setup script).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../../public/js/navpip/navpip-core.js");
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("distances count down like a navigator's; times and turn kinds", () => {
    assert.equal(P.distanceText(4), "10 m");
    assert.equal(P.distanceText(184), "180 m");
    assert.equal(P.distanceText(640), "650 m");
    assert.equal(P.distanceText(1450), "1.4 km");
    assert.equal(P.distanceText(23500), "24 km");
    assert.equal(P.durationText(18 * 60), "18 min");
    assert.equal(P.durationText(65 * 60), "1 h 05 min");
    assert.deepEqual([0, -40, -90, -135, 40, 90, 135, 180].map((d) => P.turnKind(d)), ["straight", "slight-left", "left", "sharp-left", "slight-right", "right", "sharp-right", "uturn"]);
    assert.equal(P.turnKind(-90, true), "arrive");
});

test("the card and the notification: the next turn, then, arrival, what's left, progress", () => {
    const now = Date.UTC(2026, 9, 18, 11, 0);
    const c = P.card({ nextManeuver: "Turn left onto NH-26", nextManeuverM: 184, thenText: "Then arrive at Araku", nextTurnDeg: -90, remainingM: 12400, etaSec: 18 * 60, destName: "Araku", totalM: 31000 }, now);
    assert.equal(c.distance, "180 m");
    assert.equal(c.instruction, "Turn left onto NH-26");
    assert.equal(c.turn, "left");
    assert.equal(c.left, "12 km · 18 min");
    assert.ok(Math.abs(c.progress - 0.6) < 1e-9);
    assert.match(c.eta, /\d{1,2}:\d\d\s?(AM|PM)/);
    const n = P.notice(c);
    assert.equal(n.title, "180 m · Turn left onto NH-26");
    assert.match(n.text, /^Then arrive at Araku · Arrive .+ · 12 km · 18 min$/);
    // the last stretch: "Arrive at …" with the distance to the destination
    const a = P.card({ nextManeuver: "", remainingM: 640, etaSec: 90, destName: "Araku" }, now);
    assert.equal(a.instruction, "Arrive at Araku");
    assert.equal(a.distance, "650 m");
    assert.equal(a.turn, "arrive");
    assert.equal(a.progress, null, "no total, no bar");
});

test("updates only when worth it: a new turn, the distance's next step, the arrival minute", () => {
    const now = Date.UTC(2026, 9, 18, 11, 0, 0);
    const s = { nextManeuver: "Turn left", nextManeuverM: 184, nextTurnDeg: -90, remainingM: 5000, etaSec: 600 };
    const a = P.card(s, now);
    assert.equal(P.changed(a, P.card({ ...s, nextManeuverM: 182 }, now)), false, "182 m still reads 180 m");
    assert.equal(P.changed(a, P.card({ ...s, nextManeuverM: 170 }, now)), true);
    assert.equal(P.changed(a, P.card({ ...s, nextManeuver: "Keep right", nextTurnDeg: 40 }, now)), true);
    assert.equal(P.changed(a, P.card({ ...s, etaSec: 600 }, now + 70000)), true, "the arrival minute moved");
    assert.equal(P.changed(null, a), true);
});

test("the turn arrow: a shaft that bends the way of the turn, a head at its end; a pin to arrive", () => {
    const l = P.arrowPath("left"), r = P.arrowPath("right"), s = P.arrowPath("straight"), u = P.arrowPath("uturn");
    assert.ok(l.shaft.at(-1)[0] < 50 && r.shaft.at(-1)[0] > 50, "left goes left, right goes right");
    assert.equal(s.shaft.length, 2);
    assert.ok(l.head[1][0] < l.shaft.at(-1)[0], "the tip is beyond the shaft's end");
    assert.ok(u.shaft.length > 5 && u.head.length === 3);
    assert.equal(P.arrowPath("arrive").pin, true);
    for (const a of [l, r, s, u]) for (const p of [...a.shaft, ...a.head]) assert.ok(p[0] >= 0 && p[0] <= 100 && p[1] >= 0 && p[1] <= 100, "inside the square");
});

test("the wiring: page, offline cache, navigation's state, the service worker's Stop, the Android plugin and its setup", async () => {
    const html = read("public/index.html"), sw = read("public/sw.js"), nav = read("public/js/navigation.js"), js = read("public/js/navpip/navpip.js");
    for (const f of ["navpip-core.js", "navpip.js"]) { assert.match(html, new RegExp(`js/navpip/${f.replace(".", "\\.")}\\?v=`)); assert.ok(sw.includes(`"/js/navpip/${f}"`)); }
    assert.ok(html.indexOf("js/navpip/navpip-core.js") < html.indexOf("js/navpip/navpip.js?"));
    assert.ok(sw.includes('"/js/navpip/navpip.css"'));
    assert.match(nav, /navState\.nextTurnDeg = maneuverRotation\(next\)/);
    assert.match(nav, /navState\.totalM = routeData\.distance/);
    assert.match(sw, /addEventListener\("notificationclick"[\s\S]*n\.tag !== "mu-nav"[\s\S]*"nav-stop"[\s\S]*mu-nav-stop/);
    assert.match(js, /registerPlugin\("MapUniteNavPip"\)/);
    for (const m of ["start", "update", "stop", "enterPip"]) assert.match(js, new RegExp(`N\\.${m}\\(`));
    const kt = read("native/android/nav/NavPipPlugin.kt"), svc = read("native/android/nav/NavService.kt"), ma = read("native/android/MainActivity.java");
    assert.match(kt, /@CapacitorPlugin\(name = "MapUniteNavPip"\)/);
    for (const m of ["start", "update", "stop", "enterPip", "supported"]) assert.match(kt, new RegExp(`fun ${m}\\(call: PluginCall\\)`));
    assert.match(kt, /setAutoEnterEnabled/);
    assert.match(svc, /CATEGORY_NAVIGATION/);
    assert.match(svc, /FOREGROUND_SERVICE_TYPE_LOCATION/);
    assert.match(ma, /registerPlugin\(NavPipPlugin\.class\)/);
    assert.match(ma, /onUserLeaveHint\(\)[\s\S]*NavPipPlugin\.onUserLeaveHint\(this\)/);
    assert.match(ma, /onPictureInPictureModeChanged[\s\S]*NavPipPlugin\.onPipChanged/);
    const S = await import("../../scripts/setup-perception-android.mjs");
    assert.ok(S.KOTLIN_PACKAGES.includes("nav"));
    const m = '<manifest>\n  <application>\n    <activity\n            android:name=".MainActivity"\n            android:exported="true">\n    </activity>\n  </application>\n</manifest>';
    const a = S.patchManifest(m);
    assert.match(a.text, /android:supportsPictureInPicture="true"[\s\S]*android:name="\.MainActivity"/);
    assert.match(a.text, /com\.mapunite\.app\.nav\.NavService" android:exported="false" android:foregroundServiceType="location"/);
    assert.equal(S.patchManifest(a.text).text, a.text, "safe to run again");
});
