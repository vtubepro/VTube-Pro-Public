// "My face model": the shared data shapes (types only; docs/FACE_MODEL.md).

/** Where a frame's teacher scores came from, best to weakest:
 *  'arkit'    a phone's real ARKit TrueDepth blendshapes (externalSource.ts) — the gold standard, the performer's own face.
 *  'maxine'   NVIDIA Maxine's 52 scores (gpuVision.ts), percentile-mapped into MediaPipe's range — good, GPU-only.
 *  'prompted' guided-prompt targets ("close your eyes" -> eyeBlink 1, "open wide" -> jawOpen 1 ...) merged with calibrated
 *             MediaPipe values for every channel the prompt does not pin. The WEAKEST teacher: it can only be as good as
 *             MediaPipe on the channels nobody prompted, so a net trained on it mostly learns the prompted extremes
 *             and the held-out gate (evaluate.ts) is what decides whether it is used at all. */
export type TeacherKind = 'arkit' | 'maxine' | 'prompted';

/** One teach-session frame. The crops and features are kept in RAM only for the session (they are the performer's face);
 *  only the trained weights are ever stored. */
export interface FaceFrame {
  /** seconds, monotonic within a session (the time-block split cuts on it) */
  t: number;
  eyeL: Float32Array; eyeR: Float32Array; mouth: Float32Array;
  fEyeL: Float32Array; fEyeR: Float32Array; fMouth: Float32Array;
  /** MediaPipe's own 52 scores for this frame, in the range the studio would otherwise use (after calibration): the baseline
   *  the net must beat on held-out frames. */
  mp: Float32Array;
  /** the teacher's 52 scores (0..1, ARKIT order) or null when the teacher had no reading (such frames are skipped) */
  teacher: Float32Array | null;
  teacherKind: TeacherKind | null;
}
