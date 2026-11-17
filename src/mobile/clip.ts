// "Record a clip": the stage (your avatar, its background) plus your microphone as a video file on the phone, for
// TikTok / Shorts / Reels. MP4 where the browser records it (Safari 14.5+, Chrome 126+), else WebM. Never plays sound.
//   * the recording goes to the browser's file store as it is made (one part a second: src/mobile/webStore.ts), not
//     into memory. Every take has its OWN folder (vtp-web/clips/<take>/: parts/00000 …, then clip.<ext>), and every
//     removal names its take: nothing one take does can touch another
//   * stop() copies the parts into ONE complete file, clip.<ext>, streamed part by part (the store writes a Blob made
//     of the stored parts: never a whole copy in memory), checks its size, removes the parts, and hands back that file
//     (an OPFS file: the bytes stay on disk until saved). A take is removed when it has been saved: after the share
//     sheet took it (share() resolved), or for a download when you tap "Saved". A downloaded clip, or one never saved
//     when show mode closes, is marked waiting (pending.json): the next show offers it ("Save again / Delete"), and
//     it is removed PENDING_MAX_MS after it was marked; any other take TAKE_STALE_MS after it began (the sweeps run
//     at a new take and at a show start; never on a take whose save is in flight). At most one waiting clip + the take
//     being recorded are kept: over that, show mode asks before recording. On the IndexedDB fallback a read part is in
//     memory: that is why a phone's clip is capped shorter (CLIP_MAX_S_PHONE, about 60 MB)
//   * at most CLIP_MAX_S long (it stops by itself and says so); show mode stops and keeps it when the page is hidden
//   * a 2D avatar shown "Flat over the stream" is a separate picture on the page (src/avatar/flat/overlay.ts): it is
//     drawn into the recording too (a composite canvas), so the clip shows what the screen shows

/** The longest clip (seconds): a desktop, and a phone (its memory and storage are smaller). */
export const CLIP_MAX_S = 180;
export const CLIP_MAX_S_PHONE = 120;
/** The cap of a take this browser keeps in memory while recording (its recorder hands out no data until stop). */
export const HELD_MAX_S = 60;
/** The cap for this page (src/mobile/device.ts isPhone). */
export const clipMaxS = (phone: boolean) => (phone ? CLIP_MAX_S_PHONE : CLIP_MAX_S);

/** The recording format: MP4 first (what TikTok / Shorts / Reels take everywhere), WebM when MP4 can't be recorded. */
export function pickClipFormat(supported: (t: string) => boolean): { mime: string; ext: 'mp4' | 'webm' } | null {
  for (const t of ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4']) if (supported(t)) return { mime: t, ext: 'mp4' };
  for (const t of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) if (supported(t)) return { mime: t, ext: 'webm' };
  return null;
}

/** State the tests read (window.__vtpClip). */
export const clipState = { recording: false, bytes: 0, parts: 0, inMemory: 0, mime: '', ms: 0, audio: false, composite: false, stoppedBy: '', discarded: 0, cleaned: 0, singleFile: false, held: false };

/** Where the parts go (src/mobile/webStore.ts in the studio; tests may pass their own). */
export interface ClipSink { write(path: string[], data: Blob): Promise<void>; read(path: string[]): Promise<Blob | null>; remove(path: string[]): Promise<void>; list(path: string[]): Promise<{ name: string; kind: string }[]> }

/** A take with nothing waiting for it is removed this long after it began (a new take / a show start sweeps). */
export const TAKE_STALE_MS = 10 * 60_000;
/** A clip waiting for you to confirm it was saved ("pending.json" in its folder: downloaded, or never saved) is
 *  offered again at the next show ("Save again / Delete") and removed this long after it was marked. */
export const PENDING_MAX_MS = 24 * 60 * 60_000;
/** Takes whose save is in flight right now (a share sheet open): never removed by a sweep. */
const keep = new Set<string>();
/** A clip waiting for a "Saved" confirmation (its pending.json). */
export interface PendingClip { take: string; at: number; file: File }
/** Now, for the sweeps (tests: localStorage vtp.test.clipClockMs moves the clock forward). */
export function clipNow(): number { let o = 0; try { o = Number(localStorage.getItem('vtp.test.clipClockMs')) || 0; } catch { /* storage off */ } return Date.now() + o; }
const newTake = () => `t${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const takeAge = (id: string, now: number) => { const m = /^t(\d+)-/.exec(id); return m ? now - Number(m[1]) : Infinity; };
/** The finished clip: its File (on disk) and the take it belongs to. */
export interface Clip { file: File; take: string }
const DIR = ['vtp-web', 'clips'];

/** The overlay pictures to draw on top of the stage (flat avatars "over the stream"), with their box on the page. */
function overlays(): { cv: HTMLCanvasElement; r: DOMRect; flip: boolean }[] {
  return [...document.querySelectorAll<HTMLCanvasElement>('.vtp-flat-overlay canvas')].filter((c) => c.offsetParent).map((cv) => {
    const el = cv.parentElement!, m = new DOMMatrix(getComputedStyle(el).transform === 'none' ? undefined : getComputedStyle(el).transform);
    return { cv, r: el.getBoundingClientRect(), flip: m.a < 0 };
  });
}

export class ClipRecorder {
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private t0 = 0;
  private fmt: { mime: string; ext: 'mp4' | 'webm' } | null = null;
  private take = '';
  private n = 0;
  private mem: Blob[] = [];
  private memMode = false;
  private writes: Promise<void> = Promise.resolve();
  private comp: { cv: HTMLCanvasElement; raf: number } | null = null;
  private capTimer = 0;
  private heldTimer = 0;
  /** called when this browser keeps the recording in memory (the take is then capped at `max` seconds) */
  onHeld: ((max: number) => void) | null = null;
  /** called when the clip stops by itself (the length cap) */
  onAutoStop: ((why: 'cap') => void) | null = null;
  constructor(private sink: ClipSink | null, private maxS = CLIP_MAX_S) {}
  get capSeconds() { return this.maxS; }
  /** Start recording `stage` (+ overlay pictures, + a copy of `mic`'s audio). Throws one plain sentence. */
  async start(stage: HTMLCanvasElement, mic: MediaStream | null, fps = 30) {
    if (this.rec) return;
    const MR = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
    this.fmt = MR ? pickClipFormat((t) => { try { return MR.isTypeSupported(t); } catch { return false; } }) : null;
    if (!MR || !this.fmt || typeof stage.captureStream !== 'function') throw new Error('This browser can’t record video. Use your phone’s own screen recording instead.');
    // takes left behind (older than TAKE_STALE_MS and not waiting for a save): only those are removed
    await this.cleanup(clipNow()).catch(() => {});
    let src = stage;
    if (overlays().length) {
      // the stage + the overlay pictures, drawn together every frame
      const cv = document.createElement('canvas'); cv.width = stage.width; cv.height = stage.height;
      const g = cv.getContext('2d')!;
      const draw = () => {
        g.clearRect(0, 0, cv.width, cv.height);
        g.drawImage(stage, 0, 0, cv.width, cv.height);
        const sr = stage.getBoundingClientRect(), kx = cv.width / Math.max(1, sr.width), ky = cv.height / Math.max(1, sr.height);
        for (const o of overlays()) {
          const x = (o.r.left - sr.left) * kx, y = (o.r.top - sr.top) * ky, w = o.r.width * kx, h = o.r.height * ky;
          if (o.flip) { g.save(); g.translate(x + w, y); g.scale(-1, 1); g.drawImage(o.cv, 0, 0, w, h); g.restore(); } else g.drawImage(o.cv, x, y, w, h);
        }
        if (this.comp) this.comp.raf = requestAnimationFrame(draw);
      };
      this.comp = { cv, raf: 0 };
      draw();
      src = cv;
    }
    const tracks = [...src.captureStream(fps).getVideoTracks()];
    for (const a of mic?.getAudioTracks() ?? []) if (a.readyState === 'live') tracks.push(a.clone());
    this.stream = new MediaStream(tracks);
    this.take = newTake(); this.n = 0; this.mem = []; this.memMode = false; this.writes = Promise.resolve();
    // A keyframe every second: Chrome's MP4 recorder only hands out data at a keyframe, and a canvas stream almost never
    // makes one by itself, so without this the whole take sat inside the recorder (in memory) until stop — measured: no
    // part at all in 5 s, the whole clip at stop; with it, one part a second (tools/mobile2d_e2e.mjs checks it per take)
    this.rec = new MR(this.stream, { mimeType: this.fmt.mime, videoBitsPerSecond: 4_000_000, videoKeyFrameIntervalDuration: 1000 } as MediaRecorderOptions);
    this.rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      clipState.bytes += e.data.size; clipState.parts++;
      if (this.sink) {
        const part = e.data, take = this.take;
        // stored as it arrives, in order; once the store fails (full), the rest stays in memory (order kept)
        this.writes = this.writes.then(async () => {
          if (!this.memMode) { try { await this.sink!.write([...DIR, take, 'parts', String(this.n).padStart(5, '0')], part); this.n++; return; } catch { this.memMode = true; } }
          this.mem.push(part); clipState.inMemory += part.size;
        });
      } else { this.mem.push(e.data); clipState.inMemory += e.data.size; }
    };
    this.t0 = performance.now();
    Object.assign(clipState, { recording: true, bytes: 0, parts: 0, inMemory: 0, mime: this.fmt.mime, ms: 0, audio: tracks.length > 1, composite: !!this.comp, stoppedBy: '', held: false });
    this.rec.start(1000);
    let cap = this.maxS;
    try { cap = Number(localStorage.getItem('vtp.test.clipMaxS')) || this.maxS; } catch { /* storage off */ }   // (tests)
    this.capTimer = window.setTimeout(() => { clipState.stoppedBy = 'cap'; this.onAutoStop?.('cap'); }, cap * 1000);
    // a browser whose recorder still keeps the take in memory (no video data handed out after 4 s): this take stops at
    // HELD_MAX_S instead, and the page is told (onHeld) so it can say so in one sentence
    const startBytes = () => clipState.bytes;
    window.clearTimeout(this.heldTimer);
    this.heldTimer = window.setTimeout(() => {
      if (!this.rec || startBytes() > 4096) return;
      clipState.held = true;
      window.clearTimeout(this.capTimer);
      const left = Math.max(1, HELD_MAX_S - this.seconds);
      this.capTimer = window.setTimeout(() => { clipState.stoppedBy = 'cap'; this.onAutoStop?.('cap'); }, left * 1000);
      this.onHeld?.(HELD_MAX_S);
    }, 4000);
  }
  get recording() { return !!this.rec; }
  get seconds() { return this.rec ? (performance.now() - this.t0) / 1000 : 0; }
  /** Stop: the clip (null when nothing was recorded). Its folder stays until discard(take), or a sweep (cleanup). */
  async stop(name = 'my-clip'): Promise<Clip | null> {
    const rec = this.rec, take = this.take;
    if (!rec) return null;
    window.clearTimeout(this.capTimer); window.clearTimeout(this.heldTimer);
    await new Promise<void>((res) => { rec.onstop = () => res(); try { rec.requestData(); } catch { /* fine */ } rec.stop(); });
    this.rec = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    if (this.comp) { cancelAnimationFrame(this.comp.raf); this.comp.cv.width = this.comp.cv.height = 0; this.comp = null; }
    await this.writes;
    clipState.recording = false; clipState.ms = Math.round(performance.now() - this.t0);
    const type = this.fmt!.mime.split(';')[0], ext = this.fmt!.ext;
    const parts: Blob[] = [];
    if (this.sink) for (let i = 0; i < this.n; i++) { const b = await this.sink.read([...DIR, take, 'parts', String(i).padStart(5, '0')]); if (b) parts.push(b); }
    parts.push(...this.mem); this.mem = [];
    const whole = new Blob(parts, { type });
    if (!whole.size) { await this.discard(take); return null; }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const fileName = `${name}-${stamp}.${ext}`;
    // one complete file on disk, written from the stored parts (streamed by the store), checked, then the parts go
    if (this.sink && this.n > 0) {
      try {
        const P = [...DIR, take, `clip.${ext}`];
        await this.sink.write(P, whole);
        const one = await this.sink.read(P);
        if (one && one.size === whole.size) {
          await this.sink.remove([...DIR, take, 'parts']).catch(() => {});
          clipState.singleFile = true;
          return { file: new File([one], fileName, { type }), take };
        }
      } catch { /* full: the parts themselves stay (below) */ }
    }
    clipState.singleFile = false;
    return { file: new File([whole], fileName, { type }), take };
  }
  /** The take was saved / given up: remove its folder (only that take's). */
  async discard(take: string) {
    keep.delete(take);
    if (!take || !this.sink) return;
    clipState.discarded++;
    await this.sink.remove([...DIR, take]).catch(() => {});
  }
  /** A save of this take is in flight (the share sheet is open): no sweep touches it until release(). */
  hold(take: string) { keep.add(take); }
  release(take: string) { keep.delete(take); }
  /** Mark a take as waiting for a "Saved" confirmation (a downloaded clip, or one never saved when show mode closes). */
  async markPending(c: Clip, now = clipNow()) {
    if (!this.sink || !c.take) return;
    await this.sink.write([...DIR, c.take, 'pending.json'], new Blob([JSON.stringify({ at: now, name: c.file.name, type: c.file.type })], { type: 'application/json' })).catch(() => {});
  }
  /** The clips waiting for a confirmation, newest first (their file read back from disk). */
  async pendingClips(): Promise<PendingClip[]> {
    if (!this.sink) return [];
    const out: PendingClip[] = [];
    for (const e of await this.sink.list(DIR)) {
      if (e.kind !== 'directory') continue;
      const j = await this.marker(e.name);
      if (!j) continue;
      const ext = /\.(mp4|webm)$/.exec(j.name)?.[1] ?? 'mp4';
      const f = await this.sink.read([...DIR, e.name, `clip.${ext}`]);
      if (f && f.size) out.push({ take: e.name, at: j.at, file: new File([f], j.name, { type: j.type || f.type }) });
    }
    return out.sort((a, b) => b.at - a.at);
  }
  /** Every take stored now (oldest first: take ids start with their time). */
  async takes(): Promise<string[]> {
    if (!this.sink) return [];
    return (await this.sink.list(DIR)).filter((e) => e.kind === 'directory').map((e) => e.name).sort();
  }
  private async marker(take: string): Promise<{ at: number; name: string; type: string } | null> {
    try { const b = await this.sink!.read([...DIR, take, 'pending.json']); if (!b) return null; const j = JSON.parse(await b.text()); return typeof j?.at === 'number' ? j : null; } catch { return null; }
  }
  /** The sweep (a new take, a show start): a take waiting for a confirmation goes PENDING_MAX_MS after it was marked,
   *  any other take TAKE_STALE_MS after it began; never a take whose save is in flight, never the current take. */
  async cleanup(now: number) {
    if (!this.sink) return;
    for (const e of await this.sink.list(DIR)) {
      if (e.kind !== 'directory' || keep.has(e.name) || (this.rec && e.name === this.take)) continue;
      const m = await this.marker(e.name);
      const old = m ? now - m.at > PENDING_MAX_MS : takeAge(e.name, now) > TAKE_STALE_MS;
      if (old) { await this.sink.remove([...DIR, e.name]).catch(() => {}); clipState.cleaned++; }
    }
  }
}
