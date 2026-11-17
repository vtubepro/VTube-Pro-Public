// "Best lip sync for me" + the general "Hardware check": the pure logic (no DOM, no I/O). The studio's guide
// (src/ui/lipsyncGuide.ts) gathers the facts — the avatar's mouth (model-onboarding's faceCaps), this computer (ai-local's
// consented scan, or what the browser can tell), the mic, the camera, the helper and the GPU helpers — and this file
// turns them into a plain recommendation: Basic / Good / Best, what each option needs, what it costs on THIS computer,
// and the exact limits to show when someone picks more than the computer comfortably handles ("Use it anyway" /
// "Pick the safe option"). The same pattern checks the other heavy features (graphics quality, GPU tracking, local AI).
// Also the guided test's scoring ("Say these words": did the mic hear you, did the mouth follow, which shapes showed).
// Unit tests: tools/lipsync_unit.ts. Words follow T\portal\ux\VOICE.md (short, plain, no jargon on the main path).
import { budgetOf, type GpuInfo, type HwInfo } from './localAi/recommend.ts';
import { classifyGpu } from './gpuClass.ts';

// ================================================================ facts

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'other';
export interface GpuFact {
  name: string;
  vendor: GpuVendor;
  /** Dedicated video memory (GB). null = unknown (browser-only facts) or shared memory. */
  vramGB: number | null;
  /** true when vramGB is a guess from the card's name (browser-only facts). */
  vramGuess?: boolean;
  integrated?: boolean;
  /** Apple Silicon: the GPU shares the computer's memory. */
  unified?: boolean;
}

export interface MachineFacts {
  /** 'scan' = the helper's read-only scan (the user said yes); 'browser' = only what this browser tells every page. */
  source: 'scan' | 'browser';
  os: 'windows' | 'mac' | 'linux' | 'other';
  /** Logical processors (threads). */
  cores: number;
  /** Total memory (GB). Browser-only: navigator.deviceMemory (rounded, capped at 8) or null. */
  ramGB: number | null;
  gpu: GpuFact | null;
  /** The browser can draw 3D with WebGL 2 (face tracking + the avatar need it). */
  webgl2: boolean;
  /** The WebGL renderer string (or '' when the browser hides it). */
  renderer: string;
  /** The browser draws with a software renderer (SwiftShader / llvmpipe): very slow. */
  softwareGl: boolean;
  /** WebGPU is available in this browser (null = not checked). Informational: nothing in the studio needs it today. */
  webgpu: boolean | null;
}

/** What the avatar's mouth can do (model-onboarding's faceCaps, src/onboarding/modelCheck.ts). */
export interface AvatarFacts {
  name: string;
  /** shapes = its own ARKit mouth shapes · vowels = A I U E O presets · jaw = a jaw bone · drawn = VTube Pro's mouth · none */
  mouth: 'shapes' | 'vowels' | 'jaw' | 'drawn' | 'none';
  vowels: string[];
  /** It has a shape for closed lips (M / B / P). */
  seal: boolean;
  /** Number of own ARKit mouth shapes (mouth* + jawOpen). */
  mouthShapes: number;
  /** All 52 ARKit shapes ("perfect sync"). */
  perfectSync: boolean;
}
export interface MicFacts {
  on: boolean;
  label: string;
  /** A Bluetooth / hands-free headset mic (narrow, muffled sound). */
  bluetooth: boolean;
  /** The noise filter + voice model are running. */
  filterOn: boolean;
}
export interface CamFacts {
  on: boolean;
  width: number;
  height: number;
  fps: number;
  /** Face tracking updates per second right now (0 = unknown). */
  trackHz: number;
  /** Face model time per frame (ms, 0 = unknown). */
  faceMs: number;
  /** MediaPipe fell back to the processor (no GPU delegate). */
  cpuTracking: boolean;
}
export interface SidecarFacts {
  /** The helper found an NVIDIA card (nvidia-smi). */
  nvidia: boolean;
  /** …and it is an RTX 50-series card (what the GPU helpers are built for). */
  rtx50: boolean;
  gpuName: string;
  vramMB: number;
  /** The one-time GPU setup is done (its Python environment exists). */
  setUp: boolean;
  /** NVIDIA's own AR SDK (Maxine) is installed. */
  maxineSdk: boolean;
}
export interface SetupFacts {
  machine: MachineFacts;
  avatar: AvatarFacts | null;
  mic: MicFacts | null;
  camera: CamFacts | null;
  /** local = the studio runs on this computer (its server is the helper); none = browser only (paired is unused). */
  helper: 'local' | 'paired' | 'none';
  /** The GPU helpers' status (GET /api/gpu/status); null = unknown / no helper. */
  sidecars: SidecarFacts | null;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function vendorOf(name: string): GpuVendor {
  const n = name.toLowerCase();
  if (/nvidia|geforce|quadro|rtx|gtx|tesla/.test(n)) return 'nvidia';
  if (/\bamd\b|radeon|\bati\b|advanced micro devices/.test(n)) return 'amd';
  if (/intel|\barc\b|iris|uhd graphics|hd graphics/.test(n)) return 'intel';
  if (/apple|\bm[1-9]\b/.test(n)) return 'apple';
  return 'other';
}
function integratedName(name: string): boolean {
  const n = name.toLowerCase();
  if (/intel/.test(n)) return !/\barc\b/.test(n) || /arc\(tm\) graphics$|arc graphics$/.test(n);
  if (/radeon/.test(n)) return !/\brx\b|radeon pro|\bw\d{4}|vega (56|64)|radeon vii/.test(n);
  return false;
}

/** "ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 (0x00002B85) Direct3D11 vs_5_0 ps_5_0, D3D11)" → "NVIDIA GeForce RTX 5090". */
export function rendererName(renderer: string): string {
  const s = renderer.trim();
  const m = /^ANGLE \(([^,]+),\s*(.+?)(?:\s*\(0x[0-9a-f]+\))?(?:\s+(?:Direct3D|OpenGL|Vulkan)\S*.*)?(?:,\s*[^,]*)?\)$/i.exec(s);
  if (m) return m[2].replace(/^ANGLE Metal Renderer:\s*/i, '').replace(/\s+/g, ' ').trim();
  return s.replace(/\/PCIe\/SSE2$/i, '').trim();
}

/** A rough video-memory guess from a card's name (browser-only facts have no memory size). null = no idea. */
export function guessVram(name: string): number | null {
  const n = name.toLowerCase();
  let m = /rtx\s*(20|30|40|50)(\d)0\s*(ti|super)?/.exec(n);
  if (m) {
    const gen = Number(m[1]), tier = Number(m[2]);
    const table: Record<number, number> = { 5: 8, 6: gen >= 50 ? 8 : gen === 30 ? 12 : 8, 7: gen >= 50 ? 12 : gen === 40 ? 12 : 8, 8: gen >= 50 ? 16 : gen === 40 ? 16 : 10, 9: gen >= 50 ? 32 : 24 };
    return table[tier] ?? null;
  }
  m = /rx\s*(5|6|7|9)(\d)(\d)0\s*(xt|xtx)?/.exec(n);
  if (m) {
    const tier = Number(m[2]);
    return tier >= 9 ? 20 : tier >= 8 ? 16 : tier >= 7 ? 12 : tier >= 6 ? 8 : 4;
  }
  if (/gtx\s*16\d0/.test(n)) return 4;
  if (/gtx\s*10[67]0/.test(n)) return 6;
  if (/gtx\s*10[8]0/.test(n)) return 8;
  return null;
}

/** Facts from what any web page can read (no scan): cores, deviceMemory, the WebGL renderer, WebGPU. */
export function machineFromBrowser(b: { cores?: number; deviceMemory?: number | null; renderer?: string; webgl2?: boolean; webgpu?: boolean | null; platform?: string; ua?: string }): MachineFacts {
  const renderer = b.renderer ?? '';
  const name = rendererName(renderer);
  const softwareGl = /swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(renderer);
  const plat = `${b.platform ?? ''} ${b.ua ?? ''}`.toLowerCase();
  const os: MachineFacts['os'] = /win/.test(plat) ? 'windows' : /mac|iphone|ipad/.test(plat) ? 'mac' : /linux|x11|cros/.test(plat) ? 'linux' : 'other';
  let gpu: GpuFact | null = null;
  if (name && !softwareGl) {
    const vendor = vendorOf(name);
    const apple = vendor === 'apple' || /apple m\d/i.test(name);
    const integrated = integratedName(name);
    const v = apple || integrated ? null : guessVram(name);
    gpu = { name, vendor: apple ? 'apple' : vendor, vramGB: v, vramGuess: v !== null || undefined, integrated: integrated || undefined, unified: apple || undefined };
  }
  return {
    source: 'browser', os, cores: Math.max(1, Math.round(b.cores ?? 4)), ramGB: typeof b.deviceMemory === 'number' && b.deviceMemory > 0 ? b.deviceMemory : null,
    gpu, webgl2: b.webgl2 !== false, renderer, softwareGl, webgpu: b.webgpu ?? null,
  };
}

/** The helper's scan (ai-local, server/hwScan.ts, POST /api/local-ai/scan {consent:true}) + this browser's 3D facts. */
export function machineFromScan(hw: HwInfo, browser: Pick<MachineFacts, 'webgl2' | 'renderer' | 'softwareGl' | 'webgpu'>): MachineFacts {
  const p = pickGpu(hw.gpus);
  const gpu: GpuFact | null = p ? { name: p.name, vendor: p.vendor, vramGB: p.vramGB, integrated: p.integrated, unified: p.unified } : null;
  return {
    source: 'scan', os: hw.os === 'windows' || hw.os === 'linux' ? hw.os : hw.os === 'macos' ? 'mac' : 'other', cores: Math.max(1, hw.cpu.cores || 1), ramGB: hw.ramGB || null,
    gpu, webgl2: browser.webgl2, renderer: browser.renderer, softwareGl: browser.softwareGl, webgpu: browser.webgpu,
  };
}
function pickGpu(gpus: GpuInfo[]): GpuInfo | null {
  const real = gpus.filter((g) => g.vendor !== 'other');
  const dedicated = real.filter((g) => !g.integrated && !g.unified);
  if (dedicated.length) return dedicated.reduce((a, b) => ((b.vramGB ?? 0) > (a.vramGB ?? 0) ? b : a));
  return real.find((g) => g.unified) ?? real[0] ?? null;
}
/** Back to ai-local's shape (for its memory budget: budgetOf). */
export function hwOf(m: MachineFacts): HwInfo {
  const g = m.gpu;
  return {
    os: m.os === 'mac' ? 'macos' : m.os, osName: m.os, arch: '', cpu: { model: '', cores: m.cores }, ramGB: m.ramGB ?? 8,
    gpus: g ? [{ name: g.name, vendor: g.vendor, vramGB: g.vramGB, integrated: g.integrated, unified: g.unified, source: m.source }] : [], diskFreeGB: null, notes: [],
  };
}

// ================================================================ how strong is this computer (for live streaming)

export type MachineClass = 'low' | 'mid' | 'high';
export interface MachineRead { cls: MachineClass; /** plain reasons, one per line */ why: string[]; /** dedicated (or Apple) graphics with room to spare */ strongGpu: boolean }

export function readMachine(m: MachineFacts): MachineRead {
  const why: string[] = [];
  const g = m.gpu;
  const vram = g?.vramGB ?? null;
  const strongGpu = !!g && !g.integrated && !m.softwareGl && (
    (g.unified ? (m.ramGB ?? 0) >= 16 : (g.vendor === 'nvidia' || g.vendor === 'amd' || (g.vendor === 'intel' && /\barc\b/i.test(g.name))) && (vram === null ? /rtx|rx\s*[6-9]\d{3}|arc a7/i.test(g.name) : vram >= 8)));
  let weak = false;
  if (!m.webgl2) { weak = true; why.push('This browser can’t draw 3D well. Try Chrome or Edge.'); }
  if (m.softwareGl) { weak = true; why.push('Your browser is drawing without the graphics card.'); }
  if (m.cores <= 4) { weak = true; why.push(`Your processor has ${m.cores} threads. 8 or more is comfortable.`); }
  if (m.ramGB !== null && m.ramGB < 8 && m.source === 'scan') { weak = true; why.push(`Your computer has ${Math.round(m.ramGB)} GB of memory. 16 GB is comfortable.`); }
  if (!g) why.push(m.source === 'browser' ? 'We couldn’t see your graphics card from the browser.' : 'We didn’t find a graphics card.');
  else if (g.integrated) why.push(`${g.name} is built into the processor. It shares memory with everything else.`);
  else if (strongGpu) why.push(`${g.name}${vram ? ` with ${g.vramGuess ? 'about ' : ''}${vram} GB` : ''} has room for extras.`);
  else why.push(`${g.name}${vram ? ` (${vram} GB)` : ''} is fine for the basics.`);
  const cls: MachineClass = weak ? 'low' : strongGpu && m.cores >= 8 ? 'high' : 'mid';
  if (!weak && cls === 'mid' && m.cores < 8) why.push(`Your processor has ${m.cores} threads. 8 or more leaves room while you game.`);
  return { cls, why, strongGpu };
}

// ================================================================ lip-sync options

export type LipTier = 'basic' | 'good' | 'best';
export const TIERS: LipTier[] = ['basic', 'good', 'best'];
export type Fit = 'ok' | 'stretch' | 'blocked';
/** What fixes a blocked option: turn on the mic / camera, open the helper, run the GPU setup, fix the model. */
export type Fix = 'mic' | 'camera' | 'helper' | 'gpu-setup' | 'model';
export type OptionId = 'voice' | 'filter' | 'voiceModel' | 'onTime' | 'personal' | 'natural' | 'mouthDetail' | 'gpuLipSync' | 'tracking';

export interface LipOption {
  id: OptionId;
  name: string;
  /** One plain sentence: what you get. */
  what: string;
  /** The lowest tier that includes it. */
  tier: LipTier;
  /** Always worth knowing (not a hardware problem). */
  notes?: string[];
  /** The technical name, for the Details fold only. */
  tech: string;
}

export const OPTIONS: LipOption[] = [
  { id: 'voice', tier: 'basic', name: 'Mouth follows your voice', what: 'Your mic opens and closes the mouth on every word.', tech: 'Audio lip sync: loudness envelope + MFCC vowels + fricative detectors (src/tracking/audioLipSync.ts)' },
  { id: 'filter', tier: 'basic', name: 'Noise filter', what: 'Only your voice moves the mouth, not the fan or keyboard.', tech: 'Voice front-end: 80 Hz high-pass → RNNoise → Silero voice gate (src/audio/voice/voiceFrontEnd.ts), ≈ 4 % of one core' },
  { id: 'voiceModel', tier: 'basic', name: 'Sound shapes', what: 'A small voice model shapes P, F, OO and EE on the lips.', tech: 'Neural visemes, fast model (≈ 150 k parameters, ≈ 1 % of one core; src/tracking/neuralVisemes.ts)' },
  { id: 'tracking', tier: 'basic', name: 'Face tracking quality', what: 'How much detail the camera reads from your face.', tech: 'MediaPipe quality tier low / medium / high / ultra (vtp.tier; src/tracking/Tracker.ts)' },
  { id: 'onTime', tier: 'good', name: 'Shapes land on time', what: 'Lips close and round just before each sound, like a real mouth.',
    notes: ['You delay your mic by 60 ms in OBS, once. We show you how.', 'Friends in a party hear you a moment before your mouth moves.'],
    tech: 'Lip-sync lookahead 60 ms (100 ms with GPU lip sync; full voice model from 80 ms) + OBS mic Sync Offset (src/tracking/lipLookahead.ts)' },
  { id: 'personal', tier: 'good', name: 'Tuned to your voice', what: 'A 45-second test teaches it how you talk and smile.',
    notes: ['Copy the faces and sounds on screen. It is saved for you, not per avatar.'],
    tech: 'Guided setup: speaking profile, vowel + consonant profile, personal neural layer (Go Live → the 45-second test)' },
  { id: 'natural', tier: 'good', name: 'Natural mode', what: 'Small, real smiles show without acting for the camera.', tech: 'Natural capture: per-person neutral + expression range (src/tracking/naturalCapture.ts)' },
  { id: 'mouthDetail', tier: 'best', name: 'Teeth and tongue', what: 'The camera also looks inside your mouth for teeth and tongue.', tech: 'Mouth-interior image analysis in the face worker (vtp.mouthImage; src/tracking/mouthImage.ts); turns itself off when the face model is slower than 20 ms' },
  { id: 'gpuLipSync', tier: 'best', name: 'GPU lip sync', what: 'Your graphics card moves the whole mouth like a real face.',
    notes: ['Runs in VTube Pro on your computer.'],
    tech: 'NVIDIA Audio2Face-3D sidecar (tools/gpu/a2f_sidecar.py, ws://127.0.0.1:5197; docs/GPU_TRACKING.md): RTX 50-series, ≈ 1.1 GB VRAM' },
];
export const optionById = (id: OptionId) => OPTIONS.find((o) => o.id === id)!;
const RANK: Record<LipTier, number> = { basic: 0, good: 1, best: 2 };
export const optionsIn = (t: LipTier) => OPTIONS.filter((o) => RANK[o.tier] <= RANK[t]);

export interface OptionCheck {
  id: OptionId;
  fit: Fit;
  /** Exact limits on THIS computer (stretch) or what is missing (blocked). Plain sentences. */
  limits: string[];
  fix?: Fix;
}

export type TrackTier = 'low' | 'medium' | 'high' | 'ultra';
const TRACK_RANK: Record<TrackTier, number> = { low: 0, medium: 1, high: 2, ultra: 3 };
/** The tracking quality a tier asks for on this machine class. */
export function trackingFor(tier: LipTier, cls: MachineClass): TrackTier {
  const own: TrackTier = cls === 'high' ? 'high' : cls === 'mid' ? 'medium' : 'low';
  if (tier === 'basic') return own;
  if (tier === 'good') return TRACK_RANK[own] >= 1 ? own : 'medium';
  return 'high';
}

/** Is this option OK on this setup, for this tier? */
export function checkOption(id: OptionId, f: SetupFacts, tier: LipTier = 'best', read = readMachine(f.machine)): OptionCheck {
  const mic = !!f.mic?.on, cam = !!f.camera?.on;
  const L: string[] = [];
  const out = (fit: Fit, fix?: Fix): OptionCheck => ({ id, fit, limits: L, fix });
  switch (id) {
    case 'voice':
      if (!mic) { L.push('Turn on your microphone first.'); return out('blocked', 'mic'); }
      if (f.mic?.bluetooth) L.push('Bluetooth headset mics sound muffled, so the mouth is less exact.', 'A wired or USB mic is better.');
      return out(L.length ? 'stretch' : 'ok');
    case 'filter':
      if (!mic) { L.push('Needs your microphone.'); return out('blocked', 'mic'); }
      if (read.cls === 'low') L.push('Uses a little more of your processor.', 'On a busy computer it may stutter while you game.');
      return out(L.length ? 'stretch' : 'ok');
    case 'voiceModel':
      if (!mic) { L.push('Needs your microphone.'); return out('blocked', 'mic'); }
      return out('ok');
    case 'onTime':
      if (!mic) { L.push('Needs your microphone.'); return out('blocked', 'mic'); }
      return out('ok');
    case 'personal':
      if (!mic && !cam) { L.push('Needs your camera and microphone.'); return out('blocked', 'camera'); }
      if (!cam) { L.push('Needs your camera.'); return out('blocked', 'camera'); }
      if (!mic) { L.push('Needs your microphone.'); return out('blocked', 'mic'); }
      return out('ok');
    case 'natural':
      return out('ok');
    case 'tracking': {
      const want = trackingFor(tier, read.cls);
      const own = trackingFor('basic', read.cls);
      if (TRACK_RANK[want] > TRACK_RANK[own]) L.push('Face tracking may lag on stream.', 'It uses more of your graphics card while you game.');
      if (f.camera?.on && f.camera.cpuTracking) L.push('Face tracking runs on your processor right now, not the graphics card.');
      return out(L.length ? 'stretch' : 'ok');
    }
    case 'mouthDetail':
      if (read.cls === 'low') L.push('Your computer is already busy with face tracking.', 'It switches itself off when tracking slows, so you may not see it.');
      else if (cam && (f.camera!.cpuTracking || f.camera!.faceMs >= 15)) L.push('Your face tracking is already slow right now.', 'It switches itself off when tracking slows, so you may not see it.');
      else if (read.cls === 'mid') L.push('May lag on stream while you game.');
      return out(L.length ? 'stretch' : 'ok');
    case 'gpuLipSync': {
      if (f.helper === 'none') { L.push('Needs VTube Pro on your computer.'); return out('blocked', 'helper'); }
      const s = f.sidecars;
      const g = f.machine.gpu;
      const nvidia = s ? s.nvidia : g?.vendor === 'nvidia';
      const rtx50 = s ? s.rtx50 : !!g && classifyGpu(g.name).rtx50;
      if (!nvidia || !rtx50) { L.push('Needs an NVIDIA RTX 50-series graphics card.'); return out('blocked'); }
      if (!mic) { L.push('Needs your microphone.'); return out('blocked', 'mic'); }
      if (s && !s.setUp) { L.push('Needs a one-time setup first (a large download).'); return out('blocked', 'gpu-setup'); }
      const name = s?.gpuName || g?.name || '';
      const vramGB = s ? s.vramMB / 1024 : g?.vramGB ?? 0;
      if (/50[56]0/.test(name) || (vramGB > 0 && vramGB < 12)) L.push('Uses a lot of graphics power while gaming.', 'May lag on stream if your game needs the whole card.');
      if (f.avatar && f.avatar.mouth !== 'shapes') L.push('Your model has only simple mouth shapes, so this adds less.');
      return out(L.length ? 'stretch' : 'ok');
    }
  }
}

// ================================================================ tiers + the recommendation

export interface TierReport {
  tier: LipTier;
  /** Options this tier switches on that work here (ok or stretch). */
  applied: OptionId[];
  /** Options this tier would use that can't run here, with why (they are left out). */
  skipped: { id: OptionId; why: string; fix?: Fix }[];
  /** Options that run, but past what this computer comfortably handles: the exact limits. */
  stretch: { id: OptionId; limits: string[] }[];
}
export interface Recommendation {
  tier: LipTier;
  machine: MachineRead;
  /** Plain reasons for the pick. */
  why: string[];
  tiers: Record<LipTier, TierReport>;
  /** Things to fix first (no mic, no mouth on the model …). */
  first: { fix: Fix; text: string }[];
}

export function tierReport(tier: LipTier, f: SetupFacts, read = readMachine(f.machine)): TierReport {
  const rep: TierReport = { tier, applied: [], skipped: [], stretch: [] };
  for (const o of optionsIn(tier)) {
    const c = checkOption(o.id, f, tier, read);
    if (c.fit === 'blocked') { rep.skipped.push({ id: o.id, why: c.limits[0] ?? '', fix: c.fix }); continue; }
    rep.applied.push(o.id);
    if (c.fit === 'stretch') rep.stretch.push({ id: o.id, limits: c.limits });
  }
  return rep;
}

export function recommend(f: SetupFacts): Recommendation {
  const read = readMachine(f.machine);
  const tiers = { basic: tierReport('basic', f, read), good: tierReport('good', f, read), best: tierReport('best', f, read) };
  const why: string[] = [];
  const first: Recommendation['first'] = [];
  const mic = !!f.mic?.on;
  if (!mic) first.push({ fix: 'mic', text: 'Turn on your microphone. The mouth then follows your voice too.' });
  if (!f.camera?.on) first.push({ fix: 'camera', text: 'Turn on your camera. Your face drives the expressions.' });
  if (f.avatar?.mouth === 'none') first.push({ fix: 'model', text: 'Your model has no mouth shapes yet. We can add a drawn mouth.' });
  // the highest tier with nothing past this computer's comfort (a Bluetooth mic is a mic problem, not a tier problem)
  const comfy = (t: LipTier) => tiers[t].stretch.every((s) => s.id === 'voice');
  let tier: LipTier = 'basic';
  if (mic && comfy('good') && read.cls !== 'low') tier = 'good';
  if (tier === 'good' && comfy('best') && read.cls === 'high') tier = 'best';
  // tracking is struggling right now: one step down
  const slow = !!f.camera?.on && f.camera.trackHz > 0 && f.camera.trackHz < 20;
  if (slow && tier !== 'basic') { tier = tier === 'best' ? 'good' : 'basic'; why.push(`Face tracking is slow right now (${Math.round(f.camera!.trackHz)} updates a second), so we picked one step lower.`); }
  if (!mic) why.push('Without a microphone, only your camera moves the mouth. Basic is the right pick.');
  else if (read.cls === 'low') why.push('Your computer is on the lighter side. Basic keeps your stream smooth.');
  else if (tier === 'good') why.push(read.cls === 'high' ? 'Good is the sweet spot here.' : 'Your computer handles Good comfortably.');
  else if (tier === 'best') why.push('Your computer has room for everything.');
  if (tier === 'best' && tiers.best.skipped.some((s) => s.id === 'gpuLipSync')) why.push('GPU lip sync is left out: it needs an NVIDIA RTX 50-series card and VTube Pro.');
  if (f.avatar && f.avatar.mouth === 'vowels' && !f.avatar.seal) why.push(`${f.avatar.name} talks with vowel shapes. Lips can’t fully press for M, B and P.`);
  return { tier, machine: read, why, tiers, first };
}

// ================================================================ apply

/** What "Use Basic / Good / Best" changes. null = leave as it is. */
export interface LipPlan {
  tier: LipTier;
  /** Lip-sync lookahead (ms) = the mic delay in OBS. 0 = none. */
  lookaheadMs: number;
  /** Make sure the noise filter is on (Standard) when it is off. */
  filterOn: boolean;
  /** Voice model on (auto mix). */
  voiceModel: boolean;
  natural: boolean | null;
  mouthDetail: boolean;
  gpuLipSync: boolean;
  /** Face tracking quality to set (only raised for Good / Best; Basic may lower it to what fits). */
  tracking: TrackTier | null;
  /** Suggest the 45-second test afterwards. */
  runTest: boolean;
  skipped: TierReport['skipped'];
}

export function planFor(tier: LipTier, f: SetupFacts, current: { tracking?: TrackTier } = {}): LipPlan {
  const read = readMachine(f.machine);
  const rep = tierReport(tier, f, read);
  const on = (id: OptionId) => rep.applied.includes(id);
  const gpu = on('gpuLipSync');
  const want = trackingFor(tier, read.cls);
  let tracking: TrackTier | null = want;
  if (current.tracking) {
    const cur = TRACK_RANK[current.tracking], w = TRACK_RANK[want];
    // Good / Best never lower a quality the performer chose; Basic lowers only past what this computer handles
    if (tier !== 'basic' ? cur >= w : cur <= TRACK_RANK[trackingFor('basic', read.cls)]) tracking = null;
    if (cur === w) tracking = null;
  }
  return {
    tier,
    lookaheadMs: on('onTime') ? (gpu ? 100 : 60) : 0,
    filterOn: on('filter'),
    voiceModel: on('voiceModel'),
    natural: tier === 'basic' ? null : on('natural') ? true : null,
    mouthDetail: on('mouthDetail'),
    gpuLipSync: gpu,
    tracking,
    runTest: on('personal'),
    skipped: rep.skipped,
  };
}

// ================================================================ the general hardware check (other heavy features)

export type HeavyId = 'lipsync' | 'graphics-high' | 'graphics-ultra' | 'gpu-tracking' | 'local-ai';
export interface HeavyCheck {
  id: HeavyId;
  name: string;
  what: string;
  fit: Fit;
  limits: string[];
  /** The safe choice, as a button label ("Use Medium graphics"). */
  safe: string;
  fix?: Fix;
}

export const HEAVY: { id: HeavyId; name: string; what: string; safe: string }[] = [
  { id: 'lipsync', name: 'Lip sync', what: 'How closely the mouth follows your words.', safe: 'Use the recommended lip sync' },
  { id: 'graphics-high', name: 'High graphics', what: 'Glow, soft shadows and colour grading in your room.', safe: 'Use Medium graphics' },
  { id: 'graphics-ultra', name: 'Ultra graphics', what: 'Every effect, drawn extra sharp.', safe: 'Use Medium graphics' },
  { id: 'gpu-tracking', name: 'GPU tracking', what: 'Your graphics card helps read your face and body.', safe: 'Keep it off' },
  { id: 'local-ai', name: 'Local AI', what: 'AI that runs on your own computer, no account needed.', safe: 'Use it when you are not live' },
];

export function checkHeavy(id: HeavyId, f: SetupFacts): HeavyCheck {
  const base = HEAVY.find((x) => x.id === id)!;
  const read = readMachine(f.machine);
  const g = f.machine.gpu;
  const vram = g?.vramGB ?? null;
  const L: string[] = [];
  let fit: Fit = 'ok', fix: Fix | undefined;
  switch (id) {
    case 'lipsync': {
      const r = recommend(f);
      L.push(`We recommend ${TIER_NAMES[r.tier]} here.`);
      break;
    }
    case 'graphics-high':
      if (read.cls === 'low') { fit = 'stretch'; L.push('May lag on stream.', 'Uses a lot of your graphics card while gaming.', 'Face tracking may slow down, and the mouth with it.'); }
      else if (!read.strongGpu) { fit = 'stretch'; L.push('Uses a lot of your graphics card while gaming.', 'If face tracking slows, switch back to Medium.'); }
      break;
    case 'graphics-ultra':
      if (read.cls !== 'high' || (vram !== null && vram < 12)) {
        fit = 'stretch';
        L.push('May lag on stream.', 'Uses a lot of your graphics card while gaming.', 'Face tracking may slow down, and the mouth with it.');
      } else L.push('Still heavy: watch that face tracking stays smooth.');
      break;
    case 'gpu-tracking': {
      if (f.helper === 'none') { fit = 'blocked'; fix = 'helper'; L.push('Needs VTube Pro on your computer.'); break; }
      const s = f.sidecars;
      const rtx50 = s ? s.rtx50 : !!g && classifyGpu(g.name).rtx50;
      if (!rtx50) { fit = 'blocked'; L.push('Needs an NVIDIA RTX 50-series graphics card.'); break; }
      if (s && !s.setUp) { fit = 'blocked'; fix = 'gpu-setup'; L.push('Needs a one-time setup first (a large download).'); break; }
      const name = s?.gpuName || g?.name || '';
      if (/50[56]0/.test(name)) { fit = 'stretch'; L.push('Uses a lot of graphics power while gaming.', 'Body tracking on this card may lag on stream. Use 30 updates a second.'); }
      break;
    }
    case 'local-ai': {
      if (f.helper === 'none') { fit = 'blocked'; fix = 'helper'; L.push('Needs VTube Pro on your computer.'); break; }
      const b = budgetOf(hwOf(f.machine));
      if (b.kind === 'cpu') { fit = 'stretch'; L.push('Runs on your processor, so answers are slow.', 'Your stream may stutter while it thinks.'); }
      else if (b.liveGB < 2) { fit = 'stretch'; L.push('Uses most of your graphics memory.', 'Run it when you are not live, or your stream may lag.'); }
      else L.push(`About ${b.liveGB} GB of graphics memory is free for AI while you stream.`);
      break;
    }
  }
  return { id, name: base.name, what: base.what, fit, limits: L, safe: base.safe, fix };
}

export const TIER_NAMES: Record<LipTier, string> = { basic: 'Basic', good: 'Good', best: 'Best' };
export const TIER_LINES: Record<LipTier, string> = {
  basic: 'The mouth follows your voice and face. Works on any computer.',
  good: 'Shapes land right on time and learn your voice.',
  best: 'Everything, including teeth, tongue and GPU lip sync.',
};

// ================================================================ the guided test ("Say these words")

export type Family = 'open' | 'seal' | 'tuck' | 'round' | 'spread';
export const FAMILY_NAMES: Record<Family, string> = { open: 'open mouth', seal: 'lips pressed (M, B, P)', tuck: 'lip under teeth (F, V)', round: 'round lips (OO)', spread: 'wide lips (EE)' };
/** `quiet`: no words — the performer stays quiet and relaxed; the mouth must stay shut (the "mouth hangs open" check). */
export interface TestWord { id: string; say: string; expect: Family[]; quiet?: boolean }
export const TEST_WORDS: TestWord[] = [
  { id: 'bob', say: 'Bob bought a map', expect: ['seal', 'open'] },
  { id: 'five', say: 'Five fluffy veggies', expect: ['tuck'] },
  { id: 'ooh', say: 'Who knew? Ooh!', expect: ['round'] },
  { id: 'see', say: 'See these cheese', expect: ['spread'] },
  { id: 'quiet', say: 'Now stay quiet', expect: [], quiet: true },
];
/** Seconds each word is on screen. */
export const WORD_SECONDS = 3.5;

/** One sample of what the studio shows (the fused mouth) + what the mic heard. */
export interface TestSample {
  /** mic level 0..1 */
  level: number;
  /** the voice gate is open (the analysis hears you) */
  voiced: boolean;
  open: number; closure: number; fv: number; pucker: number; funnel: number; wide: number;
  /** viseme weights (sil PP FF TH DD kk CH SS nn RR L W aa E I O U), when the mic drives the mouth */
  vis?: Record<string, number>;
  /** the camera's raw lip opening above the closed lips (lip gap / eye-corner span), when the camera sees the face */
  gap?: number;
}

export function familyValue(s: TestSample, fam: Family): number {
  const v = s.vis ?? {};
  const g = (k: string) => v[k] ?? 0;
  switch (fam) {
    case 'open': return Math.max(s.open, g('aa') + 0.5 * g('O'));
    case 'seal': return Math.max(s.closure, g('PP'));
    case 'tuck': return Math.max(s.fv, g('FF'));
    case 'round': return Math.max(s.pucker, s.funnel, g('O') + g('U') + g('W'));
    case 'spread': return Math.max(s.wide, g('E') + g('I'));
  }
}
const FAMILY_HIT: Record<Family, number> = { open: 0.35, seal: 0.35, tuck: 0.3, round: 0.3, spread: 0.3 };

export interface WordResult { id: string; heard: boolean; moved: boolean; found: Family[]; missing: Family[]; score: number;
  /** quiet line: share of the quiet moments the avatar's mouth still showed open (0 = always shut) */
  restOpen?: number }
export function scoreWord(w: TestWord, samples: readonly TestSample[]): WordResult {
  if (w.quiet) {
    // only the moments the performer really was quiet count (a cough / a word doesn't fail the line)
    const calm = samples.filter((s) => !s.voiced && s.level < 0.1);
    const ok = calm.length >= 6;
    const openFrac = ok ? calm.filter((s) => s.open > 0.1).length / calm.length : 0;
    return { id: w.id, heard: ok, moved: ok, found: [], missing: [], score: ok ? Math.round(100 * (1 - Math.min(1, Math.max(0, (openFrac - 0.05) / 0.45)))) : 100, restOpen: ok ? +openFrac.toFixed(3) : undefined };
  }
  const voiced = samples.filter((s) => s.voiced || s.level > 0.12);
  const heard = voiced.length >= 4;
  // the mouth followed the voice: it opened on a good share of the voiced samples
  const movedN = voiced.filter((s) => s.open > 0.08 || familyValue(s, 'open') > 0.12).length;
  const moved = heard && movedN >= Math.max(3, voiced.length * 0.3);
  const found = w.expect.filter((fam) => samples.some((s) => familyValue(s, fam) >= FAMILY_HIT[fam]));
  const missing = w.expect.filter((fam) => !found.includes(fam));
  const score = Math.round(100 * ((heard ? 0.25 : 0) + (moved ? 0.25 : 0) + 0.5 * (heard ? found.length / Math.max(1, w.expect.length) : 0)));
  return { id: w.id, heard, moved, found, missing, score };
}

export type Grade = 'great' | 'good' | 'help';
export interface TestScore { score: number; grade: Grade; headline: string; tips: string[] }
export function scoreTest(results: readonly WordResult[], f: Pick<SetupFacts, 'avatar' | 'mic'> & { tier?: LipTier }): TestScore {
  const score = results.length ? Math.round(results.reduce((a, r) => a + r.score, 0) / results.length) : 0;
  const quiet = results.find((r) => r.restOpen !== undefined);
  const grade: Grade = score >= 80 ? 'great' : score >= 55 ? 'good' : 'help';
  const tips: string[] = [];
  const spoken = results.filter((r) => r.restOpen === undefined && r.id !== 'quiet');
  const heard = spoken.filter((r) => r.heard).length;
  if (quiet && quiet.restOpen! > 0.25) tips.push('The mouth stayed a little open while you were quiet. Press “Use it” below to teach it your resting mouth, then test again.');
  if (heard < spoken.length / 2) tips.push(f.mic?.on ? 'We barely heard you. Move closer to the mic, or turn its volume up.' : 'Turn on your microphone, then try again.');
  else if (spoken.filter((r) => r.moved).length < heard / 2) tips.push('We heard you, but the mouth barely moved. Check that the noise filter is on and the sensitivity is not too low.');
  const miss = new Set(results.flatMap((r) => (r.heard ? r.missing : [])));
  const a = f.avatar;
  if (miss.has('seal')) tips.push(a && !a.seal && a.mouth !== 'shapes' && a.mouth !== 'drawn' ? 'Your model has no shape for pressed lips. M, B and P stay a little open.' : 'Lips didn’t press on B and M. Good lip sync fixes most of that.');
  if (miss.has('tuck')) tips.push(f.tier === 'basic' ? 'F and V were soft. Good lip sync shapes them better.' : 'F and V were soft. The 45-second test teaches it your F.');
  if (miss.has('round')) tips.push(a && a.mouth === 'vowels' && !a.vowels.includes('ou') ? 'Your model has no “OO” shape, so round lips stay small.' : 'OO wasn’t round enough. Say it a bit slower, or run the 45-second test.');
  if (miss.has('spread')) tips.push(a && a.mouth === 'vowels' && !a.vowels.includes('ee') && !a.vowels.includes('ih') ? 'Your model has no “EE” shape, so wide lips stay small.' : 'EE wasn’t wide enough. The 45-second test learns your EE.');
  if (f.mic?.bluetooth) tips.push('A wired or USB mic sounds clearer than a Bluetooth headset.');
  const headline = grade === 'great' ? 'Your lip sync looks great!' : grade === 'good' ? 'Your lip sync looks good.' : 'Your lip sync needs a little help.';
  return { score, grade, headline, tips: tips.slice(0, 3) };
}

/** The resting-mouth margin (slackMouth.ts `max`, lip gap / eye-corner span) that would make this performer's quiet face
 *  read as closed: the 75th percentile of their quiet lip opening plus 0.04, never below the default 0.13 or above 0.3.
 *  Only OFFERED (the self-test saves it when the user accepts). null = nothing to learn (too few quiet camera samples, or
 *  the margin in use already covers it). */
export function restMarginFor(samples: readonly TestSample[], current = 0.13): number | null {
  const g = samples.filter((s) => !s.voiced && s.level < 0.1 && typeof s.gap === 'number' && Number.isFinite(s.gap)).map((s) => s.gap as number).sort((a, b) => a - b);
  if (g.length < 6) return null;
  const want = Math.min(0.3, Math.max(0.13, g[Math.floor(g.length * 0.75)] + 0.04));
  return want > current + 0.01 ? +want.toFixed(3) : null;
}

/** A Bluetooth / hands-free headset, from the mic's name. */
export const isBluetoothMic = (label: string) => /bluetooth|hands-?free|headset \(|airpods|\bbt\b|wh-1000|buds/i.test(label);
