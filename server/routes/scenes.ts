// 3D scenes (docs/SCENES.md): list + serve assets/scenes/<id>/*, and the host's persisted scene state.
//
//   GET  /api/scenes                     → SceneInfo[] (every folder with a readable scene.json; kept in memory, ETag)
//   GET  /api/scenes/:id/file/*path      → a file from that scene folder (scene.glb, thumb.png, …)
//   GET  /api/scene                      → the current SceneState (kept in memory, saved to cache/scene.json; default = Classic)
//   PUT  /api/scene                      → save + broadcast { type:'scene', state, self:'@host' } (localhost only). The body
//                                          is merged into the saved state per top-level key: studios send only what they
//                                          changed (`_diff: true`, src/scene/sceneSync.ts); rev only goes up. A WHOLE
//                                          state older than the saved one (an older studio that never read it, or a stale
//                                          tab) is refused with 409 + the saved state instead of replacing the room.
//   POST /api/scene/lighting | /api/scene/curtain | /api/scene/stage | /api/scene/area | /api/scene/afk | /api/scene/toggle
//                                        → a bus command to the host studio (localhost only)
// Rooms with `areas` (shared/roomId.ts) are listed once per area (`<room>~<area>`); files of an area id come from
// `<room>/areas/<area>/<file>` when that exists (its own preview / thumb / lut), else from the room folder.
import { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { SceneState } from '../../shared/types.ts';
import { HOST_KEY, defaultSceneState, isSceneId, sanitizeSceneState } from '../../shared/scene.ts';
import { broadcast } from '../bus.ts';
import { obs } from '../obs.ts';
import { isLightingState } from '../../shared/lightShow.ts';
import { isModeId } from '../../shared/stage.ts';
import { HttpError, etagMatches, pendingWriteText, writeFileNow } from '../library.ts';
import { CACHE_DIR, USER_SCENES_DIR } from '../paths.ts';
import { requireLocal, sendFrom, wildcardPath } from './util.ts';
import { AREA_KEY, splitRoomId } from '../../shared/roomId.ts';
import { ROOM_DIRS, roomCatalog, startRoomCatalog } from '../roomList.ts';
import { roomPrefsRoutes } from './roomPrefs.ts';
import { composeArgs } from '../../shared/festivalComposeState.ts';
import { isToggleId } from '../../shared/roomToggles.ts';
import { AFK_TEXT_MAX, cleanCrewName } from '../../shared/afk.ts';

export const SCENES_DIR = USER_SCENES_DIR;   // where new rooms go (server/paths.ts); shipped rooms stay in SHIPPED_SCENES_DIR
const STATE_FILE = path.join(CACHE_DIR, 'scene.json');

export const sceneRoutes = Router();
sceneRoutes.use(roomPrefsRoutes);              // room favourites + recent rooms (server/routes/roomPrefs.ts, shared/roomPrefs.ts)

/** A room's folder: the user's scenes folder or the shipped one; else where a new room would go. */
export function sceneDir(id: string): string {
  for (const d of ROOM_DIRS) { const own = path.join(d, id); if (fs.existsSync(path.join(own, 'scene.json'))) return own; }
  return path.join(SCENES_DIR, id);
}

// The room list comes from memory (server/roomList.ts room catalog: built at startup, refreshed in the background when
// a rooms folder changes), as a ready JSON string with an ETag (a repeat poll of an unchanged list = 304).
void startRoomCatalog();
sceneRoutes.get('/api/scenes', async (req, res) => {
  const c = await roomCatalog();
  res.setHeader('ETag', c.etag);
  res.setHeader('Cache-Control', 'no-cache');
  if (etagMatches(req.headers['if-none-match'], c.etag)) { res.status(304).end(); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(c.body);
});

sceneRoutes.get('/api/scenes/:id/file/*rel', (req, res) => {
  const id = String(req.params.id);
  if (!isSceneId(id)) throw new HttpError(400, 'Bad scene id');
  const { base, area } = splitRoomId(id);
  const rel = wildcardPath((req.params as Record<string, unknown>).rel);
  if (area && AREA_KEY.test(area)) {
    const dir = path.join(sceneDir(base), 'areas', area), full = path.resolve(dir, rel);
    if (full.startsWith(path.resolve(dir) + path.sep) && fs.existsSync(full) && fs.statSync(full).isFile()) return sendFrom(res, dir, rel);
  }
  sendFrom(res, sceneDir(base), rel);
});

// The host's scene state lives in memory (this server is its only writer): GET answers from memory, PUT merges into
// it and cache/scene.json is written off the event loop (PUTs that come in while one is written share the next write).
// The file is read once, here; if something else replaces it ("Bring my stuff over" copies an older one in), the
// watcher below picks that up.
// (a good file is copied to scene.json.bak at start-up; a broken / missing one falls back to that copy, never to Classic)
function readStateFile(): SceneState {
  for (const f of [STATE_FILE, `${STATE_FILE}.bak`]) {
    try {
      const text = fs.readFileSync(f, 'utf8');
      const s = sanitizeSceneState(JSON.parse(text));
      if (f === STATE_FILE) try { fs.writeFileSync(`${STATE_FILE}.bak`, text); } catch { /* read-only / no cache folder yet */ }
      else console.warn('[vtube-pro] cache/scene.json was unreadable: using scene.json.bak');
      return s;
    } catch { /* next */ }
  }
  return defaultSceneState();
}
let sceneState: SceneState = readStateFile();
let lastStateText: string | null = null;                    // what this server saved last
let stateGen = 0;                                           // bumped by every PUT
/** The state known to be on disk (a failed PUT puts sceneState back to it). */
let savedState: SceneState = sceneState, savedText: string | null = null;
const readState = (): SceneState => sceneState;
let stateReload: NodeJS.Timeout | null = null;
async function reloadState() {
  stateReload = null;
  const gen = stateGen;
  if (pendingWriteText(STATE_FILE) !== undefined) return;                      // our own save is still going on
  const text = await fsp.readFile(STATE_FILE, 'utf8').catch(() => null);
  if (gen !== stateGen || pendingWriteText(STATE_FILE) !== undefined) return;   // a PUT came in meanwhile: it is newer
  if (text === null || text === lastStateText) return;                         // our own save
  try {
    const s = sanitizeSceneState(JSON.parse(text));
    s.rev = Math.max(s.rev, sceneState.rev + 1);             // (studios ignore states older than what they have)
    sceneState = savedState = s; lastStateText = savedText = text;
    broadcast({ type: 'scene', state: s, self: HOST_KEY });  // studios + OBS pages follow the replaced file
  } catch { /* half-written: the next event */ }
}
let stateWatch: fs.FSWatcher | null = null;
function watchStateFile() {
  if (stateWatch) return;
  try {
    const w = fs.watch(CACHE_DIR, { persistent: false }, (_ev, name) => {
      if (String(name) !== 'scene.json' || stateReload) return;
      stateReload = setTimeout(() => void reloadState(), 250);
      stateReload.unref?.();
    });
    w.on('error', () => { try { w.close(); } catch { /* */ } if (stateWatch === w) stateWatch = null; });   // watched again below
    stateWatch = w;
  } catch { /* no cache folder yet (a first run: index.ts makes it right after the imports) */ }
}
watchStateFile();
// a first run / a broken watcher: try again (the cache folder appears right after start-up), until it watches
const stateWatchRetry = setInterval(() => { watchStateFile(); }, 2000);
stateWatchRetry.unref?.();
setImmediate(watchStateFile);

sceneRoutes.get('/api/scene', (_req, res) => { res.json(readState()); });

// POST /api/scene/lighting {state:'preshow'|'show'|'react'|'brb'|'outro'} — Stream Deck / scripts. The host studio owns
// the scene state, so this asks it (bus command) to switch; it saves + sends to OBS pages and guests as usual.
sceneRoutes.post('/api/scene/lighting', (req, res) => {
  requireLocal(req);
  const st = (req.body ?? {}) as { state?: unknown; style?: unknown; reactive?: unknown; mood?: unknown; safe?: unknown };
  // {style: 'neon_rave' | 'auto' | 'off' | 'u:0'} picks a music lighting style (shared/lightStyles.ts); may come with a state
  const style = typeof st.style === 'string' && (st.style === 'off' || st.style === 'auto' || /^[a-z0-9_]{2,32}$|^u:\d{1,2}$/.test(st.style)) ? st.style : null;
  // reactive lights: {reactive: true | false | 'toggle', mood: 'room' | 'calm' | 'club' | 'rave' | 'next', safe: bool}
  const rl: Record<string, unknown> = {};
  if (typeof st.reactive === 'boolean' || st.reactive === 'toggle') rl.on = st.reactive;
  if (typeof st.mood === 'string' && /^(room|calm|club|rave|next)$/.test(st.mood)) rl.mood = st.mood;
  if (typeof st.safe === 'boolean') rl.safe = st.safe;
  const hasRl = Object.keys(rl).length > 0;
  if (!isLightingState(st.state) && !style && !hasRl) throw new HttpError(400, 'Body must be { state: "preshow" | "show" | "react" | "brb" | "outro" }, { style: "<style id>" | "auto" | "off" } and / or { reactive: true | false | "toggle", mood: "room" | "calm" | "club" | "rave" | "next", safe: true | false }');
  broadcast({ type: 'command', command: 'scene', args: { ...(isLightingState(st.state) ? { lighting: st.state } : {}), ...(style ? { lightStyle: style } : {}), ...(hasRl ? { reactiveLights: rl } : {}) } });
  res.json({ ok: true, ...(isLightingState(st.state) ? { state: st.state } : {}), ...(style ? { style } : {}), ...(hasRl ? { reactiveLights: rl } : {}) });
});
// POST /api/scene/club {event?: 'conga' | 'danceoff' | … | 'tip' | 'sub' | 'bits' | 'raid' | 'big', area?: 'dj' | 'balcony', bits?, freq?}
// — the club room (src/scene/club) from a Stream Deck / script; the host studio applies it (bus command).
sceneRoutes.post('/api/scene/club', (req, res) => {
  requireLocal(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  if (typeof b.event === 'string' && /^[a-z]{2,16}$/.test(b.event)) args.event = b.event;
  if (b.area === 'dj' || b.area === 'balcony') args.area = b.area;
  if (typeof b.bits === 'boolean') args.bits = b.bits;
  if (typeof b.freq === 'number' && Number.isFinite(b.freq)) args.freq = b.freq;
  if (typeof b.user === 'string') args.user = b.user.slice(0, 32);
  if (!Object.keys(args).length) throw new HttpError(400, 'Body: { event?: "<bit or celebration>", area?: "dj" | "balcony", bits?: bool, freq?: number }');
  broadcast({ type: 'command', command: 'scene', args: { club: args } });
  res.json({ ok: true, ...args });
});
// POST /api/scene/festival {cue?: 'drop' | 'flames' | 'co2' | 'confetti' | 'fireworks' | 'gerbs' | 'blinders' | 'blackout' | 'cue:<name>',
// show?, pyro?, intensity?, endshow?: 1 (start now) | <epoch ms> | 0 (stop), showCams?, compose?: 'main' | 'closing' | 'acts3' | 'inverted'
// (+ min?, anthem?, bpm?, seed?: a composed endshow, shared/festivalCompose.ts - {"compose":"main","endshow":1} plays it; compose
// alone sets the choice up and stops what is playing) | null | 'room' (the stage's own endshow: {"compose":"room","endshow":1});
// a bare {"endshow":1} plays the stage's own endshow} — festival stages (src/scene/festival) from a Stream Deck / DJ pad; the
// host studio applies it (bus command).
sceneRoutes.post('/api/scene/festival', (req, res) => {
  requireLocal(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  if (typeof b.cue === 'string' && /^(drop|flames|co2|confetti|fireworks|gerbs|blinders|blackout|big|cue:[a-z0-9_]{1,40})$/.test(b.cue)) args.cue = b.cue;
  if (typeof b.show === 'string' && /^[a-z0-9_]{1,40}$/.test(b.show)) args.show = b.show;
  if (typeof b.pyro === 'boolean') args.pyro = b.pyro;
  if (typeof b.intensity === 'number' && Number.isFinite(b.intensity)) args.intensity = Math.min(1.5, Math.max(0, b.intensity));
  // the room's scripted endshow: a start time (epoch ms; the host's studio stamps now when it's 1) or 0 = stop; its camera cuts
  if (typeof b.endshow === 'number' && Number.isFinite(b.endshow)) args.endshow = b.endshow === 1 ? Date.now() + 400 : Math.max(0, b.endshow);
  if (typeof b.showCams === 'boolean') args.showCams = b.showCams;
  composeArgs(b, Date.now(), args);
  if (!Object.keys(args).length) throw new HttpError(400, 'Body: { cue?: "drop" | "flames" | "co2" | "confetti" | "fireworks" | "gerbs" | "blinders" | "blackout", show?: "<show id>" | "auto", pyro?: bool, intensity?: 0..1.5 }');
  broadcast({ type: 'command', command: 'scene', args: { festival: args } });
  res.json({ ok: true, ...args });
});
// POST /api/scene/curtain {confirm?: true, style?, hold?, dur?, boot?, minHold?, rooms?} — room-change transitions (Stream Deck /
// scripts): confirm = reveal the new room now (hold mode). Like lighting, the host studio owns the state: bus command.
sceneRoutes.post('/api/scene/curtain', (req, res) => {
  requireLocal(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  if (b.confirm === true) args.confirm = true;
  if (typeof b.style === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(b.style)) args.style = b.style;
  for (const k of ['hold', 'boot', 'rooms'] as const) if (typeof b[k] === 'boolean') args[k] = b[k];
  for (const k of ['dur', 'minHold'] as const) if (typeof b[k] === 'number' && Number.isFinite(b[k])) args[k] = b[k];
  if (!Object.keys(args).length) throw new HttpError(400, 'Body: { confirm: true } and / or { style, hold, dur, boot, minHold }');
  broadcast({ type: 'command', command: 'scene', args: { curtain: args } });
  res.json({ ok: true, curtain: args });
});
// POST /api/scene/cover {on?: true | false | "toggle", style?, text?} — the capture cover (Stream Deck / scripts): an
// animated card over ONLY the screen-capture area while a game is being set up; stays up until turned off. Bus command.
sceneRoutes.post('/api/scene/cover', (req, res) => {
  requireLocal(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  if (typeof b.on === 'boolean' || b.on === 'toggle') args.on = b.on;
  if (typeof b.style === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(b.style)) args.style = b.style;
  if (typeof b.text === 'string') args.text = b.text.slice(0, 60);
  if (!Object.keys(args).length) throw new HttpError(400, 'Body: { on: true | false | "toggle" } and / or { style, text }');
  broadcast({ type: 'command', command: 'scene', args: { cover: args } });
  res.json({ ok: true, cover: args });
});
// POST /api/scene/toggle {id, on?: true | false | "toggle"} — room prop toggles (Stream Deck / scripts): show / hide one of the
// current room's node groups (scene.json `toggles`, glb extras `toggleGroup`; docs/SCENES.md → "Room prop toggles") on every
// page. `on` missing = flip. The host studio owns the state (and remembers the choice for the room): bus command.
sceneRoutes.post('/api/scene/toggle', (req, res) => {
  requireLocal(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (!isToggleId(b.id)) throw new HttpError(400, 'Body: { id: "<toggle id>", on?: true | false | "toggle" }');
  if (b.on !== undefined && typeof b.on !== 'boolean' && b.on !== 'toggle') throw new HttpError(400, 'on must be true, false or "toggle"');
  const toggle = { id: b.id, on: typeof b.on === 'boolean' ? b.on : 'toggle' };
  broadcast({ type: 'command', command: 'scene', args: { toggle } });
  res.json({ ok: true, toggle });
});
// POST /api/scene/stage {mode?, react?, gaming?, strip?, corner?, cam?, framing?, backdrop?, dock?: {chat?, support?}, lounge?,
// lineup?} — Stream Deck / scripts: switch mode (talk | react | gaming | any registered mode) and / or the stage presets
// (docs/SCENES.md → "Stage modes"). The host studio owns the state: a bus command, like lighting / curtain.
sceneRoutes.post('/api/scene/stage', (req, res) => {
  requireLocal(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  if (isModeId(b.mode)) args.mode = b.mode;
  const st: Record<string, unknown> = {};
  for (const k of ['react', 'gaming', 'strip', 'corner', 'cam', 'framing', 'backdrop'] as const) if (typeof b[k] === 'string' && /^[a-z-]{1,16}$/.test(b[k] as string)) st[k] = b[k];
  if (typeof b.lounge === 'boolean') st.lounge = b.lounge;
  // the chat box: {chatBox: {at?: 'auto' | 'tl' | 'tr' | 'bl' | 'br' | 'left' | 'right' | 'top' | 'bottom' | 'custom', w?, h?, x?, y?, opacity?}}
  if (b.chatBox && typeof b.chatBox === 'object') st.chatBox = Object.fromEntries(Object.entries(b.chatBox as Record<string, unknown>).filter(([k, v]) => ['at', 'w', 'h', 'x', 'y', 'opacity'].includes(k) && (typeof v === 'string' ? /^[a-z]{1,8}$/.test(v) : typeof v === 'number' && Number.isFinite(v))));
  const d = b.dock as Record<string, unknown> | undefined;
  if (d && typeof d === 'object') st.dock = Object.fromEntries(['chat', 'support'].filter((k) => typeof d[k] === 'string' && /^(auto|always|off)$/.test(d[k] as string)).map((k) => [k, d[k]]));
  if (Object.keys(st).length) args.stage = st;
  if (typeof b.lineup === 'boolean') args.lineup = b.lineup;
  if (!Object.keys(args).length) throw new HttpError(400, 'Body: { mode: "talk" | "react" | "gaming" | … } and / or { react, gaming, strip, corner, cam, framing, backdrop, dock, lounge, lineup, chatBox }');
  broadcast({ type: 'command', command: 'scene', args });
  res.json({ ok: true, ...args });
});
// POST /api/scene/area {area: "bar" | "next" | "prev"} or {sceneId: "<room>~<area>"} — Stream Deck / scripts: move the host
// (and the party) to another area of the current room (docs/SCENES.md → "Areas"). The host studio owns the state.
sceneRoutes.post('/api/scene/area', (req, res) => {
  requireLocal(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  if (typeof b.area === 'string' && (AREA_KEY.test(b.area) || b.area === 'next' || b.area === 'prev')) args.area = b.area;
  else if (isSceneId(b.sceneId)) args.sceneId = b.sceneId;
  else throw new HttpError(400, 'Body: { area: "<area key>" | "next" | "prev" } or { sceneId: "<room>~<area>" }');
  broadcast({ type: 'command', command: 'scene', args });
  res.json({ ok: true, ...args });
});
// POST /api/scene/afk {on?: true | false | "toggle", overlay?: "off"|"brb"|"soon"|"custom", text?, names?: "afk"|"always"|"off",
// pace?: "calm"|"normal"|"snappy", events?, hideHost?} — Stream Deck / scripts: the AFK cinematic mode (docs/SCENES.md →
// "AFK cinematic director"). An empty body toggles it. The host studio owns the state: a bus command, like lighting.
sceneRoutes.post('/api/scene/afk', (req, res) => {
  requireLocal(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  if (typeof b.on === 'boolean' || b.on === 'toggle') args.on = b.on;
  if (typeof b.overlay === 'string' && /^(off|brb|soon|custom)$/.test(b.overlay)) args.overlay = b.overlay;
  if (typeof b.text === 'string') args.text = cleanCrewName(b.text, AFK_TEXT_MAX);   // (by code point: a plain slice can cut an emoji in half)
  if (typeof b.names === 'string' && /^(afk|always|off)$/.test(b.names)) args.names = b.names;
  if (typeof b.pace === 'string' && /^(calm|normal|snappy)$/.test(b.pace)) args.pace = b.pace;
  for (const k of ['events', 'hideHost'] as const) if (typeof b[k] === 'boolean') args[k] = b[k];
  if (!Object.keys(args).length) {
    if (Object.keys(b).length) throw new HttpError(400, 'Body: {} (toggle) or { on: true | false | "toggle", overlay: "off"|"brb"|"soon"|"custom", text, names: "afk"|"always"|"off", pace, events, hideHost }');
    args.on = 'toggle';
  }
  broadcast({ type: 'command', command: 'scene', args: { afk: args } });
  res.json({ ok: true, afk: args });
});
obs.scene(readState());                           // seed the automation's "last mode" (it never acts on this one)
// Merged into the in-memory state at once (the next PUT merges onto it), then answered and broadcast once
// cache/scene.json is on disk, as before: a failed write (a full disk ...) is a 500, nothing is broadcast, and GET
// /api/scene goes back to the saved state (unless a newer PUT came in meanwhile: that one carries this one's change).
/** A whole scene state (an older studio's save) that is older than the saved one: it would put back an old room / chat
 *  setting (the start-up race of older studios: their defaults, rev 1, saved over the streamer's room). */
export function staleWholeState(body: Record<string, unknown>, cur: SceneState): boolean {
  if (body._diff === true || typeof body.rev !== 'number' || !Number.isFinite(body.rev)) return false;
  const whole = ['sceneId', 'mode', 'camera', 'spots', 'lights', 'moves'].every((k) => k in body);
  return whole && body.rev < cur.rev;
}
/** The saved state with a PUT body merged in (per top-level key). A hand-picked camera (camPick) belongs to the camera / mode it
 *  was made for: a studio that moves either without saying what happens to the pick (an older studio, which never sends
 *  camPick) must not leave the old stamp silencing the room's directors. */
export function mergePut(cur: SceneState, body: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...cur, ...body };
  if (('camera' in body || 'mode' in body) && !('camPick' in body)) delete merged.camPick;
  return merged;
}
sceneRoutes.put('/api/scene', async (req, res) => {
  requireLocal(req);
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const cur = readState();
  if (staleWholeState(body, cur)) {
    res.status(409).json({ error: 'This window had an old copy of your scene (another VTube Pro window changed it). Reload this window.', code: 'stale-scene', state: cur });
    return;
  }
  const s = sanitizeSceneState(mergePut(cur, body));
  s.rev = Math.max(s.rev, cur.rev + 1);
  sceneState = s;
  const gen = ++stateGen;
  const text = lastStateText = JSON.stringify(s, null, 2);
  try {
    await writeFileNow(STATE_FILE, text);
  } catch (e) {
    if (stateGen === gen) { sceneState = savedState; lastStateText = savedText; }
    throw e;
  }
  savedState = s; savedText = text;               // (writes land in PUT order; a shared write settles its PUTs in order)
  broadcast({ type: 'scene', state: s, self: HOST_KEY });
  obs.scene(s);                                   // optional OBS automation (off by default): scene switch on mode change
  res.json(s);
});
