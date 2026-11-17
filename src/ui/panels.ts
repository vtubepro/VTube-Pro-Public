// Side-panel tabs.
import { builderNote } from '../../shared/createGate.ts';
import { runGateFix } from './gateFix.ts';
import { externalSection } from './externalPanel.ts';
import { blendCurvesSection } from './blendCurvesPanel.ts';
import { faceChainSection } from './faceChainPanel.ts';
import type { App } from '../app.ts';
import { TEST_EXPRESSIONS } from '../app.ts';
import { api, waitJob } from '../api.ts';
import type { AvatarProfile, JiggleRegion, Job, SurfaceMarker } from '../../shared/types.ts';
import { PREFERRED_CAMERA, PREFERRED_MIC, RESOLUTIONS, listCameras, listMics, preferred } from '../tracking/camera.ts';
import type { QualityTier } from '../tracking/Tracker.ts';
import { mouthStatusText } from '../tracking/mouthVisibility.ts';
import { guessSoftRig } from '../avatar/softRig.ts';
import { autoIrisGlow } from '../avatar/eyes.ts';
import { defaultProfile } from '../../shared/defaults.ts';
import { applyOpenState, button, cancelRerender, clear, color, debounce, h, holdScroll, rerender, scrollTarget, section, select, slider, toast, toggle, tut } from './dom.ts';
import { wardrobe } from './wardrobe.ts';
import { openHelperAi } from '../net/aiHelper.ts';
import { openNamed, studioNav } from './wizards.ts';
import { guidedSetupsCard, performanceCard, shortcutList, tagCard, type SettingsNav } from './settingsCards.ts';
import { lookFeelCard } from './simple.ts';
import { surfaceStyleSection } from './surfacePanel.ts';
import { scenePanel } from './scenePanel.ts';
import { voiceFilterControls } from './voiceFilter.ts';
import { trailSection } from './trailPanel.ts';
import { sizeSection } from './sizePanel.ts';
import { neckSection } from './neckPanel.ts';
import { skeletonSection } from './skeletonPanel.ts';
import { armsPicker } from './armsPanel.ts';
import { TRIS_MAX, TRIS_WARN, fmtTris } from '../../shared/modelStats.ts';
import { SIZE_ICON, avatarSize } from '../../shared/avatarSize.ts';
import { EMOTES } from '../avatar/emotes.ts';
import { naturalSection } from './naturalPanel.ts';
import { bulbDepthRange, clampEyeDepth, eyeDepthKind } from '../../shared/eyeDepth.ts';
import { CENTER_SCALE_DEFAULT, CENTER_SCALE_RANGE, PATCH_DEFAULTS, PATCH_SIZE_RANGE, effectiveLayout, sanitizeEyeLayout, type EyeLayout } from '../../shared/eyeLayout.ts';
import { saveEyesTracked, type EyesTracked } from '../tracking/oneEye.ts';
import { BAKED_COVER_RANGE, BAKED_DEFAULTS, BAKED_NUDGE_RANGE, sanitizeBakedEyes, type BakedEyesConfig } from '../../shared/bakedEyes.ts';
import { guessFaceMarkers } from '../avatar/faceGuess.ts';
import { eyeBoneMarkers } from '../avatar/bakedEyes.ts';
import { collectMeshes } from '../avatar/surfacePatch.ts';
import { SNACK_DEFAULTS } from '../tracking/snackController.ts';
import { TRACK_LOSS_DEFAULTS, TRACK_LOSS_LABEL, sanitizeTrackLoss, type TrackLossMode, type TrackLossPart, type TrackLossSettings } from '../../shared/trackLoss.ts';
import { TRACK_PART_TEXT } from '../../shared/trackParts.ts';
import { IDLE_ARM_DOWN_DEFAULT, IDLE_ARM_DOWN_MAX, IDLE_ARM_DOWN_MIN } from '../../shared/idleArm.ts';
import { IMPORT_ACCEPT } from '../../shared/importCheck.ts';
import { openImportDialog } from './importDialog.ts';
import { flatDrop, flatPanel, openFlatImport } from './flatPanel.ts';
import { expressionHint, expressionLabel, rigLabel } from './meWords.ts';
import { avatarCardMenu } from './avatarDelete.ts';   // ⋯ → Delete… on own avatar cards (avdelete lane)
import { editRigCardButton } from './rig2dEditRig.ts';   // "Edit rig" on 2D rig cards (rig2dtune lane)
import { avatarMakerButton, importModelButtonLazy } from './laneWiring.ts';
import { installModelWizardTestHook, openModelWizard } from './modelWizard.ts';
import { detailReadout } from '../avatar/lod/readout.ts';
import * as retargetModule from '../avatar/retarget.ts';

// the app's own new-profile values: what every slider's ↺ (reset to default) restores
const DP = defaultProfile('_', '_', '_');
const JIGGLE_DEF = { stiffness: 0.45, damping: 0.3, amount: 1 };
/** This browser's settings that other modules read at their own time (storage may be off: then they simply don't stick). */
const lsGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage off */ } };
/** 'Tracking processor' (localStorage vtp.trackDelegate): the tracker (src/tracking/delegatePolicy.ts) reads exactly
 *  'gpu' / 'cpu', anything else = Auto. An early build of this control wrote 'GPU' / 'CPU': read in any case and stored
 *  back in lower case, so the tracker sees the same choice the control shows. */
function trackDelegateSetting(): 'auto' | 'gpu' | 'cpu' | 'nogpu' {
  const v = lsGet('vtp.trackDelegate'), s = (v ?? '').toLowerCase();
  if (s !== 'gpu' && s !== 'cpu' && s !== 'nogpu') return 'auto';
  if (v !== s) lsSet('vtp.trackDelegate', s);
  return s;
}
const hwMemo = new WeakMap<object, Map<string, number>>();
const softMemo = new WeakMap<object, ReturnType<typeof guessSoftRig>>();
/** app.localHalfWidth (the auto-fit used when a marker is first placed), cached per loaded model + marker. */
function halfW(app: App, m: SurfaceMarker): number {
  const rt = app.runtime;
  if (!rt) return 0.1;
  let c = hwMemo.get(rt);
  if (!c) hwMemo.set(rt, (c = new Map()));
  const k = m.position.join(',');
  if (!c.has(k)) c.set(k, app.localHalfWidth(m));
  return c.get(k)!;
}

/** Eye depth (in / out along the face normal): bulb / inset eyes and model eye bones; painted eyes get a note. */
function eyeDepthControl(app: App): HTMLElement {
  const E = app.profile!.eyes, sup = app.runtime?.eyeDepth ?? null;
  const kind = eyeDepthKind(E.mode, E.style);
  if (kind === 'painted') return h('p', { class: 'note' }, 'Eye depth: painted eyes sit on the face surface. Pick the Bulb or Inset style to move eyes in / out.');
  const range = kind === 'bulb' ? bulbDepthRange(E.size, E.protrusion, E.style) : sup?.kind === 'bones' ? sup.range : null;
  if (!range) return h('p', { class: 'note' }, app.runtime ? 'Eye depth: this model’s eyes are part of its face (no eye bones), so there is nothing to move in / out.' : '');
  // ~200 steps across the range, on a 1 / 2 / 5 grid (0.1 mm for human-size eyes)
  const raw = (range[1] - range[0]) / 200, p10 = 10 ** Math.floor(Math.log10(raw));
  const step = +([1, 2, 5, 10].map((k) => k * p10).find((s) => s >= raw) ?? raw).toPrecision(1);
  return slider('Eye depth', clampEyeDepth(E.depth, range), range[0], range[1], step, (v) => {
    app.edit((q) => (q.eyes.depth = v), false);
    app.runtime?.setEyeDepth(v);
  }, 'Push the eyes into the face (−) or out of it (+), along the face normal. Limited so they never sink away or poke through the lids.', { def: 0, scale: 1000, unit: 'mm' });
}

/** Eye layout (both / one eye / cyclops) + the eye patch over a hidden eye (shared/eyeLayout.ts, src/avatar/eyePatch.ts). */
/** Painted eyes → tracked eyes (profile.eyes.replaceBaked, shared/bakedEyes.ts): the toggle, the erase area, the fit. */
function paintedEyesControls(app: App, rerender: () => void): HTMLElement[] {
  const E = app.profile!.eyes, rt = app.runtime;
  const RB = { ...BAKED_DEFAULTS, ...sanitizeBakedEyes(E.replaceBaked) };
  const on = RB.on && E.mode === 'procedural';
  // VRM eyes are real eye parts that already track: nothing painted to replace
  if (rt?.vrm && !on) return [];
  const set = (fn: (b: BakedEyesConfig) => void) => app.edit((q) => { const n = { ...BAKED_DEFAULTS, ...sanitizeBakedEyes(q.eyes.replaceBaked) }; fn(n); q.eyes.replaceBaked = n; });
  const out: HTMLElement[] = [
    toggle('Replace the model’s painted eyes (tracked eyes)', on, (v) => {
      if (!v) { set((b) => (b.on = false)); rerender(); return; }
      const wasModel = E.mode !== 'procedural';
      app.edit((q) => {
        q.eyes.replaceBaked = { ...BAKED_DEFAULTS, ...sanitizeBakedEyes(q.eyes.replaceBaked), on: true };
        if (wasModel) {
          // from the model's own eyes: generated anime eyes with highlights (the look painted eyes had)
          q.eyes.mode = 'procedural';
          if (q.eyes.style !== 'decal' && q.eyes.style !== 'anime') q.eyes.style = 'anime';
          q.eyes.highlight = true;
        }
        // no eye markers yet: the automatic first guess (the fit below then moves them onto the painted eyes)
        if (!q.eyes.left && !q.eyes.right && rt) {
          const ms = collectMeshes(rt.model);
          const g = eyeBoneMarkers(rt.model, ms, rt.anchor, { left: rt.humanoid?.getRawBoneNode('leftEye') ?? null, right: rt.humanoid?.getRawBoneNode('rightEye') ?? null })
            ?? guessFaceMarkers(rt.model, ms, rt.humanoid?.getRawBoneNode('head') ?? null, q.transform.yaw)?.eyes;
          if (g) Object.assign(q.eyes, { left: g.left, right: g.right, size: g.size });
        }
      });
      // once rebuilt: put the markers on the painted eyes, size + iris colour to match (once, on first turning on)
      const off = app.on((what) => { if (what !== 'avatar') return; off(); if (fitPainted(app, true)) toast('Found the painted eyes — the new eyes sit where they were. Fine-tune below.', 'info', 6000); });
      rerender();
    }, 'Erases the eyes painted into the model’s texture (in memory — the model file never changes) and draws eyes that follow your gaze, blinks and smiles'),
  ];
  if (!on) return out;
  const info = rt?.info.bakedEyes;
  out.push(
    slider('Cover size', RB.cover, BAKED_COVER_RANGE[0], BAKED_COVER_RANGE[1], 0.01, (v) => set((b) => (b.cover = v)), 'How much skin around each eye is repainted. Bigger if bits of the old eye still show', { def: 1, unit: '×' }),
    slider('Cover ↔', RB.nudge?.[0] ?? 0, BAKED_NUDGE_RANGE[0], BAKED_NUDGE_RANGE[1], 0.01, (v) => set((b) => (b.nudge = [v, b.nudge?.[1] ?? 0])), '+ = toward the outer corners (both eyes)', { def: 0 }),
    slider('Cover ↕', RB.nudge?.[1] ?? 0, BAKED_NUDGE_RANGE[0], BAKED_NUDGE_RANGE[1], 0.01, (v) => set((b) => (b.nudge = [b.nudge?.[0] ?? 0, v])), undefined, { def: 0 }),
    h('div', { class: 'btns tight' },
      button('Fit to the painted eyes', () => { if (fitPainted(app, false)) toast('Eyes moved onto the painted eyes.', 'info'); else toast('Couldn’t find painted eyes near the markers — place them by hand.', 'warn'); }),
      button('Blink', () => app.preview('Blink')), button('Smile', () => app.preview('Big grin')),
    ),
  );
  if (info) out.push(h('p', { class: 'note' }, info.textures || info.skinnedMeshes || info.hiddenMeshes
    ? `Repainted ${info.textures} texture${info.textures === 1 ? '' : 's'}${info.hiddenMeshes ? `, hid ${info.hiddenMeshes} eye part${info.hiddenMeshes === 1 ? '' : 's'}` : ''}${info.skinnedMeshes ? `, turned ${info.skinnedMeshes} eyeball${info.skinnedMeshes === 1 ? '' : 's'} into skin` : ''} (${info.ms} ms).`
    : 'Nothing painted found near the eye markers.'));
  return out;
}

/** Move the eye markers onto the painted eyes the runtime found (+ size, + the painted iris colour on first use). */
function fitPainted(app: App, first: boolean): boolean {
  const f = app.runtime?.bakedFit;
  if (!f || (!f.left && !f.right)) return false;
  app.edit((q) => {
    if (f.left && q.eyes.left) q.eyes.left = { ...q.eyes.left, position: f.left };
    if (f.right && q.eyes.right) q.eyes.right = { ...q.eyes.right, position: f.right };
    if (f.size > 0) q.eyes.size = f.size;
    if (first && f.iris) q.eyes.irisColor = f.iris;
  });
  return true;
}

function eyeLayoutControls(app: App, rerender: () => void): HTMLElement[] {
  const E = app.profile!.eyes, rt = app.runtime;
  const chosen: EyeLayout = sanitizeEyeLayout(E.layout) ?? 'both';
  const gen = E.mode === 'procedural';
  const out: HTMLElement[] = [
    select('Eyes', chosen, [['both', 'Both eyes'], ['left', 'Left eye only (right one hidden)'], ['right', 'Right eye only (left one hidden)'],
      ['center', gen ? 'One centre eye (cyclops)' : 'One centre eye (generated eyes only)']],
      (v) => { app.edit((q) => { if (v === 'both') delete q.eyes.layout; else q.eyes.layout = v; }); rerender(); },
      'For characters with an eye patch, a lost eye or a single cyclops eye. Left / right = the character’s own side.'),
  ];
  const note = (s: string) => out.push(h('p', { class: 'note' }, s));
  const layout = effectiveLayout(chosen, E.mode === 'none' ? 'model' : E.mode);
  if (chosen === 'center' && !gen) note('A centre eye needs generated eyes: set Source to “Generate eyes”, place both eye markers, then pick One centre eye. Until then both eyes show.');
  if (layout === 'center') {
    if (!E.left || !E.right) note('Place both eye markers: the centre eye sits on the face midway between them.');
    out.push(slider('Centre eye size', E.centerScale ?? CENTER_SCALE_DEFAULT, CENTER_SCALE_RANGE[0], CENTER_SCALE_RANGE[1], 0.01,
      (v) => app.edit((q) => (q.eyes.centerScale = v)), 'The cyclops eye’s size, × the eye Size below', { def: CENTER_SCALE_DEFAULT, unit: '×' }));
  }
  if (layout !== 'left' && layout !== 'right') return out;
  const hide = layout === 'left' ? 'right' : 'left';
  // what could be done with the hidden eye on this model
  if (gen) note(`The ${hide} eye isn’t drawn.`);
  else if (E.mode === 'model' && rt) {
    const keys = rt.expressions?.arkitKeys() ?? new Set<string>();
    const oneSided = keys.has('eyeBlinkLeft') !== keys.has('eyeBlinkRight');
    const info = rt.eyeLayout?.info;
    if (oneSided) note('This model already has only one working eye — the other is painted into its face texture (e.g. Aosabi’s eye patch). The eye patch below can still cover it.');
    else if (!rt.expressions?.hasBlink && !info?.hiddenBones && !info?.hiddenMeshes)
      note(`This model’s eyes are painted into its face texture, so the ${hide} eye can’t be hidden — turn on the eye patch below to cover it.`);
    else note(`The ${hide} eye is kept shut${info?.hiddenBones ? ' and its eyeball tucked away behind the lid' : ''}${info?.hiddenMeshes ? ' (its eye mesh is hidden)' : ''}. Add the eye patch to cover it.`);
  }
  const Pt = { ...PATCH_DEFAULTS, ...E.patch };
  const patch = (fn: (p: typeof Pt) => void) => app.edit((q) => { const n = { ...PATCH_DEFAULTS, ...q.eyes.patch }; fn(n); q.eyes.patch = n; });
  out.push(toggle('Eye patch', Pt.enabled, (v) => { patch((p) => (p.enabled = v)); rerender(); }, `A leather patch (and strap) over the hidden ${hide} eye`));
  if (Pt.enabled) {
    out.push(
      color('Patch colour', Pt.color, (v) => patch((p) => (p.color = v))),
      toggle('Strap', Pt.strap, (v) => patch((p) => (p.strap = v)), 'The band around the head'),
      slider('Patch size', Pt.size ?? 1, PATCH_SIZE_RANGE[0], PATCH_SIZE_RANGE[1], 0.01, (v) => patch((p) => (p.size = v)), undefined, { def: 1, unit: '×' }),
    );
    if (rt?.eyeLayout && !rt.eyeLayout.patch && rt.eyeLayout.info.warning) note(rt.eyeLayout.info.warning);
  }
  return out;
}

/** Track: which of the performer's eyes the camera should read (eye patch / one eye), + the auto-suggestion. */
function eyesTrackedSection(app: App, rerender: () => void): HTMLElement {
  const f = app.face;
  const set = (v: EyesTracked) => { f.eyesTracked = v; saveEyesTracked(v); f.oneEye.reset(); rerender(); };
  const sug = f.eyesTracked === 'both' ? f.oneEye.suggestion : null;
  return section('Eyes tracked',
    select('Eyes tracked', f.eyesTracked, [['both', 'Both eyes'], ['left', 'Only my left eye (right one covered)'], ['right', 'Only my right eye (left one covered)']], set,
      'Wear an eye patch or have one eye? The visible eye then drives BOTH avatar eyes: blinks, squints, wide eyes and gaze. The covered eye can never fake a wink.'),
    sug ? h('div', { class: 'note' }, `Your ${sug === 'left' ? 'right' : 'left'} eye looks covered. `, button(`Track only my ${sug} eye`, () => set(sug), 'primary')) : '',
    h('p', { class: 'note' }, f.eyesTracked === 'both'
      ? 'Left / right = your own side. It is suggested automatically when one eye stays hidden.'
      : 'Recalibrate neutral (Calibration above) once with the patch on: calibration and natural mode then learn from your visible eye only.'),
  );
}

export type TabId = 'avatars' | 'wardrobe' | 'face' | 'tracking' | 'body' | 'create' | 'scene' | 'output' | 'settings'
  // the studio areas split the Scene tab (src/ui/shell.ts): Room = 'scene', Show & layout, Chat & events, OBS automation
  | 'show' | 'chatev' | 'obs';

export const TABS: { id: TabId; icon: string; label: string }[] = [
  { id: 'avatars', icon: '☺', label: 'Avatars' },
  { id: 'wardrobe', icon: '👕', label: 'Wardrobe' },
  { id: 'face', icon: '◉', label: 'Face' },
  { id: 'tracking', icon: '◎', label: 'Track' },
  { id: 'body', icon: '✦', label: 'Body' },
  { id: 'create', icon: '✚', label: 'Create' },
  { id: 'scene', icon: '▣', label: 'Scene' },
  { id: 'output', icon: '▶', label: 'OBS' },
  { id: 'settings', icon: '⚙', label: 'Setup' },
];

// Where each tab was scrolled to (survives re-renders, tab switches and page reloads).
const SCROLL_KEY = 'vtp.ui.scroll';
const tabScroll: Record<string, number> = (() => { try { const v = JSON.parse(localStorage.getItem(SCROLL_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } })();
const saveTabScroll = debounce(() => { try { localStorage.setItem(SCROLL_KEY, JSON.stringify(tabScroll)); } catch { /* storage off */ } }, 400);
const scrollWatched = new WeakSet<HTMLElement>();
// a tab just shown wants its old scroll position back, even if its content arrives late (avatar still
// loading at boot, library fetch…) — until reached or the user scrolls / clicks in the panel themselves
let want: { tab: string; top: number } | null = null;

/** Show `tab` in `el`. Re-rendering the tab that is already showing keeps the user's place (scroll, focus,
 *  open sections) and leaves the DOM alone when nothing visible changed — see rerender() in dom.ts. */
export function renderPanel(app: App, tab: TabId, el: HTMLElement) {
  app.showGizmos = tab === 'face' || tab === 'body';
  app.drawGizmos();
  const r = { avatars, wardrobe, face, tracking, body, create, scene: (a: App, e: HTMLElement) => scenePanel(a, e, 'room'), output, settings,
    show: (a: App, e: HTMLElement) => scenePanel(a, e, 'show'), chatev: (a: App, e: HTMLElement) => scenePanel(a, e, 'chat'), obs: (a: App, e: HTMLElement) => scenePanel(a, e, 'stream') }[tab] ?? avatars;
  if (!scrollWatched.has(el)) {
    scrollWatched.add(el);
    el.addEventListener('scroll', () => {
      const t = el.dataset.ui;
      if (!t) return;
      if (want && want.tab === t) { if (Math.abs(el.scrollTop - want.top) > 1) return; want = null; }
      tabScroll[t] = Math.round(scrollTarget(el)); saveTabScroll();
    }, { passive: true });
    const mine = () => { want = null; };
    for (const ev of ['wheel', 'pointerdown', 'keydown', 'touchstart']) el.addEventListener(ev, mine, { passive: true });
  }
  if (el.dataset.ui === tab) {
    rerender(el, () => r(app, el));
    if (want?.tab === tab) holdScroll(el, want.top);
    return;
  }
  // tab switch: remember where the old tab was, bring the new one back to where the user left it
  if (el.dataset.ui && want?.tab !== el.dataset.ui) { tabScroll[el.dataset.ui] = Math.round(scrollTarget(el)); saveTabScroll(); }
  cancelRerender(el);
  clear(el);
  el.dataset.ui = tab;
  r(app, el);
  applyOpenState(el);
  want = { tab, top: tabScroll[tab] ?? 0 };
  holdScroll(el, want.top);
}

/** Re-render `tab` if it is still the one showing in `el` (async callbacks can land after a tab switch). */
function refresh(app: App, tab: TabId, el: HTMLElement) { if (el.dataset.ui === tab) renderPanel(app, tab, el); }

const needAvatar = (app: App, el: HTMLElement) => {
  if (app.profile) return false;
  el.append(h('p', { class: 'note' }, 'Load or create an avatar first (Me → Advanced → Avatars).'));
  return true;
};

// ---------------------------------------------------------------- Avatars
const lib: { list: AvatarProfile[] | null; sig: string; stamp: number } = { list: null, sig: '', stamp: Date.now() };
/** Library changed (import / delete / new thumbnail): re-fetch thumbnails on the next render. */
export function invalidateLibrary() { lib.stamp = Date.now(); lib.sig = ''; }

function avatars(app: App, el: HTMLElement) {
  el.append(h('h2', null, 'Avatars'));
  const file = h('input', { type: 'file', accept: IMPORT_ACCEPT, style: 'display:none' });
  const drop = h('div', { class: 'drop' }, h('b', null, 'Import a model'), h('br'), 'Drop any 3D model (.vrm .glb .fbx .obj .blend …) here, or click — its rigging is checked');
  // the import dialog (src/ui/importDialog.ts): rigging notice → upload → per-item check → Re-rig with Blender / face setup / use as is
  const doImport = (f: File) => /\.(png|apng|gif|webp|jpe?g|zip)$/i.test(f.name) ? openFlatImport(app, [f]) : openImportDialog(app, f, { onDone: () => app.emit('library'), openFace: () => renderPanel(app, 'face', el) });
  drop.onclick = () => file.click();
  file.onchange = () => { if (file.files?.[0]) void doImport(file.files[0]); };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); void flatDrop(e, app, (f) => void doImport(f)); };   // (pictures / a folder of them → 2D avatar: src/ui/flatPanel.ts)
  // "Add my model" (src/ui/modelWizard.ts): the guided check + set-up; the drop zone below is the quick import
  installModelWizardTestHook(app); // observer pages only (window.vtpModelWizardTest)
  el.append(h('div', { class: 'btns', style: 'margin-bottom:8px' }, importModelButtonLazy(app, 'Add my model…', () => app.emit('library')), button('Add my model (guided)…', () => openModelWizard(app, { onDone: () => app.emit('library') })), avatarMakerButton(app)), drop, file);   // (beta.12: src/ui/laneWiring.ts)
  // Rig a 3D model: the skeleton tools live in Body & physics (shown for an imported / unrigged model); say so where people import
  el.append(h('p', { class: 'note', 'data-cg': 'rig-pointer' }, 'Rig a 3D model (a person, an animal, an object): import it here, wear it, then open ', h('a', { href: '#', onClick: (e: Event) => { e.preventDefault(); renderPanel(app, 'body', el); } }, 'Body & physics → Re-rig this model'), '.'));
  el.append(flatPanel(app));   // 2D avatars (PNG / GIF, plug-in kinds) + 2D rooms: src/ui/flatPanel.ts
  const grid = h('div', { class: 'grid' });
  el.append(grid);
  // last list shown immediately (no "Loading…" jump on re-render), refreshed from the server
  const fill = (list: AvatarProfile[]) => {
    clear(grid);
    if (!list.length) grid.append(h('p', { class: 'note' }, 'No avatars yet — click “Add my model” or use Create.'));
    for (const p of list) {
      const thumb = p.thumbnail ? h('img', { src: `${api.fileUrl(p, p.thumbnail)}?t=${lib.stamp}` }) : h('div', { class: 'ph' }, '☺');
      const del = avatarCardMenu(app, p);   // ⋯ → Delete… (type CONFIRM, Undo): src/ui/avatarDelete.ts
      // polycount (server-counted from the file) + size class: too detailed for parties = red
      const tris = p.modelStats?.tris;
      const sz = avatarSize(p);
      const polys = tris ? h('span', { style: tris > TRIS_MAX ? 'color:#f5a45b' : tris > TRIS_WARN ? 'color:#f5c451' : '', title: tris > TRIS_MAX ? `${fmtTris(tris)} triangles — over the party limit (${fmtTris(TRIS_MAX)}): parties get an automatic party version` : `${fmtTris(tris)} triangles` }, ` · ${fmtTris(tris)} tris`) : null;
      grid.append(h('div', { class: `card ${app.profile?.id === p.id ? 'on' : ''}`, onClick: () => app.loadAvatar(p.id) },
        thumb, del, editRigCardButton(app, p), h('div', { class: 'meta' }, p.name, h('small', null, `${sz.auto ? '' : SIZE_ICON[sz.cls] + ' '}${p.source}${p.rig?.kind && p.rig.kind !== 'none' ? ' · ' + p.rig.kind : ''}`, polys))));
    }
  };
  if (lib.list) fill(lib.list); else grid.append(h('p', { class: 'note' }, 'Loading library…'));
  void api.avatars().then((list) => {
    const sig = JSON.stringify(list);
    if (sig === lib.sig && lib.list) return;
    const had = !!lib.list;
    lib.list = list; lib.sig = sig;
    if (!had) lib.stamp = Date.now();
    if (grid.isConnected) fill(list);
    else if (el.isConnected && el.dataset.ui === 'avatars') renderPanel(app, 'avatars', el); // this build was dropped as unchanged
  }).catch((e) => { if (!lib.list) { clear(grid); grid.append(h('p', { class: 'note' }, `Server offline? ${(e as Error).message}`)); } });

  if (app.runtime) {
    const i = app.runtime.info;
    el.append(section('Loaded model',
      h('p', { class: 'note' }, `Rig: `, h('b', null, rigLabel(i.rig)), ` · ${i.triangles.toLocaleString()} tris · ${i.meshes} meshes · ${i.bones} bones · ${i.springJoints} spring joints`),
      h('p', { class: 'note' }, `Own face shapes: ${i.expressions.arkit} ARKit, ${i.expressions.named.join(', ') || 'no presets'}${i.expressions.vrm ? ' (VRM)' : ''}`),
      detailNote(app),
      ...i.warnings.map((w) => h('p', { class: 'note', style: 'color:var(--warn)' }, '⚠ ' + w)),
      transformControls(app),
    ));
    el.append(sizeSection(app, () => refresh(app, 'avatars', el)));
  }
}

/** Avatar detail readout (Room -> Advanced -> Graphics quality -> Avatar detail) for THIS studio view's avatar: every OBS
 *  source picks its own level for its own camera (its ?diag=1 overlay shows it). Updates itself while it is on screen.
 *  The text (src/avatar/lod/readout.ts) says in every state when textures are still the smaller ones from the load. */
function detailNote(app: App): HTMLElement {
  const el = h('p', { class: 'note' });
  const text = () => detailReadout(app.runtime?.detail?.info());
  el.textContent = text();
  const t = window.setInterval(() => { if (!el.isConnected) { clearInterval(t); return; } const s = text(); if (el.textContent !== s) el.textContent = s; }, 1000);
  return el;
}

function transformControls(app: App) {
  const p = app.profile!;
  return h('div', null,
    slider('Scale', p.transform.scale, 0.1, 5, 0.01, (v) => { app.edit((q) => (q.transform.scale = v), false); applyTransform(app); }, undefined, { def: DP.transform.scale, unit: '×', hard: [0.01, 50] }),
    slider('Turn (yaw°)', p.transform.yaw, -180, 180, 1, (v) => { app.edit((q) => (q.transform.yaw = v), false); applyTransform(app); }, undefined, { def: DP.transform.yaw }),
    slider('Raise', p.transform.offset[1], -1, 1, 0.005, (v) => { app.edit((q) => (q.transform.offset[1] = v), false); applyTransform(app); }, undefined, { def: DP.transform.offset[1], unit: 'm', hard: [-5, 5] }),
    h('p', { class: 'note' }, 'Model facing away? Set Turn to 180. Marker placement uses the model’s own space, so these never break your face setup.'),
  );
}
function applyTransform(app: App) {
  const rt = app.runtime, p = app.profile;
  if (!rt || !p) return;
  rt.wrapper.scale.setScalar(p.transform.scale);
  rt.wrapper.position.set(...p.transform.offset);
  rt.wrapper.rotation.y = (p.transform.yaw * Math.PI) / 180;
  app.rebuild(); // eyes/mouth frames depend on facing
}

// ---------------------------------------------------------------- Face
function face(app: App, el: HTMLElement) {
  el.append(h('h2', null, 'Face'));
  if (needAvatar(app, el)) return;
  const p = app.profile!;
  const mirrorKey = 'vtp.mirrorEyes';
  let mirror = localStorage.getItem(mirrorKey) !== '0';
  const rerender = () => refresh(app, 'face', el);

  const placeBtn = (label: string, kind: 'eyeL' | 'eyeR' | 'mouth', done: (m: SurfaceMarker) => void) =>
    button(app.placing?.kind === kind ? 'Click the model… (Esc)' : label, () => {
      if (app.placing) { app.cancelPlace(); rerender(); return; }
      app.place(kind, (m) => { done(m); rerender(); });
      rerender();
    }, app.placing?.kind === kind ? 'active' : '');

  // --- expression preview ---
  el.append(section('Test expressions',
    h('div', { class: 'btns tight' }, ...Object.keys(TEST_EXPRESSIONS).map((n) => { const b = button(expressionLabel(n), () => app.preview(n)); const tip = expressionHint(n); if (tip) b.title = tip; return b; })),
    h('p', { class: 'note' }, 'Preview without a camera. Keys ', h('span', { class: 'kbd' }, '1'), '–', h('span', { class: 'kbd' }, '9'), ' also work.'),
  ));

  // --- eyes ---
  const E = p.eyes;
  const eyeSec = section('Eyes',
    select('Source', E.mode, [['procedural', 'Generate eyes (any model)'], ['model', "Model's own eyes"], ['none', 'None']], (v) => { app.edit((q) => { q.eyes.mode = v; q.eyes.picked = true; }); rerender(); }),
  );
  if (E.mode !== 'none') eyeSec.append(...paintedEyesControls(app, rerender));
  eyeSec.append(...eyeLayoutControls(app, rerender));
  if (E.mode === 'model') eyeSec.append(eyeDepthControl(app));
  if (E.mode === 'procedural') {
    eyeSec.append(
      select('Style', E.style, [['bulb', 'Bulb — sits on the surface (frogs, critters)'], ['inset', 'Inset — set into the head'], ['decal', 'Painted — flat cartoon/anime'], ['anime', 'Anime — gacha-style (winged lashes, glowing iris)'], ['led', 'LED screen — glowing robot eyes']], (v) => { app.edit((q) => (q.eyes.style = v)); rerender(); }),
      h('div', { class: 'btns' },
        placeBtn(E.left ? 'Move left eye' : 'Place left eye', 'eyeL', (m) => app.edit((q) => {
          q.eyes.left = m;
          if (mirror) q.eyes.right = app.mirrorMarker(m);
          if (!E.left) q.eyes.size = +(app.localHalfWidth(m) * 0.22).toFixed(4);
        })),
        placeBtn(E.right ? 'Move right eye' : 'Place right eye', 'eyeR', (m) => app.edit((q) => { q.eyes.right = m; })),
      ),
      toggle('Mirror left → right', mirror, (v) => { mirror = v; localStorage.setItem(mirrorKey, v ? '1' : '0'); }, 'Placing the left eye auto-places the right one symmetrically'),
      h('p', { class: 'note' }, '“Left” = the character’s own left (on screen right). Eyes can go anywhere — on top of the head for frogs, one eye for a cyclops.'),
      slider('Size', E.size, 0.005, 0.4, 0.001, (v) => app.edit((q) => (q.eyes.size = v)), 'Eye radius (model units). ↺ = the auto size fitted to the head when the eye was placed', { def: E.left ? +(halfW(app, E.left) * 0.22).toFixed(4) : DP.eyes.size, hard: [0.001, 1] }),
      slider('Protrusion', E.protrusion, 0, 1, 0.01, (v) => app.edit((q) => (q.eyes.protrusion = v)), 'How much of the eyeball sticks out of the surface', { def: DP.eyes.protrusion }),
      eyeDepthControl(app),
      slider('Iris size', E.irisSize, 0.1, 0.9, 0.01, (v) => app.edit((q) => (q.eyes.irisSize = v)), undefined, { def: DP.eyes.irisSize }),
      slider('Pupil size', E.pupilSize, 0.1, 1, 0.01, (v) => app.edit((q) => (q.eyes.pupilSize = v)), undefined, { def: DP.eyes.pupilSize }),
      slider('Rest openness', E.restOpen, 0.2, 1, 0.01, (v) => app.edit((q) => (q.eyes.restOpen = v)), 'Lower = sleepy / unimpressed look at rest', { def: DP.eyes.restOpen }),
      slider('Resting scowl', E.restAngry ?? 0, 0, 1, 0.01, (v) => app.edit((q) => (q.eyes.restAngry = v)), 'Angry lid tilt at rest for grumpy characters (surprise / smiles release it)', { def: 0 }),
      slider('Gaze range°', E.gazeRange, 0, 45, 1, (v) => app.edit((q) => (q.eyes.gazeRange = v), false), undefined, { def: DP.eyes.gazeRange }),
      color('Iris', E.irisColor, (v) => app.edit((q) => (q.eyes.irisColor = v))),
      color('Sclera', E.scleraColor, (v) => app.edit((q) => (q.eyes.scleraColor = v))),
      // (painted-eye replacement: auto = the skin measured around each eye; the lid keeps the face's shading)
      color(E.lidColor ? 'Eyelid' : 'Eyelid (auto)', E.lidColor ?? app.runtime?.eyes?.autoLid.find(Boolean) ?? '#7fb05a', (v) => app.edit((q) => (q.eyes.lidColor = v))),
      h('div', { class: 'btns tight' }, button('Eyelid = skin (auto)', () => { app.edit((q) => (q.eyes.lidColor = null)); rerender(); })),
      toggle('Outline', E.outline, (v) => app.edit((q) => (q.eyes.outline = v))),
      toggle('Highlights', E.highlight, (v) => app.edit((q) => (q.eyes.highlight = v))),
    );
    if (E.style === 'anime') eyeSec.append(
      h('h3', null, 'Anime eyes'),
      select('Pupil', E.pupilShape ?? 'star', [['star', 'Star ✦'], ['round', 'Round'], ['heart', 'Heart'], ['slit', 'Slit (cat)']], (v) => app.edit((q) => (q.eyes.pupilShape = v))),
      color('Iris glow (bottom)', E.irisColor2 || autoIrisGlow(E.irisColor), (v) => app.edit((q) => (q.eyes.irisColor2 = v))),
      h('div', { class: 'btns tight' }, button('Iris glow = auto', () => { app.edit((q) => (q.eyes.irisColor2 = null)); rerender(); })),
      color('Lashes', E.lashColor ?? '#1b1116', (v) => app.edit((q) => (q.eyes.lashColor = v))),
      slider('Lash wing', E.lashWing ?? 0.7, 0, 1, 0.01, (v) => app.edit((q) => (q.eyes.lashWing = v)), 'Winged flick + lash spikes at the outer corner', { def: 0.7 }),
      slider('Lash thickness', E.lashThickness ?? 1, 0.3, 2, 0.01, (v) => app.edit((q) => (q.eyes.lashThickness = v)), undefined, { def: 1, unit: '×' }),
      slider('Lower lashes', E.lowerLash ?? 0.7, 0, 1, 0.01, (v) => app.edit((q) => (q.eyes.lowerLash = v)), 'Lower lash accent on the outer third', { def: 0.7 }),
    );
    // --- blush (conforming cheek decals, placed from the eye + mouth markers) ---
    const Bl = p.blush ?? defaultProfile('_', '_', '_').blush!;
    const blush = (fn: (b: NonNullable<AvatarProfile['blush']>) => void, rebuild = true) => app.edit((q) => { q.blush = { ...Bl, ...q.blush }; fn(q.blush); }, rebuild);
    eyeSec.append(
      h('h3', null, 'Blush'),
      toggle('Cheek blush', Bl.enabled, (v) => { blush((b) => (b.enabled = v)); rerender(); }, 'Pink cheeks that deepen when you smile'),
    );
    if (Bl.enabled) eyeSec.append(
      color('Blush colour', Bl.color, (v) => blush((b) => (b.color = v))),
      slider('Blush at rest', Bl.rest, 0, 1, 0.01, (v) => blush((b) => (b.rest = v)), 'Smiles / happy / cheek squint add to this', { def: DP.blush!.rest }),
      slider('Blush size', Bl.size ?? 1.1, 0.4, 2.5, 0.01, (v) => blush((b) => (b.size = v)), undefined, { def: 1.1, unit: '×', hard: [0.2, 4] }),
      toggle('Hatch lines', Bl.hatch, (v) => blush((b) => (b.hatch = v)), 'Diagonal anime blush strokes'),
    );
  }
  el.append(eyeSec);

  // --- mouth ---
  const M = p.mouth;
  const mouthSec = section('Mouth',
    select('Source', M.mode, [['procedural', 'Generate mouth (any model)'], ['model', "Model's own mouth"], ['none', 'None']], (v) => { app.edit((q) => { q.mouth.mode = v; q.mouth.picked = true; }); rerender(); }),
  );
  // physical mouth (jaw / puppet bones): choose whether speech shows as jaw MOTION or as LIGHT
  const rt0 = app.runtime;
  if (rt0?.jawRig) {
    const rig = M.rig ?? rt0.jawRig.cfg;
    mouthSec.append(h('p', { class: 'note' }, rig.kind === 'puppet' ? `Puppet mouth: '${rig.upperBone}' tips back, '${rig.jawBone}' drops.` : `Hinged jaw on bone '${rig.jawBone}'.`));
    if (rt0.hasVoiceGlow)
      mouthSec.append(select('Speech shows as', rig.drive ?? 'motion', [['motion', 'Jaw moves (lights stay steady)'], ['light', 'Lights pulse with the voice (jaw stays shut)']],
        (v) => app.edit((q) => { q.mouth.rig = { ...rig, drive: v as 'motion' | 'light' }; }, false), 'One or the other: a moving jaw, or the speaker grille / chest light pulsing to your voice'));
    else mouthSec.append(slider('Jaw opening', rig.openAngle, 2, 45, 0.5, (v) => app.edit((q) => { q.mouth.rig = { ...rig, openAngle: v }; }), undefined, { def: rig.kind === 'puppet' ? 10 : 20, unit: '°' }));
  }
  // mouth sizes' defaults = the auto fit applied when the mouth marker is first placed (see placeBtn below)
  const mouthDef = (k: number, d: number) => (M.center ? +(halfW(app, M.center) * k).toFixed(4) : d);
  if (M.mode === 'procedural') {
    mouthSec.append(
      select('Style', M.style, [['cavity', 'Sculpted — skin moves with the jaw'], ['3d', 'Carved — real depth inside, flat anime teeth (heavier)'], ['toon', 'Drawn — flat cartoon mouth']], (v) => app.edit((q) => (q.mouth.style = v))),
      h('div', { class: 'btns' }, placeBtn(M.center ? 'Move mouth' : 'Place mouth', 'mouth', (m) => app.edit((q) => {
        q.mouth.center = m;
        if (!M.center) {
          const hw = app.localHalfWidth(m);
          q.mouth.width = +(hw * 0.38).toFixed(4); q.mouth.openHeight = +(hw * 0.3).toFixed(4);
          q.mouth.influence = +(hw * 0.75).toFixed(4); q.mouth.lineWidth = +(hw * 0.02).toFixed(4);
        }
      }))),
      h('p', { class: 'note' }, 'Click the centre of where the mouth should be. It is drawn onto the surface and animated from your real mouth every frame.'),
      slider('Width', M.width, 0.005, 0.5, 0.001, (v) => app.edit((q) => (q.mouth.width = v)), 'Model units. ↺ = the auto fit from when the mouth was placed', { def: mouthDef(0.38, DP.mouth.width), hard: [0.001, 1] }),
      slider('Open height', M.openHeight, 0.002, 0.4, 0.001, (v) => app.edit((q) => (q.mouth.openHeight = v)), undefined, { def: mouthDef(0.3, DP.mouth.openHeight), hard: [0.001, 1] }),
      slider('Jaw influence', M.influence, 0.01, 0.8, 0.005, (v) => app.edit((q) => (q.mouth.influence = v)), 'Radius of skin that moves with the jaw / cheeks', { def: mouthDef(0.75, DP.mouth.influence), hard: [0.005, 1.5] }),
      slider('Line width', M.lineWidth, 0.0005, 0.03, 0.0005, (v) => app.edit((q) => (q.mouth.lineWidth = v)), undefined, { def: mouthDef(0.02, DP.mouth.lineWidth) }),
      slider('Rest curve', M.restCurve, -1, 1, 0.01, (v) => app.edit((q) => (q.mouth.restCurve = v)), '−1 frown … +1 smile at rest', { def: DP.mouth.restCurve }),
      color('Lip line', M.lipColor, (v) => app.edit((q) => (q.mouth.lipColor = v))),
      color('Inside', M.interiorColor, (v) => app.edit((q) => (q.mouth.interiorColor = v))),
      color('Tongue', M.tongueColor, (v) => app.edit((q) => (q.mouth.tongueColor = v))),
      toggle('Teeth', M.showTeeth, (v) => app.edit((q) => (q.mouth.showTeeth = v))),
      toggle('Tongue', M.showTongue, (v) => app.edit((q) => (q.mouth.showTongue = v))),
    );
  }
  el.append(mouthSec);

  // --- surface look (non-VRM models) ---
  if (app.runtime && !app.runtime.vrm) {
    const L = p.look ?? defaultProfile('_', '_', '_').look!;
    const look = (fn: (l: NonNullable<AvatarProfile['look']>) => void, rebuild: boolean) => app.edit((q) => {
      q.look = { ...L, ...q.look };
      fn(q.look);
      if (!rebuild) app.runtime?.setLook(q.look);
    }, rebuild);
    const lookSec = section('Look',
      select('Shading', L.shading, [['anime', 'Anime — colour-tinted cel shadows + rim light'], ['classic', 'Classic — grey toon ramp']], (v) => { look((l) => (l.shading = v), true); rerender(); }),
    );
    if (L.shading === 'anime') lookSec.append(
      color('Shadow tint', L.shadowTint, (v) => look((l) => (l.shadowTint = v), false)),
      slider('Rim light', L.rim, 0, 1, 0.01, (v) => look((l) => (l.rim = v), false), undefined, { def: DP.look!.rim }),
      slider('Shadow softness', L.softness, 0, 1, 0.01, (v) => look((l) => (l.softness = v), false), undefined, { def: DP.look!.softness }),
      slider('Hair shine', L.hairShine, 0, 1, 0.01, (v) => look((l) => (l.hairShine = v), false), 'Angel-ring highlight on meshes/materials named hair / bangs / fringe / ponytail / twintail', { def: DP.look!.hairShine }),
      toggle('Nose highlight', L.noseHighlight ?? p.eyes.style === 'anime', (v) => look((l) => (l.noseHighlight = v), true), 'Small highlight dot on the nose (needs both eyes + the mouth placed)'),
    );
    el.append(lookSec);
    el.append(surfaceStyleSection(app, p, rerender));
  } else if (app.runtime?.vrm) {
    // VRM / VRoid: the model brings its own MToon look; only its brightness under the studio lights
    const L = p.look ?? defaultProfile('_', '_', '_').look!;
    el.append(section('Look',
      slider('Brightness', L.vrmExposure ?? 0.6, 0.3, 1.2, 0.01, (v) => app.edit((q) => { q.look = { ...L, ...q.look, vrmExposure: v }; }, true),
        'MToon models (VRoid etc.) are authored for dimmer scenes — lower if skin / white clothes look blown out', { def: 0.6, unit: '×' }),
    ));
    el.append(surfaceStyleSection(app, p, rerender));
  }
}

// ---------------------------------------------------------------- Tracking
function tracking(app: App, el: HTMLElement) {
  el.append(h('h2', null, 'Tracking'));
  const t = app.tune;
  const rerender = () => refresh(app, 'tracking', el);
  const camSel = h('select', { onChange: () => localStorage.setItem('vtp.camChosen', '1') });
  const resSel = h('select', null, ...RESOLUTIONS.map((r, i) => h('option', { value: String(i), selected: i === Number(localStorage.getItem('vtp.res') ?? 2) }, r.label)));
  const fpsSel = h('select', null, ...[30, 60].map((f) => h('option', { value: String(f), selected: String(f) === (localStorage.getItem('vtp.fps') ?? '60') }, `${f} fps`)));
  void listCameras().then((cams) => {
    const saved = localStorage.getItem('vtp.cam');
    const pick = cams.find((c) => c.deviceId === saved) ?? preferred(cams, PREFERRED_CAMERA);
    for (const c of cams) camSel.append(h('option', { value: c.deviceId, selected: c.deviceId === pick?.deviceId }, c.label));
    if (!cams.length) camSel.append(h('option', null, 'No camera found'));
  });
  const start = async () => {
    const r = RESOLUTIONS[Number(resSel.value)];
    localStorage.setItem('vtp.cam', camSel.value); localStorage.setItem('vtp.res', resSel.value); localStorage.setItem('vtp.fps', fpsSel.value);
    await app.startTracking({ deviceId: camSel.value || undefined, width: r.width, height: r.height, fps: Number(fpsSel.value) });
    rerender();
  };
  const fileIn = h('input', { type: 'file', accept: 'video/*', style: 'display:none', onChange: () => { const f = fileIn.files?.[0]; if (f) void app.startVideoFile(f).then(rerender); } });
  el.append(section('Camera',
    h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'Camera'), camSel),
    h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'Resolution'), resSel),
    h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'Frame rate'), fpsSel),
    h('div', { class: 'btns' },
      app.trackingOn ? button('Stop', () => { app.stopTracking(); rerender(); }, 'danger') : button('Start tracking', () => void start(), 'primary'),
      button('Use a video file…', () => fileIn.click()),
    ),
    fileIn,
    h('p', { class: 'note' }, app.stats.camera ? `Live: ${app.stats.camera} · ${app.stats.delegate}` : 'Any webcam works — no depth sensor or iPhone needed. 720p is plenty; 1080p helps gaze when you sit far back.'),
    // the Hands / Body switches of Simple → Tracking (one state: app.setTrackPart, this browser, every avatar)
    toggle('Track hands & fingers', app.parts.hands, (v) => app.setTrackPart('hands', v), `${TRACK_PART_TEXT.hands.hint} Same switch as Hands in Simple mode.`),
    toggle('Track body', app.parts.body, (v) => app.setTrackPart('body', v), `${TRACK_PART_TEXT.body.hint} Same switch as Body in Simple mode.`),
    h('p', { class: 'note' }, 'Off stops it right away and that part of your avatar rests. Your face is always tracked, and this browser remembers your choice.'),
  ));
  el.append(externalSection(app as never));
  el.append(faceChainSection(app));   // MediaPipe GPU -> processor -> OpenSeeFace: where it stands + the buttons (src/tracking/faceChain.ts)

  el.append(section('One-step setup',
    h('p', { class: 'note' }, 'One guided ~45 s test personalises everything: neutral face, your expressions, how you talk and (mic on) your vowels. It belongs to YOU, not the avatar — every avatar, built-in or uploaded, is ready after a single run.'),
    h('div', { class: 'btns' }, button('Run expression setup test', () => void app.runSetupTest(), 'primary')),
  ));
  el.append(section('Calibration',
    h('p', { class: 'note' }, app.face.calib ? `Calibrated ${new Date(app.face.calib.at).toLocaleString()}` : 'Not calibrated yet — happens automatically once your face is steady.'),
    h('div', { class: 'btns' },
      button('Calibrate neutral (2 s)', async () => { toast('Relax your face and look at the screen…'); await app.face.calibrate(2); toast('Neutral calibrated', 'ok'); rerender(); }, 'primary'),
      button('Expression range wizard', () => void wizard(app)),
      button('Reset', () => { app.face.resetCalibration(); rerender(); }, 'danger'),
    ),
    h('p', { class: 'note' }, 'The wizard learns YOUR biggest smile, widest mouth, etc. so subtle faces still read fully on the avatar.'),
    naturalSection(app, rerender),
    h('div', { class: 'btns' }, button('Record expression test clip (65 s)', () => void app.recordClip())),
    h('p', { class: 'note' }, 'Records your face (and mic) through a scripted set of expressions to cache/diag/ on this PC, so tracking can be tuned to your face — beards, glasses, lighting.'),
  ));

  el.append(eyesTrackedSection(app, rerender));

  // metric depth (iris-scaled) + mouth-interior image analysis
  const M = app.face.metric;
  const fovNow = M.fovSource === 'user' ? String(M.fovDiag) : 'auto';
  el.append(section('Depth & mouth detail',
    h('p', { class: 'note' }, M.Z > 0 ? `You are ~${Math.round(M.Z * 100)} cm from the camera (face size from your iris${M.learned >= 240 ? '' : ', still learning'}; ${M.fovDiag}° lens, ${M.fovSource === 'camera' ? 'from the camera model' : M.fovSource === 'user' ? 'set by you' : 'typical webcam'}).` : 'Distance appears once tracking runs.'),
    select('Camera field of view', fovNow, [['auto', 'Auto (from camera model)'], ['65', '65° (narrow / zoomed)'], ['78', '78° (typical webcam)'], ['84', '84°'], ['90', '90° (wide)'], ['100', '100° (ultra-wide)']],
      (v) => { M.setUserFov(v === 'auto' ? null : Number(v), app.stats.camera ?? ''); rerender(); },
      'Only changes how far lean-in / lean-back moves the avatar. Sideways / up-down motion is measured in real centimetres either way.'),
    toggle('Tongue & teeth detection (beta)', app.tracker.mouthImage, (v) => { app.tracker.mouthImage = v; try { localStorage.setItem('vtp.mouthImage', v ? '1' : '0'); } catch { /* ignore */ } rerender(); },
      'Looks inside your mouth on the camera image: tongue out, teeth, open cavity (MediaPipe has no tongue). Pauses itself on slow PCs.'),
    toggle('Camera tongue moves the avatar tongue', app.face.tongueFromCamera, (v) => { app.face.tongueFromCamera = v; try { localStorage.setItem('vtp.tongueCam', v ? '1' : '0'); } catch { /* ignore */ } },
      'Needs tongue detection on. Stick your tongue out and hold it — quick flickers while talking are ignored.'),
  ));

  const tune = (fn: (p: AvatarProfile['tracking']) => void) => app.edit((p) => fn(p.tracking), false);
  el.append(section('Feel',
    slider('Expressiveness', t.expressiveness, 0.5, 2, 0.01, (v) => tune((x) => (x.expressiveness = v)), 'Global intensity of all expressions', { def: DP.tracking.expressiveness, unit: '×' }),
    slider('Smoothing', t.smoothing, 0, 1, 0.01, (v) => tune((x) => (x.smoothing = v)), 'Low = snappy, high = buttery (more lag)', { def: DP.tracking.smoothing }),
    slider('Head motion', t.headRotationScale, 0, 2, 0.01, (v) => tune((x) => (x.headRotationScale = v)), undefined, { def: DP.tracking.headRotationScale, unit: '×' }),
    slider('Body follow', t.bodyFollow, 0, 1.5, 0.01, (v) => tune((x) => (x.bodyFollow = v)), 'How much the torso sways with your head/body', { def: DP.tracking.bodyFollow, unit: '×' }),
    select('Facial hair', t.facialHair < 0 ? 'auto' : t.facialHair >= 0.75 ? 'full' : t.facialHair >= 0.35 ? 'some' : 'none',
      [['auto', `Auto-detect (${app.face.hair.score > 0.35 ? 'beard detected' : app.face.hair.moustache > 0.35 ? 'moustache detected' : 'none seen yet'})`], ['none', 'None / clean-shaven'], ['some', 'Stubble / moustache'], ['full', 'Full beard']],
      (v) => tune((x) => (x.facialHair = { auto: -1, none: 0, some: 0.5, full: 1 }[v])),
      'Beards hide the cues MediaPipe uses for the mouth. With compensation on, VTube Pro reads your lips geometrically instead.'),
    toggle('Mirror (like a mirror)', t.mirror, (v) => tune((x) => (x.mirror = v))),
    slider('Follow ←→', t.translate?.[0] ?? 1, 0, 2, 0.05, (v) => tune((x) => (x.translate = [v, x.translate?.[1] ?? 0.7, x.translate?.[2] ?? 1.2])), 'Avatar moves sideways when you do', { def: DP.tracking.translate![0], unit: '×' }),
    slider('Follow ↑↓', t.translate?.[1] ?? 0.7, 0, 2, 0.05, (v) => tune((x) => (x.translate = [x.translate?.[0] ?? 1, v, x.translate?.[2] ?? 1.2])), 'Avatar rises/sinks with your head', { def: DP.tracking.translate![1], unit: '×' }),
    slider('Follow depth', t.translate?.[2] ?? 1.2, 0, 3, 0.05, (v) => tune((x) => (x.translate = [x.translate?.[0] ?? 1, x.translate?.[1] ?? 0.7, v])), 'Lean in → avatar comes closer (bigger); lean back → it moves away', { def: DP.tracking.translate![2], unit: '×' }),
    // (Track body / Track hands & fingers moved to Camera above: they are this browser's Hands / Body switches now)
  ));
  el.append(blendCurvesSection(app));   // the 52 face channels: range + response curve, saved with this avatar (shared/blendCurves.ts)
  {
    // when tracking is lost (shared/trackLoss.ts, src/tracking/trackLoss.ts): per part + the two transition sliders
    const L = sanitizeTrackLoss(t.trackLoss), D = TRACK_LOSS_DEFAULTS;
    const setL = (fn: (c: TrackLossSettings) => void) => tune((x) => { const c = sanitizeTrackLoss(x.trackLoss); fn(c); x.trackLoss = c; });
    const partSel = (part: TrackLossPart, label: string, hint: string) => select(label, L.modes[part],
      (part === 'body' || part === 'hands' ? (['hold', 'rest'] as TrackLossMode[]) : (['hold', 'rest', 'life'] as TrackLossMode[])).map((m) => [m, TRACK_LOSS_LABEL[m]] as [string, string]),
      (v) => setL((c) => (c.modes[part] = v as TrackLossMode)), hint);
    el.append(section('When tracking is lost',
      partSel('face', 'Head & face', 'Hold: freeze and pick up where you left off. Rest: ease back to the default pose. Voice life: blinks, glances and nods from your voice.'),
      partSel('eyes', 'Eyes', 'Hold keeps the gaze (never frozen mid-blink). Voice life keeps blinking and glancing.'),
      partSel('body', 'Body & arms', 'When the body model loses your shoulders / an arm'),
      partSel('hands', 'Hands & fingers', 'When a hand leaves the frame'),
      slider('Loss transition', L.lossS, 0, 3, 0.05, (v) => setL((c) => (c.lossS = v)), 'How gently it eases into the hold or rest pose', { def: D.lossS, unit: 's' }),
      slider('Recovery transition', L.recoverS, 0, 1.5, 0.05, (v) => setL((c) => (c.recoverS = v)), 'How gently it blends back to live tracking when you are found again', { def: D.recoverS, unit: 's' }),
      slider('Grace period', L.graceMs, 0, 500, 10, (v) => setL((c) => (c.graceMs = v)), 'Nothing moves until tracking has been gone this long (a dropped frame never twitches the avatar)', { def: D.graceMs, unit: 'ms' }),
      slider('Ignore first frames', L.rejectFrames, 0, 5, 1, (v) => setL((c) => (c.rejectFrames = Math.round(v))), 'Frames thrown away when tracking comes back (the tracker is often wrong for 1–2 frames); two frames must also agree', { def: D.rejectFrames }),
    ));
  }
  const neckSec = neckSection(app, rerender);
  if (neckSec) el.append(neckSec);

  // (a fresh install has the built-in starter set, not a model of YOUR face: say so until the person trains their own)
  const exprLine = (m: typeof app.exprModel) => !m ? 'No expression model yet'
    : m.source.split(' ')[0] === 'live' ? `Expression model: ${m.classes.length} expressions, trained on your faces`
    : `Expression model: the built-in starter set (${m.classes.length} expressions), not trained on you yet. Teach it your faces below to make it yours.`;
  const exprStatus = h('p', { class: 'note' }, exprLine(app.exprModel));
  const teach: [string, string, string][] = [
    ['neutral', 'Neutral', 'Relax your face'], ['talk', 'Talk', 'Talk normally for 3 s'], ['happy', 'Smile', 'Closed-mouth smile'],
    ['grin', 'Big grin', 'Big open grin'], ['sad', 'Sad', 'Your sad face'], ['angry', 'Angry', 'Your angry face'],
    ['surprised', 'Surprised', 'Your surprised face'], ['kiss', 'Kiss', 'Pucker / kiss'], ['puff', 'Puff', 'Puff your cheeks'], ['smirk', 'Smirk', 'One-sided smirk'],
  ];
  el.append(section('Expressions',
    slider('Expression boost', t.expressionBoost ?? 1, 0, 1.5, 0.05, (v) => tune((x) => (x.expressionBoost = v)), 'When your face matches one of YOUR trained expressions, push the avatar into a strong cartoon version of it', { def: DP.tracking.expressionBoost, unit: '×' }),
    slider('Cartoon squash & stretch', t.cartoon ?? 1, 0, 2, 0.05, (v) => tune((x) => (x.cartoon = v)), 'Eye pops on surprise, head stretches with the jaw, squashes on grins', { def: DP.tracking.cartoon, unit: '×' }),
    exprStatus,
    h('p', { class: 'note' }, 'Teach it YOUR faces (2 s each — make the face, then click; it waits half a second). Anything you skip keeps the default.'),
    h('div', { class: 'btns tight' }, ...teach.map(([cls, label, hint]) => button(label, async (e) => {
      if (!app.trackingOn) { toast('Start tracking first', 'warn'); return; }
      const b = e.currentTarget as HTMLButtonElement;
      b.textContent = `${hint}…`;
      try { const n = await app.captureExpression(cls as never, cls === 'talk' ? 3 : 2); b.textContent = `${label} ✔`; toast(`Captured ${label} (${n} frames)`, 'ok', 1800); }
      catch (err) { b.textContent = label; toast((err as Error).message, 'err'); }
    }))),
    h('div', { class: 'btns' },
      button('Train on my faces', () => { const n = app.trainExpressions(); exprStatus.textContent = `Expression model: ${n} expressions, trained on your faces`; toast('Expressions trained ✔', 'ok'); }, 'primary'),
      button('Reset to default', () => { app.resetExpressions(); exprStatus.textContent = exprLine(app.exprModel); }, 'danger'),
    ),
  ));

  el.append(section('Arms & hands',
    // what the arms do: follow me / at my sides / in front (shared/armPose.ts); hidden for 2D avatars
    ...(() => { const a = armsPicker(app, rerender); return a ? [a] : []; })(),
    slider('Arm exaggeration', t.armExaggeration ?? 1.25, 0.6, 2, 0.05, (v) => tune((x) => (x.armExaggeration = v)), 'Cartoon energy — pushes arm poses further than your real motion', { def: DP.tracking.armExaggeration, unit: '×' }),
    slider('Bouncy arms', t.armBounce ?? 0.45, 0, 1, 0.01, (v) => tune((x) => (x.armBounce = v)), 'Springy follow-through: overshoot & settle', { def: DP.tracking.armBounce }),
    // per avatar (src/avatar/bodyGuard.ts): bulky armour or a big chest, hands touching the chest or meeting in front
    toggle('Keep hands out of the body', t.bodyGuard === true, (v) => tune((x) => (x.bodyGuard = v)), 'For bulky armour or a big chest: your hands and forearms stay on the body instead of passing through it'),
    slider('Body depth', t.bodyDepth ?? 1, 1, 2, 0.05, (v) => tune((x) => (x.bodyDepth = v)), 'With "Keep hands out of the body": how far the body reaches out in front. Raise it until your hands rest on the armour, not inside it', { def: 1, unit: '×' }),
    // per avatar (shared/idleArm.ts): a wide character (a big belly, bulky armour) whose resting hands sink into the body
    slider('Resting arm angle', t.idleArmDown ?? IDLE_ARM_DOWN_DEFAULT, IDLE_ARM_DOWN_MIN, IDLE_ARM_DOWN_MAX, 1, (v) => tune((x) => (x.idleArmDown = v)), 'How far below level the arms hang while the camera isn’t tracking them. Lower it for a wide character whose resting hands sink into the body', { def: IDLE_ARM_DOWN_DEFAULT, unit: '°' }),
    slider('Finger smoothing', t.handSmoothing ?? t.smoothing, 0, 1, 0.01, (v) => tune((x) => (x.handSmoothing = v)), 'Low = fingers react instantly (a little jitter at rest), high = steady fingers with more lag. Adaptive: fast finger moves always get through', { def: DP.tracking.handSmoothing ?? t.smoothing }),
    toggle('Gesture effects', t.gestureFx !== false, (v) => tune((x) => (x.gestureFx = v)), '👍 ✌️ 🤟 ✊ ☝️ 👎 and waving spawn emoji bursts from the avatar’s hand'),
    toggle('Gesture reactions', t.gestureReactions !== false, (v) => tune((x) => (x.gestureReactions = v)), 'The face reacts: thumbs-up grin, peace-sign wink, love-you heart eyes…'),
    // (this browser, every avatar: localStorage vtp.handUpsample = '1', read by the hand retargeting's render-rate upsampler.
    //  Shown only in a build that has it: src/avatar/retarget.ts exports handEaseRate next to it)
    ...('handEaseRate' in retargetModule ? [toggle('Smooth hands between camera frames', lsGet('vtp.handUpsample') === '1', (v) => lsSet('vtp.handUpsample', v ? '1' : null),
      'Moves the avatar’s hands smoothly between camera frames instead of stepping with each new frame. Off by default.')] : []),
    h('div', { class: 'btns tight' }, ...([['thumbs_up', '👍'], ['peace', '✌️'], ['love', '🤟'], ['wave', '👋'], ['fist', '✊'], ['point', '☝️'], ['thumbs_down', '👎']] as const)
      .map(([k, e]) => button(e, () => app.gestures.inject(k, 'right')))),
    h('p', { class: 'note' }, 'Hold a gesture for a beat to trigger it; wave an open palm to wave. Buttons preview the effects.'),
  ));

  el.append(snackSection(app));

  const micSel = h('select', { onChange: () => localStorage.setItem('vtp.micChosen', '1') });
  void listMics().then((mics) => {
    const saved = localStorage.getItem('vtp.mic');
    const pick = mics.find((m) => m.deviceId === saved) ?? preferred(mics, PREFERRED_MIC);
    for (const m of mics) micSel.append(h('option', { value: m.deviceId, selected: m.deviceId === pick?.deviceId }, m.label));
  });
  // live: can the camera see the mouth, or is a mic / hand in front of it? (mouthVisibility.ts)
  const mouthNote = h('p', { class: 'note' });
  let mouthMounted = false, mouthWaits = 0;
  const mouthRefresh = () => {
    if (mouthNote.isConnected) mouthMounted = true;
    else if (mouthMounted || ++mouthWaits > 4) { clearInterval(mouthTimer); return; } // panel re-rendered / tab switched
    // honest about what is checked: off / paused (no mouth patch lately: busy PC, no face worker) / sees it / covered;
    // face.hands is null unless a hand model really runs (app.ts: the Hands switch AND tracker.models().hands)
    const mv = app.face.mouthVis;
    mouthNote.textContent = mouthStatusText({ enabled: mv.enabled, tracking: app.trackingOn, tracked: app.frame.tracked, checking: mv.checking,
      busy: app.tracker.mouthVisPause === 'busy', vis: mv.vis, mic: app.audio.active, hands: app.face.hands !== null });
  };
  const mouthTimer = setInterval(mouthRefresh, 500);
  mouthRefresh();
  el.append(section('Voice lip-sync',
    mouthNote,
    h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'Microphone'), micSel),
    toggle('Use microphone', app.audio.active, async (v) => {
      tune((x) => (x.audioLipSync = v));
      if (v) { try { localStorage.setItem('vtp.mic', micSel.value); await app.audio.start(localStorage.getItem('vtp.micChosen') ? micSel.value : undefined); localStorage.setItem('vtp.micOn', '1'); toast(`Mic lip-sync on${app.audio.deviceLabel ? ` (${app.audio.deviceLabel})` : ''}`, 'ok'); } catch (e) { toast(`Mic failed: ${(e as Error).message}`, 'err'); } }
      else { app.audio.stop(); localStorage.removeItem('vtp.micOn'); }
    }),
    slider('Mic sensitivity', app.audio.gain, 0.3, 4, 0.05, (v) => (app.audio.gain = v), undefined, { def: 1, unit: '×' }),
    ...voiceFilterControls(app),
    slider('Enunciation', t.enunciation ?? 1.3, 0.5, 2, 0.05, (v) => tune((x) => (x.enunciation = v)), 'How crisp and distinct speech shapes are: A wide-open, E/I stretched, O round, U small round, M/B/P pressed shut', { def: DP.tracking.enunciation, unit: '×' }),
    h('div', { class: 'btns tight' },
      ...([['A', 'AAH'], ['I', 'EEE'], ['U', 'OOO'], ['E', 'EH'], ['O', 'OH']] as const).map(([v, say]) =>
        button(`Train “${say}”`, async (e) => {
          if (!app.audio.active) { toast('Turn on the microphone first', 'warn'); return; }
          const b = e.currentTarget as HTMLButtonElement;
          b.textContent = `Say “${say}”…`;
          try { const n = await app.audio.calibrateVowel(v); toast(`Learned “${say}” (${n} frames)`, 'ok'); }
          catch (err) { toast((err as Error).message, 'err'); }
          b.textContent = `Train “${say}” ✔`;
        })),
      button('Reset voice', () => { app.audio.resetProfile(); toast('Voice profile reset to default', 'ok'); }, 'danger'),
    ),
    h('p', { class: 'note' }, 'Voice training (optional, ~10 s): hold each vowel for 2 seconds so the mouth shapes match YOUR voice. The mic also drives F/V (teeth on lip), S/SH, and snaps the mouth shut between syllables.'),
    h('p', { class: 'note' }, 'Fills in the mouth when the camera can’t see it (hand in front of face, dark room) and adds vowel shapes. Camera always leads when your mouth is visible.'),
  ));

  const gains = h('details', null, h('summary', null, 'Per-expression gain (advanced)'));
  const chans = ['jawOpen', 'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthPucker', 'mouthFunnel', 'browInnerUp', 'browDownLeft', 'browDownRight', 'browOuterUpLeft', 'browOuterUpRight', 'eyeWideLeft', 'eyeWideRight', 'eyeSquintLeft', 'eyeSquintRight', 'cheekPuff', 'mouthStretchLeft', 'mouthStretchRight', 'noseSneerLeft', 'noseSneerRight'];
  for (const c of chans) gains.append(slider(c, t.gains[c] ?? 1, 0, 3, 0.05, (v) => tune((x) => (x.gains[c] = v)), undefined, { def: DP.tracking.gains[c] ?? 1, unit: '×' }));
  el.append(section('Fine tuning', gains,
    select('Performance', app.tier, [['low', 'Low (older laptops)'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra (RTX-class)']], (v) => app.setTier(v as QualityTier), 'Lower tiers use lighter body models and track body/hands less often'),
    // (this browser: localStorage vtp.trackDelegate = 'gpu' | 'cpu', none = Auto, read by the tracker when the camera
    //  starts. Shown only in a build whose tracker has the setting: Tracker.delegatePolicy)
    ...('delegatePolicy' in app.tracker ? [select('Tracking processor', trackDelegateSetting(),
      [['auto', 'Auto'], ['gpu', 'Graphics card'], ['cpu', 'Processor'], ['nogpu', 'Processor (for games)']], // ('nogpu': cpuFace hook)
      (v) => { lsSet('vtp.trackDelegate', v === 'auto' ? null : v); app.tracker.refreshPolicy?.(); },
      'Where face, body and hand tracking run. Auto measures while you track and moves a model to the graphics card or the processor, whichever is faster right now (everything starts on the graphics card; your face always comes first; a game that holds the graphics card moves it all to the processor). Processor: everything on the processor; your face never waits for the graphics card (body and hands still use it briefly for each picture). Processor (for games): the same, with body and hands at most 10 times a second, so a game that fills the graphics card slows tracking least. Applies at once.')] : []),
    // (truth: "Never leaves this PC" was false once an AI app is connected: it can read the snapshots and sends them to its company)
    toggle('Save camera snapshots for AI help', app.diagAuto, (v) => { app.diagAuto = v; localStorage.setItem('vtp.diagAuto', v ? '1' : '0'); }, 'While your camera is on, saves a camera picture, a render and tracking numbers in VTube Pro’s folder on this computer every 3 seconds. An AI app you connected to VTube Pro can look at them, and that app sends them to its own company. Not on your stream.'),
  ));
}

/** Food & drinks (fun): drink props in the avatar's hand, food mess on the face. Settings are per performer. */
function snackSection(app: App): HTMLElement {
  const S = app.snacks, s = S.settings;
  const status = h('p', { class: 'note' });
  // live readout: what each hand is doing, the cues, and why the last events fired
  const why = h('pre', { class: 'note', style: 'white-space:pre-wrap;font-size:11px;line-height:1.35;margin:2px 0 6px;max-height:10em;overflow:auto' });
  let mounted = false, waits = 0;
  const refresh = () => {
    if (document.hidden && mounted) return;                  // nobody looks at a hidden studio's readout (a game in front)
    why.textContent = S.settings.enabled && app.trackingOn ? S.debugText() : '';
    if (status.isConnected) mounted = true;
    else if (mounted || ++waits > 4) { clearInterval(timer); return; } // panel re-rendered / tab switched
    const tr = app.tracker;
    const st = S.state;
    status.textContent = !S.settings.enabled ? 'Off — nothing extra runs.'
      : !app.trackingOn ? 'Waiting for tracking to start.'
      : tr.objectsError ? `Detector failed: ${tr.objectsError}`
      : !tr.objectsActive ? 'Detector paused (tracking is busy on this PC) — hand-to-mouth + chewing still work for food.'
      : `Detector on · ${tr.timing.objects.toFixed(0)} ms per look · ${st?.hold.left || st?.hold.right ? `holding ${(st.hold.right ?? st.hold.left)!.kind}` : 'no drink'}${st?.chewing ? ' · chewing' : ''}${st?.food ? ` · food: ${st.food}` : ''}`;
  };
  const timer = setInterval(refresh, 500);
  refresh();
  return section('Food & drinks (fun)',
    toggle('Detect drinks & food', s.enabled, (v) => { S.save({ enabled: v }); refresh(); },
      'Picks up a cup / can / bottle → your avatar holds one and sips when you drink. Eating (food, forks, hand-to-mouth + chewing) leaves food mess. Runs a small object detector ~4× a second next to the hand tracker, and pauses itself whenever tracking needs the PC.'),
    status,
    why,
    select('Sensitivity', s.sensitivity, [['strict', 'Strict (several cues must agree)'], ['normal', 'Normal'], ['loose', 'Loose (fires easily)']], (v) => S.save({ sensitivity: v }),
      'Strict: a cup must be seen in your hand AND reach your closed lips while you are not talking; bites need the mouth to open (and food in hand, or chewing right after). Loose reacts to weaker evidence and may fire on hand-to-face gestures.'),
    toggle('Show props', s.drinks, (v) => S.save({ drinks: v }), 'Show the drink prop in the avatar’s hand'),
    h('details', null, h('summary', null, 'Which drinks & food'),
      ...([['mug', 'Mug'], ['coffee', 'Coffee / to-go cup'], ['can', 'Soda can'], ['bottle', 'Bottle'], ['glass', 'Wine glass'], ['food', 'Food (bites → mess)']] as const)
        .map(([k, l]) => toggle(l, s.types[k] !== false, (v) => S.save({ types: { ...S.settings.types, [k]: v } }))),
      toggle('Guess drinks from posture', s.posture, (v) => S.save({ posture: v }), 'No cup seen: hand at the lips + a long head tilt back counts as a sip. Off by default (it can mistake a chin rest for a drink).')),
    select('Drink prop', s.propStyle, [['auto', 'Auto (from what you hold)'], ['coffee', 'Coffee cup'], ['mug', 'Mug'], ['can', 'Soda can'], ['bottle', 'Soda bottle'], ['glass', 'Wine glass']], (v) => S.save({ propStyle: v })),
    toggle('Food mess', s.mess, (v) => S.save({ mess: v }), 'Each bite adds a little mess around the mouth (and on your fingers) that fades over time.'),
    select('Mess style', s.messStyle, [['auto', 'Auto (from the food seen)'], ['crumbs', 'Crumbs & sauce'], ['spaghetti', 'Spaghetti sauce'], ['cheeto', 'Cheeto dust'], ['chocolate', 'Chocolate'], ['sugar', 'Powdered sugar']], (v) => S.save({ messStyle: v })),
    slider('Max messiness', s.maxMess, 0.1, 1, 0.05, (v) => S.save({ maxMess: v }), 'From a tiny smudge to face-planted in a plate of spaghetti', { def: SNACK_DEFAULTS.maxMess }),
    slider('Mess fades in (min)', s.fadeMin, 0.5, 20, 0.5, (v) => S.save({ fadeMin: v }), 'Minutes until a mess has faded away on its own', { def: SNACK_DEFAULTS.fadeMin, unit: 'min' }),
    h('div', { class: 'btns tight' },
      button('🧻 Clean face', () => S.clean(), 'primary'),
      button('☕ Sip preview', () => { const k = S.settings.propStyle === 'auto' ? 'coffee' : S.settings.propStyle; S.forceHold('right', k, 0, 5); setTimeout(() => S.forceHold('right', k, 1, 2), 1200); setTimeout(() => S.forceHold('right', k, 0, 1.5), 3200); }),
      button('🍝 Bite preview', () => S.forceBite(1)),
      button('😵 Big mess', () => S.forceBite(8)),
    ),
  );
}

async function wizard(app: App) {
  if (!app.trackingOn) { toast('Start tracking first', 'warn'); return; }
  const steps: [string, string[]][] = [
    ['Smile as BIG as you can 😁', ['mouthSmileLeft', 'mouthSmileRight', 'cheekSquintLeft', 'cheekSquintRight', '_gSmileL', '_gSmileR']],
    ['Open your mouth WIDE 😮', ['jawOpen', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthStretchLeft', 'mouthStretchRight', '_gOpen', '_gLowerDown']],
    ['Frown — corners DOWN ☹️', ['mouthFrownLeft', 'mouthFrownRight', '_gFrownL', '_gFrownR']],
    ['Say “EEEE” (wide)', ['mouthStretchLeft', 'mouthStretchRight', '_gStretchL', '_gStretchR']],
    ['Raise your eyebrows high 🤨', ['browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'eyeWideLeft', 'eyeWideRight']],
    ['Frown / angry brows 😠', ['browDownLeft', 'browDownRight', 'mouthFrownLeft', 'mouthFrownRight', 'noseSneerLeft', 'noseSneerRight']],
    ['Kiss face / pucker 😗', ['mouthPucker', 'mouthFunnel', '_gPucker']],
    ['Say “OH!” (round & open)', ['mouthFunnel', '_gFunnel']],
    ['Press your lips together hard', ['mouthPressLeft', 'mouthPressRight', '_gPress']],
    ['Puff your cheeks 🐡', ['cheekPuff', '_gPuff']],
    ['Squint your eyes 😑', ['eyeSquintLeft', 'eyeSquintRight']],
  ];
  if (!app.face.calib) { toast('Relax — calibrating neutral first'); await app.face.calibrate(2); }
  for (const [msg, chans] of steps) {
    toast(msg, 'info', 2600);
    await new Promise((r) => setTimeout(r, 700));
    app.face.beginCapture(chans);
    await new Promise((r) => setTimeout(r, 1800));
    app.face.endCapture();
  }
  toast('Expression range learned ✔', 'ok');
}

// ---------------------------------------------------------------- Emotes (VRMA)
function emoteSection(app: App, supported: boolean): HTMLElement {
  const loop = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const now = h('span', { class: 'note' }, app.emote ? `Playing: ${app.emote.name}` : '');
  const list = h('div', { class: 'btns tight' }, ...EMOTES.map((e) => button(`▶ ${e.label}`, () => {
    if (app.playEmote(e.id, loop.checked || e.loop)) now.textContent = `Playing: ${e.label}${loop.checked || e.loop ? ' (loop)' : ''}`;
  })));
  return section('Emotes',
    supported
      ? h('p', { class: 'note' }, 'Plays a short animation on top of your tracking (your face stays live; in a room only the upper body moves). It shows in OBS and to party guests too.')
      : h('p', { class: 'note' }, 'Emotes work on VRM and humanoid avatars.'),
    list,
    h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'Loop'), loop),
    h('div', { class: 'btns' }, button('■ Stop emote', () => { app.stopEmote(); now.textContent = ''; }), now),
    h('p', { class: 'note' }, 'Emote clips are free to use: Quaternius Universal Animation Library (CC0).'),
  );
}

// ---------------------------------------------------------------- Body & physics
/** Imported (not shipped) GLB / glTF / OBJ / FBX models that are not VRM humanoids: the "Re-rig this model" entry is offered. */
function offersRerig(p: AvatarProfile): boolean {
  return p.rig.kind !== 'vrm' && !p.shipped && p.source !== 'builtin' && p.source !== 'builtin-test' && /\.(glb|gltf|obj|fbx)$/i.test(p.modelFile);
}
function body(app: App, el: HTMLElement) {
  el.append(h('h2', null, 'Body & physics'));
  if (needAvatar(app, el)) return;
  const p = app.profile!, rt = app.runtime!;
  const rerender = () => refresh(app, 'body', el);
  el.append(section('Rig',
    h('p', { class: 'note' }, 'Rig: ', h('b', null, rigLabel(rt.info.rig)), rt.info.rig === 'soft' ? ' — generated instantly for this unrigged model.' : ''),
  ));
  // (only for models without a skeleton of their own, or one this section made: it replaces the skeleton, so a VRM / rigged GLB never sees it)
  if (p.rig.kind === 'soft' || p.rig.kind === 'none' || p.rig.retarget) el.append(skeletonSection(app, p));
  else if (offersRerig(p)) {
    // imported GLB / OBJ models that already have a skeleton: re-rigging stays one click away (tucked in, closed by default). A VRM or a shipped avatar never sees it.
    el.append(h('details', { class: 'sub', 'data-cg': 'rerig' }, h('summary', null, 'Re-rig this model (people, animals, objects)'),
      h('p', { class: 'note' }, 'Only if this model moves wrongly with your face: this builds a new skeleton for it. Your original file is kept.'), skeletonSection(app, p)));
  }
  el.append(emoteSection(app, rt.info.rig === 'vrm' || rt.info.rig === 'humanoid'));
  if (p.rig.kind === 'soft' && p.rig.soft) {
    const s = p.rig.soft;
    const softGuess = () => softMemo.get(rt) ?? softMemo.set(rt, guessSoftRig(rt.model)).get(rt)!;
    const markerBtn = (label: string, kind: 'shoulderL' | 'shoulderR' | 'handL' | 'handR', key: 'leftShoulder' | 'rightShoulder' | 'leftHand' | 'rightHand') =>
      button(label, () => app.place(kind, (m) => {
        const b = rt.bounds(); const w = rt.toWorld(m.position);
        const sz = b.getSize(w.clone().set(0, 0, 0));
        app.edit((q) => (q.rig.soft![key] = [(w.x - b.min.x) / sz.x, (w.y - b.min.y) / sz.y, (w.z - b.min.z) / sz.z]));
        rerender();
      }));
    el.append(section('Soft rig',
      slider('Neck height', s.neck, 0.2, 0.95, 0.005, (v) => app.edit((q) => (q.rig.soft!.neck = v)), '↺ = the automatic guess for this model (same as Re-guess)', { def: softGuess().neck }),
      slider('Chest height', s.chest, 0.1, 0.9, 0.005, (v) => app.edit((q) => (q.rig.soft!.chest = v)), undefined, { def: softGuess().chest }),
      slider('Hips height', s.hips, 0.05, 0.8, 0.005, (v) => app.edit((q) => (q.rig.soft!.hips = v)), undefined, { def: softGuess().hips }),
      slider('Blend', s.blend, 0.01, 0.2, 0.005, (v) => app.edit((q) => (q.rig.soft!.blend = v)), 'Softer = squishier bends', { def: softGuess().blend }),
      h('p', { class: 'note' }, 'Arms (optional): click a shoulder then its hand.'),
      h('div', { class: 'btns tight' },
        markerBtn('Left shoulder', 'shoulderL', 'leftShoulder'), markerBtn('Left hand', 'handL', 'leftHand'),
        markerBtn('Right shoulder', 'shoulderR', 'rightShoulder'), markerBtn('Right hand', 'handR', 'rightHand'),
        button('Re-guess', () => app.edit((q) => (q.rig.soft = guessSoftRig(rt.model)))),
      ),
      h('div', { class: 'btns' }, button('Improve rig with Blender (bone heat)', async () => {
        try {
          const { jobId } = await api.autorig(p.id, p.rig.soft!);
          toast('Blender is rigging… (~20 s)');
          const j = await waitJob(jobId, () => {});
          if (j.status === 'succeeded') { toast('Rigged with Blender ✔', 'ok'); await app.loadAvatar(p.id, true); }
          else toast(`Blender rig failed: ${j.error}`, 'err', 8000);
        } catch (e) { toast((e as Error).message, 'err'); }
      }, 'primary')),
    ));
  }
  const ph = p.physics;
  const jig = section('Physics',
    toggle('Enabled', ph.enabled, (v) => app.edit((q) => (q.physics.enabled = v))),
    toggle('Auto hair/tail/accessory springs', ph.autoChains, (v) => app.edit((q) => (q.physics.autoChains = v)), 'Bones named hair, tail, ear, skirt, ribbon, earring, hat… get springs automatically'),
    slider('Wind', ph.wind, 0, 1, 0.01, (v) => { app.edit((q) => (q.physics.wind = v), false); rt.physics.wind = v; }, undefined, { def: DP.physics.wind }),
    h('p', { class: 'note' }, `${rt.info.springJoints} spring joints active.`),
    h('h3', { style: 'margin-top:10px' }, 'Jiggle regions'),
    h('p', { class: 'note' }, 'Belly, chest, cheeks, anything soft: click the centre of the soft area.'),
    h('div', { class: 'btns' }, button('Add jiggle region', () => app.place('jiggle', (m) => {
      const r: JiggleRegion = { id: Math.random().toString(36).slice(2, 7), name: `Jiggle ${ph.jiggle.length + 1}`, center: m.position, radius: app.localHalfWidth(m) * 0.5, ...JIGGLE_DEF };
      app.edit((q) => q.physics.jiggle.push(r)); rerender();
    }))),
  );
  ph.jiggle.forEach((j, i) => {
    jig.append(h('div', { class: 'sec' },
      h('h3', null, j.name),
      slider('Radius', j.radius, 0.01, 1, 0.005, (v) => app.edit((q) => (q.physics.jiggle[i].radius = v)), '↺ = the size fitted when the region was added', { def: +(halfW(app, { position: j.center, normal: [0, 0, 1] }) * 0.5).toFixed(4), hard: [0.005, 2] }),
      slider('Stiffness', j.stiffness, 0, 1, 0.01, (v) => app.edit((q) => (q.physics.jiggle[i].stiffness = v)), undefined, { def: JIGGLE_DEF.stiffness }),
      slider('Damping', j.damping, 0, 1, 0.01, (v) => app.edit((q) => (q.physics.jiggle[i].damping = v)), undefined, { def: JIGGLE_DEF.damping }),
      slider('Amount', j.amount, 0, 2, 0.01, (v) => app.edit((q) => (q.physics.jiggle[i].amount = v)), undefined, { def: JIGGLE_DEF.amount, unit: '×' }),
      button('Remove', () => { app.edit((q) => q.physics.jiggle.splice(i, 1)); rerender(); }, 'danger'),
    ));
  });
  el.append(jig);
}

// ---------------------------------------------------------------- Create
function create(app: App, el: HTMLElement) {
  el.append(h('h2', null, 'Create an avatar'));
  const state = (create as unknown as { s?: { images: string[]; prompt: string; faceless: boolean; job?: Job | null; running?: boolean } }).s ??=
    { images: [], prompt: '', faceless: true };
  const rerender = () => refresh(app, 'create', el);
  const thumbs = h('div', { class: 'thumbs' }, ...state.images.map((src, i) => h('img', { src, title: 'Click to remove', onClick: () => { state.images.splice(i, 1); rerender(); } })));
  const fileIn = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' });
  const addFiles = (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      const r = new FileReader();
      r.onload = () => { state.images.push(String(r.result)); rerender(); };
      r.readAsDataURL(f);
    }
  };
  fileIn.onchange = () => fileIn.files && addFiles(fileIn.files);
  const drop = h('div', { class: 'drop', onClick: () => fileIn.click() }, 'Reference images (front / side / back, character sheets, sketches) — drop or click');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer?.files) addFiles(e.dataTransfer.files); };
  const prompt = h('textarea', { placeholder: 'Describe your character… e.g. "friendly robot DJ in a silver bomber jacket with a glowing blue visor, cartoon style"', value: state.prompt, onInput: (e: Event) => (state.prompt = (e.target as HTMLTextAreaElement).value) });

  el.append(section('What to make', prompt, drop, fileIn, thumbs));
  el.append(section('How',
    h('p', { class: 'note' }, 'Builds a plain 3D model from your picture with ComfyUI on this computer (the Character 3D recipe). Nothing is sent to the internet.'),
    toggle('Let VTube Pro make eyes & mouth', state.faceless, (v) => (state.faceless = v), 'Generates a blank face so our procedural eyes and mouth animate perfectly'),
  ));
  const log = h('div', { class: 'log' }, 'Ready.');
  const bar = h('div', { class: 'progress' }, h('i', { style: 'width:0%' }));
  const preview = h('div', { class: 'thumbs' });
  const paint = (j: Job | null | undefined) => {
    if (!j) return;
    log.textContent = j.log.slice(-40).join('\n');
    log.scrollTop = log.scrollHeight;
    (bar.firstChild as HTMLElement).style.width = `${Math.round(j.progress * 100)}%`;
    if (j.preview && preview.dataset.src !== j.preview) { preview.dataset.src = j.preview; clear(preview); preview.append(h('img', { src: j.preview, style: 'width:100%;height:auto' })); }
  };
  paint(state.job);
  // lane create-gating: say what is missing before anyone presses Generate (GET /api/status; same rules as the server)
  const blockNote = h('p', { class: 'note warn' });
  // the button that fixes what the note says (ComfyUI without its 3D model: "Set it up for me"),
  // the same button as the simple Create card (shared/createGate.ts providerFix, src/ui/gateFix.ts)
  const fixBox = h('div', { class: 'btns', 'data-cg': 'builder-fix' });
  // `needPic`: ComfyUI will run VTube Pro's own Character 3D (a picture in); the user's own workflow file is not held to it
  let needPic = false;
  const checkStatus = (e?: Event) => void api.status().then((st) => {
    if (e && !fixBox.isConnected) { window.removeEventListener('focus', checkStatus); return; } // this panel was replaced
    const note = builderNote('comfy', st);
    needPic = note.needsPicture;
    blockNote.textContent = note.text;
    clear(fixBox);
    const fix = note.fix;
    if (fix) fixBox.append(button(fix.label, () => runGateFix(fix), note.blocks ? 'primary' : 'link'));
    go.disabled = note.blocks || !!state.running;
  }).catch(() => {});
  checkStatus();
  // the person presses "Set it up for me", finishes in the helper's tab and comes back here: the note, the button and Generate follow without re-opening the panel
  window.addEventListener('focus', checkStatus);
  const go = button('Generate', async () => {
    if (!state.prompt && !state.images.length) { toast('Describe the character or add a reference image', 'warn'); return; }
    if (needPic && !state.images.length) { toast('ComfyUI turns a picture into 3D: add a picture of your character first', 'warn'); return; }
    go.disabled = true; state.running = true;
    try {
      const { jobId } = await api.generate({ provider: 'comfy', prompt: state.prompt, images: state.images, faceless: state.faceless });
      const job = await waitJob(jobId, (j) => { state.job = j; if (log.isConnected) paint(j); else rerender(); });
      state.job = job;
      if (job.status === 'succeeded' && job.result?.avatarId) {
        toast('Avatar created ✔ — next: place its eyes & mouth (Me → Advanced → Face)', 'ok', 7000);
        // (unstamped: a job finishing minutes after the click is no performer switch - OBS never jumps to this studio for it)
        await app.loadAvatar(job.result.avatarId, false, false);
        app.emit('library');
      } else toast(`Generation failed: ${job.error}`, 'err', 10000);
    } catch (e) { toast((e as Error).message, 'err', 8000); }
    go.disabled = false; state.running = false;
    rerender();
  }, 'primary');
  go.disabled = !!state.running;
  el.append(section('Run', h('div', { class: 'btns' }, go), blockNote, fixBox, bar, preview, log));
}

// ---------------------------------------------------------------- OBS output
function output(app: App, el: HTMLElement) {
  el.append(h('h2', null, 'Stream output (OBS)'));
  const focus = (localStorage.getItem('vtp.outFocus') as 'full' | 'bust' | 'head') || 'bust';
  const url = () => `http://127.0.0.1:5191/output.html?focus=${localStorage.getItem('vtp.outFocus') || 'bust'}`;
  const code = h('code', null, url());
  el.append(tut(section('Your OBS link',
    h('p', { class: 'note' }, 'In OBS: ', h('b', null, 'Sources → + → Browser'), '. Paste this link and set Width 1920, Height 1080. The background is see-through: drop it over any scene.'),
    code,
    h('div', { class: 'btns' },
      button('Copy OBS link', () => { void navigator.clipboard.writeText(url()); toast('OBS link copied', 'ok', 2000); }, 'primary', 'obs-copy'),
      button('See what OBS shows', () => window.open(url(), '_blank')),
    ),
    select('Framing', focus, [['bust', 'Bust (head & shoulders)'], ['head', 'Head close-up'], ['full', 'Full body']], (v) => { localStorage.setItem('vtp.outFocus', v); code.textContent = url(); }),
    h('p', { class: 'note' }, 'In OBS, leave “Shutdown source when not visible” and “Refresh browser when scene becomes active” unticked (they are by default), so your avatar doesn’t reload.'),
    h('details', null, h('summary', { class: 'note', style: 'cursor:pointer' }, 'For power users'),
      h('p', { class: 'note' }, 'It follows whichever avatar the studio has loaded; add ', h('code', null, '&avatar=<id>'), ' to pin one. A source can still start from URL params (?scale=1.2&x=0.1&y=-0.05&focus=head): the studio wins as soon as you move a slider.')),
  ), 'obs-link'));
  { const sp = h('div'); el.append(sp); void import('./streamPcCard.ts').then((m) => m.mountStreamPcCard(sp)); } // "Streaming from a second PC" (Stream PC mode, src/ui/streamPcCard.ts)
  // ---- live layout for every OBS output page (saved on this PC, applied instantly)
  const outBox = h('div');
  void api.output().then((o) => {
    let t = 0;
    const save = (patch: Partial<typeof o>) => {
      Object.assign(o, patch);
      clearTimeout(t);
      t = window.setTimeout(() => { if (!app.observer) void api.saveOutput(o).catch((e) => toast(String(e), 'err')); }, 120);
    };
    outBox.append(
      slider('Avatar size', o.scale, 0.3, 3, 0.01, (v) => save({ scale: v }), 'Bigger / smaller on the OBS canvas (1 = auto-framed)', { def: 1, unit: '×', hard: [0.2, 5] }),
      slider('Move ←→', o.offset[0], -0.5, 0.5, 0.005, (v) => save({ offset: [v, o.offset[1]] }), 'Slide the avatar left / right in the OBS frame', { def: 0, hard: [-1, 1] }),
      slider('Move ↑↓', o.offset[1], -0.5, 0.5, 0.005, (v) => save({ offset: [o.offset[0], v] }), 'Slide the avatar up / down in the OBS frame', { def: 0, hard: [-1, 1] }),
      select('Framing', o.focus, [['bust', 'Bust (head & shoulders)'], ['head', 'Head close-up'], ['full', 'Full body']], (v) => save({ focus: v as typeof o.focus })),
      select('Party layout', o.layout ?? 'row', [['row', 'Side by side (one row)'], ['grid', 'Two rows for 5+ people']], (v) => save({ layout: v as typeof o.layout })),
      h('div', { class: 'btns' }, button('Reset layout', () => { save({ scale: 1, offset: [0, 0], focus: 'bust', layout: 'row' }); toast('Layout reset', 'ok'); })),
    );
  }).catch(() => outBox.append(h('p', { class: 'note' }, 'VTube Pro’s engine isn’t answering. Restart VTube Pro.')));
  el.append(section('Output size & position', outBox,
    h('p', { class: 'note' }, 'Changes apply live to every OBS output.')));

  // (clarity: the Discord party / relay / TURN settings used to sit here too, and people setting up OBS thought they
  // needed them; they live in Party)
  el.append(h('div', { class: 'note', style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0' }, h('span', null, 'Streaming with friends? Party and Discord settings are in Party.'),
    button('Party settings', () => studioNav().advanced('friends', 'party'))));
  el.append(trailSection(app)); // Party games: The Trail (src/ui/trailPanel.ts → src/game/trail)

  el.append(section('Studio view',
    select('Framing', app.focus, [['bust', 'Bust'], ['head', 'Head'], ['full', 'Full body']], (v) => { app.focus = v; app.frameCamera(); }),
    toggle('Transparent studio background', app.stage.background === null, (v) => app.stage.setTransparent(v)),
    select('Studio preview while live', app.previewLight ? 'light' : 'full', [['full', 'Full'], ['light', 'Light']], (v) => app.setPreviewLight(v === 'light'),
      'Light: while your camera is on and OBS shows VTube Pro, this studio preview draws 30 times a second at about 1080p, which leaves your graphics card more time for tracking. What OBS shows does not change. Full: the preview is not reduced.'),
    h('p', { class: 'note' }, 'Press ', h('span', { class: 'kbd' }, 'H'), ' to hide all UI (clean window capture). Zoom Meet/Teams/Discord: use OBS’s ', h('b', null, 'Start Virtual Camera'), '.'),
  ));
}

// ---------------------------------------------------------------- Settings
/** What the shared Settings cards need from the shell, from here (the Advanced panel is not handed the shell's nav). */
function settingsNavFor(app: App): SettingsNav {
  const modeButtons = () => [...document.querySelectorAll<HTMLElement>('[role=radiogroup][aria-label="Menus"] button')]; // the top bar's Simple | Advanced
  return {
    wizard: (id, at) => openNamed(app, id, at),
    refresh: () => studioNav().refresh(),
    setGlobalAdvanced: (on) => modeButtons()[on ? 1 : 0]?.click(),
    globalAdvanced: () => { try { return localStorage.getItem('vtp.ui.mode') === 'advanced'; } catch { return false; } },
  };
}
function settings(app: App, el: HTMLElement) {
  // FR-02: Advanced is a superset of Simple. The Simple cards come first (the very same builders as Settings -> Simple,
  // src/ui/settingsCards.ts, ids in src/ui/settingsRegistry.ts), then the Advanced ones below.
  const sNav = settingsNavFor(app);
  el.append(lookFeelCard(app, sNav), guidedSetupsCard(app, sNav), performanceCard(app, sNav));
  const stat = h('div', { class: 'note' }, 'Checking server…');
  void api.status().then((s) => {
    clear(stat);
    stat.append(
      h('div', null, 'Blender: ', h('b', null, s.blender.available ? `✔ ${s.blender.version ?? ''}` : '✕ not found')),
      h('div', null, 'ComfyUI: ', h('b', null, s.comfy.reachable ? `✔ ${s.comfy.url}` : `✕ ${s.comfy.url}`)),
    );
  }).catch(() => {
    clear(stat);
    stat.textContent = 'VTube Pro’s engine stopped. Restart VTube Pro.';
  });
  el.append(tagCard('status', section('Status', stat)));
  const comfy = h('input', { type: 'text', placeholder: 'http://127.0.0.1:8188' });
  const blender = h('input', { type: 'text', placeholder: 'auto-detect' });
  void api.settings().then((s) => {
    comfy.value = String(s.comfyUrl ?? ''); blender.value = String(s.blenderPath ?? '');
  }).catch(() => {});
  el.append(tagCard('ai-apps', section('AI apps and local AI',
    h('p', { class: 'note' }, 'VTube Pro holds no AI account and no key. Use your own AI app (Claude, ChatGPT, Grok ...) through VTube Pro, or a free model on this computer.'),
    h('div', { class: 'btns' }, button('Connect an AI in 3 steps', () => openHelperAi(), 'ghost')),
  )));
  el.append(tagCard('models-tools', section('Models & tools',
    h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'ComfyUI URL'), comfy),
    h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'Blender path'), blender),
  )));
  el.append(h('div', { class: 'btns' }, button('Save settings', async () => {
    try { await api.saveSettings({ comfyUrl: comfy.value, blenderPath: blender.value }); toast('Saved', 'ok'); refresh(app, 'settings', el); }
    catch (e) { toast((e as Error).message, 'err'); }
  }, 'primary')));
  el.append(tagCard('credits', section('Credits',
    h('p', { class: 'note' }, 'NPC walk styles: ', h('b', null, 'The 100STYLE Dataset – Ian Mason'), ' (CC BY 4.0, ianxmason.com/100style).'),
    h('p', { class: 'note' }, 'Animations + characters: Quaternius (Universal Animation Library 1 + 2, CC0). Props: Poly Haven, Quaternius, KayKit (Kay Lousberg). Sounds: Kenney. Room light HDRIs: Poly Haven. All CC0.'),
    h('p', { class: 'note' }, 'Rendering: pmndrs/postprocessing (SMAA, Zlib), N8AO (CC0), @pixiv/three-vrm + three-vrm-animation (MIT), three.js (MIT). Full list: THIRD_PARTY_NOTICES.md.'),
  )));
  // (the same list as Settings -> Simple; it holds every key the old one-line note had)
  el.append(tagCard('keyboard-shortcuts', section('Keyboard', shortcutList())));
}
