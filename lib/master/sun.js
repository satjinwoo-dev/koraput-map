// @ts-check
"use strict";
/* ============================================================================
   Solar elevation (NOAA's general solar position equations), pure, SI.
   Accurate to a fraction of a degree, which is all "is it dark when the rider
   arrives?" needs. elevationDeg(lat, lng, tMs) → degrees above the horizon.
     ≥ 0      day
     0 … −6   civil twilight (dusk: headlights on, depth perception drops)
     < −6     dark
   ============================================================================ */

const RAD = Math.PI / 180;

/** @param {number} lat @param {number} lng @param {number} tMs */
function elevationDeg(lat, lng, tMs) {
    const d = new Date(tMs);
    const start = Date.UTC(d.getUTCFullYear(), 0, 1);
    const doy = Math.floor((tMs - start) / 86400000);                 // 0-based day of year
    const hour = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    const g = (2 * Math.PI / 365) * (doy + (hour - 12) / 24);         // fractional year (rad)
    const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    const tst = hour * 60 + eqtime + 4 * lng;                         // true solar time (min)
    const ha = (tst / 4 - 180) * RAD;
    const cosZen = Math.sin(lat * RAD) * Math.sin(decl) + Math.cos(lat * RAD) * Math.cos(decl) * Math.cos(ha);
    return 90 - Math.acos(Math.max(-1, Math.min(1, cosZen))) / RAD;
}

/** @param {number} lat @param {number} lng @param {number} tMs @returns {"day"|"dusk"|"dark"} */
function light(lat, lng, tMs) {
    const e = elevationDeg(lat, lng, tMs);
    return e >= 0 ? "day" : e >= -6 ? "dusk" : "dark";
}

module.exports = { elevationDeg, light };
