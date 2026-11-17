// The chat audience's floating cards: speech BUBBLES (a chat message above the chatter, emotes inline) and QUESTION cards
// (an approved !ask / paid question above the asker's name; "NOW ANSWERING" when it is up). Each card is one canvas
// texture on a camera-facing quad that keeps a readable on-screen size. Pooled: a few bubbles + question cards at once.
import * as THREE from 'three';
import type { ChatPart } from '../../../shared/chat.ts';
import type { NameStyle } from '../../../shared/audience.ts';
import { drawBadge } from '../../chat/nameStyle.ts';
import { readable } from './nameTags.ts';

const FONT = '"Segoe UI", "Noto Sans", system-ui, sans-serif';

// ---------------------------------------------------------------- emote images (through this PC's proxy: untainted canvases)
const images = new Map<string, HTMLImageElement | null>();
const waiting = new Map<string, Set<() => void>>();
function emoteImage(url: string, onLoad: () => void): HTMLImageElement | null {
  const have = images.get(url);
  if (have) return have.complete && have.naturalWidth ? have : null;
  if (have === null) return null;
  if (!/^\/[\w\-./%?=&]{1,300}$/.test(url) && !/^https:\/\//.test(url)) { images.set(url, null); return null; }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  const list = new Set([onLoad]); waiting.set(url, list);
  img.onload = () => { for (const f of waiting.get(url) ?? []) f(); waiting.delete(url); };
  img.onerror = () => { images.set(url, null); waiting.delete(url); };
  img.src = url.startsWith('/') ? url : `/api/chat/img?u=${encodeURIComponent(url)}`;
  images.set(url, img);
  if (images.size > 400) { const k = images.keys().next().value; if (k !== undefined) images.delete(k); }
  return null;
}

type Tok = { k: 'w'; v: string; w: number } | { k: 'sp'; w: number } | { k: 'em'; url: string; n: string; w: number };
function tokens(g: CanvasRenderingContext2D, parts: ChatPart[], fs: number): Tok[] {
  const out: Tok[] = [];
  for (const p of parts) {
    if (p.t === 'emote') { out.push({ k: 'em', url: p.u, n: p.n, w: fs * 1.3 }); continue; }
    for (const w of p.v.split(/(\s+)/)) { if (!w) continue; if (/^\s+$/.test(w)) out.push({ k: 'sp', w: g.measureText(' ').width }); else out.push({ k: 'w', v: w, w: g.measureText(w).width }); }
  }
  return out;
}
function wrap(toks: Tok[], maxW: number, maxLines: number): { lines: Tok[][]; cut: boolean } {
  const lines: Tok[][] = [[]]; let x = 0, cut = false;
  for (const t of toks) {
    if (t.k === 'sp' && x === 0) continue;
    if (x + t.w > maxW && x > 0) { if (lines.length >= maxLines) { cut = true; break; } lines.push([]); x = 0; if (t.k === 'sp') continue; }
    lines[lines.length - 1].push(t); x += t.w;
  }
  return { lines, cut };
}
const lineW = (l: Tok[]) => l.reduce((a, t) => a + t.w, 0);

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

export interface BubbleSpec { kind: 'bubble'; parts: ChatPart[]; laugh: boolean }
export interface QuestionSpec { kind: 'question'; text: string; name: string; nameColor: string; style: NameStyle; paid?: { display: string; tier: string }; answering: boolean; /** answered a moment ago: fading out as ANSWERED */ done?: boolean }
export type CardSpec = BubbleSpec | QuestionSpec;

class Card {
  readonly canvas = document.createElement('canvas');
  readonly g: CanvasRenderingContext2D;
  readonly tex: THREE.CanvasTexture;
  readonly mesh: THREE.Mesh;
  readonly mat: THREE.MeshBasicMaterial;
  key = '';
  /** who shows on it (the caller's id): the same card every frame */
  owner = '';
  used = false;
  /** drawn content size in canvas px (the quad matches it) */
  w = 1; h = 1;
  constructor(W: number, H: number) {
    this.canvas.width = W; this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter; this.tex.generateMipmaps = true; this.tex.anisotropy = 4;
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, depthTest: true, toneMapped: false });
    const geo = new THREE.PlaneGeometry(1, 1); geo.translate(0, 0.5, 0);   // anchored at the bottom centre
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 22; this.mesh.visible = false;
  }
  dispose() { this.tex.dispose(); this.mat.dispose(); this.mesh.geometry.dispose(); this.mesh.removeFromParent(); }
}

const tq = new THREE.Quaternion(), tpq = new THREE.Quaternion(), tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tf = new THREE.Vector3(), tcp = new THREE.Vector3();
type Rect = { x0: number; y0: number; x1: number; y1: number };
type Req = { id: string; spec: CardSpec; pos: THREE.Vector3; worldH: number; pxMin: number; pxMax: number; pop: number; alpha: number; prio: number };
function overlapsAny(r: Rect, list: readonly Rect[]) { for (const q of list) if (!(r.x1 < q.x0 || r.x0 > q.x1 || r.y1 < q.y0 || r.y0 > q.y1)) return true; return false; }

export class AudienceCards {
  readonly group = new THREE.Group();
  private bubbles: Card[] = [];
  private qcards: Card[] = [];
  private redraw = new Set<Card>();

  constructor(nBubbles = 8, nQuestions = 6) {
    this.group.name = 'audience-cards';
    for (let i = 0; i < nBubbles; i++) { const c = new Card(512, 176); this.bubbles.push(c); this.group.add(c.mesh); }
    for (let i = 0; i < nQuestions; i++) { const c = new Card(768, 330); this.qcards.push(c); this.group.add(c.mesh); }
  }

  private reqs: Req[] = [];
  private pool: Req[] = [];
  private order: Req[] = [];
  private placed: Rect[] = [];
  private rectPool: Rect[] = [];
  /** Cards that did not fit this frame (overlap / a face): debug + tests. */
  dropped = 0;

  begin() { for (const r of this.reqs) this.pool.push(r); this.reqs.length = 0; for (const c of this.bubbles) c.used = false; for (const c of this.qcards) c.used = false; }

  /** Ask for a card for `id` at `pos` (root space, its bottom centre). `pxMin` / `pxMax` = its on-screen height range at
   *  1080p; `pop` 0…1 scales it in / out; `prio` decides who wins when cards would overlap (end()). */
  show(id: string, spec: CardSpec, pos: THREE.Vector3, worldH: number, pxMin: number, pxMax: number, pop: number, alpha = 1, prio = 0) {
    const r = this.pool.pop() ?? { id: '', spec, pos: new THREE.Vector3(), worldH: 0, pxMin: 0, pxMax: 0, pop: 0, alpha: 0, prio: 0 };
    r.id = id; r.spec = spec; r.pos.copy(pos); r.worldH = worldH; r.pxMin = pxMin; r.pxMax = pxMax; r.pop = pop; r.alpha = alpha; r.prio = prio;
    this.reqs.push(r);
  }

  /** Place this frame's cards, most important first: a card that would overlap one already placed (or cover a
   *  performer's face: `faces`, 0…1 screen rects) waits — the one on air (prio >= 3000) always shows. */
  end(cam: THREE.PerspectiveCamera, viewH: number, faces: { x0: number; y0: number; x1: number; y1: number }[] = []) {
    const parent = this.group.parent;
    cam.updateMatrixWorld();
    cam.getWorldDirection(tf);
    const camPos = cam.getWorldPosition(tcp);
    cam.getWorldQuaternion(tq);
    if (parent) { parent.getWorldQuaternion(tpq).invert(); tq.premultiply(tpq); }
    const vw = viewH * cam.aspect;
    for (const r of this.placed) this.rectPool.push(r);
    const placed = this.placed; placed.length = 0;
    this.dropped = 0;
    const order = this.order; order.length = 0;
    for (const r of this.reqs) order.push(r);
    order.sort((a, b) => b.prio - a.prio);
    for (const r of order) {
      const pool = r.spec.kind === 'bubble' ? this.bubbles : this.qcards;
      let c = pool.find((x) => x.owner === r.id && !x.used) ?? null;
      if (!c) c = pool.find((x) => !x.used && !x.owner) ?? pool.find((x) => !x.used && !x.mesh.visible) ?? null;
      if (!c) { this.dropped++; continue; }
      const sp = r.spec;
      const key = sp.kind === 'bubble' ? `b|${r.id}` : `q|${r.id}|${sp.answering ? 1 : sp.done ? 2 : 0}|${sp.text}|${sp.style.color}|${sp.paid?.display ?? ''}`;
      if (c.key !== key || this.redraw.has(c)) { c.key = key; this.redraw.delete(c); this.paint(c, sp); }
      // size: world height clamped to the on-screen range
      const wpos = parent ? parent.localToWorld(tv.copy(r.pos)) : tv.copy(r.pos);
      const depth = Math.max(0.1, tv2.copy(wpos).sub(camPos).dot(tf));
      const pxPerUnit = viewH / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * depth);
      const k = viewH / 1080;
      const hPx = Math.min(r.pxMax * k, Math.max(r.pxMin * k, r.worldH * pxPerUnit)) * r.pop;
      const aspect = c.w / c.h;
      // its screen rect (bottom centre projected; the card stands straight up on screen)
      tv2.copy(wpos).project(cam);
      if (tv2.z > 1) { c.used = true; c.mesh.visible = false; continue; }
      const sx = (tv2.x + 1) / 2, sy = (1 - tv2.y) / 2;
      const rect = this.rectPool.pop() ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
      rect.x0 = sx - (hPx * aspect) / 2 / vw; rect.x1 = sx + (hPx * aspect) / 2 / vw; rect.y0 = sy - hPx / viewH; rect.y1 = sy;
      if (r.prio < 3000 && (overlapsAny(rect, placed) || overlapsAny(rect, faces))) { this.rectPool.push(rect); this.dropped++; continue; }   // (its card stays free for it next frame)
      placed.push(rect);
      c.used = true; c.owner = r.id;
      const h = hPx / pxPerUnit;
      c.mesh.position.copy(r.pos);
      c.mesh.quaternion.copy(tq);
      c.mesh.scale.set(h * aspect, h, 1);
      c.tex.repeat.set(c.w / c.canvas.width, c.h / c.canvas.height);
      c.tex.offset.set(0, 1 - c.h / c.canvas.height);
      c.mat.opacity = r.alpha;
      c.mesh.visible = h > 1e-4 && r.alpha > 0.01;
    }
    for (const list of [this.bubbles, this.qcards]) for (const c of list) if (!c.used) { c.mesh.visible = false; if (!this.reqs.some((r) => r.id === c.owner)) c.owner = ''; }
  }

  private paint(c: Card, s: CardSpec) {
    if (s.kind === 'bubble') this.paintBubble(c, s); else this.paintQuestion(c, s);
    c.tex.needsUpdate = true;
  }

  private paintBubble(c: Card, s: BubbleSpec) {
    const g = c.g, W = c.canvas.width, H = c.canvas.height;
    g.clearRect(0, 0, W, H);
    const fs = 30, maxW = W - 64;
    g.font = `650 ${fs}px ${FONT}`;
    const { lines, cut } = wrap(tokens(g, s.parts, fs), maxW, 2);
    if (cut) { const l = lines[lines.length - 1]; while (l.length && lineW(l) + g.measureText('…').width > maxW) l.pop(); l.push({ k: 'w', v: '…', w: g.measureText('…').width }); }
    const lh = fs * 1.22;
    const bw = Math.min(W - 8, Math.max(...lines.map(lineW), 40) + 40), bh = lines.length * lh + 24, tail = 18;
    const x0 = (W - bw) / 2, y0 = 4;
    // bubble + tail (a laugh gets a warm tint)
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 6; g.shadowOffsetY = 2;
    roundRect(g, x0, y0, bw, bh, 22);
    g.moveTo(W / 2 - 12, y0 + bh - 1); g.lineTo(W / 2, y0 + bh + tail); g.lineTo(W / 2 + 12, y0 + bh - 1);
    g.fillStyle = s.laugh ? '#fff6d6' : '#ffffff'; g.fill();
    g.restore();
    g.lineWidth = 2; g.strokeStyle = 'rgba(20,24,40,0.25)'; roundRect(g, x0, y0, bw, bh, 22); g.stroke();
    g.font = `650 ${fs}px ${FONT}`; g.textBaseline = 'middle'; g.fillStyle = '#16182a';
    lines.forEach((l, i) => {
      let x = (W - lineW(l)) / 2;
      const y = y0 + 12 + i * lh + lh / 2;
      for (const t of l) {
        if (t.k === 'w') g.fillText(t.v, x, y);
        else if (t.k === 'em') {
          const im = emoteImage(t.url, () => this.redraw.add(c));
          if (im) { const ar = Math.min(2.5, im.naturalWidth / Math.max(1, im.naturalHeight)); const eh = fs * 1.15; g.drawImage(im, x, y - eh / 2, eh * ar, eh); }
          else { g.fillStyle = '#c9cde0'; roundRect(g, x + 2, y - fs * 0.45, t.w - 4, fs * 0.9, fs * 0.25); g.fill(); g.fillStyle = '#16182a'; }   // (no image: a neutral chip, never the typed name)
        }
        x += t.w;
      }
    });
    c.w = W; c.h = Math.min(H, Math.ceil(y0 + bh + tail + 4));
  }

  private paintQuestion(c: Card, s: QuestionSpec) {
    const g = c.g, W = c.canvas.width, H = c.canvas.height;
    g.clearRect(0, 0, W, H);
    const accent = s.paid?.tier ?? (s.answering || s.done ? '#ffd34d' : '#35e3ff');
    const pad = 22;
    let fs = 34;
    g.font = `700 ${fs}px ${FONT}`;
    let lines = wrap(tokens(g, [{ t: 'text', v: s.text }], fs), W - pad * 2 - 8, 4);
    if (lines.cut) { fs = 28; g.font = `700 ${fs}px ${FONT}`; lines = wrap(tokens(g, [{ t: 'text', v: s.text }], fs), W - pad * 2 - 8, 5); }
    if (lines.cut) { const l = lines.lines[lines.lines.length - 1]; while (l.length && lineW(l) + g.measureText('…').width > W - pad * 2 - 8) l.pop(); l.push({ k: 'w', v: '…', w: g.measureText('…').width }); }
    const lh = fs * 1.2, head = 46, foot = 44;
    const bh = head + 12 + lines.lines.length * lh + foot, tail = 20, y0 = 4;
    const bw = W - 8, x0 = 4;
    g.save();
    if (s.answering) { g.shadowColor = accent; g.shadowBlur = 18; }
    roundRect(g, x0, y0, bw, bh, 24);
    g.moveTo(W / 2 - 16, y0 + bh - 1); g.lineTo(W / 2, y0 + bh + tail); g.lineTo(W / 2 + 16, y0 + bh - 1);
    g.fillStyle = 'rgba(12,14,26,0.97)'; g.fill();
    g.restore();
    g.lineWidth = s.answering ? 5 : 3; g.strokeStyle = accent; roundRect(g, x0, y0, bw, bh, 24); g.stroke();
    // header strip
    g.save(); roundRect(g, x0, y0, bw, head, 24); g.clip(); g.fillStyle = accent; g.globalAlpha = s.answering ? 1 : 0.85; g.fillRect(x0, y0, bw, head); g.restore();
    g.font = `900 24px ${FONT}`; g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillStyle = inkOn(accent);
    g.fillText(s.answering ? 'NOW ANSWERING' : s.done ? 'ANSWERED' : 'QUESTION', x0 + pad, y0 + head / 2 + 1);
    if (s.paid) {
      g.textAlign = 'right'; g.font = `900 24px ${FONT}`;
      g.fillText(s.paid.display, x0 + bw - pad, y0 + head / 2 + 1);
    }
    // the question
    g.textAlign = 'left'; g.font = `700 ${fs}px ${FONT}`; g.fillStyle = '#f4f6ff';
    lines.lines.forEach((l, i) => { const y = y0 + head + 10 + i * lh + lh / 2; let x = x0 + pad; for (const t of l) { if (t.k === 'w') g.fillText(t.v, x, y); x += t.w; } });
    // the asker
    const fy = y0 + bh - foot / 2 - 4;
    let x = x0 + pad;
    g.font = `800 24px ${FONT}`; g.fillStyle = '#9aa4c4'; g.fillText('—', x, fy); x += 30;
    if (s.style.badge !== 'none') { drawBadge(g, s.style.badge, x, fy - 12, 24); x += 30; }
    if (s.style.glow) { g.shadowColor = s.style.glow; g.shadowBlur = 8; }
    g.fillStyle = readable(s.style.color || s.nameColor);
    g.fillText(s.name, x, fy);
    g.shadowBlur = 0;
    c.w = W; c.h = Math.min(H, Math.ceil(y0 + bh + tail + 4));
  }

  dispose() { for (const c of [...this.bubbles, ...this.qcards]) c.dispose(); this.group.removeFromParent(); }
}

function inkOn(bg: string) { const c = new THREE.Color(bg); return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b > 0.45 ? '#0b0f14' : '#ffffff'; }
