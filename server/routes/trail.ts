// The Trail (src/game/trail): theme packs + the host PC's persistence (graveyard, run history).
//
//   GET  /api/trail/themes              → [{ id, name, personal, extends }] (every assets/games/trail/<id>/theme.json)
//   GET  /api/trail/:theme/deck         → the merged + validated deck (a theme `extends` the neutral 'frontier' base)
//   GET  /api/trail/:theme/file/*rel    → a file of that theme pack (GLBs, PNGs — trailart's assets)
//   GET  /api/trail/graveyard           → Grave[] (everyone who died on this PC, all runs)
//   POST /api/trail/graveyard {graves}  → append (localhost only; names + text only, capped)
//   GET  /api/trail/runs                → run history
//   POST /api/trail/runs {run}          → append a finished run (localhost only)
// Stored in saves/trail/ (git-ignored, created on first write, atomic tmp + rename). No model data, ever.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { mergeDeck, validateDeck } from '../../shared/trail/deck.ts';
import type { Deck, Grave } from '../../shared/trail/types.ts';
import { HttpError } from '../library.ts';
import { ROOT, SAVES_DIR } from '../paths.ts';
import { requireLocal, sendFrom, wildcardPath } from './util.ts';

export const TRAIL_DIR = path.join(ROOT, 'assets', 'games', 'trail');
const SAVE_DIR = path.join(SAVES_DIR, 'trail');
const GRAVES = path.join(SAVE_DIR, 'graveyard.json');
const RUNS = path.join(SAVE_DIR, 'runs.json');
const isId = (s: string) => /^[a-z0-9_-]{1,40}$/.test(s);

export const trailRoutes = Router();

function readJson<T>(file: string, fallback: T): T { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; } }
function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}
function loadDeck(id: string, depth = 0): Deck {
  if (!isId(id) || depth > 3) throw new HttpError(400, 'Bad theme');
  const raw = readJson<(Deck & { extends?: string }) | null>(path.join(TRAIL_DIR, id, 'deck.json'), null);
  if (!raw) throw new HttpError(404, `No deck for theme '${id}'`);
  return raw.extends ? mergeDeck(loadDeck(raw.extends, depth + 1), raw) : mergeDeck(raw, {});
}

trailRoutes.get('/api/trail/themes', (_req, res) => {
  const out: { id: string; name: string; personal: boolean; extends?: string }[] = [];
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(TRAIL_DIR); } catch { /* no packs */ }
  for (const id of dirs) {
    if (!isId(id)) continue;
    const t = readJson<{ name?: string; personal?: boolean; extends?: string } | null>(path.join(TRAIL_DIR, id, 'theme.json'), null);
    if (t) out.push({ id, name: String(t.name ?? id), personal: !!t.personal, ...(t.extends ? { extends: String(t.extends) } : {}) });
  }
  res.json(out);
});

// CC0 sound packs (assets/library/sounds: Kenney impact + UI) for the game's cues
trailRoutes.get('/api/trail/sfx/*rel', (req, res) => {
  sendFrom(res, path.join(ROOT, 'assets', 'library', 'sounds'), wildcardPath((req.params as Record<string, unknown>).rel));
});

trailRoutes.get('/api/trail/:theme/deck', (req, res) => {
  const deck = loadDeck(String(req.params.theme));
  const errs = validateDeck(deck);
  if (errs.length) throw new HttpError(422, `Deck problems: ${errs.slice(0, 5).join('; ')}`);
  res.setHeader('Cache-Control', 'no-cache');
  res.json(deck);
});

trailRoutes.get('/api/trail/:theme/file/*rel', (req, res) => {
  const id = String(req.params.theme);
  if (!isId(id)) throw new HttpError(400, 'Bad theme');
  sendFrom(res, path.join(TRAIL_DIR, id), wildcardPath((req.params as Record<string, unknown>).rel));
});

const cleanText = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, n) : '');
function cleanGrave(g: unknown): Grave | null {
  if (!g || typeof g !== 'object') return null;
  const o = g as Record<string, unknown>;
  const mile = Number(o.mile);
  if (!Number.isFinite(mile)) return null;
  return {
    mile: Math.max(0, Math.min(5000, Math.round(mile))), name: cleanText(o.name, 40) || 'Someone', cause: cleanText(o.cause, 60) || 'dysentery',
    epitaph: cleanText(o.epitaph, 60), theme: isId(String(o.theme)) ? String(o.theme) : 'frontier', seed: cleanText(o.seed, 40), date: cleanText(o.date, 10),
    ...(typeof o.run === 'string' ? { run: cleanText(o.run, 40) } : {}), ...(Number.isFinite(Number(o.day)) ? { day: Math.round(Number(o.day)) } : {}),
  };
}

trailRoutes.get('/api/trail/graveyard', (_req, res) => { res.json(readJson<Grave[]>(GRAVES, [])); });
trailRoutes.post('/api/trail/graveyard', (req, res) => {
  requireLocal(req);
  const add = (Array.isArray(req.body?.graves) ? req.body.graves : []).slice(0, 16).map(cleanGrave).filter((g: Grave | null): g is Grave => !!g);
  const all = readJson<Grave[]>(GRAVES, []);
  // an epitaph written after the death updates the same grave (same run + name + mile)
  for (const g of add) {
    const i = all.findIndex((x) => x.seed === g.seed && x.name === g.name && x.mile === g.mile && x.run === g.run);
    if (i >= 0) all[i] = { ...all[i], ...g, epitaph: g.epitaph || all[i].epitaph }; else all.push(g);
  }
  const kept = all.slice(-500);
  writeJson(GRAVES, kept);
  res.json({ ok: true, count: kept.length });
});

trailRoutes.get('/api/trail/runs', (_req, res) => { res.json(readJson<unknown[]>(RUNS, [])); });
trailRoutes.post('/api/trail/runs', (req, res) => {
  requireLocal(req);
  const r = req.body?.run as Record<string, unknown> | undefined;
  if (!r || typeof r !== 'object') throw new HttpError(400, 'run missing');
  const party = Array.isArray(r.party) ? (r.party as Record<string, unknown>[]).slice(0, 8).map((m) => ({ name: cleanText(m.name, 40), role: cleanText(m.role, 20), cls: cleanText(m.cls, 10), alive: m.alive === true, diedOf: cleanText(m.diedOf, 60), epitaph: cleanText(m.epitaph, 60) })) : [];
  const entry = {
    at: new Date().toISOString(), theme: isId(String(r.theme)) ? String(r.theme) : 'frontier', seed: cleanText(r.seed, 40), daily: r.daily === true, slice: r.slice === true,
    outcome: r.outcome === 'won' ? 'won' : 'wiped', score: Math.round(Number(r.score) || 0), days: Math.round(Number(r.days) || 0), miles: Math.round(Number(r.miles) || 0),
    modifiers: Array.isArray(r.modifiers) ? (r.modifiers as unknown[]).slice(0, 4).map((m) => cleanText(m, 20)) : [],
    party, photo: typeof r.photo === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]{1,400000}$/.test(r.photo) ? r.photo : undefined,
  };
  const all = [...readJson<unknown[]>(RUNS, []), entry].slice(-200);
  writeJson(RUNS, all);
  res.json({ ok: true, count: all.length });
});
