// Ride Edit's AI director (lib/master/edit-director.js): numbers in, the Summit Cut prompt, an EDL out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const D = require("../../lib/master/edit-director.js");
const S = require("../../public/js/edit/summit.js");
const B = require("../../public/js/edit/beats.js");

const media = [
    { id: "m0", kind: "video", duration: 6, fps: 60, w: 1080, h: 1920, mask: true, samples: [{ t: 1, bright: 0.5, color: 0.3, sharp: 0.6, motion: 0.4, subj: 0.3, cx: 0.5, cy: 0.4, url: "blob:secret" }] },
    { id: "m1", kind: "photo", duration: 0, fps: 30, w: 4000, h: 3000, samples: [{ t: 0, bright: 0.6, color: 0.4, sharp: 0.7, motion: 0, sky: 0.5 }], thumb: "data:image/jpeg;base64,AAAA" }
];
const music = { ...B.synthetic(124, 30), track_id: "agent:A" };

test("only bounded numbers reach the engine: no thumbnails, URLs or pixels", () => {
    const c = D.cleanInput({ brief: { preset: "A_CINEMATIC_SUMMIT", durationS: 15, caption: "x".repeat(500) }, media, music });
    const s = JSON.stringify(c);
    assert.ok(!/blob:|data:image|thumb|url/.test(s), s.slice(0, 200));
    assert.equal(c.brief.caption.length, 120);
    assert.equal(c.media[0].samples[0].subj, 0.3);
    assert.ok(c.music.beats.length > 30);
});

test("the Summit Cut prompt goes to the engine as the system prompt; the JSON comes back", async () => {
    let asked = null;
    const plan = S.plan({ media, music, brief: { preset: "A_CINEMATIC_SUMMIT", seed: 1 } });
    const engines = { configured: () => true, async reason(q) { asked = q; const text = "Here you go:\n```json\n" + JSON.stringify(plan) + "\n```"; return q.accept(text) ? { ok: true, engine: "groq", text } : { ok: false, tried: [] }; } };
    const r = await D.createEditDirector({ engines }).handle({ brief: { durationS: 15 }, media, music });
    assert.equal(r.status, 200);
    assert.equal(r.json.engine, "groq");
    assert.ok(asked.system.includes("Summit Cut") && asked.system.includes("EDIT DECISION LIST"));
    assert.ok(asked.system.includes("interpolation\": \"none\""), "the app's limits are explained");
    assert.deepEqual(r.json.edl.timeline.length, plan.timeline.length);
    // what the phone does with it
    const fixed = S.repair(r.json.edl, { media, music, brief: {} });
    assert.deepEqual(fixed.qc_report.failures, []);
});

test("no engine, nonsense, or no footage: a clear reason (the phone uses its own plan)", async () => {
    const none = await D.createEditDirector({ engines: { configured: () => false, reason: async () => ({ ok: false }) } }).handle({ media, music });
    assert.equal(none.json.reason, "no-engine");
    const bad = await D.createEditDirector({ engines: { configured: () => true, reason: async (q) => ({ ok: q.accept("I can't do that"), tried: [{ engine: "gemini", error: "UNUSABLE" }] }) } }).handle({ media, music });
    assert.equal(bad.json.reason, "no-answer");
    const empty = await D.createEditDirector({ engines: { configured: () => true, reason: async () => ({ ok: true }) } }).handle({ media: [], music });
    assert.equal(empty.status, 400);
    assert.equal(D.parseEdl("{ not json"), null);
});
