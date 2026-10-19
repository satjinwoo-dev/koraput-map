import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import { art, drivers, tmpDir, buildDb, raw, ROOT } from "../server/helpers.mjs";

const require = createRequire(import.meta.url);
const io = require("../../node_modules/socket.io/client-dist/socket.io.js");     // the browser client the server ships

const sqlite = drivers[0];                     // whichever SQLite this machine has; server.js picks the same (lib/server-db.js)
const opts = sqlite ? {} : { skip: "no SQLite driver here: Node 22.13+ (node:sqlite) or better-sqlite3's native addon" };
const HUNTER = "royal-enfield-hunter-350-metro-in";
const hunter = art.bundles.find((b) => b.id === HUNTER);
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let dir, child, base, log = "";
const sockets = [];
before(async () => {
    if (!sqlite) return;
    dir = tmpDir("pins");
    const bikes = buildDb(dir, sqlite);
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

/** A rider: connected, profile accepted (with a device id), every pairUpdate / tripError recorded. */
async function rider(name, deviceId = crypto.randomUUID(), deviceToken = undefined) {
    const s = io(base, { transports: ["websocket"], forceNew: true, reconnection: false });
    sockets.push(s);
    s.profiles = []; s.errors = []; s.pairs = []; s.moves = [];
    s.on("tripFuelProfiles", (d) => s.profiles.push(d));
    s.on("tripError", (d) => s.errors.push(d));
    s.on("pairUpdate", (d) => s.pairs.push(d));
    s.on("friendMoved", (d) => s.moves.push(d));
    await new Promise((resolve, reject) => { s.once("connect", resolve); s.once("connect_error", reject); });
    const accepted = once(s, "profileAccepted");
    s.deviceIdUsed = deviceId;
    s.emit("profileReady", { name, deviceId, deviceToken });
    const acc = await accepted;
    s.deviceToken = acc.deviceToken || deviceToken;
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

const ask = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));

let host, mate, outsider, other;
test("group PIN: the host sees it, others see only that the trip is locked", opts, async () => {
    [host, mate, outsider, other] = await Promise.all([rider("Host"), rider("Mate"), rider("Outsider"), rider("Other")]);
    const started = once(host, "tripData", (t) => t && t.id);
    const offered = once(mate, "tripData", (t) => t && t.id);
    host.emit("startTrip", { name: "Araku ride", lat: 18.81, lng: 82.71 });
    const t = await started, o = await offered;
    assert.match(t.pin, /^\d{4}$/);
    assert.equal(t.locked, true);
    assert.equal(o.locked, true);
    assert.equal(o.pin, null, "never sent to someone outside the trip");
    host.trip = t;
});

test("joining needs the PIN: none → asked for it; wrong → tries left; right → in, and then sees the PIN", opts, async () => {
    const t = host.trip;
    let e = once(mate, "tripError");
    mate.emit("joinTrip", { tripId: t.id });
    assert.equal((await e).reason, "pin-required");
    const wrong = t.pin === "0000" ? "1111" : "0000";
    e = once(mate, "tripError");
    mate.emit("joinTrip", { tripId: t.id, pin: wrong });
    const w = await e;
    assert.equal(w.reason, "wrong-pin");
    assert.equal(w.triesLeft, 4);
    e = once(mate, "tripError");
    mate.emit("joinTrip", { tripId: t.id, pin: "12a4" });
    assert.equal((await e).reason, "bad-pin");
    const joined = once(mate, "tripData", (x) => x && x.members.some((m) => m.id === mate.id));
    mate.emit("joinTrip", { tripId: t.id, pin: t.pin });
    assert.equal((await joined).pin, t.pin, "a member sees the PIN, to share it");
});

test("the PIN alone finds the group (typed in, no trip tapped)", opts, async () => {
    const joined = once(other, "tripData", (x) => x && x.members.some((m) => m.id === other.id));
    other.emit("joinTrip", { pin: host.trip.pin });
    await joined;
    other.emit("leaveTrip");
    await once(other, "tripData", (x) => !x || !x.members.some((m) => m.id === other.id));
});

test("five wrong PINs and that phone waits; the host renews the PIN and the old one stops working", opts, async () => {
    const t = host.trip, wrong = t.pin === "9999" ? "9998" : "9999";
    for (let i = 0; i < 5; i++) { const e = once(outsider, "tripError"); outsider.emit("joinTrip", { tripId: t.id, pin: wrong }); await e; }
    const e = once(outsider, "tripError");
    outsider.emit("joinTrip", { tripId: t.id, pin: t.pin });
    assert.equal((await e).reason, "too-many-tries", "even the right PIN, for now");
    const renewed = once(host, "tripData", (x) => x && x.pin && x.pin !== t.pin);
    host.emit("renewTripPin");
    const n = await renewed;
    const e2 = once(other, "tripError");
    other.emit("joinTrip", { tripId: t.id, pin: t.pin });
    assert.equal((await e2).reason, "wrong-pin");
    host.trip = n;
});

let rA, rB;
test("rider + pillion: a 4-digit code, the partner types it, both are asked who rides", opts, async () => {
    [rA, rB] = await Promise.all([rider("Satyam"), rider("Asha")]);
    const made = await ask(rA, "pairCreate", {});
    assert.equal(made.ok, true);
    assert.match(made.code, /^\d{4}$/);
    const own = await ask(rA, "pairJoin", { code: made.code });
    assert.equal(own.reason, "own-code");
    const bad = await ask(rB, "pairJoin", { code: made.code === "0000" ? "0001" : "0000" });
    assert.equal(bad.reason, "wrong-code");
    assert.equal(bad.triesLeft, 4);
    const ua = once(rA, "pairUpdate", (d) => d.paired), ub = once(rB, "pairUpdate", (d) => d.paired);
    assert.equal((await ask(rB, "pairJoin", { code: made.code })).ok, true);
    const [pa, pb] = await Promise.all([ua, ub]);
    assert.equal(pa.partner.name, "Asha");
    assert.equal(pb.partner.name, "Satyam");
    assert.equal(pa.askRole, true);
    assert.equal(pa.role, null);
    assert.equal((await ask(other, "pairJoin", { code: made.code })).reason, "wrong-code", "one use");
});

test("who rides: either can choose; both hear it; others see one bike (the rider's marker says +pillion)", opts, async () => {
    const ua = once(rA, "pairUpdate", (d) => d.role), ub = once(rB, "pairUpdate", (d) => d.role);
    assert.equal((await ask(rB, "pairRole", { rider: "partner" })).ok, true);
    assert.equal((await ua).role, "rider");
    assert.equal((await ub).role, "pillion");
    // positions so others see them
    const seenA = once(other, "friendMoved", (u) => u.id === rA.id && u.pillion === "Asha", 6000);
    rA.emit("updateLocation", { lat: 18.811, lng: 82.711, accuracy: 8, speed: 0 });
    rB.emit("updateLocation", { lat: 18.811, lng: 82.711, accuracy: 8, speed: 0 });
    await seenA;
    const seenB = await once(other, "friendMoved", (u) => u.id === rB.id && u.ridingWith, 6000).catch(() => other.moves.find((u) => u.id === rB.id && u.ridingWith));
    assert.equal(seenB.ridingWith, rA.id);
    assert.equal(seenB.riderName, "Satyam");
    // swap
    const sw = once(rB, "pairUpdate", (d) => d.role === "rider");
    await ask(rB, "pairRole", { rider: "me" });
    await sw;
    // unpair
    const gone = once(rA, "pairUpdate", (d) => !d.paired);
    assert.equal((await ask(rA, "pairLeave", {})).ok, true);
    await gone;
});

test("a reconnecting phone gets its pair back (same device)", opts, async () => {
    const [x, y] = await Promise.all([rider("X"), rider("Y")]);
    const c = await ask(x, "pairCreate", {});
    await ask(y, "pairJoin", { code: c.code });
    await ask(x, "pairRole", { rider: "me" });
    const dev = y.deviceIdUsed;
    assert.ok(dev && y.deviceToken);
    y.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    const y2 = await rider("Y", dev, y.deviceToken);
    const back = y2.pairs.find((d) => d.paired) || await once(y2, "pairUpdate", (d) => d.paired);
    assert.equal(back.role, "pillion");
    assert.equal(back.partner.name, "X");
});

test("a shared place's invite: whoever opens it asks, the sharer says yes, they're paired (and asked who rides)", opts, async () => {
    const [sharer, viewer, nosy] = await Promise.all([rider("Ravi"), rider("Meena"), rider("Nosy")]);
    const inv = await ask(sharer, "pairInvite", {});
    assert.equal(inv.ok, true);
    assert.match(inv.token, /^[\w-]{16}$/);
    assert.equal((await ask(sharer, "pairRequest", { token: inv.token })).reason, "own-invite");
    assert.equal((await ask(viewer, "pairRequest", { token: "x".repeat(16) })).reason, "expired");
    await new Promise((r) => setTimeout(r, 1100));       // one request a second
    // the sharer says no
    const asked = once(sharer, "pairAsk");
    const r1 = await ask(viewer, "pairRequest", { token: inv.token });
    assert.equal(r1.ok, true); assert.equal(r1.name, "Ravi");
    const q1 = await asked;
    assert.equal(q1.from, "Meena");
    const declined = once(viewer, "pairDeclined");
    await ask(sharer, "pairAnswer", { reqId: q1.reqId, accept: false });
    assert.equal((await declined).name, "Ravi");
    // someone else can't answer for the sharer
    await new Promise((r) => setTimeout(r, 1100));
    const asked2 = once(sharer, "pairAsk");
    await ask(viewer, "pairRequest", { token: inv.token });
    const q2 = await asked2;
    assert.equal((await ask(nosy, "pairAnswer", { reqId: q2.reqId, accept: true })).ok, false);
    // the sharer says yes
    const pv = once(viewer, "pairUpdate", (d) => d.paired), ps = once(sharer, "pairUpdate", (d) => d.paired);
    assert.equal((await ask(sharer, "pairAnswer", { reqId: q2.reqId, accept: true })).ok, true);
    const [a, b] = await Promise.all([pv, ps]);
    assert.equal(a.partner.name, "Ravi"); assert.equal(b.partner.name, "Meena");
    assert.equal(a.askRole, true);
});
