// VTube Studio phone tracking protocol (VTube Studio iPhone/Android app with "3rd Party PC Clients" on,
// MeowFace on Android, and other apps that speak it).
//
// Protocol, from DenchiSoft's reference receiver
//   https://github.com/DenchiSoft/VTubeStudioBlendshapeUDPReceiverTest (README + VTubeStudioRawTrackingData.cs)
// and the Warudo VTS receiver https://github.com/Veasu/warudo-vtubestudio (VTubeStudioClient.cs):
//   PC → phone UDP :21412   {"messageType":"iOSTrackingDataRequest","time":<0.5..10 s>,"sentBy":"<app>","ports":[<PC ports>]}
//                           (re-send before `time` runs out; Warudo sends "sendForSeconds" instead of "time", so we send both)
//   phone → PC  UDP :ports  ~60 Hz JSON (Unity JsonUtility):
//     { "Timestamp": <unix ms>, "Hotkey": <-1 | 1..8 on-screen button>, "FaceFound": bool,
//       "Rotation": {x,y,z}, "Position": {x,y,z}, "EyeLeft": {x,y,z}, "EyeRight": {x,y,z},
//       "BlendShapes": [{"k":"EyeBlinkLeft","v":0.12}, …]   // ARKit names, PascalCase, performer's own sides
//       "VNyanPos"?: {x,y,z} (MeowFace extra) }
//
// Axis conventions (degrees, Unity euler): Rotation.x = yaw, .y = pitch, .z = roll. Derived from how the
// reference receivers apply them — DenchiSoft's demo cube uses Euler(-y, -x, z) on a camera-facing cube,
// Warudo uses Quaternion.Euler(y, x, z) on a +Z-facing Unity head bone — which gives:
//   Rotation.x > 0 : head turns to the performer's RIGHT   → ExternalTracking yaw   = -x
//   Rotation.y > 0 : head pitches DOWN                     → ExternalTracking pitch = +y
//   Rotation.z > 0 : head tilts to the performer's LEFT    → ExternalTracking roll  = +z
//   Position (≈ cm, Warudo scales it by 0.04 into its own units): x > 0 performer's left, y up, z away from the phone
//   EyeLeft/EyeRight: Unity euler for the eye bones, x > 0 down, y > 0 toward the performer's right
// If a particular app/version disagrees, the per-source "invert" toggles flip an axis.
//
// Discovery (no IP typing): with no phone IP set, the request is BROADCAST to the subnet + 255.255.255.255 on :21412
// (the same way Laplace Persona finds the phone) and the first phone that answers is locked in while it keeps sending
// (another sender is ignored and the lock is held across silence; a phone that came back with a new Wi-Fi address is
// offered with "Use it": common.ts SenderLock). The studio shows "Phone: <IP>" with "That's not my phone" (forget()), which
// drops the lock and broadcasts again. A typed IP still works as before.
import dgram from 'node:dgram';
import type { ExternalTracking } from '../../shared/types.ts';
import {
  MAX_PACKET, RateCounter, SenderLock, arkitName, applyInvert, bareIp, clamp, clamp01, eyeDeg, headDeg, num, nowSec, throttled,
  type AxisInvert, type SourceRuntime, type SourceStatus,
} from './common.ts';

export interface VtsPhoneConfig {
  enabled: boolean;
  /** Phone IP as shown in the VTube Studio / MeowFace app. */
  phoneIp: string;
  /** Port the phone listens on for data requests (21412). */
  phonePort: number;
  /** Local UDP port the phone streams to (0 = any free port). */
  listenPort: number;
  bind: string;
  invert: AxisInvert;
  /** Broadcast the request when no phone IP is set (default on). */
  discover: boolean;
}

export const VTS_PHONE_DEFAULTS: VtsPhoneConfig = {
  enabled: false, phoneIp: '', phonePort: 21412, listenPort: 21413, bind: '0.0.0.0',
  invert: { yaw: false, pitch: false, roll: false }, discover: true,
};


type V3 = { x?: unknown; y?: unknown; z?: unknown } | undefined;
const v3 = (v: unknown): [number, number, number] | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as V3 & object;
  return [num(o.x), num(o.y), num(o.z)];
};

/** Normalise one phone packet (already JSON-parsed). Returns null if it isn't a tracking packet. */
export function parseVtsPhonePacket(j: unknown): { data: ExternalTracking; hotkey: number } | null {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (!('FaceFound' in o) && !('BlendShapes' in o) && !('Rotation' in o)) return null;
  const d: ExternalTracking = { source: 'vts-phone', t: nowSec(), found: o.FaceFound === true };
  const rot = v3(o.Rotation);
  if (rot) d.head = headDeg(rot[1], -rot[0], rot[2]);
  const pos = v3(o.Position);
  if (pos) d.headPos = [clamp(pos[0] * 0.01, -2, 2), clamp(pos[1] * 0.01, -2, 2), clamp(-pos[2] * 0.01, -2, 2)];
  const el = v3(o.EyeLeft), er = v3(o.EyeRight);
  if (el) d.eyeLeft = eyeDeg(el[0], -el[1]);
  if (er) d.eyeRight = eyeDeg(er[0], -er[1]);
  if (Array.isArray(o.BlendShapes)) {
    const bs: Record<string, number> = {};
    for (const e of o.BlendShapes.slice(0, 96)) {
      if (!e || typeof e !== 'object') continue;
      const k = arkitName(String((e as { k?: unknown }).k ?? ''));
      if (k) bs[k] = clamp01(num((e as { v?: unknown }).v));
    }
    d.blendshapes = bs;
  }
  const hk = Math.trunc(num(o.Hotkey, -1));
  return { data: d, hotkey: hk >= 1 && hk <= 8 ? hk : -1 };
}

export class VtsPhoneSource implements SourceRuntime {
  private sock: dgram.Socket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private rate = new RateCounter();
  private lastError: string | null = null;
  private faceFound = false;
  private lastHotkey = -1;
  private boundPort = 0;
  private publish: ReturnType<typeof throttled>;
  /** The phone found by the broadcast (no IP typed): locked in and held across silence (SenderLock). */
  private lock = new SenderLock();
  private broadcasts = 0;

  constructor(private cfg: VtsPhoneConfig, publish: (d: ExternalTracking) => void, private onHotkey?: (n: number) => void,
    /** Where a discovery broadcast goes (the subnet broadcast + 255.255.255.255; tests pass loopback). */
    private targets: () => string[] | Promise<string[]> = () => ['255.255.255.255']) {
    this.publish = throttled(publish, 60);
  }

  async start() {
    if (this.sock) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    sock.on('error', (e) => { this.lastError = e.message; });
    sock.on('message', (msg, rinfo) => this.onPacket(msg, rinfo));
    await new Promise<void>((resolve, reject) => {
      const fail = (e: Error) => { reject(e); };
      sock.once('error', fail);
      sock.bind(this.cfg.listenPort, this.cfg.bind, () => { sock.off('error', fail); resolve(); });
    }).catch((e: Error) => { this.lastError = `Can't listen on UDP ${this.cfg.bind}:${this.cfg.listenPort} — ${e.message}`; try { sock.close(); } catch { /* */ } throw e; });
    this.sock = sock;
    this.boundPort = sock.address().port;
    try { sock.setBroadcast(true); } catch { /* not fatal: manual IP still works */ }
    this.lastError = null;
    const request = () => this.sendRequest();
    request();
    this.timer = setInterval(request, 1000);
  }

  /** The phone we talk to: the typed IP, else the one discovery found (null = still looking). */
  private phone(): string | null {
    if (this.cfg.phoneIp) return this.cfg.phoneIp;
    return this.lock.current();
  }

  forget() { this.lock.forget(); this.faceFound = false; this.rate.reset(); }
  /** "Use it": the device that was knocking takes over (SenderLock.take). */
  switchPhone(): boolean { const c = this.lock.take(); if (c) { this.faceFound = false; this.rate.reset(); } return !!c; }

  private sendRequest() {
    const sock = this.sock;
    if (!sock) return;
    const body = JSON.stringify({ messageType: 'iOSTrackingDataRequest', time: 3, sendForSeconds: 3, sentBy: 'VTubePro', ports: [this.boundPort] });
    const ip = this.phone();
    if (ip) { sock.send(body, this.cfg.phonePort, ip, (e) => { if (e) this.lastError = `Request to ${ip}:${this.cfg.phonePort} failed — ${e.message}`; }); return; }
    if (!this.cfg.discover) return;
    void Promise.resolve(this.targets()).then((list) => {
      if (this.sock !== sock) return;
      for (const t of list) { this.broadcasts++; sock.send(body, this.cfg.phonePort, t, () => { /* a missing route is normal on some adapters */ }); }
    }).catch(() => {});
  }

  private onPacket(msg: Buffer, rinfo: dgram.RemoteInfo) {
    if (msg.length > MAX_PACKET) return;
    // only the configured (or the discovered) phone may drive the avatar
    const from = bareIp(rinfo.address);
    if (!this.lock.allows(from, this.cfg.phoneIp)) return;
    let j: unknown;
    try { j = JSON.parse(msg.toString('utf8')); } catch { this.lastError = 'Malformed packet (not JSON)'; return; }
    const r = parseVtsPhonePacket(j);
    if (!r) return;
    this.lock.accept(from, this.cfg.phoneIp);
    this.rate.hit();
    this.faceFound = r.data.found;
    if (r.hotkey !== -1 && r.hotkey !== this.lastHotkey) this.onHotkey?.(r.hotkey);
    this.lastHotkey = r.hotkey;
    this.publish(applyInvert(r.data, this.cfg.invert));
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.publish.cancel();
    const s = this.sock;
    this.sock = null;
    if (s) await new Promise<void>((r) => { try { s.close(() => r()); } catch { r(); } });
  }

  status(): SourceStatus {
    return {
      kind: 'vts-phone', enabled: this.cfg.enabled, running: !!this.sock, bind: this.cfg.bind,
      port: this.boundPort || this.cfg.listenPort, phoneIp: this.cfg.phoneIp,
      packetsPerSec: this.rate.perSec(), packetsTotal: this.rate.total, lastSeen: this.rate.lastSeen,
      faceFound: this.faceFound && this.rate.lastSeen !== null && Date.now() - this.rate.lastSeen < 1000,
      lastError: !this.cfg.phoneIp && !this.cfg.discover && this.sock ? 'Enter the phone IP shown in the app' : this.lastError,
      info: { lastHotkey: this.lastHotkey, phonePort: this.cfg.phonePort, mode: this.cfg.phoneIp ? 'manual' : 'discover', phone: this.phone(), candidate: this.lock.candidate(), broadcasts: this.broadcasts },
    };
  }
}
