// config/settings.json — the ComfyUI address, the ComfyUI workflow and the Blender path. Gitignored.
// VTube Pro holds no AI keys: nothing here is a credential for a cloud service.
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS_FILE, SETTINGS_EXAMPLE } from './paths.ts';

export interface Settings {
  comfyUrl: string;
  blenderPath: string;
  /** Advanced: run your own API-format workflow, config/comfy_workflows/<name>.json (without .json), instead of VTube Pro's
   *  built-in Character 3D (server/providers/comfy.ts). Leave empty to use the built-in one. */
  comfyWorkflow?: string;
}

const FALLBACK: Settings = {
  comfyUrl: 'http://127.0.0.1:8188',
  blenderPath: '',
};

function readJson(file: string): Partial<Settings> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

let cache: Settings | null = null;

export function loadSettings(): Settings {
  if (cache) return cache;
  if (!fs.existsSync(SETTINGS_FILE)) {
    // a brand-new data folder may not have config/ yet (the server makes it at start; tools and tests may not)
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    if (fs.existsSync(SETTINGS_EXAMPLE)) fs.copyFileSync(SETTINGS_EXAMPLE, SETTINGS_FILE);
    else fs.writeFileSync(SETTINGS_FILE, JSON.stringify(FALLBACK, null, 2));
  }
  const example = readJson(SETTINGS_EXAMPLE) ?? {};
  const raw = readJson(SETTINGS_FILE) ?? {};
  // every other field of the file is kept as it is (a switch another part reads, such as `to3d`); an older file's `keys` /
  // `models` blocks (pasted AI keys, cloud model names) are dropped: this build has no use for them
  const clean = (s: Partial<Settings> & Record<string, unknown>) => { const { keys: _k, models: _m, ...rest } = s; return rest as Partial<Settings>; };
  cache = { ...FALLBACK, ...clean(example), ...clean(raw) };
  // an older settings file may still hold pasted AI keys: this build never uses them, so they are wiped from the file now
  if ('keys' in raw || 'models' in raw) saveSettings(cache);
  return cache;
}

function saveSettings(s: Settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  cache = s;
}

export function publicSettings(): Settings {
  return { ...loadSettings() };
}

/**
 * Merge a patch into settings. Strings: '' = leave unchanged, null = clear.
 * Only the top-level fields below are accepted.
 */
export function updateSettings(patch: Record<string, unknown>) {
  const s = structuredClone(loadSettings());
  const allowed = ['comfyUrl', 'blenderPath', 'comfyWorkflow'];
  const target = s as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    if (v === null) target[k] = '';
    else if (typeof v === 'string' && v !== '') target[k] = v.trim();
  }
  saveSettings(s);
  return publicSettings();
}
