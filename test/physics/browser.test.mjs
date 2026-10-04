// The physics files must also load as plain <script> tags (no module system), in order,
// and give the same answers through window.MUPhysics as through require().
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { Physics, bundleById } from "./helpers.mjs";

const ORDER = ["atmosphere", "tyre", "powertrain", "roadload", "model", "cruise", "index"];

test("browser load: plain scripts in order build window.MUPhysics, with identical results", () => {
    const sandbox = { Math, Number, Object, Array, Float64Array, Int8Array, Uint8Array, Error, TypeError, RangeError, JSON, Set, Map, String, Infinity, NaN };
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    for (const f of ORDER) vm.runInContext(fs.readFileSync(fileURLToPath(new URL(`../../public/js/physics/${f}.js`, import.meta.url)), "utf8"), ctx, { filename: `${f}.js` });
    const W = /** @type {any} */ (sandbox).MUPhysics;
    assert.equal(typeof W.createBikeModel, "function");
    const b = bundleById.get("royal-enfield-hunter-350-metro-in");
    const a = W.cruiseTable(W.createBikeModel(JSON.parse(JSON.stringify(b))), { altitude: 500 });
    const n = Physics.cruiseTable(Physics.createBikeModel(b), { altitude: 500 });
    assert.deepEqual(Array.from(a.perMetre), Array.from(n.perMetre));
    assert.equal(JSON.stringify(a.eco), JSON.stringify(n.eco));   // objects from another realm: compare values
});

test("browser load: index.js loaded too early says what's missing", () => {
    const sandbox = { Math, Object, Error };
    sandbox.globalThis = sandbox;
    assert.throws(() => vm.runInNewContext(fs.readFileSync(fileURLToPath(new URL("../../public/js/physics/index.js", import.meta.url)), "utf8"), sandbox), /load atmosphere, tyre/);
});
