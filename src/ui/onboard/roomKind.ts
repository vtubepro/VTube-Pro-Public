// "Add my room": the room kind of the shared onboarding wizard (src/ui/onboard/shell.ts, model-onboarding's shell).
//   Pick a .glb (or .fbx / .blend / .obj through the helper) → the check (seats found, size, cameras, lights, weight)
//   → no seats? "We couldn't find any places for you to sit or stand in this room":
//       "Place seats for me" (sofas, chairs, open floor + a camera for each, shared/roomSeats.ts) or
//       "Let me place them" (click in the 3D preview, drag to move, turn, test the camera view, add a second place)
//   → saved on the user's side: the room folder (POST /api/rooms/import)
//   → "Your room is ready in VTube Pro". Nothing is ever uploaded anywhere; nothing changes on stream until
//   "Use it now". The room logic (check, plan, lossless GLB edit) is shared/roomCheck.ts, the same code the helper and
//   the AI's check_room run.
import type { App } from '../../app.ts';
import { analyzeParsed, applyFix, manualSpot, planFix, plannedProblems, refreshSpotCam, sceneJsonFor, analyzeRoom, type FixPlan, type PlannedSpot, type RoomAnalysis, type RoomLine } from '../../../shared/roomCheck.ts';
import { apply, isGlb, parseGlb, stripArea, writeGlb, type Glb } from '../../../shared/roomGlb.ts';
import { floorBelow, seatFacing, wideCamera, type CamPlace, type V3 } from '../../../shared/roomSeats.ts';
import { button, h, toast } from '../dom.ts';
import { RoomPreview, type MarkerSpot } from './roomPreview.ts';
import { anglesGrid, openOnboarding, type AutoTask, type OnboardKind, type OnboardStep, type OpenResult, type ReportLine, type SaveResult, type ShellUi, type TestButton } from './shell.ts';
import { helperAvailable } from './links.ts';

const DIRECT = ['.glb', '.gltf'], VIA_HELPER = ['.fbx', '.blend', '.obj'];
const extOf = (n: string) => (/\.[a-z0-9]+$/i.exec(n)?.[0] ?? '').toLowerCase();
const tidyName = (file: string) => {
  const b = file.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'My room';
  return b.charAt(0).toUpperCase() + b.slice(1);
};
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'room';
const rnd = () => Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, '0')).join('');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface RoomKindDeps {
  app?: App | null;
  onDone?: (id: string) => void;
  /** Test pages: replace the save (never touches the network or storage). */
  fakeSave?: 'helper' | 'browser' | 'sandbox';
  /** Test pages: force "is the helper here?". */
  helper?: boolean;
}

export class RoomKind implements OnboardKind {
  readonly kind = 'room' as const;
  readonly noun = 'room';
  readonly title = 'Add my room';
  readonly accept = [...DIRECT, ...VIA_HELPER].join(',');
  readonly formats = 'A .glb file works right here. .fbx, .blend and .obj files are opened by VTube Pro on your PC.';
  readonly guide = 'ENVIRONMENTS_SIMPLE.md#add-my-room';
  readonly readyTitle = 'Your room is ready in VTube Pro';
  private pv: RoomPreview | null = null;
  private a: RoomAnalysis | null = null;
  private bytes: Uint8Array | null = null;
  private fileName = '';
  plan: FixPlan = { fix: null, spots: [], wides: [], front: [0, 1] };
  private history: string[] = [];
  private finalSeats = 0;

  constructor(private deps: RoomKindDeps = {}) {}

  private get preview_(): RoomPreview { return (this.pv ??= this.makePreview()); }
  private makePreview() {
    const p = new RoomPreview();
    p.onPick = (pt, up) => this.addAt(pt, up);
    p.onMove = (name, pt, up) => this.moveTo(name, pt, up);
    return p;
  }
  preview() { return this.preview_.el; }
  async snapshot() { return this.preview_.snapshot(640, 480); }
  doneText(sv: SaveResult) { return `“${sv.name}” is in your rooms: open Change room to find it.`; }

  // ---------------------------------------------------------------- open + check
  async open(file: File, ui: ShellUi): Promise<OpenResult> {
    this.fileName = file.name;
    const ext = extOf(file.name);
    const name = tidyName(file.name);
    if (![...DIRECT, ...VIA_HELPER].includes(ext)) throw new Error(`We can’t use ${ext || 'this kind of'} files for rooms. Save your room as .glb (glTF Binary) and try again.`);
    if (file.size > 300 * 1048576) throw new Error('That room is over 300 MB. Make it lighter (fewer details, smaller textures) and try again.');
    let buf = new Uint8Array(await file.arrayBuffer());
    const helper = this.deps.helper ?? await helperAvailable().catch(() => false);
    // other formats, Draco / KTX2: Blender in the helper turns them into a GLB we can open
    const packed = (b: Uint8Array) => isGlb(b) && /KHR_draco_mesh_compression|KHR_texture_basisu/.test(new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 2_000_000))));
    if (VIA_HELPER.includes(ext) || packed(buf)) {
      const why = VIA_HELPER.includes(ext) ? `This is a ${ext} file. Rooms open from .glb files, so VTube Pro turns it into one with Blender.` : 'This room is packed in a way the room viewer can’t open. VTube Pro unpacks it with Blender.';
      if (!helper) return { name, summary: 'This file needs VTube Pro first.', ready: false, report: [{ id: 'file', level: 'bad', text: why, detail: 'Or export it from your 3D app as .glb and drop that here.', needsHelper: true }] };
      ui.busy('VTube Pro is opening the file with Blender… (this can take a minute)');
      const r = await fetch(`/api/rooms/convert?${new URLSearchParams({ filename: file.name })}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf as BlobPart });
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? 'VTube Pro couldn’t open that file. Try exporting it as .glb.');
      buf = new Uint8Array(await r.arrayBuffer());
    }
    let glb: Glb;
    try { glb = parseGlb(buf); } catch (e) { throw new Error((e as Error).message); }
    ui.busy('Loading the 3D preview…');
    try { await this.preview_.load(buf.slice().buffer as ArrayBuffer); } catch (e) { console.warn('[add my room] the preview could not load the file', e); throw new Error('We couldn’t show this room. Export it again as .glb (glTF Binary) and try again.'); }
    ui.busy('Looking for places to sit or stand…');
    await new Promise((r) => setTimeout(r, 30));
    let a = analyzeParsed(glb, buf.length, {});
    if (a.facts.unreadableMeshes) a = analyzeParsed(glb, buf.length, { soup: this.preview_.soup() });   // meshopt: read through three.js
    this.a = a; this.bytes = buf;
    this.plan = { fix: a.fix, spots: [], wides: [], front: [0, 1] };
    this.history = [];
    this.preview_.setFix(a.fix);
    this.paint();
    this.preview_.frame(this.wideOf(), this.plan.front, this.firstArea());
    ui.busy(null);
    return this.openResult(name);
  }

  private openResult(name: string): OpenResult {
    const a = this.a!;
    const seats = a.report.seats;
    const report: ReportLine[] = a.report.lines.map((l: RoomLine) => ({ id: l.id, level: l.level, text: l.text, detail: l.detail, needsHelper: l.needsHelper }));
    const fixable = a.report.lines.some((l) => l.autoFix && l.level !== 'ok');
    const summary = seats === 0 ? 'We couldn’t find any places for you to sit or stand in this room. We can fix that in a minute.'
      : seats === 1 ? 'It works, and a second place would let a friend join you.'
        : fixable ? `We found ${plural(seats, 'place')} to sit or stand, and a few things we can tidy up.` : `We found ${plural(seats, 'place')} to sit or stand. Your room is ready to use.`;
    const choose = seats === 0
      ? { headline: 'We couldn’t find any places for you to sit or stand in this room', lead: 'Pick one. You can move every place afterwards.', auto: 'Place seats for me', autoText: 'We look for sofas, chairs and open floor, put places there and point a camera at each one. You see them in the preview.', manual: 'Let me place them', manualText: 'Click where you want to sit or stand in the 3D preview, drag to move, then test the camera view.' }
      : seats === 1
        ? { headline: 'Let’s add a place for a friend', lead: 'Two or more places let a guest sit with you on stream.', auto: 'Place seats for me', autoText: 'We find another sofa seat, chair or open floor and point a camera at it.', manual: 'Let me place them', manualText: 'Click in the 3D preview where your friend should sit or stand.' }
        : { headline: 'Want us to tidy it up?', lead: 'Either way you can change anything later.', auto: 'Fix it for me', autoText: 'We fix the size and direction, and add a main camera view if it’s missing.', manual: 'Let me check it', manualText: 'Look at every place and camera view yourself, move places, add more.' };
    return { name, summary, report, ready: true, allGood: seats >= 2 && !fixable, choose };
  }

  tests(): TestButton[] {
    return [
      { label: '🎥 Test the camera view', run: () => this.showCamView(this.preview_.selection ?? this.allMarkers()[0]?.name ?? null) },
      { label: '⤢ Show the whole room', run: () => this.preview_.frame(this.wideOf(), this.plan.front, this.firstArea()) },
    ];
  }

  // ---------------------------------------------------------------- markers
  /** Existing (authored) places, in fixed space. */
  private authored(): MarkerSpot[] {
    const a = this.a; if (!a) return [];
    return a.facts.areas.flatMap((ar) => ar.spots.map((s) => ({
      name: s.name, label: s.label || stripArea(s.name), position: (a.fix ? apply(a.fix, ...s.position) : s.position) as V3,
      yawDeg: s.yawDeg, pose: s.pose, seatHeight: s.seatHeight, state: s.problems.some((p) => p === 'inside' || p === 'floating') ? 'warn' as const : 'ok' as const, cam: null,
    })));
  }
  private planned(): MarkerSpot[] {
    return this.plan.spots.map((s) => ({ name: s.name, label: s.label, position: s.position, yawDeg: s.yawDeg, pose: s.pose, seatHeight: s.seatHeight, state: this.a && plannedProblems(this.a, s).length ? 'warn' as const : 'new' as const, cam: s.cam }));
  }
  private allMarkers() { return [...this.authored(), ...this.planned()]; }
  private paint() { this.preview_.setSpots(this.allMarkers()); }
  private wideOf(): CamPlace | null { return this.plan.wides[0] ?? null; }
  /** Rooms with areas: the first area's node prefix ('MAIN__'), so the preview frames one place, not the whole building. */
  private firstArea(): string | null { const a = this.a?.facts.areas; return a && a.length > 1 && a[0].prefix ? `${a[0].prefix}__` : null; }

  private remember() { this.history.push(JSON.stringify(this.plan)); if (this.history.length > 40) this.history.shift(); }
  canUndo() { return this.history.length > 0; }
  undo() { const s = this.history.pop(); if (s) { this.plan = JSON.parse(s) as FixPlan; this.paint(); } }

  /** A click in the preview while adding: a seat when the point is cushion height above the floor, else standing. */
  /** What a click / drop on the room means: a seat (a cushion 0.28-0.62 m above the floor under it), a standing spot
   *  (the floor, a stage, a riser), or nothing (a table / counter top, a wall). */
  private placeAt(p: V3, up: number): { pos: V3; pose: 'sit' | 'stand'; seatHeight?: number; yawDeg?: number } | string {
    const g = this.a?.grid;
    if (up < 0.7) return 'That’s a wall or the side of something. Click a seat or the floor.';
    const below = g ? floorBelow(g, p[0], p[1], p[2]) : 0, hgt = p[1] - below;
    if (hgt > 0.28 && hgt < 0.62) return { pos: [p[0], below, p[2]], pose: 'sit', seatHeight: Math.round(hgt * 100) / 100, yawDeg: g ? seatFacing(g, p[0], p[2], p[1]) ?? undefined : undefined };
    if (hgt >= 0.62 && hgt < 1.3) return 'That looks like a table or a counter. Click a seat or the floor.';
    return { pos: [p[0], p[1], p[2]], pose: 'stand' };
  }
  private addAt(p: V3, up: number) {
    const a = this.a; if (!a) return;
    const w = this.placeAt(p, up);
    if (typeof w === 'string') { toast(w, 'info', 4000); return; }
    const spot = manualSpot(a, this.plan, w.pos, { pose: w.pose, seatHeight: w.seatHeight, yawDeg: w.yawDeg });
    if (!spot) { toast('That’s the most places this room can hold (12).', 'warn'); return; }
    this.remember();
    this.plan.spots.push(spot);
    this.preview_.addMode = false; this.preview_.setHint(null);
    this.paint(); this.preview_.select(spot.name);
    this.refreshUi?.();
  }
  private moveTo(name: string, p: V3, up: number) {
    const i = this.plan.spots.findIndex((s) => s.name === name);
    if (i < 0) { toast('That place came with your room file. Add your own places to move them around.', 'info', 5000); this.paint(); return; }
    const a = this.a!;
    const w = this.placeAt(p, up);
    if (typeof w === 'string') { toast(w, 'info', 4000); this.paint(); return; }
    const sit = w.pose === 'sit';
    this.remember();
    const s = this.plan.spots[i];
    const moved: PlannedSpot = { ...s, position: w.pos, pose: w.pose, seatHeight: w.seatHeight, yawDeg: w.yawDeg ?? s.yawDeg, seatDepth: sit ? 0.5 : undefined, label: sit ? 'My seat' : 'My spot' };
    this.plan.spots[i] = refreshSpotCam(a, moved);
    this.paint(); this.refreshUi?.();
  }
  private turn(name: string, deg: number) {
    const i = this.plan.spots.findIndex((s) => s.name === name); if (i < 0 || !this.a) return;
    this.remember();
    const s = this.plan.spots[i];
    this.plan.spots[i] = refreshSpotCam(this.a, { ...s, yawDeg: ((s.yawDeg + deg + 540) % 360) - 180 });
    this.paint(); this.refreshUi?.();
  }
  private setPose(name: string, pose: 'sit' | 'stand') {
    const i = this.plan.spots.findIndex((s) => s.name === name); if (i < 0 || !this.a) return;
    this.remember();
    const s = this.plan.spots[i];
    this.plan.spots[i] = refreshSpotCam(this.a, { ...s, pose, seatHeight: pose === 'sit' ? s.seatHeight ?? 0.45 : undefined, seatDepth: pose === 'sit' ? 0.5 : undefined });
    this.paint(); this.refreshUi?.();
  }
  private remove(name: string) {
    this.remember();
    this.plan.spots = this.plan.spots.filter((s) => s.name !== name);
    this.paint(); this.refreshUi?.();
  }
  private refreshUi: (() => void) | null = null;

  /** The camera view of a place (its own camera, else where the automatic camera operator would roughly stand). */
  private camFor(name: string | null): CamPlace | null {
    if (!name || !this.a) return null;
    const p = this.plan.spots.find((s) => s.name === name);
    if (p?.cam) return p.cam;
    const m = this.allMarkers().find((s) => s.name === name);
    if (!m) return null;
    const y = (m.yawDeg * Math.PI) / 180, face = m.position[1] + (m.pose === 'sit' ? (m.seatHeight ?? 0.45) + 0.75 : 1.38);
    return { name: `${name}_view`, position: [m.position[0] + Math.sin(y) * 1.8, face + 0.05, m.position[2] + Math.cos(y) * 1.8], target: [m.position[0], face - 0.05, m.position[2]], yfovDeg: 35 };
  }
  private showCamView(name: string | null) {
    const cam = this.camFor(name);
    if (!cam) { toast('Add a place first, then test its camera view.', 'info'); return; }
    const url = this.preview_.viewFrom(cam, 640, 360);
    const box = h('div', { class: 'ob-confirm', role: 'dialog', 'aria-label': 'Camera view' }, h('div', { style: 'max-width:680px' },
      h('b', { style: 'font-size:16px' }, `What the camera sees: place ${this.allMarkers().findIndex((m) => m.name === name) + 1}`),
      h('img', { src: url, alt: 'Camera view', style: 'width:100%;border-radius:10px;border:1px solid var(--line2)' }),
      h('span', { class: 'note' }, 'The coloured figure stands in for you. If something blocks the face, drag the place a little or turn it.'),
      h('div', { class: 'ob-row' }, button('Close', () => box.remove(), 'primary'))));
    (document.querySelector('.wiz.ob') ?? document.body).append(box);
  }

  // ---------------------------------------------------------------- "Place seats for me"
  autoTasks(): AutoTask[] {
    return [
      { id: 'size', label: 'Size and direction', detail: 'Checking the room is the right size and the right way up', run: async () => {
        const f = this.a!.facts, done: string[] = [];
        if (f.scaleGuess === 0.01) done.push('shrank it to the right size');
        else if (f.scaleGuess > 1) done.push('grew it to the right size');
        if (f.upGuess !== 'y') done.push('stood it up the right way');
        if (this.a!.fix && !done.length) done.push('moved the floor to ground level');
        return done.length ? { state: 'done', detail: `We ${done.join(' and ')}.` } : { state: 'kept', detail: 'Already right.' };
      } },
      { id: 'seats', label: 'Places to sit or stand', detail: 'Looking for sofas, chairs and open floor', run: async (ui) => {
        const seats = this.a!.report.seats;
        if (seats >= 2 && !this.a!.report.lines.some((l) => l.id === 'seats' && l.level !== 'ok')) return { state: 'kept', detail: `You already have ${plural(seats, 'place')}.` };
        ui.busy('Looking around the room…');
        await new Promise((r) => setTimeout(r, 20));
        this.remember();
        const plan = planFix(this.a!);
        this.plan = { ...plan, spots: [...this.plan.spots.filter((s) => s.source === 'manual'), ...plan.spots] };
        this.paint(); this.preview_.frame(this.wideOf(), this.plan.front, this.firstArea());
        ui.busy(null);
        if (!plan.spots.length) return { state: 'failed', detail: 'We couldn’t find a sofa, chair or open floor we trust. Click “Fine-tune it myself” to put a place in by hand.' };
        const sit = plan.spots.filter((s) => s.pose === 'sit').length, stand = plan.spots.length - sit;
        return { state: 'done', detail: `Added ${[sit ? plural(sit, 'seat') : '', stand ? plural(stand, 'standing spot') : ''].filter(Boolean).join(' and ')}. They’re numbered in the preview.` };
      } },
      { id: 'cams', label: 'Camera views', detail: 'Pointing a camera at each new place', run: async () => {
        const n = this.plan.spots.length, withCam = this.plan.spots.filter((s) => s.cam).length;
        // a main wide view for every area that has none (over its places: the file's own + the new ones)
        let wides = 0;
        const a = this.a!;
        if (a.grid) for (const ar of a.facts.areas) {
          const name = `${ar.prefix ? `${ar.prefix}__` : ''}CAM_WIDE`;
          if (ar.hasWide || this.plan.wides.some((w) => w.name === name)) continue;
          const pts = [...ar.spots.filter((s) => !s.problems.length).map((s) => ({ ...s, position: (a.fix ? apply(a.fix, ...s.position) : s.position) as V3 })), ...this.plan.spots.filter((s) => s.area === ar.key)];
          if (!pts.length) continue;
          const w = wideCamera(a.grid, pts, this.plan.front);
          if (w) { this.plan.wides.push({ ...w, name }); wides++; }
        }
        if (!n) return wides ? { state: 'done', detail: 'Added a wide view of the room (the main camera).' } : { state: a.report.seats ? 'kept' : 'skipped', detail: a.report.seats ? 'Your room already has its cameras.' : 'No places yet.' };
        return { state: 'done', detail: withCam === n ? `Each new place has its own camera${this.plan.wides.length ? ', plus a wide view of the room' : ''}.` : `${withCam} of ${n} places have their own camera; VTube Pro films the others automatically.` };
      } },
      { id: 'check', label: 'Check it again', detail: 'Running the room check on the fixed room', run: async () => {
        const out = this.build();
        this.finalSeats = out.seats;
        return out.seats ? { state: 'done', detail: `${plural(out.seats, 'place')} ready to use.` } : { state: 'failed', detail: 'Still no place to sit or stand. Click “Fine-tune it myself” to add one.' };
      } },
    ];
  }

  /** The fixed room: GLB bytes + scene.json + its fresh check. */
  private build(): { glb: Uint8Array; sceneJson: Record<string, unknown>; seats: number; analysis: RoomAnalysis } {
    const a = this.a!, name = tidyName(this.fileName);
    if (!this.plan.spots.length && !this.plan.wides.length && !this.plan.fix) {
      const sj = sceneJsonFor(name, a);
      return { glb: this.bytes!, sceneJson: sj, seats: a.report.seats, analysis: a };
    }
    const out = applyFix(a, this.plan, name);
    const again = analyzeRoom(out.glb, { sceneJson: out.sceneJson });
    return { glb: out.glb, sceneJson: out.sceneJson, seats: again.report.seats, analysis: again };
  }

  // ---------------------------------------------------------------- "Let me place them"
  manualSteps(): OnboardStep[] {
    const editor = (el: HTMLElement, ui: ShellUi, intro: string) => {
      this.refreshUi = () => ui.refresh();
      const all = this.allMarkers();
      const mine = new Set(this.plan.spots.map((s) => s.name));
      const sel = this.preview_.selection;
      const adding = this.preview_.addMode;
      const addBtn = h('button', { class: `btn ${adding ? '' : 'primary'} ob-big`, onClick: () => {
        this.preview_.addMode = !adding;
        this.preview_.setHint(this.preview_.addMode ? 'Click on a seat or on the floor in the preview' : null);
        ui.refresh();
      } }, adding ? 'Cancel adding' : all.length ? '＋ Add another place' : '＋ Add a place');
      const rows = all.map((m, i) => {
        const own = mine.has(m.name);
        const probs = m.state === 'warn';
        return h('div', { class: `ob-task ${probs ? 'needs-helper' : 'done'}`, style: m.name === sel ? 'border-color:var(--accent2)' : '', onClick: () => this.preview_.select(m.name) },
          h('span', { class: 'ic' }, String(i + 1)),
          h('div', null,
            h('b', null, `${m.label || 'Place'} · ${m.pose === 'sit' ? 'sitting' : 'standing'}`),
            h('span', null, probs ? 'This looks stuck in furniture or floating: drag it a little.' : own ? 'Drag it in the preview to move it.' : 'Came with your room file.'),
            own ? h('div', { class: 'ob-row', style: 'margin-top:6px' },
              button(m.pose === 'sit' ? 'Make it standing' : 'Make it a seat', () => this.setPose(m.name, m.pose === 'sit' ? 'stand' : 'sit')),
              button('⟲ Turn', () => this.turn(m.name, -45)), button('Turn ⟳', () => this.turn(m.name, 45)),
              button('🎥 View', () => this.showCamView(m.name)), button('Remove', () => this.remove(m.name), 'ghost')) : h('div', { class: 'ob-row', style: 'margin-top:6px' }, button('🎥 View', () => this.showCamView(m.name)))));
      });
      el.append(h('p', { class: 'lead' }, intro), h('div', { class: 'ob-row', style: 'margin:8px 0' }, addBtn),
        rows.length ? h('div', { class: 'ob-tasks' }, ...rows) : h('p', { class: 'note' }, 'No places yet. Click “Add a place”, then click on a sofa, a chair or the floor in the preview.'));
    };
    return [
      { id: 'first', title: this.a?.report.seats ? 'Your places' : 'Put in your first place', why: 'Every room needs at least one place where you sit or stand. That’s where VTube Pro puts you, and where its cameras look.',
        render: (el, ui) => editor(el, ui, this.a?.report.seats ? 'These are the places in your room. Add more, move yours, or test what the camera sees.' : 'Click “Add a place”, then click on a sofa, a chair or the floor in the 3D preview. A seat is made when you click a cushion; the floor makes a standing spot.'),
        tests: () => this.tests() },
      { id: 'second', title: 'Add a place for a friend', why: 'With two or more places a guest can join you on stream. Rooms work with one, but two is better.',
        render: (el, ui) => editor(el, ui, this.allMarkers().length >= 2 ? `You have ${plural(this.allMarkers().length, 'place')}. That’s enough for a friend to join you.` : 'Add one more place so a friend can sit or stand with you.'),
        tests: () => this.tests() },
      { id: 'views', title: 'Test the camera views', why: 'Each place gets its own camera. If something blocks a face, move or turn that place a little.',
        render: (el, ui) => {
          this.refreshUi = () => ui.refresh();
          const all = this.allMarkers().slice(0, 12);
          el.append(h('p', { class: 'lead' }, 'This is what each camera sees. The coloured figure stands in for you.'),
            h('div', { class: 'ob-angles', style: 'grid-template-columns:repeat(2,1fr)' }, ...all.map((m, i) => {
              const cam = this.camFor(m.name);
              return h('figure', null, cam ? h('img', { src: this.preview_.viewFrom(cam, 320, 180), alt: `Camera view of place ${i + 1}`, style: 'aspect-ratio:16/9' }) : null, h('figcaption', null, `${i + 1} · ${m.label || 'Place'}`));
            })));
        } },
      { id: 'angles', title: 'Look at it from every side', why: 'A last look before saving: the places should sit on the seats and the floor, not inside furniture.',
        render: (el) => { el.append(h('p', { class: 'lead' }, 'Your room from 8 sides.'), anglesGrid(this.preview_.angles())); } },
    ];
  }
  async angles() { return this.preview_.angles(); }

  // ---------------------------------------------------------------- save
  async save(ui: ShellUi): Promise<SaveResult> {
    const name = tidyName(this.fileName);
    ui.busy('Checking your room one last time…');
    await new Promise((r) => setTimeout(r, 20));
    const out = this.build();
    if (out.seats < 1) throw new Error('There’s still no place to sit or stand. Go back and add one (Let me place them), then save.');
    const cam = this.wideOf() ?? this.plan.spots.find((s) => s.cam)?.cam ?? null;
    const thumbUrl = cam ? this.preview_.viewFrom(cam, 480, 270) : this.preview_.snapshot(480, 270);
    const thumb = await (await fetch(thumbUrl)).blob();
    if (this.deps.fakeSave || this.deps.app?.observer) {
      const where = this.deps.fakeSave ?? 'sandbox';
      return { id: where === 'sandbox' ? 'sandbox' : `${slug(name)}_test00`, where, name, note: where === 'sandbox' ? 'Test sandbox: nothing was saved.' : `Test page: nothing was saved (${out.glb.length.toLocaleString('en-US')} bytes, ${plural(out.seats, 'place')}).` };
    }
    const helper = this.deps.helper ?? await helperAvailable().catch(() => false);
    if (helper) {
      ui.busy('Saving it on your PC…');
      const r = await fetch(`/api/rooms/import?${new URLSearchParams({ filename: 'scene.glb', name })}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: out.glb as BlobPart });
      const j = await r.json().catch(() => null) as { id?: string; error?: string } | null;
      if (!r.ok || !j?.id) throw new Error(j?.error ?? 'VTube Pro couldn’t save the room. Try again.');
      await fetch(`/api/rooms/${encodeURIComponent(j.id)}/thumbnail`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: thumb }).catch(() => null);
      this.deps.onDone?.(j.id);
      return { id: j.id, where: 'helper', name };
    }
    throw new Error('VTube Pro isn’t running on this PC right now. Start it (the “Start VTube Pro” shortcut), then click Try again.');
  }

  async useNow(id: string) {
    const app = this.deps.app;
    if (!app || id === 'sandbox' || /_test00$/.test(id)) { toast('(Test page: nothing to switch to.)', 'info'); return; }
    await app.scene.refreshScenes();
    if (!app.scene.scenes.some((s) => s.id === id)) { toast('Your room is saved. Open Change room and press ↻ Rescan to see it.', 'info', 7000); return; }
    app.scene.setScene(id);
  }

  dispose() { this.pv?.dispose(); this.pv = null; this.refreshUi = null; }

  /** (tests) the preview, for projecting points to click. */
  get previewForTests(): RoomPreview { return this.preview_; }
  /** (tests) the current planned places. */
  get plannedSpots(): PlannedSpot[] { return this.plan.spots; }
  get finalSeatCount() { return this.finalSeats; }
}

/** Open "Add my room" (Change room → Add my room). */
export function openRoomWizard(app: App | null, opts: { file?: File; onDone?: (id: string) => void } = {}) {
  return openOnboarding(new RoomKind({ app, onDone: opts.onDone }), { file: opts.file, onClose: (s) => { if (s && app) void app.scene.refreshScenes(); } });
}

/** Test pages only: open the wizard on a room file from a URL; `strip` removes every SPOT_xx (and its camera) first,
 *  so the "no seats" path can be checked on a shipped room. Never saves (fakeSave). */
export async function openRoomWizardTest(o: { url: string; strip?: boolean; dropWide?: boolean; save?: 'helper' | 'browser' | 'sandbox'; helper?: boolean; name?: string }) {
  const r = await fetch(o.url);
  let bytes: Uint8Array = new Uint8Array(await r.arrayBuffer());
  if (o.strip || o.dropWide) {
    const g = parseGlb(bytes);
    for (const n of g.json.nodes ?? []) {
      if (o.strip && /^SPOT_\d\d/.test(stripArea(n.name ?? ''))) n.name = (n.name ?? '').replace(/SPOT_(\d\d)/, 'OLD_$1');
      if (o.dropWide && stripArea(n.name ?? '') === 'CAM_WIDE') n.name = `${n.name}_OLD`;
    }
    bytes = writeGlb(g.json, g.bin);
  }
  const base = (o.name ?? (o.url.split('/').slice(-2, -1)[0] || 'room')).replace(/\.glb$/i, '');
  const file = new File([bytes as BlobPart], /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.glb`, { type: 'model/gltf-binary' });
  const kind = new RoomKind({ fakeSave: o.save ?? 'sandbox', helper: o.helper ?? false });
  const shell = openOnboarding(kind, { file });
  return { kind, shell };
}
