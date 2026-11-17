// Getting PCM for our own analysis, in memory only (decoded audio is never written anywhere):
//  - WAV and AIFF / AIFC: read in the analysis WORKER (never on the helper's main thread), streamed from the file in
//    1 MB blocks and resampled as it goes, only as much as the analysis uses (the first 20 minutes, like ffmpeg -t 1200);
//  - everything else (MP3, FLAC, AAC / M4A, OGG …): a user-installed ffmpeg when there is one (never bundled), run at
//    low priority and killed when it stalls (no output for 30 s) or runs too long; otherwise the studio page decodes it
//    with the browser's own decoders (src/ui/djTrackPanel.ts) while the studio is open and the user isn't live.
// Output: mono Float32 at 22 050 Hz (what the analysis and the optional beat finder expect).
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ANALYSIS_SR = 22050;
/** The analysis reads at most this much of a track (a DJ track is shorter; a 2-hour mix is cut, not loaded whole). */
export const MAX_ANALYSIS_SECONDS = 1200;
export interface Pcm { pcm: Float32Array; sr: number }
/** Where the samples are in a WAV / AIFF file and how they're stored. */
interface PcmLayout { sr: number; ch: number; bits: number; float: boolean; le: boolean; u8: boolean; dataOff: number; dataLen: number }
type ReadAt = (off: number, len: number) => Buffer;

function wavLayout(read: ReadAt, size: number): PcmLayout | null {
  const head = read(0, 12);
  if (head.length < 12 || head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') return null;
  let o = 12, fmt: { tag: number; ch: number; sr: number; bits: number } | null = null, dataOff = -1, dataLen = 0;
  for (let guard = 0; o + 8 <= size && guard < 4096; guard++) {
    const h = read(o, 8); if (h.length < 8) break;
    const id = h.toString('latin1', 0, 4), len = h.readUInt32LE(4);
    if (id === 'fmt ') {
      const body = read(o + 8, Math.min(len, 40));
      if (body.length >= 16) {
        let tag = body.readUInt16LE(0);
        if (tag === 0xfffe && body.length >= 26) tag = body.readUInt16LE(24);
        fmt = { tag, ch: body.readUInt16LE(2), sr: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
      }
    } else if (id === 'data') { dataOff = o + 8; dataLen = Math.max(0, Math.min(len, size - dataOff)); if (fmt) break; }
    o += 8 + len + (len & 1);
  }
  if (!fmt || dataOff < 0 || !(fmt.ch >= 1 && fmt.ch <= 64) || !(fmt.sr >= 4000 && fmt.sr <= 768000)) return null;
  const float = fmt.tag === 3;
  if (fmt.tag !== 1 && !float) return null;
  if (float ? fmt.bits !== 32 && fmt.bits !== 64 : ![8, 16, 24, 32].includes(fmt.bits)) return null;
  return { sr: fmt.sr, ch: fmt.ch, bits: fmt.bits, float, le: true, u8: fmt.bits === 8, dataOff, dataLen };
}
/** An 80-bit IEEE extended float (AIFF sample rate). */
function ext80(b: Buffer, o: number): number {
  const e = b.readUInt16BE(o) & 0x7fff, hi = b.readUInt32BE(o + 2), lo = b.readUInt32BE(o + 6);
  return (hi * 2 ** 32 + lo) * 2 ** (e - 16383 - 63) * (b[o] & 0x80 ? -1 : 1);
}
function aiffLayout(read: ReadAt, size: number): PcmLayout | null {
  const head = read(0, 12);
  if (head.length < 12 || head.toString('latin1', 0, 4) !== 'FORM') return null;
  const form = head.toString('latin1', 8, 12);
  if (form !== 'AIFF' && form !== 'AIFC') return null;
  let o = 12, ch = 0, bits = 0, sr = 0, comp = 'NONE', dataOff = -1, dataLen = 0;
  for (let guard = 0; o + 8 <= size && guard < 4096; guard++) {
    const h = read(o, 8); if (h.length < 8) break;
    const id = h.toString('latin1', 0, 4), len = h.readUInt32BE(4);
    if (id === 'COMM') { const body = read(o + 8, Math.min(len, 64)); if (body.length >= 18) { ch = body.readUInt16BE(0); bits = body.readUInt16BE(6); sr = ext80(body, 8); if (form === 'AIFC' && body.length >= 22) comp = body.toString('latin1', 18, 22); } }
    else if (id === 'SSND') { const sh = read(o + 8, 8); if (sh.length === 8) { dataOff = o + 16 + sh.readUInt32BE(0); dataLen = Math.max(0, Math.min(len - 8 - sh.readUInt32BE(0), size - dataOff)); } }
    o += 8 + len + (len & 1);
  }
  if (dataOff < 0 || !(ch >= 1 && ch <= 64) || !(sr >= 4000 && sr <= 768000)) return null;
  const fl = comp === 'fl32' || comp === 'FL32';
  if (fl ? bits !== 32 : ![8, 16, 24, 32].includes(bits)) return null;
  if (comp !== 'NONE' && comp !== 'sowt' && !fl) return null;
  return { sr, ch, bits, float: fl, le: comp === 'sowt', u8: false, dataOff, dataLen };
}
/** One sample at byte p as −1..1. */
function sampleFn(L: PcmLayout): (b: Buffer, p: number) => number {
  if (L.float) return L.bits === 64 ? (L.le ? (b, p) => b.readDoubleLE(p) : (b, p) => b.readDoubleBE(p)) : (L.le ? (b, p) => b.readFloatLE(p) : (b, p) => b.readFloatBE(p));
  switch (L.bits) {
    case 8: return L.u8 ? (b, p) => (b[p] - 128) / 128 : (b, p) => b.readInt8(p) / 128;
    case 16: return L.le ? (b, p) => b.readInt16LE(p) / 32768 : (b, p) => b.readInt16BE(p) / 32768;
    case 24: return L.le ? (b, p) => b.readIntLE(p, 3) / 8388608 : (b, p) => b.readIntBE(p, 3) / 8388608;
    default: return L.le ? (b, p) => b.readInt32LE(p) / 2147483648 : (b, p) => b.readInt32BE(p) / 2147483648;
  }
}
/** Interleaved frames → mono. */
function toMono(L: PcmLayout, b: Buffer, frames: number, out: Float32Array) {
  const smp = sampleFn(L), bps = L.bits / 8, frame = bps * L.ch;
  for (let i = 0; i < frames; i++) { let s = 0; for (let c = 0; c < L.ch; c++) s += smp(b, i * frame + c * bps); out[i] = s / L.ch; }
}
const bufReader = (b: Buffer): ReadAt => (off, len) => b.subarray(Math.min(off, b.length), Math.min(b.length, off + len));
function decodeBuffer(b: Buffer, L: PcmLayout | null): Pcm | null {
  if (!L) return null;
  const frame = L.bits / 8 * L.ch, n = Math.floor(L.dataLen / frame), out = new Float32Array(n);
  toMono(L, b.subarray(L.dataOff, L.dataOff + n * frame), n, out);
  return { pcm: out, sr: L.sr };
}
/** A WAV file in memory (PCM 8/16/24/32-bit, float 32/64, WAVE_FORMAT_EXTENSIBLE) → mono. */
export function decodeWav(b: Buffer): Pcm | null { return decodeBuffer(b, wavLayout(bufReader(b), b.length)); }
/** AIFF / AIFC (NONE / sowt / fl32) in memory → mono. */
export function decodeAiff(b: Buffer): Pcm | null { return decodeBuffer(b, aiffLayout(bufReader(b), b.length)); }

/** Resampling as the samples arrive (box-filtered when going down, then linear): exactly `resample` on the whole. */
export class StreamResampler {
  readonly out: Float32Array;
  private i = 0; private readonly ratio: number; private readonly w: number;
  private buf = new Float32Array(1 << 16); private base = 0; private len = 0;
  constructor(sr: number, totalIn: number, to = ANALYSIS_SR) { this.ratio = sr / to; this.w = Math.max(1, Math.round(this.ratio)); this.out = new Float32Array(Math.floor(totalIn / this.ratio)); }
  private at(j: number) { const k = j - this.base; return k >= 0 && k < this.len ? this.buf[k] : 0; }
  push(x: Float32Array) {
    if (this.len + x.length > this.buf.length) { const nb = new Float32Array(Math.max(this.buf.length * 2, this.len + x.length)); nb.set(this.buf.subarray(0, this.len)); this.buf = nb; }
    this.buf.set(x, this.len); this.len += x.length;
    this.run(false);
  }
  finish(): Float32Array { this.run(true); return this.out; }
  private run(final: boolean) {
    const { ratio, w, out } = this, end = this.base + this.len;
    while (this.i < out.length) {
      const x = this.i * ratio, k = Math.floor(x);
      if (!final && (w > 1 ? k + w : k + 2) > end) break;
      if (w > 1) { let s = 0; for (let j = 0; j < w; j++) s += this.at(k + j); out[this.i] = s / w; }
      else { const f = x - k; out[this.i] = this.at(k) * (1 - f) + this.at(k + 1) * f; }
      this.i++;
    }
    const drop = Math.min(this.len, Math.floor(this.i * ratio) - this.base);
    if (drop > 0) { this.buf.copyWithin(0, drop, this.len); this.len -= drop; this.base += drop; }
  }
}
/** Resample mono PCM (box-filtered when going down, then linear). */
export function resample(p: Pcm, to = ANALYSIS_SR): Float32Array {
  if (p.sr === to) return p.pcm;
  const r = new StreamResampler(p.sr, p.pcm.length, to);
  r.push(p.pcm);
  return r.finish();
}
/** A WAV / AIFF file → mono 22 050 Hz, streamed: only the header and the first `maxSeconds` of samples are read (1 MB at
 *  a time; memory = the output). null = not a format read here (ffmpeg or the studio page then). */
export function decodePcmFile(file: string | number, maxSeconds = MAX_ANALYSIS_SECONDS): Float32Array | null {
  // (a number = a handle the caller opened, checked and closes)
  const fd = typeof file === 'number' ? file : fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const read: ReadAt = (off, len) => { const b = Buffer.alloc(Math.max(0, Math.min(len, size - off))); if (b.length) fs.readSync(fd, b, 0, b.length, off); return b; };
    const head = read(0, 4).toString('latin1');
    const L = head === 'RIFF' ? wavLayout(read, size) : head === 'FORM' ? aiffLayout(read, size) : null;
    if (!L) return null;
    const frame = L.bits / 8 * L.ch;
    const frames = Math.min(Math.floor(L.dataLen / frame), Math.floor(maxSeconds * L.sr));
    const rs = new StreamResampler(L.sr, frames);
    const per = Math.max(1, Math.floor((1 << 20) / frame)), buf = Buffer.alloc(per * frame), mono = new Float32Array(per);
    for (let f = 0; f < frames; f += per) {
      const nf = Math.min(per, frames - f);
      const got = fs.readSync(fd, buf, 0, nf * frame, L.dataOff + f * frame), nn = Math.floor(got / frame);
      toMono(L, buf, nn, mono);
      rs.push(mono.subarray(0, nn));
      if (nn < nf) break;
    }
    return rs.finish();
  } finally { if (typeof file !== 'number') fs.closeSync(fd); }
}
/** Read here (in the worker) rather than by ffmpeg / the studio page. */
export const PCM_FILE = /\.(wav|aif|aiff|aifc)$/i;

const ffSeen = new Map<string, { at: number; v: string | null }>();
const ffAsking = new Map<string, Promise<string | null>>();
/** The user's ffmpeg (VTube Pro never ships one): the configured path, PATH, or the usual install folders. Asked
 *  asynchronously and remembered for 5 minutes (the analyser asks every step: never a blocking `where` call). */
export async function findFfmpeg(configured = ''): Promise<string | null> {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const cands = [configured, process.env.VTP_FFMPEG ?? ''].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  if (process.env.VTP_FFMPEG === 'none') return null;
  const seen = ffSeen.get(configured);
  if (seen && Date.now() - seen.at < 5 * 60000) return seen.v;
  // (one lookup at a time: callers meanwhile share it)
  const asking = ffAsking.get(configured);
  if (asking) return asking;
  const p = lookFfmpeg(configured, exe).finally(() => ffAsking.delete(configured));
  ffAsking.set(configured, p);
  return p;
}
async function lookFfmpeg(configured: string, exe: string): Promise<string | null> {
  const out = await new Promise<string>((res) => execFile(process.platform === 'win32' ? 'where' : 'which', [exe], { encoding: 'utf8', windowsHide: true, timeout: 3000 }, (_e, stdout) => res(String(stdout ?? ''))));
  const line = out.split(/\r?\n/).find((l) => l.trim());
  let v: string | null = line && fs.existsSync(line.trim()) ? line.trim() : null;
  if (!v) for (const c of process.platform === 'win32' ? [path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', exe), 'C:\\ffmpeg\\bin\\ffmpeg.exe'] : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) if (fs.existsSync(c)) { v = c; break; }
  ffSeen.set(configured, { at: Date.now(), v });
  return v;
}
export interface ProcLimits {
  /** stop reading after this many bytes (the process is killed) */
  maxBytes: number;
  /** killed when it prints nothing for this long (ms) */
  idleMs: number;
  /** killed when it runs longer than this (ms) */
  hardMs: number;
}
/** Run a decoder process at low priority and collect its float32 stdout, killing it when it stalls or runs too long. */
export function readPcmProcess(cmd: string, args: string[], lim: ProcLimits): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try { if (c.pid) os.setPriority(c.pid, os.constants.priority.PRIORITY_LOW); } catch { /* not allowed */ }
    const chunks: Buffer[] = []; let n = 0, err = '', why = '', settled = false;
    const kill = (reason: string) => { if (!why) why = reason; try { c.kill('SIGKILL'); } catch { /* gone */ } };
    let idle = setTimeout(() => kill('the decoder stalled'), lim.idleMs);
    const hard = setTimeout(() => kill('decoding took too long'), lim.hardMs);
    const finish = (f: () => void) => { if (settled) return; settled = true; clearTimeout(idle); clearTimeout(hard); f(); };
    c.stdout.on('data', (d: Buffer) => {
      clearTimeout(idle); idle = setTimeout(() => kill('the decoder stalled'), lim.idleMs);
      if (n >= lim.maxBytes) return;
      chunks.push(d); n += d.length;
      if (n >= lim.maxBytes) kill('');
    });
    c.stderr.on('data', (d: Buffer) => { if (err.length < 2000) err += d.toString(); });
    c.on('error', (e) => finish(() => reject(e)));
    c.on('close', (code) => finish(() => {
      if (why) { reject(new Error(why)); return; }
      if (code !== 0 && !n) { reject(new Error(err.trim().split(/\r?\n/).pop() || `the decoder exited ${code}`)); return; }
      const b = Buffer.concat(chunks).subarray(0, Math.min(n, lim.maxBytes));
      resolve(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)).slice());
    }));
  });
}
/** Decode with ffmpeg: mono 22 050 Hz float on stdout (nothing written to disk), the first `maxSeconds` only. */
export function decodeWithFfmpeg(ffmpeg: string, file: string, o: Partial<ProcLimits> & { maxSeconds?: number } = {}): Promise<Float32Array> {
  const maxSeconds = o.maxSeconds ?? MAX_ANALYSIS_SECONDS;
  return readPcmProcess(ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-t', String(maxSeconds), '-vn', '-ac', '1', '-ar', String(ANALYSIS_SR), '-f', 'f32le', 'pipe:1'],
    { maxBytes: o.maxBytes ?? maxSeconds * ANALYSIS_SR * 4, idleMs: o.idleMs ?? 30000, hardMs: o.hardMs ?? 10 * 60000 });
}
export class NeedsDecoder extends Error { constructor(readonly file: string) { super('needs a decoder'); } }
