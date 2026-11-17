// Where a walking machine (profile.body 'mech', src/avatar/mech.ts) parks at a spot. It never sits: it stands on
// the floor in front of the seat (src/scene/actor.ts updateSeat), and its whole footprint (hull, legs, feet) must be
// clear of the furniture: the couch, the armchairs beside it, their arms, a desk front, a coffee table, a stool.
//
// How: a height map of the floor in front of the seat, in the spot's own frame, from vertical probes (RoomRays: the
// room's own meshes; the first surface below the machine's top, so a shelf over the floor counts and the ceiling does
// not). A cell is taken when something stands on it above ankle height, and when there is no floor under it at all
// within `drop` below the spot's own floor (the edge of a stage, a balcony, a hole: the feet follow lower floors, SPEC M1,
// but never stand on nothing). The machine's rest footprint (its box plus a
// margin) is slid over that map: forward from the old body-length rule (a stand spot: a little either way of the spot)
// and sideways up to `side` metres; the closest clear place wins (the distance from where it would rather stand + 1.5 x
// the sideways shift: straight in front preferred). Cells out of the spot's line of sight at chest height (behind a
// wall) count as taken. Prefix sums make every candidate O(1). Pure maths over a ray probe: every page (studio, OBS,
// guests) gets the same answer from the same room. The actor probes once per spot / scale / room version and caches it.
// (A seat spot or a stand spot alike: a walking machine parks at every spot.)
import * as THREE from 'three';

/** A line-of-sight probe: distance from `a` to the first surface towards `b` (Infinity = clear). twoShot.ts RoomRays. */
export interface ParkRays { hit(a: THREE.Vector3, b: THREE.Vector3, skipNear?: number): number }

/** The machine's rest box in its own frame (room metres, scale applied): x = its left / right, z = forward / back from
 *  its origin, `top` = its height above its feet. */
export interface ParkBox { minX: number; maxX: number; back: number; front: number; top: number }

export interface ParkResult {
  /** Distance (room metres) from the seat spot to the machine's origin, along the spot's facing. */
  z: number;
  /** Sideways shift (room metres, along the spot's own +X). */
  x: number;
  /** The parked footprint was probed clear (false: no clear place within the limits; the least-blocked one). */
  clear: boolean;
  /** Footprint cells over furniture at that place (0 when clear). */
  blocked: number;
  /** Vertical probes cast. */
  rays: number;
}

export interface ParkOpts {
  /** Grid cell (m). */
  cell?: number;
  /** Clearance kept around the footprint (m). */
  margin?: number;
  /** Largest sideways shift (m). */
  side?: number;
  /** A cell counts as furniture above this height (m): rugs, thresholds and floor seams don't. */
  ankle?: number;
  /** The forward distance it would rather park at (default minZ: as close to the seat as it can; a stand spot: 0). */
  prefZ?: number;
  /** A floor down to this far (m) below the spot's floor still carries a foot (a stage edge); deeper = no floor. */
  drop?: number;
}

/**
 * @param pos  the seat spot on its floor (world)
 * @param yaw  the spot's facing (0 = +Z)
 * @param minZ the closest it may park (the old rule)
 * @param maxZ the farthest it may park (it stays at its seat, not in the middle of the room)
 */
export function mechParkDistance(pos: THREE.Vector3, yaw: number, box: ParkBox, rays: ParkRays, minZ: number, maxZ: number, o: ParkOpts = {}): ParkResult {
  const cell = o.cell ?? 0.07, margin = o.margin ?? 0.1, side = Math.max(0, o.side ?? 0.5), ankle = o.ankle ?? 0.04, drop = Math.max(0.05, o.drop ?? 0.4);
  const prefZ = THREE.MathUtils.clamp(o.prefZ ?? minZ, minZ, maxZ);
  const f = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const r = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  const at = (x: number, y: number, z: number, out: THREE.Vector3) => out.copy(pos).addScaledVector(r, x).addScaledVector(f, z).setY(pos.y + y);
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  let n = 0;
  // the probes start at the machine's top, or just under the ceiling when that is lower (the highest of three upward
  // probes over the parking area: one of them may start under a table)
  let ceil = 0;
  for (const z of [minZ, (minZ + maxZ) / 2, maxZ]) {
    at(0, 0.05, z, a); at(0, box.top + 1, z, b);
    const up = rays.hit(a, b, 0.005); n++;
    ceil = Math.max(ceil, up === Infinity ? Infinity : 0.05 + up);
  }
  const yTop = Math.max(0.1, Math.min(box.top + 0.05, ceil - 0.02));
  // (a spot with no floor under it at all (a room without floor meshes): missing floor can't be told from a hole there,
  // so it doesn't count)
  at(0, yTop, 0, a); at(0, -drop, 0, b);
  const floored = rays.hit(a, b, 0.005) !== Infinity; n++;
  // the grid: x over every sideways candidate, z from behind the seat to the farthest front
  const x0 = box.minX - margin - side, x1 = box.maxX + margin + side;
  const z0 = Math.min(minZ - box.back - margin, -0.2), z1 = maxZ + box.front + margin;
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell)), nz = Math.max(1, Math.ceil((z1 - z0) / cell));
  // walls: the height map can't see one (a probe that starts inside a wall passes through it), so every pair of cells is
  // also checked for line of sight from the spot, at chest height (over the furniture): a cell behind a wall is taken
  const yv = Math.max(0.1, Math.min(1.3, yTop - 0.1));
  const vx = Math.ceil(nx / 2), vz = Math.ceil(nz / 2);
  const hidden = new Uint8Array(vx * vz);
  const eye = at(0, yv, 0, new THREE.Vector3());
  for (let j = 0; j < vz; j++) for (let i = 0; i < vx; i++) {
    at(x0 + (2 * i + 1) * cell, yv, z0 + (2 * j + 1) * cell, b);
    if (rays.hit(eye, b, 0.005) !== Infinity) hidden[j * vx + i] = 1;
    n++;
  }
  // prefix sums of taken cells: S[j * (nx + 1) + i] = taken cells in columns [0, i) of rows [0, j)
  const W = nx + 1;
  const S = new Int32Array(W * (nz + 1));
  for (let j = 0; j < nz; j++) {
    let row = 0;
    for (let i = 0; i < nx; i++) {
      const cx = x0 + (i + 0.5) * cell, cz = z0 + (j + 0.5) * cell;
      if (hidden[(j >> 1) * vx + (i >> 1)]) { row++; S[(j + 1) * W + i + 1] = S[j * W + i + 1] + row; continue; }
      // (two probes a cell, on its diagonal a quarter-cell either side of the centre: samples every half cell along
      // both axes, so a panel or a leg thinner than a cell (a desk front, a stool leg) is never missed)
      let t = false;
      for (const q of [-0.25, 0.25]) {
        at(cx + q * cell, yTop, cz + q * cell, a); at(cx + q * cell, -drop, cz + q * cell, b);
        const d = rays.hit(a, b, 0.005); n++;
        if (d === Infinity ? floored : yTop - d > ankle) { t = true; break; }
      }
      if (t) row++;
      S[(j + 1) * W + i + 1] = S[j * W + i + 1] + row;
    }
  }
  const taken = (xa: number, xb: number, za: number, zb: number) => {
    const i0 = Math.max(0, Math.floor((xa - x0) / cell)), i1 = Math.min(nx, Math.ceil((xb - x0) / cell));
    const j0 = Math.max(0, Math.floor((za - z0) / cell)), j1 = Math.min(nz, Math.ceil((zb - z0) / cell));
    if (i1 <= i0 || j1 <= j0) return 0;
    return S[j1 * W + i1] - S[j0 * W + i1] - S[j1 * W + i0] + S[j0 * W + i0];
  };
  // candidates: forward in cell steps from minZ, sideways in cell steps both ways (straight ahead first)
  const shifts: number[] = [0];
  for (let k = 1; k * cell <= side + 1e-9; k++) shifts.push(k * cell, -k * cell);
  type Cand = { z: number; x: number; cost: number; blocked: number };
  const clear: Cand[] = [];
  let least: Cand | null = null;
  // (forward candidates from where it would rather stand, both ways, in cell steps)
  const zs: number[] = [prefZ];
  for (let k = 1; prefZ + k * cell <= maxZ + 1e-9 || prefZ - k * cell >= minZ - 1e-9; k++) {
    if (prefZ + k * cell <= maxZ + 1e-9) zs.push(prefZ + k * cell);
    if (prefZ - k * cell >= minZ - 1e-9) zs.push(prefZ - k * cell);
  }
  for (const z of zs) {
    for (const x of shifts) {
      const cost = Math.abs(z - prefZ) + 1.5 * Math.abs(x);
      const k = taken(x + box.minX - margin, x + box.maxX + margin, z - box.back - margin, z + box.front + margin);
      if (k === 0) clear.push({ z, x, cost, blocked: 0 });
      else if (!least || k < least.blocked || (k === least.blocked && cost < least.cost)) least = { z, x, cost, blocked: k };
    }
  }
  clear.sort((p, q) => p.cost - q.cost || Math.abs(p.x) - Math.abs(q.x) || q.x - p.x || p.z - q.z);
  const best: Cand | null = clear[0] ?? null;
  const w = best ?? least ?? { z: minZ, x: 0, cost: 0, blocked: 0 };
  return { z: w.z, x: w.x, clear: !!best, blocked: w.blocked, rays: n };
}
