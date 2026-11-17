// Setup-wizard helpers + the "Generate new room" job (UI overhaul).
//   GET  /api/setup/status        → { busClients, outputs:{count,inObs}, aiArt }   (OBS chip: output pages on the bus)
//   POST /api/setup/probe-relay   { url } → { ok, service?, status?, error?, gone?, offline? }   (Discord wizard: is the relay
//                                 Worker up? gone: the name doesn't exist; for the saved address error = RELAY_GONE, or
//                                 RELAY_NOT_YET while it is brand new; offline: no name resolves at all, server/relayGone.ts)
//   POST /api/rooms/generate      RoomGenerateRequest → { jobId }   (records the request; room generation is coming)
//   GET  /api/rooms/requests      → the last room-generation jobs
import { Router } from 'express';
import type { LookupAddress } from 'node:dns';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { busClientCount, outputPages } from '../bus.ts';
import { listJobs, startJob } from '../jobs.ts';
import { HttpError } from '../library.ts';
import { ROOT } from '../paths.ts';
import { RELAY_DNS, RELAY_TYPO } from '../relayGone.ts';
import { ROOM_GEN_JOB, sanitizeRoomRequest } from '../../shared/roomGen.ts';
import { noteRelayAnswered, relayDnsTrouble, savedRelayUrl } from './discord.ts';

export const setupRoutes = Router();

/** The AI art pipeline another part of the project is building (tools/ai_texture, docs/AI_ART_PIPELINE.md). */
function aiArt() {
  const tool = fs.existsSync(path.join(ROOT, 'tools', 'ai_texture', 'run.py'));
  const doc = fs.existsSync(path.join(ROOT, 'docs', 'AI_ART_PIPELINE.md'));
  const blenderKit = fs.existsSync(path.join(ROOT, 'blender', 'ai_texture'));
  return { texturePipeline: tool || blenderKit, doc, roomBuilder: false };
}

setupRoutes.get('/api/setup/status', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const o = outputPages();
  res.json({ busClients: busClientCount(), outputs: { count: o.count, inObs: o.inObs }, aiArt: aiArt() });
});

/** Addresses the probe never knocks on for a page that asks it to: this PC and the home network. */
const PRIVATE_NETS = new net.BlockList();
for (const [a, b] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) PRIVATE_NETS.addSubnet(a, b, 'ipv4');
for (const [a, b] of [['::', 127], ['fc00::', 7], ['fe80::', 10]] as const) PRIVATE_NETS.addSubnet(a, b, 'ipv6');
export function privateAddress(ip: string): boolean {
  // an IPv4 address mapped into IPv6 counts as the IPv4 one, dotted (::ffff:127.0.0.1) or hex (::ffff:7f00:1)
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  const v4 = hex ? [parseInt(hex[1], 16) >> 8, parseInt(hex[1], 16) & 255, parseInt(hex[2], 16) >> 8, parseInt(hex[2], 16) & 255].join('.') : ip.replace(/^::ffff:/i, '');
  return net.isIPv4(v4) ? PRIVATE_NETS.check(v4, 'ipv4') : net.isIPv6(ip) ? PRIVATE_NETS.check(ip, 'ipv6') : false;
}

type Resolve = (host: string) => Promise<LookupAddress[]>;
/** A socket `lookup` that resolves the name once and refuses it when any answer is this PC or the home network
 *  (code EPRIVATEADDR). The socket connects to the very address checked here, so a DNS answer that changes between
 *  a check and the connect (rebinding) can't slip through; a name that doesn't resolve fails the connect. */
export function publicLookup(resolve: Resolve = (h) => dns.lookup(h, { all: true })): net.LookupFunction {
  return (host, opts, cb) => {
    resolve(host).then((addrs) => {
      if (!addrs.length) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND', hostname: host }), '');
      if (addrs.some((a) => privateAddress(a.address))) return cb(Object.assign(new Error(`${host} points at this PC or the home network`), { code: 'EPRIVATEADDR' }), '');
      if (opts?.all) cb(null, addrs); else cb(null, addrs[0].address, addrs[0].family);
    }, (e: NodeJS.ErrnoException) => cb(e, ''));
  };
}

type ProbeAnswer = { ok: boolean; status: number; json: () => Promise<unknown> };
/** GET <origin>/health: no redirects, a 64 KB answer at most, an https connection pinned by publicLookup. Errors are
 *  shaped like fetch's ("fetch failed", the socket error as the cause) so server/relayGone.ts reads them the same. */
export function pinnedGet(u: URL, timeoutMs: number, lookup = publicLookup()): Promise<ProbeAnswer> {
  return new Promise((resolve, reject) => {
    const fail = (e: Error) => reject(e.name === 'TimeoutError' ? e : new TypeError('fetch failed', { cause: e }));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(`${u.origin}/health`, { ...(u.protocol === 'https:' ? { lookup } : {}), headers: { accept: 'application/json' } }, (res) => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (c: Buffer) => { size += c.length; if (size > 64 * 1024) { res.destroy(); return; } chunks.push(c); });
      res.on('error', fail);
      res.on('close', () => {
        clearTimeout(timer);
        const status = res.statusCode ?? 0, text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text) });
      });
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), timeoutMs);
    req.on('error', (e) => { clearTimeout(timer); fail(e); });
  });
}
let probeGet: (u: URL, timeoutMs: number) => Promise<ProbeAnswer> = (u, ms) => pinnedGet(u, ms);
/** Tests: answer the probe's GET another way (tools/relay_gone_unit.ts routes it through its mocked fetch). */
export function configureProbeNet(o: { get: typeof probeGet }) { probeGet = o.get; }
const privateRefused = (e: unknown) => (e as { cause?: { code?: string } })?.cause?.code === 'EPRIVATEADDR';

/** The address the relay probe may fetch, or a 400. A relay is a public name (workers.dev / the streamer's own
 *  domain): a bare IP, a home-network name or a dotless name is refused, so the probe can't be used to knock on other
 *  devices. http://localhost (a relay under `wrangler dev`) is allowed for a relay run on this PC. */
export function relayProbeTarget(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new HttpError(400, 'That is not a web address (it should start with https://)'); }
  const devRelay = u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
  if (u.protocol !== 'https:' && !devRelay) throw new HttpError(400, 'The relay address must start with https://');
  if (u.username || u.password) throw new HttpError(400, 'The relay address must not contain a user name or password');
  const host = u.hostname.replace(/\.$/, '');   // "localhost." is localhost
  if (!devRelay && (/^\[|^[\d.]+$/.test(host) || /(^|\.)(local|lan|home|internal|localhost)$/i.test(host) || !host.includes('.'))) throw new HttpError(400, 'The relay address must be a public web address (like https://name.workers.dev)');
  return u;
}

setupRoutes.post('/api/setup/probe-relay', async (req, res) => {
  const raw = String((req.body ?? {}).url ?? '').trim().replace(/\/+$/, '');
  const u = relayProbeTarget(raw);
  try {
    // no redirects (the relay answers /health itself), and a name that resolves to this PC or the home network is
    // refused at connect time, for every caller (pinnedGet)
    const r = await probeGet(u, 6000);
    noteRelayAnswered(u.origin);   // its name resolves: no longer "brand new"
    const body = (await r.json().catch(() => null)) as { ok?: boolean; service?: string } | null;
    if (r.ok && body?.service === 'vtube-pro-relay') { res.json({ ok: true, service: body.service, status: r.status }); return; }
    res.json({ ok: false, status: r.status, error: r.ok ? 'Something answered, but it is not the VTube Pro relay (check the address).' : `The relay answered with HTTP ${r.status}.` });
  } catch (e) {
    if (privateRefused(e)) throw new HttpError(400, 'The relay address must be a public web address (like https://name.workers.dev)');
    // no such host name (server/relayGone.ts): this PC is offline, or the SAVED address was renamed / deleted (or was
    // saved minutes ago and isn't live yet); a freshly typed one has a typo or is brand new
    const v = await relayDnsTrouble(e, u.origin);
    if (v === 'offline') { res.json({ ok: false, offline: true, error: RELAY_DNS.offline.message }); return; }
    if (v) { res.json({ ok: false, gone: true, error: u.origin === savedRelayUrl() ? RELAY_DNS[v].message : RELAY_TYPO }); return; }
    res.json({ ok: false, error: `Could not reach it (${(e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message}). Is the Worker deployed?` });
  }
});

setupRoutes.post('/api/rooms/generate', (req, res) => {
  const r = sanitizeRoomRequest(req.body);
  if (!r.prompt && !r.styles.length) throw new HttpError(400, 'Describe the room (or pick a style) first');
  const art = aiArt();
  const job = startJob(ROOM_GEN_JOB, async (ctx) => {
    fs.writeFileSync(path.join(ctx.dir, 'request.json'), JSON.stringify({ ...r, createdAt: new Date().toISOString(), version: 1 }, null, 2));
    ctx.log(`Room request saved: “${r.prompt || r.styles.join(', ')}”${r.basedOn ? ` (closest existing room: ${r.basedOn})` : ''}.`);
    ctx.progress(0.5);
    ctx.log('AI room generation is not switched on in this version yet. Your request is kept in this job (request.json)');
    ctx.log('so the room builder can make it as soon as it ships. Meanwhile the studio set up the closest existing room.');
    if (art.texturePipeline) ctx.log('Found the AI texture pipeline (tools/ai_texture): it will repaint the room’s materials once the builder hands it a room.');
    ctx.progress(1);
    return { stub: true, request: ctx.fileUrl('request.json'), basedOn: r.basedOn, prompt: r.prompt };
  }, { kind: 'room', prompt: r.prompt });
  res.json({ jobId: job.id, stub: true });
});

setupRoutes.get('/api/rooms/requests', (_req, res) => {
  res.json(listJobs((j) => j.kind === ROOM_GEN_JOB, 10));
});
