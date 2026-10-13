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
    return { VA, gate, spoken, islands, events, announce, setReply: (r) => { reply = r; }, Recognition,
        setMaster: (live) => { sandbox.MUMaster = live ? { live } : undefined; }, sandbox, ctx };
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
    assert.equal(v.events.filter((e) => e.type === "mu:voice-ask").at(-1).detail.answer, "yes");
    // what the Master AI's face follows (js/ai/): the question, the mic for the answer, then the tip
    const flow = v.events.filter((e) => e.type === "mu:voice-state" || e.type === "mu:mic-state")
        .map((e) => (e.type === "mu:mic-state" ? `mic:${e.detail.on ? e.detail.mode : "off"}` : `${e.detail.phase}${e.detail.priority ? `:${e.detail.priority}` : ""}`));
    assert.deepEqual(flow.filter((x, i) => x !== flow[i - 1]), ["start:45", "end", "mic:ask", "mic:off", "start:45", "end"]);
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

// ================================================================ push-to-talk: what isn't a command goes to the Master AI
test("push-to-talk: 'hello' (one word, no command) goes to the Master as chat, not to 'didn't catch a command'", async () => {
    const v = loadVoice();
    const asked = [];
    v.VA.reply = (t) => { v.spoken.push(`reply:${t}`); return true; };
    const live = { persona: { style: "desi" }, ask: async (q, o) => { asked.push({ q, chat: Boolean(o && o.chat) }); return { ok: true, text: "Namaste bhai! Bol, kya help karun?", display: { title: "Chat", sub: "Namaste bhai!" } }; } };
    v.VA.masterSay = (ans) => v.spoken.push(`say:${ans.text}`);
    v.setMaster(live);
    assert.equal(v.VA.handleAlternatives([{ transcript: "Hello", confidence: 0.9 }], "ptt"), true);
    await sleep(0);
    assert.deepEqual(asked, [{ q: "Hello", chat: true }]);
    assert.deepEqual(v.spoken, ["say:Namaste bhai! Bol, kya help karun?"], "no 'Ek second, dhoondh ke…' before a greeting, and no fallback");
    // a real question (more than 3 words) is a lookup, chat off; answered quickly, it has no lead-in
    v.spoken.length = 0;
    v.VA.handleAlternatives([{ transcript: "Araku valley mein kal baarish hogi kya", confidence: 0.9 }], "ptt");
    await sleep(0);
    assert.deepEqual(asked.at(-1), { q: "Araku valley mein kal baarish hogi kya", chat: false });
    assert.deepEqual(v.spoken, ["say:Namaste bhai! Bol, kya help karun?"]);
    // nothing usable heard: an honest line, the Master isn't bothered
    v.spoken.length = 0;
    v.VA.handleAlternatives([{ transcript: " ", confidence: 0.9 }], "ptt");
    assert.deepEqual(v.spoken, ["reply:Sorry, I didn't hear anything. Tap the mic and try again."]);
    assert.equal(asked.length, 2);
    // hands-free never sends conversation to the Master (only commands)
    v.VA.handleAlternatives([{ transcript: "hello", confidence: 0.9 }], "handsfree");
    assert.equal(asked.length, 2);
    // without the Master running, the old fallback stays
    v.setMaster(null);
    v.spoken.length = 0;
    v.VA.handleAlternatives([{ transcript: "hello", confidence: 0.9 }], "ptt");
    assert.deepEqual(v.spoken, ["reply:Sorry, I didn't catch a command. Say help to hear what I can do."]);
});

// ================================================================ voice actions: the Master's "action" runs through the app's own commands
test("Master actions map onto the app's voice commands; anything unknown or malformed does nothing", () => {
    const v = loadVoice();
    const map = vm.runInContext("masterActionCommand", v.ctx);
    const m = (a) => plain(map(a));
    assert.deepEqual(m({ name: "navigate_to", place: "Araku Valley" }), { name: "navigateTo", arg: "Araku Valley" });
    assert.deepEqual(m({ name: "send_sos" }), { name: "sos", arg: null });
    assert.deepEqual(m({ name: "share_location" }), { name: "shareLocation", arg: null });
    assert.deepEqual(m({ name: "find_nearby", category: "mechanic" }), { name: "masterNearest", arg: "mechanic" });
    assert.deepEqual(m({ name: "quiet_ride", on: false }), { name: "quietRide", arg: "off" });
    assert.deepEqual(m({ name: "music", control: "next" }), { name: "masterMusic", arg: "next" });
    for (const n of ["start_navigation", "stop_navigation", "where_am_i", "how_far", "squad_status"]) assert.ok(map({ name: n }), n);
    for (const bad of [null, "navigate_to", {}, { name: "rm -rf" }, { name: "navigate_to" }, { name: "navigate_to", place: "x" }, { name: "find_nearby", category: "casino" }, { name: "quiet_ride", on: "yes" }, { name: "music", control: "louder" }]) assert.equal(map(bad), null, JSON.stringify(bad));
});

test("'share my location' / 'meri location bhej do' is a command; 'location sharing off' isn't", () => {
    const v = loadVoice();
    const match = vm.runInContext("matchVoiceCommand", v.ctx);
    const name = (t) => { const c = match(t, { mode: "ptt", pendingSos: false }); return c && c.name; };
    for (const t of ["share my location", "send my location to the group", "meri location bhej do", "gang ko location bhejo", "location share kar"]) assert.equal(name(t), "shareLocation", t);
    assert.notEqual(name("location sharing off"), "shareLocation");
    assert.equal(name("send sos"), "sos");
});

/** voice.js with a fake socket, GPS, privacy mode and Master; returns what it sent and said. */
function actionWorld({ mode = "exact", online = true, action = null, spoken = "Theek hai bhai." } = {}) {
    const v = loadVoice();
    const sent = [], queued = [], said = [], sos = [];
    v.sandbox.myCoords = { lat: 18.812345678, lng: 82.713456789 };
    v.sandbox.cityName = "Koraput";
    v.sandbox.currentUser = { name: "Satyam" };
    v.sandbox.socket = { emit: (ev, p) => sent.push({ ev, p }) };
    v.sandbox.offlineMessageQueue = queued;
    v.sandbox.PrivacyControls = { state: { sharingMode: mode } };
    v.sandbox.navigator.onLine = online;
    v.sandbox.sendSOS = () => { sos.push(1); return true; };
    vm.runInContext("var sendSOS = globalThis.sendSOS; var myCoords = globalThis.myCoords; var cityName = globalThis.cityName; var currentUser = globalThis.currentUser; var socket = globalThis.socket; var offlineMessageQueue = globalThis.offlineMessageQueue; var PrivacyControls = globalThis.PrivacyControls;", v.ctx);
    v.VA.reply = (t) => { said.push(t); return true; };
    v.VA.masterSay = (ans) => said.push(`say:${ans.text}`);
    const executed = [];
    const realExecute = v.VA.execute.bind(v.VA);
    v.VA.execute = (cmd) => { executed.push(plain(cmd)); return realExecute(cmd); };
    v.setMaster({ persona: { style: "desi" }, ask: async () => ({ ok: true, text: spoken, display: { title: "x", sub: "y" }, result: { action } }) });
    return { v, sent, queued, said, sos, executed };
}

test("voice action: 'SOS bhej' via the Master never sends an SOS by itself; it asks for 'confirm SOS'", async () => {
    const w = actionWorld({ action: { name: "send_sos" }, spoken: "Bhai, confirm SOS bol de, gang ko alert bhejta hoon." });
    await w.v.VA.masterAsk("bhai kuch gadbad hai help chahiye", {});
    assert.deepEqual(w.executed, [{ name: "sos", arg: null }]);
    assert.equal(w.sos.length, 0, "nothing sent yet");
    assert.equal(w.v.VA.pendingConfirm.type, "sos");
    assert.match(w.said.join(" | "), /say:Bhai, confirm SOS[\s\S]*Say confirm S O S within 10 seconds/);
    w.v.VA.confirmSos();                                      // only the rider's confirmation sends it
    assert.equal(w.sos.length, 1);
});

test("voice action: share location posts to the group chat, rounded in approximate mode, queued offline, refused when sharing is off", async () => {
    const exact = actionWorld({ action: { name: "share_location" }, spoken: "Gang ko location bhej raha hoon." });
    await exact.v.VA.masterAsk("gang ko bata main kahan hoon", {});
    assert.equal(exact.sent.length, 1);
    assert.equal(exact.sent[0].ev, "chatMessage");
    assert.equal(exact.sent[0].p.type, "text");
    assert.match(exact.sent[0].p.data, /^📍 Satyam is near Koraput: https:\/\/www\.google\.com\/maps\?q=18\.81235,82\.71346$/);
    assert.match(exact.said.at(-1), /Gang ko location bhej di/);
    const unnamed = actionWorld({ action: { name: "share_location" } });
    vm.runInContext("cityName = 'Local Area';", unnamed.v.ctx);
    await unnamed.v.VA.masterAsk("location bhej", {});
    assert.match(unnamed.sent[0].p.data, /^📍 Satyam is here: https/, "core.js's placeholder never goes out as a town");
    const approx = actionWorld({ mode: "approx", action: { name: "share_location" } });
    await approx.v.VA.masterAsk("location bhej", {});
    assert.match(approx.sent[0].p.data, /\(approx\.\): https:\/\/www\.google\.com\/maps\?q=18\.81,82\.71$/);
    const off = actionWorld({ mode: "off", action: { name: "share_location" } });
    await off.v.VA.masterAsk("location bhej", {});
    assert.equal(off.sent.length, 0);
    assert.match(off.said.at(-1), /sharing band hai/);
    const offline = actionWorld({ online: false, action: { name: "share_location" } });
    await offline.v.VA.masterAsk("location bhej", {});
    assert.equal(offline.sent.length, 0);
    assert.equal(offline.queued.length, 1);
    assert.match(offline.said.at(-1), /queue mein hai/);
});

test("voice action: an answer without an action only speaks; a bad action is ignored", async () => {
    const none = actionWorld({ action: null, spoken: "Haan bhai, mast weather hai." });
    await none.v.VA.masterAsk("mausam kaisa hai", {});
    assert.deepEqual(none.executed, []);
    assert.deepEqual(none.said, ["say:Haan bhai, mast weather hai."], "a quick answer has no 'Ek second' lead-in");
    const bad = actionWorld({ action: { name: "delete_everything" } });
    await bad.v.VA.masterAsk("sab delete kar de", {});
    assert.deepEqual(bad.executed, []);
});

test("voice action: an action runs at once, with no 'Ek second' lead-in; only a slow lookup gets one", async () => {
    const nav = actionWorld({ action: { name: "navigate_to", place: "Araku Valley" }, spoken: "Chal bhai, Araku ka rasta nikalta hoon." });
    nav.v.VA.navigateTo = () => {};
    await nav.v.VA.masterAsk("Araku le chal", {});
    assert.deepEqual(nav.said, ["say:Chal bhai, Araku ka rasta nikalta hoon."]);
    assert.deepEqual(nav.executed, [{ name: "navigateTo", arg: "Araku Valley" }]);
    await sleep(40);
    assert.deepEqual(nav.said, ["say:Chal bhai, Araku ka rasta nikalta hoon."], "the lead-in timer was cancelled, nothing late");
    // an engine falling back takes longer: the rider hears that it's still working, then the answer
    const slow = actionWorld({ spoken: "Haan bhai, kal baarish hai." });
    slow.v.VA.MASTER_FILLER_MS = 10;
    slow.v.setMaster({ persona: { style: "desi" }, ask: async () => { await sleep(40); return { ok: true, text: "Haan bhai, kal baarish hai.", display: { title: "x", sub: "y" }, result: { action: null } }; } });
    await slow.v.VA.masterAsk("Araku mein kal baarish hogi kya", {});
    assert.deepEqual(slow.said, ["Ek second, dhoondh raha hoon.", "say:Haan bhai, kal baarish hai."]);
    // a failed lookup cancels it too
    const fail = actionWorld();
    fail.v.VA.MASTER_FILLER_MS = 10;
    fail.v.setMaster({ persona: { style: "desi" }, ask: async () => { throw new Error("offline"); } });
    await fail.v.VA.masterAsk("kuch bhi", {});
    await sleep(30);
    assert.deepEqual(fail.said, ["Sorry, I couldn't look that up right now."]);
});

test("voice action: when the app's command is the answer (nearest place, squad, where am I, how far), only the app speaks", async () => {
    const w = actionWorld({ action: { name: "squad_status" }, spoken: "Gang kahan hai, yeh live check nahi kar sakta bhai." });
    w.v.sandbox.ConvoyIntelligence = { summary: () => "Rahul 2 km behind, Asha 500 m ahead." };
    vm.runInContext("var ConvoyIntelligence = globalThis.ConvoyIntelligence;", w.v.ctx);
    await w.v.VA.masterAsk("sab log kahan hain", { chat: true });
    assert.deepEqual(w.executed, [{ name: "convoy", arg: null }]);
    assert.deepEqual(w.said, ["Rahul 2 km behind, Asha 500 m ahead."], "the model's 'can't check' line is never spoken over real data");
    // a doing-action keeps the buddy's acknowledgement
    const nav = actionWorld({ action: { name: "stop_navigation" }, spoken: "Le bhai, band kar diya." });
    vm.runInContext("navState.active = false; navState.ready = false;", nav.v.ctx);
    await nav.v.VA.masterAsk("navigation band kar", { chat: true });
    assert.equal(nav.said[0], "say:Le bhai, band kar diya.");
});


// ================================================================ conversation: the mic reopens after the Master asks something
/** voice.js with a scripted Master: answers[i] for the i-th question; records the questions. */
function convoWorld(answers, { followUpOn = true } = {}) {
    const v = loadVoice();
    vm.runInContext("var myCoords = null;", v.ctx);                  // core.js's GPS fix: none here (masterSay reads it)
    v.VA.FOLLOWUP_ECHO_MS = 5;
    v.VA.followUpOn = followUpOn;
    const asked = [];
    v.setMaster({ persona: { style: "desi" }, ask: async (q, o) => {
        asked.push({ q, chat: Boolean(o && o.chat) });
        const a = answers[asked.length - 1] || { text: "Theek hai bhai.", expectsReply: false };
        return { ok: true, text: a.text, display: { title: "Chat", sub: a.text }, result: { expectsReply: a.expectsReply, action: a.action || null } };
    } });
    return { v, asked, listens: () => v.Recognition.instances.length };
}

test("conversation: the Master asks back → after its line is spoken the mic opens by itself; the answer goes to the Master; a reply without a question ends it", async () => {
    const w = convoWorld([
        { text: "Arre bhai! Aaj kahan ki ride hai?", expectsReply: true },
        { text: "Araku mast hai! Ghat pe dhyan se chalana.", expectsReply: false }
    ]);
    w.v.setReply({ type: "say", text: "Araku ja raha hoon" });
    await w.v.VA.masterAsk("Hello", { chat: true });
    await sleep(200);
    assert.deepEqual(w.asked.map((a) => a.q), ["Hello", "Araku ja raha hoon"], "no tap: the reply reached the Master");
    assert.ok(w.v.islands.some((i) => i.title === "Listening for your reply…"));
    assert.deepEqual(w.v.spoken, ["Arre bhai! Aaj kahan ki ride hai?", "Araku mast hai! Ghat pe dhyan se chalana."]);
    assert.equal(w.listens(), 1, "the second line asked nothing: the mic stays closed");
    assert.equal(w.v.VA.convoTurns, 0);
});

test("conversation: a line ending in '?' counts even without the model's flag; silence ends it; at most 6 turns in a row", async () => {
    const q = convoWorld([{ text: "Chai break le lein kya?", expectsReply: false }]);
    q.v.setReply({ type: "silence" });
    await q.v.VA.masterAsk("thak gaya yaar", {});
    await sleep(120);
    assert.equal(q.listens(), 1, "opened once for the answer");
    assert.equal(q.asked.length, 1, "silence: nothing more is asked");
    // the turn limit: a 7th question in a row doesn't reopen the mic
    const many = convoWorld(Array.from({ length: 10 }, (_, i) => ({ text: `Sawaal ${i}?`, expectsReply: true })));
    many.v.setReply({ type: "say", text: "haan" });
    await many.v.VA.masterAsk("hello", { chat: true });
    await sleep(900);
    assert.equal(many.asked.length, 7, `1 tap + 6 automatic turns, then it waits for a tap (${many.asked.length})`);
    many.v.VA.togglePushToTalk();                                   // a tap starts a fresh count
    assert.equal(many.v.VA.convoTurns, 0);
});

test("conversation: the mic doesn't reopen by itself after an action, when switched off, when muted, or in a call", async () => {
    const act = convoWorld([{ text: "Chal bhai, Araku ka rasta nikalta hoon. Theek hai?", expectsReply: true, action: { name: "stop_navigation" } }]);
    vm.runInContext("navState.active = false; navState.ready = false;", act.v.ctx);
    await act.v.VA.masterAsk("navigation band kar", {});
    await sleep(120);
    assert.equal(act.listens(), 0, "an action's own command has the floor");
    const off = convoWorld([{ text: "Kahan ja rahe ho?", expectsReply: true }], { followUpOn: false });
    await off.v.VA.masterAsk("hello", { chat: true });
    await sleep(120);
    assert.equal(off.listens(), 0, "setting off");
    const muted = convoWorld([{ text: "Kahan ja rahe ho?", expectsReply: true }]);
    muted.v.VA.mutedUntil = Date.now() + 60000;
    muted.v.VA.wantsFollowUp({ ok: true, text: "x?" });
    assert.equal(muted.v.VA.canFollowUp(), false, "muted");
    const call = convoWorld([]);
    vm.runInContext("var peerConnection = {};", call.v.ctx);
    assert.equal(call.v.VA.canFollowUp(), false, "in a call");
});
