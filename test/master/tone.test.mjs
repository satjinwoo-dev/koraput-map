// Voice tones (public/js/master/phrases-tone.js + persona tone): Family (default), Rowdy and 18+ Rowdy, for the RoadPulse lines.
// The tone may change the words, never the facts or the safety message.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../../public/js/master/persona.js");
const PH = require("../../public/js/master/phrases-desi.js");
const TONE = require("../../public/js/master/phrases-tone.js");
const H = require("../../public/js/voice/hinglish.js");
const RS = require("../../public/js/master/roadsense/roadsense.js");
const TR = require("../../public/js/master/roadsense/truth.js");
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

const persona = (o = {}) => TONE.install(PH.install(P.createPersona({ rng: () => 0, ...o })));
const say = (p, kind, data, severity = "advice") => p.phrase({ kind, key: kind, severity, data });
const SAMPLE = {
    distanceM: 80, riders: 3, evidence: "2 riders ne bataya, kal", evidenceTu: "tu aur 2 aur riders ne feel kiya, aakhri baar kal", where: "aage ke raaste",
    kinds: "2 gaddha ya breaker", verified: 2, candidates: 1, hazard: "gaddha ya breaker", confidence: "bharosa zyada", clearM: 3200, clearRiders: 3,
    clearAgo: "2 ghante pehle", riddenAgo: "kal", officialKind: "sadak ka kaam", officialRefs: "Example list", officialM: 2400,
    predictedKind: "paani bhara hua", predictedM: 1800, predictedBy: "IMD nowcast + Bhuvan DEM", detail: "3 riders · motion sensor · yesterday · 82%",
    screen: { where: "the road ahead", evidence: "reported by 2 riders yesterday" }
};
const lines = (pack) => Object.entries(pack).flatMap(([kind, bySev]) => Object.entries(bySev).flatMap(([sev, list]) => list.map((l) => ({ kind, sev, say: l.say, when: l.when }))));

test("Family is the default; Rowdy is opt-in; every other kind and English keep their lines", () => {
    const fam = persona({ name: "Asha" });
    assert.equal(fam.tone, "family");
    assert.equal(say(fam, "road.bump-reported", SAMPLE, "warning").text, "80 metre aage gaddhe ki report hai, 2 riders ne bataya, kal. Kripya dhyaan se chalayein.");
    const rowdy = persona({ name: "Asha", tone: "rowdy" });
    assert.equal(say(rowdy, "road.bump-reported", SAMPLE, "warning").text, "Abe aage 80 metre pe gaddha ya breaker hai, 3 riders ne bataya. Andha hai kya? Dheere kar le warna udd jayega!");
    fam.setTone("rowdy");
    assert.equal(fam.tone, "rowdy");
    assert.match(say(fam, "road.truth-unknown", SAMPLE).text, /^Asha, aage ka apne ko pata nahi hai, apna khud dekh ke chala le\.$/);
    fam.setTone("anything-else");
    assert.equal(fam.tone, "family", "unknown values fall back to Family");
    // a kind with no tone lines: the same desi line in both tones
    const other = (p) => say(p, "network.lost", {}, "warning").text;
    assert.equal(other(persona()), other(persona({ tone: "rowdy" })));
    // English has no tones
    const en = (t) => say(persona({ style: "plain", tone: t }), "road.bump-reported", SAMPLE, "warning").text;
    assert.equal(en("rowdy"), en("family"));
    // the screen is the same English in both tones
    assert.deepEqual(say(persona({ tone: "rowdy" }), "road.bump-reported", SAMPLE, "warning").display, say(persona(), "road.bump-reported", SAMPLE, "warning").display);
    // the unnamed rider is "bhai" in Rowdy; Family never uses a name
    assert.match(say(persona({ tone: "rowdy" }), "road.truth-unknown", SAMPLE).text, /^Bhai, aage ka/);
    assert.ok(lines(TONE.family).every((l) => !l.say.includes("{{name}}")));
});

test("Family and Rowdy cover the same RoadPulse kinds, 18+ a part of them; every line renders", () => {
    assert.deepEqual(Object.keys(TONE.rowdy).sort(), Object.keys(TONE.family).sort());
    for (const k of Object.keys(TONE.family)) assert.ok(PH.desi[k], `${k} also has a desi line to fall back on`);
    // 18+ falls back to Rowdy then desi; only the reroute line is its own (navigation keeps English otherwise)
    for (const k of Object.keys(TONE.rowdy18)) if (k !== "nav.reroute") assert.ok(PH.desi[k], `${k} has a desi line to fall back on`);
    for (const t of TONE.TONES) {
        const p = persona({ tone: t });
        for (const l of lines(TONE[t])) assert.ok(p.render(l.say, { name: "bhai", ...SAMPLE }, "desi"), `${t} ${l.kind}: "${l.say}" has an unknown placeholder`);
    }
});

test("the tone changes the words, never the facts: the same numbers and sources in both", () => {
    const facts = (say) => (say.match(/\{\{\s*([a-zA-Z]+)/g) || []).map((x) => x.replace(/\{\{\s*/, "")).filter((v) => v !== "name").map((v) => (v === "evidenceTu" ? "evidence" : v));
    // the facts each kind must carry, whatever the tone
    const MUST = {
        "road.bump-ahead": ["distanceM"], "road.bump-reported": ["distanceM"], "road.truth": ["verified", "kinds", "distanceM", "hazard", "evidence"],
        "road.truth-unconfirmed": ["candidates", "distanceM", "hazard", "evidence"], "road.truth-clear": ["clearRiders", "clearAgo"],
        "road.truth-partly-clear": ["clearM", "clearRiders"], "road.truth-ridden": ["riddenAgo"], "road.truth-also-clear": ["clearM", "clearRiders"],
        "road.truth-official": ["officialM", "officialKind", "officialRefs"], "road.truth-predicted": ["predictedM", "predictedKind", "predictedBy"],
        "road.route-truth": ["verified", "kinds"], "road.hazard": ["distanceM"]
    };
    for (const t of TONE.TONES) for (const l of lines(TONE[t])) for (const f of MUST[l.kind] || []) assert.ok(facts(l.say).includes(f), `${t} ${l.kind}: says ${f}`);
    // a bump reported by other riders always says by how many (Family through the evidence clause, Rowdy as a count)
    for (const t of ["rowdy", "rowdy18"]) assert.ok(lines(TONE[t]).filter((l) => l.kind === "road.bump-reported").every((l) => l.say.includes("{{riders}}")));
    // a prediction is never said as fact, an unknown road never as fine
    for (const t of TONE.TONES) {
        for (const l of lines(TONE[t]).filter((x) => x.kind === "road.truth-predicted")) assert.match(l.say, /kisi ne dekha nahi/i);
        for (const l of lines(TONE[t]).filter((x) => x.kind === "road.truth-unknown")) assert.match(l.say, /pata nahi|kuch nahi dikh/);
    }
});

test("safety in every tone: warnings say slow down, nothing says speed up, roasting is about riding, never identity", () => {
    const SPEED_UP = /kheench|full speed|bhaga|race|tez chala|udaa de|throttle|maar de/i;
    // words that would abuse someone's family, caste, religion or gender: none, in any tone
    const ABUSE = /\b(maa|behen|bhen|chut|chod|madar|bc|mc|randi|haram|kutt?e ki|suar|chamar|bhangi|chhakka|hijra|mulla|katua)\b|bhenchod|behenchod|madarchod|maderchod|bhosd|bsdk|teri maa|tere baap|chutiy/i;
    for (const t of TONE.TONES) for (const l of lines(TONE[t])) {
        assert.doesNotMatch(l.say, SPEED_UP, `${t} ${l.kind}: never "speed up"`);
        assert.doesNotMatch(l.say, ABUSE, `${t} ${l.kind}: no abuse`);
        if (l.sev === "warning" || l.kind === "road.rough-stretch" || l.kind === "nav.reroute") assert.match(l.say, /dheere|speed kam|dhyaan se|aaram se/i, `${t} ${l.kind}: says slow down`);
    }
    // "clear" only means no bumps were felt: both tones keep the limit and what a phone can't feel
    const clearRowdy = lines(TONE.rowdy).find((l) => l.kind === "road.truth-clear").say;
    assert.match(clearRowdy, /meter limit mein rakh/);
    assert.match(clearRowdy, /paani ya bajri/);
    assert.match(lines(TONE.family).find((l) => l.kind === "road.truth-clear").say, /paani ya bajri/);
    const clear18 = lines(TONE.rowdy18).find((l) => l.kind === "road.truth-clear").say;
    assert.match(clear18, /limit mein chalaiyo/);
    assert.match(clear18, /paani ya bajri/);
});

test("18+ Rowdy: the reels' lines, picked by what was seen, only when chosen; other kinds keep Rowdy", () => {
    const adult = persona({ tone: "rowdy18" });
    assert.equal(adult.tone, "rowdy18");
    const hz = (cls) => say(adult, "road.hazard", { hazard: "x", cls, distanceM: 120 }, "warning").text;
    assert.equal(hz("pothole"), "Abe chomu, 120 metre aage bada gaddha hai! Dheere kar le warna gaand ke beech ek aur line ban jayegi!");
    assert.equal(hz("speed_breaker_unmarked"), "Abe gaandu, 120 metre aage breaker hai. Dheere kar le warna hawa mein udd jayega!");
    assert.equal(hz("waterlogging"), "Arey bhai, 120 metre aage paani bhara hai, pata nahi kisne hag diya hai andar. Dheere nikal le.");
    // something the reels have no line for: the desi road.hazard line, not a wrong gaali
    assert.match(hz("animal"), /120 metre/);
    assert.doesNotMatch(hz("animal"), /gaddha|breaker|paani/);
    // a RoadSense bump by its kind; a plain "bump" (the sensor can't tell which) keeps the Rowdy line
    assert.equal(say(adult, "road.bump-reported", { ...SAMPLE, kind: "speed_breaker" }, "warning").text, "Abe gaandu, 80 metre aage breaker hai, 3 riders ne bataya. Dheere kar le warna hawa mein udd jayega!");
    assert.match(say(adult, "road.bump-reported", { ...SAMPLE, kind: "pothole" }, "warning").text, /^Abe chomu, 80 metre aage bada gaddha hai, 3 riders ne bataya!/);
    assert.equal(say(adult, "road.bump-reported", { ...SAMPLE, kind: "bump" }, "warning").text, say(persona({ tone: "rowdy" }), "road.bump-reported", { ...SAMPLE, kind: "bump" }, "warning").text);
    assert.match(say(adult, "road.rough-stretch", SAMPLE).text, /^Bhai aage sadak ki band baji padi hai\. Aaram se nikal le/);
    assert.equal(say(adult, "road.truth-clear", SAMPLE).text, "Bhai zindagi toh tu jee raha hai, baaki toh bas marwa rahe hain. Rasta clear hai, 3 riders bina jhatke nikle, aakhri baar 2 ghante pehle. Par limit mein chalaiyo, paani ya bajri mujhe nahi dikhti.");
    assert.equal(say(adult, "road.truth-unknown", SAMPLE).text, "Arey bhai, aage ka mujhe jhaant kuch nahi dikh raha yaar. Apna khud dekh ke chala le.");
    // a kind 18+ doesn't cover: the Rowdy line
    assert.equal(say(adult, "road.route-truth", SAMPLE).text, say(persona({ tone: "rowdy" }), "road.route-truth", SAMPLE).text);
    // the screen stays English: no gaali is ever written
    assert.deepEqual(say(adult, "road.hazard", { hazard: "gaddha", cls: "pothole", distanceM: 120, screen: { hazard: "Pothole" } }, "warning").display, say(persona(), "road.hazard", { hazard: "gaddha", cls: "pothole", distanceM: 120, screen: { hazard: "Pothole" } }, "warning").display);
    // navigation's reroute: only 18+ has its own line; every other tone, and English, keep the English cue
    assert.match(adult.toneLine("nav.reroute"), /^Haan, mujhe pata tha tu aisi hi koi bakchodi karne wala hai\. .*Dheere chal, naya rasta nikal raha hoon\.$/);
    for (const p of [persona(), persona({ tone: "rowdy" }), persona({ style: "plain", tone: "rowdy18" })]) assert.equal(p.toneLine("nav.reroute"), null);
    // no gaali in Family or Rowdy: the reels' words are 18+ only
    const GAALI = /\b(gaand|gaandu|chomu|marwa\w*|hag|jhaant|bakchodi)\b/i;
    for (const t of ["family", "rowdy"]) for (const l of lines(TONE[t])) assert.doesNotMatch(l.say, GAALI, `${t} ${l.kind}`);
});

test("the evidence in 'tu' for Rowdy: the rider is addressed as tu, other riders' words unchanged", () => {
    const base = { status: "verified", confidence: 0.9, sources: { imu: 2 }, ageS: 2 * 3600 };
    assert.equal(TR.evidence({ ...base, riders: 1, felt: true }).tu, "tune khud feel kiya tha, 2 ghante pehle");
    assert.equal(TR.evidence({ ...base, riders: 3, felt: true }).tu, "tu aur 2 aur riders ne feel kiya, aakhri baar 2 ghante pehle");
    assert.equal(TR.evidence({ ...base, riders: 2, felt: false }).tu, TR.evidence({ ...base, riders: 2, felt: false }).desi);
    // end to end: a Rowdy Truth Card answer from the log
    const log = RS.createLog();
    const at = { lat: 18.81, lng: 82.71 + 1200 / (111320 * Math.cos(18.81 * Math.PI / 180)) };
    const T0 = Date.UTC(2026, 9, 17, 6);
    log.addAll([{ type: "bump", t: T0, ...at, source: "imu", rider: "self", present: true, conf: 0.7 }, { type: "bump", t: T0 + 60000, ...at, source: "imu", rider: "r1aaaaaaaaaaaaaa", present: true, conf: 0.7 }]);
    const card = TR.buildTruth({ log, path: [[18.81, 82.71], [18.81, 82.73]], now: T0 + 3600000 });
    const text = say(persona({ tone: "rowdy" }), TR.phraseKind(card), TR.phraseData(card, "route")).text;
    assert.match(text, /^Sun bhai, is raaste pe 1 pakki report hai: 1 gaddha ya breaker\. Pehli 1\.2 km aage, gaddha ya breaker: tu aur 1 aur riders ne feel kiya, aakhri baar 59 minute pehle\. Aankhein khuli rakh\.$/);
});

test("every Hinglish word of every tone is in the pronunciation lexicon", () => {
    const unknown = new Set();
    for (const t of TONE.TONES) for (const l of lines(TONE[t])) {
        const r = H.prepare(l.say.replace(/\{\{name\}\}/g, "Rahul").replace(/\{\{[^}]+\}\}/g, "800 metre"));
        if (r.lang !== "hi-IN") continue;
        for (const w of r.unknown) if (w !== "Rahul") unknown.add(w);
    }
    assert.deepEqual([...unknown], [], `words with no Devanagari spelling: ${[...unknown].join(", ")}`);
});

test("wiring: loaded with the phrase packs, Settings switch off by default, saved in the Master's config, offline, type-checked", () => {
    const html = read("public/index.html");
    const pos = (s) => html.indexOf(`<script src="${s}`);
    assert.ok(pos("js/master/phrases-tone.js") > pos("js/master/phrases-radar.js") && pos("js/master/phrases-tone.js") < pos("js/master/master-app.js"));
    const sw = html.match(/<input[^>]*id="voice-tone-toggle"[^>]*>/);
    assert.ok(sw, "the switch exists");
    assert.doesNotMatch(sw[0], /checked/, "off by default: Family");
    assert.ok(html.indexOf('id="voice-tone-toggle"') > html.indexOf('id="roadsense-section"'), "in the Community road reports section");
    const app = read("public/js/master/master-app.js");
    assert.match(app, /tone: \/\*\* @type \{"family"\|"rowdy"\|"rowdy18"\} \*\/ \("family"\)/);
    assert.match(app, /createPersona\(\{ style: config\.style, tone: config\.tone, name: config\.name \}\)/);
    assert.match(app, /setTone\(t\) \{ persona\.setTone\(t\); config\.tone = persona\.tone; save\(\);/);
    const ui = read("public/js/master/roadsense/roadsense-ui.js");
    assert.match(ui, /live\.setTone\(tone\.checked \? \(adult && adult\.checked \? "rowdy18" : "rowdy"\) : "family"\)/);
    // 18+: its own switch, off by default, on only after the age confirm
    const sw18 = html.match(/<input[^>]*id="voice-18-toggle"[^>]*>/);
    assert.ok(sw18 && !/checked/.test(sw18[0]), "18+ switch exists, off by default");
    assert.ok(html.indexOf('id="voice-18-toggle"') > html.indexOf('id="voice-tone-toggle"'));
    assert.match(ui, /if \(adult\.checked && !W\.confirm\("18\+ Rowdy[^"]*Are you 18\+\?"\)\) \{ adult\.checked = false; return; \}/);
    assert.match(read("public/js/navigation.js"), /speak\(toneSay \|\| "Route updated\."/);
    assert.ok(read("public/sw.js").includes('"/js/master/phrases-tone.js"'));
    assert.ok(JSON.parse(read("tsconfig.master.json")).files.includes("public/js/master/phrases-tone.js"));
});
