// @ts-check
"use strict";
/* ============================================================================
   MapUnite RoadSense Live — official lists and model predictions (the server's feeds)
   ==============================================================================
   Two data layers that don't come from riders, merged into /api/master/roadsense/area
   with the riders' evidence and judged by the same rules (roadsense.js):

     official    a government list: MoRTH / NHAI roadworks, municipal closures,
                 SACHET CAP alerts. Verifies on its own, for as long as the list
                 says (validUntil), and always names itself (ref).
     prediction  a model's forecast, e.g. waterlogging risk from low-lying ground
                 (ISRO Bhuvan elevation) + a heavy-rain nowcast (IMD). Never
                 verifies, never counts as a rider, never clears anything: shown
                 and said as "predicted", apart from the evidence.

   Every item: { id, type, source, ref, lat, lng, t (published), validUntil, conf?, url?, detail? }.
   No item without a source name and an end time: a list that doesn't say how long
   something lasts can't be shown as current.

   What's here is the plumbing, not the data:
     - loadFeedDir(dir): GeoJSON FeatureCollections dropped in data/roadsense/feeds/
       (Points, or LineStrings sampled every 100 m), the format official lists can
       be converted into. No list ships with the app: none was found published with
       coordinates for this region (see data/roadsense/feeds/README.md).
     - createWaterloggingPredictor({ rule }): the rule's thresholds must be given
       (rain rate, how low-lying, the confidence, and their source). Without them
       it is OFF: no threshold is invented here.
   ============================================================================ */

const fs = require("fs");
const path = require("path");
const RS = require("../../public/js/master/roadsense/roadsense.js");

const ID_RE = /^[A-Za-z0-9_.:#-]{1,64}$/;
const M_PER_DEG = 111320;
const fin = (/** @type {any} */ v) => typeof v === "number" && Number.isFinite(v);
/** ISO text or ms → ms @param {any} v */
const time = (v) => (fin(v) ? v : typeof v === "string" && v ? Date.parse(v) : NaN);

/**
 * Check one feed item; bad ones are refused with a reason.
 * @param {any} it
 * @returns {{ ok: boolean, item: any, error: string|null }}
 */
function validateFeedItem(it) {
    const bad = (/** @type {string} */ error) => ({ ok: false, item: null, error });
    if (!it || typeof it !== "object") return bad("not an object");
    if (typeof it.id !== "string" || !ID_RE.test(it.id)) return bad("id is required");
    if (!RS.FEED_SOURCES.includes(it.source)) return bad(`source must be ${RS.FEED_SOURCES.join(" or ")}`);
    const t = time(it.t), until = time(it.validUntil);
    if (!fin(t)) return bad("t (published) is required");
    if (!fin(until) || until <= t) return bad("validUntil is required, after t");
    if (it.url !== undefined && it.url !== null && !(typeof it.url === "string" && /^https:\/\/\S{1,290}$/.test(it.url))) return bad("url must be https");
    if (it.detail !== undefined && it.detail !== null && !(typeof it.detail === "string" && it.detail.length <= 200)) return bad("detail ≤ 200 characters");
    const v = RS.validateObservation({ type: it.type, t, lat: it.lat, lng: it.lng, source: it.source, rider: "feed", present: true, conf: it.conf, ref: it.ref, validUntil: until, id: "feed-check" });
    if (!v.ok) return bad(/** @type {string} */ (v.error));
    return {
        ok: true, error: null,
        item: { id: it.id, type: it.type, source: it.source, ref: v.obs.ref, lat: Math.round(it.lat * 1e6) / 1e6, lng: Math.round(it.lng * 1e6) / 1e6, t, validUntil: until, conf: v.obs.conf, url: it.url || null, detail: it.detail || null }
    };
}

/**
 * A GeoJSON FeatureCollection → feed items. Points are one item; LineStrings (a closed stretch) are sampled every
 * 100 m (ids "<id>#<k>"). Properties: id, type, source, ref, published, valid_until, confidence?, url?, detail?
 * @param {any} fc
 */
function fromGeoJSON(fc) {
    /** @type {any[]} */ const items = [];
    /** @type {string[]} */ const errors = [];
    for (const [i, f] of (fc && Array.isArray(fc.features) ? fc.features : []).entries()) {
        const p = (f && f.properties) || {};
        const base = { id: p.id, type: p.type, source: p.source, ref: p.ref, t: p.published, validUntil: p.valid_until, conf: p.confidence, url: p.url, detail: p.detail };
        const g = f && f.geometry;
        /** @type {number[][]} */ let pts = [];
        if (g && g.type === "Point") pts = [g.coordinates];
        else if (g && g.type === "LineString" && Array.isArray(g.coordinates)) {
            const c = g.coordinates;
            for (let k = 0; k < c.length; k++) {
                pts.push(c[k]);
                const n = c[k + 1];
                if (!n) break;
                const d = Math.hypot((n[1] - c[k][1]) * M_PER_DEG, (n[0] - c[k][0]) * M_PER_DEG * Math.cos(c[k][1] * Math.PI / 180));
                for (let s = 100; s < d; s += 100) pts.push([c[k][0] + (n[0] - c[k][0]) * s / d, c[k][1] + (n[1] - c[k][1]) * s / d]);
            }
        } else { errors.push(`feature ${i}: Point or LineString only`); continue; }
        pts.forEach((xy, k) => {
            const v = validateFeedItem({ ...base, id: pts.length > 1 ? `${base.id}#${k}` : base.id, lng: xy[0], lat: xy[1] });
            if (v.ok) items.push(v.item); else if (errors.length < 50) errors.push(`feature ${i}: ${v.error}`);
        });
    }
    return { items, errors };
}

/** Every *.geojson in a folder (none → nothing; the folder is optional). @param {string} dir */
function loadFeedDir(dir) {
    /** @type {any[]} */ const items = [];
    /** @type {string[]} */ const errors = [];
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".geojson")); } catch { return { items, errors, files: 0 }; }
    for (const f of files) {
        try {
            const r = fromGeoJSON(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
            items.push(...r.items);
            errors.push(...r.errors.map((e) => `${f}: ${e}`));
        } catch (e) { errors.push(`${f}: ${(e && /** @type {any} */ (e).message) || e}`); }
    }
    return { items, errors, files: files.length };
}

/**
 * Waterlogging risk from low-lying ground + a rain nowcast. OFF unless every threshold is given, with its source:
 *   rule = { minRainMmPerHour, maxReliefM, conf, ref }   e.g. ref "IMD nowcast + ISRO Bhuvan CartoDEM"
 * predict({ cells: [{ lat, lng, reliefM }], nowcast: { mmPerHour, t, validUntil } }) → prediction items
 *   reliefM: how far the spot sits below its surroundings, from the elevation model (the caller computes it)
 * @param {{ rule?: { minRainMmPerHour?: number, maxReliefM?: number, conf?: number, ref?: string } }} [o]
 */
function createWaterloggingPredictor(o = {}) {
    const r = o.rule || {};
    const enabled = fin(r.minRainMmPerHour) && fin(r.maxReliefM) && fin(r.conf) && /** @type {number} */ (r.conf) > 0 && /** @type {number} */ (r.conf) <= 1 && typeof r.ref === "string" && r.ref.trim().length > 0;
    return {
        enabled,
        /** @param {{ cells: { lat: number, lng: number, reliefM: number }[], nowcast: { mmPerHour: number, t: number, validUntil: number } }} q */
        predict(q) {
            if (!enabled || !q || !q.nowcast || !fin(q.nowcast.mmPerHour) || q.nowcast.mmPerHour < /** @type {number} */ (r.minRainMmPerHour)) return [];
            /** @type {any[]} */ const out = [];
            for (const c of q.cells || []) {
                if (!fin(c.lat) || !fin(c.lng) || !fin(c.reliefM) || c.reliefM > /** @type {number} */ (r.maxReliefM)) continue;
                const v = validateFeedItem({
                    id: `wl-${Math.round(c.lat * 1e4)}-${Math.round(c.lng * 1e4)}-${Math.round(q.nowcast.t / 600000)}`, type: "waterlogging", source: "prediction",
                    ref: r.ref, lat: c.lat, lng: c.lng, t: q.nowcast.t, validUntil: q.nowcast.validUntil, conf: r.conf,
                    detail: `${q.nowcast.mmPerHour} mm/h nowcast; ${c.reliefM} m below surroundings`
                });
                if (v.ok) out.push(v.item);
            }
            return out;
        }
    };
}

module.exports = { validateFeedItem, fromGeoJSON, loadFeedDir, createWaterloggingPredictor };
