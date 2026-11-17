// VTube Pro capture covers (ship with the engine): three "loading into a game / plugging in" cards.
//   cc-cartridge  a retro cartridge gets blown on, clunks into the console, the pixel loading bar fills (pixel dissolve in / out)
//   cc-jackin     a neon cable jacks into a port, data rains, the handshake log runs (glowing wipe in / out)
//   cc-boot       PRESS START: a spinning disc, a boot chime ring, rotating loading tips (iris in / out)
import { SANS, clamp01, easeInOut, easeOut, easeOutBack, fitFont, glowText, rng, rr, seg, vtpMark } from '../transition/kit.ts';
import { X, Y, coverK, cyc, masked, type CoverFrame, type CoverStyleDef } from './kit.ts';

const MONO = `'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace`;
const G = '#7bd88f', B = '#6cc7f5';

function setSpacing(ctx: CanvasRenderingContext2D, px: number) { if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${px}px`; }

/** The host's line (or the style's) as a big centred caption. */
function caption(f: CoverFrame, text: string, y: number, size: number, color: string, family = SANS, weight = '800', maxW = 1500) {
  const { ctx, u } = f;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const s = fitFont(ctx, text, weight, size * u, family, Math.min(maxW * u, f.w * 0.92));
  ctx.font = `${weight} ${s}px ${family}`;
  ctx.fillStyle = color;
  ctx.fillText(text, f.w / 2, Y(f, y));
}

// ================================================================ 1. cartridge
const CART = { bg0: '#1a0f33', bg1: '#2c1658', grid: 'rgba(160,120,255,0.07)', body: '#b9b7c6', bodyDark: '#8d8a9e', ink: '#1b1530', red: '#ff4d6d' };

function cartridgeScene(f: CoverFrame) {
  const { ctx, w, h, u, th } = f;
  const t = f.t;
  // background: indigo gradient, pixel grid, twinkling pixel stars
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, CART.bg0); g.addColorStop(1, CART.bg1);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = CART.grid;
  const step = 24 * u;
  for (let x = (w / 2) % step; x < w; x += step) ctx.fillRect(x, 0, Math.max(1, u), h);
  for (let y = (h / 2) % step; y < h; y += step) ctx.fillRect(0, y, w, Math.max(1, u));
  const r = rng(91);
  for (let i = 0; i < 70; i++) {
    const sx = r() * w, sy = r() * h * 0.62, ph = r() * 6, sz = (r() < 0.2 ? 6 : 4) * u;
    const a = 0.25 + 0.75 * Math.max(0, Math.sin(t * 1.7 + ph));
    ctx.fillStyle = `rgba(255,255,255,${(a * 0.7).toFixed(3)})`;
    ctx.fillRect(Math.round(sx / sz) * sz, Math.round(sy / sz) * sz, sz, sz);
  }
  // loop: blow (0–.2) · line up (.2–.33) · insert (.33–.45) · CLUNK · loading bar (.5–.9) · eject (.9–1)
  const c = cyc(th + 0.6, 7.5);
  const slotY = 650, cx = 960;
  const blow = seg(c, 0.02, 0.2), up = seg(c, 0.2, 0.33), ins = easeInOut(seg(c, 0.33, 0.45)), ej = easeOutBack(seg(c, 0.9, 1));
  const inserted = c >= 0.45 && c < 0.9;
  // cartridge pose: tilted + raised while blown, upright over the slot, down into it, pops back up
  let cy = 250, rot = 0;
  if (c < 0.2) { rot = -0.5 * Math.sin(Math.PI * clamp01(blow * 1.15)); cy = 240 + Math.sin(t * 8) * 4 * (blow > 0 && blow < 1 ? 1 : 0); }
  else if (c < 0.33) { rot = 0; cy = 250 + up * 60; }
  else if (c < 0.9) cy = 310 + ins * 250;
  else cy = 560 - ej * 310;
  const cartW = 300, cartH = 330;
  // console (behind the cartridge's lower half: drawn first, the cartridge clipped at the slot)
  const conW = 760, conH = 210, conX = cx - conW / 2;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(X(f, cx), Y(f, slotY + conH + 26), conW * 0.55 * u, 26 * u, 0, 0, Math.PI * 2); ctx.fill();
  rr(ctx, X(f, conX), Y(f, slotY), conW * u, conH * u, 26 * u); ctx.fillStyle = CART.body; ctx.fill();
  ctx.lineWidth = 5 * u; ctx.strokeStyle = CART.ink; ctx.stroke();
  ctx.fillStyle = CART.bodyDark; ctx.fillRect(X(f, conX + 20), Y(f, slotY + 120), (conW - 40) * u, 14 * u);
  // slot
  rr(ctx, X(f, cx - 185), Y(f, slotY - 8), 370 * u, 30 * u, 8 * u); ctx.fillStyle = CART.ink; ctx.fill();
  // power LED + label
  const on = inserted;
  ctx.fillStyle = on ? G : '#5a1d2c';
  if (on) { ctx.shadowColor = G; ctx.shadowBlur = 24 * u; }
  ctx.beginPath(); ctx.arc(X(f, conX + 70), Y(f, slotY + 170), 13 * u, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.font = `800 ${22 * u}px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = CART.ink;
  ctx.fillText('POWER', X(f, conX + 100), Y(f, slotY + 171));
  ctx.textAlign = 'right'; ctx.fillText('VTP-64', X(f, conX + conW - 40), Y(f, slotY + 171));
  ctx.restore();
  // cartridge
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, w, Y(f, slotY + 4)); ctx.clip();
  ctx.translate(X(f, cx), Y(f, cy + cartH / 2));
  ctx.rotate(rot);
  const x0 = -cartW / 2 * u, y0 = -cartH / 2 * u;
  rr(ctx, x0, y0, cartW * u, cartH * u, 18 * u); ctx.fillStyle = CART.body; ctx.fill();
  ctx.lineWidth = 5 * u; ctx.strokeStyle = CART.ink; ctx.stroke();
  for (let i = 0; i < 5; i++) { ctx.fillStyle = CART.bodyDark; ctx.fillRect(x0 + 30 * u, y0 + (20 + i * 12) * u, (cartW - 60) * u, 5 * u); }
  // label
  const lg = ctx.createLinearGradient(x0, 0, -x0, 0); lg.addColorStop(0, G); lg.addColorStop(1, B);
  rr(ctx, x0 + 30 * u, y0 + 95 * u, (cartW - 60) * u, 170 * u, 10 * u); ctx.fillStyle = lg; ctx.fill(); ctx.lineWidth = 4 * u; ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = CART.ink;
  ctx.font = `900 ${64 * u}px ${SANS}`; ctx.fillText('VTP', 0, y0 + 165 * u);
  ctx.font = `800 ${22 * u}px ${MONO}`; ctx.fillText('GAME PAK', 0, y0 + 225 * u);
  // contacts at the bottom
  ctx.fillStyle = '#d7b64a';
  for (let i = 0; i < 9; i++) ctx.fillRect(x0 + (52 + i * 22) * u, y0 + (cartH - 26) * u, 12 * u, 20 * u);
  ctx.restore();
  // the blow: puffs + dust + FWOOO
  if (c < 0.2 && blow > 0.05) {
    const k = Math.sin(Math.PI * blow);
    const bx = cx + 190, by = 440;
    ctx.save();
    for (let i = 0; i < 7; i++) {
      const q = ((t * 2.2 + i / 7) % 1);
      ctx.globalAlpha = k * (1 - q) * 0.85;
      ctx.fillStyle = '#e9e6ff';
      ctx.beginPath(); ctx.arc(X(f, bx + q * 220), Y(f, by - 20 + Math.sin(i * 2.1) * 30 - q * 40), (16 + q * 30) * u, 0, Math.PI * 2); ctx.fill();
    }
    const d = rng(5);
    ctx.fillStyle = '#c9b48a';
    for (let i = 0; i < 18; i++) { const q = (t * 1.6 + d()) % 1; ctx.globalAlpha = k * (1 - q); ctx.fillRect(X(f, bx - 150 + q * 380 + d() * 40), Y(f, by + 60 - q * 120 + d() * 60), 6 * u, 6 * u); }
    ctx.globalAlpha = k;
    ctx.font = `900 ${58 * u}px ${SANS}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 8 * u; ctx.strokeStyle = CART.ink; ctx.strokeText('FWOOO!', X(f, bx + 60), Y(f, by - 110));
    ctx.fillStyle = '#ffe066'; ctx.fillText('FWOOO!', X(f, bx + 60), Y(f, by - 110));
    ctx.restore();
  }
  // CLUNK
  const cl = seg(c, 0.45, 0.53);
  if (cl > 0 && cl < 1) {
    ctx.save();
    ctx.globalAlpha = 1 - cl;
    ctx.translate(X(f, cx + 330), Y(f, slotY - 60)); ctx.rotate(-0.12); ctx.scale(0.7 + cl * 0.5, 0.7 + cl * 0.5);
    ctx.font = `900 ${64 * u}px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 8 * u; ctx.strokeStyle = CART.ink; ctx.strokeText('CLUNK!', 0, 0);
    ctx.fillStyle = CART.red; ctx.fillText('CLUNK!', 0, 0);
    ctx.restore();
  }
  // pixel loading bar
  const segs = 20, bw = 760, bx0 = cx - bw / 2, by0 = 930;
  const fill = inserted ? Math.floor(clamp01((c - 0.5) / 0.38) * segs) : c >= 0.9 ? segs : 0;
  ctx.save();
  ctx.lineWidth = 5 * u; ctx.strokeStyle = '#efeaff';
  ctx.strokeRect(X(f, bx0 - 10), Y(f, by0 - 10), (bw + 20) * u, 56 * u);
  for (let i = 0; i < segs; i++) {
    if (i >= fill) break;
    ctx.fillStyle = i < segs * 0.5 ? G : B;
    ctx.fillRect(X(f, bx0 + i * (bw / segs) + 3), Y(f, by0), (bw / segs - 6) * u, 36 * u);
  }
  ctx.font = `800 ${30 * u}px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#efeaff';
  const lbl = !inserted && c < 0.45 ? (c < 0.2 ? 'CLEANING CONTACTS' : 'INSERT CARTRIDGE') : c >= 0.9 ? 'HMM. ONE MORE TIME' : `LOADING${'.'.repeat(1 + Math.floor(t * 3) % 3)}`;
  if (Math.floor(t * 2.4) % 2 === 0 || inserted) ctx.fillText(lbl, f.w / 2, Y(f, by0 + 90));
  ctx.restore();
  caption(f, f.text || 'Setting up the game…', 120, 76, '#ffffff', SANS, '900');
}

function drawCartridge(f: CoverFrame) {
  const { w, h, u } = f;
  const k = coverK(f);
  const cell = 60 * u, cols = Math.ceil(w / cell), rows = Math.ceil(h / cell);
  const r = rng(f.seed);
  const thr: number[] = [];
  for (let i = 0; i < cols * rows; i++) { const cx = (i % cols) / cols - 0.5, cy = Math.floor(i / cols) / rows - 0.5; thr.push(clamp01(0.55 * r() + 0.45 * Math.hypot(cx, cy) * 1.3)); }
  masked(f, (ctx) => {
    for (let i = 0; i < thr.length; i++) if (thr[i] < k * 1.02) ctx.rect((i % cols) * cell, Math.floor(i / cols) * cell, cell + 0.5, cell + 0.5);
  }, () => cartridgeScene(f));
}

// ================================================================ 2. jack in
const JACK = { bg0: '#05070f', bg1: '#0b1224', line: 'rgba(108,199,245,0.35)', cyan: '#35e3ff', pink: '#ff4fd8' };
const GLYPHS = '0123456789ABCDEF<>/\\#$%&*+=';

function jackScene(f: CoverFrame) {
  const { ctx, w, h, u, th } = f;
  const t = f.t;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, JACK.bg0); g.addColorStop(1, JACK.bg1);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  // data rain
  const colW = 34 * u, n = Math.ceil(w / colW);
  ctx.font = `700 ${22 * u}px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const r = rng(17);
  for (let i = 0; i < n; i++) {
    const sp = 80 + r() * 220, off = r() * 2000, len = 6 + Math.floor(r() * 12), bright = r();
    const head = ((t * sp + off) % (h / u + len * 26)) * u;
    for (let j = 0; j < len; j++) {
      const y = head - j * 26 * u;
      if (y < -20 * u || y > h + 20 * u) continue;
      const a = (1 - j / len) * (0.25 + bright * 0.35);
      ctx.fillStyle = j === 0 ? `rgba(220,255,255,${(a + 0.3).toFixed(3)})` : `rgba(53,227,255,${a.toFixed(3)})`;
      ctx.fillText(GLYPHS[(i * 7 + j * 3 + Math.floor(t * 8 + i)) % GLYPHS.length], i * colW + colW / 2, y);
    }
  }
  // perspective floor grid (moves towards the viewer)
  const hy = Y(f, 700);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, hy, w, h - hy); ctx.clip();
  const fg = ctx.createLinearGradient(0, hy, 0, h); fg.addColorStop(0, 'rgba(5,7,15,0.92)'); fg.addColorStop(1, 'rgba(10,20,40,0.92)');
  ctx.fillStyle = fg; ctx.fillRect(0, hy, w, h - hy);
  ctx.strokeStyle = JACK.line; ctx.lineWidth = 2 * u;
  for (let i = -24; i <= 24; i++) { ctx.beginPath(); ctx.moveTo(w / 2 + i * 12 * u, hy); ctx.lineTo(w / 2 + i * 180 * u, h + 40 * u); ctx.stroke(); }
  for (let i = 0; i < 12; i++) { const q = ((i + (t * 0.8) % 1) / 12) ** 2.2; const y = hy + q * (h - hy + 40 * u); ctx.globalAlpha = 0.3 + q; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.restore();
  ctx.fillStyle = JACK.cyan; ctx.globalAlpha = 0.6; ctx.fillRect(0, hy - u, w, 2 * u); ctx.globalAlpha = 1;
  // loop: plug slides in (0–.22) · spark + ring (.22) · handshake (.25–.85) · re-sync (.9–1)
  const c = cyc(th + 0.3, 6.5);
  const plugX = 700 + easeInOut(seg(c, 0.02, 0.22)) * 480 - easeInOut(seg(c, 0.9, 1)) * 480;
  const sockX = 1240, py = 520;
  const linked = c >= 0.22 && c < 0.92;
  // socket panel
  ctx.save();
  rr(ctx, X(f, sockX - 20), Y(f, py - 150), 300 * u, 300 * u, 30 * u);
  ctx.fillStyle = '#0d1830'; ctx.fill();
  ctx.lineWidth = 4 * u; ctx.strokeStyle = linked ? JACK.cyan : '#2b4a74';
  if (linked) { ctx.shadowColor = JACK.cyan; ctx.shadowBlur = 30 * u; }
  ctx.stroke(); ctx.shadowBlur = 0;
  rr(ctx, X(f, sockX), Y(f, py - 40), 60 * u, 80 * u, 10 * u); ctx.fillStyle = '#02040a'; ctx.fill();
  // progress ring
  const prog = linked ? clamp01((c - 0.25) / 0.55) : 0;
  const rcx = X(f, sockX + 140), rcy = Y(f, py);
  ctx.lineWidth = 10 * u; ctx.strokeStyle = '#1a2d4d';
  ctx.beginPath(); ctx.arc(rcx, rcy, 80 * u, 0, Math.PI * 2); ctx.stroke();
  if (prog > 0) {
    ctx.strokeStyle = prog >= 1 ? G : JACK.cyan; ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 18 * u; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(rcx, rcy, 80 * u, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0;
  }
  ctx.font = `800 ${34 * u}px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = prog >= 1 ? G : '#cfe9ff';
  ctx.fillText(`${Math.round(prog * 100)}%`, rcx, rcy);
  ctx.restore();
  // cable: from the left edge, sagging, to the plug
  ctx.save();
  const x0 = -20 * u, y0 = Y(f, py + 180), pxx = X(f, plugX), pyy = Y(f, py);
  ctx.lineCap = 'round';
  const cable = () => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.bezierCurveTo(X(f, 200), Y(f, py + 260), X(f, plugX - 300), Y(f, py + 40), pxx - 90 * u, pyy); };
  ctx.strokeStyle = '#0a0f1c'; ctx.lineWidth = 30 * u; cable(); ctx.stroke();
  ctx.strokeStyle = linked ? JACK.cyan : '#3a6ea8'; ctx.lineWidth = 18 * u;
  if (linked) { ctx.shadowColor = JACK.cyan; ctx.shadowBlur = 20 * u; }
  cable(); ctx.stroke(); ctx.shadowBlur = 0;
  // packets along the cable (both ways) while linked
  if (linked) {
    for (let i = 0; i < 10; i++) {
      const dir = i % 2 ? 1 : -1;
      let q = ((t * 0.5 + i / 10) % 1); if (dir < 0) q = 1 - q;
      // point on the bezier
      const P = (a: number, b: number, cc: number, d: number) => (1 - q) ** 3 * a + 3 * (1 - q) ** 2 * q * b + 3 * (1 - q) * q * q * cc + q ** 3 * d;
      const bx = P(x0, X(f, 200), X(f, plugX - 300), pxx - 90 * u), by = P(y0, Y(f, py + 260), Y(f, py + 40), pyy);
      ctx.fillStyle = dir > 0 ? '#eaffff' : JACK.pink; ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 14 * u;
      ctx.beginPath(); ctx.arc(bx, by, 9 * u, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0;
  }
  // plug head
  rr(ctx, pxx - 100 * u, pyy - 50 * u, 110 * u, 100 * u, 16 * u); ctx.fillStyle = '#1b2a44'; ctx.fill();
  ctx.lineWidth = 4 * u; ctx.strokeStyle = JACK.cyan; ctx.stroke();
  ctx.fillStyle = '#9fb6d6'; ctx.fillRect(pxx + 10 * u, pyy - 30 * u, 50 * u, 60 * u);
  ctx.fillStyle = JACK.cyan; ctx.fillRect(pxx - 80 * u, pyy - 6 * u, 60 * u, 12 * u);
  ctx.restore();
  // spark + ring pulse on contact
  const sp = seg(c, 0.22, 0.34);
  if (sp > 0 && sp < 1) {
    ctx.save();
    const sx = X(f, sockX + 10), sy = Y(f, py);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 5 * u * (1 - sp); ctx.shadowColor = JACK.cyan; ctx.shadowBlur = 20 * u;
    const rr2 = rng(3);
    for (let i = 0; i < 12; i++) { const a = rr2() * Math.PI * 2, l0 = 20 + sp * 60, l1 = l0 + 40 + rr2() * 60; ctx.beginPath(); ctx.moveTo(sx + Math.cos(a) * l0 * u, sy + Math.sin(a) * l0 * u); ctx.lineTo(sx + Math.cos(a) * l1 * u, sy + Math.sin(a) * l1 * u); ctx.stroke(); }
    ctx.globalAlpha = 1 - sp; ctx.lineWidth = 6 * u; ctx.strokeStyle = JACK.cyan;
    ctx.beginPath(); ctx.arc(sx, sy, (40 + sp * 420) * u, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  // handshake log
  const log: [number, string][] = [[0.02, '> DIALING HOST ...'], [0.24, '> SYN'], [0.34, '< SYN-ACK'], [0.44, '> ACK'], [0.56, '> SYNCING SAVE DATA'], [0.8, '* LINK ESTABLISHED']];
  ctx.save();
  ctx.font = `700 ${28 * u}px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  let row = 0;
  for (const [at, s] of log) {
    if (c < at || c > 0.9) continue;
    const k = clamp01((c - at) / 0.04);
    ctx.fillStyle = s.startsWith('*') ? G : s.startsWith('<') ? JACK.pink : '#bfe6ff';
    ctx.fillText(s.slice(0, Math.ceil(s.length * k)), X(f, 1240), Y(f, 740 + row * 40));
    row++;
  }
  if (c > 0.9) { ctx.fillStyle = '#ffd166'; ctx.fillText('> RE-SYNCING ...', X(f, 1240), Y(f, 740)); }
  ctx.restore();
  ctx.save();
  glowTitle(f, f.text || 'Jacking in…', 130);
  ctx.restore();
}

function glowTitle(f: CoverFrame, text: string, y: number) {
  const { ctx, u } = f;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const s = fitFont(ctx, text, '900', 80 * u, SANS, Math.min(1500 * u, f.w * 0.92));
  ctx.font = `900 ${s}px ${SANS}`;
  glowText(ctx, text, f.w / 2, Y(f, y), JACK.cyan, '#eaffff', 26 * u, 0.9 + 0.1 * Math.sin(f.t * 9));
}

function drawJack(f: CoverFrame) {
  const { ctx, w, h, u } = f;
  // in: a glowing wipe from the left; out: the same edge keeps going and uncovers from the left
  const k = f.phase === 'in' ? easeInOut(f.p) : f.phase === 'out' ? easeInOut(f.p) : 1;
  const edge = f.phase === 'in' ? k * (w + 80 * u) : f.phase === 'out' ? k * (w + 80 * u) : w;
  masked(f, (c) => { if (f.phase === 'in') c.rect(0, 0, edge, h); else c.rect(edge, 0, w - edge + 1, h); }, () => jackScene(f));
  if (f.phase !== 'hold' && edge > 0 && edge < w + 40 * u) {
    ctx.save();
    ctx.fillStyle = JACK.cyan; ctx.shadowColor = JACK.cyan; ctx.shadowBlur = 30 * u;
    ctx.fillRect(edge - 3 * u, 0, 6 * u, h);
    const r = rng(Math.floor(f.t * 20));
    ctx.shadowBlur = 0;
    for (let i = 0; i < 26; i++) { ctx.globalAlpha = r(); const sz = (8 + r() * 26) * u; ctx.fillRect(edge + (f.phase === 'in' ? 1 : -1) * r() * 90 * u - sz / 2, r() * h, sz, sz); }
    ctx.restore();
  }
}

// ================================================================ 3. PRESS START
const BOOT = { bg0: '#f6f7fb', bg1: '#dde5f1', text: '#141821', dim: '#56607a', accent: '#23904a', accent2: '#1678b8' };
const TIPS = [
  'Tip: stretch those wrists before ranked.',
  'Tip: hydrate — your squad is counting on you.',
  'Tip: chat can’t see this screen right now.',
  'Tip: blowing on it doesn’t help. Do it anyway.',
  'Tip: the loading screen is the best level.',
  'Tip: turn it off and on again. Works on people too.',
];

function bootScene(f: CoverFrame) {
  const { ctx, w, h, u, t, th } = f;
  const g = ctx.createLinearGradient(0, 0, w * 0.4, h * 1.2);
  g.addColorStop(0, BOOT.bg0); g.addColorStop(1, BOOT.bg1);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  for (const [c, x, y, rad, sp] of [['rgba(35,144,74,0.14)', 0.2, 0.25, 0.6, 0.3], ['rgba(22,120,184,0.14)', 0.85, 0.8, 0.65, 0.23]] as [string, number, number, number, number][]) {
    const cx = w * (x + Math.sin(t * sp) * 0.05), cy = h * (y + Math.cos(t * sp) * 0.05), R = h * rad;
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R); rg.addColorStop(0, c); rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  }
  ctx.fillStyle = 'rgba(20,24,33,0.06)';
  const step = 32 * u;
  for (let y = step / 2; y < h; y += step) for (let x = step / 2; x < w; x += step) ctx.fillRect(x - 1.5 * u, y - 1.5 * u, 3 * u, 3 * u);
  // boot chime: a ring expands from the disc every 5 s
  const dx = X(f, 600), dy = Y(f, 560), R = 230 * u;
  const chime = cyc(th, 5);
  ctx.save();
  ctx.globalAlpha = (1 - chime) * 0.5; ctx.lineWidth = 6 * u * (1 - chime) + u;
  ctx.strokeStyle = chime < 0.5 ? BOOT.accent : BOOT.accent2;
  ctx.beginPath(); ctx.arc(dx, dy, R + chime * 420 * u, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  // the disc (spins), rainbow sheen, label ring
  ctx.save();
  ctx.shadowColor = 'rgba(20,30,50,0.25)'; ctx.shadowBlur = 50 * u; ctx.shadowOffsetY = 18 * u;
  ctx.fillStyle = '#d9dde6'; ctx.beginPath(); ctx.arc(dx, dy, R, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath(); ctx.arc(dx, dy, R, 0, Math.PI * 2); ctx.arc(dx, dy, 34 * u, 0, Math.PI * 2, true); ctx.clip();
  const ang = t * 4.2;
  const cg = ctx.createConicGradient(ang, dx, dy);
  const stops = ['#e7ebf2', '#b8f0ff', '#e7ebf2', '#ffd6f5', '#e7ebf2', '#fff3b0', '#e7ebf2', '#c8ffd9', '#e7ebf2'];
  stops.forEach((s, i) => cg.addColorStop(i / (stops.length - 1), s));
  ctx.fillStyle = cg; ctx.fillRect(dx - R, dy - R, R * 2, R * 2);
  // label ring with the mark (rotates with the disc)
  ctx.translate(dx, dy); ctx.rotate(ang);
  const lr = ctx.createLinearGradient(-R, 0, R, 0); lr.addColorStop(0, '#7bd88f'); lr.addColorStop(1, '#6cc7f5');
  ctx.fillStyle = lr; ctx.beginPath(); ctx.arc(0, 0, R * 0.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffffff'; ctx.font = `900 ${34 * u}px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('VTube Pro', 0, -R * 0.28);
  ctx.font = `700 ${18 * u}px ${SANS}`; ctx.fillText('GAME DISC 1', 0, R * 0.3);
  ctx.restore();
  ctx.save();
  ctx.lineWidth = 4 * u; ctx.strokeStyle = 'rgba(20,24,33,0.25)';
  ctx.beginPath(); ctx.arc(dx, dy, R, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = BOOT.bg1; ctx.beginPath(); ctx.arc(dx, dy, 30 * u, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.restore();
  // right column: header, PRESS START (blinks), the line, a loading tip, dots
  const cx = 1060;
  ctx.save();
  vtpMark(ctx, X(f, cx), Y(f, 250), 64 * u, false);
  ctx.font = `800 ${34 * u}px ${SANS}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = BOOT.text;
  ctx.fillText('VTube', X(f, cx + 82), Y(f, 283));
  const vw = ctx.measureText('VTube ').width; ctx.fillStyle = BOOT.accent; ctx.fillText('Pro', X(f, cx + 82) + vw, Y(f, 283));
  const blink = Math.floor(t * 1.6) % 2 === 0;
  ctx.globalAlpha = blink ? 1 : 0.25;
  setSpacing(ctx, 8 * u);
  const ps = fitFont(ctx, 'PRESS START', '900', 104 * u, SANS, 780 * u);
  ctx.font = `900 ${ps}px ${SANS}`;
  const pg = ctx.createLinearGradient(X(f, cx), 0, X(f, cx + 760), 0); pg.addColorStop(0, BOOT.accent); pg.addColorStop(1, BOOT.accent2);
  ctx.fillStyle = pg; ctx.fillText('PRESS START', X(f, cx - 4), Y(f, 440));
  setSpacing(ctx, 0);
  ctx.globalAlpha = 1;
  const line = f.text || 'Setting up the game…';
  const ls = fitFont(ctx, line, '700', 46 * u, SANS, 780 * u);
  ctx.font = `700 ${ls}px ${SANS}`; ctx.fillStyle = BOOT.text; ctx.fillText(line, X(f, cx), Y(f, 540));
  // tip card
  const ti = Math.floor(th / 4.5 + f.seed % TIPS.length) % TIPS.length, tk = cyc(th, 4.5);
  const ta = Math.min(1, tk / 0.08, (1 - tk) / 0.08);
  rr(ctx, X(f, cx), Y(f, 610), 780 * u, 96 * u, 18 * u); ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fill();
  ctx.lineWidth = 2 * u; ctx.strokeStyle = 'rgba(22,120,184,0.3)'; ctx.stroke();
  ctx.globalAlpha = ta;
  const ts = fitFont(ctx, TIPS[ti], '600', 30 * u, SANS, 730 * u);
  ctx.font = `600 ${ts}px ${SANS}`; ctx.fillStyle = BOOT.dim; ctx.fillText(TIPS[ti], X(f, cx + 26), Y(f, 658));
  ctx.globalAlpha = 1;
  // bouncing dots
  for (let i = 0; i < 3; i++) {
    const b = Math.max(0, Math.sin(t * 6 - i * 0.7));
    ctx.fillStyle = i === 1 ? BOOT.accent2 : BOOT.accent;
    ctx.beginPath(); ctx.arc(X(f, cx + 20 + i * 40), Y(f, 780 - b * 22), 12 * u, 0, Math.PI * 2); ctx.fill();
  }
  ctx.font = `600 ${26 * u}px ${SANS}`; ctx.fillStyle = BOOT.dim; ctx.fillText('Now loading', X(f, cx + 140), Y(f, 782));
  ctx.restore();
}

function drawBoot(f: CoverFrame) {
  const { ctx, w, h, u } = f;
  const diag = Math.hypot(w, h) / 2 + 20 * u;
  const r = f.phase === 'in' ? easeOut(f.p) * diag : f.phase === 'out' ? (1 - easeInOut(f.p)) * diag : diag;
  masked(f, (c) => c.arc(w / 2, h / 2, Math.max(0.5, r), 0, Math.PI * 2), () => bootScene(f));
  if (f.phase !== 'hold' && r > 1 && r < diag - 1) {
    ctx.save();
    ctx.lineWidth = 14 * u; ctx.strokeStyle = G; ctx.beginPath(); ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 6 * u; ctx.strokeStyle = B; ctx.beginPath(); ctx.arc(w / 2, h / 2, r + 12 * u, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}

export const VTP_COVERS: CoverStyleDef[] = [
  { id: 'cc-cartridge', name: 'Blow the cartridge', theme: 'vtp', blurb: 'A retro cartridge gets blown on, clunks into the console and the pixel loading bar fills', line: 'Setting up the game…', inDur: 0.7, outDur: 0.8, draw: drawCartridge },
  { id: 'cc-jackin', name: 'Jacking in', theme: 'vtp', blurb: 'A neon cable jacks into the port, data rains down and the handshake log runs', line: 'Jacking in…', inDur: 0.6, outDur: 0.7, draw: drawJack },
  { id: 'cc-boot', name: 'Press Start', theme: 'vtp', blurb: 'A console boot screen: spinning game disc, blinking PRESS START and loading tips', line: 'Setting up the game…', inDur: 0.65, outDur: 0.75, draw: drawBoot },
];
