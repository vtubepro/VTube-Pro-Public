// The page-side copy of the helper's goals view (server/goals.ts → {type:'goals', s}): ONE store per page that every
// renderer reads (the docked card, the HUD elements, the in-world board, the support board's goal line, the studio
// panel's preview). It keeps the helper's clock offset (the subathon's time left is computed from the ABSOLUTE end, so
// every page shows the same second), eases the goal bars, and turns new timer additions into "+5:00" pops.
import { sanitizeGoalsView, type GoalLive, type GoalsView } from '../../shared/goalsView.ts';

export interface TimePop { seq: number; ms: number; who: string; at: number }

class GoalsStore {
  view: GoalsView | null = null;
  /** helper clock − this page's clock (ms) */
  offset = 0;
  /** eased goal values (the bars glide) */
  readonly disp = new Map<string, number>();
  /** recent additions to the timer, newest last (shown as pops) */
  pops: TimePop[] = [];
  private seen = new Set<number>();
  private loadedAt = Date.now();
  private stepAt = 0;
  private subId = '';
  private listeners = new Set<(v: GoalsView | null) => void>();
  /** bumps on every new view (canvases redraw on change) */
  rev = 0;
  /** something is animating (a bar easing, a "+5:00" pop): renderers draw at full rate, else a few times a second */
  moving = false;

  on(fn: (v: GoalsView | null) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  set(raw: unknown) {
    const v = sanitizeGoalsView(raw);
    if (!v) return;
    if (this.view && v.rev < this.view.rev && v.now <= this.view.now) return;    // an older push arriving late
    const off = v.now - Date.now();
    this.offset = !this.view || Math.abs(off - this.offset) > 1500 ? off : this.offset + (off - this.offset) * 0.3;
    const sub = v.sub;
    const sid = sub ? `${sub.startedAt}` : '';
    if (sid !== this.subId) { this.subId = sid; this.seen.clear(); for (const l of sub?.last ?? []) this.seen.add(l.seq); }
    for (const l of sub?.last ?? []) {
      if (this.seen.has(l.seq)) continue;
      this.seen.add(l.seq);
      if (l.at + 15_000 > this.now() && l.at > this.loadedAt - 2000 + this.offset) { this.pops.push({ seq: l.seq, ms: l.ms, who: l.who, at: Date.now() }); if (this.pops.length > 4) this.pops.shift(); }
    }
    for (const g of v.goals) if (!this.disp.has(g.id)) this.disp.set(g.id, g.value);
    this.view = v;
    this.rev++;
    for (const l of this.listeners) try { l(v); } catch { /* listener */ }
  }
  clear() { this.view = null; this.rev++; for (const l of this.listeners) try { l(null); } catch { /* listener */ } }

  /** The helper's clock now. */
  now() { return Date.now() + this.offset; }

  /** Ease the bars (once per frame; safe to call from several renderers). */
  step(t = performance.now()) {
    const dt = this.stepAt ? Math.min(0.1, Math.max(0, (t - this.stepAt) / 1000)) : 0;
    this.stepAt = t;
    if (!this.view || !dt) return;
    for (const g of this.view.goals) {
      const d = this.disp.get(g.id) ?? g.value;
      const nd = Math.abs(g.value - d) < 0.005 ? g.value : d + (g.value - d) * (1 - Math.exp(-dt * 3.2));
      this.disp.set(g.id, nd);
    }
    const cut = Date.now() - 4500;
    if (this.pops.length && this.pops[0].at < cut) this.pops = this.pops.filter((p) => p.at >= cut);
    let mv = this.pops.length > 0;
    for (const g of this.view.goals) if (Math.abs((this.disp.get(g.id) ?? g.value) - g.value) > 1e-3) { mv = true; break; }
    this.moving = mv;
  }
  shown(id: string, fallback: number) { return this.disp.get(id) ?? fallback; }
}

export const goalsStore = new GoalsStore();

/** A goal by a HUD element's `goal` prop: '' = the first shown one, "2" = the second goal, else by name. */
export function pickGoal(spec: string): GoalLive | null {
  const v = goalsStore.view;
  if (!v) return null;
  const k = spec.trim().toLowerCase();
  if (!k) return v.goals.find((g) => g.show) ?? null;
  if (/^\d+$/.test(k)) return v.goals[Number(k) - 1] ?? null;
  return v.goals.find((g) => g.title.toLowerCase() === k) ?? v.goals.find((g) => g.title.toLowerCase().includes(k)) ?? null;
}

/** ?goalsDemo=1|wheel|end on TEST pages only: a local fake view (no server, no sound) for screenshots. */
export function goalsDemo(kind: string) {
  const t0 = Date.now();
  let rev = 0;
  const tick = () => {
    const now = Date.now(), k = Math.min(1, (now - t0) / 8000);
    const money = 410 + k * 380, subs = Math.round(31 + k * 12);
    const lv = (tg: number[], v: number, rw: string[], hid: boolean[] = []) => tg.map((t, i) => ({ target: t, reward: hid[i] && v < t ? '' : rw[i], hidden: !!hid[i] && v < t, hit: v >= t }));
    const reached = (tg: number[], v: number) => tg.filter((t) => v >= t).length;
    const mt = [500, 750, 1000, 1500], st = [50, 75, 100];
    const ended = kind === 'end';
    goalsStore.set({
      v: 1, now, rev: ++rev, cur: 'USD',
      goals: [
        { id: 'demo1', title: 'Stream goal', metric: 'money', value: money, levels: lv(mt, money, ['Karaoke hour', 'Outfit change', 'Spicy noodle challenge', ''], [false, false, false, true]), reached: reached(mt, money), show: true, color: '' },
        { id: 'demo2', title: 'Sub goal', metric: 'subs', value: subs, levels: lv(st, subs, ['New emote', 'Face reveal (of my cat)', '24 h stream']), reached: reached(st, subs), show: true, color: '' },
      ],
      sub: {
        title: 'Subathon', startedAt: t0 - 5 * 3_600_000, endsAt: ended ? t0 : t0 + 7 * 3_600_000 + 25 * 60_000 + 13_000, paused: false, pausedRemaining: 0, ended, endedAt: ended ? t0 : 0,
        mult: 2, happy: { mult: 2, until: t0 + 20 * 60_000 }, hype: null, sleep: false, addedMs: 3 * 3_600_000,
        last: [{ seq: 1, at: now - 1000, ms: 300_000, label: 'NightOwl42: sub', who: 'NightOwl42' }, ...(k > 0.4 ? [{ seq: 2, at: t0 + 3500, ms: 1_500_000, label: 'PixelPioneer: 5 gifted subs', who: 'PixelPioneer' }] : [])],
        top: [{ name: 'PixelPioneer', platform: 'twitch', ms: 5_400_000 }, { name: 'NeonNomad', platform: 'youtube', ms: 3_000_000 }, { name: 'Beatsmith', platform: 'kick', ms: 1_800_000 }],
        rules: ['Sub T1 +5 min · T2 +10 min · T3 +15 min', 'Each gifted sub = +5 min', '$1 = +1 min', '100 bits = +1 min'], display: 'remaining',
        stats: { subs: 212, gifted: 140, bits: 42000, money: 1830, members: 12, events: 380 },
        summary: ended ? { lengthMs: 31 * 3_600_000, addedMs: 19 * 3_600_000, biggest: 'PixelPioneer: 50 gifted subs (+4 h 10 min)' } : null,
      },
      wheel: { slots: ['Do 10 push-ups', 'Sing a song', '+15 minutes', 'Accent for 10 min', 'Chat picks the game', 'Outfit change', 'Hydrate!', 'Spin again'], spin: kind === 'wheel' ? { id: 'demo', at: t0 + 600, result: 2, label: '+15 minutes', by: 'NightOwl42' } : null },
      fx: kind === 'fx' || (kind === '1' && money >= 750) ? [{ id: 'f1', at: kind === 'fx' ? t0 + 300 : t0 + 4500, kind: 'stretch', text: 'STRETCH GOAL 1 REACHED!', sub: 'Unlocked: Outfit change', color: '#ffd24a' }] : [],
      show: { dock: 'auto', what: 'both', world: true, scale: 1, style: 'neon' }, test: false,
    });
    if (k < 1) setTimeout(tick, 500);
  };
  tick();
}
