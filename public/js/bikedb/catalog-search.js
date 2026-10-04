// @ts-check
/* ============================================================================
   MapUnite — bike catalogue search (shared by the app, the website and the server)
   ==============================================================================
   One tokeniser for both sides of the search, so they find the same bikes:
     - In the app and on the website, CatalogIndex searches catalog.json in
       memory. It works offline and needs no SQLite.
     - On the server, bikes.sqlite has an FTS5 table whose columns hold
       indexTokens() output, queried with toFtsQuery(queryTokens(q)).
   The two match exactly the same rows for any query (test/bikedb/search.test.mjs
   checks this), and rankResults() orders them the same way on both.

   Matching rules:
     - Case, accents and punctuation are ignored: "H'ness", "hness" and "h ness"
       all match; "Splendor+" matches "splendor plus".
     - Letters and digits are split: "mt15", "MT 15" and "MT-15" are the same,
       and so are "ns200" and "NS 200".
     - Every query word is a prefix ("roy enf hun" finds the Hunter), and every
       word must match (AND).
     - "cc" on its own is ignored ("350cc" means "350").
     - Latin script only; that's the script the catalogue's names are in.

   Runs unchanged in the browser (window.BikeCatalogSearch), the Android app and
   Node. No dependencies.
   ============================================================================ */

(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else /** @type {any} */ (root).BikeCatalogSearch = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const CATALOG_FORMAT = "mapunite-bike-catalog/1";
    /** The columns of catalog.json (one array each). */
    const CATALOG_COLUMNS = ["id", "make", "model", "variant", "market", "yearFrom", "yearTo", "class", "size", "aliases", "image_url", "bundle"];
    const MAX_QUERY_CHARS = 100;
    const MAX_QUERY_TOKENS = 8;
    const MAX_TOKEN_CHARS = 32;
    const DEFAULT_LIMIT = 20;
    const MAX_LIMIT = 200;
    /** Query words that carry no information on their own. */
    const STOPWORDS = ["cc"];
    /** Field order used everywhere: make, model, variant, aliases. Model names matter most. */
    const FIELD_WEIGHTS = [3, 4, 1, 3];

    // ------------------------------------------------------------------
    // Tokenising
    // ------------------------------------------------------------------
    const HAS_APOSTROPHE = /['\u2018\u2019\u02BC`\u00B4]/;
    const HAS_CAMEL = /[a-z][A-Z]|[A-Z][A-Z][a-z]/;
    const NON_ASCII = /[^\x00-\x7f]/;
    const isApostrophe = (c) => c === 39 || c === 96 || c === 0xB4 || c === 0x2018 || c === 0x2019 || c === 0x02BC;

    /**
     * Lower-case [a-z0-9] words, letters and digits split apart ("NS200" → ns, 200),
     * "+" read as "plus", accents removed, anything else a separator.
     * @param {string} text
     * @param {"join"|"space"} apostrophe  "join": H'ness → hness; "space": H'ness → h ness
     * @returns {string[]}
     */
    function words(text, apostrophe) {
        let t = String(text);
        if (NON_ASCII.test(t)) t = t.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
        /** @type {string[]} */
        const out = [];
        let cur = "";
        let prev = 0;                                   // 1 = letter, 2 = digit, 0 = separator
        const push = () => {
            if (cur) { out.push(cur.length > MAX_TOKEN_CHARS ? cur.slice(0, MAX_TOKEN_CHARS) : cur); cur = ""; }
        };
        for (let i = 0; i < t.length; i++) {
            let c = t.charCodeAt(i);
            if (c >= 65 && c <= 90) c += 32;            // A–Z → a–z
            if (c >= 97 && c <= 122) { if (prev === 2) push(); cur += String.fromCharCode(c); prev = 1; }
            else if (c >= 48 && c <= 57) { if (prev === 1) push(); cur += t[i]; prev = 2; }
            else if (c === 43) { push(); out.push("plus"); prev = 0; }
            else if (isApostrophe(c)) { if (apostrophe === "space") { push(); prev = 0; } }
            else { push(); prev = 0; }
        }
        push();
        return out;
    }

    /** "XPulse" → "X Pulse", "iQube" → "i Qube" (index side only: riders type lower case). */
    const camelSplit = (text) => String(text).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");

    /**
     * Tokens stored for a catalogue field. A superset of what any spelling of the
     * name produces in queryTokens(), so "H'ness", "hness", "h ness", "XPulse"
     * and "x pulse" all find their bike.
     * @param {string} text
     * @returns {string[]}
     */
    function indexTokens(text) {
        if (typeof text !== "string" || !text) return [];
        let all = words(text, "join");
        if (HAS_APOSTROPHE.test(text)) all = all.concat(words(text, "space"));
        if (HAS_CAMEL.test(text)) all = all.concat(words(camelSplit(text), "join"));
        return all.length < 2 ? all : [...new Set(all)];
    }

    /**
     * Words of a search query: normalised, stopwords removed, de-duplicated,
     * at most MAX_QUERY_TOKENS. An empty array means "no search".
     * @param {unknown} query
     * @returns {string[]}
     */
    function queryTokens(query) {
        if (typeof query !== "string") return [];
        const out = [];
        for (const w of words(query.slice(0, MAX_QUERY_CHARS), "join")) {
            if (STOPWORDS.includes(w) || out.includes(w)) continue;
            out.push(w);
            if (out.length === MAX_QUERY_TOKENS) break;
        }
        return out;
    }

    /**
     * FTS5 MATCH expression for queryTokens() output: every word as a prefix,
     * all required. Tokens are [a-z0-9] only, so quoting is enough to keep FTS5
     * keywords (AND, OR, NOT, NEAR) literal.
     * @param {string[]} tokens
     * @returns {string|null}  null when there is nothing to search for
     */
    function toFtsQuery(tokens) {
        if (!Array.isArray(tokens) || tokens.length === 0) return null;
        for (const t of tokens) if (typeof t !== "string" || !/^[a-z0-9]{1,32}$/.test(t)) throw new Error(`not a query token: ${JSON.stringify(t)}`);
        return tokens.map((t) => `"${t}"*`).join(" AND ");
    }

    /**
     * The four FTS5 column values for a catalogue row (make, model, variant, aliases).
     * @param {{ make: string, model: string, variant: string|null, aliases: string[] }} row
     * @returns {[string, string, string, string]}
     */
    function ftsColumns(row) {
        const f = rowFields(row);
        return [f[0].join(" "), f[1].join(" "), f[2].join(" "), f[3].join(" ")];
    }

    /**
     * Index tokens per field: make, model, variant, aliases.
     * @param {{ make: string, model: string, variant: string|null, aliases: string[] }} row
     * @param {Map<string, string[]>} [cache]  shared token cache (names repeat across trims)
     * @returns {string[][]}
     */
    function rowFields(row, cache) {
        const tok = cache instanceof Map ? (text) => {
            let t = cache.get(text);
            if (!t) cache.set(text, (t = indexTokens(text)));
            return t;
        } : indexTokens;
        return [tok(row.make), tok(row.model), tok(row.variant || ""), tok((row.aliases || []).join(" "))];
    }

    // ------------------------------------------------------------------
    // Ranking (shared, deterministic)
    // ------------------------------------------------------------------
    /**
     * Each query word scores its best match in the row: an exact word counts
     * twice a prefix, weighted by field (model 4, make 3, aliases 3, variant 1).
     * @param {string[][]} fields  rowFields() output
     * @param {string[]} tokens    queryTokens() output
     */
    function scoreRow(fields, tokens) {
        let total = 0;
        for (const q of tokens) {
            let best = 0;
            for (let f = 0; f < fields.length; f++) {
                const w = FIELD_WEIGHTS[f];
                for (const t of fields[f]) {
                    if (t === q) { if (2 * w > best) best = 2 * w; }
                    else if (w > best && t.startsWith(q)) best = w;
                }
            }
            total += best;
        }
        return total;
    }

    /**
     * Result order: score, then bikes on sale, then newer, then by name and id.
     * Plain code-unit comparison (no locale), so every device sorts the same.
     * @param {{ score: number, yearTo: number|null, yearFrom: number, title: string, id: string }} a
     * @param {{ score: number, yearTo: number|null, yearFrom: number, title: string, id: string }} b
     */
    function compareResults(a, b) {
        if (a.score !== b.score) return b.score - a.score;
        const sa = a.yearTo === null ? 1 : 0, sb = b.yearTo === null ? 1 : 0;
        if (sa !== sb) return sb - sa;
        if (a.yearFrom !== b.yearFrom) return b.yearFrom - a.yearFrom;
        if (a.title !== b.title) return a.title < b.title ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }

    /**
     * Score and order candidate rows (e.g. the server's FTS5 matches) exactly as
     * CatalogIndex.search() does.
     * @template {CatalogRow} R
     * @param {R[]} rows
     * @param {string[]} tokens
     * @param {number} [limit]
     * @returns {Array<R & { score: number }>}
     */
    function rankResults(rows, tokens, limit = DEFAULT_LIMIT) {
        const n = clampLimit(limit);
        return rows.map((r) => Object.assign({}, r, { score: scoreRow(rowFields(r), tokens) }))
            .sort(compareResults).slice(0, n);
    }

    const clampLimit = (limit) => {
        const n = Math.floor(Number(limit));
        return Number.isFinite(n) ? Math.min(MAX_LIMIT, Math.max(1, n)) : DEFAULT_LIMIT;
    };

    // ------------------------------------------------------------------
    // catalog.json
    // ------------------------------------------------------------------
    /** @typedef {{ key: string, powertrain: string, segment: string, title: string, image_url: string|null, bundle: string }} CatalogClass */
    /**
     * size is SI: displacement in m3 (petrol) or gross battery energy in J (EV).
     * image_url is an https picture for the picker, or null (show a class silhouette).
     * @typedef {{ id: string, make: string, model: string, variant: string|null, title: string, market: string, yearFrom: number, yearTo: number|null, classKey: string, powertrain: string, segment: string, size: number|null, sizeUnit: "m3"|"J", aliases: string[], image_url: string|null, bundle: string }} CatalogRow
     */

    /**
     * Check catalog.json's shape and turn its columns into row objects.
     * catalog.json is column-oriented (one array per field, `count` long):
     * similar values sit together, which compresses ~20 % better than rows.
     * @param {any} catalog  parsed catalog.json
     * @returns {{ version: string, schemaVersion: string, bundlePath: string, classes: CatalogClass[], rows: CatalogRow[] }}
     */
    function readCatalog(catalog) {
        const fail = (msg) => { throw new Error(`catalog.json: ${msg}`); };
        if (!catalog || typeof catalog !== "object") fail("not an object");
        if (typeof catalog.format !== "string" || !catalog.format.startsWith("mapunite-bike-catalog/")) fail(`unknown format ${JSON.stringify(catalog.format)}`);
        if (catalog.format !== CATALOG_FORMAT) fail(`format ${catalog.format} is newer than this app understands (${CATALOG_FORMAT}) — update the app`);
        if (catalog.units !== "SI") fail(`units must be "SI"`);
        if (typeof catalog.version !== "string" || typeof catalog.bundlePath !== "string" || !catalog.bundlePath.includes("{hash}")) fail("version and bundlePath are required");
        if (!Array.isArray(catalog.makes) || !Array.isArray(catalog.classes)) fail("makes and classes must be arrays");
        const cols = catalog.columns;
        const n = catalog.count;
        if (!cols || typeof cols !== "object" || !Number.isInteger(n) || n < 0) fail("columns and count are required");
        if (Object.keys(cols).sort().join() !== [...CATALOG_COLUMNS].sort().join()) fail(`columns must be exactly ${CATALOG_COLUMNS.join(", ")}`);
        for (const k of CATALOG_COLUMNS) if (!Array.isArray(cols[k]) || cols[k].length !== n) fail(`column ${k} must be an array of ${n} values`);
        /** @type {CatalogClass[]} */
        const classes = catalog.classes.map((c, i) => {
            if (!c || typeof c.key !== "string" || typeof c.bundle !== "string") fail(`classes[${i}] is malformed`);
            if (c.image_url !== null && typeof c.image_url !== "string") fail(`classes[${i}].image_url must be a string or null`);
            return { key: c.key, powertrain: c.powertrain, segment: c.segment, title: c.title, image_url: c.image_url, bundle: c.bundle };
        });
        /** @type {CatalogRow[]} */
        const rows = new Array(n);
        for (let i = 0; i < n; i++) {
            const make = catalog.makes[cols.make[i]];
            const cls = classes[cols.class[i]];
            const id = cols.id[i], model = cols.model[i], bundle = cols.bundle[i], aliases = cols.aliases[i], image = cols.image_url[i];
            if (typeof make !== "string" || !cls || typeof id !== "string" || typeof model !== "string" || typeof bundle !== "string" || !Array.isArray(aliases)
                || (image !== null && (typeof image !== "string" || !image.startsWith("https://")))) fail(`row ${i} is malformed`);
            const variant = cols.variant[i] === null ? null : String(cols.variant[i]);
            rows[i] = {
                id, make, model, variant,
                title: variant ? `${make} ${model} ${variant}` : `${make} ${model}`,
                market: cols.market[i], yearFrom: cols.yearFrom[i], yearTo: cols.yearTo[i],
                classKey: cls.key, powertrain: cls.powertrain, segment: cls.segment,
                size: cols.size[i], sizeUnit: cls.powertrain === "ev" ? "J" : "m3",
                aliases, image_url: image, bundle
            };
        }
        return { version: catalog.version, schemaVersion: catalog.schemaVersion, bundlePath: catalog.bundlePath, classes, rows };
    }

    /**
     * Picker label for a row's SI size: "349 cc" or "2.9 kWh". Display only;
     * everything else uses the SI number.
     * @param {{ size: number|null, sizeUnit: "m3"|"J" }} row
     */
    function formatSize(row) {
        if (typeof row.size !== "number") return "";
        return row.sizeUnit === "J" ? `${(Math.round(row.size / 3.6e5) / 10).toFixed(1)} kWh` : `${Math.round(row.size * 1e6)} cc`;
    }

    // ------------------------------------------------------------------
    // In-memory index (app + website, offline)
    // ------------------------------------------------------------------
    /** Sorted term list + posting lists; prefix lookups are two binary searches. */
    class CatalogIndex {
        /** @param {any} catalog  parsed catalog.json */
        constructor(catalog) {
            const c = readCatalog(catalog);
            this.version = c.version;
            this.schemaVersion = c.schemaVersion;
            this.bundlePath = c.bundlePath;
            /** @type {CatalogClass[]} */
            this.classes = c.classes;
            /** @type {CatalogRow[]} */
            this.rows = c.rows;
            /** @type {Map<string, number>} */
            this._byId = new Map(c.rows.map((r, i) => [r.id, i]));
            /** @type {Map<string, string[]>} */
            const cache = new Map();
            /** @type {string[][][]} */
            this._fields = c.rows.map((r) => rowFields(r, cache));
            /** @type {Map<string, number[]>} */
            const postings = new Map();
            this._fields.forEach((fields, row) => {
                for (const f of fields) for (const t of f) {
                    let list = postings.get(t);
                    if (!list) postings.set(t, (list = []));
                    if (list[list.length - 1] !== row) list.push(row);
                }
            });
            /** @type {string[]} */
            this._terms = [...postings.keys()].sort();
            /** @type {Int32Array[]} */
            this._postings = this._terms.map((t) => Int32Array.from(/** @type {number[]} */ (postings.get(t))));
            this._mark = new Int32Array(c.rows.length);
            this._gen = 0;
        }

        get size() { return this.rows.length; }

        /** @param {string} id */
        get(id) { const i = this._byId.get(id); return i === undefined ? null : this.rows[i]; }

        /** Relative URL of a bundle (resolve it against catalog.json's URL). @param {string} hash */
        bundleUrl(hash) { return this.bundlePath.replace("{hash}", hash); }

        /** First term ≥ s. @param {string} s */
        _lowerBound(s) {
            let lo = 0, hi = this._terms.length;
            while (lo < hi) { const mid = (lo + hi) >>> 1; if (this._terms[mid] < s) lo = mid + 1; else hi = mid; }
            return lo;
        }

        /**
         * Search the catalogue.
         * @param {unknown} query
         * @param {{ limit?: number }} [opts]
         * @returns {Array<CatalogRow & { score: number }>}
         */
        search(query, opts = {}) {
            const tokens = queryTokens(query);
            const limit = clampLimit(opts.limit === undefined ? DEFAULT_LIMIT : opts.limit);
            // Keep the best `limit` results (insertion into a short sorted list).
            /** @type {Array<CatalogRow & { score: number }>} */
            const top = [];
            for (const row of this._match(tokens)) {
                const r = Object.assign({}, this.rows[row], { score: scoreRow(this._fields[row], tokens) });
                if (top.length === limit && compareResults(r, top[top.length - 1]) >= 0) continue;
                let lo = 0, hi = top.length;
                while (lo < hi) { const mid = (lo + hi) >>> 1; if (compareResults(top[mid], r) <= 0) lo = mid + 1; else hi = mid; }
                top.splice(lo, 0, r);
                if (top.length > limit) top.pop();
            }
            return top;
        }

        /**
         * Ids of EVERY row the query matches, sorted (no ranking, no limit).
         * The server's FTS5 table must return exactly these.
         * @param {unknown} query
         * @returns {string[]}
         */
        matchIds(query) {
            return this._match(queryTokens(query)).map((row) => this.rows[row].id).sort();
        }

        /**
         * Rows matching every token as a prefix of some word in some field.
         * @param {string[]} tokens
         * @returns {number[]}
         */
        _match(tokens) {
            if (tokens.length === 0) return [];
            // Term ranges: tokens are [a-z0-9], and "{" sorts after "z", so q…q{ spans every term starting with q.
            const ranges = tokens.map((q) => [this._lowerBound(q), this._lowerBound(q + "{")]);
            const cost = ranges.map(([lo, hi]) => { let n = 0; for (let j = lo; j < hi; j++) n += this._postings[j].length; return n; });
            if (cost.some((n) => n === 0)) return [];
            const order = tokens.map((_, i) => i).sort((a, b) => cost[a] - cost[b] || a - b);   // rarest word first

            // mark[row] === base + k  ⇔  the row matched the first k words of `order` in this search.
            const step = MAX_QUERY_TOKENS + 1;
            if (this._gen >= Math.floor(0x7fffffff / step) - 1) { this._mark.fill(0); this._gen = 0; }
            const base = ++this._gen * step;
            const mark = this._mark;
            /** @type {number[]} */
            const hits = [];
            const last = order.length - 1;
            for (let k = 0; k <= last; k++) {
                const [lo, hi] = ranges[order[k]];
                for (let j = lo; j < hi; j++) {
                    const list = this._postings[j];
                    for (let p = 0; p < list.length; p++) {
                        const row = list[p];
                        if (k === 0 ? mark[row] < base : mark[row] === base + k) {
                            mark[row] = base + k + 1;
                            if (k === last) hits.push(row);
                        }
                    }
                }
            }
            return hits;
        }
    }

    return {
        CATALOG_FORMAT, CATALOG_COLUMNS, MAX_QUERY_CHARS, MAX_QUERY_TOKENS, MAX_TOKEN_CHARS, DEFAULT_LIMIT, MAX_LIMIT, STOPWORDS, FIELD_WEIGHTS,
        indexTokens, queryTokens, toFtsQuery, ftsColumns, rowFields, scoreRow, compareResults, rankResults, readCatalog, formatSize, CatalogIndex
    };
});
