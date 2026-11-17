// StageLinQ (Denon DJ / Engine OS players and mixers: SC6000, SC5000, Prime 4 / 2 / Go, SC Live, X1800 / X1850…) wire
// format: pure encoders / decoders. A clean port of the protocol as implemented by icedream/go-stagelinq (MIT,
// Copyright (c) 2021 Carl Kittelberger — THIRD_PARTY_NOTICES.md) with protocol notes from PyStageLinQ (MIT).
// We deliberately do NOT use chrisle/StageLinq: its history descends from GPL-3.0 code relabelled MIT.
// Everything is big-endian. A "network string" is a u32 BYTE length + UTF-16BE text. Tests: tools/djsync_unit.ts.

export const DISCOVERY_PORT = 51337;
export const ACTION_HOWDY = 'DISCOVERER_HOWDY_', ACTION_EXIT = 'DISCOVERER_EXIT_';

export function netStr(s: string): Buffer {
  const b = Buffer.alloc(4 + s.length * 2);
  b.writeUInt32BE(s.length * 2, 0);
  for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), 4 + i * 2);
  return b;
}
/** Read a network string at off → [text, next] (null = incomplete). */
export function readNetStr(b: Buffer, off: number): [string, number] | null {
  if (off + 4 > b.length) return null;
  const n = b.readUInt32BE(off);
  if (n > 1 << 20 || n % 2) throw new Error('bad StageLinQ string');
  if (off + 4 + n > b.length) return null;
  let s = '';
  for (let i = 0; i < n; i += 2) s += String.fromCharCode(b.readUInt16BE(off + 4 + i));
  return [s, off + 4 + n];
}

/** A fresh token: 16 random bytes with the top bit clear (devices ignore requests from tokens with it set). */
export function newToken(rand: (n: number) => Buffer): Buffer { const t = rand(16); t[0] &= 0x7f; return t; }

export interface Discovery { token: Buffer; source: string; action: string; software: string; version: string; port: number }
export function buildDiscovery(d: Discovery): Buffer {
  return Buffer.concat([Buffer.from('airD', 'latin1'), d.token, netStr(d.source), netStr(d.action), netStr(d.software), netStr(d.version), Buffer.from([d.port >> 8, d.port & 0xff])]);
}
export function parseDiscovery(b: Buffer): Discovery | null {
  try {
    if (b.length < 4 + 16 + 4 * 4 + 2 || b.toString('latin1', 0, 4) !== 'airD') return null;
    const token = Buffer.from(b.subarray(4, 20));
    let r = readNetStr(b, 20); if (!r) return null; const source = r[0];
    r = readNetStr(b, r[1]); if (!r) return null; const action = r[0];
    r = readNetStr(b, r[1]); if (!r) return null; const software = r[0];
    r = readNetStr(b, r[1]); if (!r) return null; const version = r[0];
    if (r[1] + 2 > b.length) return null;
    return { token, source, action, software, version, port: b.readUInt16BE(r[1]) };
  } catch { return null; }
}

// ---------------------------------------------------------------- main connection (unframed, back to back)
export type MainMsg =
  | { id: 0; token: Buffer; service: string; port: number }        // a service the device offers
  | { id: 1; token: Buffer; token2: Buffer; ref: bigint }          // reference / timestamp
  | { id: 2; token: Buffer };                                       // services request
export function buildServicesRequest(token: Buffer): Buffer { const h = Buffer.alloc(4); h.writeUInt32BE(2, 0); return Buffer.concat([h, token]); }
export function buildReference(token: Buffer, token2: Buffer, ref = 0n): Buffer {
  const h = Buffer.alloc(4); h.writeUInt32BE(1, 0);
  const r = Buffer.alloc(8); r.writeBigInt64BE(ref, 0);
  return Buffer.concat([h, token, token2.length === 16 ? token2 : Buffer.alloc(16), r]);
}
export function buildServiceAnnounce(token: Buffer, service: string, port: number): Buffer {
  const h = Buffer.alloc(4); h.writeUInt32BE(0, 0);
  return Buffer.concat([h, token, netStr(service), Buffer.from([port >> 8, port & 0xff])]);
}
/** Parse main-connection messages from the front of a stream buffer → [messages, bytes used]. */
export function readMainMessages(b: Buffer): [MainMsg[], number] {
  const out: MainMsg[] = [];
  let off = 0;
  for (;;) {
    if (off + 4 > b.length) break;
    const id = b.readUInt32BE(off);
    if (id === 2) { if (off + 20 > b.length) break; out.push({ id: 2, token: Buffer.from(b.subarray(off + 4, off + 20)) }); off += 20; continue; }
    if (id === 1) { if (off + 44 > b.length) break; out.push({ id: 1, token: Buffer.from(b.subarray(off + 4, off + 20)), token2: Buffer.from(b.subarray(off + 20, off + 36)), ref: b.readBigInt64BE(off + 36) }); off += 44; continue; }
    if (id === 0) {
      if (off + 20 > b.length) break;
      const r = readNetStr(b, off + 20); if (!r) break;
      if (r[1] + 2 > b.length) break;
      out.push({ id: 0, token: Buffer.from(b.subarray(off + 4, off + 20)), service: r[0], port: b.readUInt16BE(r[1]) });
      off = r[1] + 2; continue;
    }
    throw new Error(`unknown StageLinQ main message 0x${id.toString(16)}`);
  }
  return [out, off];
}

// ---------------------------------------------------------------- service connections (framed: u32 length + payload)
/** Frame a payload. */
export const frame = (p: Buffer) => { const h = Buffer.alloc(4); h.writeUInt32BE(p.length, 0); return Buffer.concat([h, p]); };
/** Split framed messages → [payloads, bytes used]. */
export function readFrames(b: Buffer, max = 1 << 20): [Buffer[], number] {
  const out: Buffer[] = [];
  let off = 0;
  while (off + 4 <= b.length) {
    const n = b.readUInt32BE(off);
    if (n > max) throw new Error('StageLinQ frame too big');
    if (off + 4 + n > b.length) break;
    out.push(Buffer.from(b.subarray(off + 4, off + 4 + n)));
    off += 4 + n;
  }
  return [out, off];
}

const SMAA = Buffer.from('smaa', 'latin1');
export function buildStateSubscribe(path: string, intervalMs = 0): Buffer {
  const id = Buffer.alloc(4); id.writeUInt32BE(0x7d2, 0);
  const iv = Buffer.alloc(4); iv.writeUInt32BE(intervalMs, 0);
  return frame(Buffer.concat([SMAA, id, netStr(path), iv]));
}
export function buildStateValue(path: string, json: string): Buffer {
  const id = Buffer.alloc(4); id.writeUInt32BE(0, 0);
  return frame(Buffer.concat([SMAA, id, netStr(path), netStr(json)]));
}
/** A StateMap payload → { path, value } for value messages (null for acks / others). Values: {"value":n} | {"state":b} | {"string":s}. */
export function parseStateValue(p: Buffer): { path: string; value: number | boolean | string | null } | null {
  if (p.length < 12 || !p.subarray(0, 4).equals(SMAA) || p.readUInt32BE(4) !== 0) return null;
  const r = readNetStr(p, 8); if (!r) return null;
  const j = readNetStr(p, r[1]); if (!j) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(j[0]) as Record<string, unknown>; } catch { return { path: r[0], value: null }; }
  const v = typeof o.value === 'number' ? o.value : typeof o.state === 'boolean' ? o.state : typeof o.string === 'string' ? o.string.slice(0, 200) : null;
  return { path: r[0], value: v };
}

export const BEATINFO_START = frame(Buffer.from([0, 0, 0, 0]));
export interface BeatDeck { beat: number; totalBeats: number; bpm: number; timeline: number }
export function parseBeatInfo(p: Buffer): { clock: bigint; decks: BeatDeck[] } | null {
  if (p.length < 16 || p.readUInt32BE(0) !== 2) return null;
  const clock = p.readBigUInt64BE(4);
  const n = p.readUInt32BE(12);
  if (n > 8 || p.length < 16 + n * 24 + n * 8) return null;
  const decks: BeatDeck[] = [];
  for (let i = 0; i < n; i++) {
    const o = 16 + i * 24;
    decks.push({ beat: p.readDoubleBE(o), totalBeats: p.readDoubleBE(o + 8), bpm: p.readDoubleBE(o + 16), timeline: p.readDoubleBE(16 + n * 24 + i * 8) });
  }
  return { clock, decks };
}
export function buildBeatInfo(clock: bigint, decks: BeatDeck[]): Buffer {
  const p = Buffer.alloc(16 + decks.length * 32);
  p.writeUInt32BE(2, 0); p.writeBigUInt64BE(clock, 4); p.writeUInt32BE(decks.length, 12);
  decks.forEach((d, i) => { const o = 16 + i * 24; p.writeDoubleBE(d.beat, o); p.writeDoubleBE(d.totalBeats, o + 8); p.writeDoubleBE(d.bpm, o + 16); p.writeDoubleBE(d.timeline, 16 + decks.length * 24 + i * 8); });
  return frame(p);
}

/** The StateMap paths we read (N = deck 1..4). */
export function statePaths(decks = 4): string[] {
  const out = ['/Mixer/CrossfaderPosition', '/Engine/Master/MasterTempo', '/Engine/DeckCount'];
  for (let n = 1; n <= decks; n++) {
    out.push(`/Engine/Deck${n}/Track/SongName`, `/Engine/Deck${n}/Track/ArtistName`, `/Engine/Deck${n}/Track/CurrentBPM`, `/Engine/Deck${n}/Track/SongLoaded`,
      `/Engine/Deck${n}/Track/TrackNetworkPath`, `/Engine/Deck${n}/PlayState`, `/Engine/Deck${n}/Play`, `/Engine/Deck${n}/DeckIsMaster`, `/Engine/Deck${n}/CurrentBPM`, `/Mixer/CH${n}faderPosition`);
  }
  return out;
}
