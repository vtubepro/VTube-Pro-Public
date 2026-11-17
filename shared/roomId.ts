// Room AREAS (docs/SCENES.md → "Areas: several locations in one room"): one room folder (assets/scenes/<id>/) may
// declare several places the host can be — a yacht's foyer, bar, dining room, observation deck — in scene.json:
//
//   "areas": { "foyer": { "name": "…", "label": "Foyer", "icon": "🏛", … }, "bar": { "name": "…", … } },
//   "defaultArea": "foyer"
//
// Every area is its own room id: `<room>~<area>` (the room's own id = its default area). An area's scene.json view is
// the room's scene.json shallow-merged with the area's entry (so an area overrides any top-level key: cameras,
// soloScreens, chat anchors, lights, gfx, yacht …). Its GLB nodes carry the prefix `<AREA>__` (upper case) and the page
// renames them to the plain contract names when it loads that area (src/scene/areas.ts), so every engine keeps reading
// SPOT_01 / CAM_WIDE / DOOR … unchanged. Because the id changes, everything keyed by the room id works per area for
// free: the room-change curtain, the host's remembered seat, stage presets, the way back from room-moving modes.
import type { SceneInfo } from './types.ts';

/** A room folder id (unchanged rule). */
export const ROOM_FOLDER = /^[a-z0-9][a-z0-9_-]{0,47}$/;
/** An area key (scene.json `areas` keys). */
export const AREA_KEY = /^[a-z0-9][a-z0-9_-]{0,23}$/;
/** A room id as used in SceneState.sceneId: a folder id, optionally `~<area>`. */
export const ROOM_ID = /^[a-z0-9][a-z0-9_-]{0,47}(?:~[a-z0-9][a-z0-9_-]{0,23})?$/;

export const isRoomId = (v: unknown): v is string => typeof v === 'string' && ROOM_ID.test(v);

/** `my_room` → {base: 'my_room', area: null}; `sc_890jump~bar` → {base: 'sc_890jump', area: 'bar'}. */
export function splitRoomId(id: string): { base: string; area: string | null } {
  const i = id.indexOf('~');
  return i < 0 ? { base: id, area: null } : { base: id.slice(0, i), area: id.slice(i + 1) || null };
}

/** The room folder of a (possibly area) room id. */
export const baseRoomId = (id: string): string => splitRoomId(id).base;

/** Area info as the server attaches it to every SceneInfo of a room with areas. */
export interface RoomAreaInfo {
  /** This entry's area key. */
  area: string;
  /** The room folder id (the default area's id). */
  areaOf: string;
  /** Every area of the room in order: key, room id, card name, short label, icon, whether its preview exists. */
  areaList: { key: string; id: string; name: string; label: string; icon?: string; thumb?: string | null }[];
}

/** The areas of a room's scene.json, in declaration order (only valid keys with object entries). */
export function roomAreas(j: { areas?: unknown; defaultArea?: unknown }): { keys: string[]; def: string | null } {
  const a = j.areas;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { keys: [], def: null };
  const keys = Object.keys(a).filter((k) => AREA_KEY.test(k) && !!(a as Record<string, unknown>)[k] && typeof (a as Record<string, unknown>)[k] === 'object').slice(0, 16);
  if (!keys.length) return { keys, def: null };
  const def = typeof j.defaultArea === 'string' && keys.includes(j.defaultArea) ? j.defaultArea : keys[0];
  return { keys, def };
}

/** The room id of `area` in the room `id` belongs to (the default area = the plain folder id). */
export function areaRoomId(info: Pick<SceneInfo, 'id'> & { areaOf?: string; areas?: unknown; defaultArea?: unknown }, area: string): string | null {
  const base = info.areaOf ?? baseRoomId(info.id);
  const { keys, def } = roomAreas(info);
  if (!keys.includes(area)) return null;
  return area === def ? base : `${base}~${area}`;
}

/** Keys the area overrides may NOT change (identity + files are the room's). */
const FIXED = new Set(['id', 'model', 'areas', 'defaultArea', 'ready', 'thumb', 'area', 'areaOf', 'areaList', 'roomName']);

/**
 * Expand a room with `areas` into one SceneInfo per area (the server's /api/scenes and the test mock do this).
 * `info` = the room as read from its folder (id = folder id). `thumbOf(area)` = the area's thumb URL (or the room's).
 * Rooms without areas come back unchanged (one entry).
 */
export function expandAreas(info: SceneInfo, thumbOf: (areaId: string, area: string) => string | null | undefined): SceneInfo[] {
  const j = info as SceneInfo & { areas?: Record<string, Record<string, unknown>>; defaultArea?: string };
  const { keys, def } = roomAreas(j);
  if (!keys.length || !def) return [info];
  const idOf = (k: string) => (k === def ? info.id : `${info.id}~${k}`);
  const areaList = keys.map((k) => {
    const a = j.areas![k] ?? {};
    const name = typeof a.name === 'string' ? a.name.slice(0, 80) : `${info.name} — ${k}`;
    const label = typeof a.label === 'string' ? a.label.slice(0, 24) : k;
    const icon = typeof a.icon === 'string' ? a.icon.slice(0, 8) : undefined;
    return { key: k, id: idOf(k), name, label, ...(icon ? { icon } : {}), thumb: thumbOf(idOf(k), k) ?? info.thumb ?? null };
  });
  return keys.map((k) => {
    const over: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(j.areas![k] ?? {})) if (!FIXED.has(key)) over[key] = v;
    const e = areaList.find((x) => x.key === k)!;
    return { ...info, ...over, id: e.id, name: e.name, model: info.model, ready: info.ready, thumb: e.thumb,
      area: k, areaOf: info.id, areaList, roomName: info.name } as SceneInfo;
  });
}
