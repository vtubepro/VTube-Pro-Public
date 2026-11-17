// Studio: the chat audience + question queue (Scene tab "👥 Chat audience" section, and the Chat Hub's ❓ drawer).
//   * the MOD QUEUE first (it is what you use live): pending questions with Approve / Answer now / Pin / Skip, the one
//     on air with Done, Next question, Applause;
//   * settings under "Settings": the audience (on, size, who, names, bubbles, reactions), questions (!ask, who, paid
//     questions, bumps, cards, camera close-up, overlay), blocked words, name effects per supporter tier (+ a live
//     preview), hand-picked effects, test buttons.
// Talks only to this PC's VTube Pro server (/api/audience/*). Defaults just work: free !ask on, paid off, every question waits for
// your OK.
import {
  EFFECT_TIERS, NAME_BADGES, NAME_TRAILS, TIER_LABELS, resolveNameStyle, sanitizeAudience,
  type AskSettings, type AudienceSettings, type AudienceView, type EffectTier, type Question,
} from '../../shared/audience.ts';
import { drawBadge } from '../chat/nameStyle.ts';

interface State { settings: AudienceSettings; view: AudienceView; queue: Question[]; counts: Record<string, number>; chatters: number; nativeSupport: boolean }

const CSS = `
.vaud{font:13px/1.4 Inter,"Segoe UI",system-ui,sans-serif;color:var(--text,#e7eaf0);display:flex;flex-direction:column;gap:10px;min-width:0}
.vaud h4{margin:6px 0 2px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim,#9aa3b2);font-weight:600}
.vaud .note{color:var(--dim,#9aa3b2);font-size:12px}
.vaud .bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.vaud .bar .grow{flex:1}
.vaud button{background:#262c3a;color:inherit;border:1px solid #333b4b;border-radius:8px;padding:6px 10px;font:inherit;cursor:pointer;white-space:nowrap}
.vaud button:hover{background:#2f3647}
.vaud button.pri{background:var(--accent,#7bd88f);color:#0d1a10;border-color:transparent;font-weight:700}
.vaud button.air{background:#ffd34d;color:#1b1400;border-color:transparent;font-weight:700}
.vaud button.warn{background:#ff6b6b22;border-color:#ff6b6b55}
.vaud button.sm{padding:3px 8px;font-size:12px}
.vaud .q{border:1px solid #2a303c;border-radius:10px;padding:8px 9px;background:#151922;display:flex;flex-direction:column;gap:6px}
.vaud .q.held{border-color:#ff6b6b88;background:#2a1418}
.vaud .q.answering{border-color:#ffd34d;box-shadow:0 0 0 1px #ffd34d55 inset;background:#2a2410}
.vaud .q.approved,.vaud .q.pinned{border-color:#35e3ff66}
.vaud .q.answered{opacity:.6;border-style:dashed}
.vaud .q .who{display:flex;gap:4px 6px;align-items:center;flex-wrap:wrap;min-width:0;font-weight:700}
.vaud .q .who .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.vaud .q .who .note{white-space:nowrap}
.vaud .q .txt{font-size:14px;overflow-wrap:anywhere}
.vaud .tag{font-size:11px;padding:1px 7px;border-radius:99px;background:#2a303c;color:var(--dim,#9aa3b2);white-space:nowrap}
.vaud .tag.paid{color:#111;font-weight:800}
.vaud .tag.flag{background:#ff6b6b26;color:#ffb0b0}
.vaud .tag.st{background:#35e3ff22;color:#8eeaff}
.vaud .tag.air{background:#ffd34d;color:#1b1400;font-weight:800}
.vaud .list{display:flex;flex-direction:column;gap:6px;max-height:420px;overflow:auto}
.vaud details{border:1px solid #2a303c;border-radius:10px;padding:6px 9px;background:#151922}
.vaud details>summary{cursor:pointer;font-weight:600;padding:2px 0}
.vaud .f{display:grid;grid-template-columns:minmax(96px,40%) 1fr;gap:6px 8px;align-items:center;margin:6px 0}
.vaud .f>span{color:var(--dim,#9aa3b2)}
.vaud .f input[type=text],.vaud .f input[type=number],.vaud .f select,.vaud textarea{width:100%;box-sizing:border-box;background:#12151b;color:inherit;border:1px solid #2a303c;border-radius:7px;padding:5px 7px;font:inherit;min-width:0}
.vaud textarea{min-height:54px;resize:vertical}
.vaud .f .inl{display:flex;gap:6px;align-items:center;min-width:0}
.vaud .tier{border-top:1px solid #2a303c;padding-top:6px;margin-top:6px}
.vaud .tier .hd{display:flex;align-items:center;gap:8px;justify-content:space-between}
.vaud .tier canvas{height:28px;width:auto;max-width:100%}
.vaud .stat{display:flex;gap:8px;flex-wrap:wrap}
.vaud .stat b{font-size:15px}
.vaud .err{color:#ffb0b0}
`;

type Kid = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> | null = null, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'value') (e as HTMLInputElement).value = String(v);
    else if (k === 'checked') (e as HTMLInputElement).checked = !!v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}
async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || `HTTP ${r.status}`);
  return j as T;
}
const PLAT: Record<string, string> = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick', rumble: 'Rumble', tiktok: 'TikTok', test: 'Test' };
const ago = (ms: number) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`; };

/** A preview of a name tag in a tier's style (the same badge glyph + colours as on stream). */
function tagPreview(name: string, tier: EffectTier, s: AudienceSettings): HTMLCanvasElement {
  const st = resolveNameStyle(tier, '#9fd8ff', s);
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const fs = 26, pad = 10, bw = st.badge !== 'none' ? 30 : 0;
  g.font = `800 ${fs}px Inter, "Segoe UI", system-ui, sans-serif`;
  const tw = g.measureText(name).width;
  c.width = Math.ceil(pad * 2 + bw + tw + 8); c.height = 52;
  const r = 19, x0 = 4, y0 = 7, w = c.width - 8, h = 38;
  g.beginPath(); g.moveTo(x0 + r, y0); g.arcTo(x0 + w, y0, x0 + w, y0 + h, r); g.arcTo(x0 + w, y0 + h, x0, y0 + h, r); g.arcTo(x0, y0 + h, x0, y0, r); g.arcTo(x0, y0, x0 + w, y0, r); g.closePath();
  if (st.glow) { g.shadowColor = st.glow; g.shadowBlur = 8; }
  g.fillStyle = 'rgba(10,12,20,.85)'; g.fill(); g.shadowBlur = 0;
  g.lineWidth = st.glow ? 2.5 : 1.5; g.strokeStyle = st.glow || 'rgba(255,255,255,.22)'; g.stroke();
  let x = x0 + pad;
  if (bw) { drawBadge(g, st.badge, x, 14, 24); x += bw; }
  g.font = `800 ${fs}px Inter, "Segoe UI", system-ui, sans-serif`; g.textBaseline = 'middle';
  if (st.glow) { g.shadowColor = st.glow; g.shadowBlur = 8; }
  g.fillStyle = st.color || '#9fd8ff'; g.fillText(name, x, 27);
  c.style.height = '26px';
  return c;
}

export interface AudiencePanelOpts { queueOnly?: boolean }

/** Mount the audience + question controls. `toast` shows a message in the host page's style. */
export function audiencePanel(toast: (msg: string) => void = (m) => console.log('[audience]', m), opts: AudiencePanelOpts = {}): HTMLElement {
  if (!document.getElementById('vaud-css')) document.head.append(el('style', { id: 'vaud-css' }, CSS));
  const root = el('div', { class: 'vaud' });
  const statEl = el('div'), queueEl = el('div'), setEl = el('div');
  root.append(statEl, queueEl);
  if (!opts.queueOnly) root.append(setEl);
  let st: State | null = null;
  let err = '';
  let sigQ = '', sigS = '';
  let saveT = 0;
  let draft: AudienceSettings | null = null;

  const run = async (p: Promise<unknown>, ok?: string) => { try { const r = await p; if (r && typeof r === 'object' && 'settings' in (r as object)) { st = r as State; paint(); } else await refresh(); if (ok) toast(ok); } catch (e) { toast((e as Error).message); } };
  const act = (id: string, a: string, ok?: string) => run(call('POST', `/api/audience/q/${encodeURIComponent(id)}/${a}`), ok);
  const save = (patch: Partial<AudienceSettings>) => {
    if (!st) return;
    draft = { ...(draft ?? st.settings), ...patch } as AudienceSettings;
    clearTimeout(saveT);
    saveT = window.setTimeout(() => { const d = draft; draft = null; if (d) { if (st) st.settings = d; void run(call('PUT', '/api/audience/settings', d)); } }, 350);
  };
  /** The question settings as they will be saved (a pending change included). */
  const curAsk = (): AskSettings => (draft ?? st!.settings).ask;
  /** "Also works as": the names VTube Pro will keep (same rules, shared/audience.ts) go back into the field, and a name
   *  it would refuse is named instead of silently staying there. */
  const saveAliases = (inp: HTMLInputElement) => {
    if (!st) return;
    const typed = inp.value.split(/[\s,]+/).filter(Boolean);
    const kept = sanitizeAudience({ ask: { ...curAsk(), aliases: typed } }, draft ?? st.settings).ask.aliases;
    inp.value = kept.map((c) => `!${c}`).join(' ');
    const out = typed.filter((t) => !kept.includes(t.replace(/^!+/, '').toLowerCase()));
    if (out.length) toast(`Not used: ${out.join(' ')} (another feature's command, the question command itself, not letters / digits, or more than 4)`);
    saveAsk({ aliases: kept });
  };
  /** A Questions control saves only its own field, on top of any pending change (two quick edits never undo each other). */
  const saveAsk = (p: Partial<AskSettings>) => { if (st) save({ ask: { ...curAsk(), ...p } }); };

  function paintStat() {
    if (err) {
      statEl.replaceChildren(el('div', { class: 'err' }, 'Can’t reach VTube Pro right now. ', el('button', { class: 'sm', onClick: () => void refresh() }, 'Try again')));
      queueEl.replaceChildren(); setEl.replaceChildren(); sigQ = sigS = '';
      return;
    }
    if (!st) { statEl.replaceChildren(el('div', { class: 'note' }, 'Loading…')); return; }
    const c = st.counts;
    statEl.replaceChildren(...[
      el('div', { class: 'stat' },
        el('span', null, el('b', null, String(st.chatters)), ' in the audience'),
        el('span', null, el('b', null, String(c.pending ?? 0)), ' waiting for you'),
        el('span', null, el('b', null, String(c.approved ?? 0)), ' approved')),
      st.settings.on ? null : el('div', { class: 'note' }, 'The audience is off — chatters don’t get a seat. Questions still work.'),
      el('div', { class: 'bar' },
        el('button', { class: 'pri', title: 'Show the next approved question (pinned first, then paid, then oldest)', onClick: () => void run(call('POST', '/api/audience/next'), 'Next question') }, '❓ Next question'),
        el('button', { title: 'Done with the question on air: it shows ANSWERED for a few seconds and fades out (Take down on its row = off stream at once)', onClick: () => void run(call('POST', '/api/audience/done')) }, '✔ Done'),
        el('button', { title: 'The whole audience claps and cheers', onClick: () => void run(call('POST', '/api/audience/applause'), 'Applause!') }, '👏 Applause'))].filter((x): x is HTMLDivElement => !!x));
  }

  /** Questions whose flagged text the moderator chose to look at (this panel only). */
  const revealed = new Set<string>();
  function qItem(q: Question): HTMLElement {
    const style = resolveNameStyle(st!.view.tiers[q.k] ?? null, q.color, st!.settings);
    const held = q.blocked && !q.allowed;
    const b: Kid[] = [];
    if (held && q.status !== 'answered' && q.status !== 'skipped') {
      // held back by the filter: Skip / Delete; "Show anyway" first shows the text, then lets it through
      b.push(el('button', { class: 'pri sm', onClick: () => act(q.id, 'skip') }, 'Skip'), el('button', { class: 'warn sm', onClick: () => act(q.id, 'delete', 'Deleted') }, 'Delete'));
      if (!revealed.has(q.id)) b.push(el('button', { class: 'sm', onClick: () => { revealed.add(q.id); sigQ = ''; paintQueue(); } }, 'Show anyway…'));
      else b.push(el('button', { class: 'sm', title: 'You have read it: it can now be approved like any other question', onClick: () => act(q.id, 'allow', 'Allowed — approve it if you want it on stream') }, 'Allow this question'));
    } else if (q.status === 'pending') b.push(
      el('button', { class: 'pri sm', onClick: () => act(q.id, 'approve', 'Approved — it shows above their head') }, 'Approve'),
      el('button', { class: 'air sm', onClick: () => act(q.id, 'answer', 'On air') }, 'Answer now'),
      el('button', { class: 'sm', onClick: () => act(q.id, 'pin') }, 'Pin'),
      el('button', { class: 'warn sm', onClick: () => act(q.id, 'skip') }, 'Skip'));
    else if (q.status === 'approved' || q.status === 'pinned') b.push(
      el('button', { class: 'air sm', onClick: () => act(q.id, 'answer', 'On air') }, 'Answer now'),
      el('button', { class: 'sm', onClick: () => act(q.id, q.status === 'pinned' ? 'unpin' : 'pin') }, q.status === 'pinned' ? 'Unpin' : 'Pin'),
      el('button', { class: 'warn sm', onClick: () => act(q.id, 'skip') }, 'Skip'));
    else if (q.status === 'answering') b.push(
      el('button', { class: 'pri sm', title: 'It shows ANSWERED for a few seconds and fades out', onClick: () => void run(call('POST', '/api/audience/done')) }, 'Done'),
      el('button', { class: 'warn sm', title: 'Off stream right now, no fade-out', onClick: () => act(q.id, 'skip', 'Taken down') }, 'Take down'));
    // (answered a moment ago and still fading out on stream)
    else if (q.status === 'answered') b.push(el('button', { class: 'warn sm', title: 'Off stream right now', onClick: () => act(q.id, 'skip', 'Taken down') }, 'Take down'));
    const nameEl = el('span', { class: 'nm', style: `color:${style.color || q.color || 'inherit'}${style.glow ? `;text-shadow:0 0 .4em ${style.glow}` : ''}` }, q.name);
    const noteText = (n: string) => (n === 'blocked word' ? '⚠ contains a blocked word' : n === 'hidden link' ? '⚠ looks like a hidden link' : n);
    return el('div', { class: `q ${q.status}${held ? ' held' : ''}` },
      el('div', { class: 'who' }, nameEl,
        el('span', { class: 'tag' }, PLAT[q.platform] ?? q.platform),
        q.paid ? el('span', { class: 'tag paid', style: `background:${q.paid.tier}` }, q.source === 'paid' ? q.paid.display : `+${q.paid.display}`) : null,
        q.status === 'answering' ? el('span', { class: 'tag air' }, 'ON AIR') : q.status === 'answered' ? el('span', { class: 'tag st' }, 'answered · fading out') : q.status === 'pending' ? null : el('span', { class: 'tag st' }, q.status === 'pinned' ? '📌 pinned' : 'approved'),
        q.test ? el('span', { class: 'tag' }, 'test') : null,
        el('span', { class: 'note', style: 'margin-left:auto;font-weight:400' }, ago(q.at))),
      held && !revealed.has(q.id) ? el('div', { class: 'txt note' }, 'Hidden — the filter held this one back.') : el('div', { class: 'txt' }, q.text),
      q.notes.length ? el('div', { class: 'bar' }, ...q.notes.map((n) => el('span', { class: 'tag flag' }, noteText(n)))) : null,
      q.maybeBump ? el('div', { class: 'bar' },
        el('span', { class: 'tag flag' }, `A tip of ${q.maybeBump.display} from someone ALSO called “${q.maybeBump.from}” — the platform can’t tell if it’s the same person`),
        el('button', { class: 'sm', onClick: () => act(q.id, 'confirm-bump', 'Counted as their tip') }, 'Same person'),
        el('button', { class: 'sm', onClick: () => act(q.id, 'drop-bump') }, 'Not them')) : null,
      el('div', { class: 'bar' }, ...b));
  }

  function paintQueue() {
    if (!st) { queueEl.replaceChildren(); return; }
    // open ones, plus the ones still fading out on stream after Done (the server's view says which: no clock to compare)
    const fading = new Set(st.view.questions.filter((v) => v.status === 'answered').map((v) => v.id));
    const open = st.queue.filter((q) => q.status !== 'skipped' && (q.status !== 'answered' || fading.has(q.id)));
    const ak = st.settings.ask;
    const sig = JSON.stringify([ak.on, ak.command, ak.aliases ?? [], ak.paid.on, ak.paid.minUsd, open.map((q) => [q.id, q.status, q.text, q.pr, q.notes.length, q.allowed, q.maybeBump?.usd, Math.round((Date.now() - q.at) / 30000)])]);
    if (sig === sigQ) return;
    sigQ = sig;
    const cmd = [st.settings.ask.command, ...(st.settings.ask.aliases ?? [])].map((c) => `!${c}`).join(' or ');
    queueEl.replaceChildren(
      el('h4', null, 'Questions'),
      open.length ? el('div', { class: 'list' }, ...open.map(qItem))
        : el('div', { class: 'note' }, st.settings.ask.on
          ? `No questions yet. Viewers type ${cmd} followed by their question${st.settings.ask.paid.on ? `, or tip $${st.settings.ask.paid.minUsd}+ with a message` : ''}. Nothing shows on stream until you approve it.`
          : 'Questions are off (Settings → Questions).'));
  }

  // ---------------------------------------------------------------- settings
  const chk = (v: boolean, on: (v: boolean) => void) => el('input', { type: 'checkbox', checked: v, onChange: (e: Event) => on((e.target as HTMLInputElement).checked) });
  const num = (v: number, min: number, max: number, step: number, on: (v: number) => void) => el('input', { type: 'number', value: v, min, max, step, onChange: (e: Event) => { const n = Number((e.target as HTMLInputElement).value); if (Number.isFinite(n)) on(n); } });
  const sel = <T extends string>(v: T, opts: [T, string][], on: (v: T) => void) => el('select', { onChange: (e: Event) => on((e.target as HTMLSelectElement).value as T) }, ...opts.map(([k, l]) => el('option', { value: k, ...(k === v ? { selected: true } : {}) }, l)));
  const range = (v: number, min: number, max: number, step: number, on: (v: number) => void) => el('input', { type: 'range', value: v, min, max, step, onChange: (e: Event) => on(Number((e.target as HTMLInputElement).value)) });
  const f = (label: string, control: Node, title = '') => el('label', { class: 'f', title }, el('span', null, label), control);
  const list = (v: string[], on: (v: string[]) => void, ph: string) => el('textarea', { placeholder: ph, onChange: (e: Event) => on((e.target as HTMLTextAreaElement).value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)) }, v.join(', '));

  function paintSettings() {
    if (opts.queueOnly || !st) return;
    const s = st.settings;
    const sig = JSON.stringify(s);
    if (sig === sigS) return;
    sigS = sig;
    const a = s.ask;
    const tiers = el('div');
    const known = EFFECT_TIERS.filter((t) => !!s.effects?.[t]);
    for (const t of known) {
      const e = s.effects[t];
      const setE = (p: Partial<typeof e>) => save({ effects: { ...s.effects, [t]: { ...e, ...p } } });
      tiers.append(el('div', { class: 'tier' },
        el('div', { class: 'hd' }, el('label', { class: 'inl', style: 'display:flex;gap:6px;align-items:center' }, chk(e.on, (v) => setE({ on: v })), el('b', null, TIER_LABELS[t])), tagPreview('NightOwl42', t, s)),
        e.on ? el('div', null,
          f('Name colour', el('div', { class: 'inl' }, chk(!!e.color, (v) => setE({ color: v ? '#ffd34d' : '' })), e.color ? el('input', { type: 'color', value: e.color, onChange: (ev: Event) => setE({ color: (ev.target as HTMLInputElement).value }) }) : el('span', { class: 'note' }, 'their chat colour'))),
          f('Glow', el('div', { class: 'inl' }, chk(!!e.glow, (v) => setE({ glow: v ? '#ffae00' : '' })), e.glow ? el('input', { type: 'color', value: e.glow, onChange: (ev: Event) => setE({ glow: (ev.target as HTMLInputElement).value }) }) : el('span', { class: 'note' }, 'none'))),
          f('Badge', sel(e.badge, NAME_BADGES.map((b) => [b, b === 'none' ? 'None' : b[0].toUpperCase() + b.slice(1)]), (v) => setE({ badge: v }))),
          f('Sparkle trail', sel(e.trail, NAME_TRAILS.map((b) => [b, b === 'none' ? 'None' : b[0].toUpperCase() + b.slice(1)]), (v) => setE({ trail: v })), '3D audience only'),
          f('Gentle pulse', chk(e.pulse, (v) => setE({ pulse: v })), '3D audience only')) : null));
    }
    const manual = el('div');
    const paintManual = () => {
      manual.replaceChildren(
        ...s.manual.map((m, i) => el('div', { class: 'bar' }, el('span', { class: 'grow' }, m.who), el('span', { class: 'tag' }, TIER_LABELS[m.tier]),
          el('button', { class: 'sm warn', onClick: () => save({ manual: s.manual.filter((_, j) => j !== i) }) }, 'Remove'))),
        (() => {
          const who = el('input', { type: 'text', placeholder: 'chat name (or twitch:name)' });
          let tier: EffectTier = 'patron_top';
          return el('div', { class: 'bar' }, who, sel(tier, EFFECT_TIERS.filter((t) => !!s.effects?.[t]).map((t) => [t, TIER_LABELS[t]]), (v) => { tier = v; }),
            el('button', { class: 'sm', onClick: () => { const w = (who as HTMLInputElement).value.trim().toLowerCase(); if (w) save({ manual: [...s.manual.filter((m) => m.who !== w), { who: w, tier }] }); } }, 'Add'));
        })());
    };
    paintManual();
    setEl.replaceChildren(el('details', null, el('summary', null, '⚙ Settings'),
      el('h4', null, 'The audience'),
      f('Audience', chk(s.on, (v) => save({ on: v })), 'Chatters get a seat in rooms with audience seats'),
      f(`Up to ${s.max} people`, range(s.max, 10, 200, 5, (v) => save({ max: v })), 'Rooms may have fewer seats'),
      f('Who gets a seat', sel(s.who, [['everyone', 'Everyone chatting'], ['subs', 'Subs, members + patrons'], ['supporters', 'Supporters only']], (v) => save({ who: v }))),
      f('Stays in the audience', sel(s.keep === 'minutes' ? String(s.windowMin) : 'stream',
          [['stream', 'The whole stream'], ...[...new Set([5, 10, 15, 30, 60, 120, s.windowMin])].sort((x, y) => x - y).map((m): [string, string] => [String(m), `${m} min after their last message`])],
          (v) => save(v === 'stream' ? { keep: 'stream' } : { keep: 'minutes', windowMin: Number(v) })),
          'The whole stream (default): nobody leaves over time; a new stream starts fresh. Minutes: people leave that long after their last message (supporters twice as long). Either way, when every seat in the room is taken, a newcomer takes the seat of whoever has been quiet longest, and someone whose question is on screen keeps their seat.'),
      f('Name size', range(s.names.size, 0.5, 2, 0.1, (v) => save({ names: { ...s.names, size: v } }))),
      f('Platform dot', chk(s.names.platform, (v) => save({ names: { ...s.names, platform: v } }))),
      f('Tidy names', chk(s.names.declutter, (v) => save({ names: { ...s.names, declutter: v } })), 'Hide names that would overlap (people talking, asking or supporting always show)'),
      f('Speech bubbles', chk(s.bubbles, (v) => save({ bubbles: v })), 'Off by default. Chat messages float above the chatter WITHOUT a moderator (links removed, a blocked word hides the bubble)'),
      f('Reactions', range(s.intensity, 0, 2, 0.1, (v) => save({ intensity: v })), 'Calm … wild'),
      f('Names over a crowd', chk(s.crowdNames, (v) => save({ crowdNames: v })), 'Rooms with a background crowd but no seats: put chat names over the crowd'),
      el('h4', null, 'Questions'),
      f('Questions', chk(a.on, (v) => saveAsk({ on: v }))),
      f('Chat command', el('div', { class: 'inl' }, el('span', null, '!'), el('input', { type: 'text', value: a.command, maxlength: 16, onChange: (e: Event) => saveAsk({ command: (e.target as HTMLInputElement).value }) }))),
      f('Also works as', el('input', { type: 'text', value: a.aliases.map((c) => `!${c}`).join(' '), maxlength: 80, placeholder: 'none', onChange: (e: Event) => saveAliases(e.target as HTMLInputElement) }), 'Other chat commands that ask a question the same way (!axe by default). Separate them with spaces; empty = none.'),
      f('Who can ask', sel(a.who, [['everyone', 'Everyone'], ['subs', 'Subs, members + patrons'], ['supporters', 'Supporters'], ['paid', 'Only paid questions'], ['off', 'Nobody (off)']], (v) => saveAsk({ who: v }))),
      f('Paid questions', chk(a.paid.on, (v) => saveAsk({ paid: { ...curAsk().paid, on: v } })), 'A tip / Super Chat / bits with a message becomes a question'),
      a.paid.on ? f('From', el('div', { class: 'inl' }, el('span', null, '$'), num(a.paid.minUsd, 0.5, 10000, 0.5, (v) => saveAsk({ paid: { ...curAsk().paid, minUsd: v } })))) : null,
      a.paid.on ? f('Only "Q:" messages', chk(a.paid.prefix, (v) => saveAsk({ paid: { ...curAsk().paid, prefix: v } })), 'Only tip messages starting with Q: become questions') : null,
      f('Tip bumps a question', el('div', { class: 'inl' }, num(a.bumpMin, 0, 120, 1, (v) => saveAsk({ bumpMin: v })), el('span', { class: 'note' }, 'min after !ask (0 = off)'))),
      f('Cards above heads', range(a.cards, 0, 5, 1, (v) => saveAsk({ cards: v })), 'Approved questions shown at once (plus the one on air)'),
      f('Close-up of the asker', chk(a.askerCut, (v) => saveAsk({ askerCut: v })), '"Answer now" cuts to the asker for a few seconds'),
      f('Overlay card', sel(a.overlay, [['auto', 'When there are no seats'], ['on', 'Always'], ['off', 'Never']], (v) => saveAsk({ overlay: v }))),
      f('Longest question', num(a.maxLen, 40, 400, 10, (v) => saveAsk({ maxLen: v }))),
      f('Wait before asking again', el('div', { class: 'inl' }, num(a.cooldownSec, 0, 3600, 10, (v) => saveAsk({ cooldownSec: v })), el('span', { class: 'note' }, 's'))),
      f('Show questions without approval', chk(!a.approve, (v) => saveAsk({ approve: !v })), 'Off (default): every question waits for your OK'),
      el('div', { class: 'note' }, a.approve ? '🛡 Every question waits for your OK — it never shows on stream before you approve it.' : 'Questions go on stream as soon as they arrive (only ones the filter holds back still wait for you).'),
      el('h4', null, 'Filter'),
      f('Word filter', chk(s.filterWords, (v) => save({ filterWords: v })), 'Blocked words + the built-in slur list, on names, bubbles, questions and emote names'),
      f('Remove links', chk(s.filterLinks, (v) => save({ filterLinks: v })), 'Links are removed or held back, on names, bubbles, questions and emote names'),
      !s.filterWords || !s.filterLinks ? el('div', { class: 'note' }, !s.filterWords && !s.filterLinks ? 'Names, bubbles and questions are shown as typed.' : !s.filterWords ? 'Blocked words are not filtered: names, bubbles and questions keep them. Links are still removed.' : 'Links are not removed: names, bubbles and questions keep them. Blocked words are still filtered.') : null,
      el('h4', null, 'Blocked words'),
      list(s.blocklist, (v) => save({ blocklist: v }), 'words, separated by commas'),
      f('Built-in slur list', chk(s.builtinBlock, (v) => save({ builtinBlock: v }))),
      f('Allowed words', list(s.allowWords, (v) => save({ allowWords: v }), 'never blocked (a false alarm), e.g. scunthorpe'), 'Words the filter must never block'),
      f('Always show these names', list(s.allowNames, (v) => save({ allowNames: v }), 'chat names shown as they are'), 'A name the filter turned into “viewer” by mistake'),
      f('Never seat', list(s.exclude, (v) => save({ exclude: v }), 'names (bots are always left out)')),
      el('h4', null, 'Name effects'),
      el('div', { class: 'note' }, 'Supporters’ names on stream (the 3D audience and the chat box). Patrons come from Patreon and other memberships once linked; until then pick people by hand below.'),
      tiers,
      f('Big patron from', el('div', { class: 'inl' }, el('span', null, '$'), num(s.patron.plusUsd, 1, 100000, 1, (v) => save({ patron: { ...s.patron, plusUsd: v } })), el('span', { class: 'note' }, '/month'))),
      f('Top patron from', el('div', { class: 'inl' }, el('span', null, '$'), num(s.patron.topUsd, 1, 100000, 1, (v) => save({ patron: { ...s.patron, topUsd: v } })), el('span', { class: 'note' }, '/month'))),
      f('Top tier names', list(s.patron.topTiers, (v) => save({ patron: { ...s.patron, topTiers: v } }), 'e.g. Gold, Producer')),
      f('“Tipped” from', el('div', { class: 'inl' }, el('span', null, '$'), num(s.tipperUsd, 0.5, 100000, 0.5, (v) => save({ tipperUsd: v })), el('span', { class: 'note' }, 'this stream'))),
      el('h4', null, 'Picked by hand'),
      manual,
      el('h4', null, 'Try it'),
      el('div', { class: 'bar' },
        el('button', { class: 'sm', onClick: () => void run(call('POST', '/api/audience/test', { what: 'crowd', n: 40 }), '40 test chatters joined') }, '+40 test chatters'),
        el('button', { class: 'sm', onClick: () => void run(call('POST', '/api/audience/test', { what: 'ask' })) }, 'Test !ask'),
        el('button', { class: 'sm', onClick: () => void run(call('POST', '/api/audience/test', { what: 'paid' })) }, 'Test paid question'),
        el('button', { class: 'sm', onClick: () => void run(call('POST', '/api/audience/test', { what: 'tip' })) }, 'Test tip'),
        el('button', { class: 'sm', onClick: () => void run(call('POST', '/api/audience/test', { what: 'laugh' })) }, 'Test laugh'),
        el('button', { class: 'sm warn', onClick: () => void run(call('POST', '/api/audience/clear', { what: 'all' }), 'Cleared') }, 'Clear')),
      el('div', { class: 'note' }, 'Test chatters are local to this PC and never sent anywhere.')));
    // keep it open across repaints
    const d = setEl.querySelector('details');
    if (d && openSettings) d.open = true;
    d?.addEventListener('toggle', () => { openSettings = d.open; });
  }
  let openSettings = false;

  function paint() { paintStat(); paintQueue(); paintSettings(); }
  async function refresh() {
    try { st = await call<State>('GET', '/api/audience/state'); err = ''; }
    catch (e) { err = (e as Error).message; }
    paint();
  }
  void refresh();
  // live while shown (the panel may be re-mounted by the host page, so the timer stays; it does nothing while detached)
  window.setInterval(() => { if (root.isConnected && document.visibilityState !== 'hidden') void refresh(); }, 1500);
  return root;
}

// ---------------------------------------------------------------- the Chat Hub drawer (❓ Questions)
let drawer: HTMLElement | null = null;
/** Chat Hub: open / close the question drawer (the mod queue only). */
export function toggleQuestionsDrawer(toast: (m: string) => void) {
  if (!drawer) {
    const close = el('button', { onClick: () => toggleQuestionsDrawer(toast) }, 'Close');
    drawer = el('aside', { style: 'position:fixed;top:56px;right:12px;bottom:40px;width:min(460px,calc(100vw - 24px));overflow:auto;background:#141226f2;border:1px solid #ffffff22;border-radius:14px;padding:12px 14px;z-index:9;box-shadow:0 12px 40px #0009' },
      el('div', { style: 'display:flex;align-items:center;margin-bottom:6px' }, el('b', { style: 'flex:1;font-size:16px' }, '❓ Questions'), close),
      audiencePanel(toast, { queueOnly: true }));
    document.body.append(drawer);
  } else drawer.style.display = drawer.style.display === 'none' ? '' : 'none';
}
