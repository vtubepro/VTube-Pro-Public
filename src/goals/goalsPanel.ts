// "Goals & subathon" in the studio (Show tab → 🎯 Goals & subathon; beta.13). Zero effort first: a goal in three clicks
// (open, pick a template, done), a subathon from a template in two, ready-made incentives you just switch on. Everything
// else is there when wanted: stretch goals with rewards and effects, the subathon's rules / caps / multipliers, live
// controls (pause, add time, undo, happy hour, sleep mode, the wheel), mod chat commands, the audit logs with Undo, the
// look on stream and test mode. Talks only to this PC's VTube Pro server (/api/goals/*).
import { fmtClock, fmtMetric, fmtMoney, fmtSpan, GOAL_METRICS, GOAL_TEMPLATES, incentiveText, METRIC_LABEL, MOD_COMMANDS, parseDuration, RESET_LABEL, SOUND_CUES, SOUND_LABEL,
  type DeckCue, type GoalDef, type GoalMetric, type IncAction, type Incentive, type IncTrigger, type SoundCue, type StretchGoal } from '../../shared/goals.ts';
import { sanitizeSubathon, type SubathonConfig, type SubLog } from '../../shared/subathon.ts';
import { liveTarget, viewRemaining, type GoalsView } from '../../shared/goalsView.ts';
import { DECK_ACTIONS } from '../../shared/deck.ts';
import { SUPPORT_KINDS, type SupportKind } from '../../shared/support.ts';
import { toast } from '../ui/dom.ts';
import { forScripts } from '../ui/forScripts.ts';

interface PanelState {
  cfg: {
    currency: string; goals: GoalDef[]; subathon: SubathonConfig; incentives: Incentive[]; wheel: { label: string; weight: number }[];
    show: GoalsView['show']; mods: { on: boolean; off: string[] }; celebrate: SoundCue | 'none'; streamGapH: number;
  };
  view: GoalsView;
  recent: { seq: number; at: number; origin: string; void: boolean; test: boolean; source: string; kind: string; who: string; label: string; timerUnknown?: boolean }[];
  adjust: { seq: number; at: number; goalId: string; delta: number; by: string; note: string; void?: boolean }[];
  subLog: SubLog[];
  history: { title: string; startedAt: number; endedAt: number; lengthMs: number; addedMs: number; stats: { subs: number; gifted: number; money: number; bits: number }; top: { name: string; ms: number }[] }[];
  test: boolean;
  presets: Incentive[];
}

const CSS = `
.vgoal{display:flex;flex-direction:column;gap:10px;font-size:13.5px;color:var(--text)}
.vgoal *{box-sizing:border-box}
.vgoal .tabs{display:flex;gap:4px;background:var(--card2);padding:3px;border-radius:10px;border:1px solid var(--line)}
.vgoal .tabs button{flex:1 1 auto;min-width:0;border:0;background:transparent;color:var(--dim);padding:7px 3px;font-size:12.5px !important;border-radius:8px;font:inherit;font-weight:650;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vgoal .tabs button.on{background:var(--card);color:var(--text);box-shadow:0 0 0 1px var(--line2)}
.vgoal .status{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dim);font-size:12.5px}
.vgoal .dot{width:8px;height:8px;border-radius:50%;background:var(--faint);flex:none}
.vgoal .dot.live{background:var(--ok);box-shadow:0 0 0 3px var(--accent-soft)}
.vgoal .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px}
.vgoal .card.test{border-color:var(--warn)}
.vgoal .card h5{margin:0;font-size:14px;display:flex;align-items:center;gap:8px}
.vgoal .card h5 .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vgoal .muted{color:var(--dim);font-size:12.5px;line-height:1.4}
.vgoal .tiny{color:var(--faint);font-size:11.5px}
.vgoal .row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.vgoal .row > .grow{flex:1;min-width:0}
.vgoal .grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 8px}
.vgoal .grid label,.vgoal label.f{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--dim);min-width:0}
.vgoal input[type=text],.vgoal input[type=number],.vgoal input[type=datetime-local],.vgoal select,.vgoal textarea{background:var(--input);color:var(--text);border:1px solid var(--line2);border-radius:8px;padding:6px 8px;font:inherit;min-width:0;width:100%}
.vgoal textarea{min-height:110px;resize:vertical}
.vgoal button.b{background:var(--card2);color:var(--text);border:1px solid var(--line2);border-radius:8px;padding:6px 10px;font:inherit;font-weight:600;cursor:pointer;white-space:nowrap}
.vgoal button.b:hover{border-color:var(--focus)}
.vgoal button.b.pri{background:var(--accent);color:var(--accent-ink);border-color:transparent}
.vgoal button.b.warn{color:var(--err);border-color:var(--err-soft)}
.vgoal button.b.sm{padding:3px 8px;font-size:12px}
.vgoal button.b:disabled{opacity:.5;cursor:default}
.vgoal .tpl{display:flex;flex-direction:column;gap:6px}
.vgoal .tpl button{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;color:var(--text);font:inherit;cursor:pointer}
.vgoal .tpl button:hover{border-color:var(--accent)}
.vgoal .tpl.mine button{border-color:var(--accent);border-width:2px}
.vgoal .tpl button b{font-size:13.5px}
.vgoal .tpl button span{color:var(--dim);font-size:12px}
.vgoal .bar{position:relative;height:12px;border-radius:99px;background:var(--card3);overflow:hidden}
.vgoal .bar i{position:absolute;left:0;top:0;bottom:0;border-radius:99px;background:linear-gradient(90deg,var(--accent2),var(--violet));transition:width .5s}
.vgoal .bar.done i{background:linear-gradient(90deg,#ffd166,#ff8a3d)}
.vgoal .lv{display:flex;flex-direction:column;gap:3px}
.vgoal .lv div{display:flex;gap:8px;align-items:center;font-size:12.5px}
.vgoal .lv .ck{width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font-size:11px;background:var(--card3);color:var(--dim);flex:none}
.vgoal .lv .ck.hit{background:var(--ok);color:var(--accent-ink)}
.vgoal .clock{font:800 34px/1.1 "Segoe UI",system-ui,sans-serif;letter-spacing:.5px;font-variant-numeric:tabular-nums}
.vgoal .clock.paused{color:var(--dim)}
.vgoal .chips{display:flex;gap:4px;flex-wrap:wrap}
.vgoal .chip2{font-size:11.5px;font-weight:700;padding:2px 8px;border-radius:99px;background:var(--card3);color:var(--text)}
.vgoal .chip2.y{background:#ffd16633;color:var(--warn)}
.vgoal .chip2.p{background:#ff7ac833;color:var(--pink)}
.vgoal .chip2.b{background:var(--accent2-soft);color:var(--accent2)}
.vgoal .chip2.t{background:var(--err-soft);color:var(--err)}
.vgoal .log{display:flex;flex-direction:column;gap:2px;max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:4px;background:var(--bg2)}
.vgoal .log div{display:flex;gap:6px;align-items:center;font-size:12px;padding:3px 4px;border-radius:6px}
.vgoal .log div:nth-child(odd){background:var(--card2)}
.vgoal .log .t{color:var(--faint);font-variant-numeric:tabular-nums;flex:none}
.vgoal .log .x{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vgoal .log .ms{font-weight:700;font-variant-numeric:tabular-nums;flex:none}
.vgoal .log .ms.up{color:var(--ok)} .vgoal .log .ms.dn{color:var(--err)}
.vgoal .log .void .x,.vgoal .log .void .ms{text-decoration:line-through;opacity:.55}
.vgoal details{border:1px solid var(--line);border-radius:10px;padding:0 10px;background:var(--card)}
.vgoal details[open]{padding-bottom:10px}
.vgoal details > summary{cursor:pointer;padding:9px 0;font-weight:650;list-style:none}
.vgoal details > summary::before{content:'▸ ';color:var(--dim)} .vgoal details[open] > summary::before{content:'▾ '}
.vgoal .inc{display:flex;gap:8px;align-items:flex-start;padding:8px;border:1px solid var(--line);border-radius:10px;background:var(--card)}
.vgoal .inc .grow{flex:1;min-width:0}
.vgoal .sw{position:relative;width:34px;height:20px;border-radius:99px;background:var(--card3);border:1px solid var(--line2);cursor:pointer;flex:none;padding:0}
.vgoal .sw::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dim);transition:left .15s}
.vgoal .sw.on{background:var(--accent)} .vgoal .sw.on::after{left:16px;background:var(--accent-ink)}
.vgoal .warnbox{border:1px solid var(--warn);background:var(--warn-soft);border-radius:10px;padding:8px 10px;font-size:12.5px}
.vgoal .st{display:grid;grid-template-columns:1fr 1.3fr auto auto;gap:4px;align-items:center}
@media (max-width:420px){.vgoal .grid{grid-template-columns:1fr}.vgoal .clock{font-size:30px}}
`;

type Kid = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> | null = null, ...kids: (Kid | Kid[])[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'value') (e as HTMLInputElement).value = String(v);
    else if (k === 'checked') (e as HTMLInputElement).checked = !!v;
    else if (k === 'class') e.className = String(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}
async function call<T = PanelState>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j as { error?: string }).error || `${r.status}`) as Error & { status?: number }; e.status = r.status; throw e; }
  return j as T;
}
const ls = { get(k: string) { try { return localStorage.getItem(k); } catch { return null; } }, set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage off */ } } };
const clockOf = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const sw = (on: boolean, fn: (v: boolean) => void, label: string) => el('button', { class: `sw${on ? ' on' : ''}`, role: 'switch', 'aria-checked': String(on), 'aria-label': label, onClick: () => fn(!on) });

/** Fun Stream Deck actions a goal / incentive can fire (room cues, lights, celebrations, emotes …). */
const EFFECTS = DECK_ACTIONS.filter((a) => ['lighting', 'club', 'lounge', 'emote', 'expression', 'slap', 'warzone', 'weather', 'room', 'costume', 'accessory', 'raid', 'video', 'ambcam', 'camera'].includes(a.id));

type Tab = 'goals' | 'sub' | 'inc' | 'look';
const TABS: [Tab, string][] = [['goals', 'Goals'], ['sub', 'Subathon'], ['inc', 'Incentives'], ['look', 'On stream']];

let cached: HTMLElement | null = null;
/** The studio's Show tab section (one element, created once; it keeps its own state). */
export function goalsSection(): HTMLElement {
  if (cached) return cached;
  const s = el('section', { class: 'sec' }, el('h3', { class: 'sec-h', onClick: () => s.classList.toggle('collapsed') }, '🎯 Goals & subathon'), goalsPanel());
  s.dataset.key = 'goals-subathon';
  cached = s;
  return s;
}

export function goalsPanel(): HTMLElement {
  if (!document.getElementById('vgoal-css')) { const st = el('style', { id: 'vgoal-css' }); st.textContent = CSS; document.head.append(st); }
  const root = el('div', { class: 'vgoal' });
  let S: PanelState | null = null;
  let err: string | null = null;
  let offset = 0;
  let tab: Tab = (ls.get('vtp.goals.tab') as Tab) || 'goals';
  if (!TABS.some(([t]) => t === tab)) tab = 'goals';
  const ui = {
    edit: null as GoalDef | null, newGoal: false, adjust: null as string | null, adjVal: '', adjNote: '',
    addText: '', inc: null as Incentive | null, rules: null as SubathonConfig | null, wheel: '' as string, wheelEdit: false,
  };
  let lastRev = -1;
  let busy = false;

  const apply = (st: PanelState) => { S = st; err = null; offset = st.view.now - Date.now(); render(); };
  const run = (p: Promise<PanelState>, okMsg?: string) => {
    busy = true;
    p.then((st) => { busy = false; apply(st); if (okMsg) toast(okMsg, 'ok'); }).catch((e: Error & { status?: number }) => { busy = false; toast(e.message || 'That did not work', 'warn'); });
  };
  const load = () => call('GET', '/api/goals/state').then(apply).catch((e: Error & { status?: number }) => {
    err = 'down';
    render();
  });
  const editing = () => { const a = document.activeElement; return !!a && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); };
  // live: poll while on screen; the timer ticks locally from the absolute end
  const poll = window.setInterval(() => {
    if (!root.isConnected) { if (!document.body.contains(root) && cached && !cached.isConnected) { /* parked: keep state */ } return; }
    if (document.hidden || busy) return;
    void call('GET', '/api/goals/state').then((st) => {
      const changed = st.view.rev !== lastRev;
      S = st; err = null; offset = st.view.now - Date.now();
      if (changed && !editing() && !ui.edit && !ui.inc && !ui.rules) render(); else tickClock();
    }).catch(() => { /* the next poll tries again */ });
  }, 2000);
  window.setInterval(() => { if (root.isConnected) tickClock(); }, 250);
  void poll;

  function tickClock() {
    const c = root.querySelector('[data-clock]') as HTMLElement | null;
    const sub = S?.view.sub;
    if (!c || !sub) return;
    const now = Date.now() + offset;
    c.textContent = sub.ended ? 'Ended' : fmtClock(viewRemaining(sub, now));
    const up = root.querySelector('[data-uptime]') as HTMLElement | null;
    if (up) up.textContent = `Live for ${fmtClock(now - sub.startedAt)}`;
  }

  // ---------------------------------------------------------------- render
  function render() {
    const open = new Set([...root.querySelectorAll('details[data-k]')].filter((d) => (d as HTMLDetailsElement).open).map((d) => (d as HTMLElement).dataset.k));
    root.replaceChildren();
    if (!S) { root.append(el('p', { class: 'muted' }, err === 'down' ? 'Can’t reach VTube Pro right now. It will retry by itself.' : 'Loading…')); if (!err) void load(); return; }
    lastRev = S.view.rev;
    const v = S.view;
    // status line + test mode
    const shown = v.goals.filter((g) => g.show).length;
    const live = shown > 0 || !!v.sub;
    root.append(el('div', { class: 'status' }, el('span', { class: `dot${live ? ' live' : ''}` }),
      el('span', { class: 'grow' }, live ? `On stream: ${[shown ? `${shown} goal${shown === 1 ? '' : 's'}` : '', v.sub ? (v.sub.ended ? 'subathon (ended)' : 'subathon timer') : ''].filter(Boolean).join(' + ')}` : 'Nothing on stream yet'),
      el('label', { class: 'row', title: 'Fake events only: the overlay shows a copy, your real goals and timer never change' }, sw(S.test, (on) => run(call('POST', '/api/goals/test', { on }), on ? 'Test mode: fake events only' : 'Test mode off: back to the real numbers'), 'Test mode'), el('span', null, 'Test mode'))));
    if (S.test) root.append(el('div', { class: 'warnbox' }, el('b', null, 'Test mode. '), 'The stream shows a copy marked TEST. Fake events: ',
      ...['tip', 'sub', 'gift5', 'bits', 'big', 'raid'].map((w) => el('button', { class: 'b sm', style: 'margin:2px', onClick: () => run(call('POST', '/api/goals/test/event', { what: w })) }, ({ tip: '$10 tip', sub: 'Sub', gift5: '5 gifted', bits: '500 bits', big: '$50', raid: 'Raid' } as Record<string, string>)[w]))));
    root.append(el('div', { class: 'tabs', role: 'tablist' }, ...TABS.map(([t, label]) => el('button', { class: t === tab ? 'on' : '', role: 'tab', 'aria-selected': String(t === tab), onClick: () => { tab = t; ls.set('vtp.goals.tab', t); render(); } }, label))));
    if (tab === 'goals') renderGoals();
    else if (tab === 'sub') renderSub();
    else if (tab === 'inc') renderInc();
    else renderLook();
    for (const d of root.querySelectorAll('details[data-k]')) if (open.has((d as HTMLElement).dataset.k)) (d as HTMLDetailsElement).open = true;
    tickClock();
  }

  // ---------------------------------------------------------------- goals
  function renderGoals() {
    const st = S!, cur = st.cfg.currency;
    if (ui.edit) { root.append(goalEditor(ui.edit)); return; }
    if (!st.cfg.goals.length || ui.newGoal) {
      root.append(el('p', { class: 'muted' }, st.cfg.goals.length ? 'Pick one to add:' : 'Show a goal on stream. Pick one; you can change everything later.'),
        el('div', { class: 'tpl' }, ...GOAL_TEMPLATES.map((t) => el('button', { onClick: () => { ui.newGoal = false; run(call('POST', '/api/goals/template', { id: t.id }), `“${t.goal.title}” is on stream`); } }, el('b', null, t.label), el('span', null, t.hint))),
          el('button', { onClick: () => { ui.newGoal = false; ui.edit = blankGoal(); render(); } }, el('b', null, 'My own goal…'), el('span', null, 'Money, subs, bits, members, points or supporters, with stretch goals'))),
        st.cfg.goals.length ? el('button', { class: 'b', onClick: () => { ui.newGoal = false; render(); } }, 'Cancel') : '');
      if (!st.cfg.goals.length) return;
    }
    for (const g of st.cfg.goals) {
      const live = st.view.goals.find((x) => x.id === g.id);
      if (!live) continue;
      const { target } = liveTarget(live);
      const done = live.reached >= live.levels.length;
      const card = el('div', { class: 'card' },
        el('h5', null, el('span', { class: 'grow', title: g.title }, g.title), el('span', { class: 'chip2 b' }, g.metric), g.reset === 'stream' ? el('span', { class: 'chip2', title: 'Starts over every stream' }, 'per stream') : null),
        el('div', { class: 'row' }, el('b', null, fmtMetric(live.value, g.metric, cur)), el('span', { class: 'muted' }, `of ${fmtMetric(target, g.metric, cur)}${live.levels.length > 1 ? ` · ${live.reached}/${live.levels.length} reached` : ''}`)),
        el('div', { class: `bar${done ? ' done' : ''}` }, el('i', { style: `width:${Math.min(100, (live.value / Math.max(1e-9, target)) * 100).toFixed(1)}%` })),
        live.levels.length > 1 || g.reward ? el('div', { class: 'lv' }, ...live.levels.map((l, i) => el('div', null, el('span', { class: `ck${l.hit ? ' hit' : ''}` }, l.hit ? '✓' : String(i + 1)), el('b', null, fmtMetric(l.target, g.metric, cur)), el('span', { class: 'muted' }, (i ? g.stretch[i - 1]?.reward : g.reward) || (i ? `Stretch ${i}` : 'Goal'), i && g.stretch[i - 1]?.hidden && !l.hit ? ' (hidden until reached)' : '')))) : null,
        el('div', { class: 'row' },
          el('label', { class: 'row', title: 'Show it on stream' }, sw(g.show, (on) => run(call('POST', '/api/goals/goal', { ...g, show: on })), 'On stream'), el('span', { class: 'muted' }, 'On stream')),
          el('span', { class: 'grow' }),
          el('button', { class: 'b sm', onClick: () => { ui.adjust = ui.adjust === g.id ? null : g.id; ui.adjVal = ''; ui.adjNote = ''; render(); } }, '± Adjust'),
          el('button', { class: 'b sm', onClick: () => { ui.edit = JSON.parse(JSON.stringify(g)) as GoalDef; render(); } }, 'Edit')),
        ui.adjust === g.id ? el('div', { class: 'row' },
          el('input', { type: 'number', step: 'any', placeholder: g.metric === 'money' ? 'e.g. 25 or -5' : 'e.g. 3 or -1', value: ui.adjVal, class: 'grow', style: 'max-width:120px', onInput: (e: Event) => { ui.adjVal = (e.target as HTMLInputElement).value; } }),
          el('input', { type: 'text', placeholder: 'Why (e.g. PayPal tip)', value: ui.adjNote, class: 'grow', onInput: (e: Event) => { ui.adjNote = (e.target as HTMLInputElement).value; } }),
          el('button', { class: 'b sm pri', onClick: () => { const d = Number(ui.adjVal); if (!d) { toast('Type an amount (a minus sign takes off)', 'warn'); return; } ui.adjust = null; run(call('POST', `/api/goals/goal/${g.id}/adjust`, { delta: d, note: ui.adjNote }), 'Added to the goal (in the log, undo-able)'); } }, 'Add')) : null);
      root.append(card);
    }
    root.append(el('div', { class: 'row' },
      st.cfg.goals.length < 8 ? el('button', { class: 'b', onClick: () => { ui.newGoal = true; render(); } }, '+ Another goal') : null,
      el('button', { class: 'b', title: 'Every-stream goals start over now (they also do when OBS starts streaming, or after a long break)', onClick: () => run(call('POST', '/api/goals/new-stream'), 'New stream: every-stream goals start over') }, 'New stream')));
    root.append(eventLog());
  }

  function blankGoal(): GoalDef {
    return { id: '', title: 'Stream goal', metric: 'money', weights: {}, filter: { sources: [], kinds: [], test: false, minValue: 0 }, target: 100, reward: '', stretch: [], startAt: 0, reset: 'stream', show: true, color: '' };
  }

  function goalEditor(g: GoalDef): HTMLElement {
    const cur = S!.cfg.currency;
    const set = (p: Partial<GoalDef>) => { Object.assign(g, p); };
    const unit = g.metric === 'money' ? cur : g.metric;
    const stretchRows = el('div', { class: 'lv' });
    const paintStretch = () => {
      stretchRows.replaceChildren(...g.stretch.map((s, i) => el('div', { class: 'st' },
        el('input', { type: 'number', min: 0, step: 'any', value: s.target, title: 'Target', 'aria-label': `Stretch ${i + 1} target`, onInput: (e: Event) => { s.target = Number((e.target as HTMLInputElement).value) || 0; } }),
        el('input', { type: 'text', value: s.reward, placeholder: 'Reward (e.g. outfit change)', 'aria-label': `Stretch ${i + 1} reward`, maxLength: 80, onInput: (e: Event) => { s.reward = (e.target as HTMLInputElement).value; } }),
        el('label', { class: 'row tiny', title: 'Show "???" until reached or unlocked' }, el('input', { type: 'checkbox', checked: s.hidden, onChange: (e: Event) => { s.hidden = (e.target as HTMLInputElement).checked; } }), '???'),
        el('button', { class: 'b sm warn', title: 'Remove', onClick: () => { g.stretch.splice(i, 1); paintStretch(); } }, '×'))),
        g.stretch.length < 10 ? el('button', { class: 'b sm', onClick: () => { const last = g.stretch[g.stretch.length - 1]?.target ?? g.target; g.stretch.push({ id: `s${Date.now().toString(36)}${g.stretch.length}`, target: Math.round(last * 1.5), reward: '', hidden: false } as StretchGoal); paintStretch(); } }, '+ Stretch goal') : '');
    };
    paintStretch();
    const kinds = el('div', { class: 'row' }, ...SUPPORT_KINDS.filter((k) => k !== 'other').map((k) => el('label', { class: 'row tiny' }, el('input', { type: 'checkbox', checked: g.filter.kinds.includes(k), onChange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; g.filter.kinds = on ? [...g.filter.kinds, k] : g.filter.kinds.filter((x) => x !== k); } }), k.replace('_', ' '))));
    const plats = el('div', { class: 'row' }, ...(['twitch', 'youtube', 'kick', 'rumble', 'tiktok', 'kofi', 'patreon', 'fourthwall', 'throne', 'streamelements', 'streamlabs'] as const).map((p) => el('label', { class: 'row tiny' }, el('input', { type: 'checkbox', checked: g.filter.sources.includes(p), onChange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; g.filter.sources = on ? [...g.filter.sources, p] : g.filter.sources.filter((x) => x !== p); } }), p)));
    const effect = actionPicker(g.action, (a) => { g.action = a; });
    return el('div', { class: 'card' },
      el('h5', null, el('span', { class: 'grow' }, g.id ? 'Edit goal' : 'New goal')),
      el('div', { class: 'grid' },
        el('label', null, 'Name', el('input', { type: 'text', value: g.title, maxLength: 48, onInput: (e: Event) => set({ title: (e.target as HTMLInputElement).value }) })),
        el('label', null, 'Counts', el('select', { onChange: (e: Event) => { set({ metric: (e.target as HTMLSelectElement).value as GoalMetric }); render(); } }, ...GOAL_METRICS.map((m) => el('option', { value: m, selected: m === g.metric }, METRIC_LABEL[m])))),
        el('label', null, `Target (${unit})`, el('input', { type: 'number', min: 0, step: 'any', value: g.target, onInput: (e: Event) => set({ target: Number((e.target as HTMLInputElement).value) || 0 }) })),
        el('label', null, 'Reward at the target', el('input', { type: 'text', value: g.reward, maxLength: 80, placeholder: 'e.g. karaoke hour', onInput: (e: Event) => set({ reward: (e.target as HTMLInputElement).value }) })),
        el('label', null, 'Starts over', el('select', { onChange: (e: Event) => set({ reset: (e.target as HTMLSelectElement).value as GoalDef['reset'] }) }, ...(['stream', 'manual', 'never'] as const).map((r) => el('option', { value: r, selected: r === g.reset }, RESET_LABEL[r])))),
        el('label', null, 'Bar colour', el('input', { type: 'text', value: g.color, placeholder: 'auto (the room’s)', maxLength: 7, onInput: (e: Event) => set({ color: (e.target as HTMLInputElement).value.trim() }) }))),
      el('b', { class: 'tiny' }, 'STRETCH GOALS (in order, past the target)'), stretchRows,
      el('details', { 'data-k': 'gfx' }, el('summary', null, 'When it is reached'), el('p', { class: 'muted' }, 'A fanfare plays and the stream celebrates by default. Add an effect:'), effect),
      el('details', { 'data-k': 'gfilter' }, el('summary', null, 'What counts (default: everything that fits)'),
        el('p', { class: 'tiny' }, 'Platforms (none ticked = all):'), plats,
        el('p', { class: 'tiny' }, 'Kinds (none ticked = the usual for this goal):'), kinds,
        el('div', { class: 'grid' },
          g.metric === 'money' ? el('label', null, `Smallest amount that counts (${cur})`, el('input', { type: 'number', min: 0, step: 'any', value: g.filter.minValue, onInput: (e: Event) => { g.filter.minValue = Number((e.target as HTMLInputElement).value) || 0; } })) : null),
        el('p', { class: 'tiny' }, 'Test alerts (the Chat tab’s “Send test”, platform dashboards) only count in test mode, never in your real goals.')),
      el('div', { class: 'row' },
        el('button', { class: 'b pri', onClick: () => { const d = g; ui.edit = null; run(call('POST', '/api/goals/goal', d.id ? d : { ...d, id: undefined }), 'Saved'); } }, 'Save'),
        el('button', { class: 'b', onClick: () => { ui.edit = null; render(); } }, 'Cancel'),
        el('span', { class: 'grow' }),
        g.id ? el('button', { class: 'b warn', title: 'Start counting from zero now (the events stay in the log)', onClick: () => { if (!confirm(`Start “${g.title}” over from zero?`)) return; ui.edit = null; run(call('POST', `/api/goals/goal/${g.id}/reset`), 'Started over'); } }, 'Start over') : null,
        g.id ? el('button', { class: 'b warn', onClick: () => { if (!confirm(`Delete “${g.title}”?`)) return; ui.edit = null; run(call('DELETE', `/api/goals/goal/${g.id}`), 'Deleted'); } }, 'Delete') : null));
  }

  function eventLog(): HTMLElement {
    const st = S!;
    const rows = st.recent.slice(0, 60);
    return el('details', { 'data-k': 'elog' }, el('summary', null, `Counted support (${rows.length ? 'newest first' : 'none yet'})`),
      el('p', { class: 'tiny' }, 'Everything counted, from every platform. Undo takes a mis-counted one out of every goal (and its time off the subathon).'),
      rows.length ? el('div', { class: 'log' }, ...rows.map((r) => el('div', { class: r.void ? 'void' : '' }, el('span', { class: 't' }, clockOf(r.at)), el('span', { class: 'x', title: `${r.source} · ${r.kind} · via ${r.origin}` }, `${r.who}: ${r.label}${r.test ? ' (test)' : ''}${r.timerUnknown ? ' · counted before an update: Undo changes the goals only, not the timer' : ''}`),
        el('button', { class: 'b sm', onClick: () => run(call('POST', `/api/goals/entry/${r.seq}/void`, { void: !r.void })) }, r.void ? 'Redo' : 'Undo')))) : el('p', { class: 'muted' }, 'Support from Twitch, YouTube, Kick, Rumble, TikTok (and tip sites once connected) shows up here.'),
      st.adjust.length ? el('div', { class: 'log' }, ...st.adjust.map((a) => el('div', { class: a.void ? 'void' : '' }, el('span', { class: 't' }, clockOf(a.at)), el('span', { class: 'x' }, `${st.cfg.goals.find((g) => g.id === a.goalId)?.title ?? 'goal'}: ${a.delta > 0 ? '+' : ''}${a.delta} by ${a.by}${a.note ? ` (${a.note})` : ''}`),
        el('button', { class: 'b sm', onClick: () => run(call('POST', `/api/goals/entry/${a.seq}/void`, { void: !a.void })) }, a.void ? 'Redo' : 'Undo')))) : null);
  }

  // ---------------------------------------------------------------- subathon
  function renderSub() {
    const st = S!, sub = st.view.sub, cur = st.cfg.currency, mine = st.cfg.subathon;
    // (the rules already set up here - by hand, a preset or an AI - come first: a template replaces them)
    const startMine = () => run(call('POST', '/api/goals/sub/start', { config: mine }), `${mine.title} started: ${fmtSpan(mine.startMs)} on the clock`);
    const mineCard = () => el('div', { class: 'tpl mine' }, el('button', { class: 'pri', onClick: startMine },
      el('b', null, `Start “${mine.title}”`), el('span', null, `Your rules: ${fmtSpan(mine.startMs)} on the clock · ${fmtSpan(mine.rules.sub[0] * 1000)} per sub · ${fmtMoney(1, cur)} = ${fmtSpan(mine.rules.perMoney * 1000)}`)));
    if (!sub) {
      root.append(el('p', { class: 'muted' }, 'A countdown on stream that supporters push back: every sub, gift, tip, bit and member adds time, from every platform at once.'),
        mineCard(),
        el('p', { class: 'muted' }, 'Or start from a template instead (it replaces your rules):'),
        el('div', { class: 'tpl' },
          el('button', { onClick: () => run(call('POST', '/api/goals/sub/start', { template: 'classic' }), 'Subathon started: 12 h on the clock') }, el('b', null, 'Subathon: 12 h start, 5 / 10 / 15 min per sub tier'), el('span', null, `Gifted subs count each · ${fmtMoney(1, cur)} = 1 min · 100 bits = 1 min · member = 5 min`)),
          el('button', { onClick: () => run(call('POST', '/api/goals/sub/start', { template: 'chill' }), 'Subathon started: 4 h on the clock') }, el('b', null, 'Chill: 4 h start, 2 / 4 / 6 min per sub'), el('span', null, `${fmtMoney(1, cur)} = 30 s · a shorter, gentler timer`)),
          el('button', { onClick: () => run(call('POST', '/api/goals/sub/start', { template: 'weekend' }), 'Weekend subathon started') }, el('b', null, 'Weekend: 24 h start, 72 h max, sleep mode at night'), el('span', null, 'Time added slows down after the first day (decay) so it can end'))),
        rulesEditor(st.cfg.subathon, false));
      if (st.history.length) root.append(historyBox());
      return;
    }
    const now = Date.now() + offset;
    const card = el('div', { class: `card${st.test ? ' test' : ''}` },
      el('h5', null, el('span', { class: 'grow' }, sub.title), sub.ended ? el('span', { class: 'chip2 y' }, 'ENDED') : sub.paused ? el('span', { class: 'chip2' }, 'PAUSED') : el('span', { class: 'chip2 b' }, 'RUNNING')),
      el('div', { class: `clock${sub.paused ? ' paused' : ''}`, 'data-clock': '1', 'aria-live': 'off' }, sub.ended ? 'Ended' : fmtClock(viewRemaining(sub, now))),
      el('div', { class: 'muted', 'data-uptime': '1' }, `Live for ${fmtClock(now - sub.startedAt)}`),
      el('div', { class: 'chips' },
        sub.mult !== 1 ? el('span', { class: 'chip2 y' }, `Time ×${sub.mult}`) : null,
        sub.happy ? el('span', { class: 'chip2 y' }, `Happy hour ×${sub.happy.mult} until ${clockOf(sub.happy.until - offset)}`) : null,
        sub.hype ? el('span', { class: 'chip2 p' }, `Hype ×${sub.hype.mult}`) : null,
        sub.sleep ? el('span', { class: 'chip2 b' }, 'Sleep mode') : null,
        el('span', { class: 'chip2' }, [`${sub.stats.subs} sub${sub.stats.subs === 1 ? '' : 's'}`, fmtMoney(sub.stats.money, cur), sub.stats.bits ? `${sub.stats.bits.toLocaleString('en-US')} bits` : ''].filter(Boolean).join(' · '))));
    if (sub.ended) {
      card.append(el('p', { class: 'muted' }, sub.summary ? `Ran ${fmtSpan(sub.summary.lengthMs)}; supporters added ${fmtSpan(sub.summary.addedMs)}.${sub.summary.biggest ? ` Biggest: ${sub.summary.biggest}.` : ''}` : ''),
        el('div', { class: 'row' }, el('button', { class: 'b pri', onClick: () => run(call('POST', '/api/goals/sub/reopen', { ms: 3_600_000 }), 'Back on: 1 h on the clock') }, 'Keep going (+1 h)'), el('button', { class: 'b', onClick: () => run(call('POST', '/api/goals/sub/stop'), 'Taken off stream (kept in history)') }, 'Take it off stream'),
          // (a new night: this one goes to history, a fresh clock starts with the rules set up here)
          el('button', { class: 'b', title: `This one goes to history; “${mine.title}” starts with ${fmtSpan(mine.startMs)} on the clock`, onClick: () => run(call('POST', '/api/goals/sub/stop').then(() => call('POST', '/api/goals/sub/start', { config: mine })), `${mine.title} started: ${fmtSpan(mine.startMs)} on the clock`) }, 'Start fresh with my rules')));
    } else {
      const add = (ms: number, l: string) => el('button', { class: 'b sm', onClick: () => run(call('POST', '/api/goals/sub/add', { ms }), `${l} ${ms > 0 ? 'added' : 'taken off'}`) }, l);
      card.append(
        el('div', { class: 'row' },
          el('button', { class: `b ${sub.paused ? 'pri' : ''}`, onClick: () => run(call('POST', '/api/goals/sub/pause', { on: !sub.paused }), sub.paused ? 'Resumed' : 'Paused: time is frozen') }, sub.paused ? '▶ Resume' : '⏸ Pause'),
          el('button', { class: 'b', title: 'Undo the last time change', onClick: () => run(call('POST', '/api/goals/sub/undo', { n: 1 }), 'Undone') }, '↩ Undo last'),
          el('button', { class: 'b', onClick: () => run(call('POST', '/api/goals/wheel/spin'), 'Spinning the wheel on stream') }, '🎡 Spin')),
        el('div', { class: 'row' }, add(300_000, '+5m'), add(900_000, '+15m'), add(3_600_000, '+1h'), add(-300_000, '−5m'),
          el('input', { type: 'text', placeholder: '1h30m or -10m', value: ui.addText, class: 'grow', style: 'max-width:130px', 'aria-label': 'Time to add', onInput: (e: Event) => { ui.addText = (e.target as HTMLInputElement).value; }, onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') (e.target as HTMLElement).nextElementSibling?.dispatchEvent(new MouseEvent('click')); } }),
          el('button', { class: 'b sm pri', onClick: () => { const t = ui.addText.trim(); const ms = (t.startsWith('-') ? -1 : 1) * parseDuration(t.replace(/^[+-]/, '')); if (!ms) { toast('Type a time like 5m, 1h30m or -10m', 'warn'); return; } ui.addText = ''; run(call('POST', '/api/goals/sub/add', { ms }), `${fmtSpan(Math.abs(ms))} ${ms > 0 ? 'added' : 'taken off'}`); } }, 'Add')),
        el('div', { class: 'row' },
          sub.happy ? el('button', { class: 'b sm', onClick: () => run(call('POST', '/api/goals/sub/happy', { mult: 1, ms: 0 }), 'Happy hour off') }, 'Happy hour off')
            : [el('button', { class: 'b sm', onClick: () => run(call('POST', '/api/goals/sub/happy', { mult: 2, ms: 1_800_000 }), 'Happy hour: time ×2 for 30 min') }, 'Happy hour 2× 30m'), el('button', { class: 'b sm', onClick: () => run(call('POST', '/api/goals/sub/happy', { mult: 3, ms: 900_000 }), 'Happy hour: time ×3 for 15 min') }, '3× 15m')],
          el('button', { class: 'b sm', onClick: () => run(call('POST', '/api/goals/sub/sleep', {}), sub.sleep ? 'Sleep mode off' : 'Sleep mode on: reduced rates') }, sub.sleep ? 'Sleep mode off' : '😴 Sleep mode'),
          el('span', { class: 'grow' }),
          el('button', { class: 'b sm warn', onClick: () => { if (!confirm('End the subathon and take it off stream? (Its summary stays in the history.)')) return; run(call('POST', '/api/goals/sub/stop'), 'Subathon ended'); } }, 'End')));
    }
    root.append(card);
    if (sub.top.length) root.append(el('div', { class: 'card' }, el('h5', null, 'Time added by'), ...sub.top.map((r, i) => el('div', { class: 'row' }, el('b', null, `${i + 1}.`), el('span', { class: 'grow' }, r.name), el('b', null, `+${fmtClock(r.ms, false)}`)))));
    root.append(rulesEditor(st.cfg.subathon, true), auditLog());
    if (st.history.length) root.append(historyBox());
  }

  function rulesEditor(c0: SubathonConfig, running: boolean): HTMLElement {
    const c = ui.rules ?? (JSON.parse(JSON.stringify(c0)) as SubathonConfig);
    const touch = () => { ui.rules = c; };
    const r = c.rules, cur = S!.cfg.currency;
    const minIn = (label: string, get: () => number, put: (v: number) => void, unit = 'min', step = 0.5) => el('label', null, label, el('input', { type: 'number', min: 0, step, value: +(get() / (unit === 'min' ? 60 : unit === 'h' ? 3600 : 1)).toFixed(2), onInput: (e: Event) => { put((Number((e.target as HTMLInputElement).value) || 0) * (unit === 'min' ? 60 : unit === 'h' ? 3600 : 1)); touch(); } }));
    const dt = (t: number) => (t ? new Date(t - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');
    return el('details', { 'data-k': 'rules' }, el('summary', null, running ? 'Rules, caps + multipliers (changes apply to new support)' : 'Change the rules before you start'),
      el('div', { class: 'grid' },
        el('label', null, 'Name on stream', el('input', { type: 'text', value: c.title, maxLength: 40, onInput: (e: Event) => { c.title = (e.target as HTMLInputElement).value; touch(); } })),
        minIn('Starting time (hours)', () => c.startMs / 1000, (v) => { c.startMs = v * 1000; }, 'h'),
        minIn('Sub, tier 1 (min)', () => r.sub[0], (v) => { r.sub[0] = v; }), minIn('Sub, tier 2 (min)', () => r.sub[1], (v) => { r.sub[1] = v; }),
        minIn('Sub, tier 3 (min)', () => r.sub[2], (v) => { r.sub[2] = v; }), minIn('Prime sub (min)', () => r.prime, (v) => { r.prime = v; }),
        el('label', null, 'Gifted sub = × a sub', el('input', { type: 'number', min: 0, step: 0.25, value: r.giftMult, onInput: (e: Event) => { r.giftMult = Number((e.target as HTMLInputElement).value) || 0; touch(); } })),
        minIn(`Each ${fmtMoney(1, cur)} (min)`, () => r.perMoney, (v) => { r.perMoney = v; }, 'min', 0.25),
        minIn('Each 100 bits (min)', () => r.per100Bits, (v) => { r.per100Bits = v; }, 'min', 0.25), minIn('New member / patron (min)', () => r.perMember, (v) => { r.perMember = v; }),
        minIn('Each 100 Kicks (min)', () => r.per100Kicks, (v) => { r.per100Kicks = v; }, 'min', 0.25),
        el('label', null, `Smallest tip that counts (${cur})`, el('input', { type: 'number', min: 0, step: 0.5, value: r.minMoney, onInput: (e: Event) => { r.minMoney = Number((e.target as HTMLInputElement).value) || 0; touch(); } })),
        minIn('Follow bonus (min)', () => r.follow, (v) => { r.follow = v; }, 'min', 0.25), minIn('Raid bonus (min)', () => r.raid, (v) => { r.raid = v; }),
        el('label', null, 'Raid: seconds per viewer', el('input', { type: 'number', min: 0, step: 1, value: r.raidPerViewer, onInput: (e: Event) => { r.raidPerViewer = Number((e.target as HTMLInputElement).value) || 0; touch(); } })),
        el('label', null, 'On stream shows', el('select', { onChange: (e: Event) => { c.display = (e.target as HTMLSelectElement).value as SubathonConfig['display']; touch(); } }, ...([['remaining', 'Time left'], ['uptime', 'Time running'], ['both', 'Both']] as const).map(([k, l]) => el('option', { value: k, selected: c.display === k }, l))))),
      el('b', { class: 'tiny' }, 'CAPS'),
      el('div', { class: 'grid' },
        el('label', null, 'Never run past', el('input', { type: 'datetime-local', value: dt(c.caps.maxEndAt), onInput: (e: Event) => { const v = (e.target as HTMLInputElement).value; c.caps.maxEndAt = v ? new Date(v).getTime() : 0; touch(); } })),
        minIn('Longest in total (hours, 0 = none)', () => c.caps.maxTotalMs / 1000, (v) => { c.caps.maxTotalMs = v * 1000; }, 'h'),
        minIn('Most one support adds (min, 0 = none)', () => c.caps.perEventMs / 1000, (v) => { c.caps.perEventMs = v * 1000; }),
        el('label', { class: 'row', style: 'flex-direction:row;align-items:center' }, el('input', { type: 'checkbox', checked: c.pauseCounts, onChange: (e: Event) => { c.pauseCounts = (e.target as HTMLInputElement).checked; touch(); } }), 'Support adds time while paused')),
      el('b', { class: 'tiny' }, 'SLOW IT DOWN / SPEED IT UP'),
      el('div', { class: 'grid' },
        el('label', { class: 'row', style: 'flex-direction:row;align-items:center' }, el('input', { type: 'checkbox', checked: c.decay.on, onChange: (e: Event) => { c.decay.on = (e.target as HTMLInputElement).checked; touch(); } }), 'Decay: added time shrinks'),
        minIn('…after this much was added (h)', () => c.decay.afterMs / 1000, (v) => { c.decay.afterMs = v * 1000; }, 'h'),
        minIn('…halving every (h)', () => c.decay.halveEveryMs / 1000, (v) => { c.decay.halveEveryMs = Math.max(60, v) * 1000; }, 'h'),
        el('label', { class: 'row', style: 'flex-direction:row;align-items:center' }, el('input', { type: 'checkbox', checked: c.hype.on, onChange: (e: Event) => { c.hype.on = (e.target as HTMLInputElement).checked; touch(); } }), `Hype: ${c.hype.events} supports in ${fmtSpan(c.hype.windowMs)} = ×${c.hype.mult} for ${fmtSpan(c.hype.ms)}`),
        el('label', { class: 'row', style: 'flex-direction:row;align-items:center' }, el('input', { type: 'checkbox', checked: c.sleep.auto, onChange: (e: Event) => { c.sleep.auto = (e.target as HTMLInputElement).checked; touch(); } }), 'Sleep mode every night'),
        el('label', null, 'Sleep from – to', el('div', { class: 'row' },
          el('input', { type: 'text', value: hhmm(c.sleep.from), style: 'max-width:70px', 'aria-label': 'Sleep from', onInput: (e: Event) => { c.sleep.from = parseHm((e.target as HTMLInputElement).value, c.sleep.from); touch(); } }),
          el('input', { type: 'text', value: hhmm(c.sleep.to), style: 'max-width:70px', 'aria-label': 'Sleep to', onInput: (e: Event) => { c.sleep.to = parseHm((e.target as HTMLInputElement).value, c.sleep.to); touch(); } }))),
        el('label', null, 'Sleep mode rate (%)', el('input', { type: 'number', min: 0, max: 100, step: 5, value: Math.round(c.sleep.mult * 100), onInput: (e: Event) => { c.sleep.mult = (Number((e.target as HTMLInputElement).value) || 0) / 100; touch(); } }))),
      el('b', { class: 'tiny' }, 'HAPPY HOURS ON A SCHEDULE'),
      el('div', { class: 'lv' }, ...c.happy.map((h, i) => el('div', null, el('span', { class: 'grow' }, `${new Date(h.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · ×${h.mult} for ${fmtSpan(h.ms)}`), el('button', { class: 'b sm warn', onClick: () => { c.happy.splice(i, 1); touch(); render(); } }, '×'))),
        el('div', { class: 'row' }, el('button', { class: 'b sm', onClick: () => { c.happy.push({ at: Date.now() + 3_600_000, ms: 3_600_000, mult: 2 }); touch(); render(); } }, '+ In an hour, 2× for 1 h'))),
      el('div', { class: 'row' },
        el('button', { class: 'b pri', onClick: () => { const cfg = sanitizeSubathon(c); ui.rules = null; run(running ? call('POST', '/api/goals/sub/config', { config: cfg }) : call('POST', '/api/goals/sub/start', { config: cfg }), running ? 'Rules saved' : 'Subathon started'); } }, running ? 'Save rules' : 'Start with these rules'),
        ui.rules ? el('button', { class: 'b', onClick: () => { ui.rules = null; render(); } }, 'Discard changes') : null));
  }

  function auditLog(): HTMLElement {
    const st = S!;
    const rows = st.subLog.slice(0, 120);
    return el('details', { 'data-k': 'audit' }, el('summary', null, 'Timer log (every change, with Undo)'),
      el('div', { class: 'log' }, ...rows.map((l) => el('div', { class: l.undone ? 'void' : '' }, el('span', { class: 't' }, clockOf(l.at)), el('span', { class: 'x', title: `${l.label}${l.mult && l.mult !== 1 ? ` · ×${l.mult}` : ''}${l.capped ? ` · ${l.capped}` : ''}${l.who ? ` · ${l.who}` : ''}` }, `${l.label}${l.capped ? ` (${l.capped})` : ''}`),
        l.ms ? el('span', { class: `ms ${l.ms > 0 ? 'up' : 'dn'}` }, `${l.ms > 0 ? '+' : '−'}${fmtClock(Math.abs(l.ms), false)}`) : null,
        (l.kind === 'event' || l.kind === 'adjust') && (l.ms || l.stat) ? (l.undone
          ? el('button', { class: 'b sm', title: 'Put it back: its time (what fits, while the timer runs) and its credit', onClick: () => run(call('POST', '/api/goals/sub/redo', { seq: l.seq }), 'Redone') }, 'Redo')
          : el('button', { class: 'b sm', onClick: () => run(call('POST', '/api/goals/sub/undo', { seq: l.seq }), 'Undone') }, 'Undo')) : null))));
  }
  function historyBox(): HTMLElement {
    const st = S!;
    return el('details', { 'data-k': 'hist' }, el('summary', null, `Past subathons (${st.history.length})`),
      ...st.history.map((h) => el('div', { class: 'muted' }, `${new Date(h.startedAt).toLocaleDateString()}: ${h.title}, ran ${fmtSpan(h.lengthMs)} · ${h.stats.subs + h.stats.gifted} subs · ${fmtMoney(h.stats.money, st.cfg.currency)}${h.top[0] ? ` · top: ${h.top[0].name}` : ''}`)));
  }

  // ---------------------------------------------------------------- incentives
  function renderInc() {
    const st = S!, cur = st.cfg.currency;
    const mine = st.cfg.incentives;
    const save = (list: Incentive[], msg?: string) => run(call('PUT', '/api/goals/config', { incentives: list }), msg);
    root.append(el('p', { class: 'muted' }, 'Get viewers to do stuff: when something happens on stream, something fun happens. Switch on a ready one or make your own.'));
    root.append(el('b', { class: 'tiny' }, 'READY-MADE'));
    for (const p of st.presets) {
      const on = mine.find((i) => i.id === p.id);
      root.append(el('div', { class: 'inc' }, sw(!!on?.on, (v) => save(on ? mine.map((i) => (i.id === p.id ? { ...i, on: v } : i)) : [...mine, { ...p, on: true }], v ? `On: ${p.name}` : `Off: ${p.name}`), p.name),
        el('div', { class: 'grow' }, el('div', null, p.name), el('div', { class: 'tiny' }, incentiveText(p, cur))),
        el('button', { class: 'b sm', title: 'A TEST preview on stream: nothing real changes', onClick: () => tryInc(p.id) }, 'Try')));
    }
    const custom = mine.filter((i) => !st.presets.some((p) => p.id === i.id));
    root.append(el('b', { class: 'tiny' }, 'YOUR OWN'));
    for (const i of custom) root.append(el('div', { class: 'inc' }, sw(i.on, (v) => save(mine.map((x) => (x.id === i.id ? { ...x, on: v } : x))), i.name),
      el('div', { class: 'grow' }, el('div', null, i.name), el('div', { class: 'tiny' }, incentiveText(i, cur))),
      el('button', { class: 'b sm', title: 'A TEST preview on stream: nothing real changes', onClick: () => tryInc(i.id) }, 'Try'),
      el('button', { class: 'b sm warn', onClick: () => save(mine.filter((x) => x.id !== i.id), 'Removed') }, '×')));
    root.append(ui.inc ? incBuilder(ui.inc) : el('button', { class: 'b', onClick: () => { ui.inc = { id: '', name: '', on: true, when: { on: 'support', kinds: [], unit: 'money', min: 5, every: false }, then: [{ do: 'message', text: 'Thank you {name}!' }] }; render(); } }, '+ Make my own'));
    // the wheel
    const wheelText = ui.wheelEdit ? ui.wheel : st.cfg.wheel.map((s) => (s.weight !== 1 ? `${s.label} ×${s.weight}` : s.label)).join('\n');
    root.append(el('details', { 'data-k': 'wheel' }, el('summary', null, `The wheel (${st.cfg.wheel.length} slots)`),
      el('p', { class: 'tiny' }, 'One slot per line. "×3" at the end makes a slot 3 times as likely. A slot like "+15 minutes" or "-10 min" changes the subathon by itself.'),
      el('textarea', { value: wheelText, 'aria-label': 'Wheel slots', onInput: (e: Event) => { ui.wheel = (e.target as HTMLTextAreaElement).value; ui.wheelEdit = true; } }),
      el('div', { class: 'row' }, el('button', { class: 'b pri', onClick: () => {
        const slots = ui.wheel.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const m = /^(.*?)\s*[×x]\s*(\d+(?:\.\d+)?)$/.exec(l); return m ? { label: m[1], weight: Number(m[2]) } : { label: l, weight: 1 }; });
        if (slots.length < 2) { toast('The wheel needs at least 2 slots', 'warn'); return; }
        ui.wheelEdit = false; run(call('PUT', '/api/goals/config', { wheel: slots }), 'Wheel saved');
      } }, 'Save wheel'), el('button', { class: 'b', onClick: () => run(call('POST', '/api/goals/wheel/spin'), 'Spinning on stream') }, '🎡 Spin now'))));
    // mod commands
    const off = new Set(st.cfg.mods.off);
    root.append(el('details', { 'data-k': 'mods' }, el('summary', null, `Mod chat commands (${st.cfg.mods.on ? 'on' : 'off'})`),
      el('div', { class: 'row' }, sw(st.cfg.mods.on, (on) => run(call('PUT', '/api/goals/config', { mods: { ...st.cfg.mods, on } })), 'Mod commands'), el('span', null, 'Your moderators (and you) can run these in chat, on every platform. Nobody else can.')),
      ...MOD_COMMANDS.map((m) => el('div', { class: 'row' }, el('input', { type: 'checkbox', checked: !off.has(m.cmd), disabled: !st.cfg.mods.on, 'aria-label': m.usage, onChange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; run(call('PUT', '/api/goals/config', { mods: { ...st.cfg.mods, off: on ? st.cfg.mods.off.filter((x) => x !== m.cmd) : [...st.cfg.mods.off, m.cmd] } })); } }), el('code', null, m.usage), el('span', { class: 'tiny' }, m.what)))));
  }

  /** Try = a TEST preview in test mode (the real timer, room cues and sounds are never touched). Off = ask first: the
   *  stream shows the TEST copy until test mode is switched off again. */
  function tryInc(id: string) {
    if (!S!.test && !confirm('Try shows it on stream as a TEST preview: test mode switches on (the stream shows a copy marked TEST; your real goals, timer, room and sounds are not touched). Switch test mode off again when you are done. Go?')) return;
    run(call('POST', `/api/goals/incentive/${id}/try`), 'Test preview on stream (test mode is on)');
  }

  function incBuilder(i: Incentive): HTMLElement {
    const w = i.when;
    const cur = S!.cfg.currency;
    const whenSel = el('select', { 'aria-label': 'When', onChange: (e: Event) => {
      const k = (e.target as HTMLSelectElement).value;
      i.when = k === 'every' ? { on: 'support', kinds: [], unit: 'money', min: 10, every: true } : k === 'support' ? { on: 'support', kinds: [], unit: 'money', min: 5, every: false }
        : k === 'gift' ? { on: 'support', kinds: ['gift'], unit: 'subs', min: 5, every: false } : k === 'bits' ? { on: 'support', kinds: ['bits'], unit: 'bits', min: 500, every: false }
          : k === 'command' ? { on: 'command', cmd: 'hydrate', who: 'everyone', cooldownSec: 120 } : k === 'follow' ? { on: 'follow' } : k === 'raid' ? { on: 'raid', minViewers: 5 }
            : k === 'mtime' ? { on: 'milestone', of: 'time', every: 60 } : k === 'msubs' ? { on: 'milestone', of: 'subs', every: 10 } : k === 'mmoney' ? { on: 'milestone', of: 'money', every: 100 } : { on: 'goal', goalId: '', level: 0 };
      render();
    } }, ...([['support', `Someone supports with at least…`], ['every', `Every … (counts multiples)`], ['gift', 'Someone gifts at least … subs'], ['bits', 'Someone cheers at least … bits'], ['command', 'Someone types a chat command'], ['follow', 'Someone follows'], ['raid', 'A raid arrives'], ['mtime', 'Every … minutes added to the subathon'], ['msubs', 'Every … subs'], ['mmoney', `Every … ${cur} in total`], ['goal', 'A goal / stretch goal is reached']] as const)
      .map(([k, l]) => el('option', { value: k, selected: kindOf(w) === k }, l)));
    const num = (val: number, put: (v: number) => void, label: string) => el('input', { type: 'number', min: 0, step: 'any', value: val, 'aria-label': label, style: 'max-width:110px', onInput: (e: Event) => put(Number((e.target as HTMLInputElement).value) || 0) });
    const whenArgs = w.on === 'support' ? num(w.min, (v) => { w.min = v; }, 'Amount') : w.on === 'command'
      ? el('div', { class: 'row' }, el('input', { type: 'text', value: `!${w.cmd}`, style: 'max-width:120px', 'aria-label': 'Command', onInput: (e: Event) => { w.cmd = (e.target as HTMLInputElement).value.replace(/^!+/, '').toLowerCase().replace(/[^a-z0-9_]/g, ''); } }),
        el('select', { 'aria-label': 'Who', onChange: (e: Event) => { w.who = (e.target as HTMLSelectElement).value as typeof w.who; } }, ...(['everyone', 'subs', 'mods'] as const).map((x) => el('option', { value: x, selected: w.who === x }, x === 'everyone' ? 'anyone' : x))),
        el('span', { class: 'tiny' }, 'wait'), num(w.cooldownSec, (v) => { w.cooldownSec = v; }, 'Cooldown seconds'), el('span', { class: 'tiny' }, 's'))
      : w.on === 'raid' ? num(w.minViewers, (v) => { w.minViewers = v; }, 'Viewers') : w.on === 'milestone' ? num(w.every, (v) => { w.every = v; }, 'Every')
        : w.on === 'goal' ? el('select', { 'aria-label': 'Goal', onChange: (e: Event) => { w.goalId = (e.target as HTMLSelectElement).value; } }, el('option', { value: '' }, 'any goal'), ...S!.cfg.goals.map((g) => el('option', { value: g.id, selected: w.goalId === g.id }, g.title))) : null;
    const thenRows = el('div', { class: 'lv' });
    const paintThen = () => thenRows.replaceChildren(...i.then.map((a, k) => el('div', { class: 'row' }, actionRow(a, (na) => { if (na) i.then[k] = na; else i.then.splice(k, 1); paintThen(); })),
      i.then.length < 6 ? el('button', { class: 'b sm', onClick: () => { i.then.push({ do: 'sound', s: 'fanfare' }); paintThen(); } }, '+ Also…') : ''));
    paintThen();
    return el('div', { class: 'card' }, el('h5', null, 'New incentive'),
      el('label', { class: 'f' }, 'When', whenSel), whenArgs, el('label', { class: 'f' }, 'Then'), thenRows,
      el('label', { class: 'f' }, 'Name (optional)', el('input', { type: 'text', value: i.name, maxLength: 48, placeholder: 'e.g. Hydrate check', onInput: (e: Event) => { i.name = (e.target as HTMLInputElement).value; } })),
      el('div', { class: 'row' },
        el('button', { class: 'b pri', onClick: () => { const n = { ...i, id: `i${Date.now().toString(36)}` }; ui.inc = null; run(call('PUT', '/api/goals/config', { incentives: [...S!.cfg.incentives, n] }), 'Incentive on'); } }, 'Save'),
        el('button', { class: 'b', onClick: () => { ui.inc = null; render(); } }, 'Cancel')));
  }

  /** One "then" action: what + its value. `put(null)` removes it. */
  function actionRow(a: IncAction, put: (a: IncAction | null) => void): HTMLElement[] {
    const kind = el('select', { 'aria-label': 'Action', onChange: (e: Event) => {
      const k = (e.target as HTMLSelectElement).value;
      put(k === 'addTime' ? { do: 'addTime', ms: 300_000 } : k === 'wheel' ? { do: 'wheel' } : k === 'unlock' ? { do: 'unlock', goalId: '' } : k === 'sound' ? { do: 'sound', s: 'fanfare' } : k === 'message' ? { do: 'message', text: 'Thank you {name}!' } : k === 'happyhour' ? { do: 'happyhour', mult: 2, ms: 900_000 } : { do: 'deck', cue: { action: EFFECTS[0]?.id ?? 'lighting', params: {} } });
    } }, ...([['addTime', 'Add time'], ['deck', 'Room effect'], ['wheel', 'Spin the wheel'], ['unlock', 'Unlock a hidden stretch goal'], ['sound', 'Play a sound'], ['message', 'Show a message'], ['happyhour', 'Start a happy hour']] as const).map(([k, l]) => el('option', { value: k, selected: a.do === k }, l)));
    let arg: HTMLElement | null = null;
    if (a.do === 'addTime') arg = el('input', { type: 'text', value: fmtSpan(a.ms).replace(/ /g, ''), style: 'max-width:100px', 'aria-label': 'Time', onChange: (e: Event) => { const t = (e.target as HTMLInputElement).value.trim(); const ms = (t.startsWith('-') ? -1 : 1) * parseDuration(t.replace(/^[+-]/, '').replace(/min/g, 'm')); if (ms) a.ms = ms; } });
    else if (a.do === 'sound') arg = el('select', { 'aria-label': 'Sound', onChange: (e: Event) => { a.s = (e.target as HTMLSelectElement).value as SoundCue; } }, ...SOUND_CUES.map((s) => el('option', { value: s, selected: a.s === s }, SOUND_LABEL[s])));
    else if (a.do === 'message') arg = el('input', { type: 'text', value: a.text, maxLength: 120, class: 'grow', 'aria-label': 'Message ({name}, {amount}, {subs}, {bits})', onInput: (e: Event) => { a.text = (e.target as HTMLInputElement).value; } });
    else if (a.do === 'happyhour') arg = el('span', { class: 'tiny' }, `×${a.mult} for ${fmtSpan(a.ms)}`);
    else if (a.do === 'unlock') arg = el('select', { 'aria-label': 'Goal', onChange: (e: Event) => { a.goalId = (e.target as HTMLSelectElement).value; } }, el('option', { value: '' }, 'the first goal with a hidden one'), ...S!.cfg.goals.map((g) => el('option', { value: g.id, selected: a.goalId === g.id }, g.title)));
    else if (a.do === 'deck') arg = effectPicker(a.cue, (c) => { a.cue = c; });
    return [kind, ...(arg ? [arg] : []), el('button', { class: 'b sm warn', title: 'Remove', onClick: () => put(null) }, '×')];
  }

  /** A goal's / stretch goal's "when reached" effect: a room effect + a sound + a message. */
  function actionPicker(a0: GoalDef['action'], put: (a: GoalDef['action']) => void): HTMLElement {
    const a = { ...(a0 ?? {}) };
    const commit = () => put(a.deck || a.sound || a.text ? { ...a } : undefined);
    return el('div', { class: 'grid' },
      el('label', null, 'Room effect', a.deck ? effectPicker(a.deck, (c) => { a.deck = c; commit(); }) : el('button', { class: 'b sm', onClick: (e: Event) => { a.deck = { action: 'lighting', params: { state: 'show' } }; commit(); (e.target as HTMLElement).replaceWith(effectPicker(a.deck, (c) => { a.deck = c; commit(); })); } }, '+ Add an effect')),
      el('label', null, 'Sound', el('select', { onChange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; a.sound = v ? v as SoundCue : undefined; commit(); } }, el('option', { value: '' }, 'The usual fanfare'), ...SOUND_CUES.map((s) => el('option', { value: s, selected: a.sound === s }, SOUND_LABEL[s])))),
      el('label', null, 'Message on stream', el('input', { type: 'text', value: a.text ?? '', maxLength: 120, placeholder: 'e.g. Outfit change incoming!', onInput: (e: Event) => { a.text = (e.target as HTMLInputElement).value || undefined; commit(); } })));
  }

  function effectPicker(c: DeckCue, put: (c: DeckCue) => void): HTMLElement {
    const def = EFFECTS.find((x) => x.id === c.action) ?? EFFECTS[0];
    const p0 = def?.params?.[0];
    const box = el('div', { class: 'row' });
    const sel = el('select', { 'aria-label': 'Effect', onChange: (e: Event) => { const id = (e.target as HTMLSelectElement).value; const d = EFFECTS.find((x) => x.id === id); const p = d?.params?.[0]; put({ action: id, params: p && p.default !== undefined ? { [p.key]: p.default } : {} }); box.replaceWith(effectPicker({ action: id, params: p && p.default !== undefined ? { [p.key]: p.default } : {} }, put)); } },
      ...EFFECTS.map((x) => el('option', { value: x.id, selected: x.id === def?.id }, `${x.icon} ${x.label}`)));
    box.append(sel);
    if (p0) {
      const v = c.params[p0.key] ?? p0.default ?? '';
      box.append(p0.options ? el('select', { 'aria-label': p0.label, onChange: (e: Event) => put({ action: def.id, params: { ...c.params, [p0.key]: (e.target as HTMLSelectElement).value } }) }, ...p0.options.map((o) => el('option', { value: o.value, selected: String(v) === o.value }, o.label)))
        : el('input', { type: p0.type === 'number' ? 'number' : 'text', value: v, placeholder: p0.label, 'aria-label': p0.label, style: 'max-width:150px', onInput: (e: Event) => { const t = (e.target as HTMLInputElement).value; put({ action: def.id, params: { ...c.params, [p0.key]: p0.type === 'number' ? Number(t) || 0 : t } }); } }));
    }
    return box;
  }

  // ---------------------------------------------------------------- the look on stream + settings
  function renderLook() {
    const st = S!, sh = st.cfg.show;
    const put = (show: Partial<typeof sh>, msg?: string) => run(call('PUT', '/api/goals/config', { show: { ...sh, ...show } }), msg);
    const seg = <T extends string>(val: T, opts: [T, string][], f: (v: T) => void) => el('div', { class: 'tabs' }, ...opts.map(([k, l]) => el('button', { class: val === k ? 'on' : '', onClick: () => f(k) }, l)));
    root.append(
      el('label', { class: 'f' }, 'Where on the stream', seg(sh.dock, [['auto', 'Auto'], ['tl', '↖'], ['tr', '↗'], ['bl', '↙'], ['br', '↘'], ['off', 'Off']], (dock) => put({ dock }))),
      el('p', { class: 'tiny' }, 'Auto picks a free corner and moves out of the way of faces, cams, the react screen and the chat. Full screen layouts can place them exactly: Layouts → add “Goal bar”, “Stretch-goal ladder” or “Subathon timer”.'),
      el('label', { class: 'f' }, 'What the corner card shows', seg(sh.what, [['both', 'Goals + timer'], ['goals', 'Goals'], ['timer', 'Timer']], (what) => put({ what }))),
      el('label', { class: 'f' }, 'Style', seg(sh.style, [['neon', 'Neon'], ['clean', 'Clean'], ['bold', 'Bold']], (style) => put({ style }))),
      el('label', { class: 'f' }, `Size ${Math.round(sh.scale * 100)}%`, el('input', { type: 'range', min: 0.6, max: 1.6, step: 0.05, value: sh.scale, onChange: (e: Event) => put({ scale: Number((e.target as HTMLInputElement).value) }) })),
      el('div', { class: 'row' }, sw(sh.world, (world) => put({ world }, world ? 'The goals board drops into rooms that have a spot for it' : 'No board in the room'), 'In the room'), el('span', null, 'A goals board in the room (rooms with a goal or chat board spot)')),
      el('div', { class: 'grid' },
        el('label', null, 'Goal reached sound', el('select', { onChange: (e: Event) => run(call('PUT', '/api/goals/config', { celebrate: (e.target as HTMLSelectElement).value })) }, el('option', { value: 'none', selected: st.cfg.celebrate === 'none' }, 'None'), ...SOUND_CUES.map((s) => el('option', { value: s, selected: st.cfg.celebrate === s }, SOUND_LABEL[s])))),
        el('label', null, 'Money in', el('select', { onChange: (e: Event) => run(call('PUT', '/api/goals/config', { currency: (e.target as HTMLSelectElement).value }), 'New support counts in this currency') }, ...['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'BRL', 'MXN'].map((c) => el('option', { value: c, selected: st.cfg.currency === c }, c)))),
        el('label', null, 'A new stream after (hours without support)', el('input', { type: 'number', min: 0, max: 72, step: 1, value: st.cfg.streamGapH, onChange: (e: Event) => run(call('PUT', '/api/goals/config', { streamGapH: Number((e.target as HTMLInputElement).value) || 0 })) }))),
      el('p', { class: 'tiny' }, 'Sounds play from the studio (like every show sound), never from the OBS page.'),
      el('details', { 'data-k': 'deck' }, el('summary', null, 'Stream Deck'),
        el('p', { class: 'muted' }, 'Stream Deck & controllers has a Goals group: “Subathon timer” (pause / resume, add or take off time, undo, happy hour, sleep mode), “Goal” (show / hide, add an amount, new stream) and “Spin the wheel”.'),
        el('button', { class: 'b', onClick: () => { void import('../ui/deckOpen.ts').then((m) => m.openDeck()).catch(() => window.open('/deck.html', 'vtp-deck')); } }, 'Open Stream Deck & controllers'),
        forScripts('POST /api/goals/sub/add {"text":"5m"} · /api/goals/sub/pause · /api/goals/sub/undo · /api/goals/sub/happy {"mult":2,"ms":1800000} · /api/goals/wheel/spin · /api/goals/goal/<id>/adjust {"delta":5}')));
  }

  void load();
  render();
  return root;
}

function kindOf(w: IncTrigger): string {
  if (w.on === 'support') return w.every ? 'every' : w.kinds.length === 1 && w.kinds[0] === 'gift' ? 'gift' : w.kinds.length === 1 && w.kinds[0] === 'bits' ? 'bits' : 'support';
  if (w.on === 'milestone') return w.of === 'time' ? 'mtime' : w.of === 'subs' ? 'msubs' : 'mmoney';
  return w.on;
}
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const parseHm = (s: string, d: number) => { const m = /^(\d{1,2}):?(\d{2})?$/.exec(s.trim()); return m ? Math.min(1439, Number(m[1]) * 60 + Number(m[2] ?? 0)) : d; };
export type { SupportKind };
