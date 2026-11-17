// The 2D avatar maker: turn your own layered art into a live, trackable 2D avatar (.vtp2) with no other software.
//   main path: drop a layered PSD (or PNG layers) → it is auto-rigged at once and moves in the preview (demo motion or
//   your camera) → answer a picture question if something was unclear → "Use this avatar" / "Save".
//   power path: parts list (role, side, depth, clip, draw order, visibility), mesh editing (move / add / remove
//   vertices, auto-mesh density), bend points (rotation deformers) and lattices (warp deformers), recording poses per
//   parameter key (drag vertices / lattice points, turn bend points), physics strands, expressions, undo / redo.
// One mount function (the studio's layout owns where it sits): mountRig2DEditor(host, opts), or openRig2DEditor(opts)
// for a full-window overlay. The preview draws with the RUNTIME evaluator (shared/rig2d/evaluate.ts) on the exported rig,
// so what you see is what goes live; while you drag, the editor's own evaluator (same maths, unit-tested to agree)
// fills in until the rig is rebuilt. Never makes sound; nothing leaves the computer unless the user saves / uses it.
import type { TrackingFrame } from '../../shared/types.ts';
import type { ArtSet } from '../../shared/rig2d/edit/layers.ts';
import { autoRigArt, applyAutoRig, STD_BIND, ROLE_DEPTH } from '../../shared/rig2d/edit/autorig.ts';
import { buildRig, packRig, packAtlas, atlasPages, type BuiltRig, type AtlasPage } from '../../shared/rig2d/edit/vtp2.ts';
import { PoseEval, unmapDelta } from '../../shared/rig2d/edit/pose.ts';
import { History } from '../../shared/rig2d/edit/history.ts';
import { recordAt, nudge, defaultKeys, uniqueId, findParam, type EdDoc, type EdMesh, type EdTexture, type EdDeformer, type EdExpression } from '../../shared/rig2d/edit/doc.ts';
import { questions, answer, WHAT_CHOICES, type Question } from '../../shared/rig2d/edit/ask.ts';
import { ROLE_LABEL, ROLES, SIDED, type Role } from '../../shared/rig2d/edit/classify.ts';
import { addVertex, removeVertex, moveVertex, remeshAuto, pickVertex } from '../../shared/rig2d/edit/meshEdit.ts';
import { RigEval } from '../../shared/rig2d/evaluate.ts';
import { RIG2D } from '../../shared/rig2d/format.ts';
import { RigGL, type LightOpts } from './gl.ts';
import { noteGroups } from '../../shared/rig2d/edit/notes.ts';
import { RuntimePreview } from './runtimePreview.ts';
import { setRig2DWorld } from '../../shared/rig2d/world.ts';
import type { LightMaps } from '../../shared/rig2d/edit/maps.ts';
import { PreviewExtras } from '../../shared/rig2d/edit/preview.ts';
import { bonesPanel, chainCards, lightPanel, fxPanel, moodsPanel, outfitsPanel, makeChain, type PanelCtx } from './advanced.ts';
import { paintWeights } from '../../shared/rig2d/edit/skin.ts';
import { landmarksOf } from '../../shared/rig2d/edit/autorig.ts';
import { nearestVertex } from '../../shared/rig2d/edit/extras.ts';
import { decodePng } from './files.ts';
import { buildMaps } from '../../shared/rig2d/edit/maps.ts';
import { demoFrame, idleFrame } from './tracking.ts';
import { Animator } from '../../shared/rig2d/animate.ts';
import { openFiles, encodePng, thumbURL, download } from './files.ts';
import { mountPictureStep } from './pictureStep.ts';
import { rigPicture, type PicturePixels, type PictureTaps } from '../../shared/rig2d/edit/picture.ts';
import { injectEditorStyle } from './style.ts';

export interface Rig2DEditorOpts {
  /** The studio's live tracking (the user's camera). Absent / null = the "My camera" choice is hidden / waits. */
  getFrame?: () => TrackingFrame | null;
  /** "Use this avatar": the finished .vtp2 bytes, a name and a PNG thumbnail. Absent = the button is hidden. */
  onUse?: (bytes: Uint8Array, name: string, thumb: Uint8Array) => void | boolean | Promise<void | boolean>;
  /** The "Use this avatar" button's words (Edit rig: "Save to my avatar", src/rig2dEditor/editRig.ts). */
  useLabel?: string;
  /** One plain sentence: why "Use this avatar" can't work here now (the button stays visible but off; "Save" still works). */
  useBlocked?: string;
  /** Save: default = a download of <name>.vtp2. */
  onSave?: (bytes: Uint8Array, fileName: string) => void | Promise<void>;
  /** Open these at start (a dropped PSD / PNG layers / .vtp2). */
  files?: File[];
  /** "Try the sample" art (the built-in procedural character when absent). */
  sample?: () => ArtSet;
  /** Shown as a Close button (overlay mode). */
  onClose?: () => void;
}

export interface Rig2DEditorHandle {
  readonly el: HTMLElement;
  open(files: File[]): Promise<void>;
  openArt(art: ArtSet, name: string): void;
  /** demo = built-in motion, camera = getFrame(), still = sliders only. */
  setDrive(d: Drive): void;
  /** Hold exactly these parameter values (by id; every other parameter at rest). {} = all at rest. */
  setParams(v: Record<string, number>): void;
  save(): Promise<Uint8Array | null>;
  /** Show a one-line message inside the maker (err = stays longer, red edge). */
  notify(msg: string, err?: boolean): void;
  /** Test / automation helpers: where a part's centre is on screen (client px), and how many hand-made keyform groups
   *  it has. */
  debug: { pointOf(partName: string): [number, number] | null; handForms(partName: string): number; bones(): number; skinOf(partName: string): number; extras(): unknown; select(partName: string): void; swing(partName: string): { bones: number; kick: number } | null };
  info(): { name: string; parts: number; understood: number; questions: number; vertices: number; built: boolean; issues: number; drive: Drive; fps: number; msFrame: number; msOverlay: number; preview: 'editor' | 'runtime' };
  dispose(): void;
}

/** A tracking frame showing an emotion (for "Try" on emotion triggers), the faces the runtime's estimator reads. */
function withEmotion(f: TrackingFrame, name: string): TrackingFrame {
  const face: Record<string, number> = { ...f.face };
  const set = (o: Record<string, number>) => Object.assign(face, o);
  if (name === 'happy') set({ mouthSmileLeft: 1, mouthSmileRight: 1, cheekSquintLeft: 0.8, cheekSquintRight: 0.8, mouthFrownLeft: 0, mouthFrownRight: 0 });
  else if (name === 'sad') set({ mouthFrownLeft: 1, mouthFrownRight: 1, browInnerUp: 1, mouthSmileLeft: 0, mouthSmileRight: 0, browDownLeft: 0, browDownRight: 0 });
  else if (name === 'angry') set({ browDownLeft: 1, browDownRight: 1, noseSneerLeft: 0.8, noseSneerRight: 0.8, mouthSmileLeft: 0, mouthSmileRight: 0 });
  else if (name === 'surprised') set({ browOuterUpLeft: 1, browOuterUpRight: 1, eyeWideLeft: 1, eyeWideRight: 1, jawOpen: 0.7, browDownLeft: 0, browDownRight: 0 });
  return { ...f, face, mouth: { ...f.mouth, smile: name === 'happy' ? 1 : 0, frown: name === 'sad' ? 1 : 0, open: name === 'surprised' ? 0.7 : f.mouth.open } };
}

const nn = (...a: (Node | null | false | undefined)[]) => a.filter(Boolean) as Node[];

type Drive = 'demo' | 'camera' | 'still';
type Tool = 'look' | 'pose' | 'mesh' | 'bend' | 'bone' | 'weights' | 'slot';
type Tab = 'check' | 'move' | 'part' | 'bones' | 'light' | 'fx' | 'moods' | 'outfits' | 'physics' | 'looks';

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> | null = null, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style') el.style.cssText = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
};

const ROLE_GROUPS: [string, Role[]][] = [
  ['Eyes', ['eyeWhite', 'iris', 'highlight', 'lashUpper', 'lashLower', 'eyeClosed', 'eyeWhole']], ['Brows', ['brow']],
  ['Mouth', ['mouthUpper', 'mouthLower', 'mouthInner', 'teeth', 'tongue', 'mouth']], ['Face', ['face', 'nose', 'blush', 'ear']],
  ['Hair', ['hairFront', 'hairSide', 'hairBack', 'ahoge']], ['Body', ['neck', 'body', 'arm', 'hand']], ['Extras', ['headAcc', 'bodyAcc']],
];

export function mountRig2DEditor(host: HTMLElement, opts: Rig2DEditorOpts = {}): Rig2DEditorHandle {
  injectEditorStyle();
  // ------------------------------------------------------------------ state
  let doc: EdDoc | null = null;
  let textures: EdTexture[] = [];
  let name = 'My avatar';
  let atlas: { tex: EdTexture[]; n: number; v: number; places: ReturnType<typeof packAtlas>['places']; sizes: { w: number; h: number }[]; pages: AtlasPage[] } | null = null;
  let rt: RuntimePreview | null = null, rtMaps: LightMaps | null = null, rtMapsKey = '', tryEmotion: { name: string; until: number } | null = null;
  let selBone: string | null = null, boneDraft: [number, number][] = [], slotTarget: { kind: 'particle' | 'attachment'; id: string } | null = null;
  let texVersion = 0, extras: PreviewExtras | null = null, windOn = false, mapsStale = true, mapsKey = '', mapsTimer = 0;
  // the preview light (the "Lighting" tab): mode, direction (x right, y up, z toward the viewer), colours
  const light: LightOpts = { mode: 'art', dir: [-0.5, 0.55, 0.65], key: [1, 0.96, 0.9], amb: [0.42, 0.45, 0.55], strength: 0.8, rimStrength: 0.8, rimWidth: 0.35 };
  /** The light options for this frame (maps built lazily the first time they are needed). */
  const lightOpts = (): LightOpts | null => {
    if (!doc || light.mode === 'art') return null;
    const L = doc.extras?.lighting;
    if (L) { light.strength = L.strength; light.rimStrength = L.rim.strength; light.rimWidth = L.rim.width; }
    const key = doc.meshes.map((m) => `${m.role}:${m.depth.toFixed(2)}:${m.glow ?? 0}`).join('|') + `|${L?.rimPx}|${atlas?.v}|${atlas?.n}`;
    if ((mapsStale || key !== mapsKey) && atlas && !mapsTimer) {
      mapsTimer = window.setTimeout(() => { mapsTimer = 0; if (!doc || !atlas) return; gl?.setMaps(buildMaps(doc, textures, atlas.places, atlas.sizes)); mapsKey = key; mapsStale = false; }, 60);
    }
    return light;
  };
  let built: BuiltRig | null = null, ev: RigEval | null = null, builtStale = true, buildTimer = 0, topoStale = true;
  let pose: PoseEval | null = null;
  let anim: Animator | null = null, physicsOn = true, builtFor: EdDoc | null = null;
  const demoF = demoFrame(0), idleF = idleFrame();
  const hist = new History();
  let drive: Drive = 'demo', tool: Tool = 'look', tab: Tab = 'check', lastTab: Tab = 'check';
  let sel: string | null = null, selDef: string | null = null, focusParam = 'ParamMouthOpenY';
  let held: EdExpression | null = null;
  let brush = 24, density = 0.5;
  const thumbs = new Map<number, string>();
  let view = { s: 1, ox: 0, oy: 0 }, userZoom = 1, userPan = [0, 0];
  let dirty = false;
  /** Why "Use this avatar" is off for what is open now (null = it isn't): an imported model whose pictures could not all
   *  be read would save those parts blank over the avatar. */
  let useOff: string | null = null;
  let disposed = false, raf = 0, lastT = performance.now(), t0 = performance.now(), fps = 0, frames = 0, fpsT = performance.now();
  // The maker has no autosave: a reload / closed tab with changes that were not saved or used asks first (the browser's own "Leave site?").
  const askBeforeLeaving = (e: BeforeUnloadEvent) => { if (!dirty || disposed) return; e.preventDefault(); e.returnValue = ''; };
  addEventListener('beforeunload', askBeforeLeaving);
  const held2: Record<string, number> = {};
  let toastTimer = 0;

  // ------------------------------------------------------------------ DOM
  const root = h('div', { class: 'r2e', tabIndex: 0 });
  const top = h('div', { class: 'r2e-top' });
  const left = h('div', { class: 'r2e-left' });
  const stage = h('div', { class: 'r2e-stage checker' });
  const right = h('div', { class: 'r2e-right' });
  root.append(top, left, stage, right);
  host.append(root);
  const glc = h('canvas'), rtc = h('canvas'), ovc = h('canvas');
  stage.append(glc, rtc, ovc);
  const rtx = rtc.getContext('2d')!;
  let gl: RigGL | null = null, glErr = '';
  try { gl = new RigGL(glc); } catch (e) { glErr = e instanceof Error ? e.message : String(e); }
  const ov = ovc.getContext('2d')!;
  const tools = h('div', { class: 'r2e-tools' });
  const status = h('div', { class: 'r2e-status' });
  const empty = h('div', { class: 'r2e-empty' });
  stage.append(tools, status, empty);
  const fileIn = h('input', { type: 'file', multiple: true, accept: `.psd,.psb,.png,.jpg,.jpeg,.webp,${RIG2D.ext}`, style: 'display:none' }) as HTMLInputElement;
  root.append(fileIn);
  fileIn.addEventListener('change', () => { const f = Array.from(fileIn.files ?? []); fileIn.value = ''; if (f.length) void open(f); });

  const toast = (msg: string, err = false, list?: { title: string; items: string[] }[]) => {
    root.querySelector('.r2e-toast')?.remove();
    const t = h('div', { class: `r2e-toast${err ? ' err' : ''}${list ? ' list' : ''}`, role: 'status' }, msg);
    if (list?.length) {
      // every note, grouped, behind one "Show" (the first group open when it is short)
      const n = list.reduce((s, g) => s + g.items.length, 0);
      const box = h('details', { class: 'r2e-notes' }, h('summary', null, `${n} note${n > 1 ? 's' : ''} about your file`),
        ...list.map((g) => h('div', null, h('b', null, g.title), h('ul', null, ...g.items.map((x) => h('li', null, x))))));
      if (n <= 3) box.open = true;
      t.append(box);
      box.addEventListener('toggle', () => { clearTimeout(toastTimer); });
    }
    const close = h('button', { class: 'x', 'aria-label': 'Close' }, '×');
    close.addEventListener('click', () => t.remove());
    t.append(close);
    root.append(t);
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => t.remove(), list?.length ? 14000 : err ? 7000 : 3500);
  };
  const busy = (msg: string | null) => { stage.querySelector('.r2e-busy')?.remove(); if (msg) stage.append(h('div', { class: 'r2e-busy' }, msg)); };

  // ------------------------------------------------------------------ open
  async function open(files: File[]) {
    busy('Reading your art…');
    await new Promise((r) => setTimeout(r, 30));
    try {
      const r = await openFiles(files);
      if (r.kind === 'error') { toast(r.message, true); return; }
      if (r.kind === 'rig' && r.adopted && r.doc.imported) {
        // an imported model: an editable copy (shared/rig2d/edit/adopt.ts); what didn't come over exactly is on the Check tab.
        // Pictures that could not be read (low memory) are blank parts: never saved over the avatar
        const off = r.unread ? `Some pictures of this model could not be opened (this computer may be short of memory), so "${opts.useLabel ?? 'Use this avatar'}" is off: those parts would be saved blank. Close other programs, then open it again.` : null;
        setDoc(r.doc, r.textures, r.name, off);
        const n = r.doc.imported.notes.length;
        const notes = n ? [{ title: 'What changed on the way in', items: r.doc.imported.notes }] : undefined;
        if (off) toast(off, true, notes);
        else toast(`Opened an editable copy of this imported model.${n ? ` ${n === 1 ? 'One thing' : `${n} things`} changed on the way in: see the Check tab.` : ' Everything came over as it was.'} Saving makes it a maker avatar.`, false, notes);
        return;
      }
      if (r.kind === 'rig') { setDoc(r.doc, r.textures, r.name); toast('Opened. Everything you made is back, ready to edit.'); return; }
      if (r.kind === 'picture') { startPicture(r.pic, r.name); return; }
      openArt(r.art, r.name);
    } finally { busy(null); }
  }
  // (a rig made from one picture has no face layer to find: it is one mesh with a head weight, so "which is your face?" is never asked)
  const askable = (d: EdDoc, tex: EdTexture[]): Question[] => questions(d, tex).filter((q) => !(q.id === 'face' && d.meta.notes?.startsWith('Made from one picture')));
  // one flat picture: three taps (eyes, mouth), then the same rig as any layered art (shared/rig2d/edit/picture.ts)
  let pictureStep: { dispose(): void } | null = null, pictureTimer = 0;
  function startPicture(pic: PicturePixels, nm: string) {
    pictureStep?.dispose();
    pictureStep = mountPictureStep(stage, { pic, name: nm, onCancel: () => { pictureStep?.dispose(); pictureStep = null; },
      onBuild: (taps) => { pictureStep?.dispose(); pictureStep = null; buildPicture(pic, taps, nm); } });
  }
  function buildPicture(pic: PicturePixels, taps: PictureTaps, nm: string) {
    busy('Bringing your picture to life…');
    clearTimeout(pictureTimer);
    pictureTimer = window.setTimeout(() => {
      if (disposed) { busy(null); return; }
      try {
        const t = performance.now();
        const r = rigPicture(pic, taps, { name: nm });
        setDoc(r.doc, r.textures, nm);
        toast(`${r.says} (Done in ${((performance.now() - t) / 1000).toFixed(1)} s.) It is moving with a demo motion: switch to "My camera" to try it on.`, false, noteGroups(r.art.warnings, r.doc.report?.notes ?? []));
      } catch (e) { toast(`We could not bring this picture to life: ${e instanceof Error ? e.message : String(e)}`, true); }
      finally { busy(null); }
    }, 30);
  }
  function openArt(art: ArtSet, nm: string) {
    busy('Rigging your avatar…');
    const t = performance.now();
    const r = autoRigArt(art, { name: nm, density });
    setDoc(r.doc, r.textures, nm);
    busy(null);
    const qs = questions(r.doc, r.textures);
    const missing = qs.filter((q) => !q.id.startsWith('what_')).length;
    toast(missing ? `Rigged in ${((performance.now() - t) / 1000).toFixed(1)} s. ${missing === 1 ? 'One quick question' : `${missing} quick questions`} on the right, then you're ready.`
      : `Your avatar is ready (rigged in ${((performance.now() - t) / 1000).toFixed(1)} s). It is moving with a demo motion: switch to "My camera" to try it on.`,
      false, noteGroups(art.warnings, r.doc.report?.notes ?? []));
  }
  function setDoc(d: EdDoc, tex: EdTexture[], nm: string, off: string | null = null) {
    doc = d; textures = tex; name = nm; doc.name = nm; dirty = true; useOff = off;
    thumbs.clear(); hist.clear();
    sel = null; selDef = null; held = null;
    pose = new PoseEval(doc);
    userZoom = 1; userPan = [0, 0];
    tab = 'check'; tool = 'look';
    markChanged(true);
    renderAll();
  }
  const thumb = (i: number) => { let u = thumbs.get(i); if (!u && textures[i]) { u = thumbURL(textures[i]); thumbs.set(i, u); } return u ?? ''; };

  // ------------------------------------------------------------------ rebuild (the runtime rig) after edits
  function markChanged(topology = false) {
    builtStale = true; if (topology) topoStale = true;
    clearTimeout(buildTimer);
    buildTimer = window.setTimeout(rebuild, topology ? 0 : 140);
  }
  function rebuild() {
    if (!doc || disposed) return;
    pose?.rebuild();
    if (!atlas || atlas.tex !== textures || atlas.n !== textures.length || atlas.v !== texVersion) { const pk = packAtlas(textures); atlas = { tex: textures, n: textures.length, v: texVersion, places: pk.places, sizes: pk.sizes, pages: atlasPages(textures, pk.places, pk.sizes) }; }
    const b = buildRig(doc, textures, atlas);
    built = b;
    ev = new RigEval(b.doc, b.buffers);
    // the same avatar edited (not another one opened): the hair's motion carries on into the rebuilt rig
    const same = builtFor === doc;
    builtFor = doc;
    const oldAnim = anim;
    anim = new Animator(b.doc, b.buffers, ev, { physics: physicsOn });
    if (oldAnim && same) anim.carryMotionFrom(oldAnim);
    gl?.setRig(b);
    if (!extras || extras.doc !== doc) { const keep = extras?.costumeOn; extras = new PreviewExtras(doc); if (keep) extras.costumeOn = keep; }
    mapsStale = true;
    // the live preview through the real runtime (lighting maps cached: they only change with roles / depth / glow / art)
    try {
      const L = doc.extras?.lighting;
      const key = L?.maps ? doc.meshes.map((m) => `${m.role}:${m.depth.toFixed(2)}:${m.glow ?? 0}`).join('|') + `|${L.rimPx}|${atlas.v}|${atlas.n}` : '';
      if (key !== rtMapsKey) { rtMaps = key ? buildMaps(doc, textures, atlas.places, atlas.sizes) : null; rtMapsKey = key; }
      const on = (doc.extras?.costumes ?? []).filter((c) => extras?.costumeOn.get(c.id) ?? c.on).map((c) => c.id);
      // (the new preview carries the hair's motion on: an edit never snaps it back to rest)
      const old = rt;
      rt = new RuntimePreview(b, rtMaps, physicsOn, on, same ? old : null);
      old?.dispose();
    } catch (e) { rt = null; console.warn('runtime preview', e); }
    builtStale = false; topoStale = false;
    if (b.issues.length) toast(`This rig has a problem the live avatar would refuse: ${b.issues[0].path}: ${b.issues[0].message}`, true);
  }
  const edit = (fn: () => void, topology = false) => { if (!doc) return; dirty = true; hist.change(doc, fn); markChanged(topology); renderPanels(); };

  function undo() { if (!doc) return; const d = hist.undo(doc); if (d) { doc = d; reattach(); } }
  function redo() { if (!doc) return; const d = hist.redo(doc); if (d) { doc = d; reattach(); } }
  function reattach() { if (!doc) return; const vals = pose ? new Map(pose.values) : null; pose = new PoseEval(doc); if (vals) for (const [k, v] of vals) pose.values.set(k, v); markChanged(true); renderPanels(); }

  // ------------------------------------------------------------------ the frame loop
  function tick(now: number) {
    raf = requestAnimationFrame(tick);
    if (disposed) return;
    const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
    frames++; if (now - fpsT > 1000) { fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now; }
    layout();
    if (!doc || !pose) { gl?.draw([], [], [], 0, view); drawOverlay(); return; }
    const t = (now - t0) / 1000;
    const live = drive !== 'still' && tool !== 'mesh' && tool !== 'bend' && !drag;
    const tA = performance.now();
    const P = (id: string) => built!.doc.params.findIndex((p) => p.id === id);
    const drawExtras = (positions: Float32Array[], opacity: ArrayLike<number>, order: ArrayLike<number>, count: number, voice: number, expression: string | null) => {
      pose!.update();
      // positions come from the runtime evaluator (skinned already)
      const sprites = extras ? extras.update(pose!, positions, dt, { voice, expression, wind: windOn ? 0.6 : 0, skin: false }) : [];
      gl?.draw(positions, opacity, order, count, {
        view, light: lightOpts(), factor: extras ? (i) => extras!.meshFactor(i) : undefined, sprites,
        spriteRect: (tex) => { const pl = built?.places[tex], pg = pl ? built!.pages[pl.page] : null, tt = doc!.textures[tex]; return pl && pg ? { page: pl.page, rect: [pl.x / pg.w, pl.y / pg.h, tt.w / pg.w, tt.h / pg.h] } : null; },
      });
      placed = positions;
    };
    const runtimeOk = !!rt && !builtStale && !drag && (tool === 'look' || tool === 'slot') && (light.mode === 'art' || light.mode === 'lit');
    rtc.style.display = runtimeOk ? '' : 'none'; glc.style.display = runtimeOk ? 'none' : '';
    if (runtimeOk && rt && built) {
      // THE runtime: animator (tracking, bindings, blinks, lip sync, moods, dynamics, physics), skinning, effects, lighting
      const still = !live;
      let f = drive === 'demo' ? demoFrame(t, demoF) : (opts.getFrame?.() ?? idleF);
      if (tryEmotion && tryEmotion.until > t) f = withEmotion(f, tryEmotion.name);
      const voice = f.tracked ? f.mouth.speak ?? f.mouth.open : 0;
      for (const [k, v] of Object.entries(held2)) pose.set(k, v);
      rt.update(f, still ? 0 : voice, dt, t, { expression: held?.id ?? null, ...(still ? { still: (vals: Float64Array, idx: (id: string) => number) => { for (const p of doc!.params) { const i = idx(p.id); if (i >= 0) vals[i] = pose!.get(p.id); } }, ...(extras ? { parts: extras.partsAt(pose) } : {}) } : {}) });
      if (!still) built.doc.params.forEach((p, i) => pose!.values.set(p.id, rt!.ev.values[i]));
      const W = rtc.width, H = rtc.height;
      rt.draw(rtx, W, H, [-view.ox / view.s, -view.oy / view.s, (W - view.ox) / view.s, (H - view.oy) / view.s], light.mode === 'lit' ? { dir: light.dir, color: light.key } : null);
      placed = rt.positions.slice(0, doc.meshes.length) as Float32Array[];
      if (tab === 'bones' && extras) { pose.update(); extras.update(pose, placed.map((p) => p.slice()), dt, { skin: false }); }
    } else if (rt && built && !builtStale && !drag && (tool === 'look' || tool === 'slot')) {
      // normal / rim map views: the runtime moves it, the editor's renderer shows the maps
      let f = drive === 'demo' ? demoFrame(t, demoF) : (opts.getFrame?.() ?? idleF);
      if (tryEmotion && tryEmotion.until > t) f = withEmotion(f, tryEmotion.name);
      const still = !live;
      rt.update(f, still ? 0 : (f.tracked ? f.mouth.speak ?? f.mouth.open : 0), dt, t, { expression: held?.id ?? null, ...(still ? { still: (vals: Float64Array, idx: (id: string) => number) => { for (const p of doc!.params) { const i = idx(p.id); if (i >= 0) vals[i] = pose!.get(p.id); } } } : {}) });
      const o = rt.ev.out, N = doc.meshes.length;
      const order: number[] = []; for (let k = 0; k < o.orderCount; k++) if (o.order[k] < N) order.push(o.order[k]);
      placed = o.positions.slice(0, N) as Float32Array[];
      gl?.draw(placed, o.opacity, order, order.length, { view, light: lightOpts() });
    } else if (live && ev && built && anim) {
      // the runtime's own animator: tracking -> bindings -> blinks -> lip sync -> expressions -> physics
      const f = drive === 'demo' ? demoFrame(t, demoF) : (opts.getFrame?.() ?? idleF);
      const voice = f.tracked ? f.mouth.speak ?? f.mouth.open : 0;
      anim.update({ frame: f, voice, dt, time: t, expression: held?.id ?? null });
      // beyond-runtime-1 dynamics (spring / jiggle / wind) write their parameters before the rig is evaluated
      extras?.driveParams((id) => { const k = P(id); return k >= 0 ? ev!.values[k] : 0; }, (id, v) => { const k = P(id); if (k >= 0) ev!.values[k] = v; }, dt,
        { role: (r) => (r === 'headYaw' ? f.head[0] * 57.3 : r === 'headPitch' ? -f.head[1] * 57.3 : r === 'headRoll' ? f.head[2] * 57.3 : r === 'voice' ? voice : 0), wind: windOn ? 0.6 : 0 });
      built.doc.params.forEach((p, i) => pose!.values.set(p.id, ev!.values[i]));
      const o = ev.update();
      anim.afterEvaluate();   // follow-through (kind 'follow') runs on the evaluated vertices; not in the hand-posing branch below
      drawExtras(o.positions, o.opacity, o.order, o.orderCount, voice, held?.id ?? null);
    } else {
      for (const [k, v] of Object.entries(held2)) pose.set(k, v);
      const vals = new Map(pose.values);
      if (held) for (const p of held.params) {
        const v = vals.get(p.param); if (v === undefined) continue;
        vals.set(p.param, p.blend === 'add' ? v + p.value : p.blend === 'multiply' ? v * p.value : p.value);
      }
      if (!drag && !builtStale && ev && built) {
        built.doc.params.forEach((p, i) => { ev!.values[i] = vals.get(p.id) ?? p.default; });
        ev.partOpacity.fill(1);
        const o = ev.update();
        drawExtras(o.positions, o.opacity, o.order, o.orderCount, 0, held?.id ?? null);
      } else if (built && !topoStale) {
        const saved = new Map(pose.values);
        for (const [k, v] of vals) pose.values.set(k, v);
        const o = pose.update();
        for (const [k, v] of saved) pose.values.set(k, v);
        const order = doc.meshes.map((m, i) => i).filter((i) => doc!.meshes[i].visible && o.opacity[i] > 0).sort((a, b) => doc!.meshes[a].z - doc!.meshes[b].z || a - b);
        gl?.draw(o.pos, o.opacity, order, order.length, { view, light: lightOpts() });
        placed = o.pos;
      }
    }
    pose.update(); // handles (bend points, lattices) at the shown pose
    const tB = performance.now();
    drawOverlay();
    perf.frame = perf.frame * 0.9 + (tB - tA) * 0.1;
    perf.overlay = perf.overlay * 0.9 + (performance.now() - tB) * 0.1;
  }
  let placed: Float32Array[] = [];
  const perf = { frame: 0, overlay: 0 };

  function layout() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(2, Math.round(stage.clientWidth * dpr)), H = Math.max(2, Math.round(stage.clientHeight * dpr));
    for (const c of [glc, rtc, ovc]) if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    if (!doc) return;
    const s = Math.min(W / doc.canvas.w, H / doc.canvas.h) * 0.94 * userZoom;
    view = { s, ox: (W - doc.canvas.w * s) / 2 + userPan[0] * dpr, oy: (H - doc.canvas.h * s) / 2 + userPan[1] * dpr };
  }
  const toCanvas = (e: PointerEvent | MouseEvent): [number, number] => {
    const r = ovc.getBoundingClientRect(), dpr = ovc.width / Math.max(1, r.width);
    return [((e.clientX - r.left) * dpr - view.ox) / view.s, ((e.clientY - r.top) * dpr - view.oy) / view.s];
  };

  // ------------------------------------------------------------------ overlay (wireframe, handles)
  function drawOverlay() {
    ov.clearRect(0, 0, ovc.width, ovc.height);
    if (!doc || !pose) return;
    const X = (x: number) => x * view.s + view.ox, Y = (y: number) => y * view.s + view.oy;
    const mi = sel ? doc.meshes.findIndex((m) => m.id === sel) : -1;
    const p = mi >= 0 ? placed[mi] : null;
    if (p && tool !== 'look') {
      const m = doc.meshes[mi].mesh;
      ov.strokeStyle = tool === 'pose' ? '#ff6b6bcc' : '#6cc7f5cc'; ov.lineWidth = 1;
      ov.beginPath();
      for (let t = 0; t + 2 < m.tri.length; t += 3) { const a = m.tri[t], b = m.tri[t + 1], c = m.tri[t + 2]; ov.moveTo(X(p[a * 2]), Y(p[a * 2 + 1])); ov.lineTo(X(p[b * 2]), Y(p[b * 2 + 1])); ov.lineTo(X(p[c * 2]), Y(p[c * 2 + 1])); ov.closePath(); }
      ov.stroke();
      ov.fillStyle = '#ffffff';
      for (let k = 0; k < p.length; k += 2) ov.fillRect(X(p[k]) - 2, Y(p[k + 1]) - 2, 4, 4);
      if (drag?.kind === 'verts') { ov.fillStyle = '#ffb454'; for (const [i] of drag.picked) ov.fillRect(X(p[i * 2]) - 3, Y(p[i * 2 + 1]) - 3, 6, 6); }
    } else if (p) {
      // selection outline: the placed mesh's bounding box
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < p.length; k += 2) { x0 = Math.min(x0, p[k]); x1 = Math.max(x1, p[k]); y0 = Math.min(y0, p[k + 1]); y1 = Math.max(y1, p[k + 1]); }
      ov.setLineDash([5, 4]); ov.strokeStyle = '#6cc7f5'; ov.lineWidth = 1.5; ov.strokeRect(X(x0), Y(y0), (x1 - x0) * view.s, (y1 - y0) * view.s); ov.setLineDash([]);
    }
    if (tool !== 'look') {
      for (const f of doc.deformers) {
        const s = pose.out.defs.get(f.id);
        if (!s) continue;
        const on = f.id === selDef;
        if (f.kind === 'rotation') {
          const a = (s.angle * Math.PI) / 180, L = 46 * Math.max(1, view.s * 0.6) / Math.max(1, view.s * 0.6);
          const ex = X(s.ox) + Math.sin(a) * L, ey = Y(s.oy) - Math.cos(a) * L;
          ov.strokeStyle = on ? '#ffb454' : '#7bd88fcc'; ov.lineWidth = on ? 3 : 2;
          ov.beginPath(); ov.arc(X(s.ox), Y(s.oy), 7, 0, Math.PI * 2); ov.moveTo(X(s.ox), Y(s.oy)); ov.lineTo(ex, ey); ov.stroke();
          ov.beginPath(); ov.arc(ex, ey, 5, 0, Math.PI * 2); ov.fillStyle = on ? '#ffb454' : '#7bd88f'; ov.fill();
        } else if (s.lattice && (on || f.id === doc.meshes[mi]?.deformer)) {
          const L = s.lattice, cp = s.cols + 1;
          ov.strokeStyle = '#a78bfacc'; ov.lineWidth = 1.2; ov.beginPath();
          for (let j = 0; j <= s.rows; j++) for (let i = 0; i <= s.cols; i++) {
            const k = j * cp + i;
            if (i < s.cols) { ov.moveTo(X(L[k * 2]), Y(L[k * 2 + 1])); ov.lineTo(X(L[(k + 1) * 2]), Y(L[(k + 1) * 2 + 1])); }
            if (j < s.rows) { ov.moveTo(X(L[k * 2]), Y(L[k * 2 + 1])); ov.lineTo(X(L[(k + cp) * 2]), Y(L[(k + cp) * 2 + 1])); }
          }
          ov.stroke();
          ov.fillStyle = '#a78bfa'; for (let k = 0; k < L.length; k += 2) ov.fillRect(X(L[k]) - 3, Y(L[k + 1]) - 3, 6, 6);
        }
      }
    }
    // bones (Bones tab / tools): lines from the preview's placed bones; weights as coloured points
    if ((tool === 'bone' || tool === 'weights' || tab === 'bones') && extras) {
      for (const b of doc.extras?.bones ?? []) {
        const B = extras.boneWorld.get(b.id);
        if (!B || !b.parent) continue;
        const x0 = B[4], y0 = B[5], x1 = x0 + B[0] * b.length, y1 = y0 + B[1] * b.length;
        ov.strokeStyle = b.id === selBone ? '#ffb454' : '#7bd88f'; ov.lineWidth = b.id === selBone ? 4 : 2.5;
        ov.beginPath(); ov.moveTo(X(x0), Y(y0)); ov.lineTo(X(x1), Y(y1)); ov.stroke();
        ov.beginPath(); ov.arc(X(x0), Y(y0), 4, 0, Math.PI * 2); ov.fillStyle = ov.strokeStyle; ov.fill();
      }
    }
    if (tool === 'weights' && p && selBone) {
      const w = doc.meshes[mi].skin?.[selBone];
      for (let k = 0; k < p.length / 2; k++) { const v = w?.[k] ?? 0; ov.fillStyle = `rgba(${Math.round(255 * v)},${Math.round(80 + 120 * (1 - v))},${Math.round(255 * (1 - v))},0.9)`; ov.fillRect(X(p[k * 2]) - 3, Y(p[k * 2 + 1]) - 3, 6, 6); }
      if (hover) { ov.strokeStyle = '#ffb45488'; ov.lineWidth = 1; ov.beginPath(); ov.arc(X(hover[0]), Y(hover[1]), brush * view.s, 0, Math.PI * 2); ov.stroke(); }
    }
    if (tool === 'bone' && boneDraft.length) {
      ov.strokeStyle = '#ffb454'; ov.lineWidth = 3; ov.beginPath();
      boneDraft.forEach(([x, y], i) => (i ? ov.lineTo(X(x), Y(y)) : ov.moveTo(X(x), Y(y))));
      if (hover) ov.lineTo(X(hover[0]), Y(hover[1]));
      ov.stroke();
      for (const [x, y] of boneDraft) { ov.beginPath(); ov.arc(X(x), Y(y), 5, 0, Math.PI * 2); ov.fillStyle = '#ffb454'; ov.fill(); }
    }
    if (tool === 'pose' && hover) { ov.strokeStyle = '#ff6b6b88'; ov.lineWidth = 1; ov.beginPath(); ov.arc(X(hover[0]), Y(hover[1]), brush * view.s, 0, Math.PI * 2); ov.stroke(); }
  }
  let hover: [number, number] | null = null;

  // ------------------------------------------------------------------ pointer: select, pan / zoom, mesh edit, pose recording, bend points
  type Drag = { kind: 'pan'; x: number; y: number; px: number; py: number }
    | { kind: 'verts'; mesh: EdMesh; picked: [number, number][]; last: [number, number] }
    | { kind: 'rest'; mesh: EdMesh; i: number; x0: number; y0: number; px: number; py: number }
    | { kind: 'paint'; mesh: EdMesh; sign: number }
    | { kind: 'rot'; def: EdDeformer; last: number }
    | { kind: 'lattice'; def: EdDeformer; i: number; last: [number, number] };
  let drag: Drag | null = null;

  /** Posing at the slider's rest value edits its first / rest key (how the part looks while that slider rests): say so
   *  once per slider, since every other movement blends from there. */
  const restNoted = new Set<string>();
  function restKeyNote() {
    const fp = doc ? findParam(doc, focusParam) : null;
    if (!fp || !pose || !atRest(fp.id) || restNoted.has(fp.id)) return;
    restNoted.add(fp.id);
    toast(`Editing the rest key of "${fp.name}": this is how the part looks while that slider rests. Undo (Ctrl+Z) if you meant another slider.`);
  }
  const atRest = (id: string) => { const p = doc ? findParam(doc, id) : null; return !!p && !!pose && Math.abs(pose.get(id) - p.def) < 1e-3; };

  function hitMesh(x: number, y: number): number {
    if (!doc || !built) return -1;
    const order = doc.meshes.map((m, i) => i).filter((i) => doc!.meshes[i].visible && doc!.meshes[i].opacity > 0).sort((a, b) => doc!.meshes[b].z - doc!.meshes[a].z);
    for (const i of order) {
      const P = placed[i], m = doc.meshes[i].mesh, t = textures[doc.meshes[i].tex];
      if (!P) continue;
      for (let k = 0; k + 2 < m.tri.length; k += 3) {
        const a = m.tri[k], b = m.tri[k + 1], c = m.tri[k + 2];
        const ax = P[a * 2], ay = P[a * 2 + 1], bx = P[b * 2], by = P[b * 2 + 1], cx = P[c * 2], cy = P[c * 2 + 1];
        const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(d) < 1e-9) continue;
        const w0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d, w1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d, w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const u = m.uv[a * 2] * w0 + m.uv[b * 2] * w1 + m.uv[c * 2] * w2, v = m.uv[a * 2 + 1] * w0 + m.uv[b * 2 + 1] * w1 + m.uv[c * 2 + 1] * w2;
        const px = Math.min(t.w - 1, Math.max(0, Math.floor(u * t.w))), py = Math.min(t.h - 1, Math.max(0, Math.floor(v * t.h)));
        if (t.rgba[(py * t.w + px) * 4 + 3] > 60) return i;
      }
    }
    return -1;
  }
  function hitHandle(x: number, y: number): Drag | null {
    if (!doc || !pose) return null;
    const r = 10 / view.s;
    for (const f of doc.deformers) {
      const s = pose.out.defs.get(f.id);
      if (!s) continue;
      if (f.kind === 'rotation') {
        const a = (s.angle * Math.PI) / 180, L = 46 / view.s;
        const ex = s.ox + Math.sin(a) * L, ey = s.oy - Math.cos(a) * L;
        if (Math.hypot(x - ex, y - ey) < r * 1.2 || Math.hypot(x - s.ox, y - s.oy) < r) return { kind: 'rot', def: f, last: Math.atan2(x - s.ox, -(y - s.oy)) };
      } else if (s.lattice && (f.id === selDef || doc.meshes.find((m) => m.id === sel)?.deformer === f.id)) {
        for (let k = 0; k < s.lattice.length / 2; k++) if (Math.hypot(x - s.lattice[k * 2], y - s.lattice[k * 2 + 1]) < r) return { kind: 'lattice', def: f, i: k, last: [x, y] };
      }
    }
    return null;
  }

  ovc.addEventListener('pointerdown', (e) => {
    if (!doc || !pose) return;
    root.focus({ preventScroll: true });
    const [x, y] = toCanvas(e);
    ovc.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2 && tool === 'look' || (tool === 'look' && e.shiftKey)) { drag = { kind: 'pan', x: e.clientX, y: e.clientY, px: userPan[0], py: userPan[1] }; return; }
    const mi = sel ? doc.meshes.findIndex((m) => m.id === sel) : -1;
    if (tool === 'pose' || tool === 'mesh') {
      const hd = tool === 'pose' ? hitHandle(x, y) : null;
      if (hd) { restKeyNote(); selDef = hd.kind === 'rot' || hd.kind === 'lattice' ? hd.def.id : selDef; hist.begin(doc); drag = hd; renderPanels(); return; }
      if (mi >= 0 && placed[mi]) {
        const P = placed[mi], em = doc.meshes[mi];
        if (tool === 'mesh') {
          if (em.mirrorOf) { toast('This part is a mirrored copy of another angle: edit the original and it follows.'); return; }
          const vi = pickVertex(P, x, y, 9 / view.s);
          if (vi >= 0 && (e.altKey || e.button === 2)) { edit(() => removeVertex(em, vi), true); return; }
          if (vi >= 0) { hist.begin(doc); drag = { kind: 'rest', mesh: em, i: vi, x0: x, y0: y, px: em.mesh.pos[vi * 2], py: em.mesh.pos[vi * 2 + 1] }; return; }
          return;
        }
        const picked: [number, number][] = [];
        for (let k = 0; k < P.length / 2; k++) { const d = Math.hypot(P[k * 2] - x, P[k * 2 + 1] - y); if (d < brush) picked.push([k, Math.pow(1 - d / brush, 1.5)]); }
        if (!picked.length) { const vi = pickVertex(P, x, y, 14 / view.s); if (vi >= 0) picked.push([vi, 1]); }
        if (picked.length) { restKeyNote(); hist.begin(doc); drag = { kind: 'verts', mesh: em, picked, last: [x, y] }; return; }
      }
    }
    if (tool === 'bend') { addBend(x, y); return; }
    if (tool === 'bone') {
      if (!sel) { const hit = hitMesh(x, y); if (hit >= 0) { sel = doc.meshes[hit].id; renderPanels(); } else toast('Click a part first.'); return; }
      boneDraft.push([x, y]); renderTools(); return;
    }
    if (tool === 'weights') {
      const em = sel ? doc.meshes.find((m) => m.id === sel) : undefined;
      if (!em || !selBone) { toast('Select a part and pick a bone (Bones tab) first.'); return; }
      hist.begin(doc); drag = { kind: 'paint', mesh: em, sign: e.altKey || e.button === 2 ? -1 : 1 };
      paintWeights(em, selBone, x, y, brush, 0.12 * drag.sign); builtStale = true; markChanged();
      return;
    }
    if (tool === 'slot' && slotTarget) {
      const hit = hitMesh(x, y);
      const v = nearestVertex(doc, x, y, hit >= 0 ? (m) => m.id === doc!.meshes[hit].id : () => true);
      const tgt = slotTarget;
      if (v) edit(() => { const X = doc!.extras ?? {}; const o = tgt.kind === 'particle' ? X.particles?.find((p) => p.id === tgt.id) : X.attachments?.find((a) => a.id === tgt.id); if (o) o.slot = v; });
      slotTarget = null; setTool('look'); toast('Moved.');
      return;
    }
    const hit = hitMesh(x, y);
    if (hit >= 0) { sel = doc.meshes[hit].id; if (tab === 'check') tab = 'part'; renderPanels(); }
    else if (tool === 'look') { drag = { kind: 'pan', x: e.clientX, y: e.clientY, px: userPan[0], py: userPan[1] }; }
  });
  ovc.addEventListener('dblclick', (e) => {
    if (tool === 'bone') { finishChain(); return; }
    if (!doc || tool !== 'mesh' || !sel) return;
    const em = doc.meshes.find((m) => m.id === sel);
    if (!em) return;
    const [x, y] = toCanvas(e);
    edit(() => addVertex(doc!, em, x, y), true);
  });
  ovc.addEventListener('contextmenu', (e) => e.preventDefault());
  ovc.addEventListener('pointermove', (e) => {
    if (!doc || !pose) return;
    const [x, y] = toCanvas(e);
    hover = [x, y];
    if (!drag) return;
    if (drag.kind === 'pan') { userPan = [drag.px + (e.clientX - drag.x), drag.py + (e.clientY - drag.y)]; return; }
    const param = findParam(doc, focusParam);
    // (relative to where the drag started: a rest key that was posed draws the part away from its rest mesh)
    if (drag.kind === 'rest') { moveVertex(doc, drag.mesh, drag.i, drag.px + x - drag.x0, drag.py + y - drag.y0); builtStale = true; return; }
    if (drag.kind === 'paint') { if (selBone) paintWeights(drag.mesh, selBone, x, y, brush, 0.06 * drag.sign); markChanged(); return; }
    if (!param) return;
    const vals = (id: string) => pose!.get(id);
    const keys = (id: string) => { const p = findParam(doc!, id); return p ? defaultKeys(p) : [0]; };
    if (drag.kind === 'verts') {
      const dx = x - drag.last[0], dy = y - drag.last[1];
      drag.last = [x, y];
      const em = drag.mesh, n = em.mesh.pos.length / 2;
      const pk = drag.picked;
      recordAt(em, [focusParam], vals, n, (v) => {
        for (const [i, w] of pk) { const [rx, ry] = unmapDelta(pose!, em.deformer, dx * w, dy * w, [em.mesh.pos[i * 2], em.mesh.pos[i * 2 + 1]]); nudge(v, n, i, rx, ry); }
      }, keys);
      builtStale = true;
    } else if (drag.kind === 'rot') {
      const s = pose.out.defs.get(drag.def.id);
      if (!s) return;
      const a = Math.atan2(x - s.ox, -(y - s.oy));
      let da = ((a - drag.last) * 180) / Math.PI; drag.last = a;
      if (da > 180) da -= 360; if (da < -180) da += 360;
      recordAt(drag.def, [focusParam], vals, 0, (v) => { v.a = (v.a ?? 0) + da; }, keys);
      builtStale = true;
    } else if (drag.kind === 'lattice') {
      const dx = x - drag.last[0], dy = y - drag.last[1];
      drag.last = [x, y];
      const f = drag.def, np = ((f.cols ?? 1) + 1) * ((f.rows ?? 1) + 1), i = drag.i;
      const [rx, ry] = unmapDelta(pose, f.parent, dx, dy);
      recordAt(f, [focusParam], vals, np, (v) => nudge(v, np, i, rx, ry), keys);
      builtStale = true;
    }
  });
  const endDrag = () => {
    if (!drag || !doc) { drag = null; return; }
    const d = drag;
    drag = null;
    if (d.kind !== 'pan') { hist.commit(doc); markChanged(d.kind === 'rest'); renderPanels(); }
  };
  ovc.addEventListener('pointerup', endDrag);
  ovc.addEventListener('pointercancel', endDrag);
  ovc.addEventListener('pointerleave', () => { hover = null; });
  ovc.addEventListener('wheel', (e) => {
    if (!doc) return;
    e.preventDefault();
    const k = Math.exp(-e.deltaY * 0.0015);
    const r = ovc.getBoundingClientRect();
    const mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2;
    const nz = Math.min(12, Math.max(0.3, userZoom * k)), f = nz / userZoom;
    userPan = [mx - (mx - userPan[0]) * f, my - (my - userPan[1]) * f];
    userZoom = nz;
  }, { passive: false });

  function addBend(x: number, y: number) {
    if (!doc) return;
    const em = sel ? doc.meshes.find((m) => m.id === sel) : undefined;
    if (!em) { toast('Pick the part that should bend first (click it), then click where it bends.'); return; }
    edit(() => {
      const id = uniqueId(`Bend_${em.name}`, (s) => doc!.deformers.some((f) => f.id === s));
      doc!.deformers.push({ id, name: `Bend point (${em.name})`, kind: 'rotation', parent: em.deformer, origin: [x, y], forms: [] });
      em.deformer = id;
      selDef = id;
    }, true);
    setTool('pose');
    toast('Bend point added. Pick a slider on the right, then drag the green handle to record how far it turns.');
  }
  function addLattice(em: EdMesh) {
    if (!doc) return;
    const t = doc.textures[em.tex];
    edit(() => {
      const id = uniqueId(`Lattice_${em.name}`, (s) => doc!.deformers.some((f) => f.id === s));
      const pad = Math.max(t.w, t.h) * 0.05;
      doc!.deformers.push({ id, name: `Lattice (${em.name})`, kind: 'warp', parent: em.deformer, rect: [t.x - pad, t.y - pad, t.w + pad * 2, t.h + pad * 2], cols: 4, rows: 4, forms: [] });
      em.deformer = id;
      selDef = id;
    }, true);
    setTool('pose');
    toast('Lattice added. Pick a slider on the right, then drag the purple points to record the bend.');
  }

  // keys
  root.addEventListener('keydown', (e) => {
    if (pictureStep) return;   // (the tap step is up: the maker's keys are off)
    if ((e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'text') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (!mod && ['1', '2', '3', '4', '5', '6'].includes(e.key)) setTool((['look', 'pose', 'mesh', 'bend', 'bone', 'weights'] as Tool[])[Number(e.key) - 1]);
    else if (e.key === 'Enter' && tool === 'bone') finishChain();
    else if (e.key === 'Escape' && !opts.onClose) escapeTool();   // (an overlay's Esc is handled for the whole window, below)
  });

  // Esc (AV-04 / cr-03). With a tool active it only puts the tool down; otherwise it leaves the maker through the same path as the
  // Close button. Not while the tap step is up (it has its own buttons) or a text field has focus. With changes that were not saved
  // or used, leaving asks with the app's own Save / Discard / Keep editing box: never window.confirm.
  function escapeTool(): boolean {
    if (tool === 'look' && !boneDraft.length && !slotTarget) return false;
    boneDraft = []; slotTarget = null; setTool('look');
    return true;
  }
  let leaveBox: HTMLElement | null = null, leaveOpener: HTMLElement | null = null;
  function closeLeaveBox() { leaveBox?.remove(); leaveBox = null; const o = leaveOpener; leaveOpener = null; (o && o.isConnected ? o : root).focus?.(); }
  /** Close button and Esc: straight out when nothing is unsaved, else the Save / Discard / Keep editing box. */
  function requestClose() {
    if (!opts.onClose || disposed) return;
    if (!dirty) { opts.onClose(); return; }
    if (leaveBox) return;
    leaveOpener = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
    const keep = h('button', { class: 'primary', 'data-r2e': 'keep-editing', onClick: closeLeaveBox }, 'Keep editing');
    const save$ = h('button', { 'data-r2e': 'save-leave', onClick: async () => {
      (save$ as HTMLButtonElement).disabled = true;
      try { await save(); } finally { (save$ as HTMLButtonElement).disabled = false; }
      if (!dirty) { closeLeaveBox(); opts.onClose?.(); }   // (a save that failed keeps the box and the maker open; its message is in the toast)
    } }, 'Save');
    const discard = h('button', { class: 'danger', 'data-r2e': 'discard', onClick: () => { dirty = false; closeLeaveBox(); opts.onClose?.(); } }, 'Discard');
    const title = h('h3', { id: 'r2e-leave-t' }, 'Save your changes?');
    leaveBox = h('div', { class: 'r2e-back', 'data-r2e': 'leave-dialog' },
      h('div', { class: 'r2e-dlg', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'r2e-leave-t' }, title,
        h('p', null, 'This avatar has changes that were not saved or used. Save keeps them in a file you can open here again. Discard throws them away.'),
        h('div', { class: 'r2e-btns' }, keep, save$, discard)));
    leaveBox.addEventListener('keydown', (ev) => {   // Tab stays inside the box
      if (ev.key !== 'Tab') return;
      const bs = Array.from(leaveBox!.querySelectorAll('button')) as HTMLButtonElement[], i = bs.indexOf(document.activeElement as HTMLButtonElement);
      ev.preventDefault(); bs[(i + (ev.shiftKey ? bs.length - 1 : 1)) % bs.length]?.focus();
    });
    root.append(leaveBox);
    keep.focus();
  }
  const onWindowKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || disposed || !opts.onClose || !root.isConnected) return;
    e.stopPropagation();   // nothing behind the full-window maker reacts to this Esc
    if (leaveBox) { e.preventDefault(); closeLeaveBox(); return; }   // Esc in the box = Keep editing
    if (pictureStep) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && ['text', 'search', 'number', 'url', 'email', 'password', ''].includes((t as HTMLInputElement).type)))) return;
    e.preventDefault();
    if (!escapeTool()) requestClose();
  };
  window.addEventListener('keydown', onWindowKey, true);

  // drag & drop files onto the editor
  root.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); root.querySelector('.r2e-drop')?.classList.add('hot'); });
  root.addEventListener('dragleave', () => root.querySelector('.r2e-drop')?.classList.remove('hot'));
  root.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    root.querySelector('.r2e-drop')?.classList.remove('hot');
    const f = Array.from(e.dataTransfer?.files ?? []);
    if (f.length) void open(f);
  });

  // ------------------------------------------------------------------ panels
  function finishChain() {
    if (!doc || !sel) return;
    const m = doc.meshes.find((x) => x.id === sel);
    if (!m || boneDraft.length < 2) return;
    const pts = boneDraft.slice();
    boneDraft = [];
    let first: string | null = null;
    edit(() => { first = makeChain(doc!, m, pts); }, true);
    selBone = first; tab = 'bones';
    setTool('look');
    toast('Bone chain made, with weights and swing. Paint weights to fine-tune which pixels each bone moves.');
  }
  function setTool(t: Tool) {
    if (tool === 'bone' && t !== 'bone') boneDraft = [];
    if (t === 'weights' && !selBone) { const b = (doc?.extras?.bones ?? []).find((x) => x.parent && doc!.meshes.find((m) => m.id === sel)?.skin?.[x.id]); if (b) selBone = b.id; }
    if (t === 'weights' || t === 'bone') tab = 'bones';
    tool = t;
    if (t === 'mesh' || t === 'bend' || t === 'bone' || t === 'weights') { pose?.resetValues(); for (const k of Object.keys(held2)) delete held2[k]; held = null; }
    if (t === 'pose') { if (drive !== 'still') { drive = 'still'; pose?.resetValues(); } tab = 'move'; }
    renderAll();
  }
  function setDrive(d: Drive) {
    drive = d;
    if (d === 'still') pose?.resetValues();
    if (tool === 'pose' && d !== 'still') tool = 'look';
    renderAll();
  }
  function renderAll() { renderTools(); renderPanels(); renderEmpty(); }

  function renderTop() {
    top.replaceChildren(...nn(
      h('h2', null, '2D avatar maker'),
      // (with nothing open the empty state below has the one art button and the sample: the bar does not repeat them)
      doc ? h('button', { onClick: () => fileIn.click(), title: 'A layered PSD, several PNG layers, or a 2D avatar you saved here' }, 'Open other art') : null,
      doc ? h('button', { onClick: () => void trySample() }, 'Try the sample') : null,
      doc ? h('button', { onClick: undo, disabled: !hist.canUndo, title: 'Undo (Ctrl+Z)' }, 'Undo') : null,
      doc ? h('button', { onClick: redo, disabled: !hist.canRedo, title: 'Redo (Ctrl+Y)' }, 'Redo') : null,
      h('span', { class: 'sp' }),
      doc ? h('span', { class: 'r2e-seg', role: 'group', 'aria-label': 'What moves the preview' },
        segBtn('Demo motion', drive === 'demo', () => setDrive('demo')),
        opts.getFrame ? segBtn('My camera', drive === 'camera', () => setDrive('camera')) : null,
        segBtn('Sliders', drive === 'still', () => setDrive('still'))) : null,
      doc ? h('button', { onClick: () => void save() }, `Save ${RIG2D.ext}`) : null,
      doc && opts.onUse ? h('button', { class: 'primary', onClick: () => void use(), disabled: !!(opts.useBlocked ?? useOff), title: opts.useBlocked ?? useOff ?? undefined }, opts.useLabel ?? 'Use this avatar') : null,
      opts.onClose ? h('button', { onClick: requestClose, 'aria-label': 'Close the 2D avatar maker' }, 'Close') : null,
    ));
  }
  const segBtn = (label: string, on: boolean, fn: () => void) => h('button', { class: on ? 'on' : '', onClick: fn, 'aria-pressed': on ? 'true' : 'false' }, label);

  function renderTools() {
    tools.replaceChildren();
    status.replaceChildren();
    if (!doc) return;
    const tb = (t: Tool, label: string, tip: string) => h('button', { class: tool === t ? 'on' : '', onClick: () => setTool(t), title: tip }, label);
    tools.append(tb('look', 'Look', 'Click a part to select it, drag to pan, scroll to zoom (1)'), tb('pose', 'Pose', 'Drag the art to record how it moves at the slider you picked (2)'),
      tb('mesh', 'Mesh', 'Move mesh points; double-click adds one, Alt+click removes one (3)'), tb('bend', 'Bend point', 'Click where the selected part bends (4)'),
      tb('bone', 'Bones', 'Click along a part from its root to its tip to give it a swinging bone chain (5)'), tb('weights', 'Weights', 'Paint which part of the picture a bone moves (6)'));
    if (tool === 'pose') {
      const p = findParam(doc, focusParam);
      status.append(h('span', { class: 'rec' }, `Recording "${p?.name ?? focusParam}" at ${(pose?.get(focusParam) ?? 0).toFixed(2)}${atRest(focusParam) ? ' (its rest key)' : ''}`));
      const b = h('input', { type: 'range', min: '4', max: '160', value: String(brush), 'aria-label': 'Brush size', style: 'width:120px;pointer-events:auto' }) as HTMLInputElement;
      b.addEventListener('input', () => { brush = Number(b.value); });
      status.append(h('span', null, 'Brush ', b));
    } else if (tool === 'mesh') status.append(h('span', null, sel ? 'Drag points to move them. Double-click: add a point. Alt+click: remove one.' : 'Click a part in the list to edit its mesh.'));
    else if (tool === 'bend') status.append(h('span', null, sel ? 'Click where the selected part should bend (a shoulder, an elbow, the root of a ponytail).' : 'Select a part first.'));
    else if (tool === 'bone') {
      status.append(h('span', null, !sel ? 'Select a part first (click it in the list).' : boneDraft.length ? `${boneDraft.length} point${boneDraft.length > 1 ? 's' : ''}: keep clicking toward the tip, then Finish.` : 'Click the root of the strand, then along it to the tip.'));
      if (boneDraft.length >= 2) { const f = h('button', { style: 'pointer-events:auto' }, 'Finish'); f.addEventListener('click', finishChain); status.append(f); }
      if (boneDraft.length) { const x = h('button', { style: 'pointer-events:auto' }, 'Cancel'); x.addEventListener('click', () => { boneDraft = []; renderTools(); }); status.append(x); }
    } else if (tool === 'weights') {
      const b = (doc.extras?.bones ?? []).find((x) => x.id === selBone);
      status.append(h('span', null, b ? `Painting "${b.name}" on ${doc.meshes.find((m) => m.id === sel)?.name ?? 'the selected part'}: drag to add, Alt + drag to take away.` : 'Pick a bone in the Bones tab first.'));
      const br = h('input', { type: 'range', min: '4', max: '200', value: String(brush), 'aria-label': 'Brush size', style: 'width:120px;pointer-events:auto' }) as HTMLInputElement;
      br.addEventListener('input', () => { brush = Number(br.value); });
      status.append(h('span', null, 'Brush ', br));
    } else if (tool === 'slot') status.append(h('span', null, 'Click on the avatar where it should sit.'));
  }

  function renderEmpty() {
    root.classList.toggle('nodoc', !doc);
    empty.replaceChildren();
    empty.style.display = doc ? 'none' : 'flex';
    if (doc) return;
    if (glErr) { empty.append(h('div', { class: 'r2e-drop' }, h('h3', null, 'Your browser cannot show the preview'), h('p', null, glErr), h('p', null, 'Update your browser (Chrome, Edge or Firefox) and open this page again.'))); return; }
    empty.append(h('div', { class: 'r2e-drop' },
      h('h3', null, 'Make a 2D avatar from your own art'),
      h('p', null, 'Drop a layered PSD here (or one PNG per part). We find the eyes, mouth, hair and the rest, rig them, and it moves straight away. No other software needed. Only one picture? Drop that: you tap the eyes and the mouth, and it comes to life.'),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onClick: () => fileIn.click() }, 'Choose your art'),
        h('button', { onClick: () => void trySample() }, 'Try the sample')),
      h('p', { style: 'margin-top:14px;font-size:12.5px' }, 'Tip: one part per layer works best (eyes, eyebrows, mouth, front hair, back hair, face, body). Names like "eye L" or "前髪" help, but we look at the pictures too.')));
  }

  function renderPanels() {
    renderTop();
    if (!doc) { left.replaceChildren(); right.replaceChildren(); return; }
    const keepL = left.scrollTop, keepR = lastTab === tab ? right.scrollTop : 0;
    lastTab = tab;
    queueMicrotask(() => { left.scrollTop = keepL; right.scrollTop = keepR; });
    renderParts();
    const tb = (t: Tab, label: string) => h('button', { class: tab === t ? 'on' : '', onClick: () => { tab = t; renderPanels(); } }, label);
    const qs = askable(doc, textures);
    right.replaceChildren(h('div', { class: 'r2e-tabs', role: 'tablist' }, tb('check', qs.filter((q) => !q.id.startsWith('what_')).length ? 'Check (!)' : 'Check'), tb('move', 'Sliders'), tb('part', 'Part'),
      tb('bones', 'Bones'), tb('light', 'Lighting'), tb('fx', 'Effects'), tb('moods', 'Moods'), tb('outfits', 'Outfits'), tb('physics', 'Physics'), tb('looks', 'Expressions')));
    if (tab === 'check') right.append(...checkPanel(qs));
    else if (tab === 'move') right.append(...movePanel());
    else if (tab === 'part') right.append(...partPanel());
    else if (tab === 'bones') right.append(...bonesPanel(panelCtx()));
    else if (tab === 'light') right.append(...lightPanel(panelCtx()));
    else if (tab === 'fx') right.append(...fxPanel(panelCtx()));
    else if (tab === 'moods') right.append(...moodsPanel(panelCtx()));
    else if (tab === 'outfits') right.append(...outfitsPanel(panelCtx(), (turn) => edit(() => { (doc!.extras ??= {}).turn = turn; applyAutoRig(doc!, textures, { turn }); }, true)));
    else if (tab === 'physics') right.append(...physicsPanel(), h('h4', null, 'Swinging bones'), ...chainCards(panelCtx()));
    else right.append(...looksPanel());
    renderTools();
  }

  function renderParts() {
    if (!doc) return;
    const list = h('div', { class: 'r2e-parts', role: 'listbox', 'aria-label': 'Parts' });
    const order = doc.meshes.slice().sort((a, b) => b.z - a.z);
    for (const m of order) {
      const vis = h('input', { type: 'checkbox', checked: m.visible, title: m.visible ? 'Shown (untick to hide)' : 'Hidden', 'aria-label': `Show ${m.name}`, onClick: (e: Event) => e.stopPropagation() }) as HTMLInputElement;
      vis.addEventListener('change', () => edit(() => { m.visible = vis.checked; }, true));
      list.append(h('div', { class: `r2e-part${m.id === sel ? ' sel' : ''}`, role: 'option', 'aria-selected': m.id === sel ? 'true' : 'false', onClick: () => { sel = m.id; tab = 'part'; renderPanels(); } },
        h('img', { src: thumb(m.tex), alt: '' }),
        h('div', { class: 'nm' }, m.name, doc.imported && m.role === 'unknown' ? h('span', { class: 'rl' }, m.group.split('/').pop() ?? '')
          : h('span', { class: `rl${m.role === 'unknown' ? ' unk' : ''}` }, `${ROLE_LABEL[m.role]}${m.side ? (m.side === 'L' ? ' (left)' : ' (right)') : ''}`)),
        vis));
    }
    left.replaceChildren(h('h4', null, `Parts (${doc.meshes.length})`), list);
  }

  function checkPanel(qs: Question[]): Node[] {
    if (!doc) return [];
    const out: Node[] = [];
    if (doc.imported) {
      // an imported model keeps its own rig: no roles to check, no automatic rig to redo
      const im = doc.imported;
      out.push(h('div', { class: 'r2e-card good' }, h('p', null, h('b', null, 'This avatar came from an imported model.')),
        h('p', { class: 'r2e-dim' }, `Its ${doc.meshes.length} parts, ${doc.params.length} sliders and the way it moves came over. Change parts, sliders, limits, expressions and outfits here, then save: it is saved as a maker avatar.`)));
      out.push(h('div', { class: 'r2e-card' }, h('p', null, h('b', null, im.notes.length ? 'What changed on the way in' : 'Nothing changed on the way in')),
        ...(im.notes.length ? im.notes.map((n) => h('p', { class: 'r2e-dim' }, n)) : [h('p', { class: 'r2e-dim' }, 'Everything moves as it did before.')])));
      return out;
    }
    const real = qs.filter((q) => !q.id.startsWith('what_'));
    const rigged = doc.meshes.filter((m) => m.role !== 'unknown').length;
    out.push(h('div', { class: `r2e-card${real.length ? '' : ' good'}` },
      h('p', null, h('b', null, real.length ? 'Almost there' : 'Your avatar is rigged and moving.')),
      h('p', { class: 'r2e-dim' }, `We understood ${rigged} of ${doc.meshes.length} parts. ${real.length ? 'Answer the question below so everything moves.' : 'Try it with your camera, then press "Use this avatar".'}`)));
    for (const q of qs) out.push(questionCard(q));
    const got = h('div', null);
    for (const [label, roles] of ROLE_GROUPS) {
      const ms = doc.meshes.filter((m) => roles.includes(m.role));
      if (!ms.length) continue;
      got.append(h('h4', null, label), h('div', { class: 'r2e-got' }, ...ms.map((m) => h('span', { title: m.name }, h('img', { src: thumb(m.tex), alt: '' }), `${ROLE_LABEL[m.role]}${m.side ? ` ${m.side === 'L' ? 'left' : 'right'}` : ''}`))));
    }
    out.push(h('div', { class: 'r2e-card' }, h('p', null, h('b', null, 'What we found')), got));
    const notes = (doc.report?.notes ?? []).filter((n) => !/not understood/.test(n));
    if (notes.length) out.push(h('div', { class: 'r2e-card' }, ...notes.map((n) => h('p', { class: 'r2e-dim' }, n))));
    const dens = range(0.1, 1, 0.05, density, (v) => { density = v; }, 'Mesh detail');
    out.push(h('div', { class: 'r2e-card' }, h('p', null, h('b', null, 'Rig again')),
      h('p', { class: 'r2e-dim' }, 'Rebuilds the automatic movement from each part\'s role. Anything you recorded by hand is kept.'),
      dens,
      h('div', { class: 'r2e-btns' }, h('button', { onClick: () => edit(() => { for (const m of doc!.meshes) if (!m.generated) remeshAuto(doc!, textures, m, density); applyAutoRig(doc!, textures); }, true) }, 'Rig again'))));
    return out;
  }

  function questionCard(q: Question): HTMLElement {
    const card = h('div', { class: 'r2e-card r2e-q' }, h('p', null, h('b', null, q.text)));
    const meshes = q.candidates.map((id) => doc!.meshes.find((m) => m.id === id)!).filter(Boolean);
    if (q.role === 'unknown') {
      const m = meshes[0];
      card.append(h('div', { class: 'pics' }, h('div', { class: 'pic' }, h('img', { src: thumb(m.tex), alt: m.name }))));
      card.append(h('div', { class: 'choices' }, ...WHAT_CHOICES.map((c) => h('button', { onClick: () => { edit(() => answer(doc!, textures, q, [m.id], c.role), true); toast('Thanks, done.'); } }, c.label))));
      return card;
    }
    card.append(h('div', { class: 'pics' }, ...meshes.map((m) => h('button', { 'aria-label': `This one (${m.name})`, title: 'This one', onClick: () => { edit(() => answer(doc!, textures, q, [m.id]), true); toast('Thanks, it is rigged now.'); } }, h('img', { src: thumb(m.tex), alt: m.name })))));
    card.append(h('button', { onClick: () => { card.remove(); } }, 'It has none'));
    return card;
  }

  function range(min: number, max: number, step: number, value: number, onInput: (v: number) => void, label: string, fmt = (v: number) => v.toFixed(2), onCommit?: () => void): HTMLElement {
    const inp = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label }) as HTMLInputElement;
    const v = h('span', { class: 'v' }, fmt(value));
    inp.addEventListener('input', () => { onInput(Number(inp.value)); v.textContent = fmt(Number(inp.value)); });
    if (onCommit) inp.addEventListener('change', onCommit);
    return h('div', null, h('div', { class: 'r2e-row' }, h('label', null, label), v), inp);
  }

  function movePanel(): Node[] {
    if (!doc || !pose) return [];
    const out: Node[] = [];
    out.push(h('p', { class: 'r2e-dim' }, drive === 'still' ? 'Move a slider to see that movement. To change a movement: pick its slider, jump to one of its keys (the first ones too, where it rests), press "Record this movement" and drag the art.' : 'The preview is moving by itself. Choose "Sliders" at the top to try each movement by hand.'));
    const groups = new Map<string, typeof doc.params>();
    // (a part's swing amount only scales motion, which posing by hand doesn't have: it lives on the Physics tab's cards)
    const amounts = new Set((doc.extras?.dynamics ?? []).map((y) => y.amount).filter(Boolean));
    for (const p of doc.params) { if (amounts.has(p.id)) continue; const g = p.group ?? 'Other'; if (!groups.has(g)) groups.set(g, []); groups.get(g)!.push(p); }
    const target = (sel && doc.meshes.find((m) => m.id === sel)) || (selDef && doc.deformers.find((f) => f.id === selDef)) || null;
    for (const [g, ps] of groups) {
      out.push(h('h4', null, g));
      for (const p of ps) {
        const focus = p.id === focusParam;
        const row = h('div', { class: `r2e-prm${focus ? ' focus' : ''}` });
        const sl = range(p.min, p.max, (p.max - p.min) / 200, pose.get(p.id), (v) => { if (drive !== 'still') setDrive('still'); pose!.set(p.id, v); }, p.name, (v) => v.toFixed(2));
        row.append(sl);
        row.addEventListener('pointerdown', () => { if (focusParam !== p.id) { focusParam = p.id; renderPanels(); } }, { capture: true });
        if (focus) {
          const form = target?.forms.find((f) => f.axes.length === 1 && f.axes[0].param === p.id);
          const keys = form ? form.axes[0].keys : defaultKeys(p);
          row.append(h('div', { class: 'keys' }, h('span', { class: 'r2e-dim', style: 'font-size:11.5px' }, 'Keys:'), ...keys.map((k) => { const rest = Math.abs(k - p.def) < 1e-6, on = Math.abs(pose!.get(p.id) - k) < 1e-3; return h('button', { class: on ? 'on' : '', onClick: () => { if (drive !== 'still') setDrive('still'); pose!.set(p.id, k); renderPanels(); }, title: rest ? 'Jump to the rest key (how the part looks while this slider rests): you can record it like any other key' : 'Jump to this key' }, `${Math.round(k * 100) / 100}${rest ? ' (rest)' : ''}`); })),
            h('div', { class: 'r2e-btns' }, h('button', { class: tool === 'pose' ? 'on' : '', onClick: () => setTool(tool === 'pose' ? 'look' : 'pose') }, tool === 'pose' ? 'Recording: drag the art' : 'Record this movement'),
              target && form ? h('button', { onClick: () => edit(() => { const v = pose!.get(p.id); const k = form.axes[0].keys.findIndex((x) => Math.abs(x - v) < 1e-3); if (k >= 0) form.values[k] = null; }), title: 'Put the selected part back to rest at this key' }, 'Clear this key') : null));
        }
        out.push(row);
      }
    }
    out.push(h('div', { class: 'r2e-btns' }, h('button', { onClick: () => { pose!.resetValues(); renderPanels(); } }, 'All sliders to rest')));
    return out;
  }

  function panelCtx(): PanelCtx {
    return {
      h: h as PanelCtx['h'], doc: doc!, textures, sel, selBone, tool, extras, light,
      setSelBone: (id) => { selBone = id; renderPanels(); },
      fire: (kind, value) => {
        extras?.fire(kind, value);
        if (kind === 'emotion') tryEmotion = { name: value, until: (performance.now() - t0) / 1000 + 2.5 };
        else rt?.fire(kind, value);
        if (drive === 'still') setDrive('demo');
      },
      edit: (fn, topo) => edit(fn, topo),
      toast: (m, e) => toast(m, e),
      setTool: (t) => setTool(t as Tool),
      lightChanged: () => { renderPanels(); },
      range, thumb, rerender: () => { for (const co of doc?.extras?.costumes ?? []) rt?.anim.setLayer(co.id, extras?.costumeOn.get(co.id) ?? co.on); renderPanels(); },
      texChanged: () => { texVersion++; thumbs.clear(); markChanged(true); },
      placeSlot: (kind, id) => { slotTarget = { kind, id }; setTool('slot'); },
      wind: windOn, setWind: (on) => { windOn = on; setRig2DWorld({ wind: on ? 1.2 : 0.3 }); renderPanels(); },
      landmarks: () => (doc ? landmarksOf(doc, doc.meshes) : null),
      tune: (id, t) => { rt?.anim.tuneDynamic(id, t); anim?.tuneDynamic(id, t); },
      liveParam: (id, v) => { for (const d of [built?.doc, rt?.ev.doc]) { const p = d?.params.find((q) => q.id === id); if (p) p.default = v; } pose?.set(id, v); },
      liveBegin: () => { if (doc) hist.begin(doc); },
      liveCommit: () => { if (!doc) return; dirty = true; hist.commit(doc); markChanged(); renderPanels(); },
      pickPng: () => new Promise((res) => {
        const inp = h('input', { type: 'file', accept: '.png,.webp,.gif,.jpg,.jpeg', style: 'display:none' }) as HTMLInputElement;
        root.append(inp);
        inp.addEventListener('change', async () => {
          const f = inp.files?.[0]; inp.remove();
          if (!f) { res(null); return; }
          try { const d = await decodePng(new Uint8Array(await f.arrayBuffer())); res({ name: f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 40), ...d }); } catch { toast('That picture could not be read.', true); res(null); }
        });
        inp.click();
      }),
    };
  }

  function partPanel(): Node[] {
    if (!doc) return [];
    const m = sel ? doc.meshes.find((x) => x.id === sel) : undefined;
    if (!m) return [h('p', { class: 'r2e-dim' }, 'Click a part in the picture or in the list on the left.')];
    const t = doc.textures[m.tex];
    const field = (label: string, el: HTMLElement) => h('label', { class: 'r2e-field' }, h('span', null, label), el);
    const nameIn = h('input', { type: 'text', value: m.name }) as HTMLInputElement;
    nameIn.addEventListener('change', () => edit(() => { m.name = nameIn.value.slice(0, 80) || m.name; }));
    const roleSel = h('select', null, ...ROLES.map((r) => h('option', { value: r, selected: r === m.role }, ROLE_LABEL[r]))) as HTMLSelectElement;
    roleSel.addEventListener('change', () => edit(() => { m.role = roleSel.value as Role; m.depth = ROLE_DEPTH[m.role] ?? m.depth; m.deformer = null; if (!SIDED.has(m.role)) m.side = null; applyAutoRig(doc!, textures); }, true));
    const sideSel = h('select', { disabled: !SIDED.has(m.role) }, h('option', { value: '', selected: !m.side }, 'Middle'), h('option', { value: 'L', selected: m.side === 'L' }, 'Left (picture right)'), h('option', { value: 'R', selected: m.side === 'R' }, 'Right (picture left)')) as HTMLSelectElement;
    sideSel.addEventListener('change', () => edit(() => { m.side = (sideSel.value || null) as EdMesh['side']; applyAutoRig(doc!, textures); }, true));
    const clipSel = h('select', null, h('option', { value: '' }, 'Nothing (always visible)'), ...doc.meshes.filter((x) => x.id !== m.id).map((x) => h('option', { value: x.id, selected: m.masks.includes(x.id) }, x.name))) as HTMLSelectElement;
    clipSel.addEventListener('change', () => edit(() => { m.masks = clipSel.value ? [clipSel.value] : []; }, true));
    const blendSel = h('select', null, ...(['normal', 'multiply', 'screen', 'add'] as const).map((b) => h('option', { value: b, selected: m.blend === b }, b === 'normal' ? 'Normal' : b === 'multiply' ? 'Shadow (multiply)' : b === 'screen' ? 'Light (screen)' : 'Glow (add)'))) as HTMLSelectElement;
    blendSel.addEventListener('change', () => edit(() => { m.blend = blendSel.value as EdMesh['blend']; }, true));
    const zs = doc.meshes.map((x) => x.z).sort((a, b) => a - b);
    const move = (dir: 1 | -1) => edit(() => {
      const sorted = doc!.meshes.slice().sort((a, b) => a.z - b.z);
      const i = sorted.indexOf(m), j = i + dir;
      if (j < 0 || j >= sorted.length) return;
      const o = sorted[j], z = m.z; m.z = o.z; o.z = z;
      if (m.z === o.z) m.z += dir;
    }, true);
    void zs;
    return [
      h('div', { class: 'r2e-card' }, h('img', { src: thumb(m.tex), alt: '', style: 'width:64px;height:64px;object-fit:contain;float:right;background:#8882;border-radius:8px' }),
        h('p', null, h('b', null, m.name)), h('p', { class: 'r2e-dim' }, `${m.mesh.pos.length / 2} points, ${m.mesh.tri.length / 3} triangles. ${t.w}x${t.h} px.`), h('div', { style: 'clear:both' })),
      // (an imported model's parts keep their own movement: no role / side / depth, which only steer the automatic rig)
      field('Name', nameIn), ...(doc.imported ? [] : [field('What is it', roleSel), field('Side', sideSel)]), field('Show only inside', clipSel), field('Blend', blendSel),
      range(0, 1, 0.01, m.opacity, (v) => { m.opacity = v; builtStale = true; }, 'Opacity', (v) => `${Math.round(v * 100)} %`, () => edit(() => {})),
      ...(doc.imported ? [] : [range(-0.8, 0.8, 0.01, m.depth, (v) => { m.depth = v; }, 'Depth when the head turns', (v) => v.toFixed(2), () => edit(() => applyAutoRig(doc!, textures), true))]),
      h('div', { class: 'r2e-btns' }, h('button', { onClick: () => move(1) }, 'Bring forward'), h('button', { onClick: () => move(-1) }, 'Send back')),
      h('h4', null, 'Mesh'),
      range(0.05, 1, 0.05, density, (v) => { density = v; }, 'Detail'),
      h('div', { class: 'r2e-btns' }, h('button', { onClick: () => edit(() => { remeshAuto(doc!, textures, m, density); applyAutoRig(doc!, textures); }, true) }, 'Rebuild mesh'), h('button', { onClick: () => setTool('mesh') }, 'Edit points')),
      h('h4', null, 'Look'),
      range(0, 1, 0.01, m.glow ?? 0, (v) => { m.glow = v; }, 'Glows in the dark', (v) => (v ? `${Math.round(v * 100)} %` : 'no'), () => edit(() => {})),
      range(0, 8, 0.5, m.outline?.width ?? 0, (v) => { if (v > 0) m.outline = { width: v, color: m.outline?.color ?? [40, 28, 50], opacity: 1, light: m.outline?.light }; else delete m.outline; }, 'Outline', (v) => (v ? `${v} px` : 'off'), () => edit(() => {}, true)),
      h('h4', null, 'Bending'),
      h('p', { class: 'r2e-dim' }, `Moves with: ${m.deformer ? doc.deformers.find((f) => f.id === m.deformer)?.name ?? m.deformer : 'nothing'}`),
      h('div', { class: 'r2e-btns' }, h('button', { onClick: () => setTool('bend') }, 'Add a bend point'), h('button', { onClick: () => addLattice(m) }, 'Add a lattice')),
    ];
  }

  function physicsPanel(): Node[] {
    if (!doc) return [];
    const out: Node[] = [h('p', { class: 'r2e-dim' }, 'Hair and other loose parts swing when you move. Physics runs while the preview moves (demo motion or your camera).')];
    out.push(h('label', { class: 'r2e-field' }, h('span', null, 'Physics'), (() => { const c = h('input', { type: 'checkbox', checked: physicsOn }) as HTMLInputElement; c.addEventListener('change', () => { physicsOn = c.checked; if (built && ev) anim = new Animator(built.doc, built.buffers, ev, { physics: physicsOn }); }); return c; })()));
    const own = !!(doc.imported?.physics?.length || doc.imported?.dynamics?.length);
    if (own) out.push(h('div', { class: 'r2e-card' }, h('p', null, h('b', null, 'This model\'s own swing')),
      h('p', { class: 'r2e-dim' }, 'Its hair and clothes swing exactly as before. Swing you add here comes on top; the model\'s own swing settings can\'t be changed here yet.')));
    if (!own && !doc.physics.length && !(doc.extras?.dynamics ?? []).some((y) => y.kind === 'chain')) out.push(h('p', null, 'No swinging parts (no hair layers found).'));
    for (const p of doc.physics) {
      out.push(h('div', { class: 'r2e-card' }, h('p', null, h('b', null, p.name)),
        range(20, 2000, 10, p.length, (v) => { p.length = v; }, 'Length (slower swing)', (v) => `${Math.round(v)}`, () => edit(() => {})),
        range(0, 1, 0.01, 1 - p.damping, (v) => { p.damping = 1 - v; }, 'Bounce', (v) => `${Math.round(v * 100)} %`, () => edit(() => {})),
        range(0, 3, 0.05, p.gain, (v) => { p.gain = v; }, 'Swing amount', (v) => (v <= 0 ? 'still' : `${Math.round(v * 100)} %`), () => edit(() => {}))));
    }
    return out;
  }

  function looksPanel(): Node[] {
    if (!doc || !pose) return [];
    const out: Node[] = [h('p', { class: 'r2e-dim' }, 'Expressions you can switch on with a hotkey while live. Press "Try" to see one.')];
    for (const e of doc.expressions) {
      out.push(h('div', { class: 'r2e-row', style: 'grid-template-columns:1fr auto auto' }, h('label', null, e.name),
        h('button', { class: held === e ? 'on' : '', onClick: () => { held = held === e ? null : e; renderPanels(); } }, held === e ? 'Trying' : 'Try'),
        h('button', { onClick: () => edit(() => { doc!.expressions = doc!.expressions.filter((x) => x !== e); if (held === e) held = null; }), 'aria-label': `Delete ${e.name}` }, 'Delete')));
    }
    const nm = h('input', { type: 'text', placeholder: 'Name, e.g. Smug' }) as HTMLInputElement;
    out.push(h('h4', null, 'New expression'), h('p', { class: 'r2e-dim' }, 'Set the sliders (Sliders at the top), then save that look:'), nm,
      h('div', { class: 'r2e-btns' }, h('button', { onClick: () => {
        const params = doc!.params.filter((p) => Math.abs(pose!.get(p.id) - p.def) > 1e-3).map((p) => ({ param: p.id, value: Math.round(pose!.get(p.id) * 1000) / 1000, blend: 'overwrite' as const }));
        if (!params.length) { toast('Move some sliders first: the expression is the difference from rest.'); return; }
        const label = nm.value.trim() || `Expression ${doc!.expressions.length + 1}`;
        edit(() => { doc!.expressions.push({ id: uniqueId(label.toLowerCase(), (s) => doc!.expressions.some((x) => x.id === s)), name: label, params }); });
        toast(`Saved "${label}".`);
      } }, 'Save this look')));
    return out;
  }

  async function trySample() {
    busy('Opening the sample character…');
    await new Promise((r) => setTimeout(r, 30));
    try {
      if (opts.sample) { openArt(opts.sample(), 'Sample character'); return; }
      // the real sample: a finished, rig-ready PSD (public/samples/), fetched only when asked; offline, the drawn one
      const real = await loadBundledSample();
      if (real) { openArt(real, 'Stella'); return; }
      await preloadSample(); openArt(sampleArt(), 'Sample character');
    } finally { busy(null); }
  }

  // ------------------------------------------------------------------ save / use
  async function pack(): Promise<Uint8Array | null> {
    if (!doc) return null;
    busy('Packing your avatar…');
    try {
      const r = await packRig(doc, textures, encodePng);
      if (r.issues.length) { toast(`Could not save: ${r.issues[0].path}: ${r.issues[0].message}`, true); return null; }
      return r.bytes;
    } finally { busy(null); }
  }
  async function save(): Promise<Uint8Array | null> {
    const bytes = await pack();
    if (!bytes) return null;
    const file = `${name.replace(/[\\/:*?"<>|]+/g, '_') || 'avatar'}${RIG2D.ext}`;
    if (opts.onSave) await opts.onSave(bytes, file); else download(bytes, file, RIG2D.mime);
    dirty = false;
    toast(`Saved ${file}. Open it here again any time to keep editing.`);
    return bytes;
  }
  async function use() {
    const off = opts.useBlocked ?? useOff;
    if (off) { toast(off, true); return; }
    const bytes = await pack();
    if (!bytes || !opts.onUse) return;
    const thumbPng = await snapshotPng();
    // (false = it did not land: the changes stay "not saved" so Close still asks)
    if ((await opts.onUse(bytes, name, thumbPng)) !== false) dirty = false;
  }
  async function snapshotPng(): Promise<Uint8Array> {
    const c = document.createElement('canvas'); c.width = 256; c.height = 256;
    const ctx = c.getContext('2d')!;
    const s = Math.min(256 / glc.width, 256 / glc.height);
    ctx.drawImage(glc, (256 - glc.width * s) / 2, (256 - glc.height * s) / 2, glc.width * s, glc.height * s);
    const b = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
    return new Uint8Array(b ? await b.arrayBuffer() : new ArrayBuffer(0));
  }

  // ------------------------------------------------------------------ start
  renderAll();
  raf = requestAnimationFrame(tick);
  const vis = () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else if (!raf && !disposed) { lastT = performance.now(); raf = requestAnimationFrame(tick); } };
  document.addEventListener('visibilitychange', vis);
  if (opts.files?.length) void open(opts.files).then(() => { if (opts.useBlocked) toast(opts.useBlocked, true); });
  else if (opts.useBlocked) toast(opts.useBlocked, true);

  return {
    el: root,
    open,
    openArt,
    setDrive,
    setParams(v) {
      if (drive !== 'still') setDrive('still');
      for (const k of Object.keys(held2)) delete held2[k];
      pose?.resetValues();
      for (const [k, x] of Object.entries(v)) { held2[k] = x; pose?.set(k, x); }
    },
    save: async () => pack(),
    notify: (msg, err) => toast(msg, !!err),
    debug: {
      pointOf(nm) {
        const i = doc?.meshes.findIndex((m) => m.name === nm) ?? -1;
        const P = i >= 0 ? placed[i] : null;
        if (!P) return null;
        let x = 0, y = 0; for (let k = 0; k < P.length; k += 2) { x += P[k]; y += P[k + 1]; }
        x /= P.length / 2; y /= P.length / 2;
        const r = ovc.getBoundingClientRect(), dpr = ovc.width / Math.max(1, r.width);
        return [r.left + (x * view.s + view.ox) / dpr, r.top + (y * view.s + view.oy) / dpr];
      },
      handForms(nm) { return doc?.meshes.find((m) => m.name === nm)?.forms.filter((f) => !f.auto).length ?? 0; },
      bones() { return doc?.extras?.bones?.length ?? 0; },
      /** How much a part swings in the running preview now: Σ|its bones' physics angle| (deg) and |its head-turn sway| (tests). */
      swing(nm) {
        const m = doc?.meshes.find((x) => x.name === nm);
        if (!rt || !m) return null;
        let bones = 0, kick = 0;
        (rt.built.doc.bones ?? []).forEach((b, i) => { if (b.id.startsWith('auto_') && b.id.includes(m.id)) bones += Math.abs(rt!.ev.boneAngleAdd[i]); });
        rt.built.doc.params.forEach((p, i) => { if (p.id.startsWith('ParamSwing_') && p.id.includes(m.id)) kick += Math.abs(rt!.ev.values[i]); });
        return { bones, kick };
      },
      skinOf(nm) { const m = doc?.meshes.find((x) => x.name === nm); const w = m?.skin && selBone ? m.skin[selBone] : null; return w ? w.reduce((a, b) => a + b, 0) : 0; },
      extras() { const X = doc?.extras; return X ? { bones: X.bones?.length ?? 0, chains: X.dynamics?.filter((y) => y.kind === 'chain').length ?? 0, particles: X.particles?.length ?? 0, attachments: X.attachments?.length ?? 0, costumes: X.costumes?.length ?? 0, views: X.views?.sets.length ?? 0, moods: X.states?.length ?? 0, lighting: !!X.lighting?.maps, parts: X.parts?.length ?? 0 } : null; },
      select(nm) { const m = doc?.meshes.find((x) => x.name === nm); if (m) { sel = m.id; renderPanels(); } },
    },
    info: () => ({ name, parts: doc?.meshes.length ?? 0, understood: doc?.meshes.filter((m) => m.role !== 'unknown').length ?? 0, questions: doc ? askable(doc, textures).length : 0,
      vertices: doc?.meshes.reduce((s, m) => s + m.mesh.pos.length / 2, 0) ?? 0, built: !builtStale, issues: built?.issues.length ?? 0, drive, fps, msFrame: perf.frame, msOverlay: perf.overlay, preview: rtc.style.display === 'none' ? 'editor' : 'runtime' }),
    dispose() {
      disposed = true; pictureStep?.dispose(); clearTimeout(pictureTimer);
      removeEventListener('beforeunload', askBeforeLeaving);
      window.removeEventListener('keydown', onWindowKey, true);
      cancelAnimationFrame(raf);
      clearTimeout(buildTimer); clearTimeout(toastTimer);
      document.removeEventListener('visibilitychange', vis);
      gl?.dispose();
      rt?.dispose();
      root.remove();
    },
  };
}

let sampleCache: (() => ArtSet) | null = null;
function sampleArt(): ArtSet {
  if (!sampleCache) throw new Error('sample not loaded');
  return sampleCache();
}
/** "Try the sample": Stella, an original character made with AI image tools and split into a rig-ready layered PSD
 *  (30 layers: eyes in parts with a drawn closed eye, mouth inside / teeth / tongue, front / side / back hair, a hair
 *  shadow clipped to the face). Shipped gzipped in public/samples/ (~10 MB) and fetched only when someone asks. */
const SAMPLE_URL = `${(import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'}samples/pro2d-sample.psd.gz`;
let bundledSample: Promise<ArtSet | null> | null = null;
export function loadBundledSample(): Promise<ArtSet | null> {
  bundledSample ??= (async () => {
    try {
      const r = await fetch(SAMPLE_URL);
      if (!r.ok) return null;
      let bytes = new Uint8Array(await r.arrayBuffer());
      // a server may already have undone the gzip (Content-Encoding): only gunzip what is still gzip
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        if (typeof DecompressionStream === 'function') bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
        else { const { gunzipSync } = await import('three/examples/jsm/libs/fflate.module.js'); bytes = gunzipSync(bytes); }
      }
      const { parsePsd } = await import('../../shared/rig2d/edit/psd.ts');
      const { fitArt } = await import('../../shared/rig2d/edit/layers.ts');
      const f = await parsePsd(bytes);
      return f.layers.length ? fitArt({ width: f.width, height: f.height, layers: f.layers, warnings: f.warnings }) : null;
    } catch { return null; }
  })();
  const p = bundledSample;
  void p.then((v) => { if (!v && bundledSample === p) bundledSample = null; });   // a failed fetch may be retried
  return p;
}

/** The procedural sample (tests, and the fallback when the real one can't be fetched) is loaded lazily (it computes
 *  its pictures, ~0.5 s): call before opening the editor. */
export async function preloadSample() { if (!sampleCache) { const m = await import('../../shared/rig2d/edit/sampleArt.ts'); sampleCache = () => m.makeSampleCharacter(); } }

/** Open the 2D avatar maker over the whole window (its own Close button). */
export function openRig2DEditor(opts: Rig2DEditorOpts = {}): Rig2DEditorHandle {
  injectEditorStyle();
  const shell = document.createElement('div');
  shell.className = 'r2e-overlay';
  document.body.append(shell);
  void preloadSample();
  const prevClose = opts.onClose;
  let closed = false;
  const close = () => { if (closed) return; closed = true; inner.dispose(); shell.remove(); prevClose?.(); };
  const inner = mountRig2DEditor(shell, { ...opts, onClose: close });
  // disposing the overlay's handle closes the whole overlay
  return { ...inner, dispose: close };
}


