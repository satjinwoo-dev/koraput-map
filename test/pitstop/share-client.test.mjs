// Step 8: the phone side of the convoy share — pitstop-app.js sends myShare() as
// "setFuelShare" (level as its age) at the right moments, and TripFuel turns a relayed
// level's age back into a time on this phone's clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ROOT } from "../smartdrive/harness.mjs";

const json = (x) => JSON.parse(JSON.stringify(x));
const GARAGE = { v: 1, bikeId: "royal-enfield-hunter-350-metro-in", bundle: "0123456789abcdef", classKey: "ice_manual.cruiser", settings: { riderMass: 80 } };

function loadApp({ connected = true, level = null, globals = {} } = {}) {
    const emitted = [], socketHandlers = {}, docHandlers = {};
    const store = new Map();
    if (level) store.set("mu.pitstop.v1", JSON.stringify({ v: 1, levels: { me: level } }));
    const ctx = vm.createContext({
        console, Math, JSON, Date, Number, Array, Object, String, Boolean, Map, Set, Promise, setTimeout, clearTimeout, clearInterval, setInterval, Error,
        localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
        document: { readyState: "complete", getElementById: () => null, addEventListener: (e, h) => { (docHandlers[e] ||= []).push(h); } },
        __sock: { id: "sock-me", connected, emit: (...a) => emitted.push(a), on: (e, h) => { (socketHandlers[e] ||= []).push(h); } },
        MUTrip: { app: { loadBike: async () => ({ name: "Royal Enfield Hunter 350" }), store: { garage: () => GARAGE } } },
        ...globals
    });
    ctx.window = ctx; ctx.globalThis = ctx;
    // as in the page: core.js's `const socket` is a script-scope lexical, NOT a property of window
    vm.runInContext("const socket = __sock; delete globalThis.__sock;", ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "public/js/pitstop/pitstop-app.js"), "utf8"), ctx, { filename: "pitstop-app.js" });
    return { ctx, emitted, socketHandlers, docHandlers, app: ctx.MUPitstop.app, sock: vm.runInContext("socket", ctx) };
}
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test("myShare: the bike (with its stable id) and the level you set, within 6 h", async () => {
    const at = Date.now() - 120000;
    const { app } = loadApp({ level: { share: 0.35, at } });
    assert.deepEqual(json(await app.myShare()), {
        bike: { bundle: GARAGE.bundle, bikeId: GARAGE.bikeId, classKey: GARAGE.classKey, title: "Royal Enfield Hunter 350", settings: { riderMass: 80 } },
        level: { share: 0.35, at }
    });
    const old = loadApp({ level: { share: 0.35, at: Date.now() - 7 * 3600000 } });
    assert.equal((await old.app.myShare()).level, null);
});

test("shareFuel: sent as setFuelShare with the level as its age; nothing while disconnected", async () => {
    const { app, emitted } = loadApp({ level: { share: 0.6, at: Date.now() - 60000 } });
    assert.equal(await app.shareFuel(), true);
    const [ev, payload] = emitted.at(-1);
    assert.equal(ev, "setFuelShare");
    assert.deepEqual(Object.keys(payload).sort(), ["bike", "level"]);
    assert.equal(payload.level.share, 0.6);
    assert.ok(payload.level.ageMs >= 60000 && payload.level.ageMs < 65000);
    assert.equal(payload.level.at, undefined, "no clock time leaves the phone");
    const off = loadApp({ connected: false });
    assert.equal(await off.app.shareFuel(), false);
    assert.equal(off.emitted.length, 0);
});

test("shared after every profileAccepted (a new socket starts empty) and when My bike changes", async () => {
    const { emitted, socketHandlers, docHandlers } = loadApp();
    assert.equal(socketHandlers.profileAccepted.length, 1);
    assert.equal(docHandlers["mu:garage-change"].length, 1);
    docHandlers["mu:garage-change"][0]();
    await settle();
    assert.equal(emitted.filter((e) => e[0] === "setFuelShare").length, 1);
    socketHandlers.profileAccepted[0]();
    await settle(600);
    assert.equal(emitted.filter((e) => e[0] === "setFuelShare").length, 2);
    assert.equal(emitted.at(-1)[1].level, null);
});

test("TripFuel.onProfiles: a relayed level's age becomes a time on this phone; junk levels are dropped", () => {
    const src = fs.readFileSync(path.join(ROOT, "public/js/groupnav.js"), "utf8");
    const start = src.indexOf("const TripFuel = {");
    const end = src.indexOf("\n};", start) + 3;
    assert.ok(start > 0 && end > start);
    const ctx = vm.createContext({ Number, Object, Date, Math, updateTripPanel() {} });
    vm.runInContext(`${src.slice(start, end)}\nthis.TripFuel = TripFuel;`, ctx);
    const before = Date.now();
    ctx.TripFuel.onProfiles({ tripId: "t1", defaultKmPerL: 18, profiles: {
        a: { kmPerL: 35, assumed: false, walking: false, bike: { bundle: GARAGE.bundle }, level: { share: 0.4, ageMs: 600000 } },
        b: { kmPerL: 18, assumed: true, walking: false, level: { share: "x" } },
        c: { kmPerL: null, assumed: false, walking: true }
    } });
    const a = ctx.TripFuel.profiles.a;
    assert.equal(a.level.share, 0.4);
    assert.ok(a.level.at <= before - 600000 + 50 && a.level.at >= before - 600000 - 50, "at = now − age on this phone's clock");
    assert.equal(a.level.ageMs, undefined);
    assert.equal(a.bike.bundle, GARAGE.bundle);
    assert.equal("level" in ctx.TripFuel.profiles.b, false);
    assert.equal(ctx.TripFuel.tripId, "t1");
});

test("the planner finds your group trip: your id is read from core.js's `socket` (a script lexical, not window.socket)", async () => {
    const trip = { id: "t1", name: "Koraput", lat: 18.81, lng: 82.71, members: [{ id: "sock-me" }, { id: "sock-mate" }] };
    const { app, ctx } = loadApp({ globals: { currentTrip: trip, friendData: {} } });
    assert.equal(ctx.socket, undefined, "like the page: no window.socket");
    const m = await app.buildModel(() => {}).catch((e) => ({ state: "error", message: String(e) }));
    assert.doesNotMatch(String(m.message || ""), /Start or join a group trip/, "the trip is recognised");
});
