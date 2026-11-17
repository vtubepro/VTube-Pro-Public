// The 2D avatar maker's panels for the beyond-Live2D features (docs/RIG2D_FORMAT.md §8): Bones, Lighting, Effects
// (particles + props), Moods (expression rules) and Outfits (costume layers + angle views). The auto-rig fills all of
// them; these panels are the power-user path. Each panel is a function of a small context the editor provides.
import type { EdBone, EdDoc, EdDynamic, EdMesh, EdTexture, EdParticles } from '../../shared/rig2d/edit/doc.ts';
import type { PreviewExtras } from '../../shared/rig2d/edit/preview.ts';
import type { LightOpts } from './gl.ts';
import { addPreset, defaultMoods, autoBones, nearestVertex, PRESETS, turnOf, turnSpring, ensureSwingAmount, setSwingReach, swingReachBase, type PresetId, type Landmarks } from '../../shared/rig2d/edit/extras.ts';
import { readRules, writeRules, ruleText, autoLayerOn, setAutoLayer, TRIGGER_LABEL, EMOTIONS, EVENTS, type MoodRule, type TriggerKind } from '../../shared/rig2d/edit/moods.ts';
import { chainWeights } from '../../shared/rig2d/edit/skin.ts';

export type Hfn = <K extends keyof HTMLElementTagNameMap>(tag: K, props?: Record<string, unknown> | null, ...kids: (Node | string | null | undefined | false)[]) => HTMLElementTagNameMap[K];
export interface PanelCtx {
  h: Hfn;
  doc: EdDoc;
  textures: EdTexture[];
  sel: string | null;
  selBone: string | null;
  setSelBone(id: string | null): void;
  edit(fn: () => void, topology?: boolean): void;
  toast(msg: string, err?: boolean): void;
  setTool(t: string): void;
  tool: string;
  extras: PreviewExtras | null;
  /** Make a trigger happen in the preview (emotion / chat / event / hotkey). */
  fire(kind: string, value: string): void;
  light: LightOpts;
  lightChanged(): void;
  range(min: number, max: number, step: number, value: number, onInput: (v: number) => void, label: string, fmt?: (v: number) => string, onCommit?: () => void): HTMLElement;
  thumb(tex: number): string;
  rerender(): void;
  /** A texture was added / changed (repack the atlas). */
  texChanged(): void;
  /** Pick a slot on the avatar for an effect / prop (the next click). */
  placeSlot(kind: 'particle' | 'attachment', id: string): void;
  wind: boolean;
  setWind(on: boolean): void;
  landmarks(): Landmarks | null;
  /** Retune a dynamics solver in the running preview at once (no rebuild): stiffness, damping, gravity, limits. */
  tune(id: string, t: { stiffness?: number; damping?: number; gravity?: number; limit?: number; boneLimit?: number }): void;
  /** A parameter's default changed (a part's swing amount): the running preview uses it at once. */
  liveParam(id: string, def: number): void;
  /** A live slider gesture starts (remember the state for ONE undo step) / ends (keep it; the preview carries its motion on). */
  liveBegin(): void;
  liveCommit(): void;
  pickPng(): Promise<{ name: string; w: number; h: number; rgba: Uint8ClampedArray } | null>;
}

const btn = (c: PanelCtx, label: string, fn: () => void, cls = '', title = '') => c.h('button', { class: cls, onClick: fn, ...(title ? { title } : {}) }, label);
const card = (c: PanelCtx, ...kids: (Node | string | null | false)[]) => c.h('div', { class: 'r2e-card' }, ...kids);
const field = (c: PanelCtx, label: string, el: HTMLElement) => c.h('label', { class: 'r2e-field' }, c.h('span', null, label), el);
const check = (c: PanelCtx, on: boolean, fn: (v: boolean) => void, label: string) => { const i = c.h('input', { type: 'checkbox', checked: on, 'aria-label': label }) as HTMLInputElement; i.addEventListener('change', () => fn(i.checked)); return i; };

// ================================================================ bones
/** The bone chains' swing settings (Bones tab and Physics tab). */
export function chainCards(c: PanelCtx): Node[] { return bonesPanel(c, true); }

export function bonesPanel(c: PanelCtx, chainsOnly = false): Node[] {
  const { h, doc } = c;
  const X = doc.extras ?? {};
  const bones = X.bones ?? [];
  const out: Node[] = [h('p', { class: 'r2e-dim' }, 'Hair strands, animal ears and hanging accessories swing on bones. The automatic ones are made for you; you can draw your own and paint which part of the picture each bone moves.')];
  out.push(h('label', { class: 'r2e-field' }, h('span', null, 'Bones'), check(c, X.useBones !== false, (v) => c.edit(() => { (doc.extras ??= {}).useBones = v; const L = c.landmarks(); if (L) autoBones(doc, c.textures, L); }, true), 'Use bones for hair')),
    h('label', { class: 'r2e-field' }, h('span', null, 'Wind'), check(c, c.wind, (v) => c.setWind(v), 'Gentle wind in the preview')));
  // chains by mesh
  const chains = (X.dynamics ?? []).filter((y) => y.kind === 'chain');
  if (chains.length) out.push(h('p', { class: 'r2e-dim' }, '"Swing amount" calms or livens everything a part does (0 = still). The other sliders shape how it moves. Changes show at once while the preview moves.'));
  for (const ch of chains) {
    const first = bones.find((b) => b.id === ch.bones?.[0]);
    const mesh = doc.meshes.find((m) => m.skin && first && first.id in m.skin);
    const partName = mesh?.name ?? first?.name ?? ch.id, hair = !!mesh && ['hairSide', 'hairBack', 'ahoge'].includes(mesh.role);
    // the head-turn kick that goes with the chain: "Stiffness" / "Calms down" set both (same damping ratio: turnSpring)
    const turn = turnOf(doc, ch);
    const syncTurn = () => { if (!turn) return; Object.assign(turn, turnSpring(ch.stiffness ?? 40, ch.damping ?? 6)); c.tune(turn.id, { stiffness: turn.stiffness, damping: turn.damping }); };
    const amt = doc.params.find((p) => p.id === ch.amount);
    // "How far it can swing": each gesture scales from where it started (exact round trips, no floor creeping in)
    let reach: ReturnType<typeof swingReachBase> | null = null;
    const done = () => { reach = null; c.liveCommit(); };
    out.push(card(c,
      h('div', { class: 'r2e-row', style: 'grid-template-columns:34px 1fr auto' }, mesh ? h('img', { src: c.thumb(mesh.tex), alt: '', style: 'width:30px;height:30px;object-fit:contain' }) : h('span'),
        h('b', null, partName), btn(c, 'Delete', () => c.edit(() => removeChain(doc, ch.id), true))),
      h('p', { class: 'r2e-dim' }, `${ch.bones?.length ?? 0} bones${ch.auto ? ' (automatic)' : ''}`),
      c.range(0, 2, 0.05, amt?.def ?? 1, (v) => {
        c.liveBegin();
        const id = ensureSwingAmount(doc, ch, partName, hair);
        const p = doc.params.find((q) => q.id === id)!;
        p.def = v; c.liveParam(id, v);
      }, 'Swing amount', (v) => (v <= 0 ? 'still' : `${Math.round(v * 100)} %`), done),
      c.range(5, 200, 1, ch.stiffness ?? 40, (v) => { c.liveBegin(); ch.stiffness = v; c.tune(ch.id, { stiffness: v }); syncTurn(); }, 'Stiffness', (v) => `${Math.round(v)}`, done),
      c.range(0.5, 20, 0.5, ch.damping ?? 6, (v) => { c.liveBegin(); ch.damping = v; c.tune(ch.id, { damping: v }); syncTurn(); }, 'Calms down', (v) => v.toFixed(1), done),
      c.range(0, 1500, 10, ch.gravity ?? 0, (v) => { c.liveBegin(); ch.gravity = v; c.tune(ch.id, { gravity: v }); }, 'Hangs down (gravity)', (v) => `${Math.round(v)}`, done),
      // the per-bone limit keeps its share of the whole chain's (raising it really lets the part swing further); the
      // automatic head-turn kick's bend follows (a keyform: the preview picks it up when the slider is let go)
      c.range(5, 90, 1, ch.limit ?? 90, (v) => {
        c.liveBegin();
        reach ??= swingReachBase(doc, ch);
        setSwingReach(doc, ch, reach, v);
        c.tune(ch.id, { limit: v, boneLimit: ch.boneLimit });
      }, 'How far it can swing', (v) => `${Math.round(v)}°`, done),
      h('div', { class: 'r2e-btns' }, ...(ch.bones ?? []).map((id, i) => btn(c, `Bone ${i + 1}`, () => { c.setSelBone(id); c.setTool('weights'); }, c.selBone === id ? 'on' : '', 'Paint which part this bone moves')))));
  }
  if (chainsOnly) return out.slice(2);
  const m = c.sel ? doc.meshes.find((x) => x.id === c.sel) : undefined;
  out.push(h('h4', null, 'Your own bones'),
    h('p', { class: 'r2e-dim' }, m ? `Selected: ${m.name}. Choose "Draw a chain", click along the strand from its root to its tip, then "Finish".` : 'Select a part first (click it in the picture or the list).'),
    h('div', { class: 'r2e-btns' },
      btn(c, c.tool === 'bone' ? 'Drawing… click along the part' : 'Draw a chain', () => c.setTool(c.tool === 'bone' ? 'look' : 'bone'), c.tool === 'bone' ? 'on' : ''),
      btn(c, c.tool === 'weights' ? 'Painting weights' : 'Paint weights', () => c.setTool(c.tool === 'weights' ? 'look' : 'weights'), c.tool === 'weights' ? 'on' : '', 'Drag to add, Alt + drag to remove'),
      btn(c, 'Make the automatic bones again', () => c.edit(() => { const L = c.landmarks(); if (L) { for (const mm of doc.meshes) if (mm.skin) for (const id of Object.keys(mm.skin)) if (id.startsWith('auto_')) delete mm.skin[id]; autoBones(doc, c.textures, L); } }, true))));
  return out;
}

/** Make a bone chain on mesh `m` through `pts` (rest space, root first): a still anchor + one bone per segment, automatic
 *  weights, chain physics. */
export function makeChain(doc: EdDoc, m: EdMesh, pts: [number, number][]): string | null {
  if (pts.length < 2) return null;
  const X = (doc.extras ??= {});
  const base = `bone_${m.id}`.replace(/[^\w-]/g, '_').slice(0, 40);
  let k = 1; while ((X.bones ?? []).some((b) => b.id.startsWith(`${base}_${k}_`))) k++;
  const pre = `${base}_${k}`;
  const ang = (a: [number, number], b: [number, number]) => Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
  const anchor: EdBone = { id: `${pre}_root`, name: `${m.name} root`, parent: null, deformer: m.deformer, x: pts[0][0], y: pts[0][1], angle: ang(pts[0], pts[1]), length: 4, forms: [] };
  const chain: EdBone[] = [];
  for (let i = 0; i + 1 < pts.length; i++) chain.push({ id: `${pre}_${i + 1}`, name: `${m.name} ${i + 1}`, parent: i ? chain[i - 1].id : anchor.id, deformer: null, x: pts[i][0], y: pts[i][1], angle: ang(pts[i], pts[i + 1]), length: Math.max(2, Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])), forms: [] });
  (X.bones ??= []).push(anchor, ...chain);
  // the new chain owns this part's weights
  m.skin = chainWeights(m, chain, 0.35, anchor);
  const ch: EdDynamic = { id: `${pre}_swing`, kind: 'chain', bones: chain.map((b) => b.id), stiffness: 40, damping: 6, gravity: 400, limit: 45, boneLimit: 25 };
  (X.dynamics ??= []).push(ch);
  ensureSwingAmount(doc, ch, m.name, ['hairSide', 'hairBack', 'ahoge', 'hairFront'].includes(m.role));
  return chain[0].id;
}

function removeChain(doc: EdDoc, dynId: string) {
  const X = doc.extras ?? {};
  const ch = (X.dynamics ?? []).find((y) => y.id === dynId);
  if (!ch) return;
  const ids = new Set(ch.bones ?? []);
  for (const b of X.bones ?? []) if (b.parent && ids.has(b.parent)) ids.add(b.id);
  const roots = (X.bones ?? []).filter((b) => ids.has(b.id)).map((b) => b.parent).filter((p): p is string => !!p && !ids.has(p));
  for (const r of roots) if (!(X.bones ?? []).some((b) => b.parent === r && !ids.has(b.id))) ids.add(r);
  X.bones = (X.bones ?? []).filter((b) => !ids.has(b.id));
  X.dynamics = (X.dynamics ?? []).filter((y) => y.id !== dynId && !(y.kind === 'jiggle' && y.output && y.id.startsWith(dynId.replace(/_swing$/, ''))));
  // its swing amount goes with it (no slider that moves nothing)
  if (ch.amount && !X.dynamics.some((y) => y.amount === ch.amount)) doc.params = doc.params.filter((p) => p.id !== ch.amount);
  for (const m of doc.meshes) if (m.skin) { for (const id of Object.keys(m.skin)) if (ids.has(id)) delete m.skin[id]; if (!Object.keys(m.skin).length) delete m.skin; }
}

// ================================================================ lighting
export function lightPanel(c: PanelCtx): Node[] {
  const { h, doc, light } = c;
  const X = (doc.extras ??= {});
  const L = (X.lighting ??= { maps: true, rimPx: 6, tint: 0.6, strength: 0.8, rim: { width: 0.35, strength: 0.8 } });
  const seg = (m: LightOpts['mode'], label: string) => btn(c, label, () => { light.mode = m; c.lightChanged(); }, light.mode === m ? 'on' : '');
  const dirAngle = Math.round(Math.atan2(light.dir[1], light.dir[0]) * 180 / Math.PI), dirHeight = Math.round(Math.asin(Math.max(-1, Math.min(1, light.dir[2] / (Math.hypot(...light.dir) || 1)))) * 180 / Math.PI);
  const setDir = (a: number, e: number) => { const r = a * Math.PI / 180, el = e * Math.PI / 180; light.dir = [Math.cos(r) * Math.cos(el), Math.sin(r) * Math.cos(el), Math.sin(el)]; c.lightChanged(); };
  let A = dirAngle, E = dirHeight;
  const outerRoles = new Set(['face', 'hairFront', 'hairSide', 'hairBack', 'ahoge', 'ear', 'neck', 'body', 'arm', 'hand', 'headAcc', 'bodyAcc']);
  const anyOutline = doc.meshes.find((m) => m.outline && m.outline.width > 0)?.outline;
  const ow = anyOutline?.width ?? 0;
  const col = h('input', { type: 'color', value: `#${(anyOutline?.color ?? [40, 28, 50]).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`, 'aria-label': 'Outline colour' }) as HTMLInputElement;
  const applyOutline = (width: number) => c.edit(() => {
    const hex = col.value.replace('#', ''), rgb: [number, number, number] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
    for (const m of doc.meshes) if (outerRoles.has(m.role)) { if (width > 0) m.outline = { width, color: rgb, opacity: 1, light: !!m.outline?.light || followIn.checked }; else delete m.outline; }
  }, true);
  const followIn = check(c, !!anyOutline?.light, () => applyOutline(ow), 'Outline follows the room light');
  col.addEventListener('change', () => applyOutline(Math.max(1, ow)));
  return [
    h('p', { class: 'r2e-dim' }, 'Room lights shade your avatar using maps made from your art: a normal map (the shape) and a rim map (where edges catch light). Check them here; nothing to paint.'),
    h('div', { class: 'r2e-btns', role: 'group', 'aria-label': 'Preview' }, seg('art', 'Flat'), seg('lit', 'Lit'), seg('normal', 'Normal map'), seg('rim', 'Rim map')),
    h('label', { class: 'r2e-field' }, h('span', null, 'Use room light'), check(c, L.maps, (v) => c.edit(() => { L.maps = v; }), 'Make lighting maps')),
    c.range(-180, 180, 1, A, (v) => { A = v; setDir(A, E); }, 'Test light from', (v) => `${Math.round(v)}°`),
    c.range(5, 85, 1, E, (v) => { E = v; setDir(A, E); }, 'Test light height', (v) => `${Math.round(v)}°`),
    h('div', { class: 'r2e-btns' }, ...([['Warm', [1, 0.88, 0.72]], ['Daylight', [1, 0.98, 0.95]], ['Neon pink', [1, 0.45, 0.8]], ['Neon blue', [0.45, 0.7, 1]]] as [string, [number, number, number]][]).map(([n, k]) => btn(c, n, () => { light.key = k; if (light.mode === 'art') light.mode = 'lit'; c.lightChanged(); }))),
    c.range(0, 1, 0.01, L.strength, (v) => { L.strength = v; c.lightChanged(); }, 'Shading strength', (v) => `${Math.round(v * 100)} %`, () => c.edit(() => {})),
    c.range(0, 1, 0.01, L.tint, (v) => { L.tint = v; }, 'Room colour tint', (v) => `${Math.round(v * 100)} %`, () => c.edit(() => {})),
    c.range(0, 2, 0.01, L.rim.strength, (v) => { L.rim.strength = v; c.lightChanged(); }, 'Rim light', (v) => v.toFixed(2), () => c.edit(() => {})),
    c.range(0, 1, 0.01, L.rim.width, (v) => { L.rim.width = v; c.lightChanged(); }, 'Rim width', (v) => v.toFixed(2), () => c.edit(() => {})),
    c.range(1, 40, 1, L.rimPx, (v) => { L.rimPx = v; }, 'Edge band in the rim map', (v) => `${Math.round(v)} px`, () => c.edit(() => {})),
    h('h4', null, 'Outline'),
    h('p', { class: 'r2e-dim' }, 'An ink line around the hair, face and body. Most art has lines already: leave it at 0 then.'),
    c.range(0, 8, 0.5, ow, () => {}, 'Width', (v) => (v ? `${v} px` : 'off'), undefined),
    field(c, 'Colour', col), field(c, 'Follows room light', followIn),
  ].map((n) => {
    // the outline width slider applies on release
    if (n instanceof HTMLElement && n.querySelector?.('input[aria-label="Width"]')) n.querySelector('input')!.addEventListener('change', (e) => applyOutline(Number((e.target as HTMLInputElement).value)));
    return n;
  });
}

// ================================================================ effects + props
const TRIG: { v: string; label: string; kind: EdParticles['trigger']['kind']; value?: string }[] = [
  { v: 'emotion:happy', label: 'When I look happy', kind: 'emotion', value: 'happy' }, { v: 'emotion:sad', label: 'When I look sad', kind: 'emotion', value: 'sad' },
  { v: 'emotion:angry', label: 'When I look angry', kind: 'emotion', value: 'angry' }, { v: 'emotion:surprised', label: 'When I look surprised', kind: 'emotion', value: 'surprised' },
  { v: 'voice:', label: 'While I talk', kind: 'voice' }, { v: 'always:', label: 'Always', kind: 'always' },
  { v: 'chat:', label: 'When chat says…', kind: 'chat' }, { v: 'event:follow', label: 'On a new follower', kind: 'event', value: 'follow' }, { v: 'event:sub', label: 'On a new subscriber', kind: 'event', value: 'sub' },
  { v: 'hotkey:', label: 'On a hotkey', kind: 'hotkey' },
];
export function fxPanel(c: PanelCtx): Node[] {
  const { h, doc } = c;
  const X = (doc.extras ??= {});
  const out: Node[] = [h('p', { class: 'r2e-dim' }, 'Little effects that play when something happens, and props pinned to your avatar. Press "Try" to see an effect.')];
  out.push(h('div', { class: 'r2e-btns' }, ...(Object.keys(PRESETS) as PresetId[]).map((id) => btn(c, `+ ${PRESETS[id].name}`, () => {
    const L = c.landmarks();
    const m = c.sel ? doc.meshes.find((x) => x.id === c.sel) : undefined;
    const t = m ? doc.textures[m.tex] : null;
    const at = t ? [t.x + t.w / 2, t.y + t.h * 0.3] : L ? [L.F.x + L.F.w * 0.9, L.F.y + L.F.h * 0.15] : [doc.canvas.w / 2, doc.canvas.h / 3];
    const v = nearestVertex(doc, at[0], at[1], m ? (x) => x.id === m.id : () => true);
    if (!v) return;
    c.edit(() => { addPreset(doc, c.textures, id, v); }, true);
    c.texChanged();
    c.toast(`${PRESETS[id].name} added${m ? ` on ${m.name}` : ''}. Use "Move" to put it somewhere else.`);
  }))));
  for (const p of X.particles ?? []) {
    const sel = h('select', { 'aria-label': `When ${p.name} plays` }, ...TRIG.map((t) => h('option', { value: t.v, selected: `${p.trigger.kind}:${t.value ?? (t.kind === 'chat' || t.kind === 'hotkey' ? '' : '')}` === t.v || (t.kind === p.trigger.kind && !t.value && (p.trigger.kind === 'chat' || p.trigger.kind === 'hotkey' || p.trigger.kind === 'voice' || p.trigger.kind === 'always')) }, t.label))) as HTMLSelectElement;
    const txt = h('input', { type: 'text', value: p.trigger.value ?? '', placeholder: p.trigger.kind === 'chat' ? 'word in chat, e.g. lol' : 'hotkey name', style: p.trigger.kind === 'chat' || p.trigger.kind === 'hotkey' ? '' : 'display:none' }) as HTMLInputElement;
    sel.addEventListener('change', () => c.edit(() => { const t = TRIG.find((x) => x.v === sel.value)!; p.trigger = { kind: t.kind, ...(t.value ? { value: t.value } : txt.value ? { value: txt.value } : {}), ...(p.trigger.burst ? { burst: p.trigger.burst } : {}) }; }));
    txt.addEventListener('change', () => c.edit(() => { p.trigger = { ...p.trigger, value: txt.value.slice(0, 60) }; }));
    out.push(card(c,
      h('div', { class: 'r2e-row', style: 'grid-template-columns:34px 1fr auto auto' }, h('img', { src: c.thumb(p.tex), alt: '', style: 'width:30px;height:30px;object-fit:contain;background:#8884;border-radius:6px' }), h('b', null, p.name),
        btn(c, 'Try', () => { c.fire(p.trigger.kind, p.trigger.value ?? ''); if (['always', 'voice'].includes(p.trigger.kind)) c.toast('This one plays by itself (always / while talking).'); }),
        h('label', null, check(c, p.on !== false, (v) => c.edit(() => { p.on = v; }), `${p.name} on`))),
      sel, txt,
      c.range(0.5, 40, 0.5, p.rate, (v) => { p.rate = v; }, 'How many', (v) => `${v.toFixed(1)} / s`, () => c.edit(() => {})),
      c.range(0.2, 3, 0.05, (p.size[0] + p.size[1]) / 2 / 16, (v) => { const k = v * 16 / ((p.size[0] + p.size[1]) / 2 || 1); p.size = [p.size[0] * k, p.size[1] * k]; }, 'Size', (v) => `${Math.round(v * 100)} %`, () => c.edit(() => {})),
      h('div', { class: 'r2e-btns' }, btn(c, 'Move', () => c.placeSlot('particle', p.id), '', 'Click on the avatar where it should start'), btn(c, 'Delete', () => c.edit(() => { X.particles = (X.particles ?? []).filter((x) => x !== p); })))));
  }
  out.push(h('h4', null, 'Props'), h('p', { class: 'r2e-dim' }, 'A picture pinned to your avatar: a hat, a held item, a badge. It moves with the part you pin it to.'),
    h('div', { class: 'r2e-btns' }, btn(c, '+ Add a prop picture', () => void (async () => {
      const png = await c.pickPng();
      if (!png) return;
      const tex = c.textures.length;
      c.textures.push({ w: png.w, h: png.h, rgba: png.rgba });
      const m = c.sel ? doc.meshes.find((x) => x.id === c.sel) : undefined, t = m ? doc.textures[m.tex] : null;
      const at = t ? [t.x + t.w / 2, t.y + t.h / 2] : [doc.canvas.w / 2, doc.canvas.h / 3];
      const v = nearestVertex(doc, at[0], at[1], m ? (x) => x.id === m.id : () => true);
      if (!v) return;
      const k = Math.min(1, (doc.canvas.w * 0.3) / Math.max(png.w, png.h));
      c.edit(() => {
        doc.textures.push({ name: `prop:${png.name}`, x: 0, y: 0, w: png.w, h: png.h, kind: 'sprite' });
        let id = `prop_${png.name}`.replace(/[^\w-]/g, '_').slice(0, 40); for (let i = 2; (X.attachments ?? []).some((a) => a.id === id); i++) id = `prop_${i}`;
        (X.attachments ??= []).push({ id, name: png.name, slot: v, tex, pivot: [0.5, 0.5], size: [png.w * k, png.h * k], on: true });
      }, true);
      c.texChanged();
      c.toast('Prop added. Use "Move" to pin it somewhere else, and the sliders to size and turn it.');
    })())));
  for (const a of X.attachments ?? []) {
    out.push(card(c,
      h('div', { class: 'r2e-row', style: 'grid-template-columns:34px 1fr auto' }, h('img', { src: c.thumb(a.tex), alt: '', style: 'width:30px;height:30px;object-fit:contain' }), h('b', null, a.name), h('label', null, check(c, a.on, (v) => c.edit(() => { a.on = v; }), `${a.name} shown`))),
      c.range(0.1, 3, 0.01, 1, (v) => { (a as { _s?: number[] })._s ??= a.size.slice(); const s0 = (a as { _s?: number[] })._s!; a.size = [s0[0] * v, s0[1] * v]; }, 'Size', (v) => `${Math.round(v * 100)} %`, () => c.edit(() => { delete (a as { _s?: number[] })._s; })),
      c.range(-180, 180, 1, a.angle ?? 0, (v) => { a.angle = v; }, 'Turn', (v) => `${Math.round(v)}°`, () => c.edit(() => {})),
      h('label', { class: 'r2e-field' }, h('span', null, 'Turns with it'), check(c, a.rotate !== false, (v) => c.edit(() => { a.rotate = v; }), 'Turns with the part')),
      h('div', { class: 'r2e-btns' }, btn(c, 'Move', () => c.placeSlot('attachment', a.id)), btn(c, 'Delete', () => c.edit(() => { X.attachments = (X.attachments ?? []).filter((x) => x !== a); for (const co of X.costumes ?? []) if (co.attachments) co.attachments = co.attachments.filter((x) => x !== a.id); })))));
  }
  return out;
}

// ================================================================ moods
export function moodsPanel(c: PanelCtx): Node[] {
  const { h, doc } = c;
  const exprName = (id: string) => doc.expressions.find((e) => e.id === id)?.name ?? id;
  const rules = readRules(doc);
  const out: Node[] = [h('p', { class: 'r2e-dim' }, 'Your avatar changes its face by itself: these rules say when. They run live on stream; hotkeys and expressions still work on top.')];
  out.push(card(c,
    h('label', { class: 'r2e-field' }, h('span', null, 'Talking face'), check(c, autoLayerOn(doc, 'auto_mood'), (v) => c.edit(() => setAutoLayer(doc, 'auto_mood', v, () => defaultMoods(doc))), 'Talking face and happy on happy chat')),
    h('p', { class: 'r2e-dim' }, 'A livelier face while you talk; happy when chat says "happy" or your face looks happy.'),
    h('label', { class: 'r2e-field' }, h('span', null, 'Blink by itself'), check(c, autoLayerOn(doc, 'auto_blink'), (v) => c.edit(() => setAutoLayer(doc, 'auto_blink', v, () => defaultMoods(doc))), 'Blink by itself')),
    h('p', { class: 'r2e-dim' }, 'Extra blinks every few seconds (your camera blinks still show).')));
  out.push(h('h4', null, 'My rules'));
  rules.forEach((r, i) => out.push(h('div', { class: 'r2e-row', style: 'grid-template-columns:1fr auto auto' }, h('span', null, ruleText(r, exprName)),
    btn(c, 'Try', () => { c.fire(r.on.kind, r.on.value ?? ''); c.toast(`"${exprName(r.expression)}" (live, this plays when the trigger happens).`); }),
    btn(c, 'Delete', () => c.edit(() => writeRules(doc, rules.filter((_, k) => k !== i)))))));
  if (!rules.length) out.push(h('p', { class: 'r2e-dim' }, 'No rules yet.'));
  // add a rule
  const kinds = h('select', { 'aria-label': 'When' }, ...(Object.keys(TRIGGER_LABEL) as TriggerKind[]).map((k) => h('option', { value: k }, TRIGGER_LABEL[k]))) as HTMLSelectElement;
  const value = h('select', { 'aria-label': 'Which' }) as HTMLSelectElement;
  const text = h('input', { type: 'text', placeholder: 'word, e.g. lol' }) as HTMLInputElement;
  const expr = h('select', { 'aria-label': 'Show' }, ...doc.expressions.map((e) => h('option', { value: e.id }, e.name))) as HTMLSelectElement;
  const hold = h('input', { type: 'number', min: '0.5', max: '60', step: '0.5', value: '3', style: 'width:70px', 'aria-label': 'Seconds' }) as HTMLInputElement;
  const sync = () => {
    const k = kinds.value as TriggerKind;
    value.replaceChildren(...(k === 'emotion' ? EMOTIONS : k === 'event' ? EVENTS : []).map((v) => h('option', { value: v }, v)));
    value.style.display = k === 'emotion' || k === 'event' ? '' : 'none';
    text.style.display = k === 'chat' || k === 'hotkey' ? '' : 'none';
    text.placeholder = k === 'chat' ? 'word, e.g. lol' : 'hotkey name';
  };
  kinds.addEventListener('change', sync); sync();
  out.push(card(c, h('p', null, h('b', null, 'Add a rule')), field(c, 'When', kinds), value, text, field(c, 'Show', expr), field(c, 'For (seconds)', hold),
    h('div', { class: 'r2e-btns' }, btn(c, 'Add', () => {
      const k = kinds.value as TriggerKind;
      if (!expr.value) { c.toast('Make an expression first (Expressions tab).', true); return; }
      const r: MoodRule = { on: { kind: k, ...(k === 'emotion' || k === 'event' ? { value: value.value } : k === 'chat' || k === 'hotkey' ? { value: text.value.trim() } : {}), ...(k === 'timer' ? { above: Number(hold.value) * 3 } : {}) }, expression: expr.value, hold: Number(hold.value) || 3 };
      c.edit(() => writeRules(doc, [...rules, r]));
      c.toast('Rule added.');
    }, 'primary'))));
  return out;
}

// ================================================================ outfits + angles
export function outfitsPanel(c: PanelCtx, reRig: (turn: number) => void): Node[] {
  const { h, doc } = c;
  const X = (doc.extras ??= {});
  const parts = X.parts ?? [];
  const out: Node[] = [h('p', { class: 'r2e-dim' }, 'Outfits and extras you can switch while live. Folders in your PSD named like "Outfits/Casual", "Hat" or "Glasses" become switches by themselves.')];
  for (const co of X.costumes ?? []) {
    const on = c.extras?.costumeOn.get(co.id) ?? co.on;
    out.push(h('div', { class: 'r2e-row', style: 'grid-template-columns:auto 1fr auto auto' },
      check(c, on, (v) => { if (co.group) for (const o of X.costumes ?? []) if (o.group === co.group) c.extras?.costumeOn.set(o.id, false); c.extras?.costumeOn.set(co.id, v); c.rerender(); }, `${co.name} on`),
      h('span', null, `${co.name}${co.group ? ` (${co.group})` : ''}`),
      btn(c, co.on ? 'Starts on' : 'Starts off', () => c.edit(() => { if (co.group && !co.on) for (const o of X.costumes ?? []) if (o.group === co.group) o.on = false; co.on = !co.on; })),
      btn(c, 'Delete', () => c.edit(() => { X.costumes = (X.costumes ?? []).filter((x) => x !== co); }))));
  }
  const m = c.sel ? doc.meshes.find((x) => x.id === c.sel) : undefined;
  const folder = m?.part ? parts.find((p) => p.id === m.part) : undefined;
  out.push(h('div', { class: 'r2e-btns' }, btn(c, folder ? `+ Make "${folder.name}" a switch` : '+ Make a switch (select a part in a folder first)', () => {
    if (!folder) { c.toast('Select a part that sits in a folder of your PSD first.'); return; }
    c.edit(() => { (X.costumes ??= []).push({ id: `costume_${folder.id}`.slice(0, 60), name: folder.name, parts: [folder.id], on: true }); });
  })));
  out.push(h('h4', null, 'Head turn'));
  if (X.views?.sets.length) {
    out.push(h('p', { class: 'r2e-dim' }, `Your PSD has ${X.views.sets.length} angles: they cross-fade as you turn your head.`));
    for (const s of X.views.sets) out.push(c.range(-30, 30, 1, s.at, (v) => { s.at = v; }, `${s.id} at`, (v) => `${Math.round(v)}°`, () => c.edit(() => {})));
    const V = X.views;
    out.push(c.range(0, 1, 0.05, Math.max(0, Math.min(1, ((V.blendBand ?? 2) - 0.5) / 7.5)), (v) => { V.blendBand = Math.round((0.5 + v * 7.5) * 10) / 10; V.hysteresis = Math.round((1 + v * 2) * 10) / 10; },
      'How quickly it switches between angles', (v) => (v < 0.2 ? 'snappy' : v > 0.7 ? 'smooth' : 'medium'), () => c.edit(() => {})));
  } else {
    out.push(h('p', { class: 'r2e-dim' }, 'Your front drawing turns in 2.5D (near parts move more than far ones). For true 3/4 and side views, add folders named "Front", "3/4" and "Side" to your PSD, each a full head drawing.'));
  }
  const turn = X.turn ?? 0.6;
  out.push(c.range(0.3, 1.2, 0.05, turn, () => {}, 'How far the head turns', (v) => `${Math.round(v * 100)} %`));
  const last = out[out.length - 1] as HTMLElement;
  last.querySelector('input')!.addEventListener('change', (e) => reRig(Number((e.target as HTMLInputElement).value)));
  return out;
}
