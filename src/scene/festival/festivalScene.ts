// Festival stage engine (scene.json `festival` + FX_<TYPE>_<GROUP>_<NN> anchors; docs/SCENES.md "Festival"):
// moving heads, PAR cans, strobes, blinders, lasers, pixel bars, LED walls, flames, CO2, confetti, gerbs, comets and
// fireworks, an instanced crowd, the DJ at the decks, a drone camera - all driven by the show director
// (shared/festivalDirector.ts) from the music clock (./music.ts: DJ software → audio beat engine → a built-in auto show).
// Pure functions of the shared beat grid, so the studio preview, every OBS page and party guests show the same frame.
// Rooms without `festival` pay nothing. Coexists with the room light show (src/scene/lightShow.ts, untouched): the
// room's LIGHT_* fixtures keep their programs, the generic effects rig (vtp:fx) is hidden while the festival rig plays.
import * as THREE from 'three';
import type { SceneRuntime } from '../SceneRuntime.ts';
import { sceneFileUrl } from '../SceneRuntime.ts';
import type { SceneActor } from '../actor.ts';
import { lookPose, type CamPose } from '../cameraRig.ts';
import { RoomRays } from '../twoShot.ts';
import { movePose, showCut } from './camMove.ts';
import { FlashGate, TIER_BELOW, b64ToBits, hash3, hashStr, parseFxAnchor, sanitizeFestivalConfig, sanitizeFestivalState, type FestivalConfig, type FxKind, type SceneFestivalState, type Tier } from '../../../shared/festival.ts';
import { DROP_SEQS, cueHits as cueHitsD, direct, dropHits, festivalCatalogue, framePaletteId, lookFrame, type DirectorFrame, type MusicState, type SfxHit } from '../../../shared/festivalDirector.ts';
import { LOOKS_VERSION, catalogue, type Catalogue } from '../../../shared/festivalLooks.ts';
import { QUALITY_KILL } from '../../../shared/festivalQuality.ts';
import type { Fixture } from './common.ts';
import { FestivalGov, type GovOwner } from './gov.ts';
import { StageRig, tierFixtures, type WallSpec } from './stageRig.ts';
import { unitFrom, type CrowdArea } from './crowd.ts';
import { FestivalMusic, festivalMusic, tapBeatClock } from './music.ts';
import { BeatClock } from '../beatClock.ts';
import { flashNoticeWanted, wallNotice } from '../flashWarning.ts';
import { DjPose } from '../club/djPose.ts';
import { followFestival, registerCatalogue, restoreRoomShow } from './lightsBridge.ts';
import { Ambient, Endshow, TalkLights, type AmbientOut, type EndshowOut } from './endshow.ts';
import { SHARED_EPOCH_S, sharedBase } from '../../../shared/showPack/rhythm.ts';
import type { FestivalScript } from '../../../shared/festival.ts';
import { DEFAULT_STRUCTURE, spreadStepColor, structureColor, structureLevel, structureTarget, phraseEase, type RGB, type StructureCfg } from '../../../shared/festivalRoles.ts';
import { DEFAULT_SMOKE, smoothToward } from '../../../shared/festivalSmoke.ts';
import { wallPulse } from '../../../shared/festivalWall.ts';
import { composeEndshow, composeGroupKeys, type ComposeRoom } from '../../../shared/festivalCompose.ts';
import { CutGuard, bandBpm, cutAt, cutGrid, grammarParts, liveParts, liveStart, minCutBeats, planCuts, tempoBand, type Cut } from '../../../shared/festivalCamGrammar.ts';

tapBeatClock();

const TA = new THREE.Color(), TB = new THREE.Color(), STAGE = new THREE.Vector3();
const WC: RGB = [0, 0, 0];
const hexRgbW = (h: string): [number, number, number] => { const n = parseInt(h.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
/** a room cue's steps at beat b → hits (kept like the director's) */
function cueHitsOf(steps: FestivalConfig['cues'][string], b: number, out: SfxHit[]) { out.push(...cueHitsD(steps, b)); }
const LEVEL_TIER: Record<string, Tier> = { performance: 'low', balanced: 'high', high: 'high', ultra: 'ultra' };

/** A room's fixtures, walls, crowd areas and seats, read from its anchors (room frame). */
export function readRoom(room: THREE.Object3D, cfg: FestivalConfig): { all: Fixture[]; walls: (WallSpec & { group: string })[]; areas: CrowdArea[]; seats: THREE.Vector3[]; box: THREE.Box3 } {
  room.updateMatrixWorld(true);
  const toRoom = new THREE.Matrix4().copy(room.matrixWorld).invert();
  const rootQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(room.matrixWorld)).invert();
  const all: Fixture[] = [], walls: (WallSpec & { group: string })[] = [], areas: CrowdArea[] = [], seats: THREE.Vector3[] = [];
  room.traverse((o) => {
    const a = parseFxAnchor(o.name);
    if (a) {
      const pos = o.getWorldPosition(new THREE.Vector3()).applyMatrix4(toRoom);
      const qr = rootQ.clone().multiply(o.getWorldQuaternion(new THREE.Quaternion()));
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(qr);
      const ex = (o.userData ?? {}) as Record<string, unknown>;
      all.push({ kind: a.kind, group: a.group, index: a.index, name: o.name, pos, quat: qr, extras: ex, mesh: (o as THREE.Mesh).isMesh ? o as THREE.Mesh : null,
        geo: { x: 0, y: 0, z: 0, i: 0, n: 1, seed: hash3(a.index, a.group.length) }, hung: typeof ex.hung === 'boolean' ? ex.hung : up.y < -0.2 });
      if (a.kind === 'ledwall') {
        const w = cfg.walls[a.group] ?? {};
        const role = w.role ?? (/EYE/.test(a.group) ? 'eye' : /MAIN|CENTER|CENTRE/.test(a.group) ? 'main' : 'side');
        o.traverse((x) => { if ((x as THREE.Mesh).isMesh) walls.push({ mesh: x as THREE.Mesh, role, visual: w.visual, mirror: w.mirror ?? (pos.x > 0.5 && role === 'side'), pupil: w.pupil, iris: w.iris, group: a.group }); });
      }
    }
    if (/^AUDIENCE_AREA_\d+$/.test(o.name)) {
      const x = (o.userData ?? {}) as Record<string, unknown>;
      const p = o.getWorldPosition(new THREE.Vector3()).applyMatrix4(toRoom);
      const fw = new THREE.Vector3(0, 0, 1).applyQuaternion(rootQ.clone().multiply(o.getWorldQuaternion(new THREE.Quaternion())));
      const ko = typeof x.keepOut === 'string' ? x.keepOut.split(';').map((s) => s.split(',').map(Number)).filter((v) => v.length === 3 && v.every(Number.isFinite)) as [number, number, number][] : [];
      areas.push({ center: p, yaw: Math.atan2(fw.x, fw.z), rx: Number(x.rx) || 6, rz: Number(x.rz) || 6, density: Number(x.density) || 1.1, ellipse: x.shape === 'ellipse', keepOut: ko });
    }
    if (/^AUDIENCE_SEAT_\d+$/.test(o.name)) seats.push(o.getWorldPosition(new THREE.Vector3()).applyMatrix4(toRoom));
  });
  const box = new THREE.Box3().setFromObject(room).applyMatrix4(toRoom);
  return { all, walls, areas, seats, box };
}

/** The Quality team's first pass (shared/festivalQuality.ts) as a kill set over this catalogue. */
function qualityKills(cat: Catalogue): Set<string> { return new Set(cat.looks.filter((l) => QUALITY_KILL.has(l.id)).map((l) => l.id)); }

/** how far apart the camera's beat and the director's read of the same frame may be and still be one beat (the room's other
 *  engines run between the two reads: a few ms; 1/4 beat = 62 ms even at 240 BPM) */
export const CAM_LOCK_BEATS = 0.25;

export class FestivalScene {
  private rt: SceneRuntime | null = null;
  cfg: FestivalConfig | null = null;
  private cat: Catalogue | null = null;
  rig: StageRig | null = null;
  private gate = new FlashGate();
  /** the room's photosensitivity governor (shared with the light show when the lights lane is in the build) */
  /** (public for tests: the drawn-flash hunt rebinds it to the festival's own governor on the test clock) */
  readonly gov = new FestivalGov();
  private washGov: GovOwner = {};
  private tier: Tier = 'high';
  private level = 0;
  private base = 0;                                    // page-time origin (s) for the shaders (32-bit floats)
  private warnUntil = 0; private wasNotice = false;
  private dj: DjPose | null = null;
  private killed: Set<string> | null = null; private curKey = '#';
  private slow = 0; private good = 0; private degrade = 0;
  private nightMats = new Map<THREE.MeshStandardMaterial, { env: number; metal: number }>();
  private washMats: { m: THREE.MeshStandardMaterial; em: THREE.Color; emI: number; map: THREE.Texture | null }[] = [];
  private washCol = new THREE.Color();
  private prevOverride: SceneRuntime['cameraOverride'] = null;
  private myOverride: SceneRuntime['cameraOverride'] = null;
  /** music source (a private one for replays / tests) */
  music: FestivalMusic = festivalMusic;
  /** test pages: force the show level (0..1), null = follow the lighting state */
  force: number | null = null;
  /** test pages: override the tier (rebuilds) */
  forceTier: Tier | null = null;
  /** test pages: never step the tier down on slow frames (frame-time measurements) */
  noDowngrade = false;
  /** test pages: the camera grammar shows this camera (e.g. 'PYRO_WIDE') instead of its plan's */
  forceCut: string | null = null;
  /** test pages: how far apart the camera's and the director's beat reads of a frame may be and still be one beat */
  camLock = CAM_LOCK_BEATS;
  private reactBack = 0;
  private camV = new THREE.Vector3();          // (scratch: the camera in the room frame, every frame)
  // the scripted endshow, the Talk / Interview background show, the talk set's key + rims, the swell node
  private endshow = new Endshow();
  private ambient = new Ambient();
  private talk: TalkLights | null = null;
  /** the talk set's lights made while the room loaded (preLights), until attach() takes them */
  private pre: { root: THREE.Object3D; talk: TalkLights } | null = null;
  private swellNode: { o: THREE.Object3D; base: THREE.Vector3 } | null = null;
  private swellNow = 0;
  /** the effect groups per kind (for the background show's moments) */
  private groups = new Map<FxKind, string[]>();
  /** every effect anchor of the room (all tiers: a composed show is the same on every page) and its cameras */
  private allFx: Fixture[] = [];
  /** the composed endshow (SceneFestivalState.compose), cached per settings; the camera grammar's cut plan, per script */
  private composed: { key: string; script: FestivalScript } | null = null;
  private plan: { key: string; cuts: Cut[] } | null = null;
  private autoPlan: { key: string; cuts: Cut[] } | null = null;
  /** the grammar's tempo band (latched: festivalCamGrammar tempoBand) and the cut on screen, kept across re-plans */
  private fastBand = false;
  private cutGuard = new CutGuard();
  /** the structure layer's section level, eased (shared/festivalRoles.ts), and the moving heads' scripted level */
  private structT = 0; private beamsNow = 1;
  /** the last endshow / background frame (debug, tests) */
  lastShow: { endshow: EndshowOut | null; ambient: AmbientOut | null } = { endshow: null, ambient: null };
  /** ms per update (moving average) and the last director frame (debug) */
  cost = 0;
  last: DirectorFrame | null = null;
  lastMusic: MusicState | null = null;

  /** SceneRuntime.earlyLights: the talk set's three spots exist before the room's first shader compile (a light added after it
   *  recompiles every lit program with the new count). Same lights, same place in the room root, same order as attach() makes
   *  them; only when attach() would make them (festival on + ambient.key). */
  preLights(root: THREE.Object3D, info: unknown) {
    this.pre?.talk.dispose(); this.pre = null;
    const cfg = sanitizeFestivalConfig((info as { festival?: unknown }).festival);
    if (!cfg || !cfg.on || !cfg.ambient.key) return;
    const talk = new TalkLights();
    root.add(talk.group);
    this.pre = { root, talk };
  }

  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    const cfg = sanitizeFestivalConfig((rt.info as unknown as { festival?: unknown }).festival);
    if (!cfg || !cfg.on) return;
    this.rt = rt; this.cfg = cfg;
    this.gov.bind(rt); this.washGov = {};
    this.cat = festivalCatalogue(cfg);
    registerCatalogue(this.cat);                         // (the room light show's director knows the festival's looks)
    // a night set: the studio environment's reflections on the room's own materials way down (restored on detach)
    if (cfg.night < 1) rt.room.root.traverse((o) => {
      const mats = (o as THREE.Mesh).material; if (!mats) return;
      for (const m of (Array.isArray(mats) ? mats : [mats]) as THREE.MeshStandardMaterial[]) {
        if (!m.isMeshStandardMaterial || /^EMIT_/.test(m.name) || this.nightMats.has(m)) continue;
        // (measured: on a dark set the grey is all SPECULAR - the studio environment + the avatar key lights on
        // dielectric surfaces. Metalness 1 makes the specular take the near-black albedo; the stage wash, the LED walls,
        // the fixtures and the beam pools carry the look)
        this.nightMats.set(m, { env: m.envMapIntensity, metal: m.metalness }); m.envMapIntensity *= cfg.night; if (cfg.nightMetal) m.metalness = 1 - (1 - m.metalness) * cfg.night;
      }
    });
    // the stage wash on the set (scene.json festival.wash): emissive through the material's own texture, show-tinted
    if (cfg.wash?.materials.length) {
      const names = new Set(cfg.wash.materials), seen = new Set<THREE.Material>();
      rt.room.root.traverse((o) => {
        const mats = (o as THREE.Mesh).material; if (!mats) return;
        for (const m of (Array.isArray(mats) ? mats : [mats]) as THREE.MeshStandardMaterial[]) {
          if (!m.isMeshStandardMaterial || seen.has(m) || !names.has(m.name.replace(/\.\d+$/, ''))) continue;
          seen.add(m);
          this.washMats.push({ m, em: m.emissive.clone(), emI: m.emissiveIntensity, map: m.emissiveMap });
          if (m.map && !m.emissiveMap) { m.emissiveMap = m.map; m.needsUpdate = true; }
          m.emissive.setRGB(0, 0, 0);
        }
      });
      try { rt.stage.renderer.compile(rt.stage.scene, rt.stage.camera); } catch { /* optional */ }
    }
    this.base = sharedBase(this.music.now());   // (a shared anchor: every page's walls in phase)
    this.build();
    // the swell node (a throat sac): scaled through builds, snapping back on the drop
    if (cfg.swell) { const o = rt.room.root.getObjectByName(cfg.swell.node); if (o) this.swellNode = { o, base: o.scale.clone() }; }
    // the talk set's lights (only rooms that ask for them: they are real lights, created once)
    if (cfg.ambient.key) {
      const early = this.pre && this.pre.root === rt.root ? this.pre.talk : null;
      this.talk = early ?? new TalkLights();
      if (!early) rt.root.add(this.talk.group);
    }
    if (this.pre && this.pre.talk !== this.talk) this.pre.talk.dispose();
    this.pre = null;
    // the drone sweep: CAM_DRONE becomes a slow arc over the crowd (a pure function of the wall clock: every page flies
    // the same path); other directors keep working underneath
    this.cams.clear(); this.rays = null;   // (this room's cameras are read and checked on first use)
    this.prevOverride = rt.cameraOverride;
    this.myOverride = (aspect) => this.showShot() ?? this.talkSetShot() ?? this.droneShot() ?? this.autoShot() ?? this.prevOverride?.(aspect) ?? null;
    rt.cameraOverride = this.myOverride;
  }

  /** the endshow's camera cuts (its parts' `cams`), while it plays in show mode and the host left its cameras on */
  private showShot(): { key: string; pose: CamPose; secs: number } | null {
    const rt = this.rt, es = this.lastShow.endshow;
    if (!rt || !es || rt.state.mode === 'react' || rt.state.mode === 'interview') return null;
    const st = this.st();
    if (st.showCams === false) return null;
    // a part without its own cameras in a show that asks for it: the music-locked camera grammar (camera roles from the
    // room's camera names). The cut is read at THIS frame's beat (the camera is decided before the director runs in a
    // frame): the drop's cut and its white hit land on the same frame
    if (!es.f.cam && es.script.camGrammar) return this.grammarShot(es);
    if (!es.f.cam) return null;
    if (es.f.cam === 'CAM_DRONE') return this.droneShot(true);
    // (a camera with a <NAME>_END empty moves to it over its cut)
    const pose = this.movePose(es.f.cam, es.f.camU);
    if (!pose) return null;
    return { key: `festival:show:${es.f.part.bar}:${es.f.camIdx}:${es.f.cam}`, pose, secs: 0 };
  }

  /** A wide framed for the pyro (the research's fireworks frame): on the stage's centre line, the roofline at about half the
   *  frame height, the deck at ~80 %, the effect anchors' whole width in the frame - so the sky the comets and shells fill
   *  is in the picture (a room's own wide is usually framed on the set). Inside the room's box, clear of its geometry;
   *  null = no room for one. Room frame → world, like the drone. */
  private pyroWide: CamPose | null | undefined;
  private pyroWidePose(): CamPose | null {
    if (this.pyroWide !== undefined) return this.pyroWide;
    const rt = this.rt!, cfg = this.cfg!;
    const fx = this.allFx.filter((f) => f.kind !== 'firework');
    const sfx = this.allFx.filter((f) => f.kind === 'flame' || f.kind === 'comet' || f.kind === 'gerb' || f.kind === 'firework');
    if (!fx.length || !sfx.length) return (this.pyroWide = null);
    let x0 = Infinity, x1 = -Infinity, top = cfg.deckY, zs = 0;
    for (const f of sfx) { x0 = Math.min(x0, f.pos.x); x1 = Math.max(x1, f.pos.x); }
    for (const f of fx) { top = Math.max(top, f.pos.y); zs += f.pos.z; }
    zs /= fx.length;
    const H = Math.max(4, top - cfg.deckY), cx = (x0 + x1) / 2, W = Math.max(8, x1 - x0);
    const half = Math.max(H * 1.7, (W * 1.1) / 2 / (16 / 9));          // half the frame height at the stage
    const box = this.roomBox;
    // (as far as the effects' width at a ~62 deg horizontal field - hFOV = 2 atan(1.1 W/2 / D) - inside the room)
    let D = Math.max(25, Math.min((W * 0.55) / Math.tan((31 * Math.PI) / 180), (box && Number.isFinite(box.max.z) ? box.max.z - 3 : zs + 90) - zs, 140));
    const rays = (this.rays ??= new RoomRays(rt.room));
    const p = new THREE.Vector3(), tg = new THREE.Vector3(cx, cfg.deckY + 0.9 * H, zs), q = new THREE.Vector3();
    // (inside a wall / tower, or scenery between it and the stage: closer, until it is clear)
    for (let k = 0; k < 10; k++, D -= 5) {
      p.set(cx, cfg.deckY + Math.max(4, 0.3 * H), zs + D);
      let ok = !rays.insideCollider(p);
      // (lines to the stage's front, above the deck: the set itself is behind them)
      for (const fx2 of [-0.42, 0, 0.42]) if (ok && !rays.clear(p, q.set(cx + fx2 * W, cfg.deckY + 0.6 * H, Math.max(zs, cfg.deckFront) + 2))) ok = false;
      if (ok || D <= 26) break;
    }
    if (rays.insideCollider(p)) return (this.pyroWide = null);
    const fov = Math.max(24, Math.min(80, (2 * Math.atan(half / D) * 180) / Math.PI));
    this.pyroWideInfo = { D: +D.toFixed(1), fov: +fov.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1), boxZ: box ? +box.max.z.toFixed(1) : null };
    rt.root.localToWorld(p); rt.root.localToWorld(tg);
    return (this.pyroWide = lookPose(p, tg, fov));
  }
  private roomBox: THREE.Box3 | null = null;
  /** where the pyro wide ended up (tests / debug) */
  pyroWideInfo: Record<string, number | null> | null = null;

  /** the grammar's cameras: the room's CAM_* (not React / doors / press sets) + the DJ spot's camera (+ the pyro wide when
   *  the room fires aerials) */
  private grammarCams(): string[] {
    const rt = this.rt!, cfg = this.cfg!;
    const names = ((rt as unknown as { cameraNames?: () => string[] }).cameraNames?.() ?? []).filter((c) => /^CAM_/.test(c) && !/REACT|DOOR|PRESS|_END$/.test(c));
    // (the room's own wide: the runtime's list leaves CAM_WIDE out - it is the Wide button's - but it is the grammar's wide)
    if (rt.room.root.getObjectByName('CAM_WIDE') && !names.includes('CAM_WIDE')) names.push('CAM_WIDE');
    if (!names.length) rt.room.root.traverse((o) => { if (/^CAM_[A-Z0-9_]+$/.test(o.name) && !/REACT|DOOR|PRESS|_END$/.test(o.name) && !names.includes(o.name)) names.push(o.name); });
    if (cfg.djSpot) { const dj = `${cfg.djSpot}_CAM`; if (rt.room.root.getObjectByName(dj)) names.push(dj); }
    if (names.includes('CAM_DRONE') && !cfg.drone) names.splice(names.indexOf('CAM_DRONE'), 1);
    if (this.allFx.some((f) => f.kind === 'firework' || f.kind === 'comet') && this.pyroWidePose()) names.push('PYRO_WIDE');
    return names.sort();
  }
  /** the endshow's cut at this frame (shared/festivalCamGrammar.ts planCuts: the whole show's cuts, planned once) */
  private grammarShot(es: EndshowOut): { key: string; pose: CamPose; secs: number } | null {
    const safe = this.rt!.state.lights?.safe !== false, m = this.lastMusic;
    if (!m) return null;
    // (the plan per script - a composed one by its settings - per tempo band (latched: a clock jittering around 180 BPM
    //  can't flip it) and Safe flashes; the planner gets a tempo inside the band, so its grid matches the key)
    this.fastBand = tempoBand(this.fastBand, m.bpm);
    const bpm = bandBpm(this.fastBand, m.bpm), key = `${this.st().compose ? this.composed?.key : es.script.id}|${es.script.bars}|${es.script.parts.length}|${es.script.cues.length}|${this.fastBand ? 'f' : 's'}|${safe}`;
    if (this.plan?.key !== key) {
      const holds = es.script.cues.filter((c) => c.kind === 'firework').map((c) => c.bar * 4 + c.at);
      this.grammarCamList = this.grammarCams();
      this.plan = { key, cuts: planCuts(grammarParts(es.script.parts, es.script.bars), this.grammarCamList, { bpm, safe, seed: (this.st().compose?.seed ?? 1) + 7, holds, pyroCam: 'PYRO_WIDE' }) };
    }
    // (this frame's beat: the music clock's last frame moved on by the time since it was read - the director uses the SAME
    //  number this frame (update), so the drop's cut and its white hit can't fall a rounding apart)
    this.camBeat = this.beatNow(m);
    const c = cutAt(this.plan.cuts, this.camBeat - es.startBeat);
    if (!c.cut) return null;
    // (the cut on screen, kept across re-plans: a new plan never cuts inside the spacing - festivalCamGrammar CutGuard)
    const g = this.cutGuard, cam0 = this.forceCut ?? c.cut.cam;
    const u = g.step(cam0, `festival:grammar:${Math.round(es.startBeat)}:${c.idx}:${cam0}`, es.startBeat + c.cut.at, c.len, this.camBeat, Math.max(minCutBeats(bpm), cutGrid(bpm, safe)));
    const cam = g.cam;
    this.cutNow = cam;
    if (cam === 'CAM_DRONE') { const d = this.droneShot(true); return d ? { pose: d.pose, secs: 0, key: g.key } : null; }
    if (cam === 'PYRO_WIDE') { const pw = this.pyroWidePose(); return pw ? { key: g.key, pose: pw, secs: 0 } : null; }
    const pose = this.movePose(cam, u);
    return pose ? { key: g.key, pose, secs: 0 } : null;
  }
  /** the effect groups this tier's rig kept and the cameras the grammar plans with (tests / debug) */
  keptGroups: string[] = []; grammarCamList: string[] = [];
  /** the camera the grammar has up now (tests / debug) */
  cutNow = '';
  /** when the last music frame was read (the music clock's ms), and the beat the camera was picked on this frame */
  private musicAt = NaN; private camBeat = NaN;
  /** the beat now: the last music frame moved on by the time since it was read (the camera is picked before this
   *  frame's director runs - read off the same clock, the drop's cut and its white hit share a frame) */
  private beatNow(m: MusicState): number { const dt = Number.isFinite(this.musicAt) ? this.music.now() - this.musicAt : 0; return m.beat + (dt > 0 && dt < 250 ? dt * m.bpm / 60000 : 0); }

  /** A room camera's pose moved toward its `<NAME>_END` empty by u 0..1 (camMove.ts), into a scratch pose (no allocation
   *  per frame); null = no such camera, or one the geometry guard turned down. A move that passes through the room's
   *  geometry stays on its start pose. */
  private movePose(name: string, u: number): CamPose | null {
    const c = this.camOf(name);
    if (!c || !c.ok) return null;
    return movePose(this.camPose, c.a, c.move ? c.b : null, u);
  }
  private camPose: CamPose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), fov: 40 };
  private cams = new Map<string, { a: CamPose; b: CamPose | null; ok: boolean; move: boolean }>();
  private rays: RoomRays | null = null;
  /** A room camera + its <NAME>_END pose, read and checked once (the room's geometry guard): the start inside a collider
   *  = not used; the end inside one, or the line start -> 4 samples -> end through the room's meshes = no move. */
  private camOf(name: string) {
    let c = this.cams.get(name);
    if (c) return c;
    const root = this.rt?.room.root;
    const o = root?.getObjectByName(name);
    if (!root || !o) return null;
    const fovOf = (x: THREE.Object3D) => ((x as THREE.PerspectiveCamera).isPerspectiveCamera ? (x as THREE.PerspectiveCamera).fov : Number((x.userData as { fov?: unknown }).fov) || 40);
    const a: CamPose = { position: o.getWorldPosition(new THREE.Vector3()), quaternion: o.getWorldQuaternion(new THREE.Quaternion()), fov: fovOf(o) };
    let b: CamPose | null = null;
    const e = root.getObjectByName(`${name}_END`);
    if (e) {
      const bp = e.getWorldPosition(new THREE.Vector3());
      // (an empty is not turned like a camera on export: extras `target` - ROOM coordinates - aims it; else its -Z)
      const tg = (e.userData as { target?: unknown }).target;
      const bq = Array.isArray(tg) && tg.length === 3 && tg.every((v) => typeof v === 'number' && Number.isFinite(v))
        ? new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(bp, root.localToWorld(new THREE.Vector3(tg[0] as number, tg[1] as number, tg[2] as number)), new THREE.Vector3(0, 1, 0)))
        : e.getWorldQuaternion(new THREE.Quaternion());
      b = { position: bp, quaternion: bq, fov: fovOf(e) };
    }
    const rays = (this.rays ??= new RoomRays(this.rt!.room));
    const ok = !rays.insideCollider(a.position);
    let move = !!b && ok && !rays.insideCollider(b.position);
    if (move && b) {
      let prev = a.position.clone();
      for (let i = 1; i <= 5 && move; i++) { const p = a.position.clone().lerp(b.position, i / 5); if (!rays.clear(prev, p)) move = false; prev = p; }
    }
    if (!ok || (b && !move)) console.info(`[festival] camera ${name}: ${!ok ? 'starts inside geometry - not used' : 'its move passes through geometry - held on its start'}`);
    c = { a, b, ok, move };
    this.cams.set(name, c);
    return c;
  }

  private cut = { k: 0, u: 0 };
  /** The show's own camera director (festival.showCams): Talk with nobody to frame, or the Wide / the room's default
   *  camera picked - the room's show cameras in turn, a cut every `bars` bars on the bar-phase grid (camMove.ts showCut:
   *  never the raw beat counter, which Ableton Link offsets from the bar), each one a slow move. A performer close-up
   *  (Me / a guest), React, Interview and the Stream Deck's own camera picks are never taken over. */
  private autoShot(): { key: string; pose: CamPose; secs: number } | null {
    const rt = this.rt, sc = this.cfg?.showCams;
    if (!rt || !sc || rt.state.mode !== 'talk' || this.level < 0.2) return null;
    const cam = rt.state.camera;
    let nobody = true;
    // (nobody in the room: no performer, or every one of them stepped out - an absent host is still an actor)
    for (const k of rt.actors.keys()) if (rt.state.present?.[k] !== false) { nobody = false; break; }
    if (!(cam === 'wide' || cam === rt.info.defaultCamera || (cam === 'talk' && nobody))) return null;
    if (sc.grammar && this.lastMusic && Number.isFinite(this.lastMusic.beat)) { const g = this.autoGrammar(sc.cams); if (g) return g; }
    const t = showCut(this.lastMusic, sc.bars, (this.music.manualAt ?? Date.now()) / 1000, this.cut);
    // (a camera the guard turned down: the next one on the list)
    for (let j = 0; j < sc.cams.length; j++) {
      const idx = (((t.k + j) % sc.cams.length) + sc.cams.length) % sc.cams.length, name = sc.cams[idx];
      if (name === 'CAM_DRONE' && this.cfg?.drone) { const d = this.droneShot(true); if (d) return { pose: d.pose, secs: 0, key: `festival:auto:${t.k}:drone` }; continue; }
      const pose = this.movePose(name, t.u);
      if (pose) return { key: `festival:auto:${t.k}:${name}`, pose, secs: 0 };
    }
    return null;
  }

  /** The show director by the camera grammar (festival.showCams.grammar): the music's section now - a build counting
   *  down to a known drop, the drop itself (its downbeat = the widest shot), a breakdown - planned as a few parts around
   *  the section's start, re-planned when the section changes. */
  private autoGrammar(cams: string[]): { key: string; pose: CamPose; secs: number } | null {
    const m = this.lastMusic!, safe = this.rt!.state.lights?.safe !== false;
    this.fastBand = tempoBand(this.fastBand, m.bpm);
    const bpm = bandBpm(this.fastBand, m.bpm), start = liveStart(m);
    const key = `${Math.round(start)}|${m.section}|${m.nextDrop ?? ''}|${this.fastBand ? 'f' : 's'}|${safe}`;
    if (this.autoPlan?.key !== key) this.autoPlan = { key, cuts: planCuts(liveParts(m, start), cams.filter((c) => !!this.camOf(c)?.ok || c === 'CAM_DRONE'), { bpm, safe, seed: hashStr(this.rt!.info.id) }) };
    this.camBeat = this.beatNow(m);
    const c = cutAt(this.autoPlan.cuts, this.camBeat);
    if (!c.cut) return null;
    // (re-planned on every section / drop change: the cut on screen is kept until the spacing has passed - CutGuard)
    const g = this.cutGuard;
    const u = g.step(c.cut.cam, `festival:autog:${Math.round(start)}:${c.idx}:${c.cut.cam}`, c.cut.at, c.len, this.camBeat, Math.max(minCutBeats(bpm), cutGrid(bpm, safe)));
    if (g.cam === 'CAM_DRONE') { const d = this.droneShot(true); return d ? { pose: d.pose, secs: 0, key: g.key } : null; }
    const pose = this.movePose(g.cam, u);
    return pose ? { key: g.key, pose, secs: 0 } : null;
  }

  /** Talk on the room's talk set (rooms with ambient.key): the authored SPOT_xx_CAM of the host's seat, composed with the
   *  stage behind (the generic talk solver frames the face but knows nothing about the show behind it) */
  private talkSetShot(): { key: string; pose: CamPose; secs: number } | null {
    const rt = this.rt, cfg = this.cfg;
    if (!rt || !cfg?.ambient.key || rt.state.mode !== 'talk' || rt.state.camera !== 'talk') return null;
    const key = rt.actors.has('@host') ? '@host' : [...rt.actors.keys()][0];
    const seat = key && rt.state.present?.[key] !== false ? rt.seatOf(key) : null;   // (stepped out: the show's own director)
    if (!seat || (cfg.djSpot && seat.index === +cfg.djSpot.slice(5) - 1 && !cfg.djCam)) return null;
    const o = rt.room.root.getObjectByName(`SPOT_${String(seat.index + 1).padStart(2, '0')}_CAM`) as THREE.PerspectiveCamera | null;
    if (!o) return null;
    return { key: `festival:talkset:${seat.index}`, pose: { position: o.getWorldPosition(new THREE.Vector3()), quaternion: o.getWorldQuaternion(new THREE.Quaternion()), fov: o.isPerspectiveCamera ? o.fov : 36 }, secs: 0 };
  }

  private droneShot(always = false): { key: string; pose: CamPose; secs: number } | null {
    const rt = this.rt, dr = this.cfg?.drone;
    if (!rt || !dr || (!always && rt.state.camera !== 'CAM_DRONE') || rt.state.mode === 'react') return null;
    const t = (this.music.manualAt ?? Date.now()) / 1000;
    const th = Math.sin((t / dr.secs) * Math.PI * 2) * THREE.MathUtils.degToRad(62);
    const c = new THREE.Vector3(...dr.center);
    const p = new THREE.Vector3(c.x + Math.sin(th) * dr.radius, dr.height + 3.5 * Math.sin(th * 2.3 + 1), c.z + Math.cos(th) * dr.radius);
    const target = new THREE.Vector3(c.x + Math.sin(th) * 6, this.cfg!.deckY + 6, c.z - dr.radius * 0.35);
    rt.root.localToWorld(p); rt.root.localToWorld(target);
    return { key: 'festival:drone', pose: lookPose(p, target, 52), secs: 1.6 };
  }

  private tierNow(): Tier {
    const rt = this.rt!;
    if (this.forceTier) return this.forceTier;
    const lvl = (rt.constructor as unknown as { levelHook: (() => string) | null }).levelHook?.() ?? 'balanced';
    const t = LEVEL_TIER[lvl] ?? 'high';
    const page = rt.opts.tier as Tier;
    return lvl === 'balanced' && (page === 'low' || page === 'medium') ? page : t;
  }

  /** the tier the rig should have: the graphics level's (or a test's forced) tier, stepped down by the auto-downgrade */
  private wantTier(): Tier {
    let tier = this.tierNow();
    for (let d = 0; d < this.degrade; d++) tier = TIER_BELOW[tier];
    return tier;
  }

  /** (re)build the rig for the current tier: anchors → fixtures → renderers */
  private build() {
    const rt = this.rt!, cfg = this.cfg!;
    this.rig?.dispose(); this.rig = null;
    const tier = this.wantTier();
    this.tier = tier;
    const room = rt.room.root;
    const R = readRoom(room, cfg);
    this.allFx = R.all; this.roomBox = R.box; this.pyroWide = undefined;
    // groups the room's cues / endshow name stay in every tier (at least one unit each)
    const must = new Set<string>();
    for (const steps of Object.values(cfg.cues)) for (const st of steps) if (st.group) must.add(`${st.kind}:${st.group}`);
    for (const st of cfg.script?.cues ?? []) if (st.group) must.add(`${st.kind}:${st.group}`);
    // (and every group a composed endshow can fire here: the composer reads every anchor of the room on every tier, so the
    //  same show must find its groups on every page - a low-tier or auto-downgraded one too)
    for (const k of composeGroupKeys(this.composeRoom())) must.add(k);
    const keep = tierFixtures(R.all, tier, must, cfg.boost);
    this.keptGroups = [...new Set(keep.map((f) => `${f.kind}:${f.group}`))].sort();
    const rig = this.rig = new StageRig(keep, tier, cfg, R.walls, R.areas, R.seats, R.box);
    this.groups.clear();
    for (const f of keep) { const g = this.groups.get(f.kind) ?? []; if (!g.includes(f.group)) g.push(f.group); this.groups.set(f.kind, g); }
    room.add(rig.root);
    // the emblem the walls show: scene.json festival.logo (a file in the room folder), else the texture of a hidden
    // FESTIVAL_LOGO mesh inside the GLB (ships with the room, no extra file)
    const logoNode = room.getObjectByName('FESTIVAL_LOGO');
    if (logoNode) logoNode.visible = false;
    if (rig.walls) {
      if (cfg.logo) { const img = new Image(); img.crossOrigin = 'anonymous'; img.onload = () => { if (this.rig === rig) rig.walls?.setLogo(img); }; img.src = sceneFileUrl(rt.info.id, cfg.logo); }
      else if (logoNode) {
        let map: THREE.Texture | null = null;
        logoNode.traverse((x) => { const m = (x as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if (!map && m?.map) map = m.map; });
        const img = (map as THREE.Texture | null)?.image as HTMLImageElement | ImageBitmap | undefined;
        if (img) rig.walls.setLogo(img);
      }
    }
    if (cfg.crowd.unit && R.areas.length) {
      void import('three/examples/jsm/loaders/GLTFLoader.js').then(({ GLTFLoader }) => new GLTFLoader().loadAsync(sceneFileUrl(rt.info.id, cfg.crowd.unit!))).then((g) => {
        const u = unitFrom(g.scene);
        if (u && this.rig === rig) rig.setCrowd(R.areas, R.seats, u);
      }).catch(() => { /* the built-in people stay */ });
    }
    rig.warm(rt.stage.renderer as THREE.WebGLRenderer, rt.stage.camera, rt.stage.scene);
  }

  detach() {
    this.cams.clear(); this.rays = null; this.pyroWide = undefined; this.plan = null; this.autoPlan = null; this.composed = null; this.cutGuard.reset(); this.fastBand = false;
    if (!this.rt) return;
    this.gov.unbind();
    this.talk?.dispose(); this.talk = null;
    if (this.swellNode) { this.swellNode.o.scale.copy(this.swellNode.base); this.swellNode = null; }
    this.lastShow = { endshow: null, ambient: null };
    if (this.rt.cameraOverride === this.myOverride) this.rt.cameraOverride = this.prevOverride;
    this.prevOverride = this.myOverride = null;
    this.dj?.release(); this.dj = null;
    restoreRoomShow();
    for (const [m, v] of this.nightMats) { m.envMapIntensity = v.env; m.metalness = v.metal; }
    for (const w of this.washMats) { w.m.emissive.copy(w.em); w.m.emissiveIntensity = w.emI; if (w.m.emissiveMap !== w.map) { w.m.emissiveMap = w.map; w.m.needsUpdate = true; } }
    this.washMats = [];
    this.nightMats.clear();
    this.rig?.dispose(); this.rig = null;
    this.rt = null; this.cfg = null; this.cat = null; this.curKey = '#';
  }

  get active() { return !!this.rt; }

  /** state (host-owned, from the scene state) */
  private st(): SceneFestivalState { return sanitizeFestivalState((this.rt!.state as unknown as { festival?: unknown }).festival); }

  /** the room as the composer sees it: every effect group of every anchor (all tiers), the stage's height */
  composeRoom(): ComposeRoom {
    const cfg = this.cfg!, by = new Map<string, { kind: FxKind; group: string; n: number; ys: number; x0: number; x1: number }>();
    let top = cfg.deckY;
    for (const f of this.allFx) {
      if (f.kind === 'beam' || f.kind === 'spot' || f.kind === 'wash' || f.kind === 'pixel' || f.kind === 'par') top = Math.max(top, f.pos.y);
      if (!['flame', 'co2', 'confetti', 'gerb', 'comet', 'firework'].includes(f.kind)) continue;
      const k = `${f.kind}:${f.group}`, g = by.get(k) ?? { kind: f.kind, group: f.group, n: 0, ys: 0, x0: Infinity, x1: -Infinity };
      g.n++; g.ys += f.pos.y; g.x0 = Math.min(g.x0, f.pos.x); g.x1 = Math.max(g.x1, f.pos.x); by.set(k, g);
    }
    const groups = [...by.values()].sort((a, b) => (a.kind + a.group < b.kind + b.group ? -1 : 1)).map((g) => ({ kind: g.kind, group: g.group, n: g.n, y: g.ys / g.n, x0: g.x0, x1: g.x1 }));
    return { groups, deckY: cfg.deckY, stageH: Math.max(4, top - cfg.deckY), title: cfg.title };
  }
  /** the script the endshow plays: the host's composed show (state.compose) or the room's own (festival.script) */
  scriptNow(st: SceneFestivalState): FestivalScript | null {
    if (st.compose) {
      const key = `${this.rt!.info.id}|${JSON.stringify(st.compose)}`;
      if (this.composed?.key !== key) this.composed = { key, script: composeEndshow(st.compose.t, st.compose.tracks ?? null, this.composeRoom(), st.compose) };
      return this.composed.script;
    }
    return this.cfg?.script ?? null;
  }

  update(dt: number) {
    if (dt > 0 && dt < 0.1) this.music.lead += (Math.min(40, dt * 1000) - this.music.lead) * 0.05;   // (one frame ahead: a hit is computed into the frame that shows it on its beat)
    const rt = this.rt;
    if (!rt || !this.cfg || !this.cat || !this.rig) return;
    const p0 = performance.now();
    // (compared with the stepped-down tier: a forced / changed tier while downgraded used to rebuild every frame)
    if (this.wantTier() !== this.tier) this.build();
    const rig = this.rig!, cfg = this.cfg, st = this.st();
    const ls = rt.state.lights;
    const lstate = (ls?.state ?? 'show') as keyof FestivalConfig['states'];
    const want = (this.force ?? cfg.states[lstate] ?? 1) * st.intensity;
    this.level += (want - this.level) * Math.min(1, dt / 0.6);
    // the generic effects rig stays hidden in a festival room (this rig is the show)
    const fx = rt.stage.scene.getObjectByName('vtp:fx');
    if (fx && this.level > 0.02) fx.visible = false;
    // photosensitivity: lights.safe (default on). Turning it off (with lights.warnOnStream on) shows a warning card on the
    // walls, then a badge (src/scene/flashWarning.ts wallNotice)
    const safe = ls?.safe !== false;
    const noticeOn = flashNoticeWanted(ls);
    const nowMs = this.music.now();
    // the shaders get page seconds from `base` (32-bit floats): re-anchor when the clock jumps far (a test page's
    // virtual time, a day-long session) - every effect in flight starts over
    // (the anchor is on a shared grid - shared/showPack/rhythm.ts sharedBase - so the walls' time-driven patterns play in
    //  phase on every page (studio, OBS, party); it moves every ~11 h, on every page at the same moment)
    if (nowMs / 1000 - this.base >= SHARED_EPOCH_S || nowMs / 1000 < this.base) { this.base = sharedBase(nowMs); this.rig?.rebase(); }
    if (noticeOn && !this.wasNotice) this.warnUntil = nowMs + 8000;
    this.wasNotice = noticeOn;
    this.gate.safe = safe;
    // curation: the host's Look Lab picks, else the Quality team's first pass
    const ck = st.curation ? `${st.curation.v}:${st.curation.kill}` : 'q';
    if (ck !== this.curKey) {
      this.curKey = ck;
      // (the Look Lab saves its mask over the shipped catalogue - no room palettes - and a room's own looks sit between the
      //  shipped looks and the pack: read the bits against the Lab's list and remove by id)
      if (st.curation && st.curation.v === LOOKS_VERSION) { const lab = catalogue(null).looks, bits = b64ToBits(st.curation.kill, lab.length); this.killed = new Set(lab.filter((_, i) => bits[i]).map((l) => l.id)); }
      else this.killed = qualityKills(this.cat);
    }
    // ---- music → director
    let m = this.music.frame();
    this.musicAt = nowMs;
    // (the camera grammar picked this frame's cut on its own read of this beat - in the room's update, a few ms before this
    //  read, other engines run between: the director takes THAT number, so the same frame decides the cut and the white
    //  hit. A clock that jumped since (a re-sync, > 1/4 beat) keeps its own read.)
    if (Number.isFinite(this.camBeat) && Math.abs(m.beat - this.camBeat) < this.camLock) m.beat = this.camBeat;
    this.camBeat = NaN;
    // manual cues (host stamps): a 'drop' re-times the drop sequence, the others fire their effect now
    const cueHits: SfxHit[] = [];
    let bigCue: number | null = null;
    for (const c of st.cues) {
      if (c.k === 'big') { if (bigCue === null || c.at > bigCue) bigCue = c.at; continue; }
      const b = this.music.beatAt(c.at, m);
      if (m.beat < b || m.beat - b > 40) continue;
      if (c.k === 'drop') { if (b > m.lastDrop) { m.lastDrop = b; m.dropCount += 1; m.section = 'drop'; } continue; }
      const kind: Record<string, SfxHit['kind']> = { flames: 'flame', co2: 'co2', confetti: 'confetti', fireworks: 'firework', gerbs: 'gerb', blinders: 'blinder' };
      if (c.k.startsWith('cue:')) { cueHitsOf(cfg.cues[c.k.slice(4)] ?? [], b, cueHits); continue; }
      if (c.k === 'blackout') continue;
      if (kind[c.k]) cueHits.push({ kind: kind[c.k], group: '', beat: b, dur: c.k === 'flames' ? 1 : c.k === 'gerbs' ? 8 : 1.5, power: 1, seed: c.seed, side: 0, key: `cue${c.at}${c.k}` });
    }
    const blackoutCue = st.cues.some((c) => c.k === 'blackout' && m.beat >= this.music.beatAt(c.at, m) && m.beat - this.music.beatAt(c.at, m) < 2);
    // the endshow (show modes) or the background show (Talk / Interview) take the director over
    // the background show: Interview, or Talk with the host away from the decks (at the decks Talk is a DJ set: the show)
    const mode = rt.state.mode;
    const hostKey = rt.actors.has('@host') ? '@host' : [...rt.actors.keys()][0];
    const hostSeat = hostKey ? rt.seatOf(hostKey) : null;
    const atDecks = !hostSeat || (!!cfg.djSpot && hostSeat.index === +cfg.djSpot.slice(5) - 1);
    const talkMode = mode === 'interview' || (mode === 'talk' && !atDecks);
    const spb0 = 60 / Math.max(40, m.bpm);
    const m0 = m;
    const script = st.endshow ? this.scriptNow(st) : null;
    const es = st.endshow && script && !talkMode ? this.endshow.frame(script, this.cat, st.endshow, m0, (ms) => this.music.beatAt(ms, m0), this.music.source === 'auto', spb0) : null;
    const amb = !es && talkMode && cfg.ambient.on ? this.ambient.frame(cfg, this.cat, nowMs, this.talking(), bigCue, this.groups, hashStr(rt.info.id)) : null;
    this.lastShow = { endshow: es, ambient: amb };
    let showId = st.show === 'auto' ? cfg.defaultShow : st.show, pinned = st.look || undefined, pyro = st.pyro;
    const extra = cueHits.filter((h) => m.beat - h.beat < 30);
    if (es) { m = es.m; extra.push(...es.hits); if (es.pinned && !st.look) pinned = es.pinned; pyro = false; if (es.script.show && this.cat.showById.has(es.script.show)) showId = es.script.show; }
    // the house look: the room's (festival.house), or a show that brings it (a composed endshow) while it plays
    const houseScript = !!es?.script.house;
    const structure: StructureCfg | null = cfg.structure ?? (houseScript ? DEFAULT_STRUCTURE : null);
    rig.setSmoke(cfg.smoke ?? (houseScript ? DEFAULT_SMOKE : null));
    if (amb) { m = amb.m; extra.push(...amb.hits); showId = amb.show; pyro = false; pinned = st.look || undefined; }
    if (!st.pyro) for (let i = extra.length - 1; i >= 0; i--) if (extra[i].kind !== 'blinder' && extra[i].kind !== 'laser') extra.splice(i, 1);
    const d = direct(this.cat, showId, m, { pyro, killed: this.killed, pinned, cfg, extraHits: extra, house: cfg.house });
    if (es?.wall) d.look = { ...d.look, wall: es.wall as typeof d.look.wall };
    if (amb) { d.strobeHz = 0; d.white = 0; d.blinder = 0; d.blinderKey = ''; }
    this.gov.frame(nowMs, m.beat, m.bpm, true, safe);                    // (before any light is drawn this frame)
    d.strobeHz = this.gate.cap(d.strobeHz);                               // (a countdown never strobes past the limit)
    this.last = d; this.lastMusic = m;
    if (this.level > 0.02) followFestival(d.look, this.cat.palettes.get(framePaletteId(d.look, m, d)));   // the room's own lights follow the same look (and palette)
    const lf = lookFrame(this.cat, d.look, m, d);
    // the structure (keylight) layer: the section's level eased (~0.6 s), a shallow pulse (the kick; a slow breath with
    // Safe flashes ON), the show's own level (an endshow part's master, 0 in a blackout) - the floor stays (festivalRoles.ts)
    const showK0 = es ? es.f.master * (es.blackout ? 0 : 1) : amb ? Math.min(1, amb.master) : 1;
    let sIn: { cfg: StructureCfg; target: number; pulse: number; show: number; base: number } | null = null;
    if (structure) {
      this.structT = smoothToward(this.structT, structureTarget(structure, d.section, d.build), dt, 0.6);
      sIn = { cfg: structure, target: this.structT, pulse: safe ? wallPulse(m.beat, m.bpm) : m.kick, show: showK0 * (1 - (blackoutCue ? 1 : d.blackout)), base: 0 };
    }
    if (this.washMats.length && cfg.wash) {
      // palette A blended with white (the texture keeps its own colour), riding the level, the kick and blackouts
      // (a room may fix the wash colour - fire light on stone - instead of following the palette)
      // (the structure layer on: the wash is the set's own light - its structure colour, its slow level and its floor)
      const pe = sIn && !lf.roles ? phraseEase(m) : null;
      const pa = cfg.wash.tint ? hexRgbW(cfg.wash.tint) : sIn ? (lf.roles ? structureColor(lf.roles, 0.3, WC) : spreadStepColor(lf.colors, pe!.step, pe!.ease, 0.3, WC)) : lf.colors[0];
      const W = cfg.wash.white;
      this.washCol.setRGB(W + (1 - W) * pa[0], W + (1 - W) * pa[1], W + (1 - W) * pa[2]).convertSRGBToLinear();
      const k = sIn && structure!.wash ? cfg.wash.strength * this.level * structureLevel(structure!, sIn.target, sIn.pulse, sIn.show) / 0.9
        : cfg.wash.strength * this.level * (1 - d.blackout) * (0.75 + 0.25 * m.kick + 0.4 * d.blinder);
      const kg = this.gov.level(this.washGov, k);
      for (const w of this.washMats) { w.m.emissive.copy(this.washCol); w.m.emissiveIntensity = kg; }
    }
    const pf = d.prev ? lookFrame(this.cat, d.prev, m, d) : null;
    const secPerBeat = 60 / Math.max(40, m.bpm);
    // camera + faces in the room frame (faces only for close shots: wide shots may cross people)
    const cam = rt.root.worldToLocal(rt.stage.camera.getWorldPosition(this.camV));
    const faceList = [...rt.actors.values()].filter((a) => a.shown && a.spot).map((a) => a.faceAt(a.spot!)?.center).filter((c): c is THREE.Vector3 => !!c).map((c) => rt.root.worldToLocal(c.clone()));
    const faces = faceList.some((f) => f.distanceTo(cam) < 9) ? faceList : null;
    // React: a react screen (the big one in front of the stage, or the side screen by the DJ) is in the shot, and every
    // beam / laser / glare between the lens and it would wash over the picture (and over the OBS hole) - the show steps
    // back to a glow while a screen is up (eased over ~0.5 s)
    const scrUp = rt.state.mode === 'react' && ((rt.screen?.target ?? 0) > 0.5 || (rt.solo?.target ?? 0) > 0.5) ? 1 : 0;
    this.reactBack += (scrUp - this.reactBack) * Math.min(1, dt * 2);
    const back = 1 - 0.85 * this.reactBack;
    // the show's own level: the endshow part's master (its blackouts), the background show's cap under a conversation
    const showK = es ? es.f.master * (es.blackout ? 0 : 1) : amb ? Math.min(1, amb.master) : 1;
    // the swell node: an endshow's swell, else the build into a drop (snapping back on the drop)
    const swellWant = es ? es.f.swell : amb ? 0.08 + 0.06 * m.kick : d.section === 'build' ? d.build : 0;
    this.swellNow += (swellWant - this.swellNow) * Math.min(1, dt / (swellWant < this.swellNow - 0.3 ? 0.06 : 0.35));
    if (this.swellNode && cfg.swell) this.swellNode.o.scale.copy(this.swellNode.base).multiplyScalar(1 + (cfg.swell.max - 1) * this.swellNow * (1 + 0.04 * m.kick));
    // the talk set: a neutral key on whoever speaks, rims tinted to the show (scaled with the background's level)
    if (this.talk) {
      const spk = talkMode ? this.speakerFace() : null;
      const pal = lf.colors;
      TA.setRGB(pal[0][0], pal[0][1], pal[0][2]); TB.setRGB(pal[1 % pal.length][0], pal[1 % pal.length][1], pal[1 % pal.length][2]);
      this.talk.update(talkMode, spk ? rt.root.worldToLocal(spk.clone()) : null, cam, STAGE.set(0, cfg.deckY + 8, cfg.deckFront - 10), TA, TB, this.level * showK, dt);
    }
    if (sIn) sIn.base = this.level * back;
    // (a scripted part's beams level eases over ~1 s: never a step)
    this.beamsNow = smoothToward(this.beamsNow, es?.f.part.beams ?? 1, dt, 0.5);
    rig.frame({ d, m, lf, pf, level: this.level * back * Math.max(0.12, showK), master: this.level * back * showK * (1 - (blackoutCue ? 1 : d.blackout)), structure: sIn, beams: this.beamsNow,
      lore: es?.f.text || undefined, eyes: es ? (es.blackout ? 0.1 : es.f.eyes) : 1, swell: this.swellNow, calm: !!amb,
      gate: (key, atBeat) => this.gate.depth(key, atBeat * secPerBeat * 1000), gov: this.gov, safe, warn: wallNotice(ls, nowMs, this.warnUntil),
      nowSec: nowMs / 1000 - this.base, dt, cam, faces, faceList, haze: cfg.haze * back * (0.75 + 0.25 * Math.min(1, m.energy + 0.3)), nowMs: p0 });
    this.djPose(nowMs / 1000, m.beat, d.dropAge * secPerBeat);
    // auto-downgrade: slow frames for 3 s with the show on → one tier lower (rebuild); recovers after 60 s of good frames.
    // Slow = under ~27 fps: an OBS browser source capped at 30 fps runs at 33 ms frames and must not count as slow
    if (!this.noDowngrade && this.level > 0.3 && dt > 0 && dt < 0.5) {
      if (dt > 1 / 27) { this.slow += dt; this.good = 0; } else { this.good += dt; this.slow = Math.max(0, this.slow - dt * 0.5); }
      if (this.slow > 3 && this.tier !== 'low') { this.degrade++; this.slow = 0; this.build(); }
      else if (this.good > 60 && this.degrade > 0) { this.degrade--; this.good = 0; this.build(); }
    }
    const ms = performance.now() - p0;
    this.cost += (ms - this.cost) * 0.05;
  }

  /** is anyone talking now: the Interview voices (src/scene/talkshow/voice.ts), else the room mic's speech flag */
  private talking(): boolean {
    const iv = (window as unknown as { vtpInterview?: { voice?: { level?: Map<string, { v: number; at: number }> } } }).vtpInterview?.voice?.level;
    if (iv && typeof iv.forEach === 'function') { let t = false; const now = performance.now(); iv.forEach((x) => { if (x && x.v > 0.34 && now - x.at < 400) t = true; }); return t; }
    const X = this.music.clock as unknown as { talking?: (t?: number) => boolean };
    try { return !!X.talking?.(this.music.now()); } catch { return false; }
  }
  /** the face to key: the loudest voice in Interview, else the host */
  private speakerFace(): THREE.Vector3 | null {
    const rt = this.rt!;
    let key = '@host', best = 0.3;
    const iv = (window as unknown as { vtpInterview?: { voice?: { level?: Map<string, { v: number; at: number }> } } }).vtpInterview?.voice?.level;
    if (iv && typeof iv.forEach === 'function') { const now = performance.now(); iv.forEach((x, k) => { if (x && now - x.at < 400 && x.v > best && rt.actors.has(k)) { best = x.v; key = k; } }); }
    const a = (rt.actors.get(key) ?? [...rt.actors.values()].find((x) => x.shown && x.spot)) as SceneActor | undefined;
    return a?.spot ? a.faceAt(a.spot)?.center ?? null : null;
  }

  /** the host at the festival's DJ spot plays the decks (src/scene/club/djPose.ts) */
  private djPose(t: number, beat: number, dropAge: number) {
    const rt = this.rt!, cfg = this.cfg!;
    if (!cfg.djSpot) return;
    const host = rt.actors.get('@host') as SceneActor | undefined;
    if (!host) { this.dj?.release(); this.dj = null; return; }
    if (this.dj && this.dj.actor !== host) { this.dj.release(); this.dj = null; }
    const idx = +cfg.djSpot.slice(5) - 1;
    const at = rt.seatOf('@host')?.index === idx && !rt.mover.busy(host) && host.shown;
    if (!this.dj && at) this.dj = new DjPose(host);
    this.dj?.update({ t, beat, dropAge: Number.isFinite(dropAge) ? dropAge : 99, weight: at && rt.state.mode !== 'react' ? 1 : 0 });
  }

  // ---------------------------------------------------------------- test pages / debug
  info() {
    const kinds: Record<string, number> = {};
    for (const f of this.rig?.fixtures ?? []) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
    const d = this.last, m = this.lastMusic, r = this.rig;
    return {
      on: !!this.rt, tier: this.tier, degrade: this.degrade, level: +this.level.toFixed(3), cost: +this.cost.toFixed(3), fixtures: kinds,
      crowd: r?.crowd?.count ?? 0, flats: r?.flats.counts ?? null, rays: r?.lasers.drawn ?? 0, walls: r?.walls?.walls.length ?? 0, killed: this.killed?.size ?? 0,
      source: this.music.source, music: m && { bpm: +m.bpm.toFixed(1), beat: +m.beat.toFixed(2), section: m.section, lastDrop: m.lastDrop, nextDrop: m.nextDrop, known: m.known, drops: m.dropCount, kickOn: m.kickOn, energy: +m.energy.toFixed(2) },
      show: d?.show.name, look: d && { id: d.look.id, name: d.look.name, prev: d.prev?.name ?? null, mix: +d.mix.toFixed(2) }, section: d?.section, countdown: d?.countdown, strobeHz: d && +d.strobeHz.toFixed(2), blackout: d?.blackout, hits: d?.hits.map((h) => `${h.kind}@${h.beat}${h.side ? (h.side < 0 ? 'L' : 'R') : ''}`).slice(0, 24),
      flashes: this.gate.passed.slice(-12).map((t) => Math.round(t)), safe: this.gate.safe, governor: this.gov.stats,
      endshow: this.lastShow.endshow ? { bar: this.lastShow.endshow.f.bar, part: this.lastShow.endshow.f.idx, section: this.lastShow.endshow.f.section, text: this.lastShow.endshow.f.text, cam: this.lastShow.endshow.f.cam || this.cutNow, swell: +this.swellNow.toFixed(2), eyes: this.lastShow.endshow.f.eyes, blackout: this.lastShow.endshow.blackout, script: this.lastShow.endshow.script.name, bars: this.lastShow.endshow.script.bars, master: this.lastShow.endshow.f.master } : null,
      house: { show: d?.show.id ?? null, roles: !!d?.show.roles, structure: +this.structT.toFixed(3), smoke: r?.smoke ? +r.smoke.density.d.toFixed(3) : null, smokeShown: r?.smoke ? +r.smoke.shown.toFixed(4) : null },
      ambient: this.lastShow.ambient ? { big: this.lastShow.ambient.big, master: +this.lastShow.ambient.master.toFixed(2), show: this.lastShow.ambient.show, hits: this.lastShow.ambient.hits.length } : null,
    };
  }
  // ---------------------------------------------------------------- test pages: replay a recorded beat-packet stream
  private rp: { clock: BeatClock; packets: { t: number }[]; i: number; t0: number; start: number } | null = null;
  /** play these packets (e.g. tools/festival/hardstyle_track.ts) through a private clock instead of the page's; null = back to live */
  replay(packets: { t: number }[] | null) {
    if (!packets?.length) { this.rp = null; this.music = festivalMusic; return; }
    const m = new FestivalMusic(); m.clock = new BeatClock();
    this.music = m;
    this.rp = { clock: m.clock, packets: [...packets].sort((a, b) => a.t - b.t), i: 0, t0: packets[0].t, start: Math.floor(Date.now()) };
    m.manualAt = this.rp.start;
  }
  /** move the replay to `ms` after its first packet (deterministic: the clock only advances here) */
  seek(ms: number) {
    const r = this.rp;
    if (!r) return;
    const now = r.start + ms;
    if (now < (this.music.manualAt ?? 0)) { r.clock = new BeatClock(); this.music.clock = r.clock; this.music.reset(); r.i = 0; }
    while (r.i < r.packets.length && r.packets[r.i].t - r.t0 <= ms) { const p = { ...r.packets[r.i], t: r.start + (r.packets[r.i].t - r.t0) }; r.clock.push(p, p.t + 1); r.i++; }
    this.music.manualAt = now;
  }
  /** test pages: the looks / shows */
  catalogue() { return this.cat; }
  /** the drop schedule a show would play (test pages) */
  dropPlan(show: string, drop = 0, count = 1) { const s = this.cat?.showById.get(show); return s ? dropHits(DROP_SEQS[s.drop], drop, count, true, true, this.cfg, s.dropCue) : []; }
}
