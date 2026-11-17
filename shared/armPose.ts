// The "Arms" choice (Tracking panel -> Arms & hands): what the avatar's arms do. Per avatar, saved in the profile
// (profile.tracking.armPose / armFront / armFrontReact). Pure data + sanitising, no three.js: the studio panel, the profile
// normaliser and the tests all read it. The pose itself is src/avatar/armPose.ts, the retargeter applies it
// (src/avatar/retarget.ts).
//
//   follow  Follow my arms  (the default, unset): the tracked arms move the avatar's arms, a relaxed rest when the camera
//                           can't see them. Exactly the behaviour before this choice existed.
//   sides   At my sides:    the relaxed resting pose, always. Tracked arms and hands are ignored.
//   front   In front:       forearms forward, hands together or resting in front of the body, as at a desk. Built from the
//                           avatar's own bone lengths and body width; the tracked arms still take over for big gestures.

export type ArmPoseMode = 'follow' | 'sides' | 'front';
export const ARM_POSE_MODES: ArmPoseMode[] = ['follow', 'sides', 'front'];

/** How the hands sit for "In front". */
export type ArmFrontStyle = 'together' | 'clasped' | 'desk' | 'controller';
export const ARM_FRONT_STYLES: ArmFrontStyle[] = ['together', 'clasped', 'desk', 'controller'];
export const ARM_FRONT_DEFAULT: ArmFrontStyle = 'together';

/** Plain words for the panel (no jargon). */
export const ARM_POSE_TEXT: Record<ArmPoseMode, { name: string; hint: string }> = {
  follow: { name: 'Follow my arms', hint: 'Your arms move the avatar’s arms when the camera sees them. This is how it has always worked.' },
  sides: { name: 'At my sides', hint: 'The avatar’s arms rest at its sides, always. Your arm movements are ignored.' },
  front: { name: 'In front', hint: 'The avatar’s forearms rest in front of its body, hands together or on a desk. Big gestures you make still come through.' },
};
export const ARM_FRONT_TEXT: Record<ArmFrontStyle, { name: string; hint: string }> = {
  together: { name: 'Hands together', hint: 'Both hands rest side by side in front, relaxed.' },
  clasped: { name: 'Hands clasped', hint: 'Hands held together, fingers curled round each other.' },
  desk: { name: 'On a desk', hint: 'Hands flat on a desk in front of the avatar, a shoulder-width apart.' },
  controller: { name: 'Holding a controller', hint: 'Both hands close together, fingers curled as if holding a game controller.' },
};

/** A clean mode, or nothing. "follow" is the default and is never stored: an avatar without the setting behaves exactly as before. */
export function sanitizeArmPose(v: unknown): 'sides' | 'front' | undefined {
  return v === 'sides' || v === 'front' ? v : undefined;
}
/** A clean hand style, or nothing (= "together", the default). */
export function sanitizeArmFront(v: unknown): ArmFrontStyle | undefined {
  return v === 'clasped' || v === 'desk' || v === 'controller' ? v : undefined;
}
/** "In front" reacts to big tracked gestures unless this is false; only false is stored. */
export function sanitizeArmFrontReact(v: unknown): false | undefined {
  return v === false ? false : undefined;
}

/**
 * Does this avatar get the Arms choice? 3D humanoids do. A 2D avatar (profile.flat: a picture card, an overlay, a Pro2D rig) has
 * no skeleton for it: its arms, if the rig has any, are the rigger's own model sliders (shared/rig2d/userParams.ts "pose"), so
 * the choice is hidden there (no message, nothing saved). Four-legged bodies have no arms either; a walking machine's pilot
 * is placed by the machine (src/avatar/mech.ts).
 */
export function armPoseAvailable(p: { flat?: unknown; body?: string } | null | undefined): boolean {
  return !!p && !p.flat && p.body !== 'quadruped' && p.body !== 'mech';
}

/** The effective settings of a tracking block (what the retargeter and the panel read). */
export function armSettings(t: { armPose?: unknown; armFront?: unknown; armFrontReact?: unknown } | undefined): { mode: ArmPoseMode; style: ArmFrontStyle; react: boolean } {
  return {
    mode: sanitizeArmPose(t?.armPose) ?? 'follow',
    style: sanitizeArmFront(t?.armFront) ?? ARM_FRONT_DEFAULT,
    react: sanitizeArmFrontReact(t?.armFrontReact) !== false,
  };
}
