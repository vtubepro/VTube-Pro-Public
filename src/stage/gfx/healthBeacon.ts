// Studio → this PC's OBS pages (and the Scene-tab preview): face-tracking health once a second, so "Auto" graphics
// quality (src/stage/gfx/auto.ts) never takes GPU time the tracker needs. ?observer=1 studios send nothing.
// beta.13.5: the beacon also says where each model runs, the face / camera rates, the frame in flight, starve / stall,
// the graphics-queue round trip, focus and the studio's draw rate (P0 observability: research/tracking_gpu_rca/RCA.md);
// the same object goes into state.json (trackingHealthNow). It also runs the graphics-queue probe while tracking runs.
import type { BusMessage } from '../../../shared/types.ts';
import type { TrackingHealth } from '../../../shared/graphics.ts';
import { gpuSync } from '../../tracking/gpuSyncProbe.ts';

interface TrackerLike {
  models(): { roles?: Record<string, { delegate: string } | null> };
  camFps(now?: number): number;
  gameMode: boolean;
  inFlightMs: number;
}
interface StudioLike {
  bus: { send(m: BusMessage): void };
  stats: { inferMs: number; trackFps?: number; fps?: number };
  trackingOn: boolean; observer: boolean;
  tracker?: TrackerLike;
  starveMeter?: { w: number };
}

/** The health the studio reports right now (the beacon + state.json). */
export function trackingHealthNow(app: StudioLike): TrackingHealth {
  const h: TrackingHealth = { inferMs: +app.stats.inferMs.toFixed(2), trackFps: Math.round(app.stats.trackFps ?? 0), tracking: app.trackingOn };
  const tr = app.tracker;
  if (!tr || !app.trackingOn) return h;
  try {
    const roles = tr.models().roles ?? {};
    h.faceDelegate = roles.face?.delegate; h.poseDelegate = roles.pose?.delegate; h.handsDelegate = roles.hands?.delegate;
    h.faceHz = +(app.stats.trackFps ?? 0).toFixed(1); h.camFps = Math.round(tr.camFps());
    h.inflightMs = tr.inFlightMs; h.stall = tr.gameMode; h.starve = +(app.starveMeter?.w ?? 0).toFixed(2);
    h.gpuSyncMs = gpuSync.ms < 0 ? -1 : +gpuSync.ms.toFixed(1);
    h.focused = typeof document === 'undefined' || document.hasFocus();
    h.drawFps = Math.round(app.stats.fps ?? 0);
  } catch { /* diagnostics only */ }
  return h;
}

export function startHealthBeacon(app: StudioLike) {
  // (console / tests: the same object the beacon sends — tools/gamefps_e2e.mjs reads it)
  (globalThis as unknown as { vtpHealth?: () => TrackingHealth }).vtpHealth = () => trackingHealthNow(app);
  setInterval(() => {
    // the graphics-queue probe runs while tracking runs (one pixel a second)
    if (app.trackingOn && !app.observer) gpuSync.start(); else if (gpuSync.running) gpuSync.stop();
    if (app.observer) return;
    app.bus.send({ type: 'health', h: trackingHealthNow(app) });
  }, 1000);
}
