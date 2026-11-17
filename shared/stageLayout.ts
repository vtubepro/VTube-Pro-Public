// Custom stage layouts (Show area → Layout editor): per-element manual placement on top of the automatic stage plans
// (shared/stage.ts). "Auto" stays the default; a room + mode + preset can switch to "Custom", which stores the rects
// the host dragged / typed for the capture window, each cam (by slot: cam0 = the host / first performer), the docked
// chat and the support ticker. Stored in the generic mode bag SceneState.modes.layout (shared/stage.ts
// sanitizeModeBags — no server change), so every OBS page (host's and guests') applies the same overrides.
//
//   bag = { safe?: number (0..0.08 safe margin, every composite plan), rooms: { <roomKey>: { <slot>: Slot } } }
//   Slot = { on: boolean, capture?: R, chat?: R, support?: R, cam0?: R, cam1?: R …, 'hud-<id>'?: R }   R = [x, y, w, h] fractions
//
// Pure data + maths (no DOM, no three.js).
import type { Rect, StagePlan } from './stage.ts';

export const LAYOUT_BAG = 'layout';
export type LayoutElem = 'capture' | 'chat' | 'support' | `cam${number}` | `hud-${string}`;
export type R4 = [number, number, number, number];
export interface LayoutSlot { on: boolean; [elem: string]: R4 | boolean | undefined }
export interface LayoutBag { safe?: number; rooms: Record<string, Record<string, LayoutSlot>> }

const MAX_CAMS = 12;
const ELEM = /^(capture|chat|support|cam([0-9]|1[01])|hud-[a-z0-9][a-z0-9-]{0,23})$/;   // hud-<id>: a HUD element (shared/hud.ts)
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const r4 = (v: unknown): R4 | undefined => {
  if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  const w = clamp(v[2], 0.02, 1), h = clamp(v[3], 0.02, 1);
  return [round(clamp(v[0], -0.02, 1.02 - w)), round(clamp(v[1], -0.02, 1.02 - h)), round(w), round(h)];
};
const round = (n: number) => Math.round(n * 10000) / 10000;

/** Bag keys: letters, digits, _ @ : . - (≤ 48): room ids may carry `~area` → '.'. */
export const roomKey = (roomId: string | null | undefined) => (roomId || '_none').replace(/~/g, '.').replace(/[^A-Za-z0-9_@:.-]/g, '_').slice(0, 48);
/** A slot per mode + resolved preset (the plan label: "Corner cam", "Full", "Talk" …). */
export const slotKey = (mode: string, label: string) => `${mode}.${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x'}`.slice(0, 48);

export function sanitizeLayoutBag(raw: unknown): LayoutBag {
  const x = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: LayoutBag = { rooms: {} };
  if (typeof x.safe === 'number' && Number.isFinite(x.safe) && x.safe > 0.0005) out.safe = round(clamp(x.safe, 0, 0.08));
  const rooms = (x.rooms && typeof x.rooms === 'object' ? x.rooms : {}) as Record<string, unknown>;
  for (const [rk, rv] of Object.entries(rooms).slice(0, 30)) {
    if (!rv || typeof rv !== 'object') continue;
    const slots: Record<string, LayoutSlot> = {};
    for (const [sk, sv] of Object.entries(rv as Record<string, unknown>).slice(0, 30)) {
      if (!sv || typeof sv !== 'object') continue;
      const s = sv as Record<string, unknown>;
      const slot: LayoutSlot = { on: s.on === true };
      let n = 0;
      for (const [ek, ev] of Object.entries(s)) { if (!ELEM.test(ek)) continue; const r = r4(ev); if (r) { slot[ek] = r; n++; } }
      if (n || slot.on) slots[sk] = slot;
    }
    if (Object.keys(slots).length) out.rooms[rk] = slots;
  }
  return out;
}

export const toRect = (r: R4): Rect => ({ x: r[0], y: r[1], w: r[2], h: r[3] });
export const toR4 = (r: Rect): R4 => [round(r.x), round(r.y), round(r.w), round(r.h)];

/** The active custom slot for this room / mode / plan (null = Auto). */
export function activeSlot(bag: LayoutBag, roomId: string | null | undefined, mode: string, label: string): LayoutSlot | null {
  const s = bag.rooms[roomKey(roomId)]?.[slotKey(mode, label)];
  return s && s.on ? s : null;
}

/** Fit a rect inside the safe area (margin m on every side): the whole frame is scaled into the inset. */
const safeMap = (r: Rect, m: number): Rect => (m > 0 ? { x: m + r.x * (1 - 2 * m), y: m + r.y * (1 - 2 * m), w: r.w * (1 - 2 * m), h: r.h * (1 - 2 * m) } : r);
export const inSafe = safeMap;

/** A plan with the custom slot + safe margin applied (composite plans: capture, cams by order, docks; 3d plans are
 *  handled by the compositor per element, see overrideRect). Custom rects are exact (never moved by the safe margin). */
export function applyLayout(plan: StagePlan, bag: LayoutBag, slot: LayoutSlot | null): StagePlan {
  const m = bag.safe ?? 0;
  if (plan.view !== 'composite') return plan;
  if (!slot && !m) return plan;
  const pick = (k: string, r: Rect | null): Rect | null => {
    const o = slot?.[k];
    if (Array.isArray(o)) return toRect(o);
    return r ? safeMap(r, m) : r;
  };
  const tiles = plan.tiles.map((t, i) => ({ ...t, rect: i < MAX_CAMS ? pick(`cam${i}`, t.rect)! : safeMap(t.rect, m) }));
  const dock = (k: 'chat' | 'support') => { const d = plan.docks[k]; return d === 'auto' || d === null ? d : pick(k, d); };
  const sig = slot ? JSON.stringify(slot).length.toString(36) + ':' + hash(JSON.stringify(slot)) : '';
  const hud = plan.hud?.map((e) => ({ ...e, rect: pick(`hud-${e.id}`, e.rect)! }));
  return { ...plan, key: `${plan.key}|L${m}${sig}`, capture: pick('capture', plan.capture), tiles, docks: { chat: dock('chat'), support: dock('support') }, ...(hud ? { hud } : {}) };
}

/** 3d plans: a custom rect for one element (rail cam i, a docked panel) — or null to keep the automatic one. */
export function overrideRect(slot: LayoutSlot | null, elem: LayoutElem): Rect | null {
  const o = slot?.[elem];
  return Array.isArray(o) ? toRect(o) : null;
}

function hash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

/** Snap a rect's edges to guides (frame edges, centre lines, safe margin, other elements' edges) within `tol`. */
export function snapRect(r: Rect, others: Rect[], tol: number, safe = 0, mode: 'move' | 'resize' = 'move'): { rect: Rect; gx: number[]; gy: number[] } {
  const xs = [0, 0.5, 1, safe, 1 - safe], ys = [0, 0.5, 1, safe, 1 - safe];
  for (const o of others) { xs.push(o.x, o.x + o.w, o.x + o.w / 2); ys.push(o.y, o.y + o.h, o.y + o.h / 2); }
  const best = (cands: number[], vals: number[]) => {
    let d = tol + 1, off = 0, at = NaN;
    for (const v of vals) for (const c of cands) { const e = c - v; if (Math.abs(e) < Math.abs(d)) { d = e; off = e; at = c; } }
    return Math.abs(d) <= tol ? { off, at } : null;
  };
  const out = { ...r }; const gx: number[] = [], gy: number[] = [];
  if (mode === 'move') {
    const bx = best(xs, [r.x, r.x + r.w, r.x + r.w / 2]); if (bx) { out.x += bx.off; gx.push(bx.at); }
    const by = best(ys, [r.y, r.y + r.h, r.y + r.h / 2]); if (by) { out.y += by.off; gy.push(by.at); }
  } else {
    const bx = best(xs, [r.x + r.w]); if (bx) { out.w += bx.off; gx.push(bx.at); }
    const by = best(ys, [r.y + r.h]); if (by) { out.h += by.off; gy.push(by.at); }
  }
  return { rect: out, gx, gy };
}
