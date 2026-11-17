// beta.16 "soundfx" lane, helper side (docs/b16/LANES.md, docs/b16/SOUNDFX.md): the Soundboard's files and settings.
//
//   GET    /api/soundboard                 -> { cfg, sounds }         the settings + every sound (starter stings, synth, yours)
//   PUT    /api/soundboard                 -> save config/soundboard.json (the whole thing or a patch)       (localhost only)
//   POST   /api/soundboard/upload?name=    -> raw audio body (<= 3 MB: ogg / mp3 / wav / m4a / webm / flac)  (localhost only)
//   PUT    /api/soundboard/sound/:id       -> { name } rename one of your sounds                             (localhost only)
//   GET    /api/soundboard/file/:id        -> the sound file (a starter sting or one of yours)
//   DELETE /api/soundboard/file/:id        -> remove one of your sounds (cues that used it lose it)           (localhost only)
//
// The streamer's sounds live in the helper's library (library/sounds/board/<id>.<ext> + index.json), so they move with
// "Bring my stuff over" like the avatars; the settings are config/soundboard.json. Starter stings are CC0 files shipped in
// assets/library/stings/ (LICENSE.txt there). Nothing here plays a sound: playing is the STUDIO window's job
// (src/audio/soundboard.ts), started by the bus command `sfx`, which the Stream Deck, a rule or a key sends. This file also
// registers the rule actions `sfx` and `screen-fx` for a rules engine that runs in the helper: they turn into the same bus
// commands (the deck planner, shared/deck.ts, already checks the arguments).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import { broadcast } from '../bus.ts';
import { HttpError } from '../library.ts';
import { CONFIG_DIR, LIBRARY_DIR, ROOT } from '../paths.ts';
import { requireLocal, sendAbsolute } from './util.ts';
import type { B16ServerCtx } from '../b16/mount.ts';
import { ACTION_BY_ID, planRun } from '../../shared/deck.ts';
import { registerRuleAction, type RuleActionHandler } from '../../shared/streamRules.ts';
import {
  AUDIO_EXT, MAX_SOUND_BYTES, MAX_USER_SOUNDS, STARTER_STINGS, SYNTH_STINGS, cleanSoundName, dropSound, sanitizeSoundboardCfg, sniffAudioBytes,
  starterSting, type SoundInfo, type SoundboardCfg, type UserSoundRec,
} from '../../shared/soundboard.ts';

const CFG_FILE = path.join(CONFIG_DIR, 'soundboard.json');
const SOUND_DIR = path.join(LIBRARY_DIR, 'sounds', 'board');
const INDEX = path.join(SOUND_DIR, 'index.json');
const STING_DIR = path.join(ROOT, 'assets', 'library', 'stings');

let cfg: SoundboardCfg | null = null;
export function soundboardCfg(): SoundboardCfg {
  if (cfg) return cfg;
  try { cfg = sanitizeSoundboardCfg(JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))); } catch { cfg = sanitizeSoundboardCfg({}); }
  return cfg;
}
function saveCfg(next: SoundboardCfg) {
  cfg = next;
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); const tmp = CFG_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(next, null, 1)); fs.renameSync(tmp, CFG_FILE); }
  catch (e) { console.warn('[soundboard] save', e); }
}
/** Tests: forget the cached settings. */
export function resetSoundboardCache() { cfg = null; }

function readIndex(): UserSoundRec[] {
  try {
    const j = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    return Array.isArray(j) ? j.filter((s) => s && /^u[a-f0-9]{16}$/.test(s.id) && typeof s.type === 'string' && s.type in AUDIO_EXT).slice(0, MAX_USER_SOUNDS) : [];
  } catch { return []; }
}
function writeIndex(list: UserSoundRec[]) { fs.mkdirSync(SOUND_DIR, { recursive: true }); const tmp = INDEX + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(list, null, 1)); fs.renameSync(tmp, INDEX); }
const fileFor = (s: UserSoundRec) => path.join(SOUND_DIR, `${s.id}.${AUDIO_EXT[s.type] ?? 'bin'}`);

export function listSounds(): SoundInfo[] {
  const mine = readIndex().map((s): SoundInfo => ({ id: s.id, name: s.name, kind: 'mine', bytes: s.bytes }));
  return [
    ...SYNTH_STINGS.map((s): SoundInfo => ({ id: s.id, name: s.name, kind: 'synth' })),
    ...STARTER_STINGS.map((s): SoundInfo => ({ id: s.id, name: s.name, kind: 'sting' })),
    ...mine,
  ];
}
const view = () => ({ cfg: soundboardCfg(), sounds: listSounds() });

export const soundboardRoutes = Router();
soundboardRoutes.get('/api/soundboard', (_req, res) => { res.json(view()); });
soundboardRoutes.put('/api/soundboard', (req, res) => {
  requireLocal(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  // a patch keeps what it doesn't mention (a key may flip `on` while the panel edits a cue)
  const next = sanitizeSoundboardCfg({ ...soundboardCfg(), ...b });
  // sounds that are not on this PC can't be picked
  const known = new Set(listSounds().map((s) => s.id));
  for (const id of Object.keys(next.vols)) if (!known.has(id)) delete next.vols[id];
  next.cues = next.cues.map((c) => (c.sound && !known.has(c.sound) ? { ...c, sound: '' } : c)).filter((c) => c.sound || c.fx);
  if (next.scream.sound && !known.has(next.scream.sound)) next.scream = { ...next.scream, sound: '' };
  saveCfg(next);
  res.json(view());
});
soundboardRoutes.post('/api/soundboard/upload', express.raw({ type: () => true, limit: MAX_SOUND_BYTES }), (req, res) => {
  requireLocal(req);
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buf.length) throw new HttpError(400, 'The file was empty');
  if (buf.length > MAX_SOUND_BYTES) throw new HttpError(413, 'That sound is bigger than 3 MB: use a shorter clip');
  const kind = sniffAudioBytes(buf);
  if (!kind) throw new HttpError(415, 'That file is not a sound VTube Pro can play (use .mp3, .ogg, .wav, .m4a, .webm or .flac)');
  const list = readIndex();
  const id = 'u' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
  const name = cleanSoundName(req.query.name);
  if (!list.some((s) => s.id === id)) {
    if (list.length >= MAX_USER_SOUNDS) throw new HttpError(409, `You have ${MAX_USER_SOUNDS} sounds of your own: remove one first`);
    const s: UserSoundRec = { id, name, type: kind.type, bytes: buf.length };
    fs.mkdirSync(SOUND_DIR, { recursive: true });
    fs.writeFileSync(fileFor(s), buf);
    writeIndex([...list, s]);
  }
  res.json({ ...view(), added: id });
});
soundboardRoutes.put('/api/soundboard/sound/:id', (req, res) => {
  requireLocal(req);
  const id = String(req.params.id);
  const list = readIndex();
  if (!list.some((s) => s.id === id)) throw new HttpError(404, 'No such sound');
  const name = cleanSoundName((req.body ?? {}).name, '');
  if (!name) throw new HttpError(400, 'Give it a name');
  writeIndex(list.map((s) => (s.id === id ? { ...s, name } : s)));
  res.json(view());
});
soundboardRoutes.get('/api/soundboard/file/:id', (req, res) => {
  const id = String(req.params.id);
  const st = starterSting(id);
  const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' };
  if (st) {
    const full = path.join(STING_DIR, st.file);
    if (!fs.existsSync(full)) throw new HttpError(404, 'No such sound');
    sendAbsolute(res, full, { headers: { ...headers, 'Content-Type': 'audio/ogg' } }, STING_DIR);
    return;
  }
  const s = readIndex().find((x) => x.id === id);
  if (!s || !fs.existsSync(fileFor(s))) throw new HttpError(404, 'No such sound');
  sendAbsolute(res, fileFor(s), { headers: { ...headers, 'Content-Type': s.type } }, SOUND_DIR);
});
soundboardRoutes.delete('/api/soundboard/file/:id', (req, res) => {
  requireLocal(req);
  const id = String(req.params.id);
  const list = readIndex(), s = list.find((x) => x.id === id);
  if (!s) throw new HttpError(404, 'No such sound');
  try { fs.rmSync(fileFor(s), { force: true }); } catch { /* gone already */ }
  writeIndex(list.filter((x) => x.id !== id));
  saveCfg(dropSound(soundboardCfg(), id));
  res.json(view());
});

// ---------------------------------------------------------------- rule actions (a rules engine that runs in the helper)
function busAction(id: 'sfx' | 'screen-fx'): RuleActionHandler {
  return ({ params }) => {
    const plan = planRun(id, params);
    if (plan.kind === 'error') return { ok: false, error: plan.error };
    if (plan.kind !== 'bus') return { ok: false, error: 'Not a sound action' };
    broadcast({ type: 'command', command: plan.command, args: plan.args } as Parameters<typeof broadcast>[0]);
    return { ok: true };
  };
}
let unregister: (() => void)[] = [];
export function registerSoundfxRuleActions() {
  for (const u of unregister.splice(0)) u();
  const meta = (id: string, over: { sound?: boolean }) => { const d = ACTION_BY_ID.get(id); return { label: d?.label ?? id, group: d?.group ?? 'Stream extras', icon: d?.icon, params: d?.params, where: 'helper' as const, ...over }; };
  unregister.push(registerRuleAction('sfx', busAction('sfx'), meta('sfx', { sound: true })));
  unregister.push(registerRuleAction('screen-fx', busAction('screen-fx'), meta('screen-fx', {})));
}

let mounted: express.Express | null = null;
export function mount(ctx: B16ServerCtx): void {
  if (mounted === ctx.app) return;
  mounted = ctx.app;
  ctx.app.use(soundboardRoutes);
  registerSoundfxRuleActions();
}
