// Host moderation: the host turns a guest's camera off, mutes them, sets their volume, or cuts both at once (one guest
// or everyone), instantly, with Undo. Pure data + rules shared by the host studio (src/net/moderation.ts, src/party.ts,
// src/net/tv/*), the browser guest page (src/net/tv/tvLiteGuest.ts), VTube Pro app guests, the Live panel and
// tools/moderation_unit.ts. No DOM, no network.
//
// How it is enforced (docs/MULTIPLAYER_DISCORD.md → "Host moderation"):
//  • ON THE HOST, never by the guest's cooperation. The guest's media keeps arriving at the host; the host decides what
//    leaves its studio:
//      camera off → every output gets a "Camera off" card instead of their picture: this PC's OBS pages (TV / projector /
//                   standee / Interview monitor, via the loopback feeds), the forwards to every other guest, and the
//                   avatar guests' scene (a 3D-avatar guest is held out of the room instead: they have no picture);
//      muted      → their voice leaves the studio speakers (= what OBS Desktop Audio captures), the OBS page audio, and
//                   every other guest's mix-minus; their speaking level reads 0 everywhere (no talk gestures, no auto cuts
//                   to them) and an app guest's mouth samples are dropped. They still HEAR the show.
//  • By a STABLE identity (shared/greenroom.ts stableKey: Discord id / per-tab link id), so a guest who reconnects comes
//    back exactly as moderated. Only the host can lift it.
//  • The guest is told ({t:'mod'} on the host ↔ guest 'ctl' channel, plus the relay as a backup path) and their page
//    shows it and locks their own unmute until the host lifts it.

/** Capability: this peer understands {t:'mod'} (guest: shows it + locks its unmute). Old peers are still moderated. */
export const MOD_CAP = 'mod1';

/** What the host decided for one guest. */
export interface ModState {
  /** Camera (or avatar) hidden from the show. */
  cam: boolean;
  /** Voice muted for the show and for every other guest. */
  mic: boolean;
  /** Their volume on the show / in the studio, 0..1 (the slider; mute is separate so unmute restores it). */
  vol: number;
}
export const MOD_DEFAULT: Readonly<ModState> = Object.freeze({ cam: false, mic: false, vol: 1 });
export const isDefault = (s: ModState) => !s.cam && !s.mic && Math.abs(s.vol - 1) < 0.005;
export const isCut = (s: ModState) => s.cam && s.mic;
const clamp01 = (v: unknown, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, Math.round(v * 100) / 100)) : d);

// ---------------------------------------------------------------- propagation rules (every output asks these)
/** The volume their voice plays at on this PC (studio speakers, OBS page) and in other guests' mixes. 0 = silent. */
export const effectiveVol = (s: ModState | undefined, base = 1): number => (!s ? base : s.mic ? 0 : Math.min(base, s.vol));
/** Their speaking level as everyone else sees it (talk gestures, the auto director, the People tile). */
export const effectiveLevel = (s: ModState | undefined, level: number): number => (s?.mic ? 0 : level);
/** Does their real picture leave the studio? (false = the "Camera off" card goes everywhere instead) */
export const showsPicture = (s: ModState | undefined): boolean => !s?.cam;
/** Every output a guest can reach, and what each one gets. One place, so the outputs can't disagree. */
export interface ModRoute {
  /** OBS pages on this PC (TV / projector / standee / Interview monitor). */
  obsVideo: 'picture' | 'card';
  /** The forwarded copy each other guest gets. */
  forwardVideo: 'picture' | 'card';
  /** Their voice on the OBS page / studio speakers (0 = not at all). */
  obsVol: number;
  /** Their voice in other guests' mix-minus. */
  inMixes: boolean;
  /** They still hear the show (never cut by moderation). */
  hearsShow: boolean;
  /** A 3D-avatar guest with the camera "off": held out of the room (no picture to swap). */
  avatarHidden: boolean;
}
export function routeOf(s: ModState | undefined, o: { tv: boolean; baseVol?: number }): ModRoute {
  const card = !showsPicture(s);
  const v = effectiveVol(s, o.baseVol ?? 1);
  return { obsVideo: card ? 'card' : 'picture', forwardVideo: card ? 'card' : 'picture', obsVol: v, inMixes: v > 0, hearsShow: true, avatarHidden: card && !o.tv };
}

// ---------------------------------------------------------------- the host's book (+ Undo)
export interface ModEntry extends ModState { key: string; name: string; at: number }
export type ModKind = 'cam' | 'mic' | 'vol' | 'cut' | 'restore' | 'all' | 'allback' | 'undo';
/** One step of history: what changed and what it was before (Undo puts the `prev` back). */
export interface ModChange { kind: ModKind; label: string; at: number; keys: string[]; prev: [string, ModState | null][] }
export const HISTORY_MAX = 30;
/** Volume drags within this long on the same guest are one Undo step. */
export const VOL_MERGE_MS = 2000;

export class ModBook {
  readonly entries = new Map<string, ModEntry>();
  readonly history: ModChange[] = [];
  constructor(private now: () => number = Date.now) {}

  get(key: string): ModState { const e = this.entries.get(key); return e ? { cam: e.cam, mic: e.mic, vol: e.vol } : { ...MOD_DEFAULT }; }
  /** Raw entry (null = never moderated / back to normal). */
  entry(key: string): ModEntry | null { return this.entries.get(key) ?? null; }

  private put(key: string, name: string, s: ModState) {
    if (isDefault(s)) { this.entries.delete(key); return; }
    const e = this.entries.get(key);
    this.entries.set(key, { key, name: name || e?.name || 'Guest', cam: s.cam, mic: s.mic, vol: clamp01(s.vol), at: this.now() });
  }
  private record(c: ModChange) {
    this.history.push(c);
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
  }

  /** Change one guest. Returns the history step (null = nothing changed). */
  set(key: string, name: string, patch: Partial<ModState>, kind: ModKind, label: string): ModChange | null {
    const was = this.entries.has(key) ? this.get(key) : null;
    const cur = was ?? { ...MOD_DEFAULT };
    const next: ModState = { cam: patch.cam ?? cur.cam, mic: patch.mic ?? cur.mic, vol: patch.vol === undefined ? cur.vol : clamp01(patch.vol) };
    if (next.cam === cur.cam && next.mic === cur.mic && Math.abs(next.vol - cur.vol) < 0.005) return null;
    const t = this.now();
    const last = this.history[this.history.length - 1];
    // a volume drag is one Undo step (its `prev` stays the value before the drag started)
    if (kind === 'vol' && last?.kind === 'vol' && last.keys.length === 1 && last.keys[0] === key && t - last.at < VOL_MERGE_MS) {
      this.put(key, name, next); last.at = t; last.label = label; return last;
    }
    this.put(key, name, next);
    const c: ModChange = { kind, label, at: t, keys: [key], prev: [[key, was]] };
    this.record(c);
    return c;
  }
  /** Cut (or bring back) several guests in one Undo step. */
  setMany(list: { key: string; name: string }[], patch: Partial<ModState>, kind: ModKind, label: string): ModChange | null {
    const prev: [string, ModState | null][] = [];
    for (const g of list) {
      const was = this.entries.has(g.key) ? this.get(g.key) : null;
      const cur = was ?? { ...MOD_DEFAULT };
      const next: ModState = { cam: patch.cam ?? cur.cam, mic: patch.mic ?? cur.mic, vol: patch.vol === undefined ? cur.vol : clamp01(patch.vol) };
      if (next.cam === cur.cam && next.mic === cur.mic && Math.abs(next.vol - cur.vol) < 0.005) continue;
      prev.push([g.key, was]);
      this.put(g.key, g.name, next);
    }
    if (!prev.length) return null;
    const c: ModChange = { kind, label, at: this.now(), keys: prev.map(([k]) => k), prev };
    this.record(c);
    return c;
  }
  /** Undo the last step: everyone it touched goes back to how they were. Returns the step undone (null = nothing). */
  undo(): ModChange | null {
    const c = this.history.pop();
    if (!c) return null;
    for (const [k, s] of c.prev) {
      const name = this.entries.get(k)?.name ?? '';
      if (!s) this.entries.delete(k); else this.put(k, name, s);
    }
    return c;
  }
  get last(): ModChange | null { return this.history[this.history.length - 1] ?? null; }
  /** The host removed them for good: forget (Undo steps that name them stay harmless: they put back a state nobody reads). */
  forget(key: string) { this.entries.delete(key); }
  reset() { this.entries.clear(); this.history.length = 0; }

  /** sessionStorage (a studio reload that resumes the same party keeps who is cut). */
  save(): string { return JSON.stringify([...this.entries.values()].map((e) => ({ key: e.key, name: e.name, cam: e.cam, mic: e.mic, vol: e.vol }))); }
  load(s: string | null) {
    let v: unknown; try { v = JSON.parse(s || '[]'); } catch { return; }
    if (!Array.isArray(v)) return;
    for (const x of v.slice(0, 32) as Record<string, unknown>[]) {
      const key = typeof x?.key === 'string' && /^(link|discord|peer):[A-Za-z0-9]{1,40}$/.test(x.key) ? x.key : '';
      if (!key) continue;
      const st: ModState = { cam: x.cam === true, mic: x.mic === true, vol: clamp01(x.vol) };
      if (!isDefault(st)) this.entries.set(key, { key, name: typeof x.name === 'string' ? x.name.replace(/[\u0000-\u001f<>]/g, '').slice(0, 40) || 'Guest' : 'Guest', ...st, at: this.now() });
    }
  }
}

// ---------------------------------------------------------------- wire ('ctl' channel + relay backup, host → guest only)
export interface ModToGuest { t: 'mod'; cam: boolean; mic: boolean }
export function readModToGuest(v: unknown): ModToGuest | null {
  const o = v && typeof v === 'object' ? v as Record<string, unknown> : null;
  if (!o || o.t !== 'mod') return null;
  return { t: 'mod', cam: o.cam === true, mic: o.mic === true };
}
/** The banner a guest sees when the host's decision changes (plain words; '' = nothing new). */
export function modNotice(was: { cam: boolean; mic: boolean }, now: { cam: boolean; mic: boolean }, host = 'The host'): string {
  const H = host || 'The host';
  if (!was.cam && now.cam && !was.mic && now.mic) return `${H} turned off your camera and muted you`;
  if (was.cam && !now.cam && was.mic && !now.mic) return `${H} turned your camera and mic back on`;
  const out: string[] = [];
  if (!was.cam && now.cam) out.push(`${H} turned off your camera`);
  if (was.cam && !now.cam) out.push(`${H} turned your camera back on`);
  if (!was.mic && now.mic) out.push(`${H} muted you`);
  if (was.mic && !now.mic) out.push(`${H} turned your mic back on`);
  return out.join(' · ');
}
/** The guest page's steady line while a decision is in force. */
export function modStatus(s: { cam: boolean; mic: boolean }, host = 'The host'): string {
  const H = host || 'The host';
  // (clarity: your camera keeps running and the host still sees it, to check on you: say so, so nobody feels watched in secret)
  const still = ` ${H} can still see your camera to check on you. Viewers can’t. To turn your camera off fully, press Leave the show.`;
  if (s.cam && s.mic) return `${H} turned off your camera and muted you. Viewers see a “Camera off” card and can’t hear you. Only ${H} can turn them back on.${still}`;
  if (s.cam) return `${H} turned off your camera. Viewers and other guests see a “Camera off” card instead of you. Only ${H} can turn it back on.${still}`;
  if (s.mic) return `${H} muted you. Nobody on the show can hear you right now (you can still hear the show). Only ${H} can unmute you.`;
  return '';
}

// ---------------------------------------------------------------- the "Camera off" card (a picture every renderer shows)
/** Size + drawing plan of the card for a guest's picture: same aspect, pre-mirrored when their picture is shown
 *  mirrored, packed side by side when they send Spout2 alpha (shared/spout.ts), all-neutral when a chroma key is on
 *  (a coloured card could be keyed out). */
export interface CoverPlan { w: number; h: number; fw: number; mirror: boolean; neutral: boolean; pack: { cw: number; ax: number } | null }
export function coverPlan(info: { aspect?: number; mirror?: boolean; chroma?: unknown; pack?: { l: string; c: number; a: number } | null } | null, height = 360): CoverPlan {
  const asp = Math.min(3, Math.max(0.4, Number(info?.aspect) || 16 / 9));
  const h = Math.max(90, Math.min(720, Math.round(height / 2) * 2));
  const w = Math.max(2, Math.round((h * asp) / 2) * 2);
  const p = info?.pack && info.pack.l === 'sbs' && info.pack.c > 0 && info.pack.a >= info.pack.c ? info.pack : null;
  // packed: colour in [0, cw), alpha in [ax, ax + cw) — the same fractions the guest's frames use
  const fw = p ? Math.round(w / p.c) : w;
  return { w, h, fw, mirror: !!info?.mirror, neutral: !!info?.chroma, pack: p ? { cw: w, ax: Math.round(fw * p.a) } : null };
}
export const COVER_TITLE = 'Camera off';

// ---------------------------------------------------------------- the panel's words
export function modLabel(kind: ModKind, names: string[], on: boolean): string {
  const who = names.length === 1 ? names[0] : `${names.length} guests`;
  switch (kind) {
    case 'cam': return `${who}: camera ${on ? 'hidden' : 'back on'}`;
    case 'mic': return `${who}: ${on ? 'muted' : 'unmuted'}`;
    case 'vol': return `${who}: volume`;
    case 'cut': return `${who}: camera and mic cut`;
    case 'restore': return `${who}: back on`;
    case 'all': return `Cut all guests (${names.length})`;
    case 'allback': return `All guests back on (${names.length})`;
    default: return who;
  }
}
