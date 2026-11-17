// Lasers: thin additive rays (one instanced draw; each ray a camera-facing ribbon built in the vertex shader from its
// origin / direction / length, a razor core + soft glow across it, a minimum on-screen width) and translucent sheets
// between neighbouring rays (fans, "liquid sky" over the crowd: one instanced triangle draw with fine scan lines).
// Modes from the look (shared/festivalDirector.ts evalLaser): fan, sheet, tunnel (a spinning cone), scan, cross,
// liquid, burst. 16th-note chops are hit layers and go through the photosensitivity gate.
import * as THREE from 'three';
import { FESTIVAL_BUDGET, type Tier } from '../../../shared/festival.ts';
import type { FestivalGov, GovOwner } from './gov.ts';
import type { SfxHit } from '../../../shared/festivalDirector.ts';
import { evalLaser, type LaserOut, type LookFrame } from '../../../shared/festivalDirector.ts';
import type { Section } from '../../../shared/festivalLooks.ts';
import { aimDir, fxMaterial, glow, lin, type Fixture } from './common.ts';
import { packRay, packRayCount, packRaySwing } from '../../../shared/showPack/festival.ts';

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
  float dist = length(cameraPosition - p);
  float w = max(aCol.w, dist * mix(0.0022, 0.0035, uSafe));
  p += side * position.x * w * 6.0;
  vUv = vec2(position.x + 0.5, position.y);
  vCol = aCol.rgb * min(1.0, aCol.w / w * 1.0 + 0.35);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const RAY_FS = /* glsl */ `
uniform float uSafe;
varying vec2 vUv; varying vec3 vCol;
void main() {
  float x = abs(vUv.x - 0.5) * 2.0;
  // (Safe flashes ON: a soft core several pixels wide - a razor core a pixel or two wide crawls across the pixel grid as
  // the ray moves, a white blip over a saturated-red region every frame or two: the WCAG red-flash rule)
  float core = mix(exp(-x * x * 120.0), exp(-x * x * 10.0) * 0.4, uSafe), halo = exp(-x * 5.0) * 0.18;
  float along = (1.0 - pow(clamp(vUv.y, 0.0, 1.0), 2.0)) * smoothstep(0.0, 0.01, vUv.y);
  float a = (core * 1.6 + halo) * along;
  gl_FragColor = vec4(vCol * a, a);
}`;
const SHEET_VS = /* glsl */ `
attribute vec3 aOrigin; attribute vec4 aA; attribute vec4 aB;   // dir A + len, dir B + alpha
varying vec3 vBary; varying vec3 vCol; varying float vAlpha;
attribute vec3 aCol;
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
uniform float uSafe;
varying vec3 vBary; varying vec3 vCol; varying float vAlpha;
void main() {
  float along = 1.0 - vBary.x;                         // 0 at the origin, 1 at the far edge
  float across = vBary.y / max(1e-4, vBary.y + vBary.z);
  float lines = mix(0.55 + 0.45 * pow(abs(sin(across * 3.14159 * 6.0)), 8.0), 0.68, uSafe * 0.85);   // (Safe: near-flat scan lines - fine bright lines crawl too)
  float a = vAlpha * lines * (1.0 - along * along) * smoothstep(0.0, 0.03, along);
  gl_FragColor = vec4(vCol * a, a);
}`;

interface Origin extends GovOwner { f: Fixture; out: LaserOut; pAx?: THREE.Vector3; pMode?: string; fadeIn?: number; spd?: number; pSpin?: number; rspd?: number; raySw?: Float64Array; raySwOk?: boolean }
const PD = new THREE.Vector3();
const V = new THREE.Vector3(), V2 = new THREE.Vector3(), AX = new THREE.Vector3(), P1 = new THREE.Vector3(), P2 = new THREE.Vector3();
const RA = { yaw: 0, pitch: 0 };
/** Safe flashes ON, a show with colour roles: the most luminance a laser colour may carry (relative, linear) */
const LASER_LUM = 0.3;

export class LaserRig {
  readonly group = new THREE.Group();
  private origins: Origin[] = [];
  private rays: THREE.InstancedBufferGeometry; private rayMesh: THREE.Mesh;
  private sheets: THREE.InstancedBufferGeometry; private sheetMesh: THREE.Mesh;
  private aO: Float32Array; private aD: Float32Array; private aC: Float32Array;
  private sO: Float32Array; private sA: Float32Array; private sB: Float32Array; private sC: Float32Array;
  private perOrigin: number;
  private disposables: { dispose(): void }[] = [];
  /** rays drawn last frame (debug) */
  drawn = 0;

  constructor(fixtures: Fixture[], tier: Tier) {
    this.group.name = 'festival:lasers';
    const B = FESTIVAL_BUDGET[tier];
    this.perOrigin = B.rays;
    for (const f of fixtures) if (f.kind === 'laser') this.origins.push({ f, out: { on: 0, mode: 'off', rays: 0, spread: 0, yaw: 0, pitch: 0, spin: 0, r: 0, g: 0, b: 0, flash: false, key: '' } });
    const maxRays = Math.max(1, this.origins.length * this.perOrigin);
    // rays
    const q = new THREE.BufferGeometry();
    q.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3));
    q.setIndex([0, 1, 2, 0, 2, 3]);
    this.rays = new THREE.InstancedBufferGeometry(); this.rays.index = q.index; this.rays.setAttribute('position', q.getAttribute('position'));
    this.aO = new Float32Array(maxRays * 3); this.aD = new Float32Array(maxRays * 4); this.aC = new Float32Array(maxRays * 4);
    this.rays.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(this.aO, 3));
    this.rays.setAttribute('aDir', new THREE.InstancedBufferAttribute(this.aD, 4));
    this.rays.setAttribute('aCol', new THREE.InstancedBufferAttribute(this.aC, 4));
    this.rays.instanceCount = 0;
    this.rayMesh = new THREE.Mesh(this.rays, fxMaterial(RAY_VS, RAY_FS, { uSafe: { value: 0 } }, { side: THREE.DoubleSide }));
    this.rayMesh.frustumCulled = false; this.rayMesh.renderOrder = 12; this.rayMesh.name = 'festival:laser-rays';
    // sheets
    const t = new THREE.BufferGeometry();
    t.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]), 3));
    this.sheets = new THREE.InstancedBufferGeometry(); this.sheets.setAttribute('position', t.getAttribute('position'));
    this.sO = new Float32Array(maxRays * 3); this.sA = new Float32Array(maxRays * 4); this.sB = new Float32Array(maxRays * 4); this.sC = new Float32Array(maxRays * 3);
    this.sheets.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(this.sO, 3));
    this.sheets.setAttribute('aA', new THREE.InstancedBufferAttribute(this.sA, 4));
    this.sheets.setAttribute('aB', new THREE.InstancedBufferAttribute(this.sB, 4));
    this.sheets.setAttribute('aCol', new THREE.InstancedBufferAttribute(this.sC, 3));
    this.sheets.instanceCount = 0;
    this.sheetMesh = new THREE.Mesh(this.sheets, fxMaterial(SHEET_VS, SHEET_FS, { uSafe: { value: 0 } }, { side: THREE.DoubleSide }));
    this.sheetMesh.frustumCulled = false; this.sheetMesh.renderOrder = 11; this.sheetMesh.name = 'festival:laser-sheets';
    for (const m of [this.rayMesh, this.sheetMesh]) { glow(m); this.group.add(m); }
    this.disposables.push(q, t, this.rays, this.sheets, this.rayMesh.material as THREE.Material, this.sheetMesh.material as THREE.Material);
  }

  /** `lz${key}` per laser look key (the gate's key: one string per look, not per origin per frame) */
  private gateKeys = new Map<string, string>();
  get count() { return this.origins.length; }
  /** the room's laser brightness (festival.laserGain) */
  gain = 1;
  /** Safe flashes ON + this frame's dt (s): rays fade with how fast they swing, a change of pattern fades in */
  safe = false; dt = 1 / 60;

  update(f: LookFrame, prev: LookFrame | null, mix: number, sec: Section, master: number, gate: (k: string, at: number) => number, faces: THREE.Vector3[] | null, cam: THREE.Vector3, gov: FestivalGov, hits: readonly SfxHit[] = [], beat = f.beat, calm = false) {
    let ri = 0, si = 0;
    const L = this.perOrigin;
    (this.rayMesh.material as THREE.ShaderMaterial).uniforms.uSafe.value = this.safe ? 1 : 0;
    (this.sheetMesh.material as THREE.ShaderMaterial).uniforms.uSafe.value = this.safe ? 1 : 0;
    for (const o of this.origins) {
      const lf = prev && mix < 0.5 ? prev : f;                         // lasers switch at the cross-fade midpoint
      const e = evalLaser(lf, o.f.geo, sec, o.out);
      let on = e.on * master * (prev && mix < 1 ? Math.abs(mix - 0.5) * 2 : 1);
      if (e.flash) { let gk = this.gateKeys.get(e.key); if (gk === undefined) this.gateKeys.set(e.key, gk = `lz${e.key}`); on *= gate(gk, f.beat); }
      // a cued laser moment on this origin's group: the tongue (one fat venom beam whipping across the sky above the
      // crowd over the cue), sky beams, a fan or a flat sheet
      for (const h of hits) {
        if (h.kind !== 'laser' || (h.group && h.group !== o.f.group) || beat < h.beat || beat > h.beat + h.dur) continue;
        const k = Math.min(1, Math.max(0, (beat - h.beat) / Math.max(0.05, h.dur)));
        on = h.power * Math.max(0.35, master);
        if (h.style === 'tongue') { e.mode = 'tongue'; e.r = 0.24; e.g = 1; e.b = 0.18; e.yaw = -75 + 150 * (k * k * (3 - 2 * k)); e.pitch = 20 + 6 * Math.sin(k * Math.PI); e.spread = 0; }
        else if (h.style === 'sky') { e.mode = 'sky'; e.pitch = 86; e.spread = 10; e.spin = (f.motionBeat ?? beat) * 25; }
        else if (h.style === 'fan' || h.style === 'sheet') { e.mode = h.style; e.pitch = h.style === 'sheet' ? 14 : 30; e.spread = 110; }
        break;
      }
      // a show with colour roles: this phrase's laser colour (mostly green; a cued tongue keeps its own)
      if (f.roles && e.mode !== 'tongue') {
        e.r = f.roles.laser[0]; e.g = f.roles.laser[1]; e.b = f.roles.laser[2];
        // (Safe flashes ON: a green ray is ~3.4x the luminance of a red one - a sweep of green rays through a region of the
        //  frame is a flash. The role colour is held to a red-ray-like luminance budget, the hue kept)
        if (this.safe) { const l = 0.2126 * lin(e.r) + 0.7152 * lin(e.g) + 0.0722 * lin(e.b); if (l > LASER_LUM) { const k = Math.pow(LASER_LUM / l, 1 / 2.2); e.r *= k; e.g *= k; e.b *= k; } }
      }
      // the anchor's own aim bias (glTF extras yaw / pitch, degrees): a tree's side pods fan outwards - looks and cued
      // fans alike (the tongue keeps its sweep)
      // (minPitch: a high origin never fans down over the camera's view of the stage)
      const ex = o.f.extras as { yaw?: unknown; pitch?: unknown; minPitch?: unknown };
      if (e.mode !== 'tongue') {
        if (typeof ex.yaw === 'number') e.yaw += ex.yaw;
        if (typeof ex.pitch === 'number') e.pitch += ex.pitch;
        if (typeof ex.minPitch === 'number') e.pitch = Math.max(e.pitch, ex.minPitch);
      }
      on *= this.gain;
      // behind a conversation the lasers stay up in the sky (never a sweep across a face)
      if (calm) { e.pitch = Math.max(e.pitch, 38); if (e.mode === 'burst' || e.mode === 'scan') e.mode = 'liquid'; if (e.mode === 'pack' && e.pack && (e.pack.form === 'burst' || e.pack.form === 'scan')) e.pack.form = 'liquid'; }
      // a show-pack formation (shared/showPack): its rays fan around the (biased) aim
      const pk = e.mode === 'pack' ? e.pack : undefined;
      if (pk) { pk.yaw = e.yaw; pk.pitch = e.pitch; }
      aimDir(e.yaw, e.pitch, AX);
      // Safe flashes ON: a bright ray swinging across a region of the frame is a flash no governor sees - rays dim with
      // their swing speed (a sweep reads as a soft fan) and a new pattern (a cue, a look) fades in over 0.4 s; applied
      // before the governors, so what they see is what is drawn
      if (this.safe) {
        if (o.pMode !== e.mode) { o.fadeIn = o.pMode === undefined ? 1 : 0; o.pMode = e.mode; }
        o.fadeIn = Math.min(1, (o.fadeIn ?? 1) + this.dt / 0.4);
        const w = o.pAx ? Math.acos(Math.min(1, Math.max(-1, o.pAx.dot(AX)))) / Math.max(1e-3, this.dt) : 0;
        o.spd = (o.spd ?? w) + (w - (o.spd ?? w)) * Math.min(1, this.dt / 0.15);
        (o.pAx ??= new THREE.Vector3()).copy(AX);
        // (a tunnel spins its rays round a still axis: their own speed = the spin rate x the sine of the cone's half-angle)
        const dsp = e.mode === 'tunnel' && o.pSpin !== undefined ? Math.abs(((e.spin - o.pSpin) % 360 + 540) % 360 - 180) : 0;
        o.pSpin = e.spin;
        let wr = THREE.MathUtils.degToRad(dsp) / Math.max(1e-3, this.dt) * Math.sin(THREE.MathUtils.degToRad(Math.min(90, e.spread * 0.5)));
        // (a show-pack formation's own rays move round the aim: their swing counts too)
        if (pk) wr = Math.max(wr, packRaySwing(pk, packRayCount(pk, L), 0, o, this.dt));
        o.rspd = (o.rspd ?? wr) + (wr - (o.rspd ?? wr)) * Math.min(1, this.dt / 0.15);
        // (quadratic in the swing speed: half bright at 29 deg/s, a 57 deg/s sweep at 20 % - a white ray crossing a red
        // region in a few frames was a red flash; the calm clock keeps the looks' own sweeps under ~30 deg/s, bright)
        on *= o.fadeIn * o.fadeIn / (1 + Math.pow(Math.max(o.spd ?? 0, o.rspd ?? 0) / 0.5, 2));
      }
      on = gov.out(o, on, e.r, e.g, e.b); e.r = gov.r; e.g = gov.g; e.b = gov.b;
      if (on < 0.01) continue;
      const n = pk ? packRayCount(pk, L) : e.mode === 'tongue' ? 1 : e.mode === 'sky' ? 4 : e.mode === 'scan' ? 3 : e.mode === 'burst' ? L : e.mode === 'liquid' || e.mode === 'sheet' ? L : Math.max(4, Math.round(L * 0.75));
      const reach = e.mode === 'tongue' ? 160 : e.mode === 'sky' ? 140 : e.mode === 'liquid' ? 60 : 70;
      const r = lin(e.r) * on * 1.4, g = lin(e.g) * on * 1.4, b = lin(e.b) * on * 1.4;
      let prevDir: THREE.Vector3 | null = null, prevFs = 1;
      for (let k = 0; k < n && ri < this.aO.length / 3; k++) {
        const u = n > 1 ? k / (n - 1) - 0.5 : 0;
        switch (e.mode) {
          case 'tunnel': {
            // rays on a cone around the aim axis, spinning
            const ang = THREE.MathUtils.degToRad(e.spin) + (k / n) * Math.PI * 2;
            const half = THREE.MathUtils.degToRad(e.spread * 0.5);
            const up = Math.abs(AX.y) > 0.9 ? V2.set(1, 0, 0) : V2.set(0, 1, 0);
            const s1 = P1.crossVectors(AX, up).normalize(), s2 = P2.crossVectors(AX, s1).normalize();
            V.copy(AX).multiplyScalar(Math.cos(half)).addScaledVector(s1, Math.sin(half) * Math.cos(ang)).addScaledVector(s2, Math.sin(half) * Math.sin(ang)).normalize();
            break;
          }
          case 'burst': aimDir(e.yaw + (Math.sin(k * 12.9898 + o.f.geo.seed * 78) * 0.5) * e.spread * 1.2, e.pitch + Math.cos(k * 4.1) * e.spread * 0.25, V); break;
          default: if (pk) { packRay(pk, k, n, this.safe ? 0 : f.beat, RA); aimDir(RA.yaw, RA.pitch, V); break; }   // (Safe: no tier hops)
            aimDir(e.yaw + u * e.spread, e.pitch + (e.mode === 'sheet' ? 0 : Math.sin(k * 1.7 + (f.motionBeat ?? f.beat)) * 1.5), V);
        }
        // (a ray near a protected face line is not drawn; with Safe flashes ON it fades out over the last 0.85 m before
        // the 0.35 m line instead - a swinging ray dropping out / back in a frame at a time was a one-frame blip over a
        // region of the frame: white over a red sky, the WCAG red-flash rule)
        const fd = faces ? this.faceDist(o.f.pos, V, reach, cam, faces) : Infinity;
        const fk = this.safe ? Math.min(1, Math.max(0, (fd - 0.35) / 0.85)) : fd < 0.35 ? 0 : 1;
        if (fk <= 0) { prevDir = null; continue; }
        const fs = fk * fk * (3 - 2 * fk);
        this.aO.set([o.f.pos.x, o.f.pos.y, o.f.pos.z], ri * 3);
        this.aD.set([V.x, V.y, V.z, reach], ri * 4);
        this.aC.set([r * fs, g * fs, b * fs, e.mode === 'tongue' ? 0.24 : 0.018], ri * 4);
        ri++;
        if ((e.mode === 'sheet' || e.mode === 'liquid' || e.mode === 'fan' || pk?.sheet) && prevDir && si < this.sO.length / 3) {
          this.sO.set([o.f.pos.x, o.f.pos.y, o.f.pos.z], si * 3);
          this.sA.set([prevDir.x, prevDir.y, prevDir.z, reach * 0.9], si * 4);
          this.sB.set([V.x, V.y, V.z, (e.mode === 'fan' ? 0.05 : pk ? 0.1 : 0.14) * Math.min(1, this.gain)], si * 4);   // (a dimmed room's sheets thin out faster than its rays)
          this.sC.set([r * Math.min(fs, prevFs), g * Math.min(fs, prevFs), b * Math.min(fs, prevFs)], si * 3);
          si++;
        }
        prevDir = PD.copy(V); prevFs = fs;
      }
    }
    this.drawn = ri;
    this.rays.instanceCount = ri; this.sheets.instanceCount = si;
    for (const n of ['aOrigin', 'aDir', 'aCol']) (this.rays.getAttribute(n) as THREE.InstancedBufferAttribute).needsUpdate = true;
    for (const n of ['aOrigin', 'aA', 'aB', 'aCol']) (this.sheets.getAttribute(n) as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  /** how close a ray passes to the lines from the camera to the protected faces (m; Infinity: nowhere near) */
  private faceDist(p: THREE.Vector3, d: THREE.Vector3, reach: number, cam: THREE.Vector3, faces: THREE.Vector3[]): number {
    let best = Infinity;
    for (const f of faces) for (let k = 1; k <= 5; k++) {
      V2.copy(cam).lerp(f, k / 5.5);
      const t = P1.copy(V2).sub(p).dot(d);
      if (t < 0 || t > reach) continue;
      best = Math.min(best, P1.copy(p).addScaledVector(d, t).distanceTo(V2));
    }
    return best;
  }

  dispose() { for (const d of this.disposables) d.dispose(); this.group.removeFromParent(); }
}
