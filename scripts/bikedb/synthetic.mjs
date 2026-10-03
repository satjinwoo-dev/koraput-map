// Deterministic synthetic catalogue for benchmarks and scale tests.
// Names are shaped like the real Indian catalogue (brand + model word + number +
// suffix, then trims such as "Disc", "Dual ABS", "2.9 kWh"), so the search index
// sees a realistic token distribution: many shared prefixes, short numbers, and
// letter-digit mixes like "NS200" and "4V".
import { shortHash } from "./catalog-build.mjs";

/** mulberry32: small, fast, seeded PRNG (same sequence on every machine). */
export function prng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const MAKES = ["Aprilia", "Ather", "Bajaj", "Benelli", "BMW", "BSA", "Ducati", "Hero", "Harley-Davidson", "Honda", "Husqvarna", "Hyosung",
    "Ampere", "Jawa", "Kawasaki", "Keeway", "Kinetic Green", "KTM", "Moto Guzzi", "MV Agusta", "Ola", "Okinawa", "Piaggio", "PURE EV",
    "QJ Motor", "Revolt", "Royal Enfield", "Simple Energy", "Suzuki", "Tork", "Triumph", "TVS", "Ultraviolette", "Vespa", "Yamaha",
    "Yezdi", "Zontes", "Matter", "Oben", "River", "Bounce", "Lectrix", "Odysse", "Joy e-bike", "Hop Electric", "Komaki", "Quantum",
    "Evolet", "Gemopai", "iVOOMi", "Raptee", "Orxa", "BattRE", "Detel", "Yulu", "Kabira", "Brisk", "Numeros", "Svitch", "Tunwal"];
const SYL = ["pul", "sar", "spl", "en", "dor", "hun", "ter", "cla", "ssic", "me", "te", "or", "ap", "ache", "rai", "der", "ju", "pi",
    "shi", "ne", "act", "iva", "dio", "acc", "ess", "bur", "gman", "ray", "fas", "cino", "nt", "orq", "xpu", "lse", "dom", "ina",
    "ave", "nger", "him", "ala", "yan", "scr", "am", "ble", "ron", "in", "nin", "ja", "duk", "adv", "ent", "ure", "chet", "ak", "iq", "ube"];
const SUFFIX = ["", "", "", "", " Pro", " S", " X", " N", " NS", " RS", " RTR", " XTEC", " 4V", " 2V", " Plus", "+", " Neo", " Max", " Sport", " Street"];
const TRIMS = ["Std", "Disc", "Drum", "Dual ABS", "Single-channel ABS", "Alloy", "Spoke", "Connected", "Bluetooth", "Matte Edition",
    "Dark Edition", "Racing Edition", "SmartXonnect", "Split Seat", "Single Seat", "Deluxe", "Premium", "Top", "Base", "Rally"];
const CLASSES = [
    ["ice_manual.commuter", 100, 160], ["ice_manual.naked", 125, 900], ["ice_manual.sport", 150, 1000], ["ice_manual.adventure", 200, 1300],
    ["ice_manual.cruiser", 300, 1800], ["ice_cvt.scooter", 100, 160], ["ice_cvt.maxi_scooter", 150, 400],
    ["ev.scooter", 1.5, 5], ["ev.commuter", 2, 6], ["ev.sport", 3, 12]
];

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const slug = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * @param {number} n     rows to generate
 * @param {number} [seed]
 * @returns {Array<{ id: string, make: string, model: string, variant: string|null, market: string, yearFrom: number, yearTo: number|null, classKey: string, size: number|null, aliases: string[], bundle: string }>}
 */
export function syntheticRows(n, seed = 20261003) {
    const rnd = prng(seed);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const rows = [];
    const ids = new Set();
    while (rows.length < n) {
        const make = pick(MAKES);
        const [classKey, lo, hi] = pick(CLASSES);
        const ev = classKey.startsWith("ev.");
        const word = cap(pick(SYL) + pick(SYL) + (rnd() < 0.4 ? pick(SYL) : ""));
        const num = ev ? String(Math.floor(rnd() * 900) + 100) : String(Math.round((lo + rnd() * (hi - lo)) / 5) * 5);
        const model = `${word}${rnd() < 0.3 ? "" : " "}${rnd() < 0.7 ? num : ""}${pick(SUFFIX)}`.trim().slice(0, 60);
        const trims = 1 + Math.floor(rnd() * 6);
        for (let t = 0; t < trims && rows.length < n; t++) {
            const yearFrom = 2015 + Math.floor(rnd() * 12);
            const yearTo = rnd() < 0.6 ? null : Math.min(2026, yearFrom + Math.floor(rnd() * 6));
            const size = ev ? Math.round((lo + rnd() * (hi - lo)) * 10) / 10 : Math.round(lo + rnd() * (hi - lo));
            const variant = ev ? `${size} kWh ${pick(TRIMS)}` : rnd() < 0.1 ? null : pick(TRIMS);
            let id = slug(`${make} ${model} ${variant || ""} ${yearFrom} in`);
            for (let k = 2; ids.has(id); k++) id = slug(`${make} ${model} ${variant || ""} ${yearFrom} ${k} in`);
            ids.add(id);
            const aliases = [`${make} ${word}`, ...(rnd() < 0.3 ? [`${word}${num}`] : [])].map((a) => a.slice(0, 60));
            const sizeSI = ev ? size * 3.6e6 : size / 1e6;          // kWh → J, cm3 → m3
            rows.push({ id, make, model, variant, market: "IN", yearFrom, yearTo, classKey, size: sizeSI, aliases, image_url: rnd() < 0.5 ? `https://img.example.com/bikes/${id}.webp` : null, bundle: shortHash(id) });
        }
    }
    return rows;
}

/** One fake class entry per class, in CLASS_MATRIX order. */
export function syntheticClasses() {
    return CLASSES.map(([key]) => {
        const [powertrain, segment] = key.split(".");
        return { key, powertrain, segment, title: `Generic ${segment}`, image_url: null, bundle: shortHash(key) };
    });
}

/**
 * Type-ahead queries a rider might type: prefixes of real names, make + model,
 * bare numbers, full names, and misses. Deterministic for a given row set.
 * Every query has at least 2 characters (the picker searches from the second keystroke).
 * @param {Array<{ make: string, model: string, variant: string|null }>} rows
 * @param {number} count
 */
export function syntheticQueries(rows, count, seed = 7) {
    const rnd = prng(seed);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const out = [];
    while (out.length < count) {
        const r = pick(rows);
        const firstModelWord = r.model.split(/\s+/)[0];
        const kind = Math.floor(rnd() * 7);
        let q;
        if (kind === 0) q = firstModelWord.slice(0, 2 + Math.floor(rnd() * Math.max(1, firstModelWord.length - 1)));
        else if (kind === 1) q = `${r.make} ${firstModelWord.slice(0, 3)}`;
        else if (kind === 2) q = r.model;
        else if (kind === 3) q = `${r.make} ${r.model} ${r.variant || ""}`.trim();
        else if (kind === 4) q = (r.model.match(/\d+/) || ["150"])[0];
        else if (kind === 5) q = r.make.slice(0, 2 + Math.floor(rnd() * 4));
        else q = `${firstModelWord.slice(0, 3)}zq ${Math.floor(rnd() * 999)}`;   // usually no match
        if (q.replace(/\s+/g, "").length >= 2) out.push(q);
    }
    return out;
}
