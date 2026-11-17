// Town engine — NPC assets + instances: <scene>/town/town_units.glb (23 townsfolk on ONE shared skeleton, held props
// PROP_xx, one 512² atlas) and town_anims.json (15 baked civilian clips, int16 quaternions — built by
// assets/scenes/poe2_kingsmarch/blender/km_units.py + km_anims.py). Same sampler as the raid units (src/scene/raid/units.ts):
// SkeletonUtils clones (geometry shared), cel-ramp MeshToonMaterial per instance (own fade), two clips cross-faded,
// locomotion phase driven by distance walked (no foot sliding), props on the `Gun` socket bone.
import * as THREE from 'three';
import { skipMatricesWhileHidden } from '../hiddenSkip.ts';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { disposeSkeletons } from '../../avatar/gpuDispose.ts';

export const MODEL_H = 1.8;
/** props held in the right fist (they follow the hand bone) — the rest sit on the chest-anchored `Gun` socket */
const HAND_PROPS = new Set(['hammer', 'tankard', 'torch', 'lantern', 'rod', 'bread', 'flute', 'bottle']);   // (+ flute / bottle: the yacht crew, sc_890jump)
/** Extra retargeted clips (Quaternius UAL 1+2 `ual_*`, 100STYLE walks / idles `style_*`) — tools/retarget/retarget.py,
 *  see docs/ANIMATION_LIBRARY.md. Loaded after the room's own clips (never blocks the town); same format + skeleton. */
const EXTRA_ANIMS_URL = new URL('../../../assets/library/anims/npc/town_anims_ual.json', import.meta.url).href;
/** Render-time clip variety: a plan's clip name → alternatives (only those loaded are used; walks only with a similar
 *  stride, so feet never skate). Picked deterministically per NPC / segment, so every page shows the same choice. */
const VARIANTS: Record<string, string[]> = {
  idle: ['idle', 'ual_idle', 'ual_idle_fold_arms', 'style_neutral_idle', 'style_hands_in_pockets_idle', 'style_arms_behind_back_idle', 'style_heavyset_idle', 'style_proud_idle', 'style_old_idle'],
  talk: ['talk', 'ual_idle_talking'],
  browse: ['browse', 'ual_interact', 'browse'],
  walk: ['walk', 'style_neutral_walk', 'style_proud_walk', 'style_hands_in_pockets_walk', 'style_heavyset_walk', 'style_arms_behind_back_walk', 'style_strutting_walk', 'style_depressed_walk', 'ual_walk_formal', 'style_old_walk', 'style_rushed_walk', 'ual_walk'],
};

export interface TownClip {
  name: string; dur: number; loop: boolean; frames: number; fps: number; prop: string | null;
  q: Float32Array[]; p: (Float32Array | null)[];
}

function decode(b64: string, scale: number): Float32Array {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v & 0x8000) v -= 0x10000;
    out[i] = v / scale;
  }
  return out;
}

let outlineMat: THREE.MeshBasicMaterial | null = null;
/** inverted-hull ink outline for the cel look (shared material; pushed out along the skinned normal). */
function inkMaterial() {
  if (outlineMat) return outlineMat;
  outlineMat = new THREE.MeshBasicMaterial({ color: 0x0d0b0a, side: THREE.BackSide });
  outlineMat.name = 'vtp:town:npcInk';
  outlineMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed += normalize(objectNormal) * 0.014;');
  };
  return outlineMat;
}

let ramp: THREE.DataTexture | null = null;
function toonRamp() {
  if (ramp) return ramp;
  const d = new Uint8Array([118, 118, 128, 255, 200, 200, 208, 255, 255, 255, 255, 255]);
  ramp = new THREE.DataTexture(d, 3, 1, THREE.RGBAFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.needsUpdate = true;
  return ramp;
}

type AnimJson = { fps: number; bones: string[]; qscale: number; pscale: number; cycle?: Record<string, number>;
  clips: Record<string, { dur: number; loop: boolean; frames: number; q: Record<string, string>; p: Record<string, string>; prop?: string | null }> };

export class TownAssets {
  private static pending = new Map<string, Promise<TownAssets>>();
  static load(unitsUrl: string, animsUrl: string): Promise<TownAssets> {
    const key = unitsUrl + '|' + animsUrl;
    let p = TownAssets.pending.get(key);
    if (!p) {
      p = (async () => {
        const [gltf, anims] = await Promise.all([new GLTFLoader().loadAsync(unitsUrl), fetch(animsUrl).then((r) => { if (!r.ok) throw new Error(`town anims ${r.status}`); return r.json() as Promise<AnimJson>; })]);
        const a = new TownAssets(gltf.scene, anims);
        void fetch(EXTRA_ANIMS_URL).then((r) => (r.ok ? r.json() as Promise<AnimJson> : null)).then((x) => { if (x) a.addClips(x, false); }).catch(() => { /* optional library */ });
        return a;
      })();
      p.catch(() => TownAssets.pending.delete(key));
      TownAssets.pending.set(key, p);
    }
    return p;
  }

  readonly templates = new Map<string, THREE.Object3D>();
  readonly props = new Map<string, { geo: THREE.BufferGeometry; offset: THREE.Matrix4; hand: boolean }>();
  readonly clips = new Map<string, TownClip>();
  readonly boneNames: string[];
  readonly atlas: THREE.Texture | null;
  readonly labels = new Map<string, string>();
  readonly unitProp = new Map<string, string>();
  readonly cycle: Record<string, number>;

  private constructor(scene: THREE.Object3D, anims: AnimJson) {
    scene.updateMatrixWorld(true);
    this.boneNames = anims.bones.map((b) => b.replace(/[.\s]/g, ''));
    this.cycle = anims.cycle ?? { walk: 1.03 };
    let atlas: THREE.Texture | null = null;
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !atlas) atlas = ((Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial).map ?? null;
    });
    this.atlas = atlas;
    if (this.atlas) { (this.atlas as THREE.Texture).colorSpace = THREE.SRGBColorSpace; (this.atlas as THREE.Texture).anisotropy = 4; }
    const gun = scene.getObjectByName('Gun');
    const inv = gun ? gun.matrixWorld.clone().invert() : new THREE.Matrix4();
    const hand = scene.getObjectByName('Hand_R');
    // a fist grip: the prop's up axis (its handle) runs forward through the fist, at the palm of the rest T-pose
    const grip = new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(-0.765, 1.42, 0.0);
    const handOff = hand ? hand.matrixWorld.clone().invert().multiply(grip) : null;
    const all: THREE.Object3D[] = [];
    scene.traverse((o) => all.push(o));
    for (const o of all) {
      const m = /^PROP_([a-z0-9_]+)$/.exec(o.name);
      if (!m || !(o as THREE.Mesh).isMesh) continue;
      const inHand = HAND_PROPS.has(m[1]) && !!handOff;
      // hand props: the geometry is authored around the socket origin, so re-anchor it at the grip
      const local = inv.clone().multiply(o.matrixWorld);
      this.props.set(m[1], { geo: (o as THREE.Mesh).geometry, offset: inHand ? handOff!.clone() : local, hand: inHand });
    }
    const unitIds: string[] = [];
    for (const o of all) {
      const m = /^UNIT_([a-z0-9_]+)$/.exec(o.name);
      if (!m || /_LOD\d$/.test(m[1])) continue;
      unitIds.push(m[1]);
      const ud = o.userData as Record<string, unknown>;
      this.labels.set(m[1], String(ud.label ?? m[1]));
      if (typeof ud.prop === 'string') this.unitProp.set(m[1], ud.prop);
    }
    for (const id of unitIds) {
      const t = skClone(scene);
      const drop: THREE.Object3D[] = [];
      t.traverse((o) => { if ((/^UNIT_/.test(o.name) && o.name !== `UNIT_${id}` && o.name !== `UNIT_${id}_LOD1` && o.name !== `UNIT_${id}_LOD2`) || /^PROP_/.test(o.name)) drop.push(o); });
      for (const o of drop) o.removeFromParent();
      this.templates.set(id, t);
    }
    this.addClips(anims, true);
  }

  /** Clips from a town_anims-format file (the room's own, or the retargeted library: never overrides a room clip). */
  addClips(anims: AnimJson, own: boolean) {
    if (!own && anims.bones.map((b) => b.replace(/[.\s]/g, '')).join() !== this.boneNames.join()) { console.warn('[town] extra clips: skeleton mismatch'); return; }
    if (!own) for (const [k, v] of Object.entries(anims.cycle ?? {})) this.cycle[k] ??= v;
    for (const [name, c] of Object.entries(anims.clips)) {
      if (!own && this.clips.has(name)) continue;
      this.clips.set(name, {
        name, dur: c.dur, loop: c.loop, frames: c.frames, fps: anims.fps, prop: c.prop ?? null,
        q: anims.bones.map((b) => decode(c.q[b], anims.qscale)),
        p: anims.bones.map((b) => (c.p[b] ? decode(c.p[b], anims.pscale) : null)),
      });
    }
  }

  /** The clip an NPC actually plays for a plan clip (see VARIANTS); `key` = a stable per-NPC / per-segment number. */
  variant(name: string, key: number, walkCycle: number): string {
    const v = VARIANTS[name];
    if (!v) return name;
    const ok = v.filter((n) => this.clips.has(n) && (name !== 'walk' || n === 'walk' || ((this.cycle[n] ?? 0) > walkCycle * 0.8 && (this.cycle[n] ?? 0) < walkCycle * 1.45)));
    if (ok.length < 2) return name;
    let h = (key * 2654435761) >>> 0; h ^= h >>> 15;
    return ok[h % ok.length];
  }
}

const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qt = new THREE.Quaternion();
const va = new THREE.Vector3(), vb = new THREE.Vector3();
const lq0 = new THREE.Quaternion(), lq1 = new THREE.Quaternion(), lq2 = new THREE.Quaternion(), lq3 = new THREE.Quaternion(), lq4 = new THREE.Quaternion();
const lv0 = new THREE.Vector3(), le = new THREE.Euler();

function frameAt(c: TownClip, t: number) {
  const n = c.frames;
  let f = t * c.fps;
  let i0: number, i1: number;
  if (c.loop) { f = ((f % n) + n) % n; i0 = Math.floor(f); i1 = (i0 + 1) % n; } else { f = Math.max(0, Math.min(n - 1, f)); i0 = Math.floor(f); i1 = Math.min(n - 1, i0 + 1); }
  return [i0, i1, f - i0] as const;
}
function sampleQ(c: TownClip, bone: number, t: number, out: THREE.Quaternion) {
  const [i0, i1, a] = frameAt(c, t);
  const q = c.q[bone];
  out.set(q[i0 * 4], q[i0 * 4 + 1], q[i0 * 4 + 2], q[i0 * 4 + 3]);
  if (a > 1e-4) {
    qt.set(q[i1 * 4], q[i1 * 4 + 1], q[i1 * 4 + 2], q[i1 * 4 + 3]);
    if (out.dot(qt) < 0) qt.set(-qt.x, -qt.y, -qt.z, -qt.w);
    out.set(out.x + (qt.x - out.x) * a, out.y + (qt.y - out.y) * a, out.z + (qt.z - out.z) * a, out.w + (qt.w - out.w) * a);
  }
  return out.normalize();
}
function sampleP(c: TownClip, bone: number, t: number, out: THREE.Vector3) {
  const p = c.p[bone];
  if (!p) return out.set(0, 0, 0);
  const [i0, i1, a] = frameAt(c, t);
  return out.set(p[i0 * 3] + (p[i1 * 3] - p[i0 * 3]) * a, p[i0 * 3 + 1] + (p[i1 * 3 + 1] - p[i0 * 3 + 1]) * a, p[i0 * 3 + 2] + (p[i1 * 3 + 2] - p[i0 * 3 + 2]) * a);
}

/** One townsperson on screen. */
export class TownNpc {
  readonly root = skipMatricesWhileHidden(new THREE.Group());   // (culled = no matrix work: src/scene/hiddenSkip.ts)
  readonly mesh: THREE.SkinnedMesh;
  /** the decimated LOD1 (distant NPCs / cheaper tiers), if the asset has one */
  readonly lod1: THREE.SkinnedMesh | null = null;
  /** a far LOD2 (≈600 tris), if the asset has one */
  readonly lod2: THREE.SkinnedMesh | null = null;
  lod = 0;
  readonly mat: THREE.MeshToonMaterial;
  private bones: (THREE.Bone | null)[];
  private restQ: THREE.Quaternion[];
  private restP: THREE.Vector3[];
  private gun: THREE.Bone | null;
  private hand: THREE.Bone | null;
  private headI: number;
  private neckI: number;
  private props = new Map<string, THREE.Mesh>();
  /** ink outline of the LOD0 mesh (hidden at LOD1 and while fading) */
  readonly ink: THREE.SkinnedMesh;
  opacity = 1;

  constructor(readonly assets: TownAssets, readonly unit: string, parent: THREE.Object3D) {
    const tmpl = assets.templates.get(unit) ?? assets.templates.values().next().value!;
    const obj = skClone(tmpl);
    let mesh: THREE.SkinnedMesh | null = null, lod1: THREE.SkinnedMesh | null = null, lod2: THREE.SkinnedMesh | null = null;
    obj.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) { if (/_LOD1$/.test(o.name)) lod1 = o as THREE.SkinnedMesh; else if (/_LOD2$/.test(o.name)) lod2 = o as THREE.SkinnedMesh; else mesh = o as THREE.SkinnedMesh; } });
    this.mesh = mesh!;
    this.lod1 = lod1;
    this.lod2 = lod2;
    this.mat = new THREE.MeshToonMaterial({ map: assets.atlas, gradientMap: toonRamp() });
    this.mat.name = 'vtp:town:npc';
    // (it fades — transparent — and its held props use it on plain meshes: both warmed with the room, programKeep.ts)
    this.mat.userData.vtpVariants = { fade: true, unskinned: true };
    this.mesh.material = this.mat;
    this.mesh.frustumCulled = false;
    for (const l of [this.lod1, this.lod2] as (THREE.SkinnedMesh | null)[]) if (l) { l.material = this.mat; l.frustumCulled = false; l.visible = false; }
    this.ink = new THREE.SkinnedMesh(this.mesh.geometry, inkMaterial());
    this.ink.bind(this.mesh.skeleton, this.mesh.bindMatrix);
    this.ink.frustumCulled = false;
    this.ink.name = 'vtp:town:ink';
    this.mesh.parent?.add(this.ink);
    this.root.add(obj);
    this.root.name = `vtp:town:${unit}`;
    const byName = new Map<string, THREE.Bone>();
    obj.traverse((o) => { if ((o as THREE.Bone).isBone) byName.set(o.name, o as THREE.Bone); });
    this.bones = assets.boneNames.map((n) => byName.get(n) ?? null);
    this.restQ = this.bones.map((b) => (b ? b.quaternion.clone() : new THREE.Quaternion()));
    this.restP = this.bones.map((b) => (b ? b.position.clone() : new THREE.Vector3()));
    this.gun = this.bones[assets.boneNames.indexOf('Gun')] ?? null;
    this.hand = this.bones[assets.boneNames.indexOf('Hand_R')] ?? null;
    this.headI = assets.boneNames.indexOf('Head');
    this.neckI = assets.boneNames.indexOf('Neck');
    parent.add(this.root);
  }

  /** 0 = full mesh, 1 = the decimated LOD1, 2 = the far LOD2 (same skeleton, so switching is free) */
  setLod(l: number) {
    let want = l >= 2 && this.lod2 ? 2 : l >= 1 && this.lod1 ? 1 : 0;
    if (want === 2 && !this.lod2) want = this.lod1 ? 1 : 0;
    if (want === this.lod) return;
    this.lod = want;
    this.mesh.visible = want === 0;
    this.ink.visible = want === 0 && this.opacity > 0.98 && this.inkOn;
    if (this.lod1) this.lod1.visible = want === 1;
    if (this.lod2) this.lod2.visible = want === 2;
  }

  private inkOn = true;
  /** ink outline only near the camera (it doubles the skinned vertex work) */
  setInk(on: boolean) {
    if (on === this.inkOn) return;
    this.inkOn = on;
    this.ink.visible = on && this.lod === 0 && this.opacity > 0.98;
  }

  /** show exactly one held prop (or none) */
  setProp(id: string | null) {
    for (const [k, m] of this.props) m.visible = k === id;
    if (!id || this.props.has(id) || !this.gun) return;
    const p = this.assets.props.get(id);
    if (!p) return;
    const bone = p.hand && this.hand ? this.hand : this.gun;
    const m = new THREE.Mesh(p.geo, this.mat);
    m.matrixAutoUpdate = false;
    m.matrix.copy(p.offset);
    m.frustumCulled = false;
    bone.add(m);
    this.props.set(id, m);
  }

  /** Pose: clip A at time ta, blended towards clip B at tb with weight w (0 = all A). */
  pose(a: TownClip, ta: number, b: TownClip | null, tb: number, w: number) {
    const k = b ? w * w * (3 - 2 * w) : 0;
    for (let i = 0; i < this.bones.length; i++) {
      const bn = this.bones[i];
      if (!bn) continue;
      sampleQ(a, i, ta, qa);
      if (b && k > 0.001) { sampleQ(b, i, tb, qb); if (qb.dot(qa) < 0) qb.set(-qb.x, -qb.y, -qb.z, -qb.w); qa.slerp(qb, k); }
      bn.quaternion.copy(this.restQ[i]).multiply(qa);
      if (a.p[i] || (b && b.p[i])) {
        sampleP(a, i, ta, va);
        if (b && k > 0.001) { sampleP(b, i, tb, vb); va.lerp(vb, k); }
        bn.position.copy(this.restP[i]).add(va.applyQuaternion(this.restQ[i]));
      }
    }
  }

  /** Turn the head (60 %) + neck (40 %) towards a world point, on top of the posed clip (w = 0..1, limited to ±75° yaw,
   *  ±30° pitch; nothing when the point is behind). Call right after pose(). */
  lookAt(target: THREE.Vector3, w: number) {
    const head = this.bones[this.headI], neck = this.bones[this.neckI];
    if (!head || !neck || !neck.parent || w < 0.01) return;
    this.root.updateMatrixWorld(true);
    this.root.getWorldQuaternion(lq0);
    lq1.copy(lq0).invert();
    head.getWorldPosition(lv0);
    lv0.subVectors(target, lv0).applyQuaternion(lq1);
    const yaw = Math.atan2(lv0.x, lv0.z);
    if (Math.abs(yaw) > 2.0) return;
    const pitch = Math.atan2(lv0.y, Math.hypot(lv0.x, lv0.z));
    const k = w * THREE.MathUtils.smoothstep(2.0 - Math.abs(yaw), 0, 0.5);
    const cy = THREE.MathUtils.clamp(yaw, -1.3, 1.3) * k, cp = THREE.MathUtils.clamp(pitch, -0.5, 0.5) * k;
    for (const [b, f] of [[neck, 0.4], [head, 0.6]] as const) {
      le.set(-cp * f, cy * f, 0, 'YXZ');
      lq2.setFromEuler(le);
      lq2.premultiply(lq0).multiply(lq1);            // root-space delta -> world-space delta
      b.getWorldQuaternion(lq3);
      b.parent!.getWorldQuaternion(lq4);
      b.quaternion.copy(lq4.invert().multiply(lq2.multiply(lq3)));
      b.updateMatrixWorld(true);
    }
  }

  headWorld(out: THREE.Vector3) {
    const b = this.bones[this.headI];
    if (!b) return out.copy(this.root.position).setY(this.root.position.y + 1.6 * this.root.scale.y);
    b.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(b.matrixWorld);
  }

  setOpacity(o: number) {
    this.opacity = o;
    const t = o < 0.999;
    if (this.mat.transparent !== t) { this.mat.transparent = t; this.mat.needsUpdate = true; }
    this.mat.opacity = o;
    this.mat.depthWrite = o > 0.5;
    this.ink.visible = this.lod === 0 && o > 0.98 && this.inkOn;
    this.root.visible = o > 0.01;
  }

  dispose() {
    this.root.removeFromParent(); this.mat.dispose();
    disposeSkeletons(this.root);   // (the clone's own skeleton(s), shared with the ink outline: only this frees their bone textures)
  }
}
