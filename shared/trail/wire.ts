// The Trail — network protocol (TECH.md §4). Reliable JSON messages ride the party's 'ctl' channel as
// { t: 'game', d: TrailCtl }; realtime binary snapshots / inputs ride its unreliable 'rt' channel (first byte 0x54 / 0x49).
// Everything received is sanitised here (guests can be modified clients; the host is trusted for game state).
import type { GameState, RoleId } from './types.ts';
import { ROLE_IDS } from './types.ts';

export const TRAIL_PROTO = 2;   // 2: v2 journey (snapshot header carries the floating origin)
export const TRAIL_CAP = 'trail1';
export const PKT_SNAP = 0x54;   // 'T' host → guest
export const PKT_INPUT = 0x49;  // 'I' guest → host
export const MAX_RT = 4000;     // the party's rt receive limit is 4096

// ---------------------------------------------------------------- entities (sent once per stop / on spawn, reliable)
export type EntKind = 'player' | 'prop' | 'wagon' | 'animal' | 'npc' | 'platform' | 'fx';
export interface EntInfo {
  id: number; kind: EntKind;
  /** prop: item / prop id ('crate_food', 'spare_wheel', 'carcass:hog'…); animal: animal id; npc: npc id; player: player id */
  sub: string;
  /** Box half-extents / capsule [radius, halfHeight, 0] (m) — the client's placeholder shape + interpolation bounds. */
  size: [number, number, number];
  shape: 'box' | 'capsule' | 'cylinder' | 'sphere';
  mass?: number; price?: number; owned?: boolean; value?: number; label?: string; color?: string;
  /** props: the inventory item it stands for (food, wheel, …) — the load hints */
  item?: string;
}

// ---------------------------------------------------------------- reliable messages
export type TrailCtl =
  | { k: 'hello'; v: number; theme: string; session: string; you: string; host: string; deck?: unknown }
  | { k: 'state'; s: GameState }
  | { k: 'level'; id: string; stop: string; ents: EntInfo[]; origin?: [number, number, number]; desc?: unknown; theme: string; seed: string }
  | { k: 'spawn'; ents: EntInfo[] } | { k: 'despawn'; ids: number[] }
  | { k: 'ev'; e: TrailEvent }
  | { k: 'end' }
  /** host → every game peer, every 3 s: "this game session is alive" (guests drop stale sessions without it) */
  | { k: 'ping'; session: string }
  // guest → host
  /** guest → host, every 3 s while a guest session exists (a reloaded host studio learns a game is still on screen) */
  | { k: 'here'; session: string }
  | { k: 'join'; v: number; name: string; height: number; role?: RoleId }
  | { k: 'cmd'; c: TrailCmd };

/** One-shot events for every view (toasts, sounds, fx, cards already live in GameState). */
export type TrailEvent =
  | { e: 'toast'; text: string; tone?: 'info' | 'good' | 'bad' | 'meme'; who?: string }
  | { e: 'fx'; fx: 'splash' | 'dust' | 'impact' | 'fire' | 'sparkle' | 'confetti' | 'launch' | 'shot' | 'hit' | 'tip'; at: [number, number, number]; n?: number; by?: string }
  | { e: 'death'; id: string; name: string; cause: string }
  | { e: 'talk'; npc: string; name: string; line: string; to: string }
  | { e: 'photo'; names: string[] }
  | { e: 'rebase'; dz: number; dx?: number }
  /** v2: a meme moment (banner + the director cuts to it); `k` = what the views do (big head, floaty, buzz …) */
  | { e: 'meme'; id: string; tier: 'common' | 'rare' | 'legendary'; text: string; k?: string; who?: string; at?: [number, number, number]; dur?: number }
  /** v2: a player's emote (the avatar plays it; bubbles + sound on every view) */
  | { e: 'emote'; who: string; id: string }
  | { e: 'shake'; k: number }
  | { e: 'sound'; s: string; at?: [number, number, number] }
  | { e: 'swap'; a: string; b: string } | { e: 'unswap' };

export type TrailCmd =
  | { c: 'vote'; opt: string } | { c: 'role'; role: RoleId } | { c: 'ready'; on: boolean } | { c: 'start' }
  | { c: 'buy'; item: string; n: number } | { c: 'epitaph'; text: string } | { c: 'halt' } | { c: 'continue' }
  | { c: 'pace'; v: string } | { c: 'rations'; v: string } | { c: 'emote'; id: string } | { c: 'lobby'; key: string; val: unknown }
  | { c: 'force'; opt: string } | { c: 'pause'; on: boolean } | { c: 'seat' } | { c: 'respawn' } | { c: 'drive' } | { c: 'unstuck' }
  /** guest: I'm out (my player leaves the game) / host: send me the game again (a new join prompt) */
  | { c: 'leave' } | { c: 'rejoin' };

const s = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, n) : '');
const num = (v: unknown, lo: number, hi: number, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** Host side: a guest's message, cleaned (null = drop). Guests can only join / send commands. */
export function sanitizeFromGuest(d: unknown): TrailCtl | null {
  if (!d || typeof d !== 'object') return null;
  const m = d as Record<string, unknown>;
  if (m.k === 'join') return { k: 'join', v: num(m.v, 0, 99), name: s(m.name, 40) || 'Pilgrim', height: num(m.height, 0.03, 100, 1.7), role: ROLE_IDS.includes(m.role as RoleId) ? (m.role as RoleId) : undefined };
  if (m.k === 'here') return { k: 'here', session: s(m.session, 16) };
  if (m.k !== 'cmd' || !m.c || typeof m.c !== 'object') return null;
  const c = m.c as Record<string, unknown>;
  switch (c.c) {
    case 'vote': return { k: 'cmd', c: { c: 'vote', opt: s(c.opt, 32) } };
    case 'role': return ROLE_IDS.includes(c.role as RoleId) ? { k: 'cmd', c: { c: 'role', role: c.role as RoleId } } : null;
    case 'ready': return { k: 'cmd', c: { c: 'ready', on: c.on === true } };
    case 'buy': return { k: 'cmd', c: { c: 'buy', item: s(c.item, 16), n: Math.round(num(c.n, 1, 20, 1)) } };
    case 'epitaph': return { k: 'cmd', c: { c: 'epitaph', text: s(c.text, 60) } };
    case 'halt': case 'continue': case 'seat': case 'respawn': case 'leave': case 'rejoin': case 'drive': case 'unstuck': return { k: 'cmd', c: { c: c.c } };
    case 'pace': case 'rations': return { k: 'cmd', c: { c: c.c, v: s(c.v, 12) } };
    case 'emote': return { k: 'cmd', c: { c: 'emote', id: s(c.id, 16) } };
    default: return null; // start / lobby / force / pause are host-only
  }
}
/** Guest side: the host's message (trusted for content, still shape-checked + size-capped by the party). */
export function sanitizeFromHost(d: unknown): TrailCtl | null {
  if (!d || typeof d !== 'object') return null;
  const k = (d as { k?: unknown }).k;
  if (k === 'ping') return { k: 'ping', session: s((d as { session?: unknown }).session, 16) };
  return k === 'hello' || k === 'state' || k === 'level' || k === 'spawn' || k === 'despawn' || k === 'ev' || k === 'end' ? (d as TrailCtl) : null;
}

// ---------------------------------------------------------------- inputs (guest → host, rt, 30 Hz, 3 frames redundancy)
export const BTN = { jump: 1, sprint: 2, grab: 4, throw: 8, use: 16, fire: 32, crouch: 64, ping: 128 } as const;
export interface InputFrame {
  seq: number;
  /** Move intent in the player's view space: x = right, z = forward, each −1..1. */
  mx: number; mz: number;
  /** View yaw (rad, world) + pitch (rad, + = up). */
  yaw: number; pitch: number;
  buttons: number;
  /** Hold distance for a grabbed object (m, 0 = default). */
  hold: number;
}
export const emptyInput = (): InputFrame => ({ seq: 0, mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0, hold: 0 });

export function encodeInputs(frames: InputFrame[], ack: number): Uint8Array {
  const n = Math.min(3, frames.length);
  const out = new Uint8Array(6 + n * 9);
  const dv = new DataView(out.buffer);
  out[0] = PKT_INPUT; out[1] = TRAIL_PROTO; dv.setUint16(2, ack & 0xffff); out[4] = n; out[5] = 0;
  for (let i = 0; i < n; i++) {
    const f = frames[frames.length - n + i], o = 6 + i * 9;
    dv.setUint16(o, f.seq & 0xffff);
    dv.setInt8(o + 2, Math.round(num(f.mx, -1, 1) * 127)); dv.setInt8(o + 3, Math.round(num(f.mz, -1, 1) * 127));
    dv.setInt16(o + 4, Math.round(wrap(f.yaw) / Math.PI * 32767));
    dv.setInt8(o + 6, Math.round(num(f.pitch, -1.55, 1.55) / 1.56 * 127));
    out[o + 7] = f.buttons & 0xff; out[o + 8] = Math.round(num(f.hold, 0, 12.75) * 20);
  }
  return out;
}
export function decodeInputs(u8: Uint8Array): { ack: number; frames: InputFrame[] } | null {
  if (u8.length < 6 || u8[0] !== PKT_INPUT || u8[1] !== TRAIL_PROTO) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = Math.min(3, u8[4]);
  if (u8.length < 6 + n * 9) return null;
  const frames: InputFrame[] = [];
  for (let i = 0; i < n; i++) {
    const o = 6 + i * 9;
    frames.push({ seq: dv.getUint16(o), mx: dv.getInt8(o + 2) / 127, mz: dv.getInt8(o + 3) / 127, yaw: dv.getInt16(o + 4) / 32767 * Math.PI, pitch: dv.getInt8(o + 6) / 127 * 1.56, buttons: u8[o + 7], hold: u8[o + 8] / 20 });
  }
  return { ack: dv.getUint16(2), frames };
}
const wrap = (a: number) => { let x = a % (2 * Math.PI); if (x > Math.PI) x -= 2 * Math.PI; if (x < -Math.PI) x += 2 * Math.PI; return x; };

// ---------------------------------------------------------------- snapshots (host → guest, rt, 20 Hz)
export const F = { ragdoll: 1, held: 2, seated: 4, downed: 8, ghost: 16, gone: 32, water: 64, swept: 128 } as const;
export interface EntSnap {
  id: number; flags: number;
  p: [number, number, number]; q: [number, number, number, number];
  /** players: yaw, pitch, anim, speed (m/s), holding entity id (0 = none); animals: anim */
  yaw?: number; pitch?: number; anim?: number; speed?: number; hold?: number;
  /** players: the low 8 bits of the last input seq the host applied (client prediction + latency) */
  ack?: number;
}
export interface Snapshot { tick: number; ack: number; time: number; ents: EntSnap[];
  /** v2 journey: the floating origin (world metres, multiples of 64) the positions are relative to. */
  origin?: [number, number] }
/** Player / animal anim codes. */
export const ANIM = { idle: 0, walk: 1, run: 2, jump: 3, fall: 4, ragdoll: 5, sit: 6, swim: 7, carry: 8, dead: 9, attack: 10, flee: 11, push: 12, fly: 13,
  /** v2: on the driver bench; carrying something too heavy (straining, slow); pushing the wagon / a heavy thing; sprinting */
  drive: 14, strain: 15, sprint: 16 } as const;

const EXTRA = 1 << 15; // id high bit: an extended (player / animal) record follows

function packQuat(q: readonly number[]): number {
  let [x, y, z, w] = q;
  const n = Math.hypot(x, y, z, w) || 1; x /= n; y /= n; z /= n; w /= n;
  const a = [Math.abs(x), Math.abs(y), Math.abs(z), Math.abs(w)];
  let big = 0; for (let i = 1; i < 4; i++) if (a[i] > a[big]) big = i;
  const c = [x, y, z, w];
  const sgn = c[big] < 0 ? -1 : 1;
  const rest = c.filter((_, i) => i !== big).map((v) => v * sgn);
  const k = 511 / Math.SQRT1_2;
  const e = rest.map((v) => Math.max(0, Math.min(1023, Math.round(v * k + 511))));
  return ((big << 30) | (e[0] << 20) | (e[1] << 10) | e[2]) >>> 0;
}
function unpackQuat(u: number): [number, number, number, number] {
  const big = u >>> 30;
  const k = Math.SQRT1_2 / 511;
  const e = [((u >>> 20) & 1023) * k - Math.SQRT1_2, ((u >>> 10) & 1023) * k - Math.SQRT1_2, (u & 1023) * k - Math.SQRT1_2];
  const m = Math.sqrt(Math.max(0, 1 - e[0] * e[0] - e[1] * e[1] - e[2] * e[2]));
  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < 4; i++) out.push(i === big ? m : e[j++]);
  return out as [number, number, number, number];
}

/** Encode; entities that don't fit in MAX_RT are left out (the caller rotates them to later packets). Returns the
 *  packet and how many entities made it. Positions are metres relative to `origin` (±327 m, cm precision). */
export function encodeSnapshot(sn: Snapshot): { pkt: Uint8Array; n: number } {
  const buf = new Uint8Array(MAX_RT);
  const dv = new DataView(buf.buffer);
  buf[0] = PKT_SNAP; buf[1] = TRAIL_PROTO;
  dv.setUint32(2, sn.tick >>> 0); dv.setUint16(6, sn.ack & 0xffff); dv.setFloat64(8, sn.time);
  // 18..21: the origin in 64 m units (0x7fff,0x7fff = none)
  dv.setInt16(18, sn.origin ? Math.round(sn.origin[0] / 64) : 0x7fff); dv.setInt16(20, sn.origin ? Math.round(sn.origin[1] / 64) : 0x7fff);
  let o = 22, n = 0;
  for (const e of sn.ents) {
    const ext = e.yaw !== undefined || e.anim !== undefined;
    const need = 2 + 1 + 6 + 4 + (ext ? 8 : 0);
    if (o + need > MAX_RT) break;
    dv.setUint16(o, (e.id & 0x7fff) | (ext ? EXTRA : 0)); o += 2;
    buf[o++] = e.flags & 0xff;
    for (let i = 0; i < 3; i++) { dv.setInt16(o, Math.max(-32767, Math.min(32767, Math.round(e.p[i] * 100)))); o += 2; }
    dv.setUint32(o, packQuat(e.q)); o += 4;
    if (ext) {
      dv.setInt16(o, Math.round(wrap(e.yaw ?? 0) / Math.PI * 32767)); o += 2;
      dv.setInt8(o, Math.round(num(e.pitch ?? 0, -1.55, 1.55) / 1.56 * 127)); o += 1;
      buf[o++] = (e.anim ?? 0) & 0xff;
      buf[o++] = Math.round(num(e.speed ?? 0, 0, 25.5) * 10);
      dv.setUint16(o, (e.hold ?? 0) & 0xffff); o += 2;
      buf[o++] = (e.ack ?? 0) & 0xff;
    }
    n++;
  }
  dv.setUint16(16, n);
  return { pkt: buf.slice(0, o), n };
}
export function decodeSnapshot(u8: Uint8Array): Snapshot | null {
  if (u8.length < 22 || u8[0] !== PKT_SNAP || u8[1] !== TRAIL_PROTO) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tick = dv.getUint32(2), ack = dv.getUint16(6), time = dv.getFloat64(8), n = dv.getUint16(16);
  const ox = dv.getInt16(18), oz = dv.getInt16(20);
  const origin: [number, number] | undefined = ox === 0x7fff && oz === 0x7fff ? undefined : [ox * 64, oz * 64];
  const ents: EntSnap[] = [];
  let o = 22;
  for (let i = 0; i < n; i++) {
    if (o + 13 > u8.length) return null;
    const raw = dv.getUint16(o); o += 2;
    const ext = (raw & EXTRA) !== 0;
    const flags = u8[o++];
    const p: [number, number, number] = [dv.getInt16(o) / 100, dv.getInt16(o + 2) / 100, dv.getInt16(o + 4) / 100]; o += 6;
    const q = unpackQuat(dv.getUint32(o)); o += 4;
    const e: EntSnap = { id: raw & 0x7fff, flags, p, q };
    if (ext) {
      if (o + 8 > u8.length) return null;
      e.yaw = dv.getInt16(o) / 32767 * Math.PI; o += 2;
      e.pitch = dv.getInt8(o) / 127 * 1.56; o += 1;
      e.anim = u8[o++]; e.speed = u8[o++] / 10; e.hold = dv.getUint16(o); o += 2; e.ack = u8[o++];
    }
    ents.push(e);
  }
  return { tick, ack, time, ents, ...(origin ? { origin } : {}) };
}
