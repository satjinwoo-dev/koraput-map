// @ts-check
/* ============================================================================
   MapUnite curator — talking to the server (or working offline)
   ==============================================================================
   createCuratorApi({ base, token }) — the admin endpoints the curator expects
   (Step 5 server; all JSON, all behind `Authorization: Bearer <admin token>`):

     GET  /api/admin/bike-requests?status=queued|drafted|approved|rejected|duplicate|all
            → { requests: [{ id, description, classKey, createdAt, count, status, draft?, resolution? }] }
     GET  /api/admin/bikedb/reference        → { fuelGrades, emissionStandards }  (data/bikes/reference/*.json)
     PUT  /api/admin/bike-requests/:id/draft  { draft }                  → { ok }
     POST /api/admin/bike-requests/:id/approve { bundle }                → { ok, id, location: "variants"|"pending", errors?, warnings? }
            the server re-validates with scripts/bikedb/validate.mjs, writes data/bikes/<location>/<id>.json and rebuilds
     POST /api/admin/bike-requests/:id/reject  { reason }                → { ok }
     POST /api/admin/bike-requests/:id/duplicate { bikeId }              → { ok }

   createLocalApi(storage) — the same surface with no server: requests come from
   an imported JSON file, everything is kept in localStorage, and "approve" hands
   back the file to download and commit (the reviewable data/bikes workflow).
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUCurator || (/** @type {any} */ (root).MUCurator = {}); ns.api = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const STATUSES = ["queued", "drafted", "approved", "rejected", "duplicate"];

    /**
     * @param {{ base: string, token?: string|null, fetch?: typeof fetch, timeoutMs?: number }} o
     */
    function createCuratorApi(o) {
        const base = String(o.base || "").replace(/\/+$/, "");
        const doFetch = o.fetch || fetch.bind(globalThis);
        const timeoutMs = o.timeoutMs || 15000;
        async function req(method, path, body) {
            const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
            const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
            try {
                const res = await doFetch(`${base}${path}`, {
                    method, credentials: "same-origin", signal: ctl ? ctl.signal : undefined,
                    headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
                    body: body !== undefined ? JSON.stringify(body) : undefined
                });
                let json = null;
                try { json = await res.json(); } catch { json = null; }
                if (res.status === 401 || res.status === 403) throw Object.assign(new Error("The server didn't accept this admin token."), { status: res.status });
                if (!res.ok) throw Object.assign(new Error((json && (json.error || json.message)) || `Server error ${res.status}`), { status: res.status, body: json });
                return json || {};
            } catch (e) {
                if (/** @type {any} */ (e).name === "AbortError") throw new Error("The server took too long to answer.");
                throw e;
            } finally { if (t) clearTimeout(t); }
        }
        const enc = encodeURIComponent;
        return {
            mode: "server",
            list: (status = "all") => req("GET", `/api/admin/bike-requests?status=${enc(status)}`).then((j) => (Array.isArray(j.requests) ? j.requests : [])),
            reference: () => req("GET", "/api/admin/bikedb/reference"),
            saveDraft: (id, draft) => req("PUT", `/api/admin/bike-requests/${enc(id)}/draft`, { draft }),
            approve: (id, bundle) => req("POST", `/api/admin/bike-requests/${enc(id)}/approve`, { bundle }),
            reject: (id, reason) => req("POST", `/api/admin/bike-requests/${enc(id)}/reject`, { reason }),
            duplicate: (id, bikeId) => req("POST", `/api/admin/bike-requests/${enc(id)}/duplicate`, { bikeId })
        };
    }

    /**
     * Requests imported from a file (the app's outbox format or the server's), normalised.
     * Same description (case/spacing-insensitive) collapses into one request with a count.
     * @param {any} json
     */
    function normaliseRequests(json) {
        const list = Array.isArray(json) ? json : json && Array.isArray(json.requests) ? json.requests : [];
        const byKey = new Map();
        for (const r of list) {
            const description = String(r && (r.description || r.text) || "").replace(/\s+/g, " ").trim().slice(0, 200);
            if (description.length < 2) continue;
            const key = description.toLowerCase();
            const at = Number(r.createdAt || r.at) || Date.now();
            const cur = byKey.get(key);
            if (cur) { cur.count += Number(r.count) || 1; cur.createdAt = Math.min(cur.createdAt, at); if (!cur.classKey && r.classKey) cur.classKey = r.classKey; }
            else byKey.set(key, { id: String(r.id || `req-${key.replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`), description, classKey: r.classKey || null, createdAt: at, count: Number(r.count) || 1, status: STATUSES.includes(r.status) ? r.status : "queued" });
        }
        return [...byKey.values()].sort((a, b) => b.count - a.count || a.createdAt - b.createdAt);
    }

    /** @param {Storage|null} storage */
    function createLocalApi(storage) {
        const KEY = "mu.curator.local.v1";
        const read = () => { try { const o = JSON.parse((storage && storage.getItem(KEY)) || "{}"); return { requests: Array.isArray(o.requests) ? o.requests : [], ref: o.ref || null }; } catch { return { requests: [], ref: null }; } };
        const write = (o) => { try { if (storage) storage.setItem(KEY, JSON.stringify(o)); } catch { /* full */ } };
        const update = (id, patch) => { const o = read(); o.requests = o.requests.map((r) => (r.id === id ? { ...r, ...patch } : r)); write(o); return { ok: true }; };
        return {
            mode: "local",
            async list(status = "all") { const r = read().requests; return status === "all" ? r : r.filter((x) => x.status === status); },
            async reference() { const o = read(); if (!o.ref) throw new Error("No reference tables in offline mode: fuel and emission checks run when the file is validated."); return o.ref; },
            async saveDraft(id, draft) { return update(id, { status: "drafted", draft }); },
            async approve(id, bundle) { update(id, { status: "approved", resolution: bundle.id }); return { ok: true, id: bundle.id, location: "download" }; },
            async reject(id, reason) { return update(id, { status: "rejected", resolution: reason }); },
            async duplicate(id, bikeId) { return update(id, { status: "duplicate", resolution: bikeId }); },
            /** Import requests (and optionally reference tables) from a file's JSON. */
            importJson(json) {
                const o = read();
                const incoming = normaliseRequests(json);
                const byKey = new Map(o.requests.map((r) => [r.description.toLowerCase(), r]));
                for (const r of incoming) { const cur = byKey.get(r.description.toLowerCase()); if (cur) cur.count = Math.max(cur.count, r.count); else o.requests.push(r); }
                if (json && json.fuelGrades && json.emissionStandards) o.ref = { fuelGrades: json.fuelGrades, emissionStandards: json.emissionStandards };
                write(o);
                return incoming.length;
            }
        };
    }

    return { STATUSES, createCuratorApi, createLocalApi, normaliseRequests };
});
