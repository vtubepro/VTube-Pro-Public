// VRMA emotes: VRM Animation clips (.vrma, VRMC_vrm_animation — loaded by @pixiv/three-vrm-animation, MIT) played on
// top of live tracking on VRM avatars AND on our humanoid-mapped models (both expose a VRMHumanoid).
//
// Library: assets/library/anims/vrma/*.vrma + index.json (retargeted from Quaternius UAL, CC0, by
// tools/retarget/retarget.py). Users' own .vrma files load through loadVrma(url | ArrayBuffer).
//
// How it plays: the studio stamps `frame.emote = { id, name, at, loop }` while an emote runs (app.playEmote), so the OBS
// page and party guests play the same clip at the same phase without extra messages. AvatarRuntime.update() hands that
// to its EmoteLayer after tracking (and a room's seat / locomotion pose hook) wrote the normalized bones: the layer
// blends the clip over them — fade in 0.25 s, out 0.35 s; the head / neck keep most of the face tracking; in a room
// (a pose hook owns the legs and hips) only the upper body plays. Expression / lookAt tracks are ignored (the face stays live).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMAnimationLoaderPlugin, type VRMAnimation } from '@pixiv/three-vrm-animation';
import { VRMHumanBoneParentMap, type VRMHumanBoneName, type VRMHumanoid } from '@pixiv/three-vrm';
import INDEX from '../../assets/library/anims/vrma/index.json';

export interface EmoteInfo { id: string; label: string; file: string; dur: number; loop: boolean; source: string }
/** The built-in emote library (assets/library/anims/vrma/index.json). */
export const EMOTES: EmoteInfo[] = (INDEX as { clips: EmoteInfo[] }).clips;

/** What travels in TrackingFrame.emote. `at` = wall-clock ms (Date.now()) the clip started; a new id restarts it. */
export interface EmoteState { id: number; name: string; at: number; loop?: boolean }

const loader = new GLTFLoader();
loader.register((p) => new VRMAnimationLoaderPlugin(p));
const cache = new Map<string, Promise<VRMAnimation | null>>();

/** A .vrma from a URL or bytes (null when it is not a valid VRM Animation). */
export async function loadVrma(src: string | ArrayBuffer): Promise<VRMAnimation | null> {
  try {
    const gltf = typeof src === 'string' ? await loader.loadAsync(src) : await loader.parseAsync(src, '');
    const a = (gltf.userData.vrmAnimations as VRMAnimation[] | undefined)?.[0];
    return a ?? null;
  } catch (e) { console.warn('[emote] vrma', e); return null; }
}

/** Built-in emote by id (cached). */
export function emoteAnimation(name: string): Promise<VRMAnimation | null> {
  let p = cache.get(name);
  if (!p) {
    const info = EMOTES.find((e) => e.id === name);
    p = info ? loadVrma(new URL(`../../assets/library/anims/vrma/${info.file}`, import.meta.url).href) : Promise.resolve(null);
    cache.set(name, p);
  }
  return p;
}
/** Register a user clip under a name (e.g. a dropped .vrma file) so frames can refer to it. */
export function registerEmote(name: string, anim: VRMAnimation) { cache.set(name, Promise.resolve(anim)); }

interface Track { bone: VRMHumanBoneName; node: THREE.Object3D; times: Float32Array; values: Float32Array }
/** T-pose directions (VRM normalized space: faces +Z, the avatar's left = +X) of the bones whose rest pose may differ on
 *  non-VRM humanoids (A-pose arms, splayed legs) → each is corrected by the swing from this to the model's rest. */
const TDIR: Partial<Record<VRMHumanBoneName, [VRMHumanBoneName, [number, number, number]]>> = {
  hips: ['spine', [0, 1, 0]], spine: ['chest', [0, 1, 0]], chest: ['neck', [0, 1, 0]], upperChest: ['neck', [0, 1, 0]], neck: ['head', [0, 1, 0]],
  leftShoulder: ['leftUpperArm', [1, 0, 0]], leftUpperArm: ['leftLowerArm', [1, 0, 0]], leftLowerArm: ['leftHand', [1, 0, 0]],
  rightShoulder: ['rightUpperArm', [-1, 0, 0]], rightUpperArm: ['rightLowerArm', [-1, 0, 0]], rightLowerArm: ['rightHand', [-1, 0, 0]],
  leftUpperLeg: ['leftLowerLeg', [0, -1, 0]], leftLowerLeg: ['leftFoot', [0, -1, 0]], rightUpperLeg: ['rightLowerLeg', [0, -1, 0]], rightLowerLeg: ['rightFoot', [0, -1, 0]],
};
const HEAD = new Set<string>(['neck', 'head', 'leftEye', 'rightEye', 'jaw']);
const LOWER = new Set<string>(['hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes']);
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qc = new THREE.Quaternion();

/** Plays EmoteStates on one avatar's humanoid (normalized bones). */
export class EmoteLayer {
  private cur: { st: EmoteState; anim: VRMAnimation; tracks: Track[]; t: number } | null = null;
  /** humanoid bones parent-first, each with its rest correction S⁻¹ (T-pose → this model's rest; identity on T-posed VRMs) */
  private chain: { bone: VRMHumanBoneName; parent: VRMHumanBoneName | null; node: THREE.Object3D; sInv: THREE.Quaternion }[] = [];
  private D = new Map<VRMHumanBoneName, THREE.Quaternion>();
  private W = new Map<VRMHumanBoneName, THREE.Quaternion>();
  private pending: number | null = null;
  private w = 0;
  /** how much of the face tracking the head / neck keep during an emote (0 = the clip only) */
  headKeep = 0.65;

  constructor(private humanoid: VRMHumanoid, private vrm0: boolean) {
    const rest = humanoid.normalizedRestPose;
    const depth = (b: VRMHumanBoneName): number => { let d = 0, p = VRMHumanBoneParentMap[b]; while (p) { d++; p = VRMHumanBoneParentMap[p]; } return d; };
    const names = (Object.keys(humanoid.humanBones) as VRMHumanBoneName[]).filter((b) => humanoid.getNormalizedBoneNode(b)).sort((a, b) => depth(a) - depth(b));
    for (const b of names) {
      let p = VRMHumanBoneParentMap[b];
      while (p && !humanoid.getNormalizedBoneNode(p)) p = VRMHumanBoneParentMap[p];
      const sInv = new THREE.Quaternion();
      const td = TDIR[b];
      const cp = td ? rest[td[0]]?.position : undefined;
      if (td && cp) {
        const r = new THREE.Vector3(...cp);
        // (VRM 0.x normalized space faces -Z: its T-pose directions are mirrored in x and z)
        const T = new THREE.Vector3(...td[1]); if (vrm0) { T.x = -T.x; T.z = -T.z; }
        if (r.lengthSq() > 1e-8) sInv.setFromUnitVectors(r.normalize(), T).normalize();   // S⁻¹: rest → T
      }
      this.chain.push({ bone: b, parent: p ?? null, node: humanoid.getNormalizedBoneNode(b)!, sInv });
      this.D.set(b, new THREE.Quaternion()); this.W.set(b, new THREE.Quaternion());
    }
  }

  get playing() { return this.cur ? this.cur.st.name : null; }

  apply(st: EmoteState | undefined, dt: number, upperOnly: boolean) {
    // (re)start on a new id, once its clip has loaded
    if (st && st.id !== this.cur?.st.id && st.id !== this.pending) {
      this.pending = st.id;
      void emoteAnimation(st.name).then((anim) => {
        if (this.pending !== st.id) return;
        this.pending = null;
        if (anim) this.cur = { st, anim, tracks: this.build(anim), t: 0 };
      });
    }
    const c = this.cur;
    if (!c) return;
    const dur = Math.max(0.05, c.anim.duration);
    const active = !!st && st.id === c.st.id;
    c.t = Math.max(0, (Date.now() - c.st.at) / 1000);
    const ended = !c.st.loop && c.t >= dur;
    const target = active && !ended ? 1 : 0;
    this.w = target ? Math.min(1, this.w + dt / 0.25) : Math.max(0, this.w - dt / 0.35);
    if (target === 0 && this.w < 0.01) { this.cur = null; this.w = 0; return; }
    const t = c.st.loop ? c.t % dur : Math.min(c.t, dur);
    // clip locals (relative to the humanoid parent, T-pose based) → world deltas D → corrected for this model's rest:
    // W_b = D_b · S_b⁻¹, local = W_parent⁻¹ · W_b
    const byBone = new Map<VRMHumanBoneName, Track>();
    for (const tr of c.tracks) byBone.set(tr.bone, tr);
    for (const L of this.chain) {
      const tr = byBone.get(L.bone);
      if (tr && !(upperOnly && L.bone === 'hips')) { sampleQuat(tr, t, qa); if (this.vrm0) { qa.x = -qa.x; qa.z = -qa.z; } } else qa.identity();
      const D = this.D.get(L.bone)!, W = this.W.get(L.bone)!;
      D.copy(L.parent ? this.D.get(L.parent)! : qc.identity()).multiply(qa);
      W.copy(D).multiply(L.sInv);
      if (upperOnly && LOWER.has(L.bone)) continue;
      if (!tr && !TDIR[L.bone]) continue;
      qb.copy(L.parent ? this.W.get(L.parent)! : qc.identity()).invert().multiply(W);
      const k = this.w * (HEAD.has(L.bone) ? 1 - this.headKeep : 1);
      L.node.quaternion.slerp(qb, k);
    }
  }

  private build(anim: VRMAnimation): Track[] {
    const out: Track[] = [];
    for (const [bone, tr] of anim.humanoidTracks.rotation.entries()) {
      const node = this.humanoid.getNormalizedBoneNode(bone);
      if (!node) continue;
      out.push({ bone, node, times: tr.times as Float32Array, values: tr.values as Float32Array });
    }
    return out;
  }
}

function sampleQuat(tr: Track, t: number, out: THREE.Quaternion) {
  const T = tr.times, V = tr.values, n = T.length;
  if (n === 1 || t <= T[0]) { out.fromArray(V, 0); return; }
  if (t >= T[n - 1]) { out.fromArray(V, (n - 1) * 4); return; }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
  const a = (t - T[lo]) / Math.max(1e-6, T[hi] - T[lo]);
  out.fromArray(V, lo * 4);
  qb.fromArray(V, hi * 4);
  out.slerp(qb, a);
}
