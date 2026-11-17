// Tiny SVG drawings of stage layouts for the Scene tab: preset thumbnails and the live layout preview. Composite plans
// are drawn exactly (the same shared/stage.ts maths the OBS pages use); the 3D presets (Big / Side) as a schematic of
// the room shot.
import type { Rect, StagePlan } from '../../../shared/stage.ts';

const NS = 'http://www.w3.org/2000/svg';
type Attrs = Record<string, string | number>;
function el(tag: string, a: Attrs, parent?: Element, text?: string) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(a)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  parent?.append(e);
  return e;
}
const initials = (n: string) => n.replace(/\(.*?\)/g, '').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';

export interface SvgOpts {
  width: number;
  aspect: number;
  /** member key → display name (tags / initials). */
  name?: (key: string) => string;
  /** 'thumb' = small, no text but initials; 'live' = labels. */
  size?: 'thumb' | 'live';
  captureLabel?: string;
}

/** A composite plan (or a 3d schematic: pass `schematic`) as an SVG. */
export function layoutSvg(plan: StagePlan | null, o: SvgOpts, schematic?: { kind: 'big' | 'side' | 'talk'; keys: string[] }): SVGSVGElement {
  const W = 320, H = W / o.aspect;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: o.width, height: Math.round(o.width / o.aspect), class: 'stg-svg' }) as SVGSVGElement;
  const defs = el('defs', {}, svg);
  const pat = el('pattern', { id: `chk${Math.random().toString(36).slice(2, 7)}`, width: 8, height: 8, patternUnits: 'userSpaceOnUse' }, defs);
  el('rect', { width: 8, height: 8, fill: '#2d3342' }, pat); el('rect', { width: 4, height: 4, fill: '#394153' }, pat); el('rect', { x: 4, y: 4, width: 4, height: 4, fill: '#394153' }, pat);
  const chk = `url(#${pat.getAttribute('id')})`;
  const R = (r: Rect) => ({ x: r.x * W, y: r.y * H, width: r.w * W, height: r.h * H });
  const live = o.size === 'live';
  const fs = live ? 9 : 7;
  const tileRect = (key: string, r: Rect, hero: boolean, cut = false) => {
    const g = el('g', {}, svg);
    // (a cut-out: no box, just the figure standing on the capture)
    if (!cut) el('rect', { ...R(r), rx: 3.5, fill: '#1f2a36', stroke: hero ? '#ffd166' : '#6cc7f5', 'stroke-width': hero ? 1.6 : 1 }, g);
    // a little bust silhouette
    const cx = (r.x + r.w / 2) * W, cy = (r.y + r.h * 0.42) * H, s = Math.min(r.w * W, r.h * H);
    el('circle', { cx, cy, r: s * 0.17, fill: hero ? '#ffd16688' : '#6cc7f588' }, g);
    el('path', { d: `M ${cx - s * 0.32} ${(r.y + r.h) * H - 1} Q ${cx} ${cy + s * 0.1} ${cx + s * 0.32} ${(r.y + r.h) * H - 1} Z`, fill: hero ? '#ffd16655' : '#6cc7f555' }, g);
    if (live || s > 26) el('text', { x: (r.x + r.w * 0.06) * W + 2, y: (r.y + r.h) * H - 3, fill: '#fff', 'font-size': fs, 'font-weight': 700 }, g, live ? (o.name?.(key) ?? key).slice(0, 14) : initials(o.name?.(key) ?? key));
  };
  el('rect', { width: W, height: H, fill: '#0e131b' }, svg);
  if (schematic) {
    // the room shot: floor + back wall, the screen, performers as heads
    el('rect', { width: W, height: H * 0.62, fill: '#18202b' }, svg);
    el('rect', { y: H * 0.62, width: W, height: H * 0.38, fill: '#141a22' }, svg);
    const n = Math.max(1, schematic.keys.length);
    if (schematic.kind === 'side') {
      el('rect', { x: W * 0.46, y: H * 0.14, width: W * 0.47, height: W * 0.47 * 9 / 16, rx: 2, fill: chk, stroke: '#4cc9f0', 'stroke-width': 1.2 }, svg);
      el('circle', { cx: W * 0.25, cy: H * 0.42, r: H * 0.1, fill: '#ffd16699', stroke: '#ffd166' }, svg);
      el('path', { d: `M ${W * 0.13} ${H} Q ${W * 0.25} ${H * 0.5} ${W * 0.37} ${H} Z`, fill: '#ffd16655' }, svg);
    } else if (schematic.kind === 'big') {
      el('rect', { x: W * 0.1, y: H * 0.1, width: W * 0.8, height: H * 0.8, rx: 2, fill: chk, stroke: '#4cc9f0', 'stroke-width': 1.2 }, svg);
      for (let i = 0; i < Math.min(n, 6); i++) {
        const cx = W * (0.5 + (i - (Math.min(n, 6) - 1) / 2) * 0.13);
        el('circle', { cx, cy: H * 0.86, r: H * 0.07, fill: i === 0 ? '#ffd16699' : '#6cc7f599', stroke: i === 0 ? '#ffd166' : '#6cc7f5' }, svg);
      }
    } else {
      for (let i = 0; i < Math.min(n, 6); i++) {
        const cx = W * (0.5 + (i - (Math.min(n, 6) - 1) / 2) * 0.15);
        el('circle', { cx, cy: H * 0.45, r: H * 0.09, fill: i === 0 ? '#ffd16699' : '#6cc7f599', stroke: i === 0 ? '#ffd166' : '#6cc7f5' }, svg);
      }
    }
    return svg;
  }
  if (!plan) return svg;
  if (plan.capture) {
    el('rect', { ...R(plan.capture), rx: 2.5, fill: chk, stroke: '#4cc9f0', 'stroke-width': 1.2 }, svg);
    if (live) el('text', { x: (plan.capture.x + plan.capture.w / 2) * W, y: (plan.capture.y + plan.capture.h / 2) * H, fill: '#9fe7ff', 'font-size': 12, 'font-weight': 800, 'text-anchor': 'middle', 'dominant-baseline': 'middle', opacity: 0.9 }, svg, o.captureLabel ?? 'CAPTURE');
  }
  for (const [k, r] of [['CHAT', plan.docks.chat], ['SUPPORT', plan.docks.support]] as const) {
    if (!r || r === 'auto') continue;
    el('rect', { ...R(r), rx: 3, fill: '#151c29', stroke: '#8b5cff', 'stroke-width': 1 }, svg);
    if (live || r.w * W > 30) el('text', { x: (r.x + r.w / 2) * W, y: (r.y + r.h / 2) * H, fill: '#c8b6ff', 'font-size': fs, 'font-weight': 800, 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, svg, k === 'CHAT' ? (live ? '💬 CHAT' : '💬') : live ? '♥ SUPPORT' : '♥');
  }
  for (const t of plan.tiles) tileRect(t.key, t.rect, !!t.hero, t.backdrop === 'cutout');
  // HUD elements (Full screen layouts): dashed outlines + the type's word
  for (const e of plan.hud ?? []) {
    el('rect', { ...R(e.rect), rx: 2, fill: '#ffffff10', stroke: '#e8e2ff', 'stroke-width': 0.8, 'stroke-dasharray': '3 2' }, svg);
    if (live || e.rect.w * W > 34) el('text', { x: (e.rect.x + e.rect.w / 2) * W, y: (e.rect.y + e.rect.h / 2) * H, fill: '#f1ecff', 'font-size': fs, 'font-weight': 800, 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, svg, e.type === 'chatText' ? (live ? '💬 chat text' : '💬') : live ? e.type : '▪');
  }
  return svg;
}
