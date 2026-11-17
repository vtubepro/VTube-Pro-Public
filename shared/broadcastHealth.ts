// VTube Pro Live, W1: the stream health state machine, pure. Implements BroadcastHealthApi (shared/broadcastTypes.ts).
//
// Once a second (or per event) the caller hands in HealthInputs; this module says which plain-words state the stream is in:
// Not live / Smooth / Your internet is struggling / Your graphics card is busy / Your game went black / Reconnecting /
// Avatar paused. The wording is HEALTH_TEXT in the contract, the UI never shows a raw number.
//
// Two layers:
//   classifyHealth(inputs)  what the numbers say right now (no memory).
//   stepHealth(prev, inputs) the state machine with HYSTERESIS: a worse state must hold for its ENTER time before it is
//                            shown, and a state is only left (for a milder one) after its EXIT time of good readings, so
//                            one bad second never flashes a warning and a warning never flickers off. Any change of the
//                            input before the hold ends restarts the hold. Going live / ending the show is instant.
// Unknown readings (null) are never counted as bad. Only the engine can drop the stream (plan 4.2): a frozen avatar page
// or a closed studio tab shows "Avatar paused" but never anything stronger.

import { HEALTH_TEXT, RECONNECT_BACKOFF_S } from './broadcastTypes.ts';
import type { BroadcastHealthApi, HealthId, HealthInputs, HealthMachine, HealthView } from './broadcastTypes.ts';

/** Thresholds, named so tests and tuning have one place. Fractions are 0..1. */
export const HEALTH_LIMITS = {
  /** Network: more than this fraction of frames dropped, or the send rate under this fraction of the target. */
  droppedFrac: 0.02,
  bitrateRatioMin: 0.5,
  /** Graphics: skipped frames (render or encoder) over this fraction, or a very late pose. */
  skippedFrac: 0.02,
  poseAgeP95Ms: 150,
  /** Graphics card pinned AND the output frame rate well under target. */
  gpuBusyPct: 97,
  fpsRatioMin: 0.9,
  /** No avatar page stamps for this long = the page is paused (plan 4.2). */
  avatarPausedMs: 3000,
} as const;

/** How long the readings must say "this state" before it is shown (ms). Smooth and idle are instant. */
export const HEALTH_ENTER_MS: Record<HealthId, number> = {
  'idle': 0, 'smooth': 0, 'network-struggling': 5000, 'graphics-busy': 5000, 'source-black': 3000, 'reconnecting': 2000, 'avatar-paused': 0,
};
/** How long the readings must be milder before a state is left (ms). */
export const HEALTH_EXIT_MS: Record<HealthId, number> = {
  'idle': 0, 'smooth': 0, 'network-struggling': 15000, 'graphics-busy': 10000, 'source-black': 5000, 'reconnecting': 5000, 'avatar-paused': 2000,
};
/** Higher = worse for the viewer. Used to decide whether a move is "getting milder". */
export const HEALTH_SEVERITY: Record<HealthId, number> = {
  'idle': 0, 'smooth': 0, 'network-struggling': 1, 'graphics-busy': 2, 'avatar-paused': 3, 'source-black': 4, 'reconnecting': 5,
};

const over = (v: number | null, limit: number): boolean => v !== null && Number.isFinite(v) && v >= limit;

/** What the numbers say right now. Order of precedence: not live, reconnecting, game went black, avatar paused,
 *  graphics busy, internet struggling, smooth. */
export function classifyHealth(x: HealthInputs): HealthId {
  if (!x.streaming && !x.outputReconnecting) return 'idle';
  if (x.outputReconnecting) return 'reconnecting';
  if (x.captureBlank === true) return 'source-black';
  if (x.msSinceLastStamp !== null && x.msSinceLastStamp > HEALTH_LIMITS.avatarPausedMs) return 'avatar-paused';

  const fpsLow = x.fps !== null && x.targetFps !== null && x.targetFps > 0 && x.fps < x.targetFps * HEALTH_LIMITS.fpsRatioMin;
  const gpuPinned = x.gpuBusyPct !== null && x.gpuBusyPct >= HEALTH_LIMITS.gpuBusyPct;
  if (over(x.renderSkippedFrac, HEALTH_LIMITS.skippedFrac) || over(x.encoderSkippedFrac, HEALTH_LIMITS.skippedFrac)
    || over(x.poseAgeP95Ms, HEALTH_LIMITS.poseAgeP95Ms) || (gpuPinned && fpsLow)) return 'graphics-busy';

  const lowRate = x.bitrateKbps !== null && x.targetKbps !== null && x.targetKbps > 0
    && x.bitrateKbps < x.targetKbps * HEALTH_LIMITS.bitrateRatioMin;
  if (over(x.droppedFrac, HEALTH_LIMITS.droppedFrac) || lowRate) return 'network-struggling';
  return 'smooth';
}

export function initialHealth(now: number): HealthMachine {
  return { id: 'idle', since: now, candidate: null, candidateSince: null, lastNoticeAt: null };
}

/** Milliseconds to hold a change from `from` to `to` before showing it. */
export function healthHoldMs(from: HealthId, to: HealthId): number {
  if (from === 'idle' || to === 'idle') return 0;
  const enter = HEALTH_ENTER_MS[to];
  const exit = HEALTH_SEVERITY[to] < HEALTH_SEVERITY[from] ? HEALTH_EXIT_MS[from] : 0;
  return Math.max(enter, exit);
}

function enter(prev: HealthMachine, id: HealthId, now: number): HealthMachine {
  return { id, since: now, candidate: null, candidateSince: null, lastNoticeAt: id === 'idle' ? prev.lastNoticeAt : now };
}

export function stepHealth(prev: HealthMachine, inputs: HealthInputs): HealthMachine {
  const now = inputs.at;
  const raw = classifyHealth(inputs);
  if (raw === prev.id) {
    return prev.candidate === null ? prev : { ...prev, candidate: null, candidateSince: null };
  }
  const hold = healthHoldMs(prev.id, raw);
  const since = prev.candidate === raw && prev.candidateSince !== null ? prev.candidateSince : now;
  if (now - since >= hold) return enter(prev, raw, now);
  return { ...prev, candidate: raw, candidateSince: since };
}

export function healthView(m: HealthMachine): HealthView {
  const t = HEALTH_TEXT[m.id];
  return { id: m.id, since: m.since, title: t.title, say: t.say, tone: t.tone, fixId: t.fixId };
}

/** Seconds to wait before reconnect try `attempt` (1-based): 2, 4, 8, 15, 30, 30, ... Bad input counts as the first try. */
export function reconnectDelayS(attempt: number): number {
  const a = Number.isFinite(attempt) ? Math.floor(attempt) : 1;
  const i = Math.min(Math.max(a, 1), RECONNECT_BACKOFF_S.length) - 1;
  return RECONNECT_BACKOFF_S[i];
}

/** True when the change from `prev` to `next` is a state edge worth a notice (entering anything but "not live"). */
export function isHealthEdge(prev: HealthMachine, next: HealthMachine): boolean {
  return prev.id !== next.id && next.id !== 'idle';
}

const _api: BroadcastHealthApi = { initialHealth, stepHealth, healthView, reconnectDelayS };
void _api;
