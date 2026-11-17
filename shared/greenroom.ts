// Green room (waiting room) for party guests + host ↔ guest messages + the guest page's mute hotkey. Pure data and
// helpers shared by the host studio (src/net/greenRoom.ts, src/party.ts), the no-install guest page
// (relay/tvguest/main.ts → src/net/tv/tvLiteGuest.ts), the Live panel and tools/greenroom_unit.ts. No DOM, no network.
//
// How it works (docs/MULTIPLAYER_DISCORD.md → "Green room"):
//  • An approved guest connects fully (camera, mic level, connection), but while they WAIT they are not a scene member:
//    not in the room, not on the Interview monitor / line-up, no walk-in, their voice never reaches stream. The host
//    tech-checks them in the Live panel, then presses Bring on.
//  • Their state is kept by a STABLE identity, not the party id (a link guest gets a new party id on every rejoin):
//    the Discord user id, or for a no-sign-in link guest the relay's per-browser-tab id ("link" + 20 hex: a hash of the
//    invite + a random key the page keeps in sessionStorage). The same tab rejoining keeps its place (on air stays on
//    air); a new tab / browser / invite is a new guest and waits again. Guests with neither (manual invite codes) are
//    keyed by their party id.
//  • Messages travel on the existing host ↔ guest 'ctl' data channel as {t:'gr', …} (both the browser guest page and
//    VTube Pro app guests): plain text only, length-capped, rate-limited on both ends.

/** Capability: this peer speaks the green room messages. Old guest pages / apps without it can still be held in the
 *  green room (they just don't see messages). */
export const GR_CAP = 'gr1';
export const HOST_MSG_MAX = 140;
export const GUEST_MSG_MAX = 100;
/** Host messages kept per guest (the guest page keeps its own history too). */
export const HISTORY = 12;
/** A guest who disconnected is remembered this long (same key back → same place: waiting or on air). */
export const FORGET_MS = 30 * 60_000;

/** One-click host → guest messages. */
export const GR_PRESETS = [
  { id: 'next', label: 'Up next', text: 'You’re up next' },
  { id: 'minute', label: 'In 1 min', text: 'Going on in 1 minute' },
  { id: 'live', label: 'You’re live', text: 'You’re live now!' },
  { id: 'hold', label: 'Hang tight', text: 'Hang tight a moment' },
] as const;
export type GrPresetId = (typeof GR_PRESETS)[number]['id'];
export const presetText = (id: string): string => GR_PRESETS.find((p) => p.id === id)?.text ?? '';

/** Who waits in the green room when they join: link guests (default), everyone, or nobody. */
export type GreenMode = 'link' | 'all' | 'off';
export const isGreenMode = (v: unknown): v is GreenMode => v === 'link' || v === 'all' || v === 'off';
export function shouldWait(mode: GreenMode, link: boolean): boolean { return mode === 'all' || (mode === 'link' && link); }

/** Plain text: no control / bidi-override / zero-width characters, no angle brackets, whitespace collapsed, capped by
 *  code points (never splits a surrogate pair). */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, max).join('').trim();
}

/** The stable identity of a party member (see the header). `uid` = their verified Discord id / link id, if any. */
export function stableKey(m: { id: string; uid?: string | null }): string {
  const u = String(m.uid ?? '');
  if (/^link[0-9a-f]{20}$/.test(u)) return `link:${u}`;
  if (/^\d{5,25}$/.test(u)) return `discord:${u}`;
  return `peer:${m.id}`;
}
export const isLinkKey = (k: string) => k.startsWith('link:');

// ---------------------------------------------------------------- wire ('ctl' channel, JSON {t:'gr', k, …})
export type GrToGuest =
  | { t: 'gr'; k: 'state'; wait: boolean; talk: boolean }                 // you're in the green room / on air; backstage voice on
  | { t: 'gr'; k: 'msg'; text: string; at: number; p?: string };          // a host message (p = preset id)
export type GrToHost =
  | { t: 'gr'; k: 'ready'; on: boolean; text: string }                    // "I'm ready" (+ optional short message)
  | { t: 'gr'; k: 'note'; text: string }                                  // a short message
  | { t: 'gr'; k: 'mute'; on: boolean };                                  // my mic is muted (guest page)

export function readToGuest(v: unknown): GrToGuest | null {
  const o = v && typeof v === 'object' ? v as Record<string, unknown> : null;
  if (!o || o.t !== 'gr') return null;
  if (o.k === 'state') return { t: 'gr', k: 'state', wait: o.wait === true, talk: o.talk === true };
  if (o.k === 'msg') {
    const text = cleanText(o.text, HOST_MSG_MAX);
    if (!text) return null;
    const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0;
    const p = typeof o.p === 'string' && GR_PRESETS.some((x) => x.id === o.p) ? o.p : undefined;
    return { t: 'gr', k: 'msg', text, at, ...(p ? { p } : {}) };
  }
  return null;
}
export function readToHost(v: unknown): GrToHost | null {
  const o = v && typeof v === 'object' ? v as Record<string, unknown> : null;
  if (!o || o.t !== 'gr') return null;
  if (o.k === 'ready') return { t: 'gr', k: 'ready', on: o.on === true, text: cleanText(o.text, GUEST_MSG_MAX) };
  if (o.k === 'note') { const text = cleanText(o.text, GUEST_MSG_MAX); return text ? { t: 'gr', k: 'note', text } : null; }
  if (o.k === 'mute') return { t: 'gr', k: 'mute', on: o.on === true };
  return null;
}

// ---------------------------------------------------------------- rate limits
/** Token bucket: `cap` messages at once, then one per `every` ms. */
export class Bucket {
  private tok: number; private at: number;
  constructor(private cap: number, private every: number, now = Date.now()) { this.tok = cap; this.at = now; }
  take(now = Date.now()): boolean {
    this.tok = Math.min(this.cap, this.tok + Math.max(0, now - this.at) / this.every);
    this.at = now;
    if (this.tok < 1) return false;
    this.tok -= 1;
    return true;
  }
}
/** Guest → host: ready / notes (5 at once, then one per 3 s); mute state (PTT toggles: 20, then 4 per second). */
export const guestBuckets = (now = Date.now()) => ({ say: new Bucket(5, 3000, now), mute: new Bucket(20, 250, now) });
/** Host → one guest: 6 at once, then one per 2 s (a deck key held down can't flood their page). */
export const hostBucket = (now = Date.now()) => new Bucket(6, 2000, now);

// ---------------------------------------------------------------- the host's book
export type Stage = 'wait' | 'air';
export interface GreenEntry {
  key: string; name: string; link: boolean;
  /** Current party id (null = disconnected right now, remembered for FORGET_MS). */
  id: string | null;
  stage: Stage;
  /** When they entered this stage / first knocked (ms). */
  since: number;
  ready: { on: boolean; text: string; at: number } | null;
  note: { text: string; at: number } | null;
  /** Their mic is muted on their page (null = unknown: an older page, or voice through Discord). */
  micOff: boolean | null;
  /** Backstage voice with the host (only while waiting). */
  talk: boolean;
  /** Host messages sent to them, newest last. */
  sent: { text: string; at: number }[];
  /** Speaks GR_CAP (sees messages). */
  caps: boolean;
  goneAt: number;
  /** Brought on: the scene gives them the Entrances setting's way in (walk / instant) once. */
  entering: boolean;
  /** Where they sat in the Interview line-up when they went back (restored when they come on again): index, place,
   *  and their role (a co-host comes back as a co-host). */
  slot: { i: number; place?: string; role?: 'cohost' } | null;
}
export interface GuestEvent { kind: 'ready' | 'note' | 'mute'; entry: GreenEntry }

export class GreenBook {
  readonly entries = new Map<string, GreenEntry>();
  private buckets = new Map<string, ReturnType<typeof guestBuckets>>();
  private out = new Map<string, Bucket>();
  constructor(public mode: GreenMode = 'link', private now: () => number = Date.now) {}

  /** A member connected (their hello): known key → their remembered stage; new → the green room mode decides. */
  admit(key: string, id: string, name: string, link: boolean, caps = false): GreenEntry {
    const t = this.now();
    for (const e of this.entries.values()) if (e.id === id && e.key !== key) e.id = null;       // (id reuse: never two entries)
    let e = this.entries.get(key);
    if (!e) {
      e = { key, name, link, id, stage: shouldWait(this.mode, link) ? 'wait' : 'air', since: t, ready: null, note: null, micOff: null, talk: false, sent: [], caps, goneAt: 0, entering: false, slot: null };
      this.entries.set(key, e);
    } else {
      Object.assign(e, { id, name, link, caps, goneAt: 0 });
      e.ready = null; e.micOff = null;     // their page re-sends its current state after a reconnect
    }
    return e;
  }
  /** Their link is gone (they stay remembered). */
  left(id: string) {
    const e = this.byId(id);
    if (!e) return;
    e.id = null; e.goneAt = this.now(); e.talk = false; e.ready = null; e.micOff = null; e.entering = false;
  }
  byId(id: string): GreenEntry | undefined { if (!id) return undefined; for (const e of this.entries.values()) if (e.id === id) return e; return undefined; }
  /** Held out of the scene right now. */
  waiting(id: string): boolean { return this.byId(id)?.stage === 'wait'; }
  bringOn(id: string): GreenEntry | null {
    const e = this.byId(id);
    if (!e || e.stage === 'air') return null;
    Object.assign(e, { stage: 'air', since: this.now(), talk: false, entering: true });
    e.ready = null;
    return e;
  }
  back(id: string, slot: GreenEntry['slot'] = null): GreenEntry | null {
    const e = this.byId(id);
    if (!e || e.stage === 'wait') return null;
    Object.assign(e, { stage: 'wait', since: this.now(), talk: false, entering: false, ...(slot ? { slot } : {}) });
    e.ready = null;
    return e;
  }
  /** The next guest to bring on: READY first (who said it first), then who has waited longest. Connected only. */
  next(): GreenEntry | null {
    const w = [...this.entries.values()].filter((e) => e.stage === 'wait' && e.id);
    w.sort((a, b) => (a.ready?.on ? 0 : 1) - (b.ready?.on ? 0 : 1) || (a.ready?.on && b.ready?.on ? a.ready.at - b.ready.at : 0) || a.since - b.since);
    return w[0] ?? null;
  }
  /** The on-air guest who came on most recently (Back to green room / Next guest with nobody named). */
  lastOn(): GreenEntry | null {
    const a = [...this.entries.values()].filter((e) => e.stage === 'air' && e.id);
    a.sort((x, y) => y.since - x.since);
    return a[0] ?? null;
  }
  setTalk(id: string, on: boolean): GreenEntry | null { const e = this.byId(id); if (!e || (on && e.stage !== 'wait')) return null; e.talk = on; return e; }
  /** A {t:'gr'} message from guest `id` (already read with readToHost): applied, or null (unknown / rate-limited). */
  fromGuest(id: string, m: GrToHost): GuestEvent | null {
    const e = this.byId(id);
    if (!e) return null;
    let b = this.buckets.get(e.key);
    if (!b) { b = guestBuckets(this.now()); this.buckets.set(e.key, b); }
    const t = this.now();
    if (m.k === 'mute') { if (!b.mute.take(t)) return null; e.micOff = m.on; return { kind: 'mute', entry: e }; }
    if (!b.say.take(t)) return null;
    if (m.k === 'ready') { e.ready = { on: m.on, text: m.text, at: t }; if (m.text) e.note = { text: m.text, at: t }; return { kind: 'ready', entry: e }; }
    e.note = { text: m.text, at: t };
    return { kind: 'note', entry: e };
  }
  /** Host → guest `id`: the cleaned text to send, or '' (nothing to send / rate-limited / they can't read it). */
  toGuest(id: string, text: string): string {
    const e = this.byId(id);
    const s = cleanText(text, HOST_MSG_MAX);
    if (!e || !s) return '';
    let b = this.out.get(e.key);
    if (!b) { b = hostBucket(this.now()); this.out.set(e.key, b); }
    if (!b.take(this.now())) return '';
    e.sent.push({ text: s, at: this.now() });
    if (e.sent.length > HISTORY) e.sent.splice(0, e.sent.length - HISTORY);
    return s;
  }
  /** Removed by the host: forget them (if they get back in, they start in the green room again). */
  forget(id: string) { const e = this.byId(id); if (e) { this.entries.delete(e.key); this.buckets.delete(e.key); this.out.delete(e.key); } }
  /** Forget guests gone longer than FORGET_MS. */
  prune() {
    const t = this.now();
    for (const [k, e] of this.entries) if (!e.id && t - e.goneAt > FORGET_MS) { this.entries.delete(k); this.buckets.delete(k); this.out.delete(k); }
  }
  reset() { this.entries.clear(); this.buckets.clear(); this.out.clear(); }
  /** For sessionStorage (a studio reload that resumes the same party keeps who is waiting / on air). */
  save(): string {
    return JSON.stringify([...this.entries.values()].map((e) => ({ key: e.key, name: e.name, link: e.link, stage: e.stage, since: e.since, slot: e.slot })));
  }
  load(s: string | null) {
    let v: unknown; try { v = JSON.parse(s || '[]'); } catch { return; }
    if (!Array.isArray(v)) return;
    const t = this.now();
    for (const x of v.slice(0, 32) as Record<string, unknown>[]) {
      const key = typeof x?.key === 'string' && /^(link|discord|peer):[A-Za-z0-9]{1,40}$/.test(x.key) ? x.key : '';
      if (!key || this.entries.has(key)) continue;
      const slot = x.slot && typeof x.slot === 'object' ? x.slot as { i?: unknown; place?: unknown; role?: unknown } : null;
      this.entries.set(key, { key, name: cleanText(x.name, 40) || 'Guest', link: x.link === true, id: null, stage: x.stage === 'air' ? 'air' : 'wait', since: Number(x.since) || t,
        ready: null, note: null, micOff: null, talk: false, sent: [], caps: false, goneAt: t, entering: false,
        slot: slot && Number.isInteger(slot.i) ? { i: Math.max(0, Math.min(7, Number(slot.i))), ...(slot.place === 'studio' || slot.place === 'monitor' ? { place: slot.place } : {}), ...(slot.role === 'cohost' ? { role: 'cohost' as const } : {}) } : null });
    }
  }
}

// ---------------------------------------------------------------- Interview line-up (src/scene/controller.ts)
type Lined = { key?: string; place?: 'studio' | 'monitor'; role?: 'cohost' };
type Slot = { i: number; place?: 'studio' | 'monitor'; role?: 'cohost' };
/** Waiting guests (co-hosts too) leave the line-up; returns the rest + where each one sat and their role (to restore
 *  when they come back on). */
export function lineupWithoutWaiting<G extends Lined>(guests: G[], waiting: (key: string) => boolean): { guests: G[]; removed: { key: string; slot: Slot }[] } {
  const removed: { key: string; slot: Slot }[] = [];
  const kept = guests.filter((g, i) => {
    if (!g.key || !waiting(g.key)) return true;
    removed.push({ key: g.key, slot: { i, ...(g.place ? { place: g.place } : {}), ...(g.role === 'cohost' ? { role: 'cohost' as const } : {}) } });
    return false;
  });
  return { guests: kept, removed };
}
/** A guest brought back on: move their (newly added) entry to their old slot, place and role. Returns a new array. */
export function restoreSlot<G extends Lined>(guests: G[], key: string, slot: { i: number; place?: string; role?: string }): G[] {
  const out = guests.slice();
  const at = out.findIndex((g) => g.key === key);
  if (at < 0) return out;
  const g = { ...out[at], ...(slot.place === 'studio' || slot.place === 'monitor' ? { place: slot.place } : {}), ...(slot.role === 'cohost' ? { role: 'cohost' as const } : {}) };
  out.splice(at, 1);
  out.splice(Math.max(0, Math.min(slot.i, out.length)), 0, g);
  return out;
}

// ---------------------------------------------------------------- the guest page's mute hotkey
/** A key combo: the physical key (KeyboardEvent.code, layout-independent) + exact modifiers. */
export interface Combo { code: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }
export const DEFAULT_COMBO: Combo = { code: 'KeyM', ctrl: false, shift: false, alt: false, meta: false };
const MOD = /^(Control|Shift|Alt|Meta|OS|Fn|CapsLock)(Left|Right|Lock)?$/;
type KeyLike = { code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean };
/** The combo a keydown means (null for a bare modifier, Escape = cancel, Tab = focus moves). */
export function comboFrom(e: KeyLike): Combo | null {
  if (!e.code || MOD.test(e.code) || e.code === 'Escape' || e.code === 'Tab' || !/^[A-Za-z0-9]{1,24}$/.test(e.code)) return null;
  return { code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
}
export function comboLabel(c: Combo): string {
  const k = c.code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ').replace(/^Arrow/, '')
    .replace(/^Backquote$/, '`').replace(/^Minus$/, '-').replace(/^Equal$/, '=').replace(/^BracketLeft$/, '[').replace(/^BracketRight$/, ']')
    .replace(/^Semicolon$/, ';').replace(/^Quote$/, '\'').replace(/^Comma$/, ',').replace(/^Period$/, '.').replace(/^Slash$/, '/').replace(/^Backslash$/, '\\');
  return [c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', c.meta && 'Meta', k].filter(Boolean).join('+');
}
/** keydown: the same key with exactly these modifiers. keyup (push-to-talk release): the key alone is enough. */
export function comboMatch(c: Combo | null, e: KeyLike, release = false): boolean {
  if (!c || e.code !== c.code) return false;
  return release || (e.ctrlKey === c.ctrl && e.shiftKey === c.shift && e.altKey === c.alt && e.metaKey === c.meta);
}
/** A plain key (no Ctrl / Alt / Meta) would fire while typing in a text box: the page ignores it there. */
export const comboTypes = (c: Combo) => !c.ctrl && !c.alt && !c.meta;
export function readCombo(s: string | null): Combo | null {
  try {
    const o = JSON.parse(s || 'null') as Record<string, unknown> | null;
    if (!o || typeof o.code !== 'string') return null;
    return comboFrom({ code: o.code, ctrlKey: o.ctrl === true, shiftKey: o.shift === true, altKey: o.alt === true, metaKey: o.meta === true });
  } catch { return null; }
}
