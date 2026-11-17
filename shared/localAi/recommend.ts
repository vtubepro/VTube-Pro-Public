// Local AI recommender: hardware facts in, plain-language picks out. Pure (no I/O): the helper page, the MCP tools and
// the unit tests (tools/local_ai_unit.ts) all call the same functions. Data: ./catalog.ts. Workflows: ./workflows.ts.
import {
  CATALOG_CHECKED, COMFY_NODES, COMFY_SETUPS, IMAGE_MODELS, LLM_MODELS, RUNNERS, SOURCES, TORCH_LINES,
  type ComfySetup, type ImageModel, type LlmModel, type OsId, type Runner, type Step,
} from './catalog.ts';
import { matchWorkflows, type WorkflowPick } from './workflows.ts';
import { HUNYUAN_AI_FOR, HUNYUAN_PLACES } from '../comfyWorkflows/models.ts';

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'other';
export interface GpuInfo {
  name: string;
  vendor: GpuVendor;
  /** Dedicated video memory in GB (null = unknown / shared). Apple Silicon: null + unified. */
  vramGB: number | null;
  unified?: boolean;
  /** An integrated GPU that borrows system RAM (Intel UHD / Iris, AMD Radeon Graphics APUs). */
  integrated?: boolean;
  /** Which probe found it (nvidia-smi, cim, registry, system_profiler, rocm-smi, sysfs, lspci). */
  source: string;
}
export interface HwInfo {
  os: OsId | 'other';
  osName: string;
  arch: string;
  cpu: { model: string; cores: number };
  ramGB: number;
  gpus: GpuInfo[];
  /** Free space on the drive that holds the user's home folder. */
  diskFreeGB: number | null;
  /** Probe notes for the "what we found" box (e.g. "nvidia-smi not found"). Never personal data. */
  notes: string[];
}

/** VRAM the live studio needs while you stream (face tracking + rendering + OBS). docs/AI_ART_PIPELINE.md, aiconnect page. */
export const STUDIO_VRAM_GB = 3;
/** Windows / the desktop keeps some VRAM for the screen. */
const DESKTOP_VRAM_GB = 0.8;

export type TierId = 'cpu' | 'entry' | 'mid' | 'high' | 'enthusiast' | 'pro' | 'workstation';
export const TIERS: { id: TierId; label: string; minGB: number; example: string }[] = [
  { id: 'cpu', label: 'No graphics card for AI', minGB: 0, example: 'laptops with built-in graphics' },
  { id: 'entry', label: 'Entry (4-6 GB)', minGB: 3.5, example: 'GTX 1650, RTX 3050 laptop' },
  { id: 'mid', label: 'Mid (8 GB)', minGB: 7, example: 'RTX 3060 Ti / 4060, RX 6600' },
  { id: 'high', label: 'High (12 GB)', minGB: 10.5, example: 'RTX 3060 12 GB / 4070, RX 6700 XT' },
  { id: 'enthusiast', label: 'Enthusiast (16 GB)', minGB: 14.5, example: 'RTX 4060 Ti 16 GB / 4080 / 5070 Ti, RX 7800 XT' },
  { id: 'pro', label: 'Pro (24 GB)', minGB: 20, example: 'RTX 3090 / 4090, RX 7900 XTX' },
  { id: 'workstation', label: 'Workstation (32 GB+)', minGB: 28, example: 'RTX 5090, 48 GB cards, big Apple Silicon Macs' },
];
export const tierOf = (gb: number): TierId => [...TIERS].reverse().find((t) => gb >= t.minGB)!.id;

export interface Budget {
  kind: 'dedicated' | 'unified' | 'cpu';
  gpu: GpuInfo | null;
  /** The memory the AI can use (dedicated VRAM, or the GPU share of unified memory, or RAM for CPU). */
  effectiveGB: number;
  /** What fits when VTube Pro is NOT running (best quality). */
  offAirGB: number;
  /** What fits next to a live VTube Pro stream (or 0 = don't run AI while live). */
  liveGB: number;
  tier: TierId;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The GPU that matters for AI: the dedicated card with the most VRAM; else Apple Silicon; else none. */
export function primaryGpu(gpus: GpuInfo[]): GpuInfo | null {
  const dedicated = gpus.filter((g) => !g.integrated && !g.unified && (g.vramGB ?? 0) >= 3 && g.vendor !== 'other');
  if (dedicated.length) return dedicated.reduce((a, b) => ((b.vramGB ?? 0) > (a.vramGB ?? 0) ? b : a));
  return gpus.find((g) => g.unified && g.vendor === 'apple') ?? null;
}

export function budgetOf(hw: HwInfo): Budget {
  const gpu = primaryGpu(hw.gpus);
  if (gpu && gpu.unified) {
    // Apple Silicon: the GPU may use most (not all) of unified memory; macOS keeps the rest. Heuristic: 65% below 64 GB,
    // 75% from 64 GB. The studio + OBS share the same memory while live.
    const share = hw.ramGB >= 64 ? 0.75 : 0.65;
    const eff = round1(hw.ramGB * share);
    const off = Math.max(0, round1(eff - 1));
    return { kind: 'unified', gpu, effectiveGB: eff, offAirGB: off, liveGB: Math.max(0, round1(off - 4)), tier: tierOf(eff) };
  }
  if (gpu && gpu.vramGB) {
    const v = gpu.vramGB;
    const off = Math.max(0, round1(v - DESKTOP_VRAM_GB));
    return { kind: 'dedicated', gpu, effectiveGB: v, offAirGB: off, liveGB: Math.max(0, round1(off - STUDIO_VRAM_GB)), tier: tierOf(v) };
  }
  // CPU only: small models run from system RAM, slowly. Keep half the RAM for the PC (and the studio).
  const off = Math.max(0, round1(Math.min(hw.ramGB * 0.5, 8)));
  return { kind: 'cpu', gpu: null, effectiveGB: off, offAirGB: off, liveGB: Math.max(0, round1(Math.min(hw.ramGB * 0.25, 3))), tier: 'cpu' };
}

// ---------------------------------------------------------------- LLMs
export interface LlmPick { model: LlmModel; why: string }
export interface LlmAdvice {
  best: LlmPick | null;
  /** A second choice from another family (or null). */
  alternative: LlmPick | null;
  /** What still fits while VTube Pro is live (null = close the local AI while you stream). */
  whileLive: LlmPick | null;
  runner: Runner;
  otherRunner: Runner | null;
  slow: boolean;
  notes: string[];
  /** Install steps for the best pick with its tag filled in. */
  steps: Step[];
}

/** On the processor only small models answer at a usable speed. */
const CPU_MAX_SIZE_GB = 4;
const fits = (m: LlmModel, gb: number, cpu: boolean) => m.tools && m.needGB <= gb && (!cpu || m.sizeGB <= CPU_MAX_SIZE_GB);
const best = (list: LlmModel[]) => list.reduce<LlmModel | null>((a, b) => (!a || b.score > a.score ? b : a), null);

export function recommendLlm(hw: HwInfo, b = budgetOf(hw)): LlmAdvice {
  const cpu = b.kind === 'cpu';
  const pool = LLM_MODELS.filter((m) => fits(m, b.offAirGB, cpu));
  const top = best(pool);
  const alt = top ? best(pool.filter((m) => m.family !== top.family && m.score >= top.score - 25)) : null;
  const live = best(LLM_MODELS.filter((m) => fits(m, b.liveGB, cpu) && m.score >= 30));
  const notes: string[] = [];
  const os: OsId = hw.os === 'other' ? 'linux' : hw.os;
  let runner = RUNNERS.find((r) => r.id === 'ollama')!;
  let otherRunner: Runner | null = RUNNERS.find((r) => r.id === 'lmstudio')!;
  const gpu = b.gpu;
  if (os === 'macos' && !(gpu?.vendor === 'apple')) {
    otherRunner = null;
    notes.push('LM Studio needs an Apple Silicon Mac (M1 or newer); on an Intel Mac use Ollama (it runs on the processor, slowly).');
  }
  if (gpu?.vendor === 'amd' && os === 'windows' && !/\b(7\d{3}|9\d{3})\b|PRO W/i.test(gpu.name)) {
    // Ollama's ROCm build on Windows covers RX 7000-series and PRO W only; LM Studio uses Vulkan on any Radeon.
    [runner, otherRunner] = [otherRunner ?? runner, runner];
    notes.push('Your Radeon card is older than the RX 7000 series: LM Studio (Vulkan) uses it best on Windows. Ollama works too but may fall back to its Vulkan or CPU mode.');
  }
  if (gpu?.vendor === 'intel') notes.push('Intel Arc: LM Studio (Vulkan) is the simplest way to use the card; Ollama may run on the processor.');
  if (cpu) notes.push('No graphics card for AI was found, so models run on the processor: only small models, and answers come slowly (a few words per second).');
  if (top && b.liveGB < top.needGB) {
    notes.push(live
      ? `While you are live, VTube Pro needs about ${b.kind === 'unified' ? STUDIO_VRAM_GB + 1 : STUDIO_VRAM_GB} GB of ${b.kind === 'unified' ? 'memory' : 'graphics memory'}. Use ${live.name} (${live.ollama}) during streams, or close the AI first.`
      : 'While you are live, VTube Pro needs the graphics card. Close the local AI before you stream (or use an AI app of your own through VTube Pro).');
  }
  if (!top) notes.push('This computer does not have enough memory for a useful local model. An AI app of your own connected to VTube Pro (Claude, ChatGPT, Grok ...) works instead.');
  const why = (m: LlmModel, gb: number) => `${m.blurb} Needs about ${m.needGB} GB; you have about ${gb} GB for AI.`;
  const quant = os === 'macos' && gpu?.vendor === 'apple' ? 'MLX 4-bit' : 'Q4_K_M';
  const steps = top ? fillSteps(runner.steps[os] ?? [], { tag: top.ollama, lmSearch: top.lmSearch, quant }) : [];
  return {
    best: top && { model: top, why: why(top, b.offAirGB) },
    alternative: alt && { model: alt, why: why(alt, b.offAirGB) },
    whileLive: live && { model: live, why: why(live, b.liveGB) },
    runner, otherRunner, slow: cpu, notes, steps,
  };
}

// ---------------------------------------------------------------- ComfyUI
export interface ComfyAdvice {
  recommended: boolean;
  setup: ComfySetup | null;
  altSetup: ComfySetup | null;
  /** Models that fit comfortably, then ones that fit with low-VRAM tricks. Restricted ones never appear. */
  start: ImageModel[];
  tight: ImageModel[];
  helpers: ImageModel[];
  /** Needed disk space for ComfyUI + the starter models, GB. */
  diskNeedGB: number;
  diskOk: boolean | null;
  notes: string[];
  steps: Step[];
}
const HELPER_IDS = new Set(['realesrgan', 'birefnet', 'controlnet-union-sdxl', 'ipadapter-plus-sdxl']);
/** Preference order when several image models fit (best first for VTube Pro jobs). */
const IMAGE_PREF = ['qwen-image', 'z-image-turbo', 'flux2-klein-4b', 'animagine-xl-4', 'sdxl', 'flux1-schnell'];

export function recommendComfy(hw: HwInfo, b = budgetOf(hw)): ComfyAdvice {
  const notes: string[] = [];
  const os = hw.os;
  const gpu = b.gpu;
  const setupBy = (id: ComfySetup['id']) => COMFY_SETUPS.find((s) => s.id === id)!;
  let setup: ComfySetup | null = null, altSetup: ComfySetup | null = null;
  let torch: string = TORCH_LINES.cpu;
  if (b.kind === 'cpu' || b.effectiveGB < 4) {
    notes.push('ComfyUI needs a graphics card with at least 4-6 GB of memory to be useful. On this computer pictures would take many minutes each, so we don\'t recommend it.');
  } else if (os === 'windows') {
    if (gpu?.vendor === 'nvidia') { setup = setupBy('desktop'); altSetup = setupBy('portable-nvidia'); }
    else if (gpu?.vendor === 'amd') { setup = setupBy('portable-amd'); notes.push('AMD on Windows needs a Radeon RX 6000 (RDNA 2) or newer.'); }
    else if (gpu?.vendor === 'intel') setup = setupBy('portable-intel');
  } else if (os === 'macos') {
    if (gpu?.vendor === 'apple') { setup = setupBy('desktop'); torch = TORCH_LINES.apple; altSetup = setupBy('manual'); notes.push('On a Mac, ComfyUI uses Apple\'s Metal: it works, but pictures take several times longer than on a gaming PC.'); }
    else notes.push('ComfyUI Desktop needs an Apple Silicon Mac. On an Intel Mac it would run on the processor only: not recommended.');
  } else {
    setup = setupBy('manual');
    torch = gpu?.vendor === 'amd' ? TORCH_LINES.amd : gpu?.vendor === 'nvidia' ? TORCH_LINES.nvidia : TORCH_LINES.cpu;
    altSetup = setupBy('desktop');
    if (gpu?.vendor === 'amd') notes.push('AMD on Linux uses ROCm 7.2: install AMD\'s ROCm driver first if `rocm-smi` is missing.');
  }
  const eff = b.effectiveGB;
  const main = IMAGE_MODELS.filter((m) => !m.restricted && !HELPER_IDS.has(m.id));
  const order = (l: ImageModel[]) => l.sort((a, c) => IMAGE_PREF.indexOf(a.id) - IMAGE_PREF.indexOf(c.id));
  const start = setup ? order(main.filter((m) => m.recVramGB <= eff)) : [];
  // tight = fits only with fp8 / GGUF / --lowvram: the lightest first
  const tight = setup ? order(main.filter((m) => m.recVramGB > eff && m.minVramGB <= eff)).sort((a, c) => a.recVramGB - c.recVramGB) : [];
  const helpers = setup ? IMAGE_MODELS.filter((m) => HELPER_IDS.has(m.id) && m.minVramGB <= eff) : [];
  if (setup && b.kind === 'dedicated') {
    notes.push('Make pictures when you are NOT live: in our test an SDXL picture dropped face tracking from about 54 to 30-40 frames per second (docs/AI_ART_PIPELINE.md).');
  }
  if (setup && eff < 8) notes.push('Start ComfyUI with --lowvram and make pictures at 768 px, then upscale.');
  const firstTwo = [...start, ...tight].slice(0, 2);
  const diskNeedGB = setup ? Math.ceil(10 + firstTwo.reduce((s, m) => s + m.downloadGB, 0) + helpers.reduce((s, m) => s + m.downloadGB, 0)) : 0;
  const diskOk = hw.diskFreeGB === null || !setup ? null : hw.diskFreeGB >= diskNeedGB;
  if (diskOk === false) notes.push(`You have about ${Math.floor(hw.diskFreeGB!)} GB free; ComfyUI and the starter models need about ${diskNeedGB} GB. Install it on another drive or free some space first.`);
  const steps = setup ? fillSteps(setup.steps, { disk: String(diskNeedGB), torch }) : [];
  return { recommended: !!setup, setup, altSetup, start, tight, helpers, diskNeedGB, diskOk, notes, steps };
}

// ---------------------------------------------------------------- everything at once
export interface Recommendation {
  catalogChecked: string;
  budget: Budget;
  llm: LlmAdvice;
  comfy: ComfyAdvice;
  workflows: WorkflowPick[];
  /** The custom nodes the fitting workflows use. */
  nodes: typeof COMFY_NODES;
  sources: typeof SOURCES;
}
export function recommend(hw: HwInfo): Recommendation {
  const budget = budgetOf(hw);
  const llm = recommendLlm(hw, budget);
  const comfy = recommendComfy(hw, budget);
  const workflows = comfy.recommended ? matchWorkflows({ vramGB: budget.effectiveGB }) : [];
  const nodeIds = new Set(workflows.flatMap((w) => w.variant.nodes));
  nodeIds.add('manager');
  const used = new Set<string>([
    ...[llm.best, llm.alternative, llm.whileLive].flatMap((p) => p?.model.sources ?? []),
    ...llm.runner.sources, ...(llm.otherRunner?.sources ?? []),
    ...(comfy.setup?.sources ?? []), ...(comfy.altSetup?.sources ?? []),
    ...[...comfy.start, ...comfy.tight, ...comfy.helpers].flatMap((m) => m.sources),
    ...COMFY_NODES.filter((n) => nodeIds.has(n.id)).flatMap((n) => n.sources),
  ]);
  return {
    catalogChecked: CATALOG_CHECKED, budget, llm, comfy, workflows,
    nodes: COMFY_NODES.filter((n) => nodeIds.has(n.id)),
    sources: SOURCES.filter((s) => used.has(s.id)),
  };
}

/** Hardware described by the user (or an AI asking them) instead of a scan. */
export function hwFromFacts(f: { os?: string; vramGB?: number; ramGB?: number; gpuVendor?: string; gpuName?: string; appleSilicon?: boolean }): HwInfo {
  const os: HwInfo['os'] = f.os === 'windows' || f.os === 'macos' || f.os === 'linux' ? f.os : 'other';
  const ram = f.ramGB && f.ramGB > 0 ? f.ramGB : 16;
  const gpus: GpuInfo[] = [];
  if (f.appleSilicon || f.gpuVendor === 'apple') gpus.push({ name: f.gpuName || 'Apple Silicon', vendor: 'apple', vramGB: null, unified: true, source: 'user' });
  else if (f.vramGB && f.vramGB > 0) {
    const v = (['nvidia', 'amd', 'intel'] as const).find((x) => x === f.gpuVendor) ?? 'nvidia';
    gpus.push({ name: f.gpuName || `${v.toUpperCase()} GPU`, vendor: v, vramGB: f.vramGB, source: 'user' });
  }
  const osName = os === 'windows' ? 'Windows' : os === 'macos' ? 'macOS' : os === 'linux' ? 'Linux' : 'Other';
  return { os, osName, arch: f.appleSilicon ? 'arm64' : 'x64', cpu: { model: '', cores: 0 }, ramGB: ram, gpus, diskFreeGB: null, notes: ['from the facts given, not a scan'] };
}

export function fillSteps(steps: Step[], vars: Record<string, string>): Step[] {
  const sub = (s: string) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
  return steps.map((s) => ({ ...s, text: sub(s.text), ...(s.copy ? { copy: sub(s.copy) } : {}) }));
}

// ---------------------------------------------------------------- text for AIs (MCP) and for "copy my results"
const gb = (n: number) => `${n} GB`;
export function recommendationMarkdown(r: Recommendation, opts: { scanned: boolean; summary?: string } = { scanned: false }): string {
  const b = r.budget;
  const lines: string[] = [];
  lines.push(`# Local AI recommendation (catalogue checked ${r.catalogChecked})`);
  lines.push(opts.scanned ? `Based on the user's consented hardware scan${opts.summary ? `: ${opts.summary}` : ''}.` : `Based on facts given in the conversation${opts.summary ? `: ${opts.summary}` : ''} (no scan).`);
  lines.push(`Tier: **${TIERS.find((t) => t.id === b.tier)!.label}**. Memory for AI: ~${gb(b.offAirGB)} when VTube Pro is closed, ~${gb(b.liveGB)} while live (the studio keeps ~${STUDIO_VRAM_GB} GB).`);
  lines.push('', '## Local language model');
  if (r.llm.best) {
    const m = r.llm.best.model;
    lines.push(`- Best: **${m.name}** (\`ollama pull ${m.ollama}\`, LM Studio search "${m.lmSearch}"), ${m.sizeGB} GB download, licence ${m.licence}. ${m.blurb}`);
  } else lines.push('- No local model fits; suggest an AI app of your own connected to VTube Pro.');
  if (r.llm.alternative) lines.push(`- Alternative: **${r.llm.alternative.model.name}** (\`${r.llm.alternative.model.ollama}\`), licence ${r.llm.alternative.model.licence}.`);
  lines.push(`- While live: ${r.llm.whileLive ? `**${r.llm.whileLive.model.name}** (\`${r.llm.whileLive.model.ollama}\`)` : 'close the local model (or use an AI app of your own)'}.`);
  lines.push(`- Runner: ${r.llm.runner.name} (${r.llm.runner.download.windows ?? r.llm.runner.download.macos}); OpenAI-compatible endpoint ${r.llm.runner.openaiBase}.`);
  for (const n of r.llm.notes) lines.push(`- Note: ${n}`);
  lines.push('', '## ComfyUI');
  if (r.comfy.setup) {
    lines.push(`- Install: **${r.comfy.setup.name}** (${r.comfy.setup.link})${r.comfy.altSetup ? `; or ${r.comfy.altSetup.name}` : ''}. Disk: ~${r.comfy.diskNeedGB} GB.`);
    lines.push(`- Start with: ${r.comfy.start.map((m) => `${m.name} (${m.licence})`).join('; ') || 'none comfortably'}.`);
    if (r.comfy.tight.length) lines.push(`- Fits with low-VRAM tricks (fp8 / GGUF / --lowvram): ${r.comfy.tight.map((m) => m.name).join('; ')}.`);
    lines.push(`- Custom nodes: ${r.nodes.map((n) => `${n.name} (${n.licence})`).join('; ')}.`);
  } else lines.push('- Not recommended on this machine.');
  for (const n of r.comfy.notes) lines.push(`- Note: ${n}`);
  if (r.workflows.length) {
    lines.push('', '## Workflows that fit (get details with comfy_workflows {task})');
    for (const w of r.workflows) lines.push(`- ${w.workflow.id}: ${w.workflow.title} -> ${w.variant.label}${w.workflow.restricted ? ' (licence warning: see comfy_workflows)' : ''}`);
  }
  lines.push('', '## Rules when suggesting these', '- Only suggest; never download or install for the user. Give the official links above.',
    `- Recommend only commercial-OK models by default; say the licence. Never suggest FLUX dev / klein 9B or RMBG-2.0 for monetised streams. Hunyuan3D only through the Character 3D recipe (the user's own download after their own Yes, never bundled), after telling the user it is not for ${HUNYUAN_PLACES}, and only for ${HUNYUAN_AI_FOR} (never for humans).`,
    '- GPU work only when the user is not live.');
  lines.push('', 'Sources: ' + r.sources.map((s) => `${s.title} <${s.url}> (checked ${s.checked})`).join('; '));
  return lines.join('\n');
}
