#!/usr/bin/env node
/*
 * Puts the on-phone person model into public/vendor/mediapipe/, so Ride Edit's
 * cut-outs (clones, ghosts, text behind the rider, 2.5D photos) work offline
 * and inside the Android app (build-native copies public/ into the app):
 *
 *   node scripts/fetch-mediapipe.mjs      (needs curl and tar; ~12 MB)
 *
 *   vision_bundle.mjs + wasm/   @mediapipe/tasks-vision 0.10.21 (Apache-2.0), from the npm registry
 *   selfie_segmenter.tflite     MediaPipe's selfie segmenter (Apache-2.0), from Google's model storage
 *
 * Without these files the page uses the CDN copy of the same version, when online.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public", "vendor", "mediapipe");
const VERSION = "0.10.21";
const MODEL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mu-mediapipe-"));
const curl = (url, file) => execFileSync("curl", ["-fsSL", "--retry", "3", "-o", file, url], { stdio: "inherit" });
try {
    const tgz = path.join(tmp, "tasks-vision.tgz");
    curl(`https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-${VERSION}.tgz`, tgz);
    execFileSync("tar", ["-xzf", tgz, "-C", tmp]);
    fs.mkdirSync(path.join(OUT, "wasm"), { recursive: true });
    fs.copyFileSync(path.join(tmp, "package", "vision_bundle.mjs"), path.join(OUT, "vision_bundle.mjs"));
    for (const f of fs.readdirSync(path.join(tmp, "package", "wasm"))) fs.copyFileSync(path.join(tmp, "package", "wasm", f), path.join(OUT, "wasm", f));
    curl(MODEL, path.join(OUT, "selfie_segmenter.tflite"));
    fs.writeFileSync(path.join(OUT, "VERSION"), `@mediapipe/tasks-vision ${VERSION}\nselfie_segmenter (float16, latest)\n`);
    const size = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
    console.log(`fetch-mediapipe: ${(size(OUT) / 1e6).toFixed(1)} MB in ${path.relative(ROOT, OUT)}/`);
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
