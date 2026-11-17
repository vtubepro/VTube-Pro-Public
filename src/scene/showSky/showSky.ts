// Show sky + beam rig (scene.json `showSky`, shared/showSky.ts): in the lighting states the room lists (default Preshow),
// a music-reactive night sky - stars, a nebula band, aurora curtains, planets and moons (a ringed giant), meteors on the
// snares, pulse rings on the drops - and the room's searchlights / laser fans shooting up into it. One sky draw (every
// element is analytic in one dome shader, drawn just after the room's own sky, under everything else) + one beam draw.
// Reacts to the light show's music analysis (src/scene/beatClock.ts), or a wall-clock auto groove with no music (every
// page, OBS included, pulses on the same beat). Never plays or captures sound. Rooms without `showSky` pay nothing.
import * as THREE from 'three';
import { govChannel, governK, pageGovernor } from '../../../shared/flashGovernor.ts';
import type { SceneRuntime } from '../SceneRuntime.ts';
import { MAX_SKY_BEAMS, MAX_SKY_BODIES, beamAim, beamPattern, sanitizeShowSky, skyDir, type ShowSkyConfig } from '../../../shared/showSky.ts';
import { musicFrame, type MusicFrame } from './music.ts';

const MAX_MET = 8, MAX_PULSE = 3, LASERS_PER = 7;
const WHITE = new THREE.Color(1, 1, 1);
// per-frame scratch (no allocation in the beam / meteor loops)
const SD = new THREE.Vector3(), SH = new THREE.Vector3(), SC = new THREE.Color(), SC2 = new THREE.Color();
const MAX_INST = MAX_SKY_BEAMS + 3 * LASERS_PER;

const DOME_VS = /* glsl */ `
uniform mat3 uToRoom;
varying vec3 vDir;
void main() {
  vDir = uToRoom * position;
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const DOME_FS = /* glsl */ `
uniform float uShow, uTime;
uniform vec4 uMus;      // kick, snare, energy, drop
uniform vec4 uMus2;     // lo, mi, hi, build
uniform vec3 uPalA, uPalB;
uniform vec4 uAmt;      // stars, nebula, aurora, pulses
uniform vec4 uBody[${MAX_SKY_BODIES}];    // dir xyz, angular radius (rad)
uniform vec4 uBodyC[${MAX_SKY_BODIES}];   // colour, kind (0 giant, 1 moon, 2 planet)
uniform vec4 uBodyC2[${MAX_SKY_BODIES}];  // colour 2, glow
uniform vec4 uRing[${MAX_SKY_BODIES}];    // ring normal xyz, outer (x radius; 0 = none)
uniform vec4 uRingC[${MAX_SKY_BODIES}];   // ring colour, inner
uniform int uBodyN;
uniform vec3 uLight;
uniform vec4 uMet[${MAX_MET}];            // head dir xyz, age 0..1 (< 0 off)
uniform vec4 uMetV[${MAX_MET}];           // direction of travel xyz (unit, tangent), length (rad)
uniform vec4 uPulse[${MAX_PULSE}];        // centre dir xyz, age (s; < 0 off)
varying vec3 vDir;
float hsh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hsh(i), hsh(i + vec2(1, 0)), f.x), mix(hsh(i + vec2(0, 1)), hsh(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vn(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
vec3 basisU(vec3 n) { return normalize(abs(n.y) < 0.95 ? cross(vec3(0.0, 1.0, 0.0), n) : cross(vec3(1.0, 0.0, 0.0), n)); }
void main() {
  vec3 d = normalize(vDir);
  float hm = smoothstep(-0.005, 0.07, d.y);
  if (uShow < 0.002 || hm <= 0.0) discard;
  float kick = uMus.x, snare = uMus.y, en = uMus.z, drop = uMus.w, lo = uMus2.x, mi = uMus2.y, hi = uMus2.z;
  vec3 col = vec3(0.0);
  // deepen the night towards the zenith (premultiplied: a = how much of the sky below is replaced)
  float a = 0.55 * smoothstep(0.0, 0.5, d.y);
  col += vec3(0.004, 0.006, 0.02) * a;
  vec2 st = d.xz / (1.0 + d.y);             // stereographic (no seams)
  // ---- stars (three layers), twinkling, brighter with the hats
  if (uAmt.x > 0.001) {
    for (int l = 0; l < 3; l++) {
      float sc = 180.0 + float(l) * 170.0;
      vec2 c = floor(st * sc);
      float h = hsh(c + float(l) * 17.0);
      vec2 f = fract(st * sc) - 0.5 - (vec2(hsh(c + 3.1), hsh(c + 5.7)) - 0.5) * 0.6;
      float s = smoothstep(0.06 + 0.04 * float(l), 0.0, length(f)) * step(0.982 - float(l) * 0.004, h);
      float tw = 0.55 + 0.45 * sin(uTime * (1.5 + h * 4.0) + h * 60.0);
      vec3 sc3 = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.85, 0.7), hsh(c + 9.3));
      col += sc3 * s * tw * (1.2 - 0.3 * float(l)) * uAmt.x * (0.8 + 0.7 * hi) * smoothstep(0.03, 0.2, d.y);
    }
  }
  // ---- the nebula: a tilted band of dust and glowing gas, breathing with the music
  if (uAmt.y > 0.001) {
    vec3 n = normalize(vec3(0.42, 0.55, 0.72));
    float b = dot(d, n);
    vec3 u = basisU(n), v = cross(n, u);
    vec2 q = vec2(atan(dot(d, v), dot(d, u)) * 1.6, b * 4.0);
    float w = fbm(q * 1.4 + vec2(uTime * 0.004, 0.0));
    float g = fbm(q * 2.6 + w * 1.8 - vec2(0.0, uTime * 0.006));
    float band = exp(-b * b / 0.05) * (0.35 + 0.9 * g * g);
    float dust = smoothstep(0.45, 0.8, fbm(q * 4.0 + 3.0)) * exp(-b * b / 0.012);
    vec3 nc = mix(uPalA, uPalB, smoothstep(0.3, 0.75, w)) * band * (1.0 - 0.75 * dust);
    col += nc * uAmt.y * (0.12 + 0.3 * en) * (1.0 + 0.45 * kick + 0.9 * drop) * smoothstep(0.02, 0.25, d.y);
  }
  // ---- aurora curtains low over the horizon, rippling with the mids
  if (uAmt.z > 0.001) {
    float az = atan(d.x, -d.z);
    float side = smoothstep(-0.2, 0.6, sin(az * 0.7 + 1.2));
    float x = az * 6.0 + sin(az * 3.0 + uTime * 0.25) * 0.8 + uTime * 0.05;
    float rays = 0.5 + 0.5 * sin(x * 3.0 + fbm(vec2(x * 0.8, uTime * 0.15)) * 6.0);
    float h0 = 0.06 + 0.05 * fbm(vec2(x * 0.5, 2.0));
    float cur = smoothstep(h0, h0 + 0.03, d.y) * (1.0 - smoothstep(h0 + 0.05, h0 + 0.32 + 0.1 * mi, d.y));
    vec3 ac = mix(vec3(0.15, 0.95, 0.6), uPalB, 0.7) * mix(1.0, 0.4, smoothstep(h0 + 0.05, h0 + 0.3, d.y)) + uPalA * 0.25 * smoothstep(h0 + 0.12, h0 + 0.3, d.y);
    col += ac * cur * rays * side * uAmt.z * (0.05 + 0.16 * en + 0.1 * mi);
  }
  // ---- planets and moons (analytic spheres at infinity), rings, halos pulsing with the bass
  float cover = 0.0;
  for (int i = 0; i < ${MAX_SKY_BODIES}; i++) {
    if (i >= uBodyN) break;
    vec3 c = uBody[i].xyz; float R = tan(uBody[i].w);
    float tc = dot(d, c);
    if (tc <= 0.0) continue;
    // ray o=0, dir d vs sphere at c (|c| = 1), radius R
    float h2 = dot(c, c) - tc * tc;
    float ringA = 0.0, tRing = 1e9; vec3 ringCol = vec3(0.0);
    if (uRing[i].w > 0.0) {
      vec3 rn = uRing[i].xyz;
      float dn = dot(d, rn);
      if (abs(dn) > 1e-4) {
        float t = dot(c, rn) / dn;
        float rr = length(d * t - c) / R;
        if (t > 0.0 && rr > uRingC[i].w && rr < uRing[i].w) {
          float k = (rr - uRingC[i].w) / (uRing[i].w - uRingC[i].w);
          float bands = 0.55 + 0.45 * sin(rr * 41.0) * sin(rr * 13.0 + 1.0);
          float gap = smoothstep(0.0, 0.02, abs(k - 0.62) - 0.03);
          ringA = (0.25 + 0.6 * bands) * gap * smoothstep(0.0, 0.05, k) * smoothstep(1.0, 0.9, k);
          ringCol = uRingC[i].rgb * (0.55 + 0.6 * max(dot(rn, uLight), 0.0) + 0.3 * lo);
          tRing = t;
        }
      }
    }
    vec3 bc = vec3(0.0); float ba = 0.0; float tS = 1e9;
    if (h2 < R * R) {
      float th = sqrt(R * R - h2);
      tS = tc - th;
      vec3 N = normalize(d * tS - c);
      float lam = max(dot(N, uLight), 0.0);
      int kind = int(uBodyC[i].w + 0.5);
      vec3 u = basisU(c), v = cross(c, u);
      float lat = dot(N, v), lon = atan(dot(N, u), dot(N, -c));
      vec3 alb;
      if (kind == 0) {
        float bands = sin(lat * 18.0 + fbm(vec2(lon * 2.0 + uTime * 0.01, lat * 6.0)) * 3.0);
        alb = mix(uBodyC[i].rgb, uBodyC2[i].rgb, 0.5 + 0.5 * bands);
        alb *= 0.85 + 0.3 * fbm(vec2(lon * 6.0, lat * 30.0));
      } else {
        float cr = fbm(vec2(lon, lat) * 5.0 + float(i) * 3.0);
        alb = mix(uBodyC2[i].rgb, uBodyC[i].rgb, smoothstep(0.3, 0.7, cr));
      }
      float fres = pow(1.0 - max(-dot(N, d), 0.0), 4.0);
      // night side: a faint fill of the show's colours (never a black hole in the sky); rim light breathing with the bass
      bc = alb * (0.07 + 1.15 * lam) + mix(uPalA, uPalB, 0.5) * alb * 0.06 + mix(uPalA, uBodyC[i].rgb, 0.5) * fres * uBodyC2[i].w * (0.25 + 0.6 * lo + 0.5 * drop);
      ba = 1.0;
      // ring shadow on the planet
      if (uRing[i].w > 0.0) {
        vec3 P = d * tS; vec3 rn = uRing[i].xyz;
        float ld = dot(uLight, rn);
        if (abs(ld) > 1e-3) { float t = dot(c - P, rn) / ld; float rr = length(P + uLight * t - c) / R; if (t > 0.0 && rr > uRingC[i].w && rr < uRing[i].w) bc *= 0.45; }
      }
    }
    // halo
    float edge = sqrt(max(h2, 0.0)) / R;
    float halo = exp(-max(edge - 1.0, 0.0) * 7.0) * step(1.0, edge) * uBodyC2[i].w * (0.1 + 0.35 * lo + 0.4 * drop);
    col += mix(uBodyC[i].rgb, uPalA, 0.4) * halo * (1.0 - cover);
    // composite (premultiplied): the nearer of ring / disc on top
    if (tRing < tS) { col = mix(col, bc, ba * (1.0 - cover)); cover = max(cover, ba); col = mix(col, ringCol, ringA); cover = max(cover, ringA); }
    else { col = mix(col, ringCol, ringA * (1.0 - cover)); cover = max(cover, ringA); col = mix(col, bc, ba); cover = max(cover, ba); }
  }
  a = max(a, cover);
  // ---- meteors (on the snares)
  for (int i = 0; i < ${MAX_MET}; i++) {
    float age = uMet[i].w;
    if (age < 0.0) continue;
    vec3 hd = uMet[i].xyz, tv = uMetV[i].xyz;
    vec3 p = d - hd * dot(d, hd);
    float along = dot(p, -tv);
    float len = uMetV[i].w * min(1.0, age * 4.0);
    if (along < 0.0 || along > len || dot(d, hd) < 0.9) continue;
    float perp = length(p + tv * along);
    float k = smoothstep(0.0025, 0.0, perp) * (1.0 - along / max(len, 1e-4)) * (1.0 - age);
    col += mix(vec3(1.0, 0.95, 0.85), uPalA, 0.3) * k * 2.2;
  }
  // ---- pulse rings (on the drops)
  for (int i = 0; i < ${MAX_PULSE}; i++) {
    float age = uPulse[i].w;
    if (age < 0.0) continue;
    float ang = acos(clamp(dot(d, uPulse[i].xyz), -1.0, 1.0));
    float r = age * 0.55;
    float k = exp(-pow((ang - r) / (0.015 + 0.02 * age), 2.0)) * (1.0 - age / 2.6);
    col += mix(uPalA, uPalB, 0.5 + 0.5 * sin(ang * 8.0)) * k * uAmt.w * 0.9;
  }
  gl_FragColor = vec4(col * uShow * hm, a * uShow * hm);
}`;

const BEAM_VS = /* glsl */ `
in vec4 aO;   // origin xyz (room frame), on 0/1
in vec4 aD;   // direction xyz (unit), length
in vec4 aC;   // colour rgb, intensity
in vec4 aW;   // radius at the foot, radius at the end, softness, kind (0 searchlight, 1 laser)
varying vec3 vW;
varying vec3 vN;
varying float vT;
varying vec4 vC;
varying vec4 vWd;
varying float vLen;
void main() {
  vec3 dir = aD.xyz;
  vec3 u = normalize(abs(dir.y) < 0.95 ? cross(vec3(0.0, 1.0, 0.0), dir) : cross(vec3(1.0, 0.0, 0.0), dir));
  vec3 v = cross(dir, u);
  float t = position.y;                      // 0..1 along
  float r = mix(aW.x, aW.y, t);
  vec3 radial = u * position.x + v * position.z;
  vec3 p = aO.xyz + dir * t * aD.w + radial * r;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * radial);
  vT = t; vC = aC; vWd = aW; vLen = aD.w;
  gl_Position = aO.w > 0.5 ? projectionMatrix * viewMatrix * w : vec4(2.0, 2.0, 2.0, 1.0);
}`;
const BEAM_FS = /* glsl */ `
uniform float uShow, uTime;
varying vec3 vW;
varying vec3 vN;
varying float vT;
varying vec4 vC;
varying vec4 vWd;
varying float vLen;
float hsh(float x) { return fract(sin(x * 127.1) * 43758.5453); }
float n1(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(hsh(i), hsh(i + 1.0), f); }
void main() {
  vec3 V = normalize(cameraPosition - vW);
  float facing = abs(dot(normalize(vN), V));
  float core = pow(facing, vWd.z);
  float along = pow(1.0 - vT, vWd.w > 0.5 ? 0.6 : 1.4) * smoothstep(0.0, 0.004, vT);
  float dust = vWd.w > 0.5 ? 1.0 : 0.65 + 0.35 * n1(vT * vLen * 0.03 - uTime * 0.6) * n1(vT * vLen * 0.11 + uTime * 0.2);
  float nearFade = smoothstep(2.0, 14.0, length(cameraPosition - vW));
  float k = core * along * dust * nearFade * vC.a * uShow;
  if (k < 0.001) discard;
  gl_FragColor = vec4(vC.rgb * k, 1.0);
}`;

export class ShowSkyScene {
  private rt: SceneRuntime | null = null;
  private cfg: ShowSkyConfig | null = null;
  private dome: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> | null = null;
  private beams: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial> | null = null;
  private bA: { o: THREE.InstancedBufferAttribute; d: THREE.InstancedBufferAttribute; c: THREE.InstancedBufferAttribute; w: THREE.InstancedBufferAttribute } | null = null;
  private show = 0;
  /** test pages: force the show on (1) / off (0) whatever the lighting state; null = follow the state */
  force: number | null = null;
  private met: { beat: number; at: number; dir: THREE.Vector3; vel: THREE.Vector3; len: number }[] = [];
  private pulses: { beat: number; at: number; dir: THREE.Vector3 }[] = [];
  private lastSnare = -1e9; private lastDrop = -1e9; private lastDown = -1e9;
  private palette: () => [THREE.Color, THREE.Color] | null = () => null;
  private palA = new THREE.Color('#ff3cac'); private palB = new THREE.Color('#2bd9fe');
  private m: MusicFrame | null = null;
  private kickCh = govChannel('show sky');
  perf = { ms: 0 };

  /** The light show's current wash colours (BeatLights.washPalette), so the sky and beams match the room's show. */
  setPalette(f: () => [THREE.Color, THREE.Color] | null) { this.palette = f; }

  /** `fallback`: the sky a room engine supplies when the room has no `showSky` block (a walking ship's Preshow show). */
  attach(rt: SceneRuntime, fallback?: () => unknown) {
    if (this.rt === rt) return;
    this.detach();
    const own = (rt.info as unknown as { showSky?: unknown }).showSky;
    const cfg = sanitizeShowSky(own === undefined && fallback ? fallback() : own);
    if (!cfg) return;
    this.rt = rt; this.cfg = cfg;
    const B = cfg.bodies;
    const u = {
      uShow: { value: 0 }, uTime: { value: 0 }, uMus: { value: new THREE.Vector4() }, uMus2: { value: new THREE.Vector4() },
      uPalA: { value: new THREE.Color() }, uPalB: { value: new THREE.Color() }, uAmt: { value: new THREE.Vector4(cfg.stars, cfg.nebula, cfg.aurora, cfg.pulses) },
      uBody: { value: Array.from({ length: MAX_SKY_BODIES }, () => new THREE.Vector4()) }, uBodyC: { value: Array.from({ length: MAX_SKY_BODIES }, () => new THREE.Vector4()) },
      uBodyC2: { value: Array.from({ length: MAX_SKY_BODIES }, () => new THREE.Vector4()) }, uRing: { value: Array.from({ length: MAX_SKY_BODIES }, () => new THREE.Vector4()) },
      uRingC: { value: Array.from({ length: MAX_SKY_BODIES }, () => new THREE.Vector4()) }, uBodyN: { value: B.length },
      uLight: { value: new THREE.Vector3(...skyDir(cfg.light[0], cfg.light[1])).normalize() },
      uMet: { value: Array.from({ length: MAX_MET }, () => new THREE.Vector4(0, 1, 0, -1)) }, uMetV: { value: Array.from({ length: MAX_MET }, () => new THREE.Vector4()) },
      uPulse: { value: Array.from({ length: MAX_PULSE }, () => new THREE.Vector4(0, 1, 0, -1)) },
      uToRoom: { value: new THREE.Matrix3() },
    };
    const lin = (h: string) => new THREE.Color(h);
    B.forEach((b, i) => {
      const [x, y, z] = skyDir(b.az, b.el);
      u.uBody.value[i].set(x, y, z, (b.size * Math.PI) / 360);
      const c1 = lin(b.color), c2 = lin(b.color2);
      u.uBodyC.value[i].set(c1.r, c1.g, c1.b, b.kind === 'giant' ? 0 : b.kind === 'moon' ? 1 : 2);
      u.uBodyC2.value[i].set(c2.r, c2.g, c2.b, b.glow);
      if (b.ring) {
        // the ring plane: tilted from the view direction's up by `tilt` about the line of sight
        const c = new THREE.Vector3(x, y, z);
        const up = new THREE.Vector3(0, 1, 0).sub(c.clone().multiplyScalar(c.y)).normalize();
        const n = up.clone().applyAxisAngle(c, (b.ring.tilt * Math.PI) / 180).lerp(c, 0.18).normalize();
        u.uRing.value[i].set(n.x, n.y, n.z, b.ring.outer);
        const rc = lin(b.ring.color);
        u.uRingC.value[i].set(rc.r, rc.g, rc.b, b.ring.inner);
      }
    });
    const dm = new THREE.ShaderMaterial({ vertexShader: DOME_VS, fragmentShader: DOME_FS, uniforms: u, depthWrite: false, depthTest: false, side: THREE.BackSide, fog: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
    dm.name = 'vtp:showsky:dome';
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), dm);
    this.dome.name = 'vtp:showsky:dome';
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -998;              // right after the room's / desert's sky (-1000 / -999), under everything else
    this.dome.visible = false;
    rt.stage.scene.add(this.dome);
    // beams: open cylinders along +Y (0..1), instanced
    const cg = new THREE.CylinderGeometry(1, 1, 1, 16, 24, true).translate(0, 0.5, 0);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', cg.getAttribute('position'));
    g.setIndex(cg.getIndex());
    const mk = () => new THREE.InstancedBufferAttribute(new Float32Array(MAX_INST * 4), 4);
    this.bA = { o: mk(), d: mk(), c: mk(), w: mk() };
    g.setAttribute('aO', this.bA.o); g.setAttribute('aD', this.bA.d); g.setAttribute('aC', this.bA.c); g.setAttribute('aW', this.bA.w);
    g.instanceCount = 0;
    const bm = new THREE.ShaderMaterial({ vertexShader: BEAM_VS, fragmentShader: BEAM_FS, uniforms: { uShow: { value: 0 }, uTime: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
    bm.name = 'vtp:showsky:beams';
    bm.forceSinglePass = true;                 // (additive: order-independent - both faces in one pass, no two-pass side swap)
    this.beams = new THREE.Mesh(g, bm);
    this.beams.name = 'vtp:showsky:beams';
    this.beams.frustumCulled = false;
    this.beams.renderOrder = 60;
    this.beams.visible = false;
    rt.room.root.add(this.beams);
    try { void (rt.stage.renderer as THREE.WebGLRenderer & { compileAsync?: (o: THREE.Object3D, c: THREE.Camera, s?: THREE.Scene) => Promise<unknown> }).compileAsync?.(this.dome, rt.stage.camera, rt.stage.scene)?.catch(() => {}); } catch { /* optional */ }
  }

  detach() {
    this.dome?.removeFromParent(); this.dome?.geometry.dispose(); this.dome?.material.dispose();
    this.beams?.removeFromParent(); this.beams?.geometry.dispose(); this.beams?.material.dispose();
    this.dome = null; this.beams = null; this.bA = null; this.rt = null; this.cfg = null; this.show = 0; this.met = []; this.pulses = [];
  }

  /** Is the show on in this lighting state (the target the fade runs to)? */
  wants(): boolean {
    const rt = this.rt, cfg = this.cfg;
    if (!rt || !cfg) return false;
    if (this.force !== null) return this.force > 0.5;
    return cfg.states.includes(rt.state.lights?.state ?? 'show');
  }

  update(dt: number, now: number = Date.now()) {
    const rt = this.rt, cfg = this.cfg, dome = this.dome, beams = this.beams;
    if (!rt || !cfg || !dome || !beams || !this.bA) return;
    const t0 = performance.now();
    const want = this.wants() ? 1 : 0;
    this.show += (want - this.show) * (1 - Math.exp(-Math.max(0, dt) / Math.max(0.05, cfg.fade / 3)));
    if (this.show < 0.002 && !want) { this.show = 0; dome.visible = false; beams.visible = false; return; }
    dome.visible = true; beams.visible = true;
    // photosensitivity: the kick drives the nebula band, the searchlights and the laser fans — one output on the page's
    // governor (its largest swing: the beams, 1 + 0.72·kick + 0.6·drop) gives the kick everything may show
    const m0 = musicFrame(now);
    const m = { ...m0, kick: governK(pageGovernor(performance.timeOrigin + performance.now()), this.kickCh, m0.kick, 1 + 0.6 * m0.drop, 0.72) };
    this.m = m;
    const pal = this.palette();
    if (pal) { this.palA.lerp(pal[0], 0.08); this.palB.lerp(pal[1], 0.08); }
    const t = (now / 1000) % 3600;
    const U = dome.material.uniforms;
    U.uShow.value = this.show; U.uTime.value = t;
    (U.uMus.value as THREE.Vector4).set(m.kick, m.snare, m.energy, m.drop);
    (U.uMus2.value as THREE.Vector4).set(m.lo, m.mi, m.hi, m.build);
    // the palette as glowing colours (never black, never pure white)
    (U.uPalA.value as THREE.Color).copy(this.palA).lerp(WHITE, 0.08);
    (U.uPalB.value as THREE.Color).copy(this.palB).lerp(WHITE, 0.08);
    // the dome's directions in the room frame
    rt.room.root.updateWorldMatrix(true, false);
    (U.uToRoom.value as THREE.Matrix3).setFromMatrix4(rt.room.root.matrixWorld).invert();
    this.events(m, now);
    const met = U.uMet.value as THREE.Vector4[], metV = U.uMetV.value as THREE.Vector4[];
    for (let i = 0; i < MAX_MET; i++) {
      const e = this.met[i];
      const age = e ? (now - e.at) / 1100 : -1;
      if (e && age >= 0 && age < 1 && cfg.meteors > 0) { const h = SH.copy(e.dir).addScaledVector(e.vel, age * e.len * 0.6).normalize(); met[i].set(h.x, h.y, h.z, age); metV[i].set(e.vel.x, e.vel.y, e.vel.z, e.len); }
      else met[i].w = -1;
    }
    const pu = U.uPulse.value as THREE.Vector4[];
    for (let i = 0; i < MAX_PULSE; i++) { const e = this.pulses[i]; const age = e ? (now - e.at) / 1000 : -1; if (e && age >= 0 && age < 2.6) pu[i].set(e.dir.x, e.dir.y, e.dir.z, age); else pu[i].w = -1; }
    this.updateBeams(m, t);
    this.perf.ms += (performance.now() - t0 - this.perf.ms) * 0.05;
  }

  /** Meteors on snares (at most one per beat, directions hashed from the beat index: every page draws the same), pulse
   *  rings on drops and on every 4th downbeat of a drop section. */
  private events(m: MusicFrame, now: number) {
    const cfg = this.cfg!;
    if (cfg.meteors > 0 && m.snareBeat > this.lastSnare && m.snare > 0.5) {
      this.lastSnare = m.snareBeat;
      const h = (k: number) => ((Math.imul((m.snareBeat * 31 + k) ^ 0x9e3779b9, 0x85ebca6b) >>> 0) % 10000) / 10000;
      if (h(1) < 0.55 * cfg.meteors) {
        const dir = new THREE.Vector3(...skyDir(h(2) * 360 - 180, 25 + 50 * h(3)));
        const side = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
        const vel = side.multiplyScalar(h(4) < 0.5 ? 1 : -1).addScaledVector(new THREE.Vector3(0, -1, 0).projectOnPlane(dir).normalize(), 0.6).normalize();
        this.met = [...this.met.filter((x) => now - x.at < 1100), { beat: m.snareBeat, at: now, dir, vel, len: 0.12 + 0.18 * h(5) }].slice(-MAX_MET);
      }
    }
    const downbeat = Math.floor(m.beat / 4) * 4;
    const pulse = (beat: number) => {
      const body = cfg.bodies[0];
      const dir = body ? new THREE.Vector3(...skyDir(body.az, body.el)) : new THREE.Vector3(0, 1, 0);
      this.pulses = [...this.pulses.filter((x) => now - x.at < 2600), { beat, at: now, dir }].slice(-MAX_PULSE);
    };
    if (m.dropBeat > this.lastDrop && m.drop > 0.6) { this.lastDrop = m.dropBeat; pulse(m.dropBeat); }
    else if (m.section === 'drop' && downbeat > this.lastDown && downbeat % 16 === 0 && m.barPos < 0.5) { this.lastDown = downbeat; pulse(downbeat); }
  }

  /** Searchlights (lean outward, patterns per phrase) + laser fans in the energetic parts. */
  private updateBeams(m: MusicFrame, t: number) {
    const cfg = this.cfg!, A = this.bA!, beams = this.beams!;
    const rt = this.rt!;
    const pat = beamPattern(m.bar, m.section);
    const n = cfg.beams.length;
    const far = Math.max(60, rt.stage.camera.far * 0.92);
    const L = Math.min(cfg.beamLength, far);
    const level = (m.section === 'breakdown' ? 0.45 : 0.75 + 0.25 * m.energy) * (1 + 0.7 * m.kick + 0.6 * m.drop);
    let k = 0;
    const put = (o: number[], d: THREE.Vector3, len: number, col: THREE.Color, I: number, r0: number, r1: number, soft: number, kind: number) => {
      A.o.setXYZW(k, o[0], o[1], o[2], 1); A.d.setXYZW(k, d.x, d.y, d.z, len); A.c.setXYZW(k, col.r, col.g, col.b, I); A.w.setXYZW(k, r0, r1, soft, kind); k++;
    };
    const tmp = SC;
    for (let i = 0; i < n; i++) {
      const b = cfg.beams[i];
      const lean = Math.atan2(b.at[0], -b.at[2]);
      const a = beamAim(pat, i, n, m.beat, m.build, lean);
      const d = SD.set(Math.sin(a.tilt) * Math.sin(a.az), Math.cos(a.tilt), -Math.sin(a.tilt) * Math.cos(a.az));
      const c = b.color ? tmp.set(b.color) : tmp.copy((i + Math.floor(m.bar / 2)) % 2 ? this.palA : this.palB);
      put(b.at, d, L, SC2.copy(c).lerp(WHITE, 0.3), 0.4 * level, 0.35 * cfg.beamWidth, 24 * cfg.beamWidth, 3.0, 0);
    }
    // laser fans: in the drops and the energetic grooves
    const lz = Math.max(0, Math.min(1, (m.energy - 0.6) * 4)) * (m.section === 'breakdown' ? 0 : 1);
    const lk = Math.max(lz, m.drop);
    if (lk > 0.05) cfg.lasers.forEach((o, j) => {
      for (let q = 0; q < LASERS_PER; q++) {
        const spread = (q / (LASERS_PER - 1) - 0.5) * 1.6;
        const az = Math.atan2(o[0], -o[2]) + (j % 2 ? Math.PI : 0) + spread + 0.5 * Math.sin(m.beat * Math.PI / 4 + j);
        const tilt = 0.55 + 0.35 * Math.sin(m.beat * Math.PI / 2 + q * 0.45);
        const d = SD.set(Math.sin(tilt) * Math.sin(az), Math.cos(tilt), -Math.sin(tilt) * Math.cos(az));
        const c = tmp.copy(q % 2 ? this.palA : this.palB).lerp(WHITE, 0.15);
        put(o, d, L, c, 1.6 * lk * (0.7 + 0.5 * m.kick), 0.025, 0.5, 1.0, 1);
      }
    });
    beams.geometry.instanceCount = k;
    A.o.needsUpdate = A.d.needsUpdate = A.c.needsUpdate = A.w.needsUpdate = true;
    beams.material.uniforms.uShow.value = this.show;
    beams.material.uniforms.uTime.value = t;
  }

  /** The direction (room frame, unit) of the hero body (the first one) - exterior cameras frame it. */
  heroDir(): THREE.Vector3 | null {
    const b = this.cfg?.bodies[0];
    return b ? new THREE.Vector3(...skyDir(b.az, b.el)) : null;
  }
  /** The show's colours now (between its two wash colours): a walking ship's desert tints its night haze with them. */
  tint(out: THREE.Color): THREE.Color { return out.copy(this.palA).lerp(this.palB, 0.5); }
  /** 0..1: how much the show is on now (cameras / the voyage read it). */
  get level() { return this.show; }

  info() {
    const m = this.m;
    return { on: !!this.rt, show: +this.show.toFixed(3), wants: this.wants(), states: this.cfg?.states ?? [], bodies: this.cfg?.bodies.length ?? 0, beams: this.beams?.geometry.instanceCount ?? 0,
      music: m ? { live: m.live, bpm: m.bpm, beat: +m.beat.toFixed(2), section: m.section, kick: +m.kick.toFixed(2), energy: +m.energy.toFixed(2), drop: +m.drop.toFixed(2) } : null,
      pattern: m ? beamPattern(m.bar, m.section) : null, meteors: this.met.length, pulses: this.pulses.length, ms: +this.perf.ms.toFixed(3) };
  }
}
