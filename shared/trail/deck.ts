// The Trail — deck loading: overlay merge (a theme `extends` the neutral 'frontier' base deck and overrides text /
// numbers / adds events) + validation. Decks are content (assets/games/trail/<theme>/deck.json), read by the HOST only.
import { COND_IDS, ITEM_IDS, ROLE_IDS, TIERS, type Deck, type DeckChoice, type DeckEvent, type Effect } from './types.ts';

/** Text keys the engine reads from deck.text (all optional; English defaults below). */
export const DEFAULT_TEXT: Record<string, string> = {
  title: 'The Trail', subtitle: 'Can you make it to the end?', destinationVerb: 'reached',
  death: '{name} has died of {cause}.', wipe: 'Everyone has died.', win: 'You made it to {place}!',
  wagon: 'wagon', draft: 'oxen', draftOne: 'ox', hunt: 'Go hunting', huntTool: 'rifle', ammoUnit: 'bullets',
  riverCard: 'The river is {depth} feet deep and {width} feet across.{swift}', swift: ' The current is swift.',
  ford: 'Attempt to ford the river', caulk: 'Caulk the wagon and float it', ferry: 'Take the ferry ({cost})', wait: 'Wait a day', ask: 'Ask a local',
  storeName: 'General Store', shopkeeper: 'The shopkeeper', leaveStore: 'Hit the trail', forage: '{name} scrounged up {n} lbs of food.',
  camp: 'Make camp', rest: 'Rest', watch: 'Stand watch', stories: 'Tell stories', trade: 'Trade with strangers',
  ghost: 'ghost', revive: 'revived', swept: '{name} was swept away by the current!', tipped: 'The {wagon} tipped over!',
  shotMeat: 'You shot {shot} pounds of meat, but were only able to carry {carried} pounds back to the {wagon}.',
  bossTie: 'Tie! The Wagon Boss decides.', diceTie: 'Tie! Fate decides.',
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Deep merge for plain objects (arrays replace), used for text / roles / items / conds / palette. */
function merge<T>(a: T, b: unknown): T {
  if (!isObj(a) || !isObj(b)) return (b === undefined ? a : b) as T;
  const out: Obj = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
  return out as T;
}

/** Events merge by id; within an event, choices merge by id and outcomes by index (overlays usually only change text). */
function mergeEvent(a: DeckEvent, b: Partial<DeckEvent>): DeckEvent {
  const { choices: bc, ...rest } = b;
  const out = merge(a, rest) as DeckEvent;
  if (Array.isArray(bc)) {
    out.choices = a.choices.map((c) => {
      const o = bc.find((x) => x?.id === c.id) as Partial<DeckChoice> | undefined;
      if (!o) return c;
      const { outcomes: bo, ...cr } = o;
      const mc = merge(c, cr) as DeckChoice;
      if (Array.isArray(bo)) mc.outcomes = c.outcomes.map((oc, i) => (bo[i] ? merge(oc, bo[i]) : oc));
      return mc;
    });
    for (const x of bc) if (x?.id && !a.choices.some((c) => c.id === x.id) && Array.isArray(x.outcomes)) out.choices.push(x as DeckChoice);
  }
  return out;
}

/** `overlay` (a theme) on top of `base` (frontier). Overlay events with a new id are added; `"remove": true` drops one. */
export function mergeDeck(base: Deck, overlay: Partial<Deck> & { events?: (Partial<DeckEvent> & { id: string; remove?: boolean })[] }): Deck {
  const { events: oe, route, slice, epitaphs, memes, memes2, weather, biomes, animals, ...rest } = overlay;
  const out = merge(base, rest) as Deck;
  if (route) out.route = route;
  if (slice) out.slice = slice;
  if (epitaphs) out.epitaphs = epitaphs;
  if (memes) out.memes = memes;
  if (memes2) out.memes2 = memes2;
  if (weather) out.weather = weather;
  if (biomes) out.biomes = biomes;
  if (animals) out.animals = animals;
  if (Array.isArray(oe)) {
    const byId = new Map(out.events.map((e) => [e.id, e] as const));
    for (const e of oe) {
      if (!e || typeof e.id !== 'string') continue;
      if (e.remove) { byId.delete(e.id); continue; }
      const cur = byId.get(e.id);
      byId.set(e.id, cur ? mergeEvent(cur, e) : (e as DeckEvent));
    }
    out.events = [...byId.values()];
  }
  out.id = overlay.id ?? base.id;
  out.name = overlay.name ?? base.name;
  out.text = { ...DEFAULT_TEXT, ...out.text };
  return out;
}

const EFFECT_KEYS = new Set(['food', 'money', 'item', 'health', 'cond', 'cure', 'days', 'miles', 'draft', 'draftHealth', 'morale', 'break', 'repair', 'flag', 'mod', 'ghost', 'revive', 'swap', 'chain', 'rewind', 'rations', 'depth', 'hunt', 'meme', 'limp', 'rest']);

/** Problems in a deck (empty = fine). The host refuses a deck with problems and falls back to the base. */
export function validateDeck(d: Deck): string[] {
  const err: string[] = [];
  if (!d || typeof d !== 'object') return ['not an object'];
  if (!Array.isArray(d.route) || d.route.length < 2) err.push('route: needs ≥ 2 nodes');
  else {
    if (d.route[0].kind !== 'start') err.push('route[0] must be kind "start"');
    if (d.route[d.route.length - 1].kind !== 'end') err.push('last route node must be kind "end"');
    for (let i = 1; i < d.route.length; i++) if (!(d.route[i].miles > d.route[i - 1].miles)) err.push(`route[${i}] miles must increase`);
  }
  for (const r of ROLE_IDS) if (!d.roles?.[r]) err.push(`roles.${r} missing`);
  for (const c of COND_IDS) if (!d.conds?.[c]) err.push(`conds.${c} missing`);
  for (const i of [...ITEM_IDS, 'food', 'draft'] as const) if (!d.items?.[i]) err.push(`items.${i} missing`);
  const ids = new Set<string>();
  for (const e of d.events ?? []) {
    if (ids.has(e.id)) err.push(`event ${e.id}: duplicate id`);
    ids.add(e.id);
    if (!TIERS.includes(e.tier)) err.push(`event ${e.id}: bad tier ${e.tier}`);
    if (!e.choices?.length) err.push(`event ${e.id}: no choices`);
    for (const c of e.choices ?? []) {
      if (!c.outcomes?.length) err.push(`event ${e.id}.${c.id}: no outcomes`);
      for (const o of c.outcomes ?? []) for (const f of o.fx ?? []) if (!EFFECT_KEYS.has((f as Effect).k)) err.push(`event ${e.id}.${c.id}: unknown effect ${(f as Effect).k}`);
      if (c.stop && !c.outcomes.some((o) => o.on === 'success') ) err.push(`event ${e.id}.${c.id}: stop choice without an on:"success" outcome`);
    }
  }
  for (const e of d.events ?? []) for (const c of e.choices) for (const o of c.outcomes) for (const f of o.fx) if (f.k === 'chain' && !ids.has(f.id)) err.push(`event ${e.id}: chains to unknown ${f.id}`);
  if (!d.epitaphs?.length) err.push('epitaphs: none');
  return err;
}

/** Count events per tier (DESIGN §9 requires 30–40 per theme). */
export function tierCounts(d: Deck): Record<string, number> {
  const c: Record<string, number> = { mild: 0, hilarious: 0, hard: 0, insane: 0 };
  for (const e of d.events) c[e.tier]++;
  return c;
}
