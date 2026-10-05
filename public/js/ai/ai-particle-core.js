/*
  ai-particle-core.js : MapUnite AI Master, holographic humanoid core
  ==========================================================================
  A Three.js (r160+) ES module that renders, inside <canvas id="ai-master-core">:

    1. Outer shell : a humanoid bust (head, neck, shoulders) made of cyan/blue
                     light dust, drawn as stacked horizontal contour lines with
                     a bright rim. Comes from a .glb model (GLTFLoader, surface
                     sampled into THREE.Points) or, until one is supplied, from a
                     procedural signed-distance bust that is built in code.
    2. Inner core  : a dense orange/yellow particle sphere in the brain /
                     forehead area that throbs, swirls and spills warm light
                     onto the face around it.
    3. Extras      : rising aura dust above the head, golden energy veins down
                     the neck to a sternum node, faint concentric rings behind.

  Everything is additive-blended points on a transparent canvas. Particle
  sprites are radial gradients drawn on an offscreen <canvas>; no image files.

  Usage
  -----
    import { createAIMasterCore } from "./ai-particle-core.js";
    const core = createAIMasterCore(document.getElementById("ai-master-core"), {
      modelUrl: "./models/head.glb",          // optional; fallback shows until it loads
    });
    core.setMode("thinking");                 // idle | listening | thinking | speaking | alert
    core.setLevel(0.7);                       // 0..1 voice level while speaking
    core.pulse();                             // one shockwave from the brain
    await core.loadModel("./other.glb", { rotationY: Math.PI });

  Extending (the future Swarm Radar)
  ----------------------------------
    core.addLayer({
      object3D: radarGroup,                   // added to core.stage, centred on the bust
      update(ctx) { ... },                    // ctx: { time, dt, mode, level, camera, anchors, viewport }
      dispose() { ... }
    });
  core.anchors exposes the stage, the bust group, the brain group and the
  chest centre so orbiting nodes and link lines can attach to them.

  Import map needed by the page:
    "three":         ".../three@0.169.0/build/three.module.js"
    "three/addons/": ".../three@0.169.0/examples/jsm/"      (only for .glb loading)
*/

import * as THREE from "three";

/* ------------------------------------------------------------------------ */
/* 0. Palette, modes and shared shader code                                 */
/* ------------------------------------------------------------------------ */

export const COLORS = {
  cyan: new THREE.Color("#1fb4ff"),
  deep: new THREE.Color("#0a2fd8"),
  rim: new THREE.Color("#5fd0ff"),
  warm: new THREE.Color("#ff6a00"),
  hot: new THREE.Color("#ffb52e"),
  white: new THREE.Color("#ffe7a8"),
  gold: new THREE.Color("#ffb53a"),
  alert: new THREE.Color("#ff3b2e")
};

// bpm: brain throb rate; beat: throb depth; spin: brain swirl (rad/s);
// glow: brain brightness; ripple/drift: shell motion; scan: seconds between
// holographic scan sweeps (0 = never); alert: 0..1 red shift.
export const MODES = {
  idle:      { bpm: 54,  beat: 0.55, spin: 0.35, glow: 0.9,  ripple: 0.010, drift: 0.020, scan: 7.0, alert: 0 },
  listening: { bpm: 66,  beat: 0.65, spin: 0.55, glow: 1.0,  ripple: 0.016, drift: 0.024, scan: 4.0, alert: 0 },
  thinking:  { bpm: 104, beat: 0.85, spin: 1.35, glow: 1.25, ripple: 0.012, drift: 0.030, scan: 2.2, alert: 0 },
  speaking:  { bpm: 78,  beat: 0.7,  spin: 0.75, glow: 1.1,  ripple: 0.022, drift: 0.024, scan: 5.0, alert: 0 },
  alert:     { bpm: 128, beat: 1.0,  spin: 1.6,  glow: 1.35, ripple: 0.020, drift: 0.034, scan: 1.6, alert: 1 }
};

// Procedural bust bounds in model units (y up, face looking down +z).
export const BUST = {
  top: 1.33,
  bottom: -1.62,
  sliceStep: 0.045,                                  // spacing of the contour lines
  brain: new THREE.Vector3(0, 0.47, 0.18),           // centre of the inner core
  brainRadius: 0.3,
  chest: new THREE.Vector3(0, -0.15, 0)              // breathing centre / swarm orbit centre
};

const SIMPLEX = /* glsl */`
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+10.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.5-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 105.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

// Shared sprite fragment: the procedural glow texture tinted per particle.
const SPRITE_FRAG = /* glsl */`
uniform sampler2D uMap;
varying vec3 vColor; varying float vAlpha;
void main(){
  vec4 t = texture2D(uMap, gl_PointCoord);
  float a = t.a * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * t.rgb, a);
  #include <colorspace_fragment>
}`;

/* ------------------------------------------------------------------------ */
/* 1. Procedural glow texture (offscreen canvas, no PNGs)                   */
/* ------------------------------------------------------------------------ */

/**
 * A soft radial-gradient sprite. White by default so shaders tint it; pass
 * `stops` ([offset, cssColor][]) for a coloured one (e.g. halo sprites).
 */
export function createGlowTexture({ size = 128, stops } = {}) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  const s = stops || [
    [0.0, "rgba(255,255,255,1)"],
    [0.16, "rgba(255,255,255,0.85)"],
    [0.38, "rgba(255,255,255,0.32)"],
    [0.68, "rgba(255,255,255,0.07)"],
    [1.0, "rgba(255,255,255,0)"]
  ];
  for (const [o, col] of s) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/* ------------------------------------------------------------------------ */
/* 2. Procedural bust: a signed-distance humanoid, sliced into contours     */
/* ------------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
const ssub = (a, b, k) => -smin(-a, b, k);                       // a minus b, smooth
function ell(x, y, z, rx, ry, rz) {                               // ellipsoid (approximate SDF)
  const k0 = Math.hypot(x / rx, y / ry, z / rz);
  const k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  return k1 === 0 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
}
const sph = (x, y, z, r) => Math.hypot(x, y, z) - r;
function cap(px, py, pz, ax, ay, az, bx, by, bz, r) {             // capsule a→b
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const h = Math.min(1, Math.max(0, (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz)));
  return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - r;
}

/** Signed distance to the procedural bust (negative inside). */
export function bustSDF(x, y, z) {
  const ax = Math.abs(x);                                          // left/right symmetry
  // head
  let d = ell(x, y - 0.62, z + 0.04, 0.6, 0.7, 0.7);               // cranium
  d = smin(d, ell(x, y - 0.3, z - 0.14, 0.47, 0.56, 0.52), 0.18);  // face mass
  d = smin(d, ell(x, y - 0.02, z - 0.18, 0.38, 0.26, 0.36), 0.12); // jaw
  d = smin(d, sph(x, y + 0.1, z - 0.4, 0.13), 0.1);                // chin
  d = smin(d, sph(ax - 0.3, y - 0.36, z - 0.4, 0.14), 0.1);        // cheekbones
  d = smin(d, cap(x, y, z, -0.27, 0.56, 0.55, 0.27, 0.56, 0.55, 0.075), 0.08); // brow ridge
  d = ssub(d, sph(ax - 0.19, y - 0.45, z - 0.66, 0.085), 0.05);    // eye sockets
  d = smin(d, cap(x, y, z, 0, 0.5, 0.64, 0, 0.25, 0.76, 0.05), 0.06); // nose bridge
  d = smin(d, sph(x, y - 0.24, z - 0.74, 0.07), 0.04);             // nose tip
  d = smin(d, cap(x, y, z, -0.12, 0.08, 0.6, 0.12, 0.08, 0.6, 0.045), 0.04); // lips
  d = smin(d, ell(ax - 0.58, y - 0.42, z + 0.04, 0.07, 0.17, 0.11), 0.05);   // ears
  // neck and shoulders
  let b = cap(x, y, z, 0, 0.0, -0.06, 0, -0.95, -0.02, 0.28);      // neck
  let t = ell(x, y + 1.52, z + 0.02, 1.36, 0.42, 0.5);            // chest and shoulder mass
  t = smin(t, cap(ax, y, z, 0, -0.86, -0.06, 1.12, -1.24, -0.04, 0.2), 0.26); // trapezius sloping to the shoulder
  b = smin(b, t, 0.18);
  d = smin(d, b, 0.08);
  return Math.max(d, BUST.bottom - y);                             // flat cut under the chest
}

function sdfNormal(x, y, z, out, i) {
  const e = 0.004;
  const nx = bustSDF(x + e, y, z) - bustSDF(x - e, y, z);
  const ny = bustSDF(x, y + e, z) - bustSDF(x, y - e, z);
  const nz = bustSDF(x, y, z + e) - bustSDF(x, y, z - e);
  const l = Math.hypot(nx, ny, nz) || 1;
  out[i] = nx / l; out[i + 1] = ny / l; out[i + 2] = nz / l;
}

// Centre of a horizontal slice that is inside the body (the rays start there).
function sliceCentre(y) {
  for (const cz of [0.06, -0.05, 0.2, -0.2]) if (bustSDF(0, y, cz) < 0) return cz;
  return null;
}

// Distance from (0, y, cz) to the outer surface along the horizontal angle a
// (0 = +z), by sphere tracing inwards from outside the body.
function rayToSurface(y, cz, a) {
  const dx = Math.sin(a), dz = Math.cos(a);
  let r = 2.4;
  for (let i = 0; i < 80; i++) {
    const d = bustSDF(dx * r, y, cz + dz * r);
    if (Math.abs(d) < 0.0006) break;
    r -= d * 0.9;
    if (r <= 0) return 0;
  }
  return r;
}

/**
 * Builds the fallback bust as point data:
 *   ~82 % of the points sit on horizontal contour lines (the "Humano" look),
 *   the rest is a faint surface fill so the volume reads between lines.
 * Returns { positions, normals, kinds } (kind 0 = line, 1 = fill).
 */
export function generateProceduralBust(count, { seed = 7, lineRatio = 0.82, rays = 240 } = {}) {
  const rng = mulberry32(seed);
  const slices = [];
  for (let y = BUST.bottom + BUST.sliceStep * 0.5; y < BUST.top; y += BUST.sliceStep) {
    const cz = sliceCentre(y);
    if (cz === null) continue;
    const pts = new Float32Array(rays * 2);
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2;
      const r = rayToSurface(y, cz, a);
      pts[i * 2] = Math.sin(a) * r;
      pts[i * 2 + 1] = cz + Math.cos(a) * r;
    }
    const cum = new Float32Array(rays + 1);
    for (let i = 0; i < rays; i++) {
      const j = (i + 1) % rays;
      cum[i + 1] = cum[i] + Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]);
    }
    if (cum[rays] > 0.02) slices.push({ y, cz, pts, cum, len: cum[rays] });
  }
  const total = slices.reduce((s, sl) => s + sl.len, 0);

  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const kinds = new Float32Array(count);
  let n = 0;

  const pointOn = (sl, dist) => {                                  // point at arc length
    let lo = 0, hi = rays;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (sl.cum[m] <= dist) lo = m; else hi = m; }
    const seg = sl.cum[lo + 1] - sl.cum[lo] || 1;
    const f = (dist - sl.cum[lo]) / seg;
    const j = (lo + 1) % rays;
    return [sl.pts[lo * 2] + (sl.pts[j * 2] - sl.pts[lo * 2]) * f, sl.pts[lo * 2 + 1] + (sl.pts[j * 2 + 1] - sl.pts[lo * 2 + 1]) * f];
  };
  const push = (x, y, z, kind) => {
    positions[n * 3] = x; positions[n * 3 + 1] = y; positions[n * 3 + 2] = z;
    sdfNormal(x, y, z, normals, n * 3);
    kinds[n] = kind;
    n++;
  };

  // contour lines, spread along each ring by arc length
  const lineCount = Math.floor(count * lineRatio);
  for (const sl of slices) {
    const k = Math.round((lineCount * sl.len) / total);
    const step = sl.len / Math.max(k, 1);
    const off = rng() * step;
    for (let i = 0; i < k && n < lineCount; i++) {
      const [x, z] = pointOn(sl, (off + i * step + (rng() - 0.5) * step * 0.6) % sl.len);
      push(x, sl.y + (rng() - 0.5) * 0.004, z, 0);
    }
  }
  // surface fill, between the lines
  const sliceCdf = []; let acc = 0;
  for (const sl of slices) { acc += sl.len; sliceCdf.push(acc); }
  while (n < count) {
    const u = rng() * acc;
    let i = 0; while (sliceCdf[i] < u) i++;
    const sl = slices[i];
    const [x, z] = pointOn(sl, rng() * sl.len);                    // between this ring and the next
    push(x, sl.y + (rng() - 0.5) * BUST.sliceStep, z, 1);
  }
  return { positions, normals, kinds, source: "procedural" };
}

/** Seeds for the rising aura: points on the upper head / shoulders, with normals. */
function generateAuraSeeds(count, seed = 11) {
  const rng = mulberry32(seed);
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const onHead = rng() < 0.9;
    let y, a;
    if (onHead) { y = BUST.top - 0.02 - Math.pow(rng(), 1.5) * (BUST.top - 0.3); a = (rng() - 0.5) * Math.PI * 2; }
    else { y = -1.2 + rng() * 0.25; a = (rng() < 0.5 ? -1 : 1) * (Math.PI * 0.5 + (rng() - 0.5) * 0.9); }
    const cz = sliceCentre(y) ?? 0;
    const r = rayToSurface(y, cz, a);
    const x = Math.sin(a) * r, z = cz + Math.cos(a) * r;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    sdfNormal(x, y, z, nor, i * 3);
  }
  return { pos, nor };
}

/** Golden veins: curves from under the jaw down the neck into a sternum node. */
function generateVeins({ seed = 23, veins = 7, branches = 5, density = 190 } = {}) {
  const rng = mulberry32(seed);
  const sternumY = -1.12;
  const sternumZ = rayToSurface(sternumY, 0, 0) + 0.01;
  const out = []; // [x, y, z, t, seed]
  const surf = (y, a, lift = 0.008) => {
    const cz = sliceCentre(y) ?? 0;
    const r = rayToSurface(y, cz, a) + lift;
    return [Math.sin(a) * r, y, cz + Math.cos(a) * r];
  };
  const curve = (y0, y1, a0, a1, s0, s1, seedV, steps) => {
    const knots = Array.from({ length: 11 }, (_, i) => (i === 0 ? 0 : (rng() - 0.5) * 0.22)); // zig-zag offsets
    for (let i = 0; i <= steps; i++) {
      const s = i / steps;
      const y = y0 + (y1 - y0) * s;
      const kf = s * (knots.length - 1), ki = Math.min(knots.length - 2, Math.floor(kf));
      const zig = knots[ki] + (knots[ki + 1] - knots[ki]) * (kf - ki);
      const a = a0 + (a1 - a0) * Math.pow(s, 1.25) + zig * Math.sin(s * Math.PI);
      out.push(...surf(y, a), s0 + (s1 - s0) * s, seedV);
    }
  };
  const starts = [];
  for (let v = 0; v < veins; v++) {
    const a0 = (v / (veins - 1) - 0.5) * 1.9 + (rng() - 0.5) * 0.15;
    const y0 = -0.2 - rng() * 0.1;
    starts.push([y0, a0]);
    curve(y0, sternumY + 0.02, a0, (rng() - 0.5) * 0.08, 0, 1, rng(), density);
  }
  for (let b = 0; b < branches; b++) {                             // short forks off the main veins
    const [y0, a0] = starts[Math.floor(rng() * starts.length)];
    const s = 0.2 + rng() * 0.5;
    const yb = y0 + (sternumY - y0) * s;
    const ab = a0 * (1 - Math.pow(s, 1.25));
    curve(yb, yb - 0.12 - rng() * 0.18, ab, ab + (rng() < 0.5 ? -1 : 1) * (0.25 + rng() * 0.35), s, s + 0.25, rng(), Math.round(density * 0.3));
  }
  return { data: new Float32Array(out), node: new THREE.Vector3(0, sternumY, sternumZ) };
}

/* ------------------------------------------------------------------------ */
/* 3. GLB → points (GLTFLoader + area-weighted surface sampling)            */
/* ------------------------------------------------------------------------ */

let gltfLoaderPromise = null;
function getGLTFLoader() {
  // Lazy: the module runs without "three/addons/" until a model is requested.
  gltfLoaderPromise ||= import("three/addons/loaders/GLTFLoader.js").then((m) => new m.GLTFLoader());
  return gltfLoaderPromise;
}

/** Uniformly samples `count` points (and face normals) over every mesh in `root`. */
export function sampleMeshSurface(root, count, seed = 5) {
  root.updateMatrixWorld(true);
  const tris = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position;
    const idx = o.geometry.index;
    const nTri = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < nTri; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
      tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
  });
  const nTris = tris.length / 9;
  if (!nTris) throw new Error("The model has no triangle meshes.");
  const cum = new Float64Array(nTris);
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), cr = new THREE.Vector3();
  let total = 0;
  for (let t = 0; t < nTris; t++) {
    const o = t * 9;
    e1.set(tris[o + 3] - tris[o], tris[o + 4] - tris[o + 1], tris[o + 5] - tris[o + 2]);
    e2.set(tris[o + 6] - tris[o], tris[o + 7] - tris[o + 1], tris[o + 8] - tris[o + 2]);
    total += cr.crossVectors(e1, e2).length() * 0.5;
    cum[t] = total;
  }
  const rng = mulberry32(seed);
  const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = rng() * total;
    let lo = 0, hi = nTris - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < u) lo = m + 1; else hi = m; }
    const o = lo * 9;
    let r1 = rng(), r2 = rng();
    if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
    for (let k = 0; k < 3; k++) positions[i * 3 + k] = tris[o + k] + (tris[o + 3 + k] - tris[o + k]) * r1 + (tris[o + 6 + k] - tris[o + k]) * r2;
    e1.set(tris[o + 3] - tris[o], tris[o + 4] - tris[o + 1], tris[o + 5] - tris[o + 2]);
    e2.set(tris[o + 6] - tris[o], tris[o + 7] - tris[o + 1], tris[o + 8] - tris[o + 2]);
    cr.crossVectors(e1, e2).normalize();
    normals[i * 3] = cr.x; normals[i * 3 + 1] = cr.y; normals[i * 3 + 2] = cr.z;
  }
  return { positions, normals };
}

/**
 * Loads a .glb and converts it into the same point layout as the fallback:
 * centred, scaled into the bust bounds, normals pointing outwards, and most
 * points snapped onto the horizontal contour levels.
 *
 * modelOptions:
 *   fit        "bust" (head + shoulders, default) or "head" (head-only models)
 *   rotationY  radians, to turn a model that doesn't face +z
 *   scale      extra uniform scale after fitting (default 1)
 *   offset     [x, y, z] shift after fitting
 *   lineRatio  share of points snapped to contour lines (default 0.82)
 *   keepVeins  keep the golden neck veins on the model (default false: they fade out,
 *              because they follow the procedural neck)
 */
export async function loadBustFromGLB(url, count, modelOptions = {}) {
  const { fit = "bust", rotationY = 0, scale = 1, offset = [0, 0, 0], lineRatio = 0.82, seed = 5, onProgress } = modelOptions;
  const loader = await getGLTFLoader();
  const gltf = await loader.loadAsync(url, onProgress);
  const root = gltf.scene || gltf.scenes?.[0];
  if (!root) throw new Error("The .glb has no scene.");
  if (rotationY) root.rotation.y += rotationY;
  const { positions, normals } = sampleMeshSurface(root, count, seed);
  root.traverse((o) => { if (o.isMesh) { o.geometry?.dispose(); [].concat(o.material || []).forEach((m) => m.dispose?.()); } });

  // fit into the bust's bounds
  const box = new THREE.Box3().setFromArray(positions);
  const size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
  const top = BUST.top, bottom = fit === "head" ? -0.26 : BUST.bottom;
  const s = ((top - bottom) / (size.y || 1)) * scale;
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (positions[i * 3] - mid.x) * s + offset[0];
    positions[i * 3 + 1] = (positions[i * 3 + 1] - box.min.y) * s + bottom + offset[1];
    positions[i * 3 + 2] = (positions[i * 3 + 2] - mid.z) * s + offset[2];
  }
  // outward normals (relative to the vertical axis), contour snapping, kinds
  const rng = mulberry32(seed + 1);
  const kinds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
    const out = x * nx + z * nz + (y > BUST.top - 0.3 ? (y - (BUST.top - 0.6)) * ny : 0);
    if (out < 0) { normals[i * 3] = -nx; normals[i * 3 + 1] = -ny; normals[i * 3 + 2] = -nz; }
    if (rng() < lineRatio) {
      const k = Math.round((y - BUST.bottom - BUST.sliceStep * 0.5) / BUST.sliceStep);
      positions[i * 3 + 1] = BUST.bottom + BUST.sliceStep * 0.5 + k * BUST.sliceStep + (rng() - 0.5) * 0.004;
      kinds[i] = 0;
    } else kinds[i] = 1;
  }
  return { positions, normals, kinds, source: url };
}

/* ------------------------------------------------------------------------ */
/* 4. Layers                                                                */
/* ------------------------------------------------------------------------ */

const morphAt = (m, delay) => { const x = Math.min(1, Math.max(0, m * 1.6 - delay * 0.6)); return x * x * (3 - 2 * x); };

const HEAD_VERT = /* glsl */`
uniform float uTime, uMorph, uProj, uSize, uBoost;
uniform float uBreath, uRipple, uDrift, uScanY, uScan;
uniform vec3 uBrain; uniform float uBrainR, uBrainGlow, uAlert;
uniform float uShockR, uShockAmp, uBottom;
uniform vec3 uCyan, uDeep, uRim, uWarm, uHot, uRed;
attribute vec3 aFrom; attribute vec3 aNormal; attribute vec3 aNormalFrom;
attribute vec4 aRand;                    // x size jitter, y phase, z assembly delay, w kind (0 line, 1 fill)
varying vec3 vColor; varying float vAlpha;
${SIMPLEX}
float morphAt(float m, float d){ return smoothstep(0.0, 1.0, clamp(m * 1.6 - d * 0.6, 0.0, 1.0)); }
void main(){
  float k = morphAt(uMorph, aRand.z);
  vec3 p = mix(aFrom, position, k);
  vec3 n = normalize(mix(aNormalFrom, aNormal, k) + vec3(1e-5));
  float transit = 1.0 - k;
  float ph = aRand.y * 6.2831;
  p += transit * transit * 0.35 * vec3(sin(uTime * 1.3 + ph), cos(uTime * 1.1 + ph * 1.7), sin(uTime * 0.9 + ph * 2.3));

  // breathing about the chest, a ripple climbing the body, organic noise drift
  vec3 c = vec3(0.0, -0.15, 0.0);
  p = c + (p - c) * (1.0 + uBreath);
  float rip = sin(p.y * 10.0 - uTime * 2.4) * uRipple;
  float nz = snoise(p * 1.8 + vec3(0.0, uTime * 0.18, uTime * 0.07));
  p += n * (rip + nz * uDrift);
  p += vec3(sin(uTime * 0.7 + ph * 7.0), sin(uTime * 0.5 + ph * 3.0) * 0.3, cos(uTime * 0.6 + ph * 5.0)) * 0.005;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  vec3 nv = normalize(normalMatrix * n);
  float facing = dot(nv, normalize(-mv.xyz));
  float rim = pow(1.0 - abs(facing), 2.0);
  float back = facing < 0.0 ? 0.3 : 1.0;                       // far side dimmer
  float scan = exp(-pow((position.y - uScanY) * 9.0, 2.0)) * uScan;
  float d = distance(p, uBrain);
  float shock = exp(-pow((d - uShockR) * 9.0, 2.0)) * uShockAmp;
  vec3 wq = (p - (uBrain + vec3(0.0, 0.0, uBrainR * 1.1))) / vec3(1.25, 0.9, 1.0);      // spill reaches forward onto the face
  float warm = pow(clamp(1.0 - length(wq) / (uBrainR * 2.3), 0.0, 1.0), 1.3) * (0.65 + 0.35 * uBrainGlow);

  vec3 col = mix(uDeep, uCyan, 0.5 + 0.5 * rim);
  col = mix(col, uRim, clamp(rim * 0.35 + scan * 0.6 + shock * 0.5, 0.0, 1.0));
  vec3 hot = mix(mix(uWarm, uHot, warm), uRed, uAlert * 0.6);
  col = mix(col, hot, clamp(warm * 2.2, 0.0, 1.0));
  col = mix(col, mix(col, uWarm, 0.45), uAlert * 0.25);

  float line = 1.0 - aRand.w;
  float a = mix(0.07, 0.42, line) * (0.6 + 0.55 * rim) * back + scan * 0.55 + shock * 0.6;
  a += warm * 0.45;
  a *= mix(0.45, 1.0, k);
  a *= smoothstep(uBottom, uBottom + 0.42, p.y);               // fade out under the chest
  vColor = col;
  vAlpha = a * uBoost;
  float size = uSize * mix(0.75, 1.3, aRand.x) * mix(0.7, 1.0, line) * (1.0 + scan * 0.7 + rim * 0.35 + shock * 0.8);
  gl_PointSize = clamp(size * uProj / -mv.z, 1.0, 22.0);
}`;

/** The cyan contour-line shell. Morphs between point sets of equal size. */
function createHeadCloud(data, map, reduceMotion) {
  const count = data.kinds.length;
  const rng = mulberry32(3);
  const geo = new THREE.BufferGeometry();
  const rand = new Float32Array(count * 4);
  const from = new Float32Array(count * 3), fromN = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const y = data.positions[i * 3 + 1];
    rand[i * 4] = rng();
    rand[i * 4 + 1] = rng();
    rand[i * 4 + 2] = Math.min(1, ((y - BUST.bottom) / (BUST.top - BUST.bottom)) * 0.7 + rng() * 0.3); // assemble bottom-up
    rand[i * 4 + 3] = data.kinds[i];
    // intro: a loose swirl of dust around and below the bust
    const a = rng() * Math.PI * 2, r = 1.6 + rng() * 2.6;
    from[i * 3] = Math.cos(a) * r;
    from[i * 3 + 1] = -2.6 + rng() * 4.2;
    from[i * 3 + 2] = Math.sin(a) * r - 0.6;
    fromN[i * 3 + 1] = 1;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(data.positions.slice(), 3));
  geo.setAttribute("aNormal", new THREE.BufferAttribute(data.normals.slice(), 3));
  geo.setAttribute("aFrom", new THREE.BufferAttribute(from, 3));
  geo.setAttribute("aNormalFrom", new THREE.BufferAttribute(fromN, 3));
  geo.setAttribute("aRand", new THREE.BufferAttribute(rand, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -0.1, 0), 2.6);

  const uniforms = {
    uMap: { value: map }, uTime: { value: 0 }, uMorph: { value: reduceMotion ? 1 : 0 }, uProj: { value: 600 },
    uSize: { value: 0.016 }, uBoost: { value: 1 }, uBreath: { value: 0 }, uRipple: { value: 0.01 }, uDrift: { value: 0.02 },
    uScanY: { value: -9 }, uScan: { value: 0 }, uBrain: { value: BUST.brain.clone() }, uBrainR: { value: BUST.brainRadius },
    uBrainGlow: { value: 0.8 }, uAlert: { value: 0 }, uShockR: { value: -9 }, uShockAmp: { value: 0 }, uBottom: { value: BUST.bottom },
    uCyan: { value: COLORS.cyan }, uDeep: { value: COLORS.deep }, uRim: { value: COLORS.rim },
    uWarm: { value: COLORS.warm }, uHot: { value: COLORS.hot }, uRed: { value: COLORS.alert }
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: HEAD_VERT, fragmentShader: SPRITE_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  });
  const points = new THREE.Points(geo, mat);
  points.name = "head-shell";
  points.frustumCulled = false;

  let morphT = reduceMotion ? 1 : 0, morphDur = 3.4;
  return {
    points, uniforms, count,
    get morphing() { return morphT < 1; },
    /** Start morphing from what is on screen now to `next` (same count). */
    setTarget(next, duration = 2.6) {
      const P = geo.attributes.position, N = geo.attributes.aNormal, F = geo.attributes.aFrom, FN = geo.attributes.aNormalFrom, R = geo.attributes.aRand;
      const m = uniforms.uMorph.value;
      for (let i = 0; i < count; i++) {
        const k = morphAt(m, R.array[i * 4 + 2]);
        for (let j = 0; j < 3; j++) {
          const o = i * 3 + j;
          F.array[o] = F.array[o] + (P.array[o] - F.array[o]) * k;
          FN.array[o] = FN.array[o] + (N.array[o] - FN.array[o]) * k;
        }
        R.array[i * 4 + 3] = next.kinds[i];
      }
      P.array.set(next.positions); N.array.set(next.normals);
      for (const at of [P, N, F, FN, R]) at.needsUpdate = true;
      morphT = 0; morphDur = reduceMotion ? 0.001 : duration;
      uniforms.uMorph.value = 0;
    },
    update(dt) {
      if (morphT < 1) { morphT = Math.min(1, morphT + dt / morphDur); uniforms.uMorph.value = morphT; }
    },
    dispose() { geo.dispose(); mat.dispose(); }
  };
}

const BRAIN_VERT = /* glsl */`
uniform float uTime, uProj, uSize, uScale, uBeat, uSpin, uGlow, uAlert;
uniform vec3 uWhite, uHot, uWarm, uRed;
attribute vec4 aRand;                    // x radius 0..1, y phase, z size, w shell flag
varying vec3 vColor; varying float vAlpha;
${SIMPLEX}
void main(){
  vec3 p = position;
  float r = aRand.x;
  float ang = uSpin * (1.0 + (1.0 - r) * 1.8);                 // inner layers swirl faster
  float cs = cos(ang), sn = sin(ang);
  p.xz = mat2(cs, -sn, sn, cs) * p.xz;
  float ang2 = uSpin * 0.37 * (0.5 + r);
  cs = cos(ang2); sn = sin(ang2);
  p.xy = mat2(cs, -sn, sn, cs) * p.xy;
  vec3 q = p * 3.2 + vec3(0.0, uTime * 0.5, uTime * 0.3);
  p += vec3(snoise(q), snoise(q + 17.1), snoise(q + 31.7)) * 0.03 * (0.4 + r);
  float wave = 0.5 + 0.5 * sin(r * 14.0 - uTime * 6.0);       // rings travelling outwards
  p *= uScale * (1.0 + uBeat * (0.08 + 0.06 * wave * r));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vec3 col = mix(uWhite, uHot, smoothstep(0.0, 0.35, r));
  col = mix(col, uWarm, smoothstep(0.2, 0.8, r));
  col = mix(col, uRed, uAlert * smoothstep(0.2, 1.0, r) * 0.7);
  vColor = col;
  vAlpha = (0.17 + 0.17 * (1.0 - r) - aRand.w * 0.1 + uBeat * 0.2 * wave) * uGlow;
  float size = uSize * (0.6 + aRand.z * 0.9) * (1.0 + uBeat * 0.35) * (1.0 + aRand.w * 0.4);
  gl_PointSize = clamp(size * uProj / -mv.z, 1.0, 24.0);
}`;

/** The dense orange/yellow brain core: points + two glow sprites. */
function createBrainCore(map, { count = 9000, radius = BUST.brainRadius, seed = 19 } = {}) {
  const rng = mulberry32(seed);
  const pos = new Float32Array(count * 3), rand = new Float32Array(count * 4);
  const shellN = Math.floor(count * 0.28);
  for (let i = 0; i < count; i++) {
    const shell = i < shellN;
    let dx, dy, dz;
    if (shell) {                                                   // fibonacci shell
      const t = (i + 0.5) / shellN, phi = Math.acos(1 - 2 * t), th = Math.PI * (1 + Math.sqrt(5)) * i;
      dx = Math.sin(phi) * Math.cos(th); dy = Math.cos(phi); dz = Math.sin(phi) * Math.sin(th);
    } else {
      const u = rng() * 2 - 1, th = rng() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      dx = s * Math.cos(th); dy = u; dz = s * Math.sin(th);
    }
    const r = shell ? 0.6 + rng() * 0.4 : Math.pow(rng(), 1.25) * 0.92; // packed towards the centre
    pos[i * 3] = dx * r * radius; pos[i * 3 + 1] = dy * r * radius; pos[i * 3 + 2] = dz * r * radius;
    rand[i * 4] = r; rand[i * 4 + 1] = rng(); rand[i * 4 + 2] = rng(); rand[i * 4 + 3] = shell ? 1 : 0;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aRand", new THREE.BufferAttribute(rand, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius * 1.5);
  const uniforms = {
    uMap: { value: map }, uTime: { value: 0 }, uProj: { value: 600 }, uSize: { value: 0.014 }, uScale: { value: 1 },
    uBeat: { value: 0 }, uSpin: { value: 0 }, uGlow: { value: 1 }, uAlert: { value: 0 },
    uWhite: { value: COLORS.white }, uHot: { value: COLORS.hot }, uWarm: { value: COLORS.warm }, uRed: { value: COLORS.alert }
  };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: BRAIN_VERT, fragmentShader: SPRITE_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;

  const haloTex = createGlowTexture({ size: 256, stops: [[0, "rgba(255,190,90,0.9)"], [0.2, "rgba(255,140,40,0.45)"], [0.5, "rgba(255,95,20,0.12)"], [1, "rgba(255,80,0,0)"]] });
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.6 }));
  halo.scale.setScalar(radius * 6);
  const spark = new THREE.Sprite(new THREE.SpriteMaterial({ map, color: COLORS.white, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.9 }));
  spark.scale.setScalar(radius * 0.9);

  const group = new THREE.Group();
  group.name = "brain-core";
  group.position.copy(BUST.brain);
  group.add(halo, points, spark);
  return {
    group, uniforms, halo, spark,
    dispose() { geo.dispose(); mat.dispose(); haloTex.dispose(); halo.material.dispose(); spark.material.dispose(); }
  };
}

const AURA_VERT = /* glsl */`
uniform float uTime, uProj, uSize, uRate, uBoost;
uniform vec3 uColor, uRim;
attribute vec3 aNormal; attribute vec4 aRand;                   // x phase, y speed, z size, w drift
varying vec3 vColor; varying float vAlpha;
${SIMPLEX}
void main(){
  float life = fract(aRand.x + uTime * uRate * (0.5 + aRand.y));
  vec3 p = position + aNormal * (0.02 + life * (0.25 + aRand.w * 0.35));
  p.y += life * life * (0.55 + aRand.y * 0.7);
  vec3 q = p * 1.4 + vec3(0.0, -uTime * 0.25, 0.0);
  p += vec3(snoise(q), 0.0, snoise(q + 9.3)) * 0.12 * life;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vColor = mix(uRim, uColor, life);
  vAlpha = sin(life * 3.14159) * 0.7 * uBoost;
  gl_PointSize = clamp(uSize * (0.6 + aRand.z) * (1.0 - life * 0.4) * uProj / -mv.z, 1.0, 14.0);
}`;

/** Light dust rising off the head and shoulders. */
function createAura(map, { count = 4200 } = {}) {
  const { pos, nor } = generateAuraSeeds(count);
  const rng = mulberry32(31);
  const rand = new Float32Array(count * 4);
  for (let i = 0; i < count * 4; i++) rand[i] = rng();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aNormal", new THREE.BufferAttribute(nor, 3));
  geo.setAttribute("aRand", new THREE.BufferAttribute(rand, 4));
  const uniforms = { uMap: { value: map }, uTime: { value: 0 }, uProj: { value: 600 }, uSize: { value: 0.018 }, uRate: { value: 0.09 }, uBoost: { value: 0 }, uColor: { value: COLORS.deep }, uRim: { value: COLORS.cyan } };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: AURA_VERT, fragmentShader: SPRITE_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.name = "aura";
  return { points, uniforms, dispose() { geo.dispose(); mat.dispose(); } };
}

const VEIN_VERT = /* glsl */`
uniform float uTime, uProj, uSize, uFlow, uBoost;
uniform vec3 uGold, uHot;
attribute vec2 aVein;                                          // x position along the vein 0..1, y seed
varying vec3 vColor; varying float vAlpha;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float pulse = pow(0.5 + 0.5 * sin(aVein.x * 16.0 - uTime * uFlow + aVein.y * 6.28), 8.0);
  vColor = mix(uGold, uHot, pulse);
  vAlpha = (0.38 + 0.6 * pulse) * uBoost * smoothstep(0.0, 0.08, aVein.x);
  gl_PointSize = clamp(uSize * (1.0 + pulse * 0.8) * uProj / -mv.z, 1.0, 10.0);
}`;

/** Golden energy veins down the neck plus the sternum node. */
function createVeins(map) {
  const { data, node } = generateVeins();
  const n = data.length / 5;
  const pos = new Float32Array(n * 3), vein = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = data[i * 5]; pos[i * 3 + 1] = data[i * 5 + 1]; pos[i * 3 + 2] = data[i * 5 + 2];
    vein[i * 2] = data[i * 5 + 3]; vein[i * 2 + 1] = data[i * 5 + 4];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aVein", new THREE.BufferAttribute(vein, 2));
  const uniforms = { uMap: { value: map }, uTime: { value: 0 }, uProj: { value: 600 }, uSize: { value: 0.014 }, uFlow: { value: 3 }, uBoost: { value: 0 }, uGold: { value: COLORS.gold }, uHot: { value: COLORS.white } };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: VEIN_VERT, fragmentShader: SPRITE_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  const nodeSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, color: COLORS.hot, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
  nodeSprite.position.copy(node);
  nodeSprite.scale.setScalar(0.16);
  const group = new THREE.Group();
  group.name = "veins";
  group.add(points, nodeSprite);
  return { group, uniforms, node: nodeSprite, dispose() { geo.dispose(); mat.dispose(); nodeSprite.material.dispose(); } };
}

const RING_VERT = /* glsl */`
uniform float uTime, uProj, uSize, uBoost;
uniform vec3 uColor;
attribute vec3 aRing;                                          // x angle, y ring index, z seed
varying vec3 vColor; varying float vAlpha;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float dir = mod(aRing.y, 2.0) < 1.0 ? 1.0 : -1.0;
  float dash = smoothstep(0.1, 0.9, 0.5 + 0.5 * sin(aRing.x * (3.0 + aRing.y * 2.0) + uTime * 0.25 * dir + aRing.y));
  vColor = uColor;
  vAlpha = (0.08 + 0.3 * dash) * uBoost * (1.0 - aRing.y * 0.18);
  gl_PointSize = clamp(uSize * (0.7 + aRing.z * 0.6) * uProj / -mv.z, 1.0, 8.0);
}`;

/** Faint concentric rings behind the head (the holo-emitter look). */
function createHaloRings(map, { rings = 4, perRing = 520 } = {}) {
  const rng = mulberry32(41);
  const n = rings * perRing;
  const pos = new Float32Array(n * 3), meta = new Float32Array(n * 3);
  for (let r = 0; r < rings; r++) {
    const radius = 0.95 + r * 0.34;
    for (let i = 0; i < perRing; i++) {
      const k = r * perRing + i, a = (i / perRing) * Math.PI * 2;
      pos[k * 3] = Math.cos(a) * radius; pos[k * 3 + 1] = Math.sin(a) * radius; pos[k * 3 + 2] = (rng() - 0.5) * 0.01;
      meta[k * 3] = a; meta[k * 3 + 1] = r; meta[k * 3 + 2] = rng();
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aRing", new THREE.BufferAttribute(meta, 3));
  const uniforms = { uMap: { value: map }, uTime: { value: 0 }, uProj: { value: 600 }, uSize: { value: 0.012 }, uBoost: { value: 0 }, uColor: { value: COLORS.cyan } };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: RING_VERT, fragmentShader: SPRITE_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.position.set(0, BUST.brain.y + 0.05, -0.9);
  points.name = "halo-rings";
  return { points, uniforms, dispose() { geo.dispose(); mat.dispose(); } };
}

/* ------------------------------------------------------------------------ */
/* 5. Stage: renderer, camera, loop, public API                             */
/* ------------------------------------------------------------------------ */

const DEFAULTS = {
  count: null,                 // shell particles; null = 30 000 (16 000 on small screens)
  modelUrl: null,              // .glb to load after start
  model: {},                   // options for loadBustFromGLB (fit, rotationY, scale, offset)
  mode: "idle",
  aura: true,
  veins: true,
  rings: true,
  parallax: true,              // bust turns a little towards the pointer
  maxPixelRatio: 2,
  onReady: null,               // () => void, after the intro assembly
  onModelLoad: null,           // (info) => void
  onModelError: null           // (error) => void
};

/**
 * Creates the AI Master hologram on `canvas`.
 * Returns { setMode, setLevel, pulse, loadModel, addLayer, removeLayer,
 *           resize, pause, resume, dispose, mode, source, scene, camera,
 *           stage, anchors, renderer }.
 */
export function createAIMasterCore(canvas, options = {}) {
  if (!canvas) throw new Error("createAIMasterCore: canvas is required");
  const opts = { ...DEFAULTS, ...options, model: { ...DEFAULTS.model, ...(options.model || {}) } };
  const reduceMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  const stage = new THREE.Group();          // world root for this core and its layers (swarm radar goes here)
  const bust = new THREE.Group();           // the humanoid; turns with the pointer
  stage.add(bust);
  scene.add(stage);

  const sprite = createGlowTexture();
  const small = Math.min(canvas.clientWidth || innerWidth, canvas.clientHeight || innerHeight) < 600;
  const count = opts.count || (small ? 16000 : 30000);
  const sizeComp = Math.sqrt(30000 / count);                     // fewer points → slightly bigger dust

  const fallback = generateProceduralBust(count);
  const head = createHeadCloud(fallback, sprite, reduceMotion);
  head.uniforms.uSize.value *= sizeComp;
  const brain = createBrainCore(sprite);
  bust.add(head.points, brain.group);
  const aura = opts.aura ? createAura(sprite) : null;
  const veins = opts.veins ? createVeins(sprite) : null;
  const rings = opts.rings ? createHaloRings(sprite) : null;
  if (aura) bust.add(aura.points);
  if (veins) bust.add(veins.group);
  if (rings) stage.add(rings.points);

  const anchors = { stage, bust, brain: brain.group, chest: BUST.chest.clone(), bounds: { top: BUST.top, bottom: BUST.bottom } };
  const layers = new Set();

  // ---- state ----
  let mode = MODES[opts.mode] ? opts.mode : "idle";
  const cur = { ...MODES[mode] };
  let level = 0, levelTarget = 0;
  let spin = 0, beatPhase = 0;
  let shockT = -10, shockAmp = 0, nextScan = 1.5, scanT = -10;
  let source = "procedural";
  let readyFired = false, introDone = false;
  let veinsOn = true, veinsFade = 1;          // the veins follow the procedural neck; they fade out for a loaded model
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  const viewport = { width: 1, height: 1, dpr: 1 };
  let disposed = false, paused = false, onScreen = true, raf = 0, lost = false;
  const clock = new THREE.Clock();

  // ---- sizing & camera framing ----
  const fov = THREE.MathUtils.degToRad(camera.fov);
  function resize() {
    const w = canvas.clientWidth || canvas.parentElement?.clientWidth || innerWidth;
    const h = canvas.clientHeight || canvas.parentElement?.clientHeight || innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, opts.maxPixelRatio);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // frame the bust plus the aura above it, by height or by width, whichever is tighter
    const frameH = 3.55, frameW = 3.25, cy = 0.02;
    const t = Math.tan(fov / 2);
    const dist = Math.max((frameH / 2) / t, (frameW / 2) / (t * camera.aspect));
    camera.position.set(0, cy + 0.12, dist);
    camera.lookAt(0, cy, 0);
    camera.updateProjectionMatrix();
    const proj = (h * dpr) / (2 * t);                              // world size → pixels at distance 1
    for (const u of [head.uniforms, brain.uniforms, aura?.uniforms, veins?.uniforms, rings?.uniforms]) if (u) u.uProj.value = proj;
    viewport.width = w; viewport.height = h; viewport.dpr = dpr;
    if (paused || !raf) render(0);
  }
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => resize()) : null;
  ro?.observe(canvas);
  if (!ro) addEventListener("resize", resize);

  // ---- pointer parallax ----
  function onPointer(e) {
    if (!opts.parallax) return;
    const r = canvas.getBoundingClientRect();
    pointer.tx = THREE.MathUtils.clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
    pointer.ty = THREE.MathUtils.clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
  }
  function onLeave() { pointer.tx = 0; pointer.ty = 0; }
  addEventListener("pointermove", onPointer, { passive: true });
  document.addEventListener("pointerleave", onLeave);

  // ---- heartbeat shape: a double "lub-dub" per beat ----
  function beat(phase) {
    const e1 = Math.exp(-(((phase - 0.08) / 0.055) ** 2));
    const e2 = 0.65 * Math.exp(-(((phase - 0.3) / 0.07) ** 2));
    return Math.min(1, e1 + e2);
  }

  // ---- frame ----
  function render(dt) {
    const t = clock.elapsedTime;
    const motion = reduceMotion ? 0.3 : 1;
    const target = MODES[mode];
    const ease = 1 - Math.exp(-dt * 3);
    for (const k in target) cur[k] += (target[k] - cur[k]) * ease;
    level += (levelTarget - level) * (1 - Math.exp(-dt * 12));
    if (mode !== "speaking") levelTarget *= Math.exp(-dt * 4);

    head.update(dt);
    if (!readyFired && !head.morphing) { readyFired = true; opts.onReady?.(); }

    // brain throb + swirl
    beatPhase = (beatPhase + dt * (cur.bpm / 60) * motion) % 1;
    const b = beat(beatPhase) * cur.beat + level * 0.6;
    spin += dt * cur.spin * motion;
    const bu = brain.uniforms;
    bu.uTime.value = t * motion;
    bu.uBeat.value = b;
    bu.uSpin.value = spin;
    bu.uScale.value = 1 + level * 0.12;
    bu.uGlow.value = cur.glow;
    bu.uAlert.value = cur.alert;
    brain.group.rotation.x = Math.sin(t * 0.37) * 0.25 * motion;
    brain.group.rotation.z = Math.sin(t * 0.23) * 0.15 * motion;
    brain.group.scale.setScalar(1 + b * 0.07);
    brain.halo.material.opacity = (0.3 + 0.3 * b) * Math.min(1.2, cur.glow);
    brain.halo.material.color.copy(COLORS.white).lerp(COLORS.alert, cur.alert * 0.6);
    brain.spark.material.opacity = 0.18 + 0.22 * b;

    // shell: breathing, ripple, drift, scan sweeps, shockwaves
    const hu = head.uniforms;
    hu.uTime.value = t * motion;
    hu.uBreath.value = (0.012 * Math.sin(t * 1.15) + 0.004 * Math.sin(t * 2.3 + 1)) * motion;
    hu.uRipple.value = (cur.ripple + level * 0.02) * motion;
    hu.uDrift.value = cur.drift * motion;
    hu.uBrainGlow.value = (0.55 + 0.45 * b) * Math.min(1.2, cur.glow);
    hu.uAlert.value = cur.alert;
    if (!reduceMotion && cur.scan > 0.5 && t > nextScan && !head.morphing) { scanT = t; nextScan = t + MODES[mode].scan + Math.random() * 1.5; }
    const sp = (t - scanT) / 1.8;
    hu.uScanY.value = sp < 1 ? BUST.bottom + (BUST.top - BUST.bottom + 0.3) * sp : -9;
    hu.uScan.value = sp < 1 ? Math.sin(sp * Math.PI) * 0.9 : 0;
    const ss = t - shockT;
    hu.uShockR.value = ss * 2.2;
    hu.uShockAmp.value = ss < 1.4 ? shockAmp * (1 - ss / 1.4) : 0;
    if (mode === "alert" && !reduceMotion && ss > 1.1) pulse(0.8);

    // extras fade in once the shell has assembled
    const settle = introDone ? 1 : THREE.MathUtils.clamp((hu.uMorph.value - 0.55) / 0.45, 0, 1);
    if (settle >= 1) introDone = true;
    veinsFade += ((veinsOn ? 1 : 0) - veinsFade) * (1 - Math.exp(-dt * 2.5));
    if (aura) { aura.uniforms.uTime.value = t * motion; aura.uniforms.uBoost.value = settle * (0.8 + 0.3 * cur.glow); }
    if (veins) {
      veins.uniforms.uTime.value = t;
      veins.uniforms.uFlow.value = (2.2 + cur.spin * 2.2) * motion;
      veins.uniforms.uBoost.value = settle * veinsFade * (0.75 + 0.35 * b);
      veins.node.material.opacity = settle * veinsFade * (0.55 + 0.45 * b);
      veins.group.visible = veinsFade > 0.01;
      veins.node.scale.setScalar(0.13 + 0.06 * b);
    }
    if (rings) { rings.uniforms.uTime.value = t * motion; rings.uniforms.uBoost.value = settle; }

    // whole bust: idle sway + pointer parallax
    pointer.x += (pointer.tx - pointer.x) * (1 - Math.exp(-dt * 2.5));
    pointer.y += (pointer.ty - pointer.y) * (1 - Math.exp(-dt * 2.5));
    bust.rotation.y = (Math.sin(t * 0.21) * 0.16 * motion) + pointer.x * 0.38;
    bust.rotation.x = pointer.y * 0.1 + Math.sin(t * 0.17) * 0.02 * motion;
    bust.position.y = Math.sin(t * 0.6) * 0.025 * motion;

    const ctx = { time: t, dt, mode, level, beat: b, camera, anchors, viewport, reduceMotion };
    for (const l of layers) l.update?.(ctx);
    renderer.render(scene, camera);
  }

  function frame() {
    raf = 0;
    if (disposed || paused || !onScreen || lost) return;
    const dt = Math.min(clock.getDelta(), 1 / 20);
    render(dt);
    raf = requestAnimationFrame(frame);
  }
  function schedule() { if (!raf && !disposed && !paused && onScreen && !lost) { clock.getDelta(); raf = requestAnimationFrame(frame); } }

  // ---- lifecycle: hidden tab, off screen, context loss ----
  const onVis = () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else schedule(); };
  document.addEventListener("visibilitychange", onVis);
  const io = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver((e) => { onScreen = e[0].isIntersecting; schedule(); }) : null;
  io?.observe(canvas);
  const onLost = (e) => { e.preventDefault(); lost = true; cancelAnimationFrame(raf); raf = 0; };
  const onRestored = () => { lost = false; resize(); schedule(); };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  // ---- public API ----
  function setMode(m) { if (MODES[m]) { mode = m; if (m === "thinking" || m === "alert") pulse(0.6); } }
  function setLevel(v) { levelTarget = THREE.MathUtils.clamp(+v || 0, 0, 1); }
  function pulse(strength = 0.6) { shockT = clock.elapsedTime; shockAmp = THREE.MathUtils.clamp(strength, 0, 1.5); beatPhase = 0.02; }

  let loadToken = 0;
  async function loadModel(url, modelOptions = {}) {
    const token = ++loadToken;
    try {
      const data = await loadBustFromGLB(url, count, { ...opts.model, ...modelOptions });
      if (disposed || token !== loadToken) return null;
      head.setTarget(data);
      source = url;
      veinsOn = !!(modelOptions.keepVeins ?? opts.model.keepVeins);
      const info = { url, count };
      opts.onModelLoad?.(info);
      return info;
    } catch (err) {
      if (!disposed && token === loadToken) opts.onModelError?.(err);
      if (!opts.onModelError) console.warn("[ai-particle-core] model failed, keeping the procedural bust:", err);
      return null;
    }
  }
  function useProcedural() { loadToken++; head.setTarget(fallback); source = "procedural"; veinsOn = true; }

  /** layer: { object3D?, update?(ctx), dispose?() }. Returns a remover. */
  function addLayer(layer) {
    if (!layer) return () => {};
    if (layer.object3D) stage.add(layer.object3D);
    layers.add(layer);
    return () => removeLayer(layer);
  }
  function removeLayer(layer) {
    if (!layers.delete(layer)) return;
    if (layer.object3D) stage.remove(layer.object3D);
    layer.dispose?.();
  }

  function pause() { paused = true; cancelAnimationFrame(raf); raf = 0; }
  function resume() { paused = false; schedule(); }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    ro?.disconnect(); io?.disconnect();
    if (!ro) removeEventListener("resize", resize);
    removeEventListener("pointermove", onPointer);
    document.removeEventListener("pointerleave", onLeave);
    document.removeEventListener("visibilitychange", onVis);
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
    for (const l of [...layers]) removeLayer(l);
    head.dispose(); brain.dispose(); aura?.dispose(); veins?.dispose(); rings?.dispose();
    sprite.dispose();
    renderer.dispose();
  }

  resize();
  schedule();
  if (opts.modelUrl) loadModel(opts.modelUrl);

  return {
    setMode, setLevel, pulse, loadModel, useProcedural, addLayer, removeLayer,
    resize, pause, resume, dispose,
    get mode() { return mode; },
    get source() { return source; },
    get level() { return level; },
    scene, camera, renderer, stage, anchors
  };
}
