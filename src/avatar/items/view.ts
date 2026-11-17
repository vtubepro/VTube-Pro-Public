// Drawing the items on the avatar (three.js side of the items lane, docs/b16/ITEMS.md). One ItemsView per page: the studio's
// preview and every OBS page each build their own from the same ItemStore contents.
//
// Where an item hangs: on the avatar's NORMALIZED humanoid bone (the VRM proxy rig whose rest pose has no rotation, so a
// place of "0.22 m up" means up on every avatar, whatever the model's own bone axes are, and it still follows every tracked
// head turn / arm swing), on the head at the face centre, or on the model root (stays put). An avatar with no humanoid (a
// soft rig, a 2D avatar) gets the same spots worked out from its size and face (boxAnchor), so a sticker is never refused.
//
// Cost: an item is a bone child, so a still sticker costs nothing per frame. A tick (own requestAnimationFrame) runs only while
// a GIF / APNG / WebP or an animated model is on; with nothing animated there is no timer at all.
import * as THREE from 'three';
import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { AvatarRuntime } from '../AvatarRuntime.ts';
import { HAND_POSE_CURL, ITEM_BASE_M, ITEM_REF_HEIGHT_M, PIN_CHOICES, handSideOf, type HandPose, type ItemPin, type ItemPlace, type ItemSpec, type PinChoice } from '../../../shared/avatarItems.ts';
import { loadItemModel, loadPicture, type ItemModel, type ItemPicture } from './pictures.ts';
import type { ItemStore } from './store.ts';

export interface ViewHooks {
  /** The bytes of an item: its RAM data or its library file. Null = not available (the item shows nothing and says why once). */
  bytesOf(spec: ItemSpec): Promise<ArrayBuffer | null>;
  /** A plain-words problem with one item (shown once as a toast by the studio). */
  onProblem?(id: string, why: string): void;
}

interface Anchor { parent: THREE.Object3D; offset: THREE.Vector3; outward: number }

interface ItemNode {
  id: string;
  /** What forces new content: kind, source, speed. */
  sig: string;
  spec: ItemSpec;
  rev: number;
  holder: THREE.Group;
  inner: THREE.Group;
  content: THREE.Object3D | null;
  picture: ItemPicture | null;
  model: ItemModel | null;
  mat: THREE.MeshBasicMaterial | null;
  anchor: Anchor | null;
  t0: number;
  loading: number;
  /** content width / height */
  aspect: number;
  /** The hand this item closes, if any. */
  grip: { side: 'left' | 'right'; curl: number } | null;
}

/** Bones to try, in order, when the avatar lacks the first (a VRM without upper chest / shoulder bones ...). */
const BONE_FALLBACK: Record<string, string[]> = {
  upperChest: ['chest', 'spine'], chest: ['spine'], neck: ['head'],
  leftShoulder: ['leftUpperArm'], rightShoulder: ['rightUpperArm'],
  leftHand: ['leftLowerArm'], rightHand: ['rightLowerArm'],
};
const rad = (d: number) => (d * Math.PI) / 180;
const _v = new THREE.Vector3(), _w = new THREE.Vector3();

export class ItemsView {
  private rt: AvatarRuntime | null = null;
  private readonly nodes = new Map<string, ItemNode>();
  private unit = 1;
  /** From the head bone up to the top of this avatar, in place units (metres on a 1.6 m avatar); null when unknown. */
  private crown: number | null = null;
  /** Turns a bone's own frame into the avatar's frame (front = +Z, character's left = +X): a VRM 0.x model sits turned half round in its scene. */
  private readonly fix = new THREE.Quaternion();
  private baseGrip: { left: number; right: number } | null = null;
  private raf = 0;
  private lastTick = 0;
  private told = new Set<string>();
  private dead = false;

  constructor(private readonly store: ItemStore, private readonly hooks: ViewHooks) {}

  get runtime() { return this.rt; }
  get count() { return this.nodes.size; }
  has(id: string) { return this.nodes.has(id); }

  // ------------------------------------------------------------ binding to an avatar

  /** Hang everything on this avatar (a new one after a switch, or null to take it all off). */
  attach(rt: AvatarRuntime | null) {
    if (rt === this.rt) { this.reconcile(); return; }
    this.releaseGrip();
    this.rt = rt;
    this.baseGrip = null;
    if (rt) {
      try { rt.wrapper.updateWorldMatrix(true, true); } catch { /* not in a scene yet */ }
      this.unit = this.measureUnit(rt);
      this.crown = this.measureCrown(rt);
      this.fix.copy(rt.model.getWorldQuaternion(new THREE.Quaternion())).invert().multiply(rt.wrapper.getWorldQuaternion(new THREE.Quaternion()));
      if (rt.retarget) this.baseGrip = { left: rt.retarget.grip.left, right: rt.retarget.grip.right };
    }
    for (const n of this.nodes.values()) { n.anchor = null; n.rev = -1; n.holder.removeFromParent(); }
    this.reconcile();
  }

  private measureUnit(rt: AvatarRuntime): number {
    try {
      const box = rt.bounds();
      const s = new THREE.Vector3();
      rt.model.matrixWorld.decompose(_v, new THREE.Quaternion(), s);
      const h = (box.max.y - box.min.y) / Math.max(1e-6, Math.abs(s.y));
      return Number.isFinite(h) && h > 0.05 ? h / ITEM_REF_HEIGHT_M : 1;
    } catch { return 1; }
  }

  /** Distance from the head bone to the top of the avatar (measured before any item hangs on it), in place units. */
  private measureCrown(rt: AvatarRuntime): number | null {
    try {
      const head = rt.flat ? null : rt.humanoid?.getNormalizedBoneNode('head' as VRMHumanBoneName);
      if (!head) return null;
      const s = new THREE.Vector3();
      rt.model.matrixWorld.decompose(_v, new THREE.Quaternion(), s);
      const c = ((rt.bounds().max.y - head.getWorldPosition(_w).y) / Math.max(1e-6, Math.abs(s.y))) / Math.max(1e-6, this.unit);
      return Number.isFinite(c) && c > 0.02 && c < 1 ? c : null;
    } catch { return null; }
  }

  /** A place meant for the top of a head ("on top of my head", a hat, a halo) moved so it sits at THIS avatar's crown: a short
   *  head or tall hair would otherwise put the hat inside the face or high above it. */
  fitPlace(pin: ItemPin, place: ItemPlace): ItemPlace {
    if (this.crown === null || pin.to !== 'bone' || pin.bone !== 'head' || place.y < 0.15) return place;
    return { ...place, y: Math.round((place.y + Math.min(0.25, Math.max(-0.12, this.crown - 0.22))) * 1000) / 1000 };
  }

  // ------------------------------------------------------------ keeping up with the store

  /** The store changed: add, rebuild, move or drop what differs. Cheap when nothing did. */
  reconcile() {
    if (this.dead) return;
    for (const id of [...this.nodes.keys()]) if (!this.store.has(id)) this.drop(id);
    for (const e of this.store.list()) {
      let n = this.nodes.get(e.spec.id);
      const sig = `${e.spec.kind}|${JSON.stringify(e.spec.src)}|${e.spec.speed ?? 1}`;
      if (!n) {
        const holder = new THREE.Group(), inner = new THREE.Group();
        holder.name = `vtp:item:${e.spec.id}`; holder.userData.vtpItem = true; holder.userData.vtpNoToon = true;
        holder.add(inner);
        n = { id: e.spec.id, sig, spec: e.spec, rev: -1, holder, inner, content: null, picture: null, model: null, mat: null, anchor: null, t0: performance.now(), loading: 0, aspect: 1, grip: null };
        this.nodes.set(e.spec.id, n);
        void this.build(n);
      } else if (n.sig !== sig) {
        n.sig = sig; n.t0 = performance.now();
        void this.build(n);
      }
      if (n.rev !== e.rev) { n.spec = e.spec; n.rev = e.rev; this.place(n); }
    }
    this.syncGrip();
    this.wantTick();
  }

  private async build(n: ItemNode) {
    const my = ++n.loading;
    this.clearContent(n);
    let bytes: ArrayBuffer | null = null;
    try { bytes = await this.hooks.bytesOf(n.spec); } catch { bytes = null; }
    if (this.dead || my !== n.loading || !this.nodes.has(n.id)) return;
    if (!bytes) { this.problem(n.id, 'This picture is not available any more'); return; }
    try {
      if (n.spec.kind === 'model') {
        const m = await loadItemModel(bytes);
        if (this.dead || my !== n.loading || !this.nodes.has(n.id)) { m.dispose(); return; }
        n.model = m; n.aspect = m.aspect; n.content = m.root;
      } else {
        const p = await loadPicture(bytes, n.spec.speed ?? 1);
        if (this.dead || my !== n.loading || !this.nodes.has(n.id)) { p.dispose(); return; }
        n.picture = p; n.aspect = p.aspect;
        const mat = new THREE.MeshBasicMaterial({ map: p.texture, transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false, fog: false });
        const w = p.aspect >= 1 ? 1 : p.aspect, h = p.aspect >= 1 ? 1 / p.aspect : 1;
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
        mesh.userData.vtpItem = true; mesh.userData.vtpNoToon = true; mesh.frustumCulled = false; mesh.name = `vtp:item:${n.id}:picture`;
        n.mat = mat; n.content = mesh;
      }
    } catch (e) {
      console.warn('[items] could not read', n.id, e);
      this.problem(n.id, n.spec.kind === 'model' ? 'I could not read that 3D model. Try a plain .glb with no compression' : 'I could not read that picture');
      return;
    }
    if (n.content) n.inner.add(n.content);
    this.place(n);
    this.wantTick();
  }

  private problem(id: string, why: string) {
    if (this.told.has(id)) return;
    this.told.add(id);
    this.hooks.onProblem?.(id, why);
  }

  private clearContent(n: ItemNode) {
    if (n.content) { n.content.removeFromParent(); }
    n.picture?.dispose(); n.picture = null;
    n.model?.dispose(); n.model = null;
    if (n.mat) { n.mat.dispose(); (n.content as THREE.Mesh | null)?.geometry?.dispose(); n.mat = null; }
    n.content = null;
  }

  private drop(id: string) {
    const n = this.nodes.get(id);
    if (!n) return;
    n.loading++;
    this.nodes.delete(id);
    n.holder.removeFromParent();
    this.clearContent(n);
    this.told.delete(id);
  }

  // ------------------------------------------------------------ placing

  /** Parent + offset for a pin on the current avatar (null: no avatar yet). */
  private anchorOf(pin: ItemPin): Anchor | null {
    const rt = this.rt;
    if (!rt) return null;
    if (pin.to === 'screen') return { parent: rt.model, offset: new THREE.Vector3(), outward: 1 };
    if (!rt.flat) {
      const hum = rt.humanoid;
      const get = (name: string) => hum?.getNormalizedBoneNode(name as VRMHumanBoneName) ?? null;
      if (hum && pin.to === 'face') {
        const head = get('head'), f = rt.faceInfo();
        if (head && f) {
          const off = head.worldToLocal(_v.copy(f.center)).clone();
          off.add(new THREE.Vector3(0, 0, 0.02 * this.unit).applyQuaternion(this.fix));
          return { parent: head, offset: off, outward: 1 };
        }
      }
      if (hum && (pin.to === 'bone' || pin.to === 'part')) {
        const want = pin.to === 'bone' ? pin.bone : partToBone(pin.part);
        const node = [want, ...(BONE_FALLBACK[want] ?? [])].map(get).find((x): x is THREE.Object3D => !!x);
        if (node) {
          const lateral = /^(left|right)/.test(want);
          let outward = 1;
          if (lateral) { rt.wrapper.updateWorldMatrix(true, false); outward = rt.wrapper.worldToLocal(node.getWorldPosition(_w)).x >= 0 ? 1 : -1; }
          return { parent: node, offset: new THREE.Vector3(), outward };
        }
      }
    }
    return this.boxAnchor(pin);
  }

  /** No bone to hang on: the same spots worked out from the avatar's size and face. */
  private boxAnchor(pin: ItemPin): Anchor | null {
    const rt = this.rt;
    if (!rt) return null;
    const box = rt.bounds();
    const H = Math.max(0.01, box.max.y - box.min.y), W = Math.max(0.01, box.max.x - box.min.x);
    const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
    const face = rt.faceInfo()?.center ?? new THREE.Vector3(cx, box.min.y + H * 0.86, cz);
    const at = (x: number, y: number, z: number) => rt.model.worldToLocal(new THREE.Vector3(x, y, z));
    let w: THREE.Vector3, outward = 1;
    if (pin.to === 'screen') { return { parent: rt.model, offset: new THREE.Vector3(), outward: 1 }; }
    const bone = pin.to === 'bone' ? pin.bone : pin.to === 'part' ? partToBone(pin.part) : 'face';
    const sideSign = /^left/.test(bone) ? 1 : /^right/.test(bone) ? -1 : 0;
    if (bone === 'face') w = face.clone();
    else if (bone === 'head') w = face.clone().add(new THREE.Vector3(0, -H * 0.05, 0));
    else if (bone === 'neck') w = face.clone().add(new THREE.Vector3(0, -H * 0.11, 0));
    else if (/Hand|Arm|Elbow/.test(bone)) { w = new THREE.Vector3(cx + (sideSign || 1) * W * 0.32, box.min.y + H * 0.5, cz + H * 0.04); outward = sideSign >= 0 ? 1 : -1; }
    else if (/Shoulder/.test(bone)) { w = new THREE.Vector3(cx + (sideSign || 1) * W * 0.18, box.min.y + H * 0.8, cz); outward = sideSign >= 0 ? 1 : -1; }
    else w = new THREE.Vector3(cx, box.min.y + H * 0.72, cz);
    return { parent: rt.model, offset: at(w.x, w.y, w.z), outward };
  }

  private place(n: ItemNode) {
    const s = n.spec;
    const a = this.anchorOf(s.pin);
    if (!a) { n.holder.removeFromParent(); n.anchor = null; return; }
    if (n.anchor?.parent !== a.parent || !n.holder.parent) a.parent.add(n.holder);
    n.anchor = a;
    n.holder.position.copy(a.offset);
    n.holder.quaternion.copy(this.fix);
    const u = this.unit, p = s.place;
    n.inner.position.set(p.x * a.outward * u, p.y * u, p.z * u);
    n.inner.rotation.set(0, 0, rad(p.rot));
    const k = u * p.scale * ITEM_BASE_M;
    n.inner.scale.set(p.flipX ? -k : k, k, k);
    n.holder.visible = true;
    const front = s.layer !== 'behind';
    const order = front ? 30 : -5;
    n.inner.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.renderOrder = order;
      for (const mat of [m.material].flat()) {
        if (!mat) continue;
        if (n.mat === mat) { mat.depthTest = !front; mat.opacity = s.opacity ?? 1; }
        else if (s.opacity !== undefined) { mat.transparent = true; mat.opacity = s.opacity; }
      }
    });
    const hs = s.hand && s.pin.to === 'bone' ? handSideOf(s.pin.bone) : null;
    n.grip = s.hand && hs ? { side: hs, curl: HAND_POSE_CURL[s.hand.pose as HandPose] ?? 1 } : null;
  }

  // ------------------------------------------------------------ held props: the hand closes round them

  private syncGrip() {
    const rt = this.rt;
    if (!rt?.retarget || !this.baseGrip) return;
    const g = { left: this.baseGrip.left, right: this.baseGrip.right };
    for (const n of this.nodes.values()) if (n.grip) g[n.grip.side] = Math.max(g[n.grip.side], n.grip.curl);
    // a flat hand (curl 0) on top of a costume's grip must still win for the item's own hand
    for (const n of this.nodes.values()) if (n.grip && n.grip.curl === 0 && this.baseGrip[n.grip.side] === 0) g[n.grip.side] = 0;
    rt.retarget.grip.left = g.left; rt.retarget.grip.right = g.right;
  }
  private releaseGrip() {
    if (this.rt?.retarget && this.baseGrip) { this.rt.retarget.grip.left = this.baseGrip.left; this.rt.retarget.grip.right = this.baseGrip.right; }
  }

  // ------------------------------------------------------------ the tick (only while something moves by itself)

  private wantTick() {
    let need = false;
    for (const n of this.nodes.values()) if (n.picture?.animated || n.model?.mixer) { need = true; break; }
    if (need && !this.raf && !this.dead) { this.lastTick = performance.now(); this.raf = requestAnimationFrame(this.tick); }
    else if (!need && this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
  }
  private readonly tick = (now: number) => {
    this.raf = 0;
    if (this.dead) return;
    const dt = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    for (const n of this.nodes.values()) {
      if (n.picture?.animated) n.picture.step(now - n.t0);
      n.model?.mixer?.update(dt);
    }
    this.wantTick();
  };

  // ------------------------------------------------------------ for the selection frame and the drop

  /** The item under a point of the picture (NDC), nearest first. Null when nothing is there. */
  pick(ndc: THREE.Vector2, camera: THREE.Camera): string | null {
    if (!this.nodes.size) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hits: { id: string; d: number }[] = [];
    for (const n of this.nodes.values()) {
      if (!n.content || !n.holder.parent) continue;
      const h = ray.intersectObject(n.content, true)[0];
      if (h) hits.push({ id: n.id, d: h.distance });
    }
    hits.sort((a, b) => a.d - b.d);
    return hits[0]?.id ?? null;
  }

  /** The item's box on the canvas (CSS px from its top-left) + its centre, or null while it has no picture yet. */
  rectOf(id: string, camera: THREE.Camera, width: number, height: number): { x: number; y: number; w: number; h: number; cx: number; cy: number } | null {
    const n = this.nodes.get(id);
    if (!n?.content || !n.holder.parent) return null;
    n.holder.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(n.content);
    if (box.isEmpty()) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      _v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(camera);
      const px = (_v.x * 0.5 + 0.5) * width, py = (-_v.y * 0.5 + 0.5) * height;
      x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
    }
    n.inner.getWorldPosition(_w).project(camera);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, cx: (_w.x * 0.5 + 0.5) * width, cy: (-_w.y * 0.5 + 0.5) * height };
  }

  /** A movement in world space (a drag on the picture), as a change of the item's place. */
  placeDelta(id: string, worldDelta: THREE.Vector3): { x: number; y: number; z: number } | null {
    const n = this.nodes.get(id);
    if (!n?.anchor) return null;
    n.holder.updateWorldMatrix(true, false);
    const m = new THREE.Matrix4().copy(n.holder.matrixWorld).invert();
    m.setPosition(0, 0, 0);
    const l = worldDelta.clone().applyMatrix4(m);
    const u = this.unit || 1;
    return { x: (l.x / u) * n.anchor.outward, y: l.y / u, z: l.z / u };
  }
  /** Metres-on-screen: the world size of one pixel at the item's depth (for turning a drag into a move). */
  worldPerPixel(id: string, camera: THREE.PerspectiveCamera, canvasHeight: number): number {
    const n = this.nodes.get(id);
    if (!n) return 0;
    n.inner.getWorldPosition(_w);
    const d = _w.distanceTo(camera.position);
    return (2 * d * Math.tan(rad(camera.fov) / 2)) / Math.max(1, canvasHeight);
  }
  /** Where each "Where" choice sits on the picture now (0..1 of the canvas), for sending a drop to the nearest one. */
  choicePoints(camera: THREE.Camera): { id: string; x: number; y: number }[] {
    const out: { id: string; x: number; y: number }[] = [];
    if (!this.rt) return out;
    try { this.rt.wrapper.updateWorldMatrix(true, true); } catch { /* not in a scene */ }
    for (const c of PIN_CHOICES as readonly PinChoice[]) {
      if (c.pin.to === 'screen') continue;
      const a = this.anchorOf(c.pin);
      if (!a) continue;
      a.parent.updateWorldMatrix(true, false);
      const p = new THREE.Vector3(c.place.x * a.outward * this.unit, c.place.y * this.unit, c.place.z * this.unit).applyQuaternion(this.fix).add(a.offset).applyMatrix4(a.parent.matrixWorld).project(camera);
      out.push({ id: c.id, x: p.x * 0.5 + 0.5, y: -p.y * 0.5 + 0.5 });
    }
    return out;
  }
  /** World position of an item's centre (the studio's gizmo, tests). */
  worldPos(id: string): THREE.Vector3 | null {
    const n = this.nodes.get(id);
    if (!n?.content) return null;
    return n.inner.getWorldPosition(new THREE.Vector3());
  }
  /** For tests: the node's parent object and its world quaternion. */
  debug(id: string) {
    const n = this.nodes.get(id);
    return n ? { parent: n.holder.parent?.name ?? null, visible: n.holder.visible, hasContent: !!n.content, animated: !!n.picture?.animated, loading: n.loading } : null;
  }

  dispose() {
    this.dead = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.releaseGrip();
    for (const id of [...this.nodes.keys()]) this.drop(id);
    this.rt = null;
  }
}

/** A 2D part name (Pro2D / flat rigs) → the nearest body spot. */
export function partToBone(part: string): string {
  const p = part.toLowerCase();
  if (/hand|finger|palm/.test(p)) return /left|_l\b|\.l\b/.test(p) ? 'leftHand' : 'rightHand';
  if (/shoulder|arm/.test(p)) return /left|_l\b|\.l\b/.test(p) ? 'leftShoulder' : 'rightShoulder';
  if (/neck|collar|scarf/.test(p)) return 'neck';
  if (/head|hair|face|eye|brow|mouth|ear|hat/.test(p)) return 'head';
  return 'upperChest';
}
