// Software 3D ("the browser draws 3D without the graphics card"): detection + the light preset the studio drops to.
//
// Why (2026-10-06, a Bazzite user: Chrome "stuck at 96%"): when a browser can't use the graphics card it still offers
// WebGL 2, drawn by the processor: Chrome's SwiftShader, or Mesa's llvmpipe / softpipe / lavapipe on Linux (typical: a
// Flatpak browser whose GPU driver runtime doesn't match the system's NVIDIA driver after an update, hardware
// acceleration switched off, a blocklisted driver, a VM). Everything then runs on the CPU. Measured in a muted headless
// Chrome on SwiftShader (32 threads, tools/linux_softgl_e2e.mjs): the studio kept 11-13 cores busy with the camera OFF,
// whatever the canvas size (the cost is per frame, not per pixel: ~0.35 core-seconds a frame), and the face / pose /
// hand models on the "GPU" took 500-1000 ms each. On a 6-8 core PC that is a pegged processor.
//
// What the studio does then (src/app.ts, src/tracking/delegatePolicy.ts, src/ui/softwareGlNotice.ts):
//   * graphics preset 'low' (no MSAA / post / shadows); the studio loop (tracking intake, OBS publish) at
//     SOFT_PRESET.loopFps and the studio's own preview every other loop (the "Light" preview path) at previewPixels;
//     the hidden-window ticker only after SOFT_PRESET.tickerMs without a display frame (CSS backdrop blur and the
//     canvas size measured ~no difference there: the frame rate is the lever)
//   * every tracking model on the processor (MediaPipe's CPU path is far cheaper than its WebGL path on a software GPU),
//     unless the user picked 'Graphics card' in Tracking processor
//   * a plain-language notice with how to turn the graphics card back on (Chrome / Flatpak on Linux, Windows, macOS)
// Override (localStorage vtp.softGl): 'off' = "use full quality anyway" (the notice's button), 'on' = treat this browser as
// software (tests, or a slow virtual GPU the regex doesn't know). Nothing here writes storage on its own.

/** Renderer strings of software rasterisers (WEBGL_debug_renderer_info UNMASKED_RENDERER_WEBGL / RENDERER). */
export const SOFTWARE_GL_RE = /swiftshader|llvmpipe|softpipe|lavapipe|software rasterizer|software renderer|microsoft basic render|basic render driver|gdi generic|mesa offscreen/i;

export const SOFT_GL_KEY = 'vtp.softGl';
export type SoftGlOverride = 'auto' | 'on' | 'off';

/** The light preset for a software GPU (measured: tools/linux_softgl_e2e.mjs). */
export const SOFT_PRESET = {
  /** studio preview drawing buffer, pixels (~ 730 x 410 at 16:9; the browser upscales the canvas) */
  previewPixels: 0.3e6,
  /** the studio loop per second: tracking intake, solvers, the OBS publish (the 60 Hz gate otherwise) */
  loopFps: 30,
  /** the studio's own preview per second (every other loop): CPU on a software GPU grows with this, ~linearly */
  previewFps: 15,
  /** the hidden-window ticker takes over only after this long without a display frame (45 ms otherwise: on a software
   *  GPU a slow frame alone is longer than that, and the ticker then ran a second, unrendered loop in its gaps) */
  tickerMs: 250,
} as const;

export function isSoftwareRenderer(renderer: string | null | undefined): boolean {
  return !!renderer && SOFTWARE_GL_RE.test(renderer);
}

export function parseSoftGlOverride(v: unknown): SoftGlOverride {
  return v === 'on' || v === 'off' ? v : 'auto';
}

export function readSoftGlOverride(): SoftGlOverride {
  try { return parseSoftGlOverride(globalThis.localStorage?.getItem(SOFT_GL_KEY)); } catch { return 'auto'; }
}

export interface SoftGlState {
  /** the light preset applies (software renderer and not overridden 'off', or forced 'on') */
  active: boolean;
  /** the renderer really is a software one (whatever the override says) */
  software: boolean;
  /** the renderer string ('' when the browser hides it or has no WebGL 2) */
  renderer: string;
  override: SoftGlOverride;
}

/** Pure decision (tests): renderer string + override -> state. */
export function softGlState(renderer: string, override: SoftGlOverride): SoftGlState {
  const software = isSoftwareRenderer(renderer);
  return { active: override === 'on' || (software && override !== 'off'), software, renderer, override };
}

let cached: SoftGlState | null = null;

/** The renderer string of a throwaway WebGL 2 context (freed again). '' when there is none. */
function probeRenderer(): string {
  try {
    if (typeof document === 'undefined') return '';
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return r;
  } catch { return ''; }
}

/** This page's software-3D state: measured once (a throwaway context), or from a renderer string the caller has. */
export function detectSoftwareGl(renderer?: string): SoftGlState {
  if (cached && renderer === undefined) return cached;
  cached = softGlState(renderer ?? probeRenderer(), readSoftGlOverride());
  return cached;
}

/** The state measured so far, without probing (null = nobody asked yet). */
export function softGlKnown(): SoftGlState | null { return cached; }

/** Tests only. */
export function resetSoftGlForTests(s: SoftGlState | null = null) { cached = s; }

export type HelpOs = 'linux' | 'windows' | 'mac' | 'chromeos' | 'other';
export type HelpBrowser = 'chrome' | 'chromium' | 'edge' | 'brave' | 'opera' | 'vivaldi' | 'firefox' | 'safari' | 'other';

export function helpTarget(ua: string): { os: HelpOs; browser: HelpBrowser } {
  const os: HelpOs = /CrOS/.test(ua) ? 'chromeos' : /Android/.test(ua) ? 'other' : /Linux|X11/.test(ua) ? 'linux' : /Windows/.test(ua) ? 'windows' : /Mac OS X|Macintosh/.test(ua) ? 'mac' : 'other';
  const browser: HelpBrowser = /Firefox\//.test(ua) ? 'firefox' : /Edg\//.test(ua) ? 'edge' : /OPR\//.test(ua) ? 'opera' : /Vivaldi\//.test(ua) ? 'vivaldi'
    : /Brave\//.test(ua) ? 'brave' : /Chromium\//.test(ua) ? 'chromium' : /Chrome\//.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'other';
  return { os, browser };
}

/** Flathub ids of the common browsers (for the `flatpak override` line). */
const FLATPAK_ID: Partial<Record<HelpBrowser, string>> = {
  chrome: 'com.google.Chrome', chromium: 'org.chromium.Chromium', edge: 'com.microsoft.Edge', brave: 'com.brave.Browser',
  opera: 'com.opera.Opera', vivaldi: 'com.vivaldi.Vivaldi', firefox: 'org.mozilla.firefox',
};

export interface HelpStep { text: string; code?: string }

/** The one most likely fix, as ONE plain sentence (+ the address / command it names, for a Copy button). The notice
 *  leads with this (zero-effort rule); softwareGlHelp() is the "more ways" list behind it. */
export function softwareGlQuickFix(ua: string, brave = false): HelpStep {
  const t = helpTarget(ua);
  const browser: HelpBrowser = brave && (t.browser === 'chrome' || t.browser === 'chromium') ? 'brave' : t.browser;
  if (browser === 'firefox') return { text: 'To fix it, open about:preferences, search "hardware acceleration", switch it on and restart Firefox.', code: 'about:preferences' };
  if (browser === 'safari') return { text: 'To fix it, restart your Mac, or use Chrome.' };
  if (t.os === 'linux') return { text: 'To fix it, run "flatpak update" if your browser is a Flatpak, then open chrome://settings/system, switch on "Use graphics acceleration when available" and press Relaunch.', code: 'chrome://settings/system' };
  return { text: 'To fix it, open chrome://settings/system, switch on "Use graphics acceleration when available" and press Relaunch.', code: 'chrome://settings/system' };
}

/**
 * What to try, most likely first, in plain words. `brave` is passed in because Brave hides itself in the user agent
 * (navigator.brave). Chromium-family browsers share chrome:// pages under their own scheme name in places, but they
 * all accept chrome://gpu and chrome://settings/system.
 */
export function softwareGlHelp(ua: string, brave = false): HelpStep[] {
  const t = helpTarget(ua);
  const browser: HelpBrowser = brave && (t.browser === 'chrome' || t.browser === 'chromium') ? 'brave' : t.browser;
  const steps: HelpStep[] = [];
  if (browser === 'firefox') {
    steps.push({ text: 'Firefox: open about:preferences, search "performance", untick "Use recommended performance settings" and tick "Use hardware acceleration when available". Restart Firefox.' });
    steps.push({ text: 'Check it: about:support should say "WebGL 2 Driver Renderer" with your graphics card, not llvmpipe.' });
  } else if (browser === 'safari') {
    steps.push({ text: 'Safari draws 3D with the graphics card by itself. Restart the Mac and try again, or try Chrome.' });
  } else {
    steps.push({ text: 'Turn on graphics acceleration: open the address below, switch on "Use graphics acceleration when available", then press Relaunch.', code: 'chrome://settings/system' });
    steps.push({ text: 'Check it: this page should say "WebGL: Hardware accelerated", not "Software only".', code: 'chrome://gpu' });
  }
  if (t.os === 'linux') {
    const id = FLATPAK_ID[browser];
    steps.push({ text: 'Linux with a Flatpak browser (Bazzite, SteamOS, Fedora Silverblue / Kinoite, Flathub installs): update it, so its graphics driver part matches your system driver (NVIDIA: this is needed after every driver update). Then restart the browser.', code: 'flatpak update' });
    if (id) steps.push({ text: 'Still software? Let the Flatpak use the graphics card (or switch on "GPU acceleration" for it in Flatseal):', code: `flatpak override --user --device=dri ${id}` });
    steps.push({ text: 'Or use the browser your Linux ships as a normal package (rpm / deb / pacman) instead of the Flatpak.' });
    steps.push({ text: 'Update your graphics driver. A virtual machine or remote desktop usually has no graphics card for the browser at all.' });
  } else if (t.os === 'windows') {
    steps.push({ text: 'Update your graphics driver from NVIDIA, AMD or Intel. Remote Desktop sessions and virtual machines usually have no graphics card for the browser.' });
  } else if (t.os === 'mac') {
    steps.push({ text: 'Update macOS. A virtual machine or screen-sharing session may have no graphics card for the browser.' });
  } else {
    steps.push({ text: 'Update your graphics driver and your browser.' });
  }
  if (browser !== 'firefox' && browser !== 'safari') {
    steps.push({ text: 'Last resort: if chrome://gpu says your card is on the blocklist, enable "Override software rendering list" here and relaunch (at your own risk).', code: 'chrome://flags/#ignore-gpu-blocklist' });
  }
  return steps;
}
