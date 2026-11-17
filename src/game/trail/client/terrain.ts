// The Trail v2 — the journey's world on screen: the seeded terrain streamed in 64 m chunks around the camera (5 × 5,
// two LODs, built in a worker), painted with trailart's per-biome layers (terrain/terrain.json: ground / grass / mud /
// rock / shore + a detail texture; flat biome colours when the pack has none), the road as a textured ribbon with
// verges, creek water, instanced scatter (trailart's SCENERY_* kit pieces by role + biome, procedural stand-ins
// otherwise), fork signposts, route-node beacons, old graves at their mile, the cloud sea under Skyisles's islands.
// Coordinates: children live at WORLD metres under `root`, and root sits at −origin (the sim's floating origin), so
// the view's local space = the physics space.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CHUNK, heightAt, pathPoint, planJourney, roadInfo, type PlanIn, type WorldPlan } from '../../../../shared/trail/procgen.ts';
import type { Grave } from '../../../../shared/trail/types.ts';
import { ROLES, type ChunkMesh, type Strip } from './terrainMesh.ts';
import { loadThemeGlb, themeFileUrl } from './assets.ts';
import { labelSprite, toon, toonRamp } from './kit.ts';
import { buildTombstone } from './art.ts';

type Layer = 'ground' | 'grass' | 'mud' | 'rock' | 'shore';
interface BiomeTex { layers: Partial<Record<Layer, { file: string; tileM: number }>>; road?: { file: string; tileM: number }; verge?: { file: string; tileM: number }; detail?: string }
interface Piece { id: string; geo: THREE.BufferGeometry; mat: THREE.Material; biomes: string[]; sMin: number; sMax: number; role: string }
interface Live { key: string; cx: number; cz: number; step: number; group: THREE.Group; scatter: Float32Array; biome: number; grid?: Float32Array }

const RING = 2;
const texLoader = new THREE.TextureLoader();

export class JourneyTerrain {
  readonly root = new THREE.Group();
  readonly plan: WorldPlan;
  origin: [number, number] = [0, 0];
  private worker: Worker;
  private live = new Map<string, Live>();
  private pending = new Map<string, number>();
  private arrived: ChunkMesh[] = [];
  private req = 0;
  private terrainMats: THREE.Material[] = [];
  private roadMats: THREE.Material[] = [];
  private vergeMats: THREE.Material[] = [];
  private waterMat: THREE.ShaderMaterial;
  private cloud: THREE.Mesh | null = null;
  private pieces = new Map<string, Piece[]>();
  private inst = new Map<Piece, THREE.InstancedMesh>();
  private scatterDirty = true;
  private uOrigin = { value: new THREE.Vector2() };
  private graves = new Map<string, THREE.Object3D>();
  private disposed = false;
  /** Worker generation time (ms) of the last chunks, for the perf overlay / tests. */
  genMs = 0;
  time = 0;

  constructor(readonly theme: string, opts: PlanIn) {
    this.plan = planJourney(opts);
    this.worker = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module', name: 'trail-terrain' });
    this.worker.onmessage = (e: MessageEvent<{ t: 'chunk'; mesh: ChunkMesh; ms: number }>) => { if (!this.disposed && e.data.t === 'chunk') { this.arrived.push(e.data.mesh); this.genMs = this.genMs * 0.8 + e.data.ms * 0.2; } };
    this.worker.postMessage({ t: 'plan', opts });
    this.waterMat = waterMaterial(this.plan.biomes[0]?.colors.water ?? '#3f6b3a', this.theme === 'skyisles');
    this.root.name = 'journey-terrain';
    // materials per biome: flat colours at once, painted layers when the pack's terrain.json arrives
    this.plan.biomes.forEach((b, i) => {
      const flat = (c: string) => colorTex(c);
      const layers: Record<Layer, THREE.Texture> = { ground: flat(b.colors.ground), grass: flat(b.colors.grass), mud: flat(b.colors.mud), rock: flat(b.colors.rock), shore: flat(b.colors.shoulder) };
      this.terrainMats[i] = splatMaterial(layers, { ground: 6, grass: 4, mud: 5, rock: 6, shore: 5 }, flat('#808080'), this.uOrigin);
      this.roadMats[i] = new THREE.MeshToonMaterial({ color: b.colors.road, gradientMap: toonRamp(), side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      this.vergeMats[i] = new THREE.MeshToonMaterial({ color: b.colors.shoulder, gradientMap: toonRamp(), side: THREE.DoubleSide, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    });
    void this.loadPaint();
    void this.loadKit();
    if (this.plan.biomes.some((b) => b.islands)) this.makeCloudSea();
    this.makeLandmarks();
  }

  /** Compile every material the journey will draw (terrain per biome, road, verge, water, scatter pieces, the cloud
   *  sea) off-screen before the first chunk shows: no shader compile ever lands on a gameplay frame. */
  warmed = false;
  async warm(renderer: THREE.WebGLRenderer, camera: THREE.Camera, lit: THREE.Object3D[]) {
    this.renderer = renderer;
    for (let tries = 0; tries < 40 && !this.kitLoaded && !this.disposed; tries++) await new Promise((r) => setTimeout(r, 50));
    const scene = new THREE.Scene();
    for (const l of lit) scene.add(l.clone());
    scene.fog = new THREE.Fog('#ffffff', 10, 100);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6), 2));
    g.setAttribute('splat', new THREE.BufferAttribute(new Uint8Array(12), 4, true));
    for (const m of [...this.terrainMats, ...this.roadMats, ...this.vergeMats, this.waterMat]) { const x = new THREE.Mesh(g, m); x.receiveShadow = true; scene.add(x); }
    for (const list of this.pieces.values()) for (const p of list) { const im = new THREE.InstancedMesh(p.geo, p.mat, 1); im.receiveShadow = true; scene.add(im); }
    for (const p of this.tuftPieces) { const im = new THREE.InstancedMesh(p.geo, p.mat, 1); im.receiveShadow = true; scene.add(im); }
    if (this.cloud) scene.add(new THREE.Mesh(g, this.cloud.material as THREE.Material));
    try { await renderer.compileAsync(scene, camera); } catch { /* compiles on first draw */ }
    this.warmed = true;
  }
  private kitLoaded = false;
  /** Textures that finished loading: uploaded to the GPU one per frame (a burst of 1k uploads hitches). */
  private texQueue: THREE.Texture[] = [];
  private renderer: THREE.WebGLRenderer | null = null;

  // ---------------------------------------------------------------- queries
  /** Ground height under a LOCAL point (camera clamp, props, markers). */
  groundLocal(x: number, z: number): number { return heightAt(this.plan, x + this.origin[0], z + this.origin[1]); }
  setOrigin(o: [number, number]) { this.origin = [o[0], o[1]]; this.root.position.set(-o[0], 0, -o[1]); this.uOrigin.value.set(o[0], o[1]); }
  /** Solid scatter (trees, rocks) near a LOCAL point → camera blocker spheres. */
  solidsNear(x: number, z: number, r: number, out: { c: THREE.Vector3; r: number }[], pool: THREE.Vector3[]) {
    const wx = x + this.origin[0], wz = z + this.origin[1];
    let k = 0;
    for (const l of this.live.values()) {
      if (Math.abs((l.cx + 0.5) * CHUNK - wx) > CHUNK / 2 + r || Math.abs((l.cz + 0.5) * CHUNK - wz) > CHUNK / 2 + r) continue;
      const s = l.scatter;
      for (let i = 0; i < s.length; i += 9) {
        if (!s[i + 7] || Math.abs(s[i + 1] - wx) > r || Math.abs(s[i + 3] - wz) > r) continue;
        const v = pool[k] ?? (pool[k] = new THREE.Vector3());
        v.set(s[i + 1] - this.origin[0], s[i + 2] + 1.6 * s[i + 5], s[i + 3] - this.origin[1]);
        out.push({ c: v, r: Math.max(0.4, s[i + 8]) * 1.2 });
        if (++k > 60) return;
      }
    }
  }

  // ---------------------------------------------------------------- streaming
  /** Keep the chunks around a LOCAL point; build at most one arrived chunk per frame. */
  update(dt: number, lx: number, lz: number, graves?: Grave[], miles?: number) {
    this.time += dt;
    this.waterMat.uniforms.uTime.value = this.time;
    const tx = this.texQueue.shift();
    if (tx && this.renderer) this.renderer.initTexture(tx);
    const wx = lx + this.origin[0], wz = lz + this.origin[1];
    const ccx = Math.floor(wx / CHUNK), ccz = Math.floor(wz / CHUNK);
    // wanted set + LOD
    const want = new Map<string, number>();
    // inner 3×3: full detail (step 1) — but any chunk not on screen yet gets the quick coarse version first; outer ring: coarse
    for (let dz = -RING; dz <= RING; dz++) for (let dx = -RING; dx <= RING; dx++) {
      const key = `${ccx + dx},${ccz + dz}`, inner = Math.max(Math.abs(dx), Math.abs(dz)) <= 1;
      want.set(key, inner && this.live.has(key) ? 1 : 4);
    }
    // drop far chunks (hysteresis: one ring more)
    for (const [k, l] of this.live) if (Math.abs(l.cx - ccx) > RING + 1 || Math.abs(l.cz - ccz) > RING + 1) { this.root.remove(l.group); disposeGroup(l.group); this.live.delete(k); this.scatterDirty = true; }
    // request missing / wrong-LOD chunks, nearest first, ≤ 2 in flight
    if (this.pending.size < 3) {
      const order = [...want.entries()].filter(([k, step]) => { const l = this.live.get(k); return (!l || l.step > step) && this.pending.get(k) !== step; })
        .map(([k, step]) => { const [cx, cz] = k.split(',').map(Number); return { k, step, cx, cz, d: Math.hypot(cx + 0.5 - wx / CHUNK, cz + 0.5 - wz / CHUNK) }; }).sort((a, b) => a.d - b.d);
      for (const o of order.slice(0, 3 - this.pending.size)) { this.pending.set(o.k, o.step); this.worker.postMessage({ t: 'chunk', cx: o.cx, cz: o.cz, step: o.step, req: ++this.req }); }
    }
    // build one arrived chunk (after the materials are compiled: no shader compile on a gameplay frame)
    const m = this.warmed || this.time > 4 ? this.arrived.shift() : undefined;
    if (m) {
      const k = `${m.cx},${m.cz}`;
      this.pending.delete(k);
      if (want.has(k) || (Math.abs(m.cx - ccx) <= RING + 1 && Math.abs(m.cz - ccz) <= RING + 1)) {
        const old = this.live.get(k);
        if (old) { this.root.remove(old.group); disposeGroup(old.group); }
        const group = this.buildChunk(m);
        this.root.add(group);
        this.live.set(k, { key: k, cx: m.cx, cz: m.cz, step: m.step, group, scatter: m.scatter, biome: m.biome, grid: m.step === 1 ? m.pos : undefined });
        this.scatterDirty = true;
      }
    }
    if (this.scatterDirty && this.pieces.size) { this.scatterDirty = false; this.rebuildScatter(); }
    if (this.cloud) { this.cloud.position.set(wx, -17, wz); (this.cloud.material as THREE.ShaderMaterial).uniforms.uTime.value = this.time; }
    if (graves && miles !== undefined) this.placeGraves(graves, miles);
  }
  /** Chunks built so far (tests / the loading gate). */
  get chunkCount() { return this.live.size; }

  private buildChunk(m: ChunkMesh): THREE.Group {
    const g = new THREE.Group();
    g.position.set(m.cx * CHUNK, 0, m.cz * CHUNK);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 3));
    geo.setAttribute('splat', new THREE.BufferAttribute(m.spl, 4, true));
    geo.setIndex(new THREE.BufferAttribute(m.idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(CHUNK / 2, (m.minH + m.maxH) / 2, CHUNK / 2), Math.hypot(CHUNK / 2, CHUNK / 2, (m.maxH - m.minH) / 2 + 3));
    const t = new THREE.Mesh(geo, this.terrainMats[m.biome] ?? this.terrainMats[0]);
    t.receiveShadow = true; t.castShadow = false; t.name = 'terrain';
    g.add(t);
    const strip = (s: Strip | null, mat: THREE.Material, name: string) => {
      if (!s) return;
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(s.pos, 3));
      sg.setAttribute('uv', new THREE.BufferAttribute(s.uv, 2));
      sg.setIndex(new THREE.BufferAttribute(s.idx, 1));
      sg.computeVertexNormals();
      const sm = new THREE.Mesh(sg, mat);
      sm.receiveShadow = true; sm.name = name;
      g.add(sm);
    };
    strip(m.road, this.roadMats[m.biome] ?? this.roadMats[0], 'road');
    strip(m.verge, this.vergeMats[m.biome] ?? this.vergeMats[0], 'verge');
    strip(m.water, this.waterMat, 'water');
    return g;
  }

  // ---------------------------------------------------------------- trailart's painted layers
  private async loadPaint() {
    const r = await fetch(themeFileUrl(this.theme, 'terrain/terrain.json'), { cache: 'no-store' }).then((x) => (x.ok ? x.json() : null)).catch(() => null) as { biomes?: Record<string, BiomeTex> } | null;
    if (!r?.biomes || this.disposed) return;
    const ids = Object.keys(r.biomes);
    this.plan.biomes.forEach((b, i) => {
      const t = r.biomes![b.id] ?? r.biomes![ids[Math.min(i, ids.length - 1)]];
      if (!t) return;
      const tex = (f?: string, srgb = true) => { if (!f) return null; const x = texLoader.load(themeFileUrl(this.theme, f), (t) => this.texQueue.push(t)); x.wrapS = x.wrapT = THREE.RepeatWrapping; x.anisotropy = 4; if (srgb) x.colorSpace = THREE.SRGBColorSpace; return x; };
      const cur = this.terrainMats[i] as THREE.MeshToonMaterial & { userData: { layers: Record<Layer, { value: THREE.Texture }>; tiles: { value: THREE.Vector4 }; tile5: { value: number }; det: { value: THREE.Texture } } };
      const L = cur.userData;
      for (const k of ['ground', 'grass', 'mud', 'rock', 'shore'] as Layer[]) { const e = t.layers[k]; const x = tex(e?.file); if (x) L.layers[k].value = x; }
      L.tiles.value.set(t.layers.ground?.tileM ?? 6, t.layers.grass?.tileM ?? 4, t.layers.mud?.tileM ?? 5, t.layers.rock?.tileM ?? 6);
      L.tile5.value = t.layers.shore?.tileM ?? 5;
      const d = tex(t.detail, false); if (d) L.det.value = d;
      if (t.road) { const x = tex(t.road.file)!; x.repeat.set(1, 1 / (t.road.tileM || 4)); const rm = this.roadMats[i] as THREE.MeshToonMaterial; rm.map = x; rm.color.set('#ffffff'); rm.needsUpdate = true; }
      if (t.verge) { const x = tex(t.verge.file)!; x.repeat.set(1, 1 / (t.verge.tileM || 4)); x.wrapS = THREE.ClampToEdgeWrapping; const vm = this.vergeMats[i] as THREE.MeshToonMaterial; vm.map = x; vm.color.set('#ffffff'); vm.opacity = 1; vm.alphaTest = 0.02; vm.needsUpdate = true; }
    });
  }

  // ---------------------------------------------------------------- scatter (instanced)
  private async loadKit() {
    const g = await loadThemeGlb(this.theme, 'levels/trail_road.glb').catch(() => null);
    const extra = await loadThemeGlb(this.theme, 'scatter.glb').catch(() => null);
    if (this.disposed) return;
    const found: Piece[] = [];
    for (const src of [g, extra]) {
      if (!src) continue;
      src.updateMatrixWorld(true);
      src.traverse((o) => {
        if (/^INST_/.test(o.name) && !/_(mesh|LOD\d)$/.test(o.name)) { const m = o.getObjectByProperty('isMesh', true) as THREE.Mesh | undefined; if (m && !this.tuftPieces.some((x) => x.geo === m.geometry)) this.tuftPieces.push({ geo: m.geometry, mat: Array.isArray(m.material) ? m.material[0] : m.material }); return; }
        if (!/^SCENERY_/.test(o.name) || /_(mesh|LOD\d)$/.test(o.name)) return;
        const tr = (o.userData?.trail ?? {}) as { biomes?: string[]; scaleMin?: number; scaleMax?: number; role?: string };
        const id = o.name.replace(/^SCENERY_/, '');
        const role = tr.role && (ROLES as readonly string[]).includes(tr.role) ? tr.role : roleOf(id);
        if (!role) return;
        // bake the piece (all its meshes, LOD0 only) into one geometry per material, relative to the piece root
        const inv = new THREE.Matrix4().copy(o.matrixWorld).invert();
        const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
        o.traverse((x) => {
          const m = x as THREE.Mesh;
          if (!m.isMesh || /_LOD1|COL_/.test(m.name) || (m as THREE.SkinnedMesh).isSkinnedMesh) return;
          const mat = Array.isArray(m.material) ? m.material[0] : m.material;
          if (/^M_(Ink|Collider)/i.test(mat.name)) return;
          const geo = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
          for (const a of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(a)) geo.deleteAttribute(a);
          (byMat.get(mat) ?? byMat.set(mat, []).get(mat)!).push(geo);
        });
        for (const [mat, geos] of byMat) {
          const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos.map((x) => (x.index ? x : x)), false);
          if (!merged) continue;
          found.push({ id: `${id}:${found.length}`, geo: merged, mat, biomes: (tr.biomes ?? []).map(String), sMin: Number(tr.scaleMin) || 1, sMax: Number(tr.scaleMax) || 1, role });
        }
      });
    }
    // every role the generator uses gets at least a procedural stand-in
    for (const role of ROLES) if (!found.some((p) => p.role === role)) found.push(...standIns(role, this.plan.biomes[0]?.colors));
    for (const p of found) (this.pieces.get(p.role) ?? this.pieces.set(p.role, []).get(p.role)!).push(p);
    this.scatterDirty = true;
    this.kitLoaded = true;
    void this.dressKit();
  }
  // ground tufts (trailart INST_*: grass / flowers / pebbles) on the near chunks, deterministic per chunk
  private tuftPieces: { geo: THREE.BufferGeometry; mat: THREE.Material }[] = [];
  private tuftMeshes: THREE.InstancedMesh[] = [];
  private rebuildTufts() {
    if (!this.tuftPieces.length) return;
    if (!this.tuftMeshes.length) for (const p of this.tuftPieces) { const im = new THREE.InstancedMesh(p.geo, p.mat, 4200); im.castShadow = false; im.receiveShadow = true; im.frustumCulled = false; this.tuftMeshes.push(im); this.root.add(im); }
    const counts = this.tuftMeshes.map(() => 0);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
    for (const l of this.live.values()) {
      if (l.step !== 1 || !l.grid) continue;
      let h = ((l.cx * 73856093) ^ (l.cz * 19349663)) | 1;
      const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; };
      for (let i = 0; i < 260; i++) {
        const ix = Math.floor(rnd() * 64), iz = Math.floor(rnd() * 64), k = Math.floor(rnd() * this.tuftMeshes.length);
        const wx = l.cx * CHUNK + ix + rnd(), wz = l.cz * CHUNK + iz + rnd();
        const y = l.grid[(iz * 65 + ix) * 3 + 1];
        if (y < -8 || roadInfo(this.plan, wx, wz, 3.4)) continue;
        if (counts[k] >= 4200) continue;
        const sc = 0.7 + rnd() * 0.8;
        m4.compose(t.set(wx, y - 0.02, wz), q.setFromAxisAngle(Y, rnd() * 6.28), s.set(sc, sc, sc));
        this.tuftMeshes[k].setMatrixAt(counts[k]++, m4);
      }
    }
    this.tuftMeshes.forEach((im, i) => { im.count = counts[i]; im.instanceMatrix.needsUpdate = true; });
  }
  /** trailart's sign / bridge kits: the fork signposts + bridges and ford markers at the creek crossings. */
  private async dressKit() {
    const signs = await loadThemeGlb(this.theme, 'sign_kit.glb').catch(() => null);
    const bridges = await loadThemeGlb(this.theme, 'bridge_kit.glb').catch(() => null);
    if (this.disposed) return;
    const piece = (kit: THREE.Object3D | null, name: string) => { const src = kit?.getObjectByName(name); if (!src) return null; const c = src.clone(); c.position.set(0, 0, 0); c.rotation.set(0, 0, 0); c.traverse((x) => { x.castShadow = false; }); return c; };
    if (signs) for (const g of [...this.root.children]) {
      if (!g.userData.fork) continue;
      const post = piece(signs, 'SIGN_fork');
      if (!post) continue;
      // turn the sign so its arm A points down the main road; the labels go on the sockets
      const dir = g.userData.mainDir as [number, number];
      post.rotation.y = Math.atan2(-dir[1], dir[0]);
      post.updateMatrixWorld(true);
      for (const c of [...g.children]) if ((c as THREE.Mesh).isMesh) g.remove(c);
      const labels = g.children.filter((c) => (c as THREE.Sprite).isSprite);
      const sA = post.getObjectByName('SOCKET_sign_A'), sB = post.getObjectByName('SOCKET_sign_B');
      const base = post.getWorldPosition(new THREE.Vector3());
      if (sA && labels[0]) { labels[0].position.copy(sA.getWorldPosition(new THREE.Vector3())).sub(base); labels[0].position.y += 0.35; }
      if (sB && labels[1]) { labels[1].position.copy(sB.getWorldPosition(new THREE.Vector3())).sub(base); labels[1].position.y += 0.35; }
      g.add(post);
    }
    if (bridges) for (const c of this.plan.creeks) {
      const r = roadInfo(this.plan, c.roadX, c.roadZ, 8);
      if (!r) continue;
      const g = new THREE.Group();
      g.position.set(c.roadX, 0, c.roadZ); g.rotation.y = Math.atan2(r.tx, r.tz);
      if (c.bridge) {
        const L = Math.ceil((c.half * 2 + 5) / 4) * 4;
        for (let z = -L / 2; z < L / 2; z += 4) {
          const s = piece(bridges, 'BRIDGE_plank_span'); if (s) { s.position.set(0, r.h + 0.12, z); g.add(s); }
          for (const side of [-1, 1]) { const rl = piece(bridges, 'BRIDGE_rail'); if (rl) { rl.position.set(side * 1.5, r.h + 0.12, z); rl.scale.x = side; g.add(rl); } }
        }
        for (const end of [-1, 1]) { const e = piece(bridges, 'BRIDGE_end'); if (e) { e.position.set(0, r.h + 0.1, end * L / 2); e.rotation.y = end > 0 ? 0 : Math.PI; g.add(e); } }
      } else {
        for (const z of [-(c.half + 1.5), c.half + 1.5]) for (const x of [-2.9, 2.9]) { const m = piece(bridges, 'FORD_marker'); if (m) { m.position.set(x, heightAt(this.plan, c.roadX, c.roadZ) + 0.05, z); g.add(m); } }
        const st = piece(bridges, 'FORD_stones'); if (st) { st.position.set(3.6, c.level - 0.15, -2); g.add(st); }
      }
      this.addCompiled(g);
    }
  }
  /** Add a dressing group once its shaders are linked (no first-draw stall). */
  private addCompiled(g: THREE.Object3D) {
    g.visible = false; this.root.add(g);
    const r = this.renderer;
    if (!r) { g.visible = true; return; }
    const cam = new THREE.PerspectiveCamera();
    void r.compileAsync(g, cam, this.root.parent as THREE.Scene ?? undefined).catch(() => {}).then(() => { g.visible = true; });
  }
  private rebuildScatter() {
    this.rebuildTufts();
    // count per piece first
    const pick = (role: number, biome: number, v: number): Piece | null => {
      const list = this.pieces.get(ROLES[role]);
      if (!list?.length) return null;
      const bid = this.plan.biomes[biome]?.id ?? '';
      const own = list.filter((p) => !p.biomes.length || p.biomes.includes(bid));
      const L = own.length ? own : list;
      return L[Math.min(L.length - 1, Math.floor(v * L.length))];
    };
    const counts = new Map<Piece, number>();
    for (const l of this.live.values()) for (let i = 0; i < l.scatter.length; i += 9) { const p = pick(l.scatter[i], l.biome, l.scatter[i + 6]); if (p) counts.set(p, (counts.get(p) ?? 0) + 1); }
    for (const [p, im] of this.inst) if (!counts.has(p)) im.count = 0;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
    const fill = new Map<Piece, number>();
    for (const [p, n] of counts) {
      let im = this.inst.get(p);
      if (!im || im.instanceMatrix.count < n) {
        if (im) { this.root.remove(im); im.dispose(); }
        im = new THREE.InstancedMesh(p.geo, p.mat, Math.ceil(n * 1.5) + 16);
        im.castShadow = false; im.receiveShadow = true; im.frustumCulled = false;
        this.inst.set(p, im); this.root.add(im);
      }
      im.count = n; fill.set(p, 0);
    }
    for (const l of this.live.values()) {
      const S = l.scatter;
      for (let i = 0; i < S.length; i += 9) {
        const p = pick(S[i], l.biome, S[i + 6]);
        if (!p) continue;
        const im = this.inst.get(p)!, k = fill.get(p)!;
        const sc = S[i + 5] * (p.sMin + (p.sMax - p.sMin) * S[i + 6]);
        m4.compose(t.set(S[i + 1], S[i + 2] - 0.05, S[i + 3]), q.setFromAxisAngle(Y, S[i + 4]), s.set(sc, sc, sc));
        im.setMatrixAt(k, m4);
        fill.set(p, k + 1);
      }
    }
    for (const im of this.inst.values()) im.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- landmarks: fork signposts, node beacons, graves
  private makeLandmarks() {
    for (const f of this.plan.forks) {
      const main = this.plan.paths.find((p) => p.id === f.main), alt = this.plan.paths.find((p) => p.id === f.alt);
      if (!main || !alt) continue;
      const r = roadInfo(this.plan, f.x, f.z, 6);
      const a = pathPoint(alt, 30), m = r ? pathPoint(main, r.s + 30) : a;
      const sign = new THREE.Group();
      const h = heightAt(this.plan, f.x, f.z);
      // stand at the split, on the outside of the road
      const nx = -(r?.tz ?? 0), nz = r?.tx ?? 1;
      sign.position.set(f.x + nx * 4.2, h, f.z + nz * 4.2);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 3.2, 8), toon('#6b4a2e'));
      post.position.y = 1.6; sign.add(post);
      const board = (label: string, tx: number, tz: number, y: number, col: string) => {
        const b = labelSprite(label, { fg: '#fff8e0', bg: col, height: 0.42 });
        const yaw = Math.atan2(tx - f.x, tz - f.z);
        b.position.set(Math.sin(yaw) * 0.7, y, Math.cos(yaw) * 0.7);
        sign.add(b);
      };
      board(`➜ ${f.labels[0]}`, m.x, m.z, 2.75, '#3d5a2a');
      board(`➜ ${f.labels[1]}`, a.x, a.z, 2.2, '#8a3a2a');
      sign.userData.fork = f.alt;
      sign.userData.mainDir = [m.x - f.x, m.z - f.z];
      this.root.add(sign);
    }
    for (const n of this.plan.nodes) {
      if (n.kind === 'start') continue;
      const g = new THREE.Group();
      g.position.set(n.x, heightAt(this.plan, n.x, n.z), n.z);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.4, 60, 12, 1, true), new THREE.MeshBasicMaterial({ color: this.theme === 'skyisles' ? '#ffe9a8' : '#b8ff7a', transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false }));
      beam.position.y = 30; g.add(beam);
      const tag = labelSprite(n.name, { fg: '#ffffff', bg: 'rgba(20,20,30,0.7)', height: 1.4 });
      tag.position.y = 14; (tag.material as THREE.SpriteMaterial).fog = false; tag.renderOrder = 5; g.add(tag);
      this.root.add(g);
    }
  }
  private placeGraves(graves: Grave[], miles: number) {
    for (const gr of graves) {
      const key = `${gr.name}|${gr.mile}|${gr.seed}`;
      const near = Math.abs(gr.mile - miles) < 40;
      const have = this.graves.get(key);
      if (!near) { if (have) { this.root.remove(have); this.graves.delete(key); } continue; }
      if (have) continue;
      const main = this.plan.paths.filter((p) => p.kind === 'main').find((p) => gr.mile >= p.m0 && gr.mile <= p.m1);
      if (!main) continue;
      const L = main.cum[main.cum.length - 1];
      const pt = pathPoint(main, (gr.mile - main.m0) / Math.max(1e-6, main.m1 - main.m0) * L);
      const o = buildTombstone(this.theme, gr.name, gr.cause, gr.epitaph || '…');
      const side = Math.cos(pt.yaw), sidz = -Math.sin(pt.yaw);
      o.position.set(pt.x + side * 4, heightAt(this.plan, pt.x + side * 4, pt.z + sidz * 4), pt.z + sidz * 4);
      o.rotation.y = pt.yaw - Math.PI / 2;
      this.root.add(o);
      this.graves.set(key, o);
    }
  }
  private makeCloudSea() {
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(this.plan.biomes[0]?.colors.water ?? '#eef2ff') } },
      vertexShader: 'varying vec2 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: `uniform float uTime; uniform vec3 uColor; varying vec2 vW;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f); return mix(mix(h(i), h(i+vec2(1,0)), u.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), u.x), u.y); }
        void main(){ vec2 p = vW * 0.02 + vec2(uTime * 0.01, uTime * 0.004); float c = n(p) * 0.5 + n(p * 2.1) * 0.3 + n(p * 4.3) * 0.2;
          vec3 col = mix(uColor * 0.82, vec3(1.0), smoothstep(0.35, 0.8, c)); gl_FragColor = vec4(col, 0.92);
          #include <colorspace_fragment>
        }`,
    });
    this.cloud = new THREE.Mesh(new THREE.PlaneGeometry(900, 900, 1, 1), mat);
    this.cloud.rotation.x = -Math.PI / 2;
    this.cloud.renderOrder = -1;
    this.root.add(this.cloud);
  }

  dispose() {
    this.disposed = true;
    this.worker.terminate();
    for (const l of this.live.values()) disposeGroup(l.group);
    this.live.clear();
    for (const im of this.inst.values()) im.dispose();
    this.root.removeFromParent();
  }
}

// ---------------------------------------------------------------- materials
function colorTex(c: string): THREE.Texture {
  const t = new THREE.DataTexture(new Uint8Array([...new THREE.Color(c).toArray().map((x) => Math.round(x * 255)), 255]), 1, 1);
  t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
  return t;
}
/** A toon material that paints 5 world-tiled layers by the chunk's splat weights (+ a detail texture). */
function splatMaterial(L: Record<Layer, THREE.Texture>, tile: Record<Layer, number>, det: THREE.Texture, uOrigin: { value: THREE.Vector2 }): THREE.Material {
  const m = new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap: toonRamp(), side: THREE.DoubleSide });
  const U = {
    layers: { ground: { value: L.ground }, grass: { value: L.grass }, mud: { value: L.mud }, rock: { value: L.rock }, shore: { value: L.shore } } as Record<Layer, { value: THREE.Texture }>,
    tiles: { value: new THREE.Vector4(tile.ground, tile.grass, tile.mud, tile.rock) }, tile5: { value: tile.shore }, det: { value: det },
  };
  m.userData = U;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.tG = U.layers.ground; sh.uniforms.tGr = U.layers.grass; sh.uniforms.tM = U.layers.mud; sh.uniforms.tR = U.layers.rock; sh.uniforms.tS = U.layers.shore;
    sh.uniforms.uTiles = U.tiles; sh.uniforms.uTile5 = U.tile5; sh.uniforms.tDet = U.det; sh.uniforms.uOrigin = uOrigin;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 splat; varying vec4 vSplat; varying vec3 vWp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSplat = splat; vWp = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D tG, tGr, tM, tR, tS, tDet; uniform vec4 uTiles; uniform float uTile5; uniform vec2 uOrigin; varying vec4 vSplat; varying vec3 vWp;')
      .replace('#include <map_fragment>', `
        vec2 wq = vWp.xz + uOrigin;
        vec3 cc = texture2D(tG, wq / uTiles.x).rgb;
        cc = mix(cc, texture2D(tGr, wq / uTiles.y).rgb, vSplat.r);
        cc = mix(cc, texture2D(tS, wq / uTile5).rgb, vSplat.a);
        cc = mix(cc, texture2D(tM, wq / uTiles.z).rgb, vSplat.g);
        vec3 rk = texture2D(tR, vec2(wq.x + vWp.y * 0.7, wq.y - vWp.y * 0.7) / uTiles.w).rgb;
        cc = mix(cc, rk, vSplat.b);
        float dd = texture2D(tDet, wq / 1.9).r;
        cc *= 0.86 + 0.28 * dd;
        diffuseColor.rgb *= cc;`);
  };
  m.customProgramCacheKey = () => 'trail-splat-v1';
  return m;
}
function waterMaterial(color: string, cloudy: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, fog: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uCloud: { value: cloudy ? 1 : 0 } }]),
    vertexShader: 'varying vec2 vUv; \n#include <fog_pars_vertex>\n void main(){ vUv = uv; vec4 mvPosition = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mvPosition; \n#include <fog_vertex>\n }',
    fragmentShader: `uniform float uTime; uniform vec3 uColor; uniform float uCloud; varying vec2 vUv;
      #include <fog_pars_fragment>
      void main(){ vec2 q = vec2(vUv.x * 3.0, vUv.y * 0.35 - uTime * 0.6); float s = sin(q.x * 3.1 + sin(q.y * 2.3) * 1.4) * sin(q.y * 4.0);
        float streak = smoothstep(0.8, 1.0, s) * 0.5; float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
        vec3 c = mix(uColor * 0.78, uColor * 1.2, 0.5 + 0.5 * sin(q.y * 0.9 + q.x));
        gl_FragColor = vec4(c + vec3(streak), mix(0.75, 0.9, uCloud) * edge);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

// ---------------------------------------------------------------- kit roles + procedural stand-ins
function roleOf(id: string): string | null {
  const s = id.toLowerCase();
  if (/milepost/.test(s)) return null;
  if (/small|sapling|blossom/.test(s) && /tree|cypress|blossom/.test(s)) return 'tree_small';
  if (/tree|cypress|pine|oak|willow|palm/.test(s)) return 'tree';
  if (/stump|skull/.test(s)) return 'rock';
  if (/fallen_log|tire|couch|flamingo/.test(s)) return 'junk';
  if (/lily|mushroom_ring/.test(s)) return 'flower';
  if (/bush|shrub|fern|rose/.test(s)) return 'bush';
  if (/reed|cattail|tallgrass/.test(s)) return 'reed';
  if (/boulder|rock|stone/.test(s)) return 'rock';
  if (/shroom|flower|lotus|lamp|lily/.test(s)) return 'flower';
  if (/crystal/.test(s)) return 'crystal';
  if (/cloud/.test(s)) return 'cloud';
  if (/fence/.test(s)) return 'fence';
  if (/wreck|billboard|sign|junk|barrel|banner|cart/.test(s)) return 'junk';
  if (/statue|column|shrine|outhouse|ruin|arch|marker|pillar/.test(s)) return 'ruin';
  return null;
}
const standCache = new Map<string, Piece[]>();
function standIns(role: string, colors?: { grass: string; rock: string; ground: string }): Piece[] {
  const k = `${role}|${colors?.grass}`;
  const hit = standCache.get(k);
  if (hit) return hit;
  const paint = (g: THREE.BufferGeometry, c: string) => { const col = new THREE.Color(c); const n = g.attributes.position.count; const a = new Float32Array(n * 3); for (let i = 0; i < n; i++) a.set([col.r, col.g, col.b], i * 3); g.setAttribute('color', new THREE.BufferAttribute(a, 3)); g.deleteAttribute('uv'); return g; };
  const at = (g: THREE.BufferGeometry, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) => g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz)));
  const leaf = colors?.grass ?? '#4f7a3d', rock = colors?.rock ?? '#8a8378', wood = '#5b3d24';
  let geo: THREE.BufferGeometry;
  switch (role) {
    case 'tree': geo = mergeGeometries([paint(at(new THREE.CylinderGeometry(0.18, 0.28, 2.2, 7), 0, 1.1, 0), wood), paint(at(new THREE.ConeGeometry(1.6, 3.6, 8), 0, 3.6, 0), leaf), paint(at(new THREE.ConeGeometry(1.2, 2.6, 8), 0, 5.0, 0), leaf)])!; break;
    case 'tree_small': geo = mergeGeometries([paint(at(new THREE.CylinderGeometry(0.1, 0.16, 1.2, 6), 0, 0.6, 0), wood), paint(at(new THREE.IcosahedronGeometry(0.9, 0), 0, 1.8, 0, 1, 1.2, 1), leaf)])!; break;
    case 'bush': geo = paint(at(new THREE.IcosahedronGeometry(0.7, 0), 0, 0.45, 0, 1.2, 0.8, 1.1), leaf); break;
    case 'rock': geo = paint(at(new THREE.DodecahedronGeometry(0.9, 0), 0, 0.35, 0, 1.2, 0.8, 1), rock); break;
    case 'reed': geo = mergeGeometries([-0.2, 0, 0.2].map((x, i) => paint(at(new THREE.ConeGeometry(0.05, 1.4 + i * 0.2, 4), x, 0.7, (i - 1) * 0.15), '#7a8a3a')))!; break;
    case 'flower': geo = mergeGeometries([paint(at(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 4), 0, 0.2, 0), '#4a7a2a'), paint(at(new THREE.IcosahedronGeometry(0.12, 0), 0, 0.42, 0), '#ff9ad0')])!; break;
    case 'ruin': geo = paint(at(new THREE.CylinderGeometry(0.35, 0.4, 2.6, 8), 0, 1.3, 0), '#d8d2c8'); break;
    case 'junk': geo = paint(at(new THREE.BoxGeometry(0.9, 0.7, 0.7), 0, 0.35, 0), '#7a5533'); break;
    case 'fence': geo = mergeGeometries([paint(at(new THREE.BoxGeometry(0.1, 1, 0.1), -1, 0.5, 0), wood), paint(at(new THREE.BoxGeometry(0.1, 1, 0.1), 1, 0.5, 0), wood), paint(at(new THREE.BoxGeometry(2.1, 0.1, 0.06), 0, 0.75, 0), wood), paint(at(new THREE.BoxGeometry(2.1, 0.1, 0.06), 0, 0.4, 0), wood)])!; break;
    case 'crystal': geo = paint(at(new THREE.OctahedronGeometry(0.6, 0), 0, 0.9, 0, 0.7, 1.6, 0.7), '#b8a8ff'); break;
    default: geo = paint(at(new THREE.IcosahedronGeometry(1.6, 1), 0, 1, 0, 1.6, 0.7, 1.2), '#ffffff');
  }
  const mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonRamp(), emissive: role === 'crystal' ? new THREE.Color('#6a5acd') : new THREE.Color('#000000'), emissiveIntensity: role === 'crystal' ? 0.6 : 0 });
  const out = [{ id: `stand_${role}`, geo, mat, biomes: [], sMin: 1, sMax: 1, role }];
  standCache.set(k, out);
  return out;
}
function disposeGroup(g: THREE.Object3D) { g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); }); }
