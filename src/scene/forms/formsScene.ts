// Room forms engine (shared/forms.ts): rooms whose scene.json has `forms` change their set with WHO is at a zone -
// the host desk becomes a booster riser for a small host, a perch podium for a fairy, a wide desk for an ogre, a low
// console for a giant and, when a mech or vehicle takes the host spot, the desk splits and sinks while a docking cradle,
// clamps, a ceiling gantry and a holo desk rise into place (and it all goes back when they leave).
//
// Each frame, per zone: the host's stamp (SceneState.modes.forms, else this page's own derivation) -> formPhase ->
// sampleZone -> node offsets from their rest pose + which form's nodes are shown. Pure functions of (now - at): every
// page (studio preview, OBS, guests' OBS) shows the same frame; a page that loads mid-change lands mid-change.
//   - spots: a form's `spots` replace the zone's spots for whoever sits there (SceneRuntime.spotMaps; the same spot
//     index, so the seat rules, the green room and the Live panel never see a change). A spot can `ride` a node (the
//     chair rising on the booster riser carries the performer). Big performers (bigEntrance.ts) are sent to the form
//     the zone is changing TO at once, so their entrance walks / rises to the right place.
//   - ray tests: moving and hidden form parts leave room.occluders; when a zone settles the runtime's rays, framing
//     caches and seat plans are rebuilt (SceneRuntime.refreshRays).
//   - lights: EMIT_<group> materials of the forms' light groups (taken from the room light engine by SceneRuntime) run
//     the form's programs (rotate / chase / pulse / steady / flash / off); beacons spin, glow halos are drawn as
//     additive sprites (fake bloom that reads on every graphics tier).
//   - cues: steam, sparks, dust, flashes (instanced sprites: src/scene/space/fx.ts) and the light engine's moments.
// Free in rooms without `forms` / `bigEntrance` (attach does nothing).
import * as THREE from 'three';
import { govChannel, pageGovernor, type GovChannel } from '../../../shared/flashGovernor.ts';
import type { SceneRuntime } from '../SceneRuntime.ts';
import type { SceneActor } from '../actor.ts';
import type { CameraPreset, SpotInfo } from '../contract.ts';
import { lookPose } from '../cameraRig.ts';
import type { SeatSurface } from '../sizeSeat.ts';
import { SpaceFx, SPRITE } from '../space/fx.ts';
import { SIZE_CLASSES } from '../../../shared/avatarSize.ts';
import { biggestOccupant, occupantOf, sanitizeOccupantRules, type Occupant } from '../../../shared/occupant.ts';
import {
  FIT_KEYS, INSTANT_AGO, fitFor, fitWeight, formPhase, formsBagOf, parseBigEntrance, parseForms, pickForm, restScaleOf, sampleZone, settledOffset, usesBigEntrance, zoneCues,
  type BigEntranceDef, type CamDef, type Delta, type FormDef, type FormFit, type FormPhase, type FormZoneState, type FormsDef, type FxKind, type LightProgram, type ZoneSample,
} from '../../../shared/forms.ts';
import { KitMaterials, buildKitPiece, type KitSurface } from './kit.ts';

const D2R = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);


interface Rest { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3; vis: boolean; world: THREE.Vector3 }
interface FxShot { kind: FxKind | 'glow'; at: number; pos: THREE.Vector3; size: number; color: THREE.Color; dur: number; seed: number }
/** What the big-entrance mover tells the engine to draw (src/scene/forms/bigEntrance.ts fx()). */
export interface BigFx { kind: FxKind | 'glow'; pos: THREE.Vector3; size: number; k: number; color?: string; seed: number }
export interface BigFxSource { fx(nowS: number): BigFx[]; runwayOn(nowS: number): boolean; /** Re-read the room's nodes (the kit pieces just arrived). */ refresh?(): void }

/** The live engine of a room (the big-entrance mover asks it when a zone will be ready). */
const byRoom = new WeakMap<object, FormsScene>();
export const formsOfRoom = (room: object): FormsScene | null => byRoom.get(room) ?? null;
const byRt = new WeakMap<SceneRuntime, FormsScene>();
/** The big-entrance mover of a room (set by bigEntrance.ts). */
export const bigOfRoom = new WeakMap<object, BigFxSource>();

let hooked = false;
function installHooks(R: typeof SceneRuntime) {
  if (hooked) return;
  hooked = true;
  R.spotMaps.push((rt, key, spot) => byRt.get(rt)?.mapSpot(key, spot) ?? null);
  const prevHop = R.hopHook;
  R.hopHook = (rt, a, want, had) => byRt.get(rt)?.isHop(want, had) ?? prevHop?.(rt, a, want, had) ?? false;
}

const NO_FIT: FormFit = {};
/** Same fit values (per frame in lintFits: no allocation). */
function sameFit(a: FormFit, b: FormFit): boolean {
  for (const k of FIT_KEYS) {
    if (k === 'clampR') {
      const x = a.clampR, y = b.clampR;
      if (x === y) continue;
      if (!x || !y || x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    } else if (a[k] !== b[k]) return false;
  }
  return true;
}

export class FormsScene {
  private rt: SceneRuntime | null = null;
  defs: FormsDef | null = null;
  big: BigEntranceDef | null = null;
  private kitMats: KitMaterials | null = null;
  private kitRoots: THREE.Object3D[] = [];
  private kitSurfaces = new Map<string, KitSurface & { world: THREE.Matrix4 }>();
  private nodes = new Map<string, THREE.Object3D>();
  private rest = new Map<THREE.Object3D, Rest>();
  /** Form parts the GLB ships collapsed (extras.restScale): their authored (collapsed) scale, put back on detach. */
  private unfolded = new Map<THREE.Object3D, THREE.Vector3>();
  /** Spot variants: form id -> base spot index -> the form's spot (stable objects). */
  private spots = new Map<string, Map<number, SpotInfo>>();
  private baseSpots = new Map<number, SpotInfo>();
  private zoneOf = new Map<number, string>();
  /** Per zone: nodes the zone's forms show / hide / move (to restore and to manage visibility). */
  private zoneNodes = new Map<string, { formNodes: Map<string, THREE.Object3D[]>; hide: Map<string, THREE.Object3D[]>; moved: Set<string> }>();
  private local: Record<string, FormZoneState> = {};
  private localLock: Record<string, string> = {};
  private samples = new Map<string, { ph: FormPhase; s: ZoneSample }>();
  private lastActive: Record<string, string> = {};
  private lastCur: Record<string, string> = {};
  private occSig = '';
  private settledSig = '';
  private lastT: Record<string, number> = {};
  private fired = new Set<string>();
  private shots: FxShot[] = [];
  private fx: SpaceFx | null = null;
  private lightMats = new Map<string, THREE.MeshStandardMaterial[]>();
  private spinners: { node: THREE.Object3D; group: string; rest: THREE.Quaternion }[] = [];
  private glows: { node: THREE.Object3D; group: string; size: number }[] = [];
  private savedCams = new Map<string, CameraPreset | null>();
  private camsOn = new Set<string>();
  private addedOcc = new Set<THREE.Mesh>();
  private first = true;
  private attachedAt = 0;
  /** A room without forms / bigEntrance: only the big mover's effects are drawn. */
  private lite = false;
  // (no glTF clips: every form motion is a scene.json tween. A room GLB never carries FORM_* clips - the released beta.9
  //  RoomClips loops every clip in a GLB, so a desk split would loop forever there: SPEC 6.1 C9, rule R0)
  /** Pages without the host's stamps: changes this soon after the room came up are the performers still loading (ms). */
  bootMs = 10_000;
  private errors: string[] = [];
  /** Tests: a manual clock (epoch ms) instead of Date.now(). */
  clock: number | null = null;
  /** Tests / Live panel: occupant overrides by member key (a library stand-in played as a mech ...). */
  force = new Map<string, Partial<Occupant>>();

  now() { return this.clock ?? Date.now(); }
  get active() { return !!this.rt && !!this.defs; }

  attach(rt: SceneRuntime) {
    this.detach();
    const defs = parseForms(rt.info), big = parseBigEntrance(rt.info);
    if (!defs && !big) {
      // every other room: only the big-entrance mover's effects (a mech powering up at its spot) - no zones, no kit
      this.rt = rt; this.lite = true; this.first = true;
      byRoom.set(rt.room, this);
      return;
    }
    this.lite = false;
    this.rt = rt; this.defs = defs; this.big = big; this.first = true; this.attachedAt = this.now();
    byRt.set(rt, this); byRoom.set(rt.room, this);
    installHooks(rt.constructor as typeof SceneRuntime);
    const root = rt.room.root;
    // kit pieces (glTF space, under the room model, so they are room geometry like any authored node)
    const kit = defs?.kit ?? kitOnly(rt.info);
    if (kit.length) {
      this.kitMats = new KitMaterials();
      for (const k of kit) {
        try {
          const b = buildKitPiece(k, this.kitMats);
          if (!b) { this.errors.push(`kit: unknown piece '${k.piece}'`); continue; }
          root.add(b.root);
          this.kitRoots.push(b.root);
          b.root.updateMatrixWorld(true);
          for (const sf of b.surfaces) this.kitSurfaces.set(k.name, { ...sf, world: b.root.matrixWorld.clone() });
          b.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = false; m.receiveShadow = false; } });
        } catch (e) { this.errors.push(`kit ${k.name}: ${String(e)}`); }
      }
    }
    root.updateMatrixWorld(true);
    root.traverse((o) => { if (o.name && !this.nodes.has(o.name)) this.nodes.set(o.name, o); });
    // kit meshes are room geometry: the cameras / seat probes ray-test them (managed below while they move)
    for (const r of this.kitRoots) r.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.visible && !(m.material as THREE.Material).transparent && !rt.room.occluders.includes(m)) { rt.room.occluders.push(m); this.addedOcc.add(m); } });
    this.collectLights(root);
    // (before the rest poses are taken: a collapsed part's children measure their real rest positions)
    if (defs) this.unfold(defs);
    if (defs) this.prepareZones(defs);
    // (the big-entrance mover was made with the room, before the kit's doors / lifts / path markers existed)
    bigOfRoom.get(rt.room)?.refresh?.();
    // (a GLB that still carries FORM_* clips: RoomClips loops them like any clip, here and on beta.9 - say so)
    const acts = (rt.clips as unknown as { actions?: { a: THREE.AnimationAction }[] } | null)?.actions ?? [];
    const loops = acts.map((x) => x.a.getClip().name).filter((n) => /^FORM_/.test(n));
    if (loops.length) this.errors.push(`GLB clips ${loops.join(', ')} loop forever (RoomClips): form motion belongs in scene.json tweens (SPEC 6.1 C9)`);

    if (this.errors.length) console.warn(`[forms] ${rt.info.id}: ${this.errors.join('; ')}`);
    rt.refreshSeats();
  }

  detach() {
    const rt = this.rt;
    if (!rt) return;
    // back to the authored room: rest poses, visibility, cameras, ray tests
    for (const [o, r] of this.rest) { o.position.copy(r.p); o.quaternion.copy(r.q); o.scale.copy(r.s); o.visible = r.vis; }
    for (const [o, s] of this.unfolded) o.scale.copy(s);
    this.unfolded.clear();
    for (const [name, c] of this.savedCams) { if (c) rt.room.cameras.set(name, c); else rt.room.cameras.delete(name); }
    // (kit meshes own their geometry - one per mesh, kit.ts; KitMaterials frees the materials + textures below)
    for (const k of this.kitRoots) { k.removeFromParent(); k.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry?.dispose(); }); }
    const keep = rt.room.occluders.filter((m) => !this.addedOcc.has(m));
    rt.room.occluders.length = 0; rt.room.occluders.push(...keep);
    this.kitMats?.dispose(); this.kitMats = null;
    this.fx?.dispose(); this.fx = null;
    byRt.delete(rt); byRoom.delete(rt.room);
    this.rt = null; this.defs = null; this.big = null; this.lite = false;
    this.kitRoots = []; this.kitSurfaces.clear(); this.nodes.clear(); this.rest.clear(); this.spots.clear(); this.baseSpots.clear(); this.zoneOf.clear(); this.zoneNodes.clear();
    this.local = {}; this.lintedFit = {}; this.samples.clear(); this.lastActive = {}; this.lastCur = {}; this.occSig = ''; this.settledSig = ''; this.lastT = {}; this.fired.clear(); this.shots = [];
    this.lightMats.clear(); this.spinners = []; this.glows = []; this.savedCams.clear(); this.camsOn.clear(); this.addedOcc.clear(); this.errors = [];
  }

  // ---------------------------------------------------------------- setup
  private node(name: string): THREE.Object3D | null { return this.nodes.get(name) ?? null; }
  /** Node names starting with a prefix, sorted (each-tweens, petals, clamps ...). */
  private expandCache = new Map<string, string[]>();
  private expand = (prefix: string): string[] => {
    let v = this.expandCache.get(prefix);
    if (!v) { v = [...this.nodes.keys()].filter((k) => k.startsWith(prefix) && k !== prefix && !k.slice(prefix.length).includes('_')).sort(); if (!v.length && this.nodes.has(prefix)) v = [prefix]; this.expandCache.set(prefix, v); }
    return v;
  };
  /** Form parts a room GLB ships COLLAPSED (scale ~1e-4 + extras.restScale: shared/forms.ts restScaleOf - an engine
   *  without forms shows the default set) get their real scale back: the forms engine shows / hides them with their
   *  form. Without it the perch podium, booster riser, wide desk, guest pad ... stayed points while their form was up,
   *  and the performer on a spot riding one stood on nothing. The room clips layer lets go of them (it hides collapsed
   *  meshes, roomClips.ts). Only a form's own `nodes` (their visibility is the form's): anything else stays as authored. */
  private unfold(defs: FormsDef) {
    for (const f of Object.values(defs.list)) for (const n of f.nodes) {
      const o = this.node(n);
      if (!o || this.unfolded.has(o) || this.rest.has(o)) continue;
      const rs = restScaleOf(o.userData, [o.scale.x, o.scale.y, o.scale.z]);
      if (!rs) continue;
      this.unfolded.set(o, o.scale.clone());
      // (the clips layer lets go first: it drops a .scale track on the node, and a stopped track puts its original back)
      this.rt?.clips?.release(o);
      o.scale.set(rs[0], rs[1], rs[2]);
    }
    if (this.unfolded.size) this.rt?.room.root.updateMatrixWorld(true);
  }
  /** Debug (vtpOut.forms.debug): the collapsed form parts this room unfolded. */
  get unfoldedNodes(): string[] { return [...this.unfolded.keys()].map((o) => o.name); }
  private keepRest(o: THREE.Object3D) {
    if (this.rest.has(o)) return;
    o.updateWorldMatrix(true, false);
    this.rest.set(o, { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone(), vis: o.visible, world: o.getWorldPosition(new THREE.Vector3()) });
  }
  /** `radial` offsets (docking clamps out to the feet): a node's rest direction / distance from its parent's centre. */
  private radial = (name: string): { dir: [number, number, number]; r: number } | null => {
    const o = this.node(name), r = o ? this.rest.get(o) : null;
    if (!o || !r) return null;
    const d = Math.hypot(r.p.x, r.p.z);
    return d > 1e-3 ? { dir: [r.p.x / d, 0, r.p.z / d], r: d } : null;
  };
  /** `auto: 'rise'`: from below the floor by the node's own height (+5 cm). */
  private riseCache = new Map<string, Delta>();
  private rise = (name: string): Delta => {
    let d = this.riseCache.get(name);
    if (!d) {
      const o = this.node(name);
      let h = 1;
      if (o) { const r = this.rest.get(o); const b = new THREE.Box3().setFromObject(o, true); if (!b.isEmpty()) h = Math.max(0.1, b.max.y - (r ? r.world.y : b.min.y) + 0.05); }
      d = { p: [0, -h, 0], r: [0, 0, 0], s: [1, 1, 1] };
      this.riseCache.set(name, d);
    }
    return d;
  };

  private prepareZones(defs: FormsDef) {
    const rt = this.rt!;
    const spotByName = (n: string) => rt.room.spots.find((s) => s?.name === n) ?? null;
    for (const z of Object.values(defs.zones)) {
      const formNodes = new Map<string, THREE.Object3D[]>(), hide = new Map<string, THREE.Object3D[]>(), moved = new Set<string>();
      for (const id of z.order) {
        const f = defs.list[id];
        if (!f) continue;
        const list = f.nodes.map((n) => this.node(n)).filter((o): o is THREE.Object3D => { if (!o) return false; return true; });
        for (const n of f.nodes) if (!this.node(n)) this.errors.push(`${id}: no node '${n}'`);
        formNodes.set(id, list);
        hide.set(id, f.hide.map((n) => this.node(n)).filter((o): o is THREE.Object3D => !!o));
        for (const a of [f.in, f.out, ...Object.values(f.outTo)]) for (const tw of a?.tweens ?? []) for (const n of tw.each ? this.expand(tw.node) : [tw.node]) moved.add(n);
        for (const sp of Object.values(f.spots)) if (sp.ride) moved.add(sp.ride);
        if (f.holoDesk) moved.add(f.holoDesk.node);
        if (f.scaleTo) moved.add(f.scaleTo.node);
      }
      for (const n of moved) { const o = this.node(n); if (o) this.keepRest(o); else this.errors.push(`zone ${z.id}: no node '${n}'`); }
      for (const l of [...formNodes.values(), ...hide.values()]) for (const o of l) this.keepRest(o);
      this.zoneNodes.set(z.id, { formNodes, hide, moved });
      // the zone's spots take every size class: the forms shape the set for whoever sits there
      for (const sn of z.spots) {
        const base = spotByName(sn);
        if (!base) { this.errors.push(`zone ${z.id}: no spot ${sn}`); continue; }
        this.zoneOf.set(base.index, z.id);
        this.baseSpots.set(base.index, base);
        if (!base.sizes) base.sizes = [...SIZE_CLASSES];
        for (const id of z.order) {
          const f = defs.list[id], fs = f?.spots[sn];
          const camDef = fs?.cam ?? f?.cams[`${sn}_CAM`];
          if (!f || (!fs && !camDef)) continue;
          let m = this.spots.get(id);
          if (!m) { m = new Map(); this.spots.set(id, m); }
          m.set(base.index, this.formSpot(base, fs ?? {}, camDef, f));
          if (fs) this.lintCarrier(base, fs, f, sn);
        }
      }
    }
  }

  /** A form spot that gives `pos` AND rides a carrier the form moves: the engine puts it at pos + the carrier's move
   *  (docs/SCENES.md "Room forms": pos is at the carrier's REST pose). When pos is already where the move ends - the base
   *  spot + the move, or the carrier's own settled place (not its rest) - the move counts twice: a booster chair's sitter
   *  floats the riser's height above the seat, a bench slid back leaves its sitter behind it, a cradle authored at its
   *  risen height floats by fit.wellY. Moves that come from the zone's fit (`fit.*` end poses) are only known once the
   *  zone has an occupant: `fit` (the zone's fit) resolves them - checked again whenever the zone's fit changes
   *  (lintFits). Returns the warning, or null. */
  lintCarrier(base: SpotInfo, fs: FormDef['spots'][string], f: FormDef, sn: string, fit?: FormFit): string | null {
    const o = fs.ride && fs.pos ? this.node(fs.ride) : null;
    if (!o || !fs.pos) return null;
    const off = settledOffset(f, fs.ride!, fit ? { fit } : undefined);
    if (Math.hypot(off[0], off[1], off[2]) < 0.03) return null;
    const par = o.parent ?? this.rt!.room.root;
    par.updateWorldMatrix(true, false);
    const r = this.rest.get(o)?.p ?? o.position;
    const restW = par.localToWorld(r.clone());
    const moved = par.localToWorld(r.clone().add(new THREE.Vector3(...off))).sub(restW);
    const pos = this.w(fs.pos);
    const atEnd = pos.distanceTo(base.position.clone().add(moved)) < 0.03 || (pos.distanceTo(restW.clone().add(moved)) < 0.03 && pos.distanceTo(restW) >= 0.03);
    if (!atEnd) return null;
    const msg = `${f.id} ${sn}: pos is where the spot ends up, and the carrier ${fs.ride} moves it ${moved.length().toFixed(2)} m again${fit ? ' (with this occupant\'s fit)' : ''} (give pos at the carrier's rest pose, or leave it out)`;
    if (!this.errors.includes(msg)) this.errors.push(msg);
    return msg;
  }
  /** lintCarrier for the forms of a zone whose fit changed (fit.* carrier moves: the dock's fit.wellY ...). */
  private lintedFit: Record<string, FormFit> = {};
  private lintFits(zone: string, fit: FormFit | undefined) {
    const had = this.lintedFit[zone];
    if ((had && sameFit(had, fit ?? NO_FIT)) || !this.defs || !this.rt) return;
    this.lintedFit[zone] = fit ? { ...fit, clampR: fit.clampR?.slice() } : NO_FIT;
    if (!fit) return;
    const z = this.defs.zones[zone];
    for (const id of z?.order ?? []) {
      const f = this.defs.list[id];
      for (const [sn, fs] of Object.entries(f?.spots ?? {})) {
        const base = this.rt.room.spots.find((q) => q?.name === sn);
        if (!f || !base || !fs.pos || !fs.ride) continue;
        const before = this.errors.length;
        const msg = this.lintCarrier(base, fs, f, sn, fit);
        if (msg && this.errors.length > before) console.warn(`[forms] ${this.rt.info.id}: ${msg}`);
      }
    }
  }

  private w(v: [number, number, number]) { return this.rt!.room.root.localToWorld(new THREE.Vector3(v[0], v[1], v[2])); }
  private cam(name: string, c: CamDef): CameraPreset {
    const p = lookPose(this.w(c.pos), this.w(c.target), c.fov);
    return { name, position: p.position, quaternion: p.quaternion, fov: p.fov };
  }
  private formSpot(base: SpotInfo, fs: FormDef['spots'][string], camDef: CamDef | undefined, f: FormDef): SpotInfo {
    const yaw = fs.yaw !== undefined ? fs.yaw * D2R : base.yaw;
    const pose = fs.pose ?? base.pose;
    const position = fs.pos ? this.w(fs.pos) : base.position.clone();
    const s: SpotInfo = {
      ...base,
      position, yaw, forward: new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), pose,
      seatHeight: pose === 'sit' ? fs.seatHeight ?? base.seatHeight : 0,
      label: fs.label ?? `${base.label} (${f.label})`,
      sizes: fs.sizes ? [...fs.sizes] : [...SIZE_CLASSES],
      ...(fs.kinds ? { kinds: [...fs.kinds] } : {}),
      cam: camDef ? this.cam(`${base.name}_CAM`, camDef) : base.cam,
      approach: fs.approach ? fs.approach.map((p) => this.w(p)) : base.approach.filter((q) => q.distanceTo(position) < 3),
      extras: { ...base.extras, form: f.id },
      ...(fs.clearance ? { clearance: { ...fs.clearance } } : { clearance: undefined }),
    };
    (s as SpotInfo & { formRest?: THREE.Vector3; formRide?: string }).formRest = position.clone();
    if (fs.ride) (s as SpotInfo & { formRide?: string }).formRide = fs.ride;
    return s;
  }

  private collectLights(root: THREE.Object3D) {
    const groups = new Set([...(this.defs?.lightGroups ?? []), ...(this.big?.runway ? [this.big.runway] : [])]);
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) for (const mt of (Array.isArray(m.material) ? m.material : [m.material])) {
        const g = /^EMIT_(.+)$/.exec(mt?.name ?? '')?.[1]?.replace(/[._]\d+$/, '');
        const sm = mt as THREE.MeshStandardMaterial;
        if (!g || !groups.has(g) || !sm.isMeshStandardMaterial) continue;
        const list = this.lightMats.get(g) ?? [];
        if (!list.includes(sm)) { list.push(sm); sm.userData.formBase ??= sm.emissiveIntensity || 1; sm.userData.formColor ??= sm.emissive.clone(); sm.userData.formOrder = list.length; }
        this.lightMats.set(g, list);
      }
      const spin = o.userData.formSpin;
      if (typeof spin === 'string' && groups.has(spin)) this.spinners.push({ node: o, group: spin, rest: o.quaternion.clone() });
      const gl = o.userData.formGlow as { group?: string; size?: number } | undefined;
      if (gl && typeof gl.group === 'string' && groups.has(gl.group)) this.glows.push({ node: o, group: gl.group, size: gl.size ?? 0.4 });
    });
    // runway chevrons: chase order = the order their nodes come in the room (kit names _CHEV_01 ...)
    for (const list of this.lightMats.values()) list.sort((a, b) => (a.userData.formOrder as number) - (b.userData.formOrder as number));
  }

  // ---------------------------------------------------------------- state
  /** The zone states this page plays: the host's stamps, else this page's own derivation. */
  zoneState(zone: string): FormZoneState | undefined {
    const rt = this.rt, defs = this.defs;
    if (!rt || !defs) return undefined;
    const bag = formsBagOf(rt.state.modes, rt.info.id);
    if (bag?.zones[zone] && !this.localLock[zone]) return bag.zones[zone];
    return this.deriveLocal(zone);
  }
  /** Occupant of an actor (profile + measured height; test overrides). */
  occupantOf(a: SceneActor): Occupant | null {
    if (!a.runtime) return null;
    const rt = this.rt!;
    const base = (rt.info.avatarHeight ?? 1.5) * (rt.state.avatarScale || 1);
    const o = occupantOf(a.runtime.profile, this.defs?.rules ?? this.bigRules, a.rest?.height, base);
    const f = this.force.get(a.key);
    return f ? { ...o, ...f } : o;
  }
  /** Who is at each zone now (present, seated or walking to a zone spot). */
  occupants(zone: string): { a: SceneActor; occ: Occupant }[] {
    const rt = this.rt!, out: { a: SceneActor; occ: Occupant }[] = [];
    for (const [key, a] of rt.actors) {
      const s = rt.seatOf(key);
      if (!s || this.zoneOf.get(s.index) !== zone || rt.state.present[key] === false) continue;
      const occ = this.occupantOf(a);
      if (occ) out.push({ a, occ });
    }
    return out;
  }
  private deriveLocal(zone: string): FormZoneState {
    const defs = this.defs!, rt = this.rt!, now = this.now();
    const occ = this.occupants(zone);
    const target = pickForm(defs, zone, occ.map((o) => o.occ), this.localLock[zone]);
    const cur0 = this.local[zone];
    // the zone's fit to its biggest occupant (SPEC 2.5), as the host would stamp it
    // (a zone without spots - the call-in screen pylon - fits to the host zone's occupant)
    const fitOcc = defs.zones[zone]?.spots.length ? occ : this.occupants(defs.zones.host ? 'host' : Object.keys(defs.zones)[0]);
    const big = biggestOccupant(fitOcc.map((o) => o.occ));
    const fit = big ? fitFor({ shown: big.shown, kind: big.kind, cls: big.cls, pilotEye: big.pilotEye, contactR: big.contactR }) : {};
    const cur = cur0 && JSON.stringify(cur0.fit ?? {}) !== JSON.stringify(fit) ? (this.local[zone] = { ...cur0, fit }) : cur0;
    if (!cur) return (this.local[zone] = { id: target, from: target, at: now - INSTANT_AGO, fit });
    if (cur.id === target) return cur;
    // a walk-in to the zone starts the change with it; while the page is still loading its performers (the first
    // seconds after the room came up) the zone just IS its form; else now
    const idx = new Set([...this.zoneOf].filter(([, z]) => z === zone).map(([i]) => i));
    let at = now - this.attachedAt < this.bootMs ? now - INSTANT_AGO : now;
    const arrivals = occ.map((o) => rt.state.moves?.[o.a.key]).filter((mv): mv is NonNullable<typeof mv> => !!mv && idx.has(mv.to) && !idx.has(mv.from) && mv.at >= now - 2500);
    if (arrivals.length) at = Math.min(...arrivals.map((mv) => mv.at));
    return (this.local[zone] = { id: target, from: cur.id, at, fit });
  }
  /** Occupant rules of a room without zones (big entrance only). */
  private get bigRules() { return sanitizeOccupantRules((this.rt?.info as unknown as { occupants?: unknown } | undefined)?.occupants); }
  /** SPEC 6.1 C7: the call-in screen's fitted centre height above the floor (fit.monY: the host's eye line + 0.45 m) while
   *  a form that lists `monY` is up, `k` = how far that form is in (0..1, eased like its fit bindings), `target` = the
   *  form the zone is changing to lists it (the shot book fits the screen where it is going). null = no form fits the
   *  call-in screen (the interview engine leaves it where the set placed it). Read by InterviewScene.setMonitorLift. */
  monitorFit(): { monY: number; k: number; target: boolean } | null {
    const defs = this.defs;
    if (!this.rt || !defs) return null;
    for (const z of Object.values(defs.zones)) {
      const st = this.zoneState(z.id), monY = st?.fit?.monY;
      if (typeof monY !== 'number' || !Number.isFinite(monY)) continue;
      const ph = formPhase(defs, z.id, st, this.now());
      const target = !!defs.list[ph.cur]?.fit.includes('monY');
      const k = fitWeight(defs, ph, 'monY');
      if (k > 0 || target) return { monY, k, target };
    }
    return null;
  }
  /** Tests / Live panel: force a zone's form on this page (null = automatic). */
  lock(zone: string, id: string | null, at = this.now()) {
    if (!this.defs?.zones[zone]) return;
    const cur = this.zoneState(zone);
    if (id && this.defs.list[id]?.zone === zone) this.localLock[zone] = id; else delete this.localLock[zone];
    const target = id ?? pickForm(this.defs, zone, this.occupants(zone).map((o) => o.occ));
    if (cur?.id !== target) this.local[zone] = { id: target, from: cur?.id ?? target, at };
  }
  phase(zone: string): FormPhase | null { return this.defs ? formPhase(this.defs, zone, this.zoneState(zone), this.now()) : null; }
  /** Epoch ms when the zone of a spot is settled in the form it is changing to (0 = no zone / no change). */
  readyAt(spotIndex: number): number {
    const z = this.zoneOf.get(spotIndex);
    const ph = z ? this.phase(z) : null;
    return ph && ph.prev !== ph.cur ? ph.readyAt : 0;
  }
  zoneForSpot(index: number): string | null { return this.zoneOf.get(index) ?? null; }
  /** The host's big-entrance style choice (forms bag `entrance`; null = the room's). */
  bagEntrance(): string | null { const rt = this.rt; return rt ? formsBagOf(rt.state.modes, rt.info.id)?.entrance ?? null : null; }
  /** The stage mode shown now (the big entrance never takes the camera in React / Gaming). */
  mode(): string { return this.rt?.state.mode ?? 'talk'; }

  // ---------------------------------------------------------------- spots (SceneRuntime.spotMaps / hopHook)
  /** The spot a member gets at a zone spot: the active form's variant (big performers: the form it changes to). */
  mapSpot(key: string, spot: SpotInfo): SpotInfo | null {
    const zone = this.zoneOf.get(spot.index);
    if (!zone || !this.defs) return null;
    const a = this.rt?.actors.get(key);
    const ph = this.phase(zone);
    if (!ph) return null;
    const big = !!a && !!this.big && (() => { const o = this.occupantOf(a); return !!o && usesBigEntrance(this.big, o); })();
    const form = big ? ph.cur : ph.k === 'in' || ph.k === 'settled' ? ph.cur : ph.prev;
    return this.spots.get(form)?.get(spot.index) ?? this.baseSpots.get(spot.index) ?? null;
  }
  /** A move between two variants of the same zone spot: re-placed in place (no walk). */
  isHop(want: SpotInfo, had: SpotInfo): boolean { return want.index === had.index && want !== had && this.zoneOf.has(want.index); }

  // ---------------------------------------------------------------- per frame (after scene.update)
  update(dt: number) {
    const rt = this.rt;
    if (!rt) return;
    const now = this.now();
    void dt;
    let reseat = false, refresh = false;
    if (this.defs) {
      for (const z of Object.values(this.defs.zones)) {
        const st = this.zoneState(z.id);
        const ph = formPhase(this.defs, z.id, st, now);
        const s = sampleZone(this.defs, ph, this.expand, this.rise, { fit: st?.fit, radial: this.radial });
        this.samples.set(z.id, { ph, s });
        if (this.lastActive[z.id] !== s.active || this.lastCur[z.id] !== ph.cur) { this.lastActive[z.id] = s.active; this.lastCur[z.id] = ph.cur; reseat = true; }
        this.cues(z.id, ph, now);
        this.lintFits(z.id, st?.fit);
      }
      for (const { ph, s } of this.samples.values()) this.applyZone(ph.zone, ph, s);
      this.applyCams();
      const set = [...this.samples.values()];
      const settled = set.every((x) => x.s.settled);
      const sig = set.map((x) => `${x.ph.zone}:${x.s.active}`).join('|');
      this.manageOccluders(set.map((x) => x.s));
      if (settled && sig !== this.settledSig) { this.settledSig = sig; refresh = true; }
      this.rideSpots();
    }
    if (refresh) { rt.refreshRays(); rt.setSeatSurfaces(this.surfaces()); }
    if ((reseat || this.first) && !this.lite) rt.refreshSeats();
    this.lights(now);
    this.drawFx(now);
    this.first = false;
  }

  private applyZone(zone: string, ph: FormPhase, s: ZoneSample) {
    const zn = this.zoneNodes.get(zone);
    if (!zn) return;
    // offsets: every node any form of this zone moves (rest when nothing touches it now)
    const q = new THREE.Quaternion(), e = new THREE.Euler();
    for (const n of zn.moved) {
      const o = this.node(n), r = o ? this.rest.get(o) : null;
      if (!o || !r) continue;
      const d = s.deltas.get(n);
      if (!d) { o.position.copy(r.p); o.quaternion.copy(r.q); o.scale.copy(r.s); continue; }
      o.position.set(r.p.x + d.p[0], r.p.y + d.p[1], r.p.z + d.p[2]);
      o.quaternion.copy(r.q).multiply(q.setFromEuler(e.set(d.r[0] * D2R, d.r[1] * D2R, d.r[2] * D2R)));
      o.scale.set(r.s.x * d.s[0], r.s.y * d.s[1], r.s.z * d.s[2]);
    }
    // visibility: a form's nodes while it is shown; its hide-list hidden while it is shown
    const vis = new Map<THREE.Object3D, boolean>();
    for (const [id, list] of zn.formNodes) for (const o of list) vis.set(o, (vis.get(o) ?? false) || s.shown.includes(id));
    for (const [o, v] of vis) o.visible = v && (this.rest.get(o)?.vis ?? true);
    for (const [id, list] of zn.hide) for (const o of list) if (!vis.has(o)) o.visible = !s.shown.includes(id) && (this.rest.get(o)?.vis ?? true);
    // the active form's extras: holo desk at the pilot's face, a node scaled with the occupant
    const f = this.defs!.list[s.active];
    if (f?.holoDesk || f?.scaleTo) {
      const occ = this.occupants(zone).sort((a, b) => b.a.height - a.a.height)[0];
      if (f.holoDesk) this.placeHolo(f, occ?.a ?? null);
      if (f.scaleTo && occ) {
        const o = this.node(f.scaleTo.node), r = o ? this.rest.get(o) : null;
        const k = THREE.MathUtils.clamp(occ.a.height / f.scaleTo.ref, f.scaleTo.min, f.scaleTo.max);
        if (o && r) o.scale.multiplyScalar(k);
      }
    }
    void ph;
  }

  private placeHolo(f: FormDef, a: SceneActor | null) {
    const o = this.node(f.holoDesk!.node), r = o ? this.rest.get(o) : null;
    if (!o || !r || !o.parent) return;
    if (!a?.spot) { o.visible = false; return; }
    // (only once the pilot is in place: never a plate floating over an empty cradle or a rising lift)
    if (!a.shown || this.rt!.mover.busy(a)) { o.visible = false; return; }
    const face = a.faceAt(a.spot);
    if (!face) return;
    const fwd = a.spot.forward;
    // (below / ahead are in head units: a human head is about 0.24 m; a mech's cockpit pilot or a big robot's head scales it)
    const k = THREE.MathUtils.clamp(face.size / 0.24, 0.5, 3);
    const wpos = face.center.clone().addScaledVector(fwd, f.holoDesk!.ahead * k).add(new THREE.Vector3(0, -f.holoDesk!.below * k, 0));
    // (the rise offset of its in-animation still applies on top: delta = current - rest)
    const delta = o.position.clone().sub(r.p);
    o.parent.updateWorldMatrix(true, false);
    o.position.copy(o.parent.worldToLocal(wpos)).add(delta);
    o.rotation.set(0, a.spot.yaw, 0);
  }

  /** Spots that ride a node: follow its animated offset from rest (world). */
  private rideSpots() {
    for (const m of this.spots.values()) for (const s of m.values()) {
      const x = s as SpotInfo & { formRest?: THREE.Vector3; formRide?: string };
      if (!x.formRide || !x.formRest) continue;
      const o = this.node(x.formRide), r = o ? this.rest.get(o) : null;
      if (!o || !r) continue;
      o.updateWorldMatrix(true, false);
      const now = o.getWorldPosition(new THREE.Vector3());
      s.position.copy(x.formRest).add(now.sub(r.world));
    }
  }

  /** Form cameras (CAM_*) while their form is active; the room's own preset comes back after. */
  private applyCams() {
    const rt = this.rt!, want = new Map<string, CamDef>();
    for (const { s } of this.samples.values()) { const f = this.defs!.list[s.active]; for (const [n, c] of Object.entries(f?.cams ?? {})) if (n.startsWith('CAM_')) want.set(n, c); }
    const key = [...want.keys()].sort().join(',');
    if (key === [...this.camsOn].sort().join(',')) return;
    for (const n of this.camsOn) if (!want.has(n)) { const c = this.savedCams.get(n); if (c) rt.room.cameras.set(n, c); else rt.room.cameras.delete(n); }
    for (const [n, c] of want) { if (!this.savedCams.has(n)) this.savedCams.set(n, rt.room.cameras.get(n) ?? null); rt.room.cameras.set(n, this.cam(n, c)); }
    this.camsOn = new Set(want.keys());
  }

  /** Hidden or moving form parts leave the ray tests; they come back once still and shown. */
  private manageOccluders(samples: ZoneSample[]) {
    const rt = this.rt!;
    const moving = new Set<string>(); for (const s of samples) for (const n of s.moving) moving.add(n);
    const sig = [...moving].sort().join(',') + '|' + samples.map((s) => s.shown.join('+')).join('/');
    if (sig === this.occSig) return;
    this.occSig = sig;
    const off = new Set<THREE.Object3D>();
    for (const n of moving) { const o = this.node(n); if (o) o.traverse((c) => off.add(c)); }
    const managed = new Set<THREE.Mesh>();
    for (const zn of this.zoneNodes.values()) {
      for (const list of [...zn.formNodes.values(), ...zn.hide.values()]) for (const o of list) o.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh) managed.add(m); });
      for (const n of zn.moved) this.node(n)?.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh) managed.add(m); });
    }
    const shownFully = (m: THREE.Object3D) => { for (let p: THREE.Object3D | null = m; p; p = p.parent) if (!p.visible) return false; return true; };
    const keep = rt.room.occluders.filter((m) => !managed.has(m));
    for (const m of managed) if (shownFully(m) && !off.has(m) && !(m.material as THREE.Material).transparent) keep.push(m);
    rt.room.occluders.length = 0; rt.room.occluders.push(...keep);
  }

  /** Desk tops of the active forms (kit desks + authored seatSurfaces), world space. */
  private surfaces(): SeatSurface[] {
    const out: SeatSurface[] = [];
    for (const { s } of this.samples.values()) {
      const f = this.defs!.list[s.active];
      if (!f) continue;
      for (const n of f.nodes) {
        const k = this.kitSurfaces.get(n);
        if (!k) continue;
        const c = k.center.clone().applyMatrix4(k.world);
        const top = new THREE.Vector3(0, k.top, 0).applyMatrix4(k.world).y;
        const yaw = Math.atan2(new THREE.Vector3(1, 0, 0).transformDirection(k.world).z * -1, new THREE.Vector3(1, 0, 0).transformDirection(k.world).x);
        out.push({ center: c, yaw, halfW: k.halfW, halfD: k.halfD, top });
      }
      for (const sd of f.seatSurfaces) {
        const o = sd.node ? this.node(sd.node) : null;
        const c = o ? o.getWorldPosition(new THREE.Vector3()) : sd.at ? this.w(sd.at) : null;
        if (!c) continue;
        out.push({ center: c, yaw: (sd.yaw ?? 0) * D2R, halfW: sd.halfW, halfD: sd.halfD, top: sd.top ?? c.y });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- cues, lights, effects
  private cues(zone: string, ph: FormPhase, now: number) {
    const last = this.lastT[zone] ?? -Infinity;
    this.lastT[zone] = ph.t;
    if (this.first || ph.prev === ph.cur) return;
    for (const c of zoneCues(this.defs!, ph)) {
      // (a page that joins late skips cues older than 1.5 s; continuous looks are pure functions of the phase)
      if (!(c.at > last && c.at <= ph.t && ph.t - c.at < 1.5)) continue;
      const id = `${zone}|${ph.cur}|${ph.prev}|${Math.round(now - ph.t * 1000)}|${c.form}|${c.which}|${c.at}`;
      if (this.fired.has(id)) continue;
      this.fired.add(id);
      if (this.fired.size > 200) this.fired = new Set([...this.fired].slice(-100));
      this.fireCue(zone, c.cue, now - (ph.t - c.at) * 1000);
    }
  }
  private fireCue(zone: string, cue: NonNullable<ReturnType<typeof zoneCues>[number]>['cue'], at: number) {
    const rt = this.rt!;
    const lights = rt.lights as unknown as { moment?: (k: string, s?: number) => void; cue?: (w: string) => void };
    try { if (cue.light) lights.moment?.(cue.light, cue.secs ?? 8); if (cue.cue) lights.cue?.(cue.cue); } catch { /* optional hooks */ }
    if (!cue.fx) return;
    const z = this.defs!.zones[zone];
    const base = z ? this.baseSpots.get([...this.zoneOf].find(([, id]) => id === zone)?.[0] ?? -1) : null;
    const pos = cue.anchor && this.node(cue.anchor) ? this.node(cue.anchor)!.getWorldPosition(new THREE.Vector3()) : cue.pos ? this.w(cue.pos) : base?.position.clone() ?? new THREE.Vector3();
    const color = new THREE.Color(cue.color ?? (cue.fx === 'sparks' ? '#ffcf6a' : cue.fx === 'flash' ? '#fff4dc' : cue.fx === 'beam' ? '#9fe8ff' : '#cfd6e6'));
    const dur = cue.fx === 'steam' ? 3.2 : cue.fx === 'dust' ? 2.4 : cue.fx === 'sparks' ? 1.2 : cue.fx === 'beam' ? 2.5 : 0.6;
    this.shots.push({ kind: cue.fx, at, pos, size: cue.size ?? 1, color, dur, seed: (this.shots.length * 0.618) % 1 });
    if (this.shots.length > 40) this.shots.splice(0, this.shots.length - 40);
  }

  /** Light programs of the active forms (+ the runway chase while a big walker comes in). */
  private lights(now: number) {
    const t = now / 1000;
    const prog = new Map<string, LightProgram>();
    for (const { s, ph } of this.samples.values()) {
      const f = this.defs?.list[s.active];
      for (const [g, p] of Object.entries(f?.lightGroups ?? {})) if (!prog.has(g)) prog.set(g, p);
      // a zone changing: its beacons spin up even before the new form is up
      if (ph.k === 'out' || ph.k === 'in') for (const [g, p] of Object.entries(this.defs?.list[ph.cur]?.lightGroups ?? {})) if (!prog.has(g) && p.program === 'rotate') prog.set(g, p);
    }
    const big = this.rt ? bigOfRoom.get(this.rt.room) : undefined;
    if (this.big?.runway && big?.runwayOn(t)) prog.set(this.big.runway, { program: 'chase', speed: 1.4, intensity: 1.6, color: '#ffd25a' });
    for (const [g, mats] of this.lightMats) {
      const p = prog.get(g) ?? { program: 'off', speed: 1, intensity: 1 } as LightProgram;
      const col = p.color ? new THREE.Color(p.color) : null;
      mats.forEach((m, i) => {
        const base = (m.userData.formBase as number) ?? 1;
        let k = 0;
        switch (p.program) {
          case 'steady': k = 1; break;
          case 'pulse': k = 0.55 + 0.45 * Math.sin(t * Math.PI * 2 * 0.8 * p.speed); break;
          case 'flash': k = Math.sin(t * Math.PI * 2 * 2.5 * p.speed) > 0.2 ? 1 : 0.08; break;
          case 'rotate': k = 0.65 + 0.35 * Math.max(0, Math.sin(t * Math.PI * 2 * 1.1 * p.speed)); break;
          case 'chase': { const n = mats.length, ph = ((t * 6 * p.speed) % n + n) % n; const d = (ph - i + n) % n; k = 0.12 + 0.88 * Math.max(0, 1 - d / 2.2); break; }
          default: k = 0;
        }
        // (photosensitivity: 'flash' / 'chase' at speed > 1.2 run past 3 a second: each material steps the page's governor)
        m.emissiveIntensity = base * p.intensity * pageGovernor(performance.timeOrigin + performance.now()).step((m.userData.gch ??= govChannel('form light')) as GovChannel, k);
        m.emissive.copy(col ?? (m.userData.formColor as THREE.Color) ?? m.emissive);
      });
    }
    for (const sp of this.spinners) {
      const p = prog.get(sp.group);
      if (p && p.program === 'rotate') sp.node.quaternion.copy(sp.rest).multiply(new THREE.Quaternion().setFromAxisAngle(UP, (t * Math.PI * 2 * 0.9 * p.speed) % (Math.PI * 2)));
      sp.node.visible = !!p && p.program !== 'off';
    }
    this.glowProg = prog;
  }
  private glowProg = new Map<string, LightProgram>();

  /** The effects pool, made on first use (rooms whose engines never draw an effect pay nothing). */
  private fxPool(): SpaceFx {
    if (!this.fx) { this.fx = new SpaceFx({ sprites: 700, smoke: 260, streaks: 260 }, false); this.rt!.root.add(this.fx.group); }
    return this.fx;
  }
  private drawFx(now: number) {
    const rt = this.rt!;
    const big = bigOfRoom.get(rt.room);
    const bigFx = big ? big.fx(now / 1000) : [];
    const any = bigFx.length || this.shots.length || this.glows.some((g) => { const p = this.glowProg.get(g.group); return !!p && p.program !== 'off'; });
    if (!any && !this.fx) return;
    const fx = this.fxPool();
    const cam = rt.stage.camera;
    const h = rt.stage.renderer.domElement.height || 720;
    fx.uniforms.uPx.value = (2 * Math.tan((cam.fov * D2R) / 2)) / h;
    fx.uniforms.uMinPx.value = 1.2;
    fx.uniforms.uK.value = 1;
    const t = now / 1000;
    fx.begin(t);
    const v = new THREE.Vector3();
    // glow halos on lit beacons / work lights (fake bloom: Low / Medium have no post effects)
    for (const g of this.glows) {
      const p = this.glowProg.get(g.group);
      if (!p || p.program === 'off') continue;
      let vis = true; for (let o: THREE.Object3D | null = g.node; o; o = o.parent) if (!o.visible) { vis = false; break; }
      if (!vis) continue;
      g.node.getWorldPosition(v);
      const m = this.lightMats.get(g.group)?.[0];
      const c = p.color ? new THREE.Color(p.color) : (m?.userData.formColor as THREE.Color | undefined) ?? new THREE.Color('#ffab2e');
      const k = p.program === 'rotate' ? 0.5 + 0.5 * Math.max(0, Math.sin(t * Math.PI * 2 * 0.9 * p.speed * 2)) : p.program === 'pulse' ? 0.6 + 0.4 * Math.sin(t * Math.PI * 1.6 * p.speed) : 0.8;
      fx.sprite(v, g.size, c.r, c.g, c.b, 0.55 * k, SPRITE.glow, 0);
    }
    // cue effects (pure functions of their age)
    this.shots = this.shots.filter((s) => now - s.at < s.dur * 1000 + 200);
    for (const s of this.shots) this.drawShot(fx, s.kind, s.pos, s.size, (now - s.at) / 1000 / s.dur, s.color, s.seed);
    // the big entrance's thrusters / steam / dust
    for (const b of bigFx) this.drawShot(fx, b.kind, b.pos, b.size, b.k, new THREE.Color(b.color ?? (b.kind === 'thrust' ? '#ffb070' : b.kind === 'sparks' ? '#ffcf6a' : '#cfd6e6')), b.seed);
    fx.end();
  }

  /** One effect at age k (0..1). */
  private drawShot(fx: SpaceFx, kind: FxKind | 'glow', pos: THREE.Vector3, size: number, k: number, c: THREE.Color, seed: number) {
    if (k < 0 || k > 1) return;
    const v = new THREE.Vector3();
    const rnd = (i: number) => { const x = Math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453; return x - Math.floor(x); };
    switch (kind) {
      case 'steam': for (let i = 0; i < 14; i++) {
        const a = rnd(i) * Math.PI * 2, r = size * (0.3 + 1.1 * k) * (0.5 + rnd(i + 20));
        v.set(pos.x + Math.cos(a) * r, pos.y + size * (0.2 + 1.6 * k * (0.5 + rnd(i + 40))), pos.z + Math.sin(a) * r);
        fx.puff(v, size * (0.35 + 0.9 * k), c.r * 0.9, c.g * 0.9, c.b, 0.42 * (1 - k) * Math.min(1, k * 6), rnd(i + 60));
      } break;
      case 'dust': for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2 + rnd(i) * 0.3, r = size * (0.4 + 2.2 * Math.sqrt(k));
        v.set(pos.x + Math.cos(a) * r, pos.y + 0.15 + 0.3 * rnd(i + 5) * k, pos.z + Math.sin(a) * r);
        fx.puff(v, size * (0.3 + 0.6 * k), 0.55, 0.5, 0.46, 0.5 * (1 - k), rnd(i + 70));
      }
        fx.sprite(pos.clone().setY(pos.y + 0.05), size * (0.5 + 2.6 * k), 1, 0.85, 0.6, 0.6 * (1 - k), SPRITE.ring, 0);
        break;
      case 'sparks': for (let i = 0; i < 26; i++) {
        const a = rnd(i) * Math.PI * 2, sp = 2.2 + 3 * rnd(i + 9), up = 1.5 + 3 * rnd(i + 17), tt = k * 1.1;
        v.set(pos.x + Math.cos(a) * sp * tt * size, pos.y + (up * tt - 4.9 * tt * tt) * size, pos.z + Math.sin(a) * sp * tt * size);
        fx.sprite(v, 0.035 * size, c.r * 2, c.g * 2, c.b * 2, 1 - k, SPRITE.spark, rnd(i));
      } break;
      case 'flash': fx.sprite(pos, size * (0.8 + 1.5 * k), c.r * 2, c.g * 2, c.b * 2, 0.9 * (1 - k), SPRITE.flare, seed); break;
      case 'beam': {
        const top = pos.clone().setY(pos.y + 9 * size);
        fx.line(pos, top, 0.5 * size * (1 - 0.5 * k), 2, c.r, c.g, c.b, 0.35 * Math.sin(Math.PI * k), true);
        break;
      }
      case 'thrust': {
        // a downward flame cone (k = intensity 0..1, not age)
        for (let i = 0; i < 5; i++) {
          v.copy(pos).setY(pos.y - i * 0.18 * size);
          fx.sprite(v, size * (0.45 - i * 0.06), 1, 0.55 + 0.1 * i, 0.25, k * (1 - i * 0.17), i === 0 ? SPRITE.core : SPRITE.fire, rnd(i) + seed);
        }
        fx.puff(pos.clone().setY(pos.y - size), size * 0.9, 0.7, 0.7, 0.72, 0.25 * k, seed);
        break;
      }
      case 'glow': fx.sprite(pos, size, c.r, c.g, c.b, k, SPRITE.glow, 0); break;
    }
  }

  // ---------------------------------------------------------------- debug (vtpOut.forms.debug())
  debug() {
    const rt = this.rt;
    if (!rt || (!this.defs && !this.big)) return null;
    const zones: Record<string, unknown> = {};
    for (const [z, { ph, s }] of this.samples) {
      zones[z] = { cur: ph.cur, prev: ph.prev, k: ph.k, t: +ph.t.toFixed(2), active: s.active, shown: s.shown, moving: [...s.moving].slice(0, 12), settled: s.settled,
        occupants: this.occupants(z).map((o) => ({ key: o.a.key, cls: o.occ.cls, kind: o.occ.kind, height: o.occ.height })), source: formsBagOf(rt.state.modes, rt.info.id)?.zones[z] && !this.localLock[z] ? 'host' : 'local' };
    }
    return { room: rt.info.id, zones, kit: this.kitRoots.map((r) => r.name), unfolded: this.unfoldedNodes, big: !!this.big, errors: this.errors, occluders: rt.room.occluders.length, cams: [...this.camsOn], fx: this.fx?.counts() ?? null,
      spots: [...rt.actors.keys()].map((k) => { const s = rt.seatOf(k); return s ? { key: k, index: s.index, label: s.label, form: (s.extras as { form?: string }).form ?? null, pos: s.position.toArray().map((v) => +v.toFixed(2)) } : { key: k, index: null }; }) };
  }
}

/** `forms.kit` of a room that has a big entrance but no zones. */
function kitOnly(info: unknown) {
  const f = (info as { forms?: { kit?: unknown } } | null)?.forms;
  if (!f || !Array.isArray(f.kit)) return [];
  const p = parseForms({ forms: { zones: { _k: { spots: ['SPOT_01'], order: ['_k'] } }, list: { _k: { zone: '_k', nodes: [] } }, kit: f.kit } });
  return p?.kit ?? [];
}

export const formsScene = new FormsScene();
