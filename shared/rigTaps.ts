// Guided taps for the 3D auto-rig (lane b15-autorig3d): the body-type picker and the few taps each type needs.
//
// The person picks what the model IS (a person, an animal on four legs, a bird, a snake or anything with a tail, a thing)
// and taps a handful of places on a picture of it. Plain words only: no "bones", "joints", "axes". The taps travel to
// Blender as [u,v,w] points over the model's own glTF box (u = x, v = up, w = z, the same space as SoftRigConfig.joints),
// and blender/rigplan.py turns them into a skeleton. This file is the one place that knows which taps each type asks for,
// what to say for each, and how to clean an incoming request (the autorig endpoint and the MCP tool both call it).

import type { SoftRigConfig, Vec3 } from './types.ts';

export type BodyType = 'person' | 'fourLegs' | 'bird' | 'tail' | 'thing';
/** The skeleton templates blender/autorig.py builds. */
export type RigTemplate = 'humanoid' | 'quadruped' | 'creature' | 'object';

export const BODY_TYPES: readonly BodyType[] = ['person', 'fourLegs', 'bird', 'tail', 'thing'];
export const TEMPLATES: readonly RigTemplate[] = ['humanoid', 'quadruped', 'creature', 'object'];
export const TEMPLATE_OF: Readonly<Record<BodyType, RigTemplate>> = {
  person: 'humanoid', fourLegs: 'quadruped', bird: 'creature', tail: 'creature', thing: 'object',
};

export type TapId =
  // person
  | 'leftShoulder' | 'leftHand' | 'rightShoulder' | 'rightHand' | 'chin'
  | 'leftElbow' | 'rightElbow' | 'leftKnee' | 'rightKnee' | 'leftAnkle' | 'rightAnkle'
  // animals (the near side of the side picture is the character's right: legs FR / HR)
  | 'nose' | 'tailRoot' | 'tailTip' | 'pawFR' | 'pawHR' | 'pawFL' | 'pawHL'
  // bird extras
  | 'footR' | 'footL' | 'wingTipR' | 'wingTipL'
  // things
  | 'objStill' | 'objBendStart' | 'objBendEnd';

export const TAP_IDS: readonly TapId[] = [
  'leftShoulder', 'leftHand', 'rightShoulder', 'rightHand', 'chin', 'leftElbow', 'rightElbow', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle',
  'nose', 'tailRoot', 'tailTip', 'pawFR', 'pawHR', 'pawFL', 'pawHL', 'footR', 'footL', 'wingTipR', 'wingTipL',
  'objStill', 'objBendStart', 'objBendEnd',
];

/** Taps as [u,v,w] over the model's glTF box. */
export type RigTaps = Partial<Record<TapId, Vec3>>;

export interface BodyTypeInfo { id: BodyType; label: string; icon: string; blurb: string; template: RigTemplate; view: 'front' | 'side' }
export const BODY_TYPE_INFO: Readonly<Record<BodyType, BodyTypeInfo>> = {
  person: { id: 'person', label: 'A person', icon: '🧍', blurb: 'Two arms, two legs, standing up.', template: 'humanoid', view: 'front' },
  fourLegs: { id: 'fourLegs', label: 'Four legs', icon: '🐕', blurb: 'A dog, a horse, a llama: walks on four legs.', template: 'quadruped', view: 'side' },
  bird: { id: 'bird', label: 'A bird', icon: '🐦', blurb: 'Wings, a beak, a tail and two feet.', template: 'creature', view: 'side' },
  tail: { id: 'tail', label: 'Snake or tail', icon: '🐍', blurb: 'Long and bendy: a snake, a worm, a fish, a dragon.', template: 'creature', view: 'side' },
  thing: { id: 'thing', label: 'A thing', icon: '💡', blurb: 'A lamp, a plant, a robot arm: one part stays put, one part bends.', template: 'object', view: 'front' },
};

export interface TapStep {
  id: TapId;
  /** Big plain prompt, 12 words or fewer. */
  prompt: string;
  /** A second, smaller line. */
  hint: string;
  /** The rig can still be built without it (the planner guesses from the shape). */
  optional: boolean;
  /** Which picture to tap on. */
  view: 'front' | 'side';
  /** A mark colour so the person sees what they already placed. */
  color: string;
}

const C = { head: '#ff5ca8', arm: '#2bd4ff', leg: '#ffc02b', body: '#8affc1', tail: '#c58bff', wing: '#7aa7ff' };
const step = (id: TapId, view: 'front' | 'side', prompt: string, hint: string, optional: boolean, color: string): TapStep => ({ id, view, prompt, hint, optional, color });

const STEPS: Readonly<Record<BodyType, readonly TapStep[]>> = {
  person: [
    step('chin', 'front', 'Tap the chin', 'The point of the chin, where the head meets the neck.', true, C.head),
    step('leftShoulder', 'front', 'Tap the left shoulder', 'Their left, which is the right side of the picture.', true, C.arm),
    step('rightShoulder', 'front', 'Tap the right shoulder', 'Their right, the left side of the picture.', true, C.arm),
    step('leftElbow', 'front', 'Tap the left elbow', 'Where the arm bends.', true, C.arm),
    step('rightElbow', 'front', 'Tap the right elbow', 'Where the arm bends.', true, C.arm),
    step('leftHand', 'front', 'Tap the left hand', 'The middle of the wrist or hand.', true, C.arm),
    step('rightHand', 'front', 'Tap the right hand', 'The middle of the wrist or hand.', true, C.arm),
    step('leftKnee', 'front', 'Tap the left knee', 'Where the leg bends.', true, C.leg),
    step('rightKnee', 'front', 'Tap the right knee', 'Where the leg bends.', true, C.leg),
    step('leftAnkle', 'front', 'Tap the left ankle', 'Just above the foot.', true, C.leg),
    step('rightAnkle', 'front', 'Tap the right ankle', 'Just above the foot.', true, C.leg),
  ],
  fourLegs: [
    step('nose', 'side', 'Tap the nose', 'The very front of the face.', false, C.head),
    step('tailRoot', 'side', 'Tap where the tail starts', 'Where the tail joins the body.', false, C.tail),
    step('tailTip', 'side', 'Tap the end of the tail', 'No tail? Skip this one.', true, C.tail),
    step('pawFR', 'side', 'Tap the front foot nearest you', 'The spot where it touches the floor.', false, C.leg),
    step('pawHR', 'side', 'Tap the back foot nearest you', 'The spot where it touches the floor.', false, C.leg),
    step('pawFL', 'side', 'Tap the front foot on the far side', 'Hidden behind? Skip: it matches the near one.', true, C.leg),
    step('pawHL', 'side', 'Tap the back foot on the far side', 'Hidden behind? Skip: it matches the near one.', true, C.leg),
  ],
  bird: [
    step('nose', 'side', 'Tap the tip of the beak', 'The very front of the face.', false, C.head),
    step('tailTip', 'side', 'Tap the end of the tail', 'The tip of the longest tail feather.', false, C.tail),
    step('wingTipR', 'side', 'Tap the tip of the wing nearest you', 'Folded wings: the pointed end.', true, C.wing),
    step('footR', 'side', 'Tap the foot nearest you', 'Where it touches the floor or the perch.', true, C.leg),
    step('wingTipL', 'side', 'Tap the far wing tip', 'Hidden? Skip: it matches the near one.', true, C.wing),
    step('footL', 'side', 'Tap the far foot', 'Hidden? Skip: it matches the near one.', true, C.leg),
  ],
  tail: [
    step('nose', 'side', 'Tap the nose', 'The very front of the head.', false, C.head),
    step('tailTip', 'side', 'Tap the very end of the tail', 'The thin tip at the back.', false, C.tail),
  ],
  thing: [
    step('objStill', 'front', 'Tap the part that stays put', 'A base, a stand, a floor plate.', false, C.body),
    step('objBendStart', 'front', 'Tap where it starts to bend', 'Not sure? Skip: we pick a spot.', true, C.arm),
    step('objBendEnd', 'front', 'Tap the tip that sways the most', 'The far end: a lamp head, a leaf, a hand.', false, C.tail),
  ],
};

export const stepsFor = (t: BodyType): readonly TapStep[] => STEPS[t];

/** Taps the type cannot do without. */
export const requiredTaps = (t: BodyType): TapId[] => STEPS[t].filter((s) => !s.optional).map((s) => s.id);
export const missingRequired = (t: BodyType, taps: RigTaps): TapId[] => requiredTaps(t).filter((id) => !taps[id]);

const isTapId = (k: string): k is TapId => (TAP_IDS as readonly string[]).includes(k);

/** Keep known tap names with three finite numbers (clamped just outside the box; a tap on the picture's edge is fine). */
export function sanitizeTaps(raw: unknown): RigTaps {
  const out: RigTaps = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isTapId(k) || !Array.isArray(v) || v.length !== 3) continue;
    const n = v.map(Number);
    if (!n.every(Number.isFinite)) continue;
    out[k] = n.map((x) => Math.round(Math.min(1.1, Math.max(-0.1, x)) * 1e4) / 1e4) as Vec3;
  }
  return out;
}

export interface AutorigRequest {
  template: RigTemplate;
  bodyType: BodyType;
  taps: RigTaps;
  /** Only for the humanoid template (the existing four-click flow + the pose finder's joints). */
  soft?: SoftRigConfig;
}

const isSoft = (s: unknown): s is SoftRigConfig => !!s && typeof s === 'object'
  && ['hips', 'neck', 'chest'].every((k) => typeof (s as Record<string, unknown>)[k] === 'number');

/**
 * The body of POST /api/avatars/:id/autorig and of the MCP `autorig` tool. Old callers send `{ soft }` only: that stays the
 * humanoid flow, unchanged. New callers send `{ bodyType, taps }` (and `soft` for people).
 */
export function parseAutorigRequest(body: unknown, profileSoft?: SoftRigConfig): { ok: true; req: AutorigRequest } | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const bodyType: BodyType = (BODY_TYPES as readonly string[]).includes(b.bodyType as string) ? (b.bodyType as BodyType) : 'person';
  const template = TEMPLATE_OF[bodyType];
  const taps = sanitizeTaps(b.taps);
  if (template === 'humanoid') {
    // as before: the body's soft rig, else the profile's; anything that is not a soft rig is a 400, never a silent fallback
    const given = b.soft !== undefined && b.soft !== null ? b.soft : profileSoft;
    if (!given || !isSoft(given)) return { ok: false, error: 'Body must include { soft: SoftRigConfig } (or the profile must have rig.soft)' };
    // the person-only taps ride on the same record the four-click flow already used (joints are added only if they were given)
    const soft: SoftRigConfig = { ...given };
    for (const k of ['leftShoulder', 'rightShoulder', 'leftHand', 'rightHand'] as const) if (taps[k]) soft[k] = taps[k]!;
    return { ok: true, req: { template, bodyType, taps, soft } };
  }
  const missing = missingRequired(bodyType, taps);
  if (missing.length) return { ok: false, error: `Missing taps for ${bodyType}: ${missing.join(', ')}` };
  return { ok: true, req: { template, bodyType, taps } };
}

/** What the avatar profile should say about its body after the rig (src/avatar/AvatarRuntime.ts reads `body`, shared/bodyKind.ts):
 *  animals and birds stand on legs, a snake slithers, a thing only bends and sways; a person stays as it was. */
export const profileBodyFor = (t: RigTemplate, bodyType?: BodyType): 'quadruped' | 'object' | 'serpent' | undefined =>
  t === 'humanoid' ? undefined : t === 'object' ? 'object' : bodyType === 'tail' ? 'serpent' : 'quadruped';
