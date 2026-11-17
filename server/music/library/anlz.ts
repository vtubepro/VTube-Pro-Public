// rekordbox analysis files (ANLZnnnn.DAT / .EXT / .2EX): the beat grid (PQTZ), cues (PCOB / PCO2), the audio file's
// path (PPTH), waveforms (PWV4 colour preview, PWV6 3-band preview, PWV7 3-band detail) and the phrase analysis (PSSI,
// XOR-masked from rekordbox 6 on with a fixed public pattern: prolinkPackets.ts unmasks it). The same files sit on
// rekordbox USB sticks and, unencrypted, in rekordbox's own folder on the DJ's PC (…\PIONEER\USBANLZ).
// Written from Deep Symmetry's published format analysis (djl-analysis: "Analysis Files"), no code copied; checked
// against rekordcrate's published demo export at test time (tools/djtrack_unit.ts). READ-ONLY: we never write these.
// (buildAnlz exists for the tests' synthetic files.)
import { parsePssi, type Pssi } from '../prolinkPackets.ts';

export interface AnlzBeat { bib: number; bpm: number; ms: number }
export interface AnlzCue { hot: number; kind: 'point' | 'loop'; ms: number; endMs?: number; memory: boolean; color?: string; name?: string }
export interface Anlz {
  path?: string;
  beats?: AnlzBeat[];
  cues: AnlzCue[];
  pssi?: Pssi | null;
  /** 3-band overview (PWV6: [mid, high, low] per column → stored as [low, mid, high]); colour preview heights (PWV4). */
  bands?: { cols: number; data: Uint8Array };
  /** 3-band detail columns (PWV7, 150 a second). */
  detail?: { perSec: number; cols: number; data: Uint8Array };
  tags: string[];
}
const MAX_FILE = 32 << 20;

/** Parse one ANLZ file (any of the three). Unknown tags are skipped; a broken one ends the walk.
 *  `phrases: false` leaves the masked phrase tag (PSSI) unread (the "Read rekordbox phrase analysis" setting). */
export function parseAnlz(b: Buffer, opt: { phrases?: boolean } = {}): Anlz | null {
  if (b.length < 28 || b.toString('latin1', 0, 4) !== 'PMAI' || b.length > MAX_FILE) return null;
  const out: Anlz = { cues: [], tags: [] };
  let o = b.readUInt32BE(4);
  while (o + 12 <= b.length) {
    const tag = b.toString('latin1', o, o + 4);
    const lh = b.readUInt32BE(o + 4), lt = b.readUInt32BE(o + 8);
    if (lt < 12 || lh < 12 || lh > lt || o + lt > b.length) break;
    const t = b.subarray(o, o + lt);
    out.tags.push(tag);
    try {
      switch (tag) {
        case 'PPTH': { const n = t.readUInt32BE(12); out.path = utf16be(t.subarray(lh, Math.min(lt, lh + n))).replace(/\0+$/, ''); break; }
        case 'PQTZ': {
          const n = t.readUInt32BE(20), beats: AnlzBeat[] = [];
          for (let i = 0; i < n && lh + i * 8 + 8 <= lt; i++) { const e = lh + i * 8; beats.push({ bib: t.readUInt16BE(e), bpm: t.readUInt16BE(e + 2) / 100, ms: t.readUInt32BE(e + 4) }); }
          out.beats = beats;
          break;
        }
        case 'PCOB': readCues(t, lh, false, out.cues); break;
        case 'PCO2': readCues(t, lh, true, out.cues); break;
        case 'PSSI': if (opt.phrases !== false) out.pssi = parsePssi(Buffer.from(t)); break;
        case 'PWV6': {
          const per = t.readUInt32BE(12), n = t.readUInt32BE(16);
          if (per === 3 && lh + n * 3 <= lt) { const d = new Uint8Array(n * 3); for (let i = 0; i < n; i++) { const e = lh + i * 3; d[i * 3] = t[e + 2]; d[i * 3 + 1] = t[e]; d[i * 3 + 2] = t[e + 1]; } out.bands = { cols: n, data: d }; }
          break;
        }
        case 'PWV7': {
          const per = t.readUInt32BE(12), n = t.readUInt32BE(16), rate = t.readUInt16BE(20);
          if (per === 3 && lh + n * 3 <= lt) { const d = new Uint8Array(n * 3); for (let i = 0; i < n; i++) { const e = lh + i * 3; d[i * 3] = t[e + 2]; d[i * 3 + 1] = t[e]; d[i * 3 + 2] = t[e + 1]; } out.detail = { perSec: rate || 150, cols: n, data: d }; }
          break;
        }
        case 'PWV4': {
          // colour preview: 1200 columns × 6 bytes; without a 3-band tag, use its height bytes as one band
          if (!out.bands) {
            const per = t.readUInt32BE(12), n = t.readUInt32BE(16);
            if (per === 6 && lh + n * 6 <= lt) { const d = new Uint8Array(n * 3); for (let i = 0; i < n; i++) { const e = lh + i * 6; const h = Math.min(255, Math.max(t[e + 3], t[e + 4], t[e + 5]) * 2); d[i * 3] = h; d[i * 3 + 1] = h; d[i * 3 + 2] = h; } out.bands = { cols: n, data: d }; }
          }
          break;
        }
      }
    } catch { /* a malformed tag: skip it */ }
    o += lt;
  }
  return out;
}
/** Loose tags (as a CDJ's dbserver returns them, each from its four-letter id on) → one parsed analysis. */
export function anlzFromTags(tags: Buffer[], o: { phrases?: boolean } = {}): Anlz | null {
  const ok = tags.filter((t) => t.length >= 12 && t.readUInt32BE(8) <= t.length);
  if (!ok.length) return null;
  const body = Buffer.concat(ok.map((t) => t.subarray(0, t.readUInt32BE(8))));
  const head = Buffer.alloc(28); head.write('PMAI', 0, 'latin1'); head.writeUInt32BE(28, 4); head.writeUInt32BE(28 + body.length, 8);
  return parseAnlz(Buffer.concat([head, body]), o);
}
function readCues(t: Buffer, lh: number, v2: boolean, out: AnlzCue[]) {
  const type = t.readUInt32BE(12);              // 0 = memory points, 1 = hot cues
  const n = v2 ? t.readUInt16BE(16) : t.readUInt16BE(18);
  let e = lh;
  for (let i = 0; i < n && e + 12 <= t.length; i++) {
    const id = t.toString('latin1', e, e + 4), elh = t.readUInt32BE(e + 4), elt = t.readUInt32BE(e + 8);
    if (elt < 12 || e + elt > t.length) break;
    const c = t.subarray(e, e + elt);
    if (id === 'PCPT' && elt >= 0x28) {
      const hot = c.readUInt32BE(0x0c), kind = c[0x1c] === 2 ? 'loop' : 'point', ms = c.readUInt32BE(0x20), loop = c.readUInt32BE(0x24);
      // (rekordbox 6+ lists some entries twice: in PCOB and PCO2; the merger dedupes)
      out.push({ hot, kind, ms, ...(kind === 'loop' && loop !== 0xffffffff ? { endMs: loop } : {}), memory: type === 0 || hot === 0 });
    } else if (id === 'PCP2' && elt >= 0x1c) {
      const hot = c.readUInt32BE(0x0c), kind = c[0x10] === 2 ? 'loop' : 'point', ms = c.readUInt32BE(0x14), loop = c.readUInt32BE(0x18);
      const cue: AnlzCue = { hot, kind, ms, ...(kind === 'loop' && loop !== 0xffffffff ? { endMs: loop } : {}), memory: type === 0 || hot === 0 };
      // comment (UTF-16BE) + its colour, when the entry carries them
      if (elt >= 0x4c) {
        const clen = c.readUInt32BE(0x48);
        if (clen > 0 && 0x4c + clen <= elt) cue.name = utf16be(c.subarray(0x4c, 0x4c + clen)).replace(/\0+$/, '').slice(0, 80);
        const co = 0x4c + clen;
        if (co + 4 <= elt && c[co] !== 0) cue.color = `#${[c[co + 1], c[co + 2], c[co + 3]].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
      }
      out.push(cue);
    }
    void elh;
    e += elt;
  }
}
function utf16be(b: Buffer): string { let s = ''; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i)); return s; }

// ---------------------------------------------------------------------------------------------------- tests: writers
function tag(id: string, header: Buffer, body: Buffer): Buffer {
  const h = Buffer.alloc(12); h.write(id, 0, 'latin1'); h.writeUInt32BE(12 + header.length, 4); h.writeUInt32BE(12 + header.length + body.length, 8);
  return Buffer.concat([h, header, body]);
}
export interface AnlzSpec { path?: string; beats?: AnlzBeat[]; cues?: AnlzCue[]; pssi?: Buffer; bands?: Uint8Array /* [low, mid, high] × cols */; v2cues?: boolean;
  /** 3-band detail (PWV7): [low, mid, high] × cols at 150 columns a second */ detail?: Uint8Array }
/** Build a synthetic ANLZ file (tests only). */
export function buildAnlz(s: AnlzSpec): Buffer {
  const tags: Buffer[] = [];
  if (s.path !== undefined) {
    const p = Buffer.alloc((s.path.length + 1) * 2); for (let i = 0; i < s.path.length; i++) p.writeUInt16BE(s.path.charCodeAt(i), i * 2);
    const h = Buffer.alloc(4); h.writeUInt32BE(p.length, 0); tags.push(tag('PPTH', h, p));
  }
  if (s.beats) {
    const h = Buffer.alloc(12); h.writeUInt32BE(0x80000, 4); h.writeUInt32BE(s.beats.length, 8);
    const d = Buffer.alloc(s.beats.length * 8); s.beats.forEach((x, i) => { d.writeUInt16BE(x.bib, i * 8); d.writeUInt16BE(Math.round(x.bpm * 100), i * 8 + 2); d.writeUInt32BE(Math.round(x.ms), i * 8 + 4); });
    tags.push(tag('PQTZ', h, d));
  }
  if (s.cues?.length) {
    for (const memory of [true, false]) {
      const list = s.cues.filter((c) => c.memory === memory);
      const ents = list.map((c) => {
        if (s.v2cues) { const e = Buffer.alloc(0x1c); e.write('PCP2', 0, 'latin1'); e.writeUInt32BE(0x10, 4); e.writeUInt32BE(0x1c, 8); e.writeUInt32BE(c.hot, 0x0c); e[0x10] = c.kind === 'loop' ? 2 : 1; e.writeUInt32BE(c.ms, 0x14); e.writeUInt32BE(c.endMs ?? 0xffffffff, 0x18); return e; }
        const e = Buffer.alloc(0x38); e.write('PCPT', 0, 'latin1'); e.writeUInt32BE(0x1c, 4); e.writeUInt32BE(0x38, 8); e.writeUInt32BE(c.hot, 0x0c); e.writeUInt32BE(4, 0x10); e.writeUInt32BE(0x10000, 0x14);
        e[0x1c] = c.kind === 'loop' ? 2 : 1; e.writeUInt16BE(0x3e8, 0x1e); e.writeUInt32BE(c.ms, 0x20); e.writeUInt32BE(c.endMs ?? 0xffffffff, 0x24); return e;
      });
      const h = Buffer.alloc(s.v2cues ? 8 : 12); h.writeUInt32BE(memory ? 0 : 1, 0);
      if (s.v2cues) h.writeUInt16BE(list.length, 4); else { h.writeUInt16BE(list.length, 6); h.writeUInt32BE(0xffffffff, 8); }
      tags.push(tag(s.v2cues ? 'PCO2' : 'PCOB', h, Buffer.concat(ents)));
    }
  }
  if (s.bands) {
    const n = s.bands.length / 3, h = Buffer.alloc(8); h.writeUInt32BE(3, 0); h.writeUInt32BE(n, 4);
    const d = Buffer.alloc(n * 3); for (let i = 0; i < n; i++) { d[i * 3] = s.bands[i * 3 + 1]; d[i * 3 + 1] = s.bands[i * 3 + 2]; d[i * 3 + 2] = s.bands[i * 3]; }
    tags.push(tag('PWV6', h, d));
  }
  if (s.detail) {
    const n = s.detail.length / 3, h = Buffer.alloc(12); h.writeUInt32BE(3, 0); h.writeUInt32BE(n, 4); h.writeUInt16BE(150, 8);
    const d = Buffer.alloc(n * 3); for (let i = 0; i < n; i++) { d[i * 3] = s.detail[i * 3 + 1]; d[i * 3 + 1] = s.detail[i * 3 + 2]; d[i * 3 + 2] = s.detail[i * 3]; }
    tags.push(tag('PWV7', h, d));
  }
  if (s.pssi) tags.push(s.pssi);
  const body = Buffer.concat(tags);
  const head = Buffer.alloc(28); head.write('PMAI', 0, 'latin1'); head.writeUInt32BE(28, 4); head.writeUInt32BE(28 + body.length, 8);
  return Buffer.concat([head, body]);
}
