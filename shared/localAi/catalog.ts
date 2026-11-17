// Local AI catalogue: the DATA behind the helper's "Local AI" recommender (server/routes/localAi.ts) and the ComfyUI
// workflow knowledge AIs get through MCP (server/localAiTools.ts). Pure data, no imports: safe for the studio, the
// server and tests.
//
// HOW TO UPDATE (maintainers): models move fast. When you change an entry:
//   1. open its `page` link (and the licence link) and check the name / tag / download size / licence still match;
//   2. bump `checked` on the entry and CATALOG_CHECKED below, and add / update a SOURCES row (with the date you looked);
//   3. run `npx tsx tools/local_ai_unit.ts` (it checks ids, links, sources and that every hardware tier gets a pick).
// Sizes are the download sizes shown on the official page (Ollama: the default q4_K_M tag). `needGB` is what must fit
// in GPU memory (weights + a working context); it is an estimate, not a promise.

export const CATALOG_VERSION = '2026.10.01';
/** The date every entry below was last checked against its source. */
export const CATALOG_CHECKED = '2026-10-01';

// ---------------------------------------------------------------- sources (cited in the UI and in AI answers)
export interface Source { id: string; title: string; url: string; checked: string; note?: string }
export const SOURCES: Source[] = [
  { id: 'ollama-library', title: 'Ollama model library', url: 'https://ollama.com/library', checked: '2026-10-01' },
  { id: 'ollama-qwen3', title: 'Ollama: qwen3 tags (8b = 5.2 GB)', url: 'https://ollama.com/library/qwen3/tags', checked: '2026-10-01' },
  { id: 'ollama-qwen35', title: 'Ollama: qwen3.5 tags', url: 'https://ollama.com/library/qwen3.5/tags', checked: '2026-10-01' },
  { id: 'ollama-qwen36', title: 'Ollama: qwen3.6 tags', url: 'https://ollama.com/library/qwen3.6/tags', checked: '2026-10-01' },
  { id: 'ollama-qwen38', title: 'Ollama: qwen3.8 tags', url: 'https://ollama.com/library/qwen3.8/tags', checked: '2026-10-01' },
  { id: 'ollama-gemma4', title: 'Ollama: gemma4 tags', url: 'https://ollama.com/library/gemma4/tags', checked: '2026-10-01' },
  { id: 'ollama-gptoss', title: 'Ollama: gpt-oss tags', url: 'https://ollama.com/library/gpt-oss/tags', checked: '2026-10-01' },
  { id: 'ollama-mistral', title: 'Ollama: mistral-small3.2 tags', url: 'https://ollama.com/library/mistral-small3.2/tags', checked: '2026-10-01' },
  { id: 'ollama-win', title: 'Ollama for Windows (requirements, port 11434)', url: 'https://docs.ollama.com/windows', checked: '2026-10-01' },
  { id: 'ollama-linux', title: 'Ollama for Linux', url: 'https://docs.ollama.com/linux', checked: '2026-10-01' },
  { id: 'ollama-gpu', title: 'Ollama GPU support (NVIDIA CC 5.0+, AMD ROCm v7 / Vulkan, Apple Metal)', url: 'https://docs.ollama.com/gpu', checked: '2026-10-01' },
  { id: 'ollama-download', title: 'Ollama download (macOS 14 Sonoma or later)', url: 'https://ollama.com/download', checked: '2026-10-01' },
  { id: 'lmstudio-req', title: 'LM Studio system requirements', url: 'https://lmstudio.ai/docs/app/system-requirements', checked: '2026-10-01' },
  { id: 'lmstudio-dl', title: 'LM Studio download (0.4.25 on 2026-10-01)', url: 'https://lmstudio.ai/download', checked: '2026-10-01' },
  { id: 'qwen-licence', title: 'Qwen3.5-9B licence (Apache-2.0)', url: 'https://huggingface.co/Qwen/Qwen3.5-9B/blob/main/LICENSE', checked: '2026-10-01' },
  { id: 'qwen38-licence', title: 'Qwen3.8-27B licence (Apache-2.0, released 2026-08-14)', url: 'https://huggingface.co/Qwen/Qwen3.8-27B/blob/main/LICENSE', checked: '2026-10-01' },
  { id: 'gemma4-licence', title: 'Gemma 4 is Apache-2.0 (Google Open Source Blog)', url: 'https://opensource.googleblog.com/2026/03/gemma-4-expanding-the-gemmaverse-with-apache-20.html', checked: '2026-10-01' },
  { id: 'gptoss-card', title: 'gpt-oss-20b (Apache-2.0, runs within 16 GB)', url: 'https://huggingface.co/openai/gpt-oss-20b', checked: '2026-10-01' },
  { id: 'comfy-req', title: 'ComfyUI system requirements', url: 'https://docs.comfy.org/installation/system_requirements', checked: '2026-10-01' },
  { id: 'comfy-portable', title: 'ComfyUI portable for Windows', url: 'https://docs.comfy.org/installation/comfyui_portable_windows', checked: '2026-10-01' },
  { id: 'comfy-manual', title: 'ComfyUI manual install', url: 'https://docs.comfy.org/installation/manual_install', checked: '2026-10-01' },
  { id: 'comfy-download', title: 'ComfyUI download (Desktop / Portable / CLI)', url: 'https://www.comfy.org/download', checked: '2026-10-01' },
  { id: 'comfy-repo', title: 'ComfyUI on GitHub (GPL-3.0; portable .7z per GPU; Manager via --enable-manager)', url: 'https://github.com/Comfy-Org/ComfyUI', checked: '2026-10-01' },
  { id: 'comfy-desktop-port', title: 'ComfyUI Desktop listens on 127.0.0.1:8000 by default (Portable / manual: 8188) (community wiki)', url: 'https://comfyui-wiki.com/en/interface/settings/server-config', checked: '2026-10-01' },
  { id: 'ollama-llama31', title: 'Ollama: llama3.1 tags (8b = 4.9 GB)', url: 'https://ollama.com/library/llama3.1/tags', checked: '2026-10-01' },
  { id: 'zimage-card', title: 'Z-Image-Turbo (Apache-2.0, fits 16 GB, 8 steps, guidance 0)', url: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo', checked: '2026-10-01' },
  { id: 'zimage-comfy', title: 'ComfyUI tutorial: Z-Image-Turbo files + folders', url: 'https://docs.comfy.org/tutorials/image/z-image/z-image-turbo', checked: '2026-10-01' },
  { id: 'flux2klein-card', title: 'FLUX.2 [klein] 4B (Apache-2.0, ~13 GB; the 9B is non-commercial)', url: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B', checked: '2026-10-01' },
  { id: 'flux1schnell-card', title: 'FLUX.1 [schnell] (Apache-2.0, 12B, 1-4 steps)', url: 'https://huggingface.co/black-forest-labs/FLUX.1-schnell', checked: '2026-10-01' },
  { id: 'sdxl-card', title: 'SDXL base 1.0 (CreativeML Open RAIL++-M)', url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0', checked: '2026-10-01' },
  { id: 'qwenimage-card', title: 'Qwen-Image (Apache-2.0, 20B, strong text rendering)', url: 'https://huggingface.co/Qwen/Qwen-Image', checked: '2026-10-01' },
  { id: 'qwenimage-comfy', title: 'ComfyUI tutorial: Qwen-Image (fp8 / distilled / Lightning timings on 24 GB)', url: 'https://docs.comfy.org/tutorials/image/qwen/qwen-image', checked: '2026-10-01' },
  { id: 'gguf-node', title: 'ComfyUI-GGUF (Apache-2.0; GGUF files go in models/unet)', url: 'https://github.com/city96/ComfyUI-GGUF', checked: '2026-10-01' },
  { id: 'rmbg-node', title: 'ComfyUI-RMBG (GPL-3.0; BiRefNet, RMBG-2.0, BEN2, SAM ...)', url: 'https://github.com/1038lab/ComfyUI-RMBG', checked: '2026-10-01' },
  { id: 'rmbg2-card', title: 'BRIA RMBG-2.0 (CC BY-NC 4.0: non-commercial)', url: 'https://huggingface.co/briaai/RMBG-2.0', checked: '2026-10-01' },
  { id: 'birefnet-card', title: 'BiRefNet (MIT)', url: 'https://huggingface.co/ZhengPeng7/BiRefNet', checked: '2026-10-01' },
  { id: 'tiling-node', title: 'ComfyUI-seamless-tiling (GPL-3.0; X / Y tiling, circular VAE)', url: 'https://github.com/spinagon/ComfyUI-seamless-tiling', checked: '2026-10-01' },
  { id: 'esrgan', title: 'Real-ESRGAN (BSD-3-Clause, code + x4plus / anime_6B weights)', url: 'https://github.com/xinntao/Real-ESRGAN', checked: '2026-10-01' },
  { id: 'yt-thumb', title: 'YouTube custom thumbnails (16:9, min width 640, JPG/PNG)', url: 'https://support.google.com/youtube/answer/72431', checked: '2026-10-01' },
  { id: 'twitch-emotes', title: 'Twitch emote sizes 28 / 56 / 112 px, PNG, transparent, <= 1 MB (third-party guide; the official Twitch help page did not load on 2026-10-01)', url: 'https://emoteresizer.net/blog/twitch-emote-size', checked: '2026-10-01' },
  { id: 'vtp-models', title: 'VTube Pro AI model manifest (licences of the weights the paint pipeline uses)', url: 'docs/AI_MODELS.md', checked: '2026-09-25' },
  { id: 'vtp-pipeline', title: 'VTube Pro AI art pipeline (GPU etiquette, measured costs)', url: 'docs/AI_ART_PIPELINE.md', checked: '2026-09-25' },
];

// ---------------------------------------------------------------- runners (how a user runs a local LLM)
export type OsId = 'windows' | 'macos' | 'linux';
export interface Step { text: string; copy?: string; link?: string }
export interface Runner {
  id: 'ollama' | 'lmstudio' | 'llamacpp';
  name: string;
  what: string;
  /** Where the helper finds it (ai-connect lane uses the same addresses). */
  endpoint: string;
  openaiBase: string;
  download: Partial<Record<OsId, string>>;
  licence: string;
  steps: Partial<Record<OsId, Step[]>>;
  sources: string[];
  /** Hidden from non-experts unless nothing else fits. */
  advanced?: boolean;
}
export const RUNNERS: Runner[] = [
  {
    id: 'ollama', name: 'Ollama',
    what: 'A small free app that downloads and runs AI models on your own computer. VTube Pro talks to it automatically.',
    endpoint: 'http://127.0.0.1:11434', openaiBase: 'http://127.0.0.1:11434/v1',
    download: { windows: 'https://ollama.com/download/windows', macos: 'https://ollama.com/download', linux: 'https://ollama.com/download/linux' },
    licence: 'MIT (the app). Each model has its own licence (shown next to it).',
    steps: {
      windows: [
        { text: 'Click "Download Ollama" and run OllamaSetup.exe (Windows 10 22H2 or newer).', link: 'https://ollama.com/download/windows' },
        { text: 'When it finishes, a llama icon appears near the clock. That means it is running.' },
        { text: 'Open the Start menu, type "Terminal", open it and paste this line, then press Enter:', copy: 'ollama pull {tag}' },
        { text: 'Wait for the download to reach 100%. Then come back here and click "Check again". VTube Pro finds it by itself.' },
      ],
      macos: [
        { text: 'Click "Download Ollama", open Ollama.dmg and drag Ollama into Applications (macOS 14 Sonoma or newer).', link: 'https://ollama.com/download' },
        { text: 'Open Ollama from Applications once. A llama icon appears in the menu bar.' },
        { text: 'Open Terminal (press Cmd+Space, type "Terminal"), paste this line and press Enter:', copy: 'ollama pull {tag}' },
        { text: 'Wait for 100%, then click "Check again" here.' },
      ],
      linux: [
        { text: 'Open a terminal and paste the official installer line (it asks for your password):', copy: 'curl -fsSL https://ollama.com/install.sh | sh', link: 'https://docs.ollama.com/linux' },
        { text: 'Then download the model:', copy: 'ollama pull {tag}' },
        { text: 'Click "Check again" here.' },
      ],
    },
    sources: ['ollama-download', 'ollama-win', 'ollama-linux', 'ollama-gpu'],
  },
  {
    id: 'lmstudio', name: 'LM Studio',
    what: 'A free app with a friendly window: search a model, click Download, click Load. Good if you never want to type a command.',
    endpoint: 'http://127.0.0.1:1234', openaiBase: 'http://127.0.0.1:1234/v1',
    download: { windows: 'https://lmstudio.ai/download', macos: 'https://lmstudio.ai/download', linux: 'https://lmstudio.ai/download' },
    licence: 'Free app (LM Studio terms). Each model has its own licence.',
    steps: {
      windows: [
        { text: 'Download LM Studio for Windows and run the installer.', link: 'https://lmstudio.ai/download' },
        { text: 'Open LM Studio, click the magnifying glass (Discover) and search for:', copy: '{lmSearch}' },
        { text: 'Click Download on the version LM Studio marks as a good fit for your PC (usually {quant}). When it is done, click Load.' },
        { text: 'Open the Developer tab and switch "Status: Running" on (the local server). Then click "Check again" here.' },
      ],
      macos: [
        { text: 'Download LM Studio for Mac (needs an Apple Silicon Mac, M1 or newer, and macOS 14+). Intel Macs are not supported.', link: 'https://lmstudio.ai/download' },
        { text: 'Open LM Studio, click Discover and search for:', copy: '{lmSearch}' },
        { text: 'On a Mac, the "MLX" download is usually fastest. Click Download, then Load.' },
        { text: 'Developer tab: switch the local server on. Then click "Check again" here.' },
      ],
      linux: [
        { text: 'Download the LM Studio AppImage (Ubuntu 20.04 or newer), make it executable and open it.', link: 'https://lmstudio.ai/download' },
        { text: 'Discover: search for', copy: '{lmSearch}' },
        { text: 'Download, Load, then switch the local server on in the Developer tab and click "Check again" here.' },
      ],
    },
    sources: ['lmstudio-dl', 'lmstudio-req'],
  },
  {
    id: 'llamacpp', name: 'llama.cpp server', advanced: true,
    what: 'The engine inside many local AI apps, as a bare command-line server. For tinkerers.',
    endpoint: 'http://127.0.0.1:8080', openaiBase: 'http://127.0.0.1:8080/v1',
    download: { windows: 'https://github.com/ggml-org/llama.cpp/releases', macos: 'https://github.com/ggml-org/llama.cpp/releases', linux: 'https://github.com/ggml-org/llama.cpp/releases' },
    licence: 'MIT',
    steps: {
      windows: [{ text: 'Download a release zip for your GPU, unzip it and run llama-server with a GGUF model (see the project README).', link: 'https://github.com/ggml-org/llama.cpp' }],
      macos: [{ text: 'Download a release (or build it) and run llama-server with a GGUF model (see the README).', link: 'https://github.com/ggml-org/llama.cpp' }],
      linux: [{ text: 'Download a release (or build it) and run llama-server with a GGUF model (see the README).', link: 'https://github.com/ggml-org/llama.cpp' }],
    },
    sources: [],
  },
];

// ---------------------------------------------------------------- local LLMs
export interface LlmModel {
  id: string;
  name: string;
  family: 'Qwen' | 'Gemma' | 'gpt-oss' | 'Mistral' | 'Llama';
  /** Ollama tag (`ollama pull <tag>`). */
  ollama: string;
  /** What to type in LM Studio's Discover search. */
  lmSearch: string;
  /** Download size of the default (4-bit) build, GB. */
  sizeGB: number;
  /** GPU memory to run it fully on the GPU with a working context (estimate). */
  needGB: number;
  /** Relative quality for VTube Pro jobs (tool calling, planning rooms, following the guides). Higher is better. */
  score: number;
  tools: boolean;
  vision: boolean;
  moe?: boolean;
  licence: string;
  licenceUrl: string;
  commercialOk: boolean;
  page: string;
  blurb: string;
  sources: string[];
  checked: string;
}
const need = (size: number) => Math.round((size + 1.0) * 10) / 10; // + KV cache / runtime for an ~8k context
const APACHE = 'Apache-2.0';
export const LLM_MODELS: LlmModel[] = [
  { id: 'qwen3.5-0.8b', name: 'Qwen3.5 0.8B', family: 'Qwen', ollama: 'qwen3.5:0.8b', lmSearch: 'Qwen3.5 0.8B', sizeGB: 1.0, needGB: need(1.0), score: 20, tools: true, vision: true, licence: APACHE, licenceUrl: 'https://huggingface.co/Qwen/Qwen3.5-9B/blob/main/LICENSE', commercialOk: true, page: 'https://ollama.com/library/qwen3.5', blurb: 'Tiny. Chat and short answers only; too small to build rooms reliably.', sources: ['ollama-qwen35', 'qwen-licence'], checked: '2026-10-01' },
  { id: 'qwen3.5-2b', name: 'Qwen3.5 2B', family: 'Qwen', ollama: 'qwen3.5:2b', lmSearch: 'Qwen3.5 2B', sizeGB: 1.9, needGB: need(1.9), score: 35, tools: true, vision: true, licence: APACHE, licenceUrl: 'https://huggingface.co/Qwen/Qwen3.5-9B/blob/main/LICENSE', commercialOk: true, page: 'https://ollama.com/library/qwen3.5', blurb: 'Small and quick, even without a graphics card. Fine for chat helpers and simple commands.', sources: ['ollama-qwen35', 'qwen-licence'], checked: '2026-10-01' },
  { id: 'qwen3.5-4b', name: 'Qwen3.5 4B', family: 'Qwen', ollama: 'qwen3.5:4b', lmSearch: 'Qwen3.5 4B', sizeGB: 3.4, needGB: need(3.4), score: 52, tools: true, vision: true, licence: APACHE, licenceUrl: 'https://huggingface.co/Qwen/Qwen3.5-9B/blob/main/LICENSE', commercialOk: true, page: 'https://ollama.com/library/qwen3.5', blurb: 'The best small model: tool calling and image input in 3.4 GB.', sources: ['ollama-qwen35', 'qwen-licence'], checked: '2026-10-01' },
  { id: 'gemma4-e4b', name: 'Gemma 4 E4B', family: 'Gemma', ollama: 'gemma4:e4b', lmSearch: 'Gemma 4 E4B', sizeGB: 6.6, needGB: need(6.6), score: 50, tools: true, vision: true, licence: APACHE, licenceUrl: 'https://opensource.googleblog.com/2026/03/gemma-4-expanding-the-gemmaverse-with-apache-20.html', commercialOk: true, page: 'https://ollama.com/library/gemma4', blurb: 'Google\'s on-device model (text, images and audio in). Bigger download than its name suggests.', sources: ['ollama-gemma4', 'gemma4-licence'], checked: '2026-10-01' },
  { id: 'qwen3-8b', name: 'Qwen3 8B', family: 'Qwen', ollama: 'qwen3:8b', lmSearch: 'Qwen3 8B', sizeGB: 5.2, needGB: need(5.2), score: 60, tools: true, vision: false, licence: APACHE, licenceUrl: 'https://github.com/QwenLM/Qwen3', commercialOk: true, page: 'https://ollama.com/library/qwen3', blurb: 'The best fit for 8 GB cards: solid tool calling and reasoning in 5.2 GB. Text only.', sources: ['ollama-qwen3'], checked: '2026-10-01' },
  { id: 'llama3.1-8b', name: 'Llama 3.1 8B', family: 'Llama', ollama: 'llama3.1:8b', lmSearch: 'Llama 3.1 8B Instruct', sizeGB: 4.9, needGB: need(4.9), score: 55, tools: true, vision: false, licence: 'Llama 3.1 Community License (use policy; extra terms above 700M monthly users)', licenceUrl: 'https://www.llama.com/llama3_1/license/', commercialOk: true, page: 'https://ollama.com/library/llama3.1', blurb: 'A well-known all-rounder. Qwen3.5 9B is usually better for the same card.', sources: ['ollama-llama31'], checked: '2026-10-01' },
  { id: 'qwen3.5-9b', name: 'Qwen3.5 9B', family: 'Qwen', ollama: 'qwen3.5:9b', lmSearch: 'Qwen3.5 9B', sizeGB: 6.6, needGB: need(6.6), score: 68, tools: true, vision: true, licence: APACHE, licenceUrl: 'https://huggingface.co/Qwen/Qwen3.5-9B/blob/main/LICENSE', commercialOk: true, page: 'https://ollama.com/library/qwen3.5', blurb: 'The sweet spot for 10-12 GB cards: good tool calling, sees images.', sources: ['ollama-qwen35', 'qwen-licence'], checked: '2026-10-01' },
  { id: 'gemma4-12b', name: 'Gemma 4 12B', family: 'Gemma', ollama: 'gemma4:12b', lmSearch: 'Gemma 4 12B', sizeGB: 8.0, needGB: need(8.0), score: 72, tools: true, vision: true, licence: APACHE, licenceUrl: 'https://opensource.googleblog.com/2026/03/gemma-4-expanding-the-gemmaverse-with-apache-20.html', commercialOk: true, page: 'https://ollama.com/library/gemma4', blurb: 'Strong 12 GB-class model with a 256k context.', sources: ['ollama-gemma4', 'gemma4-licence'], checked: '2026-10-01' },
  { id: 'gpt-oss-20b', name: 'gpt-oss 20B', family: 'gpt-oss', ollama: 'gpt-oss:20b', lmSearch: 'gpt-oss 20b', sizeGB: 14, needGB: need(14), score: 79, tools: true, vision: false, moe: true, licence: APACHE, licenceUrl: 'https://huggingface.co/openai/gpt-oss-20b', commercialOk: true, page: 'https://ollama.com/library/gpt-oss', blurb: 'OpenAI\'s open-weight reasoning model; fast (mixture of experts). Text only.', sources: ['ollama-gptoss', 'gptoss-card'], checked: '2026-10-01' },
  { id: 'mistral-small3.2-24b', name: 'Mistral Small 3.2 24B', family: 'Mistral', ollama: 'mistral-small3.2:24b', lmSearch: 'Mistral Small 3.2 24B Instruct 2506', sizeGB: 15, needGB: need(15), score: 76, tools: true, vision: true, licence: APACHE, licenceUrl: 'https://ollama.com/library/mistral-small3.2', commercialOk: true, page: 'https://ollama.com/library/mistral-small3.2', blurb: 'Reliable function calling; a good second choice for 16-20 GB cards.', sources: ['ollama-mistral'], checked: '2026-10-01' },
  { id: 'gemma4-26b', name: 'Gemma 4 26B (MoE)', family: 'Gemma', ollama: 'gemma4:26b', lmSearch: 'Gemma 4 26B A4B', sizeGB: 18, needGB: need(18), score: 85, tools: true, vision: true, moe: true, licence: APACHE, licenceUrl: 'https://opensource.googleblog.com/2026/03/gemma-4-expanding-the-gemmaverse-with-apache-20.html', commercialOk: true, page: 'https://ollama.com/library/gemma4', blurb: 'Only 4B active parameters, so it answers fast for its size.', sources: ['ollama-gemma4', 'gemma4-licence'], checked: '2026-10-01' },
  { id: 'qwen3.8-27b', name: 'Qwen3.8 27B', family: 'Qwen', ollama: 'qwen3.8:27b', lmSearch: 'Qwen3.8 27B', sizeGB: 18, needGB: need(18), score: 90, tools: true, vision: true, licence: APACHE, licenceUrl: 'https://huggingface.co/Qwen/Qwen3.8-27B/blob/main/LICENSE', commercialOk: true, page: 'https://ollama.com/library/qwen3.8', blurb: 'Newest Qwen (Aug 2026). The best pick for a 24 GB card: agentic tasks, coding, images in.', sources: ['ollama-qwen38', 'qwen38-licence'], checked: '2026-10-01' },
  { id: 'gemma4-31b', name: 'Gemma 4 31B', family: 'Gemma', ollama: 'gemma4:31b', lmSearch: 'Gemma 4 31B', sizeGB: 20, needGB: need(20), score: 88, tools: true, vision: true, licence: APACHE, licenceUrl: 'https://opensource.googleblog.com/2026/03/gemma-4-expanding-the-gemmaverse-with-apache-20.html', commercialOk: true, page: 'https://ollama.com/library/gemma4', blurb: 'Google\'s largest Gemma 4 (dense). Tight on 24 GB.', sources: ['ollama-gemma4', 'gemma4-licence'], checked: '2026-10-01' },
  { id: 'qwen3.6-35b-a3b', name: 'Qwen3.6 35B-A3B (MoE)', family: 'Qwen', ollama: 'qwen3.6:35b-a3b', lmSearch: 'Qwen3.6 35B A3B', sizeGB: 24, needGB: need(24), score: 89, tools: true, vision: true, moe: true, licence: APACHE, licenceUrl: 'https://huggingface.co/Qwen/Qwen3.6-35B-A3B', commercialOk: true, page: 'https://ollama.com/library/qwen3.6', blurb: 'Very fast for its quality (3B active). Needs a 32 GB card or a big Mac.', sources: ['ollama-qwen36', 'qwen-licence'], checked: '2026-10-01' },
  { id: 'gpt-oss-120b', name: 'gpt-oss 120B', family: 'gpt-oss', ollama: 'gpt-oss:120b', lmSearch: 'gpt-oss 120b', sizeGB: 65, needGB: need(65), score: 94, tools: true, vision: false, moe: true, licence: APACHE, licenceUrl: 'https://huggingface.co/openai/gpt-oss-20b', commercialOk: true, page: 'https://ollama.com/library/gpt-oss', blurb: 'For 96-128 GB Macs and workstation cards.', sources: ['ollama-gptoss'], checked: '2026-10-01' },
  { id: 'qwen3.5-122b', name: 'Qwen3.5 122B-A10B (MoE)', family: 'Qwen', ollama: 'qwen3.5:122b', lmSearch: 'Qwen3.5 122B A10B', sizeGB: 81, needGB: need(81), score: 96, tools: true, vision: true, moe: true, licence: APACHE, licenceUrl: 'https://huggingface.co/Qwen/Qwen3.5-9B/blob/main/LICENSE', commercialOk: true, page: 'https://ollama.com/library/qwen3.5', blurb: 'The biggest model worth running at home: 128 GB Macs and multi-GPU rigs.', sources: ['ollama-qwen35', 'qwen-licence'], checked: '2026-10-01' },
];

// ---------------------------------------------------------------- ComfyUI: install options
export interface ComfySetup {
  id: 'desktop' | 'portable-nvidia' | 'portable-amd' | 'portable-intel' | 'manual';
  name: string;
  what: string;
  link: string;
  steps: Step[];
  sources: string[];
}
export const COMFY_SETUPS: ComfySetup[] = [
  {
    id: 'desktop', name: 'ComfyUI Desktop (easiest)',
    what: 'A normal installer with automatic updates. It sets up Python and the extension manager for you.',
    link: 'https://www.comfy.org/download',
    steps: [
      { text: 'Open the ComfyUI download page and click the Desktop download for your computer.', link: 'https://www.comfy.org/download' },
      { text: 'Run the installer. When it asks for a folder, pick a drive with at least {disk} GB free (models are big).' },
      { text: 'When ComfyUI opens, it shows a page with a node graph. That means it works. Leave it open.' },
      { text: 'Come back here and click "Check again". VTube Pro looks for ComfyUI Desktop on 127.0.0.1:8000 and for Portable on 127.0.0.1:8188.' },
    ],
    sources: ['comfy-download', 'comfy-req', 'comfy-desktop-port'],
  },
  {
    id: 'portable-nvidia', name: 'ComfyUI Portable for NVIDIA (no installer)',
    what: 'One folder you unzip anywhere. Nothing is installed into Windows; delete the folder to remove it.',
    link: 'https://github.com/Comfy-Org/ComfyUI/releases/latest',
    steps: [
      { text: 'Open the latest ComfyUI release and download ComfyUI_windows_portable_nvidia.7z.', link: 'https://github.com/Comfy-Org/ComfyUI/releases/latest' },
      { text: 'Right-click the file and choose "Extract All" (if Windows can\'t open .7z files, install 7-Zip from 7-zip.org first). Put it on a drive with {disk} GB free.', link: 'https://www.7-zip.org/' },
      { text: 'Open the new folder and double-click run_nvidia_gpu.bat. A black window opens: keep it open, closing it stops ComfyUI.' },
      { text: 'When the window says "To see the GUI go to: http://127.0.0.1:8188", click "Check again" here.' },
      { text: 'Want the extension manager (to add the extra nodes below)? Right-click run_nvidia_gpu.bat, Edit, add --enable-manager at the end of the python line, save.' },
    ],
    sources: ['comfy-portable', 'comfy-repo'],
  },
  {
    id: 'portable-amd', name: 'ComfyUI Portable for AMD Radeon',
    what: 'The same one-folder build, made for Radeon cards (RDNA 2 or newer).',
    link: 'https://github.com/Comfy-Org/ComfyUI/releases/latest',
    steps: [
      { text: 'Download ComfyUI_windows_portable_amd.7z from the latest release.', link: 'https://github.com/Comfy-Org/ComfyUI/releases/latest' },
      { text: 'Extract it (7-Zip if needed) to a drive with {disk} GB free.', link: 'https://www.7-zip.org/' },
      { text: 'Double-click run_amd_gpu.bat and keep the window open.' },
      { text: 'When it shows http://127.0.0.1:8188, click "Check again" here.' },
    ],
    sources: ['comfy-portable', 'comfy-repo', 'comfy-req'],
  },
  {
    id: 'portable-intel', name: 'ComfyUI Portable for Intel Arc',
    what: 'The one-folder build for Intel Arc graphics.',
    link: 'https://github.com/Comfy-Org/ComfyUI/releases/latest',
    steps: [
      { text: 'Download ComfyUI_windows_portable_intel.7z from the latest release.', link: 'https://github.com/Comfy-Org/ComfyUI/releases/latest' },
      { text: 'Extract it (7-Zip if needed), double-click run_intel_gpu.bat and keep the window open.', link: 'https://www.7-zip.org/' },
      { text: 'When it shows http://127.0.0.1:8188, click "Check again" here.' },
    ],
    sources: ['comfy-portable', 'comfy-repo'],
  },
  {
    id: 'manual', name: 'Manual install (Linux, or if you like a terminal)',
    what: 'The official from-source install. Works on every system; best on Linux.',
    link: 'https://docs.comfy.org/installation/manual_install',
    steps: [
      { text: 'Open a terminal and download ComfyUI:', copy: 'git clone https://github.com/Comfy-Org/ComfyUI.git && cd ComfyUI && python3 -m venv .venv && . .venv/bin/activate' },
      { text: 'Install PyTorch for your graphics card:', copy: '{torch}' },
      { text: 'Install ComfyUI\'s own parts:', copy: 'pip install -r requirements.txt' },
      { text: 'Start it (keep the terminal open), then click "Check again" here:', copy: 'python main.py' },
    ],
    sources: ['comfy-manual', 'comfy-req'],
  },
];
/** Exact PyTorch lines from docs.comfy.org (manual install), per GPU. */
export const TORCH_LINES: Record<'nvidia' | 'amd' | 'apple' | 'cpu', string> = {
  nvidia: 'pip install torch torchvision torchaudio --extra-index-url https://download.pytorch.org/whl/cu130',
  amd: 'pip3 install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/rocm7.2',
  apple: 'pip install torch torchvision torchaudio',
  cpu: 'pip install torch torchvision torchaudio',
};

// ---------------------------------------------------------------- ComfyUI: image models
export interface ImageModel {
  id: string;
  name: string;
  /** What it is good at, in plain words. */
  good: string;
  /** Minimum VRAM that works (low-VRAM / fp8 / GGUF), and the comfortable amount. */
  minVramGB: number;
  recVramGB: number;
  /** Total download for the files listed (approx). */
  downloadGB: number;
  files: { file: string; folder: string; url: string }[];
  licence: string;
  licenceUrl: string;
  /** May the user sell / monetise what they make with the default setup? (outputs; RAIL use restrictions still apply) */
  commercialOk: boolean;
  /** Excluded from recommendations (non-commercial, house-rule ban ...); still listed so AIs can warn. */
  restricted?: string;
  settings?: string;
  page: string;
  sources: string[];
  checked: string;
}
export const IMAGE_MODELS: ImageModel[] = [
  {
    id: 'sdxl', name: 'SDXL base 1.0', good: 'All-round pictures, textures, skies. Huge ecosystem (ControlNet, IP-Adapter, LoRAs). Can\'t write text.',
    minVramGB: 6, recVramGB: 8, downloadGB: 6.9,
    files: [{ file: 'sd_xl_base_1.0.safetensors', folder: 'models/checkpoints', url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0' }],
    licence: 'CreativeML Open RAIL++-M', licenceUrl: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0', commercialOk: true,
    settings: '1024x1024 (896x1152 portrait), 25-30 steps, CFG 5-7. On 6 GB start ComfyUI with --lowvram and use 768 px.',
    page: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0', sources: ['sdxl-card', 'vtp-models'], checked: '2026-10-01',
  },
  {
    id: 'animagine-xl-4', name: 'Animagine XL 4.0 (SDXL, anime)', good: 'Anime / cel-shaded art: avatar skins, emotes, anime thumbnails. VTube Pro\'s default anime painter.',
    minVramGB: 6, recVramGB: 8, downloadGB: 6.9,
    files: [{ file: 'animagine-xl-4.0-opt.safetensors', folder: 'models/checkpoints', url: 'https://huggingface.co/cagliostrolab/animagine-xl-4.0' }],
    licence: 'CreativeML Open RAIL++-M', licenceUrl: 'https://huggingface.co/cagliostrolab/animagine-xl-4.0', commercialOk: true,
    settings: 'Same as SDXL; tag-style prompts ("1girl, silver hair, ...") work best.',
    page: 'https://huggingface.co/cagliostrolab/animagine-xl-4.0', sources: ['vtp-models'], checked: '2026-09-25',
  },
  {
    id: 'z-image-turbo', name: 'Z-Image-Turbo', good: 'Fast, sharp, photo-real or illustrated pictures in 8 steps; decent at short text. Great for thumbnails and posters.',
    minVramGB: 12, recVramGB: 16, downloadGB: 20,
    files: [
      { file: 'z_image_turbo_bf16.safetensors', folder: 'models/diffusion_models', url: 'https://huggingface.co/Comfy-Org/z_image_turbo' },
      { file: 'qwen_3_4b.safetensors', folder: 'models/text_encoders', url: 'https://huggingface.co/Comfy-Org/z_image_turbo' },
      { file: 'ae.safetensors', folder: 'models/vae', url: 'https://huggingface.co/Comfy-Org/z_image_turbo' },
    ],
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo', commercialOk: true,
    settings: '8-9 steps, guidance / CFG 1 (Turbo models: no guidance). Use ComfyUI\'s built-in Z-Image template.',
    page: 'https://docs.comfy.org/tutorials/image/z-image/z-image-turbo', sources: ['zimage-card', 'zimage-comfy'], checked: '2026-10-01',
  },
  {
    id: 'flux2-klein-4b', name: 'FLUX.2 [klein] 4B', good: 'Text-to-image AND image editing in one model, very fast (4 steps). Edit a texture with words.',
    minVramGB: 12, recVramGB: 16, downloadGB: 16,
    files: [{ file: 'FLUX.2-klein-4B (diffusion model + VAE)', folder: 'models/diffusion_models + models/vae', url: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B' }],
    licence: 'Apache-2.0 (the 4B only; FLUX.2 klein 9B is non-commercial)', licenceUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B', commercialOk: true,
    settings: '4 steps. Use ComfyUI\'s FLUX.2 klein template.',
    page: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B', sources: ['flux2klein-card'], checked: '2026-10-01',
  },
  {
    id: 'flux1-schnell', name: 'FLUX.1 [schnell]', good: 'Good prompt following in 1-4 steps. A GGUF build runs on 8 GB cards.',
    minVramGB: 8, recVramGB: 16, downloadGB: 17,
    files: [{ file: 'flux1-schnell (fp8 or GGUF Q4/Q5 + t5xxl + clip_l + ae)', folder: 'models/diffusion_models or models/unet (GGUF)', url: 'https://huggingface.co/black-forest-labs/FLUX.1-schnell' }],
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/black-forest-labs/FLUX.1-schnell', commercialOk: true,
    settings: '4 steps, CFG 1. Below 12 GB use a GGUF Q4 build with the ComfyUI-GGUF node.',
    page: 'https://huggingface.co/black-forest-labs/FLUX.1-schnell', sources: ['flux1schnell-card', 'gguf-node'], checked: '2026-10-01',
  },
  {
    id: 'qwen-image', name: 'Qwen-Image / Qwen-Image-Edit-2509 (+ Lightning 8-step)', good: 'The best open model for TEXT in images (titles, signs, logos-to-be) and for reference-faithful edits. VTube Pro\'s texture painter uses Qwen-Image-Edit.',
    minVramGB: 12, recVramGB: 24, downloadGB: 30,
    files: [
      { file: 'qwen_image_fp8_e4m3fn / qwen_image_edit_2509_fp8_e4m3fn', folder: 'models/diffusion_models', url: 'https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI' },
      { file: 'Qwen-Image-Lightning 8-step LoRA', folder: 'models/loras', url: 'https://huggingface.co/lightx2v/Qwen-Image-Lightning' },
      { file: 'qwen_2.5_vl_7b_fp8 + qwen_image_vae', folder: 'models/text_encoders + models/vae', url: 'https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI' },
    ],
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/Qwen/Qwen-Image', commercialOk: true,
    settings: 'fp8 needs ~20 GB VRAM (24 GB card). 8 steps with the Lightning LoRA (about 34 s per image on a 24 GB card). 12-16 GB: GGUF Q4 via ComfyUI-GGUF, slow.',
    page: 'https://docs.comfy.org/tutorials/image/qwen/qwen-image', sources: ['qwenimage-card', 'qwenimage-comfy', 'vtp-models'], checked: '2026-10-01',
  },
  // ---- helpers (small, used inside workflows)
  {
    id: 'realesrgan', name: 'Real-ESRGAN x4plus / x4plus_anime_6B (upscaler)', good: 'Makes a finished picture 2-4x bigger and sharper (anime_6B for drawn styles).',
    minVramGB: 2, recVramGB: 4, downloadGB: 0.1,
    files: [{ file: 'RealESRGAN_x4plus.pth / RealESRGAN_x4plus_anime_6B.pth', folder: 'models/upscale_models', url: 'https://github.com/xinntao/Real-ESRGAN/releases' }],
    licence: 'BSD-3-Clause', licenceUrl: 'https://github.com/xinntao/Real-ESRGAN', commercialOk: true,
    page: 'https://github.com/xinntao/Real-ESRGAN', sources: ['esrgan'], checked: '2026-10-01',
  },
  {
    id: 'birefnet', name: 'BiRefNet (background remover)', good: 'Cuts the subject out with a clean transparent edge: emotes, decals, stickers.',
    minVramGB: 2, recVramGB: 4, downloadGB: 0.9,
    files: [{ file: 'BiRefNet (downloaded by the ComfyUI-RMBG node on first use)', folder: 'models/RMBG', url: 'https://huggingface.co/ZhengPeng7/BiRefNet' }],
    licence: 'MIT', licenceUrl: 'https://huggingface.co/ZhengPeng7/BiRefNet', commercialOk: true,
    page: 'https://huggingface.co/ZhengPeng7/BiRefNet', sources: ['birefnet-card', 'rmbg-node'], checked: '2026-10-01',
  },
  {
    id: 'controlnet-union-sdxl', name: 'ControlNet Union SDXL ProMax (xinsir)', good: 'Keeps a picture lined up with a guide image (UV layout lines, depth, edges) so textures land on the model.',
    minVramGB: 8, recVramGB: 12, downloadGB: 2.5,
    files: [{ file: 'diffusion_pytorch_model_promax.safetensors', folder: 'models/controlnet', url: 'https://huggingface.co/xinsir/controlnet-union-sdxl-1.0' }],
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/xinsir/controlnet-union-sdxl-1.0', commercialOk: true,
    page: 'https://huggingface.co/xinsir/controlnet-union-sdxl-1.0', sources: ['vtp-models'], checked: '2026-09-25',
  },
  {
    id: 'ipadapter-plus-sdxl', name: 'IP-Adapter Plus SDXL (ViT-H)', good: 'Copies the look of a reference picture (your character sheet) into new images.',
    minVramGB: 8, recVramGB: 12, downloadGB: 3.4,
    files: [
      { file: 'ip-adapter-plus_sdxl_vit-h.safetensors', folder: 'models/ipadapter', url: 'https://huggingface.co/h94/IP-Adapter' },
      { file: 'CLIP-ViT-H-14-laion2B-s32B-b79K', folder: 'models/clip_vision', url: 'https://huggingface.co/laion/CLIP-ViT-H-14-laion2B-s32B-b79K' },
    ],
    licence: 'Apache-2.0 (adapter), MIT (CLIP-ViT-H)', licenceUrl: 'https://huggingface.co/h94/IP-Adapter', commercialOk: true,
    page: 'https://huggingface.co/h94/IP-Adapter', sources: ['vtp-models'], checked: '2026-09-25',
  },
  // ---- listed so AIs can WARN; never recommended by default
  {
    id: 'flux1-dev', name: 'FLUX.1 [dev] / FLUX.2 [dev] / FLUX.2 [klein] 9B', good: 'High quality, but the weights are under non-commercial licences.',
    minVramGB: 12, recVramGB: 24, downloadGB: 24, files: [],
    licence: 'FLUX non-commercial licences', licenceUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B', commercialOk: false,
    restricted: 'Non-commercial weights: not recommended for streamers who monetise (VTube Pro public-product rule, docs/AI_MODELS.md). Use FLUX.2 klein 4B (Apache-2.0) instead.',
    page: 'https://huggingface.co/black-forest-labs', sources: ['flux2klein-card', 'vtp-models'], checked: '2026-10-01',
  },
  {
    id: 'rmbg-2', name: 'BRIA RMBG-2.0 (background remover)', good: 'Good cut-outs, but non-commercial.',
    minVramGB: 2, recVramGB: 4, downloadGB: 0.9, files: [],
    licence: 'CC BY-NC 4.0', licenceUrl: 'https://huggingface.co/briaai/RMBG-2.0', commercialOk: false,
    restricted: 'Non-commercial (CC BY-NC 4.0). In ComfyUI-RMBG pick BiRefNet (MIT) instead.',
    page: 'https://huggingface.co/briaai/RMBG-2.0', sources: ['rmbg2-card'], checked: '2026-10-01',
  },
  {
    id: 'hunyuan', name: 'Hunyuan3D (picture to 3D character)', good: 'Only for the Character 3D recipe: your own download, never a default.',
    minVramGB: 8, recVramGB: 16, downloadGB: 4.9, files: [],
    licence: 'Tencent Hunyuan community licence (excludes the EU, UK and South Korea)', licenceUrl: 'https://huggingface.co/Comfy-Org/hunyuan3D_2.0_repackaged/blob/main/LICENSE', commercialOk: false,
    restricted: 'Territory limits: the licence does not cover the EU, the UK or South Korea, and a company with over 1 million monthly users needs Tencent\'s OK. Never recommended by default and never bundled. Only the Character 3D recipe uses it, after the user\'s own Yes and a notice. An AI may suggest it for props, creatures, mascots and non-human characters; humans and anime humans start from a proper base.',
    page: 'https://huggingface.co/Comfy-Org/hunyuan3D_2.0_repackaged', sources: ['vtp-models'], checked: '2026-10-16',
  },
];

// ---------------------------------------------------------------- ComfyUI: custom nodes the workflows need
export interface ComfyNode { id: string; name: string; why: string; repo: string; licence: string; manager: string; sources: string[] }
export const COMFY_NODES: ComfyNode[] = [
  { id: 'manager', name: 'ComfyUI-Manager', why: 'Installs the other nodes with a click ("Install Missing Custom Nodes").', repo: 'https://github.com/Comfy-Org/ComfyUI', licence: 'GPL-3.0', manager: 'Built in: Desktop has it; Portable / manual: start with --enable-manager.', sources: ['comfy-repo'] },
  { id: 'gguf', name: 'ComfyUI-GGUF', why: 'Runs big models (FLUX, Qwen-Image) as smaller GGUF files on 8-16 GB cards.', repo: 'https://github.com/city96/ComfyUI-GGUF', licence: 'Apache-2.0', manager: 'Search "ComfyUI-GGUF" in the Manager.', sources: ['gguf-node'] },
  { id: 'tiling', name: 'ComfyUI-seamless-tiling', why: 'Makes textures that repeat without seams (X / Y separately: X only for 360 skies).', repo: 'https://github.com/spinagon/ComfyUI-seamless-tiling', licence: 'GPL-3.0', manager: 'Search "seamless tiling" in the Manager.', sources: ['tiling-node'] },
  { id: 'rmbg', name: 'ComfyUI-RMBG', why: 'Background removal for emotes, decals and stickers (choose the BiRefNet model).', repo: 'https://github.com/1038lab/ComfyUI-RMBG', licence: 'GPL-3.0 (node); model licences vary: BiRefNet MIT, RMBG-2.0 non-commercial', manager: 'Search "ComfyUI-RMBG" in the Manager.', sources: ['rmbg-node', 'birefnet-card', 'rmbg2-card'] },
  { id: 'ipadapter', name: 'ComfyUI_IPAdapter_plus', why: 'Reference-image style transfer for SDXL (keep your character on-model).', repo: 'https://github.com/cubiq/ComfyUI_IPAdapter_plus', licence: 'GPL-3.0', manager: 'Search "IPAdapter plus" in the Manager.', sources: ['vtp-models'] },
];
