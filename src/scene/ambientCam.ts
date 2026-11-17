// Ambient cameras (shared/ambientCam.ts): per-room camera paths for PRESHOW / BRB / OUTRO, generated from the room's
// bounds, spots, screen and authored CAM_* presets, and validated against the room itself (RoomRays: BVH raycasts on the
// occluders + the collider boxes) before use:
//   * every sampled camera position is inside the room: floor below, below the ceiling, inside the (area) bounds,
//     line of sight back to the room's centre of interest (so never behind a wall), not inside / touching a collider;
//   * the path between samples is clear (no flying through props);
//   * what it looks at is visible (the aim point isn't hidden behind a wall).
// A variant that fails is re-planned (smaller radius, other side, other height); a move that can't be made in this room
// falls back to the next move, then to a static security cam, then to the room's normal camera.
// Deterministic: the path depends only on (room, move, shot number k, speed, screen on/off), and the pose on u (0…1
// through the shot, from the wall clock) — every OBS page renders the same camera.
import * as THREE from 'three';
import { AMB_MOVES, ambientShot, type AmbMoveId, type AmbShot } from '../../shared/ambientCam.ts';
import type { CamPose } from './cameraRig.ts';
import type { RoomInfo } from './contract.ts';
import type { RoomRays } from './twoShot.ts';
import type { SceneRuntime } from './SceneRuntime.ts';
import { lookPose } from './cameraRig.ts';

/** What the planner knows about a room (built from RoomInfo by `ambRoomOf`, or synthetic in tests). */
export interface AmbRoom {
  id: string;
  bounds: THREE.Box3;
  floorY: number;
  /** Points of interest at head height (occupied spots first). */
  focus: THREE.Vector3[];
  /** The screen's centre when a screen video is on it (the camera aims there), else null. */
  screen: THREE.Vector3 | null;
  /** Which way the performers face (flat, unit), or null: cameras stay on that side (faces, not backs of heads). */
  front?: THREE.Vector3 | null;
  /** Authored cameras (CAM_*, SPOT_xx_CAM). */
  cams: { name: string; position: THREE.Vector3; quaternion: THREE.Quaternion; fov: number }[];
  /** Line-of-sight test against the room geometry (RoomRays.clear). */
  clear(a: THREE.Vector3, b: THREE.Vector3): boolean;
  /** Point inside a collider box (padded)? */
  inside(p: THREE.Vector3, pad: number): boolean;
  /** Ceiling height above p, or null. */
  ceiling(p: THREE.Vector3): number | null;
  /** Floor height below p, or null. */
  floor(p: THREE.Vector3): number | null;
  /** A view ray that meets nothing (the frame would show void past the set); absent = not checked (void / space rooms,
   *  synthetic tests). Framing guarantee: an ambient camera never looks out of the set. */
  open?(from: THREE.Vector3, dir: THREE.Vector3): boolean;
}

/** Does the frame of a camera at `pos` aimed at `target` (vertical lens `fov`, 16:9) look out of the set anywhere at its
 *  edges? (6 rays: the corners and the side middles) */
function viewOpen(r: AmbRoom, pos: THREE.Vector3, target: THREE.Vector3, fov: number): boolean {
  if (!r.open) return false;
  const f = target.clone().sub(pos).normalize();
  if (Math.abs(f.y) > 0.99) return false;
  const right = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize(), up = new THREE.Vector3().crossVectors(right, f).normalize();
  const vt = Math.tan((fov * Math.PI) / 360) * 0.94, ht = vt * (16 / 9);
  for (const [x, y] of [[-1, 1], [1, 1], [-1, -1], [1, -1], [-1, 0], [1, 0]]) {
    if (r.open(pos, f.clone().addScaledVector(right, x * ht).addScaledVector(up, y * vt).normalize())) return true;
  }
  return false;
}

/** A planned move: pose at u (0 … 1). */
export interface AmbPath { move: AmbMoveId; k: number; pose(u: number, t: number): { pos: THREE.Vector3; target: THREE.Vector3; fov: number } }

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
/** Small deterministic PRNG (mulberry32) seeded from the room id + move + shot. */
export function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Ease in-out with a steady middle (a camera operator's move: no stop-start). */
const ease = (u: number) => { const c = Math.min(1, Math.max(0, u)); return c < 0.15 ? (c * c) / 0.3 / 0.85 : c > 0.85 ? 1 - ((1 - c) * (1 - c)) / 0.3 / 0.85 : (c - 0.075) / 0.85; };

/** Centre of interest: the screen (a BRB video playing) or the people (spots), else the room centre. */
function centre(r: AmbRoom, k: number, rand: () => number): THREE.Vector3 {
  if (r.screen) return r.screen.clone();
  if (r.focus.length) {
    // some shots frame one spot, others the group
    if (r.focus.length > 1 && k % 3 === 2) return r.focus[Math.floor(rand() * r.focus.length)].clone();
    return r.focus.reduce((s, p) => s.add(p), V(0, 0, 0)).divideScalar(r.focus.length);
  }
  const c = r.bounds.getCenter(V(0, 0, 0)); c.y = r.floorY + 1.3; return c;
}

/** Camera height limits at p: above the floor, under the ceiling. */
function heightOk(r: AmbRoom, p: THREE.Vector3) {
  const f = r.floor(p.clone().setY(p.y));
  if (f === null || p.y - f < 0.35) return false;
  const c = r.ceiling(p);
  return c === null || c - p.y > 0.2;
}

/** Is this camera position legal (inside the room, off the props, sees the room centre)? */
export function posOk(r: AmbRoom, p: THREE.Vector3, look: THREE.Vector3): boolean {
  const b = r.bounds;
  if (p.x < b.min.x + 0.15 || p.x > b.max.x - 0.15 || p.z < b.min.z + 0.15 || p.z > b.max.z - 0.15 || p.y > b.max.y - 0.1) return false;
  if (r.inside(p, 0.25)) return false;
  if (!heightOk(r, p)) return false;
  return r.clear(p, look);
}

/** Validate a whole path: samples legal, the legs between them clear, the aim visible. */
export function pathOk(r: AmbRoom, path: AmbPath, n = 24): boolean {
  let prev: THREE.Vector3 | null = null;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const { pos, target, fov } = path.pose(u, u * 20);
    // the aim point may sit on a surface (a screen, a face): test a little in front of it
    const aim = target.clone().lerp(pos, Math.min(0.9, 0.35 / Math.max(0.35, pos.distanceTo(target))));
    if (!posOk(r, pos, aim)) return false;
    if (i % 3 === 0 && viewOpen(r, pos, target, fov)) return false;
    if (prev && prev.distanceToSquared(pos) > 1e-6 && !r.clear(prev, pos)) return false;
    prev = pos;
  }
  return true;
}

/** A good vantage for static-ish moves: an authored camera (seeded pick) or a computed one looking at `c`. */
/** A camera angle (about +Y, from the centre) on the side the performers face: ±65° around their facing, any angle when unknown. */
function frontAngle(r: AmbRoom, c: THREE.Vector3, rand: () => number) {
  let f = r.front ?? null;
  if (r.screen && r.focus.length) { const p = r.focus.reduce((s, q) => s.add(q), V(0, 0, 0)).divideScalar(r.focus.length); f = p.sub(c).setY(0); if (f.lengthSq() < 1e-4) f = r.front ?? null; }
  if (!f || f.lengthSq() < 1e-6) return rand() * Math.PI * 2;
  return Math.atan2(f.x, f.z) + (rand() - 0.5) * THREE.MathUtils.degToRad(130);
}

function vantage(r: AmbRoom, c: THREE.Vector3, rand: () => number, dist: number, high: number): THREE.Vector3 {
  const a = frontAngle(r, c, rand);
  return V(c.x + Math.sin(a) * dist, r.floorY + high, c.z + Math.cos(a) * dist);
}

/** Build one variant of a move (try = the attempt number: later attempts are tighter / lower-risk). */
function build(r: AmbRoom, move: AmbMoveId, k: number, speed: number, tr: number): AmbPath | null {
  const rand = rng(`${r.id}|${move}|${k}|${tr}|${r.screen ? 's' : '-'}`);
  const c = centre(r, k, rand);
  const size = r.bounds.getSize(V(0, 0, 0));
  const span = Math.max(1.2, Math.min(size.x, size.z) * 0.5);
  const shrink = 1 - Math.min(0.6, tr * 0.12);
  const dist = Math.min(span * 0.9, (2.4 + rand() * 2.2)) * shrink;
  const sp = speed;
  const dir = rand() < 0.5 ? -1 : 1;
  const P = (pose: AmbPath['pose']): AmbPath => ({ move, k, pose });
  switch (move) {
    case 'pan': {
      const p = vantage(r, c, rand, dist, 1.35 + rand() * 0.5);
      const base = Math.atan2(c.x - p.x, c.z - p.z), sweep = THREE.MathUtils.degToRad(14 * sp) * dir, d = p.distanceTo(c);
      return P((u) => { const a = base + sweep * (ease(u) - 0.5); return { pos: p.clone(), target: V(p.x + Math.sin(a) * d, c.y, p.z + Math.cos(a) * d), fov: 38 }; });
    }
    case 'orbit': {
      const a0 = frontAngle(r, c, rand) - THREE.MathUtils.degToRad(19 * sp) * dir, sweep = THREE.MathUtils.degToRad(38 * sp) * dir, h = c.y + 0.2 + rand() * 0.6;
      return P((u) => { const a = a0 + sweep * ease(u); return { pos: V(c.x + Math.sin(a) * dist, h, c.z + Math.cos(a) * dist), target: c.clone(), fov: 36 }; });
    }
    case 'dolly': {
      const p = vantage(r, c, rand, dist, 1.3 + rand() * 0.4);
      const into = k % 2 === 0, frac = Math.min(0.55, 0.28 * sp);
      return P((u) => ({ pos: p.clone().lerp(c, frac * (into ? ease(u) : 1 - ease(u))), target: c.clone(), fov: 36 }));
    }
    case 'crane': {
      const p = vantage(r, c, rand, dist, 0);
      const up = k % 2 === 0, lo = r.floorY + 0.8, hi = Math.min(r.floorY + 0.8 + 1.4 * Math.min(1.6, sp), r.bounds.max.y - 0.3);
      return P((u) => { const e = up ? ease(u) : 1 - ease(u); return { pos: V(p.x, lo + (hi - lo) * e, p.z), target: c.clone().setY(c.y + 0.2 * e), fov: 40 }; });
    }
    case 'zoom': {
      // no depth of field in the renderer: a slow focal-length pull stands in for the rack-focus shot
      const p = vantage(r, c, rand, dist, 1.4 + rand() * 0.3);
      const f0 = 42, f1 = Math.max(18, 42 - 16 * sp);
      return P((u) => ({ pos: p.clone(), target: c.clone(), fov: f0 + (f1 - f0) * ease(u) }));
    }
    case 'drift': {
      const p = vantage(r, c, rand, dist, 1.45 + rand() * 0.25);
      const ph = [rand(), rand(), rand(), rand()].map((x) => x * 100);
      const amp = 0.035 * sp;
      // handheld: a few slow incommensurate sines (deterministic from the clock, no random walk)
      const w = (t: number, i: number) => Math.sin(t * 0.61 + ph[i]) * 0.6 + Math.sin(t * 1.37 + ph[i] * 1.7) * 0.3 + Math.sin(t * 2.9 + ph[i] * 0.3) * 0.1;
      return P((_u, t) => ({ pos: V(p.x + w(t, 0) * amp, p.y + w(t, 1) * amp * 0.6, p.z + w(t, 2) * amp), target: V(c.x + w(t, 3) * amp * 3, c.y + w(t, 0) * amp * 2, c.z), fov: 37 }));
    }
    case 'security': {
      // high in a corner of the room, wide lens, looking down at the room centre
      const b = r.bounds, cx = rand() < 0.5 ? b.min.x : b.max.x, cz = rand() < 0.5 ? b.min.z : b.max.z;
      const corner = V(cx, 0, cz).lerp(V(c.x, 0, c.z), 0.12 + tr * 0.1);
      const ceil = r.ceiling(V(corner.x, r.floorY + 1, corner.z));
      corner.y = Math.min((ceil ?? r.floorY + 3.2) - 0.3, r.floorY + 2.7, b.max.y - 0.3);
      return P(() => ({ pos: corner.clone(), target: c.clone().setY(r.floorY + 0.9), fov: 68 }));
    }
    case 'tour': {
      const cams = r.cams;
      if (cams.length < 2) return null;
      const i = (k + tr) % cams.length, j = (i + 1) % cams.length;
      const a = cams[i], b2 = cams[j];
      const fwd = (q: THREE.Quaternion, p: THREE.Vector3) => p.clone().add(V(0, 0, -3).applyQuaternion(q));
      return P((u) => { const e = ease(u); return { pos: a.position.clone().lerp(b2.position, e), target: fwd(a.quaternion, a.position).lerp(fwd(b2.quaternion, b2.position), e), fov: a.fov + (b2.fov - a.fov) * e }; });
    }
  }
}

/** The best valid path for (move, k): a few variants of it, else the other moves, else null. */
export function planPath(r: AmbRoom, move: AmbMoveId, k: number, speed: number): AmbPath | null {
  const order: AmbMoveId[] = [move, ...(move === 'security' ? [] : ['security' as AmbMoveId]), ...AMB_MOVES.filter((m) => m !== move && m !== 'security')];
  for (const m of order) for (let tr = 0; tr < 6; tr++) {
    const p = build(r, m, k, speed, tr);
    if (p && pathOk(r, p)) return p;
  }
  return null;
}

/** Plans cached per (room, move, k, speed, screen) — raycasts happen once per shot, not per frame. */
export class AmbientDirector {
  private cache = new Map<string, AmbPath | null>();
  private roomKey = '';
  /** The shot + pose at `now` (epoch ms) for this room, or null (room camera as usual). */
  shot(r: AmbRoom, a: Parameters<typeof ambientShot>[0], lighting: string | undefined, now: number): { key: string; pose: CamPose; secs: number; shot: AmbShot } | null {
    const s = ambientShot(a, lighting, now);
    if (!s) return null;
    if (r.id !== this.roomKey) { this.cache.clear(); this.roomKey = r.id; }
    const ck = `${s.move}|${s.k}|${s.speed}|${r.screen ? 1 : 0}`;
    let p = this.cache.get(ck);
    if (p === undefined) {
      p = planPath(r, s.move, s.k, s.speed);
      if (this.cache.size > 64) this.cache.clear();
      this.cache.set(ck, p);
    }
    if (!p) return null;
    const t = now / 1000;
    const { pos, target, fov } = p.pose(s.u, t);
    return { key: `amb:${s.state}:${ck}`, pose: lookPose(pos, target, fov), secs: s.cut ? 0 : Math.min(4, s.secs * 0.2), shot: s };
  }
  info() { return { room: this.roomKey, plans: [...this.cache.entries()].map(([k, v]) => `${k} → ${v ? v.move : 'none'}`) }; }
}

/** AmbRoom from a loaded room (SceneRuntime): occupied spots first, the screen when a video is on it. */
export function ambRoomOf(id: string, room: RoomInfo, rays: RoomRays, occupied: number[], screen: THREE.Vector3 | null, openOk: 'none' | 'sky' | 'all' = 'all'): AmbRoom {
  const spots = room.spots.filter((s): s is NonNullable<typeof s> => !!s);
  const occ = occupied.map((i) => room.spots[i]).filter((s): s is NonNullable<typeof s> => !!s);
  const use = occ.length ? occ : spots;
  const floorY = use.length ? use.reduce((a, s) => a + s.position.y, 0) / use.length : room.bounds.isEmpty() ? 0 : room.bounds.min.y;
  const cams = [...room.cameras.values(), ...spots.map((s) => s.cam).filter((c): c is NonNullable<typeof c> => !!c)]
    .filter((c) => !/REACT|SOLO/i.test(c.name));
  return {
    id, bounds: room.bounds.isEmpty() ? new THREE.Box3(V(-4, floorY, -4), V(4, floorY + 3.5, 4)) : room.bounds, floorY,
    focus: use.map((s) => s.position.clone().setY(s.position.y + 1.35)), screen, cams,
    front: use.length ? use.reduce((a, s) => a.add(s.forward), V(0, 0, 0)).setY(0).normalize() : null,
    clear: (a, b) => rays.clear(a, b), inside: (p, pad) => rays.insideCollider(p, pad),
    ceiling: (p) => rays.ceilingAbove(p), floor: (p) => rays.floorBelow(p),
    // (indoors any ray into nothing is void; outdoors an engine draws sky / horizon, so only steep looks down count)
    ...(openOk === 'all' ? {} : { open: (from: THREE.Vector3, dir: THREE.Vector3) => (openOk === 'none' || dir.y < -0.35) && rays.hit(from, from.clone().addScaledVector(dir, 60), 0.02) === Infinity }),
  };
}

/** One director per page (a room change clears its plans). */
export const ambientDirector = new AmbientDirector();
const tmpBox = new THREE.Box3();

/** SceneRuntime hook: the ambient shot for this page right now (Talk only, no stage layout owning the frame), or null. */
export function ambientFor(rt: SceneRuntime): { key: string; pose: CamPose; secs: number } | null {
  const s = rt.state;
  if (!s.ambcam?.on || s.mode !== 'talk' || s.stage?.hole) return null;
  const ls = s.lights.state;
  if (ls !== 'preshow' && ls !== 'brb' && ls !== 'outro') return null;
  let screen: THREE.Vector3 | null = null;
  if (rt.videoLay === 'big' && rt.room.screen) screen = tmpBox.setFromObject(rt.room.screen.surface).getCenter(new THREE.Vector3());
  const occupied = Object.values(s.spots).filter((i) => i < 12);
  const r = ambRoomOf(`${s.sceneId ?? 'none'}|${occupied.join(',')}`, rt.room, rt.seatEnv.rays(), occupied, screen, rt.framing.guard ? rt.openOk : 'all');
  const shot = ambientDirector.shot(r, s.ambcam, ls, Date.now());
  return shot ? { key: shot.key, pose: shot.pose, secs: shot.secs } : null;
}
