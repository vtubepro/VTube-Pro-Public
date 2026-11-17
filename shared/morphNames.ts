// Which face shape a morph target name means: ARKit "perfect sync" channels, VRM0 / VRChat / MMD vowel + blink +
// emotion presets, the optional speech extras, and the performer's own picks from the "Add my model" wizard
// (profile.faceMap: morph name → key). Pure (no three.js): src/avatar/expressions.ts drives the shapes, the model
// wizard (src/onboarding/modelCheck.ts) reports and suggests mappings. Tests: tools/onboarding_unit.ts.
import { ARKIT, ARKIT_BY_NORM, normKey, type ArkitName } from '../src/core/arkit.ts';

/** Named presets the expression driver understands (besides the 52 ARKit channels). */
export const VISEME_NAMES: Record<string, string[]> = {
  aa: ['a', 'aa', 'vrcvaa', 'mouth_a', 'mtha', 'あ', 'vaa'],
  ih: ['i', 'ih', 'vrcvih', 'mouth_i', 'mthi', 'い', 'vih'],
  ou: ['u', 'ou', 'vrcvou', 'mouth_u', 'mthu', 'う', 'vou'],
  ee: ['e', 'ee', 'vrcvee', 'mouth_e', 'mthe', 'え', 'vee'],
  oh: ['o', 'oh', 'vrcvoh', 'mouth_o', 'mtho', 'お', 'voh'],
  blink: ['blink', 'まばたき', 'eyeclose', 'eyesclosed', 'blinkboth'],
  blinkLeft: ['blinkl', 'blinkleft', 'ウィンク', 'winkl', 'eyecloseleft'],
  blinkRight: ['blinkr', 'blinkright', 'ウィンク右', 'winkr', 'eyecloseright'],
  happy: ['joy', 'happy', 'smile', '笑い', 'にこり', 'fun'],
  angry: ['angry', '怒り', 'anger'],
  sad: ['sorrow', 'sad', '困る', 'sadness'],
  surprised: ['surprised', 'surprise', '驚き', 'びっくり'],
};
export const NAMED_KEYS: readonly string[] = Object.keys(VISEME_NAMES);
/** Every key a faceMap value may name ('' = "ignore this shape"). */
export const FACE_MAP_KEYS: ReadonlySet<string> = new Set<string>([...ARKIT, ...NAMED_KEYS]);

const SPEECH_EXTRA: Record<string, 'tongueUp' | 'tongueTip'> = { tongueup: 'tongueUp', tonguetip: 'tongueTip' };
export const norm2 = (s: string) => s.toLowerCase().replace(/^.*[.:|]/, '').replace(/[\s_.\-]/g, '');
const VISEME_LOOKUP = new Map<string, string>();
for (const [k, names] of Object.entries(VISEME_NAMES)) for (const n of names) VISEME_LOOKUP.set(norm2(n), k);

export type MorphRole =
  | { kind: 'arkit'; key: ArkitName }
  | { kind: 'named'; key: string }
  | { kind: 'extra'; key: 'tongueUp' | 'tongueTip' };

/** What a morph target does for the expression driver, or null (unknown / ignored / internal). */
export function classifyMorph(name: string, faceMap?: Readonly<Record<string, string>> | null): MorphRole | null {
  if (name.startsWith('vtp_')) return null;
  if (faceMap && Object.prototype.hasOwnProperty.call(faceMap, name)) {
    const v = faceMap[name];
    if (!v) return null;                                           // the performer said "ignore this one"
    const ak = ARKIT_BY_NORM.get(v.toLowerCase());
    if (ak) return { kind: 'arkit', key: ak };
    if (NAMED_KEYS.includes(v)) return { kind: 'named', key: v };
  }
  const sx = SPEECH_EXTRA[norm2(name)];
  if (sx) return { kind: 'extra', key: sx };
  const ak = ARKIT_BY_NORM.get(normKey(name));
  if (ak) return { kind: 'arkit', key: ak };
  const vk = VISEME_LOOKUP.get(norm2(name));
  return vk ? { kind: 'named', key: vk } : null;
}

/** A clean faceMap (≤ 400 entries, known keys only) or undefined. */
export function sanitizeFaceMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (n >= 400) break;
    if (typeof k !== 'string' || !k || k.length > 128 || typeof val !== 'string') continue;
    if (val !== '' && !FACE_MAP_KEYS.has(val)) continue;
    out[k] = val; n++;
  }
  return n ? out : undefined;
}
