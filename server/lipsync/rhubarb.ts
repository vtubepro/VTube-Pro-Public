// Offline lip sync for audio files: Rhubarb Lip Sync (Daniel S. Wolf, MIT; PocketSphinx + CMU dictionary / acoustic model, BSD-style,
// see docs/licenses/rhubarb_LICENSE.md and THIRD_PARTY_NOTICES.md) turns a WAV (or OGG) of a spoken line into mouth-shape cues
// (A–H, X); shared/lipBus.ts maps those onto our visemes. Used where the app plays PREPARED audio of speech (the AI game
// master's server-rendered voice lines, server/routes/ttrpg.ts): the mouth follows the real sounds instead of a text guess.
//
// It runs the vendored CLI headless: no audio output, no window, no network. Nothing from a line's text ever reaches a command
// line: the words go to a temp file (Rhubarb's --dialogFile makes it far more accurate on TTS), the arguments are a fixed array.
// Windows only (the vendored build). Default mode `phonetic` (language-independent, about 0.1x real time: a 6 s line in 0.7 s on the dev PC);
// VTP_RHUBARB_MODE=pocketSphinx = the English recogniser (+ the words as --dialogFile), about 1x real time (a 6 s line: 6-9 s), a little
// closer to the hand labels (docs/VOICE.md) but too slow to wait for.
// Not installed / not Windows / it fails or times out: callers get null and keep the text-driven mouth (src/ttrpg/gm/speech.ts).
//
// Where it looks (first that has rhubarb.exe + res/sphinx): VTP_RHUBARB, <repo>/tools/vendor/rhubarb/<unpacked folder>, else the vendored
// zip is unpacked once into <temp>/vtp_rhubarb/<version>/ (only rhubarb.exe, res/ and LICENSE.md, by our own small zip reader).
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from '../paths.ts';
import { RHUBARB_SHAPES, RHUBARB_VISEME, type RhubarbShape, type Viseme } from '../../shared/lipBus.ts';

export const RHUBARB_VERSION = '1.14.0';
const VENDOR = path.join(ROOT, 'tools', 'vendor', 'rhubarb');
const ZIP_NAME = `Rhubarb-Lip-Sync-${RHUBARB_VERSION}-Windows.zip`;
const ZIP_ROOT = `Rhubarb-Lip-Sync-${RHUBARB_VERSION}-Windows/`;
/** the parts of the release we use (the Spine / After Effects extras and the test wavs stay in the zip) */
const WANTED = (n: string) => n === `${ZIP_ROOT}rhubarb.exe` || n === `${ZIP_ROOT}LICENSE.md` || n.startsWith(`${ZIP_ROOT}res/`);
const MAX_WAV = 60 * 1024 * 1024;
const TIMEOUT_MS = 12_000;

export interface RhubarbCue { start: number; end: number; value: RhubarbShape }
export interface VisemeSeg { t0: number; t1: number; v: Viseme }
export interface RhubarbResult { cues: RhubarbCue[]; segs: VisemeSeg[]; dur: number; ms: number; mode: 'pocketSphinx' | 'phonetic' }

// ---------------------------------------------------------------- pure: cues → our visemes
/** The single viseme a Rhubarb shape stands for (the heaviest of RHUBARB_VISEME's mix). */
export function shapeViseme(s: RhubarbShape): Viseme {
  const m = RHUBARB_VISEME[s];
  let best: Viseme = 'sil', bv = -1;
  for (const [k, w] of Object.entries(m) as [Viseme, number][]) if (w > bv) { bv = w; best = k; }
  return best;
}
/** Rhubarb's JSON (`mouthCues`) → clean cues (known shapes, finite increasing times, clamped to the audio length when known). */
export function parseCues(json: unknown, dur = Infinity): RhubarbCue[] {
  const raw = (json as { mouthCues?: unknown })?.mouthCues;
  if (!Array.isArray(raw)) return [];
  const out: RhubarbCue[] = [];
  for (const c of raw.slice(0, 20_000)) {
    const o = c as { start?: unknown; end?: unknown; value?: unknown };
    if (typeof o.start !== 'number' || typeof o.end !== 'number' || !Number.isFinite(o.start) || !Number.isFinite(o.end) || typeof o.value !== 'string') continue;
    if (!(RHUBARB_SHAPES as readonly string[]).includes(o.value)) continue;
    const start = Math.max(out.length ? out[out.length - 1].end : 0, Math.max(0, o.start)), end = Math.min(dur, o.end);
    if (end > start) out.push({ start, end, value: o.value as RhubarbShape });
  }
  return out;
}
/** Cues → viseme segments covering [0, dur] without gaps (a gap is silence), neighbours with the same viseme merged. */
export function cuesToSegs(cues: readonly RhubarbCue[], dur: number): VisemeSeg[] {
  const segs: VisemeSeg[] = [];
  const push = (t0: number, t1: number, v: Viseme) => {
    if (t1 - t0 <= 1e-4) return;
    const last = segs[segs.length - 1];
    if (last && last.v === v && Math.abs(last.t1 - t0) < 1e-4) last.t1 = t1; else segs.push({ t0, t1, v });
  };
  let t = 0;
  for (const c of cues) { push(t, c.start, 'sil'); push(c.start, c.end, shapeViseme(c.value)); t = c.end; }
  push(t, Math.max(t, dur), 'sil');
  return segs;
}

// ---------------------------------------------------------------- finding / unpacking the CLI
let located: Promise<string | null> | null = null;
const hasCli = (dir: string) => fs.existsSync(path.join(dir, 'rhubarb.exe')) && fs.existsSync(path.join(dir, 'res', 'sphinx', 'cmudict-en-us.dict'));

/** Read the wanted entries of a (non-zip64) zip with node's own inflate: no PowerShell, no unzip tool. Only allow-listed names are written, inside `dest`. */
export function unpackZip(zip: Buffer, dest: string, wanted: (name: string) => boolean = WANTED): number {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_558); i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const n = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16), written = 0;
  const root = path.resolve(dest) + path.sep;
  for (let k = 0; k < n; k++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip directory');
    const method = zip.readUInt16LE(p + 10), csize = zip.readUInt32LE(p + 20), usize = zip.readUInt32LE(p + 24);
    const nl = zip.readUInt16LE(p + 28), el = zip.readUInt16LE(p + 30), cl = zip.readUInt16LE(p + 32), lh = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nl);
    p += 46 + nl + el + cl;
    if (name.endsWith('/') || !wanted(name)) continue;
    if (usize > 200 * 1024 * 1024) throw new Error(`entry too large: ${name}`);
    const target = path.resolve(dest, name.slice(ZIP_ROOT.length));
    if (!target.startsWith(root)) throw new Error(`entry outside the folder: ${name}`);
    if (zip.readUInt32LE(lh) !== 0x04034b50) throw new Error('damaged zip entry');
    const data = zip.subarray(lh + 30 + zip.readUInt16LE(lh + 26) + zip.readUInt16LE(lh + 28), lh + 30 + zip.readUInt16LE(lh + 26) + zip.readUInt16LE(lh + 28) + csize);
    const bytes = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
    if (!bytes || bytes.length !== usize) throw new Error(`cannot read ${name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    written++;
  }
  return written;
}

/** The folder holding rhubarb.exe + res/, or null (not Windows / not installed). Cached. */
export function locateRhubarb(): Promise<string | null> {
  if (located) return located;
  located = (async () => {
    if (process.platform !== 'win32') return null;
    const env = process.env.VTP_RHUBARB;
    const cands = [env, path.join(VENDOR, `Rhubarb-Lip-Sync-${RHUBARB_VERSION}-Windows`), VENDOR].filter((x): x is string => !!x);
    for (const d of cands) if (hasCli(d)) return d;
    const zip = [process.env.VTP_RHUBARB_ZIP, path.join(VENDOR, ZIP_NAME)].find((z): z is string => !!z && fs.existsSync(z));
    if (!zip) return null;
    const dest = path.join(os.tmpdir(), 'vtp_rhubarb', RHUBARB_VERSION);
    if (hasCli(dest)) return dest;
    try { unpackZip(fs.readFileSync(zip), dest); return hasCli(dest) ? dest : null; } catch (e) { console.warn('[lipsync] could not unpack Rhubarb:', (e as Error).message); return null; }
  })();
  located.then((v) => { if (!v) located = null; }, () => { located = null; });   // (look again next time when it was not found)
  return located;
}
export const rhubarbAvailable = async () => !!(await locateRhubarb());

// ---------------------------------------------------------------- running it
/** Duration (s) of a PCM WAV; 0 when unknown (OGG …). */
export function wavDuration(b: Buffer): number {
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return 0;
  let off = 12, byteRate = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') byteRate = b.readUInt32LE(off + 16);
    if (id === 'data') return byteRate ? Math.min(size, b.length - off - 8) / byteRate : 0;
    off += 8 + size + (size & 1);
  }
  return 0;
}
const isOgg = (b: Buffer) => b.length > 4 && b.toString('ascii', 0, 4) === 'OggS';
const isWav = (b: Buffer) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE';
/** The spoken words as plain text for --dialogFile (letters, digits, basic punctuation: Rhubarb's recogniser only knows those). */
export function dialogText(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9'.,;:!?\s-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
}

export interface RhubarbOpts { /** the words that are spoken (English): far more accurate */ text?: string; mode?: 'pocketSphinx' | 'phonetic'; timeoutMs?: number }
/** Cues for a spoken line's audio (WAV / OGG bytes). null = Rhubarb is not available or could not read it (the caller keeps its fallback). */
export async function rhubarbCues(audio: Buffer, o: RhubarbOpts = {}): Promise<RhubarbResult | null> {
  if (!audio.length || audio.length > MAX_WAV || !(isWav(audio) || isOgg(audio))) return null;
  const dir = await locateRhubarb();
  if (!dir) return null;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vtp_lipsync_'));
  const id = crypto.randomBytes(6).toString('hex');
  const inFile = path.join(work, `${id}${isOgg(audio) ? '.ogg' : '.wav'}`), outFile = path.join(work, `${id}.json`), dlg = path.join(work, `${id}.txt`);
  const mode = o.mode ?? (process.env.VTP_RHUBARB_MODE === 'pocketSphinx' ? 'pocketSphinx' : 'phonetic');
  const t0 = performance.now();
  try {
    fs.writeFileSync(inFile, audio);
    const args = ['-f', 'json', '--extendedShapes', 'GHX', '-r', mode, '-q', '-o', outFile];
    const words = mode === 'pocketSphinx' && o.text ? dialogText(o.text) : '';
    if (words.length > 1) { fs.writeFileSync(dlg, words, 'utf8'); args.push('--dialogFile', dlg); }
    args.push(inFile);
    await new Promise<void>((res, rej) => {
      execFile(path.join(dir, 'rhubarb.exe'), args, { cwd: work, windowsHide: true, timeout: o.timeoutMs ?? TIMEOUT_MS, maxBuffer: 1 << 20 }, (err) => (err ? rej(err) : res()));
    });
    const json = JSON.parse(fs.readFileSync(outFile, 'utf8')) as { metadata?: { duration?: number } };
    const dur = typeof json.metadata?.duration === 'number' && json.metadata.duration > 0 ? json.metadata.duration : wavDuration(audio);
    const cues = parseCues(json, dur || Infinity);
    if (!cues.length) return null;
    return { cues, segs: cuesToSegs(cues, dur || cues[cues.length - 1].end), dur: dur || cues[cues.length - 1].end, ms: Math.round(performance.now() - t0), mode };
  } catch (e) {
    console.warn('[lipsync] Rhubarb failed:', (e as Error).message.slice(0, 200));
    return null;
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => {});     // (our own temp folder, created above)
  }
}
