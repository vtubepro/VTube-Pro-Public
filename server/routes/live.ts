// Live-show endpoints: OBS output layout (size / position / framing) and the party (multiplayer) RAM vault.
//
// Party members' avatars arrive in the studio over an encrypted WebRTC data channel (src/party.ts). They are
// NEVER written to disk: the studio seals them (AES-GCM, per-member key) and parks the ciphertext in this
// server's RAM vault (server/partyVault.ts) so this PC's OBS output pages — which get the key + capability over
// the loopback bus — can open them. See docs/MULTIPLAYER_DISCORD.md "Model custody".
import express, { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { OutputSettings } from '../../shared/types.ts';
import { normalizeProfile } from '../../shared/defaults.ts';
import { broadcast } from '../bus.ts';
import { HttpError } from '../library.ts';
import { CACHE_DIR } from '../paths.ts';
import { requireLocal } from './util.ts';
import { VAULT_MAX_ITEM, requireLocalPage, vaultAlive, vaultDrop, vaultGet, vaultPurge, vaultPut } from '../partyVault.ts';

export const liveRoutes = Router();

// ---------------------------------------------------------------- OBS output layout
const OUTPUT_FILE = path.join(CACHE_DIR, 'output.json');
const DEFAULT_OUTPUT: OutputSettings = { scale: 1, offset: [0, 0], focus: 'bust', layout: 'row' };
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

function readOutput(): OutputSettings {
  try { return sanitizeOutput(JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'))); } catch { return { ...DEFAULT_OUTPUT }; }
}
function sanitizeOutput(o: Partial<OutputSettings> | null | undefined): OutputSettings {
  const off = Array.isArray(o?.offset) ? o!.offset : [0, 0];
  return {
    scale: num(o?.scale, 0.2, 5, 1),
    offset: [num(off[0], -1, 1, 0), num(off[1], -1, 1, 0)],
    focus: o?.focus === 'full' || o?.focus === 'head' ? o.focus : 'bust',
    layout: o?.layout === 'grid' || o?.layout === 'free' ? o.layout : 'row',
  };
}

liveRoutes.get('/api/output', (_req, res) => { res.json(readOutput()); });
liveRoutes.put('/api/output', async (req, res) => {
  requireLocal(req);
  const s = sanitizeOutput({ ...readOutput(), ...(req.body ?? {}) });
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  await fsp.writeFile(OUTPUT_FILE, JSON.stringify(s, null, 2));
  broadcast({ type: 'output', settings: s });
  res.json(s);
});

// ---------------------------------------------------------------- party: RAM vault (sealed blobs only)
// Legacy disk store (cache/party/<peer>/model.glb …, before 2026-09-24): other people's models must not persist
// on this PC — delete whatever an older build left behind, and refuse the old routes.
const LEGACY_PARTY_DIR = path.join(CACHE_DIR, 'party');
try { fs.rmSync(LEGACY_PARTY_DIR, { recursive: true, force: true }); } catch { /* not there */ }

const noStore = (res: express.Response) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
};
liveRoutes.put('/api/party/vault', express.raw({ type: () => true, limit: VAULT_MAX_ITEM }), (req, res) => {
  requireLocalPage(req);
  noStore(res);
  res.json(vaultPut(String(req.headers['x-vtp-session'] ?? ''), req.body as Buffer));
});
liveRoutes.get('/api/party/vault/:id', (req, res) => {
  requireLocalPage(req);
  const data = vaultGet(String(req.params.id), req.headers['x-vtp-cap']);
  noStore(res);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'inline');
  res.end(data);
});
liveRoutes.delete('/api/party/vault/:id', (req, res) => {
  requireLocalPage(req);
  noStore(res);
  vaultDrop(String(req.params.id), req.headers['x-vtp-cap']);
  res.json({ ok: true });
});
liveRoutes.post('/api/party/vault/session/:sid/alive', (req, res) => { requireLocalPage(req); noStore(res); res.json({ ok: vaultAlive(String(req.params.sid)) }); });
liveRoutes.post('/api/party/vault/session/:sid/purge', (req, res) => { requireLocalPage(req); noStore(res); res.json({ purged: vaultPurge(String(req.params.sid)) }); });
// old disk-backed routes: gone for good
liveRoutes.all('/api/party/:peer/{*rest}', (_req, res) => { res.status(410).json({ error: 'Party avatars are no longer stored on disk (RAM vault only)' }); });
