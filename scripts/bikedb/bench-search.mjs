#!/usr/bin/env node
/*
 * Search benchmark for plan step 3's gate: "FTS5 under 10 ms on a synthetic
 * 20k-row benchmark".
 *
 *   node --disable-warning=ExperimentalWarning scripts/bikedb/bench-search.mjs [--rows 20000]
 *
 * Builds an in-memory database from lib/bikedb/schema.sql, fills bike_search
 * with synthetic but realistic bike names (deterministic: the same rows every
 * run), then times lib/bikedb/search.js — the exact query the server runs —
 * over a mix of what riders type: one- and two-letter prefixes (the worst case:
 * thousands of matches to rank), makes, model codes run together and split.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { keywordsFor } = require(path.join(ROOT, "public/js/bikedb/search-keys.js"));
const { makeSearch } = require(path.join(ROOT, "lib/bikedb/search.js"));

const MAKES = ["Hero", "Honda", "Bajaj", "TVS", "Royal Enfield", "Yamaha", "Suzuki", "KTM", "Kawasaki", "Ather",
    "Ola Electric", "Revolt", "Ultraviolette", "Jawa", "Yezdi", "BMW", "Triumph", "Harley-Davidson", "Benelli", "Keeway"];
const STEMS = ["Splendor", "Shine", "Pulsar", "Apache", "Classic", "Hunter", "Meteor", "Activa", "Jupiter", "Access",
    "Duke", "Ninja", "Raider", "Glamour", "Passion", "Unicorn", "Dominar", "Avenger", "Ronin", "Scram", "Bullet", "Xpulse",
    "Chetak", "iQube", "Ntorq", "Burgman", "Gixxer", "Dio", "Fascino", "Ray"];
const CODES = ["NS", "RS", "RTR", "MT", "R", "FZ", "N", "SP", "CB", "RC", "Z", "X", "S", "GT", "V"];
const TRIMS = ["Standard", "Deluxe", "Disc", "Drum", "ABS", "Dual Channel ABS", "Bluetooth", "Smart Xonnect", "Pro", "Plus", "Special Edition"];

/** Deterministic PRNG (mulberry32) so every run benchmarks the same rows. */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function syntheticRows(n, seed = 20261003) {
    const r = rng(seed);
    const pick = (xs) => xs[Math.floor(r() * xs.length)];
    const rows = [];
    for (let i = 0; i < n; i++) {
        const make = pick(MAKES);
        const cc = pick([100, 110, 125, 150, 160, 180, 200, 220, 250, 300, 350, 390, 400, 450, 650]);
        const model = r() < 0.5 ? `${pick(STEMS)} ${cc}` : `${pick(STEMS)} ${pick(CODES)}${cc}`;
        const variant = `${pick(TRIMS)} ${2015 + Math.floor(r() * 12)}`;
        const title = `${make} ${model} ${variant}`;
        const aliases = [model, `${make} ${model.split(" ")[0]}`];
        rows.push({ id: `bench-${i}`, kind: r() < 0.02 ? "class_default" : "variant", title, aliases: aliases.join(" "),
            keywords: [...new Set([title, ...aliases].flatMap(keywordsFor))].join(" "), make });
    }
    return rows;
}

// Starts at two characters: shorter input isn't searched (search-keys.js MIN_QUERY_CHARS).
export const QUERIES = ["ka", "su", "he", "pu", "ro", "ya", "honda", "royal enfield", "classic 350", "ns200", "ns 200",
    "rtr 160", "mt15", "duke 390", "activa 125", "splendor", "pulsar ns", "ktm d", "bajaj dominar 400", "iqube",
    "hero splendor plus 2020", "special edition", "dual channel abs", "zzz", "450x"];

/**
 * @param {{ rows?: number, rounds?: number }} [opts]
 * @returns {{ rows: number, queries: number, p50: number, p95: number, p99: number, max: number, worst: string }}
 */
export function benchSearch(opts = {}) {
    const n = opts.rows ?? 20000, rounds = opts.rounds ?? 20;
    const db = new DatabaseSync(":memory:");
    db.exec(fs.readFileSync(path.join(ROOT, "lib/bikedb/schema.sql"), "utf8"));
    const ins = db.prepare("INSERT INTO bike_search (bundle_id, kind, title, aliases, keywords, make) VALUES (?, ?, ?, ?, ?, ?)");
    db.exec("BEGIN");
    for (const x of syntheticRows(n)) ins.run(x.id, x.kind, x.title, x.aliases, x.keywords, x.make);
    db.exec("COMMIT");
    db.exec("INSERT INTO bike_search (bike_search) VALUES ('optimize')");
    const search = makeSearch(db);
    for (const q of QUERIES) search(q); // warm the page cache
    const times = [];
    let worst = { ms: 0, q: "" };
    for (let k = 0; k < rounds; k++) {
        for (const q of QUERIES) {
            const t0 = performance.now();
            search(q, 20);
            const ms = performance.now() - t0;
            times.push(ms);
            if (ms > worst.ms) worst = { ms, q };
        }
    }
    db.close();
    times.sort((a, b) => a - b);
    const at = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
    return { rows: n, queries: times.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: times[times.length - 1], worst: worst.q };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const i = process.argv.indexOf("--rows");
    const s = benchSearch({ rows: i > 0 ? Number(process.argv[i + 1]) : 20000 });
    const f = (x) => `${x.toFixed(2)} ms`;
    console.log(`${s.rows} rows, ${s.queries} queries: p50 ${f(s.p50)}, p95 ${f(s.p95)}, p99 ${f(s.p99)}, max ${f(s.max)} ("${s.worst}")`);
    process.exit(s.p95 < 10 ? 0 : 1);
}
