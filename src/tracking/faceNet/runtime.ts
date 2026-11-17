// "My face model" stage 2, inside a face worker (trackWorker.ts for the graphics-card / tasks-vision face, cpuFaceWorker.ts for the
// processor-only face): per tracked frame, cut the Stage-1 crops out of the SAME pixels the landmarks came from and either run the
// net (the raw 41 channels, mask-free; the studio folds them in) or hand the crops back to the studio for a teach session.
// Nothing is posted unless the studio asked for it in that frame's message (`fnet`), so with the feature off a frame costs nothing.
import { extractCrops, newFaceCrops, type FaceCrops, type LM, type PlaneReader } from './crops.ts';
import { FaceNet, parseFaceNet } from './net.ts';
import type { Planes } from '../cpuFace/imageOps.ts';

/** fnet bits in a frame message */
export const FNET_RUN = 1, FNET_CAPTURE = 2;

export interface FaceNetOut {
  /** the net's 52 raw outputs (ARKIT order; only FACENET_CHANNELS are meaningful) when the run bit was set and a model is loaded */
  vals?: Float32Array;
  /** this frame's crops + features (copies the studio owns) when the capture bit was set */
  cap?: FaceCrops;
  /** why nothing came back for a wanted frame ('' = fine) */
  skip?: string;
  /** ms spent: the pixel reads, the crops and the net */
  ms: number;
}

export class FaceNetRuntime {
  private net: FaceNet | null = null;
  private modelKey = '';
  private crops = newFaceCrops();
  private vals = new Float32Array(52);
  error = '';
  /** Load (or clear, `json` = null) the model. A bad model leaves the runtime without one and says why in `error`. */
  setModel(json: string | null) {
    if (json === this.modelKey) return;
    this.modelKey = json ?? '';
    this.net = null; this.error = '';
    if (!json) return;
    try { this.net = parseFaceNet(json); } catch (e) { this.error = String((e as Error)?.message ?? e); }
  }
  get loaded() { return !!this.net; }
  /** `lm` = the 478 landmarks normalised to the frame `planes` describes (before any remap to the full camera frame). */
  step(bits: number, lm: ArrayLike<LM>, planes: Planes | PlaneReader): FaceNetOut | null {
    if (!bits) return null;
    const run = !!(bits & FNET_RUN) && !!this.net, cap = !!(bits & FNET_CAPTURE);
    if (!run && !cap) return { skip: this.error || 'no model', ms: 0 };
    const t0 = performance.now();
    if (!extractCrops(lm, planes, this.crops)) return { skip: 'face not fully in view', ms: performance.now() - t0 };
    const out: FaceNetOut = { ms: 0 };
    if (cap) { const c = this.crops; out.cap = { eyeL: c.eyeL.slice(), eyeR: c.eyeR.slice(), mouth: c.mouth.slice(), fEyeL: c.fEyeL.slice(), fEyeR: c.fEyeR.slice(), fMouth: c.fMouth.slice() }; }
    if (run) { this.net!.predictAll(this.crops, this.vals); out.vals = this.vals.slice(); }
    out.ms = performance.now() - t0;
    return out;
  }
}
