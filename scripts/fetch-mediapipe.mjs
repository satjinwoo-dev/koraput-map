#!/usr/bin/env node
/**
 * Puts the on-device face model for the fatigue check into public/vendor/mediapipe/,
 * so it works offline and inside the Android app (build-native copies public/ → www/).
 *
 *   node scripts/fetch-mediapipe.mjs
 *
 * Takes @mediapipe/tasks-vision from node_modules when it's installed
 * (npm install @mediapipe/tasks-vision@0.10.14), otherwise downloads it from
 * jsDelivr; the face_landmarker model always comes from Google's model bucket.
 * Without these files the app still works: js/master/vision/landmarker.js then
 * loads the same files from the CDN on the first check (needs a connection).
 *
 *   public/vendor/mediapipe/vision_bundle.mjs
 *   public/vendor/mediapipe/wasm/vision_wasm_internal.{js,wasm}
 *   public/vendor/mediapipe/wasm/vision_wasm_nosimd_internal.{js,wasm}
 *   public/vendor/mediapipe/face_landmarker.task          (~3.6 MB, float16)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.10.14";                                   // keep in step with js/master/vision/landmarker.js
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public", "vendor", "mediapipe");
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const FILES = ["vision_bundle.mjs", "wasm/vision_wasm_internal.js", "wasm/vision_wasm_internal.wasm", "wasm/vision_wasm_nosimd_internal.js", "wasm/vision_wasm_nosimd_internal.wasm"];

function fromNodeModules(rel) {
    let dir = ROOT;
    for (;;) {
        const p = path.join(dir, "node_modules", "@mediapipe", "tasks-vision", rel);
        if (fs.existsSync(p)) return p;
        const up = path.dirname(dir);
        if (up === dir) return null;
        dir = up;
    }
}
async function download(url, dest) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

fs.mkdirSync(path.join(OUT, "wasm"), { recursive: true });
for (const rel of FILES) {
    const dest = path.join(OUT, rel);
    const local = fromNodeModules(rel);
    if (local) { fs.copyFileSync(local, dest); console.log(`fetch-mediapipe: ${rel} ← node_modules`); continue; }
    await download(`${CDN}/${rel}`, dest);
    console.log(`fetch-mediapipe: ${rel} ← jsDelivr`);
}
const modelDest = path.join(OUT, "face_landmarker.task");
if (!fs.existsSync(modelDest)) { await download(MODEL, modelDest); console.log("fetch-mediapipe: face_landmarker.task ← Google"); }
else console.log("fetch-mediapipe: face_landmarker.task already there");
const size = FILES.concat("face_landmarker.task").reduce((a, f) => a + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`fetch-mediapipe: done, ${(size / 1e6).toFixed(1)} MB in public/vendor/mediapipe/ (MediaPipe Tasks Vision ${VERSION}, Apache-2.0)`);
