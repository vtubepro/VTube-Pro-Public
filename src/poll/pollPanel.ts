// Chat poll controls (Chat Hub + the studio's Show tab): create / start a poll, quick presets, saved templates, the
// live standings with End / Hide / Clear, and the results history. Talks only to this PC's server (/api/poll/*).
import { forScripts } from '../ui/forScripts.ts';
import { POLL_MAX_OPTIONS, POLL_MIN_OPTIONS, winnerText, type PollResult, type PollTemplate, type PollView } from '../../shared/poll.ts';

interface PollState { poll: PollView | null; templates: PollTemplate[]; presets: PollTemplate[]; history: PollResult[]; canSend: boolean }

const CSS = `
.vpoll{font:14px/1.35 "Segoe UI",system-ui,sans-serif;color:var(--fg,#e9e6f7);display:flex;flex-direction:column;gap:10px}
.vpoll h4{margin:4px 0 2px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.7}
.vpoll input[type=text],.vpoll input[type=number],.vpoll select{background:#0003;color:inherit;border:1px solid #ffffff24;border-radius:8px;padding:6px 8px;font:inherit;min-width:0}
.vpoll .row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.vpoll .row>input[type=text]{flex:1}
.vpoll .opt{display:grid;grid-template-columns:22px 1fr 110px 26px;gap:6px;align-items:center}
.vpoll .opt b{opacity:.7;text-align:center}
.vpoll button{background:#ffffff14;color:inherit;border:1px solid #ffffff22;border-radius:8px;padding:6px 10px;font:inherit;cursor:pointer}
.vpoll button:hover{background:#ffffff26}
.vpoll button.pri{background:linear-gradient(90deg,#35e3ff,#ff5fa2);color:#0a0716;font-weight:700;border:0}
.vpoll button.warn{background:#ff5fa233;border-color:#ff5fa266}
.vpoll .live{border:1px solid #35e3ff55;border-radius:12px;padding:10px;background:#35e3ff0d}
.vpoll .live.ended{border-color:#ffd24a77;background:#ffd24a10}
.vpoll .bar{position:relative;height:26px;border-radius:7px;background:#ffffff10;margin:4px 0;overflow:hidden}
.vpoll .bar i{position:absolute;inset:0 auto 0 0;border-radius:7px;background:linear-gradient(90deg,#35e3ff88,#35e3ff);transition:width .4s}
.vpoll .bar.win i{background:linear-gradient(90deg,#ffd24a99,#ffd24a)}
.vpoll .bar span{position:relative;display:flex;justify-content:space-between;padding:0 8px;line-height:26px;font-weight:600;text-shadow:0 1px 2px #000a}
.vpoll .pulse{display:inline-block;color:#7dff8a;font-weight:800;animation:vpp 1.2s ease-out}
@keyframes vpp{from{transform:scale(1.6);opacity:.2}to{transform:none;opacity:1}}
.vpoll .note{opacity:.65;font-size:12px}
.vpoll .list{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto}
.vpoll .li{display:flex;gap:6px;align-items:center;padding:4px 6px;border-radius:8px;background:#ffffff08}
.vpoll .li .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> | null = null, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
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

interface Draft { question: string; options: { label: string; keyword: string }[]; durationSec: number; subDouble: boolean; donationVotes: boolean; usdPerVote: number; announce: boolean; name: string }
const blank = (): Draft => ({ question: '', options: [{ label: '', keyword: '' }, { label: '', keyword: '' }], durationSec: 60, subDouble: false, donationVotes: false, usdPerVote: 1, announce: false, name: '' });
const fromTpl = (t: PollTemplate): Draft => ({ question: t.question, options: t.options.map((o) => ({ label: o.label, keyword: o.keyword ?? '' })), durationSec: t.durationSec, subDouble: t.subDouble, donationVotes: t.donationVotes, usdPerVote: t.usdPerVote, announce: t.announce, name: t.name });

/** Mount the poll controls. `toast` shows a message in the host page's style. */
export function pollPanel(toast: (msg: string) => void = (m) => console.log('[poll]', m)): HTMLElement {
  if (!document.getElementById('vpoll-css')) document.head.append(el('style', { id: 'vpoll-css' }, CSS));
  const root = el('div', { class: 'vpoll' });
  const liveEl = el('div');
  const formEl = el('div');
  const listEl = el('div');
  root.append(liveEl, formEl, listEl);
  let st: PollState | null = null;
  let draft = blank();
  let lastTotal = -1;
  let sig = '';

  const run = async (p: Promise<unknown>, ok?: string) => { try { await p; if (ok) toast(ok); await refresh(); } catch (e) { toast((e as Error).message); } };
  const start = (body: unknown) => run(call('POST', '/api/poll/start', body), 'Poll started');

  function paintLive() {
    liveEl.replaceChildren();
    const v = st?.poll;
    if (!v) { liveEl.append(el('p', { class: 'note' }, 'No poll running. Viewers vote in chat with a number (1), !vote 2 or an option word, on every connected platform at once; votes stay out of the chat display.')); return; }
    const ended = v.state === 'ended';
    const left = !ended && v.endsAt ? Math.max(0, Math.ceil((v.endsAt - Date.now()) / 1000)) : null;
    const win = new Set(v.winner);
    const gained = lastTotal >= 0 && v.total > lastTotal ? v.total - lastTotal : 0;
    lastTotal = v.total;
    const plats = Object.entries(v.byPlatform).map(([p, n]) => `${p} ${n}`).join(' · ');
    liveEl.append(el('div', { class: `live${ended ? ' ended' : ''}` },
      el('div', { class: 'row' }, el('b', { style: 'flex:1' }, v.question),
        el('span', null, `${v.total} vote${v.total === 1 ? '' : 's'} `, gained ? el('span', { class: 'pulse' }, `+${gained}`) : null),
        el('span', { class: 'note' }, ended ? '· ended' : left !== null ? `· ${left}s left` : '· until you end it')),
      ...v.options.map((o, i) => el('div', { class: `bar${ended && win.has(i) ? ' win' : ''}` }, el('i', { style: `width:${v.total ? (o.votes / v.total) * 100 : 0}%` }),
        el('span', null, el('span', null, `${ended && win.has(i) ? '👑 ' : ''}${i + 1}. ${o.label}${o.keyword ? `  “${o.keyword}”` : ''}`), el('span', null, `${o.votes}${o.bonus ? ` (+${o.bonus} tips)` : ''}`)))),
      ended ? el('p', null, el('b', null, `Winner: ${winnerText(v)}`), st!.canSend ? ' — posted to chat' : '') : null,
      plats ? el('p', { class: 'note' }, `Voters by platform: ${plats}`) : null,
      el('div', { class: 'row' },
        !ended ? el('button', { class: 'warn', onClick: () => run(call('POST', '/api/poll/end'), 'Poll ended') }, 'End now') : null,
        el('button', { onClick: () => run(call('POST', '/api/poll/hide', { shown: !v.shown })) }, v.shown ? 'Hide on stream' : 'Show on stream'),
        el('button', { onClick: () => run(call('POST', '/api/poll/clear')) }, ended ? 'Clear' : 'Cancel'),
        !ended ? el('button', { title: 'Adds 5 LOCAL test votes (never sent anywhere; they do count in this poll)', onClick: () => run(Promise.all([0, 1, 2, 3, 4].map(() => call('POST', '/api/poll/test-vote', { text: String(1 + Math.floor(Math.random() * v.options.length)) })))) }, '+5 test votes') : null)));
  }

  function paintForm() {
    formEl.replaceChildren();
    const d = draft;
    const opts = el('div', { style: 'display:flex;flex-direction:column;gap:5px' },
      ...d.options.map((o, i) => el('div', { class: 'opt' }, el('b', null, String(i + 1)),
        el('input', { type: 'text', placeholder: `Option ${i + 1}`, value: o.label, maxlength: '48', onInput: (e: Event) => { o.label = (e.target as HTMLInputElement).value; } }),
        el('input', { type: 'text', placeholder: 'keyword (opt.)', value: o.keyword, maxlength: '24', title: 'A word viewers can type instead of the number', onInput: (e: Event) => { o.keyword = (e.target as HTMLInputElement).value; } }),
        el('button', { title: 'Remove', disabled: d.options.length <= POLL_MIN_OPTIONS ? true : undefined, onClick: () => { d.options.splice(i, 1); paintForm(); } }, '×'))));
    const num = (v: number, set: (n: number) => void, attrs: Record<string, unknown>) => el('input', { type: 'number', value: v, style: 'width:80px', ...attrs, onInput: (e: Event) => set(Number((e.target as HTMLInputElement).value)) });
    const cb = (label: string, v: boolean, set: (b: boolean) => void, title = '') => el('label', { title }, el('input', { type: 'checkbox', checked: v, onChange: (e: Event) => set((e.target as HTMLInputElement).checked) }), ' ', label);
    const durs: [number, string][] = [[30, '30 s'], [45, '45 s'], [60, '1 min'], [120, '2 min'], [300, '5 min'], [0, 'Until I end it']];
    formEl.append(
      el('h4', null, 'New poll'),
      el('div', { class: 'row' }, 'Quick:', ...(st?.presets ?? []).map((p) => el('button', { onClick: () => start({ template: p.name }), title: `Start "${p.question}" now` }, p.name)),
        el('button', { onClick: () => { draft = blank(); paintForm(); } }, 'Clear form')),
      el('div', { class: 'row' }, el('input', { type: 'text', placeholder: 'Question — e.g. What should I play next?', value: d.question, maxlength: '140', onInput: (e: Event) => { d.question = (e.target as HTMLInputElement).value; } })),
      opts,
      el('div', { class: 'row' },
        d.options.length < POLL_MAX_OPTIONS ? el('button', { onClick: () => { d.options.push({ label: '', keyword: '' }); paintForm(); } }, '+ Option') : null,
        el('select', { onChange: (e: Event) => { d.durationSec = Number((e.target as HTMLSelectElement).value); } }, ...durs.map(([s, l]) => el('option', { value: s, ...(s === d.durationSec ? { selected: true } : {}) }, l)))),
      el('div', { class: 'row' },
        cb('Subs / members ×2', d.subDouble, (b) => { d.subDouble = b; }, 'Subscribers, members and founders count twice'),
        cb('Donation votes', d.donationVotes, (b) => { d.donationVotes = b; paintForm(); }, 'A tip / Super Chat / bits naming an option adds votes'),
        d.donationVotes ? el('span', null, '1 vote per $', num(d.usdPerVote, (n) => { d.usdPerVote = n; }, { min: '0.1', step: '0.5' })) : null,
        cb('Read aloud on stream', d.announce, (b) => { d.announce = b; }, 'The OBS page says the question and the winner with your Chat Hub voice')),
      el('div', { class: 'row' },
        el('button', { class: 'pri', onClick: () => start(draft) }, st?.poll?.state === 'live' ? 'Start (ends the current poll)' : 'Start poll'),
        el('input', { type: 'text', placeholder: 'Template name', value: d.name, maxlength: '40', style: 'width:150px', onInput: (e: Event) => { d.name = (e.target as HTMLInputElement).value; } }),
        el('button', { onClick: () => run(call('PUT', '/api/poll/templates', draft), 'Saved — a Stream Deck "Start poll" key can start it by name') }, 'Save as template')));
  }

  function paintLists() {
    listEl.replaceChildren();
    const t = st?.templates ?? [], h = st?.history ?? [];
    if (t.length) listEl.append(el('h4', null, 'Saved polls'), el('div', { class: 'list' }, ...t.map((x) => el('div', { class: 'li' },
      el('span', { class: 'grow', title: x.question }, el('b', null, x.name), ` — ${x.options.map((o) => o.label).join(' / ')}`),
      el('button', { onClick: () => start({ template: x.name }) }, 'Start'),
      el('button', { onClick: () => { draft = fromTpl(x); paintForm(); } }, 'Edit'),
      el('button', { title: 'Delete', onClick: () => run(call('DELETE', `/api/poll/templates/${encodeURIComponent(x.name)}`)) }, '×')))));
    if (h.length) listEl.append(el('h4', null, 'Results'), el('div', { class: 'list' }, ...h.map((r) => el('div', { class: 'li', title: r.options.map((o) => `${o.label}: ${o.votes}`).join('\n') },
      el('span', { class: 'grow' }, el('b', null, r.winner), ` — ${r.question}`), el('span', { class: 'note' }, `${r.total} votes · ${new Date(r.endedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)))));
    listEl.append(el('p', { class: 'note' }, 'Stream Deck: the Poll actions.'), forScripts('Streamer.bot / Touch Portal: POST /api/poll/start {"template":"name"} · /api/poll/end · /api/poll/hide.'));
  }

  async function refresh() {
    try { st = await call<PollState>('GET', '/api/poll/state'); } catch { return; }
    const s = JSON.stringify([st.templates, st.history.length, st.presets.length]);
    paintLive();
    if (s !== sig) { const first = !sig; sig = s; paintLists(); if (first) paintForm(); }
  }
  paintForm(); paintLists();
  void refresh();
  setInterval(() => { if (!document.hidden && root.isConnected) void refresh(); }, 1000);
  return root;
}
