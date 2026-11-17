// Background NPC detail by quality level — layered ON TOP of the raid engine (src/scene/raid/*), which keeps planning,
// posing and fading its NPCs exactly as before (every page still shows the same fight). Runs after RaidScene.update,
// before the render.
//   High / Ultra, within gfxBudget().npcDetailDist (11 / 20 m):
//     · LOD0 body: assets/raid/raid_units_lod0.glb (same skeleton + DGL_* dangle bones; 2–3× the geometry: real fingers,
//       rounder heads / helmets / gear, bevelled boxes) with the 2K cel atlas raid_atlas_lod0.png (its alpha = specular
//       mask), bound to the NPC's own bones — the old mesh (LOD1) hides; weapons swap to their LOD0 geometry.
//     · coloured ink outline (the surface colour darkened, not flat black), constant ~1.4 px on screen.
//     · secondary motion: straps / belt tails / antennas / Tagilla's tied sleeves swing on springs, rifle slings hang
//       from the chest to the stock and follow the weapon.
//     · planted feet: while standing / aiming / reloading the feet lock to the floor (two-bone leg IK); turning in
//       place becomes small steps instead of sliding. Pops (instant pose jumps) are inertialised out over 0.2 s.
//     · toon+ shading on every NPC (rim, gear highlights, tinted ramp).
//   Performance, beyond gfxBudget().impostorDist (13 m): far NPCs become IMPOSTORS — a camera-facing card re-rendered
//     from the real NPC ~10–15× a second into a shared 1024² atlas (16 slots): one instanced draw for all of them.
//   Balanced: nothing (today's NPCs).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GfxLevel } from '../../../shared/graphics.ts';
import type { Stage } from '../Stage.ts';
import { gfxBudget } from './lod.ts';
import { patchToon, tintedRamp } from './toonPlus.ts';
import { RAID_PACKS } from '../../scene/raid/units.ts';

const LOD0_URL = new URL('../../../assets/raid/raid_units_lod0.glb', import.meta.url).href;
const ATLAS0_URL = new URL('../../../assets/raid/raid_atlas_lod0.png', import.meta.url).href;

/** The parts of src/scene/raid/units.ts Npc this layer reads (structural — no import of the raid engine's internals). */
interface NpcLike {
  root: THREE.Group; mesh: THREE.SkinnedMesh; mat: THREE.MeshToonMaterial; bones: (THREE.Bone | null)[];
  weapon: THREE.Mesh | null; weaponId: string; outline: THREE.SkinnedMesh | null; opacity: number; visible: boolean;
  cur: { clip: { name: string }; t: number } | null; unit: string; assets: { boneNames: string[]; unitPack?: Map<string, string> };
  dropped: unknown;
}

interface UnitTmpl { geometry: THREE.BufferGeometry; boneNames: string[]; boneParents: (string | null)[]; restLocal: THREE.Matrix4[]; inverses: THREE.Matrix4[]; bindMatrix: THREE.Matrix4; local: THREE.Matrix4 }
interface Lod0Assets { units: Map<string, UnitTmpl>; weapons: Map<string, THREE.BufferGeometry>; atlas: THREE.Texture; tris: Record<string, number> }

/** Static clips: feet stay planted (locomotion clips plant their feet by their own distance-driven phase). */
const STATIC = /^(idle|aim|aim_crouch|crouch_idle|peek_[LR]|reload|scan|loot|t_idle|t_taunt|p_idle|p_aim|p_crouch|p_aim_crouch|throw|hit)$/;

function hull(g: THREE.BufferGeometry) {
  if (g.getAttribute('onormal')) return;
  const baked = g.getAttribute('_onormal') ?? g.getAttribute('_ONORMAL');
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  if (baked) {
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
  g.setAttribute('onormal', nor);
}

function inkMaterial(atlas: THREE.Texture) {
  const m = new THREE.MeshBasicMaterial({ map: atlas, color: new THREE.Color(0.16, 0.15, 0.2), side: THREE.BackSide });
  const w = { value: 0.01 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.outlineW = w;
    sh.vertexShader = 'attribute vec3 onormal;\nuniform float outlineW;\n' + sh.vertexShader.replace('#include <begin_vertex>', 'vec3 transformed = vec3( position ) + onormal * outlineW;');
    // ink = the surface colour, darkened and a touch more saturated (anime colour lines)
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb = pow(diffuseColor.rgb, vec3(1.3));\n  diffuseColor.a = opacity;');   // (atlas alpha = specular mask, not coverage)
  };
  m.customProgramCacheKey = () => 'vtp-npc-ink0';
  (m.userData as { w: { value: number } }).w = w;
  return m;
}

/** One LOD0 set: units (skinned geometry + rig data), weapons, the 2K atlas. */
async function loadLod0(glb: string, atlasUrl: string): Promise<Lod0Assets> {
  const [gltf, atlas] = await Promise.all([new GLTFLoader().loadAsync(glb), new THREE.TextureLoader().loadAsync(atlasUrl)]);
  atlas.flipY = false; atlas.colorSpace = THREE.SRGBColorSpace; atlas.anisotropy = 8; atlas.needsUpdate = true;
  const units = new Map<string, UnitTmpl>(), weapons = new Map<string, THREE.BufferGeometry>(), tris: Record<string, number> = {};
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    const mu = /^UNIT_([a-z0-9_]+)$/.exec(o.name) ?? (o.parent ? /^UNIT_([a-z0-9_]+)$/.exec(o.parent.name) : null);
    if (sm.isSkinnedMesh && mu && !units.has(mu[1])) {
      hull(sm.geometry);
      const bones = sm.skeleton.bones;
      units.set(mu[1], {
        geometry: sm.geometry, boneNames: bones.map((b) => b.name), boneParents: bones.map((b) => ((b.parent as THREE.Bone)?.isBone ? b.parent!.name : null)),
        restLocal: bones.map((b) => b.matrix.clone()), inverses: sm.skeleton.boneInverses.map((m) => m.clone()), bindMatrix: sm.bindMatrix.clone(), local: sm.matrix.clone(),
      });
      tris[mu[1]] = (sm.geometry.index ? sm.geometry.index.count : sm.geometry.getAttribute('position').count) / 3;
    }
    const mw = /^WPN_([a-z0-9_]+)$/.exec(o.name);
    if (mw && (o as THREE.Mesh).isMesh) weapons.set(mw[1], (o as THREE.Mesh).geometry);
  });
  return { units, weapons, atlas, tris };
}

// ---------------------------------------------------------------- small IK / bone helpers
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _b2 = new THREE.Vector2();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
function worldPos(b: THREE.Object3D, out: THREE.Vector3) { return out.setFromMatrixPosition(b.matrixWorld); }
/** Rotate a bone so the world direction `from` turns into `to` (both from the bone's head), weight k. */
function turnBone(b: THREE.Bone, from: THREE.Vector3, to: THREE.Vector3, k = 1) {
  if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return;
  _q.setFromUnitVectors(_v3.copy(from).normalize(), _v4.copy(to).normalize());
  if (k < 1) _q.slerp(_q2.identity(), 1 - k);
  b.getWorldQuaternion(_q2);
  const pw = b.parent ? b.parent.getWorldQuaternion(_q3) : _q3.identity();
  b.quaternion.copy(pw.invert().multiply(_q.multiply(_q2)));
  b.updateMatrixWorld(true);
}

interface FootState { lock: THREE.Vector3 | null; step: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null }
interface Chain { bones: THREE.Bone[]; len: number[]; tip: THREE.Vector3[]; prev: THREE.Vector3[]; sling: boolean; init: boolean; stiff: number; grav: number }

interface Rec {
  npc: NpcLike;
  toon: boolean;
  lod0: THREE.SkinnedMesh | null; ink: THREE.SkinnedMesh | null; mat0: THREE.MeshToonMaterial | null; inkMat: THREE.MeshBasicMaterial | null;
  showing0: boolean;
  weaponGeo: THREE.BufferGeometry | null; weaponGeo0: THREE.BufferGeometry | null;
  chains: Chain[];
  feet: [FootState, FootState]; ik: number;
  animQ: THREE.Quaternion[]; outQ: THREE.Quaternion[]; pop: { off: THREE.Quaternion; t: number }[];
  ramp0: THREE.Texture | null;
  imp: number;          // impostor slot (-1 = none)
  impAt: number;
}

export class NpcDetail {
  private root: THREE.Object3D | null = null;
  private recs = new Map<NpcLike, Rec>();
  private assets: Lod0Assets | null = null;
  private loading: Promise<void> | null = null;
  private failed = false;
  private level: GfxLevel = 'balanced';
  private detail = false;
  private toon = false;
  private built = 0;
  private cost = 0;
  private stats = { npcs: 0, lod0: 0, lod1: 0, impostors: 0, planted: 0, chains: 0 };
  // impostors
  private impRT: THREE.WebGLRenderTarget | null = null;
  private impMesh: THREE.InstancedMesh | null = null;
  private impCam = new THREE.PerspectiveCamera(20, 1, 0.1, 500);
  private impSlots: (Rec | null)[] = new Array(16).fill(null);
  private impNext = 0;
  private lightsTagged = 0;
  /** Impostor captures render ONE NPC in its own tiny scene (lit like the stage) — a full-scene pass per capture costs more than it saves. */
  private impScene = new THREE.Scene();
  private impHemi = new THREE.HemisphereLight();
  private impKey = new THREE.DirectionalLight();
  /** Ink outline width in screen pixels (debug / tuning). */
  inkPx = 3.2;

  constructor(private stage: Stage) { this.impScene.add(this.impHemi, this.impKey, this.impKey.target); }

  bind(root: THREE.Object3D) { this.root = root; }
  unbind() {
    for (const r of this.recs.values()) this.release(r, true);
    this.recs.clear();
    this.impMesh?.removeFromParent();
    this.root = null;
  }

  setLevel(level: GfxLevel, detail: boolean, toon: boolean) {
    this.level = level; this.detail = detail; this.toon = toon;
    if (detail) this.preload();
    for (const r of this.recs.values()) this.applyToon(r);
    if (level !== 'performance') for (const r of this.recs.values()) this.dropImpostor(r);
  }

  /** Load the LOD0 assets (and compile their shaders) ahead of use. */
  preload() {
    if (this.assets || this.loading || this.failed) return;
    this.loading = (async () => {
      try {
        this.assets = await loadLod0(LOD0_URL, ATLAS0_URL);
        this.warm();
      } catch (e) { this.failed = true; console.warn('gfx: raid LOD0 assets unavailable (NPC detail uses today\'s meshes)', e); }
      finally { this.loading = null; }
    })();
  }

  /** Compile the LOD0 body + ink programs once (a hidden mesh drawn through renderer.compile). */
  private warm() {
    const A = this.assets, st = this.stage;
    if (!A || !this.root) return;
    const u = A.units.values().next().value as UnitTmpl | undefined;
    if (!u) return;
    const holder = new THREE.Group();
    holder.position.set(0, -500, 0);
    const bones = u.boneNames.map(() => new THREE.Bone());
    bones.forEach((b, i) => { b.matrix.copy(u.restLocal[i]); b.matrix.decompose(b.position, b.quaternion, b.scale); const p = u.boneParents[i]; const pi = p ? u.boneNames.indexOf(p) : -1; (pi >= 0 ? bones[pi] : holder).add(b); });
    const sk = new THREE.Skeleton(bones, u.inverses);
    const mat = this.bodyMaterial();
    const m = new THREE.SkinnedMesh(u.geometry, mat); m.bind(sk, u.bindMatrix); m.frustumCulled = false;
    const ink = new THREE.SkinnedMesh(u.geometry, inkMaterial(A.atlas)); ink.bind(sk, u.bindMatrix); ink.frustumCulled = false;
    holder.add(m, ink);
    this.root.add(holder);
    try { st.renderer.compile(holder, st.camera, st.scene); } catch { /* optional */ }
    holder.removeFromParent();
    mat.dispose(); (ink.material as THREE.Material).dispose();
  }

  /** Unit packs' LOD0 sets (assets/raid/packs/<id>/raid_units_lod0.glb), loaded the first time one of their NPCs shows. */
  private packs0 = new Map<string, Lod0Assets | 'loading' | 'failed'>();
  /** The LOD0 set an NPC's unit lives in (null = not loaded yet / none). */
  private lod(npc: NpcLike): Lod0Assets | null {
    const pk = npc.assets.unitPack?.get(npc.unit);
    if (!pk) return this.assets;
    const got = this.packs0.get(pk);
    if (got === undefined) {
      const def = RAID_PACKS.find((p) => p.id === pk);
      this.packs0.set(pk, def ? 'loading' : 'failed');
      if (def) loadLod0(def.lod0, def.atlas0).then((a) => { this.packs0.set(pk, a); }).catch((e) => { this.packs0.set(pk, 'failed'); console.warn(`gfx: raid pack ${pk} LOD0 unavailable`, e); });
      return null;
    }
    return typeof got === 'string' ? null : got;
  }

  private bodyMaterial(atlas: THREE.Texture = this.assets!.atlas) {
    const m = new THREE.MeshToonMaterial({ map: atlas, gradientMap: tintedRamp() });
    patchToon(m, 0.55, 1, true);
    return m;
  }

  // ---------------------------------------------------------------- per frame
  update(dt: number, cam: THREE.PerspectiveCamera) {
    const root = this.root;
    if (!root) return;
    const t0 = performance.now();
    const B = gfxBudget();
    const st = { npcs: 0, lod0: 0, lod1: 0, impostors: 0, planted: 0, chains: 0 };
    const live = new Set<NpcLike>();
    for (const o of root.children) {
      const npc = (o.userData as { npc?: NpcLike }).npc;
      if (!npc || !o.name.startsWith('vtp:raid:')) continue;
      live.add(npc);
      let r = this.recs.get(npc);
      if (!r) { r = this.newRec(npc); this.recs.set(npc, r); }
      if (!npc.root.visible) { if (r.showing0) this.show0(r, false); this.dropImpostor(r); continue; }
      st.npcs++;
      const dist = cam.position.distanceTo(npc.root.position);
      // ---- LOD0 swap (hysteresis 10 %)
      const want0 = this.detail && !!this.lod(npc) && B.npcDetailDist > 0 && dist < B.npcDetailDist * (r.showing0 ? 1.1 : 1);
      if (want0 && !r.lod0 && this.built < 1) this.build0(r);
      this.show0(r, want0 && !!r.lod0);
      if (r.showing0) { st.lod0++; this.sync0(r, dist, cam); } else st.lod1++;
      // ---- motion layer (close NPCs at High / Ultra)
      if (this.detail && dist < Math.max(8, B.npcDetailDist * 1.2)) {
        this.motion(r, dt);
        if (r.ik > 0.01) st.planted++;
        st.chains += r.showing0 ? r.chains.length : 0;
      }
      // ---- impostors (Performance)
      if (this.level === 'performance' && dist > B.impostorDist && !npc.dropped) this.useImpostor(r); else this.dropImpostor(r);
      if (r.imp >= 0) st.impostors++;
    }
    for (const [npc, r] of this.recs) if (!live.has(npc)) { this.release(r, false); this.recs.delete(npc); }
    this.built = 0;
    this.drawImpostors(cam);
    this.stats = st;
    this.cost += (performance.now() - t0 - this.cost) * 0.05;
  }

  private newRec(npc: NpcLike): Rec {
    const r: Rec = {
      npc, toon: false, lod0: null, ink: null, mat0: null, inkMat: null, showing0: false, weaponGeo: null, weaponGeo0: null, chains: [],
      feet: [{ lock: null, step: null }, { lock: null, step: null }], ik: 0,
      animQ: npc.bones.map(() => new THREE.Quaternion()), outQ: npc.bones.map(() => new THREE.Quaternion(2, 2, 2, 2)), pop: npc.bones.map(() => ({ off: new THREE.Quaternion(), t: 0 })),
      ramp0: npc.mat.gradientMap, imp: -1, impAt: 0,
    };
    this.applyToon(r);
    return r;
  }

  private applyToon(r: Rec) {
    const m = r.npc.mat;
    if (this.toon) {
      if (!r.toon) { patchToon(m, 0.2, 0, true); r.toon = true; }
      m.gradientMap = tintedRamp();
    } else if (r.toon) m.gradientMap = r.ramp0;
  }

  private build0(r: Rec) {
    const npc = r.npc, A = this.lod(npc);
    const u = A?.units.get(npc.unit);
    if (!A) return;
    if (!u) return;
    this.built++;
    const byName = new Map<string, THREE.Bone>();
    npc.root.traverse((o) => { if ((o as THREE.Bone).isBone) byName.set(o.name, o as THREE.Bone); });
    const bones: THREE.Bone[] = [];
    u.boneNames.forEach((n, i) => {
      let b = byName.get(n);
      if (!b) {
        // a DGL_* dangle bone the LOD1 rig doesn't have: created under its parent at the LOD0 rest pose
        b = new THREE.Bone(); b.name = n;
        u.restLocal[i].decompose(b.position, b.quaternion, b.scale);
        const p = u.boneParents[i] ? (byName.get(u.boneParents[i]!) ?? bones[u.boneNames.indexOf(u.boneParents[i]!)]) : null;
        (p ?? npc.mesh.parent ?? npc.root).add(b);
        byName.set(n, b);
      }
      bones.push(b);
    });
    const sk = new THREE.Skeleton(bones, u.inverses);
    r.mat0 = this.bodyMaterial(A.atlas);
    r.lod0 = new THREE.SkinnedMesh(u.geometry, r.mat0);
    r.lod0.name = 'vtp:raid:lod0';
    r.lod0.matrixAutoUpdate = true;
    u.local.decompose(r.lod0.position, r.lod0.quaternion, r.lod0.scale);
    r.lod0.bind(sk, u.bindMatrix);
    r.lod0.frustumCulled = false;
    r.inkMat = inkMaterial(A.atlas);
    r.ink = new THREE.SkinnedMesh(u.geometry, r.inkMat);
    r.ink.name = 'vtp:raid:lod0ink';
    u.local.decompose(r.ink.position, r.ink.quaternion, r.ink.scale);
    r.ink.bind(sk, u.bindMatrix);
    r.ink.frustumCulled = false;
    (npc.mesh.parent ?? npc.root).add(r.lod0, r.ink);
    r.lod0.visible = r.ink.visible = false;
    // dangle chains: DGL_<name>_<n>, in order
    const groups = new Map<string, THREE.Bone[]>();
    for (const b of bones) { const m = /^DGL_(.+)_(\d)$/.exec(b.name); if (m) { const g = groups.get(m[1]) ?? []; g[+m[2] - 1] = b; groups.set(m[1], g); } }
    for (const [name, list] of groups) {
      const bs = list.filter(Boolean);
      if (!bs.length) continue;
      r.chains.push({ bones: bs, len: bs.map((b) => Math.max(0.02, (b.children.find((c) => (c as THREE.Bone).isBone)?.position.length() ?? 0.07))), tip: bs.map(() => new THREE.Vector3()), prev: bs.map(() => new THREE.Vector3()), sling: /^sling/i.test(name), init: false,
        // whips (antennas) spring back hard and barely sag; straps / sleeves hang and swing
        stiff: /^ant/i.test(name) ? 0.45 : 0.1, grav: /^ant/i.test(name) ? 0.05 : 1 });
    }
  }


  private show0(r: Rec, on: boolean) {
    const npc = r.npc;
    if (on === r.showing0) return;
    r.showing0 = on;
    if (r.lod0) r.lod0.visible = on;
    if (r.ink) r.ink.visible = on;
    npc.mesh.visible = !on;
    // weapon: LOD0 geometry while close (the Npc keeps its offset / material)
    const w = npc.weapon, A = this.lod(npc);
    if (w && A) {
      if (on) { const g0 = A.weapons.get(npc.weaponId); if (g0 && w.geometry !== g0) { r.weaponGeo = w.geometry; r.weaponGeo0 = g0; w.geometry = g0; } }
      else if (r.weaponGeo && w.geometry === r.weaponGeo0) { w.geometry = r.weaponGeo; r.weaponGeo = null; }
    }
  }

  /** Mirror the NPC's fade + outline state onto LOD0; constant-width ink. */
  private sync0(r: Rec, dist: number, cam: THREE.PerspectiveCamera) {
    const npc = r.npc, o = npc.opacity;
    const t = o < 0.999;
    for (const m of [r.mat0, r.inkMat]) {
      if (!m) continue;
      if (m.transparent !== t) { m.transparent = t; m.needsUpdate = true; }
      m.depthWrite = o > 0.5;
    }
    if (r.mat0) r.mat0.opacity = o;
    if (r.inkMat) r.inkMat.opacity = o * o;
    if (npc.outline) npc.outline.visible = false;
    if (r.ink) {
      r.ink.visible = o > 0.02 && dist < 30;
      const H = this.stage.renderer.getDrawingBufferSize(_b2).y || 1080;
      const px = 2 * dist * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / H;
      (r.inkMat!.userData as { w: { value: number } }).w.value = THREE.MathUtils.clamp(px * this.inkPx, 0.0045, 0.035) / Math.max(0.3, npc.root.scale.x);
    }
    // swap the weapon too if it was changed while close
    const A = this.lod(npc);
    if (npc.weapon && A && npc.weapon.geometry !== A.weapons.get(npc.weaponId) && A.weapons.has(npc.weaponId) && !npc.dropped) {
      r.weaponGeo = npc.weapon.geometry; r.weaponGeo0 = A.weapons.get(npc.weaponId)!; npc.weapon.geometry = r.weaponGeo0;
    }
  }

  /** Planted feet, pop smoothing, dangles. Idempotent over frames the raid didn't re-pose. */
  private motion(r: Rec, dt: number) {
    const npc = r.npc, bones = npc.bones;
    // did the raid pose this frame? (else restore its pose before layering ours again)
    let posed = false;
    for (let i = 0; i < bones.length; i++) { const b = bones[i]; if (b && !b.quaternion.equals(r.outQ[i])) { posed = true; break; } }
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i];
      if (!b) continue;
      if (posed) {
        // pop: a >30° jump in one frame → carry the old pose as an offset that decays over 0.2 s
        const prevOut = r.outQ[i];
        if (prevOut.x < 1.5 && Math.abs(prevOut.dot(b.quaternion)) < Math.cos(0.27)) { r.pop[i].off.copy(prevOut).multiply(_q.copy(b.quaternion).invert()); r.pop[i].t = 0.2; }
        r.animQ[i].copy(b.quaternion);
      } else b.quaternion.copy(r.animQ[i]);
      const p = r.pop[i];
      if (p.t > 0) { p.t = Math.max(0, p.t - dt); const k = p.t / 0.2; b.quaternion.premultiply(_q.identity().slerp(p.off, k * k * (3 - 2 * k))); }
    }
    npc.root.updateMatrixWorld(true);
    // ---- feet
    const clip = npc.cur?.clip.name ?? '';
    const want = STATIC.test(clip) && !npc.dropped ? 1 : 0;
    r.ik += (want - r.ik) * Math.min(1, dt / 0.2);
    if (want === 0) { r.feet[0].lock = r.feet[1].lock = null; r.feet[0].step = r.feet[1].step = null; }
    if (r.ik > 0.01) {
      const ix = (n: string) => npc.assets.boneNames.indexOf(n);
      (['L', 'R'] as const).forEach((s, fi) => {
        const up = bones[ix(`UpperLeg_${s}`)], lo = bones[ix(`LowerLeg_${s}`)], ft = bones[ix(`Foot_${s}`)];
        if (!up || !lo || !ft) return;
        const f = r.feet[fi];
        const A = worldPos(ft, new THREE.Vector3());
        const sc = npc.root.scale.x;
        if (!f.lock) f.lock = A.clone();
        if (!f.step && A.distanceTo(f.lock) > 0.2 * sc) f.step = { from: f.lock.clone(), to: A.clone(), t: 0 };
        let T = f.lock;
        if (f.step) {
          f.step.t = Math.min(1, f.step.t + dt / 0.2);
          f.step.to.copy(A);
          const k = f.step.t * f.step.t * (3 - 2 * f.step.t);
          T = _v.copy(f.step.from).lerp(f.step.to, k);
          T.y += Math.sin(Math.PI * f.step.t) * 0.06 * sc;
          if (f.step.t >= 1) { f.lock = f.step.to.clone(); f.step = null; T = f.lock; }
        }
        const target = _v2.copy(A).lerp(T, r.ik);
        this.legIK(up, lo, ft, target);
      });
    }
    // ---- dangles (LOD0 only)
    if (r.showing0) for (const c of r.chains) this.chain(c, npc, dt);
    for (let i = 0; i < bones.length; i++) if (bones[i]) r.outQ[i].copy(bones[i]!.quaternion);
  }

  private legIK(up: THREE.Bone, lo: THREE.Bone, ft: THREE.Bone, T: THREE.Vector3) {
    const H = worldPos(up, new THREE.Vector3()), K = worldPos(lo, new THREE.Vector3()), A = worldPos(ft, new THREE.Vector3());
    const l1 = H.distanceTo(K), l2 = K.distanceTo(A);
    if (l1 < 1e-4 || l2 < 1e-4 || A.distanceTo(T) < 1e-4) return;
    const footW = ft.getWorldQuaternion(new THREE.Quaternion());
    const d = THREE.MathUtils.clamp(H.distanceTo(T), 1e-3, l1 + l2 - 1e-4);
    const dir = T.clone().sub(H).normalize();
    // bend plane from the current knee (keeps the knee pointing where the animation had it)
    const n = new THREE.Vector3().crossVectors(K.clone().sub(H), A.clone().sub(H));
    if (n.lengthSq() < 1e-10) return;
    n.normalize();
    const cosA = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
    const knee = dir.clone().applyAxisAngle(n, Math.acos(cosA)).multiplyScalar(l1).add(H);
    turnBone(up, K.clone().sub(H), knee.clone().sub(H));
    const K2 = worldPos(lo, new THREE.Vector3()), A2 = worldPos(ft, new THREE.Vector3());
    turnBone(lo, A2.sub(K2), T.clone().sub(K2));
    // keep the foot's world orientation (flat on the floor)
    const pw = lo.getWorldQuaternion(new THREE.Quaternion());
    ft.quaternion.copy(pw.invert().multiply(footW));
    ft.updateMatrixWorld(true);
  }

  /** Verlet dangle: each segment's tip swings under gravity + the body's motion, limited to 70° off its rest direction.
   *  Slings: the end is pinned to the weapon's stock, the middle sags. */
  private chain(c: Chain, npc: NpcLike, dt: number) {
    const g = -9.8 * 0.35;
    const h = Math.min(dt, 1 / 30);
    if (c.sling && npc.weapon && npc.weapon.visible && !npc.dropped) {
      const a = worldPos(c.bones[0], new THREE.Vector3());
      npc.weapon.updateWorldMatrix(true, false);
      const stock = new THREE.Vector3(0, -0.2, 0.02).applyMatrix4(npc.weapon.matrixWorld);
      const len = c.len.reduce((x, y) => x + y, 0) * npc.root.scale.x;
      const span = a.distanceTo(stock);
      const mid = a.clone().lerp(stock, 0.5);
      mid.y -= Math.sqrt(Math.max(0, len * len - span * span)) * 0.5;
      if (!c.init) { c.tip[0].copy(mid); c.prev[0].copy(mid); c.init = true; }
      const vel = c.tip[0].clone().sub(c.prev[0]).multiplyScalar(0.82);
      c.prev[0].copy(c.tip[0]);
      c.tip[0].add(vel).lerp(mid, 0.35);
      const cur = worldPos(c.bones[1] ?? c.bones[0], new THREE.Vector3()).sub(a);
      turnBone(c.bones[0], cur, c.tip[0].clone().sub(a));
      if (c.bones[1]) { const b1 = worldPos(c.bones[1], new THREE.Vector3()); const tail = c.bones[1].children.find((x) => (x as THREE.Bone).isBone); const t1 = tail ? worldPos(tail, new THREE.Vector3()) : b1.clone().add(stock.clone().sub(b1).normalize().multiplyScalar(c.len[1])); turnBone(c.bones[1], t1.sub(b1), stock.clone().sub(b1)); }
      return;
    }
    for (let i = 0; i < c.bones.length; i++) {
      const b = c.bones[i];
      const head = worldPos(b, new THREE.Vector3());
      // rest direction (as animated by the parent): the bone's own +Y
      const restDir = new THREE.Vector3(0, 1, 0).applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion())).normalize();
      const L = c.len[i] * npc.root.scale.x;
      if (!c.init) { c.tip[i].copy(head).addScaledVector(restDir, L); c.prev[i].copy(c.tip[i]); }
      const vel = c.tip[i].clone().sub(c.prev[i]).multiplyScalar(0.9);
      c.prev[i].copy(c.tip[i]);
      c.tip[i].add(vel);
      c.tip[i].y += g * c.grav * h * h;
      // spring back towards the rest direction (stiffness), then keep the length
      c.tip[i].lerp(head.clone().addScaledVector(restDir, L), c.stiff);
      const dir = c.tip[i].clone().sub(head);
      if (dir.lengthSq() < 1e-10) continue;
      dir.normalize();
      const ang = dir.angleTo(restDir);
      if (ang > 1.2) dir.copy(restDir).lerp(dir, 1.2 / ang).normalize();
      c.tip[i].copy(head).addScaledVector(dir, L);
      turnBone(b, restDir, dir);
    }
    c.init = true;
  }

  // ---------------------------------------------------------------- impostors (Performance, far NPCs)
  private useImpostor(r: Rec) {
    if (r.imp >= 0) return;
    const slot = this.impSlots.indexOf(null);
    if (slot < 0) return;
    this.impSlots[slot] = r;
    r.imp = slot; r.impAt = -1;
  }
  private dropImpostor(r: Rec) {
    if (r.imp < 0) return;
    this.impSlots[r.imp] = null;
    r.imp = -1;
    this.setParts(r, true);
  }
  private setParts(r: Rec, on: boolean) {
    const n = r.npc;
    n.mesh.visible = on && !r.showing0;
    if (n.weapon && !n.dropped) n.weapon.visible = on;
    if (n.outline && !on) n.outline.visible = false;
  }

  private drawImpostors(cam: THREE.PerspectiveCamera) {
    const used = this.impSlots.filter(Boolean) as Rec[];
    if (!used.length) { if (this.impMesh) this.impMesh.visible = false; return; }
    const st = this.stage, r = st.renderer;
    if (!this.impRT) {
      this.impRT = new THREE.WebGLRenderTarget(1024, 1024, { samples: 0, depthBuffer: true, colorSpace: THREE.SRGBColorSpace });
      const geo = new THREE.PlaneGeometry(1, 1);
      const tile = new THREE.InstancedBufferAttribute(new Float32Array(16 * 3), 3);
      geo.setAttribute('aTile', tile);
      const mat = new THREE.ShaderMaterial({
        uniforms: { tAtlas: { value: this.impRT.texture } },
        vertexShader: /* glsl */ `attribute vec3 aTile; varying vec2 vUv; varying float vA;
          void main() { vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0); float s = length(instanceMatrix[0].xyz);
            c.xy += position.xy * s; vUv = (uv + aTile.xy) * 0.25; vA = aTile.z; gl_Position = projectionMatrix * c; }`,
        fragmentShader: /* glsl */ `uniform sampler2D tAtlas; varying vec2 vUv; varying float vA;
          void main() { vec4 c = texture2D(tAtlas, vUv); if (c.a * vA < 0.5) discard; gl_FragColor = vec4(c.rgb / max(c.a, 1e-3), 1.0); }`,
      });
      this.impMesh = new THREE.InstancedMesh(geo, mat, 16);
      this.impMesh.name = 'vtp:gfx:impostors';
      this.impMesh.frustumCulled = false;
    }
    if (this.impMesh!.parent !== this.root) this.root?.add(this.impMesh!);
    // the capture scene is lit like the stage (hemisphere + key light), fogged like the room
    let hemi: THREE.HemisphereLight | null = null;
    for (const o of st.scene.children) if ((o as THREE.HemisphereLight).isHemisphereLight) { hemi = o as THREE.HemisphereLight; break; }
    if (hemi) { this.impHemi.color.copy(hemi.color); this.impHemi.groundColor.copy(hemi.groundColor); this.impHemi.intensity = hemi.intensity; }
    const key = st.keyLight;
    this.impKey.color.copy(key.color); this.impKey.intensity = key.intensity;
    this.impKey.position.copy(key.position).sub(key.target.position); this.impKey.target.position.set(0, 0, 0);
    this.impScene.fog = st.scene.fog;
    const prevT = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color()), prevA = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    let done = 0;
    for (let k = 0; k < 16 && done < 2; k++) {
      const i = (this.impNext + k) % 16, rec = this.impSlots[i];
      if (!rec) continue;
      done++;
      this.impNext = (i + 1) % 16;
      const n = rec.npc, sc = n.root.scale.x;
      const c = _v.copy(n.root.position).setY(n.root.position.y + 0.9 * sc);
      const rad = 1.05 * sc, dist = Math.max(1, cam.position.distanceTo(c));
      this.impCam.position.copy(cam.position);
      this.impCam.lookAt(c);
      this.impCam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(rad / dist));
      this.impCam.aspect = 1; this.impCam.near = Math.max(0.05, dist - rad * 2); this.impCam.far = dist + rad * 2;
      this.impCam.updateProjectionMatrix();
      const tx = (i % 4) * 256, ty = Math.floor(i / 4) * 256;
      this.impRT.viewport.set(tx, ty, 256, 256); this.impRT.scissor.set(tx, ty, 256, 256); this.impRT.scissorTest = true;
      r.setRenderTarget(this.impRT);
      r.clear(true, true, false);
      this.setParts(rec, true);
      const parent = n.root.parent;
      const wasVis = n.root.visible;
      n.root.visible = true;
      this.impScene.add(n.root);                 // (world = room space: the room root sits at the origin)
      r.render(this.impScene, this.impCam);
      parent?.add(n.root);
      n.root.visible = wasVis;
      rec.impAt = performance.now();
    }
    this.impRT.scissorTest = false;
    r.setRenderTarget(prevT);
    r.setClearColor(prevClear, prevA);
    // cards
    const m = new THREE.Matrix4(), tile = this.impMesh!.geometry.getAttribute('aTile') as THREE.InstancedBufferAttribute;
    let n = 0;
    for (let i = 0; i < 16; i++) {
      const rec = this.impSlots[i];
      if (!rec || rec.impAt < 0) continue;
      this.setParts(rec, false);
      const sc = rec.npc.root.scale.x;
      m.makeScale(2.1 * sc, 2.1 * sc, 2.1 * sc).setPosition(rec.npc.root.position.x, rec.npc.root.position.y + 0.9 * sc, rec.npc.root.position.z);
      this.impMesh!.setMatrixAt(n, m);
      tile.setXYZ(n, i % 4, Math.floor(i / 4), rec.npc.opacity);
      n++;
    }
    this.impMesh!.count = n;
    this.impMesh!.instanceMatrix.needsUpdate = true;
    tile.needsUpdate = true;
    this.impMesh!.visible = n > 0;
  }

  private release(r: Rec, restore: boolean) {
    this.dropImpostor(r);
    if (r.showing0) this.show0(r, false);
    r.lod0?.removeFromParent(); r.ink?.removeFromParent();
    r.mat0?.dispose(); r.inkMat?.dispose();
    for (const c of r.chains) for (const b of c.bones) if (!r.npc.bones.includes(b)) b.removeFromParent();
    if (restore && r.toon) r.npc.mat.gradientMap = r.ramp0;
  }

  info() {
    return { ...this.stats, assets: this.assets ? Object.keys(this.assets.tris).length : this.failed ? 'missing' : this.loading ? 'loading' : 'not loaded', tris0: this.assets?.tris ?? null, costMs: +this.cost.toFixed(3) };
  }

  dispose() { this.unbind(); this.impRT?.dispose(); this.impMesh?.geometry.dispose(); (this.impMesh?.material as THREE.Material | undefined)?.dispose(); }
}
