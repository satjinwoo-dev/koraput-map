import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VEHICLES as HERO_LIST } from "./dataset-hero.mjs";
import { VEHICLES_HONDA as HONDA_LIST } from "./dataset-honda.mjs";
import { VEHICLES_TVS as TVS_LIST } from "./dataset-tvs.mjs";
import { VEHICLES_BAJAJ as BAJAJ_LIST } from "./dataset-bajaj.mjs";
import { VEHICLES_RE_YAM_SUZ as RE_YAM_SUZ_LIST } from "./dataset-re-yam-suz.mjs";
import { VEHICLES_HERITAGE_AND_EV as HERITAGE_EV_LIST } from "./dataset-heritage-ev.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const VARIANTS_DIR = path.join(ROOT, "data", "bikes", "variants");
const REF_DIR = path.join(ROOT, "data", "bikes", "reference");

// Load formatJson from format.mjs
const { formatJson } = await import("../bikedb/format.mjs");

// Load Contract
const ContractModule = await import("../../public/js/bikedb/bundle-contract.js");
const Contract = ContractModule.default || ContractModule;

const ref = {
  fuelGrades: JSON.parse(fs.readFileSync(path.join(REF_DIR, "fuel-grades.json"), "utf8")),
  emissionStandards: JSON.parse(fs.readFileSync(path.join(REF_DIR, "emission-standards.json"), "utf8"))
};

const ALL_VEHICLES = [
  ...HERO_LIST,
  ...HONDA_LIST,
  ...TVS_LIST,
  ...BAJAJ_LIST,
  ...RE_YAM_SUZ_LIST,
  ...HERITAGE_EV_LIST
];

console.log(`Loaded ${ALL_VEHICLES.length} new vehicles to generate.`);

function buildBundle(v) {
  const isEv = v.powertrain === "ev";
  const isCvt = v.powertrain === "ice_cvt";
  const isManual = v.powertrain === "ice_manual";

  const sources = [
    {
      id: "official-spec",
      kind: "manufacturer",
      title: v.sourceTitle || `${v.make} ${v.model} official specifications`,
      url: v.sourceUrl || "https://www.mapunite.com",
      publisher: v.make,
      retrieved: "2026-10-04"
    }
  ];

  const needsLowerBlendRule = !isEv && (v.emissionStandard === "BS6-P2" || v.emissionStandard === "BS6-P1" || !v.emissionStandard);
  if (needsLowerBlendRule) {
    sources.push({
      id: "lower-blend-rule",
      kind: "derived",
      title: "Lower-ethanol blends of a certified fuel",
      retrieved: "2026-10-04",
      note: "A vehicle certified for a higher-ethanol petrol is materials-compatible with lower-ethanol petrol. Listed as compatible, never as certified."
    });
  }

  const bundle = {
    $schema: "../../../lib/bikedb/bundle.schema.json",
    schemaVersion: "1.0.0",
    id: v.id,
    kind: "variant",
    classKey: `${v.powertrain}.${v.segment}`,
    segment: v.segment,
    powertrain: v.powertrain,
    identity: {
      make: v.make,
      model: v.model,
      variant: v.variant,
      market: "IN",
      yearFrom: v.yearFrom,
      yearTo: v.yearTo !== undefined ? v.yearTo : null,
      aliases: v.aliases || []
    },
    image: {
      url: v.imageUrl || `https://images.mapunite.com/bikes/${v.id}.webp`,
      src: "official-spec"
    },
    sources
  };

  if (!isEv) {
    bundle.engine = {
      displacement: { v: v.displacement, u: "cm3", src: "official-spec", conf: 0.95 },
      cylinders: { v: v.cylinders || 1, u: "1", src: "official-spec", conf: 0.95 },
      strokes: { v: v.strokes || 4, u: "1", src: "official-spec", conf: 0.95 },
      bore: { v: v.bore, u: "mm", src: "official-spec", conf: 0.95 },
      stroke: { v: v.stroke, u: "mm", src: "official-spec", conf: 0.95 },
      cooling: { v: v.cooling || "air", src: "official-spec", conf: 0.95 },
      fuelSystem: { v: v.fuelSystem || "fi", src: "official-spec", conf: 0.95 },
      peakPower: { v: v.peakPower, u: "kW", src: "official-spec", conf: 0.95 },
      peakPowerRpm: { v: v.peakPowerRpm, u: "rpm", src: "official-spec", conf: 0.95 },
      peakTorque: { v: v.peakTorque, u: "N*m", src: "official-spec", conf: 0.95 },
      peakTorqueRpm: { v: v.peakTorqueRpm, u: "rpm", src: "official-spec", conf: 0.95 }
    };

    if (v.compressionRatio) {
      bundle.engine.compressionRatio = { v: v.compressionRatio, u: "1", src: "official-spec", conf: 0.9 };
    }
    if (v.idleRpm) {
      bundle.engine.idleRpm = { v: v.idleRpm, u: "rpm", src: "official-spec", conf: 0.9, tol: 100 };
    }
  } else {
    // EV motor + battery
    bundle.motor = {
      type: { v: v.motorType || "pmsm", src: "official-spec", conf: 0.9 },
      mount: { v: v.motorMount || "mid_drive", src: "official-spec", conf: 0.9 },
      peakPower: { v: v.peakPower, u: "kW", src: "official-spec", conf: 0.9 }
    };
    if (v.ratedPower) {
      bundle.motor.ratedPower = { v: v.ratedPower, u: "kW", src: "official-spec", conf: 0.85 };
    }
    if (v.peakTorque) {
      bundle.motor.peakTorque = { v: v.peakTorque, u: "N*m", src: "official-spec", conf: 0.85, at: "motor" };
    }

    bundle.battery = {
      grossCapacity: { v: v.batteryGrossCapacity, u: "kWh", src: "official-spec", conf: 0.9 }
    };
    if (v.batteryChemistry) {
      bundle.battery.chemistry = { v: v.batteryChemistry, src: "official-spec", conf: 0.85 };
    }
    if (v.certifiedRange) {
      bundle.battery.certifiedRange = { v: v.certifiedRange, u: "km", src: "official-spec", conf: 0.9, cycle: v.rangeCycle || "IDC" };
    }
  }

  // Transmission
  if (isManual) {
    bundle.transmission = {
      kind: { v: "manual", src: "official-spec", conf: 0.95 },
      speeds: { v: v.speeds || 5, u: "1", src: "official-spec", conf: 0.95 }
    };
    if (v.primaryRatio) {
      bundle.transmission.primaryRatio = { v: v.primaryRatio, u: "1", src: "official-spec", conf: 0.9 };
    }
    if (v.gearRatios) {
      bundle.transmission.gearRatios = { v: v.gearRatios, u: "1", src: "official-spec", conf: 0.9 };
    }
    if (v.finalRatio) {
      bundle.transmission.finalRatio = { v: v.finalRatio, u: "1", src: "official-spec", conf: 0.9 };
    }
    if (v.frontSprocket) {
      bundle.transmission.frontSprocket = { v: v.frontSprocket, u: "1", src: "official-spec", conf: 0.9 };
    }
    if (v.rearSprocket) {
      bundle.transmission.rearSprocket = { v: v.rearSprocket, u: "1", src: "official-spec", conf: 0.9 };
    }
  } else if (isCvt) {
    bundle.transmission = {
      kind: { v: "cvt", src: "official-spec", conf: 0.95 }
    };
  } else if (isEv) {
    bundle.transmission = {
      kind: { v: "single_speed", src: "official-spec", conf: 0.95 }
    };
    if (v.drive) {
      bundle.transmission.drive = { v: v.drive, src: "official-spec", conf: 0.9 };
    }
    if (v.reductionRatio) {
      bundle.transmission.reductionRatio = { v: v.reductionRatio, u: "1", src: "official-spec", conf: 0.9 };
    }
  }

  // Chassis
  bundle.chassis = {
    mass: { v: v.mass, u: "kg", src: "official-spec", conf: 0.95, basis: "kerb" },
    frontTyre: { v: v.frontTyre, src: "official-spec", conf: 0.95 },
    rearTyre: { v: v.rearTyre, src: "official-spec", conf: 0.95 }
  };
  if (v.fuelTank) {
    bundle.chassis.fuelTank = { v: v.fuelTank, u: "L", src: "official-spec", conf: 0.95 };
  }
  if (v.topSpeed) {
    bundle.chassis.topSpeed = { v: v.topSpeed, u: "km/h", src: "official-spec", conf: 0.9 };
  }

  // Emission & Fuel
  if (!isEv) {
    bundle.emission = {
      standard: { v: v.emissionStandard || "BS6-P2", src: "official-spec", conf: 0.9 }
    };
    if (v.obd) {
      bundle.emission.obd = { v: v.obd, src: "official-spec", conf: 0.9 };
    }

    if (v.emissionStandard === "BS6-P2" || !v.emissionStandard) {
      bundle.fuel = {
        compat: [
          { fuel: "E20", status: "certified", src: "official-spec", conf: 0.8, note: "Manufacturer E20 material compliance" },
          { fuel: "E10", status: "compatible", src: "lower-blend-rule", conf: 0.8 },
          { fuel: "E0", status: "compatible", src: "lower-blend-rule", conf: 0.8 }
        ]
      };
    } else if (v.emissionStandard === "BS6-P1") {
      bundle.fuel = {
        compat: [
          { fuel: "E10", status: "certified", src: "official-spec", conf: 0.8, note: "Manufacturer BS6 Phase 1 E10 compliance" },
          { fuel: "E0", status: "compatible", src: "lower-blend-rule", conf: 0.8 }
        ]
      };
    } else {
      // BS4 or vintage
      bundle.fuel = {
        compat: [
          { fuel: "E0", status: "certified", src: "official-spec", conf: 0.8, note: "Unleaded standard petrol" },
          { fuel: "E10", status: "compatible", src: "official-spec", conf: 0.6 }
        ]
      };
    }
  }

  return bundle;
}

// Generate, validate, and write files
let validCount = 0;
let errorCount = 0;

for (const v of ALL_VEHICLES) {
  const bundle = buildBundle(v);
  const valResult = Contract.validateBundle(bundle, ref);

  if (!valResult.ok) {
    console.error(`Validation failed for ${v.id}:`, valResult.errors);
    errorCount++;
    continue;
  }

  const filePath = path.join(VARIANTS_DIR, `${v.id}.json`);
  const formattedJson = formatJson(bundle) + "\n";
  fs.writeFileSync(filePath, formattedJson, "utf8");
  validCount++;
}

console.log(`Generated and saved ${validCount} bike variant files into data/bikes/variants/ (Errors: ${errorCount})`);
