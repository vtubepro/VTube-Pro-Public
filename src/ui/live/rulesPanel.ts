// Live > Stream extras > "Redeems & reactions" (docs/b16/RULES.md): the rule list and the editor.
// Plain words, Simple first: each rule is one card with an on/off switch, a sentence that says what it does, and a Try it button.
// The editor asks three things: WHEN (what happens), DO (what the avatar does), GO BACK (after how long). Everything else
// (waiting between uses, gift-bomb line-up, delays between steps, more than one trigger) sits under "More options".
// Nothing here posts anywhere: Try it runs the rule for real on the avatar and says so.
import { api } from '../../api.ts';
import { comboOf } from '../../../shared/hotkey.ts';
import type { DeckParam } from '../../../shared/deck.ts';
import {
  MAX_RULES, MAX_RULE_CHAIN, MAX_WHEN, emitRuleTrigger, parseRuleSet, sanitizeRule, sanitizeStep, sanitizeWhen, stringifyRuleSet,
  type RuleStep, type RuleWhen, type StreamRule,
} from '../../../shared/streamRules.ts';
import { GROUP_ORDER, actionOptions, defaultParams, type ActionOption } from '../../rules/actions.ts';
import { describeImport, describeRule, describeSecs } from '../../rules/describe.ts';
import { ruleNeedsScream } from '../../rules/inputWants.ts';
import { starterRules } from '../../rules/starters.ts';
import { rulesRuntime } from '../../rules/store.ts';
import { WHEN_FORMS, WHEN_FORM_BY_KIND, shown, stored, type Field } from '../../rules/whenForms.ts';
import { h, toast } from '../dom.ts';

const CSS = `
.vtr { --r-bg: var(--card, #1b1f28); --r-bg2: var(--card2, #222733); --r-text: var(--text, #eef1f6); --r-dim: var(--dim, #a3abba); --r-edge: color-mix(in srgb, var(--r-text) 14%, transparent);
  --r-acc: var(--accent, #7bd88f); --r-ink: var(--accent-ink, #08130b); --r-warn: #ffb454; --r-err: #ff6b6b; color: var(--r-text); font-size: 13px; line-height: 1.35; display: flex; flex-direction: column; gap: 10px; }
.vtr * { box-sizing: border-box; }
.vtr button, .vtr select, .vtr input { font: inherit; color: inherit; }
.vtr h3 { margin: 0; font-size: 17px; }
.vtr .r-sub { color: var(--r-dim); margin: 2px 0 0; }
.vtr .r-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.vtr .r-btn { min-height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--r-edge); background: var(--r-bg2); cursor: pointer; }
.vtr .r-btn:hover { border-color: var(--r-acc); }
.vtr .r-btn.pri { background: var(--r-acc); color: var(--r-ink); border-color: transparent; font-weight: 700; }
.vtr .r-btn.danger:hover { border-color: var(--r-err); color: var(--r-err); }
.vtr .r-btn.s { min-height: 28px; padding: 0 9px; font-size: 12px; }
.vtr .r-note { padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, var(--r-warn) 14%, var(--r-bg)); border: 1px solid color-mix(in srgb, var(--r-warn) 50%, transparent); }
.vtr .r-note.err { background: color-mix(in srgb, var(--r-err) 14%, var(--r-bg)); border-color: color-mix(in srgb, var(--r-err) 50%, transparent); }
.vtr .r-empty { padding: 18px; text-align: center; color: var(--r-dim); border: 1px dashed var(--r-edge); border-radius: 10px; }
.vtr .r-list { display: flex; flex-direction: column; gap: 8px; }
.vtr .r-card { display: grid; grid-template-columns: auto 1fr auto; gap: 4px 12px; align-items: center; padding: 10px 12px; background: var(--r-bg); border: 1px solid var(--r-edge); border-radius: 10px; }
.vtr .r-card.on { border-color: color-mix(in srgb, var(--r-acc) 60%, transparent); }
.vtr .r-name { font-weight: 700; }
.vtr .r-what { color: var(--r-dim); grid-column: 2 / 3; }
.vtr .r-chip { display: inline-block; margin-top: 2px; padding: 1px 8px; border-radius: 999px; background: var(--r-bg2); border: 1px solid var(--r-edge); font-size: 11px; color: var(--r-dim); }
.vtr .r-chip.warn { color: var(--r-warn); border-color: color-mix(in srgb, var(--r-warn) 50%, transparent); }
.vtr .r-acts { display: flex; gap: 6px; flex-wrap: wrap; grid-row: 1 / 3; grid-column: 3; justify-content: flex-end; }
.vtr .r-sw { position: relative; width: 42px; height: 24px; flex: none; }
.vtr .r-sw input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; width: 100%; height: 100%; }
.vtr .r-sw i { position: absolute; inset: 0; border-radius: 999px; background: var(--r-bg2); border: 1px solid var(--r-edge); transition: background 120ms; pointer-events: none; }
.vtr .r-sw i::after { content: ''; position: absolute; left: 2px; top: 2px; width: 18px; height: 18px; border-radius: 50%; background: var(--r-dim); transition: transform 120ms, background 120ms; }
.vtr .r-sw input:checked + i { background: var(--r-acc); }
.vtr .r-sw input:checked + i::after { transform: translateX(18px); background: var(--r-ink); }
.vtr .r-sw input:focus-visible + i { outline: 2px solid var(--focus, #8ab4ff); outline-offset: 2px; }
.vtr .r-ed { display: flex; flex-direction: column; gap: 12px; }
.vtr .r-sec { padding: 10px 12px; background: var(--r-bg); border: 1px solid var(--r-edge); border-radius: 10px; display: flex; flex-direction: column; gap: 8px; }
.vtr .r-sec > h4 { margin: 0; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--r-dim); }
.vtr .r-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; padding: 8px; border-radius: 8px; background: var(--r-bg2); }
.vtr .r-fld { display: flex; flex-direction: column; gap: 3px; min-width: 110px; }
.vtr .r-fld > span { font-size: 11px; color: var(--r-dim); }
.vtr .r-fld input[type=text], .vtr .r-fld input[type=number], .vtr .r-fld select { min-height: 30px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--r-edge); background: var(--r-bg); }
.vtr .r-fld input[type=number] { width: 96px; }
.vtr .r-fld.chk { flex-direction: row; align-items: center; gap: 6px; min-height: 30px; }
.vtr .r-multi { display: flex; flex-wrap: wrap; gap: 4px 10px; }
.vtr .r-multi label { display: inline-flex; gap: 4px; align-items: center; }
.vtr .r-hint { font-size: 11px; color: var(--r-dim); }
.vtr .r-or { text-align: center; color: var(--r-dim); font-size: 11px; }
.vtr details > summary { cursor: pointer; color: var(--r-dim); }
.vtr .r-gal { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; }
.vtr .r-gal button { text-align: left; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--r-edge); background: var(--r-bg2); cursor: pointer; }
.vtr .r-gal button:hover { border-color: var(--r-acc); }
@media (prefers-reduced-motion: reduce) { .vtr .r-sw i, .vtr .r-sw i::after { transition: none; } }
`;

const el = (tag: string, cls?: string, ...kids: (Node | string | null | false | undefined)[]) => h(tag as 'div', cls ? { class: cls } : null, ...kids);
const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 5 ? 'just now' : s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

export function drawRulesPanel(host: HTMLElement): { destroy(): void } {
  if (!document.getElementById('vtp-rules-css')) document.head.append(h('style', { id: 'vtp-rules-css' }, CSS));
  const store = rulesRuntime.store;
  const root = el('div', 'vtr');
  host.replaceChildren(root);
  let actions: ActionOption[] = actionOptions();
  const byId = () => new Map(actions.map((a) => [a.id, a]));
  const labelOf = (id: string) => byId().get(id)?.label;
  const paramsOf = (id: string) => byId().get(id)?.params;
  let editing: { draft: StreamRule; isNew: boolean; error: string } | null = null;
  let note = '';
  let dead = false;
  // "when I get loud" fires only while the Soundboard's scream detector is on: ask it (null = not known, so no warning)
  let screamOn: () => boolean | null = () => null;
  void import('../../audio/soundfxMount.ts').then((m) => { screamOn = () => m.soundfxApi()?.cfg().scream.on ?? null; if (!dead && !editing) draw(); }).catch(() => { /* no soundboard in this page */ });
  let stopLearn: (() => void) | null = null;   // the "Learn a key" listener, while one is waiting

  // other lanes register their actions in the helper too: ask once so the list is complete in this page
  void api.get<{ actions?: { id: string; meta: { label: string; group?: string; params?: DeckParam[]; undoable?: boolean; sound?: boolean } }[] }>('/api/rules/actions').then((j) => {
    if (dead || !j.actions?.length) return;
    const known = byId();
    for (const a of j.actions) if (!known.has(a.id)) actions.push({ id: a.id, label: a.meta.label, group: 'More', hint: '', params: a.meta.params ?? [], undoable: !!a.meta.undoable, sound: !!a.meta.sound });
    if (!editing) draw();
  }).catch(() => { /* an older version: the list of deck actions is all there is */ });

  const save = (rules: StreamRule[]) => store.save(rules);

  // ------------------------------------------------------------ the list
  function tryIt(r: StreamRule) {
    const id = `try-${r.id}-${Date.now().toString(36)}`;
    if (rulesRuntime.engine) {
      emitRuleTrigger({ kind: 'manual', id, ts: Date.now(), rule: r.id, test: true, user: 'Viewer' });
      toast(`Tried “${r.name}”. It ran on your avatar; nothing was posted anywhere.`, 'ok', 3200);
    } else {
      void fetch(`/api/rules/run/${encodeURIComponent(r.id)}`, { method: 'POST' }).then((x) => {
        toast(x.ok ? `Tried “${r.name}” in your studio.` : 'Could not try it: open your studio first.', x.ok ? 'ok' : 'warn', 3200);
      }).catch(() => toast('Could not reach VTube Pro.', 'warn'));
    }
  }

  function statusChip(r: StreamRule): HTMLElement | null {
    const eng = rulesRuntime.engine;
    if (!eng) return null;
    const st = eng.state(r.id), last = eng.last.get(r.id);
    const now = Date.now();
    if (r.enabled && ruleNeedsScream(r) && screamOn() === false) return el('span', 'r-chip warn', 'Waiting for a scream: switch on the scream detector in Soundboard, or this rule never fires');
    if (st.revertAt > now) return el('span', 'r-chip warn', `Goes back in ${describeSecs(Math.ceil((st.revertAt - now) / 1000))}`);
    if (st.waiting) return el('span', 'r-chip warn', `${st.waiting} waiting in line`);
    if (!last) return null;
    const who = last.user && last.user !== 'Viewer' ? ` for ${last.user}` : '';
    const text = last.kind === 'ran' ? `Ran ${ago(now - last.at)}${who}` : last.kind === 'reverted' ? `Put back ${ago(now - last.at)}` : last.kind === 'cooldown' ? 'Skipped: still cooling down'
      : last.kind === 'queued' ? 'Waiting in line' : last.kind === 'full' ? 'Skipped: the line was full' : `Problem: ${last.detail ?? 'a step failed'}`;
    return el('span', `r-chip${last.kind === 'failed' ? ' warn' : ''}`, text);
  }

  function card(r: StreamRule): HTMLElement {
    const sw = h('label', { class: 'r-sw', title: r.enabled ? 'On: click to turn off' : 'Off: click to turn on' },
      h('input', { type: 'checkbox', checked: r.enabled, 'aria-label': `${r.name}: on or off`, onChange: (e: Event) => { void store.update(r.id, { enabled: (e.target as HTMLInputElement).checked }); } }), h('i'));
    const acts = el('div', 'r-acts',
      h('button', { class: 'r-btn s', title: 'Run this rule once right now. Nothing is posted anywhere.', onClick: () => tryIt(r) }, 'Try it'),
      h('button', { class: 'r-btn s', onClick: () => { editing = { draft: structuredClone(r), isNew: false, error: '' }; draw(); } }, 'Edit'),
      r.starter ? h('button', { class: 'r-btn s', title: 'Put this ready-made rule back the way it came (it stays off)', onClick: () => {
        const orig = starterRules().find((s) => s.id === r.id);
        if (orig) void save(store.rules.map((x) => (x.id === r.id ? orig : x)));
      } }, 'Reset') : null,
      h('button', { class: 'r-btn s', title: 'Make a copy to change', onClick: () => {
        const copy: StreamRule = { ...structuredClone(r), id: store.freshId(r.name), name: `${r.name} (copy)`, enabled: false, starter: undefined };
        void save([...store.rules, copy]);
      } }, 'Copy'),
      h('button', { class: 'r-btn s danger', onClick: () => { if (confirm(`Delete “${r.name}”?`)) void store.remove(r.id); } }, 'Delete'));
    const chip = statusChip(r);
    return h('div', { class: `r-card${r.enabled ? ' on' : ''}`, 'data-rule': r.id },
      sw, el('div', 'r-name', r.name), acts, el('div', 'r-what', describeRule(r, labelOf, paramsOf), r.note ? ` ${r.note}` : '', h('div', { 'data-chip': r.id }, chip)));
  }

  function listView() {
    const rules = store.rules;
    const eng = rulesRuntime.engine;
    const missing = starterRules().filter((s) => !rules.some((r) => r.id === s.id));
    const kids: (Node | null)[] = [];
    kids.push(el('div', '', el('p', 'r-sub', 'When chat redeems, donates, follows or types a command, your avatar reacts for a few seconds, then goes back. No other program needed.')));
    if (store.error) kids.push(el('div', 'r-note err', store.error));
    if (rulesRuntime.observer) kids.push(el('div', 'r-note', 'This is a test window, so rules only show here. Open your real studio to run them.'));
    else if (!eng && store.loaded) kids.push(el('div', 'r-note', 'Rules start a few seconds after the studio opens.'));
    if (note) kids.push(el('div', 'r-note', note));
    const bar = el('div', 'r-bar',
      h('button', { class: 'r-btn pri', onClick: () => { editing = { draft: newRule(), isNew: true, error: '' }; draw(); } }, '+ New rule'),
      missing.length ? h('button', { class: 'r-btn', title: 'Ready-made rules you can change', onClick: () => { gallery = !gallery; draw(); } }, gallery ? 'Hide ready-made rules' : `Ready-made rules (${missing.length})`) : null,
      h('button', { class: 'r-btn', title: 'Load a .vtprules.json file. Imported rules are always switched off.', onClick: importFile }, 'Import'),
      h('button', { class: 'r-btn', disabled: !rules.length, title: 'Save all your rules to a file you can share', onClick: exportFile }, 'Export'),
      eng && eng.pending().length ? h('button', { class: 'r-btn', title: 'Undo everything the rules changed and are waiting to put back', onClick: () => { void eng.revertDue(true).then(() => draw()); } }, 'Put everything back now') : null);
    kids.push(bar);
    if (gallery && missing.length) {
      kids.push(el('div', 'r-gal', ...missing.map((s) => h('button', { 'data-starter': s.id, onClick: () => { void save([...store.rules, s]); toast(`Added “${s.name}” (switched off). Turn it on when you are ready.`, 'ok', 3200); } },
        el('b', '', s.name), el('div', 'r-hint', s.note ?? '')))));
    }
    if (!store.loaded) kids.push(el('div', 'r-empty', 'Loading your rules...'));
    else if (!rules.length) kids.push(el('div', 'r-empty', 'No rules yet. Add a ready-made one, or press “+ New rule”.'));
    else kids.push(el('div', 'r-list', ...rules.map(card)));
    kids.push(el('p', 'r-hint', 'Rules only act while the studio is open. Try it never posts to chat or to any site. Outfits, accessories, items, lights and the camera go back by themselves when you set “go back after”.'));
    root.replaceChildren(...kids.filter((k): k is Node => !!k));
  }
  let gallery = false;

  function newRule(): StreamRule {
    return { id: store.freshId('my-rule'), name: 'My rule', enabled: false, when: [WHEN_FORMS[0].make()], then: [{ action: 'emote', params: { name: rulesRuntime.env?.emotes()[0]?.id ?? 'idle_rail_call' } }], revertSecs: 0, cooldownSecs: 5 };
  }

  function exportFile() {
    const blob = new Blob([stringifyRuleSet(store.rules, 'My VTube Pro rules')], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'my-rules.vtprules.json' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function importFile() {
    const input = h('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (!f) return;
      if (f.size > 1_000_000) { note = 'That file is too big to be a rules file.'; draw(); return; }
      void f.text().then((text) => {
        const set = parseRuleSet(text, true);
        if (!set) { note = 'That is not a VTube Pro rules file (.vtprules.json).'; draw(); return; }
        const rules = [...store.rules];
        for (const r of set.rules) { if (rules.length >= MAX_RULES) break; rules.push({ ...r, id: ((): string => { let id = r.id, n = 2; while (rules.some((x) => x.id === id)) id = `${r.id.slice(0, 44)}-${n++}`; return id; })(), enabled: false, starter: undefined }); }
        note = describeImport(set);
        void save(rules);
      });
    });
    input.click();
  }

  // ------------------------------------------------------------ the editor
  const input = (cls: string, label: string, control: HTMLElement) => el('label', cls, el('span', '', label), control);

  function whenRow(w: RuleWhen & Record<string, unknown>, i: number, d: StreamRule): HTMLElement {
    const form = WHEN_FORM_BY_KIND.get(w.kind) ?? WHEN_FORMS[0];
    const kindSel = h('select', { 'aria-label': 'When', onChange: (e: Event) => {
      const f = WHEN_FORM_BY_KIND.get((e.target as HTMLSelectElement).value);
      if (f) { d.when[i] = f.make(); draw(); }
    } }, ...WHEN_FORMS.map((f) => h('option', { value: f.kind, selected: f.kind === w.kind }, f.label)));
    const kids: (Node | null)[] = [input('r-fld', 'When', kindSel)];
    for (const f of form.fields) kids.push(fieldControl(f, w, d));
    if (w.kind === 'key') kids.push(h('button', { class: 'r-btn s', title: 'Press the key you want', onClick: (ev: MouseEvent) => learnKey(ev.currentTarget as HTMLButtonElement, w) }, 'Learn a key'));
    if (d.when.length > 1) kids.push(h('button', { class: 'r-btn s danger', title: 'Remove this', onClick: () => { d.when.splice(i, 1); draw(); } }, 'Remove'));
    return el('div', 'r-row', ...kids);
  }
  function learnKey(btn: HTMLButtonElement, w: Record<string, unknown>) {
    stopLearn?.();
    const label = btn.textContent;
    btn.textContent = 'Press a key... (Esc stops)';
    const off = () => { window.removeEventListener('keydown', on, true); window.removeEventListener('blur', onBlur); if (stopLearn === off) stopLearn = null; };
    const onBlur = () => { off(); btn.textContent = label; };
    const on = (e: KeyboardEvent) => {
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      off();
      if (e.key === 'Escape') { btn.textContent = label; return; }
      const combo = comboOf(e);   // the same names the key runtime emits (Up, Num1, Space ...), so a learned key really fires
      if (!combo) { btn.textContent = label; toast('That key cannot start a rule. Try another one.', 'warn'); return; }
      w.combo = combo;
      draw();
    };
    stopLearn = off;
    window.addEventListener('keydown', on, true);
    window.addEventListener('blur', onBlur);
  }

  function fieldControl(f: Field, w: Record<string, unknown>, d: StreamRule): HTMLElement {
    void d;
    const hint = f.hint ? el('span', 'r-hint', f.hint) : null;
    if (f.kind === 'check') {
      return h('label', { class: 'r-fld chk' }, h('input', { type: 'checkbox', checked: w[f.key] === true, onChange: (e: Event) => { w[f.key] = (e.target as HTMLInputElement).checked || undefined; } }), el('span', '', f.label));
    }
    if (f.kind === 'select') {
      const cur = typeof w[f.key] === 'string' ? w[f.key] as string : '';
      return input('r-fld', f.label, h('select', { onChange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; w[f.key] = v || undefined; } }, ...(f.options ?? []).map(([v, l]) => h('option', { value: v, selected: v === cur }, l))));
    }
    if (f.kind === 'multi') {
      const cur = new Set(Array.isArray(w[f.key]) ? w[f.key] as string[] : []);
      const box = el('div', 'r-multi', ...(f.options ?? []).map(([v, l]) => h('label', null, h('input', { type: 'checkbox', checked: cur.has(v), onChange: (e: Event) => {
        if ((e.target as HTMLInputElement).checked) cur.add(v); else cur.delete(v);
        w[f.key] = cur.size ? [...cur] : undefined;
      } }), l)));
      return el('div', 'r-fld', el('span', '', f.label), box, hint);
    }
    if (f.kind === 'num') {
      return input('r-fld', f.label, h('input', { type: 'number', min: f.min !== undefined ? f.min / (f.mul ?? 1) : undefined, max: f.max !== undefined ? f.max / (f.mul ?? 1) : undefined, step: 'any', value: shown(f, w[f.key]), onInput: (e: Event) => { w[f.key] = stored(f, (e.target as HTMLInputElement).value); } }));
    }
    return el('div', 'r-fld', el('span', '', f.label), h('input', { type: 'text', value: typeof w[f.key] === 'string' ? w[f.key] as string : '', placeholder: f.placeholder, maxLength: 80, onInput: (e: Event) => { w[f.key] = (e.target as HTMLInputElement).value || undefined; } }), hint);
  }

  /** One parameter of a step: a list when the studio knows the names (outfits, emotes, rooms), else the deck's own control. */
  function paramControl(def: DeckParam, step: RuleStep, action: string): HTMLElement {
    const params = (step.params ??= {});
    const env = rulesRuntime.env;
    const set = (v: string | number | undefined) => { if (v === undefined || v === '') delete params[def.key]; else params[def.key] = v; };
    const cur = params[def.key] ?? '';
    const pick = (opts: { value: string; label: string }[], blank: string) => {
      const list = opts.some((o) => o.value === String(cur)) || cur === '' ? opts : [{ value: String(cur), label: String(cur) }, ...opts];
      return input('r-fld', def.label, h('select', { onChange: (e: Event) => set((e.target as HTMLSelectElement).value) }, h('option', { value: '', selected: cur === '' }, blank), ...list.map((o) => h('option', { value: o.value, selected: o.value === String(cur) }, o.label))));
    };
    if (def.type === 'select') return input('r-fld', def.label, h('select', { onChange: (e: Event) => set((e.target as HTMLSelectElement).value) }, ...(def.options ?? []).map((o) => h('option', { value: o.value, selected: o.value === String(cur || def.default || '') }, o.label))));
    if (def.type === 'room') return pick((env?.rooms() ?? []).map((r) => ({ value: r.id, label: r.name })), 'No room (Classic)');
    if (def.type === 'number') return input('r-fld', def.label, h('input', { type: 'number', min: def.min, max: def.max, step: 'any', value: String(cur === '' ? def.default ?? '' : cur), onInput: (e: Event) => { const v = (e.target as HTMLInputElement).value; set(v === '' ? undefined : Number(v)); } }));
    if (env && action === 'costume' && def.key === 'id') return pick(env.outfits().map((o) => ({ value: o.id, label: o.name })), 'My default outfit');
    if (env && action === 'accessory' && def.key === 'id') return pick(env.accessories().map((o) => ({ value: o.id, label: o.name })), 'Choose one');
    if (env && action === 'emote' && def.key === 'name') return pick(env.emotes().map((n) => ({ value: n.id, label: n.name })), 'Choose one');
    return input('r-fld', def.label, h('input', { type: 'text', value: String(cur), maxLength: 200, onInput: (e: Event) => set((e.target as HTMLInputElement).value) }));
  }

  function stepRow(s: RuleStep, i: number, d: StreamRule): HTMLElement {
    const opt = byId().get(s.action);
    const groups = GROUP_ORDER.map((g) => [g, actions.filter((a) => a.group === g)] as const).filter(([, l]) => l.length);
    const sel = h('select', { 'aria-label': 'Do', onChange: (e: Event) => {
      const id = (e.target as HTMLSelectElement).value;
      const params: Record<string, string | number> = defaultParams(byId().get(id));
      if (id === 'emote') params.name = rulesRuntime.env?.emotes()[0]?.id ?? 'idle_rail_call';   // (the deck's own default "wave" is not a clip in the library)
      d.then[i] = { action: id, params, ...(s.delayMs ? { delayMs: s.delayMs } : {}) };
      draw();
    } }, ...groups.map(([g, list]) => h('optgroup', { label: g }, ...list.map((a) => h('option', { value: a.id, selected: a.id === s.action }, a.label)))),
    byId().has(s.action) ? null : h('option', { value: s.action, selected: true }, s.action));
    const kids: (Node | null)[] = [input('r-fld', i === 0 ? 'Do' : 'Then', sel)];
    for (const p of opt?.params ?? []) kids.push(paramControl(p, s, s.action));
    if (opt?.sound) kids.push(el('span', 'r-hint', 'Plays a sound on your OBS page, only if sounds are on.'));
    if (i > 0) kids.push(input('r-fld', 'Wait first (seconds)', h('input', { type: 'number', min: 0, max: 60, step: 'any', value: s.delayMs ? String(s.delayMs / 1000) : '', onInput: (e: Event) => { const v = Number((e.target as HTMLInputElement).value); if (v > 0) s.delayMs = Math.round(Math.min(60, v) * 1000); else delete s.delayMs; } })));
    if (i > 0) kids.push(h('button', { class: 'r-btn s', title: 'Do this earlier', onClick: () => { [d.then[i - 1], d.then[i]] = [d.then[i], d.then[i - 1]]; draw(); } }, 'Up'));
    if (d.then.length > 1) kids.push(h('button', { class: 'r-btn s danger', onClick: () => { d.then.splice(i, 1); draw(); } }, 'Remove'));
    return el('div', 'r-row', ...kids);
  }

  /** Check the draft and turn it into a rule the engine accepts, or say in plain words what is missing. */
  function build(d: StreamRule): { rule?: StreamRule; error?: string } {
    const when = d.when.map((w) => sanitizeWhen(w)).filter((w): w is RuleWhen => !!w);
    if (!when.length) return { error: 'Say what should start it: pick something under “When” and fill in its box (for example the reward name).' };
    const then = d.then.map((s) => sanitizeStep(s)).filter((s): s is RuleStep => !!s);
    if (!then.length) return { error: 'Choose at least one thing for your avatar to do.' };
    const rule = sanitizeRule({ ...d, when, then, name: d.name.trim() || 'My rule' }, d.id);
    return rule ? { rule } : { error: 'Something in this rule is not valid. Check the boxes.' };
  }

  function editorView() {
    const e = editing!, d = e.draft;
    const canRevert = d.then.some((s) => byId().get(s.action)?.undoable);
    const whens = el('div', 'r-sec', el('h4', '', 'When this happens'));
    d.when.forEach((w, i) => { if (i) whens.append(el('div', 'r-or', 'or')); whens.append(whenRow(w as RuleWhen & Record<string, unknown>, i, d)); });
    if (d.when.length < MAX_WHEN) whens.append(h('button', { class: 'r-btn s', style: 'align-self:flex-start', onClick: () => { d.when.push(WHEN_FORMS[0].make()); draw(); } }, '+ Or when something else happens'));
    const dos = el('div', 'r-sec', el('h4', '', 'Your avatar does this'));
    d.then.forEach((s, i) => dos.append(stepRow(s, i, d)));
    if (d.then.length < MAX_RULE_CHAIN) dos.append(h('button', { class: 'r-btn s', style: 'align-self:flex-start', onClick: () => { d.then.push({ action: 'emote', params: { name: rulesRuntime.env?.emotes()[0]?.id ?? 'idle_rail_call' } }); draw(); } }, '+ Then do something else'));
    dos.append(el('div', 'r-hint', 'In text boxes you can use {user}, {title}, {amount}, {count}, {text} and {viewers}.'));
    const back = el('div', 'r-sec', el('h4', '', 'Then go back'),
      canRevert
        ? input('r-fld', 'Put it back after (seconds, 0 = leave it)', h('input', { type: 'number', min: 0, max: 3600, step: 'any', value: String(d.revertSecs), onInput: (ev: Event) => { d.revertSecs = Math.max(0, Math.min(3600, Number((ev.target as HTMLInputElement).value) || 0)); } }))
        : el('div', 'r-hint', 'Emotes, throws, sounds and effects finish by themselves. Pick an outfit, accessory, light, camera, sticker or item scene above to have it put back after a while.'),
      canRevert ? el('div', 'r-hint', 'It still goes back if you reload the studio meanwhile.') : null);
    const more = h('details', { class: 'r-sec' }, h('summary', null, 'More options'),
      input('r-fld', 'Do not repeat more than once every (seconds)', h('input', { type: 'number', min: 0, max: 3600, step: 'any', value: String(d.cooldownSecs), onInput: (ev: Event) => { d.cooldownSecs = Math.max(0, Math.min(3600, Number((ev.target as HTMLInputElement).value) || 0)); } })),
      h('label', { class: 'r-fld chk' }, h('input', { type: 'checkbox', checked: !!d.queue && d.queue.max > 0, onChange: (ev: Event) => { d.queue = (ev.target as HTMLInputElement).checked ? { max: 10, gapMs: 2500 } : undefined; draw(); } }),
        el('span', '', 'If many arrive at once (a gift bomb), line them up instead of dropping them')),
      d.queue ? el('div', 'r-row',
        input('r-fld', 'Line up at most', h('input', { type: 'number', min: 1, max: 50, value: String(d.queue.max), onInput: (ev: Event) => { d.queue!.max = Math.max(1, Math.min(50, Math.round(Number((ev.target as HTMLInputElement).value) || 1))); } })),
        input('r-fld', 'Seconds between runs', h('input', { type: 'number', min: 0, max: 60, step: 'any', value: String(d.queue.gapMs / 1000), onInput: (ev: Event) => { d.queue!.gapMs = Math.round(Math.max(0, Math.min(60, Number((ev.target as HTMLInputElement).value) || 0)) * 1000); } }))) : null);
    const finish = (tryAfter: boolean) => {
      const b = build(d);
      if (!b.rule) { e.error = b.error ?? 'Check the boxes.'; draw(); return; }
      const r = { ...b.rule, enabled: d.enabled };
      const exists = store.rules.some((x) => x.id === r.id);
      void save(exists ? store.rules.map((x) => (x.id === r.id ? r : x)) : [...store.rules, r]).then(() => {
        if (tryAfter) { tryIt(r); return; }
        editing = null; draw();
      });
      if (tryAfter) { e.isNew = false; }
    };
    root.replaceChildren(
      el('div', 'r-bar', h('button', { class: 'r-btn', onClick: () => { editing = null; draw(); } }, 'Back to my rules'), el('h3', '', e.isNew ? 'New rule' : 'Edit rule')),
      el('div', 'r-ed',
        input('r-fld', 'Name', h('input', { type: 'text', value: d.name, maxLength: 60, onInput: (ev: Event) => { d.name = (ev.target as HTMLInputElement).value; } })),
        whens, dos, back, more,
        e.error ? el('div', 'r-note err', e.error) : null,
        el('div', 'r-bar', h('button', { class: 'r-btn pri', onClick: () => finish(false) }, 'Save'), h('button', { class: 'r-btn', title: 'Save, then run it once on your avatar. Nothing is posted anywhere.', onClick: () => finish(true) }, 'Save and try it'),
          h('button', { class: 'r-btn', onClick: () => { editing = null; draw(); } }, 'Cancel')),
        el('div', 'r-hint', 'A new rule starts switched off. Turn it on from the list when it does what you want.')));
  }

  function draw() {
    stopLearn?.();   // every screen change (Save, Cancel, Back, a list refresh) ends a Learn that was waiting
    if (dead) return;
    if (editing) editorView(); else listView();
  }

  const offStore = store.onChange(() => { if (!editing) draw(); });
  let drawnPending = rulesRuntime.engine?.pending().length ?? 0;
  const offEng = rulesRuntime.engine?.onChange(() => { const n = rulesRuntime.engine!.pending().length; if (n !== drawnPending && !editing) { drawnPending = n; draw(); } else paintChips(); });
  // the "goes back in 12 s" chips tick once a second, only while something is waiting to be put back
  const paintChips = () => {
    if (editing) return;
    for (const r of store.rules) { const c = root.querySelector(`[data-chip="${r.id}"]`); if (c) { const chip = statusChip(r); c.replaceChildren(...(chip ? [chip] : [])); } }
  };
  const tick = window.setInterval(() => { const e = rulesRuntime.engine; if (e && e.pending().length) paintChips(); }, 1000);
  if (!store.loaded) void store.load();
  draw();
  return { destroy() { dead = true; stopLearn?.(); offStore(); offEng?.(); clearInterval(tick); root.remove(); } };
}

