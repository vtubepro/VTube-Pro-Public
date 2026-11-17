// Ambient crowd: one rigged unit GLB (rig + clips + OUTFIT_* / PROP_* / ROOTPROP_* meshes), cloned per character.
// A character is dressed by toggling mesh visibility (no per-outfit loads), posed from the planner's Pose each frame
// (clip + time, optional blend, body pitch / roll about its middle), and drawn at LOD0 / LOD1 by its size on screen.
import * as THREE from 'three';
import { skipMatricesWhileHidden } from '../hiddenSkip.ts';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { disposeSkeletons } from '../../avatar/gpuDispose.ts';
import type { Pose } from './crowdPlan';

export interface CrowdAsset { scene: THREE.Object3D; clips: Map<string, THREE.AnimationClip>; height: number; outfits: string[]; props: string[] }

const loader = new GLTFLoader();
const cache = new Map<string, Promise<CrowdAsset>>();

let gradient: THREE.DataTexture | null = null;
function toonGradient() {
  if (gradient) return gradient;
  const d = new Uint8Array([96, 96, 96, 255, 186, 186, 186, 255, 255, 255, 255, 255]);
  gradient = new THREE.DataTexture(d, 3, 1, THREE.RGBAFormat);
  gradient.minFilter = THREE.NearestFilter; gradient.magFilter = THREE.NearestFilter; gradient.needsUpdate = true;
  return gradient;
}
const toonCache = new Map<THREE.Material, THREE.Material>();
/** glTF standard materials → toon (cel bands like the avatars), keeping map / colour / vertex colours / emissive */
function toToon(m: THREE.Material): THREE.Material {
  const hit = toonCache.get(m); if (hit) return hit;
  const s = m as THREE.MeshStandardMaterial;
  if (!s.isMeshStandardMaterial) return m;
  const t = new THREE.MeshToonMaterial({ color: s.color.clone(), map: s.map, vertexColors: s.vertexColors, gradientMap: toonGradient(), transparent: s.transparent, alphaTest: s.alphaTest, side: s.side });
  t.name = s.name;
  if (s.emissive && (s.emissive.r + s.emissive.g + s.emissive.b) > 0) { t.emissive.copy(s.emissive); t.emissiveIntensity = Math.max(1, s.emissiveIntensity) * 1.6; }
  toonCache.set(m, t);
  return t;
}

export function loadCrowdUnit(url: string): Promise<CrowdAsset> {
  let p = cache.get(url);
  if (!p) {
    p = loader.loadAsync(url).then((g) => {
      const scene = g.scene;
      const outfits: string[] = [], props: string[] = [];
      scene.traverse((o) => {
        if (/^OUTFIT_/.test(o.name)) outfits.push(o.name.slice(7));
        if (/^(ROOT)?PROP_/.test(o.name)) props.push(o.name.replace(/^(ROOT)?PROP_/, ''));
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = false; mesh.receiveShadow = false;
        mesh.frustumCulled = false;                 // skinned: the bind-pose bounds lie (the crowd culls per character)
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(toToon) : toToon(mesh.material);
      });
      const body = scene.getObjectByName('Frog_Body') ?? scene;
      const box = new THREE.Box3().setFromObject(body);
      const clips = new Map(g.animations.map((a) => [a.name, a] as [string, THREE.AnimationClip]));
      return { scene, clips, height: Math.max(0.3, box.max.y - Math.min(0, box.min.y)), outfits, props };
    });
    cache.set(url, p);
  }
  return p;
}

/** skClone() gives every skinned part its own Skeleton (own bone-matrix update every frame + own bone texture) although all parts
 *  of one rig bind the very same bones with the very same inverses. The parts that do share one Skeleton: the bone matrices
 *  (bone world x bone inverse) are the same numbers; each part keeps its own bindMatrix. Parts whose bones or inverses differ
 *  keep theirs. Returns how many Skeletons went. (Skeleton.update runs once per skeleton per frame: the renderer guards it.) */
export function shareSkeletons(root: THREE.Object3D): number {
  const hosts: THREE.Skeleton[] = [];
  const same = (a: THREE.Skeleton, b: THREE.Skeleton) => {
    if (a.bones.length !== b.bones.length || a.boneInverses.length !== b.boneInverses.length) return false;
    for (let i = 0; i < a.bones.length; i++) if (a.bones[i] !== b.bones[i]) return false;
    for (let i = 0; i < a.boneInverses.length; i++) if (!a.boneInverses[i].equals(b.boneInverses[i])) return false;
    return true;
  };
  let n = 0;
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || !m.skeleton) return;
    const mine = m.skeleton, host = hosts.find((h) => h === mine || same(h, mine));
    if (!host) { hosts.push(mine); return; }
    if (host === mine) return;
    m.bind(host, m.bindMatrix.clone());   // (same bind matrix: only the skeleton it reads moves)
    mine.dispose();                       // (never uploaded yet: nothing on the GPU)
    n++;
  });
  return n;
}

const LOOPS = new Set(['hop', 'shock', 'wake']);
const loopOf = (c: string) => !LOOPS.has(c);
const TV = new THREE.Vector3(), E = new THREE.Euler();

export class CActor {
  readonly root = skipMatricesWhileHidden(new THREE.Group());   // (culled = no matrix work: src/scene/hiddenSkip.ts)
  private spin = new THREE.Group();
  private model: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private live = new Set<THREE.AnimationAction>();
  private outfitMeshes = new Map<string, THREE.Object3D>();
  private propNodes = new Map<string, THREE.Object3D>();
  private body: THREE.Object3D | null;
  private lod1: THREE.Object3D | null;
  private skin: THREE.MeshToonMaterial | null = null;
  readonly scale: number;
  head: THREE.Object3D | null;
  rodTip: THREE.Object3D | null;
  outfit = '';
  props = '';
  lodLevel = 0;
  visible = true;
  /** hidden by face / screen protection */
  shielded = false;
  /** skip the pose update this frame (off screen) */
  culled = false;

  constructor(readonly asset: CrowdAsset, height: number, tint?: THREE.Color) {
    this.model = skClone(asset.scene);
    shareSkeletons(this.model);
    this.scale = height / asset.height;
    this.model.scale.setScalar(this.scale);
    this.spin.add(this.model); this.root.add(this.spin);
    this.root.name = 'crowd:frog';
    this.mixer = new THREE.AnimationMixer(this.model);
    this.model.traverse((o) => {
      if (/^OUTFIT_/.test(o.name)) { this.outfitMeshes.set(o.name.slice(7), o); o.visible = false; }
      if (/^PROP_/.test(o.name)) { this.propNodes.set(o.name.slice(5), o); o.visible = false; }
    });
    // root props (the canoe) ride the character's root, not its hips
    const rootProps: THREE.Object3D[] = [];
    this.model.traverse((o) => { if (/^ROOTPROP_/.test(o.name)) rootProps.push(o); });
    this.root.updateMatrixWorld(true);
    for (const o of rootProps) { this.spin.attach(o); o.visible = false; this.propNodes.set(o.name.slice(9), o); }   // keeps its rest placement
    this.body = this.model.getObjectByName('Frog_Body') ?? null;
    this.lod1 = this.model.getObjectByName('Frog_Body_LOD1') ?? null;
    if (this.lod1) this.lod1.visible = false;
    // per-actor skin tint (the body's own material clone)
    for (const b of [this.body, this.lod1]) {
      const m = b as THREE.Mesh | null;
      if (!m?.isMesh) continue;
      if (!this.skin) { this.skin = (m.material as THREE.MeshToonMaterial).clone(); if (tint) this.skin.color.multiply(tint); }
      m.material = this.skin;
    }
    this.head = this.model.getObjectByName('head') ?? null;
    this.rodTip = this.model.getObjectByName('rod_tip') ?? null;
  }

  dress(outfit: string, props: string[]) {
    if (outfit !== this.outfit) {
      for (const [k, o] of this.outfitMeshes) o.visible = k === outfit;
      this.outfit = outfit;
    }
    const key = props.join(',');
    if (key !== this.props) {
      for (const [k, o] of this.propNodes) o.visible = props.includes(k);
      this.props = key;
    }
  }

  setLod(level: number) {
    if (level === this.lodLevel || !this.lod1 || !this.body) return;
    this.lodLevel = level;
    this.body.visible = level === 0; this.lod1.visible = level !== 0;
  }

  private action(name: string): THREE.AnimationAction | null {
    let a = this.actions.get(name);
    if (a) return a;
    const clip = this.asset.clips.get(name) ?? this.asset.clips.get('idle');
    if (!clip) return null;
    a = this.mixer.clipAction(clip);
    a.play(); a.enabled = false; a.timeScale = 0;
    this.actions.set(name, a);
    return a;
  }

  private setA(name: string, t: number, w: number) {
    const a = this.action(name);
    if (!a || w <= 0.001) return;
    const d = a.getClip().duration || 1;
    a.time = loopOf(name) ? ((t % d) + d) % d : Math.min(Math.max(0, t), d - 1e-3);
    a.enabled = true;
    a.weight = Math.min(1, (this.live.has(a) ? a.weight : 0) + w);
    this.live.add(a);
  }

  /** place + pose; mid = the body middle (m, model space × scale) the pitch / roll rotate about */
  apply(p: Pose, mid: number) {
    this.visible = !p.hidden;
    this.root.visible = !p.hidden && !this.shielded;
    if (p.hidden) return;
    this.root.position.copy(p.pos);
    this.root.rotation.set(0, p.yaw, 0);
    if (p.pitch || p.roll) {
      E.set(p.pitch, 0, p.roll, 'XZY');
      this.spin.quaternion.setFromEuler(E);
      this.spin.position.set(0, mid, 0).sub(TV.set(0, mid, 0).applyQuaternion(this.spin.quaternion));
    } else { this.spin.quaternion.identity(); this.spin.position.set(0, 0, 0); }
    if (this.culled) return;
    for (const a of this.live) { a.weight = 0; a.enabled = false; }
    this.live.clear();
    const w2 = p.clip2 && p.w2 ? Math.min(1, Math.max(0, p.w2)) : 0;
    this.setA(p.clip, p.time, 1 - w2);
    if (w2 > 0 && p.clip2) this.setA(p.clip2, p.time2 ?? p.time, w2);
    this.mixer.update(0);
  }

  headTop(out: THREE.Vector3) {
    if (this.head) { this.head.getWorldPosition(out); out.y += 0.42 * this.scale; return out; }
    return this.root.getWorldPosition(out).add(TV.set(0, this.asset.height * this.scale, 0));
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    this.root.removeFromParent();
    this.skin?.dispose();
    disposeSkeletons(this.model);   // (the clone's own skeleton: only this frees its bone texture)
  }
}
