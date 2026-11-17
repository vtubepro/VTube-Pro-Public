// A wide, short support panel (a band under a game capture): "♥ SUPPORT" plate · stream goal bar · the latest
// supporters as chips; a support event takes the whole strip for 8 s. Canvas2D, redrawn only when something changed
// (≤ 15 Hz while an alert animates). The squarer docks use the in-world support board's canvas instead.
import type { ChatEvent, SceneChatState } from '../../../shared/chat.ts';
import type { ChatFeed } from '../../chat/feed.ts';
import type { StagePalette } from '../../../shared/stage.ts';

const FONT = '"Segoe UI", Inter, system-ui, sans-serif';
function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, h / 2, w / 2);
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
const amount = (e: ChatEvent, st: SceneChatState) => (st.converted && e.approxUsd ? `${e.display ?? ''} ≈$${e.approxUsd.toFixed(2)}` : e.display ?? e.label ?? '');

/** Fit one line of text in `maxW`: shrink down to 72 % of `size`, then ellipsize — never cut a name short at full size. */
function fitLine(g: CanvasRenderingContext2D, text: string, weight: number, size: number, maxW: number): { text: string; size: number } {
  for (let k = 1; k >= 0.72; k -= 0.04) {
    g.font = `${weight} ${Math.round(size * k)}px ${FONT}`;
    if (g.measureText(text).width <= maxW) return { text, size: Math.round(size * k) };
  }
  const fs = Math.round(size * 0.72);
  g.font = `${weight} ${fs}px ${FONT}`;
  let t = text;
  while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return { text: t + '…', size: fs };
}
/** Word-wrap into at most `lines` lines (the last one ellipsized when the text doesn't fit). */
function wrap(g: CanvasRenderingContext2D, text: string, maxW: number, lines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean), out: string[] = [];
  let cur = '', used = 0;
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (g.measureText(t).width <= maxW || !cur) { cur = t; used++; continue; }
    out.push(cur); cur = w; used++;
    if (out.length === lines) { cur = ''; used--; break; }
  }
  if (cur && out.length < lines) out.push(cur);
  const cut = used < words.length;
  const last = out.length - 1;
  if (last >= 0 && (cut || g.measureText(out[last]).width > maxW)) {
    let t = out[last];
    while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    out[last] = t + '…';
  }
  return out;
}

export class SupportStrip {
  readonly canvas = document.createElement('canvas');
  private g = this.canvas.getContext('2d')!;
  palette: StagePalette | null = null;
  alert: { e: ChatEvent; at: number } | null = null;
  private key = '';
  private last = 0;
  private palRef: StagePalette | null | undefined = undefined; private palJson = '';   // JSON of `palette`, redone only when the reference changes

  /** `unit` = device px per 1080p pixel (picks the compact box for short docks). */
  draw(feed: ChatFeed, st: SceneChatState, W: number, H: number, now: number, unit = H / 220) {
    const al = this.alert && now - this.alert.at < 8000 ? this.alert : null;
    if (this.palette !== this.palRef) { this.palRef = this.palette; this.palJson = JSON.stringify(this.palette); }
    const k = `${W}|${H}|${unit.toFixed(3)}|${feed.rev}|${st.goal.on}|${st.goal.target}|${st.goal.label}|${st.converted}|${this.palJson}|${al?.e.id ?? ''}`;
    if (k === this.key && !al) return;
    if (al && now - this.last < 66) return;
    this.key = k; this.last = now;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    const g = this.g, p = this.palette;
    const acc = p?.accent ?? '#35e3ff', acc2 = p?.accent2 ?? '#8b5cff', hero = p?.hero ?? '#ffd166', ink = p?.ink ?? '#fff';
    g.clearRect(0, 0, W, H);
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, p?.glass ?? '#0b1220'); bg.addColorStop(1, '#05070b');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    if (W / H < 4.5 && H / unit <= 150 && W / H >= 1.5) { this.drawCompact(feed, st, W, H, now, al); return; }
    if (W / H < 4.5) { this.drawTall(feed, st, W, H, now, al); return; }
    const pad = Math.round(H * 0.14), fs = Math.round(Math.min(H * 0.3, W * 0.028));
    if (al) {
      const e = al.e, t = Math.min(1, (now - al.at) / 350), tier = e.tier ?? hero;
      const pulse = 0.5 + 0.5 * Math.sin((now - al.at) / 120);
      g.save(); g.globalAlpha = t;
      g.shadowColor = tier; g.shadowBlur = H * (0.2 + 0.2 * pulse);
      g.fillStyle = '#0b0913'; rr(g, pad, pad, W - pad * 2, H - pad * 2, H * 0.2); g.fill();
      g.shadowBlur = 0; g.lineWidth = Math.max(2, H * 0.03); g.strokeStyle = tier; rr(g, pad, pad, W - pad * 2, H - pad * 2, H * 0.2); g.stroke();
      g.textBaseline = 'middle'; g.textAlign = 'left';
      g.font = `900 ${Math.round(fs * 1.15)}px ${FONT}`; g.fillStyle = ink;
      const name = e.user;
      g.fillText(name, pad * 2.2, H / 2, W * 0.45);
      g.textAlign = 'right'; g.fillStyle = tier; g.font = `900 ${Math.round(fs * 1.25)}px ${FONT}`;
      g.fillText(amount(e, st), W - pad * 2.2, H / 2, W * 0.3);
      g.textAlign = 'center'; g.fillStyle = '#ffffffcc'; g.font = `700 ${Math.round(fs * 0.62)}px ${FONT}`;
      g.fillText((e.label ?? 'Support').toUpperCase() + (e.text ? `  “${e.text}”` : ''), W * 0.6, H / 2, W * 0.28);
      g.restore();
      return;
    }
    // plate
    const plateW = Math.min(W * 0.2, H * 2.2);
    const pg = g.createLinearGradient(0, 0, plateW, 0); pg.addColorStop(0, acc); pg.addColorStop(1, acc2);
    g.fillStyle = pg; rr(g, pad, pad, plateW, H - pad * 2, H * 0.18); g.fill();
    g.fillStyle = '#05070b'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const pl = fitLine(g, '♥ SUPPORT', 900, fs * 0.92, plateW - pad);
    g.font = `900 ${pl.size}px ${FONT}`; g.fillText(pl.text, pad + plateW / 2, H / 2 + 1);
    let x = pad * 2 + plateW;
    // goal
    if (st.goal.on) {
      const gw = Math.min(W * 0.34, W - x - pad), gh = Math.round(H * 0.42), gy = (H - gh) / 2;
      const cur = feed.totals?.usd ?? 0, kk = Math.min(1, cur / Math.max(1, st.goal.target));
      g.fillStyle = '#0a0f16'; rr(g, x, gy, gw, gh, gh / 2); g.fill();
      const gr = g.createLinearGradient(x, 0, x + gw, 0); gr.addColorStop(0, acc); gr.addColorStop(1, acc2);
      g.fillStyle = gr; rr(g, x, gy, Math.max(gh, gw * kk), gh, gh / 2); g.fill();
      g.strokeStyle = `${acc}88`; g.lineWidth = 2; rr(g, x, gy, gw, gh, gh / 2); g.stroke();
      const s = fitLine(g, `${st.goal.label}  $${cur.toFixed(2)} / $${st.goal.target.toFixed(0)}`, 800, gh * 0.5, gw - 16);
      g.font = `800 ${s.size}px ${FONT}`; g.lineWidth = 4; g.strokeStyle = '#000a'; g.fillStyle = '#fff';
      g.strokeText(s.text, x + gw / 2, H / 2 + 1); g.fillText(s.text, x + gw / 2, H / 2 + 1);
      x += gw + pad;
    }
    // latest supporters (newest first) as chips
    const fin = feed.support.filter((e) => e.fkind !== 'raid').slice(-6).reverse();
    g.textBaseline = 'middle';
    if (!fin.length) {
      g.textAlign = 'left'; g.fillStyle = `${ink}99`; g.font = `700 ${Math.round(fs * 0.78)}px ${FONT}`;
      g.fillText('Be the first to support the stream today!', x, H / 2, W - x - pad);
      return;
    }
    const ch = H - pad * 2.2, cy = (H - ch) / 2;
    for (const e of fin) {
      const tier = e.tier ?? hero, amt = amount(e, st);
      g.font = `900 ${Math.round(fs * 0.8)}px ${FONT}`;
      const aw = g.measureText(amt).width;
      const nm = fitLine(g, e.user, 800, fs * 0.8, Math.min(W * 0.16, W - pad - x - aw - pad * 3));
      g.font = `800 ${nm.size}px ${FONT}`;
      const nw = g.measureText(nm.text).width;
      const cw = nw + aw + pad * 3;
      if (x + cw > W - pad || nm.text.length < 4) break;
      g.fillStyle = '#ffffff10'; rr(g, x, cy, cw, ch, ch * 0.3); g.fill();
      g.fillStyle = tier; rr(g, x, cy, Math.max(4, H * 0.05), ch, 3); g.fill();
      g.textAlign = 'left'; g.fillStyle = ink; g.font = `800 ${nm.size}px ${FONT}`;
      g.fillText(nm.text, x + pad * 1.2, H / 2);
      g.fillStyle = tier; g.font = `900 ${Math.round(fs * 0.8)}px ${FONT}`;
      g.fillText(amt, x + pad * 1.8 + nw, H / 2);
      x += cw + pad * 0.7;
    }
  }

  /** Squarer docks (a column / a corner card): plate on top, goal bar, supporters one per row (names shrink before they
   *  are ever shortened), alerts as a card whose name wraps onto two lines. */
  private drawTall(feed: ChatFeed, st: SceneChatState, W: number, H: number, now: number, al: { e: ChatEvent; at: number } | null) {
    const g = this.g, p = this.palette;
    const acc = p?.accent ?? '#35e3ff', acc2 = p?.accent2 ?? '#8b5cff', hero = p?.hero ?? '#ffd166', ink = p?.ink ?? '#fff';
    const u = Math.min(W / 300, H / 220);                               // design unit: a 300 × 220 card
    const pad = Math.round(10 * u);
    const plateH = Math.round(Math.min(H * 0.2, 34 * u));
    const pg = g.createLinearGradient(0, 0, W, 0); pg.addColorStop(0, acc); pg.addColorStop(1, acc2);
    g.fillStyle = pg; rr(g, pad, pad, W - pad * 2, plateH, plateH * 0.35); g.fill();
    g.fillStyle = '#05070b'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const pl = fitLine(g, '♥ SUPPORT', 900, plateH * 0.62, W - pad * 4);
    g.font = `900 ${pl.size}px ${FONT}`; g.fillText(pl.text, W / 2, pad + plateH / 2 + 1);
    let y = pad * 2 + plateH;
    if (al) {
      const e = al.e, t = Math.min(1, (now - al.at) / 350), tier = e.tier ?? hero;
      const pulse = 0.5 + 0.5 * Math.sin((now - al.at) / 120);
      const ch = H - y - pad;
      g.save(); g.globalAlpha = t;
      g.shadowColor = tier; g.shadowBlur = 16 * u * (0.6 + 0.4 * pulse);
      g.fillStyle = '#0b0913'; rr(g, pad, y, W - pad * 2, ch, 12 * u); g.fill();
      g.shadowBlur = 0; g.lineWidth = Math.max(2, 3 * u); g.strokeStyle = tier; rr(g, pad, y, W - pad * 2, ch, 12 * u); g.stroke();
      const inner = W - pad * 4;
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = ink;
      const nameFs = Math.round(Math.min(26 * u, ch * 0.2));
      g.font = `900 ${nameFs}px ${FONT}`;
      const nm = wrap(g, e.user, inner, 2);
      let yy = y + ch * 0.2;
      for (const l of nm) { g.fillText(l, W / 2, yy); yy += nameFs * 1.1; }
      const am = fitLine(g, amount(e, st), 900, Math.min(34 * u, ch * 0.24), inner);
      g.fillStyle = tier; g.font = `900 ${am.size}px ${FONT}`; g.fillText(am.text, W / 2, yy + am.size * 0.55); yy += am.size * 1.25;
      g.fillStyle = '#ffffffcc';
      const lb = fitLine(g, (e.label ?? 'Support').toUpperCase(), 800, 12 * u, inner);
      g.font = `800 ${lb.size}px ${FONT}`; g.fillText(lb.text, W / 2, yy); yy += lb.size * 1.4;
      if (e.text && yy < y + ch - 12 * u) {
        g.font = `600 ${Math.round(12 * u)}px ${FONT}`; g.fillStyle = ink;
        for (const l of wrap(g, `“${e.text}”`, inner, Math.max(1, Math.floor((y + ch - yy) / (15 * u))))) { g.fillText(l, W / 2, yy); yy += 15 * u; }
      }
      g.restore();
      return;
    }
    if (st.goal.on) {
      const gh = Math.round(22 * u), gw = W - pad * 2;
      const cur = feed.totals?.usd ?? 0, kk = Math.min(1, cur / Math.max(1, st.goal.target));
      g.fillStyle = '#0a0f16'; rr(g, pad, y, gw, gh, gh / 2); g.fill();
      const gr = g.createLinearGradient(pad, 0, pad + gw, 0); gr.addColorStop(0, acc); gr.addColorStop(1, acc2);
      g.fillStyle = gr; rr(g, pad, y, Math.max(gh, gw * kk), gh, gh / 2); g.fill();
      const tx = fitLine(g, `${st.goal.label}  $${cur.toFixed(2)} / $${st.goal.target.toFixed(0)}`, 800, gh * 0.58, gw - 16);
      g.font = `800 ${tx.size}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 3; g.strokeStyle = '#000a'; g.strokeText(tx.text, W / 2, y + gh / 2 + 1); g.fillStyle = '#fff'; g.fillText(tx.text, W / 2, y + gh / 2 + 1);
      y += gh + pad;
    }
    const fin = feed.support.filter((e) => e.fkind !== 'raid').slice().reverse();
    const cols = W / H > 3.2 ? 3 : W / H > 1.8 ? 2 : 1, cg = pad, colW = (W - pad * 2 - cg * (cols - 1)) / cols;
    const rowH = Math.round(Math.max(20 * u, Math.min(34 * u, (H - y - pad) / (cols > 1 ? 2 : 4))));
    if (!fin.length) {
      g.fillStyle = `${ink}99`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `700 ${Math.round(13 * u)}px ${FONT}`;
      const lines = wrap(g, 'Be the first to support the stream today!', W - pad * 3, 3);
      lines.forEach((l, i) => g.fillText(l, W / 2, y + rowH * 0.8 + i * 17 * u));
      return;
    }
    // (newest first: left to right, then down)
    for (let i = 0; i < fin.length; i++) {
      const col = i % cols, ry = y + Math.floor(i / cols) * rowH;
      if (ry + rowH > H - pad * 0.5) break;
      const e = fin[i], tier = e.tier ?? hero, amt = amount(e, st);
      const x0 = pad + col * (colW + cg), x1 = x0 + colW;
      g.globalAlpha = 1 - Math.min(0.5, Math.floor(i / cols) * 0.12);
      g.fillStyle = '#ffffff0f'; rr(g, x0, ry, colW, rowH - 4 * u, 8 * u); g.fill();
      g.fillStyle = tier; rr(g, x0, ry, Math.max(3, 5 * u), rowH - 4 * u, 3); g.fill();
      g.textBaseline = 'middle';
      const fs = (rowH - 4 * u) * 0.5;
      g.font = `900 ${Math.round(fs)}px ${FONT}`;
      const aw = g.measureText(amt).width;
      g.textAlign = 'right'; g.fillStyle = tier; g.fillText(amt, x1 - pad, ry + (rowH - 4 * u) / 2 + 1);
      const nm = fitLine(g, e.user, 800, fs, colW - pad * 2 - aw - 12 * u);
      g.textAlign = 'left'; g.fillStyle = ink; g.font = `800 ${nm.size}px ${FONT}`; g.fillText(nm.text, x0 + pad, ry + (rowH - 4 * u) / 2 + 1);
    }
    g.globalAlpha = 1;
  }

  /** Short docks (a column's end, ≈ 112 px at 1080p): two rows — the plate + goal bar, then the latest supporters;
   *  an alert takes the box (name + amount, then the label / message). Text ≥ ~20 px at 1080p. */
  private drawCompact(feed: ChatFeed, st: SceneChatState, W: number, H: number, now: number, al: { e: ChatEvent; at: number } | null) {
    const g = this.g, p = this.palette;
    const acc = p?.accent ?? '#35e3ff', acc2 = p?.accent2 ?? '#8b5cff', hero = p?.hero ?? '#ffd166', ink = p?.ink ?? '#fff';
    const pad = Math.max(4, Math.round(H * 0.07)), rowH = (H - pad * 3) / 2, fs = rowH * 0.56;
    const y1 = pad, y2 = pad * 2 + rowH;
    g.textBaseline = 'middle';
    if (al) {
      const e = al.e, t = Math.min(1, (now - al.at) / 350), tier = e.tier ?? hero;
      const pulse = 0.5 + 0.5 * Math.sin((now - al.at) / 120);
      g.save(); g.globalAlpha = t;
      g.shadowColor = tier; g.shadowBlur = H * 0.12 * (0.6 + 0.4 * pulse);
      g.fillStyle = '#0b0913'; rr(g, pad * 0.5, pad * 0.5, W - pad, H - pad, H * 0.12); g.fill();
      g.shadowBlur = 0; g.lineWidth = Math.max(2, H * 0.025); g.strokeStyle = tier; rr(g, pad * 0.5, pad * 0.5, W - pad, H - pad, H * 0.12); g.stroke();
      const amt = fitLine(g, amount(e, st), 900, fs * 1.1, W * 0.4);
      g.font = `900 ${amt.size}px ${FONT}`; const aw = g.measureText(amt.text).width;
      g.textAlign = 'right'; g.fillStyle = tier; g.fillText(amt.text, W - pad * 1.6, y1 + rowH / 2 + 1);
      const nm = fitLine(g, e.user, 900, fs * 1.1, W - pad * 4 - aw);
      g.textAlign = 'left'; g.fillStyle = ink; g.font = `900 ${nm.size}px ${FONT}`; g.fillText(nm.text, pad * 1.6, y1 + rowH / 2 + 1);
      const ln = fitLine(g, (e.label ?? 'Support').toUpperCase() + (e.text ? `  “${e.text}”` : ''), 700, fs * 0.8, W - pad * 3.2);
      g.fillStyle = '#ffffffcc'; g.font = `700 ${ln.size}px ${FONT}`; g.fillText(ln.text, pad * 1.6, y2 + rowH / 2);
      g.restore();
      return;
    }
    // row 1: the plate, then the goal bar (or the top supporter when there's no goal)
    g.font = `900 ${Math.round(fs)}px ${FONT}`;
    const plateW = Math.min(W * 0.42, g.measureText('♥ SUPPORT').width + pad * 2.4);
    const pg = g.createLinearGradient(pad, 0, pad + plateW, 0); pg.addColorStop(0, acc); pg.addColorStop(1, acc2);
    g.fillStyle = pg; rr(g, pad, y1, plateW, rowH, rowH * 0.3); g.fill();
    const pl = fitLine(g, '♥ SUPPORT', 900, fs, plateW - pad * 1.2);
    g.fillStyle = '#05070b'; g.textAlign = 'center'; g.font = `900 ${pl.size}px ${FONT}`; g.fillText(pl.text, pad + plateW / 2, y1 + rowH / 2 + 1);
    const gx = pad * 2 + plateW, gw = W - pad - gx;
    const fin = feed.support.filter((e) => e.fkind !== 'raid').slice().reverse();
    let rest = fin;
    if (st.goal.on && gw > 40) {
      const cur = feed.totals?.usd ?? 0, kk = Math.min(1, cur / Math.max(1, st.goal.target));
      const gh = rowH * 0.8, gy = y1 + (rowH - gh) / 2;
      g.fillStyle = '#0a0f16'; rr(g, gx, gy, gw, gh, gh / 2); g.fill();
      const gr = g.createLinearGradient(gx, 0, gx + gw, 0); gr.addColorStop(0, acc); gr.addColorStop(1, acc2);
      g.fillStyle = gr; rr(g, gx, gy, Math.max(gh, gw * kk), gh, gh / 2); g.fill();
      const tx = fitLine(g, `${st.goal.label}  $${cur.toFixed(2)} / $${st.goal.target.toFixed(0)}`, 800, fs * 0.82, gw - gh);
      g.font = `800 ${tx.size}px ${FONT}`; g.textAlign = 'center';
      g.lineWidth = 3; g.strokeStyle = '#000a'; g.strokeText(tx.text, gx + gw / 2, y1 + rowH / 2 + 1); g.fillStyle = '#fff'; g.fillText(tx.text, gx + gw / 2, y1 + rowH / 2 + 1);
    } else if (fin.length && gw > 40) {
      this.chip(fin[0], st, gx, y1, gw, rowH, fs, ink, hero);
      rest = fin.slice(1);
    }
    // row 2: the latest supporters, newest first, as many as fit (names shrink, then "…")
    if (!rest.length) {
      if (!fin.length) {
        const t = fitLine(g, 'Be the first to support today!', 700, fs * 0.85, W - pad * 2);
        g.textAlign = 'center'; g.fillStyle = `${ink}99`; g.font = `700 ${t.size}px ${FONT}`; g.fillText(t.text, W / 2, y2 + rowH / 2);
      }
      return;
    }
    const cols = Math.max(1, Math.min(3, rest.length, Math.floor((W - pad) / (rowH * 4.2))));
    const cw = (W - pad * (cols + 1)) / cols;
    for (let i = 0; i < cols; i++) {
      g.globalAlpha = 1 - i * 0.12;
      this.chip(rest[i], st, pad + i * (cw + pad), y2, cw, rowH, fs, ink, hero);
    }
    g.globalAlpha = 1;
  }

  /** One supporter: "name  amount" in a rounded chip with the tier's colour edge. */
  private chip(e: ChatEvent, st: SceneChatState, x: number, y: number, w: number, h: number, fs: number, ink: string, hero: string) {
    const g = this.g, tier = e.tier ?? hero, amt = amount(e, st);
    g.fillStyle = '#ffffff12'; rr(g, x, y, w, h, h * 0.3); g.fill();
    g.fillStyle = tier; rr(g, x, y, Math.max(3, h * 0.09), h, 3); g.fill();
    g.textBaseline = 'middle';
    const am = fitLine(g, amt, 900, fs * 0.9, w * 0.45);
    g.font = `900 ${am.size}px ${FONT}`; const aw = g.measureText(am.text).width;
    g.textAlign = 'right'; g.fillStyle = tier; g.fillText(am.text, x + w - h * 0.3, y + h / 2 + 1);
    const nm = fitLine(g, e.user, 800, fs * 0.9, w - aw - h * 0.9);
    g.textAlign = 'left'; g.fillStyle = ink; g.font = `800 ${nm.size}px ${FONT}`; g.fillText(nm.text, x + h * 0.3, y + h / 2 + 1);
  }
}
