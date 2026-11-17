// Room editor: the per-user OVERRIDE layer over a room (docs/ROOM_EDITOR.md). Pure TypeScript, shared by the helper
// (validation + storage + the room check), the OBS / studio pages (applied over the room when it loads, and hot when the
// performer saves) and the tests (tools/roomedits_unit.ts).
//
// A room's own files (scene.glb + scene.json, shipped or the owner's hand-authored) are NEVER written by the editor. The
// edits live in <data>/room-edits/<room id>.json (one file per room id; an area is its own id `<room>~<area>`) and are
// merged over scene.json when a page loads the room: an updated room keeps the user's edits, and "Reset" just deletes
// the file. Everything is in the room's glTF space (metres, +Y up, front +Z), like scene.json cameraOverrides.
//
//   {
//     "schema": "vtp-room-edits/1", "room": "vtubepro_studio", "rev": 3, "savedAt": "2026-10-06T12:00:00.000Z",
//     "cameras":      { "CAM_WIDE": { "pos": [x,y,z], "target": [x,y,z], "fov": 38 }, "SPOT_02_CAM": {…}, "CAM_MY_1": {…} },
//     "spots":        { "SPOT_03": { "pos": [x,y,z], "yaw": 180 } },
//     "screen":       { "pos": [x,y,z], "rot": [pitch, yaw, roll], "scale": 1.1 },
//     "soloScreens":  { "SPOT_01": { "position": [x,y,z], "yaw": -20, "width": 2.2 } },
//     "chatMonitors": { "SPOT_01": { "position": [x,y,z], "yaw": 15, "width": 0.9 } },
//     "chatBoards":   { "SPOT_01": { "position": [x,y,z], "yaw": 15, "width": 1.4 } },
//     "buddySpots":   { "SPOT_01": [[x,y,z]] },
//     "props": [ { "uid": "p7k2", "src": "lib:kaykit_dungeon/barrel_large", "pos": [x,y,z], "rot": [0, 90, 0], "scale": 1,
//                  "box": [x0,y0,z0, x1,y1,z1] } ],
//     "camTweaks":    { "talk:SPOT_01": { "orbit": -12, "tilt": 4, "dolly": 0.3, "height": 0.1, "fov": -3 }, "CAM_WIDE": {…} },
//     "chatScreens":  [ { "uid": "c1x9a", "pos": [x,y,z], "yaw": 20, "pitch": 0, "width": 1.2, "height": 0.9, "opacity": 1,
//                         "frame": true, "face": "fixed", "text": 1 } ],
//     "hiddenObjects": [ "PLANTS", "DESK_PROPS" ],
//     "movedObjects":  { "GAMING_CHAIR": { "pos": [x,y,z], "rot": [0, 30, 0], "scale": 1 } }
//   }
//
// hiddenObjects / movedObjects = the room's OWN objects (meshes / groups of scene.glb, by node name as the page loads the
// room: src/scene/roomObjects.ts lists the ones a user would call "objects" — never engine anchors, cameras, lights,
// colliders or tiny sub-meshes). A hidden object is not drawn and not ray-tested; a moved one is placed like the react
// screen (room-space position, rotation, size on top of the authored size). Both are undone exactly by restoring the
// authored transform / visibility (src/scene/roomEdits.ts restoreRoom); scene.json `hideNodes` stay hidden regardless.
//
// chatScreens = in-world chat displays the performer placed (any number up to 8, anywhere): they show the live chat when
// the chat is "In the room" (SceneState.chat.monitor) and replace the automatic chat monitor in that room.
//
// camTweaks = the live camera quick-adjust (src/ui/cameraTweaks.ts): a small offset on top of whatever shot an angle
// resolves to (an authored preset, or the automatic talk / group / wide / React shot), remembered per angle and applied
// every time that angle is on air (src/scene/roomEdits.ts tweakPose).
//
// Merge (mergeRoomEdits): cameras → scene.json `cameraOverrides`, spots → `spotOverrides`, soloScreens / chatMonitors /
// chatBoards / buddySpots → the scene.json keys of the same name (per SPOT_xx: the edit wins), screen → `screenEdit`,
// props → `placedProps`; `userEdits` keeps the layer itself (rev, what changed) for the editor and the room check.
import type { GfxLevel } from './graphics.ts';

export const ROOM_EDITS_SCHEMA = 'vtp-room-edits/1';
export type V3 = [number, number, number];

export interface CamEdit { pos: V3; target: V3; fov: number }
export interface SpotEdit { pos?: V3; yaw?: number }
/** A flat display (solo react screen, chat monitor, support board): centre of the shown surface, facing (yaw, deg), width. */
export interface PanelEdit { position: V3; yaw: number; width: number }
/** The SCREEN node: where its origin is when shown, its rotation (deg, Euler YXZ: [x pitch, y yaw, z roll]), uniform scale. */
export interface ScreenEdit { pos: V3; rot: V3; scale: number }
/** A placed prop. `src` = `lib:<kit>/<item>` (assets/library/props, CC0) or `pack:<pack>/<item>` (an installed prop pack).
 *  `box` = the prop's own bounding box (prop space, before scale), so the room check can test it without loading it. */
export interface PlacedProp { uid: string; src: string; pos: V3; rot: V3; scale: number; box?: [number, number, number, number, number, number] }

/** Live quick-adjust of one camera angle: orbit round the subject (deg, + = to the camera's right), tilt (deg, + = from
 *  higher, looking down more), dolly (m, + = closer), height (m, + = up, aim kept), fov (deg added to the lens). */
export interface CamTweak { orbit: number; tilt: number; dolly: number; height: number; fov: number }
export const TWEAK_LIMITS: Record<keyof CamTweak, readonly [number, number]> = { orbit: [-90, 90], tilt: [-30, 30], dolly: [-3, 3], height: [-1.5, 1.5], fov: [-25, 25] };
export const ZERO_TWEAK: CamTweak = { orbit: 0, tilt: 0, dolly: 0, height: 0, fov: 0 };
/** An angle a tweak is remembered for: a preset (CAM_WIDE, CAM_MY_1, SPOT_03_CAM), or an automatic shot (talk / solo React
 *  at a spot, group, wide, react). */
export const ANGLE_KEY = /^(?:talk:SPOT_(?:0[1-9]|1[0-2])|solo:SPOT_(?:0[1-9]|1[0-2])|group|wide|react|CAM_[A-Z0-9_]{1,40}|SPOT_(?:0[1-9]|1[0-2])_CAM)$/;
export const tweakEmpty = (t: CamTweak | null | undefined) => !t || (Object.keys(ZERO_TWEAK) as (keyof CamTweak)[]).every((k) => Math.abs(t[k] ?? 0) < 1e-4);

/** An in-world chat screen placed by the performer: centre (room space), facing (yaw / pitch, deg), size in metres (the
 *  text keeps its size: a bigger screen shows more lines), opacity, a frame or a bare panel, fixed or turning to face the
 *  camera (upright), text size. */
export interface ChatScreen { uid: string; pos: V3; yaw: number; pitch: number; width: number; height: number; opacity: number; frame: boolean; face: 'fixed' | 'camera'; text: number }
export const CHAT_SCREEN_LIMITS = { count: 8, width: [0.3, 6] as const, height: [0.2, 4] as const, opacity: [0.3, 1] as const, text: [0.6, 2] as const, pitch: [-60, 60] as const };
export const DEFAULT_CHAT_SCREEN: Omit<ChatScreen, 'uid' | 'pos' | 'yaw'> = { pitch: 0, width: 0.9, height: 1.2, opacity: 1, frame: true, face: 'fixed', text: 1 };

/** One of the room's own objects moved / turned / resized: room-space position of its origin, rotation (deg, Euler YXZ),
 *  uniform size on top of the authored size (like ScreenEdit). */
export interface ObjectEdit { pos: V3; rot: V3; scale: number }

export interface RoomEdits {
  schema: typeof ROOM_EDITS_SCHEMA;
  room: string;
  rev: number;
  savedAt: string;
  cameras?: Record<string, CamEdit>;
  spots?: Record<string, SpotEdit>;
  screen?: ScreenEdit;
  soloScreens?: Record<string, PanelEdit>;
  chatMonitors?: Record<string, PanelEdit>;
  chatBoards?: Record<string, PanelEdit>;
  buddySpots?: Record<string, V3[]>;
  props?: PlacedProp[];
  camTweaks?: Record<string, CamTweak>;
  chatScreens?: ChatScreen[];
  /** The room's own objects the performer hid (node names). */
  hiddenObjects?: string[];
  /** The room's own objects the performer moved / turned / resized (node name → pose). */
  movedObjects?: Record<string, ObjectEdit>;
}

/** The keys of a RoomEdits that hold edits (everything but the header). */
export const EDIT_KINDS = ['cameras', 'spots', 'screen', 'soloScreens', 'chatMonitors', 'chatBoards', 'buddySpots', 'props', 'camTweaks', 'chatScreens', 'hiddenObjects', 'movedObjects'] as const;
export type EditKind = typeof EDIT_KINDS[number];

export const LIMITS = {
  /** |coordinate| in metres when the room's bounds are unknown. */
  coord: 500,
  /** How far outside the room's bounds an anchor may go (m). */
  margin: 8,
  fov: [10, 100] as const,
  width: { solo: [0.8, 5] as const, monitor: [0.3, 4] as const, board: [0.3, 4] as const },
  screenScale: [0.25, 4] as const,
  propScale: [0.05, 20] as const,
  props: 200,
  /** User camera presets CAM_MY_1 … CAM_MY_8. */
  myCams: 8,
  /** The room's own objects hidden / moved (each list). */
  objects: 300,
  objectScale: [0.05, 20] as const,
  bytes: 256 * 1024,
};

/** Placed-prop budgets per graphics level (triangles of every placed prop together, after instancing: tris × copies).
 *  Over the cap the last-placed props are not drawn on that PC (the editor says so). */
export const PROP_TRI_BUDGET: Record<GfxLevel, number> = { performance: 40_000, balanced: 90_000, high: 180_000, ultra: 300_000 };
/** Draw-call budget for placed props (one per distinct prop mesh / material, instanced). */
export const PROP_DRAW_BUDGET: Record<GfxLevel, number> = { performance: 40, balanced: 80, high: 140, ultra: 200 };

export const SPOT_KEY = /^SPOT_(0[1-9]|1[0-2])$/;
export const SPOT_CAM_KEY = /^SPOT_(0[1-9]|1[0-2])_CAM$/;
export const CAM_KEY = /^CAM_[A-Z0-9_]{1,40}$/;
export const MY_CAM_KEY = /^CAM_MY_[1-8]$/;
export const PROP_SRC = /^(lib|pack):([a-z0-9][a-z0-9_-]{0,47})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,79})$/;
const UID = /^[a-z0-9]{2,16}$/;
/** A room object's node name as three.js loads it (GLTFLoader: spaces → _, no [ ] . : / ; made unique with _1, _2 …). */
export const OBJECT_NAME = /^[^\u0000-\u001f\u007f[\]:./\\<>"`]{1,80}$/u;
/** Node names the room engines read (anchors, cameras, lights, colliders, screens, FX, engine-moved parts …): never
 *  offered as "objects" and refused in hiddenObjects / movedObjects (docs/SCENES.md, docs/ARTIST_ENVIRONMENTS.md). */
export const ENGINE_NODE = /^(?:(?:SPOT|SEAT|GM_SEAT|CAM|SCREEN|PATH|LIGHT|EMIT|COLLIDE|FLOOR|BG|SMASH|CHAT|BUDDY|FX|EVT|EVENT|ACTIVITY|SPACE|SHIP|SHIPLANE|SWAY|BOB|SWAB|RAIL|LEG|PERCH|PROJECTOR|YACHT|VOYAGE|SKY|DAMAGE|TALK_MONITOR|SOLO|NAV|WALK|SIZE|DETAIL_LOD|MAP_SURFACE|RACE|WZ|SLAP|TREASURE|FESTIVAL|PA_TICKER|DOOR_OUTSIDE|DOOR_LOCKED|DOOR_UNLOCKED)(?:_|$)|DOOR$|.*_SKIN$|[A-Z0-9][A-Z0-9_-]{0,23}__|vtp:|~|prop:)/;
export const objectNameOk = (n: unknown): n is string => typeof n === 'string' && OBJECT_NAME.test(n) && !ENGINE_NODE.test(n);

export const spotKey = (index0: number) => `SPOT_${String(index0 + 1).padStart(2, '0')}`;

/** What the server knows about a room, to validate edits against (all optional: unknown = not checked). */
export interface EditContext {
  room?: string;
  /** SPOT_xx keys the room has (incl. TTRPG SEAT_xx / GM_SEAT, as SPOT_xx). */
  spots?: Set<string>;
  /** CAM_* presets the room has (GLB + scene.json cams / cameraOverrides). */
  cams?: Set<string>;
  /** The room has a SCREEN. */
  screen?: boolean;
  /** glTF-space bounds of the room geometry [x0,y0,z0, x1,y1,z1]. */
  bounds?: [number, number, number, number, number, number] | null;
  /** Prop sources that are installed (lib:… / pack:…) → their own box; unknown sources are refused when given. */
  props?: Map<string, { box?: PlacedProp['box'] }>;
}

export interface EditCheck { edits: RoomEdits; errors: string[]; dropped: string[] }

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const r2 = (v: number) => Math.round(v * 100) / 100;
const yawNorm = (d: number) => { let y = ((d % 360) + 360) % 360; if (y > 180) y -= 360; return r2(y); };

/** An empty layer for a room. */
export function emptyEdits(room: string): RoomEdits { return { schema: ROOM_EDITS_SCHEMA, room, rev: 0, savedAt: '' }; }

/** True when the layer changes nothing. */
export function editsEmpty(e: RoomEdits | null | undefined): boolean {
  if (!e) return true;
  return EDIT_KINDS.every((k) => {
    const v = e[k];
    if (v === undefined || v === null) return true;
    if (k === 'screen') return false;
    return Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0;
  });
}

/** Count of edited anchors + props (the editor's "N changes"). */
export function editCount(e: RoomEdits | null | undefined): number {
  if (!e) return 0;
  let n = 0;
  for (const k of EDIT_KINDS) {
    const v = e[k];
    if (!v) continue;
    if (k === 'screen') n++;
    else if (Array.isArray(v)) n += v.length;
    else n += Object.keys(v).length;
  }
  return n;
}

/**
 * Validate a layer (from a page, a file, an AI): every number finite and in range, every anchor id known (when the
 * context says which exist), every prop installed (when the context lists them), positions inside the room's bounds +
 * a margin. Bad entries are reported in `errors` (the server refuses the save) — `edits` holds what is valid, so a file
 * written by an older / newer version still loads with what it can.
 */
export function checkRoomEdits(raw: unknown, ctx: EditContext = {}): EditCheck {
  const errors: string[] = [];
  const dropped: string[] = [];
  const x = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const room = typeof ctx.room === 'string' ? ctx.room : typeof x.room === 'string' && /^[a-z0-9][a-z0-9_~-]{0,72}$/.test(x.room) ? x.room : '';
  const out: RoomEdits = emptyEdits(room);
  out.rev = isNum(x.rev) && x.rev >= 0 ? Math.min(1e9, Math.floor(x.rev)) : 0;
  out.savedAt = typeof x.savedAt === 'string' && x.savedAt.length <= 40 ? x.savedAt : '';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push('The room edits must be an object.'); return { edits: out, errors, dropped }; }
  if (x.schema !== undefined && x.schema !== ROOM_EDITS_SCHEMA) errors.push(`Unknown format "${String(x.schema).slice(0, 40)}" (expected ${ROOM_EDITS_SCHEMA}).`);
  const b = ctx.bounds && ctx.bounds.every(isNum) ? ctx.bounds : null;
  const bad = (what: string, why: string) => { errors.push(`${what}: ${why}`); dropped.push(what); };
  const v3 = (v: unknown, what: string, inRoom = true): V3 | null => {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(isNum)) { bad(what, 'needs three finite numbers [x, y, z]'); return null; }
    const p = v.map(r4) as V3;
    if (p.some((c) => Math.abs(c) > LIMITS.coord)) { bad(what, `is more than ${LIMITS.coord} m from the room's centre`); return null; }
    if (inRoom && b) {
      const m = LIMITS.margin;
      if (p[0] < b[0] - m || p[1] < b[1] - m || p[2] < b[2] - m || p[0] > b[3] + m || p[1] > b[4] + m || p[2] > b[5] + m) { bad(what, `is outside the room (more than ${m} m past its walls)`); return null; }
    }
    return p;
  };
  const deg = (v: unknown, what: string): number | null => { if (!isNum(v)) { bad(what, 'needs a finite angle in degrees'); return null; } return yawNorm(v); };
  const inRange = (v: unknown, lo: number, hi: number, what: string): number | null => {
    if (!isNum(v)) { bad(what, 'needs a finite number'); return null; }
    if (v < lo || v > hi) { bad(what, `must be between ${lo} and ${hi}`); return null; }
    return r4(v);
  };
  const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
  const knownSpot = (k: string) => SPOT_KEY.test(k) && (!ctx.spots || ctx.spots.has(k));

  // cameras
  const cams = obj(x.cameras);
  if (x.cameras !== undefined && !cams) errors.push('cameras: must be an object of camera name → {pos, target, fov}');
  if (cams) {
    let myCams = 0;
    for (const [k, v] of Object.entries(cams)) {
      const what = `cameras.${k.slice(0, 48)}`;
      const spotCam = SPOT_CAM_KEY.exec(k);
      if (spotCam) { if (!knownSpot(`SPOT_${spotCam[1]}`)) { bad(what, 'that spot is not in this room'); continue; } }
      else if (MY_CAM_KEY.test(k)) { if (++myCams > LIMITS.myCams) { bad(what, `at most ${LIMITS.myCams} cameras of your own`); continue; } }
      else if (!CAM_KEY.test(k)) { bad(what, 'not a camera name (CAM_…, SPOT_xx_CAM or CAM_MY_1…8)'); continue; }
      else if (ctx.cams && !ctx.cams.has(k)) { bad(what, 'this room has no camera of that name (add your own as CAM_MY_1…8)'); continue; }
      const c = obj(v);
      if (!c) { bad(what, 'needs {pos, target, fov}'); continue; }
      const pos = v3(c.pos, `${what}.pos`), target = v3(c.target, `${what}.target`, false);
      const fov = inRange(c.fov ?? 38, LIMITS.fov[0], LIMITS.fov[1], `${what}.fov`);
      if (!pos || !target || fov === null) continue;
      if (Math.hypot(pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]) < 0.05) { bad(what, 'pos and target are the same point'); continue; }
      (out.cameras ??= {})[k] = { pos, target, fov };
    }
  }
  // spots
  const spots = obj(x.spots);
  if (x.spots !== undefined && !spots) errors.push('spots: must be an object of SPOT_xx → {pos, yaw}');
  if (spots) for (const [k, v] of Object.entries(spots)) {
    const what = `spots.${k.slice(0, 48)}`;
    if (!knownSpot(k)) { bad(what, 'that spot is not in this room'); continue; }
    const s = obj(v);
    if (!s) { bad(what, 'needs {pos?, yaw?}'); continue; }
    const e: SpotEdit = {};
    if (s.pos !== undefined) { const p = v3(s.pos, `${what}.pos`); if (p) e.pos = p; }
    if (s.yaw !== undefined) { const y = deg(s.yaw, `${what}.yaw`); if (y !== null) e.yaw = y; }
    if (e.pos || e.yaw !== undefined) (out.spots ??= {})[k] = e;
  }
  // the react screen
  if (x.screen !== undefined && x.screen !== null) {
    const s = obj(x.screen);
    if (!s) bad('screen', 'needs {pos, rot, scale}');
    else if (ctx.screen === false) bad('screen', 'this room has no react screen');
    else {
      const pos = v3(s.pos, 'screen.pos');
      const rot = Array.isArray(s.rot) && s.rot.length === 3 && s.rot.every(isNum) ? (s.rot as number[]).map(yawNorm) as V3 : (bad('screen.rot', 'needs three angles [x, y, z] in degrees'), null);
      const scale = inRange(s.scale ?? 1, LIMITS.screenScale[0], LIMITS.screenScale[1], 'screen.scale');
      if (pos && rot && scale !== null) out.screen = { pos, rot, scale };
    }
  }
  // flat displays per spot
  const panels = (key: 'soloScreens' | 'chatMonitors' | 'chatBoards', lim: readonly [number, number]) => {
    const o = obj(x[key]);
    if (x[key] !== undefined && !o) { errors.push(`${key}: must be an object of SPOT_xx → {position, yaw, width}`); return; }
    if (!o) return;
    for (const [k, v] of Object.entries(o)) {
      const what = `${key}.${k.slice(0, 48)}`;
      if (!knownSpot(k)) { bad(what, 'that spot is not in this room'); continue; }
      const p = obj(v);
      if (!p) { bad(what, 'needs {position, yaw, width}'); continue; }
      const position = v3(p.position, `${what}.position`), yaw = deg(p.yaw ?? 0, `${what}.yaw`), width = inRange(p.width, lim[0], lim[1], `${what}.width`);
      if (position && yaw !== null && width !== null) (out[key] ??= {})[k] = { position, yaw, width };
    }
  };
  panels('soloScreens', LIMITS.width.solo);
  panels('chatMonitors', LIMITS.width.monitor);
  panels('chatBoards', LIMITS.width.board);
  // chat buddy floor points
  const bs = obj(x.buddySpots);
  if (x.buddySpots !== undefined && !bs) errors.push('buddySpots: must be an object of SPOT_xx → [[x,y,z], …]');
  if (bs) for (const [k, v] of Object.entries(bs)) {
    const what = `buddySpots.${k.slice(0, 48)}`;
    if (!knownSpot(k)) { bad(what, 'that spot is not in this room'); continue; }
    if (!Array.isArray(v) || !v.length || v.length > 8) { bad(what, 'needs 1 to 8 points'); continue; }
    const pts = v.map((p, i) => v3(p, `${what}[${i}]`)).filter((p): p is V3 => !!p);
    if (pts.length) (out.buddySpots ??= {})[k] = pts;
  }
  // props
  if (x.props !== undefined) {
    if (!Array.isArray(x.props)) errors.push('props: must be a list');
    else {
      if (x.props.length > LIMITS.props) errors.push(`props: at most ${LIMITS.props} props in one room (${x.props.length} given)`);
      const uids = new Set<string>();
      for (const [i, v] of x.props.slice(0, LIMITS.props).entries()) {
        const p = obj(v);
        const what = `props[${i}]`;
        if (!p) { bad(what, 'needs {uid, src, pos, rot, scale}'); continue; }
        const uid = typeof p.uid === 'string' && UID.test(p.uid) && !uids.has(p.uid) ? p.uid : null;
        if (!uid) { bad(`${what}.uid`, 'needs a unique short id (a-z, 0-9)'); continue; }
        const src = typeof p.src === 'string' && PROP_SRC.test(p.src) ? p.src : null;
        if (!src) { bad(`${what}.src`, 'not a prop source (lib:<kit>/<item> or pack:<pack>/<item>)'); continue; }
        if (ctx.props && !ctx.props.has(src)) { bad(`${what}.src`, `"${src}" is not installed on this PC`); continue; }
        const pos = v3(p.pos, `${what}.pos`);
        const rot = Array.isArray(p.rot) && p.rot.length === 3 && p.rot.every(isNum) ? (p.rot as number[]).map(yawNorm) as V3 : (bad(`${what}.rot`, 'needs three angles [x, y, z] in degrees'), null);
        const scale = inRange(p.scale ?? 1, LIMITS.propScale[0], LIMITS.propScale[1], `${what}.scale`);
        if (!pos || !rot || scale === null) continue;
        uids.add(uid);
        const known = ctx.props?.get(src)?.box;
        const bx = known ?? (Array.isArray(p.box) && p.box.length === 6 && p.box.every(isNum) && p.box.every((c) => Math.abs(c as number) < 200) ? (p.box as number[]).map(r4) as PlacedProp['box'] : undefined);
        (out.props ??= []).push({ uid, src, pos, rot, scale, ...(bx ? { box: bx } : {}) });
      }
    }
  }
  // live camera quick-adjust
  const tw = obj(x.camTweaks);
  if (x.camTweaks !== undefined && !tw) errors.push('camTweaks: must be an object of angle → {orbit, tilt, dolly, height, fov}');
  if (tw) for (const [k, v] of Object.entries(tw).slice(0, 64)) {
    const what = `camTweaks.${k.slice(0, 48)}`;
    if (!ANGLE_KEY.test(k)) { bad(what, 'not a camera angle'); continue; }
    const sp = /SPOT_(\d\d)/.exec(k);
    if (sp && !knownSpot(`SPOT_${sp[1]}`)) { bad(what, 'that spot is not in this room'); continue; }
    const t = obj(v);
    if (!t) { bad(what, 'needs {orbit, tilt, dolly, height, fov}'); continue; }
    const o = {} as CamTweak;
    let okT = true;
    for (const f of Object.keys(TWEAK_LIMITS) as (keyof CamTweak)[]) {
      const n = inRange(t[f] ?? 0, TWEAK_LIMITS[f][0], TWEAK_LIMITS[f][1], `${what}.${f}`);
      if (n === null) { okT = false; break; }
      o[f] = n;
    }
    if (okT && !tweakEmpty(o)) (out.camTweaks ??= {})[k] = o;
  }
  // in-world chat screens
  if (x.chatScreens !== undefined) {
    if (!Array.isArray(x.chatScreens)) errors.push('chatScreens: must be a list');
    else {
      if (x.chatScreens.length > CHAT_SCREEN_LIMITS.count) errors.push(`chatScreens: at most ${CHAT_SCREEN_LIMITS.count} chat screens in one room`);
      const uids = new Set<string>();
      const L = CHAT_SCREEN_LIMITS;
      for (const [i, v] of x.chatScreens.slice(0, L.count).entries()) {
        const c = obj(v), what = `chatScreens[${i}]`;
        if (!c) { bad(what, 'needs {uid, pos, yaw, width, height}'); continue; }
        const uid = typeof c.uid === 'string' && UID.test(c.uid) && !uids.has(c.uid) ? c.uid : null;
        if (!uid) { bad(`${what}.uid`, 'needs a unique short id (a-z, 0-9)'); continue; }
        const pos = v3(c.pos, `${what}.pos`), yaw = deg(c.yaw ?? 0, `${what}.yaw`);
        const pitch = inRange(c.pitch ?? 0, L.pitch[0], L.pitch[1], `${what}.pitch`);
        const width = inRange(c.width, L.width[0], L.width[1], `${what}.width`), height = inRange(c.height, L.height[0], L.height[1], `${what}.height`);
        const opacity = inRange(c.opacity ?? 1, L.opacity[0], L.opacity[1], `${what}.opacity`), text = inRange(c.text ?? 1, L.text[0], L.text[1], `${what}.text`);
        if (c.face !== undefined && c.face !== 'fixed' && c.face !== 'camera') { bad(`${what}.face`, 'must be "fixed" or "camera"'); continue; }
        if (!pos || yaw === null || pitch === null || width === null || height === null || opacity === null || text === null) continue;
        uids.add(uid);
        (out.chatScreens ??= []).push({ uid, pos, yaw, pitch, width, height, opacity, frame: c.frame !== false, face: c.face === 'camera' ? 'camera' : 'fixed', text });
      }
    }
  }
  // the room's own objects: hidden, moved
  if (x.hiddenObjects !== undefined) {
    if (!Array.isArray(x.hiddenObjects)) errors.push('hiddenObjects: must be a list of object names');
    else {
      if (x.hiddenObjects.length > LIMITS.objects) errors.push(`hiddenObjects: at most ${LIMITS.objects} hidden objects in one room`);
      const seen = new Set<string>();
      for (const [i, n] of x.hiddenObjects.slice(0, LIMITS.objects).entries()) {
        if (!objectNameOk(n)) { bad(`hiddenObjects[${i}]`, 'not an object of the room (engine anchors, cameras and lights cannot be hidden)'); continue; }
        if (!seen.has(n)) { seen.add(n); (out.hiddenObjects ??= []).push(n); }
      }
    }
  }
  const mo = obj(x.movedObjects);
  if (x.movedObjects !== undefined && !mo) errors.push('movedObjects: must be an object of object name → {pos, rot, scale}');
  if (mo) {
    const list = Object.entries(mo);
    if (list.length > LIMITS.objects) errors.push(`movedObjects: at most ${LIMITS.objects} moved objects in one room`);
    for (const [k, v] of list.slice(0, LIMITS.objects)) {
      const what = `movedObjects.${k.slice(0, 48)}`;
      if (!objectNameOk(k)) { bad(what, 'not an object of the room (engine anchors, cameras and lights cannot be moved here)'); continue; }
      const o = obj(v);
      if (!o) { bad(what, 'needs {pos, rot, scale}'); continue; }
      const pos = v3(o.pos, `${what}.pos`);
      const rot = Array.isArray(o.rot) && o.rot.length === 3 && o.rot.every(isNum) ? (o.rot as number[]).map(yawNorm) as V3 : (bad(`${what}.rot`, 'needs three angles [x, y, z] in degrees'), null);
      const scale = inRange(o.scale ?? 1, LIMITS.objectScale[0], LIMITS.objectScale[1], `${what}.scale`);
      if (pos && rot && scale !== null) (out.movedObjects ??= {})[k] = { pos, rot, scale };
    }
  }
  return { edits: out, errors, dropped };
}

/** The scene.json keys an edit layer touches (and the editor reads back for "original" values). */
export const MERGED_KEYS = ['cameraOverrides', 'spotOverrides', 'soloScreens', 'chatMonitors', 'chatBoards', 'buddySpots', 'screenEdit', 'placedProps', 'camTweaks', 'chatScreens', 'userEdits'] as const;

/**
 * scene.json (or a listed SceneInfo) with the user's layer merged over it. Never mutates `base`. Per key the edit wins;
 * a moved spot drops the authored scene.json approach waypoints (the GLB's are kept within 3 m, spotOverrides rules).
 */
export function mergeRoomEdits<T extends object>(base: T, edits: RoomEdits | null | undefined): T & { userEdits?: RoomEdits } {
  if (!edits || editsEmpty(edits)) return base as T & { userEdits?: RoomEdits };
  const b = base as Record<string, unknown>;
  const rec = (k: string): Record<string, unknown> => (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? b[k] as Record<string, unknown> : {});
  const out: Record<string, unknown> = { ...b, userEdits: edits };
  if (edits.cameras && Object.keys(edits.cameras).length) out.cameraOverrides = { ...rec('cameraOverrides'), ...edits.cameras };
  if (edits.spots && Object.keys(edits.spots).length) {
    const so: Record<string, unknown> = { ...rec('spotOverrides') };
    for (const [k, e] of Object.entries(edits.spots)) {
      const prev = (so[k] && typeof so[k] === 'object' ? so[k] : {}) as Record<string, unknown>;
      const next: Record<string, unknown> = { ...prev, ...e };
      if (e.pos) delete next.approach;
      so[k] = next;
    }
    out.spotOverrides = so;
  }
  for (const k of ['soloScreens', 'chatMonitors', 'chatBoards', 'buddySpots'] as const) {
    const e = edits[k];
    if (e && Object.keys(e).length) out[k] = { ...rec(k), ...e };
  }
  if (edits.screen) out.screenEdit = edits.screen;
  if (edits.props?.length) out.placedProps = edits.props;
  if (edits.camTweaks && Object.keys(edits.camTweaks).length) out.camTweaks = edits.camTweaks;
  if (edits.chatScreens?.length) out.chatScreens = edits.chatScreens;
  return out as T & { userEdits?: RoomEdits };
}

/** Undo / redo: the editor keeps whole layers (they are small) and compares them. */
export function sameEdits(a: RoomEdits | null | undefined, b: RoomEdits | null | undefined): boolean {
  const strip = (e: RoomEdits | null | undefined) => (e ? JSON.stringify(EDIT_KINDS.map((k) => e[k] ?? null)) : JSON.stringify(EDIT_KINDS.map(() => null)));
  return strip(a) === strip(b);
}

/** A deep copy (structuredClone is not in every runtime the shared code runs in). */
export const cloneEdits = (e: RoomEdits): RoomEdits => JSON.parse(JSON.stringify(e)) as RoomEdits;

/** A new prop uid that isn't used yet in this layer. */
export function newPropUid(e: RoomEdits, rnd: () => number = Math.random): string {
  const used = new Set([...(e.props ?? []).map((p) => p.uid), ...(e.chatScreens ?? []).map((c) => c.uid)]);
  for (let i = 0; i < 1000; i++) {
    const u = 'p' + Math.floor(rnd() * 36 ** 5).toString(36).padStart(5, '0');
    if (!used.has(u)) return u;
  }
  return 'p' + Date.now().toString(36).slice(-8);
}

/** Which props fit a graphics level's budget (in placing order): `tris` per source. Returns the uids drawn + why not. */
export function propsInBudget(props: PlacedProp[], tris: (src: string) => number, meshes: (src: string) => number, level: GfxLevel): { drawn: Set<string>; over: string[]; tris: number; draws: number } {
  const capT = PROP_TRI_BUDGET[level], capD = PROP_DRAW_BUDGET[level];
  const drawn = new Set<string>(), over: string[] = [];
  const srcs = new Set<string>();
  let t = 0, d = 0;
  for (const p of props) {
    const pt = Math.max(0, tris(p.src) || 0);
    const pd = srcs.has(p.src) ? 0 : Math.max(1, meshes(p.src) || 1);   // (instanced: a source costs its draw calls once)
    if (t + pt > capT || d + pd > capD) { over.push(p.uid); continue; }
    t += pt; d += pd; srcs.add(p.src); drawn.add(p.uid);
  }
  return { drawn, over, tris: t, draws: d };
}
