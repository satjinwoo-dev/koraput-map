// @ts-check
/* ============================================================================
   MapUnite physics core — entry point (strict SI, no dependencies, no DOM)
   ==============================================================================
   Node / tests:   const Physics = require("./public/js/physics/index.js");
   Browser / app:  load in this order, then use window.MUPhysics:
       atmosphere.js, tyre.js, powertrain.js, roadload.js, model.js, cruise.js, index.js

   Typical use (the bike picker has fetched the bike's bundle and its class default):
       const model = Physics.createBikeModel(bundle, { classDefault, settings: { riderMass: 78 } });
       const table = Physics.cruiseTable(model, { altitude: 920, temperature: 303.15 });
       table.eco  → { speedLow, speedHigh, speedBest, perMetreBest }   (m/s, m3/m or J/m)

   Every input and output is SI: m/s, rad/s, W, N, kg, m, m3, J, Pa, K.
   Unit conversion for display (km/h, rpm, km/L) belongs in the UI layer.
   ============================================================================ */

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory(require("./atmosphere.js"), require("./tyre.js"), require("./powertrain.js"), require("./roadload.js"), require("./model.js"), require("./cruise.js"));
    } else {
        const ns = /** @type {any} */ (root).MUPhysics;
        if (!ns || !ns.atmosphere || !ns.tyre || !ns.powertrain || !ns.roadload || !ns.model || !ns.cruise) throw new Error("MUPhysics: load atmosphere, tyre, powertrain, roadload, model and cruise before index.js");
        Object.assign(ns, factory(ns.atmosphere, ns.tyre, ns.powertrain, ns.roadload, ns.model, ns.cruise));
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function (
    /** @type {typeof import("./atmosphere.js")} */ atmosphere,
    /** @type {typeof import("./tyre.js")} */ tyre,
    /** @type {typeof import("./powertrain.js")} */ powertrain,
    /** @type {typeof import("./roadload.js")} */ roadload,
    /** @type {typeof import("./model.js")} */ model,
    /** @type {typeof import("./cruise.js")} */ cruise
) {
    "use strict";
    return {
        VERSION: "1.0.0",
        atmosphere, tyre, powertrain, roadload, model, cruise,
        // the everyday API
        airDensity: atmosphere.airDensity,
        airDensityAt: atmosphere.airDensityAt,
        standardAtmosphere: atmosphere.standardAtmosphere,
        wheelFromTyre: tyre.wheelFromTyre,
        buildTorqueCurve: powertrain.buildTorqueCurve,
        torqueAt: powertrain.torqueAt,
        powerAt: powertrain.powerAt,
        roadLoad: roadload.roadLoad,
        createBikeModel: model.createBikeModel,
        operatingPoint: cruise.operatingPoint,
        shiftPoints: cruise.shiftPoints,
        maxSpeed: cruise.maxSpeed,
        cruiseTable: cruise.cruiseTable
    };
});
