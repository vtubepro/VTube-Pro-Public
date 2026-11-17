// Room areas (shared/roomId.ts, docs/SCENES.md → "Areas: several locations in one room"): before a room GLB is parsed,
// its nodes are narrowed to the area being loaded, so contract.ts and every engine that reads node names (chat anchors,
// raid / space / crowd / town / traffic / kitchen / yacht anchors, TTRPG tables …) see ONE ordinary room:
//   - `<AREA>__NAME` of the loaded area → renamed `NAME` (an unprefixed node already called `NAME` is parked as `~NAME`:
//     the area's own anchor wins);
//   - `<OTHER>__…` nodes of any other area → removed with their children (never drawn, ray-tested or uploaded);
//   - nodes with extras `areas` ("foyer,bar" or ["foyer", "bar"]) → kept only in those areas (shared geometry that more
//     than one area sees, without duplicating it);
//   - everything else is shared (the hull, the sky, the planet …).
// Room animation clips are rewritten the same way (tracks of removed nodes dropped, renamed nodes re-targeted).
import * as THREE from 'three';
import type { SceneInfo } from '../../shared/types.ts';
import { roomAreas } from '../../shared/roomId.ts';
import type { RoomInfo } from './contract.ts';

export interface AreaApplied { area: string; renamed: number; removed: number; parked: number; clips: number }

/** The area a SceneInfo stands for (its `area`, else the room's default area), or null for rooms without areas. */
export function activeArea(info: SceneInfo): string | null {
  const { keys, def } = roomAreas(info);
  if (!keys.length) return null;
  return info.area && keys.includes(info.area) ? info.area : def;
}

const listOf = (v: unknown): string[] | null => {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase());
  if (typeof v === 'string' && v.trim()) return v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return null;
};

/** Narrow a freshly loaded room GLB to one area (in place). No-op for rooms without areas. */
export function applyArea(root: THREE.Object3D, clips: THREE.AnimationClip[], info: SceneInfo): AreaApplied | null {
  const area = activeArea(info);
  if (!area) return null;
  const { keys } = roomAreas(info);
  const mine = `${area.toUpperCase()}__`;
  const others = keys.filter((k) => k !== area).map((k) => `${k.toUpperCase()}__`);
  const nodes: THREE.Object3D[] = [];
  root.traverse((o) => nodes.push(o));
  const byName = new Map<string, THREE.Object3D>();
  for (const o of nodes) if (o.name && !byName.has(o.name)) byName.set(o.name, o);
  const rename = new Map<string, string>();            // old → new (for the clips)
  const drop = new Set<string>();                      // names whose nodes were removed
  const removeSet = new Set<THREE.Object3D>();
  const res: AreaApplied = { area, renamed: 0, removed: 0, parked: 0, clips: 0 };
  for (const o of nodes) {
    const n = o.name ?? '';
    const x = (o.userData ?? {}) as Record<string, unknown>;
    const only = listOf(x.areas);
    if (others.some((p) => n.startsWith(p)) || (only && !only.includes(area))) { removeSet.add(o); continue; }
    if (n.startsWith(mine) && n.length > mine.length) {
      const plain = n.slice(mine.length);
      const clash = byName.get(plain);
      if (clash && clash !== o && !clash.name.startsWith('~')) { rename.set(clash.name, `~${plain}`); clash.name = `~${plain}`; res.parked++; }
      rename.set(n, plain);
      o.name = plain; res.renamed++;
    }
  }
  // remove the outermost removed nodes (their subtrees go with them)
  for (const o of removeSet) {
    let anc = o.parent, nested = false;
    for (; anc; anc = anc.parent) if (removeSet.has(anc)) { nested = true; break; }
    o.traverse((c) => { if (c.name) drop.add(c.name); });
    if (!nested) { o.parent?.remove(o); res.removed++; }
  }
  // clips: retarget / drop tracks (track name = "<sanitized node name>.<property>")
  const san = (s: string) => THREE.PropertyBinding.sanitizeNodeName(s);
  const renameS = new Map([...rename].map(([a, b]) => [san(a), san(b)]));
  const dropS = new Set([...drop].map(san));
  for (let i = clips.length - 1; i >= 0; i--) {
    const c = clips[i];
    c.tracks = c.tracks.filter((t) => {
      const dot = t.name.indexOf('.');
      const node = dot < 0 ? t.name : t.name.slice(0, dot);
      if (dropS.has(node) && !renameS.has(node)) return false;
      const to = renameS.get(node);
      if (to) { t.name = to + t.name.slice(node.length); res.clips++; }
      return true;
    });
    if (!c.tracks.length) clips.splice(i, 1);
  }
  return res;
}

/** scene.json (or area) `bounds` [minx, miny, minz, maxx, maxy, maxz] → the room's framing box. */
export function applyAreaBounds(room: RoomInfo, info: SceneInfo): boolean {
  const b = info.bounds;
  if (!Array.isArray(b) || b.length !== 6 || !b.every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
  const box = new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5]));
  if (box.isEmpty()) return false;
  room.bounds.copy(box);
  return true;
}
