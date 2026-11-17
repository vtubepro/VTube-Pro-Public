// Live panel tabs (live-tabs): the Live area is ONE row of labelled tabs, each with an icon and a one-line "what this
// is for". Pure data + routing, shared by the panel (src/ui/live/liveControl.ts), Ctrl+K (src/ui/live/liveStudio.ts)
// and tools/live_tabs_unit.ts. Owner: "Live needs to have tabs so you can set your transitions, hide your screen, and
// all that" — and every tab must be obvious to someone who has never streamed before.

export type LiveTabId = 'show' | 'cameras' | 'transitions' | 'privacy' | 'guests' | 'audio' | 'chat' | 'me' | 'obs' | 'golive';

export interface LiveTabDef {
  id: LiveTabId;
  /** Tab label (short, plain words). */
  label: string;
  /** Icon name from src/ui/icons.ts. */
  icon: string;
  /** One line under the tab bar: what this tab is for. */
  hint: string;
  /** Extra words Ctrl+K matches ("hide my screen" → Privacy). */
  words: string[];
}

/** The Live panel's 9 tabs, in the order and with the exact labels + hints the panel renders (src/ui/live/liveControl.ts
 *  PANES; tools/live_tabs_unit.ts checks the two match). The Rooms tab's id is 'show' (it opens with the Show tile). */
export const LIVE_TABS: LiveTabDef[] = [
  { id: 'show', label: 'Rooms', icon: 'room', hint: 'Switch rooms. A card covers the change.', words: ['room', 'rooms', 'scene', 'switch room', 'change room'] },
  { id: 'guests', label: 'Guests', icon: 'users', hint: 'Let people in, seat them, and control their camera and mic.', words: ['guest', 'guests', 'people', 'party', 'green room', 'co host', 'cohost', 'invite', 'moderation', 'kick'] },
  { id: 'chat', label: 'Chat & polls', icon: 'chat', hint: 'Read chat, thank supporters, run polls, hide chat.', words: ['chat', 'alerts', 'poll', 'polls', 'donation', 'thank', 'read aloud'] },
  { id: 'me', label: 'Me', icon: 'me', hint: 'Your outfit, emotes and face tracking.', words: ['me', 'outfit', 'costume', 'emote', 'emotes', 'tracking', 'recalibrate', 'avatar'] },
  { id: 'privacy', label: 'Privacy', icon: 'shield', hint: 'Hide your screen, BRB, hide chat or guests. One click each way.', words: ['privacy', 'hide', 'hide screen', 'hide my screen', 'cover', 'private', 'brb card', 'hide chat'] },
  { id: 'transitions', label: 'Transitions', icon: 'transition', hint: 'How the picture changes when you switch rooms or cameras.', words: ['transition', 'transitions', 'fade', 'wipe', 'cut', 'glide', 'curtain'] },
  { id: 'audio', label: 'Audio', icon: 'speak', hint: 'What you and your guests hear, and your mic level.', words: ['audio', 'sound', 'voice', 'mic', 'microphone', 'hear', 'volume'] },
  { id: 'obs', label: 'OBS', icon: 'stream', hint: 'Check that OBS can see VTube Pro, and switch OBS scenes.', words: ['obs', 'stream', 'streaming', 'browser source', 'automation', 'obs scene'] },
  // VTube Pro Live (docs/BROADCAST_PROTOCOL.md): the Go Live tab, src/ui/broadcast/
  { id: 'golive', label: 'Go Live', icon: 'live', hint: 'Check your setup, go live, end the show, record, and save a clip.', words: ['go live', 'golive', 'live', 'end show', 'twitch', 'youtube', 'kick', 'tiktok', 'broadcast', 'record', 'recording', 'clip', 'replay', 'stream key', 'check my setup', 'start streaming', 'destination'] },
];
/** The two tiles that are always on screen above the tabs (not tabs): Ctrl+K points at them by their own titles. */
export const LIVE_TILES: LiveTabDef[] = [
  { id: 'show', label: 'Show', icon: 'sun', hint: 'What you’re doing (Talk, React, Gaming, Interview) and your lighting.', words: ['show', 'look', 'lights', 'lighting', 'starting soon', 'go live', 'end show', 'mode', 'preshow', 'outro'] },
  { id: 'cameras', label: 'Camera', icon: 'camera', hint: 'Choose what the camera shows. Auto picks the shot for you.', words: ['camera', 'cameras', 'shot', 'shots', 'director', 'close up', 'wide'] },
];
export const LIVE_TAB_IDS = LIVE_TABS.map((t) => t.id);
export const DEFAULT_LIVE_TAB: LiveTabId = 'show';
export const tabDef = (id: LiveTabId): LiveTabDef => LIVE_TABS.find((t) => t.id === id) ?? LIVE_TILES.find((t) => t.id === id) ?? LIVE_TABS[0];

/** The old console's tile / tab ids (localStorage vtp.live.tab, show presets) → the tab that now holds them. */
const LEGACY: Record<string, LiveTabId> = { scene: 'show', rooms: 'show', camera: 'cameras', cameras: 'cameras', guests: 'guests', people: 'guests', chat: 'chat', me: 'me', health: 'obs' };

/** A remembered / typed tab id (any junk) → a real tab. */
export function sanitizeTab(v: unknown): LiveTabId {
  if (typeof v !== 'string') return DEFAULT_LIVE_TAB;
  const s = v.trim().toLowerCase();
  if ((LIVE_TAB_IDS as string[]).includes(s)) return s as LiveTabId;
  return LEGACY[s] ?? DEFAULT_LIVE_TAB;
}

/** Which tab holds the button for a Stream Deck registry action (shared/deck.ts DECK_ACTIONS). Ctrl+K "show me where"
 *  and the tests use it; null = not a Live-panel action (deck pages, custom commands). */
export function tabForAction(action: string, params?: Record<string, unknown>): LiveTabId | null {
  void params;
  switch (action) {
    case 'lighting': case 'mode': case 'room': case 'area': case 'video': case 'weather': case 'hour': case 'raid': case 'warzone': case 'calm': case 'club': case 'lounge': return 'show';
    case 'camera': case 'interview': case 'ambcam': return 'cameras';
    case 'curtain': case 'transition': case 'camera-move': return 'transitions';
    case 'cover': case 'chat-hide': return 'privacy';
    case 'guest-voice': case 'video-audio': case 'greenroom-output': return 'audio';
    case 'presence': case 'entrances': case 'guest-place': case 'interview-role': case 'knock-approve': case 'knock-deny': case 'guest-kick':
    case 'guest-mute': case 'guest-cam': case 'guest-volume': case 'guest-cut': case 'guests-cut-all': case 'guest-undo': case 'guest-cut-hold':
    case 'party-end': case 'guest-link': case 'greenroom-on': case 'greenroom-back': case 'greenroom-next': case 'greenroom-msg': case 'greenroom-talk': case 'greenroom-mode':
      return 'guests';
    case 'hub-tts': case 'hub-ack-next': case 'hub-thank-next': case 'hub-ack-all': case 'hub-skip': case 'hub-replay': case 'poll-start': case 'poll-end': case 'poll-show': return 'chat';
    case 'costume': case 'accessory': case 'recalibrate': case 'trackloss': case 'emote': case 'expression': case 'slap': return 'me';
  }
  return null;
}

/** Ctrl+K: the tabs / tiles a typed line points at ("transitions", "hide my screen", "obs", "lighting"), best first, at
 *  most 3. Each hit carries the label the panel shows, so the search says "Live → Chat & polls", never an old name. */
export function liveHitsForQuery(q: string): LiveTabDef[] {
  const s = q.toLowerCase().replace(/[^a-z0-9& ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length < 2) return [];
  const score = (t: LiveTabDef) => {
    let best = 0;
    const l = t.label.toLowerCase();
    if (s === l || s === t.id) best = 100;
    else if (l.startsWith(s) || t.id.startsWith(s)) best = 80;
    for (const w of t.words) if (s === w) best = Math.max(best, 90); else if (s.includes(w) && w.length > 3) best = Math.max(best, 40 + w.length); else if (w.startsWith(s) && s.length > 2) best = Math.max(best, 50);
    return best;
  };
  return [...LIVE_TABS, ...LIVE_TILES].map((t) => [t, score(t)] as const).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
}
/** Ctrl+K: the tab ids a typed line points at (deduped: the Rooms tab and the Show tile share 'show'). */
export function tabsForQuery(q: string): LiveTabId[] {
  return [...new Set(liveHitsForQuery(q).map((t) => t.id))];
}

// ---------------------------------------------------------------- transitions (Transitions tab presets)
/** Room-change card speed presets (SceneCurtainState.dur, seconds of the cover-in). */
export const CURTAIN_SPEEDS: { label: string; dur: number }[] = [
  { label: 'Quick', dur: 0.35 }, { label: 'Normal', dur: 0.6 }, { label: 'Slow', dur: 1 }, { label: 'Very slow', dur: 1.6 },
];
/** Camera changes (SceneState.transition, seconds; 0 = a hard cut). */
export const CAMERA_MOVES: { label: string; secs: number; hint: string }[] = [
  { label: 'Cut', secs: 0, hint: 'Jumps straight to the new shot, like a TV cut.' },
  { label: 'Quick glide', secs: 0.6, hint: 'The camera moves to the new shot in about half a second.' },
  { label: 'Smooth glide', secs: 1.2, hint: 'A calm camera move (the default).' },
  { label: 'Slow glide', secs: 2.5, hint: 'A slow, cinematic move.' },
];
/** The preset closest to a value (its index), for lighting up the right button. */
export function nearestPreset(list: { v: number }[], v: number): number {
  let bi = 0, bd = Infinity;
  list.forEach((x, i) => { const d = Math.abs(x.v - v); if (d < bd) { bd = d; bi = i; } });
  return bd <= 0.051 ? bi : -1;
}
