// TTRPG routes (docs/TTRPG.md): the AI GM (a model on this PC: config, model list, connection test, streamed turns,
// memory summaries, token meter), voice-server TTS / STT on this PC, campaign saves, the VTT bridge status and the bridge client
// files (Foundry module, Owlbear extension, Roll20 userscript) served from tools/ttrpg/vtt.
//
//   GET  /api/ttrpg/config                 → public config (the model + the addresses on this PC)
//   PUT  /api/ttrpg/config                 ← patch                                              [studio on this PC only]
//   GET  /api/ttrpg/models                 → model ids on the local model server                [studio only]
//   POST /api/ttrpg/test {model}           → { ok, models, reply, ms, error }                    [studio only]
//   POST /api/ttrpg/gm/turn {ctx}          → text/event-stream (delta… turn, done | error)       [studio only]
//   POST /api/ttrpg/gm/abort · POST /api/ttrpg/gm/summary {prev, transcript} · GET/POST /api/ttrpg/spend[/reset]
//   POST /api/ttrpg/tts {text, voice}      → audio/mpeg (a voice server on this PC) · POST /api/ttrpg/stt (raw audio body) → { text }
//   GET  /api/ttrpg/voices                 → { system: [...], systemOk }  (this PC's Windows voices)       [studio only]
//   POST /api/ttrpg/voice/line {text, engine: system|provider(voice server on this PC), voice, rate, pitch} → { url, dur, voice, type, lip? }
//        lip = [[t0, t1, viseme], …] seconds into the line, from the audio itself (Rhubarb, server/lipsync/rhubarb.ts; only when it is installed)
//   GET  /api/ttrpg/voice/:id              → the rendered line (the OBS page plays it: the GM on stream)  [this PC]
//   GET/PUT/DELETE /api/ttrpg/campaigns[/:id] · GET /api/ttrpg/bridge · GET /vtt/* (bridge client files)
import express, { Router, type Request } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../library.ts';
import { ROOT } from '../paths.ts';
import { requireLocal, sendFrom, wildcardPath } from './util.ts';
import { loadTtrpgConfig, patchTtrpgConfig, publicTtrpgConfig, scrub } from '../ttrpg/config.ts';
import { listModels, synthesize, testConnection, transcribe, ProviderError } from '../ttrpg/providers.ts';
import { systemSay, systemVoiceSupported, systemVoices } from '../ttrpg/systemVoice.ts';
import { rhubarbCues } from '../lipsync/rhubarb.ts';
import crypto from 'node:crypto';
import { abortGm, gmSummary, gmTurn, resetSpend, spend } from '../ttrpg/gm.ts';
import { listCampaigns, readCampaign, trashCampaign, writeCampaign } from '../ttrpg/campaigns.ts';
import { bridgeStatus, startVttBridge } from '../ttrpg/bridge.ts';
import type { GmContext } from '../../shared/ttrpg/gm.ts';
import { clean } from '../../shared/ttrpg/state.ts';

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
/** Only the studio on this PC: loopback socket AND (no Origin, or a loopback Origin). Any website open in the user's
 *  browser could otherwise POST to 127.0.0.1 and drive the user's model server or read its model list. */
function requireStudio(req: Request) {
  requireLocal(req);
  const o = req.headers.origin;
  if (o && !LOOPBACK_ORIGIN.test(o)) throw new HttpError(403, 'Only the VTube Pro studio on this PC may use this');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site request refused');
}

/** The GM context arrives from our own studio, but it is still clamped (sizes, types) before it reaches a prompt. */
function sanitizeCtx(o: unknown): GmContext {
  if (!o || typeof o !== 'object') throw new HttpError(400, 'Missing ctx');
  if (JSON.stringify(o).length > 250_000) throw new HttpError(413, 'Game state too large for one GM turn');
  const x = o as Record<string, any>;
  const s = (v: unknown, n: number) => clean(v, n);
  const arr = <T>(v: unknown, n: number, f: (e: any) => T | null): T[] => (Array.isArray(v) ? v.slice(0, n).map(f).filter((e): e is T => e !== null) : []);
  const pos = (v: unknown): [number, number] | undefined => (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number') ? [Math.round(v[0]), Math.round(v[1])] : undefined);
  const ev = x.event ?? {};
  const kinds = ['start', 'action', 'rolls', 'continue', 'ooc', 'recap', 'summary'];
  return {
    system: x.system === 'generic' ? 'generic' : '5e',
    rating: x.rating === 'family' || x.rating === 'mature' ? x.rating : 'pg13',
    lines: arr(x.lines, 20, (e) => s(e, 80) || null), veils: arr(x.veils, 20, (e) => s(e, 80) || null),
    gmName: s(x.gmName, 40) || 'The Game Master', persona: s(x.persona, 240), language: s(x.language, 20) || undefined,
    env: { id: s(x.env?.id, 48), name: s(x.env?.name, 60), theme: s(x.env?.theme, 200) },
    seed: x.seed && typeof x.seed === 'object' ? { title: s(x.seed.title, 80), pitch: s(x.seed.pitch, 600), tone: s(x.seed.tone, 60), twist: s(x.seed.twist, 300),
      hooks: arr(x.seed.hooks, 6, (e) => s(e, 160) || null), npcs: arr(x.seed.npcs, 8, (e) => s(e, 160) || null), places: arr(x.seed.places, 8, (e) => s(e, 160) || null), maps: arr(x.seed.maps, 6, (e) => s(e, 20) || null) } : null,
    campaign: { title: s(x.campaign?.title, 80), memory: s(x.campaign?.memory, 2000), facts: arr(x.campaign?.facts, 40, (e) => s(e, 200) || null) },
    party: arr(x.party, 12, (e) => (e && typeof e === 'object' ? { player: s(e.player, 40), sheet: s(e.sheet, 700), token: s(e.token, 40) || undefined, pos: pos(e.pos) } : null)),
    npcs: arr(x.npcs, 40, (e) => (e && typeof e === 'object' ? { name: s(e.name, 32), kind: s(e.kind, 12), hp: s(e.hp, 16) || undefined, pos: pos(e.pos), stats: s(e.stats, 200) || undefined } : null)),
    scene: { title: s(x.scene?.title, 80), map: s(x.scene?.map, 20), mapDesc: s(x.scene?.mapDesc, 600), mood: s(x.scene?.mood, 12) || 'calm' },
    combat: x.combat && x.combat.on ? { on: true, round: Number(x.combat.round) || 1, order: arr(x.combat.order, 30, (e) => s(e, 40) || null), turn: s(x.combat.turn, 40) } : null,
    recent: arr(x.recent, 40, (e) => (e && typeof e === 'object' ? { who: s(e.who, 40), text: s(e.text, 800) } : null)),
    feedback: arr(x.feedback, 12, (e) => s(e, 200) || null),
    xcard: x.xcard === true,
    event: { kind: kinds.includes(ev.kind) ? ev.kind : 'continue', who: s(ev.who, 40) || undefined, text: s(ev.text, 800) || undefined, rolls: arr(ev.rolls, 12, (e) => s(e, 200) || null) },
  };
}

export function ttrpgRoutes() {
  const r = Router();
  startVttBridge();

  r.get('/api/ttrpg/config', (req, res) => { requireStudio(req); res.json(publicTtrpgConfig()); });
  r.put('/api/ttrpg/config', (req, res) => {
    requireStudio(req);
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, 'Expected a JSON object');
    res.json(patchTtrpgConfig(req.body));
  });
  r.get('/api/ttrpg/models', async (req, res) => {
    requireStudio(req);
    try { res.json({ models: await listModels() }); }
    catch (e) { throw new HttpError((e as ProviderError).status ?? 502, scrub((e as Error).message)); }
  });
  r.post('/api/ttrpg/test', async (req, res) => {
    requireStudio(req);
    const model = typeof req.body?.model === 'string' ? req.body.model.slice(0, 120) : loadTtrpgConfig().model;
    const out = await testConnection(model);
    res.json({ ...out, error: out.error ? scrub(out.error) : undefined });
  });

  r.post('/api/ttrpg/gm/turn', async (req, res) => {
    requireStudio(req);
    const ctx = sanitizeCtx(req.body?.ctx);
    await gmTurn(ctx, res, { model: req.body?.model });
  });
  r.post('/api/ttrpg/gm/abort', (req, res) => { requireStudio(req); abortGm(); res.json({ ok: true }); });
  r.post('/api/ttrpg/gm/summary', async (req, res) => {
    requireStudio(req);
    const tr = Array.isArray(req.body?.transcript) ? req.body.transcript.slice(-80).map((e: any) => ({ who: clean(e?.who, 40), text: clean(e?.text, 800) })) : [];
    try { res.json(await gmSummary(clean(req.body?.prev, 2000), tr)); }
    catch (e) { throw new HttpError((e as ProviderError).status ?? 502, scrub((e as Error).message)); }
  });
  r.get('/api/ttrpg/spend', (req, res) => { requireStudio(req); res.json(spend()); });
  r.post('/api/ttrpg/spend/reset', (req, res) => { requireStudio(req); resetSpend(); res.json(spend()); });

  r.post('/api/ttrpg/tts', async (req, res) => {
    requireStudio(req);
    const text = clean(req.body?.text, 1200);
    if (!text) throw new HttpError(400, 'No text');
    try { const a = await synthesize(text, clean(req.body?.voice, 40) || undefined); res.setHeader('Content-Type', a.type); res.setHeader('Cache-Control', 'no-store'); res.end(Buffer.from(a.audio)); }
    catch (e) { throw new HttpError((e as ProviderError).status ?? 502, scrub((e as Error).message)); }
  });
  // the GM's voice on stream: a line rendered here, played by this PC's OBS page (kept a few minutes, in memory only)
  const lines = new Map<string, { audio: Buffer; type: string; at: number }>();
  const keepLine = (audio: Buffer, type: string) => {
    const id = crypto.randomBytes(12).toString('hex');
    lines.set(id, { audio, type, at: Date.now() });
    for (const [k, v] of lines) if (lines.size > 48 || Date.now() - v.at > 10 * 60_000) lines.delete(k); else break;
    return id;
  };
  r.get('/api/ttrpg/voices', async (req, res) => {
    requireStudio(req);
    let system: { name: string; lang: string; gender: string }[] = [], error = '';
    try { system = await systemVoices(); } catch (e) { error = (e as Error).message; }
    res.json({ systemOk: systemVoiceSupported() && system.length > 0, system, error });
  });
  r.post('/api/ttrpg/voice/line', async (req, res) => {
    requireStudio(req);
    const text = clean(req.body?.text, 1200);
    if (!text) throw new HttpError(400, 'No text');
    const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
    const voice = clean(req.body?.voice, 80) || undefined;
    try {
      if (req.body?.engine === 'provider') {
        const a = await synthesize(text, voice);
        const id = keepLine(Buffer.from(a.audio), a.type);
        res.json({ url: `/api/ttrpg/voice/${id}`, dur: 0, voice: voice ?? '', type: a.type });
      } else {
        const a = await systemSay(text, { voice, rate: num(req.body?.rate, 0.5, 2, 1), pitch: num(req.body?.pitch, 0.3, 2, 1) });
        const id = keepLine(a.audio, a.type);
        // the mouth follows the real sounds of the rendered WAV (null = Rhubarb not installed / failed: the text-driven mouth carries on)
        const lip = await rhubarbCues(a.audio, { text }).catch(() => null);
        res.json({ url: `/api/ttrpg/voice/${id}`, dur: Math.round(a.dur * 1000) / 1000, voice: a.voice, type: a.type, ...(lip ? { lip: lip.segs.map((s) => [Math.round(s.t0 * 1000) / 1000, Math.round(s.t1 * 1000) / 1000, s.v]) } : {}) });
      }
    } catch (e) { throw new HttpError((e as ProviderError).status ?? 502, scrub((e as Error).message)); }
  });
  r.get('/api/ttrpg/voice/:id', (req, res) => {
    requireStudio(req);
    const l = lines.get(String(req.params.id));
    if (!l) throw new HttpError(404, 'That line is gone');
    res.setHeader('Content-Type', l.type); res.setHeader('Cache-Control', 'no-store'); res.end(l.audio);
  });
  r.post('/api/ttrpg/stt', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '12mb' }), async (req, res) => {
    requireStudio(req);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Send the recorded audio as the request body');
    try { res.json({ text: await transcribe(req.body, String(req.headers['content-type'] ?? 'audio/webm')) }); }
    catch (e) { throw new HttpError((e as ProviderError).status ?? 502, scrub((e as Error).message)); }
  });

  r.get('/api/ttrpg/campaigns', (req, res) => { requireStudio(req); res.json(listCampaigns()); });
  r.get('/api/ttrpg/campaigns/:id', (req, res) => { requireStudio(req); res.json(readCampaign(String(req.params.id))); });
  r.put('/api/ttrpg/campaigns/:id', (req, res) => { requireStudio(req); res.json(writeCampaign(String(req.params.id), req.body)); });
  r.delete('/api/ttrpg/campaigns/:id', (req, res) => { requireStudio(req); res.json(trashCampaign(String(req.params.id))); });

  r.get('/api/ttrpg/bridge', (_req, res) => { res.json({ enabled: loadTtrpgConfig().bridge.enabled, clients: bridgeStatus() }); });
  // bridge client files: the Owlbear extension (manifest + page), the Roll20 userscript, the Foundry module
  const VTT_DIR = path.join(ROOT, 'tools', 'ttrpg', 'vtt');
  // the Foundry module as a zip (Foundry's "Install Module" wants a download URL): store-only zip built on the fly
  r.get('/vtt/foundry/vtube-pro-bridge.zip', (_req, res) => {
    const dir = path.join(VTT_DIR, 'foundry', 'vtube-pro-bridge');
    const files = ['module.json', 'scripts/bridge.js'].map((f) => ({ name: `vtube-pro-bridge/${f}`, data: fs.readFileSync(path.join(dir, f)) }));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(storeZip(files));
  });
  r.get('/vtt/*rest', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');   // Owlbear loads the manifest cross-origin; these are static public files
    sendFrom(res, VTT_DIR, wildcardPath((req.params as Record<string, unknown>).rest), { shipped: true });
  });
  return r;
}

// ---------------------------------------------------------------- a minimal store-only ZIP writer (no compression)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Buffer) { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function storeZip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), crc = crc32(f.data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(f.data.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, f.data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(0, 12); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(f.data.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
