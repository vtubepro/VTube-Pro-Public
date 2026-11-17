// Floor navigation for entrances / exits / spot changes (src/scene/walkMover.ts).
//
// 2D on the floor plane (x, z). The room's authored routing is the backbone: DOOR_OUTSIDE → the doorway →
// PATH_01… (in order) and, per spot, PATH_[leavePathAt | nearest] → its `approach` points → the spot's
// "stand point" (sit spots: just in front of the seat, where the avatar turns and sits down backwards).
// Neighbouring stand points are linked directly when the straight line is clear. Every leg of a route is
// checked against the COLLIDE_* boxes (inflated by the walker's radius) and detoured around them with a
// small visibility-graph A*. The result is smoothed into a centripetal Catmull-Rom curve and baked into an
// arc-length table, so every page (studio preview, OBS, guests' OBS) gets the SAME path from the same room.
import * as THREE from 'three';
import type { RoomInfo, SpotInfo } from './contract.ts';

/** A COLLIDE_* box on the floor: centre, unit axes (x / z), half extents. */
export interface FloorBox { name: string; cx: number; cz: number; ux: number; uz: number; vx: number; vz: number; hx: number; hz: number }

interface NavNode { p: THREE.Vector3; edges: Map<number, number> }

const flat = (v: THREE.Vector3) => new THREE.Vector3(v.x, 0, v.z);

/** Baked walk path: points with cumulative arc length. */
export class WalkPath {
  readonly pts: THREE.Vector3[];
  readonly cum: number[];
  readonly length: number;
  constructor(points: THREE.Vector3[]) {
    const pts: THREE.Vector3[] = [];
    if (points.length >= 3) {
      const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
      let rough = 0;
      for (let i = 1; i < points.length; i++) rough += points[i].distanceTo(points[i - 1]);
      const n = Math.max(8, Math.ceil(rough / 0.03));
      for (let i = 0; i <= n; i++) pts.push(curve.getPoint(i / n).setY(0));
    } else pts.push(...points.map((p) => p.clone().setY(0)));
    if (pts.length === 1) pts.push(pts[0].clone());
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    this.pts = pts; this.cum = cum; this.length = cum[cum.length - 1];
  }

  /** Point at arc length s (clamped). */
  at(s: number, out = new THREE.Vector3()): THREE.Vector3 {
    const { cum, pts } = this;
    if (s <= 0) return out.copy(pts[0]);
    if (s >= this.length) return out.copy(pts[pts.length - 1]);
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const seg = cum[hi] - cum[lo];
    return out.lerpVectors(pts[lo], pts[hi], seg > 1e-9 ? (s - cum[lo]) / seg : 0);
  }

  /** Facing yaw (0 = +Z) along the path at s: looks a little ahead so corners are anticipated. */
  heading(s: number): number {
    const a = this.at(Math.max(0, Math.min(s, this.length - 0.3) - 0.05)), b = this.at(Math.min(this.length, s + 0.3));
    const dx = b.x - a.x, dz = b.z - a.z;
    if (dx * dx + dz * dz < 1e-8) {
      const n = this.pts.length;
      const p = this.pts[Math.max(0, n - 2)], q = this.pts[n - 1];
      return Math.atan2(q.x - p.x, q.z - p.z);
    }
    return Math.atan2(dx, dz);
  }

  /** Arc length where the path passes closest to a point. */
  closest(p: THREE.Vector3): number {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.pts.length; i++) { const d = (this.pts[i].x - p.x) ** 2 + (this.pts[i].z - p.z) ** 2; if (d < bd) { bd = d; best = i; } }
    return this.cum[best];
  }
}

export class RoomNav {
  readonly boxes: FloorBox[];
  readonly doorOutside: THREE.Vector3 | null;
  /** Middle of the door opening (closed leaf), on the floor. */
  readonly doorway: THREE.Vector3 | null;
  private nodes: NavNode[] = [];
  private iOut = -1;
  private iDoor = -1;
  private stand = new Map<number, number>();   // spot index → node
  private standPts = new Map<number, THREE.Vector3>();

  /** `radius` = walker radius (m) the boxes are inflated by. */
  constructor(readonly room: RoomInfo, readonly radius = 0.2) {
    this.boxes = floorBoxes(room);
    this.doorOutside = room.doorOutside ? flat(room.doorOutside.position) : null;
    let doorway: THREE.Vector3 | null = null;
    if (room.door) {
      const b = new THREE.Box3().setFromObject(room.door.node);
      if (!b.isEmpty()) doorway = flat(b.getCenter(new THREE.Vector3()));
    }
    this.doorway = doorway;
    this.build();
  }

  /** Where a walker stops in front of a spot (sit: in front of the seat; stand: the spot itself). */
  standPoint(s: SpotInfo): THREE.Vector3 { return this.standPts.get(s.index)?.clone() ?? flat(s.position); }

  private add(p: THREE.Vector3) { this.nodes.push({ p: flat(p), edges: new Map() }); return this.nodes.length - 1; }
  private link(a: number, b: number) {
    if (a < 0 || b < 0 || a === b) return;
    const d = this.nodes[a].p.distanceTo(this.nodes[b].p);
    this.nodes[a].edges.set(b, d); this.nodes[b].edges.set(a, d);
  }

  private build() {
    const room = this.room;
    if (this.doorOutside) this.iOut = this.add(this.doorOutside);
    if (this.doorway) { this.iDoor = this.add(this.doorway); this.link(this.iOut, this.iDoor); }
    const pathIdx = room.path.map((p) => this.add(p));
    for (let i = 1; i < pathIdx.length; i++) this.link(pathIdx[i - 1], pathIdx[i]);
    const entry = this.iDoor >= 0 ? this.iDoor : this.iOut;
    if (pathIdx.length) this.link(entry, pathIdx[0]);
    for (const s of room.spots) {
      if (!s) continue;
      const sp = this.findStandPoint(s);
      this.standPts.set(s.index, sp);
      const chain = [...s.approach.map((p) => this.add(p)), this.add(sp)];
      this.stand.set(s.index, chain[chain.length - 1]);
      for (let i = 1; i < chain.length; i++) this.link(chain[i - 1], chain[i]);
      const first = this.nodes[chain[0]].p;
      let leave = s.leavePathAt ?? -1;
      if (leave < 0 && room.path.length) {
        let bd = Infinity;
        room.path.forEach((w, i) => { const d = w.distanceToSquared(first); if (d < bd) { bd = d; leave = i; } });
      }
      if (leave >= 0 && pathIdx[leave] !== undefined) this.link(pathIdx[leave], chain[0]);
      else if (entry >= 0) this.link(entry, chain[0]);
    }
    // coincident nodes (shared approach points) are the same place
    for (let a = 0; a < this.nodes.length; a++) for (let b = a + 1; b < this.nodes.length; b++)
      if (this.nodes[a].p.distanceTo(this.nodes[b].p) < 0.25) this.link(a, b);
    // neighbouring seats: walk straight across when nothing is in the way
    const st = [...this.stand.values()];
    for (let i = 0; i < st.length; i++) for (let j = i + 1; j < st.length; j++) {
      const a = this.nodes[st[i]].p, b = this.nodes[st[j]].p;
      if (a.distanceTo(b) < 2.4 && this.clear(a, b)) this.link(st[i], st[j]);
    }
  }

  private findStandPoint(s: SpotInfo): THREE.Vector3 {
    const p = flat(s.position);
    if (s.pose !== 'sit') return p;
    for (let d = 0.36; d <= 0.95; d += 0.04) {
      const q = p.clone().addScaledVector(s.forward, d);
      if (!this.boxes.some((b) => inside(b, q.x, q.z, 0.1))) return q;
    }
    return p.clone().addScaledVector(s.forward, 0.45);
  }

  // ---------------------------------------------------------------- queries
  /** Route polyline door → spot (outside first). */
  fromDoor(s: SpotInfo): THREE.Vector3[] { return this.route(this.iOut >= 0 ? this.iOut : this.iDoor, this.stand.get(s.index)!); }
  toDoor(s: SpotInfo): THREE.Vector3[] { return this.route(this.stand.get(s.index)!, this.iOut >= 0 ? this.iOut : this.iDoor); }
  between(a: SpotInfo, b: SpotInfo): THREE.Vector3[] { return this.route(this.stand.get(a.index)!, this.stand.get(b.index)!); }
  /** From an arbitrary floor point (an interrupted walk) to a spot / the door. */
  fromPoint(p: THREE.Vector3, outside: boolean, to: SpotInfo | null): THREE.Vector3[] {
    const target = to ? this.stand.get(to.index)! : (this.iOut >= 0 ? this.iOut : this.iDoor);
    if (target === undefined || target < 0) return [flat(p)];
    const tmp = this.add(p);
    const cand = outside ? [this.iOut, this.iDoor].filter((i) => i >= 0) : this.nodes.map((_, i) => i).filter((i) => i !== tmp && i !== this.iOut);
    for (const i of cand) { const q = this.nodes[i].p; if (q.distanceTo(this.nodes[tmp].p) < 3.5 && (outside || this.clear(this.nodes[tmp].p, q))) this.link(tmp, i); }
    if (!this.nodes[tmp].edges.size) {
      // nothing visible: join the nearest node anyway (detoured around boxes below)
      let best = -1, bd = Infinity;
      for (const i of cand) { const d = this.nodes[i].p.distanceTo(this.nodes[tmp].p); if (d < bd) { bd = d; best = i; } }
      this.link(tmp, best);
    }
    const r = this.route(tmp, target);
    for (const [i] of this.nodes[tmp].edges) this.nodes[i].edges.delete(tmp);
    this.nodes.pop();
    return r;
  }

  /**
   * A floor point to a floor point (null = the door: outside it when there is an outside point). Each end joins every
   * graph node it can see (clear of the boxes, < 3.5 m; else the nearest), the two ends each other when clear, then the
   * graph as usual. For walkers that don't stop at the spots' own stand points (walking machines park clear of the
   * furniture: a seat's approach chain leads behind the desk, to the chair), so the route never cuts through a desk or a
   * couch to reach the real end point. `outsideA`: the start is outside the door (joins the door nodes only). `joinR`:
   * the clearance the two ends join the graph with (a wide walker on a graph inflated for its width still leaves its
   * parking place, which is closer than that to the furniture behind it, by a human's clearance).
   */
  pointRoute(a: THREE.Vector3 | null, b: THREE.Vector3 | null, outsideA = false, joinR = this.radius): THREE.Vector3[] {
    const door = this.iOut >= 0 ? this.iOut : this.iDoor;
    const temps: number[] = [];
    const join = (p: THREE.Vector3, outside: boolean) => {
      const t = this.add(p);
      temps.push(t);
      const cand = outside ? [this.iOut, this.iDoor].filter((i) => i >= 0) : this.nodes.map((_, i) => i).filter((i) => i !== t && i !== this.iOut);
      for (const i of cand) { const q = this.nodes[i].p; if (q.distanceTo(this.nodes[t].p) < 3.5 && (outside || this.clear(this.nodes[t].p, q, joinR))) this.link(t, i); }
      if (!this.nodes[t].edges.size) {
        let best = -1, bd = Infinity;
        for (const i of cand) { const d = this.nodes[i].p.distanceTo(this.nodes[t].p); if (d < bd) { bd = d; best = i; } }
        this.link(t, best);
      }
      return t;
    };
    try {
      const ia = a ? join(a, outsideA) : door;
      const ib = b ? join(b, false) : door;
      if (ia === undefined || ib === undefined || ia < 0 || ib < 0) return a && b ? [flat(a), flat(b)] : [];
      return this.route(ia, ib);
    } finally {
      for (let k = temps.length - 1; k >= 0; k--) {
        const t = temps[k];
        for (const [i] of this.nodes[t].edges) this.nodes[i].edges.delete(t);
        this.nodes.splice(t, 1);
      }
    }
  }

  /** Dijkstra over the nav graph, then every leg detoured around the collision boxes. */
  private route(a: number, b: number): THREE.Vector3[] {
    if (a === undefined || b === undefined || a < 0 || b < 0) return [];
    const n = this.nodes.length;
    const dist = new Array<number>(n).fill(Infinity), prev = new Array<number>(n).fill(-1), done = new Array<boolean>(n).fill(false);
    dist[a] = 0;
    for (;;) {
      let u = -1, bd = Infinity;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < bd) { bd = dist[i]; u = i; }
      if (u < 0 || u === b) break;
      done[u] = true;
      for (const [v, w] of this.nodes[u].edges) if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; }
    }
    const chain: THREE.Vector3[] = [];
    if (dist[b] === Infinity) chain.push(this.nodes[a].p.clone(), this.nodes[b].p.clone());
    else for (let u = b; u >= 0; u = prev[u]) chain.unshift(this.nodes[u].p.clone());
    const out: THREE.Vector3[] = [chain[0]];
    for (let i = 1; i < chain.length; i++) out.push(...this.detour(chain[i - 1], chain[i]).slice(1));
    // drop near-duplicates (they kink the spline)
    const clean: THREE.Vector3[] = [];
    for (const p of out) if (!clean.length || clean[clean.length - 1].distanceTo(p) > 0.08) clean.push(p);
    if (clean.length > 1 && clean[clean.length - 1].distanceTo(out[out.length - 1]) > 1e-6) clean[clean.length - 1] = out[out.length - 1];
    return clean;
  }

  /** Is the straight floor segment a→b clear of every (inflated) box that contains neither end? */
  clear(a: THREE.Vector3, b: THREE.Vector3, r = this.radius): boolean {
    for (const bx of this.boxes) {
      if (inside(bx, a.x, a.z, r) || inside(bx, b.x, b.z, r)) continue;
      if (segHits(bx, a.x, a.z, b.x, b.z, r)) return false;
    }
    return true;
  }

  /** a→b, or around the boxes in the way (A* over the inflated box corners). */
  private detour(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3[] {
    if (this.clear(a, b)) return [a, b];
    const r = this.radius, m = r + 0.08;
    const pts: THREE.Vector3[] = [a, b];
    for (const bx of this.boxes) for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const lx = sx * (bx.hx + m), lz = sz * (bx.hz + m);
      const p = new THREE.Vector3(bx.cx + bx.ux * lx + bx.vx * lz, 0, bx.cz + bx.uz * lx + bx.vz * lz);
      if (!this.boxes.some((o) => inside(o, p.x, p.z, r))) pts.push(p);
    }
    const n = pts.length;
    const g = new Array<number>(n).fill(Infinity), prev = new Array<number>(n).fill(-1), closed = new Array<boolean>(n).fill(false);
    g[0] = 0;
    for (;;) {
      let u = -1, bf = Infinity;
      for (let i = 0; i < n; i++) if (!closed[i] && g[i] < Infinity) { const f = g[i] + pts[i].distanceTo(b); if (f < bf) { bf = f; u = i; } }
      if (u < 0 || u === 1) break;
      closed[u] = true;
      for (let v = 0; v < n; v++) {
        if (closed[v] || v === u) continue;
        const w = pts[u].distanceTo(pts[v]);
        if (g[u] + w < g[v] && this.clear(pts[u], pts[v])) { g[v] = g[u] + w; prev[v] = u; }
      }
    }
    if (g[1] === Infinity) return [a, b];
    const out: THREE.Vector3[] = [];
    for (let u = 1; u >= 0; u = prev[u]) out.unshift(pts[u].clone());
    return out;
  }
}

// ---------------------------------------------------------------- boxes
function floorBoxes(room: RoomInfo): FloorBox[] {
  const out: FloorBox[] = [];
  const corner = new THREE.Vector3();
  for (const c of room.colliders) {
    c.updateWorldMatrix(true, true);
    const e = c.matrixWorld.elements;
    let ux = e[0], uz = e[2], vx = e[8], vz = e[10];
    const lu = Math.hypot(ux, uz) || 1, lv = Math.hypot(vx, vz) || 1;
    ux /= lu; uz /= lu; vx /= lv; vz /= lv;
    const cx = e[12], cz = e[14];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
    c.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox!;
      for (let i = 0; i < 8; i++) {
        corner.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(m.matrixWorld);
        const dx = corner.x - cx, dz = corner.z - cz;
        const lx = dx * ux + dz * uz, lz = dx * vx + dz * vz;
        minX = Math.min(minX, lx); maxX = Math.max(maxX, lx); minZ = Math.min(minZ, lz); maxZ = Math.max(maxZ, lz);
        minY = Math.min(minY, corner.y); maxY = Math.max(maxY, corner.y);
      }
    });
    if (!Number.isFinite(minX)) continue;
    // only what stands on the floor (a wall-mounted tank at head height doesn't block the feet)
    if (minY > 0.9 || maxY < 0.05) continue;
    const mx = (minX + maxX) / 2, mz = (minZ + maxZ) / 2;
    out.push({ name: c.name, cx: cx + ux * mx + vx * mz, cz: cz + uz * mx + vz * mz, ux, uz, vx, vz, hx: (maxX - minX) / 2, hz: (maxZ - minZ) / 2 });
  }
  return out;
}

function inside(b: FloorBox, x: number, z: number, r: number) {
  const dx = x - b.cx, dz = z - b.cz;
  return Math.abs(dx * b.ux + dz * b.uz) < b.hx + r && Math.abs(dx * b.vx + dz * b.vz) < b.hz + r;
}

/** Liang–Barsky: does segment (ax,az)→(bx,bz) cross the box inflated by r? */
function segHits(b: FloorBox, ax: number, az: number, bx: number, bz: number, r: number) {
  const x0 = (ax - b.cx) * b.ux + (az - b.cz) * b.uz, z0 = (ax - b.cx) * b.vx + (az - b.cz) * b.vz;
  const x1 = (bx - b.cx) * b.ux + (bz - b.cz) * b.uz, z1 = (bx - b.cx) * b.vx + (bz - b.cz) * b.vz;
  const dx = x1 - x0, dz = z1 - z0, hx = b.hx + r, hz = b.hz + r;
  let t0 = 0, t1 = 1;
  const clip = (p: number, q: number) => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, x0 + hx) && clip(dx, hx - x0) && clip(-dz, z0 + hz) && clip(dz, hz - z0) && t0 < t1;
}
