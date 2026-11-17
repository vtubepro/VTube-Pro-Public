// The Trail — body animation layer: retargeted clips (Quaternius UAL + authored emotes, .vrma, see
// assets/library/anims/vrma/trail/index.json) on every performer's humanoid body, while the FACE and HEAD stay driven by
// tracking. Runs inside the actor's pose hook (AvatarRuntime.poseHook → SceneActor.extraPose): AFTER tracking wrote the
// normalized bones, BEFORE the rig update — the same slot the procedural room walk (src/scene/locomotion.ts) uses; that
// walk stays the fallback for rigs without usable legs, quadrupeds and until the clips have loaded.
//
// What it does, per frame, from the host snapshot of the player (anim code, speed, flags, hold) + the rendered motion:
//   - locomotion blend space idle → walk → jog → sprint, chosen by speed RELATIVE TO BODY SIZE (dynamic similarity:
//     natural speeds × √(leg length ratio)); all loops phase-aligned on their left-foot contact (index `phase`) so
//     blends keep the feet in step; the blend is the one whose interpolated stride × natural cadence equals the speed,
//     and the phase advances by DISTANCE / stride (stride = source stride × hip-height ratio) → the cadence stays
//     natural for the size: a micro scampers with many quick short steps, a macro takes long slow strides;
//   - foot locking: a foot the clip plants stays on its world spot (two-bone leg IK) until the clip lifts it;
//   - orientation warping (legs turn toward the travel direction, the chest counter-turns to keep facing the aim),
//     backwards walking, turn-in-place steps, a small lean into turns / acceleration;
//   - carry (arms holding), strain (crouched legs, bent back, trembling arms, slow), push, swim, sit, drive, jump
//     (take-off / air / land), ragdoll limp + get-up, climb, emotes (wave, dance, point, facepalm, cheer, laugh, sit,
//     soundbite) — short crossfades (0.2 s);
//   - head / neck keep the tracking (face, expressions and lip sync are never touched: they are not bones here); arms
//     keep the tracked pose while the performer gestures (raised arms) and the character stands or sits.
// Clips are parsed once per page and shared by every player (RAM only, library content — no performer data).
import * as THREE from 'three';
import { VRMHumanBoneParentMap, type VRMHumanBoneName } from '@pixiv/three-vrm';
import type { VRMAnimation } from '@pixiv/three-vrm-animation';
import { loadVrma } from '../../../avatar/emotes.ts';
import type { AvatarRuntime } from '../../../avatar/AvatarRuntime.ts';
import type { SceneActor } from '../../../scene/actor.ts';
import { ANIM, F } from '../../../../shared/trail/wire.ts';
import INDEX from './animclips.json';   // (a copy of assets/library/anims/vrma/trail/index.json: strides, contacts, speeds)

export interface ClipInfo { id: string; label: string; file: string; dur: number; loop: boolean; source: string; stride: number; hips: number; phase?: number; speed?: number }
export const CLIPS: ClipInfo[] = (INDEX as { clips: ClipInfo[] }).clips;
const SRC_HIPS = (INDEX as { hips?: number }).hips ?? 0.9167;
const FPS = 30;

// ---------------------------------------------------------------- the clip skeleton (VRM humanoid, parent-first)
const SIDES = ['left', 'right'] as const;
const FING = ['Index', 'Middle', 'Ring', 'Little'] as const;
export const BONES: VRMHumanBoneName[] = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'];
for (const s of SIDES) {
  BONES.push(`${s}Shoulder`, `${s}UpperArm`, `${s}LowerArm`, `${s}Hand`, `${s}UpperLeg`, `${s}LowerLeg`, `${s}Foot`, `${s}Toes`,
    `${s}ThumbMetacarpal`, `${s}ThumbProximal`, `${s}ThumbDistal`);
  for (const f of FING) BONES.push(`${s}${f}Proximal`, `${s}${f}Intermediate`, `${s}${f}Distal`);
}
const NB = BONES.length;
const BI = new Map<string, number>(BONES.map((b, i) => [b, i]));
/** clip-skeleton parent index of each bone (-1 = root), always earlier in BONES */
const PARENT = new Int16Array(NB);
for (let i = 0; i < NB; i++) { let p = VRMHumanBoneParentMap[BONES[i]]; while (p && !BI.has(p)) p = VRMHumanBoneParentMap[p]; PARENT[i] = p ? BI.get(p)! : -1; }
const idx = (b: string) => BI.get(b)!;
const G_LOWER = new Float32Array(NB), G_UPPER = new Float32Array(NB), G_ARMS = new Float32Array(NB), G_SPINE = new Float32Array(NB);
for (let i = 0; i < NB; i++) {
  const b = BONES[i];
  const leg = /UpperLeg|LowerLeg|Foot|Toes/.test(b) || b === 'hips';
  const arm = /Shoulder|Arm|Hand|Thumb|Index|Middle|Ring|Little/.test(b);
  const sp = b === 'spine' || b === 'chest' || b === 'upperChest';
  G_LOWER[i] = leg ? 1 : 0;
  G_ARMS[i] = arm ? 1 : 0;
  G_SPINE[i] = sp ? 1 : 0;
  G_UPPER[i] = arm || b === 'neck' || b === 'head' ? 1 : sp ? 0.75 : 0;
}
/** T-pose directions (VRM 1 normalized space: faces +Z, avatar-left = +X) of bones whose rest may differ on non-VRM
 *  humanoids (A-pose arms, splayed legs) — the same correction as src/avatar/emotes.ts. */
const TDIR: Partial<Record<VRMHumanBoneName, [VRMHumanBoneName, [number, number, number]]>> = {
  hips: ['spine', [0, 1, 0]], spine: ['chest', [0, 1, 0]], chest: ['neck', [0, 1, 0]], upperChest: ['neck', [0, 1, 0]], neck: ['head', [0, 1, 0]],
  leftShoulder: ['leftUpperArm', [1, 0, 0]], leftUpperArm: ['leftLowerArm', [1, 0, 0]], leftLowerArm: ['leftHand', [1, 0, 0]],
  rightShoulder: ['rightUpperArm', [-1, 0, 0]], rightUpperArm: ['rightLowerArm', [-1, 0, 0]], rightLowerArm: ['rightHand', [-1, 0, 0]],
  leftUpperLeg: ['leftLowerLeg', [0, -1, 0]], leftLowerLeg: ['leftFoot', [0, -1, 0]], rightUpperLeg: ['rightLowerLeg', [0, -1, 0]], rightLowerLeg: ['rightFoot', [0, -1, 0]],
};

// ---------------------------------------------------------------- packed clips (shared, parsed once)
export interface Packed { info: ClipInfo; n: number; dur: number; loop: boolean; q: Float32Array; has: Uint8Array; hip: Float32Array }
const packed = new Map<string, Packed>();
let loading: Promise<void> | null = null;
const tq1 = new THREE.Quaternion(), tq2 = new THREE.Quaternion();

function pack(info: ClipInfo, a: VRMAnimation): Packed {
  const dur = Math.max(1 / FPS, a.duration || info.dur);
  const n = Math.max(2, Math.round(dur * FPS) + 1);
  const q = new Float32Array(n * NB * 4), has = new Uint8Array(NB), hip = new Float32Array(n * 3);
  for (let i = 0; i < n * NB; i++) q[i * 4 + 3] = 1;
  const at = (times: ArrayLike<number>, t: number) => { let lo = 0, hi = times.length - 1; if (t <= times[0]) return [0, 0, 0] as const; if (t >= times[hi]) return [hi, hi, 0] as const; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= t) lo = m; else hi = m; } return [lo, hi, (t - times[lo]) / Math.max(1e-6, times[hi] - times[lo])] as const; };
  for (const [bone, tr] of a.humanoidTracks.rotation.entries()) {
    const bi = BI.get(bone);
    if (bi === undefined) continue;
    has[bi] = 1;
    const T = tr.times, V = tr.values;
    for (let f = 0; f < n; f++) {
      const [lo, hi, k] = at(T, (f / (n - 1)) * dur);
      tq1.fromArray(V, lo * 4); tq2.fromArray(V, hi * 4); tq1.slerp(tq2, k).normalize();
      tq1.toArray(q, (f * NB + bi) * 4);
    }
  }
  const ht = a.humanoidTracks.translation.get('hips');
  if (ht) {
    const r = a.restHipsPosition;
    for (let f = 0; f < n; f++) {
      const [lo, hi, k] = at(ht.times, (f / (n - 1)) * dur);
      for (let c = 0; c < 3; c++) hip[f * 3 + c] = ht.values[lo * 3 + c] * (1 - k) + ht.values[hi * 3 + c] * k - (c === 0 ? r.x : c === 1 ? r.y : r.z);
    }
  }
  return { info, n, dur, loop: info.loop, q, has, hip };
}

/** Load (once per page) every clip of the trail set; resolves when all have been tried. */
export function loadTrailClips(): Promise<void> {
  if (loading) return loading;
  loading = Promise.all(CLIPS.map(async (info) => {
    const a = await loadVrma(new URL(`../../../../assets/library/anims/vrma/trail/${info.file}`, import.meta.url).href);
    if (a) packed.set(info.id, pack(info, a));
    else console.warn('trail anim: clip failed', info.id);
  })).then(() => undefined);
  return loading;
}
export const clipReady = (id: string) => packed.has(id);
/** Global switch (tests: `&anim=0` on the private test pages compares with the procedural walk). */
export const animConfig = { enabled: true };

// ---------------------------------------------------------------- small maths (allocation-free)
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const clamp01 = (v: number) => clamp(v, 0, 1);
const smooth = (a: number, b: number, v: number) => { const k = clamp01((v - a) / (b - a)); return k * k * (3 - 2 * k); };
const frac = (v: number) => v - Math.floor(v);
const wrapA = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const approach = (v: number, t: number, rate: number) => (v < t ? Math.min(t, v + rate) : Math.max(t, v - rate));

/** Sample clip `c` at time `t` (s) into out[NB*4] (+ hips offset into hip[3]); bones the clip lacks = identity. */
function sampleInto(c: Packed, t: number, out: Float32Array, hip: Float32Array) {
  const d = c.dur;
  let x = c.loop ? frac(t / d) * d : clamp(t, 0, d);
  const f = (x / d) * (c.n - 1);
  const i0 = Math.min(c.n - 2, Math.floor(f)), k = f - i0;
  const o0 = i0 * NB * 4, o1 = o0 + NB * 4, q = c.q;
  for (let b = 0; b < NB; b++) {
    const j = b * 4;
    let ax = q[o0 + j], ay = q[o0 + j + 1], az = q[o0 + j + 2], aw = q[o0 + j + 3];
    let bx = q[o1 + j], by = q[o1 + j + 1], bz = q[o1 + j + 2], bw = q[o1 + j + 3];
    if (ax * bx + ay * by + az * bz + aw * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
    ax += (bx - ax) * k; ay += (by - ay) * k; az += (bz - az) * k; aw += (bw - aw) * k;
    const l = 1 / (Math.hypot(ax, ay, az, aw) || 1);
    out[j] = ax * l; out[j + 1] = ay * l; out[j + 2] = az * l; out[j + 3] = aw * l;
  }
  const h0 = i0 * 3, h1 = h0 + 3, hp = c.hip;
  hip[0] = hp[h0] + (hp[h1] - hp[h0]) * k; hip[1] = hp[h0 + 1] + (hp[h1 + 1] - hp[h0 + 1]) * k; hip[2] = hp[h0 + 2] + (hp[h1 + 2] - hp[h0 + 2]) * k;
}
/** acc += w · s (hemisphere-aligned), per bone weight mask optional; hips offset too. */
function addWeighted(acc: Float32Array, accHip: Float32Array, s: Float32Array, sHip: Float32Array, w: number, hipW: number) {
  for (let j = 0; j < NB * 4; j += 4) {
    const sg = acc[j] * s[j] + acc[j + 1] * s[j + 1] + acc[j + 2] * s[j + 2] + acc[j + 3] * s[j + 3] < 0 ? -w : w;
    acc[j] += s[j] * sg; acc[j + 1] += s[j + 1] * sg; acc[j + 2] += s[j + 2] * sg; acc[j + 3] += s[j + 3] * sg;
  }
  accHip[0] += sHip[0] * w * hipW; accHip[1] += sHip[1] * w * hipW; accHip[2] += sHip[2] * w * hipW;
}
/** acc = nlerp(acc, s, w · mask[bone]) (acc normalized first). */
function lerpToward(acc: Float32Array, s: Float32Array, w: number, mask: Float32Array | null) {
  for (let b = 0; b < NB; b++) {
    const k = w * (mask ? mask[b] : 1);
    if (k <= 0.0005) continue;
    const j = b * 4;
    let sx = s[j], sy = s[j + 1], sz = s[j + 2], sw = s[j + 3];
    if (acc[j] * sx + acc[j + 1] * sy + acc[j + 2] * sz + acc[j + 3] * sw < 0) { sx = -sx; sy = -sy; sz = -sz; sw = -sw; }
    const x = acc[j] + (sx - acc[j]) * k, y = acc[j + 1] + (sy - acc[j + 1]) * k, z = acc[j + 2] + (sz - acc[j + 2]) * k, ww = acc[j + 3] + (sw - acc[j + 3]) * k;
    const l = 1 / (Math.hypot(x, y, z, ww) || 1);
    acc[j] = x * l; acc[j + 1] = y * l; acc[j + 2] = z * l; acc[j + 3] = ww * l;
  }
}
function normalizeAll(acc: Float32Array) {
  for (let j = 0; j < NB * 4; j += 4) {
    const l = Math.hypot(acc[j], acc[j + 1], acc[j + 2], acc[j + 3]);
    if (l < 1e-6) { acc[j] = acc[j + 1] = acc[j + 2] = 0; acc[j + 3] = 1; } else { const k = 1 / l; acc[j] *= k; acc[j + 1] *= k; acc[j + 2] *= k; acc[j + 3] *= k; }
  }
}
/** Pre-multiply bone b's local by a rotation (axis in the parent frame, clip space). */
function preRotate(acc: Float32Array, b: number, ax: number, ay: number, az: number, ang: number) {
  if (Math.abs(ang) < 1e-5) return;
  tq1.setFromAxisAngle(tv.set(ax, ay, az), ang);
  tq2.fromArray(acc, b * 4); tq1.multiply(tq2); tq1.toArray(acc, b * 4);
}
/** Scale bone b's local rotation angle by f (nlerp from identity; f > 1 extrapolates a little). */
function scaleAngle(acc: Float32Array, b: number, f: number) {
  const j = b * 4;
  let x = acc[j] * f, y = acc[j + 1] * f, z = acc[j + 2] * f, w = 1 + (acc[j + 3] * (acc[j + 3] < 0 ? -1 : 1) - 1) * f;
  if (acc[j + 3] < 0) { x = -x; y = -y; z = -z; }
  const l = 1 / (Math.hypot(x, y, z, w) || 1);
  acc[j] = x * l; acc[j + 1] = y * l; acc[j + 2] = z * l; acc[j + 3] = w * l;
}
const tv = new THREE.Vector3();

// ---------------------------------------------------------------- emotes (trail cmd 'emote' ids → clips)
interface EmoteDef { clip: string; full: boolean; hold?: number; rate?: number }
export const EMOTE_CLIPS: Record<string, EmoteDef> = {
  wave: { clip: 'wave', full: false }, point: { clip: 'point', full: false }, facepalm: { clip: 'facepalm', full: false },
  cheer: { clip: 'cheer', full: true }, laugh: { clip: 'laugh', full: false }, soundbite: { clip: 'call', full: false },
  dance: { clip: 'dance', full: true, hold: 6 }, sit: { clip: 'sit_ground', full: true, hold: 30 },
};

/** Per-frame input from the view (the interpolated host sample + what the avatar measured). */
export interface AnimInput {
  anim: number; flags: number; speed: number; hold: number;
  /** facing yaw (sim convention: forward = (−sin, 0, −cos)) */
  yaw: number;
  /** world position of the body (for the rendered velocity: direction, lean, climbs) */
  x: number; y: number; z: number;
  /** 0..1 how hard a held thing strains this body (mass / lift); speaking 0..1 */
  strain: number; talk: number;
}

interface Shot { c: Packed; t: number; rate: number; w: number; end: number; max: number; id: string }
interface Emote { c: Packed; t: number; w: number; end: number; len: number; full: boolean; id: string }
const GEST_CHAIN: Record<'left' | 'right', VRMHumanBoneName[]> = {
  left: ['hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm'],
  right: ['hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm'],
};
const LEG_BONES = SIDES.map((s) => [idx(`${s}UpperLeg`), idx(`${s}LowerLeg`)] as const);
const ARM_BONES = SIDES.map((s) => [idx(`${s}UpperArm`), idx(`${s}LowerArm`)] as const);
const B_HIPS = idx('hips'), B_SPINE = idx('spine'), B_CHEST = idx('chest'), B_UCHEST = idx('upperChest');
const STATES = ['idle', 'walk', 'jog', 'sprint'];
/** Blend weight w in [0,1] between two loops (stride S, cadence C) whose interpolated stride × cadence equals v. */
function gaitMix(S0: number, S1: number, C0: number, C1: number, v: number) {
  const dS = S1 - S0, dC = C1 - C0;
  const a = dS * dC, b = S0 * dC + dS * C0, c = S0 * C0 - v;
  if (Math.abs(a) < 1e-9) return clamp01(-c / (b || 1e-9));
  const disc = Math.max(0, b * b - 4 * a * c);
  const r1 = (-b + Math.sqrt(disc)) / (2 * a), r2 = (-b - Math.sqrt(disc)) / (2 * a);
  return clamp01(r1 >= -1e-6 && r1 <= 1 + 1e-6 ? r1 : r2);
}
const loopT = (c: Packed, ph: number) => frac(ph + (c.info.phase ?? 0)) * c.dur;

/** One performer's animation state + the bone writer. Allocation-free per frame. */
export class BodyAnim {
  /** false → the caller uses its procedural fallback (no clips yet, unusable rig) */
  active = false;
  /** the dominant state (debug / tests / the weight meter) */
  state = 'idle';
  private rt: AvatarRuntime | null = null;
  private ok = false;
  /** why the rig can't take clips ('' = it can) */
  why = '';
  private chain: { bi: number; node: THREE.Object3D; parent: number; sInv: THREE.Quaternion }[] = [];
  private D: THREE.Quaternion[] = Array.from({ length: NB }, () => new THREE.Quaternion());
  private W: THREE.Quaternion[] = Array.from({ length: NB }, () => new THREE.Quaternion());
  private vrm0 = false;
  private restUpperN = [new THREE.Vector3(), new THREE.Vector3()];
  private relaxN = [new THREE.Vector3(), new THREE.Vector3()];
  private hipH = 0.9;
  private acc = new Float32Array(NB * 4); private tmp = new Float32Array(NB * 4);
  private accHip = new Float32Array(3); private tmpHip = new Float32Array(3);
  private kW = new Float32Array(NB);
  private inp: AnimInput = { anim: 0, flags: 0, speed: 0, hold: 0, yaw: 0, x: 0, y: 0, z: 0, strain: 0, talk: 0 };
  private fresh = true;
  private clock = 0;
  /** locomotion phase (0..1, left-foot contact at 0) and the push / swim phases */
  phase = 0; private pushPh = 0; private swimPh = 0;
  // base-state weights (crossfaded) + overlays
  private wLoco = 1; private wSit = 0; private wDrive = 0; private wSwim = 0; private wPush = 0; private wAir = 0; private wLimp = 0;
  private wCarry = 0; private wStrain = 0; private wTalk = 0;
  private vel = new THREE.Vector3(); private accF = 0; private accL = 0;
  private last = new THREE.Vector3(); private lastYaw = 0;
  private warp = 0; private legsYaw = 0; private turning = false;
  private leanP = 0; private leanR = 0;
  private gait = 0;
  private shots: Shot[] = [];
  private emote: Emote | null = null;
  private prevAir = false; private prevRag = false; private rise = 0;
  private gestureKeep = [0, 0];
  // foot locking (two-bone leg IK onto the planted foot's world spot): rig geometry in normalized space + lock state
  private legGeo: { ul: THREE.Object3D; ll: THREE.Object3D; ft: THREE.Object3D; hipOff: THREE.Vector3; oL: THREE.Vector3; oF: THREE.Vector3; a: number; b: number; ankH: number }[] = [];
  private hipsA = new THREE.Vector3(); private toNorm = new THREE.Quaternion(); private fromNorm = new THREE.Quaternion();
  private lockSt = [{ on: false, w: 0, x: 0, z: 0, px: NaN, pz: 0 }, { on: false, w: 0, x: 0, z: 0, px: NaN, pz: 0 }];
  private ikW = 0;
  /** foot-lock on/off (tests) */
  footLock = true;
  /** tests: pin the gait (0 idle … 3 sprint) and / or the stride warp */
  forceGait: number | null = null; forceWarp: number | null = null;
  /** last blend-space numbers (evidence / tests) */
  readonly debug = { gait: 0, stride: 0, warp: 1, cadence: 0, kS: 1, strainW: 0 };

  constructor() { void loadTrailClips(); }

  input(i: AnimInput) {
    const d = this.inp;
    d.anim = i.anim; d.flags = i.flags; d.speed = i.speed; d.hold = i.hold; d.yaw = i.yaw; d.x = i.x; d.y = i.y; d.z = i.z; d.strain = i.strain; d.talk = i.talk;
  }

  /** Play a trail emote (wave, dance, point, facepalm, cheer, laugh, sit, soundbite). False = unknown / not loaded. */
  playEmote(id: string): boolean {
    const d = EMOTE_CLIPS[id];
    const c = d ? packed.get(d.clip) : null;
    if (!d || !c) return false;
    this.emote = { c, t: 0, w: this.emote ? this.emote.w : 0, end: Infinity, len: d.hold ?? c.dur, full: d.full, id };
    return true;
  }
  get emoting() { return this.emote?.id ?? null; }

  private bind(rt: AvatarRuntime, actor: SceneActor): boolean {
    this.rt = rt; this.ok = false; this.chain.length = 0; this.fresh = true;
    const h = rt.humanoid, rest = actor.rest;
    this.why = !h ? 'no humanoid' : rt.quadruped ? 'quadruped' : !rest?.toNorm ? 'no rest' : '';
    if (!h || rt.quadruped || !rest?.toNorm) return false;
    const J = rest.joints;
    const N = (b: string) => h.getNormalizedBoneNode(b as VRMHumanBoneName);
    // legs must reach the floor (creatures with dangly bits keep the procedural hop)
    for (const s of SIDES) {
      const u = J[`${s}UpperLeg`], l = J[`${s}LowerLeg`], f = J[`${s}Foot`];
      if (!u || !l || !N(`${s}UpperLeg`) || !N(`${s}LowerLeg`)) { this.why = 'no legs'; return false; }
      const ank = f ?? l;
      const L = u.distanceTo(l) + (f ? l.distanceTo(f) : 0);
      if (ank.y - rest.floorY > 0.45 * L + 0.02 * rest.height) { this.why = `legs off the floor (${(ank.y - rest.floorY).toFixed(3)} vs leg ${L.toFixed(3)})`; return false; }
    }
    this.vrm0 = (rt as unknown as { vrm?: { meta?: { metaVersion?: string } } }).vrm?.meta?.metaVersion === '0';
    const restPose = h.normalizedRestPose;
    for (let i = 0; i < NB; i++) {
      const b = BONES[i];
      const node = N(b);
      if (!node) continue;
      let p = PARENT[i];
      while (p >= 0 && !N(BONES[p])) p = PARENT[p];
      const sInv = new THREE.Quaternion();
      const td = TDIR[b];
      const cp = td ? restPose[td[0]]?.position : undefined;
      if (td && cp) {
        const r = new THREE.Vector3(...cp);
        const T = new THREE.Vector3(...td[1]); if (this.vrm0) { T.x = -T.x; T.z = -T.z; }
        if (r.lengthSq() > 1e-8) sInv.setFromUnitVectors(r.normalize(), T).normalize();
      }
      this.chain.push({ bi: i, node, parent: p, sInv });
    }
    // gesture detection geometry (normalized space): rest upper-arm direction + the tracking's relaxed hang
    for (let k = 0; k < 2; k++) {
      const s = SIDES[k];
      const u = J[`${s}UpperArm`], l = J[`${s}LowerArm`];
      if (u && l) this.restUpperN[k].copy(l).sub(u).normalize().applyQuaternion(rest.toNorm);
      this.relaxN[k].set(0.28 * (k ? -1 : 1), -0.95, 0.08).normalize().applyQuaternion(rest.toNorm);
    }
    this.hipH = rest.hips ? Math.max(0.05, rest.hips.y - rest.floorY) : rest.height * 0.53;
    // leg geometry for foot locking (needs hips + both legs with feet)
    this.legGeo.length = 0;
    this.toNorm.copy(rest.toNorm); this.fromNorm.copy(rest.toNorm).invert();
    const hipsJ = J.hips;
    if (hipsJ) {
      this.hipsA.copy(hipsJ);
      for (const s of SIDES) {
        const u = J[`${s}UpperLeg`], l = J[`${s}LowerLeg`], f = J[`${s}Foot`];
        const nu = N(`${s}UpperLeg`), nl = N(`${s}LowerLeg`), nf = N(`${s}Foot`);
        if (!u || !l || !f || !nu || !nl || !nf) { this.legGeo.length = 0; break; }
        const oL = l.clone().sub(u).applyQuaternion(rest.toNorm), oF = f.clone().sub(l).applyQuaternion(rest.toNorm);
        this.legGeo.push({ ul: nu, ll: nl, ft: nf, hipOff: u.clone().sub(hipsJ).applyQuaternion(rest.toNorm), oL, oF, a: oL.length(), b: oF.length(), ankH: Math.max(0, f.y - rest.floorY) });
      }
    }
    this.ok = true;
    return true;
  }

  /** The pose hook body. Returns false when the caller should run its fallback (procedural walk). */
  apply(rt: AvatarRuntime, dt: number, actor: SceneActor): boolean {
    if (rt !== this.rt) this.bind(rt, actor);
    this.active = animConfig.enabled && this.ok && packed.has('idle') && packed.has('walk') && packed.has('jog') && packed.has('sprint');
    if (!this.active || dt <= 0) return this.active;
    this.step(Math.min(dt, 0.1), actor);
    this.write();
    if (this.footLock) this.lockFeet(Math.min(dt, 0.1), actor);
    return true;
  }

  private put(id: string, t: number, w: number, hipW: number) {
    const c = packed.get(id);
    if (!c || w <= 0.001) return;
    sampleInto(c, t, this.tmp, this.tmpHip); addWeighted(this.acc, this.accHip, this.tmp, this.tmpHip, w, hipW);
  }
  /** One locomotion loop at the shared phase, stride-warped (swing legs + bob). */
  private legs(c: Packed, w: number, warp: number) {
    if (w <= 0.001) return;
    const tmp = this.tmp, th = this.tmpHip;
    sampleInto(c, loopT(c, this.phase), tmp, th);
    for (const [u] of LEG_BONES) scaleAngle(tmp, u, warp);
    th[1] *= warp;
    addWeighted(this.acc, this.accHip, tmp, th, w, 1);
  }

  private step(dt: number, actor: SceneActor) {
    const I = this.inp;
    this.clock += dt;
    const kS = Math.max(0.02, (this.hipH * actor.scale) / SRC_HIPS);       // size: avatar hip height / source hip height
    const rk = Math.sqrt(kS);
    const cad = 1 / rk;                                                    // pendulum cadence scaling (Froude)
    // rendered motion: velocity (smoothed), acceleration, climbs
    if (this.fresh) { this.last.set(I.x, I.y, I.z); this.lastYaw = I.yaw; this.legsYaw = I.yaw; this.fresh = false; }
    let vx = (I.x - this.last.x) / dt, vy = (I.y - this.last.y) / dt, vz = (I.z - this.last.z) / dt;
    if (vx * vx + vz * vz > 900 || Math.abs(vy) > 40) vx = vy = vz = 0;     // teleport / rebase
    this.last.set(I.x, I.y, I.z);
    const ka = 1 - Math.exp(-dt / 0.08);
    const ox = this.vel.x, oz = this.vel.z;
    this.vel.x += (vx - this.vel.x) * ka; this.vel.y += (vy - this.vel.y) * ka; this.vel.z += (vz - this.vel.z) * ka;
    const fx = -Math.sin(I.yaw), fz = -Math.cos(I.yaw);                    // avatar forward (world)
    const lx = fz, lz = -fx;                                               // avatar left (world)
    const ax = (this.vel.x - ox) / dt, az = (this.vel.z - oz) / dt;
    const ks = 1 - Math.exp(-dt / 0.15);
    this.accL += ((ax * lx + az * lz) - this.accL) * ks;
    this.accF += ((ax * fx + az * fz) - this.accF) * ks;
    // states
    const rag = (I.flags & (F.ragdoll | F.downed)) !== 0 || I.anim === ANIM.ragdoll || I.anim === ANIM.dead;
    const seated = !rag && ((I.flags & F.seated) !== 0 || I.anim === ANIM.sit || I.anim === ANIM.drive);
    const drive = seated && I.anim === ANIM.drive;
    const air = !rag && !seated && (I.anim === ANIM.jump || I.anim === ANIM.fall);
    const swim = !rag && !seated && !air && (I.anim === ANIM.swim || (I.flags & F.swept) !== 0);
    const push = !rag && !seated && !air && !swim && I.anim === ANIM.push;
    const strain = !rag && !seated && !swim && (I.anim === ANIM.strain || (!!I.hold && I.strain > 1));
    const carry = !rag && !seated && !swim && !!I.hold;
    const spd = seated || rag ? 0 : Math.max(0, I.speed);
    // one-shots on transitions
    if (air && !this.prevAir && I.anim === ANIM.jump) this.shot('jump_start', 1.5, 0.45, 1, 1);
    if (!air && this.prevAir && !rag && !swim) { const run = smooth(0.6, 1.6, this.gait); if (run < 0.8) this.shot('jump_land', 1.3, 0.05, 0.55, 1 - run); }
    if (!rag && this.prevRag) this.shot('getup', 1.35, 0.12, 1, 1);
    this.rise = !air && !seated && !rag && vy > 0.9 * rk ? this.rise + dt : 0;
    if (this.rise > 0.12) { this.shot('climb', 1.6, 0.1, 0.55, 1); this.rise = -2; }
    this.prevAir = air; this.prevRag = rag;
    // emotes: full-body ones stop when the player walks off; everything stops on ragdoll / air / swim
    const e = this.emote;
    if (e && (rag || air || swim || (e.full && spd > 0.6 * rk))) e.end = Math.min(e.end, e.t);
    // base weights (crossfade 0.2 s)
    const rate = dt / 0.2;
    this.wLoco = approach(this.wLoco, !rag && !seated && !swim && !push && !air ? 1 : 0, rate);
    this.wSit = approach(this.wSit, seated && !drive ? 1 : 0, rate);
    this.wDrive = approach(this.wDrive, drive ? 1 : 0, rate);
    this.wSwim = approach(this.wSwim, swim ? 1 : 0, rate);
    this.wPush = approach(this.wPush, push ? 1 : 0, rate);
    this.wAir = approach(this.wAir, air ? 1 : 0, rate);
    this.wLimp = approach(this.wLimp, rag ? 1 : 0, rate);
    this.wCarry = approach(this.wCarry, carry || strain ? 1 : 0, rate);
    this.wStrain = approach(this.wStrain, strain ? clamp(0.55 + (I.strain - 1) * 0.35, 0.55, 1) : 0, rate * 0.8);
    this.wTalk = approach(this.wTalk, I.talk > 0.35 && spd < 0.2 && !carry && !seated ? 0.4 : 0, dt / 0.6);
    // ---- locomotion blend space (speed relative to size) ----
    const cw = packed.get('walk')!, cj = packed.get('jog')!, cs = packed.get('sprint')!;
    // each loop's stride (m / loop) and natural cadence (loops / s) at this size; natural speed = stride × cadence
    const Sw = cw.info.stride * kS, Sj = cj.info.stride * kS, Ss = cs.info.stride * kS;
    const Cw = cad / cw.dur, Cj = cad / cj.dur, Cs = cad / cs.dur;
    const natW = Sw * Cw, natJ = Sj * Cj, natS = Ss * Cs;
    // gait: the blend whose (interpolated) natural stride × cadence equals the speed — so the feet stay locked AND the
    // cadence stays natural for the size (below a walk: a slower walk; above a sprint: a faster sprint)
    let g: number;
    if (spd < natW) g = Math.min(1, spd / (0.35 * natW));
    else if (spd < natJ) g = 1 + gaitMix(Sw, Sj, Cw, Cj, spd);
    else if (spd < natS) g = 2 + gaitMix(Sj, Ss, Cj, Cs, spd);
    else g = 3;
    // turn in place: the legs stay planted while the body turns, then step round (a shuffle on the walk cycle)
    const moving = smooth(0.08, 0.3, spd / Math.max(0.05, natW));
    let turnDist = 0;
    if (!seated && !rag && !air && !swim && moving < 0.3) {
      const diff = wrapA(I.yaw - this.legsYaw);
      if (Math.abs(diff) > 0.85) this.turning = true;
      if (this.turning) {
        const st = Math.sign(diff) * Math.min(Math.abs(diff), dt * 4.5);
        this.legsYaw = wrapA(this.legsYaw + st);
        turnDist = Math.abs(st) * this.hipH * actor.scale * 0.6;
        if (Math.abs(diff) < 0.06) this.turning = false;
      }
      if (this.turning) g = Math.max(g, 0.55);
    } else { this.legsYaw = I.yaw; this.turning = false; }
    if (this.forceGait !== null) g = this.forceGait;
    this.gait += (g - this.gait) * (1 - Math.exp(-dt / 0.12));
    const gg = this.gait;
    const wIdle = clamp01(1 - gg), wWalk = gg <= 1 ? clamp01(gg) : clamp01(2 - gg), wJog = gg <= 2 ? clamp01(gg - 1) : clamp01(3 - gg), wSpr = clamp01(gg - 2);
    const mv = wWalk + wJog + wSpr;
    // stride of the current blend (the phase advances by distance / stride: foot-locked by construction)
    const strideNat = mv > 1e-4 ? ((wWalk * cw.info.stride + wJog * cj.info.stride + wSpr * cs.info.stride) / mv) * kS : cw.info.stride * kS;
    const travel = spd + turnDist / dt;
    // (no pose-warping of the stride: scaling leg swing breaks the stance foot's speed — measured; the blend above does it)
    const warp = 1;
    const warpU = this.forceWarp ?? warp;
    const stride = Math.max(1e-3, strideNat * warpU * (1 - 0.3 * this.wStrain));
    // travel direction relative to facing → orientation warp / walking backwards
    const vl = this.vel.x * lx + this.vel.z * lz, vf = this.vel.x * fx + this.vel.z * fz;
    let dir = 1, aim = 0;
    if (moving > 0.2 && Math.hypot(vl, vf) > 0.15 * rk && !seated && !air) {
      aim = Math.atan2(vl, vf);
      if (Math.abs(aim) > 1.95) { dir = -1; aim -= Math.PI * Math.sign(aim); }
      aim = clamp(aim, -1.2, 1.2);
    }
    if (moving < 0.3 && !seated && !rag) aim = wrapA(this.legsYaw - I.yaw);
    this.warp += (aim - this.warp) * (1 - Math.exp(-dt / 0.12));
    this.phase = frac(this.phase + (dir * travel * dt) / stride);
    const D = this.debug; D.gait = gg; D.stride = stride; D.warp = warp; D.cadence = travel / stride; D.kS = kS; D.strainW = this.wStrain;
    // lean into turns / acceleration (a tilt at the feet; avatar space +X left, +Z front)
    const run = smooth(0.8, 2, gg);
    const calm = seated || rag ? 0 : 1;
    const lp = clamp(this.accF * 0.02 + run * 0.05 * (1 - this.wStrain) + this.wPush * 0.02, -0.12, 0.2) * calm;
    const lr = clamp(-Math.atan(this.accL / 9.81) * 0.35, -0.22, 0.22) * (swim ? 0 : calm * moving);
    this.leanP += (lp - this.leanP) * ks; this.leanR += (lr - this.leanR) * ks;
    // ---------------- blend the pose ----------------
    const acc = this.acc, tmp = this.tmp, ah = this.accHip, th = this.tmpHip;
    acc.fill(0); ah.fill(0);
    const Wl = this.wLoco;
    if (Wl > 0.001) {
      if (wIdle > 0.001) this.put('idle', this.clock, Wl * wIdle, 1);
      this.legs(cw, Wl * wWalk, warpU); this.legs(cj, Wl * wJog, warpU); this.legs(cs, Wl * wSpr, warpU);
    }
    if (this.wSit > 0.001) this.put(I.talk > 0.35 && packed.has('sit_talk') ? 'sit_talk' : 'sit', this.clock, this.wSit, 0);
    if (this.wDrive > 0.001) this.put(packed.has('drive') ? 'drive' : 'sit', this.clock, this.wDrive, 0);
    if (this.wSwim > 0.001) {
      const sw = packed.get('swim');
      const move = smooth(0.1, 0.6, spd / Math.max(0.1, 1.2 * rk));
      if (sw) this.swimPh = frac(this.swimPh + Math.max((0.5 * dt) / sw.dur, (spd * dt) / Math.max(0.05, sw.info.stride * kS)));
      if (move < 0.999) this.put('swim_idle', this.clock, this.wSwim * (1 - move), 0.5);
      if (sw && move > 0.001) this.put('swim', loopT(sw, this.swimPh), this.wSwim * move, 0.5);
    }
    if (this.wPush > 0.001) {
      const c = packed.get('push');
      if (c) { this.pushPh = frac(this.pushPh + Math.max((0.45 * dt) / c.dur, (spd * dt) / Math.max(0.05, c.info.stride * kS))); this.put('push', this.pushPh * c.dur, this.wPush, 1); }
      else this.put('idle', this.clock, this.wPush, 1);
    }
    if (this.wAir > 0.001) this.put(packed.has('jump_air') ? 'jump_air' : 'idle', this.clock * 0.8, this.wAir, 0.3);
    if (this.wLimp > 0.001) this.put('idle', 0.4, this.wLimp, 0);
    normalizeAll(acc);
    const wsum = Wl + this.wSit + this.wDrive + this.wSwim + this.wPush + this.wAir + this.wLimp;
    if (wsum > 1e-4) { ah[0] /= wsum; ah[1] /= wsum; ah[2] /= wsum; }
    // strain: crouched heavy legs under the walk, bent back, trembling
    const ws = this.wStrain;
    if (ws > 0.001) {
      const cwk = packed.get(mv > 0.3 ? 'crouch_walk' : 'crouch_idle');
      if (cwk) { sampleInto(cwk, cwk.info.stride > 0 ? loopT(cwk, this.phase) : this.clock, tmp, th); lerpToward(acc, tmp, ws * 0.55, G_LOWER); ah[1] += th[1] * ws * 0.55; }
      const tr = Math.sin(this.clock * 37) * 0.012 + Math.sin(this.clock * 23.3) * 0.01;
      preRotate(acc, B_SPINE, 1, 0, 0, ws * (0.16 + tr));
      preRotate(acc, B_CHEST, 1, 0, 0, ws * (0.08 - tr));
    }
    // carrying: the carry clip's arms (in step with the walk)
    if (this.wCarry > 0.001) {
      const c = packed.get('carry');
      if (c) { sampleInto(c, mv > 0.2 ? loopT(c, this.phase) : 0.1, tmp, th); lerpToward(acc, tmp, this.wCarry, G_ARMS); }
      if (ws > 0.001) for (let k = 0; k < 2; k++) { const t = Math.sin(this.clock * (k ? 44 : 41)) * 0.03 * ws; preRotate(acc, ARM_BONES[k][1], 1, 0, 0, t); preRotate(acc, ARM_BONES[k][0], 0, 0, 1, t * 0.6); }
    }
    // talking hands while standing (light; the performer's own tracked gestures win below)
    if (this.wTalk > 0.001) { const c = packed.get('talk'); if (c) { sampleInto(c, this.clock, tmp, th); lerpToward(acc, tmp, this.wTalk, G_ARMS); } }
    // one-shots (take-off, landing, get-up, climb)
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      s.t += dt * s.rate;
      const done = s.t >= s.end;
      s.w = done ? Math.max(0, s.w - dt / 0.2) : Math.min(s.max, s.w + dt / 0.1);
      if (done && s.w <= 0) { this.shots.splice(i, 1); continue; }
      sampleInto(s.c, Math.min(s.t, s.end), tmp, th);
      lerpToward(acc, tmp, s.w, null);
      ah[0] += (th[0] - ah[0]) * s.w; ah[1] += (th[1] - ah[1]) * s.w; ah[2] += (th[2] - ah[2]) * s.w;
    }
    // in the air the arms stay closer to the body (UAL's take-off / air clips fling them out wide: reads as a T-pose)
    if (this.wAir > 0.001) { sampleInto(packed.get('idle')!, this.clock, tmp, th); lerpToward(acc, tmp, this.wAir * 0.65, G_ARMS); }
    // the emote (full body when standing, upper body while walking / sitting)
    if (e) {
      e.t += dt;
      const done = e.t >= e.end || e.t >= e.len;
      e.w = done ? Math.max(0, e.w - dt / 0.25) : Math.min(1, e.w + dt / 0.18);
      if (done && e.w <= 0) this.emote = null;
      else {
        sampleInto(e.c, e.t, tmp, th);
        const full = e.full && moving < 0.3 && !seated;
        lerpToward(acc, tmp, e.w, full ? null : G_UPPER);
        if (full) { ah[0] += (th[0] - ah[0]) * e.w; ah[1] += (th[1] - ah[1]) * e.w; ah[2] += (th[2] - ah[2]) * e.w; }
      }
    }
    // orientation warp: legs toward the travel direction, the torso counter-turns (the aim keeps facing forward)
    const wa = this.warp * clamp01(1 - this.wSit - this.wDrive) * (1 - this.wLimp);
    if (Math.abs(wa) > 1e-3) {
      preRotate(acc, B_HIPS, 0, 1, 0, wa);
      preRotate(acc, B_SPINE, 0, 1, 0, -wa * 0.4);
      preRotate(acc, B_CHEST, 0, 1, 0, -wa * 0.35);
      preRotate(acc, B_UCHEST, 0, 1, 0, -wa * 0.25);
    }
    // hips offset (source metres → this body, avatar space) + lean
    actor.offset.set(ah[0] * kS, ah[1] * kS, ah[2] * kS);
    actor.tilt.setFromEuler(te.set(this.leanP, 0, this.leanR, 'YXZ'));
    this.state = rag ? 'ragdoll' : seated ? (drive ? 'drive' : 'sit') : air ? 'air' : swim ? 'swim' : push ? 'push' : strain ? 'strain' : carry ? 'carry' : STATES[Math.round(clamp(gg, 0, 3))];
    // per-bone write weights: head / neck keep the tracking; the torso keeps some tracked lean when standing still;
    // arms keep the tracked pose while the performer gestures (standing / sitting, hands free)
    const still = (1 - moving) * (1 - this.wCarry) * (1 - this.wPush) * (1 - this.wSwim) * (1 - this.wAir) * (1 - this.wLimp);
    this.measureGestures();
    for (let b = 0; b < NB; b++) {
      let k = 1;
      if (b === B_HEAD) k = 0.12;
      else if (b === B_NECK) k = 0.3;
      else if (G_SPINE[b]) k = 1 - 0.3 * still;
      else if (G_ARMS[b]) k = 1 - this.gestureKeep[B_SIDE[b]] * still * (this.wDrive > 0.5 ? 0.6 : 1);
      this.kW[b] = k;
    }
  }

  private shot(id: string, rate: number, t0: number, end: number, max: number) {
    const c = packed.get(id);
    if (!c || max <= 0.05) return;
    for (let i = this.shots.length - 1; i >= 0; i--) if (this.shots[i].id === id) this.shots.splice(i, 1);
    this.shots.push({ c, t: t0 * c.dur, rate, w: 0, end: end * c.dur, max, id });
  }

  /** How far the TRACKED upper arms are raised from the tracking's relaxed hang (0 = hanging, 1 = clearly gesturing). */
  private measureGestures() {
    const h = this.rt?.humanoid;
    if (!h) return;
    for (let k = 0; k < 2; k++) {
      tq1.identity();
      for (const b of GEST_CHAIN[SIDES[k]]) { const n = h.getNormalizedBoneNode(b); if (n) tq1.multiply(n.quaternion); }
      const ang = tv.copy(this.restUpperN[k]).applyQuaternion(tq1).angleTo(this.relaxN[k]);
      this.gestureKeep[k] += (smooth(0.45, 0.85, ang) - this.gestureKeep[k]) * 0.2;
    }
  }

  // ---------------------------------------------------------------- write the bones
  /** Foot locking: a foot the clip puts down stays on its world spot until the clip lifts it (two-bone IK on the leg,
   *  the foot keeps the clip's orientation). Absorbs what the stride warp / blends / turning can't match exactly. */
  private lockFeet(dt: number, actor: SceneActor) {
    const grounded = this.wSit + this.wDrive + this.wAir + this.wLimp + this.wSwim < 0.02;
    this.ikW = approach(this.ikW, grounded && this.legGeo.length === 2 ? 1 : 0, dt / 0.15);
    if (this.ikW <= 0.001 || this.legGeo.length !== 2 || !this.rt) { this.lockSt[0].on = this.lockSt[1].on = false; return; }
    const h = this.rt.humanoid!;
    const hipsN = h.getNormalizedBoneNode('hips');
    if (!hipsN) return;
    actor.lift.updateWorldMatrix(true, false);
    const M = actor.lift.matrixWorld;
    mInv.copy(M).invert();
    const ground = actor.mount.matrixWorld.elements[13];
    const sc = actor.scale;
    // hips joint in anchor space (+ the tracked head-follow shift of the model wrapper)
    const off = this.rt.profile.transform.offset;
    hA.copy(this.hipsA).add(v5.set(this.rt.wrapper.position.x - off[0], this.rt.wrapper.position.y - off[1], this.rt.wrapper.position.z - off[2]));
    const Qh = hipsN.quaternion;
    const lowSide = this.footHeight(0, Qh, M) < this.footHeight(1, Qh, M) ? 0 : 1;
    for (let k = 0; k < 2; k++) {
      const L = this.legGeo[k], S = this.lockSt[k];
      // current (clip) pose, normalized space relative to the hips joint
      qU.copy(Qh).multiply(L.ul.quaternion); qL.copy(qU).multiply(L.ll.quaternion);
      hipJ.copy(L.hipOff).applyQuaternion(Qh);
      knee.copy(L.oL).applyQuaternion(qU).add(hipJ);
      ank.copy(L.oF).applyQuaternion(qL).add(knee);
      ankW.copy(ank).applyQuaternion(this.fromNorm).add(hA).applyMatrix4(M);
      const hgt = ankW.y - ground;
      const legW = (L.a + L.b) * sc;
      // planted = the clip holds this foot low AND (nearly) still in the world; lifting / swinging releases it
      const fv = Number.isNaN(S.px) ? 0 : Math.hypot(ankW.x - S.px, ankW.z - S.pz) / dt;
      S.px = ankW.x; S.pz = ankW.z;
      const bodyV = Math.hypot(this.vel.x, this.vel.z);
      const still = fv < Math.max(0.3 * bodyV, 0.12 * Math.sqrt(sc));
      const low = hgt < L.ankH * sc + 0.035 * legW && (k === lowSide || hgt < L.ankH * sc + 0.012 * legW);
      if (low && still && !S.on) { S.on = true; S.x = ankW.x; S.z = ankW.z; }
      else if (!low || (S.on && fv > 0.9 * bodyV + 0.3 * Math.sqrt(sc))) S.on = false;
      if (S.on && Math.hypot(S.x - ankW.x, S.z - ankW.z) > 0.4 * legW) S.on = false;      // too far behind: let it go
      S.w = approach(S.w, S.on ? 1 : 0, dt / (S.on ? 0.05 : 0.12));
      const w = S.w * this.ikW;
      if (w <= 0.001) continue;
      // target: the locked spot (the clip keeps the height), back into normalized space relative to the hip joint
      tgt.set(ankW.x + (S.x - ankW.x) * w, ankW.y, ankW.z + (S.z - ankW.z) * w).applyMatrix4(mInv).sub(hA).applyQuaternion(this.toNorm).sub(hipJ);
      const d = clamp(tgt.length(), Math.abs(L.a - L.b) + 1e-4, (L.a + L.b) * 0.999);
      dirV.copy(tgt).normalize();
      // bend plane from the clip's own knee
      pole.copy(knee).sub(hipJ); pole.addScaledVector(dirV, -pole.dot(dirV));
      if (pole.lengthSq() < 1e-10) pole.set(0, 0, 1).applyQuaternion(Qh);
      pole.normalize();
      const cosA = clamp((L.a * L.a + d * d - L.b * L.b) / (2 * L.a * d), -1, 1);
      kn.copy(dirV).multiplyScalar(L.a * cosA).addScaledVector(pole, L.a * Math.sqrt(1 - cosA * cosA));   // new knee (rel. hip)
      // upper: swing its bone direction onto the new knee
      v5.copy(L.oL).applyQuaternion(qU).normalize();
      qA.setFromUnitVectors(v5, v6.copy(kn).normalize()).multiply(qU);
      // lower: follow, then swing onto the target
      qB.copy(qA).multiply(L.ll.quaternion);
      v5.copy(L.oF).applyQuaternion(qB).normalize();
      qB.premultiply(qC.setFromUnitVectors(v5, v6.copy(dirV).multiplyScalar(d).sub(kn).normalize()));
      // keep the foot's world orientation from the clip
      qF.copy(qL).multiply(L.ft.quaternion);
      L.ul.quaternion.copy(qC.copy(Qh).invert().multiply(qA));
      L.ll.quaternion.copy(qC.copy(qA).invert().multiply(qB));
      L.ft.quaternion.copy(qC.copy(qB).invert().multiply(qF));
    }
  }
  private footHeight(k: number, Qh: THREE.Quaternion, M: THREE.Matrix4) {
    const L = this.legGeo[k];
    qU.copy(Qh).multiply(L.ul.quaternion); qL.copy(qU).multiply(L.ll.quaternion);
    ank.copy(L.oF).applyQuaternion(qL).add(knee.copy(L.oL).applyQuaternion(qU)).add(hipJ.copy(L.hipOff).applyQuaternion(Qh));
    return ankW.copy(ank).applyQuaternion(this.fromNorm).add(hA).applyMatrix4(M).y;
  }

  private write() {
    const acc = this.acc, D = this.D, W = this.W;
    // clip locals → world deltas over the full clip skeleton (a bone the model lacks still carries its rotation down)
    for (let b = 0; b < NB; b++) {
      const q = tq1.fromArray(acc, b * 4);
      if (this.vrm0) { q.x = -q.x; q.z = -q.z; }
      const p = PARENT[b];
      if (p >= 0) D[b].copy(D[p]).multiply(q); else D[b].copy(q);
    }
    for (const L of this.chain) {
      const Wb = W[L.bi].copy(D[L.bi]).multiply(L.sInv);
      const local = tq2.copy(L.parent >= 0 ? W[L.parent] : qI).invert().multiply(Wb);
      const k = this.kW[L.bi];
      if (k >= 0.999) L.node.quaternion.copy(local); else if (k > 0.001) L.node.quaternion.slerp(local, k);
    }
  }
}
const B_HEAD = idx('head'), B_NECK = idx('neck');
const B_SIDE = new Uint8Array(NB); for (let b = 0; b < NB; b++) B_SIDE[b] = BONES[b].startsWith('right') ? 1 : 0;
const te = new THREE.Euler();
const mInv = new THREE.Matrix4();
const hA = new THREE.Vector3(), hipJ = new THREE.Vector3(), knee = new THREE.Vector3(), ank = new THREE.Vector3(), ankW = new THREE.Vector3();
const tgt = new THREE.Vector3(), dirV = new THREE.Vector3(), pole = new THREE.Vector3(), kn = new THREE.Vector3(), v5 = new THREE.Vector3(), v6 = new THREE.Vector3();
const qU = new THREE.Quaternion(), qL = new THREE.Quaternion(), qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), qC = new THREE.Quaternion(), qF = new THREE.Quaternion();
const qI = new THREE.Quaternion();
