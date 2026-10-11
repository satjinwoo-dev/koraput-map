// Opens a SQLite database with whichever driver this machine has:
//   1. better-sqlite3 — the server's own dependency (same SQLite the server reads with);
//   2. node:sqlite    — built into Node 22.5+ (no install needed).
// Set BIKEDB_SQLITE_DRIVER=better-sqlite3 or BIKEDB_SQLITE_DRIVER=node:sqlite to force one.
//
// Both are wrapped in the same small synchronous interface, so the build and
// the tests don't care which one they got.
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Resolve from the repo root, so a node_modules in the repo (or any parent folder) is found.
const requireFromRoot = createRequire(path.join(ROOT, "package.json"));

export const DRIVERS = ["better-sqlite3", "node:sqlite"];

/**
 * @typedef {{ run: (...params: any[]) => any, all: (...params: any[]) => any[], get: (...params: any[]) => any }} Statement
 * @typedef {{ driver: string, sqliteVersion: string, exec: (sql: string) => void, prepare: (sql: string) => Statement, transaction: (fn: () => void) => void, close: () => void }} Db
 */

function loadBetterSqlite3() {
    const Database = requireFromRoot("better-sqlite3");
    return (file, { readonly = false } = {}) => {
        const db = new Database(file, { readonly, fileMustExist: readonly });
        return wrap("better-sqlite3", db, (sql) => db.prepare(sql));
    };
}

function loadNodeSqlite() {
    // node:sqlite prints an ExperimentalWarning on first load in Node 22; it's
    // expected here, so keep the build output clean.
    const emit = process.emitWarning;
    process.emitWarning = function (warning, ...rest) {
        const text = typeof warning === "string" ? warning : warning && warning.message;
        if (/SQLite/i.test(String(text))) return;
        return emit.call(process, warning, ...rest);
    };
    let mod;
    try { mod = requireFromRoot("node:sqlite"); } finally { process.emitWarning = emit; }
    return (file, { readonly = false } = {}) => {
        const db = new mod.DatabaseSync(file, { readOnly: readonly });
        return wrap("node:sqlite", db, (sql) => db.prepare(sql));
    };
}

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
            db.exec("BEGIN");
            try { fn(); db.exec("COMMIT"); }
            catch (e) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
        },
        close: () => db.close()
    };
}

/**
 * @param {{ driver?: string }} [opts]
 * @returns {{ name: string, open: (file: string, o?: { readonly?: boolean }) => Db }}
 */
export function loadDriver(opts = {}) {
    const wanted = opts.driver || process.env.BIKEDB_SQLITE_DRIVER || "";
    if (wanted && !DRIVERS.includes(wanted)) throw new Error(`unknown SQLite driver "${wanted}" (use ${DRIVERS.join(" or ")})`);
    const order = wanted ? [wanted] : DRIVERS;
    const failures = [];
    for (const name of order) {
        try {
            const open = name === "better-sqlite3" ? loadBetterSqlite3() : loadNodeSqlite();
            return { name, open };
        } catch (e) {
            failures.push(`${name}: ${String(e && e.message).split("\n")[0]}`);
        }
    }
    throw new Error([
        "no SQLite driver available to build bikes.sqlite:",
        ...failures.map((f) => `  - ${f}`),
        "Install the server's dependencies (npm install — better-sqlite3 is one of them), use Node 22.5 or newer,",
        "or build only catalog.json and the bundles with --skip-sqlite."
    ].join("\n"));
}
