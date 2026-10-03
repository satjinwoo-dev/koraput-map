// @ts-check
"use strict";
/* ============================================================================
   MapUnite bike catalogue — the server's read-only view of bikes.sqlite
   ==============================================================================
   bikes.sqlite is a build output (scripts/build-bike-catalog.mjs). The server
   opens it READ-ONLY and answers two questions from it:
     - search: FTS5 finds the matching variants, then the shared ranking in
       public/js/bikedb/catalog-search.js orders them. Matching and ranking are
       the same code the app runs offline on catalog.json, so the server and
       the phone return the same bikes in the same order for any query
       (test/server/catalog-db.test.mjs checks this result for result).
     - bundles: the runtime bundle bytes exactly as written to
       public/bikedb/bundles/<hash>.json, by content hash or by bike id.

   Reliability:
     - The file is checked (application_id, user_version against
       lib/bikedb/schema.sql, catalogue format) before it is used.
     - A missing or unreadable file doesn't stop the server: calls throw a
       CatalogUnavailable error the HTTP layer turns into 503, and the file is
       looked for again later.
     - A rebuild replaces the file atomically (rename). At most every
       `reloadCheckMs` the file's identity is compared, and a new build is
       opened and swapped in without a restart. A broken new file is refused
       and the previous catalogue keeps serving.

   Search rows are cached per variant (the catalogue is immutable while open),
   so ranking costs one FTS5 query plus scoring.
   ============================================================================ */

const fs = require("fs");
const path = require("path");
const Search = require("../../public/js/bikedb/catalog-search.js");
const { loadDriver } = require("./sqlite.js");

/** "MUBK": identifies a MapUnite bike database (PRAGMA application_id). */
const APPLICATION_ID = 0x4D55424B;
/** The format this code reads: PRAGMA user_version in lib/bikedb/schema.sql. */
const DB_FORMAT = (() => {
    const m = /PRAGMA\s+user_version\s*=\s*(\d+)/i.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
    if (!m) throw new Error("lib/bikedb/schema.sql has no PRAGMA user_version");
    return Number(m[1]);
})();
const HASH_RE = /^[0-9a-f]{16}$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

class CatalogUnavailable extends Error {
    /** @param {"catalog-unavailable"|"catalog-incompatible"} reason @param {string} message */
    constructor(reason, message) {
        super(message);
        this.name = "CatalogUnavailable";
        this.reason = reason;
    }
}

/**
 * @typedef {NonNullable<ReturnType<InstanceType<typeof Search.CatalogIndex>["get"]>>} CatalogRow  a catalog.json row (CatalogIndex.get())
 * @typedef {{ row: CatalogRow, fields: string[][] }} CachedRow
 * @typedef {{ id: string, kind: "variant"|"class_default", hash: string, body: string }} BundleRecord
 * @typedef {{ available: boolean, reason: string|null, message: string|null, file: string, driver: string|null,
 *             catalogVersion: string|null, schemaVersion: string|null, variants: number, bundles: number, openedAt: number|null }} CatalogStatus
 */

class CatalogDb {
    /**
     * @param {{ file: string, driver?: { name: string, open: import("./sqlite.js").Opener }, reloadCheckMs?: number,
     *           now?: () => number, log?: { warn: (...a: any[]) => void, info?: (...a: any[]) => void } }} opts
     */
    constructor(opts) {
        if (!opts || typeof opts.file !== "string" || !opts.file) throw new TypeError("CatalogDb needs { file }");
        this.file = path.resolve(opts.file);
        this._driverOpt = opts.driver || null;
        this.reloadCheckMs = opts.reloadCheckMs === undefined ? 5000 : opts.reloadCheckMs;
        this._now = opts.now || Date.now;
        this._log = opts.log || console;
        /** @type {null | { db: import("./sqlite.js").Db, st: Record<string, import("./sqlite.js").Statement>, meta: Record<string, string>, variants: number, bundles: number, openedAt: number }} */
        this._open = null;
        /** @type {Map<number, CachedRow>} */
        this._rows = new Map();
        /** @type {CatalogUnavailable|null} */
        this._error = null;
        this._sig = "";
        this._checkedAt = -Infinity;
    }

    /** The SQLite driver, loaded on first use (so constructing never throws for a missing driver). */
    _driver() {
        if (!this._driverOpt) this._driverOpt = loadDriver({ purpose: "read bikes.sqlite" });
        return this._driverOpt;
    }

    /**
     * Make sure the newest valid build is open; throws CatalogUnavailable if none is.
     * Cheap: the file is only stat()ed every reloadCheckMs.
     */
    _ensure() {
        const now = this._now();
        if (now - this._checkedAt >= this.reloadCheckMs) {
            this._checkedAt = now;
            this._refresh();
        }
        if (!this._open) throw this._error || new CatalogUnavailable("catalog-unavailable", "bike catalogue not loaded");
        return this._open;
    }

    /** Force a check of the file now (e.g. after a deploy hook rebuilt it). */
    reload() {
        this._checkedAt = this._now();
        this._refresh();
        return this.status();
    }

    _refresh() {
        let sig;
        try {
            const s = fs.statSync(this.file);
            sig = `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`;
        } catch (e) {
            // Gone: keep serving what is open (its file handle still reads the old build).
            if (!this._open) this._error = new CatalogUnavailable("catalog-unavailable", `bike catalogue not found at ${this.file} — run npm run bikes:build`);
            return;
        }
        if (sig === this._sig) return;
        this._sig = sig;
        try {
            const next = this._openFile();
            const prev = this._open;
            this._open = next;
            this._rows = new Map();
            this._error = null;
            if (prev) { try { prev.db.close(); } catch { /* already closed */ } }
            if (this._log.info) this._log.info(`[bikes] catalogue ${next.meta.catalog_version} open: ${next.variants} variants, ${next.bundles} bundles (${next.db.driver})`);
        } catch (e) {
            const err = e instanceof CatalogUnavailable ? e : new CatalogUnavailable("catalog-unavailable", `can't open ${this.file}: ${/** @type {any} */ (e).message}`);
            if (this._open) this._log.warn(`[bikes] new catalogue refused, still serving ${this._open.meta.catalog_version}: ${err.message}`);
            else { this._error = err; this._log.warn(`[bikes] ${err.message}`); }
        }
    }

    _openFile() {
        const db = this._driver().open(this.file, { readonly: true });
        try {
            const one = (/** @type {string} */ sql) => { const r = db.prepare(sql).get(); return r ? Object.values(r)[0] : undefined; };
            const appId = Number(one("PRAGMA application_id"));
            const fmt = Number(one("PRAGMA user_version"));
            if (appId !== APPLICATION_ID) throw new CatalogUnavailable("catalog-incompatible", `${this.file} is not a MapUnite bike database (application_id ${appId})`);
            if (fmt !== DB_FORMAT) throw new CatalogUnavailable("catalog-incompatible", `${this.file} has database format ${fmt}, this server reads ${DB_FORMAT} — rebuild it with npm run bikes:build`);
            /** @type {Record<string, string>} */
            const meta = Object.fromEntries(db.prepare("SELECT key, value FROM meta").all().map((r) => [r.key, r.value]));
            if (meta.catalog_format !== Search.CATALOG_FORMAT) throw new CatalogUnavailable("catalog-incompatible", `${this.file} has catalogue format ${meta.catalog_format}, this server reads ${Search.CATALOG_FORMAT}`);
            if (!meta.catalog_version) throw new CatalogUnavailable("catalog-incompatible", `${this.file} has no catalogue version`);
            const st = {
                match: db.prepare("SELECT rowid AS id FROM bundle_search WHERE bundle_search MATCH ?"),
                rows: db.prepare(`SELECT v.bundle_id AS bundleId, v.slug, v.make, v.model, v.variant_name AS variant, v.market, v.year_from AS yearFrom,
                                         v.year_to AS yearTo, v.class_key AS classKey, v.powertrain, v.segment, v.hash, v.image_url AS imageUrl,
                                         v.displacement_m3 AS displacement, v.battery_gross_j AS battery,
                                         (SELECT json_group_array(alias) FROM (SELECT alias FROM alias a WHERE a.bundle_id = v.bundle_id ORDER BY ord)) AS aliases
                                  FROM v_variant v WHERE v.bundle_id IN (SELECT value FROM json_each(?))`),
                byHash: db.prepare("SELECT slug AS id, kind, hash, body FROM bundle WHERE hash = ?"),
                bySlug: db.prepare("SELECT slug AS id, kind, hash, body FROM bundle WHERE slug = ?"),
                classOf: db.prepare("SELECT b.slug AS id, b.class_key AS classKey, vc.powertrain FROM bundle b JOIN vehicle_class vc ON vc.class_key = b.class_key WHERE b.hash = ?"),
                classOfVariant: db.prepare("SELECT b.slug AS id, b.class_key AS classKey, vc.powertrain FROM bundle b JOIN vehicle_class vc ON vc.class_key = b.class_key WHERE b.slug = ? AND b.kind = 'variant'"),
                classOfDefault: db.prepare("SELECT b.slug AS id, b.class_key AS classKey, vc.powertrain FROM class_default cd JOIN bundle b ON b.bundle_id = cd.bundle_id JOIN vehicle_class vc ON vc.class_key = b.class_key WHERE b.class_key = ?"),
                fuels: db.prepare("SELECT code FROM fuel_grade ORDER BY ord")
            };
            const counts = db.prepare("SELECT count(*) AS bundles, sum(kind = 'variant') AS variants FROM bundle").get();
            return { db, st, meta, variants: Number(counts.variants) || 0, bundles: Number(counts.bundles) || 0, openedAt: this._now() };
        } catch (e) {
            try { db.close(); } catch { /* ignore */ }
            throw e;
        }
    }

    /** @returns {CatalogStatus} */
    status() {
        try { this._ensure(); } catch { /* reported below */ }
        const o = this._open;
        return {
            available: Boolean(o), reason: o ? null : this._error ? this._error.reason : "catalog-unavailable", message: o ? null : this._error ? this._error.message : null,
            file: this.file, driver: o ? o.db.driver : null,
            catalogVersion: o ? o.meta.catalog_version : null, schemaVersion: o ? o.meta.schema_version || null : null,
            variants: o ? o.variants : 0, bundles: o ? o.bundles : 0, openedAt: o ? o.openedAt : null
        };
    }

    /**
     * Search variants exactly like CatalogIndex.search() does on catalog.json.
     * @param {unknown} query
     * @param {{ limit?: number }} [opts]
     * @returns {{ catalogVersion: string, tokens: string[], total: number, results: Array<CatalogRow & { score: number }> }}
     */
    search(query, opts = {}) {
        const o = this._ensure();
        const tokens = Search.queryTokens(query);
        const limit = clampLimit(opts.limit);
        const fts = Search.toFtsQuery(tokens);
        if (fts === null) return { catalogVersion: o.meta.catalog_version, tokens, total: 0, results: [] };
        const ids = o.st.match.all(fts).map((r) => Number(r.id));
        const rows = this._cachedRows(o, ids);
        // Keep the best `limit` (insertion into a short sorted list), as CatalogIndex does.
        /** @type {Array<CatalogRow & { score: number }>} */
        const top = [];
        for (const c of rows) {
            const r = Object.assign({}, c.row, { score: Search.scoreRow(c.fields, tokens) });
            if (top.length === limit && Search.compareResults(r, top[top.length - 1]) >= 0) continue;
            let lo = 0, hi = top.length;
            while (lo < hi) { const mid = (lo + hi) >>> 1; if (Search.compareResults(top[mid], r) <= 0) lo = mid + 1; else hi = mid; }
            top.splice(lo, 0, r);
            if (top.length > limit) top.pop();
        }
        return { catalogVersion: o.meta.catalog_version, tokens, total: ids.length, results: top };
    }

    /**
     * Ids of EVERY variant a query matches, sorted: must equal CatalogIndex.matchIds().
     * @param {unknown} query
     */
    matchIds(query) {
        const o = this._ensure();
        const fts = Search.toFtsQuery(Search.queryTokens(query));
        if (fts === null) return [];
        return this._cachedRows(o, o.st.match.all(fts).map((r) => Number(r.id))).map((c) => c.row.id).sort();
    }

    /**
     * @param {NonNullable<CatalogDb["_open"]>} o
     * @param {number[]} ids
     * @returns {CachedRow[]}
     */
    _cachedRows(o, ids) {
        const missing = ids.filter((id) => !this._rows.has(id));
        if (missing.length) {
            for (const r of o.st.rows.all(JSON.stringify(missing))) {
                const ev = r.powertrain === "ev";
                /** @type {CatalogRow} */
                const row = {
                    id: r.slug, make: r.make, model: r.model, variant: r.variant === null ? null : String(r.variant),
                    title: r.variant ? `${r.make} ${r.model} ${r.variant}` : `${r.make} ${r.model}`,
                    market: r.market, yearFrom: r.yearFrom, yearTo: r.yearTo === null ? null : r.yearTo,
                    classKey: r.classKey, powertrain: r.powertrain, segment: r.segment,
                    size: (ev ? r.battery : r.displacement) ?? null, sizeUnit: ev ? "J" : "m3",
                    aliases: JSON.parse(r.aliases), image_url: r.imageUrl === null ? null : r.imageUrl, bundle: r.hash
                };
                this._rows.set(Number(r.bundleId), { row, fields: Search.rowFields(row) });
            }
        }
        /** @type {CachedRow[]} */
        const out = [];
        for (const id of ids) {
            const c = this._rows.get(id);
            if (c) out.push(c);          // an FTS row without a variant row can't happen in a valid build; skip it rather than crash
        }
        return out;
    }

    /**
     * A runtime bundle by its content hash (16 hex) or its bike id (slug). Class defaults included.
     * @param {string} key
     * @returns {BundleRecord | null}
     */
    bundle(key) {
        const o = this._ensure();
        const r = HASH_RE.test(key) ? o.st.byHash.get(key) : SLUG_RE.test(key) ? o.st.bySlug.get(key) : undefined;
        return r ? { id: r.id, kind: r.kind, hash: r.hash, body: r.body } : null;
    }

    /** Class and powertrain of a bundle by hash (null when unknown). @param {string} hash */
    bundleClass(hash) {
        const o = this._ensure();
        const r = HASH_RE.test(hash) ? o.st.classOf.get(hash) : undefined;
        return r ? { bikeId: r.id, classKey: r.classKey, powertrain: r.powertrain } : null;
    }

    /**
     * The same, by the bike's stable id (a variant) or, for a typical bike, its class:
     * for records made with a bundle an older catalogue build shipped.
     * @param {string|null|undefined} bikeId @param {string|null|undefined} classKey
     * @returns {{ bikeId: string, classKey: string, powertrain: string } | null}
     */
    bikeClass(bikeId, classKey) {
        const o = this._ensure();
        let r;
        if (typeof bikeId === "string" && SLUG_RE.test(bikeId)) r = o.st.classOfVariant.get(bikeId);
        else if (bikeId == null && typeof classKey === "string" && classKey.length <= 40) r = o.st.classOfDefault.get(classKey);
        return r ? { bikeId: r.id, classKey: r.classKey, powertrain: r.powertrain } : null;
    }

    /** The fuel grade codes the catalogue knows (E0, E10 …). */
    fuelCodes() { return this._ensure().st.fuels.all().map((r) => r.code); }

    close() {
        if (this._open) { try { this._open.db.close(); } catch { /* ignore */ } }
        this._open = null;
        this._rows = new Map();
        this._sig = "";
        this._checkedAt = -Infinity;
    }
}

/** @param {unknown} limit */
function clampLimit(limit) {
    const n = Math.floor(Number(limit === undefined ? Search.DEFAULT_LIMIT : limit));
    return Number.isFinite(n) ? Math.min(Search.MAX_LIMIT, Math.max(1, n)) : Search.DEFAULT_LIMIT;
}

module.exports = { CatalogDb, CatalogUnavailable, APPLICATION_ID, DB_FORMAT, HASH_RE, SLUG_RE };
