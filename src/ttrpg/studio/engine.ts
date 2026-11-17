// The host's game engine: the whole table (sheets, NPC stat blocks, log, roll requests, the SceneState.ttrpg table)
// and every rule change — dice rolls (crypto RNG), GM actions (validated again here against the real table: names,
// cells, stat blocks), initiative, damage / conditions, scenes and maps. No DOM, no network: the session
// (session.ts) wires it to the GM, the party and OBS; Node tests can drive it directly.
import { DEFAULT_GM_LOOK, DEFAULT_TTRPG_STATE, type GmLook, type SceneTtrpgState, type TtrpgInitEntry, type TtrpgRoll, type TtrpgToken } from '../../../shared/ttrpg/state.ts';
import { checkBonus, colorFor, sheetLine, type TtrpgCharacter, type TtrpgSystem } from '../../../shared/ttrpg/rules.ts';
import { cryptoDie, cryptoSeed, evalDice, parseDice, type DiceResult } from '../../../shared/ttrpg/dice.ts';
import { ARCHETYPES, MONSTERS, abilityMod, fmtMod } from '../../../shared/ttrpg/srd.ts';
import { buildMap, describeMap, isMapTemplate, walkable, type MapGrid } from '../../../shared/ttrpg/maps.ts';
import type { ContentRating, GmAction, GmContext } from '../../../shared/ttrpg/gm.ts';
import type { LogEntry, RollRequest } from '../../../shared/ttrpg/wire.ts';
import type { AdventureSeed } from '../../../shared/ttrpg/seeds.ts';

export interface GameNpc { tok: string; name: string; ac: number; hp: [number, number]; attacks: { name: string; hit: number; dmg: string }[]; dexMod: number; srd?: string; note?: string }
export interface VoicePrefs { voice: string; rate: number; pitch: number; provider: 'browser' | 'server'; hear: boolean }
/** A new game's GM voice settings (the Voice panel's ↺ defaults). */
export const DEFAULT_VOICE_PREFS: VoicePrefs = { voice: '', rate: 1, pitch: 0.9, provider: 'browser', hear: true };
export interface TtrpgGame {
  v: 1;
  id: string;
  title: string;
  env: string;
  room: string;
  system: TtrpgSystem;
  created: number;
  sessions: number;
  gm: { kind: 'ai' | 'human' | 'none'; who?: string; look: GmLook; persona: string };
  ai: { rating: ContentRating; lines: string[]; veils: string[]; approve: boolean; seedId: string; memory: string; facts: string[]; summarizedTo: number; language: string; auto: boolean };
  voice: VoicePrefs;
  chars: TtrpgCharacter[];
  npcs: GameNpc[];
  log: LogEntry[];
  requests: RollRequest[];
  table: SceneTtrpgState;
  feedback: string[];
  mapAspect: number;
}

const rid = (p = '') => `${p}${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`;

export function newGame(o: { env: string; room: string; system: TtrpgSystem; title?: string; mapAspect?: number; look?: GmLook; persona?: string; seedId?: string }): TtrpgGame {
  return {
    v: 1, id: `${(o.env || 'table').replace(/[^a-z0-9_-]/g, '').slice(0, 20) || 'table'}-${Date.now().toString(36)}`, title: o.title ?? 'A new adventure', env: o.env, room: o.room, system: o.system, created: Date.now(), sessions: 1,
    gm: { kind: 'ai', look: o.look ?? { ...DEFAULT_GM_LOOK }, persona: o.persona ?? '' },
    ai: { rating: 'pg13', lines: [], veils: [], approve: false, seedId: o.seedId ?? '', memory: '', facts: [], summarizedTo: 0, language: 'en', auto: true },
    voice: { ...DEFAULT_VOICE_PREFS },
    chars: [], npcs: [], log: [], requests: [], feedback: [], mapAspect: o.mapAspect ?? 16 / 9,
    table: { ...structuredClone(DEFAULT_TTRPG_STATE), on: true, system: o.system, title: o.title ?? '', from: o.env || undefined, gm: { kind: 'ai', look: o.look ?? { ...DEFAULT_GM_LOOK } } },
  };
}

// ---------------------------------------------------------------- log
export function log(g: TtrpgGame, kind: LogEntry['kind'], who: string, name: string, text: string): LogEntry {
  const e: LogEntry = { id: rid('l'), at: Date.now(), who, name, kind, text: text.slice(0, 1200) };
  g.log.push(e);
  if (g.log.length > 500) { const cut = g.log.length - 400; g.log.splice(0, cut); g.ai.summarizedTo = Math.max(0, g.ai.summarizedTo - cut); }
  return e;
}

// ---------------------------------------------------------------- names → things
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export interface Target { char?: TtrpgCharacter; tok?: TtrpgToken; npc?: GameNpc }
export function findTarget(g: TtrpgGame, name: string): Target | null {
  const n = norm(name);
  if (!n) return null;
  const toks = g.table.tokens;
  const exact = toks.find((t) => norm(t.name) === n) ?? null;
  const char = g.chars.find((c) => norm(c.name) === n || norm(c.name).split(' ')[0] === n) ?? null;
  const tok = exact ?? (char ? toks.find((t) => t.id === `pc-${char.id}`) : null) ?? toks.find((t) => norm(t.name).startsWith(n)) ?? null;
  const c = char ?? (tok?.kind === 'pc' ? g.chars.find((x) => `pc-${x.id}` === tok.id) ?? null : null);
  const npc = tok ? g.npcs.find((x) => x.tok === tok.id) ?? null : null;
  if (!c && !tok) return null;
  return { ...(c ? { char: c } : {}), ...(tok ? { tok } : {}), ...(npc ? { npc } : {}) };
}

// ---------------------------------------------------------------- map
const mapCache = { key: '', grid: null as MapGrid | null };
export function currentGrid(g: TtrpgGame): MapGrid | null {
  const m = g.table.map;
  if (!m || !isMapTemplate(m.tpl)) return null;
  const rows = m.rows ?? Math.round(m.grid / g.mapAspect);
  const key = `${m.tpl}|${m.seed}|${m.grid}|${rows}`;
  if (mapCache.key !== key) { mapCache.key = key; mapCache.grid = buildMap(m.tpl, m.seed, m.grid, rows); }
  return mapCache.grid;
}
function occupied(g: TtrpgGame, x: number, y: number, except?: string) { return g.table.tokens.some((t) => t.id !== except && Math.round(t.x) === x && Math.round(t.y) === y && !t.dead); }
/** Nearest free walkable cell to (x, y). */
export function freeCell(g: TtrpgGame, x: number, y: number, except?: string): [number, number] {
  const grid = currentGrid(g);
  const cols = g.table.map?.grid ?? 20, rows = g.table.map?.rows ?? Math.round(cols / g.mapAspect);
  const ok = (cx: number, cy: number) => cx >= 0 && cy >= 0 && cx < cols && cy < rows && (!grid || walkable(grid.cells[cy * grid.cols + cx])) && !occupied(g, cx, cy, except);
  const x0 = Math.round(Math.min(cols - 1, Math.max(0, x))), y0 = Math.round(Math.min(rows - 1, Math.max(0, y)));
  for (let r = 0; r < Math.max(cols, rows); r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    if (ok(x0 + dx, y0 + dy)) return [x0 + dx, y0 + dy];
  }
  return [x0, y0];
}

export function setScene(g: TtrpgGame, title: string, tpl: string, seed?: number, clear = true) {
  const t = g.table;
  const cols = Math.max(12, Math.min(30, Math.round(t.map?.grid ?? 20)));
  t.map = { tpl: isMapTemplate(tpl) || tpl === 'room' ? tpl : 'dungeon', seed: seed ?? (cryptoSeed() % 2 ** 31), title: title.slice(0, 60), grid: cols, rows: Math.max(6, Math.round(cols / Math.max(0.6, g.mapAspect))) };
  if (clear) {
    const drop = new Set(t.tokens.filter((x) => x.kind !== 'pc').map((x) => x.id));
    t.tokens = t.tokens.filter((x) => !drop.has(x.id));
    g.npcs = g.npcs.filter((n) => !drop.has(n.tok));
    t.init = { on: false, round: 1, turn: 0, order: [] };
  }
  placeParty(g);
}

/** Every character with an owner gets a mini at the map's party start. */
export function placeParty(g: TtrpgGame) {
  const grid = currentGrid(g);
  const starts = grid?.party ?? [];
  g.chars.forEach((c, i) => {
    const id = `pc-${c.id}`;
    let tok = g.table.tokens.find((x) => x.id === id);
    const want = starts[i] ?? [1 + i, 1];
    const [x, y] = freeCell(g, want[0], want[1], id);
    if (!tok) { tok = { id, name: c.name, kind: 'pc', ...(c.owner ? { owner: c.owner } : {}), x, y, color: c.color, icon: c.icon, hp: [c.hp[0], c.hp[1]] }; g.table.tokens.push(tok); }
    else { tok.x = x; tok.y = y; tok.name = c.name; tok.color = c.color; tok.icon = c.icon; tok.hp = [c.hp[0], c.hp[1]]; }
  });
}

/** Keep a PC's mini in step with its sheet (name, colour, HP). */
export function syncCharToken(g: TtrpgGame, c: TtrpgCharacter) {
  const tok = g.table.tokens.find((x) => x.id === `pc-${c.id}`);
  if (tok) { tok.name = c.name; tok.color = c.color; tok.icon = c.icon; tok.hp = [c.hp[0], c.hp[1]]; tok.dead = c.hp[0] <= 0 && c.conditions.includes('Dead'); }
  else if (g.table.map) placeParty(g);
}

// ---------------------------------------------------------------- dice
/** Throws never overlap on the table: each starts once the previous one has had time to land and be read (~2.8 s). */
export function nextThrowAt(g: TtrpgGame, delay = 350): number {
  const last = g.table.rolls.reduce((m, r) => (r.secret ? m : Math.max(m, r.at)), 0);
  return Math.max(Date.now() + delay, last + 2800);
}
export interface RollOut { roll: TtrpgRoll; result: DiceResult; line: string }
/** Roll on the host with crypto randomness; the throw is stamped on the table (every page throws it). */
export function roll(g: TtrpgGame, o: { who: string; name: string; expr: string; label: string; dc?: number; secret?: boolean; vars?: Record<string, number>; delay?: number }): RollOut {
  const e = parseDice(o.expr, o.vars ?? {});
  const result = evalDice(e, cryptoDie);
  const r: TtrpgRoll = { id: rid('r'), who: o.who, name: o.name.slice(0, 32), label: o.label.slice(0, 60), expr: e.text, dice: result.dice.slice(0, 40), mod: result.mod, total: result.total, crit: result.crit,
    at: o.secret ? Date.now() : nextThrowAt(g, o.delay ?? 350), seed: cryptoSeed(), ...(typeof o.dc === 'number' ? { dc: o.dc } : {}), ...(o.secret ? { secret: true } : {}) };
  g.table.rolls = [...g.table.rolls, r].slice(-8);
  const verdict = r.crit === 'hi' ? ' — NATURAL 20!' : r.crit === 'lo' ? ' — natural 1' : typeof o.dc === 'number' ? (r.total >= o.dc ? ` — success (DC ${o.dc})` : ` — fail (DC ${o.dc})`) : '';
  const line = `${o.name} rolls ${o.label || 'dice'}: ${e.text} → ${o.secret ? '(secret)' : result.detail}${o.secret ? '' : verdict}`;
  log(g, 'roll', o.who, o.name, line);
  return { roll: r, result, line };
}

/** Sheet variables for "d20+dex" style rolls. */
export function varsFor(c: TtrpgCharacter | undefined): Record<string, number> {
  if (!c) return {};
  const v: Record<string, number> = { prof: c.prof, level: c.level };
  for (const [k, s] of Object.entries(c.stats)) v[k.toLowerCase().replace(/[^a-z_]/g, '')] = c.system === '5e' ? abilityMod(s) : s;
  return v;
}

/** A GM roll request → the dice expression for that character. */
export function requestExpr(g: TtrpgGame, c: TtrpgCharacter | undefined, check?: string, rollExpr?: string, adv?: 'adv' | 'dis'): string {
  if (rollExpr) return rollExpr;
  const b = c && check ? checkBonus(c, check) : null;
  const bonus = b ? b.bonus : 0;
  return `d20${adv ? ` ${adv}` : ''}${bonus ? fmtMod(bonus) : ''}`;
}

export function addRequest(g: TtrpgGame, who: string, name: string, expr: string, label: string, dc?: number, secret?: boolean): RollRequest {
  const q: RollRequest = { id: rid('q'), who, name, expr, label, ...(typeof dc === 'number' ? { dc } : {}), ...(secret ? { secret: true } : {}), at: Date.now() };
  g.requests = [...g.requests.filter((x) => !(x.who === who && x.label === label)), q].slice(-12);
  return q;
}

// ---------------------------------------------------------------- combat
export function startCombat(g: TtrpgGame, only?: string[]): RollOut | null {
  const toks = g.table.tokens.filter((t) => !t.dead && t.kind !== 'object' && (!only?.length || only.some((n) => norm(t.name).startsWith(norm(n)))));
  if (!toks.length) return null;
  const order: TtrpgInitEntry[] = [];
  const dice: TtrpgRoll['dice'] = [];
  for (const t of toks) {
    const c = t.kind === 'pc' ? g.chars.find((x) => `pc-${x.id}` === t.id) : undefined;
    const npc = g.npcs.find((n) => n.tok === t.id);
    const mod = c ? checkBonus(c, 'init')?.bonus ?? 0 : npc?.dexMod ?? 0;
    const v = cryptoDie(20);
    dice.push({ s: 20, v });
    order.push({ id: `i-${t.id}`, name: t.name, init: v + mod, tok: t.id, kind: t.kind });
  }
  order.sort((a, b) => b.init - a.init || (a.kind === 'pc' ? -1 : 1));
  g.table.init = { on: true, round: 1, turn: 0, order };
  const r: TtrpgRoll = { id: rid('r'), who: 'gm', name: 'Initiative', label: 'Initiative', expr: `${dice.length}d20`, dice: dice.slice(0, 12), mod: 0, total: order[0]?.init ?? 0, crit: null, at: nextThrowAt(g), seed: cryptoSeed() };
  g.table.rolls = [...g.table.rolls, r].slice(-8);
  const line = `Initiative: ${order.map((o) => `${o.name} ${o.init}`).join(', ')}`;
  log(g, 'roll', 'gm', 'Initiative', line);
  return { roll: r, result: { dice: r.dice, mod: 0, total: r.total, crit: null, detail: line }, line };
}
export function nextTurn(g: TtrpgGame) {
  const it = g.table.init;
  if (!it.on || !it.order.length) return;
  for (let k = 0; k < it.order.length; k++) {
    it.turn++;
    if (it.turn >= it.order.length) { it.turn = 0; it.round++; }
    const tok = g.table.tokens.find((t) => t.id === it.order[it.turn].tok);
    if (!tok?.dead) break;
  }
}
export function endCombat(g: TtrpgGame) { g.table.init = { on: false, round: 1, turn: 0, order: [] }; }

// ---------------------------------------------------------------- HP
export function applyHp(g: TtrpgGame, t: Target, delta: number): string {
  if (t.char) {
    const c = t.char;
    if (delta < 0 && c.temp > 0) { const soak = Math.min(c.temp, -delta); c.temp -= soak; delta += soak; }
    c.hp[0] = Math.max(0, Math.min(c.hp[1], c.hp[0] + delta));
    if (c.hp[0] === 0 && !c.conditions.includes('Unconscious')) c.conditions.push('Unconscious');
    if (c.hp[0] > 0) c.conditions = c.conditions.filter((x) => x !== 'Unconscious');
    syncCharToken(g, c);
    return `${c.name}: ${c.hp[0]}/${c.hp[1]} HP${c.hp[0] === 0 ? ' (down!)' : ''}`;
  }
  if (t.tok) {
    const hp = t.tok.hp ?? (t.npc ? [t.npc.hp[0], t.npc.hp[1]] as [number, number] : null);
    if (!hp) return `${t.tok.name} has no HP`;
    hp[0] = Math.max(0, Math.min(hp[1], hp[0] + delta));
    t.tok.hp = hp;
    if (t.npc) t.npc.hp = [hp[0], hp[1]];
    t.tok.dead = hp[0] <= 0;
    return `${t.tok.name}: ${hp[0]}/${hp[1]} HP${t.tok.dead ? ' (defeated)' : ''}`;
  }
  return 'no target';
}

// ---------------------------------------------------------------- spawning
const MONSTER_COLORS = ['#7a9a3a', '#a8453a', '#6a5a8a', '#3a7a8a', '#8a6a3a'];
export function spawn(g: TtrpgGame, a: Extract<GmAction, { type: 'spawn_token' }>): string[] {
  const out: string[] = [];
  const srd = a.srd ? MONSTERS.find((m) => m.id === a.srd || norm(m.name) === norm(a.srd!)) ?? null : MONSTERS.find((m) => norm(m.name) === norm(a.name)) ?? null;
  const arch = !srd && a.srd ? ARCHETYPES.find((x) => x.id === a.srd) ?? null : null;
  const grid = currentGrid(g);
  const cols = g.table.map?.grid ?? 20, rows = g.table.map?.rows ?? Math.round(cols / g.mapAspect);
  let spots: [number, number][] = [];
  if (Array.isArray(a.at)) spots = [a.at as [number, number]];
  else if (a.at === 'west') spots = grid?.party ?? [[1, 1]];
  else if (a.at === 'center') spots = [[Math.floor(cols / 2), Math.floor(rows / 2)]];
  else if (a.at === 'north') spots = [[Math.floor(cols / 2), 1]];
  else if (a.at === 'south') spots = [[Math.floor(cols / 2), rows - 2]];
  else spots = grid?.foes ?? [[cols - 2, Math.floor(rows / 2)]];
  const base = a.name.replace(/\s+\d+$/, '').slice(0, 24);
  const existing = g.table.tokens.filter((t) => norm(t.name).startsWith(norm(base))).length;
  const color = a.color ?? (a.kind === 'npc' ? '#4f8fe0' : a.kind === 'object' ? '#8a6a45' : MONSTER_COLORS[g.table.tokens.length % MONSTER_COLORS.length]);
  for (let i = 0; i < a.count; i++) {
    if (g.table.tokens.length >= 40) { g.feedback.push('the map is full (40 tokens): remove some before spawning more'); break; }
    const name = a.count > 1 || existing ? `${base} ${existing + i + 1}` : base;
    const want = spots[i % spots.length] ?? [cols - 2, 1];
    const [x, y] = freeCell(g, want[0] + (spots.length === 1 ? i : 0), want[1]);
    const id = rid('t');
    const hp = a.hp ?? srd?.hp ?? arch?.hp;
    g.table.tokens.push({ id, name, kind: a.kind, x, y, color, icon: a.icon ?? (a.kind === 'monster' ? name.slice(0, 1).toUpperCase() : undefined), ...(hp ? { hp: [hp, hp] as [number, number] } : {}) });
    if (a.kind !== 'object') {
      g.npcs.push({ tok: id, name, ac: a.ac ?? srd?.ac ?? arch?.ac ?? 12, hp: [hp ?? 10, hp ?? 10],
        attacks: srd ? srd.attacks.map((x) => ({ name: x.name, hit: x.hit, dmg: x.dmg })) : arch ? [{ name: 'Attack', hit: arch.hit, dmg: arch.dmg }] : [],
        dexMod: srd ? abilityMod(srd.stats[1]) : 1, ...(srd ? { srd: srd.id } : {}), ...(arch ? { note: arch.note } : {}) });
    }
    out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------- apply one GM action
export interface ApplyOut { log: string[]; speak: { name: string; text: string; voice?: string }[]; npcRolls: RollOut[]; requests: RollRequest[]; initRoll: RollOut | null; cam?: { shot: string; who?: string } }
export function applyAction(g: TtrpgGame, a: GmAction): ApplyOut {
  const o: ApplyOut = { log: [], speak: [], npcRolls: [], requests: [], initRoll: null };
  const miss = (who: string) => g.feedback.push(`${a.type}: no "${who}" on the table (known: ${[...g.chars.map((c) => c.name), ...g.table.tokens.filter((t) => t.kind !== 'pc').map((t) => t.name)].slice(0, 16).join(', ') || 'nobody'})`);
  switch (a.type) {
    case 'request_roll': {
      const targets = /^(all|everyone|party|each)$/i.test(a.who) ? g.chars.filter((c) => c.owner) : [findTarget(g, a.who)?.char].filter((c): c is TtrpgCharacter => !!c);
      if (!targets.length) { miss(a.who); break; }
      for (const c of targets) {
        const expr = requestExpr(g, c, a.check, a.roll, a.adv);
        o.requests.push(addRequest(g, c.owner ?? '@host', c.name, expr, a.check ? `${a.check}${a.reason && a.reason !== a.check ? ` (${a.reason})` : ''}` : a.reason, a.dc, a.secret));
      }
      break;
    }
    case 'npc_roll': {
      const t = findTarget(g, a.who);
      const name = t?.tok?.name ?? t?.char?.name ?? a.who;
      let dc = a.dc;
      if (dc === undefined && a.vs) { const v = findTarget(g, a.vs); if (v?.char) dc = v.char.ac; else if (v?.npc) dc = v.npc.ac; }
      try { o.npcRolls.push(roll(g, { who: 'gm', name, expr: a.roll, label: `${a.label}${a.vs ? ` vs ${a.vs}` : ''}`, dc, delay: 600 })); }
      catch (e) { g.feedback.push(`npc_roll: ${(e as Error).message}`); }
      break;
    }
    case 'set_scene': setScene(g, a.title, a.map ?? g.table.map?.tpl ?? 'dungeon', a.seed, a.clear !== false); if (a.mood) g.table.mood = a.mood; o.log.push(`Scene: ${a.title}`); break;
    case 'spawn_token': { if (!g.table.map) setScene(g, g.table.title || 'The scene', 'dungeon'); const n = spawn(g, a); if (n.length) o.log.push(`Appears: ${n.join(', ')}`); break; }
    case 'move_token': {
      const t = findTarget(g, a.who);
      if (!t?.tok) { miss(a.who); break; }
      let to: [number, number];
      if (Array.isArray(a.to)) to = a.to as [number, number];
      else { const d = findTarget(g, a.to); if (!d?.tok) { miss(String(a.to)); break; } to = [d.tok.x + (t.tok.x < d.tok.x ? -1 : 1), d.tok.y]; }
      const [x, y] = freeCell(g, to[0], to[1], t.tok.id);
      t.tok.x = x; t.tok.y = y;
      break;
    }
    case 'remove_token': {
      const t = findTarget(g, a.who);
      if (!t?.tok) { miss(a.who); break; }
      if (t.tok.kind === 'pc') { g.feedback.push('remove_token: player characters stay on the map (use a condition instead)'); break; }
      g.table.tokens = g.table.tokens.filter((x) => x.id !== t.tok!.id);
      g.npcs = g.npcs.filter((n) => n.tok !== t.tok!.id);
      g.table.init.order = g.table.init.order.filter((e) => e.tok !== t.tok!.id);
      if (g.table.init.turn >= g.table.init.order.length) g.table.init.turn = 0;
      break;
    }
    case 'damage': case 'heal': {
      const t = findTarget(g, a.who);
      if (!t) { miss(a.who); break; }
      o.log.push(applyHp(g, t, a.type === 'damage' ? -a.amount : a.amount));
      break;
    }
    case 'condition': {
      const t = findTarget(g, a.who);
      if (!t) { miss(a.who); break; }
      if (t.char) {
        if (a.add && !t.char.conditions.includes(a.add)) t.char.conditions.push(a.add);
        if (a.remove) t.char.conditions = t.char.conditions.filter((x) => norm(x) !== norm(a.remove!));
      } else if (t.npc) t.npc.note = [t.npc.note, a.add].filter(Boolean).join('; ');
      break;
    }
    case 'start_combat': o.initRoll = startCombat(g, a.who); if (!o.initRoll) g.feedback.push('start_combat: nobody on the map to fight'); break;
    case 'next_turn': nextTurn(g); break;
    case 'end_combat': endCombat(g); break;
    case 'npc_say': o.speak.push({ name: a.name, text: a.text, voice: a.voice }); break;
    case 'show_handout': g.table.handout = { id: rid('h'), title: a.title, ...(a.text ? { text: a.text } : {}), style: a.style ?? 'parchment', at: Date.now() }; break;
    case 'mood_light': g.table.mood = a.mood; break;
    case 'camera': {
      const who = a.who ? findTarget(g, a.who)?.char?.owner : undefined;
      o.cam = { shot: a.shot, ...(who ? { who } : {}) };
      break;
    }
    case 'give_item': {
      const c = findTarget(g, a.who)?.char;
      if (!c) { miss(a.who); break; }
      if (a.take) { const i = c.inventory.findIndex((x) => norm(x) === norm(a.item)); if (i >= 0) c.inventory.splice(i, 1); }
      else c.inventory.push(a.item);
      o.log.push(`${c.name} ${a.take ? 'loses' : 'gets'} ${a.item}`);
      break;
    }
    case 'remember': g.ai.facts = [...g.ai.facts, a.fact].slice(-40); break;
    case 'award_luck': { const c = findTarget(g, a.who)?.char; if (!c) { miss(a.who); break; } c.luck = Math.max(0, Math.min(99, c.luck + a.amount)); o.log.push(`${c.name} gains ${a.amount} luck`); break; }
    case 'end_session': if (a.recap) g.ai.memory = `${g.ai.memory ? `${g.ai.memory} ` : ''}${a.recap}`.slice(-1600); o.log.push('The session ends.'); break;
  }
  return o;
}

// ---------------------------------------------------------------- the GM's view of the table
export function gmContext(g: TtrpgGame, o: { env: { id: string; name: string; theme: string }; seed: AdventureSeed | null; players: Map<string, string>; event: GmContext['event']; xcard: boolean; gmName: string }): GmContext {
  const grid = currentGrid(g);
  const recent = g.log.filter((e) => e.kind !== 'system').slice(-24).map((e) => ({ who: e.kind === 'gm' ? 'GM' : e.kind === 'npc' ? `${e.name} (NPC)` : e.kind === 'roll' ? '[dice]' : e.kind === 'ooc' ? `${e.name} [OOC]` : e.name, text: e.text }));
  const it = g.table.init;
  return {
    system: g.system, rating: g.ai.rating, lines: g.ai.lines, veils: g.ai.veils, gmName: o.gmName, persona: g.gm.persona, language: g.ai.language,
    env: o.env, seed: o.seed ? { title: o.seed.title, pitch: o.seed.pitch, hooks: o.seed.hooks, npcs: o.seed.npcs, places: o.seed.places, twist: o.seed.twist, tone: o.seed.tone, maps: o.seed.maps } : null,
    campaign: { title: g.title, memory: g.ai.memory, facts: g.ai.facts },
    party: g.chars.map((c) => { const tok = g.table.tokens.find((t) => t.id === `pc-${c.id}`); return { player: (c.owner && o.players.get(c.owner)) || 'a player', sheet: sheetLine(c), token: tok?.name, pos: tok ? [Math.round(tok.x), Math.round(tok.y)] as [number, number] : undefined }; }),
    npcs: g.table.tokens.filter((t) => t.kind !== 'pc').map((t) => { const n = g.npcs.find((x) => x.tok === t.id); return { name: t.name, kind: t.kind, hp: t.hp ? `${t.hp[0]}/${t.hp[1]}` : undefined, pos: [Math.round(t.x), Math.round(t.y)] as [number, number], stats: n ? `AC ${n.ac}${n.attacks.length ? `; ${n.attacks.map((a) => `${a.name} ${fmtMod(a.hit)} ${a.dmg}`).join(', ')}` : ''}${n.note ? `; ${n.note}` : ''}${t.dead ? '; DEFEATED' : ''}` : t.dead ? 'defeated' : undefined }; }),
    scene: { title: g.table.map?.title ?? '', map: g.table.map?.tpl ?? '', mapDesc: grid ? describeMap(grid) : '', mood: g.table.mood },
    combat: it.on ? { on: true, round: it.round, order: it.order.map((e) => `${e.name} (${e.init})`), turn: it.order[it.turn]?.name ?? '' } : null,
    recent, feedback: g.feedback.slice(-8), xcard: o.xcard, event: o.event,
  };
}

export { colorFor };
