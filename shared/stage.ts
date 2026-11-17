// Stage layouts (docs/SCENES.md → "Stage modes"): how the frame is shared between the capture window (react / game),
// the performers and the chat / support displays, per scene mode (Talk · React · Gaming · modes other workstreams
// register, src/scene/stage/registry.ts).
//
// Pure data + maths (no three.js, no DOM): the server sanitises it, the studio's mini preview draws the SAME plan the
// OBS pages render, party guests' pages compute the same layout from the host's state.
//
//   SceneState.stage   host-owned presets (react size, gaming layout, strip height, solo cam corner / size, docks …)
//   SceneState.modes   per-mode JSON bags for registered modes (generic sanitiser; each mode re-validates its own)
//
// Geometry is authored in 1080-high "design px" (the frame is 1080·aspect wide) and returned as fractions of the frame
// (x, y, w, h — top-left origin), so it follows any OBS canvas size.
import { baseRoomId } from './roomId.ts';
import { sanitizeChatBox, type ChatBoxPlace } from './chatBox.ts';

// ---------------------------------------------------------------- state
export type ReactPreset = 'auto' | 'full' | 'big' | 'medium' | 'side';
export type GamingLayout = 'auto' | 'corner' | 'strip-bottom' | 'strip-top' | 'column';
export type SizeStep = 's' | 'm' | 'l';
export type Corner = 'bl' | 'br' | 'tl' | 'tr';
export type CamBackdrop = 'room' | 'clean' | 'cutout';
export type DockMode = 'auto' | 'always' | 'off';
export type Framing = 'bust' | 'full';

export interface SceneStageState {
  /** React window size (Scene tab → React). auto = by group size: 1 → side, 2–4 → big, 5+ → medium. */
  react: ReactPreset;
  /** Gaming layout. auto = 1 → corner cam, 2+ → strip along the bottom. */
  gaming: GamingLayout;
  /** Strip height (strip layouts) / column width (column layout). */
  strip: SizeStep;
  /** Solo corner cam: which corner of the game, its size and framing. */
  corner: Corner;
  cam: SizeStep;
  framing: Framing;
  /** What is behind a gaming cam: the room (default), a clean studio backdrop, or nothing (a cut-out over the game). */
  backdrop: CamBackdrop;
  /** Docked chat / support panels: auto = whenever the in-world rigs can't show them; always; off. */
  dock: { chat: DockMode; support: DockMode };
  /** 3+ performers in Gaming → the party moves to the Gaming Lounge (loungeRoom). */
  lounge: boolean;
  loungeRoom: string;
  /** Member keys in join order (host first) — the strip / tile order. Kept by the host's controller. */
  order: string[];
  /** Where a room-moving mode (Gaming → lounge, TTRPG → tabletop) came from; leaving that mode goes back there. */
  back?: { sceneId: string | null; mode: string };
  /** The current mode shows an OBS passthrough hole (server/obs.ts keeps the capture visible). */
  hole?: boolean;
  /** Line-up test pattern around the hole, shown until this time (epoch ms, host clock → converted on guests). */
  test?: number;
  /** Aspect of the captured content (the hole rect keeps it, so the capture fills it exactly): 16:9 by default. */
  content?: number;
  /** Walking-TV guests (S\tv): their cam shows their live picture (framed like a TV) instead of the 3D TV. */
  tvFeed?: boolean;
  /** Names on the cams' name tags, member key → name (the host's "My name on screen", host overrides for guests);
   *  missing = the performer's own party / avatar name. */
  names?: Record<string, string>;
  /** Docked chat panel text size, × the default (≈ 18 px at 1080p). 0.6 – 1.6. */
  chatText?: number;
  /** Where the docked chat box sits, its size and opacity (shared/chatBox.ts; missing = automatic). */
  chatBox?: ChatBoxPlace;
  /** React Big: people moved off seats in front of the screen, member key → their own seat (restored after Big). */
  reseat?: Record<string, number>;
}

export const DEFAULT_STAGE: SceneStageState = {
  react: 'auto', gaming: 'auto', strip: 'm', corner: 'bl', cam: 'm', framing: 'bust', backdrop: 'room',
  dock: { chat: 'auto', support: 'auto' }, lounge: true, loungeRoom: 'gaming_lounge', order: [],
};

const pick = <T extends string>(v: unknown, all: readonly T[], d: T): T => (typeof v === 'string' && (all as readonly string[]).includes(v) ? v as T : d);
const KEY = /^(@host|[a-z0-9]{6,32}|lib:[A-Za-z0-9_-]{1,48})$/;
export const MODE_ID = /^[a-z][a-z0-9-]{1,23}$/;
export const isModeId = (v: unknown): v is string => typeof v === 'string' && MODE_ID.test(v);
const SCENE_ID = /^[a-z0-9][a-z0-9_-]{0,47}(?:~[a-z0-9][a-z0-9_-]{0,23})?$/;   // + `~<area>` (shared/roomId.ts)
export const REACT_PRESETS = ['auto', 'full', 'big', 'medium', 'side'] as const;
export const GAMING_LAYOUTS = ['auto', 'corner', 'strip-bottom', 'strip-top', 'column'] as const;
const STEPS = ['s', 'm', 'l'] as const;
const CORNERS = ['bl', 'br', 'tl', 'tr'] as const;
const DOCKS = ['auto', 'always', 'off'] as const;
/** Capture aspects offered (16:9 screens, 16:10 laptops, 21:9 / 32:9 ultrawides, 4:3 retro). */
export const CONTENT_ASPECTS = [16 / 9, 16 / 10, 21 / 9, 32 / 9, 4 / 3] as const;

/** A name for the cams' name tags: printable, single-spaced, ≤ 32 characters ('' = none). */
export function cleanStageName(v: string): string {
  return v.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/ {2,}/g, ' ').trim().slice(0, 32).trim();
}

export function sanitizeStageState(o: unknown): SceneStageState {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const d = DEFAULT_STAGE;
  const dk = (x.dock && typeof x.dock === 'object' ? x.dock : {}) as Record<string, unknown>;
  const order = Array.isArray(x.order) ? [...new Set(x.order.filter((k): k is string => typeof k === 'string' && KEY.test(k)))].slice(0, 24) : [];
  const b = (x.back && typeof x.back === 'object' ? x.back : null) as Record<string, unknown> | null;
  const back = b && (b.sceneId === null || (typeof b.sceneId === 'string' && SCENE_ID.test(b.sceneId))) && isModeId(b.mode) ? { sceneId: b.sceneId as string | null, mode: b.mode } : undefined;
  const content = typeof x.content === 'number' && Number.isFinite(x.content) ? CONTENT_ASPECTS.find((a) => Math.abs(a - (x.content as number)) < 0.02) : undefined;
  return {
    react: pick(x.react, REACT_PRESETS, d.react),
    gaming: pick(x.gaming, GAMING_LAYOUTS, d.gaming),
    strip: pick(x.strip, STEPS, d.strip),
    corner: pick(x.corner, CORNERS, d.corner),
    cam: pick(x.cam, STEPS, d.cam),
    framing: pick(x.framing, ['bust', 'full'] as const, d.framing),
    backdrop: pick(x.backdrop, ['room', 'clean', 'cutout'] as const, d.backdrop),
    dock: { chat: pick(dk.chat, DOCKS, d.dock.chat), support: pick(dk.support, DOCKS, d.dock.support) },
    lounge: typeof x.lounge === 'boolean' ? x.lounge : d.lounge,
    loungeRoom: typeof x.loungeRoom === 'string' && SCENE_ID.test(x.loungeRoom) ? x.loungeRoom : d.loungeRoom,
    order,
    ...(back ? { back } : {}),
    ...(x.hole === true ? { hole: true } : {}),
    ...(typeof x.test === 'number' && Number.isFinite(x.test) && x.test > 0 && x.test < 1e14 ? { test: x.test } : {}),
    ...(content && Math.abs(content - 16 / 9) > 0.01 ? { content } : {}),
    ...(x.tvFeed === true ? { tvFeed: true } : {}),
    ...((): { names?: Record<string, string> } => {
      if (!x.names || typeof x.names !== 'object') return {};
      const o: Record<string, string> = {};
      for (const [k, v] of Object.entries(x.names as Record<string, unknown>).slice(0, 24)) { const n = typeof v === 'string' ? cleanStageName(v) : ''; if (KEY.test(k) && n) o[k] = n; }
      return Object.keys(o).length ? { names: o } : {};
    })(),
    ...(typeof x.chatText === 'number' && Number.isFinite(x.chatText) && Math.abs(x.chatText - 1) > 0.004 ? { chatText: Math.min(1.6, Math.max(0.6, Math.round(x.chatText * 100) / 100)) } : {}),
    ...(x.chatBox && typeof x.chatBox === 'object' ? { chatBox: sanitizeChatBox(x.chatBox) } : {}),
    ...((): { reseat?: Record<string, number> } => {
      if (!x.reseat || typeof x.reseat !== 'object') return {};
      const o: Record<string, number> = {};
      for (const [k, v] of Object.entries(x.reseat as Record<string, unknown>).slice(0, 24)) if (KEY.test(k) && typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 32) o[k] = v;
      return Object.keys(o).length ? { reseat: o } : {};
    })(),
  };
}

// ---------------------------------------------------------------- generic per-mode bags (SceneState.modes)
const BAG_BYTES = 6000;
export const MAX_MODE_BAGS = 24;
function cleanJson(v: unknown, depth: number): unknown {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') return v.slice(0, 200);
  if (depth <= 0) return undefined;
  if (Array.isArray(v)) return v.slice(0, 32).map((e) => cleanJson(e, depth - 1)).filter((e) => e !== undefined);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
      if (n >= 32 || !/^[A-Za-z0-9_@:.-]{1,48}$/.test(k) || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      const c = cleanJson(e, depth - 1);
      if (c !== undefined) { out[k] = c; n++; }
    }
    return out;
  }
  return undefined;
}
/** SceneState.modes: ≤ 24 registered modes' settings, plain JSON only (depth ≤ 5, ≤ 6 KB each). The cap was 12 before beta.16; the eleven
 *  feature lanes added rules, throw, items, emoterain and hype next to the nine older bags, and the 13th one was silently dropped. */
export function sanitizeModeBags(o: unknown): Record<string, unknown> | undefined {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (n >= MAX_MODE_BAGS || !isModeId(k)) continue;
    const c = cleanJson(v, 5);
    if (c === undefined) continue;
    try { if (JSON.stringify(c).length > BAG_BYTES) continue; } catch { continue; }
    out[k] = c; n++;
  }
  return n ? out : undefined;
}

// ---------------------------------------------------------------- plans
/** Fractions of the output frame, top-left origin. */
export interface Rect { x: number; y: number; w: number; h: number }
export interface TilePlan {
  /** Member key ('@host' / party id / 'lib:x' stand-ins). */
  key: string;
  rect: Rect;
  framing: Framing;
  backdrop: CamBackdrop;
  /** Name tag: under the tile, inside it (bottom), or none. */
  tag: 'below' | 'inside' | 'none';
  /** The host's tile (gold edge + crown). */
  hero?: boolean;
}
export interface StagePlan {
  /** Changes when the composition is a different one (the page morphs to it). */
  key: string;
  /** '3d' = the room camera render is the base (Talk, Big, Side …); 'composite' = a styled backdrop with the capture +
   *  performer cams laid out on it (Full, Medium, Gaming). */
  view: '3d' | 'composite';
  /** The capture window: OBS passthrough hole or the in-scene video (composite views). 3d views: the room's screen. */
  capture: Rect | null;
  tiles: TilePlan[];
  /** 3d views: performers not clearly visible in the shot get tiles in free space (never over faces / the screen). */
  rail?: boolean;
  /** Docked panels: explicit rects (composite) or 'auto' (searched in free space, only when the in-world rigs can't
   *  show them), null = none. */
  docks: { chat: Rect | 'auto' | null; support: Rect | 'auto' | null };
  /** What the plan is, for the UI ("Medium · 4 performers"). */
  label: string;
  /** 3d views: the room shot drawn smaller, in this rect (fractions, the frame's aspect) — the camera's view is widened
   *  around it, so the docks / cams get the free columns beside and under it (React Big / Side). */
  inset?: Rect;
  /** HUD elements drawn over the frame (the Full screen HUD layouts, shared/hud.ts; docs/LAYOUTS.md). */
  hud?: { id: string; type: string; rect: Rect; opacity: number; props: Record<string, string | number | boolean> }[];
}

export interface PlanInput {
  /** Frame aspect (w / h). */
  aspect: number;
  /** Performer keys in order (host first). */
  keys: string[];
  /** Capture content aspect (default 16:9). */
  content?: number;
  /** Docks wanted (false = its space goes to the capture). */
  chat?: boolean;
  support?: boolean;
}

const P = 20, G = 12;
const HOST = '@host';
const fr = (x: number, y: number, w: number, h: number, W: number): Rect => ({ x: x / W, y: y / 1080, w: w / W, h: h / 1080 });
const cam = (key: string, x: number, y: number, w: number, h: number, W: number, framing: Framing, backdrop: CamBackdrop, tag: TilePlan['tag'] = 'inside'): TilePlan =>
  ({ key, rect: fr(x, y, w, h, W), framing, backdrop, tag, ...(key === HOST ? { hero: true } : {}) });

/** React preset in effect for n performers in the room. */
export function resolveReact(preset: ReactPreset, n: number, hasBigScreen = true): Exclude<ReactPreset, 'auto'> {
  if (preset !== 'auto') return preset === 'big' && !hasBigScreen ? 'medium' : preset;
  if (n <= 1) return 'side';
  if (n <= 4 && hasBigScreen) return 'big';
  return 'medium';
}
/** Gaming layout in effect for n performers. */
export function resolveGaming(layout: GamingLayout, n: number): Exclude<GamingLayout, 'auto'> {
  if (layout !== 'auto') return layout;
  return n <= 1 ? 'corner' : 'strip-bottom';
}
/** Does Gaming move this group to the lounge? (the host's rule; guests follow the host's room) */
export const wantsLounge = (st: SceneStageState, n: number) => st.lounge && n > 2;

export const REACT_LABEL: Record<ReactPreset, string> = { auto: 'Auto', full: 'Full', big: 'Big', medium: 'Medium', side: 'Side' };
export const GAMING_LABEL: Record<GamingLayout, string> = { auto: 'Auto', corner: 'Corner cam', 'strip-bottom': 'Strip bottom', 'strip-top': 'Strip top', column: 'Side column' };

/** Largest content-aspect box inside w × h. */
function fitAspect(w: number, h: number, a: number) { return w / h > a ? { w: h * a, h } : { w, h: w / a }; }

/** Tiles in a row, left → right in order, each at most `maxA` wide per tall (left-aligned). */
function row(keys: string[], x: number, y: number, w: number, h: number, W: number, framing: Framing, backdrop: CamBackdrop, maxA = 2.2, heroK = 1): TilePlan[] {
  const n = keys.length;
  if (!n) return [];
  // the host's tile may be a little wider ("prominent")
  const hasHero = keys[0] === HOST && heroK > 1 && n > 1;
  const units = n + (hasHero ? heroK - 1 : 0);
  let cw = (w - (n - 1) * G) / units;
  cw = Math.min(cw, h * maxA / (hasHero ? heroK : 1));
  const out: TilePlan[] = [];
  let cx = x;
  keys.forEach((k, i) => {
    const ww = i === 0 && hasHero ? cw * heroK : cw;
    out.push(cam(k, cx, y, ww, h, W, framing, backdrop));
    cx += ww + G;
  });
  return out;
}
/** Tiles in a column, top → bottom, each at most `maxTall` tall per wide. */
function column(keys: string[], x: number, y: number, w: number, h: number, W: number, framing: Framing, backdrop: CamBackdrop, maxTall = 1.25): TilePlan[] {
  const n = keys.length;
  if (!n) return [];
  const ch = Math.min((h - (n - 1) * G) / n, w * maxTall);
  return keys.map((k, i) => cam(k, x, y + i * (ch + G), w, ch, W, framing, backdrop));
}
/** Two-row grid (≥ 5 tiles in a short band). */
function grid(keys: string[], x: number, y: number, w: number, h: number, W: number, framing: Framing, backdrop: CamBackdrop, maxA = 2.2): TilePlan[] {
  if (keys.length <= 4) return row(keys, x, y, w, h, W, framing, backdrop, maxA);
  const top = Math.ceil(keys.length / 2);
  const rh = (h - G) / 2;
  return [...row(keys.slice(0, top), x, y, w, rh, W, framing, backdrop, maxA), ...row(keys.slice(top), x, y + rh + G, w, rh, W, framing, backdrop, maxA)];
}

/** React Full: the capture as big as the docks allow, performers in front of its bottom corners (host bottom-left). */
export function planReactFull(inp: PlanInput): StagePlan {
  const W = 1080 * inp.aspect, a = inp.content ?? 16 / 9, n = inp.keys.length;
  const docks = inp.chat !== false || inp.support !== false;
  const CC = docks ? Math.round(Math.min(340, Math.max(250, W * 0.155))) : 0;
  const cap = fitAspect(W - 2 * P - (docks ? G + CC : 0), 1080 - 2 * P, a);
  const capX = P, capY = P;
  const tiles: TilePlan[] = [];
  const hh = n <= 1 ? 0.36 : n === 2 ? 0.32 : n <= 4 ? 0.3 : 0.26;
  const gh = n <= 2 ? hh : n <= 4 ? 0.24 : 0.19;
  const ta = 0.82;                                                    // bust tiles, a little taller than wide
  const bottom = 1080 - P;
  const hostH = hh * 1080, hostW = hostH * ta, gH = gh * 1080, gW = gH * ta;
  const [host, ...guests] = inp.keys;
  if (host) tiles.push(cam(host, capX + G, bottom - hostH, hostW, hostH, W, 'bust', 'room', 'inside'));
  if (n === 2) tiles.push(cam(guests[0], capX + cap.w - G - gW, bottom - gH, gW, gH, W, 'bust', 'room', 'inside'));
  else if (n > 2) {
    // left cluster after the host, right cluster at the capture's right edge: the middle stays clear (subtitles)
    const left = guests.slice(0, Math.ceil(guests.length / 2) - (n <= 4 ? 1 : 0));
    const right = guests.slice(left.length);
    let x = capX + G + hostW + G;
    for (const k of left) { tiles.push(cam(k, x, bottom - gH, gW, gH, W, 'bust', 'room', 'inside')); x += gW + G; }
    let xr = capX + cap.w - G - gW;
    for (const k of [...right].reverse()) { tiles.push(cam(k, xr, bottom - gH, gW, gH, W, 'bust', 'room', 'inside')); xr -= gW + G; }
  }
  const colX = capX + cap.w + G, colW = W - P - colX;
  const chatH = inp.support === false ? 1080 - 2 * P : Math.round((1080 - 2 * P - G) * 0.64);
  return {
    key: `full:${n}:${inp.aspect.toFixed(3)}:${a.toFixed(3)}:${+!!docks}`, view: 'composite', label: 'Full',
    capture: fr(capX, capY, cap.w, cap.h, W),
    tiles,
    docks: {
      chat: docks && inp.chat !== false ? fr(colX, P, colW, chatH, W) : null,
      support: docks && inp.support !== false ? fr(colX, inp.chat === false ? P : P + chatH + G, colW, inp.chat === false ? 1080 - 2 * P : 1080 - 2 * P - chatH - G, W) : null,
    },
  };
}

/** React Medium: the capture ~63 % wide, performers clearly visible below it (host first, bigger), chat + support right. */
export function planReactMedium(inp: PlanInput): StagePlan {
  const W = 1080 * inp.aspect, a = inp.content ?? 16 / 9, n = inp.keys.length;
  const CC = Math.round(Math.min(560, Math.max(300, W * 0.3)));
  const cap = fitAspect(W - 2 * P - G - CC, (1080 - 2 * P - G) * 0.68, a);
  const capX = P, capY = P;
  const colX = capX + cap.w + G, colW = W - P - colX;
  const bandY = capY + cap.h + G, bandH = 1080 - P - bandY;
  const tiles: TilePlan[] = [];
  let chat: Rect | null, support: Rect | null;
  const colH = 1080 - 2 * P;
  if (n <= 1) {
    // alone: the host is the hero in the right column, chat under them, support under the capture
    const hostH = Math.min(colH * 0.46, colW / 1.25);
    if (inp.keys[0]) tiles.push(cam(inp.keys[0], colX, P, colW, hostH, W, 'bust', 'room', 'inside'));
    chat = fr(colX, P + hostH + G, colW, colH - hostH - G, W);
    support = fr(capX, bandY, cap.w, bandH, W);
  } else {
    // everyone under the capture: the host first and 1.35× wider; 5+ → two rows
    const keys = inp.keys;
    if (keys.length <= 4) tiles.push(...row(keys, capX, bandY, cap.w, bandH, W, 'bust', 'room', 1.9, 1.35));
    else {
      // host tile spans both rows, guests in a 2-row grid beside it
      const hostW = Math.min(bandH * 1.0, cap.w * 0.3);
      tiles.push(cam(keys[0], capX, bandY, hostW, bandH, W, 'bust', 'room', 'inside'));
      tiles.push(...grid(keys.slice(1), capX + hostW + G, bandY, cap.w - hostW - G, bandH, W, 'bust', 'room', 1.9));
    }
    const chatH = Math.round((colH - G) * 0.66);
    chat = fr(colX, P, colW, chatH, W);
    support = fr(colX, P + chatH + G, colW, colH - chatH - G, W);
  }
  if (inp.chat === false && inp.support === false) { chat = null; support = null; }
  else if (inp.chat === false) { support = support && n > 1 ? fr(colX, P, colW, colH, W) : support; chat = null; }
  else if (inp.support === false) { if (n > 1) chat = fr(colX, P, colW, colH, W); support = null; }
  return { key: `medium:${n}:${inp.aspect.toFixed(3)}:${a.toFixed(3)}:${+(inp.chat !== false)}${+(inp.support !== false)}`, view: 'composite', label: 'Medium', capture: fr(capX, capY, cap.w, cap.h, W), tiles, docks: { chat, support } };
}

export interface GamingInput extends PlanInput {
  layout: Exclude<GamingLayout, 'auto'>;
  strip: SizeStep;
  corner: Corner;
  cam: SizeStep;
  framing: Framing;
  backdrop: CamBackdrop;
}

/** Support panel sizes in Gaming (1080p units): a slim ticker in the band under the game, a compact two-row box in a
 *  column, a card when the column holds nothing else. The user asked for them small: the game is the star. */
const SUP_BAND = 76, SUP_COL = 112, SUP_CARD = 220;

/** Gaming: the game capture is the star, performers are live cams. */
export function planGaming(inp: GamingInput): StagePlan {
  const W = 1080 * inp.aspect, a = inp.content ?? 16 / 9, n = inp.keys.length;
  const wantChat = inp.chat !== false, wantSup = inp.support !== false;
  const bd = inp.backdrop;
  const keyBase = `gaming:${inp.layout}:${n}:${inp.aspect.toFixed(3)}:${a.toFixed(3)}:${+wantChat}${+wantSup}:${inp.strip}:${inp.corner}:${inp.cam}:${inp.framing}:${bd}`;
  // a column beside the game holding chat and / or support (support compact, at the bottom — or the top over a top strip)
  const colDocks = (x: number, y: number, w: number, h: number, supTop = false): { chat: Rect | null; support: Rect | null } => {
    if (wantChat && wantSup) {
      const sh = Math.min(SUP_COL, Math.round(h * 0.3));
      return supTop ? { support: fr(x, y, w, sh, W), chat: fr(x, y + sh + G, w, h - sh - G, W) } : { chat: fr(x, y, w, h - sh - G, W), support: fr(x, y + h - sh, w, sh, W) };
    }
    if (wantChat) return { chat: fr(x, y, w, h, W), support: null };
    if (wantSup) { const sh = Math.min(h, SUP_CARD); return { chat: null, support: fr(x, supTop ? y : y + h - sh, w, sh, W) }; }
    return { chat: null, support: null };
  };
  if (inp.layout === 'corner') {
    const CC = wantChat || wantSup ? Math.round(Math.min(340, Math.max(250, W * 0.155))) : 0;
    const cap = fitAspect(W - 2 * P - (CC ? G + CC : 0), 1080 - 2 * P, a);
    const capX = P, capY = P;
    const hK = { s: 0.28, m: 0.38, l: 0.5 }[inp.cam];
    // smarter auto sizing: several cams in the corner shrink (never more than ~62 % of the game's width), and a short
    // (ultrawide) game never gets a cam taller than about half its height
    const ratio = inp.framing === 'full' ? 0.62 : 0.84, nK = n <= 1 ? 1 : n === 2 ? 0.82 : n === 3 ? 0.7 : 0.6;
    let camH = Math.min(hK * nK * 1080, cap.h * 0.56), camW = camH * ratio;
    const maxRow = cap.w * 0.62;
    if (n > 0 && n * camW + (n - 1) * G > maxRow) { camW = (maxRow - (n - 1) * G) / n; camH = camW / ratio; }
    const tiles: TilePlan[] = [];
    const top = inp.corner[0] === 't', left = inp.corner[1] === 'l';
    const y = top ? capY + G : Math.min(1080 - P, capY + cap.h + (1080 - P - capY - cap.h)) - camH;
    // host left of the guest(s), whichever corner
    const total = n * camW + (n - 1) * G;
    let x = left ? capX + G : capX + cap.w - G - total;
    for (const k of inp.keys) { tiles.push(cam(k, x, y, camW, camH, W, inp.framing, bd)); x += camW + G; }
    const colX = capX + cap.w + G, colW = W - P - colX, colH = 1080 - 2 * P;
    let chat: Rect | null = null, support: Rect | null = null;
    // the band under the game (when the game is width-limited): a slim support ticker beside the cam, on the bottom edge
    // (level with the cam and the chat column)
    const bandY = capY + cap.h + G, bandH = 1080 - P - bandY;
    if (wantSup && bandH >= 56) {
      const sx = !top && left ? x : capX, sw = !top && left ? capX + cap.w - x : !top ? cap.w - total - G : cap.w;
      const sh = Math.min(bandH, SUP_BAND);
      if (sw > 260) support = fr(sx, 1080 - P - sh, sw, sh, W);
    }
    if (CC) {
      const d = colDocks(colX, P, colW, colH);
      if (support) chat = wantChat ? fr(colX, P, colW, colH, W) : null;
      else ({ chat, support } = d);
    }
    return { key: keyBase, view: 'composite', label: 'Corner cam', capture: fr(capX, capY, cap.w, cap.h, W), tiles, docks: { chat, support } };
  }
  if (inp.layout === 'column') {
    const TW = { s: 240, m: 300, l: 380 }[inp.strip];
    const CC = wantChat || wantSup ? Math.round(Math.min(380, Math.max(260, W * 0.17))) : 0;
    const capX = P + TW + G;
    const cap = fitAspect(W - capX - P - (CC ? G + CC : 0), 1080 - 2 * P, a);
    const colTiles = Math.min(1080 - 2 * P, n * TW * 1.2 + (n - 1) * G);
    const tiles = column(inp.keys, P, P + (1080 - 2 * P - colTiles) / 2, TW, colTiles, W, 'bust', bd, 1.2);   // (few cams: centred)
    const colX = capX + cap.w + G, colW = W - P - colX, colH = 1080 - 2 * P;
    const bandY = P + cap.h + G, bandH = 1080 - P - bandY;
    let chat: Rect | null = null, support: Rect | null = null;
    // a slim support ticker right under the game, inside the game's column
    if (wantSup && bandH >= 56) support = fr(capX, bandY, cap.w, Math.min(bandH, SUP_BAND), W);
    if (CC) {
      const d = colDocks(colX, P, colW, colH);
      if (support) chat = wantChat ? fr(colX, P, colW, colH, W) : null;
      else ({ chat, support } = d);
    }
    return { key: keyBase, view: 'composite', label: 'Side column', capture: fr(capX, P, cap.w, cap.h, W), tiles, docks: { chat, support } };
  }
  // strips: the game above (or below) a strip of cams, host leftmost; chat right of the game, support compact at the
  // column's end (beside the strip with ≤ 4 cams, else under the chat, beside the game)
  const SH = { s: 200, m: 250, l: 310 }[inp.strip];
  const CCmin = wantChat || wantSup ? 300 : 0;
  const cap = fitAspect(W - 2 * P - (CCmin ? G + CCmin : 0), 1080 - 2 * P - G - SH, a);
  const topStrip = inp.layout === 'strip-top';
  const stripH = 1080 - 2 * P - G - cap.h;
  const capX = P, capY = topStrip ? P + stripH + G : P;
  const stripY = topStrip ? P : P + cap.h + G;
  const colX = capX + cap.w + G, colW = W - P - colX;
  let chat: Rect | null = null, support: Rect | null = null;
  let tilesW = W - 2 * P;
  if (CCmin) {
    const full = n <= 4;                                   // ≤ 4 cams: the column runs the full height beside the strip too
    if (full) tilesW = cap.w;
    ({ chat, support } = full ? colDocks(colX, P, colW, 1080 - 2 * P, topStrip) : colDocks(colX, capY, colW, cap.h, topStrip));
  }
  // few cams keep a cam shape (≤ 1.7:1 alone, ≤ 2.4:1 each) and are centred under the game — never a mostly empty strip
  const maxA = n === 1 ? 1.7 : 2.4;
  const natural = n * stripH * maxA + (n - 1) * G;
  let tx = P;
  if (n <= 8 && natural < tilesW) { tx = P + (tilesW - natural) / 2; tilesW = natural; }
  const tiles = n > 8 ? grid(inp.keys, tx, stripY, tilesW, stripH, W, 'bust', bd, 2.4) : row(inp.keys, tx, stripY, tilesW, stripH, W, 'bust', bd, maxA);
  return { key: keyBase, view: 'composite', label: topStrip ? 'Strip top' : 'Strip bottom', capture: fr(capX, capY, cap.w, cap.h, W), tiles, docks: { chat, support } };
}

export function plan3d(label: string, rail: boolean, chat: boolean, support: boolean, inset = 1): StagePlan {
  const i = inset < 0.999 ? { x: 0.012, y: 0.0185, w: inset, h: inset } : undefined;
  return { key: `3d:${label}:${+rail}:${inset.toFixed(2)}`, view: '3d', label, capture: null, tiles: [], rail, docks: { chat: chat ? 'auto' : null, support: support ? 'auto' : null }, ...(i ? { inset: i } : {}) };
}

// ---------------------------------------------------------------- looks (the docked panels / frame wear the room)
export interface StagePalette {
  /** Backdrop gradient (top → bottom), panel glass, accent (borders, glow), second accent, text, the host's gold. */
  bg0: string; bg1: string; glass: string; accent: string; accent2: string; ink: string; hero: string;
  /** Pattern drawn faintly on the backdrop. */
  pattern: 'grid' | 'scan' | 'runes' | 'hex' | 'dots' | 'stripes';
}
/** Same colours + pattern (field by field - cheaper than stringifying a palette every frame). */
export const samePalette = (a: StagePalette | null, b: StagePalette): boolean =>
  !!a && a.bg0 === b.bg0 && a.bg1 === b.bg1 && a.glass === b.glass && a.accent === b.accent && a.accent2 === b.accent2 && a.ink === b.ink && a.hero === b.hero && a.pattern === b.pattern;
const PALETTES: Record<string, StagePalette> = {
  vtp: { bg0: '#0d1320', bg1: '#060910', glass: '#0b1220', accent: '#35e3ff', accent2: '#8b5cff', ink: '#e8f6ff', hero: '#ffd166', pattern: 'grid' },
  studio: { bg0: '#0c1a14', bg1: '#050b08', glass: '#0a1712', accent: '#39ff9c', accent2: '#35e3ff', ink: '#eafff4', hero: '#ffd166', pattern: 'scan' },
  scrying: { bg0: '#1a1030', bg1: '#08060f', glass: '#140c24', accent: '#c99bff', accent2: '#ffcf6b', ink: '#f6ecff', hero: '#ffcf6b', pattern: 'runes' },
  hologram: { bg0: '#07182a', bg1: '#02070d', glass: '#061321', accent: '#4ae3ff', accent2: '#ffe14a', ink: '#e3fbff', hero: '#ffe14a', pattern: 'hex' },
  terragroup: { bg0: '#1b2330', bg1: '#0c1118', glass: '#121a24', accent: '#5fb4ff', accent2: '#e9eef5', ink: '#f4f8fc', hero: '#ffd166', pattern: 'stripes' },
  tarp: { bg0: '#1e1a12', bg1: '#0b0906', glass: '#17130c', accent: '#ffb347', accent2: '#9fbf5a', ink: '#fff3df', hero: '#ffd166', pattern: 'stripes' },
  bedsheet: { bg0: '#231c14', bg1: '#0e0b08', glass: '#1b150f', accent: '#f2c572', accent2: '#8fd3c7', ink: '#fff6e8', hero: '#ffd166', pattern: 'dots' },
  lounge: { bg0: '#170d24', bg1: '#06040b', glass: '#120a1d', accent: '#ff3fd2', accent2: '#35e3ff', ink: '#fbeaff', hero: '#ffd166', pattern: 'grid' },
  kitchen: { bg0: '#2a0d0b', bg1: '#0f0504', glass: '#1f0a08', accent: '#ffc72c', accent2: '#ff5a3c', ink: '#fff5e0', hero: '#ffc72c', pattern: 'stripes' },
  military: { bg0: '#1a1d14', bg1: '#080a06', glass: '#141710', accent: '#c6d36b', accent2: '#ff8a3d', ink: '#f2f5e6', hero: '#ffd166', pattern: 'hex' },
  epoch: { bg0: '#1c1030', bg1: '#07040d', glass: '#150c24', accent: '#ffb85c', accent2: '#8f7bff', ink: '#fff1dc', hero: '#ffb85c', pattern: 'runes' },
  city: { bg0: '#0b1426', bg1: '#03060d', glass: '#0a1222', accent: '#4ad8ff', accent2: '#ff4fa3', ink: '#e9f6ff', hero: '#ffd166', pattern: 'scan' },
};
const ROOM_PALETTE: Record<string, string> = {
  poe2_kingsmarch: 'scrying', poe2_kingsmarch_v2: 'scrying', helldivers_bridge: 'hologram', space_test: 'hologram',
  eft_labs: 'terragroup', eft_labs_rnd: 'terragroup', eft_factory: 'tarp', eft_customs_dorms: 'bedsheet', gaming_lounge: 'lounge',
  gzw_fob: 'military', gzw_crimson_camp: 'military', lastepoch_end_of_time: 'epoch', sc_area18: 'city',
};
/** The docked panels' / frame's colours for a room: scene.json `stage.palette` (a name or colours) → by room → by the
 *  room's screen skin theme → VTube Pro. */
export function stagePalette(roomId: string | null, theme?: string | null, own?: unknown): StagePalette {
  let base = PALETTES[ROOM_PALETTE[roomId ?? ''] ?? ROOM_PALETTE[baseRoomId(roomId ?? '')] ?? ''] ?? (theme ? PALETTES[theme] : undefined) ?? PALETTES.vtp;
  if (typeof own === 'string' && PALETTES[own]) base = PALETTES[own];
  else if (own && typeof own === 'object') {
    const o = own as Record<string, unknown>;
    const c = (k: keyof StagePalette) => (typeof o[k] === 'string' && /^#[0-9a-f]{6}$/i.test(o[k] as string) ? o[k] as string : base[k]);
    base = { ...base, bg0: c('bg0'), bg1: c('bg1'), glass: c('glass'), accent: c('accent'), accent2: c('accent2'), ink: c('ink'), hero: c('hero') };
  }
  return base;
}
