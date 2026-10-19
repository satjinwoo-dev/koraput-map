// Ride Edit: the beat tracker (js/edit/beats.js) on synthetic music with known beats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const B = require("../../public/js/edit/beats.js");

/** Kick on every beat (louder on the bar), hats on the off-beats, a quiet intro then a loud drop. */
function song(bpm, seconds, { offset = 0.2, sr = 22050, dropAt = 8, jitter = 0 } = {}) {
    const pcm = new Float32Array(Math.round(seconds * sr));
    const beat = 60 / bpm, truth = [];
    let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let k = 0; offset + k * beat < seconds - 0.3; k++) {
        const t = offset + k * beat + (jitter ? (rnd() - 0.5) * 2 * jitter : 0); truth.push(t);
        const loud = t >= dropAt ? 1 : 0.35, accent = k % 4 === 0 ? 1 : 0.6;
        const i0 = Math.round(t * sr);
        for (let i = 0; i < 0.12 * sr && i0 + i < pcm.length; i++) {           // kick: falling sine
            const tt = i / sr; pcm[i0 + i] += loud * accent * Math.sin(2 * Math.PI * (110 - 300 * tt) * tt) * Math.exp(-tt * 30);
        }
        const h0 = Math.round((t + beat / 2) * sr);                               // hat: a click of noise
        for (let i = 0; i < 0.02 * sr && h0 + i < pcm.length; i++) pcm[h0 + i] += loud * 0.15 * (rnd() * 2 - 1) * Math.exp(-i / (0.004 * sr));
    }
    return { pcm, sr, truth };
}

for (const bpm of [100, 124, 140]) {
    test(`${bpm} BPM: the tempo, every beat within a frame (33 ms), downbeats on the bar`, () => {
        const s = song(bpm, 16);
        const r = B.analyze(s.pcm, s.sr);
        assert.ok(Math.abs(r.bpm - bpm) < 1.5, `bpm ${r.bpm}`);
        const near = (t) => Math.min(...s.truth.map((x) => Math.abs(x - t)));
        const off = r.beats.filter((t) => t > 0.5 && t < 15).map(near);
        assert.ok(off.length > 20);
        assert.ok(Math.max(...off) < 0.034, `worst ${Math.max(...off).toFixed(3)} s`);
        const bars = s.truth.filter((_, k) => k % 4 === 0);
        const dOff = r.downbeats.filter((t) => t > 0.5 && t < 15).map((t) => Math.min(...bars.map((x) => Math.abs(x - t))));
        assert.ok(Math.max(...dOff) < 0.034, "downbeats are the accented beats");
    });
}

test("the drop is found where the music gets loud, on a downbeat; the first onset is the first kick", () => {
    const s = song(120, 16, { dropAt: 8.2 });
    const r = B.analyze(s.pcm, s.sr);
    assert.ok(r.drops.some((d) => Math.abs(d - 8.2) < 0.6), JSON.stringify(r.drops));
    assert.ok(Math.abs(r.firstOnset - 0.2) < 0.04, String(r.firstOnset));
    assert.ok(r.energy.length > 50 && r.energy.every((e) => e >= 0 && e <= 1));
});

test("a drummer who drifts ±20 ms: beats follow the hits", () => {
    const s = song(110, 16, { jitter: 0.02 });
    const r = B.analyze(s.pcm, s.sr);
    const near = (t) => Math.min(...s.truth.map((x) => Math.abs(x - t)));
    const off = r.beats.filter((t) => t > 0.5 && t < 15).map(near);
    assert.ok(off.filter((x) => x < 0.034).length / off.length > 0.9);
});

test("synthetic: the agent's own beat has the same shape", () => {
    const r = B.synthetic(124, 15);
    assert.equal(r.beats[1], Math.round(60 / 124 * 1000) / 1000);
    assert.equal(r.downbeats.length, Math.ceil(r.beats.length / 4));
    assert.equal(r.drops.length, 1);
    assert.ok(r.downbeats.includes(r.drops[0]));
});
