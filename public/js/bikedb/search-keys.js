// @ts-check
"use strict";

/* ============================================================================
   MapUnite bike database — js/bikedb/search-keys.js
   ==============================================================================
   How bike names become search keys, and how a rider's typing becomes a
   query. One file so the SQLite FTS5 index (server), catalog.json's `search`
   column and the phone's offline index all agree.

   People type bike names many ways: "MT-15", "mt15", "mt 15"; "NS200",
   "ns 200"; "RTR 160 4V", "rtr160". The FTS5 tokenizer splits on punctuation
   ("MT-15" -> mt, 15) but can't join or split letters and digits, so the
   index carries extra keywords for both:
     - joined:  adjacent short tokens where one has a digit ("mt"+"15" -> mt15,
                "rtr"+"160"+"4v" -> rtr1604v)
     - split:   a token at its letter/digit boundaries ("ns200" -> ns, 200;
                "450x" -> 450, x)
   A query is then each typed token as a prefix term, all required.

   Runs in the browser (window.MUBikeSearchKeys) and in Node (require).
   ============================================================================ */

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module && module.exports) module.exports = api;
    else /** @type {any} */ (root).MUBikeSearchKeys = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
    // Fewer characters than this isn't a search: one letter matches a third of
    // a large catalog, and ranking that many rows is the only thing that can
    // push a query past the 10 ms budget (scripts/bikedb/bench-search.mjs).
    const MIN_QUERY_CHARS = 2;
    const MAX_QUERY_TOKENS = 8;
    const MAX_TOKEN_LENGTH = 32;
    const JOIN_MAX_TOKEN = 6;   // only short tokens are joined: model codes, not words

    /**
     * Lower-cases, strips diacritics and splits on anything that isn't a
     * letter or digit.
     * @param {string} text
     * @returns {string[]}
     */
    function tokens(text) {
        return String(text)
            .normalize("NFKD")
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean);
    }

    const hasDigit = (/** @type {string} */ t) => /[0-9]/.test(t);
    const isNumber = (/** @type {string} */ t) => /^[0-9]+$/.test(t);

    /**
     * Would a rider type these two tokens run together? Only model-code
     * pieces: a short letter prefix before digits ("mt"+"15", "rtr"+"160"),
     * digits before a short suffix or another code ("450"+"x", "160"+"4v").
     * Not words: "2.0 STD" must not become "0std".
     * @param {string} a @param {string} b
     */
    function joinable(a, b) {
        if (a.length > JOIN_MAX_TOKEN || b.length > JOIN_MAX_TOKEN) return false;
        if (!hasDigit(a) && !hasDigit(b)) return false;
        if (!hasDigit(a) && a.length > 4) return false;             // a word before a number: "update 2"
        if (!hasDigit(b) && b.length > 2) return false;              // a code before a word: "0 std", "4v dual"
        if (hasDigit(a) && hasDigit(b)) return isNumber(a) && !isNumber(b); // "160 4v" yes; "2 0", "450x 3" no
        return true;
    }

    /**
     * Extra keywords for one name (see the header): joined and split forms
     * the tokenizer can't produce on its own.
     * @param {string} text
     * @returns {string[]}
     */
    function keywordsFor(text) {
        const t = tokens(text);
        /** @type {Set<string>} */
        const out = new Set();
        for (let i = 0; i < t.length; i++) {
            // split "ns200" -> "ns", "200"
            const parts = t[i].match(/[a-z]+|[0-9]+/g) || [];
            if (parts.length > 1) for (const p of parts) out.add(p);
            // join runs of model-code pieces: mt+15, ns+200, 450+x, rtr+160+4v
            let joined = t[i];
            for (let j = i + 1; j < t.length && j < i + 3; j++) {
                if (!joinable(t[j - 1], t[j])) break;
                joined += t[j];
                out.add(joined);
            }
        }
        for (const x of t) out.delete(x); // already indexed as plain tokens
        return [...out].sort();
    }

    /**
     * All search text for a bike, as one normalised string: names, aliases and
     * the extra keywords. This is catalog.json's `search` column.
     * @param {string[]} names
     * @returns {string}
     */
    function searchText(names) {
        /** @type {Set<string>} */
        const all = new Set();
        for (const n of names) {
            for (const t of tokens(n)) all.add(t);
            for (const k of keywordsFor(n)) all.add(k);
        }
        return [...all].sort().join(" ");
    }

    /** @param {string} text */
    function queryTokens(text) {
        const t = tokens(text).slice(0, MAX_QUERY_TOKENS).map((x) => x.slice(0, MAX_TOKEN_LENGTH));
        return t.join("").length < MIN_QUERY_CHARS ? [] : t;
    }

    /**
     * Turns what the rider typed into an FTS5 MATCH expression: every token a
     * quoted prefix term, all required. Tokens are [a-z0-9] only, so nothing
     * the rider types can inject FTS5 syntax. Returns null when there is
     * nothing to search for yet (fewer than MIN_QUERY_CHARS letters/digits).
     * @param {string} text
     * @returns {string | null}
     */
    function ftsQuery(text) {
        const t = queryTokens(text);
        if (t.length === 0) return null;
        return t.map((x) => `"${x}"*`).join(" ");
    }

    /**
     * The same matching rule for the offline in-memory index: every typed token
     * must be a prefix of some word in the bike's search text.
     * @param {string} query
     * @param {string} searchTextOfBike  catalog.json `search` column
     */
    function matches(query, searchTextOfBike) {
        const t = queryTokens(query);
        if (t.length === 0) return false;
        const words = searchTextOfBike.split(" ");
        return t.every((q) => words.some((w) => w.startsWith(q)));
    }

    return Object.freeze({ MIN_QUERY_CHARS, tokens, keywordsFor, searchText, ftsQuery, matches });
});
