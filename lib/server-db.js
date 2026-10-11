// @ts-check
"use strict";
/* ============================================================================
   MapUnite — the server's own database (DB_PATH), on whichever SQLite this
   machine has
   ==============================================================================
   server.js was written against better-sqlite3. That's a native addon: on a
   machine where npm can neither download a prebuilt binary for this Node version
   nor compile one (no Python / C++ build tools), it isn't there, and the server
   used to crash on start. Now:

     1. better-sqlite3 when its addon loads (fastest; the database object is
        better-sqlite3's own, unchanged);
     2. else node:sqlite (built into Node 22.13+ / 23.4+), behind a small adapter
        with exactly the part of better-sqlite3's API the server uses:
          prepare(sql) → run / get / all       (node:sqlite's StatementSync has them)
          exec(sql), close()
          pragma("name = value") → rows
          transaction(fn) → a function that runs fn in BEGIN … COMMIT, rolls back
                            if it throws, and nests with SAVEPOINTs like better-sqlite3

   The same choice as the bike catalogue (lib/bikedb/sqlite.js), and the same
   override: BIKEDB_SQLITE_DRIVER=better-sqlite3 | node:sqlite. Both read and
   write the same SQLite file format, so switching drivers keeps the data.
   ============================================================================ */

const { DRIVERS, requireNodeSqlite } = require("./bikedb/sqlite.js");

/** better-sqlite3's API, as far as server.js uses it, on node:sqlite. */
class NodeSqliteDatabase {
    /** @param {any} raw  a node:sqlite DatabaseSync */
    constructor(raw) {
        this.raw = raw;
        this._depth = 0;
    }
    /** @param {string} sql */
    prepare(sql) { return this.raw.prepare(sql); }
    /** @param {string} sql */
    exec(sql) { this.raw.exec(sql); return this; }
    /** @param {string} source  e.g. "journal_mode = WAL" @returns {any[]} */
    pragma(source) { return this.raw.prepare(`PRAGMA ${source}`).all(); }
    /**
     * @template {(...args: any[]) => any} F
     * @param {F} fn @returns {F}
     */
    transaction(fn) {
        const self = this;
        return /** @type {any} */ (function (/** @type {any[]} */ ...args) {
            const depth = self._depth;
            const sp = `mu_tx_${depth}`;
            self.raw.exec(depth === 0 ? "BEGIN" : `SAVEPOINT ${sp}`);
            self._depth++;
            let result;
            try {
                result = fn.apply(this, args);
            } catch (e) {
                self._depth--;
                try { self.raw.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`); } catch { /* already rolled back */ }
                throw e;
            }
            self._depth--;
            try { self.raw.exec(depth === 0 ? "COMMIT" : `RELEASE ${sp}`); }
            catch (e) { if (depth === 0) { try { self.raw.exec("ROLLBACK"); } catch { /* nothing open */ } } throw e; }
            return result;
        });
    }
    close() { this.raw.close(); }
}

/**
 * Open (creating it if needed) the server's database.
 * @param {string} file
 * @param {{ driver?: string }} [opts]
 * @returns {{ driver: string, db: any }}
 */
function openServerDatabase(file, opts = {}) {
    const wanted = opts.driver || process.env.BIKEDB_SQLITE_DRIVER || "";
    if (wanted && !DRIVERS.includes(wanted)) throw new Error(`unknown SQLite driver "${wanted}" (use ${DRIVERS.join(" or ")})`);
    /** @type {string[]} */
    const failures = [];
    for (const name of wanted ? [wanted] : DRIVERS) {
        try {
            if (name === "better-sqlite3") {
                const Database = require("better-sqlite3");
                return { driver: name, db: new Database(file) };     // throws here when the native addon is missing
            }
            const { DatabaseSync } = requireNodeSqlite();
            return { driver: name, db: new NodeSqliteDatabase(new DatabaseSync(file)) };
        } catch (e) {
            failures.push(`${name}: ${String(e && /** @type {any} */ (e).message).split("\n")[0]}`);
        }
    }
    throw new Error([
        `no SQLite driver could open ${file}:`,
        ...failures.map((f) => `  - ${f}`),
        "Use Node 22.13 or newer (its built-in node:sqlite needs nothing installed), or install",
        "better-sqlite3's build tools and run npm rebuild better-sqlite3."
    ].join("\n"));
}

module.exports = { openServerDatabase, NodeSqliteDatabase };
