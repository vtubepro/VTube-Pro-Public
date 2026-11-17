// AFK / starting-soon cinematic director + chatter names on ships (docs/SCENES.md "AFK cinematic director").
//
// While the host's SceneState.afk is on (Talk mode), the camera cycles the room's cinematic shots on a host-seeded
// schedule and cuts to EVENT SHOTS when something happens that a camera sees: a ship touching down on a pad or lifting
// off (sky traffic: the pad cycles are closed-form, src/scene/traffic/flights.ts), a kill in the room's baked battle (the
// pop-in of an *EXPLOSION* node in a room clip: moments.ts). Event shots use a room camera that sees it, a chase camera
// behind the landing / launching ship, an over-the-shoulder shot from one of our own craft in the same battle group, or a
// live (moving) camera preset of that group when the room has one (a preset flagged `live` — used when present, never required).
// Sky-traffic ships (and room craft named after them) carry chatter names ("Skiff · Maple") from the host-stamped
// crew list: shipTags.ts. The optional title card ("BE RIGHT BACK") is overlay.ts.
//
// Sync: every decision is a pure function of (SceneState.afk seed / epoch / crew, room data, the wall clock) — the same
// clock base as sky traffic and room clips (shared/afk.ts) — so every OBS page, the Scene-tab preview and party guests cut
// to the same shot at the same moment. Where a camera can see a pad / a moment is measured once per room with room rays
// (time-sliced ≈ 1 ms per frame, never more than one pose of the room clips in a slice); until that finishes a page only
// shows the ordinary cycle.
//
// Priority: the entrance follow-cam, then the raid / kitchen directors this one wraps (cameraOverride chain: they're
// asked first), then AFK. Interview / TTRPG modes aren't Talk, so AFK never competes with them. Leaving AFK is a cut.
// Cost: off = one check per frame. On: ≈ 0.02–0.1 ms per frame (+ the one-off visibility plan, spread over frames).
import * as THREE from 'three';
import type { SceneRuntime } from '../SceneRuntime.ts';
import type { TrafficScene } from '../traffic/trafficScene.ts';
import type { ShipPose, TrafficEvent } from '../traffic/flights.ts';
import type { TrafficCfg, ShipMeta } from '../traffic/config.ts';
import { lookPose, type CamPose } from '../cameraRig.ts';
import type { CameraPreset, RoomInfo } from '../contract.ts';
import { RoomRays } from '../twoShot.ts';
import { roomClock } from '../roomClips.ts';
import {
  AFK_PACE, AfkCycle, DEFAULT_AFK_STATE, afkNamesOn, afkPick, afkRand, afkTitle, crewNameFor, sanitizeAfkState, takeEvents,
  type AfkDrift, type AfkEvent, type AfkFlight, type AfkMomentKind, type AfkPick, type RoomAfkConfig, type RoomShipNamesConfig, type SceneAfkState,
} from '../../../shared/afk.ts';
import { collectMoments, measureMoment, occurrences, type ClipMoment } from './moments.ts';
import { ShipTags, type TagAvoid, type TagSpec } from './shipTags.ts';
import { AfkOverlay } from './overlay.ts';

const UP = new THREE.Vector3(0, 1, 0);
const DAY = 86400000;
/** Decisions are made for a 16:9 frame on every page (like the raid director). */
const ASPECT = 16 / 9;
const KIND_WEIGHT: Record<AfkMomentKind, number> = { kill: 1, dies: 1, land: 0.9, launch: 0.8, moment: 0.6 };
/** Cameras that are never part of the cycle (screens, doors, other systems' cinematic cameras: the raid / cryo / drop-pod
 *  entrances, the kitchen riot, the tabletop mode's table / dice / GM shots, a game's spectator cameras). A room can still
 *  list any of them in scene.json afk.shots. */
const NOT_CYCLE = /^(CAM_REACT|CAM_DOOR|CAM_RAID|CAM_CRYO|CAM_DROPBAY|CAM_TAGILLA|CAM_RIOT|CAM_DICE|CAM_GM|CAM_HANDOUT|CAM_TABLE_|CAM_SPECT_)/;

interface Shot { id: string; preset: CameraPreset; weight: number; hold: [number, number]; drift: AfkDrift; live: boolean }
interface Craft { id: string; node: THREE.Object3D; label: string; period: number; radius: number; length: number; group: THREE.Object3D | null }
interface CamScore { name: string; score: number }
type Option =
  | { k: 'cam'; name: string; q: number }
  | { k: 'chase'; key: string; ship: string; L: number; q: number }
  | { k: 'ots'; craft: Craft; target: THREE.Vector3; q: number };
interface Ev extends AfkEvent { opt: Option; label: string }

/** Test pages only (output.html?sceneTest=<room>): &afk=on,brb|soon,always|nonames,calm|snappy,noevents &afkSeed=<n>
 *  &afkAt=<s into it> &crew=Name1,Name2 → the SceneState.afk the page starts with. */
export function afkTestState(q: URLSearchParams): SceneAfkState {
  const a = (q.get('afk') || '').split(',');
  return sanitizeAfkState({ on: a.includes('on'), seed: parseInt(q.get('afkSeed') || '7', 10), epoch: Date.now() - parseFloat(q.get('afkAt') || '0') * 1000,
    overlay: a.includes('brb') ? 'brb' : a.includes('soon') ? 'soon' : 'off', names: a.includes('always') ? 'always' : a.includes('nonames') ? 'off' : 'afk', events: !a.includes('noevents'),
    pace: a.includes('calm') ? 'calm' : a.includes('snappy') ? 'snappy' : 'normal', crew: (q.get('crew') || '').split(',').filter(Boolean).map((n) => ({ n, at: Date.now() - 3600_000 })) });
}

// (live cameras are the presets the room flags `live`: found by the flag, never by a name, so AFK works whether or not
//  the live-camera feature is in this build)
const isLive = (p: CameraPreset) => !!(p as { live?: unknown }).live;
const liveNode = (p: CameraPreset) => ((p as { live?: { node?: THREE.Object3D } }).live?.node ?? null);
const cap = (s: string) => s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

export class AfkScene {
  private rt: SceneRuntime | null = null;
  private cfg: RoomAfkConfig = {};
  private ncfg: RoomShipNamesConfig = {};
  private shots: Shot[] = [];
  private crafts: Craft[] = [];
  private rays: RoomRays | null = null;
  private moments: ClipMoment[] = [];
  private padCams = new Map<number, CamScore[]>();
  private momentCams = new Map<number, { cams: CamScore[]; ots: { craft: Craft; q: number } | null; live: string[] }>();
  private job: Generator<'pose' | void, void, void> | null = null;
  private planned = false;
  private planMs = 0;
  /** The plan posed the room clips at other times: they are put back at the room clock before the frame is drawn. */
  private clipsDirty = false;
  private cycle: AfkCycle | null = null;
  private cycleKey = '';
  private evCache: { key: string; t0: number; t1: number; evs: Ev[]; taken: Ev[] } | null = null;
  private chaseOk = new Map<string, boolean>();
  private names = new Map<string, string | null>();
  private nameMemo = new Map<string, string | null>();
  private namesKey = '';
  private prevOverride: SceneRuntime['cameraOverride'] = null;
  private myOverride: SceneRuntime['cameraOverride'] = null;
  private cur: { key: string; pick: AfkPick<Ev> } | null = null;
  private lastDt = 1 / 60;
  private tagFrame = -1;
  private frameNo = 0;
  private perf = { avg: 0, peak: 0 };
  readonly tags = new ShipTags();
  readonly overlay = new AfkOverlay();
  /** Test pages: time only advances through update() (ms). */
  manual = false;
  clock = Date.now();

  constructor(private traffic: TrafficScene | null = null) {}

  now() { return this.manual ? this.clock : Date.now(); }
  private get st(): SceneAfkState { return this.rt?.state.afk ?? DEFAULT_AFK_STATE; }
  /** Is the director cutting right now? */
  get active(): boolean {
    const rt = this.rt;
    return !!rt && this.st.on && rt.state.mode === 'talk' && !rt.composite && this.shots.length > 0;
  }

  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    this.rt = rt;
    const info = rt.info as unknown as { afk?: RoomAfkConfig; shipNames?: RoomShipNamesConfig };
    this.cfg = info.afk && typeof info.afk === 'object' ? info.afk : {};
    this.ncfg = info.shipNames && typeof info.shipNames === 'object' ? info.shipNames : {};
    this.tags.setStyle(this.ncfg.style);
    this.tags.maxDistance = typeof this.ncfg.maxDistance === 'number' && this.ncfg.maxDistance > 10 ? this.ncfg.maxDistance : 1200;
    rt.root.add(this.tags.group);
    this.shots = this.buildShots(rt);
    this.crafts = this.findCrafts(rt);
    const hook = rt as unknown as { cameraOverride: SceneRuntime['cameraOverride'] };
    this.prevOverride = hook.cameraOverride;
    // the directors attached before (raid / kitchen) keep priority: asked first, AFK fills in when they have no shot
    this.myOverride = (aspect: number) => this.prevOverride?.(aspect) ?? this.shot();
    hook.cameraOverride = this.myOverride;
    if (this.traffic) this.traffic.onFrame = (t, poses) => this.trafficFrame(t, poses);
    // (where the cameras see things is measured the first time AFK is on in this room — nothing for rooms never used)
  }

  detach() {
    const rt = this.rt;
    if (rt) {
      const hook = rt as unknown as { cameraOverride: SceneRuntime['cameraOverride'] };
      if (hook.cameraOverride === this.myOverride) hook.cameraOverride = this.prevOverride;
    }
    if (this.traffic?.onFrame) this.traffic.onFrame = null;
    this.tags.clear();
    this.tags.group.removeFromParent();
    this.overlay.set('', '');
    this.rt = null; this.prevOverride = null; this.myOverride = null;
    this.shots = []; this.crafts = []; this.moments = []; this.padCams.clear(); this.momentCams.clear();
    this.rays = null; this.job = null; this.planned = false; this.clipsDirty = false; this.cycle = null; this.cycleKey = ''; this.evCache = null;
    this.chaseOk.clear(); this.names.clear(); this.nameMemo.clear(); this.namesKey = ''; this.cur = null; this.tagFrame = -1;
  }

  // ---------------------------------------------------------------- the room's shots
  private buildShots(rt: SceneRuntime): Shot[] {
    const cams = rt.room.cameras;
    const cfg = this.cfg;
    const hold: [number, number] = Array.isArray(cfg.hold) && cfg.hold.length === 2 && cfg.hold.every((v) => typeof v === 'number' && v > 0)
      ? [Math.max(3, Math.min(cfg.hold[0], cfg.hold[1])), Math.min(60, Math.max(cfg.hold[0], cfg.hold[1]))] : [7, 12];
    const exclude = new Set((cfg.exclude ?? []).filter((x) => typeof x === 'string'));
    const live = cfg.includeLive !== false;
    const driftOn = cfg.drift !== false;
    const mk = (p: CameraPreset, o: { weight?: number; hold?: [number, number]; drift?: AfkDrift } = {}): Shot => {
      const lv = isLive(p);
      const pick: AfkDrift[] = ['push', 'pull', 'push', 'pan'];
      const drift = !driftOn || lv ? 'none' : o.drift && ['push', 'pull', 'pan', 'none'].includes(o.drift) ? o.drift : pick[Math.floor(afkRand(p.name, 'drift') * pick.length)];
      const hd = Array.isArray(o.hold) && o.hold.length === 2 ? [Math.max(3, o.hold[0]), Math.max(o.hold[0], o.hold[1])] as [number, number] : hold;
      return { id: p.name, preset: p, weight: typeof o.weight === 'number' && o.weight > 0 ? Math.min(4, o.weight) : 1, hold: hd, drift, live: lv };
    };
    if (Array.isArray(cfg.shots) && cfg.shots.length) {
      const out: Shot[] = [];
      for (const s of cfg.shots) {
        const name = typeof s === 'string' ? s : s && typeof s === 'object' ? s.cam : null;
        const p = name ? cams.get(name) : undefined;
        if (!p || exclude.has(p.name) || (!live && isLive(p))) continue;
        out.push(mk(p, typeof s === 'object' ? s : {}));
      }
      return out;
    }
    // default: every CAM_* but the tight ones (a performer's face big in frame) and other systems' cameras
    const out: Shot[] = [];
    for (const p of cams.values()) {
      if (!/^CAM_/.test(p.name) || NOT_CYCLE.test(p.name) || exclude.has(p.name) || (!live && isLive(p))) continue;
      if (!isLive(p) && this.tight(rt, p)) continue;
      out.push(mk(p));
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** How big the biggest performer's face (a seat's face height) is in this camera's frame, as a share of its height. */
  private faceShare(rt: SceneRuntime, p: CameraPreset): number {
    const h = rt.info.avatarHeight ?? 1.5;
    const tanH = Math.tan(THREE.MathUtils.degToRad(p.fov) / 2);
    const inv = p.quaternion.clone().invert();
    let best = 0;
    for (const s of rt.room.spots) {
      if (!s) continue;
      const face = s.position.clone().addScaledVector(UP, s.pose === 'sit' ? s.seatHeight + h * 0.5 : h * 0.92);
      const v = face.sub(p.position).applyQuaternion(inv);
      const d = -v.z;
      if (d < 0.2) continue;
      if (Math.abs(v.y / d) > tanH * 0.85 || Math.abs(v.x / d) > tanH * ASPECT * 0.85) continue;
      best = Math.max(best, (0.24 * (h / 1.5)) / (2 * d * tanH));
    }
    return best;
  }
  /** A camera whose frame a performer's face would fill more than a loose medium shot (≥ 12 % of the height). */
  private tight(rt: SceneRuntime, p: CameraPreset): boolean { return this.faceShare(rt, p) >= 0.12; }

  /** Our own craft in the room: scene.json shipNames.craft, else nodes named after one of the room's traffic ships. */
  private findCrafts(rt: SceneRuntime): Craft[] {
    const root = rt.room.root;
    const tcfg = (rt.info as unknown as { traffic?: TrafficCfg }).traffic;
    const spec = this.ncfg.craft;
    if (spec === false) return [];
    const clips = rt.clips?.list ?? [];
    const period = new Map<string, number>();
    for (const c of clips) for (const tr of c.tracks) { const n = THREE.PropertyBinding.parseTrackName(tr.name).nodeName; if (!period.has(n)) period.set(n, c.duration); }
    const classes = this.ncfg.classes ?? {};
    const labelOf = (id: string) => (typeof classes[id] === 'string' ? classes[id].slice(0, 24) : cap(id));
    const list: { node: THREE.Object3D; label: string }[] = [];
    if (Array.isArray(spec)) {
      for (const c of spec) {
        const name = typeof c === 'string' ? c : c?.node;
        const node = name ? root.getObjectByName(name) ?? root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name)) : null;
        if (!node) continue;
        const lbl = typeof c === 'object' && typeof c.label === 'string' ? c.label.slice(0, 24) : null;
        list.push({ node, label: lbl ?? this.guessClass(node.name, tcfg, labelOf) ?? cap(node.name.replace(/^[A-Z]+_/, '').toLowerCase()) });
      }
    } else if (tcfg) {
      const seen = new Set<THREE.Object3D>();
      root.traverse((o) => {
        if (!o.name || /^(SHIP_|CAM_|LIGHT_|SPOT_|TRAFFIC_|PATROL_|BG_|COLLIDE_|EVENT_|ALERT_)/.test(o.name)) return;   // (ALERT_* = the support-alert set pieces and their smoke puffs: list them in shipNames.craft to name them)
        for (let p = o.parent; p; p = p.parent) if (seen.has(p)) return;              // (a craft's own parts / LODs)
        const lbl = this.guessClass(o.name, tcfg, labelOf);
        if (!lbl) return;
        let mesh = false;
        o.traverse((c) => { if ((c as THREE.Mesh).isMesh) mesh = true; });
        if (!mesh) return;
        seen.add(o);
        list.push({ node: o, label: lbl });
      });
    }
    return list.slice(0, 32).map(({ node, label }) => {
      // measured at full size (a clip may have it popped out, scale 0, right now)
      const keep = node.scale.clone();
      node.scale.set(1, 1, 1); node.updateWorldMatrix(true, true);
      const box = new THREE.Box3().setFromObject(node, true);
      node.scale.copy(keep); node.updateWorldMatrix(true, true);
      const size = box.isEmpty() ? new THREE.Vector3(12, 4, 12) : box.getSize(new THREE.Vector3());
      const len = Math.max(4, Math.min(160, Math.max(size.x, size.z)));
      // (a looping craft gets a new name each loop — ≥ 20 s so it can be read; a static one every 5 minutes)
      return { id: node.name, node, label, period: Math.max(20, period.get(node.name) ?? 300), radius: Math.max(2, len * 0.45), length: len, group: groupOfNode(node, root) };
    });
  }

  /** "BTL_G1_SKIFF_A" → "Skiff" when the room flies skiffs (the id, or its first 4+ letters, as a name token). */
  private guessClass(name: string, tcfg: TrafficCfg | undefined, labelOf: (id: string) => string): string | null {
    if (!tcfg) return null;
    const ids = new Set<string>();
    for (const v of Object.values(tcfg.classes ?? {})) for (const id of v) ids.add(id);
    for (const l of tcfg.lanes ?? []) for (const id of (l.ships ?? '').split(',')) if (id.trim()) ids.add(id.trim());
    for (const p of tcfg.parked ?? []) ids.add(p.ship);
    const toks = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    for (const id of ids) {
      const k = id.toLowerCase();
      if (k.length < 4) continue;
      if (toks.some((t) => t === k || (t.length >= 4 && k.startsWith(t)))) return labelOf(id);
    }
    return null;
  }

  // ---------------------------------------------------------------- where cameras see things (once per room)
  private roomRays(rt: SceneRuntime): RoomRays {
    if (this.rays) return this.rays;
    // glass, additive FX and everything a room clip moves don't block a view (the battle flies through them)
    const moving = new Set<string>();
    for (const c of rt.clips?.list ?? []) for (const tr of c.tracks) moving.add(THREE.PropertyBinding.parseTrackName(tr.name).nodeName);
    const solid = rt.room.occluders.filter((m) => {
      for (let p: THREE.Object3D | null = m; p; p = p.parent) if (moving.has(p.name)) return false;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      return !mats.some((x) => !x || x.transparent || (x.opacity ?? 1) < 0.99 || x.blending === THREE.AdditiveBlending || /^(ADD_|GLASS|M_Glass|FX_)/i.test(x.name ?? '')) && !/GLASS|WINDOW/i.test(m.name);
    });
    this.rays = new RoomRays({ occluders: solid, colliders: [] } as unknown as RoomInfo);
    return this.rays;
  }

  /** How well a fixed camera sees these points (0 = not all of them): in the middle 80 % of a 16:9 frame, a clear line,
   *  a readable size for something `size` m big. */
  private sees(p: CameraPreset, pts: THREE.Vector3[], size: number, rays: RoomRays): number {
    const tanH = Math.tan(THREE.MathUtils.degToRad(p.fov) / 2);
    const inv = p.quaternion.clone().invert();
    let q = 1;
    for (const pt of pts) {
      const v = pt.clone().sub(p.position).applyQuaternion(inv);
      const d = -v.z;
      if (d < 2) return 0;
      const nx = v.x / (d * tanH * ASPECT), ny = v.y / (d * tanH);
      if (Math.abs(nx) > 0.8 || Math.abs(ny) > 0.8) return 0;
      if (!rays.clear(p.position, pt)) return 0;
      const a = size / (2 * d * tanH);
      const s = a < 0.05 ? 0 : a < 0.12 ? a / 0.12 : a > 0.95 ? 0.45 : 1;
      q = Math.min(q, s * (1 - 0.3 * Math.max(Math.abs(nx), Math.abs(ny))));
    }
    return q;
  }

  /** The one-off visibility plan. `yield` = a slice may end here; `yield 'pose'` = the next step poses every room clip (the
   *  expensive unit): the pump starts it at the top of a frame's slice, never after other work. */
  private *plan(): Generator<'pose' | void, void, void> {
    const rt = this.rt!;
    const rays = this.roomRays(rt);
    // (never a close-up of a performer — a kill behind the host's head isn't an event shot)
    const cams = [...rt.room.cameras.values()].filter((p) => !isLive(p) && !/^(CAM_REACT|CAM_DOOR)$/.test(p.name) && !this.tight(rt, p));
    // (a camera with a performer big in the foreground is a weaker view of the action)
    const busy = new Map(cams.map((c) => [c.name, this.faceShare(rt, c) > 0.05 ? 0.6 : 1]));
    const seen = (c: CameraPreset, pts: THREE.Vector3[], size: number) => this.sees(c, pts, size, rays) * (busy.get(c.name) ?? 1);
    yield;
    // pads: the pad and the hover point above it (a ship landing)
    const tcfg = (rt.info as unknown as { traffic?: TrafficCfg }).traffic;
    if (tcfg?.pads?.length && this.cfg.events !== false) {
      rt.room.root.updateMatrixWorld(true);
      for (let i = 0; i < tcfg.pads.length; i++) {
        const pad = tcfg.pads[i];
        const P = rt.room.root.localToWorld(new THREE.Vector3(...pad.position));
        const size = Math.max(8, pad.size || 18);
        const pts = [P.clone().addScaledVector(UP, 2), P.clone().addScaledVector(UP, 14 + size * 0.5)];
        const out: CamScore[] = [];
        for (const c of cams) { const s = seen(c, pts, size); if (s > 0.15) out.push({ name: c.name, score: s }); yield; }
        this.padCams.set(i, out.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1)));
      }
    }
    // battle moments in the room clips. The expensive unit is one pose of every room clip (a big room has ~100): it is the
    // only thing a slice ends on, so a frame does one pose + the put-back, never a moment's whole search at once
    if (this.cfg.events !== false) {
      this.moments = collectMoments(rt, this.cfg);
      yield;
      const liveCams = [...rt.room.cameras.values()].filter((p) => isLive(p) && liveNode(p));
      for (const m of this.moments) {
        yield 'pose';
        if (measureMoment(rt, m)) this.clipsDirty = true;
        yield;
        const list = m.cams ? cams.filter((c) => m.cams!.includes(c.name)) : cams;
        const out: CamScore[] = [];
        for (const c of list) { const s = seen(c, [m.pos], 45); if (s > 0.15) out.push({ name: c.name, score: s }); yield; }
        // our craft in the same battle group: an over-the-shoulder shot from it onto the kill. The clips are posed once per
        // time that matters (a moment before, at, a moment after the kill) for all candidate craft together.
        let ots: { craft: Craft; q: number } | null = null;
        const cand = this.cfg.chase !== false && m.group ? this.crafts.filter((c) => c.group === m.group) : [];
        if (cand.length) {
          let alive = cand;
          const dist = new Map<Craft, number>();
          for (const dt of [-m.lead * 0.8, 0, m.tail * 0.8]) {
            yield 'pose';
            rt.clips?.update(m.at + dt);
            this.clipsDirty = true;
            alive = alive.filter((c) => {
              c.node.updateWorldMatrix(true, false);
              if (c.node.matrixWorld.determinant() === 0 || c.node.getWorldScale(new THREE.Vector3()).x < 0.05) return false;
              const cp = c.node.getWorldPosition(new THREE.Vector3());
              const pose = otsPose(cp, m.pos, c.radius * c.node.getWorldScale(new THREE.Vector3()).x);
              if (!(rays.clear(pose.position, cp) && rays.clear(pose.position, m.pos))) return false;
              if (dt === 0) dist.set(c, cp.distanceTo(m.pos));
              return true;
            });
            yield;
            if (!alive.length) break;
          }
          let best: { craft: Craft; d: number } | null = null;
          for (const c of alive) { const d = dist.get(c); if (d !== undefined && d < 600 && (!best || d < best.d)) best = { craft: c, d }; }
          if (best) ots = { craft: best.craft, q: 0.95 };
        }
        // live camera presets riding something in the same group (when the room has them), or listed for it
        const inGroup = (p: CameraPreset) => { for (let n: THREE.Object3D | null = liveNode(p); n; n = n.parent) if (n === m.group) return true; return false; };
        const live = liveCams.filter((p) => (m.cams ? m.cams.includes(p.name) : !!m.group && inGroup(p))).map((p) => p.name);
        this.momentCams.set(m.idx, { cams: out.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1)), ots, live });
      }
    }
    this.planned = true;
  }

  /** Plan work per frame (ms). A slice ends after the unit that crosses this, and before a pose of the room clips that
   *  would follow other work, so a frame costs ≈ max(this, one pose + the put-back) — not the whole plan. */
  static planSliceMs = 1;   // (a test sets 0: one step per frame)
  private pump() {
    if (!this.job) return;
    const t0 = performance.now();
    for (;;) {
      let r: IteratorResult<'pose' | void, void>;
      try { r = this.job.next(); } catch (e) { console.warn('[afk] plan', e); this.job = null; this.planned = true; break; }
      if (r.done) { this.job = null; break; }
      const used = performance.now() - t0;
      if (used > AfkScene.planSliceMs || (r.value === 'pose' && used > 0.15)) break;
    }
    this.planMs += performance.now() - t0;
    this.reposeClips();
  }
  /** The plan poses the room clips at other times to measure where things happen: put them back at the room clock before
   *  this frame is drawn (only when it did — a slice of rays alone leaves them alone). */
  private reposeClips() {
    if (!this.clipsDirty) return;
    this.clipsDirty = false;
    this.rt?.clips?.update((this.rt.clipClock ?? roomClock)());
  }

  // ---------------------------------------------------------------- events (landings, launches, kills)
  private chaseValid(ev: TrafficEvent, from: number, to: number): boolean {
    const id = `${ev.flight}:${ev.kind}`;
    const c = this.chaseOk.get(id);
    if (c !== undefined) return c;
    const pl = this.traffic?.flights, rt = this.rt;
    let ok = !!pl && !!rt;
    if (pl && rt) {
      const rays = this.roomRays(rt);
      for (let i = 0; i <= 4 && ok; i++) {
        const t = from + ((to - from) * i) / 4;
        const p = pl.poseOf(ev.key, t / 1000);
        if (!p) continue;
        const L = pl.length(p.ship) * (this.traffic?.shipScale ?? 1);
        const pose = chasePose(p, L, pl.shipMeta(p.ship));
        const c0 = p.pos.clone().addScaledVector(UP, L * 0.2);
        if (!rays.clear(c0, pose.position)) ok = false;
      }
    }
    this.chaseOk.set(id, ok);
    if (this.chaseOk.size > 400) this.chaseOk.delete(this.chaseOk.keys().next().value!);
    return ok;
  }

  private events(now: number): { evs: Ev[]; taken: Ev[] } {
    const st = this.st;
    const key = `${st.seed}|${st.events}|${this.planned}|${!!this.traffic?.flights}`;
    const c = this.evCache;
    if (c && c.key === key && now > c.t0 + 60_000 && now < c.t1 - 120_000) return c;
    const t0 = now - 120_000, t1 = now + 180_000;
    const evs: Ev[] = [];
    if (st.events && this.planned && this.cfg.events !== false) {
      const seed = st.seed;
      const chase = this.cfg.chase !== false;
      // sky traffic: touchdowns and lift-offs
      const pl = this.traffic?.flights;
      if (pl) for (const e of pl.padEvents(t0 / 1000, t1 / 1000)) {
        const lead = e.kind === 'land' ? 7000 : 2500, tail = e.kind === 'land' ? 2500 : 6500;
        const at = e.at * 1000;
        const cams = this.padCams.get(e.pad) ?? [];
        const L = pl.length(e.ship) * (this.traffic?.shipScale ?? 1);
        const chaseOk = chase && this.chaseValid(e, at - lead, at + tail);
        const alt = afkRand(seed, 'alt', e.flight, e.kind) < 0.5;
        let opt: Option | null = null;
        if (chaseOk && (alt || !cams.length)) opt = { k: 'chase', key: e.key, ship: e.ship, L, q: 0.9 };
        else if (cams.length) opt = { k: 'cam', name: cams[0].name, q: cams[0].score };
        if (!opt) continue;
        const id = `${e.kind}:${e.flight}`;
        evs.push({ id, kind: e.kind, at, lead, tail, prio: KIND_WEIGHT[e.kind] * opt.q * (0.8 + 0.4 * afkRand(seed, 'prio', id)), opt, label: `${e.kind === 'land' ? 'Landing' : 'Launch'} · ${e.padName}` });
      }
      // battle moments
      for (const m of this.moments) {
        const mc = this.momentCams.get(m.idx);
        if (!mc) continue;
        for (const oc of occurrences(m, t0, t1)) {
          const id = `${m.kind}:${m.name}:${m.idx}:${oc.k}`;
          const opts: Option[] = [];
          for (const l of mc.live) opts.push({ k: 'cam', name: l, q: 0.95 });
          if (mc.ots) opts.push({ k: 'ots', craft: mc.ots.craft, target: m.pos, q: mc.ots.q });
          if (mc.cams.length) opts.push({ k: 'cam', name: mc.cams[0].name, q: mc.cams[0].score });
          if (!opts.length) continue;
          const opt = opts[Math.floor(afkRand(seed, 'alt', id) * opts.length) % opts.length];
          // (a kill that repeats every 23 s isn't news every time: short loops get fewer event shots)
          evs.push({ id, kind: m.kind, at: oc.wall, lead: m.lead * 1000, tail: m.tail * 1000, prio: KIND_WEIGHT[m.kind] * opt.q * (0.8 + 0.4 * afkRand(seed, 'prio', id)), share: Math.min(1, m.period / 60), opt, label: `${m.kind === 'kill' ? 'Kill' : cap(m.kind)} · ${m.name}` });
        }
      }
    }
    const gap = (typeof this.cfg.gap === 'number' ? Math.min(120, Math.max(4, this.cfg.gap)) : 14) * 1000;
    const share = typeof this.cfg.share === 'number' ? Math.min(1, Math.max(0, this.cfg.share)) : 0.7;
    const taken = takeEvents(evs, st.seed, gap, share);
    this.evCache = { key, t0, t1, evs, taken };
    return this.evCache;
  }

  // ---------------------------------------------------------------- the director (SceneRuntime.cameraOverride)
  private cycleFor(st: SceneAfkState): AfkCycle | null {
    if (!this.shots.length) return null;
    const pace = AFK_PACE[st.pace] ?? 1;
    const k = `${st.seed}|${st.epoch}|${pace}|${this.shots.map((s) => s.id).join(',')}`;
    if (k !== this.cycleKey) {
      this.cycleKey = k;
      this.cycle = new AfkCycle(st.seed, st.epoch, this.shots.map((s) => ({ id: s.id, weight: s.weight, hold: s.hold })), this.cfg.order === 'list' ? 'list' : 'shuffle', pace);
    }
    return this.cycle;
  }

  /** The pick on air now (null = AFK not directing). */
  pick(now = this.now()): AfkPick<Ev> | null {
    if (!this.active) return null;
    const cyc = this.cycleFor(this.st);
    if (!cyc) return null;
    return afkPick(now, cyc, this.events(now).taken);
  }

  private shot(): { key: string; pose: CamPose; secs: number } | null {
    const t0 = performance.now();
    try {
      const now = this.now();
      const pk = this.pick(now);
      if (!pk) { this.cur = null; return null; }
      const key = pk.kind === 'event' ? `afk:e:${pk.ev.id}` : `afk:s${pk.seg.n}`;
      const pose = this.poseFor(pk, now);
      if (!pose) return null;
      let secs = 0;
      if (!this.cur || this.cur.key !== key) {
        secs = this.blendSecs(pk, pose);
        this.cur = { key, pick: pk };
      }
      return { key, pose, secs };
    } finally {
      const ms = performance.now() - t0;
      this.perf.avg += (ms - this.perf.avg) * 0.05; this.perf.peak = Math.max(this.perf.peak * 0.995, ms);
    }
  }

  /** A calm dolly between two nearby static shots with a clear path (seeded, ~60 %); everything else is a cut. */
  private blendSecs(pk: AfkPick<Ev>, pose: CamPose): number {
    const rt = this.rt!;
    const prev = this.cur?.pick;
    if (pk.kind !== 'shot' || !prev || prev.kind !== 'shot') return 0;
    const a = this.shots[prev.seg.shot], b = this.shots[pk.seg.shot];
    if (!a || !b || a.live || b.live) return 0;
    const from = rt.rig.current?.position ?? this.presetOf(a).position, to = pose.position;
    const d = from.distanceTo(to);
    if (d < 0.05 || d > 12 || afkRand(this.st.seed, 'blend', pk.seg.n) > 0.6) return 0;
    const rays = this.roomRays(rt);
    const mid = from.clone().lerp(to, 0.5).add(new THREE.Vector3(0, Math.min(0.35, d * 0.08), 0));
    if (!rays.clear(from, mid) || !rays.clear(mid, to)) return 0;
    return 2.2 * (AFK_PACE[this.st.pace] ?? 1);
  }

  /** The shot's camera as the room has it NOW: a Room-editor save puts fresh preset objects in room.cameras (restoreRoom) and
   *  the runtime rides those, so the object stored when the shot was built is an orphan (a live cockpit shot would freeze, an
   *  edited camera would be ignored). A camera the editor removed keeps its last pose. */
  private presetOf(s: Shot): CameraPreset {
    return this.rt?.room.cameras.get(s.id) ?? s.preset;
  }

  private poseFor(pk: AfkPick<Ev>, now: number): CamPose | null {
    const rt = this.rt!;
    if (pk.kind === 'shot') {
      const s = this.shots[pk.seg.shot];
      if (!s) return null;
      const p = this.presetOf(s);
      if (s.live || s.drift === 'none') return p;                  // (a live preset object itself: the runtime rides it)
      const k = THREE.MathUtils.smoothstep((now - pk.seg.start) / Math.max(1, pk.seg.end - pk.seg.start), 0, 1);
      if (s.drift === 'push') return { position: p.position, quaternion: p.quaternion, fov: p.fov * (1 - 0.07 * k) };
      if (s.drift === 'pull') return { position: p.position, quaternion: p.quaternion, fov: p.fov * (0.93 + 0.07 * k) };
      const side = afkRand(s.id, 'pan') < 0.5 ? -1 : 1;
      const q = new THREE.Quaternion().setFromAxisAngle(UP, THREE.MathUtils.degToRad(1.8) * (k - 0.5) * side).multiply(p.quaternion);
      return { position: p.position, quaternion: q, fov: p.fov };
    }
    const o = pk.ev.opt;
    if (o.k === 'cam') return rt.room.cameras.get(o.name) ?? null;
    if (o.k === 'chase') {
      const pl = this.traffic?.flights;
      const p = pl?.poseOf(o.key, now / 1000);
      return p ? chasePose(p, o.L, pl!.shipMeta(p.ship)) : null;
    }
    return this.otsNow(o.craft, o.target);
  }
  /** The over-the-shoulder pose from a craft right now (its size as drawn: clips may scale it). */
  private otsNow(c: Craft, target: THREE.Vector3): CamPose {
    c.node.updateWorldMatrix(true, false);
    const s = c.node.getWorldScale(TMP).x;
    return otsPose(c.node.getWorldPosition(new THREE.Vector3()), target, c.radius * (s > 0.05 ? s : 1));
  }

  // ---------------------------------------------------------------- per frame
  /** After SceneRuntime.update (the room clips are posed): the plan job, craft shots, tags (rooms without traffic), the
   *  title card. */
  update(dt: number) {
    const rt = this.rt;
    if (!rt) return;
    this.frameNo++;
    this.lastDt = dt;
    if (this.manual) this.clock += dt * 1000;
    const st = this.st;
    if (st.on && !this.planned && !this.job) this.job = this.plan();
    this.pump();
    // an over-the-shoulder shot rides its craft: re-aim now that the clips moved it this frame
    if (this.cur?.pick.kind === 'event' && this.cur.pick.ev.opt.k === 'ots') {
      const o = this.cur.pick.ev.opt;
      rt.lateCamera(this.cur.key, this.otsNow(o.craft, o.target));
    }
    if (!this.traffic?.flights) this.updateTags(dt, null);
    const accent = this.ncfg.style?.text ?? '#F5A623';
    this.overlay.set(afkTitle(st), accent);
  }

  /** Sky traffic posed its ships (same frame): a chase shot is re-aimed at the ship exactly where it's drawn; tags. */
  private trafficFrame(t: number, poses: readonly ShipPose[]) {
    const rt = this.rt;
    if (!rt) return;
    const c = this.cur;
    if (c?.pick.kind === 'event' && c.pick.ev.opt.k === 'chase') {
      const o = c.pick.ev.opt;
      const p = poses.find((x) => x.key === o.key);
      const pl = this.traffic?.flights;
      if (p && pl) rt.lateCamera(c.key, chasePose(p, o.L, pl.shipMeta(p.ship)));
    }
    this.updateTags(this.lastDt, poses);
  }

  /** Names depend on the crew AND on every flight (sky traffic too): a change of either starts the cache afresh. */
  private crewKey(st: SceneAfkState) { return `${st.seed}|${!!this.traffic?.flights}|${st.crew.map((c) => `${c.n}@${c.at}-${c.until ?? ''}`).join(',')}`; }

  /** Flights active at wall ms `w` (traffic + our craft loops): what a new flight's name is chosen against. */
  private flightsAt(w: number): AfkFlight[] {
    const out: AfkFlight[] = [];
    const pl = this.traffic?.flights;
    if (pl && this.ncfg.traffic !== false) for (const f of pl.activeAt(w / 1000)) out.push({ id: f.id, start: f.start * 1000 });
    for (const c of this.crafts) out.push(this.craftFlight(c, w));
    return out;
  }
  private craftFlight(c: Craft, w: number): AfkFlight {
    const day = Math.floor(w / DAY), cc = (w - day * DAY) / 1000, loop = Math.floor(cc / c.period);
    return { id: `${c.id}:${day}:${loop}`, start: day * DAY + loop * c.period * 1000 };
  }
  private nameFor(f: AfkFlight): string | null {
    const st = this.st;
    const k = this.crewKey(st);
    if (k !== this.namesKey || this.nameMemo.size > 20000) { this.namesKey = k; this.names.clear(); this.nameMemo.clear(); }
    if (this.names.has(f.id)) return this.names.get(f.id)!;
    const n = crewNameFor(st.crew, st.seed, f, (t) => this.flightsAt(t), this.nameMemo);
    this.names.set(f.id, n);
    if (this.names.size > 600) this.names.delete(this.names.keys().next().value!);
    return n;
  }

  private updateTags(dt: number, poses: readonly ShipPose[] | null) {
    const rt = this.rt!;
    if (this.tagFrame === this.frameNo) return;
    this.tagFrame = this.frameNo;
    const st = this.st;
    if (!afkNamesOn(st) || this.ncfg.enabled === false || !st.crew.length) { if (this.tags.shown.length || this.tags.group.children.length) this.tags.clear(); return; }
    const pl = this.traffic?.flights;
    // (a traffic room names ships against its whole sky: until the flight plans are in, no name would match other pages)
    if (!pl && (rt.info as unknown as { traffic?: unknown }).traffic && this.ncfg.traffic !== false) return;
    const specs: TagSpec[] = [];
    const now = this.now();
    const scale = this.traffic?.shipScale ?? 1;
    if (poses && pl && this.ncfg.traffic !== false) {
      const labels = this.ncfg.classes ?? {};
      for (const p of poses) {
        if (!p.flight || p.start === undefined) continue;
        if (p.phase === 'parked' && p.key.startsWith('park') && this.ncfg.parked === false) continue;
        const meta: ShipMeta | null = pl.shipMeta(p.ship);
        if (!meta || meta.cls === 'T') continue;                   // (tugs, carts, cars: no names)
        const name = this.nameFor({ id: p.flight, start: p.start * 1000 });
        if (!name) continue;
        const L = meta.length * scale;
        specs.push({ id: p.flight, text: `${typeof labels[p.ship] === 'string' ? labels[p.ship] : cap(p.ship)} · ${name}`, anchor: p.pos.clone().addScaledVector(UP, L * 0.3 + 1.2), size: L });
      }
    }
    for (const c of this.crafts) {
      const s = c.node.getWorldScale(TMP).x;
      if (!(s > 0.05) || !c.node.visible) continue;
      const f = this.craftFlight(c, now);
      const name = this.nameFor(f);
      if (!name) continue;
      c.node.updateWorldMatrix(true, false);
      specs.push({ id: f.id, text: `${c.label} · ${name}`, anchor: c.node.getWorldPosition(new THREE.Vector3()).addScaledVector(UP, c.radius * 1.05 * s + 1.5), size: c.length * s });
    }
    const cam = rt.stage.camera;
    const avoid: TagAvoid = { faces: [], rects: [] };
    for (const a of rt.actors.values()) { if (!a.shown || !a.spot) continue; const f = a.faceAt(a.spot); if (f) avoid.faces.push(f); }
    if (rt.state.mode === 'react') for (const s of [rt.screen, rt.solo]) { const r = s?.rect(cam); if (r?.visible) avoid.rects.push(r); }
    this.tags.update(specs, cam, rt.stage.renderer.domElement.height || 1080, dt, avoid);
  }

  // ---------------------------------------------------------------- tests / debug
  /** Test pages: pin every clock this uses (AFK, sky traffic, room clips) to wall time `ms`; vtpOut.step() advances them. */
  freeze(ms: number) {
    this.manual = true; this.clock = ms;
    if (this.traffic) { this.traffic.manual = true; this.traffic.clock = ms / 1000; }
    if (this.rt) this.rt.clipClock = () => (((this.clock % DAY) + DAY) % DAY) / 1000;
    this.evCache = null;
  }

  info() {
    const st = this.st, now = this.now();
    const pk = this.rt ? this.pick(now) : null;
    const ev = this.rt && st.on && this.planned ? this.events(now) : null;
    const next = ev?.taken.find((e) => e.at - e.lead > now) ?? null;
    return {
      on: st.on, active: this.active, planned: this.planned, planMs: +this.planMs.toFixed(1),
      shot: pk ? (pk.kind === 'event' ? `${pk.ev.label} → ${optName(pk.ev.opt)}` : this.shots[pk.seg.shot]?.id ?? null) : null,
      kind: pk?.kind ?? null, left: pk ? Math.max(0, Math.round((pk.to - now) / 100) / 10) : null,
      next: next ? { what: next.label, cam: optName(next.opt), in: Math.round((next.at - next.lead - now) / 100) / 10 } : null,
      shots: this.shots.map((s) => s.id), crafts: this.crafts.map((c) => `${c.id} (${c.label})`),
      pads: [...this.padCams.entries()].map(([i, c]) => `${i}:${c.slice(0, 2).map((x) => `${x.name} ${x.score.toFixed(2)}`).join(' / ') || '—'}`),
      moments: this.moments.map((m) => { const mc = this.momentCams.get(m.idx); return `${m.name}@${m.at.toFixed(1)}/${m.period}s: ${mc?.cams[0]?.name ?? '—'}${mc?.ots ? ` + OTS ${mc.ots.craft.id}` : ''}${mc?.live.length ? ` + ${mc.live.join(',')}` : ''}`; }),
      events: ev ? { window: ev.evs.length, taken: ev.taken.length } : null,
      tags: this.tags.shown.length, tagNames: this.tags.shown.map((t) => t.text).slice(0, 12), crew: st.crew.length,
      overlay: this.overlay.showing, ms: +this.perf.avg.toFixed(3), peak: +this.perf.peak.toFixed(2),
    };
  }
  debug() { return this.info(); }
  /** Tests: the taken events around now (label, cam, start in s from now). */
  upcoming(n = 8) {
    const now = this.now();
    return this.planned ? this.events(now).taken.filter((e) => e.at + e.tail > now).slice(0, n).map((e) => ({ id: e.id, what: e.label, cam: optName(e.opt), start: +((e.at - e.lead - now) / 1000).toFixed(2), at: e.at, lead: e.lead, tail: e.tail })) : [];
  }
}

const TMP = new THREE.Vector3();
function groupOfNode(o: THREE.Object3D, root: THREE.Object3D): THREE.Object3D | null {
  let p: THREE.Object3D | null = o;
  while (p && p.parent && p.parent !== root) p = p.parent;
  return p && p !== o ? p : null;
}
function optName(o: Option): string {
  return o.k === 'cam' ? o.name : o.k === 'chase' ? `chase ${o.ship}` : `over the shoulder of ${o.craft.id}`;
}

/** Behind and above a flying ship, looking past its nose (level horizon) — or its cockpit when ships.json gives one
 *  (`cockpit: [x, y, z]`, ship-local metres, nose −Z). */
export function chasePose(p: ShipPose, L: number, meta: (ShipMeta & { cockpit?: unknown }) | null): CamPose {
  const ck = meta?.cockpit;
  if (Array.isArray(ck) && ck.length === 3 && ck.every((v) => typeof v === 'number')) {
    const pos = new THREE.Vector3(ck[0], ck[1], ck[2]).multiplyScalar(L / Math.max(1, meta!.length)).applyQuaternion(p.quat).add(p.pos);
    return { position: pos, quaternion: p.quat.clone(), fov: 70 };
  }
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(p.quat);
  const flat = f.clone().setY(0);
  if (flat.lengthSq() < 1e-4) flat.set(0, 0, -1); else flat.normalize();
  // (the ship sits in the lower third, whole: the camera 2.6 lengths behind and 1 above, aimed just past its nose)
  const pos = p.pos.clone().addScaledVector(flat, -L * 2.6).addScaledVector(UP, L * 1.0);
  const target = p.pos.clone().addScaledVector(f, L * 1.2).addScaledVector(UP, L * 0.1);
  return lookPose(pos, target, 52);
}

/** Behind one of our craft, looking over it at the kill (both in frame). */
export function otsPose(craft: THREE.Vector3, target: THREE.Vector3, radius: number): CamPose {
  const away = craft.clone().sub(target);
  if (away.lengthSq() < 1e-4) away.set(0, 0, 1);
  away.normalize();
  const pos = craft.clone().addScaledVector(away, radius * 4.6).addScaledVector(UP, radius * 0.8);
  return lookPose(pos, craft.clone().lerp(target, 0.25), 50);
}
