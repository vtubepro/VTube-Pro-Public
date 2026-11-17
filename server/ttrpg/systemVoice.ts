// "This PC's voices" for the AI GM, rendered to audio on the server so the GM can be heard ON STREAM: the OBS page
// plays the file (browser source → "Control audio via OBS"), which the browser's own speechSynthesis can't do (its
// sound goes straight to the speakers, never through the page). Windows: the built-in SAPI voices (Microsoft David /
// Zira …) through one long-lived PowerShell worker (System.Speech, no installs, offline, free). Elsewhere: unavailable
// (use a voice server on this PC under Setup instead).
// Safety: the text never touches a command line — requests go to the worker's stdin as base64 JSON and the SSML is
// built with every character escaped; the worker writes to our own temp folder only.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { psFileCommand, psScriptExists, psScriptPath } from '../psLaunch.ts';

/** The worker is a static script file (tools/helper/win/ps/system_voice.ps1): the same stdin / stdout protocol, nothing encoded. */
const WORKER_SCRIPT = 'system_voice.ps1';

export interface SystemVoice { name: string; lang: string; gender: string }
export interface SayOpts { voice?: string; rate?: number; pitch?: number }

const DIR = path.join(os.tmpdir(), 'vtp_ttrpg_voice');
let proc: ChildProcessWithoutNullStreams | null = null;
let ready: Promise<SystemVoice[]> | null = null;
let idle: NodeJS.Timeout | null = null;
const waiting = new Map<string, { ok: () => void; fail: (e: Error) => void }>();
let chain: Promise<unknown> = Promise.resolve();

export const systemVoiceSupported = () => process.platform === 'win32';

function start(): Promise<SystemVoice[]> {
  if (ready) return ready;
  ready = new Promise<SystemVoice[]>((resolve, reject) => {
    const script = psScriptPath(WORKER_SCRIPT);
    if (!psScriptExists(script)) { reject(new Error('Windows voices did not start')); return; } // (script missing: fails like PowerShell failing)
    const cmd = psFileCommand(script, [], ['-NoLogo']);
    const p = spawn(cmd.command, cmd.args, { windowsHide: true });
    proc = p;
    let buf = '';
    const t = setTimeout(() => { reject(new Error('Windows voices did not start')); stop(); }, 15_000);
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line.startsWith('VOICES ')) {
          clearTimeout(t);
          resolve(line.slice(7).split('|').filter(Boolean).map((v) => { const [name, lang, gender] = v.split('~'); return { name, lang: lang ?? '', gender: gender ?? '' }; }));
        } else if (line.startsWith('OK ') || line.startsWith('ERR ')) {
          const [, id, ...rest] = line.split(' ');
          const w = waiting.get(id); waiting.delete(id);
          if (w) line.startsWith('OK ') ? w.ok() : w.fail(new Error(rest.join(' ').slice(0, 200) || 'voice failed'));
        }
      }
    });
    p.stderr.on('data', () => { /* progress noise */ });
    p.on('exit', () => { clearTimeout(t); for (const w of waiting.values()) w.fail(new Error('the Windows voice worker stopped')); waiting.clear(); proc = null; ready = null; reject(new Error('the Windows voice worker stopped')); });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
  });
  ready.catch(() => { ready = null; });
  return ready;
}

function stop() { try { proc?.kill(); } catch { /* */ } proc = null; ready = null; }
function touch() { if (idle) clearTimeout(idle); idle = setTimeout(stop, 120_000); idle.unref?.(); }

export async function systemVoices(): Promise<SystemVoice[]> {
  if (!systemVoiceSupported()) return [];
  touch();
  return start();
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
const pct = (v: number) => `${v >= 0 ? '+' : ''}${Math.round(v)}%`;

/** Pick the installed voice for a browser voice name ("Microsoft David - English (United States)" → "Microsoft David Desktop"). */
export function matchVoice(list: SystemVoice[], want?: string): SystemVoice | null {
  if (!list.length) return null;
  const w = (want ?? '').toLowerCase();
  const exact = list.find((v) => v.name.toLowerCase() === w);
  if (exact) return exact;
  const first = w.replace(/^microsoft\s+/, '').split(/[\s-]+/)[0];
  return (first && list.find((v) => v.name.toLowerCase().replace(/^microsoft\s+/, '').startsWith(first))) || list.find((v) => /^en/i.test(v.lang) && /male/i.test(v.gender) && !/female/i.test(v.gender)) || list[0];
}

/** Render a line with a Windows voice → WAV bytes + duration (s). One line at a time (the worker is serial). */
export function systemSay(text: string, o: SayOpts = {}): Promise<{ audio: Buffer; type: string; dur: number; voice: string }> {
  const run = async () => {
    if (!systemVoiceSupported()) throw Object.assign(new Error("This PC's voices on stream need Windows — pick a voice server under Setup → AI voice."), { status: 400 });
    const list = await systemVoices();
    const v = matchVoice(list, o.voice);
    if (!v) throw Object.assign(new Error('No Windows voices are installed.'), { status: 400 });
    if (!proc) throw new Error('the Windows voice worker is not running');
    fs.mkdirSync(DIR, { recursive: true });
    const id = crypto.randomBytes(8).toString('hex');
    const file = path.join(DIR, `${id}.wav`);
    const rate = Math.max(-50, Math.min(100, ((o.rate ?? 1) - 1) * 100));
    const pitch = Math.max(-50, Math.min(50, ((o.pitch ?? 1) - 1) * 60));
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${esc(v.lang || 'en-US')}"><prosody rate="${pct(rate)}" pitch="${pct(pitch)}">${esc(text.slice(0, 1200))}</prosody></speak>`;
    const done = new Promise<void>((ok, fail) => { waiting.set(id, { ok, fail }); setTimeout(() => { if (waiting.delete(id)) fail(new Error('the Windows voice took too long')); }, 30_000); });
    proc!.stdin.write(Buffer.from(JSON.stringify({ id, file, voice: v.name, ssml }), 'utf8').toString('base64') + '\n');
    touch();
    try {
      await done;
      const audio = fs.readFileSync(file);
      return { audio, type: 'audio/wav', dur: wavSeconds(audio), voice: v.name };
    } finally { fs.rm(file, { force: true }, () => {}); }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => null);
  return p;
}

/** Duration of a PCM WAV (RIFF) in seconds (0 if unknown). */
export function wavSeconds(b: Buffer): number {
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

export function stopSystemVoice() { stop(); }
