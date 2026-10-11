// Master AI: hierarchical core (public/js/master/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../../public/js/master/contracts.js");
const B = require("../../public/js/master/bus.js");
const K = require("../../public/js/master/kernel.js");
const CAPS = require("../../public/js/master/capabilities.js");
const P = require("../../public/js/master/persona.js");
const PH = require("../../public/js/master/phrases-desi.js");
const O = require("../../public/js/master/output.js");
const BR = require("../../public/js/master/brain.js");
const RIDE = require("../../public/js/master/agents/ride-agent.js");
const NET = require("../../public/js/master/agents/network-agent.js");
const TEMPLATE = require("../../public/js/master/agents/_template.js");
const G = require("../../public/js/advice/gate.js");

const flush = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------- test helpers
function fakeClock(start = 1_000_000) {
    let t = start, id = 0;
    const q = new Map();
    const timers = {
        setTimeout(fn, ms) { const h = ++id; q.set(h, { at: t + Math.max(0, ms || 0), fn }); return h; },
        clearTimeout(h) { q.delete(h); },
        setInterval(fn, ms) { const h = ++id; q.set(h, { at: t + ms, fn, every: ms }); return h; },
        clearInterval(h) { q.delete(h); }
    };
    function advance(ms) {
        const end = t + ms;
        for (;;) {
            let next = null;
            for (const [h, e] of q) if (e.at <= end && (!next || e.at < next[1].at)) next = [h, e];
            if (!next) break;
            const [h, e] = next;
            t = e.at;
            if (e.every) e.at += e.every; else q.delete(h);
            e.fn();
        }
        t = end;
    }
    return { now: () => t, timers, advance, get pending() { return q.size; } };
}
const quietLog = { info() {}, warn() {}, error() {} };

function emitter() {
    const fns = new Set();
    return { on(fn) { fns.add(fn); return () => fns.delete(fn); }, emit(v) { for (const fn of fns) fn(v); }, get size() { return fns.size; } };
}

/** A whole Master with fake time and recording output. */
function harness({ voice, busy, config, island } = {}) {
    const clock = fakeClock();
    const bus = B.createBus({ now: clock.now, timers: clock.timers });
    const caps = CAPS.createCapabilities();
    caps.provide("store", CAPS.createStoreProvider({}));
    const persona = PH.install(P.createPersona({ style: "desi", rng: () => 0 }));
    const said = [];
    const output = O.createOutput({
        window: {},
        voice: voice || ((text, o) => { said.push({ text, ...o }); return true; }),
        island: island || (() => true),
        busy: busy || (() => false),
        emit: () => {}
    });
    const brain = BR.createBrain({ bus, contracts: C, persona, output, now: clock.now, timers: clock.timers, config });
    const kernel = K.createKernel({ bus, caps, contracts: C, now: clock.now, timers: clock.timers, log: quietLog });
    const decisions = [];
    bus.subscribe("master.decision", (d) => decisions.push(d));
    return { clock, bus, caps, persona, output, brain, kernel, said, decisions };
}

function agent(over = {}) {
    return { id: "probe", version: "1.0.0", apiVersion: 1, start() {}, ...over };
}

// ================================================================ contracts
test("contracts: reports are normalized into complete, frozen objects", () => {
    const r = C.normalizeReport({ kind: "network.lost", severity: "warning", data: { a: 1 } }, { source: "network", now: 1000 });
    assert.equal(r.ok, true);
    const rep = r.report;
    assert.equal(rep.priority, 70);
    assert.equal(rep.key, "network.lost");
    assert.equal(rep.category, "network");
    assert.equal(rep.speak, true);
    assert.equal(rep.expiresAt, 1000 + C.DEFAULT_TTL.warning);
    assert.ok(Object.isFrozen(rep) && Object.isFrozen(rep.data));
    // priority alone picks the severity; a priority outside the band is clamped
    assert.equal(C.normalizeReport({ kind: "x.y", priority: 92 }).report.severity, "critical");
    assert.equal(C.normalizeReport({ kind: "x.y", severity: "advice", priority: 99 }).report.priority, 59);
    assert.equal(C.normalizeReport({ kind: "x.y" }).report.severity, "info");
    assert.equal(C.normalizeReport({ kind: "x.y" }).report.speak, false);
    // the gate reads the same numbers
    for (const [sev, want] of [["critical", "critical"], ["warning", "warning"], ["advice", "advice"]]) {
        assert.equal(G.classify({ priority: C.normalizeReport({ kind: "a", severity: sev }).report.priority }), want);
    }
    for (const bad of [null, { kind: "Bad Kind" }, { kind: "a", severity: "loud" }, { kind: "a", data: [1] }]) assert.equal(C.normalizeReport(bad).ok, false);
});

test("contracts: agent definitions are checked before the kernel takes them", () => {
    assert.equal(C.validateAgent(agent()).ok, true);
    assert.equal(C.validateAgent(TEMPLATE).ok, true);
    assert.equal(C.validateAgent(RIDE).ok, true);
    assert.equal(C.validateAgent(NET).ok, true);
    const bad = C.validateAgent({ id: "X", version: "1", apiVersion: 2, requires: "gps", runWhen: { topic: 1 } });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.length >= 5);
});

// ================================================================ bus
test("bus: patterns, ordering of nested publishes, sticky replay", () => {
    const bus = B.createBus();
    const seen = [];
    bus.subscribe("report.**", (_d, e) => seen.push(`deep:${e.topic}`));
    bus.subscribe("report.*", (_d, e) => seen.push(`one:${e.topic}`));
    bus.subscribe("state.ride", (d) => { seen.push(`ride:${d}`); if (d === 1) bus.publish("state.ride", 2); });
    bus.subscribe("state.ride", (d) => seen.push(`ride2:${d}`));
    bus.publish("report.net.network.lost", {});
    bus.publish("report.x", {});
    bus.publish("state.ride", 1, { sticky: true });
    assert.deepEqual(seen, ["deep:report.net.network.lost", "deep:report.x", "one:report.x", "ride:1", "ride2:1", "ride:2", "ride2:2"]);
    const late = [];
    bus.publish("state.net", "ok", { sticky: true });
    bus.subscribe("state.*", (d, e) => late.push(`${e.topic}=${d}`), { replay: true });
    assert.deepEqual(late, ["state.ride=1", "state.net=ok"]);
    assert.equal(bus.last("state.net"), "ok");
    assert.throws(() => bus.publish("bad topic"), /bad topic/);
    assert.throws(() => bus.subscribe("a..b", () => {}), /bad pattern/);
});

test("bus: a throwing handler doesn't stop the others; removeOwner cleans up", () => {
    const errors = [];
    const bus = B.createBus({ onError: (_e, env, owner) => errors.push(`${owner}@${env.topic}`) });
    const got = [];
    bus.subscribe("a", () => { throw new Error("boom"); }, { owner: "agent:x", order: 5 });
    bus.subscribe("a", () => got.push("second"), { owner: "agent:y" });
    const be = [];
    bus.subscribe("bus.error", (d) => be.push(d.owner));
    bus.publish("a");
    assert.deepEqual(got, ["second"]);
    assert.deepEqual(errors, ["agent:x@a"]);
    assert.deepEqual(be, ["agent:x"]);
    bus.handle("task.t", () => 1, { owner: "agent:x" });
    bus.removeOwner("agent:x");
    assert.equal(bus.hasResponder("task.t"), false);
    got.length = 0;
    bus.publish("a");
    assert.deepEqual(got, ["second"]);
    assert.equal(errors.length, 1);
});

test("bus: request / handle with timeout and missing responder", async () => {
    const clock = fakeClock();
    const bus = B.createBus({ now: clock.now, timers: clock.timers });
    bus.handle("task.add", ({ a, b }) => a + b);
    assert.equal(await bus.request("task.add", { a: 2, b: 3 }), 5);
    await assert.rejects(bus.request("task.none"), (e) => e.code === "NO_HANDLER");
    bus.handle("task.slow", () => new Promise(() => {}));
    const p = bus.request("task.slow", null, { timeoutMs: 500 });
    clock.advance(600);
    await assert.rejects(p, (e) => e.code === "TIMEOUT");
    assert.throws(() => bus.handle("task.add", () => 0), /already has a responder/);
});

// ================================================================ kernel
test("kernel: an agent waits for its capability and dependency, then runs in order", () => {
    const h = harness();
    const order = [];
    h.kernel.define(agent({ id: "child", depends: ["parent"], start() { order.push("child"); } }));
    h.kernel.define(agent({ id: "parent", requires: ["gps"], start() { order.push("parent"); } }));
    h.kernel.start();
    assert.equal(h.kernel.get("parent").state, "waiting");
    assert.match(h.kernel.get("parent").reason, /needs gps/);
    assert.equal(h.kernel.get("child").state, "waiting");
    h.caps.provide("gps", { available: () => true });
    assert.deepEqual(order, ["parent", "child"]);
    assert.equal(h.kernel.get("child").state, "running");
    // capability revoked: the agent and its dependant stop
    h.caps.revoke("gps");
    assert.equal(h.kernel.get("parent").state, "waiting");
    assert.equal(h.kernel.get("child").state, "waiting");
});

test("kernel: runWhen starts and stops an agent from shared state; stopping cleans everything up", () => {
    const h = harness();
    let ticks = 0, events = 0, stopped = 0;
    h.kernel.define(agent({
        id: "rider-only",
        runWhen: { topic: "state.ride", test: (r) => Boolean(r && r.active) },
        start(ctx) {
            ctx.timers.setInterval(() => ticks++, 1000);
            ctx.bus.subscribe("ping", () => events++);
            ctx.bus.handle("task.rider", () => "yes");
            ctx.onStop(() => stopped++);
        }
    }));
    h.kernel.start();
    assert.equal(h.kernel.get("rider-only").state, "waiting");
    h.bus.publish("state.ride", { active: true }, { sticky: true });
    assert.equal(h.kernel.get("rider-only").state, "running");
    h.clock.advance(3000);
    h.bus.publish("ping");
    assert.equal(ticks, 3); assert.equal(events, 1);
    assert.equal(h.bus.hasResponder("task.rider"), true);
    h.bus.publish("state.ride", { active: false }, { sticky: true });
    assert.equal(h.kernel.get("rider-only").state, "waiting");
    assert.equal(stopped, 1);
    h.clock.advance(5000);
    h.bus.publish("ping");
    assert.equal(ticks, 3); assert.equal(events, 1);                    // nothing left behind
    assert.equal(h.bus.hasResponder("task.rider"), false);
});

test("kernel: a crashing agent is restarted with back-off, then given up on; others keep running", () => {
    const h = harness();
    let attempts = 0, healthy = 0;
    h.kernel.define(agent({ id: "flaky", start() { attempts++; throw new Error("no sensor"); } }));
    h.kernel.define(agent({ id: "steady", start() { healthy++; } }));
    h.kernel.start();
    assert.equal(attempts, 1);
    assert.equal(h.kernel.get("steady").state, "running");
    assert.match(h.kernel.get("flaky").reason, /retry in 1 s/);
    h.clock.advance(1000); assert.equal(attempts, 2);
    h.clock.advance(2000); assert.equal(attempts, 3);
    h.clock.advance(4000); assert.equal(attempts, 4);
    h.clock.advance(8000); assert.equal(attempts, 5);
    h.clock.advance(16000); assert.equal(attempts, 6);
    assert.equal(h.kernel.get("flaky").state, "failed");
    assert.match(h.kernel.get("flaky").reason, /crashed 6 times/);
    h.clock.advance(600000); assert.equal(attempts, 6);                  // stays down
    assert.equal(healthy, 1);
    h.kernel.restart("flaky");
    assert.equal(attempts, 7);
});

test("kernel: handler errors degrade, then restart the agent", () => {
    const h = harness();
    let starts = 0;
    h.kernel.define(agent({ id: "buggy", start(ctx) { starts++; ctx.bus.subscribe("tick", () => { throw new Error("oops"); }); } }));
    h.kernel.start();
    for (let i = 0; i < 3; i++) h.bus.publish("tick");
    assert.equal(h.kernel.get("buggy").state, "degraded");
    for (let i = 0; i < 7; i++) h.bus.publish("tick");
    assert.equal(h.kernel.get("buggy").state, "failed");
    h.clock.advance(1000);
    assert.equal(starts, 2);
    assert.equal(h.kernel.get("buggy").state, "running");
});

test("kernel: rejects bad definitions, hot-swaps versions, guards capabilities, enable/disable", () => {
    const h = harness();
    h.kernel.start();
    assert.equal(h.kernel.define(agent({ apiVersion: 99 })), false);
    assert.equal(h.kernel.has("probe"), false);
    const log = [];
    h.caps.provide("gps", {});
    h.kernel.define(agent({ id: "swap", requires: ["gps"], start(ctx) { log.push(`v1 start`); ctx.onStop(() => log.push("v1 stop")); } }));
    h.kernel.define(agent({ id: "swap", version: "2.0.0", requires: ["gps"], start(ctx) { log.push("v2 start"); assert.throws(() => ctx.caps.get("camera"), /must list "camera"/); assert.ok(ctx.caps.get("gps")); } }));
    assert.deepEqual(log, ["v1 start", "v1 stop", "v2 start"]);
    assert.equal(h.kernel.get("swap").version, "2.0.0");
    h.kernel.disable("swap");
    assert.equal(h.kernel.get("swap").state, "disabled");
    h.kernel.enable("swap");
    assert.equal(h.kernel.get("swap").state, "running");
    assert.equal(h.kernel.config.agents.swap.enabled, true);
});

test("kernel: async start, heartbeat watchdog and dependency cycles", async () => {
    const h = harness();
    let resolveStart;
    h.kernel.define(agent({ id: "slow", heartbeatMs: 1000, start: () => new Promise((r) => { resolveStart = r; }) }));
    h.kernel.define(agent({ id: "after", depends: ["slow"] }));
    h.kernel.define(agent({ id: "a1", depends: ["a2"] }));
    h.kernel.define(agent({ id: "a2", depends: ["a1"] }));
    h.kernel.start();
    assert.equal(h.kernel.get("slow").state, "starting");
    assert.equal(h.kernel.get("after").state, "waiting");
    assert.equal(h.kernel.get("a1").state, "failed");
    assert.match(h.kernel.get("a1").reason, /cycle/);
    resolveStart(); await flush();
    assert.equal(h.kernel.get("slow").state, "running");
    assert.equal(h.kernel.get("after").state, "running");
    h.clock.advance(5000);                                              // no heartbeat for > 3 s
    assert.equal(h.kernel.get("slow").state, "failed");
    assert.match(h.kernel.get("slow").reason, /no heartbeat/);
    assert.equal(h.kernel.get("after").state, "waiting");               // its dependant stops with it
});

test("kernel: lazy agents load on their topic", async () => {
    const h = harness();
    const loaded = [];
    const kernel = K.createKernel({
        bus: h.bus, caps: h.caps, contracts: C, now: h.clock.now, timers: h.clock.timers, log: quietLog,
        loadScript: async (src) => { loaded.push(src); kernel.define(agent({ id: "vision" })); }
    });
    kernel.start();
    kernel.lazy({ id: "vision", src: "vision.js", loadOn: "report.ride.ride.break-due" });
    assert.deepEqual(loaded, []);
    h.bus.publish("report.ride.ride.break-due", { kind: "ride.break-due" });
    h.bus.publish("report.ride.ride.break-due", { kind: "ride.break-due" });
    await flush();
    assert.deepEqual(loaded, ["vision.js"]);
    assert.equal(kernel.get("vision").state, "running");
});

// ================================================================ persona
test("persona: templates, filters, rotation and fallbacks", () => {
    const p = PH.install(P.createPersona({ style: "desi", rng: () => 0 }));
    const r = { kind: "network.zone-ahead", key: "network.zone", severity: "advice", data: { distanceM: 1530 } };
    const a = p.phrase(r);
    const b = p.phrase(r);
    assert.match(a.text, /1\.5 km aage/);
    assert.match(p.phrase({ kind: "rest.stop", key: "rs", severity: "advice", data: { distanceM: 2000, place: "Dhaba" } }).text, /^[A-Z]/);   // sentences start capitalised
    assert.notEqual(a.text, b.text);                                    // the same line twice in a row is avoided
    assert.equal(a.source, "pack");
    assert.equal(a.display.sub, "In 1.5 kilometres");                    // the screen is English even when the voice is desi
    // a missing placeholder skips that line and falls back to the generic one
    const g = p.phrase({ kind: "weather.ahead", key: "w", severity: "warning", data: {} });
    assert.equal(g.source, "generic");
    // unknown kind → generic; agent text → used as-is
    assert.equal(p.phrase({ kind: "radar.close", key: "r", severity: "critical", data: {} }).text, "Dhyan se bhai! Speed kam kar, aage khatra hai.");
    assert.equal(p.phrase({ kind: "x", key: "x", severity: "advice", text: "Exact words." }).text, "Exact words.");
    // name and plain style
    p.setName("Rahul");
    assert.match(p.phrase({ kind: "network.lost", key: "n", severity: "warning" }).text, /Rahul/);
    p.setStyle("plain");
    assert.equal(p.phrase({ kind: "network.lost", key: "n", severity: "warning" }).text, "No signal. Navigation keeps working offline.");
    assert.equal(P.FILTERS.min(5400, "desi"), "1 ghante 30 minute");
    assert.equal(P.FILTERS.min(7200, "plain"), "2 hours");
    assert.equal(P.FILTERS.km(420, "desi"), "400 metre");
    // critical lines are clipped to stay short
    const long = p.phrase({ kind: "x", key: "x", severity: "critical", text: "Stop ".repeat(60) });
    assert.ok(long.text.length <= P.CRITICAL_MAX);
});

test("phrase packs: every line renders with sample data, critical lines are short", () => {
    const sample = { distanceM: 1200, ridingSec: 5400, condition: "baarish", place: "Sharma chai tapri", speedKmh: 60, rttMs: 2000, navigating: true, goneSec: 90, detail: "aankh 1.2 second tak band rahi", score: 62, level: "high", hazard: "gaddha", vehicle: "truck", ttcS: 3.1, count: 3, minutes: 8 };
    for (const [style, pack] of Object.entries({ desi: PH.desi, plain: PH.plain })) {
        const p = P.createPersona({ style, name: "Asha" });
        for (const [kind, bySev] of Object.entries(pack)) for (const [sev, lines] of Object.entries(bySev)) for (const line of lines) {
            const out = p.render(line.say, { name: "Asha", ...sample });
            assert.ok(out, `${style} ${kind}/${sev}: "${line.say}" has an unknown placeholder`);
            assert.doesNotMatch(out, /\{\{|\}\}/);
            if (sev === "critical") assert.ok(out.length <= P.CRITICAL_MAX, `${kind} critical too long`);
        }
    }
    // the desi and plain packs cover the same kinds
    assert.deepEqual(Object.keys(PH.desi).sort(), Object.keys(PH.plain).sort());
});

// ================================================================ brain
test("brain: priority order, spacing, critical first, supersede", () => {
    const h = harness();
    h.kernel.start();
    const pub = (kind, extra) => h.bus.publish(`report.t.${kind}`, { kind, ...extra }, { source: "t" });
    pub("rest.stop", { severity: "advice", data: { distanceM: 2000, place: "Dhaba" } });
    assert.equal(h.said.length, 1);                                     // first one goes straight out
    pub("ride.break-due", { severity: "advice", key: "ride.break", data: { ridingSec: 5400 } });
    pub("network.weak", { severity: "warning", key: "network.status" });
    pub("network.lost", { severity: "warning", key: "network.status" }); // replaces the queued "weak"
    pub("x.danger", { severity: "critical", text: "Ruk ja bhai!" });     // skips the queue
    assert.equal(h.said.length, 2);
    assert.equal(h.said[1].text, "Ruk ja bhai!");
    assert.ok(h.decisions.some((d) => d.action === "superseded" && d.kind === "network.weak"));
    h.clock.advance(2500);
    assert.match(h.said[2].text, /Network gaya|signal bilkul nahi/);    // warning before advice
    h.clock.advance(2500);
    assert.match(h.said[3].text, /lagatar|ruk ja/i);
    assert.equal(h.said.length, 4);
    // priorities and categories reach the voice (and so the gate)
    assert.equal(h.said[1].priority, 90);
    assert.equal(h.said[2].category, "network");
});

test("brain: cooldown by key + kind, riding-only, expiry, busy voice, low confidence", () => {
    let busy = false;
    const h = harness({ busy: () => busy });
    const pub = (kind, extra) => h.bus.publish(`report.t.${kind}`, { kind, ...extra }, { source: "t" });
    pub("network.lost", { severity: "warning", key: "network.status" });
    h.clock.advance(3000);
    pub("network.lost", { severity: "warning", key: "network.status" });
    assert.equal(h.said.length, 1);
    assert.ok(h.decisions.some((d) => d.reason === "cooldown: said recently"));
    pub("network.restored", { severity: "advice", key: "network.status" });   // a change of state is said
    h.clock.advance(3000);
    assert.equal(h.said.length, 2);
    pub("ride.break-due", { severity: "advice", ridingOnly: true, data: { ridingSec: 5400 } });
    assert.ok(h.decisions.some((d) => d.reason === "riding-only: not riding"));
    pub("rest.stop", { severity: "advice", confidence: 0.2, data: { distanceM: 1, place: "x" } });
    assert.ok(h.decisions.some((d) => /low confidence/.test(d.reason)));
    busy = true;
    pub("rest.stop", { severity: "advice", ttlMs: 5000, data: { distanceM: 500, place: "Tapri" } });
    h.clock.advance(4000);
    assert.equal(h.said.length, 2);                                     // waits while the voice talks
    h.clock.advance(2000);
    assert.ok(h.decisions.some((d) => d.action === "dropped" && d.reason === "expired in queue"));
    busy = false;
});

test("brain: custom policies plug in; a broken policy never swallows a report; delegation", async () => {
    const h = harness();
    const removeNight = h.brain.use("night-mode", (r) => (r.severity === "advice" ? { drop: "night" } : r), { order: 15 });
    h.brain.use("broken", () => { throw new Error("bad policy"); }, { order: 16 });
    h.bus.publish("report.t.rest.stop", { kind: "rest.stop", severity: "advice", data: { distanceM: 1, place: "x" } });
    assert.ok(h.decisions.some((d) => d.reason === "night-mode: night"));
    removeNight();
    h.bus.publish("report.t.rest.stop", { kind: "rest.stop", severity: "advice", data: { distanceM: 900, place: "Tapri" } });
    assert.equal(h.said.length, 1);
    assert.deepEqual(h.brain.policies().slice(0, 3), ["expired", "broken", "riding-only"]);
    h.bus.handle("task.deep-search", async ({ query }) => ({ answer: `found ${query}` }));
    assert.deepEqual(await h.brain.delegate("deep-search", { query: "puncture shop" }), { ok: true, result: { answer: "found puncture shop" } });
    const none = await h.brain.delegate("vision-check");
    assert.equal(none.ok, false); assert.equal(none.error, "NO_HANDLER");
    assert.equal(h.brain.transcript().length, 1);
});

test("brain + the real advice gate: quiet ride holds advice, critical always speaks", () => {
    const gate = G.createGate();
    gate.setQuiet(true);
    const spoken = [];
    const h = harness({ voice: (text, o) => { const d = gate.decide({ text, ...o }, Date.now()); if (d.speak) spoken.push(text); return d.speak; } });
    h.bus.publish("report.t.rest.stop", { kind: "rest.stop", severity: "advice", data: { distanceM: 900, place: "Tapri" } });
    h.bus.publish("report.t.x.crash", { kind: "x.crash", severity: "critical", text: "Ruk bhai, aage accident hai!" });
    assert.deepEqual(spoken, ["Ruk bhai, aage accident hai!"]);
    const held = h.decisions.find((d) => d.kind === "rest.stop" && d.action !== "dropped");
    assert.equal(held.action, "shown");                                 // on screen, not spoken
});

// ================================================================ output
test("output: info is transcript-only; others hit the voice and the island with the right kind", () => {
    const calls = [], islands = [], emitted = [];
    const out = O.createOutput({ voice: (t, o) => { calls.push(o); return false; }, island: (s) => { islands.push(s); }, busy: () => false, emit: (d) => emitted.push(d) });
    assert.deepEqual(out.say({ text: "hi", severity: "info", priority: 10 }), { spoken: false, shown: false, reason: "info" });
    const r = out.say({ text: "careful", severity: "critical", priority: 90, category: "radar", key: "radar.close", display: { title: "Dhyan se!" } });
    assert.deepEqual(r, { spoken: false, shown: true, reason: "held" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].priority, 90); assert.equal(calls[0].category, "radar"); assert.equal(calls[0].key, "master:radar.close");
    assert.equal(islands[0].kind, "speed-danger"); assert.equal(islands[0].haptic, true);
    assert.equal(emitted.length, 2);
});

// ================================================================ ride agent
function fakeLocDrive() {
    const fixes = emitter(), drives = emitter();
    let drive = { driving: false, navigating: false };
    return {
        loc: { available: () => true, current: () => null, onFix: fixes.on },
        drive: { available: () => true, current: () => drive, onChange: drives.on },
        fix: (f) => fixes.emit(f),
        setDrive: (d) => { drive = d; drives.emit(d); }
    };
}

test("ride agent: riding time, break reminders at 1:30 and 2:00, a 10-minute stop resets", () => {
    const h = harness();
    const s = fakeLocDrive();
    h.caps.provide("location", s.loc); h.caps.provide("drive", s.drive);
    const reports = [];
    h.bus.subscribe("report.ride.**", (d) => reports.push(`${d.kind}:${d.severity}`));
    h.kernel.define(RIDE);
    h.kernel.start();
    assert.equal(h.kernel.get("ride").state, "running");
    assert.equal(h.bus.last("state.ride").active, false);
    s.setDrive({ driving: true, navigating: false });
    assert.equal(h.bus.last("state.ride").active, true);
    let t = h.clock.now();
    const ride = (sec, speedMs = 15) => { for (let i = 0; i < sec / 5; i++) { t += 5000; s.fix({ t, speedMs, lat: 20, lng: 85 }); } };
    ride(5390);
    assert.ok(!reports.includes("ride.break-due:advice"));
    ride(20);
    assert.ok(reports.includes("ride.break-due:advice"));
    ride(1800);
    assert.ok(reports.includes("ride.break-due:warning"));
    assert.ok(h.bus.last("state.ride").ridingSec >= 7200);
    ride(610, 0);                                                       // a ten-minute stop
    assert.ok(reports.includes("ride.break-taken:info"));
    assert.equal(h.bus.last("state.ride").ridingSec, 0);
    ride(3000);
    assert.ok(h.bus.last("state.ride").ridingSec >= 2990);
    t += 15 * 60 * 1000;                                                // parked with the GPS asleep: no fixes at all
    reports.length = 0;
    ride(5);
    assert.deepEqual(reports, ["ride.break-taken:info"]);
    assert.ok(h.bus.last("state.ride").ridingSec <= 5);
    s.setDrive({ driving: false, navigating: false });
    assert.equal(h.bus.last("state.ride").active, false);
    assert.ok(reports.includes("ride.ended:info"));
});

// ================================================================ network agent
function fakeNetwork() {
    const changes = emitter();
    let st = { connected: true, type: "4g", downlinkMbps: 10, rttMs: 80 };
    let probeResult = { ok: true, rttMs: 120 };
    return {
        provider: { available: () => true, status: () => ({ ...st }), onChange: changes.on, probe: async () => probeResult },
        set(patch) { st = { ...st, ...patch }; changes.emit({ ...st }); },
        setProbe(r) { probeResult = r; }
    };
}

test("network agent: lost while riding is a warning, restored after a minute is said, flapping stays quiet", async () => {
    const h = harness();
    const n = fakeNetwork(), s = fakeLocDrive();
    h.caps.provide("network", n.provider); h.caps.provide("location", s.loc); h.caps.provide("drive", s.drive);
    const reports = [];
    h.bus.subscribe("report.network.**", (d) => reports.push(`${d.kind}:${d.severity}`));
    h.kernel.define(RIDE); h.kernel.define(NET);
    h.kernel.start();
    await flush();
    assert.equal(h.bus.last("state.network").level, "good");
    assert.deepEqual(reports, []);                                      // a good start says nothing
    s.setDrive({ driving: true, navigating: true });
    n.set({ connected: false });
    assert.deepEqual(reports, ["network.lost:warning"]);
    assert.match(h.said.at(-1).text, /Network gaya|signal bilkul nahi/);
    h.clock.advance(90000);
    n.set({ connected: true }); await flush();
    assert.equal(reports.at(-1), "network.restored:advice");
    n.set({ connected: false });                                        // flaps again within 5 min
    assert.equal(reports.at(-1), "network.lost:info");
    n.set({ connected: true }); await flush();
    assert.equal(reports.at(-1), "network.restored:info");              // was gone only a moment
    // connected to a dead tower: two failed probes = offline; a slow round trip = weak
    n.setProbe({ ok: false, rttMs: null });
    h.clock.advance(20000); await flush();
    h.clock.advance(20000); await flush();
    assert.equal(h.bus.last("state.network").level, "offline");
    n.setProbe({ ok: true, rttMs: 2600 });
    h.clock.advance(20000); await flush();
    assert.equal(h.bus.last("state.network").level, "weak");
    assert.equal(reports.at(-1), "network.weak:warning");
});

test("network agent: learns no-signal cells on a ride and warns ahead on the route; good signal forgets them", async () => {
    const h = harness();
    const n = fakeNetwork(), s = fakeLocDrive();
    const routes = emitter();
    let current = null;
    const route = { available: () => true, current: () => current, onChange: routes.on };
    let here = null;
    s.loc.current = () => here;
    h.caps.provide("network", n.provider); h.caps.provide("location", s.loc); h.caps.provide("drive", s.drive); h.caps.provide("route", route);
    const reports = [];
    h.bus.subscribe("report.network.**", (d) => reports.push(d));
    h.kernel.define(RIDE); h.kernel.define(NET);
    h.kernel.start(); await flush();
    s.setDrive({ driving: true, navigating: true });
    // ride 1: signal drops at 20.050, 85.000
    here = { lat: 20.05, lng: 85.0 };
    n.set({ connected: false });
    let t = h.clock.now();
    s.fix({ t: (t += 5000), lat: 20.05, lng: 85.0, speedMs: 12 });
    n.set({ connected: true }); await flush();
    const cells = h.caps.get("store").namespace("network").get("deadCells");
    assert.equal(Object.keys(cells).length, 1);
    // ride 2: a route northwards through that cell; 1.1 km before it we hear about it
    current = { path: Array.from({ length: 60 }, (_, i) => [20.0 + i * 0.001, 85.0]) };
    h.clock.advance(3600000); t = h.clock.now();
    s.fix({ t: (t += 15000), lat: 20.039, lng: 85.0, speedMs: 12 });
    const z = reports.find((r) => r.kind === "network.zone-ahead");
    assert.ok(z, "zone-ahead reported");
    assert.ok(z.data.distanceM >= 300 && z.data.distanceM <= 2000);
    assert.match(h.said.at(-1).text, /aage network gayab|signal chala jaata/);
    s.fix({ t: (t += 15000), lat: 20.040, lng: 85.0, speedMs: 12 });
    assert.equal(reports.filter((r) => r.kind === "network.zone-ahead").length, 1);   // once per zone
    // riding through it with good signal twice forgets it
    s.fix({ t: (t += 15000), lat: 20.05, lng: 85.0, speedMs: 12 });
    s.fix({ t: (t += 15000), lat: 20.06, lng: 85.0, speedMs: 12 });
    s.fix({ t: (t += 15000), lat: 20.05, lng: 85.0, speedMs: 12 });
    assert.equal(Object.keys(h.caps.get("store").namespace("network").get("deadCells")).length, 0);
});

test("template agent runs as documented", async () => {
    const h = harness();
    const s = fakeLocDrive();
    h.caps.provide("location", s.loc); h.caps.provide("drive", s.drive);
    h.kernel.define(RIDE); h.kernel.define(TEMPLATE);
    h.kernel.start();
    assert.equal(h.kernel.get("example").state, "waiting");             // runWhen: only while riding
    s.setDrive({ driving: true, navigating: false });
    assert.equal(h.kernel.get("example").state, "running");
    assert.deepEqual(await h.brain.delegate("example-lookup", { q: "petrol" }), { ok: true, result: { answer: "looked up petrol" } });
    s.fix({ t: h.clock.now() + 1000, speedMs: 33, lat: 1, lng: 1 });
    assert.equal(h.said.length, 1);
    s.setDrive({ driving: false, navigating: false });
    assert.equal(h.kernel.get("example").state, "waiting");
    assert.equal(h.bus.hasResponder("task.example-lookup"), false);
});

// ================================================================ ask first (output + brain)
test("ask first: the Master waits for the answer; declined tips aren't shown; an interrupted one is offered once more", async () => {
    const asks = [], islands = [];
    const h = harness({
        voice: (text, o) => { if (o.priority >= 85) return true; asks.push({ text, o }); return "ask"; },
        island: (spec) => { islands.push(spec.title); return true; }
    });
    const pub = (kind, extra) => h.bus.publish(`report.t.${kind}`, { kind, ...extra }, { source: "t" });
    pub("rest.stop", { severity: "advice", data: { distanceM: 2000, place: "Sharma chai tapri" } });
    pub("ride.break-due", { severity: "advice", key: "ride.break", data: { ridingSec: 5400 } });
    assert.equal(asks.length, 1);
    assert.ok(h.decisions.some((d) => d.kind === "rest.stop" && d.action === "asking"));
    h.clock.advance(10000);
    assert.equal(asks.length, 1);                                       // nothing else while the question is open
    asks[0].o.onResult({ spoken: false, reason: "asked:no" });
    await flush();
    assert.ok(h.decisions.some((d) => d.kind === "rest.stop" && d.action === "declined"));
    assert.deepEqual(islands, []);                                      // a declined tip isn't put on screen either
    assert.equal(h.brain.transcript().at(-1).asked, true);
    h.clock.advance(2500);
    assert.equal(asks.length, 2);
    asks[1].o.onResult({ spoken: false, reason: "asked:interrupted" }); // a turn instruction cut in
    await flush();
    h.clock.advance(2500);
    assert.equal(asks.length, 3);                                       // offered once more…
    assert.equal(asks[2].o.category, "ride");                          // the same break reminder
    asks[2].o.onResult({ spoken: true, reason: "asked:yes" });
    await flush();
    assert.ok(h.decisions.some((d) => d.kind === "ride.break-due" && d.action === "spoken"));
    assert.equal(islands.length, 1);                                    // shown once the rider said yes
    // a warning that goes unanswered still shows (as it did in quiet ride)
    h.clock.advance(3000);
    pub("network.lost", { severity: "warning", key: "network.status" });
    asks.at(-1).o.onResult({ spoken: false, reason: "asked:silence" });
    await flush();
    assert.ok(h.decisions.some((d) => d.kind === "network.lost" && d.action === "unanswered"));
    assert.equal(islands.length, 2);
    // critical never waits for anything
    pub("x.crash", { severity: "critical", text: "Ruk bhai!" });
    assert.equal(asks.length, 4);
    assert.ok(h.decisions.some((d) => d.kind === "x.crash" && d.action === "spoken"));
});

test("persona: whatever the voice's style, screen titles and subtitles are plain English", () => {
    const HINGLISH = /\b(bhai|hai|hain|nahi|kar|karo|aage|ruk|chal|raha|rahi|gaya|thoda|thodi|bahut|aankh|kamzor|wapas|paani|abhi|baad|dhyan|ek baat)\b/i;
    const data = { distanceM: 1200, ridingSec: 5400, condition: "Rain", place: "Sharma Tea Stall", detail: "aankh 1.3 second tak band rahi", hazard: "gaddha", vehicle: "gaadi", ttcS: 3.1, screen: { detail: "Eyes closed for 1.3 seconds", hazard: "Pothole", vehicle: "Car" }, goneSec: 90 };
    for (const style of ["desi", "plain"]) {
        const p = PH.install(P.createPersona({ style, rng: () => 0 }));
        for (const [kind, bySev] of Object.entries(PH.desi)) for (const sev of Object.keys(bySev)) {
            const severity = sev === "any" ? "advice" : sev;
            const out = p.phrase({ kind, key: kind, severity, data });
            assert.doesNotMatch(`${out.display.title} ${out.display.sub}`, HINGLISH, `${style} ${kind}/${sev}: "${out.display.title} / ${out.display.sub}"`);
            assert.ok(out.display.title, `${kind}/${sev} has a screen title`);
        }
    }
    const desi = PH.install(P.createPersona({ style: "desi", rng: () => 0 }));
    const f = desi.phrase({ kind: "fatigue.high", key: "f", severity: "warning", data });
    assert.match(f.text, /aankh 1\.3 second tak band rahi/);                  // spoken: Hinglish
    assert.deepEqual([f.display.title, f.display.sub], ["High fatigue", "Eyes closed for 1.3 seconds"]);   // screen: English
    // the desi pack carries no screen words at all
    for (const bySev of Object.values(PH.desi)) for (const lines of Object.values(bySev)) for (const l of lines) assert.equal("title" in l || "sub" in l, false);
});
