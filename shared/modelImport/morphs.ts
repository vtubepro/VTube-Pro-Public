// "Just drop a model": what a model's face shapes (morph targets / shape keys / VRM expressions) are for, and the
// profile.faceMap entries that teach the studio the names it wouldn't understand by itself. Builds on the studio's own
// matching (shared/morphNames.ts classifyMorph, "Add my model" suggestFaceMap in src/onboarding/modelCheck.ts) and adds
// the schemes people drop most: ARKit 52 with any prefix / case / _L-_R spelling, Character Creator "A01_Brow_Inner_Up",
// MMD Japanese morphs (あいうえお, まばたき, ウィンク, 笑い, 上, ぺろっ …), VRChat / Oculus visemes (vrc.v_aa, viseme_aa)
// and VRM 0.x / 1.0 expression presets. Pure; tests: tools/model_import_unit.ts.
import { ARKIT, ARKIT_BY_NORM, normKey } from '../../src/core/arkit.ts';
import { classifyMorph, norm2 } from '../morphNames.ts';
import { suggestFaceMap } from '../../src/onboarding/modelCheck.ts';

export type FaceScheme = 'arkit' | 'vrm' | 'mmd' | 'visemes' | 'cc' | 'custom' | 'none';
export const FACE_SCHEME_LABEL: Record<FaceScheme, string> = {
  arkit: 'ARKit (“perfect sync”)', vrm: 'VRM expressions', mmd: 'MMD morphs', visemes: 'VRChat / Oculus visemes',
  cc: 'Character Creator ARKit names', custom: 'own names', none: 'none',
};

export interface MorphReport {
  /** Unique morph / expression names found. */
  total: number;
  /** ARKit channels covered (after matching). */
  arkit: string[];
  /** The five vowels (aa ih ou ee oh) covered. */
  vowels: string[];
  blink: boolean;
  wink: boolean;
  emotions: string[];
  scheme: FaceScheme;
  /** faceMap entries to save (morph name → studio key). Only names the studio wouldn't match by itself. */
  faceMap: Record<string, string>;
  /** Names nothing understood (shown so people can match them by hand in "Add my model"). */
  unknown: string[];
  /** Shapes with no name at all (exported as morph_0, morph_1 …): can't be matched. */
  unnamed: number;
}

// CC4 "Facial Profile: ARKit" ("A01_Brow_Inner_Up" … "A52_Tongue_Out") → strip "Axx_" and match the ARKit name
const CC_ARKIT = /^a\d{2}[_\s-]+/i;
// Meta / Oculus + Ready Player Me visemes
const OCULUS: Record<string, string> = { ve: 'ee', vrcve: 'ee', visemeaa: 'aa', visemee: 'ee', visemei: 'ih', visemeih: 'ih', visemeo: 'oh', visemeoh: 'oh', visemeu: 'ou', visemeou: 'ou' };
// MMD morphs beyond the vowels / blink / emotions shared/morphNames.ts already knows
const MMD: [RegExp, string][] = [
  [/^上$/, 'browInnerUp'], [/^ぺろっ$|^ぺろっ2$|^舌出し$/, 'tongueOut'], [/^ん$/, 'mouthClose'], [/^ウィンク2$|^ｳｨﾝｸ2$/, 'blinkLeft'],
  [/^ウィンク2右$|^ｳｨﾝｸ2右$|^ウィンク右2$/, 'blinkRight'], [/^にこり$|^にっこり$/, 'happy'], [/^怒$/, 'angry'], [/^驚$|^びっくり2$/, 'surprised'],
  [/^ω$|^▲$/, 'mouthPucker'], [/^口角上げ$/, 'happy'], [/^はぅ$/, 'blink'],
];

/** Every key a morph can be matched to by the studio itself (no faceMap needed). */
function ownKey(name: string): string | null {
  const r = classifyMorph(name, null);
  return r ? r.key : null;
}

/** What a name means when the studio's own matching misses it (or null). */
export function extraKey(name: string): string | null {
  const n = name.normalize('NFKC').replace(/^.*[.:|]/, '').trim();
  if (CC_ARKIT.test(n)) { const k = ARKIT_BY_NORM.get(normKey(n.replace(CC_ARKIT, ''))); if (k) return k; }
  const o = OCULUS[norm2(n)];
  if (o) return o;
  for (const [re, k] of MMD) if (re.test(n)) return k;
  // "Blink_L" / "EyeBlinkL" / "eye_blink_left" with any prefix ("Face.M_F00_000_00_Fcl_…" is handled by suggestFaceMap)
  const k = ARKIT_BY_NORM.get(normKey(n));
  return k ?? null;
}

/** Morph names (+ VRM expressions) → the report and the faceMap to save. `vrm` = the file is a VRM (its expressions
 *  drive the morphs; raw morph names aren't matched one by one). */
export function analyzeMorphs(morphs: readonly string[], opts: { vrmExpressions?: readonly string[]; vrm?: boolean } = {}): MorphReport {
  const names = [...new Set(morphs.filter((m) => m && !m.startsWith('vtp_')))];
  const unnamed = names.filter((m) => /^(morph|target|shape|key)[_\s-]?\d+$/i.test(m)).length;
  const faceMap: Record<string, string> = {};
  const keys = new Set<string>();
  const taken = new Set<string>();
  const unknown: string[] = [];
  let cc = 0, mmd = 0, vis = 0, ark = 0;
  if (!opts.vrm) {
    // 1. the studio's own matching
    for (const m of names) {
      const k = ownKey(m);
      if (k) { keys.add(k); taken.add(k); if (ARKIT_BY_NORM.has(k.toLowerCase())) ark++; if (/[぀-ヿ一-鿿]/.test(m)) mmd++; if (/^vrc\.|^v_/i.test(m)) vis++; }
    }
    // 2. "Add my model" suggestions (VRoid Fcl_* in a plain GLB, "MouthOpen", "Smile_L" …)
    for (const s of suggestFaceMap(names, { vrm: false, existing: null })) {
      if (taken.has(s.key)) continue;
      faceMap[s.morph] = s.key; keys.add(s.key); taken.add(s.key);
    }
    // 3. our extra schemes
    for (const m of names) {
      if (ownKey(m) || faceMap[m]) continue;
      const k = extraKey(m);
      if (k && !taken.has(k)) {
        faceMap[m] = k; keys.add(k); taken.add(k);
        if (CC_ARKIT.test(m)) cc++; else if (/^viseme/i.test(m)) vis++; else if (/[぀-ヿ一-鿿]/.test(m.normalize('NFKC'))) mmd++; else ark++;
      } else if (!k && !/^(morph|target|shape|key)[_\s-]?\d+$/i.test(m)) unknown.push(m);
    }
  }
  // VRM expressions (presets + custom ones named like ARKit)
  const vrmPreset: Record<string, string> = { aa: 'aa', a: 'aa', ih: 'ih', i: 'ih', ou: 'ou', u: 'ou', ee: 'ee', e: 'ee', oh: 'oh', o: 'oh', blink: 'blink', blinkleft: 'blinkLeft', blinkright: 'blinkRight', blinkl: 'blinkLeft', blinkr: 'blinkRight', happy: 'happy', joy: 'happy', angry: 'angry', sad: 'sad', sorrow: 'sad', surprised: 'surprised', relaxed: 'happy', fun: 'happy' };
  let vrmCount = 0;
  for (const e of opts.vrmExpressions ?? []) {
    const p = vrmPreset[norm2(e)];
    if (p) { keys.add(p); vrmCount++; continue; }
    const k = ARKIT_BY_NORM.get(normKey(e));
    if (k) { keys.add(k); ark++; }
  }
  const arkit = ARKIT.filter((k) => keys.has(k));
  const vowels = ['aa', 'ih', 'ou', 'ee', 'oh'].filter((k) => keys.has(k));
  const blink = keys.has('blink') || (keys.has('eyeBlinkLeft') && keys.has('eyeBlinkRight')) || (keys.has('blinkLeft') && keys.has('blinkRight'));
  const wink = (keys.has('eyeBlinkLeft') && keys.has('eyeBlinkRight')) || (keys.has('blinkLeft') && keys.has('blinkRight'));
  const emotions = ['happy', 'angry', 'sad', 'surprised'].filter((k) => keys.has(k));
  const scheme: FaceScheme = arkit.length >= 40 ? (cc > 20 ? 'cc' : 'arkit')
    : opts.vrm && vrmCount ? 'vrm'
      : mmd >= 3 ? 'mmd'
        : vis >= 3 ? 'visemes'
          : arkit.length >= 10 ? 'arkit'
            : keys.size ? 'custom' : 'none';
  return { total: names.length + (opts.vrmExpressions?.length ?? 0), arkit, vowels, blink, wink, emotions, scheme, faceMap, unknown: unknown.slice(0, 60), unnamed };
}
