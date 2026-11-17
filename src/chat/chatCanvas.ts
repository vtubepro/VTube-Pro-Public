// In-world chat / support screens drawn on an offscreen canvas → THREE.CanvasTexture. Redrawn ONLY when the feed or
// the options change (≤ 15 Hz while a new line slides in / an alert animates); idle = no work, no texture upload.
//
// Layouts: 'monitor' (portrait, the hanging chat monitor), 'tablet' (Sprocket's tablet, compact + big text),
// 'board' (the neon support board: goal bar, recent supporters, big alert card).
// Tablet: its canvas grows with the tablet's size (SceneChatState.tablet, resize()) while the text keeps its size on
// the tablet (`textScale` = tabletText / tablet) — a bigger tablet shows more lines, never blurrier ones.
// Readable at 1080p: bold 30 px+ text with an outline on a dark panel, names in their colour, platform icons, badges,
// inline emotes (remote images through /api/chat/img so the canvas never gets tainted), support cards in tier colours.
import * as THREE from 'three';
import { chatVisible, PLATFORM_COLORS, type ChatEvent, type ChatPart, type ChatTotals, type SceneChatState } from '../../shared/chat.ts';
import type { ChatFeed } from './feed.ts';
import { drawPoll, pollStore } from '../poll/pollCard.ts';
import { emoteFrame, onEmoteAnimReady } from './emoteAnim.ts';
import { productWorld } from '../support/productCard.ts';
import { goalsStore } from '../goals/goalsStore.ts';
import { liveTarget } from '../../shared/goalsView.ts';
import { fmtMetric } from '../../shared/goals.ts';
import { beginName, endName, nameStyleFor } from './nameStyle.ts';

export type ChatLayout = 'monitor' | 'tablet' | 'board';

const FONT = '"Segoe UI", Inter, system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
const MAX_HZ = 15;

// ---------------------------------------------------------------- emote images (shared by every canvas)
const images = new Map<string, HTMLImageElement | null>();
const waiting = new Set<() => void>();
function emoteImage(url: string): HTMLImageElement | null {
  let im = images.get(url);
  if (im !== undefined) return im && im.complete && im.naturalWidth ? im : null;
  if (images.size > 400) images.clear();
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => { for (const f of waiting) f(); };
  img.onerror = () => { images.set(url, null); };
  img.src = emoteSrc(url);
  images.set(url, img);
  return null;
}
const emoteSrc = (url: string) => (url.startsWith('/') ? url : `/api/chat/img?u=${encodeURIComponent(url)}`);
/** Animated emotes redraw the screen at this rate (src/chat/emoteAnim.ts), a little under the alert / slide-in rate. */
const ANIM_HZ = 12;

// ---------------------------------------------------------------- colour helpers
const PALETTE = ['#ff7eb6', '#7ee0ff', '#ffd166', '#9bff8a', '#c3a6ff', '#ffab76', '#6fffd6', '#ff9aa2', '#b8f35d', '#8fb8ff'];
function nameColor(e: ChatEvent): string {
  let c = e.color;
  if (!c) { let h = 7; for (const ch of e.user.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0; c = PALETTE[h % PALETTE.length]; }
  const col = new THREE.Color(c);
  const lum = 0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b;
  if (lum < 0.32) col.lerp(new THREE.Color(1, 1, 1), 0.45);         // dark names stay readable on the dark panel
  return `#${col.getHexString()}`;
}
const inkFor = (bg: string) => { const c = new THREE.Color(bg); return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b > 0.55 ? '#0b0f14' : '#ffffff'; };

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Are two #rrggbb colours close (a badge that would melt into the card behind it)? */
const nearColor = (a: string, b: string) => { const v = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); const [p, q] = [v(a), v(b)]; return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.35; };

/** Platform glyph (vector — no remote logos). `on`: the colour it sits on, when that is a coloured card. */
function platformIcon(g: CanvasRenderingContext2D, p: string, x: number, y: number, s: number, on?: string) {
  g.save();
  g.translate(x, y);
  const c = PLATFORM_COLORS[p as keyof typeof PLATFORM_COLORS] ?? '#888';
  if (p === 'youtube') {
    g.fillStyle = c; roundRect(g, 0, s * 0.14, s, s * 0.72, s * 0.2); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(s * 0.4, s * 0.32); g.lineTo(s * 0.4, s * 0.68); g.lineTo(s * 0.7, s * 0.5); g.closePath(); g.fill();
  } else if (p === 'kick') {
    g.fillStyle = '#0b0f0a'; roundRect(g, 0, 0, s, s, s * 0.18); g.fill();
    g.fillStyle = c;
    const u = s / 7;
    // blocky K (Kick's pixel glyph)
    for (const [cx, cy, w, h] of [[1, 1, 1.6, 5], [2.6, 2.4, 1.2, 1.2], [3.8, 1.2, 1.4, 1.2], [3.8, 4.6, 1.4, 1.2], [2.6, 3.4, 1.2, 1.2]] as const) g.fillRect(cx * u, cy * u, w * u, h * u);
  } else if (p === 'twitch') {
    // Twitch: the white Glitch (speech bubble with a tail, two eyes) on a Twitch-purple badge, the way YouTube and
    // Rumble put a white glyph on their colour. On a purple card (bits / raid tiers) the badge would melt into the card,
    // so there it flips: a white badge with a purple Glitch. 24-unit grid, centred.
    const inv = !!on && nearColor(on, c);
    g.fillStyle = inv ? '#fff' : c; roundRect(g, 0, 0, s, s, s * 0.2); g.fill();
    const k = (s * 0.7) / 24, o = s * 0.15;
    const poly = (pts: number[]) => { g.moveTo(o + pts[0] * k, o + pts[1] * k); for (let i = 2; i < pts.length; i += 2) g.lineTo(o + pts[i] * k, o + pts[i + 1] * k); g.closePath(); };
    g.fillStyle = inv ? c : '#fff'; g.beginPath();
    poly([6, 0, 22.3, 0, 22.3, 12.2, 14.6, 19.8, 11.2, 19.8, 6.9, 24, 6.9, 19.8, 1.7, 19.8, 1.7, 4.3]);   // the bubble
    poly([6.9, 2.1, 20.2, 2.1, 20.2, 11.3, 16.9, 14.6, 13.6, 14.6, 10.6, 17.5, 10.6, 14.6, 6.9, 14.6]); // its screen (a hole)
    g.fill('evenodd');
    g.fillRect(o + 11.4 * k, o + 5 * k, 2.1 * k, 5 * k); g.fillRect(o + 16.1 * k, o + 5 * k, 2.1 * k, 5 * k);   // the eyes
  } else if (p === 'rumble') {
    g.fillStyle = c; g.beginPath(); g.ellipse(s / 2, s / 2, s * 0.5, s * 0.46, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(s * 0.38, s * 0.28); g.lineTo(s * 0.38, s * 0.72); g.lineTo(s * 0.74, s * 0.5); g.closePath(); g.fill();
  } else {
    g.fillStyle = c; g.beginPath(); g.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#111'; g.font = `800 ${s * 0.6}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('T', s / 2, s * 0.54);
  }
  g.restore();
}

const BADGE: Record<string, [string, string]> = {
  broadcaster: ['★', '#e91916'], moderator: ['MOD', '#00ad03'], vip: ['VIP', '#e005b9'], subscriber: ['SUB', '#7c4dff'], member: ['MEM', '#2ba640'],
  founder: ['FDR', '#ff9800'], og: ['OG', '#d4a017'], verified: ['✔', '#3ea6ff'], staff: ['STAFF', '#00c8ff'], premium: ['PRE', '#85c742'], admin: ['ADM', '#e91916'],
};

interface Tok { k: 'w' | 'sp' | 'em'; v: string; w: number; url?: string; /** 7TV zero-width: drawn over the emote before it */ zw?: boolean }
interface LaidOut { lines: Tok[][]; h: number; key: string }

export class ChatCanvas {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  /** Tablet only: text size relative to the canvas width (tabletText / tablet size); header + margins follow the
   *  tablet size only. 1 = the classic 640 × 480 tablet. */
  textScale = 1;
  headScale = 1;
  /** Width the text size is measured on (0 = the canvas width). An upright tablet keeps its landscape text size. */
  textRefW = 0;
  private g: CanvasRenderingContext2D;
  private drawnRev = -1;
  private optKey = '';
  private lastDraw = 0;
  private dirty = true;
  private appear = new Map<string, number>();
  private layoutCache = new Map<string, LaidOut>();
  /** Current alert (board / monitor support strip): the event + when it started (epoch ms). */
  alert: { e: ChatEvent; at: number } | null = null;
  /** Connection lights in the header (platform → live). */
  live: Record<string, boolean> = {};
  private wake = () => { this.dirty = true; };
  /** The last draw showed an animated emote: keep redrawing (≤ ANIM_HZ) while it is on the screen. */
  private animEmotes = false;
  private drawNow = 0;

  constructor(readonly layout: ChatLayout, public W: number, public H: number) {
    this.canvas.width = W; this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.generateMipmaps = true;
    waiting.add(this.wake);
    onEmoteAnimReady(this.wake);
  }

  /** New canvas size (tablet size changes): a fresh texture upload at the next redraw. */
  resize(W: number, H: number) {
    W = Math.round(W); H = Math.round(H);
    if (W === this.W && H === this.H) return;
    this.W = W; this.H = H;
    this.canvas.width = W; this.canvas.height = H;
    this.texture.dispose();                          // the GPU copy has the old size: re-allocate on the next upload
    this.layoutCache.clear();
    this.dirty = true;
    this.lastDraw = 0;
  }

  /** Chat text size (canvas px) — how big the text is on the tablet (readability checks). */
  textPx(font = 1): number {
    const tab = this.layout === 'tablet';
    return Math.round(29 * (tab ? 1.65 * this.textScale : 1) * font * ((this.textRefW || this.W) / 600));
  }

  /** Redraw if something changed (returns true when the texture was updated). */
  update(feed: ChatFeed, st: SceneChatState, now = Date.now()): boolean {
    // a chat poll shown in the world takes this screen over (src/poll/pollCard.ts); the chat comes back after it
    if (this.layout !== 'tablet' && pollStore.world === this.layout && pollStore.active(now)) {
      if (now - this.lastDraw < 50) return false;
      this.lastDraw = now; this.dirty = true;
      this.g.setTransform(1, 0, 0, 1, 0, 0); this.g.clearRect(0, 0, this.W, this.H);
      drawPoll(this.g, this.W, this.H, now, true);   // fills the screen (text scales to fit its height)
      this.texture.needsUpdate = true;
      return true;
    }
    // the product showcase on the support board (src/support/productCard.ts), when it is up in this shot
    if (this.layout === 'board' && now - this.lastDraw >= 50 && productWorld(this.g, this.W, this.H, now)) {
      this.lastDraw = now; this.dirty = true; this.texture.needsUpdate = true;
      return true;
    }
    // (the 15 Hz cap first: it returns false whether or not anything changed and touches no state, so the option key below is only built at the cap rate)
    if (now - this.lastDraw < 1000 / MAX_HZ) return false;
    const optKey = `${st.font}|${this.textScale}|${this.headScale}|${this.W}|${this.H}|${this.textRefW}|${st.hideBots}|${st.hideCommands}|${st.bots.join(',')}|${st.converted}|${st.goal.on}|${st.goal.target}|${st.goal.label}|${goalsStore.rev}|${st.panel}|${JSON.stringify(this.live)}`;
    const anim = this.animating(now);
    const emoteAnim = this.animEmotes && now - this.lastDraw >= 1000 / ANIM_HZ;
    if (!this.dirty && feed.rev === this.drawnRev && optKey === this.optKey && !anim && !emoteAnim) return false;
    this.drawnRev = feed.rev; this.optKey = optKey; this.dirty = false; this.lastDraw = now;
    this.animEmotes = false; this.drawNow = now;
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.W, this.H);
    if (this.layout === 'board') this.drawBoard(feed, st, now);
    else this.drawChat(feed, st, now);
    this.texture.needsUpdate = true;
    return true;
  }

  /** An emote at (x, middle of the line y), `w` wide: its animated frame once decoded, else the still image
   *  (false = not loaded yet). */
  private drawEmote(url: string, x: number, y: number, w: number): boolean {
    const fr = emoteFrame(emoteSrc(url), this.drawNow || Date.now());
    if (fr) { this.g.drawImage(fr.img, x, y - w * 0.5, w, w * Math.min(1.4, fr.h / Math.max(1, fr.w))); this.animEmotes = true; return true; }
    const im = emoteImage(url);
    if (!im) return false;
    this.g.drawImage(im, x, y - w * 0.5, w, w * Math.min(1.4, im.naturalHeight / Math.max(1, im.naturalWidth)));
    return true;
  }

  private animating(now: number) {
    if (this.alert && now - this.alert.at < 9000) return true;
    for (const t of this.appear.values()) if (now - t < 450) return true;
    return false;
  }

  // ---------------------------------------------------------------- chat (monitor + tablet)
  private drawChat(feed: ChatFeed, st: SceneChatState, now: number) {
    const g = this.g, W = this.W, H = this.H;
    const tab = this.layout === 'tablet';
    const fs = this.textPx(st.font), lh = Math.round(fs * 1.28);   // tablet: big cel-style text, the latest lines that fit
    const u = ((this.textRefW || W) / 600) * (tab ? this.headScale : 1);   // header / margins: same size on any tablet
    const pad = Math.round(18 * u);
    // panel background
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0b1018'); bg.addColorStop(1, '#101a26');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    // header
    const hh = Math.round((tab ? 52 : 62) * u);
    const hg = g.createLinearGradient(0, 0, W, 0);
    hg.addColorStop(0, '#16263a'); hg.addColorStop(1, '#0f1b2a');
    g.fillStyle = hg; g.fillRect(0, 0, W, hh);
    g.fillStyle = '#35e3ff'; g.fillRect(0, hh - 3, W, 3);
    g.font = `900 ${Math.round(hh * 0.5)}px ${FONT}`; g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillStyle = '#ff3b5c'; g.beginPath(); g.arc(pad + hh * 0.16, hh / 2, hh * 0.14, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e8f6ff'; g.fillText(tab ? 'CHAT' : 'LIVE CHAT', pad + hh * 0.42, hh / 2 + 1);
    let ix = W - pad - hh * 0.55;
    for (const p of ['youtube', 'rumble', 'kick', 'twitch']) {
      if (p === 'twitch' && this.live.twitch !== true) continue;   // Twitch joins the lights only while connected (rooms without it look as before)
      g.globalAlpha = this.live[p] === false ? 0.25 : 1;
      platformIcon(g, p, ix, hh * 0.22, hh * 0.56);
      ix -= hh * 0.7;
    }
    g.globalAlpha = 1;
    let top = hh + pad * 0.5;
    // support strip (panel shown on the monitor)
    if (!tab && st.panel === 'monitor') top = this.drawSupportStrip(feed, st, now, top, pad, fs);
    // messages, newest at the bottom
    const list = feed.events.filter((e) => chatVisible(e, st)).slice(-40);
    const maxW = W - pad * 2;
    const items: { e: ChatEvent; lay: LaidOut; h: number }[] = [];
    let total = 0;
    for (let i = list.length - 1; i >= 0 && total < H; i--) {
      const e = list[i];
      if (!this.appear.has(e.id)) this.appear.set(e.id, feed.rev > 1 && now - e.ts < 4000 ? now : 0);
      const lay = e.kind === 'finance' ? this.layFinance(e, maxW, fs, lh) : this.layLine(e, maxW, fs, lh);
      const h = lay.h + Math.round(lh * 0.28);
      items.push({ e, lay, h }); total += h;
    }
    if (this.appear.size > 200) for (const k of [...this.appear.keys()].slice(0, 100)) this.appear.delete(k);
    let y = H - pad * 0.6;
    // slide: the newest item's entrance lifts everything
    const newest = items[0];
    const k0 = newest ? Math.min(1, (now - (this.appear.get(newest.e.id) || 0)) / 260) : 1;
    const lift = newest ? (1 - easeOut(k0)) * newest.h : 0;
    g.save();
    g.beginPath(); g.rect(0, top, W, H - top); g.clip();
    for (const it of items) {
      y -= it.h;
      const yy = y + lift;
      if (yy + it.h < top) break;
      const a = it === newest ? 0.35 + 0.65 * k0 : 1;
      g.globalAlpha = a;
      if (it.e.kind === 'finance') this.drawFinance(it.e, it.lay, pad, yy, maxW, fs, lh, st);
      else this.drawLine(it.e, it.lay, pad, yy, fs, lh);
    }
    g.restore();
    g.globalAlpha = 1;
    // fade the oldest lines under the header
    const fade = g.createLinearGradient(0, top, 0, top + lh * 2.2);
    fade.addColorStop(0, '#0b1018'); fade.addColorStop(1, 'rgba(11,16,24,0)');
    g.fillStyle = fade; g.fillRect(0, top, W, lh * 2.2);
    if (!items.length) {
      g.fillStyle = '#5f7489'; g.font = `600 ${fs}px ${FONT}`; g.textAlign = 'center';
      g.fillText('Waiting for chat…', W / 2, (top + H) / 2);
    }
  }

  /** Top strip on the monitor (support board "on the monitor"): the goal + the alert card while one is playing. */
  private drawSupportStrip(feed: ChatFeed, st: SceneChatState, now: number, top: number, pad: number, fs: number): number {
    const g = this.g, W = this.W;
    const al = this.alert && now - this.alert.at < 8000 ? this.alert : null;
    if (al) {
      const h = Math.round(fs * 3.3);
      const k = Math.min(1, (now - al.at) / 300);
      const e = al.e, tier = e.tier ?? '#ffd84a';
      g.save();
      g.globalAlpha = k;
      const pulse = 0.5 + 0.5 * Math.sin((now - al.at) / 110);
      g.shadowColor = tier; g.shadowBlur = 16 + 18 * pulse;
      g.fillStyle = tier; roundRect(g, pad, top + 4, W - pad * 2, h, 14); g.fill();
      g.shadowBlur = 0;
      const ink = inkFor(tier);
      g.fillStyle = ink; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      g.font = `900 ${Math.round(fs * 1.05)}px ${FONT}`;
      this.fitText(`${e.user}`, pad + 16, top + 4 + fs * 1.25, W - pad * 2 - 32);
      g.font = `800 ${Math.round(fs * 0.9)}px ${FONT}`;
      this.fitText(`${amountText(e, st)}  ·  ${e.label ?? ''}`, pad + 16, top + 4 + fs * 2.35, W - pad * 2 - 32);
      g.restore();
      return top + h + 14;
    }
    if (goalLine(feed.totals, st)) return this.drawGoal(feed.totals, st, pad, top + 6, W - pad * 2, Math.round(fs * 1.25)) + 10;
    return top;
  }

  private tokens(e: ChatEvent, fs: number): Tok[] {
    const g = this.g;
    const parts: ChatPart[] = e.parts ?? [{ t: 'text', v: e.text }];
    const out: Tok[] = [];
    for (const p of parts) {
      if (p.t === 'emote') {
        if (p.zw && out[out.length - 1]?.k === 'em') { out.push({ k: 'em', v: p.n, w: 0, url: p.u, zw: true }); continue; }
        out.push({ k: 'em', v: p.n, w: fs * 1.25, url: p.u }); continue;
      }
      for (const w of p.v.split(/(\s+)/)) {
        if (!w) continue;
        if (/^\s+$/.test(w)) out.push({ k: 'sp', v: ' ', w: g.measureText(' ').width });
        else out.push({ k: 'w', v: w, w: g.measureText(w).width });
      }
    }
    return out;
  }

  /** Word-wrap a chat line: [icon][badges] Name: message … */
  private layLine(e: ChatEvent, maxW: number, fs: number, lh: number): LaidOut {
    const key = `${e.id}|${maxW}|${fs}`;
    const c = this.layoutCache.get(key);
    if (c) return c;
    const g = this.g;
    g.font = `800 ${fs}px ${FONT}`;
    const nameW = g.measureText(e.kind === 'system' ? `${e.user} ` : `${e.user}: `).width;
    const head = fs * 1.15 + this.badgesWidth(e, fs) + nameW + (e.kind !== 'system' && (nameStyleFor(e)?.badge ?? 'none') !== 'none' ? fs * 1.05 : 0);   // (+ a supporter badge: src/chat/nameStyle.ts)
    g.font = `600 ${fs}px ${FONT}`;
    const toks = this.tokens(e, fs);
    const lines: Tok[][] = [[{ k: 'sp', v: '', w: head }]];
    let x = head;
    for (const t of toks) {
      if (t.k === 'sp' && x === 0) continue;
      if (x + t.w > maxW && x > 0 && t.k !== 'sp') {
        if (t.w > maxW) {           // a monster word: hard-break it
          let s = t.v;
          while (s) {
            let n = s.length;
            while (n > 1 && g.measureText(s.slice(0, n)).width > maxW - x) n--;
            lines[lines.length - 1].push({ k: 'w', v: s.slice(0, n), w: g.measureText(s.slice(0, n)).width });
            s = s.slice(n);
            if (s) { lines.push([]); x = 0; } else x += g.measureText(lines[lines.length - 1].slice(-1)[0].v).width;
            if (lines.length > 6) break;
          }
          continue;
        }
        lines.push([]); x = 0;
      }
      lines[lines.length - 1].push(t); x += t.w;
      if (lines.length > 6) break;
    }
    const cap = this.layout === 'tablet' ? 3 : 6;
    const out = { lines: lines.slice(0, cap), h: Math.min(cap, lines.length) * lh, key };
    if (this.layoutCache.size > 300) this.layoutCache.clear();
    this.layoutCache.set(key, out);
    return out;
  }

  private badgesWidth(e: ChatEvent, fs: number) {
    let w = 0;
    this.g.font = `800 ${Math.round(fs * 0.52)}px ${FONT}`;
    for (const b of (e.badges ?? []).slice(0, 3)) { const d = BADGE[b]; if (d) w += this.g.measureText(d[0]).width + fs * 0.42; }
    return w;
  }
  private drawBadges(e: ChatEvent, x: number, y: number, fs: number): number {
    const g = this.g;
    for (const b of (e.badges ?? []).slice(0, 3)) {
      const d = BADGE[b];
      if (!d) continue;
      g.font = `800 ${Math.round(fs * 0.52)}px ${FONT}`;
      const w = g.measureText(d[0]).width + fs * 0.3;
      g.fillStyle = d[1]; roundRect(g, x, y + fs * 0.12, w, fs * 0.78, fs * 0.16); g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(d[0], x + w / 2, y + fs * 0.53);
      x += w + fs * 0.12;
    }
    return x;
  }

  private drawLine(e: ChatEvent, lay: LaidOut, x0: number, y: number, fs: number, lh: number) {
    const g = this.g;
    const sys = e.kind === 'system';
    if (e.mention || e.vip) {
      g.fillStyle = e.mention ? 'rgba(255,196,0,0.16)' : 'rgba(224,5,185,0.12)';
      roundRect(g, x0 - 8, y - 4, this.W - x0 * 2 + 16, lay.h + 6, 10); g.fill();
      g.fillStyle = e.mention ? '#ffc400' : '#e005b9'; g.fillRect(x0 - 8, y - 2, 4, lay.h + 2);
    }
    platformIcon(g, e.platform, x0, y + (lh - fs * 0.95) / 2, fs * 0.95);
    let x = x0 + fs * 1.15;
    x = this.drawBadges(e, x, y + (lh - fs) / 2, fs);
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.font = `800 ${fs}px ${FONT}`;
    const name = sys ? `${e.user} ` : `${e.user}: `;
    const ns = sys ? null : nameStyleFor(e);   // supporter name effect (src/chat/nameStyle.ts): badge, glow, colour
    if (ns) x = beginName(g, ns, x, y + lh / 2, fs);
    g.lineWidth = fs * (this.layout === 'tablet' ? 0.24 : 0.16); g.strokeStyle = this.layout === 'tablet' ? '#000' : 'rgba(0,0,0,0.75)'; g.strokeText(name, x, y + lh / 2);
    g.fillStyle = sys ? '#ffd84a' : ns?.color || nameColor(e); g.fillText(name, x, y + lh / 2);
    if (ns) endName(g);
    g.font = `${sys ? 'italic 600' : '600'} ${fs}px ${FONT}`;
    lay.lines.forEach((line, li) => {
      let lx = li === 0 ? x0 : x0;
      const ly = y + li * lh + lh / 2;
      let lastEm = { x: lx, w: 0 };
      for (const t of line) {
        if (t.k === 'em') {
          if (t.zw) { this.drawEmote(t.url!, lastEm.x, ly, lastEm.w); continue; }
          if (!this.drawEmote(t.url!, lx, ly, t.w)) { g.fillStyle = '#9fb3c8'; g.fillText(t.v, lx, ly); }
          lastEm = { x: lx, w: t.w };
        } else if (t.k === 'w') {
          g.strokeText(t.v, lx, ly);
          g.fillStyle = sys ? '#ffe9a6' : '#f2f6fa'; g.fillText(t.v, lx, ly);
        }
        lx += t.w;
      }
    });
  }

  // ---------------------------------------------------------------- support cards
  private layFinance(e: ChatEvent, maxW: number, fs: number, lh: number): LaidOut {
    const key = `f|${e.id}|${maxW}|${fs}`;
    const c = this.layoutCache.get(key);
    if (c) return c;
    const g = this.g;
    g.font = `600 ${Math.round(fs * 0.92)}px ${FONT}`;
    const toks = e.text ? this.tokens(e, Math.round(fs * 0.92)) : [];
    const inner = maxW - 28;
    const lines: Tok[][] = [];
    let x = 0;
    for (const t of toks) {
      if (!lines.length) lines.push([]);
      if (x + t.w > inner && x > 0) { lines.push([]); x = 0; if (t.k === 'sp') continue; }
      lines[lines.length - 1].push(t); x += t.w;
      if (lines.length > 4) break;
    }
    const out = { lines: lines.slice(0, 4), h: Math.round(lh * 1.3) + Math.min(4, lines.length) * Math.round(lh * 0.92) + 14, key };
    this.layoutCache.set(key, out);
    return out;
  }

  private drawFinance(e: ChatEvent, lay: LaidOut, x0: number, y: number, maxW: number, fs: number, lh: number, st: SceneChatState) {
    const g = this.g;
    const tier = e.tier ?? '#ffd84a';
    const head = Math.round(lh * 1.3);
    // header band in the tier colour, body a darker shade (YouTube Super Chat style)
    const dark = new THREE.Color(tier).multiplyScalar(0.42);
    g.fillStyle = `#${dark.getHexString()}`; roundRect(g, x0, y, maxW, lay.h, 14); g.fill();
    g.save(); roundRect(g, x0, y, maxW, lay.h, 14); g.clip();
    g.fillStyle = tier; g.fillRect(x0, y, maxW, head);
    g.restore();
    const ink = inkFor(tier);
    platformIcon(g, e.platform, x0 + 12, y + (head - fs) / 2, fs, tier);
    g.textBaseline = 'middle'; g.textAlign = 'left';
    g.font = `900 ${fs}px ${FONT}`; g.fillStyle = ink;
    const amt = amountText(e, st);
    const aw = g.measureText(amt).width;
    g.textAlign = 'right'; g.fillText(amt, x0 + maxW - 14, y + head / 2 + 1);
    g.textAlign = 'left';
    g.font = `800 ${Math.round(fs * 0.95)}px ${FONT}`;
    this.fitText(e.user, x0 + 14 + fs * 1.15, y + head / 2 + 1, maxW - aw - fs * 1.9 - 28);
    let ly = y + head + Math.round(lh * 0.46) + 4;
    g.font = `700 ${Math.round(fs * 0.62)}px ${FONT}`;
    g.fillStyle = '#ffffffcc';
    const label = (e.label ?? '').toUpperCase() + (e.recipients?.length ? ` → ${e.recipients.slice(0, 4).join(', ')}${e.recipients.length > 4 ? ` +${e.recipients.length - 4}` : ''}` : '');
    if (!lay.lines.length) { this.fitText(label, x0 + 14, ly, maxW - 28); return; }
    g.font = `600 ${Math.round(fs * 0.92)}px ${FONT}`;
    for (const line of lay.lines) {
      let lx = x0 + 14;
      for (const t of line) {
        if (t.k === 'em') { if (t.zw) continue; this.drawEmote(t.url!, lx, ly, t.w); }
        else if (t.k === 'w') { g.fillStyle = '#ffffff'; g.fillText(t.v, lx, ly); }
        lx += t.w;
      }
      ly += Math.round(lh * 0.92);
    }
  }

  private fitText(s: string, x: number, y: number, maxW: number) {
    const g = this.g;
    if (g.measureText(s).width <= maxW) { g.fillText(s, x, y); return; }
    let n = s.length;
    while (n > 1 && g.measureText(s.slice(0, n) + '…').width > maxW) n--;
    g.fillText(s.slice(0, n) + '…', x, y);
  }

  // ---------------------------------------------------------------- support board
  private drawGoal(t: ChatTotals | null, st: SceneChatState, x: number, y: number, w: number, h: number): number {
    const g = this.g;
    const line = goalLine(t, st)!;
    const k = Math.min(1, line.value / Math.max(1e-9, line.target));
    g.fillStyle = '#0a0f16'; roundRect(g, x, y, w, h, h / 2); g.fill();
    const gr = g.createLinearGradient(x, 0, x + w, 0);
    gr.addColorStop(0, '#35e3ff'); gr.addColorStop(1, '#b388ff');
    g.fillStyle = gr; roundRect(g, x, y, Math.max(h, w * k), h, h / 2); g.fill();
    g.strokeStyle = '#35e3ff88'; g.lineWidth = 2; roundRect(g, x, y, w, h, h / 2); g.stroke();
    g.font = `800 ${Math.round(h * 0.52)}px ${FONT}`; g.textBaseline = 'middle'; g.textAlign = 'center';
    g.lineWidth = 4; g.strokeStyle = '#000a';
    const s = line.text;
    g.strokeText(s, x + w / 2, y + h / 2 + 1); g.fillStyle = '#fff'; g.fillText(s, x + w / 2, y + h / 2 + 1);
    return y + h;
  }

  private drawBoard(feed: ChatFeed, st: SceneChatState, now: number) {
    const g = this.g, W = this.W, H = this.H;
    g.fillStyle = '#07060d'; g.fillRect(0, 0, W, H);
    // brushed back panel
    const bg = g.createRadialGradient(W / 2, H * 0.35, 20, W / 2, H * 0.5, W * 0.7);
    bg.addColorStop(0, '#1a1030'); bg.addColorStop(1, '#07060d');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const al = this.alert && now - this.alert.at < 8000 ? this.alert : null;
    // neon title
    const neon = (text: string, x: number, y: number, size: number, col: string, flick = 1) => {
      g.font = `900 ${size}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.shadowColor = col; g.shadowBlur = size * 0.5 * flick; g.fillStyle = col; g.fillText(text, x, y);
      g.shadowBlur = size * 0.2 * flick; g.fillStyle = '#ffffff'; g.globalAlpha = 0.85; g.fillText(text, x, y); g.globalAlpha = 1;
      g.shadowBlur = 0;
    };
    const flick = al ? 0.7 + 0.3 * Math.sin((now - al.at) / 60) : 1;
    neon('★ SUPPORT ★', W / 2, H * 0.12, Math.round(H * 0.12), al ? (al.e.tier ?? '#ff4fd8') : '#ff4fd8', flick);
    if (al) {
      const e = al.e, k = Math.min(1, (now - al.at) / 350), tier = e.tier ?? '#ffd84a';
      const s = 0.85 + 0.15 * easeOut(k);
      g.save();
      g.translate(W / 2, H * 0.58); g.scale(s, s); g.globalAlpha = k;
      const cw = W * 0.88, ch = H * 0.62;
      g.shadowColor = tier; g.shadowBlur = 40;
      g.fillStyle = '#120b20'; roundRect(g, -cw / 2, -ch / 2, cw, ch, 26); g.fill();
      g.shadowBlur = 0; g.lineWidth = 6; g.strokeStyle = tier; roundRect(g, -cw / 2, -ch / 2, cw, ch, 26); g.stroke();
      platformIcon(g, e.platform, -cw / 2 + 26, -ch / 2 + 26, H * 0.09);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `900 ${Math.round(H * 0.11)}px ${FONT}`; g.fillStyle = '#fff';
      this.fitCenter(e.user, 0, -ch * 0.24, cw - 60);
      g.font = `900 ${Math.round(H * 0.13)}px ${FONT}`; g.fillStyle = tier; g.shadowColor = tier; g.shadowBlur = 20;
      this.fitCenter(amountText(e, st), 0, -ch * 0.02, cw - 60);
      g.shadowBlur = 0;
      g.font = `800 ${Math.round(H * 0.05)}px ${FONT}`; g.fillStyle = '#ffffffcc';
      this.fitCenter((e.label ?? '').toUpperCase(), 0, ch * 0.16, cw - 60);
      if (e.text) { g.font = `600 ${Math.round(H * 0.055)}px ${FONT}`; g.fillStyle = '#fff'; this.fitCenter(`“${e.text}”`, 0, ch * 0.33, cw - 60); }
      g.restore();
      return;
    }
    // goal + recent supporters
    let y = H * 0.24;
    if (goalLine(feed.totals, st)) y = this.drawGoal(feed.totals, st, W * 0.06, y, W * 0.88, Math.round(H * 0.1)) + H * 0.04;
    const fin = feed.support.filter((e) => e.fkind !== 'raid').slice(-4).reverse();
    const rowH = (H * 0.94 - y) / 4;
    if (!fin.length) { g.font = `700 ${Math.round(H * 0.06)}px ${FONT}`; g.fillStyle = '#8a7fb0'; g.textAlign = 'center'; g.fillText('Be the first to support the stream!', W / 2, y + rowH * 1.5); }
    fin.forEach((e, i) => {
      const yy = y + i * rowH, tier = e.tier ?? '#ffd84a';
      g.globalAlpha = 1 - i * 0.14;
      g.fillStyle = '#ffffff0d'; roundRect(g, W * 0.06, yy + 4, W * 0.88, rowH - 8, 12); g.fill();
      g.fillStyle = tier; roundRect(g, W * 0.06, yy + 4, 8, rowH - 8, 4); g.fill();
      platformIcon(g, e.platform, W * 0.06 + 22, yy + rowH / 2 - rowH * 0.25, rowH * 0.5);
      g.textBaseline = 'middle'; g.textAlign = 'left';
      g.font = `800 ${Math.round(rowH * 0.42)}px ${FONT}`; g.fillStyle = '#fff';
      const amt = amountText(e, st);
      g.textAlign = 'right'; g.fillStyle = tier; g.fillText(amt, W * 0.93, yy + rowH / 2);
      const aw = g.measureText(amt).width;
      g.textAlign = 'left'; g.fillStyle = '#fff';
      this.fitText(e.user, W * 0.06 + 30 + rowH * 0.5, yy + rowH / 2, W * 0.87 - aw - rowH * 0.5 - 50);
    });
    g.globalAlpha = 1;
  }
  private fitCenter(s: string, x: number, y: number, maxW: number) {
    const g = this.g;
    let t = s;
    while (t.length > 2 && g.measureText(t).width > maxW) t = t.slice(0, -2);
    g.fillText(t === s ? s : t + '…', x, y);
  }

  dispose() { waiting.delete(this.wake); this.texture.dispose(); }
}

function easeOut(k: number) { return 1 - Math.pow(1 - Math.min(1, Math.max(0, k)), 3); }

/** "$5.00", "€10.00 (≈ $10.80)", "500 Kicks ($5.00)", "5 subs". */
export function amountText(e: ChatEvent, st: SceneChatState): string {
  const d = e.display ?? '';
  if (e.currency === 'kicks' && e.usd) return `${d}`;
  if (st.converted && e.approxUsd) return `${d} ≈$${e.approxUsd.toFixed(2)}`;
  return d || (e.label ?? '');
}

/** The support board's goal line: the goals engine's first shown goal (beta.13, src/goals/goalsStore.ts) filling towards
 *  its next stretch goal; with an older version the chat goal (Chat & events → Goal) and the session total, as before. */
function goalLine(t: ChatTotals | null, st: SceneChatState): { value: number; target: number; text: string } | null {
  const v = goalsStore.view;
  if (v) {
    const g = v.goals.find((x) => x.show);
    if (!g) return null;
    const { target } = liveTarget(g);
    return { value: g.value, target, text: `${g.title}  ${fmtMetric(g.value, g.metric, v.cur, true)} / ${fmtMetric(target, g.metric, v.cur)}` };
  }
  if (!st.goal.on) return null;
  const cur = t?.usd ?? 0;
  return { value: cur, target: Math.max(1, st.goal.target), text: `${st.goal.label}  $${cur.toFixed(2)} / $${st.goal.target.toFixed(0)}` };
}
