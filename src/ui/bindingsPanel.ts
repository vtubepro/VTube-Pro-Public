// Live > Stream extras > "Keys & pads" (beta.16, docs/b16/BINDINGS.md). One screen, plain words: "Add a shortcut", press the key /
// tap the pad / push the button / make the sign, pick what should happen. Learn is one button for all four kinds of input.
// Simple first: the list shows one line per shortcut (what starts it -> what it does) with an on/off switch; the details
// (the action's options, "only while I hold it", knobs, hold time) open under "Change". Nothing here runs a timer of its own;
// it redraws when the runtime says something changed.
import { ACTION_BY_ID, DECK_ACTIONS, type DeckParam } from '../../shared/deck.ts';
import { listRuleActions } from '../../shared/streamRules.ts';
import type { B16PanelHandle } from '../b16/panels.ts';
import {
  PICKABLE_SIGNS, QUICK_STARTS, SIGN_LABEL, canHold, describeBinding, describeDo, describeWhen, duplicateOf, keyAdvice, type Binding, type BindingWhen, type ParamValue,
} from '../input/bindings.ts';
import type { BindingsRuntime } from '../input/runtime.ts';
import { button, h, toast } from './dom.ts';

const CSS = `
.kp { display:flex; flex-direction:column; gap:10px; }
.kp p { margin:0; }
.kp .kp-dim { color:var(--dim); font-size:12px; line-height:1.45; }
.kp .kp-chips { display:flex; flex-wrap:wrap; gap:6px; }
.kp .kp-chip { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; padding:3px 9px; border-radius:99px; border:1px solid var(--line); background:var(--card); color:var(--dim); }
.kp .kp-chip i { width:8px; height:8px; border-radius:50%; background:var(--faint); flex:none; }
.kp .kp-chip.ok i { background:var(--ok); } .kp .kp-chip.warn i { background:var(--warn); }
.kp .kp-chip button { all:unset; cursor:pointer; color:var(--accent); font-weight:650; }
.kp .kp-add { padding:10px 14px; font-weight:700; }
.kp .kp-learn { border:1px dashed var(--accent); border-radius:12px; padding:12px; background:var(--card); }
.kp .kp-learn b { display:block; margin-bottom:4px; }
.kp .kp-learn .kp-pulse { display:inline-block; width:9px; height:9px; border-radius:50%; background:var(--accent); margin-right:6px; animation:kp-pulse 1s ease-in-out infinite; }
@keyframes kp-pulse { 50% { opacity:.25; } }
@media (prefers-reduced-motion: reduce) { .kp .kp-learn .kp-pulse { animation:none; } }
.kp .kp-card { border:1px solid var(--line); border-radius:12px; background:var(--card); padding:9px 11px; display:flex; flex-direction:column; gap:7px; }
.kp .kp-card.off { opacity:.62; }
.kp .kp-card.flash { border-color:var(--ok); }
.kp .kp-head { display:flex; align-items:center; gap:9px; }
.kp .kp-head .kp-main { flex:1; min-width:0; }
.kp .kp-when { font-weight:700; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.kp .kp-do { color:var(--dim); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.kp .kp-warn { color:var(--warn); font-size:11.5px; line-height:1.4; }
.kp .kp-err { color:var(--err); font-size:11.5px; line-height:1.4; }
.kp .kp-body { display:flex; flex-direction:column; gap:7px; padding-top:4px; border-top:1px solid var(--line); }
.kp .kp-body label { display:flex; align-items:center; gap:8px; font-size:12px; }
.kp .kp-body label > span { min-width:92px; color:var(--dim); }
.kp .kp-body input[type=text], .kp .kp-body input[type=number], .kp .kp-body select { flex:1; min-width:0; }
.kp .kp-acts { display:flex; flex-wrap:wrap; gap:6px; }
.kp .kp-quick { display:flex; flex-direction:column; gap:6px; }
.kp .kp-quick button { text-align:left; }
.kp .kp-quick small { display:block; color:var(--dim); font-weight:400; }
.kp details > summary { cursor:pointer; font-size:12px; color:var(--dim); }
`;
let cssDone = false;

const POPULAR = ['expression', 'emote', 'cover', 'lighting', 'recalibrate', 'slap', 'costume', 'camera', 'chat-hide', 'mode'];
interface ActionDef { id: string; label: string; group: string; params: DeckParam[] }
function actionDefs(): ActionDef[] {
  const out: ActionDef[] = [];
  for (const a of DECK_ACTIONS) if (!a.local) out.push({ id: a.id, label: a.label, group: a.group, params: a.params ?? [] });
  const have = new Set(out.map((a) => a.id));
  for (const r of listRuleActions()) if (!have.has(r.id)) out.push({ id: r.id, label: r.meta.label, group: r.meta.group ?? 'Stream extras', params: r.meta.params ?? [] });
  return out;
}
const defaultParams = (def: ActionDef): Record<string, ParamValue> => {
  const p: Record<string, ParamValue> = {};
  for (const x of def.params) if (x.default !== undefined) p[x.key] = x.default;
  return p;
};

export function mountBindingsPanel(host: HTMLElement, rt: BindingsRuntime): B16PanelHandle {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const root = h('div', { class: 'kp' });
  host.append(root);
  const open = new Set<string>();
  let learnBox: HTMLElement | null = null;
  let lastSig = '';

  // ---------------------------------------------------------------- the "Add a shortcut" flow

  const addBinding = (when: BindingWhen, knob: boolean) => {
    let doIt: Binding['do'] = { action: 'expression', params: { name: 'happy', seconds: 2.5 } };
    let knobMap: Binding['knob'];
    if (when.kind === 'hand' && when.sign === 'wave') doIt = { action: 'emote', params: { name: 'wave' } };
    if (when.kind === 'pad' && when.cc !== undefined && knob) { doIt = { action: 'hour', params: { hour: 12 } }; knobMap = { param: 'hour', min: 6, max: 20 }; }
    const made = rt.add({ name: '', on: true, when, do: doIt, ...(knobMap ? { knob: knobMap } : {}) });
    if (!made) { toast('That is the most shortcuts you can have (40). Remove one first.', 'warn'); return; }
    open.clear(); open.add(made.id);
    draw(true);
    toast(`Added ${describeWhen(made.when)}. Now pick what it does.`, 'ok');
  };

  const startLearn = () => {
    const l = rt.learn();
    void l.done.then((r) => { if (r) addBinding(r.when, r.knob); draw(true); });
    draw(true);
  };

  const learnCard = (): HTMLElement => h('div', { class: 'kp-learn', role: 'status' },
    h('b', null, h('span', { class: 'kp-pulse' }), 'Waiting for you…'),
    h('p', { class: 'kp-dim' }, 'Press a key, tap a MIDI pad or turn a knob, push a controller button, or make a hand sign. For a key that works inside your game, hold Ctrl and Alt while you press it. Esc cancels.'),
    h('div', { class: 'kp-acts', style: 'margin-top:8px' }, button('Cancel', () => rt.cancelLearn())));

  // ---------------------------------------------------------------- one shortcut

  const paramEditor = (b: Binding, p: DeckParam, onChange: () => void): HTMLElement => {
    const cur = b.do.params?.[p.key];
    const set = (v: ParamValue) => { rt.update(b.id, { do: { action: b.do.action, params: { ...(b.do.params ?? {}), [p.key]: v } } }); onChange(); };
    if (p.type === 'select') {
      const sel = h('select', { onChange: (e: Event) => set((e.target as HTMLSelectElement).value) }, ...(p.options ?? []).map((o) => h('option', { value: o.value, selected: String(cur ?? p.default ?? '') === o.value }, o.label)));
      return h('label', null, h('span', null, p.label), sel);
    }
    if (p.type === 'number') {
      const inp = h('input', { type: 'number', value: String(cur ?? p.default ?? ''), min: p.min !== undefined ? String(p.min) : undefined, max: p.max !== undefined ? String(p.max) : undefined, step: 'any', onChange: (e: Event) => { const n = Number((e.target as HTMLInputElement).value); if (Number.isFinite(n)) set(n); } });
      return h('label', null, h('span', null, p.label), inp);
    }
    return h('label', null, h('span', null, p.label), h('input', { type: 'text', value: String(cur ?? p.default ?? ''), maxlength: 120, onChange: (e: Event) => set((e.target as HTMLInputElement).value) }));
  };

  const warningsFor = (b: Binding): { err: string[]; warn: string[] } => {
    const err: string[] = [], warn: string[] = [], st = rt.status();
    const w = b.when;
    if (w.kind === 'key') {
      const global = !['in-page', 'offline'].includes(rt.helper.state);
      const a = keyAdvice(w.combo, { global, modelKeys: rt.modelKeys().map((k) => k) });
      if (a.block) err.push(a.block);
      if (a.warn) warn.push(a.warn);
      const r = rt.helper.results[b.id];
      if (b.on && r && !r.ok && r.why && r.why !== a.block) warn.push(r.why);
      if (b.on && (rt.helper.state === 'in-page' || rt.helper.state === 'offline') && rt.helper.note) warn.push(rt.helper.note);
    }
    if (w.kind === 'pad' && st.midi.state !== 'on') warn.push(st.midi.state === 'unsupported' ? st.midi.error : 'Click “Find my MIDI pad” above so the browser lets VTube Pro read it.');
    if (w.kind === 'gamepad' && !st.controllers.length) warn.push('No controller is plugged in right now. Press a button on it once so the browser sees it.');
    if (w.kind === 'hand' && !st.hands.seen) warn.push('Your camera doesn’t see your hands right now. Turn on tracking and show your hand.');
    const dup = duplicateOf(rt.list, b);
    if (b.on && dup) warn.push(`“${describeBinding(dup)}” uses the same trigger. Both will run.`);
    if (!ACTION_BY_ID.has(b.do.action) && !actionDefs().some((a) => a.id === b.do.action)) err.push('This action isn’t in this version of VTube Pro.');
    return { err, warn };
  };

  const card = (b: Binding): HTMLElement => {
    const isOpen = open.has(b.id);
    const defs = actionDefs();
    const def = defs.find((a) => a.id === b.do.action);
    const { err, warn } = warningsFor(b);
    const sw = h('input', { type: 'checkbox', checked: b.on, title: 'On / off', 'aria-label': 'On or off', onChange: (e: Event) => rt.update(b.id, { on: (e.target as HTMLInputElement).checked }) });
    const head = h('div', { class: 'kp-head' }, sw,
      h('div', { class: 'kp-main' }, h('div', { class: 'kp-when' }, describeWhen(b.when)), h('div', { class: 'kp-do' }, '→ ', describeDo(b.do), b.hold ? ' (only while held)' : '')),
      button(isOpen ? 'Done' : 'Change', () => { if (isOpen) open.delete(b.id); else open.add(b.id); draw(true); }),
    );
    const el = h('div', { class: `kp-card${b.on ? '' : ' off'}`, 'data-id': b.id }, head,
      ...err.map((t) => h('div', { class: 'kp-err', role: 'alert' }, t)), ...warn.map((t) => h('div', { class: 'kp-warn' }, t)));
    if (!isOpen) return el;

    // ---- details
    const body = h('div', { class: 'kp-body' });
    const groups = new Map<string, ActionDef[]>();
    const popular = POPULAR.map((id) => defs.find((x) => x.id === id)).filter((x): x is ActionDef => !!x);
    groups.set('Popular', popular);
    for (const x of defs) { if (popular.includes(x)) continue; const g = groups.get(x.group) ?? []; g.push(x); groups.set(x.group, g); }
    const sel = h('select', { onChange: (e: Event) => {
      const id = (e.target as HTMLSelectElement).value, nd = defs.find((x) => x.id === id);
      rt.update(b.id, { do: { action: id, params: nd ? defaultParams(nd) : {} }, hold: undefined, knob: undefined });
      draw(true);
    } }, ...[...groups].map(([g, list]) => h('optgroup', { label: g }, ...list.map((x) => h('option', { value: x.id, selected: x.id === b.do.action }, x.label)))));
    body.append(h('label', null, h('span', null, 'What happens'), sel));
    for (const p of def?.params ?? []) { if (b.hold && b.do.action === 'expression' && p.key === 'seconds') continue; body.append(paramEditor(b, p, () => draw(true))); }   // (held: it lasts as long as you hold)

    const holdable = b.when.kind !== 'pad' || b.when.cc === undefined || !b.knob;
    if (holdable && canHold(b.do.action, rt.ruleActionUndoable(b.do.action))) {
      const what = b.when.kind === 'hand' ? 'Only while I make the sign' : 'Only while I hold it';
      body.append(h('label', { title: 'Your avatar goes back to normal when you let go.' }, h('span', null, ''), h('input', { type: 'checkbox', checked: !!b.hold, onChange: (e: Event) => rt.update(b.id, { hold: (e.target as HTMLInputElement).checked || undefined }) }), what));
    }
    if (b.when.kind === 'pad' && b.when.cc !== undefined) {
      const nums = (def?.params ?? []).filter((p) => p.type === 'number');
      body.append(h('label', { title: 'A knob or slider sends many values. They set one number of the action.' }, h('span', null, ''), h('input', { type: 'checkbox', checked: !!b.knob, disabled: !nums.length, onChange: (e: Event) => {
        const on = (e.target as HTMLInputElement).checked, p = nums[0];
        rt.update(b.id, { knob: on && p ? { param: p.key, min: p.min ?? 0, max: p.max ?? 1 } : undefined, hold: undefined }); draw(true);
      } }), nums.length ? 'This is a knob or slider (it sets a number)' : 'Pick an action with a number to use this as a knob'));
      if (b.knob) {
        const k = b.knob, nums2 = nums;
        const upd = (patch: Partial<typeof k>) => { rt.update(b.id, { knob: { ...k, ...patch } }); };
        body.append(
          h('label', null, h('span', null, 'Knob sets'), h('select', { onChange: (e: Event) => { const p = nums2.find((x) => x.key === (e.target as HTMLSelectElement).value); upd({ param: (e.target as HTMLSelectElement).value, min: p?.min ?? 0, max: p?.max ?? 1 }); draw(true); } },
            ...nums2.map((p) => h('option', { value: p.key, selected: p.key === k.param }, p.label)))),
          h('label', null, h('span', null, 'Lowest'), h('input', { type: 'number', value: String(k.min), step: 'any', onChange: (e: Event) => upd({ min: Number((e.target as HTMLInputElement).value) || 0 }) })),
          h('label', null, h('span', null, 'Highest'), h('input', { type: 'number', value: String(k.max), step: 'any', onChange: (e: Event) => upd({ max: Number((e.target as HTMLInputElement).value) || 0 }) })),
        );
      }
    }
    body.append(h('label', null, h('span', null, 'Name (optional)'), h('input', { type: 'text', value: b.name, maxlength: 60, placeholder: describeDo(b.do), onChange: (e: Event) => rt.update(b.id, { name: (e.target as HTMLInputElement).value }) })));
    body.append(h('div', { class: 'kp-acts' },
      button('Try it', () => { void rt.test(b).then((r) => toast(r.ok ? `Tried: ${describeDo(b.do)}` : (r.error ?? 'That did not work.'), r.ok ? 'ok' : 'warn')); }),
      button('Teach it a different trigger', () => {
        const l = rt.learn();
        void l.done.then((r) => { if (r) rt.update(b.id, { when: r.when, knob: r.knob ? b.knob : undefined, hold: r.knob ? undefined : b.hold }); draw(true); });
        draw(true);
      }),
      button('Delete', () => { rt.remove(b.id); open.delete(b.id); draw(true); }, 'danger'),
    ));
    el.append(body);
    return el;
  };

  // ---------------------------------------------------------------- the whole screen

  const chips = (): HTMLElement => {
    const st = rt.status(), box = h('div', { class: 'kp-chips' });
    const chip = (ok: boolean, text: string, act?: HTMLElement) => box.append(h('span', { class: `kp-chip ${ok ? 'ok' : 'warn'}` }, h('i'), text, act));
    const hs = rt.helper.state;
    chip(hs === 'ok' || hs === 'none', hs === 'ok' ? 'Keys work inside games' : hs === 'in-page' ? 'Keys work while this tab is in front' : hs === 'offline' ? 'VTube Pro not connected: keys work in this tab' : 'Keys work inside games (Windows)',
      hs === 'in-page' || hs === 'offline' ? h('button', { onClick: () => void rt.syncHelper() }, 'Check again') : undefined);
    chip(st.midi.state === 'on', st.midi.state === 'on' ? (st.midi.ports.length ? `MIDI: ${st.midi.ports[0]}${st.midi.ports.length > 1 ? ` +${st.midi.ports.length - 1}` : ''}` : 'MIDI is on, no pad found') : 'MIDI pads',
      st.midi.state === 'on' ? undefined : h('button', { onClick: () => void rt.allowMidi().then((ok) => { if (!ok) toast(rt.midi.error || 'MIDI did not start.', 'warn'); }) }, 'Find my MIDI pad'));
    chip(st.controllers.length > 0, st.controllers.length ? `Controller: ${st.controllers[0]}` : 'No controller found (press a button on it)');
    chip(st.hands.seen, st.hands.seen ? 'Hand signs: I can see your hands' : st.hands.listening ? 'Hand signs: show me your hand' : 'Hand signs wake up when you add one');
    return box;
  };

  const settings = (): HTMLElement => {
    const s = rt.settings;
    const hold = h('input', { type: 'range', min: '0', max: '2000', step: '50', value: String(s.handHoldMs), onChange: (e: Event) => rt.saveSettings({ handHoldMs: Number((e.target as HTMLInputElement).value) }) });
    const out = h('span', null, `${(s.handHoldMs / 1000).toFixed(2)} s`);
    hold.addEventListener('input', () => { out.textContent = `${(Number(hold.value) / 1000).toFixed(2)} s`; });
    return h('details', null, h('summary', null, 'Settings'),
      h('div', { class: 'kp-body', style: 'border:0' },
        h('label', { title: 'A hand sign counts after you hold it this long, so a hand passing by does nothing.' }, h('span', null, 'Hand sign hold time'), hold, out),
        h('p', { class: 'kp-dim' }, 'Your shortcuts are saved in this browser. Hand signs and controller buttons are only heard while this VTube Pro tab is open and visible.')));
  };

  const draw = (force = false) => {
    const st = rt.status();
    const sig = JSON.stringify([rt.list, rt.settings, rt.isLearning, st.helper, st.midi, st.controllers, st.hands, [...open]]);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    const scroll = host.scrollTop;
    root.replaceChildren();
    root.append(h('p', { class: 'kp-dim' }, 'Press a key in your game, tap a pad, push a controller button or make a peace sign, and your avatar reacts. No Stream Deck needed. Every shortcut also works as a trigger in Redeems & Reactions.'));
    root.append(chips());
    if (rt.isLearning) { learnBox = learnCard(); root.append(learnBox); }
    else {
      root.append(h('div', { class: 'kp-acts' },
        button('+ Add a shortcut', startLearn, 'primary kp-add'),
        h('select', { 'aria-label': 'Add a hand sign without the camera', onChange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) addBinding({ kind: 'hand', sign: v, side: 'any' }, false); (e.target as HTMLSelectElement).value = ''; } },
          h('option', { value: '' }, 'or pick a hand sign…'), ...PICKABLE_SIGNS.map((s) => h('option', { value: s }, SIGN_LABEL[s] ?? s)))));
    }
    if (!rt.list.length) {
      root.append(h('p', { class: 'kp-dim' }, 'Nothing yet. Try one of these (you can change everything after):'),
        h('div', { class: 'kp-quick' }, ...QUICK_STARTS.map((q) => button('', () => { const made = rt.add(q.make()); if (made) { open.clear(); open.add(made.id); draw(true); toast('Added. It is on.', 'ok'); } }, '')).map((btn, i) => {
          btn.append(QUICK_STARTS[i].title, h('small', null, QUICK_STARTS[i].blurb)); return btn;
        })));
    } else {
      for (const b of rt.list) root.append(card(b));
    }
    root.append(settings());
    host.scrollTop = scroll;
  };

  // a firing shows on the card without redrawing the screen (a half-typed name must survive)
  const unpeek = rt.peek();                                      // (while this screen is open a controller shows up here before any shortcut uses it)
  const off = rt.on(() => {
    const f = rt.lastFired;
    if (f && Date.now() - f.at < 400) {
      const el = root.querySelector(`.kp-card[data-id="${f.binding.id}"]`);
      if (el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 350); }
    }
    const active = document.activeElement as HTMLInputElement | null;
    if (active && root.contains(active) && active.tagName === 'INPUT' && /^(text|number|range)$/.test(active.type) && !rt.isLearning) return;   // never redraw under the user's typing
    draw();
  });
  draw(true);
  const tick = window.setInterval(() => draw(), 1500);        // (only while this screen is open: "I can see your hands" comes and goes)
  return { destroy() { off(); unpeek(); clearInterval(tick); rt.cancelLearn(); root.remove(); } };
}
