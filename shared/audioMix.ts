// Audio mixer (beta.12): the rules. One row per voice in the studio (you, each interview / party guest, the show's own
// sounds) with a level meter, a volume, "Mute for me", the moderation "Mute for everyone" and a noise gate.
// The runtime is src/audio/mixer/audioMixer.ts (+ gate-worklet.js), the card src/ui/audioMixerPanel.ts,
// the plain-words guide docs/VOICE.md → "Audio mixer".
//
// Owner rule: guest voices come through the STUDIO only, never straight to OBS. What a guest voice reaches:
//   what the host hears (studio speakers)  = volume × (Hear guests) × (on air) × (not Mute for me) × (not muted for everyone)
//                                            — played by the mixer (WebAudio), the plain <audio> path only as a fallback
//   backstage talk (green room)            = not Mute for me, not muted for everyone
//   the OBS / output page                  = NOTHING: no guest audio track is ever sent there (only their picture + level)
//   the camera director / speaking glow    = the guest's level after the noise gate, whatever the volume or "Mute for me"
//                                            (only "Mute for everyone" silences it: then they really aren't on the show)
//
// Settings are kept per guest identity in this browser: their Discord id, or their interview link identity (stable for
// as long as they use that link in the same browser). Never their name: two "Alex"es are two people. A guest with neither
// keeps their settings for that connection only. Defaults: everyone audible at 100 %, nothing muted, no gate.
//
// Pure: no DOM, no WebAudio (tools/audio_mixer_unit.ts tests all of it).

export type GateMode = 'off' | 'auto' | 'manual';
export interface GateCfg {
  /** off = the voice passes untouched; auto = learns the background noise and sits 12 dB above it; manual = threshold. */
  mode: GateMode;
  /** dBFS: the gate opens above this (manual mode). */
  threshold: number;
  /** ms: fade in / stay open after the voice drops / fade out. */
  attack: number; hold: number; release: number;
}
export interface SourcePrefs {
  /** The host's volume for them (0..1). Missing = never changed (100 %). */
  vol?: number;
  /** Silent for the host (and so on the OBS page) while the level still drives the cameras. */
  muteMe: boolean;
  gate: GateCfg;
  /** Light hiss clean-up (a spectral gate) before the gate. */
  clean: boolean;
  /** Last name seen (shown in lists; never part of the key). */
  name: string;
  /** Last change (ms epoch): the oldest entries go first when the list is full. */
  at: number;
}

export const GATE_DEFAULT: GateCfg = { mode: 'off', threshold: -45, attack: 5, hold: 200, release: 150 };
export const GATE_LIMITS = { threshold: [-75, -15], attack: [1, 50], hold: [0, 1000], release: [20, 1000] } as const;
export const SOURCE_DEFAULT: SourcePrefs = { muteMe: false, gate: { ...GATE_DEFAULT }, clean: false, name: '', at: 0 };
export const MIX_PREFS_KEY = 'vtp.audioMix';
export const MIX_PREFS_MAX = 200;
/** "You": your own mic row. */
export const ME_ID = '@me';

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** Who a guest is, for remembering their settings: their Discord id, or their interview link identity (the relay's
 *  per-browser, per-link id). Never the name they typed. Empty = nothing stable: settings live with the connection. */
export function identityKey(m: { uid?: string | null }): string {
  const u = String(m.uid ?? '');
  if (/^\d{5,25}$/.test(u)) return `discord:${u}`;
  if (/^link[0-9a-f]{20}$/.test(u)) return `link:${u}`;
  if (/^input:[\w+/=.-]{1,200}$/.test(u)) return u;          // a sound input the host added: its device id
  return '';
}

export function sanitizeGate(x: unknown): GateCfg {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const L = GATE_LIMITS;
  return {
    mode: o.mode === 'auto' || o.mode === 'manual' ? o.mode : 'off',
    threshold: num(o.threshold, L.threshold[0], L.threshold[1], GATE_DEFAULT.threshold),
    attack: num(o.attack, L.attack[0], L.attack[1], GATE_DEFAULT.attack),
    hold: num(o.hold, L.hold[0], L.hold[1], GATE_DEFAULT.hold),
    release: num(o.release, L.release[0], L.release[1], GATE_DEFAULT.release),
  };
}
export function sanitizeSource(x: unknown): SourcePrefs {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const out: SourcePrefs = { muteMe: o.muteMe === true, gate: sanitizeGate(o.gate), clean: o.clean === true, name: typeof o.name === 'string' ? o.name.slice(0, 40) : '', at: num(o.at, 0, 1e15, 0) };
  if (typeof o.vol === 'number' && Number.isFinite(o.vol)) out.vol = Math.min(1, Math.max(0, o.vol));
  return out;
}
/** Nothing worth keeping (= the defaults). */
export function isDefaultSource(p: SourcePrefs): boolean {
  const g = p.gate, d = GATE_DEFAULT;
  return !p.muteMe && !p.clean && (p.vol === undefined || p.vol >= 0.995) && g.mode === d.mode && g.threshold === d.threshold && g.attack === d.attack && g.hold === d.hold && g.release === d.release;
}
/** Does this voice need the gate node (the gate or the clean-up is on)? */
export const needsProcessing = (p: SourcePrefs): boolean => p.gate.mode !== 'off' || p.clean;

/** Every guest's remembered settings (localStorage text in, text out). */
export class MixPrefs {
  private map = new Map<string, SourcePrefs>();
  constructor(text?: string | null, private now: () => number = Date.now) { this.load(text ?? null); }
  load(text: string | null) {
    this.map.clear();
    let o: unknown = null;
    try { o = text ? JSON.parse(text) : null; } catch { o = null; }
    const src = o && typeof o === 'object' && (o as { v?: unknown }).v === 1 ? (o as { s?: unknown }).s : null;
    if (!src || typeof src !== 'object') return;
    for (const [k, v] of Object.entries(src as Record<string, unknown>).slice(0, MIX_PREFS_MAX * 2)) {
      if (typeof k !== 'string' || !/^(discord:\d{5,25}|link:link[0-9a-f]{20}|input:[\w+/=.-]{1,200})$/.test(k)) continue;
      const p = sanitizeSource(v);
      if (!isDefaultSource(p)) this.map.set(k, p);
    }
    this.trim();
  }
  /** Their settings (the defaults when unknown or `key` is empty). */
  get(key: string): SourcePrefs { const p = key ? this.map.get(key) : undefined; return p ? { ...p, gate: { ...p.gate } } : { ...SOURCE_DEFAULT, gate: { ...GATE_DEFAULT } }; }
  has(key: string): boolean { return !!key && this.map.has(key); }
  /** Change some of their settings. Returns false when there is nothing stable to remember them by. */
  set(key: string, patch: Partial<Omit<SourcePrefs, 'gate'>> & { gate?: Partial<GateCfg> }, name?: string): boolean {
    if (!key) return false;
    const cur = this.get(key);
    const { gate, vol, ...rest } = patch;
    const next = sanitizeSource({ ...cur, ...rest, ...('vol' in patch ? { vol } : {}), gate: { ...cur.gate, ...(gate ?? {}) }, name: name ?? cur.name, at: this.now() });
    if ('vol' in patch && vol === undefined) delete next.vol;
    if (isDefaultSource(next)) this.map.delete(key); else this.map.set(key, next);
    this.trim();
    return true;
  }
  forget(key: string) { this.map.delete(key); }
  get size() { return this.map.size; }
  keys(): string[] { return [...this.map.keys()]; }
  private trim() {
    if (this.map.size <= MIX_PREFS_MAX) return;
    const old = [...this.map].sort((a, b) => a[1].at - b[1].at).slice(0, this.map.size - MIX_PREFS_MAX);
    for (const [k] of old) this.map.delete(k);
  }
  toText(): string { return JSON.stringify({ v: 1, s: Object.fromEntries(this.map) }); }
}

// ---------------------------------------------------------------- the decisions (one place, so the outputs can't disagree)
/** Gain for the host's own speakers. */
export function hostPlayGain(o: { hear: boolean; air: boolean; vol: number; muteMe: boolean; muted: boolean }): number {
  return o.hear && o.air && !o.muteMe && !o.muted ? Math.min(1, Math.max(0, o.vol)) : 0;
}
/** Backstage talk (the green room): plays unless muted for me / for everyone. */
export const backstagePlays = (o: { muteMe: boolean; muted: boolean }): boolean => !o.muteMe && !o.muted;
/** What the camera director and the speaking glow read for a guest. `reported` = the level their page measured;
 *  `gate` = the host-side gate's state (null = no gate running for them: their level as before). "Mute for me" is
 *  deliberately not an input. */
export function directorLevel(o: { reported: number; quiet: boolean; gate: null | { open: boolean } }): number {
  if (o.quiet) return 0;
  if (o.gate && !o.gate.open) return 0;
  return Math.min(1, Math.max(0, o.reported));
}

// ---------------------------------------------------------------- meters
/** Meter scale: −60 dBFS … 0 dBFS → 0 … 1. */
export const METER_FLOOR = -60;
export function meterPos(db: number): number { return Number.isFinite(db) ? Math.min(1, Math.max(0, (db - METER_FLOOR) / -METER_FLOOR)) : 0; }
export const linToDb = (x: number): number => (x > 1e-5 ? 20 * Math.log10(x) : -100);
/** Peak hold for a meter: holds `holdS` s, then falls `fallDbS` dB per second. */
export function peakHold(prev: { db: number; at: number }, db: number, now: number, holdS = 1.2, fallDbS = 20): { db: number; at: number } {
  if (db >= prev.db) return { db, at: now };
  const since = now - prev.at;
  if (since <= holdS) return prev;
  return { db: Math.max(db, prev.db - fallDbS * Math.min(0.25, since - holdS)), at: prev.at + Math.min(0.25, since - holdS) };
}
/** One-line state for a row (what a first-time user needs to know, nothing more). */
export function rowStatus(o: { muted: boolean; muteMe: boolean; air: boolean; talking: boolean; gateClosed: boolean }): { text: string; tone: 'ok' | 'dim' | 'warn' } {
  if (o.muted) return { text: 'Muted for everyone', tone: 'warn' };
  if (!o.air) return { text: 'Waiting backstage', tone: 'dim' };
  if (o.muteMe) return { text: o.talking ? 'Talking · muted for you' : 'Muted for you', tone: 'dim' };
  if (o.talking) return { text: 'Talking', tone: 'ok' };
  return { text: o.gateClosed ? 'Quiet · gate closed' : 'Quiet', tone: 'dim' };
}

// ---------------------------------------------------------------- app guests: no speech while their gate is shut
/** Voice-mouth samples of a guest whose noise gate is shut: kept flowing (so every page stays on the voice path and
 *  never falls back to the camera's mouth), but silent: no voice, mouth closed. In place (the host's own freshly decoded
 *  packet: nothing is allocated while the gate is shut). */
export function quietVoice<T extends { vad: number; level: number; open: number; closure: number; vis: [number, number][] }>(samples: T[]): T[] {
  for (const s of samples) { s.vad = 0; s.level = 0; s.open = 0; s.closure = 0; s.vis.length = 0; }
  return samples;
}
/** A tracking frame of a guest whose noise gate is shut: the camera's mouth doesn't count as talking either. In place
 *  (the host's own freshly sanitised frame). */
export function quietFrame<F extends { mouth?: { open: number; speak?: number }; visemes?: Record<string, number> }>(f: F): F {
  if (f.mouth) { f.mouth.open = 0; if (f.mouth.speak !== undefined) f.mouth.speak = 0; }
  if (f.visemes) { for (const k in f.visemes) f.visemes[k] = 0; f.visemes.sil = 1; }
  return f;
}
