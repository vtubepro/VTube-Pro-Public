// The torso's REAL front, back and side surface, measured once from the avatar's mesh when it loads (clothes count: the
// mesh includes them). The "In front" arm pose (src/avatar/armPose.ts) puts the wrists a set distance in front of this surface
// instead of in front of a prism guessed from the skeleton, so a belly, an apron or bulky armour never swallows the hands.
//
// Method: the triangles of the visible meshes whose three vertices are dominated (weight >= 0.5) by the hips / spine / chest /
// upperChest bones (a rigid mesh on one of those bones counts whole), in the bind pose the avatar loads in, are rasterised onto
// an (x, y) grid seen from the front, each cell keeping the nearest and the farthest z of the surface in it (low-poly meshes
// have few vertices and long triangles: a vertex census alone would miss the surface). 24 rows of height from the hips to the
// shoulders; per row the half width, and the front / back z (90th / 10th percentile over the middle of the width, so a stray
// spike never counts). Smoothed over neighbouring rows. Frame: the retargeter's avatar space (+Y up, +Z front, +X left, the
// units of its rest bone positions), relative to the hips bone and the shoulder midline, so it does not care where the model
// stands. ~100k vertices take a few ms; the result is cached per avatar + model signature (a worn costume changes the
// signature), and nothing here runs per frame. Pure geometry: no renderer, runs in node.
import * as THREE from 'three';

export const TORSO_ROLES = new Set(['hips', 'spine', 'chest', 'upperChest']);
export const TORSO_SLICES = 24;
/** lateral bands per row (|x| / half width): 0-25 %, 25-50 %, 50-75 %, 75-100 % */
export const TORSO_BANDS = 4;

export interface TorsoSurface {
  /** slice i covers height y0 + i * dy .. + dy above the hips (avatar-space units) */
  y0: number; dy: number; n: number;
  /** per slice, in avatar-space units: half width (about the shoulder midline), and z of the front and of the back surface,
   *  both relative to the hips bone's z (either can be negative: bones are not always centred in the body) */
  halfW: Float32Array;
  /** [row * bands + band]: z of the front / back surface in each lateral band (see TORSO_BANDS) */
  front: Float32Array; back: Float32Array; bands: number;
  /** slices that had enough surface (the rest were filled in from their neighbours) */
  measured: number;
  /** how thick the forearms are: 90th percentile of the distance of their vertices from the bone line (avatar-space units); 0 = not measured */
  armRadius: number;
  /** torso vertices / triangles used and how long it took (ms), for diagnostics */
  verts: number; tris: number; ms: number;
}

export interface TorsoFrame {
  /** world -> the retargeter's avatar space (Retargeter.worldToAvatar(): the same units and axes its rest bone positions use).
   *  Applied to the meshes' bind-pose vertices (geometry positions x mesh.matrixWorld), so it does not matter what pose the
   *  skeleton is in when the measurement runs. */
  toAv: THREE.Matrix4;
  /** The model root. With it, `toAv` is the world -> avatar matrix multiplied by the root's world matrix AT THE START (so it maps the root's local space),
   *  and each mesh is taken relative to the root's matrixWorld as it is when that mesh is sliced: a wrapper that moves meanwhile (head lean moves the
   *  avatar's position every frame) cannot shift one mesh against another. Without it `toAv` is the plain world -> avatar matrix (a still avatar). */
  root?: THREE.Object3D;
  /** hips and the two upper-arm roots at rest, in avatar space (Retargeter.restAvatar) */
  hips: THREE.Vector3; leftArm: THREE.Vector3; rightArm: THREE.Vector3;
  /** elbows and wrists at rest, avatar space (optional: with them the thickness of the forearms is measured too) */
  leftElbow?: THREE.Vector3; leftWrist?: THREE.Vector3; rightElbow?: THREE.Vector3; rightWrist?: THREE.Vector3;
}

/** This mesh's bind-pose-vertex -> avatar-space matrix, relative to the model root when there is one (see TorsoFrame.root). */
function meshToAv(f: TorsoFrame, mesh: THREE.Object3D): THREE.Matrix4 {
  mesh.updateWorldMatrix(true, false);
  if (!f.root) return new THREE.Matrix4().multiplyMatrices(f.toAv, mesh.matrixWorld);
  f.root.updateWorldMatrix(true, false);
  const rel = new THREE.Matrix4().copy(f.root.matrixWorld).invert().multiply(mesh.matrixWorld);
  return new THREE.Matrix4().multiplyMatrices(f.toAv, rel);
}

/** Value at fraction q (0..1) of `a` (sorted in place). */
function percentile(a: number[], q: number): number {
  a.sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))];
}

/** A cheap signature of the meshes that matter (counts + a sparse sample of positions): same avatar, same model, same clothes. */
export function surfaceSignature(meshes: THREE.Mesh[]): string {
  let h = 2166136261 >>> 0, count = 0;
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    count += pos.count;
    const step = Math.max(1, Math.floor(pos.count / 61));
    for (let i = 0; i < pos.count; i += step) {
      h = Math.imul(h ^ Math.round(pos.getX(i) * 1e4), 16777619) >>> 0;
      h = Math.imul(h ^ Math.round(pos.getY(i) * 1e4), 16777619) >>> 0;
      h = Math.imul(h ^ Math.round(pos.getZ(i) * 1e4), 16777619) >>> 0;
    }
  }
  return `${meshes.length}:${count}:${h.toString(16)}`;
}

/** The measurement run to the end in one go (tests, tools). */
export function measureTorsoSurface(meshes: THREE.Mesh[], role: (bone: THREE.Object3D) => string | undefined, f: TorsoFrame): TorsoSurface | null {
  const t0 = performance.now();
  const g = measureTorsoSurfaceSteps(meshes, role, f);
  let r = g.next();
  while (!r.done) r = g.next();
  if (r.value) r.value.ms = performance.now() - t0;
  return r.value;
}

/** How many triangles / vertices one slice of the measurement handles between two `yield`s (about a millisecond each). */
const SLICE_TRIS = 500, SLICE_VERTS = 1500;

/**
 * Measure the torso, in slices: the generator `yield`s every ~1 ms of work so a caller can give the page back (LazyTorsoSurface
 * below does, a couple of ms a frame). `role` maps a bone object to its humanoid bone name ('hips', 'leftHand' ...). Returns null
 * when there is too little torso mesh to say anything (the pose then keeps using the skeleton's prism).
 */
export function* measureTorsoSurfaceSteps(meshes: THREE.Mesh[], role: (bone: THREE.Object3D) => string | undefined, f: TorsoFrame): Generator<void, TorsoSurface | null, void> {
  const t0 = performance.now();
  const hips = f.hips, L = f.leftArm, R = f.rightArm;
  const shY = Math.min(L.y, R.y), span = Math.abs(L.x - R.x), cx = (L.x + R.x) / 2;
  const Ht = shY - hips.y;
  if (!(Ht > 0.05) || !(span > 0.02)) return null;
  const n = TORSO_SLICES, y1 = Ht * 1.02, dy = y1 / n;
  const maxX = span * 0.9;                    // (arm meshes are skinned to the arm bones, but a loose sleeve can be dominated by the chest)
  const dx = dy * 0.7, nx = Math.ceil((2 * maxX) / dx) + 1;
  const zHi = new Float32Array(n * nx).fill(-Infinity), zLo = new Float32Array(n * nx).fill(Infinity);
  const cellX = (c: number) => -maxX + c * dx;
  const put = (r: number, c: number, z: number) => { if (r < 0 || r >= n || c < 0 || c >= nx) return; const k = r * nx + c; if (z > zHi[k]) zHi[k] = z; if (z < zLo[k]) zLo[k] = z; };
  let verts = 0, tris = 0;
  let px = new Float32Array(0), py = new Float32Array(0), pz = new Float32Array(0), st = new Uint8Array(0);
  for (const mesh of meshes) {
    if (!mesh.visible) continue;
    yield;
    const geo = mesh.geometry, pos = geo.attributes.position;
    const skin = mesh as THREE.SkinnedMesh;
    const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    let torsoBone: boolean[] | null = null;
    if (skin.isSkinnedMesh && si && sw && skin.skeleton) torsoBone = skin.skeleton.bones.map((b) => TORSO_ROLES.has(role(b) ?? ''));
    else {
      // a rigid mesh: carried by the nearest ancestor that is a humanoid bone
      let all = false;
      for (let o: THREE.Object3D | null = mesh.parent; o; o = o.parent) { const r = role(o); if (r) { all = TORSO_ROLES.has(r); break; } }
      if (!all) continue;
    }
    const m = meshToAv(f, mesh), e = m.elements;
    const count = pos.count;
    // scratch arrays, shared by the meshes (a VRoid body can have ~1M vertices: only the ones its triangles use are looked at)
    if (px.length < count) { px = new Float32Array(count); py = new Float32Array(count); pz = new Float32Array(count); st = new Uint8Array(count); }
    st.fill(0, 0, count);
    yield;
    // (raw arrays when the attributes are plain: this loop is the cost of the whole measurement)
    const raw = !(pos as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && pos.itemSize >= 3 && !pos.normalized ? pos.array : null;
    const rawSkin = torsoBone && !(si as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && !(sw as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && si.itemSize === 4 && sw.itemSize === 4;
    const wScale = sw && sw.normalized ? 1 / (sw.array instanceof Uint8Array ? 255 : sw.array instanceof Uint16Array ? 65535 : 1) : 1;
    /** Vertex i: 1 = a torso vertex (its avatar-space position is in px/py/pz), 2 = not. Looked at once. */
    const vert = (i: number): number => {
      if (st[i]) return st[i];
      if (torsoBone) {
        let w = 0;
        if (rawSkin) { const sa = sw.array as ArrayLike<number>, ia = si.array as ArrayLike<number>; for (let k = 0; k < 4; k++) { const ww = sa[i * 4 + k]; if (ww > 0 && torsoBone[ia[i * 4 + k]]) w += ww * wScale; } }
        else for (let k = 0; k < 4; k++) { const ww = sw.getComponent(i, k); if (ww > 0 && torsoBone[si.getComponent(i, k)]) w += ww; }
        if (w < 0.5) return (st[i] = 2);
      }
      const x = raw ? raw[i * pos.itemSize] : pos.getX(i), y = raw ? raw[i * pos.itemSize + 1] : pos.getY(i), z = raw ? raw[i * pos.itemSize + 2] : pos.getZ(i);
      const wv = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
      px[i] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * wv - cx;
      py[i] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * wv - hips.y;
      pz[i] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * wv - hips.z;
      verts++;
      return (st[i] = 1);
    };
    // the triangles, rasterised onto the grid (their corners too: never worse than a vertex census)
    const idx = geo.index, ia = idx ? idx.array : null, triCount = (idx ? idx.count : count) / 3;
    const tStep = Math.max(1, Math.floor(triCount / 12000)); // (a dense mesh has tiny triangles: every n-th is plenty)
    for (let t = 0, k = 0; t < triCount; t += tStep) {
      if (++k % SLICE_TRIS === 0) yield;
      const a = ia ? ia[t * 3] : t * 3, b = ia ? ia[t * 3 + 1] : t * 3 + 1, c = ia ? ia[t * 3 + 2] : t * 3 + 2;
      if (vert(a) !== 1 || vert(b) !== 1 || vert(c) !== 1) continue;
      if (py[a] >= 0 && py[a] < y1 && Math.abs(px[a]) <= maxX) put(Math.floor(py[a] / dy), Math.round((px[a] + maxX) / dx), pz[a]);
      if (py[b] >= 0 && py[b] < y1 && Math.abs(px[b]) <= maxX) put(Math.floor(py[b] / dy), Math.round((px[b] + maxX) / dx), pz[b]);
      if (py[c] >= 0 && py[c] < y1 && Math.abs(px[c]) <= maxX) put(Math.floor(py[c] / dy), Math.round((px[c] + maxX) / dx), pz[c]);
      const ya = py[a], yb = py[b], yc = py[c];
      if (Math.max(ya, yb, yc) < 0 || Math.min(ya, yb, yc) >= y1) continue;
      tris++;
      const xa = px[a], xb = px[b], xc = px[c];
      const r0 = Math.max(0, Math.floor(Math.min(ya, yb, yc) / dy)), r1 = Math.min(n - 1, Math.floor(Math.max(ya, yb, yc) / dy));
      const c0 = Math.max(0, Math.floor((Math.min(xa, xb, xc) + maxX) / dx)), c1 = Math.min(nx - 1, Math.ceil((Math.max(xa, xb, xc) + maxX) / dx));
      if (c1 < c0) continue;
      const den = (yb - yc) * (xa - xc) + (xc - xb) * (ya - yc);
      if (Math.abs(den) < 1e-12) continue;
      for (let r = r0; r <= r1; r++) {
        const y = (r + 0.5) * dy;
        for (let cc = c0; cc <= c1; cc++) {
          const x = -maxX + cc * dx;
          const l1 = ((yb - yc) * (x - xc) + (xc - xb) * (y - yc)) / den, l2 = ((yc - ya) * (x - xc) + (xa - xc) * (y - yc)) / den, l3 = 1 - l1 - l2;
          if (l1 < -0.02 || l2 < -0.02 || l3 < -0.02) continue;
          put(r, cc, l1 * pz[a] + l2 * pz[b] + l3 * pz[c]);
        }
      }
    }
  }
  if (verts < 200) return null;
  yield;
  const NB = TORSO_BANDS;
  const halfW = new Float32Array(n), front = new Float32Array(n * NB), back = new Float32Array(n * NB), ok = new Uint8Array(n);
  let measured = 0;
  for (let r = 0; r < n; r++) {
    let hw = 0, cells = 0;
    for (let c = 0; c < nx; c++) if (zHi[r * nx + c] > -Infinity) { hw = Math.max(hw, Math.abs(cellX(c))); cells++; }
    if (cells < 4 || hw < 0.02) continue;
    // per lateral band (|x| / half width): the front and back z (the chest is flatter than an ellipse, a barrel belly boxier)
    const hi: number[][] = Array.from({ length: NB }, () => []), lo: number[][] = Array.from({ length: NB }, () => []);
    for (let c = 0; c < nx; c++) {
      const k = r * nx + c;
      if (!(zHi[k] > -Infinity)) continue;
      const bnd = Math.min(NB - 1, Math.floor((Math.abs(cellX(c)) / hw) * NB * 0.9999 / 1));
      hi[bnd].push(zHi[k]); lo[bnd].push(zLo[k]);
    }
    if (hi[0].length < 2) continue;
    halfW[r] = hw;
    for (let k = 0; k < NB; k++) {
      // an empty outer band takes the next one in (the side of the body has nothing to say about the front)
      let src = k; while (src > 0 && hi[src].length < 2) src--;
      front[r * NB + k] = percentile(hi[src], 0.9); back[r * NB + k] = percentile(lo[src], 0.1);
    }
    ok[r] = 1; measured++;
  }
  if (measured < n / 2) return null;
  // fill the gaps from the nearest measured rows, then smooth over three rows
  for (let s = 0; s < n; s++) {
    if (ok[s]) continue;
    let a = s - 1, b = s + 1;
    while (a >= 0 && !ok[a]) a--;
    while (b < n && !ok[b]) b++;
    const src = a >= 0 && (b >= n || s - a <= b - s) ? a : b;
    halfW[s] = halfW[src];
    for (let k = 0; k < NB; k++) { front[s * NB + k] = front[src * NB + k]; back[s * NB + k] = back[src * NB + k]; }
  }
  const sm = (arr: Float32Array, w: number) => { const c = arr.slice(); for (let s = 0; s < n; s++) for (let k = 0; k < w; k++) arr[s * w + k] = (c[Math.max(0, s - 1) * w + k] + c[s * w + k] * 2 + c[Math.min(n - 1, s + 1) * w + k]) / 4; };
  sm(halfW, 1); sm(front, NB); sm(back, NB);
  return { y0: 0, dy, n, halfW, front, back, bands: NB, measured, armRadius: yield* measureArmRadius(meshes, role, f), verts, tris, ms: performance.now() - t0 };
}

const ARM_ROLE = /LowerArm$/;
/** Thickness of the forearms from a sample of the mesh: the vertices they dominate, their distance from the elbow-wrist line. */
function* measureArmRadius(meshes: THREE.Mesh[], role: (bone: THREE.Object3D) => string | undefined, f: TorsoFrame): Generator<void, number, void> {
  if (!f.leftElbow || !f.leftWrist || !f.rightElbow || !f.rightWrist) return 0;
  const seg = [f.leftElbow, f.leftWrist, f.rightElbow, f.rightWrist];
  const ends: [THREE.Vector3, THREE.Vector3][] = [[seg[0], seg[1]], [seg[2], seg[3]]];
  const dist: number[] = [], v = new THREE.Vector3(), ab = new THREE.Vector3(), ap = new THREE.Vector3();
  for (const mesh of meshes) {
    const skin = mesh as THREE.SkinnedMesh;
    const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
    if (!mesh.visible || !skin.isSkinnedMesh || !si || !sw || !skin.skeleton) continue;
    const side = skin.skeleton.bones.map((b) => { const r = role(b) ?? ''; return ARM_ROLE.test(r) ? (r.startsWith('left') ? 1 : 2) : 0; });
    if (!side.some((x) => x)) continue;
    const m = meshToAv(f, mesh), pos = mesh.geometry.attributes.position;
    const stride = Math.max(1, Math.floor(pos.count / 8000));
    for (let i = 0, k = 0; i < pos.count; i += stride) {
      if (++k % SLICE_VERTS === 0) yield;
      let w1 = 0, w2 = 0;
      for (let k = 0; k < 4; k++) { const ww = sw.getComponent(i, k); if (ww > 0) { const sd = side[si.getComponent(i, k)]; if (sd === 1) w1 += ww; else if (sd === 2) w2 += ww; } }
      const e = w1 >= 0.5 ? ends[0] : w2 >= 0.5 ? ends[1] : null;
      if (!e) continue;
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
      ab.subVectors(e[1], e[0]); ap.subVectors(v, e[0]);
      const t = Math.max(0, Math.min(1, ap.dot(ab) / Math.max(ab.lengthSq(), 1e-12)));
      dist.push(ap.sub(ab.multiplyScalar(t)).length());
    }
  }
  return dist.length >= 50 ? percentile(dist, 0.9) : 0;
}

/**
 * The surface at a height above the hips (linear between slice centres, held at the ends) and a sideways offset `x` from the
 * middle (the front / back z there: linear between the band centres, easing back to the middle at the edge of the body).
 * `x` omitted: the middle of the chest.
 */
export function surfaceAt(s: TorsoSurface, y: number, x = 0): { halfW: number; front: number; back: number } {
  const u = (y - s.y0) / s.dy - 0.5, i = Math.max(0, Math.min(s.n - 1, Math.floor(u))), j = Math.min(s.n - 1, i + 1);
  const t = Math.max(0, Math.min(1, u - i)), NB = s.bands;
  const halfW = s.halfW[i] + (s.halfW[j] - s.halfW[i]) * t;
  const band = (a: Float32Array, k: number) => a[i * NB + k] + (a[j * NB + k] - a[i * NB + k]) * t;
  const q = Math.min(1.2, Math.abs(x) / Math.max(halfW, 1e-6));
  // band k covers q in [k / NB, (k + 1) / NB): its centre is (k + 0.5) / NB
  const pos = Math.max(0, Math.min(NB - 1, q * NB - 0.5)), k0 = Math.floor(pos), k1 = Math.min(NB - 1, k0 + 1), f = pos - k0;
  let front = band(s.front, k0) + (band(s.front, k1) - band(s.front, k0)) * f, back = band(s.back, k0) + (band(s.back, k1) - band(s.back, k0)) * f;
  if (q > (NB - 0.5) / NB) { // past the last band centre: the surface turns the corner toward the middle between front and back
    const e = Math.min(1, (q - (NB - 0.5) / NB) / (1 - (NB - 0.5) / NB + 0.2)), mid = (front + back) / 2;
    front += (mid - front) * e * e; back += (mid - back) * e * e;
  }
  return { halfW, front, back };
}

const cache = new Map<string, TorsoSurface | null>();
/** Measure once per avatar + model signature. `id` is the avatar's id. */
export function torsoSurfaceCached(id: string, meshes: THREE.Mesh[], role: (bone: THREE.Object3D) => string | undefined, f: TorsoFrame): TorsoSurface | null {
  const key = `${id}|${surfaceSignature(meshes)}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  if (cache.size > 24) cache.clear();
  const s = measureTorsoSurface(meshes, role, f);
  cache.set(key, s);
  return s;
}

/** A measurement in progress (or already finished: a cache hit). */
export interface TorsoJob {
  /** the result once `step` has returned true (null = no usable torso mesh) */
  surface: TorsoSurface | null;
  /** Work for about `budgetMs`; true when finished. Cheap when already finished. */
  step(budgetMs: number): boolean;
}

/** The measurement as a job to be advanced a few ms at a time; a cache hit is finished at once. Same cache as torsoSurfaceCached. */
export function torsoSurfaceJob(id: string, meshes: THREE.Mesh[], role: (bone: THREE.Object3D) => string | undefined, f: TorsoFrame): TorsoJob {
  const key = `${id}|${surfaceSignature(meshes)}`;
  if (cache.has(key)) { const s = cache.get(key) ?? null; return { surface: s, step: () => true }; }
  const gen = measureTorsoSurfaceSteps(meshes, role, f);
  let busy = 0;
  const job: TorsoJob = {
    surface: null,
    step(budgetMs) {
      const t0 = performance.now();
      for (;;) {
        const r = gen.next();
        if (r.done) {
          busy += performance.now() - t0;
          job.surface = r.value;
          if (r.value) r.value.ms = busy;
          if (cache.size > 24) cache.clear();
          cache.set(key, r.value);
          job.step = () => true;
          return true;
        }
        if (performance.now() - t0 >= budgetMs) { busy += performance.now() - t0; return false; }
      }
    },
  };
  return job;
}

/**
 * The torso measurement for one avatar, started only when it is wanted (the "In front" arm pose chosen or loaded) and then
 * advanced a couple of ms per frame: an avatar that follows the performer's arms (the default), a guest, a sidekick never
 * measure anything, and nobody's frame waits for the measurement. `start` is called at most once.
 */
export class LazyTorsoSurface {
  private job: TorsoJob | null = null;
  /** `start` calls so far (0 or 1) */
  started = 0;
  done = false;
  surface: TorsoSurface | null = null;
  constructor(private readonly start: () => TorsoJob) {}
  /** Call every frame. Does nothing unless `wanted`. true on the frame the measurement finished (`surface` is then set; may be null). */
  tick(wanted: boolean, budgetMs = 2): boolean {
    if (this.done || !wanted) return false;
    if (!this.job) { this.started++; this.job = this.start(); }
    if (!this.job.step(budgetMs)) return false;
    this.done = true; this.surface = this.job.surface; this.job = null;
    return true;
  }
}
