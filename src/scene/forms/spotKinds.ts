// Seat routing by body kind (creations/desert_walker/SPEC.md 6.1 C1; shared/occupant.ts spotFitOcc): which spots take
// which bodies. A room marks spots with GLB extras `kinds: ["biped", "quadruped", "tv"]` or scene.json
// `spotKinds: { "SPOT_02": [...] }` (wins over the extras), so a mech never gets the couch; a forms zone that converts for
// an occupant (the dock at the host desk, a landing pad) counts as made for them. Both the studio controller (host seat
// picks) and every page's SceneRuntime (guests the host hasn't placed) score spots through here.
import type { RoomInfo } from '../contract.ts';
import type { SceneActor } from '../actor.ts';
import { occupantOf, parseKinds, sanitizeOccupantRules, type Occupant, type OccupantRules, type ZoneConverts } from '../../../shared/occupant.ts';
import { parseForms, zoneConverts } from '../../../shared/forms.ts';

/** GLB extras `kinds` / scene.json `spotKinds` -> SpotInfo.kinds (null / missing = any body kind). */
export function applySpotKinds(room: RoomInfo, info: unknown) {
  const o = (info && typeof info === 'object' ? (info as { spotKinds?: unknown }).spotKinds : null);
  const map = (o && typeof o === 'object' && !Array.isArray(o) ? o : {}) as Record<string, unknown>;
  for (const s of room.spots) {
    if (!s) continue;
    const k = (Object.prototype.hasOwnProperty.call(map, s.name) ? parseKinds(map[s.name]) : null) ?? parseKinds(s.extras?.kinds);
    if (k) s.kinds = k;
  }
}

/** A room's seat-routing context: its occupant rules (scene.json `occupants` / forms) and the forms zones' rule (1). */
export interface SeatRouting { rules: OccupantRules; converts: ZoneConverts | null }
const cache = new WeakMap<object, SeatRouting>();
export function seatRoutingOf(info: unknown): SeatRouting {
  const key = info && typeof info === 'object' ? info : null;
  const hit = key ? cache.get(key) : undefined;
  if (hit) return hit;
  const defs = parseForms(info);
  const r: SeatRouting = { rules: defs?.rules ?? sanitizeOccupantRules((info as { occupants?: unknown } | null)?.occupants), converts: zoneConverts(defs) };
  if (key) cache.set(key, r);
  return r;
}

/** A performer in the room as the seat rules see them: their profile's occupant, with the size class the actor uses. */
export function actorOccupant(a: SceneActor, rules: OccupantRules): Occupant {
  const o = occupantOf(a.runtime?.profile ?? null, rules, a.rest?.height, a.base);
  return o.size === a.size.cls ? o : { ...o, size: a.size.cls };
}
