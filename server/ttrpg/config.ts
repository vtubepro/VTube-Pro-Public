// AI GM + TTS/STT + VTT bridge settings: config/ttrpg.json (git-ignored like every config/*.json). The AI GM runs on a
// model server on THIS PC (Ollama, LM Studio, llama.cpp, KoboldCpp, any OpenAI-compatible server on a loopback address):
// there is no cloud provider, no account and no key here. All model calls are made by this server, for the host.
// Guests never need anything.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../paths.ts';

export const TTRPG_CONFIG_FILE = path.join(CONFIG_DIR, 'ttrpg.json');

export const LOCAL_KINDS = ['ollama', 'lmstudio', 'llamacpp', 'koboldcpp', 'other'] as const;
export type LocalKind = (typeof LOCAL_KINDS)[number];
export const LOCAL_DEFAULT_URL: Record<LocalKind, string> = {
  ollama: 'http://127.0.0.1:11434/v1', lmstudio: 'http://127.0.0.1:1234/v1', llamacpp: 'http://127.0.0.1:8080/v1', koboldcpp: 'http://127.0.0.1:5001/v1', other: 'http://127.0.0.1:8000/v1',
};

export interface TtrpgConfig {
  /** The model on the local server ('' = the first one it lists). */
  model: string;
  local: { kind: LocalKind; url: string };
  temperature: number;
  /** Max output tokens per GM turn (narration + actions). */
  maxTokens: number;
  /** local = a voice server on this PC (OpenAI-compatible /audio/speech, e.g. Kokoro, openedai-speech) */
  tts: { provider: 'browser' | 'local'; model: string; voice: string; url: string };
  stt: { provider: 'browser' | 'local'; model: string; url: string };
  limits: { minGapSec: number; perMinute: number; sessionTokens: number };
  bridge: { enabled: boolean; token: string };
}

const token = () => crypto.randomBytes(9).toString('base64url');
function defaults(): TtrpgConfig {
  return {
    model: '', local: { kind: 'ollama', url: LOCAL_DEFAULT_URL.ollama }, temperature: 0.9, maxTokens: 900,
    tts: { provider: 'browser', model: 'kokoro', voice: 'af_heart', url: 'http://127.0.0.1:8880/v1' },
    stt: { provider: 'browser', model: 'whisper-1', url: 'http://127.0.0.1:8000/v1' },
    limits: { minGapSec: 2, perMinute: 12, sessionTokens: 600_000 },
    bridge: { enabled: false, token: token() },
  };
}

const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
/** An address on THIS PC only (127.x.x.x, localhost or ::1): the AI GM and its voices never reach the network. */
export const LOOPBACK_HOST = /^(127(\.\d{1,3}){3}|localhost|\[::1\])$/i;
const URL_OK = (v: unknown) => {
  const s = str(v, 300);
  if (!s) return undefined;
  try { const u = new URL(s); return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOST.test(u.hostname) ? s.replace(/\/+$/, '') : undefined; } catch { return undefined; }
};
const MODEL = (v: unknown) => { const s = str(v, 120); return s !== undefined && /^[A-Za-z0-9._:/@+-]*$/.test(s) ? s : undefined; };

let cache: TtrpgConfig | null = null;
export function loadTtrpgConfig(): TtrpgConfig {
  if (cache) return cache;
  const d = defaults();
  let raw: Record<string, any> = {};
  try { raw = JSON.parse(fs.readFileSync(TTRPG_CONFIG_FILE, 'utf8')); } catch { /* first run */ }
  cache = merge(d, raw);
  // a file written by an older version may hold fields this build no longer has: it is rewritten without them
  const stale = ['provider', 'models', 'keys', 'effort', 'prices'].some((k) => k in raw) || raw.limits?.sessionUsd !== undefined;
  if (!raw.bridge?.token || stale) saveTtrpgConfig(cache);   // mint the bridge pairing token once
  return cache;
}

function merge(d: TtrpgConfig, x: Record<string, any>): TtrpgConfig {
  const out = structuredClone(d);
  // `models.local` is where an older version kept the local model's name
  const m = MODEL(x.model) ?? MODEL(x.models?.local); if (m !== undefined) out.model = m;
  if ((LOCAL_KINDS as readonly string[]).includes(x.local?.kind)) out.local.kind = x.local.kind;
  out.local.url = URL_OK(x.local?.url) ?? out.local.url;
  out.temperature = num(x.temperature, 0, 2, out.temperature);
  out.maxTokens = Math.round(num(x.maxTokens, 200, 8000, out.maxTokens));
  if (['browser', 'local'].includes(x.tts?.provider)) out.tts.provider = x.tts.provider;
  out.tts.model = MODEL(x.tts?.model) || out.tts.model; out.tts.voice = str(x.tts?.voice, 40) || out.tts.voice; out.tts.url = URL_OK(x.tts?.url) ?? out.tts.url;
  if (['browser', 'local'].includes(x.stt?.provider)) out.stt.provider = x.stt.provider;
  out.stt.model = MODEL(x.stt?.model) || out.stt.model; out.stt.url = URL_OK(x.stt?.url) ?? out.stt.url;
  out.limits = { minGapSec: num(x.limits?.minGapSec, 0, 60, out.limits.minGapSec), perMinute: Math.round(num(x.limits?.perMinute, 1, 60, out.limits.perMinute)),
    sessionTokens: Math.round(num(x.limits?.sessionTokens, 1000, 1e8, out.limits.sessionTokens)) };
  out.bridge.enabled = x.bridge?.enabled === true;
  if (typeof x.bridge?.token === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(x.bridge.token)) out.bridge.token = x.bridge.token;
  return out;
}

export function saveTtrpgConfig(c: TtrpgConfig) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${TTRPG_CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, TTRPG_CONFIG_FILE);
  cache = c;
}

/** Error text on its way to the studio: the bridge pairing code is never in it, and it is cut short. */
export function scrub(text: string): string {
  let t = String(text ?? '');
  const code = loadTtrpgConfig().bridge.token;
  if (code && code.length >= 6) t = t.split(code).join('••••');
  return t.slice(0, 600);
}

/** What the studio sees: the bridge token only as a pairing code. */
export function publicTtrpgConfig() {
  const c = loadTtrpgConfig();
  return { model: c.model, local: c.local, temperature: c.temperature, maxTokens: c.maxTokens, tts: c.tts, stt: c.stt, limits: c.limits, bridge: { enabled: c.bridge.enabled, code: c.bridge.token } };
}

/** Patch from the studio. */
export function patchTtrpgConfig(p: Record<string, any>) {
  const c = structuredClone(loadTtrpgConfig());
  const next = merge(c, { ...c, ...p, local: { ...c.local, ...(p.local ?? {}) }, tts: { ...c.tts, ...(p.tts ?? {}) },
    stt: { ...c.stt, ...(p.stt ?? {}) }, limits: { ...c.limits, ...(p.limits ?? {}) },
    bridge: { enabled: typeof p.bridge?.enabled === 'boolean' ? p.bridge.enabled : c.bridge.enabled, token: p.bridge?.newToken === true ? token() : c.bridge.token } });
  saveTtrpgConfig(next);
  return publicTtrpgConfig();
}
