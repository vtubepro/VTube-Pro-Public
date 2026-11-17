// The Trail — the TRAIL layer as pure, deterministic functions (DESIGN.md §4, §9, §11). No DOM, no three.js, no time:
// the host sim calls these; Node tests call them directly. Same seed + same choices = same run.
import type { SizeClass } from '../avatarSize.ts';
import { Rng } from './rng.ts';
import { sizeStats } from './sizes.ts';
import {
  ITEM_IDS, type CondId, type Deck, type DeckChoice, type DeckEvent, type DeckOutcome, type Effect, type Grave, type ItemId, type Member,
  type Need, type Pace, type PlayerInfo, type Rations, type RouteNode, type RunState, type ScoreSheet, type Tier, type VoteState, type Who,
} from './types.ts';

export const MILES_PER_DAY: Record<Pace, number> = { steady: 15, strenuous: 20, grueling: 26 };
const PACE_HEALTH: Record<Pace, number> = { steady: 0, strenuous: -2, grueling: -5 };
const RATION_FOOD: Record<Rations, number> = { filling: 1.5, meager: 1, bare: 0.5 };
const RATION_HEALTH: Record<Rations, number> = { filling: 2, meager: 0.5, bare: -3 };
/** lbs of food a normal-sized pilgrim eats per day on meager rations. */
export const LBS_PER_DAY = 2;
const DRAFT_LOSS: Record<Pace, number> = { steady: 0.5, strenuous: 1.5, grueling: 3 };
const SICK_IDS: CondId[] = ['dysentery', 'cholera', 'typhoid', 'measles', 'exhaustion'];
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const r1 = (v: number) => Math.round(v * 10) / 10;

export const routeOf = (run: RunState, deck: Deck): RouteNode[] => (run.slice && deck.slice?.length ? deck.slice : deck.route);
export const living = (run: RunState): Member[] => run.order.map((id) => run.party[id]).filter((m) => m && m.alive);
export const everyone = (run: RunState): Member[] => run.order.map((id) => run.party[id]).filter(Boolean);
export const progress = (run: RunState) => clamp(run.miles / Math.max(1, run.total), 0, 1);

export function healthWord(h: number): 'good' | 'fair' | 'poor' | 'very poor' | 'dead' {
  return h <= 0 ? 'dead' : h > 70 ? 'good' : h > 45 ? 'fair' : h > 20 ? 'poor' : 'very poor';
}
/** Party health (the OT status line): the average of the living. */
export function partyHealth(run: RunState): number {
  const l = living(run);
  return l.length ? l.reduce((a, m) => a + m.health, 0) / l.length : 0;
}

// ---------------------------------------------------------------- new run / members
const COLORS = ['#7cff4f', '#ff4fd8', '#39d9ff', '#ffd23f', '#ff7a3d', '#b48cff', '#4fffc3', '#ff4f6d'];
export function newRun(deck: Deck, o: { seed: string; slice: boolean; modifiers?: string[]; players: PlayerInfo[]; oldGraves?: Grave[]; startMonth?: number }): RunState {
  const route = o.slice && deck.slice?.length ? deck.slice : deck.route;
  const rng = new Rng(`${o.seed}:start`);
  const run: RunState = {
    theme: deck.id, seed: o.seed, slice: o.slice, modifiers: [...(o.modifiers ?? [])],
    day: 0, startMonth: o.startMonth ?? rng.int(3, 5), miles: 0, total: route[route.length - 1].miles, node: 1,
    pace: 'steady', rations: 'meager', money: 0, food: 0, items: Object.fromEntries(ITEM_IDS.map((i) => [i, 0])) as Record<ItemId, number>,
    draft: 0, draftHealth: 100, morale: 70, weather: deck.weather[0]?.id ?? 'clear', biome: deck.biomes[0]?.id ?? 'plains',
    broken: [], limp: false, flags: {}, party: {}, order: [], lastEventDay: -99, seen: [], insaneLegs: [],
    graves: [], oldGraves: (o.oldGraves ?? []).filter((g) => g.theme === deck.id && g.mile < route[route.length - 1].miles).slice(-60),
    river: null, log: [], bossIdx: 0, mods: [], badDays: [], outcome: 'playing',
  };
  for (const p of o.players) addMember(run, deck, p, false);
  if (run.modifiers.includes('dysentery_any')) for (const m of living(run)) m.conds.push({ id: 'dysentery', days: 6 });
  return run;
}

export function addMember(run: RunState, deck: Deck, p: PlayerInfo, late: boolean): Member {
  const existing = run.party[p.id];
  if (existing) { existing.name = p.name; return existing; }
  const role = deck.roles[p.role] ? p.role : 'banker';
  const st = sizeStats(p.height);
  const m: Member = {
    id: p.id, name: p.name.slice(0, 40), role, height: st.height, cls: st.cls, color: p.color || COLORS[run.order.length % COLORS.length],
    health: run.modifiers.includes('hardcore') ? 80 : 100, conds: [], alive: true, ghost: false,
    stats: { swept: 0, dropped: 0, carriedKg: 0, shots: 0, hits: 0, revives: 0, deaths: 0 }, late,
  };
  run.party[p.id] = m;
  run.order.push(p.id);
  // starting money: the role's purse (a late pilgrim brings half)
  run.money += Math.round((deck.roles[role]?.money ?? 300) * (late ? 0.5 : 1));
  return m;
}

// ---------------------------------------------------------------- calendar / weather / biome
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MDAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export function dateOf(run: RunState, deck: Deck): string {
  let m = run.startMonth - 1, d = run.day + 1;
  while (d > MDAYS[m % 12]) { d -= MDAYS[m % 12]; m++; }
  return `${MONTHS[m % 12]} ${d}, ${deck.text.year ?? '1848'}`;
}
function monthOf(run: RunState): number {
  let m = run.startMonth - 1, d = run.day + 1;
  while (d > MDAYS[m % 12]) { d -= MDAYS[m % 12]; m++; }
  return m % 12;
}
function rollWeather(run: RunState, deck: Deck, rng: Rng) {
  if (rng.next() > 0.3) return; // weather sticks for a few days
  const month = monthOf(run);
  const hot = month >= 5 && month <= 7, cold = month <= 2 || month >= 10;
  const ws = deck.weather.map((w) => {
    const cool = w.health < -1 ? (cold ? 2.5 : hot ? 0.3 : 0.8) : 1;
    return w.id === deck.weather[0]?.id ? 3 : cool;
  });
  const i = rng.weighted(ws);
  if (i >= 0) run.weather = deck.weather[i].id;
}
function updateBiome(run: RunState, deck: Deck) {
  const p = progress(run);
  let b = deck.biomes[0]?.id ?? 'plains';
  for (const x of deck.biomes) if (p >= x.from) b = x.id;
  run.biome = b;
}

// ---------------------------------------------------------------- the day tick
export interface DayResult { miles: number; notes: string[]; deaths: { id: string; cause: string }[]; arrived: RouteNode | null; event: DeckEvent | null; sick: { id: string; cond: CondId }[] }

/** Travel speed factor from the draft animals, broken parts, weather (0 = can't move). */
export function speedFactor(run: RunState, deck: Deck): number {
  if (run.broken.length && !run.limp) return 0;
  const d = run.draft;
  const draftK = d <= 0 ? (run.flags.humanToads ? 0.35 : 0) : d === 1 ? 0.5 : d === 2 ? 0.8 : d === 3 ? 0.95 : 1;
  const w = deck.weather.find((x) => x.id === run.weather)?.speed ?? 1;
  return draftK * (0.5 + 0.5 * run.draftHealth / 100) * w * (run.limp && run.broken.length ? 0.6 : 1) * (run.modifiers.includes('speedrun') ? 1.25 : 1);
}

export function milesPerDay(run: RunState, deck: Deck): number { return MILES_PER_DAY[run.pace] * speedFactor(run, deck); }

/** One day passes. `travel` = the wagon moves (false: resting / waiting / lost days). The host passes the run's
 *  event RNG stream. Returns what happened; deaths are already applied (members marked dead). */
/** `driven` (v2 journey): the miles were driven for real (run.miles already moved by the wagon); the day still counts
 *  as a travel day (draft wear, event roll) but adds no miles and never "arrives" (the journey does). */
export function dayTick(run: RunState, deck: Deck, rng: Rng, travel = true, resting = false, driven?: number): DayResult {
  const out: DayResult = { miles: 0, notes: [], deaths: [], arrived: null, event: null, sick: [] };
  if (run.outcome !== 'playing') return out;
  run.day++;
  if (run.rationsLock && run.day >= run.rationsLock.until) { run.rations = run.rationsLock.v; run.rationsLock = undefined; }
  rollWeather(run, deck, rng);
  const weather = deck.weather.find((x) => x.id === run.weather);
  const liv = living(run);
  // ---- food
  const munch = (m: Member) => (m.conds.some((c) => c.id === 'munchies') ? 2 : 1);
  const bigBack = (m: Member) => (m.quirk === 'big_back' ? 1.5 : 1);
  let need = 0;
  for (const m of liv) if (!m.ghost) need += LBS_PER_DAY * sizeStats(m.height).appetite * RATION_FOOD[run.rations] * munch(m) * bigBack(m);
  const starving = need > run.food + 1e-6;
  run.food = Math.max(0, r1(run.food - need));
  // hunger ramps up (a first empty day hurts less than the tenth); a starving party scrounges a little food
  const hungry = run.flags.hungry = starving ? (run.flags.hungry ?? 0) + 1 : 0;
  const hungerHit = Math.min(10, 2.5 + 1.25 * hungry);
  const foragers = liv.filter((m) => !m.ghost);
  if (starving && foragers.length && rng.chance(0.5)) {
    const who = rng.pick(foragers);
    const n = Math.round(foragers.length * rng.range(1, 2.6) * (who.cls === 'micro' ? 1.5 : 1));
    run.food = r1(run.food + n);
    out.notes.push((deck.text.forage ?? '{name} scrounged up {n} lbs of food.').replace('{name}', who.name).replace('{n}', String(n)));
  }
  // ---- travel
  const route = routeOf(run, deck);
  if (travel && driven !== undefined) {
    out.miles = driven;
    run.draftHealth = clamp(run.draftHealth - DRAFT_LOSS[run.pace] * (hasRole(run, 'whisperer') ? 0.5 : 1) * Math.min(1.5, driven / Math.max(1, milesPerDay(run, deck))), 0, 100);
  } else if (travel) {
    const mpd = milesPerDay(run, deck);
    const next = route[run.node];
    let gain = mpd;
    if (next && run.miles + gain >= next.miles) { gain = next.miles - run.miles; out.arrived = next; }
    run.miles = r1(run.miles + gain);
    out.miles = gain;
    if (mpd <= 0) out.notes.push(run.broken.length ? 'The {wagon} can\'t move: a broken {part}.' : 'The {wagon} can\'t move without {draft}.');
    run.draftHealth = clamp(run.draftHealth - DRAFT_LOSS[run.pace] * (hasRole(run, 'whisperer') ? 0.5 : 1), 0, 100);
  } else if (resting) run.draftHealth = clamp(run.draftHealth + 2, 0, 100);
  if (run.draft > 0 && run.draftHealth < 20 && rng.chance(0.06)) { run.draft--; out.notes.push('One of the {draft} has died.'); }
  updateBiome(run, deck);
  // ---- health
  const coldNoClothes = (weather?.health ?? 0) < -1 && run.items.clothes < liv.filter((m) => !m.ghost).length;
  for (const m of liv) {
    if (m.ghost) continue;
    let dh = RATION_HEALTH[run.rations] + (travel ? PACE_HEALTH[run.pace] : 0) + (weather?.health ?? 0) + (resting ? 6 : 0) + (run.morale > 80 ? 0.5 : run.morale < 25 ? -1 : 0);
    if (starving) dh -= hungerHit;
    if (coldNoClothes) dh -= 3;
    for (const c of m.conds) {
      const def = deck.conds[c.id];
      const drain = def?.drain ?? 5;
      dh -= c.id === 'exhaustion' && run.pace === 'grueling' ? drain * 2 : c.id === 'snakebite' && c.days < 0 ? drain * 1.5 : drain;
      c.days -= resting ? 2 : 1;
    }
    m.conds = m.conds.filter((c) => c.id === 'snakebite' ? c.days > -6 : c.days > 0);
    m.health = clamp(r1(m.health + dh), 0, 100);
    // catching something
    let p = 0.012 + (run.rations === 'bare' ? 0.02 : 0) + (run.pace === 'grueling' ? 0.02 : 0) + (coldNoClothes ? 0.02 : 0) + (starving ? 0.03 : 0);
    if (m.cls === 'micro') p *= 0.5;
    if (!m.conds.length && rng.chance(p)) {
      const id = rng.pick(SICK_IDS);
      m.conds.push({ id, days: deck.conds[id]?.days || 5 });
      out.sick.push({ id: m.id, cond: id });
      out.notes.push(`${m.name} has ${deck.conds[id]?.name ?? id}.`);
    }
    if (m.health <= 0) {
      const worst = [...m.conds].sort((a, b) => (deck.conds[b.id]?.drain ?? 0) - (deck.conds[a.id]?.drain ?? 0))[0];
      const cause = starving ? (deck.text.starvation ?? 'starvation') : worst ? (deck.conds[worst.id]?.name ?? worst.id) : (deck.text.exhaustionCause ?? 'exhaustion');
      kill(run, m.id, cause);
      out.deaths.push({ id: m.id, cause });
    }
  }
  run.morale = clamp(run.morale + (hasRole(run, 'streamer') ? 1 : 0) + (starving ? -4 : 0) + (run.rations === 'filling' ? 0.5 : run.rations === 'bare' ? -1 : 0), 0, 100);
  run.bossIdx = (run.bossIdx + 1) % Math.max(1, run.order.length);
  if (!living(run).length) run.outcome = 'wiped';
  // ---- event roll (travel days only, not on the day we arrive somewhere)
  if (travel && !out.arrived && run.outcome === 'playing') out.event = rollEvent(run, deck, rng);
  return out;
}

export function kill(run: RunState, id: string, cause: string) {
  const m = run.party[id];
  if (!m || !m.alive) return;
  m.alive = false; m.ghost = true; m.health = 0; m.conds = [];
  m.diedOf = cause; m.diedMile = Math.round(run.miles); m.diedDay = run.day; m.stats.deaths++;
  run.graves.push({ mile: Math.round(run.miles), name: m.name, cause, epitaph: '', theme: run.theme, seed: run.seed, date: new Date().toISOString().slice(0, 10), day: run.day });
  run.morale = clamp(run.morale - 12, 0, 100);
  if (!living(run).length) run.outcome = 'wiped';
}
export function revive(run: RunState, id: string, health = 40) {
  const m = run.party[id];
  if (!m || m.alive) return;
  m.alive = true; m.ghost = false; m.health = health; m.diedOf = undefined; m.diedMile = undefined;
  if (run.outcome === 'wiped') run.outcome = 'playing';
}

export const hasRole = (run: RunState, role: string) => living(run).some((m) => m.role === role && !m.ghost);
export const hasSize = (run: RunState, cls: SizeClass) => living(run).some((m) => m.cls === cls && !m.ghost);

// ---------------------------------------------------------------- events: eligibility, tiers, roll
export function tierWeights(run: RunState): Record<Tier, number> {
  const p = progress(run);
  const w: Record<Tier, number> = { mild: 50 - 26 * p, hilarious: 30, hard: 18 + 15 * p, insane: 2 + 11 * p };
  if (run.modifiers.includes('chaos')) { w.insane *= 2; w.hilarious *= 2; }
  if (run.modifiers.includes('chill')) { w.hard *= 0.5; w.insane *= 0.5; }
  if (run.morale < 30) w.hard += 10;
  if (living(run).length <= 2) w.hard *= 0.5;
  // never INSANE in the first 2 legs; at most one per 3 legs
  if (run.node <= 2 || run.insaneLegs.some((l) => run.node - l < 3)) w.insane = 0;
  return w;
}

export function needValue(run: RunState, deck: Deck, s: Need['s']): number {
  const liv = living(run);
  switch (s) {
    case 'food': return run.food;
    case 'foodDays': { const need = liv.reduce((a, m) => a + (m.ghost ? 0 : LBS_PER_DAY * sizeStats(m.height).appetite * RATION_FOOD[run.rations]), 0); return need > 0 ? run.food / need : 99; }
    case 'money': return run.money;
    case 'draft': return run.draft;
    case 'dead': return everyone(run).filter((m) => !m.alive).length;
    case 'living': return liv.length;
    case 'micro': return liv.filter((m) => m.cls === 'micro').length;
    case 'small': return liv.filter((m) => m.cls === 'small' || m.cls === 'micro').length;
    case 'macro': return liv.filter((m) => m.cls === 'macro').length;
    case 'sick': return liv.filter((m) => m.conds.length).length;
    case 'dysentery': return liv.filter((m) => m.conds.some((c) => c.id === 'dysentery')).length;
    case 'meme': return run.items.meme;
    case 'players': return run.order.length;
    case 'graves': return run.oldGraves.length;
    case 'heat': return run.flags.heat ?? 0;
    case 'haunted': return run.flags.haunted ?? 0;
    case 'badDays': return run.badDays.filter((d) => run.day - d <= 2).length;
    case 'broken': return run.broken.length;
  }
  void deck;
  return 0;
}
const cmp = (a: number, op: Need['op'], b: number) => (op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : op === '<=' ? a <= b : a === b);

export function eligible(e: DeckEvent, run: RunState, deck: Deck, night = false): boolean {
  const t = e.trigger;
  const p = progress(run);
  if (t) {
    if (t.minP !== undefined && p < t.minP) return false;
    if (t.maxP !== undefined && p > t.maxP) return false;
    if (t.minLeg !== undefined && run.node < t.minLeg) return false;
    if (t.biome?.length && !t.biome.includes(run.biome)) return false;
    if (t.weather?.length && !t.weather.includes(run.weather)) return false;
    if (t.pace?.length && !t.pace.includes(run.pace)) return false;
    if (t.night !== undefined && t.night !== night) return false;
    for (const n of t.need ?? []) if (!cmp(needValue(run, deck, n.s), n.op, n.n)) return false;
  }
  if (e.id === 'body_swap' && (!run.flags.chaosConsent || living(run).length < 2)) return false;
  return true;
}

/** The daily roll: maybe an event (tier by progress / modifiers, then weighted within the tier, no repeats until a
 *  tier is exhausted). `force` skips the chance roll (debug / chained). */
export function rollEvent(run: RunState, deck: Deck, rng: Rng, night = false, force = false): DeckEvent | null {
  if (!force) {
    if (run.day - run.lastEventDay < 2) return null;
    const chance = 0.14 + 0.01 * run.miles / 100 + (run.pace === 'grueling' ? 0.04 : 0) + (run.biome === deck.biomes[deck.biomes.length - 1]?.id ? 0.03 : 0) + (run.modifiers.includes('chaos') ? 0.06 : 0);
    if (!rng.chance(chance)) return null;
  }
  const tw = tierWeights(run);
  const pool = deck.events.filter((e) => eligible(e, run, deck, night));
  if (!pool.length) return null;
  const tiers: Tier[] = ['mild', 'hilarious', 'hard', 'insane'];
  const avail = tiers.map((t) => (pool.some((e) => e.tier === t) ? tw[t] : 0));
  const ti = rng.weighted(avail);
  if (ti < 0) return null;
  const tier = tiers[ti];
  let cand = pool.filter((e) => e.tier === tier && !run.seen.includes(e.id));
  if (!cand.length) { run.seen = run.seen.filter((id) => deck.events.find((e) => e.id === id)?.tier !== tier); cand = pool.filter((e) => e.tier === tier); }
  const i = rng.weighted(cand.map((e) => (e.weight ?? 1) * (e.id === 'ghost_convoy' && run.flags.haunted ? 3 : 1)));
  if (i < 0) return null;
  const ev = cand[i];
  run.lastEventDay = run.day;
  run.seen.push(ev.id);
  if (ev.tier === 'insane') run.insaneLegs.push(run.node);
  return ev;
}

/** Who an event is about. */
export function pickTarget(e: DeckEvent, run: RunState, rng: Rng): string | null {
  const liv = living(run).filter((m) => !m.ghost);
  if (!liv.length) return null;
  const size = (m: Member) => m.height;
  switch (e.target ?? 'random') {
    case 'none': return null;
    case 'smallest': return [...liv].sort((a, b) => size(a) - size(b))[0].id;
    case 'largest': return [...liv].sort((a, b) => size(b) - size(a))[0].id;
    case 'sick': return (liv.find((m) => m.conds.length) ?? rng.pick(liv)).id;
    case 'dysentery': return (liv.find((m) => m.conds.some((c) => c.id === 'dysentery')) ?? rng.pick(liv)).id;
    case 'dead': return everyone(run).find((m) => !m.alive)?.id ?? null;
    case 'main': case 'random': default: {
      const ws = liv.map((m) => (m.quirk === 'main_character' ? 2 : 1) * (m.quirk === 'npc' && !m.stats.revives ? 0.2 : 1));
      return liv[Math.max(0, rng.weighted(ws))].id;
    }
  }
}

// ---------------------------------------------------------------- choices + outcomes
/** Why a choice can't be picked right now (null = it can). */
export function choiceBlocked(run: RunState, deck: Deck, c: DeckChoice): string | null {
  const q = c.req;
  if (!q) return null;
  const cur = deck.currency.sym;
  if (q.item && run.items[q.item] < (q.n ?? 1)) return `needs ${q.n ?? 1} ${deck.items[q.item]?.name ?? q.item}`;
  if (q.money && run.money < q.money) return `needs ${cur}${q.money}`;
  if (q.food && run.food < q.food) return `needs ${q.food} lbs of food`;
  if (q.role && !hasRole(run, q.role)) return `needs a ${deck.roles[q.role]?.name ?? q.role}`;
  if (q.players && living(run).length < q.players) return `needs ${q.players} players`;
  return null;
}

export interface Ctx { target: string | null; volunteer: string | null; cause: string; extra?: Record<string, string | number> }
export interface Resolution { outcome: DeckOutcome; text: string; notes: string[]; deaths: { id: string; cause: string }[]; chain: string | null; rewind: boolean; hunt: boolean; mods: string[]; swap: [string, string] | null }

function modFactor(run: RunState, o: DeckOutcome, ctx: Ctx): number {
  let k = 1;
  for (const m of o.mods ?? []) {
    const tgt = ctx.target ? run.party[ctx.target] : null;
    const pool = m.on === 'target' ? (tgt ? [tgt] : []) : living(run).filter((x) => !x.ghost);
    let hit = false;
    if (m.role) hit = pool.some((x) => x.role === m.role);
    else if (m.size) hit = pool.some((x) => x.cls === m.size);
    else if (m.flag) hit = (run.flags[m.flag] ?? 0) > 0;
    else if (m.item) hit = run.items[m.item] > 0;
    if (hit) k *= m.x;
  }
  return k;
}

/** Pick an outcome: by a physical stop's result when given, else weighted (with the perk / size modifiers). */
export function pickOutcome(run: RunState, c: DeckChoice, ctx: Ctx, rng: Rng, stopResult?: 'success' | 'partial' | 'fail'): DeckOutcome {
  if (stopResult) {
    const o = c.outcomes.find((x) => x.on === stopResult) ?? (stopResult === 'partial' ? c.outcomes.find((x) => x.on === 'success') : null) ?? c.outcomes.find((x) => x.on === 'fail');
    if (o) return o;
  }
  const opts = c.outcomes;
  const ws = opts.map((o) => (o.w ?? (o.on ? (o.on === 'success' ? 0.6 : o.on === 'fail' ? 0.4 : 0.2) : 1)) * modFactor(run, o, ctx));
  const i = rng.weighted(ws);
  return opts[Math.max(0, i)];
}

export function fill(tpl: string, run: RunState, deck: Deck, ctx: Partial<Ctx> = {}): string {
  const name = (id: string | null | undefined) => (id && run.party[id]?.name) || 'someone';
  const dead = everyone(run).find((m) => !m.alive);
  const map: Record<string, string | number> = {
    target: name(ctx.target), volunteer: name(ctx.volunteer), dead: dead?.name ?? 'the fallen', wagon: deck.text.wagon, draft: deck.text.draft, draftOne: deck.text.draftOne,
    currency: deck.currency.name, sym: deck.currency.sym, food: Math.round(run.food), money: run.money, meme: deck.items.meme?.name ?? 'the meme item',
    part: run.broken[0] ? (deck.items[run.broken[0]]?.name ?? run.broken[0]) : 'part', huntTool: deck.text.huntTool, ...(ctx.extra ?? {}),
  };
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in map ? String(map[k]) : m));
}

function whoIds(run: RunState, who: Who, ctx: Ctx, rng: Rng): string[] {
  const liv = living(run).filter((m) => !m.ghost);
  switch (who) {
    case 'all': return everyone(run).filter((m) => m.alive).map((m) => m.id);
    case 'living': return liv.map((m) => m.id);
    case 'target': return ctx.target ? [ctx.target] : liv.length ? [rng.pick(liv).id] : [];
    case 'random': return liv.length ? [rng.pick(liv).id] : [];
    case 'volunteer': return ctx.volunteer ? [ctx.volunteer] : [];
    case 'dead': { const d = everyone(run).find((m) => !m.alive); return d ? [d.id] : []; }
    case 'ghosts': return everyone(run).filter((m) => m.ghost).map((m) => m.id);
  }
  return [];
}

/** Apply effects in order. Returns notes + deaths (members already marked dead). */
export function applyEffects(run: RunState, deck: Deck, fx: readonly Effect[], ctx: Ctx, rng: Rng): Omit<Resolution, 'outcome' | 'text'> {
  const res: Omit<Resolution, 'outcome' | 'text'> = { notes: [], deaths: [], chain: null, rewind: false, hunt: false, mods: [], swap: null };
  const hurt = (id: string, n: number) => {
    const m = run.party[id];
    if (!m || !m.alive || m.ghost) return;
    m.health = clamp(r1(m.health + n), 0, 100);
    if (m.health <= 0) { kill(run, id, ctx.cause); res.deaths.push({ id, cause: ctx.cause }); }
  };
  for (const f of fx) {
    switch (f.k) {
      case 'food': run.food = Math.max(0, r1(run.food + f.n)); break;
      case 'money': run.money = Math.max(0, Math.round(run.money + f.n)); break;
      case 'item': run.items[f.id] = Math.max(0, (run.items[f.id] ?? 0) + f.n); break;
      case 'meme': run.items.meme = Math.max(0, run.items.meme + f.n); break;
      case 'health': for (const id of whoIds(run, f.who, ctx, rng)) hurt(id, f.n); break;
      case 'cond': for (const id of whoIds(run, f.who, ctx, rng)) {
        const m = run.party[id];
        const cid: CondId = f.id === 'random' ? rng.pick(SICK_IDS) : f.id;
        if (!m || !m.alive || m.ghost || m.conds.some((c) => c.id === cid)) continue;
        if (f.p !== undefined && !rng.chance(f.p * (m.cls === 'micro' ? 0.5 : 1))) continue;
        m.conds.push({ id: cid, days: deck.conds[cid]?.days || 5 });
        res.notes.push(`${m.name} has ${deck.conds[cid]?.name ?? cid}.`);
      } break;
      case 'cure': for (const id of whoIds(run, f.who, ctx, rng)) { const m = run.party[id]; if (m) m.conds = m.conds.filter((c) => c.id === 'munchies'); } break;
      case 'days': for (let i = 0; i < f.n; i++) { const d = dayTick(run, deck, rng, false, false); res.deaths.push(...d.deaths); res.notes.push(...d.notes); } break;
      case 'miles': {
        const next = routeOf(run, deck)[run.node];
        run.miles = clamp(r1(run.miles + f.n), 0, next ? next.miles - 0.5 : run.total);
        break;
      }
      case 'draft': run.draft = Math.max(0, run.draft + f.n); break;
      case 'draftHealth': run.draftHealth = clamp(run.draftHealth + f.n, 0, 100); break;
      case 'morale': run.morale = clamp(run.morale + f.n, 0, 100); break;
      case 'break': if (!run.broken.includes(f.part)) run.broken.push(f.part); run.limp = false; break;
      case 'repair': run.broken = run.broken.filter((p) => p !== f.part); if (!run.broken.length) run.limp = false; break;
      case 'flag': run.flags[f.id] = (run.flags[f.id] ?? 0) + f.n; break;
      case 'mod': run.mods.push(f.id); res.mods.push(f.id); break;
      case 'ghost': for (const id of whoIds(run, f.who, ctx, rng)) { const m = run.party[id]; if (m && m.alive) { m.ghost = true; run.flags[`tempGhost:${id}`] = 1; } } break;
      case 'revive': for (const id of whoIds(run, f.who, ctx, rng)) { revive(run, id); run.party[id] && res.notes.push(`${run.party[id].name} is back!`); } break;
      case 'swap': {
        const l = living(run).filter((m) => !m.ghost);
        if (l.length >= 2) { const a = rng.int(0, l.length - 1); let b = rng.int(0, l.length - 2); if (b >= a) b++; res.swap = [l[a].id, l[b].id]; run.mods.push(`swap:${l[a].id}:${l[b].id}`); }
        break;
      }
      case 'chain': res.chain = f.id; break;
      case 'rewind': res.rewind = true; break;
      case 'rations': run.rationsLock = { v: run.rations, until: run.day + f.days }; run.rations = f.v; break;
      case 'depth': run.flags.riverDepth = (run.flags.riverDepth ?? 0) + f.n; break;
      case 'hunt': res.hunt = true; break;
      case 'limp': run.limp = true; break;
      case 'rest': for (let i = 0; i < f.n; i++) { const d = dayTick(run, deck, rng, false, true); res.deaths.push(...d.deaths); res.notes.push(...d.notes); } break;
    }
  }
  if (!living(run).length) run.outcome = 'wiped';
  return res;
}

/** Resolve an event choice (card resolution, or the result of its physical stop). */
export function resolveChoice(run: RunState, deck: Deck, e: DeckEvent, choiceId: string, ctx: Ctx, rng: Rng, stopResult?: 'success' | 'partial' | 'fail'): Resolution {
  const c = e.choices.find((x) => x.id === choiceId) ?? e.choices[e.choices.length - 1];
  const outcome = pickOutcome(run, c, ctx, rng, stopResult);
  const r = applyEffects(run, deck, outcome.fx, { ...ctx, cause: ctx.cause || e.name }, rng);
  const bad = outcome.fx.some((f) => (f.k === 'health' && f.n < -10) || (f.k === 'food' && f.n < -20) || f.k === 'break' || (f.k === 'days' && f.n >= 2));
  if (bad) run.badDays.push(run.day);
  return { outcome, text: fill(outcome.text, run, deck, ctx), ...r };
}

// ---------------------------------------------------------------- votes
/** Majority; ties → the Wagon Boss if they voted one of the tied options, else dice. Chat = one extra vote (two with a
 *  Streamer). Nobody voted → the first enabled option. */
export function tally(v: VoteState, run: RunState | null, rng: Rng): { result: string; how: 'majority' | 'boss' | 'dice' | 'default' } {
  const enabled = v.options.filter((o) => !o.disabled).map((o) => o.id);
  const count: Record<string, number> = {};
  for (const [, opt] of Object.entries(v.votes)) if (enabled.includes(opt)) count[opt] = (count[opt] ?? 0) + 1;
  if (v.chat) {
    const top = Object.entries(v.chat).filter(([o]) => enabled.includes(o)).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] > 0) count[top[0]] = (count[top[0]] ?? 0) + (run && hasRole(run, 'streamer') ? 2 : 1);
  }
  const entries = Object.entries(count);
  if (!entries.length) return { result: enabled[0] ?? v.options[0].id, how: 'default' };
  const max = Math.max(...entries.map((e) => e[1]));
  const tied = entries.filter((e) => e[1] === max).map((e) => e[0]);
  if (tied.length === 1) return { result: tied[0], how: 'majority' };
  const bossPick = v.boss ? v.votes[v.boss] : undefined;
  if (bossPick && tied.includes(bossPick)) return { result: bossPick, how: 'boss' };
  return { result: rng.pick(tied.sort()), how: 'dice' };
}

// ---------------------------------------------------------------- store
export function priceOf(run: RunState, deck: Deck, item: ItemId | 'food' | 'draft'): number {
  const base = deck.items[item]?.price ?? 10;
  const node = run.node - 1;
  const inflate = 1 + Math.max(0, node) * 0.12; // forts further along are pricier (OT)
  return Math.max(1, Math.round(base * inflate * (hasRole(run, 'banker') ? 0.85 : 1)));
}

// ---------------------------------------------------------------- rivers
export function riverAt(run: RunState, node: RouteNode, rng: Rng): { depth: number; width: number; swift: boolean } {
  const base = node.depth ?? 3;
  const depth = Math.max(1, r1(base + rng.range(-1, 1.6) + (run.weather.includes('rain') || run.weather.includes('storm') ? 1 : 0) + (run.flags.riverDepth ?? 0) + (run.modifiers.includes('mirror') ? 1 : 0)));
  run.flags.riverDepth = 0;
  return { depth, width: Math.round((node.width ?? 500) + rng.range(-80, 120)), swift: depth > 3.5 || rng.chance(0.3) };
}
/** Card fallback for a crossing (no physical stop): chance of trouble by method + depth. */
export function riverRisk(river: { depth: number; swift: boolean }, how: 'ford' | 'caulk' | 'ferry'): number {
  if (how === 'ferry') return 0.03;
  if (how === 'caulk') return clamp(0.1 + (river.swift ? 0.15 : 0) + (river.depth < 2.5 ? 0.1 : 0), 0, 0.9);
  return clamp(river.depth < 2.5 ? 0.05 : river.depth < 3.5 ? 0.25 : river.depth < 5 ? 0.6 : 0.9, 0, 0.95) + (river.swift ? 0.1 : 0);
}

// ---------------------------------------------------------------- score (OT formula, themed)
export function score(run: RunState, deck: Deck): ScoreSheet {
  const lines: ScoreSheet['lines'] = [];
  const add = (label: string, n: number, per: number) => { if (n > 0) lines.push({ label, n, pts: Math.round(n * per) }); };
  const word = { good: 500, fair: 400, poor: 300, 'very poor': 200, dead: 0 } as const;
  for (const m of living(run)) if (!m.ghost) lines.push({ label: `${m.name} (${healthWord(m.health)})`, n: 1, pts: word[healthWord(m.health)] });
  add(`${deck.text.draft}`, run.draft, 4);
  add('spare parts', run.items.wheel + run.items.axle + run.items.tongue, 2);
  add(deck.items.clothes.name, run.items.clothes, 2);
  add(deck.items.ammo.name, Math.floor(run.items.ammo / 20), 1);
  add('lbs of food / 25', Math.floor(run.food / 25), 1);
  add(`${deck.currency.name} / 5`, Math.floor(run.money / 5), 1);
  if (run.items.meme > 0) add(deck.items.meme.name, 1, 50);
  let mult = 1;
  for (const m of everyone(run)) mult = Math.max(mult, deck.roles[m.role]?.mult ?? 1);
  if (run.modifiers.includes('speedrun')) mult *= 1.2;
  if (run.modifiers.includes('chill')) mult *= 0.8;
  if (run.modifiers.includes('hardcore')) mult *= 2;
  const raw = lines.reduce((a, l) => a + l.pts, 0);
  const titles: ScoreSheet['titles'] = [];
  const top = (k: keyof Member['stats'], title: string) => {
    const best = everyone(run).filter((m) => m.stats[k] > 0).sort((a, b) => b.stats[k] - a.stats[k])[0];
    if (best) titles.push({ who: best.name, title });
  };
  top('carriedKg', deck.text.titleCarry ?? 'Pack Mule');
  top('swept', deck.text.titleSwept ?? 'Most Swept');
  top('dropped', deck.text.titleShame ?? 'Hall of Shame');
  top('hits', deck.text.titleHunter ?? 'Sharpshooter');
  top('revives', deck.text.titleMedic ?? 'Guardian Angel');
  if (run.flags.kaiju) titles.push({ who: 'The party', title: deck.text.titleKaiju ?? 'Kaiju Slayers' });
  if (run.flags.ateMeme) titles.push({ who: 'The party', title: deck.text.titleAteMeme ?? 'Ate the Frog' });
  return { lines, mult, total: Math.round(raw * mult), titles };
}

/** Deaths caused by damage in a stop (the sim reports) → run members. */
export function stopDamage(run: RunState, id: string, hp: number, cause: string): boolean {
  const m = run.party[id];
  if (!m || !m.alive || m.ghost) return false;
  m.health = clamp(r1(m.health - hp), 0, 100);
  if (m.health <= 0) { kill(run, id, cause); return true; }
  return false;
}

/** The event's immediate effects (the bite, the broken wheel…) — applied when it is drawn, before the vote. */
export function fireEvent(run: RunState, deck: Deck, e: DeckEvent, ctx: Ctx, rng: Rng) {
  return e.fire?.length ? applyEffects(run, deck, e.fire, { ...ctx, cause: ctx.cause || e.name }, rng) : null;
}
