// "Overlay around me" (Avatars tab → 2D avatar): pick a 2.5D overlay (scenery behind you, a desk in front: shared/
// overlayStage.ts) or bring your own (OBS scene collection, a layered PSD, pictures / GIF / WebM loops, a zip). Zero
// settings: picking one shows the avatar flat over the stream, placed where the overlay says; the import plans
// everything from the files and says what it did in one sentence. One hook in src/ui/flatPanel.ts.
import type { App } from '../app.ts';
import { OVERLAY_ACCEPT, type OverlayConfig } from '../../shared/overlayStage.ts';
import { loadOverlayConfig, overlayUrl } from '../avatar/flat/overlayStage.ts';
import { planOverlayUpload, uploadOverlay } from '../avatar/flat/overlayImport.ts';
import { filesFromDrop } from './flatPanel.ts';
import { button, h, section, select, slider, toast } from './dom.ts';

interface OverlayRow { id: string; name: string; layers: number; builtin: boolean; thumb: boolean; credits?: string }
let rows: OverlayRow[] | null = null;
let loading: Promise<OverlayRow[]> | null = null;
function listOverlays(fresh = false): Promise<OverlayRow[]> {
  if (fresh) { rows = null; loading = null; }
  if (rows) return Promise.resolve(rows);
  loading ??= fetch('/api/overlays', { cache: 'no-cache' }).then(async (r) => {
    const j = r.ok ? await r.json() as OverlayRow[] : [];
    return (rows = Array.isArray(j) ? j : []);
  }).catch(() => (rows = []));
  return loading;
}

const CSS = `.ov-pick{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:8px;margin:6px 0}
.ov-pick button{all:unset;cursor:pointer;border:2px solid var(--line,#2c343e);border-radius:10px;overflow:hidden;background:var(--card2,#222932);display:flex;flex-direction:column}
.ov-pick button:focus-visible{outline:2px solid #7bd88f}
.ov-pick button.on{border-color:#7bd88f}
.ov-pick img,.ov-pick .none{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#151a20}
.ov-pick .none{display:flex;align-items:center;justify-content:center;color:var(--dim,#9aa4af);font-size:12px}
.ov-pick span{padding:4px 7px;font-size:12px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`;
let cssDone = false;

/** Apply an overlay to the loaded 2D avatar: show it flat over the stream, placed where the overlay says. */
export async function useOverlay(app: App, id: string | null) {
  const c: OverlayConfig | null = id ? await loadOverlayConfig(id, true) : null;
  if (id && !c) { toast('That overlay could not be loaded.', 'err'); return; }
  app.edit((p) => {
    const d = p.flat?.display;
    if (!d) return;
    if (!id) { delete d.overlay.stage; return; }
    d.mode = 'overlay';
    d.overlay.stage = id;
    if (c?.avatar) { d.overlay.anchor = c.avatar.anchor; d.overlay.x = c.avatar.x; d.overlay.y = c.avatar.y; d.overlay.scale = c.avatar.scale; }
  });
  if (c) toast(`${c.name} is on: ${c.layers.some((l) => l.side === 'back') ? 'scenery behind you' : ''}${c.layers.some((l) => l.side === 'back') && c.layers.some((l) => l.side === 'front') ? ', ' : ''}${c.layers.some((l) => l.side === 'front') ? 'things in front of you' : ''}. Size and place: More….`, 'ok', 5200);
}

/** The block for the 2D avatar panel (null when no 2D avatar is loaded). */
export function overlayStageSection(app: App): HTMLElement | null {
  const p = app.profile?.flat;
  if (!p) return null;
  if (!cssDone) { cssDone = true; document.head.append(h('style', { id: 'vtp-ov-panel' }, CSS)); }
  const cur = p.display.mode === 'overlay' ? p.display.overlay.stage ?? null : null;
  const grid = h('div', { class: 'ov-pick', role: 'listbox', 'aria-label': 'Overlay around me' });
  const note = h('p', { class: 'note' }, 'Scenery behind you, a desk or plants in front: it moves with your head, like a real room.');
  const tile = (id: string | null, name: string, img: string | null) => {
    const b = h('button', { class: cur === id ? 'on' : '', role: 'option', 'aria-selected': String(cur === id), title: name },
      img ? h('img', { src: img, alt: '', loading: 'lazy' }) : h('div', { class: 'none' }, id ? 'No preview' : 'No overlay'), h('span', null, name));
    b.onclick = () => void useOverlay(app, id);
    return b;
  };
  const paint = (list: OverlayRow[]) => {
    grid.replaceChildren(tile(null, 'None', null), ...list.map((o) => tile(o.id, o.name, o.thumb ? `${overlayUrl(o.id)}/thumb` : null)));
  };
  paint([]);
  const add = h('div', { class: 'btns' }, button('Add my overlay…', () => openOverlayImport(app)));
  void listOverlays().then((list) => {
    paint(list);
    // a helper older than overlays: its update sentence instead of an empty picker (None stays when one is picked)
  });
  const extra: Node[] = [];
  if (cur) {
    const d = p.display.overlay;
    extra.push(
      slider('My size', d.scale, 0.1, 1.6, 0.01, (v) => app.edit((x) => { if (x.flat) x.flat.display.overlay.scale = v; })),
      slider('Left / right', d.x, -0.5, 0.5, 0.005, (v) => app.edit((x) => { if (x.flat) x.flat.display.overlay.x = v; })),
      slider('Up / down', d.y, -0.5, 0.5, 0.005, (v) => app.edit((x) => { if (x.flat) x.flat.display.overlay.y = v; })),
      select('Stand at', d.anchor === 'bottom-left' || d.anchor === 'bottom-right' ? d.anchor : 'bottom', [['bottom-left', 'Left'], ['bottom', 'Middle'], ['bottom-right', 'Right']], (v) => app.edit((x) => { if (x.flat) { x.flat.display.overlay.anchor = v; x.flat.display.overlay.x = 0; } })));
  }
  return section('Overlay around me', note, grid, ...extra, add);
}

/** "Add my overlay": drop whatever you have; it is planned in the browser, stored on this PC and put on. */
export function openOverlayImport(app: App, files?: File[]) {
  document.querySelector('.flat-imp-back')?.remove();
  const box = h('div', { class: 'flat-imp', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Add my overlay' });
  const back = h('div', { class: 'flat-imp-back', onClick: (e: Event) => { if (e.target === back) close(); } }, box);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const close = () => { back.remove(); window.removeEventListener('keydown', onKey, true); };
  window.addEventListener('keydown', onKey, true);
  document.body.append(back);
  const run = async (fs: File[]) => {
    if (app.observer) { toast('Observer sandbox: imports are off here.', 'warn'); return; }
    box.replaceChildren(h('h3', null, 'Adding your overlay…'), h('p', null, `${fs.length} file${fs.length > 1 ? 's' : ''}: working out what goes behind you and what goes in front.`));
    try {
      const plan = await planOverlayUpload(fs);
      const r = await uploadOverlay(plan);
      listOverlays(true);
      await useOverlay(app, r.id);
      const back = plan.config.layers.filter((l) => l.side === 'back').length, front = plan.config.layers.length - back;
      box.replaceChildren(h('h3', null, `${r.name} is on`),
        ...(plan.thumb ? [h('img', { class: 'done', src: URL.createObjectURL(plan.thumb), alt: '' })] : []),
        h('p', null, `${back} layer${back === 1 ? '' : 's'} behind you, ${front} in front. They move a little with your head, like a real room; the performer's place came from your overlay.`),
        ...(plan.notes.length || r.missing?.length ? [h('ul', { class: 'note' }, ...[...plan.notes, ...(r.missing?.length ? [`Left out (could not be read): ${r.missing.join(', ')}`] : [])].slice(0, 5).map((n) => h('li', null, n)))] : []),
        h('div', { class: 'btns' }, button('Done', close, 'primary')));
    } catch (e) {
      box.replaceChildren(h('h3', null, 'That didn’t work'), h('p', null, (e as Error).message),
        h('div', { class: 'btns' }, button('Try again', () => { close(); openOverlayImport(app); }, 'primary'), button('Close', close)));
    }
  };
  const input = h('input', { type: 'file', accept: OVERLAY_ACCEPT, multiple: true, style: 'display:none' }) as HTMLInputElement;
  const zone = h('div', { class: 'drop', tabindex: '0', role: 'button' }, 'Drop your overlay here (files, a folder or a .zip), or click to choose');
  zone.onclick = () => input.click();
  zone.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
  input.onchange = () => { if (input.files?.length) void run([...input.files]); };
  zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('over'); };
  zone.ondragleave = () => zone.classList.remove('over');
  zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove('over'); void filesFromDrop(e.dataTransfer).then((f) => { if (f.length) void run(f); }); };
  box.append(h('h3', null, 'Add my overlay'),
    h('p', null, 'Bring the overlay you already stream with. VTube Pro puts the scenery behind you and the desk, plants or frame in front, and it moves with your head.'),
    h('ul', null,
      h('li', null, 'From OBS: Scene Collection → Export, then drop that .json together with your overlay pictures (or their folder)'),
      h('li', null, 'A layered PSD: name the layer where you stand “avatar” (or “model”, “vtuber”)'),
      h('li', null, 'Pictures, GIFs or WebM / MP4 loops: background.png, desk.png … or numbered 1_back.png, 2_desk.png')),
    zone, input, h('div', { class: 'btns' }, button('Cancel', close)));
  if (files?.length) void run(files);
}
