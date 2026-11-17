// The helper's Tools list: optional programs that make VTube Pro do more (Blender, ffmpeg, local AI, OBS plugins ...).
// DATA ONLY: what each tool is for, its size and licence, the official download source, per-OS install steps and how
// the helper detects it. The helper (server/toolsCatalog.ts) runs detection on the user's own PC and never installs
// anything without an explicit "I understand" from the user; the studio page (tools.html, src/tools/main.ts) shows it.
//
// Other lanes reference entries by id (stable, never renamed): `getTool('ollama')`, `getTool('comfyui').endpoint`.
// Rules for editing this file (checked by tools/tools_catalog_unit.ts):
//   * every URL is https and its host is in the entry's `officialHosts` (no mirrors, no third-party download sites);
//   * `runnable` package-manager commands are ONLY `winget install -e --id <Id>` or `brew install [--cask] <name>`
//     (the helper opens them in a VISIBLE terminal, so the user sees and answers every prompt; nothing is pre-accepted);
//   * anything needing sudo, a pipe to a shell, or a Linux terminal is `runnable: false` (shown with a Copy button);
//   * blurbs are one plain sentence for someone "allergic to technology"; sizes are approximate and say so.

export type ToolOs = 'win' | 'mac' | 'linux';
export const TOOL_OSES: readonly ToolOs[] = ['win', 'mac', 'linux'];
export const OS_LABEL: Record<ToolOs, string> = { win: 'Windows', mac: 'macOS', linux: 'Linux' };

export type ToolCategory = '3d' | 'art' | 'video' | 'ai' | 'obs' | 'windows';
export const CATEGORY_LABEL: Record<ToolCategory, string> = {
  '3d': '3D models & avatars',
  art: '2D art & pictures',
  video: 'Video',
  ai: 'AI on your computer',
  obs: 'OBS & streaming',
  windows: 'Windows extras',
};

/** How much VTube Pro leans on it: `feature` = a VTube Pro feature needs it; `optional` = nice to have. */
export type ToolNeed = 'feature' | 'optional';

/** Output parsers (shared/toolsDetect.ts). Each one is unit-tested with real-looking output per OS. */
export type ParserId =
  | 'blender' | 'ffmpeg' | 'python' | 'ollama' | 'llamacpp'          // `<exe> --version` style text
  | 'json-version' | 'comfy-stats' | 'openai-models' | 'llama-health'  // local HTTP answers
  | 'reg-version' | 'plist-version';                                    // Windows registry / macOS Info.plist

export interface ToolStep {
  /** One plain sentence. */
  text: string;
  /** A command the user can copy (shown in a box with a Copy button). Never run by the helper from here. */
  command?: string;
  /** An official link (host must be in officialHosts). */
  url?: string;
}

export type ToolMethodKind = 'open-url' | 'package-manager';
export interface ToolMethod {
  /** Stable within the entry + OS, e.g. 'official-page', 'winget', 'brew'. */
  id: string;
  kind: ToolMethodKind;
  /** Button text, e.g. "Open the official download page". */
  label: string;
  /** open-url: the official page. */
  url?: string;
  /** package-manager: the exact command, shown to the user before anything happens. */
  command?: string;
  /** package-manager: true = the helper may open it in a visible terminal after consent; false = copy only. */
  runnable?: boolean;
  /** Needs an administrator / sudo password (said in the consent dialog). */
  admin?: boolean;
}

export interface ToolOsInfo {
  supported: boolean;
  /** When not supported: one friendly sentence why (and see `alternatives`). */
  why?: string;
  /** Step-by-step for the guide (1-5 short steps). */
  steps: ToolStep[];
  /** What the Install button can do on this OS, best first. Empty = guide only. */
  methods: ToolMethod[];
}

export interface ToolDetectExe {
  /** File names looked up on PATH (Windows also tries .exe / .cmd). */
  names: string[];
  /** Arguments that print a version and exit. Never anything that opens a window. */
  args: string[];
  parser: ParserId;
  /** Extra places, per OS. Tokens: %ProgramFiles% %ProgramFiles(x86)% %ProgramData% %LOCALAPPDATA% %APPDATA% ~ ; one `*` per segment. */
  paths?: Partial<Record<ToolOs, string[]>>;
  /** Environment variable holding an explicit path (e.g. VTP_BLENDER). */
  env?: string;
}
export interface ToolDetect {
  exe?: ToolDetectExe;
  /** Files / app bundles / folders whose presence means "installed" (no version unless `versionFrom`). */
  files?: Partial<Record<ToolOs, string[]>>;
  /** Windows: registry keys (under HKLM / HKCU) whose DisplayVersion gives the version. */
  registry?: string[];
  /** macOS: read CFBundleShortVersionString from this app's Info.plist (text plists only). */
  plist?: string;
  /** A local HTTP probe (127.0.0.1 only) that tells "running" and often the version. */
  http?: { url: string; parser: ParserId; settingKey?: 'comfyUrl' };
  /** Oldest version that works with VTube Pro (dotted, compared numerically). */
  minVersion?: string;
}

export interface ToolEndpoint {
  /** What protocol the ai-local / ai-connect lanes talk to it with. */
  kind: 'openai-compatible' | 'ollama' | 'comfyui';
  /** Default local address when the tool runs its server. */
  baseUrl: string;
  /** One sentence on how to turn the server on (if it is not on by default). */
  enable?: string;
}

export interface ToolAlternative {
  name: string;
  text: string;
  url?: string;
  os?: ToolOs[];
}

export interface ToolEntry {
  /** Stable id (other lanes reference it). */
  id: string;
  name: string;
  category: ToolCategory;
  need: ToolNeed;
  /** What it is for, in one plain sentence. */
  blurb: string;
  /** What VTube Pro does with it (one or two sentences). */
  uses: string;
  /** Approximate sizes for the user's disk. */
  size: { download: string; disk: string; note?: string };
  licence: { name: string; url: string; free: boolean };
  homepage: string;
  /** Hosts every link / download must come from. */
  officialHosts: string[];
  /** Comes with VTube Pro (nothing to install), e.g. the Blender kit. */
  included?: boolean;
  /** Other catalogue ids that must be installed first. */
  requires?: string[];
  os: Record<ToolOs, ToolOsInfo>;
  detect: ToolDetect;
  endpoint?: ToolEndpoint;
  alternatives?: ToolAlternative[];
  /** Extra guide paragraphs (plain text). */
  guide?: string[];
}

const BL = 'https://www.blender.org/download/';
const FF = 'https://ffmpeg.org/download.html';
const PY = 'https://www.python.org/downloads/';
const CF = 'https://www.comfy.org/download';
const CF_GH = 'https://github.com/comfyanonymous/ComfyUI';
const OL = 'https://ollama.com/download';
const LM = 'https://lmstudio.ai/download';
const LC = 'https://github.com/ggml-org/llama.cpp/releases';
const OBS = 'https://obsproject.com/download';
const SF = 'https://github.com/exeldro/obs-shaderfilter/releases';
const DAV = 'https://github.com/DistroAV/DistroAV/releases';
const GIMP = 'https://www.gimp.org/downloads/';
const UV = 'https://docs.astral.sh/uv/getting-started/installation/';

const page = (url: string, label = 'Open the official download page'): ToolMethod => ({ id: 'official-page', kind: 'open-url', label, url });
const winget = (id: string): ToolMethod => ({ id: 'winget', kind: 'package-manager', label: 'Install with winget (Windows’ own installer)', command: `winget install -e --id ${id}`, runnable: true });
const brew = (name: string, cask: boolean): ToolMethod => ({ id: 'brew', kind: 'package-manager', label: 'Install with Homebrew', command: `brew install ${cask ? '--cask ' : ''}${name}`, runnable: true });
const copyOnly = (id: string, label: string, command: string, admin = true): ToolMethod => ({ id, kind: 'package-manager', label, command, runnable: false, admin });

export const TOOL_CATALOG: readonly ToolEntry[] = [
  // ------------------------------------------------------------------------------------------------ 3D
  {
    id: 'blender', name: 'Blender', category: '3d', need: 'feature',
    blurb: 'A free 3D program that VTube Pro uses quietly in the background to import, fix and convert avatars and rooms.',
    uses: 'Importing FBX / OBJ / .blend models, auto-rigging, previews, and every “make it with AI” job. Without it you can still use VRM and GLB models.',
    size: { download: 'about 400 MB', disk: 'about 1.5 GB' },
    licence: { name: 'GPL-3.0 or later (free)', url: 'https://www.blender.org/about/license/', free: true },
    homepage: 'https://www.blender.org/', officialHosts: ['www.blender.org', 'blender.org', 'flathub.org', 'snapcraft.io'],
    os: {
      win: { supported: true, methods: [winget('BlenderFoundation.Blender'), page(BL)], steps: [
        { text: 'Press Install: a window opens and Windows’ own installer (winget) downloads Blender from the Blender Foundation.' },
        { text: 'Or download the Windows installer yourself from blender.org and double-click it.', url: BL },
        { text: 'When it finishes, come back here and press “Check again”.' },
      ] },
      mac: { supported: true, methods: [page(BL), brew('blender', true)], steps: [
        { text: 'Download Blender for macOS (pick Apple Silicon for M-series Macs, Intel otherwise).', url: BL },
        { text: 'Open the .dmg and drag Blender into Applications.' },
        { text: 'Have Homebrew? You can run this instead:', command: 'brew install --cask blender' },
        { text: 'Come back here and press “Check again”.' },
      ] },
      linux: { supported: true, methods: [page(BL), copyOnly('snap', 'Install with Snap', 'sudo snap install blender --classic'), copyOnly('flatpak', 'Install with Flatpak', 'flatpak install --user flathub org.blender.Blender', false)], steps: [
        { text: 'Ubuntu: copy this into a terminal:', command: 'sudo snap install blender --classic' },
        { text: 'Bazzite, SteamOS, Fedora Atomic and other read-only systems (and Mint): use Flatpak, from your app store or with:', command: 'flatpak install --user flathub org.blender.Blender' },
        { text: 'Or download the Linux .tar.xz from blender.org and unpack it into ~/Applications: VTube Pro finds it there.', url: BL },
        { text: '“Set up AI creation” (top of this page) shows the right way for your Linux and finds Blender afterwards.' },
      ] },
    },
    detect: {
      exe: { names: ['blender'], args: ['--version'], parser: 'blender', env: 'VTP_BLENDER', paths: {
        win: ['%ProgramFiles%\\Blender Foundation\\Blender*\\blender.exe', '%ProgramFiles(x86)%\\Blender Foundation\\Blender*\\blender.exe',
          '%LOCALAPPDATA%\\Programs\\Blender Foundation\\Blender*\\blender.exe', '%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\blender.exe',
          '%ProgramFiles(x86)%\\Steam\\steamapps\\common\\Blender\\blender.exe', '~\\Downloads\\blender-*\\blender.exe'],
        mac: ['/Applications/Blender.app/Contents/MacOS/Blender', '/Applications/Blender*.app/Contents/MacOS/Blender', '~/Applications/Blender*.app/Contents/MacOS/Blender',
          '~/Library/Application Support/Steam/steamapps/common/Blender/Blender.app/Contents/MacOS/Blender'],
        // (the full list, with Steam libraries, the Microsoft Store, the registry and Spotlight, is shared/blenderSetup.ts
        // BLENDER_PLACES, used by "Set up AI creation"; these are the common ones for the Tools card)
        linux: ['/snap/bin/blender', '/var/lib/flatpak/exports/bin/org.blender.Blender', '~/.local/share/flatpak/exports/bin/org.blender.Blender', '/usr/bin/blender', '/usr/local/bin/blender',
          '~/Applications/blender*/blender', '~/blender*/blender', '/opt/blender*/blender', '~/.local/share/Steam/steamapps/common/Blender/blender'],
      } },
      files: { linux: ['/var/lib/flatpak/app/org.blender.Blender', '~/.local/share/flatpak/app/org.blender.Blender'] },
      minVersion: '4.2',
    },
    guide: ['VTube Pro is tested with Blender 5.1. Blender 4.2 or newer works for importing models.',
      'The Microsoft Store copy of Blender cannot be started by other programs: install the blender.org (or winget) one as well.',
      'Already have Blender somewhere unusual? “Set up AI creation” finds it (Steam, a download folder, another drive) or lets you pick it.'],
  },
  {
    id: 'vtp-blender-kit', name: 'VTube Pro Blender kit + MCP server', category: '3d', need: 'feature', included: true, requires: ['blender'],
    blurb: 'VTube Pro’s own Blender scripts plus the “MCP server” that lets AI apps like Claude Desktop build and fix avatars for you.',
    uses: 'The scripts in VTube Pro’s blender/ folder (import, cleanup, face / hair kits, previews) and the vtube-pro MCP server (server/mcp.ts) that AI assistants connect to.',
    size: { download: 'nothing (comes with VTube Pro)', disk: 'about 2 MB', note: 'Needs Blender for the 3D parts.' },
    licence: { name: 'Free, noncommercial source-available licence (VTube Pro)', url: 'https://github.com/vtubepro/VTube-Pro-Public', free: true },
    homepage: 'https://github.com/vtubepro/VTube-Pro-Public', officialHosts: ['www.gnu.org', 'github.com', 'modelcontextprotocol.io'],
    os: {
      win: { supported: true, methods: [], steps: [
        { text: 'Nothing to install: it comes with VTube Pro. Install Blender (above) so the 3D parts work.' },
        { text: 'Press “Set up AI creation” at the top of this page: it adds VTube Pro to your AI apps (Claude, ChatGPT / Codex, Cursor, VS Code, Gemini CLI ...) and checks that it works.' },
      ] },
      mac: { supported: true, methods: [], steps: [
        { text: 'Nothing to install: it comes with VTube Pro. Install Blender (above) so the 3D parts work.' },
        { text: 'Press “Set up AI creation” at the top of this page: it adds VTube Pro to your AI apps (Claude, ChatGPT / Codex, Cursor, VS Code, Gemini CLI ...) and checks that it works.' },
      ] },
      linux: { supported: true, methods: [], steps: [
        { text: 'Nothing to install: it comes with VTube Pro. Install Blender (above) so the 3D parts work.' },
        { text: 'Press “Set up AI creation” at the top of this page: it adds VTube Pro to your AI apps (Claude, ChatGPT / Codex, Cursor, VS Code, Gemini CLI ...) and checks that it works.' },
      ] },
    },
    detect: { files: { win: ['@helper/blender/common.py', '@helper/server/mcp.ts'], mac: ['@helper/blender/common.py', '@helper/server/mcp.ts'], linux: ['@helper/blender/common.py', '@helper/server/mcp.ts'] } },
    alternatives: [{ name: 'blender-mcp (live Blender window)', text: 'An optional third-party add-on that lets an AI drive a Blender window you can watch. Not needed for normal use; VTube Pro installs it only when you say yes (Connect your AI page, or the 3D version drawer of a 2D avatar).', url: 'https://github.com/ahujasid/mcp-for-blender' }],
    guide: ['The MCP server only talks to VTube Pro on this computer (127.0.0.1). Your AI app asks before it changes anything live.'],
  },
  // ------------------------------------------------------------------------------------------------ 2D art (lane aiskills)
  {
    id: 'gimp', name: 'GIMP', category: 'art', need: 'optional',
    blurb: 'A free, open-source alternative to Photoshop that your AI can use to make layered art for Pro2D avatars.',
    uses: 'Layered PSD art for the Pro2D maker, made by you or by your AI through the GIMP MCP (Create > Connect your AI > Make your AI better).',
    size: { download: 'about 350 MB', disk: 'about 1 GB' },
    licence: { name: 'GPL-3.0 or later (free)', url: 'https://www.gimp.org/about/COPYING', free: true },
    homepage: 'https://www.gimp.org/', officialHosts: ['www.gimp.org', 'gimp.org', 'flathub.org'],
    os: {
      win: { supported: true, methods: [winget('GIMP.GIMP.3'), page(GIMP)], steps: [
        { text: 'Press Install: a window opens and Windows’ own installer (winget) downloads GIMP from the GIMP team.' },
        { text: 'Or download the Windows installer yourself from gimp.org and double-click it.', url: GIMP },
        { text: 'Open GIMP once, then come back here and press “Check again”.' },
      ] },
      mac: { supported: true, methods: [page(GIMP), brew('gimp', true)], steps: [
        { text: 'Download GIMP for macOS from gimp.org, open the .dmg and drag GIMP into Applications.', url: GIMP },
        { text: 'Have Homebrew? You can run this instead:', command: 'brew install --cask gimp' },
        { text: 'Open GIMP once, then press “Check again”.' },
      ] },
      linux: { supported: true, methods: [copyOnly('flatpak', 'Install with Flatpak', 'flatpak install --user flathub org.gimp.GIMP', false), page(GIMP)], steps: [
        { text: 'Install the official Flatpak from your app store, or copy this into a terminal:', command: 'flatpak install --user flathub org.gimp.GIMP' },
        { text: 'Open GIMP once, then press “Check again”.' },
      ] },
    },
    detect: {
      files: {
        win: ['%ProgramFiles%\\GIMP 3\\bin\\gimp-3.exe', '%LOCALAPPDATA%\\Programs\\GIMP 3\\bin\\gimp-3.exe'],
        mac: ['/Applications/GIMP.app', '~/Applications/GIMP.app'],
        linux: ['/usr/bin/gimp', '/var/lib/flatpak/app/org.gimp.GIMP', '~/.local/share/flatpak/app/org.gimp.GIMP', '/snap/bin/gimp'],
      },
      registry: ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GIMP-3_is1', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GIMP-3_is1'],
      plist: '/Applications/GIMP.app/Contents/Info.plist',
      minVersion: '3.2',
    },
    guide: ['The GIMP MCP (the part that lets an AI drive GIMP) needs GIMP 3.2 or newer.'],
  },
  // ------------------------------------------------------------------------------------------------ video
  {
    id: 'ffmpeg', name: 'FFmpeg', category: 'video', need: 'optional',
    blurb: 'A free video tool that lets VTube Pro show a game or app window on the in-room screen quickly and smoothly.',
    uses: 'The fast window feed for the react screen (Windows: FFmpeg 8.1+ with “gfxcapture”), and converting videos for the screen library.',
    size: { download: 'about 100 MB', disk: 'about 300 MB' },
    licence: { name: 'LGPL-2.1+ / GPL (depends on the build, free)', url: 'https://ffmpeg.org/legal.html', free: true },
    homepage: 'https://ffmpeg.org/', officialHosts: ['ffmpeg.org', 'www.gyan.dev', 'evermeet.cx', 'johnvansickle.com'],
    os: {
      win: { supported: true, methods: [winget('Gyan.FFmpeg'), page(FF)], steps: [
        { text: 'Press Install: a window opens and winget installs the FFmpeg build that ffmpeg.org links for Windows (gyan.dev).' },
        { text: 'Restart VTube Pro afterwards so it sees the new program.' },
        { text: 'The fast window feed needs FFmpeg 8.1 or newer; older versions still convert videos.' },
      ] },
      mac: { supported: true, methods: [brew('ffmpeg', false), page(FF)], steps: [
        { text: 'With Homebrew, copy this into Terminal:', command: 'brew install ffmpeg' },
        { text: 'No Homebrew? ffmpeg.org links ready-made macOS builds.', url: FF },
      ] },
      linux: { supported: true, methods: [copyOnly('apt', 'Install with apt (Ubuntu / Debian)', 'sudo apt install ffmpeg'), copyOnly('dnf', 'Install with dnf (Fedora)', 'sudo dnf install ffmpeg-free'), page(FF)], steps: [
        { text: 'Ubuntu / Debian / Mint:', command: 'sudo apt install ffmpeg' },
        { text: 'Fedora:', command: 'sudo dnf install ffmpeg-free' },
        { text: 'Arch:', command: 'sudo pacman -S ffmpeg' },
      ] },
    },
    detect: {
      exe: { names: ['ffmpeg'], args: ['-hide_banner', '-version'], parser: 'ffmpeg', env: 'VTP_FFMPEG', paths: {
        win: ['%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\ffmpeg.exe', '%ProgramFiles%\\ffmpeg\\bin\\ffmpeg.exe', '~\\scoop\\shims\\ffmpeg.exe', 'C:\\ffmpeg\\bin\\ffmpeg.exe'],
        mac: ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'],
        linux: ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/snap/bin/ffmpeg'],
      } },
    },
  },
  // ------------------------------------------------------------------------------------------------ Windows extras
  {
    id: 'python-spout', name: 'Python (for Spout2)', category: 'windows', need: 'optional',
    blurb: 'Lets VTube Pro bring in a model from VSeeFace, VTube Studio, Warudo and similar apps with a clean see-through background.',
    uses: 'Runs VTube Pro’s tiny Spout2 receiver (tools/spout/spout_rx.py, nothing else to install). Any Python 3.8 or newer works.',
    size: { download: 'about 30 MB', disk: 'about 100 MB' },
    licence: { name: 'PSF License (free)', url: 'https://docs.python.org/3/license.html', free: true },
    homepage: 'https://www.python.org/', officialHosts: ['www.python.org', 'python.org', 'docs.python.org', 'apps.microsoft.com', 'obsproject.com', 'github.com', 'ndi.video'],
    os: {
      win: { supported: true, methods: [winget('Python.Python.3.13'), page(PY)], steps: [
        { text: 'Press Install: a window opens and winget installs Python from python.org.' },
        { text: 'Or download it from python.org; tick “Add python.exe to PATH” on the first screen.', url: PY },
        { text: 'Restart VTube Pro, then pick ✨ Spout2 in Multiplayer → How you appear.' },
      ] },
      mac: { supported: false, why: 'Spout2 is a Windows-only way for apps to share video, so this isn’t needed on a Mac.', methods: [], steps: [
        { text: 'Use one of the options below instead. The OBS Browser Source is the easiest and keeps the see-through background.' },
      ] },
      linux: { supported: false, why: 'Spout2 is a Windows-only way for apps to share video, so this isn’t needed on Linux.', methods: [], steps: [
        { text: 'Use one of the options below instead. The OBS Browser Source is the easiest and keeps the see-through background.' },
      ] },
    },
    detect: {
      exe: { names: ['py', 'python', 'python3'], args: ['--version'], parser: 'python', env: 'VTP_SPOUT_PYTHON', paths: {
        win: ['%LOCALAPPDATA%\\Programs\\Python\\Python3*\\python.exe', '%ProgramFiles%\\Python3*\\python.exe'],
      } },
      minVersion: '3.8',
    },
    alternatives: [
      { name: 'OBS Browser Source (recommended)', text: 'Add VTube Pro’s output page to OBS as a Browser Source: see-through background, every OS, nothing to install.', url: 'https://obsproject.com/kb/browser-source' },
      { name: 'Syphon (macOS)', text: 'The Mac version of Spout. OBS on macOS can capture Syphon apps with its built-in “Syphon Client” source.', os: ['mac'] },
      { name: 'NDI with DistroAV', text: 'Send video between apps and computers over the network with the free DistroAV OBS plugin (see below).', url: 'https://github.com/DistroAV/DistroAV' },
      { name: 'OBS Virtual Camera', text: 'Built into OBS on every OS. No see-through background, but works with any app that takes a webcam.' },
    ],
  },
  // ------------------------------------------------------------------------------------------------ AI
  {
    id: 'comfyui', name: 'ComfyUI', category: 'ai', need: 'optional',
    blurb: 'A free picture-making AI that runs on your own graphics card, for textures, room art and thumbnails.',
    uses: 'Texture and art generation in the creation tools. Ready-made VTube Pro workflows (thumbnails, emotes, overlays, room art) set themselves up on VTube Pro’s ComfyUI workflows page, or when you ask your AI.',
    size: { download: 'about 200 MB app', disk: '10–30 GB', note: 'It downloads its own Python and AI models; each model is 2–25 GB.' },
    licence: { name: 'GPL-3.0 (free)', url: 'https://github.com/comfyanonymous/ComfyUI/blob/master/LICENSE', free: true },
    homepage: 'https://www.comfy.org/', officialHosts: ['www.comfy.org', 'comfy.org', 'docs.comfy.org', 'github.com'],
    os: {
      win: { supported: true, methods: [page(CF, 'Open the ComfyUI download page'), winget('Comfy.ComfyUI-Desktop')], steps: [
        { text: 'Download ComfyUI Desktop for Windows (best with an NVIDIA graphics card).', url: CF },
        { text: 'Run it and let it finish its first-time setup (it downloads a lot: leave it running).' },
        { text: 'Leave ComfyUI open, then press “Check again” here.' },
      ] },
      mac: { supported: true, methods: [page(CF, 'Open the ComfyUI download page')], steps: [
        { text: 'Download ComfyUI Desktop for macOS (Apple Silicon Macs).', url: CF },
        { text: 'Open the .dmg, drag ComfyUI to Applications, open it and let setup finish.' },
        { text: 'Leave ComfyUI open, then press “Check again” here.' },
      ] },
      linux: { supported: true, methods: [page(CF_GH, 'Open the official install guide')], steps: [
        { text: 'Linux uses the manual install from the official GitHub page (needs git and Python).', url: CF_GH },
        { text: 'Start it with', command: 'python main.py' },
        { text: 'Leave it running, then press “Check again” here.' },
      ] },
    },
    detect: {
      files: {
        win: ['%LOCALAPPDATA%\\Programs\\@comfyorgcomfyui-electron\\ComfyUI.exe', '%LOCALAPPDATA%\\Programs\\ComfyUI\\ComfyUI.exe'],
        mac: ['/Applications/ComfyUI.app'],
        linux: ['~/ComfyUI/main.py'],
      },
      http: { url: 'http://127.0.0.1:8188/system_stats', parser: 'comfy-stats', settingKey: 'comfyUrl' },
    },
    endpoint: { kind: 'comfyui', baseUrl: 'http://127.0.0.1:8188', enable: 'Just keep ComfyUI open; it listens on this computer only.' },
  },
  {
    id: 'uv', name: 'uv (Python runner)', category: 'ai', need: 'optional',
    blurb: 'A small free program that runs the Blender and GIMP helpers your AI can use, each in its own tidy folder.',
    uses: 'Starts the Blender MCP and the GIMP MCP for your AI apps (Create > Connect your AI > Make your AI better). VTube Pro itself does not need it.',
    size: { download: 'about 20 MB', disk: 'about 50 MB', note: 'Plus the Python pieces each helper downloads the first time (about 100 MB).' },
    licence: { name: 'MIT or Apache-2.0 (free)', url: 'https://github.com/astral-sh/uv/blob/main/LICENSE-MIT', free: true },
    homepage: 'https://docs.astral.sh/uv/', officialHosts: ['docs.astral.sh', 'astral.sh', 'github.com'],
    os: {
      win: { supported: true, methods: [winget('astral-sh.uv'), page(UV, 'Open the official install page')], steps: [
        { text: 'Press Install: a window opens and winget installs uv from Astral, its maker.' },
        { text: 'Then press “Check again”.' },
      ] },
      mac: { supported: true, methods: [brew('uv', false), page(UV, 'Open the official install page')], steps: [
        { text: 'With Homebrew:', command: 'brew install uv' },
        { text: 'No Homebrew? The official page has the installer.', url: UV },
      ] },
      linux: { supported: true, methods: [copyOnly('script', 'Install with the official script', 'curl -LsSf https://astral.sh/uv/install.sh | sh', false), page(UV, 'Open the official install page')], steps: [
        { text: 'Copy this into a terminal (the official installer from astral.sh; it installs into your home folder, no password):', command: 'curl -LsSf https://astral.sh/uv/install.sh | sh' },
        { text: 'Then press “Check again”.' },
      ] },
    },
    detect: {
      files: {
        win: ['~\\.local\\bin\\uv.exe', '%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\uv.exe', '~\\.cargo\\bin\\uv.exe'],
        mac: ['~/.local/bin/uv', '/opt/homebrew/bin/uv', '/usr/local/bin/uv', '~/.cargo/bin/uv'],
        linux: ['~/.local/bin/uv', '~/.cargo/bin/uv', '/usr/local/bin/uv', '/usr/bin/uv', '/home/linuxbrew/.linuxbrew/bin/uv'],
      },
    },
  },
  {
    id: 'ollama', name: 'Ollama', category: 'ai', need: 'optional',
    blurb: 'The simplest way to run a chat AI on your own computer, free and private.',
    uses: 'A local AI for VTube Pro (chat, co-host, creation help) with no account and no API key. The local-model scan recommends a model for your hardware.',
    size: { download: 'about 1 GB', disk: 'about 2 GB', note: 'Plus the AI models you pick: 2–40 GB each.' },
    licence: { name: 'MIT (free)', url: 'https://github.com/ollama/ollama/blob/main/LICENSE', free: true },
    homepage: 'https://ollama.com/', officialHosts: ['ollama.com', 'github.com'],
    os: {
      win: { supported: true, methods: [winget('Ollama.Ollama'), page(OL)], steps: [
        { text: 'Press Install (winget), or download the Windows installer from ollama.com.', url: OL },
        { text: 'Ollama starts by itself and sits in the tray.' },
        { text: 'Press “Check again” here, then pick a model in AI → Local models.' },
      ] },
      mac: { supported: true, methods: [page(OL), brew('ollama-app', true)], steps: [
        { text: 'Download Ollama for macOS from ollama.com and drag it to Applications.', url: OL },
        { text: 'Open it once so it can start in the background.' },
        { text: 'Press “Check again” here.' },
      ] },
      linux: { supported: true, methods: [copyOnly('script', 'Install with the official script', 'curl -fsSL https://ollama.com/install.sh | sh'), page(OL)], steps: [
        { text: 'Copy this into a terminal (the official install script from ollama.com):', command: 'curl -fsSL https://ollama.com/install.sh | sh' },
        { text: 'It asks for your password and sets Ollama up to start by itself.' },
        { text: 'Press “Check again” here.' },
      ] },
    },
    detect: {
      exe: { names: ['ollama'], args: ['--version'], parser: 'ollama', paths: {
        win: ['%LOCALAPPDATA%\\Programs\\Ollama\\ollama.exe'],
        mac: ['/Applications/Ollama.app/Contents/Resources/ollama', '/opt/homebrew/bin/ollama', '/usr/local/bin/ollama'],
        linux: ['/usr/local/bin/ollama', '/usr/bin/ollama'],
      } },
      http: { url: 'http://127.0.0.1:11434/api/version', parser: 'json-version' },
    },
    endpoint: { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enable: 'On by default while Ollama runs. OpenAI-compatible at http://127.0.0.1:11434/v1.' },
  },
  {
    id: 'lmstudio', name: 'LM Studio', category: 'ai', need: 'optional',
    blurb: 'A friendly app for finding and running chat AIs on your own computer, with a built-in model browser.',
    uses: 'A local AI for VTube Pro through LM Studio’s local server (OpenAI-compatible). Good if you like picking models with a mouse.',
    size: { download: 'about 500 MB', disk: 'about 1.5 GB', note: 'Plus the AI models you pick: 2–40 GB each.' },
    licence: { name: 'Free to use, closed source (LM Studio terms)', url: 'https://lmstudio.ai/app-terms', free: true },
    homepage: 'https://lmstudio.ai/', officialHosts: ['lmstudio.ai', 'installers.lmstudio.ai'],
    os: {
      win: { supported: true, methods: [winget('ElementLabs.LMStudio'), page(LM)], steps: [
        { text: 'Press Install (winget), or download LM Studio for Windows.', url: LM },
        { text: 'In LM Studio, download a model, then open the Developer tab and switch “Start server” on.' },
        { text: 'Press “Check again” here.' },
      ] },
      mac: { supported: true, methods: [page(LM), brew('lm-studio', true)], steps: [
        { text: 'Download LM Studio for macOS (Apple Silicon).', url: LM },
        { text: 'In LM Studio, download a model, then open the Developer tab and switch “Start server” on.' },
        { text: 'Press “Check again” here.' },
      ] },
      linux: { supported: true, methods: [page(LM)], steps: [
        { text: 'Download the Linux AppImage from lmstudio.ai.', url: LM },
        { text: 'Make it runnable (right-click → Properties → Allow executing) and open it.' },
        { text: 'Download a model, open the Developer tab and switch “Start server” on, then press “Check again”.' },
      ] },
    },
    detect: {
      files: {
        win: ['%LOCALAPPDATA%\\Programs\\LM Studio\\LM Studio.exe', '%LOCALAPPDATA%\\Programs\\lm-studio\\LM Studio.exe', '~\\.lmstudio\\bin\\lms.exe'],
        mac: ['/Applications/LM Studio.app', '~/.lmstudio/bin/lms'],
        linux: ['~/.lmstudio/bin/lms'],
      },
      plist: '/Applications/LM Studio.app/Contents/Info.plist',
      http: { url: 'http://127.0.0.1:1234/v1/models', parser: 'openai-models' },
    },
    endpoint: { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', enable: 'In LM Studio: Developer tab → Start server.' },
  },
  {
    id: 'llamacpp', name: 'llama.cpp', category: 'ai', need: 'optional',
    blurb: 'A small, fast program for running chat AIs, for people who are happy with a command line.',
    uses: 'A local AI for VTube Pro through llama-server (OpenAI-compatible). The leanest option on older or smaller PCs.',
    size: { download: '50–500 MB (depends on your graphics card)', disk: '50–500 MB', note: 'Plus the AI models (GGUF files): 2–40 GB each.' },
    licence: { name: 'MIT (free)', url: 'https://github.com/ggml-org/llama.cpp/blob/master/LICENSE', free: true },
    homepage: 'https://github.com/ggml-org/llama.cpp', officialHosts: ['github.com'],
    os: {
      win: { supported: true, methods: [winget('ggml.llamacpp'), page(LC, 'Open the official releases page')], steps: [
        { text: 'Press Install (winget), or download a ready-made zip from the official releases page (pick “cuda” for NVIDIA, “vulkan” for AMD / Intel).', url: LC },
        { text: 'Start the server with a model you downloaded:', command: 'llama-server -m your-model.gguf --port 8080' },
        { text: 'Press “Check again” here while it runs.' },
      ] },
      mac: { supported: true, methods: [brew('llama.cpp', false), page(LC, 'Open the official releases page')], steps: [
        { text: 'With Homebrew:', command: 'brew install llama.cpp' },
        { text: 'Start the server with a model you downloaded:', command: 'llama-server -m your-model.gguf --port 8080' },
        { text: 'Press “Check again” here while it runs.' },
      ] },
      linux: { supported: true, methods: [page(LC, 'Open the official releases page'), copyOnly('brew', 'Install with Homebrew on Linux', 'brew install llama.cpp', false)], steps: [
        { text: 'Download a ready-made build from the official releases page, or use Homebrew:', url: LC, command: 'brew install llama.cpp' },
        { text: 'Start the server with a model you downloaded:', command: 'llama-server -m your-model.gguf --port 8080' },
        { text: 'Press “Check again” here while it runs.' },
      ] },
    },
    detect: {
      exe: { names: ['llama-server', 'llama-cli'], args: ['--version'], parser: 'llamacpp', paths: {
        win: ['%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\llama-server.exe'],
        mac: ['/opt/homebrew/bin/llama-server', '/usr/local/bin/llama-server'],
        linux: ['/home/linuxbrew/.linuxbrew/bin/llama-server', '/usr/local/bin/llama-server'],
      } },
      http: { url: 'http://127.0.0.1:8080/health', parser: 'llama-health' },
    },
    endpoint: { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1', enable: 'Run llama-server with your model (port 8080 by default).' },
  },
  // ------------------------------------------------------------------------------------------------ OBS
  {
    id: 'obs', name: 'OBS Studio', category: 'obs', need: 'feature',
    blurb: 'The free streaming app most VTubers use; VTube Pro shows up in it as a see-through layer.',
    uses: 'Your stream: add VTube Pro’s output page as a Browser Source. Optional OBS automation switches scenes and fits your game window onto the in-room screen.',
    size: { download: 'about 150 MB', disk: 'about 450 MB' },
    licence: { name: 'GPL-2.0 or later (free)', url: 'https://github.com/obsproject/obs-studio/blob/master/COPYING', free: true },
    homepage: 'https://obsproject.com/', officialHosts: ['obsproject.com', 'flathub.org', 'github.com'],
    os: {
      win: { supported: true, methods: [winget('OBSProject.OBSStudio'), page(OBS)], steps: [
        { text: 'Press Install (winget), or download the Windows installer from obsproject.com.', url: OBS },
        { text: 'In OBS: Sources → + → Browser, and paste VTube Pro’s output address (Settings → OBS shows it with a Copy button).' },
      ] },
      mac: { supported: true, methods: [page(OBS), brew('obs', true)], steps: [
        { text: 'Download OBS for macOS from obsproject.com and drag it to Applications.', url: OBS },
        { text: 'In OBS: Sources → + → Browser, and paste VTube Pro’s output address.' },
      ] },
      linux: { supported: true, methods: [copyOnly('flatpak', 'Install with Flatpak', 'flatpak install flathub com.obsproject.Studio', false), page(OBS)], steps: [
        { text: 'Copy this into a terminal (the official Flatpak):', command: 'flatpak install flathub com.obsproject.Studio' },
        { text: 'Ubuntu also has the official OBS PPA; see obsproject.com.', url: OBS },
        { text: 'In OBS: Sources → + → Browser, and paste VTube Pro’s output address.' },
      ] },
    },
    detect: {
      files: {
        win: ['%ProgramFiles%\\obs-studio\\bin\\64bit\\obs64.exe'],
        mac: ['/Applications/OBS.app'],
        linux: ['/usr/bin/obs', '/var/lib/flatpak/app/com.obsproject.Studio', '~/.local/share/flatpak/app/com.obsproject.Studio'],
      },
      registry: ['HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OBS Studio', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OBS Studio'],
      plist: '/Applications/OBS.app/Contents/Info.plist',
      minVersion: '28',
    },
  },
  {
    id: 'obs-websocket', name: 'OBS WebSocket', category: 'obs', need: 'optional', included: true, requires: ['obs'],
    blurb: 'A switch inside OBS that lets VTube Pro change scenes and line up your game window for you.',
    uses: 'OBS automation (Scene tab): scene switching on mode changes and fitting the capture onto the in-room screen. Built into OBS 28 and newer.',
    size: { download: 'nothing (built into OBS 28+)', disk: 'nothing extra' },
    licence: { name: 'GPL-2.0 (part of OBS, free)', url: 'https://github.com/obsproject/obs-websocket', free: true },
    homepage: 'https://github.com/obsproject/obs-websocket', officialHosts: ['github.com', 'obsproject.com'],
    os: {
      win: { supported: true, methods: [], steps: [
        { text: 'In OBS: Tools → WebSocket Server Settings → tick “Enable WebSocket server”.' },
        { text: 'Press “Show Connect Info”, then paste the password into VTube Pro: Scene tab → OBS automation.' },
      ] },
      mac: { supported: true, methods: [], steps: [
        { text: 'In OBS: Tools → WebSocket Server Settings → tick “Enable WebSocket server”.' },
        { text: 'Press “Show Connect Info”, then paste the password into VTube Pro: Scene tab → OBS automation.' },
      ] },
      linux: { supported: true, methods: [], steps: [
        { text: 'In OBS: Tools → WebSocket Server Settings → tick “Enable WebSocket server”.' },
        { text: 'Press “Show Connect Info”, then paste the password into VTube Pro: Scene tab → OBS automation.' },
      ] },
    },
    detect: {},
  },
  {
    id: 'obs-shaderfilter', name: 'obs-shaderfilter', category: 'obs', need: 'optional', requires: ['obs'],
    blurb: 'A small free OBS plugin that bends your game window so it sits perfectly on an angled screen in the room.',
    uses: 'OBS automation’s “perspective corner-pin”. Without it VTube Pro uses the closest straight box instead.',
    size: { download: 'under 5 MB', disk: 'under 10 MB' },
    licence: { name: 'GPL-2.0 (free, by exeldro)', url: 'https://github.com/exeldro/obs-shaderfilter/blob/master/LICENSE', free: true },
    homepage: 'https://github.com/exeldro/obs-shaderfilter', officialHosts: ['github.com', 'obsproject.com'],
    os: {
      win: { supported: true, methods: [page(SF, 'Open the official releases page')], steps: [
        { text: 'Close OBS. Download the Windows installer (or zip) from the official releases page.', url: SF },
        { text: 'Run the installer (it finds OBS by itself), then start OBS again.' },
        { text: 'Press “Check again” here.' },
      ] },
      mac: { supported: true, methods: [page(SF, 'Open the official releases page')], steps: [
        { text: 'Close OBS. Download the macOS .pkg from the official releases page and open it.', url: SF },
        { text: 'Start OBS again, then press “Check again” here.' },
      ] },
      linux: { supported: true, methods: [page(SF, 'Open the official releases page')], steps: [
        { text: 'Download the Linux build from the official releases page and follow its README, or build it from source.', url: SF },
        { text: 'Start OBS again, then press “Check again” here.' },
      ] },
    },
    detect: {
      files: {
        win: ['%ProgramFiles%\\obs-studio\\obs-plugins\\64bit\\obs-shaderfilter.dll', '%ProgramData%\\obs-studio\\plugins\\obs-shaderfilter\\bin\\64bit\\obs-shaderfilter.dll'],
        mac: ['~/Library/Application Support/obs-studio/plugins/obs-shaderfilter.plugin', '/Library/Application Support/obs-studio/plugins/obs-shaderfilter.plugin'],
        linux: ['~/.config/obs-studio/plugins/obs-shaderfilter', '/usr/lib/x86_64-linux-gnu/obs-plugins/obs-shaderfilter.so', '/usr/lib/obs-plugins/obs-shaderfilter.so', '/usr/lib64/obs-plugins/obs-shaderfilter.so'],
      },
    },
  },
  {
    id: 'distroav', name: 'DistroAV (NDI for OBS)', category: 'obs', need: 'optional', requires: ['obs'],
    blurb: 'A free OBS plugin for sending video between apps and computers over your network (NDI).',
    uses: 'The Mac / Linux-friendly alternative to Spout2, and a way to move video between two PCs. VTube Pro itself doesn’t need it.',
    size: { download: 'about 10 MB + the NDI Runtime (about 50 MB)', disk: 'about 100 MB' },
    licence: { name: 'GPL-2.0 (free); the NDI Runtime has its own free licence', url: 'https://github.com/DistroAV/DistroAV/blob/master/LICENSE', free: true },
    homepage: 'https://github.com/DistroAV/DistroAV', officialHosts: ['github.com', 'ndi.video'],
    os: {
      win: { supported: true, methods: [winget('DistroAV.DistroAV'), page(DAV, 'Open the official releases page')], steps: [
        { text: 'Close OBS. Press Install (winget) or download the installer from the official releases page.', url: DAV },
        { text: 'It also needs the free NDI Runtime; the installer points you to it.' },
        { text: 'Start OBS again, then press “Check again” here.' },
      ] },
      mac: { supported: true, methods: [page(DAV, 'Open the official releases page')], steps: [
        { text: 'Close OBS. With Homebrew:', command: 'brew install --cask distroav/distroav/distroav' },
        { text: 'Or download the .pkg from the official releases page.', url: DAV },
        { text: 'Start OBS again, then press “Check again” here.' },
      ] },
      linux: { supported: true, methods: [copyOnly('flatpak', 'Install with Flatpak', 'flatpak install com.obsproject.Studio.Plugin.DistroAV', false), page(DAV, 'Open the official releases page')], steps: [
        { text: 'For the OBS Flatpak, copy this into a terminal:', command: 'flatpak install com.obsproject.Studio.Plugin.DistroAV' },
        { text: 'Ubuntu (OBS from the PPA):', command: 'sudo apt install distroav' },
        { text: 'Start OBS again, then press “Check again” here.' },
      ] },
    },
    detect: {
      files: {
        win: ['%ProgramData%\\obs-studio\\plugins\\distroav', '%ProgramFiles%\\obs-studio\\obs-plugins\\64bit\\distroav.dll'],
        mac: ['~/Library/Application Support/obs-studio/plugins/distroav.plugin', '/Library/Application Support/obs-studio/plugins/distroav.plugin'],
        linux: ['/usr/lib/x86_64-linux-gnu/obs-plugins/distroav.so', '/var/lib/flatpak/runtime/com.obsproject.Studio.Plugin.DistroAV', '~/.local/share/flatpak/runtime/com.obsproject.Studio.Plugin.DistroAV'],
      },
    },
  },
];

export const TOOL_IDS: readonly string[] = TOOL_CATALOG.map((t) => t.id);
export function getTool(id: string): ToolEntry | undefined { return TOOL_CATALOG.find((t) => t.id === id); }

// ---------------------------------------------------------------- schema check (unit-tested; also handy for lanes adding entries)
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
/** The only commands the helper will ever open in a terminal. */
export const RUNNABLE_COMMAND = /^(winget install -e --id [A-Za-z0-9][A-Za-z0-9.-]{1,80}|brew install (--cask )?[a-z0-9][a-z0-9@./-]{0,80})$/;

function hostOf(u: string): string | null { try { const x = new URL(u); return x.protocol === 'https:' ? x.hostname.toLowerCase() : null; } catch { return null; } }
/** true when `url` is https and its host is one of the entry's official hosts. */
export function isOfficialUrl(entry: Pick<ToolEntry, 'officialHosts'>, url: string): boolean {
  const h = hostOf(url);
  return !!h && entry.officialHosts.includes(h);
}

/** Every problem with the catalogue, as plain sentences (empty = fine). */
export function validateCatalog(list: readonly ToolEntry[] = TOOL_CATALOG): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const t of list) {
    const at = `"${t.id}"`;
    if (!ID_RE.test(t.id)) out.push(`${at}: bad id`);
    if (ids.has(t.id)) out.push(`${at}: duplicate id`);
    ids.add(t.id);
    if (!t.name.trim()) out.push(`${at}: no name`);
    if (!/^[A-Z].{15,170}\.$/.test(t.blurb) || /\.\s+\S/.test(t.blurb)) out.push(`${at}: blurb must be ONE plain sentence (16-170 chars, ends with a full stop)`);
    if (!CATEGORY_LABEL[t.category]) out.push(`${at}: unknown category`);
    if (!t.size.download || !t.size.disk) out.push(`${at}: size missing`);
    if (!t.licence.name || !hostOf(t.licence.url)) out.push(`${at}: licence missing`);
    if (!t.officialHosts.length) out.push(`${at}: no officialHosts`);
    for (const r of t.requires ?? []) if (!list.some((x) => x.id === r)) out.push(`${at}: requires unknown "${r}"`);
    const links: string[] = [t.homepage, ...(t.alternatives ?? []).map((a) => a.url ?? '').filter(Boolean)];
    for (const os of TOOL_OSES) {
      const o = t.os[os];
      if (!o) { out.push(`${at}: no ${os} info`); continue; }
      if (!o.steps.length) out.push(`${at}/${os}: no steps`);
      if (!o.supported && !o.why) out.push(`${at}/${os}: unsupported needs a "why"`);
      if (!o.supported && o.methods.length) out.push(`${at}/${os}: unsupported but has install methods`);
      if (o.supported && !t.included && !o.methods.length) out.push(`${at}/${os}: supported but no install method`);
      const mids = new Set<string>();
      for (const m of o.methods) {
        if (mids.has(m.id)) out.push(`${at}/${os}: duplicate method "${m.id}"`);
        mids.add(m.id);
        if (m.kind === 'open-url') {
          if (!m.url || !isOfficialUrl(t, m.url)) out.push(`${at}/${os}/${m.id}: download page is not an official https URL`);
        } else if (m.kind === 'package-manager') {
          if (!m.command) out.push(`${at}/${os}/${m.id}: no command`);
          else if (m.runnable && !RUNNABLE_COMMAND.test(m.command)) out.push(`${at}/${os}/${m.id}: runnable command is not a plain winget/brew install`);
          else if (m.runnable && (m.command.startsWith('winget') ? os !== 'win' : os !== 'mac')) out.push(`${at}/${os}/${m.id}: runnable command for the wrong OS`);
          if (m.command && /\bsudo\b|\|/.test(m.command) && m.runnable) out.push(`${at}/${os}/${m.id}: sudo / pipes are copy-only`);
        } else out.push(`${at}/${os}/${m.id}: unknown method kind`);
      }
      for (const s of o.steps) if (s.url) links.push(s.url);
    }
    for (const u of links) if (!isOfficialUrl(t, u)) out.push(`${at}: link ${u} is not on an official host`);
    if (t.endpoint && !/^http:\/\/127\.0\.0\.1:\d{2,5}(\/|$)/.test(t.endpoint.baseUrl)) out.push(`${at}: endpoint must be a 127.0.0.1 URL`);
    if (t.detect.http && !/^http:\/\/127\.0\.0\.1:\d{2,5}\//.test(t.detect.http.url)) out.push(`${at}: detect.http must be a 127.0.0.1 URL`);
    if (t.detect.exe && t.detect.exe.args.some((a) => !/^-{1,2}[a-z_-]+$/.test(a))) out.push(`${at}: version args must be plain flags`);
    if (!t.included && !t.detect.exe && !t.detect.files && !t.detect.http) out.push(`${at}: no way to detect it`);
  }
  return out;
}
