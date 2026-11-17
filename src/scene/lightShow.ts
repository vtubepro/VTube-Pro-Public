// Beat-reactive room lights (the SceneLights engine, docs/SCENES.md "Lights"). Installed as the lights factory
// when output.ts imports this module.
//
// Every LIGHT_* fixture belongs to a group (extras.group / its EMIT_<group> material). Each group runs one program
// (shared/lightShow.ts: steady, pulse, chase, strobe, breathe, cycle, flicker, drift, drop, off) with its own
// intensity / colour / speed, driven by the page's BeatClock (the studio's beat analysis → bus 'beat' packets).
//
// Rendering stays cheap and never changes the render tier: fixtures get their own CLONE of their EMIT_* material
// (so a chase can light them one by one — same shader program, just uniforms), EMIT_ meshes outside any fixture
// follow their group's mean level, and at most LIGHT_BUDGET[tier] real THREE lights exist (created once in
// attach(), exactly as the placeholder picked them; only intensity / colour change per frame, never the count → no
// shader recompiles). No bloom / post.
//
// Photosensitivity (state.safe, default on): every "big flash" (kick pulses, strobe hits, drop peaks — and their
// real lights) goes through ONE gate: at most 3 flashes per second across all groups (hits < 60 ms apart count as
// one flash); a gated hit still shows, at 10 % depth (under the 10 % luminance change WCAG counts as a flash).
// Chases are capped at 3 steps per second.
import * as THREE from 'three';
import type { LightGroupSetting, LightProgram, LightingLook, LightingStateId, SceneLightsState } from '../../shared/types.ts';
import { AMBIENT_PROGRAMS, EV_DOWN, EV_DROP, EV_HAT, EV_KICK, EV_SNARE, PALETTES, PRACTICAL_FLOOR, houseLevel, lookFromPreset, lookOf, resolveGroup, resolveLookGroup } from '../../shared/lightShow.ts';
import { SHOW_PRESETS, groupKind, presetById } from '../../shared/lightPresets.ts';
import { FxRig } from './fxRig.ts';
import { PerformerLights, type PerformerLightInput } from './performerLight.ts';
import { DEFAULT_LIGHTS } from '../../shared/scene.ts';
import { LIGHT_BUDGET, setLightsFactory, type SceneLights, type SceneLightsContext } from './lights.ts';
import type { LightFixture } from './contract.ts';
import { BeatClock, beatClock, epochNow } from './beatClock.ts';
import { DEFAULT_STYLE_OPTS, autoStyle, cueEval, resolveStyle, styleEval, styleLayer, type FixGeo, type LightCue, type LightStyle, type StyleIn, type StyleOut, type StyleSection } from '../../shared/lightStyles.ts';
import { STILL_ROLES, isFlame, lightRole, type LightRole } from '../../shared/lightRoles.ts';
import { evalFixture, frameFromClock, newOut, showById, showLook, showPalette, type DirSection, type FixtureInfo, type FrameState, type MusicFrame } from '../../shared/lightDirector.ts';
import { flashPillOn, flashWarning } from './flashWarning.ts';
import { musicClock } from './musicClockRx.ts';
import { FlashGovernor, govChannel, isSatRed, relLum, setPageGovernor, type GovChannel } from '../../shared/flashGovernor.ts';
import { registerShowPack } from '../../shared/showPack/director.ts';

const PRACTICAL_KINDS: ReadonlySet<string> = new Set(['lamps', 'onair', 'lava', 'aqua']);
const STEADY_PROGRAMS: ReadonlySet<string> = new Set(['steady', 'flicker', 'drift', 'breathe']);

registerShowPack();   // the show pack: ~1,700 programs for every room (Club / Rave / Calm pick from them)

interface FixMat { m: THREE.MeshStandardMaterial; baseColor: THREE.Color; baseI: number }
interface Fix {
  f: LightFixture;
  mats: FixMat[];
  lights: THREE.Light[];
  /** Chase order within the group (left → right, then back → front). */
  index: number;
  seed: number;
  level: number;
  hue: number;
  /** Show-open bank (0..3, left → right across the room). */
  bank: number;
  /** Per look (0 = from, 1 = to): level, hue, palette colour (null = the group / authored colour). */
  lv: [number, number];
  hu: [number, number];
  pc: [THREE.Color | null, THREE.Color | null];
  /** where it is in the room (music styles: shared/lightStyles.ts) + its per-look style colour + white flash */
  geo?: FixGeo;
  sc?: [THREE.Color, THREE.Color];
  wh?: [number, number];
  /** photosensitivity governor channel (shared/flashGovernor.ts) + the colour last shown */
  ch?: GovChannel;
  shown?: THREE.Color;
  snap?: GovChannel; snapCol?: THREE.Color; outLv?: number; outL?: number; lastLv?: number; lastL?: number;
  wc?: THREE.Color;
  /** what the director sees (role, kind, place, authored colour) */
  info?: FixtureInfo;
}
/** One evaluated look. */
interface LookEval { id: string; look: LightingLook; settings: Map<string, LightGroupSetting>; colors: Map<string, THREE.Color | null> }
interface Group {
  name: string;
  fixtures: Fix[];
  /** EMIT_<group> materials as loaded (meshes outside any LIGHT_* node keep them). */
  shared: { m: THREE.MeshStandardMaterial; baseColor: THREE.Color; baseI: number }[];
  color: THREE.Color | null;
  colorKey: string | null;
  setting: LightGroupSetting;
  /** Stand-in slot for groups with no LIGHT_* fixture (EMIT_ materials only). */
  pseudo: Fix | null;
  onair: boolean;
  /** shared/lightRoles.ts: practicals / windows / screens / signals / moods never dance */
  role: LightRole;
  /** governor channel of the group's shared EMIT_ materials, and whether any mesh still shows them */
  sch?: GovChannel;
  sharedShown?: boolean;
  gch?: GovChannel;
  flame: boolean;
}

const smooth = (e0: number, e1: number, v: number) => { const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const frac = (x: number) => x - Math.floor(x);
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0) / 4294967296; };
const rnd = (a: number, b: number) => frac(Math.sin(a * 127.1 + b * 311.7) * 43758.5453);
/** Synthetic emissive fixtures, one per mesh, for moving-role groups that have no LIGHT_* node (2..48 meshes). */
function meshFixtures(room: SceneLightsContext['room'], roles: Record<string, string> | null): LightFixture[] {
  const have = new Set(room.fixtures.map((f) => f.group));
  const skip = new Set<THREE.Object3D>();
  room.screen?.node.traverse((o) => skip.add(o));
  for (const f of room.fixtures) f.node.traverse((o) => skip.add(o));
  const byG = new Map<string, { mesh: THREE.Mesh; rec: (typeof room.emissive)[number] }[]>();
  room.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || skip.has(m)) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const rec = room.emissive.find((e) => e.material === mat);
      if (!rec || have.has(rec.group) || STILL_ROLES.has(lightRole(rec.group, roles))) continue;
      const list = byG.get(rec.group) ?? []; list.push({ mesh: m, rec }); byG.set(rec.group, list);
      break;
    }
  });
  const out: LightFixture[] = [];
  let total = 0;
  for (const [g, list] of byG) {
    if (list.length < 2 || list.length > 48 || total + list.length > 400) continue;   // (≤ 400 split meshes a room)
    total += list.length;
    list.forEach(({ mesh, rec }, i) => out.push({ name: `${g}#${i}`, node: mesh, group: g, color: rec.baseColor.clone(), kind: 'emissive', materials: [rec.material], extras: {} }));
  }
  return out;
}
/** Blend director outputs: a <- a*(1-w) + b*w. */
function mixOut(a: { dim: number; r: number; g: number; b: number; white: number }, b: { dim: number; r: number; g: number; b: number; white: number }, w: number) {
  a.dim += (b.dim - a.dim) * w; a.r += (b.r - a.r) * w; a.g += (b.g - a.g) * w; a.b += (b.b - a.b) * w; a.white += (b.white - a.white) * w;
}
/** The room's own palette for "Match the room": its saturated authored light colours (linear RGB), most common
 *  first, lifted to show-light saturation; warm white / steel blue when the room has only white / grey lights. */
export function roomPalette(cols: [number, number, number][]): [number, number, number][] {
  const c = new THREE.Color(), hsl = { h: 0, s: 0, l: 0 };
  const bins = new Map<number, { n: number; h: number; s: number }>();
  for (const [r, g, b] of cols) {
    c.setRGB(r, g, b).getHSL(hsl);
    if (hsl.s < 0.25 || hsl.l < 0.05) continue;
    const k = Math.round(hsl.h * 12) % 12, e = bins.get(k) ?? { n: 0, h: 0, s: 0 };
    e.n++; e.h += hsl.h; e.s += hsl.s; bins.set(k, e);
  }
  const out = [...bins.values()].sort((a, b) => b.n - a.n).slice(0, 4).map((e) => { c.setHSL(e.h / e.n, Math.max(0.75, e.s / e.n), 0.55); return [c.r, c.g, c.b] as [number, number, number]; });
  if (!out.length) { c.setHSL(0.08, 0.6, 0.6); out.push([c.r, c.g, c.b]); c.setHSL(0.6, 0.5, 0.6); out.push([c.r, c.g, c.b]); }
  if (out.length === 1) { c.setRGB(out[0][0], out[0][1], out[0][2]).getHSL(hsl); c.setHSL((hsl.h + 0.08) % 1, hsl.s, 0.6); out.push([c.r, c.g, c.b]); }
  return out;
}
/** Colour-cycle palette: hue offsets from the authored colour, one per bar. */
const CYCLE = [0, 0.2, 0.5, 0.72];
const MIN_FLASH_MS = 1000 / 3;
/** how much Reactive lights tint the performers' hemisphere / rim light, per look */
const MOOD_WASH: Record<string, number> = { room: 0.22, calm: 0.18, club: 0.38, rave: 0.5 };
/** depth of a hit the gate holds back (was 0.3: measured, a 30 % hit on a whole room still counts as a WCAG flash) */
const GATED = 0.05;

/** One flash budget for the whole room (see the header). */
class FlashGate {
  safe = true;
  /** last time a flash came faster than the limit (counted with the limit off too: the on-stream warning) */
  overAt = -Infinity;
  private last = -Infinity;
  private seen = new Map<string, number>();
  depth(key: string, at: number): number {
    const k = this.seen.get(key);
    if (k !== undefined) return k;
    let d = 1;
    if (Number.isFinite(at)) {
      const gap = at - this.last;
      if (gap >= MIN_FLASH_MS || gap < 60) { if (gap >= MIN_FLASH_MS) this.last = at; }
      else { this.overAt = at; if (this.safe) d = GATED; else this.last = at; }
    }
    this.seen.set(key, d);
    if (this.seen.size > 48) this.seen.delete(this.seen.keys().next().value as string);
    return d;
  }
}

export class BeatLights implements SceneLights {
  private ctx: SceneLightsContext | null = null;
  private state: SceneLightsState = { ...DEFAULT_LIGHTS };
  private groups = new Map<string, Group>();
  private restore: { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }[] = [];
  private clones: THREE.Material[] = [];
  private lights: THREE.Light[] = [];
  private live = 0;
  /** Clock / liveness of the look being evaluated (program() reads these). */
  private pc: BeatClock = beatClock;
  private pl = 0;
  /** Built-in auto show clock (looks with music 'auto' and no music input). */
  private auto = new BeatClock();
  private autoStart = epochNow();
  private autoBeat = -1; private autoHalf = -1; private autoSent = 0;
  private cur: LightingStateId = 'show';
  private trans: { from: LightingStateId; to: LightingStateId; t0: number; dur: number; open: boolean } | null = null;
  private attached = false;
  private looks = new Map<string, LookEval>();
  /** Scene-tab preview of a look (preview pages only; never saved or sent). */
  private preview: LightingLook | null = null;
  private stageLights: { l: THREE.Light; color: THREE.Color; ground?: THREE.Color }[] = [];
  private eSlow = 0;
  private snares: number[] = [];
  private lastSnareSeq = -1;
  private brk = 0;
  private house: { m: THREE.MeshStandardMaterial; base: THREE.Color; env: number; em: number; metal: number }[] = [];
  private houseKey = '';
  private houseNow = 1;
  private fx: FxRig | null = null;
  private faces: THREE.Vector3[] = [];
  private facesAt = 0;
  private cueAt = -Infinity;
  /** Room alert reactions (src/scene/reactions.ts): the 'alert' cue's start (local epoch ms) + the groups it pulses. */
  private alertAt = -Infinity;
  private alertGroups = new Set<string>();
  /** …and the light override while a reaction runs: groups that play their own setting in every state + house / tint. */
  private ov: { groups: Record<string, LightGroupSetting>; house?: number; tint?: string } | null = null;
  private ovK = 0;
  private ovLast: { house?: number; tint: THREE.Color; tintOn: boolean } = { tint: new THREE.Color(1, 1, 1), tintOn: false };
  private perf = new PerformerLights();
  /** A performer's model changed (src/output.ts Slot.show): their show-light patch on the next frame. */
  performersChanged() { this.perf.touch(); }
  /** An incoming model before it is shown (src/output.ts stageModel): the show-light patch it will get. */
  preparePerformer(root: THREE.Object3D, mount: THREE.Object3D | null) { this.perf.prepare(root, mount); }
  private performers: PerformerLightInput[] = [];
  private actorsAt = 0;
  private pWash = new THREE.Color(); private pRim = new THREE.Color();
  private palA = new THREE.Color(); private palB = new THREE.Color();
  private tintA = new THREE.Color(); private tintB = new THREE.Color();
  private tmpC = new THREE.Color(); private tmpA = new THREE.Color(); private tmpB = new THREE.Color();
  private gate = new FlashGate();
  /** every output passes here before it is drawn: ≤ 3 flashes a second, whatever made them (see shared/flashGovernor.ts) */
  readonly gov = new FlashGovernor();
  private houseCh = govChannel('house'); private rimCh = govChannel('rim'); private perfCh = govChannel('performer flash'); private perfRimCh = govChannel('performer rim');
  private shownTmp = new THREE.Color();
  /** music styles: the running style per look slot, the Auto pick latched per 16-bar block, the build's start */
  private styleNow: [LightStyle | null, LightStyle | null] = [null, null];
  private autoPick = { key: '', style: null as LightStyle | null };
  private buildFrom = -Infinity; private secPrev = '';
  private sIn: StyleIn | null = null;
  private sOut: StyleOut = { lv: 0, mix: 0, hue: 0, white: 0 };
  private cueList: { what: LightCue; at: number }[] = [];
  private cueTmp = { lv: 0, color: '#ffffff', white: 0 };
  private cueCol = new THREE.Color(); private white = new THREE.Color(1, 1, 1);
  /** cues this engine plays (chatScene / club / raid call cue(kind) for the support celebrations; 'alert' = a room alert reaction) */
  readonly cues: string[] = ['donation', 'tip', 'sub', 'bits', 'raid', 'big', 'alert'];
  /** timed moments from room engines: the mirror ball comes out, a scripted drop */
  private ballUntil = -Infinity; private momentDropAt = -Infinity; private laserUntil = -Infinity;
  /** how far ahead of the wall clock the lights are computed: one frame (smoothed) = when this frame reaches the screen
   *  (the harness measures it: tools/beat/rhythm_eval.ts; 1.5 frames would centre hits better but lets two OBS pages
   *  with jittered packets drift apart — tools/lights_unit.ts) */
  private frameLead = 1000 / 60;
  /** ms spent in update() (moving average) — debug / budget check. */
  cost = 0;
  /** the room's light level now (house lights × tint luminance, 0.05..1.2) and the effects palette — background
   *  characters (src/scene/crowd) dim + tint with the room in club looks */
  get houseLevel() { return this.houseNow; }
  /** a room engine's show takes the room (the club's pack rig while it plays SHOW with music): × the house level,
   *  1 = as the look says. Room materials only - the performers' stage lights (their key / faces) are never touched. */
  showDim = 1;
  get washPalette(): [THREE.Color, THREE.Color] { return [this.palA, this.palB]; }

  constructor(private clock: BeatClock = beatClock) {}

  attach(ctx: SceneLightsContext) {
    this.ctx = ctx;
    setPageGovernor(this.gov);   // the club wall, show sky, night lights … step through this same one
    this.cur = this.state.state ?? 'show';
    const room = ctx.room;
    const roleOverrides = ((ctx.info as { lights?: { roles?: Record<string, string> } } | undefined)?.lights?.roles) ?? null;
    const group = (name: string): Group => {
      let g = this.groups.get(name);
      if (!g) { g = { name, fixtures: [], shared: [], color: null, colorKey: null, setting: resolveGroup(this.state, name), pseudo: null, onair: /on_?air/i.test(name), role: lightRole(name, roleOverrides), flame: isFlame(name) }; this.groups.set(name, g); }
      return g;
    };
    // per-fixture material clones
    const done = new Set<THREE.Mesh>();
    const fixOf = new Map<LightFixture, Fix>();
    // rooms that light a group only through EMIT_<group> materials (no LIGHT_* nodes): every mesh carrying the material
    // becomes its own fixture (own material clone, own place in the room), so sweeps / splits / chases move ACROSS the
    // room instead of the whole group blinking as one
    this.builtModern = !!this.state.mood;
    for (const f of [...room.fixtures, ...(this.builtModern ? meshFixtures(room, roleOverrides) : [])]) {
      const fx: Fix = { f, mats: [], lights: [], index: 0, seed: hash(f.name), level: 1, hue: 0, bank: 0, lv: [1, 1], hu: [0, 0], pc: [null, null] };
      const made = new Map<THREE.Material, THREE.MeshStandardMaterial>();
      f.node.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || done.has(mesh)) return;
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        if (!list.some((m) => /^EMIT_/.test(m?.name ?? '') && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial)) return;
        done.add(mesh);
        this.restore.push({ mesh, material: mesh.material });
        const swap = (m: THREE.Material): THREE.Material => {
          const sm = m as THREE.MeshStandardMaterial;
          if (!/^EMIT_/.test(m.name) || !sm.isMeshStandardMaterial) return m;
          // another group's EMIT_ material on this fixture (e.g. a lamp on the transmitter) keeps following its own group
          const rec0 = room.emissive.find((e) => e.material === sm);
          if (rec0 && rec0.group !== f.group) return m;
          let c = made.get(m);
          if (!c) {
            c = sm.clone();
            made.set(m, c);
            this.clones.push(c);
            // the authored values (a material shared by several fixtures may already be a clone source — use the room's record)
            const rec = room.emissive.find((e) => e.material === sm);
            fx.mats.push({ m: c, baseColor: (rec?.baseColor ?? sm.emissive).clone(), baseI: rec?.baseIntensity ?? sm.emissiveIntensity });
          }
          return c;
        };
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
      });
      group(f.group).fixtures.push(fx);
      fixOf.set(f, fx);
    }
    for (const e of room.emissive) group(e.group).shared.push({ m: e.material, baseColor: e.baseColor.clone(), baseI: e.baseIntensity });
    // which shared EMIT_ materials are still on a mesh (outside every fixture: those were swapped for clones)
    {
      const onMesh = new Set<THREE.Material>();
      room.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) for (const x of Array.isArray(m.material) ? m.material : [m.material]) onMesh.add(x); });
      for (const g of this.groups.values()) g.sharedShown = g.shared.some((x) => onMesh.has(x.m));
    }
    // chase order: left → right (x), then back → front (z)
    const p = new THREE.Vector3();
    for (const g of this.groups.values()) {
      const pos = new Map(g.fixtures.map((x) => [x, x.f.node.getWorldPosition(p).clone()]));
      g.fixtures.sort((a, b) => { const A = pos.get(a)!, B = pos.get(b)!; return Math.abs(A.x - B.x) > 0.05 ? A.x - B.x : A.z - B.z; });
      g.fixtures.forEach((x, i) => (x.index = i));
      if (!g.fixtures.length) g.pseudo = { f: null as unknown as LightFixture, mats: [], lights: [], index: 0, seed: hash(g.name), level: 1, hue: 0, bank: 0, lv: [1, 1], hu: [0, 0], pc: [null, null] };
    }
    // show-open banks: every fixture by its x across the room
    const byX = [...this.groups.values()].flatMap((g) => g.fixtures).sort((a, b) => a.f.node.getWorldPosition(p).x - b.f.node.getWorldPosition(new THREE.Vector3()).x);
    byX.forEach((x, i) => (x.bank = Math.min(3, Math.floor((i / Math.max(1, byX.length)) * 4))));
    // music styles: every fixture's place in the room, normalised over all fixtures (left → right, low → high,
    // back → front, angle + distance around the centre) — the same maths as the Scene-tab previews
    {
      const all = [...this.groups.values()].flatMap((g) => g.fixtures);
      const pos = all.map((x) => { const b = new THREE.Box3().setFromObject(x.f.node); return b.isEmpty() ? x.f.node.getWorldPosition(new THREE.Vector3()) : b.getCenter(new THREE.Vector3()); });
      const bb = new THREE.Box3(); for (const q of pos) bb.expandByPoint(q);
      const c = bb.getCenter(new THREE.Vector3()), sz = bb.getSize(new THREE.Vector3()).max(new THREE.Vector3(0.01, 0.01, 0.01));
      const rMax = Math.max(0.01, ...pos.map((q) => Math.hypot(q.x - c.x, q.z - c.z)));
      all.forEach((x, i) => {
        const q = pos[i];
        x.geo = { x: (q.x - bb.min.x) / sz.x, y: (q.y - bb.min.y) / sz.y, z: (q.z - bb.min.z) / sz.z, ang: (Math.atan2(q.z - c.z, q.x - c.x) / (Math.PI * 2) + 1) % 1, r: Math.hypot(q.x - c.x, q.z - c.z) / rMax, i, n: all.length, seed: x.seed };
        x.sc = [new THREE.Color(), new THREE.Color()]; x.wh = [0, 0];
      });
      for (const g of this.groups.values()) if (g.pseudo) { g.pseudo.geo = { x: 0.5, y: 0.5, z: 0.5, ang: 0, r: 0, i: 0, n: 1, seed: g.pseudo.seed }; g.pseudo.sc = [new THREE.Color(), new THREE.Color()]; g.pseudo.wh = [0, 0]; }
      // the director's view of every fixture (+ the room's own palette: its saturated authored colours)
      for (const g of this.groups.values()) for (const x of g.fixtures.length ? g.fixtures : [g.pseudo!]) {
        const c = x.mats[0]?.baseColor ?? g.shared[0]?.baseColor ?? x.f?.color ?? new THREE.Color(1, 1, 1);
        const geo = x.geo!;
        x.info = { role: g.role, kind: x.f ? x.f.kind : 'emissive', group: g.name, x: geo.x, y: geo.y, z: geo.z, ang: geo.ang, r: geo.r, i: geo.i, n: geo.n, seed: geo.seed, base: [c.r, c.g, c.b] };
      }
      this.roomPal = roomPalette([...this.groups.values()].filter((g) => !STILL_ROLES.has(g.role)).flatMap((g) => (g.fixtures.length ? g.fixtures : [g.pseudo!]).map((x) => x.info!.base)));
    }
    // house lights = the room's own materials (baked vertex lighting × colour): not EMIT_, not the react screen
    const skip = new Set<THREE.Object3D>();
    room.screen?.node.traverse((o) => skip.add(o));
    const seen = new Set<THREE.Material>();
    room.root.traverse((o) => {
      if (skip.has(o)) return;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const sm = m as THREE.MeshStandardMaterial;
        if (!sm || seen.has(sm) || /^EMIT_/.test(sm.name) || !sm.color) continue;
        seen.add(sm);
        this.house.push({ m: sm, base: sm.color.clone(), env: sm.envMapIntensity ?? 1, em: sm.emissiveIntensity ?? 1, metal: sm.metalness ?? 0 });
      }
    });
    // real lights: the placeholder's budget + picks (spot cans first, then the strongest / widest points)
    let budget = LIGHT_BUDGET[ctx.tier] ?? 2;
    const weight = (f: LightFixture) => (f.kind === 'spot' ? 1000 : 0) + (Number(f.extras.intensity) || 1) * (Number(f.extras.range) || 5);
    const all = room.fixtures.map((f) => fixOf.get(f)!);   // file order, like the placeholder
    const real = all.filter((x) => x.f.kind !== 'emissive').sort((a, b) => weight(b.f) - weight(a.f));
    for (const fx of real) {
      if (budget <= 0) break;
      const f = fx.f, x = f.extras;
      const wp = f.node.getWorldPosition(new THREE.Vector3());
      const k = Number.isFinite(Number(x.intensity)) ? Math.max(0, Number(x.intensity)) : 1;
      const range = Number(x.range) > 0 ? Number(x.range) : f.kind === 'spot' ? 9 : 6;
      let l: THREE.Light;
      if (f.kind === 'spot') {
        const cone = THREE.MathUtils.degToRad(Math.min(170, Number(x.angle) || 40)) / 2;
        const s = new THREE.SpotLight(f.color, 30 * k, range, cone, Number.isFinite(Number(x.penumbra)) ? Number(x.penumbra) : 0.5, 2);
        s.position.copy(wp);
        const t = Array.isArray(x.target) && x.target.length >= 3
          ? room.root.localToWorld(new THREE.Vector3(...(x.target as number[]).slice(0, 3).map(Number)))
          : wp.clone().add(new THREE.Vector3(0, 0, -1).applyQuaternion(f.node.getWorldQuaternion(new THREE.Quaternion())).multiplyScalar(3));
        s.target.position.copy(t);
        ctx.scene.add(s.target);
        l = s;
      } else {
        const pl = new THREE.PointLight(f.color, 6 * k, range, 2);
        pl.position.copy(wp);
        l = pl;
      }
      l.name = `vtp:${f.name}`;
      l.userData.base = l.intensity;
      l.userData.color = f.color.clone();
      ctx.scene.add(l);
      this.lights.push(l);
      fx.lights.push(l);
      if (l instanceof THREE.SpotLight) l.userData.target = l.target.position.clone();
      budget--;
    }
    // rooms that declare no light groups at all get a small automatic accent rig (≤ the tier's light budget, created
    // once — no recompiles later): two coloured washes high at the back corners, dark until Reactive lights runs
    if (!room.fixtures.length && !room.emissive.length && budget > 0) this.fallbackRig(ctx, Math.min(2, budget));
    // the stage's own lights (hemisphere + the cool rim): tinted by the show palette in effects looks (avatars pick up
    // a colour wash / rim) — colours only, never their intensity (SceneRuntime's landing dip owns that)
    for (const o of ctx.scene.children) {
      const l = o as THREE.Light;
      if (!l.isLight || l.name.startsWith('vtp:')) continue;
      if ((l as THREE.HemisphereLight).isHemisphereLight) this.stageLights.push({ l, color: l.color.clone(), ground: (l as THREE.HemisphereLight).groundColor.clone() });
      else if ((l as THREE.DirectionalLight).isDirectionalLight && !(l as THREE.DirectionalLight).castShadow && l.intensity < 1.5) this.stageLights.push({ l, color: l.color.clone() });
    }
    try { this.fx = new FxRig(room, ctx.tier, (ctx.info as { lightRig?: never } | undefined)?.lightRig, ctx.scene); } catch (e) { console.warn('light fx rig failed', e); this.fx = null; }
    // pre-warm: compile the effects shaders now (hidden rigs aren't compiled until first drawn → a hitch on PRESHOW)
    if (this.fx && ctx.warm) { this.fx.group.visible = true; ctx.warm(); this.fx.group.visible = false; }
    this.setState(this.state);
    this.render(epochNow(), 0);
  }

  /** Reactive lights v2 (roles, the director, per-mesh fixtures) run once the host has picked a look on the new card
   *  (`lights.mood` set; new scenes start with 'room'). A setup saved before that keeps its old show exactly. */
  private get modern() { return !!this.state.mood; }
  private builtModern = false;
  setState(s: SceneLightsState) {
    const wasModern = this.modern;
    this.state = s;
    // switching to the new lights rebuilds the fixtures once (EMIT_-only groups split into placed per-mesh fixtures)
    if (this.ctx && this.attached && !!s.mood !== wasModern && !!s.mood !== this.builtModern) { const ctx = this.ctx; this.dispose(); this.state = s; this.attach(ctx); return; }
    this.gate.safe = s.safe !== false;
    for (const g of this.groups.values()) {
      g.setting = resolveGroup(s, g.name);
      if (g.setting.color !== g.colorKey) { g.colorKey = g.setting.color; g.color = g.setting.color ? new THREE.Color(g.setting.color) : null; }
    }
    this.looks.clear();
    const target = s.state ?? 'show';
    if (target !== this.cur) {
      const now = epochNow();
      const dur = Math.max(0, (s.stateFade ?? 2) * 1000);
      // a transition already running: start from where it is (its target) — good enough for a fade
      this.trans = this.ctx && dur > 0 && this.attached ? { from: this.cur, to: target, t0: now, dur, open: this.cur === 'preshow' && target === 'show' } : null;
      this.cur = target;
    }
  }

  /** Optional hook from the scene engine: 'screenLand' (solo react screen landed) → an ON AIR slam + accent; support
   *  celebrations ('donation' / 'tip', 'sub', 'bits', 'raid', 'big') → a room-wide overlay (shared/lightStyles.ts cueEval);
   *  'alert' (a room alert reaction, src/scene/reactions.ts) → four pulses, 2 per second, on the ON AIR groups + `opts.groups`
   *  (default: groups named alert / alarm), photosensitivity-gated like every flash. `opts.at` = local epoch ms of the start. */
  cue(what: string, opts?: { at?: number; groups?: string[] | null }) {
    const now = epochNow();
    if (what === 'screenLand') { this.cueAt = now; return; }
    if (what === 'alert') {
      this.alertAt = opts?.at ?? now;
      this.alertGroups = new Set(opts?.groups ?? [...this.groups.keys()].filter((g) => /^(alert|alarm)s?$/i.test(g)));
      return;
    }
    if ((this.cues as string[]).includes(what)) {
      // the same celebration asked for twice (chat alert + a room engine) plays once
      const same = (c: { what: string }) => c.what === what || (c.what === 'donation' && what === 'tip') || (c.what === 'tip' && what === 'donation');
      if (this.cueList.some((c) => same(c) && now - c.at < 2500)) return;
      this.cueList = this.cueList.filter((c) => now - c.at < 6000).slice(-2);
      this.cueList.push({ what: what as LightCue, at: now });
      if (what !== 'bits') this.cueAt = now;
    }
  }

  /** Room alert reactions: per-group settings that win over every look, plus the house level / tint (null = off). */
  setOverride(o: { groups?: Record<string, LightGroupSetting>; house?: number; tint?: string } | null) {
    this.ov = o && (o.groups || o.house !== undefined || o.tint) ? { groups: o.groups ?? {}, house: o.house, tint: o.tint } : null;
    if (this.ov) { this.ovLast.house = this.ov.house; this.ovLast.tintOn = !!this.ov.tint; if (this.ov.tint) this.ovLast.tint.set(this.ov.tint); else this.ovLast.tint.setRGB(1, 1, 1); }
    this.looks.clear();
  }

  /** Timed moments from room engines: 'ball' (the mirror ball + its spots for `secs`), 'drop' (a scripted drop hit). */
  moment(kind: string, secs = 8) {
    const now = epochNow();
    if (kind === 'ball') this.ballUntil = now + secs * 1000;
    if (kind === 'drop') this.momentDropAt = now;
    if (kind === 'lasers') this.laserUntil = now + secs * 1000;
  }

  /** Scene-tab preview: play a look here without committing it (null = back to the real state). */
  previewLook(look: LightingLook | null) { this.preview = look; this.looks.delete('preview'); }

  /** The look of a state (or the preview), with auto-cycling presets resolved for the current phrase. */
  private lookFor(id: string, phrase: number): { key: string; look: LightingLook } {
    const base = id === 'preview' && this.preview ? this.preview : lookOf(this.state, id as LightingStateId);
    if (base.cycle) {
      const list = SHOW_PRESETS.filter((x) => x.cat === base.cycle!.cat || base.cycle!.cat === 'all');
      if (list.length) {
        const pr = list[((Math.floor(phrase / base.cycle.every) % list.length) + list.length) % list.length];
        return { key: `${id}:${pr.id}`, look: { ...lookFromPreset(pr, base.music), cycle: base.cycle } };
      }
    }
    return { key: id, look: base };
  }

  private lookEval(id: string, phrase = 0): LookEval {
    const { key, look } = this.lookFor(id, phrase);
    let e = this.looks.get(key);
    if (!e) {
      if (this.looks.size > 24) this.looks.clear();
      const settings = new Map<string, LightGroupSetting>(), colors = new Map<string, THREE.Color | null>();
      for (const g of this.groups.values()) {
        const st = this.ov?.groups[g.name] ?? (id === 'show' ? g.setting : resolveLookGroup(this.state, look, g.name));
        settings.set(g.name, st);
        colors.set(g.name, st.color ? new THREE.Color(st.color) : null);
      }
      e = { id, look, settings, colors };
      this.looks.set(key, e);
    }
    return e;
  }

  /** Built-in auto show (no music input), 124 BPM in 64-beat cycles: 8 bars groove, 2 bars moody breakdown (no
   *  kick), 2 bars groove, 3 bars build (energy ramps, snares every beat), 1 bar snare roll, DROP. */
  private autoTick(wall: number) {
    const bpm = 124, per = 60000 / bpm;
    const pos = (wall - this.autoStart) / per;
    const bi = Math.floor(pos), q = Math.floor(pos * 4), c = ((bi % 64) + 64) % 64;
    const sec = c < 32 ? 2 : c < 40 ? 4 : c < 48 ? 2 : c < 60 ? 3 : c < 64 ? 3 : 2;
    let ev = 0;
    if (bi !== this.autoBeat) {
      this.autoBeat = bi;
      ev |= 4;
      if (sec !== 4 && c < 60) ev |= EV_KICK;
      if (sec === 3 || bi % 2) ev |= EV_SNARE;
      if (bi % 4 === 0) ev |= EV_DOWN;
      if (c === 0 && bi > 0) ev |= EV_DROP | EV_KICK;
    }
    if (q !== this.autoHalf) { this.autoHalf = q; if (q % 2) ev |= EV_HAT; if (c >= 60 && q % 4) ev |= EV_SNARE; }   // snare roll: 16ths
    if (!ev && wall - this.autoSent < 33) return;
    this.autoSent = wall;
    const ph = pos - bi;
    const e = sec === 4 ? 0.3 : sec === 3 ? 0.5 + 0.03 * (c - 48) : 0.85;
    this.auto.push({ sid: 'autoshow', t: wall, on: true, bpm, bi, ph, bar: ((bi % 4) + 4) % 4, cf: 1, lk: true, ev, ka: 0, sa: 0,
      e, lo: sec === 4 ? 0.2 : 0.8, mi: 0.6, hi: 0.5, k: sec === 4 ? 0 : Math.exp(-ph * 5), s: bi % 2 ? Math.exp(-ph * 6) : 0, h: 0.4, d: c < 4 ? 1 - c / 4 : 0, sec }, wall);
  }

  /** The music style a look runs (null = the classic per-group programs). */
  private styleOf(e: LookEval, C: BeatClock, now: number): { style: LightStyle; palette: [string, string][]; speed: number } | null {
    const look = e.look;
    if (look.style === 'none') return null;
    const opts = this.state.styleOpts ?? DEFAULT_STYLE_OPTS;
    const id = look.style || this.state.style;
    if (!id) return null;
    if (e.id !== 'preview' && !look.style && !opts.states.includes(e.id as never)) return null;
    if (id === 'auto') {
      const block = Math.floor(C.barAt(now) / 16);
      const key = `${block}:${C.dropSeq}`;
      if (key !== this.autoPick.key || !this.autoPick.style) this.autoPick = { key, style: autoStyle(block, C.dropSeq, this.eSlow || C.env.e, C.section) };
      return { style: this.autoPick.style!, palette: this.autoPick.style!.palette, speed: opts.speed };
    }
    const r = resolveStyle(id, this.state.userStyles);
    return r ? { ...r, speed: r.speed * opts.speed } : null;
  }

  private section(C: BeatClock, now: number): StyleSection {
    const s = C.section;
    if (s !== this.secPrev) { if (s === 'buildup') this.buildFrom = now; this.secPrev = s; }
    const dropAge = now - Math.max(C.dropAt, this.momentDropAt);
    if (s === 'drop' || s === 'chorus' || dropAge < 60000 / Math.max(60, C.bpm || 120) * 16) return 'drop';
    if (s === 'buildup') return 'build';
    if (s === 'breakdown') return 'breakdown';
    return 'groove';
  }

  /** Evaluate one look into slot k of every fixture. */
  private evalInto(e: LookEval, k: 0 | 1, now: number, tSec: number, palA: THREE.Color, palB: THREE.Color) {
    const look = e.look;
    const useAuto = look.music === 'auto' && !beatClock.active(now + (this.state.delay ?? 0));
    this.pc = look.music === 'auto' ? (useAuto ? this.auto : this.clock) : this.clock;
    this.pl = look.music === 'auto' ? 1 : this.live;
    // ---- a music style drives every show fixture as one spatial canvas (practicals keep their programs)
    const sty = this.pl > 0.001 ? this.styleOf(e, this.pc, now) : null;
    this.styleNow[k] = sty?.style ?? null;
    if (sty) {
      const C = this.pc;
      let beat = C.posAt(now); if (!Number.isFinite(beat)) beat = this.clock.showTime(now) / 500;
      const bpm = C.bpm || 120;
      const sec = this.section(C, now);
      const opts = this.state.styleOpts ?? DEFAULT_STYLE_OPTS;
      const bar = C.barAt(now), phrase = Math.floor(bar / 8) + C.dropSeq;
      const pal = sty.palette[((phrase % sty.palette.length) + sty.palette.length) % sty.palette.length];
      const A = this.tmpA.set(pal[0]), Bc = this.tmpB.set(pal[1]);
      const dropAt = Math.max(C.dropAt, this.momentDropAt);
      this.sIn = { beat, barPos: Number.isFinite(C.barPosAt(now)) ? C.barPosAt(now) : ((beat % 4) + 4) % 4, bar, phrase, kickAge: now - C.kickAt, snareAge: now - C.snareAt, hatAge: now - C.hatAt,
        hatSeq: C.hatSeq, kickSeq: C.kickSeq, snareSeq: C.snareSeq, dropAge: now - dropAt, energy: C.env.e,
        buildK: sec === 'build' ? Math.max(Math.min(1, (now - this.buildFrom) / (60000 / bpm * 32)), musicClock.show.frame?.build ?? 0) : 0, speed: sty.speed, strobes: opts.strobes && this.state.safe !== false ? true : opts.strobes,
        gate: (key, at) => this.gate.depth(`st${key}`, at), now };
      const main = styleLayer(sty.style, sec);
      const acc = sty.style.accent ?? { pat: 'wash', floor: 0.55, color: 'pair', kick: 0.5 } as const;
      for (const g of this.groups.values()) {
        if (this.ov?.groups[g.name]) continue;                                    // an alert reaction's override plays its own program (below)
        const kind = groupKind(g.name);
        if (PRACTICAL_KINDS.has(kind) || (this.modern && STILL_ROLES.has(g.role))) continue;   // practicals, windows, screens … keep theirs (below)
        const layer = kind === 'sign' || kind === 'neon' ? acc : main;
        const st = e.settings.get(g.name)!;
        const slots = g.fixtures.length ? g.fixtures : [g.pseudo!];
        for (const fx of slots) {
          if (!fx.geo || !fx.sc) continue;
          const o = styleEval(layer, fx.geo, this.sIn, this.sOut);
          const lv = o.lv * st.intensity * (st.program === 'off' && look.groups?.[g.name] ? 0 : 1);
          const col = fx.sc[k];
          if (o.hue) col.setHSL(o.hue, 1, 0.55); else col.copy(A).lerp(Bc, o.mix);
          fx.lv[k] = 1 + (lv - 1) * this.pl; fx.hu[k] = 0; fx.pc[k] = col; fx.wh![k] = o.white * this.pl;
        }
      }
      void tSec; void palA; void palB;
    } else {
      for (const g of this.groups.values()) for (const fx of g.fixtures.length ? g.fixtures : [g.pseudo!]) if (fx.wh) fx.wh[k] = 0;
    }
    const paletted = look.palette !== 'authored';
    // lights down = low, never black: practicals (lamps, lava lamp, sign, string lights, ON AIR, tanks) keep glowing
    const pk = Math.min(1, Math.max(0, (0.75 - houseLevel(look.house)) / 0.59));
    // Reactive lights (the director, shared/lightDirector.ts): SHOW / REACT with Beat reactive on and the room show
    // preset - every group the host hasn't set by hand follows its role (show / accent / deco / sign move with the
    // music, practicals / windows / screens / signals / moods never dance). Music styles still win where set.
    const dir = this.modern && !sty && (e.id === 'show' || e.id === 'react') && this.state.reactive && (this.state.program || 'show') === 'show' ? (showById(this.state.mood!) ?? showById('room')) : null;
    if (dir) this.directPrep(dir, now);
    for (const g of this.groups.values()) {
      const ovr = !!this.ov?.groups[g.name];                              // an alert reaction's override: its own program in any look / style
      if (sty && !ovr && !(this.modern && STILL_ROLES.has(g.role)) && !PRACTICAL_KINDS.has(groupKind(g.name))) continue;   // the style set these
      const st = e.settings.get(g.name)!;
      const explicit = ovr || (e.id === 'show' ? !!this.state.groups?.[g.name] : !!look.groups?.[g.name]);
      if (this.modern && !explicit && STILL_ROLES.has(g.role)) { this.stillGroup(g, st, k, tSec, pk); continue; }
      if (dir && !explicit) { this.directGroup(g, st, k); continue; }
      const floor = pk * (PRACTICAL_FLOOR[groupKind(g.name)] ?? 0) * (st.program === 'off' && look.groups?.[g.name] ? 0 : 1);
      const prog = st.program;
      const ambient = AMBIENT_PROGRAMS.has(prog);
      const n = g.fixtures.length;
      const slots = n ? g.fixtures : [g.pseudo!];
      // an alert reaction's override animates with or without a music input (the built-in auto show clock)
      const pc0 = this.pc, pl0 = this.pl;
      if (ovr) { this.pc = beatClock.active(now + (this.state.delay ?? 0)) ? this.clock : this.auto; this.pl = 1; }
      for (const fx of slots) {
        if (ovr && fx.wh) fx.wh[k] = 0;                                  // (a music style may have left a white flash on a group the override now owns)
        let [lv, hue] = this.program(prog, st, fx.index, Math.max(1, n), fx.seed, now, tSec);
        if (!ambient) { lv = 1 + (lv - 1) * this.pl; hue *= this.pl; }
        lv *= st.intensity;
        if (floor > lv) lv = floor;
        let pc: THREE.Color | null = e.colors.get(g.name) ?? null;
        if (paletted && prog === 'cycle') {                              // palette looks: cycle through the palette instead of hue steps
          const bar = Math.floor(this.pc.barAt(now) * st.speed);
          pc = (bar + fx.index) % 2 ? palB : palA; hue = 0;
        }
        fx.lv[k] = lv; fx.hu[k] = hue; fx.pc[k] = pc;
      }
      if (ovr) { this.pc = pc0; this.pl = pl0; }
    }
  }

  // ---------------------------------------------------------------- reactive director
  private roomPal: [number, number, number][] = [];
  private dOut = newOut(); private dOut2 = newOut(); private dOut3 = newOut();
  private dFr: MusicFrame | null = null; private dIdle: MusicFrame | null = null;
  private dShow: ReturnType<typeof showById> = null;
  private dSec: DirSection = 'idle'; private dPrevSec: DirSection = 'idle'; private dChangeAt = -Infinity; private dFade = 1;
  private dPal: [number, number, number][] = []; private dPalPrev: [number, number, number][] = [];
  private dLive = 0;
  private gateFn = (key: string, at: number) => this.gate.depth(`dir${key}`, at);
  private mkFrame(): MusicFrame {
    return { now: 0, beat: 0, bar: 0, barPos: 0, phraseId: 0, phraseBeat: 0, section: 'idle', sectionBeats: 0, intensity: 0, kick: 0, kickAge: Infinity, dropAge: Infinity, buildK: 0, bpm: 120, gate: this.gateFn, room: this.roomPal };
  }
  /** Once per look evaluation: the musical moment, the section (with a one-bar crossfade), the palettes. */
  private dPrepAt = NaN; private frameDt = 0; private dState: FrameState = { sec: 'idle', changeAt: -Infinity, dropSecAt: -Infinity };
  private directPrep(show: NonNullable<ReturnType<typeof showById>>, now: number) {
    if (now === this.dPrepAt && show === this.dShow) return;     // once per frame (a crossfade evaluates two looks)
    this.dPrepAt = now;
    const C = this.clock;
    const fr = (this.dFr ??= this.mkFrame()), idle = (this.dIdle ??= this.mkFrame());
    const live = this.live * (C.talking(now + (this.state.delay ?? 0)) ? 0 : 1);
    this.dLive += (live - this.dLive) * (1 - Math.exp(-this.frameDt / 0.2));
    if (Math.abs(live - this.dLive) < 1e-3) this.dLive = live;
    // (Room and Calm keep every hit under 3 a second even with the limit off; Club and Rave only with it on)
    const fst = this.dState;
    if (frameFromClock(fr, fst, C, now, this.dLive, this.state.safe !== false || show.mood === 'room' || show.mood === 'calm', { momentDropAt: this.momentDropAt, pre: this.live > 0.001 ? musicClock.show.frame : null })) {
      this.dPrevSec = fst.prevSec ?? 'idle'; this.dPalPrev = this.dPal;
    }
    this.dSec = fst.sec; this.dChangeAt = fst.changeAt;
    const bpm = fr.bpm, sec = fr.section;
    fr.room = this.roomPal;
    Object.assign(idle, fr, { section: 'idle', intensity: 0.5, kick: 0, dropAge: Infinity });
    this.dShow = show;
    // a section change crossfades over one bar (into a drop: a cut)
    this.dFade = sec === 'drop' ? 1 : Math.min(1, (now - this.dChangeAt) / (240000 / bpm));
    this.dPal = showPalette(show, fr);
    if (!this.dPalPrev.length) this.dPalPrev = this.dPal;
  }
  private prevFrame: MusicFrame | null = null;
  /** One group under the director. */
  private directGroup(g: Group, st: LightGroupSetting, k: 0 | 1) {
    const show = this.dShow!, fr = this.dFr!, idle = this.dIdle!;
    // the live frame's look LAST: a show's pick hook (the show pack) remembers its last pick, and the club rig plays it
    const idleLook = showLook(show, idle);
    let prevLook = null;
    if (this.dFade < 1) { const pf = (this.prevFrame ??= this.mkFrame()); Object.assign(pf, fr, { section: this.dPrevSec }); prevLook = showLook(show, pf); }
    const look = showLook(show, fr);
    const w = this.dLive;
    for (const fx of g.fixtures.length ? g.fixtures : [g.pseudo!]) {
      const info = fx.info; if (!info || !fx.sc) continue;
      const o = this.dOut;
      let ok = look && w > 0.001 ? evalFixture(look, info, fr, this.dPal, o) : false;
      if (ok && prevLook && evalFixture(prevLook, info, fr, this.dPalPrev, this.dOut3)) mixOut(o, this.dOut3, 1 - smooth(0, 1, this.dFade));
      if (w < 0.999 && idleLook && evalFixture(idleLook, info, idle, this.dPal, this.dOut2)) { if (ok) mixOut(o, this.dOut2, 1 - w); else { Object.assign(o, this.dOut2); ok = true; } }
      if (!ok) { fx.lv[k] = st.intensity; fx.hu[k] = 0; fx.pc[k] = null; if (fx.wh) fx.wh[k] = 0; continue; }
      const col = fx.sc[k];
      col.setRGB(o.r, o.g, o.b);
      fx.lv[k] = o.dim * st.intensity; fx.hu[k] = 0; fx.pc[k] = col; if (fx.wh) fx.wh[k] = o.white;
      // real spot lights of show fixtures aim where the look's pan / tilt says (moving-head style, on the beat grid)
      for (const l of fx.lights) { l.userData.dirPan = o.pan * w; l.userData.dirTilt = o.tilt * w; }
    }
  }
  /** Practicals, windows, screens, signals, moods: never the music. Flames flicker softly, signals blink on their own. */
  private stillGroup(g: Group, st: LightGroupSetting, k: 0 | 1, tSec: number, pk: number) {
    const keep = st.program === 'off' ? 0 : g.role === 'practical' && STEADY_PROGRAMS.has(st.program) ? st.intensity : 1;
    const floor = pk * (PRACTICAL_FLOOR[groupKind(g.name)] ?? (g.role === 'practical' ? 0.6 : 0));
    for (const fx of g.fixtures.length ? g.fixtures : [g.pseudo!]) {
      let lv = 1;
      // (a soft flicker: under 5 % swing, so a candle never counts as a flash)
      if (g.flame) lv = 0.96 + 0.015 * Math.sin(tSec * 7.1 + fx.seed * 40) * Math.sin(tSec * 2.3 + fx.seed * 13) + 0.007 * Math.sin(tSec * 17.3 + fx.seed * 7);
      else if (g.role === 'signal') { const u = frac(tSec / 1.6 + fx.seed); lv = 0.4 + 0.9 * Math.exp(-Math.max(0, u - 0.02) * 14) * (u < 0.3 ? 1 : 0); }
      lv = Math.max(lv * keep, keep > 0 ? floor : 0);
      fx.lv[k] = lv; fx.hu[k] = 0; fx.pc[k] = null; if (fx.wh) fx.wh[k] = 0;
    }
  }
  /** Rooms with no light groups: two coloured accent washes (real point lights within the tier budget). */
  private fallback: { l: THREE.PointLight; side: number; ch: GovChannel }[] = [];
  private fallbackRig(ctx: SceneLightsContext, n: number) {
    const b = ctx.room.bounds, c = b.getCenter(new THREE.Vector3()), sz = b.getSize(new THREE.Vector3());
    if (b.isEmpty() || !(sz.x > 0.5)) return;
    for (let i = 0; i < n; i++) {
      const side = n === 1 ? 0 : i === 0 ? -1 : 1;
      const l = new THREE.PointLight(0xffffff, 0, Math.max(6, Math.min(18, Math.max(sz.x, sz.z) * 0.9)), 2);
      l.position.set(c.x + side * sz.x * 0.38, b.min.y + Math.min(sz.y * 0.8, 3.2), b.min.z + sz.z * 0.2);
      l.name = `vtp:auto_accent_${i}`;
      ctx.scene.add(l);
      this.fallback.push({ l, side, ch: govChannel(`auto accent ${i}`) });
    }
  }
  private fallbackUpdate(now: number) {
    if (!this.fallback.length) return;
    const on = this.state.reactive && (this.state.state ?? 'show') !== 'brb' ? 1 : 0;
    const fr = this.dFr, pal = this.dPal.length ? this.dPal : null;
    for (const f of this.fallback) {
      const P = pal ? pal[f.side > 0 ? 1 : 0] : [1, 0.85, 0.7];
      const music = this.dLive;
      const beat = fr ? fr.beat : this.clock.showTime(now) / 500;
      // (a pulse a beat up to 132 BPM, every other beat above: never more than ~2 a second, limit or not)
      const pb = fr && fr.bpm > 132 ? beat / 2 : beat;
      const pulse = fr && music > 0.01 ? 0.25 * fr.kick * Math.exp(-frac(pb) * 4) : 0;
      const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * (beat / 16 + (f.side > 0 ? 0.5 : 0)));
      const lv = on * (0.35 + music * (0.35 * (fr?.intensity ?? 0) + 0.2 * swell + pulse));
      // (photosensitivity: each accent light is an output on the governor, like every fixture)
      const lum = Math.max(1e-4, relLum(P[0], P[1], P[2]));
      f.l.intensity = 9 * this.gov.step(f.ch, lv * lum, isSatRed(P[0], P[1], P[2])) / lum * this.state.intensity;
      if (!this.gov.holdRed) f.l.color.setRGB(P[0], P[1], P[2]);
    }
  }

  private palette(look: LightingLook, C: BeatClock, now: number, a: THREE.Color, b: THREE.Color) {
    const pairs = (PALETTES[look.palette] ?? PALETTES.authored).pairs;
    const phrase = Math.floor(C.barAt(now) / 8) + C.dropSeq;
    const i = ((phrase % pairs.length) + pairs.length) % pairs.length;
    a.set(pairs[i][0]); b.set(pairs[i][1]);
    return phrase;
  }

  /** Auto-downgrade of the effects rig: frame interval (EMA) with effects on vs the page's cadence; slow → fewer beams / rays / spots. */
  private dtOff = 1 / 60; private dtOn = 1 / 60; private slowFor = 0; private goodFor = 0;
  private ladder(dt: number, fxOn: boolean) {
    if (!(dt > 0) || dt > 0.25 || !this.fx) return;
    // the page's own cadence (fps cap / vsync): a slowly relaxing minimum of the frame interval
    this.dtOff = Math.min(dt, this.dtOff + 0.00002);
    if (!fxOn) return;
    this.dtOn += (dt - this.dtOn) * 0.05;
    const slow = this.dtOn > this.dtOff * 1.3 + 0.002;
    this.slowFor = slow ? this.slowFor + dt : 0;
    this.goodFor = this.dtOn < this.dtOff * 1.08 + 0.001 ? this.goodFor + dt : 0;
    if (this.slowFor > 3 && this.fx.level < 2) { this.fx.setLevel(this.fx.level + 1); this.slowFor = 0; this.dtOn = this.dtOff; }
    else if (this.goodFor > 30 && this.fx.level > 0) { this.fx.setLevel(this.fx.level - 1); this.goodFor = 0; }
  }

  update(dt: number) {
    const t0 = performance.now();
    this.render(epochNow(), dt);
    this.cost += (performance.now() - t0 - this.cost) * 0.05;
  }

  /** Levels for every group at local epoch time `wall` (the clock is read `delay` ms in the past). */
  private render(wall: number, dt: number) {
    if (!this.ctx) return;
    this.attached = true;
    const C = this.clock;
    C.update(wall);
    this.autoTick(wall);
    this.auto.update(wall);
    // (the frame being computed appears on screen about one frame later: the music is read for THAT moment, so a hit
    // pre-cued on the grid lands on the beat on screen, not a frame after it — rhythm lane, tools/beat/rhythm_eval.ts)
    if (dt > 0 && dt < 0.1) this.frameLead += (Math.min(40, dt * 1000) - this.frameLead) * 0.05;
    const now = wall - (this.state.delay ?? 0) + this.frameLead;
    const liveTarget = this.state.reactive && C.active(wall) ? 1 : 0;
    this.live += (liveTarget - this.live) * (dt > 0 ? 1 - Math.exp(-dt / (liveTarget > this.live ? 0.35 : 1.2)) : 1);
    if (Math.abs(liveTarget - this.live) < 1e-3) this.live = liveTarget;
    const master = this.state.intensity;
    this.frameDt = Math.max(0, Math.min(0.1, dt));
    const tSec = this.clock.showTime(wall) / 1000;
    this.gov.safe = this.state.safe !== false;
    {
      // the governor's windows on the beat grid (the same instants on every page): half beats up to 166 BPM, beats
      // above, every 2 beats above 333; no grid: 180 ms slots of the sender's clock
      const pos = C.active(wall) ? C.posAt(now) : NaN;
      if (Number.isFinite(pos) && C.bpm >= 40) {
        const P = 60000 / C.bpm, n = P >= 360 ? 2 : P >= 180 ? 1 : 0.5, x = pos * n, slot = Math.floor(x);
        this.gov.frame(wall, slot, (x - slot) * P / n);
      } else { const st = this.clock.showTime(wall); this.gov.frame(wall, Math.floor(st / 180) + 1e7, st - Math.floor(st / 180) * 180); }
    }
    // ---- lighting state (+ transition)
    const tr = this.trans;
    let p = 1;
    if (tr) { p = Math.min(1, (wall - tr.t0) / tr.dur); if (p >= 1) this.trans = null; }
    const cyc = C.active(wall) ? C : this.auto;
    const phrase8 = Math.floor(cyc.barAt(now) / 8);
    const B = this.lookEval(this.preview ? 'preview' : this.cur, phrase8);
    const A = tr && p < 1 && !this.preview ? this.lookEval(tr.from, phrase8) : null;
    const w = A ? smooth(0, 1, p) : 1;
    const open = !!(A && tr?.open);
    const fxLook = B.look.fx > 0 || !A ? B : A;
    const fxClock = fxLook.look.music === 'auto' && !C.active(wall) ? this.auto : C;
    const phrase = this.palette(fxLook.look, fxClock, now, this.palA, this.palB);
    for (const l of this.lights) if (l.userData.dirPan || l.userData.dirTilt) { l.userData.dirPan = 0; l.userData.dirTilt = 0; }
    this.evalInto(B, 1, now, tSec, this.palA, this.palB);
    if (A) this.evalInto(A, 0, now, tSec, this.palA, this.palB);
    // show-open: blackout hit, ON AIR slams on, then the room racks up bank by bank
    const blk = open ? 1 - smooth(0, 0.03, p) : 1 - w;
    const bankOn = (bank: number) => (open ? smooth(0.25 + bank * 0.15, 0.25 + bank * 0.15 + 0.04, p) : w);
    const slam = open && p >= 0.15 ? 1.2 * Math.exp(-(p - 0.15) * tr!.dur / 280) * this.gate.depth(`open${tr!.t0}`, tr!.t0 + 0.15 * tr!.dur) : 0;
    const cue = wall - this.cueAt < 1200 ? Math.exp(-(wall - this.cueAt) / 260) * this.gate.depth(`cue${this.cueAt}`, this.cueAt) : 0;
    // alert reaction cue: 4 pulses 500 ms apart (each one a gated flash)
    let alert = 0;
    const aAge = wall - this.alertAt;
    if (aAge >= 0 && aAge < 2600) for (let i = 0; i < 4; i++) { const a = aAge - i * 500; if (a >= 0) alert = Math.max(alert, Math.exp(-a / 220) * this.gate.depth(`alert${this.alertAt}:${i}`, this.alertAt + i * 500)); }
    for (const g of this.groups.values()) {
      const slots = g.fixtures.length ? g.fixtures : [g.pseudo!];
      let sum = 0, sumL = 0, hue0 = 0, pc0: THREE.Color | null = null;
      for (const fx of slots) {
        let lv: number;
        if (!A) lv = fx.lv[1];
        else if (open) lv = fx.lv[0] * blk + fx.lv[1] * (g.onair ? (p >= 0.15 ? 1 : 0) : bankOn(fx.bank));
        else lv = fx.lv[0] * (1 - w) + fx.lv[1] * w;
        if (g.onair) lv *= 1 + slam + cue * 1.2;
        if (alert > 0 && (g.onair || this.alertGroups.has(g.name))) lv *= 1 + alert * 1.6;
        const hue = A ? fx.hu[0] * (1 - w) + fx.hu[1] * w : fx.hu[1];
        let pc = A && w < 0.5 ? fx.pc[0] : fx.pc[1];
        // white flashes from the style + support celebrations (cue overlays) on top
        let wh = fx.wh ? (A ? fx.wh[0] * (1 - w) + fx.wh[1] * w : fx.wh[1]) : 0;
        // (celebrations sweep the show + accent lights; lamps, windows, screens and signals stay as they are)
        if (this.cueList.length && fx.geo && !(this.modern && STILL_ROLES.has(g.role))) {
          for (const c of this.cueList) {
            const o = cueEval(c.what, fx.geo, wall - c.at, (this.state.styleOpts ?? DEFAULT_STYLE_OPTS).strobes, this.cueTmp, this.gov.safe);
            if (o.lv < 0) { lv *= 0.05; continue; }
            if (o.lv <= 0.001) continue;
            const d = this.gate.depth(`cue${c.at}`, c.at);
            if (o.lv * d > lv * 0.6) { fx.wc ??= new THREE.Color(); fx.wc.set(o.color); pc = fx.wc; }
            lv = Math.max(lv, o.lv * d); wh = Math.max(wh, o.white * d);
          }
        }
        if (wh > 0.01) { fx.wc ??= new THREE.Color(); fx.wc.copy(pc ?? g.color ?? (fx.mats[0]?.baseColor ?? this.white)).lerp(this.white, Math.min(1, wh)); pc = fx.wc; }
        // ---- the photosensitivity governor: what this fixture would show (colour × level, luminance) → what it may
        const want = this.shownTmp.copy(pc ?? g.color ?? fx.mats[0]?.baseColor ?? fx.f?.color ?? this.white);
        if (hue) want.offsetHSL(hue, 0, 0);
        fx.ch ??= govChannel(g.name); fx.shown ??= want.clone();
        // (a snapshot: if the group as a whole may not turn this frame, the whole group stays as it was — below)
        fx.snap ??= { ...fx.ch }; Object.assign(fx.snap, fx.ch); fx.snapCol ??= new THREE.Color(); fx.snapCol.copy(fx.shown);
        const Lw = lv * relLum(want.r, want.g, want.b);
        const Ly = this.gov.step(fx.ch, Lw, isSatRed(want.r, want.g, want.b));
        // a held turn keeps the colour it had (a darker colour is never pushed brighter to fake the old luminance)
        if (!this.gov.holdRed && !(Ly > Lw * 1.15)) fx.shown.copy(want);
        const Ls = relLum(fx.shown.r, fx.shown.g, fx.shown.b);
        const lvOut = fx.shown.equals(want) && Lw > 1e-6 ? lv * Ly / Lw : Ls > 1e-6 ? Ly / Ls : 0;
        fx.outLv = lvOut; fx.outL = Ly; fx.hue = hue;
        sumL += Ly;
      }
      // the group as one area (an EMIT_ wall, a row of PARs): its total light is governed too; when it may not turn
      // now, every fixture of the group keeps last frame's light (their governors are rolled back to it)
      if (slots.length > 1) {
        g.gch ??= govChannel(`group:${g.name}`);
        const gs = this.gov.step(g.gch, sumL);
        if (Math.abs(gs - sumL) > 1e-6 * Math.max(1, sumL)) {
          sumL = 0;
          for (const fx of slots) { Object.assign(fx.ch!, fx.snap!); fx.shown!.copy(fx.snapCol!); fx.outLv = fx.lastLv ?? fx.outLv; fx.outL = fx.lastL ?? fx.outL; sumL += fx.outL!; }
          g.gch.y = sumL;
        }
      }
      for (const fx of slots) {
        const col = fx.shown!, lvOut = fx.outLv!;
        fx.lastLv = lvOut; fx.lastL = fx.outL;
        fx.level = lvOut;
        if (fx.index === 0) { hue0 = 0; pc0 = col; }
        sum += lvOut;
        const k = master;
        for (const fm of fx.mats) {
          fm.m.emissive.copy(col);
          fm.m.emissiveIntensity = fm.baseI * lvOut * k;
        }
        for (const l of fx.lights) {
          l.intensity = (l.userData.base as number) * lvOut * k;
          l.color.copy(col);
        }
      }
      let mean = (sum / slots.length) * master;
      if (g.shared.length && g.sharedShown) {
        // the group's other EMIT_ meshes: fixture 0's colour at the group's mean LUMINANCE (governed again)
        const c0 = pc0 ?? g.color ?? g.shared[0].baseColor, lc = relLum(c0.r, c0.g, c0.b);
        g.sch ??= govChannel(`shared:${g.name}`);
        if (lc > 1e-6) mean = this.gov.step(g.sch, sumL / slots.length, isSatRed(c0.r, c0.g, c0.b)) / lc * master;
      }
      for (const sm of g.shared) {
        sm.m.emissive.copy(pc0 ?? g.color ?? sm.baseColor);
        if (hue0) sm.m.emissive.offsetHSL(hue0, 0, 0);
        sm.m.emissiveIntensity = sm.baseI * mean;
      }
    }
    // ---- effects rig amount (blackout kills it at once on the show-open)
    this.cueList = this.cueList.filter((c) => wall - c.at < 6000);
    let fxAmt = !A ? B.look.fx : open ? A.look.fx * blk : A.look.fx * (1 - w) + B.look.fx * w;
    const ballOn = wall < this.ballUntil, laserOn = wall < this.laserUntil;
    if (ballOn || laserOn) fxAmt = Math.max(fxAmt, 0.85);
    const dropAge = now - Math.max(fxClock.dropAt, this.momentDropAt);
    const dropDepth = dropAge < 2000 ? this.gate.depth(`fxd${fxClock.dropSeq}`, fxClock.dropAt) : 0;
    // ---- house lights: level × tint (+ a palette wash in effects looks, a white hit on drops)
    const houseOf = (e: LookEval) => houseLevel(e.look.house);
    let house = !A ? houseOf(B) : open ? Math.max(0.05, houseOf(A) * blk + houseOf(B) * (Math.floor(Math.min(4, Math.max(0, (p - 0.25) / 0.15 + 1))) / 4)) : houseOf(A) * (1 - w) + houseOf(B) * w;
    if (ballOn) house = Math.min(house, 0.45 + 0.55 * Math.min(1, (this.ballUntil - wall) / 1500));
    const tintOf = (e: LookEval, out: THREE.Color) => { out.set(e.look.tint ?? '#ffffff'); const l = (out.r * 0.2126 + out.g * 0.7152 + out.b * 0.0722) || 1; out.multiplyScalar(1 / l); if (e.look.fx > 0 && e.look.palette !== 'authored') out.lerp(this.tmpC.copy(this.palA).multiplyScalar(1 / Math.max(0.05, this.palA.r * 0.2126 + this.palA.g * 0.7152 + this.palA.b * 0.0722)), 0.35 * e.look.fx); return out; };
    tintOf(B, this.tintB);
    if (A && !open) { tintOf(A, this.tintA); this.tintB.lerp(this.tintA, 1 - w); }
    if (fxAmt > 0 && dropAge < 400) house += 0.45 * fxAmt * dropDepth * Math.exp(-dropAge / 90);
    // alert reaction override: house level / tint eased in (0.4 s) and out (1 s)
    const ovOn = !!this.ov && (this.ov.house !== undefined || !!this.ov.tint);
    this.ovK = ovOn ? Math.min(1, this.ovK + (dt > 0 ? dt / 0.4 : 1)) : Math.max(0, this.ovK - (dt > 0 ? dt / 1 : 1));
    if (this.ovK > 0) {
      if (this.ovLast.house !== undefined) house += (houseLevel(this.ovLast.house) - house) * this.ovK;
      // (a house-only override leaves the look's own tint alone: easing it to white would wash the room's colour out)
      if (this.ovLast.tintOn) {
        const t = this.tmpC.copy(this.ovLast.tint), l = (t.r * 0.2126 + t.g * 0.7152 + t.b * 0.0722) || 1;
        this.tintB.lerp(t.multiplyScalar(1 / l), this.ovK);
      }
    }
    if (this.showDim < 1) house *= Math.max(0, this.showDim);
    house = this.gov.step(this.houseCh, house);
    this.houseNow = house;
    this.setHouse(house, this.tintB);
    // Reactive lights also colour the performers a little (the stage's hemisphere + rim take the look's palette and
    // the rim kicks on the beat grid): the show reaches the people, not just the walls — and rooms whose lights are
    // mostly lamps / windows still visibly react. Colours only (never the intensities SceneRuntime owns).
    const dirWash = this.dShow && fxAmt < 0.01 && this.dLive > 0.001 && this.dPal.length ? MOOD_WASH[this.dShow.mood] * this.dLive : 0;
    if (dirWash > 0) {
      this.palA.setRGB(this.dPal[0][0], this.dPal[0][1], this.dPal[0][2]); this.palB.setRGB(this.dPal[1][0], this.dPal[1][1], this.dPal[1][2]);
      const fr = this.dFr!, gridKick = fr.kick > 0.4 ? (fr.beat - Math.floor(fr.beat)) * 60000 / Math.max(40, fr.bpm) : Infinity;
      this.wash(dirWash, gridKick);
    } else this.wash(fxAmt, now - fxClock.kickAt);
    this.ladder(dt, fxAmt > 0.01);
    this.fallbackUpdate(now);
    flashWarning(flashPillOn(this.state, wall - this.gov.overAt));   // (the governor measures what is shown; lights.warnOnStream switches the notice)
    // ---- the show on the performers (patched avatar materials; zero in SHOW)
    if (this.ctx.actors && this.ctx.camera) {
      if (wall - this.actorsAt > 250) {
        this.actorsAt = wall;
        this.performers = this.ctx.actors().filter((a) => a.face).map((a) => ({ obj: a.obj, head: a.face!.clone(), chest: a.face!.clone().add(new THREE.Vector3(0, -0.32, 0)) }));
      }
      const on = fxAmt > 0.005;
      const kick = Math.exp(-Math.max(0, now - fxClock.kickAt) / 180);
      const dropHit = this.gov.step(this.perfCh, 1 + (on && dropAge < 400 ? dropDepth * Math.exp(-dropAge / 110) * 0.6 : 0)) - 1;
      this.pWash.copy(this.palA).multiplyScalar(on ? 0.1 * fxAmt : 0);
      this.pRim.copy(this.palB).multiplyScalar(on ? this.gov.step(this.perfRimCh, 1 + (0.28 + 0.18 * kick) * fxAmt) - 1 : 0);
      this.perf.update(this.performers, on && this.fx ? this.fx.lightBeams() : [], this.ctx.camera,
        // (the mirror-ball sparkle twinkles at ~7 Hz per cell: off while the flash limit is on)
        { wash: this.pWash, rim: this.pRim, flash: dropHit, spark: on && this.fx && !this.gov.safe ? this.fx.sparkle * 0.9 : 0, t: tSec, now: wall });
    }
    // ---- effects
    if (this.fx) {
      if (fxAmt > 0.002 && this.ctx.faces && wall - this.facesAt > 200) { this.facesAt = wall; this.faces = this.ctx.faces(); }
      const pos = fxClock.posAt(now);
      // arrangement: builds (energy rising / buildup), snare-roll fills, moody breakdowns
      const e = fxClock.env.e, dts = Math.max(0, dt);
      this.eSlow += (e - this.eSlow) * Math.min(1, dts / 4);
      if (fxClock.snareSeq !== this.lastSnareSeq) { this.lastSnareSeq = fxClock.snareSeq; this.snares.push(now); }
      while (this.snares.length && now - this.snares[0] > 1200) this.snares.shift();
      const build = Math.min(1, Math.max(fxClock.section === 'buildup' ? 0.75 : 0, (e - this.eSlow) * 5));
      const fill = Math.min(1, Math.max(0, (this.snares.length - 3) / 4));
      this.brk += ((fxClock.section === 'breakdown' ? 1 : 0) - this.brk) * Math.min(1, dts / 1.2);
      const pr = presetById(fxLook.look.preset);
      const bar = fxClock.barAt(now);
      const stNow = this.styleNow[1] ?? this.styleNow[0];
      const sec = stNow ? this.section(fxClock, now) : 'groove';
      const motions = stNow?.beams?.[sec] ? [stNow.beams[sec]!] : pr?.motion ?? ['fan', 'figure8', 'sweep', 'cross', 'ballyhoo'];
      const lasers = stNow?.lasers?.[sec] ? [stNow.lasers[sec]!] : pr?.lasers ?? ['fan', 'cross', 'tunnel', 'sheet'];
      const mi = Math.floor(bar / 8) + fxClock.dropSeq, li = Math.floor(bar / 16) + fxClock.dropSeq;
      if (stNow) {                                      // the style's palette drives the beams / lasers / washes too
        const sp = this.styleOf(fxLook, fxClock, now)?.palette ?? stNow.palette;
        const ph = Math.floor(bar / 8) + fxClock.dropSeq; const pair = sp[((ph % sp.length) + sp.length) % sp.length];
        this.palA.set(pair[0]); this.palB.set(pair[1]);
      }
      this.fx.update({
        amount: fxAmt, pos: Number.isFinite(pos) ? pos : this.clock.showTime(now) / 500, barPos: fxClock.barPosAt(now) || 0,
        kickAge: now - fxClock.kickAt, hatAge: now - fxClock.hatAt, dropAge, dropDepth,
        a: this.palA, b: this.palB, speed: fxLook.look.energy, energy: e, phrase,
        camera: this.ctx.camera ?? new THREE.PerspectiveCamera(), faces: this.faces, tSec,
        motion: motions[((mi % motions.length) + motions.length) % motions.length], laser: lasers[((li % lasers.length) + lasers.length) % lasers.length],
        gov: this.gov, safe: this.gov.safe,
        split: pr?.split ?? 'oddeven', ball: pr?.ball ?? 1, mix: (ballOn || laserOn) && B.look.fx < 0.05 ? [ballOn ? 0.25 : 0.4, laserOn ? 1 : 0, ballOn ? 1 : 0] : pr?.mix ?? [1, 0.8, 0.8], build, fill, breakdown: this.brk, bar, bpm: fxClock.bpm || 120,
      }, dt);
      // real spot lights sweep like moving heads in effects looks
      for (const l of this.lights) {
        const base = l.userData.target as THREE.Vector3 | undefined;
        if (!base || !(l instanceof THREE.SpotLight)) continue;
        const ph = (Number.isFinite(pos) ? pos : this.clock.showTime(now) / 500) * Math.PI / 4 * fxLook.look.energy + base.x;
        const dp = (l.userData.dirPan as number) || 0, dtl = (l.userData.dirTilt as number) || 0;
        l.target.position.set(base.x + Math.sin(ph) * 1.4 * fxAmt + dp * 1.4, base.y, base.z + Math.cos(ph * 0.7) * 0.9 * fxAmt + dtl * 0.9);
        if (fxAmt > 0.01) l.color.lerp(this.tmpC.copy(this.lights.indexOf(l) % 2 ? this.palB : this.palA), fxAmt);
      }
    }
  }

  /** Stage lights take the palette in effects looks (a colour wash + a brighter coloured rim on the performers). */
  private wash(fxAmt: number, kickAge: number) {
    const k = Math.min(1, fxAmt);
    const kick = Math.exp(-Math.max(0, kickAge) / 180);
    for (const s of this.stageLights) {
      if (s.ground) {
        s.l.color.copy(s.color).lerp(this.tmpC.copy(this.palA).lerp(s.color, 0.55), 0.5 * k);
        (s.l as THREE.HemisphereLight).groundColor.copy(s.ground).lerp(this.palB, 0.45 * k);
      } else {
        s.l.color.copy(s.color).lerp(this.palB, 0.75 * k).multiplyScalar(1 + k * (0.7 + 0.5 * kick));
        const L = relLum(s.l.color.r, s.l.color.g, s.l.color.b);
        if (L > 1e-6) s.l.color.multiplyScalar(this.gov.step(this.rimCh, L) / L);
      }
    }
  }

  private setHouse(level: number, tint: THREE.Color) {
    const key = `${level.toFixed(4)}|${tint.r.toFixed(3)},${tint.g.toFixed(3)},${tint.b.toFixed(3)}`;
    if (key === this.houseKey) return;
    this.houseKey = key;
    for (const h of this.house) {
      h.m.color.copy(h.base).multiply(tint).multiplyScalar(level);
      // the environment (IBL) light too, or a 'blackout' room stays grey; self-lit backdrops (night sky) dim less
      if (h.m.envMapIntensity !== undefined) h.m.envMapIntensity = h.env * Math.min(1.2, level);
      if (h.m.emissiveIntensity !== undefined) h.m.emissiveIntensity = h.em * Math.min(1, 0.35 + 0.65 * level);
      // dielectric specular ignores the colour (a dark room would stay grey under the stage lights): lean towards
      // metal-with-a-dark-albedo as the house goes down, so the highlights dim with it (as authored at level 1)
      if (h.m.metalness !== undefined) h.m.metalness = h.metal + (1 - h.metal) * (1 - Math.min(1, level));
    }
  }

  /** [level, hue offset] of one fixture (index i of n) for a program. level 1 = as authored. */
  private program(p: LightProgram, st: LightGroupSetting, i: number, n: number, seed: number, now: number, tSec: number): [number, number] {
    const C = this.pc;
    const speed = st.speed;
    const bpm = C.bpm || 120;
    const period = 60000 / bpm;
    let pos = C.posAt(now);
    if (!Number.isFinite(pos)) pos = this.clock.showTime(now) / 500;              // no grid yet: free-run at 120 BPM
    const barPos = Number.isFinite(C.barPosAt(now)) ? C.barPosAt(now) : frac(pos / 4) * 4;
    const e = C.env;
    switch (p) {
      case 'off': return [0, 0];
      case 'steady': return [1, 0];
      case 'pulse': {
        // kicks; the grid's beats when the track has no kick right now
        const kickAge = now - C.kickAt;
        const useGrid = !(kickAge < period * 2.2) && C.locked;
        const age = useGrid ? frac(pos) * period : kickAge;
        const key = useGrid ? `b${Math.floor(pos)}` : `k${C.kickSeq}`;
        const d = age < 2000 ? this.gate.depth(key, now - age) : 0;
        const tau = 170 / Math.sqrt(speed);
        const floor = 0.22 + 0.18 * e.e;
        return [floor + (1.35 - floor) * d * Math.exp(-Math.max(0, age) / tau), 0];
      }
      case 'chase': {
        const steps = n * speed * bpm / 240;                   // fixture steps per second
        // flash limit: <= 2 steps a second (each step lights one fixture and darkens the last: the group as a whole
        // swings once a step, so 3 steps/s plus a held hit could read as more than 3 flashes)
        const sp = this.gate.safe && steps > 2 ? speed * 2 / steps : speed;
        if (n === 1) {
          const u = frac(pos * sp);
          return [0.2 + 1.0 * Math.exp(-u * 4), 0];
        }
        const head = frac((barPos / 4) * sp) * n;               // one sweep per bar at speed 1
        const dist = ((head - i) % n + n) % n;                  // how far behind the head this fixture is
        // lit at the head, fading tail behind it, a short fade-in just before the head arrives
        const accent = 0.85 + 0.25 * Math.exp(-Math.max(0, now - C.kickAt) / 150);
        return [(0.12 + 1.15 * Math.max(Math.exp(-dist * 1.6), smooth(n - 0.35, n, dist))) * accent, 0];
      }
      case 'strobe': {
        let at = C.snareAt, key = `s${C.snareSeq}`;
        if (speed >= 2 && C.hatAt > at) { at = C.hatAt; key = `h${C.hatSeq}`; }
        const age = now - at;
        if (!(age < 1500)) return [0.35, 0];
        const d = this.gate.depth(key, at);
        const hold = 45, fall = 80 / Math.sqrt(speed);
        const f = age < 0 ? 0 : age < hold ? 1 : Math.exp(-(age - hold) / fall);
        return [0.35 + 1.45 * d * f, 0];
      }
      case 'breathe': {
        const u = pos * speed / 4;                              // one breath per bar at speed 1
        return [0.3 + 0.75 * (0.5 - 0.5 * Math.cos(2 * Math.PI * u)), 0];
      }
      case 'cycle': {
        const bar = Math.floor(((pos / 4) * speed));
        const within = frac((pos / 4) * speed) * 4 / speed;     // beats since this colour came in
        const a = CYCLE[((bar % 4) + 4) % 4], b = CYCLE[(((bar - 1) % 4) + 4) % 4];
        let dh = a - b; if (dh > 0.5) dh -= 1; if (dh < -0.5) dh += 1;
        const hue = b + dh * smooth(0, 0.35, within);
        const glow = 0.8 + 0.35 * Math.exp(-frac(pos) * period / 200);
        return [glow, hue];
      }
      case 'flicker': {
        const r = speed;
        let lv = 0.9 + 0.06 * Math.sin(tSec * 2 * Math.PI * 7.3 * r + seed * 50) * Math.sin(tSec * 2 * Math.PI * 2.9 * r + seed * 20);
        // drop-outs: in some 1.9 s slots, one or two short blinks
        const slotLen = 1.9 / r, slot = Math.floor(tSec / slotLen), inSlot = tSec - slot * slotLen;
        if (rnd(slot, seed * 97) < 0.4) {
          const at = rnd(slot, seed * 13 + 1) * (slotLen - 0.5), len = 0.05 + 0.1 * rnd(slot, seed * 7 + 2);
          const second = rnd(slot, seed * 5 + 3) < 0.5;
          if ((inSlot > at && inSlot < at + len) || (second && inSlot > at + len + 0.07 && inSlot < at + 2 * len + 0.07)) lv = 0.18;
        }
        return [lv, 0];
      }
      case 'drift': {
        const w = 0.5 + 0.5 * (0.6 * Math.sin(tSec * 0.7 * speed + seed * 40 + i * 1.7) + 0.4 * Math.sin(tSec * 1.9 * speed + seed * 90 + i * 2.3));
        return [(0.35 + 0.75 * w) * (1 + 0.35 * e.e * this.pl), 0];
      }
      case 'drop': {
        const sec = C.section;
        const base = sec === 'breakdown' ? 0.55 : sec === 'buildup' ? 0.65 + 0.45 * e.e : 0.85;
        const age = now - C.dropAt;
        if (!(age < 8000)) return [base, 0];
        const d = this.gate.depth(`d${C.dropSeq}`, C.dropAt);
        return [base + (1.9 - base) * d * Math.exp(-age / (period * 3)), 0];
      }
    }
    return [1, 0];
  }

  dispose() {
    for (const l of this.lights) { l.removeFromParent(); (l as THREE.SpotLight).target?.removeFromParent(); l.dispose(); }
    this.lights = [];
    for (const f of this.fallback) { f.l.removeFromParent(); f.l.dispose(); }
    this.fallback = [];
    flashWarning(false);
    for (const r of this.restore) r.mesh.material = r.material;
    this.restore = [];
    for (const c of this.clones) c.dispose();
    this.clones = [];
    for (const e of this.ctx?.room.emissive ?? []) { e.material.emissive.copy(e.baseColor); e.material.emissiveIntensity = e.baseIntensity; }
    for (const h of this.house) { h.m.color.copy(h.base); h.m.envMapIntensity = h.env; h.m.emissiveIntensity = h.em; if (h.m.metalness !== undefined) h.m.metalness = h.metal; }
    this.house = [];
    this.fx?.dispose(); this.fx = null;
    this.perf.dispose(); this.performers = [];
    for (const st of this.stageLights) { st.l.color.copy(st.color); if (st.ground) (st.l as THREE.HemisphereLight).groundColor.copy(st.ground); }
    this.stageLights = [];
    this.groups.clear();
    this.ctx = null;
  }

  /** Debug / tests: per-group level + program right now. */
  debug() {
    return { alert: { at: this.alertAt, groups: [...this.alertGroups] }, override: this.ov, overrideK: +this.ovK.toFixed(2), director: this.dShow ? { show: this.dShow.id, section: this.dSec, live: +this.dLive.toFixed(2), fade: +this.dFade.toFixed(2), roomPal: this.roomPal.length, fallback: this.fallback.length } : null, live: +this.live.toFixed(3), cost: +this.cost.toFixed(4), state: this.cur, style: this.styleNow[1]?.id ?? null, cues: this.cueList.map((c) => c.what), ball: epochNow() < this.ballUntil, trans: this.trans && { ...this.trans, p: +Math.min(1, (epochNow() - this.trans.t0) / this.trans.dur).toFixed(2) }, house: +this.houseNow.toFixed(3), fx: this.fx?.counts() ?? null,
      lights: this.lights.map((l) => [l.name, +l.intensity.toFixed(2)]), performers: this.perf.count(),
      groups: [...this.groups.values()].map((g) => ({ g: g.name, role: g.role, p: g.setting.program, n: g.fixtures.length, lv: g.fixtures.map((x) => +x.level.toFixed(2)) })) };
  }
}

setLightsFactory(() => new BeatLights());
