// Creator Console (owner tool, local only): "tie a room in". What a room's GLB offers (spots, cameras, light groups,
// screen, door / path, chat anchors, areas) and the scene.json keys that wire them into VTube Pro, as one editable
// object (TieIn). Pure TS: the console page, the helper routes, the CLI and the unit tests share it.
//
// The edit rule that keeps the owner's hand-written scene.json safe: applyTieIn() only touches the keys whose TieIn
// field CHANGED compared to what deriveTieIn() read from the same file, and inside an object key only the entries it
// owns. Every other key (raid, gfx, spotOverrides, unknown future keys) is copied through untouched, in its original
// order. So deriveTieIn → applyTieIn with no edits returns a byte-identical file (unit-tested).
// Contract words: docs/ARTIST_ENVIRONMENTS.md §2, docs/SCENES.md.
import { areaPrefix, stripArea, type GltfJson } from './roomGlb.ts';

type J = Record<string, unknown>;
export type V3 = [number, number, number];

// ---------------------------------------------------------------- what the GLB offers
export interface InvSpot { name: string; area: string; pose: 'sit' | 'stand' | null; label: string | null; hasCam: boolean }
export interface InvLightGroup { group: string; fixtures: string[]; emitMaterials: string[]; color: string | null; kinds: string[] }
export interface RoomInventory {
  spots: InvSpot[];
  /** Every camera node (area-prefixed names kept), CAM_* presets and SPOT_xx_CAM talk cameras. */
  cams: string[];
  areas: string[];                 // area keys (lower case) found from node prefixes
  screens: string[];               // SCREEN nodes (per area)
  soloScreens: string[];
  door: string[]; doorOutside: string[]; paths: string[];
  lightGroups: InvLightGroup[];
  chat: { monitors: string[]; boards: string[]; buddies: string[] };
  nodeCount: number;
}

const SPOT_RE = /^SPOT_(\d{1,2})$/;
const groupOfMaterial = (name: string) => /^EMIT_([^.]+)/.exec(name)?.[1] ?? null;

export function inventoryOf(json: GltfJson): RoomInventory {
  const nodes = json.nodes ?? [];
  const names = nodes.map((n) => n.name ?? '');
  const camNames = nodes.filter((n) => n.camera !== undefined).map((n) => n.name ?? '').filter(Boolean);
  const camSet = new Set(camNames.map(stripArea));
  const spots: InvSpot[] = [];
  const areas = new Set<string>();
  const groups = new Map<string, InvLightGroup>();
  const grp = (g: string) => { let x = groups.get(g); if (!x) groups.set(g, (x = { group: g, fixtures: [], emitMaterials: [], color: null, kinds: [] })); return x; };
  const inv: RoomInventory = { spots, cams: camNames, areas: [], screens: [], soloScreens: [], door: [], doorOutside: [], paths: [], lightGroups: [], chat: { monitors: [], boards: [], buddies: [] }, nodeCount: nodes.length };
  nodes.forEach((n, i) => {
    const full = names[i];
    if (!full) return;
    const base = stripArea(full), pre = areaPrefix(full);
    if (pre && /^(SPOT_|CAM_|SCREEN|DOOR|PATH_)/.test(base)) areas.add(pre.toLowerCase());
    const ex = (n.extras ?? {}) as J;
    const m = SPOT_RE.exec(base);
    if (m && n.camera === undefined) {
      const pose = ex.pose === 'sit' || ex.pose === 'stand' ? ex.pose : null;
      spots.push({ name: full, area: pre.toLowerCase(), pose, label: typeof ex.label === 'string' ? ex.label.slice(0, 60) : null, hasCam: camSet.has(`${base}_CAM`) });
    } else if (base === 'SCREEN') inv.screens.push(full);
    else if (/^SCREEN_SOLO(_\d{1,2})?$/.test(base)) inv.soloScreens.push(full);
    else if (base === 'DOOR') inv.door.push(full);
    else if (base === 'DOOR_OUTSIDE') inv.doorOutside.push(full);
    else if (/^PATH_\d+$/.test(base)) inv.paths.push(full);
    else if (/^CHAT_MONITOR(_\d{1,2})?$/.test(base)) inv.chat.monitors.push(full);
    else if (/^CHAT_BOARD(_\d{1,2})?$/.test(base)) inv.chat.boards.push(full);
    else if (/^(BUDDY_SPOT|CHAT_BUDDY)(_\d{1,2})?$/.test(base)) inv.chat.buddies.push(full);
    else if (/^LIGHT_/.test(base)) {
      // (GLTFLoader splits a multi-material mesh into LIGHT_x_1 children: count only the top LIGHT_ node)
      const parentIsLight = nodes.some((p) => (p.children ?? []).includes(i) && /^LIGHT_/.test(stripArea(p.name ?? '')));
      if (parentIsLight) return;
      const g = grp(typeof ex.group === 'string' && ex.group ? ex.group.slice(0, 32) : 'default');
      g.fixtures.push(full);
      if (typeof ex.color === 'string' && !g.color) g.color = ex.color.slice(0, 16);
      const k = ex.kind === 'spot' || ex.kind === 'point' ? ex.kind : 'emissive';
      if (!g.kinds.includes(k)) g.kinds.push(k);
    }
  });
  for (const mat of json.materials ?? []) {
    const g = groupOfMaterial(mat.name ?? '');
    if (g) { const x = grp(g); if (!x.emitMaterials.includes(mat.name!)) x.emitMaterials.push(mat.name!); }
  }
  spots.sort((a, b) => a.area.localeCompare(b.area) || a.name.localeCompare(b.name));
  inv.areas = [...areas].sort();
  inv.lightGroups = [...groups.values()].sort((a, b) => a.group.localeCompare(b.group));
  inv.paths.sort();
  return inv;
}

// ---------------------------------------------------------------- the editable tie-in
export interface Anchor { position: V3; yaw: number; width: number }
export interface TieIn {
  name: string;
  /** scene.json areas: key → display name + chip label (other per-area keys are kept as they are). */
  areas: Record<string, { name: string; label: string }>;
  defaultArea: string | null;
  hostSpot: string | null;
  defaultCamera: string | null;
  reactCamera: string | null;
  /** Authored cameras switched off (scene.json cameraOverrides[name] = null). */
  camsOff: string[];
  /** React mode offered (scene.json modes has 'react'). */
  react: boolean;
  /** Screen skin theme; 'custom' = an object config the console leaves alone; null = the room's default. */
  screenSkin: string | null;
  /** Light groups switched off (scene.json lightGroupsOff: their LIGHT_ fixtures and EMIT_ materials stay dark). */
  lightGroupsOff: string[];
  /** Day / night + weather opt-in (scene.json environment present). */
  dayNight: boolean;
  /** Groups that switch on at night (scene.json environment.nightLights keys). */
  nightGroups: string[];
  /** Entrance cinematic: null = the door walk (default), else 'cryo' | 'droppod'. */
  entrance: string | null;
  chatMonitors: Record<string, Anchor>;
  chatBoards: Record<string, Anchor>;
  /** Default look: ambience.exposure (null = 1), background (undefined = not set, null = transparent), lights.programs. */
  exposure: number | null;
  background: string | null | undefined;
  programs: string[];
  avatarHeight: number | null;
}
export const TIE_FIELDS: readonly (keyof TieIn)[] = ['name', 'areas', 'defaultArea', 'hostSpot', 'defaultCamera', 'reactCamera', 'camsOff', 'react',
  'screenSkin', 'lightGroupsOff', 'dayNight', 'nightGroups', 'entrance', 'chatMonitors', 'chatBoards', 'exposure', 'background', 'programs', 'avatarHeight'];

const obj = (v: unknown): J | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const nice = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function anchors(v: unknown): Record<string, Anchor> {
  const o = obj(v); const out: Record<string, Anchor> = {};
  if (!o) return out;
  for (const [k, raw] of Object.entries(o)) {
    const a = obj(raw); const p = a?.position;
    if (!a || !Array.isArray(p) || p.length !== 3 || !p.every((x) => typeof x === 'number' && Number.isFinite(x))) continue;
    out[k] = { position: [p[0], p[1], p[2]], yaw: num(a.yaw) ?? 0, width: num(a.width) ?? 0 };
  }
  return out;
}

/** Read the tie-in from a scene.json (the inventory only fills names nobody wrote yet, e.g. new areas). */
export function deriveTieIn(sj: J | null | undefined, inv?: RoomInventory | null): TieIn {
  const j = sj ?? {};
  const areasJ = obj(j.areas);
  const areas: TieIn['areas'] = {};
  if (areasJ) for (const [k, v] of Object.entries(areasJ)) { const a = obj(v) ?? {}; areas[k] = { name: str(a.name) ?? '', label: str(a.label) ?? '' }; }
  const co = obj(j.cameraOverrides);
  const env = obj(j.environment);
  const amb = obj(j.ambience);
  const lights = obj(j.lights);
  const skin = j.screenSkin;
  void inv;
  return {
    name: str(j.name) ?? '',
    areas,
    defaultArea: str(j.defaultArea),
    hostSpot: str(j.hostSpot),
    defaultCamera: str(j.defaultCamera),
    reactCamera: str(j.reactCamera),
    camsOff: co ? Object.keys(co).filter((k) => co[k] === null).sort() : [],
    react: Array.isArray(j.modes) ? (j.modes as unknown[]).includes('react') : false,
    screenSkin: typeof skin === 'string' ? skin : skin && typeof skin === 'object' ? 'custom' : null,
    lightGroupsOff: strs(j.lightGroupsOff).slice().sort(),
    dayNight: !!env,
    nightGroups: env && obj(env.nightLights) ? Object.keys(obj(env.nightLights)!).sort() : [],
    entrance: str(j.entrance),
    chatMonitors: anchors(j.chatMonitors),
    chatBoards: anchors(j.chatBoards),
    exposure: amb ? num(amb.exposure) : null,
    background: amb && 'background' in amb ? (typeof amb.background === 'string' ? amb.background : null) : undefined,
    programs: lights ? strs(lights.programs) : [],
    avatarHeight: num(j.avatarHeight),
  };
}

/** Suggestions for an untouched room (used by the console's "Fill from the GLB" button; never applied silently). */
export function suggestTieIn(t: TieIn, inv: RoomInventory): TieIn {
  const out: TieIn = JSON.parse(JSON.stringify(t));
  for (const a of inv.areas) if (!out.areas[a]) out.areas[a] = { name: `${t.name || 'Room'} – ${nice(a)}`, label: nice(a) };
  if (inv.areas.length && !out.defaultArea) out.defaultArea = inv.areas[0];
  const base = (n: string) => stripArea(n);
  if (!out.defaultCamera && inv.cams.some((c) => base(c) === 'CAM_WIDE')) out.defaultCamera = 'CAM_WIDE';
  if (!out.reactCamera && inv.cams.some((c) => base(c) === 'CAM_REACT')) out.reactCamera = 'CAM_REACT';
  if (!out.hostSpot && inv.spots.length) out.hostSpot = base(inv.spots[0].name);
  if (inv.screens.length && !out.react) out.react = true;
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const setOrDel = (o: J, k: string, v: unknown) => { if (v === null || v === undefined) delete o[k]; else o[k] = v; };
/** Put `k` at key position `at` (the other keys keep their order). */
function insertAt(o: J, k: string, v: unknown, at: number) {
  const entries = Object.entries(o).filter(([x]) => x !== k);
  entries.splice(Math.max(0, Math.min(at, entries.length)), 0, [k, v]);
  for (const x of Object.keys(o)) delete o[x];
  for (const [x, y] of entries) o[x] = y;
}
const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/** Write the CHANGED tie-in fields into a copy of `sj`. `before` must be deriveTieIn(sj). Keys keep their order. */
export function applyTieIn(sj: J | null | undefined, before: TieIn, after: TieIn): J {
  const out: J = JSON.parse(JSON.stringify(sj ?? {}));
  const changed = (f: keyof TieIn) => !same(before[f], after[f]);
  if (changed('name')) out.name = after.name.slice(0, 80);
  if (changed('areas')) {
    const prev = obj(out.areas) ?? {};
    const next: J = {};
    for (const [k, v] of Object.entries(after.areas)) {
      const keep = obj(prev[k]) ?? {};
      const e: J = { ...keep };
      if (v.name) e.name = v.name.slice(0, 80); else delete e.name;
      if (v.label) e.label = v.label.slice(0, 40); else delete e.label;
      next[k] = e;
    }
    setOrDel(out, 'areas', Object.keys(next).length ? next : null);
  }
  for (const f of ['defaultArea', 'hostSpot', 'defaultCamera', 'reactCamera', 'entrance'] as const) if (changed(f)) setOrDel(out, f, after[f]);
  if (changed('camsOff')) {
    const co: J = { ...(obj(out.cameraOverrides) ?? {}) };
    for (const c of before.camsOff) if (!after.camsOff.includes(c) && co[c] === null) delete co[c];
    for (const c of after.camsOff) co[c] = null;
    setOrDel(out, 'cameraOverrides', Object.keys(co).length ? co : null);
  }
  if (changed('react')) {
    const modes = Array.isArray(out.modes) ? (out.modes as unknown[]).filter((m) => m !== 'react') : ['talk'];
    if (after.react) modes.push('react');
    out.modes = modes;
  }
  if (changed('screenSkin') && after.screenSkin !== 'custom') setOrDel(out, 'screenSkin', after.screenSkin);
  if (changed('lightGroupsOff')) setOrDel(out, 'lightGroupsOff', after.lightGroupsOff.length ? [...after.lightGroupsOff] : null);
  if (changed('dayNight')) {
    const stash = obj(out._creator) ?? {};
    if (after.dayNight) {
      // turning it back on brings back the environment the owner had before it was turned off, where it was
      const at = typeof stash.environmentAt === 'number' ? stash.environmentAt : Object.keys(out).length;
      const env = obj(stash.environmentOff) ?? {};
      delete stash.environmentOff; delete stash.environmentAt;
      setOrDel(out, '_creator', Object.keys(stash).length ? stash : null);
      insertAt(out, 'environment', env, at);
    } else if (out.environment !== undefined) {
      stash.environmentAt = Object.keys(out).indexOf('environment');
      stash.environmentOff = out.environment;
      delete out.environment;
      setOrDel(out, '_creator', Object.keys(stash).length ? stash : null);
    }
  }
  if (changed('nightGroups') && after.dayNight) {
    const env: J = { ...(obj(out.environment) ?? {}) };
    const nl: J = { ...(obj(env.nightLights) ?? {}) };
    for (const g of before.nightGroups) if (!after.nightGroups.includes(g)) delete nl[g];
    for (const g of after.nightGroups) if (!(g in nl)) nl[g] = {};
    setOrDel(env, 'nightLights', Object.keys(nl).length ? nl : null);
    out.environment = env;
  }
  for (const f of ['chatMonitors', 'chatBoards'] as const) if (changed(f)) {
    const prev = obj(out[f]) ?? {};
    const next: J = {};
    for (const [k, a] of Object.entries(after[f])) next[k] = { ...(obj(prev[k]) ?? {}), position: a.position.map((v) => round(v)), yaw: round(a.yaw, 1), ...(a.width > 0 ? { width: round(a.width, 2) } : {}) };
    setOrDel(out, f, Object.keys(next).length ? next : null);
  }
  if (changed('exposure') || changed('background')) {
    const amb: J = { ...(obj(out.ambience) ?? {}) };
    if (changed('exposure')) setOrDel(amb, 'exposure', after.exposure === null ? null : Math.min(3, Math.max(0.1, round(after.exposure, 2))));
    if (changed('background')) { if (after.background === undefined) delete amb.background; else amb.background = after.background; }
    setOrDel(out, 'ambience', Object.keys(amb).length ? amb : null);
  }
  if (changed('programs')) {
    const l: J = { ...(obj(out.lights) ?? {}) };
    setOrDel(l, 'programs', after.programs.length ? [...after.programs] : null);
    setOrDel(out, 'lights', Object.keys(l).length ? l : null);
  }
  if (changed('avatarHeight')) setOrDel(out, 'avatarHeight', after.avatarHeight === null ? null : Math.min(2.5, Math.max(0.5, round(after.avatarHeight, 2))));
  return out;
}

/** Problems with a tie-in against what the GLB has (plain sentences; empty = fine). */
export function tieInWarnings(t: TieIn, inv: RoomInventory): string[] {
  const out: string[] = [];
  const base = new Set([...inv.cams.map(stripArea)]);
  if (t.defaultCamera && !base.has(t.defaultCamera)) out.push(`Default camera ${t.defaultCamera} isn't in the room file.`);
  if (t.reactCamera && !base.has(t.reactCamera)) out.push(`React camera ${t.reactCamera} isn't in the room file.`);
  if (t.hostSpot && !inv.spots.some((s) => stripArea(s.name) === t.hostSpot)) out.push(`Host spot ${t.hostSpot} isn't in the room file.`);
  if (t.react && !inv.screens.length) out.push('React is on but the room has no SCREEN: the engine will place a floating screen.');
  if (t.defaultCamera && t.camsOff.includes(t.defaultCamera)) out.push('The default camera is switched off.');
  for (const g of t.lightGroupsOff) if (!inv.lightGroups.some((x) => x.group === g)) out.push(`Light group "${g}" isn't in the room file.`);
  if (t.areas && Object.keys(t.areas).length && t.defaultArea && !t.areas[t.defaultArea]) out.push(`Default area "${t.defaultArea}" isn't listed.`);
  return out;
}

// ---------------------------------------------------------------- before / after diff
export interface DiffLine { op: ' ' | '+' | '-'; text: string }
/** Line diff of two JSON values (pretty-printed); `context` unchanged lines kept around each change (… marks gaps). */
export function jsonDiff(a: unknown, b: unknown, context = 3): DiffLine[] {
  const A = a === undefined ? [] : JSON.stringify(a, null, 2).split('\n');
  const B = b === undefined ? [] : JSON.stringify(b, null, 2).split('\n');
  return lineDiff(A, B, context);
}

export function lineDiff(A: string[], B: string[], context = 3): DiffLine[] {
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  const a = A.slice(p, A.length - s), b = B.slice(p, B.length - s);
  const full: DiffLine[] = A.slice(0, p).map((text) => ({ op: ' ' as const, text }));
  if (a.length * b.length > 4_000_000) {               // huge: plain remove + add
    for (const t of a) full.push({ op: '-', text: t });
    for (const t of b) full.push({ op: '+', text: t });
  } else {
    const n = a.length, m = b.length;
    const L = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * (m + 1) + j] = a[i] === b[j] ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { full.push({ op: ' ', text: a[i] }); i++; j++; }
      else if (j < m && (i >= n || L[i * (m + 1) + j + 1] >= L[(i + 1) * (m + 1) + j])) { full.push({ op: '+', text: b[j] }); j++; }
      else { full.push({ op: '-', text: a[i] }); i++; }
    }
  }
  for (const t of A.slice(A.length - s)) full.push({ op: ' ', text: t });
  if (context < 0) return full;
  const keep = new Uint8Array(full.length);
  full.forEach((l, k) => { if (l.op !== ' ') for (let d = -context; d <= context; d++) if (k + d >= 0 && k + d < full.length) keep[k + d] = 1; });
  const out: DiffLine[] = [];
  let gap = false;
  full.forEach((l, k) => { if (keep[k]) { out.push(l); gap = false; } else if (!gap) { out.push({ op: ' ', text: '…' }); gap = true; } });
  return out.length === 1 && out[0].text === '…' ? [] : out;
}

export const diffStats = (d: DiffLine[]) => ({ added: d.filter((l) => l.op === '+').length, removed: d.filter((l) => l.op === '-').length });
