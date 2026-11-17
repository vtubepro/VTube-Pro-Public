// Party avatar transfers with a receipt — the "resolver" (docs/MULTIPLAYER_DISCORD.md → "Avatar transfers").
//
// Why: a model used to be streamed as raw chunks + an end marker and nobody ever confirmed it arrived. Any hiccup
// (a chunk processed before the sender's hello, a half transfer left over from a reconnect, a vault that refused
// the size, a relay that hung on a closed channel) ended in "waiting for avatar" forever while the owner's panel
// said "sharing". Now (both peers advertise the 'xf1' capability):
//
//   'bin' channel (reliable, ordered):   X begin {x, k, n, h, c, o}  →  D data (u32 x, u32 offset, bytes)…  →  E end {x}
//   (h = CRC-32 of the whole file, 8 hex digits: the receiver computes it chunk by chunk as the bytes arrive — no extra
//    pass, no 250 MB copy; DTLS already authenticates every packet, this catches OUR bugs: lost / doubled / stale chunks)
//   'ctl' channel (JSON), receiver → sender:
//        {t:'xprog', owner, k, x, got}                       progress (≤ 1/s): the sender sees it is moving
//        {t:'xack',  owner, k, x, ok:true}                   checked (size + CRC-32 + GLB + polycount), sealed, shown
//        {t:'xack',  owner, k, x, ok:false, why, retry, got} the exact failure; `retry` = worth sending again
//        {t:'xneed', owner, k, have?:{h, got}}               "I don't have it — (re)send it" (resume from `got`)
//   host → owner: {t:'xstat', owner, to:[{name, st, why, got, n}]}  where the owner's avatar got to
//
// The sender resumes from the receiver's `got` (same checksum) or starts over, with backoff (2, 4, 8, 16, 30 s; 5
// tries). A receiver that sees "sharing" but no model after XF_MISSING_MS asks for it (xneed) — the host for its
// guests, guests for everyone via the host. Old clients (no 'xf1') still get / send the legacy format; their state
// shows "their app is outdated". Pure TS (browser + Node tests: tools/mpfix_unit.ts).

export const XF_CAP = 'xf1';
/** Largest avatar model / costume a party carries (custom VRMs with 4K textures are often 70–150 MB). The studio's RAM
 *  vault (server/partyVault.ts) takes this plus the seal's overhead — the two used to disagree (256 MB vs 72 MB). */
export const PARTY_MAX_MODEL = 256 * 1024 * 1024;
/** Packet types on the 'bin' channel (byte 32, after the 32-byte owner id). Legacy: 'm' 'c' data, 'M' 'C' end. */
export const XF_BEGIN = 0x58, XF_DATA = 0x44, XF_END = 0x45; // 'X' 'D' 'E'
export const XF_HEAD = 33;
export const XF_DATA_HEAD = 41;
export const XF_CHUNK = 16 * 1024;
/** Automatic tries per transfer (and per "missing model" request round). */
export const XF_TRIES = 5;
const BACKOFF = [2000, 4000, 8000, 16000, 30000];
export const xfBackoff = (tries: number) => BACKOFF[Math.max(0, Math.min(BACKOFF.length - 1, tries - 1))];
/** No progress for this long (while sending / receiving) = stalled → resume / resend. */
export const XF_STALL_MS = 20_000;
/** A member says they share, the link is up, yet no model and nothing arriving after this long → ask for it. */
export const XF_MISSING_MS = 25_000;
/** A finished model that arrived before the owner's "sharing" message is held this long for it (then wiped). */
export const XF_LATE_MS = 10_000;

export type XfKind = 'm' | 'c';
export interface XfBegin { x: number; k: XfKind; n: number; h: string; c: string; o: number }
/** Reasons that sending again can't fix (the receiver said no for a rule, not for a glitch). */
export const xfFinal = (why: string) => /^(tris:|glb:|big:|policy:|off$|gone$|none$|load$)/.test(why);

const te = new TextEncoder(), td = new TextDecoder();
const SUM = /^[0-9a-f]{8}$/;

function head(owner: string, type: number, extra: number): Uint8Array {
  const u = new Uint8Array(XF_HEAD + extra);
  u.set(te.encode(owner.padEnd(32, ' ').slice(0, 32)), 0);
  u[32] = type;
  return u;
}
function withJson(owner: string, type: number, o: unknown): Uint8Array {
  const j = te.encode(JSON.stringify(o));
  const u = head(owner, type, j.length);
  u.set(j, XF_HEAD);
  return u;
}
export const encBegin = (owner: string, b: XfBegin) => withJson(owner, XF_BEGIN, b);
export const encEnd = (owner: string, x: number) => withJson(owner, XF_END, { x });
export function encData(owner: string, x: number, off: number, part: Uint8Array): Uint8Array {
  const u = head(owner, XF_DATA, 8 + part.length);
  const dv = new DataView(u.buffer);
  dv.setUint32(XF_HEAD, x >>> 0, true);
  dv.setUint32(XF_HEAD + 4, off >>> 0, true);
  u.set(part, XF_DATA_HEAD);
  return u;
}
/** The owner id + packet type of any 'bin' packet (legacy or xf1). */
export function binHeader(u8: Uint8Array): { owner: string; type: number } | null {
  if (u8.byteLength < XF_HEAD) return null;
  return { owner: td.decode(u8.subarray(0, 32)).trim(), type: u8[32] };
}
export function decBegin(u8: Uint8Array, maxBytes: number): XfBegin | null {
  try {
    const o = JSON.parse(td.decode(u8.subarray(XF_HEAD, XF_HEAD + 512))) as Record<string, unknown>;
    const x = Number(o.x), n = Number(o.n), off = Number(o.o ?? 0);
    const k = o.k === 'c' ? 'c' : o.k === 'm' ? 'm' : null;
    const h = String(o.h ?? '');
    const c = typeof o.c === 'string' && /^[A-Za-z0-9_-]{0,40}$/.test(o.c) ? o.c : '';
    if (!k || !Number.isInteger(x) || x < 0 || x > 0xffffffff || !Number.isInteger(n) || n < 28 || n > maxBytes || !SUM.test(h)
      || !Number.isInteger(off) || off < 0 || off >= n) return null;
    return { x, k, n, h, c, o: off };
  } catch { return null; }
}
export function decEnd(u8: Uint8Array): number | null {
  try { const x = Number((JSON.parse(td.decode(u8.subarray(XF_HEAD, XF_HEAD + 64))) as { x?: unknown }).x); return Number.isInteger(x) ? x : null; } catch { return null; }
}
export function decData(u8: Uint8Array): { x: number; off: number; data: Uint8Array } | null {
  if (u8.byteLength < XF_DATA_HEAD) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return { x: dv.getUint32(XF_HEAD, true), off: dv.getUint32(XF_HEAD + 4, true), data: u8.subarray(XF_DATA_HEAD) };
}
export const newXferId = () => (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0) || 1;

// ---------------------------------------------------------------- costume sets (cap 'acc1')
// Owner 2026-10-02: "i do need for avatars that are guests to transmit their accessories and costumes as well".
// Between 'acc1' peers the worn outfit AND the worn accessories travel as ONE 'c' transfer — a costume set — so they
// arrive together (one checksum, one resume, one OBS reload) and an accessory switch supersedes the old set the way an
// outfit switch does. Older apps keep getting the plain outfit GLB they understand. Layout (little endian):
//   'VTPS' · version 1 (u8) · piece count 1–16 (u8) · 0 (u16)
//   per piece: id length (u8) · id (ASCII [A-Za-z0-9_-], ≤ 40) · kind (u8: 0 outfit, 1 accessory) · byte length (u32)
//   then the pieces' bytes in that order. At most one outfit, ids unique, lengths add up exactly; every piece is a GLB
//   the receiver checks like a model (glbProblem). The 'c' transfer's costume id is the set's id ('s-' + its CRC-32).
export const ACC_CAP = 'acc1';
export const SET_MAX_PIECES = 16;
export interface SetPiece { id: string; kind: 'outfit' | 'accessory'; bytes: Uint8Array }
const SET_MAGIC = 0x53505456;   // 'VTPS'
const PIECE_ID = /^[A-Za-z0-9_-]{1,40}$/;
export const isCostumeSet = (b: Uint8Array) => b.byteLength >= 8 && b[0] === 0x56 && b[1] === 0x54 && b[2] === 0x50 && b[3] === 0x53;
export function packSet(pieces: SetPiece[]): Uint8Array {
  if (!pieces.length || pieces.length > SET_MAX_PIECES) throw new Error(`a costume set holds 1–${SET_MAX_PIECES} pieces`);
  if (pieces.filter((p) => p.kind === 'outfit').length > 1 || new Set(pieces.map((p) => p.id)).size !== pieces.length) throw new Error('one outfit at most, unique ids');
  const ids = pieces.map((p) => { if (!PIECE_ID.test(p.id)) throw new Error(`bad piece id ${p.id}`); return te.encode(p.id); });
  const head = 8 + ids.reduce((s, id) => s + 1 + id.length + 1 + 4, 0);
  const out = new Uint8Array(head + pieces.reduce((s, p) => s + p.bytes.byteLength, 0));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, SET_MAGIC, true); out[4] = 1; out[5] = pieces.length;
  let o = 8;
  pieces.forEach((p, i) => { out[o++] = ids[i].length; out.set(ids[i], o); o += ids[i].length; out[o++] = p.kind === 'outfit' ? 0 : 1; dv.setUint32(o, p.bytes.byteLength, true); o += 4; });
  for (const p of pieces) { out.set(p.bytes, o); o += p.bytes.byteLength; }
  return out;
}
/** A costume set's pieces (views into `b`, nothing copied), or why it is refused. */
export function unpackSet(b: Uint8Array): SetPiece[] | string {
  if (!isCostumeSet(b)) return 'not a costume set';
  if (b[4] !== 1) return 'a costume set from a newer app';
  const n = b[5], dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (n < 1 || n > SET_MAX_PIECES) return 'bad costume set';
  const meta: { id: string; kind: SetPiece['kind']; len: number }[] = [];
  let o = 8;
  for (let i = 0; i < n; i++) {
    if (o >= b.byteLength) return 'bad costume set';
    const l = b[o++];
    if (o + l + 5 > b.byteLength) return 'bad costume set';
    const id = td.decode(b.subarray(o, o + l)); o += l;
    const k = b[o++], len = dv.getUint32(o, true); o += 4;
    if (!PIECE_ID.test(id) || (k !== 0 && k !== 1) || meta.some((m) => m.id === id)) return 'bad costume set';
    meta.push({ id, kind: k === 0 ? 'outfit' : 'accessory', len });
  }
  if (meta.filter((m) => m.kind === 'outfit').length > 1 || o + meta.reduce((s, m) => s + m.len, 0) !== b.byteLength) return 'bad costume set';
  return meta.map((m) => { const p = { id: m.id, kind: m.kind, bytes: b.subarray(o, o + m.len) }; o += m.len; return p; });
}

// ---------------------------------------------------------------- CRC-32 (IEEE, slicing-by-4: ~0.5–1 GB/s in V8)
const CRC = (() => {
  const t = new Uint32Array(1024);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  for (let n = 0; n < 256; n++) for (let s = 1; s < 4; s++) t[s * 256 + n] = (t[(s - 1) * 256 + n] >>> 8) ^ t[t[(s - 1) * 256 + n] & 255];
  return t;
})();
/** Continue a CRC-32 over more bytes (start with 0). */
export function crc32(b: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0, i = 0;
  const n = b.length, n4 = n - (n % 4);
  for (; i < n4; i += 4) {
    c ^= b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
    c = CRC[768 + (c & 255)] ^ CRC[512 + ((c >>> 8) & 255)] ^ CRC[256 + ((c >>> 16) & 255)] ^ CRC[c >>> 24];
  }
  for (; i < n; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}
export const sumHex = (crc: number) => (crc >>> 0).toString(16).padStart(8, '0');
/** The checksum of a whole buffer without blocking the studio: 4 MB at a time, yielding in between. */
export async function checksum(b: Uint8Array): Promise<string> {
  let c = 0;
  for (let o = 0; o < b.length; o += 4 << 20) {
    c = crc32(b.subarray(o, Math.min(b.length, o + (4 << 20))), c);
    if (o + (4 << 20) < b.length) await new Promise((r) => setTimeout(r, 0));
  }
  return sumHex(c);
}

// ---------------------------------------------------------------- states + words people read
export type XfState = 'idle' | 'queued' | 'sending' | 'sent' | 'receiving' | 'checking' | 'waiting' | 'retrying' | 'done' | 'failed' | 'outdated';
/** One transfer as the Multiplayer panel shows it. */
export interface XfView { st: XfState; kind: XfKind; got: number; n: number; why: string; tries: number; at: number }

export const fmtMB = (b: number) => (b >= 10 * 1048576 ? `${Math.round(b / 1048576)} MB` : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(0, Math.round(b / 1024))} kB`);
const kTris = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** A reason code (xack why / member why) in plain words. `limit` = the party's triangle limit. */
export function xfWhyText(why: string, limit: number): string {
  if (!why) return '';
  if (why.startsWith('tris:')) { const n = Number(why.slice(5)); const t = n < 5000 ? n * 1000 : n; return `${kTris(t)} triangles > ${kTris(limit)} limit`; }
  if (why.startsWith('glb:')) return `not a usable model (${why.slice(4)})`;
  if (why.startsWith('big:')) return `${why.slice(4)} MB — over the 256 MB limit`;
  if (why.startsWith('vault:')) return `this PC couldn’t hold it in memory (${why.slice(6)})`;
  if (why.startsWith('policy:')) return why === 'policy:host' ? 'they share it with the host only' : 'they share it with verified server members only';
  switch (why) {
    case 'hash': return 'arrived damaged (checksum mismatch)';
    case 'size': return 'arrived incomplete';
    case 'gap': return 'pieces went missing on the way';
    case 'resume': return 'couldn’t resume — starting over';
    case 'nomem': return 'not enough memory to receive it';
    case 'off': return 'sharing is switched off';
    case 'none': return 'their avatar hasn’t loaded yet';
    case 'load': return 'their avatar file couldn’t be read';
    case 'pending': return 'the host is still receiving it';
    case 'queued': return 'queued behind another avatar';
    case 'gone': return 'they left';
    case 'stalled': return 'stalled (no progress)';
    case 'closed': return 'the connection closed mid-transfer';
    case 'missing': return 'never arrived';
    case 'outdated': return 'their app is outdated — ask them to update VTube Pro';
    case 'late': return 'arrived before they said they share it';
    default: return why;
  }
}

/** One status line: "receiving 42 MB / 118 MB", "stalled — retrying (2/5)", "rejected: 214k triangles > 200k limit". */
export function xfLine(v: XfView | null, limit: number, dir: 'in' | 'out'): string {
  if (!v || v.st === 'idle') return '';
  const pr = v.n ? `${fmtMB(v.got)} / ${fmtMB(v.n)}` : fmtMB(v.got);
  const what = v.kind === 'c' ? 'costume' : 'avatar';
  switch (v.st) {
    case 'queued': return `${what} queued${v.why ? ` (${xfWhyText(v.why, limit)})` : ''}`;
    case 'sending': return `sending ${what} ${pr}`;
    case 'sent': return `${what} sent ${fmtMB(v.n)} — waiting for the receipt`;
    case 'receiving': return `receiving ${what} ${pr}`;
    case 'checking': return `checking ${what} (${fmtMB(v.n)})`;
    case 'waiting': return v.why ? `waiting — ${xfWhyText(v.why, limit)}` : `waiting for the ${what}`;
    case 'retrying': return `${v.why ? `${xfWhyText(v.why, limit)} — ` : 'stalled — '}retrying (${Math.min(v.tries, XF_TRIES)}/${XF_TRIES})`;
    case 'done': return dir === 'out' ? `${what} delivered ✔` : `${what} received ✔`;
    case 'outdated': return 'their app is outdated — ask them to update VTube Pro';
    case 'failed': return `${dir === 'out' ? 'rejected' : 'failed'}: ${xfWhyText(v.why, limit) || 'unknown error'}`;
  }
  return '';
}
