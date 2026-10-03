// Opens a SQLite database with whichever driver this machine has
// (better-sqlite3, else node:sqlite). The implementation lives in
// lib/bikedb/sqlite.js so the server (CommonJS) and the build use the same code.
import { createRequire } from "node:module";

const lib = createRequire(import.meta.url)("../../lib/bikedb/sqlite.js");

/**
 * @typedef {import("../../lib/bikedb/sqlite.js").Statement} Statement
 * @typedef {import("../../lib/bikedb/sqlite.js").Db} Db
 */

/** @type {string[]} */
export const DRIVERS = lib.DRIVERS;
/** @type {typeof import("../../lib/bikedb/sqlite.js").loadDriver} */
export const loadDriver = lib.loadDriver;
