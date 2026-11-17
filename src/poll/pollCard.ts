// The on-stream poll card (server/poll.ts pushes {type:'poll'}): ONE canvas renderer used twice —
//   in-world: drawn onto the room's chat monitor / support board texture (src/chat/chatCanvas.ts) while the compositor
//             sees that prop in the shot (the chat in-world policy: StageCompositor.pollWorld), else
//   docked:   a card in the first free screen corner that touches no face, cam, capture / interview screen or docked
//             chat (shared/poll.ts pickPollDock over StageCompositor.pollAvoid()).
// Live animated bars, a countdown ring, total votes + a "+N votes" pulse, and a winner reveal (gold bar, crown,
// confetti, a short synthesized sting when the page's voice is on — never on test pages).
import { pickPollDock, sanitizePollView, winnerText, type PollView, type PRect } from '../../shared/poll.ts';

const FONT = '"Segoe UI", system-ui, sans-serif';
const COLS = ['#35e3ff', '#ff5fa2', '#ffd24a', '#7dff8a', '#b388ff', '#ff8a3d', '#4dd0e1', '#f06292'];
const SHOW_AFTER_END_MS = 15000;

class PollStore {
  view: PollView | null = null;
  /** Which in-world chat prop shows the card right now (set by the compositor each frame). */
  world: 'monitor' | 'board' | null = null;
  bars: number[] = [];
  pulses: { n: number; at: number }[] = [];
  revealAt = 0;
  private stepAt = 0;
  onReveal: ((v: PollView) => void) | null = null;

  set(raw: unknown, now = Date.now()) {
    const v = sanitizePollView(raw);
    const prev = this.view;
    if (!v) { this.view = null; return; }
    if (!prev || prev.id !== v.id) { this.bars = v.options.map(() => 0); this.revealAt = 0; this.pulses = []; }
    if (v.pulse > 0 && v.state === 'live') { this.pulses.push({ n: v.pulse, at: now }); if (this.pulses.length > 6) this.pulses.shift(); }
    if (v.state === 'ended' && (!prev || prev.id !== v.id || prev.state !== 'ended')) {
      // a result that ended long ago (page reload) shows no reveal
      this.revealAt = !v.endedAt || now - v.endedAt < 5000 ? now : 1;
      if (this.revealAt > 1) try { this.onReveal?.(v); } catch { /* */ }
    }
    this.view = v;
  }
  /** Card on stream right now? */
  active(now = Date.now()): boolean {
    const v = this.view;
    if (!v || !v.shown) return false;
    return v.state === 'live' || now - (this.revealAt > 1 ? this.revealAt : v.endedAt) < SHOW_AFTER_END_MS;
  }
  step(now: number) {
    const dt = Math.min(0.1, Math.max(0, (now - (this.stepAt || now)) / 1000));
    this.stepAt = now;
    const v = this.view;
    if (!v) return;
    const max = Math.max(1, v.total);
    v.options.forEach((o, i) => { const t = o.votes / max; this.bars[i] = (this.bars[i] ?? 0) + (t - (this.bars[i] ?? 0)) * (1 - Math.exp(-dt * 7)); });
  }
}
export const pollStore = new PollStore();

/** Canvas height for a width (the card's aspect follows the option count). */
export const pollCardHeight = (W: number, n: number) => Math.round(W * (0.3 + n * 0.105));

const rr = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
};
function fit(g: CanvasRenderingContext2D, s: string, maxW: number): string {
  if (g.measureText(s).width <= maxW) return s;
  let t = s;
  while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}
const fmtT = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`; };

/** Draw the card into (0,0,W,H). `solid` = opaque background (in-world screens). */
export function drawPoll(g: CanvasRenderingContext2D, W: number, H: number, now = Date.now(), solid = false) {
  const st = pollStore, v = st.view;
  if (!v) return;
  st.step(now);
  const ended = v.state === 'ended';
  const rv = ended && st.revealAt > 1 ? Math.min(1, (now - st.revealAt) / 900) : ended ? 1 : 0;
  const n = v.options.length;
  const u = Math.min(W / 720, H / pollCardHeight(720, n));   // unit: the 720-px reference card
  const pad = 26 * u;
  g.save();
  // panel
  if (solid) { g.fillStyle = '#07060d'; g.fillRect(0, 0, W, H); }
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, 'rgba(24,14,48,0.94)'); bg.addColorStop(1, 'rgba(8,10,26,0.94)');
  rr(g, 2, 2, W - 4, H - 4, 26 * u); g.fillStyle = bg; g.fill();
  const edge = g.createLinearGradient(0, 0, W, 0);
  edge.addColorStop(0, ended ? '#ffd24a' : '#35e3ff'); edge.addColorStop(1, ended ? '#ff8a3d' : '#ff5fa2');
  g.lineWidth = 3 * u; g.strokeStyle = edge; g.stroke();
  // header: POLL tag, timer ring, question
  g.textBaseline = 'middle';
  const tagH = 34 * u;
  g.font = `900 ${Math.round(19 * u)}px ${FONT}`;
  const tag = ended ? 'RESULTS' : 'POLL · VOTE IN CHAT';
  const tw = g.measureText(tag).width + 28 * u;
  rr(g, pad, pad, tw, tagH, tagH / 2); g.fillStyle = ended ? '#ffd24a' : '#35e3ff'; g.fill();
  g.fillStyle = '#0a0716'; g.textAlign = 'left'; g.fillText(tag, pad + 14 * u, pad + tagH / 2 + 1);
  // timer / total on the right
  const cx = W - pad - 26 * u, cy = pad + tagH / 2, R = 24 * u;
  g.lineWidth = 6 * u;
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.strokeStyle = '#ffffff22'; g.stroke();
  let tText = '∞';
  if (!ended && v.endsAt) {
    const left = v.endsAt - now, frac = Math.max(0, Math.min(1, left / Math.max(1, v.endsAt - v.startedAt)));
    g.beginPath(); g.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    g.strokeStyle = left < 10000 ? `rgba(255,95,162,${0.7 + 0.3 * Math.sin(now / 120)})` : '#35e3ff'; g.stroke();
    tText = fmtT(left);
  } else if (ended) { g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.strokeStyle = '#ffd24a'; g.stroke(); tText = '✓'; }
  g.font = `800 ${Math.round((tText.length > 3 ? 14 : 17) * u)}px ${FONT}`; g.textAlign = 'center'; g.fillStyle = '#fff'; g.fillText(tText, cx, cy + 1);
  g.font = `800 ${Math.round(22 * u)}px ${FONT}`; g.textAlign = 'right'; g.fillStyle = '#e9e4ff';
  g.fillText(`${v.total} vote${v.total === 1 ? '' : 's'}`, cx - R - 14 * u, cy + 1);
  // question
  let y = pad + tagH + 20 * u;
  g.font = `800 ${Math.round(33 * u)}px ${FONT}`; g.textAlign = 'left'; g.fillStyle = '#fff'; g.textBaseline = 'top';
  g.fillText(fit(g, v.question, W - pad * 2), pad, y);
  y += 50 * u;
  // bars
  const rowH = 75.6 * u, barH = 44 * u;
  const win = new Set(v.winner);
  v.options.forEach((o, i) => {
    const yy = y + i * rowH, isWin = ended && win.has(i);
    const dim = ended && !isWin ? 1 - 0.55 * rv : 1;
    g.globalAlpha = dim;
    rr(g, pad, yy, W - pad * 2, barH, 12 * u); g.fillStyle = '#ffffff12'; g.fill();
    const f = Math.max(0, Math.min(1, st.bars[i] ?? 0));
    if (f > 0.002) {
      const bw = Math.max(barH * 0.5, (W - pad * 2) * f);
      const c = isWin ? '#ffd24a' : COLS[i % COLS.length];
      const gr = g.createLinearGradient(pad, 0, pad + bw, 0); gr.addColorStop(0, c + 'aa'); gr.addColorStop(1, c);
      if (isWin) { g.shadowColor = '#ffd24a'; g.shadowBlur = 24 * u * rv; }
      rr(g, pad, yy, bw, barH, 12 * u); g.fillStyle = gr; g.fill();
      g.shadowBlur = 0;
      // sheen sweeping over the leading bar(s) while live
      if (!ended) {
        const sx = pad + ((now / 1400 + i * 0.17) % 1) * bw;
        const sh = g.createLinearGradient(sx - 40 * u, 0, sx + 40 * u, 0); sh.addColorStop(0, '#fff0'); sh.addColorStop(0.5, '#ffffff30'); sh.addColorStop(1, '#fff0');
        g.save(); rr(g, pad, yy, bw, barH, 12 * u); g.clip(); g.fillStyle = sh; g.fillRect(pad, yy, bw, barH); g.restore();
      }
    }
    // number chip + label + keyword, percent + count on the right
    g.textBaseline = 'middle';
    const chip = 30 * u;
    rr(g, pad + 8 * u, yy + (barH - chip) / 2, chip, chip, 8 * u); g.fillStyle = '#0a0716cc'; g.fill();
    g.font = `900 ${Math.round(18 * u)}px ${FONT}`; g.textAlign = 'center'; g.fillStyle = '#fff'; g.fillText(isWin ? '👑' : String(i + 1), pad + 8 * u + chip / 2, yy + barH / 2 + 1);
    const pct = v.total ? Math.round((o.votes / v.total) * 100) : 0;
    g.font = `800 ${Math.round(20 * u)}px ${FONT}`; g.textAlign = 'right';
    const right = `${pct}%  ·  ${o.votes}`;
    g.lineWidth = 4 * u; g.strokeStyle = '#000a'; g.strokeText(right, W - pad - 12 * u, yy + barH / 2 + 1); g.fillStyle = '#fff'; g.fillText(right, W - pad - 12 * u, yy + barH / 2 + 1);
    const rw = g.measureText(right).width;
    g.font = `800 ${Math.round(22 * u)}px ${FONT}`; g.textAlign = 'left';
    const kw = o.keyword && o.keyword !== o.label.toLowerCase() ? `  “${o.keyword}”` : '';
    const lab = fit(g, o.label + kw, W - pad * 2 - chip - rw - 40 * u);
    g.strokeText(lab, pad + chip + 20 * u, yy + barH / 2 + 1); g.fillStyle = '#fff'; g.fillText(lab, pad + chip + 20 * u, yy + barH / 2 + 1);
    g.globalAlpha = 1;
  });
  // footer: how to vote / the winner
  const fy = y + n * rowH + 4 * u;
  g.textBaseline = 'middle'; g.textAlign = 'left';
  if (ended) {
    const s = 0.8 + 0.2 * Math.min(1, rv * 1.4) + (rv < 1 ? 0.12 * Math.sin(rv * Math.PI) : 0);
    g.font = `900 ${Math.round(26 * u * s)}px ${FONT}`; g.fillStyle = '#ffd24a';
    g.shadowColor = '#ffb300'; g.shadowBlur = 16 * u * rv;
    g.fillText(fit(g, v.winner.length ? `🏆 WINNER: ${winnerText(v)}${v.total ? ` · ${Math.round((v.options[v.winner[0]].votes / v.total) * 100)}%` : ''}` : 'No votes this time', W - pad * 2), pad, fy + 14 * u);
    g.shadowBlur = 0;
  } else {
    const kws = v.options.some((o) => o.keyword);
    g.font = `600 ${Math.round(17 * u)}px ${FONT}`; g.fillStyle = '#a79fce';
    g.fillText(fit(g, `Type 1–${n}${kws ? ', !vote 2 or the word' : ' or !vote 2'} · one vote each${v.subDouble ? ' · subs ×2' : ''}${v.donationVotes ? ' · tips naming an option add votes' : ''}`, W - pad * 2), pad, fy + 14 * u);
  }
  // "+N votes" pulses rising from the total
  for (const p of st.pulses) {
    const a = (now - p.at) / 1400;
    if (a >= 1) continue;
    g.globalAlpha = 1 - a;
    g.font = `900 ${Math.round(18 * u)}px ${FONT}`; g.textAlign = 'right'; g.fillStyle = '#7dff8a';
    g.fillText(`+${p.n}`, cx - R - 14 * u, cy + 26 * u - a * 30 * u);
  }
  g.globalAlpha = 1;
  // confetti on the reveal
  if (ended && st.revealAt > 1 && now - st.revealAt < 3200) {
    const t = (now - st.revealAt) / 1000;
    for (let k = 0; k < 46; k++) {
      const sx = ((k * 97) % 100) / 100, sp = 0.6 + ((k * 37) % 50) / 60;
      const px = W * sx + Math.sin(t * 3 + k) * 20 * u, py = -10 * u + (t * sp * 260 - ((k * 13) % 40)) * u;
      if (py < 0 || py > H) continue;
      g.save(); g.translate(px, py); g.rotate(t * 5 + k); g.globalAlpha = Math.max(0, 1 - t / 3.2);
      g.fillStyle = COLS[k % COLS.length]; g.fillRect(-5 * u, -3 * u, 10 * u, 6 * u); g.restore();
    }
  }
  g.restore();
}

// (the winner sting plays in the studio: src/audio/mixer/showSounds.ts — OBS pages are silent)

/** Where the compositor wants the card (see StageCompositor.pollWorld / pollAvoid). */
export interface PollPlacement { pollWorld: 'monitor' | 'board' | null; pollAvoid(): PRect[] }

/** The docked card (a canvas over the page) — hidden while the card is in the world. */
export class PollOverlay {
  readonly canvas = document.createElement('canvas');
  private g = this.canvas.getContext('2d')!;
  private alpha = 0;
  private rect: PRect | null = null;
  private lastDraw = 0;
  /** Debug / tests: where the card is. */
  where: 'hidden' | 'world' | 'docked' = 'hidden';

  constructor() {
    const c = this.canvas;
    c.id = 'vtp-poll';
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:30;opacity:0;transform-origin:top left;';
    document.body.append(c);
  }

  update(dt: number, place: PollPlacement | null, now = Date.now()) {
    const on = pollStore.active(now);
    pollStore.world = on && place?.pollWorld ? place.pollWorld : null;
    const docked = on && !pollStore.world;
    this.where = !on ? 'hidden' : pollStore.world ? 'world' : 'docked';
    const vw = window.innerWidth || 1920, vh = window.innerHeight || 1080;
    if (docked) {
      const n = pollStore.view!.options.length;
      const w = 0.27, h = (w * vw * (pollCardHeight(720, n) / 720)) / vh;
      const r = pickPollDock(place?.pollAvoid() ?? [], w, h, this.rect);
      if (r) this.rect = r;
      else this.rect = null;             // nowhere free: never cover a face / screen — fade out
    }
    const want = docked && this.rect ? 1 : 0;
    this.alpha += (want - this.alpha) * (1 - Math.exp(-dt * 9));
    if (this.alpha < 0.01 && !want) { if (this.canvas.style.opacity !== '0') this.canvas.style.opacity = '0'; return; }
    const r = this.rect;
    if (!r) { this.canvas.style.opacity = '0'; this.alpha = 0; return; }
    const W = Math.round(r.w * vw), H = Math.round(r.h * vh);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr);
      this.canvas.style.width = `${W}px`; this.canvas.style.height = `${H}px`;
    }
    this.canvas.style.left = `${Math.round(r.x * vw)}px`; this.canvas.style.top = `${Math.round(r.y * vh)}px`;
    this.canvas.style.opacity = this.alpha.toFixed(3);
    this.canvas.style.transform = `scale(${(0.94 + 0.06 * this.alpha).toFixed(3)})`;
    if (now - this.lastDraw < 33) return;   // ≤ 30 fps
    this.lastDraw = now;
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    drawPoll(g, this.canvas.width, this.canvas.height, now);
  }
}

/** ?pollDemo=live|reveal on TEST pages only: a local fake poll (no server, no sound) for screenshots. */
export function pollDemo(kind: string) {
  const t0 = Date.now();
  const opts = [{ label: 'Pizza', keyword: 'pizza' }, { label: 'Tacos', keyword: 'tacos' }, { label: 'Sushi', keyword: '' }, { label: 'Frog legs', keyword: 'frog' }];
  const base = [41, 27, 12, 19];
  const tick = () => {
    const k = Math.min(1, (Date.now() - t0) / 6000);
    const votes = base.map((b, i) => Math.round(b * k + (i === 0 ? 0 : 0)));
    const total = votes.reduce((a, b) => a + b, 0);
    const ended = kind === 'reveal' && k >= 1;
    pollStore.set({ id: 'demo', question: 'What should the frog eat tonight?', options: opts.map((o, i) => ({ ...o, votes: votes[i], voters: votes[i], bonus: 0 })), total, voters: total,
      startedAt: t0, endsAt: t0 + 90_000, endedAt: ended ? Date.now() : 0, state: ended ? 'ended' : 'live', winner: ended ? [0] : [], shown: true,
      byPlatform: { twitch: 30, youtube: 40, kick: 29 }, subDouble: true, donationVotes: true, pulse: ended ? 0 : 3 });
    if (!ended) setTimeout(tick, 500);
  };
  tick();
}
