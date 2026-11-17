// VTube Pro Live, W1: the picture-quality ladder and the governor rung table, pure. Implements BroadcastLadderApi
// (shared/broadcastTypes.ts).
//
// pickLadder: graphics-card tier + which encoders work + the measured upload + the platform ceiling -> one pick
// (encoder, size, fps, bitrate). Defaults: 1080p60 at 6,000 kbps. A top card with a fat, measured uplink and no platform
// ceiling below it goes to 8,500. A weak uplink drops to 720p60 at 4,500. With no hardware encoder the pick is x264 at
// 720p30, labelled "slow mode". Never picks something the uplink cannot carry; never exceeds the platform ceiling.
//
// governorStep: under load, shed one rung at a time in GOVERNOR_ORDER (preview, vertical, secondary outputs, avatar fps,
// avatar scale, canvas, main bitrate); give one back after 60 s of low load. The GAME is never a rung. Settings are always
// recomputed from (base, shed set), so the same set always gives the same settings.

import { GOVERNOR_ORDER } from './broadcastTypes.ts';
import type {
  BroadcastLadderApi, EncoderKind, GovernorRungId, GovernorSettings, GpuTier, LadderInput, LadderPick,
} from './broadcastTypes.ts';

export const AUDIO_KBPS = 160;
export const AUDIO_KBPS_SLOW = 128;
/** Share of the measured upload a stream may use. Gaming leaves more headroom (the game's own traffic). */
export const UPLOAD_SHARE = 0.8;
export const UPLOAD_SHARE_GAMING = 0.7;
/** A rung is skipped when the platform ceiling would squeeze its bitrate below this share of its nominal bitrate. */
/** The least video bitrate ever returned (best effort when nothing fits). */
export const MIN_VIDEO_KBPS = 200;
export const CEILING_MIN_SHARE = 0.75;
/** The 8,500 kbps rung needs at least a top card. */
export const HIGH_RUNG_TIERS: readonly GpuTier[] = ['top'];

interface Rung { width: number; height: number; fps: number; kbps: number; id: string }
/** Hardware rungs, best first. */
const RUNGS: readonly Rung[] = [
  { id: 'hi', width: 1920, height: 1080, fps: 60, kbps: 8500 },
  { id: '1080p60', width: 1920, height: 1080, fps: 60, kbps: 6000 },
  { id: '720p60', width: 1280, height: 720, fps: 60, kbps: 4500 },
  { id: '720p30', width: 1280, height: 720, fps: 30, kbps: 3000 },
  { id: '480p30', width: 854, height: 480, fps: 30, kbps: 1500 },
];
/** Slow mode (x264) rungs: 720p30 first, then smaller. */
const SLOW_RUNGS: readonly Rung[] = [
  { id: '720p30', width: 1280, height: 720, fps: 30, kbps: 3000 },
  { id: '480p30', width: 854, height: 480, fps: 30, kbps: 1500 },
];

/** Encoder preference when several work. */
const ENCODER_ORDER: readonly Exclude<EncoderKind, 'x264'>[] = ['nvenc', 'amf', 'qsv'];

const labelOf = (r: Rung, slow: boolean) => `${r.height}p ${r.fps} fps${slow ? ', slow mode' : ''}`;

export function pickLadder(i: LadderInput): LadderPick {
  const hw = ENCODER_ORDER.find((e) => i.encoders.includes(e)) ?? null;
  const slow = hw === null;
  const encoder: EncoderKind = hw ?? 'x264';
  const audio = slow ? AUDIO_KBPS_SLOW : AUDIO_KBPS;
  const share = i.gaming ? UPLOAD_SHARE_GAMING : UPLOAD_SHARE;
  const usableKbps = i.uploadMbps === null || !Number.isFinite(i.uploadMbps) ? Infinity : Math.max(0, i.uploadMbps) * 1000 * share;
  const ceiling = i.platformMaxKbps === null || !Number.isFinite(i.platformMaxKbps) ? Infinity : Math.max(0, i.platformMaxKbps);

  let rungs: readonly Rung[] = slow ? SLOW_RUNGS : RUNGS;
  if (!slow) {
    // The 8,500 rung is for a top card with a measured uplink only (the default is 6,000, the probe raises it).
    if (!HIGH_RUNG_TIERS.includes(i.gpuTier) || i.uploadMbps === null) rungs = rungs.filter((r) => r.id !== 'hi');
    // A small card or no card (an integrated encoder) shares its power with the game: 720p60 at most while gaming.
    if ((i.gpuTier === 'entry' || i.gpuTier === 'none') && i.gaming) rungs = rungs.filter((r) => r.height <= 720);
  }

  let chosen: Rung | null = null;
  let kbps = 0;
  for (const r of rungs) {
    const eff = Math.min(r.kbps, ceiling);
    if (eff < r.kbps * CEILING_MIN_SHARE) continue;
    if (eff + audio > usableKbps) continue;
    chosen = r; kbps = eff; break;
  }
  if (!chosen) {
    // Nothing fits: the smallest rung, trimmed to what we have (never above the ceiling), never below a floor.
    chosen = rungs[rungs.length - 1];
    kbps = Math.max(MIN_VIDEO_KBPS, Math.min(chosen.kbps, ceiling, Math.floor(usableKbps - audio)));
  }
  return {
    encoder, width: chosen.width, height: chosen.height, fps: chosen.fps,
    videoKbps: kbps, audioKbps: audio, keyintS: 2, slowMode: slow, label: labelOf(chosen, slow),
  };
}

// ---------------------------------------------------------------- governor

export const GOVERNOR_FLOORS = { pageFps: 20, renderScale: 0.5, canvasScale: 0.5, recordBitrate: 1000 } as const;

/** Settings after shedding `shed` from `base`. Pure and order independent. Rungs with no field in GovernorSettings
 *  ('secondary-off' beyond the recording bitrate, 'main-bitrate') are carried in the shed list for the caller to act on. */
export function governorSettings(shed: readonly GovernorRungId[], base: GovernorSettings): GovernorSettings {
  const s: GovernorSettings = { ...base };
  const has = (r: GovernorRungId) => shed.includes(r);
  if (has('preview-off')) s.previewOn = false;
  if (has('vertical-off')) s.verticalOn = false;
  if (has('secondary-off')) s.recordBitrate = Math.max(Math.min(GOVERNOR_FLOORS.recordBitrate, base.recordBitrate), Math.round(base.recordBitrate * 0.5));
  if (has('avatar-fps')) s.pageFps = Math.min(base.pageFps, Math.max(GOVERNOR_FLOORS.pageFps, Math.round(base.pageFps * 0.5)));
  if (has('avatar-scale')) s.renderScale = Math.min(base.renderScale, Math.max(GOVERNOR_FLOORS.renderScale, Math.round(base.renderScale * 75) / 100));
  if (has('canvas')) s.canvasScale = Math.min(base.canvasScale, Math.max(GOVERNOR_FLOORS.canvasScale, Math.round(base.canvasScale * 2 / 3 * 1000) / 1000));
  return s;
}

export function governorStep(
  state: { shed: GovernorRungId[] }, load: 'ok' | 'high' | 'low-for-60s', base: GovernorSettings,
): { shed: GovernorRungId[]; settings: GovernorSettings } {
  // Keep only known rungs, once each, in table order (so a stale or doubled list cannot confuse the steps).
  let shed = GOVERNOR_ORDER.filter((r) => state.shed.includes(r));
  if (load === 'high') {
    const next = GOVERNOR_ORDER.find((r) => !shed.includes(r));
    if (next) shed = GOVERNOR_ORDER.filter((r) => r === next || shed.includes(r));
  } else if (load === 'low-for-60s' && shed.length > 0) {
    shed = shed.slice(0, -1);
  }
  return { shed, settings: governorSettings(shed, base) };
}

const _api: BroadcastLadderApi = { pickLadder, governorStep };
void _api;
