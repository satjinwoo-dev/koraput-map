// Step 10: the admin curator — drafts are real data files, checked by the real contract, previewed
// through the real physics; the API client and the offline mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildArtifacts, makeRuntimeBundle } from "../../scripts/bikedb/catalog-build.mjs";
import { loadCatalog } from "../../scripts/bikedb/load-catalog.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const C = require("../../public/js/bikedb/bundle-contract.js");
const Physics = require("../../public/js/physics/index.js");
const D = require("../../public/js/curator/draft.js");
const A = require("../../public/js/curator/api.js");

const cat = loadCatalog();
const ref = cat.ref;
const art = buildArtifacts(cat);
const runtimeById = new Map(art.bundles.map((b) => [b.id, JSON.parse(b.bytes)]));
const readSrc = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, "data/bikes/variants", `${id}.json`), "utf8"));

test("the form is the contract: every non-prior field for the powertrain, nothing else", () => {
    for (const pt of ["ice_manual", "ice_cvt", "ev"]) {
        const want = C.FIELDS.filter((f) => !f.path.startsWith("priors.") && f.allow.includes(pt) && f.path !== "transmission.kind").map((f) => f.path).sort();
        const got = D.formSections(C, pt).flatMap((s) => s.fields.filter((f) => !f.fixed).map((f) => f.path)).sort();
        assert.deepEqual(got, want, pt);
    }
    const eng = D.formSections(C, "ice_manual").find((s) => s.key === "engine");
    const disp = eng.fields.find((f) => f.path === "engine.displacement");
    assert.equal(disp.unitLabel, "cc"); assert.equal(disp.required, true); assert.deepEqual(disp.range, [40, 2500]);
    assert.ok(!D.formSections(C, "ev").some((s) => s.key === "engine" || s.key === "fuel" && s.fields.length));
});

test("identity from a rider's words, file ids and source ids", () => {
    assert.deepEqual(D.guessIdentity("Bajaj Avenger 220 Street, 2023", ["Bajaj", "TVS"]), { make: "Bajaj", model: "Avenger 220 Street", variant: "", yearFrom: 2023 });
    assert.deepEqual(D.guessIdentity("royal enfield shotgun 650, matte", ["Royal Enfield"]), { make: "Royal Enfield", model: "shotgun 650", variant: "matte", yearFrom: null });
    assert.equal(D.guessIdentity("Yezdi Roadster", []).make, "Yezdi");
    assert.equal(D.slugId({ make: "Honda", model: "H'ness CB350", variant: "DLX Pro", market: "IN" }), "honda-h-ness-cb350-dlx-pro-in");
    assert.equal(D.slugId({ make: "Hero", model: "Splendor+", variant: "", market: "IN" }), "hero-splendor-plus-in");
    assert.equal(D.sourceId({ publisher: "Bajaj Auto", title: "Avenger page" }, ["bajaj-auto-avenger-page"]), "bajaj-auto-avenger-page-2");
});

test("a new draft is a skeleton the validator explains; a real file round-trips through setValue and passes", () => {
    const d = D.newDraft(C, { description: "TVS Ronin 225, 2024", classKey: "ice_manual.naked" }, ["TVS"], "2026-10-04");
    assert.equal(d.id, "tvs-ronin-225-in");
    assert.equal(d.transmission.kind.v, "manual");
    const r = C.validateBundle(d, ref);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.path === "sources"));
    // rebuild the Hunter 350 field by field through the draft API
    const src = readSrc("royal-enfield-hunter-350-metro-in");
    const re = { ...src, engine: undefined, transmission: { kind: src.transmission.kind }, chassis: undefined, emission: undefined, fuel: { compat: src.fuel.compat } };
    for (const g of ["engine", "transmission", "chassis", "emission", "fuel"]) for (const [k, v] of Object.entries(src[g] || {})) {
        if (k === "compat" || (g === "transmission" && k === "kind")) continue;
        D.setValue(re, `${g}.${k}`, v.v, { unit: v.u, src: v.src, conf: v.conf, note: v.note, tol: v.tol, basis: v.basis });
    }
    for (const k of Object.keys(re)) if (re[k] === undefined) delete re[k];
    assert.deepEqual(JSON.parse(JSON.stringify(re.engine)), JSON.parse(JSON.stringify(src.engine)));
    assert.deepEqual(JSON.parse(JSON.stringify(re.chassis)), JSON.parse(JSON.stringify(src.chassis)));
    assert.equal(C.validateBundle(re, ref).ok, true);
    // removing a required value is caught
    D.setValue(re, "engine.peakTorque", "");
    assert.ok(C.validateBundle(re, ref).errors.some((e) => e.path.startsWith("engine.peakTorque")));
});

test("approval needs a picture: the contract passes a bundle without one, approval does not", () => {
    const src = readSrc("bajaj-pulsar-ns200-dual-abs-in");
    assert.equal(src.image, undefined);
    assert.equal(C.validateBundle(src, ref).ok, true);            // still fine for the contract …
    const errs = D.approvalErrors(src);                               // … but not for approval
    assert.equal(errs.length, 1);
    assert.equal(errs[0].path, "image.url"); assert.equal(errs[0].code, "picture_required");
    assert.equal(D.approvalErrors({ ...src, image: { url: "   ", src: "x" } }).length, 1);
    const sid = src.sources[0].id;
    const withPic = { ...src, image: { url: "https://cdn.mapunite.app/bikes/bajaj-pulsar-ns200.webp", src: sid } };
    assert.deepEqual(D.approvalErrors(withPic), []);
    assert.equal(C.validateBundle(withPic, ref).ok, true);
    assert.deepEqual(D.approvalErrors(null), D.approvalErrors({}));
});

test("the physics preview equals the shipped bundle's physics", () => {
    const id = "honda-activa-110-dlx-obd2b-in";
    const src = readSrc(id);
    const classRt = runtimeById.get(`default-${src.classKey.replace(".", "-").replace("_", "-")}`) || [...runtimeById.values()].find((b) => b.kind === "class_default" && b.classKey === src.classKey);
    const pv = D.preview(Physics, D.toRuntime(C, src, classRt), classRt);
    assert.equal(pv.ok, true);
    const shipped = Physics.createBikeModel(runtimeById.get(id), { classDefault: classRt });
    const t = Physics.cruiseTable(shipped, { grade: 0 }, { sigma: false, step: 1 });
    for (const a of pv.at) {
        const i = Math.round(a.kmh / 3.6);
        assert.ok(Math.abs(a.value - 1 / (t.perMetre[i] * 1e6)) / a.value < 1e-9, `${a.kmh} km/h`);
    }
    assert.ok(pv.eco && pv.eco.low < pv.eco.high);
    assert.ok(pv.range > 100000);
    assert.equal(pv.classAt.length, 3);
    assert.equal(D.preview(Physics, { kind: "variant" }, classRt).ok, false);
    void makeRuntimeBundle;
});

test("PS / hp conversion with the contract's note; confidence defaults respect the caps", () => {
    assert.deepEqual(D.convertPower(20.4, "PS"), { kw: 15, note: "Published as 20.4 PS; converted at 0.7355 kW/PS" });
    assert.equal(D.convertPower(19, "hp").kw, 14.17);
    assert.equal(D.defaultConf(C, "press"), 0.6);
    assert.equal(D.defaultConf(C, "manufacturer"), 0.9);
    assert.ok(D.defaultConf(C, "community") <= C.CONF_CAP.community);
});

test("requests: duplicates collapse with a count; offline mode keeps the whole workflow", async () => {
    const reqs = A.normaliseRequests([
        { id: "a", description: "Bajaj  Avenger 220 Street", classKey: "ice_manual.cruiser", at: 5 },
        { id: "b", description: "bajaj avenger 220 street", at: 3 },
        { description: "x" },
        { id: "c", description: "Yezdi Roadster", at: 9 }
    ]);
    assert.equal(reqs.length, 2);
    assert.equal(reqs[0].count, 2); assert.equal(reqs[0].createdAt, 3); assert.equal(reqs[0].classKey, "ice_manual.cruiser");
    const mem = new Map();
    const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
    const api = A.createLocalApi(/** @type {any} */ (storage));
    assert.equal(api.importJson({ requests: [{ description: "TVS Ronin 225" }, { description: "Yezdi Roadster" }], ...ref }), 2);
    assert.equal((await api.list("queued")).length, 2);
    const [r1, r2] = await api.list("all");
    await api.saveDraft(r1.id, { id: "x" });
    assert.equal((await api.list("drafted")).length, 1);
    const ap = await api.approve(r1.id, { id: "tvs-ronin-225-in" });
    assert.equal(ap.location, "download");
    await api.duplicate(r2.id, "yezdi-roadster-in");
    assert.deepEqual((await api.list("all")).map((r) => r.status).sort(), ["approved", "duplicate"]);
    assert.ok((await api.reference()).fuelGrades);
});

test("server API: paths, admin token, JSON bodies and readable errors", async () => {
    const calls = [];
    const fake = async (url, init) => {
        calls.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body && JSON.parse(init.body) });
        if (url.endsWith("/approve")) return new Response(JSON.stringify({ error: "validate.mjs: 1 error", errors: [{ path: "fuel", message: "no_certified_fuel" }] }), { status: 422 });
        if (url.includes("/reference")) return new Response("nope", { status: 401 });
        return new Response(JSON.stringify({ requests: [{ id: "r1", description: "x y" }], ok: true }), { status: 200 });
    };
    const api = A.createCuratorApi({ base: "https://mu.example/", token: "s3cret", fetch: /** @type {any} */ (fake) });
    assert.equal((await api.list("queued"))[0].id, "r1");
    await api.saveDraft("r 1", { id: "a" });
    await api.reject("r1", "not sold in India");
    await api.duplicate("r1", "bike-id");
    await assert.rejects(api.reference(), /didn't accept this admin token/);
    await assert.rejects(api.approve("r1", { id: "a" }), (e) => /validate\.mjs/.test(e.message) && e.status === 422 && e.body.errors[0].message === "no_certified_fuel");
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace("https://mu.example", "")}`), [
        "GET /api/admin/bike-requests?status=queued", "PUT /api/admin/bike-requests/r%201/draft", "POST /api/admin/bike-requests/r1/reject",
        "POST /api/admin/bike-requests/r1/duplicate", "GET /api/admin/bikedb/reference", "POST /api/admin/bike-requests/r1/approve"
    ]);
    assert.ok(calls.every((c) => c.auth === "Bearer s3cret"));
    assert.deepEqual(calls[2].body, { reason: "not sold in India" });
});

test("the curator page: no inline script, not indexed, every script exists", () => {
    const html = fs.readFileSync(path.join(ROOT, "public/admin/curator.html"), "utf8");
    assert.doesNotMatch(html, /<script>(?!\s*<\/script>)/);
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    for (const m of html.matchAll(/<script src="([^"]+)"/g)) assert.ok(fs.existsSync(path.join(ROOT, "public", m[1])), m[1]);
    assert.ok(fs.existsSync(path.join(ROOT, "public/js/curator/curator.css")));
});
