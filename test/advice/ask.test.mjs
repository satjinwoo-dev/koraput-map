// Ask before tips: "Bhai, ek baat bolun?" → listen → speak only after a yes
// (public/js/advice/ask.js, gate.js ask rules, voice.js VoiceAssistant.askThenSay)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ASK = require("../../public/js/advice/ask.js");
const G = require("../../public/js/advice/gate.js");
const src = (rel) => fs.readFileSync(fileURLToPath(new URL(`../../public/js/${rel}`, import.meta.url)), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (x) => JSON.parse(JSON.stringify(x));            // objects from the vm realm

// ================================================================ replies
test("replies: Hinglish yes / no, Roman and Devanagari; no wins; unclear stays quiet", () => {
    const yes = ["haan", "Haan bol", "haa", "ji", "ji haan", "bol", "bolo bhai", "bol na", "bata", "batao", "sunao", "kya hai", "kya hua", "hmm", "theek hai", "chal bol", "ok", "okay", "yes", "yeah", "sure", "go ahead", "what", "kyun nahi", "हाँ", "हाँ बोलो", "क्या है", "बताओ", "सुनाओ"];
    const no = ["nahi", "nahin", "nai", "na", "naa", "na bhai", "mat bol", "abhi nahi", "baad mein", "rehne do", "chup", "busy hoon", "no", "nope", "not now", "later", "stop", "cancel", "haan... nahi abhi nahi", "नहीं", "ना", "अभी नहीं"];
    for (const t of yes) assert.equal(ASK.classifyReply(t), "yes", t);
    for (const t of no) assert.equal(ASK.classifyReply(t), "no", t);
    for (const t of ["hello", "traffic is heavy", "उधर देखो"]) assert.equal(ASK.classifyReply(t), "unclear", t);
    assert.equal(ASK.classifyReply(""), "silence");
    assert.equal(ASK.classifyReply(null), "silence");
    // alternatives: the best guess decides; later ones only help when it's unclear
    assert.equal(ASK.classifyReply(["hello", "haan"]), "yes");
    assert.equal(ASK.classifyReply(["nahi", "haan"]), "no");
});

test("prompts: short, about the topic when known, rotate, plain style", () => {
    const n = ASK.promptFor({ category: "network", rng: () => 0 });
    assert.equal(n, "Bhai, network ke baare mein ek baat bolun?");
    assert.equal(ASK.promptFor({ category: "network", rng: () => 0, avoid: n }), "Network ke baare mein kuch bataun bhai?");
    assert.equal(ASK.promptFor({ category: "something-new", rng: () => 0 }), "Bhai, ek baat bolun?");
    assert.equal(ASK.promptFor({ category: "fatigue", style: "plain", rng: () => 0 }), "Quick one about a break. Want it?");
    for (const cat of [...Object.keys(ASK.TOPICS.desi), "x"]) for (let i = 0; i < 4; i++) assert.ok(ASK.promptFor({ category: cat, rng: () => i / 4 }).length <= 48, cat);
});

test("runAsk: yes, no, silence, cut off, no mic", async () => {
    const run = (heard, spoke = true) => ASK.runAsk({ prompt: "Bhai, ek baat bolun?", speak: async () => spoke, listen: async () => heard, listenMs: 10 });
    assert.deepEqual(await run({ text: "haan bol" }), { answer: "yes", heard: "haan bol" });
    assert.equal((await run({ text: "nahi yaar" })).answer, "no");
    assert.equal((await run({ text: "kuch nahi", alternatives: ["kuch nahi"] })).answer, "no");
    assert.deepEqual(await run(null), { answer: "silence", heard: "" });
    assert.equal((await run({ text: "haan" }, false)).answer, "interrupted");           // the question itself was cut off
    assert.equal((await run({ error: "interrupted" })).answer, "interrupted");
    assert.equal((await run({ error: "not-allowed" })).answer, "unavailable");
    let listened = 0;
    await ASK.runAsk({ prompt: "x", speak: async () => false, listen: async () => { listened++; return null; } });
    assert.equal(listened, 0);                                                          // never listens if the question wasn't heard
});

// ================================================================ gate rules
test("gate: with ask first, tips are asked (spacing counts the question); critical and directions never are", () => {
    const g = G.createGate();
    g.setAskFirst(true);
    const tip = g.decide({ priority: 40, category: "eco" }, 1000);
    assert.equal(tip.ask, true); assert.equal(tip.speak, false); assert.equal(tip.fallbackSpeak, true); assert.equal(tip.reason, "ask");
    assert.equal(g.decide({ priority: 40, category: "eco" }, 20000).reason, "spacing");  // 45 s from the question
    assert.equal(g.decide({ priority: 90, category: "speed" }, 21000).speak, true);
    assert.equal(g.decide({ priority: 90, category: "speed" }, 21000).ask, undefined);
    const nav = g.decide({ priority: 65, category: "nav" }, 22000);
    assert.equal(nav.speak, true); assert.equal(nav.ask, undefined);
    const warn = g.decide({ priority: 70, category: "network" }, 23000);
    assert.equal(warn.speak, true); assert.equal(warn.ask, undefined);                  // warnings speak straight away outside quiet ride
    assert.equal("ask" in g.state.held, false);                                         // a question isn't "held back"
    // quiet ride (the app's rule): tips are held back, a warning is still spoken, never asked
    g.setQuiet(true);
    const aw = g.decide({ priority: 70, category: "network" }, 30000);
    assert.equal(aw.speak, true); assert.equal(aw.ask, undefined);
    assert.equal(g.decide({ priority: 40, category: "eco" }, 100000).reason, "quiet");
    // quietMutesWarnings: warnings are asked instead of only shown; a weak-GPS speed warning isn't asked
    const m = G.createGate({ quietMutesWarnings: true });
    m.setAskFirst(true); m.setQuiet(true);
    const qw = m.decide({ priority: 70, category: "network" }, 30000);
    assert.equal(qw.ask, true); assert.equal(qw.fallbackSpeak, false); assert.equal(qw.show, true);
    m.setConfidence(0.2);
    assert.equal(m.decide({ priority: 70, category: "speed" }, 31000).ask, undefined);
    // off: exactly the old behaviour
    const old = G.createGate();
    assert.deepEqual(old.decide({ priority: 40, category: "eco" }, 1000), { speak: true, show: true, level: "advice", reason: "ok" });
});

test("gate: 'nahi' snoozes that kind of tip for 20 min; 3 unanswered pause asking for 15 min", () => {
    const g = G.createGate({ adviceGapMs: 0 });
    g.setAskFirst(true);
    const T = 1_000_000;
    g.noteAnswer("fuel", "no", T);
    assert.equal(g.decide({ priority: 40, category: "fuel" }, T + 60000).reason, "snoozed");
    assert.equal(g.decide({ priority: 40, category: "eco" }, T + 60000).ask, true);      // other kinds still asked
    assert.equal(g.decide({ priority: 40, category: "fuel" }, T + 20 * 60000 + 1).ask, true);
    const U = T + 30 * 60000;
    g.noteAnswer("eco", "silence", U); g.noteAnswer("eco", "unclear", U);
    g.noteAnswer("eco", "yes", U);                                                      // an answer resets the count
    g.noteAnswer("eco", "silence", U); g.noteAnswer("eco", "silence", U);
    assert.equal(g.decide({ priority: 40, category: "eco" }, U + 1000).ask, true);
    g.noteAnswer("eco", "silence", U);
    const paused = g.decide({ priority: 40, category: "eco" }, U + 2000);
    assert.equal(paused.reason, "ask-paused"); assert.equal(paused.show, true); assert.equal(paused.speak, false);
    assert.equal(g.mode(U + 2000).key, "ask-paused");
    assert.equal(g.decide({ priority: 40, category: "eco" }, U + 15 * 60000 + 1).ask, true);
    g.noteAnswer("eco", "interrupted", U);                                              // not the rider's doing: not counted
    assert.deepEqual(g.state.asks, { asked: 7, yes: 1, no: 1, silence: 5 });
    assert.equal(G.askSummary(g.state.asks), "Asked 7 times this ride: 1 yes, 1 not now, 5 no answer.");
    g.resetRide();
    assert.equal(g.state.asks.asked, 0);
    assert.equal(g.decide({ priority: 40, category: "fuel" }, U + 16 * 60000).ask, true);
});

// ================================================================ voice.js, end to end (fake speech engine and mic)
function loadVoice({ quietMutesWarnings = false, recognition = true } = {}) {
    const spoken = [], islands = [], events = [];
    let reply = { type: "silence" };
    class Utterance { constructor(text) { this.text = text; } }
    const synth = {
        speaking: false,
        speak(u) { spoken.push(u.text); this.speaking = true; u._t = setTimeout(() => { this.speaking = false; u.onend && u.onend(); }, 15); this._u = u; },
        cancel() { if (this._u) clearTimeout(this._u._t); this.speaking = false; },
        getVoices: () => [], addEventListener() {}
    };
    class Recognition {
        constructor() { this.onresult = this.onerror = this.onend = this.onstart = null; Recognition.instances.push(this); }
        start() {
            setTimeout(() => {
                if (this.aborted) return;
                this.onstart && this.onstart({});
                const r = reply;
                if (r.type === "say") setTimeout(() => { if (this.aborted) return; const res = Object.assign([{ transcript: r.text, confidence: 0.9 }], { isFinal: true }); this.onresult({ resultIndex: 0, results: [res] }); this.onend && this.onend({}); }, r.after || 20);
                if (r.type === "error") setTimeout(() => { this.onerror({ error: r.error }); this.onend && this.onend({}); }, 10);
                // "silence": nothing happens; the answer window closes
            }, 5);
        }
        abort() { this.aborted = true; }
        stop() { this.aborted = true; }
    }
    Recognition.instances = [];
    const doc = {
        visibilityState: "visible", readyState: "complete",
        addEventListener() {}, removeEventListener() {}, getElementById: () => null,
        dispatchEvent: (e) => events.push(e)
    };
    const sandbox = {
        console, Math, Date, JSON, Promise, Object, Array, String, Number, Boolean, Map, Set, Error, RegExp, Symbol, Infinity, NaN,
        setTimeout, clearTimeout, setInterval, clearInterval,
        document: doc, navigator: { language: "en-IN" }, localStorage: { getItem: () => null, setItem() {} },
        speechSynthesis: synth, SpeechSynthesisUtterance: Utterance,
        CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } },
        islandShow: (s) => islands.push(s), islandHide() {}, showToast() {}
    };
    if (recognition) sandbox.SpeechRecognition = Recognition;
    sandbox.window = sandbox; sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    for (const f of ["advice/gate.js", "advice/ask.js", "voice.js"]) vm.runInContext(src(f), ctx, { filename: f });
    const VA = vm.runInContext("VoiceAssistant", ctx);
    sandbox.VoiceAssistant = VA;
    VA.ASK_LISTEN_MS = 120; VA.ASK_EXTEND_MS = 80; VA.ASK_ECHO_MS = 5;
    const gate = sandbox.MUAdvice.gate.createGate({ adviceGapMs: 0, quietMutesWarnings });
    gate.setAskFirst(true);
    sandbox.MUAdvice.live = {
        decide: (text, opts) => gate.decide({ text, ...opts }, Date.now()),
        noteAnswer: (cat, answer) => gate.noteAnswer(cat, answer, Date.now())
    };
    const announce = vm.runInContext("voiceAnnounce", ctx);
    return { VA, gate, spoken, islands, events, announce, setReply: (r) => { reply = r; }, Recognition };
}

test("voice: tip → question → 'haan bol' → the tip is spoken; onResult reports it", async () => {
    const v = loadVoice();
    v.setReply({ type: "say", text: "haan bol" });
    let result = null;
    const r = v.announce("Petrol pump 2 kilometre aage hai.", { priority: 45, category: "fuel", onResult: (x) => { result = x; } });
    assert.equal(r, "ask");
    assert.ok(v.VA.asking);
    await sleep(250);
    assert.equal(v.spoken.length, 2);
    assert.match(v.spoken[0], /petrol ke baare mein/i);
    assert.equal(v.spoken[1], "Petrol pump 2 kilometre aage hai.");
    assert.deepEqual(plain(result), { spoken: true, reason: "asked:yes" });
    assert.equal(v.VA.asking, null);
    assert.equal(v.gate.state.asks.yes, 1);
    assert.equal(v.events.at(-1).detail.answer, "yes");
});

test("voice: 'nahi' or silence drops the tip; critical cues never ask", async () => {
    const v = loadVoice();
    v.setReply({ type: "say", text: "nahi abhi nahi" });
    let result = null;
    v.announce("Eco tip: gear upar daal.", { priority: 40, category: "eco", onResult: (x) => { result = x; } });
    await sleep(200);
    assert.equal(v.spoken.length, 1);                                       // only the question
    assert.deepEqual(plain(result), { spoken: false, reason: "asked:no" });
    assert.ok(v.islands.some((i) => i.title === "OK, maybe later"));
    v.setReply({ type: "silence" });
    v.announce("Convoy update.", { priority: 40, category: "convoy", onResult: (x) => { result = x; } });
    await sleep(400);
    assert.equal(v.spoken.length, 2);
    assert.deepEqual(plain(result), { spoken: false, reason: "asked:silence" });
    const r = v.announce("Slow down. You are over 100.", { priority: 90, category: "speed" });
    assert.equal(r, true);
    await sleep(30);
    assert.equal(v.spoken.at(-1), "Slow down. You are over 100.");
    assert.equal(v.Recognition.instances.length, 2);                        // no mic for the critical one
});

test("voice: a direction cuts in while listening (the tip is dropped); a small tip waits for the answer", async () => {
    const v = loadVoice();
    v.setReply({ type: "say", text: "haan", after: 150 });
    let result = null;
    v.announce("Chai ki tapri aage hai.", { priority: 45, category: "rest", onResult: (x) => { result = x; } });
    await sleep(60);                                                         // question said, mic open
    assert.equal(v.VA.asking.phase, "listen");
    v.announce("Eco tip: tyre pressure check kar lena.", { priority: 30, category: "eco" });  // queues behind the question
    assert.equal(v.spoken.length, 1);
    v.announce("In 200 metres, turn left.", { priority: 65, category: "nav" });
    await sleep(120);
    assert.equal(v.spoken[1], "In 200 metres, turn left.");
    assert.deepEqual(plain(result), { spoken: false, reason: "asked:interrupted" });
    await sleep(120);
    assert.equal(v.spoken.length, 2);                                        // the eco tip was gated as advice → not spoken directly
});

test("voice: low tip queued during the answer window plays after it (via announce), never over the mic", async () => {
    const v = loadVoice();
    v.setReply({ type: "say", text: "bol", after: 60 });
    v.announce("Mausam badal raha hai.", { priority: 45, category: "weather" });
    await sleep(45);
    assert.equal(v.VA.asking.phase, "listen");
    v.VA.announce("Squad member joined.", { priority: 30 });                 // straight to the voice (not gated)
    assert.equal(v.spoken.length, 1);                                        // held while listening
    await sleep(250);
    assert.deepEqual(v.spoken.slice(1), ["Mausam badal raha hai.", "Squad member joined."]);
});

test("voice: without a mic, tips are spoken as before; a quiet-ride warning is spoken (app) or stays on screen (quietMutesWarnings)", async () => {
    const app = loadVoice({ recognition: false });
    app.gate.setQuiet(true);
    let r0 = null;
    assert.equal(app.announce("Network gaya.", { priority: 70, category: "network", onResult: (x) => { r0 = x; } }), true);
    await sleep(30);
    assert.deepEqual(app.spoken, ["Network gaya."]);
    assert.deepEqual(plain(r0), { spoken: true, reason: "spoken" });
    const v = loadVoice({ recognition: false, quietMutesWarnings: true });
    let result = null;
    assert.equal(v.announce("Eco tip.", { priority: 40, category: "eco", onResult: (x) => { result = x; } }), true);
    await sleep(30);
    assert.deepEqual(v.spoken, ["Eco tip."]);
    assert.deepEqual(plain(result), { spoken: true, reason: "spoken" });
    v.gate.setQuiet(true);
    assert.equal(v.announce("Network gaya.", { priority: 70, category: "network", onResult: (x) => { result = x; } }), false);
    assert.deepEqual(plain(result), { spoken: false, reason: "quiet" });
});

test("voice: mic blocked mid-question → that tip is spoken as before, and asking stops", async () => {
    const v = loadVoice();
    v.setReply({ type: "error", error: "not-allowed" });
    let result = null;
    v.announce("Agle mod pe dhaba hai.", { priority: 45, category: "rest", onResult: (x) => { result = x; } });
    await sleep(150);
    assert.deepEqual(plain(result), { spoken: true, reason: "asked:unavailable" });
    assert.equal(v.VA.micBlocked, true);
    assert.equal(v.VA.canAsk(), false);
});
