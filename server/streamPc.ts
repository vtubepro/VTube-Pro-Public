// Stream PC mode (two-PC streaming), the helper side. OFF by default; off = nothing here listens or changes a request.
//
// When the user turns on "Let my stream PC connect" in the studio (OBS & stream → Streaming from a second PC):
//   * a SECOND http.Server is bound to this PC's ONE private LAN IPv4 (shared/phoneNet.ts pickLanAddress), same port as
//     the helper (default 5191). Not 0.0.0.0: a VPN / public adapter / IPv6 never even accepts a connection. Not bound
//     on a Windows network marked Public, and on Windows not before our firewall rule exists (or "Try without it").
//     Both are read by the static, read-only tools/helper/win/ps/streampc_net_query.ps1, cached for minutes (spNetQuery).
//   * EVERY request / WebSocket upgrade arriving there goes through gate() / upgrade() below, first and only:
//     same-subnet private IP, Host = this PC (DNS rebinding), same Origin, a paired token, the ALLOW-LIST
//     (shared/streamPc.ts lanVerdict). Accepted requests are marked (server/streamPcMark.ts) so the loopback guards
//     downstream know who they are; everything else is answered here (401 / 403 / 421) and never reaches a route.
//   * pairing: a 6-character code shown only in the studio on this PC -> a 32-byte token for that stream PC (only its
//     SHA-256 hash is kept, in <data>/config/stream-pc.json); listed with name / IP / last seen; Forget closes its sockets.
//   * mode A (default): OBS on the stream PC renders output.html itself. Mode B: this PC renders it in a headless system
//     browser (Chrome / Edge, muted, its own profile, incognito) and sends finished video over WebRTC to /streampc/view.
// Admin API (this PC only: requireLocal + localGuard's loopback-Origin rule for writes):
//   GET    /api/streampc                 -> SpView (state, address, code, paired PCs, firewall, sender)
//   PUT    /api/streampc {enabled?, mode?, skipFirewall?}
//   POST   /api/streampc/code            -> a new pairing code
//   DELETE /api/streampc/pcs/:id         -> forget a stream PC (its sockets close at once)
//   POST   /api/streampc/firewall        -> ONE elevated rule add (UAC), click only (x-vtp-user-action)
//   POST   /api/streampc/network-settings-> open Windows' network page (Public -> Private is the user's choice)
//   POST   /api/streampc/obs-link        -> the OBS link for "Set up OBS on my stream PC" (a token for that OBS)
// LAN pages (a stream PC): GET /streampc (pairing page), POST /streampc/pair, GET /streampc/obs (entry: mode A -> output
// page, mode B -> receiver), GET /streampc/view, GET /streampc/state.
// Test switches: VTP_STREAMPC_FAKE_NET=<json {profiles, rules}> (the Windows query's answer, also off Windows),
// VTP_TOOLS_DRYRUN=1 (the firewall add only reports its plan), VTP_STREAMPC_BROWSER (sender browser path),
// VTP_STREAMPC_SENDER_FLAGS (extra sender flags, e.g. software GL in tests).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http, { type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { Router, type Express, type NextFunction, type Request, type Response } from 'express';
import {
  SP_CODE_ALPHABET, SIGNAL_PREFIXES, isLoopbackIp, lanBusMessage, lanVerdict, normIp, normSpCode, normaliseSpRule, pcNames,
  lanClientId, lanFrom, pinLanSignal, rewriteMdns, showSpCode, unstampTo, spCookieName, spFirewallParams, spRuleOk, spTokens, stripSpToken,
  type ServeCtx, type SpMode, type SpPc, type SpRule, type SpView,
} from '../shared/streamPc.ts';
import { elevatedFileCommand, psFileCommand, psScriptExists, psScriptPath } from './psLaunch.ts';
import { networkSettingsUrl, normaliseProfiles, profileFor, type LanPick, type NetProfile } from '../shared/phoneNet.ts';
import { lanPick } from './tracking/phoneNet.ts';
import { markStreamPc, streamPcOf } from './streamPcMark.ts';
import { notPairedPage, pairPage, receiverPage } from './streamPcPages.ts';
import { CACHE_DIR, CONFIG_DIR, PORT } from './paths.ts';

/** "Chrome on Windows"-style label from a User-Agent (shown next to a device on the home network). */
export function uaLabel(ua: string | undefined): string {
  const u = String(ua ?? '');
  const b = /Edg\//.test(u) ? 'Edge' : /OPR\//.test(u) ? 'Opera' : /Firefox\//.test(u) ? 'Firefox' : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : 'A browser';
  const os = /Windows/.test(u) ? 'Windows' : /Mac OS X/.test(u) ? 'macOS' : /Android/.test(u) ? 'Android' : /Linux/.test(u) ? 'Linux' : /iPhone|iPad/.test(u) ? 'iOS' : '';
  return os ? `${b} on ${os}` : b;
}

export { streamPcOf };

// ---------------------------------------------------------------- store

interface PcRec { id: string; tokenHash: string; name: string; ip: string; created: string; lastSeen: string; via: 'code' | 'obs' }
/** obsLink: WHICH pairing "Set up OBS for me" made (its id only: like every pairing, the token is kept as a hash; the
 *  plain token lives in memory for the wizard's preview -> apply, never on disk). */
interface Store { version: 1; enabled: boolean; mode: SpMode; skipFirewall: boolean; pcs: PcRec[]; obsLink: { id: string } | null }
const EMPTY: Store = { version: 1, enabled: false, mode: 'A', skipFirewall: false, pcs: [], obsLink: null };
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
function safeEq(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); }
const clean = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, n) : '');

export const CODE_TTL_MS = 10 * 60_000;
export const CODE_TRIES = 5;
export const FAIL_WINDOW_MS = 10 * 60_000;
export const FAIL_MAX = 20;
export const IP_PER_MIN = 10;
/** Live bus connections one stream PC may hold at once. */
export const BUS_PER_PC = 6;
/** One hello / want per feed per socket this often (each may restart an encoder on the gaming PC). */
export const HELLO_EVERY_MS = 5000;
const ONLINE_MS = 15_000;

// ---------------------------------------------------------------- the network around us

export interface NetInfo { address: string | null; netmask: string | null; iface: string | null; profile: NetProfile['category'] | null; rules: SpRule[] | null; windows: boolean }
export type NetProvider = (fresh?: boolean) => Promise<NetInfo>;
/** The read-only check: tools/helper/win/ps/streampc_net_query.ps1, no parameters (beta.14.1; an inline -Command before). */
export const spQueryCommand = () => psFileCommand(psScriptPath('streampc_net_query.ps1'));
interface SpQuery { rules: SpRule[] | null; profiles: NetProfile[] }
let fakeRuleAdded = false;
/** seq: which check started last (an older check that ends late never replaces a newer answer, e.g. the one after UAC). */
let queryCache: { at: number; seq: number; lan: string; v: SpQuery } | null = null;
let querySeq = 0;
/** Checks run since the helper started (tests / diagnostics). */
export const spQueryStats = { runs: 0 };
function parseQuery(j: { rules?: unknown; profiles?: unknown }) {
  const rl = Array.isArray(j.rules) ? j.rules : j.rules && typeof j.rules === 'object' ? [j.rules] : [];
  return { rules: rl.map(normaliseSpRule).filter((r): r is SpRule => !!r), profiles: normaliseProfiles(j.profiles) };
}
function runQuery(): Promise<SpQuery> {
  spQueryStats.runs++;
  if (process.env.VTP_STREAMPC_FAKE_NET) {
    let j: { rules?: unknown[]; profiles?: unknown } = {};
    try { j = JSON.parse(process.env.VTP_STREAMPC_FAKE_NET); } catch { /* none */ }
    const q = parseQuery(j);
    if (fakeRuleAdded) q.rules.push({ enabled: true, allow: true, inbound: true, profile: 'Private', protocol: 'TCP', ports: [String(PORT)], remote: ['LocalSubnet'], program: process.execPath });
    return Promise.resolve(q);
  }
  if (process.platform !== 'win32') return Promise.resolve({ rules: [], profiles: [] });
  if (!psScriptExists(psScriptPath('streampc_net_query.ps1'))) return Promise.resolve({ rules: null, profiles: [] }); // (unknown, as a failed check: nothing runs)
  const cmd = spQueryCommand();
  return new Promise((resolve) => {
    execFile(cmd.command, cmd.args, { windowsHide: true, timeout: 15_000, maxBuffer: 1 << 20 }, (err, out) => {
      if (err && !out) { resolve({ rules: null, profiles: [] }); return; }
      try { resolve(parseQuery(JSON.parse(String(out).trim() || '{}'))); } catch { resolve({ rules: null, profiles: [] }); }
    });
  });
}
/** How long one check is used (beta.14.1). Each check is a PowerShell the helper starts by itself, and reconcile() runs
 *  every 30 s while the switch is on: once every 30 s was the kind of repeated background launch antivirus behaviour
 *  blockers watch (Emsisoft blocked a background PowerShell of this helper as an "exploit attempt"). The rule and the
 *  profile only change when the person changes them, so: QUERY_TTL_MS normally; QUERY_TTL_SETTINGS_MS for
 *  SETTINGS_WINDOW_MS after the person opened Windows' network settings from the card (they are switching the profile
 *  right now); at once when this PC's network (adapter / address) changes; `fresh` (the switch, "I switched it", the
 *  firewall button after UAC) re-asks. */
export const QUERY_TTL_MS = 300_000, QUERY_TTL_SETTINGS_MS = 20_000, SETTINGS_WINDOW_MS = 180_000;
let settingsOpenedAt = -1e12;
/** The person opened Windows' network settings from the card: check sooner for a while. */
export function noteSettingsOpened(now = Date.now()) { settingsOpenedAt = now; }
/** The network a check was made on (the adapter + address the listener binds to). */
export const spLanKey = (lan: Pick<LanPick, 'iface' | 'address'>) => `${lan.iface ?? ''}|${lan.address ?? ''}`;
/** Our firewall rule + the network profiles. `lan` = spLanKey() of the network in use (a change re-asks). */
export async function spNetQuery(fresh = false, lan = '', now = Date.now()): Promise<SpQuery> {
  const since = now - settingsOpenedAt;
  const ttl = since >= 0 && since < SETTINGS_WINDOW_MS ? QUERY_TTL_SETTINGS_MS : QUERY_TTL_MS;
  const age = queryCache ? now - queryCache.at : -1;
  if (!fresh && queryCache && queryCache.lan === lan && age >= 0 && age < ttl) return queryCache.v; // (a clock set back: asks again)
  const seq = ++querySeq;
  const v = await runQuery();
  if (!queryCache || queryCache.seq < seq) queryCache = { at: now, seq, lan, v };
  return v;
}
export async function realNet(fresh = false, now = Date.now()): Promise<NetInfo> {
  const lan = await lanPick();
  const windows = process.platform === 'win32' || !!process.env.VTP_STREAMPC_FAKE_NET;
  if (!windows) return { address: lan.address, netmask: lan.netmask, iface: lan.iface, profile: null, rules: [], windows };
  const q = await spNetQuery(fresh, spLanKey(lan), now);
  return { address: lan.address, netmask: lan.netmask, iface: lan.iface, profile: profileFor(q.profiles, lan.iface)?.category ?? null, rules: q.rules, windows };
}

// ---------------------------------------------------------------- the service

export interface StreamPcOptions { file?: string; now?: () => number; net?: NetProvider; port?: number; log?: (m: string) => void; hostname?: string }
interface Code { code: string; expires: number; tries: number }

export class StreamPc {
  readonly file: string;
  readonly port: number;
  private now: () => number;
  private net: NetProvider;
  private log: (m: string) => void;
  private hostname: string;
  private store: Store = { ...EMPTY };
  private code: Code | null = null;
  private failures: number[] = [];
  private perIp = new Map<string, number[]>();
  /** Live sockets per pairing id (HTTP keep-alive + WebSockets): closed the moment a PC is forgotten / the switch goes off. */
  private sockets = new Map<string, Set<Duplex>>();
  /** LAN bus sockets per pairing id (online + mode B receivers). */
  private busCount = new Map<string, number>();
  /** Per LAN bus socket: the page's own id for each feed (screen / tvfeed / spv), first one wins (one peer per feed). */
  private feedIds = new Map<string, Record<string, string>>();
  /** Live WebSocket connections per stream PC (every path). */
  private wsCount = new Map<string, number>();
  /** Per paired stream PC: when each feed last said hello / want (one every HELLO_EVERY_MS, all its sockets together). */
  private feedHello = new Map<string, Record<string, number>>();
  private seen = new Map<string, number>();
  private kind = new Map<string, SpPc['kind']>();
  private lan: Server | null = null;
  /** What the LAN listener serves right now (null = not listening). */
  ctx: ServeCtx | null = null;
  private status: { state: SpView['state']; says: string; iface: string | null; profile: SpView['profile']; firewall: SpView['firewall'] } =
    { state: 'off', says: 'Off', iface: null, profile: null, firewall: { supported: false, ok: false, skipped: false } };
  private app: Express | null = null;
  private main: Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private reconciling: { p: Promise<void>; fresh: boolean } | null = null;
  readonly sender = new Sender(this);

  constructor(o: StreamPcOptions = {}) {
    this.file = o.file ?? path.join(CONFIG_DIR, 'stream-pc.json');
    this.port = o.port ?? PORT;
    this.now = o.now ?? Date.now;
    this.net = o.net ?? realNet;
    this.log = o.log ?? ((m) => console.log(`[stream-pc] ${m}`));
    this.hostname = o.hostname ?? os.hostname();
    this.load();
  }

  // ---- persistence
  private load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Store>;
      this.store = {
        version: 1, enabled: j.enabled === true, mode: j.mode === 'B' ? 'B' : 'A', skipFirewall: j.skipFirewall === true,
        pcs: (Array.isArray(j.pcs) ? j.pcs : []).filter((p): p is PcRec => !!p && typeof p.id === 'string' && /^[a-f0-9]{64}$/.test(String(p.tokenHash))),
        obsLink: j.obsLink && typeof j.obsLink.id === 'string' ? { id: j.obsLink.id } : null, // (an older file's plain token is dropped here)
      };
    } catch { this.store = { ...EMPTY, pcs: [] }; }
  }
  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  get enabled() { return this.store.enabled; }
  get mode(): SpMode { return this.store.mode; }

  // ---- wiring (server/index.ts)
  /** Keep the app + the main server (its upgrade handler serves the LAN listener's sockets too) and start if it was on. */
  attach(app: Express, main: Server) {
    this.app = app; this.main = main;
    if (this.store.enabled) void this.reconcile();
    this.timer = setInterval(() => { if (this.store.enabled) void this.reconcile(); }, 30_000);
    this.timer.unref();
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopListening();
    this.sender.stop('helper closing');
  }

  // ---- listener
  /** Bring the LAN listener in line with the switch + the network (called on changes and every 30 s; the Windows check
   *  behind it is cached for minutes, spNetQuery, so a tick on an unchanged network starts no PowerShell). */
  reconcile(fresh = false): Promise<void> {
    const cur = this.reconciling;
    if (cur && (cur.fresh || !fresh)) return cur.p;
    // (a fresh ask - a click - while a tick runs: once more right after it, so the click never gets the tick's cached answer
    // or the switch as it was before the click)
    const p = cur ? cur.p.catch(() => {}).then(() => this.doReconcile(fresh)) : this.doReconcile(fresh);
    const run: { p: Promise<void>; fresh: boolean } = { fresh, p: p.finally(() => { if (this.reconciling === run) this.reconciling = null; }) };
    this.reconciling = run;
    return run.p;
  }
  private async doReconcile(fresh: boolean) {
    if (!this.store.enabled) { this.stopListening(); this.status = { ...this.status, state: 'off', says: 'Off' }; this.sender.stop('switched off'); return; }
    let n: NetInfo;
    try { n = await this.net(fresh); } catch { n = { address: null, netmask: null, iface: null, profile: null, rules: null, windows: false }; }
    const fwOk = !n.windows || spRuleOk(n.rules ?? [], this.port, process.execPath);
    const firewall = { supported: n.windows, ok: fwOk, skipped: this.store.skipFirewall };
    const base = { iface: n.iface, profile: n.profile, firewall };
    if (!n.address) { this.stopListening(); this.status = { ...base, state: 'no-network', says: 'This PC isn’t on a home network right now (no Wi-Fi or cable). Connect it, and this turns on by itself.' }; return; }
    // Windows: only a network the user marked Private (a Public, Domain, unknown or unmatched profile = not bound)
    if (n.windows && n.profile !== 'Private') { this.stopListening(); this.status = { ...base, state: 'public', says: n.profile === 'Public' ? 'Windows treats this network as Public, so your stream PC can’t connect. Switch it to Private (one setting).' : 'Windows hasn’t marked this network as your Private home network, so your stream PC can’t connect. Set it to Private (one setting).' }; return; }
    if (n.windows && !fwOk && !this.store.skipFirewall) { this.stopListening(); this.status = { ...base, state: 'firewall', says: 'One more step: let your stream PC through Windows’ firewall (Windows asks you once).' }; return; }
    const want: ServeCtx = { address: n.address, netmask: n.netmask, port: this.port, names: pcNames(this.hostname) };
    if (this.lan && this.ctx && this.ctx.address === want.address && this.ctx.netmask === want.netmask) { this.ctx = want; this.status = { ...base, state: 'listening', says: this.listeningSays() }; return; }
    this.stopListening();
    try {
      await this.listen(want);
      this.status = { ...base, state: 'listening', says: this.listeningSays() };
    } catch (e) {
      const msg = (e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Another program already uses port ${this.port} on ${want.address}. Close it, then turn this off and on.` : `VTube Pro couldn’t open the connection for your stream PC (${(e as Error).message}).`;
      this.status = { ...base, state: 'error', says: msg };
    }
  }
  private listeningSays() { return this.store.pcs.length ? 'Ready: your stream PC can connect.' : 'Ready. On your stream PC, open the address below and type the code.'; }
  private listen(ctx: ServeCtx): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.app || !this.main) { reject(new Error('not attached')); return; }
      const srv = http.createServer(this.app);
      const main = this.main;
      srv.on('upgrade', (req, socket, head) => main.emit('upgrade', req, socket, head)); // same WebSocket router (bus, feeds)
      srv.headersTimeout = 20_000; srv.requestTimeout = 60_000;
      srv.once('error', reject);
      srv.listen(this.port, ctx.address, () => {
        srv.off('error', reject);
        srv.on('error', (e) => this.log(`listener error: ${(e as Error).message}`));
        this.lan = srv; this.ctx = ctx;
        this.log(`your stream PC can connect: http://${ctx.address}:${this.port}/streampc`);
        resolve();
      });
    });
  }
  private stopListening() {
    if (this.lan) { try { this.lan.close(); } catch { /* closed */ } try { this.lan.closeAllConnections(); } catch { /* old node */ } this.log('stopped listening on the home network'); }
    this.lan = null; this.ctx = null;
    for (const set of this.sockets.values()) for (const s of set) try { s.destroy(); } catch { /* gone */ }
    this.sockets.clear();
  }

  // ---- pairing
  /** The code the studio shows (a new one when there is none / it ran out). */
  currentCode(make = true): Code | null {
    const t = this.now();
    if (this.code && (this.code.expires <= t || this.code.tries >= CODE_TRIES)) this.code = null;
    if (!this.code && make && this.store.enabled) this.code = this.newCode();
    return this.code;
  }
  newCode(): Code {
    let s = '';
    for (let i = 0; i < 6; i++) s += SP_CODE_ALPHABET[crypto.randomInt(SP_CODE_ALPHABET.length)];
    this.code = { code: s, expires: this.now() + CODE_TTL_MS, tries: 0 };
    return this.code;
  }
  private lockedOut(t: number) { this.failures = this.failures.filter((x) => t - x < FAIL_WINDOW_MS); return this.failures.length >= FAIL_MAX; }
  /** POST /streampc/pair from the stream PC: code -> token (once). */
  pair(body: unknown, ip: string, ua: string | undefined): { status: number; body: Record<string, unknown>; token?: string } {
    const t = this.now();
    const tries = (this.perIp.get(ip) ?? []).filter((x) => t - x < 60_000);
    tries.push(t); this.perIp.set(ip, tries);
    if (this.perIp.size > 256) for (const [k, v] of this.perIp) if (!v.some((x) => t - x < 60_000)) this.perIp.delete(k);
    if (tries.length > IP_PER_MIN || this.lockedOut(t)) return { status: 429, body: { error: 'Too many tries. Wait a few minutes, then use the newest code on your gaming PC.' } };
    const b = (body ?? {}) as Record<string, unknown>;
    const given = normSpCode(b.code);
    const c = this.currentCode(false);
    if (!c) { this.failures.push(t); return { status: 410, body: { error: 'That code ran out. Look at your gaming PC: it shows a new one.' } }; }
    if (!safeEq(given.padEnd(6, '?').slice(0, 16), c.code)) {
      c.tries++; this.failures.push(t);
      if (c.tries >= CODE_TRIES) { this.code = null; return { status: 410, body: { error: 'Too many wrong codes. Your gaming PC now shows a new one.' } }; }
      return { status: 400, body: { error: 'That isn’t the code. Check your gaming PC and try again.', triesLeft: CODE_TRIES - c.tries } };
    }
    this.code = null; // one use
    const name = clean(b.name, 40) || `Stream PC (${uaLabel(ua)})`;
    const { token } = this.addPc(name, ip, 'code');
    return { status: 200, body: { ok: true }, token };
  }
  private addPc(name: string, ip: string, via: PcRec['via']): { token: string; rec: PcRec } {
    const token = crypto.randomBytes(32).toString('base64url');
    const iso = new Date(this.now()).toISOString();
    const rec: PcRec = { id: crypto.randomBytes(8).toString('hex'), tokenHash: sha(token), name, ip, created: iso, lastSeen: iso, via };
    this.store.pcs.push(rec);
    this.save();
    this.log(`connected "${name}" (${ip || 'via OBS'}). Forget it any time in OBS & stream → Streaming from a second PC.`);
    return { token, rec };
  }
  /** The token's pairing, constant-time against every stored hash. */
  check(token: string): PcRec | null {
    const h = sha(token);
    let hit: PcRec | null = null;
    for (const p of this.store.pcs) if (safeEq(p.tokenHash, h)) hit = p;
    return hit;
  }
  forget(id: string): boolean {
    const n = this.store.pcs.length;
    this.store.pcs = this.store.pcs.filter((p) => p.id !== id);
    if (this.store.obsLink?.id === id) this.store.obsLink = null;
    if (this.store.pcs.length === n) return false;
    this.save();
    for (const s of this.sockets.get(id) ?? []) try { s.destroy(); } catch { /* gone */ }
    this.sockets.delete(id); this.busCount.delete(id); this.seen.delete(id); this.kind.delete(id);
    return true;
  }
  /** "Set up OBS on my stream PC": a pairing for that OBS (made on THIS PC by the user's click), kept so the wizard's plan
   *  stays the same between preview and apply. Returns the link OBS loads, or null when the switch is off. */
  obsLink(): string | null {
    if (!this.store.enabled || !this.ctx) return null;
    const id = this.store.obsLink?.id;
    const tok = id ? this.obsTokens.get(id) : undefined;
    if (id && tok && this.store.pcs.some((p) => p.id === id && safeEq(p.tokenHash, sha(tok)))) return this.entryUrl(tok);
    // (none yet, or the helper restarted: the old OBS pairing keeps working for the OBS that has it; a new one is made)
    const { token, rec } = this.addPc('OBS (set up for you)', '', 'obs');
    this.obsTokens.set(rec.id, token);
    this.store.obsLink = { id: rec.id };
    this.save();
    return this.entryUrl(token);
  }
  /** The plain token of the OBS pairing, this process only (never written). */
  private obsTokens = new Map<string, string>();
  entryUrl(token: string) { return this.ctx ? `http://${this.ctx.address}:${this.port}/streampc/obs?vtp_sp=${token}` : ''; }

  // ---- settings
  async set(patch: { enabled?: unknown; mode?: unknown; skipFirewall?: unknown }) {
    let changed = false;
    if (typeof patch.enabled === 'boolean' && patch.enabled !== this.store.enabled) { this.store.enabled = patch.enabled; changed = true; if (!patch.enabled) this.code = null; }
    if ((patch.mode === 'A' || patch.mode === 'B') && patch.mode !== this.store.mode) { this.store.mode = patch.mode; changed = true; }
    if (typeof patch.skipFirewall === 'boolean' && patch.skipFirewall !== this.store.skipFirewall) { this.store.skipFirewall = patch.skipFirewall; changed = true; }
    if (changed) { this.save(); await this.reconcile(true); this.sender.sync(); }
  }

  // ---- what the studio card shows
  view(): SpView {
    const t = this.now();
    const c = this.store.enabled && this.ctx ? this.currentCode() : null;
    return {
      enabled: this.store.enabled, mode: this.store.mode, state: this.status.state, says: this.status.says,
      address: this.ctx?.address ?? null, iface: this.status.iface, port: this.port,
      pairUrl: this.ctx ? `http://${this.ctx.address}:${this.port}/streampc` : null,
      code: c ? { code: showSpCode(c.code), expiresIn: Math.max(0, Math.round((c.expires - t) / 1000)) } : null,
      pcs: this.store.pcs.map((p) => ({ id: p.id, name: p.name, ip: p.ip, created: p.created, lastSeen: new Date(Math.max(Date.parse(p.lastSeen) || 0, this.seen.get(p.id) ?? 0)).toISOString(),
        online: (this.busCount.get(p.id) ?? 0) > 0 || t - (this.seen.get(p.id) ?? 0) < ONLINE_MS, kind: this.kind.get(p.id) ?? null, via: p.via })),
      firewall: this.status.firewall, profile: this.status.profile,
      sender: this.store.mode === 'B' ? this.sender.view() : null,
    };
  }
  receivers(): number { let n = 0; for (const v of this.busCount.values()) n += v; return n; }

  private touch(p: PcRec, ip: string) {
    const t = this.now();
    this.seen.set(p.id, t);
    if (p.ip !== ip || t - (Date.parse(p.lastSeen) || 0) > 10 * 60_000) { p.ip = ip; p.lastSeen = new Date(t).toISOString(); try { this.save(); } catch { /* best effort */ } }
  }
  private track(id: string, s: Duplex) {
    let set = this.sockets.get(id);
    if (!set) this.sockets.set(id, (set = new Set()));
    if (set.has(s)) return;
    set.add(s);
    s.once('close', () => set!.delete(s));
  }

  // ---- the gate (HTTP)
  /** True when the request arrived over the home network (not loopback-to-loopback). */
  static isLan(req: IncomingMessage) { const s = req.socket; return !!s && (!isLoopbackIp(s.localAddress) || !isLoopbackIp(s.remoteAddress)); }
  /** Express middleware, mounted FIRST: loopback requests pass untouched; LAN requests are decided here. */
  gate() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!StreamPc.isLan(req)) { next(); return; }
      const ip = normIp(req.socket.remoteAddress);
      const tokens = spTokens(req.method, req.url ?? '', { authorization: req.headers.authorization, cookie: req.headers.cookie }, this.port);
      let pc: PcRec | null = null, viaQuery = false, tok = '';
      for (const tk of tokens) { const p = this.check(tk); if (p) { pc = p; tok = tk; viaQuery = (req.url ?? '').includes(`vtp_sp=${tk}`); break; } }
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      const v = lanVerdict({ method: req.method, url: req.url ?? '', remote: ip, host: req.headers.host, origin, secFetchSite: String(req.headers['sec-fetch-site'] ?? '') || undefined, paired: !!pc }, this.ctx);
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.vary('Cookie');
      const p = (req.url ?? '').split('?')[0].toLowerCase().replace(/\/+$/, '');
      if (!v.ok) {
        if (v.status === 401 && /^\/(output\.html|streampc\/(obs|view))$/.test(p) && this.ctx) {
          res.status(401).type('html').setHeader('Cache-Control', 'no-store');
          res.send(notPairedPage({ address: this.ctx.address, port: this.port, forgotten: tokens.length > 0 }));
          return;
        }
        res.status(v.status).json({ error: v.reason, code: v.code, ...(v.code === 'pair' ? { pair: true } : {}) });
        return;
      }
      if (v.public) { void this.publicRoute(p, req, res, ip, pc); return; }
      // a paired stream PC
      this.touch(pc!, ip);
      this.track(pc!.id, req.socket);
      markStreamPc(req, { id: pc!.id, ip });
      if (viaQuery) res.append('Set-Cookie', `${spCookieName(this.port)}=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=34560000`);
      req.url = stripSpToken(req.url ?? '');
      if (/^\/api\/party\//.test(p)) res.setHeader('Cache-Control', 'no-store, max-age=0'); // guests' blobs never touch the stream PC's disk
      if (p === '/streampc/state') { res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, mode: this.store.mode, name: pc!.name }); return; }
      if (p === '/streampc/obs') {
        this.kind.set(pc!.id, 'obs');
        const qs = (req.url ?? '').includes('?') ? (req.url ?? '').slice((req.url ?? '').indexOf('?')) : '';
        const keep = new URLSearchParams(qs.slice(1)); keep.delete('vtp_sp'); // (the cookie is set: no token in the next URL)
        res.setHeader('Cache-Control', 'no-store');
        res.redirect(302, this.store.mode === 'B' ? `/streampc/view?${keep}` : `/output.html?${keep}`);
        return;
      }
      if (p === '/streampc/view') { this.kind.set(pc!.id, 'view'); res.setHeader('Cache-Control', 'no-store'); res.type('html').send(receiverPage()); return; }
      if (p === '/output.html') this.kind.set(pc!.id, 'output');
      next();
    };
  }
  private async publicRoute(p: string, req: Request, res: Response, ip: string, pc: PcRec | null) {
    res.setHeader('Cache-Control', 'no-store');
    if (p === '/streampc' && req.method !== 'POST') {
      // already paired in this browser (the cookie): straight to the OBS entry
      // (the cookie is valid: straight to the page for this mode, never a token in a URL)
      if (pc) { res.redirect(302, this.store.mode === 'B' ? '/streampc/view' : '/output.html'); return; }
      res.type('html').send(pairPage({ pcName: this.hostname, address: this.ctx!.address, port: this.port }));
      return;
    }
    if (p === '/streampc/pair' && req.method === 'POST') {
      const body = await readJson(req, 4096);
      const r = this.pair(body, ip, req.headers['user-agent']);
      if (r.token) {
        res.append('Set-Cookie', `${spCookieName(this.port)}=${r.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=34560000`);
        res.json({ ok: true, url: this.entryUrl(r.token) });
        return;
      }
      res.status(r.status).json(r.body);
      return;
    }
    res.status(404).json({ error: 'Not found' });
  }

  // ---- the gate (WebSocket upgrades): null = not a LAN socket (the loopback guard decides), true = go on, false = refused
  upgrade(req: IncomingMessage, socket: Duplex): boolean | null {
    if (!StreamPc.isLan(req)) return null;
    const ip = normIp(req.socket.remoteAddress);
    const tokens = spTokens(req.method ?? 'GET', req.url ?? '', { authorization: req.headers.authorization, cookie: req.headers.cookie }, this.port, true);
    let pc: PcRec | null = null;
    for (const tk of tokens) { pc = this.check(tk); if (pc) break; }
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const v = lanVerdict({ method: 'GET', url: req.url ?? '', remote: ip, host: req.headers.host, origin, secFetchSite: String(req.headers['sec-fetch-site'] ?? '') || undefined, upgrade: true, paired: !!pc }, this.ctx);
    if (!v.ok) {
      const text = v.status === 421 ? 'Misdirected Request' : v.status === 401 ? 'Unauthorized' : 'Forbidden';
      try { socket.end(`HTTP/1.1 ${v.status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
      setTimeout(() => socket.destroy(), 1000).unref();
      return false;
    }
    // at most BUS_PER_PC live connections per stream PC, ALL its sockets counted (/ws, /ws/screen, /ws/spout): no flood
    if ((this.wsCount.get(pc!.id) ?? 0) >= BUS_PER_PC) {
      try { socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch { /* gone */ }
      setTimeout(() => socket.destroy(), 1000).unref();
      return false;
    }
    this.touch(pc!, ip);
    this.track(pc!.id, socket);
    const id = pc!.id;
    this.wsCount.set(id, (this.wsCount.get(id) ?? 0) + 1);
    socket.once('close', () => { const n = (this.wsCount.get(id) ?? 1) - 1; if (n > 0) this.wsCount.set(id, n); else this.wsCount.delete(id); });
    markStreamPc(req, { id, ip });
    req.url = stripSpToken(req.url ?? '');
    return true;
  }

  // ---- the bus (server/bus.ts hooks)
  /** A LAN bus socket opened / closed (online, mode B receivers). */
  busOpen(id: string, conn = '') { this.busCount.set(id, (this.busCount.get(id) ?? 0) + 1); if (conn) this.feedIds.set(conn, {}); this.sender.sync(); }
  /** A LAN bus socket closed: returns the `bye` messages the helper sends for it (every feed it used), so this PC's window
   *  share, TV feeds and mode B sender close that socket's links: a closed socket never leaves an encoder running
   *  (review r4). The pacing (feedHello) is per stream PC and stays. */
  busClose(id: string, conn = ''): Record<string, unknown>[] {
    const n = (this.busCount.get(id) ?? 1) - 1; if (n > 0) this.busCount.set(id, n); else this.busCount.delete(id);
    const used = Object.keys(this.feedIds.get(conn) ?? {});
    this.feedIds.delete(conn);
    this.sender.sync();
    return conn ? used.map((type) => ({ type, k: 'bye', from: lanFrom(conn) })) : [];
  }
  /** A message FROM a stream PC page: allow-listed, candidates rewritten to its real address. null = drop. */
  busIn(text: string, ip: string, conn: string, pcId: string = conn): string | null {
    const m = lanBusMessage(text);
    if (!m) return null;
    // WebRTC signalling: ONE peer per feed per socket (the first id the page uses for that feed; any other is dropped),
    // `from` = the helper's id for THIS socket, candidates must be this socket's own address
    const signal = m.type === 'screen' || m.type === 'tvfeed' || m.type === 'spv';
    if (signal) {
      const cid = lanClientId(m.from);
      if (!cid) return null;
      let ids = this.feedIds.get(conn);
      if (!ids) this.feedIds.set(conn, (ids = {}));
      const t = String(m.type);
      if (ids[t] === undefined) ids[t] = cid;
      else if (ids[t] !== cid) return null;
      // a hello / want starts (or restarts) an encoder on this PC: at most one per feed per PAIRED stream PC (all its
      // sockets together, so new sockets don't reset it) every HELLO_EVERY_MS (review r4)
      if (m.k === 'hello' || m.k === 'want') {
        let h = this.feedHello.get(pcId);
        if (!h) this.feedHello.set(pcId, (h = {}));
        const now = this.now();
        if (h[t] !== undefined && now - h[t] < HELLO_EVERY_MS) return null;
        h[t] = now;
      }
    }
    const fixed = signal ? pinLanSignal(m, ip, conn) : m;
    if (!fixed) return null;
    if (fixed.type === 'spv') this.sender.fromReceiver(fixed);
    return JSON.stringify(fixed);
  }
  /** A message going TO a stream PC page: this PC's own mDNS names become its LAN address. Prefix test first. */
  busOut(data: Buffer | string, conn: string): Buffer | string | null {
    const head = typeof data === 'string' ? data.slice(0, 20) : data.subarray(0, 20).toString('utf8');
    // (this PC's graphics-card reading is about this PC: a stream PC's page must not judge its own card by it)
    if (head.startsWith('{"type":"gpustat"')) return null;
    if (!SIGNAL_PREFIXES.some((p) => head.startsWith(p))) return data;
    let m: Record<string, unknown>;
    try { m = JSON.parse(String(data)) as Record<string, unknown>; } catch { return null; }
    const to = unstampTo(m, conn, this.feedIds.get(conn)?.[String(m.type)]); // (another socket's signalling is not delivered here)
    if (!to) return null;
    return JSON.stringify(this.ctx ? rewriteMdns(to, this.ctx.address) : to);
  }

  // ---- admin routes (this PC only)
  routes() {
    const r = Router();
    const local = (req: Request) => {
      if (StreamPc.isLan(req) || !isLoopbackIp(req.socket.remoteAddress)) { const e = new Error('This only works on this PC') as Error & { status: number }; e.status = 403; throw e; }
    };
    const click = (req: Request) => { if (req.headers['x-vtp-user-action'] !== '1') { const e = new Error('Press the button in VTube Pro on this PC') as Error & { status: number }; e.status = 403; throw e; } };
    r.get('/api/streampc', async (req, res) => { local(req); res.setHeader('Cache-Control', 'no-store'); if (req.query.fresh === '1' && this.store.enabled) await this.reconcile(true); res.json(this.view()); });
    r.put('/api/streampc', async (req, res) => {
      local(req); res.setHeader('Cache-Control', 'no-store');
      const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      if (b.skipFirewall !== undefined) click(req); // ("Try without it" is a click, like the firewall button)
      await this.set({ enabled: b.enabled, mode: b.mode, skipFirewall: b.skipFirewall });
      res.json(this.view());
    });
    r.post('/api/streampc/code', (req, res) => { local(req); res.setHeader('Cache-Control', 'no-store'); if (this.store.enabled) this.newCode(); res.json(this.view()); });
    r.delete('/api/streampc/pcs/:id', (req, res) => { local(req); res.setHeader('Cache-Control', 'no-store'); res.json({ ok: this.forget(String(req.params.id)), view: this.view() }); });
    let lastFw = 0;
    r.post('/api/streampc/firewall', async (req, res) => {
      local(req); click(req); res.setHeader('Cache-Control', 'no-store');
      if (Date.now() - lastFw < 2000) { res.status(429).json({ ok: false, says: 'One moment…' }); return; }
      lastFw = Date.now();
      const out = await addSpFirewallRule(this.port);
      await this.reconcile(true); // (a click: its own check, after any tick in flight that may have read the rule before the add)
      res.json({ ...out, view: this.view() });
    });
    r.post('/api/streampc/network-settings', async (req, res) => {
      local(req); click(req); res.setHeader('Cache-Control', 'no-store');
      res.json(openNetSettings(this.status.iface));
    });
    r.post('/api/streampc/obs-link', (req, res) => {
      local(req); res.setHeader('Cache-Control', 'no-store');
      const url = this.obsLink();
      if (!url) { res.status(409).json({ ok: false, says: 'Turn on “Let my stream PC connect” first.' }); return; }
      res.json({ ok: true, url });
    });
    return r;
  }
}

async function readJson(req: Request, max: number): Promise<unknown> {
  if (req.body !== undefined && typeof req.body === 'object') return req.body; // express.json already ran (not here: gate is first)
  return new Promise((resolve) => {
    let n = 0; const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => { n += c.length; if (n > max) { req.destroy(); resolve(null); return; } parts.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || 'null')); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

// ---------------------------------------------------------------- Windows: firewall rule + network settings

let adding = false;
/** The user pressed "Let my stream PC through": ONE elevated PowerShell (Windows shows its UAC prompt). */
export async function addSpFirewallRule(port: number): Promise<{ ok: boolean; says: string; dryRun?: boolean; plan?: { command: string; args: string[] } }> {
  if (process.platform !== 'win32' && !process.env.VTP_STREAMPC_FAKE_NET) return { ok: true, says: 'Nothing to do: only Windows needs this.' };
  const script = psScriptPath('firewall_streampc.ps1');
  const plan = elevatedFileCommand(script, spFirewallParams(port, process.execPath));
  if (process.env.VTP_TOOLS_DRYRUN === '1' || process.platform !== 'win32') {
    fakeRuleAdded = !!process.env.VTP_STREAMPC_FAKE_NET;
    queryCache = null; // (the next check re-asks, as after a real add)
    return { ok: true, dryRun: true, says: 'Dry run: nothing changed.', plan };
  }
  if (adding) return { ok: false, says: 'Windows is already asking. Look for its prompt (it may be behind this window).' };
  adding = true;
  try {
    const code = await new Promise<number>((resolve) => {
      if (!psScriptExists(script)) { resolve(-1); return; } // (script missing: fails like PowerShell failing, nothing runs)
      const c = spawn(plan.command, plan.args, { windowsHide: true, stdio: 'ignore' });
      c.on('error', () => resolve(-1));
      c.on('exit', (n) => resolve(n ?? -1));
    });
    queryCache = null;
    const q = await spNetQuery(true, spLanKey(await lanPick())); // (fresh: the person just answered UAC)
    if (spRuleOk(q.rules ?? [], port, process.execPath)) return { ok: true, says: 'Done: your stream PC can reach VTube Pro on your home network now.' };
    return { ok: false, says: code === 0 ? 'Windows didn’t add it. Try once more, or press “Try without it”.' : 'Windows didn’t get a “Yes”, so nothing changed. Press the button again and choose Yes.' };
  } finally { adding = false; }
}
function openNetSettings(iface: string | null): { ok: boolean; says: string; url: string; dryRun?: boolean } {
  const url = networkSettingsUrl(iface);
  const says = 'Windows Settings opens: click your network, then choose “Private network”.';
  noteSettingsOpened(); // (they are switching the profile now: the 30 s reconcile checks again sooner for a few minutes)
  if (process.env.VTP_TOOLS_DRYRUN === '1' || process.platform !== 'win32') return { ok: process.platform === 'win32' || !!process.env.VTP_STREAMPC_FAKE_NET, says, url, dryRun: true };
  try { const c = spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true }); c.on('error', () => {}); c.unref(); return { ok: true, says, url }; }
  catch { return { ok: false, says: 'We couldn’t open Settings. Open Settings → Network & internet yourself.', url }; }
}

// ---------------------------------------------------------------- mode B: the renderer on this PC

/** The system's own Chromium browser (Edge ships with Windows). */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = fs.existsSync): string | null {
  if (env.VTP_STREAMPC_BROWSER) return exists(env.VTP_STREAMPC_BROWSER) ? env.VTP_STREAMPC_BROWSER : null;
  const pf = env.PROGRAMFILES || 'C:\\Program Files', pf86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', la = env.LOCALAPPDATA || '';
  const list = platform === 'win32' ? [
    `${pf}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Google\\Chrome\\Application\\chrome.exe`, la && `${la}\\Google\\Chrome\\Application\\chrome.exe`,
    `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ] : platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'];
  return list.find((p) => !!p && exists(p)) || null;
}
/** Extra sender flags (VTP_STREAMPC_SENDER_FLAGS, tests: software GL) - an allow-list: nothing that opens a debugging
 *  port, turns off web security, loads code or changes the profile can get in. */
export function senderFlagOk(a: string): boolean {
  return /^--(use-angle=(swiftshader|d3d11|d3d9|gl|vulkan|metal|default)|use-gl=(angle|egl|swiftshader)|enable-unsafe-swiftshader|disable-gpu|ignore-gpu-blocklist|enable-gpu-rasterization|force-device-scale-factor=[0-9.]{1,4})$/i.test(a);
}
/** The sender's command line: headless, MUTED, its own throwaway profile, incognito (nothing on disk), never throttled.
 *  --remote-debugging-pipe is a watchdog, not a remote control: the pipe is only to the helper process (no port) and
 *  carries one call (sizePage: the page = the OBS canvas size); when the helper ends for ANY reason (crash, killed, update) the pipe closes and the
 *  browser quits by itself (Windows does not end child processes with their parent).
 *  `o` is for the guest browser source (server/guestFeed.ts): its own page and window size. Mode B passes nothing and gets the same command line as ever. */
export function senderArgs(port: number, profileDir: string, extra = '', stamp = false, query = '', o: { page?: string; w?: number; h?: number } = {}): string[] {
  return [
    '--headless=new', '--mute-audio', '--incognito', '--remote-debugging-pipe', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-features=WebRtcHideLocalIpsWithMdns,CalculateNativeWinOcclusion', '--autoplay-policy=no-user-gesture-required',
    `--window-size=${o.w ?? 1920},${o.h ?? 1080}`, '--hide-scrollbars', '--disable-extensions', '--disable-sync', '--disable-default-apps',
    ...extra.split(/\s+/).filter(senderFlagOk),
    `http://127.0.0.1:${port}/${o.page ?? `output.html?spSend=1${stamp ? '&spStamp=1' : ''}`}${query}`,
  ];
}

/** The pipe's one job besides the watchdog: make the hidden page exactly the OBS canvas (1920 x 1080). Headless Chrome's
 *  --window-size counts the (invisible) window frame, so the page came out 1898 x 982 (measured): stretched in OBS.
 *  Device metrics override over the pipe (the same call test tools use for a viewport); nothing else is ever sent. */
export function sizePage(p: ChildProcess, w: number, h: number) {
  const out = p.stdio[3] as NodeJS.WritableStream | null, inp = p.stdio[4] as NodeJS.ReadableStream | null;
  if (!out || !inp) return;
  let id = 0, buf = '';
  const waits = new Map<number, (m: { result?: Record<string, unknown>; error?: unknown }) => void>();
  inp.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    for (let i = buf.indexOf('\0'); i >= 0; i = buf.indexOf('\0')) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line) as { id?: number; result?: Record<string, unknown>; error?: unknown }; const f = m.id ? waits.get(m.id) : undefined; if (f) { waits.delete(m.id!); f(m); } } catch { /* event */ }
    }
    if (buf.length > 1 << 20) buf = '';
  });
  out.on('error', () => {});
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<{ result?: Record<string, unknown>; error?: unknown }>((resolve) => {
    const n = ++id; waits.set(n, resolve);
    try { out.write(`${JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })}\0`); } catch { waits.delete(n); resolve({ error: 'closed' }); return; }
    setTimeout(() => { if (waits.delete(n)) resolve({ error: 'timeout' }); }, 5000);
  });
  const sized = new Set<string>();
  const tick = async () => {
    const r = await send('Target.getTargets');
    for (const t of ((r.result?.targetInfos ?? []) as { targetId: string; type: string }[])) {
      if (t.type !== 'page' || sized.has(t.targetId)) continue;
      const a = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const sid = a.result?.sessionId as string | undefined;
      if (!sid) continue;
      const o = await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sid);
      if (!o.error) sized.add(t.targetId);
    }
  };
  const timer = setInterval(() => void tick().catch(() => {}), 1500);
  void tick().catch(() => {});
  p.once('exit', () => clearInterval(timer));
}

class Sender {
  private proc: ChildProcess | null = null;
  private stopT: NodeJS.Timeout | null = null;
  private restarts: number[] = [];
  private says = 'Waiting for your stream PC.';
  private stats: Record<string, unknown> | null = null;
  private wantAt = 0;
  constructor(private sp: StreamPc) {}
  get running() { return !!this.proc; }
  view() { return { running: this.running, says: this.says, stats: this.stats }; }
  /** A message from a mode-B receiver (want / stats). */
  fromReceiver(m: Record<string, unknown>) {
    if (m.k === 'want') { this.wantAt = Date.now(); this.sync(); }
    if (m.k === 'stats' && m.stats && typeof m.stats === 'object') this.stats = { ...(m.stats as Record<string, unknown>), at: Date.now() };
  }
  /** Run while mode B is on, the LAN listener is up and a receiver is there (or asked in the last 10 s). */
  sync() {
    const want = this.sp.enabled && this.sp.mode === 'B' && !!this.sp.ctx && (this.sp.receivers() > 0 || Date.now() - this.wantAt < 10_000);
    if (want) { if (this.stopT) { clearTimeout(this.stopT); this.stopT = null; } if (!this.proc) this.start(); }
    else if (this.proc && !this.stopT) this.stopT = setTimeout(() => { this.stopT = null; this.stop('no stream PC watching'); }, this.sp.mode === 'B' && this.sp.enabled ? 30_000 : 0);
  }
  private start() {
    const t = Date.now();
    this.restarts = this.restarts.filter((x) => t - x < 120_000);
    if (this.restarts.length >= 4) { this.says = 'The picture maker on this PC keeps closing. Switch to “Draw on the stream PC”, or restart VTube Pro.'; return; }
    const exe = findBrowser();
    if (!exe) { this.says = 'Mode B needs Google Chrome or Microsoft Edge on this PC. Install one, or use “Draw on the stream PC”.'; return; }
    this.restarts.push(t);
    const dir = path.join(CACHE_DIR, `streampc-sender-${this.sp.port}`); // (this user's own data folder, not the shared temp)
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* in use */ }
    const q = /^[&a-z0-9=._-]{0,120}$/i.test(process.env.VTP_STREAMPC_SENDER_QUERY ?? '') ? process.env.VTP_STREAMPC_SENDER_QUERY ?? '' : ''; // (tests: e.g. &gfx=low)
    const p = spawn(exe, senderArgs(this.sp.port, dir, process.env.VTP_STREAMPC_SENDER_FLAGS ?? '', process.env.VTP_STREAMPC_STAMP === '1', q), { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true, detached: false });
    sizePage(p, 1920, 1080);
    this.proc = p;
    this.says = 'Drawing on this PC and sending to your stream PC.';
    p.on('error', (e) => { this.says = `The picture maker didn’t start (${e.message}).`; });
    p.on('exit', () => { if (this.proc === p) { this.proc = null; try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } setTimeout(() => this.sync(), 3000); } });
    console.log(`[stream-pc] mode B: drawing on this PC (${path.basename(exe)}, muted, headless)`);
  }
  stop(why: string) {
    if (this.stopT) { clearTimeout(this.stopT); this.stopT = null; }
    const p = this.proc;
    this.proc = null;
    if (p) { try { p.kill(); } catch { /* gone */ } console.log(`[stream-pc] mode B renderer stopped (${why})`); }
    this.says = 'Waiting for your stream PC.';
  }
}

// ---------------------------------------------------------------- process-wide instance
let shared: StreamPc | null = null;
export const streamPc = () => (shared ??= new StreamPc());
/** server/localGuard.ts guardUpgrade: null = not a home-network socket (the loopback rules apply as before). */
export function streamPcUpgrade(req: IncomingMessage, socket: Duplex): boolean | null { return StreamPc.isLan(req) ? streamPc().upgrade(req, socket) : null; }
/** Tests: a private instance. */
export function setStreamPc(s: StreamPc | null) { shared = s; }
process.once('exit', () => { try { shared?.sender.stop('exit'); } catch { /* */ } });
