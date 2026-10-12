// The Master AI avatar (public/js/ai/): which face shows when, wired to the real brain,
// and the page wiring (import map, script order, ids, CSP hash, offline precache).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC = path.join(ROOT, "public");
const S = require("../../public/js/ai/avatar-state.js");
const C = require("../../public/js/master/contracts.js");
const B = require("../../public/js/master/bus.js");
const P = require("../../public/js/master/persona.js");
const PH = require("../../public/js/master/phrases-desi.js");
const O = require("../../public/js/master/output.js");
const BR = require("../../public/js/master/brain.js");
const { importMapHashes } = require("../../lib/csp-inline.js");

const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), "utf8");

// ---------------------------------------------------------------- state rules
test("idle until something happens; a line playing is speaking, and ends back in idle", () => {
    const st = S.createAvatarState();
    assert.equal(st.mode(0), "idle");
    assert.deepEqual(st.handle({ type: "voice", phase: "start", priority: 50, route: "web" }, 10), { pulse: 0 });
    assert.equal(st.mode(10), "speaking");
    assert.equal(st.speaking, true);
    st.handle({ type: "voice", phase: "end" }, 900);
    assert.equal(st.mode(900), "idle");
    assert.equal(st.speaking, false);
});

test("the premium voice still downloading reads as thinking, then speaking once it plays", () => {
    const st = S.createAvatarState();
    st.handle({ type: "voice", phase: "start", priority: 40, route: "pending" }, 0);
    assert.equal(st.mode(0), "thinking");
    assert.equal(st.speaking, false, "no voice level while nothing is heard");
    st.handle({ type: "voice", phase: "route", route: "cloud" }, 700);
    assert.equal(st.mode(700), "speaking");
    st.handle({ type: "voice", phase: "route", route: "native" }, 800);            // a route change without a line is ignored after end
    st.handle({ type: "voice", phase: "end" }, 2000);
    st.handle({ type: "voice", phase: "route", route: "cloud" }, 2100);
    assert.equal(st.mode(2100), "idle");
});

test("a safety line (priority ≥ 85) is alert for as long as it's spoken, with one pulse at its start", () => {
    const st = S.createAvatarState();
    assert.deepEqual(st.handle({ type: "voice", phase: "start", priority: 95, route: "native" }, 0), { pulse: S.PULSE.criticalLine });
    assert.equal(st.mode(0), "alert");
    assert.equal(st.speaking, true, "the brain still moves with the voice");
    st.handle({ type: "voice", phase: "end" }, 3000);
    assert.equal(st.mode(3000), "idle");
    assert.equal(st.handle({ type: "voice", phase: "start", priority: S.CRITICAL_PRIORITY - 1 }, 4000).pulse, 0);
});

test("the mic: an answer or a command is listening; the ride-long hands-free listening isn't", () => {
    const st = S.createAvatarState();
    st.handle({ type: "mic", on: true, mode: "ask" }, 0);
    assert.equal(st.mode(0), "listening");
    st.handle({ type: "mic", on: false, mode: null }, 10);
    assert.equal(st.mode(10), "idle");
    st.handle({ type: "mic", on: true, mode: "handsfree" }, 20);
    assert.equal(st.mode(20), "idle");
    st.handle({ type: "mic", on: true, mode: "ptt" }, 30);
    assert.equal(st.mode(30), "listening");
    st.handle({ type: "voice", phase: "start", priority: 80, route: "web" }, 40);
    assert.equal(st.mode(40), "speaking", "speaking wins over listening");
});

test("a delegated task is thinking until it's done, or for THINK_MAX_MS at most", () => {
    const st = S.createAvatarState();
    st.handle({ type: "task", phase: "start", task: "deep-search" }, 1000);
    assert.equal(st.mode(1000), "thinking");
    assert.equal(st.nextChange(1000), 1000 + S.THINK_MAX_MS);
    st.handle({ type: "task", phase: "end", task: "deep-search" }, 4000);
    assert.equal(st.mode(4000), "idle");
    assert.equal(st.nextChange(4000), Infinity);
    st.handle({ type: "task", phase: "start", task: "poi-best" }, 5000);
    assert.equal(st.mode(5000 + S.THINK_MAX_MS - 1), "thinking");
    assert.equal(st.mode(5000 + S.THINK_MAX_MS), "idle", "a task that never reports back stops thinking");
});

test("hazards the Master delivered: critical and warning go alert with a pulse; the rest don't", () => {
    const st = S.createAvatarState();
    assert.equal(st.handle({ type: "decision", severity: "warning", kind: "weather.rain", action: "spoken" }, 0).pulse, S.PULSE.warning);
    assert.equal(st.mode(0), "alert");
    assert.equal(st.nextChange(0), S.ALERT_HOLD_MS.warning);
    assert.equal(st.mode(S.ALERT_HOLD_MS.warning), "idle");
    // the same hazard confirmed again soon: no second pulse, no new alert
    assert.equal(st.handle({ type: "decision", severity: "warning", kind: "weather.rain", action: "spoken" }, 5000).pulse, 0);
    assert.equal(st.mode(5000), "idle");
    // a different one, critical: longer hold, stronger pulse, and it beats speaking
    st.handle({ type: "voice", phase: "start", priority: 60, route: "web" }, 6000);
    assert.equal(st.handle({ type: "decision", severity: "critical", kind: "blackspot.ahead", action: "spoken" }, 6000).pulse, S.PULSE.critical);
    assert.equal(st.mode(6000 + S.ALERT_HOLD_MS.critical - 1), "alert");
    assert.equal(st.mode(6000 + S.ALERT_HOLD_MS.critical), "speaking");
    // after REPEAT_MS the same kind pulses again
    assert.equal(st.handle({ type: "decision", severity: "warning", kind: "weather.rain", action: "shown" }, S.REPEAT_MS + 1).pulse, S.PULSE.warning);
    // never for dropped / superseded / rejected reports, advice or info
    const quiet = S.createAvatarState();
    for (const ev of [
        { severity: "critical", kind: "a", action: "dropped" }, { severity: "warning", kind: "b", action: "superseded" },
        { severity: "warning", kind: "c", action: "rejected" }, { severity: "advice", kind: "d", action: "spoken" }, { severity: "info", kind: "e", action: "held" }
    ]) assert.equal(quiet.handle({ type: "decision", ...ev }, 0).pulse, 0);
    assert.equal(quiet.mode(0), "idle");
    assert.deepEqual(quiet.handle(null, 0), { pulse: 0 });
    assert.deepEqual(quiet.handle({ type: "nonsense" }, 0), { pulse: 0 });
});

test("speechLevel: a 0..1 rhythm that starts from silence and keeps moving", () => {
    assert.equal(S.speechLevel(0), 0);
    const v = Array.from({ length: 200 }, (_, i) => S.speechLevel(150 + i * 37));
    for (const x of v) assert.ok(x >= 0 && x <= 1);
    assert.ok(Math.max(...v) - Math.min(...v) > 0.5, "visibly animated");
});

test("the state's modes are exactly the particle core's MODES", () => {
    const core = read("js/ai/ai-particle-core.js");
    const block = core.match(/export const MODES = \{([\s\S]*?)\n\};/)[1];
    const keys = [...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    assert.deepEqual([...keys].sort(), [...S.MODES].sort());
});

// ---------------------------------------------------------------- with the real brain
function brainHarness() {
    const bus = B.createBus();
    const persona = PH.install(P.createPersona({ style: "desi", rng: () => 0 }));
    const output = O.createOutput({ window: {}, voice: () => true, island: () => true, busy: () => false, emit: () => {} });
    const brain = BR.createBrain({ bus, contracts: C, persona, output });
    const st = S.createAvatarState();
    const pulses = [];
    const feed = (ev) => { const r = st.handle(ev, Date.now()); if (r.pulse) pulses.push(r.pulse); };
    // the same subscriptions avatar-app.js makes
    bus.subscribe("master.delegated", (d) => feed({ type: "task", phase: "start", task: d.task }));
    bus.subscribe("master.task-done", (d) => feed({ type: "task", phase: "end", task: d.task }));
    bus.subscribe("master.decision", (d) => feed({ type: "decision", severity: d.severity, kind: d.kind, action: d.action }));
    return { bus, brain, st, pulses };
}

test("brain.delegate is thinking from master.delegated to master.task-done (answered or failed)", async () => {
    const h = brainHarness();
    const done = [];
    h.bus.subscribe("master.task-done", (d) => done.push(d));
    let release;
    h.bus.handle("task.deep-search", () => new Promise((r) => { release = r; }));
    const p = h.brain.delegate("deep-search", { query: "Araku" });
    await Promise.resolve();
    assert.equal(h.st.mode(Date.now()), "thinking");
    release({ spoken: "haan" });
    assert.deepEqual(await p, { ok: true, result: { spoken: "haan" } });
    assert.equal(h.st.mode(Date.now()), "idle");
    const none = await h.brain.delegate("nobody-handles-this");
    assert.equal(none.ok, false);
    assert.equal(h.st.mode(Date.now()), "idle");
    assert.deepEqual(done.map((d) => [d.task, d.ok]), [["deep-search", true], ["nobody-handles-this", false]]);
    assert.ok(done.every((d) => Number.isFinite(d.ms) && d.ms >= 0));
});

test("a radar agent's critical report reaching the rider turns the face to alert with a pulse", () => {
    const h = brainHarness();
    h.bus.publish("report.blackspot.blackspot.ahead", { kind: "blackspot.ahead", severity: "critical", data: { distanceM: 400 } });
    assert.equal(h.st.mode(Date.now()), "alert");
    assert.deepEqual(h.pulses, [S.PULSE.critical]);
});

// ---------------------------------------------------------------- the page
test("index.html: the import map comes before every module script, the avatar after the Master", () => {
    const map = html.indexOf('<script type="importmap">');
    const firstModule = html.search(/<script type="module"/);
    assert.ok(map > 0 && map < firstModule, "an import map after a module script is ignored");
    const json = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
    assert.equal(json.imports.three, "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js");
    assert.equal(json.imports["three/addons/"], "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/");
    const order = ['<script src="js/master/master-app.js', '<script src="js/ai/avatar-state.js', '<script type="module" src="js/ai/avatar-app.js'].map((f) => html.indexOf(f));
    assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], String(order));
    assert.match(html, /<script type="module" src="js\/ai\/avatar-app\.js\?v=[^"]+"><\/script>/);
    assert.match(html, /<link rel="stylesheet" href="js\/ai\/avatar\.css\?v=[^"]+">/);
});

test("index.html: every element avatar-app.js looks up exists, once; ids are unique page-wide", () => {
    const app = read("js/ai/avatar-app.js");
    const wanted = new Set([...app.matchAll(/(?:\$|txt)\("([\w-]+)"\)/g)].map((m) => m[1]));
    for (const id of ["mu-avatar", "ai-master-core", "mu-avatar-pip-btn", "mu-avatar-close", "mu-avatar-talk", "avatar-open-btn", "premium-nav-ui", "turn-dist", "turn-name", "speed-n"]) assert.ok(wanted.has(id), id);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    for (const id of wanted) assert.equal(ids.filter((x) => x === id).length, 1, `#${id}`);
    const dupes = ids.filter((x, i) => ids.indexOf(x) !== i);
    assert.deepEqual(dupes, []);
});

test("index.html: the Google Maps script tag is exactly as it was", () => {
    assert.ok(html.includes('<script src="https://maps.googleapis.com/maps/api/js?key=AIzaSyASbmXgn0T-B4AQdCe1sp7dfJbDXKgDw5c&libraries=places&loading=async"></script>'));
    assert.equal(html.match(/maps\.googleapis\.com\/maps\/api\/js/g).length, 1);
});

test("CSP: the import map is allowed by its exact SHA-256 (computed from the page)", () => {
    const inner = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1];
    const expected = `'sha256-${crypto.createHash("sha256").update(inner, "utf8").digest("base64")}'`;
    assert.deepEqual(importMapHashes(html), [expected]);
    assert.deepEqual(importMapHashes("<p>no map</p>"), []);
    const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    assert.match(server, /scriptSrc: \["'self'", \.\.\.IMPORT_MAP_HASHES,/);
});

test("offline: the service worker precaches the avatar's files and the pinned Three.js", () => {
    const sw = read("sw.js");
    for (const f of ["/js/ai/avatar-state.js", "/js/ai/avatar-app.js", "/js/ai/ai-particle-core.js", "/js/ai/avatar-ridges.js", "/js/ai/avatar.css"]) {
        assert.ok(sw.includes(`"${f}"`), f);
        assert.ok(fs.existsSync(path.join(PUBLIC, f)), `${f} exists`);
    }
    assert.ok(sw.includes('"https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js"'));
    // what the module imports is what's precached
    for (const f of ["js/ai/avatar-app.js", "js/ai/avatar-ridges.js"]) {
        for (const m of read(f).matchAll(/^import .* from "\.\/([\w-]+\.js)";$/gm)) assert.ok(sw.includes(`"/js/ai/${m[1]}"`), `${f} imports ${m[1]}`);
    }
});
