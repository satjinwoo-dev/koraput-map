// Ride Edit (public/js/edit/edit-core.js): the agent picks the best moments, a look that suits the clips, the ride's
// real figures (never made up), and a beat-synced timeline in each of the three looks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const E = require("../../public/js/edit/edit-core.js");

const vid = (dur, f) => ({ kind: "video", duration: dur, samples: Array.from({ length: Math.floor(dur / 0.5) }, (_, i) => ({ t: i * 0.5, ...f(i * 0.5) })) });
const photo = (s) => ({ kind: "photo", samples: [{ t: 0, ...s }] });
const media = [
    vid(10, (t) => ({ sharp: t > 5 && t < 8 ? 0.9 : 0.2, motion: t > 5 && t < 8 ? 0.4 : 0.05, color: 0.3, bright: 0.5 })),   // best between 5 and 8 s
    vid(6, () => ({ sharp: 0.4, motion: 0.2, color: 0.25, bright: 0.45 })),
    photo({ sharp: 0.7, motion: 0, color: 0.4, bright: 0.55 }),
    photo({ sharp: 0.1, motion: 0, color: 0.1, bright: 0.95 })
];
const card = { title: "Evening ride", startedAt: Date.UTC(2026, 9, 18, 12), distance: 172400, moving: 4.3 * 3600, ecoScore: 0.82, place: "",
    route: { pts: Array.from({ length: 20 }, (_, i) => [i / 19, Math.sin(i / 3) * 0.3 + 0.5]), aspect: 1, extent: 50000 } };

test("the best moments: the sharp, moving stretch of a clip first; photos too; windows don't overlap", () => {
    const m = E.pickMoments(media);
    const first = m.find((x) => x.m === 0);
    assert.ok(first.inS >= 3.5 && first.inS <= 7, `the clip's best window starts at ${first.inS}`);
    assert.ok(m.some((x) => x.kind === "photo" && x.m === 2));
    const w0 = m.filter((x) => x.m === 0).map((x) => x.inS).sort((a, b) => a - b);
    for (let i = 1; i < w0.length; i++) assert.ok(w0[i] - w0[i - 1] >= 2.4 - 1e-9, "no overlap");
    assert.ok(m.indexOf(m.find((x) => x.m === 3)) > m.indexOf(m.find((x) => x.m === 2)), "the blown-out photo ranks below the good one");
});

test("the look the agent picks, and why", () => {
    assert.equal(E.chooseStyle([vid(4, () => ({ color: 0.05, motion: 0.2 }))]).style, "mono");
    assert.equal(E.chooseStyle([vid(4, () => ({ color: 0.3, motion: 0.2 })), vid(4, () => ({ color: 0.3, motion: 0.2 }))]).style, "cinematic");
    assert.equal(E.chooseStyle([photo({ color: 0.4, motion: 0 }), photo({ color: 0.4, motion: 0 })]).style, "kinetic");
    assert.match(E.chooseStyle([]).why, /Kinetic/);
});

test("the ride's words: its title and real figures only; no figures when the summary has none", () => {
    const l = E.storyLines(card, { seed: 3 });
    assert.equal(l.title, "EVENING RIDE");
    assert.deepEqual(l.stats.map((s) => s.big), ["172", "4 H", "82"]);
    assert.equal(l.stats[1].small, "18 MIN");
    assert.match(l.sub, /2026/);
    const none = E.storyLines(null, {});
    assert.equal(none.stats.length, 0, "nothing invented");
    assert.deepEqual(E.storyLines(card, { caption: "  koraput   to araku  " }).words, ["koraput", "to", "araku"]);
});

test("each look: on its beat, about the length asked, opening title, figures, route, end card", () => {
    for (const style of ["cinematic", "mono", "kinetic"]) {
        const p = E.plan({ media, card, style, targetS: 20, seed: 5 });
        const beat = 60 / E.STYLES[style].bpm;
        assert.ok(p.duration > 14 && p.duration < 30, `${style}: ${p.duration}`);
        assert.equal(p.shots[0].text.kind, "title");
        assert.equal(p.shots.at(-1).text.kind, "end");
        assert.ok(p.shots.some((s) => s.kind === "route"), "the route draws itself");
        assert.deepEqual(p.shots.filter((s) => s.text && s.text.kind === "stat").map((s) => s.text.big), ["172", "4 H", "82"]);
        for (const s of p.shots) {
            const k = s.durS / beat;
            assert.ok(Math.abs(k * 4 - Math.round(k * 4)) < 1e-2 || s.text, `${style}: shot of ${k} beats lands on the grid`);
        }
        for (let i = 1; i < p.shots.length; i++) assert.ok(Math.abs(p.shots[i].at - (p.shots[i - 1].at + p.shots[i - 1].durS)) < 2e-3, "back to back");
        const same = p.shots.filter((s, i) => i && s.kind === "media" && s.m === p.shots[i - 1].m && p.shots[i - 1].kind === "media").length;
        assert.ok(same <= 1, `${style}: the same file twice in a row ${same} times`);
    }
    const cin = E.plan({ media, card, style: "cinematic", targetS: 20, seed: 5 });
    assert.equal(cin.shots.filter((s) => s.fx && s.fx.hud).length, 1, "one viewfinder shot");
    const mono = E.plan({ media, card, style: "mono", targetS: 30, seed: 2 });
    assert.ok(mono.shots.some((s) => s.fx.shrink), "frames shrink away");
    const kin = E.plan({ media, card, style: "kinetic", targetS: 30, seed: 2 });
    assert.ok(kin.shots.some((s) => s.text && s.text.kind === "words"), "words on the beat");
    assert.deepEqual(E.plan({ media, card, style: "kinetic", seed: 9 }), E.plan({ media, card, style: "kinetic", seed: 9 }), "the same seed, the same edit");
    assert.equal(E.plan({ media: [], card: null, style: "kinetic", targetS: 10 }).shots[0].kind, "card", "no media: still an edit of cards");
});

test("a frame: which shot, zoom over the shot, flash at its start, shrink at its end, words one per beat", () => {
    const p = E.plan({ media, card, style: "mono", targetS: 30, seed: 2 });
    const s = p.shots.find((x) => x.fx.shrink && x.durS > 1);
    const a = E.frameAt(p, s.at + 0.01), b = E.frameAt(p, s.at + s.durS * 0.99);
    assert.equal(a.shot, s);
    assert.equal(a.shrink, 1);
    assert.ok(b.shrink < 0.4, "nearly gone at the end");
    assert.ok(b.zoom > a.zoom);
    const f = p.shots.find((x) => x.fx.flash === "white");
    if (f) assert.ok(E.frameAt(p, f.at + 0.01).flash > 0.8 && E.frameAt(p, f.at + 0.3).flash === 0);
    const k = E.plan({ media, card, style: "kinetic", targetS: 30, seed: 2 });
    const w = k.shots.find((x) => x.text && x.text.kind === "words");
    assert.equal(E.frameAt(k, w.at + 0.01).words, 1);
    assert.equal(E.frameAt(k, w.at + k.beat * 2 + 0.01).words, 3);
    const v = k.shots.find((x) => x.mk === "video" && x.fx.speed === 0.6);
    if (v) assert.ok(Math.abs(E.frameAt(k, v.at + 1).mediaT - (v.inS + 0.6)) < 1e-9, "slow motion runs the clip at 0.6×");
});

test("the wiring: loaded and cached offline; opened from the ride recap with its card; nothing uploaded", async () => {
    const fs = await import("node:fs");
    const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
    const html = read("public/index.html"), sw = read("public/sw.js"), ui = read("public/js/share/share-ui.js"), eng = read("public/js/edit/edit-engine.js"), app = read("public/js/edit/edit-app.js");
    for (const f of ["edit-core.js", "edit-engine.js", "edit-app.js"]) { assert.match(html, new RegExp(`js/edit/${f.replace(".", "\\.")}\\?v=`)); assert.ok(sw.includes(`"/js/edit/${f}"`)); }
    assert.ok(sw.includes('"/js/edit/edit.css"'));
    assert.match(ui, /RideEdit\.open\(\{ card \}\)/, "the recap's own card: trimmed for privacy, real figures");
    assert.doesNotMatch(eng + app, /fetch\(|XMLHttpRequest|socket\.emit/, "clips and the edit stay on the phone");
    assert.match(eng, /video\/mp4;codecs=avc1/, "H.264 MP4 first, where the phone can record it");
});
