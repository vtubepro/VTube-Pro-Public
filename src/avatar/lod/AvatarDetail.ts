// Avatar detail (docs/PERFORMANCE.md "Avatar detail"): one per own-avatar runtime. Very detailed avatars get lighter
// INDEX-ONLY levels of their body, clothes and hair; the triangle list of the SAME geometry is swapped, nothing else:
// vertices, shape keys, skin weights, UVs, materials, shaders, bones, spring bones and morph textures never change, and
// the face triangles are identical at every level, so expressions and lip sync are exact by construction.
//
// Prepare (after AvatarRuntime.build, never blocking the load): src/avatar/lod/extract.ts (main thread, <= 4 ms slices)
// -> src/avatar/lod/lodClient.ts (one worker per page while it has jobs, one geometry per job) -> install (level
// BufferAttributes shared with the twins: one GPU buffer per level). Avatars under the gate are left alone
// ('light-model'), also when the choice changes to Auto after levels were made for Lighter / Lightest (L0 at once, the
// levels are kept for a later switch back).
// Select (tick, every 0.5 s): pixels per metre of every camera that drew the avatar in the last 0.5 s (onBeforeRender of
// the largest eligible meshes: compositor tiles and performer cams count, shadow passes do not), the nearest point of the
// avatar's bounding sphere; the level is the coarsest whose error is <= T px. Finer at once (a render whose camera sees
// the drawn level over T, e.g. a cut from a wide shot to a close-up, makes the NEXT tick refine, past the 0.5 s pick
// spacing: one frame late at most), coarser only after the target held at <= 0.8 T for 1 s and >= 0.5 s after the last
// change, no camera for 1 s = keep the level.
// Pinned to L0: choice Full, resting (marker placement), thumbnails. A geometry under a runtime overlay (food mess:
// src/avatar/lod/fullIndex.ts holdFull) is drawn at L0 while it shows. dispose() puts the original indices back.
import * as THREE from 'three';
import {
  DETAIL_COARSEN_HOLD_MS, DETAIL_COARSEN_K, DETAIL_GATE_TRIS, DETAIL_KEEP, DETAIL_MM, DETAIL_NO_CAMERA_MS, DETAIL_PICK_MS, DETAIL_REF_MM,
  coarsestWithin, detailThreshold, detailWanted, leverWorthIt, type AvatarDetailChoice,
} from '../../../shared/avatarDetail.ts';
import { keepLevels } from '../../../shared/lod/levels.ts';
import { DetailCancelled, detailSnapshot, extractDetail, type DetailEntry, type DetailSnapshot, type DetailSource, type RawJob } from './extract.ts';
import { heldFull, watchHold } from './fullIndex.ts';
import { lodClient, type LodResult } from './lodClient.ts';
import type { TexCapInfo } from './textureCap.ts';

export type DetailState = 'light-model' | 'preparing' | 'ready' | 'failed' | 'full';

/** What the controller needs from the runtime (structural: no import of AvatarRuntime). */
export interface DetailHost extends DetailSource {
  info: { triangles: number };
  detailTex?: TexCapInfo | null;
  /** Time Avatar detail added to the avatar's load (ms). */
  detailLoadMs?: number;
}

interface Built { e: DetailEntry; levels: THREE.BufferAttribute[]; res: LodResult }

export interface DetailInfo {
  choice: AvatarDetailChoice; state: DetailState; level: number; requested: number; T: number; pressure: number; reason: string;
  l0Tris: number; drawnTris: number; faceTris: number;
  levels: { tris: number; verts: number; mm: number; kept: boolean }[];
  buildMs: number; extractMs: number; longestSliceMs: number; longestSliceAt: string; geometries: number; skipped: { name: string; why: string; tris: number }[];
  switches: number; switchMsP95: number; pxPerM: number;
  tex: TexCapInfo | null;
  /** Time it added to the avatar's load (texture cap + start), ms. */
  loadMs: number;
}

const v4 = new THREE.Vector4(), vc = new THREE.Vector3(), vp = new THREE.Vector3();

/** Auto's OBS pressure: would the allowed error `T` (px) of a higher pressure take enough off what the page draws to be
 *  worth acting on? Summed over the page's own Auto avatars (AvatarDetail.savingAt), against every avatar triangle the
 *  page draws (shared/avatarDetail.ts leverWorthIt: at least DETAIL_LEVER_MIN_SHARE). output.ts asks this for the
 *  governor (helps) and for vtpOut.detail.helps. */
export function pressureHelps(autos: readonly { savingAt(T: number): number }[], T: number, pageAvatarTris: number): boolean {
  let saved = 0;
  for (const d of autos) saved += d.savingAt(T);
  return leverWorthIt(saved, pageAvatarTris);
}

export class AvatarDetail {
  choice: AvatarDetailChoice;
  pressure = 0;
  /** Requested level (0..3) and the level actually drawn (after the keep rule's aliasing). */
  level = 0;
  shown = 0;
  reason = '';
  private phase: 'idle' | 'preparing' | 'ready' | 'failed' = 'idle';
  private disposed = false;
  private gen = 0;
  private built: Built[] = [];
  private skipped: DetailInfo['skipped'] = [];
  private eff = [0, 0, 0, 0];
  private totals = [0, 0, 0, 0];
  private verts = [0, 0, 0, 0];
  private mmAch = [0, 0, 0, 0];
  private faceTris = 0;
  private restHeight = 1.7;
  private attachScale = 1;
  private sphere = new THREE.Sphere();
  private pins = new Set<string>();
  private forced: number | null = null;
  private urlPin: number | null;
  private wrapped: { mesh: THREE.Mesh; prev: THREE.Mesh['onBeforeRender']; fn: THREE.Mesh['onBeforeRender'] }[] = [];
  private winMax = 0;
  private pxm = 0;
  private lastSeenAt = -1e9;
  private lastPick = -1e9;
  private lastSwitch = -1e9;
  /** A render saw the drawn level over T (a camera cut to a close-up): the next tick refines at once. */
  private refine = false;
  private coarseSince = 0;
  private coarseMin = 0;
  private buildMs = 0;
  private extractMs = 0;
  private longestSlice = 0;
  private longestAt = '';
  private switchMs: number[] = [];
  switches = 0;
  /** Fires after every level change. */
  onSwitch: ((level: number, now: number) => void) | null = null;

  private clock: () => number;
  private snap: DetailSnapshot | null;
  private runner: (raw: RawJob, alive: () => boolean) => Promise<LodResult | null>;

  /** `opts.pin`: a test page's pinned level. `opts.clock` / `opts.runner`: unit tests (tools/lod_switch_unit.ts) drive
   *  time and build the levels in-process; the page uses performance.now() and the lod worker. */
  constructor(private rt: DetailHost, choice: AvatarDetailChoice, opts: { pin?: number | null; clock?: () => number; runner?: (raw: RawJob, alive: () => boolean) => Promise<LodResult | null> } = {}) {
    this.choice = choice;
    this.urlPin = opts.pin ?? null;
    this.clock = opts.clock ?? (() => performance.now());
    this.runner = opts.runner ?? ((raw, alive) => lodClient.run(raw, alive));
    // the avatar as built (still where the load put it): whatever the page does with it before the levels are made
    this.snap = rt.info.triangles >= DETAIL_GATE_TRIS.lighter ? detailSnapshot(rt) : null;
    if (this.wanted()) void this.prepare();
  }

  /** Levels wanted for this avatar now (choice + the triangle gate; a pinned test level builds from 50,000). Checked
   *  live, not only before the levels exist: a model under Auto's gate that got levels on Lighter draws L0 on Auto. */
  private wanted() { return detailWanted(this.choice, this.rt.info.triangles, (this.urlPin ?? 0) > 0); }

  /** The camera picks the level (no pin, no forced / URL level, levels wanted). */
  private autoPick() { return !this.pins.size && this.forced === null && this.urlPin === null && this.wanted(); }

  get state(): DetailState {
    if (this.choice === 'full') return 'full';
    if (!this.wanted()) return 'light-model';
    return this.phase === 'idle' ? 'preparing' : this.phase;
  }

  get ready() { return this.phase === 'ready'; }

  /** Auto with levels ready on an avatar over the triangle gate: Avatar detail is an OBS lever for it (output.ts). */
  get autoActive(): boolean { return this.choice === 'auto' && this.phase === 'ready' && this.wanted(); }

  /** Triangles drawn now (every geometry held at L0 by an overlay counts in full). */
  get drawnTris(): number { return this.drawnAt(this.shown); }

  /** A new choice from the scene state (live: geometry levels follow at once; textures only at the next load). */
  setChoice(c: AvatarDetailChoice) {
    if (c === this.choice) return;
    this.choice = c;
    if (this.phase === 'idle' && this.wanted()) void this.prepare();
    // Full, or Auto on a model under its triangle gate: every triangle at once (the levels stay for a later choice)
    if (this.phase === 'ready' && !this.wanted()) this.switchTo(0, this.clock());
    this.lastPick = -1e9;   // the next tick picks for the new choice's T
  }

  setPressure(p: number) { this.pressure = p; }

  /** Allowed on-screen error (px). */
  get T() { return detailThreshold(this.choice, this.pressure); }

  /** Pin Full for a reason ('rest' = marker placement, 'thumb' = thumbnail capture); takes effect at once. */
  pin(reason: string, on: boolean) {
    if (on) this.pins.add(reason); else this.pins.delete(reason);
    if (on && this.phase === 'ready') this.switchTo(0, this.clock());
  }

  /** Test hook: hold a level (null = automatic again). */
  force(k: number | null) {
    this.forced = k === null ? null : Math.max(0, Math.min(3, Math.round(k)));
    if (this.forced !== null && this.phase === 'ready') this.switchTo(this.forced, this.clock());
  }

  // ------------------------------------------------------------------ prepare
  private async prepare() {
    if (this.disposed || this.phase === 'preparing' || this.phase === 'ready') return;
    this.phase = 'preparing';
    const gen = ++this.gen;
    const alive = () => !this.disposed && this.gen === gen;
    const t0 = performance.now();
    try {
      this.snap ??= detailSnapshot(this.rt);
      const ex = await extractDetail(this.rt, this.snap, { alive });
      this.extractMs = ex.ms; this.longestSlice = ex.longestSlice; this.longestAt = ex.longestAt;
      this.skipped = ex.skipped;
      this.restHeight = ex.restHeight;
      const res = await Promise.all(ex.entries.map((e) => { const raw = e.raw!; e.raw = null; return this.runner(raw, alive); }));
      if (!alive()) return;
      const built: Built[] = [];
      ex.entries.forEach((e, i) => {
        const r = res[i];
        if (!r) return;
        if (r.skip) { this.skipped.push({ name: e.name, why: r.skip, tris: e.tris }); return; }
        built.push({ e, res: r, levels: r.levels.map((l) => new THREE.BufferAttribute(l.index, 1)) });
      });
      this.install(built);
      this.buildMs = performance.now() - t0;
      this.phase = 'ready';
    } catch (err) {
      if (err instanceof DetailCancelled || !alive()) return;
      console.warn('avatar detail', err);
      this.reason = `could not prepare: ${(err as Error).message}`;
      this.phase = 'failed';
    }
  }

  private install(built: Built[]) {
    this.built = built;
    const all = this.rt.info.triangles;
    const builtL0 = built.reduce((a, b) => a + b.e.tris, 0);
    this.faceTris = all - builtL0 + built.reduce((a, b) => a + b.res.faceTris, 0);
    this.totals = [all, 0, 0, 0];
    this.verts = [built.reduce((a, b) => a + b.res.l0Verts, 0), 0, 0, 0];
    for (let k = 1; k <= 3; k++) {
      this.totals[k] = all - builtL0 + built.reduce((a, b) => a + (b.res.levels[k - 1]?.tris ?? b.e.tris), 0);
      this.verts[k] = built.reduce((a, b) => a + (b.res.levels[k - 1]?.verts ?? b.res.l0Verts), 0);
      this.mmAch[k] = built.reduce((a, b) => Math.max(a, b.res.levels[k - 1]?.mm ?? 0), 0);
    }
    this.eff = keepLevels(this.totals, DETAIL_KEEP);
    // (a toon outline is a clone: BufferGeometry.copy SHARES the userData object, so each twin gets its own first)
    for (const b of built) for (const t of b.e.twins) if (t.userData === b.e.geometry.userData) t.userData = { ...t.userData };
    for (const b of built) for (const [g, l0] of b.e.l0) g.userData.vtpLodFull = l0;
    // an overlay (food mess) that starts / stops on a geometry: L0 for it at once, or its level back
    for (const b of built) watchHold(b.e.geometry, () => { if (!this.disposed) this.apply(b, this.shown); });
    // the avatar's rest bounding sphere in wrapper space (distance for the pixel error)
    const w = this.rt.wrapper;
    w.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(this.rt.model);
    // (the rest height was measured at attach: the level errors scale with the wrapper from THAT size)
    this.attachScale = this.snap?.wrapperScale ?? (w.matrixWorld.getMaxScaleOnAxis() || 1);
    if (!box.isEmpty()) {
      box.getBoundingSphere(this.sphere);
      this.sphere.center.applyMatrix4(new THREE.Matrix4().copy(w.matrixWorld).invert());
      this.sphere.radius /= w.matrixWorld.getMaxScaleOnAxis() || 1;
    }
    // cameras: the biggest eligible meshes report every render they are drawn in
    const meshes = built.map((b) => b.e.mesh).sort((a, b) => (b.geometry.index?.count ?? 0) - (a.geometry.index?.count ?? 0)).slice(0, 3);
    for (const mesh of meshes) {
      const prev = mesh.onBeforeRender;
      const self = this;
      const fn: THREE.Mesh['onBeforeRender'] = function (this: THREE.Mesh, renderer, scene, camera, geometry, material, group) {
        if (!self.disposed) self.seeCamera(renderer, camera);
        prev.call(this, renderer, scene, camera, geometry, material, group);
      };
      mesh.onBeforeRender = fn;
      this.wrapped.push({ mesh, prev, fn });
    }
  }

  /** One render of the avatar: pixels per world unit at its nearest point. */
  private seeCamera(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
    renderer.getCurrentViewport(v4);
    const h = v4.w;
    if (!(h > 0)) return;
    const P = camera.projectionMatrix.elements;
    let ppu: number;
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) ppu = (h / 2) * P[5];
    else {
      const w = this.rt.wrapper.matrixWorld;
      vc.copy(this.sphere.center).applyMatrix4(w);
      const r = this.sphere.radius * (w.getMaxScaleOnAxis() || 1);
      vp.setFromMatrixPosition(camera.matrixWorld);
      const d = Math.max((camera as THREE.PerspectiveCamera).near ?? 0.01, vp.distanceTo(vc) - r);
      ppu = ((h / 2) * Math.abs(P[5])) / d;
    }
    if (ppu > this.winMax) this.winMax = ppu;
    this.lastSeenAt = this.clock();
    // the drawn level is over the allowed error for THIS camera (a cut from a wide shot to a close-up): don't wait for
    // the 0.5 s pick, refine on the next tick (the level can't change in the middle of a frame's renders)
    if (this.shown > 0 && !this.refine && this.errAt(this.shown) * ppu > this.T && this.autoPick()) this.refine = true;
  }

  /** Auto under OBS pressure: how many triangles would the allowed error `T` (px) take off what this avatar draws now
   *  (and off what the current T would have it draw anyway)? Same rule as tick() (coarser only within DETAIL_COARSEN_K x
   *  T, kept levels only), at the camera of the last pick. 0 when it can't change anything: not Auto, not ready, no
   *  levels, under the triangle gate, pinned / forced, no camera drew it in the last second (off screen: lighter levels
   *  save nothing), every level the larger T allows is merged by the keep rule into the one already drawn, or every
   *  geometry it would lighten is held at L0 by an overlay. output.ts sums this over its own Auto avatars and raises the
   *  pressure (holding the render scale back) only when that is a real share of the page's avatar triangles
   *  (pressureHelps). */
  savingAt(T: number): number {
    if (this.phase !== 'ready' || this.disposed || this.choice !== 'auto' || !this.built.length || !this.autoPick()) return 0;
    if (!(this.pxm > 0) || this.clock() - this.lastSeenAt > DETAIL_NO_CAMERA_MS) return 0;
    const err = this.errors();
    const cur = this.eff[coarsestWithin(err, this.pxm, this.T * DETAIL_COARSEN_K)] ?? 0;
    const base = Math.max(this.shown, cur);
    const next = this.eff[coarsestWithin(err, this.pxm, T * DETAIL_COARSEN_K)] ?? 0;
    return next > base ? Math.max(0, this.drawnAt(base) - this.drawnAt(next)) : 0;
  }

  /** Would the allowed error `T` (px) draw this avatar lighter at all (savingAt > 0)? */
  lightensAt(T: number): boolean { return this.savingAt(T) > 0; }

  /** Triangles the avatar draws at (kept) level k: geometries held at L0 by an overlay count in full. */
  private drawnAt(k: number): number {
    if (!this.built.length) return this.rt.info.triangles;
    let n = this.totals[0];
    if (k > 0) for (const b of this.built) if (!heldFull(b.e.geometry)) n -= b.e.tris - (b.res.levels[k - 1]?.tris ?? b.e.tris);
    return n;
  }

  /** World error of each level now (the avatar may have been scaled since it was prepared). */
  private errors(): number[] {
    return [0, ...DETAIL_MM.map((_, i) => this.errAt(i + 1))];
  }

  /** World error of level k (1..3) now. */
  private errAt(k: number): number {
    const ratio = (this.rt.wrapper.matrixWorld.getMaxScaleOnAxis() || 1) / this.attachScale;
    return ((DETAIL_MM[k - 1] ?? 0) / DETAIL_REF_MM) * this.restHeight * ratio;
  }

  // ------------------------------------------------------------------ select + switch
  /** Every frame before the render. */
  tick(now = this.clock()) {
    if (this.phase !== 'ready' || this.disposed) return;
    const urgent = this.refine;   // a render last frame saw the drawn level over T: pick now
    if (!urgent && now - this.lastPick < DETAIL_PICK_MS) return;
    this.refine = false;
    this.lastPick = now;
    let want: number;
    // pinned, Full, or a model under the choice's triangle gate (Auto after a live change from Lighter): every triangle
    if (this.pins.size || !this.wanted()) want = 0;
    else if (this.forced !== null) want = this.forced;
    else if (this.urlPin !== null) want = this.urlPin;
    else {
      const pxm = this.winMax;
      this.winMax = 0;
      if (now - this.lastSeenAt > DETAIL_NO_CAMERA_MS || !(pxm > 0)) return;   // no camera: keep the level
      this.pxm = pxm;
      const err = this.errors(), T = this.T;
      const need = coarsestWithin(err, pxm, T);
      const coarse = coarsestWithin(err, pxm, T * DETAIL_COARSEN_K);
      if (err[this.shown] * pxm > T) { want = need; this.coarseSince = 0; }               // too coarse: finer at once
      else if (coarse > this.level) {
        if (!this.coarseSince) { this.coarseSince = now; this.coarseMin = coarse; } else this.coarseMin = Math.min(this.coarseMin, coarse);
        want = now - this.coarseSince >= DETAIL_COARSEN_HOLD_MS ? this.coarseMin : this.level;
        if (want !== this.level) this.coarseSince = 0;
      } else { this.coarseSince = 0; want = this.level; }
    }
    const target = this.eff[want] ?? 0;
    if (target === this.shown) { this.level = want; return; }
    // finer: at once (a close-up must never wait); coarser: at most one change per 0.5 s
    if (target > this.shown && now - this.lastSwitch < DETAIL_PICK_MS) return;
    this.switchTo(want, now);
  }

  /** One geometry and its twins at (kept) level `shown`, or at L0 while an overlay holds it. */
  private apply(b: Built, shown: number) {
    const attr = shown === 0 || heldFull(b.e.geometry) ? null : b.levels[shown - 1];
    b.e.geometry.setIndex(attr ?? b.e.l0.get(b.e.geometry)!);
    for (const t of b.e.twins) t.setIndex(attr ?? b.e.l0.get(t)!);
  }

  /** The whole avatar at once, between frames: setIndex on every eligible geometry and its twins. */
  private switchTo(k: number, now: number) {
    const shown = this.eff[k] ?? 0;
    this.level = k;
    if (shown === this.shown) return;
    const t0 = performance.now();
    for (const b of this.built) this.apply(b, shown);
    this.switchMs.push(performance.now() - t0);
    if (this.switchMs.length > 200) this.switchMs.shift();
    this.shown = shown;
    this.lastSwitch = now;
    this.switches++;
    this.onSwitch?.(shown, now);
  }

  // ------------------------------------------------------------------ readouts
  info(): DetailInfo {
    const sw = [...this.switchMs].sort((a, b) => a - b);
    return {
      choice: this.choice, state: this.state, level: this.shown, requested: this.level, T: this.T, pressure: this.pressure, reason: this.reason,
      l0Tris: this.totals[0] || this.rt.info.triangles, drawnTris: this.drawnTris || this.rt.info.triangles, faceTris: this.faceTris,
      levels: [1, 2, 3].map((k) => ({ tris: this.totals[k], verts: this.verts[k], mm: this.mmAch[k], kept: this.eff[k] === k })),
      buildMs: Math.round(this.buildMs), extractMs: Math.round(this.extractMs), longestSliceMs: +this.longestSlice.toFixed(2), longestSliceAt: this.longestAt, geometries: this.built.length, skipped: this.skipped,
      switches: this.switches, switchMsP95: sw.length ? +sw[Math.min(sw.length - 1, Math.floor(sw.length * 0.95))].toFixed(4) : 0, pxPerM: Math.round(this.pxm),
      tex: this.rt.detailTex ?? null,
      loadMs: +(this.rt.detailLoadMs ?? 0).toFixed(2),
    };
  }

  /** The face triangle lists of every prepared geometry (tests: the face mask pass). */
  faceIndex(): { geometry: THREE.BufferGeometry; F: THREE.BufferAttribute }[] {
    return this.built.map((b) => ({ geometry: b.e.geometry, F: new THREE.BufferAttribute((b.levels[0].array as Uint16Array | Uint32Array).slice(0, b.res.faceTris * 3), 1) }));
  }

  /** Put the original indices back, stop listening to cameras, drop the levels. Safe to call twice. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.gen++;
    for (const b of this.built) {
      watchHold(b.e.geometry, null);
      for (const [g, l0] of b.e.l0) { if (g.index !== l0) g.setIndex(l0); delete g.userData.vtpLodFull; }
    }
    this.refine = false;
    for (const w of this.wrapped) if (w.mesh.onBeforeRender === w.fn) w.mesh.onBeforeRender = w.prev;
    this.wrapped = [];
    this.built = [];
    this.shown = 0; this.level = 0;
  }
}
