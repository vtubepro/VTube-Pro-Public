// Placeable prop packs (docs/ROOM_EDITOR.md → "Prop packs"): the format a free asset pack uses so the Room editor can
// list its props and the performer can place them round a room. Pure TypeScript (helper + pages + tests).
//
// A pack is a folder <data>/props/<pack id>/ holding `props.json` (this manifest), one self-contained .glb per prop and
// optional thumbnails. It is copied in by hand (or by a tool). The CC0
// kits in assets/library/props (docs/ASSET_LIBRARY.md, index.json per kit) are listed the same way as `lib:<kit>/<item>`.
//
//   {
//     "schema": "vtp-props/1", "id": "harbour_bits", "name": "Harbour bits", "version": "2026.10.06-1",
//     "author": "…", "license": "CC0-1.0", "source": "https://…",
//     "items": [
//       { "id": "crate_small", "name": "Small crate", "file": "crate_small.glb", "thumb": "thumbs/crate_small.png",
//         "category": "crates", "tris": 412, "meshes": 1, "size": [0.6, 0.6, 0.6], "place": "floor", "scale": 1 }
//     ]
//   }
//
// Rules: metres, +Y up, the prop's origin at the bottom centre (where it touches the floor / wall), front +Z; ≤ 20,000
// triangles and ≤ 8 meshes per prop (they are instanced: every copy costs its triangles, not its draw calls); textures
// ≤ 1024²; licences that allow redistribution only (CC0-1.0, CC-BY-4.0 with the credit in `author`, or "own"); never NC
// / ND, never game rips.
import type { V3 } from './roomEdits.ts';

export const PROP_PACK_SCHEMA = 'vtp-props/1';
export const PROP_PACK_FILE = 'props.json';
export const PROP_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const PROP_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
export const PROP_VERSION = /^\d{4}\.\d{2}\.\d{2}-\d{1,3}$/;
/** A file in a pack: up to 2 folders deep, plain names. Packs carry .glb props and .png / .jpg / .webp thumbnails. */
export const PROP_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}){0,2}$/;
export const PROP_PLACES = ['floor', 'surface', 'wall', 'ceiling', 'free'] as const;
export type PropPlace = typeof PROP_PLACES[number];
export const PROP_LICENCES = ['CC0-1.0', 'CC-BY-4.0', 'own'] as const;
export const PROP_ITEM_LIMITS = { tris: 20_000, meshes: 8, items: 500, sizeM: 30 };

export interface PropPackItem {
  id: string; name?: string; file: string; thumb?: string; category?: string;
  tris: number; meshes?: number; size: V3; place?: PropPlace; scale?: number; tags?: string[];
}
export interface PropPackManifest {
  schema: typeof PROP_PACK_SCHEMA; id: string; name: string; version: string;
  author?: string; license: typeof PROP_LICENCES[number]; source?: string; minApp?: string;
  items: PropPackItem[];
}

/** One placeable prop as the Room editor lists it (GET /api/props). */
export interface PropItem {
  src: string;                 // lib:<kit>/<id> | pack:<pack>/<id>
  name: string;
  kit: string; kitName: string;
  category: string;
  file: string;                // URL of the model
  thumb: string | null;        // URL of the thumbnail
  tris: number; meshes: number;
  size: V3;
  place: PropPlace;
  scale: number;
  license: string;
  author?: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const safeFile = (p: unknown, ext: RegExp): p is string => typeof p === 'string' && PROP_FILE.test(p) && ext.test(p)
  && p.split('/').every((s) => !/^\.+$/.test(s) && !/\.$/.test(s) && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s));

/** Errors in a prop pack manifest ([] = valid). `files` = the files that are really in the folder / pack (checked when given). */
export function validatePropPack(m: unknown, files?: Set<string>): string[] {
  const e: string[] = [];
  const j = m as Partial<PropPackManifest> | null;
  if (!j || typeof j !== 'object' || Array.isArray(j)) return ['props.json is not an object'];
  if (j.schema !== PROP_PACK_SCHEMA) e.push(`schema must be ${PROP_PACK_SCHEMA}`);
  if (typeof j.id !== 'string' || !PROP_ID.test(j.id)) e.push('bad id (a-z, 0-9, _ and -, up to 48)');
  if (typeof j.name !== 'string' || !j.name.trim() || j.name.length > 80) e.push('bad name');
  if (typeof j.version !== 'string' || !PROP_VERSION.test(j.version)) e.push('bad version (YYYY.MM.DD-n)');
  if (!PROP_LICENCES.includes(j.license as typeof PROP_LICENCES[number])) e.push(`license must be one of ${PROP_LICENCES.join(', ')} (no NC / ND)`);
  if (j.license === 'CC-BY-4.0' && !(typeof j.author === 'string' && j.author.trim())) e.push('CC-BY-4.0 needs the credit in "author"');
  if (j.author !== undefined && (typeof j.author !== 'string' || j.author.length > 120)) e.push('bad author');
  if (j.source !== undefined && (typeof j.source !== 'string' || !/^https:\/\/\S{3,300}$/.test(j.source))) e.push('source must be an https URL');
  if (!Array.isArray(j.items) || !j.items.length || j.items.length > PROP_ITEM_LIMITS.items) { e.push(`items must list 1 to ${PROP_ITEM_LIMITS.items} props`); return e; }
  const seen = new Set<string>();
  for (const [i, it] of j.items.entries()) {
    const w = `items[${i}]`;
    if (!it || typeof it !== 'object') { e.push(`${w}: not an object`); continue; }
    if (typeof it.id !== 'string' || !PROP_ITEM_ID.test(it.id)) { e.push(`${w}: bad id`); continue; }
    if (seen.has(it.id)) e.push(`${w}: duplicate id ${it.id}`);
    seen.add(it.id);
    if (!safeFile(it.file, /\.glb$/i)) e.push(`${it.id}: file must be a .glb in the pack`);
    else if (files && !files.has(it.file)) e.push(`${it.id}: ${it.file} is missing`);
    if (it.thumb !== undefined && !safeFile(it.thumb, /\.(png|jpe?g|webp)$/i)) e.push(`${it.id}: thumb must be a .png / .jpg / .webp in the pack`);
    else if (it.thumb !== undefined && files && !files.has(it.thumb)) e.push(`${it.id}: ${it.thumb} is missing`);
    if (!isNum(it.tris) || it.tris < 1 || it.tris > PROP_ITEM_LIMITS.tris) e.push(`${it.id}: tris must be 1-${PROP_ITEM_LIMITS.tris}`);
    if (it.meshes !== undefined && (!Number.isInteger(it.meshes) || it.meshes < 1 || it.meshes > PROP_ITEM_LIMITS.meshes)) e.push(`${it.id}: meshes must be 1-${PROP_ITEM_LIMITS.meshes}`);
    if (!Array.isArray(it.size) || it.size.length !== 3 || !it.size.every((v) => isNum(v) && v > 0 && v <= PROP_ITEM_LIMITS.sizeM)) e.push(`${it.id}: size must be [x, y, z] metres (0-${PROP_ITEM_LIMITS.sizeM})`);
    if (it.place !== undefined && !PROP_PLACES.includes(it.place)) e.push(`${it.id}: place must be one of ${PROP_PLACES.join(', ')}`);
    if (it.scale !== undefined && (!isNum(it.scale) || it.scale < 0.05 || it.scale > 20)) e.push(`${it.id}: scale must be 0.05-20`);
    if (it.name !== undefined && (typeof it.name !== 'string' || it.name.length > 80)) e.push(`${it.id}: bad name`);
    if (it.category !== undefined && (typeof it.category !== 'string' || !/^[a-z0-9 _-]{1,32}$/i.test(it.category))) e.push(`${it.id}: bad category`);
  }
  return e;
}

const nice = (id: string) => id.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

/** A valid pack's items as the editor lists them. `url(rel)` = the URL a page loads a pack file from. */
export function packItems(m: PropPackManifest, url: (rel: string) => string): PropItem[] {
  return m.items.map((it) => ({
    src: `pack:${m.id}/${it.id}`, name: it.name || nice(it.id), kit: m.id, kitName: m.name, category: it.category || 'misc',
    file: url(it.file), thumb: it.thumb ? url(it.thumb) : null, tris: Math.round(it.tris), meshes: it.meshes ?? 1,
    size: it.size, place: it.place ?? 'floor', scale: it.scale ?? 1, license: m.license, ...(m.author ? { author: m.author } : {}),
  }));
}

/** An assets/library/props/<kit>/index.json (docs/ASSET_LIBRARY.md) as editor items (glTF + .bin, CC0). Items over the
 *  per-prop triangle limit or without a size are left out. */
export function libraryItems(index: unknown, url: (rel: string) => string): PropItem[] {
  const j = (index && typeof index === 'object' ? index : {}) as { kit?: unknown; name?: unknown; license?: unknown; author?: unknown; items?: unknown };
  if (typeof j.kit !== 'string' || !PROP_ID.test(j.kit) || !Array.isArray(j.items)) return [];
  const kit = j.kit, kitName = typeof j.name === 'string' ? j.name.slice(0, 80) : kit;
  const license = typeof j.license === 'string' ? j.license.slice(0, 40) : 'CC0 1.0';
  if (/\bNC\b|non-?commercial|\bND\b/i.test(license)) return [];
  const out: PropItem[] = [];
  for (const it of j.items as Record<string, unknown>[]) {
    if (!it || typeof it.id !== 'string' || !PROP_ITEM_ID.test(it.id) || !safeFile(it.file, /\.(gltf|glb)$/i)) continue;
    const size = Array.isArray(it.size) && it.size.length === 3 && it.size.every((v) => isNum(v) && v > 0) ? it.size as V3 : null;
    const tris = isNum(it.tris) ? Math.round(it.tris) : 0;
    if (!size || tris < 1 || tris > PROP_ITEM_LIMITS.tris || size.some((v) => v > PROP_ITEM_LIMITS.sizeM)) continue;
    out.push({
      src: `lib:${kit}/${it.id}`, name: nice(it.id), kit, kitName, category: typeof it.category === 'string' ? it.category.slice(0, 32) : 'misc',
      file: url(it.file as string), thumb: safeFile(it.thumb, /\.(png|jpe?g|webp)$/i) ? url(it.thumb as string) : null,
      tris, meshes: 1, size, place: 'floor', scale: 1, license, ...(typeof j.author === 'string' ? { author: j.author.slice(0, 120) } : {}),
    });
  }
  return out;
}
