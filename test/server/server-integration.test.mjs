// Step 5, end to end: the real server.js (production mode, default CORS for the
// Android app) with the bike API mounted, in a child process.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { art, drivers, tmpDir, buildDb, raw, bundleFile, ROOT } from "./helpers.mjs";

const better = drivers.find((d) => d.name === "better-sqlite3");
const opts = better ? {} : { skip: "server.js needs better-sqlite3's native addon (npm rebuild better-sqlite3)" };
const HUNTER = "royal-enfield-hunter-350-metro-in";
const hunterHash = art.bundles.find((b) => b.id === HUNTER).hash;

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let dir, child, base, log = "";
before(async () => {
    if (!better) return;
    dir = tmpDir("server");
    const bikes = buildDb(dir, better);
    const port = await freePort();
    child = spawn(process.execPath, ["server.js"], {
        cwd: ROOT,
        env: { ...process.env, NODE_ENV: "production", PORT: String(port), DB_PATH: path.join(dir, "mapunite.db"), BIKES_DB_PATH: bikes,
            HTTP_RATE_LIMIT_MAX: "5", SERVER_SECRET: "test-secret", REDIS_URL: "", CORS_ORIGIN: "", NATIVE_APP_ORIGINS: "https://localhost,capacitor://localhost" },
        stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (d) => { log += d; });
    child.stderr.on("data", (d) => { log += d; });
    base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
        try { if ((await raw(`${base}/healthz`)).status === 200) return; } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`server.js didn't start:\n${log}`);
});
after(async () => {
    if (child && child.exitCode === null) { child.kill("SIGKILL"); await new Promise((r) => child.once("exit", r)); }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("server.js: boots with the catalogue, reports it in /healthz and in its startup log", opts, async () => {
    const h = await raw(`${base}/healthz`);
    assert.deepEqual(h.json.bikes, { available: true, catalogVersion: art.catalog.version, variants: 25 });
    assert.match(log, new RegExp(`Bikes: catalogue ${art.catalog.version}, 25 variants`));
});

test("server.js: the API serves the same bundle bytes as the static website files", opts, async () => {
    const api = await raw(`${base}/api/bikes/bundles/${hunterHash}`);
    const stat = await raw(`${base}/bikedb/bundles/${hunterHash}.json`);
    assert.equal(api.status, 200);
    assert.equal(stat.status, 200);
    assert.equal(api.text, stat.text);
    assert.equal(api.text, fs.readFileSync(bundleFile(hunterHash), "utf8"));
    assert.equal(api.headers["x-content-type-options"], "nosniff", "helmet still applies");
});

test("server.js (production CORS): the Android app is allowed, other sites aren't", opts, async () => {
    const app = await raw(`${base}/api/bikes/search?q=hunter`, { headers: { Origin: "https://localhost" } });
    assert.equal(app.status, 200);
    assert.equal(app.headers["access-control-allow-origin"], "https://localhost");
    assert.equal(app.json.results[0].id, HUNTER);
    const pre = await raw(`${base}/api/bikes/requests`, { method: "OPTIONS", headers: { Origin: "https://localhost", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers["access-control-allow-origin"], "https://localhost");
    const evil = await raw(`${base}/api/bikes/search?q=hunter`, { headers: { Origin: "https://evil.example" } });
    assert.equal(evil.headers["access-control-allow-origin"], undefined);
    const evilPost = await raw(`${base}/api/bikes/requests`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ make: "A", model: "B" }) });
    assert.equal(evilPost.status, 403);
});

test("server.js: mounted before the global parser and limiter — 4 KB body cap, and type-ahead doesn't eat the API budget", opts, async () => {
    const big = await raw(`${base}/api/bikes/requests`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ make: "A", model: "B", note: "n".repeat(5000) }) });
    assert.equal(big.status, 413, "the bike API's own 4 KB limit, not the global 256 KB one");
    for (let i = 0; i < 12; i++) assert.equal((await raw(`${base}/api/bikes/search?q=${"royal".slice(0, 1 + (i % 5))}`)).status, 200, `keystroke ${i + 1}`);
    const general = [];
    for (let i = 0; i < 7; i++) general.push((await raw(`${base}/api/config`)).status);
    // /healthz (setup + the first test) already used 2 of the 5; the 12 searches used none
    assert.deepEqual(general, [200, 200, 200, 429, 429, 429, 429], "HTTP_RATE_LIMIT_MAX=5 still guards the rest of the API");
});

test("server.js: a request for a missing bike lands in the server's database, keyed by a pseudonym, never the IP", opts, async () => {
    const r = await raw(`${base}/api/bikes/requests`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://localhost" }, body: JSON.stringify({ make: "Kawasaki", model: "Ninja 300", year: 2025 }) });
    assert.equal(r.status, 202);
    assert.equal(r.headers["access-control-allow-origin"], "https://localhost");
    child.kill("SIGTERM");
    const code = await new Promise((res) => child.once("exit", res));
    assert.equal(code, 0, `clean shutdown\n${log}`);
    const db = better.open(path.join(dir, "mapunite.db"), { readonly: true });
    const rows = db.prepare("SELECT make, model, requesters FROM bike_request").all();
    const votes = db.prepare("SELECT requester, year FROM bike_request_vote").all();
    db.close();
    assert.deepEqual(rows.map((x) => ({ ...x })), [{ make: "Kawasaki", model: "Ninja 300", requesters: 1 }]);
    assert.equal(votes.length, 1);
    assert.equal(votes[0].year, 2025);
    assert.match(votes[0].requester, /^[0-9a-f]{32}$/);
    assert.ok(!votes[0].requester.includes("127.0.0.1"));
});
