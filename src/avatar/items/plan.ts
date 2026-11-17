// Turning the deck / Rules words ("Sticker on me", "Item scene") into concrete ItemOps. PURE (the random source and the clock are
// parameters), so the unit test can pin every pick. The studio calls this and only this; OBS pages never see the words, only
// the primitive ops that come out (src/avatar/items/store.ts).
import {
  freeItemId, libKind, pinChoice, sanitizePlace, specForChoice,
  type ItemOp, type ItemPlace, type ItemSource, type ItemSpec, type StickerDef,
} from '../../../shared/avatarItems.ts';
import type { ItemStore } from './store.ts';

/** A picture the host can pick from: a starter sticker or one of their own kept files. */
export interface PickableSticker {
  /** The id the deck / rules name it by. */
  id: string;
  name: string;
  /** Library id: `stickers/<file>` for the starters, `mine/<file>` for the host's own. */
  lib: string;
  def?: StickerDef;
}

export const STARTER_LIB = 'stickers/';
export const MINE_LIB = 'mine/';

export function pickables(starters: readonly StickerDef[], mine: readonly { lib: string; name: string }[]): PickableSticker[] {
  return [
    ...starters.map((d) => ({ id: d.id, name: d.name, lib: `${STARTER_LIB}${d.file}`, def: d })),
    ...mine.filter((m) => libKind(m.lib) === 'image').map((m) => ({ id: m.lib.replace(/^mine\//, '').replace(/\.[a-z0-9]+$/i, ''), name: m.name, lib: m.lib })),
  ];
}

/** The spec for putting one pickable picture on the avatar (the sticker's own spot, or the forehead for the host's own). */
export function specForSticker(p: PickableSticker, id: string, over?: { jitter?: () => number; ttlSecs?: number }): ItemSpec {
  const choice = pinChoice(p.def?.pin ?? 'forehead') ?? pinChoice('forehead')!;
  const base = specForChoice(id, libKind(p.lib), { lib: p.lib }, choice, { place: p.def?.place, layer: p.def?.layer, hand: p.def?.hand ?? undefined, name: p.name });
  let place: ItemPlace = base.place;
  if (over?.jitter) {
    // a stack of random stickers must not sit exactly on top of each other: a small shake in place, size and tilt
    const j = over.jitter;
    place = sanitizePlace({ ...place, x: place.x + (j() - 0.5) * 0.03, y: place.y + (j() - 0.5) * 0.03, rot: place.rot + (j() - 0.5) * 24, scale: place.scale * (0.88 + j() * 0.24) });
  }
  return { ...base, place, ...(over?.ttlSecs ? { ttlSecs: over.ttlSecs } : {}) };
}

export interface StickerArgs { op?: string; item?: string; secs?: number }
export interface PlanOk { ok: true; ops: ItemOp[]; /** the item ids this put on (the Rules "put back" step takes exactly these away) */ ids: string[]; note?: string }
export interface PlanErr { ok: false; error: string }
export type Plan = PlanOk | PlanErr;
export interface PlanCtx { store: ItemStore; pickables: readonly PickableSticker[]; rng: () => number; by: ItemSource }

/** Match what the deck / a rule typed to a picture: the id, the file name, or the name (any case). */
export function findPickable(list: readonly PickableSticker[], what: string): PickableSticker | undefined {
  const w = what.trim().toLowerCase();
  if (!w) return undefined;
  return list.find((p) => p.id.toLowerCase() === w) ?? list.find((p) => p.lib.toLowerCase() === w || p.lib.toLowerCase().endsWith(`/${w}`)) ?? list.find((p) => p.name.toLowerCase() === w);
}

/** The deck / rules "Sticker on me". */
export function planSticker(a: StickerArgs, c: PlanCtx): Plan {
  const op = a.op === 'add' || a.op === 'clear' || a.op === 'remove' ? a.op : 'random';
  if (op === 'clear') {
    // everything except what a VTube Studio plugin put there itself (it takes its own away when it leaves)
    const ids = c.store.list().filter((e) => e.by !== 'vts').map((e) => e.spec.id);
    return { ok: true, ops: ids.map((id): ItemOp => ({ op: 'remove', id })), ids: [] };
  }
  if (op === 'remove') {
    const id = (a.item ?? '').trim();
    return c.store.has(id) ? { ok: true, ops: [{ op: 'remove', id }], ids: [] } : { ok: true, ops: [], ids: [] };
  }
  if (!c.pickables.length) return { ok: false, error: 'There are no stickers to pick from' };
  let pick: PickableSticker | undefined;
  if (op === 'add' && a.item) {
    pick = findPickable(c.pickables, a.item);
    if (!pick) return { ok: false, error: `There is no sticker called "${a.item}"` };
  } else {
    // random: one that is not on yet when there is one (a redeem should look new)
    const worn = new Set(c.store.list().map((e) => ('lib' in e.spec.src ? e.spec.src.lib : '')));
    const fresh = c.pickables.filter((p) => !worn.has(p.lib));
    const pool = fresh.length ? fresh : c.pickables;
    pick = pool[Math.min(pool.length - 1, Math.floor(c.rng() * pool.length))];
  }
  const id = freeItemId(`st-${pick.id}`, (x) => c.store.has(x));
  const secs = a.secs && a.secs > 0 ? Math.min(600, a.secs) : 0;
  const spec = specForSticker(pick, id, { jitter: c.rng, ...(secs ? { ttlSecs: secs } : {}) });
  return { ok: true, ops: [{ op: 'add', item: spec, by: c.by }], ids: [id] };
}

export interface SceneArgs { name?: string; on?: boolean | 'toggle' | string }
/** The deck / rules "Item scene": an empty name means the one used last (or the only / first one). */
export function planItemScene(a: SceneArgs, c: { store: ItemStore; by: ItemSource }): Plan & { name?: string } {
  const sceneCount = c.store.scenes.length;
  if (!sceneCount) return { ok: false, error: 'You have no item scenes yet. Put some stickers on, then press "Save as a scene"' };
  let name = (a.name ?? '').trim();
  if (!name) name = c.store.lastScene || c.store.scenes[0].name;
  const sc = c.store.sceneByName(name);
  if (!sc) return { ok: false, error: `There is no item scene called "${name}"` };
  const on = a.on === true || a.on === 'true' ? true : a.on === false || a.on === 'false' ? false : 'toggle';
  return { ok: true, ops: [{ op: 'scene-toggle', name: sc.name, on, by: c.by }], ids: [], name: sc.name };
}

/** A name a deck key can carry (shared/deck.ts EXTRA_NAME): letters, digits, space, dot, dash, underscore. */
export function cleanSceneName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_ .-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48);
}
