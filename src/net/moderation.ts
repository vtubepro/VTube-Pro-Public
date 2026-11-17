// Host moderation — the studio side (host, and a VTube Pro app guest being told). Rules + wire: shared/moderation.ts.
// The party owns one (`party.mod`); the outputs ask it:
//   TV links (src/net/tv/tvLink.ts)   — forwards to other guests carry the "Camera off" card; a muted guest's level is 0
//   TvStudio (src/net/tv/tvStudio.ts) — this PC's OBS pages get the card + no voice; studio speakers drop the voice
//   PartyVoice (via TvStudio.voiceVol) — a muted guest is out of every other guest's mix (they still hear the show)
//   Party (src/party.ts)              — a hidden 3D-avatar guest leaves the room; a muted app guest's mouth samples drop
// The "Camera off" card is a real video track (a canvas), so every renderer shows it with no change on their side.
import { COVER_TITLE, MOD_CAP, ModBook, coverPlan, effectiveVol, isCut, modLabel, modNotice, readModToGuest, showsPicture, type ModChange, type ModKind, type ModState } from '../../shared/moderation.ts';
import { stableKey } from '../../shared/greenroom.ts';
import type { TvInfo } from '../../shared/tv.ts';

const SAVE_KEY = 'vtp.mod.book';
const HOLD_KEY = 'vtp.mod.hold';

/** What moderation needs from the party. */
export interface ModPort {
  role(): 'none' | 'host' | 'guest';
  /** host: the guests (party id, name, verified uid for the stable key). */
  guests(): { id: string; name: string; uid?: string | null }[];
  /** host: their TV info (null = a 3D avatar: no picture to swap). */
  tvOf(id: string): TvInfo | null;
  /** host → guest `id`: a ctl message, only when they speak MOD_CAP (false = not sent). */
  send(id: string, m: object): boolean;
  /** host → guest `id` through the relay (backup path; no-op without a relay). */
  relay(id: string, m: { cam: boolean; mic: boolean }): void;
  /** host: who is moderated changed → re-plan roster, TV forwards, OBS feeds, voices. */
  changed(ids: string[]): void;
  notify(): void;
  /** host: the party's relay room (the saved book belongs to it). */
  room(): string;
}

/** The "Camera off" card as a live video track (one per hidden guest). Frames are re-sent a few times a second, so
 *  receivers never mark it stalled; the ticks come from a tiny worker when possible (background tabs throttle timers). */
class CoverCards {
  private cards = new Map<string, { sig: string; cv: HTMLCanvasElement; stream: MediaStream; track: MediaStreamTrack & { requestFrame?: () => void } }>();
  private tickT = 0;
  private worker: Worker | null = null;

  get(id: string, name: string, info: TvInfo | null): { stream: MediaStream; track: MediaStreamTrack } | null {
    const plan = coverPlan(info);
    const sig = JSON.stringify([name, plan]);
    let c = this.cards.get(id);
    if (c && c.sig === sig && c.track.readyState === 'live') return c;
    if (c && c.track.readyState === 'live' && c.cv.width === plan.fw && c.cv.height === plan.h) { c.sig = sig; draw(c.cv, plan, name); c.track.requestFrame?.(); return c; }
    if (c) this.drop(id);
    try {
      const cv = document.createElement('canvas');
      cv.width = plan.fw; cv.height = plan.h;
      draw(cv, plan, name);
      const stream = cv.captureStream(0);
      const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
      if (!track) return null;
      try { (track as MediaStreamTrack & { contentHint: string }).contentHint = 'detail'; } catch { /* */ }
      track.requestFrame?.();
      c = { sig, cv, stream, track };
      this.cards.set(id, c);
      this.run();
      return c;
    } catch { return null; }
  }
  /** Keep only these ids (a guest back on: their card track stops). */
  keep(ids: Set<string>) { for (const id of [...this.cards.keys()]) if (!ids.has(id)) this.drop(id); this.run(); }
  private drop(id: string) { const c = this.cards.get(id); if (!c) return; try { c.track.stop(); } catch { /* */ } this.cards.delete(id); }
  /** Every tick: touch one corner pixel (two near-identical shades) so the canvas is "dirty" — Chromium only captures a
   *  changed canvas, and a still card would otherwise send ONE frame: receivers would call it stalled, then NO SIGNAL. */
  private flip = false;
  private tick = () => {
    this.flip = !this.flip;
    for (const c of this.cards.values()) {
      const g = c.cv.getContext('2d');
      if (g) { g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = this.flip ? '#0a0b0d' : '#090a0c'; g.fillRect(0, c.cv.height - 1, 1, 1); }
      c.track.requestFrame?.();
    }
  };
  private run() {
    const want = this.cards.size > 0;
    if (want && !this.tickT && !this.worker) {
      try {
        const src = 'let t=0;onmessage=(e)=>{clearInterval(t);if(e.data)t=setInterval(()=>postMessage(0),200)}';
        this.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        this.worker.onmessage = this.tick;
        this.worker.postMessage(1);
      } catch { this.worker = null; }
      if (!this.worker) this.tickT = window.setInterval(this.tick, 200);
    } else if (!want) {
      if (this.worker) { this.worker.postMessage(0); this.worker.terminate(); this.worker = null; }
      if (this.tickT) { clearInterval(this.tickT); this.tickT = 0; }
    }
  }
  reset() { this.keep(new Set()); }
}

/** Draw the card: calm, neutral, the brand's type; pre-mirrored / packed per the plan (shared/moderation.ts coverPlan). */
function draw(cv: HTMLCanvasElement, plan: ReturnType<typeof coverPlan>, name: string) {
  const g = cv.getContext('2d');
  if (!g) return;
  const { w, h } = plan;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, cv.width, cv.height);
  if (plan.pack) { g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, h); g.fillStyle = '#fff'; g.fillRect(plan.pack.ax, 0, plan.pack.cw, h); }   // alpha half: fully opaque
  g.save();
  if (plan.mirror) { g.translate(w, 0); g.scale(-1, 1); }
  // background: near-black, neutral (no hue: a chroma key can't eat it)
  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#15181b'); bg.addColorStop(1, '#090a0c');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  const vg = g.createRadialGradient(w / 2, h * 0.42, h * 0.05, w / 2, h * 0.42, Math.max(w, h) * 0.75);
  vg.addColorStop(0, 'rgba(255,255,255,0.06)'); vg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = vg; g.fillRect(0, 0, w, h);
  // hairline frame
  const u = h / 360;
  g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = Math.max(1, 1.5 * u);
  g.strokeRect(10 * u, 10 * u, w - 20 * u, h - 20 * u);
  // camera-off glyph in a soft disc
  const cx = w / 2, cy = h * 0.38, r = 34 * u;
  g.fillStyle = 'rgba(255,255,255,0.07)'; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#d9dfdb'; g.lineWidth = 2.6 * u; g.lineJoin = 'round'; g.lineCap = 'round';
  const bw = 26 * u, bh = 19 * u, bx = cx - 17 * u, by = cy - bh / 2;
  g.beginPath(); (g as CanvasRenderingContext2D & { roundRect?: (...a: number[]) => void }).roundRect?.(bx, by, bw, bh, 4 * u) ?? g.rect(bx, by, bw, bh); g.stroke();
  g.beginPath(); g.moveTo(bx + bw, cy - 3 * u); g.lineTo(bx + bw + 9 * u, cy - 8 * u); g.lineTo(bx + bw + 9 * u, cy + 8 * u); g.lineTo(bx + bw, cy + 3 * u); g.stroke();
  g.strokeStyle = plan.neutral ? '#eef3ef' : '#ff6b6b';
  g.beginPath(); g.moveTo(cx - 22 * u, cy - 20 * u); g.lineTo(cx + 22 * u, cy + 20 * u); g.stroke();
  // words
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.fillStyle = '#eef3ef';
  g.font = `700 ${Math.round(30 * u)}px Archivo, "Segoe UI", system-ui, sans-serif`;
  g.fillText(COVER_TITLE, cx, h * 0.66, w * 0.86);
  g.fillStyle = '#9aa6a0';
  g.font = `500 ${Math.round(17 * u)}px Geist, "Segoe UI", system-ui, sans-serif`;
  g.fillText(name.slice(0, 40), cx, h * 0.66 + 28 * u, w * 0.86);
  // a small lime accent under the title (left out when a chroma key could catch it)
  if (!plan.neutral) { g.fillStyle = '#7bd88f'; g.fillRect(cx - 14 * u, h * 0.66 + 44 * u, 28 * u, 2 * u); }
  g.restore();
  // pack: everything drawn in the colour half (the mirror translate keeps it there)
}

export class Moderation {
  readonly book = new ModBook();
  private cards = new CoverCards();
  /** host: guests whose decision changed and still need telling (their link wasn't open). */
  private untold = new Set<string>();
  /** Cut also sends them back to the green room (the panel's switch; remembered). */
  hold = (() => { try { return localStorage.getItem(HOLD_KEY) === '1'; } catch { return false; } })();
  // ---- guest side (a VTube Pro app guest)
  me = { cam: false, mic: false, at: 0, notice: '' };
  /** guest: the host's decision about me changed (the studio toasts it; party voice locks my unmute). */
  onMine: ((text: string, s: { cam: boolean; mic: boolean }) => void) | null = null;

  constructor(private port: ModPort) {}

  // ---------------------------------------------------------------- host: reading (the outputs call these)
  private keyOf(id: string): string {
    const g = this.port.guests().find((x) => x.id === id);
    return stableKey({ id, uid: g?.uid ?? null });
  }
  state(id: string): ModState { return this.port.role() === 'host' ? this.book.get(this.keyOf(id)) : { cam: false, mic: false, vol: 1 }; }
  camOff(id: string): boolean { return this.port.role() === 'host' && this.state(id).cam; }
  micOff(id: string): boolean { return this.port.role() === 'host' && (this.state(id).mic || this.brbQuiet); }
  /** live-tabs BRB (shared/brb.ts): every guest is silent on stream and in the other guests' mixes while the host is on
   *  BRB. A layer over the host's own decisions (the book is never touched), so BRB off restores them exactly —
   *  a guest the host had muted stays muted, one the host unmuted / muted during BRB keeps that. */
  brbQuiet = false;
  setBrbQuiet(on: boolean) {
    if (on === this.brbQuiet) return;
    this.brbQuiet = on;
    if (this.port.role() !== 'host') return;
    this.port.changed(this.port.guests().map((g) => g.id));
    this.port.notify();
  }
  /** The host's volume for them (undefined = never set: callers use their own default). Mute is separate. */
  vol(id: string): number | undefined { if (this.port.role() !== 'host') return undefined; const e = this.book.entry(this.keyOf(id)); return e ? e.vol : undefined; }
  /** Effective volume (0 = muted). */
  outVol(id: string, base = 1): number { return this.port.role() === 'host' ? effectiveVol(this.state(id), base) : base; }
  /** A 3D-avatar guest with the camera off is held out of the room (no picture to swap for a card). */
  avatarHidden(id: string): boolean { return this.camOff(id) && !this.port.tvOf(id); }
  /** The "Camera off" card for guest `id` while hidden (null = show their real picture). */
  cover(id: string): { stream: MediaStream; track: MediaStreamTrack } | null {
    if (this.port.role() !== 'host' || showsPicture(this.state(id))) return null;
    const g = this.port.guests().find((x) => x.id === id);
    return this.cards.get(id, g?.name ?? 'Guest', this.port.tvOf(id));
  }

  // ---------------------------------------------------------------- host: deciding
  private nameOf(id: string) { return this.port.guests().find((x) => x.id === id)?.name ?? 'Guest'; }
  private apply(c: ModChange | null, ids: string[]): ModChange | null {
    if (!c) return null;
    this.save();
    // the card tracks follow the book (stopped when a guest is back on)
    this.cards.keep(new Set(this.port.guests().filter((g) => this.camOff(g.id)).map((g) => g.id)));
    for (const id of ids) this.tell(id);
    this.port.changed(ids);
    this.port.notify();
    return c;
  }
  set(id: string, patch: Partial<ModState>, kind: ModKind): ModChange | null {
    if (this.port.role() !== 'host') return null;
    const name = this.nameOf(id);
    const on = kind === 'cam' ? !!patch.cam : kind === 'mic' ? !!patch.mic : true;
    return this.apply(this.book.set(this.keyOf(id), name, patch, kind, modLabel(kind, [name], on)), [id]);
  }
  setCam(id: string, hidden: boolean) { return this.set(id, { cam: hidden }, 'cam'); }
  setMic(id: string, muted: boolean) { return this.set(id, { mic: muted }, 'mic'); }
  setVol(id: string, v: number) { return this.set(id, { vol: v }, 'vol'); }
  /** The panic button for one guest: camera AND mic, in one Undo step. */
  cut(id: string) { return this.set(id, { cam: true, mic: true }, 'cut'); }
  restore(id: string) { return this.set(id, { cam: false, mic: false }, 'restore'); }
  isCut(id: string) { return isCut(this.state(id)); }
  /** Everyone at once (the emergency button) / everyone back. */
  cutAll(back = false): ModChange | null {
    if (this.port.role() !== 'host') return null;
    const gs = this.port.guests();
    const list = gs.map((g) => ({ key: stableKey({ id: g.id, uid: g.uid ?? null }), name: g.name }));
    const kind: ModKind = back ? 'allback' : 'all';
    return this.apply(this.book.setMany(list, back ? { cam: false, mic: false } : { cam: true, mic: true }, kind, modLabel(kind, list.map((x) => x.name), !back)), gs.map((g) => g.id));
  }
  undo(): ModChange | null {
    if (this.port.role() !== 'host') return null;
    const c = this.book.undo();
    if (!c) return null;
    const keys = new Set(c.keys);
    const ids = this.port.guests().filter((g) => keys.has(stableKey({ id: g.id, uid: g.uid ?? null }))).map((g) => g.id);
    this.apply(c, ids);
    return c;
  }
  setHold(on: boolean) { this.hold = on; try { localStorage.setItem(HOLD_KEY, on ? '1' : '0'); } catch { /* storage off */ } this.port.notify(); }

  /** A guest connected / reconnected (their hello): tell them where they stand (a cut guest comes back cut). */
  admitted(id: string) { if (this.port.role() === 'host') queueMicrotask(() => { if (this.untold.has(id) || this.book.entry(this.keyOf(id))) this.tell(id); }); }
  /** Removed by the host for good. */
  forget(id: string) { if (this.port.role() !== 'host') return; this.book.forget(this.keyOf(id)); this.untold.delete(id); this.save(); this.cards.keep(new Set(this.port.guests().filter((g) => g.id !== id && this.camOff(g.id)).map((g) => g.id))); }
  /** Tell guest `id` their state: the ctl channel (if their app / page understands it) AND the relay (backup). */
  private tell(id: string) {
    const s = this.state(id), m = { cam: s.cam, mic: s.mic };
    const sent = this.port.send(id, { t: 'mod', ...m });
    this.port.relay(id, m);
    if (sent) this.untold.delete(id); else this.untold.add(id);
  }
  /** Re-send to guests whose link wasn't open when it changed (called from the party's 5 s heartbeat). */
  retell() { if (this.port.role() !== 'host') return; for (const id of [...this.untold]) if (this.port.guests().some((g) => g.id === id)) this.tell(id); else this.untold.delete(id); }

  // ---------------------------------------------------------------- guest (VTube Pro app): the host's decision about me
  onCtl(raw: unknown, host = 'The host') {
    const m = readModToGuest(raw);
    if (!m || this.port.role() !== 'guest') return;
    if (m.cam === this.me.cam && m.mic === this.me.mic) return;
    const text = modNotice(this.me, m, host);
    this.me = { cam: m.cam, mic: m.mic, at: Date.now(), notice: text };
    this.onMine?.(text, m);
    this.port.notify();
  }

  /** The Live panel's view (host). */
  view(id: string): { cam: boolean; mic: boolean; vol: number; at: number } | undefined {
    if (this.port.role() !== 'host') return undefined;
    const e = this.book.entry(this.keyOf(id));
    return e ? { cam: e.cam, mic: e.mic, vol: e.vol, at: e.at } : undefined;
  }
  get lastChange(): ModChange | null { return this.book.last; }

  reset() {
    this.book.reset(); this.cards.reset(); this.untold.clear(); this.restoredFor = '';
    this.me = { cam: false, mic: false, at: 0, notice: '' };
    try { sessionStorage.removeItem(SAVE_KEY); } catch { /* storage off */ }
  }
  private restoredFor = '';
  /** A studio reload that resumes the same hosted room keeps who is cut. */
  resume(): void {
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
}
export { MOD_CAP };
