// Layout appearance ("look") for the screen-first stage layouts (docs/LAYOUTS.md): React Full / Medium, every Gaming
// layout and the Full screen HUD layouts (shared/hud.ts). The capture (game / window) is the main view there and the
// performers are cams in a box or a corner; the look decides how those cams and the frame around them are drawn:
//
//   avatar      'auto' (the layout's own choice) · 'room' (a box with the room behind) · 'clean' (a studio box) ·
//               'cutout' (just the character, nothing behind it — it stands on the capture)
//   frame       bezel style of boxed cams and the capture window: none · thin · bezel · glow
//   radius / screenRadius   corner radius of the cams / the capture window (px at 1080p)
//   camOpacity · tags · panels · backdrop     opacity of the cams, their name tags, the docked panels, the backdrop
//   dim · blur  the backdrop around the capture: darker / softer (blur flattens its pattern + light sweep)
//   screenDim   a dark veil over the capture (OBS shows it through the page: the game gets darker)
//   shadow · outline · outlineColor   a soft drop shadow / a solid outline around a cut-out character
//   scale · anchor   the cams' size (×) and which corner of the capture they sit in (auto = the layout's)
//   chat        the chat box in this layout: 'auto' (the chat box's own style) · 'panel' · 'text' (plain outlined text)
//   safe        this layout's safe margin (fractions of the frame; absent = the layout editor's global margin)
//
// Stored per layout (shared/stageLayout.ts slotKey: '<mode>.<preset>') in the `hud` mode bag (shared/hud.ts), only the
// values that differ from the layout's defaults. Pure data + maths (no DOM, no three.js): tools/layouts_unit.ts.
import type { CamBackdrop, Rect, StagePlan, TilePlan } from './stage.ts';

export type AvatarStyle = 'auto' | CamBackdrop;
export type FrameStyle = 'none' | 'thin' | 'bezel' | 'glow';
export type LookAnchor = 'auto' | 'bl' | 'br' | 'tl' | 'tr';
export type ChatStyle = 'auto' | 'panel' | 'text';

export interface LayoutLook {
  avatar: AvatarStyle;
  frame: FrameStyle;
  radius: number;
  screenRadius: number;
  camOpacity: number;
  tags: number;
  backdrop: number;
  dim: number;
  blur: number;
  screenDim: number;
  panels: number;
  shadow: number;
  outline: number;
  outlineColor: string;
  scale: number;
  anchor: LookAnchor;
  chat: ChatStyle;
  safe?: number;
}

/** Today's look of every existing layout (nothing changes until the user moves a control). */
export const DEFAULT_LOOK: LayoutLook = {
  avatar: 'auto', frame: 'bezel', radius: 16, screenRadius: 10, camOpacity: 1, tags: 1, backdrop: 1, dim: 0, blur: 0, screenDim: 0,
  panels: 1, shadow: 0, outline: 0, outlineColor: '#ffffff', scale: 1, anchor: 'auto', chat: 'auto',
};

export const AVATAR_STYLES = ['auto', 'room', 'clean', 'cutout'] as const;
export const FRAME_STYLES = ['none', 'thin', 'bezel', 'glow'] as const;
export const LOOK_ANCHORS = ['auto', 'bl', 'br', 'tl', 'tr'] as const;
export const CHAT_STYLES = ['auto', 'panel', 'text'] as const;

/** [min, max] of every numeric field (the sanitiser clamps into these; the panel's sliders use them). */
export const LOOK_RANGES: Record<'radius' | 'screenRadius' | 'camOpacity' | 'tags' | 'backdrop' | 'dim' | 'blur' | 'screenDim' | 'panels' | 'shadow' | 'outline' | 'scale' | 'safe', [number, number]> = {
  radius: [0, 60], screenRadius: [0, 60], camOpacity: [0.1, 1], tags: [0, 1], backdrop: [0, 1], dim: [0, 0.9], blur: [0, 1], screenDim: [0, 0.8],
  panels: [0.2, 1], shadow: [0, 1], outline: [0, 16], scale: [0.5, 1.8], safe: [0, 0.08],
};

const HEX = /^#[0-9a-f]{6}$/i;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const clampTo = (k: keyof typeof LOOK_RANGES, v: number) => round3(Math.min(LOOK_RANGES[k][1], Math.max(LOOK_RANGES[k][0], v)));
const pick = <T extends string>(v: unknown, all: readonly T[]): T | undefined => (typeof v === 'string' && (all as readonly string[]).includes(v) ? v as T : undefined);

/** Only the known, valid fields of a stored look (junk dropped, numbers clamped). */
export function sanitizeLook(raw: unknown): Partial<LayoutLook> {
  const x = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const out: Partial<LayoutLook> = {};
  const av = pick(x.avatar, AVATAR_STYLES); if (av) out.avatar = av;
  const fr = pick(x.frame, FRAME_STYLES); if (fr) out.frame = fr;
  const an = pick(x.anchor, LOOK_ANCHORS); if (an) out.anchor = an;
  const ch = pick(x.chat, CHAT_STYLES); if (ch) out.chat = ch;
  for (const k of Object.keys(LOOK_RANGES) as (keyof typeof LOOK_RANGES)[]) {
    const v = x[k];
    if (typeof v === 'number' && Number.isFinite(v)) (out as Record<string, number>)[k] = clampTo(k, v);
  }
  if (typeof x.outlineColor === 'string' && HEX.test(x.outlineColor)) out.outlineColor = x.outlineColor.toLowerCase();
  return out;
}

/** The full look: defaults ← the layout's own defaults ← the user's stored values. */
export function resolveLook(...layers: (Partial<LayoutLook> | null | undefined)[]): LayoutLook {
  const out: LayoutLook = { ...DEFAULT_LOOK };
  for (const l of layers) if (l) Object.assign(out, sanitizeLook(l));
  return out;
}

/** The stored form: only what differs from `base` (keeps the bag small). */
export function lookDiff(look: Partial<LayoutLook>, base: LayoutLook = DEFAULT_LOOK): Partial<LayoutLook> {
  const s = sanitizeLook(look);
  const out: Partial<LayoutLook> = {};
  for (const [k, v] of Object.entries(s) as [keyof LayoutLook, unknown][]) if (v !== base[k]) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Does any cam of the plan stand as a cut-out? */
export const hasCutout = (plan: StagePlan) => plan.tiles.some((t) => t.backdrop === 'cutout');

/** Do the cams stand ON the capture (React Full, Gaming corner cam, the HUD layouts)? Only then can they be resized /
 *  moved to another corner; strips, columns and React Medium keep their own band beside the capture (the layout
 *  editor moves those one by one). */
export function camsOnCapture(plan: StagePlan): boolean {
  if (plan.view !== 'composite' || !plan.tiles.length) return false;
  const c = plan.capture ?? { x: 0, y: 0, w: 1, h: 1 };
  return plan.tiles.some((t) => overlap(t.rect, c) >= 0.2 * t.rect.w * t.rect.h);
}
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** Bounds of a list of rects. */
function bounds(rs: Rect[]): Rect {
  const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

type Corner4 = Exclude<LookAnchor, 'auto'>;

/** The look's geometry + cam style applied to a composite plan (3d plans are returned as they are):
 *  - every cam gets the avatar style (auto = the plan's own backdrop) and loses its name tag when tags are off;
 *  - when the cams stand on the capture (camsOnCapture): they are grouped by the corner they sit in (React Full: the
 *    host bottom-left, guests bottom-right) and each group is scaled about that corner (it never overlaps another
 *    group or leaves the capture area); a chosen corner moves a single group there with the layout's inset.
 *  Custom rects from the layout editor are applied after this (they stay exact). */
export function applyLookPlan(plan: StagePlan, look: LayoutLook): StagePlan {
  if (plan.view !== 'composite') return plan;
  const style = look.avatar;
  let tiles: TilePlan[] = plan.tiles.map((t) => ({ ...t, ...(style !== 'auto' ? { backdrop: style } : {}), ...(look.tags <= 0.01 ? { tag: 'none' as const } : {}) }));
  if (tiles.length && (Math.abs(look.scale - 1) > 0.001 || look.anchor !== 'auto') && camsOnCapture(plan)) {
    // the area the cams live in: the capture, stretched to wherever the cams already reach (Full's cams stand below it)
    const all = bounds([plan.capture ?? { x: 0, y: 0, w: 1, h: 1 }, ...tiles.map((t) => t.rect)]);
    const cornerOf = (r: Rect): Corner4 => `${r.y + r.h / 2 > all.y + all.h / 2 ? 'b' : 't'}${r.x + r.w / 2 < all.x + all.w / 2 ? 'l' : 'r'}` as Corner4;
    const groups = new Map<Corner4, number[]>();
    tiles.forEach((t, i) => { const c = cornerOf(t.rect); groups.set(c, [...(groups.get(c) ?? []), i]); });
    const move = look.anchor !== 'auto' && groups.size === 1;
    // each group may grow until it would meet another group / the far edges (at most 92 % of the area each way)
    for (const [c, idx] of groups) {
      const b = bounds(idx.map((i) => tiles[i].rect));
      const a: Corner4 = move ? look.anchor as Corner4 : c;
      const top = a[0] === 't', left = a[1] === 'l';
      // inset from the corner: the group's own (moving corners: the smaller of its two insets, per axis)
      const ix = c[1] === 'l' ? b.x - all.x : all.x + all.w - b.x - b.w, iy = c[0] === 't' ? b.y - all.y : all.y + all.h - b.y - b.h;
      let room = Math.min(all.w * 0.92 / b.w, all.h * 0.92 / b.h);
      for (const [c2, idx2] of groups) {
        if (c2 === c) continue;
        const o = bounds(idx2.map((i) => tiles[i].rect));
        // another group on the same row / column limits the growth towards it
        if (o.y < b.y + b.h && b.y < o.y + o.h) room = Math.min(room, (left ? o.x - all.x - ix : all.x + all.w - ix - (o.x + o.w)) / b.w * 0.97);
        if (o.x < b.x + b.w && b.x < o.x + o.w) room = Math.min(room, (top ? o.y - all.y - iy : all.y + all.h - iy - (o.y + o.h)) / b.h * 0.97);
      }
      const k = Math.max(0.3, Math.min(look.scale, room));
      const nw = b.w * k, nh = b.h * k;
      const nx = left ? all.x + ix : all.x + all.w - ix - nw;
      const ny = top ? all.y + iy : all.y + all.h - iy - nh;
      for (const i of idx) { const t = tiles[i]; tiles[i] = { ...t, rect: { x: round4(nx + (t.rect.x - b.x) * k), y: round4(ny + (t.rect.y - b.y) * k), w: round4(t.rect.w * k), h: round4(t.rect.h * k) } }; }
    }
  }
  const sig = `${style}:${look.scale.toFixed(3)}:${look.anchor}:${look.tags <= 0.01 ? 0 : 1}`;
  return { ...plan, key: `${plan.key}|K${sig}`, tiles };
}
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Frame-shader numbers for a look (device-independent: px at 1080p). */
export function frameParams(look: LayoutLook): { bezel: number; glow: number; capRing: number; tileShadow: number } {
  switch (look.frame) {
    case 'none': return { bezel: 0, glow: 0, capRing: 0, tileShadow: 0 };
    case 'thin': return { bezel: 2, glow: 0, capRing: 0.6, tileShadow: 0.6 };
    case 'glow': return { bezel: -1, glow: 0.55, capRing: 1, tileShadow: 1 };
    default: return { bezel: -1, glow: 0, capRing: 1, tileShadow: 1 };
  }
}
