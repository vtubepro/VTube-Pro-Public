// HUD layouts (docs/LAYOUTS.md): screen-first OBS layouts described as DATA — where the capture goes, where the
// performers stand (boxed or cut-out), where the chat box sits by default, and a list of HUD elements (support alerts,
// a goal bar, a text label, a logo, a webcam frame …) drawn over the frame by the OBS page (src/scene/stage/hud.ts).
// Chat is never a HUD element: it is THE chat box (shared/chatBox.ts — shown Off / When active / Always, placed by the
// streamer or by the layout), drawn as a panel or as plain text (CHAT_TEXT_PROPS below, src/scene/stage/chatText.ts).
//
//   HudLayoutDef  { id, label, sub?, capture: 'full' | 'fit', cams: HudCams, chat?: HudPlace, look?: Partial<LayoutLook>,
//                   hud: HudElement[] }
//   HudElement    { id, type, on, anchor, x, y, w, h, opacity, …the type's own props }  (flat: primitives only)
//
// Positions are fractions of the frame measured from the element's anchor (tl = from the top-left corner, br = from the
// bottom-right one, b = bottom centre …): x / y are the gap to the anchored edges, w / h the size. So "8 % from the left,
// 6 % above the bottom" stays right on any canvas size.
//
// Element TYPES are a table (HUD_TYPES below): each lists its props with a default, a range / options and a label —
// the validator, the studio's element editor and the guide all read it. A type's look on the page is one small file in
// src/scene/stage/hudElements/ (registerHudElement). Adding an element to a layout is data only.
//
// Everything is stored in the `hud` mode bag (SceneState.modes.hud, the generic per-mode JSON bag: ≤ 6 KB, depth ≤ 5,
// ≤ 32 keys / items per level, strings ≤ 200 — so elements stay flat). Pure (no DOM, no three.js): tools/layouts_unit.ts.
import type { Rect, StagePlan, TilePlan } from './stage.ts';
import { DEFAULT_LOOK, lookDiff, resolveLook, sanitizeLook, type LayoutLook } from './layoutLook.ts';

export const HUD_BAG = 'hud';
/** The Full screen stage mode (src/scene/stage/modes/fullscreen.ts) that shows the HUD layouts. */
export const HUD_MODE = 'fullscreen';

// ---------------------------------------------------------------- element types
export type HudAnchor = 'tl' | 't' | 'tr' | 'l' | 'c' | 'r' | 'bl' | 'b' | 'br';
export const HUD_ANCHORS: readonly HudAnchor[] = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];
export const ANCHOR_LABEL: Record<HudAnchor, string> = { tl: 'Top left', t: 'Top', tr: 'Top right', l: 'Left', c: 'Centre', r: 'Right', bl: 'Bottom left', b: 'Bottom', br: 'Bottom right' };

export type HudPropSpec =
  | { kind: 'num'; def: number; min: number; max: number; step?: number; label: string; unit?: string }
  | { kind: 'bool'; def: boolean; label: string }
  | { kind: 'enum'; def: string; options: readonly string[]; labels?: readonly string[]; label: string }
  | { kind: 'color'; def: string; label: string; auto?: string }
  | { kind: 'text'; def: string; max: number; label: string; path?: boolean };

export interface HudTypeSpec {
  label: string;
  icon: string;
  /** One line for the studio's "Add element" list. */
  hint: string;
  /** Default placement for a new element of this type. */
  anchor: HudAnchor; x: number; y: number; w: number; h: number;
  props: Record<string, HudPropSpec>;
}

const FONT: HudPropSpec = { kind: 'enum', def: 'sans', options: ['sans', 'rounded', 'serif', 'mono', 'heavy'], labels: ['Clean', 'Rounded', 'Serif', 'Mono', 'Heavy'], label: 'Font' };
const SIZE = (def: number): HudPropSpec => ({ kind: 'num', def, min: 0.4, max: 3, step: 0.05, label: 'Text size', unit: '×' });
const OUTLINE: HudPropSpec = { kind: 'num', def: 3, min: 0, max: 8, step: 0.5, label: 'Text outline', unit: 'px' };
const SHADOW: HudPropSpec = { kind: 'num', def: 0.7, min: 0, max: 1, step: 0.05, label: 'Text shadow' };

/** The chat box drawn as plain text (look `chat: 'text'` / the chat box's style 'text'): its options, kept once in the
 *  `hud` bag (bag.chatText) and used by every layout. Same option kinds as the element types. */
export const CHAT_TEXT_PROPS: Record<string, HudPropSpec> = {
  max: { kind: 'num', def: 8, min: 1, max: 20, step: 1, label: 'Lines' },
  fade: { kind: 'num', def: 30, min: 0, max: 600, step: 1, label: 'Fade after', unit: 's (0 = never)' },
  size: SIZE(1), font: FONT,
  color: { kind: 'color', def: '#ffffff', label: 'Text colour' },
  names: { kind: 'bool', def: true, label: 'Coloured names' },
  outline: OUTLINE, shadow: SHADOW,
  flow: { kind: 'enum', def: 'up', options: ['up', 'down'], labels: ['Newest at the bottom', 'Newest at the top'], label: 'Order' },
  align: { kind: 'enum', def: 'left', options: ['left', 'right'], labels: ['Left', 'Right'], label: 'Align' },
  scrim: { kind: 'num', def: 0, min: 0, max: 0.8, step: 0.05, label: 'Dark backing' },
  platform: { kind: 'bool', def: false, label: 'Platform dot' },
  support: { kind: 'bool', def: true, label: 'Support messages too' },
};
export type ChatTextOptions = Record<string, string | number | boolean>;
/** Chat text options: the defaults with the stored values on top (cleaned). */
export function chatTextOptions(raw: unknown): ChatTextOptions {
  const x = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const o: ChatTextOptions = {};
  for (const [k, p] of Object.entries(CHAT_TEXT_PROPS)) o[k] = cleanProp(p, x[k]);
  return o;
}

/** Every HUD element type. Keys are the `type` values; prop names must not clash with the base fields. */
export const HUD_TYPES: Record<string, HudTypeSpec> = {
  alerts: {
    label: 'Support alerts', icon: '🎉', hint: 'A big outlined line when someone tips, subs or raids, one at a time',
    anchor: 't', x: 0, y: 0.06, w: 0.6, h: 0.14,
    props: {
      duration: { kind: 'num', def: 7, min: 2, max: 30, step: 0.5, label: 'Show for', unit: 's' },
      size: SIZE(1.6), font: { ...FONT, def: 'heavy' } as HudPropSpec,
      color: { kind: 'color', def: '#ffffff', label: 'Text colour' },
      accent: { kind: 'color', def: '', label: 'Amount colour', auto: 'the event’s tier colour' },
      outline: { ...OUTLINE, def: 4 } as HudPropSpec, shadow: SHADOW,
      message: { kind: 'bool', def: true, label: 'Show their message' },
    },
  },
  goalBar: {
    label: 'Goal bar', icon: '🎯', hint: 'The chat goal (Chat & events → Goal) as a slim bar with the amount',
    anchor: 'b', x: 0, y: 0.03, w: 0.34, h: 0.05,
    props: {
      label: { kind: 'text', def: '', max: 40, label: 'Label (empty = the chat goal’s)' },
      color: { kind: 'color', def: '', label: 'Bar colour', auto: 'the room’s accent' },
      size: SIZE(1), font: FONT,
      amount: { kind: 'bool', def: true, label: 'Show the amount' },
      always: { kind: 'bool', def: false, label: 'Show while the chat goal is off' },
      goal: { kind: 'text', def: '', max: 48, label: 'Which goal (empty = the first shown; its name or 1, 2 …)' },
    },
  },
  // goals, stretch goals + the subathon timer (Goals & subathon: server/goals.ts; drawn by src/goals/goalsDraw.ts)
  goalLadder: {
    label: 'Stretch-goal ladder', icon: '🪜', hint: 'A goal and its stretch goals as a ladder: what is unlocked, what is next',
    anchor: 'r', x: 0.015, y: 0, w: 0.2, h: 0.36,
    props: {
      goal: { kind: 'text', def: '', max: 48, label: 'Which goal (empty = the first shown; its name or 1, 2 …)' },
      style: { kind: 'enum', def: 'auto', options: ['auto', 'neon', 'clean', 'bold'], labels: ['As in Goals & subathon', 'Neon', 'Clean', 'Bold'], label: 'Style' },
    },
  },
  subathonTimer: {
    label: 'Subathon timer', icon: '⏱️', hint: 'The subathon countdown: time pops, happy hour / hype badges, how to add time',
    anchor: 'tr', x: 0.015, y: 0.03, w: 0.25, h: 0.13,
    props: {
      style: { kind: 'enum', def: 'auto', options: ['auto', 'neon', 'clean', 'bold'], labels: ['As in Goals & subathon', 'Neon', 'Clean', 'Bold'], label: 'Style' },
      board: { kind: 'bool', def: false, label: 'Time added by (top 5) under it' },
    },
  },
  text: {
    label: 'Text label', icon: '🔤', hint: 'Any short text: a schedule, !commands, “now playing” …',
    anchor: 'tr', x: 0.015, y: 0.03, w: 0.3, h: 0.06,
    props: {
      text: { kind: 'text', def: 'Your text here', max: 120, label: 'Text' },
      size: SIZE(1.2), font: FONT,
      color: { kind: 'color', def: '#ffffff', label: 'Colour' },
      outline: OUTLINE, shadow: SHADOW,
      align: { kind: 'enum', def: 'left', options: ['left', 'center', 'right'], labels: ['Left', 'Centre', 'Right'], label: 'Align' },
      bold: { kind: 'bool', def: true, label: 'Bold' },
    },
  },
  logo: {
    label: 'Logo / image', icon: '🖼', hint: 'An image VTube Pro serves (e.g. a file in your room’s folder: /api/scenes/<room>/file/logo.png)',
    anchor: 'tr', x: 0.015, y: 0.02, w: 0.1, h: 0.1,
    props: {
      src: { kind: 'text', def: '', max: 200, label: 'Image path (/api/scenes/<room>/file/logo.png …)', path: true },
      fit: { kind: 'enum', def: 'contain', options: ['contain', 'cover'], labels: ['Fit inside', 'Fill'], label: 'Fit' },
      radius: { kind: 'num', def: 0, min: 0, max: 50, step: 1, label: 'Rounded corners', unit: '%' },
      shadow: { kind: 'num', def: 0.4, min: 0, max: 1, step: 0.05, label: 'Shadow' },
    },
  },
  productCard: {
    label: 'Product card', icon: '🛍', hint: 'Your featured merch (Support & store → Store), and “Sam just bought this!” when something sells',
    anchor: 'br', x: 0.015, y: 0.03, w: 0.17, h: 0.36,
    props: {
      showcase: { kind: 'bool', def: true, label: 'Show the featured product (off = only when someone buys)' },
      qr: { kind: 'bool', def: true, label: 'Scan-to-shop code' },
    },
  },
  webcamFrame: {
    label: 'Webcam frame', icon: '📷', hint: 'A frame with a see-through middle: put a real webcam source under it in OBS',
    anchor: 'br', x: 0.015, y: 0.03, w: 0.22, h: 0.22,
    props: {
      style: { kind: 'enum', def: 'bezel', options: ['thin', 'bezel', 'glow', 'neon'], labels: ['Thin', 'Bezel', 'Glow', 'Neon'], label: 'Style' },
      color: { kind: 'color', def: '', label: 'Colour', auto: 'the room’s accent' },
      width: { kind: 'num', def: 6, min: 1, max: 24, step: 1, label: 'Border', unit: 'px' },
      radius: { kind: 'num', def: 14, min: 0, max: 80, step: 1, label: 'Corner radius', unit: 'px' },
      label: { kind: 'text', def: '', max: 40, label: 'Name tag' },
    },
  },
};

// ---------------------------------------------------------------- element + layout data
export interface HudElement {
  id: string;
  type: string;
  on: boolean;
  anchor: HudAnchor;
  x: number; y: number; w: number; h: number;
  opacity: number;
  [prop: string]: string | number | boolean;
}

export type CamFraming = 'bust' | 'full';
export interface HudCams {
  /** The host's corner (guests line up beside them, towards the middle). */
  anchor: 'bl' | 'br' | 'tl' | 'tr';
  /** Gap to the anchored edges (fractions of the frame). */
  x: number; y: number;
  /** Cam height (fraction of the frame height); the width follows the framing. */
  h: number;
  framing: CamFraming;
  /** Guests' cams × the host's size. */
  guests: number;
}

/** A place in the frame from an anchor (like an element's). */
export interface HudPlace { anchor: HudAnchor; x: number; y: number; w: number; h: number }

export interface HudLayoutDef {
  id: string;
  label: string;
  sub?: string;
  /** 'full' = the capture fills the frame; 'fit' = the content aspect, centred (bars stay see-through). */
  capture: 'full' | 'fit';
  cams: HudCams;
  /** Where the chat box sits in this layout while it shows and the streamer left its place on Auto (absent = no chat
   *  box in this layout unless placed). */
  chat?: HudPlace;
  /** This layout's look defaults (the user's own settings go on top). */
  look?: Partial<LayoutLook>;
  hud: HudElement[];
}

export interface HudBag {
  /** Full screen mode: the layout shown (a built-in or custom id). */
  pick: string;
  /** Custom layouts, and edited copies of built-ins (same id = it replaces the built-in). */
  layouts: HudLayoutDef[];
  /** Per layout (stageLayout slotKey '<mode>.<preset>'): the user's look values. */
  looks: Record<string, Partial<LayoutLook>>;
  /** The chat-as-text options (CHAT_TEXT_PROPS), only the values that differ from the defaults. */
  chatText: ChatTextOptions;
}

const ID = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const MAX_ELEMENTS = 12;
export const MAX_LAYOUTS = 6;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const cleanText = (v: string, max: number) => v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').slice(0, max);
/** An image path the OBS page may load: this server only (party guests' pages never fetch an address the host typed). */
export const safeImagePath = (v: string) => /^\/(?!\/)[A-Za-z0-9_\-./%~]{1,199}$/.test(v) && !v.includes('..');

/** The default props of a type. */
export function typeDefaults(type: string): Record<string, string | number | boolean> {
  const t = HUD_TYPES[type];
  const o: Record<string, string | number | boolean> = {};
  if (t) for (const [k, p] of Object.entries(t.props)) o[k] = p.def;
  return o;
}

/** A new element of `type` with its default placement + props (id: `<type>`, `<type>-2` … not in `taken`). */
export function newElement(type: string, taken: string[] = []): HudElement | null {
  const t = HUD_TYPES[type];
  if (!t) return null;
  const base = type.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20) || 'el';
  let id = base, i = 2;
  while (taken.includes(id)) id = `${base}-${i++}`;
  return { id, type, on: true, anchor: t.anchor, x: t.x, y: t.y, w: t.w, h: t.h, opacity: 1, ...typeDefaults(type) };
}

/** One element, cleaned: known base fields + the type's props (unknown types keep only the base fields: drawn as
 *  nothing, flagged by validateHudLayout). Returns null when it can't be an element at all. */
export function sanitizeElement(raw: unknown): HudElement | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const x = raw as Record<string, unknown>;
  if (typeof x.id !== 'string' || !ID.test(x.id) || typeof x.type !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,23}$/.test(x.type)) return null;
  const t = HUD_TYPES[x.type];
  const num = (v: unknown, d: number, a: number, b: number) => (typeof v === 'number' && Number.isFinite(v) ? r4(clamp(v, a, b)) : d);
  const anchor = (HUD_ANCHORS as readonly string[]).includes(x.anchor as string) ? x.anchor as HudAnchor : t?.anchor ?? 'tl';
  const el: HudElement = {
    id: x.id, type: x.type, on: x.on !== false, anchor,
    x: num(x.x, t?.x ?? 0, -0.1, 1), y: num(x.y, t?.y ?? 0, -0.1, 1), w: num(x.w, t?.w ?? 0.2, 0.02, 1), h: num(x.h, t?.h ?? 0.1, 0.02, 1),
    opacity: num(x.opacity, 1, 0, 1),
  };
  if (t) for (const [k, p] of Object.entries(t.props)) el[k] = cleanProp(p, x[k]);
  return el;
}

function cleanProp(p: HudPropSpec, v: unknown): string | number | boolean {
  switch (p.kind) {
    case 'num': return typeof v === 'number' && Number.isFinite(v) ? r4(clamp(v, p.min, p.max)) : p.def;
    case 'bool': return typeof v === 'boolean' ? v : p.def;
    case 'enum': return typeof v === 'string' && p.options.includes(v) ? v : p.def;
    case 'color': return typeof v === 'string' && (/^#[0-9a-f]{6}$/i.test(v) || (v === '' && p.auto !== undefined)) ? v.toLowerCase() : p.def;
    case 'text': {
      if (typeof v !== 'string') return p.def;
      const s = cleanText(v, p.max);
      return p.path ? (s === '' || safeImagePath(s) ? s : p.def) : s;
    }
  }
}

const CORNERS = ['bl', 'br', 'tl', 'tr'] as const;
export function sanitizeCams(raw: unknown): HudCams {
  const x = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown, d: number, a: number, b: number) => (typeof v === 'number' && Number.isFinite(v) ? r4(clamp(v, a, b)) : d);
  return {
    anchor: (CORNERS as readonly string[]).includes(x.anchor as string) ? x.anchor as HudCams['anchor'] : 'bl',
    x: n(x.x, 0.012, 0, 0.5), y: n(x.y, 0, 0, 0.5), h: n(x.h, 0.42, 0.1, 1),
    framing: x.framing === 'full' ? 'full' : 'bust',
    guests: n(x.guests, 0.8, 0.4, 1),
  };
}

export function sanitizePlace(raw: unknown): HudPlace | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const x = raw as Record<string, unknown>;
  const n = (v: unknown, d: number, a: number, b: number) => (typeof v === 'number' && Number.isFinite(v) ? r4(clamp(v, a, b)) : d);
  return { anchor: (HUD_ANCHORS as readonly string[]).includes(x.anchor as string) ? x.anchor as HudAnchor : 'tl', x: n(x.x, 0.015, -0.1, 1), y: n(x.y, 0.04, -0.1, 1), w: n(x.w, 0.3, 0.05, 1), h: n(x.h, 0.44, 0.05, 1) };
}

export function sanitizeLayoutDef(raw: unknown): HudLayoutDef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const x = raw as Record<string, unknown>;
  if (typeof x.id !== 'string' || !ID.test(x.id)) return null;
  const label = typeof x.label === 'string' ? cleanText(x.label, 40).trim() : '';
  const els: HudElement[] = [];
  const seen = new Set<string>();
  for (const e of Array.isArray(x.hud) ? x.hud : []) {
    const el = sanitizeElement(e);
    if (!el || seen.has(el.id) || els.length >= MAX_ELEMENTS) continue;
    seen.add(el.id); els.push(el);
  }
  const look = x.look && typeof x.look === 'object' ? sanitizeLook(x.look) : undefined;
  return {
    id: x.id, label: label || x.id,
    ...(typeof x.sub === 'string' && x.sub.trim() ? { sub: cleanText(x.sub, 60).trim() } : {}),
    capture: x.capture === 'fit' ? 'fit' : 'full',
    cams: sanitizeCams(x.cams),
    ...((): { chat?: HudPlace } => { const c = sanitizePlace(x.chat); return c ? { chat: c } : {}; })(),
    ...(look && Object.keys(look).length ? { look } : {}),
    hud: els,
  };
}

export function sanitizeHudBag(raw: unknown): HudBag {
  const x = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const layouts: HudLayoutDef[] = [];
  for (const l of Array.isArray(x.layouts) ? x.layouts : []) {
    const d = sanitizeLayoutDef(l);
    if (d && !layouts.some((o) => o.id === d.id) && layouts.length < MAX_LAYOUTS) layouts.push(d);
  }
  const looks: Record<string, Partial<LayoutLook>> = {};
  const lr = (x.looks && typeof x.looks === 'object' && !Array.isArray(x.looks) ? x.looks : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(lr).slice(0, 24)) {
    if (!/^[a-z][a-z0-9-]{1,23}\.[a-z0-9-]{1,40}$/.test(k)) continue;
    const l = sanitizeLook(v);
    if (Object.keys(l).length) looks[k] = l;
  }
  const pick = typeof x.pick === 'string' && ID.test(x.pick) ? x.pick : BUILTIN_HUD_LAYOUTS[0].id;
  const ct = chatTextOptions(x.chatText), chatText: ChatTextOptions = {};
  for (const [k, v] of Object.entries(ct)) if (v !== CHAT_TEXT_PROPS[k].def) chatText[k] = v;
  return { pick, layouts, looks, chatText };
}

// ---------------------------------------------------------------- validation (studio import, AI-made layouts, tests)
export interface HudIssue { level: 'error' | 'warn'; where: string; msg: string }

/** Checks a layout as typed / pasted / made by an AI: what the sanitiser would drop or change, and what would look
 *  wrong on stream (off-screen, overlapping the performer, unknown types). Empty = clean. */
export function validateHudLayout(raw: unknown): HudIssue[] {
  const out: HudIssue[] = [];
  const err = (where: string, msg: string) => out.push({ level: 'error', where, msg });
  const warn = (where: string, msg: string) => out.push({ level: 'warn', where, msg });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { err('layout', 'not an object'); return out; }
  const x = raw as Record<string, unknown>;
  if (typeof x.id !== 'string' || !ID.test(x.id)) err('id', 'needs an id: lower-case letters, digits and -, up to 24 characters');
  if (typeof x.label !== 'string' || !x.label.trim()) warn('label', 'no label: the id is shown instead');
  if (x.capture !== undefined && x.capture !== 'full' && x.capture !== 'fit') err('capture', `capture must be "full" or "fit" (got ${JSON.stringify(x.capture)})`);
  if (!Array.isArray(x.hud)) { if (x.hud !== undefined) err('hud', 'hud must be a list of elements'); }
  if (x.chat !== undefined) {
    const c = sanitizePlace(x.chat);
    if (!c) err('chat', 'chat must be a place: { anchor, x, y, w, h }');
    else { const r = elementRect(c); if (r.x < -0.001 || r.y < -0.001 || r.x + r.w > 1.001 || r.y + r.h > 1.001) warn('chat', 'part of the chat box is off the frame'); }
  }
  const cams = sanitizeCams(x.cams);
  const def = sanitizeLayoutDef(raw);
  const ids = new Set<string>();
  (Array.isArray(x.hud) ? x.hud : []).forEach((e, i) => {
    const w = `hud[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) { err(w, 'not an object'); return; }
    const o = e as Record<string, unknown>;
    if (typeof o.id !== 'string' || !ID.test(o.id)) { err(w, 'needs an id: lower-case letters, digits and -, up to 24 characters'); return; }
    if (ids.has(o.id)) err(`${w} ${o.id}`, 'duplicate id (the second one is dropped)');
    ids.add(o.id);
    if (i >= MAX_ELEMENTS) err(`${w} ${o.id}`, `more than ${MAX_ELEMENTS} elements (dropped)`);
    const t = typeof o.type === 'string' ? HUD_TYPES[o.type] : undefined;
    if (o.type === 'chatText') { err(`${w} ${o.id}`, 'chat is not a HUD element: use the layout\'s "chat" place (+ look.chat "text")'); return; }
    if (!t) { err(`${w} ${o.id}`, `unknown type ${JSON.stringify(o.type)} — known: ${Object.keys(HUD_TYPES).join(', ')}`); return; }
    if (o.anchor !== undefined && !(HUD_ANCHORS as readonly string[]).includes(o.anchor as string)) err(`${w} ${o.id}`, `anchor must be one of ${HUD_ANCHORS.join(', ')}`);
    for (const k of ['x', 'y', 'w', 'h', 'opacity']) if (o[k] !== undefined && (typeof o[k] !== 'number' || !Number.isFinite(o[k]))) err(`${w} ${o.id}`, `${k} must be a number`);
    const BASE = new Set(['id', 'type', 'on', 'anchor', 'x', 'y', 'w', 'h', 'opacity']);
    for (const [k, v] of Object.entries(o)) {
      if (BASE.has(k)) continue;
      const p = t.props[k];
      if (!p) { warn(`${w} ${o.id}`, `unknown prop "${k}" for ${o.type} (ignored)`); continue; }
      if (cleanProp(p, v) !== (typeof v === 'string' && p.kind === 'color' ? v.toLowerCase() : v)) warn(`${w} ${o.id}`, `${k}: ${JSON.stringify(v)} is out of range / not allowed → ${JSON.stringify(cleanProp(p, v))}`);
    }
    const el = sanitizeElement(e);
    if (el) {
      const r = elementRect(el);
      if (r.x < -0.001 || r.y < -0.001 || r.x + r.w > 1.001 || r.y + r.h > 1.001) warn(`${w} ${o.id}`, 'part of it is off the frame');
      if (def) for (const c of camRects(cams, 16 / 9, 1)) if (overlap(r, c) > 0.25 * Math.min(r.w * r.h, c.w * c.h) && el.type !== 'webcamFrame') warn(`${w} ${o.id}`, 'it covers a big part of the host’s cam');
    }
  });
  return out;
}
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

// ---------------------------------------------------------------- geometry
/** An element's rect (fractions of the frame, top-left origin) from its anchor + offsets. */
export function elementRect(e: Pick<HudElement, 'anchor' | 'x' | 'y' | 'w' | 'h'>): Rect {
  const a = e.anchor;
  const x = a.endsWith('l') ? e.x : a.endsWith('r') ? 1 - e.x - e.w : 0.5 - e.w / 2 + e.x;
  const y = a.startsWith('t') ? e.y : a.startsWith('b') ? 1 - e.y - e.h : 0.5 - e.h / 2 + e.y;
  return { x: r4(x), y: r4(y), w: e.w, h: e.h };
}
/** The inverse: anchor offsets for a rect (after a drag / a corner preset). */
export function offsetsFor(anchor: HudAnchor, r: Rect): { x: number; y: number; w: number; h: number } {
  const x = anchor.endsWith('l') ? r.x : anchor.endsWith('r') ? 1 - r.x - r.w : r.x + r.w / 2 - 0.5;
  const y = anchor.startsWith('t') ? r.y : anchor.startsWith('b') ? 1 - r.y - r.h : r.y + r.h / 2 - 0.5;
  return { x: r4(x), y: r4(y), w: r4(r.w), h: r4(r.h) };
}

/** A rect moved off the performers' cams: as it is when it covers less than 8 % of a cam, else mirrored left ↔ right,
 *  then top ↔ bottom, then both — the first that is clear (else the one covering the least). */
export function avoidCams(r: Rect, cams: Rect[]): Rect {
  const hit = (x: Rect) => cams.reduce((m, c) => Math.max(m, overlap(x, c) / Math.max(1e-6, c.w * c.h)), 0);
  const cands = [r, { ...r, x: 1 - r.x - r.w }, { ...r, y: 1 - r.y - r.h }, { ...r, x: 1 - r.x - r.w, y: 1 - r.y - r.h }];
  let best = r, bh = Infinity;
  for (const c of cands) { const h = hit(c); if (h < 0.08) return { x: r4(c.x), y: r4(c.y), w: c.w, h: c.h }; if (h < bh) { bh = h; best = c; } }
  return best;
}

/** Cam w / h per framing (the stage plans' corner-cam shapes). */
export const CAM_RATIO: Record<CamFraming, number> = { bust: 0.84, full: 0.62 };

/** The performers' cams: the host at the anchor corner, guests beside them (towards the middle), smaller. */
export function camRects(c: HudCams, aspect: number, n: number): Rect[] {
  const out: Rect[] = [];
  const left = c.anchor[1] === 'l', top = c.anchor[0] === 't';
  const gap = 12 / 1080 / aspect;
  let x = left ? c.x : 1 - c.x;
  for (let i = 0; i < n; i++) {
    const h = c.h * (i === 0 ? 1 : c.guests);
    const w = (h * CAM_RATIO[c.framing]) / aspect;
    const rx = left ? x : x - w;
    out.push({ x: r4(rx), y: r4(top ? c.y : 1 - c.y - h), w: r4(w), h: r4(h) });
    x = left ? x + w + gap : x - w - gap;
  }
  return out;
}

export type HudPlaced = NonNullable<StagePlan['hud']>[number];

/** The StagePlan of a HUD layout (the compositor draws it like any composite plan; `hud` = the elements to draw). */
/** `chat`: the chat box shows now (its dock rule + chat in use): it gets the layout's chat place. */
export function planHud(def: HudLayoutDef, inp: { aspect: number; keys: string[]; content?: number; look: LayoutLook; chat?: boolean }): StagePlan & { hud: HudPlaced[] } {
  const a = inp.content ?? 16 / 9;
  let capture: Rect = { x: 0, y: 0, w: 1, h: 1 };
  if (def.capture === 'fit') {
    const fa = inp.aspect;
    capture = fa > a ? { x: (1 - a / fa) / 2, y: 0, w: a / fa, h: 1 } : { x: 0, y: (1 - fa / a) / 2, w: 1, h: fa / a };
  }
  const backdrop = inp.look.avatar === 'auto' ? 'cutout' : inp.look.avatar;
  const rects = camRects(def.cams, inp.aspect, inp.keys.length);
  const tiles: TilePlan[] = inp.keys.map((key, i) => ({ key, rect: rects[i], framing: def.cams.framing, backdrop, tag: 'inside', ...(key === '@host' ? { hero: true } : {}) }));
  // out of the way by itself: a chat box / element that would sit on a performer moves to the mirrored place
  const camsR = tiles.map((t) => t.rect);
  const clear = (r: Rect) => avoidCams(r, camsR);
  const hud: HudPlaced[] = def.hud.filter((e) => e.on && HUD_TYPES[e.type]).map((e) => {
    const props: Record<string, string | number | boolean> = {};
    for (const k of Object.keys(HUD_TYPES[e.type].props)) props[k] = e[k];
    return { id: e.id, type: e.type, rect: e.type === 'webcamFrame' ? elementRect(e) : clear(elementRect(e)), opacity: e.opacity, props };
  });
  const hk = hud.map((e) => e.id).join(',');
  return {
    key: `hud:${def.id}:${inp.keys.length}:${inp.aspect.toFixed(3)}:${a.toFixed(3)}:${def.capture}:${def.cams.anchor}:${def.cams.h}:${def.cams.framing}:${hk}:${inp.chat && def.chat ? 1 : 0}`,
    view: 'composite', label: def.label, capture, tiles, docks: { chat: inp.chat && def.chat ? clear(elementRect(def.chat)) : null, support: null }, hud,
  };
}

// ---------------------------------------------------------------- built-in layouts
export const BUILTIN_HUD_LAYOUTS: HudLayoutDef[] = [
  {
    id: 'full-cutout', label: 'Full screen + cut-out', sub: 'game fills the screen, you bottom-left',
    capture: 'full', cams: { anchor: 'bl', x: 0.012, y: 0, h: 0.46, framing: 'bust', guests: 0.8 },
    look: { avatar: 'cutout', screenRadius: 0, tags: 0, shadow: 0.45, frame: 'none' },
    hud: [],
  },
  {
    id: 'full-cutout-chat', label: 'Full screen + cut-out + text chat', sub: 'plus chat as plain text on the screen',
    capture: 'full', cams: { anchor: 'bl', x: 0.012, y: 0, h: 0.46, framing: 'bust', guests: 0.8 },
    chat: { anchor: 'tl', x: 0.015, y: 0.04, w: 0.3, h: 0.44 },
    look: { avatar: 'cutout', screenRadius: 0, tags: 0, shadow: 0.45, frame: 'none', chat: 'text' },
    hud: [],
  },
];

/** Every layout the Full screen mode offers: built-ins (or the user's edited copy) then custom ones. */
export function hudLayouts(bag: HudBag): HudLayoutDef[] {
  const out = BUILTIN_HUD_LAYOUTS.map((b) => bag.layouts.find((l) => l.id === b.id) ?? b);
  for (const l of bag.layouts) if (!out.some((o) => o.id === l.id)) out.push(l);
  return out;
}
export const isBuiltinHud = (id: string) => BUILTIN_HUD_LAYOUTS.some((b) => b.id === id);
export function hudLayout(bag: HudBag, id = bag.pick): HudLayoutDef {
  const all = hudLayouts(bag);
  return all.find((l) => l.id === id) ?? all[0];
}

/** Zero-effort defaults: the look a layout gets with no edits (owner: "look good with zero edits"). The cams that stand
 *  ON the game / window (React Full, Gaming corner cam) are cut-outs with a soft shadow — unless the streamer picked
 *  something else for Gaming ("Behind the cams"); HUD layouts bring their own (def.look). */
export function layoutBaseLook(bag: HudBag, mode: string, label: string, stageBackdrop?: string): Partial<LayoutLook> | undefined {
  if (mode === HUD_MODE) return hudLayout(bag).look;
  if (mode === 'react' && label === 'Full') return { avatar: 'cutout', shadow: 0.45 };
  if (mode === 'gaming' && label === 'Corner cam' && (stageBackdrop ?? 'room') === 'room') return { avatar: 'cutout', shadow: 0.45 };
  return undefined;
}

/** The look in effect for a layout: defaults ← the layout's own defaults ← the user's (bag.looks[slot]). */
export function lookFor(bag: HudBag, slot: string, layoutDefaults?: Partial<LayoutLook>): LayoutLook {
  return resolveLook(layoutDefaults, bag.looks[slot]);
}
/** Store a look for a layout (only what differs from its defaults; an empty diff removes the entry). */
export function withLook(bag: HudBag, slot: string, look: Partial<LayoutLook>, layoutDefaults?: Partial<LayoutLook>): HudBag {
  const base = resolveLook(layoutDefaults);
  const d = lookDiff(look, base);
  const looks = { ...bag.looks };
  if (Object.keys(d).length) looks[slot] = d; else delete looks[slot];
  return { ...bag, looks };
}
/** Store a layout (custom or an edited built-in). */
export function withLayout(bag: HudBag, def: HudLayoutDef): HudBag {
  const d = sanitizeLayoutDef(def);
  if (!d) return bag;
  const layouts = bag.layouts.filter((l) => l.id !== d.id);
  layouts.push(d);
  return { ...bag, layouts: layouts.slice(-MAX_LAYOUTS) };
}
/** JSON size of a bag as stored (the generic mode-bag limit is 6000 bytes). */
export const hudBagBytes = (bag: HudBag) => JSON.stringify(bag).length;
export const HUD_BAG_LIMIT = 6000;
export { DEFAULT_LOOK };
