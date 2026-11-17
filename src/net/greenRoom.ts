// Green room — the studio side (host and VTube Pro app guests). The rules and the wire format are in shared/greenroom.ts;
// this wires them to the party (src/party.ts owns one: `party.green`):
//   host  — who waits (GreenBook, keyed by a stable identity), Bring on / Back / Next, backstage voice per guest,
//           messages to guests, their READY / notes / mute state for the Live panel (src/ui/live/*);
//   guest — (a VTube Pro app guest) the host's messages + "you're in the green room", my READY / notes.
// The browser guest page speaks the same messages (src/net/tv/tvLiteGuest.ts).
import { GR_CAP, GreenBook, GUEST_MSG_MAX, HISTORY, cleanText, guestBuckets, isGreenMode, presetText, readToGuest, readToHost, stableKey, type GreenEntry, type GreenMode, type GuestEvent } from '../../shared/greenroom.ts';
import type { LiveGreen } from '../../shared/liveControl.ts';

const MODE_KEY = 'vtp.gr.mode';
const SAVE_KEY = 'vtp.gr.book';
const ls = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };

/** What the green room needs from the party. */
export interface GreenPort {
  role(): 'none' | 'host' | 'guest';
  /** host: ctl message to member `id` (false = no open link); guest: to the host (id ignored). */
  send(id: string, m: object): boolean;
  /** Does member `id` (host) / the host (guest) speak GR_CAP? */
  caps(id: string): boolean;
  /** host: who waits changed → re-plan roster, scene, TV forwards, voices. */
  changed(): void;
  /** anything shown changed (UI). */
  notify(): void;
  /** host: the party's relay room (the saved book belongs to it). */
  room(): string;
}

export class GreenRoom {
  readonly book = new GreenBook(isGreenMode(ls(MODE_KEY)) ? ls(MODE_KEY) as GreenMode : 'link');
  /** host: a guest said something (READY / a note) — the studio toasts it. */
  onGuest: ((ev: GuestEvent) => void) | null = null;
  /** host: guests walking out on their way back to the green room (their voice is already backstage). */
  private leaving = new Map<string, number>();
  // ---- guest side (a VTube Pro app guest)
  me = { wait: false, talk: false, ready: false, readyText: '', msgs: [] as { text: string; at: number }[], unread: 0 };
  /** guest: a host message arrived (the studio shows a banner / toast). */
  onMessage: ((text: string) => void) | null = null;
  private myBuckets = guestBuckets();

  constructor(private port: GreenPort) {
    setInterval(() => { if (this.port.role() === 'host') this.book.prune(); }, 60_000);
  }

  // ---------------------------------------------------------------- host
  get mode(): GreenMode { return this.book.mode; }
  setMode(m: GreenMode) { this.book.mode = m; try { localStorage.setItem(MODE_KEY, m); } catch { /* storage off */ } this.port.notify(); }
  /** Held out of the scene (not a member of the room / line-up / monitor). */
  hidden(id: string): boolean { return this.port.role() === 'host' && this.book.waiting(id); }
  /** Their voice stays backstage (waiting, or walking out on their way back). */
  backstage(id: string): boolean { return this.hidden(id) || this.leaving.has(id); }
  /** Backstage voice on for this waiting guest. */
  talking(id: string): boolean { return this.backstage(id) && !!this.book.byId(id)?.talk; }
  entry(id: string): GreenEntry | undefined { return this.book.byId(id); }

  /** A member's first hello (BEFORE they reach the roster / scene). `uid`: their Discord / link id. */
  admit(m: { id: string; name: string; uid?: string | null; link: boolean }) {
    if (this.port.role() !== 'host') return;
    this.restore();
    const e = this.book.admit(stableKey(m), m.id, m.name, m.link, this.port.caps(m.id));
    this.save();
    // (the ctl channel is open: they hear where they are right away)
    queueMicrotask(() => this.sync(e.id ?? ''));
  }
  left(id: string) {
    if (this.port.role() !== 'host') return;
    const was = this.book.byId(id)?.talk;
    this.book.left(id); this.leaving.delete(id);
    this.save();
    if (was) this.port.changed();
  }
  /** The host removed them: forgotten (a way back in starts in the green room again, per the mode). */
  forget(id: string) { if (this.port.role() !== 'host') return; clearTimeout(this.leaving.get(id)); this.leaving.delete(id); this.book.forget(id); this.save(); }
  /** Tell guest `id` where they are (green room / on air, backstage voice). */
  sync(id: string) {
    const e = this.book.byId(id);
    if (!e || !this.port.caps(id)) return;
    this.port.send(id, { t: 'gr', k: 'state', wait: e.stage === 'wait' || this.leaving.has(id), talk: e.talk });
  }
  bringOn(id: string): GreenEntry | null {
    const e = this.book.bringOn(id);
    if (!e) return null;
    this.leaving.delete(id);
    this.save(); this.port.changed(); this.sync(id);
    return e;
  }
  /** Back to the green room now (or after `afterMs`: the scene walks them out first; their voice goes backstage now). */
  back(id: string, afterMs = 0, slot: GreenEntry['slot'] = null): GreenEntry | null {
    const e = this.book.byId(id);
    if (!e || e.stage === 'wait' || !e.id) return null;
    const go = () => { this.leaving.delete(id); if (this.book.back(id, slot)) { this.save(); this.port.changed(); this.sync(id); } };
    if (afterMs > 0) {
      clearTimeout(this.leaving.get(id));
      this.leaving.set(id, window.setTimeout(go, afterMs));
      this.port.changed(); this.sync(id);
    } else go();
    return e;
  }
  next(): GreenEntry | null { return this.book.next(); }
  lastOn(): GreenEntry | null { return this.book.lastOn(); }
  setTalk(id: string, on: boolean): boolean {
    if (!this.book.setTalk(id, on)) return false;
    this.port.changed(); this.sync(id);
    return true;
  }
  /** Host → guest `id`: a preset id or custom text. '' = sent; else why not. */
  message(id: string, text: string, preset = ''): string {
    const e = this.book.byId(id);
    if (!e?.id) return 'That guest isn’t connected';
    if (!e.caps) return `${e.name}’s page is too old for messages (they need to reload it after you update the relay)`;
    const s = this.book.toGuest(id, preset ? presetText(preset) || text : text);
    if (!s) return cleanText(text, 1) || preset ? 'Slow down: too many messages to them' : 'Type a message first';
    if (!this.port.send(id, { t: 'gr', k: 'msg', text: s, at: Date.now(), ...(preset && presetText(preset) ? { p: preset } : {}) })) return 'Their connection isn’t open';
    this.port.notify();
    return '';
  }
  /** A {t:'gr'} message from the other side (party onCtl). */
  onCtl(from: string, fromGuest: boolean, raw: unknown) {
    if (fromGuest) {
      const m = readToHost(raw);
      const ev = m ? this.book.fromGuest(from, m) : null;
      if (!ev) return;
      if (ev.kind !== 'mute') this.onGuest?.(ev);
      this.port.notify();
      return;
    }
    const m = readToGuest(raw);
    if (!m) return;
    if (m.k === 'state') { const was = this.me.wait; this.me.wait = m.wait; this.me.talk = m.talk; if (was && !m.wait) this.me.ready = false; this.port.notify(); return; }
    this.me.msgs.push({ text: m.text, at: Date.now() });
    if (this.me.msgs.length > HISTORY) this.me.msgs.splice(0, this.me.msgs.length - HISTORY);
    this.me.unread++;
    this.onMessage?.(m.text);
    this.port.notify();
  }
  /** Rebuild after the party ended. */
  reset() {
    for (const t of this.leaving.values()) clearTimeout(t);
    this.leaving.clear();
    this.book.reset();
    this.restoredFor = '';
    this.me = { wait: false, talk: false, ready: false, readyText: '', msgs: [], unread: 0 };
    try { sessionStorage.removeItem(SAVE_KEY); } catch { /* storage off */ }
  }
  /** The host's view of one member for the Live panel (media numbers come from the caller: feeds, stats, thumbnails). */
  view(id: string, media: { thumb?: string; level?: number; conn?: LiveGreen['conn'] } = {}): LiveGreen | undefined {
    const e = this.book.byId(id);
    if (!e) return undefined;
    const last = e.sent[e.sent.length - 1];
    return {
      wait: e.stage === 'wait' || this.leaving.has(id), since: e.since, caps: e.caps, link: e.link,
      ...(e.ready?.on ? { ready: { text: e.ready.text, at: e.ready.at } } : {}),
      ...(e.note ? { note: { text: e.note.text, at: e.note.at } } : {}),
      ...(e.micOff !== null ? { micOff: e.micOff } : {}),
      ...(e.talk ? { talk: true } : {}),
      ...(last ? { last: { text: last.text, at: last.at } } : {}),
      ...media,
    };
  }
  private restoredFor = '';
  private restore() {
    const room = this.port.room();
    if (!room || this.restoredFor === room) return;
    this.restoredFor = room;
    try { const s = JSON.parse(sessionStorage.getItem(SAVE_KEY) || 'null') as { room?: string; book?: string } | null; if (s?.room === room) this.book.load(s.book ?? null); } catch { /* */ }
  }
  private save() {
    const room = this.port.room();
    if (!room) return;
    try { sessionStorage.setItem(SAVE_KEY, JSON.stringify({ room, book: this.book.save() })); } catch { /* storage off */ }
  }

  // ---------------------------------------------------------------- guest (VTube Pro app)
  /** Does the host speak green room messages? */
  get hostKnows(): boolean { return this.port.role() === 'guest' && this.port.caps(''); }
  setReady(on: boolean, text = this.me.readyText): string {
    if (!this.hostKnows) return 'The host’s VTube Pro is too old for this';
    const t = cleanText(text, GUEST_MSG_MAX);
    if (!this.myBuckets.say.take()) return 'Slow down a moment';
    this.me.ready = on; this.me.readyText = t;
    this.port.send('', { t: 'gr', k: 'ready', on, text: on ? t : '' });
    this.port.notify();
    return '';
  }
  note(text: string): string {
    const t = cleanText(text, GUEST_MSG_MAX);
    if (!t) return 'Type a message first';
    if (!this.hostKnows) return 'The host’s VTube Pro is too old for this';
    if (!this.myBuckets.say.take()) return 'Slow down a moment';
    this.port.send('', { t: 'gr', k: 'note', text: t });
    return '';
  }
  /** Guest: the host link came back — re-send my READY (the host forgets it on a reconnect). */
  hello() { if (this.hostKnows && this.me.ready) this.port.send('', { t: 'gr', k: 'ready', on: true, text: this.me.readyText }); }
}

/** Host: small live thumbnails of green-room guests' cameras (for the Live panel, which may be another window: they
 *  travel as small JPEG data URLs in the bus liveStatus, RAM only, never stored). One muted, never-attached <video> per
 *  feed; nothing is played. */
export class ThumbGrabber {
  private vids = new Map<string, { v: HTMLVideoElement; track: MediaStreamTrack; url: string; at: number }>();
  private cv: HTMLCanvasElement | null = null;
  constructor(private w = 160, private h = 90, private everyMs = 2000) {}
  /** The current thumbnail of `id`'s feed ('' = none yet). Refreshes at most every `everyMs`. */
  get(id: string, feed: { stream: MediaStream; track: MediaStreamTrack } | null | undefined): string {
    let x = this.vids.get(id);
    if (!feed || feed.track.readyState !== 'live') { if (x) this.drop(id); return ''; }
    if (x && x.track !== feed.track) { this.drop(id); x = undefined; }
    if (!x) {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.autoplay = true; v.srcObject = new MediaStream([feed.track]);
      void v.play().catch(() => {});
      x = { v, track: feed.track, url: '', at: 0 };
      this.vids.set(id, x);
    }
    const now = performance.now();
    if (now - x.at >= this.everyMs && x.v.readyState >= 2 && x.v.videoWidth) {
      x.at = now;
      try {
        this.cv ??= Object.assign(document.createElement('canvas'), { width: this.w, height: this.h });
        const g = this.cv.getContext('2d')!;
        const vw = x.v.videoWidth, vh = x.v.videoHeight, s = Math.max(this.w / vw, this.h / vh);
        g.fillStyle = '#000'; g.fillRect(0, 0, this.w, this.h);
        g.drawImage(x.v, (this.w - vw * s) / 2, (this.h - vh * s) / 2, vw * s, vh * s);
        x.url = this.cv.toDataURL('image/jpeg', 0.62);
      } catch { /* not decodable yet */ }
    }
    return x.url;
  }
  /** Keep only these ids. */
  keep(ids: Set<string>) { for (const id of [...this.vids.keys()]) if (!ids.has(id)) this.drop(id); }
  private drop(id: string) { const x = this.vids.get(id); if (!x) return; x.v.pause(); x.v.srcObject = null; this.vids.delete(id); }
}

/** A link's health in words for the host (rtt ms from the party pings; the video numbers from the TV link stats). */
export function connOf(o: { pc: RTCPeerConnectionState | ''; rtt: number; feed?: { kbps: number; fps: number; width: number; height: number; lost?: number } | null }): NonNullable<LiveGreen['conn']> {
  const f = o.feed;
  const video = f && f.height ? `${f.width}×${f.height} · ${f.fps} fps · ${f.kbps} kbit/s` : '';
  if (o.pc !== 'connected') return { st: o.pc === 'failed' || o.pc === 'closed' ? 'poor' : 'connecting', rtt: o.rtt, video };
  const st = o.rtt > 400 || (f && f.fps > 0 && f.fps < 8) ? 'poor' : o.rtt > 180 || (f && f.fps > 0 && f.fps < 15) ? 'fair' : 'good';
  return { st, rtt: o.rtt, video };
}
export { GR_CAP };
