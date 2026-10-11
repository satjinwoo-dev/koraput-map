import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Search = require("../../public/js/bikedb/catalog-search.js");

const cat = JSON.parse(fs.readFileSync("public/bikedb/catalog.json", "utf8"));
const reader = Search.readCatalog(cat);
console.log("Total variants indexed:", reader.rows.length);

const makes = new Set(reader.rows.map(r => r.make));
console.log("Makes in database:", Array.from(makes).sort().join(", "));

const queries = [
  "splendor", "activa", "pulsar", "classic", "bullet", "himalayan",
  "ktm", "duke", "jawa", "yezdi", "chetak", "ola", "ather",
  "kinetic", "lml", "rx100", "rd350", "shogun", "dominar", "rayzr",
  "jupiter", "ntorq", "shine", "unicorn", "cb350", "ronin", "aerox"
];

const index = new Search.CatalogIndex(cat);

console.log("\n--- Sample Search Results ---");
for (const q of queries) {
  const res = index.search(q, { limit: 2 });
  const matches = res.map(r => `${r.make} ${r.model} [${r.id}]`).join(" | ");
  console.log(`Query "${q}" => ${matches || "NONE"}`);
}
