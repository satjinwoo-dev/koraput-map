// Saving and sharing files inside the Android app (js/passport/share-out.js): big files go to the plugin in pieces,
// "save" reaches the gallery, and Android 7–9 (save refused) fall back to the share sheet.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = fs.readFileSync(path.join(ROOT, "public/js/passport/share-out.js"), "utf8");

/** share-out.js in a sandbox with a stand-in MapUniteNative plugin. */
function load(plugin) {
    class FileReader {
        readAsDataURL(blob) { blob.arrayBuffer().then((b) => { this.result = `data:${blob.type};base64,${Buffer.from(b).toString("base64")}`; this.onload(); }); }
    }
    const win = { capacitorExports: plugin ? { Capacitor: { isNativePlatform: () => true }, registerPlugin: () => plugin } : null };
    const ctx = vm.createContext({ window: win, navigator: {}, Blob, FileReader, URL, document: null, setTimeout, console });
    vm.runInContext(`${SRC}\nwindow.MUShareOut = MUShareOut;`, ctx);
    return win.MUShareOut;
}
function fakePlugin({ saveRefused = false } = {}) {
    const files = new Map(), log = [];
    let n = 0;
    return {
        log, files,
        async fileOpen(o) { const id = `f${++n}`; files.set(id, { ...o, parts: [] }); log.push(["open", o.fileName, o.mimeType]); return { id }; },
        async fileWrite(o) { files.get(o.id).parts.push(Buffer.from(o.data, "base64")); log.push(["write", o.data.length]); },
        async fileClose(o) {
            log.push(["close", o.action]);
            if (o.action === "save" && saveRefused) { const e = new Error("saving needs Android 10 or newer"); e.code = "unsupported"; throw e; }
            return o.action === "save" ? { saved: true, where: "Movies/MapUnite" } : { shared: true };
        },
        async share() { log.push(["share-old"]); }
    };
}

test("a 2 MB video is saved to the gallery in ~384 KB pieces, byte for byte", async () => {
    const P = fakePlugin(), S = load(P);
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 1234); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 255;
    const r = await S.save({ blob: new Blob([bytes], { type: "video/mp4" }), fileName: "ride.mp4" });
    assert.equal(r.how, "saved");
    assert.equal(r.where, "Movies/MapUnite");
    assert.equal(S.said(r), "Saved to Movies/MapUnite on your phone.");
    const writes = P.log.filter((x) => x[0] === "write");
    assert.equal(writes.length, Math.ceil(bytes.length / (384 * 1024)));
    assert.ok(writes.every((w) => w[1] <= Math.ceil(384 * 1024 / 3) * 4), "each message stays ~512 KB of base64");
    const f = [...P.files.values()][0];
    assert.deepEqual(Buffer.concat(f.parts), bytes);
    assert.equal(f.mimeType, "video/mp4");
});

test("Android 7–9: saving is refused, so the share sheet opens instead", async () => {
    const P = fakePlugin({ saveRefused: true }), S = load(P);
    const r = await S.save({ blob: new Blob([Buffer.alloc(1000)], { type: "image/png" }), fileName: "card.png" });
    assert.equal(r.how, "native");
    assert.deepEqual(P.log.filter((x) => x[0] === "close").map((x) => x[1]), ["save", "share"]);
});

test("share sends the file in pieces too; the type comes from the name when the blob has none", async () => {
    const P = fakePlugin(), S = load(P);
    const r = await S.image({ blob: new Blob([Buffer.alloc(500000)]), fileName: "reel.webm", title: "My ride" });
    assert.equal(r.how, "native");
    assert.deepEqual(P.log[0], ["open", "reel.webm", "video/webm"]);
    assert.deepEqual(P.log[P.log.length - 1], ["close", "share"]);
});

test("an app built before fileOpen: an image still goes in one message", async () => {
    const P = fakePlugin(); delete P.fileOpen; P.fileOpen = async () => { throw new Error("not implemented"); };
    const S = load(P);
    const r = await S.image({ blob: new Blob([Buffer.alloc(1000)], { type: "image/png" }), fileName: "card.png" });
    assert.equal(r.how, "native");
    assert.ok(P.log.some((x) => x[0] === "share-old"));
});
