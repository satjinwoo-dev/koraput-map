// Every delivered batch file is in the checkout, and nothing a page loads is missing.
// If this fails, run `node scripts/check-batches.mjs` for the list, by batch.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CB = await import("../../scripts/check-batches.mjs");

test("all batch files present; every page and precache reference exists", () => {
    const { missing, broken } = CB.check();
    assert.deepEqual(missing.map((m) => `${m.rel} (${m.batch})`), [], "batch files missing: node scripts/check-batches.mjs");
    assert.deepEqual(broken.map((b) => `${b.from} → ${b.ref}`), [], "pages reference files that don't exist");
});

test("check-batches: CRLF doesn't count as a change; a missing referenced file is reported", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-cb-"));
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(dir, "public/js"), { recursive: true });
    fs.writeFileSync(path.join(dir, "public/js/a.js"), "one\ntwo\n");
    const sha = CB.hashFile(path.join(dir, "public/js/a.js"));
    fs.writeFileSync(path.join(dir, "public/js/a.js"), "one\r\ntwo\r\n");
    fs.writeFileSync(path.join(dir, "public/index.html"), '<script src="js/a.js?v=1"></script><script src="js/gone.js?v=1"></script><script src="vendor/capacitor.js"></script>');
    fs.writeFileSync(path.join(dir, "scripts/batch-manifest.json"), JSON.stringify({ latestBatch: "t", files: {
        "public/js/a.js": { sha256: sha, batch: "t" },
        "public/js/gone.js": { sha256: "x", batch: "t" }
    } }));
    const r = CB.check(dir);
    assert.deepEqual(r.changed, []);
    assert.deepEqual(r.missing.map((m) => m.rel), ["public/js/gone.js"]);
    assert.deepEqual(r.broken.map((b) => b.ref), ["/js/gone.js"]);       // vendor/ is the Android build's, not checked
    fs.rmSync(dir, { recursive: true, force: true });
});
