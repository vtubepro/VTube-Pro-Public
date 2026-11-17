// Auto-rig, beyond Live2D (docs/RIG2D_FORMAT.md §8): everything a well-layered PSD gets with no extra work.
//   folders  → parts (costume layers and angle views switch folders)
//   bones    side / back hair, ahoge, animal ears, hanging accessories (ribbons, earrings, tails …) get a bone chain
//            (a still anchor + 3 bones along the strand) with automatic weights and chain physics (§8.4), so they swing
//            and hang when the head moves;
//   lighting normal + rim maps are generated from the art at export (maps.ts) so room lights shade the avatar;
//   moods    a default expression state machine: talking while the voice is on, happy on happy chat / emotion, a blink
//            layer; the expressions it needs are added;
//   effects  particle presets (sparkles on happy, tears on sad, sweat on surprised, steam on angry) with painted sprites;
//   outfits  folders named like outfits / hats / glasses become costume layers (one per outfit group).
// Re-running replaces only what it made (auto flags / ids starting with "auto_"). Pure (no DOM).
import type { EdBone, EdDoc, EdDynamic, EdMesh, EdParticles, EdStateLayer, EdTexture, EdCostume, EdPart } from './doc.ts';
import { chainWeights } from './skin.ts';

type Box = { x: number; y: number; w: number; h: number };
export interface Landmarks { F: Box; HC: [number, number]; HR: [number, number] }

const slug = (s: string) => s.normalize('NFKC').replace(/[^\p{L}\p{N}_\-.]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'part';

// ------------------------------------------------------------------ parts from folders
export function partsFromFolders(doc: EdDoc) {
  const parts = new Map<string, EdPart>();
  for (const m of doc.meshes) {
    if (!m.group) { m.part = null; continue; }
    const segs = m.group.split('/').filter(Boolean);
    let parent: string | null = null;
    segs.forEach((seg, i) => {
      const id = slug(segs.slice(0, i + 1).join('_'));
      if (!parts.has(id)) parts.set(id, { id, name: seg, parent });
      parent = id;
    });
    m.part = parent;
  }
  (doc.extras ??= {}).parts = [...parts.values()];
}

// ------------------------------------------------------------------ bones
const ANIMAL = /cat|fox|dog|wolf|bunny|rabbit|animal|kemo|neko|usagi|kitsune|獣|猫|犬|うさ|兎|狐|狼/i;
const HANGING = /ribbon|bow|earring|charm|tassel|chain|strap|tail|scarf|tie|necklace|pendant|bell|feather|リボン|イヤリング|ピアス|尻尾|しっぽ|ネクタイ|鈴/i;

/** Which meshes swing on bones, and how: the chain (stiffness, damping, gravity, bones, limits in degrees), how far its
 *  tip may travel (`tip`, head radii: a long part gets its bend capped by it), and the head-turn kick (`turn` = the
 *  first bone's bend at a full kick, degrees; `turnGain` = how hard a head turn kicks it).
 *  Side hair (side bangs, side locks) frames the face: it sways gently and settles fast (tools/sample2d/swing_probe.ts:
 *  its tip travels about a tenth of the head's height on a quick 25° head turn and settles in about half a second;
 *  before, it swung a third of a head and rang for a second). Back hair / ponytails stay lively. */
interface BoneKind { up: boolean; stiffness: number; damping: number; gravity: number; segs: number; limit: number; boneLimit: number; tip: number; turn: number; turnGain: number }
function boneKind(m: EdMesh): BoneKind | null {
  if (m.generated) return null;
  switch (m.role) {
    case 'hairBack': return { up: false, stiffness: 28, damping: 5, gravity: 500, segs: 3, limit: 35, boneLimit: 18, tip: 0.3, turn: 25, turnGain: 2.2 };
    case 'hairSide': return { up: false, stiffness: 60, damping: 9, gravity: 500, segs: 3, limit: 25, boneLimit: 12, tip: 0.35, turn: 12, turnGain: 1.4 };
    case 'ahoge': return { up: true, stiffness: 70, damping: 4, gravity: 0, segs: 2, limit: 50, boneLimit: 30, tip: 1, turn: 25, turnGain: 2.2 };
    case 'ear': return ANIMAL.test(m.name) ? { up: true, stiffness: 140, damping: 7, gravity: 0, segs: 1, limit: 20, boneLimit: 20, tip: 1, turn: 25, turnGain: 2.2 } : null;
    case 'headAcc': case 'bodyAcc': case 'unknown': return HANGING.test(m.name) ? { up: false, stiffness: 50, damping: 5, gravity: 400, segs: 2, limit: 60, boneLimit: 35, tip: 1, turn: 25, turnGain: 2.2 } : null;
  }
  return null;
}

/** The head-turn kick's spring from its chain's settings: stiffer (it follows the turn quickly) with the SAME damping
 *  ratio, so "Stiffness" and "Calms down" on a chain mean the same for both motions of the part. */
export function turnSpring(stiffness: number, damping: number): { stiffness: number; damping: number } {
  const k = Math.max(40, stiffness * 2.5);
  return { stiffness: k, damping: damping * Math.sqrt(k / Math.max(1e-3, stiffness)) };
}

/** The head-turn jiggle that goes with a chain (the auto-rig's "<base>_swing" → "<base>_turn"). */
export function turnOf(doc: EdDoc, chain: EdDynamic): EdDynamic | undefined {
  const id = chain.id.replace(/_swing$/, '_turn');
  return id === chain.id ? undefined : (doc.extras?.dynamics ?? []).find((y) => y.id === id && y.kind === 'jiggle');
}

/** "How far it can swing" = `v` degrees for the whole chain, from where the gesture started (`base`): the per-bone limit
 *  keeps its exact share of the chain's (no floor, so going 25 → 5 → 25 comes back to the same numbers), and the
 *  AUTOMATIC head-turn kick on the first bone scales with it (a keyform the user edited by hand is left alone). */
export function setSwingReach(doc: EdDoc, ch: EdDynamic, base: { limit: number; boneLimit: number; kick: number[] | null }, v: number) {
  const k = v / Math.max(1e-6, base.limit);
  ch.limit = v;
  ch.boneLimit = base.boneLimit * k;
  const f = autoKickForm(doc, ch);
  if (f && base.kick && base.kick.length === f.values.length) f.values.forEach((x, i) => { if (x && x.a !== undefined && base.kick![i] !== undefined) x.a = base.kick![i] * k; });
}
/** The automatic head-turn kick keyform on a chain's first bone (one axis: the kick's output parameter), if any. */
export function autoKickForm(doc: EdDoc, ch: EdDynamic) {
  const t = turnOf(doc, ch), b = (doc.extras?.bones ?? []).find((x) => x.id === ch.bones?.[0]);
  return t?.output ? b?.forms.find((f) => f.auto && f.axes.length === 1 && f.axes[0].param === t.output) : undefined;
}
/** The state "How far it can swing" starts a gesture from. */
export const swingReachBase = (doc: EdDoc, ch: EdDynamic) => ({ limit: ch.limit ?? 90, boneLimit: ch.boneLimit ?? 50, kick: autoKickForm(doc, ch)?.values.map((x) => x?.a ?? 0) ?? null });

const HAIR_WORD =/hair|bang|fringe|ponytail|twintail|braid|lock|髪|前髪|後ろ髪|ポニテ|ツインテ|头发|头髮|髮|刘海|马尾|辫/i;
/** A part's one "swing" control (0 = still, 1 = as rigged, 2 = twice as lively): the parameter every motion of the part
 *  is scaled by (the dynamics' `amount`, docs/RIG2D_FORMAT.md §8.4), a model slider in the studio. Made when missing
 *  (older projects get theirs on first use); the chain and its head-turn kick are pointed at it. Returns its id. */
export function ensureSwingAmount(doc: EdDoc, chain: EdDynamic, partName: string, hair: boolean): string {
  const id = chain.amount && doc.params.some((p) => p.id === chain.amount) ? chain.amount : `ParamSwingAmount_${slug(chain.id.replace(/^auto_|_swing$/g, ''))}`.slice(0, 96);
  if (!doc.params.some((p) => p.id === id)) doc.params.push({ id, name: `${partName}${hair && !HAIR_WORD.test(partName) ? ' (hair)' : ''} swing`, min: 0, max: 2, def: 1, group: 'Swing' });
  chain.amount = id;
  const t = turnOf(doc, chain);
  if (t) t.amount = id;
  return id;
}

/** Worn round the neck / body: a chain only for the part that actually hangs (tie blade, scarf end, pendant). */
const WRAPS = /scarf|muffler|stole|shawl|tie|necklace|pendant|chain|マフラー|ストール|ネクタイ|ネックレス/i;

/** The free hanging end of a worn piece, from its picture (alpha): followed up from the bottom while it stays one
 *  narrow strip; it stops where the shape widens into the part that wraps round (a scarf's band, a necklace's loop)
 *  or splits (two strands). Hangs = at least twice as tall as wide and a real part of the piece. Returns its centre
 *  line from the attachment edge (top of the strip, canvas px) down to the free end, plus its width; null = it wraps
 *  (no chain). */
export function hangingTail(tex: EdTexture, at: { x: number; y: number }): { line: [number, number][]; width: number } | null {
  const runsOf = (y: number) => {
    const out: [number, number][] = [];
    let x0 = -1, gap = 0;
    for (let x = 0; x <= tex.w; x++) {
      const on = x < tex.w && tex.rgba[(y * tex.w + x) * 4 + 3] > 60;
      if (on) { if (x0 < 0) x0 = x; gap = 0; }
      else if (x0 >= 0 && ++gap > 2) { out.push([x0, x - gap]); x0 = -1; gap = 0; }
    }
    if (x0 >= 0) out.push([x0, tex.w - 1]);
    return out;
  };
  let y = tex.h - 1, rs = runsOf(y);
  while (y > 0 && !rs.length) rs = runsOf(--y);
  if (!rs.length) return null;
  let top = y;
  while (top > 0 && runsOf(top - 1).length) top--;
  const height = y - top + 1;
  // the longest piece at the bottom
  let cur = rs.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
  const rows: { y: number; c: number; w: number }[] = [{ y, c: (cur[0] + cur[1]) / 2, w: cur[1] - cur[0] + 1 }];
  const median = () => { const ws = rows.map((r) => r.w).sort((a, b) => a - b); return ws[ws.length >> 1]; };
  for (let yy = y - 1; yy >= 0; yy--) {
    const over = runsOf(yy).filter((r) => r[1] >= cur[0] - 2 && r[0] <= cur[1] + 2);
    if (over.length !== 1) break;                      // the end of the piece, or two strands joining
    const r = over[0], w = r[1] - r[0] + 1, md = median();
    if (rows.length >= 4 && w > md * 1.6 && w > md + 6) break; // widens into the part that wraps round
    rows.push({ y: yy, c: (r[0] + r[1]) / 2, w });
    cur = r;
  }
  const tall = rows.length, wide = median();
  if (tall < 12 || tall < wide * 2 || tall < height * 0.2) return null;
  rows.reverse();
  return { line: rows.map((r) => [at.x + r.c, at.y + r.y] as [number, number]), width: Math.max(...rows.map((r) => r.w)) };
}

/** The strand's centre line from its picture: points from the root along its length (n + 1 points). */
function strandLine(doc: EdDoc, tex: EdTexture, m: EdMesh, up: boolean, rootY: number | null, n: number): [number, number][] | null {
  const t = doc.textures[m.tex];
  const rows: { y: number; x: number }[] = [];
  for (let y = 0; y < tex.h; y++) {
    let s = 0, sx = 0;
    for (let x = 0; x < tex.w; x++) { const a = tex.rgba[(y * tex.w + x) * 4 + 3]; if (a > 60) { s += a; sx += a * x; } }
    if (s > 0) rows.push({ y: t.y + y, x: t.x + sx / s });
  }
  if (rows.length < 4) return null;
  if (up) rows.reverse();
  let start = 0;
  if (rootY !== null) { const k = rows.findIndex((r) => (up ? r.y <= rootY : r.y >= rootY)); if (k > 0) start = k; }
  const usable = rows.slice(start);
  if (usable.length < 4) return null;
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const r = usable[Math.min(usable.length - 1, Math.round((i / n) * (usable.length - 1)))];
    // smooth x over a few rows
    const k0 = Math.max(0, Math.round((i / n) * (usable.length - 1)) - 3), k1 = Math.min(usable.length - 1, k0 + 6);
    let sx = 0; for (let k = k0; k <= k1; k++) sx += usable[k].x;
    pts.push([sx / (k1 - k0 + 1), r.y]);
  }
  return pts;
}

/** n + 1 points evenly along a polyline (by row). */
function sampleLine(pts: [number, number][], n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const k = (i / n) * (pts.length - 1), k0 = Math.floor(k), k1 = Math.min(pts.length - 1, k0 + 1), f = k - k0;
    out.push([pts[k0][0] + (pts[k1][0] - pts[k0][0]) * f, pts[k0][1] + (pts[k1][1] - pts[k0][1]) * f]);
  }
  return out;
}

/** The rest of the piece (the band round the neck, a scarf's other end, a necklace's loop) is held by the still
 *  anchor: only vertices near the hanging end follow its bones (soft edge, 1 .. 1.6 × its half width + a margin). */
function holdAwayFrom(m: EdMesh, w: Record<string, number[]>, chain: EdBone[], anchor: EdBone, line: [number, number][], width: number) {
  const r0 = width * 0.5 + 4, r1 = width * 0.8 + 8, n = m.mesh.pos.length / 2;
  for (let i = 0; i < n; i++) {
    const x = m.mesh.pos[i * 2], y = m.mesh.pos[i * 2 + 1];
    let d = Infinity;
    for (let k = 0; k + 1 < line.length; k++) {
      const [ax, ay] = line[k], [bx, by] = line[k + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
      d = Math.min(d, Math.hypot(x - ax - dx * t, y - ay - dy * t));
    }
    const keep = d <= r0 ? 1 : d >= r1 ? 0 : 1 - (d - r0) / (r1 - r0);
    if (keep >= 1) continue;
    let moved = 0;
    for (const b of chain) { w[b.id][i] *= keep; moved += w[b.id][i]; }
    w[anchor.id][i] = Math.max(0, 1 - moved);
  }
}

export function autoBones(doc: EdDoc, textures: EdTexture[], L: Landmarks) {
  const X = (doc.extras ??= {});
  const keepBones = (X.bones ?? []).filter((b) => !b.auto);
  const autoIds = new Set((X.bones ?? []).filter((b) => b.auto).map((b) => b.id));
  for (const m of doc.meshes) if (m.skin) { for (const id of Object.keys(m.skin)) if (autoIds.has(id)) delete m.skin[id]; if (!Object.keys(m.skin).length) delete m.skin; }
  const bones: EdBone[] = [...keepBones];
  doc.params = doc.params.filter((p) => !p.id.startsWith('ParamSwing_') || doc.meshes.some((m) => `ParamSwing_${slug(m.id)}`.slice(0, 96) === p.id && !!boneKind(m)));
  const dyn: EdDynamic[] = (X.dynamics ?? []).filter((y) => !y.auto);
  // swing amounts nothing points at any more (the bones are off, the part was weighted by hand): no slider that does nothing
  const dropAmounts = () => {
    const live = new Set(dyn.map((y) => y.amount).filter(Boolean));
    doc.params = doc.params.filter((p) => !p.id.startsWith('ParamSwingAmount_') || live.has(p.id));
  };
  if (X.useBones === false) { X.bones = bones; X.dynamics = dyn; dropAmounts(); return; }
  for (const m of doc.meshes) {
    const k = boneKind(m);
    if (!k || (m.skin && Object.keys(m.skin).length)) continue; // the user weighted it by hand: leave it
    const rootY = m.role === 'hairBack' ? Math.max(doc.textures[m.tex].y, L.HC[1] - L.HR[1] * 0.4) : null;
    // a tie / scarf / necklace: only its hanging end swings, from where it hangs (not the top of its box: a scarf
    // wrapped round the neck would swing up to the eye); one that only wraps round gets no chain
    const wraps = !k.up && k.gravity > 0 && ['headAcc', 'bodyAcc', 'unknown'].includes(m.role) && WRAPS.test(m.name);
    const tail = wraps ? hangingTail(textures[m.tex], doc.textures[m.tex]) : null;
    if (wraps && !tail) continue;
    let line = tail ? sampleLine(tail.line, k.segs) : strandLine(doc, textures[m.tex], m, k.up, rootY, k.segs);
    if (!line) continue;
    if (m.mirrorOf) { const src = doc.meshes.find((x) => x.id === m.mirrorOf); if (src) { const cx2 = m.mesh.pos[0] + src.mesh.pos[0]; line = line.map(([x, y]) => [cx2 - x, y] as [number, number]); } }
    const base = `auto_${slug(m.id)}`;
    const [rx, ry] = line[0];
    const dir0 = Math.atan2(line[1][1] - ry, line[1][0] - rx) * 180 / Math.PI;
    const anchor: EdBone = { id: `${base}_root`, name: `${m.name} root`, parent: null, deformer: m.deformer, x: rx, y: ry, angle: dir0, length: 4, forms: [], auto: true };
    const chain: EdBone[] = [];
    for (let i = 0; i < k.segs; i++) {
      const [ax, ay] = line[i], [bx, by] = line[i + 1];
      chain.push({ id: `${base}_${i + 1}`, name: `${m.name} ${i + 1}`, parent: i === 0 ? anchor.id : chain[i - 1].id, deformer: null, x: ax, y: ay,
        angle: Math.atan2(by - ay, bx - ax) * 180 / Math.PI, length: Math.max(2, Math.hypot(bx - ax, by - ay)), forms: [], auto: true });
    }
    bones.push(anchor, ...chain);
    const w = chainWeights(m, chain, 0.35, anchor);
    if (tail) holdAwayFrom(m, w, chain, anchor, line, tail.width);
    m.skin = { ...(m.skin ?? {}), ...w };
    // long hair swings by its tip, not its angle: a waist-long mass bent 35 deg would sweep its tip half a body
    // sideways (and the framing, which measures the bends at their limits, would zoom far out). Cap the bend so the tip
    // travels at most about a head's half-height; short parts (ahoge, earrings, side locks) keep their usual limits.
    // (back hair hangs heavy: its tip a little; side hair frames the face: a little more; short parts: their limits)
    const span = chain.reduce((t, b) => t + b.length, 0), tipMax = Math.max(1, L.HR[1] * k.tip);
    const cap = span > tipMax ? Math.max(3, Math.asin(Math.min(1, tipMax / span)) * 180 / Math.PI) : Infinity;
    const limit = Math.min(k.limit, cap), boneLimit = Math.min(k.boneLimit, Math.max(5, k.boneLimit * Math.min(1, cap / k.limit)));
    const ch: EdDynamic = { id: `${base}_swing`, kind: 'chain', bones: chain.map((b) => b.id), stiffness: k.stiffness, damping: k.damping, gravity: k.gravity, limit, boneLimit, auto: true };
    dyn.push(ch);
    // a head turn is not a motion of the bones' root (the turn is drawn by keyforms), so the swing it causes comes
    // from a jiggle on the head turn that bends the first bone (same damping ratio as the chain: turnSpring)
    const sw = `ParamSwing_${slug(m.id)}`.slice(0, 96);
    const swP = doc.params.find((p) => p.id === sw);
    if (!swP) doc.params.push({ id: sw, name: `${m.name} head-turn sway`, min: -1, max: 1, def: 0, group: 'Physics' });
    else if (swP.name === `${m.name} swing`) swP.name = `${m.name} head-turn sway`;   // (older projects: "… swing" is the amount now)
    const turnA = Math.min(k.turn, cap);   // the same tip cap for the swing a head turn starts
    chain[0].forms.push({ axes: [{ param: sw, keys: [-1, 0, 1] }], values: [{ a: k.up ? turnA : -turnA }, null, { a: k.up ? -turnA : turnA }], auto: true });
    dyn.push({ id: `${base}_turn`, kind: 'jiggle', input: 'ParamAngleX', output: sw, ...turnSpring(k.stiffness, k.damping), gain: k.turnGain, auto: true });
    // the part's one swing control (kept with its value when the bones are made again: same id)
    X.dynamics = dyn;
    ensureSwingAmount(doc, ch, m.name, m.role === 'hairSide' || m.role === 'hairBack' || m.role === 'ahoge');
  }
  X.bones = bones;
  X.dynamics = dyn;
  dropAmounts();
}

// ------------------------------------------------------------------ moods (state machine)
const MOOD_EXPR = [
  { id: 'talking', name: 'Talking', params: [{ param: 'ParamBrowLY', value: 0.2, blend: 'add' as const }, { param: 'ParamBrowRY', value: 0.2, blend: 'add' as const }, { param: 'ParamEyeLSmile', value: 0.15, blend: 'add' as const }, { param: 'ParamEyeRSmile', value: 0.15, blend: 'add' as const }] },
  { id: 'blink', name: 'Blink', params: [{ param: 'ParamEyeLOpen', value: 0, blend: 'multiply' as const }, { param: 'ParamEyeROpen', value: 0, blend: 'multiply' as const }] },
];
export function defaultMoods(doc: EdDoc): EdStateLayer[] {
  for (const e of MOOD_EXPR) if (!doc.expressions.some((x) => x.id === e.id)) doc.expressions.push({ ...e, params: e.params.map((p) => ({ ...p })) });
  const has = (id: string) => doc.expressions.some((x) => x.id === id);
  const layers: EdStateLayer[] = [{
    id: 'auto_mood', name: 'Mood', initial: 'calm',
    states: [{ id: 'calm' }, { id: 'talking', ...(has('talking') ? { expression: 'talking' } : {}) }, { id: 'happy', ...(has('happy') ? { expression: 'happy' } : {}) }],
    transitions: [
      { from: 'calm', to: 'talking', on: { kind: 'voice', above: 0.15, after: 0.15 } },
      { from: 'talking', to: 'calm', on: { kind: 'silence', after: 0.8 } },
      { from: '*', to: 'happy', fade: 0.3, on: { kind: 'chat', value: 'happy' } },
      { from: '*', to: 'happy', fade: 0.3, on: { kind: 'emotion', value: 'happy', above: 0.6 } },
      { from: 'happy', to: 'calm', on: { kind: 'timer', after: 4 } },
    ],
  }, {
    id: 'auto_blink', name: 'Blink', initial: 'open',
    states: [{ id: 'open' }, { id: 'closed', ...(has('blink') ? { expression: 'blink' } : {}) }],
    transitions: [{ from: 'open', to: 'closed', fade: 0.06, on: { kind: 'timer', after: 4.2 } }, { from: 'closed', to: 'open', fade: 0.08, on: { kind: 'timer', after: 0.12 } }],
  }];
  return layers;
}

// ------------------------------------------------------------------ effects (particle presets)
export type PresetId = 'sparkles' | 'tears' | 'sweat' | 'steam' | 'hearts';
export const PRESETS: Record<PresetId, { name: string; trigger: EdParticles['trigger']; rate: number; life: number; speed: [number, number]; angle: number; spread: number; gravity: [number, number]; size: [number, number]; spin?: number; fade: number; blend: 'normal' | 'add'; max: number }> = {
  sparkles: { name: 'Sparkles', trigger: { kind: 'emotion', value: 'happy', burst: 1.5 }, rate: 14, life: 0.9, speed: [40, 110], angle: 0, spread: 80, gravity: [0, -20], size: [18, 4], spin: 90, fade: 0.4, blend: 'add', max: 40 },
  tears: { name: 'Tears', trigger: { kind: 'emotion', value: 'sad', burst: 3 }, rate: 3, life: 1.2, speed: [10, 30], angle: 180, spread: 15, gravity: [0, 520], size: [10, 8], fade: 0.3, blend: 'normal', max: 12 },
  sweat: { name: 'Sweat drop', trigger: { kind: 'emotion', value: 'surprised', burst: 1.5 }, rate: 2, life: 1.4, speed: [5, 15], angle: 160, spread: 10, gravity: [0, 80], size: [26, 22], fade: 0.3, blend: 'normal', max: 4 },
  steam: { name: 'Steam', trigger: { kind: 'emotion', value: 'angry', burst: 2 }, rate: 8, life: 1.1, speed: [60, 120], angle: 0, spread: 35, gravity: [0, -60], size: [20, 46], spin: 30, fade: 0.6, blend: 'normal', max: 20 },
  hearts: { name: 'Hearts', trigger: { kind: 'chat', value: '<3', burst: 2 }, rate: 6, life: 1.6, speed: [50, 90], angle: 0, spread: 40, gravity: [0, -30], size: [22, 14], fade: 0.4, blend: 'normal', max: 16 },
};

/** Paint a preset's sprite (64 x 64, procedural). */
export function presetSprite(id: PresetId): EdTexture {
  const W = 64, rgba = new Uint8ClampedArray(W * W * 4);
  const put = (x: number, y: number, c: [number, number, number], a: number) => { const i = (y * W + x) * 4; rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = Math.max(0, Math.min(255, a * 255)); };
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const u = (x + 0.5) / W * 2 - 1, v = (y + 0.5) / W * 2 - 1;
    let a = 0, c: [number, number, number] = [255, 255, 255];
    if (id === 'sparkles') { const r = Math.hypot(u, v), ang = Math.atan2(v, u); const star = 0.18 + 0.82 * Math.pow(Math.abs(Math.cos(ang * 2)), 18); a = Math.max(0, Math.min(1, (star - r) * 8)) + Math.max(0, 0.35 - r) * 2; c = [255, 248, 200]; }
    else if (id === 'tears' || id === 'sweat') {
      // a drop: round bottom, pointed top
      const yy = (v + 0.15) / 0.8, w2 = yy < 0 ? Math.max(0, 1 + yy * 1.6) * 0.45 : Math.sqrt(Math.max(0, 1 - yy * yy)) * 0.6;
      const d = Math.abs(u) - w2;
      a = yy > -0.7 && yy < 1 ? Math.max(0, Math.min(1, -d * 14)) : 0;
      c = id === 'tears' ? [150, 205, 255] : [190, 225, 255];
      if (a > 0 && u < -0.05 && u > -0.25 && yy > 0 && yy < 0.5) c = [255, 255, 255];
      a *= 0.9;
    } else if (id === 'steam') { const r = Math.hypot(u * 1.1, v); a = Math.max(0, 1 - r) ** 1.5 * 0.85; c = [245, 245, 250]; }
    else { const xx = u * 1.1, yy = -v * 1.1 + 0.2; const hq = (xx * xx + yy * yy - 0.5) ** 3 - xx * xx * yy * yy * yy; a = hq < 0 ? Math.max(0, Math.min(1, -hq * 40)) : 0; c = [255, 105, 150]; }
    put(x, y, c, a);
  }
  return { w: W, h: W, rgba };
}

/** Add a preset emitter (its sprite becomes a texture of kind 'sprite'). */
export function addPreset(doc: EdDoc, textures: EdTexture[], id: PresetId, slot: EdParticles['slot'], auto = false): EdParticles {
  const P = PRESETS[id];
  let tex = doc.textures.findIndex((t) => t.kind === 'sprite' && t.name === `sprite:${id}`);
  if (tex < 0) { tex = textures.length; textures.push(presetSprite(id)); doc.textures.push({ name: `sprite:${id}`, x: 0, y: 0, w: 64, h: 64, kind: 'sprite' }); }
  const X = (doc.extras ??= {});
  const list = (X.particles ??= []);
  let pid = `${auto ? 'auto_' : ''}${id}`;
  for (let k = 2; list.some((p) => p.id === pid); k++) pid = `${auto ? 'auto_' : ''}${id}_${k}`;
  const p: EdParticles = { id: pid, name: P.name, preset: id, slot, tex, rate: P.rate, life: P.life, speed: [...P.speed], angle: P.angle, spread: P.spread, gravity: [...P.gravity], size: [...P.size],
    ...(P.spin ? { spin: P.spin } : {}), fade: P.fade, max: P.max, blend: P.blend, trigger: { ...P.trigger }, on: true };
  list.push(p);
  return p;
}

/** The mesh vertex nearest to a canvas point (rest space), restricted to meshes matching `ok`. */
export function nearestVertex(doc: EdDoc, x: number, y: number, ok: (m: EdMesh) => boolean = () => true): { mesh: string; vertex: number } | null {
  let best: { mesh: string; vertex: number } | null = null, bd = Infinity;
  for (const m of doc.meshes) {
    if (!ok(m)) continue;
    for (let i = 0; i < m.mesh.pos.length / 2; i++) { const d = (m.mesh.pos[i * 2] - x) ** 2 + (m.mesh.pos[i * 2 + 1] - y) ** 2; if (d < bd) { bd = d; best = { mesh: m.id, vertex: i }; } }
  }
  return best;
}

export function autoEffects(doc: EdDoc, textures: EdTexture[], L: Landmarks) {
  const X = (doc.extras ??= {});
  X.particles = (X.particles ?? []).filter((p) => !p.id.startsWith('auto_'));
  const { F } = L;
  const role = (r: string) => (m: EdMesh) => m.role === r;
  const face = (m: EdMesh) => m.role === 'face';
  const headish = (m: EdMesh) => ['face', 'hairFront', 'hairBack', 'hairSide'].includes(m.role);
  // tears: under each eye
  for (const side of ['L', 'R'] as const) {
    const lower = doc.meshes.find((m) => m.role === 'lashLower' && m.side === side) ?? doc.meshes.find((m) => (m.role === 'eyeWhite' || m.role === 'eyeWhole') && m.side === side);
    if (!lower) continue;
    const t = doc.textures[lower.tex];
    const v = nearestVertex(doc, t.x + t.w * (side === 'L' ? 0.25 : 0.75), t.y + t.h, (m) => m.id === lower.id);
    if (v) addPreset(doc, textures, 'tears', v, true);
  }
  const top = nearestVertex(doc, F.x + F.w * 0.5, F.y - F.h * 0.05, headish);
  if (top) addPreset(doc, textures, 'steam', top, true);
  const spark = nearestVertex(doc, F.x + F.w * 0.95, F.y + F.h * 0.1, headish);
  if (spark) addPreset(doc, textures, 'sparkles', spark, true);
  const sweat = nearestVertex(doc, F.x + F.w * 0.85, F.y + F.h * 0.3, face) ?? nearestVertex(doc, F.x + F.w * 0.85, F.y + F.h * 0.3, role('face'));
  if (sweat) addPreset(doc, textures, 'sweat', sweat, true);
}

// ------------------------------------------------------------------ outfits (costume layers) from folder names
export const OUTFIT = /outfit|costume|clothes|clothing|uniform|dress|衣装|服装|コスチューム|服/i;
/** Accessory words, whole words only (Hat 2, hat_red, Caps, sunglasses, earrings, headphones — not cape, capsule,
 *  hatch, masking, scarface, halogen, crowning, Landscape, chat); Japanese words anywhere. */
export const ACCESSORY_NAME = /(^|[^a-z])((sun|eye)?glasses|hats?|caps?|goggles|masks?|headphones?|headsets?|earphones?|helmets?|crowns?|tiaras?|halos?|accessor(y|ies)|accs?|ribbons?|earrings?|necklaces?|chokers?|scarf|scarves)(?![a-z])|帽子|眼鏡|メガネ|マスク|アクセ|ヘッドホン|ヘッドフォン|イヤホン|王冠|ティアラ|ピアス|イヤリング|ネックレス|マフラー|髪飾り/i;
/** Accessory folders that become on / off switches (and hidden layers named like them: a switch of their own). */
export const TOGGLE = ACCESSORY_NAME;
/** A layer in this folder path ends up under an outfit / accessory switch, so it is kept even when hidden in the file
 *  (the PSD's visibility only decides whether the switch starts on). classify.ts leaveOut. */
export const inSwitchFolder = (path: readonly string[]) => path.some((seg) => OUTFIT.test(seg) || TOGGLE.test(seg));
const LOOSE = 'auto_layer_';
/** Folders named like outfits / accessories become costume layers (switches); the folders of an "Outfits" folder are
 *  one group (one at a time). The layers a switch shows are drawable and the switch hides them: the art's visibility
 *  only decides its default. From the PSD's folder info (mesh.hiddenAt):
 *   - a layer hidden only by its switch's folder or one above it is drawable (marked `hiddenInArt`); one hidden by
 *     its own eye or by a plain folder inside the switch stays hidden (an accessory-named one gets a switch of its own);
 *   - a switch starts off when its own folder was hidden; one hidden only because the outfit it sits in was hidden
 *     comes with that outfit; one hidden by a plain folder above it starts off; otherwise on.
 *  Without the folder info (other sources, old projects): a switch whose layers are all hidden starts off (unless an
 *  outer switch is hidden too) and all its layers are drawable. A hidden accessory-named layer no switch shows gets a
 *  folder + switch of its own, off. Re-running gives the same result. */
export function autoCostumes(doc: EdDoc) {
  const X = (doc.extras ??= {});
  const parts = (X.parts ??= []);
  const keep = (X.costumes ?? []).filter((c) => !c.id.startsWith('auto_'));
  const hasKids = (id: string) => parts.some((q) => q.parent === id && !q.id.startsWith(LOOSE));
  const container = (p: EdPart) => OUTFIT.test(p.name) && hasKids(p.id) && parts.filter((q) => q.parent === p.id && !q.id.startsWith(LOOSE)).length >= 2;
  const switches = () => {
    const made: EdCostume[] = [];
    for (const p of parts) {
      const parent = p.parent ? parts.find((q) => q.id === p.parent) : undefined;
      if (container(p)) continue;
      if (parent && container(parent) && !p.id.startsWith(LOOSE)) made.push({ id: `auto_${p.id}`, name: p.name, parts: [p.id], group: parent.name, on: true }); // a folder of outfits: one at a time
      else if (OUTFIT.test(p.name) || TOGGLE.test(p.name)) made.push({ id: `auto_${p.id}`, name: p.name, parts: [p.id], on: true });
    }
    return made;
  };
  const drawn = (m: EdMesh) => m.role !== 'ignore';
  const members = (pid: string) => doc.meshes.filter((m) => drawn(m) && (m.part === pid || isUnder(parts, m.part ?? null, pid)));
  const shown = (m: EdMesh) => m.visible && !m.hiddenInArt;
  const depth = (pid: string) => { let d = 0; for (let p: string | null = pid; p && d < 64; d++) p = parts.find((x) => x.id === p)?.parent ?? null; return d; };
  const allHidden = (pid: string) => { const ms = members(pid); return ms.length > 0 && !ms.some(shown); };
  let made = switches(), sw = new Set(made.map((c) => c.parts[0]));
  const innermost = (m: EdMesh) => { for (let p = m.part ?? null, d = 0; p && d < 64; d++) { if (sw.has(p)) return p; p = parts.find((x) => x.id === p)?.parent ?? null; } return null; };
  /** The layer is hidden only by its switch's folder or above (the switch shows it). */
  const shownBySwitch = (m: EdMesh) => {
    const s = innermost(m);
    if (!s) return false;
    return m.hiddenAt ? m.hiddenAt.every((i) => i <= depth(s) - 1) : allHidden(s);
  };
  // a hidden accessory layer no switch shows: a folder + switch of its own
  let loose = false;
  for (const m of doc.meshes) {
    if (shown(m) || !drawn(m) || m.generated || !ACCESSORY_NAME.test(m.name) || shownBySwitch(m)) continue;
    let id = slug(`${LOOSE}${m.id}`);
    for (let k = 2; parts.some((q) => q.id === id); k++) id = slug(`${LOOSE}${m.id}_${k}`);
    parts.push({ id, name: m.name, parent: m.part ?? null });
    m.part = id; loose = true;
  }
  if (loose) { made = switches(); sw = new Set(made.map((c) => c.parts[0])); }
  // the layers a switch shows are drawable
  for (const m of doc.meshes) if (!shown(m) && drawn(m) && shownBySwitch(m)) { m.visible = true; m.hiddenInArt = true; }
  // defaults from the art
  const oldHidden = new Set(made.filter((c) => { const ms = members(c.parts[0]); return allHidden(c.parts[0]) && !ms.some((m) => m.hiddenAt); }).map((c) => c.parts[0]));
  for (const c of made) {
    const pid = c.parts[0], ms = members(pid), d = depth(pid);
    if (!ms.length || ms.some(shown)) continue;                       // something in it is shown: on
    if (!ms.some((m) => m.hiddenAt)) {                                // no folder info: all hidden = off, unless an outer switch is too
      c.on = [...oldHidden].some((q) => q !== pid && isUnder(parts, pid, q));
      continue;
    }
    const above = new Set(ms.flatMap((m) => (m.hiddenAt ?? []).filter((i) => i <= d - 1)));
    if (!above.size) continue;                                       // its folder is shown (only things inside it are hidden): on
    if (above.has(d - 1)) { c.on = false; continue; }                // its own folder was hidden
    // hidden by a folder above it: it comes with that folder when that is a switch
    const outer = Math.min(...above);
    c.on = made.some((o) => o !== c && depth(o.parts[0]) - 1 === outer && isUnder(parts, pid, o.parts[0]));
  }
  // an outfit group needs exactly one on
  const groups = new Map<string, EdCostume[]>();
  for (const c of made) if (c.group) { const g = groups.get(c.group) ?? []; g.push(c); groups.set(c.group, g); }
  for (const g of groups.values()) { const on = g.findIndex((c) => c.on); g.forEach((c, i) => { c.on = i === Math.max(0, on); }); }
  X.costumes = [...keep, ...made.filter((c) => !keep.some((k) => k.parts.join() === c.parts.join()))];
}
function isUnder(parts: EdPart[], pid: string | null, ancestor: string): boolean {
  for (let p = pid, d = 0; p && d < 64; d++) { if (p === ancestor) return true; p = parts.find((x) => x.id === p)?.parent ?? null; }
  return false;
}

// ------------------------------------------------------------------ everything
export function applyExtras(doc: EdDoc, textures: EdTexture[], L: Landmarks) {
  const X = (doc.extras ??= {});
  if (!X.parts) partsFromFolders(doc);
  autoBones(doc, textures, L);
  if (!X.lighting) X.lighting = { maps: true, rimPx: Math.max(3, Math.round(L.F.w * 0.02)), tint: 0.6, strength: 0.8, rim: { width: 0.35, strength: 0.8 } };
  if (!X.states) X.states = defaultMoods(doc);
  else for (const e of MOOD_EXPR) if (X.states.some((l) => l.states.some((s) => s.expression === e.id)) && !doc.expressions.some((x) => x.id === e.id)) doc.expressions.push({ ...e, params: e.params.map((p) => ({ ...p })) });
  if (!X.particles || X.particles.some((p) => p.id.startsWith('auto_'))) autoEffects(doc, textures, L);
  autoCostumes(doc);
}
