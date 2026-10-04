// @ts-check
"use strict";
/* ============================================================================
   MapUnite bike catalogue — SQLite driver (shared by the build and the server)
   ==============================================================================
   Opens a SQLite database with whichever driver this machine has:
     1. better-sqlite3 — an optional dependency (a native addon: npm install
                         skips it when it can't be built or downloaded here);
     2. node:sqlite    — built into Node 22.13+ / 23.4+ (no install needed).
   Set BIKEDB_SQLITE_DRIVER=better-sqlite3 or BIKEDB_SQLITE_DRIVER=node:sqlite
   to force one. The server's own database uses the same choice (lib/server-db.js).

   Both are wrapped in the same small synchronous interface, so the build
   (scripts/bikedb/sqlite-driver.mjs re-exports this file), the server and the
   tests don't care which one they got. Parameters are positional (`?`), which
   both drivers bind the same way.
   ============================================================================ */

const DRIVERS = ["better-sqlite3", "node:sqlite"];

/**
 * @typedef {{ run: (...params: any[]) => any, all: (...params: any[]) => any[], get: (...params: any[]) => any }} Statement
 * @typedef {{ driver: string, sqliteVersion: string, exec: (sql: string) => void, prepare: (sql: string) => Statement,
 *             transaction: (fn: () => void) => void, close: () => void }} Db
 * @typedef {(file: string, o?: { readonly?: boolean }) => Db} Opener
 */

/** @returns {Opener} */
function loadBetterSqlite3() {
    const Database = require("better-sqlite3");
    // require() succeeds even when the native addon is missing or was built for
    // another Node version; that only fails on the first open. Open once here so
    // the failure lands in loadDriver's fallback instead of crashing the caller.
    new Database(":memory:").close();
    return (file, { readonly = false } = {}) => {
        const db = new Database(file, { readonly, fileMustExist: readonly });
        return wrap("better-sqlite3", db, (sql) => db.prepare(sql));
    };
}

/**
 * require("node:sqlite") (Node 22.13+ / 23.4+) without its one-time ExperimentalWarning.
 * @returns {any}
 */
function requireNodeSqlite() {
    // node:sqlite prints an ExperimentalWarning on first load in Node 22; it's
    // expected here, so keep the output clean.
    const emit = process.emitWarning;
    process.emitWarning = /** @type {any} */ (function (/** @type {any} */ warning, /** @type {any[]} */ ...rest) {
        const text = typeof warning === "string" ? warning : warning && warning.message;
        if (/SQLite/i.test(String(text))) return;
        return /** @type {any} */ (emit).call(process, warning, ...rest);
    });
    /** @type {any} */
    let mod;
    try { mod = require("node:sqlite"); } finally { process.emitWarning = emit; }
    return mod;
}

/** @returns {Opener} */
function loadNodeSqlite() {
    const mod = requireNodeSqlite();
    return (file, { readonly = false } = {}) => {
        const db = new mod.DatabaseSync(file, { readOnly: readonly });
        return wrap("node:sqlite", db, (sql) => db.prepare(sql));
    };
}

/**
 * @param {string} driver
 * @param {{ exec: (sql: string) => any, close: () => any }} db
 * @param {(sql: string) => any} prepare
 * @returns {Db}
 */
function wrap(driver, db, prepare) {
    const version = prepare("SELECT sqlite_version() AS v").get().v;
    return {
        driver,
        sqliteVersion: version,
        exec: (sql) => { db.exec(sql); },
        prepare: (sql) => {
            const st = prepare(sql);
            return { run: (...p) => st.run(...p), all: (...p) => st.all(...p), get: (...p) => st.get(...p) };
        },
        transaction: (fn) => {
            db.exec("BEGIN IMMEDIATE");
            try { fn(); db.exec("COMMIT"); }
            catch (e) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
        },
        close: () => { db.close(); }
    };
}

/**
 * @param {{ driver?: string, purpose?: string }} [opts]  purpose: what the database is for, used in the error message
 * @returns {{ name: string, open: Opener }}
 */
function loadDriver(opts = {}) {
    const wanted = opts.driver || process.env.BIKEDB_SQLITE_DRIVER || "";
    if (wanted && !DRIVERS.includes(wanted)) throw new Error(`unknown SQLite driver "${wanted}" (use ${DRIVERS.join(" or ")})`);
    const order = wanted ? [wanted] : DRIVERS;
    /** @type {string[]} */
    const failures = [];
    for (const name of order) {
        try {
            const open = name === "better-sqlite3" ? loadBetterSqlite3() : loadNodeSqlite();
            return { name, open };
        } catch (e) {
            failures.push(`${name}: ${String(e && /** @type {any} */ (e).message).split("\n")[0]}`);
        }
    }
    throw new Error([
        `no SQLite driver available to ${opts.purpose || "build bikes.sqlite"}:`,
        ...failures.map((f) => `  - ${f}`),
        "Install the server's dependencies (npm install — better-sqlite3 is optional), use Node 22.13 or newer (node:sqlite),",
        "or build only catalog.json and the bundles with --skip-sqlite."
    ].join("\n"));
}

module.exports = { DRIVERS, loadDriver, requireNodeSqlite };
