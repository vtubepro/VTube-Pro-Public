// HUD element registry + helpers (docs/LAYOUTS.md). Element modules (./hudElements/*.ts) import registerHudElement from
// HERE; the layer that draws them is ./hud.ts (which also loads every element module).
import type { ChatFeed } from '../../chat/feed.ts';
import type { SceneChatState } from '../../../shared/chat.ts';
import type { StagePalette, StagePlan } from '../../../shared/stage.ts';

export type HudPlaced = NonNullable<StagePlan['hud']>[number];

/** What every element gets each frame. */
export interface HudFrame {
  /** Frame size in CSS px (the OBS canvas). */
  frameW: number; frameH: number;
  now: number; dt: number;
  palette: StagePalette;
  chat: SceneChatState;
}

/** What an element gets once, when it is created. */
export interface HudEnv {
  feed: ChatFeed;
  chat: () => SceneChatState;
}

export interface HudView {
  /** The element's box (positioned by the layer; draw inside it). */
  readonly el: HTMLElement;
  update(e: HudPlaced, f: HudFrame): void;
  dispose(): void;
}

export interface HudElementDef {
  type: string;
  mount(env: HudEnv): HudView;
}

const defs = new Map<string, HudElementDef>();
/** Add (or replace — HMR) a HUD element type's renderer. */
export function registerHudElement(def: HudElementDef) { defs.set(def.type, def); }
export const hudElementTypes = () => [...defs.keys()];
export const hudElementDef = (type: string): HudElementDef | null => defs.get(type) ?? null;

// ---------------------------------------------------------------- shared helpers for element modules
/** System font stacks only: an OBS page must never wait on (or fail) a web font. */
export const HUD_FONTS: Record<string, string> = {
  sans: '"Segoe UI", Inter, system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif',
  rounded: '"Nunito", "Varela Round", "Segoe UI Rounded", "Arial Rounded MT Bold", "Segoe UI", system-ui, sans-serif',
  serif: 'Georgia, Cambria, "Times New Roman", serif',
  mono: 'Consolas, "Cascadia Mono", "SF Mono", ui-monospace, Menlo, monospace',
  heavy: 'Impact, "Arial Black", "Segoe UI Black", Haettenschweiler, system-ui, sans-serif',
};

/** Readable-anywhere text: a solid outline made of text shadows (works in every OBS browser version, unlike
 *  paint-order) + a soft drop shadow. `outline` in px at 1080p, `shadow` 0..1; `k` = frame height / 1080. */
export function textShadow(outline: number, shadow: number, k: number, color = '#000'): string {
  const out: string[] = [];
  const r = outline * k;
  if (r > 0.05) {
    const n = r < 1.6 ? 8 : 16;
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; out.push(`${(Math.cos(a) * r).toFixed(2)}px ${(Math.sin(a) * r).toFixed(2)}px 0 ${color}`); }
    if (r > 2) for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2 + 0.39; out.push(`${(Math.cos(a) * r * 0.55).toFixed(2)}px ${(Math.sin(a) * r * 0.55).toFixed(2)}px 0 ${color}`); }
  }
  if (shadow > 0.01) out.push(`0 ${(2.5 * k).toFixed(2)}px ${(7 * k).toFixed(2)}px rgba(0,0,0,${(shadow * 0.85).toFixed(2)})`);
  return out.join(', ') || 'none';
}

/** A name colour that reads on any game: very dark platform colours are lifted. */
export function readableColor(hex: string | undefined, fallback = '#9fd8ff'): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum < 110) { const k = (110 - lum) / 255; r = Math.round(r + (255 - r) * k * 1.4); g = Math.round(g + (255 - g) * k * 1.4); b = Math.round(b + (255 - b) * k * 1.4); }
  return `rgb(${Math.min(255, r)},${Math.min(255, g)},${Math.min(255, b)})`;
}

const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d = false) => (typeof v === 'boolean' ? v : d);
export const prop = { str, num, bool };

