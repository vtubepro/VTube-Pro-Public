// Sky traffic — the ships: traffic/ships.glb (SHIP_<id> = LOD0, SHIP_<id>_LOD1 = decimated; each with _glow and _gear
// children; nose −Z, origin on the ground under the belly) cloned per active flight. Geometry is shared; each clone gets
// its own engine-glow material (thrust / boost), the gear child scales 0…1 on Y (its origin is the belly), landing lights
// are additive sprites under the hull, nav lights blink together, security drones strobe red / blue.
// LOD: LOD0 while the ship is taller than `lod0Px` pixels on screen (High / Ultra: ~70 px, Balanced: ~220 px, Performance
// never), else LOD1; ±15 % hysteresis.
import * as THREE from 'three';
import { govChannel, pageGovernor, type GovChannel } from '../../../shared/flashGovernor.ts';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { ShipMeta } from './config.ts';
import type { ShipPose } from './flights.ts';

interface LodSet { root: THREE.Object3D; glow: THREE.MeshStandardMaterial[]; gear: THREE.Object3D | null }
interface Live { obj: THREE.Group; lods: LodSet[]; lod: number; land: THREE.Sprite; ship: string; seen: number; police: THREE.MeshStandardMaterial[]; len: number }

let glowTex: THREE.Texture | null = null;
export function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

const tv = new THREE.Vector3();
const RED = new THREE.Color(1, 0.08, 0.05), BLUE = new THREE.Color(0.1, 0.35, 1);

export class Fleet {
  readonly group = new THREE.Group();
  readonly templates = new Map<string, THREE.Object3D>();
  private lod1 = new Map<string, THREE.Object3D>();
  private live = new Map<string, Live>();
  private navMats = new Set<THREE.MeshStandardMaterial>();
  private landMat: THREE.SpriteMaterial;
  meta: ShipMeta[] = [];
  ready = false;
  error = '';
  /** drawn scale (small craft read better slightly oversized from 700 m, like the space layer's 1.35×) */
  scale = 1;
  /** LOD0 above this many pixels of ship height/length on screen (Infinity = never) */
  lod0Px = 220;
  private frame = 0;
  counts = { lod0: 0, lod1: 0 };

  constructor() {
    this.group.name = 'vtp:traffic-ships';
    this.landMat = new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffe6c0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
  }

  async load(glbUrl: string, meta: ShipMeta[]) {
    this.meta = meta;
    try {
      const gltf = await new GLTFLoader().loadAsync(glbUrl);
      const prep = (node: THREE.Object3D) => {
        node.removeFromParent();
        node.position.set(0, 0, 0);
        node.traverse((o) => {
          o.castShadow = false; o.receiveShadow = false;
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          for (const mt of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            if (/^EMIT_navlights/.test(mt.name)) this.navMats.add(mt as THREE.MeshStandardMaterial);
          }
        });
      };
      for (const m of meta) {
        const node = gltf.scene.getObjectByName(m.node);
        if (!node) continue;
        const l1 = gltf.scene.getObjectByName((m as ShipMeta & { lod1?: string | null }).lod1 ?? `${m.node}_LOD1`);
        prep(node); this.templates.set(m.id, node);
        if (l1) { prep(l1); this.lod1.set(m.id, l1); }
      }
      this.ready = true;
    } catch (e) {
      this.error = String(e);
      console.warn('traffic: ships failed to load', e);
    }
  }

  private lodSet(tpl: THREE.Object3D, police: THREE.MeshStandardMaterial[] | null): LodSet {
    const root = tpl.clone(true);
    const glow: THREE.MeshStandardMaterial[] = [];
    let gear: THREE.Object3D | null = null;
    root.traverse((o) => {
      if (/_gear$/.test(o.name)) gear = o;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const next = mats.map((mt) => {
        if (/^EMIT_engine/.test(mt.name)) {
          const c = (mt as THREE.MeshStandardMaterial).clone();
          c.userData.baseI = (mt as THREE.MeshStandardMaterial).emissiveIntensity || 1;
          glow.push(c);
          return c;
        }
        if (police && /^EMIT_(navlights|shiplights)/.test(mt.name)) {
          const c = (mt as THREE.MeshStandardMaterial).clone();
          c.userData.phase = police.length % 2;
          police.push(c);
          return c;
        }
        return mt;
      });
      mesh.material = Array.isArray(mesh.material) ? next : next[0];
    });
    return { root, glow, gear };
  }

  private make(p: ShipPose): Live | null {
    const tpl = this.templates.get(p.ship);
    if (!tpl) return null;
    const obj = new THREE.Group();
    const police: THREE.MeshStandardMaterial[] = [];
    const isPolice = p.ship === 'drone';
    const lods = [this.lodSet(tpl, isPolice ? police : null)];
    const t1 = this.lod1.get(p.ship);
    if (t1) lods.push(this.lodSet(t1, isPolice ? police : null));
    for (const l of lods) { l.root.visible = false; obj.add(l.root); }
    const land = new THREE.Sprite(this.landMat);
    land.visible = false;
    obj.add(land);
    this.group.add(obj);
    const len = this.meta.find((m) => m.id === p.ship)?.length ?? 20;
    return { obj, lods, lod: -1, land, ship: p.ship, seen: 0, police, len };
  }

  /** night 0…1 (brighter lights), t = clock s (nav blink); cam + viewport height (px) for the LOD choice */
  update(poses: ShipPose[], night: number, t: number, cam?: THREE.PerspectiveCamera, viewH = 720) {
    if (!this.ready) return;
    this.frame++;
    const f = cam ? viewH / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) : 0;
    this.counts.lod0 = 0; this.counts.lod1 = 0;
    for (const p of poses) {
      let l = this.live.get(p.key);
      if (l && l.ship !== p.ship) { this.drop(p.key, l); l = undefined; }
      if (!l) { const n = this.make(p); if (!n) continue; l = n; this.live.set(p.key, l); }
      l.seen = this.frame;
      l.obj.visible = true;
      l.obj.position.copy(p.pos);
      l.obj.quaternion.copy(p.quat);
      l.obj.scale.setScalar(this.scale);
      // LOD: projected size of the ship's length
      let want = l.lods.length > 1 ? 1 : 0;
      if (cam && l.lods.length > 1) {
        const d = Math.max(1, tv.copy(p.pos).sub(cam.position).length());
        const px = (l.len * this.scale * f) / d;
        const th = this.lod0Px * (l.lod === 0 ? 0.85 : 1.15);
        want = px > th ? 0 : 1;
      }
      if (want !== l.lod) { l.lods.forEach((s, i) => { s.root.visible = i === want; }); l.lod = want; }
      if (want === 0) this.counts.lod0++; else this.counts.lod1++;
      const set = l.lods[want];
      if (set.gear) { set.gear.scale.y = Math.max(0.001, p.gear); set.gear.visible = p.gear > 0.02; }
      const k = (0.55 + 0.9 * night) * p.thrust;
      for (const g of set.glow) g.emissiveIntensity = (g.userData.baseI as number) * k;
      l.land.visible = p.landing > 0.02;
      if (l.land.visible) { l.land.position.set(0, -0.5, 0); l.land.scale.setScalar(l.len * (0.5 + 0.4 * night) * p.landing); }
      if (l.police.length) {
        const ph = Math.floor(t * 6) % 2;
        // (photosensitivity: red / blue swaps are WCAG red flashes — each bar steps the page's governor and keeps its colour
        // when a swap may not happen yet)
        const gov = pageGovernor(performance.timeOrigin + performance.now());
        for (const m of l.police) {
          const on = (ph + (m.userData.phase as number)) % 2 === 0, I = 7 * (0.5 + night);
          const ch = (m.userData.gch ??= govChannel('police bar')) as GovChannel;
          gov.step(ch, I * (on ? 0.2126 : 0.0722), on);
          if (!gov.holdRed) m.emissive.copy(on ? RED : BLUE);
          m.emissiveIntensity = I;
        }
      }
    }
    for (const [k, l] of this.live) if (l.seen !== this.frame) this.drop(k, l);
    const blink = (Math.sin(t * 5.2) > 0.55 ? 1 : 0.12) * (0.6 + 0.8 * night);
    for (const m of this.navMats) m.emissiveIntensity = 6 * blink;
    this.landMat.opacity = 0.35 + 0.5 * night;
  }

  private drop(key: string, l: Live) {
    l.obj.removeFromParent();
    for (const s of l.lods) for (const g of s.glow) g.dispose();
    for (const m of l.police) m.dispose();
    this.live.delete(key);
  }

  get count() { return this.live.size; }

  dispose() {
    for (const [k, l] of this.live) this.drop(k, l);
    this.templates.clear(); this.lod1.clear();
    this.group.removeFromParent();
    this.landMat.dispose();
    this.ready = false;
  }
}
