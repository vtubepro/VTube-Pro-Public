// beta.16 cross-lane bus commands (docs/b16/LANES.md): the few commands one lane SENDS and another lane HANDLES. They ride the
// existing bus message `{ type: 'command', command, args }`, so shared/types.ts does not change. Items and rules have their own
// files (shared/avatarItems.ts, shared/streamRules.ts); everything else a lane plays is addressed by its deck action's bus command
// (shared/deck.ts: throw, item-scene, sticker, emote-rain, sfx, screen-fx, recorded-emote, cohost-say, cohost-mute).
//
//   model-move    sender: VTS API lane (MoveModelRequest), rules, deck     handler: throw lane (src/avatar/hitReact.ts)
//   model-state   sender: VTS API lane (CurrentModelRequest)              handler: throw lane answers with `model-state-reply`
//   art-list      sender: VTS API lane (ArtMeshListRequest)               handler: items lane answers with `art-list-reply`
//   art-tint      sender: VTS API lane (ColorTintRequest)                 handler: items lane (src/avatar/items/tint.ts)
//   model-clicked sender: the host's studio (src/avatar/modelClick.ts)     handler: VTS API lane (ModelClickedEvent); one-way, no reply
//
// Requests carry `req` (a short id); the answer is a command of the same name + `-reply` with the same `req`, sent by the
// studio page that owns the avatar. The VTS API lane waits for it with a timeout and answers the plugin "not available" when none comes.
import type { BusMessage } from './types.ts';

export const MODEL_MOVE_COMMAND = 'model-move';
export const MODEL_STATE_COMMAND = 'model-state';
export const ART_LIST_COMMAND = 'art-list';
export const ART_TINT_COMMAND = 'art-tint';
export const MODEL_CLICKED_COMMAND = 'model-clicked';
export const replyOf = (command: string) => `${command}-reply`;

/** Nudge the model on the picture. Units are the VTS ones: x, y in -1..1 of the frame (0 = centre), rotation in degrees, size -100..100 (VTS "size"). */
export interface ModelMove { x?: number; y?: number; rot?: number; size?: number; relative?: boolean; /** glide time (s, 0 = jump) */ secs?: number }
export interface ModelState { req?: string; x: number; y: number; rot: number; size: number; loaded: boolean; /** avatar id */ id: string; name: string }
export interface ArtList { req?: string; /** Pro2D / flat part names, or the 3D avatar's mesh / material group names. */ names: string[]; /** tags (groups of names) */ tags: string[] }
/** Tint named parts (or all): colour 0..255, `mix` 0..1 how strongly, `secs` 0 = until cleared (a plugin disconnecting clears its own). */
export interface ArtTint { names?: string[]; tags?: string[]; all?: boolean; r: number; g: number; b: number; a?: number; mix?: number; secs?: number; /** clear this tint instead */ clear?: boolean; by?: string }

/** The host clicked / tapped the avatar in the studio preview. x, y in VTS units (-1..1 of the frame, +y up), button 0 left / 1 right / 2 middle,
 *  `hit` = the click landed on the avatar, `parts` = the names under the click (the same names `art-list` gives). */
export interface ModelClicked { x: number; y: number; button: number; hit: boolean; parts?: string[] }

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const NAME = /^[\w .:\-/()]{1,64}$/;
const names = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && NAME.test(s)).slice(0, 64) : undefined);

export function sanitizeModelMove(o: unknown): ModelMove | null {
  const x = rec(o), m: ModelMove = {};
  if (typeof x.x === 'number') m.x = num(x.x, -3, 3, 0);
  if (typeof x.y === 'number') m.y = num(x.y, -3, 3, 0);
  if (typeof x.rot === 'number') m.rot = num(x.rot, -360, 360, 0);
  if (typeof x.size === 'number') m.size = num(x.size, -100, 100, 0);
  if (x.relative === true) m.relative = true;
  if (typeof x.secs === 'number') m.secs = num(x.secs, 0, 10, 0);
  return m.x === undefined && m.y === undefined && m.rot === undefined && m.size === undefined ? null : m;
}
export function sanitizeArtTint(o: unknown): ArtTint | null {
  const x = rec(o), nm = names(x.names), tg = names(x.tags);
  if (!nm?.length && !tg?.length && x.all !== true) return null;
  return {
    ...(nm?.length ? { names: nm } : {}), ...(tg?.length ? { tags: tg } : {}), ...(x.all === true ? { all: true } : {}),
    r: Math.round(num(x.r, 0, 255, 255)), g: Math.round(num(x.g, 0, 255, 255)), b: Math.round(num(x.b, 0, 255, 255)),
    ...(typeof x.a === 'number' ? { a: num(x.a, 0, 255, 255) } : {}), ...(typeof x.mix === 'number' ? { mix: num(x.mix, 0, 1, 1) } : {}), ...(typeof x.secs === 'number' ? { secs: num(x.secs, 0, 600, 0) } : {}),
    ...(x.clear === true ? { clear: true } : {}), ...(typeof x.by === 'string' && NAME.test(x.by) ? { by: x.by } : {}),
  };
}

export const commandMessage = (command: string, args: unknown): BusMessage => ({ type: 'command', command, args });
