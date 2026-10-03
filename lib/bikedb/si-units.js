// @ts-check
"use strict";

/* ============================================================================
   MapUnite bike database — lib/bikedb/si-units.js
   ==============================================================================
   The source JSON (data/bikes/) is written in the units manufacturers publish
   (rpm, cm3, kW, kWh, km/h, L ...) so a reviewer can compare it with the
   brochure. Everything compiled from it — bikes.sqlite, catalog.json and the
   per-bike bundles the physics runs on — is strict SI. This table is the one
   place that conversion happens. Every factor follows from the definition of
   the units (1 rpm = 2π/60 rad/s, 1 kWh = 3.6 MJ ...); nothing is empirical.

   An affine unit (°C) would need an offset; none is used, and toSI() refuses
   any unit not listed, so a new unit in the contract fails the build instead
   of slipping through unconverted.
   ============================================================================ */

const RAD_PER_S_PER_RPM = (2 * Math.PI) / 60;
const RAD_PER_S_PER_KRPM = 1000 * RAD_PER_S_PER_RPM;

/**
 * source unit -> [SI unit, factor]: value_SI = value × factor.
 * @type {Readonly<Record<string, readonly [string, number]>>}
 */
const TO_SI = Object.freeze({
    "1": ["1", 1],
    "RON": ["1", 1],                 // octane number: a dimensionless index
    "kg": ["kg", 1],
    "V": ["V", 1],
    "m2": ["m2", 1],
    "N*m": ["N*m", 1],
    "mm": ["m", 1e-3],
    "km": ["m", 1e3],
    "cm3": ["m3", 1e-6],
    "L": ["m3", 1e-3],
    "kW": ["W", 1e3],
    "kWh": ["J", 3.6e6],
    "rpm": ["rad/s", RAD_PER_S_PER_RPM],
    "km/h": ["m/s", 1 / 3.6],
    "kPa": ["Pa", 1e3],
    // Friction MEP = A + B·n + C·n² with n in krpm. In SI, n becomes ω (rad/s):
    // B·n = B·(ω / ω_per_krpm) ⇒ B_SI = B·1e3 / ω_per_krpm, and likewise C with the square.
    "kPa/krpm": ["Pa/(rad/s)", 1e3 / RAD_PER_S_PER_KRPM],
    "kPa/krpm2": ["Pa/(rad/s)2", 1e3 / (RAD_PER_S_PER_KRPM * RAD_PER_S_PER_KRPM)],
    "MJ/L": ["J/m3", 1e9],
    "kg/L": ["kg/m3", 1e3]
});

/**
 * Converts a value (or array of values) from a source unit to SI.
 * @template {number | number[]} T
 * @param {T} value
 * @param {string} unit
 * @returns {{ value: T, unit: string }}
 */
function toSI(value, unit) {
    const entry = TO_SI[unit];
    if (!entry) throw new Error(`no SI conversion for unit "${unit}" — add it to lib/bikedb/si-units.js`);
    const [siUnit, k] = entry;
    const conv = (/** @type {number} */ x) => roundSig(x * k);
    return { value: /** @type {T} */ (Array.isArray(value) ? value.map(conv) : conv(/** @type {number} */ (value))), unit: siUnit };
}

/**
 * Rounds to 12 significant digits: removes binary noise from the
 * multiplication (0.1 × 1e3 = 100.00000000000001) so builds are
 * byte-for-byte repeatable, while keeping far more precision than any
 * published figure has.
 * @param {number} x
 */
function roundSig(x) {
    return x === 0 ? 0 : Number(x.toPrecision(12));
}

module.exports = { TO_SI, toSI, roundSig, RAD_PER_S_PER_RPM };
