#!/usr/bin/env node
// Writes lib/bikedb/bundle.schema.json from the contract's FIELDS table.
//   node scripts/bikedb/gen-schema.mjs           # write
//   node scripts/bikedb/gen-schema.mjs --check   # exit 1 if the committed file is stale
import fs from "node:fs";
import path from "node:path";
import { ROOT, Contract } from "./load-catalog.mjs";

const out = path.join(ROOT, "lib", "bikedb", "bundle.schema.json");
const text = JSON.stringify(Contract.buildJsonSchema(), null, 2) + "\n";
if (process.argv.includes("--check")) {
    const cur = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
    if (cur !== text) { console.error("lib/bikedb/bundle.schema.json is stale — run: node scripts/bikedb/gen-schema.mjs"); process.exit(1); }
    console.log("bundle.schema.json is up to date");
} else {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text);
    console.log(`wrote ${path.relative(ROOT, out)} (${text.length} bytes)`);
}
