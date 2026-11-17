// HUD element "goalBar" (shared/hud.ts HUD_TYPES.goalBar): a goal as a slim bar. Since beta.13 it shows a goal of the
// helper's goals engine (Goals & subathon, src/goals/goalsStore.ts: the first shown one, or the one named in `goal`),
// filling towards its next stretch goal; with an older version (no goals engine) it shows the chat goal (Chat & events →
// Goal: target + label) with the session's support total, as before. Hidden while its goal is off unless `always` is set.
// This is the worked example in docs/LAYOUTS.md ("Add a new element type").
import { HUD_FONTS, prop, registerHudElement, textShadow, type HudEnv, type HudFrame, type HudPlaced, type HudView } from '../hudCore.ts';
import { fmtMetric } from '../../../../shared/goals.ts';
import { liveTarget } from '../../../../shared/goalsView.ts';
import { goalsStore, pickGoal } from '../../../goals/goalsStore.ts';

const CSS = `
.hud-goal { display:flex; flex-direction:column; justify-content:center; gap:.22em; }
.hud-goal .row { display:flex; justify-content:space-between; align-items:baseline; gap:.6em; font-weight:800; white-space:nowrap; }
.hud-goal .row .lb { overflow:hidden; text-overflow:ellipsis; }
.hud-goal .bar { position:relative; height:.62em; border-radius:99px; background:rgba(0,0,0,.55); box-shadow:0 0 0 .09em rgba(255,255,255,.55), 0 .15em .5em rgba(0,0,0,.5); overflow:hidden; }
.hud-goal .bar i { position:absolute; left:0; top:0; bottom:0; border-radius:99px; transition:width .8s cubic-bezier(.2,.9,.3,1); }
`;
let cssDone = false;

class GoalBarView implements HudView {
  readonly el = document.createElement('div');
  private lb = document.createElement('span');
  private amt = document.createElement('span');
  private fill = document.createElement('i');

  constructor(private env: HudEnv) {
    if (!cssDone) { const s = document.createElement('style'); s.textContent = CSS; document.head.append(s); cssDone = true; }
    this.el.className = 'hud-goal';
    const row = document.createElement('div'); row.className = 'row';
    this.lb.className = 'lb';
    row.append(this.lb, this.amt);
    const bar = document.createElement('div'); bar.className = 'bar';
    bar.append(this.fill);
    this.el.append(row, bar);
  }

  update(e: HudPlaced, f: HudFrame) {
    const p = e.props, k = f.frameH / 1080;
    const gv = goalsStore.view;
    if (gv) { this.engine(e, f, gv.cur); return; }
    const goal = f.chat.goal;
    const show = goal.on || prop.bool(p.always, false);
    this.el.style.visibility = show ? '' : 'hidden';
    if (!show) return;
    const s = this.el.style;
    s.fontSize = `${(22 * prop.num(p.size, 1) * k).toFixed(2)}px`;
    s.fontFamily = HUD_FONTS[prop.str(p.font, 'sans')] ?? HUD_FONTS.sans;
    s.color = '#fff';
    s.textShadow = textShadow(2.5, 0.7, k);
    const usd = this.env.feed.totals?.usd ?? 0, target = Math.max(1, goal.target);
    const label = prop.str(p.label, '') || goal.label;
    if (this.lb.textContent !== label) this.lb.textContent = label;
    const a = prop.bool(p.amount, true) ? `$${Math.floor(usd).toLocaleString('en-US')} / $${Math.round(target).toLocaleString('en-US')}` : '';
    if (this.amt.textContent !== a) this.amt.textContent = a;
    const col = prop.str(p.color, '') || f.palette.accent;
    this.fill.style.background = `linear-gradient(90deg, ${col}, ${f.palette.accent2})`;
    this.fill.style.width = `${(Math.min(1, usd / target) * 100).toFixed(2)}%`;
  }

  /** A goal of the goals engine (beta.13). */
  private engine(e: HudPlaced, f: HudFrame, cur: string) {
    const p = e.props, k = f.frameH / 1080;
    const g = pickGoal(prop.str(p.goal, ''));
    const show = !!g && (g.show || prop.bool(p.always, false));
    this.el.style.visibility = show ? '' : 'hidden';
    if (!g || !show) return;
    goalsStore.step();
    const s = this.el.style;
    s.fontSize = `${(22 * prop.num(p.size, 1) * k).toFixed(2)}px`;
    s.fontFamily = HUD_FONTS[prop.str(p.font, 'sans')] ?? HUD_FONTS.sans;
    s.color = '#fff';
    s.textShadow = textShadow(2.5, 0.7, k);
    const { target, level } = liveTarget(g);
    const v0 = goalsStore.shown(g.id, g.value), v = Math.abs(v0 - g.value) > 0.01 ? Math.round(v0) : v0;
    const label = prop.str(p.label, '') || g.title;
    if (this.lb.textContent !== label) this.lb.textContent = label;
    const st = g.levels.length > 1 ? `  ·  ${g.reached >= g.levels.length ? '✓ all' : level ? `stretch ${level}/${g.levels.length - 1}` : `+${g.levels.length - 1} stretch`}` : '';
    const a = prop.bool(p.amount, true) ? `${fmtMetric(v, g.metric, cur, true)} / ${fmtMetric(target, g.metric, cur)}${st}` : '';
    if (this.amt.textContent !== a) this.amt.textContent = a;
    const col = prop.str(p.color, '') || g.color || f.palette.accent;
    const done = g.reached >= g.levels.length;
    this.fill.style.background = `linear-gradient(90deg, ${col}, ${done ? f.palette.hero : f.palette.accent2})`;
    this.fill.style.width = `${(Math.min(1, v / Math.max(1e-9, target)) * 100).toFixed(2)}%`;
  }

  dispose() { /* nothing held */ }
}

registerHudElement({ type: 'goalBar', mount: (env) => new GoalBarView(env) });
