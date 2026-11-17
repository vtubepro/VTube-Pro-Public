// Studio settings for a 2D rig (kind 'rig2d': VTube Pro's own .vtp2 puppets incl. converted Live2D models). One entry
// point, rig2dPanel(app), appended by src/ui/flatPanel.ts (one line). Zero effort: everything works with no settings
// (the face is bound automatically); the few everyday options are on top, the parameter mapping is behind "Details"
// for unusual models; outfit switches and the performer's model sliders (chest, body, hair …) come from
// src/ui/rig2dSliders.ts. Settings live in profile.flat.opts (validated by src/avatar/flat/rig2d/source.ts rig2dOpts).
import type { App } from '../app.ts';
import { RIG2D_SOURCES, SOURCE_LABEL, type Rig2DBinding, type Rig2DStdSource } from '../../shared/rig2d/drive.ts';
import { Animator } from '../../shared/rig2d/animate.ts';
import { rig2dOpts } from '../avatar/flat/rig2d/source.ts';
import type { Rig2DDoc } from '../../shared/rig2d/format.ts';
import { button, h, section, slider, toggle } from './dom.ts';
import { rig2dSliders, rig2dSlidersRefresh } from './rig2dSliders.ts';
import { openTo3d } from './to3dPanel.ts';
import { rig2dTuneBlock } from './rig2dTune.ts';
import { editRigBlock } from './rig2dEditRig.ts';
import { wasLive2D } from '../../shared/rig2d/rigEdit.ts';

const CSS = `
.rig2d-map{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1.4fr) auto;gap:6px 8px;align-items:center;margin:8px 0}
.rig2d-map select{width:100%;min-width:0}
.rig2d-map .inv{font-size:12px;display:flex;gap:4px;align-items:center;white-space:nowrap}
.rig2d details summary{cursor:pointer;margin:8px 0;font-weight:600}
.rig2d .note{opacity:.8;font-size:12.5px}`;
let cssDone = false;

interface RigLike { doc: Rig2DDoc; anim: Animator; cpuMs?: number }

/** Every setting here is a live option of the running rig: applied in place (no rebuild in the studio; the OBS page
 *  does the same on the save, src/avatar/flat/rig2d/liveOpts.ts) — a reload would be visible on stream. */
function edit(app: App, fn: (o: Record<string, unknown>) => void) {
  app.edit((p) => { if (p.flat) { const o = { ...(p.flat.opts ?? {}) }; fn(o); p.flat.opts = o; } }, false);
  const src = app.runtime?.flat?.source as unknown as { applyOpts?: (o: unknown) => void } | undefined;
  try { src?.applyOpts?.(app.profile?.flat?.opts ?? {}); } catch (e) { console.warn('[rig2d] live options', e); app.rebuild(); }
  rig2dSlidersRefresh(app);   // (a new mapping can make a slider a tracked parameter)
}

export function rig2dPanel(app: App): HTMLElement | null {
  const p = app.profile, src = app.runtime?.flat?.source as unknown as RigLike | undefined;
  if (!p?.flat || p.flat.kind !== 'rig2d' || !src?.doc) return null;
  if (!cssDone) { cssDone = true; document.head.append(h('style', { id: 'vtp-rig2d-panel' }, CSS)); }
  const doc = src.doc, opts = rig2dOpts(p.flat.opts);
  const root = h('div', { class: 'rig2d' });
  // (also after it was edited and saved in the 2D avatar maker)
  const fromLive2D = wasLive2D(doc.meta);
  const items: Node[] = [
    h('p', { class: 'note' }, fromLive2D ? 'Brought in from another 2D app. It follows your face and voice automatically.' : 'It follows your face and voice automatically.'),
    slider('Mouth', opts.lipGain ?? 1, 0, 3, 0.05, (v) => edit(app, (o) => { o.lipGain = v; }), 'How wide the mouth opens when you talk'),
    slider('Head movement', opts.headGain ?? 1, 0, 2, 0.05, (v) => edit(app, (o) => { o.headGain = v; }), 'How far the head turns with yours'),
    toggle('Hair and clothes swing', opts.physics !== false, (v) => edit(app, (o) => { o.physics = v; })),
  ];
  // "How much each part moves" (brows up / down …, src/ui/rig2dTune.ts) + "Edit rig" (src/ui/rig2dEditRig.ts)
  const tune = rig2dTuneBlock(src, p.flat.opts?.tune, (t) => edit(app, (o) => { if (t) o.tune = t; else delete o.tune; }), () => app.runtime?.flat?.source as unknown as RigLike | undefined);
  if (tune) items.push(tune);
  items.push(editRigBlock(app, doc));
  items.push(h('button', { class: 'btn', 'data-ui': 'to3d', onClick: () => openTo3d({ avatarId: p.id, onWear: (id) => void app.loadAvatar(id) }) }, 'Make a 3D version with my AI')); // lane to3d (src/ui/to3dPanel.ts)
  if (doc.motions?.some((m) => /^idle$/i.test(m.group))) items.push(toggle('Idle animation', opts.idleMotion !== false, (v) => edit(app, (o) => { o.idleMotion = v; }), 'The model’s own breathing / idle motion under your tracking'));
  // outfit switches (costume layers, live: no reload) + "Model sliders (N)": src/ui/rig2dSliders.ts
  const extra = rig2dSliders(app);
  if (extra) items.push(extra);
  // live cost meter (the runtime's own per-frame CPU time)
  const meter = h('p', { class: 'note' }, '');
  const tick = () => { if (!meter.isConnected) return; const ms = src.cpuMs ?? 0; meter.textContent = ms ? `Runs in ${ms.toFixed(2)} ms per frame on this computer.` : ''; setTimeout(tick, 1000); };
  setTimeout(tick, 300);
  root.append(section('2D model', ...items, meter, mapping(app, doc, opts.bindings)));
  return root;
}

/** "Details": which tracked input moves which parameter (automatic by default). */
function mapping(app: App, doc: Rig2DDoc, user: Rig2DBinding[] | undefined): HTMLElement {
  const auto = Animator.autoBindings(doc);
  const cur: Rig2DBinding[] = user ?? auto;
  const byParam = (s: Rig2DStdSource) => cur.find((b) => b.src === s);
  const opts = [h('option', { value: '' }, '— nothing —'), ...doc.params.filter((q) => q.kind !== 'blend').map((q) => h('option', { value: q.id }, q.name && q.name !== q.id ? `${q.name} (${q.id})` : q.id))];
  const grid = h('div', { class: 'rig2d-map' });
  const save = (next: Rig2DBinding[]) => edit(app, (o) => { o.bindings = next; });
  for (const s of RIG2D_SOURCES) {
    const b = byParam(s);
    const sel = h('select', { 'aria-label': SOURCE_LABEL[s] }, ...opts.map((o) => o.cloneNode(true)));
    sel.value = b && !b.off ? b.param : '';
    const inv = h('input', { type: 'checkbox', checked: !!b?.invert, 'aria-label': `Reverse ${SOURCE_LABEL[s]}` });
    const apply = () => {
      const rest = cur.filter((x) => x.src !== s);
      save(sel.value ? [...rest, { src: s, param: sel.value, ...(inv.checked ? { invert: true } : {}) }] : rest);
    };
    sel.onchange = apply; inv.onchange = apply;
    grid.append(h('span', null, SOURCE_LABEL[s]), sel, h('label', { class: 'inv' }, inv, 'reverse'));
  }
  const unbound = RIG2D_SOURCES.filter((s) => !auto.some((b) => b.src === s) && ['headYaw', 'eyeOpenL', 'mouthOpen'].includes(s));
  return h('details', null, h('summary', null, 'Details: what moves what'),
    unbound.length ? h('p', { class: 'note' }, 'This model uses its own names for some parts. Pick which slider moves for each one below.') : h('p', { class: 'note' }, 'Everything is connected automatically. Change this only if a part moves wrongly.'),
    grid,
    button('Back to automatic', () => edit(app, (o) => { delete o.bindings; })));
}
