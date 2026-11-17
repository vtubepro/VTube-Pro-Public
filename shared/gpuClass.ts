// Which graphics cards can run Audio2Face-3D lip sync (the GPU sidecar, tools/gpu/a2f_sidecar.py: onnxruntime-gpu on CUDA 13),
// and how sure we are. Pure (shared by the server's nvidia-smi probe, the setup, the studio's GPU cards and the lip-sync advisor).
//
//   'measured'  RTX 50-series (Blackwell). Built and timed on an RTX 5090 (docs/GPU_TRACKING.md); smaller 50-series cards are estimates.
//   'untested'  RTX 20 / 30 / 40-series (and RTX A / RTX Ada workstation cards). The CUDA 13 runtime the sidecar installs supports
//               compute capability 7.5 and newer, which is every one of these (Turing, Ampere, Ada), and the network is a plain
//               convolution / GRU model, so it should run. Nobody has run it on one: the studio offers it with an honest note and
//               never turns it on by itself.
//   'none'      anything else (GTX 16 and older, AMD, Intel, no NVIDIA card): the browser engine (src/tracking/neuralVisemes.ts) does the job.
export type A2fSupport = 'measured' | 'untested' | 'none';
export interface GpuClass {
  nvidia: boolean;
  name: string;
  /** 20 / 30 / 40 / 50 = the RTX generation, null when it is not an RTX card */
  series: 20 | 30 | 40 | 50 | null;
  rtx50: boolean;
  a2f: A2fSupport;
  /** one plain sentence for the UI */
  note: string;
}

/** Audio2Face needs about 1.1 GB of video memory next to everything else on the card. */
export const A2F_MIN_VRAM_MB = 4096;
/** The driver the CUDA 13 runtime needs. */
export const A2F_MIN_DRIVER = 580;

export function classifyGpu(name: string, vramMB = 0): GpuClass {
  const n = (name ?? '').trim();
  const nvidia = /nvidia|geforce|quadro|\brtx\b|\bgtx\b|tesla/i.test(n);
  const base = { nvidia, name: n };
  if (!nvidia) return { ...base, series: null, rtx50: false, a2f: 'none', note: 'No NVIDIA graphics card was found, so the browser lip sync is used.' };
  // The generation comes from the card's FAMILY, never from the digits alone: workstation numbers collide with GeForce ones
  // ("RTX 5000 Ada" is an Ada card, "RTX A5000" is Ampere, "Quadro RTX 5000" is Turing; none of them is a 50-series).
  // Order matters: the workstation markers first, then Blackwell, then GeForce RTX 20 / 30 / 40 / 50 (laptop variants included).
  let series: GpuClass['series'] = null;
  const gf = /\bGeForce\s+RTX\s*(20|30|40|50)\d{2}\b/i.exec(n);
  if (/\bAda\b/i.test(n)) series = 40;                              // RTX 2000 / 4000 / 4500 / 5000 / 5880 / 6000 Ada (also "SFF")
  else if (/\bRTX\s*A\d{3,4}\b/i.test(n)) series = 30;           // RTX A2000 ... A6000 = Ampere
  else if (/\bQuadro\s+RTX\b|\bTITAN\s+RTX\b/i.test(n)) series = 20;  // Turing workstation / Titan
  else if (/\bBlackwell\b/i.test(n)) series = 50;                  // RTX PRO nnnn Blackwell, B-series
  else if (gf) series = Number(gf[1]) as 20 | 30 | 40 | 50;
  const rtx50 = series === 50;
  if (rtx50) return { ...base, series, rtx50, a2f: 'measured', note: 'NVIDIA RTX 50-series: tested (RTX 5090).' };
  if (series && (vramMB === 0 || vramMB >= A2F_MIN_VRAM_MB)) {
    return { ...base, series, rtx50, a2f: 'untested', note: `${n}: should work (its CUDA runtime is supported), but it has not been tested on this card. VTube Pro was measured on an RTX 5090.` };
  }
  if (series) return { ...base, series, rtx50, a2f: 'none', note: `${n} has less than ${A2F_MIN_VRAM_MB / 1024} GB of video memory, which GPU lip sync needs.` };
  return { ...base, series: null, rtx50: false, a2f: 'none', note: `${n} is not an RTX card, so GPU lip sync is not offered (the browser lip sync is used).` };
}

/** What the studio shows for GPU lip sync on this card: can it be switched on, may it switch itself on, and the line to show. */
export interface A2fOffer { available: boolean; auto: boolean; untested: boolean; note: string }
export function a2fOffer(c: Pick<GpuClass, 'a2f' | 'note'> | null | undefined, have: { a2fModel?: boolean; venv?: boolean } | null | undefined): A2fOffer {
  if (!c || c.a2f === 'none') return { available: false, auto: false, untested: false, note: c?.note ?? '' };
  const installed = !!have?.a2fModel && !!have?.venv;
  const untested = c.a2f === 'untested';
  return {
    available: true,
    // only a measured card with the files already installed is switched on by itself; an untested card is always the user's call
    auto: !untested && installed,
    untested,
    note: untested ? `${c.note} Turn it on to try it; the browser lip sync stays as the fallback.` : c.note,
  };
}
