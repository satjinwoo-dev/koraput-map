// @ts-check
"use strict";

/* ============================================================================
   MapUnite physics — js/physics/index.js
   ==============================================================================
   Node entry point: require("public/js/physics/index.js") gives every module.

   In the browser / app, load the modules as plain scripts in this order (each
   attaches itself to window.MUPhysics; nothing else is global):
     core.js, atmosphere.js, tyre.js, engine.js, roadload.js,
     profile.js, drive.js, uncertainty.js, cruise.js

   Typical use:
     const params  = profile.paramsFromBundle(bundle, { classDefault, rider });
     const vehicle = profile.compileVehicle(params);
     const rho     = atmosphere.airDensity({ altitude: 200, temperature: 305, relativeHumidity: 0.7 });
     const point   = drive.operatingPoint(vehicle, { speed: 13.9, grade: 0.02, rho });
     const table   = cruise.cruiseTableWithUncertainty(params, { rho });
   ============================================================================ */

module.exports = Object.freeze({
    core: require("./core.js"),
    atmosphere: require("./atmosphere.js"),
    tyre: require("./tyre.js"),
    engine: require("./engine.js"),
    roadload: require("./roadload.js"),
    profile: require("./profile.js"),
    drive: require("./drive.js"),
    uncertainty: require("./uncertainty.js"),
    cruise: require("./cruise.js")
});
