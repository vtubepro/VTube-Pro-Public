// The dice throw: Rapier physics from the roll's seed → a recorded track per die (tray-local, 60 fps). Every page runs
// the same simulation from the same seed (same WASM build → the same numbers), so every OBS page and every guest's
// OBS shows the same throw; the faces are then forced to the host's result by a symmetry turn (diceGeo.relabel), so
// the RESULT is right even if a page's float math ever drifted. Pure (no DOM): runs in Node for the tests.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { sfc32 } from '../../../shared/ttrpg/dice.ts';
import { dieShape, facesShowing, kindFor, relabel, upIndex, type DieShape } from './diceGeo.ts';

let ready: Promise<void> | null = null;
export function initPhysics(): Promise<void> { return (ready ??= RAPIER.init()); }

export interface TrayDims { w: number; d: number; rim: number; die: number }
export interface SimDie { sides: number; value: number; tens?: boolean }
export interface DieTrack {
  kind: string; sides: number; value: number; tens: boolean;
  /** frames × [x, y, z, qx, qy, qz, qw] in tray space, metres (tray floor centre = origin, +Y up, throw towards +Z). */
  frames: Float32Array;
  /** Visual offset (body space) that makes the wanted number face up at rest. */
  fix: THREE.Quaternion;
  /** Which face / vertex ended up on top (before the fix) — tests compare it between pages. */
  up: number;
}
export interface Throw { tracks: DieTrack[]; fps: number; settle: number; hash: string; ms: number }

const FPS = 60, SUB = 2, MAX_S = 5;

/** Split a roll's dice into physical dice (d100 → tens + ones d10). At most 12 physical dice are thrown. */
export function physicalDice(dice: { s: number; v: number }[]): SimDie[] {
  const out: SimDie[] = [];
  for (const d of dice) {
    if (d.s === 100) {
      const v = d.v, ones = v % 10, tens = Math.floor((v % 100) / 10);
      out.push({ sides: 100, value: tens === 0 ? 10 : tens, tens: true }, { sides: 10, value: ones === 0 ? 10 : ones });
    } else out.push({ sides: d.s, value: d.v });
    if (out.length >= 12) break;
  }
  return out.slice(0, 12);
}

export async function simulateThrow(dice: SimDie[], seed: number, tray: TrayDims): Promise<Throw> {
  await initPhysics();
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const rnd = sfc32(seed ^ 0x9e37);
  const s = tray.die;                                    // die size (m): physics runs in die units (size 1)
  const W = tray.w / s, D = tray.d / s, H = Math.max(tray.rim / s, 1.2);
  const g = (9.81 / s) * 0.72;                           // a touch floaty: reads better on stream
  const world = new RAPIER.World({ x: 0, y: -g, z: 0 });
  world.timestep = 1 / (FPS * SUB);
  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const wall = (hx: number, hy: number, hz: number, x: number, y: number, z: number, fr = 0.35) =>
    world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(fr).setRestitution(0.3), fixed);
  const T = 2;                                           // wall thickness
  wall(W / 2 + T, T / 2, D / 2 + T, 0, -T / 2, 0, 0.75);             // floor (felt)
  const top = Math.max(H, 6);
  wall(T / 2, top, D / 2 + T, -W / 2 - T / 2, top, 0); wall(T / 2, top, D / 2 + T, W / 2 + T / 2, top, 0);
  wall(W / 2 + T, top, T / 2, 0, top, -D / 2 - T / 2); wall(W / 2 + T, top, T / 2, 0, top, D / 2 + T / 2);
  wall(W / 2 + T, T / 2, D / 2 + T, 0, 2 * top + T / 2, 0);            // lid: nothing ever leaves the tray
  const shapes: DieShape[] = [];
  const bodies: RAPIER.RigidBody[] = [];
  const n = dice.length;
  dice.forEach((d, i) => {
    const shape = dieShape(kindFor(d.sides));
    shapes.push(shape);
    // thrown from the −Z edge, in a loose row, towards +Z with spin
    const lane = n > 1 ? (i / (n - 1) - 0.5) * Math.min(W * 0.7, n * 1.3) : 0;
    const x = lane + (rnd() - 0.5) * 0.6, y = Math.min(top * 1.6, H + 1.2 + rnd() * 1.5 + (i % 3) * 0.6), z = -D / 2 + 0.9 + rnd() * 0.5;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 6.283, rnd() * 6.283, rnd() * 6.283));
    const sp = D * (1.5 + rnd() * 0.7);
    const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinvel((rnd() - 0.5) * 3 - lane * 0.4, -2 - rnd() * 2, sp).setAngvel({ x: (rnd() - 0.5) * 40, y: (rnd() - 0.5) * 30, z: (rnd() - 0.5) * 40 })
      .setLinearDamping(0.15).setAngularDamping(0.35).setCcdEnabled(true).setCanSleep(true);
    const body = world.createRigidBody(desc);
    const col = shape.kind === 'd6'
      ? RAPIER.ColliderDesc.roundCuboid(0.44, 0.44, 0.44, 0.06)
      : RAPIER.ColliderDesc.roundConvexHull(shape.hull.map((v) => v * 0.94) as Float32Array, 0.03) ?? RAPIER.ColliderDesc.convexHull(shape.hull)!;
    world.createCollider(col.setFriction(0.45).setRestitution(0.35).setDensity(1.2), body);
    bodies.push(body);
  });
  const maxF = MAX_S * FPS;
  const frames = dice.map(() => new Float32Array(maxF * 7));
  let f = 0, settle = maxF, still = 0;
  for (; f < maxF; f++) {
    bodies.forEach((b, i) => {
      const p = b.translation(), r = b.rotation(), o = f * 7, a = frames[i];
      a[o] = p.x * s; a[o + 1] = p.y * s; a[o + 2] = p.z * s; a[o + 3] = r.x; a[o + 4] = r.y; a[o + 5] = r.z; a[o + 6] = r.w;
    });
    const moving = bodies.some((b) => !b.isSleeping() && (lenSq(b.linvel()) > 0.02 || lenSq(b.angvel()) > 0.05));
    still = moving ? 0 : still + 1;
    if (still > 12 && f > 30) { settle = f + 1; f++; break; }
    for (let k = 0; k < SUB; k++) world.step();
  }
  const count = Math.min(f, maxF);
  const tracks: DieTrack[] = dice.map((d, i) => {
    const a = frames[i], o = (count - 1) * 7;
    const q = new THREE.Quaternion(a[o + 3], a[o + 4], a[o + 5], a[o + 6]);
    const shape = shapes[i];
    const up = upIndex(shape, q);
    const want = facesShowing(shape, d.sides, d.value, !!d.tens);
    const fix = want.includes(up) ? new THREE.Quaternion() : relabel(shape, want[0] ?? up, up);
    return { kind: shape.kind, sides: d.sides, value: d.value, tens: !!d.tens, frames: a.slice(0, count * 7), fix, up };
  });
  world.free();
  // a short fingerprint of the throw (rounded final poses): pages compare it to prove they threw the same dice
  let h = 0x811c9dc5;
  for (const t of tracks) { const o = t.frames.length - 7; for (let k = 0; k < 7; k++) { h ^= Math.round(t.frames[o + k] * 1e4); h = Math.imul(h, 0x01000193); } h ^= t.up; }
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { tracks, fps: FPS, settle: settle / FPS, hash: (h >>> 0).toString(16), ms: Math.round((t1 - t0) * 10) / 10 };
}
const lenSq = (v: { x: number; y: number; z: number }) => v.x * v.x + v.y * v.y + v.z * v.z;

/** Pose of a die at time t (s since the throw) — interpolated. */
export function sampleTrack(tr: DieTrack, fps: number, t: number, pos: THREE.Vector3, q: THREE.Quaternion) {
  const n = tr.frames.length / 7;
  const x = Math.max(0, Math.min(n - 1, t * fps));
  const i = Math.floor(x), j = Math.min(n - 1, i + 1), u = x - i;
  const a = tr.frames, o = i * 7, p = j * 7;
  pos.set(a[o] + (a[p] - a[o]) * u, a[o + 1] + (a[p + 1] - a[o + 1]) * u, a[o + 2] + (a[p + 2] - a[o + 2]) * u);
  q.set(a[o + 3], a[o + 4], a[o + 5], a[o + 6]);
  if (u > 0 && j !== i) q.slerp(tmpQ.set(a[p + 3], a[p + 4], a[p + 5], a[p + 6]), u);
}
const tmpQ = new THREE.Quaternion();
