// Frontline rooms (scene.json `frontline`, first user: assets/scenes/hd_frontline): the anchors + the terrain.
//
//   HF_DEF_xx      a defender's firing post: origin = feet, +Z = faces down range; extras role = rifle | at
//   HF_SPAWN_xx    a hive mouth the swarm pours out of (origin = the mouth top; the bugs emerge at its foot)
//   HF_MECH, HF_SENTRY_xx, HF_SUPPLY    where the exosuit / sentry pods / the supply pod land (origin = ground)
//   HF_LZ          the drop-pod landing point (+Z = the hatch side), DOOR_OUTSIDE = where they step out to
//   HF_ZONE        the killing field (extras size [x, y, z]); HF_BOARD = the status board plane (extras width)
//   PAD_xx         a dropship pad (origin = ship origin, +Z = the ship's nose) + PAD_xx_BOARD (ramp foot), _APPROACH
//   TURRET_xx_head the room's own twin sentries (the engine aims them)
// The terrain is analytic: terrainY() mirrors hf_room.py's terrain() exactly (bugs walk on it without raycasts).
import * as THREE from 'three';

export interface FrontlineCfg {
  on?: boolean;
  units?: string; unitsMeta?: string; defenders?: string; defenderHeight?: number;
  seed?: number;
  /** Kick channel-point reward title keyword (lower-case) → support kind. */
  rewards?: Record<string, string>;
  /** When a title hits several keywords: support kinds, most specific first (the earlier one wins; unlisted kinds follow
   *  in the default order hellbomb, railcannon, laser, napalm, bomb500, mech, sentry, supply, strafe, barrage, airstrike).
   *  Optional: frontlineRewards.ts. */
  rewardPriority?: string[];
  /** Donation (USD) thresholds per support kind (the biggest one reached plays). */
  support?: Record<string, number>;
  /** Chat escalation: weight per message, memory (s), base aggression. */
  chat?: { weight?: number; tau?: number; base?: number };
  /** Ambient supports every N s (0 = none). */
  ambientEvery?: number;
  maxBugs?: number;
}

export interface Post { name: string; pos: THREE.Vector3; yaw: number; role: string }
export interface Pad { index: number; name: string; pos: THREE.Vector3; yaw: number; fwd: THREE.Vector3; board: THREE.Vector3; approach: THREE.Vector3 }

export interface FrontlineRoom {
  defenders: Post[];
  spawns: Post[];
  sentries: Post[];
  mech: Post | null;
  supply: Post | null;
  lz: Post | null;
  pads: Pad[];
  turrets: THREE.Object3D[];
  board: { node: THREE.Object3D; width: number } | null;
  zone: { center: THREE.Vector3; size: THREE.Vector3 };
  wallR: number;
}

const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** The ground height at (x, z) — identical to hf_room.py terrain(). */
export function terrainY(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const back = ss(-0.3, 0.7, -z / Math.max(r, 1e-3));
  let y = -ss(17, 38, r) * (5.5 * (1 - back) + 1.2 * back);
  y += back * ss(28, 125, r) * 26;
  y += (1 - back) * ss(55, 160, r) * 16;
  const n = Math.sin(0.11 * x + 0.7) * Math.sin(0.093 * z + 1.3) + 0.55 * Math.sin(0.23 * x - 0.17 * z + 2.1) + 0.3 * Math.sin(0.41 * x + 0.37 * z + 0.4);
  y += n * ss(17, 32, r) * (0.7 + 0.025 * r);
  return y;
}

function post(o: THREE.Object3D, root: THREE.Object3D): Post {
  o.updateWorldMatrix(true, false);
  const pos = root.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion()));
  const ud = (o.userData ?? {}) as Record<string, unknown>;
  return { name: o.name, pos, yaw: Math.atan2(f.x, f.z), role: typeof ud.role === 'string' ? ud.role : 'rifle' };
}

export function frontlineRoomOf(root: THREE.Object3D): FrontlineRoom | null {
  const named = new Map<string, THREE.Object3D>();
  root.traverse((o) => { if (o.name && !named.has(o.name)) named.set(o.name, o); });
  const list = (re: RegExp) => [...named.entries()].filter(([n]) => re.test(n)).sort(([a], [b]) => a.localeCompare(b)).map(([, o]) => post(o, root));
  const defenders = list(/^HF_DEF_\d+$/);
  const spawns = list(/^HF_SPAWN_\d+$/);
  if (!defenders.length || !spawns.length) return null;
  const one = (n: string) => (named.get(n) ? post(named.get(n)!, root) : null);
  const pads: Pad[] = [];
  for (const [n, o] of [...named.entries()].filter(([n]) => /^PAD_\d+$/.test(n)).sort(([a], [b]) => a.localeCompare(b))) {
    const p = post(o, root);
    const b = named.get(n + '_BOARD'), a = named.get(n + '_APPROACH');
    const fwd = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
    pads.push({ index: pads.length, name: n, pos: p.pos, yaw: p.yaw, fwd, board: b ? post(b, root).pos : p.pos.clone().addScaledVector(fwd, -5),
      approach: a ? post(a, root).pos : p.pos.clone().addScaledVector(fwd, -7) });
  }
  const turrets = [...named.entries()].filter(([n]) => /^TURRET_\d+_head$/.test(n)).map(([, o]) => o);
  const bn = named.get('HF_BOARD');
  const zn = named.get('HF_ZONE');
  const zs = (zn?.userData as { size?: number[] } | undefined)?.size;
  const r = defenders.reduce((s, d) => s + Math.hypot(d.pos.x, d.pos.z), 0) / defenders.length;
  return {
    defenders, spawns, sentries: list(/^HF_SENTRY_\d+$/), mech: one('HF_MECH'), supply: one('HF_SUPPLY'), lz: one('HF_LZ'), pads, turrets,
    board: bn ? { node: bn, width: Number((bn.userData as { width?: number }).width) || 1.7 } : null,
    zone: { center: zn ? post(zn, root).pos : new THREE.Vector3(0, 0, -48), size: new THREE.Vector3(...((Array.isArray(zs) && zs.length === 3 ? zs : [150, 30, 70]) as [number, number, number])) },
    wallR: r + 1.0,
  };
}

// ------------------------------------------------------------------------------------------ dropship schedule
/** A dropship leaving its pad at `at` (s since T0; the ramp closes 2 s before) — a replacement lands `SHIP.land` s later. */
export interface ShipEvent { pad: number; at: number; id: string; key?: string }
export const SHIP = { close: 2.0, gone: 12, arrive: 16, land: 26, open: 27.5, busy: 30 } as const;

function h32(...p: (string | number)[]) { let h = 0x811c9dc5; for (const x of p) { const s = String(x); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } h ^= 0x2f; } return h >>> 0; }

/** Ambient supply runs: each pad may leave once per 170 s window (clock only: every page agrees). */
export function ambientDepartures(seed: number, pads: number, t0: number, t1: number): ShipEvent[] {
  const out: ShipEvent[] = [];
  for (let p = 0; p < pads; p++) for (let w = Math.floor((t0 - 200) / 170); w <= Math.floor(t1 / 170); w++) {
    const h = h32(seed, 'ship', p, w);
    if ((h & 1023) / 1023 > 0.55) continue;
    const at = w * 170 + 20 + ((h >>> 10) % 130);
    if (at >= t0 - SHIP.busy - 5 && at <= t1) out.push({ pad: p, at, id: `amb:${p}:${w}` });
  }
  return out;
}

/** Performer departures win; an ambient run within 30 s of another departure on its pad is dropped. */
export function shipEvents(seed: number, pads: number, perf: ShipEvent[], t0: number, t1: number): ShipEvent[] {
  const kept = perf.filter((e) => e.at >= t0 - SHIP.busy - 5 && e.at <= t1 + SHIP.busy);
  for (const a of ambientDepartures(seed, pads, t0 - SHIP.busy, t1 + SHIP.busy).sort((x, y) => x.at - y.at)) {
    if (kept.some((e) => e.pad === a.pad && Math.abs(e.at - a.at) < SHIP.busy + 4)) continue;
    kept.push(a);
  }
  return kept.sort((x, y) => x.at - y.at);
}

/** Is pad p's ship on the pad (standby) for the whole window [a, b]? */
export function padFree(events: ShipEvent[], p: number, a: number, b: number): boolean {
  return !events.some((e) => e.pad === p && e.at - SHIP.close - 1 < b && e.at + SHIP.open > a);
}
