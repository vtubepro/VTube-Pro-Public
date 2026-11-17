// "Just drop a model": which bone of a dropped skeleton is the hips, the left upper arm, the right index finger …
// (VRM humanoid names). Pure: names + hierarchy (+ rest positions and "has skin weights" when known).
// Understands the common naming schemes: VRM / Unity Humanoid, Mixamo, VRoid (J_Bip_*), Blender Rigify + metarig,
// MMD (Japanese bone names, D-bones, twist bones, IK bones), Unreal mannequin (UE4 / UE5), 3ds Max Biped, Character
// Creator / iClone (CC_Base_*), Daz Genesis, and plain English names with any left/right spelling. The result is saved
// in the avatar's profile (rig.boneMap: node name → VRM bone) so the studio (src/avatar/humanoid.ts) uses exactly this
// map. Tests: tools/model_import_unit.ts.

export const HUMAN_BONES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftEye', 'rightEye', 'jaw',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
  ...(['left', 'right'] as const).flatMap((s) => ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal', 'IndexProximal', 'IndexIntermediate', 'IndexDistal',
    'MiddleProximal', 'MiddleIntermediate', 'MiddleDistal', 'RingProximal', 'RingIntermediate', 'RingDistal',
    'LittleProximal', 'LittleIntermediate', 'LittleDistal'].map((f) => `${s}${f}`)),
] as const;
export type HumanBone = (typeof HUMAN_BONES)[number];
const HUMAN_SET: ReadonlySet<string> = new Set(HUMAN_BONES);
const HUMAN_LOWER = new Map<string, HumanBone>(HUMAN_BONES.map((b) => [b.toLowerCase(), b]));

export interface BoneIn {
  name: string;
  /** Index of the parent bone in the same list, -1 = a root. */
  parent: number;
  /** Rest position (any units / axes: only compared with each other). */
  pos?: readonly [number, number, number];
  /** Skin weights point at it (false = a helper / IK / control bone nobody's skin follows). Unknown = undefined. */
  weighted?: boolean;
}

export type Scheme = 'vrm' | 'mixamo' | 'vroid' | 'rigify' | 'mmd' | 'unreal' | 'biped' | 'cc' | 'daz' | 'generic';
export const SCHEME_LABEL: Record<Scheme, string> = {
  vrm: 'VRM / Unity Humanoid names', mixamo: 'Mixamo', vroid: 'VRoid Studio', rigify: 'Blender Rigify / metarig', mmd: 'MMD (Japanese bone names)',
  unreal: 'Unreal Engine mannequin', biped: '3ds Max Biped', cc: 'Character Creator / iClone', daz: 'Daz Genesis', generic: 'common bone names',
};

export interface BoneMapResult {
  /** VRM bone → index into the input list. */
  map: Partial<Record<HumanBone, number>>;
  scheme: Scheme;
  /** Required for full-body tracking but not found. */
  missing: HumanBone[];
  /** hips + spine + head found (what the studio needs to use the skeleton at all). */
  humanoid: boolean;
  /** Arms (upper, lower, hand on both sides) found. */
  arms: boolean;
  legs: boolean;
  fingers: number;
  /** Bones a name matched but the hierarchy rejected (e.g. an "arm" that isn't below the chest). */
  rejected: { bone: string; as: HumanBone; why: string }[];
}

const REQUIRED: HumanBone[] = ['hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];

// ---------------------------------------------------------------- names

/** NFKC (full-width ０-９ / Ａ-Ｚ → ASCII), the mixamorig / armature prefixes off, separators kept. */
function stripPrefix(raw: string): string {
  return raw.normalize('NFKC')
    .replace(/^.*[:|]/, '')
    .replace(/^(mixamorig\d*|cc_base|armature|skeleton|root_?|genesis\d*(fe)?male_?)[_\s.-]*/i, '')
    .replace(/^(def|org|mch|rig)[_\s.-]+/i, '')
    .replace(/^bip0*1[_\s.-]*/i, '')
    .replace(/^j_(bip|adj)_([clr])[_\s.-]*/i, (_m, _k: string, s: string) => (/[lr]/i.test(s) ? s + '_' : ''));
}
const flat = (s: string) => s.toLowerCase().replace(/[\s._-]/g, '');

/** Bones nobody tracks: IK targets, poles, twist / roll helpers, tip / end / nub bones, MMD cancel + control bones. */
function isHelper(raw: string): boolean {
  const n = raw.normalize('NFKC');
  if (/IK/.test(n) || /(^|[_\s.-])ik([_\s.-]|$)/i.test(n)) return true;
  if (/(twist|roll|捩|キャンセル|cancel|[_\s.-]end$|[_\s.-]nub$|nub$|[_\s.-]tip$|pole|target|ctrl|control|helper|corrective)/i.test(n) || /[a-z0-9]End$/.test(n)) return true;
  if (/^(mch|org|vis|wgt)[-_.]/i.test(n)) return true;
  if (/(先$|ダミー|操作中心|全ての親|センター先|両目|肩P|肩C|腰キャンセル)/.test(n)) return true;
  return false;
}

type Side = 'left' | 'right';
/** Side + the rest of the (flattened) name. Words left/right anywhere; single letters only with a separator or as a
 *  CamelCase prefix / suffix; MMD 左 / 右; Daz-style lowercase prefix "lShldr"; Biped "L Thigh". */
function sideOf(raw: string): { side: Side; stem: string } | null {
  const s = stripPrefix(raw);
  if (/^左/.test(s)) return { side: 'left', stem: s.slice(1) };
  if (/^右/.test(s)) return { side: 'right', stem: s.slice(1) };
  const pats: [RegExp, Side][] = [
    [/^left(.+)$/i, 'left'], [/^right(.+)$/i, 'right'], [/^(.+?)left$/i, 'left'], [/^(.+?)right$/i, 'right'],
    [/^(.+?)[_\s.-]?left[_\s.-]?(.+)$/i, 'left'], [/^(.+?)[_\s.-]?right[_\s.-]?(.+)$/i, 'right'],
    [/^l[_\s.-]+(.+)$/i, 'left'], [/^r[_\s.-]+(.+)$/i, 'right'],
    [/^L(?=[A-Z])(.+)$/, 'left'], [/^R(?=[A-Z])(.+)$/, 'right'],
    [/^l(?=(?:Shldr|Collar|Forearm|Hand|Thigh|Shin|Foot|Toe|Eye|Index|Mid|Ring|Pinky|Thumb|Carpal|Metatarsals|BigToe|Ear))(.+)$/, 'left'],
    [/^r(?=(?:Shldr|Collar|Forearm|Hand|Thigh|Shin|Foot|Toe|Eye|Index|Mid|Ring|Pinky|Thumb|Carpal|Metatarsals|BigToe|Ear))(.+)$/, 'right'],
    [/^(.+[a-z0-9])L$/, 'left'], [/^(.+[a-z0-9])R$/, 'right'],
    [/^(.+?)[_\s.-]+l$/i, 'left'], [/^(.+?)[_\s.-]+r$/i, 'right'],
    [/^(.+?)[_\s.-]+l[_\s.-]+(.+)$/i, 'left'], [/^(.+?)[_\s.-]+r[_\s.-]+(.+)$/i, 'right'],
    [/^(.+?)[_\s.-]+l(\d+)$/i, 'left'], [/^(.+?)[_\s.-]+r(\d+)$/i, 'right'],
  ];
  for (const [re, side] of pats) {
    const m = s.match(re);
    if (!m) continue;
    const stem = flat((m[1] ?? '') + (m[2] ?? ''));
    if (stem.length >= 2) return { side, stem };
  }
  return null;
}

// MMD standard bone names (after NFKC; D = deform copies, preferred when they carry the skin)
const MMD_CENTRE: [RegExp, HumanBone][] = [
  [/^上半身$/, 'spine'], [/^上半身2$/, 'chest'], [/^上半身3$/, 'upperChest'], [/^首$/, 'neck'], [/^頭$/, 'head'],
];
const MMD_SIDED: [RegExp, string][] = [
  [/^肩$/, 'Shoulder'], [/^腕$/, 'UpperArm'], [/^ひじ$|^肘$/, 'LowerArm'], [/^手首$/, 'Hand'],
  [/^足D?$/, 'UpperLeg'], [/^ひざD?$|^膝D?$/, 'LowerLeg'], [/^足首D?$/, 'Foot'], [/^足先EX$|^つま先D?$/, 'Toes'], [/^目$/, 'Eye'],
  [/^親指0$/, 'ThumbMetacarpal'], [/^親指1$/, 'ThumbProximal'], [/^親指2$/, 'ThumbDistal'],
  [/^人指1$|^人差指1$/, 'IndexProximal'], [/^人指2$|^人差指2$/, 'IndexIntermediate'], [/^人指3$|^人差指3$/, 'IndexDistal'],
  [/^中指1$/, 'MiddleProximal'], [/^中指2$/, 'MiddleIntermediate'], [/^中指3$/, 'MiddleDistal'],
  [/^薬指1$/, 'RingProximal'], [/^薬指2$/, 'RingIntermediate'], [/^薬指3$/, 'RingDistal'],
  [/^小指1$/, 'LittleProximal'], [/^小指2$/, 'LittleIntermediate'], [/^小指3$/, 'LittleDistal'],
];

// Centre bones by flattened name (after the prefix strip). Spine numbering is resolved by the chain later.
const CENTRE: [RegExp, HumanBone][] = [
  [/^(hips?|pelvis|hip|cog|centerofmass|jhips?)$/, 'hips'],
  [/^(neck|neck0?1|necklower|necktwist01|neck1)$/, 'neck'],
  [/^(head|headtop0?)$/, 'head'],
  [/^(jaw|jawroot|chin|lowerjaw|jawbone)$/, 'jaw'],
  [/^(chest|chestlower|torsoupper|ribcage|thorax)$/, 'chest'],
  [/^(upperchest|chestupper)$/, 'upperChest'],
  [/^(spine|spine0?0?|spine01|spine1|torso|abdomen|abdomenlower|waist|lowerspine|lowerback|stomach|belly)$/, 'spine'],
];
const SIDED: [RegExp, string][] = [
  [/^(shoulder|clavicle|collar|clav|shldr)$/, 'Shoulder'],
  [/^(upperarm|arm|uparm|shldrbend|humerus|bicep|upperarm01|arm01)$/, 'UpperArm'],
  [/^(lowerarm|forearm|elbow|forearmbend|lowarm|radius|ulna|forarm)$/, 'LowerArm'],
  [/^(hand|wrist|palm|carpal)$/, 'Hand'],
  [/^(upperleg|upleg|thigh|thighbend|leg0?1|femur|hip(?=$))$/, 'UpperLeg'],
  [/^(lowerleg|leg|knee|calf|shin|tibia|lowleg|crus)$/, 'LowerLeg'],
  [/^(foot|ankle|heel)$/, 'Foot'],
  [/^(toes?|toebase|ball|toe0|toes0?1|toe01|bigtoe|metatarsals)$/, 'Toes'],
  [/^(eye|eyeball|faceeye|adjfaceeye)$/, 'Eye'],
];
const FINGERS: [string, RegExp][] = [
  ['Thumb', /thumb|親指/],
  ['Index', /index|pointer|^f?fore(?!arm)|人指|人差/],
  ['Middle', /middle|mid(?!dle)|中指/],
  ['Ring', /ring|薬指/],
  ['Little', /little|pinky|pinkie|small|小指/],
];

/** What one name says, without the hierarchy. */
function nameRole(raw: string, ctx: { rigify: boolean }): { bone: HumanBone; prio: number } | { finger: string; side: Side; num: number | null } | null {
  const plain = raw.replace(/^.*[:|]/, '');
  const exact = HUMAN_LOWER.get(plain.toLowerCase());
  if (exact) return { bone: exact, prio: 0 };
  const s = stripPrefix(raw);
  // MMD
  for (const [re, b] of MMD_CENTRE) if (re.test(s)) return { bone: b, prio: 1 };
  if (/^[左右]/.test(s)) {
    const side: Side = s[0] === '左' ? 'left' : 'right', stem = s.slice(1);
    for (const [re, b] of MMD_SIDED) if (re.test(stem)) return { bone: `${side}${b}` as HumanBone, prio: /D$/.test(stem) ? 0.5 : 1 };
  }
  const f = flat(s);
  if (/^necktwist0?1$/.test(f)) return { bone: 'neck', prio: 2 }; // Character Creator: the first neck twist IS the neck
  if (isHelper(raw)) return null;
  // Rigify / metarig numbered spine: spine = hips, .001 spine, .002 chest, .003 upperChest, .004 / .005 neck, .006 head
  if (ctx.rigify) {
    const rg = /^(?:DEF-|ORG-)?spine(?:[._]?(\d{3}))?$/i.exec(raw.replace(/^.*[:|]/, ''));
    if (rg) {
      const k = rg[1] ? Number(rg[1]) : 0;
      const b = (['hips', 'spine', 'chest', 'upperChest', 'neck', 'neck', 'head'] as HumanBone[])[k];
      if (b) return { bone: b, prio: k === 5 ? 3 : 1 };
    }
  }
  for (const [re, b] of CENTRE) if (re.test(f)) return { bone: b, prio: 2 };
  // UE "spine_01 … spine_05", Biped "Spine1 / Spine2", CC "Spine01 / Spine02": numbering → resolved on the chain
  if (/^(spine|abdomen|chest)\d+$/.test(f) || /^spine0\d$/.test(f)) return { bone: 'spine', prio: 4 };
  const sd = sideOf(raw);
  if (!sd) return null;
  for (const [re, b] of SIDED) if (re.test(sd.stem)) return { bone: `${sd.side}${b}` as HumanBone, prio: 2 };
  // fingers: Biped "Finger0" / "Finger01" / "Finger12" (finger digit, then segment), "LeftHandIndex1", "index_01_l",
  // "f_index.01.L", "lIndex2" (Daz)
  const biped = /^finger(\d)(\d)?$/.exec(sd.stem);
  if (biped) {
    const F = FINGERS[Number(biped[1])]?.[0];
    return F ? { finger: F, side: sd.side, num: biped[2] !== undefined ? Number(biped[2]) + 1 : 1 } : null;
  }
  for (const [F, re] of FINGERS) {
    if (!re.test(sd.stem)) continue;
    const m = /(\d+)\D*$/.exec(sd.stem.replace(/^f/, ''));
    return { finger: F, side: sd.side, num: m ? Number(m[1]) : null };
  }
  return null;
}

// ---------------------------------------------------------------- the map

export function detectScheme(names: readonly string[]): Scheme {
  const all = names.join('\n');
  const n = names.length || 1;
  const frac = (re: RegExp) => names.filter((x) => re.test(x)).length / n;
  if (frac(/^mixamorig\d*[:_]?/i) > 0.3) return 'mixamo';
  if (frac(/^J_(Bip|Adj|Sec)_/i) > 0.3) return 'vroid';
  if (/[上下]半身|[左右]腕|[左右]ひじ|センター/.test(all.normalize('NFKC'))) return 'mmd';
  if (frac(/^CC_Base_/i) > 0.3) return 'cc';
  if (frac(/^Bip0*1[\s_]/i) > 0.3) return 'biped';
  if (/(^|\n)(DEF-)?spine\.00\d/i.test(all) || frac(/^DEF-/) > 0.3 || /(^|\n)(DEF-)?upper_arm[.]?[LR]/i.test(all)) return 'rigify';
  if (/(^|\n)(clavicle|upperarm|lowerarm|thigh|calf)_[lr]($|\n)/i.test(all) && /(^|\n)pelvis($|\n)/i.test(all)) return 'unreal';
  if (/(^|\n)[lr](Shldr|Collar|ThighBend|Forearm)/.test(all)) return 'daz';
  const vrmHits = names.filter((x) => HUMAN_SET.has(x.replace(/^.*[:|]/, '')) || HUMAN_LOWER.has(x.toLowerCase())).length;
  if (vrmHits >= 10) return 'vrm';
  return 'generic';
}

export function mapBones(bones: readonly BoneIn[]): BoneMapResult {
  const N = bones.length;
  const children: number[][] = bones.map(() => []);
  bones.forEach((b, i) => { if (b.parent >= 0 && b.parent < N && b.parent !== i) children[b.parent].push(i); });
  const isAnc = (a: number, d: number) => { let p = bones[d]?.parent ?? -1, guard = 0; while (p >= 0 && guard++ < 1024) { if (p === a) return true; p = bones[p].parent; } return false; };
  const depth = (i: number) => { let d = 0, p = bones[i].parent; while (p >= 0 && d < 1024) { d++; p = bones[p].parent; } return d; };
  const weighted = (i: number) => bones[i].weighted !== false;

  // 1. candidates per bone from the names
  type Cand = { i: number; prio: number };
  const cands = new Map<HumanBone, Cand[]>();
  const fingerCands: { i: number; side: Side; finger: string; num: number | null }[] = [];
  const spineLike: number[] = [];
  const ctx = { rigify: bones.some((b) => /^(?:DEF-|ORG-)?spine[._]?\d{3}$/i.test(b.name.replace(/^.*[:|]/, ''))) };
  bones.forEach((b, i) => {
    const r = nameRole(b.name, ctx);
    if (!r) return;
    if ('finger' in r) { fingerCands.push({ i, ...r }); return; }
    if (r.bone === 'spine' && r.prio === 4) { spineLike.push(i); return; }
    // weighted bones beat helpers (MMD D-bones, Rigify DEF vs ORG copies)
    const prio = r.prio + (weighted(i) ? 0 : 5);
    (cands.get(r.bone) ?? cands.set(r.bone, []).get(r.bone)!).push({ i, prio });
  });
  const map: Partial<Record<HumanBone, number>> = {};
  const used = new Set<number>();
  const take = (k: HumanBone, i: number | undefined) => { if (i === undefined || map[k] !== undefined || used.has(i)) return; map[k] = i; used.add(i); };
  const best = (k: HumanBone, ok: (i: number) => boolean = () => true) =>
    (cands.get(k) ?? []).filter((c) => !used.has(c.i) && ok(c.i)).sort((a, b) => a.prio - b.prio || depth(a.i) - depth(b.i))[0]?.i;

  const rejected: BoneMapResult['rejected'] = [];
  // 2. head first (anchors everything), then hips = an ancestor of the head (MMD: the deepest common parent of the
  //    upper and lower body; a "pelvis" that isn't above the head is rejected)
  take('head', best('head'));
  const head = map.head;
  const hipOk = (i: number) => head === undefined || isAnc(i, head);
  let hips = best('hips', hipOk);
  for (const c of cands.get('hips') ?? []) if (!hipOk(c.i)) rejected.push({ bone: bones[c.i].name, as: 'hips', why: 'not above the head in the skeleton' });
  if (hips === undefined && head !== undefined) {
    // MMD: センター / グルーブ / 腰 (the deepest one above the head and both legs); others: the topmost bone with
    // three or more children (spine + two legs)
    const legL = best('leftUpperLeg'), legR = best('rightUpperLeg');
    const above = (i: number) => isAnc(i, head) && (legL === undefined || isAnc(i, legL)) && (legR === undefined || isAnc(i, legR));
    const mmd = bones.map((b, i) => ({ i, n: stripPrefix(b.name) })).filter((x) => /^(腰|グルーブ|センター|下半身)$/.test(x.n) && above(x.i)).sort((a, b) => depth(b.i) - depth(a.i))[0];
    if (mmd) hips = mmd.i;
    else {
      const fork = bones.map((_, i) => i).filter((i) => above(i) && children[i].length >= 3).sort((a, b) => depth(b) - depth(a))[0];
      if (fork !== undefined) hips = fork;
    }
  }
  take('hips', hips);
  const H = map.hips;
  const under = (anc: number | undefined) => (i: number) => anc === undefined || isAnc(anc, i);

  // 3. the spine chain between hips and head: named bones first, then numbered / unnamed links by position in the chain
  if (H !== undefined && head !== undefined) {
    const chain: number[] = [];
    let p = bones[head].parent, guard = 0;
    while (p >= 0 && p !== H && guard++ < 256) { chain.unshift(p); p = bones[p].parent; }
    if (p === H) {
      for (const k of ['neck', 'upperChest', 'chest', 'spine'] as HumanBone[]) {
        const c = (cands.get(k) ?? []).filter((x) => chain.includes(x.i) && !used.has(x.i)).sort((a, b) => a.prio - b.prio)[0];
        if (c) take(k, c.i);
      }
      const free = chain.filter((i) => !used.has(i) && !isHelper(bones[i].name));
      // neck = the link right below the head; spine = the first link above the hips; chest / upper chest between
      if (map.neck === undefined && free.length >= 2 && free[free.length - 1] === chain[chain.length - 1]) take('neck', free.pop());
      const below = (a: number | undefined) => (i: number) => a === undefined || isAnc(a, i);
      const links = chain.filter((i) => !used.has(i) && !isHelper(bones[i].name) && (map.neck === undefined || isAnc(i, map.neck)));
      if (map.spine === undefined) take('spine', links.find((i) => !used.has(i) && (map.chest === undefined || isAnc(i, map.chest))));
      if (map.chest === undefined) take('chest', links.find((i) => !used.has(i) && below(map.spine)(i) && (map.upperChest === undefined || isAnc(i, map.upperChest))));
      if (map.upperChest === undefined && map.chest !== undefined) take('upperChest', links.find((i) => !used.has(i) && isAnc(map.chest!, i)));
    }
  }
  if (map.spine === undefined && map.chest !== undefined) { map.spine = map.chest; delete map.chest; }
  if (map.spine === undefined && spineLike.length) take('spine', spineLike.filter(under(H)).sort((a, b) => depth(a) - depth(b))[0]);

  // 4. limbs: names, then checked against the hierarchy (an arm hangs below the chest/spine, a leg below the hips)
  const torso = map.upperChest ?? map.chest ?? map.spine ?? H;
  for (const side of ['left', 'right'] as const) {
    const S = (b: string) => `${side}${b}` as HumanBone;
    take(S('Shoulder'), best(S('Shoulder'), under(map.spine ?? H)));
    take(S('UpperArm'), best(S('UpperArm'), under(map[S('Shoulder')] ?? map.spine ?? H)));
    take(S('LowerArm'), best(S('LowerArm'), under(map[S('UpperArm')])));
    take(S('Hand'), best(S('Hand'), under(map[S('LowerArm')] ?? map[S('UpperArm')])));
    take(S('UpperLeg'), best(S('UpperLeg'), under(H)));
    take(S('LowerLeg'), best(S('LowerLeg'), under(map[S('UpperLeg')])));
    take(S('Foot'), best(S('Foot'), under(map[S('LowerLeg')])));
    take(S('Toes'), best(S('Toes'), under(map[S('Foot')])));
    take(S('Eye'), best(S('Eye'), under(head)));
    if (side === 'left') take('jaw', best('jaw', under(head)));
    // topology fill: upper arm → lower arm → hand along single-child chains (UE / Biped arms with odd names)
    const fillDown = (from: HumanBone, to: HumanBone) => {
      const f = map[from];
      if (f === undefined || map[to] !== undefined) return;
      const kids = children[f].filter((c) => !isHelper(bones[c].name) && !used.has(c));
      if (kids.length === 1) take(to, kids[0]);
    };
    fillDown(S('UpperArm'), S('LowerArm')); fillDown(S('LowerArm'), S('Hand'));
    fillDown(S('UpperLeg'), S('LowerLeg')); fillDown(S('LowerLeg'), S('Foot'));
    // fingers below this hand
    const hand = map[S('Hand')];
    if (hand !== undefined) {
      for (const k of HUMAN_BONES) if (k.startsWith(side) && /(Thumb|Index|Middle|Ring|Little)/.test(k)) take(k, best(k, under(hand)));
      for (const [F] of FINGERS) {
        const segs = F === 'Thumb' ? ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'] : [`${F}Proximal`, `${F}Intermediate`, `${F}Distal`];
        const list = fingerCands.filter((c) => c.side === side && c.finger === F && isAnc(hand, c.i) && !used.has(c.i)).sort((a, b) => depth(a.i) - depth(b.i));
        if (!list.length) continue;
        // MMD thumb: 親指0 is the metacarpal; "thumb_01" (UE / Rigify / Mixamo 1) starts at the metacarpal too
        const nums = list.map((c) => c.num);
        const zeroBased = nums.includes(0);
        list.forEach((c, k) => {
          let slot = c.num !== null ? (zeroBased ? c.num : c.num - 1) : k;
          if (F !== 'Thumb' && zeroBased) slot = (c.num ?? k) - 1; // "index0" = metacarpal: not a VRM bone
          if (F !== 'Thumb' && /meta|carpal/i.test(bones[c.i].name)) return;
          const b = segs[slot];
          if (b) take(S(b), c.i);
        });
      }
    }
  }
  // 5. sides by position: a model whose "left" bones sit on both sides (bad export) — trust the names; but a model
  //    whose left/right are swapped consistently is fine (the studio turns it around)
  const missing = REQUIRED.filter((k) => map[k] === undefined);
  const has = (k: HumanBone) => map[k] !== undefined;
  const arms = ['leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand'].every((k) => has(k as HumanBone));
  const legs = ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'].every((k) => has(k as HumanBone));
  const fingers = HUMAN_BONES.filter((k) => /(Thumb|Index|Middle|Ring|Little)/.test(k) && has(k)).length;
  void torso;
  return { map, scheme: detectScheme(bones.map((b) => b.name)), missing, humanoid: has('hips') && has('spine') && has('head'), arms, legs, fingers, rejected };
}

/** The profile form: three.js node name → VRM bone (only what was found). */
export function boneMapForProfile(bones: readonly BoneIn[], r: BoneMapResult, sanitize: (n: string) => string): Record<string, HumanBone> {
  const out: Record<string, HumanBone> = {};
  for (const [k, i] of Object.entries(r.map) as [HumanBone, number][]) out[sanitize(bones[i].name)] = k;
  return out;
}

/** A clean boneMap (≤ 200 entries, VRM bone names only, each VRM bone once) or undefined. */
export function sanitizeBoneMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  let n = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (n >= 200) break;
    if (!k || k.length > 128 || typeof val !== 'string' || !HUMAN_SET.has(val) || seen.has(val)) continue;
    out[k] = val; seen.add(val); n++;
  }
  return n ? out : undefined;
}
