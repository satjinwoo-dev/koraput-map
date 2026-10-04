// The committed JSON Schema is generated from the contract and agrees with the validator.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { Contract, ROOT, catalog, clone } from "./helpers.mjs";

const SCHEMA = path.join(ROOT, "lib", "bikedb", "bundle.schema.json");

test("lib/bikedb/bundle.schema.json is up to date with the contract", () => {
    const fresh = JSON.stringify(Contract.buildJsonSchema(), null, 2) + "\n";
    assert.equal(fs.readFileSync(SCHEMA, "utf8"), fresh, "run: node scripts/bikedb/gen-schema.mjs");
});

const py = spawnSync("python3", ["-c", "import jsonschema"], { encoding: "utf8" });
const havePy = py.status === 0;
test("every seed file passes the JSON Schema; structural breakages fail it (Python jsonschema)", { skip: !havePy && "python3 + jsonschema not installed" }, () => {
    const bad = [];
    const b1 = clone("royal-enfield-classic-350-in"); b1.engine.peakPower.u = "hp"; bad.push(b1);
    const b2 = clone("royal-enfield-classic-350-in"); delete b2.engine.bore.src; bad.push(b2);
    const b3 = clone("ather-450x-3-7kwh-2025-in"); b3.fuel = { compat: [] }; bad.push(b3);
    const b4 = clone("tvs-jupiter-110-disc-sxc-in"); b4.engine.typo = 1; bad.push(b4);
    const b5 = clone("default-ev-scooter"); delete b5.priors.cda; bad.push(b5);
    const payload = JSON.stringify({ good: catalog.entries.map((e) => e.bundle), bad });
    const script = `
import json, sys
from jsonschema import Draft202012Validator
schema = json.load(open(sys.argv[1]))
Draft202012Validator.check_schema(schema)
v = Draft202012Validator(schema)
d = json.load(sys.stdin)
good_fail = [b["id"] + ": " + next(iter(v.iter_errors(b))).message for b in d["good"] if not v.is_valid(b)]
bad_pass = [i for i, b in enumerate(d["bad"]) if v.is_valid(b)]
print(json.dumps({"good_fail": good_fail, "bad_pass": bad_pass}))`;
    const r = spawnSync("python3", ["-c", script, SCHEMA], { input: payload, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.good_fail, [], "seed files rejected by the schema");
    assert.deepEqual(out.bad_pass, [], "broken bundles accepted by the schema");
});

test("the contract loads as a plain browser script (window.BikeContract) with no module system", () => {
    const code = fs.readFileSync(path.join(ROOT, "public", "js", "bikedb", "bundle-contract.js"), "utf8");
    const win = {};
    vm.runInNewContext(code, { self: win });
    assert.equal(typeof win.BikeContract.validateBundle, "function");
    assert.equal(win.BikeContract.validateBundle(clone("tvs-iqube-3-5kwh-in"), catalog.ref).ok, true);
});
