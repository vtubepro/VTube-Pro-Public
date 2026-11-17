// Canvas renderers for goals, stretch goals and the subathon timer (beta.13). ONE look used everywhere: the docked
// card on the OBS page (goalsOverlay.ts), the HUD elements of the Full screen layouts (hudElements/goalLadder.ts,
// subathonTimer.ts), the in-world neon board (goalsWorld.ts) and the studio panel's live preview. Everything is drawn
// from the helper's view (goalsStore) - no state of its own except easing - so every page shows the same thing.
// Styles: 'neon' (dark glass + glowing gradient bars, the studio's look), 'clean' (no panel, outlined text, slim bars),
// 'bold' (chunky solid panels, heavy type, striped bars).
import { fmtClock, fmtMetric, fmtSpan } from '../../shared/goals.ts';
import { liveTarget, viewRemaining, type GoalFx, type GoalLive, type GoalsShow, type SubLive, type WheelSpin } from '../../shared/goalsView.ts';
import { goalsStore } from './goalsStore.ts';

export interface Look {
  style: GoalsShow['style'];
  accent: string;
  accent2: string;
  ink: string;
  hero: string;
  /** opaque background (in-world screens) */
  solid?: boolean;
  test?: boolean;
}
export const DEFAULT_LOOK: Look = { style: 'neon', accent: '#35e3ff', accent2: '#8b5cff', ink: '#eef6ff', hero: '#ffd166' };

export const FONT = '"Segoe UI", Inter, system-ui, -apple-system, Roboto, Arial, sans-serif';
export const HEAVY = 'Impact, "Arial Black", "Segoe UI Black", system-ui, sans-serif';
export const MONO = '"Segoe UI", "Cascadia Mono", Consolas, ui-monospace, monospace';
const tf = (look: Look, wgt: number, px: number) => `${look.style === 'bold' ? 400 : wgt} ${Math.max(6, Math.round(px))}px ${look.style === 'bold' ? HEAVY : FONT}`;

export function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
export function fit(g: CanvasRenderingContext2D, s: string, maxW: number): string {
  if (maxW <= 0) return '';
  if (g.measureText(s).width <= maxW) return s;
  let t = s;
  while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}
/** Text with a dark outline (reads on any game / room). */
function text(g: CanvasRenderingContext2D, s: string, x: number, y: number, look: Look, outline: number, color = look.ink) {
  if (look.style !== 'neon' || !look.solid) { g.lineJoin = 'round'; g.lineWidth = outline; g.strokeStyle = 'rgba(0,0,0,.82)'; g.strokeText(s, x, y); }
  g.fillStyle = color; g.fillText(s, x, y);
}
export const alpha = (hex: string, a: number) => { const m = /^#([0-9a-f]{6})$/i.exec(hex); if (!m) return hex; const n = parseInt(m[1], 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };

/** The panel behind a block (neon: glass + gradient edge; bold: solid; clean: nothing). */
export function panel(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, u: number, look: Look, edge?: [string, string]) {
  if (look.style === 'clean') return;
  g.save();
  if (look.style === 'bold') {
    rr(g, x, y, w, h, 14 * u); g.fillStyle = 'rgba(10,10,18,.92)'; g.fill();
    g.lineWidth = 5 * u; g.strokeStyle = edge?.[0] ?? look.accent; g.stroke();
  } else {
    const bg = g.createLinearGradient(x, y, x + w, y + h);
    bg.addColorStop(0, 'rgba(22,16,44,0.9)'); bg.addColorStop(1, 'rgba(6,10,24,0.9)');
    rr(g, x, y, w, h, 22 * u); g.fillStyle = bg; g.fill();
    const e = g.createLinearGradient(x, 0, x + w, 0);
    e.addColorStop(0, edge?.[0] ?? look.accent); e.addColorStop(1, edge?.[1] ?? look.accent2);
    g.lineWidth = 2.5 * u; g.strokeStyle = e; g.shadowColor = alpha(edge?.[0] ?? look.accent, 0.55); g.shadowBlur = 14 * u; g.stroke();
  }
  g.restore();
}

/** A progress bar: fill 0..1, level ticks (fractions), glow + sheen while it moves. */
function bar(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, f: number, look: Look, color: string, color2: string, ticks: number[], now: number, done: boolean) {
  const r = look.style === 'bold' ? 6 * (h / 30) : h / 2;
  g.save();
  rr(g, x, y, w, h, r);
  g.fillStyle = look.style === 'clean' ? 'rgba(0,0,0,.55)' : 'rgba(255,255,255,.08)'; g.fill();
  if (look.style === 'clean') { g.lineWidth = Math.max(1, h * 0.12); g.strokeStyle = 'rgba(255,255,255,.6)'; g.stroke(); }
  const fw = Math.max(0, Math.min(1, f)) * w;
  if (fw > 0.5) {
    g.save(); rr(g, x, y, w, h, r); g.clip();
    const gr = g.createLinearGradient(x, 0, x + Math.max(fw, h), 0);
    gr.addColorStop(0, color); gr.addColorStop(1, color2);
    if (look.style === 'neon') { g.shadowColor = alpha(color, 0.9); g.shadowBlur = h * 0.9; }
    rr(g, x, y, Math.max(fw, h * 0.6), h, r); g.fillStyle = gr; g.fill();
    g.shadowBlur = 0;
    const live = goalsStore.moving;   // (the stripes / the sheen move only while something changes: idle = a few redraws a second)
    if (look.style === 'bold') {         // diagonal stripes
      g.globalAlpha = 0.18; g.fillStyle = '#fff';
      const off = live ? (now / 40) % (h * 1.4) : 0;
      for (let sx = x - h * 2 + off; sx < x + fw; sx += h * 1.4) { g.beginPath(); g.moveTo(sx, y + h); g.lineTo(sx + h * 0.7, y + h); g.lineTo(sx + h * 1.4, y); g.lineTo(sx + h * 0.7, y); g.closePath(); g.fill(); }
      g.globalAlpha = 1;
    } else if (live) {                    // a sheen sweeping along while it fills
      const sx = x + ((now / 1600) % 1) * fw;
      const sh = g.createLinearGradient(sx - h * 2, 0, sx + h * 2, 0); sh.addColorStop(0, 'rgba(255,255,255,0)'); sh.addColorStop(0.5, done ? 'rgba(255,255,255,.45)' : 'rgba(255,255,255,.22)'); sh.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = sh; g.fillRect(x, y, fw, h);
    }
    g.restore();
  }
  for (const t of ticks) {
    if (t <= 0.001 || t >= 0.999) continue;
    const tx = x + t * w;
    g.fillStyle = t <= f ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.4)';
    g.fillRect(tx - Math.max(1, h * 0.06), y + h * 0.15, Math.max(2, h * 0.12), h * 0.7);
  }
  g.restore();
}

// ---------------------------------------------------------------- one goal (the bar)
/** Height of a goal block at width w. */
export const goalBlockH = (w: number) => Math.round(w * 0.185);

/** One goal: title + amount, the bar (towards the next level), the next reward + level pips. */
export function drawGoal(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, goal: GoalLive, cur: string, look: Look, now: number, withPanel = true) {
  const u = Math.min(w / 720, h / 133);
  const pad = 22 * u;
  if (withPanel) panel(g, x, y, w, h, u, look, goal.color ? [goal.color, look.accent2] : undefined);
  y += Math.max(0, (h - 133 * u) / 2);          // (a taller box: the rows sit in its middle)
  const v = goalsStore.shown(goal.id, goal.value);
  const { target, level } = liveTarget(goal);
  const all = goal.reached >= goal.levels.length;
  const col = goal.color || (all ? look.hero : look.accent), col2 = all ? '#ff8a3d' : look.accent2;
  g.save();
  g.textBaseline = 'middle';
  // row 1: title · value / target
  const r1 = y + pad + 16 * u;
  g.font = tf(look, 800, 30 * u); g.textAlign = 'right';
  const vs = Math.abs(v - goal.value) > 0.01 ? Math.round(v) : v;   // (whole units while the bar glides: no flickering cents)
  const amt = `${fmtMetric(vs, goal.metric, cur, true)} / ${fmtMetric(target, goal.metric, cur, goal.metric !== 'money')}`;
  const aw = g.measureText(amt).width;
  text(g, amt, x + w - pad, r1, look, 5 * u);
  g.font = tf(look, 800, 30 * u); g.textAlign = 'left';
  text(g, fit(g, goal.title, w - pad * 3 - aw), x + pad, r1, look, 5 * u);
  // row 2: the bar (towards the current level; earlier levels as ticks)
  const by = y + pad + 40 * u, bh = 30 * u, bw = w - pad * 2;
  const ticks = goal.levels.slice(0, level).map((l) => l.target / target);
  bar(g, x + pad, by, bw, bh, v / Math.max(1e-9, target), look, col, col2, ticks, now, all);
  const pct = Math.min(999, Math.floor((v / Math.max(1e-9, target)) * 100));
  g.font = tf(look, 900, 19 * u); g.textAlign = 'right';
  text(g, `${pct}%`, x + pad + bw - 10 * u, by + bh / 2 + 1, look, 4 * u);
  // row 3: what's next + pips
  const r3 = by + bh + 22 * u;
  const n = goal.levels.length;
  const pipR = 6.5 * u, pipGap = 19 * u;
  const pipsW = n > 1 ? n * pipGap : 0;
  for (let i = 0; i < n && n > 1; i++) {
    const px = x + w - pad - pipsW + i * pipGap + pipR;
    g.beginPath(); g.arc(px, r3, pipR, 0, Math.PI * 2);
    const hitL = i < goal.reached;
    g.fillStyle = hitL ? (i === 0 ? '#7dff8a' : look.hero) : i === level ? alpha(look.accent, 0.35) : 'rgba(255,255,255,.14)'; g.fill();
    g.lineWidth = 1.5 * u; g.strokeStyle = 'rgba(0,0,0,.6)'; g.stroke();
  }
  const lv = goal.levels[Math.min(level, n - 1)];
  const label = all ? (n > 1 ? `ALL ${n} GOALS SMASHED!` : 'GOAL REACHED!') : level === 0
    ? (lv.reward ? `Goal: ${lv.reward}` : '')
    : `${goal.reached ? '✓ ' : ''}Stretch ${level}/${n - 1}: ${lv.hidden ? '???' : lv.reward || fmtMetric(lv.target, goal.metric, cur)}`;
  g.font = tf(look, 700, 20 * u); g.textAlign = 'left';
  if (label) text(g, fit(g, label, w - pad * 2 - pipsW - 10 * u), x + pad, r3, look, 4 * u, all ? look.hero : alpha(look.ink, 0.9));
  g.restore();
}

// ---------------------------------------------------------------- the stretch-goal ladder
export const ladderH = (w: number, n: number) => Math.round(w * (0.2 + n * 0.115));
export function drawLadder(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, goal: GoalLive, cur: string, look: Look, now: number, withPanel = true) {
  const n = goal.levels.length;
  const u = Math.min(w / 520, h / ladderH(520, n));
  const pad = 22 * u;
  if (withPanel) panel(g, x, y, w, h, u, look, goal.color ? [goal.color, look.accent2] : undefined);
  const v = goalsStore.shown(goal.id, goal.value);
  g.save();
  g.textBaseline = 'middle';
  g.font = tf(look, 900, 26 * u); g.textAlign = 'left';
  text(g, fit(g, goal.title.toUpperCase(), w - pad * 2 - 150 * u), x + pad, y + pad + 14 * u, look, 5 * u);
  g.font = tf(look, 800, 24 * u); g.textAlign = 'right';
  text(g, fmtMetric(v, goal.metric, cur), x + w - pad, y + pad + 14 * u, look, 5 * u, look.hero);
  // the rail: bottom = 0, top = the last level; rows from the top (last stretch) down to the main goal
  const top = y + pad + 48 * u, bot = y + h - pad - 6 * u;
  const rowH = (bot - top) / n;
  const railX = x + pad + 12 * u;
  const maxT = goal.levels[n - 1].target;
  const yOf = (val: number) => {
    // piecewise: each level gets an equal row, value interpolated between levels
    const L = goal.levels.map((l) => l.target);
    let i = 0; while (i < n && val >= L[i]) i++;
    const lo = i === 0 ? 0 : L[i - 1], hi = i >= n ? maxT : L[i];
    const f = i >= n ? 1 : (val - lo) / Math.max(1e-9, hi - lo);
    const k = Math.min(n, i + Math.max(0, Math.min(1, f)));
    return bot - (k / n) * (bot - top) + (k >= n ? 0 : 0);
  };
  g.lineCap = 'round';
  g.lineWidth = 10 * u; g.strokeStyle = 'rgba(255,255,255,.12)';
  g.beginPath(); g.moveTo(railX, bot); g.lineTo(railX, top + rowH * 0.5); g.stroke();
  const fy = Math.max(top + rowH * 0.5, yOf(v));
  const gr = g.createLinearGradient(0, bot, 0, top);
  gr.addColorStop(0, goal.color || look.accent); gr.addColorStop(1, look.hero);
  if (look.style === 'neon') { g.shadowColor = alpha(goal.color || look.accent, 0.9); g.shadowBlur = 12 * u; }
  g.strokeStyle = gr; g.beginPath(); g.moveTo(railX, bot); g.lineTo(railX, fy); g.stroke();
  g.shadowBlur = 0;
  for (let i = 0; i < n; i++) {
    const l = goal.levels[i];
    const cy = bot - ((i + 1) / n) * (bot - top) + rowH * 0.5;
    const hitL = i < goal.reached, cur0 = i === goal.reached;
    if (cur0 && look.style !== 'clean') { rr(g, x + pad * 0.6, cy - rowH * 0.42, w - pad * 1.2, rowH * 0.84, 12 * u); g.fillStyle = alpha(look.accent, 0.12 + 0.05 * Math.sin(now / 300)); g.fill(); }
    g.beginPath(); g.arc(railX, cy, 11 * u, 0, Math.PI * 2);
    g.fillStyle = hitL ? (i === 0 ? '#7dff8a' : look.hero) : cur0 ? look.accent : '#2a2f45'; g.fill();
    g.lineWidth = 2 * u; g.strokeStyle = 'rgba(0,0,0,.7)'; g.stroke();
    g.font = `900 ${Math.round(13 * u)}px ${FONT}`; g.textAlign = 'center'; g.fillStyle = '#0a0716';
    g.fillText(hitL ? '✓' : l.hidden ? '?' : String(i + 1), railX, cy + 1);
    g.textAlign = 'left';
    g.font = tf(look, 800, 22 * u);
    const tt = fmtMetric(l.target, goal.metric, cur, goal.metric !== 'money');
    text(g, tt, railX + 24 * u, cy, look, 4 * u, hitL ? alpha(look.ink, 0.65) : look.ink);
    const tw = g.measureText(tt).width;
    g.font = tf(look, 600, 20 * u);
    const rw = l.hidden ? '🔒 ???' : l.reward || (i === 0 ? 'Goal' : `Stretch ${i}`);
    text(g, fit(g, rw, w - (railX + 24 * u + tw + 14 * u) - pad + x), railX + 24 * u + tw + 14 * u, cy, look, 4 * u, hitL ? alpha(look.ink, 0.55) : cur0 ? look.hero : alpha(look.ink, 0.85));
    if (hitL) { g.strokeStyle = alpha(look.ink, 0.45); g.lineWidth = 2 * u; g.beginPath(); g.moveTo(railX + 24 * u, cy + 1); g.lineTo(railX + 24 * u + tw, cy + 1); g.stroke(); }
  }
  g.restore();
}

// ---------------------------------------------------------------- the subathon timer
export const timerH = (w: number) => Math.round(w * 0.36);
export function drawTimer(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, sub: SubLive, look: Look, now: number, withPanel = true) {
  const u = Math.min(w / 720, h / timerH(720));
  const pad = 22 * u;
  const left = viewRemaining(sub, now);
  const urgent = !sub.ended && !sub.paused && left < 5 * 60_000;
  if (withPanel) panel(g, x, y, w, h, u, look, sub.ended ? [look.hero, '#ff8a3d'] : urgent ? ['#ff5fa2', '#ff8a3d'] : undefined);
  g.save();
  g.textBaseline = 'middle';
  // header: title + chips (×2 happy hour, hype, sleep, paused)
  const hy = y + pad + 14 * u;
  g.font = tf(look, 900, 22 * u); g.textAlign = 'left';
  text(g, fit(g, (sub.title || 'Subathon').toUpperCase(), w * 0.45), x + pad, hy, look, 4 * u, alpha(look.ink, 0.92));
  const chips: [string, string][] = [];
  if (sub.paused && !sub.ended) chips.push(['⏸ PAUSED', '#9aa4b8']);
  if (sub.happy) chips.push([`HAPPY HOUR ×${trim(sub.happy.mult)}`, look.hero]);
  if (sub.hype) chips.push([`HYPE ×${trim(sub.hype.mult)}`, '#ff5fa2']);
  if (sub.sleep) chips.push(['😴 SLEEP', '#8fa8ff']);
  if (look.test) chips.push(['TEST', '#ff4d4d']);
  let cx = x + w - pad;
  g.font = `900 ${Math.round(16 * u)}px ${FONT}`; g.textAlign = 'right';
  for (const [t, c] of chips) {
    const cw = g.measureText(t).width + 18 * u;
    rr(g, cx - cw, hy - 13 * u, cw, 26 * u, 13 * u); g.fillStyle = c; g.fill();
    g.fillStyle = '#0a0716'; g.fillText(t, cx - 9 * u, hy + 1);
    cx -= cw + 8 * u;
  }
  // the big clock
  const showUp = sub.display === 'uptime';
  const big = sub.ended ? 'TIME!' : fmtClock(showUp ? now - sub.startedAt : left);
  const by = y + h * 0.5 + 4 * u;
  let size = 96 * u;
  g.font = `900 ${Math.round(size)}px ${look.style === 'bold' ? HEAVY : MONO}`;
  while (g.measureText(big).width > w - pad * 2 && size > 20) { size *= 0.92; g.font = `900 ${Math.round(size)}px ${look.style === 'bold' ? HEAVY : MONO}`; }
  g.textAlign = 'center';
  const pulse = urgent ? 0.75 + 0.25 * Math.sin(now / 160) : 1;
  const clockCol = sub.ended ? look.hero : sub.paused ? '#c9cfdd' : urgent ? `rgba(255,${Math.round(95 + 60 * pulse)},${Math.round(130 + 30 * pulse)},1)` : look.ink;
  if (look.style === 'neon' && !sub.paused) { g.shadowColor = alpha(sub.ended ? look.hero : urgent ? '#ff5fa2' : look.accent, 0.85); g.shadowBlur = 22 * u; }
  text(g, big, x + w / 2, by, look, 8 * u, clockCol);
  g.shadowBlur = 0;
  // footer: the newest "+5:00 Alice" pop (slides up, green), else uptime / how to add time (rotating) / the summary
  const fy = y + h - pad - 10 * u;
  const t = Date.now();
  const pop = [...goalsStore.pops].reverse().find((p) => t - p.at >= 0 && t - p.at < 4200);
  if (pop) {
    const a = (t - pop.at) / 4200;
    const k = Math.min(1, a / 0.08), out = Math.max(0, (a - 0.8) / 0.2);
    g.globalAlpha = Math.max(0, k - out);
    g.textAlign = 'center';
    const s0 = `${pop.ms >= 0 ? '+' : '−'}${fmtClock(Math.abs(pop.ms), false)}`;
    g.font = `900 ${Math.round(26 * u)}px ${FONT}`;
    const sw0 = g.measureText(s0).width;
    g.font = tf(look, 700, 19 * u);
    const who = pop.who ? `  ${fit(g, pop.who, w * 0.45)}` : '';
    const ww = g.measureText(who).width;
    const lx = x + w / 2 - (sw0 + ww) / 2, ly = fy + (1 - k) * 14 * u;
    g.textAlign = 'left';
    g.font = `900 ${Math.round(26 * u)}px ${FONT}`; text(g, s0, lx, ly, look, 5 * u, pop.ms >= 0 ? '#7dff8a' : '#ff6b6b');
    g.font = tf(look, 700, 19 * u); if (who) text(g, who, lx + sw0, ly, look, 4 * u, alpha(look.ink, 0.92));
    g.globalAlpha = 1;
    g.restore();
    return;
  }
  g.font = tf(look, 700, 19 * u); g.textAlign = 'center';
  let foot = '';
  if (sub.ended && sub.summary) foot = `Ran ${fmtSpan(sub.summary.lengthMs)} · ${sub.stats.subs} subs${sub.stats.money ? ` · ${fmtMetric(sub.stats.money, 'money', goalsStore.view?.cur ?? 'USD')}` : ''}`;
  else if (sub.display === 'both') foot = `Live for ${fmtClock(now - sub.startedAt)}${sub.rules.length ? `  ·  ${sub.rules[Math.floor(now / 6000) % sub.rules.length]}` : ''}`;
  else if (showUp) foot = `${fmtClock(left)} left${sub.rules.length ? `  ·  ${sub.rules[Math.floor(now / 6000) % sub.rules.length]}` : ''}`;
  else if (sub.rules.length) foot = sub.rules[Math.floor(now / 6000) % sub.rules.length];
  if (foot) text(g, fit(g, foot, w - pad * 2), x + w / 2, fy, look, 4 * u, alpha(look.ink, 0.88));
  g.restore();
}
const trim = (v: number) => String(Math.round(v * 100) / 100);

/** The "time added by" leaderboard (top 5). */
export const boardH = (w: number, n: number) => Math.round(w * (0.16 + Math.max(1, n) * 0.085));
export function drawLeaders(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, sub: SubLive, look: Look, withPanel = true) {
  const n = sub.top.length;
  const u = Math.min(w / 520, h / boardH(520, n));
  const pad = 20 * u;
  if (withPanel) panel(g, x, y, w, h, u, look);
  g.save(); g.textBaseline = 'middle';
  g.font = tf(look, 900, 22 * u); g.textAlign = 'left';
  text(g, 'TIME ADDED BY', x + pad, y + pad + 10 * u, look, 4 * u, alpha(look.ink, 0.9));
  const rowH = (h - pad * 2 - 34 * u) / Math.max(1, n);
  if (!n) { g.font = tf(look, 600, 18 * u); text(g, 'Be the first!', x + pad, y + pad + 34 * u + rowH / 2, look, 4 * u, alpha(look.ink, 0.7)); }
  sub.top.forEach((r, i) => {
    const cy = y + pad + 34 * u + rowH * (i + 0.5);
    g.font = tf(look, 900, 20 * u); g.textAlign = 'left';
    text(g, ['🥇', '🥈', '🥉', '4', '5'][i], x + pad, cy, look, 3 * u, look.hero);
    g.font = tf(look, 700, 20 * u);
    const tm = `+${fmtClock(r.ms, false)}`;
    g.textAlign = 'right'; text(g, tm, x + w - pad, cy, look, 4 * u, '#7dff8a');
    const tw = g.measureText(tm).width;
    g.textAlign = 'left'; text(g, fit(g, r.name, w - pad * 2 - 40 * u - tw - 10 * u), x + pad + 40 * u, cy, look, 4 * u);
  });
  g.restore();
}

// ---------------------------------------------------------------- the wheel
const WHEEL_SPIN = 6500, WHEEL_SHOW = 4500;
const SLICE = ['#35e3ff', '#ff5fa2', '#ffd24a', '#7dff8a', '#b388ff', '#ff8a3d', '#4dd0e1', '#f06292'];
/** Is a spin on screen now (helper clock)? */
export const wheelActive = (sp: WheelSpin | null, now: number) => !!sp && now >= sp.at - 300 && now < sp.at + WHEEL_SPIN + WHEEL_SHOW;
export function drawWheel(g: CanvasRenderingContext2D, cx: number, cy: number, R: number, slots: string[], sp: WheelSpin, look: Look, now: number) {
  const n = Math.max(2, slots.length), step = (Math.PI * 2) / n;
  const t = Math.max(0, Math.min(1, (now - sp.at) / WHEEL_SPIN));
  const ease = 1 - Math.pow(1 - t, 4);
  // land with the result slot's centre under the pointer (top), after 6 whole turns
  const final = -Math.PI / 2 - (sp.result + 0.5) * step + Math.PI * 2 * 6;
  const rot = final * ease;
  const appear = Math.min(1, (now - sp.at + 300) / 300), gone = Math.max(0, (now - sp.at - WHEEL_SPIN - WHEEL_SHOW + 400) / 400);
  const a = Math.max(0, Math.min(1, appear) - gone);
  if (a <= 0) return;
  g.save();
  g.globalAlpha = a;
  g.translate(cx, cy);
  g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = R * 0.12;
  g.beginPath(); g.arc(0, 0, R * 1.04, 0, Math.PI * 2); g.fillStyle = '#0a0716'; g.fill();
  g.shadowBlur = 0;
  for (let i = 0; i < n; i++) {
    const a0 = rot + i * step;
    g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, R, a0, a0 + step); g.closePath();
    const landed = t >= 1 && i === sp.result;
    g.fillStyle = landed ? '#ffffff' : SLICE[i % SLICE.length]; g.fill();
    g.lineWidth = R * 0.012; g.strokeStyle = '#0a0716'; g.stroke();
    // labels read outwards on the right half, inwards on the left half (never upside down)
    const mid = a0 + step / 2, left = Math.cos(mid) < 0;
    g.save(); g.rotate(left ? mid + Math.PI : mid); g.textAlign = left ? 'left' : 'right'; g.textBaseline = 'middle';
    g.font = `800 ${Math.round(Math.min(R * 0.085, (R * step) * 0.38))}px ${FONT}`;
    g.fillStyle = '#0a0716';
    g.fillText(fit(g, slots[i] ?? '', R * 0.68), left ? -R * 0.92 : R * 0.92, 0);
    g.restore();
  }
  g.beginPath(); g.arc(0, 0, R * 0.11, 0, Math.PI * 2); g.fillStyle = look.hero; g.fill(); g.lineWidth = R * 0.02; g.strokeStyle = '#0a0716'; g.stroke();
  // the pointer
  g.beginPath(); g.moveTo(0, -R * 0.92); g.lineTo(-R * 0.08, -R * 1.14); g.lineTo(R * 0.08, -R * 1.14); g.closePath(); g.fillStyle = '#fff'; g.fill(); g.lineWidth = R * 0.015; g.strokeStyle = '#0a0716'; g.stroke();
  g.restore();
  if (t >= 1) {
    const k = Math.min(1, (now - sp.at - WHEEL_SPIN) / 350);
    g.save(); g.globalAlpha = a * k; g.textAlign = 'center'; g.textBaseline = 'middle';
    const s = 1 + 0.15 * (1 - k);
    g.font = `900 ${Math.round(R * 0.2 * s)}px ${FONT}`;
    const lbl = fit(g, sp.label, R * 3);
    const lw = g.measureText(lbl).width + R * 0.3;
    rr(g, cx - lw / 2, cy + R * 1.12, lw, R * 0.34, R * 0.17); g.fillStyle = 'rgba(10,7,22,.92)'; g.fill(); g.lineWidth = R * 0.02; g.strokeStyle = look.hero; g.stroke();
    g.fillStyle = look.hero; g.fillText(lbl, cx, cy + R * 1.29);
    g.restore();
  }
}

// ---------------------------------------------------------------- celebrations (banner + confetti)
export const FX_MS = 6500;
export function drawFx(g: CanvasRenderingContext2D, W: number, H: number, fx: GoalFx, look: Look, now: number) {
  const t = (now - fx.at) / FX_MS;
  if (t < 0 || t >= 1) return;
  const big = fx.kind === 'goal' || fx.kind === 'stretch' || fx.kind === 'end';
  const inK = Math.min(1, t / 0.07), outK = Math.min(1, Math.max(0, (1 - t) / 0.1));
  const a = Math.min(inK, outK);
  const u = W / 1920;
  const bw = Math.min(W * 0.62, 1180 * u), bh = (fx.sub ? 150 : 110) * u;
  const x = (W - bw) / 2, y = H * 0.12 - (1 - inK) * 60 * u;
  const col = fx.color || look.accent;
  g.save();
  g.globalAlpha = a;
  const s = 1 + 0.08 * (1 - inK);
  g.translate(W / 2, y + bh / 2); g.scale(s, s); g.translate(-W / 2, -(y + bh / 2));
  rr(g, x, y, bw, bh, 26 * u);
  const bg = g.createLinearGradient(x, y, x + bw, y + bh); bg.addColorStop(0, 'rgba(20,12,40,.94)'); bg.addColorStop(1, 'rgba(8,10,26,.94)');
  g.fillStyle = bg; g.fill();
  g.lineWidth = 4 * u; g.strokeStyle = col; g.shadowColor = col; g.shadowBlur = 30 * u; g.stroke(); g.shadowBlur = 0;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `900 ${Math.round((big ? 54 : 44) * u)}px ${FONT}`;
  g.lineWidth = 7 * u; g.strokeStyle = 'rgba(0,0,0,.85)'; g.lineJoin = 'round';
  const main = fit(g, fx.text, bw - 60 * u);
  const my = y + (fx.sub ? 54 : bh / 2) * (fx.sub ? u : 1) + (fx.sub ? 0 : 0);
  g.strokeText(main, W / 2, fx.sub ? y + 56 * u : y + bh / 2); g.fillStyle = big ? look.hero : '#fff'; g.fillText(main, W / 2, fx.sub ? y + 56 * u : y + bh / 2);
  void my;
  if (fx.sub) { g.font = `700 ${Math.round(32 * u)}px ${FONT}`; const sb = fit(g, fx.sub, bw - 60 * u); g.strokeText(sb, W / 2, y + 108 * u); g.fillStyle = '#e9e4ff'; g.fillText(sb, W / 2, y + 108 * u); }
  g.restore();
  if (big && t < 0.6) {                         // confetti
    const k = t / 0.6;
    for (let i = 0; i < 90; i++) {
      const sx = ((i * 97) % 100) / 100, sp = 0.6 + ((i * 37) % 50) / 60;
      const px = W * (0.18 + sx * 0.64) + Math.sin(k * 9 + i) * 30 * u, py = y - 20 * u + (k * sp * 900 - ((i * 13) % 80)) * u;
      if (py < 0 || py > H) continue;
      g.save(); g.translate(px, py); g.rotate(k * 12 + i); g.globalAlpha = (1 - k) * a;
      g.fillStyle = SLICE[i % SLICE.length]; g.fillRect(-7 * u, -4 * u, 14 * u, 8 * u); g.restore();
    }
  }
}

// ---------------------------------------------------------------- compositions
/** The goals card (docked / HUD): the shown goals stacked + the timer. Returns the height used for width W. */
export function cardHeight(W: number, goals: GoalLive[], sub: SubLive | null, what: GoalsShow['what']): number {
  const gap = W * 0.025;
  let h = 0;
  if (what !== 'timer') for (let i = 0; i < goals.length; i++) h += goalBlockH(W) + gap;
  if (what !== 'goals' && sub) h += timerH(W) + gap;
  return Math.max(0, h - gap);
}
export function drawCard(g: CanvasRenderingContext2D, W: number, H: number, goals: GoalLive[], sub: SubLive | null, what: GoalsShow['what'], cur: string, look: Look, now: number) {
  const gap = W * 0.025;
  const need = cardHeight(W, goals, sub, what);
  const k = need > H ? H / need : 1;
  let y = 0;
  if (what !== 'goals' && sub) { const th = timerH(W) * k; drawTimer(g, 0, y, W, th, sub, look, now); y += th + gap * k; }
  if (what !== 'timer') for (const gl of goals) { const gh = goalBlockH(W) * k; drawGoal(g, 0, y, W, gh, gl, cur, look, now); y += gh + gap * k; }
}

/** The in-world board (16:9): the timer + the first goal + its ladder / the leaderboard, on a dark screen. */
export function drawBoard(g: CanvasRenderingContext2D, W: number, H: number, goals: GoalLive[], sub: SubLive | null, cur: string, look: Look, now: number) {
  g.save();
  g.fillStyle = '#05060c'; g.fillRect(0, 0, W, H);
  const grd = g.createRadialGradient(W * 0.5, H * 0.4, H * 0.1, W * 0.5, H * 0.5, W * 0.7);
  grd.addColorStop(0, alpha(look.accent2, 0.18)); grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  const m = W * 0.035;
  const L: Look = { ...look, solid: true };
  if (sub && goals.length) {
    const lw = W * 0.56 - m * 1.5;
    const gh = Math.min((H - m * 3) * 0.45, goalBlockH(lw) * 1.15), th = H - m * 3 - gh;
    drawTimer(g, m, m, lw, th, sub, L, now);
    drawGoal(g, m, m * 2 + th, lw, gh, goals[0], cur, L, now);
    const rx = W * 0.56 + m * 0.5, rw = W - rx - m;
    if (goals[0].levels.length > 1) drawLadder(g, rx, m, rw, H - m * 2, goals[0], cur, L, now);
    else drawLeaders(g, rx, m, rw, H - m * 2, sub, L);
  } else if (sub) {
    drawTimer(g, m, m, W * 0.6 - m * 1.5, H - m * 2, sub, L, now);
    drawLeaders(g, W * 0.6 + m * 0.5, m, W * 0.4 - m * 1.5, H - m * 2, sub, L);
  } else if (goals.length) {
    const lead = goals[0];
    if (lead.levels.length > 1) {
      const lw = W * 0.56 - m * 1.5;
      const n = Math.min(2, goals.length);
      const each = (H - m * (n + 1)) / n;
      for (let i = 0; i < n; i++) drawGoal(g, m, m + i * (each + m), lw, each, goals[i], cur, L, now);
      drawLadder(g, W * 0.56 + m * 0.5, m, W * 0.44 - m * 1.5, H - m * 2, lead, cur, L, now);
    } else {
      const n = Math.min(3, goals.length);
      const each = (H - m * (n + 1)) / n;
      for (let i = 0; i < n; i++) drawGoal(g, m, m + i * (each + m), W - m * 2, each, goals[i], cur, L, now);
    }
  }
  if (look.test) { g.font = `900 ${Math.round(H * 0.05)}px ${FONT}`; g.textAlign = 'right'; g.textBaseline = 'top'; g.fillStyle = '#ff4d4d'; g.fillText('TEST', W - m * 0.6, m * 0.25); }
  g.restore();
}
