// Auto-rig, step 1: what is each layer? From the layer's name, its folder path, its place on the canvas and its paint
// order, every layer gets a ROLE (eye white, iris, upper lash, mouth inner, front hair …) and, for paired parts, a
// SIDE. Names in English and Japanese (plus common Chinese) are understood, in any case / separator style
// ("EyeWhite_L", "eye white", "白目", "Eye L/white"). Sides come from the picture, not the name: artists disagree on
// whether "L" means the viewer's left or the character's, so a part on the viewer's right is the character's LEFT
// ('L', the same convention as the tracking: +yaw = toward the viewer's right). Pure (no DOM).
import type { ArtLayer } from './layers.ts';
import { inSwitchFolder, ACCESSORY_NAME } from './extras.ts';

export const ROLES = [
  'face', 'nose', 'blush', 'ear',
  'eyeWhite', 'iris', 'highlight', 'lashUpper', 'lashLower', 'eyeClosed', 'eyeWhole', 'brow',
  'mouthUpper', 'mouthLower', 'mouthInner', 'teeth', 'tongue', 'mouth', 'mouthOpening',
  'hairFront', 'hairSide', 'hairBack', 'ahoge',
  'neck', 'body', 'arm', 'hand', 'headAcc', 'bodyAcc', 'ignore', 'unknown',
] as const;
export type Role = typeof ROLES[number];
export type Side = 'L' | 'R';

export const ROLE_LABEL: Record<Role, string> = {
  face: 'Face', nose: 'Nose', blush: 'Blush', ear: 'Ear', eyeWhite: 'Eye white', iris: 'Iris', highlight: 'Eye highlight', lashUpper: 'Upper lash / lid',
  lashLower: 'Lower lash', eyeClosed: 'Closed eye', eyeWhole: 'Whole eye (one layer)', brow: 'Eyebrow', mouthUpper: 'Upper lip', mouthLower: 'Lower lip',
  mouthInner: 'Inside of mouth', mouthOpening: 'Mouth opening (clips the inside)', teeth: 'Teeth', tongue: 'Tongue', mouth: 'Mouth (one layer)', hairFront: 'Front hair', hairSide: 'Side hair', hairBack: 'Back hair',
  ahoge: 'Ahoge (hair tuft)', neck: 'Neck', body: 'Body', arm: 'Arm', hand: 'Hand', headAcc: 'Head accessory', bodyAcc: 'Body accessory', ignore: 'Left out (background / guide)', unknown: 'Not understood',
};
/** Roles that come in left / right pairs. */
export const SIDED: ReadonlySet<Role> = new Set<Role>(['ear', 'eyeWhite', 'iris', 'highlight', 'lashUpper', 'lashLower', 'eyeClosed', 'eyeWhole', 'brow', 'arm', 'hand', 'hairSide']);
/** Roles that ride on the head (turn, nod and tilt with it). */
export const HEAD_ROLES: ReadonlySet<Role> = new Set<Role>(['face', 'nose', 'blush', 'ear', 'eyeWhite', 'iris', 'highlight', 'lashUpper', 'lashLower', 'eyeClosed', 'eyeWhole', 'brow',
  'mouthUpper', 'mouthLower', 'mouthInner', 'teeth', 'tongue', 'mouth', 'mouthOpening', 'hairFront', 'hairSide', 'hairBack', 'ahoge', 'headAcc']);

export interface Classified {
  /** Index into the layer list (paint order, 0 = bottom). */
  index: number;
  name: string;
  role: Role;
  side: Side | null;
  /** How we know: the layer's name, its folder, its shape / place, or not at all. */
  by: 'name' | 'group' | 'shape' | 'none';
  why: string;
}

export interface ClassifyResult {
  layers: Classified[];
  /** Face box (canvas px) the geometry checks used, or null when no face / eyes were found. */
  face: { x: number; y: number; w: number; h: number } | null;
  /** Human sentences: what is missing and what the auto-rig will do about it. */
  notes: string[];
}

// ------------------------------------------------------------------ words
const tokenize = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const W = (...w: string[]) => new Set(w);
const EYE = W('eye', 'eyes', 'hitomi', 'eyel', 'eyer', 'ocular');
const IRIS = W('iris', 'irises', 'pupil', 'pupils', 'eyeball', 'eyeballs', 'ball', 'hitomi', 'kurome');
const WHITE = W('white', 'whites', 'sclera', 'eyewhite', 'shirome', 'base');
const HIGHLIGHT = W('highlight', 'highlights', 'hl', 'shine', 'sparkle', 'glint', 'reflection', 'reflect', 'light', 'gloss', 'catchlight');
const LASH = W('lash', 'lashes', 'eyelash', 'eyelashes', 'lid', 'lids', 'eyelid', 'eyelids', 'line', 'eyeline', 'liner', 'mabuta', 'matsuge');
const UPPER = W('upper', 'top', 'up', 'above', 'over');
const LOWER = W('lower', 'bottom', 'down', 'under', 'below', 'jaw', 'chin');
const CLOSED = W('closed', 'close', 'shut', 'blink', 'blinking', 'sleep');
const BROW = W('brow', 'brows', 'eyebrow', 'eyebrows', 'mayu', 'mayuge');
const MOUTH = W('mouth', 'lip', 'lips', 'kuchi', 'jaw', 'muzzle');
const INNER = W('inner', 'inside', 'interior', 'cavity', 'oral', 'hole', 'back', 'dark', 'throat');
const TEETH = W('teeth', 'tooth', 'fang', 'fangs', 'ha');
const TONGUE = W('tongue', 'shita');
const FACE = W('face', 'head', 'skin', 'kao', 'outline', 'contour', 'faceline');
const JAW = W('jaw', 'chin', 'cheekbone', 'faceline', 'contour', 'ago');
const NOSE = W('nose', 'hana');
const BLUSH = W('blush', 'blushes', 'cheek', 'cheeks', 'flush', 'hoppe', 'rouge');
const EAR = W('ear', 'ears', 'mimi');
const HAIR = W('hair', 'hairs', 'bangs', 'fringe', 'forelock', 'ponytail', 'twintail', 'twintails', 'braid', 'braids', 'kami', 'locks', 'lock', 'sideburn', 'sideburns', 'tress', 'tresses', 'ahoge', 'maegami', 'ushirogami', 'yokogami');
const FRONT = W('front', 'bangs', 'fringe', 'forelock', 'maegami', 'fore');
const SIDEW = W('side', 'sides', 'sideburn', 'sideburns', 'yokogami', 'temple', 'lock', 'locks');
const BACK = W('back', 'rear', 'behind', 'ponytail', 'twintail', 'twintails', 'ushirogami', 'base', 'hind');
const AHOGE = W('ahoge', 'antenna', 'cowlick', 'tuft');
const NECK = W('neck', 'kubi', 'throat');
const BODY = W('body', 'torso', 'chest', 'clothes', 'clothing', 'shirt', 'dress', 'uniform', 'outfit', 'jacket', 'coat', 'karada', 'bust', 'shoulders', 'shoulder', 'top', 'blouse', 'sweater', 'hoodie', 'vest');
const ARM = W('arm', 'arms', 'sleeve', 'sleeves', 'ude', 'forearm', 'upperarm');
const HAND = W('hand', 'hands', 'finger', 'fingers', 'palm', 'fist');
const ACC = W('accessory', 'accessories', 'acc', 'clip', 'hairclip', 'barrette', 'ribbon', 'bow', 'hat', 'cap', 'glasses', 'earring', 'earrings', 'necklace', 'choker', 'pin', 'crown', 'horn', 'horns', 'halo', 'flower', 'tiara', 'headband', 'hairband', 'headphones', 'mask', 'tie', 'collar', 'badge', 'sticker');
const LEFT = W('l', 'left', 'lt', 'hidari'), RIGHT = W('r', 'right', 'rt', 'migi');
/** Eye words that never mean anything else (a lash / lid is an eye part even when the name also says "Top", which BODY
 *  reads as a shirt); sparkles count only when the name doesn't also say hair (a hair shine stays hair). */
const LASH_STRICT = W('lash', 'lashes', 'eyelash', 'eyelashes', 'lid', 'lids', 'eyelid', 'eyelids', 'eyeline', 'mabuta', 'matsuge');
const SPARK = W('sparkle', 'sparkles', 'glint', 'catchlight', 'shine');
/** Accessory words that stay accessories next to "hair" ("hair clip", "hair ribbon"). */
const HAIR_ACC = W('clip', 'hairclip', 'barrette', 'pin', 'ribbon', 'bow', 'headband', 'hairband', 'tiara', 'crown', 'scrunchie', 'ornament', 'accessory', 'accessories', 'acc', 'flower');

/** CJK words (substring matches): [role-ish key, words]. Order matters (longer / more specific first). */
const CJK: [string, string[]][] = [
  ['eyeClosed', ['閉じ目', '閉じ', '閉眼', '闭眼']],
  ['lashLower', ['下まつ毛', '下睫毛', '下まぶた', '下瞼', '下眼睑']],
  ['lashUpper', ['上まつ毛', 'まつ毛', '睫毛', 'まつげ', 'まぶた', '瞼', 'アイライン', '眼睑']],
  ['eyeWhite', ['白目', '眼白']],
  ['iris', ['黒目', '瞳孔', '虹彩', '瞳', '眼珠']],
  ['highlight', ['ハイライト', '高光']],
  ['brow', ['眉毛', '眉', 'まゆ']],
  ['mouthInner', ['口内', '口の中', '口腔']],
  ['teeth', ['歯', '牙']],
  ['tongue', ['舌']],
  ['mouthUpper', ['上唇']],
  ['mouthLower', ['下唇']],
  ['hairFront', ['前髪', '前发', '刘海']],
  ['hairBack', ['後ろ髪', '後髪', '后发', '後頭部']],
  ['hairSide', ['横髪', 'もみあげ', '侧发', 'サイド']],
  ['ahoge', ['アホ毛', '呆毛']],
  ['blush', ['頬', 'ほほ', 'チーク', '赤面', '腮红']],
  ['nose', ['鼻']],
  ['ear', ['耳']],
  ['neck', ['首', '脖子']],
  ['hand', ['手']],
  ['arm', ['腕', '手臂']],
  ['face', ['顔', '輪郭', '脸', '肌', '顎', 'あご', 'アゴ', '下巴']],
  ['ctx:mouth', ['口', '唇', '嘴']],
  ['ctx:eye', ['目', '眼']],
  ['ctx:hair', ['髪', '头发', '发']],
  ['body', ['体', '胴', '服', '身体', '衣']],
  ['acc', ['アクセ', '飾り', 'リボン', '帽子', 'メガネ', '眼鏡']],
];
const cjkSide = (s: string): Side | null => (/左/.test(s) ? 'L' : /右/.test(s) ? 'R' : null);

interface Words { t: Set<string>; raw: string }
const words = (s: string): Words => ({ t: new Set(tokenize(s)), raw: s });
const any = (w: Words, set: Set<string>) => { for (const x of w.t) if (set.has(x)) return true; return false; };
const cjk = (w: Words, key: string) => CJK.find(([k]) => k === key)?.[1].some((x) => w.raw.includes(x)) ?? false;
const cjkRole = (w: Words): string | null => { for (const [k, list] of CJK) if (list.some((x) => w.raw.includes(x))) return k; return null; };

type Ctx = 'eye' | 'brow' | 'mouth' | 'hair' | 'face' | 'body' | 'arm' | 'ear' | null;
function ctxOf(w: Words): Ctx {
  if (any(w, BROW) || cjk(w, 'brow')) return 'brow';
  if (any(w, EYE) || any(w, IRIS) || any(w, LASH_STRICT) || (any(w, SPARK) && !any(w, HAIR)) || cjk(w, 'ctx:eye') || cjk(w, 'eyeWhite') || cjk(w, 'iris') || cjk(w, 'lashUpper') || cjk(w, 'lashLower')) return 'eye';
  if (any(w, MOUTH) || any(w, TEETH) || any(w, TONGUE) || cjk(w, 'ctx:mouth') || cjk(w, 'mouthInner')) return 'mouth';
  if (any(w, HAIR) || cjk(w, 'ctx:hair') || cjk(w, 'hairFront') || cjk(w, 'hairBack') || cjk(w, 'hairSide')) return 'hair';
  if (any(w, EAR) || cjk(w, 'ear')) return 'ear';
  if (any(w, ARM) || any(w, HAND) || cjk(w, 'arm') || cjk(w, 'hand')) return 'arm';
  if (any(w, BODY) || cjk(w, 'body')) return 'body';
  if (any(w, FACE) || cjk(w, 'face')) return 'face';
  return null;
}

/** Role from words alone (name first, the folder path as context). `null` = the words say nothing. */
function roleFromWords(name: Words, ctxWords: Words): { role: Role; by: 'name' | 'group' } | null {
  // CJK specific words in the name win
  const cr = cjkRole(name);
  if (cr && !cr.startsWith('ctx:') && cr !== 'acc') return { role: cr as Role, by: 'name' };
  const ctxName = ctxOf(name), ctxPath = ctxOf(ctxWords);
  const ctx = ctxName ?? ctxPath;
  const by: 'name' | 'group' = ctxName ? 'name' : 'group';
  const has = (s: Set<string>) => any(name, s);
  if (has(ACC) && (!has(HAIR) || has(HAIR_ACC)) || cr === 'acc') return { role: ctx === 'body' || ctx === 'arm' ? 'bodyAcc' : 'headAcc', by: 'name' };
  if (has(AHOGE)) return { role: 'ahoge', by: 'name' };
  switch (ctx) {
    case 'brow': return { role: 'brow', by };
    case 'eye': {
      if (has(CLOSED)) return { role: 'eyeClosed', by: 'name' };
      if (has(HIGHLIGHT)) return { role: 'highlight', by: 'name' };
      if (has(WHITE)) return { role: 'eyeWhite', by: 'name' };
      if (has(IRIS)) return { role: 'iris', by: 'name' };
      if (has(LASH) || has(UPPER) || has(LOWER)) return { role: has(LOWER) ? 'lashLower' : 'lashUpper', by: 'name' };
      if (ctxName === 'eye' && name.t.size <= 3) return { role: 'eyeWhole', by: 'name' };
      return null; // an eye-folder layer with an unhelpful name: geometry decides
    }
    case 'mouth': {
      if (has(TEETH) || cjk(name, 'teeth')) return { role: 'teeth', by: 'name' };
      if (has(TONGUE) || cjk(name, 'tongue')) return { role: 'tongue', by: 'name' };
      if (has(INNER)) return { role: 'mouthInner', by: 'name' };
      if (has(UPPER)) return { role: 'mouthUpper', by: 'name' };
      if (has(LOWER)) return { role: 'mouthLower', by: 'name' };
      if (ctxName === 'mouth') return { role: 'mouth', by: 'name' };
      return null;
    }
    case 'hair': {
      if (has(FRONT)) return { role: 'hairFront', by };
      if (has(SIDEW)) return { role: 'hairSide', by };
      if (has(BACK)) return { role: 'hairBack', by };
      // the folder may say it ("Back Hair/strand 3")
      if (any(ctxWords, FRONT) || cjk(ctxWords, 'hairFront')) return { role: 'hairFront', by: 'group' };
      if (any(ctxWords, BACK) || cjk(ctxWords, 'hairBack')) return { role: 'hairBack', by: 'group' };
      if (any(ctxWords, SIDEW) || cjk(ctxWords, 'hairSide')) return { role: 'hairSide', by: 'group' };
      return { role: 'hairFront', by }; // front / back is settled by paint order below
    }
    case 'ear': return { role: 'ear', by };
    case 'arm': return { role: has(HAND) || cjk(name, 'hand') ? 'hand' : 'arm', by };
    case 'face': {
      if (has(NOSE)) return { role: 'nose', by: 'name' };
      if (has(BLUSH)) return { role: 'blush', by: 'name' };
      if (ctxName === 'face') return { role: 'face', by: 'name' };
      if (has(NECK)) return { role: 'neck', by: 'name' };
      if (has(JAW) || cjk(name, 'face')) return { role: 'face', by: 'name' };
      return { role: 'headAcc', by: 'group' }; // something else in the head / face folder: it rides the head (shape may say face, below)
    }
    case 'body': if (ctxName === 'body' || has(NECK)) return { role: has(NECK) ? 'neck' : 'body', by }; break;
  }
  if (has(NOSE)) return { role: 'nose', by: 'name' };
  if (has(BLUSH)) return { role: 'blush', by: 'name' };
  if (has(NECK) || cjk(name, 'neck')) return { role: 'neck', by: 'name' };
  if (has(BODY)) return { role: 'body', by: 'name' };
  return null;
}

type Box = { x: number; y: number; w: number; h: number };
const cxOf = (b: Box) => b.x + b.w / 2, cyOf = (b: Box) => b.y + b.h / 2;
const inside = (a: Box, b: Box, slack = 0) => a.x >= b.x - slack && a.y >= b.y - slack && a.x + a.w <= b.x + b.w + slack && a.y + a.h <= b.y + b.h + slack;
const union = (bs: Box[]): Box | null => {
  if (!bs.length) return null;
  const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y)), x1 = Math.max(...bs.map((b) => b.x + b.w)), y1 = Math.max(...bs.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/** Classify every layer. `layers` in paint order (0 = bottom). */
export function classifyLayers(layers: readonly ArtLayer[], canvas: { width: number; height: number }, fixed?: readonly ({ role: Role; side: Side | null } | null)[]): ClassifyResult {
  const out: Classified[] = layers.map((l, index) => {
    const fx = fixed?.[index];
    if (fx) return { index, name: l.name, role: fx.role, side: fx.side, by: 'name', why: 'your answer' };
    const name = words(l.name), path = words(l.path.join(' / '));
    const r = roleFromWords(name, path);
    const why = r ? (r.by === 'name' ? `name "${l.name}"` : `folder "${l.path.join('/')}"`) : '';
    return { index, name: l.name, role: r?.role ?? 'unknown', side: null, by: r ? r.by : 'none', why };
  });
  const box = (i: number): Box => layers[i];
  const of = (...roles: Role[]) => out.filter((c) => roles.includes(c.role));
  // ---- not part of the avatar: a background / green screen, adjustment layers, hidden faint sketches and guides
  out.forEach((c, i) => {
    if (fixed?.[i]) return;
    const l = layers[i], why = leaveOut(l, i, layers, canvas);
    if (why) { c.role = 'ignore'; c.by = 'shape'; c.why = why; }
  });

  // ---- the face box: the face layer, else the eyes + mouth
  let faceIdx = of('face').sort((a, b) => box(b.index).w * box(b.index).h - box(a.index).w * box(a.index).h)[0];
  // several "face" layers (face + shading): the biggest is the face, the others ride along as face detail
  for (const c of of('face')) if (faceIdx && c !== faceIdx) c.why += ' (face detail)';
  let face: Box | null = faceIdx ? box(faceIdx.index) : null;
  if (!face) {
    const feat = union(of('eyeWhite', 'iris', 'eyeWhole', 'lashUpper', 'mouth', 'mouthUpper', 'mouthInner').map((c) => box(c.index)));
    if (feat) face = { x: feat.x - feat.w * 0.25, y: feat.y - feat.h * 0.6, w: feat.w * 1.5, h: feat.h * 2.0 };
  }
  // Still nothing: the big layer that the small features (eyes, mouth, brows …) are painted on is the face.
  if (!face) {
    const votes = faceVotes(layers, canvas);
    let best = -1;
    votes.forEach((v, i) => { if (v >= 3 && (out[i].role === 'unknown' || (out[i].role === 'headAcc' && out[i].by === 'group')) && (best < 0 || v > votes[best] || (v === votes[best] && isSkin(layers[i])))) best = i; });
    if (best >= 0) { out[best].role = 'face'; out[best].by = 'shape'; out[best].why = `picture: ${votes[best]} small features are painted on it`; face = box(best); faceIdx = out[best]; }
  }
  // Or the biggest skin-coloured layer in the upper half.
  if (!face) {
    let best = -1, bestA = 0;
    layers.forEach((l, i) => {
      if (!(out[i].role === 'unknown' || (out[i].role === 'headAcc' && out[i].by === 'group')) || cyOf(l) > canvas.height * 0.6) return;
      const a = l.w * l.h;
      if (a < canvas.width * canvas.height * 0.02 || l.w < canvas.width * 0.12) return; // too small to be a face
      if (a > bestA && isSkin(l)) { best = i; bestA = a; }
    });
    if (best >= 0) { out[best].role = 'face'; out[best].by = 'shape'; out[best].why = 'the biggest skin-coloured layer in the top half'; face = box(best); faceIdx = out[best]; }
  }
  const fcx = face ? cxOf(face) : canvas.width / 2;

  // ---- a skin-coloured layer in the face / head folder (a jaw, a cheek piece) is part of the face, not an accessory
  out.forEach((c, i) => {
    if (c.role !== 'headAcc' || c.by !== 'group') return;
    const l = layers[i];
    if (isSkin(l)) { c.role = 'face'; c.by = 'shape'; c.why = `skin-coloured, in the folder "${l.path.join('/')}": part of the face`; }
  });

  // ---- layers whose names say nothing: read the picture (colour, size, place around the face, paint order)
  if (face && faceIdx) shapePass(layers, out, face, faceIdx.index);

  // ---- unnamed layers inside an eye: iris / highlight by size and order
  const whites = of('eyeWhite', 'eyeWhole');
  for (const c of out) {
    if (c.role !== 'unknown') continue;
    const b = box(c.index);
    const host = whites.find((w) => w.index < c.index && inside(b, box(w.index), Math.max(4, box(w.index).w * 0.1)));
    if (host) {
      const hb = box(host.index), frac = (b.w * b.h) / (hb.w * hb.h);
      c.role = frac > 0.18 ? 'iris' : 'highlight'; c.by = 'shape'; c.why = `inside the eye "${host.name}", ${frac > 0.18 ? 'large' : 'small'}`;
    }
  }
  // ---- plain "hair": behind the face = back hair; long strands beside the face = side hair
  if (face && faceIdx) {
    for (const c of of('hairFront')) {
      if (c.by === 'name' && /front|bang|fringe|前髪|前发|刘海|forelock/i.test(layers[c.index].name)) continue;
      const b = box(c.index);
      if (c.index < faceIdx.index) { c.role = 'hairBack'; c.why += ' (painted behind the face)'; continue; }
      const narrow = b.w < face.w * 0.45, beside = Math.abs(cxOf(b) - fcx) > face.w * 0.3, long = b.y + b.h > face.y + face.h * 0.75;
      if (narrow && beside && long) { c.role = 'hairSide'; c.why += ' (a long strand beside the face)'; }
    }
  }
  // ---- anything else unnamed: an accessory of whatever it sits on
  for (const c of out) {
    if (c.role !== 'unknown') continue;
    const b = box(c.index);
    const onHead = face && cyOf(b) < face.y + face.h * 1.05 && Math.abs(cxOf(b) - fcx) < face.w * 1.1;
    c.why = `unrecognised name "${c.name}": ${onHead ? 'moves with the head' : 'moves with the body'}`;
    c.role = 'unknown';
    (c as Classified & { rides?: string }).rides = onHead ? 'head' : 'body';
  }
  // ---- sides from the picture
  for (const c of out) {
    if (!SIDED.has(c.role) || (fixed?.[c.index] && c.side)) continue;
    const b = box(c.index);
    const dx = cxOf(b) - fcx;
    if (Math.abs(dx) < Math.max(4, (face?.w ?? canvas.width) * 0.03)) { c.side = sideFromName(layers[c.index]); continue; }
    c.side = dx > 0 ? 'L' : 'R';
    const named = sideFromName(layers[c.index]);
    if (named && named !== c.side) c.why += ` (named ${named}, but on the ${c.side === 'L' ? "viewer's right = the character's left" : "viewer's left = the character's right"})`;
  }
  // ---- notes: what the rig will be missing
  const notes: string[] = [];
  const count = (r: Role, s?: Side) => out.filter((c) => c.role === r && (!s || c.side === s)).length;
  if (!face) notes.push('No face found: name the face layer "face" (or 顔). Head turning uses the canvas centre.');
  for (const s of ['L', 'R'] as const) {
    if (!count('eyeWhite', s) && !count('eyeWhole', s) && !count('iris', s)) notes.push(`No ${s === 'L' ? 'left' : 'right'} eye found: blinking for that eye is off.`);
    else if (!count('eyeWhite', s) && count('iris', s)) notes.push(`${s === 'L' ? 'Left' : 'Right'} eye has an iris but no eye white: the iris is not clipped while blinking.`);
  }
  if (!count('mouthInner') && (count('mouth') || count('mouthUpper'))) notes.push('No inside-of-mouth layer: the auto-rig paints one so the mouth can open.');
  if (!count('mouth') && !count('mouthUpper') && !count('mouthInner') && !count('mouthLower')) notes.push('No mouth found: lip sync is off. Name the mouth layers "mouth upper", "mouth lower", "mouth inner".');
  if (!count('brow')) notes.push('No eyebrows found.');
  const unk = out.filter((c) => c.role === 'unknown');
  if (unk.length) notes.push(`${unk.length} layer${unk.length > 1 ? 's' : ''} not understood (${unk.slice(0, 6).map((c) => `"${c.name}"`).join(', ')}${unk.length > 6 ? ' …' : ''}): they move with whatever they sit on. Pick a role in the layer list to rig them.`);
  return { layers: out, face, notes };
}

function sideFromName(l: ArtLayer): Side | null {
  const all = [l.name, ...l.path.slice(-1)];
  for (const s of all) {
    const c = cjkSide(s);
    if (c) return c;
    const t = new Set(tokenize(s));
    let isL = false, isR = false;
    for (const x of t) { if (LEFT.has(x)) isL = true; if (RIGHT.has(x)) isR = true; }
    if (isL !== isR) return isL ? 'L' : 'R';
  }
  return null;
}

/** Skin-ish: mostly warm, light, low-saturation opaque pixels. */
function isSkin(l: ArtLayer): boolean {
  let n = 0, s = 0;
  const step = Math.max(1, Math.floor((l.w * l.h) / 4000));
  for (let i = 0; i < l.w * l.h; i += step) {
    if (l.rgba[i * 4 + 3] < 200) continue;
    n++;
    const r = l.rgba[i * 4], g = l.rgba[i * 4 + 1], b = l.rgba[i * 4 + 2];
    if (r > 150 && r >= g && g >= b - 10 && r - b > 10 && r - b < 110) s++;
  }
  return n > 50 && s / n > 0.6;
}

const BG_NAME = /^(background|back ?ground|bg|backdrop|green ?screen|blue ?screen|chroma ?key|paper|canvas|背景|バック|haikei)(\s*(copy|\d+))*$/i;
const ADJUST = /^(brightness\/contrast|hue\/saturation|levels|curves|exposure|vibrance|color balance|colour balance|black & white|photo filter|channel mixer|color lookup|invert|posterize|threshold|gradient map|selective color|明るさ・コントラスト|色相・彩度|レベル補正|トーンカーブ)(\s*\d+)?$/i;
const RIG_STATE = /clos|blink|wink|shut|open|talk|smile|happy|sad|angry|cry|tear|sweat|blush|cheek|teeth|tongue|inside|inner|mouth|outfit|costume|clothes|alt|variant|expression|emote|閉|まばたき|ウィンク|開|笑|涙|汗|頬|赤面|歯|舌|口|衣装|服|差分|表情/i;
// (hidden layers in an outfit / accessory folder, or named like an accessory, are kept too: they become switches,
// extras.ts autoCostumes; inSwitchFolder / ACCESSORY_NAME)
/** Hidden leftovers artists keep in the file (backups, work in progress, old versions). Bare "copy" is not one:
 *  Photoshop names duplicated parts "arm copy". */
const JUNK = /(^|[^a-z])(backups?|bak|wip|work in progress|under construction|construction|old|unused|temp|tmp|old copy|backup copy|delete( ?me)?|trash)(?![a-z])|バックアップ|作業中|未使用/i;
const GUIDE = /sketch|rough|draft|guide|ref|reference|underdrawing|下書き|ラフ|アタリ|ガイド/i;
/** Why a layer is not part of the avatar, or null. */
function leaveOut(l: ArtLayer, i: number, layers: readonly ArtLayer[], canvas: { width: number; height: number }): string | null {
  if (BG_NAME.test(l.name.trim())) return `a background ("${l.name}"): your stream shows your room instead`;
  if (ADJUST.test(l.name.trim())) return `an adjustment layer ("${l.name}"): its effect is not applied`;
  if (!l.visible && (l.opacity < 0.6 || GUIDE.test(l.name))) return `a hidden guide / sketch ("${l.name}")`;
  // any other hidden layer is left out too, unless its name says it is an alternate state the rig shows by itself
  // (closed eyes, an open mouth, blush, tears, an outfit …)
  if (!l.visible && JUNK.test(l.name)) return `a hidden leftover ("${l.name}")`;
  // (in an outfit / accessory folder: kept when a folder hid it — the switch shows it; its own eye off = left out)
  const bySwitch = inSwitchFolder(l.path) && !l.hiddenAt?.includes(l.path.length);
  if (!l.visible && !RIG_STATE.test(`${l.path.join(' ')} ${l.name}`) && !bySwitch && !ACCESSORY_NAME.test(l.name)) return `hidden in your file ("${l.name}"): left out (show it in your paint program if it belongs to the avatar)`;
  if (GUIDE.test(l.name) && l.opacity < 0.7) return `a guide / sketch ("${l.name}")`;
  // a picture covering (almost) the whole canvas, opaque, at the bottom: a background
  const cover = (l.w * l.h) / (canvas.width * canvas.height);
  if (i <= 1 && cover > 0.9) {
    let n = 0, op = 0;
    const step = Math.max(1, Math.floor((l.w * l.h) / 5000));
    for (let k = 0; k < l.w * l.h; k += step) { n++; if (l.rgba[k * 4 + 3] > 240) op++; }
    if (op / n > 0.92) return 'a background picture covering the whole canvas: your stream shows your room instead';
  }
  void layers;
  return null;
}

/** Which deformer an unknown layer rides on (set by classifyLayers). */
export const ridesOn = (c: Classified): 'head' | 'body' => ((c as Classified & { rides?: 'head' | 'body' }).rides ?? (HEAD_ROLES.has(c.role) ? 'head' : 'body'));

/** For each layer: how many small layers (eyes, mouth, brows …) are painted directly on top of it (their centre lands
 *  on its opaque pixels and no other big layer lies between them). The face collects the most. */
export function faceVotes(layers: readonly ArtLayer[], canvas: { width: number; height: number }): number[] {
  const big = (l: ArtLayer) => l.w * l.h >= canvas.width * canvas.height * 0.02 && l.w >= canvas.width * 0.12;
  const small = (l: ArtLayer) => l.w < canvas.width * 0.2 && l.h < canvas.height * 0.15;
  const alphaAt = (l: ArtLayer, x: number, y: number) => { const px = Math.floor(x - l.x), py = Math.floor(y - l.y); return px >= 0 && py >= 0 && px < l.w && py < l.h ? l.rgba[(py * l.w + px) * 4 + 3] : 0; };
  const votes = layers.map(() => 0);
  layers.forEach((s, si) => {
    if (!small(s) || s.y + s.h / 2 > canvas.height * 0.7) return;
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
    for (let k = si - 1; k >= 0; k--) {
      const l = layers[k];
      if (!big(l)) continue;
      if (alphaAt(l, cx, cy) > 128) { votes[k]++; break; }
    }
  });
  return votes;
}

// ------------------------------------------------------------------ the picture pass (names say nothing)
interface Feat { b: Box; cx: number; cy: number; area: number; fill: number; r: number; g: number; b2: number; lum: number; sat: number; alpha: number }
function features(l: ArtLayer): Feat {
  let n = 0, sa = 0, r = 0, g = 0, bb = 0, an = 0, cnt = 0;
  const step = Math.max(1, Math.floor((l.w * l.h) / 6000));
  for (let i = 0; i < l.w * l.h; i += step) {
    cnt++;
    const a = l.rgba[i * 4 + 3];
    if (a > 8) { an++; sa += a; }
    if (a < 128) continue;
    n++; r += l.rgba[i * 4]; g += l.rgba[i * 4 + 1]; bb += l.rgba[i * 4 + 2];
  }
  const k = Math.max(1, n);
  r /= k; g /= k; bb /= k;
  const mx = Math.max(r, g, bb), mn = Math.min(r, g, bb);
  return { b: l, cx: l.x + l.w / 2, cy: l.y + l.h / 2, area: l.w * l.h, fill: n / Math.max(1, cnt), r, g, b2: bb, lum: 0.3 * r + 0.59 * g + 0.11 * bb, sat: mx ? (mx - mn) / mx : 0, alpha: an ? sa / an / 255 : 0 };
}
const colDist = (a: Feat, b: Feat) => Math.hypot(a.r - b.r, a.g - b.g, a.b2 - b.b2);

function shapePass(layers: readonly ArtLayer[], out: Classified[], F: Box, fi: number) {
  const fx = F.x + F.w / 2, fA = F.w * F.h;
  const feats = layers.map(features);
  const open = () => out.filter((c) => c.role === 'unknown' && c.by === 'none');
  const set = (c: Classified, role: Role, why: string) => { c.role = role; c.by = 'shape'; c.why = `picture: ${why}`; };
  const white = (f: Feat) => f.lum > 215 && f.sat < 0.14 && f.fill > 0.25;
  const dark = (f: Feat) => f.lum < 115;
  const skin = (i: number) => isSkin(layers[i]);
  const thin = (f: Feat) => f.b.h < f.b.w * 0.55;
  const line = (f: Feat) => f.b.h < f.b.w * 0.36;
  // eye whites: white blobs in the eye band, either side of the middle
  // (biggest first; a white shape inside an eye white is a highlight, decided below)
  for (const c of open().sort((a, b) => feats[b.index].area - feats[a.index].area)) {
    const f = feats[c.index];
    const inBand = f.cy > F.y + F.h * 0.22 && f.cy < F.y + F.h * 0.72, offMid = Math.abs(f.cx - fx) > F.w * 0.06 && Math.abs(f.cx - fx) < F.w * 0.5;
    if (out.some((w) => w.role === 'eyeWhite' && inside(f.b, feats[w.index].b, 4))) continue;
    if (c.index > fi && inBand && offMid && f.b.w < F.w * 0.4 && f.area > fA * 0.004 && white(f)) set(c, 'eyeWhite', 'a white shape in the eye area');
  }
  const whites = out.filter((c) => c.role === 'eyeWhite');
  for (const c of open()) {
    const f = feats[c.index];
    const host = whites.find((w) => w.index < c.index && inside(f.b, feats[w.index].b, Math.max(4, feats[w.index].b.w * 0.12)));
    if (host) {
      const hf = feats[host.index], frac = f.area / hf.area;
      if (f.lum > 200 && f.sat < 0.2) set(c, 'highlight', 'a bright spot inside an eye');
      else if (thin(f) && f.cy > hf.cy) set(c, 'lashLower', 'a line along the bottom of an eye');
      else if (thin(f)) set(c, 'lashUpper', 'a line along the top of an eye');
      else set(c, frac > 0.18 ? 'iris' : 'highlight', frac > 0.18 ? 'inside an eye, large' : 'inside an eye, small');
      continue;
    }
    // lashes / lids: dark thin shapes on an eye; brows: dark thin shapes above the eyes
    const near = whites.find((w) => { const wb = feats[w.index].b; return f.cx > wb.x - wb.w * 0.3 && f.cx < wb.x + wb.w * 1.3; });
    if (near && c.index > fi && (dark(f) || (f.sat > 0.25 && f.lum < 160)) && thin(f) && f.b.w < F.w * 0.45) {
      const wb = feats[near.index].b;
      if (f.cy < wb.y - wb.h * 0.25 && f.cy > wb.y - wb.h * 2.2) set(c, 'brow', 'a thin dark shape above an eye');
      else if (f.cy <= wb.y + wb.h * 0.45 && f.cy >= wb.y - wb.h * 0.3) set(c, 'lashUpper', 'a dark line along the top of an eye');
      else if (f.cy > wb.y + wb.h * 0.45 && f.cy < wb.y + wb.h * 1.3) set(c, 'lashLower', 'a line under an eye');
    }
  }
  // no whites at all: shapes in the eye band = whole eyes
  if (!whites.length) for (const c of open()) {
    const f = feats[c.index];
    if (c.index > fi && f.cy > F.y + F.h * 0.25 && f.cy < F.y + F.h * 0.7 && Math.abs(f.cx - fx) > F.w * 0.08 && f.b.w < F.w * 0.4 && !thin(f) && f.area > fA * 0.004) set(c, 'eyeWhole', 'a shape in the eye area');
  }
  // mouth: shapes low in the middle of the face
  const mouthy = open().filter((c) => { const f = feats[c.index]; return c.index > fi && f.cy > F.y + F.h * 0.58 && f.cy < F.y + F.h * 1.02 && Math.abs(f.cx - fx) < F.w * 0.22 && f.b.w < F.w * 0.45; });
  for (const c of mouthy) {
    const f = feats[c.index];
    if (f.r > f.g * 1.5 && f.lum < 120 && f.fill > 0.3) set(c, 'mouthInner', 'a dark red shape where the mouth is');
  }
  const inner = out.find((c) => c.role === 'mouthInner');
  for (const c of mouthy) {
    if (c.role !== 'unknown') continue;
    const f = feats[c.index], ib = inner ? feats[inner.index].b : null;
    if (ib && inside(f.b, ib, 6) && !line(f)) { set(c, white(f) ? 'teeth' : 'tongue', white(f) ? 'white, inside the mouth' : 'inside the mouth'); continue; }
    if (ib && inside(f.b, ib, 6) && white(f)) { set(c, 'teeth', 'white, inside the mouth'); continue; }
    if (f.area < fA * 0.0015 && f.cy < F.y + F.h * 0.75) continue; // a nose, below
    if (line(f)) {
      if (ib) set(c, f.cy < ib.y + ib.h * 0.5 ? 'mouthUpper' : 'mouthLower', f.cy < ib.y + ib.h * 0.5 ? 'the line at the top of the mouth' : 'the line under the mouth');
      else set(c, 'mouth', 'a line where the mouth is');
    }
  }
  // nose: a tiny mark between the eyes and the mouth; blush: soft pink on the cheeks; ears: skin at the sides
  for (const c of open()) {
    const f = feats[c.index];
    if (c.index > fi && f.area < fA * 0.004 && Math.abs(f.cx - fx) < F.w * 0.12 && f.cy > F.y + F.h * 0.45 && f.cy < F.y + F.h * 0.8) { set(c, 'nose', 'a small mark in the middle of the face'); continue; }
    const pink = f.r > 200 && f.r - f.g > 40 && f.b2 > f.g - 30;
    if (c.index > fi && pink && (f.alpha < 0.8 || f.fill < 0.5) && f.cy > F.y + F.h * 0.4 && f.cy < F.y + F.h * 0.85) { set(c, 'blush', 'soft pink on the cheeks'); continue; }
    if ((skin(c.index) || colDist(f, feats[fi]) < 45) && f.area < fA * 0.12 && Math.abs(f.cx - fx) > F.w * 0.38 && f.cy > F.y && f.cy < F.y + F.h * 0.8) { set(c, 'ear', 'skin at the side of the head'); continue; }
  }
  // hair: the colour of a big shape that reaches above the face
  const hairish = open().filter((c) => { const f = feats[c.index]; return f.b.y < F.y + F.h * 0.15 && f.area > fA * 0.15 && !skin(c.index); });
  const ref = hairish.sort((a, b) => feats[b.index].area - feats[a.index].area)[0];
  if (ref) {
    const rf = feats[ref.index];
    for (const c of open()) {
      const f = feats[c.index];
      if (colDist(f, rf) > 70 || skin(c.index)) continue;
      if (!(f.b.y < F.y + F.h && Math.abs(f.cx - fx) < F.w * 0.9)) continue;
      if (c.index < fi) set(c, 'hairBack', 'hair colour, painted behind the face');
      else if (f.b.y + f.b.h < F.y + F.h * 0.12 && f.b.w < F.w * 0.3) set(c, 'ahoge', 'a small tuft of hair on top');
      else if (f.b.w < F.w * 0.4 && Math.abs(f.cx - fx) > F.w * 0.3 && f.b.h > F.h * 0.4) set(c, 'hairSide', 'a long strand of hair beside the face');
      else if (f.b.y < F.y + F.h * 0.1) set(c, 'hairFront', 'hair colour over the forehead');
    }
  }
  // below the face: neck, body, arms
  for (const c of open()) {
    const f = feats[c.index];
    if (f.cy < F.y + F.h * 0.9) continue;
    if ((skin(c.index) || colDist(f, feats[fi]) < 45) && f.b.w < F.w * 0.6 && f.b.y < F.y + F.h * 1.05) set(c, 'neck', 'skin under the chin');
    else if (f.b.w > F.w * 0.9 && f.area > fA * 0.6) set(c, 'body', 'a big shape under the head');
    else if (f.b.h > f.b.w * 1.4 && Math.abs(f.cx - fx) > F.w * 0.5 && f.area > fA * 0.1) set(c, 'arm', 'a long shape at the side of the body');
    else set(c, 'bodyAcc', 'something on the body (clothing detail)');
  }
  // small things on the head (clips, ribbons): head accessories
  for (const c of open()) {
    const f = feats[c.index];
    if (c.index > fi && f.area < fA * 0.06 && f.cy < F.y + F.h * 0.4 && Math.abs(f.cx - fx) < F.w * 0.7) set(c, 'headAcc', 'a small thing on the head');
  }
}
