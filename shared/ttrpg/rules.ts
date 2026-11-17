// Character sheets + the rules glue (system-agnostic core, a 5e-compatible preset on SRD 5.1 content only).
// Pure data + functions: the host studio, guests' panels, the server (GM prompt) and Node tests all use it.
import { ABILITIES, CLASSES, RACES, SKILLS, STANDARD_ARRAY, abilityMod, fmtMod, type Ability } from './srd.ts';
import { clean } from './state.ts';

export type TtrpgSystem = 'generic' | '5e';

export interface SheetAttack { name: string; hit: number; dmg: string; note?: string }
export interface TtrpgCharacter {
  id: string;
  /** Member key of the performer who plays it ('@host' / party id); absent = an NPC / unassigned sheet. */
  owner?: string;
  name: string;
  /** One line: "Half-Orc Barbarian 1", "Ex-scav medic", "Frog line cook". */
  concept: string;
  level: number;
  system: TtrpgSystem;
  hp: [number, number];
  temp: number;
  ac: number;
  speed: number;
  /** 5e: ability SCORES (str … cha). generic: named stats → modifiers ("Grit": 2). */
  stats: Record<string, number>;
  prof: number;
  saves: string[];
  /** Skill → total bonus (5e: computed at build time; generic: free-form). */
  skills: Record<string, number>;
  attacks: SheetAttack[];
  features: string[];
  inventory: string[];
  conditions: string[];
  notes: string;
  color: string;
  icon: string;
  /** Inspiration / hero points / luck — one counter every system has. */
  luck: number;
}

const COLORS = ['#e8615a', '#f2a541', '#f7d046', '#5cc98b', '#45b7d1', '#6c8cff', '#b07cf0', '#f07cc0', '#9fd356', '#ff8f6b', '#5ad6c4', '#c9c9c9'];
export const colorFor = (i: number) => COLORS[((i % COLORS.length) + COLORS.length) % COLORS.length];
const rid = () => Math.random().toString(36).slice(2, 10);

export function blankCharacter(system: TtrpgSystem, owner?: string, name = 'New hero'): TtrpgCharacter {
  return {
    id: `c${rid()}`, ...(owner ? { owner } : {}), name, concept: system === '5e' ? 'Adventurer 1' : 'Adventurer', level: 1, system,
    hp: [10, 10], temp: 0, ac: 12, speed: 30, stats: system === '5e' ? Object.fromEntries(ABILITIES.map((a) => [a, 10])) : { Might: 1, Grace: 1, Wits: 1, Heart: 1 },
    prof: 2, saves: [], skills: {}, attacks: [], features: [], inventory: [], conditions: [], notes: '', color: colorFor(0), icon: name.slice(0, 1).toUpperCase(), luck: 0,
  };
}

/** 5e quick build: race + class → standard array by the class's priorities, racial bonuses, HP, AC, skills, attacks. */
export function quickBuild5e(raceId: string, classId: string, name: string, owner?: string, flexPicks: Ability[] = []): TtrpgCharacter {
  const race = RACES.find((r) => r.id === raceId) ?? RACES[3];
  const cls = CLASSES.find((c) => c.id === classId) ?? CLASSES[4];
  const stats: Record<string, number> = {};
  cls.order.forEach((a, i) => { stats[a] = STANDARD_ARRAY[i]; });
  for (const [a, b] of Object.entries(race.bonus)) stats[a] += b!;
  if (race.flex) {
    const picks = (flexPicks.length ? flexPicks : cls.order).filter((a) => !(a in race.bonus)).slice(0, race.flex);
    for (const a of picks) stats[a] += 1;
  }
  const m = (a: Ability) => abilityMod(stats[a]);
  const prof = 2;
  const conHp = m('con') + (race.id === 'dwarf' ? 1 : 0);
  const hp = Math.max(1, cls.hd + conHp);
  const ar = cls.armor;
  const dex = ar.maxDex === null ? m('dex') : Math.min(ar.maxDex, m('dex'));
  const ac = ar.base + dex + (ar.unarmored ? m(ar.unarmored) : 0) + (ar.shield ? 2 : 0);
  const skills: Record<string, number> = {};
  for (const [s, a] of Object.entries(SKILLS)) skills[s] = m(a) + (cls.skills.includes(s) ? prof : 0);
  const attacks: SheetAttack[] = cls.attacks.map((at) => {
    const ab: Ability = at.ability === 'spell' ? cls.spell ?? 'int' : at.ability;
    const bonus = m(ab);
    return { name: at.name, hit: bonus + prof, dmg: at.ability === 'spell' ? at.dmg : `${at.dmg}${bonus ? fmtMod(bonus) : ''}`, ...(at.note ? { note: `${at.type}; ${at.note}` } : { note: at.type }) };
  });
  return {
    id: `c${rid()}`, ...(owner ? { owner } : {}), name: clean(name, 32) || 'Hero', concept: `${race.name} ${cls.name} 1`, level: 1, system: '5e',
    hp: [hp, hp], temp: 0, ac, speed: race.speed, stats, prof, saves: [...cls.saves], skills, attacks,
    features: [...cls.features, ...race.traits], inventory: ['Explorer’s pack', 'Rations (5 days)', 'Waterskin', '10 gp'], conditions: [], notes: '',
    color: colorFor(CLASSES.indexOf(cls)), icon: (clean(name, 32) || 'H').slice(0, 1).toUpperCase(), luck: 0,
  };
}

/** Bonus for a named check on this sheet: a skill, an ability ('dex', 'Dexterity'), a save ('dex save'), 'init'. */
export function checkBonus(c: TtrpgCharacter, what: string): { bonus: number; label: string } | null {
  const w = what.trim().toLowerCase();
  if (!w) return null;
  if (c.system === '5e') {
    if (w === 'init' || w === 'initiative') return { bonus: abilityMod(c.stats.dex ?? 10), label: 'Initiative' };
    const save = /^(str|dex|con|int|wis|cha)[a-z]*\s*(save|saving throw|st)$/.exec(w);
    if (save) { const a = save[1] as Ability; return { bonus: abilityMod(c.stats[a] ?? 10) + (c.saves.includes(a) ? c.prof : 0), label: `${a.toUpperCase()} save` }; }
    const ab = ABILITIES.find((a) => w === a || w.startsWith(a) && w.length > 3 && ({ str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma' } as Record<string, string>)[a].startsWith(w));
    if (ab) return { bonus: abilityMod(c.stats[ab] ?? 10), label: ab.toUpperCase() };
  }
  const sk = Object.keys(c.skills).find((s) => s.toLowerCase() === w) ?? Object.keys(c.skills).find((s) => s.toLowerCase().startsWith(w));
  if (sk) return { bonus: c.skills[sk], label: sk };
  const st = Object.keys(c.stats).find((s) => s.toLowerCase() === w);
  if (st) return { bonus: c.system === '5e' ? abilityMod(c.stats[st]) : c.stats[st], label: st };
  if (c.system === '5e') { const sk5 = Object.keys(SKILLS).find((s) => s.toLowerCase().startsWith(w)); if (sk5) return { bonus: abilityMod(c.stats[SKILLS[sk5]] ?? 10), label: sk5 }; }
  return null;
}

/** Compact one-liner for the GM prompt / panels. */
export function sheetLine(c: TtrpgCharacter): string {
  const st = c.system === '5e' ? ABILITIES.map((a) => `${a.toUpperCase()} ${c.stats[a] ?? 10}(${fmtMod(abilityMod(c.stats[a] ?? 10))})`).join(' ')
    : Object.entries(c.stats).map(([k, v]) => `${k} ${fmtMod(v)}`).join(' ');
  const atk = c.attacks.slice(0, 3).map((a) => `${a.name} ${fmtMod(a.hit)} ${a.dmg}`).join('; ');
  const top = Object.entries(c.skills).filter(([, v]) => v >= 3).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${fmtMod(v)}`).join(', ');
  return `${c.name} (${c.concept}) HP ${c.hp[0]}/${c.hp[1]}${c.temp ? `+${c.temp}` : ''} AC ${c.ac} | ${st}${top ? ` | best: ${top}` : ''}${atk ? ` | attacks: ${atk}` : ''}${c.conditions.length ? ` | conditions: ${c.conditions.join(', ')}` : ''}`;
}

// ---------------------------------------------------------------- sanitising + imports
const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : d);
const strs = (v: unknown, max: number, len: number) => (Array.isArray(v) ? v.map((x) => clean(x, len)).filter(Boolean).slice(0, max) : []);

export function sanitizeCharacter(o: unknown): TtrpgCharacter | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  const system: TtrpgSystem = x.system === 'generic' ? 'generic' : '5e';
  const stats: Record<string, number> = {};
  if (x.stats && typeof x.stats === 'object') for (const [k, v] of Object.entries(x.stats as Record<string, unknown>).slice(0, 12)) { const kk = clean(k, 20); if (kk) stats[kk] = n(v, -10, 40, 0); }
  const skills: Record<string, number> = {};
  if (x.skills && typeof x.skills === 'object') for (const [k, v] of Object.entries(x.skills as Record<string, unknown>).slice(0, 40)) { const kk = clean(k, 24); if (kk) skills[kk] = n(v, -10, 30, 0); }
  const hp = Array.isArray(x.hp) ? [n(x.hp[0], -99, 9999, 10), n(x.hp[1], 1, 9999, 10)] as [number, number] : [10, 10] as [number, number];
  const attacks: SheetAttack[] = (Array.isArray(x.attacks) ? x.attacks : []).slice(0, 12).flatMap((a) => {
    if (!a || typeof a !== 'object') return [];
    const r = a as Record<string, unknown>;
    const name = clean(r.name, 32); if (!name) return [];
    return [{ name, hit: n(r.hit, -10, 30, 0), dmg: clean(r.dmg, 24) || '1d6', ...(clean(r.note, 60) ? { note: clean(r.note, 60) } : {}) }];
  });
  return {
    id: typeof x.id === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(x.id) ? x.id : `c${rid()}`,
    ...(typeof x.owner === 'string' && /^(@host|[a-z0-9]{6,32})$/.test(x.owner) ? { owner: x.owner } : {}),
    name: clean(x.name, 32) || 'Hero', concept: clean(x.concept, 60), level: n(x.level, 1, 30, 1), system, hp, temp: n(x.temp, 0, 999, 0),
    ac: n(x.ac, 0, 40, 10), speed: n(x.speed, 0, 200, 30), stats, prof: n(x.prof, 0, 10, 2), saves: strs(x.saves, 6, 8), skills, attacks,
    features: strs(x.features, 30, 80), inventory: strs(x.inventory, 60, 60), conditions: strs(x.conditions, 12, 24), notes: clean(x.notes, 2000),
    color: typeof x.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(x.color) ? x.color : colorFor(0), icon: clean(x.icon, 2) || (clean(x.name, 32) || 'H').slice(0, 1).toUpperCase(),
    luck: n(x.luck, 0, 99, 0),
  };
}

/** Import a sheet from JSON: VTube Pro's own format, a Foundry VTT dnd5e Actor export (Actor → Export Data), or a
 *  generic { name, hp, ac, stats } blob. Returns null with `why` when it isn't recognised. */
export function importCharacter(json: unknown, owner?: string): { c: TtrpgCharacter | null; why: string; from: string } {
  if (!json || typeof json !== 'object') return { c: null, why: 'Not a JSON object', from: '' };
  const x = json as Record<string, unknown>;
  if (x.vtpTtrpg === 1 && x.character) { const c = sanitizeCharacter(x.character); return { c: c && owner ? { ...c, owner } : c, why: c ? '' : 'Broken sheet', from: 'VTube Pro' }; }
  const sys = x.system as Record<string, unknown> | undefined;
  if (typeof x.name === 'string' && sys && typeof sys === 'object' && sys.abilities && typeof sys.abilities === 'object') return { c: fromFoundry5e(x, owner), why: '', from: 'Foundry VTT (dnd5e)' };
  if (typeof x.name === 'string' && (x.stats || x.hp || x.ac)) {
    const c = sanitizeCharacter({ ...x, owner });
    return { c, why: c ? '' : 'Unreadable', from: 'generic JSON' };
  }
  return { c: null, why: 'Unknown sheet format (VTube Pro, Foundry dnd5e actor or {name, hp, ac, stats} JSON)', from: '' };
}

function fromFoundry5e(x: Record<string, unknown>, owner?: string): TtrpgCharacter {
  const sys = x.system as Record<string, any>;
  const stats: Record<string, number> = {};
  for (const a of ABILITIES) stats[a] = n(sys.abilities?.[a]?.value, 1, 30, 10);
  const lvl = n(sys.details?.level ?? (Array.isArray(x.items) ? (x.items as any[]).filter((i) => i?.type === 'class').reduce((s, i) => s + (Number(i?.system?.levels) || 0), 0) : 1), 1, 30, 1);
  const prof = n(sys.attributes?.prof, 1, 10, Math.ceil(lvl / 4) + 1);
  const saves = ABILITIES.filter((a) => Number(sys.abilities?.[a]?.proficient) > 0);
  const FS: Record<string, string> = { acr: 'Acrobatics', ani: 'Animal Handling', arc: 'Arcana', ath: 'Athletics', dec: 'Deception', his: 'History', ins: 'Insight', itm: 'Intimidation',
    inv: 'Investigation', med: 'Medicine', nat: 'Nature', prc: 'Perception', prf: 'Performance', per: 'Persuasion', rel: 'Religion', slt: 'Sleight of Hand', ste: 'Stealth', sur: 'Survival' };
  const skills: Record<string, number> = {};
  for (const [k, nm] of Object.entries(FS)) {
    const s = sys.skills?.[k];
    const ab = (s?.ability as Ability) ?? SKILLS[nm];
    const pv = Number(s?.value ?? s?.proficient ?? 0);
    skills[nm] = abilityMod(stats[ab] ?? 10) + Math.floor(pv * prof);
  }
  const items = Array.isArray(x.items) ? (x.items as any[]) : [];
  const attacks: SheetAttack[] = items.filter((i) => i?.type === 'weapon').slice(0, 6).map((i) => {
    const ab: Ability = i.system?.ability && ABILITIES.includes(i.system.ability) ? i.system.ability : (i.system?.properties?.fin || i.system?.properties?.includes?.('fin')) ? (stats.dex >= stats.str ? 'dex' : 'str') : 'str';
    const parts = i.system?.damage?.parts?.[0];
    const base = Array.isArray(parts) ? String(parts[0]).replace(/@mod/g, '').replace(/\s+/g, '').replace(/\+$/, '') : i.system?.damage?.base ? `${i.system.damage.base.number ?? 1}d${i.system.damage.base.denomination ?? 6}` : '1d6';
    const mod = abilityMod(stats[ab]);
    return { name: clean(i.name, 32) || 'Weapon', hit: mod + prof, dmg: `${base}${mod ? fmtMod(mod) : ''}` };
  });
  const cls = items.filter((i) => i?.type === 'class').map((i) => `${clean(i.name, 20)} ${i.system?.levels ?? ''}`.trim()).join(' / ');
  const race = typeof sys.details?.race === 'string' ? sys.details.race : items.find((i) => i?.type === 'race')?.name ?? '';
  return {
    id: `c${rid()}`, ...(owner ? { owner } : {}), name: clean(x.name, 32) || 'Hero', concept: clean(`${race} ${cls}`.trim(), 60) || 'Adventurer', level: lvl, system: '5e',
    hp: [n(sys.attributes?.hp?.value, -99, 9999, 10), n(sys.attributes?.hp?.max, 1, 9999, 10)], temp: n(sys.attributes?.hp?.temp, 0, 999, 0),
    ac: n(sys.attributes?.ac?.value ?? sys.attributes?.ac?.flat, 0, 40, 10 + abilityMod(stats.dex)), speed: n(sys.attributes?.movement?.walk, 0, 200, 30),
    stats, prof, saves, skills, attacks, features: items.filter((i) => i?.type === 'feat').slice(0, 20).map((i) => clean(i.name, 60)),
    inventory: items.filter((i) => ['equipment', 'consumable', 'loot', 'tool', 'container'].includes(i?.type)).slice(0, 40).map((i) => clean(i.name, 40)),
    conditions: [], notes: '', color: colorFor(lvl), icon: (clean(x.name, 32) || 'H').slice(0, 1).toUpperCase(), luck: 0,
  };
}

export function exportCharacter(c: TtrpgCharacter) { return { vtpTtrpg: 1, character: c }; }
