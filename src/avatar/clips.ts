// Animation clips for the 3D auto-rigs (animals, birds, snakes, things): load clips the person fetched themselves (CC0 only),
// fit them to a rig, and play them over the tracked pose.
//
//   loadClipPack(bytes, source)   a GLB/glTF with animations (e.g. a Mesh2Motion pack, CC0). The licence line the person gives and the
//                                 file itself are checked first (shared/clipLicense.ts); a Mixamo skeleton or credit stops the load.
//   clipFromRoleJson(json, model) a small self-made clip ("vtp-clip-1": keyframes of angles about the model's own axes, by bone
//                                 name) for rigs made by blender/rigplan.py. Ships in assets/clips/.
//   suggestBoneMap(src, dst)      which of the pack's bones drives which of the rig's bones: the trunk, the legs, the tail, paired
//                                 along their length, so a 6-bone horse leg drives a 3-bone leg.
//   retargetClip(...)             the clip on the rig: per bone the WORLD delta from rest (the method of docs/ANIMATION_LIBRARY.md),
//                                 turned to the rig's own bone frames; head and neck are left to the face tracker by default.
//   ClipPlayer                    plays a clip over everything else (the quadruped layer keeps the bones the clip does not touch).
// Nothing here downloads anything. Mixamo animations never load.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clipLicenseVerdict, sanitizeClipSource, type ClipSource } from '../../shared/clipLicense.ts';

export class ClipError extends Error {}

const MAX_KEYS = 4000, MAX_TRACKS = 96, MAX_BYTES = 40e6, MAX_DURATION = 120;

// ---------------------------------------------------------------- loading a pack

export interface ClipPack { source: ClipSource; clips: THREE.AnimationClip[]; root: THREE.Object3D }

/** Parse a clip pack. Throws ClipError (plain words) when the licence line or the file is not acceptable. */
export async function loadClipPack(bytes: ArrayBuffer, source: Partial<ClipSource>): Promise<ClipPack> {
  if (bytes.byteLength > MAX_BYTES) throw new ClipError('That clip file is bigger than 40 MB: pick a smaller pack.');
  const src = sanitizeClipSource({ id: 'pack', ...source });
  const pre = clipLicenseVerdict(src);
  if (!src || !pre.ok) throw new ClipError(pre.why || 'This clip pack has no licence line. Only CC0 or self-made clips load.');
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  let gltf;
  try { gltf = await loader.parseAsync(bytes, ''); } catch (e) { throw new ClipError(`The clip file could not be read (${(e as Error).message.slice(0, 80)}).`); }
  const json = (gltf.parser as unknown as { json: { asset?: Record<string, unknown>; nodes?: { name?: string }[]; animations?: { name?: string }[]; scenes?: { name?: string; extras?: unknown }[] } }).json;
  // everything the file says about itself: generator, copyright, extras (a source URL or a licence note often sits there), names
  const extras = (v: unknown) => { try { return JSON.stringify(v ?? '').slice(0, 2000); } catch { return ''; } };
  const hints = [String(json.asset?.generator ?? ''), String(json.asset?.copyright ?? ''), extras(json.asset?.extras), ...(json.scenes ?? []).flatMap((s) => [s.name ?? '', extras(s.extras)]),
    ...(json.nodes ?? []).map((n) => n.name ?? ''), ...(json.animations ?? []).map((a) => a.name ?? '')];
  const v = clipLicenseVerdict(src, hints);
  if (!v.ok) throw new ClipError(v.why);
  const clips = gltf.animations.filter((c) => c.tracks.length && c.duration > 0 && c.duration <= MAX_DURATION);
  if (!clips.length) throw new ClipError('That file has no animation clips in it.');
  return { source: src, clips, root: gltf.scene };
}

// ---------------------------------------------------------------- the self-made role clip

export interface RoleClipJson {
  format: 'vtp-clip-1';
  name: string;
  license: string;
  author?: string;
  duration: number;
  loop?: boolean;
  /** Rotation about an axis of the MODEL (x = across, y = up, z = forward), from the bone's rest pose, in radians. */
  tracks: { bone: string; axis: 'x' | 'y' | 'z'; keys: [number, number][] }[];
}

const AXIS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

/** Validate a role clip (no THREE needed). Returns the clean clip or throws ClipError. */
export function parseRoleClip(raw: unknown): RoleClipJson {
  if (!raw || typeof raw !== 'object') throw new ClipError('Not a clip file.');
  const r = raw as Record<string, unknown>;
  if (r.format !== 'vtp-clip-1') throw new ClipError('Not a VTube Pro clip file (format vtp-clip-1).');
  const v = clipLicenseVerdict({ license: String(r.license ?? ''), source: typeof r.source === 'string' ? r.source : undefined }, [String(r.name ?? ''), String(r.author ?? '')]);
  if (!v.ok) throw new ClipError(v.why);
  const duration = Number(r.duration);
  if (!(duration > 0 && duration <= MAX_DURATION)) throw new ClipError('The clip needs a duration between 0 and 120 seconds.');
  if (!Array.isArray(r.tracks) || !r.tracks.length || r.tracks.length > MAX_TRACKS) throw new ClipError(`A clip has 1 to ${MAX_TRACKS} tracks.`);
  const tracks: RoleClipJson['tracks'] = [];
  let keys = 0;
  for (const t of r.tracks) {
    const o = t as Record<string, unknown>;
    if (typeof o.bone !== 'string' || !/^[\p{L}\p{N}_.:\- ]{1,64}$/u.test(o.bone) || !['x', 'y', 'z'].includes(o.axis as string) || !Array.isArray(o.keys)) continue;
    const ks: [number, number][] = [];
    for (const k of o.keys as unknown[]) {
      if (!Array.isArray(k) || k.length !== 2) continue;
      const t0 = Number(k[0]), a = Number(k[1]);
      if (Number.isFinite(t0) && Number.isFinite(a) && t0 >= 0 && t0 <= duration && Math.abs(a) <= Math.PI) ks.push([t0, a]);
    }
    ks.sort((p, q) => p[0] - q[0]);
    keys += ks.length;
    if (keys > MAX_KEYS) throw new ClipError('The clip has too many keys.');
    if (ks.length >= 2) tracks.push({ bone: o.bone, axis: o.axis as 'x' | 'y' | 'z', keys: ks });
  }
  if (!tracks.length) throw new ClipError('The clip has no usable track.');
  return { format: 'vtp-clip-1', name: String(r.name ?? 'clip').slice(0, 60), license: String(r.license), ...(typeof r.author === 'string' ? { author: r.author.slice(0, 80) } : {}), duration, loop: r.loop !== false, tracks };
}

/** The bones of a rig, parents first. A file without a skin (some exporters) has plain nodes: then every non-mesh node under the root counts. */
function boneList(root: THREE.Object3D): THREE.Object3D[] {
  const bones: THREE.Object3D[] = [], nodes: THREE.Object3D[] = [];
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.push(o);
    else if (o !== root && !(o as THREE.Mesh).isMesh && !(o as THREE.Light).isLight && !(o as THREE.Camera).isCamera && o.name) nodes.push(o);
  });
  return bones.length ? bones : nodes;
}

function bonesByName(root: THREE.Object3D) {
  const m = new Map<string, THREE.Object3D>();
  for (const o of boneList(root)) if (!m.has(o.name)) m.set(o.name, o);
  return m;
}

/** The role clip as an AnimationClip on `model`'s bones (bones the model does not have are skipped). Null when none match. */
export function clipFromRoleJson(raw: unknown, model: THREE.Object3D): THREE.AnimationClip | null {
  const j = parseRoleClip(raw);
  model.updateWorldMatrix(true, true);
  const bones = bonesByName(model);
  const tracks: THREE.KeyframeTrack[] = [];
  const wq = new THREE.Quaternion(), pw = new THREE.Quaternion(), rot = new THREE.Quaternion(), local = new THREE.Quaternion();
  for (const t of j.tracks) {
    const b = bones.get(t.bone);
    if (!b || !b.parent) continue;
    const restW = b.getWorldQuaternion(new THREE.Quaternion());
    b.parent.getWorldQuaternion(pw);
    const pwInv = pw.clone().invert();
    const modelQ = model.getWorldQuaternion(new THREE.Quaternion());
    const axisW = AXIS[t.axis].clone().applyQuaternion(modelQ).normalize();
    const times: number[] = [], vals: number[] = [];
    for (const [time, ang] of t.keys) {
      rot.setFromAxisAngle(axisW, ang);
      wq.copy(rot).multiply(restW);
      local.copy(pwInv).multiply(wq);
      times.push(time); vals.push(local.x, local.y, local.z, local.w);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, vals));
  }
  return tracks.length ? new THREE.AnimationClip(j.name, j.duration, tracks) : null;
}

// ---------------------------------------------------------------- bone map

const depthOf = (o: THREE.Object3D) => { let d = 0; for (let p = o.parent; p; p = p.parent) d++; return d; };
const worldPos = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

/** Start fractions (0..1 of the whole length) of a chain of bones, by rest world position. */
function fractions(chain: THREE.Object3D[]): number[] {
  const pts = chain.map(worldPos);
  const seg = pts.map((p, i) => (i + 1 < pts.length ? p.distanceTo(pts[i + 1]) : 0));
  const total = seg.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return pts.map((_, i) => { const f = acc / total; acc += seg[i]; return f; });
}

/** Pair two chains by position along their length: each rig bone takes the pack bone that starts nearest the same fraction. */
export function pairChains(src: THREE.Object3D[], dst: THREE.Object3D[]): [THREE.Object3D, THREE.Object3D][] {
  if (!src.length || !dst.length) return [];
  if (src.length === 1) return [[src[0], dst[0]]];
  const fs = fractions(src), fd = fractions(dst);
  const used = new Set<number>();
  const out: [THREE.Object3D, THREE.Object3D][] = [];
  dst.forEach((d, j) => {
    let best = -1, bd = Infinity;
    fs.forEach((f, i) => { const e = Math.abs(f - fd[j]); if (!used.has(i) && e < bd) { bd = e; best = i; } });
    if (best >= 0) { used.add(best); out.push([src[best], d]); }
  });
  return out;
}

const SIDE = /(?:^|[_.\-\s])(l|left|r|right)$/i;
const sideOf = (n: string): 'L' | 'R' | null => { const m = SIDE.exec(n); return m ? (m[1][0].toLowerCase() === 'l' ? 'L' : 'R') : null; };
const FRONT = /(front|fore)/i, HIND = /(back|hind|rear)/i;
const LEGISH = /(leg|foot|paw|ankle|toe|humerus|scapula|pelvis|upper|lower|knee|hock|thigh|shin|calf)/i;

export type BoneMap = Map<string, string>;   // rig bone name -> pack bone name

/** Which bone of the pack drives which bone of the rig. Works on the names rigplan.py makes (hips spine chest neck head leg_FL_1 tail_1 wing_L_1)
 *  and on common animal rigs (Mesh2Motion: hips spine_1.. head front_leg_upper_l back_leg_foot_r tail_1 ...). */
export function suggestBoneMap(srcRoot: THREE.Object3D, dstRoot: THREE.Object3D): BoneMap {
  srcRoot.updateWorldMatrix(true, true); dstRoot.updateWorldMatrix(true, true);
  const sb = boneList(srcRoot), db = boneList(dstRoot);
  const sBy = new Map(sb.map((b) => [b.name, b])), dBy = new Map(db.map((b) => [b.name, b]));
  const map: BoneMap = new Map();
  const put = (pairs: [THREE.Object3D, THREE.Object3D][]) => { for (const [s, d] of pairs) if (![...map.values()].includes(s.name)) map.set(d.name, s.name); };
  // ---- trunk: the path hips -> head
  const sHips = sb.find((b) => /^(hips?|pelvis|root_?hips?|cog)$/i.test(b.name)), sHead = sBy.get('head') ?? sb.find((b) => /^head$/i.test(b.name));
  const dHips = dBy.get('hips'), dHead = dBy.get('head');
  if (sHips && sHead && dHips && dHead) {
    const path = (from: THREE.Object3D, to: THREE.Object3D) => { const p: THREE.Object3D[] = []; for (let o: THREE.Object3D | null = to; o; o = o.parent) { p.push(o); if (o === from) return p.reverse(); } return null; };
    const sp = path(sHips, sHead), dp = path(dHips, dHead);
    if (sp && dp) {
      const dTrunk = dp.filter((b) => (b as THREE.Bone).isBone);
      // the head (a leaf) maps head-to-head, the hips hips-to-hips; the bones between pair by length
      put([[sHips, dHips], [sHead, dHead]]);
      put(pairChains(sp.slice(1, -1), dTrunk.slice(1, -1)));
    }
  }
  // ---- tail
  const tail = (list: THREE.Object3D[], rx: RegExp) => list.filter((b) => rx.test(b.name)).sort((a, b) => depthOf(a) - depthOf(b));
  put(pairChains(tail(sb, /^tail_?\d+$/i), tail(db, /^tail_\d+$/)));
  // ---- legs
  const legsOfSrc = (fh: 'F' | 'H', side: 'L' | 'R') => sb.filter((b) => (fh === 'F' ? FRONT : HIND).test(b.name) && LEGISH.test(b.name) && sideOf(b.name) === side && !/(toe|leaf|scapula|pelvis)/i.test(b.name)).sort((a, b) => depthOf(a) - depthOf(b));
  for (const fh of ['F', 'H'] as const) for (const side of ['L', 'R'] as const) {
    const d = [1, 2, 3, 4, 5, 6, 7].map((i) => dBy.get(`leg_${fh}${side}_${i}`)).filter((b): b is THREE.Object3D => !!b);
    if (d.length) put(pairChains(legsOfSrc(fh, side), d));
  }
  // ---- wings (a bird pack: wing_l_1.. or "wing_upper_l" ...)
  for (const side of ['L', 'R'] as const) {
    const d = [1, 2, 3].map((i) => dBy.get(`wing_${side}_${i}`)).filter((b): b is THREE.Object3D => !!b);
    const s = sb.filter((b) => /wing/i.test(b.name) && sideOf(b.name) === side).sort((a, b) => depthOf(a) - depthOf(b));
    if (d.length && s.length) put(pairChains(s, d));
  }
  return map;
}

// ---------------------------------------------------------------- retarget

export interface RetargetOptions {
  fps?: number;
  /** Rig bones left to the face tracker (default head + neck bones). */
  skip?: (rigBone: string) => boolean;
  /** Keep the hips' up-and-down motion (scaled by the height ratio). Default true. */
  bob?: boolean;
  /** Turn the pack's world frame about Y first (radians); default: found from where the two rigs face. */
  yaw?: number;
}

const faceTracked = (n: string) => n === 'head' || n === 'neck' || /^neck_\d+$/.test(n);

/** The angle about +Y that turns the pack's forward (hips -> head, level) onto the rig's. */
export function facingYaw(srcRoot: THREE.Object3D, dstRoot: THREE.Object3D, map: BoneMap): number {
  const sBy = bonesByName(srcRoot), dBy = bonesByName(dstRoot);
  const dir = (by: Map<string, THREE.Object3D>, a: string, b: string) => { const A = by.get(a), B = by.get(b); if (!A || !B) return null; const v = worldPos(B).sub(worldPos(A)); v.y = 0; return v.lengthSq() > 1e-8 ? v.normalize() : null; };
  const sh = map.get('hips'), shd = map.get('head');
  if (!sh || !shd) return 0;
  const s = dir(sBy, sh, shd), d = dir(dBy, 'hips', 'head');
  if (!s || !d) return 0;
  return Math.atan2(s.z * d.x - s.x * d.z, s.x * d.x + s.z * d.z);       // signed angle from s to d about +Y
}

/**
 * The pack's `clip` on the rig. Both roots must be in their rest pose and share the world frame (+Y up). Returns null when no
 * bone could be driven. Nothing in either root is left changed.
 */
export function retargetClip(clip: THREE.AnimationClip, srcRoot: THREE.Object3D, dstRoot: THREE.Object3D, map: BoneMap, opt: RetargetOptions = {}): THREE.AnimationClip | null {
  const fps = opt.fps ?? 30, skip = opt.skip ?? faceTracked;
  srcRoot.updateWorldMatrix(true, true); dstRoot.updateWorldMatrix(true, true);
  const sBy = bonesByName(srcRoot), dBy = bonesByName(dstRoot);
  const pairs = [...map.entries()].filter(([d, s]) => dBy.has(d) && sBy.has(s));
  if (!pairs.length) return null;
  const yaw = opt.yaw ?? facingYaw(srcRoot, dstRoot, map);
  const Ry = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), RyI = Ry.clone().invert();
  // rest state
  const srcAll: THREE.Object3D[] = []; srcRoot.traverse((o) => srcAll.push(o));
  const saved = srcAll.map((o) => [o, o.position.clone(), o.quaternion.clone(), o.scale.clone()] as const);
  const dstBones = boneList(dstRoot);                     // parents first
  const dstRestWorld = new Map(dstBones.map((b) => [b, b.getWorldQuaternion(new THREE.Quaternion())]));
  const dstRestLocal = new Map(dstBones.map((b) => [b, b.quaternion.clone()]));
  const srcRestWorld = new Map(pairs.map(([, s]) => [s, sBy.get(s)!.getWorldQuaternion(new THREE.Quaternion())]));
  const dstOfSrc = new Map(pairs.map(([d, s]) => [d, s]));
  const hipsSrc = sBy.get(map.get('hips') ?? ''), hipsDst = dBy.get('hips');
  const sRestY = hipsSrc ? worldPos(hipsSrc).y : 0;
  const hipsK = (hipsDst && hipsSrc) ? worldPos(hipsDst).y / (sRestY || 1) : 1;
  const bob = opt.bob !== false && !!hipsDst && !!hipsSrc;

  const mixer = new THREE.AnimationMixer(srcRoot);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true;        // (sampled once through: the last key is the last key, not the first)
  action.play();
  const n = Math.max(2, Math.ceil(clip.duration * fps) + 1);
  const times: number[] = [];
  const rotVals = new Map<string, number[]>();
  for (const [d] of pairs) if (!skip(d)) rotVals.set(d, []);
  const bobVals: number[] = [];
  const cur = new Map<THREE.Object3D, THREE.Quaternion>();
  const tmp = new THREE.Quaternion(), pq = new THREE.Quaternion(), delta = new THREE.Quaternion();
  try {
    for (let i = 0; i < n; i++) {
      const t = Math.min(clip.duration, i / fps);
      times.push(t);
      mixer.setTime(t);
      srcRoot.updateMatrixWorld(true);
      cur.clear();
      for (const b of dstBones) {
        const s = dstOfSrc.get(b.name);
        const parentBone = (b.parent && cur.has(b.parent)) ? b.parent : null;
        if (parentBone) pq.copy(cur.get(parentBone)!); else if (b.parent) b.parent.getWorldQuaternion(pq); else pq.identity();
        const parentW = pq.clone();
        let world: THREE.Quaternion;
        if (s) {
          const sb = sBy.get(s)!;
          delta.copy(sb.getWorldQuaternion(tmp)).multiply(srcRestWorld.get(s)!.clone().invert());      // D = W(t) * W(rest)^-1
          delta.premultiply(Ry).multiply(RyI);                                                            // into the rig's facing
          world = delta.clone().multiply(dstRestWorld.get(b)!);
        } else world = parentW.clone().multiply(dstRestLocal.get(b)!);
        cur.set(b, world);
        const vals = rotVals.get(b.name);
        if (vals) { const local = parentW.clone().invert().multiply(world); vals.push(local.x, local.y, local.z, local.w); }
      }
      if (bob) bobVals.push(Math.max(-0.5, Math.min(0.5, (worldPos(hipsSrc!).y - sRestY) * hipsK)));
    }
  } finally {
    mixer.stopAllAction(); mixer.uncacheRoot(srcRoot);
    for (const [o, p, q, s] of saved) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }
    srcRoot.updateMatrixWorld(true);
  }
  const tracks: THREE.KeyframeTrack[] = [];
  for (const [name, vals] of rotVals) tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, vals));
  if (bob && hipsDst) {
    // the up-and-down motion is along the WORLD up axis: express it in the hips' parent frame
    const rest = hipsDst.position;
    const up = new THREE.Vector3(0, 1, 0);
    if (hipsDst.parent) up.applyQuaternion(hipsDst.parent.getWorldQuaternion(new THREE.Quaternion()).invert());
    tracks.push(new THREE.VectorKeyframeTrack('hips.position', times, bobVals.flatMap((y) => [rest.x + up.x * y, rest.y + up.y * y, rest.z + up.z * y])));
  }
  return tracks.length ? new THREE.AnimationClip(clip.name, clip.duration, tracks) : null;
}

// ---------------------------------------------------------------- playing

/** Plays clips over the model. The layers that run before it (humanoid pose, quadruped life, the rig map) keep the bones the clip does not drive. */
export class ClipPlayer {
  private mixer: THREE.AnimationMixer;
  private clips = new Map<string, THREE.AnimationClip>();
  private action: THREE.AnimationAction | null = null;
  /** The name of the clip that plays now. */
  current: string | null = null;

  constructor(model: THREE.Object3D) { this.mixer = new THREE.AnimationMixer(model); }

  add(clip: THREE.AnimationClip) { this.clips.set(clip.name, clip); }
  get names() { return [...this.clips.keys()]; }
  get playing() { return !!this.action; }
  /** Playing or fading out: the runtime keeps calling update while this is true. */
  get active() { return !!this.action || !!this.stopping; }

  play(name: string, o: { loop?: boolean; fade?: number } = {}): boolean {
    const clip = this.clips.get(name);
    if (!clip) return false;
    const next = this.mixer.clipAction(clip);
    next.reset();
    next.setLoop(o.loop === false ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = false;
    const fade = o.fade ?? 0.25;
    if (this.action && this.action !== next) { next.crossFadeFrom(this.action, fade, false); }
    else next.fadeIn(fade);
    next.play();
    this.action = next; this.current = name;
    return true;
  }

  stop(fade = 0.25) {
    if (!this.action) return;
    this.action.fadeOut(fade);
    const a = this.action;
    this.action = null; this.current = null;
    // let the fade finish, then release the bones
    this.stopping = { a, left: fade + 0.05 };
  }
  private stopping: { a: THREE.AnimationAction; left: number } | null = null;

  update(dt: number, resting = false) {
    if (resting) { if (this.action || this.stopping) { this.mixer.stopAllAction(); this.action = null; this.current = null; this.stopping = null; } return; }
    if (!this.action && !this.stopping) return;
    this.mixer.update(dt);
    if (this.action && !this.action.isRunning()) { this.action = null; this.current = null; this.mixer.stopAllAction(); }
    if (this.stopping) { this.stopping.left -= dt; if (this.stopping.left <= 0) { this.mixer.stopAllAction(); this.stopping = null; } }
  }
}
