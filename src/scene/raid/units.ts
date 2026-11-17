// Raid NPC assets + instances: assets/raid/raid_units.glb (13 stylised units on ONE shared skeleton, 7 weapon props,
// one 512² atlas) and assets/raid/raid_anims.json (23 baked clips, int16 quaternions — see
// assets/raid/blender/build_anims.py). Instances are SkeletonUtils clones (geometry shared), drawn with a cel ramp
// MeshToonMaterial (one per instance, so each can fade on its own). Clips are sampled by hand (no AnimationMixer):
// two clips cross-faded, locomotion phase driven by the distance walked (no foot sliding at any speed), plus a tiny
// procedural layer (aim pitch through the spine, recoil kick).
import * as THREE from 'three';
import { skipMatricesWhileHidden } from '../hiddenSkip.ts';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { disposeSkeletons } from '../../avatar/gpuDispose.ts';

const UNITS_URL = new URL('../../../assets/raid/raid_units.glb', import.meta.url).href;
const ANIMS_URL = new URL('../../../assets/raid/raid_anims.json', import.meta.url).href;
/** Extra retargeted clips (Quaternius UAL 1+2 `ual_*`, 100STYLE `style_*`; tools/retarget/retarget.py, see
 *  docs/ANIMATION_LIBRARY.md): same skeleton + format, loaded after the raid's own clips (never blocks a fight), never
 *  replaces one of them. Plans pick clips by name, so they are available as `assets.clips.get('ual_crouch_idle')`. */
const EXTRA_ANIMS_URL = new URL('../../../assets/library/anims/npc/raid_anims_ual.json', import.meta.url).href;
/** Unit packs: extra units built on the same skeleton by `build_units.py --pack <id>` (their own atlas + weapons),
 *  loaded on demand when a room's factions need them (assets/raid/packs/<id>/). `factions` = the raid factions whose units
 *  live in the pack. */
export const RAID_PACKS: { id: string; factions: string[]; units: string; lod0: string; atlas0: string }[] = [
  { id: 'warzone', factions: ['frog', 'militia'],
    units: new URL('../../../assets/raid/packs/warzone/raid_units.glb', import.meta.url).href,
    lod0: new URL('../../../assets/raid/packs/warzone/raid_units_lod0.glb', import.meta.url).href,
    atlas0: new URL('../../../assets/raid/packs/warzone/raid_atlas_lod0.png', import.meta.url).href },
];
export function packOfFaction(f: string) { return RAID_PACKS.find((p) => p.factions.includes(f)) ?? null; }
/** Model units: the characters are built 1.80 m tall. */
export const MODEL_H = 1.8;
/** Metres per locomotion cycle (model units) — matches build_anims.py (stride / stance fraction). */
export const CYCLE: Record<string, number> = { p_walk: 0.64 / 0.6, p_run: 1.1 / 0.4, walk: 0.64 / 0.6, run: 1.15 / 0.38, crouch_walk: 0.56 / 0.62, drag: 0.46 / 0.65, t_sprint: 1.2 / 0.38, t_walk: 0.72 / 0.6, dragged: 0.46 / 0.65 };

export interface Clip {
  name: string; dur: number; loop: boolean; frames: number; fps: number;
  q: Float32Array[]; p: (Float32Array | null)[]; events: Record<string, number>;
}

interface WeaponDef { mesh: THREE.Mesh; offset: THREE.Matrix4; muzzle: THREE.Vector3; atlas: THREE.Texture | null }

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

let ramp: THREE.DataTexture | null = null;
export function toonRamp() {
  if (ramp) return ramp;
  const d = new Uint8Array([120, 120, 130, 255, 205, 205, 210, 255, 255, 255, 255, 255]);
  ramp = new THREE.DataTexture(d, 3, 1, THREE.RGBAFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.needsUpdate = true;
  return ramp;
}

export class RaidAssets {
  private static pending: Promise<RaidAssets> | null = null;
  static load(): Promise<RaidAssets> {
    RaidAssets.pending ??= (async () => {
      const [gltf, anims] = await Promise.all([new GLTFLoader().loadAsync(UNITS_URL), fetch(ANIMS_URL).then((r) => { if (!r.ok) throw new Error(`raid anims ${r.status}`); return r.json(); })]);
      const a = new RaidAssets(gltf.scene, anims);
      void fetch(EXTRA_ANIMS_URL).then((r) => (r.ok ? r.json() : null)).then((x) => { if (x) a.addClips(x); }).catch(() => { /* optional library */ });
      return a;
    })();
    RaidAssets.pending.catch(() => { RaidAssets.pending = null; });
    return RaidAssets.pending;
  }

  readonly templates = new Map<string, THREE.Object3D>();
  readonly weapons = new Map<string, WeaponDef>();
  readonly clips = new Map<string, Clip>();
  readonly boneNames: string[];
  readonly atlas: THREE.Texture | null;
  readonly labels = new Map<string, string>();

  private constructor(scene: THREE.Object3D, anims: { fps: number; bones: string[]; qscale: number; pscale: number; clips: Record<string, { dur: number; loop: boolean; frames: number; q: Record<string, string>; p: Record<string, string>; events: Record<string, number> }> }) {
    this.boneNames = anims.bones.map((b) => b.replace(/[.\s]/g, ''));
    this.atlas = this.parse(scene, this.weapons, null);
    for (const [name, c] of Object.entries(anims.clips)) {
      this.clips.set(name, {
        name, dur: c.dur, loop: c.loop, frames: c.frames, fps: anims.fps, events: c.events ?? {},
        q: anims.bones.map((b) => decode(c.q[b], anims.qscale)),
        p: anims.bones.map((b) => (c.p[b] ? decode(c.p[b], anims.pscale) : null)),
      });
    }
  }

  /** Units + weapons + atlas of one GLB (the base set, or a pack: its weapons go to their own map). Returns the atlas. */
  private parse(scene: THREE.Object3D, weapons: Map<string, WeaponDef>, pack: string | null): THREE.Texture | null {
    scene.updateMatrixWorld(true);
    let atlas: THREE.Texture | null = null;
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !atlas) atlas = ((Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial).map ?? null;
    });
    if (atlas) { (atlas as THREE.Texture).colorSpace = THREE.SRGBColorSpace; (atlas as THREE.Texture).anisotropy = 4; }
    const gun = scene.getObjectByName('Gun');
    const inv = gun ? gun.matrixWorld.clone().invert() : new THREE.Matrix4();
    for (const o of [...scene.children, ...(scene.getObjectByName('RIG')?.children ?? [])]) {
      const m = /^WPN_([a-z0-9_]+)$/.exec(o.name);
      if (!m || !(o as THREE.Mesh).isMesh) continue;
      const mz = o.children.find((c) => /_muzzle$/.test(c.name));
      weapons.set(m[1], { mesh: o as THREE.Mesh, offset: inv.clone().multiply(o.matrixWorld), muzzle: mz ? mz.position.clone() : new THREE.Vector3(0, 0.07, 0.64), atlas });
    }
    const unitIds: string[] = [];
    scene.traverse((o) => { const m = /^UNIT_([a-z0-9_]+)$/.exec(o.name); if (m) { unitIds.push(m[1]); this.labels.set(m[1], String((o.userData as Record<string, unknown>).label ?? m[1])); } });
    for (const id of unitIds) {
      const t = skClone(scene);
      const drop: THREE.Object3D[] = [];
      t.traverse((o) => { if ((/^UNIT_/.test(o.name) && o.name !== `UNIT_${id}`) || /^WPN_/.test(o.name)) drop.push(o); });
      for (const o of drop) o.removeFromParent();
      this.templates.set(id, t);
      if (pack) { this.unitPack.set(id, pack); this.unitAtlas.set(id, atlas); }
    }
    return atlas;
  }

  /** Pack units: which pack a unit came from, its atlas, the pack's weapons. */
  readonly unitPack = new Map<string, string>();
  private unitAtlas = new Map<string, THREE.Texture | null>();
  readonly packWeapons = new Map<string, Map<string, WeaponDef>>();
  private packs = new Map<string, Promise<boolean>>();
  /** Load a unit pack (RAID_PACKS id) once; resolves false when it's missing (the room falls back to the base units). */
  ensurePack(id: string): Promise<boolean> {
    let p = this.packs.get(id);
    if (!p) {
      const def = RAID_PACKS.find((x) => x.id === id);
      p = !def ? Promise.resolve(false) : new GLTFLoader().loadAsync(def.units).then((g) => {
        const w = new Map<string, WeaponDef>();
        this.parse(g.scene, w, id);
        this.packWeapons.set(id, w);
        return true;
      }).catch((e) => { console.warn(`[raid] unit pack ${id} unavailable`, e); return false; });
      this.packs.set(id, p);
    }
    return p;
  }
  packReady(id: string) { return this.packWeapons.has(id); }
  atlasOf(unit: string) { return this.unitAtlas.has(unit) ? this.unitAtlas.get(unit) ?? null : this.atlas; }
  /** A weapon for this unit: its pack's own mesh first (same atlas), else the base set's. */
  weaponFor(unit: string, id: string): WeaponDef | undefined {
    const pk = this.unitPack.get(unit);
    return (pk ? this.packWeapons.get(pk)?.get(id) : undefined) ?? this.weapons.get(id);
  }

  /** Library clips (raid_anims format) — only when the skeleton matches; `cycle` entries join CYCLE. */
  addClips(anims: { fps: number; bones: string[]; qscale: number; pscale: number; cycle?: Record<string, number>; clips: Record<string, { dur: number; loop: boolean; frames: number; q: Record<string, string>; p: Record<string, string>; events?: Record<string, number> }> }) {
    if (anims.bones.map((b) => b.replace(/[.\s]/g, '')).join() !== this.boneNames.join()) { console.warn('[raid] extra clips: skeleton mismatch'); return; }
    for (const [k, v] of Object.entries(anims.cycle ?? {})) CYCLE[k] ??= v;
    for (const [name, c] of Object.entries(anims.clips)) {
      if (this.clips.has(name)) continue;
      this.clips.set(name, {
        name, dur: c.dur, loop: c.loop, frames: c.frames, fps: anims.fps, events: c.events ?? {},
        q: anims.bones.map((b) => decode(c.q[b], anims.qscale)),
        p: anims.bones.map((b) => (c.p[b] ? decode(c.p[b], anims.pscale) : null)),
      });
    }
  }

  unitIds() { return [...this.templates.keys()]; }
}

const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qt = new THREE.Quaternion();
const va = new THREE.Vector3(), vb = new THREE.Vector3();
const XAX = new THREE.Vector3(1, 0, 0), YAX = new THREE.Vector3(0, 1, 0);

function sampleQ(c: Clip, bone: number, t: number, out: THREE.Quaternion) {
  const n = c.frames;
  let f = t * c.fps;
  let i0: number, i1: number;
  if (c.loop) { f = ((f % n) + n) % n; i0 = Math.floor(f); i1 = (i0 + 1) % n; }
  else { f = Math.max(0, Math.min(n - 1, f)); i0 = Math.floor(f); i1 = Math.min(n - 1, i0 + 1); }
  const a = f - i0;
  const q = c.q[bone];
  out.set(q[i0 * 4], q[i0 * 4 + 1], q[i0 * 4 + 2], q[i0 * 4 + 3]);
  if (a > 1e-4) {
    qt.set(q[i1 * 4], q[i1 * 4 + 1], q[i1 * 4 + 2], q[i1 * 4 + 3]);
    if (out.dot(qt) < 0) qt.set(-qt.x, -qt.y, -qt.z, -qt.w);
    out.set(out.x + (qt.x - out.x) * a, out.y + (qt.y - out.y) * a, out.z + (qt.z - out.z) * a, out.w + (qt.w - out.w) * a);
  }
  return out.normalize();
}
function sampleP(c: Clip, bone: number, t: number, out: THREE.Vector3) {
  const p = c.p[bone];
  if (!p) return out.set(0, 0, 0);
  const n = c.frames;
  let f = t * c.fps;
  let i0: number, i1: number;
  if (c.loop) { f = ((f % n) + n) % n; i0 = Math.floor(f); i1 = (i0 + 1) % n; }
  else { f = Math.max(0, Math.min(n - 1, f)); i0 = Math.floor(f); i1 = Math.min(n - 1, i0 + 1); }
  const a = f - i0;
  return out.set(p[i0 * 3] + (p[i1 * 3] - p[i0 * 3]) * a, p[i0 * 3 + 1] + (p[i1 * 3 + 1] - p[i0 * 3 + 1]) * a, p[i0 * 3 + 2] + (p[i1 * 3 + 2] - p[i0 * 3 + 2]) * a);
}

export interface PoseLayer { clip: Clip; t: number }

/** Smoothed "hull" normals (averaged over every vertex sharing a position) for the ink outline — computed once per
 *  unit geometry (clones share it), so hard-edged gear doesn't crack the outline. */
function hullNormals(g: THREE.BufferGeometry) {
  if (g.getAttribute('onormal')) return;
  // baked by build_units.py (glTF _ONORMAL); the in-page fallback below only runs for older assets.
  // (glTF → Blender axes: the attribute is in the mesh's own space, like the normals.)
  const baked = g.getAttribute('_onormal') ?? g.getAttribute('_ONORMAL');
  if (baked) {
    // custom attributes may come through in the exporter's source axes (Z up): detect against the normals and convert
    const nor = g.getAttribute('normal') as THREE.BufferAttribute;
    let dot = 0, dotC = 0;
    const n = Math.min(baked.count, 400);
    for (let i = 0; i < n; i++) {
      dot += baked.getX(i) * nor.getX(i) + baked.getY(i) * nor.getY(i) + baked.getZ(i) * nor.getZ(i);
      dotC += baked.getX(i) * nor.getX(i) + baked.getZ(i) * nor.getY(i) - baked.getY(i) * nor.getZ(i);
    }
    if (dotC > dot) {
      const out = new Float32Array(baked.count * 3);
      for (let i = 0; i < baked.count; i++) { out[i * 3] = baked.getX(i); out[i * 3 + 1] = baked.getZ(i); out[i * 3 + 2] = -baked.getY(i); }
      g.setAttribute('onormal', new THREE.BufferAttribute(out, 3));
    } else g.setAttribute('onormal', baked);
    return;
  }
  const pos = g.getAttribute('position') as THREE.BufferAttribute, nor = g.getAttribute('normal') as THREE.BufferAttribute;
  const acc = new Map<string, [number, number, number]>();
  const key = (i: number) => `${Math.round(pos.getX(i) * 2000)},${Math.round(pos.getY(i) * 2000)},${Math.round(pos.getZ(i) * 2000)}`;
  for (let i = 0; i < pos.count; i++) { const k = key(i); const a = acc.get(k) ?? [0, 0, 0]; a[0] += nor.getX(i); a[1] += nor.getY(i); a[2] += nor.getZ(i); acc.set(k, a); }
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) { const a = acc.get(key(i))!; const l = Math.hypot(a[0], a[1], a[2]) || 1; out[i * 3] = a[0] / l; out[i * 3 + 1] = a[1] / l; out[i * 3 + 2] = a[2] / l; }
  g.setAttribute('onormal', new THREE.BufferAttribute(out, 3));
}

/** Ink outline: back faces pushed out along the hull normals, skinned with the body (one extra draw per NPC). */
function outlineMaterial() {
  const m = new THREE.MeshBasicMaterial({ color: 0x111116, side: THREE.BackSide });
  const u = { outlineW: { value: 0.012 } };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.outlineW = u.outlineW;
    sh.vertexShader = 'attribute vec3 onormal;' + String.fromCharCode(10) + 'uniform float outlineW;' + String.fromCharCode(10) + sh.vertexShader.replace('#include <begin_vertex>', 'vec3 transformed = vec3( position ) + onormal * outlineW;');
  };
  m.customProgramCacheKey = () => 'vtp-raid-outline';
  (m as THREE.MeshBasicMaterial & { outlineW?: { value: number } }).outlineW = u.outlineW;
  return m;
}

/** One NPC on screen. */
export class Npc {
  readonly root = skipMatricesWhileHidden(new THREE.Group());   // (culled = no matrix work: src/scene/hiddenSkip.ts)
  readonly mesh: THREE.SkinnedMesh;
  readonly mat: THREE.MeshToonMaterial;
  readonly bones: (THREE.Bone | null)[];
  private restQ: THREE.Quaternion[];
  private restP: THREE.Vector3[];
  weapon: THREE.Mesh | null = null;
  weaponId = '';
  private wmat: THREE.MeshToonMaterial | null = null;
  /** Ink outline hull (null when switched off). */
  outline: THREE.SkinnedMesh | null = null;
  private outlineMat: (THREE.MeshBasicMaterial & { outlineW?: { value: number } }) | null = null;
  private weaponOffset = new THREE.Matrix4();
  readonly muzzle = new THREE.Vector3();
  private gun: THREE.Bone | null;
  private spine: number; private chest: number; private hips: number; private gunI: number; private headI: number;
  /** Cross-fade state. */
  cur: PoseLayer | null = null;
  /** Optional lower-body layer (hips, spine, legs): e.g. a motion-captured walk under the rifle-holding upper body —
   *  the arms and the weapon both hang off the chest, so the hands stay on the gun whatever the legs do. */
  lower: PoseLayer | null = null;
  private lowerMask: boolean[];
  prev: PoseLayer | null = null;
  w = 1;
  fadeDur = 0.2;
  /** Crossfades start from the pose as it was last shown (a snapshot), so a new state mid-blend never pops. */
  private snapQ: THREE.Quaternion[] = [];
  private snapP: THREE.Vector3[] = [];
  private posed = false;
  opacity = 1;
  visible = true;
  /** Weapon dropped on the floor (world pose) / taken. */
  dropped: { from: THREE.Matrix4; to: THREE.Matrix4; t: number } | null = null;
  constructor(readonly assets: RaidAssets, readonly unit: string, weapon: string, parent: THREE.Object3D) {
    const tmpl = assets.templates.get(unit) ?? assets.templates.values().next().value!;
    const obj = skClone(tmpl);
    let mesh: THREE.SkinnedMesh | null = null;
    obj.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh; });
    this.mesh = mesh!;
    this.mat = new THREE.MeshToonMaterial({ map: assets.atlasOf(unit), gradientMap: toonRamp() });
    this.mat.userData.vtpVariants = { fade: true, unskinned: true };   // (fades; its weapon mesh uses it: programKeep.ts)
    this.mesh.material = this.mat;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false; this.mesh.receiveShadow = false;
    this.root.add(obj);
    this.root.name = `vtp:raid:${unit}`;
    this.root.userData.npc = this;   // graphics quality layer (src/stage/gfx/npcDetail.ts) finds its NPCs by this
    const byName = new Map<string, THREE.Bone>();
    obj.traverse((o) => { if ((o as THREE.Bone).isBone) byName.set(o.name, o as THREE.Bone); });
    this.bones = assets.boneNames.map((n) => byName.get(n) ?? null);
    this.restQ = this.bones.map((b) => (b ? b.quaternion.clone() : new THREE.Quaternion()));
    this.restP = this.bones.map((b) => (b ? b.position.clone() : new THREE.Vector3()));
    const ix = (n: string) => assets.boneNames.indexOf(n);
    this.spine = ix('Spine'); this.chest = ix('Chest'); this.hips = ix('Hips'); this.gunI = ix('Gun'); this.headI = ix('Head');
    this.lowerMask = assets.boneNames.map((n) => /^(Hips|Spine|UpperLeg_[LR]|LowerLeg_[LR]|Foot_[LR])$/.test(n));
    this.gun = this.bones[this.gunI] ?? null;
    this.setWeapon(weapon);
    // ink outline (shares the geometry + skeleton)
    hullNormals(this.mesh.geometry);
    this.outlineMat = outlineMaterial();
    this.outlineMat.userData.vtpVariants = { fade: true };
    this.outline = new THREE.SkinnedMesh(this.mesh.geometry, this.outlineMat);
    this.outline.bind(this.mesh.skeleton, this.mesh.bindMatrix);
    this.outline.frustumCulled = false;
    this.outline.name = 'vtp:raid:outline';
    this.mesh.parent?.add(this.outline);
    this.outline.position.copy(this.mesh.position); this.outline.quaternion.copy(this.mesh.quaternion); this.outline.scale.copy(this.mesh.scale);
    parent.add(this.root);
  }

  setWeapon(id: string) {
    if (this.weaponId === id && this.weapon) return;
    this.weapon?.removeFromParent();
    this.weapon = null;
    this.weaponId = id;
    const w = this.assets.weaponFor(this.unit, id);
    if (!w || !this.gun) return;
    // (a base-set weapon on a pack unit: its own material on the base atlas)
    if (w.atlas !== this.mat.map && !this.wmat) this.wmat = new THREE.MeshToonMaterial({ map: w.atlas, gradientMap: toonRamp() });
    const m = new THREE.Mesh(w.mesh.geometry, w.atlas !== this.mat.map ? this.wmat! : this.mat);
    m.matrixAutoUpdate = false;
    m.matrix.copy(w.offset);
    m.frustumCulled = false;
    this.gun.add(m);
    this.weapon = m;
    this.weaponOffset.copy(w.offset);
    this.dropped = null;
  }

  /** Start a new clip (cross-fade from whatever is showing). */
  play(clip: Clip, t: number, fade = 0.2, lower: PoseLayer | null = null) {
    if (this.cur && this.cur.clip === clip && (this.lower?.clip ?? null) === (lower?.clip ?? null)) {
      this.cur.t = t;
      if (this.lower && lower) this.lower.t = lower.t;
      return;
    }
    this.prev = this.cur && this.posed && fade > 0 ? { clip: this.cur.clip, t: this.cur.t } : null;
    this.cur = { clip, t };
    this.lower = lower ? { clip: lower.clip, t: lower.t } : null;
    this.w = this.prev ? 0 : 1;
    this.fadeDur = fade;
    if (this.prev) this.bones.forEach((b, i) => { if (!b) return; (this.snapQ[i] ??= new THREE.Quaternion()).copy(b.quaternion); (this.snapP[i] ??= new THREE.Vector3()).copy(b.position); });
  }

  /** Pose the skeleton: current clip (and the fading previous one) + aim pitch (rad, + = up) + recoil (0..1). */
  pose(dt: number, aimPitch = 0, recoil = 0, prevT?: number) {
    const c = this.cur;
    if (!c) return;
    if (this.prev) {
      this.w = Math.min(1, this.w + (this.fadeDur > 0 ? dt / this.fadeDur : 1));
      if (prevT !== undefined) this.prev.t = prevT; else if (this.prev.clip.loop) this.prev.t += dt;
      if (this.w >= 1) this.prev = null;
    }
    const k = this.prev ? this.w * this.w * (3 - 2 * this.w) : 1;
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i];
      if (!b) continue;
      const L = this.lower && this.lowerMask[i] ? this.lower : c;
      sampleQ(L.clip, i, L.t, qa);
      b.quaternion.copy(this.restQ[i]).multiply(qa);
      if (this.prev && k < 1 && this.snapQ[i]) b.quaternion.slerp(this.snapQ[i], 1 - k);
      if (L.clip.p[i]) {
        sampleP(L.clip, i, L.t, va);
        b.position.copy(this.restP[i]).add(va.applyQuaternion(this.restQ[i]));
      }
      if (this.prev && k < 1 && this.snapP[i]) b.position.lerp(this.snapP[i], 1 - k);
    }
    this.posed = true;
    // aim pitch through the spine (+ = look up = bend back), recoil kick on the chest
    if (Math.abs(aimPitch) > 1e-3 || recoil > 0) {
      const sp = this.bones[this.spine], ch = this.bones[this.chest];
      if (sp) sp.quaternion.multiply(qt.setFromAxisAngle(XAX, -aimPitch * 0.45));
      if (ch) ch.quaternion.multiply(qt.setFromAxisAngle(XAX, -aimPitch * 0.45 - recoil * 0.07)).multiply(qa.setFromAxisAngle(YAX, recoil * 0.02));
    }
  }

  /** World-space muzzle (after the skeleton has been updated). */
  muzzleWorld(out = this.muzzle) {
    if (!this.weapon) return out.copy(this.root.position).setY(this.root.position.y + 1.3 * this.root.scale.y);
    const w = this.assets.weaponFor(this.unit, this.weaponId);
    this.weapon.updateWorldMatrix(true, false);
    return out.copy(w?.muzzle ?? va.set(0, 0.07, 0.64)).applyMatrix4(this.weapon.matrixWorld);
  }

  chestWorld(out: THREE.Vector3) {
    const b = this.bones[this.chest];
    if (!b) return out.copy(this.root.position).setY(this.root.position.y + 1.25 * this.root.scale.y);
    b.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(b.matrixWorld);
  }
  headWorld(out: THREE.Vector3) {
    const b = this.bones[this.headI];
    if (!b) return out.copy(this.root.position).setY(this.root.position.y + 1.6 * this.root.scale.y);
    b.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(b.matrixWorld);
  }

  /** Let go of the weapon: it falls to the floor next to the body (world pose), animated by update(). */
  drop(floorY: number, yaw: number, seed: number, room: THREE.Object3D) {
    const w = this.weapon;
    if (!w || this.dropped) return;
    w.updateWorldMatrix(true, false);
    const from = w.matrixWorld.clone();
    this.gun?.remove(w);
    room.add(w);
    const p = new THREE.Vector3().setFromMatrixPosition(from);
    const r = ((seed % 1000) / 1000 - 0.5);
    p.x += Math.sin(yaw + r * 2) * 0.35; p.z += Math.cos(yaw + r * 2) * 0.35; p.y = floorY + 0.035 * this.root.scale.y;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw + r * 3, Math.PI / 2, 'YXZ'));
    const s = new THREE.Vector3(); from.decompose(va, qa, s);
    this.dropped = { from, to: new THREE.Matrix4().compose(p, q, s), t: 0 };
  }
  updateDrop(dt: number, snap = false) {
    const d = this.dropped, w = this.weapon;
    if (!d || !w) return;
    d.t = snap ? 1 : Math.min(1, d.t + dt / 0.5);
    const k = d.t * d.t;
    d.from.decompose(va, qa, vb);
    const p1 = new THREE.Vector3(), q1 = new THREE.Quaternion(), s1 = new THREE.Vector3();
    d.to.decompose(p1, q1, s1);
    va.lerp(p1, k); va.y += Math.sin(Math.PI * d.t) * 0.12 * (1 - d.t);
    w.matrix.compose(va, qa.slerp(q1, Math.min(1, d.t * 1.3)), vb);
    w.matrixWorldNeedsUpdate = true;
  }
  hideWeapon() { if (this.weapon) this.weapon.visible = false; }

  /** Outline width from the camera distance (≈ constant on screen), or off. */
  setOutline(on: boolean, camDist: number) {
    if (!this.outline || !this.outlineMat) return;
    this.outline.visible = on && this.opacity > 0.02;
    if (this.outlineMat.outlineW) this.outlineMat.outlineW.value = Math.min(0.05, Math.max(0.008, camDist * 0.0012)) / Math.max(0.3, this.root.scale.x);
  }

  setOpacity(o: number) {
    this.opacity = o;
    const t = o < 0.999;
    if (this.mat.transparent !== t) { this.mat.transparent = t; this.mat.needsUpdate = true; }
    this.mat.opacity = o;
    if (this.outlineMat) {
      if (this.outlineMat.transparent !== t) { this.outlineMat.transparent = t; this.outlineMat.needsUpdate = true; }
      this.outlineMat.opacity = o * o;
      this.outlineMat.depthWrite = o > 0.5;
    }
    this.mat.depthWrite = o > 0.5;
    if (this.wmat) { if (this.wmat.transparent !== t) { this.wmat.transparent = t; this.wmat.needsUpdate = true; } this.wmat.opacity = o; this.wmat.depthWrite = o > 0.5; }
    this.root.visible = this.visible && o > 0.01;
    if (this.weapon && this.dropped) this.weapon.visible = this.root.visible || !!this.dropped;
  }

  dispose() {
    this.root.removeFromParent();
    if (this.dropped) this.weapon?.removeFromParent();
    this.mat.dispose();
    this.wmat?.dispose();
    this.outlineMat?.dispose();
    disposeSkeletons(this.root);   // (the clone's own skeleton, shared with its ink outline: only this frees its bone texture)
  }
}
