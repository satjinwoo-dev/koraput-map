"use strict";

// bundle.schema.json and validate.js must agree:
//   - the committed schemas are what scripts/build-bike-schema.mjs generates,
//   - every seed file passes both,
//   - every structural breakage in fixtures.js is rejected by both,
//   - the validator rejects everything the schema rejects (it is stricter:
//     physics and source references are beyond JSON Schema).

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { execFileSync } = require("child_process");
const Ajv2020 = require("ajv/dist/2020").default;
const V = require("../../public/js/bikedb/validate.js");
const { ROOT, load, mutations } = require("./fixtures.js");
const fs = require("fs");

// strictTypes is Ajv's own lint (it wants a "type" next to every keyword in
// conditional subschemas); it isn't part of JSON Schema. Unknown keywords and
// malformed schemas still fail.
const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strictTypes: false });
const bundleSchema = ajv.compile(load("data/schema/bundle.schema.json"));
const fuelSchema = ajv.compile(load("data/schema/fuel_grade.schema.json"));
const emissionSchema = ajv.compile(load("data/schema/emission_standard.schema.json"));

const listJson = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".json")).sort().map((f) => `${dir}/${f}`);

test("committed schemas are up to date with the validator", () => {
    execFileSync(process.execPath, [path.join(ROOT, "scripts/build-bike-schema.mjs"), "--check"], { stdio: "pipe" });
});

test("every seed file passes the JSON Schema", () => {
    for (const file of [...listJson("data/bikes"), ...listJson("data/class-defaults")]) {
        assert.ok(bundleSchema(load(file)), `${file}: ${JSON.stringify(bundleSchema.errors, null, 1)}`);
    }
    assert.ok(fuelSchema(load("data/lookups/fuel_grade.json")), JSON.stringify(fuelSchema.errors, null, 1));
    assert.ok(emissionSchema(load("data/lookups/emission_standard.json")), JSON.stringify(emissionSchema.errors, null, 1));
});

for (const m of mutations) {
    test(`schema and validator agree: ${m.name}`, () => {
        const b = load(m.base);
        m.mutate(b);
        const schemaOk = bundleSchema(b);
        const validatorOk = V.validateBundle(b).valid;
        if (m.structural) assert.equal(schemaOk, false, `the schema accepted "${m.name}"`);
        if (!schemaOk) assert.equal(validatorOk, false, `the schema rejects "${m.name}" but the validator accepts it`);
    });
}
