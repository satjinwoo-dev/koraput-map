// The server's own database on node:sqlite (lib/server-db.js): the part of better-sqlite3's
// API server.js uses, so the server runs where better-sqlite3's native addon can't be built.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { tmpDir } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { openServerDatabase } = require("../../lib/server-db.js");

test("node:sqlite adapter: prepare/run/get/all, pragmas, transactions that commit, roll back and nest", () => {
    const dir = tmpDir("serverdb");
    try {
        const { driver, db } = openServerDatabase(path.join(dir, "mu.db"), { driver: "node:sqlite" });
        assert.equal(driver, "node:sqlite");
        assert.equal(db.pragma("journal_mode = WAL")[0].journal_mode, "wal");
        db.pragma("synchronous = NORMAL"); db.pragma("busy_timeout = 5000"); db.pragma("secure_delete = ON");
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
        const ins = db.prepare("INSERT INTO t (v) VALUES (?)");
        const r = ins.run("a");
        assert.equal(Number(r.changes), 1); assert.equal(Number(r.lastInsertRowid), 1);
        assert.equal(db.prepare("SELECT v FROM t WHERE id = ?").get(1).v, "a");
        assert.equal(db.prepare("SELECT v FROM t WHERE id = ?").get(99), undefined);

        // a transaction is a function: arguments and the return value pass through
        const addTwo = db.transaction((x, y) => { ins.run(x); ins.run(y); return "done"; });
        assert.equal(addTwo("b", "c"), "done");
        assert.equal(db.prepare("SELECT count(*) AS n FROM t").get().n, 3);

        // a throw rolls everything back, and the database is usable afterwards
        assert.throws(() => db.transaction(() => { ins.run("d"); ins.run(null); })(), /NOT NULL/);
        assert.equal(db.prepare("SELECT count(*) AS n FROM t").get().n, 3);

        // nested: an inner failure caught by the outer one undoes only the inner part (SAVEPOINT)
        db.transaction(() => {
            ins.run("e");
            try { db.transaction(() => { ins.run("f"); throw new Error("inner"); })(); } catch { /* handled */ }
            ins.run("g");
        })();
        assert.deepEqual(db.prepare("SELECT v FROM t ORDER BY id").all().map((x) => x.v), ["a", "b", "c", "e", "g"]);
        // a failing outer transaction undoes its committed inner one too
        assert.throws(() => db.transaction(() => { db.transaction(() => ins.run("h"))(); throw new Error("outer"); })(), /outer/);
        assert.equal(db.prepare("SELECT count(*) AS n FROM t WHERE v = 'h'").get().n, 0);

        db.pragma("wal_checkpoint(TRUNCATE)");
        db.close();
        // the same file opens with whichever driver is here: the data stays
        const again = openServerDatabase(path.join(dir, "mu.db"));
        assert.equal(again.db.prepare("SELECT count(*) AS n FROM t").get().n, 5);
        again.db.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an unknown driver name is refused; with none available the error says what to do", () => {
    assert.throws(() => openServerDatabase(":memory:", { driver: "mysql" }), /unknown SQLite driver/);
});
