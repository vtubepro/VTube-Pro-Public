// Epoch rooms — the living void for rooms whose scene.json has an `epoch` key (first user: assets/scenes/
// lastepoch_end_of_time, the Last Epoch "End of Time" homage). Everything here is additive and costs nothing elsewhere:
//   · the VOID_SKY dome: a swirling nebula vortex round the eclipse + twinkling stars, its palette slowly cycling through
//     the eras ("the timeline", epoch.sky.palettes / cycle s) and pulsing / recolouring with the light show (the
//     `EMIT_<probe>` group's live level and colour are read back from the room's emissive material every frame)
//   · the ECLIPSE: a black void-sun with a churning corona (premultiplied: the disc hides the stars, the corona adds)
//   · the VOID_TEAR far away with void creatures (VOIDLING_xx cards) drifting out of it and back
//   · RIFT_xx time rifts that open and close on their own schedules (extras radius / period / open / phase), RIFT_GATE
//     inside the Epoch Gate (swells as the react screen tears open; the screen's power-on becomes the 'shimmer' reveal)
//     and RIFT_DOOR, the arrival portal, which flares while the room's DOOR (an empty) is "open" during walk-ins
//   · SHARDS_xx: time shards orbiting an anchor (one instanced draw), FX_MOTES_xx / FX_EMBERS_xx (town particles)
//   · spinning / bobbing relics, swaying banners (SWAY_*), additive EMIT groups (epoch.additive)
//   · epoch.patrons: background hub NPCs (the town NPC tech via src/scene/traffic/patrons.ts)
// Sync: every motion is a pure function of wall-clock seconds (Date.now()), so the studio preview, OBS and party guests'
// OBS agree without messages. Test pages: vtpOut.epoch.scene.manual = true; .clock = <s>; vtpOut.step(n, dt).
import * as THREE from 'three';
import type { SceneRuntime } from '../SceneRuntime.ts';
import { sceneFileUrl } from '../SceneRuntime.ts';
import { Particles } from '../town/particles.ts';
import { Patrons, type PatronCfg } from '../traffic/patrons.ts';
import { gfxBudget } from '../../stage/gfx/lod.ts';
import { EraDirector, type RoomErasConfig } from './eras.ts';
import type { SceneEraState } from '../../../shared/era.ts';

interface EpochCfg {
  sky?: { node?: string; palettes?: string[][]; cycle?: number; probe?: string };
  eclipse?: { node?: string; rim?: string; rim2?: string; probe?: string };
  tear?: { node?: string; voidlings?: number; probe?: string };
  rifts?: { probe?: string; color?: string; color2?: string };
  additive?: string[];
  screen?: { powerOn?: 'crt' | 'hologram' | 'shimmer' | 'fade'; rift?: string };
  patrons?: PatronCfg;
  spin?: Record<string, number | { rate: number; axis?: 'x' | 'y' | 'z'; bob?: number; swing?: number }>;
}
interface Rift { node: THREE.Object3D; mesh: THREE.Mesh; mat: THREE.ShaderMaterial; r: number; kind: string; period: number; open: number; phase: number; seed: number; sy: number }
interface Spin { o: THREE.Object3D; rest: THREE.Quaternion; restP: THREE.Vector3; rate: number; axis: THREE.Vector3; bob: number; ph: number; swing: number }
interface Probe { m: THREE.MeshStandardMaterial; base: number; baseColor: THREE.Color }

const tq = new THREE.Quaternion(), tv = new THREE.Vector3(), tc = new THREE.Color(), tc2 = new THREE.Color();
const AX = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const PREMUL = { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation } as const;

// ------------------------------------------------------------------ shaders
const NOISE = /* glsl */`
  float h31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float n3(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z); }
  float fbm3(vec3 p, int oct) { float a = 0.5, s = 0.0; for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * n3(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s; }
  float h21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  float n2(vec2 q) { vec2 i = floor(q), f = fract(q); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
  float fbm2(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * n2(p); p = p * 2.07 + 3.1; a *= 0.5; } return s; }
`;

function skyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'vtp:epoch:sky', side: THREE.DoubleSide, depthWrite: false, fog: false,
    uniforms: { uTime: { value: 0 }, uA: { value: new THREE.Color() }, uB: { value: new THREE.Color() }, uC: { value: new THREE.Color() },
      uEcl: { value: new THREE.Vector3(-0.47, 0.25, -0.85).normalize() }, uPulse: { value: 1 }, uOct: { value: 4 }, uHouse: { value: 1 },
      // era shifts (src/scene/epoch/eras.ts): 1 = the void nebula, 0 = an open daylight / dusk sky with sun + clouds
      uVoid: { value: 1 }, uZen: { value: new THREE.Color('#3a78d8') }, uHor: { value: new THREE.Color('#f0d8a8') }, uGnd: { value: new THREE.Color('#2a3020') },
      uSunD: { value: new THREE.Vector3(0.4, 0.5, -0.7).normalize() }, uSunC: { value: new THREE.Color('#fff0c0') }, uCloud: { value: 0 },
      uCloudC: { value: new THREE.Color('#ffffff') }, uStars: { value: 1 }, uFlash: { value: 0 } },
    vertexShader: /* glsl */`varying vec3 vDir; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vDir = normalize(w.xyz - cameraPosition);
      gl_Position = projectionMatrix * viewMatrix * w; gl_Position.z = gl_Position.w * 0.99999; }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uPulse, uHouse; uniform int uOct; uniform vec3 uA, uB, uC, uEcl; varying vec3 vDir;
      uniform float uVoid, uCloud, uStars, uFlash; uniform vec3 uZen, uHor, uGnd, uSunD, uSunC, uCloudC;
      ${NOISE}
      void main() {
        vec3 d = normalize(vDir);
        // vortex coordinates round the eclipse axis: angle + log distance -> spiral arms that slowly turn in
        vec3 ax = uEcl; vec3 t1 = normalize(cross(ax, vec3(0.0, 1.0, 0.0))); vec3 t2 = cross(t1, ax);
        float ca = dot(d, ax);
        float ang = atan(dot(d, t2), dot(d, t1));
        float rr = acos(clamp(ca, -1.0, 1.0));                   // 0 at the eclipse .. pi opposite
        float spiral = ang + log(rr + 0.05) * 2.4 - uTime * 0.012;
        vec3 q = d * 2.2 + vec3(sin(spiral) * 0.35, cos(spiral) * 0.35, 0.0);
        float warp = fbm3(q * 1.3 + vec3(0.0, uTime * 0.004, 0.0), uOct);
        float neb = fbm3(q * 2.1 + warp * 1.7 + vec3(uTime * 0.003), uOct);
        float arms = 0.5 + 0.5 * sin(spiral * 2.0 + warp * 4.0);
        float fil = pow(fbm3(q * 5.0 + warp * 2.5, max(uOct - 1, 2)), 3.0) * 2.4;
        float near = exp(-rr * 1.6);                              // glow concentrated round the eclipse
        float band = exp(-pow(d.y * 2.8 + 0.25 * sin(ang * 1.0), 2.0));   // a galactic band across the void
        vec3 col = uA * (0.35 + 0.65 * neb);
        col += uB * smoothstep(0.45, 0.85, neb) * (0.35 + 0.9 * arms) * (0.35 + 1.4 * near + 0.5 * band) * uPulse;
        col += uC * smoothstep(0.55, 0.95, neb * 0.6 + fil * 0.6) * (0.25 + 0.6 * band) * (0.7 + 0.3 * uPulse);
        col += mix(uB, vec3(1.0, 0.75, 0.5), 0.4) * near * near * 0.9 * uPulse;
        // dark dust lanes
        col *= 0.55 + 0.45 * smoothstep(0.25, 0.6, fbm3(q * 3.3 - warp, max(uOct - 1, 2)));
        // stars: hashed cells on the sphere, twinkling
        vec3 sp = d * 180.0; vec3 ci = floor(sp); float hs = h31(ci);
        vec3 f = fract(sp) - 0.5 - (vec3(h31(ci + 3.1), h31(ci + 7.7), h31(ci + 1.3)) - 0.5) * 0.6;
        float st = step(0.93, hs) * smoothstep(0.09, 0.0, length(f)) * (0.6 + 0.4 * sin(uTime * (1.0 + hs * 4.0) + hs * 60.0));
        vec3 sp2 = d * 60.0; vec3 c2 = floor(sp2); float h2 = h31(c2);
        float big = step(0.985, h2) * smoothstep(0.16, 0.0, length(fract(sp2) - 0.5)) * (0.7 + 0.3 * sin(uTime * 2.3 + h2 * 90.0));
        // an open sky for the other eras: horizon -> zenith gradient, sun disc + glow, two-tone cel clouds
        float el = d.y;
        vec3 day = mix(uHor, uZen, smoothstep(-0.02, 0.6, el));
        day = mix(day, uGnd, smoothstep(0.0, -0.3, el));
        float sd = max(0.0, dot(d, normalize(uSunD)));
        day += uSunC * (smoothstep(0.9993, 0.9996, sd) * 2.5 + pow(sd, 14.0) * 0.4 + pow(sd, 3.0) * 0.12);
        vec2 cuv = d.xz / max(0.06, d.y + 0.14) * 0.8 + vec2(uTime * 0.005, uTime * 0.0012);
        float cn = fbm2(cuv * 1.4) * 0.7 + fbm2(cuv * 3.7 + 5.0) * 0.3;
        float cmask = smoothstep(0.52 - uCloud * 0.14, 0.62 - uCloud * 0.14, cn) * min(1.0, uCloud * 1.4) * smoothstep(-0.04, 0.12, el);
        vec3 ccol = uCloudC * mix(0.72, 1.0, smoothstep(0.6, 0.75, cn)) + uSunC * pow(sd, 5.0) * 0.35;
        day = mix(day, ccol, cmask);
        vec3 stars = vec3(0.85, 0.9, 1.0) * st * 0.9 + mix(vec3(1.0, 0.8, 0.9), uC, 0.3) * big * 1.4;
        col = mix(day + stars * uStars * (1.0 - smoothstep(0.1, 0.5, dot(day, vec3(0.33)))) * (1.0 - cmask), col + stars, uVoid);
        col += vec3(0.75, 0.9, 1.0) * uFlash * 0.35;
        col *= mix(0.55, 1.0, uHouse);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

function eclipseMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'vtp:epoch:eclipse', transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide, ...PREMUL,
    uniforms: { uTime: { value: 0 }, uRim: { value: new THREE.Color('#ff8a3a') }, uRim2: { value: new THREE.Color('#ff3a8a') }, uPulse: { value: 1 } },
    vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uPulse; uniform vec3 uRim, uRim2; varying vec2 vUv;
      ${NOISE}
      void main() {
        vec2 p = (vUv - 0.5) * 2.8;                     // disc radius 1 in these units (quad = 2.8 radii)
        float r = length(p); float a = atan(p.y, p.x);
        float disc = 1.0 - smoothstep(0.985, 1.0, r);
        // corona flames: polar noise streaming outward + slowly turning
        float fl = fbm2(vec2(a * 3.0 + uTime * 0.05, r * 3.2 - uTime * 0.35));
        float fl2 = fbm2(vec2(a * 7.0 - uTime * 0.08, r * 6.0 - uTime * 0.6) + 11.0);
        float ring = exp(-pow((r - 1.0) * 14.0, 2.0));
        float corona = exp(-(r - 1.0) * 2.6) * step(1.0, r) * (0.25 + 1.5 * fl * fl);
        float tongues = smoothstep(0.5, 0.85, fl2 + 0.42 - (r - 1.0) * 0.8) * step(1.0, r) * exp(-(r - 1.0) * 1.3)
                      + smoothstep(0.62, 0.8, fbm2(vec2(a * 12.0 + uTime * 0.03, r * 9.0 - uTime * 0.9))) * step(1.0, r) * exp(-(r - 1.0) * 4.0) * 0.8;
        float halo = exp(-(r - 1.0) * 0.9) * 0.22 * step(1.0, r);
        vec3 hot = mix(vec3(1.0, 0.95, 0.8), uRim, 0.35);
        vec3 c = hot * ring * 2.4 + mix(uRim, uRim2, smoothstep(0.0, 0.6, r - 1.0) + fl * 0.3) * (corona * 1.3 + tongues * 1.1) + uRim2 * halo;
        // an inner lip of light just inside the rim (the void sun's edge)
        c += uRim * exp(-pow((r - 0.965) * 40.0, 2.0)) * 0.9;
        c *= uPulse;
        float edge = 1.0 - smoothstep(1.2, 1.4, r);
        c *= edge;
        gl_FragColor = vec4(c * (1.0 - disc), disc);
      }`,
  });
}

function tearMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'vtp:epoch:tear', transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide, ...PREMUL,
    uniforms: { uTime: { value: 0 }, uPulse: { value: 1 }, uCol: { value: new THREE.Color('#c040ff') } },
    vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uPulse; uniform vec3 uCol; varying vec2 vUv;
      ${NOISE}
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        // a jagged, slightly diagonal tear: its half-width tapers to both tips and is broken up by noise
        float x = p.x + p.y * 0.35;
        float w = (1.0 - p.y * p.y) * 0.22 * (0.7 + 0.6 * fbm2(vec2(p.y * 6.0, uTime * 0.2)));
        float jag = fbm2(vec2(p.y * 14.0, 3.0)) * 0.12 - 0.06;
        float dx = abs(x - jag) / max(w, 1e-3);
        float inside = 1.0 - smoothstep(0.85, 1.0, dx);
        float edge = exp(-pow((dx - 1.0) * 3.0, 2.0)) * (1.0 - p.y * p.y);
        float sw = fbm2(vec2(x * 8.0 + uTime * 0.3, p.y * 5.0 - uTime * 0.2));
        vec3 interior = mix(vec3(0.02, 0.0, 0.05), uCol * 0.5, sw * 0.6) + vec3(0.9, 0.4, 1.0) * pow(sw, 6.0) * 1.5;
        vec3 glow = mix(uCol, vec3(1.0, 0.6, 0.9), 0.3) * (edge * 1.6 + exp(-dx * 0.9) * 0.35 * (1.0 - abs(p.y)));
        vec3 c = (interior * inside + glow * (1.0 - inside * 0.6)) * uPulse;
        float fade = (1.0 - smoothstep(0.7, 1.0, abs(p.x))) * (1.0 - smoothstep(0.85, 1.0, abs(p.y)));
        gl_FragColor = vec4(c * fade, inside * 0.95 * fade);
      }`,
  });
}

function riftMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'vtp:epoch:rift', transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide, ...PREMUL,
    uniforms: { uTime: { value: 0 }, uOpen: { value: 1 }, uFlash: { value: 0 }, uPulse: { value: 1 }, uSeed: { value: 0 },
      uCol: { value: new THREE.Color('#7ad8ff') }, uCol2: { value: new THREE.Color('#c070ff') }, uCore: { value: 1 } },
    vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uOpen, uFlash, uPulse, uSeed, uCore; uniform vec3 uCol, uCol2; varying vec2 vUv;
      ${NOISE}
      void main() {
        vec2 p = (vUv - 0.5) * 2.4;                     // rim radius 1 (the quad is 1.2 radii wide)
        float R = max(0.001, uOpen);
        vec2 q = p / R;
        float r = length(q); float a = atan(q.y, q.x);
        // wobbling rim
        float wob = 1.0 + 0.05 * sin(a * 5.0 + uTime * 2.0 + uSeed) + 0.04 * (n2(vec2(a * 3.0, uTime * 0.8 + uSeed)) - 0.5);
        float rn = r / wob;
        float inside = 1.0 - smoothstep(0.96, 1.0, rn);
        // the vortex: spiral arms drawn inward
        float sp = a * 2.0 + log(rn + 0.02) * 3.2 + uTime * 1.3 + uSeed;
        float arms = fbm2(vec2(sp * 1.2, rn * 3.0 - uTime * 0.9)) ;
        float s2 = 0.5 + 0.5 * sin(sp * 3.0 + arms * 5.0);
        vec3 deep = mix(vec3(0.01, 0.02, 0.06), uCol2 * 0.35, smoothstep(0.2, 1.0, rn));
        vec3 swirl = mix(uCol2, uCol, s2) * pow(arms, 1.6) * (0.4 + 1.3 * rn) ;
        vec3 core = vec3(0.85, 0.95, 1.0) * exp(-rn * rn * 14.0) * 1.4 * uCore;
        // rim: bright ring + crackling filaments just outside
        float ring = exp(-pow((rn - 0.985) * 22.0, 2.0));
        float crack = smoothstep(0.72, 0.95, fbm2(vec2(a * 9.0 + uSeed, uTime * 3.0))) * exp(-abs(rn - 1.05) * 12.0);
        float outer = exp(-max(0.0, rn - 1.0) * 5.0) * step(1.0, rn) * 0.55;
        vec3 c = (deep + swirl * 0.9 + core) * inside + mix(uCol, vec3(1.0), 0.45) * ring * 2.2 + uCol * (crack * 1.8 + outer);
        c *= uPulse * (1.0 + uFlash * 1.5);
        c += vec3(0.8, 0.95, 1.0) * uFlash * exp(-rn * rn * 2.0) * 1.2;
        float vis = smoothstep(0.0, 0.08, uOpen);
        float lim = 1.0 - smoothstep(1.1, 1.18, r * R);  // stay inside the quad
        gl_FragColor = vec4(c * vis * lim, inside * 0.97 * vis);
      }`,
  });
}

// ------------------------------------------------------------------ helpers
const smooth = (x: number) => { const k = Math.min(1, Math.max(0, x)); return k * k * (3 - 2 * k); };
function hashN(s: string) { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 10000) / 10000; }

export class EpochScene {
  private rt: SceneRuntime | null = null;
  private cfg: EpochCfg | null = null;
  private group = new THREE.Group();
  private restore: { mesh: THREE.Mesh; mat: THREE.Material | THREE.Material[] }[] = [];
  private sky: THREE.ShaderMaterial | null = null;
  private eclipse: THREE.ShaderMaterial | null = null;
  private tear: { mat: THREE.ShaderMaterial; node: THREE.Object3D } | null = null;
  private voidlings: { o: THREE.Object3D; mat: THREE.MeshBasicMaterial; seed: number }[] = [];
  private rifts: Rift[] = [];
  private spins: Spin[] = [];
  private sways: { o: THREE.Object3D; rest: THREE.Quaternion; ph: number; amp: number; period: number }[] = [];
  private shards: { mesh: THREE.InstancedMesh; specs: { c: THREE.Vector3; r: number; n: number; ring: boolean; q: THREE.Quaternion; seed: number; start: number }[] } | null = null;
  private fx: Particles[] = [];
  private patrons: Patrons | null = null;
  /** era shifts (scene.json `eras`, src/scene/epoch/eras.ts) + each era's own background NPCs */
  eras: EraDirector | null = null;
  private eraPatrons = new Map<number, Patrons>();
  private eraShown = -1;
  private probes = new Map<string, Probe[]>();
  private addMats: THREE.Material[] = [];
  private palettes: THREE.Color[][] = [];
  private gateFlare = 0;
  private doorFlare = 0;
  private perf = { avg: 0, peak: 0 };
  private gen = 0;
  manual = false;
  clock = 0;

  now() { return this.manual ? this.clock : (Date.now() % (86400 * 1000)) / 1000; }
  /** era timeline clock (epoch ms); tests: .manual = true + .eraClock = <ms> (e.g. vtpOut.sceneState.era.base + phase * 1000) */
  eraClock = 0;
  eraNow() { return this.manual && this.eraClock ? this.eraClock : Date.now(); }

  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    const cfg = (rt.info as unknown as { epoch?: EpochCfg }).epoch;
    if (!cfg) return;
    this.rt = rt; this.cfg = cfg;
    this.clock = this.now();
    this.group.name = 'vtp:epoch';
    rt.root.add(this.group);
    try { this.build(rt, cfg); } catch (e) { console.warn('epoch: build failed', e); }
  }

  detach() {
    this.gen++;
    for (const r of this.restore) r.mesh.material = r.mat;
    this.restore = [];
    for (const s of this.spins) { s.o.quaternion.copy(s.rest); s.o.position.copy(s.restP); }
    for (const s of this.sways) s.o.quaternion.copy(s.rest);
    this.spins = []; this.sways = [];
    for (const r of this.rifts) { r.mesh.removeFromParent(); r.mesh.geometry.dispose(); r.mat.dispose(); }
    this.rifts = [];
    for (const v of this.voidlings) v.mat.dispose();
    this.voidlings = [];
    for (const m of this.addMats) { m.blending = THREE.NormalBlending; m.depthWrite = true; m.transparent = false; m.needsUpdate = true; }
    this.addMats = [];
    for (const f of this.fx) f.dispose();
    this.fx = [];
    if (this.shards) { this.shards.mesh.removeFromParent(); this.shards.mesh.geometry.dispose(); (this.shards.mesh.material as THREE.Material).dispose(); }
    this.shards = null;
    this.patrons?.dispose(); this.patrons = null;
    for (const p of this.eraPatrons.values()) p.dispose();
    this.eraPatrons.clear(); this.eraShown = -1;
    this.eras?.dispose(); this.eras = null;
    this.sky?.dispose(); this.eclipse?.dispose(); this.tear?.mat.dispose();
    this.sky = null; this.eclipse = null; this.tear = null;
    this.probes.clear();
    this.group.removeFromParent();
    this.group = new THREE.Group();
    this.rt = null; this.cfg = null;
  }

  // ------------------------------------------------------------------ build
  private swapMat(o: THREE.Object3D | undefined, m: THREE.Material) {
    if (!o) return;
    o.traverse((c) => {
      const mesh = c as THREE.Mesh;
      if (!mesh.isMesh) return;
      this.restore.push({ mesh, mat: mesh.material });
      mesh.material = m;
      mesh.frustumCulled = false;
    });
  }

  private build(rt: SceneRuntime, cfg: EpochCfg) {
    const root = rt.room.root;
    root.updateMatrixWorld(true);
    const nodes = new Map<string, THREE.Object3D>();
    root.traverse((o) => { if (o.name && !nodes.has(o.name)) nodes.set(o.name, o); });
    // the far backdrop ships hidden (extras hiddenUntilBroken + epochShow) so the room's bounds / occluders stay the stage
    root.traverse((o) => { if ((o.userData as Record<string, unknown> | undefined)?.epochShow === true) o.visible = true; });
    const extras = (o: THREE.Object3D) => (o.userData ?? {}) as Record<string, unknown>;
    const wp = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
    const localOf = (p: THREE.Vector3) => this.group.worldToLocal(p.clone());
    // probes: the light show's live level / colour per EMIT group
    for (const e of rt.room.emissive) {
      const list = this.probes.get(e.group) ?? [];
      list.push({ m: e.material, base: e.baseIntensity || 1, baseColor: e.baseColor.clone() });
      this.probes.set(e.group, list);
    }
    const erasCfg = (rt.info as unknown as { eras?: RoomErasConfig }).eras;
    if (erasCfg?.list?.length) {
      this.eras = new EraDirector(rt.info.id, erasCfg, root, (f) => sceneFileUrl(rt.info.id, f), rt.stage);
      this.group.add(this.eras.group);
    }
    // sky + eclipse + tear
    const eclNode = nodes.get(cfg.eclipse?.node ?? 'ECLIPSE');
    const eclDir = eclNode ? wp(eclNode).normalize() : new THREE.Vector3(-0.47, 0.25, -0.85).normalize();
    this.sky = skyMaterial();
    (this.sky.uniforms.uEcl.value as THREE.Vector3).copy(eclDir);
    this.swapMat(nodes.get(cfg.sky?.node ?? 'VOID_SKY'), this.sky);
    nodes.get(cfg.sky?.node ?? 'VOID_SKY')?.traverse((c) => { c.renderOrder = -10; });
    this.palettes = (cfg.sky?.palettes ?? [['#2a0a4a', '#d0307a', '#3a8ad8']]).map((p) => p.map((h) => new THREE.Color(h)));
    if (eclNode) {
      this.eclipse = eclipseMaterial();
      if (cfg.eclipse?.rim) (this.eclipse.uniforms.uRim.value as THREE.Color).set(cfg.eclipse.rim);
      if (cfg.eclipse?.rim2) (this.eclipse.uniforms.uRim2.value as THREE.Color).set(cfg.eclipse.rim2);
      this.swapMat(eclNode, this.eclipse);
      eclNode.traverse((c) => { c.renderOrder = -9; });
    }
    const tearNode = nodes.get(cfg.tear?.node ?? 'VOID_TEAR');
    if (tearNode) {
      const m = tearMaterial();
      this.swapMat(tearNode, m);
      tearNode.traverse((c) => { c.renderOrder = -8; });
      this.tear = { mat: m, node: tearNode };
      for (let i = 1; i <= (cfg.tear?.voidlings ?? 5); i++) {
        const o = nodes.get(`VOIDLING_${String(i).padStart(2, '0')}`);
        if (!o) continue;
        let src: THREE.MeshStandardMaterial | null = null;
        o.traverse((c) => { const mm = (c as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if (mm && !src) src = mm; });
        const mat = new THREE.MeshBasicMaterial({ name: 'vtp:epoch:voidling', map: (src as THREE.MeshStandardMaterial | null)?.map ?? null, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide, opacity: 0 });
        this.swapMat(o, mat);
        o.traverse((c) => { c.renderOrder = -7; });
        this.voidlings.push({ o, mat, seed: i * 1.618 });
      }
    }
    // rifts
    const rc = cfg.rifts ?? {};
    for (const [n, o] of nodes) {
      if (!/^RIFT_/.test(n)) continue;
      const x = extras(o);
      const r = Number(x.radius ?? x.r ?? 1.5), sy = Number(x.sy ?? 1);
      const mat = riftMaterial();
      if (rc.color) (mat.uniforms.uCol.value as THREE.Color).set(rc.color);
      if (rc.color2) (mat.uniforms.uCol2.value as THREE.Color).set(rc.color2);
      const kind = String(x.kind ?? 'wild');
      mat.uniforms.uSeed.value = hashN(n) * 40;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.4 * r, 2.4 * r * sy), mat);
      mesh.name = 'vtp:epoch:' + n;
      mesh.renderOrder = kind === 'gate' ? 1 : 3;
      mesh.frustumCulled = false;
      o.add(mesh);                                    // the empty's +Z faces the viewer; PlaneGeometry faces +Z
      this.rifts.push({ node: o, mesh, mat, r, kind, period: Number(x.period ?? 60), open: Number(x.open ?? 20), phase: Number(x.phase ?? 0), seed: hashN(n), sy });
    }
    // additive EMIT groups (clones made by the light show keep their names)
    const add = new Set((cfg.additive ?? []).map((g) => 'EMIT_' + g));
    root.traverse((c) => {
      const m = (c as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      for (const mm of Array.isArray(m) ? m : [m]) {
        if (!add.has(mm.name.replace(/[._]\d+$/, '')) || this.addMats.includes(mm)) continue;
        mm.blending = THREE.AdditiveBlending; mm.transparent = true; mm.depthWrite = false; mm.needsUpdate = true;
        (c as THREE.Mesh).renderOrder = 2;
        this.addMats.push(mm);
      }
    });
    // spins (scene.json epoch.spin, else the build's epoch_build.spin)
    const spinCfg = cfg.spin ?? (rt.info as unknown as { epoch_build?: { spin?: Record<string, number> } }).epoch_build?.spin ?? {};
    const AXES: Record<string, 'x' | 'y' | 'z'> = { GATE_FRAGMENTS: 'z' };
    const BOB: Record<string, number> = { WAYPOINT_CRYSTAL: 0.12, FORGE_GLYPH: 0.05, HOLO_ECHO: 0.06, RELIC_01: 0.04, RELIC_02: 0.04, RELIC_03: 0.04 };
    for (const [n, v] of Object.entries(spinCfg)) {
      const o = nodes.get(n);
      if (!o) continue;
      const s = typeof v === 'number' ? { rate: v } : v;
      const axis = (s as { axis?: 'x' | 'y' | 'z' }).axis ?? AXES[n] ?? 'y';
      this.spins.push({ o, rest: o.quaternion.clone(), restP: o.position.clone(), rate: s.rate, axis: AX[axis], bob: (s as { bob?: number }).bob ?? BOB[n] ?? 0, ph: hashN(n) * 6.28, swing: (s as { swing?: number }).swing ?? 0 });
    }
    for (const [n, o] of nodes) if (/^SWAY_/.test(n) && !/^SWAY_/.test(o.parent?.name ?? '')) {
      const x = extras(o);
      this.sways.push({ o, rest: o.quaternion.clone(), ph: hashN(n) * 6.28, amp: THREE.MathUtils.degToRad(Number(x.amp ?? 3)), period: Number(x.period ?? 3.6) });
    }
    // time shards (one instanced draw for every SHARDS_xx anchor)
    const specs: NonNullable<EpochScene['shards']>['specs'] = [];
    const cols: THREE.Color[] = [];
    let total = 0;
    for (const [n, o] of nodes) {
      if (!/^SHARDS_/.test(n)) continue;
      const x = extras(o);
      const cnt = Math.max(1, Math.min(60, Number(x.count ?? 10)));
      specs.push({ c: localOf(wp(o)), r: Number(x.radius ?? 1), n: cnt, ring: !!x.ring, q: new THREE.Quaternion(), seed: hashN(n) * 100, start: total });
      for (let k = 0; k < cnt; k++) cols.push(new THREE.Color(String(x.color ?? '#9fe8ff')));
      total += cnt;
    }
    if (total) {
      const g = new THREE.OctahedronGeometry(1, 0);
      g.scale(0.5, 1.6, 0.5);
      const m = new THREE.MeshBasicMaterial({ name: 'vtp:epoch:shards', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
      const mesh = new THREE.InstancedMesh(g, m, total);
      mesh.name = 'vtp:epoch:shards'; mesh.frustumCulled = false; mesh.renderOrder = 4;
      cols.forEach((c, i) => mesh.setColorAt(i, c));
      this.group.add(mesh);
      this.shards = { mesh, specs };
    }
    // particles: motes at FX_MOTES_xx + a plaza-wide time dust, embers + flames at FX_EMBERS_xx
    const pts = (re: RegExp) => [...nodes.entries()].filter(([n]) => re.test(n)).map(([, o]) => localOf(wp(o)));
    const addFx = (p: Particles, color?: string) => { if (color) ((p.points.material as THREE.ShaderMaterial).uniforms.uColor.value as THREE.Color).set(color); this.fx.push(p); this.group.add(p.points); };
    const motes = pts(/^FX_MOTES_/);
    if (motes.length) addFx(new Particles('motes', motes, 40), '#8adcff');
    const dust: THREE.Vector3[] = [];
    for (let i = 0; i < 16; i++) { const a = i * 2.399, d = 2 + Math.sqrt(i / 16) * 9; dust.push(localOf(new THREE.Vector3(Math.cos(a) * d, -0.2, -1 + Math.sin(a) * d))); }
    addFx(new Particles('motes', dust, 14), '#ffd28a');
    const emb = pts(/^FX_EMBERS_/);
    if (emb.length) { addFx(new Particles('embers', emb, 30)); addFx(new Particles('flame', emb, 24)); }
    // the react screen: its power-on becomes the rift's shimmer
    const scr = rt.screen as unknown as { fx?: { setStyle?: (s: string) => void } } | null;
    if (scr?.fx?.setStyle && cfg.screen?.powerOn) scr.fx.setStyle(cfg.screen.powerOn);
    // background hub NPCs
    if (cfg.patrons?.list?.length && !this.eras) {
      const P = new Patrons(cfg.patrons);
      this.patrons = P;
      this.group.add(P.group);
      const g0 = this.gen;
      void P.load(sceneFileUrl(rt.info.id, cfg.patrons.units ?? 'npc/eot_units.glb'), (p) => root.localToWorld(p), () => this.gen === g0 && this.rt === rt);
    }
  }

  /** live level (≈1 = authored) + colour of an EMIT group from the light show */
  private probe(group: string | undefined, out: THREE.Color): number {
    const list = group ? this.probes.get(group) : undefined;
    if (!list?.length) { out.set(1, 1, 1); return 1; }
    const p = list[0];
    const lvl = p.m.emissiveIntensity / p.base;
    // colour relative to the authored one: 1,1,1 unless a palette recoloured the group
    const b = p.baseColor;
    out.setRGB(p.m.emissive.r / Math.max(0.02, b.r), p.m.emissive.g / Math.max(0.02, b.g), p.m.emissive.b / Math.max(0.02, b.b));
    const mx = Math.max(out.r, out.g, out.b, 1e-3);
    out.multiplyScalar(1 / mx);
    return Math.max(0, Math.min(3, lvl));
  }

  // ------------------------------------------------------------------ frame
  update(dt: number) {
    if (!this.rt) return;
    const t0 = performance.now();
    try { this.step(dt); } catch (e) { console.warn('epoch: frame failed', e); }
    const ms = performance.now() - t0;
    this.perf.avg += (ms - this.perf.avg) * 0.05;
    this.perf.peak = Math.max(this.perf.peak * 0.995, ms);
  }

  private step(dt: number) {
    const rt = this.rt!, cfg = this.cfg!;
    if (this.manual) this.clock += dt;
    const t = this.now();
    let level = 'balanced';
    try { level = gfxBudget().level; } catch { /* default */ }
    const house = (rt.state.lights as unknown as { state?: string } | undefined)?.state === 'brb' ? 0.7 : 1;
    const camE = rt.stage.camera;
    const pxE = (rt.stage.renderer.domElement.height || 1080) / (2 * Math.tan(THREE.MathUtils.degToRad(camE.fov) / 2));
    const eraState = (rt.state as unknown as { era?: SceneEraState }).era;
    this.eras?.update(eraState, this.eraNow(), t, camE, pxE, level);
    const EB = this.eras?.blend ?? null;
    if (this.eras && EB) this.eraNpcs(EB.k > 0.5 ? EB.to : EB.current);
    // --- sky: era palette cycle + light-show pulse / recolour
    if (this.sky) {
      const u = this.sky.uniforms;
      u.uTime.value = t % 7200;
      u.uOct.value = level === 'performance' ? 3 : level === 'ultra' ? 5 : 4;
      const P = this.palettes, cyc = Math.max(30, cfg.sky?.cycle ?? 420);
      const x = (t / cyc) % P.length, i = Math.floor(x), f = smooth((x - i - 0.7) / 0.3);
      const A = P[i], B = P[(i + 1) % P.length];
      const lv = this.probe(cfg.sky?.probe, tc2);
      (u.uA.value as THREE.Color).copy(A[0]).lerp(B[0], f);
      (u.uB.value as THREE.Color).copy(A[1]).lerp(B[1], f).multiply(tc.copy(tc2).lerp(new THREE.Color(1, 1, 1), 0.35));
      (u.uC.value as THREE.Color).copy(A[2]).lerp(B[2], f);
      u.uPulse.value = (0.55 + 0.45 * Math.min(2, lv)) * (1 + (EB?.build ?? 0) * 0.6);
      u.uHouse.value = house;
      if (EB) {
        u.uVoid.value = EB.void; (u.uZen.value as THREE.Color).copy(EB.zen); (u.uHor.value as THREE.Color).copy(EB.hor); (u.uGnd.value as THREE.Color).copy(EB.gnd);
        (u.uSunD.value as THREE.Vector3).copy(EB.sun); (u.uSunC.value as THREE.Color).copy(EB.sunCol); u.uCloud.value = EB.clouds; (u.uCloudC.value as THREE.Color).copy(EB.cloudCol);
        u.uStars.value = EB.stars; u.uFlash.value = EB.flash;
        const eraPal = this.eras!.defs[EB.k > 0.5 ? EB.to : EB.current]?.sky?.palettes;
        if (eraPal && eraPal !== cfg.sky?.palettes) { (u.uA.value as THREE.Color).copy(EB.palA); (u.uB.value as THREE.Color).copy(EB.palB).multiply(tc.copy(tc2).lerp(new THREE.Color(1, 1, 1), 0.35)); (u.uC.value as THREE.Color).copy(EB.palC); }
      }
    }
    if (this.eclipse) {
      const u = this.eclipse.uniforms;
      u.uTime.value = t % 7200;
      const lv = this.probe(cfg.eclipse?.probe, tc2);
      u.uPulse.value = (0.7 + 0.3 * Math.min(2.2, lv)) * (EB ? EB.eclipse : 1) * (1 + (EB?.flash ?? 0));
      if (EB) { (u.uRim.value as THREE.Color).copy(EB.rim); (u.uRim2.value as THREE.Color).copy(EB.rim2); }
      const en = this.rt?.room.root.getObjectByName(cfg.eclipse?.node ?? 'ECLIPSE');
      if (en) en.visible = !EB || EB.eclipse > 0.01;
    }
    if (this.tear) {
      this.tear.mat.uniforms.uTime.value = t % 7200;
      const lv = this.probe(cfg.tear?.probe, tc2);
      this.tear.mat.uniforms.uPulse.value = (0.6 + 0.4 * Math.min(2, lv)) * (EB ? EB.tear : 1);
      this.tear.node.visible = !EB || EB.tear > 0.01;
      // void creatures: each drifts out of the tear, lingers, sinks back (pure function of the clock)
      const tp = this.tear.node.getWorldPosition(tv);
      const cam = rt.stage.camera;
      for (const v of this.voidlings) {
        const per = 38 + v.seed * 9, u2 = ((t + v.seed * 17) % per) / per;
        const out = Math.sin(Math.PI * Math.min(1, u2 / 0.8));
        const dir = new THREE.Vector3(Math.cos(v.seed * 2.3), Math.sin(v.seed * 1.7) * 0.5, Math.sin(v.seed * 2.3) * 0.3);
        const size = 7 + (v.seed % 1) * 8;
        const p = tp.clone().addScaledVector(dir, 10 + out * 28).add(new THREE.Vector3(0, Math.sin(t * 0.3 + v.seed) * 3, 0));
        v.o.parent ? v.o.parent.worldToLocal(p) : null;
        v.o.position.copy(p);
        v.o.quaternion.copy(cam.quaternion);
        v.o.scale.setScalar(size * (0.6 + 0.4 * out));
        v.mat.opacity = Math.min(1, out * 1.4) * 0.85 * (EB ? EB.tear : 1);
        v.o.visible = out > 0.02;
      }
    }
    // --- rifts
    const rl = this.probe(cfg.rifts?.probe, tc2);
    const screen = rt.screen as unknown as { progress?: number; target?: number } | null;
    const react = (screen?.target ?? 0) > 0.5;
    this.gateFlare += ((react ? 1 : 0) - this.gateFlare) * Math.min(1, dt * 1.6);
    const door = rt.room.door;
    let doorOpen = 0;
    if (door) doorOpen = Math.min(1, (2 * Math.acos(Math.min(1, Math.abs(door.node.quaternion.dot(door.rest))))) / THREE.MathUtils.degToRad(Math.abs(door.openAngle) || 90));
    this.doorFlare += (doorOpen - this.doorFlare) * Math.min(1, dt * 5);
    for (const r of this.rifts) {
      const u = r.mat.uniforms;
      u.uTime.value = (t + r.seed * 50) % 3600;
      let open = 1, flash = 0;
      if (r.kind === 'gate') {
        open = 0.93 + 0.03 * Math.sin(t * 0.7) + 0.07 * this.gateFlare;
        flash = Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, (screen?.progress ?? 0))))) * 0.8 * (react ? 1 : 0.4);
        u.uCore.value = 1 - 0.6 * this.gateFlare;
      } else if (r.kind === 'door') {
        open = 0.62 + 0.38 * this.doorFlare + 0.03 * Math.sin(t * 1.3);
        flash = this.doorFlare * 0.9;
      } else {
        const x = ((t + r.phase) % r.period + r.period) % r.period;
        const o1 = smooth(x / 1.8), o2 = 1 - smooth((x - r.open) / 1.4);
        open = x < r.open + 1.4 ? Math.min(o1, o2) : 0;
        open *= 1 + 0.04 * Math.sin(t * 2.1 + r.seed * 9);
        flash = x < 1.8 ? Math.sin(Math.PI * x / 1.8) * 0.9 : x > r.open && x < r.open + 1.4 ? Math.sin(Math.PI * (x - r.open) / 1.4) * 0.6 : 0;
      }
      if (EB && r.kind !== 'gate' && r.kind !== 'door') open *= EB.rifts;
      if (EB) flash = Math.max(flash, EB.flash * (r.kind === 'gate' ? 1.2 : 0.6) + (r.kind === 'gate' ? 0 : EB.build * 0.25));
      u.uOpen.value = open; u.uFlash.value = flash;
      u.uPulse.value = (0.65 + 0.35 * Math.min(2.2, rl)) * (r.kind === 'gate' && EB ? 1 - 0.55 * EB.build : 1);
      if (cfg.rifts?.color) (u.uCol.value as THREE.Color).set(cfg.rifts.color).multiply(tc.copy(tc2).lerp(new THREE.Color(1, 1, 1), 0.3));
      r.mesh.visible = open > 0.002;
    }
    // --- spins, bobs, sways
    for (const s of this.spins) {
      // swing (radians amplitude) = rock back and forth; else a full turn every 1 / rate s
      const ang = s.swing ? s.swing * Math.sin(t * s.rate * Math.PI * 2 + s.ph) : (t * s.rate * Math.PI * 2) % (Math.PI * 2);
      s.o.quaternion.copy(s.rest).multiply(tq.setFromAxisAngle(s.axis, ang));
      if (s.bob) s.o.position.set(s.restP.x, s.restP.y + Math.sin(t * 0.9 + s.ph) * s.bob, s.restP.z);
    }
    for (const s of this.sways) {
      const w = (Math.PI * 2) / s.period;
      const a = s.amp * (Math.sin(t * w + s.ph) + 0.3 * Math.sin(t * w * 2.3 + s.ph * 2));
      s.o.quaternion.copy(s.rest).multiply(tq.setFromAxisAngle(AX.x, a));
    }
    // --- shards orbit
    if (this.shards) {
      const M = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
      for (const s of this.shards.specs) {
        for (let k = 0; k < s.n; k++) {
          const h = (k + 1) * 0.6180339 + s.seed;
          const f = h - Math.floor(h);
          const sp = 0.12 + f * 0.25;
          const a = f * Math.PI * 2 + t * sp * (k % 2 ? 1 : -0.7);
          if (s.ring) p.set(Math.cos(a) * s.r * (0.95 + 0.1 * f), Math.sin(a) * s.r * (0.95 + 0.1 * f), Math.sin(t * 0.5 + k) * 0.25);
          else p.set(Math.cos(a) * s.r * (0.6 + 0.4 * f), Math.sin(t * 0.4 + k * 1.3) * s.r * 0.35, Math.sin(a) * s.r * (0.6 + 0.4 * f));
          p.add(s.c);
          q.setFromEuler(new THREE.Euler(t * (0.6 + f), t * (0.9 + f * 0.5), k));
          const size = (s.ring ? 0.07 : 0.045) * (0.6 + f * 0.9) * (s.r > 3 ? 1.6 : 1);
          sc.setScalar(size * (0.75 + 0.25 * Math.sin(t * 3 + k)));
          M.compose(p, q, sc);
          this.shards.mesh.setMatrixAt(s.start + k, M);
        }
      }
      this.shards.mesh.instanceMatrix.needsUpdate = true;
    }
    // --- particles + patrons
    const cam = rt.stage.camera;
    const px = (rt.stage.renderer.domElement.height || 1080) / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    const share = level === 'performance' ? 0.45 : level === 'balanced' ? 0.7 : level === 'high' ? 0.88 : 1;
    const camPos = cam.getWorldPosition(new THREE.Vector3());
    for (const f of this.fx) f.update(t, px, share, camPos);
    if (this.patrons || this.eraPatrons.size) {
      const faces: THREE.Vector3[] = [];
      for (const a of rt.actors.values()) { if (!a.shown || !a.spot) continue; const fc = a.faceAt(a.spot); if (fc) faces.push(fc.center); }
      this.patrons?.update(t, dt, cam, faces, gfxBudget().lodBias ?? 1);
      for (const p of this.eraPatrons.values()) if (p.group.visible) p.update(t, dt, cam, faces, gfxBudget().lodBias ?? 1);
    }
  }

  /** background NPCs of the era showing (lazily loaded once per era, then just shown / hidden) */
  private eraNpcs(i: number) {
    if (!this.eras || !this.rt || i === this.eraShown) return;
    this.eraShown = i;
    const rt = this.rt, cfg = this.cfg!;
    for (const [k, p] of this.eraPatrons) p.group.visible = k === i;
    if (this.eraPatrons.has(i)) return;
    const list = this.eras.defs[i]?.patrons ?? (i === 0 ? cfg.patrons?.list : undefined);
    if (!list?.length) return;
    const P = new Patrons({ units: cfg.patrons?.units, scale: cfg.patrons?.scale, list: list.map((x, j) => ({ name: x.name ?? `${this.eras!.defs[i].id}_${j}`, ...x })) });
    this.eraPatrons.set(i, P);
    this.group.add(P.group);
    const g0 = this.gen, root = rt.room.root;
    void P.load(sceneFileUrl(rt.info.id, cfg.patrons?.units ?? 'npc/eot_units.glb'), (p) => root.localToWorld(p), () => this.gen === g0 && this.rt === rt);
  }

  info() {
    return { on: !!this.rt, eras: this.eras ? this.eras.info((this.rt?.state as unknown as { era?: SceneEraState } | undefined)?.era, this.eraNow()) : null, rifts: this.rifts.map((r) => `${r.node.name}:${(r.mat.uniforms.uOpen.value as number).toFixed(2)}`), spins: this.spins.length, sways: this.sways.length,
      shards: this.shards?.mesh.count ?? 0, fx: this.fx.length, patrons: this.patrons?.count ?? 0, patronErr: this.patrons?.error || undefined,
      additive: this.addMats.length, ms: +this.perf.avg.toFixed(3), peak: +this.perf.peak.toFixed(3) };
  }
  debug() { return this.info(); }
}
