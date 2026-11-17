// Pro DJ Link (Pioneer / AlphaTheta CDJ, XDJ, DJM, rekordbox in export mode): packet parsers + the few packets we build.
// Pure functions over Buffers, written from the protocol analysis published by Deep Symmetry (djl-analysis /
// dysentery docs, crate-digger ANLZ docs: protocol facts, no code copied) and cross-checked against the MIT-licensed
// prolink-connect (Copyright (c) 2013 Evan Purkhiser) — see THIRD_PARTY_NOTICES.md. Tests: tools/djsync_unit.ts.
//
// LISTEN-ONLY. The only packets this file can build are: our keep-alive (a "virtual player" saying hello, opt-in, never
// a real player number) and dbserver metadata queries. It never builds beat, status, sync, master hand-off, fader-start,
// on-air or load packets: we can never become tempo master or move anything on the DJ's gear.

export const MAGIC = Buffer.from('5173707431576d4a4f4c', 'hex'); // "Qspt1WmJOL"
export const PORT_ANNOUNCE = 50000, PORT_BEAT = 50001, PORT_STATUS = 50002;
export const MIXER_ID = 0x21;
/** Our virtual player number: outside the real players' 1–6 (prolink-connect and beat-link use 7+). */
export const VIRTUAL_ID = 7;

export const PT = { keepAlive: 0x06, beat: 0x28, absPos: 0x0b, onAir: 0x03, cdjStatus: 0x0a, mixerStatus: 0x29 } as const;

const hasMagic = (b: Buffer) => b.length >= 0x0b && b.subarray(0, 10).equals(MAGIC);
/** Packet type byte (null = not a Pro DJ Link packet). */
export function packetType(b: Buffer): number | null { return hasMagic(b) ? b[0x0a] : null; }
const name = (b: Buffer, from: number, to: number) => b.toString('latin1', from, to).replace(/\0.*$/s, '').trim();

export interface KeepAlive { name: string; device: number; mac: string; ip: string; peers: number; kind: 'player' | 'mixer' | 'rekordbox' | 'other' }
/** Port 50000, type 0x06 (broadcast every 1.5–2 s by every device). */
export function parseKeepAlive(b: Buffer): KeepAlive | null {
  if (packetType(b) !== PT.keepAlive || b.length < 0x36) return null;
  const device = b[0x24];
  const nm = name(b, 0x0c, 0x20);
  const mac = [...b.subarray(0x26, 0x2c)].map((x) => x.toString(16).padStart(2, '0')).join(':');
  const ip = [...b.subarray(0x2c, 0x30)].join('.');
  const kind = device === MIXER_ID || /DJM/i.test(nm) ? 'mixer' : device >= 0x11 && device <= 0x2f || /rekordbox/i.test(nm) ? 'rekordbox' : device >= 1 && device <= 6 ? 'player' : 'other';
  return { name: nm, device, mac, ip, peers: b[0x30], kind };
}

export interface BeatPkt {
  name: string; device: number;
  /** ms to the next beat / bar (at 0 % pitch; null = the track ends first). */
  nextBeatMs: number | null; nextBarMs: number | null;
  /** Pitch in percent (0 = normal speed). */
  pitch: number;
  /** The track's BPM at 0 % pitch and the effective BPM heard. */
  trackBpm: number; bpm: number;
  /** Beat within the bar 1..4 of the beat that just started. */
  beatInBar: number;
}
const ms = (v: number) => (v === 0xffffffff ? null : v);
/** Pitch u32 (0x100000 = 0 %) → percent. */
export const pitchPct = (v: number) => (v - 0x100000) / 0x100000 * 100;
/** Port 50001, type 0x28: sent by a playing player the moment each beat starts (broadcast: heard passively). */
export function parseBeat(b: Buffer): BeatPkt | null {
  if (packetType(b) !== PT.beat || b.length < 0x60) return null;
  const pitch = pitchPct(b.readUInt32BE(0x54));
  const trackBpm = b.readUInt16BE(0x5a) / 100;
  const bib = b[0x5c];
  return {
    name: name(b, 0x0b, 0x1f), device: b[0x21], nextBeatMs: ms(b.readUInt32BE(0x24)), nextBarMs: ms(b.readUInt32BE(0x2c)),
    pitch, trackBpm, bpm: trackBpm * (1 + pitch / 100), beatInBar: bib >= 1 && bib <= 4 ? bib : 1,
  };
}

export interface AbsPos { device: number; lenSec: number; playheadMs: number; pitch: number; bpm: number | null }
/** Port 50001, type 0x0b (CDJ-3000 only, every 30 ms while a track is loaded — also when paused). */
export function parseAbsPos(b: Buffer): AbsPos | null {
  if (packetType(b) !== PT.absPos || b.length < 0x3c) return null;
  const raw = b.readUInt32BE(0x38);
  return { device: b[0x21], lenSec: b.readUInt32BE(0x24), playheadMs: b.readUInt32BE(0x28), pitch: b.readInt32BE(0x2c) / 100, bpm: raw === 0xffffffff ? null : raw / 10 };
}

/** Port 50001, type 0x03 from the DJM: which channels are on air (index 0 = channel 1). */
export function parseOnAir(b: Buffer): { device: number; onAir: boolean[] } | null {
  if (packetType(b) !== PT.onAir || b.length < 0x28) return null;
  const on = [b[0x24], b[0x25], b[0x26], b[0x27]].map((x) => x === 1);
  if (b[0x20] === 0x03 && b.length >= 0x2f) on.push(b[0x2d] === 1, b[0x2e] === 1);
  return { device: b[0x21], onAir: on };
}

export interface CdjStatus {
  device: number; name: string;
  /** Where the loaded track lives: player, slot (3 USB, 2 SD, 4 rekordbox collection…), type (1 = rekordbox analysed). */
  srcPlayer: number; slot: number; trackType: number; rekordboxId: number;
  playing: boolean; master: boolean; sync: boolean; onAir: boolean;
  /** Play mode byte (3 playing, 4 looping, 5 paused, 6 cued…). */
  mode: number;
  trackBpm: number | null; pitch: number; bpm: number | null;
  /** Track beat number (1-based; null = none) and beat within the bar. */
  beat: number | null; beatInBar: number;
}
/** Port 50002, type 0x0a: a player's full state (~5 Hz, ONLY to devices that announced themselves). */
export function parseCdjStatus(b: Buffer): CdjStatus | null {
  if (packetType(b) !== PT.cdjStatus || b.length < 0xc8) return null;
  const f = b[0x89];
  const rawBpm = b.readUInt16BE(0x92);
  const pitch = pitchPct(b.readUInt32BE(0x8c));
  const trackBpm = rawBpm === 0xffff ? null : rawBpm / 100;
  const beat = b.readUInt32BE(0xa0);
  const mode = b[0x7b];
  return {
    device: b[0x21], name: name(b, 0x0b, 0x1f), srcPlayer: b[0x28], slot: b[0x29], trackType: b[0x2a], rekordboxId: b.readUInt32BE(0x2c),
    playing: (f & 0x40) !== 0 && mode !== 0x05 && mode !== 0x06, master: (f & 0x20) !== 0, sync: (f & 0x10) !== 0, onAir: (f & 0x08) !== 0, mode,
    trackBpm, pitch, bpm: trackBpm === null ? null : trackBpm * (1 + pitch / 100),
    beat: beat === 0xffffffff ? null : beat, beatInBar: b[0xa6] >= 1 && b[0xa6] <= 4 ? b[0xa6] : 1,
  };
}

/** Port 50002, type 0x29: the mixer's state (is it the tempo master, its BPM). */
export function parseMixerStatus(b: Buffer): { device: number; master: boolean; bpm: number | null } | null {
  if (packetType(b) !== PT.mixerStatus || b.length < 0x38) return null;
  const raw = b.readUInt16BE(0x2e);
  return { device: b[0x21], master: b[0x27] === 0xf0, bpm: raw === 0xffff || raw === 0 ? null : raw / 100 };
}

/** Our keep-alive as a virtual player (opt-in "track names + drops" mode): 0x36 bytes, sent every 1.5 s, UNICAST to the
 *  devices we heard. Byte 0x35 = 0x64 (the CDJ-3000-compatible form: 0x00 there can knock CDJ-3000s set to 5/6 off). */
export function buildKeepAlive(o: { name: string; device: number; mac: number[]; ip: number[]; peers: number }): Buffer {
  const b = Buffer.alloc(0x36);
  MAGIC.copy(b, 0);
  b[0x0a] = PT.keepAlive;
  b.write(o.name.slice(0, 20), 0x0c, 'latin1');
  b[0x20] = 0x01; b[0x21] = 0x02;
  b.writeUInt16BE(0x36, 0x22);
  b[0x24] = o.device;
  b[0x25] = 0x01;                                   // never "first on the network"
  for (let i = 0; i < 6; i++) b[0x26 + i] = o.mac[i] ?? 0;
  for (let i = 0; i < 4; i++) b[0x2c + i] = o.ip[i] ?? 0;
  b[0x30] = Math.max(1, Math.min(255, o.peers));
  b[0x34] = 0x01;                                   // device type: player
  b[0x35] = 0x64;
  return b;
}

// ---------------------------------------------------------------- rekordbox phrase analysis (ANLZ PSSI)
export type PssiMood = 'high' | 'mid' | 'low';
export interface PssiPhrase { index: number; beat: number; kind: number; label: string; fill: number | null }
export interface Pssi { mood: PssiMood; endBeat: number; bank: number; phrases: PssiPhrase[] }
const PSSI_MASK = [0xcb, 0xe1, 0xee, 0xfa, 0xe5, 0xee, 0xad, 0xee, 0xe9, 0xd2, 0xe9, 0xeb, 0xe1, 0xe9, 0xf3, 0xe8, 0xe9, 0xf4, 0xe1];
const HIGH = ['', 'intro', 'up', 'down', '', 'chorus', 'outro'];
const MID = ['', 'intro', 'verse', 'verse', 'verse', 'verse', 'verse', 'verse', 'bridge', 'chorus', 'outro'];
const LOW = ['', 'intro', 'verse', 'verse', 'verse', 'verse', 'verse', 'verse', 'bridge', 'chorus', 'outro'];
/** rekordbox's phrase kind number → a label (by mood). */
export function phraseLabel(mood: PssiMood, kind: number): string {
  const t = mood === 'high' ? HIGH : mood === 'mid' ? MID : LOW;
  return t[kind] || 'verse';
}
/** Unmask a rekordbox 6+ PSSI tag in place (copy): every byte from 0x12 on is XORed with (mask[i % 19] + entries) & 0xff. */
export function unmaskPssi(tag: Buffer): Buffer {
  const out = Buffer.from(tag);
  const n = out.readUInt16BE(0x10);
  for (let i = 0; 0x12 + i < out.length; i++) out[0x12 + i] ^= (PSSI_MASK[i % 19] + n) & 0xff;
  return out;
}
/** Mask a PSSI tag (tests: the XOR is its own inverse). */
export const maskPssi = unmaskPssi;
/** Parse a PSSI tag (starting at its "PSSI" identifier). Masked (rekordbox 6+) tags are detected and unmasked. */
export function parsePssi(raw: Buffer): Pssi | null {
  if (raw.length < 0x20 || raw.toString('latin1', 0, 4) !== 'PSSI') return null;
  const lenTag = raw.readUInt32BE(0x08);
  let tag = raw.subarray(0, Math.min(raw.length, lenTag || raw.length));
  if (tag.readUInt16BE(0x12) > 20) tag = unmaskPssi(tag);
  const entryLen = tag.readUInt32BE(0x0c) || 0x18;
  const n = tag.readUInt16BE(0x10);
  const moodN = tag.readUInt16BE(0x12);
  const mood: PssiMood = moodN === 1 ? 'high' : moodN === 2 ? 'mid' : 'low';
  const phrases: PssiPhrase[] = [];
  for (let i = 0; i < n && n < 2000; i++) {
    const o = 0x20 + i * entryLen;
    if (o + 0x18 > tag.length) break;
    const kind = tag.readUInt16BE(o + 4);
    phrases.push({ index: tag.readUInt16BE(o), beat: tag.readUInt16BE(o + 2), kind, label: phraseLabel(mood, kind), fill: tag[o + 0x15] ? tag.readUInt16BE(o + 0x16) : null });
  }
  return { mood, endBeat: tag.readUInt16BE(0x1a), bank: tag[0x1e], phrases };
}
/** Build a PSSI tag (tests). */
export function buildPssi(mood: PssiMood, endBeat: number, phrases: { beat: number; kind: number }[], masked = false): Buffer {
  const b = Buffer.alloc(0x20 + phrases.length * 0x18);
  b.write('PSSI', 0, 'latin1');
  b.writeUInt32BE(0x20, 4); b.writeUInt32BE(b.length, 8); b.writeUInt32BE(0x18, 0x0c);
  b.writeUInt16BE(phrases.length, 0x10);
  b.writeUInt16BE(mood === 'high' ? 1 : mood === 'mid' ? 2 : 3, 0x12);
  b.writeUInt16BE(endBeat, 0x1a);
  phrases.forEach((p, i) => { const o = 0x20 + i * 0x18; b.writeUInt16BE(i + 1, o); b.writeUInt16BE(p.beat, o + 2); b.writeUInt16BE(p.kind, o + 4); b[o + 7] = 1; });
  return masked ? maskPssi(b) : b;
}

// ---------------------------------------------------------------- dbserver (TCP) messages: track title / artist + PSSI
export type DbField = { t: 'n1' | 'n2' | 'n4'; v: number } | { t: 'blob'; v: Buffer } | { t: 'str'; v: string };
export const DB_MAGIC = 0x872349ae;
export const n4 = (v: number): DbField => ({ t: 'n4', v: v >>> 0 });
export function encodeField(f: DbField): Buffer {
  switch (f.t) {
    case 'n1': return Buffer.from([0x0f, f.v & 0xff]);
    case 'n2': { const b = Buffer.alloc(3); b[0] = 0x10; b.writeUInt16BE(f.v & 0xffff, 1); return b; }
    case 'n4': { const b = Buffer.alloc(5); b[0] = 0x11; b.writeUInt32BE(f.v >>> 0, 1); return b; }
    case 'blob': { const b = Buffer.alloc(5); b[0] = 0x14; b.writeUInt32BE(f.v.length, 1); return Buffer.concat([b, f.v]); }
    case 'str': {
      const chars = f.v.length + 1;
      const b = Buffer.alloc(5 + chars * 2);
      b[0] = 0x26; b.writeUInt32BE(chars, 1);
      for (let i = 0; i < f.v.length; i++) b.writeUInt16BE(f.v.charCodeAt(i), 5 + i * 2);
      return b;
    }
  }
}
/** Read one field at off → [field, next offset] (null = not enough bytes yet). Throws on an unknown tag. */
export function readField(b: Buffer, off: number): [DbField, number] | null {
  if (off >= b.length) return null;
  const tag = b[off];
  const need = (n: number) => off + n <= b.length;
  switch (tag) {
    case 0x0f: return need(2) ? [{ t: 'n1', v: b[off + 1] }, off + 2] : null;
    case 0x10: return need(3) ? [{ t: 'n2', v: b.readUInt16BE(off + 1) }, off + 3] : null;
    case 0x11: return need(5) ? [{ t: 'n4', v: b.readUInt32BE(off + 1) }, off + 5] : null;
    case 0x14: { if (!need(5)) return null; const n = b.readUInt32BE(off + 1); if (n > 16 * 1024 * 1024) throw new Error('blob too big'); return need(5 + n) ? [{ t: 'blob', v: Buffer.from(b.subarray(off + 5, off + 5 + n)) }, off + 5 + n] : null; }
    case 0x26: {
      if (!need(5)) return null;
      const chars = b.readUInt32BE(off + 1);
      if (chars > 65536) throw new Error('string too long');
      if (!need(5 + chars * 2)) return null;
      let s = '';
      for (let i = 0; i < chars; i++) { const c = b.readUInt16BE(off + 5 + i * 2); if (c === 0) break; s += String.fromCharCode(c); }
      return [{ t: 'str', v: s }, off + 5 + chars * 2];
    }
    default: throw new Error(`unknown dbserver field tag 0x${tag.toString(16)}`);
  }
}
export interface DbMessage { tx: number; type: number; args: DbField[] }
const ARG_TAG: Record<DbField['t'], number> = { n1: 0x06, n2: 0x06, n4: 0x06, str: 0x02, blob: 0x03 };
export function encodeMessage(m: DbMessage): Buffer {
  const tags = Buffer.alloc(12);
  m.args.slice(0, 12).forEach((a, i) => { tags[i] = ARG_TAG[a.t]; });
  const parts = [encodeField(n4(DB_MAGIC)), encodeField(n4(m.tx)), encodeField({ t: 'n2', v: m.type }), encodeField({ t: 'n1', v: m.args.length }), encodeField({ t: 'blob', v: tags })];
  // (a zero-length blob that follows a zero length number is left out, like the players do)
  m.args.forEach((a, i) => { if (a.t === 'blob' && a.v.length === 0 && i > 0) { const p = m.args[i - 1]; if (p.t === 'n4' && p.v === 0) return; } parts.push(encodeField(a)); });
  return Buffer.concat(parts);
}
/** Parse one message from the front of a stream buffer → [message, bytes used] (null = incomplete). */
export function readMessage(b: Buffer): [DbMessage, number] | null {
  let r = readField(b, 0); if (!r) return null;
  if (r[0].t !== 'n4' || r[0].v !== DB_MAGIC) throw new Error('lost dbserver framing');
  let off = r[1];
  r = readField(b, off); if (!r) return null; const tx = (r[0] as { v: number }).v; off = r[1];
  r = readField(b, off); if (!r) return null; const type = (r[0] as { v: number }).v; off = r[1];
  r = readField(b, off); if (!r) return null; const argc = (r[0] as { v: number }).v; off = r[1];
  r = readField(b, off); if (!r) return null; const tags = (r[0] as { v: Buffer }).v; off = r[1];
  const args: DbField[] = [];
  for (let i = 0; i < argc; i++) {
    // a blob argument after a zero length is omitted on the wire
    if (tags[i] === 0x03 && i > 0) { const p = args[i - 1]; if (p && p.t === 'n4' && p.v === 0) { args.push({ t: 'blob', v: Buffer.alloc(0) }); continue; } }
    r = readField(b, off); if (!r) return null;
    args.push(r[0]); off = r[1];
  }
  return [{ tx, type, args }, off];
}
/** The "DMST" argument: our device byte, menu 1, the slot, the track type. */
export const dmst = (device: number, slot: number, trackType: number) => n4(((device & 0xff) << 24) | (0x01 << 16) | ((slot & 0xff) << 8) | (trackType & 0xff));
export const DB = { setup: 0x0000, metadata: 0x2002, render: 0x3000, anlzTag: 0x2c04, menuAvail: 0x4000, menuHeader: 0x4001, menuItem: 0x4101, menuFooter: 0x4201, anlzReply: 0x4f02, error: 0x4003 } as const;
/** 4-byte ASCII tag reversed into a u32 ("PSSI" → 0x49535350 read as little-endian bytes "ISSP"), like the players expect. */
export const fourcc = (s: string) => ((s.charCodeAt(3) << 24) | (s.charCodeAt(2) << 16) | (s.charCodeAt(1) << 8) | s.charCodeAt(0)) >>> 0;
export const PSSI_TAG = fourcc('PSSI'), EXT_TAG = (('T'.charCodeAt(0) << 16) | ('X'.charCodeAt(0) << 8) | 'E'.charCodeAt(0)) >>> 0;
/** Menu item types we read. */
export const ITEM = { title: 0x04, artist: 0x07, duration: 0x0b, tempo: 0x0d, key: 0x0f } as const;
