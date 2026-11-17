// Guest browser source ("Be a guest on someone else's show"), the helper side: process, config and API.
// Spec: docs/GUEST_BROWSER_SOURCE.md (sections 5.1 and 10); the shared contract is shared/guestFeed.ts.
//
// OFF by default; off = no browser, no link, nothing listens. When the user presses "Turn on" in the studio card:
//   * a link id is made (newGuestLinkId), the signalling server is checked ONCE for this link: it must be the streamer's own
//     invite server (config/discord.json relayUrl), and its GET /health must say phone:1 within 3 s; with none, turning on is
//     refused with a plain sentence (there is no shared server; VTP_GUESTFEED_RELAY overrides in tests) and
//     everything is saved in <data>/config/guest-feed.json (atomic write; id + lock + the link's signing key pair are secrets of the link: deleted on turn-off);
//   * a signing key pair (ECDSA P-256) is made with every new link id: the public half rides in the link's #fragment, the sender page signs its
//     answers with the private half (shared/guestFeed.ts gsSignAnswer) and the viewer refuses any answer that is not signed by it;
//   * a headless system browser (Chrome / Edge, muted, throwaway profile, incognito, below-normal CPU priority) opens
//     http://127.0.0.1:<port>/output.html?gsSend=1&gst=<token> (the SENDER page, src/guestSend.ts). It opens the link on the
//     relay, answers the other streamer's OBS page and sends the packed picture. Voice never goes through here.
//   * the card shows the link (buildViewUrl, relay + id only in the #fragment) and what the sender page reports.
// API (this PC only: loopback, never the home network):
//   GET    /api/guestfeed             -> GsView        (?fresh=1 re-checks which server a NEW link would use, while off)
//   PUT    /api/guestfeed             -> GsView        click only (x-vtp-user-action: 1); GsSettings via sanitizeSettings
//   POST   /api/guestfeed/renew       -> GsView        click only: New link (the old one answers "turned off")
//   DELETE /api/guestfeed             -> GsView        click only: Turn off (id + lock deleted, browser ends)
//   POST   /api/guestfeed/knock       -> GsView        click only: {kid, allow} (Allow / Block an unknown OBS)
//   GET    /api/guestfeed/sender      -> GsSenderConfig   the sender page only (header x-vtp-gs: <token>); carries the private signing key
//   POST   /api/guestfeed/report      -> {ok}          the sender page only, once a second (GsReport)
// Bus: {type:'gs', k:'cfg'|'off'|'decide', sig} to the sender page. It carries NO secret (no link id, relay, key or credentials);
// `sig` is an HMAC of the message keyed by the sender's own token, so no other bus client can switch it off or allow a viewer.
// Test switches: VTP_GUESTFEED_RELAY (forces the relay: the mock relay), VTP_GUESTFEED_NO_BROWSER=1 (never spawns the browser),
// VTP_GUESTFEED_SENDER_QUERY (an allow-listed extra query such as &gsStamp=1), VTP_GUESTFEED_TOKEN (a fixed 32-hex sender token, so a test can start the sender page itself), VTP_GUESTFEED_VIEW_PAGE (another loopback
// http://127.0.0.1:<port>/view.html than this server's own), VTP_GUESTFEED_RAW_HOST=1 (keep the browser's raw LAN
// candidates: a loopback test cannot resolve the mDNS names a real run hides them behind); the existing VTP_STREAMPC_BROWSER
// and VTP_STREAMPC_SENDER_FLAGS apply to this sender too.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn, execFile, type ChildProcess } from 'node:child_process';
import { Router, type Request, type Response } from 'express';
import {
  GS_IDLE_OFF_MS, GS_KEY_RX, GS_AUTO_OFF_MIN, GS_MAX_VIEWERS, GS_RESTARTS_MAX, GS_RESTART_WINDOW_MS, GS_VIEWER_STALE_MS, GS_VIEW_PATH,
  GS_PRIV_RX, GS_PUB_RX, PHONE_LINK_ID_RX, asQuality, buildViewUrl, cardText, cleanRelay, clampDelay, gsPrivateJwk, gsTier, newGuestLinkId, privacyText,
  gsBusCanon, sanitizeKnockReply, sanitizeName, sanitizeReport, sanitizeSettings,
  type GsBusMsg, type GsPrivacy, type GsQuality, type GsReport, type GsSenderConfig, type GsSettings, type GsView, type GsCardState,
} from '../shared/guestFeed.ts';
import { isLoopbackIp } from '../shared/streamPc.ts';
import { StreamPc, findBrowser as realFindBrowser, senderArgs, sizePage as realSizePage } from './streamPc.ts';
import { lowerPriority } from './lowPriority.ts';
import { CACHE_DIR, CONFIG_DIR, PORT } from './paths.ts';


// ---------------------------------------------------------------- store (config/guest-feed.json)

interface Store {
  version: 1; enabled: boolean; id: string | null; idAt: number; relay: string | null; relayKind: 'own' | 'official' | null;
  name: string; q: GsQuality; delayMs: number; autoOffMin: number; lock: string[]; lastViewerAt: number;
  /** the link's ECDSA P-256 key pair: public point (87 chars, in the link) and private scalar (43 chars, only for the sender page). Made with the link id, rotated by New link. */
  pk: string | null; sk: string | null;
}
const EMPTY: Store = { version: 1, enabled: false, id: null, idAt: 0, relay: null, relayKind: null, name: '', q: 720, delayMs: 0, autoOffMin: 0, lock: [], lastViewerAt: 0, pk: null, sk: null };

/** A new signing key pair for one link. */
export function newGuestKeyPair(): { pk: string; sk: string } {
  const j = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string };
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]);
  return { pk: raw.toString('base64url'), sk: j.d };
}
/** Is this a usable pair (right shapes, and the public point really is the private scalar's)? */
export function guestKeyPairOk(pk: unknown, sk: unknown): pk is string {
  if (typeof pk !== 'string' || typeof sk !== 'string' || !GS_PUB_RX.test(pk) || !GS_PRIV_RX.test(sk)) return false;
  try {
    // (node takes x / y on trust when it imports a private JWK, so prove the pair by using it: sign with the scalar, verify with the public point)
    const jwk = gsPrivateJwk(pk, sk);
    const priv = crypto.createPrivateKey({ key: jwk as never, format: 'jwk' });
    const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } as never, format: 'jwk' });
    const msg = Buffer.from('vtp-gs-key-check');
    return crypto.verify('sha256', msg, pub, crypto.sign('sha256', msg, priv));
  } catch { return false; }
}

/** The sender page's own token (random per browser start, in its page URL, never in the config). */
const TOKEN_RX = /^[a-f0-9]{32}$/;
function safeEq(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); }

/** The browser stops this long after a turn-off / New link was broadcast, so the sender page can tell its viewers first. */
export const GRACE_MS = 1200;
/** A crashed browser is started again after this. */
export const RESTART_DELAY_MS = 3000;
/** The sender page has not reported for this long although its browser runs: something is wrong with it. */
export const SILENT_MS = 45_000;
/** Changes from the card faster than this get "One moment…". */
export const CHANGE_EVERY_MS = 500;
/** Sender reports per second (the page sends one a second). */
export const REPORTS_PER_S = 5;
const TICK_MS = 500;
/** Chrome sets its own priority on its child processes (the GPU process above normal, renderers normal), so lowering only the
 *  browser's first process leaves the heavy ones at full priority. Windows: walk the tree a few times after the start, then rarely. */
/** Gaps: 2.5 s after the start, then 2 s, 3 s and 5 s later. */
export const TREE_SWEEPS_MS = [2500, 2000, 3000, 5000];
/** Safety net only: the tree is also walked when the sender (re)starts, a viewer connects or the tier changes (never on a blind minute timer). */
export const TREE_SWEEP_EVERY_MS = 300_000;
/** An event (viewer connected, tier changed) walks the tree after this, and never more often than TREE_SWEEP_MIN_GAP_MS. */
export const TREE_EVENT_DELAY_MS = 1500;
export const TREE_SWEEP_MIN_GAP_MS = 10_000;
/** The script the walk runs. It lowers ITSELF first so the walk never competes with the game at normal priority. */
export function lowerTreeScript(pid: number): string {
  return `$ErrorActionPreference='SilentlyContinue';try{(Get-Process -Id $PID).PriorityClass='BelowNormal'}catch{};$all=@(Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId);`
    + `$ids=New-Object 'System.Collections.Generic.HashSet[int]';[void]$ids.Add(${pid});`
    + `do{$n=0;foreach($q in $all){if($ids.Contains([int]$q.ParentProcessId) -and $ids.Add([int]$q.ProcessId)){$n++}}}while($n -gt 0);`
    + `foreach($i in $ids){$x=Get-Process -Id $i;if($x -and ('Normal','AboveNormal','High') -contains [string]$x.PriorityClass){$x.PriorityClass='BelowNormal'}}`;
}
export function realLowerTree(pid: number | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || (pid as number) <= 0 || env.VTP_SIDECAR_PRIORITY === 'normal') return;
  try {
    const c = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', lowerTreeScript(pid as number)], { windowsHide: true, timeout: 30_000 }, () => { /* best effort */ });
    if (c.pid) { try { os.setPriority(c.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* the script lowers itself too */ } }
  } catch { /* stays as it is */ }
}

/** The sender browser's throwaway profile folders: guestfeed-sender-<port>-<n> in the cache folder (this exact shape only). */
export const SENDER_PROFILE_RX = /^guestfeed-sender-\d+-\d+$/;
/** Only this helper's own folders (its port): another helper on this computer may have a browser running in its folder. */
export const senderProfileRxFor = (port: number): RegExp => new RegExp(`^guestfeed-sender-${Math.trunc(port)}-\\d+$`);
/** A profile folder this old at helper start belongs to a browser that is long gone. */
export const STALE_PROFILE_MS = 24 * 3600 * 1000;
/** Delete the sender profile folders in `cacheDir` that were last touched more than STALE_PROFILE_MS ago (a crash, a kill, or a
 *  helper that ended before the browser's files were unlocked leave them behind). Only folders named exactly like
 *  SENDER_PROFILE_RX AND carry this helper's own port (guestfeed-sender-<port>-<n>) are looked at: never another helper's
 *  folder, never a junction or symlink. Returns the names removed. */
export async function sweepStaleSenderProfiles(cacheDir: string, now = Date.now(), olderThanMs = STALE_PROFILE_MS, port: number = PORT): Promise<string[]> {
  const own = senderProfileRxFor(port);
  const removed: string[] = [];
  let names: fs.Dirent[] = [];
  try { names = await fs.promises.readdir(cacheDir, { withFileTypes: true }); } catch { return removed; }
  for (const e of names) {
    if (e.isSymbolicLink() || !e.isDirectory() || !SENDER_PROFILE_RX.test(e.name) || !own.test(e.name)) continue;
    const dir = path.join(cacheDir, e.name);
    try {
      const st = await fs.promises.lstat(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) continue; // (a junction reads as a link here: never followed)
      if (now - st.mtimeMs < olderThanMs) continue;
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      removed.push(e.name);
    } catch { /* in use: the next start tries again */ }
  }
  return removed;
}

/** No invite server of the streamer's own that can carry a guest link (there is no shared one). */
export class NoRelayError extends Error {}

export interface GuestFeedOptions {
  file?: string; cacheDir?: string; port?: number; now?: () => number; log?: (m: string) => void; env?: NodeJS.ProcessEnv;
  /** GET <relay>/health (tests: a stub). */
  fetch?: (url: string, init?: { signal?: AbortSignal; redirect?: 'error' | 'follow' | 'manual' }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  /** The streamer's own invite server (config/discord.json relayUrl) or null. */
  ownRelay?: () => string | null | Promise<string | null>;
  probeMs?: number;
  spawn?: typeof nodeSpawn; findBrowser?: () => string | null;
  lower?: (pid: number | undefined) => boolean;
  /** Lower the browser's whole process tree (Windows; tests stub it). */
  lowerTree?: (pid: number | undefined) => void;
  size?: (p: ChildProcess, w: number, h: number) => void;
  bus?: (m: GsBusMsg) => void;
  noBrowser?: boolean;
  graceMs?: number;
}
type Fetch = NonNullable<GuestFeedOptions['fetch']>;

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => new Promise<T>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

/** The extra query a test may add to the sender page (shape only: &key=value pairs, short, no path, no way to change gsSend / gst). */
export function senderQueryOk(q: string): boolean {
  return /^(&[a-z0-9]{1,16}=[a-z0-9._-]{0,16}){0,6}$/i.test(q) && !/(^|&)(gsSend|gst)=/i.test(q);
}

export class GuestFeed {
  readonly file: string;
  readonly cacheDir: string;
  readonly port: number;
  /** Profile folders of the browsers started by this object (removed when their browser exits, and at shutdown). */
  private profiles = new Set<string>();
  private now: () => number;
  private log: (m: string) => void;
  private env: NodeJS.ProcessEnv;
  private fetchFn: Fetch;
  private ownRelay: NonNullable<GuestFeedOptions['ownRelay']>;
  private probeMs: number;
  private spawnFn: typeof nodeSpawn;
  private findBrowserFn: () => string | null;
  private lower: (pid: number | undefined) => boolean;
  private lowerTree: (pid: number | undefined) => void;
  private treeAt = 0;
  private treeN = 0;
  private treeLast = 0;
  private size: (p: ChildProcess, w: number, h: number) => void;
  private bus: (m: GsBusMsg) => void;
  private noBrowserMode: boolean;
  private graceMs: number;

  private store: Store = { ...EMPTY, lock: [] };
  /** Counts every change the sender page must re-read (bus {k:'cfg'}); echoed in its reports. */
  private gen = 1;
  private proc: ChildProcess | null = null;
  private gst = '';
  private launches = 0;
  private startedAt = 0;
  private crashes: number[] = [];
  private crashed = false;
  private restartAt = 0;
  private browserMissing = false;
  private dying: { p: ChildProcess; at: number }[] = [];
  private rep: { r: GsReport; at: number } | null = null;
  private privacy: GsPrivacy = 'unknown';
  private knockAt = new Map<string, number>();
  private decided = new Set<string>();
  private idleSince = 0;
  private idleOff = false;
  private lastChange = -1e12;
  private reportTimes: number[] = [];
  private lastViewerSave = 0;
  private preview: 'own' | 'official' | null = null;
  private timer: NodeJS.Timeout | null = null;
  private browserSeen: { at: number; v: boolean } | null = null;
  /** Serialises turn on / off / new link (each may wait for the server probe). */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(o: GuestFeedOptions = {}) {
    this.file = o.file ?? path.join(CONFIG_DIR, 'guest-feed.json');
    this.cacheDir = o.cacheDir ?? CACHE_DIR;
    this.port = o.port ?? PORT;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.log(`[guest-feed] ${m}`));
    this.env = o.env ?? process.env;
    this.fetchFn = o.fetch ?? ((url, init) => fetch(url, init as RequestInit));
    this.ownRelay = o.ownRelay ?? (async () => { try { return (await import('./routes/discord.ts')).savedRelayUrl() || null; } catch { return null; } });
    this.probeMs = o.probeMs ?? 3000;
    this.spawnFn = o.spawn ?? nodeSpawn;
    this.findBrowserFn = o.findBrowser ?? (() => realFindBrowser());
    this.lower = o.lower ?? ((pid) => lowerPriority(pid));
    this.lowerTree = o.lowerTree ?? (o.spawn ? () => {} : (pid) => realLowerTree(pid, this.env)); // (a stubbed spawn has no real process tree)
    this.size = o.size ?? realSizePage;
    this.bus = o.bus ?? ((m) => { void import('./bus.ts').then((b) => b.broadcast(m as never)).catch(() => {}); });
    this.noBrowserMode = o.noBrowser ?? this.env.VTP_GUESTFEED_NO_BROWSER === '1';
    this.graceMs = o.graceMs ?? GRACE_MS;
    this.load();
  }

  // ---- persistence
  private load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Store>;
      const id = typeof j.id === 'string' && PHONE_LINK_ID_RX.test(j.id) ? j.id : null;
      const relay = cleanRelay(j.relay);
      // (a link saved by an older version that used a shared server is not kept: only the streamer's own invite server is used)
      const on = j.enabled === true && !!id && !!relay && j.relayKind !== 'official';
      this.store = {
        version: 1, enabled: on, id: on ? id : null, idAt: on && typeof j.idAt === 'number' ? j.idAt : 0, relay: on ? relay : null,
        relayKind: on ? 'own' : null,
        name: sanitizeName(j.name), q: asQuality(j.q), delayMs: clampDelay(j.delayMs),
        autoOffMin: typeof j.autoOffMin === 'number' && GS_AUTO_OFF_MIN.includes(j.autoOffMin) ? j.autoOffMin : 0,
        lock: on && Array.isArray(j.lock) ? j.lock.filter((k): k is string => typeof k === 'string' && GS_KEY_RX.test(k)).slice(0, GS_MAX_VIEWERS) : [],
        lastViewerAt: on && typeof j.lastViewerAt === 'number' ? j.lastViewerAt : 0,
        pk: on && guestKeyPairOk(j.pk, j.sk) ? j.pk : null, sk: on && guestKeyPairOk(j.pk, j.sk) ? (j.sk as string) : null,
      };
      if (on && !this.store.pk) { Object.assign(this.store, newGuestKeyPair()); this.save(); }   // (a link saved before keys existed gets one; the old copies of that link say "ask for a new one")
    } catch { this.store = { ...EMPTY, lock: [] }; }
  }
  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) { this.log(`couldn’t save the settings (${(e as Error).message})`); }
  }
  get enabled() { return this.store.enabled; }
  get linkId() { return this.store.id; }
  get lock(): readonly string[] { return this.store.lock; }
  /** Tests / the e2e runner: the sender page's token while a browser (or the no-browser stand-in) runs. */
  get senderToken() { return this.gst; }
  get generation() { return this.gen; }
  get running() { return !!this.proc; }

  // ---- wiring
  /** Start the timers and, when the link was on before the helper restarted, bring the browser back. Idempotent. */
  attach() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
    void sweepStaleSenderProfiles(this.cacheDir, Date.now(), STALE_PROFILE_MS, this.port).then((n) => { if (n.length) this.log(`removed ${n.length} old browser profile folder${n.length === 1 ? '' : 's'}`); }).catch(() => {});
    if (this.store.enabled) { this.idleSince = this.now(); this.launch(); }
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.shutdown();
  }
  /** The helper ends (or a test ends): the browser goes now. The config is left as it is (the link comes back with the helper). */
  shutdown() {
    const p = this.proc;
    this.proc = null; this.gst = '';
    if (p) this.killNow(p);
    for (const d of this.dying.splice(0)) this.killNow(d.p);
    // (no 'exit' event reaches us when the helper itself is ending: take the profile folders now; what is still locked is swept at the next start)
    for (const dir of this.profiles) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* in use */ } }
    this.profiles.clear();
  }
  /** A profile folder whose browser is gone. Chrome's child processes can hold files a moment longer, so this retries. */
  private dropProfile(dir: string) {
    this.profiles.delete(dir);
    fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }, () => { /* swept at the next start */ });
  }
  private killNow(p: ChildProcess) {
    for (const i of [3, 4]) { try { (p.stdio?.[i] as { destroy?: () => void } | null | undefined)?.destroy?.(); } catch { /* closed */ } } // (the pipe is the browser's watchdog)
    try { p.kill(); } catch { /* gone */ }
  }

  // ---- which server (once per link)
  async probeHealth(origin: string): Promise<boolean> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.probeMs);
    try {
      const r = await withTimeout(this.fetchFn(`${origin}/health`, { signal: ctl.signal, redirect: 'error' }), this.probeMs);
      if (!r.ok) return false;
      const j = await withTimeout(r.json(), this.probeMs);
      return !!j && typeof j === 'object' && (j as { phone?: unknown }).phone === 1;
    } catch { return false; } finally { clearTimeout(t); }
  }
  /** The streamer's own invite server, and only when it answers /health with phone:1 within 3 s. Anything else (none set up, an
   *  older one without the phone route, down) throws NoRelayError: there is no shared server to fall back to. */
  async chooseRelay(): Promise<{ relay: string; kind: 'own' }> {
    const forced = cleanRelay(this.env.VTP_GUESTFEED_RELAY);
    if (forced) return { relay: forced, kind: 'own' };
    let own: string | null = null;
    try { own = cleanRelay(await this.ownRelay()); } catch { own = null; }
    if (own && await this.probeHealth(own)) return { relay: own, kind: 'own' };
    throw new NoRelayError(own
      ? 'Your invite server didn’t answer. Check that it is up (and an up-to-date one: Set up my invite server), then try again.'
      : 'Being a guest needs your own invite server. Set one up first (Set up my invite server), then turn this on.');
  }

  // ---- the card
  private fresh(): GsReport | null {
    return this.rep && this.now() - this.rep.at <= GS_VIEWER_STALE_MS ? this.rep.r : null;
  }
  private browserAvailable(): boolean {
    if (this.noBrowserMode) return true;
    const t = this.now();
    if (!this.browserSeen || t - this.browserSeen.at > 30_000) {
      let v = false;
      try { v = this.findBrowserFn() !== null; } catch { v = false; }
      this.browserSeen = { at: t, v };
    }
    return this.browserSeen.v;
  }
  private cardState(fresh: GsReport | null): GsCardState {
    if (!this.store.enabled) return this.idleOff ? 'idleOff' : 'off';
    if (this.crashed) return 'crashed';
    if (this.browserMissing) return 'noBrowser';
    if (fresh) {
      if (fresh.err === 'busy') return 'inUse';
      if (fresh.err === 'server') return 'noServer';
      if (fresh.err === 'gl') return 'crashed';
      if (fresh.knock && !this.decided.has(fresh.knock.kid)) return 'asking';
      if (fresh.viewers.length && fresh.tier !== 'full') return 'busy';
      if (fresh.state === 'live') return 'live';
      if (fresh.state === 'paused') return 'paused';
      if (fresh.state === 'boot') return 'starting';
      return 'waiting';
    }
    // (the browser runs but its page says nothing: starting up, or stuck)
    if (this.proc && this.now() - Math.max(this.startedAt, this.rep?.at ?? 0) > SILENT_MS) return 'crashed';
    return 'starting';
  }
  viewPage(): string {
    const v = this.env.VTP_GUESTFEED_VIEW_PAGE;
    return v && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[A-Za-z0-9_./-]*view\.html$/.test(v) ? v : `http://127.0.0.1:${this.port}${GS_VIEW_PATH}`;
  }
  /** The link to copy, or null while off. */
  url(): string | null {
    const s = this.store;
    if (!s.enabled || !s.id || !s.relay) return null;
    return buildViewUrl(this.viewPage(), { relay: s.relay, id: s.id, delayMs: s.delayMs, q: s.q, name: s.name, pub: s.pk });
  }
  view(): GsView {
    const s = this.store, f = this.fresh();
    const state = this.cardState(f);
    const viewers = s.enabled && f ? f.viewers : [];
    const knock = s.enabled && f?.knock && !this.decided.has(f.knock.kid) ? { kid: f.knock.kid, label: f.knock.label, at: this.knockAt.get(f.knock.kid) ?? this.now() } : null;
    const privacy = s.enabled ? this.privacy : 'unknown';
    return {
      v: 1, enabled: s.enabled, state, says: cardText(state, viewers.length), url: this.url(),
      name: s.name, q: s.q, delayMs: s.delayMs, autoOffMin: s.autoOffMin,
      privacy, privacySays: privacyText(privacy),
      tier: s.enabled && f ? f.tier : 'full',
      relayKind: s.enabled ? s.relayKind : this.preview,
      viewers, knock, browser: this.browserAvailable(), offAt: this.offAt(),
    };
  }
  private connected(): boolean { return (this.fresh()?.viewers.length ?? 0) > 0; }
  /** Cheap: is another streamer's OBS showing this PC right now (guest feed on, a fresh report with a viewer)? */
  hasViewer(): boolean { return this.store.enabled && this.connected(); }
  private offAt(): number | null {
    const s = this.store;
    if (!s.enabled || !s.autoOffMin || this.connected()) return null;
    return this.idleSince + s.autoOffMin * 60_000;
  }
  /** What the sender page reads at start (GET /api/guestfeed/sender). */
  senderConfig(): GsSenderConfig | null {
    const s = this.store;
    if (!s.enabled || !s.id || !s.relay) return null;
    return { gen: this.gen, relay: s.relay, id: s.id, q: s.q, delayMs: s.delayMs, name: s.name, lock: [...s.lock], ...(s.pk && s.sk ? { pk: s.pk, sk: s.sk } : {}) };
  }
  tokenOk(tok: unknown): boolean { return typeof tok === 'string' && TOKEN_RX.test(tok) && !!this.gst && safeEq(tok, this.gst); }

  // ---- the sender page talks to us
  /** A report from the sender page. Returns false when it is not usable (junk). */
  report(raw: unknown): boolean {
    const r = sanitizeReport(raw);
    if (!r || !this.store.enabled) return false;
    const t = this.now();
    const was = this.rep?.r;
    if (!was || r.tier !== was.tier || r.viewers.some((v) => !was.viewers.some((w) => w.id === v.id))) this.sweepSoon(t);
    this.rep = { r, at: t };
    if (r.privacy !== 'unknown') this.privacy = r.privacy;
    // the lock only follows a report that has read the CURRENT settings (a stale one never brings back what New link cleared)
    if (r.gen === this.gen && (r.lock.length !== this.store.lock.length || r.lock.some((k, i) => k !== this.store.lock[i]))) { this.store.lock = r.lock; this.save(); }
    const open = new Set<string>();
    if (r.knock) { open.add(r.knock.kid); if (!this.knockAt.has(r.knock.kid)) this.knockAt.set(r.knock.kid, t); }
    for (const k of this.knockAt.keys()) if (!open.has(k)) this.knockAt.delete(k);
    for (const k of this.decided) if (!open.has(k)) this.decided.delete(k);
    if (r.viewers.length) this.touchViewer(t);
    return true;
  }
  /** A viewer connected or the tier changed: Chrome may have made new processes, so walk the tree soon (not during the start-up walks, not too often). */
  private sweepSoon(t: number) {
    if (!this.proc || this.treeN < TREE_SWEEPS_MS.length) return;
    const at = Math.max(t + TREE_EVENT_DELAY_MS, this.treeLast + TREE_SWEEP_MIN_GAP_MS);
    if (!this.treeAt || at < this.treeAt) this.treeAt = at;
  }
  private touchViewer(t: number) {
    this.store.lastViewerAt = t;
    this.idleSince = t;
    if (t - this.lastViewerSave > 300_000) { this.lastViewerSave = t; this.save(); }
  }
  /** Every control message to the sender page is signed with its own token (the bus relays any client's messages, so only a signed one is obeyed). */
  private send(m: GsBusMsg) {
    if (this.gst) m = { ...m, sig: crypto.createHmac('sha256', this.gst).update(gsBusCanon(m)).digest('hex') };
    this.bus(m);
  }
  /** Allow / Block (the card's buttons). The decision goes to the sender page over the bus. */
  decide(kid: string, allow: boolean): boolean {
    const f = this.fresh();
    if (!this.store.enabled || !f?.knock || f.knock.kid !== kid) return false;
    this.decided.add(kid);
    this.send({ type: 'gs', k: 'decide', kid, allow });
    return true;
  }

  // ---- changes (each in order)
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }
  /** Too soon after the last change? (Turning off is never held back.) */
  tooSoon(): boolean {
    const t = this.now();
    if (t - this.lastChange < CHANGE_EVERY_MS && t >= this.lastChange) return true;
    this.lastChange = t;
    return false;
  }
  /** PUT: the settings, and the switch. */
  apply(patch: GsSettings): Promise<void> {
    return this.run(async () => {
      const s = this.store;
      let cfg = false, restart = false;
      if (patch.name !== undefined && patch.name !== s.name) { s.name = patch.name; cfg = true; }
      if (patch.delayMs !== undefined && patch.delayMs !== s.delayMs) { s.delayMs = patch.delayMs; cfg = true; }
      if (patch.q !== undefined && patch.q !== s.q) { s.q = patch.q; cfg = true; restart = true; }
      if (patch.autoOffMin !== undefined && patch.autoOffMin !== s.autoOffMin) { s.autoOffMin = patch.autoOffMin; this.idleSince = this.now(); }
      if (patch.enabled === true && !s.enabled) { await this.enableNow(); return; }
      if (patch.enabled === false && s.enabled) { this.disableNow('user'); return; }
      this.save();
      if (s.enabled && cfg) {
        this.gen++;
        if (restart) this.relaunch(0); // (a new quality = a new browser window size; the viewers reconnect by themselves)
        else this.send({ type: 'gs', k: 'cfg', gen: this.gen });
      }
    });
  }
  private async enableNow() {
    const s = this.store;
    const pick = await this.chooseRelay();
    const t = this.now();
    s.enabled = true; s.id = newGuestLinkId(); s.idAt = t; s.relay = pick.relay; s.relayKind = pick.kind; s.lock = []; s.lastViewerAt = t;
    Object.assign(s, newGuestKeyPair());
    this.freshLink();
    this.save();
    this.log('turned on (your own invite server)');
    this.launch();
  }
  /** Everything that belongs to one link's life starts clean. */
  private freshLink() {
    this.gen++;
    this.rep = null; this.privacy = 'unknown'; this.knockAt.clear(); this.decided.clear();
    this.crashes = []; this.crashed = false; this.browserMissing = false; this.restartAt = 0;
    this.idleSince = this.now(); this.idleOff = false; this.preview = null;
  }
  private disableNow(why: 'user' | 'auto' | 'idle') {
    const s = this.store;
    if (!s.enabled) return;
    this.send({ type: 'gs', k: 'off', gen: this.gen }); // the sender page tells its viewers "turned off" before the browser goes
    this.retire(this.graceMs);
    this.store = { ...s, enabled: false, id: null, idAt: 0, relay: null, relayKind: null, lock: [], lastViewerAt: 0, pk: null, sk: null };
    this.gen++;
    this.rep = null; this.privacy = 'unknown'; this.knockAt.clear(); this.decided.clear(); this.crashes = []; this.crashed = false; this.browserMissing = false; this.restartAt = 0;
    this.idleOff = why === 'idle';
    this.save();
    this.log(`turned off (${why === 'user' ? 'you pressed Turn off' : why === 'auto' ? 'the timer ran out' : 'nobody used the link for a day'})`);
  }
  turnOff(): Promise<void> { return this.run(async () => this.disableNow('user')); }
  /** New link: the old one answers "turned off", lock and blocks are cleared, the server is checked again. */
  renew(): Promise<boolean> {
    return this.run(async () => {
      const s = this.store;
      if (!s.enabled) return false;
      this.send({ type: 'gs', k: 'off', gen: this.gen });
      this.retire(this.graceMs);
      const pick = await this.chooseRelay();
      const t = this.now();
      s.id = newGuestLinkId(); s.idAt = t; s.relay = pick.relay; s.relayKind = pick.kind; s.lock = []; s.lastViewerAt = t;
      Object.assign(s, newGuestKeyPair());   // (the old link's key dies with it: an answer signed for the old link verifies nowhere)
      this.freshLink();
      this.save();
      this.log('new link made; the old one is dead');
      this.launch();
      return true;
    });
  }
  /** "Check which server a new link would use" (GET ?fresh=1 while off). */
  async refreshPreview() { if (!this.store.enabled) this.preview = await this.chooseRelay().then((p) => p.kind, () => null); }

  // ---- the timers (the interval calls this; tests call it with a fake clock)
  tick() {
    const t = this.now();
    for (const d of this.dying.filter((x) => x.at <= t)) this.killNow(d.p);
    this.dying = this.dying.filter((x) => x.at > t);
    const s = this.store;
    if (!s.enabled) return;
    if (!this.proc && !this.crashed && !this.browserMissing && this.restartAt && t >= this.restartAt) { this.restartAt = 0; this.launch(); }
    if (this.proc && this.treeAt && t >= this.treeAt) {
      this.lowerTree(this.proc.pid);
      this.treeLast = t;
      this.treeN++;
      this.treeAt = t + (this.treeN < TREE_SWEEPS_MS.length ? TREE_SWEEPS_MS[this.treeN] : TREE_SWEEP_EVERY_MS);
    }
    if (this.connected()) { this.idleSince = t; return; } // (never during a show)
    if (s.autoOffMin && t - this.idleSince >= s.autoOffMin * 60_000) { this.disableNow('auto'); return; }
    if (s.lastViewerAt && t - s.lastViewerAt >= GS_IDLE_OFF_MS) this.disableNow('idle');
  }

  // ---- the browser
  /** Take the running browser out of service: its pipe closes and it is killed `after` ms from now (0 = now). */
  private retire(after: number) {
    const p = this.proc;
    this.proc = null; this.gst = '';
    if (!p) return;
    if (after <= 0) this.killNow(p); else this.dying.push({ p, at: this.now() + after });
  }
  private relaunch(after: number) { this.retire(after); this.crashes = []; this.launch(); }
  private launch(): boolean {
    const s = this.store;
    if (this.proc || !s.enabled || !s.id) return false;
    const fixed = this.env.VTP_GUESTFEED_TOKEN; // (tests: a page the test starts itself needs the token)
    this.gst = fixed && TOKEN_RX.test(fixed) ? fixed : crypto.randomBytes(16).toString('hex');
    this.startedAt = this.now();
    if (this.noBrowserMode) return false; // (API and config tests: the token exists, no process)
    let exe: string | null = null;
    try { exe = this.findBrowserFn(); } catch { exe = null; }
    if (!exe) { this.browserMissing = true; this.gst = ''; this.log('no Chrome or Edge found'); return false; }
    this.browserMissing = false;
    const n = ++this.launches;
    const dir = path.join(this.cacheDir, `guestfeed-sender-${this.port}-${n}`);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* in use */ }
    this.profiles.add(dir);
    const q = this.env.VTP_GUESTFEED_SENDER_QUERY ?? '';
    const t = gsTier(s.q, 'full');
    const args = senderArgs(this.port, dir, this.env.VTP_STREAMPC_SENDER_FLAGS ?? '', false, senderQueryOk(q) ? q : '', { page: `output.html?gsSend=1&gst=${this.gst}`, w: t.w, h: t.h });
    // (the other side of a direct connection must not read this PC's LAN address: the browser hides it behind an mDNS name, unless a loopback test needs it)
    const feat = args.indexOf('--disable-features=WebRtcHideLocalIpsWithMdns,CalculateNativeWinOcclusion');
    if (feat >= 0 && this.env.VTP_GUESTFEED_RAW_HOST !== '1') args[feat] = '--disable-features=CalculateNativeWinOcclusion';
    let p: ChildProcess;
    try { p = this.spawnFn(exe, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true, detached: false }); }
    catch (e) { this.log(`the picture maker didn’t start (${(e as Error).message})`); this.gst = ''; this.dropProfile(dir); this.noteCrash(); return false; }
    this.lower(p.pid); // right away: the browser's own child processes inherit below-normal CPU priority (the game wins the processor)
    this.treeN = 0; this.treeLast = 0; this.treeAt = this.now() + TREE_SWEEPS_MS[0]; // (and Chrome re-sets some of them itself: tick() walks the tree again, see TREE_SWEEPS_MS)
    this.size(p, t.w, t.h);
    this.proc = p;
    p.on('error', (e) => {
      this.log(`the picture maker didn’t start (${e.message})`);
      this.dropProfile(dir);
      if (this.proc === p) { this.proc = null; this.gst = ''; if (this.store.enabled) this.noteCrash(); } // (a browser that never started has no 'exit' to count)
    });
    p.on('exit', () => {
      this.dropProfile(dir);
      if (this.proc !== p) return; // (retired on purpose)
      this.proc = null; this.gst = '';
      if (this.store.enabled) this.noteCrash();
    });
    this.log(`sender started (${path.basename(exe)}, muted, headless, ${t.w}x${t.h})`);
    return true;
  }
  /** The browser quit by itself: start it again, but at most GS_RESTARTS_MAX times in GS_RESTART_WINDOW_MS. */
  private noteCrash() {
    const t = this.now();
    this.crashes = this.crashes.filter((x) => t - x < GS_RESTART_WINDOW_MS);
    this.crashes.push(t);
    if (this.crashes.length >= GS_RESTARTS_MAX) { this.crashed = true; this.restartAt = 0; this.log('the picture maker keeps closing: not starting it again until you turn this off and on'); }
    else this.restartAt = t + RESTART_DELAY_MS;
  }

  // ---- routes
  routes() {
    this.attach();
    const r = Router();
    const send = (res: Response, status: number, body: unknown) => { res.setHeader('Cache-Control', 'no-store'); res.status(status).json(body); };
    const local = (req: Request, res: Response): boolean => {
      if (StreamPc.isLan(req) || !isLoopbackIp(req.socket.remoteAddress)) { send(res, 403, { error: 'This only works on this PC' }); return false; }
      return true;
    };
    const click = (req: Request, res: Response): boolean => {
      if (req.headers['x-vtp-user-action'] !== '1') { send(res, 403, { error: 'Press the button in VTube Pro on this PC' }); return false; }
      return true;
    };
    const moment = (res: Response) => { send(res, 429, { error: 'One moment…' }); };
    const guarded = (fn: (req: Request, res: Response) => Promise<void> | void) => async (req: Request, res: Response) => {
      try { await fn(req, res); } catch (e) {
        if (e instanceof NoRelayError) { if (!res.headersSent) send(res, 409, { error: e.message }); return; }
        this.log(`request failed (${(e as Error).message})`); if (!res.headersSent) send(res, 500, { error: 'Something went wrong. Try again.' });
      }
    };
    const sender = (req: Request, res: Response): boolean => {
      if (!local(req, res)) return false;
      if (!this.tokenOk(req.headers['x-vtp-gs'])) { send(res, 403, { error: 'Not for this page' }); return false; }
      return true;
    };
    r.get('/api/guestfeed', guarded(async (req, res) => {
      if (!local(req, res)) return;
      if (req.query.fresh === '1') await this.refreshPreview();
      send(res, 200, this.view());
    }));
    r.put('/api/guestfeed', guarded(async (req, res) => {
      if (!local(req, res) || !click(req, res)) return;
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) { send(res, 400, { error: 'Nothing to change' }); return; }
      const patch = sanitizeSettings(req.body);
      if (patch.enabled !== false && this.tooSoon()) { moment(res); return; }
      await this.apply(patch);
      send(res, 200, this.view());
    }));
    r.delete('/api/guestfeed', guarded(async (req, res) => {
      if (!local(req, res) || !click(req, res)) return;
      await this.turnOff();
      send(res, 200, this.view());
    }));
    r.post('/api/guestfeed/renew', guarded(async (req, res) => {
      if (!local(req, res) || !click(req, res)) return;
      if (!this.store.enabled) { send(res, 409, { error: 'Turn it on first' }); return; }
      if (this.tooSoon()) { moment(res); return; }
      await this.renew();
      send(res, 200, this.view());
    }));
    r.post('/api/guestfeed/knock', guarded((req, res) => {
      if (!local(req, res) || !click(req, res)) return;
      if (!this.store.enabled) { send(res, 409, { error: 'Turn it on first' }); return; }
      const k = sanitizeKnockReply(req.body);
      if (!k) { send(res, 400, { error: 'Nothing to answer' }); return; }
      if (!this.decide(k.kid, k.allow)) { send(res, 409, { error: 'That question has run out' }); return; }
      send(res, 200, this.view());
    }));
    r.get('/api/guestfeed/sender', guarded((req, res) => {
      if (!sender(req, res)) return;
      const c = this.senderConfig();
      if (!c) { send(res, 409, { error: 'Turned off' }); return; }
      send(res, 200, c);
    }));
    r.post('/api/guestfeed/report', guarded((req, res) => {
      if (!sender(req, res)) return;
      const t = this.now();
      this.reportTimes = this.reportTimes.filter((x) => t - x < 1000);
      if (this.reportTimes.length >= REPORTS_PER_S) { moment(res); return; }
      this.reportTimes.push(t);
      if (!this.report(req.body)) { send(res, 400, { error: 'Not a report' }); return; }
      send(res, 200, { ok: true, gen: this.gen });
    }));
    return r;
  }
}

// ---------------------------------------------------------------- process-wide instance
let shared: GuestFeed | null = null;
export const guestFeed = () => (shared ??= new GuestFeed());
/** True while a viewer is connected (the shutdown route refuses to stop a show). Never creates the instance (a helper that never used the guest feed says false). */
export const guestViewerConnected = (): boolean => { try { return shared?.hasViewer() ?? false; } catch { return false; } };
/** Tests: a private instance. */
export function setGuestFeed(g: GuestFeed | null) { shared = g; }
process.once('exit', () => { try { shared?.shutdown(); } catch { /* */ } });
