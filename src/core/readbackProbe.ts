// Can this browser's pixel and audio READBACKS be trusted? Anti-fingerprinting (Brave Shields "Block fingerprinting",
// other privacy browsers and add-ons) changes what canvas getImageData, WebGL readPixels and Web Audio sample reads
// return: a few pixels nudged, samples scaled or (in stricter set-ups) noise added. The studio reads camera pixels (the
// mouth-interior patch: tongue / teeth / is the mouth hidden; the facial-hair detector) and microphone samples (lip sync
// starts on "the analyser has real sound"). Instead of guessing the browser, the studio draws / plays something it knows
// once at start-up, reads it back and measures the difference:
//   * pixels: a nudge of a level or two on a few pixels is harmless (both analyses average patches and use wide colour
//     bands); more than that and the mouth-patch analyses switch off (the face model's own mouth shapes carry on);
//   * audio: an exact or uniformly scaled read is harmless (levels adapt); added noise raises the "digital silence"
//     test above the noise, so silence never reads as speech.
// The same rules hold in every browser (feature detection, no browser sniffing). Pure parts are tested in
// tools/browser_ui_unit.ts.

export interface PixelNoise { maxDiff: number; changed: number; total: number }
export type AudioKind = 'exact' | 'scaled' | 'noisy' | 'unknown';
export interface AudioReadback { kind: AudioKind; noise: number }

/** How far `got` is from `want` (RGBA bytes). */
export function pixelNoise(got: ArrayLike<number>, want: ArrayLike<number>): PixelNoise {
  const n = Math.min(got.length, want.length);
  let maxDiff = 0, changed = 0;
  for (let i = 0; i < n; i++) { const d = Math.abs(got[i] - want[i]); if (d) { changed++; if (d > maxDiff) maxDiff = d; } }
  if (got.length !== want.length) { changed += Math.abs(got.length - want.length); maxDiff = Math.max(maxDiff, 255); }
  return { maxDiff, changed, total: Math.max(got.length, want.length) };
}

/** Pixels good enough for the mouth-patch analyses (null = not measured: trust them, as before). */
export function pixelsTrustworthy(n: PixelNoise | null): boolean {
  if (!n || !n.total) return true;
  return n.maxDiff <= 3 && n.changed / n.total <= 0.15;
}

/** A constant `expected` signal read back: exact, scaled by one factor, or with noise added. */
export function audioReadback(samples: ArrayLike<number> | null, expected: number): AudioReadback {
  if (!samples || !samples.length) return { kind: 'unknown', noise: 0 };
  let mean = 0;
  for (let i = 0; i < samples.length; i++) mean += samples[i];
  mean /= samples.length;
  let dev = 0;
  for (let i = 0; i < samples.length; i++) dev = Math.max(dev, Math.abs(samples[i] - mean));
  if (dev > 1e-6) return { kind: 'noisy', noise: dev };
  return { kind: Math.abs(mean - expected) <= 1e-6 ? 'exact' : 'scaled', noise: 0 };
}

/** The amplitude a sample must pass to count as "real sound" (0 = any non-zero sample, the old rule). */
export function silenceThreshold(a: AudioReadback): number {
  return a.kind === 'noisy' ? Math.min(0.02, a.noise * 4) : 0;
}

export interface ReadbackReport { canvas: PixelNoise | null; webgl: PixelNoise | null; audio: AudioReadback; done: boolean }
/** What the probe found (filled in once, shortly after start-up). */
export const readback: ReadbackReport = { canvas: null, webgl: null, audio: { kind: 'unknown', noise: 0 }, done: false };
/** Camera-pixel analyses may run (the probe hasn't found heavy noise). */
export const cameraPixelsOk = () => pixelsTrustworthy(readback.canvas);

const COLOURS: [number, number, number][] = [[51, 102, 153], [200, 30, 90], [12, 240, 64], [255, 255, 255]];

function probeCanvas(): PixelNoise | null {
  try {
    const c = document.createElement('canvas'); c.width = c.height = 8;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    const want = new Uint8ClampedArray(8 * 8 * 4);
    COLOURS.forEach(([r, gg, b], q) => {
      const x0 = (q % 2) * 4, y0 = Math.floor(q / 2) * 4;
      g.fillStyle = `rgb(${r},${gg},${b})`; g.fillRect(x0, y0, 4, 4);
      for (let y = y0; y < y0 + 4; y++) for (let x = x0; x < x0 + 4; x++) want.set([r, gg, b, 255], (y * 8 + x) * 4);
    });
    return pixelNoise(g.getImageData(0, 0, 8, 8).data, want);
  } catch { return null; }
}

function probeWebgl(): PixelNoise | null {
  try {
    const c = document.createElement('canvas'); c.width = c.height = 4;
    const gl = c.getContext('webgl2');
    if (!gl) return null;
    gl.clearColor(0.2, 0.4, 0.6, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const got = new Uint8Array(4 * 4 * 4);
    gl.readPixels(0, 0, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, got);
    const want = new Uint8Array(got.length);
    for (let i = 0; i < want.length; i += 4) want.set([51, 102, 153, 255], i);
    const n = pixelNoise(got, want);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return n;
  } catch { return null; }
}

async function probeAudio(): Promise<AudioReadback> {
  try {
    const Ctx = (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
    if (!Ctx) return { kind: 'unknown', noise: 0 };
    const ctx = new Ctx(1, 512, 44100); // rendered offline: never audible
    const src = ctx.createConstantSource(); src.offset.value = 0.5; src.connect(ctx.destination); src.start();
    const buf = await ctx.startRendering();
    return audioReadback(buf.getChannelData(0).subarray(64, 448), 0.5);
  } catch { return { kind: 'unknown', noise: 0 }; }
}

let started: Promise<ReadbackReport> | null = null;
/** Run the probe once (cheap: an 8 x 8 canvas, a 4 x 4 WebGL clear, 512 silent offline samples). */
export function probeReadback(): Promise<ReadbackReport> {
  started ??= (async () => {
    readback.canvas = probeCanvas();
    readback.webgl = probeWebgl();
    readback.audio = await probeAudio();
    readback.done = true;
    const odd = !pixelsTrustworthy(readback.canvas) || !pixelsTrustworthy(readback.webgl) || readback.audio.kind === 'noisy';
    if (odd) console.warn('[vtube-pro] this browser changes canvas / WebGL / audio reads (anti-fingerprinting): the studio works around it', readback);
    return readback;
  })();
  return started;
}
