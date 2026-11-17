// Which room is an environment's TTRPG table (shared by the TTRPG session and the stage-mode entry): the room's own
// `<env>_ttrpg` (scene.json ttrpg.of = env, or the environment's `ttrpgRoom`), else the generic table (ttrpg.of = "*").
import type { SceneInfo } from '../types.ts';
import type { RoomTtrpgConfig } from './state.ts';
import { baseRoomId } from '../roomId.ts';

const cfgOf = (s: SceneInfo | undefined | null) => (s as unknown as { ttrpg?: RoomTtrpgConfig } | null | undefined)?.ttrpg;

export function ttrpgRoomFor(scenes: SceneInfo[], env: string | null | undefined): string | null {
  const here = env ? scenes.find((s) => s.id === env) : undefined;
  if (here && cfgOf(here)) return here.id;                                   // already at a table
  const own = (here as unknown as { ttrpgRoom?: string } | undefined)?.ttrpgRoom;
  if (own && scenes.some((s) => s.id === own && s.ready !== false)) return own;
  const of = env ? scenes.find((s) => (cfgOf(s)?.of === env || cfgOf(s)?.of === baseRoomId(env)) && s.ready !== false) : undefined;
  if (of) return of.id;
  return scenes.find((s) => cfgOf(s)?.of === '*' && s.ready !== false)?.id ?? null;
}

/** The environment a TTRPG room belongs to ('' for the generic table). */
export function envOfRoom(scenes: SceneInfo[], room: string | null | undefined): string {
  const of = cfgOf(scenes.find((s) => s.id === room))?.of;
  return of && of !== '*' ? of : '';
}
