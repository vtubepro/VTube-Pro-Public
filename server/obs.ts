// OBS automation over obs-websocket v5 (OBS 28+ built-in; Tools → WebSocket Server Settings). OFF by default:
// nothing connects until the performer enables it in the Scene tab. When on:
//   * the OBS output page reports when the react passthrough hole has fully opened / closed (POST /api/obs/hole);
//     we then place the chosen Window Capture exactly over the hole (position + "scale to inner bounds") and show
//     it, and hide it again once the hole has closed. Owner rule: never a misfit box — a capture is only shown when it
//     can match the screen (in the picture; straight-on, or warped by the corner-pin), else it stays hidden and the
//     page draws the window in the room. Leaving React puts the capture back where the performer had it;
//   * optionally the OBS program scene follows the mode (Talk scene / React scene) when the mapped scene changes.
//   * Reading OBS for the in-scene window feed (server/screenTarget.ts) needs only a saved password, not this switch.
// The password is stored ONLY in config/obs.json on this PC (never in cache/scene.json, broadcasts or responses).
//
//   GET  /api/obs          → ObsPublic (no password)            PUT /api/obs   → save (localhost only)
//   POST /api/obs/probe    → connect once + list scenes / inputs (optionally with unsaved url/password)
//   POST /api/obs/hole     → { open, rect:{x,y,w,h} (fractions of the output), quad, layout, mode, visible, v, shows } from
//                            the OBS output page (re-sent every few seconds while open, so a restarted server / failed
//                            call catches up; `shows` = what the page shows — a party guest's pages show the host's room)
//                            GET /api/obs/hole → { enabled, pin } (may the page use passthrough?)
//   POST /api/obs/place    → { rect, quad } Interview's "Fit my Window Capture → guest" (a click): the closest box /
//                            corner-pin on that close-up's monitor panel → ObsPlaceReport (how many px off)
//   POST /api/obs/test     → one safe placement cycle on the capture item: record → place → read back → restore
//   POST /api/obs/fit      → { source, rect, fit: 'fit' | 'fill' } the Scene tab's one-click "Fit my capture to the
//                            layout" (stage layouts: React presets, Gaming): sets ONLY that item's transform / crop
//                            — only when the performer clicks it; works with the automation off (needs the password)
import { Router, type Request } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import type { ObsDetect, ObsFitReport, ObsLogEntry, ObsPlaceReport, ObsProbe, ObsPublic, ObsScenes, ObsStatus, ObsSwitcher, ObsSwitcherUpdate, ObsTestReport, ObsUpdate } from '../shared/obs.ts';
import os from 'node:os';
import { outputPages } from './bus.ts';
import { originOk } from './localGuard.ts';
import type { ObsDiagnosis, ObsFinding } from '../shared/capture.ts';
import type { SceneState } from '../shared/types.ts';
import { CACHE_DIR, CONFIG_DIR } from './paths.ts';
import { boxErrorPx, containFit, EXACT_PX, holeInFrame, homography, invert3, rotatedFit, shotLabel, type Pt } from '../shared/quad.ts';
import { effectiveMap, isLanVtpUrl, lookOf, sanitizeSceneMap, type LookId } from '../shared/obsSetup.ts';

/** Owner rule: never show a misfit box. Without the corner-pin, the capture is shown only when a plain (rotated) OBS
 *  box matches the screen's corners within this (px of a 1080-high frame) — a little looser than the page's own test
 *  (shared/quad.ts EXACT_PX), so a hole the page opens is always filled. */
export const SERVER_EXACT_PX = EXACT_PX + 2;
/** A placed capture must show at least this much of itself on the OBS canvas (px of it inside the canvas, both ways):
 *  nothing is ever parked visible entirely outside the picture. A box only partly off the canvas is placed — OBS clips
 *  it at the canvas edge, exactly like the room's browser source around the hole. */
export const CANVAS_MIN_PX = 2;
/** A React hole's signature (layout + where it is): the same hole reported again (heartbeat, several OBS pages) = the
 *  same signature. */
export const holeSig = (layout: string, rect: { x: number; y: number; w: number; h: number }, quad: Pt[] | null) =>
  `1|${layout}|${[rect.x, rect.y, rect.w, rect.h, ...(quad ?? []).flat()].map((x) => x.toFixed(4)).join(',')}`;
/** Pure: does any part of this box (canvas px: a quad's corners or a rect's two corners) lie on the canvas? */
export function onCanvas(pts: Pt[], v: { baseWidth: number; baseHeight: number }): boolean {
  if (!pts.length || !pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) return false;
  const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0])), y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
  return Math.min(x1, v.baseWidth) - Math.max(x0, 0) >= CANVAS_MIN_PX && Math.min(y1, v.baseHeight) - Math.max(y0, 0) >= CANVAS_MIN_PX;
}
/** A "hole open" from an OBS page that doesn't say what it shows (pages before report v3) is taken as a LATE one (sent
 *  just before the page heard the show left React) only this soon after the mode changed here. Later it may be a party
 *  guest's page, which shows the host's room, not this PC's saved state: acted on, like before. */
export const LATE_OPEN_MS = 4000;
/** A corner-pin check (is obs-shaderfilter in OBS?) that got no answer is asked again this much later. */
export const PIN_RETRY_MS = 10_000;
/** What an OBS page shows as it reports (report v3): its mode, whether a room is up, whether that mode has a passthrough
 *  hole (stage.hole: React, Gaming …), and `party` = another PC's room — this PC is a party guest: its studio hands the
 *  host's state to its own OBS pages over the bus and never saves it here (no PUT /api/scene), so this PC's saved
 *  state is NOT what its pages show. */
export interface HoleShows { mode: string; room: boolean; hole: boolean; party: boolean }
/** The capture's transform fields that are recorded before the automation first changes it, and put back when the show
 *  leaves React (the performer's own placement — e.g. Gaming's Fit my capture). */
const KEEP = ['positionX', 'positionY', 'rotation', 'scaleX', 'scaleY', 'alignment', 'boundsType', 'boundsAlignment', 'boundsWidth', 'boundsHeight', 'cropLeft', 'cropRight', 'cropTop', 'cropBottom', 'cropToBounds'];

/** Pure: a transform read with GetSceneItemTransform → one SetSceneItemTransform accepts. obs-websocket 5 rejects the
 *  WHOLE request when a field is out of range — bounds below 1 (a capture placed by hand has no bounding box: OBS reports
 *  0 × 0), a 0 scale, a negative crop, a rotation past ±360 — so those are left out (OBS keeps what it has). */
export function restorableTransform(t: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of KEEP) {
    const v = t[k];
    if (k === 'boundsType') { if (typeof v === 'string' && /^OBS_BOUNDS_[A-Z_]+$/.test(v)) out[k] = v; }
    else if (k === 'cropToBounds') { if (typeof v === 'boolean') out[k] = v; }
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  const none = out.boundsType === undefined || out.boundsType === 'OBS_BOUNDS_NONE';
  for (const k of ['boundsWidth', 'boundsHeight']) if (none || !(Number(out[k]) >= 1 && Number(out[k]) <= 90001)) delete out[k];
  for (const k of ['scaleX', 'scaleY']) if (out[k] === 0) delete out[k];
  for (const k of ['cropLeft', 'cropRight', 'cropTop', 'cropBottom']) if (Number(out[k]) < 0) delete out[k];
  if (typeof out.rotation === 'number' && Math.abs(out.rotation) > 360) out.rotation = out.rotation % 360;
  return out;
}

/** Pure: a scene item's box on the canvas (px) from its transform (position + alignment anchor, bounds or scaled size,
 *  rotation); null = not measurable. */
export function itemBox(t: Record<string, unknown>): { x0: number; y0: number; x1: number; y1: number } | null {
  const n = (k: string) => (typeof t[k] === 'number' && Number.isFinite(t[k] as number) ? (t[k] as number) : NaN);
  const bounded = typeof t.boundsType === 'string' && t.boundsType !== 'OBS_BOUNDS_NONE' && n('boundsWidth') > 0 && n('boundsHeight') > 0;
  const w = bounded ? n('boundsWidth') : Math.abs(n('width')) || Math.abs(n('sourceWidth') * (Number.isFinite(n('scaleX')) ? n('scaleX') : 1));
  const h = bounded ? n('boundsHeight') : Math.abs(n('height')) || Math.abs(n('sourceHeight') * (Number.isFinite(n('scaleY')) ? n('scaleY') : 1));
  const px = n('positionX'), py = n('positionY');
  if (!(w > 0 && h > 0) || !Number.isFinite(px) || !Number.isFinite(py)) return null;
  const al = Number.isFinite(n('alignment')) ? n('alignment') : 5;            // OBS_ALIGN_LEFT 1 · RIGHT 2 · TOP 4 · BOTTOM 8
  const ax = al & 1 ? 0 : al & 2 ? w : w / 2, ay = al & 4 ? 0 : al & 8 ? h : h / 2;
  const r = ((Number.isFinite(n('rotation')) ? n('rotation') : 0) * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
  const pts = [[-ax, -ay], [w - ax, -ay], [w - ax, h - ay], [-ax, h - ay]].map(([x, y]) => [px + x * cs - y * sn, py + x * sn + y * cs]);
  return { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) };
}
/** Pure: is the item entirely off the canvas (nobody could see it there — e.g. parked off the picture by an older
 *  helper)? Unmeasurable = no. */
export function offCanvas(t: Record<string, unknown>, v: { baseWidth: number; baseHeight: number }): boolean {
  const b = itemBox(t);
  return !!b && (b.x1 <= 0 || b.y1 <= 0 || b.x0 >= v.baseWidth || b.y0 >= v.baseHeight);
}
/** The fields that identify one of the automation's own placements (to recognise it after a helper restart). */
const PLACED = ['positionX', 'positionY', 'rotation', 'boundsWidth', 'boundsHeight'] as const;
const placedOf = (t: Record<string, unknown>) => Object.fromEntries(PLACED.map((k) => [k, Number(t[k]) || 0])) as Record<string, number>;
/** Pure: does this transform sit exactly where one of the automation's placements put it? */
export function samePlace(t: Record<string, unknown>, p: Record<string, number> | null): boolean {
  return !!p && PLACED.every((k) => Math.abs((Number(t[k]) || 0) - (p[k] ?? 0)) <= (k === 'rotation' ? 0.1 : 1));
}

/** What the automation remembers about the capture item (cache/obs-capture.json, so a restart
 *  mid-React still knows what to put back): the performer's own placement + visibility from before the automation
 *  first changed it, whether it has changed it since, and where it last placed it. */
export interface CaptureMemo {
  source: string; scene: string; id: number;
  /** The performer's own transform (null = unknown: it already sat at an automation placement, or off the canvas —
   *  then it is only ever hidden, never "put back" there). */
  own: Record<string, unknown> | null;
  /** Shown before the automation changed it (put back in a mode with its own capture area, e.g. Gaming). */
  enabled: boolean;
  /** The automation has moved / hidden it since `own` was recorded (React, Talk's hide, an Interview fit). */
  touched: boolean;
  /** The transform the automation's last placement set. */
  placed: Record<string, number> | null;
  /** The corner-pin filter was switched on for a React placement. */
  pin?: boolean;
}
const MEMO_FILE = () => path.join(CACHE_DIR, 'obs-capture.json');
function loadMemo(): CaptureMemo | null {
  try {
    const m = JSON.parse(fs.readFileSync(MEMO_FILE(), 'utf8')) as Partial<CaptureMemo>;
    if (typeof m.source !== 'string' || typeof m.scene !== 'string' || typeof m.id !== 'number') return null;
    return { source: m.source, scene: m.scene, id: m.id, own: m.own && typeof m.own === 'object' ? m.own : null, enabled: m.enabled === true, touched: m.touched === true,
      placed: m.placed && typeof m.placed === 'object' ? m.placed : null, ...(m.pin === true ? { pin: true } : {}) };
  } catch { return null; }
}
function saveMemo(m: CaptureMemo | null) {
  try {
    if (!m) { fs.rmSync(MEMO_FILE(), { force: true }); return; }
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(MEMO_FILE(), JSON.stringify(m, null, 2));
  } catch { /* the memo is a convenience: in memory it still works */ }
}

/** Pure: should the scene switcher change OBS's program scene for this look change? Only when the new look maps to a
 *  DIFFERENT scene than the previous look (Talk and React on the same scene = nothing to do; a scene the performer picked
 *  by hand in OBS meanwhile is kept). The caller also skips it when OBS is already on that scene. */
export function sceneToSwitch(map: Partial<Record<LookId, string>>, prev: LookId | null, next: LookId | null): string | null {
  if (!next) return null;
  const name = map[next] ?? '';
  if (!name) return null;
  return prev && (map[prev] ?? '') === name ? null : name;
}

/** The optional obs-shaderfilter plugin (exeldro) — filter kind + the filter we add to the Window Capture. */
export const PIN_KIND = 'shader_filter';
export const PIN_FILTER = 'VTube Pro corner pin';
/** obs-shaderfilter "shader text": output uv (the capture's stretched box) → inverse homography → the screen's own
 *  uv → letterboxed window uv. Everything outside the screen is transparent. */
export const PIN_SHADER = `// VTube Pro — react screen corner pin (set by VTube Pro's OBS automation; do not edit the numbers)
uniform float h00; uniform float h01; uniform float h02;
uniform float h10; uniform float h11; uniform float h12;
uniform float h20; uniform float h21; uniform float h22;
uniform float fit_sx; uniform float fit_sy; uniform float fit_ox; uniform float fit_oy;
float4 mainImage(VertData v_in) : TARGET
{
    float2 p = v_in.uv;
    float w = h20 * p.x + h21 * p.y + h22;
    float2 s = float2(h00 * p.x + h01 * p.y + h02, h10 * p.x + h11 * p.y + h12) / w;
    if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) return float4(0.0, 0.0, 0.0, 0.0);
    float2 c = (s - float2(fit_ox, fit_oy)) / float2(fit_sx, fit_sy);
    if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0) return float4(0.0, 0.0, 0.0, 1.0);
    return image.Sample(textureSampler, c);
}
`;
import { requireLocal, requireLocalOrStreamPc } from './routes/util.ts';
import { streamPcOf } from './streamPcMark.ts';
/** What a stream PC's output page hears about the React hole: no OBS passthrough from there (display-only). */
const STREAM_PC_NO_HOLE = 'On a stream PC the React screen is drawn in the room.';
import { broadcast } from './bus.ts';
import { isLightingState } from '../shared/lightShow.ts';

const FILE = path.join(CONFIG_DIR, 'obs.json');

interface ObsConfig extends Omit<ObsPublic, 'hasPassword' | 'status' | 'canRead'> {
  password: string;
  /** OBS's WebSocket server asks for no password (found by "Find it for me", or a connection without one worked):
   *  VTube Pro may read OBS (the in-scene feed) with no password saved. Server-only, never set by a page. */
  authOff?: boolean;
}
const DEFAULTS: ObsConfig = { enabled: false, url: 'ws://127.0.0.1:4455', password: '', captureSource: '', browserSource: '', sceneName: '', switchScenes: false, talkScene: '', reactScene: '', lightingMap: {}, cornerPin: false, sceneMap: {}, recordReminder: false, reviewed: false };

const str = (v: unknown, max = 256) => (typeof v === 'string' ? v.slice(0, max) : undefined);
function sanitize(o: Partial<ObsConfig>, base: ObsConfig): ObsConfig {
  const url = str(o.url, 200);
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : base.enabled,
    url: url && /^wss?:\/\/[\w.\-[\]:]+(\/[\w\-./]*)?$/.test(url) ? url : base.url,
    password: str(o.password, 256) ?? base.password,
    captureSource: str(o.captureSource) ?? base.captureSource,
    browserSource: str(o.browserSource) ?? base.browserSource,
    sceneName: str(o.sceneName) ?? base.sceneName,
    switchScenes: typeof o.switchScenes === 'boolean' ? o.switchScenes : base.switchScenes,
    talkScene: str(o.talkScene) ?? base.talkScene,
    reactScene: str(o.reactScene) ?? base.reactScene,
    lightingMap: o.lightingMap && typeof o.lightingMap === 'object' ? lightingMap(o.lightingMap) : base.lightingMap,
    cornerPin: typeof o.cornerPin === 'boolean' ? o.cornerPin : base.cornerPin ?? false,
    // "Set up OBS" wizard (lane obs-wizard): look -> OBS scene, recording reminders (off by default), wizard step 6 seen
    sceneMap: o.sceneMap !== undefined ? sanitizeSceneMap(o.sceneMap) : base.sceneMap ?? {},
    recordReminder: typeof o.recordReminder === 'boolean' ? o.recordReminder : base.recordReminder ?? false,
    reviewed: typeof o.reviewed === 'boolean' ? o.reviewed : base.reviewed ?? false,
    authOff: typeof o.authOff === 'boolean' ? o.authOff : base.authOff ?? false,
  };
}
function lightingMap(o: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o).slice(0, 32)) if (k && k.length <= 256 && isLightingState(v)) out[k] = v;
  return out;
}
function load(): ObsConfig {
  try { return sanitize(JSON.parse(fs.readFileSync(FILE, 'utf8')), DEFAULTS); } catch { return { ...DEFAULTS }; }
}
function save(c: ObsConfig) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------- obs-websocket v5 client
type Pending = { resolve: (d: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class ObsClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  version: string | null = null;
  /** OBS asked for a password at the last Hello (null = not connected yet). */
  authRequired: boolean | null = null;
  get open() { return this.ws?.readyState === WebSocket.OPEN && this.identified; }
  private identified = false;

  /** Connect + authenticate (Hello → Identify → Identified). */
  /** Events (op 5), when connected with eventSubscriptions. */
  onEvent: ((type: string, data: Record<string, unknown>) => void) | null = null;
  onClose: (() => void) | null = null;

  connect(url: string, password: string, timeoutMs = 4000, eventSubscriptions = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      let done = false;
      const fail = (e: Error) => { if (done) return; done = true; clearTimeout(t); try { ws.close(); } catch { /* */ } reject(e); };
      const t = setTimeout(() => fail(new Error('OBS did not answer (is OBS running with the WebSocket server on?)')), timeoutMs);
      const ws = new WebSocket(url, 'obswebsocket.json', { handshakeTimeout: timeoutMs });
      this.ws = ws;
      ws.on('error', (e) => fail(new Error(`OBS connection failed: ${(e as Error).message}`)));
      ws.on('close', (code, reason) => {
        this.identified = false;
        this.onClose?.();
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('OBS connection closed')); }
        this.pending.clear();
        if (!done) fail(new Error(code === 4009 ? 'OBS rejected the password' : `OBS closed the connection (${code} ${reason.toString()})`));
      });
      ws.on('message', (raw) => {
        let m: { op: number; d: Record<string, unknown> };
        try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.op === 0) {                                              // Hello
          const auth = m.d.authentication as { challenge: string; salt: string } | undefined;
          const d: Record<string, unknown> = { rpcVersion: 1, eventSubscriptions };
          this.authRequired = !!auth;
          if (auth) {
            if (!password) return fail(new Error('OBS wants a password (set it in the Scene tab)'));
            const secret = crypto.createHash('sha256').update(password + auth.salt).digest('base64');
            d.authentication = crypto.createHash('sha256').update(secret + auth.challenge).digest('base64');
          }
          this.version = typeof m.d.obsWebSocketVersion === 'string' ? m.d.obsWebSocketVersion : null;
          ws.send(JSON.stringify({ op: 1, d }));
        } else if (m.op === 2) {                                       // Identified
          this.identified = true;
          if (!done) { done = true; clearTimeout(t); resolve(); }
        } else if (m.op === 5) {                                       // Event
          try { this.onEvent?.(String(m.d.eventType), (m.d.eventData as Record<string, unknown>) ?? {}); } catch { /* listener */ }
        } else if (m.op === 7) {                                       // RequestResponse
          const id = String(m.d.requestId), p = this.pending.get(id);
          if (!p) return;
          this.pending.delete(id); clearTimeout(p.timer);
          const st = m.d.requestStatus as { result: boolean; code: number; comment?: string };
          if (st?.result) p.resolve((m.d.responseData as Record<string, unknown>) ?? {});
          else p.reject(new Error(`${String(m.d.requestType)}: ${st?.comment ?? `error ${st?.code}`}`));
        }
      });
    });
  }

  request<T = Record<string, unknown>>(requestType: string, requestData?: Record<string, unknown>, timeoutMs = 3000): Promise<T> {
    if (!this.open) return Promise.reject(new Error('OBS not connected'));
    const requestId = `vtp${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`${requestType}: timed out`)); }, timeoutMs);
      this.pending.set(requestId, { resolve: resolve as (d: Record<string, unknown>) => void, reject, timer });
      this.ws!.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }

  close() { try { this.ws?.close(); } catch { /* */ } this.ws = null; this.identified = false; }
}

// ---------------------------------------------------------------- plain-words fixes + OBS's own settings file
/** One sentence that tells the user what to do about an OBS connection error. */
export function obsFix(msg: string, hasPassword: boolean): string {
  if (/password|4009|auth/i.test(msg)) return hasPassword
    ? 'OBS didn’t accept the password: open VTube Pro’s OBS page and press “Find it for me” (or paste it from OBS → Tools → WebSocket Server Settings → Show Connect Info).'
    : 'OBS needs its WebSocket password: open VTube Pro’s OBS page and press “Find it for me”.';
  if (/ECONNREFUSED|did not answer|connection failed|closed the connection|timed out/i.test(msg)) return 'Start OBS, then in OBS: Tools → WebSocket Server Settings → tick “Enable WebSocket server” (port 4455).';
  return 'Open OBS, then try again. Still stuck? Open VTube Pro’s OBS page.';
}

/** OBS's obs-websocket settings file (OBS 28+): %APPDATA%\obs-studio\plugin_config\obs-websocket\config.json,
 *  ~/Library/Application Support/obs-studio/…, ~/.config/obs-studio/… (Flatpak: ~/.var/app/com.obsproject.Studio/config/
 *  obs-studio/…). Override for tests: VTP_OBS_CONFIG_DIR (the obs-studio folder). */
export function obsWebsocketConfigFile(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  const tail = path.join('plugin_config', 'obs-websocket', 'config.json');
  if (env.VTP_OBS_CONFIG_DIR) return path.join(env.VTP_OBS_CONFIG_DIR, tail);
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'obs-studio', tail);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'obs-studio', tail);
  const xdg = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'obs-studio', tail);
  const flat = path.join(home, '.var', 'app', 'com.obsproject.Studio', 'config', 'obs-studio', tail);
  return !fs.existsSync(xdg) && fs.existsSync(flat) ? flat : xdg;
}

/** OBS's remote-control settings on this computer. obs-websocket 5.5+ keeps them in plugin_config/obs-websocket/
 *  config.json (server_enabled, server_port, auth_required, server_password); older builds (OBS 28 - 30) kept them in
 *  the [OBSWebSocket] section of global.ini (ServerEnabled, ServerPort, AuthRequired, ServerPassword), read as a
 *  fallback. Source: obs-websocket src/Config.cpp (MigrateGlobalConfigData). */
export function readObsRemoteSettings(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()):
  { found: boolean; enabled: boolean; port: number; auth: boolean; password: string; from: 'config.json' | 'global.ini' | null } {
  const file = obsWebsocketConfigFile(env, platform, home);
  const okPort = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 65536 ? v : 4455);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    return { found: true, enabled: raw.server_enabled === true, port: okPort(raw.server_port), auth: raw.auth_required !== false,
      password: typeof raw.server_password === 'string' ? raw.server_password.slice(0, 256) : '', from: 'config.json' };
  } catch { /* try the older place */ }
  const dir = path.dirname(path.dirname(path.dirname(file)));       // …/obs-studio
  for (const ini of ['global.ini', 'user.ini']) {
    let text: string;
    try { text = fs.readFileSync(path.join(dir, ini), 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    const at = lines.findIndex((l) => l.trim() === '[OBSWebSocket]');
    if (at < 0) continue;
    const kv = new Map<string, string>();
    for (const l of lines.slice(at + 1)) {
      if (/^\s*\[/.test(l)) break;
      const m = /^([^=]+)=(.*)$/.exec(l);
      if (m) kv.set(m[1].trim(), m[2].trim());
    }
    return { found: true, enabled: kv.get('ServerEnabled') === 'true', port: okPort(Number(kv.get('ServerPort'))), auth: kv.get('AuthRequired') !== 'false',
      password: (kv.get('ServerPassword') ?? '').slice(0, 256), from: 'global.ini' };
  }
  return { found: false, enabled: false, port: 4455, auth: true, password: '', from: null };
}

/** Is OBS on this computer? Its program (usual install folders, Steam) or its settings folder (it has been opened).
 *  Never runs anything. Tests: VTP_OBS_INSTALL_PATHS (paths joined by the OS separator) replaces the program list. */
export function obsInstalled(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): { found: boolean; settings: boolean } {
  const cfg = path.dirname(path.dirname(path.dirname(obsWebsocketConfigFile(env, platform, home))));
  const settings = fs.existsSync(cfg);
  let progs: string[];
  if (env.VTP_OBS_INSTALL_PATHS !== undefined) progs = env.VTP_OBS_INSTALL_PATHS.split(path.delimiter).filter(Boolean);
  else if (platform === 'win32') {
    const pf = [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)'], 'C:\\Program Files'].filter((x): x is string => !!x);
    progs = [...pf.map((p) => path.join(p, 'obs-studio', 'bin', '64bit', 'obs64.exe')),
      ...pf.map((p) => path.join(p, 'Steam', 'steamapps', 'common', 'OBS Studio', 'bin', '64bit', 'obs64.exe'))];
  } else if (platform === 'darwin') progs = ['/Applications/OBS.app', path.join(home, 'Applications', 'OBS.app')];
  else progs = ['/usr/bin/obs', '/usr/local/bin/obs', '/snap/bin/obs-studio', '/var/lib/flatpak/app/com.obsproject.Studio', path.join(home, '.local', 'share', 'flatpak', 'app', 'com.obsproject.Studio')];
  return { found: settings || progs.some((p) => { try { return fs.existsSync(p); } catch { return false; } }), settings };
}

// ---------------------------------------------------------------- automation
/** (exported for tests: a second instance = the helper after a restart; the app uses `obs` below) */
export class ObsAutomation {
  cfg = load();
  private client: ObsClient | null = null;
  private key = '';
  private chain: Promise<unknown> = Promise.resolve();
  private lastHole = '';
  private lastMode: string | null = null;
  private hideTimer: NodeJS.Timeout | null = null;
  status: ObsPublic['status'] = { connected: false, error: null, version: null, lastAction: null, at: null };
  private logs: ObsLogEntry[] = [];
  private reports = 0;
  private lastQuad: Pt[] | null = null;
  /** This PC's scene state as last saved (PUT /api/scene: why nothing happens — mode, screen content setting). */
  private info = { sceneId: '', mode: '', screen: 'auto', layout: 'auto', hole: false };
  /** A party guest's PC: what its OBS pages say they show (the HOST's room; report v3 `shows`). null = they show this
   *  PC's own saved state (`info`). Cleared by an own-state report and by a PUT /api/scene (only a host / solo studio
   *  saves its state: a guest's studio never does). */
  private partyView: { sceneId: string; mode: string; hole: boolean } | null = null;
  /** The scene the OBS pages show: the host's room on a party guest's PC, else this PC's saved state. */
  private get shown(): { sceneId: string; mode: string; hole: boolean } { return this.partyView ?? this.info; }
  /** The mode the pages show, as settle() names it ('classic' without a room). */
  private modeNow() { const s = this.shown; return s.sceneId ? s.mode || 'talk' : 'classic'; }
  /** When the mode last changed here (PUT /api/scene): an older page's late "open" (LATE_OPEN_MS). */
  private modeAt = 0;
  /** Told the mode (as settle() names it) whenever the saved scene state changes it (server/obsGaming.ts watches Gaming / React). */
  readonly modeListeners: ((mode: string) => void)[] = [];
  /** The mode Interview's "Fit my Window Capture" (an explicit click) placed the capture in: settle() leaves it there
   *  until the mode changes (the safety net / a late React close used to hide it right after the click). */
  private fitMode: string | null = null;
  private note(level: ObsLogEntry['level'], msg: string) {
    this.logs.push({ at: new Date().toISOString(), level, msg: msg.slice(0, 300) });
    if (this.logs.length > 40) this.logs.splice(0, this.logs.length - 40);
  }

  view(): ObsPublic {
    const { password, authOff: _authOff, ...rest } = this.cfg;
    this.audit();                                                       // (the Scene tab polls this: setup warnings stay fresh)
    return { ...rest, hasPassword: !!password, canRead: this.canRead(), status: { ...this.status, connected: !!this.client?.open, hint: this.hint(), reports: this.reports }, log: [...this.logs] };
  }

  /** The OBS setup warnings (status.warnings: a whole-monitor Display Capture, a browser source pointed at OBS's
   *  WebSocket address, the capture above the browser source …) also when nothing is placed. Auto with a working feed
   *  never places the capture, so place() alone would never say it. Read-only (Get* requests on the shared read
   *  connection), at most once a minute: while the Scene tab is open, and when React starts. */
  audit(force = false) {
    if (!this.canRead() || !this.cfg.captureSource || this.auditing) return;
    const now = Date.now();
    if (!force && now - this.auditAt < 60_000) return;
    this.auditAt = now; this.auditing = true;
    void this.readOnly(async (c) => {
      const scene = await this.targetScene(c);
      const v = await c.request<{ baseWidth: number; baseHeight: number }>('GetVideoSettings');
      await this.checkSetup(c, scene, v);
    }).catch(() => { /* OBS not reachable: the next look tries again */ }).finally(() => { this.auditing = false; });
  }
  private auditAt = 0;
  private auditing = false;

  /** Why the automation isn't doing anything right now (null = nothing to explain). */
  private hint(): string | null {
    const c = this.cfg;
    if (!c.enabled) return null;
    if (!c.captureSource) return 'No capture source set — type the OBS source to show in the react screen (e.g. your Window / Display Capture).';
    const s = this.shown;
    if (!s.sceneId) return 'No 3D scene is active (Classic layout): there is no react screen to pass through.';
    if (this.info.screen === 'inscene') return `React screen is In-scene capture: the window is drawn ON the 3D screen (Fast window feed — it follows “${c.captureSource}” — or a window shared from the studio), so OBS doesn’t need to place “${c.captureSource}”. Pick OBS passthrough only if you want OBS to composite it under a hole.`;
    if (s.mode !== 'react' && s.hole) return `${s.mode[0]?.toUpperCase() ?? ''}${s.mode.slice(1)} mode: the automation only puts your capture back where you placed it (and shows it again if it was showing) — Scene tab → *Fit my capture to the layout* sets that place, when you click it.`;
    const autoNote = ' Auto: OBS places the capture whenever the screen faces the camera straight on (or with the corner-pin); a screen at an angle, or with glass sheen / scanlines, is drawn ON the 3D screen with the fast window feed.';
    if (s.mode !== 'react') return `Waiting for React mode (now: ${s.mode || 'talk'}) — the capture is placed when the screen's hole has opened.${this.info.screen === 'auto' ? autoNote : ''}`;
    // what an OBS page says its React screen shows (GET /api/obs/hole, every 5 s in React): why there's no capture
    const p = this.page && Date.now() - this.page.at < 15_000 ? this.page : null;
    if (p && !p.stage && !p.inShot && p.shows !== 'hole') return 'The React screen isn’t in the camera’s shot (a close-up?), so the capture stays hidden. Live → Camera → Auto or Screen shows it.';
    if (p && !p.stage && p.inShot && !p.exact && p.shows === 'nosignal')
      return `The React screen is seen at a slight angle in this shot${p.err !== null ? ` (an OBS box would be up to ${Math.round(p.err)} px off its corners)` : ''}, so VTube Pro doesn’t put “${c.captureSource}” over it — no crooked box. It draws your window on the screen in the room instead, but has no picture for it (NO SIGNAL): turn on the fast window feed (needs ffmpeg) or share a window in the studio (Show → React screen → Pick a window). For OBS passthrough on an angled screen: the free obs-shaderfilter plugin + Perspective corner-pin.`;
    if (!this.reports) return `React is on but no OBS output page has reported a hole yet — is the OBS browser source showing http://127.0.0.1:5191/output.html?${this.info.screen === 'auto' ? `${autoNote} So no hole is normal.` : ''}`;
    if (this.lastHole.startsWith('x|')) return 'The React screen isn’t in the camera’s shot (a close-up?), so the capture stays hidden. Live → Camera → Auto or Screen shows it.';
    return null;
  }

  update(u: ObsUpdate, authOff?: boolean) {
    const prev = this.cfg;
    const { authOff: _fromPage, ...uu } = u as ObsUpdate & { authOff?: unknown };   // (server-only: never from a page)
    const next = sanitize({ ...uu, password: uu.clearPassword ? '' : uu.password || undefined } as Partial<ObsConfig>, this.cfg);
    // a new address / password: whether OBS needs a password is unknown again (detect() says it, or the next read)
    if (authOff !== undefined) next.authOff = authOff;
    else if (uu.password || uu.clearPassword || next.url !== prev.url) next.authOff = false;
    this.cfg = next;
    save(next);
    this.drop();                                                        // reconnect with the new settings on next use
    void this.watch();
    if (!next.enabled) this.status = { ...this.status, connected: false, error: null };
    // another capture source / the automation switched on: re-place on the next report (the memo of the capture's own
    // placement is kept per source + item — cache/obs-capture.json — so switching back still knows what to put back)
    if (next.captureSource !== prev.captureSource || next.enabled !== prev.enabled) { this.lastHole = ''; this.refused = null; }
    if (next.cornerPin !== prev.cornerPin || next.url !== prev.url || next.password !== prev.password) { this.pinKind = null; this.pinAsked = 0; }
    if (next.captureSource !== prev.captureSource || next.url !== prev.url || next.password !== prev.password || next.sceneName !== prev.sceneName) { this.auditAt = 0; this.wsSources = null; this.status.warnings = []; }
  }

  /** The in-scene window feed may read OBS (which window the capture source shows): a password is saved, OBS needs none,
   *  or the automation is on. Independent of "Automate OBS", which only moves the capture (passthrough) + switches scenes. */
  canRead() { return this.cfg.enabled || !!this.cfg.password || !!this.cfg.authOff; }

  /** For the OBS output pages (GET /api/obs/hole): will a passthrough capture be warped onto the screen's exact corners
   *  (Perspective corner-pin on + the obs-shaderfilter plugin found in OBS)? null = NOT KNOWN YET (right after a helper
   *  restart or a changed address / password: OBS is asked in the background) — the page keeps what it had and asks
   *  again soon. (It used to answer false meanwhile: a corner-pin user mid-React on an angled screen lost the capture
   *  for up to 5 s — hole closed, screen drawn in the room — then got it back.) */
  pinReady(): boolean | null {
    if (!this.cfg.enabled || !this.cfg.cornerPin || !this.cfg.captureSource) return false;
    if (this.pinKind === null) void this.askPin();
    return this.pinKind;
  }
  /** Is OBS answering (the automation connection is open, or opens within `ms`)? GET /api/obs/hole `native`: Auto uses
   *  the native passthrough only then — with OBS closed or a wrong password it would be an empty see-through hole. */
  async reachable(ms = 1500): Promise<boolean> {
    if (!this.cfg.enabled || !this.cfg.captureSource) return false;
    if (this.client?.open && this.key === `${this.cfg.url}|${this.cfg.password}`) return true;
    if (Date.now() - this.reachAsked < PIN_RETRY_MS) return false;
    this.reachAsked = Date.now();
    const p = this.chain.then(async () => { try { await this.conn(); return true; } catch { return false; } });
    this.chain = p.then(() => {});
    let t: NodeJS.Timeout | undefined;
    const ok = await Promise.race([p, new Promise<boolean>((r) => { t = setTimeout(() => r(false), ms); })]);
    if (t) clearTimeout(t);
    return ok;
  }
  private reachAsked = 0;
  private pinAsked = 0;
  private pinCheck: Promise<void> | null = null;
  /** Ask OBS once whether obs-shaderfilter is installed (a failed ask is tried again PIN_RETRY_MS later). */
  private askPin(): Promise<void> {
    if (this.pinCheck) return this.pinCheck;
    if (Date.now() - this.pinAsked < PIN_RETRY_MS) return Promise.resolve();
    this.pinAsked = Date.now();
    const p = this.chain.then(async () => { try { await this.hasPin(await this.conn()); } catch { /* OBS not reachable: ask again later */ } });
    this.chain = p;
    const done = p.finally(() => { if (this.pinCheck === done) this.pinCheck = null; });
    this.pinCheck = done;
    return done;
  }
  /** pinReady(), but when it isn't known yet: wait (≤ `ms`) for OBS's answer — GET /api/obs/hole answers once the check
   *  is done instead of a guess. Still null after that = OBS is slow / unreachable (the page keeps its choice). */
  async pinAnswer(ms = 1500): Promise<boolean | null> {
    const now = this.pinReady();
    if (now !== null) return now;
    const check = this.pinCheck;
    if (check) {
      let t: NodeJS.Timeout | undefined;
      await Promise.race([check, new Promise<void>((r) => { t = setTimeout(r, ms); })]);
      if (t) clearTimeout(t);
    }
    return this.cfg.enabled && this.cfg.cornerPin && this.cfg.captureSource ? this.pinKind : false;
  }

  /** What an OBS page says its React screen shows, and why (GET /api/obs/hole's query, every 5 s while React shows):
   *  hint() says in plain words why no capture is placed — the screen out of the shot, or seen at a slight angle with no
   *  picture for it (NO SIGNAL). Pages before this send nothing (no hint). */
  pageSaw(q: Record<string, unknown>) {
    const shows = typeof q.shows === 'string' && /^(hole|video|window|feed|standby|nosignal)$/.test(q.shows) ? q.shows : null;
    if (!shows) return;
    const e = typeof q.err === 'string' && q.err !== '' ? Number(q.err) : NaN;
    this.page = { shows, stage: q.stage === '1', inShot: q.shot === '1', exact: q.exact === '1', err: Number.isFinite(e) ? Math.min(9999, Math.max(0, e)) : null, at: Date.now() };
  }
  private page: { shows: string; stage: boolean; inShot: boolean; exact: boolean; err: number | null; at: number } | null = null;

  private drop() { this.client?.close(); this.client = null; this.key = ''; this.dropReader(); this.lastRead = null; }

  // ---- OBS scene → lighting state (optional): a separate event-only connection, kept only while a mapping exists
  private watcher: ObsClient | null = null;
  private watchKey = '';
  private watching = false;
  private watchTimer = setInterval(() => void this.watch(), 5000);
  private async watch() {
    const map = this.cfg.lightingMap ?? {};
    const want = this.cfg.enabled && Object.keys(map).length > 0;
    const k = `${this.cfg.url}|${this.cfg.password}`;
    if (!want || (this.watcher && this.watchKey !== k)) { this.watcher?.close(); this.watcher = null; }
    if (!want || this.watcher?.open || this.watching) return;
    this.watching = true;
    const c = new ObsClient();
    c.onEvent = (type, data) => {
      if (type !== 'CurrentProgramSceneChanged') return;
      const scene = String(data.sceneName ?? '');
      const st = this.cfg.lightingMap?.[scene];
      if (!st) return;
      broadcast({ type: 'command', command: 'scene', args: { lighting: st } });   // the host studio switches + saves
      this.status = { ...this.status, lastAction: `OBS scene "${scene}" → lighting ${st}`, at: new Date().toISOString() };
    };
    c.onClose = () => { if (this.watcher === c) this.watcher = null; };
    try { await c.connect(this.cfg.url, this.cfg.password, 4000, 1 << 2 /* Scenes */); this.watcher = c; this.watchKey = k; }
    catch (e) { this.status = { ...this.status, error: `lighting follow: ${(e as Error).message}` }; }
    finally { this.watching = false; }
  }
  /** Tests / shutdown. */
  stopWatch() { clearInterval(this.watchTimer); this.watcher?.close(); this.watcher = null; }

  private async conn(): Promise<ObsClient> {
    const k = `${this.cfg.url}|${this.cfg.password}`;
    if (this.client?.open && this.key === k) return this.client;
    this.drop();
    const c = new ObsClient();
    // OBS went away (restarted, crashed, the connection dropped) while a React capture was placed: what OBS shows now
    // may not be what was placed — the pages' next report (≤ 5 s) places it again instead of being skipped as "already
    // done" (the same hole signature)
    c.onClose = () => { if (this.client === c && this.lastHole.startsWith('1|')) this.lastHole = ''; };
    await c.connect(this.cfg.url, this.cfg.password);
    this.client = c; this.key = k;
    this.status.version = c.version;
    return c;
  }

  /** Serialise actions; record the outcome for the Scene tab. `fn` may return a better label for the log (what it
   *  really did). `retries`: a hide / put-back that fails is tried again 3 s later (no page re-sends a close — a
   *  dropped one used to leave the capture up), unless a new React hole opened meanwhile. `failed`: called when it
   *  fails (OBS not reachable, a request OBS refused …). */
  private run(label: string, fn: (c: ObsClient) => Promise<void | string>, retries = 0, failed?: (e: Error) => void) {
    if (!this.cfg.enabled) return;
    this.chain = this.chain.then(async () => {
      try {
        const said = await fn(await this.conn());
        const l = typeof said === 'string' ? said : label;
        this.status = { ...this.status, connected: true, error: null, lastAction: l, at: new Date().toISOString() };
        this.note('ok', `${l}${this.status.placed && l.startsWith('capture →') ? ` — ${this.status.placed}` : ''}`);
      } catch (e) {
        this.status = { ...this.status, connected: !!this.client?.open, error: (e as Error).message, lastAction: `${label} (failed)`, at: new Date().toISOString() };
        this.note('err', `${label} failed: ${(e as Error).message}`);
        try { failed?.(e as Error); } catch { /* */ }
        const was = this.lastHole;
        this.lastHole = '';                                              // the page's next report (≤ 5 s) retries an open
        if (!this.client?.open) this.drop();
        if (retries > 0) {
          const t = setTimeout(() => { if (!this.lastHole.startsWith('1|')) { if (this.lastHole === '') this.lastHole = was; this.run(label, fn, retries - 1); } }, 3000);
          t.unref?.();
        }
      }
    });
  }

  private async targetScene(c: ObsClient) {
    if (this.cfg.sceneName) return this.cfg.sceneName;
    if (this.cfg.switchScenes && this.cfg.reactScene) return this.cfg.reactScene;
    const r = await c.request<{ currentProgramSceneName?: string; sceneName?: string }>('GetCurrentProgramScene');
    return r.currentProgramSceneName ?? r.sceneName ?? '';
  }
  private async itemId(c: ObsClient, sceneName: string, sourceName: string) {
    const r = await c.request<{ sceneItemId: number }>('GetSceneItemId', { sceneName, sourceName });
    return r.sceneItemId;
  }

  /** The OBS output page says the hole finished opening (rect = fractions of the output frame) / closed.
   *  `visible` false = the page itself says the screen isn't in the shot; `v` = the page's report version (2+: a close
   *  carries the mode its hole was OPENED in, so a non-React close is never the React hole's). `shows` (v3+): what the
   *  page shows right now — on a party guest's PC that is the host's room, used instead of this PC's saved state. */
  hole(open: boolean, rect: { x: number; y: number; w: number; h: number } | null, layout: string, quad: Pt[] | null = null, mode = 'react', visible?: boolean, v = 1, shows: HoleShows | null = null) {
    this.reports++;
    if (shows) this.partyView = shows.party ? { sceneId: shows.room ? 'party' : '', mode: shows.mode, hole: shows.hole } : null;
    const reactUp = this.lastHole.startsWith('1|');
    if (mode !== 'react') {
      // other modes' holes (Gaming …): never moved automatically — the Scene tab's *Fit my capture* does it on a click
      if (open && rect) this.lastStage = { rect, mode };
      // …but a close is always safe to act on: an older OBS page tags the React hole's close with the NEW mode
      // (React → Gaming), which used to be dropped here and left the capture up at the React spot
      if (open || !reactUp || v >= 2) return;
    }
    if (!this.cfg.enabled) return;
    // a late "open" (sent just before the page heard the show left React): never place a capture outside React. Only
    // where this PC's saved state is what the pages show — never on a party guest's PC, whose pages show the host's room
    // (its saved state is its own, often Talk: every React open of the host's was dropped, an empty see-through screen);
    // a page that doesn't say what it shows (before v3): only right after the mode changed here
    const s = this.shown;
    if (open && !this.partyView && s.sceneId && s.mode && s.mode !== 'react' && (shows || Date.now() - this.modeAt < LATE_OPEN_MS)) return;
    // (every React hole a page says is open and that OBS automation will NOT fill — nothing to place, a screen it won't
    // show, a placement OBS definitely failed — is answered as refused: that page draws the screen in the room instead)
    if (!open) this.openHole = '';
    // no capture source set: nothing to place, and NOT a refusal (answering one made every React entry flip
    // standby -> hole -> NO SIGNAL; the in-room feed and the Scene tab's own notice cover this case)
    if (!this.cfg.captureSource) return;
    if (open && rect) {
      // never place (or show) a capture for a screen the camera can't see: hide it, say why (no clamping)
      const why = visible === false ? 'outside' : holeInFrame(rect, quad);
      if (why !== 'ok') {
        const sig = `x|${layout}|${why}`;
        if (sig === this.lastHole) return;
        this.lastHole = sig;
        this.openHole = sig; this.refused = { sig, why: `the React screen is ${shotLabel(why)} with this camera` };
        this.status.fit = `not shown: the React screen is ${shotLabel(why)} with this camera`;
        this.note('warn', `OBS page: the ${layout} React screen is ${shotLabel(why)} (${(rect.x * 100).toFixed(1)}%, ${(rect.y * 100).toFixed(1)}% · ${(rect.w * 100).toFixed(1)}×${(rect.h * 100).toFixed(1)}%) — capture kept hidden. Camera → Auto or Screen shows it.`);
        this.run('capture hidden (React screen not in the shot)', (c) => this.settle(c), 3);
        return;
      }
    }
    const sig = open && rect ? holeSig(layout, rect, quad) : '0';
    if (sig === this.lastHole) return;                                  // several OBS pages / the heartbeat report the same thing
    const wasHidden = this.lastHole.startsWith('x|');
    this.lastHole = sig;
    // a new placement for this hole starts: what was answered for it before (the same signature re-opened after the
    // performer fixed OBS) is not known any more until it finishes — no stale "refused"
    if (open && rect) { this.openHole = sig; this.refused = null; }
    if (open && quad) this.lastQuad = quad;
    // (a close does NOT cancel the safety net: settle() below and the net both put the capture right for the mode)
    if (open && this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    // already hidden when the screen left the shot, still in React: nothing to do
    if (!open && wasHidden && s.mode === 'react' && !!s.sceneId) return;
    this.note('info', open && rect ? `OBS page: ${layout} screen hole open at ${(rect.x * 100).toFixed(1)}%, ${(rect.y * 100).toFixed(1)}% · ${(rect.w * 100).toFixed(1)}×${(rect.h * 100).toFixed(1)}% of the frame` : 'OBS page: hole closed');
    if (open && rect) this.run(`capture → ${layout} screen`, async (c) => {
      const said = await this.place(c, rect, quad);
      // (not shown: the page that opened this hole hears why — POST / GET /api/obs/hole `refused` — and draws the screen
      // in the room instead of keeping an empty see-through hole)
      this.refused = this.refusal ? { sig, why: this.refusal } : null;
      return said;
    }, 0, (e) => {
      // OBS failed the placement (the capture source isn't in the scene, OBS closed / not answering …): nothing is shown
      // in this hole either. (A page that doesn't hear it — older — still retries with its 5 s report.)
      // A passing hiccup (OBS slow / restarting / connection dropped) is NOT a refusal: one timeout used to cost the
      // whole React stretch. The page's 5 s report retries those.
      const passing = /ECONNREFUSED|did not answer|connection failed|closed the connection|timed out|timeout/i.test(e.message);
      if (!passing && this.openHole === sig) this.refused = { sig, why: `OBS couldn’t show the capture there (${e.message.slice(0, 140)})` };
    });
    else this.run('capture hidden', (c) => this.settle(c), 3);
  }

  /** Why the last placement refused to show the capture (place()'s notShown), null = it was placed. */
  private refusal: string | null = null;
  /** The React hole (its signature) OBS automation will NOT show a capture for, and why. */
  private refused: { sig: string; why: string } | null = null;
  /** The React hole the OBS pages last said is open ('' = none): its signature. Unlike lastHole (what was last APPLIED —
   *  cleared when a placement fails, so the page's next report retries it) it stays while that hole is open. */
  private openHole = '';
  /** The open React hole's verdict: why OBS automation won't show a capture there (the page then draws the screen in the
   *  room), null = it is shown / being placed / no hole open. */
  refusedNow(): string | null { return this.refused && this.openHole && this.refused.sig === this.openHole ? this.refused.why : null; }
  /** refusedNow() once OBS has had its turn (≤ `ms`): POST /api/obs/hole answers an "open" with the outcome. */
  async holeVerdict(ms = 2500): Promise<string | null> {
    let t: NodeJS.Timeout | undefined;
    await Promise.race([this.chain.then(() => undefined, () => undefined), new Promise<void>((r) => { t = setTimeout(r, ms); })]);
    if (t) clearTimeout(t);
    return this.refusedNow();
  }

  /** obs-shaderfilter (the corner-pin's filter kind) in OBS: true / false = OBS said so, null = not asked yet or the ask
   *  failed (a busy OBS is NOT "no plugin" — that used to stick until the settings changed). */
  private pinKind: boolean | null = null;
  private async hasPin(c: ObsClient): Promise<boolean | null> {
    if (this.pinKind === null) {
      try { this.pinKind = ((await c.request<{ sourceFilterKinds: string[] }>('GetSourceFilterKindList')).sourceFilterKinds ?? []).includes(PIN_KIND); }
      catch { /* unknown: asked again (pinReady / the next placement) */ }
    }
    return this.pinKind;
  }

  /** `explicit`: a performer's click (Interview → Fit my Window Capture) — placed even when a plain box can't match an
   *  angled screen exactly (the closest box, the error said in status.fit); a React hole never is. */
  private async place(c: ObsClient, rect: { x: number; y: number; w: number; h: number }, quad: Pt[] | null = null, explicit = false): Promise<void | string> {
    const scene = await this.targetScene(c);
    const id = await this.itemId(c, scene, this.cfg.captureSource);
    this.lastErrPx = 0;
    // the frame the output page renders into: the browser source's box, else the whole canvas
    const v = await c.request<{ baseWidth: number; baseHeight: number }>('GetVideoSettings');
    let fx = 0, fy = 0, fw = v.baseWidth, fh = v.baseHeight;
    if (this.cfg.browserSource) {
      const bid = await this.itemId(c, scene, this.cfg.browserSource);
      const t = (await c.request<{ sceneItemTransform: Record<string, number> }>('GetSceneItemTransform', { sceneName: scene, sceneItemId: bid })).sceneItemTransform;
      fw = t.width || fw; fh = t.height || fh;
      const al = t.alignment ?? 5;                                        // OBS_ALIGN_LEFT 1 · RIGHT 2 · TOP 4 · BOTTOM 8
      fx = (t.positionX ?? 0) - (al & 1 ? 0 : al & 2 ? fw : fw / 2);
      fy = (t.positionY ?? 0) - (al & 4 ? 0 : al & 8 ? fh : fh / 2);
    }
    const src = this.cfg.captureSource;
    const q: Pt[] | null = quad && quad.length === 4 ? quad.map(([x, y]) => [fx + x * fw, fy + y * fh] as Pt) : null;
    const filters = async () => ((await c.request<{ filters: { filterName: string }[] }>('GetSourceFilterList', { sourceName: src }).catch(() => ({ filters: [] }))).filters ?? []);
    // the performer's own placement of this capture, before the automation first changes it (put back when the show
    // leaves React)
    await this.touch(c, scene, id, v);
    this.settledMode = null;                                            // (the next mode change puts it right again)
    this.refusal = null;
    const notShown = async (why: string, log: string) => {
      await c.request('SetSceneItemEnabled', { sceneName: scene, sceneItemId: id, sceneItemEnabled: false });
      this.status.fit = `not shown: ${why}`;
      this.status.placed = null;
      this.note('warn', log);
      this.refusal = why.split(' — ')[0];                                // (the OBS page hears it: server/obs.ts holeVerdict)
      await this.checkSetup(c, scene, v).catch(() => {});                 // (the setup warnings still show: Display Capture …)
      return `capture hidden (${why.split(' — ')[0]})`;
    };
    // never show a capture nobody could see: a box with NO part on the canvas (the room's browser source moved off the
    // picture, one that isn't where we think) stays hidden. A box only PARTLY off the canvas is placed: OBS clips the
    // capture at the canvas edge exactly where it clips the room's browser source, so the part viewers see lines up
    // (requiring the whole box on the canvas hid it there — the on-canvas part of the screen was an empty see-through hole)
    {
      const pts: Pt[] = q ?? [[fx + rect.x * fw, fy + rect.y * fh], [fx + (rect.x + rect.w) * fw, fy + (rect.y + rect.h) * fh]];
      if (!onCanvas(pts, v))
        return notShown('the React screen would sit outside the OBS picture', `capture NOT shown: the screen maps to ${pts.map((p) => `${Math.round(p[0])},${Math.round(p[1])}`).join(' / ')} — no part of it on the ${v.baseWidth}×${v.baseHeight} canvas (room frame ${Math.round(fw)}×${Math.round(fh)} at ${Math.round(fx)},${Math.round(fy)})`);
    }
    if (q && this.cfg.cornerPin && await this.hasPin(c)) {
      // exact perspective: the capture covers the quad's bounding box (stretched), the shader warps it onto the corners
      const x0 = Math.min(...q.map((p) => p[0])), x1 = Math.max(...q.map((p) => p[0])), y0 = Math.min(...q.map((p) => p[1])), y1 = Math.max(...q.map((p) => p[1]));
      const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
      const H = homography([[0, 0], [1, 0], [1, 1], [0, 1]], q.map(([x, y]) => [(x - x0) / bw, (y - y0) / bh] as Pt));
      const Hi = invert3(H);
      const t = (await c.request<{ sceneItemTransform: Record<string, number> }>('GetSceneItemTransform', { sceneName: scene, sceneItemId: id })).sceneItemTransform;
      const sw = t.sourceWidth || 16, sh = t.sourceHeight || 9;
      const fit = containFit(sw / sh, 16 / 9);                             // contract: react screens are 16:9 surfaces
      const settings: Record<string, number> = { fit_sx: fit.sx, fit_sy: fit.sy, fit_ox: fit.ox, fit_oy: fit.oy };
      ['h00', 'h01', 'h02', 'h10', 'h11', 'h12', 'h20', 'h21', 'h22'].forEach((k, i) => { settings[k] = Hi[i]; });
      if (!(await filters()).some((f) => f.filterName === PIN_FILTER)) {
        await c.request('CreateSourceFilter', { sourceName: src, filterName: PIN_FILTER, filterKind: PIN_KIND, filterSettings: { from_file: false, shader_text: PIN_SHADER, ...settings } });
      } else await c.request('SetSourceFilterSettings', { sourceName: src, filterName: PIN_FILTER, filterSettings: { from_file: false, shader_text: PIN_SHADER, ...settings }, overlay: true });
      await c.request('SetSourceFilterEnabled', { sourceName: src, filterName: PIN_FILTER, filterEnabled: true });
      if (this.memo) { this.memo.pin = true; saveMemo(this.memo); }
      await c.request('SetSceneItemTransform', {
        sceneName: scene, sceneItemId: id,
        sceneItemTransform: { positionX: Math.round(x0), positionY: Math.round(y0), rotation: 0, alignment: 5, boundsType: 'OBS_BOUNDS_STRETCH', boundsAlignment: 0, boundsWidth: Math.round(bw), boundsHeight: Math.round(bh) },
      });
      this.status.fit = 'corner-pin (exact)';
    } else {
      // no plugin: our corner-pin filter (if an earlier run added it) must not warp this box
      if ((await filters()).some((f) => f.filterName === PIN_FILTER)) await c.request('SetSourceFilterEnabled', { sourceName: src, filterName: PIN_FILTER, filterEnabled: false }).catch(() => {});
      if (q) {
        // best OBS-expressible box: rotation + size around the quad's centre (OBS transforms can't skew). Owner rule:
        // a box that can't match the screen's corners is never shown (no misfit OBS box) — in-scene draws it instead
        const err = boxErrorPx(quad!, fw / fh);
        if (err > SERVER_EXACT_PX && !explicit)
          return notShown(`the screen is at an angle (corners up to ${Math.round(err)} px off) — an OBS box can’t tilt to match it. In-scene capture draws it right; or install obs-shaderfilter and tick Perspective corner-pin`,
            `capture NOT shown: an OBS box would be up to ${Math.round(err)} px off the angled screen's corners (limit ${SERVER_EXACT_PX} px) — use In-scene capture (Auto) or the corner-pin plugin`);
        const f = rotatedFit(q);
        await c.request('SetSceneItemTransform', {
          sceneName: scene, sceneItemId: id,
          sceneItemTransform: { positionX: Math.round(f.cx), positionY: Math.round(f.cy), rotation: +f.rotation.toFixed(2), alignment: 0, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: Math.max(1, Math.round(f.w)), boundsHeight: Math.max(1, Math.round(f.h)) },
        });
        this.lastErrPx = err;
        this.status.fit = err > SERVER_EXACT_PX ? `closest box (corners up to ${Math.round(err)} px off the angled screen — exact only with the corner-pin plugin)` : 'box (exact)';
      } else {
        await c.request('SetSceneItemTransform', {
          sceneName: scene, sceneItemId: id,
          sceneItemTransform: {
            positionX: Math.round(fx + rect.x * fw), positionY: Math.round(fy + rect.y * fh), rotation: 0, alignment: 5,
            boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: Math.max(1, Math.round(rect.w * fw)), boundsHeight: Math.max(1, Math.round(rect.h * fh)),
          },
        });
        this.status.fit = 'box';
      }
    }
    await c.request('SetSceneItemEnabled', { sceneName: scene, sceneItemId: id, sceneItemEnabled: true });
    const t = (await c.request<{ sceneItemTransform: Record<string, number> }>('GetSceneItemTransform', { sceneName: scene, sceneItemId: id })).sceneItemTransform;
    // (where the automation put it: recognised as "ours, not the performer's" after a helper restart)
    if (this.memo && this.memo.scene === scene && this.memo.id === id) { this.memo.placed = placedOf(t); saveMemo(this.memo); }
    this.status.placed =`${Math.round(t.positionX)},${Math.round(t.positionY)} · ${Math.round(t.boundsWidth)}×${Math.round(t.boundsHeight)} · ${(+t.rotation || 0).toFixed(1)}° (canvas ${v.baseWidth}×${v.baseHeight}; room frame ${Math.round(fw)}×${Math.round(fh)} at ${Math.round(fx)},${Math.round(fy)})`;
    await this.checkSetup(c, scene, v).catch(() => {});
  }

  private wsSources: { scene: string; at: number; names: string[] } | null = null;
  /** Things in OBS that make a correct placement look wrong → status.warnings (+ the log when new). */
  private async checkSetup(c: ObsClient, scene: string, v: { baseWidth: number; baseHeight: number }) {
    const w: string[] = [];
    const src = this.cfg.captureSource, br = this.cfg.browserSource;
    const items = (await c.request<{ sceneItems: { sourceName: string; inputKind?: string; sceneItemIndex: number; sceneItemEnabled: boolean; sceneItemTransform: Record<string, number> }[] }>('GetSceneItemList', { sceneName: scene })).sceneItems ?? [];
    const cap = items.find((i) => i.sourceName === src), bro = br ? items.find((i) => i.sourceName === br) : null;
    const f = ((await c.request<{ filters: { filterName: string; filterKind: string; filterEnabled: boolean }[] }>('GetSourceFilterList', { sourceName: src }).catch(() => ({ filters: [] }))).filters ?? []);
    const foreign = f.filter((x) => x.filterEnabled && x.filterName !== PIN_FILTER);
    if (foreign.length) w.push(`“${src}” has filter(s) on that reshape it after VTube Pro places it: ${foreign.map((x) => `${x.filterName} (${x.filterKind})`).join(', ')} — turn them off (OBS → the source → Filters) or the window won't sit on the screen.`);
    if (cap && bro && cap.sceneItemIndex > bro.sceneItemIndex) w.push(`“${src}” is ABOVE the browser source “${br}” in “${scene}” — drag it below, or it covers the whole room.`);
    if (!bro && br) w.push(`Browser source “${br}” is not in scene “${scene}” — the room frame is assumed to fill the canvas.`);
    if (cap?.inputKind === 'monitor_capture') w.push(`“${src}” is a Display Capture: the WHOLE monitor is shrunk into the screen. For one window use a Window Capture (or crop the Display Capture).`);
    if (bro) {
      const t = bro.sceneItemTransform;
      if (t?.sourceWidth && (Math.round(t.sourceWidth) !== v.baseWidth || Math.round(t.sourceHeight) !== v.baseHeight))
        w.push(`Browser source “${br}” renders at ${t.sourceWidth}×${t.sourceHeight} and is scaled to ${Math.round(t.width)}×${Math.round(t.height)} (canvas ${v.baseWidth}×${v.baseHeight}) — placement accounts for it, but set its Width/Height to ${v.baseWidth}×${v.baseHeight} for a sharp room.`);
    }
    // a browser source pointed at OBS's WebSocket address (ws://…:4455) does nothing — VTube Pro talks to OBS by itself
    // (looked up once per scene every 5 min: one GetInputSettings per browser source)
    const now = Date.now();
    if (!this.wsSources || this.wsSources.scene !== scene || now - this.wsSources.at > 300_000) {
      const names: string[] = [];
      for (const b of items.filter((i) => i.inputKind === 'browser_source' && i.sourceName !== br).slice(0, 8)) {
        const url = String((await c.request<{ inputSettings: Record<string, unknown> }>('GetInputSettings', { inputName: b.sourceName }).catch(() => ({ inputSettings: {} as Record<string, unknown> }))).inputSettings?.url ?? '');
        if (/^wss?:/i.test(url)) names.push(b.sourceName);
      }
      this.wsSources = { scene, at: now, names };
    }
    for (const nm of this.wsSources.names) w.push(`Browser source “${nm}” in “${scene}” has OBS’s WebSocket address as its URL — that isn’t a page, so it does nothing (VTube Pro talks to OBS by itself). Remove it in OBS.`);
    const old = this.status.warnings ?? [];
    for (const x of w) if (!old.includes(x)) this.note('warn', x);
    this.status.warnings = w;
  }

  /** "Test OBS automation": place the capture as if a React hole opened (the last reported corners, else a box on
   *  the right), read the result back, and restore the item's exact transform + visibility ~1 s later. The capture
   *  sits under the room, so on stream nothing changes unless the room's hole is open. */
  test(): Promise<ObsTestReport> {
    const steps: string[] = [];
    const out = this.chain.then(async (): Promise<ObsTestReport> => {
      if (!this.cfg.captureSource) return { ok: false, steps, warnings: [], error: 'No capture source set.' };
      let c: ObsClient;
      try { c = await this.conn(); } catch (e) { return { ok: false, steps, warnings: [], error: (e as Error).message }; }
      const scene = await this.targetScene(c);
      let id: number;
      try { id = await this.itemId(c, scene, this.cfg.captureSource); } catch { return { ok: false, steps, warnings: [], error: `“${this.cfg.captureSource}” is not in OBS scene “${scene}”.` }; }
      steps.push(`connected (obs-websocket ${c.version ?? '?'}) · scene “${scene}” · “${this.cfg.captureSource}” = item ${id}`);
      const t0 = (await c.request<{ sceneItemTransform: Record<string, number> }>('GetSceneItemTransform', { sceneName: scene, sceneItemId: id })).sceneItemTransform;
      const e0 = (await c.request<{ sceneItemEnabled: boolean }>('GetSceneItemEnabled', { sceneName: scene, sceneItemId: id })).sceneItemEnabled;
      // (what SetSceneItemTransform accepts back: a hand-placed capture's 0 × 0 bounds would make OBS refuse the restore)
      const saved = restorableTransform(t0);
      const keep = Object.keys(saved);
      steps.push(`recorded: ${Math.round(t0.positionX)},${Math.round(t0.positionY)} · ${String(t0.boundsType)} ${Math.round(t0.boundsWidth)}×${Math.round(t0.boundsHeight)} · ${(+t0.rotation || 0).toFixed(1)}° · ${e0 ? 'shown' : 'hidden'}`);
      const q: Pt[] = this.lastQuad ?? [[0.56, 0.14], [0.94, 0.14], [0.94, 0.5], [0.56, 0.5]];
      const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
      const rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      let placed: string | undefined, restored = false, err: string | undefined;
      const memo0 = this.memo ? { ...this.memo } : null;
      try {
        const said = await this.place(c, rect, q);
        placed = typeof said === 'string' ? undefined : this.status.placed ?? undefined;
        steps.push(typeof said === 'string' ? `NOT shown (${this.lastQuad ? 'the last reported screen corners' : 'a test box on the right'}) — ${this.status.fit ?? said}` : `placed (${this.lastQuad ? 'the last reported screen corners' : 'a test box on the right'}): ${placed ?? '?'} · fit: ${this.status.fit ?? '?'}`);
        await new Promise((r) => setTimeout(r, 1000));
      } catch (e) { err = (e as Error).message; steps.push(`placing failed: ${err}`); }
      finally {
        // (the test restores the item itself — and the corner-pin filter if only the test switched it on)
        const pinOn = !!this.memo?.pin && !memo0?.pin;
        this.memo = memo0; saveMemo(memo0);
        if (pinOn) await c.request('SetSourceFilterEnabled', { sourceName: this.cfg.captureSource, filterName: PIN_FILTER, filterEnabled: false }).catch(() => {});
        try {
          await c.request('SetSceneItemTransform', { sceneName: scene, sceneItemId: id, sceneItemTransform: saved });
          await c.request('SetSceneItemEnabled', { sceneName: scene, sceneItemId: id, sceneItemEnabled: e0 });
          const t1 = (await c.request<{ sceneItemTransform: Record<string, number> }>('GetSceneItemTransform', { sceneName: scene, sceneItemId: id })).sceneItemTransform;
          restored = keep.every((k) => typeof t0[k] !== 'number' || Math.abs(Number(t1[k]) - Number(t0[k])) < 0.01) && t1.boundsType === t0.boundsType;
          steps.push(restored ? 'restored the original transform + visibility ✔' : 'restore: transform differs slightly (check the item)');
        } catch (e) { steps.push(`RESTORE FAILED: ${(e as Error).message}`); }
      }
      this.lastHole = ''; this.refused = null;                         // the next real hole report re-applies
      const ok = !err && restored;
      this.note(ok ? 'ok' : 'err', `test: ${ok ? 'placed + restored' : err ?? 'restore mismatch'}${placed ? ` — ${placed}` : ''}`);
      return { ok, steps, placed, restored, warnings: this.status.warnings ?? [], error: err };
    }).catch((e) => ({ ok: false, steps, warnings: [], error: (e as Error).message }) as ObsTestReport);
    this.chain = out;
    return out;
  }

  /** The last hole a non-React layout reported (Gaming …): what *Fit my capture* uses when the studio sends no rect. */
  private lastStage: { rect: { x: number; y: number; w: number; h: number }; mode: string } | null = null;

  /** Scene tab → *Fit my capture to the layout* (explicit click only): put `source` exactly over `rect` (fractions of the
   *  VTube Pro frame) — 'fit' = the whole capture inside (bars if its aspect differs), 'fill' = cover the rect, cropping
   *  the overflow (OBS 30+ crop-to-bounds). Changes that item's transform / crop, nothing else; reports what it did and
   *  what else in OBS would make it look wrong (order, filters, a Display Capture of a different monitor size). */
  fit(source: string, rect: { x: number; y: number; w: number; h: number } | null, how: 'fit' | 'fill'): Promise<ObsFitReport> {
    const out = this.chain.then(async (): Promise<ObsFitReport> => {
      const r = rect ?? this.lastStage?.rect ?? null;
      if (!source) return { ok: false, error: 'Pick the capture source first.', warnings: [] };
      if (!r) return { ok: false, error: 'No layout rect yet — switch to React / Gaming with a room first.', warnings: [] };
      const c = new ObsClient();
      try {
        await c.connect(this.cfg.url, this.cfg.password, 4000);
        const scene = await this.targetScene(c);
        let id: number;
        try { id = await this.itemId(c, scene, source); } catch { return { ok: false, error: `“${source}” is not in OBS scene “${scene}”. Add it there (below the VTube Pro browser source), then click again.`, warnings: [] }; }
        const v = await c.request<{ baseWidth: number; baseHeight: number }>('GetVideoSettings');
        let fx = 0, fy = 0, fw = v.baseWidth, fh = v.baseHeight;
        if (this.cfg.browserSource) {
          const bid = await this.itemId(c, scene, this.cfg.browserSource).catch(() => null);
          if (bid !== null) {
            const t = (await c.request<{ sceneItemTransform: Record<string, number> }>('GetSceneItemTransform', { sceneName: scene, sceneItemId: bid })).sceneItemTransform;
            fw = t.width || fw; fh = t.height || fh;
            const al = t.alignment ?? 5;
            fx = (t.positionX ?? 0) - (al & 1 ? 0 : al & 2 ? fw : fw / 2);
            fy = (t.positionY ?? 0) - (al & 4 ? 0 : al & 8 ? fh : fh / 2);
          }
        }
        const t0 = (await c.request<{ sceneItemTransform: Record<string, number> }>('GetSceneItemTransform', { sceneName: scene, sceneItemId: id })).sceneItemTransform;
        const box = { x: Math.round(fx + r.x * fw), y: Math.round(fy + r.y * fh), w: Math.max(1, Math.round(r.w * fw)), h: Math.max(1, Math.round(r.h * fh)) };
        await c.request('SetSceneItemTransform', {
          sceneName: scene, sceneItemId: id,
          sceneItemTransform: { positionX: box.x, positionY: box.y, rotation: 0, alignment: 5, boundsType: how === 'fill' ? 'OBS_BOUNDS_SCALE_OUTER' : 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: box.w, boundsHeight: box.h, cropToBounds: how === 'fill' },
        });
        const w: string[] = [];
        const items = (await c.request<{ sceneItems: { sourceName: string; inputKind?: string; sceneItemIndex: number; sceneItemEnabled: boolean }[] }>('GetSceneItemList', { sceneName: scene })).sceneItems ?? [];
        const cap = items.find((i) => i.sourceName === source);
        const bro = items.find((i) => i.sourceName === this.cfg.browserSource) ?? null;
        if (cap && bro && cap.sceneItemIndex > bro.sceneItemIndex) w.push(`“${source}” is ABOVE the browser source — drag it below “${bro.sourceName}” (OBS → Sources), or it covers your room.`);
        if (cap && !cap.sceneItemEnabled) w.push(`“${source}” is hidden (the eye icon in OBS → Sources).`);
        const sw = t0.sourceWidth || 0, sh = t0.sourceHeight || 0;
        const kind = cap?.inputKind ?? '';
        if (sw && sh && Math.abs(sw / sh - r.w * fw / (r.h * fh)) > 0.03)
          w.push(`The capture is ${sw}×${sh} (${(sw / sh).toFixed(2)}:1) and the layout's box is ${box.w}×${box.h} (${(box.w / box.h).toFixed(2)}:1): ${how === 'fill' ? 'the edges that don’t fit are cropped' : 'there are bars on two sides — pick “Fill” to crop instead, or set the capture aspect in Scene tab → Stage (16:9, 21:9 …)'}.`);
        if (!sw || !sh) w.push(`“${source}” shows nothing right now (0×0) — the window / game isn't running, or Game Capture can't hook it. If the game is running, VTube Pro offers a one-click switch to a Display or Window Capture (Scene tab → Game capture).`);
        const t1 = (await c.request<{ sceneItemTransform: Record<string, number> }>('GetSceneItemTransform', { sceneName: scene, sceneItemId: id })).sceneItemTransform;
        const placed = `${Math.round(t1.positionX)},${Math.round(t1.positionY)} · ${Math.round(t1.boundsWidth)}×${Math.round(t1.boundsHeight)} (${how}) in “${scene}”, canvas ${v.baseWidth}×${v.baseHeight}`;
        this.note('ok', `fit: “${source}” → ${placed}`);
        // this is the performer's own placement now (put back here when the show leaves React); the visibility the
        // automation remembers stays as it is (shown in Gaming if it was shown before the automation hid it)
        const m = this.memo;
        if (m && m.source === source && m.scene === scene && m.id === id) {
          m.own = restorableTransform(t1);
          if (!m.touched) m.enabled = !!cap?.sceneItemEnabled;
          saveMemo(m);
        }
        return { ok: true, placed, kind, source: { width: sw, height: sh }, box, warnings: w };
      } catch (e) {
        return { ok: false, error: `Can’t reach OBS: ${(e as Error).message} — OBS → Tools → WebSocket Server Settings (enable, port 4455) and the same password in Scene tab → OBS automation.`, warnings: [] };
      } finally { c.close(); }
    });
    this.chain = out.then(() => undefined, () => undefined);
    return out;
  }

  /** The capture item's own placement + visibility from before the automation first changed it (cache/obs-capture.json:
   *  survives a helper restart, so the React placement is never mistaken for the performer's own). */
  private memo: CaptureMemo | null = loadMemo();
  /** The corner error of the last placement (px of a 1080-high frame; Interview's explicit fit reports it). */
  private lastErrPx = 0;
  /** Record the capture's own placement before the automation changes it (React's placement, a hide, an Interview fit)
   *  — once per change: while `touched`, the record from before the first change is kept. A capture that already sits
   *  at the automation's last placement (a lost memo) or entirely off the canvas (parked there by an older version) is not
   *  the performer's placement: then nothing is ever put back there, it is only hidden. */
  private async touch(c: ObsClient, scene: string, id: number, v?: { baseWidth: number; baseHeight: number }) {
    const src = this.cfg.captureSource;
    const m = this.memo && this.memo.source === src && this.memo.scene === scene && this.memo.id === id ? this.memo : null;
    const t = (await c.request<{ sceneItemTransform: Record<string, unknown> }>('GetSceneItemTransform', { sceneName: scene, sceneItemId: id })).sceneItemTransform ?? {};
    const canvas = v ?? await c.request<{ baseWidth: number; baseHeight: number }>('GetVideoSettings').catch(() => null);
    // ours: where the automation's last placement put it — or, with no record of one (the first run after an update),
    // the shape only the automation's React box has (centre-anchored, scaled into inner bounds: a hand-placed capture
    // or a Fit my capture is anchored top-left)
    const ours = m?.placed ? samePlace(t, m.placed) : t.alignment === 0 && t.boundsType === 'OBS_BOUNDS_SCALE_INNER';
    const off = !!canvas && offCanvas(t, canvas);
    if (m?.touched) {
      // moved by hand in OBS since (neither where the automation put it nor its recorded own place): that is the
      // performer's own placement now (the visibility recorded before the automation hid it stays)
      if (!ours && !off && !(m.own && samePlace(t, placedOf(m.own)))) { m.own = restorableTransform(t); saveMemo(m); }
      return;
    }
    const e = (await c.request<{ sceneItemEnabled: boolean }>('GetSceneItemEnabled', { sceneName: scene, sceneItemId: id }).catch(() => ({ sceneItemEnabled: false }))).sceneItemEnabled;
    this.memo = { source: src, scene, id, own: ours || off ? null : restorableTransform(t), enabled: !ours && !off && !!e, touched: true, placed: m?.placed ?? null, ...(m?.pin ? { pin: true } : {}) };
    if (ours || off) this.note('info', `“${src}” sat ${ours ? 'at the automation’s own React placement' : 'off the OBS canvas'} — not taken as your placement (it is only hidden when you leave React)`);
    saveMemo(this.memo);
  }

  /** Put the capture where the CURRENT mode wants it (never React's hole itself: that is place()). React (a camera
   *  move, the screen out of the shot, a room change): hidden. A mode with its own capture area (Gaming …): back to the
   *  performer's own placement, shown again if it was shown before the automation hid it. Talk, Classic, Interview …:
   *  hidden, back at its own place. */
  private async settle(c: ObsClient): Promise<void | string> {
    // (the mode the OBS pages SHOW: on a party guest's PC the host's, not this PC's own saved one — a React close used to
    // put the capture back AND show it at the guest's own Gaming place in the middle of the host's React)
    const shown = this.shown;
    const react = shown.mode === 'react' && !!shown.sceneId;
    const mode = this.modeNow();
    // Interview's "Fit my Window Capture" (a click) placed it for this mode: left there until the mode changes
    if (!react && this.fitMode === mode) { this.settledMode = mode; return `capture: kept where “Fit my Window Capture” put it (${mode})`; }
    const scene = await this.targetScene(c);
    // (a capture source that isn't in this OBS scene — e.g. only followed by the in-scene feed — has nothing to put
    // right: said once in the log, not an error on every mode change)
    let id: number;
    try { id = await this.itemId(c, scene, this.cfg.captureSource); }
    catch (e) {
      if (!/no scene items|not found|no source/i.test((e as Error).message)) throw e;   // (OBS busy / gone: retried)
      this.settledMode = mode;
      return `capture: “${this.cfg.captureSource}” isn’t in OBS scene “${scene}” — nothing to move`;
    }
    const mine = () => (this.memo && this.memo.source === this.cfg.captureSource && this.memo.scene === scene && this.memo.id === id ? this.memo : null);
    const hide = () => c.request('SetSceneItemEnabled', { sceneName: scene, sceneItemId: id, sceneItemEnabled: false });
    if (react) {
      await this.touch(c, scene, id);
      await hide();
      this.settledMode = mode;
      return;
    }
    if (shown.hole) {
      const m = mine();
      if (!m?.touched) { this.settledMode = mode; return 'capture: nothing of the automation’s to put back'; }
      await hide();                                                     // (never shown at the React spot meanwhile)
      await this.putBack(c, scene, id, m);
      if (m.enabled) await c.request('SetSceneItemEnabled', { sceneName: scene, sceneItemId: id, sceneItemEnabled: true });
      m.touched = false; saveMemo(m);                                   // (only once it is all back: a failure retries it)
      this.settledMode = mode;
      return m.enabled ? `capture back to your own placement (${mode})` : m.own ? `capture back to your own placement, hidden as you had it (${mode})` : `capture hidden (${mode})`;
    }
    await this.touch(c, scene, id);
    await hide();
    const m = mine();
    if (m) await this.putBack(c, scene, id, m);
    this.settledMode = mode;
    return m?.own ? `capture hidden, back at your own placement (${mode})` : `capture hidden (${mode})`;
  }
  /** The mode settle() last put the capture right for (null = something moved it since: React / Interview placed it). */
  private settledMode: string | null = null;
  /** The performer's own transform back (sanitized: OBS refuses a 0 × 0 bounds box) + the corner-pin filter off. */
  private async putBack(c: ObsClient, scene: string, id: number, m: CaptureMemo) {
    if (m.own && Object.keys(m.own).length) await c.request('SetSceneItemTransform', { sceneName: scene, sceneItemId: id, sceneItemTransform: restorableTransform(m.own) });
    if (m.pin) {
      await c.request('SetSourceFilterEnabled', { sourceName: this.cfg.captureSource, filterName: PIN_FILTER, filterEnabled: false }).catch(() => {});
      delete m.pin; saveMemo(m);
    }
  }

  /** Interview → "Fit my Window Capture → <guest>" (a click, POST /api/obs/place): put the capture on that monitor
   *  panel's corners as its close-up sees them. Exact with the corner-pin; otherwise the closest OBS box — that close-up
   *  is turned a touch towards the host, so a plain box can be some px off at the corners (the answer says how far).
   *  Never hidden for that: the click asked for it (a React hole is held to the exact rule instead) — not by the mode
   *  change's safety net 2.5 s later, nor by a late close of the React hole (fitMode). Leaving the mode hides it / puts
   *  it back like React's placement. */
  placeAt(rect: { x: number; y: number; w: number; h: number }, quad: Pt[] | null): Promise<ObsPlaceReport> {
    if (!this.cfg.enabled) return Promise.resolve({ ok: false, error: 'OBS automation is off — set the capture by hand with the numbers below, or turn on Automate OBS.' });
    if (!this.cfg.captureSource) return Promise.resolve({ ok: false, error: 'No capture source is set (Scene tab → OBS automation → Window Capture).' });
    // (a click right after entering Interview: the safety net would hide what the click is about to place)
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    this.fitMode = this.modeNow();
    const out = this.chain.then(async (): Promise<ObsPlaceReport> => {
      try {
        const c = await this.conn();
        const said = await this.place(c, rect, quad, true);
        this.lastHole = ''; this.refused = null;                        // (the next React hole re-places it)
        this.note(typeof said === 'string' ? 'warn' : 'ok', `fit (Interview): ${typeof said === 'string' ? this.status.fit ?? said : `${this.status.placed ?? ''} · ${this.status.fit ?? ''}`}`);
        return typeof said === 'string' ? { ok: false, error: this.status.fit ?? said }
          : { ok: true, placed: this.status.placed ?? undefined, fit: this.status.fit ?? undefined, offPx: Math.round(this.lastErrPx) };
      } catch (e) { return { ok: false, error: `Can’t reach OBS: ${(e as Error).message}` }; }
    });
    this.chain = out.then(() => undefined, () => undefined);
    return out;
  }

  /** Host scene state saved (PUT /api/scene): switch OBS scenes with "What you're doing" + BRB (shared/obsSetup.ts
   *  lookOf); Talk hides the capture. Recording reminders follow the lighting states Preshow / Outro. */
  private lastLook: LookId | null | undefined = undefined;
  private lastLight: string | undefined = undefined;
  scene(s: SceneState) {
    this.info = { sceneId: s.sceneId ?? '', mode: s.mode, screen: s.screen?.mode ?? 'auto', layout: s.reactLayout ?? 'auto', hole: !!s.stage?.hole };
    this.partyView = null;                                              // (only a host / solo studio saves: its pages show this)
    const look = lookOf(s);
    const light = s.lights?.state ?? 'show';
    const prevLight = this.lastLight;
    this.lastLight = light;
    const firstLook = this.lastLook === undefined;
    const lookChanged = !firstLook && look !== this.lastLook;
    const prevLook = this.lastLook ?? null;
    this.lastLook = look;
    const mode = s.sceneId ? s.mode : 'classic';
    const modeChanged = mode !== this.lastMode;
    const prev = this.lastMode;
    this.lastMode = mode;
    if (modeChanged) { this.modeAt = Date.now(); this.fitMode = null; for (const f of this.modeListeners) { try { f(mode); } catch { /* a listener never breaks the automation */ } } }
    if (!this.cfg.enabled || firstLook || prev === null) return;           // never act on the first state after a restart
    // (looks the wizard doesn't map — Gaming, … — keep the program scene). Only a look that maps to a DIFFERENT scene
    // than the last one switches, and only when OBS isn't on it already: Talk ↔ React on one scene used to re-send it
    // (a Fade to itself, and it pulled OBS back from a scene picked by hand)
    if (lookChanged && this.cfg.switchScenes) {
      const name = sceneToSwitch(effectiveMap(this.cfg), prevLook, look);
      if (name) this.run(`scene → ${name}`, async (c) => {
        const cur = await c.request<{ currentProgramSceneName?: string; sceneName?: string }>('GetCurrentProgramScene').catch(() => null);
        if ((cur?.currentProgramSceneName ?? cur?.sceneName) === name) return `scene: already on ${name}`;
        await c.request('SetCurrentProgramScene', { sceneName: name });
      });
    }
    if (this.cfg.recordReminder && prevLight !== undefined && light !== prevLight) this.remind(prevLight, light);
    if (!modeChanged) return;
    // back in React before the safety net fired (a quick Talk → React): keep the capture React is about to place
    if (mode === 'react') {
      if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
      this.audit();                                                     // (setup warnings even if nothing gets placed)
      return;
    }
    // every other mode: put the capture where that mode wants it (settle) — off the React screen; hidden in Talk /
    // Classic / Interview; in Gaming (a mode with its own capture area) back at the performer's own placement and shown
    // again if it was shown before the automation hid it (Gaming → Talk → Gaming, Gaming → React → Gaming). The output
    // page's close report usually does it first; this safety net covers no page / a lost report, 2.5 s later.
    if (this.cfg.captureSource) {
      if (this.hideTimer) clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => {
        this.hideTimer = null;
        if (this.lastMode !== mode) return;
        if (this.settledMode === mode && !this.lastHole.startsWith('1|')) return;   // (done: the page's close report)
        this.lastHole = '0'; this.openHole = '';
        this.run(`capture → ${mode}`, (c) => this.settle(c), 3);
      }, 2500);
      this.hideTimer.unref?.();
    }
  }

  /** Recording reminders (wizard step 6, OFF by default): never starts or stops anything. It only asks OBS whether it
   *  is recording (GetRecordStatus) and tells the studio to show a one-line reminder (bus command `obs-reminder`). */
  private remind(from: string, to: string) {
    const starting = to === 'preshow' || (from === 'preshow' && to !== 'outro');
    const ending = to === 'outro';
    if (!starting && !ending) return;
    this.chain = this.chain.then(async () => {
      try {
        const c = await this.conn();
        const r = await c.request<{ outputActive?: boolean }>('GetRecordStatus');
        const rec = !!r.outputActive;
        const text = starting && !rec ? 'Reminder: OBS isn’t recording. Press Start Recording in OBS if you want a copy.'
          : ending && rec ? 'Reminder: OBS is still recording. Press Stop Recording in OBS when you’re done.' : '';
        if (text) { broadcast({ type: 'command', command: 'obs-reminder', args: { text } }); this.note('info', text); }
      } catch { /* OBS not reachable: no reminder */ }
    });
  }

  /** Read-only look at the OBS setup (GET /api/obs/diagnose): what the capture source is, where it sits, what gets in
   *  the way — in plain words with the fix. Never changes anything in OBS. */
  async diagnose(): Promise<ObsDiagnosis> {
    const f: ObsFinding[] = [];
    const c = this.cfg;
    if (!this.canRead()) return { ok: false, connected: false, scene: null, findings: [{ level: 'info', text: 'VTube Pro isn’t connected to OBS, so it can’t look at your OBS setup.', fix: 'Open VTube Pro’s OBS page and press “Find it for me” (or Scene tab → OBS automation → enter the WebSocket password from OBS → Tools → WebSocket Server Settings).' }] };
    const cl = new ObsClient();
    try {
      await cl.connect(c.url, c.password, 4000);
      f.push({ level: 'ok', text: `Connected to OBS (obs-websocket ${cl.version ?? '?'}).` });
      const scene = await this.targetScene(cl);
      const inputs = (await cl.request<{ inputs: { inputName: string; inputKind: string }[] }>('GetInputList')).inputs ?? [];
      const kindOf = new Map(inputs.map((i) => [i.inputName, i.inputKind]));
      const items = (await cl.request<{ sceneItems: { sourceName: string; inputKind?: string; sceneItemIndex: number; sceneItemEnabled: boolean }[] }>('GetSceneItemList', { sceneName: scene }).catch(() => ({ sceneItems: [] }))).sceneItems ?? [];
      const src = c.captureSource, kind = src ? kindOf.get(src) : undefined;
      const unesc = (x: string) => x.replace(/#3A/g, ':').replace(/#22/g, '#');
      if (!src) f.push({ level: 'err', text: 'No capture source is set, so VTube Pro doesn’t know which window to show on the react screen.', fix: 'Scene tab → OBS automation → Capture source: pick your Window Capture.' });
      else if (!kind) f.push({ level: 'err', text: `There is no source called “${src}” in OBS.`, fix: `Scene tab → OBS automation → Capture source: pick one of: ${inputs.filter((i) => /window_capture|game_capture|monitor_capture/.test(i.inputKind)).map((i) => `“${i.inputName}”`).join(', ') || '(none — add a Window Capture in OBS)'}.` });
      else {
        if (kind === 'window_capture') {
          const w = String((await cl.request<{ inputSettings: Record<string, unknown> }>('GetInputSettings', { inputName: src })).inputSettings?.window ?? '');
          const p = w.split(':');
          f.push(w ? { level: 'ok', text: `“${src}” is a Window Capture of ${unesc(p.slice(2).join(':'))} — “${unesc(p[0])}”.` }
            : { level: 'err', text: `“${src}” has no window chosen.`, fix: `OBS → double-click “${src}” → Window: pick the window to show.` });
        } else if (kind === 'monitor_capture') f.push({ level: 'warn', text: `“${src}” is a Display Capture: the WHOLE monitor goes on the react screen (small and hard to read).`, fix: 'For one window: OBS → Sources → + → Window Capture → pick the window, then choose it in Scene tab → OBS automation → Capture source (or pick the window under “Fast window feed”).' });
        else if (kind === 'game_capture') f.push({ level: 'info', text: `“${src}” is a Game Capture — the fast feed can only follow it in “Capture specific window” mode.` });
        else f.push({ level: 'warn', text: `“${src}” is a ${kind}, not a Window / Display Capture.` });
        const cap = items.find((i) => i.sourceName === src);
        const fl = (await cl.request<{ filters: { filterName: string; filterKind: string; filterEnabled: boolean }[] }>('GetSourceFilterList', { sourceName: src }).catch(() => ({ filters: [] }))).filters ?? [];
        const foreign = fl.filter((x) => x.filterEnabled && x.filterName !== PIN_FILTER);
        if (foreign.length) f.push({ level: 'warn', text: `“${src}” has filters that reshape it: ${foreign.map((x) => `${x.filterName} (${x.filterKind})`).join(', ')}. In passthrough mode it won’t sit on the screen.`, fix: `OBS → right-click “${src}” → Filters → switch them off.` });
        const bro = c.browserSource ? items.find((i) => i.sourceName === c.browserSource) : null;
        if (cap && bro && cap.sceneItemIndex > bro.sceneItemIndex) f.push({ level: 'warn', text: `“${src}” is ABOVE the VTube Pro browser source “${c.browserSource}” in “${scene}”: whenever it is shown it covers the room.`, fix: `OBS → Sources list of “${scene}”: drag “${src}” below “${c.browserSource}”.` });
        if (!cap) f.push({ level: 'info', text: `“${src}” isn’t in OBS scene “${scene}” — fine for in-scene capture (the fast feed reads the window itself); passthrough mode needs it in that scene, below the browser source.` });
      }
      // browser sources in the scene: which one is VTube Pro, and stray ones
      let vtp = 0;
      for (const b of items.filter((i) => (i.inputKind ?? kindOf.get(i.sourceName)) === 'browser_source')) {
        const url = String((await cl.request<{ inputSettings: Record<string, unknown> }>('GetInputSettings', { inputName: b.sourceName }).catch(() => ({ inputSettings: {} as Record<string, unknown> }))).inputSettings?.url ?? '');
        if (/\/output\.html/.test(url) || isLanVtpUrl(url)) { // (a stream PC's link to this PC counts too: Stream PC mode)
          vtp++;
          if (!/^http:\/\/127\.0\.0\.1:5191\//.test(url) && !isLanVtpUrl(url)) f.push({ level: 'warn', text: `Browser source “${b.sourceName}” loads ${url} — OBS should load the stable build.`, fix: `OBS → “${b.sourceName}” → Properties → URL: http://127.0.0.1:5191/output.html` });
        } else if (/^wss?:/i.test(url)) f.push({ level: 'err', text: `Browser source “${b.sourceName}” has the URL ${url} — that is the OBS WebSocket address, not a web page, so it does nothing (VTube Pro talks to OBS by itself).`, fix: `OBS → Sources of “${scene}” → select “${b.sourceName}” → click − to remove it.` });
      }
      if (!vtp) f.push({ level: 'err', text: `No browser source in “${scene}” shows http://127.0.0.1:5191/output.html, so OBS has no VTube Pro page there.`, fix: 'OBS → Sources → + → Browser → URL http://127.0.0.1:5191/output.html, width/height = your canvas.' });
      else if (vtp > 1) f.push({ level: 'warn', text: `${vtp} browser sources in “${scene}” show VTube Pro — each one renders the room and decodes the react screen (double GPU cost).`, fix: 'Keep one, remove the others.' });
      if (this.info.screen === 'passthrough') f.push({ level: 'info', text: 'React screen is set to OBS passthrough: OBS places the window under a hole (no true perspective without the corner-pin plugin, and it blanks while the camera moves). Auto / In-scene draws it on the 3D screen.' });
      return { ok: !f.some((x) => x.level === 'err'), connected: true, scene, findings: f };
    } catch (e) {
      return { ok: false, connected: false, scene: null, findings: [{ level: 'err', text: `Can’t reach OBS: ${(e as Error).message}`, fix: 'Start OBS, then OBS → Tools → WebSocket Server Settings: Enable, port 4455, and the same password as in Scene tab → OBS automation.' }] };
    } finally { cl.close(); }
  }

  /** One-off connection (optionally with unsaved settings) → what OBS has, for the Scene tab's pickers. */
  async probe(url?: string, password?: string): Promise<ObsProbe> {
    const c = new ObsClient();
    try {
      await c.connect(url || this.cfg.url, password || this.cfg.password);
      const [scenes, inputs, video, cur, kinds] = await Promise.all([
        c.request<{ scenes: { sceneName: string }[] }>('GetSceneList'),
        c.request<{ inputs: { inputName: string; inputKind: string }[] }>('GetInputList'),
        c.request<{ baseWidth: number; baseHeight: number }>('GetVideoSettings'),
        c.request<{ currentProgramSceneName?: string }>('GetCurrentProgramScene'),
        c.request<{ sourceFilterKinds: string[] }>('GetSourceFilterKindList').catch(() => ({ sourceFilterKinds: [] as string[] })),
      ]);
      this.pinKind = (kinds.sourceFilterKinds ?? []).includes(PIN_KIND);
      return {
        ok: true, version: c.version ?? undefined,
        scenes: (scenes.scenes ?? []).map((s) => s.sceneName).reverse(),
        inputs: (inputs.inputs ?? []).map((i) => ({ name: i.inputName, kind: i.inputKind })),
        canvas: { width: video.baseWidth, height: video.baseHeight }, current: cur.currentProgramSceneName, shaderFilter: !!this.pinKind,
      };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
    finally { c.close(); }
  }
  // ---------------------------------------------------------------- reading OBS's scenes (cached)
  private lastRead: { at: number; scenes: ObsScenes; authRequired: boolean | null } | null = null;
  private reading: Promise<ObsScenes> | null = null;
  private obsVersion: string | null = null;

  /** Read-only: the scene list, the program scene and the canvas. Uses the open automation connection when there is
   *  one, else a one-off connection that is closed right after. Sends only Get* requests. Cached 1.5 s (UI polling). */
  scenes(maxAgeMs = 1500): Promise<ObsScenes> {
    if (this.lastRead && Date.now() - this.lastRead.at < maxAgeMs) return Promise.resolve(this.lastRead.scenes);
    if (this.reading) return this.reading;
    const run = async (): Promise<ObsScenes> => {
      let auth: boolean | null = null;
      try {
        const c = await this.readConn();
        auth = c.authRequired;
        const [list, video, ver] = await Promise.all([
          c.request<{ scenes?: { sceneName: string }[]; currentProgramSceneName?: string }>('GetSceneList'),
          c.request<{ baseWidth: number; baseHeight: number }>('GetVideoSettings').catch(() => null),
          this.obsVersion ? Promise.resolve(null) : c.request<{ obsVersion?: string }>('GetVersion').catch(() => null),
        ]);
        if (ver?.obsVersion) this.obsVersion = String(ver.obsVersion).slice(0, 24);
        let current = typeof list.currentProgramSceneName === 'string' ? list.currentProgramSceneName : null;
        if (current === null) current = (await c.request<{ currentProgramSceneName?: string }>('GetCurrentProgramScene').catch(() => ({} as { currentProgramSceneName?: string }))).currentProgramSceneName ?? null;
        const out: ObsScenes = { ok: true, scenes: (list.scenes ?? []).map((s) => String(s.sceneName)).reverse(), current, canvas: video ? { width: video.baseWidth, height: video.baseHeight } : null, version: c.version };
        this.status = { ...this.status, version: c.version ?? this.status.version, error: this.cfg.enabled ? this.status.error : null };
        this.lastRead = { at: Date.now(), scenes: out, authRequired: auth };
        // OBS answered without asking for a password: remember it (the in-scene feed may read OBS — canRead)
        if (auth === false && !this.cfg.password && !this.cfg.authOff) { this.cfg = { ...this.cfg, authOff: true }; save(this.cfg); }
        return out;
      } catch (e) {
        const msg = (e as Error).message;
        const out: ObsScenes = { ok: false, scenes: [], current: null, error: msg, fix: obsFix(msg, !!this.cfg.password) };
        this.lastRead = { at: Date.now(), scenes: out, authRequired: auth };
        this.dropReader();
        return out;
      }
    };
    this.reading = run().finally(() => { this.reading = null; });
    return this.reading;
  }

  /** A read connection for the studio's polling: the automation's own connection when it is open, else one kept for
   *  30 s after the last read (so a status poll every few seconds doesn't open a new OBS session each time). */
  private reader: ObsClient | null = null;
  private readerKey = '';
  private readerIdle: NodeJS.Timeout | null = null;
  private readerOpening: { key: string; p: Promise<ObsClient> } | null = null;
  private async readConn(): Promise<ObsClient> {
    if (this.client?.open) return this.client;
    const k = `${this.cfg.url}|${this.cfg.password}`;
    if (!(this.reader?.open && this.readerKey === k)) {
      if (this.readerOpening?.key === k) return this.readerOpening.p;          // two readers at once share one session
      this.dropReader();
      const c = new ObsClient();
      const p = c.connect(this.cfg.url, this.cfg.password, 4000).then(() => {
        this.reader = c; this.readerKey = k;
        c.onClose = () => { if (this.reader === c) this.reader = null; };
        return c;
      });
      this.readerOpening = { key: k, p };
      try { await p; } finally { if (this.readerOpening?.p === p) this.readerOpening = null; }
    }
    if (this.readerIdle) clearTimeout(this.readerIdle);
    this.readerIdle = setTimeout(() => this.dropReader(), 30_000);
    this.readerIdle.unref?.();
    return this.reader!;
  }
  /** The shared read-only connection (above): the fast window feed (server/screenFeed.ts) follows its OBS capture source
   *  with it, every 10 s, instead of opening a new obs-websocket session (+ authentication) each time. */
  readClient(): Promise<ObsClient> { return this.readConn(); }
  private dropReader() { if (this.readerIdle) { clearTimeout(this.readerIdle); this.readerIdle = null; } this.reader?.close(); this.reader = null; this.readerKey = ''; }

  /** "Connect OBS" status (no password, ever). */
  async statusView(): Promise<ObsStatus> {
    const r = await this.scenes(4000);
    const connected = r.ok;
    return {
      enabled: this.cfg.enabled, hasPassword: !!this.cfg.password || this.lastRead?.authRequired === false, connected,
      version: r.version ?? this.status.version ?? null, obsVersion: this.obsVersion, error: connected ? null : r.error ?? null,
      fix: connected ? null : r.fix ?? null, connectPage: '/obs/connect',
    };
  }

  /** Is OBS streaming or recording right now (so nothing restarts mid-stream)? null = can't tell (OBS
   *  was never connected through VTube Pro, or it doesn't answer). Read-only: GetStreamStatus + GetRecordStatus. */
  async outputActive(): Promise<boolean | null> { const r = await this.outputLive(); return r ? r.on : null; }

  /** outputActive plus, when live, since when: OBS's own output clock (the longer of stream / recording), so a caller
   *  can tell one long stream from a new one after OBS restarted or was out of reach. */
  async outputLive(): Promise<{ on: true; startedAt?: number } | { on: false } | null> {
    if (!this.cfg.enabled && !this.lastRead?.scenes.ok) return null;
    try {
      const c = await this.readConn();
      type Out = { outputActive?: boolean; outputDuration?: number };
      const [s, r] = await Promise.all([
        c.request<Out>('GetStreamStatus', undefined, 2500),
        c.request<Out>('GetRecordStatus', undefined, 2500).catch(() => null),
      ]);
      if (s?.outputActive || r?.outputActive) {
        const ms = Math.max(...[s, r].map((o) => (o?.outputActive && Number.isFinite(o.outputDuration) && o.outputDuration! >= 0 ? o.outputDuration! : -1)));
        return ms >= 0 ? { on: true, startedAt: Date.now() - ms } : { on: true };
      }
      // (a recording state that couldn't be read is unknown, never "not recording")
      return r ? { on: false } : null;
    } catch { return null; }
  }

  /** A click in the studio: put this scene on program. Only names OBS itself lists are accepted. */
  async switchTo(sceneName: string): Promise<{ ok: boolean; current?: string | null; error?: string; status?: number }> {
    const list = await this.scenes(0);
    if (!list.ok) return { ok: false, error: list.error ?? 'OBS is not connected', status: 503 };
    if (!list.scenes.includes(sceneName)) return { ok: false, error: `OBS has no scene called “${sceneName}”.`, status: 404 };
    try {
      const c = await this.readConn();
      await c.request('SetCurrentProgramScene', { sceneName });
      this.note('ok', `scene → ${sceneName} (clicked in the studio)`);
      this.lastRead = null;
      return { ok: true, current: sceneName };
    } catch (e) { return { ok: false, error: (e as Error).message, status: 502 }; }
  }

  switcherView(): ObsSwitcher {
    const c = this.cfg;
    return { enabled: c.enabled, switchScenes: c.switchScenes, talkScene: c.talkScene, reactScene: c.reactScene, lightingMap: { ...c.lightingMap },
      sceneMap: effectiveMap(c), recordReminder: !!c.recordReminder, reviewed: !!c.reviewed };
  }

  /** The auto switcher's settings only (no address, no password: those stay on this PC's page). Turning switching on
   *  also turns the automation on — that is what the user asked for with one click. */
  updateSwitcher(u: ObsSwitcherUpdate) {
    const next: ObsUpdate = {};
    if (typeof u.switchScenes === 'boolean') { next.switchScenes = u.switchScenes; if (u.switchScenes) next.enabled = true; }
    if (typeof u.enabled === 'boolean') next.enabled = u.enabled;
    if (typeof u.talkScene === 'string') next.talkScene = u.talkScene;
    if (typeof u.reactScene === 'string') next.reactScene = u.reactScene;
    if (u.lightingMap && typeof u.lightingMap === 'object') next.lightingMap = u.lightingMap;
    if (u.sceneMap && typeof u.sceneMap === 'object') {
      // the wizard's map (look -> scene); the older Talk / React fields mirror it so every screen agrees
      const m = sanitizeSceneMap(u.sceneMap);
      next.sceneMap = m;
      if (typeof u.talkScene !== 'string') next.talkScene = m.talk ?? '';
      if (typeof u.reactScene !== 'string') next.reactScene = m.react ?? '';
    } else if (typeof u.talkScene === 'string' || typeof u.reactScene === 'string') {
      const m = { ...(this.cfg.sceneMap ?? {}) };
      if (typeof u.talkScene === 'string') { if (u.talkScene) m.talk = u.talkScene; else delete m.talk; }
      if (typeof u.reactScene === 'string') { if (u.reactScene) m.react = u.reactScene; else delete m.react; }
      next.sceneMap = m;
    }
    if (typeof u.recordReminder === 'boolean') next.recordReminder = u.recordReminder;
    if (typeof u.reviewed === 'boolean') next.reviewed = u.reviewed;
    this.update(next);
    return this.switcherView();
  }

  /** The helper page's "Find it for me": OBS keeps its obs-websocket settings (port, password) in a file in the user's
   *  own OBS folder. Read it on this PC, save what's needed in config/obs.json, never send the password anywhere. */
  async detect(env: NodeJS.ProcessEnv = process.env): Promise<ObsDetect> {
    const r = readObsRemoteSettings(env);
    if (!r.found) return { found: false, error: 'We couldn’t find OBS’s WebSocket settings on this computer. Open OBS once, then Tools → WebSocket Server Settings.', where: 'OBS → Tools → WebSocket Server Settings' };
    // the address is always this computer + OBS's own port: nothing a page sends can point it elsewhere
    // (no password needed: remember that, so the in-scene feed may read OBS with "Automate OBS" off — canRead)
    this.update({ url: `ws://127.0.0.1:${r.port}`, ...(r.auth && r.password ? { password: r.password } : {}), ...(!r.auth ? { clearPassword: true } : {}) }, !r.auth);
    this.lastRead = null;
    const test = r.enabled ? await this.scenes(0) : undefined;
    return { found: true, serverEnabled: r.enabled, port: r.port, authRequired: r.auth, saved: true, test };
  }

  // ---------------------------------------------------------------- "Set up OBS" wizard (server/obsSetup.ts)
  /** Run OBS requests for the wizard (after a click): serialised with the automation, on the shared read connection.
   *  The next read sees the change. */
  session<T>(fn: (c: ObsClient) => Promise<T>): Promise<T> {
    const out = this.chain.then(async () => fn(await this.readConn()));
    this.chain = out.then(() => undefined, () => undefined);
    return out.finally(() => { this.lastRead = null; });
  }
  /** Read-only requests for the wizard's status, on the shared read connection. */
  async readOnly<T>(fn: (c: ObsClient) => Promise<T>): Promise<T> { return fn(await this.readConn()); }

}

export const obs = new ObsAutomation();

export const obsRoutes = Router();
obsRoutes.use(obsReadGuard); // reads that open an OBS connection: this PC only (packaging-fixes)
obsRoutes.use(obsWriteGuard); // no OBS password / address changes from a web page (lane obs-web, below)
obsRoutes.get('/api/obs', (req, res) => { requireLocal(req); res.json(obs.view()); });
obsRoutes.put('/api/obs', (req, res) => { requireLocal(req); obs.update((req.body ?? {}) as ObsUpdate); res.json(obs.view()); });
obsRoutes.post('/api/obs/probe', async (req, res) => {
  requireLocal(req);
  const b = (req.body ?? {}) as { url?: unknown; password?: unknown };
  res.json(await obs.probe(typeof b.url === 'string' ? b.url : undefined, typeof b.password === 'string' ? b.password : undefined));
});
obsRoutes.get('/api/obs/diagnose', async (req, res) => { requireLocal(req); res.json(await obs.diagnose()); });
obsRoutes.post('/api/obs/test', async (req, res) => {
  requireLocal(req);
  if (!obs.cfg.enabled) { res.json({ ok: false, steps: [], warnings: [], error: 'OBS automation is off.' }); return; }
  res.json(await obs.test());
});
obsRoutes.post('/api/obs/fit', async (req, res) => {
  requireLocal(req);
  const b = (req.body ?? {}) as { source?: unknown; rect?: Record<string, unknown> | null; fit?: unknown };
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(2, Math.max(-1, v)) : null);
  const r = b.rect && typeof b.rect === 'object' ? { x: n(b.rect.x), y: n(b.rect.y), w: n(b.rect.w), h: n(b.rect.h) } : null;
  const rect = r && r.x !== null && r.y !== null && r.w !== null && r.h !== null && r.w > 0 && r.h > 0 ? (r as { x: number; y: number; w: number; h: number }) : null;
  res.json(await obs.fit(typeof b.source === 'string' ? b.source.slice(0, 256) : '', rect, b.fit === 'fill' ? 'fill' : 'fit'));
});
/** POST /api/obs/hole body → hole() arguments. Coordinates are NOT clamped into the frame any more (a clamp turned an
 *  off-shot screen into a plausible-looking box that was then shown off the canvas): finite values pass through (bounded
 *  only against absurd sizes) and hole() hides the capture for anything outside the picture. */
export function parseHoleReport(body: unknown) {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100 ? v : null);
  const rr = b.rect && typeof b.rect === 'object' ? b.rect as Record<string, unknown> : null;
  const r = rr ? { x: n(rr.x), y: n(rr.y), w: n(rr.w), h: n(rr.h) } : null;
  const rect = r && r.x !== null && r.y !== null && r.w !== null && r.h !== null && r.w > 0 && r.h > 0 ? (r as { x: number; y: number; w: number; h: number }) : null;
  const qa = b.quad;
  const quad = Array.isArray(qa) && qa.length === 4 && qa.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => n(v) !== null)) ? (qa as [number, number][]).map(([x, y]) => [x, y] as Pt) : null;
  const modeOk = (x: unknown): x is string => typeof x === 'string' && /^[a-z][a-z0-9-]{1,23}$/.test(x);
  const mode = modeOk(b.mode) ? b.mode : 'react';
  const visible = typeof b.visible === 'boolean' ? b.visible : rr && typeof rr.visible === 'boolean' ? rr.visible : undefined;
  const v = typeof b.v === 'number' && Number.isFinite(b.v) ? Math.max(1, Math.min(99, Math.round(b.v))) : 1;
  // v3: what the page shows now (a party guest's pages show the host's room — server/obs.ts HoleShows)
  const sh = v >= 3 && b.shows && typeof b.shows === 'object' ? b.shows as Record<string, unknown> : null;
  const shows: HoleShows | null = sh && modeOk(sh.mode) ? { mode: sh.mode, room: sh.room === true, hole: sh.hole === true, party: sh.party === true } : null;
  return { open: b.open === true, rect, layout: b.layout === 'solo' ? 'solo' : b.layout === 'stage' ? 'stage' : 'big', quad, mode, visible, v, shows };
}
obsRoutes.post('/api/obs/hole', async (req, res) => {
  requireLocalOrStreamPc(req);
  // An output page on a paired STREAM PC is display-only (security review 2026-10-08): its report never moves or hides
  // the OBS capture. It is told "no passthrough here", so it draws the React screen in the room (fast feed / shared window).
  if (streamPcOf(req)) { res.json({ ok: true, enabled: false, pin: false, refused: STREAM_PC_NO_HOLE }); return; }
  const h = parseHoleReport(req.body);
  obs.hole(h.open, h.rect, h.layout, h.quad, h.mode, h.visible, h.v, h.shows);
  // an open React hole: answered once OBS has placed the capture (≤ 2.5 s) — `refused` = it is NOT shown there (an
  // angle a box can't match, off the OBS picture …): the page draws that screen in the room, no empty see-through hole
  const refused = h.open && h.rect && h.mode === 'react' && obs.cfg.enabled ? await obs.holeVerdict(2500) : null;
  res.json({ ok: true, enabled: obs.cfg.enabled, pin: obs.pinReady(), ...(refused ? { refused } : {}) });
});
/** Interview → "Fit my Window Capture → <guest>" (an explicit click in the studio): place the capture on the monitor
 *  panel's corners in that guest's close-up (ObsPlaceReport says where and how close a plain box gets). */
obsRoutes.post('/api/obs/place', async (req, res) => {
  requireLocal(req);
  const h = parseHoleReport({ ...((req.body && typeof req.body === 'object') ? req.body : {}), open: true });
  if (!h.rect) { res.status(400).json({ ok: false, error: 'No rect.' }); return; }
  res.json(await obs.placeAt(h.rect, h.quad));
});
/** The OBS output page asks before it would open a passthrough hole: is the automation on, and can it warp the capture
 *  onto an angled screen's exact corners (corner-pin)? Without that, only a straight-on screen may use passthrough.
 *  `pin` null = not known yet (asked, waited ≤ 1.5 s): the page keeps what it had and asks again soon. `refused` = the
 *  open React hole gets no capture (the page draws that screen in the room). */
obsRoutes.get('/api/obs/hole', async (req, res) => {
  requireLocalOrStreamPc(req); res.setHeader('Cache-Control', 'no-store');
  if (streamPcOf(req)) { res.json({ enabled: false, pin: false, refused: STREAM_PC_NO_HOLE }); return; } // display-only (see POST)
  obs.pageSaw(req.query as Record<string, unknown>);                  // (what the page's React screen shows + why)
  const [pin, native] = await Promise.all([obs.pinAnswer(1500), obs.reachable(1500)]);
  const refused = obs.refusedNow();
  // native: automation places the capture AND OBS answers now (Auto's native passthrough, src/scene/screenFeed.ts nativePassFor)
  res.json({ enabled: obs.cfg.enabled && !!obs.cfg.captureSource, native, pin, ...(refused ? { refused } : {}) });
});

// ---------------------------------------------------------------- the OBS password and address
// The OBS password never goes through a web page (server/localGuard.ts isWebOrigin):
//   * from any Origin that is not a page on this PC, a write may not set / clear the
//     password or point VTube Pro at another obs-websocket address (that would hand the stored password to it);
//   * the helper's own page /obs/connect (top-level, this PC only) is where it is typed or found.
// Everything else (scene list, current scene, a scene switch on a click, the auto switcher's settings) is open to the
// studio on this PC: server/localGuard.ts already answers other sites 403 before this runs.

const LOOPBACK_PAGE = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)*\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i;
/** An Origin that is not a page on this PC (no Origin = curl / OBS / tools = this PC). */
export function obsWebOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return false;
  if (origin === 'null') return true;
  try { return !LOOPBACK_PAGE.test(new URL(origin).hostname); } catch { return true; }
}
export type ObsWriteVerdict = { ok: true } | { ok: false; status: 403; code: 'local-only'; error: string };
const LOCAL_ONLY_MSG = 'Your OBS password is only entered in VTube Pro on your computer, never on a website. Open VTube Pro’s OBS page (it opens in a new tab).';
/** Pure policy (tools/obs_web_unit.ts): may this request change the OBS password / address? */
export function checkObsWrite(method: string, pathName: string, origin: string | undefined, body: unknown, currentUrl: string): ObsWriteVerdict {
  if (!obsWebOrigin(origin) || ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return { ok: true };
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const no: ObsWriteVerdict = { ok: false, status: 403, code: 'local-only', error: LOCAL_ONLY_MSG };
  if (/^\/api\/obs\/local(\/|$)/.test(pathName) || /^\/obs\/connect\/?$/.test(pathName)) return no;
  if (pathName === '/api/obs') {
    if (typeof b.password === 'string' && b.password !== '') return no;
    if (b.clearPassword === true) return no;
    if (typeof b.url === 'string' && b.url.trim() !== '' && b.url.trim() !== currentUrl) return no;
  }
  if (pathName === '/api/obs/probe' && ((typeof b.url === 'string' && b.url.trim() !== '') || (typeof b.password === 'string' && b.password !== ''))) return no;
  return { ok: true };
}

// Reads: GET /api/obs/scenes, /scene, /status, /diagnose ... make the HELPER open a connection to OBS (with the stored
// password). localGuard lets every GET through for non-web origins (a GET changes nothing in VTube Pro), and another
// site's no-cors fetch / <img> sends no Origin at all, only `Sec-Fetch-Site: cross-site`. So without this guard a
// foreign page could make the helper dial OBS over and over (its answer is unreadable, but the connection happens).
// Rule, decided BEFORE any handler runs: a read is served only to a page on this PC (loopback Origin or
// VTP_ALLOWED_ORIGINS), or a caller with no Origin that is not a cross-site / same-site browser fetch (curl, Stream Deck,
// OBS, tools). Anything else gets 403.
export type ObsReadVerdict = { ok: true } | { ok: false; status: 403; code: 'foreign'; error: string };
export function checkObsRead(method: string, pathName: string, headers: { origin?: string | string[]; 'sec-fetch-site'?: string | string[] },
  env: NodeJS.ProcessEnv = process.env): ObsReadVerdict {
  const m = method.toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return { ok: true }; // writes: localGuard (Origin / cross-site) + obsWriteGuard
  if (!/^\/api\/obs(\/|$)/.test(pathName)) return { ok: true };
  const origin = typeof headers.origin === 'string' ? headers.origin : undefined;
  const no = (error: string): ObsReadVerdict => ({ ok: false, status: 403, code: 'foreign', error });
  if (origin !== undefined && origin !== '') {
    if (origin !== 'null' && originOk(origin, env)) return { ok: true };
    return no(`Origin "${origin}" may not read OBS through VTube Pro`);
  }
  const site = String(headers['sec-fetch-site'] ?? '');
  if (site === 'cross-site' || site === 'same-site') return no('Cross-site request refused');
  return { ok: true };
}
export function obsReadGuard(req: Request, res: import('express').Response, next: import('express').NextFunction) {
  const v = checkObsRead(req.method, (req.url ?? '').split('?')[0], req.headers);
  if (!v.ok) { res.status(v.status).json({ error: v.error, code: v.code }); return; }
  next();
}

/** Mounted FIRST on obsRoutes (see the top of the route list), after express.json(). */
export function obsWriteGuard(req: Request, res: import('express').Response, next: import('express').NextFunction) {
  const p = (req.url ?? '').split('?')[0];
  if (!/^\/(api\/obs|obs\/)/.test(p)) { next(); return; }
  const v = checkObsWrite(req.method, p, typeof req.headers.origin === 'string' ? req.headers.origin : undefined, req.body, obs.cfg.url);
  if (!v.ok) { res.status(v.status).json({ error: v.error, code: v.code }); return; }
  next();
}

const sceneName = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f]/.test(v) ? v : null);
obsRoutes.get('/api/obs/status', async (req, res) => {
  requireLocal(req); res.setHeader('Cache-Control', 'no-store');
  res.json({ ...(await obs.statusView()), outputs: outputPages() });
});
obsRoutes.get('/api/obs/outputs', (req, res) => { requireLocal(req); res.setHeader('Cache-Control', 'no-store'); res.json(outputPages()); });
obsRoutes.get('/api/obs/scenes', async (req, res) => { requireLocal(req); res.setHeader('Cache-Control', 'no-store'); res.json(await obs.scenes()); });
obsRoutes.get('/api/obs/scene', async (req, res) => {
  requireLocal(req); res.setHeader('Cache-Control', 'no-store');
  const r = await obs.scenes();
  res.json(r.ok ? { ok: true, current: r.current } : { ok: false, current: null, error: r.error, fix: r.fix });
});
obsRoutes.post('/api/obs/scene', async (req, res) => {
  requireLocal(req);
  const name = sceneName((req.body as { sceneName?: unknown } | undefined)?.sceneName);
  if (!name) { res.status(400).json({ ok: false, error: 'Which OBS scene? (sceneName)' }); return; }
  const r = await obs.switchTo(name);
  res.status(r.ok ? 200 : r.status ?? 500).json({ ok: r.ok, current: r.current ?? null, ...(r.error ? { error: r.error } : {}) });
});
obsRoutes.get('/api/obs/switcher', (req, res) => { requireLocal(req); res.json(obs.switcherView()); });
obsRoutes.put('/api/obs/switcher', (req, res) => {
  requireLocal(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const u: ObsSwitcherUpdate = {};
  if (typeof b.enabled === 'boolean') u.enabled = b.enabled;
  if (typeof b.switchScenes === 'boolean') u.switchScenes = b.switchScenes;
  if (typeof b.talkScene === 'string') u.talkScene = b.talkScene.slice(0, 256);
  if (typeof b.reactScene === 'string') u.reactScene = b.reactScene.slice(0, 256);
  if (b.lightingMap && typeof b.lightingMap === 'object' && !Array.isArray(b.lightingMap)) u.lightingMap = b.lightingMap as Record<string, string>;
  // "Set up OBS" wizard (lane obs-wizard): look → scene map, recording reminders, step 6 reviewed
  if (b.sceneMap && typeof b.sceneMap === 'object' && !Array.isArray(b.sceneMap)) u.sceneMap = b.sceneMap as Record<string, string>;
  if (typeof b.recordReminder === 'boolean') u.recordReminder = b.recordReminder;
  if (typeof b.reviewed === 'boolean') u.reviewed = b.reviewed;
  res.json(obs.updateSwitcher(u));
});

// ---- VTube Pro's own OBS page (this PC only; the password is typed or found HERE, never in the studio tab)
const connectNonce = crypto.randomBytes(24).toString('base64url');
/** The helper's own OBS pages (this PC only): /obs/connect, /obs/setup (server/obsSetup.ts). */
export function connectLocal(req: Request, page = false) {
  const o = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (o && obsWebOrigin(o)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return page && req.headers['sec-fetch-mode'] === 'navigate' && req.method === 'GET';
  return true;
}
/** The per-process nonce the helper's own OBS pages send with /api/obs/local/* (server/obsSetup.ts hands it out). */
export const obsConnectNonce = () => connectNonce;
const connectNonceOk = (req: Request) => {
  const n = (req.body as { nonce?: unknown } | undefined)?.nonce;
  return typeof n === 'string' && n.length === connectNonce.length && crypto.timingSafeEqual(Buffer.from(n), Buffer.from(connectNonce));
};
obsRoutes.get(['/obs/connect', '/obs/connect/'], (req, res) => {
  requireLocal(req);
  if (!connectLocal(req, true)) { res.status(403).json({ error: 'Open this page on this PC' }); return; }
  const sn = crypto.randomBytes(16).toString('base64url');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${sn}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // ?url=ws://<stream PC>:4455 (the "Streaming from a second PC" card) only fills the field; nothing is saved before "Test and save"
  const pre = typeof req.query.url === 'string' && req.query.url.length < 80 && /^wss?:\/\/[\w.\-[\]:]+$/.test(req.query.url) ? req.query.url : obs.cfg.url;
  res.type('html').send(CONNECT_PAGE.replace('__SN__', sn).replace('__NONCE__', connectNonce).replace('__URL__', JSON.stringify(pre).replace(/</g, '\\u003c')));
});
obsRoutes.post('/api/obs/local/detect', async (req, res) => {
  requireLocal(req);
  if (!connectLocal(req) || !connectNonceOk(req)) { res.status(403).json({ error: 'Open this page on this PC' }); return; }
  const r = await obs.detect();
  if (r.test?.ok && !obs.cfg.enabled) obs.update({ enabled: true });
  res.json(r);
});
obsRoutes.post('/api/obs/local/save', async (req, res) => {
  requireLocal(req);
  if (!connectLocal(req) || !connectNonceOk(req)) { res.status(403).json({ error: 'Open this page on this PC' }); return; }
  const b = (req.body ?? {}) as { url?: unknown; password?: unknown };
  const url = typeof b.url === 'string' && b.url.trim() ? b.url.trim() : undefined;
  if (url && !/^wss?:\/\/[\w.\-[\]:]+(\/[\w\-./]*)?$/.test(url)) { res.status(400).json({ ok: false, error: 'That address doesn’t look like ws://127.0.0.1:4455' }); return; }
  obs.update({ ...(url ? { url } : {}), ...(typeof b.password === 'string' && b.password ? { password: b.password.slice(0, 256) } : {}) });
  const test = await obs.scenes(0);
  if (test.ok && !obs.cfg.enabled) obs.update({ enabled: true });
  res.json({ ...test, saved: true });
});

const CONNECT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VTube Pro · Connect OBS</title>
<style>
:root{color-scheme:dark;--bg:#07090c;--card:#0f1418;--ink:#eef3ef;--mute:#9aa6a0;--line:#1f2a2f;--ok:#7bd88f;--accent:#7bd88f;--err:#ff8a7a}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;min-height:100vh;background:radial-gradient(1200px 600px at 20% -10%,#12301e55,transparent),var(--bg);color:var(--ink);font:16px/1.5 Inter,system-ui,Segoe UI,sans-serif}
main{max-width:600px;margin:0 auto;padding:32px 16px 48px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.2px}.beta{border:1px solid #7bd88f4d;background:#7bd88f1a;color:var(--ok);font:500 10px/1 ui-monospace,Consolas,monospace;letter-spacing:.08em;text-transform:uppercase;padding:4px 7px;border-radius:99px}
h1{font-size:26px;margin:22px 0 6px}p{color:var(--mute);margin:6px 0}b{color:var(--ink)}
section{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin:16px 0}
.step{font-size:12px;letter-spacing:.4px;text-transform:uppercase;color:var(--accent);font-weight:700}
button{font:600 16px/1 Inter,system-ui,Segoe UI,sans-serif;border-radius:12px;padding:14px 20px;border:1px solid var(--line);background:#141b20;color:var(--ink);cursor:pointer;width:100%}
button.primary{background:linear-gradient(90deg,#7bd88f,#6cc7f5);color:#06121a;border-color:transparent}button:disabled{opacity:.6;cursor:progress}
input{font:inherit;width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:#0a0e11;color:var(--ink);margin:6px 0 10px}
details summary{cursor:pointer;color:var(--mute)}label{font-size:14px;color:var(--mute)}
#out{margin-top:12px;font-size:15px}#out.ok{color:var(--ok)}#out.err{color:var(--err)}.scenes{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.scenes span{border:1px solid var(--line);border-radius:99px;padding:4px 10px;font-size:13px;color:var(--mute)}.scenes span.on{border-color:var(--ok);color:var(--ok)}
small{color:var(--mute)}
</style></head><body><main>
<div class="brand">VTube Pro <span class="beta">Beta</span></div>
<h1>Connect VTube Pro to OBS</h1>
<p>This lets VTube Pro read your OBS scenes and switch them for you. It stays on this computer: your OBS password is <b>never</b> sent to a website.</p>
<section><div class="step">Easiest</div>
<p>VTube Pro can read the password from OBS's own settings on this computer.</p>
<button class="primary" id="find">Find it for me</button></section>
<section><details><summary>Type it myself</summary>
<p>In OBS: <b>Tools</b> → <b>WebSocket Server Settings</b> → tick <b>Enable WebSocket server</b> → <b>Show Connect Info</b> → copy the password.</p>
<label for="pw">Server password</label><input id="pw" type="password" autocomplete="off" placeholder="Paste the password from OBS">
<label for="url">Server address (leave as is)</label><input id="url" type="text" spellcheck="false">
<button id="save">Test and save</button></details></section>
<div id="out" role="status"></div>
<p><small>To forget it later: Studio on this PC → Room → Advanced → OBS automation → clear the password.</small></p>
</main>
<script nonce="__SN__">
const NONCE='__NONCE__';const $=(id)=>document.getElementById(id);$('url').value=__URL__;
const el=(t,x,c)=>{const e=document.createElement(t);if(x!=null)e.textContent=x;if(c)e.className=c;return e};
function show(r){const o=$('out');o.replaceChildren();
 if(r&&r.ok){o.className='ok';o.append(el('div','✔ Connected to OBS'+(r.version?' (WebSocket '+r.version+')':'')+' — '+r.scenes.length+' scene'+(r.scenes.length===1?'':'s')+'. You can close this tab and go back to VTube Pro.'));
  const s=el('div',null,'scenes');for(const n of r.scenes)s.append(el('span',n,n===r.current?'on':''));o.append(s);return}
 o.className='err';o.append(el('div','✕ '+((r&&(r.fix||r.error))||'That didn’t work. Is OBS open?')))}
async function post(u,b){const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...b,nonce:NONCE})});return r.json()}
$('find').onclick=async()=>{const b=$('find');b.disabled=true;b.textContent='Looking…';
 try{const r=await post('/api/obs/local/detect',{});
  if(!r.found){show({ok:false,fix:r.error})}else if(!r.serverEnabled){show({ok:false,fix:'Found OBS, but its WebSocket server is off: in OBS tick Tools → WebSocket Server Settings → Enable WebSocket server, then press Find it for me again.'})}else show(r.test)}
 catch{show({ok:false,fix:'VTube Pro didn’t answer. Is it still running?'})}finally{b.disabled=false;b.textContent='Find it for me'}};
$('save').onclick=async()=>{const b=$('save');b.disabled=true;b.textContent='Testing…';
 try{const r=await post('/api/obs/local/save',{url:$('url').value,password:$('pw').value});$('pw').value='';show(r)}
 catch{show({ok:false,fix:'VTube Pro didn’t answer. Is it still running?'})}finally{b.disabled=false;b.textContent='Test and save'}};
</script></body></html>`;
