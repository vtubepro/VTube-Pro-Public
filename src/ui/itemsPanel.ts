// Live > Stream extras > "Stickers & items" (beta.16 items lane, docs/b16/ITEMS.md). Plain words, one click:
//   1. press a starter sticker, or "Add a picture or model", or drop a file on the avatar preview: it is on you, selected on the picture
//   2. drag it on the preview (corner = size, yellow dot = turn), or pick "Where" and the size here
//   3. "Save as a scene" to switch the whole look on and off from here, a deck key, a redeem or a timer
// Simple mode shows only those; the finer controls sit under "More". The panel only draws and calls the engine: every rule
// (limits, custody, what the OBS pages see) lives in src/avatar/items/{store,engine}.ts.
import {
  HAND_POSES, HAND_POSE_LABEL, PIN_CHOICES, choiceOfPin, ITEM_LIMITS,
  type HandPose, type ItemLayer,
} from '../../shared/avatarItems.ts';
import type { StudioEngine } from '../avatar/items/engine.ts';
import type { B16PanelHandle } from '../b16/panels.ts';
import { button, h, rerender, slider } from './dom.ts';

let cssDone = false;
function css() {
  if (cssDone) return;
  cssDone = true;
  const s = document.createElement('style');
  s.id = 'vtp-items-panel-css';
  s.textContent = `
.itm-p{display:flex;flex-direction:column;gap:14px}
.itm-p .itm-lead{margin:0;opacity:.85}
.itm-bar{display:flex;flex-wrap:wrap;gap:8px}
.itm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(66px,1fr));gap:8px}
.itm-card{position:relative;display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 4px;border:1px solid rgba(128,140,170,.35);border-radius:10px;background:rgba(128,140,170,.1);cursor:pointer;font:inherit;color:inherit}
.itm-card:hover,.itm-card:focus-visible{border-color:#5aa0ff;background:rgba(90,160,255,.16)}
.itm-card img{width:48px;height:48px;object-fit:contain}
.itm-card span{font-size:11px;text-align:center;line-height:1.15;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.itm-card .itm-del{position:absolute;right:2px;top:2px;width:18px;height:18px;border-radius:50%;border:0;background:rgba(0,0,0,.55);color:#fff;font:700 10px/18px system-ui;padding:0;cursor:pointer}
.itm-row{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid rgba(128,140,170,.35);border-radius:12px}
.itm-row.sel{border-color:#5aa0ff;box-shadow:0 0 0 2px rgba(90,160,255,.3)}
.itm-head{display:flex;align-items:center;gap:8px}
.itm-head img{width:36px;height:36px;object-fit:contain}
.itm-head b{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.itm-line{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.itm-line select,.itm-line input[type=text]{min-width:0}
.itm-seg{display:inline-flex;border:1px solid rgba(128,140,170,.5);border-radius:8px;overflow:hidden}
.itm-seg button{border:0;padding:4px 10px;background:transparent;color:inherit;cursor:pointer;font:inherit}
.itm-seg button.on{background:#2b7bff;color:#fff}
.itm-note{font-size:12px;opacity:.8;margin:0}
.itm-scene{display:flex;align-items:center;gap:8px;padding:6px 0}
.itm-scene b{flex:1}
.itm-pill{font-size:11px;padding:1px 8px;border-radius:99px;background:rgba(128,140,170,.25)}
.itm-pill.on{background:#1fa463;color:#fff}
.itm-empty{padding:14px;text-align:center;border:1px dashed rgba(128,140,170,.5);border-radius:12px;opacity:.85}
`;
  document.head.append(s);
}

/** Thumbnails: fetched once (through the page's own address), shown from a blob URL. */
const thumbs = new Map<string, string>();
function thumb(lib: string, alt: string): HTMLImageElement {
  const img = h('img', { alt, draggable: false }) as HTMLImageElement;
  const hit = thumbs.get(lib);
  if (hit) { img.src = hit; return img; }
  void fetch(`/api/items/file/${lib.split('/').map(encodeURIComponent).join('/')}`).then(async (r) => {
    if (!r.ok) return;
    const u = URL.createObjectURL(await r.blob());
    thumbs.set(lib, u);
    img.src = u;
  }).catch(() => { /* offline: the name still shows */ });
  return img;
}
export function releaseThumbs() { for (const u of thumbs.values()) URL.revokeObjectURL(u); thumbs.clear(); }

const AUTO_OFF: [string, string][] = [['0', 'Stays until I switch it off'], ['10', 'Switches off after 10 seconds'], ['30', 'Switches off after 30 seconds'], ['60', 'Switches off after 1 minute'], ['300', 'Switches off after 5 minutes']];

export function mountItemsPanel(host: HTMLElement, eng: StudioEngine): B16PanelHandle {
  css();
  const root = h('div', { class: 'itm-p', 'data-ui': 'items' });
  host.append(root);
  const input = h('input', { type: 'file', accept: 'image/png,image/gif,image/webp,image/jpeg,.glb,model/gltf-binary', multiple: true, style: 'display:none', 'aria-label': 'Choose a picture or model' }) as HTMLInputElement;
  input.addEventListener('change', () => { const f = [...(input.files ?? [])]; input.value = ''; if (f.length) void eng.addFiles(f); });
  let sceneName = '', sceneSecs = '0', askKeep = false;
  void eng.loadLibrary();
  void eng.openScenes();

  const draw = () => rerender(root, () => {
    const st = eng.store, lib = eng.lib;
    root.append(
      h('p', { class: 'itm-lead' }, 'Drop a picture or a small 3D model on your avatar preview and it sticks to you and follows you. Hats, tears, anger marks, a held sign.'),
      h('div', { class: 'itm-bar' },
        button('Add a picture or model…', () => input.click(), 'primary'),
        button('🎲 Random sticker', () => eng.randomSticker(), '', 'Puts a random starter sticker on you'),
        st.size ? button('Take everything off', () => eng.clearAll()) : null, input),
    );

    // ---- starters + mine
    const grid = (list: { id: string; name: string; lib: string }[], mine: boolean) => h('div', { class: 'itm-grid' }, ...list.map((p) => {
      const c = h('button', { type: 'button', class: 'itm-card', title: `Put “${p.name}” on me`, onClick: () => { const pk = eng.pickable().find((x) => x.lib === p.lib); if (pk) eng.addSticker(pk); } }, thumb(p.lib, p.name), h('span', null, p.name));
      if (mine) c.append(h('button', { type: 'button', class: 'itm-del', title: 'Delete this from my library', 'aria-label': `Delete ${p.name} from my library`, onClick: (e: Event) => { e.stopPropagation(); void eng.deleteMine(p.lib); } }, '✕'));
      return c;
    }));
    if (lib.state === 'offline') root.append(h('p', { class: 'itm-empty' }, 'The starter stickers come from VTube Pro, and it is not answering. Dropping your own picture on the avatar still works.'));
    else {
      root.append(h('section', null, h('h4', null, 'Starter stickers'), lib.state === 'ready' ? grid(eng.pickable().filter((p) => p.def).map((p) => ({ id: p.id, name: p.name, lib: p.lib })), false) : h('p', { class: 'itm-note' }, 'Loading…')));
      const mine = eng.pickable().filter((p) => !p.def);
      if (mine.length) root.append(h('section', null, h('h4', null, 'My pictures'), grid(mine.map((p) => ({ id: p.id, name: p.name, lib: p.lib })), true)));
    }

    // ---- what is on now
    const list = st.list();
    const nowSec = h('section', null, h('h4', null, `On my avatar now${list.length ? ` (${list.length})` : ''}`));
    if (!list.length) nowSec.append(h('div', { class: 'itm-empty' }, 'Nothing yet. Press a sticker above, or drag a picture onto your avatar preview and choose “Put it on my avatar”.'));
    for (const e of list) {
      const s = e.spec, sel = eng.selected === s.id;
      const choice = choiceOfPin(s.pin, s.place);
      const isHand = s.pin.to === 'bone' && /Hand$/.test(s.pin.bone);
      const row = h('div', { class: `itm-row${sel ? ' sel' : ''}`, 'data-item': s.id });
      row.append(h('div', { class: 'itm-head' },
        'lib' in s.src ? thumb(s.src.lib, s.name ?? s.id) : h('span', { style: 'font-size:26px', title: 'Dropped in (kept in memory only)' }, s.kind === 'model' ? '🧊' : '🖼️'),
        h('b', { title: s.name ?? s.id }, s.name ?? s.id),
        e.by && e.by !== 'host' ? h('span', { class: 'itm-pill', title: 'Who put it there' }, e.by === 'vts' ? 'from a plugin' : e.by === 'rule' ? 'from a redeem / rule' : e.by === 'deck' ? 'from a key' : e.by) : null,
        button(sel ? 'Editing' : 'Edit on avatar', () => eng.select(sel ? null : s.id)),
        button('✕', () => eng.remove(s.id), '', 'Take it off'),
      ));
      row.append(h('div', { class: 'itm-line' },
        h('label', null, 'Where ', h('select', { onChange: (ev: Event) => eng.setWhere(s.id, (ev.target as HTMLSelectElement).value) },
          ...(choice ? [] : [h('option', { value: '', selected: true }, 'Custom spot')]),
          ...(['head', 'body', 'hands', 'free'] as const).map((g) => h('optgroup', { label: { head: 'Head and face', body: 'Body', hands: 'Hands (held)', free: 'Free' }[g] },
            ...PIN_CHOICES.filter((c) => c.group === g).map((c) => h('option', { value: c.id, selected: c.id === choice }, c.label)))))),
        h('span', { class: 'itm-seg', role: 'group', 'aria-label': 'In front of or behind me' },
          ...(['front', 'behind'] as ItemLayer[]).map((l) => h('button', { type: 'button', class: s.layer === l ? 'on' : '', onClick: () => eng.setLayer(s.id, l) }, l === 'front' ? 'In front of me' : 'Behind me'))),
      ));
      row.append(slider('Size', s.place.scale, 0.05, 6, 0.05, (v) => eng.patch(s.id, { scale: v }, true), 'Bigger or smaller', (v) => `${Math.round(v * 100)}%`));
      row.append(slider('Turn', s.place.rot, -180, 180, 1, (v) => eng.patch(s.id, { rot: v }, true), 'Tilt it', (v) => `${Math.round(v)}°`));
      if (isHand) row.append(h('div', { class: 'itm-line' }, h('label', null, 'Hand ', h('select', { onChange: (ev: Event) => eng.setHand(s.id, ((ev.target as HTMLSelectElement).value || null) as HandPose | null) },
        h('option', { value: '', selected: !s.hand }, 'Leave my hand as it is'),
        ...HAND_POSES.map((p) => h('option', { value: p, selected: s.hand?.pose === p }, HAND_POSE_LABEL[p]))))));
      const more = h('details', null, h('summary', null, 'More'),
        slider('See-through', s.opacity ?? 1, 0.1, 1, 0.05, (v) => eng.setOpacity(s.id, v), 'Make it fainter', (v) => `${Math.round(v * 100)}%`),
        slider('Left / right', s.place.x, -1, 1, 0.005, (v) => eng.patch(s.id, { x: v }, true), 'Nudge sideways (metres on a 1.6 m avatar)'),
        slider('Up / down', s.place.y, -1, 1.5, 0.005, (v) => eng.patch(s.id, { y: v }, true), 'Nudge up or down'),
        slider('Closer / further', s.place.z, -0.5, 0.5, 0.005, (v) => eng.patch(s.id, { z: v }, true), 'Nudge toward the viewer or away'),
        h('div', { class: 'itm-line' }, button('Flip it', () => eng.patch(s.id, { flipX: !s.place.flipX })),
          'ram' in s.src ? button('Keep in my library', () => void eng.keep(s.id), '', 'Saves a copy of this picture on this PC so scenes can bring it back') : null));
      row.append(more);
      if ('ram' in s.src) row.append(h('p', { class: 'itm-note' }, 'This one was dropped in, so it only lives in memory and goes away when you close the studio. “Keep in my library” saves it on this PC.'));
      nowSec.append(row);
    }
    root.append(nowSec);

    // ---- scenes
    const scenes = st.scenes;
    const scn = h('section', null, h('h4', null, 'Item scenes'),
      h('p', { class: 'itm-note' }, 'A scene is a saved look: everything on you now. Switch it on or off here, with a Stream Deck key (“Item scene”), a redeem or rule (“Item scene” or “Sticker on me”), or let it switch itself off.'));
    const nameIn = h('input', { type: 'text', placeholder: 'Name it, for example Rage mode', maxLength: ITEM_LIMITS.maxName, value: sceneName, 'aria-label': 'Scene name', onInput: (ev: Event) => { sceneName = (ev.target as HTMLInputElement).value; } }) as HTMLInputElement;
    const dropped = eng.droppedCount();
    scn.append(h('div', { class: 'itm-line' }, nameIn,
      h('select', { 'aria-label': 'Timer', onChange: (ev: Event) => { sceneSecs = (ev.target as HTMLSelectElement).value; } }, ...AUTO_OFF.map(([v, l]) => h('option', { value: v, selected: v === sceneSecs }, l))),
      button('Save what’s on me as a scene', () => { if (dropped && !askKeep) { askKeep = true; draw(); return; } void eng.saveScene(sceneName, Number(sceneSecs), askKeep).then((okd) => { if (okd) { sceneName = ''; askKeep = false; draw(); } }); }, 'primary')));
    if (askKeep && dropped) scn.append(h('div', { class: 'itm-empty' }, `${dropped === 1 ? 'One picture' : `${dropped} pictures`} you dropped in can only live in memory. Save copies on this PC so the scene can bring them back?`,
      h('div', { class: 'itm-line', style: 'justify-content:center;margin-top:8px' },
        button('Yes, keep copies and save', () => void eng.saveScene(sceneName, Number(sceneSecs), true).then((okd) => { if (okd) { sceneName = ''; askKeep = false; draw(); } }), 'primary'),
        button('Save without them', () => void eng.saveScene(sceneName, Number(sceneSecs), false).then((okd) => { if (okd) { sceneName = ''; askKeep = false; draw(); } })),
        button('Cancel', () => { askKeep = false; draw(); }))));
    if (!scenes.length) scn.append(h('p', { class: 'itm-note' }, 'No scenes yet.'));
    for (const sc of scenes) {
      const on = st.sceneOn(sc.name);
      scn.append(h('div', { class: 'itm-scene', 'data-scene': sc.name }, h('b', null, sc.name), h('span', { class: `itm-pill${on ? ' on' : ''}` }, on ? 'On' : 'Off'),
        h('span', { class: 'itm-note' }, `${sc.items.length} thing${sc.items.length === 1 ? '' : 's'}${sc.secs ? `, off after ${sc.secs >= 60 ? `${Math.round(sc.secs / 60)} min` : `${sc.secs} s`}` : ''}`),
        button(on ? 'Switch off' : 'Switch on', () => void eng.toggleScene(sc.name)),
        button('Delete', () => void eng.deleteScene(sc.name))));
    }
    root.append(scn);
    root.append(h('p', { class: 'itm-note' }, 'Private by design: a picture you drop in stays in memory and never leaves this PC. Items only ever go on your own avatar; other people in a party are never decorated by you.'));
  });

  const un = eng.onChange(draw);
  draw();
  return { destroy() { un(); root.remove(); input.remove(); } };
}
