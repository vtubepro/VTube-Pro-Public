// Gaming at 60 FPS, OBS side (lane b15-gaming). Looks at the Game Capture in the scene OBS is showing, and when it shows
// nothing (not hooked / black) offers ONE click to a Display Capture or Window Capture instead; also the OBS-side advice for
// a lag-free stream (encoder, browser source rate, shutdown-when-hidden, canvas rescale, run OBS as administrator).
//
//   GET  /api/obs/gaming        → GamingStatus (read-only: Get* requests only, never changes OBS)
//   POST /api/obs/gaming/plan   → { source? } → FallbackPreview (what WOULD happen, in one sentence; changes nothing)
//   POST /api/obs/gaming/apply  → { planId, source? } → creates the Display/Window Capture beside the Game Capture, puts it in
//                                 the Game Capture's place, HIDES the Game Capture (never deletes it), remembers the choice
//                                 for this game's executable (next time it is automatic while OBS automation is on)
//   POST /api/obs/gaming/fix    → { action, vendor? } → one OBS setting from the advice list (each is undoable)
//   POST /api/obs/gaming/undo   → the latest change: removes only the capture this made, shows the Game Capture again,
//                                 puts a changed setting back
//   POST /api/obs/gaming/snooze → { source, minutes } "not now"
//
// Rules: nothing here starts, stops or elevates OBS; a source the user made is never removed; the OBS password is never
// sent anywhere; obs-websocket v5 requests only (GetSourceActive, GetSourceScreenshot, CreateInput, SetSceneItemIndex,
// SetInputSettings, GetProfileParameter / SetProfileParameter, SetVideoSettings, GetStats …). Memory + undo journal:
// config/obs-gaming.json on this PC. Pure decisions: shared/gamingCapture.ts.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { obs, obsReadGuard, obsWebsocketConfigFile, obsWriteGuard, type ObsClient } from './obs.ts';
import { obsElsewhere } from './obsSetup.ts';
import { currentGame } from './gameWindow.ts';
import { decodeShot } from './gameShot.ts';
import { requireLocal } from './routes/util.ts';
import { CONFIG_DIR } from './paths.ts';
import { isVtpUrl } from '../shared/obsSetup.ts';
import {
  ADMIN_STEPS, BlankTracker, blockerHint, browserAdvice, choiceFor, decideOffer, encoderAdvice, forgetChoice, judgeGameCapture, lumaStat,
  monitorItems, parseObsLog, parseObsWindow, planFallback, rememberChoice, rescaleAdvice, sanitizeMemory, statsAdvice, SIMPLE_HW,
  type Advice, type BlockerHint, type FallbackKind, type FallbackPlan, type GameMemory, type GameWindow, type GamingStatus, type MonitorItem, type ObsStats, type Offer, type VideoInfo,
} from '../shared/gamingCapture.ts';
export type { GamingStatus };

// ---------------------------------------------------------------- journal + memory (config/obs-gaming.json)
type Restore =
  | { op: 'input'; name: string; settings: Record<string, unknown> }
  | { op: 'profile'; category: string; name: string; value: string }
  | { op: 'video'; baseW: number; baseH: number };
interface FallbackGroup { id: string; at: string; label: string; type: 'fallback'; scene: string; input: string; itemId: number; inputKind: string; gc: { name: string; id: number; wasEnabled: boolean }; exe: string; kind: FallbackKind }
interface SettingGroup { id: string; at: string; label: string; type: 'setting'; restore: Restore[] }
type Group = FallbackGroup | SettingGroup;
interface Store { memory: GameMemory; groups: Group[] }
const FILE = () => path.join(CONFIG_DIR, 'obs-gaming.json');
function readStore(): Store {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8')) as { memory?: unknown; groups?: unknown };
    return { memory: sanitizeMemory(j.memory), groups: Array.isArray(j.groups) ? (j.groups as Group[]).filter((g) => g && typeof g.id === 'string' && (g.type === 'fallback' || g.type === 'setting')).slice(-20) : [] };
  } catch { return { memory: { byExe: {} }, groups: [] }; }
}
function writeStore(s: Store) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify({ memory: s.memory, groups: s.groups.slice(-20) }, null, 2), { mode: 0o600 });
}
const newId = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** One plain sentence for an OBS refusal. */
function plain(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/not connected|closed|timed out|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|connection failed|did not answer/i.test(m)) return 'OBS stopped answering. Is it still open? Then try again.';
  if (/password|4009|auth/i.test(m)) return 'OBS didn’t accept the saved password. Open VTube Pro’s OBS page and press “Find it for me”.';
  return `OBS said no: ${m.replace(/^\w+: /, '').slice(0, 160)}`;
}
/** An obs-websocket that doesn't know the request (an old OBS: code 204 UnknownRequestType / “not implemented”). */
const unknownRequest = (e: unknown) => /unknown request|not implemented|204|not supported|no such request/i.test((e as Error)?.message ?? '');

// ---------------------------------------------------------------- reading OBS
interface SceneItem { sourceName: string; sceneItemId: number; sceneItemIndex: number; sceneItemEnabled: boolean; inputKind?: string | null; sceneItemTransform: Record<string, unknown> }
const EMPTY_OFFER: Offer = { kind: 'none', text: '' };

let nowFn: () => number = () => Date.now();
/** Tests: a clock they can move (the blank check needs seconds of blank, the test does not wait them). */
export function setGamingClock(f: (() => number) | null) { nowFn = f ?? (() => Date.now()); }
const tracker = new BlankTracker();
const snooze = new Map<string, number>();
const SNOOZE_MAX_MIN = 240;

async function shot(c: ObsClient, source: string, formats: string[] | null) {
  const fmt = ['png', 'bmp', 'ppm'].find((f) => !formats || formats.includes(f));
  if (!fmt) return null;
  try {
    const r = await c.request<{ imageData?: string }>('GetSourceScreenshot', { sourceName: source, imageFormat: fmt, imageWidth: 32, imageHeight: 18, imageCompressionQuality: -1 }, 4000);
    const px = decodeShot(r.imageData);
    return px ? lumaStat(px.data) : null;
  } catch { return null; }
}

async function programScene(c: ObsClient): Promise<string> {
  const r = await c.request<{ currentProgramSceneName?: string; sceneName?: string }>('GetCurrentProgramScene');
  return r.currentProgramSceneName ?? r.sceneName ?? '';
}
const itemsOf = async (c: ObsClient, scene: string) => (await c.request<{ sceneItems?: SceneItem[] }>('GetSceneItemList', { sceneName: scene })).sceneItems ?? [];

/** The Game Capture to follow in a scene: the configured capture source if it is one, else the first shown one, else the first. */
export function pickGameCapture(items: SceneItem[], preferred: string): SceneItem | null {
  const gcs = items.filter((i) => i.inputKind === 'game_capture');
  return gcs.find((i) => i.sourceName === preferred) ?? gcs.find((i) => i.sceneItemEnabled) ?? gcs[0] ?? null;
}

async function videoInfo(c: ObsClient): Promise<VideoInfo | null> {
  try {
    const v = await c.request<{ baseWidth: number; baseHeight: number; outputWidth: number; outputHeight: number; fpsNumerator?: number; fpsDenominator?: number }>('GetVideoSettings');
    return { baseW: v.baseWidth, baseH: v.baseHeight, outW: v.outputWidth ?? v.baseWidth, outH: v.outputHeight ?? v.baseHeight, fps: v.fpsNumerator && v.fpsDenominator ? v.fpsNumerator / v.fpsDenominator : 60 };
  } catch { return null; }
}
async function outputsBusy(c: ObsClient): Promise<boolean> {
  const a = await c.request<{ outputActive?: boolean }>('GetStreamStatus').catch(() => null);
  const b = await c.request<{ outputActive?: boolean }>('GetRecordStatus').catch(() => null);
  return !!a?.outputActive || !!b?.outputActive;
}
async function profileParam(c: ObsClient, category: string, name: string): Promise<string | null | undefined> {
  try { const r = await c.request<{ parameterValue?: string | null }>('GetProfileParameter', { parameterCategory: category, parameterName: name }); return r.parameterValue ?? null; }
  catch (e) { return unknownRequest(e) ? undefined : null; }      // undefined = this OBS has no such request; null = no value saved
}

/** OBS's newest log (its own folder, read-only) → admin / lag signs. null = none found. */
export function readObsLog(env: NodeJS.ProcessEnv = process.env): ReturnType<typeof parseObsLog> | null {
  try {
    const dir = path.join(path.dirname(path.dirname(path.dirname(obsWebsocketConfigFile(env)))), 'logs');
    const newest = fs.readdirSync(dir).filter((f) => /\.txt$/i.test(f)).sort().pop();
    if (!newest) return null;
    const file = path.join(dir, newest), size = fs.statSync(file).size, take = Math.min(size, 400_000);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(take);
      fs.readSync(fd, buf, 0, take, size - take);
      return parseObsLog(buf.toString('utf8'));
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

let adviceCache: { at: number; key: string; advice: Advice[]; settingsApi: boolean; video: VideoInfo | null } | null = null;
const ADVICE_MS = 20_000;
/** Tests: forget the cached advice / blank timers / snoozes. */
export function resetGamingState() { adviceCache = null; tracker.reset(); snooze.clear(); }

async function gatherAdvice(c: ObsClient, scene: string, items: SceneItem[], vendor: string | null, force: boolean): Promise<{ advice: Advice[]; settingsApi: boolean; video: VideoInfo | null }> {
  const key = `${scene}|${vendor ?? ''}|${items.map((i) => `${i.sourceName}:${i.sceneItemEnabled ? 1 : 0}`).join(',')}`;
  if (!force && adviceCache && adviceCache.key === key && Date.now() - adviceCache.at < ADVICE_MS) return adviceCache;
  const out: Advice[] = [];
  const video = await videoInfo(c);
  const streaming = await outputsBusy(c);
  const scaleType = await profileParam(c, 'Video', 'ScaleType');
  const mode = await profileParam(c, 'Output', 'Mode');
  const settingsApi = scaleType !== undefined && mode !== undefined;
  let encoder: string | null = null;
  if (settingsApi) encoder = (mode === 'Advanced' ? await profileParam(c, 'AdvOut', 'Encoder') : await profileParam(c, 'SimpleOutput', 'StreamEncoder')) ?? null;
  const modeName = mode === 'Advanced' ? 'Advanced' : mode === 'Simple' ? 'Simple' : null;
  out.push(...encoderAdvice({ mode: modeName, encoder, vendor, streaming }));
  if (video) {
    // the capture that is shown now (a Display Capture the feature made, or the user's own)
    const shown = items.find((i) => i.sceneItemEnabled && i.inputKind === 'monitor_capture') ?? null;
    let size: { w: number; h: number } | null = null, box = null as { x: number; y: number; w: number; h: number } | null;
    if (shown) {
      const t = shown.sceneItemTransform, n = (k: string) => (typeof t[k] === 'number' ? (t[k] as number) : 0);
      size = { w: Math.max(0, n('sourceWidth') - n('cropLeft') - n('cropRight')), h: Math.max(0, n('sourceHeight') - n('cropTop') - n('cropBottom')) };
      const bounded = typeof t.boundsType === 'string' && t.boundsType !== 'OBS_BOUNDS_NONE' && n('boundsWidth') > 0;
      box = { x: n('positionX'), y: n('positionY'), w: bounded ? n('boundsWidth') : n('width'), h: bounded ? n('boundsHeight') : n('height') };
      if (!(size.w > 0 && size.h > 0)) size = null;
    }
    out.push(...rescaleAdvice({ video, shown: size, box, kind: shown?.inputKind ?? '', scaleType: typeof scaleType === 'string' ? scaleType.toLowerCase() : null, streaming }));
    for (const b of items.filter((i) => i.inputKind === 'browser_source').slice(0, 8)) {
      const st = (await c.request<{ inputSettings?: Record<string, unknown> }>('GetInputSettings', { inputName: b.sourceName }).catch(() => null))?.inputSettings;
      if (st && isVtpUrl(st.url)) out.push(...browserAdvice({ name: b.sourceName, settings: st, canvasFps: video.fps }));
    }
    const stats = await c.request<ObsStats>('GetStats').catch(() => null);
    out.push(...statsAdvice(stats, video.fps));
  }
  adviceCache = { at: Date.now(), key, advice: out, settingsApi, video };
  return adviceCache;
}

export interface CheckOptions { vendor?: string | null; advice?: boolean; forceAdvice?: boolean; windowForce?: boolean }
/** The read-only look: the Game Capture's state, the offer, the advice. */
export async function gamingStatus(o: CheckOptions = {}): Promise<GamingStatus> {
  const store = readStore();
  const last = store.groups[store.groups.length - 1];
  const base = { advice: [] as Advice[], settingsApi: true, video: null as VideoInfo | null, hint: null as BlockerHint | null, snoozed: false, remembered: null as FallbackKind | null,
    admin: { notAdmin: null as boolean | null, steps: ADMIN_STEPS, renderLagPct: null as number | null }, undo: last ? { id: last.id, label: last.label } : null, elsewhere: obsElsewhere(), automation: obs.cfg.enabled && !!obs.cfg.captureSource, display: null as GamingStatus['display'] };
  if (!obs.canRead()) return { ok: false, connected: false, scene: null, capture: null, game: null, offer: EMPTY_OFFER, fallback: null, error: 'VTube Pro isn’t connected to OBS.', fix: 'Open VTube Pro’s OBS page and press “Find it for me”.', ...base };
  try {
    return await obs.readOnly(async (c): Promise<GamingStatus> => {
      const scene = await programScene(c);
      const items = await itemsOf(c, scene);
      const gc = pickGameCapture(items, obs.cfg.captureSource);
      const fb = last && last.type === 'fallback' && last.scene === scene && items.some((i) => i.sourceName === last.input) ? last : null;
      const fallback = fb ? { input: fb.input, kind: fb.kind, gameCapture: fb.gc.name, undoId: fb.id } : null;
      const log = readObsLog();
      const admin = { notAdmin: log?.notAdmin ?? null, steps: ADMIN_STEPS, renderLagPct: log?.renderLagPct ?? null };
      let adv: { advice: Advice[]; settingsApi: boolean; video: VideoInfo | null } = { advice: [], settingsApi: true, video: null };
      if (o.advice !== false) adv = await gatherAdvice(c, scene, items, o.vendor ?? null, !!o.forceAdvice);
      const shownDisplay = items.find((i) => i.sceneItemEnabled && i.inputKind === 'monitor_capture');
      const dt = shownDisplay?.sceneItemTransform ?? {}, dn = (k: string) => (typeof dt[k] === 'number' ? (dt[k] as number) : 0);
      const display = shownDisplay && dn('sourceWidth') > 0 ? { source: shownDisplay.sourceName, w: dn('sourceWidth') - dn('cropLeft') - dn('cropRight'), h: dn('sourceHeight') - dn('cropTop') - dn('cropBottom') } : null;
      const common = { ok: true, connected: true, scene, fallback, advice: adv.advice, settingsApi: adv.settingsApi, video: adv.video, admin, undo: base.undo, elsewhere: base.elsewhere, automation: base.automation, display };
      if (!gc) return { ...common, capture: null, game: null, hint: null, offer: EMPTY_OFFER, snoozed: false, remembered: null };
      // the Game Capture's own state
      const active = await c.request<{ videoActive?: boolean }>('GetSourceActive', { sourceName: gc.sourceName }).then((r) => !!r.videoActive).catch(() => null);
      const sw = Number(gc.sceneItemTransform.sourceWidth) || 0, sh = Number(gc.sceneItemTransform.sourceHeight) || 0;
      const ver = await c.request<{ supportedImageFormats?: string[] }>('GetVersion').catch(() => null);
      const luma = active === false ? null : await shot(c, gc.sourceName, ver?.supportedImageFormats ?? null);
      const judged = judgeGameCapture({ kind: 'game_capture', active: gc.sceneItemEnabled ? active : false, width: sw, height: sh, luma });
      const t = tracker.observe(`${scene}|${gc.sourceName}`, judged.state === 'blank', nowFn());
      const set = (await c.request<{ inputSettings?: Record<string, unknown> }>('GetInputSettings', { inputName: gc.sourceName }).catch(() => null))?.inputSettings ?? {};
      const win = set.capture_mode === 'window' && typeof set.window === 'string' ? parseObsWindow(set.window) : null;
      // the window scan runs only for a blank Game Capture that has stayed blank (never on a timer, never for a good one)
      let game: GameWindow | null = null;
      if (judged.state === 'blank' && t.confirmed && !fallback) game = await currentGame(win?.exe || undefined, !!o.windowForce);
      const hint = game ? blockerHint(game) : win ? blockerHint({ exe: win.exe, title: win.title, cls: win.cls }) : null;
      const remembered = game ? choiceFor(store.memory, game.exe) : null;
      const snoozed = (snooze.get(gc.sourceName) ?? 0) > nowFn();
      const offer = fallback ? { kind: 'none' as const, text: '' }
        : decideOffer({ judged, confirmed: t.confirmed, game, remembered, hint });
      return {
        ...common, capture: { source: gc.sourceName, judged, blankForMs: t.forMs, confirmed: t.confirmed, mode: typeof set.capture_mode === 'string' ? set.capture_mode : null },
        game: game ? { exe: game.exe, title: game.title.slice(0, 80), monitor: { w: game.monitor.w, h: game.monitor.h }, fullscreen: Math.abs(game.rect.w - game.monitor.w) < 4 && Math.abs(game.rect.h - game.monitor.h) < 4 } : null,
        hint, offer: snoozed && offer.kind === 'ask' ? { kind: 'wait', text: '' } : offer, snoozed, remembered,
      };
    });
  } catch (e) {
    return { ok: false, connected: false, scene: null, capture: null, game: null, offer: EMPTY_OFFER, fallback: null, error: plain(e), ...base };
  }
}

// ---------------------------------------------------------------- the one click: plan + apply
export interface FallbackPreview { ok: boolean; id: string; text: string; kind?: FallbackKind; certain?: boolean; why?: string; error?: string; steps?: string[] }
interface Ctx { scene: string; items: SceneItem[]; gc: SceneItem; game: GameWindow | null; exeHint: string | undefined; canvas: { w: number; h: number }; monitors: MonitorItem[] | null; taken: string[] }
const planId = (p: FallbackPlan) => `${p.kind}|${p.inputName}|${p.monitorIndex ?? '-'}|${JSON.stringify(p.crop)}|${JSON.stringify(p.box)}`;

async function context(c: ObsClient, source: string | undefined): Promise<Ctx | { error: string }> {
  const scene = await programScene(c);
  const items = await itemsOf(c, scene);
  const gc = source ? items.find((i) => i.sourceName === source && i.inputKind === 'game_capture') ?? null : pickGameCapture(items, obs.cfg.captureSource);
  if (!gc) return { error: 'There is no Game Capture in the scene OBS is showing.' };
  const v = await c.request<{ baseWidth: number; baseHeight: number }>('GetVideoSettings');
  const set = (await c.request<{ inputSettings?: Record<string, unknown> }>('GetInputSettings', { inputName: gc.sourceName }).catch(() => null))?.inputSettings ?? {};
  const win = set.capture_mode === 'window' && typeof set.window === 'string' ? parseObsWindow(set.window) : null;
  const game = await currentGame(win?.exe || undefined, true);
  // OBS's monitor list: asked of an existing Display Capture (a new one is made first when there is none: see apply)
  const existing = (await c.request<{ inputs?: { inputName: string; inputKind: string }[] }>('GetInputList')).inputs ?? [];
  const mc = existing.find((i) => i.inputKind === 'monitor_capture');
  const monitors = mc ? await c.request<{ propertyItems?: { itemName: string; itemValue: unknown }[] }>('GetInputPropertiesListPropertyItems', { inputName: mc.inputName, propertyName: 'monitor_id' }, 10_000).then((r) => monitorItems(r.propertyItems ?? [])).catch(() => null) : null;
  return { scene, items, gc, game, exeHint: win?.exe, canvas: { w: v.baseWidth, h: v.baseHeight }, monitors, taken: existing.map((i) => i.inputName) };
}
const gcItemOf = (x: Ctx) => ({ name: x.gc.sourceName, sceneItemId: x.gc.sceneItemId, index: x.gc.sceneItemIndex, enabled: x.gc.sceneItemEnabled, transform: x.gc.sceneItemTransform });

export async function previewFallback(source?: string): Promise<FallbackPreview> {
  if (obsElsewhere()) return { ok: false, id: '', text: '', error: 'Your OBS is on another PC, so its monitors can’t be matched here. Add a Display Capture in OBS yourself.' };
  try {
    return await obs.readOnly(async (c) => {
      const x = await context(c, source);
      if ('error' in x) return { ok: false, id: '', text: '', error: x.error };
      const prefer = x.game ? choiceFor(readStore().memory, x.game.exe) : null;
      // no monitor list yet: the plan is made with the sentence only; apply reads the list from the new input
      const p = planFallback({ game: x.game, prefer, gc: gcItemOf(x), canvas: x.canvas, monitors: x.monitors, taken: x.taken, exeHint: x.exeHint });
      if ('error' in p) return { ok: false, id: '', text: '', error: p.error };
      const steps = [`Add a ${p.kind === 'monitor_capture' ? 'Display' : 'Window'} Capture called “${p.inputName}” where “${x.gc.sourceName}” is`, `Hide “${x.gc.sourceName}” (it is not deleted)`, 'Remember this choice for this game'];
      return { ok: true, id: planId(p), text: `We’ll add a ${p.text}. “${x.gc.sourceName}” stays in OBS, hidden. Undo puts everything back.${p.certain ? '' : ' We’re not sure which monitor the game is on: check the picture.'}`, kind: p.kind, certain: p.certain, why: p.why, steps };
    });
  } catch (e) { return { ok: false, id: '', text: '', error: plain(e) }; }
}

export interface ApplyOut { ok: boolean; did: string[]; undoId: string | null; error?: string; status?: number; preview?: FallbackPreview }
export async function applyFallback(id: string, source?: string, auto = false): Promise<ApplyOut> {
  if (obsElsewhere()) return { ok: false, did: [], undoId: null, error: 'Your OBS is on another PC.', status: 409 };
  try {
    return await obs.session(async (c): Promise<ApplyOut> => {
      const x = await context(c, source);
      if ('error' in x) return { ok: false, did: [], undoId: null, error: x.error, status: 404 };
      const store = readStore();
      const prefer = x.game ? choiceFor(store.memory, x.game.exe) : null;
      const first = planFallback({ game: x.game, prefer, gc: gcItemOf(x), canvas: x.canvas, monitors: x.monitors, taken: x.taken, exeHint: x.exeHint });
      if ('error' in first) return { ok: false, did: [], undoId: null, error: first.error, status: 400 };
      let p: FallbackPlan = first;
      if (!auto && id !== planId(p)) return { ok: false, did: [], undoId: null, error: 'OBS changed since you looked. Check the new preview and press the button again.', status: 409, preview: await previewFallback(source) };
      const did: string[] = [];
      let made = false;
      try {
        // created hidden, so nothing flashes on stream while it is placed
        const r = await c.request<{ sceneItemId: number }>('CreateInput', { sceneName: x.scene, inputName: p.inputName, inputKind: p.kind, sceneItemEnabled: false, inputSettings: p.kind === 'window_capture' ? p.settings : { capture_cursor: false } });
        made = true;
        const itemId = Number(r.sceneItemId);
        did.push(`Added “${p.inputName}”`);
        if (p.kind === 'monitor_capture') {
          // OBS's monitor list, read from the new input (the first time there was none to ask), then the right monitor
          const items = monitorItems((await c.request<{ propertyItems?: { itemName: string; itemValue: unknown }[] }>('GetInputPropertiesListPropertyItems', { inputName: p.inputName, propertyName: 'monitor_id' }, 10_000).catch(() => ({ propertyItems: [] }))).propertyItems ?? []);
          const re = planFallback({ game: x.game, prefer: 'monitor_capture', gc: gcItemOf(x), canvas: x.canvas, monitors: items.length ? items : null, taken: x.taken.filter((n) => n !== p.inputName), exeHint: x.exeHint });
          if (!('error' in re)) p = { ...re, inputName: p.inputName };
          if (p.settings.monitor_id !== undefined) await c.request('SetInputSettings', { inputName: p.inputName, inputSettings: p.settings, overlay: true });
        }
        await c.request('SetSceneItemTransform', { sceneName: x.scene, sceneItemId: itemId, sceneItemTransform: p.transform });
        await c.request('SetSceneItemIndex', { sceneName: x.scene, sceneItemId: itemId, sceneItemIndex: x.gc.sceneItemIndex });
        did.push(`Put it where “${x.gc.sourceName}” was`);
        await c.request('SetSceneItemEnabled', { sceneName: x.scene, sceneItemId: itemId, sceneItemEnabled: true });
        if (x.gc.sceneItemEnabled) await c.request('SetSceneItemEnabled', { sceneName: x.scene, sceneItemId: x.gc.sceneItemId, sceneItemEnabled: false });
        did.push(`Hid “${x.gc.sourceName}”`);
        const exe = x.game?.exe || x.exeHint || '';
        const group: FallbackGroup = { id: newId(), at: new Date().toISOString(), type: 'fallback', scene: x.scene, input: p.inputName, itemId, inputKind: p.kind, gc: { name: x.gc.sourceName, id: x.gc.sceneItemId, wasEnabled: x.gc.sceneItemEnabled }, exe, kind: p.kind,
          label: `${p.kind === 'monitor_capture' ? 'Display' : 'Window'} Capture instead of “${x.gc.sourceName}”` };
        store.groups.push(group);
        if (exe) store.memory = rememberChoice(store.memory, exe, p.kind, group.at);
        writeStore(store);
        tracker.reset(); adviceCache = null;
        return { ok: true, did, undoId: group.id };
      } catch (e) {
        // roll back what this call did: only the input it made; the Game Capture is shown again if it was hidden
        if (made) await c.request('RemoveInput', { inputName: p.inputName }).catch(() => {});
        if (x.gc.sceneItemEnabled) await c.request('SetSceneItemEnabled', { sceneName: x.scene, sceneItemId: x.gc.sceneItemId, sceneItemEnabled: true }).catch(() => {});
        return { ok: false, did: [], undoId: null, error: plain(e), status: 502 };
      }
    });
  } catch (e) { return { ok: false, did: [], undoId: null, error: plain(e), status: 503 }; }
}

// ---------------------------------------------------------------- one-click OBS settings
export type FixAction = 'canvas' | 'scale-type' | 'encoder' | 'browser-fps' | 'browser-shutdown';
export const FIX_ACTIONS: FixAction[] = ['canvas', 'scale-type', 'encoder', 'browser-fps', 'browser-shutdown'];
export interface FixOut { ok: boolean; did: string[]; undoId: string | null; error?: string; status?: number }
export async function applyFix(action: FixAction, o: { vendor?: string | null; name?: string } = {}): Promise<FixOut> {
  if (obsElsewhere()) return { ok: false, did: [], undoId: null, error: 'Your OBS is on another PC.', status: 409 };
  try {
    return await obs.session(async (c): Promise<FixOut> => {
      const restore: Restore[] = [];
      const did: string[] = [];
      let label = '';
      if (action === 'canvas') {
        const v = await videoInfo(c);
        if (!v) return { ok: false, did, undoId: null, error: 'OBS didn’t say its video settings.', status: 502 };
        if (await outputsBusy(c)) return { ok: false, did, undoId: null, error: 'OBS is streaming or recording; its picture size can only change when it is stopped.', status: 409 };
        await c.request('SetVideoSettings', { baseWidth: v.outW, baseHeight: v.outH });
        const after = await videoInfo(c);
        if (!after || after.baseW !== v.outW || after.baseH !== v.outH) return { ok: false, did, undoId: null, error: `OBS kept its canvas at ${after?.baseW ?? '?'}×${after?.baseH ?? '?'}.`, status: 502 };
        restore.push({ op: 'video', baseW: v.baseW, baseH: v.baseH });
        label = `OBS canvas ${v.baseW}×${v.baseH} → ${v.outW}×${v.outH}`; did.push(label);
      } else if (action === 'scale-type') {
        const prev = await profileParam(c, 'Video', 'ScaleType');
        if (prev === undefined) return { ok: false, did, undoId: null, error: 'This OBS can’t change that setting from here. OBS → Settings → Video → Downscale Filter → Bilinear.', status: 501 };
        if (await outputsBusy(c)) return { ok: false, did, undoId: null, error: 'OBS is streaming or recording.', status: 409 };
        await c.request('SetProfileParameter', { parameterCategory: 'Video', parameterName: 'ScaleType', parameterValue: 'bilinear' });
        if ((await profileParam(c, 'Video', 'ScaleType')) !== 'bilinear') return { ok: false, did, undoId: null, error: 'OBS did not keep the setting.', status: 502 };
        if (prev) restore.push({ op: 'profile', category: 'Video', name: 'ScaleType', value: prev });
        label = 'OBS downscale filter → Bilinear'; did.push(label);
      } else if (action === 'encoder') {
        const val = o.vendor ? SIMPLE_HW[o.vendor] : undefined;
        if (!val) return { ok: false, did, undoId: null, error: 'Which graphics card? (vendor)', status: 400 };
        const mode = await profileParam(c, 'Output', 'Mode');
        if (mode === undefined) return { ok: false, did, undoId: null, error: 'This OBS can’t change that setting from here. OBS → Settings → Output → Encoder.', status: 501 };
        if (mode === 'Advanced') return { ok: false, did, undoId: null, error: 'Your OBS uses Advanced output mode: pick the encoder in OBS → Settings → Output (the names differ per OBS version).', status: 409 };
        if (await outputsBusy(c)) return { ok: false, did, undoId: null, error: 'OBS is streaming or recording.', status: 409 };
        const prev = await profileParam(c, 'SimpleOutput', 'StreamEncoder');
        await c.request('SetProfileParameter', { parameterCategory: 'SimpleOutput', parameterName: 'StreamEncoder', parameterValue: val });
        if ((await profileParam(c, 'SimpleOutput', 'StreamEncoder')) !== val) return { ok: false, did, undoId: null, error: 'OBS did not keep the setting.', status: 502 };
        if (prev) restore.push({ op: 'profile', category: 'SimpleOutput', name: 'StreamEncoder', value: prev });
        label = `OBS encoder ${prev ?? 'x264'} → ${val}`; did.push(label);
      } else {
        // the VTube Pro browser source(s): found by their address, never by a name the page sends
        const scene = await programScene(c);
        const bs = (await itemsOf(c, scene)).filter((i) => i.inputKind === 'browser_source');
        const v = await videoInfo(c);
        for (const b of bs) {
          const st = (await c.request<{ inputSettings?: Record<string, unknown> }>('GetInputSettings', { inputName: b.sourceName }).catch(() => null))?.inputSettings;
          if (!st || !isVtpUrl(st.url)) continue;
          const next = action === 'browser-fps' ? { fps_custom: true, fps: Math.max(1, Math.round(v?.fps ?? 60)) } : { shutdown: false };
          const prev = Object.fromEntries(Object.keys(next).map((k) => [k, st[k] ?? (k === 'fps_custom' ? false : k === 'shutdown' ? false : 30)]));
          await c.request('SetInputSettings', { inputName: b.sourceName, inputSettings: next, overlay: true });
          restore.push({ op: 'input', name: b.sourceName, settings: prev });
          did.push(action === 'browser-fps' ? `“${b.sourceName}” → ${next.fps} fps` : `“${b.sourceName}”: shutdown when not visible off`);
        }
        if (!restore.length) return { ok: false, did, undoId: null, error: 'No VTube Pro browser source in the scene OBS is showing.', status: 404 };
        label = action === 'browser-fps' ? 'VTube Pro browser source frame rate' : 'VTube Pro browser source: keep running when hidden';
      }
      const g: SettingGroup = { id: newId(), at: new Date().toISOString(), type: 'setting', label, restore };
      const s = readStore(); s.groups.push(g); writeStore(s);
      adviceCache = null;
      return { ok: true, did, undoId: g.id };
    });
  } catch (e) { return { ok: false, did: [], undoId: null, error: plain(e), status: 503 }; }
}

// ---------------------------------------------------------------- Undo (the latest change)
export interface UndoOut { ok: boolean; did: string[]; kept: string[]; error?: string; status?: number }
export async function undoLatest(id: string): Promise<UndoOut> {
  const store = readStore();
  const g = store.groups[store.groups.length - 1];
  if (!g) return { ok: false, did: [], kept: [], error: 'Nothing to undo.', status: 404 };
  if (id !== g.id) return { ok: false, did: [], kept: [], error: 'Only the latest change can be undone. Undo that one first.', status: 409 };
  const did: string[] = [], kept: string[] = [];
  try {
    await obs.session(async (c) => {
      if (g.type === 'fallback') {
        const items = await itemsOf(c, g.scene).catch(() => [] as SceneItem[]);
        const mine = items.find((i) => i.sourceName === g.input && i.inputKind === g.inputKind);
        if (mine) { await c.request('RemoveInput', { inputName: g.input }); did.push(`Removed “${g.input}”`); }
        else if (items.some((i) => i.sourceName === g.input)) kept.push(`Kept “${g.input}”: it is something else now.`);
        const gc = items.find((i) => i.sourceName === g.gc.name && i.sceneItemId === g.gc.id);
        if (gc) {
          if (g.gc.wasEnabled) { await c.request('SetSceneItemEnabled', { sceneName: g.scene, sceneItemId: g.gc.id, sceneItemEnabled: true }); did.push(`Showed “${g.gc.name}” again`); }
        } else kept.push(`“${g.gc.name}” is no longer in “${g.scene}”.`);
      } else {
        for (const r of [...g.restore].reverse()) {
          if (r.op === 'input') { await c.request('SetInputSettings', { inputName: r.name, inputSettings: r.settings, overlay: true }); did.push(`Put “${r.name}” back`); }
          else if (r.op === 'profile') { await c.request('SetProfileParameter', { parameterCategory: r.category, parameterName: r.name, parameterValue: r.value }); did.push(`Put ${r.name} back to ${r.value}`); }
          else if (r.op === 'video') {
            if (await outputsBusy(c)) kept.push('OBS is streaming or recording, so its canvas size was left as it is.');
            else { await c.request('SetVideoSettings', { baseWidth: r.baseW, baseHeight: r.baseH }); did.push(`Put the canvas back to ${r.baseW}×${r.baseH}`); }
          }
        }
      }
    });
  } catch (e) { return { ok: false, did, kept, error: plain(e), status: 503 }; }
  store.groups.pop();
  if (g.type === 'fallback') {
    // the person took it back: do not put it there again by itself, and do not ask again for a while
    if (g.exe) store.memory = forgetChoice(store.memory, g.exe);
    snooze.set(g.gc.name, nowFn() + 30 * 60_000);
  }
  writeStore(store);
  tracker.reset(); adviceCache = null;
  return { ok: true, did, kept };
}

export function snoozeSource(source: string, minutes: number) {
  snooze.set(source.slice(0, 256), nowFn() + Math.max(1, Math.min(SNOOZE_MAX_MIN, Math.round(minutes))) * 60_000);
}

// ---------------------------------------------------------------- automatic: a game that blocked Game Capture before
// While OBS automation is on and the show is in Gaming or React, a Game Capture that stays blank for a game with a
// remembered choice is switched without a click. The timer exists only then (and stops by itself), and each look is a
// handful of Get* requests.
const WATCH_MS = 6000;
let watchTimer: NodeJS.Timeout | null = null;
let watchMode = '';
export const autoWatching = () => !!watchTimer;
function watchWanted() { return obs.cfg.enabled && (watchMode === 'gaming' || watchMode === 'react') && Object.keys(readStore().memory.byExe).length > 0; }
let autoBusy = false;
export async function autoTick() {
  if (autoBusy || !watchWanted()) return;
  autoBusy = true;
  try {
    const s = await gamingStatus({ advice: false });
    if (s.ok && s.offer.kind === 'auto' && s.capture && !s.snoozed) {
      const r = await applyFallback('', s.capture.source, true);
      void r;
    }
  } catch { /* the next look tries again */ } finally { autoBusy = false; }
}
function syncWatch() {
  if (watchWanted()) { if (!watchTimer) { watchTimer = setInterval(() => { void autoTick(); }, WATCH_MS); watchTimer.unref(); } }
  else if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
}
obs.modeListeners.push((mode) => { watchMode = mode; syncWatch(); });
/** Tests: set the mode the watcher believes the show is in. */
export function setWatchMode(mode: string) { watchMode = mode; syncWatch(); }

// ---------------------------------------------------------------- routes
export const obsGamingRoutes = Router();
obsGamingRoutes.use(obsReadGuard);
obsGamingRoutes.use(obsWriteGuard);
const noStore = (res: import('express').Response) => res.setHeader('Cache-Control', 'no-store');
const VENDORS = new Set(['nvidia', 'amd', 'intel']);
const vendorOf = (v: unknown) => (typeof v === 'string' && VENDORS.has(v) ? v : null);

obsGamingRoutes.get('/api/obs/gaming', async (req, res) => {
  requireLocal(req); noStore(res);
  res.json(await gamingStatus({ vendor: vendorOf(req.query.vendor), advice: req.query.advice !== '0' }));
});
obsGamingRoutes.post('/api/obs/gaming/plan', async (req, res) => {
  requireLocal(req); noStore(res);
  const b = (req.body ?? {}) as { source?: unknown };
  res.json(await previewFallback(typeof b.source === 'string' ? b.source.slice(0, 256) : undefined));
});
obsGamingRoutes.post('/api/obs/gaming/apply', async (req, res) => {
  requireLocal(req); noStore(res);
  const b = (req.body ?? {}) as { planId?: unknown; source?: unknown };
  if (typeof b.planId !== 'string' || !b.planId) { res.status(400).json({ ok: false, error: 'Preview the change first (planId).' }); return; }
  const { status, ...body } = await applyFallback(b.planId, typeof b.source === 'string' ? b.source.slice(0, 256) : undefined);
  res.status(body.ok ? 200 : status ?? 500).json(body);
});
obsGamingRoutes.post('/api/obs/gaming/fix', async (req, res) => {
  requireLocal(req); noStore(res);
  const b = (req.body ?? {}) as { action?: unknown; vendor?: unknown };
  const action = FIX_ACTIONS.find((a) => a === b.action);
  if (!action) { res.status(400).json({ ok: false, error: 'Which change? (action)' }); return; }
  const { status, ...body } = await applyFix(action, { vendor: vendorOf(b.vendor) });
  res.status(body.ok ? 200 : status ?? 500).json(body);
});
obsGamingRoutes.post('/api/obs/gaming/undo', async (req, res) => {
  requireLocal(req); noStore(res);
  const id = (req.body as { id?: unknown } | undefined)?.id;
  if (typeof id !== 'string' || !id) { res.status(400).json({ ok: false, error: 'Which change? (id)' }); return; }
  const { status, ...body } = await undoLatest(id);
  res.status(body.ok ? 200 : status ?? 500).json(body);
});
obsGamingRoutes.post('/api/obs/gaming/snooze', (req, res) => {
  requireLocal(req); noStore(res);
  const b = (req.body ?? {}) as { source?: unknown; minutes?: unknown };
  if (typeof b.source !== 'string' || !b.source) { res.status(400).json({ ok: false, error: 'Which source? (source)' }); return; }
  snoozeSource(b.source, typeof b.minutes === 'number' ? b.minutes : 30);
  res.json({ ok: true });
});
