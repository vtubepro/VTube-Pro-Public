// Kitchen: the three rigs (frog crew, the manager, the freezer guy) as glTF AnimationClips on AnimationMixers,
// posed each frame from the planner's samples (clip + time + cross-fade + hit overlay), plus the props they hold.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { disposeSkeletons } from '../../avatar/gpuDispose.ts';
import { type Sample, TAG } from './kitchenPlan';

export type Who = 'frog' | 'mgr' | 'brute';

export interface UnitAsset { who: Who; scene: THREE.Object3D; clips: Map<string, THREE.AnimationClip>; height: number }

const loader = new GLTFLoader();
const cache = new Map<string, Promise<UnitAsset>>();

let gradient: THREE.DataTexture | null = null;
function toonGradient() {
  if (gradient) return gradient;
  const d = new Uint8Array([90, 90, 90, 255, 180, 180, 180, 255, 255, 255, 255, 255]);
  gradient = new THREE.DataTexture(d, 3, 1, THREE.RGBAFormat);
  gradient.minFilter = THREE.NearestFilter; gradient.magFilter = THREE.NearestFilter; gradient.needsUpdate = true;
  return gradient;
}

/** glTF standard materials -> toon (cel bands like the avatars), keeping map / colour / vertex colours / alpha. */
function toToon(m: THREE.Material): THREE.Material {
  const s = m as THREE.MeshStandardMaterial;
  if (!s.isMeshStandardMaterial) return m;
  const t = new THREE.MeshToonMaterial({ color: s.color.clone(), map: s.map, vertexColors: s.vertexColors, gradientMap: toonGradient(),
    transparent: s.transparent, alphaTest: s.alphaTest, side: s.side, opacity: s.opacity });
  t.name = s.name;
  if (s.emissive && s.emissiveIntensity > 0) { t.emissive.copy(s.emissive); t.emissiveMap = s.emissiveMap; t.emissiveIntensity = s.emissiveIntensity; }
  return t;
}

export function loadUnit(url: string, who: Who): Promise<UnitAsset> {
  let p = cache.get(url);
  if (!p) {
    p = loader.loadAsync(url).then((g) => {
      const scene = g.scene;
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = false; mesh.receiveShadow = false;
        mesh.frustumCulled = false;       // skinned: the bind-pose bounds lie
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(toToon) : toToon(mesh.material);
      });
      const box = new THREE.Box3().setFromObject(scene);
      const clips = new Map(g.animations.map((a) => [a.name, a] as [string, THREE.AnimationClip]));
      return { who, scene, clips, height: Math.max(0.3, box.max.y - Math.min(0, box.min.y)) };
    });
    cache.set(url, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------------- held props
function vc(g: THREE.BufferGeometry, hex: string) {
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
const propMat = () => new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient() });
function part(g: THREE.BufferGeometry, hex: string, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  g.rotateX(rx); g.rotateY(ry); g.rotateZ(rz); g.translate(x, y, z);
  return new THREE.Mesh(vc(g, hex), propMat());
}

/** Props are modelled along +Y (the hand bone's axis), grip at the origin, frog-native metres. */
export function makeProp(kind: string): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'prop:' + kind;
  switch (kind) {
    case 'spatula':
      g.add(part(new THREE.CylinderGeometry(0.012, 0.012, 0.2, 6), '#222222', 0, 0.06, 0));
      g.add(part(new THREE.BoxGeometry(0.1, 0.13, 0.008), '#c9ced3', 0, 0.22, 0.02, 0.35));
      break;
    case 'basket':
      g.add(part(new THREE.CylinderGeometry(0.012, 0.012, 0.2, 6), '#222222', 0, 0.08, 0));
      g.add(part(new THREE.BoxGeometry(0.2, 0.12, 0.14), '#9aa0a6', 0, 0.24, 0.05));
      g.add(part(new THREE.BoxGeometry(0.17, 0.05, 0.12), '#ffd24a', 0, 0.29, 0.05));
      break;
    case 'bag':
      g.add(part(new THREE.BoxGeometry(0.16, 0.22, 0.1), '#b98552', 0, 0.1, 0.06));
      g.add(part(new THREE.BoxGeometry(0.06, 0.06, 0.012), '#ffc72c', 0, 0.12, 0.115));
      break;
    case 'cup':
      g.add(part(new THREE.CylinderGeometry(0.055, 0.045, 0.16, 12), '#ffffff', 0, 0.08, 0.06));
      g.add(part(new THREE.CylinderGeometry(0.057, 0.057, 0.05, 12), '#d81f26', 0, 0.09, 0.06));
      g.add(part(new THREE.CylinderGeometry(0.006, 0.006, 0.12, 5), '#ffc72c', 0.02, 0.2, 0.06));
      break;
    case 'mop':
      g.add(part(new THREE.CylinderGeometry(0.014, 0.014, 1.25, 6), '#c9a24a', 0, -0.35, 0));
      g.add(part(new THREE.BoxGeometry(0.34, 0.05, 0.1), '#2a6fc0', 0, -0.98, 0));
      for (let k = 0; k < 7; k++) g.add(part(new THREE.CylinderGeometry(0.018, 0.012, 0.16, 5), '#e8e4d8', -0.15 + k * 0.05, -1.07, 0));
      break;
    default: break;
  }
  return g;
}

// ---------------------------------------------------------------------------------------------------- one actor
const Q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), RED = new THREE.Color(1.0, 0.14, 0.1);

export class KActor {
  readonly root = new THREE.Group();
  private spin = new THREE.Group();
  private model: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private live = new Set<THREE.AnimationAction>();
  private hand: { L: THREE.Object3D | null; R: THREE.Object3D | null } = { L: null, R: null };
  private props = new Map<string, THREE.Object3D>();
  private skin: THREE.MeshToonMaterial[] = [];
  private skinBase: THREE.Color[] = [];
  private idle: string;
  readonly scale: number;
  head: THREE.Object3D | null = null;
  rage = 0;
  private lastMs = performance.now();
  visible = true;

  constructor(readonly asset: UnitAsset, height: number, tint?: THREE.Color) {
    this.model = skClone(asset.scene);
    // per-instance materials (rage glow / tints)
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((x) => x.clone());
      m.material = Array.isArray(m.material) ? mats : mats[0];
      for (const mt of mats) {
        const t = mt as THREE.MeshToonMaterial;
        if (asset.who === 'frog' && /FrogSkin/.test(t.name)) { if (tint) t.color.multiply(tint); this.skin.push(t); this.skinBase.push(t.color.clone()); }
      }
    });
    this.scale = height / asset.height;
    this.model.scale.setScalar(this.scale);
    this.spin.add(this.model);
    this.root.add(this.spin);
    this.root.name = 'kitchen:' + asset.who;
    this.mixer = new THREE.AnimationMixer(this.model);
    const bone = (n: string) => this.model.getObjectByName(n) ?? null;
    if (asset.who === 'frog') { this.hand = { L: bone('leftHand'), R: bone('rightHand') }; this.head = bone('head'); this.idle = 'idle'; }
    else { this.hand = { L: bone('hand_l'), R: bone('hand_r') }; this.head = bone('Head'); this.idle = 'Idle_Loop'; }
  }

  private action(name: string): THREE.AnimationAction | null {
    let a = this.actions.get(name);
    if (a) return a;
    const clip = this.asset.clips.get(name) ?? this.asset.clips.get(this.idle);
    if (!clip) return null;
    a = this.mixer.clipAction(clip);
    a.play(); a.enabled = false; a.timeScale = 0;
    this.actions.set(name, a);
    return a;
  }

  private setA(name: string, t: number, w: number, loop: boolean) {
    const a = this.action(name);
    if (!a || w <= 0.001) return;
    const d = a.getClip().duration || 1;
    a.time = loop ? ((t % d) + d) % d : Math.min(Math.max(0, t), d - 1e-3);
    a.enabled = true;
    a.weight = Math.min(1, (this.live.has(a) ? a.weight : 0) + w);
    this.live.add(a);
  }

  dur(name: string) { return this.asset.clips.get(name)?.duration ?? 0; }

  apply(s: Sample, loopOf: (clip: string) => boolean) {
    this.visible = !s.hidden;
    this.root.visible = !s.hidden;
    if (s.hidden) return;
    this.root.position.copy(s.pos);
    this.root.rotation.set(0, s.yaw, 0);
    if (s.spinAxis && s.spin) {
      // spin about the axis through the body's middle (not the feet)
      const mid = 0.45 * this.asset.height * this.scale;
      const local = s.spinAxis.clone().applyQuaternion(Q.setFromAxisAngle(UP, -s.yaw));
      this.spin.quaternion.setFromAxisAngle(local, s.spin);
      this.spin.position.set(0, mid, 0).sub(new THREE.Vector3(0, mid, 0).applyQuaternion(this.spin.quaternion));
    } else { this.spin.quaternion.identity(); this.spin.position.set(0, 0, 0); }
    for (const a of this.live) { a.weight = 0; a.enabled = false; }
    this.live.clear();
    const ow = s.over ? s.overW : 0;
    const main = (s.prev ? s.w : 1) * (1 - ow);
    this.setA(s.clip, s.time, main, loopOf(s.clip));
    if (s.prev) this.setA(s.prev, s.prevTime, (1 - s.w) * (1 - ow), loopOf(s.prev));
    if (s.over && ow > 0) this.setA(s.over, s.overTime, ow, false);
    this.mixer.update(0);
    // held props
    for (const [k, p] of this.props) p.visible = k === s.held;
    if (s.held && !this.props.has(s.held)) {
      const p = makeProp(s.held);
      const h = s.held === 'bag' || s.held === 'cup' ? this.hand.L : this.hand.R;
      if (h) { h.add(p); this.props.set(s.held, p); }
    }
    // rage glow (pulsing red skin)
    const want = s.tags & TAG.RAGE ? 1 : 0;
    const nowMs = performance.now(), dt = Math.min(0.5, Math.max(0, (nowMs - this.lastMs) / 1000)); this.lastMs = nowMs;
    this.rage += (want - this.rage) * Math.min(1, dt * 5);
    if (this.skin.length) {
      const pulse = this.rage * (0.55 + 0.45 * Math.sin(performance.now() / 110));
      // angry red: the skin colour swings to red (a tint over the painted texture) + a hot pulse
      this.skin.forEach((m, k) => { m.color.copy(this.skinBase[k]).lerp(RED, this.rage); m.emissive.setRGB(this.rage * 0.56 + pulse * 0.26, this.rage * 0.03, 0); });
    }
  }

  /** World position of the head top (bubbles / stars / steam). */
  headTop(out: THREE.Vector3) {
    if (this.head) { this.head.getWorldPosition(out); out.y += 0.35 * this.scale * (this.asset.who === 'frog' ? 1 : 0.6); return out; }
    return this.root.getWorldPosition(out).add(new THREE.Vector3(0, this.asset.height * this.scale, 0));
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    this.root.removeFromParent();
    this.model.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose()); });
    for (const p of this.props.values()) p.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
    disposeSkeletons(this.model);   // (the clone's own skeleton: only this frees its bone texture)
  }
}
