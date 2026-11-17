// Map arbitrary skeleton bone names (Mixamo, Tripo, Meshy, Blender/Rigify, VRoid, UE, Unity, CC)
// onto VRM humanoid bone names so every rig runs through the same normalized retargeting.

import * as THREE from 'three';
import type { VRMHumanBoneName } from '@pixiv/three-vrm';

type Side = 'left' | 'right';

// Patterns are tested against a normalized name: lowercase, no prefix like "mixamorig:", separators removed.
// {S} = side token. Order matters (more specific first).
const RULES: [VRMHumanBoneName, RegExp[]][] = [
  ['hips', [/^(hips?|pelvis|root_?hips|cog|bip01pelvis|bip001pelvis|hip)$/]],
  // "spine1" is Mixamo's second spine bone (→ chest), so it must not match here
  ['spine', [/^(spine|spine0?0|spine01|torso|abdomen|waist|lowerspine|bip0?01spine)$/]],
  // Mixamo counts Spine, Spine1, Spine2; UE/Rigify-style counts spine_01, spine_02, spine_03
  ['chest', [/^(chest|spine02|spine1|upperspine|bip0?01spine1)$/]],
  ['upperChest', [/^(upperchest|spine03|spine2|bip0?01spine2)$/]],
  ['neck', [/^(neck|neck0?1|neck_?01|bip0?01neck)$/]],
  ['head', [/^(head|bip0?01head)$/]],
  ['jaw', [/^(jaw|jawroot|chin)$/]],
];

const SIDED: [string, RegExp[]][] = [
  ['Shoulder', [/^{S}(shoulder|clavicle|collar)$/, /^(shoulder|clavicle|collar){S}$/]],
  ['UpperArm', [/^{S}(upperarm|arm|uparm)$/, /^(upperarm|arm|uparm){S}$/]],
  ['LowerArm', [/^{S}(lowerarm|forearm|elbow)$/, /^(lowerarm|forearm|elbow){S}$/]],
  ['Hand', [/^{S}(hand|wrist)$/, /^(hand|wrist){S}$/]],
  ['UpperLeg', [/^{S}(upperleg|upleg|thigh|leg0?1)$/, /^(upperleg|upleg|thigh){S}$/]],
  ['LowerLeg', [/^{S}(lowerleg|leg|knee|calf|shin)$/, /^(lowerleg|leg|knee|calf|shin){S}$/]],
  ['Foot', [/^{S}(foot|ankle)$/, /^(foot|ankle){S}$/]],
  ['Toes', [/^{S}(toes?|toebase|ball)$/, /^(toes?|toebase|ball){S}$/]],
  ['Eye', [/^{S}eye$/, /^eye{S}$/]],
];

const FINGER_NAMES: [string, string[]][] = [
  ['Thumb', ['thumb']],
  ['Index', ['index', 'indexfinger', 'pointer', 'fore']],
  ['Middle', ['middle', 'mid', 'middlefinger']],
  ['Ring', ['ring', 'ringfinger']],
  ['Little', ['little', 'pinky', 'pinkie', 'small']],
];

/** Strip rig prefixes ("mixamorig:", "DEF-", "Bip01 ", "J_Bip_L_") but keep separators, so a bare
 *  "l"/"r" side letter can still be told apart from a letter that belongs to the word ("RightArm" must
 *  not lose "Rig", "lowerarm_l" must not read as "l" + "owerarm"). */
function stripPrefix(name: string) {
  return name
    .replace(/^.*[:|]/, '') // mixamorig:Hips
    .replace(/^(mixamorig\d*|bip0?0?1|cc_base|armature|skeleton)[_\s.-]*/i, '')
    .replace(/^(def|org|mch|rig)[_\s.-]+/i, '')          // short prefixes only with a separator
    .replace(/^j_bip_([clr])[_\s.-]*/i, (_m, s: string) => (/[lr]/i.test(s) ? s + '_' : ''));
}

function norm(name: string) {
  return stripPrefix(name).toLowerCase().replace(/[\s._-]/g, '');
}

/** Side + remaining (normalized) stem. Whole words "left"/"right" may be glued on (LeftArm, arm_left);
 *  a single "l"/"r" letter only counts when it's separated (l_arm, lowerarm_l, hand.R, ring_01_r). */
function splitSide(raw: string): { side: Side; stem: string } | null {
  const s = stripPrefix(raw);
  const pats: [RegExp, Side, 'pre' | 'post'][] = [
    [/^left(.+)$/i, 'left', 'pre'], [/^right(.+)$/i, 'right', 'pre'],
    [/^(.+?)left$/i, 'left', 'post'], [/^(.+?)right$/i, 'right', 'post'],
    [/^l[_\s.-]+(.+)$/i, 'left', 'pre'], [/^r[_\s.-]+(.+)$/i, 'right', 'pre'],
    // CamelCase side letter: "LThigh", "RHand", "HandL", "ArmR" (case-sensitive)
    [/^L(?=[A-Z])(.+)$/, 'left', 'pre'], [/^R(?=[A-Z])(.+)$/, 'right', 'pre'],
    [/^(.+[a-z0-9])L$/, 'left', 'post'], [/^(.+[a-z0-9])R$/, 'right', 'post'],
    [/^(.+?)[_\s.-]+l$/i, 'left', 'post'], [/^(.+?)[_\s.-]+r$/i, 'right', 'post'],
    // side letter in the middle: "thumb_l_01", "index.L.002"
    [/^(.+?)[_\s.-]+l[_\s.-]+(.+)$/i, 'left', 'post'], [/^(.+?)[_\s.-]+r[_\s.-]+(.+)$/i, 'right', 'post'],
  ];
  for (const [re, side] of pats) {
    const m = s.match(re);
    if (!m) continue;
    const stem = (m[1] + (m[2] ?? '')).toLowerCase().replace(/[\s._-]/g, '');
    if (stem.length >= 2) return { side, stem };
  }
  return null;
}

export type HumanBoneMap = Partial<Record<VRMHumanBoneName, THREE.Object3D>>;

/** Build a humanoid map from bone names; then fix up by topology where names were ambiguous. `boneMap` (the profile's
 *  rig.boneMap, saved by the import: node name → VRM bone) is applied first; names it doesn't cover are matched here. */
export function mapHumanoid(root: THREE.Object3D, boneMap?: Readonly<Record<string, string>> | null): HumanBoneMap {
  const bones: THREE.Object3D[] = [];
  root.traverse((o) => { if ((o as THREE.Bone).isBone) bones.push(o); });
  const map: HumanBoneMap = {};
  const take = (k: VRMHumanBoneName, o: THREE.Object3D) => { if (!map[k]) map[k] = o; };
  const given = new Set<THREE.Object3D>();
  if (boneMap) {
    for (const b of bones) {
      const k = boneMap[b.name];
      if (k && VRM_NAMES.has(k) && !map[k as VRMHumanBoneName]) { map[k as VRMHumanBoneName] = b; given.add(b); }
    }
  }

  for (const b of bones) {
    if (given.has(b)) continue;
    const n = norm(b.name);
    // exact VRM names first (our Blender rigs and VRMs use them)
    const exact = b.name.replace(/^.*[:|]/, '');
    if (VRM_NAMES.has(exact)) { take(exact as VRMHumanBoneName, b); continue; }
    // three.js renames a bone that shares its name with a mesh ("head" → "head_1"): still the VRM bone
    const undup = exact.replace(/_\d+$/, '');
    if (undup !== exact && VRM_NAMES.has(undup) && !bones.some((o) => o !== b && o.name === undup)) { take(undup as VRMHumanBoneName, b); continue; }
    let matched = false;
    for (const [k, res] of RULES) {
      if (res.some((r) => new RegExp(r.source.replace('{S}', '')).test(n))) { take(k, b); matched = true; break; }
    }
    if (matched) continue;
    const s = splitSide(b.name);
    if (!s) continue;
    const Side = s.side === 'left' ? 'left' : 'right';
    for (const [suffix, res] of SIDED) {
      if (res.some((r) => new RegExp(r.source.replace('{S}', '')).test(s.stem))) { take(`${Side}${suffix}` as VRMHumanBoneName, b); matched = true; break; }
    }
    if (matched) continue;
    // fingers: e.g. "LeftHandIndex1", "index_01_l", "f_index.01.L"
    for (const [F, keys] of FINGER_NAMES) {
      const key = keys.find((k) => s.stem.includes(k));
      if (!key) continue;
      const num = parseInt(s.stem.replace(/\D+/g, ' ').trim().split(' ').pop() || '1', 10);
      const seg = F === 'Thumb'
        ? (['Metacarpal', 'Proximal', 'Distal'] as const)[Math.min(2, Math.max(0, num - 1))]
        : (['Proximal', 'Intermediate', 'Distal'] as const)[Math.min(2, Math.max(0, num - 1))];
      take(`${Side}${F}${seg}` as VRMHumanBoneName, b);
      break;
    }
  }

  // Topology fallback: if we have hips + head but no spine chain, fill from the path between them.
  if (map.hips && map.head) {
    const chain: THREE.Object3D[] = [];
    let o: THREE.Object3D | null = map.head.parent;
    while (o && o !== map.hips) { chain.unshift(o); o = o.parent; }
    if (o === map.hips) {
      if (!map.neck && chain.length >= 1) map.neck = chain[chain.length - 1];
      if (!map.spine && chain.length >= 2) map.spine = chain[0];
      if (!map.chest && chain.length >= 3) map.chest = chain[1];
    }
  }
  // VRM requires spine; alias chest if needed
  if (!map.spine && map.chest) { map.spine = map.chest; delete map.chest; }
  return map;
}

/** Minimum set for full-body retargeting. */
export function isHumanoid(m: HumanBoneMap) {
  return !!(m.hips && m.spine && m.head);
}

const VRM_NAMES = new Set<string>([
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftEye', 'rightEye', 'jaw',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  ...['left', 'right'].flatMap((s) => [
    'ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal', 'IndexProximal', 'IndexIntermediate', 'IndexDistal',
    'MiddleProximal', 'MiddleIntermediate', 'MiddleDistal', 'RingProximal', 'RingIntermediate', 'RingDistal',
    'LittleProximal', 'LittleIntermediate', 'LittleDistal',
  ].map((f) => s + f)),
]);
