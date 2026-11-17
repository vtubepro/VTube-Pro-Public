// "Add my model" wizard: the pure logic. What a loaded model can do (face capabilities), the friendly report card,
// face-shape name matching for models whose shapes have unusual names (VRoid Fcl_* in a plain GLB, "MouthOpen",
// "Smile_L" …), and the "Set it up for me" plan. No DOM, no three.js: the wizard (src/ui/modelWizard.ts) feeds it
// facts measured from the loaded model (src/onboarding/modelPreview.ts) and applies the plan; the unit tests
// (tools/onboarding_unit.ts) feed it facts read from the built-in sample models (src/onboarding/scanGltf.ts).
// Words follow docs/ARTIST_AVATARS.md and T\portal\BRAND.md §6 (plain words, one sentence per problem).
import type { AvatarProfile } from '../../shared/types.ts';
import { checkFormat, type Level, type RigFacts } from '../../shared/importCheck.ts';
import { classifyMorph, norm2 } from '../../shared/morphNames.ts';
import { ARKIT } from '../core/arkit.ts';

const ARKIT_KEYS: ReadonlySet<string> = new Set<string>(ARKIT);
import { readNative, fmtM } from '../../shared/avatarSize.ts';
import { fmtTris } from '../../shared/modelStats.ts';

/** Everything the wizard knows about a model. RigFacts (shared/importCheck.ts) + the names it found. */
export interface ModelFacts extends RigFacts {
  /** The file the performer picked (only its extension matters here). */
  file: string;
  /** Morph target (shape key) names on the model's meshes, unique. */
  morphs: readonly string[];
  /** VRM expression names (presets like aa / blink / happy and custom ones). */
  vrmExpressions: readonly string[];
  /** The eyes can turn: VRM look-at or leftEye / rightEye bones. */
  lookAt: boolean;
  /** VRM spring-bone joints, or (GLB) bones whose names start automatic spring chains (hair, skirt, tail …). */
  springs: number;
  /** Robot / prop / toy (rigid parts). */
  mechanical: boolean;
  /** Four-legged body (profile body 'quadruped'). */
  quadruped?: boolean;
  /** The model has colour textures (painted eyes are possible). */
  textured?: boolean;
  /** The model faces away from the camera (−Z) in its file: its left arm / leg is on the wrong side. */
  facesAway?: boolean;
  /** …and VTube Pro already turned it around (profile transform.yaw 180). */
  turned?: boolean;
  /** The face-shape picks in effect (profile.faceMap). */
  faceMapCurrent?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------- face capabilities

export interface FaceCaps {
  /** Own ARKit channels (mesh morphs + VRM custom expressions, after the faceMap). */
  arkit: string[];
  /** Named presets (aa ih ou ee oh blink blinkLeft blinkRight happy angry sad surprised). */
  named: string[];
  smile: boolean;
  blink: boolean;
  /** One eye at a time. */
  wink: boolean;
  /** How the mouth talks: own shapes (ARKit), vowel presets, a jaw bone, VTube Pro's drawn mouth, or not at all. */
  mouth: 'shapes' | 'vowels' | 'jaw' | 'drawn' | 'none';
  /** Which of the five vowels have their own shape (aa ih ou ee oh). */
  vowels: string[];
  /** Lips can seal for M / B / P. */
  seal: boolean;
  brows: boolean;
  /** Emotion presets (happy angry sad surprised). */
  emotions: string[];
  /** The eyes can look around. */
  look: boolean;
  /** Eyes are VTube Pro's drawn eyes. */
  drawnEyes: boolean;
}

const VRM_PRESET: Record<string, string> = {
  // VRM 1.0 preset names → driver keys (VRM 0.x names go through classifyMorph: a i u e o joy sorrow …)
  aa: 'aa', ih: 'ih', ou: 'ou', ee: 'ee', oh: 'oh', blink: 'blink', blinkleft: 'blinkLeft', blinkright: 'blinkRight',
  happy: 'happy', angry: 'angry', sad: 'sad', surprised: 'surprised', blinkl: 'blinkLeft', blinkr: 'blinkRight',
};

export function faceCaps(f: ModelFacts, faceMap: Readonly<Record<string, string>> | null | undefined = f.faceMapCurrent): FaceCaps {
  const arkit = new Set<string>(), named = new Set<string>();
  for (const m of f.morphs) {
    // a VRM drives its mesh morphs through its expressions: its raw morph names don't count on their own
    if (f.vrm && !faceMap?.[m]) continue;
    const r = classifyMorph(m, faceMap);
    if (r?.kind === 'arkit') arkit.add(r.key); else if (r?.kind === 'named') named.add(r.key);
  }
  for (const e of f.vrmExpressions) {
    const p = VRM_PRESET[norm2(e)];
    if (p) { named.add(p); continue; }
    const r = classifyMorph(e, null);
    if (r?.kind === 'arkit') arkit.add(r.key); else if (r?.kind === 'named') named.add(r.key);
  }
  for (const n of f.named) { const r = classifyMorph(n, null); if (r?.kind === 'named') named.add(r.key); else if (VRM_PRESET[norm2(n)]) named.add(VRM_PRESET[norm2(n)]); }
  const A = (k: string) => arkit.has(k), N = (k: string) => named.has(k);
  const vowels = ['aa', 'ih', 'ou', 'ee', 'oh'].filter(N);
  const mouthShapes = [...arkit].filter((k) => k.startsWith('mouth') || k === 'jawOpen').length;
  const drawnMouth = !!f.drawnFace && !A('jawOpen') && !vowels.length;
  const mouth: FaceCaps['mouth'] = mouthShapes >= 3 ? 'shapes' : vowels.length || A('jawOpen') ? 'vowels' : f.jaw ? 'jaw' : drawnMouth ? 'drawn' : 'none';
  const blinkShapes = (A('eyeBlinkLeft') && A('eyeBlinkRight')) || N('blink') || (N('blinkLeft') && N('blinkRight'));
  return {
    arkit: [...arkit].sort(), named: [...named].sort(),
    smile: A('mouthSmileLeft') || A('mouthSmileRight') || N('happy'),
    blink: blinkShapes || !!f.drawnFace,
    wink: (A('eyeBlinkLeft') && A('eyeBlinkRight')) || (N('blinkLeft') && N('blinkRight')),
    mouth, vowels,
    seal: A('mouthClose') || A('mouthPressLeft') || A('mouthPressRight'),
    brows: A('browInnerUp') || A('browDownLeft') || A('browOuterUpLeft'),
    emotions: ['happy', 'angry', 'sad', 'surprised'].filter(N),
    look: f.lookAt || A('eyeLookOutLeft') || A('eyeLookInLeft') || !!f.drawnFace,
    drawnEyes: !!f.drawnFace,
  };
}

// ---------------------------------------------------------------- face-shape name matching (the faceMap)

/** Name rules for shapes the automatic matching misses. Tested on the normalised name (lower case, no separators,
 *  prefixes like "blendShape1." / "Face." removed). First rule wins; each target key is taken once (sided keys once
 *  per side), so "Fcl_ALL_Joy" and "Fcl_ALL_Fun" don't both drive "happy". */
const RULES: [RegExp, string][] = [
  // VRoid Studio (Fcl_*) when exported as a plain GLB / FBX instead of VRM (docs/ARTIST_AVATARS.md §4 "Gotcha")
  [/fclmtha$/, 'aa'], [/fclmthi$/, 'ih'], [/fclmthu$/, 'ou'], [/fclmthe$/, 'ee'], [/fclmtho$/, 'oh'],
  [/fcleyeclosel$/, 'blinkLeft'], [/fcleyecloser$/, 'blinkRight'], [/fcleyeclose$/, 'blink'],
  [/fclalljoy$/, 'happy'], [/fclallangry$/, 'angry'], [/fclallsorrow$/, 'sad'], [/fclallsurprised$/, 'surprised'], [/fclallfun$/, 'happy'],
  [/fclmthclose$/, 'mouthClose'],
  // common hand-made names
  [/^(mouthopen|openmouth|jawdown|openjaw|mouthwideopen|mawopen|jaw)$/, 'jawOpen'],
  [/^(smile|grin|mouthsmile)(l|left)$/, 'mouthSmileLeft'], [/^(smile|grin|mouthsmile)(r|right)$/, 'mouthSmileRight'],
  [/^(laugh|grin|smiling|happyface|mouthsmile)$/, 'happy'],
  [/^(eyeclosedl|eyeclosel|closeeyel|closeeyeleft|eyesclosedl|blinkingl|lidl)$/, 'blinkLeft'],
  [/^(eyeclosedr|eyecloser|closeeyer|closeeyeright|eyesclosedr|blinkingr|lidr)$/, 'blinkRight'],
  [/^(eyesclose|closeeyes|closedeyes|eyeclosed|eyesshut|blinking|blinkall)$/, 'blink'],
  [/^(frown|frowning|crying|cry|sadface)$/, 'sad'],
  [/^(mad|angryface|rage)$/, 'angry'],
  [/^(shock|shocked|wow|surprisedface)$/, 'surprised'],
  [/^(pucker|kiss|lipspucker)$/, 'mouthPucker'],
  [/^(ooh|oo|mouthoo)$/, 'ou'], [/^(aah|ah|mouthah)$/, 'aa'], [/^(eeh|mouthee)$/, 'ee'], [/^(ohh|mouthoh)$/, 'oh'],
  [/^(browsup|browup|eyebrowsup|eyebrowup|browraise|browsraised)$/, 'browInnerUp'],
  [/^(tongue|tonguestickout)$/, 'tongueOut'],
  [/^(puff|cheeksPuff|puffcheeks)$/i, 'cheekPuff'],
];
const stripName = (s: string) => norm2(s).replace(/^(blendshape\d*|shapekey|key|morph|bs)/, '');

export interface FaceMatch { morph: string; key: string }

/** Suggested faceMap entries for shapes the automatic matching doesn't understand. Never touches names it already
 *  understands, never maps two shapes onto one key. VRM files drive their face through expressions: no suggestions. */
export function suggestFaceMap(morphs: readonly string[], opts: { vrm?: boolean; existing?: Readonly<Record<string, string>> | null } = {}): FaceMatch[] {
  if (opts.vrm) return [];
  const taken = new Set<string>();
  let arkit = 0;
  for (const m of morphs) { const r = classifyMorph(m, opts.existing); if (r && r.kind !== 'extra') { if (r.kind === 'arkit' && !taken.has(r.key)) arkit++; taken.add(r.key); } }
  // 10+ ARKit shapes = "perfect sync": the driver then uses ARKit channels only, so named presets would do nothing
  const perfect = arkit >= 10;
  const cands: { morph: string; rule: number }[] = [];
  for (const m of morphs) {
    if (opts.existing && Object.prototype.hasOwnProperty.call(opts.existing, m)) continue;
    if (classifyMorph(m, null)) continue;
    const n = stripName(m);
    const rule = RULES.findIndex(([re, key]) => re.test(n) && (!perfect || ARKIT_KEYS.has(key)));
    if (rule >= 0) cands.push({ morph: m, rule });
  }
  // the strongest rule wins a key ("Fcl_ALL_Joy" beats "Fcl_ALL_Fun" for happy), then file order
  cands.sort((a, b) => a.rule - b.rule);
  const out: FaceMatch[] = [];
  for (const c of cands) {
    const key = RULES[c.rule][1];
    if (taken.has(key)) continue;
    taken.add(key);
    out.push({ morph: c.morph, key });
  }
  return out;
}

/** The face is driven by ARKit channels only (10+ own ARKit shapes, "perfect sync"). */
export function perfectSync(morphs: readonly string[], faceMap?: Readonly<Record<string, string>> | null): boolean {
  const k = new Set<string>();
  for (const m of morphs) { const r = classifyMorph(m, faceMap); if (r?.kind === 'arkit') k.add(r.key); }
  return k.size >= 10;
}

/** Morph names neither the matcher nor a suggestion understands (offered in the walkthrough's face step). */
export function unknownMorphs(morphs: readonly string[], faceMap?: Readonly<Record<string, string>> | null): string[] {
  return morphs.filter((m) => !m.startsWith('vtp_') && !classifyMorph(m, faceMap));
}

/** A shape name a person can read: "Face.M_F00_000_00_Fcl_ALL_Joy" → "Joy", "Fcl_EYE_Close_L" → "Left eye closed",
 *  "blendShape1.mouthSmile_L" → "Mouth smile left", "MouthOpen" → "Mouth open". The raw name stays in the profile. */
export function friendlyShapeName(raw: string): string {
  let s = raw.replace(/^.*[.:|]/, '');                                   // "Face." / "blendShape1." / "mesh:"
  s = s.replace(/^M_F\d+_\d+_\d+_/i, '');                                // VRoid material prefix
  const v = /^Fcl_(ALL|BRW|EYE|MTH|HA|EXTRA)_(.+)$/i.exec(s);
  if (v) {
    const part = v[1].toUpperCase(), rest = v[2];
    const side = /_L$/i.test(rest) ? 'Left ' : /_R$/i.test(rest) ? 'Right ' : '';
    const what = rest.replace(/_[LR]$/i, '');
    if (part === 'MTH' && /^[AIUEO]$/i.test(what)) return `Mouth “${what.toUpperCase()}”`;
    if (part === 'EYE' && /^close$/i.test(what)) return side ? `${side}eye closed` : 'Eyes closed';
    const word = words(what);
    const area: Record<string, string> = { ALL: '', BRW: 'Brows ', EYE: side ? `${side}eye ` : 'Eyes ', MTH: 'Mouth ', HA: 'Teeth ', EXTRA: '' };
    const out = `${area[part] ?? ''}${area[part] ? word.toLowerCase() : word}`;
    return out.charAt(0).toUpperCase() + out.slice(1);
  }
  const w = words(s.replace(/^(blendshape\d*|shapekey|bs)_?/i, ''));
  return w || raw;
}
const SIDE_WORD: Record<string, string> = { l: 'left', r: 'right', left: 'left', right: 'right' };
function words(s: string): string {
  const parts = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_.\-]+/).filter(Boolean).map((p) => p.toLowerCase());
  const out = parts.map((p, i) => (i === parts.length - 1 && SIDE_WORD[p] && parts.length > 1 ? SIDE_WORD[p] : p)).join(' ');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** The face jobs the walkthrough asks about, in plain words, with the key each one maps to. */
export const FACE_ROLES: { key: string; ask: string; job: string; test: string }[] = [
  { key: 'jawOpen', ask: 'Which shape opens the mouth?', job: 'Open mouth', test: 'Say “Ahh”' },
  { key: 'happy', ask: 'Which shape makes your model smile?', job: 'Smile', test: 'Smile' },
  { key: 'blink', ask: 'Which shape closes the eyes?', job: 'Blink', test: 'Blink' },
  { key: 'ou', ask: 'Which shape makes an “Ooh” mouth?', job: 'Say “Ooh”', test: 'Say “Ooh”' },
  { key: 'surprised', ask: 'Which shape looks surprised?', job: 'Surprised', test: 'Surprised' },
  { key: 'angry', ask: 'Which shape looks angry?', job: 'Angry', test: 'Angry' },
  { key: 'sad', ask: 'Which shape looks sad?', job: 'Sad', test: 'Sad' },
];

// ---------------------------------------------------------------- the report card

export interface ReportLine { id: string; level: Level; text: string; detail?: string; needsHelper?: boolean }
export interface ReportEnv {
  /** The VTube Pro Helper is reachable (local studio = always). null = not known yet. */
  helper: boolean | null;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Before loading: can this file be opened at all, and where (browser / helper)? */
export function fileLine(file: string, env: ReportEnv): ReportLine {
  const fc = checkFormat(file, null);
  if (!fc.format) return { id: 'file', level: 'bad', text: 'We can’t open this kind of file', detail: 'Use a .vrm (VRoid Studio), .glb or .fbx file. Most 3D programs can export .glb.' };
  if (fc.needsBlender) {
    return env.helper
      ? { id: 'file', level: 'ok', text: `Your ${fc.format.label} file will be converted on your PC ✔`, detail: 'VTube Pro turns it into a model the studio can use (Blender does the work). Big files take a minute.' }
      : { id: 'file', level: 'warn', text: `${fc.format.label} files need VTube Pro`, detail: 'VTube Pro converts them on your computer. Or export a .glb or .vrm from your 3D program: those open right here.', needsHelper: true };
  }
  if (fc.ext === '.gltf') return { id: 'file', level: 'ok', text: 'Your model file opens right here ✔', detail: 'A .gltf must be one single file. If the colours are missing, export a .glb instead.' };
  return { id: 'file', level: 'ok', text: 'Your model file opens right here ✔', detail: fc.ext === '.vrm' ? 'VRM (VRoid Studio): its face, eyes and hair settings come along.' : undefined };
}

/** After loading: what the model can do, in plain sentences. */
export function reportCard(f: ModelFacts, env: ReportEnv): ReportLine[] {
  const out: ReportLine[] = [fileLine(f.file, env)];
  const caps = faceCaps(f);
  // what the face can do once its unusually named shapes are matched ("Set it up for me" does that)
  const sugg = suggestFaceMap(f.morphs, { vrm: f.vrm, existing: f.faceMapCurrent });
  const pot = sugg.length ? faceCaps(f, { ...(f.faceMapCurrent ?? {}), ...Object.fromEntries(sugg.map((s) => [s.morph, s.key])) }) : caps;
  const has = new Set(f.bones);
  const arms = ['leftUpperArm', 'rightUpperArm'].every((b) => has.has(b));
  if (f.facesAway) out.push(f.turned ? { id: 'facing', level: 'ok', text: 'Your model was saved facing away — we turned it around ✔', detail: 'Your file isn’t changed.' }
    : { id: 'facing', level: 'warn', text: 'Your model faces away from the camera — we can turn it around', detail: 'It was saved facing backwards. Turning it doesn’t change your file.' });
  const legs = ['leftUpperLeg', 'rightUpperLeg'].every((b) => has.has(b));
  // body
  if (f.quadruped) out.push({ id: 'body', level: 'ok', text: 'Your four-legged model will follow your head ✔', detail: 'Its legs stand and walk by themselves.' });
  else if (f.rig === 'vrm' || f.rig === 'humanoid') {
    if (arms && legs) out.push({ id: 'body', level: 'ok', text: 'Your model has a full skeleton: head, arms and legs follow you ✔' });
    else if (arms) out.push({ id: 'body', level: 'ok', text: 'Head, body and arms follow you ✔', detail: 'No legs we recognise: fine for a waist-up avatar.' });
    else out.push({ id: 'body', level: 'warn', text: 'Your model’s head and body follow you, but its arms won’t move', detail: 'We couldn’t find arm bones. VTube Pro can give it a new skeleton.', needsHelper: !env.helper });
  } else if (f.rig === 'soft') out.push({ id: 'body', level: 'warn', text: 'Your model has no skeleton: it will lean and nod with you, but arms won’t move', detail: 'VTube Pro can add a real skeleton (Blender, on your PC, about a minute).', needsHelper: !env.helper });
  else out.push({ id: 'body', level: 'bad', text: 'Your model has no skeleton: it moves as one piece', detail: 'VTube Pro can add a skeleton so the head, arms and body follow you.', needsHelper: !env.helper });
  if ((f.rig === 'vrm' || f.rig === 'humanoid') && arms && !f.quadruped) {
    const fingers = ['leftIndexProximal', 'leftMiddleProximal'].some((b) => has.has(b));
    out.push(fingers ? { id: 'fingers', level: 'ok', text: 'Its fingers can copy your hands ✔' } : { id: 'fingers', level: 'warn', text: 'No finger bones: the hands stay open', detail: 'That’s fine. Hands still move with your arms.' });
  }
  // face
  out.push(caps.smile ? { id: 'smile', level: 'ok', text: 'Your model’s face can smile ✔' }
    : pot.smile ? { id: 'smile', level: 'warn', text: 'Your model can smile once we match its face shapes', detail: 'Its smile shape has a name VTube Pro doesn’t know yet.' }
    : { id: 'smile', level: 'warn', text: 'Your model can’t smile yet', detail: caps.mouth === 'none' ? 'We can add a drawn mouth that smiles and talks with you.' : 'It will still talk; smiles show on a drawn mouth only.' });
  const mouthText: Record<FaceCaps['mouth'], ReportLine> = {
    shapes: { id: 'mouth', level: 'ok', text: `Its mouth can talk and make faces (${plural(caps.arkit.filter((k) => k.startsWith('mouth') || k === 'jawOpen').length, 'mouth shape')}) ✔` },
    vowels: { id: 'mouth', level: 'ok', text: `Its mouth can talk (${caps.vowels.length ? caps.vowels.map((v) => v.toUpperCase()).join(' ') : 'open / close'}) ✔`, detail: caps.vowels.length < 3 ? 'A few vowel shapes: talking looks simple but works.' : undefined },
    jaw: { id: 'mouth', level: 'ok', text: 'Its mouth opens and closes with a jaw ✔', detail: 'Great for robots, puppets and creatures.' },
    drawn: { id: 'mouth', level: 'ok', text: 'VTube Pro draws its mouth ✔' },
    none: { id: 'mouth', level: 'bad', text: 'No mouth shapes found — we can add basic ones', detail: 'VTube Pro draws a mouth on the face that talks, smiles and follows your voice.' },
  };
  out.push(caps.mouth === 'none' && pot.mouth !== 'none' ? { id: 'mouth', level: 'warn', text: 'Its mouth shapes have unusual names — we’ll match them so it can talk', detail: 'One click in “Set it up for me”.' } : mouthText[caps.mouth]);
  if (!caps.blink && pot.blink) out.push({ id: 'blink', level: 'warn', text: 'It can blink once we match its eye shapes' });
  else if (caps.blink) out.push({ id: 'blink', level: 'ok', text: caps.drawnEyes ? 'VTube Pro draws its eyes: they blink and look around ✔' : 'Your model can blink ✔' });
  else if (f.textured && (f.rig === 'vrm' || f.rig === 'humanoid' || f.rig === 'soft') && !f.mechanical) out.push({ id: 'blink', level: 'warn', text: 'The eyes look painted on, so they can’t blink yet', detail: 'We can swap in eyes that blink and follow your gaze (the file isn’t changed).' });
  else out.push({ id: 'blink', level: 'warn', text: 'No eyes that blink found — we can add drawn eyes', detail: 'They blink, look around and smile with you.' });
  if (!caps.drawnEyes) out.push(caps.look ? { id: 'look', level: 'ok', text: 'The eyes can look around ✔' } : { id: 'look', level: 'warn', text: 'The eyes can’t look around', detail: caps.blink ? 'Blinks still work. Drawn eyes can look around.' : 'Drawn eyes fix this too.' });
  if (sugg.length) out.push({ id: 'shapes', level: 'warn', text: `We found ${plural(sugg.length, 'face shape')} with unusual names — we can match them for you`, detail: `For example “${sugg[0].morph}”. “Set it up for me” does it, or pick them yourself in “Walk me through it”.` });
  // size
  const h = f.height;
  if (h > 0) {
    const r = readNative(h);
    if (r.unit === 'cm' || r.unit === 'mm') out.push({ id: 'size', level: 'warn', text: `Your model was saved in ${r.unit === 'cm' ? 'centimetres' : 'millimetres'} (${fmtM(r.metres)} tall)`, detail: 'No problem: VTube Pro sizes it correctly on screen and in rooms.' });
    else if (r.unit === '?') out.push({ id: 'size', level: 'warn', text: `Your model is ${fmtM(h)} tall — is that right?`, detail: 'If it was saved at the wrong scale, it still shows fine. If it really is that size, tell us in the Size step so rooms seat it right.' });
    else if (h < 0.3 || h > 3) out.push({ id: 'size', level: 'ok', text: `Your model is ${fmtM(h)} tall ✔`, detail: h < 0.3 ? 'A tiny character: rooms seat it on a table.' : 'A big character: rooms give it room to stand.' });
    else out.push({ id: 'size', level: 'ok', text: `Your model is ${fmtM(h)} tall ✔` });
  } else out.push({ id: 'size', level: 'warn', text: 'We couldn’t measure your model', detail: 'It still works.' });
  // detail
  out.push(f.triangles <= 37_000 ? { id: 'detail', level: 'ok', text: 'Light enough for group streams with friends ✔' }
    : f.triangles <= 200_000 ? { id: 'detail', level: 'ok', text: `${fmtTris(f.triangles)} triangles: great solo ✔`, detail: 'In group streams with a lower limit, friends see an automatic lighter copy.' }
      : { id: 'detail', level: 'warn', text: `Very detailed (${fmtTris(f.triangles)} triangles)`, detail: 'Fine on your stream. Friends in group streams see an automatic lighter copy.' });
  // physics
  out.push(f.springs > 0 ? { id: 'physics', level: 'ok', text: `Hair and clothes can swing (${plural(f.springs, 'bone')}) ✔` }
    : { id: 'physics', level: 'ok', text: 'No swinging hair or clothes found — that’s fine ✔', detail: 'Hair and skirts swing when the model has bones for them.' });
  return out;
}

/** One sentence over the report. */
export function reportSummary(lines: readonly ReportLine[], name: string): string {
  const bad = lines.filter((l) => l.level === 'bad').length, warn = lines.filter((l) => l.level === 'warn').length;
  if (bad) return `${name} opened. A few things need setting up: we can do most of it for you.`;
  if (warn) return `${name} looks good! A couple of things can be improved.`;
  return `${name} is ready to go!`;
}

// ---------------------------------------------------------------- "Set it up for me"

export type PlanState = 'apply' | 'keep' | 'helper';
export interface PlanItem {
  id: 'shapes' | 'facing' | 'skeleton' | 'mouth' | 'eyes' | 'look' | 'size' | 'camera' | 'physics';
  label: string;
  state: PlanState;
  /** What happens, in plain words (shown in the progress list). */
  detail: string;
  /** Profile changes (merged by applyPatch). */
  patch?: ProfilePatch;
  /** Markers the preview must place first (from the model's surface). */
  needs?: 'mouth' | 'eyes';
}
/** A JSON merge patch for an AvatarProfile: objects merge, everything else replaces, null deletes. */
export type ProfilePatch = { [k: string]: unknown };

export interface PlanResult { items: PlanItem[]; focus: 'full' | 'bust' | 'head' }

/** What "Set it up for me" does with this model. Pure; the wizard runs it step by step with a live preview. */
export function autoPlan(f: ModelFacts, p: Pick<AvatarProfile, 'look' | 'eyes' | 'mouth' | 'physics'> & { faceMap?: Record<string, string>; transform?: { yaw: number } }, env: ReportEnv): PlanResult {
  const items: PlanItem[] = [];
  // 0. facing: a model saved facing away is turned around (profile transform.yaw, the file isn't changed)
  const yaw = ((Math.round(p.transform?.yaw ?? 0) % 360) + 360) % 360;
  if (f.facesAway && yaw !== 180) items.push({ id: 'facing', label: 'Face the camera', state: 'apply', detail: 'Your model was saved facing away: turned it around.', patch: { transform: { yaw: 180 } } });
  else items.push({ id: 'facing', label: 'Face the camera', state: 'keep', detail: f.facesAway ? 'Turned around to face the camera.' : 'It faces the camera.' });
  const has = new Set(f.bones);
  // 1. face-shape names
  const sugg = suggestFaceMap(f.morphs, { vrm: f.vrm, existing: p.faceMap });
  if (sugg.length) {
    const map = { ...(p.faceMap ?? {}) };
    for (const s of sugg) map[s.morph] = s.key;
    items.push({ id: 'shapes', label: 'Match face shapes', state: 'apply', detail: `Matched ${plural(sugg.length, 'face shape')} (${sugg.slice(0, 3).map((s) => s.morph).join(', ')}${sugg.length > 3 ? ' …' : ''}).`, patch: { faceMap: map } });
  } else items.push({ id: 'shapes', label: 'Match face shapes', state: 'keep', detail: f.vrm ? 'VRM expressions are used as they are.' : faceCaps(f).arkit.length || faceCaps(f).named.length ? 'Every face shape was recognised.' : 'No face shapes to match.' });
  const caps = faceCaps(f, { ...(p.faceMap ?? {}), ...Object.fromEntries(sugg.map((s) => [s.morph, s.key])) });
  // 2. skeleton
  const arms = has.has('leftUpperArm') && has.has('rightUpperArm');
  if (f.quadruped) items.push({ id: 'skeleton', label: 'Check the skeleton', state: 'keep', detail: 'Four-legged body: head and neck follow you.' });
  else if ((f.rig === 'vrm' || f.rig === 'humanoid') && arms) items.push({ id: 'skeleton', label: 'Check the skeleton', state: 'keep', detail: `${f.rig === 'vrm' ? 'VRM' : 'Humanoid'} skeleton found: head, body${has.has('leftUpperLeg') ? ', arms and legs' : ' and arms'} follow you.` });
  else items.push({ id: 'skeleton', label: 'Add a skeleton', state: 'helper', detail: env.helper ? 'VTube Pro adds a skeleton on your PC after saving (about a minute).' : 'Needs VTube Pro (Blender on your PC). Until then the model leans and nods with you.' });
  // 3. mouth
  if (caps.mouth === 'none') items.push({ id: 'mouth', label: 'Add a mouth', state: 'apply', detail: 'A drawn mouth that talks and smiles with you.', needs: 'mouth', patch: { mouth: { mode: 'procedural', style: 'cavity' } } });
  else items.push({ id: 'mouth', label: 'Check the mouth', state: 'keep', detail: caps.mouth === 'jaw' ? 'The jaw opens and closes with your voice.' : caps.mouth === 'drawn' ? 'Already drawn by VTube Pro.' : 'The model’s own mouth shapes are used.' });
  // 4. eyes
  if (caps.blink) items.push({ id: 'eyes', label: 'Check the eyes', state: 'keep', detail: caps.drawnEyes ? 'Already drawn by VTube Pro.' : caps.look ? 'They blink and look around.' : 'They blink.' });
  else if (f.textured && !f.mechanical && !f.vrm && (f.rig === 'humanoid' || f.rig === 'soft' || f.rig === 'vrm')) {
    items.push({ id: 'eyes', label: 'Swap painted eyes for tracked eyes', state: 'apply', detail: 'Painted eyes are covered with eyes that blink and follow your gaze (your file isn’t changed).', needs: 'eyes',
      patch: { eyes: { mode: 'procedural', style: p.eyes.style === 'decal' ? 'decal' : 'anime', highlight: true, replaceBaked: { on: true, cover: 1, nudge: [0, 0] } } } });
  } else items.push({ id: 'eyes', label: 'Add eyes', state: 'apply', detail: f.mechanical ? 'Glowing screen eyes that blink.' : 'Drawn eyes that blink and look around.', needs: 'eyes',
    patch: { eyes: { mode: 'procedural', style: f.mechanical ? 'led' : 'inset' } } });
  // 5. look (materials)
  if (f.vrm) items.push({ id: 'look', label: 'Materials', state: 'keep', detail: 'VRM materials (MToon) are kept, brightened for the studio lights.' });
  else if (f.mechanical && p.look?.shading !== 'toy') items.push({ id: 'look', label: 'Materials', state: 'apply', detail: 'Shiny “toy” look and solid moving parts for a robot or prop.', patch: { look: { shading: 'toy', rim: 0.35 }, rig: { mechanical: true } } });
  else items.push({ id: 'look', label: 'Materials', state: 'keep', detail: `Cel-shaded “${p.look?.shading ?? 'anime'}” look with soft outlines.` });
  // 6. size
  const r = f.height > 0 ? readNative(f.height) : null;
  items.push({ id: 'size', label: 'Size', state: 'keep', detail: !r ? 'Couldn’t measure: shown at a normal size.' : r.unit === 'cm' || r.unit === 'mm' ? `Saved in ${r.unit}: corrected on screen (${fmtM(r.metres)}).` : `${fmtM(f.height)} tall.` });
  // 7. physics
  if (f.vrm) items.push({ id: 'physics', label: 'Hair and clothes', state: 'keep', detail: f.springs ? `The model’s own swing settings (${plural(f.springs, 'bone')}).` : 'Nothing set to swing in the file.' });
  else if (f.springs > 0) items.push({ id: 'physics', label: 'Hair and clothes', state: 'apply', detail: `${plural(f.springs, 'bone')} will swing (hair, clothes, tails).`, patch: { physics: { enabled: true, autoChains: true } } });
  else items.push({ id: 'physics', label: 'Hair and clothes', state: 'keep', detail: 'Nothing to swing on this model.' });
  // 8. camera
  const focus = cameraFocus(f);
  items.push({ id: 'camera', label: 'Camera framing', state: 'apply', detail: focus === 'full' ? 'Whole body in view.' : focus === 'head' ? 'Close-up on the face.' : 'Head and shoulders, the usual streaming shot.' });
  return { items, focus };
}

/** Robot / mech / prop guess from material + mesh names (rigid parts, screen eyes, the shiny "toy" look). */
export function guessMechanical(names: readonly string[]): boolean {
  if (!names.length) return false;
  if (names.some((n) => /(robot|mecha?\b|mech_|android|droid|cyborg|voice_?glow)/i.test(n))) return true;
  const metal = names.filter((n) => /(steel|metal|chrome|iron|bolt|bezel|screen|servo|piston|panel)/i.test(n)).length;
  return metal / names.length >= 0.4;
}

/** Where the studio camera should start for this model. */
export function cameraFocus(f: Pick<ModelFacts, 'rig' | 'bones' | 'quadruped' | 'height'>): 'full' | 'bust' | 'head' {
  if (f.quadruped) return 'full';
  if (f.rig === 'none') return 'full';                           // a prop or creature without a skeleton: show all of it
  return 'bust';
}

/** JSON merge patch (RFC 7386-style: objects merge, arrays and values replace, null deletes). Returns a new object. */
export function applyPatch<T extends object>(target: T, patch: ProfilePatch): T {
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) { delete out[k]; continue; }
    const cur = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) out[k] = applyPatch(cur as object, v as ProfilePatch);
    else out[k] = Array.isArray(v) ? [...v] : v && typeof v === 'object' ? applyPatch({}, v as ProfilePatch) : v;
  }
  return out as T;
}

// ---------------------------------------------------------------- the walkthrough + the 8-angle check

export type ManualStepId = 'name' | 'size' | 'body' | 'face' | 'mouth' | 'eyes' | 'look' | 'physics' | 'camera' | 'angles';
export const MANUAL_STEPS: { id: ManualStepId; title: string }[] = [
  { id: 'name', title: 'Name' }, { id: 'size', title: 'Size' }, { id: 'body', title: 'Body' }, { id: 'face', title: 'Face shapes' },
  { id: 'mouth', title: 'Mouth' }, { id: 'eyes', title: 'Eyes' }, { id: 'look', title: 'Look' }, { id: 'physics', title: 'Hair & clothes' },
  { id: 'camera', title: 'Camera' }, { id: 'angles', title: 'Check all sides' },
];
/** Steps that have nothing to ask for this model are left out (the face-shape step needs shapes to match). */
export function manualSteps(f: ModelFacts): ManualStepId[] {
  return MANUAL_STEPS.map((s) => s.id).filter((id) => {
    if (id === 'face') return !f.vrm && f.morphs.length > 0;
    return true;
  });
}

/** The 8-angle check: yaw of the model (degrees, + = turns to its left) and the label from the viewer's side. */
export const ANGLES: readonly { yaw: number; label: string }[] = [
  { yaw: 0, label: 'Front' }, { yaw: 45, label: 'Front, turned' }, { yaw: 90, label: 'Side' }, { yaw: 135, label: 'Back, turned' },
  { yaw: 180, label: 'Back' }, { yaw: 225, label: 'Back, other side' }, { yaw: 270, label: 'Other side' }, { yaw: 315, label: 'Front, other side' },
];

/** Rebuild-free check: did the change touch anything that needs the model rebuilt? */
export function needsRebuild(patch: ProfilePatch): boolean {
  return Object.keys(patch).some((k) => k !== 'name' && k !== 'tracking' && k !== 'look');
}
