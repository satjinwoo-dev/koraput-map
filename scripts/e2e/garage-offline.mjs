#!/usr/bin/env node
/*
 * End-to-end check of Step 7 in headless Chromium against the real server.js:
 * My bike as a sheet on index.html (the socket stays connected), SmartDrive taking
 * its fuel baseline from the chosen bike, and the service worker making it all work
 * offline — including for a rider who never opened My bike while online.
 *
 *   node scripts/e2e/garage-offline.mjs            (needs Playwright + Chromium: npx playwright install chromium)
 *   PLAYWRIGHT_PATH=/path/to/node_modules/playwright node scripts/e2e/garage-offline.mjs
 * The browser accepts any TLS certificate (ignoreHTTPSErrors): the app loads Leaflet from
 * unpkg, and CI sandboxes often sit behind an intercepting proxy. Where unpkg is blocked
 * outright, set E2E_LEAFLET_DIR to an unpacked leaflet@1.9.4 package (npm pack leaflet@1.9.4)
 * and the same files are served for https://unpkg.com/leaflet@1.9.4/dist/*.
 *
 * Not part of npm test (the repo doesn't depend on Playwright). Exit code 0 = pass.
 */
import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
function loadPlaywright() {
    const tries = [process.env.PLAYWRIGHT_PATH, "playwright"];
    try { tries.push(path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "playwright")); } catch { /* no npm */ }
    for (const t of tries.filter(Boolean)) { try { return require(t); } catch { /* next */ } }
    console.error("Playwright not found: npm i -D playwright && npx playwright install chromium (or set PLAYWRIGHT_PATH)");
    process.exit(2);
}
// With a local Leaflet (E2E_LEAFLET_DIR), the service worker's own requests must be routed too
// (it precaches the CDN files): Playwright does that in Chromium with this switch.
if (process.env.E2E_LEAFLET_DIR) process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";
const { chromium } = loadPlaywright();

const results = [];
const check = (ok, what, detail = "") => { results.push({ ok, what }); console.log(`${ok ? "  ✓" : "  ✗"} ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) process.exitCode = 1; };
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-e2e-"));
const port = await freePort();
const BASE = `http://localhost:${port}`;
const server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(port), DB_PATH: path.join(dir, "mu.db") }, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stdout.on("data", (d) => { log += d; });
server.stderr.on("data", (d) => { log += d; });
for (let i = 0; i < 100 && !log.includes("MapUnite Server running"); i++) await new Promise((r) => setTimeout(r, 100));
if (!log.includes("MapUnite Server running")) { console.error(log); process.exit(1); }

const browser = await chromium.launch();
const ownErrors = [];
/** Serve Leaflet from a local copy where the CDN is blocked (E2E_LEAFLET_DIR). */
async function cdnFallback(context) {
    const dirL = process.env.E2E_LEAFLET_DIR;
    if (!dirL) return;
    await context.route("https://unpkg.com/leaflet@1.9.4/dist/**", (route) => {
        const file = path.join(dirL, "dist", new URL(route.request().url()).pathname.replace("/leaflet@1.9.4/dist/", ""));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
        route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { "content-type": file.endsWith(".css") ? "text/css" : file.endsWith(".png") ? "image/png" : "application/javascript", "access-control-allow-origin": "*" } });
    });
}
/** A page on the app with its service worker in control. */
async function openApp(context) {
    await cdnFallback(context);
    const page = await context.newPage();
    page.on("pageerror", (e) => ownErrors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_|maps\.googleapis|leaflet|unpkg|google/i.test(m.text())) ownErrors.push(m.text()); });
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof SmartDrive !== "undefined" && typeof GarageSheet !== "undefined", null, { timeout: 15000 });
    await page.evaluate(() => navigator.serviceWorker.ready);
    if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) {
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller) && typeof GarageSheet !== "undefined", null, { timeout: 15000 });
    }
    await page.waitForFunction(async () => (await caches.has("mu-bikedb-v1")) && (await (await caches.open("mu-bikedb-v1")).keys()).length >= 11, null, { timeout: 20000 });
    return page;
}
/** Join like a rider does (the join screen covers the app until then). */
async function join(page, name = "E2E Rider") {
    const join = page.locator("#join-screen");
    if (!(await join.isVisible().catch(() => false))) return;
    await page.locator("#nameInput").fill(name);
    await page.locator("#join-submit").click();
    await join.waitFor({ state: "hidden", timeout: 15000 });
}
const openSheet = async (page) => {
    await join(page);
    await page.evaluate(() => { safeShow("profile-settings-modal", "flex"); document.getElementById("garage-open-btn").click(); });
    await page.locator("#garage-modal").waitFor({ state: "visible" });
};

try {
    // ------------------------------------------------------------------ online
    console.log("Online: My bike in a sheet, SmartDrive follows the bike");
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
    const page = await openApp(ctx);
    await page.waitForFunction(() => typeof socket !== "undefined" && socket.connected, null, { timeout: 15000 });
    const sid = await page.evaluate(() => socket.id);
    check(await page.evaluate(() => SmartDrive.ratedKmPerL() === 18 && BikeFuel.status === "none"), "no bike yet: SmartDrive is unchanged (18 km/L)");
    check(await page.evaluate(() => !document.querySelector('script[src*="js/physics/"]')), "the physics isn't loaded at start-up");
    await openSheet(page);
    check(await page.evaluate(() => document.getElementById("profile-settings-modal").style.display === "none"), "the sheet replaces Settings while open");
    const input = page.locator("#garage-sheet-root input.mu-search-input");
    await input.waitFor();
    await input.pressSequentially("hunter", { delay: 30 });
    await page.locator("#garage-sheet-root .mu-result").first().click();
    await page.locator("#garage-sheet-root .mu-chip-year").first().click();
    await page.locator("#garage-sheet-root .mu-bike-name").waitFor();
    await page.waitForFunction(() => BikeFuel.status === "ready", null, { timeout: 15000 });
    const rated = await page.evaluate(() => SmartDrive.ratedKmPerL());
    check(rated > 40 && rated < 70, "picking the Hunter 350 sets SmartDrive's baseline from its physics", `${rated} km/L at 40–60 km/h`);
    check(await page.evaluate((id) => socket.connected && socket.id === id, sid), "the socket stayed connected: same id, no page change");
    if (process.env.E2E_SHOTS) {                                       // optional: screenshots of the sheet for review
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(process.env.E2E_SHOTS, "sheet-390.png") });
        await page.setViewportSize({ width: 1280, height: 860 });
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(process.env.E2E_SHOTS, "sheet-1280.png") });
        await page.setViewportSize({ width: 390, height: 844 });
    }
    const searchBox = page.locator("#garage-sheet-root input.mu-search-input");
    await page.locator("#garage-sheet-root .mu-change").click();
    await searchBox.waitFor();
    await searchBox.press("Escape");
    check(await page.locator("#garage-modal").isVisible(), "Escape in the search box clears it and leaves the sheet open");
    await page.locator("#garage-sheet-root .mu-back, #garage-sheet-root button:has-text('Back')").first().click().catch(() => { });
    await page.locator("#garage-close-btn").click();
    check(await page.evaluate(() => document.getElementById("profile-settings-modal").style.display === "flex"), "closing the sheet goes back to Settings");
    check(await page.evaluate(() => document.getElementById("fuel-input-val").disabled && /From your Royal Enfield Hunter 350/.test(document.getElementById("fuel-source-hint").textContent)),
        "Settings say where the km/L comes from", await page.evaluate(() => document.getElementById("fuel-source-hint").textContent.slice(0, 90) + "…"));

    // ------------------------------------------------------------------ offline, same rider
    console.log("Offline: reload, the sheet, a typical bike, the standalone page");
    await ctx.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof SmartDrive !== "undefined" && typeof BikeFuel !== "undefined" && BikeFuel.status !== "none", null, { timeout: 15000 });
    check(await page.evaluate(() => BikeFuel.status === "ready"), "offline reload: the bike's baseline is there at once (stored snapshot)");
    check(Math.abs((await page.evaluate(() => SmartDrive.ratedKmPerL())) - rated) < 1e-9, "same km/L as online");
    await openSheet(page);
    await page.locator("#garage-sheet-root .mu-bike-name").waitFor({ timeout: 15000 });
    check(await page.locator("#garage-sheet-root svg").count() > 0, "offline: the sheet loads its code from the service worker and draws the bike's chart");
    await page.locator("#garage-sheet-root .mu-change").click();
    await page.getByRole("button", { name: "My bike isn't listed" }).click();
    await page.locator('#garage-sheet-root .mu-class-btn[data-class="ice_cvt.scooter"]').click();
    await page.locator("#garage-sheet-root .mu-bike-name").waitFor();
    await page.waitForFunction(() => BikeFuel.status === "ready" && /typical/i.test(BikeFuel.describe()), null, { timeout: 15000 });
    check(true, "offline: a typical scooter (precached class default) becomes the baseline", await page.evaluate(() => `${SmartDrive.ratedKmPerL()} km/L`));
    await page.locator("#garage-close-btn").click();
    const standalone = await ctx.newPage();
    await standalone.goto(`${BASE}/garage.html`);
    await standalone.locator(".mu-bike-name").waitFor({ timeout: 15000 });
    check(true, "offline: the standalone garage.html opens from the cache");
    await standalone.close();
    await ctx.close();

    // ------------------------------------------------------------------ offline, never opened My bike
    console.log("Offline first time: a rider who never opened My bike online");
    const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
    const p2 = await openApp(fresh);                                    // one online visit installs the worker
    await fresh.setOffline(true);
    await p2.reload({ waitUntil: "domcontentloaded" });
    await p2.waitForFunction(() => typeof GarageSheet !== "undefined", null, { timeout: 15000 });
    await openSheet(p2);
    await p2.locator("#garage-sheet-root input.mu-search-input").waitFor({ timeout: 15000 });
    await p2.locator("#garage-sheet-root input.mu-search-input").pressSequentially("activa", { delay: 20 });
    check(await p2.locator("#garage-sheet-root .mu-result").count() > 0, "offline search works from the precached bike list");
    await p2.getByRole("button", { name: "My bike isn't listed" }).click();
    await p2.locator('#garage-sheet-root .mu-class-btn[data-class="ice_manual.commuter"]').click();
    await p2.locator("#garage-sheet-root .mu-bike-name").waitFor({ timeout: 15000 });
    await p2.waitForFunction(() => BikeFuel.status === "ready", null, { timeout: 15000 });
    check(true, "offline, first time: a typical commuter works and feeds SmartDrive", await p2.evaluate(() => `${SmartDrive.ratedKmPerL()} km/L`));
    await fresh.close();
} catch (e) {
    check(false, "flow completed", process.env.E2E_VERBOSE ? e.message : e.message.split("\n")[0]);
} finally {
    await browser.close();
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
}
check(ownErrors.length === 0, "no errors from the app's own code", ownErrors.slice(0, 3).join(" | "));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
