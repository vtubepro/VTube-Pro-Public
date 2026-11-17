// Room catalogue for the visual room picker (src/ui/roomPicker.ts): which "world" a room belongs to, which rooms are
// test / work-in-progress, which TTRPG table belongs to which room, and the short feature badges. Pure (no DOM), so the
// grouping rules are one place. A room can name its world in scene.json: "world": "Tarkov" (or "group"); otherwise the
// id prefix decides (eft_ → Tarkov …), and anything unknown lands in "More rooms".
import type { SceneInfo } from '../../shared/types.ts';

export interface WorldDef { id: string; label: string; icon: string; hue: number; aliases?: string[] }

/** Known worlds, in the order the picker shows them. `hue` tints the world's dot / card edge. */
export const WORLDS: WorldDef[] = [
  { id: 'lounge', label: 'Gaming Lounge', icon: '🎮', hue: 280 },
  { id: 'tarkov', label: 'Tarkov', icon: '🪖', hue: 36, aliases: ['Escape from Tarkov', 'EFT'] },
  { id: 'grayzone', label: 'Gray Zone', icon: '🎯', hue: 150, aliases: ['Gray Zone Warfare', 'GZW'] },
  { id: 'helldivers', label: 'Helldivers', icon: '🪐', hue: 52, aliases: ['Helldivers 2'] },
  { id: 'starcitizen', label: 'Star Citizen', icon: '🚀', hue: 200, aliases: ['ArcCorp'] },
  { id: 'poe', label: 'Path of Exile', icon: '⚓', hue: 12, aliases: ['Path of Exile 2', 'PoE', 'PoE2'] },
  { id: 'lastepoch', label: 'Last Epoch', icon: '⏳', hue: 190 },
  { id: 'tabletop', label: 'Tabletop', icon: '🎲', hue: 330 },
  { id: 'other', label: 'More rooms', icon: '🏠', hue: 220 },
  { id: 'test', label: 'Test rooms', icon: '🧪', hue: 0 },
];
const PREFIX: [RegExp, string][] = [
  [/^gaming_lounge/, 'lounge'], [/^eft_|^tarkov_/, 'tarkov'],
  [/^gzw_|^grayzone_/, 'grayzone'], [/^helldivers_|^hd2_/, 'helldivers'], [/^sc_|^starcitizen_/, 'starcitizen'],
  [/^poe2?_/, 'poe'], [/^lastepoch_|^le_/, 'lastepoch'], [/^ttrpg_/, 'tabletop'],
];

type Extra = { world?: unknown; group?: unknown; test?: unknown; crowd?: unknown; town?: unknown; traffic?: unknown; stage?: unknown; parent?: unknown };
const extra = (r: SceneInfo) => r as SceneInfo & Extra;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Test / work-in-progress rooms (hidden behind "Show test rooms"): grey boxes, test yards, `*_v2` rebuilds, scene.json "test": true. */
export function isTestRoomInfo(r: SceneInfo): boolean {
  if (extra(r).test === true) return true;
  if (extra(r).test === false) return false;
  return /(^|_)test(_|$)|_v\d+$|_wip$/i.test(r.id) || /test room|grey box|gray box|test yard/i.test(r.name);
}

/** The room this TTRPG table belongs to (scene.json ttrpg.of / parent), or null for rooms that aren't tables / the generic table. */
export function tableParent(r: SceneInfo, all: SceneInfo[]): string | null {
  const of = r.ttrpg?.of;
  if (of && of !== '*' && all.some((x) => x.id === of)) return of;
  const p = extra(r).parent;
  if (r.ttrpg && typeof p === 'string' && all.some((x) => x.id === p)) return p;
  return null;
}

/** World of a room: scene.json "world" / "group" first (matched to a known world by name or alias, else its own group), then the id prefix. */
export function worldOf(r: SceneInfo): WorldDef {
  if (isTestRoomInfo(r)) return WORLDS.find((w) => w.id === 'test')!;
  const named = extra(r).world ?? extra(r).group;
  if (typeof named === 'string' && named.trim()) {
    const k = slug(named);
    const hit = WORLDS.find((w) => slug(w.label) === k || w.id === k || w.aliases?.some((a) => slug(a) === k));
    if (hit) return hit;
    const label = named.trim().slice(0, 32);
    return { id: `w:${k}`, label, icon: '🏠', hue: [...k].reduce((a, c) => a + c.charCodeAt(0) * 7, 0) % 360 };
  }
  for (const [re, id] of PREFIX) if (re.test(r.id)) return WORLDS.find((w) => w.id === id)!;
  return WORLDS.find((w) => w.id === 'other')!;
}

/** The name without its world prefix / suffix ("Gray Zone — Crimson Camp" under Gray Zone → "Crimson Camp"). */
export function shortName(name: string, w: WorldDef): string {
  const words = [w.label, ...(w.aliases ?? [])].map(slug);
  const parts = name.split(/\s+[—–-]\s+/);
  if (parts.length === 2) {
    if (words.includes(slug(parts[0]))) return parts[1];
    if (words.includes(slug(parts[1]))) return parts[0];
  }
  // "The Studio Swamp" under Studio → "Swamp" (only when a real name is left)
  const low = name.toLowerCase().replace(/^the\s+/, '');
  for (const w0 of [w.label, ...(w.aliases ?? [])]) {
    const k = w0.toLowerCase();
    const rest = low.startsWith(`${k} `) ? name.slice(name.length - low.length + k.length + 1).trim() : '';
    if (rest.length >= 3 && !/^[—–(-]/.test(rest)) return rest.replace(/^./, (c) => c.toUpperCase());
  }
  return name;
}
/** A table room's own name ("The Stump Hollow (Studio Swamp TTRPG)" → "The Stump Hollow"). */
export const tableName = (name: string) => name.replace(/\s*\([^)]*\bTTRPG\b[^)]*\)\s*$/i, '').trim() || name;

export interface RoomBadge { icon: string; label: string }
/** What makes a room special, as small badges (modes other than Talk / React first, then engines / crowds). */
export function roomBadges(r: SceneInfo): RoomBadge[] {
  const x = extra(r), out: RoomBadge[] = [];
  if (r.modes?.includes('gaming' as never) || x.stage) out.push({ icon: '🎮', label: 'Gaming layouts' });
  if (r.kitchen) out.push({ icon: '🍳', label: 'Kitchen crew' });
  if (r.space) out.push({ icon: '🌌', label: 'Space battle outside' });
  if (r.raid) out.push({ icon: '💥', label: 'Background combat' });
  if (r.eras?.list?.length) out.push({ icon: '⏳', label: 'Era shifts' });
  if (r.environment) out.push({ icon: '🌦', label: 'Time of day & weather' });
  if (x.town) out.push({ icon: '🏘', label: 'Town life' });
  if (x.crowd) out.push({ icon: '👥', label: 'Crowd' });
  if (x.traffic) out.push({ icon: '🚦', label: 'Traffic' });
  if (!r.modes?.includes('react')) out.push({ icon: '🎙', label: 'Talk only (no React screen)' });
  if ((r.areaList?.length ?? 0) > 1) out.unshift({ icon: '🧭', label: `${r.areaList!.length} areas to choose from` });
  return out;
}

export interface RoomEntry {
  info: SceneInfo;
  world: WorldDef;
  /** Card title (world prefix removed). */
  title: string;
  test: boolean;
  /** This room's TTRPG table (a `<env>_ttrpg` room), shown as a chip on the card instead of its own card. */
  table: SceneInfo | null;
  badges: RoomBadge[];
  /** Rooms with areas (shared/roomId.ts): every area of the room, shown as chips on this one card. */
  areas: { key: string; id: string; label: string; icon?: string; name: string }[];
}
export interface Catalogue {
  /** Every card (tables folded into their parent's card), world order, then name. */
  entries: RoomEntry[];
  byId: Map<string, RoomEntry>;
  /** table room id → its parent card id. */
  tableOf: Map<string, string>;
  /** area room id (`<room>~<area>`) → its room's card id. */
  areaOf: Map<string, string>;
  worlds: WorldDef[];
}

export function catalogue(scenes: SceneInfo[]): Catalogue {
  const tableOf = new Map<string, string>();
  const tableFor = new Map<string, SceneInfo>();
  for (const r of scenes) {
    const p = tableParent(r, scenes);
    if (p) { tableOf.set(r.id, p); if (!tableFor.has(p) || r.ready !== false) tableFor.set(p, r); }
  }
  // (a room may also point at its table itself: scene.json "ttrpgRoom")
  for (const r of scenes) if (r.ttrpgRoom && !tableFor.has(r.id)) { const t = scenes.find((x) => x.id === r.ttrpgRoom); if (t) { tableFor.set(r.id, t); tableOf.set(t.id, r.id); } }
  // rooms with areas: one card per room (its default area's id), the other areas fold into it as chips
  const areaOf = new Map<string, string>();
  for (const r of scenes) if (r.areaOf && r.id !== r.areaOf && scenes.some((x) => x.id === r.areaOf)) areaOf.set(r.id, r.areaOf);
  const entries: RoomEntry[] = [];
  for (const r of scenes) {
    if (tableOf.has(r.id) || areaOf.has(r.id)) continue;
    const world = worldOf(r);
    // (a stand-alone table room — ttrpg.of "*" — is its own card, and its chip opens the table there)
    const own = r.ttrpg ? r : null;
    const name = r.areaList?.length ? r.roomName ?? r.name : r.name;
    const areas = (r.areaList ?? []).map((a) => ({ key: a.key, id: a.id, label: a.label, name: a.name, ...(a.icon ? { icon: a.icon } : {}) }));
    entries.push({ info: r, world, title: own ? tableName(shortName(name, world)) : shortName(name, world), test: world.id === 'test', table: tableFor.get(r.id) ?? own, badges: roomBadges(r), areas });
  }
  const order = (w: WorldDef) => { const i = WORLDS.findIndex((x) => x.id === w.id); return i < 0 ? WORLDS.length - 2.5 : i; };   // named custom worlds sit before "More rooms"
  entries.sort((a, b) => order(a.world) - order(b.world) || a.world.label.localeCompare(b.world.label) || a.title.localeCompare(b.title));
  const worlds: WorldDef[] = [];
  for (const e of entries) if (!worlds.some((w) => w.id === e.world.id)) worlds.push(e.world);
  return { entries, byId: new Map(entries.map((e) => [e.info.id, e])), tableOf, areaOf, worlds };
}

/** Search: every word must appear in the name, id, world or a badge. */
export function matches(e: RoomEntry, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${e.info.name} ${e.info.id.replace(/_/g, ' ')} ${e.world.label} ${(e.world.aliases ?? []).join(' ')} ${e.badges.map((b) => b.label).join(' ')} ${e.table ? `table ttrpg tabletop ${e.table.name}` : ''} ${e.areas.map((a) => `${a.label} ${a.name}`).join(' ')}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}
