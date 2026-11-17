// Drives the club's show-pack rig (packRig.ts) from the page: the beat clock → a rhythm frame (kick / snare / hat
// onsets, or the grid until the rhythm lane's detection lands), the program the room's light director picked for this
// phrase (or the club pool's own pick when the room plays "Match the room"), the show's palette (the same colours as
// the LIGHT_* fixtures), the lighting state, Safe flashes and the faces to keep clear.
// scene.json `club.rig`: { on?: false, boost?: 1..2 } - a room built for a faster GPU draws up to twice the tier's rig.
import * as THREE from 'three';
import type { SceneRuntime } from '../SceneRuntime.ts';
import type { SceneActor } from '../actor.ts';
import type { QualityTier } from '../../tracking/Tracker.ts';
import { beatClock, epochNow } from '../beatClock.ts';
import { interiorBox } from '../fxRig.ts';
import { FestivalGov } from '../festival/gov.ts';
import { showById, showPalette, type DirSection, type MusicFrame } from '../../../shared/lightDirector.ts';
import { OWN_EVERY, packPick, pickProgram, programById } from '../../../shared/showPack/director.ts';
import { newRhythmFrame, rhythmFromClock, sharedSec } from '../../../shared/showPack/rhythm.ts';
import type { PackFrame, Program } from '../../../shared/showPack/program.ts';
import { DEFAULT_LIGHTS } from '../../../shared/scene.ts';
import { PackRig } from './packRig.ts';

const DSEC: Record<string, DirSection> = { intro: 'intro', groove: 'groove', build: 'build', drop: 'drop', breakdown: 'breakdown', outro: 'breakdown' };
const MOOD_LEVEL: Record<string, number> = { room: 0.85, calm: 0.55, club: 1, rave: 1.1 };
/** the house (room materials: walls, floor, bar, the crowd's base light) while the rig plays SHOW with music: the
 *  show owns the room's mood. Per section (a build sinks towards the drop); × MOOD_DIM for the calmer moods. */
const SEC_HOUSE: Record<string, number> = { intro: 0.16, groove: 0.12, build: 0.12, drop: 0.06, breakdown: 0.1, outro: 0.14 };
const MOOD_DIM: Record<string, number> = { room: 1.4, calm: 2.4, club: 1, rave: 0.85 };

/** the rig's tier from the graphics level (as the festival stages: Performance low, Balanced / High high, Ultra ultra;
 *  a page asked for low / medium keeps it on Balanced) */
const LEVEL_TIER: Record<string, QualityTier> = { performance: 'low', balanced: 'high', high: 'high', ultra: 'ultra' };
function tierNow(rt: SceneRuntime): QualityTier {
  const lvl = (rt.constructor as unknown as { levelHook: (() => string) | null }).levelHook?.() ?? 'balanced';
  const page = rt.opts.tier;
  return lvl === 'balanced' && (page === 'low' || page === 'medium') ? page : LEVEL_TIER[lvl] ?? 'high';
}

export class ClubPack {
  rig: PackRig;
  private tier: QualityTier;
  private boost: number;
  private rf = newRhythmFrame();
  /** one frame ahead, as the room's light show (BeatLights.frameLead): the rig's frame and its stage-gate windows land on
   *  the same lead-shifted beat grid as the room governor's (else, at 30 fps, every window waits half a beat) */
  private lead = 1000 / 60;
  private pf: PackFrame = { beat: 0, bar: 0, barPos: 0, bpm: 120, energy: 0, kick: 0, snare: 0, hat: 0, onsets: false, section: 'groove', build: 0, converge: 0, dropAge: Infinity, level: 1, step: 0, mb: 0, safe: true, colors: [[1, 0, 1], [0, 1, 1], [1, 1, 1]] };
  private level = 0;
  /** 1 while a program plays; fades to 0 on the director's own-look phrases */
  private standK = 0;
  /** how far the show has taken the room (0 = the look's house, 1 = SEC_HOUSE) + the section's house level, smoothed */
  private dimK = 0; private houseT = SEC_HOUSE.groove;
  private buildFrom = -Infinity; private sec = '';
  private fr: MusicFrame = { now: 0, beat: 0, bar: 0, barPos: 0, phraseId: 0, phraseBeat: 0, section: 'groove', sectionBeats: 0, intensity: 0, kick: 0, kickAge: Infinity, dropAge: Infinity, buildK: 0, bpm: 120, gate: () => 1 };
  private cam = new THREE.Vector3();
  private pal: [number, number, number][] = [[1, 0, 1], [0, 1, 1], [1, 1, 1]]; private palT = -1;
  private faceBuf: THREE.Vector3[] = []; private faceList: THREE.Vector3[] = []; private facesAt = -Infinity; private settledN = 0; private busyNow: SceneActor[] = []; private busyWas: SceneActor[] = [];
  private gov = new FestivalGov();
  /** the program playing now (debug / tests) */
  program: Program | null = null;
  /** test pages: pin one program (its id) - contact sheets, flash checks */
  pin: string | null = null;
  /** test pages: hold the show's house level (1 = the room as the look says) - A/B checks */
  houseTest: number | null = null;

  private constructor(private rt: SceneRuntime, boost: number) {
    this.boost = boost; this.tier = tierNow(rt); this.gov.bind(rt);
    this.rig = this.build();
  }
  /** the rig for the current tier (rebuilt when the graphics level changes) */
  private build(): PackRig {
    const rt = this.rt, boost = this.boost;
    const room = rt.room, root = rt.root;
    root.updateMatrixWorld(true);
    const local = (o: THREE.Object3D) => root.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
    const nodes = (re: RegExp) => { const o: THREE.Object3D[] = []; root.traverse((x) => { if (re.test(x.name)) o.push(x); }); return o.sort((a, b) => a.name.localeCompare(b.name)).map(local); };
    // the room's inside in room-local coordinates
    const wb = interiorBox(room), lb = new THREE.Box3();
    for (const x of [wb.min.x, wb.max.x]) for (const y of [wb.min.y, wb.max.y]) for (const z of [wb.min.z, wb.max.z]) lb.expandByPoint(root.worldToLocal(new THREE.Vector3(x, y, z)));
    const cfg = (rt.info as unknown as { club?: { djSpot?: string } }).club;
    const m = /(\d+)$/.exec(cfg?.djSpot ?? 'SPOT_01'), sp = room.spots[m ? +m[1] - 1 : 0];
    const dj = sp ? root.worldToLocal(sp.position.clone()) : null;
    return new PackRig(root, lb, dj, this.tier, boost, { beams: nodes(/^FX_BEAM_/), lasers: nodes(/^FX_LASER_/) });
  }
  /** null when the room turns its rig off (scene.json club.rig.on = false) or the tier draws nothing */
  static attach(rt: SceneRuntime): ClubPack | null {
    const rig = (rt.info as unknown as { club?: { rig?: { on?: boolean; boost?: number } } }).club?.rig;
    if (rig?.on === false) return null;
    try { return new ClubPack(rt, typeof rig?.boost === 'number' ? rig.boost : 1); } catch (e) { console.warn('club pack rig failed', e); return null; }
  }

  update(dt: number) {
    const t = tierNow(this.rt);
    if (t !== this.tier) { this.tier = t; this.rig.dispose(); this.rig = this.build(); }
    const rt = this.rt, st = rt.state.lights ?? DEFAULT_LIGHTS, C = beatClock;
    if (dt > 0 && dt < 0.1) this.lead += (Math.min(40, dt * 1000) - this.lead) * 0.05;   // (the same EMA as BeatLights)
    const wall = epochNow(), now = wall - (st.delay ?? 0) + this.lead;
    const mood = st.mood ?? 'room';
    const music = C.active(wall) && C.mode !== 'talk';
    const state = st.state ?? 'show';
    const want = st.reactive && music && (state === 'show' || state === 'react') ? (MOOD_LEVEL[mood] ?? 0.85) * Math.min(1.2, st.intensity) * (state === 'react' ? 0.5 : 1) : 0;
    this.level += (want - this.level) * (1 - Math.exp(-dt / (want > this.level ? 0.4 : 1.2)));
    if (Math.abs(want - this.level) < 1e-3) this.level = want;
    // the room goes dark for the show (SHOW + Reactive lights + music); talking, REACT, BRB, no music: the house comes
    // back (the performers' own key light is never dimmed: faces stay lit in every state)
    // (only while this tier's rig draws something: a low tier / an auto step-down to Performance keeps the house up)
    const B = this.rig.budget, draws = B.heads + B.bars + B.lasers + B.ceiling > 0;
    const dimOn = draws && want > 0 && state === 'show' ? 1 : 0;
    this.dimK += (dimOn - this.dimK) * (1 - Math.exp(-dt / (dimOn > this.dimK ? 1.4 : 0.7)));
    if (Math.abs(dimOn - this.dimK) < 1e-3) this.dimK = dimOn;
    this.setDim();
    if (this.level <= 0.003) { this.program = null; this.rig.update({ program: null, f: this.pf, level: 0, gov: this.gov, safe: true, cam: this.cam, faces: null, dt, t: sharedSec(now) }); return; }
    // the moment
    const rf = rhythmFromClock(C, now, this.rf, this.buildFrom);
    if (rf.section !== this.sec) { if (rf.section === 'build') this.buildFrom = now; this.sec = rf.section; }
    const phraseId = Number.isFinite(C.phraseId) ? C.phraseId : Math.floor(rf.bar / 8) + C.dropSeq;
    const dsec = DSEC[rf.section] ?? 'groove';
    const hs = (rf.section === 'build' ? SEC_HOUSE.build - (SEC_HOUSE.build - SEC_HOUSE.drop) * rf.build : SEC_HOUSE[rf.section] ?? SEC_HOUSE.groove) * (MOOD_DIM[mood] ?? 1);
    this.houseT += (Math.min(1, hs) - this.houseT) * (1 - Math.exp(-dt / 0.9));
    // the program: the director's pick for this mood (Club / Rave / Calm) - on its phrases that play the show's own
    // look the rig stands down (the same pick when the director isn't running here); the club pool's own on Match the room
    const pool = mood === 'rave' ? 'rave' : mood === 'calm' ? 'calm' : 'club';
    const fr = this.fr; fr.section = dsec; fr.bpm = rf.bpm; fr.phraseId = phraseId; fr.beat = rf.beat; fr.bar = rf.bar;
    const hook = mood === 'room' ? undefined : packPick(mood);
    const want2 = (this.pin ? programById(this.pin) : null) ?? (mood === 'room' ? pickProgram(pool, fr, 0) : hook !== undefined ? hook : pickProgram(pool, fr, OWN_EVERY[mood] ?? 4));
    // (a stand-down fades over half a second with the last program; a new program cuts in at the phrase)
    if (want2) { this.program = want2; this.standK = 1; }
    else this.standK *= Math.exp(-dt / 0.35);
    if (!want2 && this.standK < 0.01) { this.standK = 0; this.program = null; }
    // colours: the show's palette (what the room's own fixtures play)
    const show = showById(mood === 'room' ? 'club' : mood) ?? showById('club');
    const safe = st.safe !== false;
    const pf = this.pf;
    pf.beat = rf.beat; pf.bar = rf.bar; pf.barPos = rf.barPos; pf.bpm = rf.bpm; pf.energy = rf.energy; pf.kick = rf.kick; pf.snare = rf.snare; pf.hat = rf.hat; pf.onsets = rf.onsets; pf.rhythm = rf.rhythm; pf.plan = rf.plan; pf.drums = rf.drums; pf.feel = rf.feel;
    pf.section = rf.section; pf.build = rf.build; pf.converge = rf.section === 'build' ? Math.pow(rf.build, 1.5) * 0.6 : 0; pf.dropAge = rf.dropAge; pf.step = 0;   // (the phrase's colour step: the palette below rotates instead, crossfaded)
    // (a new phrase's colours crossfade in ~0.5 s, as the director's do: an instant swap against the room's own lights
    //  changing a moment apart turned the whole frame twice)
    if (show) {
      const tg = showPalette(show, fr), a = this.palT < 0 ? 1 : 1 - Math.exp(-dt / 0.5);
      // (each phrase rotates the palette by one - what the programs' per-phrase colour step does - so the fixtures' colours
      //  move on at a new phrase through the crossfade instead of all swapping on one frame)
      const ph = ((phraseId % tg.length) + tg.length) % tg.length;
      for (let k = 0; k < 3; k++) { const t = tg[(k + ph) % tg.length], c = this.pal[k]; for (let j = 0; j < 3; j++) c[j] += (t[j] - c[j]) * a; }
      this.palT = 1; pf.colors = this.pal;
    }
    // camera + faces (room-local)
    const root = rt.root;
    rt.stage.camera.getWorldPosition(this.cam); root.worldToLocal(this.cam);
    // (every shot: in a club the rig is close to the performers - nothing may cross a face, wide shots included;
    //  the settled performers refreshed 5 times a second into reused vectors; a walker's LIVE face every frame - the
    //  rest face carried by its lift: walk bob, a sit's drop, a mascot's face - with no allocation)
    // (who walks, in the map's stable order, into a reused list: any change - one stops as another starts - re-reads the
    //  settled faces at once)
    const busy = this.busyNow; busy.length = 0;
    for (const a of rt.actors.values()) if (a.shown && rt.mover.busy(a)) busy.push(a);
    let changed = busy.length !== this.busyWas.length;
    for (let k = 0; !changed && k < busy.length; k++) changed = busy[k] !== this.busyWas[k];
    if (changed) { this.busyNow = this.busyWas; this.busyWas = busy; }
    const walkers = busy.length;
    if (changed || wall - this.facesAt > 200 || wall < this.facesAt) {
      this.facesAt = wall; let n = 0;
      for (const a of rt.actors.values()) {
        if (!a.shown || !a.spot || rt.mover.busy(a)) continue;
        const c = a.faceAt(a.spot)?.center; if (!c) continue;
        root.worldToLocal((this.faceBuf[n] ??= new THREE.Vector3()).copy(c)); n++;
      }
      this.settledN = n;
    }
    let n = this.settledN;
    if (walkers) for (const a of busy) {
      const v = (this.faceBuf[n] ??= new THREE.Vector3());
      if (a.rest) a.lift.localToWorld(v.copy(a.rest.face.center));
      else { a.mount.getWorldPosition(v); v.y += 1.6 * a.scale * 0.9; }
      root.worldToLocal(v); n++;
    }
    this.faceList.length = 0; for (let k = 0; k < n; k++) this.faceList.push(this.faceBuf[k]);
    const faces = this.faceList.length ? this.faceList : null;
    // (the effects rig of a PRESHOW-style look plays its own beams: share the room)
    const fxOn = (rt.lights as unknown as { fx?: { group?: THREE.Object3D } }).fx?.group?.visible ? 0.5 : 1;
    this.gov.frame(now, rf.beat, rf.bpm, C.locked, safe);
    this.rig.update({ program: this.program, f: pf, level: this.level * fxOn * this.standK, gov: this.gov, safe, cam: this.cam, faces, dt, t: sharedSec(now) });
  }

  /** the house level the show asks the room for (BeatLights.showDim; 1 = untouched) */
  private setDim() {
    const L = this.rt.lights as unknown as { showDim?: number };
    if (typeof L.showDim === 'number') L.showDim = this.houseTest ?? 1 - this.dimK * (1 - this.houseT);
    this.rig.hazeK = this.dimK;
  }
  info() { return { tier: this.tier, boost: this.boost, level: +this.level.toFixed(2), house: +(1 - this.dimK * (1 - this.houseT)).toFixed(3), program: this.program ? { id: this.program.id, name: this.program.name, family: this.program.family } : null, ...this.rig.counts }; }
  dispose() {
    this.rig.dispose(); this.gov.unbind();
    const L = this.rt.lights as unknown as { showDim?: number };
    if (typeof L.showDim === 'number') L.showDim = 1;
  }
}
