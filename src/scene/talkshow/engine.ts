// Interview mode — the page side (OBS pages of the host and of every party guest + the Scene-tab preview). Attached to
// the current SceneRuntime while the stage mode `interview` is active (src/scene/stage/modes/interview.ts):
//
//   the set      a talk-show desk at the host's chair (or the room's own desk), the guest MONITOR (a generated retro TV /
//                CRT / field monitor / menu board, or the room's own screen skin), the sidekick with a band stand —
//                per room from shared/talkshow.ts ROOM_SETS, overridable in scene.json `interview`;
//   guests       performer guests on the monitor (their avatar in a remote mini set → render target → a panel) or seated
//                in the guest chairs; video guests on the monitor (the shared window, cropped per guest, or an OBS
//                passthrough hole that opens only on its own close-up); TV performers (their feed) via a hook;
//   co-hosts     sit with the host at the desk: generated seats (+ chairs) beside the host — the desk grows to seat
//                everyone — or the room's chairs there / nearby (layout.ts); seated through SceneRuntime.spotHook;
//   the camera   the auto-director (director.ts) on the voice signals of this page (voice.ts), the shot book
//                (shots.ts) for the poses, hotkey / button cuts from the host's bag (cutSeq) — through
//                SceneRuntime.cameraOverride (room events like a riot or a big-donation raid still take over);
//   show open    a title-card curtain (bumper.ts) when the host's bumperSeq bumps.
// Costs nothing while the mode is off (not attached).
import * as THREE from 'three';
import { HOST_KEY } from '../../../shared/scene.ts';
import { askerStandsDown, planLineup, roomCoverage, roomInterviewConfig, sanitizeCue, sanitizeInterview, singleShotOf, type InterviewBag, type InterviewCue, type LineupSlot, type MonitorStyle, type RoomInterviewConfig, type SetTheme, type ShotId } from '../../../shared/talkshow.ts';
import { SceneRuntime } from '../SceneRuntime.ts';
import { restTopAbove, type SceneActor } from '../actor.ts';
import type { SpotInfo } from '../contract.ts';
import type { CamPose } from '../cameraRig.ts';
import { RoomRays, deriveSoloPlacement } from '../twoShot.ts';
import { InterviewDirector, type DirectorShot } from './director.ts';
import { TalkMonitor, panelRects, type PanelSource } from './monitor.ts';
import { PropKit, buildChair, buildDesk, buildStand, housingSize, namePlate, MONITOR_ASPECT, THEME_LOOKS, type BuiltDesk } from './props.ts';
import { boxFree, planSet, type CoSeat, type SetLayout } from './layout.ts';
import { RoomProbe } from '../shotSolver.ts';
import { formsOfRoom } from '../forms/formsScene.ts';
import { RemoteStudios } from './remote.ts';
import { ShotBook, fitFaceBox, snapPose, type Head, type SetGeom } from './shots.ts';
import { Sidekick } from './sidekick.ts';
import { VoiceTap } from './voice.ts';
import { InterviewVoices, type VoiceInput } from './activity.ts';
import { TALK_OPEN } from './bumper.ts';
import { TvFeedCards } from './tvFeed.ts';
import { tvOfActor, tvReact } from '../tv/tvApi.ts';
import { occupantOf, type OccupantClass } from '../../../shared/occupant.ts';
import { DESK_STD, callInOffset, clampDeskSpan, deskShift, deskSpec, seatedElbow, type DeskSpec } from '../../../shared/forms.ts';
import { findCallInHousing, housingDelta, housingPlace, type CallInHousing } from './callInHousing.ts';
import { moveOf, noFlight, reachOf, softCutSecs, widePoseFor } from './cueShots.ts';
import { audienceShots } from '../audience/cams.ts';

const UP = new THREE.Vector3(0, 1, 0);
const D2R = Math.PI / 180;

/** The room's camera positions (world): every CAM_* preset, and scene.json `studioCams.cameras[].lens` (glTF, room
 *  space — the physical camera props a studio room lists), de-duplicated within 10 cm. */
function roomLenses(rt: SceneRuntime): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const add = (v: THREE.Vector3) => { if (!out.some((q) => q.distanceTo(v) < 0.1)) out.push(v); };
  for (const c of rt.room.cameras.values()) add(c.position.clone());
  const sc = (rt.info as unknown as { studioCams?: { cameras?: { lens?: unknown }[] } }).studioCams;
  if (Array.isArray(sc?.cameras)) for (const c of sc!.cameras!.slice(0, 32)) {
    const l = c?.lens;
    if (Array.isArray(l) && l.length === 3 && l.every((v) => typeof v === 'number' && Number.isFinite(v))) add(rt.room.root.localToWorld(new THREE.Vector3(l[0] as number, l[1] as number, l[2] as number)));
  }
  return out.slice(0, 40);
}

/** Hook for performer kinds that bring their own live picture (walking-TV guests, tvguests workstream): return the
 *  texture of member `key`'s feed (and its aspect) — shown on the monitor panel; null = not a feed performer. */
export type GuestFeed = (key: string) => { tex: THREE.Texture; aspect: number } | null;
const feeds: GuestFeed[] = [];
export function registerGuestFeed(fn: GuestFeed) { if (!feeds.includes(fn)) feeds.push(fn); }
const feedOf = (key: string) => { for (const f of feeds) { try { const r = f(key); if (r) return r; } catch { /* a broken hook never breaks the show */ } } return null; };

interface CurtainLike { test(target: { id: string | null; name: string; thumb: string | null }, style?: string): void; active: boolean }

/** A line-up entry on this page: the plan + their actor + seated right now. */
type Person = LineupSlot & { a: SceneActor | null; seated: boolean };
/** Generated desk seats: spot indices after the size spots' range and before the chat buddy (90) / projectors (100+). */
const SEAT_INDEX = 80;
type SpotHook = NonNullable<typeof SceneRuntime.spotHook>;

export interface InterviewPageOpts {
  /** Curtain of this page (show-open card). */
  curtain?: CurtainLike | null;
  /** Page kind: 'hole' (OBS) or 'preview' (the studio's Scene preview: the hole shows a placeholder). */
  look: 'hole' | 'preview';
}

export class InterviewScene {
  rt: SceneRuntime | null = null;
  bag: InterviewBag = sanitizeInterview(null);
  private cfg: RoomInterviewConfig = {};
  private group = new THREE.Group();
  private owned: (THREE.Material | THREE.BufferGeometry | THREE.Texture)[] = [];
  private desk: BuiltDesk | null = null;
  private deskFront: THREE.Vector3 | null = null;
  monitor: TalkMonitor | null = null;
  private remote: RemoteStudios | null = null;
  private sidekick: Sidekick | null = null;
  private sidekickPlace: { position: THREE.Vector3; yaw: number } | null = null;
  private book: ShotBook | null = null;
  private rays: RoomRays | null = null;
  readonly voice = new VoiceTap();
  /** Walking-TV guests' live pictures for the monitor panels. */
  private tvCards = new TvFeedCards();
  private remoteFeed = new Set<string>();
  /** Participant id ('c0', 'g1' …) → their actor (reaction beats). */
  private idActors = new Map<string, SceneActor | null>();
  /** The line-up as planned this frame (roles, places, panels). */
  lineup: Person[] = [];
  /** Co-hosts' seats (co-host order): a room chair or a generated desk seat. */
  private coSeats: { seat: CoSeat; spot: SpotInfo }[] = [];
  /** Co-hosts the set was built for (a change rebuilds the set: the desk / seats / monitor re-plan). */
  private builtCo = -1;
  /** The host the generated desk was shaped for (shared/forms.ts deskSpec): class + model + scale. */
  private builtHostSig = 'human';
  /** The host's occupant class now (size + body plan; an ordinary human = the desk as it always was). */
  private hostCls(rt: SceneRuntime): OccupantClass {
    const a = rt.actors.get(HOST_KEY);
    return a?.runtime ? occupantOf(a.runtime.profile, undefined, a.rest?.height).cls : 'human';
  }
  /** What the desk's shape depends on: the class, and for small / large hosts the model (their elbow) at its scale. */
  private hostSig(rt: SceneRuntime): string {
    const cls = this.hostCls(rt), a = rt.actors.get(HOST_KEY);
    const body = cls === 'small' || cls === 'large' ? `${cls}|${a?.runtime?.profile.id ?? ''}|${(a?.scale ?? 1).toFixed(3)}` : cls;
    // (room forms: the form serving the host's spot - the desk became the docking cradle - re-plans the set: SPEC 2.5)
    const form = (this.hostSpot()?.extras as { form?: string } | undefined)?.form ?? '';
    return form ? `${body}|form:${form}` : body;
  }
  /** The host's seated elbow (upper arm hanging) above `floorY`, from their measured skeleton at their scale: the generated
   *  desk's top follows it for small / large hosts (shared/forms.ts deskSpec). null = not seated / no arm joints. */
  private hostElbow(rt: SceneRuntime, spot: SpotInfo | null, floorY: number): number | null {
    const a = rt.actors.get(HOST_KEY), r = a?.rest;
    if (!a || !r || !spot || spot.pose !== 'sit' || a.runtime?.quadruped) return null;
    const j = r.joints, left = !!(j.leftUpperArm && j.leftLowerArm);
    const sh = left ? j.leftUpperArm : j.rightUpperArm, el = left ? j.leftLowerArm : j.rightLowerArm;
    const hips = r.hips ?? j.hips ?? null;
    return seatedElbow({ seat: spot.position.y + spot.seatHeight - floorY, height: r.height, hipsY: hips ? hips.y : null, shoulderY: sh ? sh.y : null, upperArm: sh && el ? sh.distanceTo(el) : null }, a.scale);
  }
  /** The call-in screen as the set placed it (centre y, the floor under it) and whether it can be lifted (a skin - its
   *  pylon inside the template - or a holo; a floor-standing tv / crt / terminal keeps its place: its stand can't stretch). */
  private monBase: { p: THREE.Vector3; c: THREE.Vector3; floor: number; liftable: boolean } | null = null;
  /** The room node the call-in picture sits ON (scene.json interview.monitor.node, else a skin monitor's own template:
   *  callInHousing.ts): the picture follows its whole world move and never fit.monY. null = a screen the set brought. */
  private monHousing: CallInHousing | null = null;
  /** Its move from where the set placed it now / where it is going (m, world: room forms - SPEC 6.1 C7). */
  private readonly monOff = new THREE.Vector3();
  private readonly monOffTarget = new THREE.Vector3();
  private readonly monTmp = new THREE.Vector3();
  private readonly monArr: [number, number, number] = [0, 0, 0];
  private readonly monArr2: [number, number, number] = [0, 0, 0];
  /** Lift now (m, world up: monOff.y). */
  private get monLift() { return this.monOff.y; }
  /** SPEC 6.1 C7: lift the call-in screen `dy` m (world up) from where the set placed it - room forms fit it to the host's
   *  eye line (fit.monY: a docked mech pilot's eye is metres up). Only a screen the set brought that can rise (a skin /
   *  holo); clamped -1.5 .. 2.5 m. The shot book re-fits (the screen's corners are hard points of every shot it is in:
   *  updateGeom). Called every frame from the room's forms (fitMonitor); 0 = as placed. */
  setMonitorLift(dy: number) {
    const b = this.monBase;
    const v = b?.liftable && Number.isFinite(dy) ? THREE.MathUtils.clamp(dy, -1.5, 2.5) : 0;
    this.setMonitorOffset(0, v, 0);
  }
  /** Move the call-in screen (the monitor rig + its picture place) by (x, y, z) m, world, from where the set placed it. */
  private setMonitorOffset(x: number, y: number, z: number) {
    const o = this.monOff;
    if (Math.abs(x - o.x) < 1e-3 && Math.abs(y - o.y) < 1e-3 && Math.abs(z - o.z) < 1e-3) return;
    o.set(x, y, z);
    if (this.monitor && this.monBase) this.putMonitor(o);
  }
  private putMonitor(off: THREE.Vector3) {
    const b = this.monBase!, m = this.monitor!;
    m.root.position.copy(b.p).add(off); m.place.center.copy(b.c).add(off);
    m.root.updateMatrixWorld(true);
  }
  /** Every frame: a picture on a room node follows that node (callInOffset `housing`); else the room's forms lift it to
   *  fit.monY over its floor (eased in with the form that lists it). */
  private fitMonitor(rt: SceneRuntime) {
    const b = this.monBase, h = this.monHousing;
    if (!b || !this.monitor) { this.monOffTarget.set(0, 0, 0); return; }
    if (h) {
      const d = callInOffset({ housing: housingDelta(h, this.monArr, this.monTmp), liftable: b.liftable, floor: b.floor, baseY: b.p.y }, this.monArr2);
      // (rounded: the shot book re-solves when the target changes - SPEC 6.1 C7)
      this.monOffTarget.set(Math.round(d[0] * 100) / 100, Math.round(d[1] * 100) / 100, Math.round(d[2] * 100) / 100);
      this.setMonitorOffset(d[0], d[1], d[2]);
      return;
    }
    const mf = formsOfRoom(rt.room)?.monitorFit() ?? null;
    const full = mf ? callInOffset({ liftable: true, floor: b.floor, baseY: b.p.y, monY: mf.monY }, this.monArr2)[1] : 0;
    this.monOffTarget.set(0, b.liftable && mf?.target ? Math.round(full * 100) / 100 : 0, 0);
    this.setMonitorLift(mf ? full * mf.k : 0);
  }
  /** Debug / tests: the call-in screen's lift (m) now and where it is going, its centre height above its floor, its whole
   *  offset and the room node it rides (null = none). */
  monitorLift() {
    const b = this.monBase, h = this.monHousing;
    return b ? { lift: this.monLift, target: this.monOffTarget.y, overFloor: b.p.y + this.monLift - b.floor, liftable: b.liftable,
      offset: this.monOff.toArray().map((v) => +v.toFixed(4)), housing: h ? { node: h.node.name, from: h.from } : null } : null;
  }
  /** The grown desk (deskSpec: wider, deeper towards the audience) kept clear of everyone else's seat - body discs at the
   *  seat and the knees of a sit spot, in the planned desk's frame - and of the room (boxFree, stepping back towards the
   *  planned desk): a giant's console never swallows the guest chair the layout put beside the planned desk (SPEC L2). */
  private fitDeskSpan(rt: SceneRuntime, place: { position: THREE.Vector3; yaw: number; width: number }, host: SpotInfo | null, grown: { halfW: number; depth: number; shift: number }, H: number) {
    const planned = { halfW: place.width / 2, depth: DESK_STD.depth as number };
    const c = Math.cos(place.yaw), s = Math.sin(place.yaw);
    const loc = (p: THREE.Vector3) => { const dx = p.x - place.position.x, dz = p.z - place.position.z; return { x: dx * c - dz * s, z: dx * s + dz * c }; };
    const seats = new Set<SpotInfo>();
    for (const q of rt.room.spots) if (q) seats.add(q);
    for (const cs of this.coSeats) seats.add(cs.spot);
    for (const a of rt.actors.values()) if (a.spot) seats.add(a.spot);
    const discs: { x: number; z: number; r: number }[] = [];
    const roomK = (rt.info.avatarHeight ?? 1.5) / 1.5;
    for (const q of seats) {
      if (host && q.index === host.index) continue;
      if (Math.abs(q.position.y - place.position.y) > 1.2) continue;            // (another level: a balcony seat)
      const who = [...rt.actors.values()].find((a) => a.spot === q);
      const k = THREE.MathUtils.clamp(who?.height ? who.height / 1.6 : roomK, 0.5, 2.5);
      if (q.pose === 'sit') {
        discs.push({ ...loc(q.position), r: 0.28 * k });
        discs.push({ ...loc(q.position.clone().addScaledVector(q.forward, 0.42 * k)), r: 0.2 * k });
      } else discs.push({ ...loc(q.position), r: 0.3 * k });
    }
    const g = clampDeskSpan(planned, grown, discs);
    // the room (a wall, a coffee table, a COLLIDE_ box): step back towards the planned desk until the grown box is free
    const probe = new RoomProbe(rt.room), rays = this.rays!;
    const hy = (Math.min(H, 1.1) - 0.1) / 2;
    const free = (x: { halfW: number; depth: number; shift: number }) =>
      boxFree(probe, rays, place.position.clone().add(new THREE.Vector3(s, 0, c).multiplyScalar(x.shift)).setY(place.position.y + 0.1 + hy), place.yaw, x.halfW, hy, x.depth / 2);
    const back = grown.shift - grown.depth / 2;
    let out = { halfW: planned.halfW, depth: planned.depth, shift: 0, clamped: true, room: true };
    for (const t of [1, 0.66, 0.33]) {
      const halfW = planned.halfW + (g.halfW - planned.halfW) * t, front = planned.depth / 2 + (g.shift + g.depth / 2 - planned.depth / 2) * t;
      const x = { halfW, depth: front - back, shift: (front + back) / 2 };
      if (free(x)) { out = { ...x, clamped: g.clamped || t < 1, room: t < 1 }; break; }
    }
    // the top never rises over a neighbour's face (a guest chair beside the desk, a co-host behind it): a 1.4 m console
    // beside a seated guest hides her from every camera on the far side. A seated face: the performer's own (measured)
    // or seat + 0.6 m (x room scale); a standing one 0.92 x a room-sized person. Seats in front of the desk don't count
    // (they are between it and the cameras).
    let maxTop = Infinity;
    for (const q of seats) {
      if ((host && q.index === host.index) || Math.abs(q.position.y - place.position.y) > 1.2) continue;
      const p = loc(q.position);
      if (Math.abs(p.x) > out.halfW + 1.6 || p.z < back - 1.2 || p.z > out.shift + out.depth / 2 + 0.3) continue;
      const who = [...rt.actors.values()].find((a) => a.spot === q);
      const face = who?.faceAt(q)?.center.y ?? (q.pose === 'sit' ? q.position.y + q.seatHeight + 0.6 * roomK : q.position.y + 1.38 * roomK);
      maxTop = Math.min(maxTop, face - place.position.y - 0.12);
    }
    return { ...out, maxTop };
  }
  /** The host's scale the set was planned for (framing guarantee: a host who grows / shrinks a lot — a size class, a
   *  transform — gets a set re-planned round their new head, never a monitor / desk placed for the old one). */
  private builtHostScale = 0;
  private coSig = '';
  private oldSidekick: Sidekick | null = null;
  /** The desk seats of the last set (a re-plan that puts a seat in the same place keeps the same spot: no pop-in). */
  private prevSeats: SpotInfo[] = [];
  private myHook: SpotHook | null = null;
  private prevHook: typeof SceneRuntime.spotHook = null;
  director: InterviewDirector | null = null;
  private addedOcc: THREE.Mesh[] = [];
  private prevOverride: SceneRuntime['cameraOverride'] = null;
  private myOverride: SceneRuntime['cameraOverride'] = null;
  private seenCut = -1;
  private seenBumper = -1;
  /** The shot on air: `pose` = the pose it ends on (after a named move), `raw` = the solved pose before the move; `from` / `t0` =
   *  where a timed move starts (a crane's high start, a push-in a page joined late) and how far in. */
  private onAir: { key: string; base: string; sig: string; pose: CamPose; raw: CamPose; secs: number; shot: DirectorShot; from?: CamPose; t0?: number } | null = null;
  private reframes = 0;
  private held: { key: string; pose: CamPose; secs: number; from?: CamPose; t0?: number } | null = null;
  private geomSig = '';
  private geom: SetGeom | null = null;
  private placed = new Set<string>();
  private built = false;
  private time = 0;
  private titleNow = '';
  private videoTex: THREE.VideoTexture | null = null;
  private videoEl: HTMLVideoElement | null = null;
  readonly stats = { ms: 0, peak: 0, rtRenders: 0 };

  constructor(readonly opts: InterviewPageOpts) {
    this.group.name = 'vtp:interview';
    (window as unknown as { vtpInterview?: unknown }).vtpInterview = this;
  }

  // ---------------------------------------------------------------- lifecycle
  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    this.rt = rt;
    const info = rt.info as unknown as { interview?: unknown };
    this.cfg = roomInterviewConfig(rt.info.id, info.interview);
    rt.root.add(this.group);
    this.rays = new RoomRays(rt.room);
    this.book = new ShotBook(rt.room, this.rays, this.cfg.shots ?? {});
    // the set's real cameras: every CAM_* preset + scene.json studioCams lenses (the physical camera props) — the wide
    // shots try them first (src/scene/talkshow/shots.ts lenses)
    this.book.lenses = roomLenses(rt);
    this.book.setPieces = () => this.addedOcc;
    const hook = rt as unknown as { cameraOverride: SceneRuntime['cameraOverride'] };
    this.prevOverride = hook.cameraOverride;
    this.myOverride = (aspect) => this.cameraShot(aspect);
    hook.cameraOverride = this.myOverride;
    this.built = false;
    this.seenCut = -1; this.seenBumper = -1;
    this.hookSpots();
  }

  detach() {
    // (the show's cues end with the mode: coming back is a new show — never the last cut of the old one)
    this.cueIn = null; this.following = false;
    const rt = this.rt;
    if (!rt) return;
    const hook = rt as unknown as { cameraOverride: SceneRuntime['cameraOverride'] };
    if (hook.cameraOverride === this.myOverride) hook.cameraOverride = this.prevOverride;
    this.prevOverride = null; this.myOverride = null;
    this.voice.dispose();
    this.teardownSet();
    this.tvCards.dispose();
    this.oldSidekick?.dispose(); this.oldSidekick = null;
    this.group.removeFromParent();
    this.videoTex?.dispose(); this.videoTex = null; this.videoEl = null;
    this.director = null; this.book = null; this.onAir = null; this.held = null;
    this.lineup = []; this.idActors.clear();
    // the co-hosts' seats go back to the room's own spots
    if (SceneRuntime.spotHook === this.myHook) SceneRuntime.spotHook = this.prevHook;
    this.myHook = null; this.prevHook = null; this.coSig = '';
    this.reseat(rt);
    this.rt = null;
  }

  /** The set pieces (desk, monitor, stand, co-host chairs, remote studios, the sidekick) — before a rebuild / detach. */
  private teardownSet() {
    const rt = this.rt;
    if (!rt) return;
    const occ = rt.room.occluders;
    for (const m of this.addedOcc) { const i = occ.indexOf(m); if (i >= 0) occ.splice(i, 1); }
    this.addedOcc = [];
    rt.noteSetChanged();
    this.monitor?.dispose(); this.monitor = null;
    this.remote?.dispose(); this.remote = null;
    // (the sidekick stays loaded through a re-plan: reused when their place is the same, else dropped after the build)
    this.oldSidekick?.dispose(); this.oldSidekick = this.sidekick; this.sidekick = null; this.sidekickPlace = null;
    this.group.clear();
    for (const o of this.owned) o.dispose();
    this.owned = [];
    if (this.desk) rt.setSeatSurfaces([]);
    this.desk = null; this.deskFront = null;
    this.placed.clear();
    this.monLanded = false;
    this.monBase = null; this.monHousing = null; this.monOff.set(0, 0, 0); this.monOffTarget.set(0, 0, 0);
    this.prevSeats = this.coSeats.map((c) => c.spot);
    this.coSeats = []; this.builtCo = -1;
    this.book?.clear(); this.geom = null; this.geomSig = ''; this.warmSig = '';
    this.built = false;
  }

  /** Co-hosts sit in their set seats: SceneRuntime.spotHook (chained with the one already there — projector-screen TV
   *  guests, src/scene/tv/tvPage.ts). Re-wrapped when someone else replaced the hook later. */
  private hookSpots() {
    if (this.myHook && SceneRuntime.spotHook === this.myHook) return;
    const prev = SceneRuntime.spotHook;
    const mine: SpotHook = (rt) => {
      const base = prev?.(rt) ?? null;
      if (rt !== this.rt || !this.built || !this.coSeats.length) return base;
      const out = new Map(base ?? []);
      let k = 0;
      for (const x of this.lineup) {
        if (x.role !== 'cohost' || x.place !== 'studio' || !x.g.key || !rt.actors.has(x.g.key)) continue;
        const s = this.coSeats[k++];
        if (!s) break;
        out.set(x.g.key, s.spot);
      }
      return out.size ? out : null;
    };
    this.prevHook = prev; this.myHook = mine;
    SceneRuntime.spotHook = mine;
  }
  /** Seat everyone again now (SceneRuntime.reconcile, through setState with the same state). Someone still on a desk
   *  seat that is gone (a co-host made a guest again, the set re-planned, the mode ended) gives it up first: the room
   *  seats them as usual (else "keep the seat you have" would leave them on a seat nobody draws a chair for). */
  private reseat(rt: SceneRuntime) {
    const live = new Set(this.coSeats.map((c) => c.spot));
    for (const a of rt.actors.values()) if (a.spot && a.spot.index >= SEAT_INDEX && a.spot.index < SEAT_INDEX + 10 && !live.has(a.spot)) a.spot = null;
    try { rt.setState(rt.state); } catch (e) { console.warn('interview: reseat', e); }
  }

  private own = <T extends THREE.Material | THREE.BufferGeometry | THREE.Texture>(x: T): T => { this.owned.push(x); return x; };

  /** A fallback monitor place that hides no studio guest's head from the camera side of the set (CAM_WIDE, and three
   *  points 4 m in front of the host): the place itself, else its mirror across the host's facing (if that is free of
   *  furniture and in the host's sight), else the one hiding fewer. */
  private clearOfGuests(pl: { center: THREE.Vector3; yaw: number; width: number }, host: SpotInfo, face: THREE.Vector3, style: MonitorStyle, aspect: number,
    heads: THREE.Vector3[], rays: RoomRays): { center: THREE.Vector3; yaw: number; width: number } {
    if (!heads.length) return pl;
    const fH = host.forward.clone().setY(0).normalize(), side = new THREE.Vector3().crossVectors(UP, fH).normalize();
    const front = host.position.clone().addScaledVector(fH, 4).setY(host.position.y + 1.6);
    const views = [front, front.clone().addScaledVector(side, 2), front.clone().addScaledVector(side, -2)];
    const wide = this.rt?.room.cameras.get('CAM_WIDE')?.position;
    if (wide) views.push(wide.clone());
    const hidden = (q: { center: THREE.Vector3; yaw: number; width: number }) => {
      const hs = housingSize(style, q.width, q.width / aspect);
      const floorY = rays.floorBelow(q.center, 4);
      const lo = hs.floor && floorY !== null ? floorY - q.center.y : -hs.h / 2;
      const box = new THREE.Box3(new THREE.Vector3(-hs.w / 2, lo, -hs.d), new THREE.Vector3(hs.w / 2, hs.h / 2, 0.08));
      const inv = new THREE.Matrix4().makeRotationY(q.yaw).setPosition(q.center).invert();
      let n = 0;
      for (const v of views) for (const h of heads) {
        const a = v.clone().applyMatrix4(inv), b = h.clone().applyMatrix4(inv), d = b.clone().sub(a), L = d.length();
        const hit = new THREE.Ray(a, d.divideScalar(L)).intersectBox(box, new THREE.Vector3());
        if (hit && hit.distanceTo(a) < L - 0.05) n++;
      }
      return n;
    };
    const n0 = hidden(pl);
    if (n0 === 0) return pl;
    const off = pl.center.clone().sub(host.position);
    const c2 = pl.center.clone().addScaledVector(side, -2 * off.dot(side));
    const nrm = new THREE.Vector3(Math.sin(pl.yaw), 0, Math.cos(pl.yaw));
    const n2 = nrm.clone().addScaledVector(side, -2 * nrm.dot(side));
    const mirror = { center: c2, yaw: Math.atan2(n2.x, n2.z), width: pl.width };
    if (rays.insideCollider(c2, 0.1) || !rays.clear(face, c2)) return pl;
    return hidden(mirror) < n0 ? mirror : pl;
  }
  private w = (v: [number, number, number]) => this.rt!.room.root.localToWorld(new THREE.Vector3(v[0], v[1], v[2]));

  private hostSpot(): SpotInfo | null {
    const rt = this.rt!;
    const name = this.cfg.host ?? 'SPOT_01';
    const base = rt.room.spots.find((s) => s?.name === name) ?? rt.room.spots.find(Boolean) ?? null;
    if (!base) return null;
    // room forms (SPEC 2.5): the host's spot as the room's current form serves it (a mech on the docking cradle, the
    // chair on the desk sled), so the monitor, the desk front and the shots are planned from where the host really is
    const holder = [...rt.actors.values()].find((a) => a.spot?.index === base.index);
    return formsOfRoom(rt.room)?.mapSpot(holder?.key ?? HOST_KEY, base) ?? base;
  }
  get theme(): SetTheme { return this.cfg.theme ?? 'studio'; }

  /** Build the set (once the room is in): desk, monitor, sidekick stand, the co-hosts' seats — authored places or
   *  automatic (layout.ts). `cohosts` = co-hosts to seat beside the host. */
  layoutNotes: string[] = [];
  private build(cohosts = 0) {
    const rt = this.rt!, cfg = this.cfg, rays = this.rays!;
    const k = new PropKit(this.own);
    const host = this.hostSpot();
    const hostA = [...rt.actors.values()].find((a) => a.spot === host) ?? rt.actors.get(HOST_KEY) ?? null;
    const face = (host && hostA?.faceAt(host)?.center) ?? (host ? host.position.clone().setY(host.position.y + 1.25) : null);
    const m = cfg.monitor ?? {};
    const style: MonitorStyle = m.style ?? (this.theme === 'kitchen' ? 'menuboard' : 'tv');
    const W = THREE.MathUtils.clamp(m.width ?? 1.4, 0.6, 4), aspect = MONITOR_ASPECT[style] ?? 16 / 9;
    const pinnedM = Array.isArray(m.position) && typeof m.yaw === 'number';
    // (the room node the picture sits on: interview.monitor.node, else a skin monitor's template - callInHousing.ts)
    const housing = findCallInHousing({ root: rt.room.root, name: m.node, style, skinTemplate: style === 'skin' ? rt.skins.solo.template : null });
    const onNode = !pinnedM && housing?.from === 'node';
    const sk = cfg.sidekick;
    const pinnedS = !!sk && Array.isArray(sk.position);
    const deskCfg = cfg.desk;
    let lay: SetLayout = { desk: null, monitor: null, sidekick: null, cohosts: [], notes: [] };
    const spotNamed = (n: string) => rt.room.spots.find((q) => q?.name === n) ?? null;
    const guestChairs = (cfg.guests ?? []).map(spotNamed).filter((q): q is NonNullable<typeof q> => !!q);
    // (a room without guest chairs in its config: the seats the line-up's studio guests have right now — the monitor
    // must not hide them either)
    const likelySeats = guestChairs.length || !host ? guestChairs
      : planLineup(this.bag).filter((x) => x.role === 'guest' && x.place === 'studio' && x.g.key).map((x) => rt.actors.get(x.g.key!)?.spot ?? null)
        .filter((q): q is SpotInfo => !!q && q !== host && q.index < 12);
    if (host && face) {
      const sp = rt.room.spots.filter((s): s is NonNullable<typeof s> => !!s);
      const center = sp.reduce((a, s) => a.add(s.position), new THREE.Vector3()).multiplyScalar(1 / Math.max(1, sp.length));
      const t0 = performance.now();
      lay = planSet({ room: rt.room, rays, host, face, width: W, aspect, cabinet: housingSize(style, W, W / aspect), wantDesk: deskCfg === undefined, side: m.side, roomCenter: center,
        guestSeats: likelySeats.map((q) => q.position.clone().setY(q.position.y + (q.pose === 'sit' ? 1.05 : 1.4))), wide: rt.room.cameras.get('CAM_WIDE')?.position.clone() ?? null, haveMonitor: pinnedM || onNode, haveSidekick: pinnedS || sk === null,
        cohosts, personH: rt.info.avatarHeight ?? 1.5, pinnedCohosts: (cfg.cohosts ?? []).map(spotNamed).filter((q): q is NonNullable<typeof q> => !!q), guestChairs });
      lay.notes.push(`layout ${(performance.now() - t0).toFixed(0)} ms`);
    }
    this.layoutNotes = lay.notes;
    this.builtHostScale = hostA?.scale ?? rt.actors.get(HOST_KEY)?.scale ?? 0;
    // co-hosts' seats: a room chair as it is, or a generated seat (+ a chair when the host's own spot is a chair)
    this.coSeats = lay.cohosts.map((c, i) => ({ seat: c, spot: c.spot ?? this.deskSeat(k, c, i, host!) }));
    this.builtCo = cohosts;
    // desk
    let deskPlace: { position: THREE.Vector3; yaw: number; width: number; seats?: number[] } | null = null;
    if (deskCfg && typeof deskCfg === 'object') deskPlace = { position: this.w(deskCfg.position), yaw: deskCfg.yaw * D2R, width: THREE.MathUtils.clamp(deskCfg.width ?? 1.45, 0.9, 2.4) };
    else if (deskCfg === undefined) deskPlace = lay.desk;
    // a desk shaped for the host (room forms, shared/forms.ts deskSpec): a small or large host gets the top just under
    // their seated elbow (a large one a deeper, wider desk that grows away from them), a giant a standing console, a mech
    // a holo plate; an ordinary human (and a fairy, who stands on the desk top: sizeSeat.ts) the desk exactly as always
    const cls = this.hostCls(rt);
    this.builtHostSig = this.hostSig(rt);
    const spec: DeskSpec | null = cls === 'human' || cls === 'micro' ? null
      : deskSpec(cls, rt.actors.get(HOST_KEY)?.height ?? 1.5, deskPlace ? this.hostElbow(rt, host, deskPlace.position.y) : null);
    if (deskPlace && spec?.holo && host && face) {
      // a mech / vehicle host: no desk to squeeze behind - a projected holo plate in front of the pilot (SPEC 2.5)
      const fsz = rt.actors.get(HOST_KEY)?.faceAt(host)?.size ?? 0.24, kk = THREE.MathUtils.clamp(fsz / 0.24, 0.5, 3);
      const g = new THREE.Group(); g.name = 'vtp:interview:holo';
      const glass = k.basic(null, 0x46e6ff, { transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const edge = k.basic(null, 0x7ff4ff);
      const hw = 1.4 * kk, hd = 0.45 * kk;
      k.box(hw, 0.02 * kk, hd, glass, g);
      for (const z of [-hd / 2, hd / 2]) k.box(hw, 0.012 * kk, 0.012 * kk, edge, g, 0, 0.012 * kk, z);
      for (const x of [-hw / 2, hw / 2]) k.box(0.012 * kk, 0.012 * kk, hd, edge, g, x, 0.012 * kk, 0);
      g.position.copy(face).addScaledVector(host.forward, 0.6 * kk).add(new THREE.Vector3(0, -0.45 * kk, 0));
      g.rotation.y = host.yaw;
      this.group.add(g);
      this.deskFront = g.position.clone();
      this.layoutNotes.push(`desk: a holo plate for a ${cls} host`);
    } else if (deskPlace) {
      let shift = spec ? deskShift(spec) : 0;
      if (spec) this.layoutNotes.push(`desk shaped for a ${cls} host: top ${spec.height.toFixed(2)} m (${spec.from === 'elbow' ? 'their seated elbow' : 'class table'}), depth ${spec.depth.toFixed(2)} m, width x${spec.widthK}, ${shift.toFixed(2)} m further out`);
      let deskW = deskPlace.width * (spec?.widthK ?? 1), deskD = spec?.depth ?? 0.64, deskH = spec?.height ?? 0.76;
      // (grown: kept clear of the seats beside / in front of it and of the room - the layout placed those around the
      //  planned desk)
      if (spec && (deskW > deskPlace.width + 1e-3 || deskD > DESK_STD.depth + 1e-3 || shift > 1e-3)) {
        const g = this.fitDeskSpan(rt, deskPlace, host, { halfW: deskW / 2, depth: deskD, shift }, deskH);
        if (g.clamped) this.layoutNotes.push(`desk: kept clear of the ${g.room ? 'room' : 'seats beside it'}: ${(g.halfW * 2).toFixed(2)} m wide, ${g.depth.toFixed(2)} m deep, ${g.shift.toFixed(2)} m out`);
        deskW = g.halfW * 2; deskD = g.depth; shift = g.shift;
        // (a giant's console stays in its SPEC range 0.9 - 1.6 m; never under the standard desk)
        const top = Math.max(cls === 'giant' ? 0.9 : DESK_STD.height, g.maxTop);
        if (deskH > top + 1e-3) { this.layoutNotes.push(`desk: top ${deskH.toFixed(2)} -> ${top.toFixed(2)} m (under the faces of the seats beside it)`); deskH = top; }
      }
      const d = buildDesk(k, this.theme, deskW, this.bag.title, deskPlace.seats, spec ? { height: deskH, depth: deskD } : undefined);
      d.root.userData.width = deskPlace.width;
      d.root.userData.top = deskH; d.root.userData.drawn = { width: deskW, depth: deskD, shift };
      d.root.position.copy(deskPlace.position);
      d.root.rotation.y = deskPlace.yaw;
      // (a deeper desk grows towards the audience: its back edge stays clear of the host, + `back` more room)
      if (shift) d.root.position.add(new THREE.Vector3(Math.sin(deskPlace.yaw), 0, Math.cos(deskPlace.yaw)).multiplyScalar(shift));
      this.group.add(d.root);
      this.desk = d;
      d.root.updateMatrixWorld(true);
      // small performers can stand on / must clear the generated desk (size-aware seating, src/scene/sizeSeat.ts)
      const dc = d.root.localToWorld(new THREE.Vector3(0, 0, 0));
      rt.setSeatSurfaces([{ center: dc, yaw: deskPlace.yaw, halfW: deskW / 2, halfD: deskD / 2, top: dc.y + deskH }]);
      this.deskFront = d.root.localToWorld(new THREE.Vector3(0, 0.5, deskD / 2 + 0.1));
      this.addedOcc.push(...d.occluders);
    } else if (deskCfg === 'room' && host) this.deskFront = host.position.clone().addScaledVector(host.forward, 0.9).setY(host.position.y + 0.5);
    this.titleNow = this.bag.title;
    // monitor
    let place: { center: THREE.Vector3; yaw: number; width: number } | null = null;
    if (pinnedM) place = { center: this.w(m.position as [number, number, number]), yaw: (m.yaw as number) * D2R, width: W };
    else if (onNode) place = housingPlace(housing!, W);
    else if (lay.monitor) place = lay.monitor;
    else if (host && face) {
      // nothing free beside the host: the room's solo-screen spot (authored or derived) — never standing in front of a
      // studio guest's chair (framing guarantee: the call-in monitor must not hide a guest from the cameras): that side,
      // else mirrored to the host's other side, else whichever hides the fewest
      const r = deriveSoloPlacement({ spot: host, face: { center: face, size: 0.1 }, bodyH: 1.5, aspect: 16 / 9, rays });
      const first = { center: r.place.center, yaw: r.place.yaw, width: Math.min(W, r.place.width) };
      const heads = likelySeats.map((q) => q.position.clone().setY(q.position.y + (q.pose === 'sit' ? 1.05 : 1.4)));
      place = this.clearOfGuests(first, host, face, style, aspect, heads, rays);
      this.layoutNotes.push(`monitor: fell back to the solo-screen place${place !== first ? ' (mirrored: clear of the guests)' : ''}`);
    }
    if (place) {
      const skin = style === 'skin' ? rt.skins.solo : null;
      const floorY = rays.floorBelow(place.center, 4);
      const ceilingY = rays.ceilingAbove(place.center, 6);
      this.monitor = new TalkMonitor({ ...place, floorY, ceilingY }, style, this.theme, () => this.bag.title, skin);
      this.group.add(this.monitor.root);
      this.monBase = { p: this.monitor.root.position.clone(), c: this.monitor.place.center.clone(), floor: floorY ?? (host ? host.position.y : place.center.y - 1.2), liftable: style === 'skin' || style === 'holo' };
      this.monOff.set(0, 0, 0); this.monOffTarget.set(0, 0, 0);
      // (on a room node - the picture rect on the room's own TV glass - it rides that node, never fit.monY: the floor probe
      //  from the glass meets the TV's own cabinet, and the self-lift put the guest 0.965 m up into the CRT's frame)
      this.monHousing = housing;
      if (housing) this.layoutNotes.push(`monitor: on the room node ${housing.node.name} (${housing.from === 'node' ? 'interview.monitor.node' : 'its skin template'}): it rides it, never fit.monY`);
      this.monitor.target = 1;
    }
    // sidekick + band stand
    if (sk !== null) {
      this.sidekickPlace = pinnedS ? { position: this.w(sk!.position as [number, number, number]), yaw: (sk!.yaw ?? 0) * D2R } : lay.sidekick;
      if (this.sidekickPlace) {
        const stand = buildStand(k, sk?.stand ?? 'keys', this.theme);
        stand.position.copy(this.sidekickPlace.position);
        stand.rotation.y = this.sidekickPlace.yaw;
        this.group.add(stand);
      }
    }
    const old = this.oldSidekick; this.oldSidekick = null;
    if (old && this.sidekickPlace && old.place.position.distanceTo(this.sidekickPlace.position) < 0.02 && Math.abs(old.place.yaw - this.sidekickPlace.yaw) < 0.01) this.sidekick = old;
    else old?.dispose();
    this.remote = new RemoteStudios(this.group, this.theme);
    for (const o of this.addedOcc) if (!rt.room.occluders.includes(o)) rt.room.occluders.push(o);
    rt.noteSetChanged();
    this.built = true;
  }

  /** A generated seat beside the host at the desk: a spot (popped in, like the size spots) + a chair when the host sits. */
  private deskSeat(k: PropKit, c: CoSeat, i: number, host: SpotInfo): SpotInfo {
    const old = this.prevSeats.find((s) => s.index === SEAT_INDEX + i && s.position.distanceTo(c.position) < 0.02 && Math.abs(s.yaw - c.yaw) < 0.01 && s.pose === host.pose);
    if (old) { this.group.add(old.node); }
    const node = old?.node ?? new THREE.Object3D();
    node.name = `vtp:interview:cohost${i + 1}`;
    node.position.copy(c.position); node.rotation.y = c.yaw;
    this.group.add(node); node.updateMatrixWorld(true);
    if (host.pose === 'sit') {
      const ch = buildChair(k, this.theme, host.seatHeight);
      ch.root.position.copy(c.position); ch.root.rotation.y = c.yaw;
      this.group.add(ch.root); ch.root.updateMatrixWorld(true);
      this.addedOcc.push(...ch.occluders);
    }
    if (old) return old;
    return { index: SEAT_INDEX + i, name: `COHOST_${String(i + 1).padStart(2, '0')}`, node, pose: host.pose, seatHeight: host.seatHeight, seatDepth: host.seatDepth, label: `Co-host ${i + 1}`,
      position: c.position.clone(), forward: new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw)), yaw: c.yaw, cam: null, leavePathAt: null, approach: [], extras: {}, sizes: null };
  }

  // ---------------------------------------------------------------- per frame (after scene.update)
  update(dt: number, bagIn: unknown) {
    const rt = this.rt;
    if (!rt) return;
    const t0 = performance.now();
    this.time += dt;
    this.bag = sanitizeInterview(bagIn);
    const bag = this.bag;
    this.hookSpots();
    // ---- roster: who is where (shared/talkshow.ts planLineup: roles, places, the monitor's panels); a walking TV
    // (webcam / VTube Studio performer) is a TV whatever the host picked
    const actorOf = (key?: string) => (key ? rt.actors.get(key) ?? null : null);
    const plan = planLineup(bag, (g) => { const a = g.kind !== 'video' ? actorOf(g.key) : null; const t = a ? tvOfActor(a) : null; return t ? { tv: true, look: t.look ?? null } : null; });
    // co-hosts to seat at the desk: the members among them who are here (a change re-plans the set)
    const coHere = plan.filter((x) => x.role === 'cohost' && x.place === 'studio' && !!actorOf(x.g.key));
    if (this.built && coHere.length !== this.builtCo) { this.teardownSet(); this.layoutNotes.push('co-hosts changed: set re-planned'); }
    else if (this.built && this.hostSig(rt) !== this.builtHostSig) { this.teardownSet(); this.layoutNotes.push('host size / body / room form changed: set re-planned'); }
    const hostScale = rt.actors.get(HOST_KEY)?.scale ?? 0;
    if (this.built && hostScale > 0 && this.builtHostScale > 0 && Math.abs(Math.log(hostScale / this.builtHostScale)) > Math.log(1.25)) {
      this.teardownSet(); this.layoutNotes.push('host size changed: set re-planned');
    }
    if (!this.built) {
      // wait until the host's avatar is measured (their face drives the shots)
      if (![...rt.actors.values()].some((a) => a.rest)) return;
      this.build(coHere.length);
    }
    const coSig = coHere.map((x) => x.g.key).join(',') + `|${this.coSeats.length}`;
    if (coSig !== this.coSig) { this.coSig = coSig; this.lineup = plan.map((s) => ({ ...s, a: null, seated: false })); this.reseat(rt); }
    if (bag.title !== this.titleNow && this.desk) { this.rebuildPlate(); this.titleNow = bag.title; }
    const aspect = rt.stage.camera.aspect || 16 / 9;
    const hostA = rt.actors.get(HOST_KEY) ?? null;
    const people: Person[] = plan.map((s) => {
      const a = s.g.key ? actorOf(s.g.key) : null;
      const seated = s.place === 'studio' && s.kind !== 'video' && !!a && !!a.spot && a.shown && !rt.mover.busy(a);
      return { ...s, a, seated };
    });
    this.lineup = people;
    const guests = people.filter((x) => x.role === 'guest'), cohosts = people.filter((x) => x.role === 'cohost');
    // per person (guestlink): 'monitor' people are on the panels (panel order); a 'studio' one still walking is neither
    const onMon = people.filter((x) => x.panel >= 0).sort((a, b) => a.panel - b.panel);
    // ---- the monitor's panels
    const mon = this.monitor;
    const feedKeys = new Set<string>();
    if (mon) {
      const rects = panelRects(onMon.length);
      const src: PanelSource[] = onMon.map((x, pi) => {
        const r = rects[pi], pa = (r[2] * mon.W) / (r[3] * mon.H);
        const hook = x.kind === 'tv' && x.g.key ? feedOf(x.g.key) : null;
        const card = !hook && x.kind === 'tv' && x.g.key ? this.tvCards.texture(x.g.key, pa) : null;
        if (card && x.g.key) feedKeys.add(x.g.key);
        return this.panelSource(x.g, x.kind, x.a, hook ?? (card ? { tex: card, aspect: pa } : null), x.g.key ? this.tvCards.state(x.g.key) : 'none');
      });
      mon.idleLogo = bag.layout === 'seated' || bag.guests.length > 0 || guests.some((x) => x.place === 'studio');
      mon.setSources(src);
      mon.target = 1;
    }
    this.tvCards.keep(feedKeys);
    // ---- guests on the monitor leave the room for their remote studio (TVs showing their own feed too: no TV body in
    // the room while they are "on the line"); the studio renders only avatars / TVs without a feed
    const want = new Set<string>();
    if (mon && this.remote) onMon.forEach((x, pi) => {
      if (x.kind === 'video' || !x.a || !x.a.runtime || !x.a.spot) return;
      const r = panelRects(onMon.length)[pi];
      const pa = (r[2] * mon.W) / (r[3] * mon.H);
      const px = Math.min(1024, 900 * Math.sqrt(r[2] * r[3]));
      const slot = this.remote!.slot(x.g.key!, pi, pa, px);
      if (!this.placed.has(x.g.key!)) { rt.mover.release?.(x.a); this.placed.add(x.g.key!); }
      this.remote!.place(x.a, slot, dt);
      want.add(x.g.key!);
    });
    for (const k of [...this.placed]) if (!want.has(k)) { this.placed.delete(k); this.remote?.drop(k); }
    this.remoteFeed = feedKeys;
    // ---- voices → who is really talking (activity.ts: mic with an adaptive floor, the mouth only by its movement, call
    // audio leaking into a mic is not that performer) → the director — or the studio's cue (one director for every page)
    this.voice.sync([...rt.actors.values()].map((a) => ({ key: a.key, rt: a.runtime })));
    // (a walking TV's own voice level is its mic)
    const tvSpeak = (a: SceneActor | null) => { const t = a ? tvOfActor(a) : null; return t ? (t.speaking ? t.level : 0) : null; };
    const mix = (tv: number | null, sp: number | null | undefined) => (tv === null ? sp ?? null : Math.max(tv, sp ?? 0));
    const covered = !!(rt.state as { capcover?: { on?: boolean } } | null)?.capcover?.on;
    // (the show wants the shared window and none is shared: "SHARE A WINDOW" — the caller isn't on yet, as in the studio)
    const noWindow = bag.video === 'window' && !this.windowTexture();
    const hs = this.voice.signals(HOST_KEY);
    const inputs: VoiceInput[] = [{ id: 'host', kind: 'performer', speak: mix(tvSpeak(hostA), hs?.speak), open: hs?.open ?? null }];
    let vIdx = 0;
    people.forEach((x) => {
      // (a video caller behind the capture cover — "Jacking in…" — is not on the show yet)
      if (x.kind === 'video') { inputs.push({ id: x.id, kind: 'video', meter: this.voice.videoLevel(vIdx++), ready: !covered && !noWindow }); return; }
      const sg = x.g.key ? this.voice.signals(x.g.key) : null;
      inputs.push({ id: x.id, kind: 'performer', speak: mix(tvSpeak(x.a), sg?.speak), open: sg?.open ?? null, ready: !!x.a?.runtime && x.a.present !== false });
    });
    const levels = this.voices.levels(this.time, inputs);
    this.idActors.clear();
    for (const x of people) this.idActors.set(x.id, x.a);
    // ---- director
    const ready = this.readyBuf;
    for (const k in ready) delete ready[k];
    for (const x of inputs) ready[x.id] = x.ready !== false;
    // (planned places, not who sat down yet: the studio's director sees the same)
    const seated = guests.filter((x) => x.place === 'studio' && x.kind !== 'video').length;
    // (cue v3: the studio says whether it cuts to the sidekick; a page that has none cues it away on its own)
    const cueFresh = this.cueIn && performance.now() - this.cueIn.rx < 2500 ? this.cueIn.c : null;
    const dOpts = { pace: bag.pace, reactions: bag.reactions, pushIns: bag.pushIns, snaps: bag.snaps, guests: guests.length, cohosts: cohosts.length, layout: bag.layout, sidekick: (cueFresh?.sk ? cueFresh.sk === 'on' : bag.sidekick) && !!this.sidekickPlace, seed: bag.seed,
      ready, voiceless: this.voices.voiceless().filter((id) => /^g\d$/.test(id)), seated,
      // (a page that directs itself - no studio cue - has the room's cameras and the owner's switches too, but not the crowd's events)
      ...(this.coverage ? { coverage: this.coverage } : {}), crowdCuts: bag.crowdCuts !== false, roomCams: bag.roomCams !== false, names: this.nameMap(people) };
    if (!this.director) { this.director = new InterviewDirector(dOpts); this.director.onReaction = (who, kind) => this.react(who, kind); }
    this.director.opts = dOpts;
    if (this.seenCut < 0) this.seenCut = bag.cutSeq;
    // (the subject the host's studio stamped with the cut: every page cuts to the same person — framing guarantee §2.8)
    if (bag.cutSeq !== this.seenCut) { this.seenCut = bag.cutSeq; this.director.cut(bag.shot, bag.subject ?? '', bag); this.cutAt = performance.now(); }
    // the studio's cue: fresh (≤ 2.5 s) — a cue that still shows the shot before an operator cut this page already took
    // (the bag can arrive before the studio's next cue) waits a moment
    const cue = cueFresh;
    const cueOk = !!cue && (performance.now() - this.cutAt > 1200 || cue.shot === bag.shot);
    this.following = !!cue;
    this.askerStandDown = askerStandsDown(cue);
    let shot: DirectorShot;
    // (the director runs on the wall clock: the page clamps a frame to 0.1 s, and a self-directed page under 10 fps would run the show slow -
    // one that held a shot for 50 s in the e2e; the director itself takes at most 2 s per call)
    const wallNow = performance.now(), wallDt = this.lastWall > 0 ? Math.min(2, Math.max(dt, (wallNow - this.lastWall) / 1000)) : dt;
    this.lastWall = wallNow;
    if (bag.director === 'manual') { if (this.director.shot.shot !== bag.shot) this.director.cut(bag.shot, bag.subject ?? '', bag); this.director.update(wallDt, levels, true); shot = this.director.shot; }
    else if (cue) { this.director.update(wallDt, levels, true); shot = cueOk ? this.director.follow(cue) : this.director.shot; }
    else shot = this.director.update(wallDt, levels);
    // ---- the monitor's housing joins the room's occluders once it stands still (shots re-solve)
    if (mon && mon.landed && !this.monLanded) {
      this.monLanded = true;
      mon.root.updateMatrixWorld(true);
      for (const o of mon.occluders) if (!rt.room.occluders.includes(o)) { rt.room.occluders.push(o); this.addedOcc.push(o); }
    }
    // ---- room forms fit the call-in screen to the host's eye line (SPEC 6.1 C7: fit.monY)
    this.fitMonitor(rt);
    // ---- the set's geometry → poses
    const geo = (x: Person) => ({ a: x.seated ? x.a : null, panel: x.seated ? -1 : x.panel });
    // (framing guarantee, src/scene/frameGuard.ts: the room's motion envelope for interview shots + its guard switch)
    if (this.book) { this.book.motion = rt.motionFor('interview'); this.book.guardOn = rt.framing.guard; this.book.safeRoom = rt.framing.safe; }
    this.updateGeom(hostA, guests.map(geo), cohosts.map(geo), aspect);
    this.warmShots();
    this.resolveOnAir(shot, aspect);
    // ---- sidekick
    if (bag.sidekick && this.sidekickPlace) {
      // none picked: the chat buddy's model (he steps out of the chat while the interview runs), so a buddy that came
      // from the user library / a crew pack is the sidekick on every build; else the sidekick default
      const model = bag.sidekickModel || (rt.state?.chat?.buddyModel ?? '');
      if (!this.sidekick || (this.sidekick.modelId !== (model || 'robot') && !this.sidekick.failed)) {
        this.sidekick?.dispose();
        this.sidekick = new Sidekick(rt.root, this.sidekickPlace, (rt.info.avatarHeight ?? 1.5) * 0.72, model);
        void this.sidekick.load();
      }
      this.sidekick.update(dt, this.lookPoint(shot), aspect, true);
    } else if (this.sidekick) { this.sidekick.dispose(); this.sidekick = null; }
    // ---- monitor animation + hole (open only while the camera rests on this monitor's own close-up)
    if (mon) {
      const holeShot = this.onAir ? /^(guest\d?|guestPush)$/.test(this.onAir.shot.shot) && !this.onAir.key.includes('snap') : false;
      const settled = !rt.rig.moving && rt.rig.settledFor > 0.25 && holeShot && this.opts.look === 'hole';
      mon.update(dt, settled);
      // remote renders: only while the picture is up and on screen
      if (mon.power > 0.01 && feedKeys.size && this.monitorOnScreen()) this.tvCards.render(rt.stage.renderer);
      if (this.remote && want.size > this.remoteFeed.size && mon.power > 0.01 && this.monitorOnScreen()) {
        this.remote.render(rt.stage.renderer, rt.stage.scene, (sl) => !this.remoteFeed.has(sl.key));
        this.stats.rtRenders++;
      }
    }
    // ---- show open
    if (this.seenBumper < 0) this.seenBumper = bag.bumperSeq;
    if (bag.bumperSeq !== this.seenBumper) {
      this.seenBumper = bag.bumperSeq;
      // (tonight's guests on the card; co-hosts are part of the show, not its guests)
      const names = guests.map((x) => x.g.name).join(' · ');
      try { if (this.opts.curtain && !this.opts.curtain.active) this.opts.curtain.test({ id: rt.info.id, name: `${bag.title}|${names}`, thumb: null }, TALK_OPEN); } catch (e) { console.warn('interview: show open', e); }
    }
    const ms = performance.now() - t0;
    this.stats.ms = this.stats.ms * 0.95 + ms * 0.05;
    this.stats.peak = Math.max(this.stats.peak * 0.995, ms);
  }
  /** Clean voice levels for the local director (activity.ts). */
  private readonly voices = new InterviewVoices();
  /** The studio director's newest cue (bus command 'interview' {cue}) and when it arrived (page clock, ms). */
  private cueIn: { c: InterviewCue; rx: number } | null = null;
  private cutAt = -1e9;
  private readonly readyBuf: Record<string, boolean> = {};
  /** The room's cameras (shared/talkshow.ts roomCoverage of its scene.json), and the guests' names for the director - cached. */
  private get coverage() {
    const rt = this.rt;
    if (!rt) return undefined;
    if (this.covOf?.id !== rt.info.id) this.covOf = { id: rt.info.id, c: roomCoverage(rt.info) };
    return this.covOf.c;
  }
  private covOf: { id: string; c: ReturnType<typeof roomCoverage> } | null = null;
  private names: Record<string, string> = {};
  private namesKey = '';
  private nameMap(people: { id: string; role: string; g: { name: string } }[]) {
    const k = people.map((x) => `${x.id}=${x.g.name}`).join('|');
    if (k !== this.namesKey) { this.namesKey = k; this.names = {}; for (const x of people) if (x.role === 'guest') this.names[x.id] = x.g.name; }
    return this.names;
  }
  /** This page takes the studio's cues right now (else it directs itself). */
  following = false;
  private lastWall = 0;
  /** … and the cue it follows is a v3 studio's that cues the asker's close-up itself (cue `ac`): the audience engine's page-local one then stands down. */
  private askerStandDown = false;
  /** A cue from the host's studio director (shared/talkshow.ts InterviewCue). Two studios sending: the lower id leads. */
  cue(raw: unknown) {
    const c = sanitizeCue(raw);
    if (!c) return;
    const now = performance.now(), cur = this.cueIn;
    if (cur && now - cur.rx < 2500 && cur.c.src && c.src && c.src !== cur.c.src && c.src > cur.c.src) return;
    // (an older cut of the same show arriving late never refreshes the cue's age: a stale show can't hold the page)
    if (cur && c.src === cur.c.src && c.s === cur.c.s && c.n < cur.c.n && c.n >= cur.c.n - 3) return;
    this.cueIn = { c, rx: now };
  }
  /** A reaction beat from the director: the sidekick laughs / nods; a TV performer plays their own clip. */
  private react(who: string, kind: 'laugh' | 'snap' | 'nod') {
    if (who === 'sidekick') { if (kind === 'laugh') this.sidekick?.laugh(); else this.sidekick?.nod(); return; }
    if (kind === 'nod') this.sidekick?.nod();
    const a = who === 'host' ? this.rt?.actors.get(HOST_KEY) ?? null : this.idActors.get(who) ?? null;
    if (a && tvOfActor(a)) { try { tvReact(a, kind === 'laugh' ? 'laugh' : kind === 'snap' ? 'react_shock' : 'clap'); } catch { /* optional */ } }
  }
  private monLanded = false;

  private rebuildPlate() {
    const d = this.desk!;
    const k = new PropKit(this.own);
    d.plate.material = k.basic(namePlate(k, THEME_LOOKS[this.theme] ?? THEME_LOOKS.studio, this.bag.title));
  }

  private panelSource(g: InterviewBag['guests'][number], kind: 'performer' | 'video' | 'tv', a: SceneActor | null, feed: { tex: THREE.Texture; aspect: number } | null, feedState: string): PanelSource {
    const bag = this.bag;
    if (kind === 'performer' || kind === 'tv') {
      if (!a || !a.runtime) return { mode: 'card', name: g.name, tag: 'Connecting…', card: 'CONNECTING…' };
      if (!a.present) return { mode: 'card', name: g.name, tag: 'Stepped out', card: 'BE RIGHT BACK' };
      if (kind === 'tv' && feed) {
        if (feedState === 'lost' || feedState === 'none') return { mode: 'card', name: g.name, tag: 'On the line', card: 'NO SIGNAL' };
        // (the TV sender's face box: the panel's cover crop keeps the face inside its safe area)
        const face = (a.runtime as unknown as { tv?: { face?: [number, number, number, number] } }).tv?.face ?? null;
        return { mode: 'tex', tex: feed.tex, aspect: feed.aspect, name: g.name, tag: 'On the line', face };
      }
      const tex = g.key ? this.remote?.texture(g.key) ?? null : null;
      return tex ? { mode: 'tex', tex, name: g.name, tag: 'Live via satellite' } : { mode: 'card', name: g.name, tag: 'Live via satellite', card: 'TUNING IN…' };
    }
    // video guest: the host's shared window (in-scene), else the OBS hole (OBS pages) / a placeholder (preview)
    const win = this.windowTexture();
    const useWin = bag.video === 'window' || (bag.video === 'auto' && !!win);
    if (useWin && win) return { mode: 'tex', tex: win.tex, aspect: win.aspect, crop: g.crop ?? null, face: g.face ?? null, name: g.name, tag: 'On the line' };
    if (bag.video === 'window') return { mode: 'card', name: g.name, tag: 'On the line', card: 'SHARE A WINDOW' };
    return this.opts.look === 'hole' ? { mode: 'hole', name: g.name, tag: 'On the line' } : { mode: 'card', name: g.name, tag: 'On the line (OBS window)', card: 'OBS WINDOW HERE' };
  }

  /** The host's shared window (in-scene capture) as a texture: the SceneRuntime's own VideoTexture when it has one. */
  private windowTexture(): { tex: THREE.Texture; aspect: number } | null {
    const rt = this.rt!;
    const v = rt.captureVideo;
    if (!v || v.readyState < 2) return null;
    const own = (rt as unknown as { videoTex?: THREE.VideoTexture | null }).videoTex;
    let tex: THREE.Texture | null = own ?? null;
    if (!tex) {
      if (this.videoEl !== v) { this.videoTex?.dispose(); this.videoTex = new THREE.VideoTexture(v); this.videoTex.colorSpace = THREE.SRGBColorSpace; this.videoEl = v; }
      tex = this.videoTex;
    }
    return tex ? { tex, aspect: v.videoWidth > 0 ? v.videoWidth / v.videoHeight : 16 / 9 } : null;
  }

  private monitorOnScreen(): boolean {
    const m = this.monitor, cam = this.rt!.stage.camera;
    if (!m) return false;
    const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    return m.corners().some((c) => fr.containsPoint(c)) || fr.containsPoint(m.center);
  }

  // ---------------------------------------------------------------- geometry + shots
  private headOf(a: SceneActor): Head | null {
    if (!a.spot) return null;
    // (the DRAWN face, at rest: a mascot whose eye bones sit deep in a big head is framed on the face it shows, and every
    // page measures the same thing whatever the avatar was doing — src/scene/faceDepth.ts)
    const f = a.drawnFaceAt(a.spot);
    if (!f) return null;
    const r = a.rest;
    const dy = r?.drawn ? r.face.center.y - r.drawn.center.y : 0;
    const top = r ? Math.max(0.05, (restTopAbove(r) + dy) * a.scale, ((r.head?.top ?? 0) + dy) * a.scale) : f.size * 1.1;
    // (a stray antenna / hat can't blow the head up, but a giant's real head is bigger than 0.6 m: scale with the face)
    // (never below the face box itself: a skeleton-measured height can put the rest top at the face — a big-headed
    // mascot in a costume)
    // (a mech / vehicle: the PILOT's head is framed, the hull is a body that hides what is behind it — framing guarantee)
    // (the drawn face in front of the reported centre: line-of-sight tests aim at it — src/scene/faceDepth.ts)
    const depth = { ...(f.depth > 0.005 ? { depth: f.depth } : {}), ...(f.head !== f.center ? { head: f.head } : {}),
      // (standing or seated, on which floor: a standing giant's body reaches the floor and hides a guest beside its legs)
      floorY: a.spot.position.y, sit: a.spot.pose === 'sit' && !a.standingSeat };
    if (this.rt?.classOf(a) === 'mech') {
      // (the hull from the rest box at the seat, never the live bounds: an idle wing beat / a gait must not change the set's
      // shots — pages and a reloaded OBS source solve the same)
      const b = a.restBoxAt(a.spot);
      const body = b && !b.isEmpty() ? b : undefined;
      return { face: f.center, size: f.size, forward: a.spot.forward.clone(), top: Math.max(f.size * 1.15, Math.min(r?.head ? (r.head.top + dy) * a.scale : f.size * 1.8, f.size * 1.8)),
        half: Math.min(r?.head ? r.head.half * a.scale : f.size, f.size * 1.2), ...(body ? { body } : {}), ...depth };
    }
    // (a mascot's drawn face from its wide-set eyes: the face box's height follows the measured head, its width stays as
    // the head's half-width — fitFaceBox; their standing height gives a single their proportions — singleFrame)
    const fit = fitFaceBox(f.size, r?.head ? (r.head.top + dy) * a.scale : null, r?.head ? Math.min(r.head.half * a.scale, Math.max(0.6, f.size * 3)) : null);
    const size = fit.size;
    return { face: f.center, size, forward: a.spot.forward.clone(), top: Math.max(size * 1.15, Math.min(top, Math.max(0.6, size * 3))),
      ...(a.spot.cam ? { cam: a.spot.cam.position.clone() } : {}),
      ...(fit.half !== null ? { half: fit.half } : {}), ...(r && r.height > 0 ? { tall: r.height * a.scale } : {}), ...depth };
  }

  private updateGeom(host: SceneActor | null, gs: { a: SceneActor | null; panel: number }[], cs: { a: SceneActor | null; panel: number }[], aspect: number) {
    const m = this.monitor;
    // (who is where, at what size, as which framing class, on which model: the set's shots are never another line-up's)
    const who = (a: SceneActor | null | undefined) => (a ? `${this.rt?.classOf(a) ?? ''}:${(a.runtime?.profile as { id?: string } | undefined)?.id ?? ''}` : '');
    const one = (x: { a: SceneActor | null; panel: number }) => `${x.a?.spot?.index ?? -1}:${x.a?.scale.toFixed(3) ?? ''}:${x.a?.boost?.mode ?? ''}:${x.panel}:${who(x.a)}`;
    const sig = [host?.spot?.index ?? -1, host?.scale.toFixed(3), host?.boost?.mode ?? '', who(host), ...gs.map(one), 'c', ...cs.map(one), m ? `${m.W.toFixed(2)}:${this.monLanded ? 1 : 0}:${this.monOffTarget.y.toFixed(2)}|${this.monOffTarget.x.toFixed(2)},${this.monOffTarget.z.toFixed(2)}` : '-', this.sidekick?.ready ? 'sk' : '', aspect.toFixed(3), this.bag.sidekick].join('|');
    // the room's guest chairs nobody sits in (a video caller's show: the armchair between the host and the screen)
    const rt = this.rt!;
    let emptySig = '';
    for (const nm of this.cfg.guests ?? []) {
      const q = rt.room.spots.find((x) => x?.name === nm);
      if (!q || q.pose !== 'sit') continue;
      let taken = false;
      for (const a of rt.actors.values()) if (a.spot === q) { taken = true; break; }
      if (!taken) emptySig += `${q.index},`;
    }
    const fullSig = `${sig}|e${emptySig}`;
    if (fullSig === this.geomSig && this.geom) return;
    this.geomSig = fullSig;
    const empty = emptySig.split(',').filter(Boolean).map((i) => rt.room.spots[+i]).filter((q): q is SpotInfo => !!q).map((q) => q.position.clone().add(new THREE.Vector3(0, q.seatHeight + 0.2, 0)));
    const n = [...gs, ...cs].filter((x) => x.panel >= 0).length;
    // (the call-in screen where the room's forms are taking it: the shots are solved once, for where it ends up)
    const lifting = !!m && !!this.monBase && this.monOffTarget.distanceTo(this.monOff) > 1e-3;
    if (lifting) this.putMonitor(this.monOffTarget);
    const monitor = m ? { center: m.center, normal: m.normal, width: m.W, height: m.H, corners: m.corners(), panels: Array.from({ length: Math.max(1, n) }, (_, i) => m.panelFrame(i, n)) } : null;
    if (lifting) this.putMonitor(this.monOff);
    this.geom = {
      host: host ? this.headOf(host) : null,
      monitor,
      guests: gs.map((x) => ({ seat: x.a ? this.headOf(x.a) : null, panel: x.panel })),
      cohosts: cs.map((x) => ({ seat: x.a ? this.headOf(x.a) : null, panel: x.panel })),
      sidekick: this.bag.sidekick && this.sidekickPlace ? (this.sidekick?.head() ?? { face: this.sidekickPlace.position.clone().add(new THREE.Vector3(0, 0.85, 0)), size: 0.22, forward: new THREE.Vector3(Math.sin(this.sidekickPlace.yaw), 0, Math.cos(this.sidekickPlace.yaw)), top: 0.2 }) : null,
      desk: this.deskFront,
      aspect,
      skyOk: this.skyOk, voidOk: this.voidOk,
      empty,
    };
  }
  /** Solve the set's likely shots ahead of time, one per frame (a cut never waits for a solve). */
  private warmList: [string, string][] = [];
  private warmSig = '';
  private warmShots() {
    if (!this.geom || !this.book) return;
    if (this.warmSig !== this.geomSig) {
      this.warmSig = this.geomSig;
      const n = this.geom.guests.length, c = this.geom.cohosts?.length ?? 0;
      this.warmList = [['establishing', ''], ['host', 'host'], ...Array.from({ length: c }, (_, i): [string, string] => [`cohost${i + 1}`, `c${i}`]),
        ...(c ? [['hosts', 'c0'] as [string, string], ['panel', ''] as [string, string]] : []),
        ...Array.from({ length: n }, (_, i): [string, string] => [n > 1 ? `guest${i + 1}` : 'guest', `g${i}`]),
        ['two', 'g0'], ['ots', 'g0'], ['sidekick', 'sidekick'], ['push', 'host'], ['reverse', 'host'], ...Array.from({ length: n }, (_, i): [string, string] => ['push', `g${i}`]),
        ...Array.from({ length: c }, (_, i): [string, string] => ['reverse', `c${i}`])];
    }
    const next = this.warmList.shift();
    if (next) this.poseFor(next[0], next[1]);
  }

  private get skyOk() { const j = this.rt!.info as unknown as Record<string, unknown>; return !!(j.environment || j.epoch || j.town || j.space); }
  private get voidOk() { const j = this.rt!.info as unknown as Record<string, unknown>; return !!(j.epoch || j.space); }

  /** Pose for a director shot (falls back to the establishing wide / the room's wide). `via`: the other person the shot
   *  is built on (over the shoulder: a co-host's shoulder; `hosts`: which co-host). */
  poseFor(shot: ShotId | string, subject: string, via?: string, x?: { cam?: string; aud?: 'r' | 'w' | 'a'; ak?: string }): { pose: CamPose; key: string } | null {
    const rt = this.rt, g = this.geom, book = this.book;
    if (!rt || !g || !book) return null;
    if (shot === 'wide') {
      // (cue v3: a room camera / the audience / the room wide - src/scene/talkshow/cueShots.ts)
      const w = widePoseFor(x ?? {}, { aspect: rt.stage.camera.aspect || 16 / 9, roomWide: () => ({ key: 'wide', pose: rt.resolveCamera('wide').pose }), camera: (n) => (rt.room.cameras.has(n) ? rt.resolveCamera(n) : null), audience: audienceShots });
      return { pose: w.pose, key: w.key };
    }
    let s = shot, sub = subject;
    const isCo = (x: string) => /^c\d$/.test(x);
    const coOn = (x: string) => !!g.cohosts?.[+x.slice(1)];
    if (shot === 'snap') {
      // tighter on the subject from their single's camera
      const base = this.singleOf(sub);
      const at = this.subjectPoint(sub);
      if (!base || !at) return base;
      const sp = snapPose(base.pose, at, 0.52);
      const mon = /^g\d$/.test(sub) ? !this.geom?.guests[+sub.slice(1)]?.seat : isCo(sub) ? !this.geom?.cohosts?.[+sub.slice(1)]?.seat : false;
      return { pose: mon ? this.limitFill(sp) : sp, key: `snap:${sub}:${base.key}` };
    }
    // co-host single = the host single's solve on them; hosts = a two-shot of the host + a co-host; panel = all hosts
    const co = /^cohost([12])$/.exec(shot);
    if (co) { sub = `c${+co[1] - 1}`; s = coOn(sub) ? 'host' : 'establishing'; }
    if (shot === 'hosts') { sub = via && isCo(via) ? via : isCo(subject) ? subject : 'c0'; s = coOn(sub) ? 'two' : 'host'; if (s === 'host') sub = 'host'; }
    if (shot === 'panel') { s = g.cohosts?.length ? 'panel' : 'host'; sub = s === 'panel' ? '' : 'host'; }
    // (the two-shot is the host + a guest: after a co-host's shot it pairs the host with the guest, not the co-host; two seated
    // guests - subject + via: the two of them. An older page ignores via: host + the first guest)
    if (shot === 'two' && isCo(sub)) sub = 'host';
    if (shot === 'two' && /^g\d$/.test(sub) && via && /^g\d$/.test(via) && via !== sub && g.guests[+sub.slice(1)]?.seat && g.guests[+via.slice(1)]?.seat) sub = `${sub}@${via}`;
    if (shot === 'push') { s = sub === 'host' || sub === 'sidekick' || isCo(sub) ? 'push' : 'guestPush'; if (sub === 'sidekick') s = 'sidekick'; }
    if (/^guest\d$/.test(shot) && g.guests.length <= 1) s = 'guest';
    // ('gv' = several callers the director can't tell apart: the whole monitor)
    if ((s === 'guest' || s === 'guestPush') && sub === 'gv') sub = 'all';
    else if (s === 'guest' && !/^g\d$/.test(sub)) sub = 'g0';
    if (shot === 'ots' && via && isCo(via) && coOn(via) && g.cohosts?.[+via.slice(1)]?.seat) sub = `${/^g\d$/.test(sub) ? sub : 'g0'}@${via}`;
    const sig = this.geomSig;
    const r = book.get(s, sub, g, sig) ?? book.get('establishing', '', g, sig);
    if (!r) return { pose: rt.resolveCamera('wide').pose, key: 'wide' };
    // shots about the monitor's picture leave room for the docked ticker
    const onMonitor = ((s === 'guest' || s === 'guestPush' || /^guest\d$/.test(s)) && !(g.guests[+(sub.slice(1) || 0)]?.seat))
      || ((s === 'host' || s === 'push') && isCo(sub) && !g.cohosts?.[+sub.slice(1)]?.seat);
    return { pose: onMonitor ? this.limitFill(r.pose) : r.pose, key: `${s}:${sub}` };
  }

  /** A person's own single (the pose a push-in or a snap zoom starts from). */
  private singleOf(sub: string): { pose: CamPose; key: string } | null {
    return this.poseFor(sub === 'sidekick' ? 'sidekick' : sub === 'host' ? 'host' : /^c\d$/.test(sub) ? `cohost${+sub.slice(1) + 1}` : `guest${+sub.slice(1) + 1}`, sub);
  }

  /** The show's own close-up of a member (slap gags, …): their single — the host, a co-host, a guest (seat / panel). */
  poseOfKey(key: string): { pose: CamPose; key: string; monitor: boolean } | null {
    if (key === HOST_KEY) { const p = this.poseFor('host', 'host'); return p ? { ...p, monitor: false } : null; }
    const x = this.lineup.find((q) => q.g.key === key);
    if (!x) return null;
    const p = this.poseFor(singleShotOf(x, this.lineup.filter((q) => q.role === 'guest').length), x.id);
    return p ? { ...p, monitor: !x.seated && x.panel >= 0 } : null;
  }

  /** The docked chat / support panels' hard keep-outs this frame (stage-mode hook `keepOut`, fractions of the frame):
   *  the monitor's picture (all panels, its live corners — arriving, swinging, flickering in), every projector screen in
   *  the room, the faces of the host / seated guests / the sidekick, each with a margin; the show-open card = the
   *  whole frame. Projected with the camera as it renders THIS frame (cuts, push-ins and snap zooms included). */
  keepOut(aspect: number): { x: number; y: number; w: number; h: number }[] {
    const rt = this.rt;
    if (!rt || !this.built) return [];
    const cur = this.opts.curtain as { active?: boolean } | null | undefined;
    if (cur?.active) return [{ x: 0, y: 0, w: 1, h: 1 }];
    const cam = rt.stage.camera;
    cam.updateMatrixWorld();
    const out: { x: number; y: number; w: number; h: number }[] = [];
    const m = 0.014, mx = m / Math.max(0.5, aspect) * (16 / 9);
    const addPts = (pts: THREE.Vector3[]) => {
      const v = pts.map((p) => p.clone().applyMatrix4(cam.matrixWorldInverse));
      const zc = -cam.near;                                               // (points ON the near plane project fine: w = near)
      if (v.every((q) => q.z > zc)) return;                              // all behind the camera
      // a quad passing beside / behind the lens (a projector screen next to the camera): clip it to the near plane
      // (Sutherland–Hodgman) — the drawn part is inside the projected clipped polygon, so its box is still conservative
      const c: THREE.Vector3[] = [];
      for (let i = 0; i < v.length; i++) {
        const a = v[i], b = v[(i + 1) % v.length], ain = a.z <= zc, bin = b.z <= zc;
        if (ain) c.push(a);
        if (ain !== bin) c.push(a.clone().lerp(b, (zc - a.z) / (b.z - a.z)));
      }
      if (c.length < 2) return;
      const s = c.map((q) => q.clone().applyMatrix4(cam.projectionMatrix));
      const xs = s.map((q) => (q.x + 1) / 2), ys = s.map((q) => (1 - q.y) / 2);
      const x0 = Math.min(...xs) - mx, x1 = Math.max(...xs) + mx, y0 = Math.min(...ys) - m, y1 = Math.max(...ys) + m;
      if (x1 < 0 || x0 > 1 || y1 < 0 || y0 > 1) return;
      out.push({ x: Math.max(0, x0), y: Math.max(0, y0), w: Math.min(1, x1) - Math.max(0, x0), h: Math.min(1, y1) - Math.max(0, y0) });
    };
    // the monitor's picture (every panel is inside it)
    if (this.monitor?.shown) addPts(this.monitor.liveCorners());
    // projector screens (tvguests' projector look) of anyone in the room
    for (const a of rt.actors.values()) {
      const r = a.runtime as unknown as { look?: string; screen?: THREE.Mesh } | null;
      if (r?.look !== 'projector' || !r.screen || !a.mount.visible) continue;
      const sm = r.screen;
      sm.updateWorldMatrix(true, false);
      sm.geometry.computeBoundingBox();
      const b = sm.geometry.boundingBox!;
      addPts([[b.min.x, b.max.y], [b.max.x, b.max.y], [b.max.x, b.min.y], [b.min.x, b.min.y]].map(([x, y]) => new THREE.Vector3(x, y, 0).applyMatrix4(sm.matrixWorld)));
    }
    // faces the show frames: the host, seated guests, the sidekick (a head-sized box)
    const g = this.geom;
    const heads = [g?.host, g?.sidekick, ...(g?.cohosts?.map((x) => x.seat) ?? []), ...(g?.guests.map((x) => x.seat) ?? [])].filter((h): h is Head => !!h);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    for (const h of heads) {
      const r = Math.max(h.size * 1.4, h.top * 0.9);
      const c = h.face.clone().addScaledVector(new THREE.Vector3(0, 1, 0), r * 0.15);
      addPts([c.clone().addScaledVector(right, -r).addScaledVector(up, r * 1.1), c.clone().addScaledVector(right, r).addScaledVector(up, r * 1.1), c.clone().addScaledVector(right, r).addScaledVector(up, -r), c.clone().addScaledVector(right, -r).addScaledVector(up, -r)]);
    }
    return out;
  }

  /** Monitor-dominant shots always leave a clear band (≥ `band` of the frame height) above or below the picture, so the
   *  docked chat / support ticker always has a place that never covers the picture (the lens widens if needed). */
  private limitFill(pose: CamPose, band = 0.11): CamPose {
    const m = this.monitor;
    if (!m) return pose;
    const aspect = this.rt?.stage.camera.aspect || 16 / 9;
    let p = pose;
    for (let k = 0; k < 12; k++) {
      const cam = new THREE.PerspectiveCamera(p.fov, aspect, 0.03, 500);
      cam.position.copy(p.position); cam.quaternion.copy(p.quaternion); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
      const s = m.corners().map((c) => c.project(cam));
      if (s.some((q) => q.z > 1)) return p;
      const y0 = Math.min(...s.map((q) => (1 - q.y) / 2)), y1 = Math.max(...s.map((q) => (1 - q.y) / 2));
      if (Math.max(y0, 1 - y1) >= band + 0.014 || p.fov > 70) return p;
      const t = Math.tan(THREE.MathUtils.degToRad(p.fov) / 2) * 1.07;
      p = { position: p.position.clone(), quaternion: p.quaternion.clone(), fov: THREE.MathUtils.radToDeg(2 * Math.atan(t)) };
    }
    return p;
  }

  private subjectPoint(sub: string): THREE.Vector3 | null {
    const g = this.geom;
    if (!g) return null;
    if (sub === 'host') return g.host?.face ?? null;
    if (sub === 'sidekick') return g.sidekick?.face ?? null;
    if (sub === 'gv') return g.monitor?.center ?? null;
    const m = /^([gc])(\d)$/.exec(sub);
    if (!m) return null;
    const x = m[1] === 'c' ? g.cohosts?.[+m[2]] : g.guests[+m[2]];
    if (x?.seat) return x.seat.face;
    if (x && x.panel >= 0 && g.monitor) return g.monitor.panels[x.panel]?.center ?? g.monitor.center;
    return g.monitor?.center ?? null;
  }

  /** Where the sidekick looks: the speaker (host face / the monitor / a seated guest). */
  private lookPoint(s: DirectorShot): THREE.Vector3 | null {
    const sub = s.subject && s.subject !== 'sidekick' ? s.subject : 'host';
    return this.subjectPoint(sub);
  }

  private resolveOnAir(s: DirectorShot, _aspect: number) {
    const p = this.poseFor(s.shot, s.subject, s.via, s);
    if (!p) { this.onAir = null; return; }
    // (a named move is another shot than the same camera held: the rig must start a move)
    const key = `iv:${p.key}${s.mv ? `~${s.mv}` : ''}`;
    // a shot on air keeps its pose until the next cut (a re-solve — the monitor landed, the sidekick loaded — never
    // jumps the camera in the middle of a shot)
    if (this.onAir && this.onAir.shot === s && this.onAir.base === key) {
      if (this.onAir.sig === this.geomSig) return;
      const moved = this.onAir.raw.position.distanceTo(p.pose.position) > 0.05 || Math.abs(this.onAir.raw.fov - p.pose.fov) > 0.5;
      this.onAir.sig = this.geomSig;
      if (!moved) return;
      this.onAir = { key: `${key}#${++this.reframes}`, base: key, sig: this.geomSig, pose: moveOf({ secs: 0 }, p.pose, {}).pose, raw: p.pose, secs: 1.1, shot: s };
      return;
    }
    // timed moves: a push-in (6.5 s), cue v3's crane / pull (CRANE_SECS / PULL_SECS, cue secs 0) - where it starts from, and how far
    // in when this page took the cut late (cue.at): every page shows the same pose at the same moment of the move
    // (a crane / pull is clamped against the room's own surfaces: the same RoomRays on every page, so every page ends on the same pose)
    const mv = moveOf(s, p.pose, { single: s.shot === 'push' && s.at ? this.singleOf(s.subject)?.pose ?? null : null, focus: this.subjectPoint('host'), ...(this.rays ? { reach: reachOf(this.rays) } : {}) });
    // (a cut to the same person from nearly the same place would be a jump cut: a short move instead - a pure function of the two poses,
    // so every page that saw both shots does the same; the operator's own cuts stay cuts)
    const prev = this.onAir;
    const soft = mv.secs === 0 && !mv.from && !s.mv && !/operator/.test(s.why) ? softCutSecs(prev?.pose ?? null, mv.pose, !!prev && !!s.subject && prev.shot.subject === s.subject) : 0;
    // (and a timed move that would carry the camera across the set is a cut: no flights)
    const secs = soft || (mv.from ? mv.secs : noFlight(mv.secs, !!s.mv, prev?.pose ?? null, mv.pose));
    this.onAir = { key, base: key, sig: this.geomSig, pose: mv.pose, raw: p.pose, secs, shot: s, ...(mv.from ? { from: mv.from } : {}), ...(mv.t0 ? { t0: mv.t0 } : {}) };
  }

  /** SceneRuntime.cameraOverride: room events first (a riot, a big-donation raid), then the director's shot. The OBS
   *  hole closes before the camera leaves a hole shot. */
  private cameraShot(aspect: number): { key: string; pose: CamPose; secs: number; from?: CamPose; t0?: number } | null {
    const ev = this.prevOverride?.(aspect) ?? null;
    // (a page following a v3 studio that cues the asker itself (cue `ac`): the audience engine's own asker close-up stands down - the
    // studio's director cues it; a room the studio's director has no audience for (the audience is GLB nodes only) keeps the close-up)
    if (ev && !(this.askerStandDown && ev.key.startsWith('audience:asker:'))) return ev;
    // the show's director cuts in Interview mode only: a page that has been switched to Talk (or whose mode hook has not
    // detached the engine yet) never carries a leftover interview shot into it
    if (this.rt && this.rt.state.mode !== 'interview') return null;
    const cur = this.onAir;
    if (!cur) return null;
    if (this.held && this.held.key !== cur.key && (this.monitor?.open ?? 0) > 0) return this.held;   // wait for the hole to close
    this.held = { key: cur.key, pose: cur.pose, secs: cur.secs, ...(cur.from ? { from: cur.from } : {}), ...(cur.t0 ? { t0: cur.t0 } : {}) };
    return this.held;
  }

  /** Studio "Fit my Window Capture" helper: the monitor panel's projected corners in that panel's close-up.
   *  `panelGuest` = the video guest's index in the line-up (bag.guests). */
  fitInfo(panelGuest: number, aspect = 16 / 9): { rect: { x: number; y: number; w: number; h: number }; quad: [number, number][] } | null {
    const m = this.monitor;
    if (!m) return null;
    const n = Math.max(1, this.lineup.filter((x) => x.panel >= 0).length);
    const slot = this.lineup.find((x) => x.i === panelGuest);
    if (!slot || slot.role !== 'guest') return null;
    const pi = slot.panel >= 0 ? slot.panel : 0;
    const gc = this.lineup.filter((x) => x.role === 'guest').length;
    const p = this.poseFor(gc > 1 ? `guest${slot.n}` : 'guest', slot.id);
    if (!p) return null;
    const cam = new THREE.PerspectiveCamera(p.pose.fov, aspect, 0.03, 500);
    cam.position.copy(p.pose.position); cam.quaternion.copy(p.pose.quaternion); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    const quad = m.quad(cam, n > 1 ? pi : -1, n);
    const xs = quad.map((q) => q[0]), ys = quad.map((q) => q[1]);
    return { rect: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }, quad };
  }

  /** Test / debug. */
  debug() {
    return {
      room: this.rt?.info.id ?? null, theme: this.theme, built: this.built,
      shot: this.onAir ? { key: this.onAir.key, ...this.onAir.shot } : null,
      monitor: this.monitor ? { style: this.monitor.style, a: +this.monitor.a.toFixed(2), power: +this.monitor.power.toFixed(2), open: +this.monitor.open.toFixed(2), w: this.monitor.W } : null,
      layout: this.layoutNotes, remote: this.remote?.keys() ?? [], sidekick: this.sidekick ? { ready: this.sidekick.ready, failed: this.sidekick.failed } : null,
      lineup: this.lineup.map((x) => ({ i: x.i, id: x.id, name: x.g.name, key: x.g.key ?? null, kind: x.kind, role: x.role, n: x.n, place: x.place, panel: x.panel, seated: x.seated, spot: x.a?.spot?.name ?? null, ...(x.overflow ? { overflow: true } : {}) })),
      cohostSeats: this.coSeats.map((c) => ({ how: c.seat.how, spot: c.spot.name, index: c.spot.index, pos: c.spot.position.toArray().map((v) => +v.toFixed(2)) })),
      desk: this.desk ? { width: +((this.desk.root.userData.width as number | undefined) ?? 0).toFixed(2) } : null,
      director: this.director ? this.director.log.slice(-12) : [], following: this.following, cue: this.cueIn ? { ...this.cueIn.c, ageMs: Math.round(performance.now() - this.cueIn.rx) } : null,
      why: this.director?.explain() ?? null, voices: this.voices.state(), shots: this.book?.info().slice(-12) ?? [], cost: { ...this.stats, ms: +this.stats.ms.toFixed(3), peak: +this.stats.peak.toFixed(2) },
    };
  }
}

void UP;
