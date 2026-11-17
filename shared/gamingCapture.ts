// Gaming at 60 FPS: the pure decisions behind "this game blocks Game Capture, switch to Display Capture?", the Display
// Capture cost warnings, and the OBS-side advice (encoder, browser source rate, shutdown-when-hidden, canvas rescale,
// run-as-admin). No DOM, no node, no OBS connection: server/obsGaming.ts feeds these what obs-websocket says, the studio
// shows what they return, tools/gaming_capture_unit.ts tests every function. Nothing here changes anything.
//
// obs-websocket v5 requests the callers use (all exist in the protocol): GetSourceActive, GetSourceScreenshot,
// GetSceneItemList / GetSceneItemTransform, GetInputSettings / SetInputSettings, GetInputPropertiesListPropertyItems,
// CreateInput, SetSceneItemIndex / SetSceneItemEnabled / SetSceneItemTransform, RemoveInput, GetVideoSettings /
// SetVideoSettings, GetProfileParameter / SetProfileParameter, GetStats, GetStreamStatus, GetRecordStatus, GetVersion.

export interface Rect { x: number; y: number; w: number; h: number }
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

// ================================================================ is the Game Capture showing anything?
/** Brightness of a small screenshot, 0-255 (alpha composited over black: a Game Capture that is not hooked is clear). */
export interface LumaStat { mean: number; max: number; lit: number; n: number }
/** Pure: mean / max luma and the share of pixels above `litAt` for RGBA bytes. */
export function lumaStat(rgba: ArrayLike<number>, litAt = 16): LumaStat {
  const n = Math.floor(rgba.length / 4);
  if (!n) return { mean: 0, max: 0, lit: 0, n: 0 };
  let sum = 0, max = 0, lit = 0;
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    const y = (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) * a;
    sum += y; if (y > max) max = y; if (y >= litAt) lit++;
  }
  return { mean: sum / n, max, lit: lit / n, n };
}
/** A picture that is (nearly) all black: nothing hooked, or a game that blocks the hook. A real dark scene still has
 *  some lit pixels (HUD, stars), and the caller waits BLANK_CONFIRM_MS before it believes this. */
export const BLACK_MEAN = 2.5, BLACK_MAX = 28, BLACK_LIT = 0.002;
export const isBlackPicture = (s: LumaStat) => s.n > 0 && s.mean < BLACK_MEAN && s.max < BLACK_MAX && s.lit <= BLACK_LIT;

export type CaptureState = 'ok' | 'blank' | 'idle' | 'na';
export interface CaptureJudgement { state: CaptureState; reason: 'picture' | 'size-only' | 'zero-size' | 'black' | 'not-in-view' | 'not-game-capture'; text: string }
export interface GameCaptureProbe {
  kind: string;
  /** GetSourceActive.videoActive (null = OBS can't say: an older obs-websocket). */
  active: boolean | null;
  /** The scene item's source size (GetSceneItemTransform sourceWidth / sourceHeight): 0 × 0 = Game Capture has not hooked. */
  width: number; height: number;
  /** null = no screenshot (GetSourceScreenshot missing / refused). */
  luma: LumaStat | null;
}
/** Pure: what the live check says about one Game Capture source. 'idle' = it is not on screen, so nothing can be said
 *  (a Game Capture only hooks while it is shown); 'blank' = it IS shown and shows nothing. */
export function judgeGameCapture(p: GameCaptureProbe): CaptureJudgement {
  if (p.kind !== 'game_capture') return { state: 'na', reason: 'not-game-capture', text: 'Not a Game Capture.' };
  if (p.active === false) return { state: 'idle', reason: 'not-in-view', text: 'The Game Capture isn’t on screen in OBS right now (its scene isn’t showing), so it can’t hook a game yet.' };
  if (!(p.width > 0 && p.height > 0)) return { state: 'blank', reason: 'zero-size', text: 'The Game Capture has not hooked a game (OBS says it is 0×0).' };
  if (p.luma && isBlackPicture(p.luma)) return { state: 'blank', reason: 'black', text: 'The Game Capture hooked something, but the picture is black.' };
  return { state: 'ok', reason: p.luma ? 'picture' : 'size-only', text: p.luma ? 'The Game Capture shows a picture.' : 'The Game Capture has a size (this OBS can’t take a test picture).' };
}

/** A game takes a few seconds to hook and loading screens are black: blank must last this long, over at least two looks. */
export const BLANK_CONFIRM_MS = 8000;
export const BLANK_MIN_LOOKS = 2;
/** Remembers, per source, since when it has been blank. Pure apart from its own state (the caller passes the time). */
export class BlankTracker {
  private since = new Map<string, { at: number; looks: number }>();
  /** One look. Returns whether the source has now been blank long enough to believe it. */
  observe(key: string, blank: boolean, now: number): { confirmed: boolean; forMs: number } {
    if (!blank) { this.since.delete(key); return { confirmed: false, forMs: 0 }; }
    const s = this.since.get(key) ?? { at: now, looks: 0 };
    s.looks++;
    this.since.set(key, s);
    const forMs = now - s.at;
    return { confirmed: forMs >= BLANK_CONFIRM_MS && s.looks >= BLANK_MIN_LOOKS, forMs };
  }
  reset(key?: string) { if (key === undefined) this.since.clear(); else this.since.delete(key); }
}

// ================================================================ known launch patterns (a HINT; the live check decides)
export interface BlockerHint { id: 'anticheat' | 'uwp' | 'vulkan'; text: string }
export interface GameInfo { exe: string; path?: string; title?: string; cls?: string }
/** Pure: does the game's executable / folder / window look like one that often blocks Game Capture? Only ever a hint: a
 *  match never switches anything, and no match never hides a real black Game Capture. */
export function blockerHint(g: GameInfo): BlockerHint | null {
  const exe = (g.exe ?? '').toLowerCase(), path = (g.path ?? '').toLowerCase(), title = (g.title ?? '').toLowerCase();
  if (/(easyanticheat|battleye|beclient|vanguard|vgc\b|valorant|faceit|xigncode|nprotect|gameguard|punkbuster|ricochet)/.test(`${exe} ${path}`))
    return { id: 'anticheat', text: 'Games with anti-cheat protection often block Game Capture.' };
  if (/\\windowsapps\\|\\xboxgames\\/.test(path) || /^(applicationframehost|gamelaunchhelper|minecraft\.windows)\.exe$/.test(exe) || g.cls === 'ApplicationFrameWindow' || g.cls === 'Windows.UI.Core.CoreWindow')
    return { id: 'uwp', text: 'Microsoft Store (UWP) games usually can’t be hooked by Game Capture.' };
  if (/(^|[^a-z])vk\.exe$/.test(exe) || /vulkan|dxvk/.test(`${exe} ${title}`) || /^(ryujinx|yuzu|rpcs3|cemu)/.test(exe))
    return { id: 'vulkan', text: 'Some Vulkan games and emulators aren’t hooked by Game Capture.' };
  return null;
}

// ================================================================ the game's window and its monitor
export interface GameWindow {
  exe: string; pid: number; title: string; cls: string; path: string;
  /** The window's rectangle and the monitor it is mostly on (virtual-desktop pixels, DPI-aware). */
  rect: Rect; monitor: Rect; primary: boolean;
}
/** Windows that are never "the game" (the browser the studio runs in, OBS, the desktop, tools). */
export const NOT_GAME_EXE = /^(explorer|chrome|msedge|firefox|brave|opera|vivaldi|obs64|obs32|obs|streamlabs.*|node|code|cursor|devenv|windowsterminal|powershell|cmd|searchhost|searchapp|shellexperiencehost|startmenuexperiencehost|textinputhost|lockapp|systemsettings|taskmgr|vtube ?pro.*|vtubepro.*|discord|spotify|steamwebhelper|nvidia share|nvcontainer|applicationframehost|grok ?bot|claude|slack|teams|ms-teams|zoom|notepad\+\+|notepad|blender|unrealeditor|vlc|mpv|outlook|winword|excel|powerpnt|onenote|mspaint|photoshop|illustrator|premiere|afterfx|resolve|figma|telegram|whatsapp|signal|streamlabs obs|medal|xsplit.*)\.exe$/i;
/** Fraction of its monitor a window must cover to count as fullscreen (borderless windowed included). */
export const FULLSCREEN_COVER = 0.97;
export const coverOf = (r: Rect, m: Rect) => {
  const w = Math.max(0, Math.min(r.x + r.w, m.x + m.w) - Math.max(r.x, m.x)), h = Math.max(0, Math.min(r.y + r.h, m.y + m.h) - Math.max(r.y, m.y));
  return m.w > 0 && m.h > 0 ? (w * h) / (m.w * m.h) : 0;
};
export const isFullscreenWindow = (g: GameWindow) => coverOf(g.rect, g.monitor) >= FULLSCREEN_COVER;
/** Pure: the likeliest game among the visible top-level windows (z-order, top first). `exe` = the game a Game Capture is
 *  set to (Capture specific window): its largest window. Otherwise the topmost fullscreen window that is not a tool. */
export function pickGame(ws: GameWindow[], exe?: string): GameWindow | null {
  const clean = ws.filter((w) => w.exe && w.rect.w > 0 && w.rect.h > 0);
  if (exe) {
    const want = exeKey(exe);
    const mine = clean.filter((w) => exeKey(w.exe) === want).sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);
    return mine[0] ?? null;
  }
  return clean.find((w) => !NOT_GAME_EXE.test(w.exe) && isFullscreenWindow(w)) ?? null;
}
export const exeKey = (exe: string) => String(exe ?? '').toLowerCase().replace(/^.*[\\/]/, '').slice(0, 100);

/** OBS's "title:class:exe" window setting (':' → #3A, '#' → #22). */
export const encodeObsWindow = (title: string, cls: string, exe: string) => [title, cls, exe].map((x) => x.replace(/#/g, '#22').replace(/:/g, '#3A')).join(':');
export function parseObsWindow(s: string): { title: string; cls: string; exe: string } | null {
  const p = String(s ?? '').split(':');
  if (p.length < 3) return null;
  const dec = (x: string) => x.replace(/#3A/g, ':').replace(/#22/g, '#');
  return { title: dec(p[0]), cls: dec(p[1]), exe: dec(p.slice(2).join(':')) };
}

// ---------------------------------------------------------------- OBS's monitor list
export interface MonitorItem { name: string; value: unknown; w?: number; h?: number; x?: number; y?: number; primary: boolean }
/** Pure: OBS names a Display Capture's monitors like “Display 1: 3840x2160 @ 0,0 (Primary Monitor)” or
 *  “LG ULTRAGEAR+ (3840x2160)”. */
export function parseMonitorName(name: string): { w?: number; h?: number; x?: number; y?: number; primary: boolean } {
  const s = String(name ?? '');
  const size = /(\d{3,5})\s*[x×]\s*(\d{3,5})/.exec(s), at = /@\s*(-?\d+)\s*,\s*(-?\d+)/.exec(s);
  return { ...(size ? { w: +size[1], h: +size[2] } : {}), ...(at ? { x: +at[1], y: +at[2] } : {}), primary: /primary/i.test(s) };
}
export const monitorItems = (items: { itemName: string; itemValue: unknown }[]): MonitorItem[] => items.map((i) => ({ name: String(i.itemName), value: i.itemValue, ...parseMonitorName(String(i.itemName)) }));
/** Pure: which of OBS's monitors the game is on. `certain` = matched on position and size (or the only monitor); a size-only
 *  match among several equal monitors is a guess (`certain` false) and the preview says so. null = no idea. */
export function pickMonitor(items: MonitorItem[], game: { monitor: Rect; primary?: boolean } | null): { index: number; certain: boolean; why: string } | null {
  if (!items.length) return null;
  if (items.length === 1) return { index: 0, certain: true, why: 'the only monitor OBS lists' };
  if (!game) { const p = items.findIndex((i) => i.primary); return p >= 0 ? { index: p, certain: false, why: 'your main monitor (the game window was not found)' } : null; }
  const m = game.monitor;
  const exact = items.map((it, i) => ({ it, i })).filter(({ it }) => it.x === m.x && it.y === m.y && it.w === m.w && it.h === m.h);
  if (exact.length === 1) return { index: exact[0].i, certain: true, why: 'it sits where the game is (position and size match)' };
  const sized = items.map((it, i) => ({ it, i })).filter(({ it }) => it.w === m.w && it.h === m.h);
  if (sized.length === 1) return { index: sized[0].i, certain: true, why: 'the only monitor of that size' };
  const pool = sized.length ? sized : items.map((it, i) => ({ it, i }));
  if (game.primary) { const p = pool.find(({ it }) => it.primary); if (p) return { index: p.i, certain: false, why: 'your main monitor (several look the same)' }; }
  const at = pool.find(({ it }) => it.x !== undefined && it.x === m.x && it.y === m.y);
  if (at) return { index: at.i, certain: at.it.w === undefined || (at.it.w === m.w && at.it.h === m.h), why: 'its position matches' };
  return { index: pool[0].i, certain: false, why: 'the first monitor of that size (several look the same)' };
}

// ================================================================ the fallback: Display Capture / Window Capture
export type FallbackKind = 'monitor_capture' | 'window_capture';
export interface GcItem { name: string; sceneItemId: number; index: number; enabled: boolean; transform: Record<string, unknown> }
export interface FallbackInput {
  game: GameWindow | null;
  /** Remembered choice for this game executable (cache of earlier clicks). */
  prefer?: FallbackKind | null;
  gc: GcItem;
  canvas: { w: number; h: number };
  monitors: MonitorItem[] | null;
  /** Names already used by OBS inputs (the new one must be unique). */
  taken: string[];
  /** The game's own exe, from a Game Capture set to a specific window. */
  exeHint?: string;
}
export interface FallbackPlan {
  kind: FallbackKind;
  inputName: string;
  settings: Record<string, unknown>;
  /** Display Capture: the index in OBS's monitor list (the caller reads the real value there). */
  monitorIndex: number | null;
  certain: boolean;
  crop: { l: number; r: number; t: number; b: number };
  box: Rect;
  /** The size of what is captured after cropping. */
  shown: { w: number; h: number };
  transform: Record<string, unknown>;
  text: string;
  why: string;
}
export function uniqueName(base: string, taken: string[]): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!set.has(`${base} ${i}`)) return `${base} ${i}`;
  return `${base} ${Date.now() % 1000}`;
}
/** Pure: the box (canvas px) the Game Capture occupied, else the whole canvas. */
export function boxOfItem(t: Record<string, unknown>, canvas: { w: number; h: number }): Rect {
  const n = (k: string) => (finite(t[k]) ? (t[k] as number) : NaN);
  const bounded = typeof t.boundsType === 'string' && t.boundsType !== 'OBS_BOUNDS_NONE' && n('boundsWidth') > 0 && n('boundsHeight') > 0;
  const w = bounded ? n('boundsWidth') : Math.abs(n('width')) || Math.abs(n('sourceWidth') * (finite(n('scaleX')) ? n('scaleX') : 1));
  const h = bounded ? n('boundsHeight') : Math.abs(n('height')) || Math.abs(n('sourceHeight') * (finite(n('scaleY')) ? n('scaleY') : 1));
  const px = n('positionX'), py = n('positionY');
  const rot = n('rotation');
  if (!(w > 0 && h > 0) || !finite(px) || !finite(py) || (finite(rot) && Math.abs(rot % 360) > 0.01)) return { x: 0, y: 0, w: canvas.w, h: canvas.h };
  const al = finite(n('alignment')) ? n('alignment') : 5;
  const x = px - (al & 1 ? 0 : al & 2 ? w : w / 2), y = py - (al & 4 ? 0 : al & 8 ? h : h / 2);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}
/** Pure: how much of the monitor to cut away so only the window is left (source pixels). */
export function cropToWindow(win: Rect, mon: Rect): { l: number; r: number; t: number; b: number } {
  const l = Math.max(0, Math.round(win.x - mon.x)), t = Math.max(0, Math.round(win.y - mon.y));
  const r = Math.max(0, Math.round(mon.x + mon.w - (win.x + win.w))), b = Math.max(0, Math.round(mon.y + mon.h - (win.y + win.h)));
  return { l, r, t, b };
}
/** Pure: the plan for the one-click fallback. Windowed game on a bigger screen → Window Capture of that window (Windows
 *  10+ capture method) unless a Display Capture was chosen before; fullscreen / borderless / unknown → Display Capture of
 *  the monitor the game is on. Never deletes anything: the caller hides the Game Capture and Undo removes the new input. */
export function planFallback(i: FallbackInput): FallbackPlan | { error: string } {
  const g = i.game, canvas = i.canvas;
  if (!(canvas.w > 0 && canvas.h > 0)) return { error: 'OBS did not say how big its picture is.' };
  const windowed = !!g && !isFullscreenWindow(g);
  const uwpHidden = !!g && (g.cls === 'ApplicationFrameWindow' || /\\windowsapps\\/i.test(g.path));
  let kind: FallbackKind = windowed && !uwpHidden ? 'window_capture' : 'monitor_capture';
  if (i.prefer && (i.prefer === 'monitor_capture' || (i.prefer === 'window_capture' && !!g && g.exe))) kind = i.prefer;
  if (kind === 'window_capture' && !(g && g.exe)) kind = 'monitor_capture';
  const box = boxOfItem(i.gc.transform, canvas);
  if (kind === 'window_capture' && g) {
    const exe = exeKey(g.exe);
    const label = g.title ? g.title.slice(0, 40) : exe;
    return {
      kind, inputName: uniqueName('Game Window Capture', i.taken), monitorIndex: null, certain: true, crop: { l: 0, r: 0, t: 0, b: 0 }, box, shown: { w: g.rect.w, h: g.rect.h },
      // method 2 = “Windows 10 (1903 and up)”; priority 2 = match the title, else any window of the same executable
      settings: { window: encodeObsWindow(g.title, g.cls, g.exe), method: 2, priority: 2, cursor: false },
      transform: fitTransform(box, g.rect.w, g.rect.h),
      text: `Window Capture of “${label}” (${exe}), the Windows 10+ way, in the place of the Game Capture`,
      why: 'the game runs in a window',
    };
  }
  const pick = i.monitors ? pickMonitor(i.monitors, g ? { monitor: g.monitor, primary: g.primary } : null) : null;
  if (i.monitors && i.monitors.length && !pick) return { error: 'OBS lists monitors, but VTube Pro can’t tell which one the game is on.' };
  const mon = g?.monitor ?? (pick && i.monitors?.[pick.index]?.w ? { x: i.monitors[pick.index].x ?? 0, y: i.monitors[pick.index].y ?? 0, w: i.monitors[pick.index].w!, h: i.monitors[pick.index].h! } : null);
  const crop = g && windowed && mon ? cropToWindow(g.rect, mon) : { l: 0, r: 0, t: 0, b: 0 };
  const sw = mon ? Math.max(1, mon.w - crop.l - crop.r) : canvas.w, sh = mon ? Math.max(1, mon.h - crop.t - crop.b) : canvas.h;
  const name = pick && i.monitors ? i.monitors[pick.index].name : 'your monitor';
  return {
    kind: 'monitor_capture', inputName: uniqueName('Game Display Capture', i.taken), monitorIndex: pick ? pick.index : null, certain: pick ? pick.certain : false, crop, box, shown: { w: sw, h: sh },
    settings: { ...(pick && i.monitors ? { monitor_id: i.monitors[pick.index].value } : {}), capture_cursor: false },
    transform: { ...fitTransform(box, sw, sh), cropLeft: crop.l, cropRight: crop.r, cropTop: crop.t, cropBottom: crop.b },
    text: `Display Capture of ${name}${crop.l || crop.r || crop.t || crop.b ? ', cropped to the game’s window' : ''}, in the place of the Game Capture`,
    why: pick ? pick.why : 'OBS did not list its monitors',
  };
}
/** Pure: the transform that places a source of `sw`×`sh` inside `box` without distortion (top-left anchored). */
export function fitTransform(box: Rect, sw: number, sh: number): Record<string, unknown> {
  void sw; void sh;
  return { positionX: box.x, positionY: box.y, rotation: 0, alignment: 5, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: Math.max(1, box.w), boundsHeight: Math.max(1, box.h) };
}

export type OfferKind = 'none' | 'wait' | 'no-game' | 'ask' | 'auto';
export interface Offer { kind: OfferKind; text: string }
/** Pure: what the studio says about a Game Capture, from the live judgement. One click ('ask'), already-chosen ('auto'),
 *  or not yet ('wait': the look must hold for a few seconds; 'no-game': blank but no game window to follow). */
export function decideOffer(a: { judged: CaptureJudgement; confirmed: boolean; game: GameWindow | null; remembered: FallbackKind | null; hint: BlockerHint | null }): Offer {
  const j = a.judged;
  if (j.state === 'ok' || j.state === 'na') return { kind: 'none', text: '' };
  if (j.state === 'idle') return { kind: 'none', text: j.text };
  if (!a.confirmed) return { kind: 'wait', text: 'The Game Capture shows nothing yet. Checking for a few more seconds before suggesting anything.' };
  if (!a.game) return { kind: 'no-game', text: `${j.text} Start your game; if it is already running, Game Capture can’t see it.` };
  const hint = a.hint ? ` ${a.hint.text}` : '';
  if (a.remembered) return { kind: 'auto', text: `This game blocks Game Capture (you chose ${a.remembered === 'monitor_capture' ? 'Display' : 'Window'} Capture for it before).${hint}` };
  return { kind: 'ask', text: `This game blocks Game Capture.${hint} Switch to ${a.game && !isFullscreenWindow(a.game) ? 'a Window' : 'a Display'} Capture?` };
}

// ---------------------------------------------------------------- remembered per game executable
export interface GameChoice { kind: FallbackKind; at: string }
export interface GameMemory { byExe: Record<string, GameChoice> }
export function sanitizeMemory(raw: unknown): GameMemory {
  const out: GameMemory = { byExe: {} };
  const by = raw && typeof raw === 'object' ? (raw as { byExe?: unknown }).byExe : null;
  if (by && typeof by === 'object') for (const [k, v] of Object.entries(by as Record<string, unknown>).slice(0, 200)) {
    const kind = (v as { kind?: unknown } | null)?.kind;
    if (k && k.length <= 100 && (kind === 'monitor_capture' || kind === 'window_capture')) out.byExe[exeKey(k)] = { kind, at: typeof (v as { at?: unknown }).at === 'string' ? (v as { at: string }).at.slice(0, 40) : '' };
  }
  return out;
}
export const rememberChoice = (m: GameMemory, exe: string, kind: FallbackKind, at: string): GameMemory => ({ byExe: { ...m.byExe, [exeKey(exe)]: { kind, at } } });
export const forgetChoice = (m: GameMemory, exe: string): GameMemory => { const b = { ...m.byExe }; delete b[exeKey(exe)]; return { byExe: b }; };
export const choiceFor = (m: GameMemory, exe: string): FallbackKind | null => m.byExe[exeKey(exe)]?.kind ?? null;

// ================================================================ costs: a big Display Capture, a rescaled canvas
export interface Advice {
  id: string; level: 'info' | 'warn';
  text: string;
  /** A click that OBS allows over obs-websocket (server/obsGaming.ts applyAdvice). */
  fix?: { action: 'canvas' | 'scale-type' | 'encoder' | 'browser-fps' | 'browser-shutdown'; label: string };
  /** What to do by hand when there is no click. */
  manual?: string;
}
export interface VideoInfo { baseW: number; baseH: number; outW: number; outH: number; fps: number }
/** Pure: the cost of the capture and canvas sizes. 4K → 1080p every frame is the one that hurts next to a game. */
export function rescaleAdvice(a: { video: VideoInfo; shown: { w: number; h: number } | null; box: Rect | null; kind: string; scaleType: string | null; streaming: boolean }): Advice[] {
  const out: Advice[] = [];
  const v = a.video;
  const px = (w: number, h: number) => w * h;
  if (px(v.baseW, v.baseH) >= 1.8 * px(v.outW, v.outH)) {
    out.push({ id: 'canvas', level: 'warn',
      text: `OBS draws everything at ${v.baseW}×${v.baseH} and then shrinks it to ${v.outW}×${v.outH} for the stream, every frame. That costs graphics power your game needs.`,
      ...(a.streaming ? { manual: 'Stop streaming and recording first, then OBS → Settings → Video → Base (Canvas) Resolution = Output (Scaled) Resolution.' }
        : { fix: { action: 'canvas' as const, label: `Make OBS draw at ${v.outW}×${v.outH}` } }) });
  }
  if (a.shown && a.box && a.box.w > 0 && a.box.h > 0 && a.kind === 'monitor_capture' && px(a.shown.w, a.shown.h) >= 1.8 * px(a.box.w, a.box.h)) {
    const soft = a.scaleType === 'bilinear' || a.scaleType === 'bicubic';
    out.push({ id: 'capture-rescale', level: soft ? 'info' : 'warn',
      text: `This Display Capture is ${a.shown.w}×${a.shown.h} and OBS shrinks it to ${Math.round(a.box.w)}×${Math.round(a.box.h)} every frame.${soft ? '' : ' OBS’s Downscale Filter is set to a heavier one.'}`,
      ...(!soft && a.scaleType && !a.streaming ? { fix: { action: 'scale-type' as const, label: 'Use the lighter Bilinear downscale' } } : {}),
      manual: 'Cheapest of all: run the game at 1080p (or crop the Display Capture to the game’s window) so nothing has to be shrunk.' });
  }
  return out;
}
/** Pure: the studio paths that cost the most with a big Display Capture. */
export function screenPathAdvice(a: { kind: string; shown: { w: number; h: number } | null; screenMode: string; fx: boolean; obsAuto: boolean; mode: string }): Advice[] {
  if (a.kind !== 'monitor_capture') return [];
  const big = !!a.shown && a.shown.w * a.shown.h >= 2560 * 1440;
  if (a.mode === 'gaming') return [];                                 // Gaming always shows the capture through the OBS hole
  if (a.mode === 'react' && big && (a.screenMode === 'inscene' || a.fx || !a.obsAuto)) {
    return [{ id: 'react-feed', level: 'warn', text: `VTube Pro is drawing your ${a.shown!.w}×${a.shown!.h} monitor inside the room, which is heavy next to a game. ${
      a.screenMode === 'inscene' ? 'The React screen is set to In-scene capture.' : a.fx ? 'Glass sheen or scanlines are on.' : 'OBS automation is off.'} The OBS hole uses OBS’s own capture and costs far less.`,
      manual: a.screenMode === 'inscene' ? 'Show → React screen → Auto.' : a.fx ? 'Show → React screen → turn Glass sheen and Scanlines off.' : 'Scene tab → OBS automation → turn it on and pick the capture source.' }];
  }
  return [];
}

// ================================================================ OBS-side settings
export const isSoftwareEncoder = (enc: string | null | undefined) => !!enc && /x264|openh264|ffmpeg_aac_h264/i.test(enc);
/** Simple output mode's names for a hardware encoder by graphics-card maker (OBS [SimpleOutput] StreamEncoder). */
export const SIMPLE_HW: Record<string, string> = { nvidia: 'nvenc', amd: 'amd', intel: 'qsv' };
const HW_NAME: Record<string, string> = { nvidia: 'NVIDIA NVENC', amd: 'AMD AMF', intel: 'Intel Quick Sync' };
export function encoderAdvice(a: { mode: 'Simple' | 'Advanced' | null; encoder: string | null; vendor: string | null; streaming: boolean }): Advice[] {
  if (!a.encoder || !isSoftwareEncoder(a.encoder)) return [];
  const name = a.vendor && HW_NAME[a.vendor] ? HW_NAME[a.vendor] : 'a hardware encoder (NVENC, AMF or Quick Sync)';
  const text = `OBS is encoding your stream on the processor (${a.encoder}). That takes processor time the game needs; ${name} does it on the graphics card’s video chip instead.`;
  if (a.mode === 'Simple' && a.vendor && SIMPLE_HW[a.vendor] && !a.streaming) return [{ id: 'encoder', level: 'warn', text, fix: { action: 'encoder', label: `Switch OBS to ${HW_NAME[a.vendor]}` } }];
  return [{ id: 'encoder', level: 'warn', text, manual: `${a.streaming ? 'Stop the stream first. ' : ''}OBS → Settings → Output → Encoder → pick the ${a.vendor && HW_NAME[a.vendor] ? HW_NAME[a.vendor] : 'NVENC / AMF / QuickSync'} entry.` }];
}
/** Pure: Browser Source frame rate and “Shutdown source when not visible” for the VTube Pro page. */
export function browserAdvice(a: { name: string; settings: Record<string, unknown>; canvasFps: number }): Advice[] {
  const out: Advice[] = [];
  const fps = Math.round(a.canvasFps);
  const custom = a.settings.fps_custom === true, rate = finite(a.settings.fps) ? Math.round(a.settings.fps as number) : 30;
  if (custom && fps > 0 && Math.abs(rate - fps) >= 1) {
    out.push({ id: 'browser-fps', level: 'warn',
      text: rate > fps ? `The VTube Pro page “${a.name}” draws ${rate} frames a second but your OBS picture is ${fps}. The extra frames are never seen and take graphics power.`
        : `The VTube Pro page “${a.name}” draws ${rate} frames a second but your OBS picture is ${fps}, so the avatar looks choppier than it has to.`,
      fix: { action: 'browser-fps', label: `Match it to ${fps} fps` } });
  }
  if (a.settings.shutdown === true) {
    out.push({ id: 'browser-shutdown', level: 'warn',
      text: `“${a.name}” has “Shutdown source when not visible” on, so the whole page is torn down and rebuilt every time its scene is hidden and shown again. That is a hitch on stream.`,
      fix: { action: 'browser-shutdown', label: 'Turn it off' } });
  }
  return out;
}
/** Pure: OBS's own numbers (GetStats). Frames OBS could not render are lost graphics time; skipped output frames are the encoder. */
export interface ObsStats { activeFps?: number; cpuUsage?: number; renderSkippedFrames?: number; renderTotalFrames?: number; outputSkippedFrames?: number; outputTotalFrames?: number; averageFrameRenderTime?: number }
export function statsAdvice(s: ObsStats | null, canvasFps: number): Advice[] {
  if (!s) return [];
  const out: Advice[] = [];
  const pct = (a?: number, b?: number) => (finite(a) && finite(b) && b > 600 ? (100 * a) / b : 0);
  const rend = pct(s.renderSkippedFrames, s.renderTotalFrames), enc = pct(s.outputSkippedFrames, s.outputTotalFrames);
  if (rend >= 1) out.push({ id: 'render-lag', level: 'warn', text: `OBS missed ${rend.toFixed(1)} % of its frames because the graphics card was too busy. Capping the game at 60 fps, or running OBS as administrator, gives OBS its share.`, manual: 'Cap the game’s frame rate (the game’s settings, NVIDIA Control Panel or AMD Software).' });
  if (enc >= 1) out.push({ id: 'encode-lag', level: 'warn', text: `The encoder skipped ${enc.toFixed(1)} % of the frames. Use a hardware encoder (NVENC / AMF / Quick Sync) or a lower resolution.` });
  if (finite(s.activeFps) && canvasFps > 0 && s.activeFps < 0.9 * canvasFps && out.length === 0) out.push({ id: 'low-fps', level: 'info', text: `OBS is running at ${s.activeFps.toFixed(0)} fps of ${Math.round(canvasFps)}.` });
  return out;
}
/** Pure: OBS's log (its newest file in the OBS folder). “D3D11 GPU priority setup failed (not admin?)” = OBS is not run as
 *  administrator, so a game that fills the card wins the card from OBS. */
export function parseObsLog(text: string): { notAdmin: boolean | null; renderLagPct: number | null; encodeLagPct: number | null } {
  const t = String(text ?? '');
  const notAdmin = /GPU priority setup failed/i.test(t) ? true : /GPU priority (setup )?(succeeded|set to)|d3d11 gpu priority/i.test(t) ? false : null;
  const pctOf = (re: RegExp) => { let best: number | null = null; for (const m of t.matchAll(re)) { const p = parseFloat(m[1]); if (Number.isFinite(p) && (best === null || p > best)) best = p; } return best; };
  return {
    notAdmin,
    renderLagPct: pctOf(/lagged frames due to rendering lag\/stalls:\s*\d+\s*\(([\d.]+)%\)/gi),
    encodeLagPct: pctOf(/skipped frames due to encoding lag:\s*\d+\/\d+\s*\(([\d.]+)%\)/gi),
  };
}
export const ADMIN_STEPS = [
  'Close OBS.',
  'Right-click the OBS icon (Start menu or desktop) and choose “Run as administrator”. Windows asks once: press Yes.',
  'To do it every time: right-click the OBS icon → Properties → Compatibility → tick “Run this program as an administrator” → OK.',
  'VTube Pro never starts OBS for you and never raises anything itself.',
];

// ================================================================ "a fullscreen game is running: use For games?"
/** Pure: should the studio ask (once) whether face tracking should move to the processor ("For games")? Only when the
 *  person picked the graphics card by hand ('gpu'): Auto already moves the models off the card by itself the moment a game
 *  holds it (src/tracking/stallGuard.ts), so there is nothing to ask, and 'cpu' / 'nogpu' already are what we'd suggest. */
export function nudgeDecision(a: { helper: boolean; trackingOn: boolean; policy: string; busyMs: number; stall: boolean; dismissed: boolean; shownThisSession: boolean; sinceLastAskMs: number }): boolean {
  if (!a.helper || !a.trackingOn || a.dismissed || a.shownThisSession || a.policy !== 'gpu') return false;
  if (a.sinceLastAskMs < 5 * 60_000) return false;
  return a.stall || a.busyMs >= 10_000;
}
export const nudgeText = (game: string) => `${game ? `“${game.replace(/\.exe$/i, '')}”` : 'A game'} is running fullscreen. Run your face tracking on the processor so it stops fighting the game for the graphics card?`;

// ================================================================ what the helper tells the studio (GET /api/obs/gaming)
export interface GamingStatus {
  ok: boolean; connected: boolean; error?: string; fix?: string;
  scene: string | null;
  /** The Game Capture the check followed (null = none in the scene OBS is showing). */
  capture: { source: string; judged: CaptureJudgement; blankForMs: number; confirmed: boolean; mode: string | null } | null;
  game: { exe: string; title: string; monitor: { w: number; h: number }; fullscreen: boolean } | null;
  hint: BlockerHint | null;
  offer: Offer;
  /** Set when a fallback this feature made is in the scene (the Game Capture is hidden): the studio shows Undo. */
  fallback: { input: string; kind: FallbackKind; gameCapture: string; undoId: string } | null;
  snoozed: boolean;
  remembered: FallbackKind | null;
  advice: Advice[];
  settingsApi: boolean;
  video: VideoInfo | null;
  admin: { notAdmin: boolean | null; steps: string[]; renderLagPct: number | null };
  undo: { id: string; label: string } | null;
  elsewhere: boolean;
  /** OBS automation is on with a capture source (the React hole is placed by OBS itself). */
  automation: boolean;
  /** The Display Capture shown in the scene, if any: its size after cropping (the studio judges the React path with it). */
  display: { source: string; w: number; h: number } | null;
}
