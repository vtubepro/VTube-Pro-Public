import type { AvatarProfile } from './types.ts';
import { sanitizeEyeDepth } from './eyeDepth.ts';
import { sanitizeIdleArmDown } from './idleArm.ts';
import { sanitizeBlendCurves } from './blendCurves.ts';
import { ARKIT } from './arkitNames.ts';
import { sanitizeArmFront, sanitizeArmFrontReact, sanitizeArmPose } from './armPose.ts';
import { sanitizeEyeLayoutFields } from './eyeLayout.ts';
import { sanitizeBakedEyes } from './bakedEyes.ts';
import { sanitizeFaceMap } from './morphNames.ts';
import { sanitizeMech } from './mech.ts';
import { sanitizeFlatConfig } from './flatAvatar.ts';
import { sanitizeBoneMap } from './modelImport/bones.ts';
import { sanitizeRigMap } from './rigMap.ts';

export function defaultProfile(id: string, name: string, modelFile: string, source: AvatarProfile['source'] = 'import'): AvatarProfile {
  return {
    version: 1,
    id,
    name,
    modelFile,
    source,
    createdAt: new Date().toISOString(),
    transform: { scale: 1, offset: [0, 0, 0], yaw: 0 },
    eyes: {
      mode: 'model',
      style: 'bulb',
      left: null,
      right: null,
      size: 0.06,
      protrusion: 0.55,
      scleraColor: '#ffffff',
      irisColor: '#111111',
      irisSize: 0.42,
      pupilSize: 0.75,
      lidColor: null,
      outline: true,
      gazeRange: 28,
      restOpen: 1,
      highlight: true,
    },
    mouth: {
      mode: 'model',
      style: 'cavity',
      center: null,
      width: 0.07,
      openHeight: 0.06,
      influence: 0.12,
      lipColor: '#1a1a1a',
      interiorColor: '#3a0d12',
      tongueColor: '#e0607a',
      teethColor: '#f7f7f2',
      showTeeth: false,
      showTongue: true,
      lineWidth: 0.006,
      restCurve: 0,
    },
    brows: { enabled: false, color: '#1a1a1a', thickness: 0.008 },
    look: { shading: 'anime', rim: 0.5, shadowTint: '#ceb6c2', softness: 0.15, hairShine: 0.6 },
    blush: { enabled: false, color: '#ff8a9a', rest: 0.3, hatch: true },
    rig: { kind: 'none' },
    physics: { enabled: true, jiggle: [], chains: [], autoChains: true, wind: 0 },
    tracking: {
      expressiveness: 1.15,
      gains: {},
      smoothing: 0.45,
      headRotationScale: 1,
      bodyFollow: 0.6,
      mirror: true,
      trackHands: true,
      trackBody: true,
      audioLipSync: false,
      facialHair: -1,
      translate: [1, 0.7, 1.2],
      armExaggeration: 1.25,
      armBounce: 0.45,
      gestureFx: true,
      gestureReactions: true,
      expressionBoost: 1,
      cartoon: 1,
      enunciation: 1.3,
    },
    costumes: [],
    costume: null,
  };
}

/** Fill in any fields missing from an older/partial profile. */
export function normalizeProfile(p: Partial<AvatarProfile> & { id: string; modelFile: string }): AvatarProfile {
  const d = defaultProfile(p.id, p.name ?? p.id, p.modelFile, p.source);
  // no look chosen yet: robots / props (mechanical rigs) get the stylised-PBR 'toy' look, everything else anime
  if (!p.look?.shading && p.rig?.mechanical) d.look = { ...d.look!, shading: 'toy', rim: 0.35 };
  const out = {
    ...d,
    ...p,
    transform: { ...d.transform, ...p.transform },
    eyes: { ...d.eyes, ...p.eyes },
    mouth: { ...d.mouth, ...p.mouth },
    brows: { ...d.brows, ...p.brows },
    look: { ...d.look!, ...p.look },
    blush: { ...d.blush!, ...p.blush },
    rig: { ...d.rig, ...p.rig },
    physics: { ...d.physics, ...p.physics },
    tracking: { ...d.tracking, ...p.tracking, gains: { ...d.tracking.gains, ...p.tracking?.gains } },
    costumes: p.costumes ?? [],
    costume: p.costume ?? null,
  } as AvatarProfile;
  // keep-hands-out-of-the-body depth (src/avatar/bodyGuard.ts): 1..2, or nothing (= 1)
  if (out.tracking.bodyDepth !== undefined) { const v = Number(out.tracking.bodyDepth); if (Number.isFinite(v)) out.tracking.bodyDepth = Math.min(2, Math.max(1, v)); else delete out.tracking.bodyDepth; }
  // the untracked arms' angle below horizontal (shared/idleArm.ts): 20..85 degrees, or nothing (= the built-in pose)
  if ('idleArmDown' in out.tracking) { const v = sanitizeIdleArmDown(out.tracking.idleArmDown); if (v === undefined) delete out.tracking.idleArmDown; else out.tracking.idleArmDown = v; }
  // the 52 face channels' range + response curves (shared/blendCurves.ts): clean curves or nothing
  if ('blendCurves' in out.tracking) { const v = sanitizeBlendCurves(out.tracking.blendCurves, ARKIT); if (v) out.tracking.blendCurves = v; else delete out.tracking.blendCurves; }
  // the Arms choice (shared/armPose.ts): known values only; 'follow' (the default) and 'together' are never stored
  if ('armPose' in out.tracking) { const v = sanitizeArmPose(out.tracking.armPose); if (v === undefined) delete out.tracking.armPose; else out.tracking.armPose = v; }
  if ('armFront' in out.tracking) { const v = sanitizeArmFront(out.tracking.armFront); if (v === undefined) delete out.tracking.armFront; else out.tracking.armFront = v as 'clasped' | 'desk' | 'controller'; }
  if ('armFrontReact' in out.tracking) { const v = sanitizeArmFrontReact(out.tracking.armFrontReact); if (v === undefined) delete out.tracking.armFrontReact; else out.tracking.armFrontReact = v; }
  // eye depth (in / out along the face normal): a clean number or nothing
  if ('depth' in out.eyes) { const v = sanitizeEyeDepth(out.eyes.depth); if (v === undefined) delete out.eyes.depth; else out.eyes.depth = v; }
  // eye layout (one eye / cyclops) + eye patch: clean values or nothing (shared/eyeLayout.ts)
  sanitizeEyeLayoutFields(out.eyes);
  // painted-eye replacement: a clean config or nothing
  // the performer's own face-shape picks (shared/morphNames.ts): known keys only, or nothing
  if ('faceMap' in out) { const v = sanitizeFaceMap(out.faceMap); if (v) out.faceMap = v; else delete out.faceMap; }
  // the import's bone matching (shared/modelImport/bones.ts): VRM bone names only, or nothing
  if (out.rig && 'boneMap' in out.rig) { const v = sanitizeBoneMap(out.rig.boneMap); if (v) out.rig.boneMap = v; else delete out.rig.boneMap; }
  // the 3D auto-rig's retarget map (shared/rigMap.ts): known fields, clamped numbers, or nothing
  if (out.rig && 'retarget' in out.rig) { const v = sanitizeRigMap(out.rig.retarget); if (v) out.rig.retarget = v; else delete out.rig.retarget; }
  // walking machine settings (shared/mech.ts): a clean config or nothing
  if ('mech' in out) { const v = sanitizeMech(out.mech); if (v) out.mech = v; else delete out.mech; }
  // 2D avatar (shared/flatAvatar.ts): a clean config or nothing
  if ('flat' in out) { const v = sanitizeFlatConfig(out.flat); if (v) out.flat = v; else delete out.flat; }
  if ('replaceBaked' in out.eyes) { const v = sanitizeBakedEyes(out.eyes.replaceBaked); if (v === undefined) delete out.eyes.replaceBaked; else out.eyes.replaceBaked = v; }
  return out;
}
