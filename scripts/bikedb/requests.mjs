#!/usr/bin/env node
/*
 * The queue of rider requests for bikes that aren't in the catalogue yet
 * (POST /api/bikes/requests), most-wanted first. For curators: research a bike
 * into data/bikes/ (sources, confidence, fuel approvals — or pending/), then
 * mark its request.
 *
 *   npm run bikes:requests                              queued requests
 *   npm run bikes:requests -- --status researching      another status
 *   npm run bikes:requests -- --votes 12                each requester's hints for request 12
 *   npm run bikes:requests -- --set 12 researching      change a status (queued, researching, added, rejected)
 *   DB_PATH=/srv/mapunite/data/mapunite.db npm run bikes:requests
 *
 * Reads the server's database (DB_PATH, default data/mapunite.db). Requesters
 * are pseudonyms; the server never stores IP addresses.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./load-catalog.mjs";

const require = createRequire(import.meta.url);
const { loadDriver } = require("../../lib/bikedb/sqlite.js");
const { RequestQueue, STATUSES } = require("../../lib/bikedb/request-queue.js");

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const fail = (msg) => { console.error(msg); process.exit(2); };

const file = process.env.DB_PATH || path.join(ROOT, "data", "mapunite.db");
if (!fs.existsSync(file)) fail(`no server database at ${file} (set DB_PATH)`);
const db = loadDriver({ purpose: "read the request queue" }).open(file);
try {
    const q = new RequestQueue(db);
    const setAt = argv.indexOf("--set");
    if (setAt >= 0) {
        const id = Number(argv[setAt + 1]), status = argv[setAt + 2];
        if (!Number.isInteger(id) || !STATUSES.includes(status)) fail(`usage: --set <id> <${STATUSES.join("|")}>`);
        if (!q.setStatus(id, status)) fail(`no request ${id}`);
        console.log(`request ${id}: ${status}`);
    } else if (opt("--votes") !== undefined) {
        const id = Number(opt("--votes"));
        const r = q.get(id);
        if (!r) fail(`no request ${id}`);
        console.log(`#${r.id}  ${r.make} ${r.model}${r.variant ? ` ${r.variant}` : ""} [${r.market}]  ${r.status}, ${r.requesters} requester(s)`);
        for (const v of q.votes(id)) console.log(`  ${new Date(v.at).toISOString().slice(0, 10)}  ${v.requester.slice(0, 8)}  year ${v.year ?? "-"}  ${v.powertrain ?? "-"}  ${v.note ? JSON.stringify(v.note) : ""}`);
    } else {
        const status = opt("--status") || "queued";
        if (!STATUSES.includes(status)) fail(`--status must be one of ${STATUSES.join(", ")}`);
        const rows = q.list({ status, limit: Number(opt("--limit")) || 50 });
        if (!rows.length) console.log(`no ${status} requests`);
        for (const r of rows) {
            console.log(`#${String(r.id).padEnd(5)} ${String(r.requesters).padStart(4)} × ${r.make} ${r.model}${r.variant ? ` ${r.variant}` : ""} [${r.market}]  since ${new Date(r.firstAt).toISOString().slice(0, 10)}`);
        }
    }
} finally {
    db.close();
}
