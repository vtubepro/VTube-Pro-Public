// Room animation clips (docs/SCENES.md "Room animation clips"): every glTF animation in a room's scene.glb loops
// forever, sampled at a DETERMINISTIC time — the room clock (default: wall-clock seconds since UTC midnight, the same
// base as the town engine) modulo the clip's own duration — so the studio preview, every OBS page and party guests
// show the same pose (within their clock skew). Nothing is event-driven, nothing accumulates, nothing drifts.
// Clips are authored in Blender as seamless loops (first key = last key). Keep engine-moved nodes (BOB_xx, SHIP_SAIL,
// SWAY_xx …) out of the clips: animate their children, so the engine's motion and the clip layer compose.
// A room without animations costs nothing (no mixer is created).
//
// Scale-0 FX: rooms hide their FX (explosions, flashes, tracers, salvos) between cues with a scale of (almost) zero —
// Blender's floor is 0.0001 — keyed in the clips, or authored that way for an engine to pop. three.js still culls,
// sorts and DRAWS such a mesh every frame (a degenerate draw call; at High / Ultra again in the glow pass). Every node a
// '.scale' track drives, and every mesh node that loads collapsed, is switched invisible while all three of its scale
// axes are at that floor, and back the moment it grows — the same picture (a collapsed mesh covers no pixel). The check
// runs after the clips (update) and again just before the frame is drawn (syncZeroScale, the OBS page), so nothing an
// engine scales up later in the frame is late. Nodes that were already hidden when the room loaded (scene.json
// hideNodes, areas, screen skins) are never touched; subtrees with lights, points, lines or sprites (they still show
// at zero scale) or with their own scale-animated / huge-scaled children are left alone.
//
// Room prop toggles (src/scene/roomToggles.ts): a clip whose every target node sits under a hidden toggle root is not
// evaluated while it is hidden (setHidden), and picks up at the room clock again when shown.
//
// One-shots: clips named ALERT_* are NOT looped. They stay at the rest pose until a room alert reaction (scene.json
// `reactions`, src/scene/reactions.ts) plays them: posed at (now − start) from the stamp every page shares, then stopped
// (back to the rest pose) once they have run their length — so they must start and end at the rest pose.
import * as THREE from 'three';
import { targetsHidden, underHiddenToggle } from './roomToggles.ts';

/** Clips played only by alert reactions (never looped). */
export const ONE_SHOT_CLIP = /^ALERT_/;

const DAY = 86400;
/** The shared room clock: seconds since UTC midnight (mod 1 day). */
export const roomClock = () => (Date.now() % (DAY * 1000)) / 1000;

/** All three scale axes at or under this = collapsed (Blender's 0.0001 floor, with float32 noise). */
export const ZERO_SCALE = 2e-4;
const MAX_CHILD_SCALE = 100;

/** Does this scale collapse the node to a point? (all three axes ~0; one flat axis can still draw a flat mesh) */
export const isZeroScale = (s: THREE.Vector3) => Math.abs(s.x) <= ZERO_SCALE && Math.abs(s.y) <= ZERO_SCALE && Math.abs(s.z) <= ZERO_SCALE;

type Kinds = THREE.Object3D & { isLight?: boolean; isPoints?: boolean; isLine?: boolean; isSprite?: boolean; isMesh?: boolean };
/** A descendant of a collapsed root may itself be scale-animated and still stay hidden with the root only while no key of its
 *  scale tracks grows it past this (a rig's bones and parts at 0..~1.5: root 2e-4 x 2 is still a point). */
const MAX_ANIM_CHILD_SCALE = 2;
/** May `node` be hidden while its own scale is zero without changing a pixel? (and does hiding it save a draw?)
 *  `scaleMax` = the largest |key| of every `.scale` track by node (Infinity = a track that may overshoot its keys). A scale-animated
 *  descendant no longer vetoes by itself (a collapsed rig: root at 1e-4 over bones keyed 1e-4..1.4 hides with the root): it
 *  vetoes only when a key can grow it past MAX_ANIM_CHILD_SCALE, and a skinned mesh below must be bound to bones under `node`
 *  too (its vertices follow the bones, not the mesh node: bones outside would not be collapsed with it). */
function hideable(node: THREE.Object3D, scaleMax: Map<THREE.Object3D, number>): boolean {
  let ok = true, draws = false, relaxed = false;
  const skinned: THREE.SkinnedMesh[] = [];
  node.traverse((o) => {
    if (!ok) return;
    const x = o as Kinds;
    if (x.isLight || x.isPoints || x.isLine || x.isSprite) { ok = false; return; }
    if (x.isMesh) draws = true;
    if (o === node) return;
    const m = scaleMax.get(o);
    if (m !== undefined) { if (!(m <= MAX_ANIM_CHILD_SCALE)) { ok = false; return; } relaxed = true; }
    if (Math.max(Math.abs(o.scale.x), Math.abs(o.scale.y), Math.abs(o.scale.z)) > MAX_CHILD_SCALE) ok = false;
  });
  if (ok && relaxed) {
    node.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh); });
    for (const sm of skinned) for (const b of sm.skeleton?.bones ?? []) {
      let q: THREE.Object3D | null = b;
      while (q && q !== node) q = q.parent;
      if (!q) return false;
    }
  }
  return ok && draws;
}

export class RoomClips {
  private mixer: THREE.AnimationMixer;
  private actions: { a: THREE.AnimationAction; d: number; targets: (THREE.Object3D | null)[]; off: boolean }[] = [];
  /** The hidden room prop toggle roots (RoomToggles.hidden, mutated in place by the page): clips that only move nodes under
   *  them stop being evaluated; an action rebuilt by freeze() / release() is checked against it again. */
  private hiddenRoots: ReadonlySet<THREE.Object3D> = new Set();
  /** The clips as authored (freeze() rebuilds the actions from them). */
  private originals: THREE.AnimationClip[] = [];
  /** Nodes no track may drive (the Room editor's moved objects) / nodes whose `.scale` tracks were released. */
  private frozen = new Set<THREE.Object3D>();
  private released = new Set<THREE.Object3D>();
  /** Nodes this layer may hide while collapsed (`hidden` = hidden by us right now). */
  private pops: { node: THREE.Object3D; hidden: boolean }[] = [];
  private hideZero = true;
  /** The ALERT_* clips as authored (buildShots() rebuilds the one-shot actions from them) … */
  private shotClips: THREE.AnimationClip[] = [];
  /** … and their actions by clip name: `on` = playing (bound to the mixer); stopped = the rest pose. */
  private shots = new Map<string, { a: THREE.AnimationAction; d: number; on: boolean }>();
  /** Starts (epoch ms) the reactions layer asked for. */
  private want: { name: string; at: number }[] = [];

  private constructor(root: THREE.Object3D, clips: THREE.AnimationClip[]) {
    this.mixer = new THREE.AnimationMixer(root);
    const scaleTargets = new Set<THREE.Object3D>();
    const scaleMax = new Map<THREE.Object3D, number>();
    for (const clip of clips) {
      if (!(clip.duration > 0)) continue;
      if (ONE_SHOT_CLIP.test(clip.name)) this.shotClips.push(clip);   // (built below, once the scale-0 FX are known)
      else {
        this.originals.push(clip);
        const a = this.mixer.clipAction(clip);
        a.setLoop(THREE.LoopRepeat, Infinity);
        a.play();
        a.paused = true;             // time is set by hand every frame (deterministic), never advanced by the mixer
        this.actions.push({ a, d: clip.duration, targets: clipTargets(root, clip), off: false });
      }
      for (const t of clip.tracks) {
        const p = THREE.PropertyBinding.parseTrackName(t.name);
        if (p.propertyName !== 'scale' || !p.nodeName) continue;
        const n = THREE.PropertyBinding.findNode(root, p.nodeName) as THREE.Object3D | undefined;
        if (n && n !== root) {
          scaleTargets.add(n);
          let m = scaleMax.get(n) ?? 0;
          if ((t as THREE.KeyframeTrack & { createInterpolant?: { isInterpolantFactoryMethodGLTFCubicSpline?: boolean } }).createInterpolant?.isInterpolantFactoryMethodGLTFCubicSpline) m = Infinity;   // (a spline can overshoot its keys)
          else for (let i = 0; i < t.values.length; i++) { const v = Math.abs(t.values[i]); if (v > m || v !== v) m = v !== v ? Infinity : v; }   // (NaN = unbounded)
          scaleMax.set(n, m);
        }
      }
    }
    this.buildShots();
    // authored visibility as loaded (after hideNodes / areas / screen skins): nodes hidden then are never touched
    const take = new Set<THREE.Object3D>();
    for (const n of scaleTargets) if (n.visible && hideable(n, scaleMax)) take.add(n);
    // meshes that load collapsed and no clip drives (FX an engine pops): the outermost collapsed node of each branch
    const visit = (o: THREE.Object3D) => {
      if (!o.visible || take.has(o)) return;
      if (o !== root && !scaleTargets.has(o) && isZeroScale(o.scale) && hideable(o, scaleMax)) { take.add(o); return; }
      for (const c of o.children) visit(c);
    };
    visit(root);
    for (const n of take) this.pops.push({ node: n, hidden: false });
  }

  /** null when the room has no (usable) clips. */
  static create(root: THREE.Object3D, clips: THREE.AnimationClip[] | undefined): RoomClips | null {
    const list = (clips ?? []).filter((c) => c.duration > 0 && c.tracks.length);
    return list.length ? new RoomClips(root, list) : null;
  }
  /** The looping clips (read only: camera directors find moments in them — src/scene/afk/moments.ts). */
  get list(): THREE.AnimationClip[] { return this.actions.map((x) => x.a.getClip()); }

  get count() { return this.actions.length; }
  /** Collapsed-FX nodes managed / hidden right now (perf report, tests). */
  get zeroScale() { let h = 0; for (const p of this.pops) if (p.hidden) h++; return { managed: this.pops.length, hidden: h }; }
  /** Clips skipped right now (every target under a hidden toggle root). */
  get skipped(): string[] { return this.actions.filter((x) => x.off).map((x) => x.a.getClip().name); }

  /** Room prop toggles: clips that only move nodes under these (hidden) roots stop being evaluated; the rest play on. */
  setHidden(roots: ReadonlySet<THREE.Object3D>) {
    this.hiddenRoots = roots;
    this.syncHidden();
  }
  private syncHidden() {
    for (const x of this.actions) {
      const off = targetsHidden(x.targets, this.hiddenRoots);
      if (off === x.off) continue;
      x.off = off;
      if (off) x.a.stop();                          // (unbinds its tracks: no interpolation, no property writes)
      else { x.a.play(); x.a.paused = true; }
    }
  }

  /** The room's ALERT_* one-shot clips (name → seconds). */
  get oneShots(): Record<string, number> { return Object.fromEntries([...this.shots].map(([k, v]) => [k, +v.d.toFixed(3)])); }
  /** Which one-shots are playing right now (debug / tests). */
  get playing(): string[] { return [...this.shots].filter(([, v]) => v.on).map(([k]) => k); }

  /** One-shot starts to play (epoch ms on this page's clock). The same list every frame = the same pose: no state. */
  setOneShots(list: { name: string; at: number }[]) { this.want = list; }

  /** Tracks no clip may drive: the Room editor's moved objects (freeze) and `.scale` tracks an engine released. */
  private keepTrack = (t: THREE.KeyframeTrack) => {
    const root = this.mixer.getRoot() as THREE.Object3D;
    const p = THREE.PropertyBinding.parseTrackName(t.name);
    const n = p.nodeName ? THREE.PropertyBinding.findNode(root, p.nodeName) as THREE.Object3D | undefined : undefined;
    if (!n) return true;
    if (this.frozen.has(n)) return false;
    return !(p.propertyName === 'scale' && this.released.has(n));
  };

  /** (Re)build the ALERT_* one-shot actions from the authored clips, without the tracks that may not be driven. They are
   *  posed from `want` every frame, so a rebuild while one plays loses nothing. */
  private buildShots() {
    for (const s of this.shots.values()) { s.a.stop(); this.mixer.uncacheAction(s.a.getClip()); }
    this.shots.clear();
    for (const clip of this.shotClips) {
      const tracks = clip.tracks.filter(this.keepTrack);
      if (!tracks.length) continue;
      const a = this.mixer.clipAction(tracks.length === clip.tracks.length ? clip : new THREE.AnimationClip(clip.name, clip.duration, tracks));
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      this.shots.set(clip.name, { a, d: clip.duration, on: false });
    }
  }

  /** Pose every clip at room-clock time t (seconds); one-shots at (now − their start). */
  update(t: number, now = Date.now()) {
    for (const { a, d, off } of this.actions) if (!off) a.time = ((t % d) + d) % d;
    for (const [name, s] of this.shots) {
      let e = -1;                                     // the most recent start that is still running wins
      for (const w of this.want) {
        if (w.name !== name) continue;
        const x = (now - w.at) / 1000;
        if (x >= 0 && x <= s.d && (e < 0 || x < e)) e = x;
      }
      if (e >= 0) { if (!s.on) { s.a.play(); s.a.paused = true; s.on = true; } s.a.time = e; }
      else if (s.on) { s.a.stop(); s.on = false; }   // stop() puts the nodes back to their rest pose
    }
    this.mixer.update(0);
    this.syncZeroScale();
  }

  /** Collapsed FX out of the draw list, grown ones back in (only nodes this layer hid itself are ever re-shown).
   *  Cheap (one scale test per managed node); the OBS page calls it again right before drawing. */
  syncZeroScale() {
    if (!this.hideZero) return;
    for (const p of this.pops) {
      if (isZeroScale(p.node.scale)) { if (p.node.visible) { p.node.visible = false; p.hidden = true; } }
      else if (p.hidden && !underHiddenToggle(p.node)) { p.node.visible = true; p.hidden = false; }   // (a toggle that is off keeps it hidden)
    }
  }

  /** An engine takes a node over (the forms engine unfolds the collapsed form parts it shows / hides itself): every
   *  collapsed node this layer manages at or under it leaves the layer, shown again if this layer had hidden it, and the
   *  clips' `.scale` tracks on the node itself are dropped (else the mixer would write the authored collapse back over the
   *  engine's scale every frame). The engine sets the node's scale AFTER this (a stopped track restores its original). */
  release(node: THREE.Object3D) {
    this.released.add(node);
    this.pops = this.pops.filter((p) => {
      let q: THREE.Object3D | null = p.node;
      while (q && q !== node) q = q.parent;
      if (!q) return true;
      if (p.hidden) p.node.visible = true;
      return false;
    });
    const root = this.mixer.getRoot() as THREE.Object3D;
    const onNode = (t: THREE.KeyframeTrack) => {
      const p = THREE.PropertyBinding.parseTrackName(t.name);
      return p.propertyName === 'scale' && !!p.nodeName && THREE.PropertyBinding.findNode(root, p.nodeName) === node;
    };
    for (let i = 0; i < this.actions.length; i++) {
      const { a, d } = this.actions[i], clip = a.getClip();
      if (!clip.tracks.some(onNode)) continue;
      a.stop();
      this.mixer.uncacheAction(clip);
      const keep = clip.tracks.filter((t) => !onNode(t));
      if (!keep.length) { this.actions.splice(i--, 1); continue; }
      const b = this.mixer.clipAction(new THREE.AnimationClip(clip.name, clip.duration, keep));
      b.setLoop(THREE.LoopRepeat, Infinity); b.play(); b.paused = true;
      this.actions[i] = { a: b, d, targets: clipTargets(root, b.getClip()), off: false };
    }
    this.syncHidden();
    if (this.shotClips.length) this.buildShots();
  }

  /** The Room editor moved these room objects (src/scene/roomObjects.ts movedNodes): no clip track drives them any more
   *  (else the mixer would put an animated object back every frame and a saved move would never show). Every other
   *  track keeps playing; a node no longer in the set is animated again. Call it BEFORE placing the nodes: a stopped track
   *  restores the value it found. Cheap when the set is unchanged. */
  freeze(nodes: Iterable<THREE.Object3D>) {
    const next = new Set(nodes);
    if (next.size === this.frozen.size && [...next].every((n) => this.frozen.has(n))) return;
    this.frozen = next;
    const keep = this.keepTrack, root = this.mixer.getRoot() as THREE.Object3D;
    for (const { a } of this.actions) { a.stop(); this.mixer.uncacheAction(a.getClip()); }
    this.actions = [];
    for (const clip of this.originals) {
      const tracks = clip.tracks.filter(keep);
      if (!tracks.length) continue;
      const a = this.mixer.clipAction(tracks.length === clip.tracks.length ? clip : new THREE.AnimationClip(clip.name, clip.duration, tracks));
      a.setLoop(THREE.LoopRepeat, Infinity); a.play(); a.paused = true;
      this.actions.push({ a, d: clip.duration, targets: clipTargets(root, a.getClip()), off: false });
    }
    this.syncHidden();
    if (this.shotClips.length) this.buildShots();
  }
  /** Tests: how many tracks drive `node` now. */
  tracksOn(node: THREE.Object3D): number {
    const root = this.mixer.getRoot() as THREE.Object3D;
    let n = 0;
    for (const { a } of this.actions) for (const t of a.getClip().tracks) { const p = THREE.PropertyBinding.parseTrackName(t.name); if (p.nodeName && THREE.PropertyBinding.findNode(root, p.nodeName) === node) n++; }
    return n;
  }

  /** A/B + tests: false = draw collapsed FX again (the old behaviour), true = hide them (default). */
  setHideZeroScale(on: boolean) {
    this.hideZero = on;
    if (on) this.syncZeroScale();
    else for (const p of this.pops) if (p.hidden) { p.node.visible = true; p.hidden = false; }
  }

  /** Back to the authored rest pose (the GLB's own node transforms / morph weights / visibility). */
  dispose() {
    this.setHideZeroScale(false);
    this.pops = [];
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
    this.actions = [];
    this.shots.clear();
    this.shotClips = [];
    this.want = [];
  }
}

/** The nodes a clip's tracks animate (by the track's node name, as the mixer binds them; null = not found). */
function clipTargets(root: THREE.Object3D, clip: THREE.AnimationClip): (THREE.Object3D | null)[] {
  const out = new Set<THREE.Object3D | null>();
  for (const tr of clip.tracks) {
    let name = '';
    try { name = THREE.PropertyBinding.parseTrackName(tr.name).nodeName ?? ''; } catch { out.add(null); continue; }
    out.add(name ? (THREE.PropertyBinding.findNode(root, name) as THREE.Object3D | null) ?? null : root);
  }
  return [...out];
}
