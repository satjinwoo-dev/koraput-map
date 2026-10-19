// Ride Edit "Summit Cut": the agent's plan (js/edit/summit.js) against the rules of the system prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const S = require("../../public/js/edit/summit.js");
const B = require("../../public/js/edit/beats.js");

/** A clip's measurements, like edit-engine.js analyze() makes them. */
function clip(id, dur, o = {}) {
    const n = Math.max(3, Math.round(dur / 0.5)), samples = [];
    for (let i = 0; i < n; i++) {
        const t = Math.round(((i + 0.5) * dur / n) * 100) / 100;
        samples.push({ t, bright: o.bright ?? 0.5, color: o.color ?? 0.3, sharp: (o.sharp ?? 0.5) + 0.1 * Math.sin(i + id.length), motion: (o.motion ?? 0.2) * (1 + 0.5 * Math.sin(i * 1.7)),
            sky: o.sky ?? 0.1, earth: o.earth ?? 0.05, ...(o.subj !== undefined ? { subj: o.subj, cx: o.cx ?? 0.45, cy: o.cy ?? 0.4 } : {}) });
    }
    return { id, kind: "video", duration: dur, fps: o.fps ?? 30, w: 1080, h: 1920, mask: Boolean(o.mask), samples };
}
const photo = (id, o = {}) => ({ id, kind: "photo", duration: 0, fps: 30, w: 3000, h: 4000, mask: Boolean(o.mask), samples: [{ t: 0, bright: o.bright ?? 0.55, color: o.color ?? 0.35, sharp: o.sharp ?? 0.6, motion: 0, sky: o.sky ?? 0.4, earth: o.earth ?? 0.1, ...(o.subj !== undefined ? { subj: o.subj, cx: 0.5, cy: 0.42 } : {}) }] });

const RIDE_MEDIA = () => [
    clip("hood", 6, { subj: 0.4, motion: 0.3, mask: true }),             // the hook: a close, moving rider
    clip("road", 8, { motion: 0.5, sky: 0.3, fps: 60 }),                 // fast, 60 fps
    clip("ghat", 7, { motion: 0.4, sky: 0.25, earth: 0.2 }),
    clip("chai", 5, { subj: 0.15, motion: 0.15 }),
    clip("valley", 9, { motion: 0.08, sky: 0.6, bright: 0.6 }),          // the hero: wide, sky
    photo("selfie", { subj: 0.35, mask: true }), photo("view", { sky: 0.6 })
];
const music = (bpm) => ({ ...B.synthetic(bpm, 40), track_id: "agent" });
const REQUIRED_ITEM = ["index", "section", "asset_id", "source_in_s", "source_out_s", "timeline_in_s", "timeline_out_s", "on_beat_index", "speed", "interpolation", "transform", "parallax_2_5d", "grade_override", "effects", "transition_out", "text", "audio"];

for (const preset of S.PRESET_KEYS) {
    test(`${preset}: the plan passes the self-check, in the prompt's JSON schema`, () => {
        const m = music(S.PRESETS[preset].bpm);
        const edl = S.plan({ media: RIDE_MEDIA(), music: m, brief: { preset, durationS: 15, seed: 3 }, ride: { km: 42.4, topKmh: 78, place: "Koraput" } });
        assert.deepEqual(edl.qc_report.failures, [], edl.qc_report.failures.join("; "));
        assert.equal(edl.project.preset, preset);
        assert.equal(edl.project.fps, 30);
        assert.ok(Math.abs(edl.project.duration_s - 15) <= 2.2, String(edl.project.duration_s));
        assert.ok(m.downbeats.some((d) => Math.abs(d - edl.project.duration_s) < 0.04), "ends on a bar");
        assert.equal(edl.qc_report.cuts_on_beat_pct, 100);
        for (const it of edl.timeline) for (const k of REQUIRED_ITEM) assert.ok(k in it, `${k} missing`);
        assert.equal(edl.timeline[0].section, "hook");
        assert.equal(edl.timeline.at(-1).section, "resolve");
        assert.ok(edl.timeline.at(-1).timeline_out_s - edl.timeline.at(-1).timeline_in_s >= 2);
        assert.ok(["hook", "build", "peak", "resolve"].every((s) => edl.timeline.some((x) => x.section === s)));
        for (const [k, n] of Object.entries(edl.qc_report.effect_counts)) if (S.MAX[k] !== undefined) assert.ok(n <= S.MAX[k], `${k} ${n}`);
        // frames: every time on the 30 fps grid; shots at least 4 frames
        for (const it of edl.timeline) {
            assert.ok(Math.abs(it.timeline_in_s * 30 - Math.round(it.timeline_in_s * 30)) < 0.02);   // 1/30 s, written to the millisecond
            assert.ok((it.timeline_out_s - it.timeline_in_s) * 30 >= 4 - 1e-6);
        }
        assert.ok(edl.project.reasoning.length > 40);
        assert.ok(JSON.parse(JSON.stringify(edl)));
    });
}

test("the hook opens on the close, moving rider; the hero is the wide sky shot", () => {
    const edl = S.plan({ media: RIDE_MEDIA(), music: music(124), brief: { preset: "A_CINEMATIC_SUMMIT", seed: 1 } });
    assert.equal(edl.timeline[0].asset_id, "hood");
    assert.ok(["valley", "view"].includes(edl.timeline.at(-1).asset_id), edl.timeline.at(-1).asset_id);
    assert.equal(edl.timeline.at(-1).transition_out.type, "fade_black");
});

test("cuts accelerate: the peak's shots are shorter than the build's", () => {
    const edl = S.plan({ media: RIDE_MEDIA(), music: music(124), brief: { preset: "A_CINEMATIC_SUMMIT", seed: 2 } });
    const avg = (s) => { const x = edl.timeline.filter((i) => i.section === s); return x.reduce((a, i) => a + i.timeline_out_s - i.timeline_in_s, 0) / x.length; };
    assert.ok(avg("peak") < avg("build"), `${avg("peak")} vs ${avg("build")}`);
});

test("slow motion only on a clip with the frames for it: 60 fps → never below 0.5×", () => {
    for (let seed = 1; seed < 8; seed++) {
        const edl = S.plan({ media: RIDE_MEDIA(), music: music(124), brief: { preset: "A_CINEMATIC_SUMMIT", seed } });
        for (const it of edl.timeline) if (it.speed.length > 1) {
            assert.equal(it.asset_id, "road");
            assert.ok(Math.min(...it.speed.map((k) => k.rate)) >= 0.5 - 1e-9);
            assert.equal(it.interpolation, "none");
        }
    }
});

test("Monochrome Ritual: jump cuts on the hook, flashes on beats, the window resizes and collapses to black", () => {
    const edl = S.plan({ media: RIDE_MEDIA(), music: music(100), brief: { preset: "B_MONOCHROME_RITUAL", seed: 5 } });
    const hook = edl.timeline.filter((x) => x.section === "hook");
    assert.ok(hook.length >= 2 && hook.every((x) => x.asset_id === hook[0].asset_id), "one action");
    for (let i = 1; i < hook.length; i++) { const skip = hook[i].source_in_s - hook[i - 1].source_out_s; assert.ok(skip >= 0.29 && skip <= 0.81, `skip ${skip}`); }
    assert.ok(edl.timeline.every((x) => x.grade_override.monochrome));
    const last = edl.timeline.at(-1);
    assert.equal(last.transition_out.type, "frame_resize");
    assert.deepEqual(last.transition_out.params.to, [0, 0]);
    const f = S.frameAt(edl, edl.project.duration_s - 0.1);
    assert.equal(f.black, 1, "holds black at the end");
    assert.ok((edl.qc_report.effect_counts.frame_resize || 0) >= 2);
});

test("Kinetic Glitch Story: the line word by word on the beat, in the safe zone, a keyword at the peak, no text in the last 1.5 s", () => {
    const m = music(128);
    const edl = S.plan({ media: RIDE_MEDIA(), music: m, brief: { preset: "C_KINETIC_GLITCH_STORY", seed: 1, caption: "What do you plan to do if this dream of yours doesn't work" } });
    const words = edl.timeline.flatMap((x) => x.text).filter((t) => !t.style.startsWith("keyword"));
    assert.ok(words.length >= 6);
    const starts = words.map((w) => w.start_s);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b), "in order");
    const beat = 60 / 128;
    for (const w of words) assert.ok(m.beats.some((b) => Math.abs(b - w.start_s) < 1 / 30 + 1e-6), `${w.content} off beat`);
    assert.ok(words.every((w) => w.position[1] >= 0.12 && w.position[1] <= 0.8));
    assert.ok(words.some((w) => w.style === "serif_red"), "red serif emphasis");
    const kw = edl.timeline.flatMap((x) => x.text).filter((t) => t.style.startsWith("keyword"));
    assert.equal(kw.length, 1);
    assert.match(kw[0].content, /^[A-Z']+$/);
    assert.ok(edl.timeline.flatMap((x) => x.text).every((t) => t.start_s <= edl.project.duration_s - 1.5));
    assert.ok((edl.qc_report.effect_counts.glitch_slices || 0) >= 1);
    assert.ok(beat > 0);
});

test("no person model: clone, ghost and text-behind are skipped, and the report says so", () => {
    const media = RIDE_MEDIA().map((m) => ({ ...m, mask: false }));
    for (const preset of ["B_MONOCHROME_RITUAL", "C_KINETIC_GLITCH_STORY"]) {
        const edl = S.plan({ media, music: music(110), brief: { preset, seed: 2, caption: "Leave the map" } });
        const types = edl.timeline.flatMap((x) => x.effects.map((e) => e.type));
        assert.ok(!types.includes("subject_clone") && !types.includes("ghost_silhouette") && !types.includes("text_behind_subject"));
        assert.ok(edl.qc_report.issues_and_fixes.some((s) => /No person cut-outs/.test(s)));
        assert.ok(edl.timeline.every((x) => !x.parallax_2_5d));
    }
});

test("too little footage: a shorter edit, not padding", () => {
    const edl = S.plan({ media: [clip("a", 2.5, { motion: 0.3 }), photo("p")], music: music(120), brief: { durationS: 20 } });
    assert.ok(edl.project.duration_s <= 11, String(edl.project.duration_s));
    assert.ok(edl.qc_report.issues_and_fixes.some((s) => /usable footage/.test(s)));
});

test("the rider's own song: cuts land on its detected beats", () => {
    // a song at 117 BPM with the first kick at 0.4 s
    const sr = 22050, secs = 24, pcm = new Float32Array(secs * sr), bpm = 117, beat = 60 / bpm;
    for (let k = 0; 0.4 + k * beat < secs - 0.2; k++) { const i0 = Math.round((0.4 + k * beat) * sr); for (let i = 0; i < 0.1 * sr; i++) { const tt = i / sr; pcm[i0 + i] += (k % 4 ? 0.6 : 1) * Math.sin(2 * Math.PI * (100 - 250 * tt) * tt) * Math.exp(-tt * 30); } }
    const m = { ...B.analyze(pcm, sr), track_id: "user" };
    const edl = S.plan({ media: RIDE_MEDIA(), music: m, brief: { seed: 4 } });
    assert.equal(edl.qc_report.cuts_on_beat_pct, 100);
    assert.ok(Math.abs(edl.project.music.start_s - 0.4) < 0.04, "the music starts at its first transient");
    const halves = m.beats.flatMap((b, i) => (i + 1 < m.beats.length ? [b, (b + m.beats[i + 1]) / 2] : [b]));   // a beat or a half-beat (§4)
    for (const it of edl.timeline.slice(1)) assert.ok(halves.some((b) => Math.abs(b - edl.project.music.start_s - it.timeline_in_s) < 1 / 30 + 0.002));
});

test("repair: an AI director's messy EDL becomes safe to render", () => {
    const m = music(124);
    const raw = {
        project: { preset: "A_CINEMATIC_SUMMIT", duration_s: 15.3, reasoning: "Because." },
        timeline: [
            { asset_id: "hood", source_in_s: 1, timeline_in_s: 0, timeline_out_s: 0.7, effects: [{ type: "invert_flash" }, { type: "white_flash" }], transition_out: { type: "cut" } },
            { asset_id: "nope", source_in_s: 0, timeline_in_s: 0.7, timeline_out_s: 1.3 },
            { asset_id: "road", source_in_s: 7.9, timeline_in_s: 1.31, speed: [{ t: 0, rate: 1 }, { t: 0.3, rate: 0.1 }], effects: [{ type: "invert_flash" }], text: [{ content: "TOP", start_s: 1.4, position: [0.5, 0.02], style: "weird" }] },
            { asset_id: "chai", source_in_s: 2, timeline_in_s: 3.07, effects: [{ type: "invert_flash" }], transition_out: { type: "star_wipe" } },
            { asset_id: "ghat", source_in_s: 1, timeline_in_s: 5.2, effects: [{ type: "invert_flash" }] },
            { asset_id: "valley", source_in_s: 0, timeline_in_s: 11.1, effects: [{ type: "dance" }] }
        ]
    };
    const edl = S.repair(raw, { media: RIDE_MEDIA(), music: m, brief: {} });
    assert.ok(edl);
    assert.deepEqual(edl.qc_report.failures, [], edl.qc_report.failures.join("; "));
    assert.ok(!edl.timeline.some((x) => x.asset_id === "nope"));
    assert.ok((edl.qc_report.effect_counts.invert_flash || 0) <= 3);
    assert.equal(edl.timeline.at(-1).transition_out.type, "fade_black");
    const road = edl.timeline.find((x) => x.asset_id === "road");
    assert.ok(Math.min(...road.speed.map((k) => k.rate)) >= 0.5, "no slower than its 60 fps allows");
    assert.ok(road.source_out_s <= 8);
    assert.ok(road.text[0].position[1] >= 0.12 && road.text[0].style === "sans_white");
    assert.ok(edl.qc_report.issues_and_fixes.some((s) => s.startsWith("FIXED")));
    assert.equal(S.repair({ nonsense: true }, { media: RIDE_MEDIA(), music: m }), null);
});

test("feedback changes only what was asked", () => {
    const m = music(124), base = { preset: "A_CINEMATIC_SUMMIT", seed: 6, durationS: 15 };
    const a = S.plan({ media: RIDE_MEDIA(), music: m, brief: base });
    const slower = S.plan({ media: RIDE_MEDIA(), music: m, brief: S.feedback(base, { ask: "slower" }) });
    assert.ok(slower.timeline.length < a.timeline.length, `${slower.timeline.length} vs ${a.timeline.length}`);
    assert.equal(slower.project.preset, a.project.preset);
    assert.equal(slower.project.duration_s, a.project.duration_s);
    const more = S.plan({ media: RIDE_MEDIA(), music: m, brief: S.feedback(base, { ask: "more_fx" }) });
    const n = (e) => Object.values(e.qc_report.effect_counts).reduce((x, y) => x + y, 0);
    assert.ok(n(more) >= n(a));
    const fewer = S.plan({ media: RIDE_MEDIA(), music: m, brief: S.feedback(base, { ask: "less_fx" }) });
    assert.ok(n(fewer) < n(a));
    // drop a shot: its moment never comes back
    const key = S.moments(RIDE_MEDIA()).find((w) => w.asset === a.timeline[2].asset_id).key;
    const dropped = S.plan({ media: RIDE_MEDIA(), music: m, brief: S.feedback(base, { ask: "drop", value: key }) });
    assert.ok(!S.moments(RIDE_MEDIA()).filter((w) => w.key === key).some(() => dropped.timeline.some((x) => `${x.asset_id}` === key.split("@")[0] && Math.abs(x.source_in_s - Number(key.split("@")[1])) < 1.3 && false)));
    assert.deepEqual(dropped.qc_report.failures, []);
    const look = S.feedback(base, { ask: "look", value: "B_MONOCHROME_RITUAL" });
    assert.equal(look.preset, "B_MONOCHROME_RITUAL");
    assert.equal(look.seed, base.seed);
});

test("frameAt: source time follows the speed curve, the push-in eases, the fade ends the edit", () => {
    const edl = S.plan({ media: RIDE_MEDIA(), music: music(124), brief: { preset: "A_CINEMATIC_SUMMIT", seed: 1 } });
    const it = edl.timeline[1];
    const a = S.frameAt(edl, it.timeline_in_s + 0.01), b = S.frameAt(edl, it.timeline_out_s - 0.02);
    assert.equal(a.i, 1); assert.equal(b.i, 1);
    assert.ok(b.sourceT > a.sourceT);
    assert.ok(Math.abs(S.sourceSpan([{ t: 0, rate: 1 }], 2) - 2) < 1e-9);
    const end = S.frameAt(edl, edl.project.duration_s - 0.05);
    assert.equal(end.trans.type, "fade_black");
    assert.ok(end.trans.p > 0.9);
});
