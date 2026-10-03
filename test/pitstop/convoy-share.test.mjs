// Step 8: the convoy share (MUPitstop.app.myShare() → "setFuelShare") relayed by the
// real server.js to trip-mates only, inside "tripFuelProfiles" — riders talking to it
// over real Socket.IO connections.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { art, drivers, tmpDir, buildDb, raw, ROOT } from "../server/helpers.mjs";

const require = createRequire(import.meta.url);
const io = require("../../node_modules/socket.io/client-dist/socket.io.js");     // the browser client the server ships

const better = drivers.find((d) => d.name === "better-sqlite3");
const opts = better ? {} : { skip: "server.js needs better-sqlite3's native addon (npm rebuild better-sqlite3)" };
const HUNTER = "royal-enfield-hunter-350-metro-in";
const hunter = art.bundles.find((b) => b.id === HUNTER);
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let dir, child, base, log = "";
const sockets = [];
before(async () => {
    if (!better) return;
    dir = tmpDir("convoy");
    const bikes = buildDb(dir, better);
    const port = await freePort();
    child = spawn(process.execPath, ["server.js"], {
        cwd: ROOT,
        env: { ...process.env, NODE_ENV: "test", PORT: String(port), DB_PATH: path.join(dir, "mapunite.db"), BIKES_DB_PATH: bikes, SERVER_SECRET: "test-secret", REDIS_URL: "" },
        stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (d) => { log += d; });
    child.stderr.on("data", (d) => { log += d; });
    base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
        try { if ((await raw(`${base}/healthz`)).status === 200) return; } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`server.js didn't start:\n${log}`);
});
after(async () => {
    for (const s of sockets) s.disconnect();
    if (child && child.exitCode === null) { child.kill("SIGKILL"); await new Promise((r) => child.once("exit", r)); }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/** A rider: connected, profile accepted, every tripFuelProfiles payload recorded. */
async function rider(name) {
    const s = io(base, { transports: ["websocket"], forceNew: true, reconnection: false });
    sockets.push(s);
    s.profiles = [];
    s.on("tripFuelProfiles", (d) => s.profiles.push(d));
    await new Promise((resolve, reject) => { s.once("connect", resolve); s.once("connect_error", reject); });
    const accepted = once(s, "profileAccepted");
    s.emit("profileReady", { name });
    await accepted;
    return s;
}
function once(s, event, pred = () => true, ms = 4000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => { s.off(event, h); reject(new Error(`no ${event} within ${ms} ms`)); }, ms);
        const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(event, h); resolve(d); } };
        s.on(event, h);
    });
}
/** The next profiles payload in which `about`'s entry passes `pred`. */
const nextProfile = (s, about, pred) => once(s, "tripFuelProfiles", (d) => d.profiles && d.profiles[about.id] && pred(d.profiles[about.id])).then((d) => d.profiles[about.id]);
const quiet = (ms = 400) => new Promise((r) => setTimeout(r, ms));

let host, mate, outsider;
test("setup: a host starts a trip, a mate joins, an outsider stays out", opts, async () => {
    [host, mate, outsider] = await Promise.all([rider("Host"), rider("Mate"), rider("Outsider")]);
    const started = once(host, "tripData", (t) => t && t.id);
    host.emit("startTrip", { name: "Koraput ride", lat: 18.81, lng: 82.71 });
    const trip = await started;
    const joined = nextProfile(host, mate, () => true);
    mate.emit("joinTrip", { tripId: trip.id });
    await joined;
});

test("the host's bike and level reach the mate, cleaned, with the level as its age", opts, async () => {
    const got = nextProfile(mate, host, (p) => p.bike);
    host.emit("setFuelShare", {
        bike: { bundle: hunter.hash, bikeId: HUNTER, classKey: "ice_manual.cruiser", title: "Hunter\u0007 350 " + "x".repeat(200), settings: { riderMass: 80, pillionMass: 60, evil: "<script>" } },
        level: { share: 0.4567, ageMs: 600000 }
    });
    const p = await got;
    assert.deepEqual(p.bike, { bundle: hunter.hash, bikeId: HUNTER, classKey: hunter.classKey, title: ("Hunter 350 " + "x".repeat(200)).slice(0, 80), settings: { riderMass: 80, pillionMass: 60 } },
        "class from the catalogue, control characters and unknown settings dropped, title capped");
    assert.equal(p.level.share, 0.457);
    assert.ok(p.level.ageMs >= 600000 && p.level.ageMs < 610000, `ageMs ${p.level.ageMs}`);
    assert.equal(p.kmPerL, 18, "the km/L profile is unchanged");
    assert.equal(p.walking, false);
    assert.equal(outsider.profiles.length, 0, "never sent outside the trip");
});

test("a bundle an older catalogue build shipped is swapped for the bike's current one", opts, async () => {
    const got = nextProfile(mate, host, (p) => p.bike && p.level === undefined);
    host.emit("setFuelShare", { bike: { bundle: "0123456789abcdef", bikeId: HUNTER, classKey: "ice_manual.cruiser", title: "Hunter" }, level: null });
    const p = await got;
    assert.equal(p.bike.bundle, hunter.hash);
    assert.equal(p.level, undefined, "level withdrawn");
    // a typical bike (no id): its class's current default
    const cd = art.bundles.find((b) => b.kind === "class_default" && b.classKey === "ice_cvt.scooter");
    const got2 = nextProfile(mate, host, (p2) => p2.bike && p2.bike.classKey === "ice_cvt.scooter");
    host.emit("setFuelShare", { bike: { bundle: "0123456789abcdef", bikeId: null, classKey: "ice_cvt.scooter", title: "Typical scooter" }, level: null });
    assert.equal((await got2).bike.bundle, cd.hash);
});

test("an unknown bike isn't relayed; a stale level isn't either", opts, async () => {
    const got = nextProfile(mate, host, (p) => !p.bike && p.level === undefined);
    host.emit("setFuelShare", { bike: { bundle: "0123456789abcdef", bikeId: "no-such-bike", classKey: "ice_manual.commuter" }, level: { share: 0.5, ageMs: 7 * 3600000 } });
    await got;
});

test("malformed shares are ignored and change nothing", opts, async () => {
    const good = nextProfile(mate, host, (p) => p.bike && p.level);
    host.emit("setFuelShare", { bike: { bundle: hunter.hash, bikeId: HUNTER, classKey: hunter.classKey, title: "Hunter" }, level: { share: 0.8, ageMs: 0 } });
    await good;
    const before = mate.profiles.length;
    for (const bad of [
        null, "x", [], {}, { bike: null }, { level: null }, { bike: "hunter", level: null }, { bike: { bundle: "XYZ", classKey: hunter.classKey } }, { bike: { bundle: hunter.hash, classKey: "car.suv" } },
        { bike: { bundle: hunter.hash, classKey: hunter.classKey, bikeId: "../etc" } }, { bike: { bundle: hunter.hash, classKey: hunter.classKey, settings: [1] } },
        { bike: { bundle: hunter.hash, classKey: hunter.classKey, settings: { frontSprocket: 15, rearSprocket: 400 } } },
        { bike: null, level: { share: 1.5, ageMs: 0 } }, { bike: null, level: { share: 0.5, ageMs: -1 } }, { bike: null, level: { share: "0.5", ageMs: 0 } }
    ]) host.emit("setFuelShare", bad);
    await quiet();
    assert.equal(mate.profiles.length, before, "no profile pushes for malformed shares");
    // and the last good share still stands for anyone who asks again (a re-push on the next change)
    const again = nextProfile(mate, host, (p) => p.bike && p.bike.bundle === hunter.hash && p.level && p.level.share === 0.8);
    host.emit("setMileage", { kmPerL: 35 });
    const p = await again;
    assert.equal(p.kmPerL, 35);
});

test("leaving the trip: the mate stops getting the host's share", opts, async () => {
    const left = once(host, "tripFuelProfiles", (d) => d.profiles && !d.profiles[mate.id]);
    mate.emit("leaveTrip");
    await left;
    const n = mate.profiles.length;
    host.emit("setFuelShare", { bike: null, level: { share: 0.2, ageMs: 0 } });
    await quiet();
    assert.equal(mate.profiles.length, n);
    assert.equal(outsider.profiles.length, 0);
});
