// Show dock (beta.12 UX, owner: "easier to run the show and less diving through submenus"): the pure parts of the
// persistent show bar at the bottom of the studio (src/ui/showDock.ts). Every button is an existing Stream Deck action
// (shared/deck.ts DECK_ACTIONS, run through /ws/deck like Live Control and the mini-bar), so a dock button, a Live
// Control button and a physical deck key are the same action with the same lit state. Nothing here touches the DOM.
//   * DOCK_PLAN: every live action the dock offers and how many clicks it takes (1 = on the bar, 2 = in a menu);
//   * dockShots: the camera row (scene camera outside Interview, the Interview switcher inside it);
//   * dockEvents: the room's own moments (weather, background fight, warzone set pieces, club, lounge, slap), only
//     the ones the current room has;
//   * expressions: the face presets the dock offers + the 1-9 keys that already show them, and the alias table that
//     makes the deck's "happy / surprised / angry / sad / relaxed" names work (they used to show a NEUTRAL face);
//   * the dock's remembered state (collapsed or not), tolerant of junk.
import { ACTION_BY_ID, keyActive, lineupIndex, type DeckLiveState } from './deck.ts';

// ---------------------------------------------------------------- remembered state
export const DOCK_PREF_KEY = 'vtp.ui.dock';
export interface DockPrefs { /** Collapsed to the slim status strip. */ min: boolean }
export function parseDockPrefs(v: string | null | undefined): DockPrefs {
  try { const o = JSON.parse(v || 'null') as { min?: unknown } | null; return { min: !!o && typeof o === 'object' && o.min === true }; } catch { return { min: false }; }
}
export const dockPrefsText = (p: DockPrefs): string => JSON.stringify({ min: !!p.min });

// ---------------------------------------------------------------- one button
export interface DockKey {
  /** Unique within its row (focus survives a repaint by it). */
  k: string;
  label: string;
  action: string;
  params?: Record<string, string | number>;
  /** One plain line: what it does. */
  hint: string;
  /** The keyboard shortcut that already does the same, as shown to people ("Shift+2"). */
  key?: string;
  /** Icon name (src/ui/icons.ts). */
  ic?: string;
}

/** Lit right now? (the deck's own check; null = the action has no on / off state) */
export const dockLit = (k: Pick<DockKey, 'action' | 'params'>, live: DeckLiveState): boolean | null => keyActive({ action: k.action, params: k.params }, live);

// ---------------------------------------------------------------- the camera row
export interface DockMember { id: string; name: string }
/**
 * The camera buttons for the mode in use. Outside Interview: the scene camera (Auto = the mode's own shot, a close-up of
 * me, group, wide, the screen). Interview: the director (auto) and the switcher's main shots, guest 1 only when there is
 * a guest. Same actions and params as Live Control's Camera tile.
 */
export function dockShots(live: DeckLiveState): DockKey[] {
  if (live.mode === 'interview') {
    const guests = (live.guests ?? []).length;
    return [
      { k: 'iv-auto', label: 'Auto', action: 'interview', params: { shot: 'auto' }, hint: 'The auto director cuts between whoever talks', ic: 'auto' },
      { k: 'iv-host', label: 'Host', action: 'interview', params: { shot: 'host' }, hint: 'Cut to you (the director goes manual)', ic: 'host' },
      ...(guests && lineupIndex(live.guests ?? [], 'guest', 1) >= 0 ? [{ k: 'iv-g1', label: 'Guest 1', action: 'interview', params: { shot: 'guest1' }, hint: 'Cut to guest 1', ic: 'users' }] : []),
      { k: 'iv-two', label: 'Two-shot', action: 'interview', params: { shot: 'two' }, hint: 'You and your guest together', ic: 'two' },
      { k: 'iv-wide', label: 'Wide', action: 'interview', params: { shot: 'wide' }, hint: 'The whole set', ic: 'wide' },
    ];
  }
  return [
    { k: 'cam-auto', label: 'Auto', action: 'camera', params: { cam: 'auto' }, hint: 'The mode’s own camera', ic: 'auto' },
    { k: 'cam-me', label: 'Me', action: 'camera', params: { cam: 'talk', focus: 'me' }, hint: 'Close-up of you', ic: 'me' },
    { k: 'cam-group', label: 'Group', action: 'camera', params: { cam: 'group' }, hint: 'Everyone in the room, framed together', ic: 'two' },
    { k: 'cam-wide', label: 'Wide', action: 'camera', params: { cam: 'wide' }, hint: 'The whole room', ic: 'wide' },
    { k: 'cam-screen', label: 'Screen', action: 'camera', params: { cam: 'screen' }, hint: 'Centred on the screen with the video or your React window', ic: 'tv' },
  ];
}

// ---------------------------------------------------------------- the room's own moments
export interface DockEventGroup { id: string; label: string; keys: DockKey[] }
/** The SceneInfo keys that switch a group on (scene.json supplies them; the server passes them through). */
type RoomInfo = Record<string, unknown> | null | undefined;
const optionsOf = (action: string, key = 'event') => ACTION_BY_ID.get(action)?.params?.find((p) => p.key === key)?.options ?? [];

/**
 * What can happen in this room right now, grouped. Only groups the room supports: a lounge room gets its celebrations,
 * a warzone its set pieces, a room with weather its sky. Slap works in every room. Labels come from the deck registry.
 */
export function dockEvents(info: RoomInfo, live: DeckLiveState): DockEventGroup[] {
  if (!live.sceneId) return [];
  const has = (k: string) => !!info && info[k] !== undefined && info[k] !== null && info[k] !== false;
  const out: DockEventGroup[] = [];
  if (live.curtainWaiting) out.push({ id: 'curtain', label: 'Room change', keys: [{ k: 'curtain', label: 'Reveal the room', action: 'curtain', hint: 'The transition is waiting for you: show the new room now', key: 'Shift+Enter', ic: 'curtain' }] });
  if (has('environment')) {
    out.push({ id: 'weather', label: 'Weather', keys: (['clear', 'cloudy', 'rain', 'storm', 'fog'] as const).map((w) => ({ k: `wx-${w}`, label: w === 'rain' ? 'Rain' : w[0].toUpperCase() + w.slice(1), action: 'weather', params: { weather: w }, hint: `Weather: ${w}` })) });
  }
  if (has('warzone')) {
    out.push({ id: 'warzone', label: 'Set pieces', keys: [
      ...optionsOf('warzone').map((o) => ({ k: `wz-${o.value}`, label: o.label, action: 'warzone', params: { event: o.value }, hint: `Call in: ${o.label.toLowerCase()}` })),
      { k: 'calm', label: 'Calm', action: 'calm', hint: 'No new big moments while you talk (the far fighting goes on)' },
    ] });
  } else if (has('raid')) {
    out.push({ id: 'raid', label: 'Background fight', keys: [{ k: 'raid', label: 'Fight on / off', action: 'raid', hint: 'Background combat in the room' }] });
  }
  if (has('club')) {
    out.push({ id: 'club', label: 'Club', keys: ([['conga', 'Conga'], ['danceoff', 'Dance-off'], ['tip', 'Tip'], ['big', 'Big moment'], ['raid', 'Raid']] as const).map(([v, l]) => ({ k: `club-${v}`, label: l, action: 'club', params: { event: v }, hint: `Club moment: ${l.toLowerCase()}` })) });
  }
  if (has('lounge')) {
    out.push({ id: 'lounge', label: 'Celebrations', keys: optionsOf('lounge').filter((o) => /^(t[1-5]|gift|train|sub|raid)$/.test(o.value))
      .map((o) => ({ k: `lounge-${o.value}`, label: o.label, action: 'lounge', params: { event: o.value }, hint: `Play a celebration: ${o.label.toLowerCase()}` })) });
  }
  out.push({ id: 'fun', label: 'Fun', keys: [{ k: 'slap', label: 'Slap!', action: 'slap', params: { target: 'random' }, hint: 'The minion slaps someone in the room', key: 'Shift+S', ic: 'hand' }] });
  return out;
}

// ---------------------------------------------------------------- expressions
/** The face presets the dock offers (names in src/app.ts TEST_EXPRESSIONS, the table the 1-9 keys already use). */
export const DOCK_EXPRESSIONS = ['Smile', 'Big grin', 'Surprised', 'Angry', 'Sad', 'Wink'] as const;
/** The digit key that already shows `name` (main.ts: key N = the N-th preset), or '' when it has none. */
export function expressionKey(name: string, names: readonly string[]): string {
  const i = names.indexOf(name);
  return i >= 1 && i <= 9 ? String(i) : '';
}
/** The deck's expression names (shared/deck.ts: happy / angry / sad / surprised / relaxed) and a few plain words. */
export const EXPRESSION_ALIAS: Record<string, string> = {
  happy: 'Big grin', joy: 'Big grin', grin: 'Big grin', smile: 'Smile', relaxed: 'Smile', calm: 'Smile',
  surprised: 'Surprised', surprise: 'Surprised', wow: 'Surprised', shock: 'Surprised',
  angry: 'Angry', mad: 'Angry', sad: 'Sad', wink: 'Wink', neutral: 'Neutral',
};
/**
 * The preset an expression command means: the exact name, the same name in any case, or an alias. null = unknown
 * (the caller keeps its old behaviour). Fixes the deck's Happy / Wow / Angry keys, which showed a neutral face.
 */
export function resolveExpression(name: string, names: readonly string[]): string | null {
  if (typeof name !== 'string' || !name) return null;
  if (names.includes(name)) return name;
  const low = name.trim().toLowerCase();
  const ci = names.find((n) => n.toLowerCase() === low);
  if (ci) return ci;
  const a = EXPRESSION_ALIAS[low];
  return a && names.includes(a) ? a : null;
}

// ---------------------------------------------------------------- what the dock covers (audit + tests)
export type DockMenuId = 'room' | 'me' | 'guests' | 'chat' | 'events' | 'screen';
export interface DockPlanItem { what: string; action: string; /** 'bar' = one click; a menu = two clicks. */ where: 'bar' | DockMenuId }
/** Every live action of the audit (docs: the UX lane's AUDIT) and where the dock puts it. */
export const DOCK_PLAN: DockPlanItem[] = [
  { what: 'Lighting (Preshow, Show, React, BRB, Outro)', action: 'lighting', where: 'bar' },
  { what: 'Show mode (Talk, React, Gaming, Interview)', action: 'mode', where: 'bar' },
  { what: 'Camera shot', action: 'camera', where: 'bar' },
  { what: 'Interview shot', action: 'interview', where: 'bar' },
  { what: 'Hide my screen', action: 'cover', where: 'bar' },
  { what: 'Hide chat on stream', action: 'chat-hide', where: 'bar' },
  { what: 'Background video', action: 'video', where: 'screen' },
  { what: 'Change room', action: 'room', where: 'room' },
  { what: 'Room area', action: 'area', where: 'room' },
  { what: 'Let a guest in', action: 'knock-approve', where: 'guests' },
  { what: 'Mute a guest', action: 'guest-mute', where: 'guests' },
  { what: 'Hide a guest’s camera', action: 'guest-cam', where: 'guests' },
  { what: 'Cut all guests', action: 'guests-cut-all', where: 'guests' },
  { what: 'Copy guest link', action: 'guest-link', where: 'guests' },
  { what: 'Acknowledge next', action: 'hub-ack-next', where: 'chat' },
  { what: 'Thank next', action: 'hub-thank-next', where: 'chat' },
  { what: 'Read-aloud', action: 'hub-tts', where: 'chat' },
  { what: 'Start / end a poll', action: 'poll-start', where: 'chat' },
  { what: 'Expression', action: 'expression', where: 'me' },
  { what: 'Emote', action: 'emote', where: 'me' },
  { what: 'Outfit', action: 'costume', where: 'me' },
  { what: 'Recalibrate', action: 'recalibrate', where: 'me' },
  { what: 'Weather', action: 'weather', where: 'events' },
  { what: 'Background fight / warzone', action: 'raid', where: 'events' },
  { what: 'Club moment', action: 'club', where: 'events' },
  { what: 'Lounge celebration', action: 'lounge', where: 'events' },
  { what: 'Slap!', action: 'slap', where: 'events' },
];
export const dockClicks = (p: Pick<DockPlanItem, 'where'>): number => (p.where === 'bar' ? 1 : 2);
