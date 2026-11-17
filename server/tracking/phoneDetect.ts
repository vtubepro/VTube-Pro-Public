// "Find my phone": listen on every known phone port at once and say which app is sending (so a streamer who does not
// know what their app speaks only has to open it). Nothing here drives the avatar and nothing is published: it only
// classifies packets (and, like the sources' own discovery, broadcasts the iFacialMocap / FaceMotion3D / VTube Studio
// request on the LAN) until the user picks the app it found.
//
//   VTube Studio / MeowFace   JSON, reply to our request on UDP :21413 (the PC asks the phone at :21412)
//   iFacialMocap              text "name&value|...|=head#..." to :49983 (the PC asks the phone at :49983)
//   FaceMotion3D (own mode)   the same text, "FM_*" extras, asked at the phone's :49993, may answer to :49993 (its docs differ)
//   Live Link Face            big-endian binary, the phone pushes to :11111
//   VMC (Waidayo, VSeeFace…)  OSC "/VMC/Ext/..." the phone pushes to :39539 or :39540
//
// A port that something already listens on (the user's own source, or another VTuber app) is reported as skipped, not
// as an error; the manager adds its own running sources (a phone already received there) to the answer.
import dgram from 'node:dgram';
import { MAX_PACKET, arkitName, bareIp } from './common.ts';
import { FM3D_HANDSHAKE, IFM_HANDSHAKE, parseIFacialMocap } from './ifacialmocap.ts';
import { LLF_MAX_PACKET, parseLiveLinkFace } from './liveLinkFace.ts';
import { parseOsc } from './osc.ts';
import { parseVtsPhonePacket } from './vtsPhone.ts';

export type DetectApp = 'vtsPhone' | 'ifacialmocap' | 'liveLinkFace' | 'vmc';
export interface Classified { app: DetectApp; label: string; detail: string; faceFound: boolean }
export interface Detected extends Classified { ip: string; port: number; packets: number; lastSeen: number }

/** Which app sent this datagram (null = not a phone-tracking packet we know). `port` = the local port it arrived on. */
export function classifyPacket(msg: Buffer, port = 0, fm3dPort = 49993): Classified | null {
  if (!Buffer.isBuffer(msg) || msg.length < 8 || msg.length > MAX_PACKET) return null;
  const c0 = msg[0];
  if (c0 === 0x7b) { // '{'
    let j: unknown;
    try { j = JSON.parse(msg.toString('utf8')); } catch { return null; }
    const r = parseVtsPhonePacket(j);
    if (!r) return null;
    const meow = !!j && typeof j === 'object' && 'VNyanPos' in (j as object);
    const n = Object.keys(r.data.blendshapes ?? {}).length;
    return { app: 'vtsPhone', label: meow ? 'MeowFace (Android)' : 'VTube Studio / MeowFace', detail: `${n} face shapes${r.data.head ? ', head' : ''}`, faceFound: r.data.found };
  }
  if (c0 === 0x2f || c0 === 0x23) { // '/' or '#bundle'
    let m;
    try { m = parseOsc(msg); } catch { return null; }
    if (!m.some((x) => x.address.startsWith('/VMC/'))) return null;
    let ark = 0, head = false;
    for (const x of m) {
      if (x.address === '/VMC/Ext/Blend/Val' && typeof x.args[0] === 'string' && arkitName(x.args[0])) ark++;
      if (x.address === '/VMC/Ext/Bone/Pos' && x.args[0] === 'Head') head = true;
    }
    return { app: 'vmc', label: ark >= 20 ? 'A VMC app with ARKit shapes (Waidayo)' : 'A VMC app (Waidayo, VSeeFace, VNyan…)', detail: `${ark} ARKit shapes${head ? ', head' : ''}`, faceFound: true };
  }
  if (msg.length <= LLF_MAX_PACKET && c0 < 32) {
    const p = parseLiveLinkFace(msg);
    if (p) return { app: 'liveLinkFace', label: 'Live Link Face', detail: p.subject ? `phone “${p.subject}”` : 'Live Link (ARKit)', faceFound: p.data.found };
  }
  if (c0 >= 0x41 && c0 <= 0x7a) { // a letter: "mouthSmile_R&12|..." / "eyeBlinkLeft&3|..."
    const text = msg.toString('utf8');
    if (!text.includes('|')) return null;
    const d = parseIFacialMocap(text);
    if (!d) return null;
    const fm = /\bFM_[A-Za-z]+&/.test(text) || port === fm3dPort;
    return { app: 'ifacialmocap', label: fm ? 'FaceMotion3D' : 'iFacialMocap', detail: `${Object.keys(d.blendshapes ?? {}).length} face shapes${d.head ? ', head' : ''}`, faceFound: true };
  }
  return null;
}

export interface DetectPorts { vts: number; ifm: number; fm3d: number; llf: number; vmc: number; vmc2: number }
export const DETECT_PORTS: DetectPorts = { vts: 21413, ifm: 49983, fm3d: 49993, llf: 11111, vmc: 39539, vmc2: 39540 };
/** Detection stops by itself after this long (the broadcasts are not left running). */
export const DETECT_MAX_MS = 120_000;

/** At most this many distinct senders are kept per search. */
export const DETECT_MAX_FOUND = 64;

export class PhoneDetector {
  private socks = new Map<number, dgram.Socket>();
  private found = new Map<string, Detected>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopAt = 0;
  skipped: { port: number; why: string }[] = [];
  startedAt: number | null = null;
  /** Datagrams that arrived but were not any known app (a hint for "something is sending, but not a phone app"). */
  unknown = 0;

  constructor(private ports: DetectPorts = DETECT_PORTS, private targets: () => string[] | Promise<string[]> = () => ['255.255.255.255'],
    /** where the phone apps listen for our request (tests point these at fake phones) */
    private remote = { vts: 21412, ifm: 49983, fm3d: 49993 },
    private maxMs = DETECT_MAX_MS) {}

  get on() { return this.socks.size > 0; }

  async start() {
    if (this.on) return;
    this.found.clear(); this.skipped = []; this.unknown = 0;
    this.startedAt = Date.now(); this.stopAt = this.startedAt + this.maxMs;
    const want = [...new Set(Object.values(this.ports).filter((p) => p > 0))];
    await Promise.all(want.map((port) => new Promise<void>((resolve) => {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      s.on('error', () => {});
      s.on('message', (msg, rinfo) => this.onPacket(msg, rinfo, port));
      s.once('error', (e) => { this.skipped.push({ port, why: /EADDRINUSE/.test(e.message) ? 'already in use (a source of ours or another app is listening there)' : e.message }); try { s.close(); } catch { /* */ } resolve(); });
      s.bind(port, '0.0.0.0', () => { s.removeAllListeners('error'); s.on('error', () => {}); try { s.setBroadcast(true); } catch { /* */ } this.socks.set(port, s); resolve(); });
    })));
    if (!this.socks.size) return;
    this.ask();
    this.timer = setInterval(() => { if (Date.now() >= this.stopAt) void this.stop(); else this.ask(); }, 2000);
  }

  /** The requests the sources send when no IP is typed (they only reach a phone whose app is open and listening). */
  private ask() {
    void Promise.resolve(this.targets()).then((list) => {
      const vts = this.socks.get(this.ports.vts), ifm = this.socks.get(this.ports.ifm);
      const req = JSON.stringify({ messageType: 'iOSTrackingDataRequest', time: 3, sendForSeconds: 3, sentBy: 'VTubePro', ports: [this.ports.vts] });
      for (const t of list) {
        vts?.send(req, this.remote.vts, t, () => {});
        ifm?.send(IFM_HANDSHAKE, this.remote.ifm, t, () => {});
        ifm?.send(FM3D_HANDSHAKE, this.remote.fm3d, t, () => {});
      }
    }).catch(() => {});
  }

  private onPacket(msg: Buffer, rinfo: dgram.RemoteInfo, port: number) {
    const c = classifyPacket(msg, port, this.ports.fm3d);
    if (!c) { this.unknown++; return; }
    const ip = bareIp(rinfo.address), key = `${c.app}|${c.label}|${ip}`;
    const prev = this.found.get(key);
    if (!prev && this.found.size >= DETECT_MAX_FOUND) { this.unknown++; return; }   // (a LAN flood of fake senders cannot grow the list without bound)
    this.found.set(key, { ...c, ip, port, packets: (prev?.packets ?? 0) + 1, lastSeen: Date.now() });
  }

  /** What was heard, newest first. */
  results(): Detected[] { return [...this.found.values()].sort((a, b) => b.lastSeen - a.lastSeen); }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const all = [...this.socks.values()];
    this.socks.clear();
    await Promise.all(all.map((s) => new Promise<void>((r) => { try { s.close(() => r()); } catch { r(); } })));
  }
}
