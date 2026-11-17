// Shared helpers for the external tracking receivers (VTube Studio phone, iFacialMocap, Live Link Face, VMC, VTS API).
// Everything here is defensive: packets come from the LAN and may be malformed or hostile.
import { ARKIT_BY_NORM, normKey } from '../../src/core/arkit.ts';
import type { ExternalSourceKind, ExternalTracking, Vec3 } from '../../shared/types.ts';

/** Largest datagram / message we will look at. Real packets are 1–4 KB. */
export const MAX_PACKET = 64 * 1024;

/** Finite number or fallback (NaN / Infinity / strings / objects → fallback). */
export function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const clamp01 = (x: number) => clamp(x, 0, 1);
/** Finite, clamped. */
export const numC = (v: unknown, lo: number, hi: number, fallback = 0) => clamp(num(v, fallback), lo, hi);

/** Wrap degrees into [-180, 180) (phones sometimes send 0..360 Unity euler angles). */
export function wrapDeg(d: number): number {
  if (!Number.isFinite(d)) return 0;
  d = ((d + 180) % 360 + 360) % 360 - 180;
  return d;
}

/** Degrees → sanitized head triple [pitch, yaw, roll], each wrapped and clamped to ±90. */
export function headDeg(pitch: number, yaw: number, roll: number): Vec3 {
  return [clamp(wrapDeg(pitch), -90, 90), clamp(wrapDeg(yaw), -90, 90), clamp(wrapDeg(roll), -90, 90)];
}

export function eyeDeg(pitch: number, yaw: number): [number, number] {
  return [clamp(wrapDeg(pitch), -60, 60), clamp(wrapDeg(yaw), -60, 60)];
}

/**
 * Map any ARKit-ish name ("EyeBlinkLeft", "eyeBlink_L", "BlendShape.JawOpen", "mouthSmile_R") to the
 * canonical ARKit camelCase name, or null.
 */
export function arkitName(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) return null;
  return ARKIT_BY_NORM.get(normKey(raw)) ?? null;
}

/** Per-axis sign flips the user can toggle when a phone app/version uses the opposite convention. */
export interface AxisInvert { yaw: boolean; pitch: boolean; roll: boolean }

export function applyInvert(d: ExternalTracking, inv: AxisInvert | undefined) {
  if (!inv) return d;
  const bits = (inv.yaw ? 1 : 0) | (inv.pitch ? 2 : 0) | (inv.roll ? 4 : 0);
  if (bits) d.inv = bits;   // (the studio re-learns the rest pose when this changes: src/tracking/externalSource.ts)
  if (!d.head) return d;
  const [p, y, r] = d.head;
  d.head = [inv.pitch ? -p : p, inv.yaw ? -y : y, inv.roll ? -r : r];
  if (inv.yaw && d.headPos) d.headPos = [-d.headPos[0], d.headPos[1], d.headPos[2]];
  return d;
}

/** Lock policy (tests change it). `wizardOpen`: the "Find my phone" search is running, so a new sender may take over (the manager wires it).
 *  `candidateMs`: how long a sender that knocked while the lock was held stays offered to the user ("Another phone is sending - use it?"). */
export const lockPolicy = { wizardOpen: (): boolean => false, candidateMs: 8_000 };

/**
 * Which phone may drive the avatar when the user typed no IP. The first sender is locked in and HELD across silence (any other device on
 * the Wi-Fi could otherwise claim the lock after a pause and drive the avatar mid-stream). Another sender only takes over when the user
 * says so ("That's not my phone" = forget(), or "Use it" on the offer = take()), or while "Find my phone" is open (lockPolicy.wizardOpen).
 * A different device that sends while the lock is held is not used; it is remembered for a few seconds as `candidate()` so the studio can ask.
 */
export class SenderLock {
  private ip: string | null = null;
  private ignore: string | null = null;
  private seen = 0;
  private cand: { ip: string; at: number } | null = null;
  /** The locked-in phone's address (null = none yet, or the user let it go). */
  current(_now = Date.now()): string | null { return this.ip; }
  /** A different device that is sending right now while another phone holds the lock (null = none). */
  candidate(now = Date.now()): string | null { return this.cand && now - this.cand.at < lockPolicy.candidateMs ? this.cand.ip : null; }
  /** May a packet from `from` be used? `typed` = the IP the user pinned ('' = take the first sender). */
  allows(from: string, typed: string, now = Date.now()): boolean {
    if (typed) return from === typed;
    if (!this.ip) return from !== this.ignore;
    if (from === this.ip) return true;
    if (lockPolicy.wizardOpen() && from !== this.ignore) return true;   // (the wizard is open: the person is looking for a phone right now)
    this.cand = { ip: from, at: now };
    return false;
  }
  /** A good packet from an allowed sender arrived. */
  accept(from: string, typed: string, now = Date.now()) {
    if (!typed) { this.ip = from; this.ignore = null; this.cand = null; }
    this.seen = now;
  }
  /** "That's not my phone": let go; the next sender is taken. */
  forget(_now = Date.now()) { this.ignore = this.ip ?? this.ignore; this.ip = null; this.cand = null; }
  /** "Use it": the device that was knocking becomes the locked-in phone. Returns its address, or null when nobody was knocking. */
  take(now = Date.now()): string | null {
    const c = this.candidate(now);
    if (!c) return null;
    this.ignore = this.ip; this.ip = c; this.cand = null; this.seen = now;
    return c;
  }
}

/** Packets-per-second counter + last-seen bookkeeping for the status endpoint. */
export class RateCounter {
  total = 0;
  lastSeen: number | null = null;
  private window: number[] = [];
  hit(now = Date.now()) {
    this.total++;
    this.lastSeen = now;
    this.window.push(now);
    if (this.window.length > 400) this.window.splice(0, this.window.length - 400);
  }
  perSec(now = Date.now()) {
    while (this.window.length && now - this.window[0] > 1000) this.window.shift();
    return this.window.length;
  }
  reset() { this.total = 0; this.lastSeen = null; this.window = []; }
}

/**
 * Rate-limits publishing to `hz` per source. Always delivers the newest value: a packet that arrives
 * inside the cool-down is held and sent when the cool-down ends (trailing edge), older ones are dropped.
 */
export function throttled(fn: (d: ExternalTracking) => void, hz = 60) {
  const minGap = 1000 / hz;
  let last = 0;
  let pending: ExternalTracking | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    timer = null;
    if (!pending) return;
    const d = pending;
    pending = null;
    last = Date.now();
    try { fn(d); } catch (e) { console.error('[external] publish failed', e); }
  };
  const push = (d: ExternalTracking) => {
    pending = d;
    const wait = minGap - (Date.now() - last);
    if (wait <= 0 && !timer) fire();
    else if (!timer) timer = setTimeout(fire, Math.max(0, wait));
  };
  push.cancel = () => { if (timer) clearTimeout(timer); timer = null; pending = null; };
  return push;
}

/** Server receive time in seconds (ExternalTracking.t). */
export const nowSec = () => Date.now() / 1000;

export function emptyTracking(source: ExternalSourceKind, found: boolean): ExternalTracking {
  return { source, t: nowSec(), found };
}

/** Status of one receiver as returned by GET /api/external. */
export interface SourceStatus {
  kind: ExternalSourceKind;
  enabled: boolean;
  running: boolean;
  bind: string;
  port: number;
  phoneIp?: string;
  packetsPerSec: number;
  packetsTotal: number;
  /** ms since epoch, null = never. */
  lastSeen: number | null;
  faceFound: boolean;
  lastError: string | null;
  /** Source-specific extras (VTS API clients, last phone hotkey, sender address …). */
  info?: Record<string, unknown>;
}

export interface SourceRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): SourceStatus;
  /** "That's not my phone": drop the locked-in sender (the next one that sends is taken instead). */
  forget?(): void;
  /** "Use it": the device that was knocking while the lock was held takes over. */
  switchPhone?(): boolean;
}

/** IPv4/IPv6 literal or hostname, conservative. */
export function validHost(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 253 && /^[A-Za-z0-9.:\-]+$/.test(s);
}
export function validPort(p: unknown, allowZero = false): p is number {
  return typeof p === 'number' && Number.isInteger(p) && p >= (allowZero ? 0 : 1) && p <= 65535;
}

/** Strip an IPv4-mapped IPv6 prefix so "::ffff:192.168.1.5" matches "192.168.1.5". */
export const bareIp = (a: string | undefined) => (a ?? '').replace(/^::ffff:/, '');
