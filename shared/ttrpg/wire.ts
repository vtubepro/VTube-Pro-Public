// Messages of the TTRPG layer.
//  - Party wire (host ⇄ guest studios, over the existing party 'ctl' channel as { t: 'ttrpg', d }): the guests' panels
//    (sheets, log, roll requests) and their inputs (actions, rolls, sheet edits, X-card).
//  - Bus (a studio → this PC's OBS pages, loopback only): speech timing, images (maps / handouts, RAM only), and the
//    VTT bridge relays from the server.
// Everything arriving from another PC or a VTT is sanitised here before anyone uses it.
import { clean, sanitizeToken, type TtrpgToken } from './state.ts';
import { sanitizeCharacter, type TtrpgCharacter } from './rules.ts';
import type { GmAction } from './gm.ts';
import { validateAction } from './gm.ts';

export interface LogEntry { id: string; at: number; who: string; name: string; kind: 'gm' | 'npc' | 'player' | 'ooc' | 'roll' | 'system' | 'x'; text: string }
export interface RollRequest { id: string; who: string; name: string; expr: string; label: string; dc?: number; secret?: boolean; at: number }

/** The table as a guest's panel sees it (no API config, no costs, no pending unapproved GM lines). */
export interface GamePublic {
  title: string;
  system: 'generic' | '5e';
  gmKind: 'ai' | 'human' | 'none';
  gmName: string;
  gmBusy: '' | 'thinking' | 'speaking' | 'paused' | 'waiting';
  rating: 'family' | 'pg13' | 'mature';
  lines: string[];
  veils: string[];
  chars: TtrpgCharacter[];
  log: LogEntry[];
  requests: RollRequest[];
  /** Tokens (for the guest's own mini map in the panel). */
  tokens: TtrpgToken[];
  rev: number;
}

export type PartyTtrpg =
  | { k: 'game'; g: GamePublic }
  | { k: 'speak'; id: string; text: string; voice?: string; npc?: boolean }
  | { k: 'asset'; id: string; part: number; of: number; data: string }
  | { k: 'act'; text: string; ooc?: boolean }
  | { k: 'roll'; expr: string; label: string; req?: string; secret?: boolean }
  | { k: 'sheet'; c: TtrpgCharacter }
  | { k: 'x' }
  | { k: 'move'; tok: string; x: number; y: number }
  | { k: 'gm'; a: GmAction }
  | { k: 'pause' };

const n = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
const ID = /^[A-Za-z0-9_:.-]{1,40}$/;

/** A message from a guest (host side). Anything else a guest sends is dropped. */
export function sanitizeFromGuest(o: unknown): PartyTtrpg | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  switch (x.k) {
    case 'act': { const text = clean(x.text, 500); return text ? { k: 'act', text, ...(x.ooc === true ? { ooc: true } : {}) } : null; }
    case 'roll': { const expr = clean(x.expr, 40); return expr ? { k: 'roll', expr, label: clean(x.label, 60), ...(typeof x.req === 'string' && ID.test(x.req) ? { req: x.req } : {}), ...(x.secret === true ? { secret: true } : {}) } : null; }
    case 'sheet': { const c = sanitizeCharacter(x.c); return c ? { k: 'sheet', c } : null; }
    case 'x': return { k: 'x' };
    case 'pause': return { k: 'pause' };
    case 'move': { const tx = n(x.x, -1, 99), ty = n(x.y, -1, 99); return typeof x.tok === 'string' && ID.test(x.tok) && tx !== null && ty !== null ? { k: 'move', tok: x.tok, x: tx, y: ty } : null; }
    case 'gm': { const a = validateAction(x.a); return typeof a === 'string' ? null : { k: 'gm', a }; }
  }
  return null;
}

/** A message from the host (guest side). */
export function sanitizeFromHost(o: unknown): PartyTtrpg | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  if (x.k === 'speak') { const text = clean(x.text, 600); return text && typeof x.id === 'string' && ID.test(x.id) ? { k: 'speak', id: x.id, text, ...(typeof x.voice === 'string' ? { voice: clean(x.voice, 12) } : {}), ...(x.npc === true ? { npc: true } : {}) } : null; }
  if (x.k === 'asset') {
    const part = n(x.part, 0, 63), of = n(x.of, 1, 64);
    return typeof x.id === 'string' && ID.test(x.id) && part !== null && of !== null && typeof x.data === 'string' && x.data.length <= 48_000 ? { k: 'asset', id: x.id, part, of, data: x.data } : null;
  }
  if (x.k === 'game' && x.g && typeof x.g === 'object') {
    const g = x.g as Record<string, unknown>;
    const log: LogEntry[] = (Array.isArray(g.log) ? g.log.slice(-60) : []).flatMap((e) => {
      if (!e || typeof e !== 'object') return [];
      const r = e as Record<string, unknown>;
      const kind = ['gm', 'npc', 'player', 'ooc', 'roll', 'system', 'x'].includes(String(r.kind)) ? r.kind as LogEntry['kind'] : 'system';
      return typeof r.id === 'string' && ID.test(r.id) ? [{ id: r.id, at: n(r.at, 0, 1e14) ?? 0, who: clean(r.who, 40), name: clean(r.name, 40), kind, text: clean(r.text, 1200) }] : [];
    });
    const requests: RollRequest[] = (Array.isArray(g.requests) ? g.requests.slice(0, 16) : []).flatMap((e) => {
      if (!e || typeof e !== 'object') return [];
      const r = e as Record<string, unknown>;
      return typeof r.id === 'string' && ID.test(r.id) ? [{ id: r.id, who: clean(r.who, 40), name: clean(r.name, 40), expr: clean(r.expr, 40), label: clean(r.label, 60), ...(typeof r.dc === 'number' ? { dc: n(r.dc, 0, 99)! } : {}), ...(r.secret === true ? { secret: true } : {}), at: n(r.at, 0, 1e14) ?? 0 }] : [];
    });
    const strs = (v: unknown) => (Array.isArray(v) ? v.map((s) => clean(s, 80)).filter(Boolean).slice(0, 20) : []);
    return { k: 'game', g: {
      title: clean(g.title, 80), system: g.system === 'generic' ? 'generic' : '5e', gmKind: g.gmKind === 'human' || g.gmKind === 'none' ? g.gmKind : 'ai', gmName: clean(g.gmName, 40),
      gmBusy: ['thinking', 'speaking', 'paused', 'waiting'].includes(String(g.gmBusy)) ? g.gmBusy as GamePublic['gmBusy'] : '',
      rating: g.rating === 'family' || g.rating === 'mature' ? g.rating : 'pg13', lines: strs(g.lines), veils: strs(g.veils),
      chars: (Array.isArray(g.chars) ? g.chars.slice(0, 12) : []).map(sanitizeCharacter).filter((c): c is TtrpgCharacter => !!c),
      log, requests, tokens: (Array.isArray(g.tokens) ? g.tokens.slice(0, 48) : []).map(sanitizeToken).filter((t): t is TtrpgToken => !!t), rev: n(g.rev, 0, 1e12) ?? 0,
    } };
  }
  return null;
}

// ---------------------------------------------------------------- bus (this PC only)
export type TtrpgBus =
  | { k: 'sayAt'; id: string; at: number; dur: number; lip?: LipCue[] } // the TTS really started: re-time the mouth / captions (lip: the audio's own mouth shapes)
  | { k: 'mouth'; id: string; v: number }                                // provider TTS audio level 0..1 (~20 Hz)
  | { k: 'asset'; id: string; url: string }                              // an image (data URL) for the map / handout (RAM only)
  | { k: 'vtt'; m: VttMsg }                                              // from the VTT bridge (server → studio)
  | { k: 'vttStatus'; clients: { id: string; src: string; name: string; at: number }[] }
  // the GM's voice ON STREAM: this PC's OBS page plays the rendered line (/api/ttrpg/voice/<id>) at `at` (ms, wall clock)
  | { k: 'play'; id: string; url: string; at: number; dur: number; vol?: number }
  | { k: 'hush'; id?: string };                                        // stop the line now (skip / stop / X-card)

/** A mouth cue of a rendered voice line: [seconds from the line's start, seconds to its end, viseme name] (server/lipsync/rhubarb.ts). */
export type LipCue = [number, number, string];
/** Clean cues that arrive over the bus: known visemes, finite increasing times, at most 4000 of them. */
export function sanitizeLip(v: unknown): LipCue[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const known = new Set(['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'L', 'W', 'aa', 'E', 'I', 'O', 'U']);
  const out: LipCue[] = [];
  let t = 0;
  for (const c of v.slice(0, 4000)) {
    if (!Array.isArray(c) || c.length !== 3 || typeof c[0] !== 'number' || typeof c[1] !== 'number' || typeof c[2] !== 'string' || !known.has(c[2])) continue;
    const a = Math.max(t, c[0]), b = c[1];
    if (Number.isFinite(a) && Number.isFinite(b) && b > a && b < 3600) { out.push([a, b, c[2]]); t = b; }
  }
  return out.length ? out : undefined;
}

/** A voice line URL the OBS page may fetch (only our own server's rendered lines). */
export const VOICE_URL = /^\/api\/ttrpg\/voice\/[0-9a-f]{24}$/;

// ---------------------------------------------------------------- VTT bridge (Foundry module / Owlbear extension / Roll20 userscript → ws://127.0.0.1:5191/ws/vtt)
export type VttSource = 'foundry' | 'owlbear' | 'roll20' | 'generic';
export type VttMsg =
  | { src: VttSource; k: 'roll'; who: string; label: string; expr: string; dice: { s: number; v: number }[]; total: number }
  | { src: VttSource; k: 'chat'; who: string; text: string }
  | { src: VttSource; k: 'init'; order: { name: string; init: number }[]; turn: number; round: number }
  | { src: VttSource; k: 'tokens'; cols: number; rows: number; tokens: { id: string; name: string; x: number; y: number; color?: string; hp?: [number, number]; pc?: boolean }[] }
  | { src: VttSource; k: 'sheet'; actor: unknown }
  | { src: VttSource; k: 'scene'; title: string };

const SRC: VttSource[] = ['foundry', 'owlbear', 'roll20', 'generic'];
export function sanitizeVtt(o: unknown, src: VttSource): VttMsg | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  const s = SRC.includes(x.src as VttSource) ? x.src as VttSource : src;
  switch (x.k) {
    case 'roll': {
      const dice = (Array.isArray(x.dice) ? x.dice.slice(0, 40) : []).flatMap((d) => {
        if (!d || typeof d !== 'object') return [];
        const r = d as Record<string, unknown>;
        const sides = n(r.s ?? r.faces, 2, 100), v = n(r.v ?? r.result, 1, 100);
        return sides !== null && v !== null && [2, 3, 4, 6, 8, 10, 12, 20, 100].includes(sides) && v <= sides ? [{ s: sides, v: Math.round(v) }] : [];
      });
      const total = n(x.total, -9999, 99999);
      return total === null ? null : { src: s, k: 'roll', who: clean(x.who, 40) || 'Someone', label: clean(x.label, 60), expr: clean(x.expr, 60), dice, total: Math.round(total) };
    }
    case 'chat': { const text = clean(String(x.text ?? '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '), 500); return text ? { src: s, k: 'chat', who: clean(x.who, 40) || 'Someone', text } : null; }
    case 'init': {
      const order = (Array.isArray(x.order) ? x.order.slice(0, 30) : []).flatMap((e) => {
        if (!e || typeof e !== 'object') return [];
        const r = e as Record<string, unknown>;
        const name = clean(r.name, 32); const init = n(r.init, -50, 99);
        return name ? [{ name, init: init === null ? 0 : Math.round(init) }] : [];
      });
      return { src: s, k: 'init', order, turn: Math.round(n(x.turn, 0, 29) ?? 0), round: Math.round(n(x.round, 1, 9999) ?? 1) };
    }
    case 'tokens': {
      const tokens = (Array.isArray(x.tokens) ? x.tokens.slice(0, 48) : []).flatMap((e) => {
        if (!e || typeof e !== 'object') return [];
        const r = e as Record<string, unknown>;
        const tx = n(r.x, -1, 199), ty = n(r.y, -1, 199);
        const tid = typeof r.id === 'string' ? r.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 30) : '';
        if (!tid || tx === null || ty === null) return [];
        const hp = Array.isArray(r.hp) && r.hp.length === 2 ? [Math.round(n(r.hp[0], -999, 9999) ?? 0), Math.round(n(r.hp[1], 1, 9999) ?? 1)] as [number, number] : undefined;
        return [{ id: tid, name: clean(r.name, 32) || tid, x: tx, y: ty, ...(typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? { color: r.color } : {}), ...(hp ? { hp } : {}), ...(r.pc === true ? { pc: true } : {}) }];
      });
      return { src: s, k: 'tokens', cols: Math.round(n(x.cols, 4, 120) ?? 20), rows: Math.round(n(x.rows, 4, 120) ?? 14), tokens };
    }
    case 'sheet': return x.actor && typeof x.actor === 'object' && JSON.stringify(x.actor).length < 400_000 ? { src: s, k: 'sheet', actor: x.actor } : null;
    case 'scene': { const title = clean(x.title, 80); return title ? { src: s, k: 'scene', title } : null; }
  }
  return null;
}

export type { TtrpgToken };
