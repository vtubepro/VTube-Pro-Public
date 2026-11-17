// iFacialMocap (iOS) / FaceMotion3D UDP receiver.
//
// Protocol from the iFacialMocap developer page https://www.ifacialmocap.com/for-developer/ and checked
// against two open-source receivers: pkhungurn/talking-head-anime-3-demo (tha3/mocap/ifacialmocap_v2.py)
// and xuan25/VTube-IFacial-Link (ifacial/threads.py, ifacial/utils.py):
//   PC → phone UDP :49983  "iFacialMocap_sahuasouryya9218sauhuiayeta91555dy3719|sendDataVersion=v2"
//   phone → PC UDP :49983  ~60 Hz text frames:
//     v2: "mouthSmile_R&12|eyeLookOut_L&3|…|=head#pitch,yaw,roll,posX,posY,posZ|rightEye#x,y,z|leftEye#x,y,z|"
//     v1: same with "name-value" instead of "name&value". Blendshape values are 0..100, angles degrees.
//   Blendshape names are ARKit with _L / _R suffixes (performer's own sides).
//
// Axis conventions: head#X,Y,Z are Unity-style euler degrees (X = pitch, Y = yaw, Z = roll) — the same
// meaning as the VTube Studio phone packet's Rotation (see vtsPhone.ts). VTube-IFacial-Link maps
// FaceAngleX = +Y, FaceAngleY = −X, FaceAngleZ = −Z, exactly how VTube Studio maps its own phone data:
//   X > 0 pitch down, Y > 0 turn to the performer's right, Z > 0 tilt to the performer's left.
//   posX/Y/Z: metres; x > 0 performer's left, y up, z toward the phone (VTube-IFacial-Link: FacePositionZ = −z).
// Per-source "invert" toggles exist in case an app version disagrees.
// Eyes (checked against the vendors' own sample frames on ifacialmocap.com/for-developer and facemotion3d.net/english/
// for-developer, which carry the eyeLook* shapes AND the eye angles of the same frame): rightEye/leftEye#X,Y,Z are ARKit's
// eye eulers, X > 0 = looking down, Y > 0 = turned toward the performer's LEFT (rightEye Y +5.53 with eyeLookInRight 15;
// leftEye Y +1.26 with eyeLookOutLeft 3; iFacialMocap sample: rightEye +2.44 with In 9, leftEye −1.67 with In 4 / Out 3).
// Before beta.15 the yaw was negated (the eyes looked the wrong way sideways). The HEAD yaw / roll could not be proven from the
// same frames (they carry no head-vs-shape pair; the head X agrees with the eyes' counter-rotation, which only fixes pitch):
// ARKit geometry and pkhungurn's talking-head-anime-3 converter point to head Y + = the performer's LEFT (like the eyes),
// xuan25's VTube-IFacial-Link maps head Y straight to VTube Studio's FaceAngleX, which points the other way. Unresolved, so
// today's mapping stays and the phone card has "Head turns the wrong way? Flip it" (the invert switch, saved per source).
//
// Both ways of connecting work:
//   * PC → phone handshake: a typed phone IP gets the handshake (as before); with NO IP the handshake is BROADCAST to the
//     subnet + 255.255.255.255 (whether every app version answers a broadcast handshake is unconfirmed on real phones);
//   * phone pushes to PC: the user types this PC's address into the app ("Destination IP", Warudo's way) and the app
//     streams to :49983 without any handshake. With no IP set, the first phone that sends is locked in for as long as
//     the listener runs ("That's not my phone" in the studio = forget()).
// FaceMotion3D's own mode (not its iFacialMocap-compatible one): handshake "FACEMOTION3D_OtherStreaming" to the phone's
// UDP 49993, data then arrives on :49983 in the same text format with "&" values (facemotion3d.net/english/for-developer).
import dgram from 'node:dgram';
import type { ExternalTracking } from '../../shared/types.ts';
import {
  MAX_PACKET, RateCounter, SenderLock, arkitName, applyInvert, bareIp, clamp, clamp01, eyeDeg, headDeg, num, nowSec, throttled,
  type AxisInvert, type SourceRuntime, type SourceStatus,
} from './common.ts';

export const IFM_HANDSHAKE = 'iFacialMocap_sahuasouryya9218sauhuiayeta91555dy3719|sendDataVersion=v2';
export const FM3D_HANDSHAKE = 'FACEMOTION3D_OtherStreaming';


export interface IFacialMocapConfig {
  enabled: boolean;
  phoneIp: string;
  /** Port the phone listens on for the handshake (49983). */
  phonePort: number;
  /** Local port the phone streams to — the app always sends to 49983. */
  port: number;
  bind: string;
  invert: AxisInvert;
  /** With no phone IP: broadcast the handshake (the phone may also push to us on its own). */
  discover: boolean;
  /** FaceMotion3D's own handshake port on the phone (49993); 0 = don't send it. */
  fm3dPort: number;
}

export const IFM_DEFAULTS: IFacialMocapConfig = {
  enabled: false, phoneIp: '', phonePort: 49983, port: 49983, bind: '0.0.0.0',
  invert: { yaw: false, pitch: false, roll: false }, discover: true, fm3dPort: 49993,
};

const floats = (s: string, n: number) => {
  const parts = s.split(',', n + 1);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(num(parts[i]));
  return out;
};

/** Parse one iFacialMocap text frame (v1 or v2). Returns null when nothing recognisable was in it. */
export function parseIFacialMocap(text: string): ExternalTracking | null {
  const d: ExternalTracking = { source: 'ifacialmocap', t: nowSec(), found: true };
  const bs: Record<string, number> = {};
  let any = false;
  const parts = text.split('|');
  if (parts.length > 256) return null;
  for (let part of parts) {
    part = part.trim();
    if (!part) continue;
    const hash = part.indexOf('#');
    if (hash > 0) {
      const key = part.slice(0, hash).replace(/^=/, '');
      const vals = part.slice(hash + 1);
      if (key === 'head') {
        const [x, y, z, px, py, pz] = floats(vals, 6);
        d.head = headDeg(x, -y, z);
        d.headPos = [clamp(px, -2, 2), clamp(py, -2, 2), clamp(pz, -2, 2)];
        any = true;
      } else if (key === 'rightEye' || key === 'leftEye') {
        // ARKit's own eye euler, no flip: Y > 0 = the eye turns toward the performer's LEFT (the vendors' sample frames, see the
        // header and tools/phone_apps_unit.ts: rightEye Y = +5.53 with eyeLookInRight 15 and eyeLookOutRight 0)
        const [x, y] = floats(vals, 3);
        if (key === 'rightEye') d.eyeRight = eyeDeg(x, y); else d.eyeLeft = eyeDeg(x, y);
        any = true;
      }
      continue;
    }
    // v2 "name&value", v1 "name-value" (names never contain '-' or '&'; values are 0..100)
    let sep = part.indexOf('&');
    if (sep < 0) sep = part.indexOf('-');
    if (sep <= 0) continue;
    const k = arkitName(part.slice(0, sep));
    if (!k) continue;
    bs[k] = clamp01(num(part.slice(sep + 1)) / 100);
    any = true;
  }
  if (!any) return null;
  d.blendshapes = bs;
  return d;
}

export class IFacialMocapSource implements SourceRuntime {
  private sock: dgram.Socket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private rate = new RateCounter();
  private lastError: string | null = null;
  private publish: ReturnType<typeof throttled>;
  /** The phone that answered (no IP typed): locked in and held across silence (SenderLock). */
  private lock = new SenderLock();
  /** FaceMotion3D's own mode may stream to PC port 49993 instead of 49983 (its developer page says both): best-effort second listener. */
  private sock2: dgram.Socket | null = null;
  private port2Note: string | null = null;
  private broadcasts = 0;

  constructor(private cfg: IFacialMocapConfig, publish: (d: ExternalTracking) => void,
    private targets: () => string[] | Promise<string[]> = () => ['255.255.255.255']) {
    this.publish = throttled(publish, 60);
  }

  async start() {
    if (this.sock) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    sock.on('error', (e) => { this.lastError = e.message; });
    sock.on('message', (msg, rinfo) => this.onPacket(msg, rinfo));
    await new Promise<void>((resolve, reject) => {
      sock.once('error', reject);
      sock.bind(this.cfg.port, this.cfg.bind, () => { sock.off('error', reject); resolve(); });
    }).catch((e: Error) => { this.lastError = `Can't listen on UDP ${this.cfg.bind}:${this.cfg.port} — ${e.message}`; try { sock.close(); } catch { /* */ } throw e; });
    this.sock = sock;
    try { sock.setBroadcast(true); } catch { /* manual IP still works */ }
    this.lastError = null;
    const p2 = this.cfg.fm3dPort;
    if (p2 && p2 !== this.cfg.port) {
      const s2 = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      s2.on('message', (msg, rinfo) => this.onPacket(msg, rinfo));
      await new Promise<void>((resolve) => {
        s2.once('error', (e) => { this.port2Note = `port ${p2} not used (${e.message})`; try { s2.close(); } catch { /* */ } resolve(); });
        s2.bind(p2, this.cfg.bind, () => { s2.removeAllListeners('error'); s2.on('error', () => {}); this.sock2 = s2; resolve(); });
      });
    }
    this.handshake();
    // The app keeps streaming after one handshake; repeat only while nothing arrives (app restarted, Wi-Fi blip).
    this.timer = setInterval(() => {
      if (this.rate.lastSeen === null || Date.now() - this.rate.lastSeen > 2000) this.handshake();
    }, 2000);
  }

  private phone(): string | null {
    if (this.cfg.phoneIp) return this.cfg.phoneIp;
    return this.lock.current();
  }

  forget() { this.lock.forget(); this.rate.reset(); }
  /** "Use it": the device that was knocking takes over (SenderLock.take). */
  switchPhone(): boolean { const c = this.lock.take(); if (c) this.rate.reset(); return !!c; }

  private handshake() {
    const sock = this.sock;
    if (!sock) return;
    const send = (ip: string, note: (e: Error | null) => void) => {
      sock.send(IFM_HANDSHAKE, this.cfg.phonePort, ip, note);
      if (this.cfg.fm3dPort) sock.send(FM3D_HANDSHAKE, this.cfg.fm3dPort, ip, () => {});
    };
    const ip = this.phone();
    if (ip) { send(ip, (e) => { if (e) this.lastError = `Handshake to ${ip} failed — ${e.message}`; }); return; }
    if (!this.cfg.discover) return;
    void Promise.resolve(this.targets()).then((list) => {
      if (this.sock !== sock) return;
      for (const t of list) { this.broadcasts++; send(t, () => {}); }
    }).catch(() => {});
  }

  private onPacket(msg: Buffer, rinfo: dgram.RemoteInfo) {
    if (msg.length > MAX_PACKET) return;
    const from = bareIp(rinfo.address);
    if (!this.lock.allows(from, this.cfg.phoneIp)) return;
    const d = parseIFacialMocap(msg.toString('utf8'));
    if (!d) return;
    this.lock.accept(from, this.cfg.phoneIp);
    this.rate.hit();
    this.publish(applyInvert(d, this.cfg.invert));
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.publish.cancel();
    const s = this.sock;
    this.sock = null;
    if (s) await new Promise<void>((r) => { try { s.close(() => r()); } catch { r(); } });
    const s2 = this.sock2;
    this.sock2 = null;
    if (s2) await new Promise<void>((r) => { try { s2.close(() => r()); } catch { r(); } });
  }

  status(): SourceStatus {
    const fresh = this.rate.lastSeen !== null && Date.now() - this.rate.lastSeen < 1000;
    return {
      kind: 'ifacialmocap', enabled: this.cfg.enabled, running: !!this.sock, bind: this.cfg.bind, port: this.cfg.port,
      phoneIp: this.cfg.phoneIp, packetsPerSec: this.rate.perSec(), packetsTotal: this.rate.total, lastSeen: this.rate.lastSeen,
      faceFound: fresh, lastError: this.lastError,
      info: { phonePort: this.cfg.phonePort, mode: this.cfg.phoneIp ? 'manual' : 'discover', phone: this.phone(), candidate: this.lock.candidate(), broadcasts: this.broadcasts, port2: this.sock2 ? this.cfg.fm3dPort : null, port2Note: this.port2Note },
    };
  }
}
