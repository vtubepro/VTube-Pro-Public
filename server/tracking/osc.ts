// Minimal dependency-free OSC 1.0 codec — just what the VMC protocol needs.
// Spec: https://opensoundcontrol.stanford.edu/spec-1_0.html
//   - strings are NUL-terminated and padded to a multiple of 4 bytes
//   - type tag string starts with ','; i = int32 BE, f = float32 BE, s = string, b = blob
//   - "#bundle\0" + 8-byte timetag + [int32 size + element]* (elements are messages or bundles)
// The parser is bounds-checked everywhere and throws OscError on malformed input (callers catch per packet).

export type OscArg = string | number | boolean | null | Uint8Array;
export interface OscMessage { address: string; args: OscArg[] }

export class OscError extends Error {}

const MAX_DEPTH = 4;
const MAX_ARGS = 64;
const MAX_MESSAGES = 1024;

function readString(buf: Buffer, off: number): [string, number] {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  if (end >= buf.length) throw new OscError('unterminated string');
  const s = buf.toString('utf8', off, end);
  const next = (end + 4) & ~3; // include the NUL, pad to 4
  if (next > buf.length) throw new OscError('string padding past end');
  return [s, next];
}

function parseMessage(buf: Buffer, out: OscMessage[]) {
  const [address, o1] = readString(buf, 0);
  if (!address.startsWith('/')) throw new OscError('bad address');
  let off = o1;
  const args: OscArg[] = [];
  if (off >= buf.length) { out.push({ address, args }); return; } // no type tags (old-style) → no args
  const [tags, o2] = readString(buf, off);
  off = o2;
  if (!tags.startsWith(',')) throw new OscError('bad type tags');
  if (tags.length - 1 > MAX_ARGS) throw new OscError('too many args');
  for (let i = 1; i < tags.length; i++) {
    const t = tags[i];
    switch (t) {
      case 'i':
        if (off + 4 > buf.length) throw new OscError('int past end');
        args.push(buf.readInt32BE(off)); off += 4; break;
      case 'f':
        if (off + 4 > buf.length) throw new OscError('float past end');
        args.push(buf.readFloatBE(off)); off += 4; break;
      case 'd':
        if (off + 8 > buf.length) throw new OscError('double past end');
        args.push(buf.readDoubleBE(off)); off += 8; break;
      case 'h':
        if (off + 8 > buf.length) throw new OscError('int64 past end');
        args.push(Number(buf.readBigInt64BE(off))); off += 8; break;
      case 's': case 'S': {
        const [s, o] = readString(buf, off);
        args.push(s); off = o; break;
      }
      case 'b': {
        if (off + 4 > buf.length) throw new OscError('blob size past end');
        const n = buf.readInt32BE(off); off += 4;
        if (n < 0 || off + n > buf.length) throw new OscError('blob past end');
        args.push(new Uint8Array(buf.subarray(off, off + n)));
        off = (off + n + 3) & ~3;
        break;
      }
      case 'T': args.push(true); break;
      case 'F': args.push(false); break;
      case 'N': args.push(null); break;
      case 'I': args.push(null); break;
      default: throw new OscError(`unsupported type tag '${t}'`);
    }
  }
  out.push({ address, args });
}

function parseElement(buf: Buffer, out: OscMessage[], depth: number) {
  if (out.length > MAX_MESSAGES) throw new OscError('too many messages');
  if (buf.length >= 8 && buf.toString('latin1', 0, 8) === '#bundle\0') {
    if (depth >= MAX_DEPTH) throw new OscError('bundle nesting too deep');
    let off = 16; // "#bundle\0" + timetag
    if (off > buf.length) throw new OscError('bundle header past end');
    while (off < buf.length) {
      if (off + 4 > buf.length) throw new OscError('element size past end');
      const n = buf.readInt32BE(off); off += 4;
      if (n <= 0 || n % 4 !== 0 || off + n > buf.length) throw new OscError('bad element size');
      parseElement(buf.subarray(off, off + n), out, depth + 1);
      off += n;
    }
    return;
  }
  parseMessage(buf, out);
}

/** Parse one UDP datagram (message or bundle) into a flat list of messages. Throws OscError. */
export function parseOsc(buf: Buffer): OscMessage[] {
  const out: OscMessage[] = [];
  parseElement(buf, out, 0);
  return out;
}

// ---------------------------------------------------------------- encoder

export type OscTyped = { t: 's'; v: string } | { t: 'f'; v: number } | { t: 'i'; v: number };
export const S = (v: string): OscTyped => ({ t: 's', v });
export const F = (v: number): OscTyped => ({ t: 'f', v: Number.isFinite(v) ? v : 0 });
export const I = (v: number): OscTyped => ({ t: 'i', v: Number.isFinite(v) ? Math.trunc(v) : 0 });

function strBytes(s: string): Buffer {
  const raw = Buffer.from(s, 'utf8');
  const out = Buffer.alloc((raw.length + 4) & ~3);
  raw.copy(out);
  return out;
}

export function encodeMessage(address: string, args: OscTyped[] = []): Buffer {
  const parts: Buffer[] = [strBytes(address), strBytes(',' + args.map((a) => a.t).join(''))];
  for (const a of args) {
    if (a.t === 's') parts.push(strBytes(a.v));
    else {
      const b = Buffer.alloc(4);
      if (a.t === 'f') b.writeFloatBE(a.v); else b.writeInt32BE(a.v | 0);
      parts.push(b);
    }
  }
  return Buffer.concat(parts);
}

/** Bundle with the "immediately" timetag (0x0000000000000001). */
export function encodeBundle(elements: Buffer[]): Buffer {
  const head = Buffer.alloc(16);
  head.write('#bundle\0', 0, 'latin1');
  head.writeUInt32BE(0, 8);
  head.writeUInt32BE(1, 12);
  const parts: Buffer[] = [head];
  for (const e of elements) {
    const n = Buffer.alloc(4);
    n.writeInt32BE(e.length);
    parts.push(n, e);
  }
  return Buffer.concat(parts);
}
