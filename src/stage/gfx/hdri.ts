// HDRI environment light + reflections for rooms (High / Ultra only): Poly Haven CC0 maps (tools/vendor/polyhaven/hdri,
// 2k originals) → assets/hdri/<name>_1k.hdr (tools/hdri_prep.py) → a 256² PMREM, cached per renderer for the page's
// lifetime (each map is fetched + decoded once, only when a High / Ultra room first asks for it).
//
// Only the ROOM's own MeshStandard / Physical materials get it (material.envMap): performers keep the studio's
// generated environment (avatars are exempt from room light, like Hi-Fi RUSH does), NPCs are MeshToon (no IBL), and the
// water / sky shaders (surfaces.ts) keep their own look. Every map is normalised to the same mean luminance at load, then
// the room's intensity is applied at RENDER time (the light show's per-material envMapIntensity dimming composes with it).
// The PMREM has the same size as the studio environment's (256), so swapping maps never changes a shader program.
//
// Room choice: scene.json `"gfx": { "hdri": "<name>" | { "name", "intensity", "rotation" (deg about +Y) } | false }`
// (or a top-level "hdri" key); else the built-in mapping below; unknown rooms get none.
import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import HDRI_META from '../../../assets/hdri/hdri.json';
import { baseRoomId } from '../../../shared/roomId.ts';

const URLS: Record<string, string> = {
  small_harbour_sunset: new URL('../../../assets/hdri/small_harbour_sunset_1k.hdr', import.meta.url).href,
  belfast_sunset_puresky: new URL('../../../assets/hdri/belfast_sunset_puresky_1k.hdr', import.meta.url).href,
  empty_warehouse_01: new URL('../../../assets/hdri/empty_warehouse_01_1k.hdr', import.meta.url).href,
  hospital_room_2: new URL('../../../assets/hdri/hospital_room_2_1k.hdr', import.meta.url).href,
  rogland_clear_night: new URL('../../../assets/hdri/rogland_clear_night_1k.hdr', import.meta.url).href,
  fireplace: new URL('../../../assets/hdri/fireplace_1k.hdr', import.meta.url).href,
  abandoned_factory_canteen_01: new URL('../../../assets/hdri/abandoned_factory_canteen_01_1k.hdr', import.meta.url).href,
};
export const HDRI_NAMES = Object.keys(URLS);

export interface RoomHdri { name: string; intensity: number; rotation: number }

/** Built-in mapping for the shipped rooms (theme → map). intensity 1 = the studio environment's brightness. */
const ROOM_HDRI: Record<string, RoomHdri> = {
  poe2_kingsmarch: { name: 'small_harbour_sunset', intensity: 1.0, rotation: 0 },
  eft_factory: { name: 'empty_warehouse_01', intensity: 0.8, rotation: 0 },
  raid_test: { name: 'empty_warehouse_01', intensity: 0.8, rotation: 0 },
  eft_labs: { name: 'hospital_room_2', intensity: 0.9, rotation: 0 },
  eft_labs_rnd: { name: 'hospital_room_2', intensity: 0.9, rotation: 0 },
  eft_customs_dorms: { name: 'abandoned_factory_canteen_01', intensity: 0.75, rotation: 0 },
  helldivers_bridge: { name: 'rogland_clear_night', intensity: 0.7, rotation: 0 },
  space_test: { name: 'rogland_clear_night', intensity: 0.7, rotation: 0 },
  test_room: { name: 'belfast_sunset_puresky', intensity: 0.8, rotation: 0 },
};

/** The room's HDRI (scene.json first, then the built-in mapping), or null. */
export function roomHdri(id: string, info: { gfx?: unknown; hdri?: unknown }): RoomHdri | null {
  const g = (info.gfx && typeof info.gfx === 'object' ? (info.gfx as Record<string, unknown>).hdri : undefined) ?? info.hdri;
  if (g === false || g === null) return null;
  const base = ROOM_HDRI[id] ?? ROOM_HDRI[baseRoomId(id)] ?? null;   // (an area `<room>~<area>`: its room's)
  if (typeof g === 'string') return URLS[g] ? { name: g, intensity: base?.intensity ?? 0.8, rotation: base?.rotation ?? 0 } : base;
  if (g && typeof g === 'object') {
    const o = g as Record<string, unknown>;
    const name = typeof o.name === 'string' && URLS[o.name] ? o.name : base?.name;
    if (!name) return null;
    const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
    return { name, intensity: num(o.intensity, base?.intensity ?? 0.8, 0, 4), rotation: num(o.rotation, base?.rotation ?? 0, -360, 360) };
  }
  return base;
}

/** Mean luminance every map is normalised to (≈ the studio RoomEnvironment's at intensity 0.55). */
const TARGET_LUM = 0.55;
const cache = new WeakMap<THREE.WebGLRenderer, Map<string, Promise<THREE.Texture | null>>>();

/** The map's PMREM (cached per renderer; null when it fails to load). */
export function loadHdri(renderer: THREE.WebGLRenderer, name: string): Promise<THREE.Texture | null> {
  let m = cache.get(renderer);
  if (!m) { m = new Map(); cache.set(renderer, m); }
  let p = m.get(name);
  if (!p) {
    p = (async () => {
      const url = URLS[name];
      if (!url) return null;
      try {
        const tex = await new HDRLoader().setDataType(THREE.FloatType).loadAsync(url);
        const meta = (HDRI_META as Record<string, { meanLum?: number }>)[name];
        const k = TARGET_LUM / Math.max(0.02, meta?.meanLum ?? TARGET_LUM);
        const d = tex.image.data as Float32Array;
        if (k !== 1) for (let i = 0; i < d.length; i++) d[i] *= k;
        tex.mapping = THREE.EquirectangularReflectionMapping;
        // 32-bit float textures are only filterable with OES_texture_float_linear (missing on some AMD / Intel / mobile
        // drivers): sample the 1k source unfiltered there instead of getting an incomplete (black) texture
        if (!renderer.extensions.has('OES_texture_float_linear')) { tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.generateMipmaps = false; }
        tex.needsUpdate = true;
        const gen = new THREE.PMREMGenerator(renderer);
        const rt = gen.fromEquirectangular(tex);
        gen.dispose(); tex.dispose();
        rt.texture.name = `hdri:${name}`;
        return rt.texture;
      } catch (e) { console.warn('[gfx] hdri', name, e); return null; }
    })();
    m.set(name, p);
  }
  return p;
}

const SKIP = /^(M_(Sea|Water|Ocean|Lake|River|Pond|Sky|Clouds)|GFX_(WATER|SKY))/i;

/** Binds one room's HDRI to its materials; on / off without shader recompiles. */
export class RoomEnvLight {
  private mats: { m: THREE.MeshStandardMaterial; rot: THREE.Euler }[] = [];
  private tex: THREE.Texture | null = null;
  private want: RoomHdri | null = null;
  private on = false;
  private base: number[] = [];
  /** Bumped when a map finished loading and was bound (Graphics compiles once then). */
  onBound: (() => void) | null = null;
  name: string | null = null;

  constructor(private renderer: THREE.WebGLRenderer) {}

  /** Room loaded: collect its PBR materials (performers / NPCs / water / sky excluded). */
  bind(root: THREE.Object3D | null, spec: RoomHdri | null, exclude: THREE.Object3D[] = []) {
    this.setOn(false);
    this.mats = []; this.tex = null; this.want = spec; this.name = spec?.name ?? null;
    if (!root || !spec) return;
    const skip = new Set(exclude);
    const seen = new Set<THREE.Material>();
    const walk = (o: THREE.Object3D) => {
      if (skip.has(o) || o.userData?.npc) return;
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.material) {
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const s = m as THREE.MeshStandardMaterial;
          if (seen.has(m) || !s.isMeshStandardMaterial || s.envMap || SKIP.test(s.name)) continue;
          seen.add(m);
          this.mats.push({ m: s, rot: s.envMapRotation.clone() });
        }
      }
      for (const c of o.children) walk(c);
    };
    walk(root);
  }

  /** High / Ultra with the effect on → load (once) + bind; else unbind (back to the studio environment). */
  setOn(on: boolean) {
    this.on = on;
    if (!on) { if (this.tex) for (const { m, rot } of this.mats) { if (m.envMap === this.tex) { m.envMap = null; m.envMapRotation.copy(rot); } } return; }
    const spec = this.want;
    if (!spec || !this.mats.length) return;
    if (this.tex) { this.apply(); return; }
    void loadHdri(this.renderer, spec.name).then((t) => {
      if (!t || this.want !== spec) return;
      this.tex = t;
      if (this.on) { this.apply(); this.onBound?.(); }
    });
  }

  /** Auto: fetch + decode the map when the room loads, so a later step up only binds it (no load mid-show). */
  prefetch() {
    const spec = this.want;
    if (!spec || this.tex || !this.mats.length) return;
    void loadHdri(this.renderer, spec.name).then((t) => { if (t && this.want === spec) { this.tex = t; if (this.on) { this.apply(); this.onBound?.(); } } });
  }

  private apply() {
    const y = THREE.MathUtils.degToRad(this.want?.rotation ?? 0);
    for (const { m } of this.mats) { m.envMap = this.tex; m.envMapRotation.set(0, y, 0); }
  }

  get active() { return this.on && !!this.tex; }
  get count() { return this.mats.length; }

  /** Around the frame's render: scale envMapIntensity by the room intensity (restored right after). */
  pre() {
    if (!this.active) return;
    const k = this.want!.intensity, B = this.base, M = this.mats;
    for (let i = 0; i < M.length; i++) { B[i] = M[i].m.envMapIntensity; M[i].m.envMapIntensity = B[i] * k; }
  }
  post() {
    if (!this.active) return;
    const B = this.base, M = this.mats;
    for (let i = 0; i < M.length; i++) M[i].m.envMapIntensity = B[i];
  }

  dispose() { this.bind(null, null); }
}
