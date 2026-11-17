// Owns every external tracking receiver (VTS phone, iFacialMocap, Live Link Face, VMC, VTS API): config (config/external.json), live (re)start/stop, status,
// VTS API token store, and the bus tap (current avatar + latest TrackingFrame for the VTS API / VMC out).
//
// Wiring (server/index.ts):
//   const external = new ExternalManager({ publish: (d) => broadcast({ type: 'ext', data: d }), broadcast });
//   external.attachBus(attachBus(server));   // passive tap; never sends onto the bus by itself
//   void external.init();                    // starts whatever is enabled (everything is off by default)
//   app.use(externalRoutes(external));
import fs from 'node:fs';
import path from 'node:path';
import type { WebSocketServer, RawData } from 'ws';
import { CONFIG_DIR } from '../paths.ts';
import type { BusMessage, ExternalTracking, TrackingFrame } from '../../shared/types.ts';
import { lockPolicy, validHost, validPort, type AxisInvert, type SourceRuntime, type SourceStatus } from './common.ts';
import { IFM_DEFAULTS, IFacialMocapSource, type IFacialMocapConfig } from './ifacialmocap.ts';
import { LLF_DEFAULTS, LiveLinkFaceSource, type LiveLinkFaceConfig } from './liveLinkFace.ts';
import { DETECT_PORTS, PhoneDetector, type DetectApp, type Detected } from './phoneDetect.ts';
import { VMC_DEFAULTS, VmcReceiver, VmcSender, type VmcConfig } from './vmc.ts';
import { VTS_API_DEFAULTS, VtsApiServer, type VtsApiConfig, type VtsAvatarInfo, type VtsTokenRecord } from './vtsApi.ts';
import { VTS_PHONE_DEFAULTS, VtsPhoneSource, type VtsPhoneConfig } from './vtsPhone.ts';

export interface ExternalConfig {
  vtsPhone: VtsPhoneConfig;
  ifacialmocap: IFacialMocapConfig;
  liveLinkFace: LiveLinkFaceConfig;
  vmc: VmcConfig;
  vtsApi: VtsApiConfig;
}

interface StoreFile { config: ExternalConfig; vtsTokens: VtsTokenRecord[] }

export const EXTERNAL_DEFAULTS: ExternalConfig = {
  vtsPhone: VTS_PHONE_DEFAULTS,
  ifacialmocap: IFM_DEFAULTS,
  liveLinkFace: LLF_DEFAULTS,
  vmc: VMC_DEFAULTS,
  vtsApi: VTS_API_DEFAULTS,
};

type Key = keyof ExternalConfig;
const KEYS: Key[] = ['vtsPhone', 'ifacialmocap', 'liveLinkFace', 'vmc', 'vtsApi'];

export interface ExternalManagerOptions {
  /** Publish normalised tracking (→ bus {type:'ext'}). */
  publish(d: ExternalTracking): void;
  /** Server-originated bus message (VTS API model loads / hotkeys). */
  broadcast(msg: BusMessage): void;
  /** Where config + token hashes persist. Default config/external.json. */
  file?: string;
  /** Avatar library (default: server/library.ts listAvatars). */
  listAvatars?(): VtsAvatarInfo[];
  /** One avatar by id (O(1)); without it the list is searched. */
  getAvatar?(id: string): VtsAvatarInfo | null;
  /** Where phone discovery broadcasts go (default: 255.255.255.255; createExternal passes this PC's subnet broadcast). */
  discoveryTargets?(): string[] | Promise<string[]>;
}

// ---------------------------------------------------------------- config sanitising

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const port = (v: unknown, d: number, zero = false) => (validPort(v, zero) ? v : d);
const hostOr = (v: unknown, d: string) => (v === '' ? '' : validHost(v) ? v : d);
const bindOr = (v: unknown, d: string) => (v === '0.0.0.0' || v === '127.0.0.1' || (validHost(v) && /^[0-9.]+$/.test(v)) ? (v as string) : d);
const inv = (v: unknown, d: AxisInvert): AxisInvert => {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { yaw: bool(o.yaw, d.yaw), pitch: bool(o.pitch, d.pitch), roll: bool(o.roll, d.roll) };
};

/** Merge an untrusted patch onto `base`, keeping only known fields with valid values. */
export function mergeConfig(base: ExternalConfig, patch: unknown): ExternalConfig {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, Record<string, unknown> | undefined>;
  const vp = p.vtsPhone ?? {}, im = p.ifacialmocap ?? {}, ll = p.liveLinkFace ?? {}, vm = p.vmc ?? {}, va = p.vtsApi ?? {};
  const vmOut = (vm.out && typeof vm.out === 'object' ? vm.out : {}) as Record<string, unknown>;
  const b = base;
  return {
    vtsPhone: {
      enabled: bool(vp.enabled, b.vtsPhone.enabled), phoneIp: hostOr(vp.phoneIp, b.vtsPhone.phoneIp),
      phonePort: port(vp.phonePort, b.vtsPhone.phonePort), listenPort: port(vp.listenPort, b.vtsPhone.listenPort, true),
      bind: bindOr(vp.bind, b.vtsPhone.bind), invert: inv(vp.invert, b.vtsPhone.invert), discover: bool(vp.discover, b.vtsPhone.discover),
    },
    ifacialmocap: {
      enabled: bool(im.enabled, b.ifacialmocap.enabled), phoneIp: hostOr(im.phoneIp, b.ifacialmocap.phoneIp),
      phonePort: port(im.phonePort, b.ifacialmocap.phonePort), port: port(im.port, b.ifacialmocap.port),
      bind: bindOr(im.bind, b.ifacialmocap.bind), invert: inv(im.invert, b.ifacialmocap.invert), discover: bool(im.discover, b.ifacialmocap.discover),
      fm3dPort: port(im.fm3dPort, b.ifacialmocap.fm3dPort, true),
    },
    liveLinkFace: {
      enabled: bool(ll.enabled, b.liveLinkFace.enabled), port: port(ll.port, b.liveLinkFace.port),
      bind: bindOr(ll.bind, b.liveLinkFace.bind), phoneIp: hostOr(ll.phoneIp, b.liveLinkFace.phoneIp),
      invert: inv(ll.invert, b.liveLinkFace.invert),
    },
    vmc: {
      enabled: bool(vm.enabled, b.vmc.enabled), port: port(vm.port, b.vmc.port), port2: port(vm.port2, b.vmc.port2, true), bind: bindOr(vm.bind, b.vmc.bind),
      phoneIp: hostOr(vm.phoneIp, b.vmc.phoneIp), invert: inv(vm.invert, b.vmc.invert),
      out: { enabled: bool(vmOut.enabled, b.vmc.out.enabled), host: hostOr(vmOut.host, b.vmc.out.host) || b.vmc.out.host, port: port(vmOut.port, b.vmc.out.port) },
    },
    vtsApi: { enabled: bool(va.enabled, b.vtsApi.enabled), port: port(va.port, b.vtsApi.port), bind: bindOr(va.bind, b.vtsApi.bind) },
  };
}

// ---------------------------------------------------------------- manager

export class ExternalManager {
  readonly file: string;
  private store: StoreFile;
  private runtimes: Partial<Record<Key, SourceRuntime>> = {};
  private startErrors: Partial<Record<Key, string>> = {};
  private applying: Promise<void> = Promise.resolve();
  private vmcOut: VmcSender | null = null;
  private vmcOutAt = 0;
  private avatarId: string | null = null;
  private frame: TrackingFrame | null = null;
  private frameAt = 0;
  private frameTimes: number[] = [];
  private lastFrameParse = 0;
  /** Listeners for the bus `command` messages the VTS API needs (studio replies, item events, model clicks). Empty = commands are never parsed. */
  private busSubs = new Set<(msg: unknown) => void>();

  constructor(private opts: ExternalManagerOptions) {
    this.file = opts.file ?? path.join(CONFIG_DIR, 'external.json');
    this.store = this.load();
    lockPolicy.wizardOpen = () => !!this.detector?.on;   // (while "Find my phone" runs, a new sender may take over a held lock)
  }

  // ---------- persistence
  private load(): StoreFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StoreFile>;
      const tokens = Array.isArray(raw.vtsTokens) ? raw.vtsTokens.filter((t) => t && typeof t.hash === 'string' && typeof t.id === 'string') : [];
      return { config: mergeConfig(structuredClone(EXTERNAL_DEFAULTS), raw.config), vtsTokens: tokens };
    } catch {
      return { config: structuredClone(EXTERNAL_DEFAULTS), vtsTokens: [] };
    }
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('[external] could not save', this.file, e); }
  }

  get config(): ExternalConfig { return structuredClone(this.store.config); }

  // ---------- lifecycle
  /** Start whatever is enabled. Never throws (a busy port is reported in status instead). */
  init() { return this.update({}); }

  /** Merge a config patch, persist it, and (re)start/stop only the receivers whose config changed. */
  update(patch: unknown): Promise<void> {
    const prev = this.store.config;
    const next = mergeConfig(prev, patch);
    this.store.config = next;
    this.save();
    this.applying = this.applying.then(() => this.apply(prev, next)).catch((e) => console.error('[external]', e));
    return this.applying;
  }

  private async apply(prev: ExternalConfig, next: ExternalConfig) {
    const strip = (k: Key, c: ExternalConfig) => JSON.stringify(k === 'vmc' ? { ...c.vmc, out: 0 } : c[k]);
    for (const k of KEYS) {
      const changed = strip(k, prev) !== strip(k, next);
      const rt = this.runtimes[k];
      if (!changed && rt && rt.status().running) continue;   // untouched and healthy
      if (!changed && !rt && !next[k].enabled) continue;     // untouched and off
      // (unchanged but failed earlier → retry, e.g. after the user closed the app holding the port)
      if (rt) { await rt.stop().catch(() => {}); delete this.runtimes[k]; }
      delete this.startErrors[k];
      if (!next[k].enabled) continue;
      // "Find my phone" holds every phone port: it lets go BEFORE a source binds one (Live Link Face turned on during a search
      // used to fail with EADDRINUSE); the wizard sees the search is off and says so
      if (k !== 'vtsApi') await this.detectStop();
      const created = this.create(k, next);
      try {
        await created.start();
        this.runtimes[k] = created;
        console.log(`[external] ${k} listening`);
      } catch (e) {
        this.startErrors[k] = (e as Error).message;
        this.runtimes[k] = created; // keep for status (running=false, lastError)
      }
    }
    // VMC sender (independent of the receiver)
    const o = next.vmc.out;
    if (o.enabled) {
      if (!this.vmcOut) this.vmcOut = new VmcSender({ host: o.host, port: o.port });
      else this.vmcOut.setTarget(o.host, o.port);
    } else if (this.vmcOut) { this.vmcOut.close(); this.vmcOut = null; }
  }

  private create(k: Key, c: ExternalConfig): SourceRuntime {
    // a source the user hasn't enabled (or just turned off) never drives anything
    const pub = (d: ExternalTracking) => { if (this.store.config[k].enabled) this.opts.publish(d); };
    const targets = () => (this.opts.discoveryTargets ? this.opts.discoveryTargets() : ['255.255.255.255']);
    switch (k) {
      // the phone's on-screen buttons 1-8: one bus command per tap; the studio runs the action the user picked (src/tracking/phoneHotkeys.ts)
      case 'vtsPhone': return new VtsPhoneSource(c.vtsPhone, pub, (n) => this.opts.broadcast({ type: 'command', command: 'phone-hotkey', args: { n, source: 'vts-phone' } }), targets);
      case 'ifacialmocap': return new IFacialMocapSource(c.ifacialmocap, pub, targets);
      case 'liveLinkFace': return new LiveLinkFaceSource(c.liveLinkFace, pub);
      case 'vmc': {
        // never listen where our own VMC sender points on this PC (we'd hear ourselves)
        const o = c.vmc.out, loop = /^(127\.|localhost$)/.test(o.host);
        return new VmcReceiver({ ...c.vmc, port2: o.enabled && loop && o.port === c.vmc.port2 ? 0 : c.vmc.port2 }, pub);
      }
      case 'vtsApi': return new VtsApiServer(c.vtsApi, {
        publish: pub,
        broadcast: (m) => this.opts.broadcast(m),
        getTokens: () => this.store.vtsTokens.map((t) => ({ ...t })),
        setTokens: (t) => { this.store.vtsTokens = t.slice(0, 200); this.save(); },
        listAvatars: () => this.avatars(),
        getAvatar: (id) => this.avatar(id),
        currentAvatarId: () => this.avatarId,
        setCurrentAvatar: (id) => { this.avatarId = id; },
        busEvents: (fn) => { this.busSubs.add(fn); return () => { this.busSubs.delete(fn); }; },
        latestFrame: () => (Date.now() - this.frameAt < 1000 ? this.frame : null),
        frameRate: () => { const n = Date.now(); return this.frameTimes.filter((t) => n - t < 1000).length; },
      });
    }
  }

  /** "That's not my phone": drop the locked-in sender of one source. */
  forgetPhone(k: Key): boolean {
    const rt = this.runtimes[k];
    if (!rt?.forget) return false;
    rt.forget();
    return true;
  }
  /** "Use it" on "Another phone is sending": the device that knocked while the lock was held becomes the phone. */
  switchPhone(k: Key): boolean {
    return !!this.runtimes[k]?.switchPhone?.();
  }

  /** UDP ports the phone receivers listen on (what the Windows firewall rule must let in). */
  receivePorts(): { udp: number[]; tcp: number[] } {
    const c = this.store.config, udp: number[] = [];
    // every phone receiver's port, on or off: the rule is asked for BEFORE "Use this now" turns one on
    if (c.vtsPhone.listenPort) udp.push(c.vtsPhone.listenPort);
    udp.push(c.ifacialmocap.port, c.liveLinkFace.port, c.vmc.port);
    if (c.ifacialmocap.fm3dPort) udp.push(c.ifacialmocap.fm3dPort); // FaceMotion3D may answer to its own port
    if (c.vmc.port2) udp.push(c.vmc.port2);
    return { udp: [...new Set(udp)].sort((a, b) => a - b), tcp: [] };
  }

  async stopAll() {
    await this.applying;
    await this.detectStop();
    for (const k of KEYS) { await this.runtimes[k]?.stop().catch(() => {}); delete this.runtimes[k]; }
    this.vmcOut?.close(); this.vmcOut = null;
  }

  // ---------- "Find my phone": every known phone port at once (phoneDetect.ts); nothing drives the avatar
  private detector: PhoneDetector | null = null;
  /** A start in flight: overlapping detectStart() calls share it (two detectors would both claim the phone ports, and the first would be orphaned). */
  private detectStarting: Promise<void> | null = null;
  /** bumped by every new start and every stop: a start that finds it changed was stopped meanwhile and lets go of what it bound */
  private detectGen = 0;
  /** Listen on all phone ports and ask the LAN (the sources' own discovery requests). Ports a running source holds are skipped. */
  detectStart(): Promise<void> {
    if (this.detectStarting) return this.detectStarting;
    if (this.detector?.on) return Promise.resolve();
    const gen = ++this.detectGen;
    const run = (async () => {
      await this.applying;
      if (gen !== this.detectGen || this.detector?.on) return;
      const c = this.store.config;
      const targets = () => (this.opts.discoveryTargets ? this.opts.discoveryTargets() : ['255.255.255.255']);
      const d = new PhoneDetector({
        vts: c.vtsPhone.listenPort || DETECT_PORTS.vts, ifm: c.ifacialmocap.port, fm3d: c.ifacialmocap.fm3dPort, llf: c.liveLinkFace.port, vmc: c.vmc.port, vmc2: c.vmc.port2,
      }, targets);
      this.detector = d; // (set before the first await on it: a detectStop() during the start finds it)
      await d.start();
      if (gen !== this.detectGen) await d.stop().catch(() => {});   // (stopped while it was binding)
    })();
    const p: Promise<void> = run.finally(() => { if (this.detectStarting === p) this.detectStarting = null; });
    this.detectStarting = p;
    return p;
  }
  async detectStop() { this.detectGen++; const d = this.detector; this.detector = null; await d?.stop(); }
  /** What the detector heard, plus any running source that is receiving a phone right now. */
  detectView(): { on: boolean; since: number | null; found: (Detected & { via: 'detect' | 'source' })[]; skipped: { port: number; why: string }[]; unknown: number } {
    const d = this.detector, now = Date.now();
    const found: (Detected & { via: 'detect' | 'source' })[] = (d?.results() ?? []).map((x) => ({ ...x, via: 'detect' as const }));
    const st = this.status();
    const labels: Record<DetectApp, string> = { vtsPhone: 'VTube Studio / MeowFace', ifacialmocap: 'iFacialMocap / FaceMotion3D', liveLinkFace: 'Live Link Face', vmc: 'A VMC app (Waidayo, VSeeFace, VNyan…)' };
    for (const k of ['vtsPhone', 'ifacialmocap', 'liveLinkFace', 'vmc'] as const) {
      const s = st[k];
      if (!s.running || s.lastSeen === null || now - s.lastSeen > 3000 || found.some((x) => x.app === k && now - x.lastSeen < 3000)) continue;
      const ip = String((s.info as { phone?: unknown } | undefined)?.phone ?? s.phoneIp ?? '');
      found.push({ app: k, label: labels[k], detail: 'already connected', faceFound: s.faceFound, ip, port: s.port, packets: s.packetsTotal, lastSeen: s.lastSeen, via: 'source' });
    }
    found.sort((a, b) => b.lastSeen - a.lastSeen);
    return { on: !!d?.on, since: d?.startedAt ?? null, found, skipped: d?.skipped ?? [], unknown: d?.unknown ?? 0 };
  }

  private avatars(): VtsAvatarInfo[] {
    try { return this.opts.listAvatars?.() ?? []; } catch { return []; }
  }

  private avatar(id: string): VtsAvatarInfo | null {
    try { return this.opts.getAvatar ? this.opts.getAvatar(id) : this.avatars().find((a) => a.id === id) ?? null; } catch { return null; }
  }

  // ---------- status
  status(): Record<Key, SourceStatus> & { vmcOut: { enabled: boolean; host: string; port: number; sent: number; lastError: string | null } } {
    const c = this.store.config;
    const idle = (k: Key, kind: SourceStatus['kind'], portN: number, phoneIp?: string): SourceStatus => ({
      kind, enabled: c[k].enabled, running: false, bind: c[k].bind, port: portN, phoneIp,
      packetsPerSec: 0, packetsTotal: 0, lastSeen: null, faceFound: false, lastError: this.startErrors[k] ?? null,
    });
    const st = (k: Key, kind: SourceStatus['kind'], portN: number, phoneIp?: string) => {
      const s = this.runtimes[k]?.status() ?? idle(k, kind, portN, phoneIp);
      if (!s.running && this.startErrors[k]) s.lastError = s.lastError ?? this.startErrors[k]!;
      return s;
    };
    return {
      vtsPhone: st('vtsPhone', 'vts-phone', c.vtsPhone.listenPort, c.vtsPhone.phoneIp),
      ifacialmocap: st('ifacialmocap', 'ifacialmocap', c.ifacialmocap.port, c.ifacialmocap.phoneIp),
      liveLinkFace: st('liveLinkFace', 'livelinkface', c.liveLinkFace.port, c.liveLinkFace.phoneIp),
      vmc: st('vmc', 'vmc', c.vmc.port),
      vtsApi: st('vtsApi', 'vts-api', c.vtsApi.port),
      vmcOut: { enabled: c.vmc.out.enabled, host: c.vmc.out.host, port: c.vmc.out.port, sent: this.vmcOut?.sent ?? 0, lastError: this.vmcOut?.lastError ?? null },
    };
  }

  // ---------- VTS API approvals / tokens
  private get vtsApi(): VtsApiServer | null {
    const r = this.runtimes.vtsApi;
    return r instanceof VtsApiServer ? r : null;
  }
  vtsPending() { return this.vtsApi?.listPending() ?? []; }
  vtsDecide(id: string, allow: boolean) { return this.vtsApi?.decide(id, allow) ?? false; }
  vtsTokens() { return this.store.vtsTokens.map(({ hash: _h, ...t }) => t); }
  vtsRevoke(id: string) {
    const before = this.store.vtsTokens.length;
    this.store.vtsTokens = this.store.vtsTokens.filter((t) => t.id !== id);
    if (this.store.vtsTokens.length === before) return false;
    this.save();
    this.vtsApi?.revoked(id);
    return true;
  }

  // ---------- bus tap (read-only)
  /** Passively observe studio messages: current avatar + latest frame. Never sends anything. */
  attachBus(wss: WebSocketServer) {
    wss.on('connection', (ws) => ws.on('message', (data: RawData) => { try { this.tap(data); } catch { /* never break the bus */ } }));
  }

  /** Exposed for tests. */
  tap(data: RawData | string) {
    const buf = typeof data === 'string' ? Buffer.from(data) : Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (buf.length > 2 * 1024 * 1024) return;
    const head = buf.toString('latin1', 0, Math.min(buf.length, 24));
    if (head.startsWith('{"type":"frame"')) {
      const now = Date.now();
      this.frameTimes.push(now);
      if (this.frameTimes.length > 240) this.frameTimes.splice(0, this.frameTimes.length - 240);
      const wantVmc = !!this.vmcOut && now - this.vmcOutAt >= 15;
      const wantApi = !!this.vtsApi && now - this.lastFrameParse >= 100;
      if (!wantVmc && !wantApi) return;
      const m = JSON.parse(buf.toString('utf8')) as { frame?: TrackingFrame };
      if (!m.frame || typeof m.frame !== 'object') return;
      this.lastFrameParse = now;
      this.frame = m.frame;
      this.frameAt = now;
      if (wantVmc) { this.vmcOutAt = now; this.vmcOut!.send(m.frame); }
    } else if (head.startsWith('{"type":"load"') || head.startsWith('{"type":"profile"')) {
      if (buf.length > 4096) return;
      const m = JSON.parse(buf.toString('utf8')) as { type: string; avatarId?: unknown };
      if (m.type === 'load' && typeof m.avatarId === 'string' && m.avatarId.length <= 128 && m.avatarId !== this.avatarId) {
        this.avatarId = m.avatarId;
        this.vtsApi?.modelChanged(m.avatarId);
      }
    } else if (head.startsWith('{"type":"command"') && this.busSubs.size > 0) {
      // the VTS API hears the studio's answers (model-state-reply, art-list-reply, item-state), item-event and model-clicked; only while
      // a plugin server is running, and only small messages (a frame or a picture is never one of these)
      if (buf.length > 256 * 1024) return;
      let m: unknown;
      try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
      for (const fn of [...this.busSubs]) { try { fn(m); } catch { /* a plugin handler never breaks the bus */ } }
    }
  }

  /** Feed a TrackingFrame to the VMC sender directly (alternative to the bus tap). */
  sendVmc(frame: TrackingFrame) { this.vmcOut?.send(frame); }
}
