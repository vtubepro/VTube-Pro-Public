// The chat buddy's rig reading: which arms can hold the tablet, where the head is and how this body holds the tablet
// (proportions of its height) — for ANY humanoid rig the user picks (the builtins Sprocket / Mirelle / Kairo, VRoid
// VRMs, auto-rigged GLBs, chunky mascots). Pure (three.js maths only, no runtime) so tools/chatbuddy_unit.ts tests it.
//
// Generalised over the old frog-first code:
//  - a missing hand bone (common on auto-rigs / low-poly mascots) no longer drops the arm: the hand is taken from the
//    first finger root, else the forearm is estimated from the upper arm (straight elbow);
//  - the arm's SIDE is geometric (which side of the body the shoulder is on), not the bone name: rigs with mirrored
//    left/right mapping still hold the tablet with the hand that is actually on that side;
//  - stubby arms (shorter than ~2 % of the height, or both segments together under ~12 %) are not arms to hold with:
//    the tablet goes on its stand instead of floating in front of a stump;
//  - the body's FRONT (how far the chest sticks out in front of the feet) and torso half-width are measured, so the
//    tablet is held in front of a chunky robot's barrel chest instead of inside it.
import * as THREE from 'three';
import { faceBand, type BuddyBody } from './chatBuddyPlace.ts';

/** Rest joints (anchor space, metres) by VRM humanoid bone name. */
export type Joints = Record<string, THREE.Vector3 | undefined>;

export interface BuddyArm {
  /** Which side of the body this arm is on: +1 = the avatar's left (+x, facing +z), −1 = its right. */
  side: 1 | -1;
  /** The humanoid bone names to pose (may differ from `side` on a mirrored rig). */
  bone: 'left' | 'right';
  /** Shoulder (upper-arm joint), anchor space. */
  S: THREE.Vector3;
  /** Upper / lower arm lengths. */
  a: number; b: number;
  /** Rest directions of the upper / lower arm (anchor space; the caller turns them into normalized-rig space). */
  dirU: THREE.Vector3; dirL: THREE.Vector3;
  /** The hand position was estimated (no hand / finger bone). */
  estimated: boolean;
}

const FINGERS = ['MiddleProximal', 'IndexProximal', 'RingProximal', 'LittleProximal', 'MiddleMetacarpal', 'IndexMetacarpal', 'ThumbProximal'];

/** The arms that can hold a tablet. */
export function buddyArms(J: Joints, height: number): BuddyArm[] {
  const H = Math.max(1e-4, height);
  const out: BuddyArm[] = [];
  // body centre line (x): hips / spine, else the midpoint of the shoulders
  const mid = (J.hips ?? J.spine ?? J.chest)?.x ?? (((J.leftUpperArm?.x ?? 0) + (J.rightUpperArm?.x ?? 0)) / 2);
  for (const bone of ['left', 'right'] as const) {
    const u = J[`${bone}UpperArm`], l = J[`${bone}LowerArm`];
    if (!u || !l) continue;
    const a = u.distanceTo(l);
    if (a < H * 0.02) continue;                                               // a stub: not an arm to hold with
    const dirU = l.clone().sub(u).normalize();
    let hd = J[`${bone}Hand`];
    if (!hd || hd.distanceTo(l) < H * 0.02) hd = FINGERS.map((f) => J[`${bone}${f}`]).find((p) => p && p.distanceTo(l) > H * 0.02);
    const estimated = !hd;
    const b = hd ? hd.distanceTo(l) : a * 0.85;
    const dirL = hd ? hd.clone().sub(l).normalize() : dirU.clone();
    if (a + b < H * 0.12) continue;                                           // too short to hold anything up
    const geo = u.x - mid;
    const side: 1 | -1 = Math.abs(geo) > H * 0.01 ? (geo > 0 ? 1 : -1) : bone === 'left' ? 1 : -1;
    out.push({ side, bone, S: u.clone(), a, b, dirU, dirL, estimated });
  }
  // both arms claim the same side (a broken mapping): fall back to the bone names
  if (out.length === 2 && out[0].side === out[1].side) for (const x of out) x.side = x.bone === 'left' ? 1 : -1;
  return out;
}

/** Where the head is (the look-at pivot): head bone, neck, the measured face, else 85 % up. */
export function buddyHead(J: Joints, height: number, face?: { center: THREE.Vector3 } | null): THREE.Vector3 {
  return (J.head ?? J.neck ?? face?.center ?? new THREE.Vector3(0, height * 0.85, 0)).clone();
}

export interface BodyInput {
  height: number;
  floorY: number;
  joints: Joints;
  face: { center: THREE.Vector3; size: number };
  /** Front of the torso ahead of the root (anchor-space z, m), measured from the mesh; optional. */
  front?: number;
  /** The real head's horizontal half-extent (RestMetrics.head.half: hair, ears, a mascot's whole head); optional. */
  headHalf?: number;
  /** The real head's top above the face centre (RestMetrics.head.top: hair, cat ears, an antenna); optional. */
  headTop?: number;
}

/** Hand-tuned bodies for specific models (preset id → body + size factor + the overlay's cartoon arm colour). */
export interface TunedBuddy { body: BuddyBody; heightK: number; arm?: { skin: number; dark: number } }

/** How this body holds the tablet, measured from the rig (proportions of its height) + its size vs the room's
 *  avatars (heightK: a big head for the body — mascots, chibis — stands smaller than a human-proportioned model). */
export function measureBuddyBody(inp: BodyInput, arms: BuddyArm[]): { body: BuddyBody; heightK: number } {
  const H = Math.max(1e-4, inp.height), fy = inp.floorY, J = inp.joints;
  const frac = (y: number) => THREE.MathUtils.clamp((y - fy) / H, 0, 1);
  const head = frac(inp.face.center.y);
  const fs = inp.face.size / H;
  const cy = chestY(J);
  const chest = cy !== null ? THREE.MathUtils.clamp(frac(cy), 0.35, 0.8) : THREE.MathUtils.clamp(head - 0.22, 0.35, 0.75);
  const armLen = arms.length ? Math.max(...arms.map((a) => a.a + a.b)) / H : 0;
  // torso: half the shoulder span (else a fifth of the height); the chest's front from the mesh (else ~10 %)
  const sh = J.leftUpperArm && J.rightUpperArm ? Math.abs(J.leftUpperArm.x - J.rightUpperArm.x) / 2 / H : 0.1;
  const halfW = THREE.MathUtils.clamp(sh, 0.05, 0.3);
  const front = THREE.MathUtils.clamp((inp.front ?? H * 0.1) / H, 0.03, 0.45);
  // hold it in front of the chest: never inside a barrel chest, and no further than the arms (+ a little) reach
  const reach = THREE.MathUtils.clamp(Math.max(armLen * 0.8, front + 0.08), 0.2, Math.max(0.4, front + 0.1));
  const headW = THREE.MathUtils.clamp(Math.max(fs * 0.75, (inp.headHalf ?? 0) / H), 0.08, 0.32);
  const face = THREE.MathUtils.clamp(fs, 0.02, 0.3);
  const body: BuddyBody = {
    chest, head,
    // the chin = just under the BOTTOM of his face box (chatBuddyPlace.faceBand): a tablet topped here leaves it clear
    chin: THREE.MathUtils.clamp(head - faceBand({ head, chin: head, headW, face }).dn - 0.005, chest + 0.02, head),
    headW, face,
    ...(inp.headTop !== undefined && inp.headTop > 0 ? { top: THREE.MathUtils.clamp(head + inp.headTop / H, head, 1.1) } : {}),
    reach,
    hold: arms.length ? 'one' : 'stand',
    front, halfW,
  };
  return { body, heightK: fs > 0.17 ? 0.72 : 0.86 };
}

/** Chest height (anchor y): the chest bones, else between the spine and the shoulders (rigs with only a spine bone —
 *  auto-rigs, mascots — would otherwise hold the tablet at the belly). null = no torso bones. */
export function chestY(J: Joints): number | null {
  const c = J.upperChest ?? J.chest;
  if (c) return c.y;
  const sh = J.leftUpperArm ?? J.rightUpperArm ?? J.neck;
  if (J.spine && sh && sh.y > J.spine.y) return J.spine.y + (sh.y - J.spine.y) * 0.55;
  return (J.spine ?? sh)?.y ?? null;
}

/** The chest band to sample for torsoFront (anchor y): from a bit under the chest up to the shoulders. */
export function chestBand(J: Joints, floorY: number, height: number): [number, number] {
  const c = chestY(J) ?? floorY + height * 0.6;
  const sh = (J.leftUpperArm ?? J.rightUpperArm ?? J.neck)?.y ?? c + height * 0.12;
  return [c - height * 0.08, Math.max(sh, c + height * 0.08)];
}

/** Front of the torso (anchor-space z ahead of the root, m) from sampled mesh points in the chest band: a high
 *  percentile, so one stray vertex (a badge, an antenna) doesn't push the tablet out. null = nothing sampled. */
export function torsoFront(points: ArrayLike<number>, lo: number, hi: number, halfW: number): number | null {
  const zs: number[] = [];
  for (let i = 0; i + 2 < points.length; i += 3) {
    const x = points[i], y = points[i + 1], z = points[i + 2];
    if (y < lo || y > hi || Math.abs(x) > halfW) continue;
    zs.push(z);
  }
  if (zs.length < 8) return null;
  zs.sort((p, q) => p - q);
  return zs[Math.min(zs.length - 1, Math.floor(zs.length * 0.98))];
}
