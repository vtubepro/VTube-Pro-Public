// Live > Stream extras > "AI co-host" (docs/b16/COHOST.md). Plain words, Simple first: ONE switch, a name and a personality,
// "Try it". Everything else (which AI, how often, what it answers, banned words, reactions) sits under "More settings".
// Talks only to this PC's VTube Pro server (/api/cohost/*). It holds no key: the AI is the model on this PC set up on "Connect an AI".
// The screen is a pure function of the server's answer (`cohostView`), so the words and the
// defaults can be checked without a browser.
import { COHOST_LIMITS, COHOST_REACTIONS, REACTION_LABEL, type CohostConfig, type CohostReaction } from '../../server/cohost/config.ts';
import type { CohostState } from '../../server/cohost/engine.ts';
import { h } from './dom.ts';

export interface PanelState {
  config: CohostConfig;
  state: CohostState;
  connections: { id: string; label: string; ready: boolean }[];
  voice: { engine: string; where: string } | null;
}
export interface PanelOpts {
  /** The switch or the mute changed: the studio starts / stops listening to the mic. */
  onState?(s: { on: boolean; muted: boolean }): void;
  /** The chat buddy (the co-host talks through it). Absent = no scene here. */
  buddy?: { isOn(): boolean; turnOn(): void };
}

/** The sentences the panel shows from the helper's answer. Pure. */
export function cohostView(s: PanelState, buddyOn: boolean | null) {
  const c = s.config, st = s.state;
  const ready = s.connections.filter((x) => x.ready);
  const chosen = c.model.provider === 'auto' ? null : s.connections.find((x) => x.id === c.model.provider) ?? null;
  const aiReady = c.model.provider === 'auto' ? ready.length > 0 : !!chosen?.ready;
  let status: string;
  if (!c.on) status = 'Off. Nothing from your chat is read, sent to an AI or said until you turn it on.';
  else if (st.muted) status = 'Muted. It stays quiet until you unmute it.';
  else if (!aiReady) status = c.model.provider === 'auto' ? 'On, but no AI model was found on this PC. Set one up on "Connect an AI".' : `On, but "${chosen?.label ?? c.model.provider}" is not ready. Check it on "Connect an AI".`;
  else if (st.speaking) status = `${c.persona.name} is talking.`;
  else if (st.waiting) status = `${c.persona.name} is thinking about ${st.waiting === 1 ? 'a question' : `${st.waiting} questions`}${st.hostSpeaking ? ' and waiting for you to finish' : ''}.`;
  else status = `On. ${c.persona.name} answers questions, @${c.persona.name} and the "${c.answers.redeemTitle}" reward.`;
  const notes: string[] = [];
  if (c.on && buddyOn === false) notes.push('The chat buddy is off, so you will only get the voice and the caption.');
  if (c.on && c.speak && s.voice) notes.push(`Voice: your Read-aloud voice (${s.voice.engine === 'system' ? 'this computer’s voice' : s.voice.engine === 'kokoro' ? 'Kokoro' : 'your voice'}). Change it in the Chat Hub.`);
  if (c.on && aiReady) notes.push('The AI runs on this PC. Nothing leaves it.');
  return { status, notes, aiReady, last: st.last, problem: c.on ? st.note : '' };
}

const CSS = `
.vcoh{font:13px/1.4 Inter,"Segoe UI",system-ui,sans-serif;color:var(--text,#e7eaf0);display:flex;flex-direction:column;gap:10px;min-width:0}
.vcoh .note{color:var(--dim,#9aa3b2);font-size:12px}
.vcoh .big{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px;border:1px solid #2a303c;border-radius:10px;background:#151922}
.vcoh .big.on{border-color:#7bd88f88}
.vcoh .stat{flex:1;min-width:180px}
.vcoh button{background:#262c3a;color:inherit;border:1px solid #333b4b;border-radius:8px;padding:6px 10px;font:inherit;cursor:pointer;white-space:nowrap}
.vcoh button:hover{background:#2f3647}
.vcoh button.pri{background:var(--accent,#7bd88f);color:#0d1a10;border-color:transparent;font-weight:700}
.vcoh button:disabled{opacity:.5;cursor:default}
.vcoh .f{display:grid;grid-template-columns:minmax(110px,36%) 1fr;gap:6px 8px;align-items:center;margin:4px 0}
.vcoh .f>span{color:var(--dim,#9aa3b2)}
.vcoh input[type=text],.vcoh input[type=number],.vcoh select,.vcoh textarea{width:100%;box-sizing:border-box;background:#12151b;color:inherit;border:1px solid #2a303c;border-radius:7px;padding:5px 7px;font:inherit}
.vcoh textarea{min-height:64px;resize:vertical}
.vcoh details{border:1px solid #2a303c;border-radius:10px;padding:6px 9px;background:#151922}
.vcoh details>summary{cursor:pointer;font-weight:600;padding:2px 0}
.vcoh .chk{display:flex;gap:8px;align-items:center;margin:3px 0}
.vcoh .said{border-left:3px solid #7bd88f;padding:4px 8px;background:#12151b;border-radius:0 7px 7px 0;overflow-wrap:anywhere}
.vcoh .warn{color:#ffd9a0}
.vcoh .err{color:#ffb0b0}
.vcoh .bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.vcoh .bar input[type=text]{flex:1 1 160px;width:auto;min-width:0}
`;

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || `HTTP ${r.status}`);
  return j as T;
}

export function mountCohostPanel(host: HTMLElement, opts: PanelOpts = {}): { destroy(): void } {
  if (!document.getElementById('vcoh-css')) { const s = document.createElement('style'); s.id = 'vcoh-css'; s.textContent = CSS; document.head.append(s); }
  const root = h('div', { class: 'vcoh', 'data-cohost': 'panel' });
  host.append(root);
  let S: PanelState | null = null, err = '', gone = false, timer = 0, saveT = 0, trying = false, tryOut = '';
  let pending: Record<string, unknown> | null = null;
  // What the streamer is in the middle of must survive the 3-second poll: whether "More settings" is open, the text in the
  // Try it box, and the field they are typing in (the screen is not rebuilt under their hands, only the status text moves).
  let moreOpen = false, tryIn = '';
  let refs: { on: boolean; status: HTMLElement; mute: HTMLElement | null; live: HTMLElement; out: HTMLElement; tryBtn: HTMLButtonElement } | null = null;
  const TYPING = 'input[type=text],input[type=number],textarea,select';
  const FOCUSABLE = 'input,textarea,select,button,summary';
  /** True while a text field, number field, text area or list inside the panel has the keyboard. */
  const typing = () => { const a = document.activeElement; return !!a && root.contains(a) && a.matches(TYPING); };

  const load = async (fresh = false) => {
    try { S = await call<PanelState>('GET', `/api/cohost/state${fresh ? '?fresh=1' : ''}`); err = ''; opts.onState?.({ on: S.config.on, muted: S.state.muted }); }
    catch (e) { err = (e as Error).message; }
    refresh();
  };
  const flush = async () => {
    saveT = 0;
    if (!pending) return;
    const patch = pending; pending = null;
    try { S = await call<PanelState>('PUT', '/api/cohost/config', patch); err = ''; opts.onState?.({ on: S.config.on, muted: S.state.muted }); }
    catch (e) { err = (e as Error).message; }
    refresh();
  };
  /** Save a change (merged, one request a moment later). The screen follows the helper's answer. */
  const save = (patch: Record<string, unknown>, now = false) => {
    pending = deepMerge(pending ?? {}, patch);
    if (S) S = { ...S, config: mergeConfig(S.config, patch) };
    if (saveT) clearTimeout(saveT);
    if (now) void flush(); else saveT = window.setTimeout(() => void flush(), 450);
  };

  const row = (label: string, control: Node, hint?: string) => h('div', { class: 'f', title: hint ?? '' }, h('span', null, label), control);
  const check = (label: string, on: boolean, set: (v: boolean) => void, hint?: string) =>
    h('label', { class: 'chk', title: hint ?? '' }, h('input', { type: 'checkbox', checked: on, onChange: (e: Event) => set((e.target as HTMLInputElement).checked) }), h('span', null, label));
  const num = (v: number, lo: number, hi: number, set: (n: number) => void) =>
    h('input', { type: 'number', min: String(lo), max: String(hi), value: String(v), onChange: (e: Event) => set(Number((e.target as HTMLInputElement).value)) });

  /** Rebuild the screen from `S`, keeping the keyboard on the same control when the layout is unchanged. */
  function redraw() {
    const a = document.activeElement as HTMLElement | null;
    const idx = a && root.contains(a) ? [...root.querySelectorAll(FOCUSABLE)].indexOf(a) : -1;
    const n = root.querySelectorAll(FOCUSABLE).length;
    draw();
    if (idx < 0) return;
    const list = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const el = list.length === n ? list[idx] : null;
    if (!el) return;
    el.focus({ preventScroll: true });
    if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === 'text')) { try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* not selectable */ } }
  }
  /** The poll / save answer arrived. While the streamer is typing only the status, notes and last line move; the form stays. */
  function refresh() {
    if (gone) return;
    if (typing()) patchLive(); else redraw();
  }
  function patchLive() {
    if (!S || !refs || S.config.on !== refs.on) return;
    const v = cohostView(S, opts.buddy ? opts.buddy.isOn() : null);
    refs.status.textContent = v.status;
    if (refs.mute) refs.mute.textContent = S.state.muted ? 'Unmute' : 'Mute co-host';
    fillLive(refs.live);
  }
  /** The part of the screen that follows the helper: notes, chat-buddy button, problem, error, last line. */
  function fillLive(box: HTMLElement) {
    box.replaceChildren();
    if (!S) return;
    const c = S.config;
    const buddyOn = opts.buddy ? opts.buddy.isOn() : null;
    const v = cohostView(S, buddyOn);
    for (const n of v.notes) box.append(h('div', { class: 'note' }, n));
    if (c.on && buddyOn === false && opts.buddy) box.append(h('div', { class: 'bar' }, h('button', { onClick: () => { opts.buddy!.turnOn(); window.setTimeout(refresh, 400); } }, 'Turn on the chat buddy')));
    if (v.problem) box.append(h('div', { class: 'warn', 'data-cohost': 'note' }, v.problem));
    if (err) box.append(h('div', { class: 'err' }, err));
    if (v.last) box.append(h('div', null, h('div', { class: 'note' }, `Last thing ${c.persona.name} said${v.last.to ? ` to ${v.last.to}` : ''}:`), h('div', { class: 'said', 'data-cohost': 'last' }, v.last.text)));
  }
  /** Paint the Try it answer and the button in place (no rebuild, so typing in the box is never interrupted). */
  function paintTry() {
    if (!refs) return;
    refs.out.className = tryOut.startsWith('!') ? 'err' : 'said';
    refs.out.style.display = tryOut ? '' : 'none';
    refs.out.textContent = tryOut.replace(/^!/, '');
    refs.tryBtn.disabled = trying;
  }

  function draw() {
    refs = null;
    root.replaceChildren();
    if (!S) { root.append(h('div', { class: err ? 'err' : 'note' }, err || 'Loading…')); return; }
    const c = S.config, st = S.state;
    const buddyOn = opts.buddy ? opts.buddy.isOn() : null;
    const v = cohostView(S, buddyOn);
    // ---- the one switch
    const statusEl = h('div', { 'data-cohost': 'status' }, v.status);
    const muteBtn = c.on ? h('button', { 'data-cohost': 'mute', onClick: () => void call<{ muted: boolean }>('POST', '/api/cohost/mute', { on: !st.muted }).then(() => load()) }, st.muted ? 'Unmute' : 'Mute co-host') : null;
    root.append(h('div', { class: `big${c.on ? ' on' : ''}` },
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', 'data-cohost': 'on', checked: c.on, onChange: (e: Event) => save({ on: (e.target as HTMLInputElement).checked }, true) }), h('b', null, 'AI co-host')),
      h('div', { class: 'stat' }, statusEl),
      muteBtn));
    const live = h('div', { style: 'display:flex;flex-direction:column;gap:10px' });
    fillLive(live);
    root.append(live);

    // ---- who it is
    root.append(
      row('Name', h('input', { type: 'text', 'data-cohost': 'name', maxlength: String(COHOST_LIMITS.nameMax), value: c.persona.name, onChange: (e: Event) => save({ persona: { name: (e.target as HTMLInputElement).value } }) }), 'Viewers can say this name to talk to it'),
      row('Personality', h('textarea', { 'data-cohost': 'personality', maxlength: String(COHOST_LIMITS.personalityMax), onChange: (e: Event) => save({ persona: { personality: (e.target as HTMLTextAreaElement).value } }) }, c.persona.personality), 'A few plain sentences: who it is and how it talks'),
      check('Say it out loud', c.speak, (x) => save({ speak: x }), 'Uses your Read-aloud voice. The sound plays in this window, like every other sound of the show'),
      check('Show what it says on the stream', c.caption, (x) => save({ caption: x })));

    // ---- try it
    const input = h('input', { type: 'text', 'data-cohost': 'try', placeholder: 'Ask it something to see how it answers', maxlength: '200', value: tryIn, onInput: (e: Event) => { tryIn = (e.target as HTMLInputElement).value; } });
    const out = h('div', { 'data-cohost': 'try-out' });
    const tryBtn = h('button', { 'data-cohost': 'try-go', onClick: () => void go() }, 'Try it');
    const go = async () => {
      if (trying || !input.value.trim()) return;
      trying = true; tryOut = 'Thinking…'; paintTry();
      try { const r = await call<{ ok: boolean; text?: string; why: string }>('POST', '/api/cohost/try', { text: input.value }); tryOut = r.ok ? r.text ?? '' : `!${r.why}`; }
      catch (e) { tryOut = `!${(e as Error).message}`; }
      trying = false; if (!gone) paintTry();
    };
    root.append(h('div', { class: 'bar' }, input, tryBtn),
      h('div', { class: 'note' }, 'Try it never speaks and never shows anything on the stream.'), out);
    refs = { on: c.on, status: statusEl, mute: muteBtn, live, out, tryBtn };
    paintTry();
    input.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') void go(); });

    // ---- more
    const providers = S.connections;
    const more = h('details', { 'data-cohost': 'more', open: moreOpen, onToggle: (e: Event) => { moreOpen = (e.target as HTMLDetailsElement).open; } }, h('summary', null, 'More settings'));
    more.append(
      row('Which AI', h('select', { 'data-cohost': 'provider', onChange: (e: Event) => save({ model: { provider: (e.target as HTMLSelectElement).value, model: '' } }) },
        h('option', { value: 'auto', selected: c.model.provider === 'auto' }, 'A model on this PC (free)'),
        ...providers.filter((p) => p.id !== 'local').map((p) => h('option', { value: p.id, selected: c.model.provider === p.id }, `${p.label}${p.ready ? '' : ' (not set up)'}`))), 'Set these up on the "Connect an AI" page'),
      row('Model name', h('input', { type: 'text', placeholder: 'leave empty for the default', value: c.model.model, onChange: (e: Event) => save({ model: { provider: c.model.provider, model: (e.target as HTMLInputElement).value } }) })),
      h('div', { class: 'note' }, 'Replies are short. The reply limit below keeps the model from answering too often.'),
      row('Replies a minute', num(c.rate.perMinute, ...COHOST_LIMITS.perMinute, (n) => save({ rate: { perMinute: n } }))),
      row('Seconds between replies', num(c.rate.gapSecs, ...COHOST_LIMITS.gapSecs, (n) => save({ rate: { gapSecs: n } }))),
      row('Most replies an hour', num(c.rate.perHour, ...COHOST_LIMITS.perHour, (n) => save({ rate: { perHour: n } }))),
      check('Answer questions', c.answers.questions, (x) => save({ answers: { questions: x } })),
      check(`Answer when someone says @${c.persona.name}`, c.answers.mentions, (x) => save({ answers: { mentions: x } })),
      check('Answer a channel-point reward', c.answers.redeem, (x) => save({ answers: { redeem: x } })),
      row('Reward name', h('input', { type: 'text', maxlength: String(COHOST_LIMITS.titleMax), value: c.answers.redeemTitle, onChange: (e: Event) => save({ answers: { redeemTitle: (e.target as HTMLInputElement).value } }) }), 'Make a reward with this exact name on your channel'),
      check('Wait until nobody is talking', c.waitForSilence, (x) => save({ waitForSilence: x }), 'It never talks over you'),
      row('Words it never says', h('input', { type: 'text', 'data-cohost': 'banned', placeholder: 'comma, separated', value: c.persona.banned.join(', '), onChange: (e: Event) => save({ persona: { banned: (e.target as HTMLInputElement).value } }) }), 'A reply with one of these words is thrown away'),
      h('div', { class: 'note' }, 'It already skips rude lines, links and commands, and it never reads a line you hid or a moderator removed. It can never post in chat.'),
      h('div', { class: 'note' }, 'It may also react when it feels like it:'),
      ...COHOST_REACTIONS.map((k: CohostReaction) => check(REACTION_LABEL[k], c.reactions.includes(k), (x) => save({ reactions: x ? [...new Set([...c.reactions, k])] : c.reactions.filter((r) => r !== k) }))),
      h('div', { class: 'bar' }, h('button', { onClick: () => void call('POST', '/api/cohost/say', { text: '' }).then(() => load(), (e: Error) => { err = e.message; refresh(); }), title: 'Make it answer the newest question in chat now' }, 'Answer chat now'),
        h('button', { onClick: () => void load(true) }, 'Check the AI again')));
    root.append(more);
  }

  void load(true);
  timer = window.setInterval(() => { if (!saveT && !trying) void load(); }, 3000);
  return { destroy() { gone = true; clearInterval(timer); if (saveT) { clearTimeout(saveT); void flush(); } root.remove(); } };
}

/** Merge a settings patch into the config the way the helper does (just enough for the screen to follow before the answer arrives). */
function mergeConfig(c: CohostConfig, p: Record<string, unknown>): CohostConfig {
  const m = deepMerge(JSON.parse(JSON.stringify(c)) as Record<string, unknown>, p) as unknown as CohostConfig;
  if (typeof (p.persona as { banned?: unknown } | undefined)?.banned === 'string') m.persona.banned = String((p.persona as { banned: string }).banned).split(/[,\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  return m;
}
function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) deepMerge(a[k] as Record<string, unknown>, v as Record<string, unknown>);
    else a[k] = v;
  }
  return a;
}
