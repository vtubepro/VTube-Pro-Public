// Draws a battle map on the table's MAP_SURFACE in the room's own look (scene.json ttrpg.map.look): parchment ink,
// green felt, chalk on slate, a hologram, an old CRT, a blueprint. Procedural maps (shared/ttrpg/maps.ts) come from
// (template, seed), so every page draws the same map; images (VTT scenes / handouts the host sends) are drawn with the
// grid on top. Canvas2D, drawn once per change (never per frame).
import { Cell, type MapGrid } from '../../../shared/ttrpg/maps.ts';
import { sfc32 } from '../../../shared/ttrpg/dice.ts';

export type MapLook = 'paper' | 'felt' | 'chalk' | 'holo' | 'crt' | 'blueprint';
interface Pal { bg: string; bg2: string; floor: string; wall: string; wallEdge: string; water: string; deep: string; tree: string; grass: string; road: string; hazard: string; rubble: string; block: string; grid: string; ink: string; label: string; glow: number; font: string }
export const PALETTES: Record<MapLook, Pal> = {
  paper: { bg: '#e9d9b4', bg2: '#d6bf8e', floor: '#f3e6c6', wall: '#5a3f24', wallEdge: '#2f1f10', water: '#9fb9b8', deep: '#6f9296', tree: '#6f7d3c', grass: '#dfd3a3', road: '#cdb88a', hazard: '#c0582f', rubble: '#a8906a', block: '#8a6a45', grid: 'rgba(80,55,25,0.28)', ink: '#3a2812', label: '#4a2f12', glow: 0, font: 'italic 600 {s}px Georgia, "Palatino Linotype", serif' },
  felt: { bg: '#1f5a36', bg2: '#17482b', floor: '#2f7a4c', wall: '#0e2a18', wallEdge: '#e8e2c8', water: '#2d6a7c', deep: '#1f4f60', tree: '#153e22', grass: '#2a6e43', road: '#6d7a52', hazard: '#b8522e', rubble: '#56704a', block: '#40331f', grid: 'rgba(240,235,210,0.22)', ink: '#f2ecd2', label: '#f7f0d8', glow: 0, font: '700 {s}px "Segoe UI", system-ui, sans-serif' },
  chalk: { bg: '#262b2a', bg2: '#1c201f', floor: '#323837', wall: '#101312', wallEdge: '#e9ede6', water: '#3c5560', deep: '#2c404a', tree: '#4d6a4a', grass: '#353f36', road: '#44474a', hazard: '#b85c4a', rubble: '#555b58', block: '#4a4a44', grid: 'rgba(235,240,230,0.18)', ink: '#eef2ea', label: '#f5f7ee', glow: 0, font: '600 {s}px "Comic Sans MS", "Segoe Print", cursive' },
  holo: { bg: '#04121c', bg2: '#020a10', floor: '#0a2433', wall: '#0e4a66', wallEdge: '#7fe7ff', water: '#0b3b5a', deep: '#072b44', tree: '#0d4d4a', grass: '#08303a', road: '#0d3a4c', hazard: '#ff4d6d', rubble: '#12465a', block: '#1b5f7c', grid: 'rgba(90,220,255,0.28)', ink: '#a8f2ff', label: '#d8fbff', glow: 1, font: '600 {s}px "Consolas", "Segoe UI Mono", monospace' },
  crt: { bg: '#031006', bg2: '#020903', floor: '#062611', wall: '#0c3a18', wallEdge: '#7dff9a', water: '#07301f', deep: '#05241a', tree: '#0b4a1c', grass: '#062d12', road: '#0a3316', hazard: '#ffb347', rubble: '#0f3f1a', block: '#11521f', grid: 'rgba(110,255,140,0.22)', ink: '#9dffb0', label: '#c8ffd2', glow: 1, font: '600 {s}px "Consolas", "Lucida Console", monospace' },
  blueprint: { bg: '#1c4f8f', bg2: '#163f73', floor: '#235aa0', wall: '#e9f2ff', wallEdge: '#ffffff', water: '#2b6cb8', deep: '#1f58a0', tree: '#3a78c0', grass: '#2461a8', road: '#2f68ad', hazard: '#ffd166', rubble: '#6f9fd6', block: '#bcd4f5', grid: 'rgba(255,255,255,0.22)', ink: '#f2f7ff', label: '#ffffff', glow: 0, font: '600 {s}px "Segoe UI", Arial, sans-serif' },
};
export const isMapLook = (v: unknown): v is MapLook => typeof v === 'string' && v in PALETTES;

export interface MapDraw { grid: MapGrid | null; img: HTMLImageElement | ImageBitmap | null; title: string; look: MapLook; ink?: string; paper?: string; cols: number; rows: number }

export function drawMap(ctx: CanvasRenderingContext2D, W: number, H: number, d: MapDraw) {
  const p = { ...PALETTES[d.look] };
  if (d.ink) { p.ink = d.ink; p.label = d.ink; p.wallEdge = d.ink; }
  if (d.paper) p.bg = d.paper;
  const cw = W / d.cols, ch = H / d.rows;
  const rnd = sfc32(((d.grid?.cells.length ?? 7) * 131 + d.cols) >>> 0);
  // background with texture
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.15, W / 2, H / 2, Math.max(W, H) * 0.75);
  g.addColorStop(0, p.bg); g.addColorStop(1, p.bg2);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < (W * H) / 900; i++) { ctx.fillStyle = `rgba(${d.look === 'paper' ? '90,60,20' : '255,255,255'},${0.015 + rnd() * 0.03})`; ctx.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 3, 1 + rnd() * 3); }
  if (d.img) {
    const iw = (d.img as HTMLImageElement).width, ih = (d.img as HTMLImageElement).height;
    const s = Math.max(W / iw, H / ih);
    ctx.drawImage(d.img as CanvasImageSource, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s);
  } else if (d.grid) drawCells(ctx, d.grid, p, cw, ch, rnd, d.look);
  // grid
  ctx.strokeStyle = p.grid; ctx.lineWidth = Math.max(1, cw * 0.03);
  ctx.beginPath();
  for (let x = 0; x <= d.cols; x++) { ctx.moveTo(x * cw, 0); ctx.lineTo(x * cw, H); }
  for (let y = 0; y <= d.rows; y++) { ctx.moveTo(0, y * ch); ctx.lineTo(W, y * ch); }
  ctx.stroke();
  if (d.grid) for (const l of d.grid.labels) label(ctx, l.text, (l.x + 0.5) * cw, (l.y + 0.5) * ch, cw * 0.42, p);
  // title cartouche
  if (d.title) {
    const s = Math.max(18, Math.min(W, H) * 0.045);
    ctx.font = p.font.replace('{s}', String(Math.round(s)));
    const tw = ctx.measureText(d.title).width;
    const bx = W * 0.03, by = H * 0.03, bw = tw + s * 1.4, bh = s * 1.6;
    ctx.fillStyle = d.look === 'paper' ? 'rgba(245,232,200,0.92)' : 'rgba(0,0,0,0.55)';
    ctx.strokeStyle = p.ink; ctx.lineWidth = s * 0.08;
    roundRect(ctx, bx, by, bw, bh, s * 0.3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = p.label; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    if (p.glow) { ctx.shadowColor = p.ink; ctx.shadowBlur = s * 0.5; }
    ctx.fillText(d.title, bx + s * 0.7, by + bh / 2);
    ctx.shadowBlur = 0;
  }
  // compass rose (north = top of the image)
  const r = Math.min(cw, ch) * 1.1, cx = W - r * 1.6, cy = r * 1.6;
  ctx.strokeStyle = p.ink; ctx.fillStyle = p.ink; ctx.lineWidth = r * 0.06;
  ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r * 0.22, cy); ctx.lineTo(cx, cy + r * 0.7); ctx.lineTo(cx - r * 0.22, cy); ctx.closePath(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r * 0.22, cy); ctx.lineTo(cx - r * 0.22, cy); ctx.closePath(); ctx.fill();
  ctx.font = p.font.replace('{s}', String(Math.round(r * 0.5))); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('N', cx, cy - r * 1.05);
  if (d.look === 'crt') { ctx.fillStyle = 'rgba(0,0,0,0.22)'; for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1.5); }
  if (d.look === 'paper') { const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.72); v.addColorStop(0, 'rgba(60,35,10,0)'); v.addColorStop(1, 'rgba(60,35,10,0.35)'); ctx.fillStyle = v; ctx.fillRect(0, 0, W, H); }
}

function drawCells(ctx: CanvasRenderingContext2D, m: MapGrid, p: Pal, cw: number, ch: number, rnd: () => number, look: MapLook) {
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < m.cols && y < m.rows ? m.cells[y * m.cols + x] : Cell.Rock);
  const fillOf: Record<number, string> = { [Cell.Floor]: p.floor, [Cell.Water]: p.water, [Cell.Deep]: p.deep, [Cell.Grass]: p.grass, [Cell.Road]: p.road, [Cell.Hazard]: p.hazard, [Cell.Rubble]: p.rubble, [Cell.Door]: p.floor, [Cell.Tree]: p.grass, [Cell.Block]: p.floor };
  for (let y = 0; y < m.rows; y++) for (let x = 0; x < m.cols; x++) {
    const c = at(x, y);
    const f = fillOf[c];
    if (f) { ctx.fillStyle = f; ctx.fillRect(x * cw - 0.5, y * ch - 0.5, cw + 1, ch + 1); }
    if (c === Cell.Water || c === Cell.Deep) {
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = cw * 0.04;
      for (let k = 0; k < 2; k++) { const yy = y * ch + ch * (0.35 + k * 0.3); ctx.beginPath(); ctx.moveTo(x * cw + cw * 0.15, yy); ctx.quadraticCurveTo(x * cw + cw * 0.5, yy - ch * 0.12, x * cw + cw * 0.85, yy); ctx.stroke(); }
    }
    if (c === Cell.Hazard) { ctx.fillStyle = 'rgba(255,220,120,0.35)'; ctx.beginPath(); ctx.arc(x * cw + cw * (0.3 + rnd() * 0.4), y * ch + ch * (0.3 + rnd() * 0.4), cw * 0.16, 0, 7); ctx.fill(); }
    if (c === Cell.Rubble) { ctx.fillStyle = p.wall; for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.arc(x * cw + cw * rnd(), y * ch + ch * rnd(), cw * (0.05 + rnd() * 0.07), 0, 7); ctx.fill(); } }
  }
  // walls: solid with a crisp inked edge towards open cells (+ hatching on paper)
  for (let y = 0; y < m.rows; y++) for (let x = 0; x < m.cols; x++) {
    const c = at(x, y);
    if (c !== Cell.Wall && c !== Cell.Rock && c !== Cell.Block) continue;
    const open = (dx: number, dy: number) => { const n = at(x + dx, y + dy); return n !== Cell.Wall && n !== Cell.Rock && n !== Cell.Block; };
    const near = open(1, 0) || open(-1, 0) || open(0, 1) || open(0, -1);
    if (c === Cell.Rock && !near) { ctx.fillStyle = look === 'paper' ? 'rgba(90,63,36,0.18)' : 'rgba(0,0,0,0.35)'; ctx.fillRect(x * cw, y * ch, cw, ch); continue; }
    ctx.fillStyle = c === Cell.Block ? p.block : p.wall; ctx.fillRect(x * cw - 0.5, y * ch - 0.5, cw + 1, ch + 1);
    if (look === 'paper' && c !== Cell.Block) { ctx.strokeStyle = 'rgba(245,230,200,0.25)'; ctx.lineWidth = cw * 0.03; for (let k = -1; k < 3; k++) { ctx.beginPath(); ctx.moveTo(x * cw + k * cw * 0.33, y * ch + ch); ctx.lineTo(x * cw + (k + 1) * cw * 0.33, y * ch); ctx.stroke(); } }
    ctx.strokeStyle = p.wallEdge; ctx.lineWidth = cw * 0.09; ctx.lineCap = 'round';
    if (p.glow) { ctx.shadowColor = p.wallEdge; ctx.shadowBlur = cw * 0.35; }
    ctx.beginPath();
    if (open(0, -1)) { ctx.moveTo(x * cw, y * ch); ctx.lineTo(x * cw + cw, y * ch); }
    if (open(0, 1)) { ctx.moveTo(x * cw, y * ch + ch); ctx.lineTo(x * cw + cw, y * ch + ch); }
    if (open(-1, 0)) { ctx.moveTo(x * cw, y * ch); ctx.lineTo(x * cw, y * ch + ch); }
    if (open(1, 0)) { ctx.moveTo(x * cw + cw, y * ch); ctx.lineTo(x * cw + cw, y * ch + ch); }
    ctx.stroke(); ctx.shadowBlur = 0;
  }
  // doors, trees, props
  for (let y = 0; y < m.rows; y++) for (let x = 0; x < m.cols; x++) {
    const c = at(x, y), px = x * cw, py = y * ch;
    if (c === Cell.Door) { ctx.fillStyle = p.block; ctx.strokeStyle = p.wallEdge; ctx.lineWidth = cw * 0.05; ctx.fillRect(px + cw * 0.15, py + ch * 0.38, cw * 0.7, ch * 0.24); ctx.strokeRect(px + cw * 0.15, py + ch * 0.38, cw * 0.7, ch * 0.24); }
    if (c === Cell.Tree) {
      ctx.fillStyle = p.tree; ctx.strokeStyle = p.ink; ctx.lineWidth = cw * 0.04;
      const r = cw * (0.36 + rnd() * 0.12);
      ctx.beginPath(); for (let k = 0; k < 9; k++) { const a = (k / 9) * Math.PI * 2, rr = r * (0.85 + 0.15 * Math.sin(k * 2.3)); ctx.lineTo(px + cw / 2 + Math.cos(a) * rr, py + ch / 2 + Math.sin(a) * rr); } ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.arc(px + cw / 2, py + ch / 2, r * 0.18, 0, 7); ctx.fill();
    }
  }
  for (const pr of m.props) drawProp(ctx, pr.kind, (pr.x + 0.5) * cw, (pr.y + 0.5) * ch, cw, p);
}

function drawProp(ctx: CanvasRenderingContext2D, kind: string, x: number, y: number, s: number, p: Pal) {
  ctx.save(); ctx.translate(x, y);
  ctx.strokeStyle = p.ink; ctx.fillStyle = p.block; ctx.lineWidth = s * 0.05;
  if (p.glow) { ctx.shadowColor = p.ink; ctx.shadowBlur = s * 0.25; }
  const r = s * 0.34;
  switch (kind) {
    case 'crate': case 'locker': ctx.fillRect(-r, -r, r * 2, r * 2); ctx.strokeRect(-r, -r, r * 2, r * 2); ctx.beginPath(); ctx.moveTo(-r, -r); ctx.lineTo(r, r); ctx.moveTo(r, -r); ctx.lineTo(-r, r); ctx.stroke(); break;
    case 'barrel': case 'stool': case 'pillar': case 'stalagmite': case 'statue': case 'boulder': ctx.beginPath(); ctx.arc(0, 0, r * (kind === 'stool' ? 0.6 : 0.9), 0, 7); ctx.fill(); ctx.stroke(); if (kind === 'barrel') { ctx.beginPath(); ctx.arc(0, 0, r * 0.55, 0, 7); ctx.stroke(); } break;
    case 'chest': ctx.fillStyle = '#b8872a'; ctx.fillRect(-r, -r * 0.6, r * 2, r * 1.2); ctx.strokeRect(-r, -r * 0.6, r * 2, r * 1.2); ctx.beginPath(); ctx.moveTo(-r, -r * 0.1); ctx.lineTo(r, -r * 0.1); ctx.stroke(); break;
    case 'campfire': case 'brazier': ctx.fillStyle = '#ff8a2a'; ctx.beginPath(); ctx.moveTo(0, -r); ctx.quadraticCurveTo(r, 0, 0, r * 0.7); ctx.quadraticCurveTo(-r, 0, 0, -r); ctx.fill(); ctx.stroke(); break;
    case 'bones': ctx.beginPath(); ctx.moveTo(-r, -r * 0.4); ctx.lineTo(r, r * 0.4); ctx.moveTo(-r, r * 0.4); ctx.lineTo(r, -r * 0.4); ctx.stroke(); break;
    case 'machine': case 'console': case 'bench': ctx.fillRect(-r * 1.2, -r * 0.8, r * 2.4, r * 1.6); ctx.strokeRect(-r * 1.2, -r * 0.8, r * 2.4, r * 1.6); ctx.beginPath(); ctx.arc(0, 0, r * 0.35, 0, 7); ctx.stroke(); break;
    case 'tent': ctx.beginPath(); ctx.moveTo(0, -r * 1.2); ctx.lineTo(r * 1.2, r); ctx.lineTo(-r * 1.2, r); ctx.closePath(); ctx.fill(); ctx.stroke(); break;
    case 'sandbags': for (let k = -1; k <= 1; k++) { ctx.beginPath(); ctx.ellipse(k * r * 0.7, 0, r * 0.4, r * 0.28, 0, 0, 7); ctx.fill(); ctx.stroke(); } break;
    case 'reeds': case 'tree': for (let k = 0; k < 5; k++) { ctx.beginPath(); ctx.moveTo((k - 2) * r * 0.3, r); ctx.lineTo((k - 2) * r * 0.45, -r); ctx.stroke(); } break;
    case 'lilypad': ctx.fillStyle = '#5e9a45'; ctx.beginPath(); ctx.arc(0, 0, r * 0.8, 0.3, Math.PI * 2 - 0.1); ctx.lineTo(0, 0); ctx.fill(); break;
    case 'hut': ctx.fillRect(-r, -r, r * 2, r * 2); ctx.strokeRect(-r, -r, r * 2, r * 2); ctx.beginPath(); ctx.moveTo(-r, -r); ctx.lineTo(0, -r * 1.6); ctx.lineTo(r, -r); ctx.stroke(); break;
    case 'spill': ctx.fillStyle = 'rgba(200,160,40,0.55)'; ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.6, 0.4, 0, 7); ctx.fill(); break;
    case 'bed': ctx.fillRect(-r * 0.7, -r * 1.2, r * 1.4, r * 2.4); ctx.strokeRect(-r * 0.7, -r * 1.2, r * 1.4, r * 2.4); break;
    case 'cart': case 'lamp': default: ctx.beginPath(); ctx.arc(0, 0, r * 0.5, 0, 7); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, s: number, p: Pal) {
  ctx.font = p.font.replace('{s}', String(Math.round(s)));
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = s * 0.25; ctx.strokeStyle = p.bg; ctx.strokeText(text, x, y);
  ctx.fillStyle = p.label; ctx.fillText(text, x, y);
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
