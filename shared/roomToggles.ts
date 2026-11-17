// Room prop toggles (docs/SCENES.md → "Room prop toggles"): content-defined node groups the host switches on and off
// live — a decor set that must disappear on some platforms (paraphernalia rules), a seasonal corner, a sponsor shelf.
//
//  - Declared by the room: scene.json `toggles` [{ id, label, nodes: [<node name>…], default }] and / or glTF node
//    extras `toggleGroup: "<id>"` (+ optional `toggleLabel` / `label`, `toggleDefault: false`) so a group can live in
//    the glb alone. Both merge by id (scene.json wins for label / default; the nodes are the union).
//  - HOST-owned, part of SceneState (`state.toggles` = { <id>: on }, missing id = the toggle's default), so the studio
//    preview, every OBS page and every party guest show the same set. Remembered per room (the host's browser).
//  - Rooms without toggles: nothing changes (no key, no work).

export interface RoomToggleDef {
  /** Stable id (scene.json / Stream Deck / bus): 1–32 of A-Z a-z 0-9 _ -. */
  id: string;
  /** Shown in the Scene tab ('' = the id). */
  label: string;
  /** glTF node names whose subtrees the toggle shows / hides (scene.json; glb-extras groups add their own nodes). */
  nodes: string[];
  /** On (shown) until the host says otherwise. Default true. */
  default: boolean;
}

/** The host's choices for the current room: toggle id → shown. */
export type SceneToggles = Record<string, boolean>;

export const MAX_TOGGLES = 16;
const MAX_NODES = 32;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const NODE = /^[^\u0000-\u001f]{1,120}$/;
export const isToggleId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const cleanLabel = (v: unknown) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 48) : '');

/** One glTF node that declares a group in its extras (userData after GLTFLoader). */
export interface ToggleNodeExtras { node: string; extras: Record<string, unknown> }

/** scene.json `toggles` (+ glb extras `toggleGroup` nodes) → the room's toggle list (≤ 16, sanitised, merged by id). */
export function parseRoomToggles(json: unknown, glb: ToggleNodeExtras[] = []): RoomToggleDef[] {
  const out: RoomToggleDef[] = [];
  const byId = new Map<string, RoomToggleDef>();
  const addNode = (d: RoomToggleDef, n: unknown) => { if (typeof n === 'string' && NODE.test(n) && !d.nodes.includes(n) && d.nodes.length < MAX_NODES) d.nodes.push(n); };
  for (const raw of Array.isArray(json) ? json : []) {
    if (!raw || typeof raw !== 'object') continue;
    const x = raw as Record<string, unknown>;
    if (!isToggleId(x.id) || byId.has(x.id) || out.length >= MAX_TOGGLES) continue;
    const d: RoomToggleDef = { id: x.id, label: cleanLabel(x.label), nodes: [], default: x.default !== false };
    for (const n of Array.isArray(x.nodes) ? x.nodes : typeof x.nodes === 'string' ? [x.nodes] : []) addNode(d, n);
    out.push(d); byId.set(d.id, d);
  }
  for (const { node, extras } of glb) {
    const id = extras.toggleGroup;
    if (!isToggleId(id)) continue;
    let d = byId.get(id);
    if (!d) {
      if (out.length >= MAX_TOGGLES) continue;
      d = { id, label: cleanLabel(extras.toggleLabel ?? extras.label), nodes: [], default: extras.toggleDefault !== false };
      out.push(d); byId.set(id, d);
    } else if (!d.label) d.label = cleanLabel(extras.toggleLabel ?? extras.label);
    addNode(d, node);
  }
  return out;
}

/** SceneState.toggles from the network / disk: valid ids, booleans, ≤ 32 entries (undefined = not an object). An empty
 *  object is kept: after a room change it says "this room: every toggle at its default" (the server merges a saved
 *  state with the new one, so a missing key would keep the previous room's choices on disk). */
export function sanitizeToggles(o: unknown): SceneToggles | undefined {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const out: SceneToggles = {};
  let n = 0;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (n >= 32) break;
    if (isToggleId(k) && typeof v === 'boolean') { out[k] = v; n++; }
  }
  return out;
}

/** Is toggle `id` shown? The host's choice, else the room's default (unknown toggles: shown). */
export function toggleOn(defs: readonly RoomToggleDef[], state: SceneToggles | undefined, id: string): boolean {
  const v = state?.[id];
  if (typeof v === 'boolean') return v;
  return defs.find((d) => d.id === id)?.default ?? true;
}

/** Ids of the room's toggles that are hidden right now. */
export function hiddenToggles(defs: readonly RoomToggleDef[], state: SceneToggles | undefined): string[] {
  return defs.filter((d) => !toggleOn(defs, state, d.id)).map((d) => d.id);
}

/** A choice (true / false / 'toggle') → the new on value. */
export function resolveToggle(defs: readonly RoomToggleDef[], state: SceneToggles | undefined, id: string, on: boolean | 'toggle'): boolean {
  return on === 'toggle' ? !toggleOn(defs, state, id) : on;
}

/** The host sets toggle `id`: the next SceneState.toggles (a new object; other ids kept). */
export function stampToggle(defs: readonly RoomToggleDef[], cur: SceneToggles | undefined, id: string, on: boolean | 'toggle'): SceneToggles {
  return sanitizeToggles({ ...(cur ?? {}), [id]: resolveToggle(defs, cur, id, on) }) ?? {};
}

/** A room change: the toggles the new room starts with — its remembered choices, else {} ("all at their defaults") once
 *  any room used toggles; undefined (no key at all) when neither the old state nor the memory has any. */
export function togglesForRoom(prev: SceneToggles | undefined, remembered: SceneToggles | undefined): SceneToggles | undefined {
  return remembered ?? (prev ? {} : undefined);
}

/** Per-room memory (the host's browser, by base room id): read one room's choices. */
export function rememberedToggles(memory: unknown, room: string | null): SceneToggles | undefined {
  if (!room || !memory || typeof memory !== 'object') return undefined;
  const t = sanitizeToggles((memory as Record<string, unknown>)[room]);
  return t && Object.keys(t).length ? t : undefined;
}

/** Per-room memory: store (or forget, when undefined) one room's choices. At most 64 rooms are kept (the newest). */
export function rememberToggles(memory: unknown, room: string, t: SceneToggles | undefined): Record<string, SceneToggles> {
  const out: Record<string, SceneToggles> = {};
  if (memory && typeof memory === 'object') for (const [k, v] of Object.entries(memory as Record<string, unknown>)) { const s = sanitizeToggles(v); if (s && Object.keys(s).length && k !== room) out[k] = s; }
  if (t && Object.keys(t).length) out[room] = t;
  const keys = Object.keys(out);
  for (const k of keys.slice(0, Math.max(0, keys.length - 64))) delete out[k];
  return out;
}
