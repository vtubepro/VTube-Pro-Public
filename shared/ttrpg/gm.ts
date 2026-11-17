// The AI Game Master protocol, shared by the server (prompt + stream parsing + schema validation) and the host studio
// (applying the validated actions to the table). Model-neutral on purpose: every model on this PC (a local llama.cpp /
// Ollama / LM Studio / KoboldCpp model) answers in the same plain-text shape:
//
//   <narration, spoken aloud>
//   [[ACTIONS]]
//   [ {"type": "request_roll", ...}, ... ]
//
// Narration streams to TTS + captions while it arrives; the JSON after the marker is parsed leniently (fences, trailing
// commas, smart quotes, unquoted keys, a cut-off array — each object is parsed on its own so one broken action never
// sinks the others), normalised (type aliases, clamped numbers) and validated. Anything dropped is reported back to the
// model on its next turn as engine feedback, so it corrects itself.
import { clean } from './state.ts';
import { TTRPG_MOODS, type TtrpgMood } from './state.ts';
import { MAP_TEMPLATES } from './maps.ts';

export type ContentRating = 'family' | 'pg13' | 'mature';
export const RATINGS: { id: ContentRating; name: string; rule: string }[] = [
  { id: 'family', name: 'Family', rule: 'All ages. No gore, no swearing, no romance beyond friendship; peril is exciting but never graphic; defeated foes flee, surrender or are knocked out; no real-world drugs or alcohol.' },
  { id: 'pg13', name: 'PG-13', rule: 'Teen. Action violence without gore, mild language, spooky but not graphic horror; no sexual content; drugs and alcohol only as background colour.' },
  { id: 'mature', name: 'Mature', rule: 'Adult stream. Darker themes, strong language and bloody violence are allowed when the story calls for it, but never sexual content, never cruelty for its own sake.' },
];

export const GM_ACTIONS = ['request_roll', 'npc_roll', 'set_scene', 'spawn_token', 'move_token', 'remove_token', 'damage', 'heal', 'condition', 'start_combat', 'next_turn',
  'end_combat', 'npc_say', 'show_handout', 'mood_light', 'camera', 'give_item', 'remember', 'award_luck', 'end_session'] as const;
export type GmActionType = (typeof GM_ACTIONS)[number];

export type GmAction =
  | { type: 'request_roll'; who: string; check?: string; roll?: string; dc?: number; adv?: 'adv' | 'dis'; reason: string; secret?: boolean }
  | { type: 'npc_roll'; who: string; roll: string; label: string; vs?: string; dc?: number }
  | { type: 'set_scene'; title: string; map?: string; seed?: number; mood?: TtrpgMood; clear?: boolean }
  | { type: 'spawn_token'; name: string; count: number; kind: 'monster' | 'npc' | 'object'; srd?: string; at?: [number, number] | 'east' | 'west' | 'north' | 'south' | 'center'; hp?: number; ac?: number; icon?: string; color?: string }
  | { type: 'move_token'; who: string; to: [number, number] | string }
  | { type: 'remove_token'; who: string }
  | { type: 'damage'; who: string; amount: number; kind?: string }
  | { type: 'heal'; who: string; amount: number }
  | { type: 'condition'; who: string; add?: string; remove?: string }
  | { type: 'start_combat'; who?: string[] }
  | { type: 'next_turn' }
  | { type: 'end_combat' }
  | { type: 'npc_say'; name: string; text: string; voice?: 'low' | 'high' | 'rough' | 'soft' }
  | { type: 'show_handout'; title: string; text: string; style?: 'parchment' | 'note' | 'dossier' | 'wanted' | 'screen' }
  | { type: 'mood_light'; mood: TtrpgMood }
  | { type: 'camera'; shot: 'wide' | 'map' | 'gm' | 'dice' | 'seat' | 'handout'; who?: string }
  | { type: 'give_item'; who: string; item: string; take?: boolean }
  | { type: 'remember'; fact: string }
  | { type: 'award_luck'; who: string; amount: number }
  | { type: 'end_session'; recap: string };

const ALIASES: Record<string, GmActionType> = {
  requestroll: 'request_roll', roll_request: 'request_roll', ask_roll: 'request_roll', check: 'request_roll', skill_check: 'request_roll', saving_throw: 'request_roll',
  npcroll: 'npc_roll', monster_roll: 'npc_roll', attack: 'npc_roll', enemy_roll: 'npc_roll', gm_roll: 'npc_roll',
  setscene: 'set_scene', scene: 'set_scene', change_scene: 'set_scene', new_scene: 'set_scene', map: 'set_scene',
  spawn: 'spawn_token', spawntoken: 'spawn_token', add_token: 'spawn_token', spawn_monster: 'spawn_token', add_npc: 'spawn_token', spawn_npc: 'spawn_token',
  move: 'move_token', movetoken: 'move_token', remove: 'remove_token', removetoken: 'remove_token', despawn: 'remove_token', kill: 'remove_token',
  hurt: 'damage', deal_damage: 'damage', apply_damage: 'damage', healing: 'heal', add_condition: 'condition', set_condition: 'condition', remove_condition: 'condition',
  combat: 'start_combat', startcombat: 'start_combat', roll_initiative: 'start_combat', initiative: 'start_combat', nextturn: 'next_turn', end_turn: 'next_turn', endcombat: 'end_combat',
  say: 'npc_say', npcsay: 'npc_say', dialogue: 'npc_say', speak: 'npc_say', handout: 'show_handout', showhandout: 'show_handout', mood: 'mood_light', moodlight: 'mood_light', lights: 'mood_light',
  cam: 'camera', shot: 'camera', give: 'give_item', item: 'give_item', loot: 'give_item', take_item: 'give_item', note: 'remember', memory: 'remember', inspiration: 'award_luck', luck: 'award_luck',
  end: 'end_session', endsession: 'end_session',
};

// ---------------------------------------------------------------- output parsing
export const ACTION_MARK = '[[ACTIONS]]';

/** Streaming splitter: feed raw model text, get the narration part as it becomes safe to show (never the marker or
 *  anything after it). A JSON-only answer ({"narration": …}) is handled by finish(). */
export class NarrationSplitter {
  private buf = '';
  private shown = 0;
  private cut = -1;
  push(chunk: string): string {
    this.buf += chunk;
    if (this.cut >= 0) return '';
    const m = markerIndex(this.buf);
    if (m >= 0) { this.cut = m; const out = this.buf.slice(this.shown, m); this.shown = m; return stripTrailingFence(out); }
    // hold back anything that could be the start of the marker / a fence / a JSON-only answer
    let safe = this.buf.length;
    const tail = this.buf.slice(-16);
    for (let i = 0; i < tail.length; i++) {
      const t = tail.slice(i);
      if (ACTION_MARK.startsWith(t.toUpperCase().replace(/\s/g, '')) || '```'.startsWith(t) || /^\[\[?a?c?t?i?o?n?s?\]?\]?$/i.test(t) || /^`{1,3}(j(s(o(n)?)?)?)?$/i.test(t)) { safe = this.buf.length - t.length; break; }
    }
    if (this.buf.trimStart().startsWith('{')) safe = Math.min(safe, this.shown);   // JSON-only answers are resolved at the end
    const out = this.buf.slice(this.shown, safe);
    this.shown = Math.max(this.shown, safe);
    return out;
  }
  get text() { return this.buf; }
}
function markerIndex(s: string): number {
  const re = /\[\[\s*actions\s*\]\]|^\s*actions\s*:\s*$|```json|<actions>/im;
  const m = re.exec(s);
  return m ? m.index : -1;
}
const stripTrailingFence = (s: string) => s.replace(/`{1,3}\s*$/, '');

export interface ParsedTurn { narration: string; actions: GmAction[]; dropped: string[]; raw: unknown[] }

/** Split a finished answer into narration + validated actions. Never throws. */
export function parseGmOutput(text: string): ParsedTurn {
  const dropped: string[] = [];
  let narration = text, json = '';
  const m = markerIndex(text);
  if (m >= 0) { narration = text.slice(0, m); json = text.slice(m).replace(/^\[\[\s*actions\s*\]\]|^```json|^<actions>|^\s*actions\s*:/i, ''); }
  else {
    const t = text.trim();
    if (t.startsWith('{') || t.startsWith('```')) {
      // JSON-only answer: {"narration": "...", "actions": [...]}
      const obj = lenientObject(t.replace(/^```(json)?/i, '').replace(/```\s*$/, ''));
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const o = obj as Record<string, unknown>;
        narration = typeof o.narration === 'string' ? o.narration : typeof o.text === 'string' ? o.text : '';
        json = Array.isArray(o.actions) ? JSON.stringify(o.actions) : '';
      }
    } else {
      // a trailing bare JSON array after the prose
      const i = t.lastIndexOf('\n[');
      if (i > 0 && /\]\s*$/.test(t)) { narration = t.slice(0, i); json = t.slice(i); }
    }
  }
  narration = tidyNarration(narration);
  const info: { cut?: boolean } = {};
  const raw = extractObjects(json, info);
  if (info.cut) dropped.push('your last action was cut off (keep the actions short and close the JSON array)');
  if (json.trim() && !raw.length && /[{]/.test(json)) dropped.push('the actions block was not valid JSON (use a JSON array of objects after [[ACTIONS]])');
  const actions: GmAction[] = [];
  for (const r of raw.slice(0, 24)) {
    const v = validateAction(r);
    if (typeof v === 'string') dropped.push(v); else actions.push(v);
  }
  if (raw.length > 24) dropped.push(`only 24 actions per turn (${raw.length - 24} ignored)`);
  return { narration, actions, dropped, raw };
}

export function tidyNarration(s: string): string {
  return s.replace(/```[\s\S]*?```/g, '').replace(/^\s*(narration|gm|dm)\s*:\s*/i, '').replace(/\*\*/g, '').replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|[.,!?]|$)/g, '$1$2').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
}

/** Every top-level {...} in a (possibly broken / truncated) JSON array, each parsed on its own. */
export function extractObjects(s: string, info: { cut?: boolean } = {}): unknown[] {
  const out: unknown[] = [];
  let depth = 0, start = -1, inStr = false, esc = false, q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) inStr = false; continue; }
    if (c === '"' || (c === "'" && depth > 0)) { inStr = true; q = c; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') { if (depth > 0) depth--; if (depth === 0 && start >= 0) { const o = lenientObject(s.slice(start, i + 1)); if (o && typeof o === 'object') out.push(o); start = -1; } }
  }
  if (depth > 0) info.cut = true;
  return out;
}

/** JSON.parse with the usual model mistakes repaired. */
export function lenientObject(s: string): unknown {
  const tries = [s, repair(s)];
  for (const t of tries) { try { return JSON.parse(t); } catch { /* next */ } }
  return null;
}
function repair(s: string): string {
  return s
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"').replace(/[\u2018\u2019]/g, "'")
    .replace(/\/\/[^\n"]*$/gm, '')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/'([^'"\\]*)'/g, '"$1"')
    .replace(/:\s*(True|False|None)\b/g, (_m, v: string) => `: ${v === 'True' ? 'true' : v === 'False' ? 'false' : 'null'}`);
}

// ---------------------------------------------------------------- schema validation (referential checks happen when the host applies them)
const str = (v: unknown, max: number) => clean(v, max);
const num = (v: unknown, lo: number, hi: number): number | null => { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? Math.round(Math.min(hi, Math.max(lo, n))) : null; };
const ROLL = /^[0-9dkhlDKHL%+\-\s]{1,40}$|^\s*d20\s*(adv|dis)\s*([+-]\s*\d+)?\s*$/i;
const point = (v: unknown): [number, number] | null => {
  if (Array.isArray(v) && v.length >= 2) { const x = num(v[0], 0, 99), y = num(v[1], 0, 99); return x === null || y === null ? null : [x, y]; }
  if (v && typeof v === 'object') { const o = v as Record<string, unknown>; const x = num(o.x, 0, 99), y = num(o.y, 0, 99); return x === null || y === null ? null : [x, y]; }
  return null;
};

export function actionType(v: unknown): GmActionType | null {
  if (typeof v !== 'string') return null;
  const k = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if ((GM_ACTIONS as readonly string[]).includes(k)) return k as GmActionType;
  return ALIASES[k] ?? ALIASES[k.replace(/_/g, '')] ?? null;
}

/** A normalised action, or a string saying why it was dropped (sent back to the model). */
export function validateAction(o: unknown): GmAction | string {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'an action was not an object';
  const x = o as Record<string, unknown>;
  const t = actionType(x.type ?? x.action ?? x.name);
  if (!t) return `unknown action type "${String(x.type ?? x.action ?? '?').slice(0, 24)}" (allowed: ${GM_ACTIONS.join(', ')})`;
  const who = str(x.who ?? x.target ?? x.character ?? x.player ?? x.token, 40);
  const need = (cond: boolean, why: string) => (cond ? null : `${t}: ${why}`);
  switch (t) {
    case 'request_roll': {
      const check = str(x.check ?? x.skill ?? x.ability ?? x.save, 32), roll = str(x.roll ?? x.dice ?? x.expr, 40);
      const e = need(!!who, 'needs "who" (a player character name or "all")') ?? need(!!check || (!!roll && ROLL.test(roll)), 'needs "check" (e.g. "Stealth") or a dice "roll" (e.g. "d20+3")');
      if (e) return e;
      const adv = x.adv === true || x.advantage === true || x.adv === 'adv' ? 'adv' : x.adv === 'dis' || x.disadvantage === true ? 'dis' : undefined;
      const dc = num(x.dc ?? x.difficulty, 1, 40);
      return { type: t, who, ...(check ? { check } : {}), ...(roll && ROLL.test(roll) ? { roll } : {}), ...(dc !== null ? { dc } : {}), ...(adv ? { adv } : {}), reason: str(x.reason ?? x.why ?? x.label, 80) || check || 'a roll', ...(x.secret === true ? { secret: true } : {}) };
    }
    case 'npc_roll': {
      const roll = str(x.roll ?? x.dice ?? x.expr, 40);
      const e = need(!!who, 'needs "who" (the NPC / monster token)') ?? need(!!roll && ROLL.test(roll), 'needs a dice "roll" like "d20+4"');
      if (e) return e;
      const dc = num(x.dc ?? x.ac, 1, 40);
      return { type: t, who, roll, label: str(x.label ?? x.reason ?? x.attack, 60) || 'roll', ...(str(x.vs ?? x.against, 40) ? { vs: str(x.vs ?? x.against, 40) } : {}), ...(dc !== null ? { dc } : {}) };
    }
    case 'set_scene': {
      const title = str(x.title ?? x.name ?? x.location, 60);
      if (!title) return 'set_scene: needs a "title"';
      const map = str(x.map ?? x.template, 20).toLowerCase();
      const mood = TTRPG_MOODS.find((m) => m === str(x.mood, 12).toLowerCase());
      const seed = num(x.seed, 0, 2 ** 31);
      return { type: t, title, ...(map && MAP_TEMPLATES.some((m) => m.id === map) ? { map } : {}), ...(seed !== null ? { seed } : {}), ...(mood ? { mood } : {}), ...(x.clear === false ? { clear: false } : {}) };
    }
    case 'spawn_token': {
      const name = str(x.name ?? who, 28);
      if (!name) return 'spawn_token: needs a "name"';
      const kind = x.kind === 'npc' || x.kind === 'object' ? x.kind : 'monster';
      const at = point(x.at ?? x.pos ?? x.position) ?? (['east', 'west', 'north', 'south', 'center'].includes(String(x.at)) ? x.at as 'east' : undefined);
      const hp = num(x.hp, 1, 999), ac = num(x.ac, 1, 30);
      return { type: t, name, count: num(x.count ?? x.n, 1, 8) ?? 1, kind, ...(str(x.srd ?? x.stat ?? x.statblock, 24) ? { srd: str(x.srd ?? x.stat ?? x.statblock, 24).toLowerCase().replace(/\s+/g, '_') } : {}),
        ...(at ? { at } : {}), ...(hp !== null ? { hp } : {}), ...(ac !== null ? { ac } : {}), ...(str(x.icon, 2) ? { icon: str(x.icon, 2) } : {}),
        ...(typeof x.color === 'string' && /^#[0-9a-f]{6}$/i.test(x.color) ? { color: x.color } : {}) };
    }
    case 'move_token': {
      const to = point(x.to ?? x.at ?? x.pos) ?? (str(x.to, 40) || null);
      return need(!!who, 'needs "who"') ?? need(!!to, 'needs "to" ([x, y] cell or a token name to move next to)') ?? { type: t, who, to: to! };
    }
    case 'remove_token': return need(!!who, 'needs "who"') ?? { type: t, who };
    case 'damage': case 'heal': {
      const amount = num(x.amount ?? x.hp ?? x.value, 0, 999);
      return need(!!who, 'needs "who"') ?? need(amount !== null, 'needs a numeric "amount"') ?? (t === 'damage' ? { type: t, who, amount: amount!, ...(str(x.kind ?? x.damage_type, 16) ? { kind: str(x.kind ?? x.damage_type, 16) } : {}) } : { type: t, who, amount: amount! });
    }
    case 'condition': {
      const add = str(x.add ?? x.condition, 24), rem = str(x.remove, 24);
      return need(!!who, 'needs "who"') ?? need(!!add || !!rem, 'needs "add" or "remove"') ?? { type: t, who, ...(add ? { add } : {}), ...(rem ? { remove: rem } : {}) };
    }
    case 'start_combat': return { type: t, ...(Array.isArray(x.who) ? { who: x.who.map((w) => str(w, 40)).filter(Boolean).slice(0, 20) } : {}) };
    case 'next_turn': case 'end_combat': return { type: t };
    case 'npc_say': {
      const name = str(x.name ?? who ?? x.npc, 32), text = str(x.text ?? x.line ?? x.says, 400);
      const v = ['low', 'high', 'rough', 'soft'].includes(String(x.voice)) ? x.voice as 'low' : undefined;
      return need(!!name && !!text, 'needs "name" and "text"') ?? { type: t, name, text, ...(v ? { voice: v } : {}) };
    }
    case 'show_handout': {
      const title = str(x.title, 60), text = str(x.text ?? x.body ?? x.content, 1200);
      const style = ['parchment', 'note', 'dossier', 'wanted', 'screen'].includes(String(x.style)) ? x.style as 'note' : undefined;
      return need(!!title || !!text, 'needs "title" and "text"') ?? { type: t, title: title || 'Handout', text, ...(style ? { style } : {}) };
    }
    case 'mood_light': {
      const mood = TTRPG_MOODS.find((m) => m === str(x.mood ?? x.light ?? x.value, 12).toLowerCase());
      return mood ? { type: t, mood } : `mood_light: "mood" must be one of ${TTRPG_MOODS.join(', ')}`;
    }
    case 'camera': {
      const shot = str(x.shot ?? x.camera ?? x.view, 10).toLowerCase();
      if (!['wide', 'map', 'gm', 'dice', 'seat', 'handout'].includes(shot)) return 'camera: "shot" must be wide, map, gm, dice, seat or handout';
      return { type: t, shot: shot as 'wide', ...(who ? { who } : {}) };
    }
    case 'give_item': {
      const item = str(x.item ?? x.items ?? x.what, 60);
      return need(!!who && !!item, 'needs "who" and "item"') ?? { type: t, who, item, ...(x.take === true || /take|remove/i.test(String(x.type)) ? { take: true } : {}) };
    }
    case 'remember': { const fact = str(x.fact ?? x.text ?? x.note, 200); return fact ? { type: t, fact } : 'remember: needs "fact"'; }
    case 'award_luck': return need(!!who, 'needs "who"') ?? { type: t, who, amount: num(x.amount, -3, 3) ?? 1 };
    case 'end_session': return { type: t, recap: str(x.recap ?? x.summary ?? x.text, 600) };
  }
  return 'unhandled action';
}

// ---------------------------------------------------------------- the prompt
export interface GmPartyMember { player: string; sheet: string; token?: string; pos?: [number, number] }
export interface GmContext {
  system: 'generic' | '5e';
  rating: ContentRating;
  lines: string[];
  veils: string[];
  gmName: string;
  persona: string;
  language?: string;
  env: { id: string; name: string; theme: string };
  seed?: { title: string; pitch: string; hooks: string[]; npcs: string[]; places: string[]; twist: string; tone: string; maps: string[] } | null;
  campaign: { title: string; memory: string; facts: string[] };
  party: GmPartyMember[];
  npcs: { name: string; kind: string; hp?: string; pos?: [number, number]; stats?: string }[];
  scene: { title: string; map: string; mapDesc: string; mood: string };
  combat: { on: boolean; round: number; order: string[]; turn: string } | null;
  recent: { who: string; text: string }[];
  feedback: string[];
  xcard: boolean;
  event: { kind: 'start' | 'action' | 'rolls' | 'continue' | 'ooc' | 'recap' | 'summary'; who?: string; text?: string; rolls?: string[] };
}

export function gmSystemPrompt(c: Pick<GmContext, 'system' | 'rating' | 'lines' | 'veils' | 'gmName' | 'persona' | 'language'>): string {
  const rating = RATINGS.find((r) => r.id === c.rating) ?? RATINGS[1];
  return [
    `You are ${c.gmName}, the Game Master of a tabletop roleplaying game played LIVE on a stream by VTubers sitting around a 3D table. ${c.persona ? `Your character: ${c.persona}.` : ''}`,
    `Rules system: ${c.system === '5e' ? 'a light 5e-compatible game (SRD 5.1 rules only: d20 + modifier vs DC or AC, advantage/disadvantage, HP, conditions).' : 'a rules-light system-agnostic game (d20 + stat vs a difficulty 10/15/20, or 2d6 when it fits; keep numbers simple).'}`,
    '',
    'HOW TO GM ON STREAM',
    '- Narrate vividly but SHORT: usually 2–5 sentences (under ~90 words); an opening scene may run to ~150 words. Your text is read aloud by a voice, so write for the ear: no lists, no markdown, no stage directions in brackets, no emoji.',
    '- Speak to the players, use their CHARACTER names, and end most turns by handing the spotlight to someone ("What do you do, Aria?"). Rotate the spotlight fairly.',
    '- Never decide what player characters do, say, think or feel. When the outcome is uncertain, ask for a roll with request_roll instead of assuming success or failure; after the roll result arrives, narrate the consequence.',
    '- Monsters and NPCs act through npc_roll (attacks, saves) and npc_say (dialogue in their own voice). Keep combat moving: one creature or group per turn, apply damage with damage/heal, move tokens with move_token.',
    '- Keep the table state consistent with what you narrate: spawn tokens for creatures that appear, remove the ones that leave or die, set_scene when the party moves somewhere new, mood_light for atmosphere.',
    '- Be fun: humour, surprises, good NPC voices, fair challenges. Say yes-and to clever ideas. Keep a brisk pace — this is entertainment for an audience.',
    `- Content rating: ${rating.name}. ${rating.rule}`,
    '- Always: no slurs or hate, no sexual content, no real people (streamers, viewers, celebrities) as targets, no instructions for real-world harm. If a player pushes past the rating or a line, steer the story elsewhere without lecturing.',
    c.lines.length ? `- LINES (never include, not even off-screen): ${c.lines.join('; ')}.` : '',
    c.veils.length ? `- VEILS (may happen only off-screen, fade to black, no detail): ${c.veils.join('; ')}.` : '',
    '- If the X-card is used, immediately retcon the last thing you described, apologise in one short in-world line, and move the scene on. Never ask why.',
    '- Messages marked [OOC] are out-of-character table talk: answer briefly and helpfully, then return to the game.',
    '- Messages from the [engine] report rule results and problems with your last actions; fix them silently.',
    c.language && c.language !== 'en' ? `- Narrate in this language: ${c.language}. Keep the JSON keys in English.` : '',
    '',
    'OUTPUT FORMAT (exactly this, every turn)',
    'First your narration as plain text. Then a line containing only [[ACTIONS]] and then a JSON array of action objects (use [] when there are none). Nothing after the array.',
    'Actions (JSON, double quotes, coordinates are map cells [x, y] with x west→east, y north→south):',
    '{"type":"request_roll","who":"<character name or all>","check":"Stealth","dc":13,"adv":"adv|dis (optional)","reason":"sneaking past the guard"}  — or "roll":"d20+2" / "2d6" instead of "check"',
    '{"type":"npc_roll","who":"<token name>","roll":"d20+4","label":"Scimitar attack","vs":"<character>","dc":15}  — dc = target AC / DC, the engine reports hit or miss',
    '{"type":"set_scene","title":"The Drowned Chapel","map":"<' + MAP_TEMPLATES.map((m) => m.id).join('|') + '>","mood":"eerie"}',
    '{"type":"spawn_token","name":"Goblin","count":3,"kind":"monster|npc|object","srd":"goblin (optional stat block id)","at":[14,6] or "east","hp":7,"ac":15}',
    '{"type":"move_token","who":"Goblin 2","to":[10,6]}  — or "to":"Aria" to move next to her',
    '{"type":"remove_token","who":"Goblin 1"}',
    '{"type":"damage","who":"Aria","amount":5,"kind":"slashing"}  {"type":"heal","who":"Aria","amount":4}',
    '{"type":"condition","who":"Aria","add":"Prone"}  (or "remove")',
    '{"type":"start_combat"}  (rolls initiative for everyone on the map)  {"type":"next_turn"}  {"type":"end_combat"}',
    '{"type":"npc_say","name":"Old Mag","text":"You lot again?","voice":"rough|low|high|soft"}',
    '{"type":"show_handout","title":"Wanted!","text":"...","style":"parchment|note|dossier|wanted|screen"}',
    `{"type":"mood_light","mood":"${TTRPG_MOODS.join('|')}"}`,
    '{"type":"camera","shot":"wide|map|gm|dice|seat|handout","who":"<character for seat>"}',
    '{"type":"give_item","who":"Aria","item":"Rusty key"}  (add "take": true to remove it)',
    '{"type":"remember","fact":"The party owes Mag 10 gold"}  — facts worth keeping for later sessions',
    '{"type":"award_luck","who":"Aria","amount":1}  — inspiration / hero point for great roleplay',
    '{"type":"end_session","recap":"..."}  — only when the players want to stop',
    'Use only names that exist on the table (see STATE) or that you spawn in the same turn. Do not invent other action types.',
  ].filter(Boolean).join('\n');
}

export function gmUserPrompt(c: GmContext): string {
  const L: string[] = [];
  L.push(`STATE — ${c.env.name}${c.env.theme ? ` (${c.env.theme})` : ''}`);
  if (c.campaign.title) L.push(`Campaign: ${c.campaign.title}`);
  if (c.campaign.memory) L.push(`Story so far: ${c.campaign.memory}`);
  if (c.campaign.facts.length) L.push(`Facts to remember: ${c.campaign.facts.slice(-20).join(' | ')}`);
  if (c.seed) L.push(`Adventure seed "${c.seed.title}" (${c.seed.tone}): ${c.seed.pitch} Hooks: ${c.seed.hooks.join(' / ')}. NPCs: ${c.seed.npcs.join(' / ')}. Places: ${c.seed.places.join(' / ')}. Twist (reveal later): ${c.seed.twist}. Good maps: ${c.seed.maps.join(', ')}.`);
  L.push(`Scene: ${c.scene.title || '(none yet)'}; mood ${c.scene.mood}; map ${c.scene.map || 'none'}${c.scene.mapDesc ? ` — ${c.scene.mapDesc}` : ''}`);
  L.push('Party (player → character):');
  for (const p of c.party) L.push(`- ${p.player} plays ${p.sheet}${p.pos ? ` @[${p.pos.join(',')}]` : ''}`);
  if (!c.party.length) L.push('- (no characters yet: the players are still sitting down)');
  if (c.npcs.length) { L.push('On the map:'); for (const n of c.npcs.slice(0, 30)) L.push(`- ${n.name} (${n.kind}${n.hp ? `, HP ${n.hp}` : ''}${n.stats ? `, ${n.stats}` : ''})${n.pos ? ` @[${n.pos.join(',')}]` : ''}`); }
  if (c.combat?.on) L.push(`COMBAT round ${c.combat.round}: order ${c.combat.order.join(' → ')}; now: ${c.combat.turn}`);
  if (c.recent.length) { L.push('Recent table talk (oldest first):'); for (const r of c.recent.slice(-24)) L.push(`${r.who}: ${r.text}`); }
  if (c.feedback.length) L.push(`[engine] ${c.feedback.join(' | ')}`);
  if (c.xcard) L.push('[engine] THE X-CARD WAS JUST USED on your last description. Retcon it now.');
  L.push('');
  const e = c.event;
  switch (e.kind) {
    case 'start': L.push('Open the session: set the scene (set_scene with a fitting map), introduce the situation from the seed in a few vivid sentences, spawn anyone important, and ask the first player what they do.'); break;
    case 'action': L.push(`${e.who ?? 'A player'} says: ${e.text ?? ''}`); break;
    case 'ooc': L.push(`[OOC] ${e.who ?? 'A player'}: ${e.text ?? ''}`); break;
    case 'rolls': L.push(`Roll results: ${(e.rolls ?? []).join(' | ')}. Narrate the outcome.`); break;
    case 'recap': L.push('Give a short "previously on…" recap (3 sentences) of the story so far in your voice, then hand the spotlight to a player. No actions needed except maybe set_scene.'); break;
    case 'continue': default: L.push(e.text ? `The host asks: ${e.text}` : 'Continue the scene: move the story forward (NPCs act, the world reacts) and hand the spotlight to a player.');
  }
  L.push(`Answer as ${c.gmName}: narration, then [[ACTIONS]] and the JSON array.`);
  return L.join('\n');
}

/** Memory compaction: the host asks for this when the transcript grows (separate short call). */
export function summaryPrompt(prevMemory: string, transcript: { who: string; text: string }[]): string {
  return `Summarise this tabletop session for the Game Master's notes in at most 180 words: who the characters are, where they are, what happened, open threads, NPC names and attitudes, loot, debts and promises. Plain prose, no lists, no headings. Keep every proper name.\n\nPrevious notes: ${prevMemory || '(none)'}\n\nNew transcript:\n${transcript.map((t) => `${t.who}: ${t.text}`).join('\n')}`;
}

/** Rough token estimate when a provider doesn't report usage (≈ 4 chars / token for English). */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3.8);
