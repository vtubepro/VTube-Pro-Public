// Procedural club effects for ANY room (lighting states PRESHOW / OUTRO, src/scene/lightShow.ts):
//   moving-head beams  — additive soft cones (one InstancedMesh), sweeping in beat-locked patterns
//   laser fans         — thin additive rays (one InstancedMesh) scanning from the back of the room
//   mirror ball        — a faceted ball + spinning light spots on the walls / floor (one Points draw)
// No post, no bloom, no shadows, depth-write off (depth-TESTED, so furniture and avatars still cover them).
// Counts scale with the quality tier (low = nothing is built). Anchors, in order of preference:
//   GLB empties FX_BEAM_xx / FX_LASER_xx / FX_BALL (optional extras.aim [x,y,z] on beams),
//   scene.json lightRig { beams: [[x,y,z]…], lasers: [[x,y,z]…], ball: [x,y,z] } (glTF space),
//   else an automatic ceiling grid over the lived-in part of the room.
// Beams and laser rays that pass between the camera and a performer's face fade out (never cover the host).
import * as THREE from 'three';
import type { QualityTier } from '../tracking/Tracker.ts';
import type { RoomInfo } from './contract.ts';
import { govChannel, isSatRed, relLum, type FlashGovernor, type GovChannel } from '../../shared/flashGovernor.ts';

export interface FxFrame {
  /** 0..1 how much of the rig is on. */
  amount: number;
  /** Beat position (continuous), beat in bar 0..4, ms since the last kick / hat / drop. */
  pos: number;
  barPos: number;
  kickAge: number;
  hatAge: number;
  dropAge: number;
  /** Big-flash depth allowed by the photosensitivity gate for the newest drop (1 = full). */
  dropDepth: number;
  /** Palette colours (linear) A / B, speed multiplier, energy 0..1 from the music. */
  a: THREE.Color;
  b: THREE.Color;
  speed: number;
  energy: number;
  /** Phrase counter (pattern changes). */
  phrase: number;
  camera: THREE.Camera;
  faces: THREE.Vector3[];
  tSec: number;
  /** Look (shared/lightPresets.ts): beam motion, laser look, colour split, mirror-ball speed, [beams, lasers, ball] mix. */
  motion: string;
  laser: string;
  split: string;
  ball: number;
  mix: [number, number, number];
  /** Arrangement 0..1: build (energy rising), fill (snare roll), breakdown. */
  build: number;
  fill: number;
  breakdown: number;
  /** the room's photosensitivity governor (every beam / ray / the ball pass it) + whether the flash limit is on */
  gov?: FlashGovernor;
  safe?: boolean;
  bar: number;
  bpm: number;
}
const smoothstep = (e0: number, e1: number, v: number) => { const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

const COUNTS: Record<QualityTier, { beams: number; rays: number; dots: number }> = {
  low: { beams: 0, rays: 0, dots: 0 },
  medium: { beams: 4, rays: 6, dots: 48 },
  high: { beams: 6, rays: 10, dots: 96 },
  ultra: { beams: 8, rays: 16, dots: 160 },
};

const beamVert = /* glsl */ `
varying float vAlong; varying float vFres; varying vec3 vCol;
void main() {
  mat4 im = mat4(1.0);
  #ifdef USE_INSTANCING
  im = instanceMatrix;
  #endif
  vec4 mv = modelViewMatrix * im * vec4(position, 1.0);
  // (a collapsed / zero-scaled instance has a zero normal: never normalize(0) — NaN)
  vec3 nn = normalMatrix * mat3(im) * normal;
  vec3 n = nn / max(length(nn), 1e-6);
  vFres = abs(dot(n, normalize(-mv.xyz)));
  vAlong = uv.y;
  #ifdef USE_INSTANCING_COLOR
  vCol = instanceColor;
  #else
  vCol = vec3(1.0);
  #endif
  gl_Position = projectionMatrix * mv;
}`;
const beamFrag = /* glsl */ `
uniform float uOpacity; uniform float uEdge;
varying float vAlong; varying float vFres; varying vec3 vCol;
void main() {
  // MSAA evaluates varyings at the pixel centre, which can lie just OUTSIDE a thin beam / laser triangle: the
  // extrapolated vAlong goes < 0 and pow(negative) = NaN, which the HDR post pipeline spreads into block artefacts
  float a = pow(clamp(vFres, 0.0, 1.0), uEdge) * (0.25 + 0.75 * pow(clamp(vAlong, 0.0, 1.0), 1.2)) * uOpacity;
  gl_FragColor = vec4(vCol, a);
}`;
const dotVert = /* glsl */ `
attribute float aBright; varying float vB; uniform float uSize;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vB = aBright;
  gl_PointSize = uSize / max(0.2, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const dotFrag = /* glsl */ `
uniform vec3 uColor; varying float vB;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.1, length(d)) * vB;
  gl_FragColor = vec4(uColor, a);
}`;

const additive = (vert: string, frag: string, uniforms: Record<string, THREE.IUniform>) => new THREE.ShaderMaterial({
  vertexShader: vert, fragmentShader: frag, uniforms, transparent: true, depthWrite: false, depthTest: true,
  blending: THREE.AdditiveBlending, side: THREE.FrontSide, fog: false, toneMapped: false,
});

interface Beam {
  apex: THREE.Vector3; home: THREE.Vector3; fade: number; i: number; ch?: GovChannel;
  /** For lighting the performers (lightShow.ts): unit axis, length, end radius, light colour × strength (NOT faded
   *  by the face protection — a beam passing in front of a face still lights it). */
  dir: THREE.Vector3; L: number; r: number; light: THREE.Color;
}
interface Ray { origin: THREE.Vector3; side: number; i: number; n: number; fade: number; ch?: GovChannel }

/** Closest distance between segments p1-q1 and p2-q2, and the parameter s on the first. */
// (module scratch: nothing here escapes a call, and segDist runs per beam / ray / face every frame)
const _d1 = new THREE.Vector3(), _d2 = new THREE.Vector3(), _sr = new THREE.Vector3(), _cp1 = new THREE.Vector3(), _cp2 = new THREE.Vector3();
const _dir = new THREE.Vector3(), _end = new THREE.Vector3(), _base = new THREE.Vector3(), _scl = new THREE.Vector3();
const _DOWN = new THREE.Vector3(0, -1, 0), _UP = new THREE.Vector3(0, 1, 0);
const AXES = ['x', 'y', 'z'] as const;
function segDist(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3): [number, number] {
  const d1 = _d1.copy(q1).sub(p1), d2 = _d2.copy(q2).sub(p2), r = _sr.copy(p1).sub(p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s = 0, t = 0;
  const c = d1.dot(r), b = d1.dot(d2), den = a * e - b * b;
  s = den > 1e-9 ? THREE.MathUtils.clamp((b * f - c * e) / den, 0, 1) : 0;
  t = (b * s + f) / e;
  if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
  const cp1 = _cp1.copy(p1).addScaledVector(d1, s), cp2 = _cp2.copy(p2).addScaledVector(d2, t);
  return [cp1.distanceTo(cp2), s];
}

export class FxRig {
  readonly group = new THREE.Group();
  private ballCh = govChannel();
  private beams: Beam[] = [];
  private rays: Ray[] = [];
  private beamMesh: THREE.InstancedMesh | null = null;
  private rayMesh: THREE.InstancedMesh | null = null;
  private ball: THREE.Mesh | null = null;
  private ballPos = new THREE.Vector3();
  private dots: THREE.Points | null = null;
  private dotDirs: THREE.Vector3[] = [];
  private box = new THREE.Box3();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  /** camera world position + tan(fov / 2), once per update() (dedicated: `v` is aliased as the beam target) */
  private camPos = new THREE.Vector3();
  private tanH = Math.tan(THREE.MathUtils.degToRad(20));
  private col = new THREE.Color();
  private col2 = new THREE.Color();
  private clock = 0;
  private ballAng = 0;
  private center = new THREE.Vector3();
  private disposables: { dispose(): void }[] = [];
  /** Anchor source, for docs / debug. */
  source = 'auto';

  constructor(room: RoomInfo, tier: QualityTier, rig: { beams?: number[][]; lasers?: number[][]; ball?: number[] } | undefined, scene: THREE.Scene) {
    this.group.name = 'vtp:fx';
    this.group.visible = false;
    const n = COUNTS[tier] ?? COUNTS.medium;
    if (!n.beams && !n.rays && !n.dots) return;
    this.box = interiorBox(room);
    const root = room.root;
    const fromRig = (p: number[] | undefined) => (Array.isArray(p) && p.length >= 3 ? root.localToWorld(new THREE.Vector3(+p[0], +p[1], +p[2])) : null);
    const nodes = (re: RegExp) => { const o: THREE.Object3D[] = []; root.traverse((x) => { if (re.test(x.name)) o.push(x); }); return o.sort((a, b) => a.name.localeCompare(b.name)); };
    const B = this.box, c = B.getCenter(new THREE.Vector3());
    this.center.copy(c);
    const ceil = B.max.y - 0.25;
    // ---- anchors
    let beamAt = nodes(/^FX_BEAM_/).map((o) => o.getWorldPosition(new THREE.Vector3()));
    let laserAt = nodes(/^FX_LASER_/).map((o) => o.getWorldPosition(new THREE.Vector3()));
    const ballNode = nodes(/^FX_BALL/)[0];
    let ballAt = ballNode ? ballNode.getWorldPosition(new THREE.Vector3()) : null;
    if (beamAt.length || laserAt.length || ballAt) this.source = 'nodes';
    else if (rig) {
      beamAt = (rig.beams ?? []).map(fromRig).filter((x): x is THREE.Vector3 => !!x);
      laserAt = (rig.lasers ?? []).map(fromRig).filter((x): x is THREE.Vector3 => !!x);
      ballAt = fromRig(rig.ball);
      this.source = 'scene.json';
    }
    if (!beamAt.length) {                                                   // automatic ceiling grid: 2 rows
      const x0 = B.min.x + 1, x1 = B.max.x - 1, cols = 4;
      for (const z of [c.z - (B.max.z - B.min.z) * 0.2, c.z + (B.max.z - B.min.z) * 0.15]) for (let i = 0; i < cols; i++) beamAt.push(new THREE.Vector3(x0 + ((x1 - x0) * (i + 0.5)) / cols, ceil, z));
      if (this.source !== 'auto') this.source += '+auto beams';
    }
    if (!laserAt.length) laserAt = [new THREE.Vector3(B.min.x + 0.4, ceil - 0.2, B.min.z + 0.3), new THREE.Vector3(B.max.x - 0.4, ceil - 0.2, B.min.z + 0.3)];
    if (!ballAt) ballAt = new THREE.Vector3(c.x, ceil - 0.5, c.z);
    // spread the tier's beam count over the anchors (every other one first so the set stays balanced)
    const pick = <T>(list: T[], k: number) => { const out: T[] = []; const order = [...list.keys()].sort((a, b) => (a % 2) - (b % 2) || a - b); for (const i of order.slice(0, k)) out.push(list[i]); return out; };

    // ---- beams
    const beamList = pick(beamAt, n.beams);
    if (beamList.length) {
      const g = new THREE.CylinderGeometry(0.035, 1, 1, 12, 1, true);
      g.translate(0, -0.5, 0);                                              // apex at the origin, pointing down −Y
      const mat = additive(beamVert, beamFrag, { uOpacity: { value: 0.95 }, uEdge: { value: 1.0 } });
      const mesh = new THREE.InstancedMesh(g, mat, beamList.length);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(beamList.length * 3), 3);
      mesh.frustumCulled = false;
      mesh.name = 'vtp:fx-beams';
      mesh.renderOrder = 10;
      this.beamMesh = mesh;
      this.group.add(mesh);
      this.disposables.push(g, mat);
      beamList.forEach((apex, i) => {
        const home = new THREE.Vector3(THREE.MathUtils.lerp(apex.x, c.x, 0.3), 0, apex.z - 0.9);   // aimed a little away from the camera side
        this.beams.push({ apex, home, fade: 1, i, dir: new THREE.Vector3(0, -1, 0), L: 1, r: 0.1, light: new THREE.Color(0, 0, 0) });
      });
    }
    // ---- laser fans
    if (n.rays && laserAt.length) {
      const origins = laserAt.slice(0, 2);
      const per = Math.max(2, Math.floor(n.rays / origins.length));
      const g = new THREE.CylinderGeometry(0.006, 0.02, 1, 3, 1, true);
      g.translate(0, -0.5, 0);
      const mat = additive(beamVert, beamFrag, { uOpacity: { value: 0.9 }, uEdge: { value: 0.3 } });
      const mesh = new THREE.InstancedMesh(g, mat, per * origins.length);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(per * origins.length * 3), 3);
      mesh.frustumCulled = false;
      mesh.name = 'vtp:fx-lasers';
      mesh.renderOrder = 11;
      this.rayMesh = mesh;
      this.group.add(mesh);
      this.disposables.push(g, mat);
      origins.forEach((o, k) => { for (let i = 0; i < per; i++) this.rays.push({ origin: o, side: origins.length > 1 ? (k === 0 ? 1 : -1) : 0, i, n: per, fade: 1 }); });
    }
    // ---- mirror ball + spots
    if (n.dots) {
      this.ballPos.copy(ballAt);
      const bg = new THREE.IcosahedronGeometry(0.2, 2).toNonIndexed();
      const cols = new Float32Array(bg.getAttribute('position').count * 3);
      for (let f = 0; f < cols.length / 9; f++) { const v = 0.35 + 0.65 * Math.abs(Math.sin(f * 12.9898) * 43758.5453 % 1); for (let k = 0; k < 9; k++) cols[f * 9 + k] = v; }
      bg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      const bm = new THREE.MeshBasicMaterial({ vertexColors: true, color: 0x9aa0b0, fog: false });
      this.ball = new THREE.Mesh(bg, bm);
      this.ball.position.copy(ballAt);
      this.ball.name = 'vtp:fx-ball';
      const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, Math.max(0.05, ceil + 0.25 - ballAt.y), 4), new THREE.MeshBasicMaterial({ color: 0x222222 }));
      cable.position.set(ballAt.x, (ceil + 0.25 + ballAt.y) / 2, ballAt.z);
      this.group.add(this.ball, cable);
      this.disposables.push(bg, bm, cable.geometry, cable.material as THREE.Material);
      // directions (golden spiral), not up at the ceiling
      for (let i = 0; this.dotDirs.length < n.dots && i < n.dots * 3; i++) {
        const y = 1 - (i + 0.5) / (n.dots * 1.5) * 2, r = Math.sqrt(Math.max(0, 1 - y * y)), th = i * 2.39996;
        if (y < 0.35) this.dotDirs.push(new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r));
      }
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.dotDirs.length * 3), 3));
      pg.setAttribute('aBright', new THREE.BufferAttribute(new Float32Array(this.dotDirs.length), 1));
      const pm = additive(dotVert, dotFrag, { uColor: { value: new THREE.Color(1, 1, 1) }, uSize: { value: 120 } });
      this.dots = new THREE.Points(pg, pm);
      this.dots.frustumCulled = false;
      this.dots.name = 'vtp:fx-dots';
      this.dots.renderOrder = 9;
      this.group.add(this.dots);
      this.disposables.push(pg, pm);
    }
    scene.add(this.group);
  }

  /** Where a ray from p along unit d leaves the room's interior box. */
  private hit(p: THREE.Vector3, d: THREE.Vector3): number {
    let t = 30;
    const B = this.box;
    for (const ax of AXES) {
      const dv = d[ax];
      if (Math.abs(dv) < 1e-6) continue;
      const tt = ((dv > 0 ? B.max[ax] : B.min[ax]) - p[ax]) / dv;
      if (tt > 0 && tt < t) t = tt;
    }
    return t;
  }

  /** Face protection: 0 when the segment a→b passes between the camera and a face (within radius r(s)). */
  private clear(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, f: FxFrame): number {
    const cam = this.camPos;
    // a fixture right in front of the lens would fill the frame: fade those out
    let k = THREE.MathUtils.smoothstep(a.distanceTo(cam), 1.8, 3.6);
    const tanH = this.tanH;
    for (const face of f.faces) {
      // only faces that are big on screen (talk / close shots) are protected — in a wide shot beams may cross people
      const frac = 0.25 / (2 * Math.max(0.1, face.distanceTo(cam)) * tanH);
      if (frac < 0.06) continue;
      const [d, s] = segDist(a, b, cam, face);
      const r = THREE.MathUtils.lerp(r0, r1, s) + 0.28;
      k = Math.min(k, THREE.MathUtils.smoothstep(d, r * 0.6, r * 1.4));
    }
    return k;
  }

  update(f: FxFrame, dt: number) {
    const on = f.amount > 0.002;
    this.group.visible = on;
    if (!on) return;
    const A = f.amount;
    if (this.beamMesh || this.rayMesh) {
      f.camera.getWorldPosition(this.camPos);
      this.tanH = Math.tan(THREE.MathUtils.degToRad(((f.camera as THREE.PerspectiveCamera).fov || 40) / 2));
    }
    const [mixB, mixL, mixM] = f.mix;
    const kick = Math.exp(-Math.max(0, f.kickAge) / 160);
    const drop = f.dropAge < 3000 ? Math.exp(-f.dropAge / 900) : 0;                 // hit big …
    const release = f.dropAge < 8000 ? smoothstep(0, 1200, f.dropAge) * Math.exp(-f.dropAge / 5000) : 0;   // … then release wide
    // the drop's white hit: a 70 ms strobe chop with the flash limit off; ONE white hit with it on
    const strobe = f.dropAge < 400 ? f.dropDepth * (f.safe ? Math.exp(-f.dropAge / 140) : Math.floor(f.dropAge / 70) % 2 === 0 ? 1 : 0.15) : 0;
    const brk = f.breakdown, build = f.build, fill = f.fill;
    // tempo of the movement: breakdowns go slow and moody, builds wind up, drops kick it
    const pace = f.speed * (1 - 0.6 * brk) * (1 + 0.9 * build) * (1 + 0.4 * drop);
    this.clock += dt * pace * (Math.max(40, f.bpm) / 60);                           // beats of movement, pace-scaled
    const t = this.clock;
    const bright = (1 - 0.55 * brk) * (1 + 0.4 * build);
    const k = 1 - Math.exp(-dt / 0.12);
    const white = this.col2.setRGB(1, 1, 1);
    const colorFor = (i: number, n: number, x: number) => (f.split === 'mono' ? f.a : f.split === 'lr' ? (x < this.center.x ? f.a : f.b) : (i % 2 ? f.b : f.a));
    // ---- beams
    if (this.beamMesh) {
      const n = this.beams.length;
      this.beams.forEach((bm, i) => {
        const ph = t / 4 * Math.PI;                                          // half a sweep per bar
        const side = bm.apex.x < this.center.x ? -1 : 1, u = n > 1 ? i / (n - 1) - 0.5 : 0;
        let ox = 0, oz = 0;
        switch (f.motion) {
          case 'sweep': ox = Math.sin(ph) * 2.4; oz = Math.cos(ph * 0.5) * 1.2; break;                        // unison
          case 'fan': { const open = 0.5 + 0.5 * Math.sin(ph * 2); ox = side * (0.4 + 2.6 * open) + u * 1.5; oz = Math.cos(ph) * 0.8; break; }   // fan-out / in
          case 'figure8': ox = Math.sin(ph + i * 0.5) * 2.2; oz = Math.sin(2 * (ph + i * 0.5)) * 1.3; break;
          case 'ballyhoo': { const seg = Math.floor(t / 2), r = (j: number) => Math.sin((seg * 13.1 + i * 7.7 + j) * 12.9898) * 43758.5453 % 1;
            const ease = smoothstep(0, 0.35, t / 2 - seg); const a0 = r(0) * 3, b0 = r(1) * 2, a1 = r(5) * 3, b1 = r(6) * 2;
            ox = a0 + (a1 - a0) * ease; oz = b0 + (b1 - b0) * ease; break; }                                   // big random throws, snapping every 2 beats
          case 'circle': ox = Math.cos(ph + (i / n) * Math.PI * 2) * 1.9; oz = Math.sin(ph + (i / n) * Math.PI * 2) * 1.6; break;
          case 'cross': { const x = Math.sin(ph) * 1.8; ox = -side * (1.2 + x); oz = Math.cos(ph * 0.5) * 0.6; break; } // left rig ↔ right rig crossing
          case 'wander': ox = Math.sin(ph * 0.7 + i * 1.7) * 2; oz = Math.cos(ph * 0.5 + i * 2.3) * 1.5; break;
          default: ox = u * 0.6; oz = 0;                                                                      // still: straight down, pulsing
        }
        // drop: converge on the floor centre, then release into a wide fan
        const conv = drop * 0.85;
        ox = ox * (1 - conv) + (conv ? (this.center.x - bm.home.x) * conv : 0) + side * release * 2.2;
        oz = oz * (1 - conv);
        // "talent hits": the last bar of every 4 (and the bar after a drop) the beams swing onto the performers
        if (f.faces.length && f.motion !== 'still') {
          const hit = Math.max(smoothstep(2.6, 3.2, f.barPos) * (((Math.floor(f.bar) % 4) + 4) % 4 === 3 ? 1 : 0), f.dropAge > 400 && f.dropAge < 2600 ? 1 : 0);
          if (hit > 0) {
            const tg = f.faces[i % f.faces.length];
            const sway = Math.sin(t * Math.PI + i) * 0.25;
            ox += (tg.x + sway - (bm.home.x + ox)) * hit;
            oz += ((tg.z - bm.home.z) / 0.6 - oz) * hit;
          }
        }
        const target = this.v.set(bm.home.x + ox, 0, bm.home.z + oz * 0.6);
        const dir = _dir.copy(target).sub(bm.apex).normalize();
        const L = Math.min(this.hit(bm.apex, dir), 9);
        const end = _end.copy(bm.apex).addScaledVector(dir, L);
        const rEnd = L * (0.085 + 0.03 * drop + 0.02 * build);
        bm.fade += (this.clear(bm.apex, end, 0.03, rEnd, f) - bm.fade) * k;
        // snare-roll fill: beams chase fast one by one
        const fillOn = fill > 0 ? (Math.floor(t * 4) % n === i ? 1 : 0.25) : 1;
        const raw = 1.5 * mixB * A * bright * (0.55 + 0.5 * kick + 0.7 * drop) * (fill > 0 ? 1 - fill + fill * fillOn * 1.4 : 1);
        const lv = raw * bm.fade;
        bm.dir.copy(dir); bm.L = L; bm.r = rEnd;
        bm.light.copy(strobe > 0.5 ? white : colorFor(i, n, bm.apex.x)).multiplyScalar(i < this.beamMesh!.count ? raw + strobe * A * mixB : 0);
        this.col.copy(strobe > 0.5 ? white : colorFor(i, n, bm.apex.x)).multiplyScalar(lv + strobe * A * bm.fade * mixB);
        if (f.gov) { const L = relLum(this.col.r, this.col.g, this.col.b); const Ly = f.gov.step(bm.ch ??= govChannel(), L, isSatRed(this.col.r, this.col.g, this.col.b)); if (L > 1e-6 && Ly !== L) { this.col.multiplyScalar(Ly / L); bm.light.multiplyScalar(Ly / L); } }
        // an invisible beam (faded / off) is collapsed: no fragments at all
        const vis = this.col.r + this.col.g + this.col.b > 0.004;
        this.q.setFromUnitVectors(_DOWN, dir);
        this.m.compose(bm.apex, this.q, vis ? _scl.set(rEnd, L, rEnd) : _scl.set(0, 0, 0));
        this.beamMesh!.setMatrixAt(i, this.m);
        this.beamMesh!.setColorAt(i, this.col);
      });
      this.beamMesh.instanceMatrix.needsUpdate = true;
      this.beamMesh.instanceColor!.needsUpdate = true;
    }
    // ---- lasers: fan / crossing / tunnel / sheet / scan looks
    if (this.rayMesh) {
      const hat = Math.exp(-Math.max(0, f.hatAge) / 90);
      const toward = this.center;
      const mode = f.laser;
      const lv0 = 1.3 * mixL * A * bright * (0.7 + 0.5 * f.energy) * (mode === 'off' ? 0 : 1);
      this.rays.forEach((r, i) => {
        const base = _base.copy(toward).sub(r.origin).setY(0).normalize();
        const uu = r.n > 1 ? r.i / (r.n - 1) - 0.5 : 0;
        let yaw = 0, pitch = 0;
        if (mode === 'fan') { yaw = uu * THREE.MathUtils.degToRad(55) + r.side * 0.15 + Math.sin(t * 0.5 + r.side) * 0.3; pitch = Math.sin(t * Math.PI / 2) * 0.22 - 0.12; }
        else if (mode === 'cross') { yaw = r.side * (0.35 + Math.sin(t * Math.PI / 4) * 0.35) + uu * 0.5; pitch = -0.08 + uu * 0.1; }       // the two fans sweep through each other
        else if (mode === 'tunnel') { const a = (r.i / r.n) * Math.PI * 2 + t * 0.9 * (r.side || 1); yaw = Math.cos(a) * 0.32; pitch = Math.sin(a) * 0.22 - 0.05; }   // a spinning cone
        else if (mode === 'sheet') { yaw = uu * THREE.MathUtils.degToRad(80); pitch = -0.02 + Math.sin(t * Math.PI / 8) * 0.12; }                 // a flat plane of light scanning slowly
        else { yaw = Math.sin(t * Math.PI + uu * 4) * 0.6; pitch = -0.1 + Math.cos(t * 2 + uu) * 0.08; }                                       // scan
        const dir = base.applyAxisAngle(_UP, yaw);
        dir.y = pitch; dir.normalize();
        const L = Math.min(this.hit(r.origin, dir), 14);
        const end = _end.copy(r.origin).addScaledVector(dir, L);
        r.fade += (this.clear(r.origin, end, 0.02, 0.05, f) - r.fade) * k;
        this.q.setFromUnitVectors(_DOWN, dir);
        this.m.compose(r.origin, this.q, _scl.set(1, L, 1));
        this.rayMesh!.setMatrixAt(i, this.m);
        // (flash limit on: no half-beat flicker / snare-roll chop — the fans move instead of blinking)
        const flick = f.safe ? 1 : (r.i + Math.floor(f.pos * 2)) % 2 ? 0.35 + 0.65 * hat : 1;
        const fl = fill > 0 && !f.safe ? (Math.floor(t * 8 + r.i) % 2 ? 1 : 1 - fill) : 1;
        this.col.copy(colorFor(i, this.rays.length, r.side < 0 ? this.center.x + 1 : this.center.x - 1)).lerp(white, 0.15 * build).multiplyScalar(lv0 * r.fade * flick * fl);
        if (f.gov) { const L = relLum(this.col.r, this.col.g, this.col.b); const Ly = f.gov.step(r.ch ??= govChannel(), L, isSatRed(this.col.r, this.col.g, this.col.b)); if (L > 1e-6 && Ly !== L) this.col.multiplyScalar(Ly / L); }
        this.rayMesh!.setColorAt(i, this.col);
      });
      this.rayMesh.instanceMatrix.needsUpdate = true;
      this.rayMesh.instanceColor!.needsUpdate = true;
    }
    // ---- mirror ball: speed follows the arrangement (slow in breakdowns, fast in builds, a spin burst on drops)
    if (this.ball && this.dots) {
      this.ballAng += dt * 0.45 * f.ball * (1 - 0.7 * brk) * (1 + 1.5 * build) * (1 + 2.5 * drop);
      const ang = this.ballAng;
      this.ball.rotation.y = ang;
      this.ball.visible = mixM > 0.01;
      if (!(mixM > 0.01)) this.sparkle = 0;
      const pos = this.dots.geometry.getAttribute('position') as THREE.BufferAttribute;
      const br = this.dots.geometry.getAttribute('aBright') as THREE.BufferAttribute;
      const c = Math.cos(ang), s = Math.sin(ang);
      const kb = f.gov ? f.gov.step(this.ballCh, 0.55 + 0.35 * kick) : 0.55 + 0.35 * kick;
      for (let i = 0; i < this.dotDirs.length; i++) {
        const d = this.dotDirs[i];
        const dir = this.v.set(d.x * c - d.z * s, d.y, d.x * s + d.z * c);
        const L = this.hit(this.ballPos, dir) - 0.03;
        pos.setXYZ(i, this.ballPos.x + dir.x * L, this.ballPos.y + dir.y * L, this.ballPos.z + dir.z * L);
        br.setX(i, mixM * A * kb * (0.7 + 0.3 * Math.sin(i * 3.1 + f.tSec * 2)) * (1 - 0.4 * brk));
      }
      pos.needsUpdate = true; br.needsUpdate = true;
      this.sparkle = this.level === 2 ? 0 : mixM * A * (1 - 0.4 * brk);
      (this.dots.material as THREE.ShaderMaterial).uniforms.uColor.value.copy(f.a).lerp(white, 0.6);
    }
  }

  /** Quality ladder (auto-downgrade when frames get slow): 0 = full, 1 = half the beams / rays / spots, 2 = a quarter, no lasers / spots. */
  level = 0;
  setLevel(n: number) {
    this.level = Math.max(0, Math.min(2, n));
    const f = this.level === 0 ? 1 : this.level === 1 ? 0.5 : 0.25;
    if (this.beamMesh) this.beamMesh.count = Math.max(1, Math.ceil(this.beams.length * f));
    if (this.rayMesh) this.rayMesh.count = this.level === 2 ? 0 : Math.max(1, Math.ceil(this.rays.length * f));
    if (this.dots) this.dots.geometry.setDrawRange(0, this.level === 2 ? 0 : Math.ceil(this.dotDirs.length * f));
  }
  /** Beams as lights (for the performers): apex, axis, length, end radius, colour × strength. */
  lightBeams(): readonly Beam[] { return this.group.visible ? this.beams : []; }
  /** Mirror-ball sparkle amount 0..1 (last frame). */
  sparkle = 0;
  /** Everything the rig draws, for renderer.compile() pre-warming. */
  get objects() { return this.group; }

  counts() { return { level: this.level, beams: this.beams.length, rays: this.rays.length, dots: this.dotDirs.length, source: this.source, beamFade: this.beams.map((b) => +b.fade.toFixed(2)), rayFade: this.rays.map((r) => +r.fade.toFixed(2)) }; }

  dispose() {
    this.group.removeFromParent();
    for (const d of this.disposables) d.dispose();
    this.beamMesh?.dispose(); this.rayMesh?.dispose();
  }
}

/** The room's inside: ray-cast from the middle of the spots to the walls / floor / ceiling (falls back to bounds). */
export function interiorBox(room: RoomInfo): THREE.Box3 {
  const sp = room.spots.filter((s): s is NonNullable<typeof s> => !!s);
  const c = sp.length ? sp.reduce((a, s) => a.add(s.position), new THREE.Vector3()).multiplyScalar(1 / sp.length) : room.bounds.getCenter(new THREE.Vector3());
  c.y = (sp.length ? sp[0].position.y : room.bounds.min.y) + 1.4;
  const box = room.bounds.clone();
  if (box.isEmpty()) box.set(new THREE.Vector3(-4, 0, -4), new THREE.Vector3(4, 3, 4));
  const ray = new THREE.Raycaster();
  const dirs: [THREE.Vector3, 'min' | 'max', 'x' | 'y' | 'z'][] = [
    [new THREE.Vector3(1, 0, 0), 'max', 'x'], [new THREE.Vector3(-1, 0, 0), 'min', 'x'], [new THREE.Vector3(0, 1, 0), 'max', 'y'],
    [new THREE.Vector3(0, -1, 0), 'min', 'y'], [new THREE.Vector3(0, 0, 1), 'max', 'z'], [new THREE.Vector3(0, 0, -1), 'min', 'z']];
  const out = box.clone();
  for (const [d, side, ax] of dirs) {
    ray.set(c, d); ray.far = 40;
    // walls: the farthest-ish big surface — take the first hit beyond 0.8 m (skips nearby props)
    const hits = room.occluders.length ? ray.intersectObjects(room.occluders, false).filter((h) => h.distance > (ax === 'y' ? 0.2 : 0.8)) : [];
    const h = hits.find((x) => (x.object as THREE.Mesh).geometry?.boundingSphere ? ((x.object as THREE.Mesh).geometry.boundingSphere!.radius > 1.5) : true) ?? hits[hits.length - 1];
    if (h) out[side][ax] = c[ax] + d[ax] * h.distance;
  }
  // front of the room (camera side) is often open: keep it within bounds, at least 1.5 m in front of the spots
  if (sp.length) out.max.z = Math.min(box.max.z, Math.max(out.max.z, Math.max(...sp.map((s) => s.position.z)) + 1.5));
  if (out.max.y - out.min.y < 2) out.max.y = out.min.y + 3;
  return out;
}
