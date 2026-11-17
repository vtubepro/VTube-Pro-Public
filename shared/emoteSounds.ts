// Emote sounds (owner: "have the option to have sound play every time they are active. This will be off by default"):
// a sound per emote, played in the studio when chat uses it. OFF until the streamer switches it on; then only the emotes
// they gave a sound play one. Pure: the settings (config/emote_sounds.json, server/chat/emoteSounds.ts), the built-in
// sounds' list and the trigger rules (cooldowns, max per message, the "N people within X seconds" combo, bots), so
// tools/emote_sounds_unit.ts can run every rule without a clock or a speaker.
//
// The helper decides (it sees every chat message once) and sends {type:'showsound', s:{k:'emote', snd, gain}} on the bus;
// the studio plays it through the audio mixer's Room sounds row (src/audio/mixer/showSounds.ts); OBS pages never play.
import { CHAT_BOTS } from './chat.ts';
import { EMOTE_KEY_RE } from './emotes.ts';

/** Built-in sounds: synthesised in the studio (no file) or CC0 Kenney sounds shipped in assets/library/sounds. */
export const BUILTIN_EMOTE_SOUNDS: { id: string; label: string; file?: string }[] = [
  { id: 'horn', label: 'Air horn' },
  { id: 'siren', label: 'Siren' },
  { id: 'ding', label: 'Ding' },
  { id: 'coin', label: 'Coin' },
  { id: 'boing', label: 'Boing' },
  { id: 'laser', label: 'Laser' },
  { id: 'pop', label: 'Pop' },
  { id: 'tada', label: 'Ta-da' },
  { id: 'bell', label: 'Bell', file: 'kenney_impact/impactBell_heavy_000.ogg' },
  { id: 'punch', label: 'Punch', file: 'kenney_impact/impactPunch_heavy_001.ogg' },
  { id: 'glass', label: 'Glass', file: 'kenney_impact/impactGlass_medium_001.ogg' },
  { id: 'knock', label: 'Knock', file: 'kenney_impact/impactWood_heavy_000.ogg' },
  { id: 'click', label: 'Click', file: 'kenney_ui/switch3.ogg' },
];
const BUILTIN_IDS = new Set(BUILTIN_EMOTE_SOUNDS.map((b) => b.id));
/** A sound reference: "b:<built-in id>" or "u:<id of a sound the streamer added>" (server/chat/emoteSounds.ts). */
export const SOUND_REF_RE = /^(b:[a-z]{2,12}|u:[a-f0-9]{16})$/;
export const isSoundRef = (v: unknown): v is string => typeof v === 'string' && SOUND_REF_RE.test(v) && (v[0] === 'u' || BUILTIN_IDS.has(v.slice(2)));

export interface EmoteSoundRule {
  /** The emote (shared/emotes.ts emoteKey) + what the panel shows for it. */
  key: string;
  name: string;
  url?: string;
  snd: string;
  /** This emote's volume, 0 … 1.5 (× the master volume). */
  vol: number;
  /** Seconds before this emote can play again. */
  cd: number;
  /** Combo / hype: only when `n` different people used it within `secs` (null = every time). */
  combo: { n: number; secs: number } | null;
  on: boolean;
}
export interface EmoteSoundCfg {
  /** The master switch. OFF by default. */
  on: boolean;
  /** Master volume 0 … 1. */
  vol: number;
  /** Seconds between any two emote sounds. */
  gcd: number;
  /** At most this many sounds for one message (1 … 5). */
  maxPerMsg: number;
  /** Seconds before the SAME person can set off another emote sound (0 = no limit). */
  userCd: number;
  /** At most `n` emote sounds within `secs` seconds, all emotes together (a burst limiter). */
  burst: { n: number; secs: number };
  /** Raid / flood guard: no emote sounds while chat runs faster than this many messages in 10 s (0 = never pause). */
  flood: number;
  /** Only subscribers / members / VIPs / mods (and you) set them off. */
  subsOnly: boolean;
  ignoreBots: boolean;
  /** Extra names never to react to (lower case). */
  bots: string[];
  rules: EmoteSoundRule[];
}
/** A sound the streamer added (stored by the helper in its library: library/sounds/emotes/<id>.<ext>). */
export interface UserSound { id: string; name: string; type: string; bytes: number }

export const DEFAULT_EMOTE_SOUNDS: EmoteSoundCfg = { on: false, vol: 0.8, gcd: 1.5, maxPerMsg: 1, userCd: 30, burst: { n: 3, secs: 10 }, flood: 50, subsOnly: false, ignoreBots: true, bots: [], rules: [] };
export const MAX_RULES = 200;
export const RULE_LIMITS = { vol: [0, 1.5], cd: [0, 600], comboN: [2, 50], comboSecs: [2, 120], gcd: [0, 60], maxPerMsg: [1, 5], userCd: [0, 600], burstN: [1, 20], burstSecs: [2, 120], flood: [0, 500] } as const;
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const r2 = (v: number) => Math.round(v * 100) / 100;
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '');

export function sanitizeRule(o: unknown): EmoteSoundRule | null {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  if (typeof x.key !== 'string' || !EMOTE_KEY_RE.test(x.key) || !isSoundRef(x.snd)) return null;
  const c = (x.combo && typeof x.combo === 'object' ? x.combo : null) as Record<string, unknown> | null;
  const url = typeof x.url === 'string' && /^https:\/\/[\w.-]+\/\S{0,400}$/.test(x.url) ? x.url : undefined;
  return {
    key: x.key, name: clean(x.name, 60) || x.key.split(':')[1], ...(url ? { url } : {}), snd: x.snd,
    vol: r2(num(x.vol, RULE_LIMITS.vol[0], RULE_LIMITS.vol[1], 1)),
    cd: Math.round(num(x.cd, RULE_LIMITS.cd[0], RULE_LIMITS.cd[1], 5) * 10) / 10,
    combo: c ? { n: Math.round(num(c.n, RULE_LIMITS.comboN[0], RULE_LIMITS.comboN[1], 3)), secs: Math.round(num(c.secs, RULE_LIMITS.comboSecs[0], RULE_LIMITS.comboSecs[1], 10)) } : null,
    on: x.on !== false,
  };
}
export function sanitizeEmoteSoundCfg(o: unknown): EmoteSoundCfg {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const d = DEFAULT_EMOTE_SOUNDS;
  const rules: EmoteSoundRule[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(x.rules) ? x.rules.slice(0, MAX_RULES * 2) : []) { const s = sanitizeRule(r); if (s && !seen.has(s.key)) { seen.add(s.key); rules.push(s); } if (rules.length >= MAX_RULES) break; }
  return {
    on: x.on === true,                                   // (anything but an explicit true = off: the default)
    vol: r2(num(x.vol, 0, 1, d.vol)),
    gcd: Math.round(num(x.gcd, RULE_LIMITS.gcd[0], RULE_LIMITS.gcd[1], d.gcd) * 10) / 10,
    maxPerMsg: Math.round(num(x.maxPerMsg, RULE_LIMITS.maxPerMsg[0], RULE_LIMITS.maxPerMsg[1], d.maxPerMsg)),
    userCd: Math.round(num(x.userCd, RULE_LIMITS.userCd[0], RULE_LIMITS.userCd[1], d.userCd)),
    burst: ((b) => ({ n: Math.round(num(b.n, RULE_LIMITS.burstN[0], RULE_LIMITS.burstN[1], d.burst.n)), secs: Math.round(num(b.secs, RULE_LIMITS.burstSecs[0], RULE_LIMITS.burstSecs[1], d.burst.secs)) }))((x.burst && typeof x.burst === 'object' ? x.burst : {}) as Record<string, unknown>),
    flood: Math.round(num(x.flood, RULE_LIMITS.flood[0], RULE_LIMITS.flood[1], d.flood)),
    subsOnly: x.subsOnly === true,
    ignoreBots: x.ignoreBots !== false,
    bots: Array.isArray(x.bots) ? [...new Set(x.bots.map((b) => clean(b, 40).trim().toLowerCase()).filter(Boolean))].slice(0, 40) : [],
    rules,
  };
}

/** One chat message as the trigger sees it. */
export interface TriggerMsg { id: string; user: string; emotes: { key: string }[]; test?: boolean; badges?: string[] }
/** Badges that count as "subscribers / members" for subsOnly (shared/chat.ts ChatEvent.badges). */
const SUPPORTER_BADGES = new Set(['subscriber', 'member', 'founder', 'vip', 'moderator', 'broadcaster', 'og']);
export interface EmoteFire { id: string; key: string; snd: string; gain: number }

/** The trigger: per-emote cooldowns, the global cooldown, max per message, combos, bots. `now` in ms (tests pass their
 *  own clock). State lives here (not in the settings): a settings change keeps the cooldowns running. */
export class EmoteSoundTrigger {
  private lastAt = new Map<string, number>();
  private lastAny = -Infinity;
  /** Combo windows: emote key → who used it when (one entry per person: their latest use). */
  private hits = new Map<string, Map<string, number>>();
  /** Every chat message's time (the flood guard), the last sound per person, the recent sounds (the burst limiter). */
  private msgs: number[] = [];
  private byUser = new Map<string, number>();
  private fired: number[] = [];

  /** Every chat message (with or without emotes) counts for the flood guard. */
  noteMessage(now: number) { this.msgs.push(now); while (this.msgs.length && now - this.msgs[0] > 10_000) this.msgs.shift(); if (this.msgs.length > 2000) this.msgs.splice(0, this.msgs.length - 2000); }
  /** Chat is faster than the flood guard allows right now. */
  flooded(cfg: EmoteSoundCfg, now: number): boolean { return cfg.flood > 0 && this.msgs.filter((t) => now - t <= 10_000).length > cfg.flood; }

  onMessage(m: TriggerMsg, cfg: EmoteSoundCfg, now: number, extraBots: readonly string[] = []): EmoteFire[] {
    if (!cfg.on || !m.emotes.length) return [];
    const user = m.user.toLowerCase();
    if (cfg.ignoreBots && (CHAT_BOTS.includes(user) || cfg.bots.includes(user) || extraBots.includes(user))) return [];
    if (cfg.subsOnly && !(m.badges ?? []).some((b) => SUPPORTER_BADGES.has(b))) return [];
    if (this.flooded(cfg, now)) return [];
    if (cfg.userCd > 0 && now - (this.byUser.get(user) ?? -Infinity) < cfg.userCd * 1000) return [];
    while (this.fired.length && now - this.fired[0] >= cfg.burst.secs * 1000) this.fired.shift();
    const rules = new Map(cfg.rules.filter((r) => r.on).map((r) => [r.key, r]));
    const out: EmoteFire[] = [];
    const done = new Set<string>();
    const globalOk = now - this.lastAny >= cfg.gcd * 1000;   // (checked once: one message may play up to maxPerMsg sounds)
    for (const e of m.emotes) {
      const r = rules.get(e.key);
      if (!r || done.has(r.key)) continue;
      done.add(r.key);                                    // (one count per emote per message: "KEKW KEKW KEKW" = one use)
      if (r.combo) {
        const w = this.hits.get(r.key) ?? new Map<string, number>();
        this.hits.set(r.key, w);
        w.set(user, now);
        for (const [u, t] of w) if (now - t > r.combo.secs * 1000) w.delete(u);
        if (w.size < r.combo.n) continue;
      }
      if (!globalOk || out.length >= cfg.maxPerMsg || this.fired.length + out.length >= cfg.burst.n) continue;
      if (now - (this.lastAt.get(r.key) ?? -Infinity) < r.cd * 1000) continue;
      this.lastAt.set(r.key, now);
      this.lastAny = now;
      if (r.combo) this.hits.delete(r.key);               // (a combo fires once; the next one needs N people again)
      out.push({ id: `emote:${m.id}:${r.key}`.replace(/[^\w:.-]/g, '_').slice(0, 80), key: r.key, snd: r.snd, gain: r2(Math.min(1.5, r.vol * cfg.vol)) });
    }
    if (out.length) {
      this.byUser.set(user, now);
      this.fired.push(...out.map(() => now));
      if (this.byUser.size > 5000) this.byUser.clear();
    }
    return out;
  }
  /** Forget the cooldowns + combo windows (tests; "reset" in the panel). */
  reset() { this.lastAt.clear(); this.hits.clear(); this.lastAny = -Infinity; this.msgs = []; this.byUser.clear(); this.fired = []; }
}
