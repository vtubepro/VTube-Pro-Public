// VTube Pro Live: the facts "Check my setup" gets for tracking, microphone, graphics card, video speed, internet and doubled sound
// (PreflightFacts.tracking / mic / gpu / encoders / upload / showSoundsHeardTwice). Before this file those were always null, so five
// rows said "I can't tell" on every PC.
//
// Where each fact comes from (all of it is something the Helper already has; nothing here polls, starts or sends anything):
//   tracking   the studio uploads cache/diag/state.json every ~3 s while its tracking is on (src/app.ts sendDiagnostics): a fresh file
//              = tracking is running (and its trackFps); a file the Helper saw stop = the camera is off. One file read per check.
//   gpu        the same file: the studio's WebGL renderer + class (what it really draws with) and the card reading it forwards
//              (gpuCard, from server/gpuWatch.ts). No hardware scan: that one needs the person's "Yes, scan my computer" click.
//   mic, encoder, doubled sound
//              the OBS we already talk to (obs-websocket reads: GetSpecialInputs, GetInputList, GetInputSettings, GetInputMute,
//              GetInputAudioMonitorType, GetProfileParameter), once per check, through ObsBackend.setupProbe().
//   upload     NEVER an outside speed test. The best bitrate a real show held for 30 s with no dropped frames (UploadMemo, fed by the
//              show's own one-second health loop, RAM only, forgotten after 12 hours). A private test goes to a local receiver, so it
//              says nothing about the internet and is not used for this.
// A fact that cannot be known stays null, and the report then leaves that row out (shared/broadcastPreflight.ts hideNoDataRows).
// Pure functions + one small file reader; unit-tested in tools/broadcast_setup_facts_unit.ts.
import fs from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR } from '../paths.ts';
import { GPU_STAT_FRESH_MS } from '../../shared/gpuStat.ts';
import { neededVideoKbps } from '../../shared/broadcastPreflight.ts';
import type { EncoderKind, GpuTier, PreflightFacts, VideoFormat } from '../../shared/broadcastTypes.ts';

/** The studio uploads state.json every ~3 s while tracking: five missed uploads means it stopped. */
export const TRACKING_FRESH_MS = 15_000;
/** A good show's bitrate is a fair guess of the upload for this long. */
export const UPLOAD_KEEP_MS = 12 * 3600_000;
/** A show has to hold its bitrate this long, without dropped frames, before it counts. */
export const UPLOAD_HEALTHY_MS = 30_000;
const STATE_MAX_BYTES = 4 * 1024 * 1024;
export const MONITOR_AND_OUTPUT = 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT';

// ---------------------------------------------------------------- what the OBS probe returns

/** What ObsBackend.setupProbe() read from OBS. null = OBS did not answer that part. */
export interface SetupProbeResult {
  /** Microphone inputs (OBS's global Mic/Aux sources and audio-input captures), with whether each is muted. */
  mics: { name: string; muted: boolean | null }[] | null;
  /** OBS has a Desktop Audio source (so the PC's sound is captured). */
  desktopAudio: boolean | null;
  /** The VTube Pro browser sources: "Control audio via OBS" on or off, and how OBS monitors each. */
  pages: { name: string; reroute: boolean; monitor: string | null }[] | null;
  /** The stream encoder id OBS is set to, as OBS names it ("x264", "jim_nvenc", "h264_texture_amf" ...). */
  encoder: string | null;
}
export const EMPTY_PROBE: SetupProbeResult = { mics: null, desktopAudio: null, pages: null, encoder: null };

/** Backends that can read these few facts (ObsBackend). Optional, like ServiceRestorer. */
export interface SetupProbe { setupProbe(): Promise<SetupProbeResult> }
export const canProbeSetup = (b: unknown): b is SetupProbe => !!b && typeof (b as Partial<SetupProbe>).setupProbe === 'function';

// ---------------------------------------------------------------- state.json (the studio's diagnostics drop)

export interface DiagSnap { mtimeMs: number; json: unknown }

/** cache/diag/state.json as the studio last uploaded it, or null (never uploaded, unreadable, or not an object). */
export async function readDiagState(dir: string = path.join(CACHE_DIR, 'diag')): Promise<DiagSnap | null> {
  try {
    const f = path.join(dir, 'state.json');
    const st = await fs.stat(f);
    if (!st.isFile() || st.size > STATE_MAX_BYTES) return null;
    const json = JSON.parse(await fs.readFile(f, 'utf8')) as unknown;
    return json && typeof json === 'object' ? { mtimeMs: st.mtimeMs, json } : null;
  } catch { return null; }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------- the facts, pure

/** Face tracking. `bootMs` = when this Helper started: a state.json older than that says nothing about now. */
export function trackingFact(snap: DiagSnap | null, now: number, bootMs: number): PreflightFacts['tracking'] {
  if (!snap) return null;
  if (now - snap.mtimeMs <= TRACKING_FRESH_MS) {
    const fps = num(obj(obj(snap.json).stats).trackFps);
    return { running: true, fps: fps !== null && fps > 0 ? Math.round(fps * 10) / 10 : null };
  }
  // the Helper saw uploads and then they stopped: the studio's tracking is off (or its tab is closed)
  return snap.mtimeMs >= bootMs ? { running: false, fps: null } : null;
}

const TIER_TOP = new Set(['enthusiast', 'upper', 'upper-mid']);
const TIER_GOOD = new Set(['mid', 'mainstream']);
/** "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)" -> "NVIDIA GeForce RTX 3060". */
export function gpuNameOf(renderer: string): string | null {
  let s = renderer.trim();
  const m = /^ANGLE \(([^,]*),\s*(.+?)(?:\s+\(0x[0-9a-f]+\))?(?:\s+(?:Direct3D\d*|OpenGL|Vulkan|Metal)\b.*)?(?:,\s*[^,)]*\))?\s*$/i.exec(s);
  if (m) s = m[2];
  s = s.replace(/\s+/g, ' ').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
  return s || null;
}

/** The graphics card, from what the studio draws with (its WebGL class) and the card reading the Helper forwarded. */
export function gpuFact(snap: DiagSnap | null, now: number): PreflightFacts['gpu'] {
  if (!snap) return null;
  const root = obj(snap.json);
  const gl = obj(root.webgl);
  const renderer = typeof gl.renderer === 'string' ? gl.renderer : '';
  const id = typeof gl.gpuClass === 'string' ? gl.gpuClass : '';
  if (!renderer && !id) return null;
  const tier: GpuTier = gl.software === true ? 'none' : TIER_TOP.has(id) ? 'top' : TIER_GOOD.has(id) ? 'good' : 'entry';
  const card = obj(root.gpuCard);
  const at = num(card.at), used = num(card.usedMB), total = num(card.totalMB), util = num(card.util);
  const fresh = at !== null && now - at <= GPU_STAT_FRESH_MS;
  return {
    tier, name: gpuNameOf(renderer),
    busyPct: fresh && util !== null ? Math.max(0, Math.min(100, Math.round(util))) : null,
    vramFreeMb: fresh && used !== null && total !== null && total > 0 ? Math.max(0, Math.round(total - used)) : null,
  };
}

/** Is a microphone in the show? null = OBS did not say. */
export function micFact(p: SetupProbeResult | null): PreflightFacts['mic'] {
  if (!p || !p.mics) return null;
  return { present: p.mics.some((m) => m.muted !== true) };
}

/** OBS's stream encoder id -> the kind of video chip it uses. null = a name we do not know (it stays unknown, never a guess). */
export function encoderKind(id: string | null | undefined): EncoderKind | null {
  if (!id) return null;
  if (/nvenc/i.test(id)) return 'nvenc';
  if (/amf|\bamd\b|^amd/i.test(id)) return 'amf';
  if (/qsv|quicksync/i.test(id)) return 'qsv';
  if (/x264|openh264|ffmpeg_aac_h264/i.test(id)) return 'x264';
  return null;
}
export function encodersFact(p: SetupProbeResult | null): EncoderKind[] | null {
  const k = encoderKind(p?.encoder);
  return k ? [k] : null;
}

/** Would the show's own sounds be heard twice? Only when a VTube Pro page sends its sound into OBS AND lets OBS play it back
 *  to the speakers while OBS also captures Desktop Audio (the speakers' sound comes in a second time). null = nothing to judge. */
export function doubleAudioFact(p: SetupProbeResult | null): boolean | null {
  if (!p || !p.pages || p.pages.length === 0 || p.desktopAudio === null) return null;
  return p.desktopAudio && p.pages.some((x) => x.reroute && x.monitor === MONITOR_AND_OUTPUT);
}

/** The best the internet has been seen to carry: a show's bitrate held for UPLOAD_HEALTHY_MS with (almost) no dropped frames.
 *  A lower bound, never a measurement: it can only ever prove "fast enough", so it is never used to say "too slow". */
export class UploadMemo {
  private since = 0;
  private avg = 0;
  private best: { kbps: number; at: number } | null = null;
  /** One reading per second of a real show (not a private test). */
  observe(at: number, s: { streaming: boolean; bitrateKbps: number | null; droppedFrac: number | null }): void {
    const healthy = s.streaming && s.bitrateKbps !== null && s.bitrateKbps > 0 && (s.droppedFrac ?? 0) <= 0.02;
    if (!healthy) { this.since = 0; this.avg = 0; return; }
    if (!this.since) { this.since = at; this.avg = s.bitrateKbps!; } else this.avg = this.avg * 0.8 + s.bitrateKbps! * 0.2;
    if (at - this.since < UPLOAD_HEALTHY_MS) return;
    const kbps = Math.round(this.avg);
    if (!this.best || at - this.best.at > UPLOAD_KEEP_MS || kbps >= this.best.kbps) this.best = { kbps, at };
    else this.best = { kbps: this.best.kbps, at };   // (a quieter stretch of the same good show: the old figure still stands, now re-confirmed)
  }
  sample(now: number): { kbps: number; ageS: number } | null {
    if (!this.best || now - this.best.at > UPLOAD_KEEP_MS) return null;
    return { kbps: this.best.kbps, ageS: Math.max(0, Math.round((now - this.best.at) / 1000)) };
  }
}

/** The upload fact for the check: only when a recent good show proved the connection carries (a lot more than) what this picture needs. */
export function uploadFact(memo: UploadMemo | null, now: number, canvas: VideoFormat | null, places: number): PreflightFacts['upload'] {
  const s = memo?.sample(now);
  if (!s) return null;
  const need = (neededVideoKbps(canvas) + 160) * Math.max(1, places);
  if (s.kbps < need * 1.5) return null;                 // proves nothing about "too slow": leave the row without data
  return { mbps: Math.round(s.kbps / 100) / 10, ageS: s.ageS };
}

// ---------------------------------------------------------------- gathering

export interface SetupFactsInput {
  now: number;
  bootMs: number;
  diag: DiagSnap | null;
  probe: SetupProbeResult | null;
  upload: UploadMemo | null;
  canvas: VideoFormat | null;
  /** How many places the picture is sent to at once (the engine sends one copy each; stock OBS sends one). */
  places: number;
}
export type SetupFacts = Pick<PreflightFacts, 'tracking' | 'mic' | 'gpu' | 'encoders' | 'upload' | 'showSoundsHeardTwice'>;

/** All six facts from what was read. Pure: the caller reads state.json and probes OBS. */
export function setupFactsFrom(i: SetupFactsInput): SetupFacts {
  return {
    tracking: trackingFact(i.diag, i.now, i.bootMs),
    gpu: gpuFact(i.diag, i.now),
    mic: micFact(i.probe),
    encoders: encodersFact(i.probe),
    upload: uploadFact(i.upload, i.now, i.canvas, i.places),
    showSoundsHeardTwice: doubleAudioFact(i.probe),
  };
}
