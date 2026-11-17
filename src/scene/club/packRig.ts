// The club's own show-pack rig (rooms with a scene.json `club`): moving heads on the trusses, beam bars on the stage
// lip, laser emitters (stage corners, the DJ booth, the side walls) and a pixel ceiling over the dance floor, all
// playing the show-pack program the room's light director picked for this phrase (shared/showPack/director.ts) - so the
// LIGHT_* fixtures, the beams, the lasers and the ceiling move as one show. Four draw calls: beam cones, laser rays,
// laser sheets, the ceiling.
//
// Counts scale with the graphics tier (low: nothing) and the room's boost (scene.json club.rig.boost 1..2, like the
// festival's `boost`: a room built for a faster GPU draws up to twice the tier's fixtures). Anchors: FX_BEAM_* / FX_LASER_*
// (the room's own), then automatic rows from the room's inside (its walls / ceiling) and the DJ spot.
// Photosensitivity: every output passes the festival's two-stage governor (src/scene/festival/gov.ts: the room's
// governor, then a stage gate with windows >= 334 ms and 150 ms ramps, so any region the rig draws turns <= 3 a second); with Safe flashes ON the rig moves
// on a calmer clock, rays dim with their swing speed and a new pattern fades in, the ceiling breathes on the slow wall
// pulse. Beams / rays that pass between the camera and a performer's face (close shots) fade out. Never touches alpha.
import * as THREE from 'three';
import type { QualityTier } from '../../tracking/Tracker.ts';
import type { FestivalGov, GovOwner } from '../festival/gov.ts';
import { packLaser, packMover, packRay, type MoverOutLike, type PackFrame, type PackLaserOut, type Program } from '../../../shared/showPack/program.ts';
import { packRayCount, packRaySwing } from '../../../shared/showPack/festival.ts';
import { laserFormById, type PackGeo } from '../../../shared/showPack/forms.ts';
import { PACK_WALLS, PACK_WALL_GLSL, isPackWall } from '../../../shared/showPack/walls.ts';
import { WALL_CALM, wallPulse } from '../../../shared/festivalWall.ts';
import { aimDir, fxMaterial, glow, lin } from '../festival/common.ts';
/** linear → sRGB 0..1 (the governor takes sRGB, as the festival's looks give it) */
const srgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055);
import { clubPackBudget, type PackRigBudget } from '../../../shared/showPack/clubBudget.ts';
export { CLUB_PACK_BUDGET, clubPackBudget } from '../../../shared/showPack/clubBudget.ts';

const BEAM_VS = /* glsl */ `
varying float vAlong; varying float vFres; varying vec3 vCol;
void main() {
  mat4 im = instanceMatrix;
  vec4 mv = modelViewMatrix * im * vec4(position, 1.0);
  vec3 nn = normalMatrix * mat3(im) * normal;
  vec3 n = nn / max(length(nn), 1e-6);
  vFres = abs(dot(n, normalize(-mv.xyz)));
  vAlong = uv.y;
  vCol = instanceColor;
  gl_Position = projectionMatrix * mv;
}`;
const BEAM_FS = /* glsl */ `
uniform float uHaze;
varying float vAlong; varying float vFres; varying vec3 vCol;
void main() {
  float a = pow(clamp(vFres, 0.0, 1.0), 1.4) * (0.2 + 0.8 * pow(clamp(vAlong, 0.0, 1.0), 1.3)) * uHaze;
  gl_FragColor = vec4(vCol, a);
}`;
const RAY_VS = /* glsl */ `
attribute vec3 aOrigin; attribute vec4 aDir; attribute vec4 aCol;
uniform float uSafe;
varying vec2 vUv; varying vec3 vCol;
void main() {
  vec3 o = (modelMatrix * vec4(aOrigin, 1.0)).xyz;
  vec3 d = normalize(mat3(modelMatrix) * aDir.xyz);
  vec3 p = o + d * aDir.w * position.y;
  vec3 view = normalize(cameraPosition - p);
  vec3 side = normalize(cross(d, view) + vec3(1e-5, 0.0, 0.0));
  float w = max(aCol.w, length(cameraPosition - p) * mix(0.0022, 0.0035, uSafe));
  p += side * position.x * w * 6.0;
  vUv = vec2(position.x + 0.5, position.y);
  vCol = aCol.rgb;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const RAY_FS = /* glsl */ `
uniform float uSafe;
varying vec2 vUv; varying vec3 vCol;
void main() {
  float x = abs(vUv.x - 0.5) * 2.0;
  float core = mix(exp(-x * x * 120.0), exp(-x * x * 10.0) * 0.4, uSafe), halo = exp(-x * 5.0) * 0.18;
  float along = (1.0 - pow(clamp(vUv.y, 0.0, 1.0), 2.0)) * smoothstep(0.0, 0.01, vUv.y);
  float a = (core * 1.6 + halo) * along;
  gl_FragColor = vec4(vCol * a, a);
}`;
const SHEET_VS = /* glsl */ `
attribute vec3 aOrigin; attribute vec4 aA; attribute vec4 aB; attribute vec3 aCol;
varying vec3 vBary; varying vec3 vCol; varying float vAlpha;
void main() {
  vec3 o = (modelMatrix * vec4(aOrigin, 1.0)).xyz;
  vec3 a = o + normalize(mat3(modelMatrix) * aA.xyz) * aA.w;
  vec3 b = o + normalize(mat3(modelMatrix) * aB.xyz) * aA.w;
  int k = int(position.x + 0.5);
  vec3 p = k == 0 ? o : k == 1 ? a : b;
  vBary = k == 0 ? vec3(1.0, 0.0, 0.0) : k == 1 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
  vCol = aCol; vAlpha = aB.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const SHEET_FS = /* glsl */ `
varying vec3 vBary; varying vec3 vCol; varying float vAlpha;
void main() {
  float along = 1.0 - vBary.x;
  float a = vAlpha * (1.0 - along * along) * smoothstep(0.0, 0.03, along);
  gl_FragColor = vec4(vCol * a, a);
}`;
// the pixel ceiling: LED dots drawing a pack wall pattern (additive: dark pixels add nothing, the room's ceiling shows)
const CEIL_VS = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const CEIL_FS = /* glsl */ `
precision highp float;
#define PI 3.14159265
varying vec2 vUv;
uniform float uT, uBeat, uKick, uEnergy, uMode, uAspect, uPix, uLevel;
uniform vec3 uA, uB, uC;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { return 0.5 * n2(p) + 0.25 * n2(p * 2.1) + 0.125 * n2(p * 4.3) + 0.0625 * n2(p * 8.7); }
vec3 pal(float t) { t = fract(t); return t < 0.333 ? mix(uA, uB, t * 3.0) : t < 0.666 ? mix(uB, uC, (t - 0.333) * 3.0) : mix(uC, uA, (t - 0.666) * 3.0); }
${PACK_WALL_GLSL}
void main() {
  vec2 grid = vec2(floor(uPix * uAspect), uPix);
  vec2 cell = floor(vUv * grid); vec2 uv = (cell + 0.5) / grid;
  float led = smoothstep(0.5, 0.25, length(fract(vUv * grid) - 0.5));
  vec3 col = packVisual(uMode, uv) * uLevel;
  gl_FragColor = vec4(col * led * 1.6, led);
}`;

interface Head { pos: THREE.Vector3; geo: PackGeo; kind: 'spot' | 'beam'; ch: GovOwner; out: MoverOutLike; fade: number; pDir?: THREE.Vector3; spd?: number }
interface Emitter { pos: THREE.Vector3; geo: PackGeo; ch: GovOwner; out: PackLaserOut; fadeIn: number; pForm: string; pAx: THREE.Vector3 | null; spd: number; raySw?: Float64Array; raySwOk?: boolean; /** aim bias (deg): side-wall origins shoot across the room, never at the audience side */ bias: number }
export interface PackRigIn {
  program: Program | null;
  /** the moment (PackFrame without colours / mb / safe / level: filled here) */
  f: PackFrame;
  /** 0..1.2: how much of the rig is on (reactive lights, the lighting state, the music) */
  level: number;
  /** the festival's two-stage governor bound to the room's (src/scene/festival/gov.ts): framed by the caller */
  gov: FestivalGov; safe: boolean;
  /** camera + faces in the rig's (room-local) frame (every performer: nothing in the rig may cross a face) */
  cam: THREE.Vector3; faces: THREE.Vector3[] | null;
  dt: number; t: number;
}
const V = new THREE.Vector3(), V2 = new THREE.Vector3(), P1 = new THREE.Vector3(), Q = new THREE.Quaternion(), M = new THREE.Matrix4(), S = new THREE.Vector3(), C = new THREE.Color(), DOWN = new THREE.Vector3(0, -1, 0);
const RA = { yaw: 0, pitch: 0 };
const MAP_WALL: Record<string, string> = { tunnel: 'pk_zoom', kaleido: 'pk_nebula', spectrum: 'pk_eq', plasma: 'pk_nebula', warp: 'pk_stars', logo: 'pk_ripple', grid: 'pk_check', rings: 'pk_ripple', fire: 'pk_aurora', scanner: 'pk_stripes', starfield: 'pk_stars', bars: 'pk_bars' };

export class PackRig {
  readonly group = new THREE.Group();
  readonly budget: PackRigBudget;
  private heads: Head[] = [];
  private emitters: Emitter[] = [];
  private beamMesh: THREE.InstancedMesh | null = null;
  private rays: THREE.InstancedBufferGeometry | null = null; private rayMesh: THREE.Mesh | null = null;
  private sheets: THREE.InstancedBufferGeometry | null = null; private sheetMesh: THREE.Mesh | null = null;
  private aO = new Float32Array(0); private aD = new Float32Array(0); private aC = new Float32Array(0);
  private sO = new Float32Array(0); private sA = new Float32Array(0); private sB = new Float32Array(0); private sC = new Float32Array(0);
  private ceiling: THREE.Mesh | null = null; private ceilCh: GovOwner = {}; private ceilKick: GovOwner = {};
  private box: THREE.Box3;
  /** +1: the crowd is towards +z of the DJ (the festival aim convention), −1: towards −z (aims turned round) */
  private flip = 1;
  private disposables: { dispose(): void }[] = [];
  private pf: PackFrame;
  /** rays / heads drawn last frame (debug) */
  drawn = { heads: 0, rays: 0, sheets: 0 };
  /** 0..1: how far the show has taken the room down (ClubPack): the haze thickens with it (the beams read in the dark) */
  hazeK = 0;
  private prevRay = new THREE.Vector3();

  constructor(root: THREE.Object3D, box: THREE.Box3, dj: THREE.Vector3 | null, tier: QualityTier, boost = 1, anchors: { beams: THREE.Vector3[]; lasers: THREE.Vector3[] } = { beams: [], lasers: [] }) {
    this.group.name = 'club:pack';
    this.box = box.clone();
    this.budget = clubPackBudget(tier, boost);
    const B = this.budget;
    this.pf = { beat: 0, bar: 0, barPos: 0, bpm: 120, energy: 0, kick: 0, snare: 0, hat: 0, onsets: false, section: 'groove', build: 0, converge: 0, dropAge: Infinity, level: 1, step: 0, mb: 0, safe: true, colors: [[1, 0, 1], [0, 1, 1], [1, 1, 1]] };
    if (!B.heads && !B.lasers && !B.ceiling) { root.add(this.group); return; }
    const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
    const stage = dj ?? new THREE.Vector3(c.x, box.min.y + 1, box.min.z + 2);
    this.flip = c.z >= stage.z ? 1 : -1;
    const ceil = box.max.y - 0.3, toCrowd = this.flip;
    const x0 = box.min.x + Math.min(1, sz.x * 0.1), x1 = box.max.x - Math.min(1, sz.x * 0.1);
    // ---- heads: the room's beam anchors, then a front truss row + a row over the floor
    const headAt: { p: THREE.Vector3; kind: 'spot' | 'beam'; row: number }[] = anchors.beams.slice(0, B.heads).map((p) => ({ p, kind: 'spot' as const, row: 0 }));
    const rest = B.heads - headAt.length, rowA = Math.ceil(rest / 2), rowB = rest - rowA;
    const zA = stage.z + toCrowd * Math.min(3, sz.z * 0.15), zB = THREE.MathUtils.lerp(stage.z, c.z, 0.55);
    for (let i = 0; i < rowA; i++) headAt.push({ p: new THREE.Vector3(x0 + (x1 - x0) * (i + 0.5) / rowA, ceil, zA), kind: 'spot', row: 1 });
    for (let i = 0; i < rowB; i++) headAt.push({ p: new THREE.Vector3(x0 + (x1 - x0) * (i + 0.5) / rowB, ceil, zB), kind: 'spot', row: 2 });
    // ---- beam bars on the stage lip: narrow beams shooting up and out over the crowd
    const lipY = Math.max(box.min.y + 0.3, stage.y - 0.4), lipZ = stage.z + toCrowd * 1.4;
    for (let b = 0; b < B.bars; b++) {
      const cxb = B.bars > 1 ? THREE.MathUtils.lerp(x0 + 1, x1 - 1, b / (B.bars - 1)) : c.x;
      const wBar = Math.min(2.4, (x1 - x0) / Math.max(1, B.bars) * 0.7);
      for (let i = 0; i < B.barHeads; i++) headAt.push({ p: new THREE.Vector3(cxb + (i / Math.max(1, B.barHeads - 1) - 0.5) * wBar, lipY, lipZ), kind: 'beam', row: 3 });
    }
    const xs = headAt.map((h) => h.p.x), xmin = Math.min(...xs), xmax = Math.max(...xs);
    const order = headAt.map((h, i) => ({ h, i })).sort((a, b) => a.h.p.x - b.h.p.x);
    headAt.forEach((h, k) => {
      const geo: PackGeo = { x: xmax > xmin ? ((h.p.x - xmin) / (xmax - xmin)) * 2 - 1 : 0, y: h.kind === 'beam' ? 0.1 : 0.9, z: h.row / 3, i: order.findIndex((o) => o.i === k), n: headAt.length, seed: ((k * 0.618) + h.row * 0.13) % 1 };
      this.heads.push({ pos: h.p, geo, kind: h.kind, ch: {}, out: { level: 0, flash: false, key: '', r: 0, g: 0, b: 0, yaw: 0, pitch: 0, zoom: 0 }, fade: 1 });
    });
    if (this.heads.length) {
      const g = new THREE.CylinderGeometry(0.04, 1, 1, 14, 1, true); g.translate(0, -0.5, 0);
      const mat = fxMaterial(BEAM_VS, BEAM_FS, { uHaze: { value: 0.55 } });
      this.beamMesh = new THREE.InstancedMesh(g, mat, this.heads.length);
      this.beamMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.heads.length * 3), 3);
      this.beamMesh.frustumCulled = false; this.beamMesh.renderOrder = 10; this.beamMesh.name = 'club:pack-beams';
      glow(this.beamMesh); this.group.add(this.beamMesh); this.disposables.push(g, mat);
    }
    // ---- laser emitters: the room's laser anchors, then the stage corners, the DJ booth, the side walls
    const auto = [new THREE.Vector3(x0 + 0.3, ceil - 0.3, stage.z + toCrowd * 0.6), new THREE.Vector3(x1 - 0.3, ceil - 0.3, stage.z + toCrowd * 0.6), new THREE.Vector3(stage.x, Math.min(ceil - 0.4, stage.y + 2.4), stage.z - toCrowd * 0.4),
      new THREE.Vector3(x0 + 0.2, ceil - 0.6, c.z), new THREE.Vector3(x1 - 0.2, ceil - 0.6, c.z),
      new THREE.Vector3(c.x - sz.x * 0.2, ceil - 0.2, zA), new THREE.Vector3(c.x + sz.x * 0.2, ceil - 0.2, zA), new THREE.Vector3(stage.x, ceil - 0.2, zB)];
    const lz = [...anchors.lasers, ...auto].slice(0, B.lasers);
    const lxs = lz.map((p) => p.x), lmin = Math.min(...lxs), lmax = Math.max(...lxs);
    // (the room's own anchors aim as authored; an automatic origin out in the room - a side wall, more than 5 m in front
    // of the DJ - aims across the room towards the middle, never at the audience side)
    const nA = anchors.lasers.length;
    const biasOf = (p: THREE.Vector3, k: number) => (k >= nA && (p.z - stage.z) * toCrowd > 5 ? (p.x < c.x ? 1 : -1) * 70 * toCrowd : 0);
    lz.forEach((p, k) => this.emitters.push({ bias: biasOf(p, k), pos: p, geo: { x: lmax > lmin ? ((p.x - lmin) / (lmax - lmin)) * 2 - 1 : 0, y: (p.y - box.min.y) / Math.max(0.1, sz.y), z: 0.5, i: k, n: lz.length, seed: (k * 0.377) % 1 }, ch: {},
      out: { on: 0, flash: false, key: '', r: 0, g: 0, b: 0, yaw: 0, pitch: 0, spread: 0, spin: 0, form: 'fan', mt: 0, sheet: false, rays: 1, tiers: 1, seed: 0 }, fadeIn: 1, pForm: '', pAx: null, spd: 0 }));
    if (this.emitters.length && B.rays) {
      const max = this.emitters.length * B.rays;
      const q = new THREE.BufferGeometry();
      q.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3)); q.setIndex([0, 1, 2, 0, 2, 3]);
      const rays = this.rays = new THREE.InstancedBufferGeometry(); rays.index = q.index; rays.setAttribute('position', q.getAttribute('position'));
      this.aO = new Float32Array(max * 3); this.aD = new Float32Array(max * 4); this.aC = new Float32Array(max * 4);
      rays.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(this.aO, 3)); rays.setAttribute('aDir', new THREE.InstancedBufferAttribute(this.aD, 4)); rays.setAttribute('aCol', new THREE.InstancedBufferAttribute(this.aC, 4));
      rays.instanceCount = 0;
      this.rayMesh = new THREE.Mesh(rays, fxMaterial(RAY_VS, RAY_FS, { uSafe: { value: 0 } }, { side: THREE.DoubleSide }));
      this.rayMesh.frustumCulled = false; this.rayMesh.renderOrder = 12; this.rayMesh.name = 'club:pack-rays';
      const t = new THREE.BufferGeometry(); t.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]), 3));
      const sh = this.sheets = new THREE.InstancedBufferGeometry(); sh.setAttribute('position', t.getAttribute('position'));
      this.sO = new Float32Array(max * 3); this.sA = new Float32Array(max * 4); this.sB = new Float32Array(max * 4); this.sC = new Float32Array(max * 3);
      sh.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(this.sO, 3)); sh.setAttribute('aA', new THREE.InstancedBufferAttribute(this.sA, 4)); sh.setAttribute('aB', new THREE.InstancedBufferAttribute(this.sB, 4)); sh.setAttribute('aCol', new THREE.InstancedBufferAttribute(this.sC, 3));
      sh.instanceCount = 0;
      this.sheetMesh = new THREE.Mesh(sh, fxMaterial(SHEET_VS, SHEET_FS, {}, { side: THREE.DoubleSide }));
      this.sheetMesh.frustumCulled = false; this.sheetMesh.renderOrder = 11; this.sheetMesh.name = 'club:pack-sheets';
      for (const m of [this.rayMesh, this.sheetMesh]) { glow(m); this.group.add(m); }
      this.disposables.push(q, t, rays, sh, this.rayMesh.material as THREE.Material, this.sheetMesh.material as THREE.Material);
    }
    // ---- the pixel ceiling over the dance floor (between the front truss and the crowd's far end)
    if (B.ceiling && sz.y > 2.4) {
      const zN = stage.z + toCrowd * Math.min(2, sz.z * 0.1), zF = stage.z + toCrowd * Math.max(4, Math.min(sz.z * 0.55, Math.abs((toCrowd > 0 ? box.max.z : box.min.z) - stage.z) - 3));   // (over the dance floor, never over the camera's balcony)
      const w = (x1 - x0) * 0.9, d = Math.abs(zF - zN);
      if (w > 2 && d > 2) {
        const pg = new THREE.PlaneGeometry(w, d); pg.rotateX(Math.PI / 2);   // facing down
        const mat = fxMaterial(CEIL_VS, CEIL_FS, { uT: { value: 0 }, uBeat: { value: 0 }, uKick: { value: 0 }, uEnergy: { value: 0 }, uMode: { value: 0 }, uAspect: { value: w / d }, uPix: { value: Math.max(8, Math.round(B.ceiling * Math.min(1, d / w))) }, uLevel: { value: 0 }, uA: { value: new THREE.Color() }, uB: { value: new THREE.Color() }, uC: { value: new THREE.Color() } }, { side: THREE.DoubleSide });
        this.ceiling = new THREE.Mesh(pg, mat);
        this.ceiling.position.set(c.x, box.max.y - 0.08, (zN + zF) / 2);
        this.ceiling.renderOrder = 9; this.ceiling.name = 'club:pack-ceiling'; this.ceiling.frustumCulled = false;
        glow(this.ceiling); this.group.add(this.ceiling); this.disposables.push(pg, mat);
      }
    }
    root.add(this.group);
  }

  get counts() { return { heads: this.heads.length, bars: this.heads.filter((h) => h.kind === 'beam').length, lasers: this.emitters.length, rays: this.budget.rays, ceiling: !!this.ceiling, drawn: { ...this.drawn } }; }

  /** where a ray from p along unit d leaves the room's inside */
  private hit(p: THREE.Vector3, d: THREE.Vector3, max: number): number {
    let t = max;
    for (const ax of ['x', 'y', 'z'] as const) { const dv = d[ax]; if (Math.abs(dv) < 1e-6) continue; const tt = ((dv > 0 ? this.box.max[ax] : this.box.min[ax]) - p[ax]) / dv; if (tt > 0.05 && tt < t) t = tt; }
    return t;
  }
  /** how close the segment p → p + d·L passes to the camera → face lines (Infinity: no protected faces) */
  private faceDist(p: THREE.Vector3, d: THREE.Vector3, L: number, cam: THREE.Vector3, faces: THREE.Vector3[]): number {
    let best = Infinity;
    for (const f of faces) for (let k = 1; k <= 5; k++) {
      V2.copy(cam).lerp(f, k / 5.5);
      const t = P1.copy(V2).sub(p).dot(d); if (t < 0 || t > L) continue;
      best = Math.min(best, P1.copy(p).addScaledVector(d, t).distanceTo(V2));
    }
    return best;
  }
  /** how close the segment p → p + d·L passes to the camera */
  private camDist(p: THREE.Vector3, d: THREE.Vector3, L: number, cam: THREE.Vector3): number {
    const t = Math.min(L, Math.max(0, P1.copy(cam).sub(p).dot(d)));
    return P1.copy(p).addScaledVector(d, t).distanceTo(cam);
  }
  private dirOf(yaw: number, pitch: number, out: THREE.Vector3) { aimDir(yaw, pitch, out); if (this.flip < 0) { out.x = -out.x; out.z = -out.z; } return out; }

  update(i: PackRigIn) {
    const on = i.level > 0.003 && !!i.program;
    this.group.visible = on;
    if (!on) { this.drawn = { heads: 0, rays: 0, sheets: 0 }; return; }
    const p = i.program!, f = i.f, gov = i.gov;
    const pf = this.pf;
    Object.assign(pf, f);
    pf.safe = i.safe; pf.level = 1;
    pf.mb = i.safe ? f.beat * Math.min(1, 45 / Math.max(40, f.bpm)) : f.beat;
    const k = 1 - Math.exp(-i.dt / 0.12);
    // ---- heads + beam bars
    if (this.beamMesh) {
      // (in a dark room the beams needn't fight the house: a little more haze, less gain - they read, they don't flood)
      const hk = Math.min(1, Math.max(0, this.hazeK)), gain = 1.6 - 0.75 * hk;
      (this.beamMesh.material as THREE.ShaderMaterial).uniforms.uHaze.value = 0.55 + 0.1 * hk;
      let drawn = 0;
      this.heads.forEach((h, n) => {
        const o = packMover(p, h.kind === 'beam' ? 'beam' : 'spot', pf, h.geo, h.out);
        // (beam bars stay under the ceiling: up and out over the crowd, never straight up into it)
        // (beam bars shoot up and out over the crowd - never flat across the stage front, never straight into the ceiling)
        const pitch = h.kind === 'beam' ? 26 + Math.max(0, Math.min(1, (o.pitch - 20) / 70)) * 36 : Math.min(-12, o.pitch);
        this.dirOf(h.kind === 'beam' ? Math.max(-38, Math.min(38, o.yaw)) : o.yaw, pitch, V);
        const L = this.hit(h.pos, V, h.kind === 'beam' ? 24 : 14);
        const rEnd = L * (h.kind === 'beam' ? 0.035 : 0.075 + 0.08 * o.zoom);
        const fd = Math.min(i.faces ? this.faceDist(h.pos, V, L, i.cam, i.faces) : Infinity, this.camDist(h.pos, V, L, i.cam) - 3 - rEnd);   // (a cone's own radius + 3 m clear of the lens: a near cone fills the frame)
        h.fade += ((fd < rEnd + 0.4 ? 0 : 1) - h.fade) * k;
        // (a wide zoom spreads the same light over a bigger cone: dimmer, or one wash near the lens fills the frame)
        let lv = o.level * i.level * h.fade * (h.kind === 'beam' ? 0.85 : 0.6 * 0.5 / (0.5 + Math.max(0, o.zoom)));
        if (i.safe) {
          // (Safe flashes ON: a bright cone sweeping across a region of the frame is a flash no governor sees - heads dim
          //  with their swing speed, as the lasers do: half at ~30 deg/s; before the governor, so it sees what is drawn)
          const w = h.pDir ? Math.acos(Math.min(1, Math.max(-1, h.pDir.dot(V)))) / Math.max(1e-3, i.dt) : 0;
          h.spd = (h.spd ?? w) + (w - (h.spd ?? w)) * Math.min(1, i.dt / 0.15);
          (h.pDir ??= new THREE.Vector3()).copy(V);
          lv /= 1 + Math.pow(h.spd / 0.5, 2);
        }
        lv = gov.out(h.ch, lv, srgb(o.r), srgb(o.g), srgb(o.b)); C.setRGB(lin(gov.r), lin(gov.g), lin(gov.b));
        Q.setFromUnitVectors(DOWN, V);
        const vis = lv > 0.004;
        M.compose(h.pos, Q, vis ? S.set(rEnd, L, rEnd) : S.set(0, 0, 0));
        this.beamMesh!.setMatrixAt(n, M);
        this.beamMesh!.setColorAt(n, C.multiplyScalar(lv * gain));
        if (vis) drawn++;
      });
      this.beamMesh.instanceMatrix.needsUpdate = true; this.beamMesh.instanceColor!.needsUpdate = true;
      this.drawn.heads = drawn;
    }
    // ---- lasers
    if (this.rayMesh && this.rays && this.sheets && this.sheetMesh) {
      (this.rayMesh.material as THREE.ShaderMaterial).uniforms.uSafe.value = i.safe ? 1 : 0;
      const L0 = this.budget.rays;
      let ri = 0, si = 0;
      for (const e of this.emitters) {
        const o = packLaser(p, pf, e.geo, L0, e.out);
        let lvl = o.on * i.level;
        if (lvl <= 0.003) continue;
        // a high origin never fans down at the camera / the floor: the rays stay over the crowd's heads
        o.pitch = Math.max(o.pitch, e.geo.y > 0.6 ? -14 : 8); o.yaw += e.bias;
        this.dirOf(o.yaw, o.pitch, V);
        if (i.safe) {
          // (rays dim with how fast they swing; a new pattern fades in over 0.4 s - festival lasers do the same)
          if (e.pForm !== o.form) { e.fadeIn = e.pForm ? 0 : 1; e.pForm = o.form; }
          e.fadeIn = Math.min(1, e.fadeIn + i.dt / 0.4);
          // (the aim's swing, and the formation's own rays moving round it)
          const w = Math.max(e.pAx ? Math.acos(Math.min(1, Math.max(-1, e.pAx.dot(V)))) / Math.max(1e-3, i.dt) : 0, packRaySwing(o, packRayCount(o, L0), 0, e, i.dt));
          e.spd += (w - e.spd) * Math.min(1, i.dt / 0.15);
          (e.pAx ??= new THREE.Vector3()).copy(V);
          lvl *= e.fadeIn * e.fadeIn / (1 + Math.pow(e.spd / 0.3, 2));
        }
        lvl = gov.out(e.ch, lvl, srgb(o.r), srgb(o.g), srgb(o.b)); C.setRGB(lin(gov.r), lin(gov.g), lin(gov.b));
        if (lvl < 0.01) continue;
        const n = Math.max(1, Math.min(L0, Math.round(L0 * (laserFormById(o.form)?.rays ?? 1))));
        let prev: THREE.Vector3 | null = null, prevFs = 1;
        const sheet = o.sheet;
        for (let r = 0; r < n && ri < this.aO.length / 3; r++) {
          packRay(o, r, n, i.safe ? 0 : f.beat, RA);   // (Safe: no tier hops)
          this.dirOf(RA.yaw, Math.max(RA.pitch, e.geo.y > 0.6 ? -16 : 6), V);
          const len = this.hit(e.pos, V, 40);
          // (never into the lens: a ray passing within 1.5 m of the camera fades out, like one crossing a face)
          const fd = Math.min(i.faces ? this.faceDist(e.pos, V, len, i.cam, i.faces) : Infinity, this.camDist(e.pos, V, len, i.cam) - 1.15);
          const fk = i.safe ? Math.min(1, Math.max(0, (fd - 0.35) / 0.85)) : fd < 0.35 ? 0 : 1;
          if (fk <= 0) { prev = null; continue; }
          const fs = fk * fk * (3 - 2 * fk);
          // (straight into the instance buffers: no per-ray arrays)
          const r3 = ri * 3, r4 = ri * 4, rk = lvl * 1.4 * fs;
          this.aO[r3] = e.pos.x; this.aO[r3 + 1] = e.pos.y; this.aO[r3 + 2] = e.pos.z;
          this.aD[r4] = V.x; this.aD[r4 + 1] = V.y; this.aD[r4 + 2] = V.z; this.aD[r4 + 3] = len;
          this.aC[r4] = C.r * rk; this.aC[r4 + 1] = C.g * rk; this.aC[r4 + 2] = C.b * rk; this.aC[r4 + 3] = 0.014;
          ri++;
          if (sheet && prev && si < this.sO.length / 3) {
            const s3 = si * 3, s4 = si * 4, m = Math.min(fs, prevFs) * lvl;
            this.sO[s3] = e.pos.x; this.sO[s3 + 1] = e.pos.y; this.sO[s3 + 2] = e.pos.z;
            this.sA[s4] = prev.x; this.sA[s4 + 1] = prev.y; this.sA[s4 + 2] = prev.z; this.sA[s4 + 3] = len * 0.9;
            this.sB[s4] = V.x; this.sB[s4 + 1] = V.y; this.sB[s4 + 2] = V.z; this.sB[s4 + 3] = 0.05 - 0.02 * Math.min(1, Math.max(0, this.hazeK));
            this.sC[s3] = C.r * m; this.sC[s3 + 1] = C.g * m; this.sC[s3 + 2] = C.b * m;
            si++;
          }
          prev = this.prevRay.copy(V); prevFs = fs;
        }
      }
      this.rays.instanceCount = ri; this.sheets.instanceCount = si;
      for (const a of ['aOrigin', 'aDir', 'aCol']) (this.rays.getAttribute(a) as THREE.InstancedBufferAttribute).needsUpdate = true;
      for (const a of ['aOrigin', 'aA', 'aB', 'aCol']) (this.sheets.getAttribute(a) as THREE.InstancedBufferAttribute).needsUpdate = true;
      this.drawn.rays = ri; this.drawn.sheets = si;
    }
    // ---- the pixel ceiling (the program's wall pattern; Safe flashes ON: half time + the slow wall pulse)
    if (this.ceiling) {
      const u = (this.ceiling.material as THREE.ShaderMaterial).uniforms;
      const wall = isPackWall(p.wall) ? p.wall : MAP_WALL[p.wall] ?? 'pk_gradient';
      u.uMode.value = Math.max(0, (PACK_WALLS as readonly string[]).indexOf(wall));
      u.uT.value = i.safe ? i.t * WALL_CALM.t : i.t;
      // (Safe: the pattern's beat at most 0.75 a second, whatever the tempo - the ceiling is a big area overhead and, in a
      //  dark room, much of the frame's light; the festival walls' half / quarter time peaks at 1.45 a second at 174 BPM)
      u.uBeat.value = f.beat * (i.safe ? Math.min(WALL_CALM.slow, 45 / Math.max(40, f.bpm)) : f.bpm > 180 ? 0.5 : 1);
      u.uKick.value = i.safe ? wallPulse(f.beat, f.bpm) : Math.max(0, (gov.level(this.ceilKick, 0.25 + 0.75 * f.kick) - 0.25) / 0.75);
      u.uEnergy.value = f.energy;
      u.uLevel.value = gov.level(this.ceilCh, 0.3 * i.level);
      const cs = f.colors;
      (u.uA.value as THREE.Color).setRGB(cs[0][0], cs[0][1], cs[0][2]); (u.uB.value as THREE.Color).setRGB(cs[1 % cs.length][0], cs[1 % cs.length][1], cs[1 % cs.length][2]); (u.uC.value as THREE.Color).setRGB(cs[2 % cs.length][0], cs[2 % cs.length][1], cs[2 % cs.length][2]);
    }
  }

  dispose() { for (const d of this.disposables) d.dispose(); this.beamMesh?.dispose(); this.group.removeFromParent(); }
}
