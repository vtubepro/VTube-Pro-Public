// The Trail — bot policy + a card-only whole-run simulator (balance checks in Node, bots in the host sim).
import { Rng } from './rng.ts';
import { addMember, choiceBlocked, dayTick, fireEvent, living, newRun, pickTarget, priceOf, resolveChoice, riverAt, riverRisk, routeOf, score } from './rules.ts';
import type { Deck, DeckEvent, PlayerInfo, RunState } from './types.ts';

/** A sensible starting shopping list for a party (bots / the "Quick buy" catalogue button). */
export function shoppingList(run: RunState, deck: Deck): { item: 'food' | 'draft' | 'clothes' | 'ammo' | 'wheel' | 'axle' | 'tongue' | 'medicine' | 'meme'; n: number }[] {
  const people = living(run).length;
  const eat = living(run).reduce((a, m) => a + ({ micro: 0.25, small: 0.6, normal: 1, large: 1.6, macro: 3 }[m.cls] ?? 1), 0);
  const days = run.slice ? 30 : 75;
  const crates = Math.ceil((eat * 2 * days) / (deck.items.food.unit ?? 50));
  return [
    { item: 'draft', n: 4 }, { item: 'food', n: crates }, { item: 'clothes', n: people }, { item: 'ammo', n: 3 },
    { item: 'wheel', n: 1 }, { item: 'axle', n: 1 }, { item: 'medicine', n: 2 }, { item: 'meme', n: 1 },
  ];
}

/** Buy as much of a list as the money allows (in order). Returns what was bought. */
export function buyList(run: RunState, deck: Deck, list: ReturnType<typeof shoppingList>): string[] {
  const got: string[] = [];
  for (const { item, n } of list) {
    for (let i = 0; i < n; i++) {
      const p = priceOf(run, deck, item);
      if (run.money < p) break;
      run.money -= p;
      if (item === 'food') run.food += deck.items.food.unit ?? 50;
      else if (item === 'draft') run.draft++;
      else if (item === 'ammo') run.items.ammo += deck.items.ammo.unit ?? 20;
      else run.items[item]++;
      got.push(item);
    }
  }
  return got;
}

/** Bot vote: the first unblocked choice that isn't obviously terrible, with some randomness. */
export function botChoice(run: RunState, deck: Deck, e: DeckEvent, rng: Rng, style: 'careful' | 'chaos' = 'careful'): string {
  const ok = e.choices.filter((c) => !choiceBlocked(run, deck, c));
  if (!ok.length) return e.choices[e.choices.length - 1].id;
  if (style === 'chaos') return rng.pick(ok).id;
  // careful: prefer free / safe-sounding choices
  const score = (id: string) => (/medicine|medic|replace|jury|pay|haggle|shelter|rest|boil|ferry|turn|search|chase|push|fight|race|sing|save|hold|brace|rescue/.test(id) ? 2 : 1) + rng.next();
  return [...ok].sort((a, b) => score(b.id) - score(a.id))[0].id;
}

export interface SimSummary { seed: string; outcome: RunState['outcome']; days: number; miles: number; deaths: number; living: number; events: Record<string, number>; score: number; tiers: Record<string, number> }

/** Play a whole run with card resolutions only (no physics): the balance baseline. */
export function simulateRun(deck: Deck, seed: string, players: PlayerInfo[], o: { slice?: boolean; style?: 'careful' | 'chaos'; maxDays?: number } = {}): SimSummary {
  const run = newRun(deck, { seed, slice: !!o.slice, players: [] });
  for (const p of players) addMember(run, deck, p, false);
  const rng = new Rng(`${seed}:events`);
  buyList(run, deck, shoppingList(run, deck));
  const route = routeOf(run, deck);
  const events: Record<string, number> = {};
  const tiers: Record<string, number> = { mild: 0, hilarious: 0, hard: 0, insane: 0 };
  const play = (e: DeckEvent) => {
    events[e.id] = (events[e.id] ?? 0) + 1;
    tiers[e.tier]++;
    const target = pickTarget(e, run, rng);
    fireEvent(run, deck, e, { target, volunteer: null, cause: e.name }, rng);
    const liv = living(run).filter((m) => !m.ghost && m.id !== target);
    const volunteer = liv.length ? rng.pick(liv).id : null;
    const ctx = { target, volunteer, cause: e.name };
    const choice = botChoice(run, deck, e, rng, o.style);
    const r = resolveChoice(run, deck, e, choice, ctx, rng);
    if (r.hunt) run.food += rng.int(40, 160);
    if (r.chain) { const c = deck.events.find((x) => x.id === r.chain); if (c) play(c); }
  };
  let guard = 0;
  while (run.outcome === 'playing' && guard++ < (o.maxDays ?? 400)) {
    if (run.broken.length) { const part = run.broken[0]; if (run.items[part] > 0) { run.items[part]--; run.broken = []; run.limp = false; } else run.limp = true; }
    if (run.food < 40 && living(run).length) run.food += rng.int(30, 120); // a hunt when hungry
    const d = dayTick(run, deck, rng, true);
    if (d.event) play(d.event);
    if (d.arrived) {
      run.node++;
      if (d.arrived.kind === 'river') {
        const rv = riverAt(run, d.arrived, rng);
        const how = rv.depth > 3 && run.money >= (d.arrived.ferry ?? 5) ? 'ferry' : rv.depth > 2.5 ? 'caulk' : 'ford';
        if (how === 'ferry') run.money -= d.arrived.ferry ?? 5;
        if (rng.chance(riverRisk(rv, how))) { run.food = Math.max(0, run.food - rng.int(20, 120)); const v = living(run); if (v.length) { const m = rng.pick(v); m.health = Math.max(1, m.health - 20); } }
      }
      if (d.arrived.kind === 'fort') buyList(run, deck, [{ item: 'food', n: 3 }, { item: 'medicine', n: 1 }]);
      if (d.arrived.kind === 'end') { run.outcome = living(run).length ? 'won' : 'wiped'; break; }
    }
  }
  void route;
  const sc = score(run, deck);
  return { seed, outcome: run.outcome, days: run.day, miles: Math.round(run.miles), deaths: Object.values(run.party).filter((m) => !m.alive).length, living: living(run).length, events, score: sc.total, tiers };
}
