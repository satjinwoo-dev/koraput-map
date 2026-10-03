// @ts-check
"use strict";

/* ============================================================================
   MapUnite bike database — lib/bikedb/search.js
   ==============================================================================
   The one search query against bikes.sqlite's FTS5 table, for the build's
   self-test, the benchmark and the server (GET /api/bikes/search, step 5).
   Works with node:sqlite and better-sqlite3 alike (both: prepare().all()).

   Ranking: real variants before class defaults, then bm25 with column
   weights title 10 > aliases 6 > keywords 3 > make 2.
   ============================================================================ */

const { ftsQuery } = require("../../public/js/bikedb/search-keys.js");

const SEARCH_SQL = `
SELECT bundle_id AS id, kind, bm25(bike_search, 0.0, 0.0, 10.0, 6.0, 3.0, 2.0) AS score
FROM bike_search
WHERE bike_search MATCH ?
ORDER BY kind = 'class_default', score, bundle_id
LIMIT ?`;

const MAX_LIMIT = 50;

/**
 * @typedef {{ prepare(sql: string): { all(...params: any[]): any[] } }} SqliteDb
 */

/**
 * Prepares the search once; call the returned function per query.
 * @param {SqliteDb} db
 * @returns {(text: string, limit?: number) => Array<{ id: string, kind: string, score: number }>}
 */
function makeSearch(db) {
    const stmt = db.prepare(SEARCH_SQL);
    return (text, limit = 20) => {
        const q = ftsQuery(text);
        if (q === null) return [];
        const n = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(limit)) || 20));
        return stmt.all(q, n).map((r) => ({ id: String(r.id), kind: String(r.kind), score: Number(r.score) }));
    };
}

module.exports = { SEARCH_SQL, makeSearch };
