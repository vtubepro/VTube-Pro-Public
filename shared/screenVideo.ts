// Screen video (docs/SCENES.md → "Screen video"): the room's big SCREEN (or the solo side screen when the room has none)
// plays a video file IN the scene — a starting-soon loop in PRESHOW, a BRB loop, an outro, or ambience during Talk.
// Host-owned like the rest of SceneState: the host studio drives the playlist clock (src/scene/screenVideoHost.ts),
// every OBS page plays the same file at the host's position (src/scene/screenVideo.ts).

/** Which moment a playlist belongs to. 'ambience' = Talk in SHOW / REACT lighting (pauses for React / Interview / Gaming /
 *  TTRPG … — any mode but Talk — and resumes where it was). */
export type VideoSlotId = 'preshow' | 'ambience' | 'brb' | 'outro';
export const VIDEO_SLOTS: VideoSlotId[] = ['preshow', 'ambience', 'brb', 'outro'];
export const VIDEO_SLOT_LABEL: Record<VideoSlotId, string> = { preshow: 'Preshow', ambience: 'Ambience (Talk)', brb: 'BRB', outro: 'Outro' };

export interface VideoPlaylist {
  /** Sources: 'lib:<file name>' = a file in this PC's videos/ folder (GET /api/videos/file/<name>), or an http(s) URL. */
  list: string[];
  /** Loop the playlist (a one-item list loops that video). Off = the screen goes away after the last one. */
  loop: boolean;
  shuffle: boolean;
  /** 'keep' = the room's camera as usual; 'screen' = frame the screen (the React shot) while this plays. */
  cam: 'keep' | 'screen';
}

/** The host's playback clock: every page shows `list[i]` at (now − at) seconds. */
export interface VideoNow {
  slot: VideoSlotId;
  i: number;
  src: string;
  /** Epoch ms (receiving page's clock: guests shift it) when position 0 of this item plays. */
  at: number;
  /** Paused at `pos` seconds (ambience while another mode is on): the screen goes away. */
  paused?: boolean;
  pos?: number;
  /** A non-looping playlist ran out: the screen goes away until the moment changes. */
  end?: boolean;
  /** The item's length in seconds as the host measured it (0 = unknown). */
  dur?: number;
}

export interface SceneVideoState {
  /** Master switch (Scene tab → Screen video). */
  on: boolean;
  slots: Partial<Record<VideoSlotId, VideoPlaylist>>;
  /** Sound on the OBS page (off by default). */
  audio: boolean;
  /** 0..1 */
  volume: number;
  /** Manual: play this playlist now whatever the lighting state (Stream Deck "play <slot>"); null = follow the moment. */
  force: VideoSlotId | null;
  /** Manual stop (Stream Deck "stop"): nothing plays until "play" or the next lighting-state change. */
  stopped: boolean;
  now: VideoNow | null;
  /** Where each playlist was left (ambience resumes there). */
  resume?: Partial<Record<VideoSlotId, { i: number; pos: number }>>;
}

export const DEFAULT_PLAYLIST: VideoPlaylist = { list: [], loop: true, shuffle: false, cam: 'keep' };
export const DEFAULT_VIDEO_STATE: SceneVideoState = { on: false, slots: {}, audio: false, volume: 0.8, force: null, stopped: false, now: null };

const SLOT = new Set<string>(VIDEO_SLOTS);
export const isVideoSlot = (v: unknown): v is VideoSlotId => typeof v === 'string' && SLOT.has(v);
/** 'lib:<name>' (letters, digits, space, . _ - ( ) ), an http(s) URL, or a LIVE source (isLiveSrc). */
export const isVideoSrc = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 1000 && (/^lib:[\w .()-]{1,120}\.(mp4|webm|m4v|mov|ogv)$/i.test(v) || /^https?:\/\/[^\s"'<>]+$/i.test(v) || isLiveSrc(v));

// ---- live sources (no fixed length: every page plays the live edge; the playlist stays on them until "next")
//   live:<http(s) URL>   a live stream: HLS (.m3u8, played with hls.js where the browser has no native HLS) or a direct
//                        MP4 / WebM / Icecast-style URL. CORS-blocked streams go through GET /api/videos/proxy.
//   cam:<device label>   a camera on THIS PC by (part of) its label — 'cam:OBS Virtual Camera' = OBS's virtual cam
//                        (so any OBS scene — Starting Soon, BRB — can be shown on the room screen). Party guests can't
//                        see the host's cameras: their screen shows a card saying so.
//   feed:window          the fast window feed (server/screenFeed.ts): whatever window the Scene tab's capture window is
//                        (e.g. an OBS windowed projector of your Starting Soon scene).
export const LIVE_SRC = /^(live:https?:\/\/[^\s"'<>]+|cam:[^\x00-\x1f"<>]{1,80}|feed:window)$/i;
export const isLiveSrc = (v: unknown): v is string => typeof v === 'string' && v.length <= 1000 && LIVE_SRC.test(v);
export const OBS_VCAM = 'cam:OBS Virtual Camera';
/** Channel pages (twitch.tv/x, youtube.com/…, kick.com/x) aren't video files: they need the OBS route (see the Scene tab). */
export const isChannelUrl = (u: string) => /^https?:\/\/(www\.|m\.)?(twitch\.tv|youtube\.com|youtu\.be|kick\.com)\//i.test(u.replace(/^live:/, ''));
export const isHlsUrl = (u: string) => /\.m3u8(\?|#|$)/i.test(u);
export const VIDEO_FILE = /^[\w .()-]{1,120}\.(mp4|webm|m4v|mov|ogv)$/i;

/** The URL a page loads for a source. */
export const videoUrl = (src: string) => (src.startsWith('lib:') ? `/api/videos/file/${encodeURIComponent(src.slice(4))}` : src.startsWith('live:') ? src.slice(5) : src);
export const videoName = (src: string) => (src.startsWith('lib:') ? src.slice(4) : src.startsWith('cam:') ? `📷 ${src.slice(4)}` : src === 'feed:window' ? '🪟 Window feed'
  : src.startsWith('live:') ? `🔴 ${src.slice(5).replace(/^https?:\/\//, '').slice(0, 56)}` : src.replace(/^https?:\/\//, '').slice(0, 60));

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function sanitizeVideoState(o: unknown): SceneVideoState {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const slots: SceneVideoState['slots'] = {};
  const sl = (x.slots && typeof x.slots === 'object' ? x.slots : {}) as Record<string, unknown>;
  for (const id of VIDEO_SLOTS) {
    const p = sl[id] as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object') continue;
    slots[id] = {
      list: Array.isArray(p.list) ? p.list.filter(isVideoSrc).slice(0, 50) : [],
      loop: p.loop !== false, shuffle: p.shuffle === true, cam: p.cam === 'screen' ? 'screen' : 'keep',
    };
  }
  const n = x.now as Record<string, unknown> | null | undefined;
  const now: VideoNow | null = n && typeof n === 'object' && isVideoSlot(n.slot) && isVideoSrc(n.src) && typeof n.at === 'number' && Number.isFinite(n.at)
    ? { slot: n.slot, i: Math.round(num(n.i, 0, 49, 0)), src: n.src, at: n.at,
        ...(n.paused === true ? { paused: true, pos: num(n.pos, 0, 1e6, 0) } : {}), ...(n.end === true ? { end: true } : {}),
        ...(typeof n.dur === 'number' && n.dur > 0 ? { dur: num(n.dur, 0, 1e6, 0) } : {}) }
    : null;
  const resume: SceneVideoState['resume'] = {};
  const rs = (x.resume && typeof x.resume === 'object' ? x.resume : {}) as Record<string, unknown>;
  for (const id of VIDEO_SLOTS) { const r = rs[id] as Record<string, unknown> | undefined; if (r && typeof r === 'object') resume[id] = { i: Math.round(num(r.i, 0, 49, 0)), pos: num(r.pos, 0, 1e6, 0) }; }
  return {
    on: x.on === true, slots, audio: x.audio === true, volume: num(x.volume, 0, 1, 0.8),
    force: isVideoSlot(x.force) ? x.force : null, stopped: x.stopped === true, now,
    ...(Object.keys(resume).length ? { resume } : {}),
  };
}

/** The playlist the moment calls for (host side), or null. Lighting PRESHOW / BRB / OUTRO → that playlist; SHOW / REACT →
 *  ambience. A moment without a playlist plays nothing. */
export function wantedSlot(v: SceneVideoState | undefined, lighting: string | undefined): VideoSlotId | null {
  if (!v?.on || v.stopped) return null;
  const has = (s: VideoSlotId) => (v.slots[s]?.list.length ?? 0) > 0;
  if (v.force) return has(v.force) ? v.force : null;
  const ls = lighting ?? 'show';
  if (ls === 'preshow' || ls === 'brb' || ls === 'outro') return has(ls) ? ls : null;
  return has('ambience') ? 'ambience' : null;
}

/** Is the screen video showing right now on this page (screen free: Talk, no stage layout owning the frame)? */
export const videoShowing = (v: SceneVideoState | undefined) => !!v?.on && !!v.now && !v.now.paused && !v.now.end;
