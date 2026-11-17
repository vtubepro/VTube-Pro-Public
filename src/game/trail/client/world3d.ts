// The Trail — the 3D world of one view: renderer, sky, sun, fog, the level (grey-box from the LevelDesc, or the theme
// pack's GLB when trailart delivered it), water, scenery streaming along the travel road, roadside tombstones.
import * as THREE from 'three';
import type { LevelDesc, ColDesc } from '../../../../shared/trail/levels.ts';
import type { Grave } from '../../../../shared/trail/types.ts';
import { buildDecor, buildTombstone, roadDecorKinds } from './art.ts';
import { disposeTree, mesh, onResizeOutlines, prng, toon, unitBox, unitCyl, unitSphere } from './kit.ts';
import { loadThemeGlb, themeClips } from './assets.ts';
import { buildStopView } from './stopview.ts';
import type { CamBlockers } from './camera.ts';

const TAG_COLOR: Record<string, string> = {
  ground: '#7a8a55', road: '#9c8457', wall: '#a8875c', wood: '#7a5533', rock: '#8a8378', shelf: '#7a5533', bed: '#6b4a2e', roof: '#6e3b2a',
  fence: '#7a5533', grass: '#6a9a3a', bush: '#5a8a3a', log: '#6b4a2e', counter: '#7a5533', tent: '#d8ceb6', spire: '#8a8378', arch: '#e8a33d', dock: '#7a5533', cloud: '#ffffff', mud: '#5a4a33',
};

export class World3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 900);
  readonly levelRoot = new THREE.Group();
  readonly entRoot = new THREE.Group();
  readonly fxRoot = new THREE.Group();
  /** Colliders as simple meshes for camera collision (third person). */
  readonly camBlockers: THREE.Object3D[] = [];
  /** Camera collision set (level meshes with a BVH + the collider boxes); filled in idle time after a level loads. */
  readonly blockers: CamBlockers = { meshes: [], extra: [], spheres: [] };
  private bvhQueue: THREE.Mesh[] = [];
  private bvhT = 0;
  private frameNo = 0;
  private sun = new THREE.DirectionalLight('#ffffff', 2);
  private hemi = new THREE.HemisphereLight('#ffffff', '#445533', 1);
  private sky: THREE.Mesh;
  private stars: THREE.Points | null = null;
  private waters: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial }[] = [];
  private bobbers: THREE.Object3D[] = [];
  private flickers: THREE.PointLight[] = [];
  level: LevelDesc | null = null;
  private levelKey = '';
  theme = 'frontier';
  time = 0;
  // travel scenery (absolute distance along the road = z - rebased)
  private rebased = 0;
  private cells = new Map<number, THREE.Group>();
  private graves = new Map<string, THREE.Group>();
  biome = '';
  /** Index of `biome` in the deck's biome list (theme packs may name their tiles differently: matched by order). */
  biomeIdx = 0;
  roadSeed = 1;
  // trailart's trail_road.glb: 60 m road tiles per biome + a SCENERY_* kit (ASSET_SPEC §2.6); null = the pack has none
  private roadKit: RoadKit | null | undefined;
  private roadKitTheme = '';
  private tiles = new Map<number, THREE.Object3D>();
  private particles: { pts: THREE.Points; kind: 'fly' | 'spark'; base: Float32Array; seed: Float32Array }[] = [];
  private emitMats: THREE.MeshToonMaterial[] = [];
  shadows: boolean;
  /** v2 journey: the day sky of the level (setTod blends it toward night) + the sun direction. */
  private daySky: LevelDesc['sky'] | null = null;
  private sunDir = new THREE.Vector3(-18, 40, 16).normalize();
  private starMat: THREE.PointsMaterial | null = null;
  /** the last generated stop's view: triangles + its longest synchronous build slice (ms) */
  stopStats: { tris: number; sliceMs: number } | null = null;

  constructor(readonly canvas: HTMLCanvasElement, o: { shadows?: boolean; transparent?: boolean } = {}) {
    this.shadows = o.shadows ?? true;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: !!o.transparent, powerPreference: 'high-performance', stencil: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = this.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;   // re-rendered every other frame (render())
    this.scene.add(this.hemi, this.sun, this.sun.target, this.levelRoot, this.entRoot, this.fxRoot, ...this.extraLights);
    this.sun.castShadow = this.shadows;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.02;
    const cam = this.sun.shadow.camera;
    cam.left = -30; cam.right = 30; cam.top = 30; cam.bottom = -30; cam.near = 1; cam.far = 140;
    // sky dome: vertical gradient
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color('#6aa6d8') }, bottom: { value: new THREE.Color('#f2e3c0') } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float k = smoothstep(-0.15, 0.65, vP.y); gl_FragColor = vec4(mix(bottom, top, k), 1.0); \n#include <colorspace_fragment>\n }',
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(600, 32, 16), skyMat);
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);
  }

  /** The scene's lights (a warm-up scene needs the same light setup: shader variants depend on it). */
  lights(): THREE.Object3D[] { return [this.hemi, this.sun, ...this.extraLights]; }
  /** Two point lights that always exist (a campfire, the wagon's lantern): adding / removing lights recompiles every
   *  shader, so they stay in the scene and only change intensity. */
  readonly extraLights = [new THREE.PointLight('#ff9a3a', 0, 22, 1.6), new THREE.PointLight('#ffd08a', 0, 16, 1.5)];
  /** Resolution scale on top of the device pixel ratio (adaptive: lowered while frames run late). */
  dprScale = 1;
  resize(w: number, h: number, dpr = Math.min(1.5, devicePixelRatio || 1) * this.dprScale) {
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    onResizeOutlines(h * dpr);
  }

  /** Build / swap the level (key changes only when the host loads a new one). */
  async setLevel(key: string, desc: LevelDesc) {
    if (key === this.levelKey) return;
    this.levelKey = key;
    this.level = desc;
    this.theme = desc.theme;
    for (const c of [...this.levelRoot.children]) { this.levelRoot.remove(c); disposeTree(c); }
    this.camBlockers.length = 0;
    this.blockers.meshes.length = 0; this.bvhQueue.length = 0;
    this.waters = []; this.bobbers = []; this.flickers = [];
    for (const g of this.cells.values()) this.levelRoot.remove(g);
    this.cells.clear(); this.graves.clear();
    this.tiles.clear();
    for (const p of this.particles) { p.pts.geometry.dispose(); (p.pts.material as THREE.Material).dispose(); }
    this.particles = []; this.emitMats = [];
    this.rebased = 0;
    // atmosphere
    const s = desc.sky;
    (this.sky.material as THREE.ShaderMaterial).uniforms.top.value.set(s.top);
    (this.sky.material as THREE.ShaderMaterial).uniforms.bottom.value.set(s.bottom);
    this.scene.fog = new THREE.Fog(s.fog, s.fogNear, s.fogFar);
    this.sun.color.set(s.sun); this.sun.intensity = s.sunI;
    this.hemi.color.set(s.amb); this.hemi.intensity = s.ambI; this.hemi.groundColor.set(s.night ? '#101828' : '#3a4a2a');
    this.sun.position.set(-18, s.night ? 22 : 40, 16);
    this.sunDir.set(-18, s.night ? 22 : 40, 16).normalize();
    if (this.stars) { this.scene.remove(this.stars); this.stars = null; this.starMat = null; }
    if (s.night) this.stars = this.makeStars(), this.scene.add(this.stars);
    this.daySky = desc.kind === 'journey' ? { ...s } : null;
    if (desc.kind === 'journey') { (this.scene.fog as THREE.Fog).near = 45; (this.scene.fog as THREE.Fog).far = 150; }
    // try the theme pack's GLB (trailart); else the grey-box from the colliders
    const glb = desc.glb ? await loadThemeGlb(desc.theme, desc.glb).catch(() => null) : null;
    // generated stops (stopgen.ts → stopview.ts): terrain + structures + the theme's kit pieces
    const sv = !glb && desc.art ? await buildStopView(desc, { night: !!s.night }).catch((e) => { console.warn('[trail] stop view failed', e); return null; }) : null;
    if (key !== this.levelKey) return;
    if (glb) {
      this.prepareLevelMeshes(glb);
      // compile the level's shaders + upload its textures BEFORE it's drawn (the first frame of a stop used to hitch)
      try { await this.renderer.compileAsync(glb, this.camera, this.scene); } catch { /* older drivers: compiles on draw */ }
      if (key !== this.levelKey) return;
      glb.traverse((o) => { const m = (o as THREE.Mesh).material; for (const mat of Array.isArray(m) ? m : m ? [m] : []) for (const v of Object.values(mat)) if ((v as THREE.Texture)?.isTexture) this.renderer.initTexture(v as THREE.Texture); });
      this.levelRoot.add(glb); this.glbLights(glb, !!s.night); this.glbFx(glb, !!s.night);
    }
    else if (sv) {
      try { await this.renderer.compileAsync(sv.root, this.camera, this.scene); } catch { /* compiles on draw */ }
      if (key !== this.levelKey) return;
      this.levelRoot.add(sv.root); this.flickers.push(...sv.flickers); this.bvhQueue.push(...sv.blockers); this.pumpBvh();
      this.stopStats = { tris: sv.tris, sliceMs: sv.sliceMs };
    }
    else for (const c of desc.cols) { const m = this.colMesh(c); if (m) { m.userData.greybox = 1; this.levelRoot.add(m); } }
    if (desc.kind === 'road') void this.loadRoadKit(desc.theme, key);
    for (const c of desc.cols) if (c.tag !== 'invisible' && c.shape === 'box' && !(glb && (c as { standIn?: boolean }).standIn)) this.camBlockers.push(this.blocker(c));
    for (const b of this.camBlockers) { b.updateMatrixWorld(true); this.blockers.meshes.push(b); }
    for (const w of desc.water) this.addWater(w.p, w.he, w.level, w.flow, w.color ?? '#3f6b3a', w.murk);
    for (const d of desc.decor) {
      const o = d.kind === 'tallgrass' ? buildDecor('tallgrass', desc.theme, 1, d.color) : buildDecor(d.kind, desc.theme, d.s, d.color);
      o.position.set(...d.p);
      if (d.kind === 'tallgrass') { o.scale.set(d.s, 1, d.yaw); } else o.rotation.y = d.yaw;
      this.levelRoot.add(o);
      o.traverse((x) => { if (x.userData.bob || x.userData.flame) this.bobbers.push(x); if ((x as THREE.PointLight).isPointLight) this.flickers.push(x as THREE.PointLight); });
    }
    if (desc.kind === 'river' && !glb && !sv) this.addFordMarkers(desc);
    // link every program the new level needs before it is drawn (the stop-change frame used to wait ~0.5–1.5 s on
    // getProgramInfoLog); the level stays hidden meanwhile (the stop card covers it)
    this.levelRoot.visible = false;
    await this.compileHidden(this.levelRoot);
    if (key === this.levelKey) this.levelRoot.visible = true;
  }
  /** Compile an object's shaders (in this scene's light / fog setup) off the frame; resolves when they're linked. */
  async compileHidden(obj: THREE.Object3D) {
    try { await this.renderer.compileAsync(obj, this.camera, this.scene); } catch { /* compiles on first draw */ }
  }

  private colMesh(c: ColDesc): THREE.Object3D | null {
    if (c.tag === 'invisible' || c.shape === 'trimesh') return null;
    const col = c.color ?? TAG_COLOR[c.tag] ?? '#999999';
    let m: THREE.Mesh;
    if (c.shape === 'box') m = mesh(unitBox(), toon(col), c.p, [c.he![0] * 2, c.he![1] * 2, c.he![2] * 2]);
    else if (c.shape === 'cylinder') m = mesh(unitCyl(24), toon(col), c.p, [c.r!, c.hh! * 2, c.r!]);
    else m = mesh(unitSphere(), toon(col), c.p, c.r!);
    if (c.q) m.quaternion.set(...c.q);
    m.castShadow = c.tag !== 'ground' && c.tag !== 'road';
    m.receiveShadow = true;
    // big flat ground: subtle checker so motion reads on stream
    if ((c.tag === 'ground' || c.tag === 'road') && c.he) m.material = groundMat(col, c.tag === 'road', c.he[0] * 2 / (c.tag === 'road' ? 4.4 : 9), c.he[2] * 2 / (c.tag === 'road' ? 4 : 9));
    return m;
  }
  private blocker(c: ColDesc): THREE.Object3D {
    const m = new THREE.Mesh(unitBox(), new THREE.MeshBasicMaterial({ visible: false }));
    m.position.set(...c.p); m.scale.set(c.he![0] * 2, c.he![1] * 2, c.he![2] * 2);
    if (c.q) m.quaternion.set(...c.q);
    m.updateMatrixWorld(true);
    return m;
  }
  private addWater(p: [number, number, number], he: [number, number, number], level: number, flow: [number, number], color: string, murk: number) {
    const mat = new THREE.ShaderMaterial({
      transparent: true, fog: true, depthWrite: false,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uFlow: { value: new THREE.Vector2(...flow) }, uColor: { value: new THREE.Color(color) }, uMurk: { value: murk } }]),
      vertexShader: 'varying vec2 vW; \n#include <fog_pars_vertex>\n void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xz; vec4 mvPosition = viewMatrix * w; gl_Position = projectionMatrix * mvPosition; \n#include <fog_vertex>\n }',
      fragmentShader: `uniform float uTime; uniform vec2 uFlow; uniform vec3 uColor; uniform float uMurk; varying vec2 vW;
        #include <fog_pars_fragment>
        void main(){ vec2 q = vW - uFlow * uTime; float s = sin(q.x*1.7 + sin(q.y*1.3)*1.2) * sin(q.y*1.9 - uTime*0.7);
          float streak = smoothstep(0.82, 1.0, s) * 0.55; vec3 c = mix(uColor*0.75, uColor*1.25, 0.5 + 0.5*sin(q.y*0.6 + q.x*0.3));
          gl_FragColor = vec4(c + vec3(streak), mix(0.55, 0.9, uMurk));
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(he[0] * 2, he[2] * 2, 1, 1), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(p[0], level, p[2]);
    m.renderOrder = 2;
    this.levelRoot.add(m);
    this.waters.push({ mesh: m, mat });
  }
  private addFordMarkers(desc: LevelDesc) {
    const ford = desc.paths.ford;
    if (!ford) return;
    for (const z of [-7, 7]) for (const x of [-2, 2]) { const post = mesh(unitCyl(8), toon('#e8a33d'), [x, 0.4, z], [0.06, 1.2, 0.06]); this.levelRoot.add(post); }
  }
  private makeStars(): THREE.Points {
    const n = 800, pos = new Float32Array(n * 3);
    const r = prng(99);
    for (let i = 0; i < n; i++) { const a = r() * Math.PI * 2, e = 0.1 + r() * 1.3; pos.set([Math.cos(a) * Math.cos(e) * 500, Math.sin(e) * 500, Math.sin(a) * Math.cos(e) * 500], i * 3); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ color: '#ffffff', size: 1.6, sizeAttenuation: false, fog: false }));
  }

  // ---------------------------------------------------------------- travel road scenery (streamed by distance)
  rebase(dz: number) {
    this.rebased += dz;
    for (const g of this.cells.values()) g.position.z += dz;
    for (const g of this.graves.values()) g.position.z += dz;
  }
  /** Keep scenery cells around `z` (sim space) on the road level; `miles` places old tombstones. */
  streamRoad(z: number, miles: number, oldGraves: Grave[], perMile: number) {
    if (this.level?.kind !== 'road') return;
    const CELL = 16;
    const abs = z - this.rebased;
    const c0 = Math.floor(abs / CELL) - 4, c1 = Math.floor(abs / CELL) + 9;
    for (const [k, g] of this.cells) if (k < c0 - 2 || k > c1 + 2) { this.levelRoot.remove(g); if (!g.userData.kit) disposeTree(g); this.cells.delete(k); }
    const kit = this.roadKit;
    if (kit) this.streamTiles(abs);
    const kinds = roadDecorKinds(this.theme, this.biome);
    for (let k = c0; k <= c1; k++) {
      if (this.cells.has(k)) continue;
      const g = new THREE.Group();
      const r = prng((this.roadSeed * 7919) ^ (k * 104729));
      if (kit) {
        // the kit's scenery for this stretch's biome: a few verge pieces + far silhouettes (the tiles carry their own decor)
        g.userData.kit = 1;
        const tb = this.tileFor().biome;
        const pool = kit.scenery.filter((x) => !x.biomes.length || x.biomes.includes(tb));
        for (let i = 0; i < 4 && pool.length; i++) {
          const it = pool[Math.floor(r() * pool.length)];
          if (it.id === 'milepost') continue;
          const far = it.place === 'far';
          const side = r() < 0.5 ? -1 : 1;
          const o = it.o.clone();
          o.position.set(side * (far ? 16 + r() * 34 : 4.2 + r() * 5), 0, k * CELL + r() * CELL + this.rebased);
          o.rotation.y = r() * 6.28;
          o.scale.setScalar(it.sMin + r() * (it.sMax - it.sMin));
          g.add(o);
        }
        const mp = kit.scenery.find((x) => x.id === 'milepost');
        if (k % 10 === 0 && mp) { const o = mp.o.clone(); o.position.set(3.2, 0, k * CELL + this.rebased); o.rotation.y = -Math.PI / 2; g.add(o); }
        this.levelRoot.add(g);
        this.cells.set(k, g);
        continue;
      }
      for (let i = 0; i < 7; i++) {
        const side = r() < 0.5 ? -1 : 1;
        const x = side * (4.5 + r() * 16);
        const kind = kinds[Math.floor(r() * kinds.length)];
        const d = buildDecor(kind, this.theme, 0.8 + r() * 0.8);
        d.position.set(x, 0, k * CELL + r() * CELL + this.rebased);
        d.rotation.y = r() * 6.28;
        g.add(d);
        d.traverse((x2) => { if (x2.userData.bob || x2.userData.flame) this.bobbers.push(x2); });
      }
      // a mile post every ~10 cells
      if (k % 10 === 0) { const post = mesh(unitCyl(8), toon('#e8dcc0'), [2.9, 0.6, k * CELL + this.rebased], [0.08, 1.2, 0.08]); g.add(post); }
      this.levelRoot.add(g);
      this.cells.set(k, g);
    }
    // old graves from earlier runs appear at their mile (a few metres off the road)
    for (const gr of oldGraves) {
      const key = `${gr.name}|${gr.mile}|${gr.seed}`;
      const dMiles = gr.mile - miles;
      if (dMiles < -20 || dMiles > 60) { const g = this.graves.get(key); if (g) { this.levelRoot.remove(g); this.graves.delete(key); } continue; }
      if (this.graves.has(key)) continue;
      const g = buildTombstone(this.theme, gr.name, gr.cause, gr.epitaph || '…');
      g.position.set(3.6, 0, z + dMiles * perMile);
      g.rotation.y = -Math.PI / 2;
      this.levelRoot.add(g);
      this.graves.set(key, g);
    }
  }

  // ---------------------------------------------------------------- trailart's road kit
  private async loadRoadKit(theme: string, key: string) {
    if (this.roadKitTheme !== theme) {
      this.roadKitTheme = theme;
      this.roadKit = undefined;
      const g = await loadThemeGlb(theme, 'levels/trail_road.glb').catch(() => null);
      if (this.roadKitTheme !== theme) return;
      this.roadKit = g ? readRoadKit(g) : null;
      if (this.roadKit) { const warm = new THREE.Group(); for (const t of this.roadKit.tiles) warm.add(t.o.clone()); for (const x of this.roadKit.scenery) warm.add(x.o.clone()); await this.compileHidden(warm); }
    }
    if (key !== this.levelKey || !this.roadKit) return;
    // the tiles bring their own ground: sink the grey-box road + ground a little (no z-fighting), keep it as the far floor
    for (const c of this.levelRoot.children) if (c.userData.greybox) { c.position.y -= 0.12; c.castShadow = false; }
    for (const [k, g] of this.cells) if (!g.userData.kit) { this.levelRoot.remove(g); disposeTree(g); this.cells.delete(k); }
  }
  private tileFor(): KitTile {
    const kit = this.roadKit!;
    return kit.tiles.find((t) => t.biome === this.biome) ?? kit.tiles[Math.min(kit.tiles.length - 1, Math.max(0, this.biomeIdx))] ?? kit.tiles[0];
  }
  private streamTiles(abs: number) {
    const kit = this.roadKit;
    if (!kit?.tiles.length) return;
    const L = kit.tileLen;
    const t0 = Math.floor(abs / L) - 2, t1 = Math.floor(abs / L) + 4;
    for (const [k, o] of this.tiles) if (k < t0 - 1 || k > t1 + 1) { this.levelRoot.remove(o); this.tiles.delete(k); }
    for (let k = t0; k <= t1; k++) {
      if (this.tiles.has(k)) { const o = this.tiles.get(k)!; o.position.z = k * L + L / 2 + this.rebased; continue; }
      const o = this.tileFor().o.clone();
      o.position.set(0, 0, k * L + L / 2 + this.rebased);
      o.userData.kit = 1;
      this.levelRoot.add(o);
      this.tiles.set(k, o);
    }
  }

  // ---------------------------------------------------------------- GLB effects: flames, fireflies, sparks
  private glbFx(root: THREE.Object3D, night: boolean) {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      const mats = m.isMesh ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
      if (/^FIRE/.test(o.name) || o.userData?.burns) { o.userData.flame = 1; this.bobbers.push(o); }
      for (const mat of mats) if (/^EMIT_(fire|bluefire|flame)/i.test(mat.name) && (mat as THREE.MeshToonMaterial).isMeshToonMaterial && !this.emitMats.includes(mat as THREE.MeshToonMaterial)) this.emitMats.push(mat as THREE.MeshToonMaterial);
      const col = String(o.userData?.color ?? '');
      if (/^FX_fireflies/.test(o.name)) this.addParticles(o, 'fly', /^#/.test(col) ? col : night ? '#d8ff7a' : '#fff2a8', 7);
      else if (/^FX_sparks/.test(o.name)) this.addParticles(o, 'spark', /^#/.test(col) ? col : '#ffb050', 18);
    });
  }
  private addParticles(at: THREE.Object3D, kind: 'fly' | 'spark', color: string, n: number) {
    const base = new Float32Array(n * 3), seed = new Float32Array(n);
    const r = prng(at.id * 31 + n);
    for (let i = 0; i < n; i++) { base.set(kind === 'fly' ? [(r() - 0.5) * 3, (r() - 0.5) * 1.2, (r() - 0.5) * 3] : [(r() - 0.5) * 0.5, 0, (r() - 0.5) * 0.5], i * 3); seed[i] = r() * 100; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(base.slice(), 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ color, map: dotTexture(), size: kind === 'fly' ? 0.12 : 0.07, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    pts.frustumCulled = false;
    at.visible = true;          // FX_ nodes are hidden helpers: show just our points under them
    at.add(pts);
    this.particles.push({ pts, kind, base, seed });
  }

  update(dt: number) {
    this.time += dt;
    for (const p of this.particles) {
      const a = p.pts.geometry.attributes.position as THREE.BufferAttribute, t = this.time;
      for (let i = 0; i < p.seed.length; i++) {
        const s = p.seed[i];
        if (p.kind === 'fly') a.setXYZ(i, p.base[i * 3] + Math.sin(t * 0.7 + s) * 0.6, p.base[i * 3 + 1] + Math.sin(t * 1.3 + s * 2) * 0.35, p.base[i * 3 + 2] + Math.cos(t * 0.6 + s) * 0.6);
        else { const u = ((t * 0.8 + s) % 1.6); a.setXYZ(i, p.base[i * 3] + Math.sin(s + t * 3) * 0.08 * u, u * 1.4, p.base[i * 3 + 2] + Math.cos(s + t * 2.5) * 0.08 * u); }
      }
      a.needsUpdate = true;
    }
    for (const m of this.emitMats) m.emissiveIntensity = (m.userData.ei ??= m.emissiveIntensity) * (0.8 + Math.sin(this.time * 11 + (m.userData.ph ??= Math.random() * 6)) * 0.12 + Math.sin(this.time * 17.3) * 0.08);
    for (const w of this.waters) w.mat.uniforms.uTime.value = this.time;
    for (const b of this.bobbers) {
      if (b.userData.flame) { b.scale.y = (b.userData.baseY ??= b.scale.y) * (0.85 + Math.sin(this.time * 13 + b.id) * 0.12); continue; }
      b.position.y = (b.userData.baseY ??= b.position.y) + Math.sin(this.time * 1.6 + b.id) * 0.25;
    }
    for (const l of this.flickers) { const base = (l.userData.base as number | undefined) ?? 26; l.intensity = base * (1 + Math.sin(this.time * 17 + l.id) * 0.15 + Math.sin(this.time * 7.3 + l.id) * 0.11); }
  }
  /** trailart's LIGHT_* empties (extras: kind 'point', color, range, intensity, flicker, nightOn) → real point lights.
   *  At most 6 (every light costs every toon material a pass); `nightOn` lamps only at night. No shadows. */
  private glbLights(root: THREE.Object3D, night: boolean) {
    const found: { o: THREE.Object3D; x: Record<string, unknown> }[] = [];
    root.traverse((o) => { if (/^LIGHT_/.test(o.name) && o.userData && (o.userData.kind ?? 'point') === 'point') found.push({ o, x: o.userData as Record<string, unknown> }); });
    let n = 0;
    for (const { o, x } of found.sort((a, b) => Number(!!b.x.flicker) - Number(!!a.x.flicker))) {
      if (n >= 6 || (x.nightOn && !night)) continue;
      const base = (Number(x.intensity) || 1) * (night ? 16 : 8);
      const l = new THREE.PointLight(String(x.color ?? '#ffc870'), base, Number(x.range) || 8, 2);
      l.userData.base = base;
      o.add(l);
      if (x.flicker) this.flickers.push(l);
      n++;
    }
  }

  /** v2 journey: continuous time of day (0.25 morning · 0.5 noon · 0.75 dusk · night), blending the level's day sky
   *  toward the theme's night: sky, fog, sun / moon direction + colour, ambient, stars. */
  setTod(tod: number, night: string) {
    const s = this.daySky;
    if (!s) return;
    const el = Math.sin((tod - 0.25) * Math.PI * 2);                 // noon 1 · midnight −1
    const day = Math.min(1, Math.max(0, (el + 0.12) / 0.4));
    const dusk = Math.max(0, 1 - Math.abs(el + 0.02) / 0.28);           // around sunrise / sunset
    const sky = this.sky.material as THREE.ShaderMaterial;
    const warm = TMP_C2.set('#ff8a4a');
    sky.uniforms.top.value.set(night).lerp(TMP_C.set(s.top), day);
    sky.uniforms.bottom.value.set('#1a2433').lerp(TMP_C.set(s.bottom), day).lerp(warm, dusk * 0.55);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.set(night).lerp(TMP_C.set(s.fog), day).lerp(warm, dusk * 0.25);
    this.sun.color.set('#8fa8ff').lerp(TMP_C.set(s.sun), day).lerp(TMP_C2.set('#ffb070'), dusk * 0.6);
    this.sun.intensity = 0.55 + (s.sunI - 0.55) * day;
    this.hemi.color.set('#6070a0').lerp(TMP_C.set(s.amb), day);
    this.hemi.intensity = 0.75 + (s.ambI - 0.75) * day;   // (nights stay readable on stream)
    this.hemi.groundColor.set('#101828').lerp(TMP_C.set('#3a4a2a'), day);
    // the sun travels east → west; at night the moon lights from the other side
    const az = tod * Math.PI * 2;
    const up = day > 0.05 ? Math.max(0.18, el) : Math.max(0.3, -el);
    this.sunDir.set(Math.cos(az) * (day > 0.05 ? 1 : -1), up * 1.4, Math.sin(az) * 0.6 + 0.3).normalize();
    if (!this.stars) { this.stars = this.makeStars(); this.starMat = this.stars.material as THREE.PointsMaterial; this.starMat.transparent = true; this.scene.add(this.stars); }
    if (this.starMat) { this.starMat.opacity = 1 - day; this.stars.visible = day < 0.95; }
  }

  /** Weather on the journey sky (after setTod): rain / storm darken + close the fog, hot warms it, a lightning flash. */
  weatherLook(kind: string, flash: number) {
    const fog = this.scene.fog as THREE.Fog | null;
    if (!fog || !this.daySky) return;
    const wet = kind === 'storm' ? 1 : kind === 'rain' ? 0.55 : kind === 'cold' ? 0.3 : 0;
    fog.far = 150 - wet * 60; fog.near = 45 - wet * 25;
    if (wet) { fog.color.lerp(TMP_C.set('#6a7280'), wet * 0.5); this.sun.intensity *= 1 - wet * 0.55; }
    if (kind === 'hot') fog.color.lerp(TMP_C.set('#ffd9a0'), 0.25);
    if (flash > 0) { this.hemi.intensity += flash * 2.5; (this.sky.material as THREE.ShaderMaterial).uniforms.top.value.lerp(TMP_C.set('#e8ecff'), flash * 0.6); }
  }

  /** Keep the sun's shadow box around the action. */
  focus(p: THREE.Vector3) {
    this.sun.target.position.copy(p);
    if (this.daySky) this.sun.position.set(p.x + this.sunDir.x * 60, p.y + this.sunDir.y * 60, p.z + this.sunDir.z * 60);
    else this.sun.position.set(p.x - 18, p.y + (this.level?.sky.night ? 22 : 40), p.z + 16);
    this.sky.position.copy(this.camera.position);
    if (this.stars) this.stars.position.copy(this.camera.position);
  }
  render() {
    // shadows: every other frame (the sun barely moves; the players' shadows lag one frame at most)
    if (this.shadows && (this.frameNo++ & 1) === 0) this.renderer.shadowMap.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  }

  /** Level GLB meshes: receive shadows but don't cast them (a 40k-triangle level re-rendered into the shadow map every
   *  frame was the biggest GPU cost); solid ones get a BVH for the camera, one mesh per idle slot. */
  private prepareLevelMeshes(glb: THREE.Object3D) {
    glb.updateMatrixWorld(true);
    glb.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = false; m.receiveShadow = true;
      let shown = true; for (let x: THREE.Object3D | null = m; x; x = x.parent) if (!x.visible) { shown = false; break; }
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const soft = mats.some((x) => x.transparent || x.alphaTest > 0 || /Foliage|Cloud|Sky|Water|Emit|Ink/i.test(x.name));
      if (!shown || soft || /FOLIAGE|FX_|SKY|WATER|CLOUD|_LOD1|COL_/i.test(m.name) || (m as THREE.SkinnedMesh).isSkinnedMesh) return;
      this.bvhQueue.push(m);
    });
    this.pumpBvh();
  }
  private pumpBvh() {
    if (this.bvhT || !this.bvhQueue.length) return;
    const run = () => {
      this.bvhT = 0;
      const t0 = performance.now();
      while (this.bvhQueue.length && performance.now() - t0 < 6) {
        const m = this.bvhQueue.shift()!;
        const g = m.geometry as THREE.BufferGeometry & { boundsTree?: unknown; computeBoundsTree?: () => void };
        try { if (!g.boundsTree) g.computeBoundsTree?.(); this.blockers.meshes.push(m); } catch { /* odd geometry: not a blocker */ }
      }
      if (this.bvhQueue.length) this.bvhT = window.setTimeout(run, 30);
    };
    this.bvhT = window.setTimeout(run, 30);
  }
  /** Warm the theme's GLBs (fetch + parse) in the background so no stop waits on the network or the parser. */
  async preload(theme: string, rels: string[]) {
    for (const rel of rels) {
      await new Promise((r) => setTimeout(r, 120));
      await themeClips(theme, rel).catch(() => []);
    }
  }
  dispose() { this.renderer.dispose(); try { this.renderer.forceContextLoss(); } catch { /* already lost */ } }
}

const TMP_C = new THREE.Color(), TMP_C2 = new THREE.Color();
const groundMats = new Map<string, THREE.Material>();
function groundMat(color: string, road: boolean, rx: number, rz: number): THREE.Material {
  const k = `${color}|${road}|${Math.round(rx)}|${Math.round(rz)}`;
  let m = groundMats.get(k);
  if (m) return m;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const base = new THREE.Color(color);
  g.fillStyle = `#${base.getHexString()}`; g.fillRect(0, 0, 256, 256);
  const r = prng(road ? 3 : 5);
  for (let i = 0; i < 420; i++) {
    const v = base.clone().offsetHSL((r() - 0.5) * 0.03, (r() - 0.5) * 0.08, (r() - 0.5) * 0.09);
    g.fillStyle = `#${v.getHexString()}`;
    const s = road ? 3 + r() * 10 : 4 + r() * 18;
    g.beginPath(); g.ellipse(r() * 256, r() * 256, s, s * (road ? 0.5 : 0.8), r() * 3, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(Math.max(1, Math.round(rx)), Math.max(1, Math.round(rz)));
  const mm = new THREE.MeshToonMaterial({ color: '#ffffff', map: t, gradientMap: (toon('#fff') as THREE.MeshToonMaterial).gradientMap });
  groundMats.set(k, mm);
  return mm;
}

interface KitTile { o: THREE.Object3D; biome: string }
interface KitScenery { id: string; o: THREE.Object3D; biomes: string[]; place: string; sMin: number; sMax: number }
interface RoadKit { tiles: KitTile[]; scenery: KitScenery[]; tileLen: number }
/** trail_road.glb → road tiles (roots LEVEL_trail_road[_<biome>], extras.trail.biome / tileLength) + SCENERY_<id> kit. */
function readRoadKit(g: THREE.Object3D): RoadKit | null {
  const tiles: KitTile[] = [], scenery: KitScenery[] = [];
  let tileLen = 60;
  const roots: THREE.Object3D[] = [];
  g.traverse((o) => { if (/^(LEVEL_trail_road|SCENERY_)/.test(o.name) && !/_(mesh|DECOR|FOLIAGE|TERRAIN|CLOUD)$/.test(o.name) && (o.userData?.trail || o.parent === g)) roots.push(o); });
  for (const o of roots) {
    const tr = (o.userData?.trail ?? {}) as { biome?: string; tileLength?: number; biomes?: string[]; place?: string; scaleMin?: number; scaleMax?: number };
    const tpl = o.clone();
    tpl.position.set(0, 0, 0);
    tpl.traverse((x) => { x.castShadow = false; });   // (scenery: shadows received, not cast — the map stays cheap)
    if (/^LEVEL_trail_road/.test(o.name)) { tiles.push({ o: tpl, biome: String(tr.biome ?? o.name.replace(/^LEVEL_trail_road_?/, '') ?? '') }); if (tr.tileLength) tileLen = Number(tr.tileLength) || 60; }
    else scenery.push({ id: o.name.replace(/^SCENERY_/, ''), o: tpl, biomes: Array.isArray(tr.biomes) ? tr.biomes.map(String) : [], place: String(tr.place ?? 'verge'), sMin: Number(tr.scaleMin) || 1, sMax: Number(tr.scaleMax) || 1 });
  }
  return tiles.length ? { tiles, scenery, tileLen } : null;
}

let dot: THREE.Texture | null = null;
/** A soft round glow for point sprites (fireflies, sparks). */
function dotTexture(): THREE.Texture {
  if (dot) return dot;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.35, 'rgba(255,255,255,0.7)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  dot = new THREE.CanvasTexture(c);
  return dot;
}
