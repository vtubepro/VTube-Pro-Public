// "Open the setting for me" (the helper's side of the camera / microphone / graphics recovery). A web page can't open
// chrome://, edge://, about: or ms-settings: pages; the helper (a program on this computer) can start the user's own
// browser with that page, or the OS's privacy page. This file only PLANS the launch (which program, which arguments),
// from an allow-list: no free-form URL or path from a page ever reaches a command line. server/routes/autopilot.ts runs
// the plan; tools/autopilot_unit.ts checks every browser on every OS with a fake disk.
import { gpuSettingsUrl, osPrivacyUrl, siteSettingsUrl, type BrowserKind, type MediaKind, type OsKind } from './media.ts';

export type SettingsTarget = 'site' | 'os' | 'gpu';
export interface OpenRequest { target: SettingsTarget; kind: MediaKind; browser: BrowserKind; origin: string }
export interface OpenEnv {
  os: OsKind;
  vars: Record<string, string | undefined>;
  home: string;
  exists(p: string): boolean;
  /** a command on PATH (Linux / macOS), else null */
  which(cmd: string): string | null;
}
export type OpenPlan = { ok: true; command: string; args: string[]; url: string; says: string } | { ok: false; says: string; url: string | null };

const BROWSERS: BrowserKind[] = ['chrome', 'edge', 'brave', 'opera', 'vivaldi', 'firefox', 'safari', 'other'];
const TARGETS: SettingsTarget[] = ['site', 'os', 'gpu'];
/** The studio's origin: exact https origin or a loopback http(s) origin (the local studio). Anything else: refused. */
export function cleanOrigin(o: unknown): string | null {
  if (typeof o !== 'string' || o.length > 200) return null;
  let u: URL;
  try { u = new URL(o); } catch { return null; }
  if (u.username || u.password || u.origin !== o.replace(/\/$/, '')) return null;
  if (u.protocol === 'https:' && /^[a-z0-9.-]+$/i.test(u.hostname)) return u.origin;
  if ((u.protocol === 'http:' || u.protocol === 'https:') && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname)) return u.origin;
  return null;
}
export function parseOpenRequest(b: unknown): OpenRequest | null {
  if (!b || typeof b !== 'object') return null;
  const r = b as Record<string, unknown>;
  const target = TARGETS.find((t) => t === r.target), browser = BROWSERS.find((x) => x === r.browser);
  const kind = r.kind === 'camera' || r.kind === 'mic' ? r.kind : null;
  const origin = cleanOrigin(r.origin);
  if (!target || !browser || !kind || !origin) return null;
  return { target, kind, browser, origin };
}

const WIN_EXE: Partial<Record<BrowserKind, string[]>> = {
  chrome: ['%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe', '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe', '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe'],
  edge: ['%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe', '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe'],
  brave: ['%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', '%ProgramFiles(x86)%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  vivaldi: ['%LOCALAPPDATA%\\Vivaldi\\Application\\vivaldi.exe', '%ProgramFiles%\\Vivaldi\\Application\\vivaldi.exe'],
  opera: ['%LOCALAPPDATA%\\Programs\\Opera\\opera.exe', '%ProgramFiles%\\Opera\\opera.exe'],
  firefox: ['%ProgramFiles%\\Mozilla Firefox\\firefox.exe', '%ProgramFiles(x86)%\\Mozilla Firefox\\firefox.exe', '%LOCALAPPDATA%\\Mozilla Firefox\\firefox.exe'],
};
const MAC_APP: Partial<Record<BrowserKind, [string, string]>> = {
  chrome: ['Google Chrome', 'Google Chrome'], edge: ['Microsoft Edge', 'Microsoft Edge'], brave: ['Brave Browser', 'Brave Browser'],
  vivaldi: ['Vivaldi', 'Vivaldi'], opera: ['Opera', 'Opera'], firefox: ['Firefox', 'firefox'],
};
const LINUX_CMD: Partial<Record<BrowserKind, string[]>> = {
  chrome: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'], edge: ['microsoft-edge', 'microsoft-edge-stable'],
  brave: ['brave-browser', 'brave'], vivaldi: ['vivaldi', 'vivaldi-stable'], opera: ['opera'], firefox: ['firefox', 'firefox-esr'],
};
const FLATPAK: Partial<Record<BrowserKind, string[]>> = {
  chrome: ['com.google.Chrome', 'org.chromium.Chromium'], edge: ['com.microsoft.Edge'], brave: ['com.brave.Browser'], vivaldi: ['com.vivaldi.Vivaldi'], opera: ['com.opera.Opera'], firefox: ['org.mozilla.firefox'],
};
const expand = (p: string, vars: OpenEnv['vars']) => p.replace(/%([^%]+)%/g, (_m, k: string) => vars[k] ?? vars[k.toUpperCase()] ?? '\u0000');

/** Where the browser's program is on this computer (null = we can't find it). */
export function findBrowser(b: BrowserKind, e: OpenEnv): { command: string; pre: string[] } | null {
  if (e.os === 'win') {
    for (const p of WIN_EXE[b] ?? []) { const x = expand(p, e.vars); if (!x.includes('\u0000') && e.exists(x)) return { command: x, pre: [] }; }
    return null;
  }
  if (e.os === 'mac') {
    const a = MAC_APP[b]; if (!a) return null;
    for (const root of ['/Applications', `${e.home}/Applications`]) {
      const bin = `${root}/${a[0]}.app/Contents/MacOS/${a[1]}`;
      if (e.exists(bin)) return { command: bin, pre: [] };
    }
    return null;
  }
  if (e.os === 'linux') {
    for (const c of LINUX_CMD[b] ?? []) { const w = e.which(c); if (w) return { command: w, pre: [] }; }
    const fp = e.which('flatpak');
    if (fp) for (const id of FLATPAK[b] ?? []) if (e.exists(`/var/lib/flatpak/app/${id}`) || e.exists(`${e.home}/.local/share/flatpak/app/${id}`)) return { command: fp, pre: ['run', id] };
  }
  return null;
}
/** Is this browser a Flatpak on Linux (its camera then needs the Flatpak's device permission)? */
export function isFlatpakBrowser(b: BrowserKind, e: OpenEnv): boolean {
  if (e.os !== 'linux') return false;
  if ((LINUX_CMD[b] ?? []).some((c) => e.which(c))) return false;
  return (FLATPAK[b] ?? []).some((id) => e.exists(`/var/lib/flatpak/app/${id}`) || e.exists(`${e.home}/.local/share/flatpak/app/${id}`));
}

/** The launch for a request: a browser page (site / gpu) or the OS privacy page (os). */
export function planOpen(r: OpenRequest, e: OpenEnv): OpenPlan {
  if (r.target === 'os') {
    const url = osPrivacyUrl(e.os, r.kind);
    if (!url) return { ok: false, url: null, says: e.os === 'linux' ? 'Linux has no single privacy page: if your browser is a Flatpak, allow its camera in Flatseal; otherwise check that no other app holds the camera.' : 'We can’t open that page on this computer.' };
    if (e.os === 'win') return { ok: true, command: 'explorer.exe', args: [url], url, says: `Windows Settings opens on the ${r.kind === 'camera' ? 'camera' : 'microphone'} page.` };
    return { ok: true, command: 'open', args: [url], url, says: `System Settings opens on the ${r.kind === 'camera' ? 'Camera' : 'Microphone'} page.` };
  }
  const url = r.target === 'site' ? siteSettingsUrl(r.browser, r.origin) : gpuSettingsUrl(r.browser);
  if (!url) return { ok: false, url: null, says: r.browser === 'safari' ? 'Safari: Safari menu → Settings for This Website.' : 'We don’t know this browser’s settings page.' };
  const exe = findBrowser(r.browser, e);
  if (!exe) {
    // macOS without the app in /Applications: `open -a` still finds it by name
    const a = e.os === 'mac' ? MAC_APP[r.browser] : undefined;
    if (a) return { ok: true, command: 'open', args: ['-a', a[0], url], url, says: `${a[0]} opens its settings in a new tab.` };
    return { ok: false, url, says: 'We couldn’t find your browser’s program. Copy the address below into a new tab instead.' };
  }
  return { ok: true, command: exe.command, args: [...exe.pre, url], url, says: 'Your browser opens its settings in a new tab.' };
}
