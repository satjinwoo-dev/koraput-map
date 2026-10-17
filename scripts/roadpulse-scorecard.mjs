#!/usr/bin/env node
// The server-measurable part of the RoadPulse pilot scorecard (docs/roadpulse/PILOT-SCORECARD.md), from the server's
// database. Usage: node scripts/roadpulse-scorecard.mjs [path/to/mapunite.db]   (default: DB_PATH or data/mapunite.db)
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { openServerDatabase } = require("../lib/server-db.js");
const { createRoadsense } = require("../lib/master/roadsense.js");

const file = process.argv[2] || process.env.DB_PATH || "data/mapunite.db";
const { db } = openServerDatabase(file);
const rs = createRoadsense({ db: () => db, secret: () => "scorecard-reads-only" });
console.log(JSON.stringify(rs.scorecard(), null, 2));
