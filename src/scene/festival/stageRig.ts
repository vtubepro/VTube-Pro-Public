// The festival rig: every renderer of a stage (moving heads, PARs / strobes / blinders / pixels, lasers, LED walls,
// special effects, the crowd, lens glare) built from a list of fixtures, and driven each frame from one director frame.
// Used by the room engine (festivalScene.ts: fixtures from the room's FX_ anchors) and by the Look Lab's mini stage
// (src/scene/festival/lab: fixtures built in code) - the same code, so a look reads the same in both.
import { WALL_CALM, wallPulse } from '../../../shared/festivalWall.ts';
import * as THREE from 'three';
import { FESTIVAL_BUDGET, budgetFor, hash3, pickSubset, type FestivalConfig, type FxKind, type Tier } from '../../../shared/festival.ts';
import type { FestivalGov, GovOwner } from './gov.ts';
import type { DirectorFrame, LookFrame, MusicState } from '../../../shared/festivalDirector.ts';
import { Glare, lin, type Fixture } from './common.ts';
import { MoverRig } from './movers.ts';
import { FlatRig } from './fixtures.ts';
import { LaserRig } from './lasers.ts';
import { flamePattern } from './flameShots.ts';

const byX = (a: Fixture, b: Fixture) => a.pos.x - b.pos.x;
import { LedWalls, visualIndex } from './ledWall.ts';
import { Pyro, type PyroEvent } from './pyro.ts';
import { Crowd, type CrowdArea } from './crowd.ts';
import type { StructureIn } from './fixtures.ts';
import { SmokeCeiling, type SmokeFrameIn } from './smokeCeiling.ts';
import type { SmokeCfg } from '../../../shared/festivalSmoke.ts';
import { FAN_DEFAULTS, fanMode, fanScale, fanSlots, isFanStyle, packFan, tiltAim, type FanSpec } from '../../../shared/festivalFans.ts';
import type { SfxHit } from '../../../shared/festivalDirector.ts';

const smooth = (x: number) => { const k = Math.min(1, Math.max(0, x)); return k * k * (3 - 2 * k); };
const C1 = new THREE.Color(), C2 = new THREE.Color(), C3 = new THREE.Color(), CW = new THREE.Color(), CT = new THREE.Color();

/** The tier's fixtures: an even, deterministic subset per class, each with its normalised place (FixGeo). */
/** The fixtures a tier draws: per kind an even subset within the budget; a group a cue names (`must`: "kind:GROUP" -
 *  the tongue laser, the sky searchlights, a hero flame) always keeps at least one unit (up to twice the budget). */
export function tierFixtures(all: Fixture[], tier: Tier, must: Set<string> = new Set(), boost = 1): Fixture[] {
  const byKind = new Map<FxKind, Fixture[]>();
  for (const f of all) { const l = byKind.get(f.kind) ?? []; l.push(f); byKind.set(f.kind, l); }
  const box = new THREE.Box3();
  for (const f of all) box.expandByPoint(f.pos);
  const sz = box.getSize(new THREE.Vector3()), cx = (box.min.x + box.max.x) / 2;
  const keep: Fixture[] = [];
  for (const [kind, list] of byKind) {
    list.sort((a, b) => a.group.localeCompare(b.group) || a.index - b.index);
    const n = kind === 'ledwall' ? list.length : Math.min(list.length, Math.round(budgetFor(tier, kind) * boost));
    let pick = pickSubset(list.length, n).map((i) => list[i]);
    if (kind !== 'ledwall') {
      const need: Fixture[] = [];
      for (const g of new Set(list.map((f) => f.group))) if (must.has(`${kind}:${g}`) && !pick.some((f) => f.group === g)) { const f = list.find((x) => x.group === g); if (f) need.push(f); }
      if (need.length) {
        const cap = Math.max(n, Math.min(list.length, n * 2));
        // the named groups first, then the even subset of the rest
        const rest = pick.filter((f) => !need.includes(f));
        pick = [...need, ...rest].slice(0, Math.max(cap, need.length));
        pick.sort((a, b) => a.group.localeCompare(b.group) || a.index - b.index);
      }
    }
    const order = [...pick].sort((a, b) => a.pos.x - b.pos.x || a.pos.y - b.pos.y);
    pick.forEach((f) => {
      f.geo.x = sz.x > 0.01 ? (f.pos.x - cx) / (sz.x / 2) : 0;
      f.geo.y = sz.y > 0.01 ? (f.pos.y - box.min.y) / sz.y : 0.5;
      f.geo.z = sz.z > 0.01 ? (f.pos.z - box.min.z) / sz.z : 0.5;
      f.geo.i = order.indexOf(f); f.geo.n = pick.length;
      f.geo.seed = hash3(f.index, f.group.charCodeAt(0) + f.group.length * 31, f.kind.length);
    });
    keep.push(...pick);
  }
  return keep;
}

export interface WallSpec { mesh: THREE.Mesh; role: 'main' | 'side' | 'eye'; visual?: string; mirror?: boolean; pupil?: 'round' | 'slit'; iris?: string }
export interface RigFrameIn {
  d: DirectorFrame; m: MusicState; lf: LookFrame; pf: LookFrame | null;
  /** show level 0..1.5 (lighting state × intensity), master after blackouts */
  level: number; master: number;
  /** photosensitivity gate (key, at beat) → depth; safe flag; wall warning */
  gate: (key: string, atBeat: number) => number; safe: boolean; warn: 'off' | 'badge' | 'card';
  /** the photosensitivity governor every drawn output passes (the room's, shared with the light show) */
  gov: FestivalGov;
  nowSec: number; dt: number;
  /** camera + faces (room frame); faces null = wide shot (beams may cross people) */
  cam: THREE.Vector3; faces: THREE.Vector3[] | null; faceList: THREE.Vector3[];
  haze: number; nowMs: number;
  /** a scripted show's lore line on the main walls, the eyes open 0..1, the swell node 0..1 */
  lore?: string; eyes?: number; swell?: number;
  /** Talk / Interview background: no strobes / blinders / white hits, lasers kept high above the crowd */
  calm?: boolean;
  /** the structure (keylight) layer this frame (null = the pixel bars follow the look, as before) */
  structure?: Omit<StructureIn, 'rf'> | null;
  /** the moving heads' level (a scripted part's `beams`; default 1) */
  beams?: number;
}

const PC1 = new THREE.Color(), PC2 = new THREE.Color(), GOLD = new THREE.Color(1.0, 0.62, 0.22), WHITE = new THREE.Color(1, 0.97, 0.9), PC3 = new THREE.Color(), SMOKE = new THREE.Color(0.72, 0.7, 0.68), SMOKE_FW = new THREE.Color(0.12, 0.11, 0.1);
const V1 = new THREE.Vector3(), AIM = new THREE.Vector3(), AIM2 = new THREE.Vector3(), FO = new THREE.Vector3();
const FA = [0, 0, 0];

export class StageRig {
  readonly root = new THREE.Group();
  readonly fixtures: Fixture[];
  readonly movers: MoverRig; readonly flats: FlatRig; readonly lasers: LaserRig; readonly pyro: Pyro;
  walls: LedWalls | null = null; crowd: Crowd | null = null; readonly glare: Glare | null;
  private flameT: Float32Array; private flameS: Float32Array; private flameWas = new Uint8Array(512);
  /** flamePatterns scratch (no allocation per frame) */
  private patIdx: number[] = []; private patSel: Fixture[] = [];
  /** the sky light of shells bursting now (0..1, governed): crowd + set light */
  skyGlow = 0;
  private skyGov: GovOwner = {};
  private flameGov: GovOwner[] = []; private wallGov: GovOwner[] = [{}, {}, {}]; private crowdGov: GovOwner[] = [{}, {}, {}];
  private t0Keys = new Map<string, number>();
  /** fire light: real point lights over clusters of flame heads (rooms with festival.fireLights) */
  private fire: { light: THREE.PointLight; heads: number[]; o: GovOwner }[] = [];
  /** the lit smoke ceiling + flame halos (festival.smoke / the house look), and this frame's pyro events for it */
  smoke: SmokeCeiling | null = null;
  /** a smoke whose show ended, thinning away (disposed once it is gone) */
  private smokeGone: SmokeCeiling | null = null;
  /** the shells' mortar x positions (the smoke is lit round them), the renderer to compile a new smoke ahead with */
  private shellXs: number[] = [];
  private warmWith: { r: THREE.WebGLRenderer; c: THREE.Camera; s: THREE.Scene } | null = null;
  private smokeIn: SmokeFrameIn | null = null;
  private ev = { shells: 0, volleys: 0, fans: 0 };
  private anyFlameWas = false;
  /** a comet cue naming a group with no comets fires from that group's other effect anchors (flame heads on a roofline):
   *  the anchors per group, read once */
  private sfxByGroup = new Map<string, Fixture[]>();
  private stageBox = new THREE.Box3();

  constructor(fixtures: Fixture[], readonly tier: Tier, readonly cfg: FestivalConfig, walls: WallSpec[], areas: CrowdArea[], seats: THREE.Vector3[], roomBox: THREE.Box3) {
    this.root.name = 'festival';
    this.fixtures = fixtures;
    const B = FESTIVAL_BUDGET[tier];
    this.glare = B.flares ? new Glare(fixtures.filter((f) => ['beam', 'spot', 'wash', 'par', 'strobe', 'blinder'].includes(f.kind)).length + 4) : null;
    this.movers = new MoverRig(fixtures.filter((f) => f.kind === 'beam' || f.kind === 'spot' || f.kind === 'wash'), tier, this.glare, roomBox);
    this.flats = new FlatRig(fixtures, tier, this.glare);
    this.lasers = new LaserRig(fixtures, tier);
    this.pyro = new Pyro(fixtures, tier, cfg.fxScale, cfg.boost, cfg.flameWidth, cfg.shellScale, cfg.flameScale);
    this.flameT = new Float32Array(this.pyro.flameCount); this.flameS = new Float32Array(this.pyro.flameCount);
    for (const g of [this.movers.group, this.flats.group, this.lasers.group, this.pyro.group]) this.root.add(g);
    if (this.glare) this.root.add(this.glare.mesh);
    const fl = cfg.fireLights;
    if (fl && tier !== 'low') {
      const heads = this.pyro.heads.map((f, i) => ({ f, i })).filter((h) => fl.groups.includes(h.f.group)).sort((a, b) => a.f.pos.x - b.f.pos.x);
      const n = Math.min(fl.count, heads.length);
      for (let k = 0; k < n; k++) {
        const part = heads.slice(Math.floor((k * heads.length) / n), Math.floor(((k + 1) * heads.length) / n));
        if (!part.length) continue;
        const c = part.reduce((a, h) => a.add(h.f.pos), new THREE.Vector3()).multiplyScalar(1 / part.length);
        const light = new THREE.PointLight(0xff7a26, 0, fl.range, 1.6);
        light.position.copy(c).add(new THREE.Vector3(0, 5, 2)); light.castShadow = false; light.name = 'festival:fire-light';
        this.root.add(light);
        this.fire.push({ light, heads: part.map((h) => h.i), o: {} });
      }
    }
    if (walls.length) this.walls = new LedWalls(walls);
    if (areas.length && B.crowd > 0) this.setCrowd(areas, seats);
    for (const f of fixtures) {
      if (f.kind === 'flame' || f.kind === 'firework' || f.kind === 'gerb' || f.kind === 'comet') { const l = this.sfxByGroup.get(f.group) ?? []; l.push(f); this.sfxByGroup.set(f.group, l); }
      if (f.kind !== 'firework' && f.kind !== 'laser') this.stageBox.expandByPoint(f.pos);
      else if (f.kind === 'firework') this.shellXs.push(f.pos.x);
    }
    if (this.stageBox.isEmpty()) this.stageBox.copy(roomBox);
    // (comet fans climb to ~1.15 x the stage height: their speed from the set's height, x the room's effect scale)
    this.pyro.sparks.scale = fanScale(this.stageBox.max.y - cfg.deckY, cfg.fxScale);
    if (cfg.smoke) this.setSmoke(cfg.smoke);
  }

  /** the lit smoke on / off (the house look of a scripted show can turn it on in a room without festival.smoke) */
  setSmoke(sc: SmokeCfg | null) {
    if (!!sc === !!this.smoke && (!sc || this.smoke?.cfg === sc)) return;
    // (the show that brought it ended: it thins away over a few seconds - never gone in one frame)
    if (this.smoke) { this.smokeGone?.dispose(); this.smokeGone = this.smoke; this.smokeGone.fadeOut = true; this.smoke = null; }
    if (!sc) return;
    const zS = Math.pow(this.cfg.fxScale, 0.8) * Math.sqrt(this.cfg.flameScale);
    this.smoke = new SmokeCeiling(sc, this.stageBox, this.cfg.deckY, this.pyro.heads, 3.3 * zS * this.cfg.flameWidth, this.shellXs);
    this.root.add(this.smoke.group);
    // (compiled ahead: a show that brings the smoke mid-stream never hitches on its shader)
    if (this.warmWith) this.smoke.warm(this.warmWith.r, this.warmWith.c, this.warmWith.s);
  }

  setCrowd(areas: CrowdArea[], seats: THREE.Vector3[], unit?: ConstructorParameters<typeof Crowd>[5]) {
    this.crowd?.dispose();
    this.crowd = new Crowd(areas, seats, this.tier, this.cfg.crowd.color, this.cfg.crowd.density, unit, this.cfg.crowd.boost, this.cfg.crowd.flags, this.cfg.crowd.flagColors, this.cfg.crowd.lit, this.cfg.crowd.flagsFar);
    if (this.cfg.crowd.rim) this.crowd.rimTint = new THREE.Color(this.cfg.crowd.rim).convertSRGBToLinear();
    this.crowd.setTop(this.cfg.crowd.top);
    this.root.add(this.crowd.mesh);
    if (this.crowd.flags) this.root.add(this.crowd.flags);
  }

  frame(i: RigFrameIn) {
    const { d, m, lf, pf, level, master, gate, gov, nowSec, dt, cam, faces, haze } = i;
    const secPerBeat = 60 / Math.max(40, m.bpm);
    if (level > 0.003) {
      this.root.visible = true;
      // Safe flashes ON: the movers move on a calm clock (<= 0.75 beats a second, smooth snaps / shakes / pumps): a sweep of
      // bright beams across the frame is a luminance change the governors never see
      // (<= 0.75 motion beats a second: a beam sweeping back and forth passes a region twice a cycle)
      if (i.safe) { const k = Math.min(1, 45 / Math.max(40, m.bpm)); lf.motionBeat = m.beat * k; if (pf) pf.motionBeat = m.beat * k; lf.safe = true; if (pf) pf.safe = true; }
      this.movers.update({ look: lf, prev: pf, mix: d.mix, master: master * (i.beams ?? 1), gate, gov, calm: !!i.calm, safe: i.safe, beamGain: this.cfg.beamGain, time: nowSec, cam, faces, floorY: this.cfg.floorY, deckY: this.cfg.deckY, deckFront: this.cfg.deckFront, haze });
      this.flats.update({ look: lf, prev: pf, mix: d.mix, d, master: level * (1 - d.blackout * 0.95), gate, gov, calm: !!i.calm, time: nowSec, dt, haze, cam, structure: i.structure ? { ...i.structure, rf: lf.roles ?? null } : null });
      this.lasers.gain = this.cfg.laserGain ?? 1; this.lasers.safe = i.safe; this.lasers.dt = dt; this.pyro.safe = i.safe;
      this.lasers.update(lf, pf, d.mix, d.section, master, gate, faces, cam, gov, d.hits, m.beat, !!i.calm);
      this.glare?.commit();
      this.pyroFrame(d, m, nowSec, dt, secPerBeat, lf.colors, gov);
      // the lit smoke (rooms with festival.smoke / the house look): built up by this frame's pyro, lit by the fire, the
      // shells and the part's colour; scaled with the show level (a React screen up: stepped back with the rest)
      if (this.smoke || this.smokeGone) {
        const si = (this.smokeIn ??= { dt, time: nowSec, shells: 0, volleys: 0, fans: 0, sky: 0, skyCol: lf.colors[0], level, haze, headLevel: this.headLevel, gov });
        si.dt = dt; si.time = nowSec; si.shells = this.ev.shells; si.volleys = this.ev.volleys; si.fans = this.ev.fans; si.sky = this.skyGlow; si.skyCol = lf.colors[0]; si.level = level; si.haze = haze; si.gov = gov;
        this.smoke?.update(si);
        if (this.smokeGone) { this.smokeGone.update(si); if (this.smokeGone.done) { this.smokeGone.dispose(); this.smokeGone = null; } }
      }
      const c = lf.colors;
      C1.setRGB(lin(c[0][0]), lin(c[0][1]), lin(c[0][2])); C2.setRGB(lin(c[1 % c.length][0]), lin(c[1 % c.length][1]), lin(c[1 % c.length][2])); C3.setRGB(lin(c[2 % c.length][0]), lin(c[2 % c.length][1]), lin(c[2 % c.length][2]));
      if (this.walls) {
        const vis = visualIndex(d.look.wall), pvis = d.prev ? visualIndex(d.prev.wall) : vis;
        const cd = d.countdown != null && d.countdown <= 8 ? d.countdown : null;
        const logo = d.dropAge >= 0 && d.dropAge < 4 ? 1 - smooth((d.dropAge - 2) / 2) : 0;
        // the walls as lights: their level (with blackouts), the white flash and the kick that pulses their visuals each
        // pass the governor (one channel each for all walls: they change together)
        const wflash = gov.level(this.wallGov[0], d.white * gate(d.whiteKey, m.lastDrop) * 0.6);
        const wlevel = gov.level(this.wallGov[1], Math.max(0.15, level) * (1 - d.blackout * 0.9));
        // Safe flashes ON: the walls breathe on a smooth cosine pulse, one per FOUR stage-gate windows (<= 0.75 a second,
        // shared/festivalWall.ts wallPulse) instead of the kick. It is slow by construction, so it does not go through the
        // governor: a governed smooth pulse would be held at its peak and stepped down at the next window (a square wave);
        // tools/festival_gov_unit.ts measures what the walls DRAW instead. With the limit off, the governed kick.
        const wkick = i.safe ? 0.25 + 0.75 * wallPulse(m.beat, m.bpm) : gov.level(this.wallGov[2], 0.25 + 0.75 * m.kick);
        this.walls.text({ title: cd == null && d.section === 'breakdown' ? (this.cfg.title || '') : '', count: cd, warn: i.warn, show: d.show.name, ...(i.lore ? { lore: i.lore } : {}) });
        // wall patterns move on the beat (rings sweep a dark gap per beat …): half time above 180 BPM; with Safe flashes ON
        // at half / quarter time and half speed, so a patch of the wall (1 m from the booth camera … 4 m from the wide
        // shot) never flashes more than 3 times a second (tools/festival_gov_unit.ts measures the drawn patches)
        this.walls.update({ t: i.safe ? nowSec * WALL_CALM.t : nowSec, beat: m.beat * (i.safe ? (m.bpm > 180 ? WALL_CALM.fast : WALL_CALM.slow) : m.bpm > 180 ? 0.5 : 1), kick: Math.max(0, (wkick - 0.25) / 0.75), energy: m.energy, level: wlevel, black: 0, flash: wflash, drop: d.dropAge >= 0 && d.dropAge < 32 ? 1 - smooth((d.dropAge - 24) / 8) : 0,
          a: C1, b: C2, c: C3, mode: d.prev ? pvis : vis, next: vis, mix: d.prev ? d.mix : 1, logo, open: i.eyes ?? 1, swell: i.swell ?? 0 }, {}, cd != null || d.section === 'breakdown' || i.warn !== 'off' || i.lore ? 1 : 0);
      }
      if (this.crowd) {
        const sec = d.section;
        const hands = sec === 'drop' ? 0.95 : sec === 'build' ? 0.25 + 0.7 * d.build : sec === 'groove' ? 0.35 : sec === 'breakdown' ? 0.25 : 0.1;
        this.crowd.update({ beat: m.beat, kick: m.kick, hands: hands * Math.min(1, level + 0.2), jump: sec === 'drop' ? 1 : sec === 'groove' ? 0.55 : sec === 'build' ? 0.25 : 0, sway: sec === 'breakdown' || sec === 'intro' || sec === 'outro' ? 1 : 0.35,
          phones: sec === 'breakdown' ? 1 : sec === 'intro' || sec === 'outro' ? 0.5 : 0, time: nowSec, level: gov.level(this.crowdGov[2], Math.max(0.2, level) * (1 - d.blackout * 0.8)),
          // (a show with colour roles: the crowd wash in its second colour)
          wash: (lf.roles ? CW.setRGB(lin(lf.roles.crowd[0]), lin(lf.roles.crowd[1]), lin(lf.roles.crowd[2])) : CW.copy(C1)).multiplyScalar(gov.level(this.crowdGov[0], 0.9 + 0.6 * m.kick)), top: CT.copy(C2).multiplyScalar(gov.level(this.crowdGov[1], 0.7 + this.flats.flashNow * 4 + this.pyro.heat * 0.6 + this.skyGlow * 1.5)) });
        this.crowd.protect(cam, i.faceList, i.nowMs);
      }
    } else {
      this.root.visible = false;
      if (this.walls) this.walls.update({ t: nowSec, beat: m.beat, kick: 0, energy: 0, level: 0.15, black: 0, flash: 0, drop: 0, a: C1.setRGB(0.2, 0.2, 0.25), b: C2.setRGB(0.1, 0.1, 0.2), c: C3.setRGB(0.1, 0.2, 0.2), mode: visualIndex('logo'), next: visualIndex('logo'), mix: 1, logo: 0.6 }, {}, i.warn !== 'off' ? 1 : 0);
    }
  }

  /** the director's hits → flame targets + particle events on the right anchors. A hit with an `order` is a chase
   *  across its units over `span` beats (left → right, centre → out …); styles pick the variant (green / hero flames,
   *  waterfalls, mines, willow / salute / crossette / glitter shells). Shells burst ON the hit's beat: launched their
   *  lift time earlier (from the anchor's `height`, default ~30 m). */
  private pyroFrame(d: DirectorFrame, m: MusicState, nowSec: number, dt: number, secPerBeat: number, colors: [number, number, number][], gov: FestivalGov) {
    const py = this.pyro;
    py.tick(nowSec);
    this.flameT.fill(0); this.flameS.fill(0);
    const heads = py.heads;
    const cfg = this.cfg;
    const col = PC1.setRGB(lin(colors[0][0]), lin(colors[0][1]), lin(colors[0][2])), col2 = PC2.setRGB(lin(colors[1 % colors.length][0]), lin(colors[1 % colors.length][1]), lin(colors[1 % colors.length][2]));
    const sideOk = (f: Fixture, s: number) => s === 0 || (s < 0 ? f.geo.x <= 0.05 : f.geo.x >= -0.05);
    let sky = 0;
    this.ev.shells = 0; this.ev.volleys = 0; this.ev.fans = 0;
    for (const h of d.hits) {
      if (h.kind === 'blinder' || h.kind === 'laser') continue;
      const kind = h.kind as FxKind;
      let units = kind === 'flame' ? heads : this.fixtures.filter((f) => f.kind === kind);
      // (a comet cue on a group with no comet anchors: the group's other effect anchors launch them - flame heads on a
      //  roofline make a sunburst / roof fans in a room built without comets up there)
      if (kind === 'comet' && h.group && !units.some((f) => f.group === h.group)) units = this.sfxByGroup.get(h.group) ?? units;
      const sel: Fixture[] = [];
      for (const f of units) if ((!h.group || f.group === h.group) && sideOk(f, h.side)) sel.push(f);
      if (!sel.length) continue;
      // a shell / comet hit without a chase fires a few of the group's mortars (by its seed), not every one of them
      if ((kind === 'firework' || kind === 'comet') && !h.order && sel.length > 3 && !isFanStyle(h.style)) {
        // (a room can fire more shells per hit: a wider battery, the same timing - festival.shellsPerHit)
        const n = kind === 'firework' ? Math.round((h.style === 'salute' ? 3 : h.power >= 1.3 ? 2 : 1) * cfg.shellsPerHit) : h.power >= 1.15 || h.style === 'mine' ? sel.length : 2;
        if (n < sel.length) { const pick: Fixture[] = []; for (let j = 0; j < n; j++) { const f = sel[Math.floor(hash3(h.seed, j, 77) * sel.length) % sel.length]; if (!pick.includes(f)) pick.push(f); } sel.length = 0; sel.push(...pick); }
      }
      // (festival.flamePatterns: a flame hit without its own chase fires a pattern across the row, not every head at once -
      // the bar picks it: centre-out pairs, L->R, R->L, every 4th; the whole row only on a big hit)
      if (kind === 'flame' && cfg.flamePatterns && !h.order && !h.shape && h.power < 1.3 && sel.length > 4) {
        sel.sort(byX);
        flamePattern(sel.length, h.beat, this.patIdx);
        this.patSel.length = 0; for (const i of this.patIdx) this.patSel.push(sel[i]);
        sel.length = 0; for (const f of this.patSel) sel.push(f);
      }
      // the chase: each unit's delay (beats) from its place across the group
      let lo = Infinity, hi = -Infinity;
      if (h.order || h.shape) for (const f of sel) { lo = Math.min(lo, f.pos.x); hi = Math.max(hi, f.pos.x); }
      const delayOf = (f: Fixture, i: number) => {
        if (!h.order) return 0;
        const u = hi > lo ? (f.pos.x - lo) / (hi - lo) : 0.5;
        const span = h.span ?? 1;
        switch (h.order) {
          case 'lr': return u * span;
          case 'rl': return (1 - u) * span;
          case 'out': return Math.abs(u - 0.5) * 2 * span;
          case 'in': return (1 - Math.abs(u - 0.5) * 2) * span;
          case 'wave': return u * span;
          case 'alt': return (i % 2) * span * 0.5;
        }
        return 0;
      };
      if (kind === 'flame') {
        const shape = h.shape ? cfg.shapes[h.shape] : null;
        const style = (h.style === 'green' ? 1 : 0) + (h.style === 'hero' ? 2 : 0);
        sel.forEach((f, si) => {
          const b0 = h.beat + delayOf(f, si);
          // a wave overlaps its neighbours (a rolling flame), a plain chase fires each unit for `dur`
          const dur = h.order === 'wave' ? Math.max(h.dur, (h.span ?? 1) * 0.35) : h.dur;
          if (m.beat < b0 || m.beat > b0 + dur) return;
          let pw = h.power;
          if (shape) {
            const x = hi > lo ? ((f.pos.x - lo) / (hi - lo)) * 2 - 1 : 0;
            let top = -1;
            for (let k = 0; k < shape.length; k += 2) if (Math.abs(shape[k] - x) < 0.13) top = Math.max(top, shape[k + 1]);
            pw = top < -0.95 ? 0 : 0.3 + 1.1 * (top + 1) / 2;
          }
          const i = heads.indexOf(f);
          if (pw > this.flameT[i]) { this.flameT[i] = pw; this.flameS[i] = style; }
        });
        continue;
      }
      const life = kind === 'confetti' ? 14 : kind === 'firework' ? (h.style === 'willow' ? 7 : 4.5) : kind === 'co2' ? 4 : h.style === 'waterfall' ? 4 : 2.5;
      const hitT = nowSec - (m.beat - h.beat) * secPerBeat;           // page time of the hit's beat
      // comet fans / rows (shared/festivalFans.ts): one event per origin carries the whole fan
      if (kind === 'comet' && isFanStyle(h.style)) { this.placeFans(h, sel, hitT, nowSec, secPerBeat, col, col2, lo, hi, delayOf); continue; }
      sel.forEach((f, ai) => {
        const key = `${h.key}#${f.name}`;
        const fireT = hitT + delayOf(f, ai) * secPerBeat;
        // shells: launched their lift time before the burst
        let height = 0, T = 0;
        if (kind === 'firework') {
          const hx = Number(f.extras.height);
          height = Number.isFinite(hx) && hx > 1 ? Math.min(398, hx) : 22 + 10 * h.power;
          T = Math.min(3.4, Math.max(1.1, 0.55 + height / 42));
          // the burst lights the sky (soft, ~250 ms), governed below
          const ab = nowSec - fireT;
          if (ab >= 0 && ab < 0.6) sky = Math.max(sky, h.power * Math.exp(-ab / 0.25) * Math.min(1, ab / 0.08) * (h.style === 'salute' ? 1 : 0.6));
        }
        let t0 = this.t0Keys.get(key);
        if (t0 === undefined) {
          const start = fireT - T;
          if (nowSec < start) return;                                     // not launched yet
          if (nowSec - start > h.dur * secPerBeat + life + T) return;     // long over
          t0 = start; this.t0Keys.set(key, t0);
        }
        if (nowSec - t0 > h.dur * secPerBeat + life + T) return;
        const sys = kind === 'co2' ? py.co2 : kind === 'confetti' ? py.confetti : kind === 'firework' ? py.shells : py.sparks;
        const placed = sys.has(key);
        const aimX = f.extras.aim;
        V1.set(0, 1, 0).applyQuaternion(f.quat);
        const aim = Array.isArray(aimX) && aimX.length >= 3 ? AIM.set(+aimX[0], +aimX[1], +aimX[2]).sub(f.pos).normalize() : V1.y > 0.2 || h.style === 'waterfall' ? AIM.copy(V1).normalize() : AIM.set(0, 1, 0);
        if (kind === 'firework') aim.set((hash3(h.seed, ai) - 0.5) * 0.25, 1, (hash3(h.seed, ai, 2) - 0.5) * 0.2).normalize();
        let mode = 0;
        if (kind === 'gerb') mode = h.style === 'waterfall' ? 4 : 0;
        else if (kind === 'comet') mode = h.style === 'mine' ? 5 : 1;
        else if (kind === 'firework') mode = (h.shape ? 3 : h.style === 'willow' ? 6 : h.style === 'salute' ? 7 : h.style === 'crossette' ? 8 : h.style === 'glitter' ? 9 : 2) + Math.min(0.995, height / 400);
        // (a mortar can carry its own star colour: glTF extras `color` hex - a room's red / green / white batteries)
        const own = kind === 'firework' && typeof f.extras.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(f.extras.color) ? PC3.set(f.extras.color).convertSRGBToLinear() : null;
        const c1 = h.style === 'willow' ? GOLD : h.style === 'salute' ? WHITE : own ?? col, c2 = h.style === 'willow' ? GOLD : h.style === 'salute' ? WHITE : own ?? col2;
        if (!placed) {
        const ev: PyroEvent = { key, pos: f.pos, aim: aim.clone(), t0, dur: Math.max(0.15, h.dur * secPerBeat), power: h.power, mode, seed: h.seed, color: c1.clone(), color2: c2.clone() };
        if (kind === 'firework' && h.shape) py.shells.setShape(cfg.shapes[h.shape] ?? null);
        sys.place(ev, nowSec, life + T);
        }
        // the burst leaves a smoke puff the beams light up
        if (kind === 'firework' && nowSec >= t0 + T) {
          const pk = `${key}#puff`;
          if (!this.t0Keys.has(pk)) {
            this.t0Keys.set(pk, t0 + T);
            this.ev.shells++;
            const top = f.pos.clone().addScaledVector(aim, height);
            // (grey smoke, lit by the beams - a puff tinted with the star colour read as a soft coloured ball over the burst)
            py.co2.place({ key: pk, pos: top, aim: AIM2.set(0, 1, 0).clone(), t0: t0 + T + 0.4, dur: 0.3, power: Math.min(0.8, 0.35 + height / 260), mode: 1, seed: h.seed, color: SMOKE_FW.clone(), color2: SMOKE_FW.clone() }, nowSec, 9);
          }
        }
      });
    }
    // flames are lights too: each head's height / brightness target passes the governor; the sky glow too. A head's
    // drawn light grows ~ with the cube of its level (height x width x brightness), so the governor holds the cube:
    // a held column stays within the tolerance in what is DRAWN, not just in its level
    for (let k = 0; k < this.flameT.length; k++) { const t = this.flameT[k]; this.flameT[k] = Math.cbrt(gov.level(this.flameGov[k] ??= {}, t * t * t)); }
    // (a flame volley for the smoke: any head starting to fire this frame)
    let anyFlame = false; for (let k = 0; k < this.flameT.length; k++) if (this.flameT[k] > 0.5) { anyFlame = true; break; }
    if (anyFlame && !this.anyFlameWas) this.ev.volleys++;
    this.anyFlameWas = anyFlame;
    // a puff of smoke at a column's base each time it fires (rooms with festival.flameSmoke): the beams light it
    if (cfg.flameSmoke) for (let k = 0; k < this.flameT.length; k++) {
      const on = this.flameT[k] > 0.5;
      if (on && !this.flameWas[k]) { const f = heads[k]; py.co2.place({ key: `fsmk#${k}#${Math.round(m.beat * 4)}`, pos: f.pos, aim: AIM2.set(0, 1, 0).clone(), t0: nowSec, dur: 0.4, power: 1.25, mode: 1, seed: f.geo.seed + Math.round(m.beat * 4), color: SMOKE.clone(), color2: SMOKE.clone() }, nowSec, 6); }
      this.flameWas[k] = on ? 1 : 0;
    }
    py.flame(this.flameT, dt, nowSec, this.flameS);
    for (const fl of this.fire) {
      let s = 0, g = 0;
      for (const i of fl.heads) { const l = Math.min(1.2, py.levelOf(i)); s += l; if (py.greenOf(i)) g += l; }
      const lv = gov.level(fl.o, s / fl.heads.length);
      fl.light.intensity = lv * (this.cfg.fireLights?.intensity ?? 0);
      const gr = s > 0 ? g / s : 0;
      fl.light.color.setRGB(1 - 0.8 * gr, 0.48 + 0.5 * gr, 0.15);
    }
    this.skyGlow = gov.level(this.skyGov, sky);
    if (this.t0Keys.size > 600) { for (const [k, t] of this.t0Keys) if (nowSec - t > 60) this.t0Keys.delete(k); }
  }

  private headLevel = (k: number) => this.pyro.levelOf(k);
  /** A comet fan hit: per origin (the centre unit, each unit, the two halves, or a row across the group) one event per
   *  slot it needs - the fan's comets interleaved over the slots, the shader shares each slot's particles out. */
  private placeFans(h: SfxHit, sel: Fixture[], hitT: number, nowSec: number, secPerBeat: number, col: THREE.Color, col2: THREE.Color, lo: number, hi: number, delayOf: (f: Fixture, i: number) => number) {
    const spec: FanSpec = FAN_DEFAULTS[h.style as keyof typeof FAN_DEFAULTS];
    const n = Math.round(h.count ?? spec.count), tilt = h.tilt ?? spec.tilt, spread = h.spread ?? spec.spread;
    const c1 = h.color ?? spec.color, c2 = h.color2 ?? spec.color2 ?? c1;
    const own = !!c1;
    const sys = this.pyro.sparks;
    const life = 2.6;
    if (!sel.length) return;
    sel.sort(byX);
    if (!(hi > lo)) { lo = sel[0].pos.x; hi = sel[sel.length - 1].pos.x; }
    const mid = (lo + hi) / 2;
    // one origin: its position, lean (deg), spread (deg) or row width (m), comets, delay (beats); one event per slot it needs
    const fire = (oi: number, pos: THREE.Vector3, lean: number, q: number, cn: number, delay: number) => {
      const t0 = hitT + delay * secPerBeat;
      if (nowSec < t0 || nowSec - t0 > life) return;
      const { slots, count } = fanSlots(cn, sys.per);
      tiltAim(lean, FA);
      for (let sI = 0; sI < slots; sI++) {
        const key = `${h.key}#fan${oi}#${sI}`;
        if (sys.has(key)) continue;
        if (sI === 0) this.ev.fans++;
        const ev: PyroEvent = { key, pos: pos.clone(), aim: new THREE.Vector3(FA[0], FA[1], FA[2]), t0, dur: packFan(spec.shape === 'row' ? q * 4 : q, count, sI, slots), span: 2.4, power: h.power, mode: fanMode(spec.shape, own),
          seed: h.seed, color: own ? new THREE.Color(c1!).convertSRGBToLinear() : col.clone(), color2: own ? new THREE.Color(c2!).convertSRGBToLinear() : col2.clone() };
        sys.place(ev, nowSec, life);
      }
    };
    if (spec.from === 'centre') {
      let best = sel[0]; for (const f of sel) if (Math.abs(f.pos.x - mid) < Math.abs(best.pos.x - mid)) best = f;
      fire(0, best.pos, tilt, spread, n, delayOf(best, 0));
    } else if (spec.from === 'each') {
      // (roof fans: the outer units lean out a little, mirrored)
      sel.forEach((f, i) => fire(i, f.pos, tilt + 15 * Math.max(-1, Math.min(1, hi > lo ? (f.pos.x - mid) / ((hi - lo) / 2) : 0)), spread, n, delayOf(f, i)));
    } else {
      // rows: the two halves leaning toward each other (a lattice) or one row across the group (a curtain)
      const rows: [Fixture[], number][] = spec.from === 'halves' ? [[sel.filter((f) => f.pos.x <= mid), tilt], [sel.filter((f) => f.pos.x > mid), -tilt]] : [[sel, tilt]];
      rows.forEach(([list, lean], ri) => {
        if (!list.length) return;
        let x0 = Infinity, x1 = -Infinity; FO.set(0, 0, 0);
        for (const f of list) { x0 = Math.min(x0, f.pos.x); x1 = Math.max(x1, f.pos.x); FO.add(f.pos); }
        FO.multiplyScalar(1 / list.length);
        const width = spread > 0 ? spread : Math.max(4, (x1 - x0) * 1.1 + 4);
        fire(ri, FO, lean, Math.min(255, width), n, delayOf(list[0], 0));
      });
    }
  }

  /** the page-seconds origin moved: forget every effect's start time (they are re-placed from the beat) */
  rebase() { this.t0Keys.clear(); for (const p of [this.pyro.co2, this.pyro.confetti, this.pyro.sparks, this.pyro.shells]) p.clear(); this.pyro.rebase(); this.flameWas.fill(0); }

  /** compile every shader of the rig now (no mid-show compile hitch) */
  warm(renderer: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene) {
    this.warmWith = { r: renderer, c: camera, s: scene };
    this.smoke?.warm(renderer, camera, scene);
    try { void (renderer as THREE.WebGLRenderer & { compileAsync?: (o: THREE.Object3D, c: THREE.Camera, s?: THREE.Scene) => Promise<unknown> }).compileAsync?.(this.root, camera, scene)?.catch(() => {}); } catch { /* optional */ }
  }

  dispose() {
    this.movers.dispose(); this.flats.dispose(); this.lasers.dispose(); this.pyro.dispose(); this.crowd?.dispose(); this.walls?.dispose(); this.glare?.dispose(); this.smoke?.dispose(); this.smokeGone?.dispose(); this.warmWith = null;
    this.root.removeFromParent();
  }
}
