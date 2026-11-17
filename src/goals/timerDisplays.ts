// The subathon countdown IN the room (beta.14): a room mesh declared as a timer display (a TIMER_DISPLAY / TIMER_DISPLAY_xx
// node, or scene.json `timerDisplays: [{ node, style?, color?, show?, label? }]`) gets the live clock drawn onto its UVs:
// big H:MM:SS digits, a "+10:00" pop when time is added, happy hour / hype / sleep / paused / test badges (pure part:
// shared/timerDisplay.ts; the painting: timerDraw.ts). Same drawing as every other goals renderer's data: the helper's goals
// view in goalsStore (absolute end time + the helper's clock offset), so the studio, every OBS page and every party guest's
// page show the same second and no page-local timer runs.
//
// How it sits on the room: the picture is a transparent overlay mesh that SHARES the surface's geometry (a child of it, one
// polygon-offset in front), so the room's own material is never touched: with no subathon, with "In the room" off or on a
// goals-only card the overlay is simply hidden and the room looks exactly as its artist made it (that is the idle look). The
// canvas is aspect-matched to the surface, laid on its UV rectangle upright / un-mirrored (shared/timerSurface.ts), redrawn only
// when the picture changes (a new second, a new view, a pop easing: at most ~10 a second, usually 1), never allocates per
// frame and is disposed with the room. Photosensitivity: nothing pulses; the overlay fades in / out and a pop eases through
// the page's flash governor.
import * as THREE from 'three';
import { govChannel, governK, pageGovernor, type GovChannel } from '../../shared/flashGovernor.ts';
import {
  cleanFit, cleanGlass, planTimerDisplays, popSig, timerFace, timerHidden, timerMainMs, timerOtherMs, TIMER_STYLES,
  type RoomNodeRef, type TimerDisplaySpec, type TimerFace, type TimerHide, type TimerStyle,
} from '../../shared/timerDisplay.ts';
import { canvasSize, extentAlong, orientation, overhang, pickSurface, surfaceStats, uvMatrix, type Orientation, type SurfaceStats } from '../../shared/timerSurface.ts';
import type { StagePalette } from '../../shared/stage.ts';
import type { SceneRuntime } from '../scene/SceneRuntime.ts';
import type { BoardShield, ShieldPanel } from './boardShield.ts';
import { DEFAULT_LOOK } from './goalsDraw.ts';
import { goalsStore } from './goalsStore.ts';
import { DEFAULT_TIMER_PAINT, drawTimerFace, timerFootprint, timerRows } from './timerDraw.ts';

/** shortest gap between two uploads of a display's texture (a pop easing in / out: ~10 a second; a quiet clock: 1) */
const MIN_GAP = 90;
const LONG_SIDE = 1024;
/** the widest clock a subathon normally shows ("47:59:12"): the reference for the digit run's size in metres */
const WIDEST = '47:59:12';
const noRaycast = () => { /* an overlay is never a ray target (cameras, placement checks) */ };
const EMPTY: readonly ShieldPanel[] = [];

interface Item {
  spec: TimerDisplaySpec;
  from: 'scene.json' | 'node';
  node: string;
  surface: THREE.Mesh;
  /** the node's other plain meshes (the glowing dome behind a halo quad): what the panel should sit inside */
  rest: THREE.Mesh[];
  /** their reach along the picture's right / up from the surface centre (m), measured on first use (tests only); undefined = not yet, null = none */
  around: [number, number, number, number] | null | undefined;
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  tex: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  w: number;
  h: number;
  stats: SurfaceStats;
  orient: Orientation;
  /** the surface's centre in the world (tests: where the picture should be) */
  centre: THREE.Vector3;
  /** the surface material's own glow colour (a default for the digits), '' = none */
  glow: string;
  ch: GovChannel;
  alpha: number;
  // what the picture was last drawn for
  a: number; b: number; ps: number; rev: number; acc: string;
  /** the picture's key (TimerFace.key): an identical picture is never uploaded again */
  key: string;
  dirty: boolean;
  lastDraw: number;
  draws: number;
  face: TimerFace | null;
  /** the glass panel in the world (the goals board must keep clear of it), cached; null = not measured yet / the look changed */
  panel: ShieldPanel | null;
}

export class TimerDisplays implements BoardShield {
  private rt: SceneRuntime | null = null;
  private items: Item[] = [];
  private missing: string[] = [];
  private skipped: { node: string; why: string }[] = [];
  private hide: TimerHide = 'no-view';
  private live: ShieldPanel[] = [];
  private liveFor = -1;
  palette: StagePalette | null = null;

  /** Find the room's displays (nodes + scene.json) and put an overlay on each one's best surface. */
  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    this.rt = rt;
    const root = rt.room.root;
    root.updateMatrixWorld(true);
    const nodes: RoomNodeRef[] = [];
    const byName = new Map<string, THREE.Object3D>();
    root.traverse((o) => {
      if (!o.name || o.name.startsWith('vtp:')) return;
      nodes.push({ name: o.name, parent: o.parent?.name ?? '', extras: o.userData });
      if (!byName.has(o.name)) byName.set(o.name, o);
    });
    const plan = planTimerDisplays((rt.info as unknown as { timerDisplays?: unknown }).timerDisplays, nodes);
    this.missing = plan.missing;
    for (const t of plan.targets) {
      const obj = byName.get(t.node);
      if (!obj) continue;
      const item = this.build(obj, t.spec, t.from, t.node);
      if (typeof item === 'string') this.skipped.push({ node: t.node, why: item }); else this.items.push(item);
    }
    for (const m of this.missing) console.warn(`timer display: scene.json timerDisplays names "${m}" but the room has no such node`);
    for (const s of this.skipped) console.warn(`timer display: "${s.node}" skipped: ${s.why}`);
  }

  detach() {
    for (const it of this.items) {
      it.mesh.removeFromParent();
      it.mat.dispose();
      it.tex.dispose();
      it.canvas.width = it.canvas.height = 0;
    }
    this.items = []; this.missing = []; this.skipped = []; this.live = []; this.liveFor = -1;
    this.rt = null;
    this.hide = 'no-view';
  }

  private build(obj: THREE.Object3D, spec: TimerDisplaySpec, from: Item['from'], node: string): Item | string {
    const meshes: THREE.Mesh[] = [];
    obj.traverse((c) => {
      const m = c as THREE.Mesh;
      // (a plain single-material mesh: skinned / instanced ones and one geometry holding several materials cannot carry a picture)
      if (m.isMesh && !(m as THREE.SkinnedMesh).isSkinnedMesh && !(m as THREE.InstancedMesh).isInstancedMesh && m.geometry && !m.name.startsWith('vtp:')
        && !(Array.isArray(m.material) && (m.geometry as THREE.BufferGeometry).groups.length > 1)) meshes.push(m);
    });
    if (!meshes.length) return 'it has no plain mesh (a skinned or instanced mesh, or one with several materials in one piece, cannot carry a display)';
    const matOf = (m: THREE.Mesh) => (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material | undefined;
    const cand = meshes.map((m) => {
      const g = m.geometry as THREE.BufferGeometry;
      const pos = g.getAttribute('position'), uv = g.getAttribute('uv');
      m.updateWorldMatrix(true, false);
      const stats = pos && uv ? surfaceStats(pos, uv, g.getIndex(), m.matrixWorld.elements, m.matrixWorld.determinant() < 0) : null;
      return { stats, material: matOf(m)?.name ?? '' };
    });
    const best = pickSurface(cand, spec.material);
    if (best < 0 || !cand[best].stats) return 'no mesh in it has usable UVs (the countdown is drawn onto a mesh\'s UVs)';
    const surface = meshes[best], stats = cand[best].stats!;
    const centre = new THREE.Box3().setFromObject(surface).getCenter(new THREE.Vector3());
    if (!stats.ok) console.warn(`timer display "${node}": ${stats.why}; the digits may not read. Use a flat TIMER_DISPLAY plane for it.`);
    const orient = orientation(stats);
    const { w, h } = canvasSize(orient.aspect, LONG_SIDE);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const g = canvas.getContext('2d');
    if (!g) return 'no 2D canvas';
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;               // (glTF UVs have v = 0 at the top of the picture)
    tex.anisotropy = 4;
    tex.matrixAutoUpdate = false;
    const [a, b, c, d, e, f] = uvMatrix(stats, orient);
    tex.matrix.set(a, b, c, d, e, f, 0, 0, 1);
    const src = matOf(surface);
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0, depthWrite: false, toneMapped: false, fog: false,
      side: src?.side ?? THREE.FrontSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    mat.name = 'vtp:timer';
    const mesh = new THREE.Mesh(surface.geometry, mat);
    mesh.name = 'vtp:timer';
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = surface.renderOrder + 2;
    mesh.castShadow = false; mesh.receiveShadow = false; mesh.frustumCulled = surface.frustumCulled;
    mesh.layers.mask = surface.layers.mask;
    mesh.raycast = noRaycast;
    mesh.visible = false;
    surface.add(mesh);
    let glow = '';
    const sm = src as THREE.MeshStandardMaterial | undefined;
    if (sm?.emissive && sm.emissive.r * sm.emissiveIntensity + sm.emissive.g * sm.emissiveIntensity + sm.emissive.b * sm.emissiveIntensity > 0.25) glow = `#${sm.emissive.getHexString()}`;
    return {
      spec, from, node, surface, rest: meshes.filter((m) => m !== surface), around: undefined, mesh, mat, tex, canvas, g, w, h, stats, orient, centre, glow, ch: govChannel(`timer ${node}`), alpha: 0,
      a: NaN, b: NaN, ps: -2, rev: -1, acc: '\u0000', key: '', dirty: true, lastDraw: -Infinity, draws: 0, face: null, panel: null,
    };
  }

  /** Once per frame (cheap: free in rooms without a display, no work while idle). */
  update(dt: number) {
    const items = this.items;
    if (!items.length) return;
    const v = goalsStore.view;
    const hide = timerHidden(v);
    this.hide = hide;
    const want = hide === '' ? 1 : 0;
    const wall = Date.now();
    const now = goalsStore.now();
    for (const it of items) {
      if (want) this.refresh(it, v!, now, wall);
      if (it.alpha === want) continue;
      // fade in / out: the picture never switches on or off in one frame (a big dark panel over a bright dome is a big change)
      it.alpha += (want - it.alpha) * (1 - Math.exp(-Math.max(0, dt) * 5));
      if (Math.abs(want - it.alpha) < 0.01) it.alpha = want;
      const vis = it.alpha > 0.003;
      if (it.mesh.visible !== vis) it.mesh.visible = vis;
      it.mat.opacity = it.alpha;
    }
  }

  private refresh(it: Item, v: NonNullable<typeof goalsStore.view>, now: number, wall: number) {
    const sub = v.sub!;
    const mode = it.spec.show || sub.display;
    const a = Math.floor(timerMainMs(sub, now, mode) / 1000);
    const b = Math.floor(timerOtherMs(sub, now, mode) / 1000);
    const pops = goalsStore.pops;
    const ps = popSig(pops, wall);
    const acc = this.palette?.accent ?? '';
    const palChanged = acc !== it.acc;
    if (!it.dirty && !palChanged && a === it.a && b === it.b && ps === it.ps && goalsStore.rev === it.rev) return;
    const t = performance.now();
    if (t - it.lastDraw < MIN_GAP) return;
    const face = timerFace(v, now, wall, pops, { show: it.spec.show, label: it.spec.label });
    if (!face) return;
    if (palChanged) it.dirty = true;
    it.a = a; it.b = b; it.ps = ps; it.rev = goalsStore.rev; it.acc = acc;
    // a new view that changes nothing on this display (another goal moved, a heartbeat) is not a new picture
    if (!it.dirty && face.key === it.key) return;
    // a pop eases through the flash governor like every other brightness change in the room
    const k = face.pop ? face.pop.k : 0;
    const gk = governK(pageGovernor(performance.timeOrigin + t), it.ch, k, 1, 0.3);
    // (a pop the governor held back is retried on the next frames: its key alone would not change)
    const held = !!face.pop && gk < face.pop.k;
    if (face.pop) face.pop.k = Math.min(face.pop.k, Math.max(0, gk));
    const p = this.palette;
    drawTimerFace(it.g, it.w, it.h, face, {
      style: it.spec.style, color: it.spec.color || it.glow || p?.accent || DEFAULT_LOOK.accent,
      hero: p?.hero ?? DEFAULT_LOOK.hero, ink: DEFAULT_TIMER_PAINT.ink, fit: it.spec.fit, glass: it.spec.glass,
    });
    it.tex.needsUpdate = true;
    it.key = face.key; it.dirty = held; it.lastDraw = t; it.draws++; it.face = face;
  }

  /** Test pages: change a display's look in place (a contact sheet of the three styles without three scene loads). */
  setSpec(i: number, patch: Partial<Pick<TimerDisplaySpec, 'style' | 'color' | 'show' | 'label' | 'fit' | 'glass'>>) {
    const it = this.items[i];
    if (!it) return false;
    if (patch.style && TIMER_STYLES.includes(patch.style as TimerStyle)) it.spec = { ...it.spec, style: patch.style };
    if (patch.color !== undefined) it.spec = { ...it.spec, color: patch.color };
    if (patch.show !== undefined) it.spec = { ...it.spec, show: patch.show };
    if (patch.label !== undefined) it.spec = { ...it.spec, label: patch.label };
    if (patch.fit !== undefined) it.spec = { ...it.spec, fit: cleanFit(patch.fit) };
    if (patch.glass !== undefined) it.spec = { ...it.spec, glass: cleanGlass(patch.glass) };
    it.dirty = true; it.lastDraw = -Infinity; it.panel = null; this.liveFor = -1;
    return true;
  }

  get count() { return this.items.length; }

  /** Test pages: a display's painted canvas, the rows it is laid out in and the digits' colour, to measure the picture itself (no camera, lighting or perspective in the way). */
  picture(i: number) {
    const it = this.items[i];
    return it ? { canvas: it.canvas, rows: timerRows(it.w, it.h, it.spec.fit), color: it.spec.color || it.glow || this.palette?.accent || DEFAULT_LOOK.accent } : null;
  }

  /** What the panel should sit inside: the node's other meshes' reach along the picture's right / up from the surface centre (m); null = none. Test pages only (walks the vertices once). */
  private aroundOf(it: Item) {
    if (it.around !== undefined) return it.around;
    const pts: number[] = [], v = new THREE.Vector3();
    for (const m of it.rest) {
      const pos = m.geometry.getAttribute('position');
      if (!pos) continue;
      m.updateWorldMatrix(true, false);
      for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); pts.push(v.x, v.y, v.z); }
    }
    it.around = extentAlong(pts, it.orient, [it.centre.x, it.centre.y, it.centre.z]);
    return it.around;
  }

  /**
   * Test pages: each display's rectangles in the world (centre + four corners, top-left first) to project into the shot: the surface's whole
   * picture, the glass panel inside it (its `fit`) and, when the node has other meshes, the box they cover (the dome the panel sits in; null = none).
   */
  worldRects() {
    return this.items.map((it) => {
      const o = it.orient, c = it.centre;
      const at = (r: number, u: number): [number, number, number] => [c.x + o.right[0] * r + o.up[0] * u, c.y + o.right[1] * r + o.up[1] * u, c.z + o.right[2] * r + o.up[2] * u];
      const box = (r0: number, r1: number, u0: number, u1: number) => [at(r0, u1), at(r1, u1), at(r1, u0), at(r0, u0)];
      const hw = o.sizeM[0] / 2, hh = o.sizeM[1] / 2;
      const [pw, ph] = this.panelSize(it);
      const ar = this.aroundOf(it);
      return { centre: [c.x, c.y, c.z] as [number, number, number], corners: box(-hw, hw, -hh, hh), panel: box(-pw / 2, pw / 2, -ph / 2, ph / 2), around: ar ? box(ar[0], ar[1], ar[2], ar[3]) : null };
    });
  }

  /** The glass panel's size on the surface in metres (the widest clock: the panel is as big as it ever gets). */
  private panelSize(it: Item): [number, number] {
    return timerFootprint(it.orient.sizeM, it.w, it.h, WIDEST, it.spec.style === 'lcd', it.spec.fit).panel as [number, number];
  }

  /**
   * The glass panels of the displays that are LIVE right now (a subathon is running, "In the room" is on, the card is not goals-only); empty
   * while every display is hidden, so a hidden display never keeps anything clear. World quads (top-left first), measured once and kept until
   * a display's look changes: the hanging goals board (goalsWorld.ts) asks this a few times a second and must never cover one.
   */
  panels(): readonly ShieldPanel[] {
    if (this.hide !== '' || !this.items.length) return EMPTY;
    if (this.liveFor !== this.items.length) {
      for (const it of this.items) {
        if (it.panel) continue;
        const o = it.orient, c = it.centre, [pw, ph] = this.panelSize(it);
        const at = (r: number, u: number) => new THREE.Vector3(c.x + o.right[0] * r + o.up[0] * u, c.y + o.right[1] * r + o.up[1] * u, c.z + o.right[2] * r + o.up[2] * u);
        it.panel = { corners: [at(-pw / 2, ph / 2), at(pw / 2, ph / 2), at(pw / 2, -ph / 2), at(-pw / 2, -ph / 2)], centre: c.clone() };
      }
      this.live = this.items.map((it) => it.panel!);
      this.liveFor = this.items.length;
    }
    return this.live;
  }

  /** The glass panel and the widest digit run in metres, the node's other meshes' reach and how far the panel hangs past them (<= 0 = inside). */
  private footprint(it: Item) {
    const fp = timerFootprint(it.orient.sizeM, it.w, it.h, WIDEST, it.spec.style === 'lcd', it.spec.fit), ar = this.aroundOf(it), r3 = (x: number) => +x.toFixed(3);
    const oh = overhang(fp.panel, ar);
    return { panelM: fp.panel.map(r3), digitsM: fp.digits.map(r3), aroundM: ar ? ar.map(r3) : null, overhangM: oh === null ? null : r3(oh) };
  }

  debug() {
    return {
      hide: this.hide,
      missing: this.missing.slice(),
      skipped: this.skipped.slice(),
      displays: this.items.map((it) => ({
        node: it.node, from: it.from, style: it.spec.style, color: it.spec.color || it.glow || '', show: it.spec.show, label: it.spec.label, fit: it.spec.fit, glass: it.spec.glass,
        ...this.footprint(it),
        surface: it.surface.name || it.surface.parent?.name || '', material: (Array.isArray(it.surface.material) ? it.surface.material[0] : it.surface.material)?.name ?? '',
        visible: it.mesh.visible, alpha: +it.alpha.toFixed(3), draws: it.draws, canvas: [it.w, it.h],
        ok: it.stats.ok, why: it.stats.why, flat: +it.stats.flat.toFixed(3), coverage: +it.stats.coverage.toFixed(3), uv: it.stats.uv.map((x) => +x.toFixed(3)),
        sizeM: [+it.stats.width.toFixed(3), +it.stats.height.toFixed(3)], mirrored: it.orient.mirrored, turns: it.orient.turns, aspect: +it.orient.aspect.toFixed(3),
        face: it.face ? { state: it.face.state, main: it.face.main, sub: it.face.sub, badges: it.face.badges.map((b) => b.text), pop: it.face.pop, test: it.face.test, urgent: it.face.urgent } : null,
      })),
    };
  }

  dispose() { this.detach(); }
}
