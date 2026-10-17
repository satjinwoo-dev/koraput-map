// data/sources.json: every external source MapUnite uses has its licence, attribution, commercial-use status, access
// method and legal review status recorded (blueprint review point 12), and no code calls a host that isn't listed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REG = JSON.parse(fs.readFileSync(path.join(ROOT, "data/sources.json"), "utf8"));

test("every source has the required fields, with closed values", () => {
    const ids = new Set();
    for (const s of REG.sources) {
        for (const k of ["id", "name", "hosts", "use", "licence", "commercial_use", "access_method", "legal_review"]) assert.ok(s[k] !== undefined && s[k] !== "", `${s.id}: ${k}`);
        for (const k of ["licence_version", "attribution", "fetched_at", "source_version", "notes"]) assert.ok(k in s, `${s.id}: ${k} (null if unknown)`);
        assert.ok(["yes", "no", "unclear", "by_agreement"].includes(s.commercial_use), `${s.id}: commercial_use`);
        assert.ok(["pending", "approved", "rejected"].includes(s.legal_review), `${s.id}: legal_review`);
        assert.ok(!ids.has(s.id), `duplicate ${s.id}`);
        ids.add(s.id);
    }
    // OSM-derived data: attribution recorded
    assert.equal(REG.sources.find((s) => s.id === "osm-data").attribution, "© OpenStreetMap contributors");
});

test("no code calls an external host that isn't in the registry", () => {
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/node_modules|vendor/.test(p)) walk(p); } else if (/\.(js|html)$/.test(e.name)) files.push(p); } };
    for (const d of ["public/js", "lib"]) walk(path.join(ROOT, d));
    files.push(path.join(ROOT, "public/index.html"), path.join(ROOT, "server.js"));
    const known = new Set([...REG.sources.flatMap((s) => s.hosts), ...REG.ignoredHosts]);
    const missing = new Map();
    for (const f of files) {
        for (const m of fs.readFileSync(f, "utf8").matchAll(/https:\/\/([a-z0-9.{}-]+\.[a-z]{2,})/gi)) {
            const host = m[1].replace(/^\{s\}\./, "").toLowerCase();
            if (!known.has(host)) missing.set(host, path.relative(ROOT, f));
        }
    }
    assert.deepEqual([...missing.entries()], [], "add these hosts to data/sources.json (with their licence) or remove the calls");
});
