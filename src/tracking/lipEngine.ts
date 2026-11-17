// Which lip-sync engine runs: GPU (Audio2Face-3D, the helper's sidecar) or the browser engine (src/tracking/neuralVisemes.ts + the
// rule engine, which always runs and is what the GPU result is blended into). The decision is pure (unit-tested in
// tools/lipengine_unit.ts); the studio calls autoPickA2f() once after it starts.
//
//   · an RTX 50-series card with the Audio2Face files installed: the studio ASKS once ("Your NVIDIA card can run better lip sync.
//     Turn it on?"), never starts a GPU job by itself the first time. The answer is kept on the helper (config/gpu.json): once
//     accepted it stays on, also after a cleared browser; declined = never asked again. Nothing starts while OBS is live;
//   · an RTX 20 / 30 / 40 card: offered in Tracking → GPU lip sync with an honest "not tested on this card" line, never on by itself;
//   · anything else, or the files missing: the browser engine, as before.
// The browser engine never stops running, so a sidecar that is slow, dead or gone costs nothing but the extra GPU detail.
import { a2fOffer, classifyGpu, type A2fOffer, type A2fSupport, type GpuClass } from '../../shared/gpuClass.ts';

/** GET /api/gpu/status, the parts this needs (older versions have no `a2f` / `series` on the gpu object: it is worked out from the name). */
export interface GpuStatusLike {
  /** the owner's answer kept on the helper (config/gpu.json); null / missing = never asked */
  choice?: 'accepted' | 'declined' | null;
  /** OBS is streaming / recording right now (null = can't tell) */
  live?: boolean | null;
  gpu?: { name?: string; vramMB?: number; nvidia?: boolean; rtx50?: boolean; a2f?: A2fSupport; note?: string } | null;
  have?: { a2fModel?: boolean; venv?: boolean } | null;
}
export interface LipEngineState { on: boolean; /** the user turned GPU lip sync off themselves: never switch it on again by itself */ optOut?: boolean; /** it is on because the studio chose it */ autoPicked?: boolean }
/** enable = on again (the owner accepted before); ask = show the one-time prompt; disable = undo the studio's own pick; none */
export type LipEngineAction = 'enable' | 'ask' | 'disable' | 'none';
export interface LipEngineChoice { engine: 'a2f' | 'browser'; action: LipEngineAction; offer: A2fOffer; gpu: GpuClass | null; why: string }

export function gpuClassOf(s: GpuStatusLike | null | undefined): GpuClass | null {
  const g = s?.gpu;
  if (!g || !g.name) return null;
  const c = classifyGpu(g.name, g.vramMB ?? 0);
  // a newer version says it itself; trust it when present
  return g.a2f ? { ...c, a2f: g.a2f, note: g.note ?? c.note } : c;
}

export function chooseLipEngine(state: LipEngineState, status: GpuStatusLike | null | undefined): LipEngineChoice {
  const gpu = gpuClassOf(status);
  const offer = a2fOffer(gpu, status?.have);
  // no answer from the helper (status null / no gpu object) = no information: change nothing
  if (!status || !status.gpu) return { engine: state.on ? 'a2f' : 'browser', action: 'none', offer, gpu, why: 'no GPU information from VTube Pro' };
  if (state.on && state.autoPicked && (!offer.auto || status.choice === 'declined')) return { engine: 'browser', action: 'disable', offer, gpu, why: 'the studio had picked GPU lip sync, but this PC no longer qualifies (card or files) or the owner declined' };
  if (!state.on && offer.auto) {
    // the owner's saved answer on the helper decides, not this browser (a cleared browser must not flip it either way)
    if (status.choice === 'accepted') return { engine: 'a2f', action: 'enable', offer, gpu, why: 'accepted before (kept on VTube Pro)' };
    if (status.choice === 'declined' || state.optOut) return { engine: 'browser', action: 'none', offer, gpu, why: 'declined / turned off by the owner' };
    // never asked: ask once (not while live)
    if (status.live === true) return { engine: 'browser', action: 'none', offer, gpu, why: 'live right now: not asking' };
    return { engine: 'browser', action: 'ask', offer, gpu, why: 'RTX 50-series card with the Audio2Face files installed: ask the owner once' };
  }
  return { engine: state.on ? 'a2f' : 'browser', action: 'none', offer, gpu,
    why: state.optOut && !state.on ? 'turned off by the user' : state.on ? 'on' : offer.available ? (offer.untested ? 'offered (untested card)' : 'available, files not installed yet') : 'browser engine only' };
}

/** The part of AudioLipSync this needs (src/tracking/audioLipSync.ts). */
export interface A2fHost { a2fSettings: LipEngineState & object; a2fBlocked: boolean; a2fAutoPick(status: GpuStatusLike | null): LipEngineChoice }

/** Ask the helper what this PC has and let the studio choose (the call that runs once after start; never throws). */
export async function autoPickA2f(audio: A2fHost, fetcher: (url: string) => Promise<{ json(): Promise<unknown> }> = (u) => fetch(u)): Promise<LipEngineChoice | null> {
  if (audio.a2fBlocked) return null;
  try { return audio.a2fAutoPick((await (await fetcher('/api/gpu/status')).json()) as GpuStatusLike); } catch { return null; }
}
