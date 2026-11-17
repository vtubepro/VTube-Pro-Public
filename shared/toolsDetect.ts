// Pure helpers for the Tools list (no node / DOM imports, so the studio, the helper and the unit tests share them):
// version parsing for every tool's output on every OS, path-token expansion, the installed / missing / outdated
// decision, path redaction for web pages, and the plain-words consent text. Detection I/O lives in
// server/toolsCatalog.ts; tests in tools/tools_catalog_unit.ts.
import { OS_LABEL, getTool, type ParserId, type ToolEntry, type ToolMethod, type ToolOs } from './toolsCatalog.ts';

export type ToolState =
  | 'installed'   // found (and new enough when we know the version)
  | 'outdated'    // found, older than detect.minVersion
  | 'missing'     // not found on this computer
  | 'included'    // comes with VTube Pro / with a tool that is installed
  | 'needs'       // included, but something it needs is missing (requires)
  | 'unsupported'; // not for this OS (see why + alternatives)

export interface ToolStatus {
  id: string;
  state: ToolState;
  version?: string;
  /** Where it was found (home folder shown as ~ for web pages). */
  path?: string;
  /** A local server answered (Ollama / LM Studio / llama.cpp / ComfyUI). */
  running?: boolean;
  /** How it was found: 'exe' | 'file' | 'http' | 'registry' | 'bundled'. */
  via?: string;
  /** One plain sentence for the card (e.g. "Found, but not running."). */
  note?: string;
  /** Missing requirement ids (state 'needs'). */
  missing?: string[];
}

export interface ToolsReport {
  v: 1;
  os: ToolOs;
  arch: string;
  checkedAt: number;
  tools: ToolStatus[];
}

// ---------------------------------------------------------------- OS
export function toolOs(platform: string): ToolOs | null {
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return 'mac';
  if (platform === 'linux') return 'linux';
  return null;
}
/** Browser guess (studio without a helper): userAgentData / userAgent / platform text. */
export function guessOsFromUa(ua: string): ToolOs {
  const s = ua.toLowerCase();
  if (/windows|win32|win64/.test(s)) return 'win';
  if (/mac os|macintosh|macintel|macos|iphone|ipad/.test(s)) return 'mac';
  return 'linux';
}

// ---------------------------------------------------------------- versions
/** "4.2.3" → [4,2,3]; anything non-numeric → [] */
export function versionParts(v: string | undefined): number[] {
  const m = String(v ?? '').match(/^\D*(\d+(?:\.\d+){0,3})/);
  return m ? m[1].split('.').map(Number) : [];
}
/** <0 a older, 0 same, >0 a newer. Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; }
  return 0;
}

export interface Parsed { ok: boolean; version?: string; running?: boolean; note?: string }

const first = (re: RegExp, s: string) => s.match(re)?.[1];

/** Parse one tool's output. `out` = stdout + stderr (or the HTTP body), `code` = exit code / HTTP status. */
export function parseOutput(parser: ParserId, out: string, code = 0): Parsed {
  const s = String(out ?? '');
  switch (parser) {
    case 'blender': {
      // "Blender 4.2.3 LTS\n\tbuild date: ..."  /  "Blender 5.1.2\n..." (Windows, macOS and Linux print the same)
      const v = first(/^\s*Blender\s+(\d+\.\d+(?:\.\d+)?)/m, s);
      return v ? { ok: true, version: v } : { ok: false };
    }
    case 'ffmpeg': {
      // "ffmpeg version 7.1-full_build-www.gyan.dev Copyright ..." / "ffmpeg version n8.1" / "ffmpeg version 6.1.1-3ubuntu5"
      // / git builds "ffmpeg version N-118000-g1234abcd" (version unknown, still installed)
      const line = s.split(/\r?\n/).find((l) => /^ffmpeg version\s/.test(l.trim()));
      if (!line || code !== 0) return { ok: false };
      const v = first(/^\s*ffmpeg version\s+n?(\d+(?:\.\d+)+|\d+)(?=[-~+_ ]|$)/, line);
      return v ? { ok: true, version: v } : { ok: true, note: 'A development build (version unknown).' };
    }
    case 'python': {
      // "Python 3.12.4"; the Windows Store stub prints "Python was not found; run without arguments to install from the
      // Microsoft Store..." with exit 9009 (not installed!). Python 2 prints "Python 2.7.18" to stderr.
      if (/was not found|Microsoft Store/i.test(s)) return { ok: false, note: 'Only the Microsoft Store shortcut is there, not Python itself.' };
      const v = first(/^\s*Python\s+(\d+\.\d+(?:\.\d+)?)/m, s);
      return v && code === 0 ? { ok: true, version: v } : { ok: false };
    }
    case 'ollama': {
      // "ollama version is 0.5.7"  /  when the server is down: "Warning: could not connect to a running Ollama instance\n
      // Warning: client version is 0.5.7"
      const v = first(/(?:ollama version is|client version is)\s+v?(\d+\.\d+\.\d+)/i, s);
      if (!v) return { ok: false };
      return /could not connect/i.test(s) ? { ok: true, version: v, running: false } : { ok: true, version: v };
    }
    case 'llamacpp': {
      // "version: 4589 (1a2b3c4d)\nbuilt with MSVC 19.42 for x64" (stderr); winget / brew name the build "b4589"
      const n = first(/version:\s*(\d+)\s*\(/, s);
      return n ? { ok: true, version: `b${n}` } : { ok: false };
    }
    case 'json-version': {
      if (code !== 200) return { ok: false };
      try { const j = JSON.parse(s) as { version?: unknown }; return typeof j.version === 'string' ? { ok: true, running: true, version: j.version.replace(/^v/, '') } : { ok: true, running: true }; } catch { return { ok: false }; }
    }
    case 'comfy-stats': {
      if (code !== 200) return { ok: false };
      try {
        const j = JSON.parse(s) as { system?: { comfyui_version?: unknown } };
        if (!j || typeof j !== 'object' || !('system' in j)) return { ok: false };
        const v = j.system?.comfyui_version;
        return { ok: true, running: true, ...(typeof v === 'string' ? { version: v.replace(/^v/, '') } : {}) };
      } catch { return { ok: false }; }
    }
    case 'openai-models': {
      if (code !== 200) return { ok: false };
      try { const j = JSON.parse(s) as { data?: unknown }; return Array.isArray(j.data) ? { ok: true, running: true, note: j.data.length ? undefined : 'Running, but no model is loaded yet.' } : { ok: false }; } catch { return { ok: false }; }
    }
    case 'llama-health': {
      // {"status":"ok"} (200) ; {"error":{"code":503,"message":"Loading model"}} (503) = running, still loading
      if (code === 200 && /"status"\s*:\s*"ok"/.test(s)) return { ok: true, running: true };
      if (code === 503 && /loading model/i.test(s)) return { ok: true, running: true, note: 'Running, still loading its model.' };
      return { ok: false };
    }
    case 'reg-version': {
      // reg query "...\OBS Studio" /v DisplayVersion →
      //   HKEY_LOCAL_MACHINE\SOFTWARE\...\OBS Studio\r\n    DisplayVersion    REG_SZ    31.0.2
      const v = first(/DisplayVersion\s+REG_SZ\s+v?(\d+(?:\.\d+)*)/i, s);
      return v && code === 0 ? { ok: true, version: v } : { ok: false };
    }
    case 'plist-version': {
      // XML Info.plist: <key>CFBundleShortVersionString</key>\n\t<string>31.0.2</string>
      const v = first(/<key>CFBundleShortVersionString<\/key>\s*<string>\s*v?(\d+(?:\.\d+)*)/, s);
      return v ? { ok: true, version: v } : { ok: false };
    }
  }
  return { ok: false };
}

// ---------------------------------------------------------------- paths
export interface PathEnv { home: string; vars: Record<string, string | undefined>; sep: '\\' | '/'; helperRoot?: string }
/** Expand %VAR% / leading ~ / @helper. Returns null when a variable is unset (that candidate is skipped). */
export function expandPath(p: string, env: PathEnv): string | null {
  let out = p;
  if (out.startsWith('@helper')) { if (!env.helperRoot) return null; out = env.helperRoot + out.slice(7); }
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) out = env.home + out.slice(1);
  let bad = false;
  out = out.replace(/%([A-Za-z_()0-9]+)%/g, (_m, k: string) => {
    const hit = Object.keys(env.vars).find((x) => x.toLowerCase() === k.toLowerCase());
    const v = hit ? env.vars[hit] : undefined;
    if (!v) bad = true;
    return v ?? '';
  });
  if (bad) return null;
  return env.sep === '\\' ? out.replace(/\//g, '\\') : out;
}
/** Replace the home folder with ~ (case-insensitive on Windows) so a web page never sees the user's account name. */
export function redactPath(p: string | undefined, home: string, win: boolean): string | undefined {
  if (!p) return p;
  if (!home) return p;
  const norm = (s: string) => (win ? s.toLowerCase().replace(/\//g, '\\') : s);
  const h = home.replace(/[\\/]+$/, '');
  if (norm(p).startsWith(norm(h) + (win ? '\\' : '/')) || norm(p) === norm(h)) return '~' + p.slice(h.length);
  // other users' folders (C:\Users\someone\..., /home/someone/..., /Users/someone/...) → keep the shape, hide the name
  return p.replace(/^([A-Za-z]:\\Users\\|\/home\/|\/Users\/)[^\\/]+/i, (_m, pre: string) => `${pre}…`);
}

// ---------------------------------------------------------------- state
export interface Finding { found: boolean; version?: string; path?: string; running?: boolean; via?: string; note?: string }

/** The card state from what was found. `others` = statuses of the other tools (for `requires`). */
export function decideState(entry: ToolEntry, os: ToolOs, f: Finding, others: Record<string, ToolStatus | undefined>): ToolStatus {
  const base = { id: entry.id } as ToolStatus;
  if (!entry.os[os].supported) return { ...base, state: 'unsupported', note: entry.os[os].why };
  const missing = (entry.requires ?? []).filter((r) => { const s = others[r]?.state; return !(s === 'installed' || s === 'outdated' || s === 'included'); });
  if (entry.included) {
    // obs-websocket: built into OBS 28+, so its version follows OBS
    if (missing.length) return { ...base, state: 'needs', missing, note: `Needs ${missing.map((m) => getTool(m)?.name ?? m).join(' and ')} first.` };
    if (entry.id === 'obs-websocket') {
      const obs = others.obs;
      if (obs?.version && compareVersions(obs.version, '28') < 0) return { ...base, state: 'outdated', note: 'Your OBS is older than 28: update OBS to get it built in.' };
      return { ...base, state: 'included', note: 'Built into your OBS. Switch it on in OBS (see the guide).' };
    }
    if (f.found === false && entry.detect.files) return { ...base, state: 'needs', note: 'Some VTube Pro files are missing: reinstall VTube Pro.' };
    return { ...base, state: 'included', via: 'bundled' };
  }
  if (!f.found) return { ...base, state: 'missing', ...(f.note ? { note: f.note } : {}) };
  const out: ToolStatus = { ...base, state: 'installed' };
  if (f.version) out.version = f.version;
  if (f.path) out.path = f.path;
  if (f.via) out.via = f.via;
  if (f.running !== undefined) out.running = f.running;
  const min = entry.detect.minVersion;
  if (min && f.version && versionParts(f.version).length && compareVersions(f.version, min) < 0) {
    out.state = 'outdated';
    out.note = `Version ${f.version} is too old: VTube Pro needs ${min} or newer.`;
  } else if (f.note) out.note = f.note;
  else if (entry.endpoint && f.running === false) out.note = 'Installed, but not running right now.';
  if (missing.length && !out.note) out.note = `Needs ${missing.map((m) => getTool(m)?.name ?? m).join(' and ')} to be useful.`;
  return out;
}

// ---------------------------------------------------------------- consent text
export interface InstallPlan {
  toolId: string;
  methodId: string;
  os: ToolOs;
  kind: ToolMethod['kind'];
  /** Title for the dialog: "Install Blender?" */
  title: string;
  /** Exactly what will happen, in plain words (bullet lines). */
  happens: string[];
  url?: string;
  command?: string;
  /** false = the helper will not run it; the user copies it. */
  runnable: boolean;
  admin: boolean;
  size: string;
  licence: string;
  source: string;
}

/** What pressing "Install" with this method does: shown BEFORE consent, and the only thing the helper may do after it. */
export function planFor(entry: ToolEntry, os: ToolOs, methodId: string): InstallPlan | null {
  const o = entry.os[os];
  if (!o?.supported) return null;
  const m = o.methods.find((x) => x.id === methodId);
  if (!m) return null;
  const source = m.url ? new URL(m.url).hostname : m.command?.startsWith('winget') ? 'winget (Microsoft’s package manager), from the publisher’s official package' : m.command?.startsWith('brew') ? 'Homebrew, from the official package' : 'the official package';
  const happens: string[] = [];
  const runnable = m.kind === 'open-url' || !!m.runnable;
  if (m.kind === 'open-url') {
    happens.push(`Your web browser opens ${new URL(m.url!).hostname}, the official ${entry.name} download page.`);
    happens.push('You download and run the installer yourself. Nothing downloads until you click there.');
  } else if (m.runnable) {
    happens.push(`A ${os === 'win' ? 'command window' : 'Terminal window'} opens on this computer and runs: ${m.command}`);
    happens.push(`It downloads ${entry.name} (${entry.size.download.replace(/\s*\(([^)]*)\)/, ', $1')}) from ${source}.`);
    happens.push('Any licence or permission question appears in that window for YOU to answer. VTube Pro never answers for you.');
  } else {
    happens.push(`Copy this command into a terminal on this ${OS_LABEL[os]} computer: ${m.command}`);
    happens.push(m.admin ? 'It asks for your password, because it installs for the whole computer.' : 'It installs for your user account.');
  }
  const note = entry.size.note ? ` (${entry.size.note.charAt(0).toLowerCase()}${entry.size.note.slice(1).replace(/\.$/, '')})` : '';
  happens.push(`It uses about ${entry.size.disk.replace(/^about /, '')} of disk space${note}.`);
  return {
    toolId: entry.id, methodId: m.id, os, kind: m.kind, title: `Install ${entry.name}?`, happens,
    ...(m.url ? { url: m.url } : {}), ...(m.command ? { command: m.command } : {}),
    runnable, admin: !!m.admin, size: entry.size.download, licence: entry.licence.name, source,
  };
}

/** Plain label for a state pill. */
export function stateLabel(s: ToolStatus): string {
  switch (s.state) {
    case 'installed': return s.version ? `Installed ✔ ${s.version}` : 'Installed ✔';
    case 'outdated': return s.version ? `Update needed (${s.version})` : 'Update needed';
    case 'included': return 'Included ✔';
    case 'needs': return 'Needs another tool';
    case 'unsupported': return 'Not for this computer';
    default: return 'Not installed';
  }
}
