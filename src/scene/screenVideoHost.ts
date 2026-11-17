// Screen video — the host side (docs/SCENES.md → "Screen video"). The host / solo studio owns the playlist clock:
// which playlist the moment calls for (lighting state PRESHOW / BRB / OUTRO, ambience in Talk), which item, and the epoch
// ms its position 0 plays (state.video.now). Every OBS page (and party guests' pages, clock-shifted) seeks its own copy
// of the file to that position. Ticks twice a second; it writes the scene state only when something changes (a new
// moment, the next item, a pause / resume), so a one-video loop costs nothing after it starts.
import type { SceneState } from '../../shared/types.ts';
import { DEFAULT_VIDEO_STATE, isLiveSrc, isVideoSlot, videoUrl, wantedSlot, type SceneVideoState, type VideoNow, type VideoSlotId } from '../../shared/screenVideo.ts';

/** The screen drops (~1.3 s) + powers on before position 0 plays. */
const LEAD = 1500;

export interface VideoHostCtl {
  readonly state: SceneState;
  /** May this studio drive the clock (host / solo, scene state loaded)? */
  readonly videoHost: boolean;
  setVideo(fn: (v: SceneVideoState) => void): void;
}

export class ScreenVideoHost {
  private durs = new Map<string, number>();          // src → seconds (-1 = can't be read)
  private probing = new Set<string>();
  private lastLs: string | undefined;
  private timer: number;

  constructor(private ctl: VideoHostCtl, private clock: () => number = () => Date.now()) {
    this.timer = window.setInterval(() => this.tick(), 500);
  }
  dispose() { window.clearInterval(this.timer); }

  /** Seconds of a source (null while measuring). */
  duration(src: string): number | null {
    const d = this.durs.get(src);
    if (d !== undefined) return d;
    if (!this.probing.has(src) && typeof document !== 'undefined') {
      this.probing.add(src);
      const v = document.createElement('video');
      v.preload = 'metadata'; v.muted = true; v.crossOrigin = 'anonymous';
      const done = (x: number) => { if (!this.probing.has(src)) return; this.probing.delete(src); this.durs.set(src, x); v.removeAttribute('src'); v.load(); };
      v.addEventListener('loadedmetadata', () => done(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : -1));
      v.addEventListener('error', () => done(-1));
      window.setTimeout(() => done(-1), 15000);
      v.src = videoUrl(src);
    }
    return null;
  }
  /** Forget measured lengths (the videos folder changed). */
  forget() { this.durs.clear(); }

  /** Manual controls (Scene tab, Stream Deck, bus command). */
  control(a: { action?: string; slot?: string; audio?: boolean | 'toggle'; volume?: number; on?: boolean }) {
    this.ctl.setVideo((v) => {
      if (typeof a.on === 'boolean') v.on = a.on;
      if (a.audio === 'toggle') v.audio = !v.audio; else if (typeof a.audio === 'boolean') v.audio = a.audio;
      if (typeof a.volume === 'number' && Number.isFinite(a.volume)) v.volume = Math.min(1, Math.max(0, a.volume > 1 ? a.volume / 100 : a.volume));
      const showing = !!v.now && !v.now.end && !v.stopped;
      const act = a.action === 'toggle' ? (showing ? 'stop' : 'play') : a.action;
      if (act === 'play') { v.on = true; v.stopped = false; v.force = isVideoSlot(a.slot) ? a.slot : null; if (v.now?.end) v.now = null; }
      else if (act === 'stop') { v.stopped = true; v.force = null; }
      else if (act === 'next' && v.now && !v.now.paused) { const n = this.next(v, v.now, this.clock(), true); v.now = n; }
      else if (act === 'restart' && v.now) v.now = { ...v.now, at: this.clock() + 300, paused: undefined, pos: undefined, end: undefined };
    });
  }

  tick() {
    const c = this.ctl;
    if (!c.videoHost) return;
    const s = c.state, v = s.video;
    const ls = s.lights.state ?? 'show';
    const lsChanged = this.lastLs !== undefined && ls !== this.lastLs;
    this.lastLs = ls;
    if (!v) return;
    const t = this.clock();
    // a manual stop / forced playlist lasts until the next lighting-state change
    if (lsChanged && (v.stopped || v.force)) { c.setVideo((x) => { x.stopped = false; x.force = null; }); return; }
    const want = wantedSlot(v, ls);
    const cur = v.now;
    if (!want) {
      if (cur) c.setVideo((x) => { this.remember(x, t); x.now = null; });
      return;
    }
    const pl = v.slots[want]!;
    const holdAmb = want === 'ambience' && s.mode !== 'talk';          // React / Interview / Gaming / TTRPG … → pause
    if (!cur || cur.slot !== want) {
      c.setVideo((x) => {
        this.remember(x, t);
        const r = want === 'ambience' ? x.resume?.[want] : undefined;
        const i = r && r.i < pl.list.length ? r.i : pl.shuffle ? Math.floor(Math.random() * pl.list.length) : 0;
        const pos = r && r.i < pl.list.length ? r.pos : 0;
        x.now = holdAmb ? { slot: want, i, src: pl.list[i], at: t, paused: true, pos } : { slot: want, i, src: pl.list[i], at: t + LEAD - pos * 1000 };
      });
      return;
    }
    if (cur.end) return;
    if (holdAmb && !cur.paused) { c.setVideo((x) => { x.now = { ...cur, paused: true, pos: Math.max(0, (t - cur.at) / 1000) }; }); return; }
    if (!holdAmb && cur.paused) { c.setVideo((x) => { x.now = { ...cur, paused: undefined, pos: undefined, at: t + LEAD - (cur.pos ?? 0) * 1000 }; }); return; }
    if (cur.paused) return;
    // the playlist was edited under it: keep the index when that item is still there, else the nearest one
    if (pl.list[cur.i] !== cur.src) {
      const j = pl.list.indexOf(cur.src);
      c.setVideo((x) => { x.now = j >= 0 ? { ...cur, i: j } : { slot: want, i: Math.min(cur.i, pl.list.length - 1), src: pl.list[Math.min(cur.i, pl.list.length - 1)], at: t + 300 }; });
      return;
    }
    if (pl.list.length <= 1 && pl.loop) return;                         // one looping video: every page loops it by itself
    if (isLiveSrc(cur.src)) return;                                     // a live source has no end: it stays until "next"
    const d = this.duration(cur.src);
    if (d === null) return;
    if (d > 0 && cur.dur !== +d.toFixed(3)) { c.setVideo((x) => { if (x.now) x.now.dur = +d.toFixed(3); }); return; }
    const len = d > 0 ? d : 2;                                          // unreadable: skip it after 2 s
    if ((t - cur.at) / 1000 >= len) c.setVideo((x) => { x.now = this.next(x, cur, t, false); });
  }

  /** The item after `cur` (loop / shuffle / end); `now` = skip right away. */
  private next(v: SceneVideoState, cur: VideoNow, t: number, now: boolean): VideoNow {
    const pl = v.slots[cur.slot];
    if (!pl || !pl.list.length) return { ...cur, end: true };
    let i = cur.i + 1;
    if (pl.shuffle && pl.list.length > 1) { do i = Math.floor(Math.random() * pl.list.length); while (i === cur.i); }
    else if (i >= pl.list.length) { if (!pl.loop && !now) return { ...cur, end: true }; i = 0; }
    const d = this.durs.get(cur.src) ?? 0;
    const at = now || d <= 0 ? t + 200 : Math.max(cur.at + d * 1000, t - 1500);   // seamless when on time
    return { slot: cur.slot, i, src: pl.list[i], at };
  }

  /** Remember where the current playlist was (ambience resumes there). */
  private remember(v: SceneVideoState, t: number) {
    const cur = v.now;
    if (!cur || cur.end) return;
    const pos = cur.paused ? cur.pos ?? 0 : Math.max(0, (t - cur.at) / 1000);
    const d = this.durs.get(cur.src) ?? cur.dur ?? 0;
    v.resume = { ...(v.resume ?? {}), [cur.slot]: { i: cur.i, pos: d > 0 ? pos % d : pos } };
  }
}

/** A fresh video state (Scene tab edits start from it). */
export const videoStateOf = (s: SceneState): SceneVideoState => structuredClone(s.video ?? DEFAULT_VIDEO_STATE);
export type { VideoSlotId };
