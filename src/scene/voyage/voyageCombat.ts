// Voyage action: everything that happens around the walking ship, sampled each frame as a pure function of the timeline
// (shared/voyage.ts) - battles (enemy approach / circling / defeat, the ship's salvos, return fire, hits on the hull,
// fires that the crew put out), support overlays (horn, salute, broadside, fireworks, summoned raiders, raid convoys),
// the treasure stop's sortie (gangway, dig, chest, hoist) and the dust the feet kick up.
// Every effect is placed in WORLD route coordinates at the moment it happened, then converted into the ship frame this
// frame (ctx.toShip) - smoke and wrecks fall behind the walking ship with real parallax, for free.
// Effects go through one SpaceFx pool (3 draws) + the enemy pool; keep-outs: no effect within 12 m of a spot is drawn at
// full size, shells land >= 25 m from the hull, effects dim behind faces (SpaceFx face hold).
import * as THREE from 'three';
import { SPRITE, type SpaceFx } from '../space/fx.ts';
import {
  ENC, ENEMY_LABEL, battlePlan, fireArcClear, fireFrom, hullHealth, legMotion, smooth01, stampLabel, voyageDistance, voyageHash, voyageRand,
  type Beat, type BattlePlan, type EnemyKind, type Intensity, type RoomVoyageConfig, type StampPlay, type VoyageBag, type VoyageNow,
} from '../../../shared/voyage.ts';
import type { EnemyPool, EnemyPose } from './voyageEnemy.ts';
import type { VoyageGroundLike } from './voyageWorld.ts';
import type { ShipRig, TurretRig } from './voyageShip.ts';
import { footAt, type GaitFoot, type GaitParams } from './voyageGait.ts';
import { CREW_EPISODE_ID, type CrewBattleIn, type CrewEpisodeIn } from '../../../shared/shipCrew.ts';
import { safeAmp } from '../../../shared/flashGovernor.ts';

/** A crew episode / hit id the crew lane accepts (shared/shipCrew.ts CREW_EPISODE_ID). */
const crewId = (s: string) => { const v = s.replace(/[^A-Za-z0-9_:.\-]/g, '_').slice(0, 80); return CREW_EPISODE_ID.test(v) ? v : 'ep'; };
/** The crew's gun id for a voyage turret: TURRET_1 / GUN_F = 'F', TURRET_2 / GUN_A = 'A' (crewDeck.ts), else by order. */
const crewGunId = (name: string, i: number) => {
  const m = /(?:TURRET|GUN)_?([0-9]+|[A-Z])/i.exec(name);
  const t = m ? m[1].toUpperCase() : '';
  if (t === 'F' || t === '1') return 'F';
  if (t === 'A' || t === '2') return 'A';
  if (/^[0-9]+$/.test(t) && +t > 2) return String.fromCharCode(64 + +t);
  return i === 0 ? 'F' : i === 1 ? 'A' : String.fromCharCode(65 + i);
};

const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tv3 = new THREE.Vector3();
const sm = smooth01;
const TRACER = 320, ENEMY_TRACER = 250;
const SMOKE_UP = new THREE.Vector3();

export interface ActionCtx {
  now: number; t: number;
  st: VoyageNow; bag: VoyageBag; cfg: RoomVoyageConfig | null;
  S: number; v: number;
  fx: SpaceFx; enemies: EnemyPool; ground: VoyageGroundLike; rig: ShipRig;
  /** world route coords -> ship frame */ toShip(s: number, d: number, h: number, out: THREE.Vector3): THREE.Vector3;
  /** ship frame -> world route coords (s, d, h) */ toWorld(p: THREE.Vector3): { s: number; d: number; h: number };
  /** ship-frame performer spots (keep-outs) */ spots: THREE.Vector3[];
  deckH: number; groundRef: number;
  dangerSide: number;
  /** 0 full .. 2 minimal effects */ level: number;
  /** stamps in play (support, host buttons) */ plays: StampPlay[];
  /** how much of an event this stage mode shows (SPEC 5.6) */ intensity(e: 'battle' | 'storm' | 'treasure' | 'city' | 'support'): Intensity;
  /** fire-arc keep-outs (level ship frame [x, 0, z]), min distance, canopy box */ fireKeep: number[][]; fireArc: number; canopy: number[] | null;
  gait: GaitParams;
  /** chat activity 0..1 (cosmetic) */ chat: number;
  /** a crew engine claimed the sortie (the placeholder crew hides) */ crewClaimed: boolean;
}

export interface Banner { key: string; text: string; sub: string; alpha: number }
export interface CutRequest { key: string; kind: 'battle' | 'defeat' | 'sortie' | 'city' | 'storm'; from: number; to: number; focusShip: THREE.Vector3 }
/** The crew lane's input (SPEC 2.6 crew contract): wall-clock ms, positions in deck (ship) space. */
export interface CrewPlan {
  phase: 'CRUISE' | 'ALERT' | 'COMBAT' | 'VICTORY' | 'TREASURE' | 'DEPART';
  /** the lookout points >= 1.5 s before the first shot */ contacts: { t: number; bearing: number; enemyId: string }[];
  shots: { gun: number; t: number; target: [number, number, number] }[];
  hits: { t: number; pos: [number, number, number]; normal: [number, number, number]; sev: number; site: number; repairAt: number; repairDur: number }[];
  end: { t: number; outcome: 'victory' } | null;
  enemy: THREE.Vector3 | null;
  stop: { phase: string; tau: number; kneel: number; dig: THREE.Vector3; gangway: number; stopDuration: number; stamped: boolean; at: number } | null;
  speed: number; accel: number; health: number;
  /** The crew lane's feed (shared/shipCrew.ts CrewEpisodeIn, src/scene/crew/crewScene.ts CrewFeed): every battle on air
   *  with its WHOLE plan (alert, planned end, the shots that pass the fire-arc rule, the hull hits; synth off) and the
   *  treasure stop window. Pure numbers of the bag + room (the same on every page); cached per battle. */
  episodes: CrewEpisodeIn[];
}
export interface ActionOut {
  alarm: number; health: number;
  /** body kicks (rad): roll + = starboard down, pitch + = bow up */ kickRoll: number; kickPitch: number;
  /** turret aims (ship frame) + weights + recoil per turret */ aims: { target: THREE.Vector3 | null; w: number; recoil: number }[];
  banners: Banner[]; cuts: CutRequest[];
  hornFlash: number; gangway: number;
  /** flats for the ground (dig site, cities) */ flats: { s: number; d: number; r: number; h: number }[];
  crew: CrewPlan;
  /** enemy focus for cameras (ship frame) */ enemy: THREE.Vector3 | null;
  /** The house special (0..1): the room's dumbwaiter / NOW SERVING board flips teal */ special: number;
  counts: { battles: number; enemies: number; overlays: number; skipped: number };
}

interface Battle {
  key: string; kind: EnemyKind; seed: number; side: number;
  A: number; B: number; D: number;
  /** seconds since the approach began (battle clock) */ tau: number;
  Sat: (tau: number) => number;
  /** wall ms of the battle clock's zero (for the crew plan) */ t0ms: number;
  user: string; summoned: boolean;
  plan: BattlePlan;
}

// ------------------------------------------------------------------------------------------------ helpers
const D2R = Math.PI / 180;
/** pack / skiff formation offsets (along, lateral m) */
const FORMATION: [number, number][] = [[0, 0], [-16, 11], [14, -9], [-28, -6], [26, 13], [-6, 22], [8, -20], [-38, 16]];
const UNITS: Record<EnemyKind, number> = { gnashers: 4, crawler: 1, lancer: 1, skiffs: 7 };
/** ship-relative enemy position: along (a, + = ahead) and lateral (d) from a bearing (deg from the bow, - = port) and a
 *  range. Approach from the far quarter; in battle the enemy prowls between the guests' background (bearing ~70 deg) and
 *  the reverse shot (~140 deg aft) at 95-130 m, so every deck camera on the danger side gets its moment. */
const relPath = (b: Battle, tau: number, k: number): { a: number; d: number } => {
  const sd = b.side;
  const off = FORMATION[k % FORMATION.length];
  const brg0 = 105 + 35 * Math.sin(b.seed % 7), r0 = 112;
  let brg: number, r: number;
  if (tau < b.A) {
    const u = smooth01(tau / b.A);
    brg = 150 + (brg0 - 150) * u; r = 620 + (r0 - 620) * u;
  } else {
    const tb = tau - b.A;
    brg = 105 + 35 * Math.sin((2 * Math.PI * tb) / 46 + (b.seed % 7)); r = 112 + 16 * Math.sin((2 * Math.PI * tb) / 27);
  }
  return { a: r * Math.cos(brg * D2R) + off[0], d: sd * (r * Math.sin(brg * D2R) + off[1]) };
};

/** Where turret T's line of fire toward the level ship-frame point (tx, tz) starts: its muzzle (SPEC C13). */
export const turretFire = (T: Pick<TurretRig, 'pivot' | 'reach'>, tx: number, tz: number): number[] => fireFrom(T.pivot.x, T.pivot.z, T.reach ?? 0, tx, tz);

/** A broadside gun's ridge (route coords, R m out on `side`) and which of its rounds may fire: bearings from the beam
 *  swinging fore / aft, the first one the gun can bear on (yaw arc, with slack) whose line from its muzzle clears every
 *  keep-out point (spots, alongside slots) and the canopy + wings + hatch-stage box by `min` m at each round's firing
 *  distance fireS[r] (SPEC D18 / C13; pure geometry in the level ship frame: x = d, z = -(s - S)). null = no clear line:
 *  the gun stays quiet. */
export function broadsideAim(rig: Pick<ShipRig, 'inArc'>, T: TurretRig, side: number, fireS: readonly number[], keep: readonly (readonly number[])[], min: number, canopy: readonly number[] | null, R = 380): { s: number; d: number; rounds: boolean[] } | null {
  for (const deg of [90, 75, 105, 60, 120, 45, 135, 30, 150, 165]) {
    const s = fireS[0] + R * Math.cos(deg * D2R), d = side * R * Math.sin(deg * D2R);
    const rounds = fireS.map((fs) => rig.inArc(T, d, -(s - fs), 0.05) && fireArcClear(turretFire(T, d, -(s - fs)), [d, 0, -(s - fs)], keep, min, canopy));
    if (rounds.some(Boolean)) return { s, d, rounds };
  }
  return null;
}

export class VoyageAction {
  private gaitFoot: GaitFoot = { s: 0, d: 0, lift: 0, stance: true, u: 0, k: 0, plantS: 0, sincePlant: 0 };
  private distCache = new Map<string, { tau: number; dist: number }>();
  private planCache = new Map<string, BattlePlan>();

  /** All battles running (or smoking) at this moment: the chapter's encounters + summoned raiders (stamps). */
  battles(c: ActionCtx): Battle[] {
    const out: Battle[] = [];
    const st = c.st, plan = st.plan;
    const legBase = st.chap.s0;
    const guns = Math.max(1, c.rig.turrets.length), sites = Math.max(1, c.rig.damage.length);
    plan.beats.forEach((b, i) => {
      if (b.kind !== 'encounter') return;
      const tau = st.tLeg - b.t0;
      if (tau < -1 || tau > (b.a ?? ENC.approach) + (b.b ?? ENC.battle) + (b.c ?? ENC.after) + 45) return;
      const bt = this.base(c, b, tau, legBase, guns, sites);
      // a summoned raider that joined this base battle (the queue found no clear window of its own): named in the banner
      const tag = st.leg * 16 + i;
      const joined = [...c.bag.stamps].find((s) => s.k === 'battle' && s.arg === tag);
      if (joined) { bt.summoned = true; bt.user = joined.who ?? ''; }
      out.push(bt);
    });
    for (const p of c.plays) {
      if (p.stamp.k !== 'battle' || p.stamp.arg !== undefined) continue;
      const tau = p.tau;
      if (tau < -1 || tau > ENC.total + 45) continue;
      const key = `s:${p.stamp.id}`;
      let bp = this.planCache.get(key);
      if (!bp) { bp = battlePlan(p.seed, ENC.battle, guns, sites, 3); this.planCache.set(key, bp); }
      const bag = c.bag, cfg = c.cfg, start = p.stamp.at;
      const u = voyageRand(p.seed, 9);
      const kind: EnemyKind = u < 0.4 ? 'gnashers' : u < 0.7 ? 'crawler' : u < 0.95 ? 'lancer' : 'skiffs';
      out.push({ key, kind, seed: p.seed, side: c.dangerSide, A: ENC.approach, B: ENC.battle, D: ENC.after, tau, Sat: (x) => voyageDistance(bag, cfg, start + x * 1000), t0ms: start, user: p.stamp.who ?? '', summoned: true, plan: bp });
    }
    if (this.planCache.size > 24) this.planCache.delete(this.planCache.keys().next().value as string);
    return out;
  }
  private base(c: ActionCtx, b: Beat, tau: number, legBase: number, guns: number, sites: number): Battle {
    const key = `b:${c.st.leg}:${b.t0}`;
    let p = this.planCache.get(key);
    if (!p) { p = battlePlan(b.seed, b.b ?? ENC.battle, guns, sites, 3); this.planCache.set(key, p); }
    const plan = c.st.plan;
    const t0ms = c.now - (c.st.tLeg - b.t0) * 1000;
    return { key, kind: b.enemy ?? 'crawler', seed: b.seed, side: b.side ?? c.dangerSide, A: b.a ?? ENC.approach, B: b.b ?? ENC.battle, D: b.c ?? ENC.after, tau, Sat: (x) => legBase + legMotion(plan, b.t0 + x).s, t0ms, user: '', summoned: false, plan: p };
  }

  /** death moment (battle clock): the killing salvo's impact */
  private death(b: Battle) { return b.A + b.plan.killTau + 0.35; }
  /** One battle as the crew lane's input (cached: the plan is pure; the rig's turrets / hit sites are part of the key). */
  private crewEps = new Map<string, CrewBattleIn>();
  private crewBattle(c: ActionCtx, b: Battle): CrewBattleIn {
    const n = Math.max(1, c.rig.turrets.length), nd = Math.max(1, c.rig.damage.length);
    const key = `${b.key}:${b.t0ms}:${n}:${nd}:${c.fireArc}`;
    const hit = this.crewEps.get(key);
    if (hit) return hit;
    const tD = this.death(b);
    const e0 = this.enemyAt(b, 1.5, 0);
    const shots: CrewBattleIn['shots'] = [];
    for (const sv of b.plan.salvos) {
      const T = c.rig.turrets[sv.gun % n];
      if (!T || b.A + sv.tau > tD) continue;
      const tg = this.enemyAt(b, b.A + sv.tau, 0);
      const fireS = b.Sat(b.A + sv.tau);
      const tLevel = [tg.d, 0, -(tg.s - fireS)];
      if (!c.rig.inArc(T, tLevel[0], tLevel[2]) || !fireArcClear(turretFire(T, tLevel[0], tLevel[2]), tLevel, c.fireKeep, c.fireArc, c.canopy)) continue;
      shots.push({ gun: crewGunId(T.name, sv.gun % n), at: Math.round(b.t0ms + (b.A + sv.tau) * 1000) });
    }
    const hits: CrewBattleIn['hits'] = [];
    for (const x of b.plan.incoming) {
      if (x.kind !== 'hit' || b.A + x.tau > tD) continue;
      const sp = c.rig.damage[x.site % nd] ?? new THREE.Vector3();
      hits.push({ id: crewId(`${b.key}:h${x.site}:${Math.round(x.tau * 10)}`), at: Math.round(b.t0ms + (b.A + x.tau) * 1000), pos: [sp.x, sp.y, sp.z], normal: [Math.sign(sp.x) || 1, 0, 0], severity: (Math.min(3, Math.max(1, Math.round(x.sev))) as 1 | 2 | 3) });
    }
    // bearing: room yaw (0 = +Z) to the enemy at the alert, in the level ship frame (bow -Z turned by the rig's bowYaw)
    const bearing = Math.atan2(e0.d, -(e0.s - b.Sat(1.5))) - (c.rig.bowYaw ?? 0);
    const e: CrewBattleIn = { k: 'battle', id: crewId(b.key), alert: Math.round(b.t0ms + 1500), end: Math.round(b.t0ms + tD * 1000), outcome: 'win', bearing: Math.atan2(Math.sin(bearing), Math.cos(bearing)), shots, hits, synth: false };
    if (this.crewEps.size > 24) this.crewEps.clear();
    this.crewEps.set(key, e);
    return e;
  }

  /** enemy world position (s, d) for unit k at battle clock tau (frozen once dead) */
  private enemyAt(b: Battle, tau: number, k: number) {
    const tD = this.death(b);
    const x = Math.min(tau, tD);
    const r = relPath(b, Math.max(0, x), k);
    return { s: b.Sat(Math.max(0, x)) + r.a, d: r.d };
  }
  /** gait distance (numeric arc length at fixed 0.5 s steps: identical on every page) */
  private enemyDist(b: Battle, tau: number, k: number): number {
    const tD = this.death(b), T = Math.max(0, Math.min(tau, tD));
    const key = `${b.key}:${k}`;
    const hit = this.distCache.get(key);
    let t = 0, dist = 0;
    if (hit && hit.tau <= T && Math.floor(hit.tau / 0.5) === hit.tau / 0.5) { t = hit.tau; dist = hit.dist; }
    let p = this.enemyAt(b, t, k);
    while (t + 0.5 <= T) {
      const q = this.enemyAt(b, t + 0.5, k);
      dist += Math.hypot(q.s - p.s, q.d - p.d);
      p = q; t += 0.5;
    }
    this.distCache.set(key, { tau: t, dist });
    if (this.distCache.size > 32) this.distCache.delete(this.distCache.keys().next().value as string);
    const q = this.enemyAt(b, T, k);
    return dist + Math.hypot(q.s - p.s, q.d - p.d);
  }

  update(c: ActionCtx): ActionOut {
    const out: ActionOut = { alarm: 0, health: 1, kickRoll: 0, kickPitch: 0, aims: c.rig.turrets.map(() => ({ target: null, w: 0, recoil: 0 })), banners: [], cuts: [], hornFlash: 0, gangway: 0, flats: [], enemy: null, special: 0, counts: { battles: 0, enemies: 0, overlays: 0, skipped: 0 },
      crew: { phase: 'CRUISE', contacts: [], shots: [], hits: [], end: null, enemy: null, stop: null, speed: c.v, accel: c.st.a, health: 1, episodes: [] } };
    c.enemies.begin();
    const battles = this.battles(c);
    out.counts.battles = battles.length;
    for (const b of battles) this.battle(c, b, out);
    this.overlays(c, out);
    this.sortie(c, out);
    this.feet(c);
    this.exhaust(c);
    c.enemies.end();
    out.counts.enemies = c.enemies.drawn.length;
    // crew phase
    const enc = c.st.encounter;
    if (out.crew.stop) out.crew.phase = out.crew.stop.phase === 'start' || out.crew.stop.phase === 'rise' ? 'DEPART' : 'TREASURE';
    else if (battles.some((b) => b.tau >= 0 && b.tau < b.A)) out.crew.phase = 'ALERT';
    else if (battles.some((b) => b.tau >= b.A && b.tau < this.death(b))) out.crew.phase = 'COMBAT';
    else if (battles.some((b) => b.tau >= this.death(b) && b.tau < this.death(b) + 8)) out.crew.phase = 'VICTORY';
    void enc;
    out.crew.health = out.health;
    return out;
  }

  // ---------------------------------------------------------------------------------------------- one battle
  private battle(c: ActionCtx, b: Battle, out: ActionOut) {
    const fx = c.fx, tau = b.tau, tD = this.death(b);
    const tb = tau - b.A;                       // battle-relative
    const units = UNITS[b.kind] ?? 1;
    const show = c.intensity('battle') !== 'off' && c.bag.events.battles;
    if (tau >= 0 && tau < tD + 0.5) out.alarm = Math.max(out.alarm, sm(tau / 2) * (1 - sm((tau - tD) / 0.5)));
    // banner for a summoned raider
    if (!show) return;
    if (b.summoned && tau >= 0 && tau < 8) out.banners.push({ key: b.key, text: `${ENEMY_LABEL[b.kind].toUpperCase()} INBOUND!`, sub: b.user ? `summoned by ${b.user}` : 'raiders on the quarter', alpha: sm(tau / 0.6) * (1 - sm((tau - 7) / 1)) });
    { const e0 = this.enemyAt(b, 1.5, 0); out.crew.contacts.push({ t: b.t0ms + 1500, bearing: Math.atan2(e0.d, e0.s - b.Sat(1.5)), enemyId: `${b.key}:0` }); }
    out.crew.episodes.push(this.crewBattle(c, b));
    // the enemies
    let focus: THREE.Vector3 | null = null;
    for (let k = 0; k < units; k++) {
      const e = this.enemyAt(b, tau, k);
      const e0 = this.enemyAt(b, Math.max(0, Math.min(tau, tD - 0.01) - 0.6), k);
      const e1 = this.enemyAt(b, Math.max(0.6, Math.min(tau, tD - 0.01)), k);
      const yaw = Math.atan2(e1.d - e0.d, e1.s - e0.s);
      const down = sm((tau - tD) / 2.6);
      const fade = sm(tau / 3) * (1 - sm((tau - (b.A + b.B + b.D + 35)) / 8));
      const pose: EnemyPose = { key: `${b.key}:${k}`, kind: b.kind, s: e.s, d: e.d, yaw: Number.isFinite(yaw) ? yaw : 0, dist: this.enemyDist(b, tau, k), walk: 1, down, fade };
      const dr = c.enemies.draw(pose, c.S, (s, d) => c.ground.heightAt(s, d));
      if (!dr) continue;
      // eyes (danger red-orange glow); off when dead
      if (down < 0.5) for (const ey of dr.eyes) { const p = this.localToShip(c, ey, tv); fx.sprite(p, b.kind === 'gnashers' ? 0.5 : 1.0, 1.0, 0.3, 0.12, 0.9 * fade, SPRITE.glow, 0); }
      if (k === 0) { focus = this.localToShip(c, dr.body, new THREE.Vector3()); }
    }
    if (focus && tau < tD) { out.enemy ??= focus; out.crew.enemy ??= focus; }
    // turret aims (alive enemy)
    const aimW = sm((tau - (b.A - 6)) / 2.5) * (1 - sm((tau - tD - 1.5) / 2));
    if (focus && aimW > 0) c.rig.turrets.forEach((_, i) => { const a = out.aims[i]; if (aimW >= a.w) { a.target = focus!.clone(); a.w = aimW; } });
    // ---- the ship's salvos
    for (const sv of b.plan.salvos) {
      const age = tb - sv.tau;
      if (age < -30 || age > 9) continue;
      const T = c.rig.turrets[sv.gun % Math.max(1, c.rig.turrets.length)];
      if (!T) continue;
      // fire-arc rule (SPEC D18), decided on pure numbers (the target's bearing in the level ship frame): no shot whose
      // line passes within 6 m of a spot or through the canopy - the other gun's next shot carries on
      const tg = this.enemyAt(b, b.A + sv.tau, 0);
      const fireS = b.Sat(b.A + sv.tau);
      const tLevel = [tg.d, 0, -(tg.s - fireS)];
      if (!c.rig.inArc(T, tLevel[0], tLevel[2]) || !fireArcClear(turretFire(T, tLevel[0], tLevel[2]), tLevel, c.fireKeep, c.fireArc, c.canopy)) { if (age >= 0 && age < 0.1) out.counts.skipped++; continue; }
      out.crew.shots.push({ gun: sv.gun, t: b.t0ms + (b.A + sv.tau) * 1000, target: [tLevel[0], c.ground.heightAt(tg.s, tg.d) - c.groundRef - c.deckH + 6, tLevel[2]] });
      if (age < -0.01 || !focus) continue;
      out.aims[sv.gun % out.aims.length].recoil = Math.max(out.aims[sv.gun % out.aims.length].recoil, Math.exp(-age / 0.12));
      if (age < 0.35) out.kickRoll += 0.0012 * b.side * Math.exp(-age / 0.12);
      const mz = tv2, dir = tv3;
      c.rig.muzzle(T, mz, dir);
      const keep = this.keep(c, mz);
      // muzzle flash (0.08 s) + a dust ring under the barrel
      if (age < 0.14) {
        const k = 1 - age / 0.14;
        fx.sprite(mz, 3.2 * keep, 1.4, 1.1, 0.75, k, SPRITE.flare, sv.seed % 97 / 97);
        fx.sprite(tv.copy(mz).addScaledVector(dir, 1.5), 2.2 * keep, 1.6, 1.25, 0.8, k, SPRITE.core, 0);
      }
      // smoke: born at the muzzle's world position at the moment of firing, drifting with the wind (the ship walks on)
      const mw = c.toWorld(mz);
      const along = mw.s - c.S;
      const n = c.level >= 2 ? 3 : 7;
      for (let i = 0; i < n; i++) {
        const a2 = age - i * 0.06;
        if (a2 <= 0 || a2 > 7) continue;
        const r = voyageRand(sv.seed, 30, i);
        const sp = c.toShip(fireS + along + dir.z * -6 * (i / n) + 0.6 * a2, mw.d + dir.x * 6 * (i / n) + 1.4 * a2 * (r - 0.3), mw.h + 0.7 * a2, tv);
        this.puff(c, sp, (1.2 + 1.6 * a2) * keep, 0.72, 0.68, 0.62, 0.55 * (1 - a2 / 7), r);
      }
      // tracer + impact
      const tgt = this.enemyAt(b, b.A + sv.tau, 0);
      const tH = c.ground.heightAt(tgt.s, tgt.d) + (sv.hit ? 6 : 0);
      const miss = sv.hit ? { s: 0, d: 0 } : { s: (voyageRand(sv.seed, 1) - 0.5) * 40, d: b.side * (8 + 18 * voyageRand(sv.seed, 2)) };
      const fromS = fireS + along, toS = tgt.s + miss.s, toD = tgt.d + miss.d;
      const dist = Math.hypot(toS - fromS, toD - mw.d, tH - mw.h);
      const flight = dist / TRACER;
      if (age < flight) {
        const u = age / flight, u0 = Math.max(0, (age - 0.08) / flight);
        const H = c.toShip(fromS + (toS - fromS) * u, mw.d + (toD - mw.d) * u, mw.h + (tH - mw.h) * u + 30 * u * (1 - u), tv);
        const Tl = c.toShip(fromS + (toS - fromS) * u0, mw.d + (toD - mw.d) * u0, mw.h + (tH - mw.h) * u0 + 30 * u0 * (1 - u0), new THREE.Vector3());
        fx.line(Tl, H, 0.35, 2.2, 1.6, 1.1, 0.6, 1, false);
      } else this.impact(c, toS, toD, c.ground.heightAt(toS, toD), age - flight, sv.seed, sv.hit ? 'hit' : 'geyser', 1);
    }
    // ---- return fire
    let health = 1;
    for (const x of b.plan.incoming) {
      const age = tb - x.tau;
      if (x.kind === 'hit' && age > -30) { const sp = c.rig.damage[x.site % Math.max(1, c.rig.damage.length)] ?? new THREE.Vector3(); const nx = Math.sign(sp.x) || 1; out.crew.hits.push({ t: b.t0ms + (b.A + x.tau) * 1000, pos: [sp.x, sp.y, sp.z], normal: [nx, 0, 0], sev: x.sev, site: x.site, repairAt: b.t0ms + (b.A + x.repairAt) * 1000, repairDur: x.repairDur }); }
      if (age < -0.2 || age > 40) continue;
      if (b.A + x.tau > tD) continue;                                  // the dead don't shoot
      const src = this.enemyAt(b, b.A + x.tau, 0);
      const gunH = c.ground.heightAt(src.s, src.d) + 8;
      if (age >= 0 && age < 0.12) fx.sprite(c.toShip(src.s, src.d, gunH, tv), 2.4, 1.6, 0.5, 0.15, 1 - age / 0.12, SPRITE.flare, 0.3);
      // target: a hull site (hit) or the sand >= 25 m from the hull (miss), both on the enemy's side
      const atS = b.Sat(b.A + x.tau);
      let toS: number, toD: number, toH: number;
      const site = c.rig.damage[x.site % Math.max(1, c.rig.damage.length)];
      if (x.kind === 'hit' && site) { const w = c.toWorld(site); toS = atS + (w.s - c.S); toD = w.d; toH = w.h; }
      else { toS = atS - 20 + 40 * voyageRand(x.seed, 1); toD = b.side * (26 + 24 * voyageRand(x.seed, 2)); toH = c.ground.heightAt(toS, toD); }
      const dist = Math.hypot(toS - src.s, toD - src.d, toH - gunH);
      const flight = dist / ENEMY_TRACER;
      if (age >= 0 && age < flight) {
        const u = age / flight, u0 = Math.max(0, (age - 0.1) / flight);
        const H = c.toShip(src.s + (toS - src.s) * u, src.d + (toD - src.d) * u, gunH + (toH - gunH) * u + 18 * u * (1 - u), tv);
        const Tl = c.toShip(src.s + (toS - src.s) * u0, src.d + (toD - src.d) * u0, gunH + (toH - gunH) * u0 + 18 * u0 * (1 - u0), new THREE.Vector3());
        fx.line(Tl, H, 0.4, 2.2, 1.8, 0.45, 0.12, 1, false);           // red-orange: danger
      } else if (age >= flight) {
        const ai = age - flight;
        if (x.kind === 'hit' && site) {
          this.hullHit(c, site, ai, x.seed, 0.08 + x.sev / 10, Math.max(0, Math.min(1, (age - (x.repairAt - x.tau)) / x.repairDur)));
          if (ai < 1.2 && c.intensity('battle') === 'full') { out.kickRoll += 0.006 * b.side * Math.exp(-ai / 0.25) * Math.sin(2 * Math.PI * 1.8 * ai); out.kickPitch += 0.0025 * Math.sign(-site.z) * Math.exp(-ai / 0.25) * Math.sin(2 * Math.PI * 1.8 * ai + 0.6); }
        } else if (ai < 4) this.impact(c, toS, toD, toH, ai, x.seed, 'geyser', 1.2);
      }
    }
    health = hullHealth(b.plan, tb);
    out.health = Math.min(out.health, health);
    // ---- defeat: sparks, the big explosion, the smoke column (stays in the world: falls behind the ship)
    const td = tau - tD;
    if (td >= 0 && td < 60) {
      const e = this.enemyAt(b, tD, 0);
      const g = c.ground.heightAt(e.s, e.d);
      const D = b.kind === 'lancer' ? 14 : b.kind === 'gnashers' ? 3 : b.kind === 'skiffs' ? 2 : 6;
      if (td < 0.1) out.crew.end = { t: b.t0ms + tD * 1000, outcome: 'victory' };
      if (td < 3) for (let i = 0; i < 6; i++) { const r = voyageRand(b.seed, 40, i + Math.floor(td * 8)); fx.sprite(c.toShip(e.s + (r - 0.5) * 8, e.d + (voyageRand(b.seed, 41, i) - 0.5) * 8, g + D + r * 4, tv), 0.8, 1.6, 1.2, 0.6, 0.8 * (1 - td / 3), SPRITE.spark, r); }
      const ex = td - 3;
      if (ex >= 0 && ex < 3.5) {
        const k = 1 - ex / 3.5;
        const P = c.toShip(e.s, e.d, g + D * 0.6 + ex * 3, tv);
        fx.sprite(P, 10 + 22 * Math.sqrt(ex / 3.5), 1.6, 0.9, 0.45, k, SPRITE.fire, b.seed % 13 / 13);
        if (ex < 0.4) fx.sprite(P, 30 * (ex / 0.4) + 6, 1.4, 1.2, 0.9, 1 - ex / 0.4, SPRITE.flare, 0.1);
        if (ex < 1.2) fx.sprite(c.toShip(e.s, e.d, g + 1.5, tv2), 12 + 50 * ex, 1.2, 0.95, 0.7, 0.8 * (1 - ex / 1.2), SPRITE.ring, 0);
        if (c.level < 2) for (let i = 0; i < 18; i++) {
          const r = voyageRand(b.seed, 50, i), a = r * Math.PI * 2, up = 18 + 22 * voyageRand(b.seed, 51, i);
          const dd = 14 + 20 * voyageRand(b.seed, 52, i);
          fx.sprite(c.toShip(e.s + Math.cos(a) * dd * ex, e.d + Math.sin(a) * dd * ex, g + D + up * ex - 4.9 * ex * ex, tv), 0.9, 1.5, 1.0, 0.5, k, SPRITE.spark, r);
        }
      }
      if (ex >= 0) {
        // the column: puffs born every 0.4 s at the wreck, rising + drifting downwind for 14 s each
        const n = c.level >= 2 ? 10 : 22;
        for (let i = 0; i < n; i++) {
          const born = Math.floor(ex / 0.4) * 0.4 - i * 0.4;
          if (born < 0) break;
          const a2 = ex - born;
          if (a2 > 14) continue;
          const r = voyageRand(b.seed, 60, Math.round(born * 10));
          const fade = (1 - a2 / 14) * (1 - sm((ex - 45) / 10));
          this.puff(c, c.toShip(e.s - 1.2 * a2, e.d + 2.4 * a2 * (r + 0.3), g + D * 0.5 + 4.2 * a2, tv), 3 + 2.1 * a2, 0.16, 0.14, 0.13, 0.75 * fade, r);
        }
      }
    }
    // cutaways (Talk only - the scene decides): battle start, the explosion
    const t0 = b.t0ms;
    if ((focus || td >= 0) && c.intensity('battle') === 'full') {
      const fShip = focus ?? c.toShip(this.enemyAt(b, tD, 0).s, this.enemyAt(b, tD, 0).d, c.ground.heightAt(this.enemyAt(b, tD, 0).s, this.enemyAt(b, tD, 0).d) + 4, new THREE.Vector3());
      out.cuts.push({ key: `${b.key}:open`, kind: 'battle', from: t0 + (b.A + 0.5) * 1000, to: t0 + (b.A + 5.5) * 1000, focusShip: fShip.clone() });
      out.cuts.push({ key: `${b.key}:boom`, kind: 'defeat', from: t0 + (tD + 1.6) * 1000, to: t0 + (tD + 7.6) * 1000, focusShip: fShip.clone() });
    }
  }

  /** a ground / enemy impact: fireball (hit) or a sand geyser */
  private impact(c: ActionCtx, s: number, d: number, h: number, age: number, seed: number, kind: 'hit' | 'geyser', scale: number) {
    const fx = c.fx;
    if (age > 5) return;
    if (kind === 'hit') {
      const P = c.toShip(s, d, h + 5, tv);
      if (age < 1.4) fx.sprite(P, (4 + 7 * Math.sqrt(age / 1.4)) * scale, 1.5, 0.85, 0.4, 1 - age / 1.4, SPRITE.fire, seed % 17 / 17);
      if (age < 0.25) fx.sprite(P, 9 * scale, 1.5, 1.3, 1.0, 1 - age / 0.25, SPRITE.flare, 0);
      for (let i = 0; i < 4; i++) { const a2 = age - i * 0.2; if (a2 > 0 && a2 < 4) this.puff(c, c.toShip(s - a2, d + a2 * 0.6, h + 5 + a2 * 2.2, tv), (2 + 1.5 * a2) * scale, 0.2, 0.18, 0.16, 0.6 * (1 - a2 / 4), voyageRand(seed, i)); }
      return;
    }
    // geyser: a column of sand thrown up 8-25 m, then a falling curtain + ground dust
    const H = (8 + 17 * voyageRand(seed, 3)) * scale;
    const n = c.level >= 2 ? 4 : 9;
    for (let i = 0; i < n; i++) {
      const r = voyageRand(seed, 70, i);
      const t = age - i * 0.03;
      if (t < 0) continue;
      const up = Math.min(H, H * (1 - Math.exp(-t * 3.2))) - 2.2 * Math.max(0, t - 1.0) ** 2;
      const spread = 1.5 + 4 * t;
      const P = c.toShip(s + (r - 0.5) * spread, d + (voyageRand(seed, 71, i) - 0.5) * spread, h + Math.max(0.5, up * (0.4 + 0.6 * (i / n))), tv);
      this.puff(c, P, (1.6 + 1.4 * t + 0.6 * (i % 3)) * scale, 0.78, 0.6, 0.4, 0.8 * (1 - t / 4.5), r);
    }
    if (age < 0.12) fx.sprite(c.toShip(s, d, h + 1, tv), 3 * scale, 1.4, 1.0, 0.6, 1 - age / 0.12, SPRITE.flare, 0);
  }

  /** a hit on the hull: fireball + sparks, then a fire / smoke emitter until the crew's repair is done */
  private hullHit(c: ActionCtx, site: THREE.Vector3, age: number, seed: number, sev: number, repaired: number) {
    const fx = c.fx;
    const keep = this.keep(c, site);
    if (age < 1) fx.sprite(site, 3.5 * keep, 1.6, 0.9, 0.45, 1 - age, SPRITE.fire, seed % 7 / 7);
    if (age < 0.2) fx.sprite(site, 6 * keep, 1.5, 1.3, 1.0, 1 - age / 0.2, SPRITE.flare, 0);
    if (age < 1.5) for (let i = 0; i < 10; i++) {
      const r = voyageRand(seed, 80, i), a = r * Math.PI * 2;
      const p = tv.copy(site).add(tv2.set(Math.cos(a) * 6 * age * keep, (3 + 4 * voyageRand(seed, 81, i)) * age - 4.9 * age * age, Math.sin(a) * 6 * age * keep));
      fx.sprite(p, 0.35, 1.6, 1.2, 0.6, 1 - age / 1.5, SPRITE.spark, r);
    }
    // fire + smoke until repaired (the crew lane's welder walks there: crew plan `hits`)
    const burn = (1 - repaired) * sm(age / 0.6);
    if (burn > 0.01) {
      const n = c.level >= 2 ? 3 : 6;
      for (let i = 0; i < n; i++) {
        const born = Math.floor(age / 0.5) * 0.5 - i * 0.5;
        if (born < 0) break;
        const a2 = age - born;
        if (a2 > 3) continue;
        const r = voyageRand(seed, 90, Math.round(born * 10));
        // smoke streams aft (the ship walks into its own smoke)
        this.puff(c, tv.copy(site).add(tv2.set((r - 0.5) * 0.8, 1.2 * a2, 2.8 * a2)), (0.8 + 1.2 * a2) * keep, 0.15, 0.14, 0.13, 0.6 * burn * (1 - a2 / 3), r);
      }
      fx.sprite(tv.copy(site).add(tv2.set(0, 0.4, 0)), (1.0 + 0.6 * sev * 5) * keep, 1.5, 0.75, 0.3, 0.8 * burn * (0.85 + safeAmp(0.15) * Math.sin(c.t * 23 + seed)), SPRITE.fire, (c.t * 0.7) % 1);
    }
  }

  /** effect scale near the performers: full beyond 12 m of every spot, smaller inside */
  /** Every smoke puff goes through here: faded + shrunk near the performers (no smoke rolling over the show deck or a
   *  deck camera - muzzle smoke stays in the world while the ship walks through it). */
  private puff(c: ActionCtx, p: THREE.Vector3, size: number, r: number, g: number, b: number, a: number, seed = 0) {
    let d = Infinity;
    for (const s of c.spots) { const q = s.distanceTo(p); if (q < d) d = q; }
    const k = sm((d - 0.5 * size - 3) / 6);
    if (k < 0.02) return;
    c.fx.puff(p, size * (0.6 + 0.4 * k), r, g, b, a * k, seed);
  }
  private keep(c: ActionCtx, p: THREE.Vector3) {
    let d = Infinity;
    for (const s of c.spots) d = Math.min(d, s.distanceTo(p));
    return d >= 12 ? 1 : Math.max(0.35, d / 12);
  }
  private localToShip(c: ActionCtx, local: THREE.Vector3, out: THREE.Vector3) {
    // enemy pool positions are world-group local (x = d, y = h, z = -(s - S))
    return c.toShip(c.S - local.z, local.x, local.y, out);
  }

  // ---------------------------------------------------------------------------------------------- support overlays
  private overlays(c: ActionCtx, out: ActionOut) {
    const fx = c.fx;
    const supportOn = c.intensity('support') !== 'off';
    for (const pl of c.plays) {
      const it = { id: `st:${pl.stamp.id}`, kind: pl.stamp.k, seed: pl.seed, user: pl.stamp.who ?? '', start: pl.stamp.at };
      const age = pl.tau, dur = pl.dur;
      if (age < 0 || age > dur + 30) continue;
      if (!supportOn && it.kind !== 'battle' && it.kind !== 'treasure' && it.kind !== 'storm' && it.kind !== 'city') continue;
      out.counts.overlays++;
      const who = it.user ? it.user : 'a friend of the ship';
      if (it.kind === 'newVoyage' && age < dur) {
        out.banners.push({ key: it.id, text: 'A NEW VOYAGE', sub: 'all aboard!', alpha: sm(age / 0.5) * (1 - sm((age - dur + 1) / 1)) });
      } else if (it.kind === 'special' && age < dur) {
        // The house special: the room's dumbwaiter raises a sandwich to the host, the NOW SERVING board flips teal (room lane
        // reads out.special); here: the banner + a teal sparkle over the counter
        out.special = Math.max(out.special, sm(age / 0.4) * (1 - sm((age - dur + 1.5) / 1.5)));
        out.banners.push({ key: it.id, text: stampLabel('special', c.cfg).toUpperCase(), sub: `for ${who}`, alpha: sm(age / 0.5) * (1 - sm((age - dur + 1) / 1)) });
      } else if (it.kind === 'whistle' && age < dur) {
        out.hornFlash = Math.max(out.hornFlash, sm(age / 0.15) * (1 - sm((age - 2.5) / 1.5)));
        const horn = tv3.set(0.8, 3.6, -9.6);
        for (let i = 0; i < 8; i++) { const a2 = age - i * 0.18; if (a2 > 0 && a2 < 3) this.puff(c, tv.copy(horn).add(tv2.set(0.3 * a2, 2.2 * a2, 1.6 * a2)), 0.4 + 0.9 * a2, 0.92, 0.92, 0.9, 0.7 * (1 - a2 / 3) * (age < 2.6 ? 1 : 0.6), voyageRand(it.seed, i)); }
      } else if (it.kind === 'salute' && age < dur + 6) {
        if (age < dur) out.banners.push({ key: it.id, text: 'A SALUTE FOR', sub: who, alpha: sm(age / 0.5) * (1 - sm((age - dur + 1) / 1)) });
        // the gun whose skyward line clears the deck (SPEC D18 / C13), the seeded one first
        const nT = Math.max(1, c.rig.turrets.length);
        let gi = it.seed % nT;
        const aimOf = (T: { dir0: THREE.Vector3 }) => new THREE.Vector3(T.dir0.z < 0 ? 90 : -90, 140, T.dir0.z < 0 ? -160 : 160);
        const okGun = (i: number) => { const T = c.rig.turrets[i]; if (!T) return false; const a = aimOf(T); return c.rig.inArc(T, a.x, a.z) && fireArcClear(turretFire(T, a.x, a.z), [a.x, 0, a.z], c.fireKeep, c.fireArc, c.canopy); };
        if (!okGun(gi)) { gi = -1; for (let i = 0; i < nT; i++) if (okGun((it.seed + i) % nT)) { gi = (it.seed + i) % nT; break; } }
        const T = gi >= 0 ? c.rig.turrets[gi] : undefined;
        if (T) {
          const tgt = aimOf(T);
          const w = sm((age - 0.2) / 0.8) * (1 - sm((age - 4.5) / 1.2));
          if (w > out.aims[gi].w) { out.aims[gi].target = tgt; out.aims[gi].w = w; }
          const fa = age - 1.6;
          if (fa >= 0 && fa < 6) {
            out.aims[gi].recoil = Math.max(out.aims[gi].recoil, Math.exp(-fa / 0.12));
            c.rig.muzzle(T, tv2, tv3);
            if (fa < 0.14) fx.sprite(tv2, 3 * this.keep(c, tv2), 1.4, 1.1, 0.75, 1 - fa / 0.14, SPRITE.flare, 0.2);
            for (let i = 0; i < 6; i++) { const a2 = fa - i * 0.05; if (a2 > 0 && a2 < 5) this.puff(c, tv.copy(tv2).addScaledVector(tv3, 2 + 3 * a2).add(SMOKE_UP.set(0, 0.6 * a2, 2.5 * a2)), 1 + 1.2 * a2, 0.8, 0.78, 0.74, 0.5 * (1 - a2 / 5), voyageRand(it.seed, 20 + i)); }
            // a golden star-burst at the top of the shot
            const pop = fa - 1.4;
            if (pop >= 0 && pop < 2.5) for (let i = 0; i < 24; i++) {
              const a = (i / 24) * Math.PI * 2, r = 9 * Math.sqrt(pop);
              fx.sprite(tv.copy(tgt).multiplyScalar(0.45).add(tv2.set(Math.cos(a) * r, Math.sin(a) * r - 2 * pop * pop, 0)), 0.7, 1.6, 1.25, 0.6, 1 - pop / 2.5, SPRITE.spark, i / 24);
            }
          }
        }
      } else if (it.kind === 'broadside' && age < dur + 8) {
        if (age < dur) out.banners.push({ key: it.id, text: 'BROADSIDE!', sub: who, alpha: sm(age / 0.5) * (1 - sm((age - dur + 1) / 1)) });
        // each gun's own ridge 380 m out on the stamp's side, swung from the beam fore / aft until the gun can bear on it
        // and every round's line of fire stays clear of the deck (SPEC D18 / C13; pure geometry, decided once per stamp)
        const bp = this.broadsidePlan(c, it.id, it.seed, it.start);
        c.rig.turrets.forEach((T, gi) => {
          const g = bp[gi];
          if (!g) return;                                                   // no clear line: this gun stays quiet
          const ridgeS = g.s, ridgeD = g.d;
          const tgt = c.toShip(ridgeS, ridgeD, c.ground.heightAt(ridgeS, ridgeD) + 6, new THREE.Vector3());
          const w = sm((age - 0.2) / 0.8) * (1 - sm((age - dur + 0.5) / 1));
          if (w > out.aims[gi].w) { out.aims[gi].target = tgt.clone(); out.aims[gi].w = w; }
          for (let r = 0; r < 3; r++) {
            const fa = age - (1.2 + r * 2.4 + gi * 0.25);
            if (fa < 0 || fa > 9 || !g.rounds[r]) continue;
            out.aims[gi].recoil = Math.max(out.aims[gi].recoil, Math.exp(-fa / 0.12));
            c.rig.muzzle(T, tv2, tv3);
            if (fa < 0.14) fx.sprite(tv2, 3.2 * this.keep(c, tv2), 1.4, 1.1, 0.75, 1 - fa / 0.14, SPRITE.flare, 0.4);
            if (fa < 0.3) out.kickRoll += 0.0015 * Math.sign(-ridgeD) * Math.exp(-fa / 0.12);
            const flight = 380 / TRACER;
            if (fa < flight) {
              const mw = c.toWorld(tv2);
              const u = fa / flight;
              fx.line(c.toShip(mw.s + (ridgeS - mw.s) * Math.max(0, u - 0.08), mw.d + (ridgeD - mw.d) * Math.max(0, u - 0.08), mw.h, new THREE.Vector3()), c.toShip(mw.s + (ridgeS - mw.s) * u, mw.d + (ridgeD - mw.d) * u, mw.h + 25 * u * (1 - u), tv), 0.35, 2.2, 1.6, 1.1, 0.6, 1, false);
            } else this.impact(c, ridgeS + r * 7 - 7, ridgeD + gi * 9, c.ground.heightAt(ridgeS, ridgeD), fa - flight, it.seed + r * 7 + gi, voyageRand(it.seed, r, gi) < 0.5 ? 'hit' : 'geyser', 1.4);
          }
        });
      } else if (it.kind === 'fireworks' && age < dur + 4) {
        if (age < 6) out.banners.push({ key: it.id, text: c.st.night > 0.5 ? 'FIREWORKS' : 'SIGNAL FLARES', sub: who, alpha: sm(age / 0.5) * (1 - sm((age - 5) / 1)) });
        const night = c.st.night > 0.5;
        const pal: [number, number, number][] = [[1.6, 1.25, 0.55], [1.5, 1.5, 1.5], [0.55, 0.75, 1.6], [1.6, 1.0, 0.35]];
        for (let k = 0; k < 14; k++) {
          const launch = 0.6 + k * 0.85;
          const a = age - launch;
          if (a < 0 || a > 6) continue;
          const r = voyageRand(it.seed, 100, k);
          const apex = 2.2 + 0.6 * r;
          // launched off the bow, bursting low over the dunes either side of the wheelhouse (the deck cameras' sky window
          // between the awning and the horizon), 100-190 m out
          const sideK = k % 2 ? 1 : -1;
          const base = tv3.set(sideK * 2.5, 0.5, -18 - 2 * r);
          const top = new THREE.Vector3(sideK * (45 + 65 * voyageRand(it.seed, 102, k)), 14 + 18 * r, -(100 + 90 * voyageRand(it.seed, 103, k)));
          const col = pal[k % pal.length];
          if (a < apex) {
            const u = a / apex;
            const P = tv.copy(base).lerp(top, 1 - (1 - u) ** 2);
            fx.sprite(P, 0.6, 1.6, 1.3, 0.8, 1, SPRITE.core, 0);
            this.puff(c, tv2.copy(base).lerp(top, Math.max(0, 1 - (1 - u + 0.08) ** 2)), 0.7, 0.8, 0.78, 0.75, 0.35 * (1 - u), r);
          } else if (night) {
            const b = a - apex;
            if (b < 0.15) fx.sprite(top, 14, col[0], col[1], col[2], 1 - b / 0.15, SPRITE.flare, r);
            for (let i = 0; i < (c.level >= 2 ? 16 : 32); i++) {
              const ang = (i / 32) * Math.PI * 2, el = voyageRand(it.seed, 110 + k, i) * Math.PI - Math.PI / 2;
              const R = 16 * (1 - Math.exp(-b * 2.2));
              const P = tv.copy(top).add(tv2.set(Math.cos(ang) * Math.cos(el) * R, Math.sin(el) * R - 3 * b * b, Math.sin(ang) * Math.cos(el) * R));
              fx.sprite(P, 0.9, col[0], col[1], col[2], Math.max(0, 1 - b / 2.8), SPRITE.spark, i / 32);
            }
          } else {
            // daylight: a magnesium flare drifting down on a smoke trail
            const b = a - apex;
            const P = tv.copy(top).add(tv2.set(2 * b, -3.5 * b, 0));
            fx.sprite(P, 2.4, 1.6, 1.5, 1.2, Math.max(0, 1 - b / 3.6), SPRITE.flare, r);
            for (let i = 0; i < 5; i++) { const bb = b - i * 0.35; if (bb > 0) this.puff(c, tv.copy(top).add(tv2.set(2 * bb, -3.5 * bb + 0.5 * i, 0)), 1 + 0.5 * i, 0.9, 0.88, 0.85, 0.4 * (1 - b / 3.8), r + i); }
          }
        }
      } else if (it.kind === 'convoy' && age < dur + 15) {
        if (age < 8) out.banners.push({ key: it.id, text: 'RAID CONVOY', sub: it.user ? `${it.user} and crew sail alongside` : 'allies alongside', alpha: sm(age / 0.6) * (1 - sm((age - 7) / 1)) });
        const side = -c.dangerSide;
        for (let k = 0; k < 3; k++) {
          const rel = age < 15 ? -160 + 160 * sm(age / 15) : age > dur ? 260 * sm((age - dur) / 15) : 0;
          const s = c.S + rel + [-25, 8, 38][k], d = side * [34, 50, 66][k];
          const g = c.ground.heightAt(s, d);
          // allied skiffs: the skiff walker (enemy pool mesh) running alongside, a teal pennant light instead of red eyes
          const fade = sm(age / 2) * (1 - sm((age - dur - 12) / 3));
          const dr = c.enemies.draw({ key: `${it.id}:ally:${k}`, kind: 'skiffs', s, d, yaw: 0, dist: s, walk: 1, down: 0, fade }, c.S, (ss, dd) => c.ground.heightAt(ss, dd));
          if (dr) fx.sprite(this.localToShip(c, tv.copy(dr.body).add(tv2.set(0, 4.3, 0.6)), tv3), 0.7, 0.2, 0.95, 0.85, 0.85 * fade, SPRITE.glow, k / 3);
          for (let i = 0; i < 4; i++) this.puff(c, c.toShip(s - 4 - i * 3, d, g + 0.5, tv), 1.0 + i * 0.5, 0.8, 0.65, 0.45, 0.35 * (1 - i / 4) * fade, voyageRand(it.seed, k, i));
        }
      }
    }
  }

  /** A broadside's targets per gun (route coords) and which of its 3 rounds may fire: bearings from the beam swinging fore
   *  and aft, the first one the gun can bear on (yaw arc) whose line clears the deck at every round's firing distance. */
  private bsCache = new Map<string, ({ s: number; d: number; rounds: boolean[] } | null)[]>();
  private broadsidePlan(c: ActionCtx, id: string, seed: number, start: number) {
    // (keyed by the rig too: rig.json's turret limits arrive a moment after attach)
    const key = `${id}|${c.rig.turrets.map((T) => `${T.arc.toFixed(4)},${T.pivot.x.toFixed(2)},${T.pivot.z.toFixed(2)}`).join(';')}|${c.fireKeep.length}`;
    const hit = this.bsCache.get(key);
    if (hit) return hit;
    const side = seed % 2 ? 1 : -1;
    const out = c.rig.turrets.map((T, gi) => broadsideAim(c.rig, T, side, [0, 1, 2].map((r) => voyageDistance(c.bag, c.cfg, start + (1.2 + r * 2.4 + gi * 0.25) * 1000)), c.fireKeep, c.fireArc, c.canopy));
    this.bsCache.set(key, out);
    if (this.bsCache.size > 16) this.bsCache.delete(this.bsCache.keys().next().value as string);
    return out;
  }

  // ---------------------------------------------------------------------------------------------- treasure sortie
  private placeholderCrew: THREE.InstancedMesh | null = null;
  private chest: THREE.Mesh | null = null;
  readonly group = new THREE.Group();
  private ensureProps() {
    if (this.chest) return;
    const body = new THREE.CapsuleGeometry(0.32, 0.6, 3, 8).translate(0, 0.62, 0);
    this.placeholderCrew = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ color: '#3d64c9', roughness: 0.8 }), 4);
    this.placeholderCrew.count = 0; this.placeholderCrew.frustumCulled = false; this.placeholderCrew.name = 'vtp:voyage:sortieCrew';
    const chest = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.8, 0.8).translate(0, 0.4, 0), new THREE.MeshStandardMaterial({ color: '#7a4e28', roughness: 0.6, metalness: 0.3, emissive: new THREE.Color('#35d6c3'), emissiveIntensity: 0.25 }));
    chest.name = 'vtp:voyage:chest'; chest.visible = false;
    this.chest = chest;
    this.group.add(this.placeholderCrew, chest);
  }
  private sortie(c: ActionCtx, out: ActionOut) {
    const st = c.st, stp0 = st.stop;
    this.ensureProps();
    const crew = this.placeholderCrew!, chest = this.chest!;
    crew.count = 0; chest.visible = false;
    if (!stp0) return;
    const show = c.intensity('treasure') !== 'off' && c.bag.events.treasure;
    // the dig site: 4 m aft of where the ship stood, `off` m out on the stop's side (the scene flattens it - digFlat)
    const stopS = voyageDistance(c.bag, c.cfg, stp0.at + 9000);
    const digS = stopS - 4, digD = stp0.side * stp0.off;
    const tb = stp0.tau, br = 8, stp = stp0.stop;
    const gang = sm((tb - br - 2) / 4) * (1 - sm((tb - (br + stp - 7)) / 4));
    out.gangway = gang;
    const digShip = c.toShip(digS, digD, c.ground.heightAt(digS, digD), new THREE.Vector3());
    out.crew.stop = { phase: stp0.phase, tau: tb, kneel: stp0.kneel, dig: digShip.clone(), gangway: gang, stopDuration: stp, stamped: stp0.stamped, at: stp0.at };
    if (!show) return;
    // the crew lane's stop window: halted from the end of the brake until the rise ends (pure: the stop's start + its
    // length); the crew fits its sortie variant (full / quick / dash / wave) into it and walks the sand through groundAt
    out.crew.episodes.push({ k: 'treasure', id: crewId(`stop:${Math.round(stp0.at)}`), at: Math.round(stp0.at + br * 1000), until: Math.round(stp0.at + (br + stp) * 1000), side: stp0.side > 0 ? 'starboard' : 'port' });
    // timeline inside the stop
    const tOut = br + 8, tDig = tOut + 10, tUp = br + stp * 0.55, tBack = tUp + 4, tHome = br + stp - 8;
    // gangway foot (world) - the ramp's tip
    const gp = c.rig.gangway ? c.rig.gangway.node.localToWorld(new THREE.Vector3(0, 0, 8)) : null;
    if (gp && c.rig.ship) c.rig.ship.worldToLocal(gp);
    const foot = gp && gang > 0.5 ? c.toWorld(gp) : { s: stopS - 6, d: stp0.side * 7, h: c.ground.heightAt(stopS - 6, stp0.side * 7) };
    const chestUp = sm((tb - (tUp - 3)) / 3);
    // the chest: rises out of the sand, carried back, hoisted
    let cs = digS, cd = digD, ch = c.ground.heightAt(digS, digD) - 1.2 + 1.2 * chestUp;
    if (tb > tBack) { const u = sm((tb - tBack) / (tHome - tBack)); cs = digS + (foot.s - digS) * u; cd = digD + (foot.d - digD) * u; ch = c.ground.heightAt(cs, cd) + 0.9; }
    const shown = tb > tUp - 3.2 && tb < tHome + 2;
    if (shown) {
      chest.visible = true;
      chest.position.copy(c.toShip(cs, cd, ch, tv));
      chest.quaternion.identity();
      // reward cue (teal = reward only): glints when it breaks the surface + while carried
      const glint = sm((tb - (tUp - 0.5)) / 0.5) * (1 - sm((tb - tHome) / 2));
      for (let i = 0; i < 6; i++) { const r = voyageRand(stp0.seed, 120, i); c.fx.sprite(tv2.copy(chest.position).add(tv3.set((r - 0.5) * 1.6, 0.9 + 0.6 * Math.sin(c.t * 3 + i), (voyageRand(stp0.seed, 121, i) - 0.5) * 1.2)), 0.35, 0.21 * 1.6, 0.84 * 1.6, 0.76 * 1.6, glint * (0.5 + 0.5 * Math.sin(c.t * 7 + i * 1.7)), SPRITE.spark, r); }
      c.fx.sprite(tv2.copy(chest.position).add(tv3.set(0, 0.8, 0)), 2.2, 0.21, 0.84, 0.76, 0.5 * glint, SPRITE.glow, 0);
      if (c.intensity('treasure') === 'full') out.cuts.push({ key: `sortie:${stp0.at}`, kind: 'sortie', from: stp0.at + (tUp - 2.5) * 1000, to: stp0.at + (tUp + 5.5) * 1000, focusShip: chest.position.clone() });
    }
    // dig dust
    if (tb > tDig && tb < tUp) for (let i = 0; i < 5; i++) { const born = Math.floor(tb / 0.7) * 0.7 - i * 0.7; const a2 = tb - born; if (a2 < 2.5) this.puff(c, c.toShip(digS + (voyageRand(born * 10, i) - 0.5) * 3, digD + (voyageRand(born * 10, i, 1) - 0.5) * 3, c.ground.heightAt(digS, digD) + 0.4 + a2 * 1.2, tv), 0.8 + 0.8 * a2, 0.8, 0.62, 0.42, 0.6 * (1 - a2 / 2.5), voyageRand(born * 10, i)); }
    // celebration when the chest reaches the gangway (teal confetti pop)
    const party = tb - tHome;
    if (party > 0 && party < 4) for (let i = 0; i < 30; i++) {
      const r = voyageRand(stp0.seed, 130, i), a = r * Math.PI * 2;
      const P = c.toShip(foot.s + Math.cos(a) * 4 * party, foot.d + Math.sin(a) * 4 * party, foot.h + 3 + 6 * party - 4 * party * party, tv);
      const col = i % 3 === 0 ? [0.21, 0.84, 0.76] : i % 3 === 1 ? [1.6, 1.25, 0.5] : [1.4, 1.4, 1.4];
      c.fx.sprite(P, 0.5, col[0] * 1.5, col[1] * 1.5, col[2] * 1.5, 1 - party / 4, SPRITE.spark, r);
    }
    // the placeholder shore party (hidden when the crew lane claims the sortie)
    if (c.crewClaimed) return;
    const m = new THREE.Matrix4();
    for (let k = 0; k < 3; k++) {
      let ss = foot.s, d = foot.d, on = false, bob = 0;
      const lag = k * 1.2;
      if (tb > tOut + lag && tb < tDig + lag) { const u = sm((tb - tOut - lag) / 10); ss = foot.s + (digS - foot.s) * u; d = foot.d + (digD + (k - 1) * 1.6 - foot.d) * u; on = true; }
      else if (tb >= tDig + lag && tb < tBack) { ss = digS + (k - 1) * 1.2; d = digD + (k - 1) * 1.6; on = true; bob = Math.abs(Math.sin(c.t * 4 + k)) * 0.25; }
      else if (tb >= tBack && tb < tHome + lag) { const u = sm((tb - tBack) / (tHome - tBack)); ss = digS + (foot.s - digS) * u + (k - 1) * 1.1; d = digD + (foot.d - digD) * u + (k - 1) * 0.9; on = true; }
      if (!on) continue;
      const p = c.toShip(ss, d, c.ground.heightAt(ss, d) - bob, tv);
      m.makeTranslation(p.x, p.y, p.z);
      crew.setMatrixAt(crew.count++, m);
    }
    crew.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------------------------- dust under the feet
  private feet(c: ActionCtx) {
    if (c.v < 0.3 || c.level >= 2) return;
    for (const L of c.rig.legs) {
      footAt(c.S, L.gait, c.gait, 1, this.gaitFoot);
      const f = this.gaitFoot;
      if (!f.stance) continue;
      const age = f.sincePlant / Math.max(0.5, c.v);
      if (age > 1.8) continue;
      const g = c.ground.heightAt(f.s, f.d);
      for (let i = 0; i < 4; i++) {
        const r = voyageRand(f.k, i, Math.round(L.gait.lat * 10));
        const a = r * Math.PI * 2, rr = 1.2 + 2.6 * age * (0.6 + 0.4 * r);
        this.puff(c, c.toShip(f.s + Math.cos(a) * rr, f.d + Math.sin(a) * rr, g + 0.3 + 0.5 * age, tv), 1.1 + 1.4 * age, 0.82, 0.66, 0.46, 0.55 * (1 - age / 1.8), r);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------- exhaust (chat activity)
  private exhaust(c: ActionCtx) {
    const rate = 0.4 + 2.2 * c.chat;                  // puffs per second
    const vent = tv3.set(-1.4, 3.5, -5.2);
    const n = Math.min(10, Math.ceil(4 * rate));
    for (let i = 0; i < n; i++) {
      const born = Math.floor(c.t * rate) / rate - i / rate;
      const a = c.t - born;
      if (a < 0 || a > 4) continue;
      const r = voyageHash(Math.round(born * 100)) / 4294967296;
      // streams aft with the head wind
      this.puff(c, tv.copy(vent).add(tv2.set((r - 0.5) * 0.6, 1.3 * a, (0.8 + c.v * 0.9) * a)), 0.35 + 0.7 * a, 0.9, 0.9, 0.9, 0.45 * (1 - a / 4), r);
    }
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
    this.chest = null; this.placeholderCrew = null;
  }
}
