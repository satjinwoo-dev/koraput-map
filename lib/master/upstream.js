// @ts-check
"use strict";
/* ============================================================================
   MapUnite Master AI (server) — calling third-party APIs safely
   ==============================================================================
   createUpstream({ name, fetchImpl }) → { json(url, init, o), state() }

   - Every call has a hard timeout (AbortSignal), default 8 s.
   - Retries ONLY idempotent failures worth retrying (network error, 429, 502,
     503, 504), at most `retries` times, with jittered exponential back-off,
     honouring Retry-After up to 5 s. A 4xx is never retried.
   - CIRCUIT BREAKER: 5 consecutive failures open the circuit for 30 s (then
     60 s, 120 s … up to 10 min). While open, calls fail at once with
     code "CIRCUIT_OPEN" instead of piling 8-second timeouts onto every rider's
     request. One trial call is let through after the pause (half-open).
   - Errors carry { code, status } so routes can answer 502/503 precisely.
   - API keys are added by the caller into headers/URLs on the SERVER only;
     they never appear in an error message or a log line (urls are redacted).
   ============================================================================ */

class UpstreamError extends Error {
    /** @param {string} message @param {string} code @param {number} [status] */
    constructor(message, code, status) { super(message); this.code = code; this.status = status; }
}

const RETRYABLE = new Set([429, 502, 503, 504]);
/** Strip query strings (they may carry keys) from anything that could be logged. @param {string} url */
const redact = (url) => String(url).replace(/\?.*$/, "?…");

/**
 * @param {{
 *   name: string, fetchImpl?: typeof fetch, now?: () => number,
 *   sleep?: (ms: number) => Promise<void>, rng?: () => number,
 *   failuresToOpen?: number, openMs?: number, maxOpenMs?: number
 * }} o
 */
function createUpstream(o) {
    const fetchImpl = o.fetchImpl || globalThis.fetch;
    const now = o.now || (() => Date.now());
    const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const rng = o.rng || Math.random;
    const failuresToOpen = o.failuresToOpen ?? 5;
    const baseOpen = o.openMs ?? 30000, maxOpen = o.maxOpenMs ?? 600000;
    let failures = 0, openUntil = 0, opens = 0, halfOpenBusy = false;

    function noteFailure() {
        failures++;
        if (failures >= failuresToOpen) {
            openUntil = now() + Math.min(maxOpen, baseOpen * 2 ** opens);
            opens++;
            failures = 0;
        }
    }
    function noteSuccess() { failures = 0; opens = 0; openUntil = 0; }

    /**
     * @param {string} url
     * @param {RequestInit} [init]
     * @param {{ timeoutMs?: number, retries?: number, accept404?: boolean }} [c]
     * @returns {Promise<any>} parsed JSON (null for an accepted 404)
     */
    async function json(url, init = {}, c = {}) {
        const t = now();
        let trial = false;
        if (openUntil > t) throw new UpstreamError(`${o.name}: circuit open`, "CIRCUIT_OPEN", 503);
        if (opens > 0) {                                   // half-open: one trial call at a time
            if (halfOpenBusy) throw new UpstreamError(`${o.name}: circuit half-open`, "CIRCUIT_OPEN", 503);
            halfOpenBusy = true; trial = true;
        }
        const retries = c.retries ?? 1;
        const timeoutMs = c.timeoutMs ?? 8000;
        try {
            for (let attempt = 0; ; attempt++) {
                /** @type {Response|null} */ let res = null;
                try {
                    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
                } catch (e) {
                    if (attempt < retries) { await sleep(backoff(attempt, null)); continue; }
                    noteFailure();
                    const timedOut = e && (/** @type {any} */ (e).name === "TimeoutError" || /** @type {any} */ (e).name === "AbortError");
                    throw new UpstreamError(`${o.name}: ${timedOut ? "timed out" : "unreachable"} (${redact(url)})`, timedOut ? "TIMEOUT" : "UNREACHABLE", 502);
                }
                if (res.status === 404 && c.accept404) { noteSuccess(); return null; }
                if (!res.ok) {
                    if (RETRYABLE.has(res.status) && attempt < retries) { await sleep(backoff(attempt, res.headers.get("retry-after"))); continue; }
                    // a 4xx means OUR request is wrong (or the key is): the upstream itself is healthy
                    if (res.status >= 500 || res.status === 429) noteFailure(); else noteSuccess();
                    throw new UpstreamError(`${o.name}: HTTP ${res.status}`, res.status === 429 ? "RATE_LIMITED" : "HTTP_ERROR", res.status);
                }
                let body;
                try { body = await res.json(); } catch (e) { noteFailure(); throw new UpstreamError(`${o.name}: bad JSON`, "BAD_RESPONSE", 502); }
                noteSuccess();
                return body;
            }
        } finally { if (trial) halfOpenBusy = false; }
    }

    /** @param {number} attempt @param {string|null} retryAfter */
    function backoff(attempt, retryAfter) {
        const ra = Number(retryAfter);
        if (Number.isFinite(ra) && ra > 0) return Math.min(5000, ra * 1000);
        return Math.round((250 * 2 ** attempt) * (0.5 + rng()));
    }

    return {
        json,
        state: () => ({ name: o.name, open: openUntil > now(), openForMs: Math.max(0, openUntil - now()), failures })
    };
}

module.exports = { createUpstream, UpstreamError, redact };
