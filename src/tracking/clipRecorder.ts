// Guided expression test clip: records the camera (+ mic) while prompting a fixed script of
// expressions, and logs every tracked frame (landmarks, blendshapes, head matrix) with labels.
// Uploaded to the local server (cache/diag/clip.*) so the solver can be tuned against real faces —
// beards, glasses, lighting — offline and repeatably.

import type { RawTracking } from './Tracker.ts';

export interface ClipStep { label: string; seconds: number; say: string }

export const CLIP_SCRIPT: ClipStep[] = [
  { label: 'neutral', seconds: 3, say: 'Relax your face and look at the camera' },
  { label: 'talk', seconds: 7, say: 'Read aloud: “The quick brown fox jumps over the lazy dog. Peter Piper picked a peck of pickled peppers.”' },
  { label: 'smile', seconds: 3, say: 'Smile (mouth closed)' },
  { label: 'grin', seconds: 3, say: 'BIG open-mouth grin 😁' },
  { label: 'aa', seconds: 2.5, say: 'Say “AAAAH” (wide open)' },
  { label: 'ee', seconds: 2.5, say: 'Say “EEEEE”' },
  { label: 'oo', seconds: 2.5, say: 'Say “OOOOO”' },
  { label: 'oh', seconds: 2.5, say: 'Say “OH!” (round, open)' },
  { label: 'mbp', seconds: 3.5, say: 'Say “mama, baba, papa”' },
  { label: 'fv', seconds: 3, say: 'Say “five fluffy voices”' },
  // held consonants (viseme engine: tools/eval_visemes.ts)
  { label: 'v_ff', seconds: 2, say: 'Hold “fffff”' },
  { label: 'v_ll', seconds: 2, say: 'Hold “lllll”' },
  { label: 'v_sh', seconds: 2, say: 'Hold “shhhhh”' },
  { label: 'v_ss', seconds: 2, say: 'Hold “sssss”' },
  { label: 'v_th', seconds: 2, say: 'Hold “thhhh”' },
  { label: 'v_rr', seconds: 2, say: 'Hold “rrrrr”' },
  { label: 'v_ww', seconds: 2, say: 'Say “www-www-www”' },
  { label: 'sad', seconds: 3, say: 'Sad face 😢 (frown, brows up in the middle)' },
  { label: 'angry', seconds: 3, say: 'Angry face 😠 (brows down, frown)' },
  { label: 'surprised', seconds: 3, say: 'Surprised! 😲 (brows up, mouth open)' },
  { label: 'pucker', seconds: 2.5, say: 'Kiss face / pucker 😗' },
  { label: 'puff', seconds: 2.5, say: 'Puff your cheeks 🐡' },
  { label: 'shift', seconds: 3, say: 'Slide your mouth to your LEFT, then RIGHT' },
  { label: 'smirk', seconds: 2.5, say: 'Smirk — one side of your mouth only' },
  { label: 'tongue', seconds: 2.5, say: 'Stick your tongue out 😛' },
  { label: 'blink', seconds: 3, say: 'Blink slowly three times' },
  { label: 'winkL', seconds: 2, say: 'Wink your LEFT eye' },
  { label: 'winkR', seconds: 2, say: 'Wink your RIGHT eye' },
  { label: 'gaze', seconds: 4, say: 'Eyes only: look left, right, up, down' },
  { label: 'head', seconds: 4, say: 'Turn your head left, right, nod up and down' },
  // metric head position (tools/eval_face.ts): depth + sideways travel without turning the head
  { label: 'lean', seconds: 4, say: 'Keep facing the screen: lean IN close, back, then slide LEFT and RIGHT' },
  { label: 'neutral_end', seconds: 2, say: 'Back to neutral — done soon!' },
];

interface FrameRec { t: number; label: string; bs: Record<string, number> | null; lm: number[] | null; mat: number[] | null; w: number; h: number }

export class ClipRecorder {
  active = false;
  label = '';
  private frames: FrameRec[] = [];
  private t0 = 0;

  constructor(private upload: (name: string, body: Blob | string) => Promise<unknown>) {}

  /** Called by the app for every processed tracking frame. */
  onFrame(raw: RawTracking) {
    if (!this.active) return;
    const f = raw.face;
    const lm = f?.faceLandmarks?.[0];
    const bs = f?.faceBlendshapes?.[0]?.categories;
    this.frames.push({
      t: +(performance.now() / 1000 - this.t0).toFixed(3),
      label: this.label,
      bs: bs ? Object.fromEntries(bs.map((c) => [c.categoryName, +c.score.toFixed(4)])) : null,
      lm: lm ? lm.flatMap((p) => [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)]) : null,
      mat: f?.facialTransformationMatrixes?.[0]?.data ? Array.from(f.facialTransformationMatrixes[0].data, (x) => +x.toFixed(4)) : null,
      w: raw.width, h: raw.height,
    });
  }

  async record(video: MediaStream | null, mic: MediaStream | null, onStep: (s: ClipStep | null, remaining: number, i: number) => void) {
    this.frames = [];
    this.active = true;
    this.t0 = performance.now() / 1000;
    let rec: MediaRecorder | null = null;
    const chunks: Blob[] = [];
    if (video) {
      const tracks = [...video.getVideoTracks(), ...(mic?.getAudioTracks() ?? [])];
      const stream = new MediaStream(tracks);
      const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.start(1000);
    }
    const marks: { label: string; start: number; end: number }[] = [];
    for (let i = 0; i < CLIP_SCRIPT.length; i++) {
      const s = CLIP_SCRIPT[i];
      this.label = s.label;
      const start = performance.now() / 1000 - this.t0;
      const end = start + s.seconds;
      while (performance.now() / 1000 - this.t0 < end) {
        onStep(s, end - (performance.now() / 1000 - this.t0), i);
        await new Promise((r) => setTimeout(r, 100));
      }
      marks.push({ label: s.label, start: +start.toFixed(3), end: +end.toFixed(3) });
    }
    this.active = false;
    onStep(null, 0, CLIP_SCRIPT.length);
    if (rec) { await new Promise<void>((r) => { rec!.onstop = () => r(); rec!.stop(); }); }
    const meta = { recordedAt: new Date().toISOString(), marks, frameCount: this.frames.length, ua: navigator.userAgent };
    await this.upload('clip.json', JSON.stringify(meta));
    await this.upload('clip-frames.json', JSON.stringify(this.frames));
    if (chunks.length) await this.upload('clip.webm', new Blob(chunks, { type: 'video/webm' }));
    return meta;
  }
}
