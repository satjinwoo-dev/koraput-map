/*
  avatar-ridges.js : the particle mountain range behind the Master AI bust
  ==========================================================================
  The backdrop of the full-screen view: layered ridges of cyan light dust,
  each drawn as contour rows like the bust, with gold streams of light
  running across the slopes. A layer for ai-particle-core.js
  (core.addLayer(createRidgeLayer())), so the core itself stays untouched.

  It reacts with the bust: brighter while speaking (voice level), a ripple
  with every brain beat, a red shift in alert. setVisible(false) skips it
  entirely (the corner view on the map doesn't draw it).

  Procedural and seeded: no textures, no data, same range on every phone.
*/

import * as THREE from "three";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 1-D value noise, smooth (cosine-free quintic fade), seeded
function noise1(seed) {
  const rng = mulberry32(seed);
  const g = Float32Array.from({ length: 512 }, () => rng() * 2 - 1);
  return (x) => {
    const i = Math.floor(x), f = x - i;
    const u = f * f * f * (f * (f * 6 - 15) + 10);
    const a = g[((i % 512) + 512) % 512], b = g[(((i + 1) % 512) + 512) % 512];
    return a + (b - a) * u;
  };
}

// The ridge profile of row `r` at x: ridged fbm, sharp crests like the video's peaks.
function makeProfile(seed) {
  const n = [noise1(seed), noise1(seed + 1), noise1(seed + 2), noise1(seed + 3)];
  return (x) => {
    let h = 0, amp = 1, freq = 0.52, norm = 0;
    for (let o = 0; o < 4; o++) {
      const v = 1 - Math.abs(n[o](x * freq + o * 13.7));
      h += v * v * amp; norm += amp;
      amp *= 0.45; freq *= 2.2;
    }
    return Math.pow(h / norm, 1.5);                               // 0..1, sharpened: narrow peaks, wide valleys
  };
}

const RIDGE_VERT = /* glsl */`
uniform float uTime, uProj, uSize, uBoost, uLevel, uBeat, uAlert, uFlow;
uniform vec3 uCam;                       // camera position (stage space), for the bust's silhouette
uniform vec3 uCyan, uDeep, uRim, uGold, uHot, uRed;
attribute vec4 aRand;                    // x crest 0..1, y phase, z size, w gold stream 0..1 (0 = none)
attribute float aDepth;                  // 0 front row .. 1 back row
varying vec3 vColor; varying float vAlpha;
void main(){
  vec3 p = position;
  float ph = aRand.y * 6.2831;
  // a slow shimmer, a ripple running along the range with every beat, a lift while speaking
  p.y += sin(uTime * 0.6 + ph) * 0.006 + sin(p.x * 2.2 - uTime * 1.6) * 0.012 * uBeat * aRand.x;
  p.y += uLevel * 0.035 * aRand.x * (0.5 + 0.5 * sin(p.x * 3.1 + uTime * 5.0));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  // hidden behind the bust: where the line of sight crosses the bust's plane (z = 0) inside its
  // silhouette (shoulders, neck, head: the procedural bust's outline), the ridge fades almost out
  float s = uCam.z / max(uCam.z - p.z, 0.001);
  vec2 q = vec2(p.x * s, uCam.y + (p.y - uCam.y) * s);
  float hw = q.y < -0.95 ? mix(1.42, 0.3, smoothstep(-1.5, -0.95, q.y))
           : q.y < -0.12 ? 0.3
           : 0.62 * sqrt(max(0.0, 1.0 - pow((q.y - 0.55) / 0.8, 2.0)));
  float behind = 1.0 - smoothstep(hw * 0.92, hw * 1.08 + 0.02, abs(q.x));
  float occlude = mix(1.0, 0.1, behind * step(q.y, 1.3));

  float crest = aRand.x;
  float gold = aRand.w;
  float flow = pow(0.5 + 0.5 * sin(p.x * 5.0 - uTime * uFlow + ph), 6.0);
  vec3 col = mix(uDeep, uCyan, 0.35 + 0.65 * crest);
  col = mix(col, uRim, crest * crest * 0.6);
  vec3 g = mix(uGold, uHot, flow);
  col = mix(col, g, step(0.001, gold));
  col = mix(col, uRed, uAlert * 0.35);

  float fade = 1.0 - aDepth * 0.55;                              // farther ridges dimmer
  float a = (gold > 0.0 ? 0.6 + 0.5 * flow : 0.08 + 0.62 * crest * crest + 0.1 * crest) * fade;
  a *= 0.85 + 0.25 * uBeat + 0.35 * uLevel;
  vColor = col;
  vAlpha = a * uBoost * occlude;
  float size = uSize * (0.7 + aRand.z * 0.7) * (gold > 0.0 ? 1.4 + flow * 0.8 : 0.9 + crest * 0.6);
  gl_PointSize = clamp(size * uProj / -mv.z, 1.0, 9.0);
}`;

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

function glowSprite() {
  const size = 64, c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d"), r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  for (const [o, col] of [[0, "rgba(255,255,255,1)"], [0.2, "rgba(255,255,255,0.8)"], [0.45, "rgba(255,255,255,0.25)"], [1, "rgba(255,255,255,0)"]]) grad.addColorStop(o, col);
  g.fillStyle = grad; g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  return tex;
}

/**
 * @param {{ count?: number, seed?: number, colors?: Record<string, THREE.Color> }} [opts]
 *   count: points (default 28 000; 14 000 on small screens)
 */
export function createRidgeLayer(opts = {}) {
  const small = Math.min(innerWidth, innerHeight) < 600;
  const count = opts.count || (small ? 14000 : 28000);
  const rng = mulberry32(opts.seed || 97);
  const C = {
    cyan: new THREE.Color("#1fb4ff"), deep: new THREE.Color("#0a2fd8"), rim: new THREE.Color("#5fd0ff"),
    gold: new THREE.Color("#ffb53a"), hot: new THREE.Color("#ffe7a8"), red: new THREE.Color("#ff3b2e"),
    ...(opts.colors || {})
  };

  // rows from front (z -1.2) to back (z -4.2); each row a ridge line sampled densely along x,
  // with a few rows of fill below it so the slopes read as dust, not as lines only
  const ROWS = 6, X0 = -8, X1 = 8, BASE = -1.75;
  const rows = Array.from({ length: ROWS }, (_, r) => {
    const depth = r / (ROWS - 1);
    return {
      z: -1.4 - depth * 3.0, depth,
      height: 1.15 + depth * 1.35 + (rng() - 0.5) * 0.25,          // back ridges taller (they read as distant peaks)
      lift: depth * 0.3,
      profile: makeProfile(7 + r * 17),
    };
  });
  // the bust stands in front of the middle: keep a soft valley there so the shoulders stay clear
  const valley = (x) => 1 - 0.7 * Math.exp(-((x / 2.1) ** 2));

  const pos = new Float32Array(count * 3), rand = new Float32Array(count * 4), depthA = new Float32Array(count);
  const goldCount = Math.floor(count * 0.08);
  const put = (i, x, y, z, crest, gold, depth) => {
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    rand[i * 4] = crest; rand[i * 4 + 1] = rng(); rand[i * 4 + 2] = rng(); rand[i * 4 + 3] = gold;
    depthA[i] = depth;
  };
  const topOf = (row, x) => BASE + row.lift + (0.04 + row.profile(x)) * row.height * valley(x);
  for (let i = 0; i < count - goldCount; i++) {
    const row = rows[Math.min(ROWS - 1, Math.floor(Math.pow(rng(), 0.9) * ROWS))];
    const x = X0 + rng() * (X1 - X0);
    const top = topOf(row, x);
    const u = rng();
    let y, crest;
    if (u < 0.4) {                                                    // the bright crest line
      y = top + (rng() - 0.5) * 0.008;
      crest = 1;
    } else if (u < 0.74) {
      // contour lines down the slope, following the crest like the bust's slices
      const k = 1 + Math.floor(Math.pow(rng(), 1.4) * 7);
      y = top - k * 0.085 + (rng() - 0.5) * 0.006;
      crest = Math.max(0.12, 0.62 - k * 0.07);
    } else {                                                          // dust filling the slope
      y = top - Math.pow(rng(), 0.7) * (top - BASE);
      crest = 0.05 + 0.15 * rng();
    }
    if (y < BASE) { y = BASE + rng() * 0.02; crest = 0.05; }
    put(i, x, y, row.z + (rng() - 0.5) * 0.25, crest, 0, row.depth);
  }
  // gold streams of light: zig-zag lines from just under a crest down the slope (the video's lava-like veins)
  const streams = [];
  for (const row of rows.slice(0, ROWS - 1)) {
    for (let k = 0; k < 7; k++) {
      let x0 = X0 + 0.5 + rng() * (X1 - X0 - 1);
      if (Math.abs(x0) < 1.4) x0 += Math.sign(x0 || 1) * 1.4;           // not straight behind the bust
      streams.push({ row, x0, drift: (rng() - 0.5) * 0.9, zig: noise1(900 + streams.length), len: 0.45 + rng() * 0.45 });
    }
  }
  for (let i = count - goldCount, n = 0; i < count; i++, n++) {
    const st = streams[n % streams.length];
    const s = rng();                                                  // 0 top .. 1 bottom of the stream
    const x = st.x0 + st.drift * s + st.zig(s * 6 + st.x0) * 0.12;
    const top = topOf(st.row, x) - 0.05;
    const y = Math.max(BASE + 0.03, top - s * st.len * (top - BASE));
    put(i, x, y, st.row.z + (rng() - 0.5) * 0.05, 0.3, 1, st.row.depth);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aRand", new THREE.BufferAttribute(rand, 4));
  geo.setAttribute("aDepth", new THREE.BufferAttribute(depthA, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -1, -2.7), 9);
  const map = glowSprite();
  const uniforms = {
    uMap: { value: map }, uTime: { value: 0 }, uProj: { value: 600 }, uSize: { value: 0.022 }, uBoost: { value: 0 },
    uLevel: { value: 0 }, uBeat: { value: 0 }, uAlert: { value: 0 }, uFlow: { value: 2.4 }, uCam: { value: new THREE.Vector3(0, 0, 6) },
    uCyan: { value: C.cyan }, uDeep: { value: C.deep }, uRim: { value: C.rim }, uGold: { value: C.gold }, uHot: { value: C.hot }, uRed: { value: C.red }
  };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: RIDGE_VERT, fragmentShader: SPRITE_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(geo, mat);
  points.name = "ridges";
  points.frustumCulled = false;
  points.renderOrder = -1;                                            // behind the bust

  let visible = true, fade = 0, alert = 0;
  return {
    object3D: points,
    /** @param {boolean} on */
    setVisible(on) { visible = Boolean(on); if (visible) points.visible = true; },
    update(ctx) {
      const dt = ctx.dt || 0;
      fade += ((visible ? 1 : 0) - fade) * (1 - Math.exp(-dt * 3.2));
      points.visible = fade > 0.01;
      if (!points.visible) return;
      const fov = THREE.MathUtils.degToRad(ctx.camera.fov);
      uniforms.uProj.value = (ctx.viewport.height * ctx.viewport.dpr) / (2 * Math.tan(fov / 2));
      uniforms.uCam.value.copy(ctx.camera.position);
      const motion = ctx.reduceMotion ? 0.3 : 1;
      uniforms.uTime.value = ctx.time * motion;
      uniforms.uLevel.value = ctx.level || 0;
      uniforms.uBeat.value = Math.min(1, ctx.beat || 0);
      alert += ((ctx.mode === "alert" ? 1 : 0) - alert) * (1 - Math.exp(-dt * 3));
      uniforms.uAlert.value = alert;
      uniforms.uFlow.value = (ctx.mode === "thinking" || ctx.mode === "alert" ? 4.2 : 2.4) * motion;
      uniforms.uBoost.value = fade;
    },
    dispose() { geo.dispose(); mat.dispose(); map.dispose(); }
  };
}
