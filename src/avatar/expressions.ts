// Drive a model's OWN face shapes (when it has them): ARKit "perfect sync" morphs, VRM expression
// presets, VRM0/VRChat visemes, and MMD (Japanese) morph names. Also estimates emotions so models
// with only preset expressions (happy/angry/sad/surprised) still copy the performer's mood.

import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { ARKIT, ARKIT_BY_NORM, normKey } from '../core/arkit.ts';
import { classifyMorph } from '../../shared/morphNames.ts';
import { clamp01 } from '../tracking/filters.ts';
import type { TrackingFrame } from '../../shared/types.ts';

export type Target = { mesh: THREE.Mesh; index: number };

export interface Emotions { happy: number; sad: number; angry: number; surprised: number; relaxed: number }

export function estimateEmotions(f: Record<string, number>): Emotions {
  const g = (k: string) => f[k] ?? 0;
  const avg = (a: string, b: string) => (g(a) + g(b)) / 2;
  const smile = avg('mouthSmileLeft', 'mouthSmileRight');
  const frown = avg('mouthFrownLeft', 'mouthFrownRight');
  const browDown = avg('browDownLeft', 'browDownRight');
  const browOuter = avg('browOuterUpLeft', 'browOuterUpRight');
  const wide = avg('eyeWideLeft', 'eyeWideRight');
  const sneer = avg('noseSneerLeft', 'noseSneerRight');
  const cheek = avg('cheekSquintLeft', 'cheekSquintRight');
  return {
    happy: clamp01(smile * 1.1 + cheek * 0.3 - frown * 0.5),
    sad: clamp01(frown * 0.8 + g('browInnerUp') * 0.55 - smile * 0.8 - browDown * 0.2),
    angry: clamp01(browDown * 0.9 + sneer * 0.45 - smile * 0.6),
    surprised: clamp01(browOuter * 0.55 + wide * 0.55 + g('jawOpen') * 0.2 - browDown * 0.6),
    relaxed: clamp01((1 - g('jawOpen')) * cheek * 0.3),
  };
}

/** Vowel visemes from the mouth summary. */
export function visemes(m: TrackingFrame['mouth']) {
  const round = Math.max(m.pucker, m.funnel);
  const open = m.open;
  let aa = open * (1 - round) * (1 - m.wide * 0.4);
  let ee = m.wide * clamp01(open * 2.5) * (1 - round) * 0.8;
  let ih = m.wide * (1 - open) * 0.5;
  let oh = m.funnel * clamp01(open * 2);
  let ou = m.pucker * (1 - open * 0.7);
  const sum = aa + ee + ih + oh + ou;
  if (sum > 1) { aa /= sum; ee /= sum; ih /= sum; oh /= sum; ou /= sum; }
  return { aa, ih, ou, ee, oh };
}

// morph-name roles (ARKit / VRM0 / VRChat / MMD presets / the performer's faceMap): shared/morphNames.ts

export class ExpressionDriver {
  private arkit = new Map<string, Target[]>();
  private named = new Map<string, Target[]>();
  private vrmArkit = new Set<string>();
  readonly hasArkit: boolean;
  readonly hasVisemes: boolean;
  readonly hasBlink: boolean;
  /** VRM emotion presets whose `overrideMouth` blocks/blends the mouth presets (they'd erase visemes). */
  readonly mouthBlockers: Map<string, 'block' | 'blend'> = new Map();

  /** @param faceMap the performer's own morph → shape picks (profile.faceMap, the "Add my model" wizard) */
  constructor(root: THREE.Object3D, private vrm: VRM | null, faceMap?: Readonly<Record<string, string>> | null) {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.morphTargetDictionary || m.userData.vtpGenerated || m.userData.vtpOutline) return;
      for (const [name, index] of Object.entries(m.morphTargetDictionary)) {
        // optional per-model speech shapes (not ARKit): 'tongueUp' (L / N / D tongue tip behind the upper teeth),
        // 'tongueTip' (TH) — driven from the viseme rig's articulators by applySpeechExtras()
        const role = classifyMorph(name, faceMap);
        if (!role) continue;
        if (role.kind === 'extra') push(this.speechExtras, role.key, { mesh: m, index });
        else if (role.kind === 'arkit') push(this.arkit, role.key, { mesh: m, index });
        else push(this.named, role.key, { mesh: m, index });
      }
    });
    if (vrm?.expressionManager) {
      for (const e of vrm.expressionManager.expressions) {
        const ak = ARKIT_BY_NORM.get(normKey(e.expressionName));
        if (ak) this.vrmArkit.add(e.expressionName);
      }
    }
    this.hasArkit = this.arkit.size >= 10 || this.vrmArkit.size >= 10;
    for (const n of ['happy', 'angry', 'sad', 'surprised', 'relaxed']) {
      const o = vrm?.expressionManager?.getExpression(n)?.overrideMouth;
      if (o === 'block' || o === 'blend') this.mouthBlockers.set(n, o);
    }
    const em = vrm?.expressionManager;
    this.hasVisemes = this.named.has('aa') || !!em?.getExpression('aa');
    this.hasBlink = this.hasArkit || this.named.has('blink') || !!em?.getExpression('blink');
  }

  get summary() {
    return { arkit: this.arkit.size + this.vrmArkit.size, named: [...this.named.keys()], vrm: !!this.vrm };
  }

  /** ARKit channel names the model has its own shapes for (mesh morphs or VRM custom expressions). */
  arkitKeys(): Set<string> { return new Set([...this.arkit.keys(), ...this.vrmArkit]); }
  /** Mesh morph targets for an ARKit channel / a named viseme or emotion (for measuring rig strength). */
  arkitTargets(name: string): readonly Target[] { return this.arkit.get(name) ?? []; }
  namedTargets(name: string): readonly Target[] { return this.named.get(name) ?? []; }
  private speechExtras = new Map<string, Target[]>();
  /** Model-supplied speech shapes ('tongueUp' / 'tongueTip' morphs) follow the viseme rig's tongue articulators.
   *  No-op for models without such morphs. */
  applySpeechExtras(x?: { tongueUp: number; tongueTip: number }) {
    if (!this.speechExtras.size) return;
    for (const [k, targets] of this.speechExtras) {
      const v = clamp01(x ? (k === 'tongueUp' ? x.tongueUp : x.tongueTip) : 0);
      for (const t of targets) t.mesh.morphTargetInfluences![t.index] = v;
    }
  }

  /** Per-channel output gains (model-strength normalisation, visemeRig.ts). Unset = 1. */
  gains = new Map<string, number>();

  /**
   * @param opts.vowels  viseme-rig vowel preset weights (aa/ih/ou/ee/oh) replacing the mouth-summary guess
   * @param opts.emotionCap  scale on preset emotions (VRM emotions that block the mouth are eased while talking)
   */
  apply(frame: TrackingFrame, emotionScale = 1, opts?: { vowels?: Record<string, number>; emotionCap?: Record<string, number> }) {
    const f = frame.face;
    const em = this.vrm?.expressionManager;
    // normalised, but never extrapolated past the authored shape (influence > 1 tears / crosses the lips)
    const gain = (n: string, v: number) => { const k = this.gains.get(n); return k === undefined ? v : Math.min(Math.max(v, 1), v * k, 1); };
    // 1) perfect sync
    if (this.hasArkit) {
      for (const name of ARKIT) {
        const v = gain(name, f[name] ?? 0);
        for (const t of this.arkit.get(name) ?? []) t.mesh.morphTargetInfluences![t.index] = v;
      }
      if (em) for (const n of this.vrmArkit) em.setValue(n, gain(n, f[n] ?? 0));
      return;
    }
    // partial ARKit sets (a few smile/frown/pucker shapes on a jaw-rigged model) still follow the face
    for (const [name, targets] of this.arkit) {
      const v = gain(name, f[name] ?? 0);
      for (const t of targets) t.mesh.morphTargetInfluences![t.index] = v;
    }
    // 2) presets / visemes / emotions
    const vis0 = visemes(frame.mouth);
    const vis = opts?.vowels ? { aa: opts.vowels.aa ?? 0, ih: opts.vowels.ih ?? 0, ou: opts.vowels.ou ?? 0, ee: opts.vowels.ee ?? 0, oh: opts.vowels.oh ?? 0 } : vis0;
    for (const k of ['aa', 'ih', 'ou', 'ee', 'oh'] as const) vis[k] = gain(k, vis[k]);
    const emo = estimateEmotions(f);
    const cap = opts?.emotionCap;
    if (cap) for (const k of Object.keys(emo) as (keyof Emotions)[]) emo[k] *= cap[k] ?? 1;
    const blinkL = f.eyeBlinkLeft ?? 0, blinkR = f.eyeBlinkRight ?? 0;
    const both = Math.min(blinkL, blinkR);
    const vals: Record<string, number> = {
      ...vis,
      blink: both, blinkLeft: blinkL - both, blinkRight: blinkR - both,
      happy: emo.happy * emotionScale, angry: emo.angry * emotionScale, sad: emo.sad * emotionScale,
      surprised: emo.surprised * emotionScale, relaxed: emo.relaxed * emotionScale,
    };
    // happy "^^" eyes already close the lids on most VRMs — avoid double-closing
    const lidFromEmotion = vals.happy * 0.6;
    vals.blink = Math.max(0, vals.blink - lidFromEmotion);
    if (em) {
      for (const [k, v] of Object.entries(vals)) if (em.getExpression(k)) em.setValue(k, v);
    }
    for (const [k, targets] of this.named) {
      const v = vals[k] ?? 0;
      for (const t of targets) t.mesh.morphTargetInfluences![t.index] = v;
    }
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v); else m.set(k, [v]);
}
