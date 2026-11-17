// "Add my model": the helper for people bringing their own avatar (owner: "make sure the program can configure it
// properly or run someone through configuring a model if they want to do it manually").
// Drop / choose a file → automatic check with a plain-words report card → "Set it up for me" (face-shape matching,
// mouth, eyes incl. painted-eye replacement, materials, size, camera, hair physics; progress + before / after) or
// "Walk me through it" (one thing per step, live preview, test buttons, undo / skip / back, ending with the 8-angle
// check) → saved into the performer's avatars with the existing calls (POST /api/avatars/import + PUT
// /api/avatars/:id + thumbnail), which the helper or, in the browser version, this browser's storage answers
// (CONTRACT §10). The shell is src/ui/onboard/shell.ts (shared with "Add my room"); the logic is
// src/onboarding/modelCheck.ts; the preview is src/onboarding/modelPreview.ts. Docs: docs/AVATARS_SIMPLE.md
// "Add my model". Nothing reaches the stream until "Use it now".
import type { App } from '../app.ts';
import type { AvatarProfile, SurfaceMarker } from '../../shared/types.ts';
import { normalizeProfile } from '../../shared/defaults.ts';
import { IMPORT_ACCEPT, checkFormat } from '../../shared/importCheck.ts';
import { readNative, fmtM } from '../../shared/avatarSize.ts';
import { classifyMorph } from '../../shared/morphNames.ts';
import { api, waitJob } from '../api.ts';
import { guessSoftRig } from '../avatar/softRig.ts';
import { FACE_ROLES, friendlyShapeName, perfectSync, applyPatch, autoPlan, faceCaps, fileLine, manualSteps as stepIds, needsRebuild, reportCard, reportSummary, suggestFaceMap, type ModelFacts, type ProfilePatch } from '../onboarding/modelCheck.ts';
import { ModelPreview, TESTS } from '../onboarding/modelPreview.ts';
import { button, h, toast } from './dom.ts';
import { add, pill, seg } from './bits.ts';
import { helperAvailable, forceHelper } from './onboard/links.ts';
import { anglesGrid, openOnboarding, whyNote, type AutoTask, type OnboardKind, type OnboardStep, type OpenResult, type SaveResult, type ShellUi, type TestButton } from './onboard/shell.ts';

export interface ModelWizardDeps {
  /** After a save (refresh the avatar lists). */
  onDone?(id: string): void;
  /** Test hook (observer pages only): replaces the upload + save; never touches the network. */
  fakeSave?: 'helper' | 'browser';
  /** Settings found by the "just drop a model" import (src/ui/dropImport.ts): name, turn, faceMap, rig.boneMap. */
  seed?: ProfilePatch;
  /** Test hook (observer pages only): a recording stand-in for the save calls, so the real save code runs with no
   *  network at all (window.__vtpWizardSaves lists the calls). */
  store?: Pick<typeof api, 'import' | 'save' | 'thumbnail' | 'autorig'>;
}

const FORMATS = 'VRoid Studio (.vrm), .glb or .gltf open right here. .fbx, .obj, .blend and other 3D files are converted by VTube Pro.';
const cleanName = (file: string) => (file.replace(/\.[^.]+$/, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'My model').replace(/^./, (c) => c.toUpperCase());
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** Profile fields the wizard configures (copied onto the saved avatar). */
const CONFIGURED = ['name', 'transform', 'eyes', 'mouth', 'brows', 'look', 'blush', 'physics', 'faceMap', 'size', 'body'] as const;

class ModelKind implements OnboardKind {
  readonly kind = 'model' as const;
  readonly noun = 'model';
  readonly title = 'Add my model';
  readonly accept = IMPORT_ACCEPT;
  readonly formats = FORMATS;
  readonly guide = 'AVATARS_SIMPLE.md#add-my-model';
  private pv: ModelPreview | null = null;
  private file: File | null = null;
  private profile: AvatarProfile | null = null;
  private facts: ModelFacts | null = null;
  private helper = false;
  private history: string[] = [];
  /** FBX / OBJ …: the helper converted (and stored) it during the check. */
  private uploaded: AvatarProfile | null = null;
  private wantRig = false;
  private focus: 'full' | 'bust' | 'head' = 'bust';
  private shots: { label: string; url: string }[] | null = null;
  /** The face-shape job whose picker is open (walkthrough). */
  private openRole: string | null = null;

  constructor(private app: App, private deps: ModelWizardDeps) {}

  private get preview_(): ModelPreview { return (this.pv ??= new ModelPreview()); }
  preview() { return this.preview_.el; }
  snapshot() { return this.preview_.snapshot(); }
  tests(): TestButton[] { return ['Smile', 'Say “Ahh”', 'Blink', 'Look ←', 'Look →'].map((n) => this.test(n)); }
  private test(name: string, label = name): TestButton { return { label, run: () => this.pv?.play(name) }; }

  // ---------------------------------------------------------------- open + check
  async open(file: File, ui: ShellUi): Promise<OpenResult> {
    this.reset();
    this.file = file;
    ui.busy('Checking what this computer can do…');
    this.helper = await helperAvailable();
    const fl = fileLine(file.name, { helper: this.helper });
    if (fl.level === 'bad') throw new Error(`${fl.text}. ${fl.detail ?? ''}`);
    const fc = checkFormat(file.name, null);
    const name = typeof this.deps.seed?.name === 'string' && this.deps.seed.name ? this.deps.seed.name : cleanName(file.name);
    if (fc.needsBlender && !this.helper) return { name, summary: 'This kind of file needs one extra step.', report: [fl], ready: false };
    let src: ArrayBuffer | string;
    let base: AvatarProfile;
    if (fc.needsBlender) {
      if (this.app.observer || this.deps.fakeSave) throw new Error('Observer sandbox: converting files with VTube Pro is off here.');
      ui.busy('VTube Pro is converting your model (big files take a minute)…');
      this.uploaded = await api.import(file, name);
      base = normalizeProfile(this.uploaded);
      src = api.modelUrl(base);
    } else {
      ui.busy('Opening your model…');
      if (file.size > 300 * 1048576) throw new Error('This file is over 300 MB. Make a lighter version (fewer triangles, 2K textures), then try again.');
      src = await file.arrayBuffer();
      const magic = new TextDecoder().decode(new Uint8Array(src, 0, Math.min(4, src.byteLength)));
      if (fc.ext !== '.gltf' && magic !== 'glTF') throw new Error('This file doesn’t look like a 3D model (it may be damaged, or renamed). Export it again as .glb or .vrm.');
      base = normalizeProfile({ id: 'wizard-preview', name, modelFile: fc.ext === '.vrm' ? 'model.vrm' : 'model.glb', source: 'import', ...(fc.ext === '.vrm' ? { rig: { kind: 'vrm' } } : {}) } as AvatarProfile);
    }
    base.name = name;
    if (this.deps.seed) base = normalizeProfile(applyPatch(base, { ...this.deps.seed, name }));
    ui.busy('Loading it in 3D…');
    try { await this.preview_.load(base, src); } catch (e) {
      throw new Error(`We couldn’t open this model: ${(e as Error).message}. Try exporting it again as .glb or .vrm.`);
    }
    this.profile = base;
    this.measure();
    // saved facing away (e.g. a VRoid model exported as a plain GLB): turn it around right away, so every preview,
    // test and picture shows its face (undo-free: the report says so; the Body step can turn it back)
    if (this.facts?.facesAway) {
      ui.busy('Turning it to face the camera…');
      this.profile = normalizeProfile(applyPatch(this.profile, { transform: { yaw: 180 } }));
      try { await this.preview_.load(this.profile); } catch { /* superseded */ }
      this.measure();
    }
    this.focus = 'bust';
    ui.busy(null);
    const report = reportCard(this.facts!, { helper: this.helper });
    return { name, summary: reportSummary(report, name), report, allGood: report.every((l) => l.level === 'ok') };
  }

  private measure() { this.facts = this.pv?.facts(this.file?.name ?? 'model.glb', { mechanical: this.profile?.rig.mechanical, quadruped: this.profile?.body === 'quadruped' }) ?? this.facts; }

  /** Apply a profile change (with undo), rebuilding the preview when the change needs it. */
  private async change(patch: ProfilePatch, ui?: ShellUi, opts: { history?: boolean } = {}) {
    if (!this.profile) return;
    if (opts.history !== false) this.history.push(JSON.stringify(this.profile));
    if (this.history.length > 40) this.history.shift();
    this.profile = normalizeProfile(applyPatch(this.profile, patch));
    if (needsRebuild(patch) || 'look' in patch) {
      ui?.busy('Updating the preview…');
      try { await this.pv?.load(this.profile); } catch (e) { if ((e as Error).message !== 'superseded') toast(`Preview: ${(e as Error).message}`, 'warn'); }
      ui?.busy(null);
      this.measure();
    }
    ui?.refresh();
  }
  canUndo() { return this.history.length > 0; }
  async undo() {
    const prev = this.history.pop();
    if (!prev || !this.profile) return;
    this.profile = JSON.parse(prev) as AvatarProfile;
    try { await this.pv?.load(this.profile); } catch { /* superseded */ }
    this.measure();
  }

  // ---------------------------------------------------------------- face spots
  private async placeMouth(ui: ShellUi, byHand: boolean): Promise<boolean> {
    const pv = this.preview_;
    let center: SurfaceMarker | null = null, width = 0, openHeight = 0, influence = 0;
    const g = pv.guessFace();
    if (byHand) {
      center = await pv.pick('Click the middle of the mouth (drag to turn the model).');
      if (!center) return false;
    } else if (g?.mouth) center = g.mouth.center;
    if (!center) return false;
    width = g?.mouth?.width ?? (this.facts?.height ?? 1.6) * 0.022;
    openHeight = g?.mouth?.openHeight ?? width * 0.9;
    influence = g?.mouth?.influence ?? width * 2.2;
    await this.change({ mouth: { mode: 'procedural', style: this.profile?.mouth.mode === 'procedural' ? this.profile.mouth.style : 'cavity', center, width, openHeight, influence } }, ui);
    return true;
  }
  private async placeEyes(ui: ShellUi, byHand: boolean, extra: ProfilePatch = {}): Promise<boolean> {
    const pv = this.preview_;
    const g = pv.guessFace();
    let left = g?.eyes?.left ?? null, right = g?.eyes?.right ?? null;
    const size = g?.eyes?.size ?? (this.facts?.height ?? 1.6) * 0.012;
    if (byHand) {
      left = await pv.pick('Click the eye on YOUR RIGHT as you look at the model (that is its left eye).');
      if (!left) return false;
      right = await pv.pick('Now click the other eye.');
      if (!right) return false;
    }
    if (!left || !right) return false;
    const eyes = (extra.eyes ?? {}) as ProfilePatch;
    const style = eyes.style ?? (this.profile?.eyes.mode === 'procedural' ? this.profile.eyes.style : g?.mascot ? 'bulb' : 'inset');
    await this.change({ ...extra, eyes: { mode: 'procedural', protrusion: style === 'bulb' ? 0.5 : 0.25, ...eyes, style, left, right, size } }, ui);
    // painted-eye replacement: move the markers onto the painted eyes the runtime found, size + iris colour to match
    const fit = this.pv?.rt?.bakedFit;
    if (this.profile?.eyes.replaceBaked?.on && fit && (fit.left || fit.right)) {
      const e = this.profile.eyes;
      await this.change({ eyes: { left: fit.left && e.left ? { ...e.left, position: fit.left } : e.left, right: fit.right && e.right ? { ...e.right, position: fit.right } : e.right,
        ...(fit.size > 0 ? { size: fit.size } : {}), ...(fit.iris ? { irisColor: fit.iris } : {}) } }, ui, { history: false });
    }
    return true;
  }

  // ---------------------------------------------------------------- "Set it up for me"
  autoTasks(): AutoTask[] {
    const f = this.facts, p = this.profile;
    if (!f || !p) return [];
    const plan = autoPlan(f, p, { helper: this.helper });
    return plan.items.map((it): AutoTask => ({
      id: it.id, label: it.label, detail: it.detail,
      run: async (ui) => {
        if (it.id === 'camera') { this.focus = plan.focus; this.pv?.frame(plan.focus); return { state: 'done' }; }
        if (it.state === 'keep') return { state: 'kept' };
        if (it.state === 'helper') {
          if (!this.helper) return { state: 'needs-helper' };
          this.wantRig = true;
          return { state: 'done', detail: 'VTube Pro adds a skeleton right after saving (about a minute).' };
        }
        if (it.needs === 'mouth') {
          const ok = await this.placeMouth(ui, false);
          return ok ? { state: 'done' } : { state: 'skipped', detail: 'We couldn’t find the face by ourselves. “Walk me through it” lets you click where the mouth is.' };
        }
        if (it.needs === 'eyes') {
          const ok = await this.placeEyes(ui, false, it.patch ?? {});
          return ok ? { state: 'done' } : { state: 'skipped', detail: 'We couldn’t find the eyes by ourselves. “Walk me through it” lets you click on them.' };
        }
        if (it.patch) await this.change(it.patch, ui);
        return { state: 'done' };
      },
    }));
  }

  // ---------------------------------------------------------------- "Walk me through it"
  manualSteps(): OnboardStep[] {
    const f = this.facts;
    if (!f) return [];
    // the facts change as the performer edits (face-shape matching, a drawn mouth …): always read the current ones
    const F = () => this.facts ?? f;
    const S: Record<string, OnboardStep> = {
      name: {
        id: 'name', title: 'Name',
        why: 'This name shows in your avatar list and in group streams.',
        render: (el) => {
          const input = h('input', { type: 'text', value: this.profile?.name ?? '', maxLength: 40, 'aria-label': 'Model name' }) as HTMLInputElement;
          input.addEventListener('change', () => { const v = input.value.trim().slice(0, 40); if (v && v !== this.profile?.name) void this.change({ name: v }); });
          el.append(h('p', { class: 'lead' }, 'What should we call your model?'), h('label', { class: 'ob-field' }, h('span', null, 'Name'), input),
            h('p', { class: 'note' }, 'Tip: drag the preview to turn the model, scroll to zoom.'));
        },
      },
      size: {
        id: 'size', title: 'Size',
        why: 'Rooms use the real size to seat your character: a tiny fairy sits on the table, a giant stands at the back. Normal people need nothing here.',
        render: (el, ui) => {
          const r = readNative(F().height);
          const h0 = this.profile?.size?.height ?? null;
          const opts: [string, string, string?][] = [['auto', 'A normal person', 'about 1.7 m'], ['0.4', 'Tiny', 'fairy, pet'], ['1.1', 'Small', 'child, gremlin'], ['2.4', 'Big', 'ogre, mech'], ['5', 'Giant', 'kaiju']];
          const cur = h0 === null ? 'auto' : opts.find(([v]) => v !== 'auto' && Math.abs(Number(v) - h0) < 0.01)?.[0] ?? null;
          add(el, h('p', { class: 'lead' }, `We measured ${F().height > 0 ? r.note : 'nothing (it still works)'}. How big is your character really?`),
            seg(opts, cur, (v) => void this.change(v === 'auto' ? { size: null } : { size: { height: Number(v) } }, ui)),
            h0 !== null && cur === null ? h('p', { class: 'note' }, `Set to ${fmtM(h0)}.`) : null,
            r.unit === 'cm' || r.unit === 'mm' ? h('p', { class: 'note' }, 'Your file was saved in ' + (r.unit === 'cm' ? 'centimetres' : 'millimetres') + '. That’s fine: VTube Pro corrects it on screen.') : null);
        },
      },
      body: {
        id: 'body', title: 'Body',
        why: 'The skeleton is what lets your head, arms and body follow you. Models without one still lean and nod.',
        tests: () => F().bones.includes('leftUpperArm') ? [this.test('Turn head'), this.test('Talk with hands')] : [this.test('Turn head')],
        needsHelper: () => (!this.helper && this.needsRig() ? 'Adding a skeleton needs VTube Pro.' : null),
        render: (el, ui) => {
          el.append(h('p', { class: 'lead' }, 'Press the test buttons under the preview to see your model move.'),
            h('div', { class: 'ob-report' }, ...reportCard(F(), { helper: this.helper }).filter((l) => l.id === 'facing' || l.id === 'body' || l.id === 'fingers').map((l) =>
              h('div', { class: `wiz-check ${l.level === 'ok' ? 'ok' : l.level === 'warn' ? 'warn' : 'bad'}` }, h('span', { class: 'ic' }, l.level === 'ok' ? '✓' : l.level === 'warn' ? '!' : '✕'), h('div', null, h('b', null, l.text.replace(/\s*✔$/, '')), l.detail ? h('span', { class: 'd' }, l.detail) : null)))));
          const yaw = this.profile?.transform.yaw ?? 0;
          el.append(h('div', { class: 'ob-row', style: 'margin:4px 0 8px' }, button(Math.round(yaw) % 360 === 180 ? 'Turn it back' : 'Turn it around (it faces away)', () => void this.change({ transform: { yaw: Math.round(yaw) % 360 === 180 ? 0 : 180 } }, ui))));
          if (this.needsRig() && this.helper) el.append(h('div', { class: 's-pills' }, pill(this.wantRig, 'Add a skeleton with VTube Pro when I save', () => { this.wantRig = !this.wantRig; ui.refresh(); })));
          if (!F().vrm) el.append(h('div', { class: 's-pills', style: 'margin-top:8px' }, pill(this.profile?.body === 'quadruped', 'It walks on four legs', () => void this.change({ body: this.profile?.body === 'quadruped' ? null : 'quadruped' }, ui), 'Llamas, dogs, dragons: legs stand and walk by themselves')));
        },
      },
      face: {
        id: 'face', title: 'Face shapes',
        why: 'Face shapes are how your model smiles, blinks and talks. VTube Pro reads most names by itself; this step is for shapes with unusual names.',
        tests: () => [this.test('Smile'), this.test('Say “Ahh”'), this.test('Blink'), this.test('Surprised')],
        render: (el, ui) => {
          const morphs = F().morphs;
          const map = this.profile?.faceMap ?? {};
          const sugg = suggestFaceMap(morphs, { vrm: F().vrm, existing: map });
          const known = morphs.filter((m) => classifyMorph(m, map)).length;
          if (perfectSync(morphs, map)) {
            el.append(h('p', { class: 'lead' }, `Your model has full face tracking: ${faceCaps(F()).arkit.length} ARKit face shapes (“perfect sync”). Every expression is covered, so there is nothing to match. Press the test buttons to see it.`));
            if (sugg.length) el.append(h('div', { class: 'ob-row' }, button(`Match ${sugg.length} more for me`, () => void this.change({ faceMap: { ...map, ...Object.fromEntries(sugg.map((s) => [s.morph, s.key])) } }, ui))));
            return;
          }
          el.append(h('p', { class: 'lead' }, `We know ${known} of your model’s ${morphs.length} face shapes. Pick one for each job.`));
          if (sugg.length) el.append(h('div', { class: 'ob-row', style: 'margin-bottom:8px' }, button(`Match ${sugg.length} for me`, () => void this.change({ faceMap: { ...map, ...Object.fromEntries(sugg.map((s) => [s.morph, s.key])) } }, ui), 'primary')));
          // one row per job: the current pick in plain words + Try it + Change (a styled picker of friendly names;
          // the file's raw shape names only under "Advanced")
          const pickRole = (role: (typeof FACE_ROLES)[number], morph: string | null) => {
            const next: Record<string, string> = {};
            for (const [m, k] of Object.entries(map)) if (k !== role.key) next[m] = k;
            if (morph) next[morph] = role.key;
            this.openRole = null;
            void this.change({ faceMap: Object.keys(next).length ? next : null }, ui).then(() => this.pv?.play(role.test));
          };
          for (const role of FACE_ROLES) {
            const mapped = Object.entries(map).find(([, k]) => k === role.key)?.[0] ?? null;
            const auto = mapped ? null : morphs.find((m) => { const r = classifyMorph(m, map); return r && r.key === role.key; }) ?? null;
            const cur = mapped ?? auto;
            const open = this.openRole === role.key;
            el.append(h('div', { class: 'ob-role' },
              h('div', { class: 'ob-role-q' }, role.ask),
              h('div', { class: 'ob-row' },
                h('span', { class: `ob-chip ${cur ? 'on' : ''}`, title: cur ?? '' }, cur ? friendlyShapeName(cur) : 'Not set'),
                cur ? button('Try it', () => this.pv?.play(role.test)) : null,
                button(open ? 'Close' : cur ? 'Change' : 'Pick one', () => { this.openRole = open ? null : role.key; ui.refresh(); }, 'ghost')),
              open ? h('div', { class: 'ob-picker', role: 'listbox', 'aria-label': role.ask },
                ...morphs.map((m) => h('button', { class: `ob-pick ${m === cur ? 'on' : ''}`, role: 'option', 'aria-selected': String(m === cur), title: m, onClick: () => pickRole(role, m) }, friendlyShapeName(m))),
                h('button', { class: 'ob-pick none', onClick: () => pickRole(role, null) }, 'None of these')) : null));
          }
          const raw = Object.entries(map);
          el.append(h('details', { class: 'ob-why' }, h('summary', null, 'Advanced: the file’s shape names'),
            raw.length ? h('ul', { class: 'note', style: 'margin:6px 0 0 18px;padding:0' }, ...raw.map(([m, k]) => h('li', null, h('code', null, m), ` → ${k || '(ignored)'}`)))
              : h('p', null, 'No shapes matched by hand yet.')));
        },
      },
      mouth: {
        id: 'mouth', title: 'Mouth',
        why: 'Your mouth drives the model’s mouth from the camera and your voice. A drawn mouth works on any model, even one without mouth shapes.',
        tests: () => [this.test('Say “Ahh”'), this.test('Say “Ooh”'), this.test('Say “Eee”'), this.test('Say “Mmm”'), this.test('Smile')],
        render: (el, ui) => {
          const caps = faceCaps(F());
          const drawn = this.profile?.mouth.mode === 'procedural';
          el.append(h('p', { class: 'lead' }, caps.mouth === 'none' ? 'Your model has no mouth shapes. A drawn mouth makes it talk and smile.' : 'Your model has its own mouth. Press the test buttons to check it.'),
            seg([['model', 'The model’s own mouth'], ['drawn', 'A drawn mouth']], drawn ? 'drawn' : 'model', (v) => {
              if (v === 'model') void this.change({ mouth: { mode: 'model', picked: true } }, ui);
              else void this.placeMouth(ui, false).then((ok) => { if (!ok) toast('We couldn’t find the mouth. Click “Place it myself”.', 'warn'); });
            }));
          if (drawn) {
            const m = this.profile!.mouth;
            el.append(h('div', { class: 'ob-row', style: 'margin-top:10px' },
              button('Place it myself', () => void this.placeMouth(ui, true)),
              button('Smaller', () => void this.change({ mouth: { width: m.width / 1.15, openHeight: m.openHeight / 1.15 } }, ui)),
              button('Bigger', () => void this.change({ mouth: { width: m.width * 1.15, openHeight: m.openHeight * 1.15 } }, ui))));
          }
        },
      },
      eyes: {
        id: 'eyes', title: 'Eyes',
        why: 'Eyes that blink and follow your gaze make a model feel alive. Painted-on eyes can’t move, so VTube Pro can cover them with tracked eyes (your file is never changed).',
        tests: () => [this.test('Blink'), this.test('Look ←'), this.test('Look →'), this.test('Smile')],
        render: (el, ui) => {
          const e = this.profile!.eyes;
          const mode = e.mode !== 'procedural' ? 'model' : e.replaceBaked?.on ? 'painted' : 'drawn';
          const opts: [string, string, string?][] = [['model', 'The model’s own eyes']];
          if (!F().vrm) opts.push(['painted', 'Swap painted eyes', 'for eyes painted on the skin']);
          opts.push(['drawn', 'Drawn eyes']);
          el.append(h('p', { class: 'lead' }, faceCaps(F()).blink && mode === 'model' ? 'Your model’s eyes can blink. Press the test buttons to check them.' : 'Pick how the eyes should work, then press “Blink” and “Look”.'),
            seg(opts, mode, (v) => {
              if (v === 'model') void this.change({ eyes: { mode: 'model', picked: true, replaceBaked: null } }, ui);
              else if (v === 'painted') void this.placeEyes(ui, false, { eyes: { style: 'anime', highlight: true, replaceBaked: { on: true, cover: 1, nudge: [0, 0] } } }).then((ok) => { if (!ok) toast('We couldn’t find the eyes. Click “Place them myself”.', 'warn'); });
              else void this.placeEyes(ui, false, { eyes: { replaceBaked: null } }).then((ok) => { if (!ok) toast('We couldn’t find the eyes. Click “Place them myself”.', 'warn'); });
            }));
          if (e.mode === 'procedural') {
            const styles: [string, string][] = [['anime', 'Anime'], ['inset', 'Round'], ['bulb', 'Cartoon bulb'], ['decal', 'Flat'], ['led', 'Robot screen']];
            el.append(h('div', { class: 'ob-field' }, h('span', null, 'Style'), h('div', { class: 's-pills' }, ...styles.map(([v, l]) => pill(e.style === v, l, () => void this.change({ eyes: { style: v } }, ui))))),
              h('div', { class: 'ob-row', style: 'margin-top:6px' },
                button('Place them myself', () => void this.placeEyes(ui, true, { eyes: { style: e.style, replaceBaked: e.replaceBaked ?? null } })),
                button('Smaller', () => void this.change({ eyes: { size: e.size / 1.12 } }, ui)),
                button('Bigger', () => void this.change({ eyes: { size: e.size * 1.12 } }, ui))));
          }
        },
      },
      look: {
        id: 'look', title: 'Look',
        why: 'The look decides how light falls on your model. Anime fits most characters; Toy suits robots and props; Realistic keeps the model’s own materials.',
        tests: () => [this.test('Turn head')],
        render: (el, ui) => {
          const L = this.profile!.look!;
          if (F().vrm) {
            const ex = L.vrmExposure ?? 0.6;
            el.append(h('p', { class: 'lead' }, 'VRM models keep their own toon materials (MToon). You can only make them brighter or darker for the studio lights.'),
              seg([['0.5', 'Darker'], ['0.6', 'Normal'], ['0.75', 'Brighter']], Math.abs(ex - 0.5) < 0.01 ? '0.5' : Math.abs(ex - 0.75) < 0.01 ? '0.75' : '0.6', (v) => void this.change({ look: { vrmExposure: Number(v) } }, ui)));
            return;
          }
          const opts: [string, string, string][] = [['anime', 'Anime', 'clean cel shading, soft outlines'], ['classic', 'Classic toon', 'simple bands'], ['toy', 'Toy', 'shiny: robots, props'], ['realistic', 'Realistic', 'the model’s own materials']];
          el.append(h('p', { class: 'lead' }, 'Pick a look. The preview changes right away.'),
            h('div', { class: 'ob-choice' }, ...opts.map(([v, t, d]) => h('button', { class: `wiz-opt ${L.shading === v ? 'on' : ''}`, 'aria-pressed': String(L.shading === v), onClick: () => void this.change({ look: { shading: v } }, ui) }, h('b', null, t), h('span', null, d)))));
        },
      },
      physics: {
        id: 'physics', title: 'Hair & clothes',
        why: 'Hair, skirts, tails and ears swing when the model has bones for them. You can switch it off if something flaps around too much.',
        tests: () => [this.test('Shake it')],
        render: (el, ui) => {
          const P = this.profile!.physics;
          add(el, h('p', { class: 'lead' }, F().springs ? `Your model has ${F().springs} bone${F().springs === 1 ? '' : 's'} that can swing. Press “Shake it” to see them move.` : 'We didn’t find hair or clothes bones that can swing. That’s fine.'),
            seg([['on', 'Swinging on'], ['off', 'Off']], P.enabled ? 'on' : 'off', (v) => void this.change({ physics: { enabled: v === 'on', autoChains: v === 'on' ? true : P.autoChains } }, ui)),
            F().vrm ? null : h('div', { class: 'ob-field' }, h('span', null, 'Wind'), seg([['0', 'None'], ['0.3', 'A breeze'], ['0.7', 'Windy']], P.wind <= 0.05 ? '0' : P.wind < 0.5 ? '0.3' : '0.7', (v) => void this.change({ physics: { wind: Number(v) } }, ui))));
        },
      },
      camera: {
        id: 'camera', title: 'Camera',
        why: 'This is where the studio camera starts when you use this model. You can change it any time in Me → Camera framing.',
        render: (el, ui) => {
          el.append(h('p', { class: 'lead' }, 'How close should the camera be?'),
            seg([['head', 'Face'], ['bust', 'Head & shoulders'], ['full', 'Whole body']], this.focus, (v) => { this.focus = v as typeof this.focus; this.pv?.frame(this.focus); ui.refresh(); }));
        },
      },
      angles: {
        id: 'angles', title: 'Check all sides',
        why: 'Problems hide at the sides and the back: hair poking through shoulders, holes, floating parts. Eight pictures show them all at once.',
        render: (el, ui) => {
          if (!this.shots) {
            el.append(h('p', { class: 'lead' }, 'Taking 8 pictures of your model…'));
            void this.preview_.angles().then((s) => { this.shots = s; ui.refresh(); });
            return;
          }
          el.append(h('p', { class: 'lead' }, 'Look at your model from every side. All good? Save it!'), anglesGrid(this.shots),
            h('ul', { class: 'note', style: 'margin:6px 0 0 18px;padding:0;line-height:1.6' },
              h('li', null, 'Hair or clothes poking through the body: switch swinging off in “Hair & clothes”.'),
              h('li', null, 'Missing colours or see-through parts: export the model again as .glb with textures included.'),
              h('li', null, 'Lying down or facing away: export from your 3D program with “+Y up”, then try again.')),
            h('div', { class: 'ob-row', style: 'margin-top:8px' }, button('Take the pictures again', () => { this.shots = null; ui.refresh(); })));
        },
      },
    };
    return stepIds(f).map((id) => S[id]);
  }

  private needsRig() {
    const f = this.facts;
    if (!f || f.quadruped) return false;
    return !((f.rig === 'vrm' || f.rig === 'humanoid') && f.bones.includes('leftUpperArm') && f.bones.includes('rightUpperArm'));
  }

  async angles() { return this.preview_.angles(); }

  // ---------------------------------------------------------------- save
  async save(ui: ShellUi): Promise<SaveResult> {
    const p = this.profile, file = this.file;
    if (!p || !file) throw new Error('Choose a file first.');
    const name = p.name || cleanName(file.name);
    if (this.deps.fakeSave) return { id: 'test-model', where: this.deps.fakeSave, name, note: '(Test page: nothing was really saved.)' };
    const A = this.deps.store ?? api;
    if (this.app.observer && !this.deps.store) return { id: 'sandbox', where: 'sandbox', name, note: 'Observer sandbox: saving is off here. In the real studio it goes into your avatars.' };
    let saved: AvatarProfile;
    try {
      ui.busy(this.uploaded ? 'Saving your settings…' : 'Adding it to your avatars…');
      const base = this.uploaded ?? await A.import(file, name);
      const out = json(base) as unknown as Record<string, unknown>;
      for (const k of CONFIGURED) {
        const v = (p as unknown as Record<string, unknown>)[k];
        if (v === undefined || v === null) delete out[k]; else out[k] = json(v);
      }
      out.rig = { ...base.rig, ...(p.rig.mechanical ? { mechanical: true } : {}), ...(p.rig.boneMap ? { boneMap: p.rig.boneMap } : {}) };
      saved = await A.save(out as unknown as AvatarProfile);
    } catch (e) {
      const msg = (e as Error).message;
      if (/helper/i.test(msg) || /\b503\b/.test(msg)) throw new Error('Saving this kind of file needs VTube Pro. Click “Open VTube Pro”, or export a .glb or .vrm and try again.');
      throw new Error(`We couldn’t save it: ${msg}`);
    }
    ui.busy('Making its picture…');
    try { this.pv?.frame(this.focus); const png = await this.pv?.thumbnail(); if (png) await A.thumbnail(saved.id, png); } catch { /* the studio makes one later */ }
    let note: string | undefined;
    if (this.wantRig && this.helper) {
      try {
        const rt = this.pv?.rt;
        const soft = saved.rig.soft ?? (rt ? guessSoftRig(rt.model) : null);
        if (!soft) throw new Error('no body shape found');
        ui.busy('VTube Pro is adding a skeleton (about a minute)…');
        const { jobId } = await A.autorig(saved.id, soft);
        const j = await waitJob(jobId, (x) => ui.busy(`VTube Pro is adding a skeleton… ${Math.round((x.progress ?? 0) * 100)}%`));
        if (j.status !== 'succeeded') throw new Error(j.error ?? 'Blender stopped');
        note = 'VTube Pro added a skeleton ✓';
      } catch (e) { note = `The skeleton step didn’t work (${(e as Error).message}). Your model is saved; try “Re-rig with Blender” under Me → Advanced later.`; }
    }
    ui.busy(null);
    this.deps.onDone?.(saved.id);
    this.app.emit('library');
    return { id: saved.id, where: 'helper', name: saved.name, note };
  }

  async useNow(id: string) {
    if (id === 'sandbox' || id === 'test-model') { toast('(Test page: nothing to put on.)', 'info'); return; }
    await this.app.loadAvatar(id);
    this.app.focus = this.focus;
    this.app.frameCamera();
    this.app.emit('library');
  }

  private reset() {
    this.uploaded = null; this.profile = null; this.facts = null; this.history = []; this.wantRig = false; this.shots = null;
  }
  dispose() { this.pv?.dispose(); this.pv = null; this.reset(); this.file = null; }
}

/** Open "Add my model" (optionally with a file the performer already dropped somewhere). */
export function openModelWizard(app: App, opts: { file?: File; onDone?: (id: string) => void; seed?: ProfilePatch } = {}) {
  return openOnboarding(new ModelKind(app, { onDone: opts.onDone, seed: opts.seed }), { file: opts.file });
}

/** Observer pages only: drive the wizard from a test harness (window.vtpModelWizardTest). Never uploads or saves. */
export function installModelWizardTestHook(app: App) {
  if (!app.observer) return;
  const w = window as unknown as Record<string, unknown>;
  if (w.vtpModelWizardTest) return;
  w.vtpModelWizardTest = async (o: { url?: string; bytes?: ArrayBuffer; name: string; helper?: boolean; save?: 'helper' | 'browser' | 'record'; pick?: boolean }) => {
    forceHelper(typeof o.helper === 'boolean' ? o.helper : null);
    const bytes = o.bytes ?? (o.url ? await (await fetch(o.url)).arrayBuffer() : new Uint8Array(1024).buffer);
    const file = new File([bytes], o.name);
    // 'record': the real save code against a recorder (no network): import → save → thumbnail calls land in __vtpWizardSaves
    const calls: unknown[] = [];
    w.__vtpWizardSaves = calls;
    const store: ModelWizardDeps['store'] = {
      import: async (f: File, n?: string) => { calls.push({ call: 'import', file: f.name, bytes: f.size, name: n }); return normalizeProfile({ id: 'rec-model', name: n ?? 'x', modelFile: 'model.glb', source: 'import' } as AvatarProfile); },
      save: async (p: AvatarProfile) => { calls.push({ call: 'save', profile: JSON.parse(JSON.stringify(p)) }); return p; },
      thumbnail: async (id: string, png: Blob) => { calls.push({ call: 'thumbnail', id, bytes: png.size, type: png.type }); return {}; },
      autorig: async (id: string) => { calls.push({ call: 'autorig', id }); throw new Error('recorder: no autorig'); },
    };
    return openOnboarding(new ModelKind(app, o.save === 'record' ? { store } : { fakeSave: o.save ?? 'helper' }), o.pick ? {} : { file });
  };
  w.vtpModelWizardTests = Object.keys(TESTS);
}
