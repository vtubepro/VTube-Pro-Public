// Head flinch + "move my model" (beta.16, docs/b16/THROW.md). Two small things act on the performer's avatar AFTER its pose
// was solved, through the onAvatarLate hook (src/avatar/b16Hooks.ts) — so they never touch tracking, the rest stabiliser
// or the retargeter's own smoothing:
//
//   1. THE FLINCH  a thrown item hits: the head snaps on a damped spring (shared/throwables.ts Flinch: strength, return time,
//                  delay), with an optional "ouch" face. The offset is ADDITIVE: it is applied to the raw head bone on top of the
//                  tracked pose and thrown away by the next frame's pose solve, so nothing accumulates and nothing is "fought".
//   2. THE NUDGE   bus command `model-move` (VTube Studio's MoveModelRequest, the deck, rules) glides the model on the picture;
//                  `model-state` answers where it is (shared/b16Commands.ts).
//
// Idle = zero cost: with nothing pending, asleep and not nudged, the hook is four comparisons. Nothing allocates per frame
// (all temporaries are module-level). 3D avatars turn the head bone; 2D avatars (profile.flat) tilt and nudge their card.
import * as THREE from 'three';
import type { AvatarRuntime } from './AvatarRuntime.ts';
import { onAvatarLate } from './b16Hooks.ts';
import { DEFAULT_THROW, flinchAsleep, kickFlinch, newFlinch, stepFlinch, type Flinch, type ThrowBag } from '../../shared/throwables.ts';
import type { ModelMove, ModelState } from '../../shared/b16Commands.ts';

export type HitSettings = Pick<ThrowBag, 'strength' | 'returnSecs' | 'delayMs' | 'ouch'>;
let settings: HitSettings = { strength: DEFAULT_THROW.strength, returnSecs: DEFAULT_THROW.returnSecs, delayMs: DEFAULT_THROW.delayMs, ouch: DEFAULT_THROW.ouch };
export function setHitSettings(s: Partial<HitSettings>) { settings = { ...settings, ...s }; }
export const hitSettings = (): HitSettings => settings;

/** Is this runtime the performer whose avatar the throws hit (this PC's own, not a party guest or an NPC)? The mount sets the real check. */
let isSelf: (rt: AvatarRuntime) => boolean = (rt) => !/^party-/.test(rt.profile.id);
/** Is this runtime the performer the throws act on? (the throw player asks the same question) */
export const isSelfRuntime = (rt: AvatarRuntime): boolean => isSelf(rt);
export function setSelfResolver(fn: ((rt: AvatarRuntime) => boolean) | null) { isSelf = fn ?? ((rt) => !/^party-/.test(rt.profile.id)); }

// ---------------------------------------------------------------- state (one performer per page)

const spring: Flinch = newFlinch();
let asleep = true;
let ouchHold = 0, ouchW = 0;
interface Pending { due: number; dx: number; dy: number; power: number; soft: boolean }
const pending: Pending[] = [];
const MAX_PENDING = 64;

/** A hit lands on the head. `dx, dy` = the way the item was travelling on screen (+x right, +y up), `power` 0..1. Plays after the delay setting.
 *  `soft` (a headpat) moves the head but never makes the pained face. */
export function hitHead(dx: number, dy: number, power: number, soft = false, now = performance.now()) {
  if (pending.length >= MAX_PENDING) pending.shift();
  pending.push({ due: now + settings.delayMs, dx, dy, power, soft });
  asleep = false;
}
/** The head's current spring angles (tests, the panel's "Try it"). */
export const flinchState = (): Readonly<Flinch> => spring;
/** Stop everything at once (an avatar switch, tests). */
export function resetHitReact() {
  Object.assign(spring, newFlinch()); pending.length = 0; asleep = true; ouchHold = 0; ouchW = 0;
}

// ---------------------------------------------------------------- the nudge (model-move)

interface Nudge { x: number; y: number; rot: number; size: number }
const nudge: Nudge = { x: 0, y: 0, rot: 0, size: 0 };
const nudgeFrom: Nudge = { x: 0, y: 0, rot: 0, size: 0 };
const nudgeTo: Nudge = { x: 0, y: 0, rot: 0, size: 0 };
let glideLeft = 0, glideTotal = 0;
let nudged = false;

/** Move the model on the picture (VTS units: x, y in -1..1 of the frame, rotation in degrees, size -100..100). Glides over `secs`. */
export function moveModel(m: ModelMove) {
  const rel = m.relative === true;
  Object.assign(nudgeFrom, nudge);
  if (m.x !== undefined) nudgeTo.x = rel ? nudgeTo.x + m.x : m.x;
  if (m.y !== undefined) nudgeTo.y = rel ? nudgeTo.y + m.y : m.y;
  if (m.rot !== undefined) nudgeTo.rot = rel ? nudgeTo.rot + m.rot : m.rot;
  if (m.size !== undefined) nudgeTo.size = rel ? nudgeTo.size + m.size : m.size;
  nudgeTo.x = clamp(nudgeTo.x, -3, 3); nudgeTo.y = clamp(nudgeTo.y, -3, 3); nudgeTo.rot = clamp(nudgeTo.rot, -360, 360); nudgeTo.size = clamp(nudgeTo.size, -100, 100);
  glideTotal = glideLeft = Math.max(0, Math.min(10, m.secs ?? 0));
  if (glideTotal === 0) Object.assign(nudge, nudgeTo);
  nudged = true;
}
/** Back to where the tracking puts it. */
export function resetNudge() { moveModel({ x: 0, y: 0, rot: 0, size: 0, secs: 0 }); }
/** Where the model is now, in VTS units. */
export function modelStateOf(rt: AvatarRuntime | null, req?: string): ModelState {
  return { ...(req ? { req } : {}), x: round(nudge.x), y: round(nudge.y), rot: round(nudge.rot), size: round(nudge.size), loaded: !!rt, id: rt?.profile.id ?? '', name: rt?.profile.name ?? '' };
}
const round = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const nudgeAtRest = () => nudgeTo.x === 0 && nudgeTo.y === 0 && nudgeTo.rot === 0 && nudgeTo.size === 0 && glideLeft <= 0;

// ---------------------------------------------------------------- the hook

interface RtBits {
  /** Avatar height (m), measured once. */
  h: number;
  head: THREE.Object3D | null;
  /** Face centre relative to the head bone, avatar space (set on the first throw). */
  faceOff: THREE.Vector3 | null; faceSize: number;
  rotBase: number | null; baseScale: THREE.Vector3 | null;
  /** Face shapes the ouch face raises. */
  ouch: { targets: readonly { mesh: THREE.Mesh; index: number }[]; w: number }[] | null;
}
const bits = new WeakMap<AvatarRuntime, RtBits>();
function bitsOf(rt: AvatarRuntime): RtBits {
  let b = bits.get(rt);
  if (!b) {
    let h = 1.6;
    try { h = rt.bounds().getSize(_v).y || 1.6; } catch { /* keep the default */ }
    b = { h, head: rt.humanoid?.getRawBoneNode('head') ?? null, faceOff: null, faceSize: 0, rotBase: null, baseScale: null, ouch: null };
    bits.set(rt, b);
  }
  return b;
}
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _e = new THREE.Euler(), _off = new THREE.Quaternion(), _qa = new THREE.Quaternion(), _qai = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _qpi = new THREE.Quaternion(), _w = new THREE.Quaternion();

/** ARKit-style pain: squeezed eyes, brows up and together, a frown, a little open mouth. Named presets for models without ARKit shapes. */
const OUCH_ARKIT: [string, number][] = [['eyeSquintLeft', 0.8], ['eyeSquintRight', 0.8], ['eyeBlinkLeft', 0.45], ['eyeBlinkRight', 0.45], ['browInnerUp', 0.7], ['browDownLeft', 0.35], ['browDownRight', 0.35], ['mouthFrownLeft', 0.6], ['mouthFrownRight', 0.6], ['jawOpen', 0.22], ['mouthStretchLeft', 0.3], ['mouthStretchRight', 0.3]];
const OUCH_NAMED: [string, number][] = [['blink', 0.6], ['sad', 0.55], ['angry', 0.25]];
function ouchTargets(rt: AvatarRuntime, b: RtBits) {
  if (b.ouch) return b.ouch;
  const list = rt.expressions?.hasArkit ? OUCH_ARKIT : OUCH_NAMED;
  b.ouch = [];
  for (const [name, w] of list) {
    const t = rt.expressions ? (rt.expressions.hasArkit ? rt.expressions.arkitTargets(name) : rt.expressions.namedTargets(name)) : [];
    if (t.length) b.ouch.push({ targets: t, w });
  }
  return b.ouch;
}

let rollDirty = false;
function late(rt: AvatarRuntime, dt: number) {
  if (asleep && !nudged && !pending.length && ouchW <= 0.001 && !rollDirty) return;
  if (!isSelf(rt)) return;
  const now = performance.now();
  // hits whose delay is over
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i];
    if (now < p.due) continue;
    pending.splice(i, 1);
    kickFlinch(spring, p.dx, p.dy, p.power, settings.strength, settings.returnSecs);
    if (!p.soft) ouchHold = Math.max(ouchHold, Math.min(1, 0.35 + p.power * 0.65));
  }
  const b = bitsOf(rt);
  if (!asleep) {
    stepFlinch(spring, dt, settings.returnSecs);
    ouchHold = Math.max(0, ouchHold - dt / Math.max(0.2, settings.returnSecs * 0.9));
    if (!pending.length && flinchAsleep(spring) && ouchHold <= 0.001) { Object.assign(spring, newFlinch()); asleep = true; }
  }
  if (nudged) stepNudge(dt);
  if (!rt.flat) applyHead(rt, b);
  else if (!asleep && (rt.flat.mode === 'card' || rt.flat.mode === 'overlay')) { rt.wrapper.position.x += spring.y * b.h * 0.1; rt.wrapper.position.y -= spring.p * b.h * 0.08; }
  if (settings.ouch && !rt.flat && (ouchHold > 0.001 || ouchW > 0.001)) applyOuch(rt, b, dt);
  else ouchW = 0;
  applyNudgeAndRoll(rt, b);
}

function stepNudge(dt: number) {
  if (glideLeft > 0) {
    glideLeft = Math.max(0, glideLeft - dt);
    const u = glideTotal > 0 ? 1 - glideLeft / glideTotal : 1, k = u * u * (3 - 2 * u);
    nudge.x = nudgeFrom.x + (nudgeTo.x - nudgeFrom.x) * k; nudge.y = nudgeFrom.y + (nudgeTo.y - nudgeFrom.y) * k;
    nudge.rot = nudgeFrom.rot + (nudgeTo.rot - nudgeFrom.rot) * k; nudge.size = nudgeFrom.size + (nudgeTo.size - nudgeFrom.size) * k;
  } else Object.assign(nudge, nudgeTo);
}

/** 3D: the spring's angles (avatar space: pitch about X, yaw about Y, roll about Z, facing +Z) turned into the head bone's local frame. */
function applyHead(rt: AvatarRuntime, b: RtBits) {
  const head = b.head;
  if (!head || !head.parent || asleep || Math.abs(spring.p) + Math.abs(spring.y) + Math.abs(spring.r) < 1e-6) return;
  _off.setFromEuler(_e.set(spring.p, spring.y, spring.r, 'YXZ'));
  rt.anchor.getWorldQuaternion(_qa); _qai.copy(_qa).invert();
  head.parent.getWorldQuaternion(_qp); _qpi.copy(_qp).invert();
  // local' = parent⁻¹ · anchor · offset · anchor⁻¹ · parent · local
  _w.copy(_qpi).multiply(_qa).multiply(_off).multiply(_qai).multiply(_qp);
  head.quaternion.premultiply(_w);
  head.updateMatrix();
}

/** The pained face, added on top of the tracked one (the face shapes are rewritten by the next frame's pose solve). */
function applyOuch(rt: AvatarRuntime, b: RtBits, dt: number) {
  const target = ouchHold;   // (raised by hits only, never by a pat; it fades over the return time)
  ouchW += (target - ouchW) * (1 - Math.exp(-dt * 16));
  if (ouchW < 0.001) { ouchW = 0; return; }
  for (const o of ouchTargets(rt, b)) {
    const v = ouchW * o.w;
    for (const t of o.targets) { const inf = t.mesh.morphTargetInfluences; if (inf) inf[t.index] = Math.min(1, inf[t.index] + v); }
  }
}

/**
 * model-move (x, y are fractions of the frame: half-height ≈ 0.6 avatar heights, 16:9, so ±1 puts the model at the picture's
 * edge) and the 2D card's tilt. The avatar re-sets its position every frame, so a position offset is simply added each frame;
 * scale and roll are kept from before the first nudge and put back when it is over.
 */
function applyNudgeAndRoll(rt: AvatarRuntime, b: RtBits) {
  const w = rt.wrapper;
  const rest = nudged && nudgeAtRest() && nudge.x === 0 && nudge.y === 0 && nudge.rot === 0 && nudge.size === 0;
  if (rest) nudged = false;
  if (nudged) {
    w.position.x += nudge.x * b.h * 1.07; w.position.y += nudge.y * b.h * 0.6;
    if (!b.baseScale) b.baseScale = w.scale.clone();
    w.scale.copy(b.baseScale).multiplyScalar(Math.max(0.1, 1 + nudge.size / 100));
  } else if (b.baseScale) { w.scale.copy(b.baseScale); b.baseScale = null; }
  const flatTilt = !!rt.flat && !asleep;
  if (nudged || flatTilt) {
    if (b.rotBase === null) b.rotBase = w.rotation.z;
    w.rotation.z = b.rotBase + (nudged ? THREE.MathUtils.degToRad(nudge.rot) : 0) + (flatTilt ? spring.r * 0.9 : 0);
    rollDirty = true;
  } else if (b.rotBase !== null) { w.rotation.z = b.rotBase; b.rotBase = null; rollDirty = false; }
}

// ---------------------------------------------------------------- where the face is (for the thrown items)

/**
 * The face centre in the avatar's own space (the group items hang under) and the head size, or 0 when the avatar has no face
 * to aim at. 3D avatars: the head bone plus an offset measured once; 2D avatars: the picture's face box (src/avatar/flat).
 */
export function faceAnchor(rt: AvatarRuntime, out: THREE.Vector3): number {
  if (rt.flat) {
    const f = rt.flat.faceWorld();
    if (!f) return 0;
    out.copy(rt.anchor.worldToLocal(_v.copy(f.center)));
    return rt.anchor.getWorldScale(_v2).y > 0 ? f.size / rt.anchor.getWorldScale(_v2).y : f.size;
  }
  const b = bitsOf(rt);
  if (!b.head) return 0;
  if (!b.faceOff) {
    const fi = rt.faceInfo();
    if (!fi) return 0;
    rt.anchor.updateWorldMatrix(true, true);
    const headLocal = rt.anchor.worldToLocal(b.head.getWorldPosition(_v));
    b.faceOff = rt.anchor.worldToLocal(_v2.copy(fi.center)).sub(headLocal);
    const s = rt.anchor.getWorldScale(_v).y || 1;
    b.faceSize = fi.size / s;
  }
  b.head.getWorldPosition(_v);
  out.copy(rt.anchor.worldToLocal(_v)).add(b.faceOff);
  return b.faceSize;
}

/** Register the hook. Returns the function that removes it. */
export function installHitReact(): () => void {
  const off = onAvatarLate(late);
  return () => { off(); resetHitReact(); };
}
