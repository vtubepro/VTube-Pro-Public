// Frontline units: the rigid-part library (npc/units.glb + units.json: bugs, dropship, drop pod, eagle, exosuit,
// sentry, supply pod) drawn as ONE InstancedMesh per part (immediate mode: begin → put(unit, root, anim) → end), and
// the skinned Sprocket defenders (npc/defenders.glb: Hell-Hopper armour + rifle, clips idle / fire / reload / throw /
// call / cheer / duck) posed from the planner's clock.
import * as THREE from 'three';
import { skipMatricesWhileHidden } from '../hiddenSkip.ts';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { disposeSkeletons } from '../../avatar/gpuDispose.ts';

export interface PartDef { unit: string; name: string; role: string; side: number; idx: number; pivot: THREE.Vector3; glow: boolean; mesh: THREE.InstancedMesh; n: number }
export interface UnitDef { name: string; height: number; length: number; parts: PartDef[]; board?: number[] }
type Meta = Record<string, { height: number; length?: number; board?: number[]; parts: Record<string, { role: string; side: number; idx: number; pivot: number[]; glow: boolean }> }>;

const CAP: Record<string, number> = { scav: 220, warrior: 160, hunter: 110, spewer: 50, charger: 30, titan: 4, shrieker: 60, dropship: 8, pod: 12, eagle: 8, mech: 2, sentry: 8, supply: 4 };

let gradient: THREE.DataTexture | null = null;
export function toonGradient() {
  if (gradient) return gradient;
  const d = new Uint8Array([95, 95, 95, 255, 185, 185, 185, 255, 255, 255, 255, 255]);
  gradient = new THREE.DataTexture(d, 3, 1, THREE.RGBAFormat);
  gradient.minFilter = THREE.NearestFilter; gradient.magFilter = THREE.NearestFilter; gradient.needsUpdate = true;
  return gradient;
}

const _m = new THREE.Matrix4(), _p = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _v = new THREE.Vector3();

export class UnitLib {
  readonly group = new THREE.Group();
  readonly units = new Map<string, UnitDef>();
  private mats: THREE.Material[] = [];
  /** per-instance tint (flash on hit / death): white = none */
  private col = new THREE.Color();

  static async load(glbUrl: string, metaUrl: string): Promise<UnitLib> {
    const [g, meta] = await Promise.all([new GLTFLoader().loadAsync(glbUrl), fetch(metaUrl).then((r) => r.json() as Promise<Meta>)]);
    const lib = new UnitLib();
    lib.group.name = 'vtp:frontline:units';
    const toon = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient() });
    const glow = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false });
    lib.mats.push(toon, glow);
    const nodes = new Map<string, THREE.Mesh>();
    g.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && o.name) nodes.set(o.name, m); if (!m.isMesh && o.name.includes('__')) { const c = o.children.find((x) => (x as THREE.Mesh).isMesh) as THREE.Mesh | undefined; if (c) nodes.set(o.name, c); } });
    for (const [u, um] of Object.entries(meta)) {
      const def: UnitDef = { name: u, height: um.height, length: um.length ?? um.height, parts: [], board: um.board };
      for (const [pn, pm] of Object.entries(um.parts)) {
        const src = nodes.get(`${u}__${pn}`);
        if (!src) continue;
        const geo = src.geometry.clone();
        // multi-primitive nodes arrive as a group: we only keep the first primitive (units are one material per part)
        const cap = CAP[u] ?? 8;
        const mesh = new THREE.InstancedMesh(geo, pm.glow ? glow : toon, cap);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
        mesh.count = 0; mesh.frustumCulled = false; mesh.name = `hf:${u}:${pn}`;
        lib.group.add(mesh);
        def.parts.push({ unit: u, name: pn, role: pm.role, side: pm.side, idx: pm.idx, pivot: new THREE.Vector3(...(pm.pivot as [number, number, number])), glow: pm.glow, mesh, n: 0 });
      }
      lib.units.set(u, def);
    }
    return lib;
  }

  begin() { for (const u of this.units.values()) for (const p of u.parts) p.n = 0; }

  /** One unit instance: root (room space, includes scale), anim(part, q, s, off) sets each part's rotation / scale /
   *  extra offset (unit space) about its pivot. tint = instance colour multiplier. */
  put(unit: string, root: THREE.Matrix4, anim?: (p: PartDef, q: THREE.Quaternion, s: THREE.Vector3, off: THREE.Vector3) => void, tint?: THREE.Color, glowK = 1) {
    const u = this.units.get(unit);
    if (!u) return;
    for (const p of u.parts) {
      if (p.n >= p.mesh.instanceMatrix.count) continue;
      _q.identity(); _s.set(1, 1, 1); _v.set(0, 0, 0);
      anim?.(p, _q, _s, _v);
      if (_s.x <= 0.001) continue;
      _p.compose(_v.add(p.pivot), _q, _s);
      _m.multiplyMatrices(root, _p);
      p.mesh.setMatrixAt(p.n, _m);
      if (p.glow) this.col.setScalar(glowK); else if (tint) this.col.copy(tint); else this.col.setScalar(1);
      p.mesh.setColorAt(p.n, this.col);
      p.n++;
    }
  }

  end() {
    for (const u of this.units.values()) for (const p of u.parts) {
      p.mesh.count = p.n;
      if (p.n) { p.mesh.instanceMatrix.needsUpdate = true; if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true; }
    }
  }

  counts() { const o: Record<string, number> = {}; for (const u of this.units.values()) o[u.name] = u.parts[0]?.n ?? 0; return o; }

  dispose() {
    this.group.removeFromParent();
    for (const u of this.units.values()) for (const p of u.parts) { p.mesh.geometry.dispose(); p.mesh.dispose(); }
    for (const m of this.mats) m.dispose();
  }
}

// ---------------------------------------------------------------------------------------------------- defenders
function toToon(m: THREE.Material): THREE.Material {
  const s = m as THREE.MeshStandardMaterial;
  if (!s.isMeshStandardMaterial) return m;
  const t = new THREE.MeshToonMaterial({ color: s.color.clone(), map: s.map, vertexColors: s.vertexColors, gradientMap: toonGradient(), transparent: s.transparent, alphaTest: s.alphaTest, side: s.side });
  t.name = s.name;
  return t;
}

export interface DefenderAsset { scene: THREE.Object3D; clips: Map<string, THREE.AnimationClip>; height: number; muzzle: THREE.Vector3; hand: string }

export async function loadDefenders(url: string): Promise<DefenderAsset> {
  const g = await new GLTFLoader().loadAsync(url);
  let muzzle = new THREE.Vector3(0, 1, 0.5), hand = 'rightHand';
  g.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    const ud = o.userData as { hf_muzzle?: number[]; hf_hand?: string };
    if (Array.isArray(ud.hf_muzzle)) { const [x, y, z] = ud.hf_muzzle; muzzle = new THREE.Vector3(x, z, -y); if (ud.hf_hand) hand = ud.hf_hand; }
    if (!m.isMesh) return;
    m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false;
    m.material = Array.isArray(m.material) ? m.material.map(toToon) : toToon(m.material);
  });
  const box = new THREE.Box3().setFromObject(g.scene);
  return { scene: g.scene, clips: new Map(g.animations.map((a) => [a.name, a])), height: Math.max(0.3, box.max.y - Math.min(0, box.min.y)), muzzle, hand };
}

const LOOP = new Set(['idle', 'fire', 'cheer', 'duck']);

export class Defender {
  readonly root = skipMatricesWhileHidden(new THREE.Group());   // (culled = no matrix work: src/scene/hiddenSkip.ts)
  private model: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private live: THREE.AnimationAction[] = [];
  private handBone: THREE.Bone | null = null;
  private handInv = new THREE.Matrix4();
  readonly scale: number;

  constructor(readonly asset: DefenderAsset, height: number) {
    this.model = skClone(asset.scene);
    this.scale = height / asset.height;
    this.model.scale.setScalar(this.scale);
    this.root.add(this.model);
    this.root.name = 'hf:defender';
    this.mixer = new THREE.AnimationMixer(this.model);
    this.model.traverse((o) => {
      const sk = o as THREE.SkinnedMesh;
      if (sk.isSkinnedMesh && !this.handBone) {
        const i = sk.skeleton.bones.findIndex((b) => b.name === asset.hand);
        if (i >= 0) { this.handBone = sk.skeleton.bones[i]; this.handInv.copy(sk.skeleton.boneInverses[i]); }
      }
    });
  }

  private act(name: string) {
    let a = this.actions.get(name);
    if (!a) {
      const c = this.asset.clips.get(name) ?? this.asset.clips.get('idle');
      if (!c) return null;
      a = this.mixer.clipAction(c); a.play(); a.enabled = false; a.timeScale = 0;
      this.actions.set(name, a);
    }
    return a;
  }

  /** clip at time t (s into it), cross-faded from prev (w = weight of the new one) */
  pose(clip: string, t: number, prev?: string, prevT = 0, w = 1) {
    for (const a of this.live) { a.enabled = false; a.weight = 0; }
    this.live.length = 0;
    const set = (n: string, tt: number, ww: number) => {
      const a = this.act(n);
      if (!a || ww <= 0.001) return;
      const d = a.getClip().duration || 1;
      a.time = LOOP.has(n) ? ((tt % d) + d) % d : Math.min(Math.max(0, tt), d - 1e-3);
      a.enabled = true; a.weight = ww; this.live.push(a);
    };
    set(clip, t, prev ? w : 1);
    if (prev && prev !== clip) set(prev, prevT, 1 - w);
    this.mixer.update(0);
  }

  dur(n: string) { return this.asset.clips.get(n)?.duration ?? 1; }

  /** World muzzle point (after pose + updateMatrixWorld). */
  muzzle(out: THREE.Vector3) {
    if (!this.handBone) return this.root.getWorldPosition(out).add(new THREE.Vector3(0, 1, 0));
    return out.copy(this.asset.muzzle).applyMatrix4(this.handInv).applyMatrix4(this.handBone.matrixWorld);
  }

  dispose() {
    this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.model); this.root.removeFromParent();
    this.model.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose()); });
    disposeSkeletons(this.model);   // (the clone's own skeleton: only this frees its bone texture)
  }
}
