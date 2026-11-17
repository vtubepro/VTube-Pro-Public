// Scene tab → Full screen → the HUD layouts (shared/hud.ts, docs/LAYOUTS.md): pick a layout (built-ins + your own),
// place the performers (corner, size, bust / full body), and edit the layout's HUD elements — chat as text, alerts,
// goal bar, text, logo, webcam frame: turn on / off, corner, size, opacity and each type's own options (generated from
// the type table, so a new type gets its controls for free). Layouts copy / paste as JSON (made by hand or by an AI),
// checked by validateHudLayout before they are saved. Every change is one write of the `hud` mode bag.
import type { App } from '../../../app.ts';
import type { SceneController } from '../../../scene/controller.ts';
import {
  ANCHOR_LABEL, HUD_ANCHORS, HUD_BAG, HUD_BAG_LIMIT, HUD_MODE, HUD_TYPES, MAX_ELEMENTS, MAX_LAYOUTS, elementRect, hudBagBytes, hudLayout, hudLayouts, isBuiltinHud, lookFor, newElement,
  offsetsFor, planHud, sanitizeHudBag, sanitizeLayoutDef, validateHudLayout, withLayout, type HudAnchor, type HudBag, type HudElement, type HudLayoutDef, type HudPropSpec,
} from '../../../../shared/hud.ts';
import { slotKey } from '../../../../shared/stageLayout.ts';
import { button, h, slider, toast, toggle } from '../../dom.ts';
import { registerModePanel } from '../panelCore.ts';
import { canvasAspect, card, presentKeys, steps, thumb } from '../common.ts';

type BagApi = { modeBag(id: string): unknown; setModeBag(id: string, v: unknown): void };

const CSS = `
.fs-els { display:flex; flex-direction:column; gap:6px; margin:6px 0; }
.fs-el { border:1px solid var(--line); border-radius:9px; background:var(--card); }
.fs-el > summary { display:flex; align-items:center; gap:8px; padding:6px 9px; cursor:pointer; list-style:none; font-size:12.5px; }
.fs-el > summary::-webkit-details-marker { display:none; }
.fs-el > summary .ic { font-size:15px; }
.fs-el > summary b { flex:1; }
.fs-el > summary .off { color:var(--faint); font-weight:400; }
.fs-el .bd { padding:2px 10px 8px; }
.fs-el .bd input[type=text] { width:100%; box-sizing:border-box; }
.fs-el input[type=color] { width:44px; height:24px; padding:0; border:1px solid var(--line2); border-radius:6px; background:none; }
.fs-add { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin:6px 0; }
.fs-json textarea { width:100%; min-height:120px; box-sizing:border-box; font:12px ui-monospace, Consolas, monospace; }
.fs-issues { margin:4px 0; padding-left:18px; font-size:12px; }
.fs-issues .error { color:var(--bad,#ff6b6b); } .fs-issues .warn { color:var(--warn,#e0a030); }
`;
let cssDone = false;
let openEl: string | null = null;
let jsonOpen = false;
let jsonText = '';
let issues: { level: string; where: string; msg: string }[] = [];
let timer = 0;
let moreOpen = false;

function build(app: App, S: SceneController): HTMLElement {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const B = S as unknown as BagApi;
  const edit = S.canEdit;
  const bag = (): HudBag => sanitizeHudBag(B.modeBag(HUD_BAG));
  const b = bag();
  const all = hudLayouts(b);
  const cur = hudLayout(b);
  const aspect = canvasAspect();
  const keys = presentKeys(S);
  // (local UI state — the JSON box — redraws this panel in place)
  const rerender = () => { if (root.isConnected) root.replaceWith(build(app, S)); };
  const save = (nb: HudBag, now = true) => {
    if (!edit) { toast('The host runs the layout', 'warn'); return; }
    if (hudBagBytes(nb) > HUD_BAG_LIMIT) { toast('That is more than a layout can hold (6 KB): remove an element or a custom layout', 'warn', 5000); return; }
    clearTimeout(timer);
    if (now) B.setModeBag(HUD_BAG, nb);
    else timer = window.setTimeout(() => B.setModeBag(HUD_BAG, nb), 220);
  };
  /** Change the current layout (an edited built-in is stored as a copy with the same id). */
  const change = (fn: (d: HudLayoutDef) => void, now = true) => {
    const d = structuredClone(hudLayout(bag())) as HudLayoutDef;
    fn(d);
    save(withLayout(bag(), d), now);
  };
  const changeEl = (id: string, fn: (e: HudElement) => void, now = true) => change((d) => { const e = d.hud.find((x) => x.id === id); if (e) fn(e); }, now);

  // ---- layout cards
  const pic = (d: HudLayoutDef) => thumb(planHud(d, { aspect, keys: keys.length ? keys : ['@host'], content: S.stage.content, look: lookFor(b, slotKey(HUD_MODE, d.label), d.look) }), aspect);
  const cards = h('div', { class: 'stg-cards' }, ...all.map((d) => card(d.label, d.sub ?? (isBuiltinHud(d.id) ? 'built-in' : 'your layout'), pic(d), d.id === cur.id, false, !edit, () => save({ ...bag(), pick: d.id }), d.sub ?? d.label)));

  // ---- cams
  const cams = cur.cams;
  const camCorner = (c: 'bl' | 'br' | 'tl' | 'tr') => h('button', { class: cams.anchor === c ? 'on' : '', disabled: !edit, title: ANCHOR_LABEL[c], onClick: () => change((d) => { d.cams.anchor = c; }) });
  const camBox = h('div', null,
    h('div', { class: 'stg-row' }, h('span', { class: 'lbl' }, 'You stand'), h('span', { class: 'stg-corner' }, camCorner('tl'), camCorner('tr'), camCorner('bl'), camCorner('br')),
      h('span', { class: 'lbl', style: 'min-width:auto;margin-left:10px' }, 'Framing'), steps(cams.framing, [['bust', 'Bust'], ['full', 'Full body']], (v) => change((d) => { d.cams.framing = v; }), !edit)),
    slider('Height', cams.h, 0.1, 1, 0.01, (v) => change((d) => { d.cams.h = v; }, false), 'How tall the performer’s cam is (share of the frame height)', (v) => `${Math.round(v * 100)}%`, { def: 0.46 }),
    slider('Edge gap', cams.x, 0, 0.2, 0.002, (v) => change((d) => { d.cams.x = v; }, false), 'Gap to the side edge', (v) => `${(v * 100).toFixed(1)}%`, { def: 0.012 }),
    slider('Bottom / top gap', cams.y, 0, 0.3, 0.002, (v) => change((d) => { d.cams.y = v; }, false), 'Gap to the bottom (or top) edge — 0 = standing on the frame edge', (v) => `${(v * 100).toFixed(1)}%`, { def: 0 }),
    h('div', { class: 'stg-row' }, h('span', { class: 'lbl' }, 'Capture'), steps(cur.capture, [['full', 'Fill the frame'], ['fit', 'Keep its shape']], (v) => change((d) => { d.capture = v; }), !edit)),
  );

  // ---- the chat box's place in this layout (when it shows and the streamer left its place on Auto)
  const cp = cur.chat;
  const chatBox = h('div', null,
    toggle('Chat box in this layout', !!cp, (v) => change((d) => { if (v) d.chat = { anchor: 'tl', x: 0.015, y: 0.04, w: 0.3, h: 0.44 }; else delete d.chat; }), 'Where the chat box sits in this layout while it shows (Chat & events → Chat box on stream: when it shows, a fixed place of your own, Panel / Text only)'),
    cp ? [
      h('div', { class: 'stg-row' }, h('span', { class: 'lbl' }, 'Chat corner'),
        h('select', { disabled: !edit, onChange: (ev: Event) => change((d) => { if (d.chat) { const a = (ev.target as HTMLSelectElement).value as HudAnchor; d.chat = { ...d.chat, anchor: a, x: a === 't' || a === 'b' || a === 'c' ? 0 : 0.015, y: a === 'l' || a === 'r' || a === 'c' ? 0 : 0.04 }; } }) },
          ...HUD_ANCHORS.map((a) => h('option', { value: a, selected: a === cp.anchor }, ANCHOR_LABEL[a])))),
      slider('Chat width', cp.w, 0.05, 1, 0.005, (v) => change((d) => { if (d.chat) d.chat.w = v; }, false), 'Share of the frame width', (v) => `${Math.round(v * 100)}%`, { def: 0.3 }),
      slider('Chat height', cp.h, 0.05, 1, 0.005, (v) => change((d) => { if (d.chat) d.chat.h = v; }, false), 'Share of the frame height', (v) => `${Math.round(v * 100)}%`, { def: 0.44 }),
    ] : null,
  );

  // ---- HUD elements
  const propControl = (e: HudElement, k: string, p: HudPropSpec): HTMLElement => {
    const v = e[k];
    switch (p.kind) {
      case 'num': return slider(p.label, Number(v), p.min, p.max, p.step ?? 0.01, (x) => changeEl(e.id, (el) => { el[k] = x; }, false), p.label, p.unit ? { unit: p.unit } : undefined, { def: p.def });
      case 'bool': return toggle(p.label, v === true, (x) => changeEl(e.id, (el) => { el[k] = x; }));
      case 'enum': return h('div', { class: 'stg-row' }, h('span', { class: 'lbl' }, p.label), steps(String(v), p.options.map((o, i) => [o, p.labels?.[i] ?? o] as [string, string]), (x) => changeEl(e.id, (el) => { el[k] = x; }), !edit));
      case 'color': return h('div', { class: 'stg-row' }, h('span', { class: 'lbl' }, p.label),
        h('input', { type: 'color', value: String(v) || '#ffffff', disabled: !edit, onInput: (ev: Event) => changeEl(e.id, (el) => { el[k] = (ev.target as HTMLInputElement).value; }, false) }),
        p.auto !== undefined ? h('button', { class: `btn tight ${v === '' ? 'on' : ''}`, disabled: !edit, title: `Use ${p.auto}`, onClick: () => changeEl(e.id, (el) => { el[k] = ''; }) }, 'Auto') : null);
      case 'text': return h('div', { class: 'stg-row' }, h('span', { class: 'lbl' }, p.label),
        h('input', { type: 'text', value: String(v), maxLength: p.max, disabled: !edit, onChange: (ev: Event) => changeEl(e.id, (el) => { el[k] = (ev.target as HTMLInputElement).value; }) }));
    }
  };
  const elBox = (e: HudElement) => {
    const t = HUD_TYPES[e.type];
    const d = h('details', { class: 'fs-el', open: openEl === e.id, onToggle: (ev: Event) => { if ((ev.target as HTMLDetailsElement).open) openEl = e.id; else if (openEl === e.id) openEl = null; } } as never,
      h('summary', null, h('span', { class: 'ic' }, t?.icon ?? '❔'), h('b', null, t?.label ?? e.type, h('span', { class: 'off' }, ` · ${e.id}${e.on ? '' : ' (off)'}`)),
        h('span', { class: 'switch', onClick: (ev: Event) => ev.stopPropagation() }, h('input', { type: 'checkbox', checked: e.on, disabled: !edit, onChange: (ev: Event) => changeEl(e.id, (el) => { el.on = (ev.target as HTMLInputElement).checked; }) }), h('i'))),
      h('div', { class: 'bd' },
        !t ? h('p', { class: 'note' }, `Unknown element type "${e.type}" — nothing is drawn for it.`) : null,
        h('div', { class: 'stg-row' }, h('span', { class: 'lbl' }, 'Corner'),
          h('select', { disabled: !edit, onChange: (ev: Event) => changeEl(e.id, (el) => {
            // keep it where it is on screen, measured from the new corner (then nudge into that corner's area)
            const a = (ev.target as HTMLSelectElement).value as HudAnchor;
            const r = elementRect(el);
            const o = offsetsFor(a, r);
            el.anchor = a; el.x = Math.max(0, Math.min(o.x, 0.04)); el.y = Math.max(0, Math.min(o.y, 0.05)); el.w = o.w; el.h = o.h;
            if (a === 't' || a === 'b' || a === 'c') el.x = 0;
            if (a === 'l' || a === 'r' || a === 'c') el.y = 0;
          }) }, ...HUD_ANCHORS.map((a) => h('option', { value: a, selected: a === e.anchor }, ANCHOR_LABEL[a])))),
        slider('Width', e.w, 0.02, 1, 0.005, (v) => changeEl(e.id, (el) => { el.w = v; }, false), 'Share of the frame width', (v) => `${Math.round(v * 100)}%`),
        slider('Height', e.h, 0.02, 1, 0.005, (v) => changeEl(e.id, (el) => { el.h = v; }, false), 'Share of the frame height', (v) => `${Math.round(v * 100)}%`),
        slider('Opacity', e.opacity, 0, 1, 0.01, (v) => changeEl(e.id, (el) => { el.opacity = v; }, false), 'The whole element', (v) => `${Math.round(v * 100)}%`, { def: 1 }),
        ...(t ? Object.entries(t.props).map(([k, p]) => propControl(e, k, p)) : []),
        h('div', { class: 'stg-row' }, button('Remove', () => { change((dd) => { dd.hud = dd.hud.filter((x) => x.id !== e.id); }); toast(`Removed ${e.id}`, 'ok', 1200); }, 'tight')),
      ));
    return d;
  };
  let addType = Object.keys(HUD_TYPES)[0];
  const addRow = h('div', { class: 'fs-add' },
    h('select', { disabled: !edit, onChange: (ev: Event) => { addType = (ev.target as HTMLSelectElement).value; } }, ...Object.entries(HUD_TYPES).map(([k, t]) => h('option', { value: k, title: t.hint }, `${t.icon} ${t.label}`))),
    button('Add element', () => {
      if (cur.hud.length >= MAX_ELEMENTS) { toast(`A layout holds up to ${MAX_ELEMENTS} elements`, 'warn'); return; }
      const el = newElement(addType, cur.hud.map((x) => x.id));
      if (!el) return;
      openEl = el.id;
      change((d) => { d.hud.push(el); });
    }, 'tight'));

  // ---- layouts: new / reset / JSON
  const custom = !isBuiltinHud(cur.id);
  const edited = isBuiltinHud(cur.id) && b.layouts.some((l) => l.id === cur.id);
  const dup = () => {
    const n = b.layouts.filter((l) => !isBuiltinHud(l.id)).length;
    if (n >= MAX_LAYOUTS) { toast(`Up to ${MAX_LAYOUTS} layouts of your own`, 'warn'); return; }
    let i = 1, id = 'my-layout';
    while (all.some((l) => l.id === id)) id = `my-layout-${++i}`;
    const d = { ...structuredClone(cur), id, label: `My layout${i > 1 ? ` ${i}` : ''}`, sub: 'your layout' } as HudLayoutDef;
    save({ ...withLayout(bag(), d), pick: id });
  };
  const jsonBox = jsonOpen ? h('div', { class: 'fs-json' },
    h('p', { class: 'note', style: 'margin:4px 0' }, 'A layout as JSON — copy it, edit it, or paste one made by hand or by an AI (docs/LAYOUTS.md). Import checks it first.'),
    h('textarea', { value: jsonText || JSON.stringify(cur, null, 1), spellcheck: false, onInput: (ev: Event) => { jsonText = (ev.target as HTMLTextAreaElement).value; } }),
    issues.length ? h('ul', { class: 'fs-issues' }, ...issues.map((i) => h('li', { class: i.level }, `${i.where}: ${i.msg}`))) : null,
    h('div', { class: 'fs-add' },
      button('Copy', () => { void navigator.clipboard?.writeText(JSON.stringify(cur, null, 1)).then(() => toast('Layout JSON copied', 'ok', 1200), () => toast('Copy blocked: select the text and copy it', 'warn')); }, 'tight'),
      button('Check', () => { try { issues = validateHudLayout(JSON.parse(jsonText || '{}')); toast(issues.length ? `${issues.length} note(s)` : 'Looks good', issues.some((i) => i.level === 'error') ? 'warn' : 'ok', 1500); } catch (e) { issues = [{ level: 'error', where: 'JSON', msg: (e as Error).message }]; } rerender(); }, 'tight'),
      button('Import', () => {
        let raw: unknown;
        try { raw = JSON.parse(jsonText || '{}'); } catch (e) { issues = [{ level: 'error', where: 'JSON', msg: (e as Error).message }]; rerender(); return; }
        issues = validateHudLayout(raw);
        const d = sanitizeLayoutDef(raw);
        if (!d || issues.some((i) => i.level === 'error')) { toast('Fix the errors first', 'warn'); rerender(); return; }
        if (!all.some((l) => l.id === d.id) && b.layouts.filter((l) => !isBuiltinHud(l.id)).length >= MAX_LAYOUTS) { toast(`Up to ${MAX_LAYOUTS} layouts of your own`, 'warn'); return; }
        jsonText = ''; save({ ...withLayout(bag(), d), pick: d.id }); toast(`Imported “${d.label}”`, 'ok', 1500);
      }, 'tight'),
      button('Close', () => { jsonOpen = false; jsonText = ''; issues = []; rerender(); }, 'tight')),
  ) : null;

  const root: HTMLElement = h('div', null,
    h('div', { class: 'stg-row' }, h('span', { class: 'lbl' }, 'Layout'), h('span', { class: 'note', style: 'margin:0' }, 'Pick one: your game / window fills the screen, you stand on it. Nothing else to set up.')),
    cards,
    h('details', { class: 'fs-more', open: moreOpen, onToggle: (e: Event) => { moreOpen = (e.target as HTMLDetailsElement).open; } } as never,
      h('summary', { class: 'btn tight', style: 'display:inline-block;margin:4px 0;cursor:pointer' }, 'Customize this layout (optional)'),
    camBox,
    chatBox,
    h('div', { class: 'stg-row', style: 'margin-top:8px' }, h('span', { class: 'lbl' }, 'On screen'), h('span', { class: 'note', style: 'margin:0' }, `${cur.hud.length} element${cur.hud.length === 1 ? '' : 's'} · drag them on the preview with the Layout editor`)),
    h('div', { class: 'fs-els' }, ...cur.hud.map(elBox)),
    edit ? addRow : null,
    h('div', { class: 'fs-add' },
      button('Save as my layout', dup, 'tight'),
      edited ? button('Reset to default', () => save({ ...bag(), layouts: bag().layouts.filter((l) => l.id !== cur.id) }), 'tight') : null,
      custom ? button('Delete this layout', () => save({ ...bag(), layouts: bag().layouts.filter((l) => l.id !== cur.id), pick: all[0].id }), 'tight') : null,
      button(jsonOpen ? 'JSON ▴' : 'JSON ▾', () => { jsonOpen = !jsonOpen; jsonText = ''; issues = []; rerender(); }, 'tight')),
    jsonBox,
    ),
  );
  return root;
}

registerModePanel(HUD_MODE, (app, S) => build(app, S));
