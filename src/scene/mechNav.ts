// Walking machines (profile.body 'mech', src/avatar/mech.ts) in a room: a STATIC ray probe of the room and a clearance
// grid route planner.
//
// StaticRays: the room's own meshes as they were when the room loaded (each mesh's place relative to the room root is
// snapshotted once; the door leaf, which swings, is left out). Every page (studio, OBS, guests) asks the same questions
// of the same geometry whatever the door, a light rig or a stale bounding box did since: where a machine parks
// (src/scene/mechPark.ts) and which way it walks never depend on the page's history (desert_walker SPEC 2.8).
//
// MechGrid: a height map of the room on a fixed 10 cm lattice (vertical probes, cached per room: a cell is furniture
// when something stands on it higher than a step above the walk floor, when the probe starts inside a solid, or when
// there is no floor under it at all), its distance transform, and an A* route that keeps the machine's legs
// `half` metres clear of every piece of furniture (the human nav's COLLIDE boxes don't know the chairs; a desk box
// says nothing about the chairs behind it). Near its two ends it may be as close as it parked. The route is pulled
// tight (never closer than the grid path it shortens, never through a wall at hip height) and handed back as points.
// Pure maths over the probe: the same route on every page.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { RoomInfo } from './contract.ts';

type BVHGeo = THREE.BufferGeometry & { boundsTree?: MeshBVH };
interface Snap { m: THREE.Mesh; local: THREE.Matrix4; lbox: THREE.Box3 }
interface Live { m: THREE.Mesh; world: THREE.Matrix4; inv: THREE.Matrix4; nrm: THREE.Matrix3; box: THREE.Box3; side: THREE.Side }

const _ray = new THREE.Ray();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();

function bvhOf(m: THREE.Mesh): MeshBVH | null {
  const g = m.geometry as BVHGeo;
  if (!g?.attributes?.position) return null;
  if (!g.boundsTree) { try { g.boundsTree = new MeshBVH(g); } catch { return null; } }
  return g.boundsTree ?? null;
}

export class StaticRays {
  private snaps = new Map<THREE.Mesh, Snap>();
  private skip = new Set<THREE.Object3D>();
  private live: Live[] = [];
  private liveKey = '';
  /** Vertical-probe buckets (1 m columns over the live list). */
  private cols = new Map<number, number[]>();

  constructor(readonly room: RoomInfo) {
    room.root.updateWorldMatrix(true, true);
    const door = room.door?.node;
    if (door) door.traverse((o) => { this.skip.add(o); });
    for (const m of room.occluders) this.snap(m);
  }

  private snap(m: THREE.Mesh): Snap | null {
    let s = this.snaps.get(m);
    if (s) return s;
    if (this.skip.has(m)) return null;
    const g = m.geometry as THREE.BufferGeometry;
    if (!g?.attributes?.position) return null;
    m.updateWorldMatrix(true, false);
    const local = this.room.root.matrixWorld.clone().invert().multiply(m.matrixWorld);
    if (!g.boundingBox) g.computeBoundingBox();
    s = { m, local, lbox: g.boundingBox!.clone() };
    this.snaps.set(m, s);
    return s;
  }

  /** The meshes in world space now (the room root may have moved; nothing inside it does). */
  private meshes(): Live[] {
    const R = this.room.root;
    R.updateWorldMatrix(true, false);
    const key = `${this.room.occluders.length}|${R.matrixWorld.elements.join(',')}`;
    if (key === this.liveKey) return this.live;
    this.liveKey = key;
    this.live = [];
    this.cols.clear();
    for (const m of this.room.occluders) {
      const s = this.snap(m);
      if (!s) continue;
      const world = R.matrixWorld.clone().multiply(s.local);
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      this.live.push({ m, world, inv: world.clone().invert(), nrm: new THREE.Matrix3().getNormalMatrix(world), box: s.lbox.clone().applyMatrix4(world), side: mat?.side ?? THREE.FrontSide });
    }
    for (let i = 0; i < this.live.length; i++) {
      const b = this.live[i].box;
      if (b.isEmpty() || b.max.x - b.min.x > 400 || b.max.z - b.min.z > 400) { this.colPush(1e9, i); continue; }
      for (let x = Math.floor(b.min.x); x <= Math.floor(b.max.x); x++) for (let z = Math.floor(b.min.z); z <= Math.floor(b.max.z); z++) this.colPush(colKey(x, z), i);
    }
    return this.live;
  }
  private colPush(k: number, i: number) { let a = this.cols.get(k); if (!a) { a = []; this.cols.set(k, a); } a.push(i); }

  /** RoomRays.hit on the static room: distance from `a` to the first surface towards `b` (Infinity = clear). */
  hit(a: THREE.Vector3, b: THREE.Vector3, skipNear = 0.05): number {
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1e-4) return Infinity;
    dir.divideScalar(len);
    const world = new THREE.Ray(a, dir);
    let best = Infinity;
    for (const L of this.meshes()) {
      const inBox = L.box.containsPoint(a);
      if (!inBox) { if (!world.intersectBox(L.box, _p) || _p.distanceTo(a) > len) continue; }
      const t = bvhOf(L.m);
      if (!t) continue;
      _ray.copy(world).applyMatrix4(L.inv);
      const h = t.raycastFirst(_ray, L.side);
      if (!h) continue;
      const d = _p.copy(h.point).applyMatrix4(L.world).distanceTo(a);
      if (d > skipNear && d < best) best = d;
    }
    return best < len - skipNear ? best : Infinity;
  }

  /** Straight down at (x, z) from yTop to yBot, both faces: the first surface's height, and whether the probe started
   *  inside a solid (that surface faces down: the inside of a wall, a cabinet, a chair back). null = nothing. */
  down(x: number, z: number, yTop: number, yBot: number): { y: number; inside: boolean } | null {
    const live = this.meshes();
    const ids = this.cols.get(colKey(Math.floor(x), Math.floor(z)));
    const big = this.cols.get(1e9);
    if (!ids && !big) return null;
    const len = yTop - yBot;
    if (!(len > 0)) return null;
    let best = Infinity, inside = false;
    const scan = (list: number[] | undefined) => {
      if (!list) return;
      for (const i of list) {
        const L = live[i];
        const b = L.box;
        if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z || b.min.y > yTop || b.max.y < yBot) continue;
        const t = bvhOf(L.m);
        if (!t) continue;
        _ray.origin.set(x, yTop, z); _ray.direction.set(0, -1, 0);
        _ray.applyMatrix4(L.inv);
        const s = _ray.direction.length();
        if (!(s > 0)) continue;
        _ray.direction.divideScalar(s);
        const h = t.raycastFirst(_ray, THREE.DoubleSide);
        if (!h) continue;
        const y = _p.copy(h.point).applyMatrix4(L.world).y;
        const d = yTop - y;
        if (d < -1e-6 || d > len) continue;
        // (this mesh's first surface faces down: the probe started inside it. Asked of every mesh, not only of the
        // nearest surface: a wall standing on the floor shares its bottom with the floor's top. The triangle's own
        // winding normal, in world space by the normal matrix: mirrored parts stay outward)
        const fn = h.face?.normal;
        if (fn && _n.copy(fn).applyMatrix3(L.nrm).y < -1e-3 * _n.length()) inside = true;
        if (d < best) best = d;
      }
    };
    scan(ids); scan(big);
    return best === Infinity ? null : { y: yTop - best, inside };
  }
}

function colKey(x: number, z: number) { return (x + 4096) * 8192 + (z + 4096); }

/** One static probe per loaded room (create it while the room is at rest: SceneRuntime does, right after loading). */
const probes = new WeakMap<RoomInfo, StaticRays>();
export function staticRaysOf(room: RoomInfo): StaticRays {
  let p = probes.get(room);
  if (!p) { p = new StaticRays(room); probes.set(room, p); }
  return p;
}

// ------------------------------------------------------------------------------------------------ grid planner
/** The vertical probe the grid needs (StaticRays, or a test double). */
export interface DownProbe {
  down(x: number, z: number, yTop: number, yBot: number): { y: number; inside: boolean } | null;
  /** Line of sight (Infinity = clear). */
  hit(a: THREE.Vector3, b: THREE.Vector3, skipNear?: number): number;
}

export interface GridOpts {
  /** Cell size (m). */
  cell?: number;
  /** The machine's height above its feet (m): the probes start there. */
  top: number;
  /** A surface up to this far above the walk floor is ground (a stage edge, a rug, a low step). */
  step?: number;
  /** No surface down to this far under the walk floor = no floor (a hole, outside the room). */
  drop?: number;
  /** The room's extent on the floor (cells outside it are taken). */
  bounds: { x0: number; z0: number; x1: number; z1: number };
  /** Points that should stand on floor (the room's spots): no floor under any of them = a room without floor meshes. */
  floorPts?: THREE.Vector3[];
}

export interface GridRoute {
  /** Floor points (y 0), start to end, the start and end exactly as given. */
  pts: THREE.Vector3[];
  /** Least clearance (m) along the route outside the two end zones. */
  minClear: number;
}

/** A binary min-heap of cell indices by key (ties: lower index first, so every page expands the same cells). */
class Heap {
  private ids: number[] = [];
  private ks: number[] = [];
  get size() { return this.ids.length; }
  push(id: number, k: number) {
    const ids = this.ids, ks = this.ks;
    let i = ids.length;
    ids.push(id); ks.push(k);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (ks[p] < k || (ks[p] === k && ids[p] <= id)) break;
      ids[i] = ids[p]; ks[i] = ks[p]; i = p;
    }
    ids[i] = id; ks[i] = k;
  }
  pop(): number {
    const ids = this.ids, ks = this.ks;
    const top = ids[0];
    const id = ids.pop()!, k = ks.pop()!;
    const n = ids.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = k, mid = id;
        if (l < n && (ks[l] < mk || (ks[l] === mk && ids[l] < mid))) { m = l; mk = ks[l]; mid = ids[l]; }
        if (r < n && (ks[r] < mk || (ks[r] === mk && ids[r] < mid))) { m = r; mk = ks[r]; mid = ids[r]; }
        if (m === i) break;
        ids[i] = ids[m]; ks[i] = ks[m]; i = m;
      }
      ids[i] = id; ks[i] = k;
    }
    return top;
  }
}

export class MechGrid {
  readonly cell: number;
  private occ = new Map<number, number>();
  private floored: boolean | null = null;
  /** Vertical probes cast so far (tests, budgets). */
  rays = 0;
  constructor(private probe: DownProbe, private floorAt: ((x: number, z: number) => number) | null, private o: GridOpts) {
    this.cell = o.cell ?? 0.1;
  }

  /** Does the room have floor meshes at all (probed under its own spots: a room without any can't tell a hole from
   *  missing floor, so no floor there is no reason to keep out)? */
  private hasFloor() {
    if (this.floored === null) {
      const top = Math.min(3, this.o.top);
      this.floored = (this.o.floorPts ?? []).some((p) => { const f = this.fl(p.x, p.z); this.rays++; return !!this.probe.down(p.x, p.z, f + top, f - (this.o.drop ?? 0.4)); });
    }
    return this.floored;
  }

  private fl(x: number, z: number) { try { return this.floorAt ? this.floorAt(x, z) : 0; } catch { return 0; } }

  /** Is cell (i, j) taken (furniture, a solid, no floor, outside the room)? Cached: the room doesn't move. */
  blocked(i: number, j: number): boolean {
    const k = (i + 32768) * 65536 + (j + 32768);
    const v = this.occ.get(k);
    if (v !== undefined) return v === 1;
    const c = this.cell, x = (i + 0.5) * c, z = (j + 0.5) * c, b = this.o.bounds;
    let t = 1;
    if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) {
      const f = this.fl(x, z), top = Math.min(3, this.o.top), step = this.o.step ?? 0.2;
      const h = this.probe.down(x, z, f + top, f - (this.o.drop ?? 0.4)); this.rays++;
      t = !h ? (this.hasFloor() ? 1 : 0) : h.inside || h.y - f > step ? 1 : 0;
    }
    if (this.occ.size > 400000) this.occ.clear();
    this.occ.set(k, t);
    return t === 1;
  }

  /** Distance (m) from (x, z) to the nearest taken cell's edge, looked for out to `R` (R when none is closer). */
  clearAt(x: number, z: number, R: number): number {
    const c = this.cell, ci = Math.floor(x / c), cj = Math.floor(z / c), n = Math.ceil(R / c) + 1;
    let best = R;
    for (let dj = -n; dj <= n; dj++) for (let di = -n; di <= n; di++) {
      const cx = (ci + di + 0.5) * c, cz = (cj + dj + 0.5) * c;
      const d = Math.max(0, Math.hypot(cx - x, cz - z) - c / 2);
      if (d >= best) continue;
      if (this.blocked(ci + di, cj + dj)) best = d;
    }
    return best;
  }

  /**
   * A route from a to b (floor points) keeping `half` metres clear of every taken cell, except near the ends (within
   * half + 0.8 m of one): there it may be as close as that end itself is, never closer. null = no such route inside the
   * search window (the ends' box grown by `margin`, at most `maxCells` cells).
   */
  route(a: THREE.Vector3, b: THREE.Vector3, half: number, margin = 3, maxCells = 160000): GridRoute | null {
    const c = this.cell, bd = this.o.bounds;
    const M = Math.max(margin, half + 1.5);
    const i0 = Math.floor((Math.max(bd.x0, Math.min(a.x, b.x) - M)) / c), i1 = Math.floor((Math.min(bd.x1, Math.max(a.x, b.x) + M)) / c);
    const j0 = Math.floor((Math.max(bd.z0, Math.min(a.z, b.z) - M)) / c), j1 = Math.floor((Math.min(bd.z1, Math.max(a.z, b.z) + M)) / c);
    const W = i1 - i0 + 1, H = j1 - j0 + 1;
    if (W < 2 || H < 2 || W * H > maxCells) return null;
    const N = W * H;
    // distance transform (cell units, 8-neighbour chamfer); outside the window: free
    const dt = new Float32Array(N);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) dt[j * W + i] = this.blocked(i0 + i, j0 + j) ? 0 : 1e6;
    const D = Math.SQRT2;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const k = j * W + i;
      let v = dt[k];
      if (v === 0) continue;
      if (i > 0) v = Math.min(v, dt[k - 1] + 1);
      if (j > 0) { v = Math.min(v, dt[k - W] + 1); if (i > 0) v = Math.min(v, dt[k - W - 1] + D); if (i < W - 1) v = Math.min(v, dt[k - W + 1] + D); }
      dt[k] = v;
    }
    for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
      const k = j * W + i;
      let v = dt[k];
      if (v === 0) continue;
      if (i < W - 1) v = Math.min(v, dt[k + 1] + 1);
      if (j < H - 1) { v = Math.min(v, dt[k + W] + 1); if (i < W - 1) v = Math.min(v, dt[k + W + 1] + D); if (i > 0) v = Math.min(v, dt[k + W - 1] + D); }
      dt[k] = v;
    }
    const clr = (k: number) => Math.max(0, dt[k] * c - c / 2);
    const idx = (p: THREE.Vector3) => {
      const i = Math.floor(p.x / c) - i0, j = Math.floor(p.z / c) - j0;
      return i >= 0 && i < W && j >= 0 && j < H ? j * W + i : -1;
    };
    const ka = idx(a), kb = idx(b);
    if (ka < 0 || kb < 0) return null;
    const ca = Math.min(half, clr(ka)), cb = Math.min(half, clr(kb));
    const zone = half + 0.8;
    const centre = (k: number, out: THREE.Vector3) => out.set((i0 + (k % W) + 0.5) * c, 0, (j0 + Math.floor(k / W) + 0.5) * c);
    const q = new THREE.Vector3();
    /** The clearance a cell must have (Infinity = never allowed). */
    const need = (k: number) => {
      centre(k, q);
      let n = half;
      if (Math.hypot(q.x - a.x, q.z - a.z) <= zone) n = Math.min(n, ca - 0.75 * c);
      if (Math.hypot(q.x - b.x, q.z - b.z) <= zone) n = Math.min(n, cb - 0.75 * c);
      return n;
    };
    // (a taken cell never, unless the end itself stands in one: then the cells right around it, to get out)
    const ok = (k: number) => {
      if (dt[k] > 0) return clr(k) >= need(k) - 1e-6;
      if (k === ka || k === kb) return true;
      centre(k, q);
      return (dt[ka] === 0 && Math.hypot(q.x - a.x, q.z - a.z) <= 0.3) || (dt[kb] === 0 && Math.hypot(q.x - b.x, q.z - b.z) <= 0.3);
    };
    // A* (8-connected; a diagonal only between two allowed sides), cost = length x (1 + 1.5 x crowding)
    const soft = half + 0.8;
    const g = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N);
    const hx = (k: number) => Math.hypot((k % W) - (kb % W), Math.floor(k / W) - Math.floor(kb / W)) * c;
    const heap = new Heap();
    g[ka] = 0; heap.push(ka, hx(ka));
    const nb: [number, number, number][] = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, D], [1, -1, D], [-1, 1, D], [-1, -1, D]];
    let found = false;
    while (heap.size) {
      const u = heap.pop();
      if (done[u]) continue;
      if (u === kb) { found = true; break; }
      done[u] = 1;
      const ui = u % W, uj = Math.floor(u / W);
      for (const [di, dj, w] of nb) {
        const vi = ui + di, vj = uj + dj;
        if (vi < 0 || vi >= W || vj < 0 || vj >= H) continue;
        const v = vj * W + vi;
        if (done[v] || !ok(v)) continue;
        if (di && dj && (!ok(uj * W + vi) || !ok(vj * W + ui))) continue;
        const crowd = Math.max(0, 1 - clr(v) / soft);
        const nv = g[u] + w * c * (1 + 1.5 * crowd);
        if (nv < g[v]) { g[v] = nv; prev[v] = u; heap.push(v, nv + hx(v)); }
      }
    }
    if (!found) return null;
    const chain: number[] = [];
    for (let u = kb; u >= 0; u = prev[u]) chain.push(u);
    chain.reverse();
    const raw = chain.map((k, n) => (n === 0 ? new THREE.Vector3(a.x, 0, a.z) : n === chain.length - 1 ? new THREE.Vector3(b.x, 0, b.z) : centre(k, new THREE.Vector3())));
    if (raw.length === 1) raw.push(new THREE.Vector3(b.x, 0, b.z));
    // the clearance each raw point keeps (end points: what they need)
    const rawClr = chain.map((k) => Math.min(clr(k), half + 0.1));
    // pull tight: from each kept point, the farthest raw point reachable in a straight line that is never closer to the
    // furniture than the raw path it replaces (and at least as clear as the cells need), with nothing at hip height
    const hip = Math.max(0.25, Math.min(1.0, 0.45 * this.o.top));
    const p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
    const sight = (A: THREE.Vector3, B: THREE.Vector3) => {
      const fa = this.fl(A.x, A.z), fb = this.fl(B.x, B.z);
      return this.probe.hit(p1.set(A.x, fa + hip, A.z), p2.set(B.x, fb + hip, B.z), 0.02) === Infinity;
    };
    const straight = (s: number, e: number) => {
      if (e === s + 1) return sight(raw[s], raw[e]);
      let req = Infinity;
      for (let n = s; n <= e; n++) req = Math.min(req, rawClr[n]);
      const A = raw[s], B = raw[e], L = A.distanceTo(B), steps = Math.max(1, Math.ceil(L / (0.5 * c)));
      for (let n = 0; n <= steps; n++) {
        q.lerpVectors(A, B, n / steps);
        const k = idx(q);
        if (k < 0) return false;
        const cl = clr(k);
        if (cl < need(k) - 1e-6 || cl < req - 0.5 * c - 1e-6) return false;
      }
      return sight(A, B);
    };
    const pts: THREE.Vector3[] = [raw[0].clone()];
    let s = 0;
    const last = raw.length - 1;
    while (s < last) {
      // (a wall the height map can't see (a single plane) between two neighbouring cells: no route here)
      if (!straight(s, s + 1)) return null;
      // (gallop then bisect for the farthest straight shot)
      let lo = s + 1, step = 1;
      while (lo + step <= last && straight(s, lo + step)) { lo += step; step *= 2; }
      let hi = lo + step;
      if (hi > last) { if (lo < last && straight(s, last)) lo = last; hi = last; }
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (straight(s, m)) lo = m; else hi = m; }
      pts.push(raw[lo].clone());
      s = lo;
    }
    // dense points (a curve through them stays on the straight runs; corners round off over ~0.3 m)
    const out: THREE.Vector3[] = [pts[0].clone()];
    for (let n = 1; n < pts.length; n++) {
      const A = pts[n - 1], B = pts[n], L = A.distanceTo(B), m = Math.max(1, Math.ceil(L / 0.3));
      for (let t = 1; t <= m; t++) out.push(new THREE.Vector3().lerpVectors(A, B, t / m));
    }
    let minClear = Infinity;
    for (const p of out) {
      if (Math.hypot(p.x - a.x, p.z - a.z) <= zone || Math.hypot(p.x - b.x, p.z - b.z) <= zone) continue;
      const k = idx(p);
      if (k >= 0) minClear = Math.min(minClear, clr(k));
    }
    return { pts: out, minClear: minClear === Infinity ? Math.min(ca, cb) : minClear };
  }
}
