// What the pages draw (beta.13 goals + subathon): the helper's engine (server/goals.ts) pushes ONE view on the bus
// ({type:'goals', s: GoalsView}); the OBS page's goal bars / stretch-goal ladder / subathon timer / wheel / in-world
// board, the studio panel and party guests' pages (relayed by the host's studio, src/goals/goalsRelay.ts) all render
// it as is. The overlay is a pure view: the time left is computed from the ABSOLUTE end + the server's clock offset, so
// a reload, a crash or a second OBS page never shows a different time. Pure; sanitised on arrival (bounded strings).
import type { GoalMetric } from './goals.ts';

export interface GoalLevelView { target: number; reward: string; hidden: boolean; hit: boolean }
export interface GoalLive {
  id: string;
  title: string;
  metric: GoalMetric;
  value: number;
  /** the main goal + the stretch goals in order */
  levels: GoalLevelView[];
  /** levels reached */
  reached: number;
  show: boolean;
  color: string;
}
export interface SubLiveRow { name: string; platform: string; ms: number }
export interface SubLive {
  title: string;
  startedAt: number;
  endsAt: number;
  paused: boolean;
  pausedRemaining: number;
  ended: boolean;
  endedAt: number;
  /** the multiplier now (happy × hype × sleep × decay) and its parts */
  mult: number;
  happy: { mult: number; until: number } | null;
  hype: { mult: number; until: number } | null;
  sleep: boolean;
  addedMs: number;
  /** the last few additions (newest last) for the "+5:00" pops */
  last: { seq: number; at: number; ms: number; label: string; who: string }[];
  top: SubLiveRow[];
  rules: string[];
  display: 'remaining' | 'uptime' | 'both';
  stats: { subs: number; gifted: number; bits: number; money: number; members: number; events: number };
  /** the end-of-subathon summary (once ended) */
  summary: { lengthMs: number; addedMs: number; biggest: string } | null;
}
export interface GoalFx { id: string; at: number; kind: 'goal' | 'stretch' | 'message' | 'time' | 'wheel' | 'end'; text: string; sub: string; color: string }
export interface WheelSpin { id: string; at: number; result: number; label: string; by: string }
export interface GoalsShow {
  /** the docked card on the normal OBS view: a corner, auto (the freest corner), or off */
  dock: 'auto' | 'tl' | 'tr' | 'bl' | 'br' | 'off';
  /** what the docked card holds */
  what: 'both' | 'goals' | 'timer';
  /** the in-world board (GOAL_BOARD_xx anchors; else the room's chat board anchors) */
  world: boolean;
  /** size × */
  scale: number;
  style: 'neon' | 'clean' | 'bold';
}
export interface GoalsView {
  v: 1;
  /** the helper's clock when this was made (pages keep an offset) */
  now: number;
  rev: number;
  cur: string;
  goals: GoalLive[];
  sub: SubLive | null;
  wheel: { slots: string[]; spin: WheelSpin | null };
  fx: GoalFx[];
  show: GoalsShow;
  /** test mode: the view shows the sandbox (fake events only), never the real state */
  test: boolean;
}

export const DEFAULT_SHOW: GoalsShow = { dock: 'auto', what: 'both', world: true, scale: 1, style: 'neon' };

const s = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').slice(0, n) : '');
const n = (v: unknown, lo = -1e15, hi = 1e15, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const o = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const COLOR = /^#[0-9a-f]{6}$/i;
const METRICS = new Set(['money', 'subs', 'bits', 'members', 'points', 'count']);

export function sanitizeShow(raw: unknown): GoalsShow {
  const x = o(raw), d = DEFAULT_SHOW;
  return {
    dock: ['auto', 'tl', 'tr', 'bl', 'br', 'off'].includes(String(x.dock)) ? x.dock as GoalsShow['dock'] : d.dock,
    what: x.what === 'goals' || x.what === 'timer' ? x.what : 'both',
    world: x.world !== false,
    scale: n(x.scale, 0.5, 2, 1),
    style: x.style === 'clean' || x.style === 'bold' ? x.style : 'neon',
  };
}

/** A view from the bus / party link (anything else = null). */
export function sanitizeGoalsView(raw: unknown): GoalsView | null {
  const x = o(raw);
  if (x.v !== 1) return null;
  const goals: GoalLive[] = arr(x.goals, 8).map((g0) => {
    const g = o(g0);
    return {
      id: s(g.id, 32), title: s(g.title, 48), metric: (METRICS.has(String(g.metric)) ? g.metric : 'money') as GoalMetric, value: n(g.value, -1e9, 1e12),
      levels: arr(g.levels, 11).map((l0) => { const l = o(l0); return { target: n(l.target, 0, 1e12), reward: s(l.reward, 80), hidden: l.hidden === true, hit: l.hit === true }; }),
      reached: Math.round(n(g.reached, 0, 11)), show: g.show !== false, color: typeof g.color === 'string' && COLOR.test(g.color) ? g.color : '',
    };
  }).filter((g) => g.id && g.levels.length);
  let sub: SubLive | null = null;
  if (x.sub && typeof x.sub === 'object') {
    const u = o(x.sub), st = o(u.stats), sm = u.summary && typeof u.summary === 'object' ? o(u.summary) : null;
    const hp = u.happy && typeof u.happy === 'object' ? o(u.happy) : null, hy = u.hype && typeof u.hype === 'object' ? o(u.hype) : null;
    sub = {
      title: s(u.title, 40), startedAt: n(u.startedAt, 0, 1e14), endsAt: n(u.endsAt, 0, 1e14), paused: u.paused === true, pausedRemaining: n(u.pausedRemaining, 0, 1e13),
      ended: u.ended === true, endedAt: n(u.endedAt, 0, 1e14), mult: n(u.mult, 0, 1000, 1),
      happy: hp ? { mult: n(hp.mult, 1, 10, 1), until: n(hp.until, 0, 1e14) } : null, hype: hy ? { mult: n(hy.mult, 1, 10, 1), until: n(hy.until, 0, 1e14) } : null,
      sleep: u.sleep === true, addedMs: n(u.addedMs, -1e13, 1e13),
      last: arr(u.last, 8).map((l0) => { const l = o(l0); return { seq: n(l.seq, 0, 1e12), at: n(l.at, 0, 1e14), ms: n(l.ms, -1e12, 1e12), label: s(l.label, 80), who: s(l.who, 48) }; }),
      top: arr(u.top, 5).map((r0) => { const r = o(r0); return { name: s(r.name, 48), platform: s(r.platform, 16), ms: n(r.ms, 0, 1e13) }; }),
      rules: arr(u.rules, 10).map((r) => s(r, 80)).filter(Boolean),
      display: u.display === 'uptime' || u.display === 'both' ? u.display : 'remaining',
      stats: { subs: n(st.subs, 0, 1e9), gifted: n(st.gifted, 0, 1e9), bits: n(st.bits, 0, 1e12), money: n(st.money, 0, 1e12), members: n(st.members, 0, 1e9), events: n(st.events, 0, 1e9) },
      summary: sm ? { lengthMs: n(sm.lengthMs, 0, 1e13), addedMs: n(sm.addedMs, -1e13, 1e13), biggest: s(sm.biggest, 100) } : null,
    };
  }
  const w = o(x.wheel), sp = w.spin && typeof w.spin === 'object' ? o(w.spin) : null;
  return {
    v: 1, now: n(x.now, 0, 1e14, Date.now()), rev: n(x.rev, 0, 1e12), cur: /^[A-Z]{3}$/.test(String(x.cur)) ? String(x.cur) : 'USD',
    goals, sub,
    wheel: { slots: arr(w.slots, 16).map((l) => s(l, 40)), spin: sp ? { id: s(sp.id, 32), at: n(sp.at, 0, 1e14), result: Math.round(n(sp.result, 0, 15)), label: s(sp.label, 40), by: s(sp.by, 48) } : null },
    fx: arr(x.fx, 6).map((f0) => { const f = o(f0); return { id: s(f.id, 40), at: n(f.at, 0, 1e14), kind: (['goal', 'stretch', 'message', 'time', 'wheel', 'end'].includes(String(f.kind)) ? f.kind : 'message') as GoalFx['kind'], text: s(f.text, 140), sub: s(f.sub, 140), color: typeof f.color === 'string' && COLOR.test(f.color) ? f.color : '' }; }),
    show: sanitizeShow(x.show), test: x.test === true,
  };
}

/** Anything to show on stream? */
export function viewActive(v: GoalsView | null): { goals: GoalLive[]; timer: boolean } {
  if (!v) return { goals: [], timer: false };
  return { goals: v.goals.filter((g) => g.show), timer: !!v.sub };
}

/** Time left on the subathon at the page's `now` + the server clock offset. */
export function viewRemaining(sub: SubLive, now: number): number {
  if (sub.ended) return 0;
  return sub.paused ? sub.pausedRemaining : Math.max(0, sub.endsAt - now);
}

/** The bar's span for a goal right now: the level it fills towards. */
export function liveTarget(g: GoalLive): { from: number; target: number; level: number } {
  const L = g.levels.map((l) => l.target);
  const i = Math.min(g.reached, L.length - 1);
  return { from: i > 0 ? L[i - 1] : 0, target: L[i], level: i };
}

/** A rect in frame fractions. */
export interface FRect { x: number; y: number; w: number; h: number }
const hit = (a: FRect, b: FRect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** Where the docked goals card goes: the wanted corner, or (auto) the first corner touching nothing it must avoid
 *  (faces, cams, the react / capture screen, the docked chat, the poll card). null = nowhere free: hide it. */
export function pickGoalsDock(avoid: FRect[], w: number, h: number, want: GoalsShow['dock'], prev: FRect | null): FRect | null {
  if (want === 'off') return null;
  const m = 0.015;
  const at: Record<'tl' | 'tr' | 'bl' | 'br', FRect> = { tl: { x: m, y: m + 0.01, w, h }, tr: { x: 1 - m - w, y: m + 0.01, w, h }, bl: { x: m, y: 1 - m - h - 0.02, w, h }, br: { x: 1 - m - w, y: 1 - m - h - 0.02, w, h } };
  const order: ('tl' | 'tr' | 'bl' | 'br')[] = want === 'auto' ? ['tr', 'tl', 'br', 'bl'] : [want, ...(['tr', 'tl', 'br', 'bl'] as const).filter((c) => c !== want)];
  const free = (r: FRect) => !avoid.some((a) => hit(r, a));
  // keep the corner it is in while it stays free (no hopping between corners)
  if (prev) { const same = order.map((c) => at[c]).find((r) => Math.abs(r.x - prev.x) < 1e-6 && Math.abs(r.y - prev.y) < 1e-6 && Math.abs(r.w - w) < 1e-6 && Math.abs(r.h - h) < 1e-6); if (same && free(same) && (want === 'auto' || same === at[want])) return same; }
  // a corner the streamer picked is used even when something overlaps it a little - only a face pushes it elsewhere
  for (const c of order) if (free(at[c])) return at[c];
  return null;
}
