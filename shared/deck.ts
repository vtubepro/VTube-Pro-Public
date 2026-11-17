// Stream Deck & controllers (docs/STREAM_DECK.md): ONE registry of everything a button can do, the button layout
// (device size, pages, keys) and the pure helpers both the server (server/deck.ts) and the pages (deck.html) use.
//
// An action is data: which bus command (or Chat Hub action) it sends, its parameters, and — for toggles / selectors —
// how to read "is it on right now?" from the live state the server knows (cache/scene.json + the Chat Hub).
// Nothing here touches the DOM, the file system or the network, so tools/deck_unit.ts can test all of it.
import { expandShotAlias } from './talkshow.ts';

export type DeckParamType = 'select' | 'text' | 'number' | 'room';
export interface DeckParam {
  key: string;
  label: string;
  type: DeckParamType;
  options?: { value: string; label: string }[];
  default?: string | number;
  /** number params */
  min?: number; max?: number;
}

export interface DeckActionDef {
  id: string;
  label: string;
  group: string;
  /** Emoji shown on the key when the key has no own icon. */
  icon: string;
  hint: string;
  params?: DeckParam[];
  /** Has an on / off (or "this one is selected") state that keys light up for. */
  stateful?: boolean;
  /** Handled by the deck itself (page switching), never sent to the server. */
  local?: boolean;
}

/** What the server knows about the live show, flattened for the state checks. */
export interface DeckLiveState {
  sceneId: string | null;
  mode: string;
  lighting: string;
  cover: boolean;
  raid: boolean;
  /** Warzone rooms: "calm" (the battle holds its big moments while the streamer talks). */
  calm?: boolean;
  videoOn: boolean;
  videoAudio: boolean;
  /** Ambient cameras (shared/ambientCam.ts) switched on. */
  ambcam?: boolean;
  /** The camera was picked by hand (SceneState.camPick): no room director cuts until Auto / a mode or room change. */
  camHand?: boolean;
  /** A Tabletop game (SceneState.ttrpg.on) is open: its table director cuts the camera in a table room. */
  ttrpgOn?: boolean;
  weather: string;
  /** The room's weather changes by itself (SceneState.env.weatherMode 'cycle'); missing = a fixed weather. A rule's "put back" reads it so automatic weather stays automatic. */
  weatherAuto?: boolean;
  tts: boolean;
  /** Connected studio pages (0 = the studio is closed: bus commands go nowhere). */
  studio: number;
  /** livedash: interview camera (modes.interview): director auto / manual, the last cut shot, the line-up (co-hosts +
   *  guests, in line-up order) + where they sit. `role` 'cohost' = at the desk with the host (missing = a guest). */
  director?: string;
  shot?: string;
  guests?: { name: string; place: string; key: string; role?: 'cohost'; kind?: 'performer' | 'video' | 'tv' }[];
  /** Scene camera outside Interview (SceneState.camera: talk / group / wide / react / screen / CAM_*) + who 'talk' frames. */
  camera?: string;
  focus?: string;
  /** React window size preset (SceneState.stage.react: auto / full / big / medium / side) — the Live panel's "React
   *  screen out of shot" note (shared/reactShot.ts). */
  react?: string;
  /** Member keys ('@host' = me) that are OUT of the room (everyone else present). */
  out?: string[];
  /** Entrances: walk in / out (false = instant) and how new party members arrive. */
  walk?: boolean;
  join?: string;
  /** live-tabs: room-change transition (SceneState.curtain): style id, cover-in seconds, hold-until-confirm, a held
   *  change waiting for the confirm; the camera move between shots (SceneState.transition, 0 = cut); chat hidden on
   *  stream (SceneState.chat.hidden); the capture cover's style + line. */
  curtain?: string;
  curtainDur?: number;
  curtainHold?: boolean;
  curtainWaiting?: boolean;
  camMove?: number;
  chatHidden?: boolean;
  /** Emote sounds' master switch (config/emote_sounds.json, shared/emoteSounds.ts). */
  emoteSounds?: boolean;
  coverStyle?: string;
  coverText?: string;
  /** live-tabs BRB card look (SceneState.brb). */
  brbStyle?: string;
  brbTheme?: string;
  brbText?: string;
  /** 'image:<rev>' / 'video:<rev>' = your own BRB background, '' = none. */
  brbBg?: string;
}
export const DEFAULT_LIVE: DeckLiveState = { sceneId: null, mode: 'talk', lighting: 'show', cover: false, raid: false, videoOn: false, videoAudio: false, weather: 'clear', tts: false, studio: 0 };

const opts = (...v: (string | [string, string])[]) => v.map((x) => (Array.isArray(x) ? { value: x[0], label: x[1] } : { value: x, label: x[0].toUpperCase() + x.slice(1) }));
const LIGHTING = opts('preshow', 'show', 'react', 'brb', 'outro');
const SHOT_OPTS = opts('auto', ['manual', 'Manual director'], 'establishing', 'host', ['cohost1', 'Co-host 1'], ['cohost2', 'Co-host 2'], ['hosts', 'Hosts (you + a co-host)'], ['panel', 'Panel (everyone at the desk)'],
  'guest', ['guest1', 'Guest 1'], ['guest2', 'Guest 2'], ['guest3', 'Guest 3'], ['guest4', 'Guest 4'], 'ots', 'two', 'wide', ['audience', 'Audience (the crowd)'], ['house', 'House wide'], ['take', 'The take (snap zoom on the host)'], 'sidekick', 'push', 'snap', 'reverse', ['bumper', 'Show open'],
  ['pin', 'Pin the shot on air (toggle)'], ['turn-guest', 'The guest’s turn'], ['turn-host', 'My turn'], ['pace-calm', 'Pace: calm'], ['pace-normal', 'Pace: normal'], ['pace-snappy', 'Pace: snappy']);
const WEATHER = opts('clear', 'cloudy', 'overcast', 'rain', ['heavyrain', 'Heavy rain'], 'storm', 'fog');

export const DECK_ACTIONS: DeckActionDef[] = [
  // ---- scene
  { id: 'lighting', label: 'Lighting state', group: 'Scene', icon: '💡', hint: 'Preshow / Show / React / BRB / Outro (lights + screen video follow)', stateful: true,
    params: [{ key: 'state', label: 'State', type: 'select', options: LIGHTING, default: 'show' }] },
  { id: 'mode', label: 'Stage mode', group: 'Scene', icon: '🎬', hint: 'Talk, React, Gaming or any installed mode (interview, …)', stateful: true,
    params: [{ key: 'mode', label: 'Mode', type: 'select', options: [...opts('talk', 'react', 'gaming', 'interview')], default: 'talk' }] },
  { id: 'room', label: 'Go to room', group: 'Scene', icon: '🏠', hint: 'Switch the room (with the transition card). Empty = Classic (no room)', stateful: true,
    params: [{ key: 'sceneId', label: 'Room', type: 'room', default: '' }] },
  { id: 'area', label: 'Room area', group: 'Scene', icon: '🧭', hint: 'Next / previous area of rooms that have areas, or an area key',
    params: [{ key: 'area', label: 'Area', type: 'text', default: 'next' }] },
  { id: 'curtain', label: 'Reveal room (curtain)', group: 'Scene', icon: '🎭', hint: 'Hold-mode transition card: reveal the new room now' },
  { id: 'cover', label: 'Hide my screen (capture cover)', group: 'Scene', icon: '🙈', hint: 'Animated card over your game / window capture (Blow the cartridge, Jacking in, Press Start …). Same as the Hide my screen key (Ctrl+B unless changed in Live → Privacy)', stateful: true,
    params: [{ key: 'on', label: 'Press does', type: 'select', options: opts('toggle', ['true', 'On'], ['false', 'Off']), default: 'toggle' },
      { key: 'text', label: 'Card line (empty = keep)', type: 'text', default: '' },
      { key: 'style', label: 'Card style id (empty = keep)', type: 'text', default: '' }] },
  // live-tabs: the Live panel's Transitions + Privacy tabs
  { id: 'transition', label: 'Room transition', group: 'Scene', icon: '🎞️', hint: 'The card that covers a room change: style, speed (seconds) and “wait for me” (hold until you reveal)', stateful: true,
    params: [{ key: 'style', label: 'Style id (vtp-dark, vtp-light, shuffle, cut …; keep = no change)', type: 'text', default: 'vtp-dark' },
      { key: 'dur', label: 'Speed in seconds (0 = no change)', type: 'number', min: 0, max: 2, default: 0 },
      { key: 'hold', label: 'Wait for me', type: 'select', options: opts(['keep', 'No change'], ['true', 'On'], ['false', 'Off'], 'toggle'), default: 'keep' }] },
  { id: 'camera-move', label: 'Camera move', group: 'Scene', icon: '🎥', hint: 'How the camera changes shots: 0 = a hard cut, else a glide of that many seconds', stateful: true,
    params: [{ key: 'secs', label: 'Seconds (0 = cut)', type: 'number', min: 0, max: 5, default: 0 }] },
  { id: 'brb-card', label: 'BRB card look', group: 'Scene', icon: '☕', hint: 'The Be Right Back card (BRB = the BRB lighting state: fade to black, guests muted, this card): animation, Light / Dark, its words',
    params: [{ key: 'style', label: 'Animation', type: 'select', options: opts(['keep', 'No change'], 'breathe', ['sweep', 'Light sweep'], ['dots', 'Bouncing dots']), default: 'keep' },
      { key: 'theme', label: 'Theme', type: 'select', options: opts(['keep', 'No change'], 'dark', 'light', ['toggle', 'Switch Light / Dark']), default: 'toggle' },
      { key: 'text', label: 'Words (empty = no change)', type: 'text', default: '' },
      { key: 'bg', label: 'Your own background (none = remove; empty = no change)', type: 'text', default: '' }] },
  { id: 'chat-hide', label: 'Hide chat on stream', group: 'Scene', icon: '🙊', hint: 'Hides the chat monitor, the chat buddy and the docked chat from viewers (support alerts stay)', stateful: true,
    params: [{ key: 'on', label: 'Press does', type: 'select', options: opts('toggle', ['true', 'Hide'], ['false', 'Show']), default: 'toggle' }] },
  { id: 'video', label: 'Screen video', group: 'Scene', icon: '📺', hint: 'Play / stop / next on the room screen', stateful: true,
    params: [{ key: 'action', label: 'Action', type: 'select', options: opts('toggle', 'play', 'stop', 'next', 'restart', ['off', 'Turn off (stays off)'], ['on', 'Turn back on']), default: 'toggle' },
      { key: 'slot', label: 'Playlist', type: 'select', options: opts(['', 'Current moment'], 'preshow', 'ambience', 'brb', 'outro'), default: '' }] },
  { id: 'camera', label: 'Scene camera', group: 'Scene', icon: '📷', hint: 'Talk / React / Gaming …: close-up (of someone), group, wide, the screen (centres the video / react window) or a room camera',
    stateful: true, params: [{ key: 'cam', label: 'Camera', type: 'select', options: opts('auto', ['talk', 'Close-up'], 'group', 'wide', ['screen', 'Screen (centred)'], ['react', 'React shot']), default: 'auto' },
      { key: 'focus', label: 'Close-up of (me / member id)', type: 'text', default: '' }] },
  { id: 'presence', label: 'In the room / outside', group: 'Scene', icon: '🚶', hint: 'Bring someone into the room or send them out (me, or a party member): walk through the door or appear instantly',
    stateful: true, params: [{ key: 'who', label: 'Who (me / member id)', type: 'text', default: 'me' }, { key: 'on', label: 'Press does', type: 'select', options: opts('toggle', ['in', 'Come in'], ['out', 'Leave']), default: 'toggle' },
      { key: 'how', label: 'How', type: 'select', options: opts(['', 'Entrances setting'], ['walk', 'Walk'], ['instant', 'Instant (already here)']), default: '' }] },
  { id: 'entrances', label: 'Entrances', group: 'Scene', icon: '🚪', hint: 'Walk-ins on / off (off = people appear in their seats), and how people who join arrive', stateful: true,
    params: [{ key: 'walk', label: 'Walk-ins', type: 'select', options: opts('toggle', ['true', 'On'], ['false', 'Off (instant)'], ['', 'Leave as is']), default: 'toggle' },
      { key: 'join', label: 'People who join', type: 'select', options: opts(['', 'Leave as is'], ['walk', 'Walk in'], ['seated', 'Already seated'], ['outside', 'Wait outside']), default: '' }] },
  { id: 'video-audio', label: 'Screen video sound', group: 'Scene', icon: '🔊', hint: 'Toggle the screen video sound on the OBS page', stateful: true },
  { id: 'ambcam', label: 'Ambient cameras', group: 'Scene', icon: '🎥', hint: 'Preshow / BRB / Outro camera moves: next shot, pick a move (orbit, pan, tour …), on / off', stateful: true,
    params: [{ key: 'action', label: 'Press does', type: 'select', options: opts('next', ['toggle', 'On / off'], ['auto', 'Back to the rotation'], ['orbit', 'Slow orbit'], ['pan', 'Slow pan'], ['dolly', 'Dolly'], ['crane', 'Crane'], ['zoom', 'Slow zoom'], ['drift', 'Handheld drift'], ['security', 'Security cam'], ['tour', 'Room tour']), default: 'next' },
      { key: 'state', label: 'Moment', type: 'select', options: opts(['', 'Current moment'], 'preshow', 'brb', 'outro'), default: '' }] },
  { id: 'weather', label: 'Weather', group: 'Scene', icon: '🌦️', hint: 'Rooms with time of day / weather', stateful: true,
    params: [{ key: 'weather', label: 'Weather', type: 'select', options: WEATHER, default: 'rain' }] },
  { id: 'hour', label: 'Time of day', group: 'Scene', icon: '🕗', hint: 'Set the clock of rooms with time of day (0–24)',
    params: [{ key: 'hour', label: 'Hour', type: 'number', min: 0, max: 24, default: 21 }] },
  { id: 'raid', label: 'Background raid', group: 'Scene', icon: '⚔️', hint: 'Background combat on / off', stateful: true },
  { id: 'warzone', label: 'Warzone set piece', group: 'Scene', icon: '💥', hint: 'Warzone rooms: call in an air strike, an armoured push, a militia assault the frogs repel, a technical, a mortar barrage, a gunship pass, flares or the sniper',
    params: [{ key: 'event', label: 'Set piece', type: 'select', options: opts(['wz_airstrike', 'Air strike'], ['wz_armor', 'Armoured push'], ['wz_assault', 'Militia assault'], ['wz_technical', 'Technical'], ['wz_mortar', 'Mortar barrage'], ['wz_heli', 'Gunship pass'], ['wz_flare', 'Illumination flares'], ['wz_sniper', 'Frog sniper']), default: 'wz_airstrike' }] },
  { id: 'calm', label: 'Calm the battle', group: 'Scene', icon: '🤫', hint: 'Warzone rooms: no new big moments and no shake inside while you talk (the far fighting goes on)', stateful: true },
  { id: 'club', label: 'Club moment', group: 'Scene', icon: '🪩', hint: 'Club room bits: conga, danceoff, raid, tip, big …',
    params: [{ key: 'event', label: 'Event', type: 'text', default: 'conga' }] },
  { id: 'lounge', label: 'Lounge celebration', group: 'Scene', icon: '🥂', hint: 'Hangout lounge: test a donation tier (bar drinks / shots, patio firepit + fireworks, lounge champagne + balloons), gifted subs, a gift train, or calm / off',
    params: [{ key: 'event', label: 'Event', type: 'select', options: opts(['t1', 'Tier 1 (small)'], ['t2', 'Tier 2'], ['t3', 'Tier 3'], ['t4', 'Tier 4 (room-wide)'], ['t5', 'Tier 5 (legend)'], ['gift', 'Gifted subs'], ['train', 'Gift train'], ['sub', 'New sub'], ['raid', 'Raid'], ['calm', 'Calm on / off'], ['toggle', 'Events on / off']), default: 't3' },
      { key: 'count', label: 'Gifts (gift / train)', type: 'number', min: 1, max: 500, default: 5 }, { key: 'user', label: 'Name on the banner', type: 'text', default: '' }] },
  // ---- performer
  { id: 'slap', label: 'Slap!', group: 'Fun', icon: '🖐️', hint: 'The minion slaps someone (random guest, host or a name)',
    params: [{ key: 'target', label: 'Target', type: 'text', default: 'random' }] },
  { id: 'emote', label: 'Emote', group: 'Fun', icon: '💃', hint: 'Play a VRMA emote by name ("stop" stops it)',
    params: [{ key: 'name', label: 'Emote', type: 'text', default: 'wave' }] },
  { id: 'expression', label: 'Expression', group: 'Fun', icon: '😊', hint: 'Show an expression for a few seconds',
    params: [{ key: 'name', label: 'Expression', type: 'select', options: opts('happy', 'angry', 'sad', 'surprised', 'relaxed'), default: 'happy' },
      { key: 'seconds', label: 'Seconds', type: 'number', min: 0.5, max: 30, default: 2.5 }] },
  { id: 'interview', label: 'Interview shot', group: 'Show', icon: '🎥', hint: 'Interview mode camera: auto / manual director, host, co-host 1–2, hosts, panel, guest 1–4, two-shot, wide …', stateful: true,
    params: [{ key: 'shot', label: 'Shot', type: 'select', options: SHOT_OPTS, default: 'auto' }] },
  // ---- party / guests (livedash: the studio runs these — src/ui/live/liveStudio.ts, bus command 'live')
  { id: 'guest-place', label: 'Guest: studio / monitor', group: 'Party', icon: '🪑', hint: 'Interview guest N (or a member id): seated in the studio or on the monitor', stateful: true,
    params: [{ key: 'guest', label: 'Guest #', type: 'number', min: 1, max: 4, default: 1 }, { key: 'where', label: 'Where', type: 'select', options: opts('toggle', 'studio', 'monitor'), default: 'toggle' },
      { key: 'peer', label: 'Member id (optional)', type: 'text', default: '' }] },
  { id: 'interview-role', label: 'Co-host / guest', group: 'Party', icon: '🤝', hint: 'Interview: make someone a co-host (sits with you at the desk) or a guest again. Who: a member id, guest1…4 or cohost1…2', stateful: true,
    params: [{ key: 'who', label: 'Who (member id / guest1 / cohost1)', type: 'text', default: 'guest1' }, { key: 'role', label: 'Press does', type: 'select', options: opts('toggle', ['cohost', 'Make co-host'], ['guest', 'Make guest']), default: 'toggle' }] },
  { id: 'knock-approve', label: 'Let in (knock)', group: 'Party', icon: '🚪', hint: 'Let in the first person knocking' },
  { id: 'knock-deny', label: 'Deny (knock)', group: 'Party', icon: '⛔', hint: 'Turn away the first person knocking' },
  { id: 'guest-kick', label: 'Kick guest', group: 'Party', icon: '👢', hint: 'Remove party member N (or a member id). "Also block them": they can’t come back with the same account / browser tab',
    params: [{ key: 'guest', label: 'Member #', type: 'number', min: 1, max: 8, default: 1 }, { key: 'peer', label: 'Member id (optional)', type: 'text', default: '' },
      { key: 'ban', label: 'Also block them', type: 'select', options: opts(['false', 'No'], ['true', 'Yes: block this account / link tab']), default: 'false' },
      { key: 'revoke', label: 'Also turn the invite link off', type: 'select', options: opts(['false', 'No'], ['true', 'Yes: the link stops working for everyone']), default: 'false' }] },
  { id: 'guest-mute', label: 'Mute guest', group: 'Party', icon: '🔇', hint: 'Mute / unmute a guest everywhere: stream, the OBS page, your speakers and every other guest’s ears (party member N, or a member id). Undo-able',
    params: [{ key: 'guest', label: 'Member #', type: 'number', min: 1, max: 8, default: 1 }, { key: 'peer', label: 'Member id (optional)', type: 'text', default: '' }, { key: 'on', label: 'Mute', type: 'select', options: opts('toggle', 'true', 'false'), default: 'toggle' }] },
  // moderation (shared/moderation.ts): instant, no confirm, Undo-able — enforced in the host's studio, the guest is told
  { id: 'guest-cam', label: 'Hide guest camera', group: 'Party', icon: '📷', hint: 'Hide / show a guest’s camera on stream, the OBS page and for other guests (everyone sees a “Camera off” card; a 3D-avatar guest leaves the room). Party member N or a member id',
    params: [{ key: 'guest', label: 'Member #', type: 'number', min: 1, max: 8, default: 1 }, { key: 'peer', label: 'Member id (optional)', type: 'text', default: '' }, { key: 'on', label: 'Press does', type: 'select', options: opts('toggle', ['true', 'Hide'], ['false', 'Show']), default: 'toggle' }] },
  { id: 'guest-volume', label: 'Guest volume', group: 'Party', icon: '🔉', hint: 'A guest’s volume on stream, in your speakers and in the other guests’ mix (0–100)',
    params: [{ key: 'guest', label: 'Member #', type: 'number', min: 1, max: 8, default: 1 }, { key: 'peer', label: 'Member id (optional)', type: 'text', default: '' }, { key: 'vol', label: 'Volume %', type: 'number', min: 0, max: 100, default: 100 }] },
  { id: 'guest-cut', label: 'Cut guest (camera + mic)', group: 'Party', icon: '⛔', hint: 'Panic button for one guest: camera AND mic off at once, everywhere. Press again (toggle) or Undo brings them back',
    params: [{ key: 'guest', label: 'Member #', type: 'number', min: 1, max: 8, default: 1 }, { key: 'peer', label: 'Member id (optional)', type: 'text', default: '' }, { key: 'on', label: 'Press does', type: 'select', options: opts('toggle', ['true', 'Cut'], ['false', 'Bring back']), default: 'toggle' }] },
  { id: 'guests-cut-all', label: 'Cut all guests', group: 'Party', icon: '🚨', hint: 'Emergency: every guest’s camera and mic off at once (one Undo brings them all back)',
    params: [{ key: 'on', label: 'Press does', type: 'select', options: opts(['true', 'Cut everyone'], ['false', 'Bring everyone back'], 'toggle'), default: 'true' }] },
  { id: 'guest-undo', label: 'Undo (guest moderation)', group: 'Party', icon: '↩️', hint: 'Undo the last camera / mic / volume / cut change' },
  { id: 'guest-cut-hold', label: 'Cut: also to green room', group: 'Party', icon: '🛋️', hint: 'When you cut a guest, also send them back to the green room (off the show until you bring them on)',
    params: [{ key: 'on', label: 'Press does', type: 'select', options: opts('toggle', ['true', 'On'], ['false', 'Off']), default: 'toggle' }] },
  { id: 'guest-voice', label: 'Link guests: voice', group: 'Party', icon: '🎧', hint: 'Talk with link guests without Discord: hear them in the studio / send them your voice',
    params: [{ key: 'what', label: 'What', type: 'select', options: opts(['hear', 'Hear them here'], ['talkback', 'They hear me'], ['mic', 'Pick the mic they hear']), default: 'hear' }, { key: 'on', label: 'Press does', type: 'select', options: opts('toggle', ['true', 'On'], ['false', 'Off']), default: 'toggle' },
      { key: 'mic', label: 'Mic id (Pick the mic; empty = same as lip sync)', type: 'text', default: '' }] },
  { id: 'party-end', label: 'End party', group: 'Party', icon: '🛑', hint: 'Close the party for everyone' },
  { id: 'guest-link', label: 'Copy interview link', group: 'Party', icon: '🔗', hint: 'Mint + copy a no-install guest link (in the studio window), or turn the current link off (it stops working for everyone)',
    params: [{ key: 'do', label: 'Press does', type: 'select', options: opts(['copy', 'Copy a link'], ['off', 'Turn the link off']), default: 'copy' }] },
  // greenroom: the waiting room (shared/greenroom.ts). Member # / id empty = the next guest waiting (READY first).
  { id: 'greenroom-on', label: 'Bring on (green room)', group: 'Party', icon: '🎬', hint: 'Bring a guest from the green room onto the show (the Entrances setting: walk in / appear). Empty = the next guest (READY first, then who waited longest)',
    params: [{ key: 'guest', label: 'Member # (0 = next)', type: 'number', min: 0, max: 8, default: 0 }, { key: 'peer', label: 'Member id (optional)', type: 'text', default: '' }] },
  { id: 'greenroom-back', label: 'Back to green room', group: 'Party', icon: '🚪', hint: 'Send a guest back to the green room (they walk out first when walk-ins are on). Empty = the guest brought on last',
    params: [{ key: 'guest', label: 'Member # (0 = last on)', type: 'number', min: 0, max: 8, default: 0 }, { key: 'peer', label: 'Member id (optional)', type: 'text', default: '' }] },
  { id: 'greenroom-next', label: 'Next guest', group: 'Party', icon: '⏭️', hint: 'The guest brought on last goes back to the green room and the next waiting guest (READY first) comes on' },
  { id: 'greenroom-msg', label: 'Message a guest', group: 'Party', icon: '💬', hint: 'Send a guest a message on their page (no sound: a banner): up next, in 1 minute, you’re live, hang tight, or your own text',
    params: [{ key: 'preset', label: 'Message', type: 'select', options: opts(['next', 'You’re up next'], ['minute', 'Going on in 1 minute'], ['live', 'You’re live now!'], ['hold', 'Hang tight a moment'], ['text', 'My own text (below)']), default: 'next' },
      { key: 'text', label: 'Own text (max 140)', type: 'text', default: '' },
      { key: 'to', label: 'To', type: 'select', options: opts(['next', 'The next guest waiting'], ['all', 'Everyone in the green room'], ['last', 'The guest brought on last'], ['member', 'Member # / id below']), default: 'next' },
      { key: 'guest', label: 'Member #', type: 'number', min: 1, max: 8, default: 1 }, { key: 'peer', label: 'Member id (optional)', type: 'text', default: '' }] },
  { id: 'greenroom-talk', label: 'Talk backstage', group: 'Party', icon: '🎙️', hint: 'Two-way voice with one waiting guest only (plays on the backstage output you picked, never on the OBS page)',
    params: [{ key: 'peer', label: 'Member id', type: 'text', default: '' }, { key: 'on', label: 'Press does', type: 'select', options: opts('toggle', ['true', 'On'], ['false', 'Off']), default: 'toggle' }] },
  { id: 'greenroom-output', label: 'Backstage voice output', group: 'Party', icon: '🎧', hint: 'Where backstage voice plays (headphones OBS does NOT capture). Empty = the default output',
    params: [{ key: 'sink', label: 'Output device id (empty = default)', type: 'text', default: '' }] },
  { id: 'greenroom-mode', label: 'Green room: who waits', group: 'Party', icon: '🛋️', hint: 'Who waits in the green room when they join: link guests (default), everyone, or nobody (straight in)',
    params: [{ key: 'mode', label: 'New guests', type: 'select', options: opts(['link', 'Link guests wait'], ['all', 'Everyone waits'], ['off', 'Nobody waits']), default: 'link' }] },
  // ---- me
  { id: 'costume', label: 'Outfit', group: 'Me', icon: '👗', hint: 'Switch outfit by id (empty = default outfit)', params: [{ key: 'id', label: 'Outfit id', type: 'text', default: '' }] },
  { id: 'accessory', label: 'Accessory on / off', group: 'Me', icon: '🎩', hint: 'Toggle an accessory by id', params: [{ key: 'id', label: 'Accessory id', type: 'text', default: '' }] },
  { id: 'model-slider', label: '2D model slider / outfit', group: 'Me', icon: '🎚️', hint: 'Pro2D models: toggle, step, set or reset a model slider (chest, body, outfit, hair …) or switch an outfit on / off, by the name the studio shows (empty = the first slider)',
    params: [{ key: 'slider', label: 'Slider or outfit name', type: 'text', default: '' }, { key: 'do', label: 'Do', type: 'select', options: opts('toggle', 'step', 'set', 'reset', 'on', 'off'), default: 'toggle' },
      { key: 'value', label: 'Value (for set)', type: 'number', default: 1 }] },
  { id: 'recalibrate', label: 'Recalibrate face', group: 'Me', icon: '🎯', hint: 'Hold a neutral face for 2.5 s: re-centres the tracking' },
  { id: 'trackloss', label: 'When tracking is lost', group: 'Me', icon: '🧊', hint: 'Hold last pose / return to rest / voice life when the camera loses you (per part, or all); "cycle" steps through them',
    params: [{ key: 'mode', label: 'Mode', type: 'select', options: opts('hold', 'rest', ['life', 'Voice life'], 'cycle'), default: 'hold' },
      { key: 'part', label: 'Part', type: 'select', options: opts('all', ['face', 'Head & face'], 'eyes', 'body', 'hands'), default: 'all' }] },
  // ---- chat hub
  { id: 'hub-ack-next', label: 'Acknowledge next', group: 'Chat Hub', icon: '✅', hint: 'Mark the oldest open support / event as done' },
  { id: 'hub-thank-next', label: 'Thank next', group: 'Chat Hub', icon: '🙏', hint: 'Thank the oldest open supporter' },
  { id: 'hub-ack-all', label: 'Acknowledge all', group: 'Chat Hub', icon: '☑️', hint: 'Clear the whole queue' },
  { id: 'hub-skip', label: 'Skip read-aloud', group: 'Chat Hub', icon: '⏭️', hint: 'Stop the message being read out' },
  { id: 'hub-replay', label: 'Replay read-aloud', group: 'Chat Hub', icon: '🔁', hint: 'Read the last message again' },
  { id: 'hub-tts', label: 'Read-aloud on / off', group: 'Chat Hub', icon: '🗣️', hint: 'Text-to-speech of donation messages', stateful: true },
  { id: 'emote-sounds', label: 'Emote sounds on / off', group: 'Chat Hub', icon: '🔔', hint: 'The sounds you gave emotes (Chat → Emotes): play when chat uses them', stateful: true,
    params: [{ key: 'on', label: 'Press does', type: 'select', options: opts('toggle', ['true', 'Turn on'], ['false', 'Turn off']), default: 'toggle' }] },
  // ---- chat polls (server/poll.ts)
  { id: 'poll-start', label: 'Start poll', group: 'Poll', icon: '📊', hint: 'Start a saved poll by name (empty = the last saved one, else Yes / No; "1–4" = the 1–4 preset)',
    params: [{ key: 'template', label: 'Saved poll name', type: 'text', default: '' }] },
  { id: 'poll-end', label: 'End poll', group: 'Poll', icon: '🏁', hint: 'End the running poll now (winner reveal)' },
  { id: 'poll-show', label: 'Show / hide poll', group: 'Poll', icon: '👁️', hint: 'Show or hide the poll card on stream',
    params: [{ key: 'on', label: 'Card', type: 'select', options: [{ value: 'toggle', label: 'Toggle' }, { value: 'show', label: 'Show' }, { value: 'hide', label: 'Hide' }], default: 'toggle' }] },
  // ---- goals, stretch goals + the subathon timer (server/goals.ts)
  { id: 'subathon', label: 'Subathon timer', group: 'Goals', icon: '⏱️', hint: 'Pause / resume the subathon, add or take off time, undo the last change, happy hour, sleep mode, or start a new one',
    params: [{ key: 'do', label: 'Press does', type: 'select', options: opts(['toggle', 'Pause / resume'], 'pause', 'resume', ['add', 'Add time'], ['sub', 'Take time off'], ['undo', 'Undo last change'], ['happy', 'Happy hour'], ['happy-off', 'Happy hour off'], ['sleep', 'Sleep mode on / off'], ['start', 'Start a new one']), default: 'toggle' },
      { key: 'minutes', label: 'Minutes (add / take off / happy hour length)', type: 'number', min: 1, max: 1440, default: 5 },
      { key: 'mult', label: 'Happy hour ×', type: 'number', min: 1, max: 10, default: 2 }] },
  { id: 'goal', label: 'Goal', group: 'Goals', icon: '🎯', hint: 'Show / hide a goal on stream, add to it by hand, or start a new stream (every-stream goals start over)',
    params: [{ key: 'do', label: 'Press does', type: 'select', options: opts(['toggle', 'Show / hide'], 'show', 'hide', ['add', 'Add an amount'], ['newstream', 'New stream']), default: 'toggle' },
      { key: 'goal', label: 'Goal (its name or number; empty = the first)', type: 'text', default: '' },
      { key: 'amount', label: 'Amount to add (negative takes off)', type: 'number', min: -1000000, max: 1000000, default: 5 }] },
  { id: 'wheel-spin', label: 'Spin the wheel', group: 'Goals', icon: '🎡', hint: 'Spin the wheel on stream (its slots are set in Goals & subathon)' },
  // ---- the chat audience (server/audience.ts)
  { id: 'audience-applause', label: 'Applause', group: 'Audience', icon: '👏', hint: 'The whole chat audience claps and cheers' },
  { id: 'audience-next', label: 'Next question', group: 'Audience', icon: '❓', hint: 'Show the next approved question (pinned first, then paid / bumped, then oldest)' },
  { id: 'audience-done', label: 'Question done', group: 'Audience', icon: '✔️', hint: 'Take the question being answered off stream' },
  // ---- beta.16 stream extras (docs/b16/LANES.md): the ids are the contract; each lane owns the behaviour behind its params
  // and plays them from the bus command of the same name (the studio stamps, OBS pages play). All are also Rules actions
  // (shared/streamRules.ts). An empty id / name means "the lane's own default" (random sticker, last scene, first sound ...).
  { id: 'throw', label: 'Throw at my head', group: 'Stream extras', icon: '🎯', hint: 'Chat emotes, a starter prop or your own picture fly at the avatar\'s head (headpat = a hand pats it)',
    params: [{ key: 'what', label: 'What', type: 'select', options: opts(['emote', 'Chat emotes'], ['prop', 'Starter props'], ['image', 'My picture'], ['headpat', 'Headpat']), default: 'emote' },
      { key: 'count', label: 'How many', type: 'number', min: 1, max: 40, default: 1 },
      { key: 'item', label: 'Item id (empty = random)', type: 'text', default: '' },
      { key: 'from', label: 'Whose emotes', type: 'select', options: opts(['chat', 'Chat'], ['raider', 'The raider'], ['redeemer', 'Whoever redeemed']), default: 'chat' }] },
  { id: 'item-scene', label: 'Item scene', group: 'Stream extras', icon: '🎩', hint: 'Turn a saved set of stickers / props on the avatar on, off or toggle (empty name = the last one used)',
    params: [{ key: 'name', label: 'Scene name', type: 'text', default: '' }, { key: 'on', label: 'Press does', type: 'select', options: opts('toggle', ['true', 'On'], ['false', 'Off']), default: 'toggle' }] },
  { id: 'sticker', label: 'Sticker on me', group: 'Stream extras', icon: '🏷️', hint: 'Put a sticker or item on the avatar (random from your sticker set when empty), or clear them',
    params: [{ key: 'op', label: 'Do', type: 'select', options: opts('random', 'add', 'clear'), default: 'random' }, { key: 'item', label: 'Item id (empty = random)', type: 'text', default: '' },
      { key: 'secs', label: 'Seconds (0 = stays)', type: 'number', min: 0, max: 600, default: 0 }] },
  { id: 'emote-rain', label: 'Emote rain', group: 'Stream extras', icon: '🌧️', hint: 'Chat emotes fall onto the avatar\'s head and shoulders',
    params: [{ key: 'op', label: 'Do', type: 'select', options: opts('burst', 'start', 'stop'), default: 'burst' }, { key: 'secs', label: 'Seconds', type: 'number', min: 1, max: 120, default: 8 },
      { key: 'from', label: 'Whose emotes', type: 'select', options: opts(['chat', 'Chat'], ['raider', 'The raider'], ['redeemer', 'Whoever redeemed']), default: 'chat' }] },
  { id: 'sfx', label: 'Play a sound', group: 'Stream extras', icon: '🔔', hint: 'A soundboard sting. Plays on the OBS page only, and only when sounds are switched on',
    params: [{ key: 'id', label: 'Sound id (empty = none)', type: 'text', default: '' }, { key: 'volume', label: 'Volume %', type: 'number', min: 0, max: 100, default: 70 }] },
  { id: 'screen-fx', label: 'Screen effect', group: 'Stream extras', icon: '📼', hint: 'A short full-frame effect: glitch, VHS, pixelate, shake, bloom pop or black & white (always inside the flash-safety limit)',
    params: [{ key: 'preset', label: 'Effect', type: 'select', options: opts('glitch', 'vhs', 'pixelate', 'shake', ['bloom', 'Bloom pop'], ['bw', 'Black & white']), default: 'glitch' },
      { key: 'secs', label: 'Seconds', type: 'number', min: 0.2, max: 60, default: 3 }] },
  { id: 'recorded-emote', label: 'My recorded emote', group: 'Stream extras', icon: '🎞️', hint: 'Play an emote you recorded from your own camera (empty = the latest one)',
    params: [{ key: 'name', label: 'Emote name', type: 'text', default: '' }] },
  { id: 'cohost-say', label: 'Co-host says', group: 'Stream extras', icon: '🤖', hint: 'The AI co-host says a line, or answers chat when empty (needs the co-host switched on)',
    params: [{ key: 'text', label: 'Say (empty = answer chat)', type: 'text', default: '' }] },
  { id: 'cohost-mute', label: 'Mute co-host', group: 'Stream extras', icon: '🤐', hint: 'Stop the AI co-host from talking (and let it talk again)',
    params: [{ key: 'on', label: 'Press does', type: 'select', options: opts('toggle', ['true', 'Mute'], ['false', 'Unmute']), default: 'toggle' }] },
  // ---- advanced
  { id: 'command', label: 'Custom command', group: 'Advanced', icon: '⚙️', hint: 'Any studio bus command (docs/SCENES.md): command name + JSON args',
    params: [{ key: 'command', label: 'Command', type: 'text', default: 'scene' }, { key: 'args', label: 'Args (JSON)', type: 'text', default: '{"lighting":"show"}' }] },
  // ---- deck itself
  { id: 'page-next', label: 'Next page', group: 'Deck', icon: '➡️', hint: 'Next page of this layout', local: true },
  { id: 'page-prev', label: 'Previous page', group: 'Deck', icon: '⬅️', hint: 'Previous page of this layout', local: true },
  { id: 'page-go', label: 'Go to page', group: 'Deck', icon: '📄', hint: 'Jump to a page (1 = first)', local: true, params: [{ key: 'page', label: 'Page', type: 'number', min: 1, max: 50, default: 1 }] },
];
export const ACTION_BY_ID = new Map(DECK_ACTIONS.map((a) => [a.id, a]));

/** Commands a Custom command key may never send (they write the avatar library / diagnostics, never a button's job). */
const BLOCKED_COMMANDS = new Set(['screenshot', 'diag', 'recordClip', 'rebuild']);

// ---------------------------------------------------------------- layout
export interface DeckKey {
  action: string;
  params?: Record<string, string | number>;
  /** Own label (default = the action label). */
  title?: string;
  /** Emoji, or a small data:image/png|svg URL (≤ 64 KB). */
  icon?: string;
  /** Key background #rrggbb. */
  color?: string;
}
export interface DeckPage { name: string; keys: (DeckKey | null)[] }
export interface DeckLayout { v: 1; name: string; cols: number; rows: number; pages: DeckPage[] }

export const DEVICE_SIZES: { id: string; label: string; cols: number; rows: number }[] = [
  { id: 'mini', label: 'Stream Deck Mini / Neo-ish (3×2)', cols: 3, rows: 2 },
  { id: 'mk2', label: 'Stream Deck MK.2 / original (5×3)', cols: 5, rows: 3 },
  { id: 'plus', label: 'Stream Deck + (4×2)', cols: 4, rows: 2 },
  { id: 'xl', label: 'Stream Deck XL (8×4)', cols: 8, rows: 4 },
  { id: 'pad', label: 'Macro pad / keypad (4×4)', cols: 4, rows: 4 },
];
export const MAX_COLS = 12, MAX_ROWS = 8, MAX_PAGES = 20;

const clampInt = (v: unknown, lo: number, hi: number, d: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const COLOR = /^#[0-9a-f]{6}$/i;
const ICON_URL = /^data:image\/(png|svg\+xml|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

export function sanitizeKey(v: unknown): DeckKey | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const def = typeof o.action === 'string' ? ACTION_BY_ID.get(o.action) : undefined;
  if (!def) return null;
  const k: DeckKey = { action: def.id };
  if (o.params && typeof o.params === 'object') {
    const p: Record<string, string | number> = {};
    for (const d of def.params ?? []) {
      const x = (o.params as Record<string, unknown>)[d.key];
      if (d.type === 'number') { const n = Number(x); if (x !== undefined && x !== '' && Number.isFinite(n)) p[d.key] = Math.min(d.max ?? 1e6, Math.max(d.min ?? -1e6, n)); }
      else if (typeof x === 'string' || typeof x === 'number') p[d.key] = String(x).slice(0, d.key === 'args' ? 2000 : 120);
    }
    if (Object.keys(p).length) k.params = p;
  }
  if (typeof o.title === 'string' && o.title.trim()) k.title = o.title.slice(0, 40);
  if (typeof o.icon === 'string' && o.icon && (o.icon.length <= 16 || (o.icon.length <= 90_000 && ICON_URL.test(o.icon)))) k.icon = o.icon;
  if (typeof o.color === 'string' && COLOR.test(o.color)) k.color = o.color.toLowerCase();
  return k;
}

export function sanitizeLayout(v: unknown): DeckLayout {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const cols = clampInt(o.cols, 1, MAX_COLS, 5), rows = clampInt(o.rows, 1, MAX_ROWS, 3), n = cols * rows;
  const pagesIn = Array.isArray(o.pages) ? o.pages.slice(0, MAX_PAGES) : [];
  const pages: DeckPage[] = pagesIn.map((p, i) => {
    const po = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    const keys = Array.isArray(po.keys) ? po.keys.slice(0, n).map(sanitizeKey) : [];
    while (keys.length < n) keys.push(null);
    return { name: typeof po.name === 'string' && po.name.trim() ? po.name.slice(0, 32) : `Page ${i + 1}`, keys };
  });
  if (!pages.length) pages.push({ name: 'Page 1', keys: Array(n).fill(null) });
  return { v: 1, name: typeof o.name === 'string' && o.name.trim() ? o.name.slice(0, 48) : 'My deck', cols, rows, pages };
}

/** Change the grid size, keeping every key at the same row / column (keys that no longer fit are dropped). */
export function resizeLayout(l: DeckLayout, cols: number, rows: number): DeckLayout {
  cols = clampInt(cols, 1, MAX_COLS, l.cols); rows = clampInt(rows, 1, MAX_ROWS, l.rows);
  const pages = l.pages.map((p) => {
    const keys: (DeckKey | null)[] = Array(cols * rows).fill(null);
    for (let r = 0; r < Math.min(rows, l.rows); r++) for (let c = 0; c < Math.min(cols, l.cols); c++) keys[r * cols + c] = p.keys[r * l.cols + c] ?? null;
    return { ...p, keys };
  });
  return { ...l, cols, rows, pages };
}

/** A starter layout (MK.2 size) so the screen is never empty on first open. */
export function defaultLayout(): DeckLayout {
  const K = (action: string, params?: Record<string, string | number>, title?: string, color?: string): DeckKey => ({ action, ...(params ? { params } : {}), ...(title ? { title } : {}), ...(color ? { color } : {}) });
  return sanitizeLayout({
    name: 'My deck', cols: 5, rows: 3, pages: [
      { name: 'Show', keys: [
        K('lighting', { state: 'preshow' }, 'Preshow', '#3b2a6b'), K('lighting', { state: 'show' }, 'Show', '#1f5a3a'), K('lighting', { state: 'react' }, 'React', '#1f4a6b'), K('lighting', { state: 'brb' }, 'BRB', '#6b4a1f'), K('lighting', { state: 'outro' }, 'Outro', '#6b1f3a'),
        K('mode', { mode: 'talk' }, 'Talk'), K('mode', { mode: 'react' }, 'React mode'), K('mode', { mode: 'gaming' }, 'Gaming'), K('cover', { on: 'toggle' }, 'Cover', '#444a55'), K('curtain', undefined, 'Reveal'),
        K('hub-ack-next', undefined, 'Ack next', '#1f5a3a'), K('hub-thank-next', undefined, 'Thank', '#5a4a1f'), K('hub-tts', undefined, 'Read-aloud'), K('slap', { target: 'random' }, 'Slap!', '#6b1f1f'), K('page-next', undefined, 'More ➡'),
      ] },
      { name: 'Fun', keys: [
        K('expression', { name: 'happy', seconds: 2.5 }, 'Happy'), K('expression', { name: 'surprised', seconds: 2.5 }, 'Wow'), K('expression', { name: 'angry', seconds: 2.5 }, 'Angry'), K('emote', { name: 'wave' }, 'Wave'), K('emote', { name: 'stop' }, 'Stop emote'),
        K('video', { action: 'toggle', slot: '' }, 'Video'), K('video-audio', undefined, 'Video sound'), K('weather', { weather: 'rain' }, 'Rain'), K('weather', { weather: 'clear' }, 'Clear'), K('raid', undefined, 'Raid'),
        null, null, null, null, K('page-prev', undefined, '⬅ Back'),
      ] },
    ],
  });
}

// ---------------------------------------------------------------- running + state
export type DeckRun =
  | { kind: 'bus'; command: string; args: Record<string, unknown> }
  | { kind: 'hub'; action: 'ack-next' | 'ack-all' | 'thank-next' | 'skip' | 'replay' | 'tts-toggle' }
  | { kind: 'local'; action: string }
  | { kind: 'poll'; action: 'start' | 'end' | 'show' | 'hide' | 'toggle'; template: string }
  | { kind: 'emotesnd'; on: boolean | null }
  | { kind: 'goals'; action: 'subathon' | 'goal' | 'wheel'; args: Record<string, unknown> }
  | { kind: 'audience'; action: 'applause' | 'next' | 'done' }
  | { kind: 'error'; error: string };

const pv = (def: DeckActionDef, params: Record<string, unknown> | undefined, key: string): string | number | undefined => {
  const v = params?.[key];
  if (v !== undefined && v !== '') return v as string | number;
  return def.params?.find((p) => p.key === key)?.default;
};
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
/** beta.16 stream extras: an item / sound / emote id, and a free scene name (letters, digits, spaces, . - _). */
const EXTRA_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const EXTRA_NAME = /^[A-Za-z0-9_ .-]{1,48}$/;

/** Turn an action + its params into what the server sends. `live` resolves toggles (raid on → off). */
export function planRun(id: string, params: Record<string, unknown> | undefined, live: DeckLiveState = DEFAULT_LIVE): DeckRun {
  const def = ACTION_BY_ID.get(id);
  if (!def) return { kind: 'error', error: `Unknown action "${id}"` };
  if (def.local) return { kind: 'local', action: id };
  const P = (k: string) => pv(def, params, k);
  const scene = (args: Record<string, unknown>): DeckRun => ({ kind: 'bus', command: 'scene', args });
  switch (id) {
    case 'lighting': return scene({ lighting: str(P('state')) || 'show' });
    case 'mode': { const m = str(P('mode')); return /^[a-z][a-z0-9-]{1,23}$/.test(m) ? scene({ mode: m }) : { kind: 'error', error: 'Bad mode' }; }
    case 'room': { const r = str(P('sceneId')); return !r ? scene({ sceneId: null }) : /^[a-z0-9][a-z0-9_-]{0,47}(?:~[a-z0-9][a-z0-9_-]{0,23})?$/.test(r) ? scene({ sceneId: r }) : { kind: 'error', error: 'Bad room id' }; }
    case 'area': return scene({ area: str(P('area')) || 'next' });
    case 'curtain': return scene({ curtain: { confirm: true } });
    case 'cover': {
      const o = str(P('on')), t = str(P('text')).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 60), sy = str(P('style'));
      if (sy && !/^[a-z][a-z0-9-]{0,31}$/.test(sy)) return { kind: 'error', error: 'Bad cover style' };
      // (on 'keep': only the card line / style change)
      // (a text param that is only spaces clears the line back to the style's own)
      return scene({ cover: { ...(o === 'keep' ? {} : { on: o === 'true' ? true : o === 'false' ? false : 'toggle' }), ...(str(P('text')) ? { text: t } : {}), ...(sy ? { style: sy } : {}) } });
    }
    // live-tabs: room-change transition (style / speed / wait for me), the camera move, hide chat on stream
    case 'transition': {
      const st = str(P('style')), d = Number(P('dur')), h = str(P('hold'));
      const c: Record<string, unknown> = {};
      if (st && st !== 'keep') { if (!/^[a-z][a-z0-9-]{0,31}$/.test(st)) return { kind: 'error', error: 'Bad transition style' }; c.style = st; }
      if (Number.isFinite(d) && d > 0) c.dur = Math.min(2, Math.max(0.25, d));
      if (h === 'true' || h === 'false') c.hold = h === 'true'; else if (h === 'toggle') c.hold = !live.curtainHold;
      return Object.keys(c).length ? scene({ curtain: c }) : { kind: 'error', error: 'Nothing to change' };
    }
    case 'camera-move': { const v = Number(P('secs')); return Number.isFinite(v) ? scene({ transition: Math.round(Math.min(5, Math.max(0, v)) * 100) / 100 }) : { kind: 'error', error: 'Seconds must be a number' }; }
    case 'brb-card': {
      const sy = str(P('style')), th = str(P('theme')), tx = str(P('text')).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 40);
      const b: Record<string, unknown> = {};
      if (sy && sy !== 'keep') { if (!/^(breathe|sweep|dots)$/.test(sy)) return { kind: 'error', error: 'Bad BRB animation' }; b.style = sy; }
      if (th === 'toggle') b.theme = live.brbTheme === 'light' ? 'dark' : 'light';
      else if (th && th !== 'keep') { if (th !== 'light' && th !== 'dark') return { kind: 'error', error: 'Theme is light or dark' }; b.theme = th; }
      if (str(P('text'))) b.text = tx;
      const bg = str(P('bg'));
      if (bg === 'none') b.bg = null;
      else if (bg) { const m = /^(image|video):(\d{1,16})$/.exec(bg); if (!m) return { kind: 'error', error: 'Bad background' }; b.bg = { kind: m[1], rev: Number(m[2]) }; }
      return Object.keys(b).length ? scene({ brb: b }) : { kind: 'error', error: 'Nothing to change' };
    }
    case 'chat-hide': { const o = str(P('on')) || 'toggle'; return scene({ chat: { hidden: o === 'true' ? true : o === 'false' ? false : !live.chatHidden } }); }
    case 'video': {
      const x = str(P('action')) || 'toggle';
      // off / on: the master switch (a Stop only lasts until the next lighting change; Off stays off)
      if (x === 'off') return scene({ video: { on: false } });
      const a: Record<string, unknown> = x === 'on' ? { on: true, action: 'play' } : { action: x }; const s = str(P('slot')); if (s) a.slot = s; return scene({ video: a });
    }
    case 'video-audio': return scene({ video: { audio: 'toggle' } });
    case 'camera': {
      const c = str(P('cam')) || 'auto', f = str(P('focus'));
      if (!/^[A-Za-z0-9_]{1,48}$/.test(c)) return { kind: 'error', error: 'Bad camera' };
      if (f && !/^(me|@host|[A-Za-z0-9_-]{1,64})$/.test(f)) return { kind: 'error', error: 'Bad member id' };
      // auto = the mode's own camera (Talk: close-up, React: the React shot, Gaming: group) and the room's directors may cut
      // again (camPick:false); any other button is a hand pick that beats every automatic camera (shared/camPick.ts)
      const cam = c === 'auto' ? autoCamera(live.mode) : c;
      return scene({ camera: cam, ...(c === 'auto' ? { camPick: false } : {}), ...(f ? { focus: f === 'me' ? '@host' : f } : c === 'auto' && cam === 'talk' ? { focus: '@host' } : {}) });
    }
    case 'presence': {
      const w = str(P('who')) || 'me', key = w === 'me' ? '@host' : w, o = str(P('on')) || 'toggle', how = str(P('how'));
      if (!/^(@host|[A-Za-z0-9_-]{1,64})$/.test(key)) return { kind: 'error', error: 'Bad member id' };
      return scene({ present: { key, on: o === 'in' ? true : o === 'out' ? false : 'toggle', ...(how === 'walk' || how === 'instant' ? { how } : {}) } });
    }
    case 'entrances': {
      const w = str(P('walk')), j = str(P('join'));
      const e: Record<string, unknown> = {};
      if (w === 'toggle') e.walk = 'toggle'; else if (w === 'true' || w === 'false') e.walk = w === 'true';
      if (j === 'walk' || j === 'seated' || j === 'outside') e.join = j;
      return Object.keys(e).length ? scene({ entrances: e }) : { kind: 'error', error: 'Nothing to change' };
    }
    case 'ambcam': { const x = str(P('action')) || 'next', st = str(P('state')); const c: Record<string, unknown> = x === 'toggle' ? { on: 'toggle' } : x === 'next' || x === 'auto' ? { action: x } : /^(pan|orbit|dolly|crane|zoom|drift|security|tour)$/.test(x) ? { move: x } : { action: 'next' }; if (st) c.state = st; return scene({ ambcam: c }); }
    // (`auto` is not in the editor: only a rule's put-back sends it, to hand the room's weather back to its own cycle)
    case 'weather': return scene({ env: { weather: str(P('weather')) || 'clear', auto: str(params?.auto) === 'true' } });
    case 'hour': { const h = Number(P('hour')); return Number.isFinite(h) ? scene({ env: { hour: h, clock: 'fixed' } }) : { kind: 'error', error: 'Bad hour' }; }
    case 'raid': return scene({ raid: { on: !live.raid } });
    case 'warzone': { const e = str(P('event')) || 'wz_airstrike'; return /^wz_[a-z]{2,16}$/.test(e) ? scene({ raid: { event: e } }) : { kind: 'error', error: 'Bad set piece' }; }
    case 'calm': return scene({ raid: { calm: !live.calm } });
    case 'club': return scene({ club: { event: str(P('event')) || 'conga' } });
    case 'lounge': {
      const e = str(P('event')) || 't3', c = Math.round(Number(P('count'))), u = str(P('user')).slice(0, 32);
      if (!/^(t[1-5]|gift|train|sub|raid|calm|toggle|on|off)$/.test(e)) return { kind: 'error', error: 'Bad lounge event' };
      return scene({ lounge: { event: e, ...((e === 'gift' || e === 'train') && c >= 1 ? { n: Math.min(500, c) } : {}), ...(u ? { user: u } : {}) } });
    }
    case 'slap': return { kind: 'bus', command: 'slap', args: { target: str(P('target')) || 'random' } };
    case 'emote': { const n = str(P('name')); return n === 'stop' ? { kind: 'bus', command: 'emote', args: { stop: true } } : { kind: 'bus', command: 'emote', args: { name: n } }; }
    case 'expression': return { kind: 'bus', command: 'expression', args: { name: str(P('name')) || 'happy', seconds: Number(P('seconds')) || 2.5 } };
    case 'interview': { const s = str(P('shot')) || 'auto';
      // (pin: the shot on air stays — pressed again, back to auto; turn-*: someone gets the floor; pace-*: the director's pace)
      const pace = /^pace-(calm|normal|snappy)$/.exec(s)?.[1];
      return { kind: 'bus', command: 'interview', args: s === 'bumper' ? { bumper: true } : s === 'auto' ? { director: 'auto' } : s === 'manual' ? { director: 'manual' }
        : s === 'pin' ? { pin: live.director !== 'manual' } : s === 'turn-guest' ? { floor: 'guest' } : s === 'turn-host' ? { floor: 'host' } : pace ? { pace }
        // (cue v3: the audience / the house wide are a `wide` with a camera - a page whose room lacks them shows the room wide; the
        // studio's own handler reads the same names through the same expander, so the same names cut the same)
        : expandShotAlias(s) ?? { shot: s } }; }
    case 'guest-place': { const g = Math.round(Number(P('guest'))), w = str(P('where')) || 'toggle', peer = str(P('peer'));
      if (peer && !/^(lib:)?[A-Za-z0-9_-]{1,64}$/.test(peer)) return { kind: 'error', error: 'Bad member id' };
      if (!peer && !(g >= 1 && g <= 4)) return { kind: 'error', error: 'Guest must be 1–4' };
      // (Guest N counts guests only — co-hosts sit at the desk; no line-up known: the N-th entry, as before)
      const list = live.guests ?? [];
      const i = peer ? list.findIndex((x) => x.key === peer) : list.length ? lineupIndex(list, 'guest', g) : g - 1;
      if (i < 0) return { kind: 'error', error: peer ? 'Not in the interview line-up' : `No guest ${g} in the line-up` };
      if (list[i]?.role === 'cohost') return { kind: 'error', error: 'Co-hosts sit at the desk (make them a guest first)' };
      const cur = list[i]?.place;
      const where = w === 'toggle' ? (cur === 'studio' ? 'monitor' : 'studio') : w;
      return where === 'studio' || where === 'monitor' ? { kind: 'bus', command: 'interview', args: { place: { i, where, ...(peer ? { key: peer } : {}) } } } : { kind: 'error', error: 'Bad place' }; }
    case 'interview-role': {
      const who = str(P('who')) || 'guest1', r = str(P('role')) || 'toggle';
      const list = live.guests ?? [];
      const m = /^(guest|cohost)([1-4])$/.exec(who);
      if (!m && !/^(lib:)?[A-Za-z0-9_-]{1,64}$/.test(who)) return { kind: 'error', error: 'Bad member id' };
      // (no line-up known here — the studio closed / an old state: the studio resolves who it is)
      if (!list.length) return r === 'toggle' || r === 'cohost' || r === 'guest' ? { kind: 'bus', command: 'interview', args: { role: { who, role: r } } } : { kind: 'error', error: 'Bad role' };
      const i = m ? lineupIndex(list, m[1] === 'cohost' ? 'cohost' : 'guest', +m[2]) : list.findIndex((x) => x.key === who);
      if (i < 0) return { kind: 'error', error: 'Not in the interview line-up' };
      const g = list[i];
      if (g.kind === 'video') return { kind: 'error', error: 'Video callers are guests on the monitor' };
      const role = r === 'toggle' ? (g.role === 'cohost' ? 'guest' : 'cohost') : r;
      if (role !== 'cohost' && role !== 'guest') return { kind: 'error', error: 'Bad role' };
      return { kind: 'bus', command: 'interview', args: { role: { i, role, ...(g.key ? { key: g.key } : {}) } } }; }
    // (peer: a relay peer id — the Live panel's per-knock buttons; none = the first person knocking)
    case 'knock-approve': case 'knock-deny': { const peer = str(P('peer')), op = id === 'knock-approve' ? 'approve' : 'deny';
      if (peer && !/^[a-z0-9]{6,32}$/.test(peer)) return { kind: 'error', error: 'Bad peer id' };
      return { kind: 'bus', command: 'live', args: peer ? { op, peer } : { op } }; }
    case 'guest-kick': { const peer = str(P('peer')), g = Math.round(Number(P('guest')));
      if (peer && !/^[A-Za-z0-9_-]{1,64}$/.test(peer)) return { kind: 'error', error: 'Bad member id' };
      const ban = { ...(str(P('ban')) === 'true' ? { ban: true } : {}), ...(str(P('revoke')) === 'true' ? { revoke: true } : {}) };
      return peer ? { kind: 'bus', command: 'live', args: { op: 'kick', peer, ...ban } } : g >= 1 ? { kind: 'bus', command: 'live', args: { op: 'kick', guest: g, ...ban } } : { kind: 'error', error: 'Which member?' }; }
    // moderation: camera / volume / cut one guest / cut everyone / undo (src/ui/live/liveStudio.ts modCommand)
    case 'guest-cam': case 'guest-cut': case 'guest-volume': {
      const peer = str(P('peer')), g = Math.round(Number(P('guest')));
      if (peer && !/^[A-Za-z0-9_-]{1,64}$/.test(peer)) return { kind: 'error', error: 'Bad member id' };
      if (!peer && !(g >= 1)) return { kind: 'error', error: 'Which member?' };
      const who = peer ? { peer } : { guest: g };
      if (id === 'guest-volume') { const v = Number(P('vol')); return Number.isFinite(v) ? { kind: 'bus', command: 'live', args: { op: 'vol', ...who, vol: Math.round(Math.min(100, Math.max(0, v))) / 100 } } : { kind: 'error', error: 'Volume must be 0–100' }; }
      const o = str(P('on')) || 'toggle';
      return { kind: 'bus', command: 'live', args: { op: id === 'guest-cam' ? 'cam' : 'cut', ...who, on: o === 'true' ? true : o === 'false' ? false : 'toggle' } }; }
    case 'guests-cut-all': { const o = str(P('on')) || 'true'; return { kind: 'bus', command: 'live', args: { op: 'cutall', on: o === 'false' ? false : o === 'toggle' ? 'toggle' : true } }; }
    case 'guest-undo': return { kind: 'bus', command: 'live', args: { op: 'modundo' } };
    case 'guest-cut-hold': { const o = str(P('on')) || 'toggle'; return { kind: 'bus', command: 'live', args: { op: 'modhold', on: o === 'true' ? true : o === 'false' ? false : 'toggle' } }; }
    case 'guest-mute': { const peer = str(P('peer')), g = Math.round(Number(P('guest'))), o = str(P('on')) || 'toggle';
      if (peer && !/^[A-Za-z0-9_-]{1,64}$/.test(peer)) return { kind: 'error', error: 'Bad member id' };
      if (!peer && !(g >= 1)) return { kind: 'error', error: 'Which member?' };
      const on = o === 'true' ? true : o === 'false' ? false : 'toggle';
      return { kind: 'bus', command: 'live', args: peer ? { op: 'mute', peer, on } : { op: 'mute', guest: g, on } }; }
    case 'party-end': return { kind: 'bus', command: 'live', args: { op: 'end' } };
    case 'guest-voice': {
      if (str(P('what')) === 'mic') { const id = str(P('mic')); return /^[A-Za-z0-9+/=_-]{0,128}$/.test(id) ? { kind: 'bus', command: 'live', args: { op: 'talkmic', id } } : { kind: 'error', error: 'Bad microphone id' }; }
      const wh = str(P('what'));
      if (wh === 'mixresume') return { kind: 'bus', command: 'live', args: { op: 'mixresume' } };
      const w = wh === 'talkback' ? 'talkback' : wh === 'obs' ? 'obsvoice' : 'hear', o = str(P('on')) || 'toggle'; return { kind: 'bus', command: 'live', args: { op: w, on: o === 'true' ? true : o === 'false' ? false : 'toggle' } }; }
    case 'guest-link': return { kind: 'bus', command: 'live', args: { op: str(P('do')) === 'off' ? 'linkoff' : 'guestlink' } };
    // greenroom (src/ui/live/liveStudio.ts runs them: the party lives in the studio page)
    case 'greenroom-on': case 'greenroom-back': {
      const peer = str(P('peer')), g = Math.round(Number(P('guest'))) || 0, op = id === 'greenroom-on' ? 'gr-on' : 'gr-back';
      if (peer && !/^[A-Za-z0-9_-]{1,64}$/.test(peer)) return { kind: 'error', error: 'Bad member id' };
      return { kind: 'bus', command: 'live', args: peer ? { op, peer } : g >= 1 && g <= 8 ? { op, guest: g } : { op } }; }
    case 'greenroom-next': return { kind: 'bus', command: 'live', args: { op: 'gr-next' } };
    case 'greenroom-msg': {
      const pr = str(P('preset')) || 'next', text = str(P('text')).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 140), to = str(P('to')) || 'next';
      if (!['next', 'minute', 'live', 'hold', 'text'].includes(pr)) return { kind: 'error', error: 'Bad message' };
      if (pr === 'text' && !text) return { kind: 'error', error: 'Type the message text' };
      const peer = str(P('peer')), g = Math.round(Number(P('guest')));
      if (peer && !/^[A-Za-z0-9_-]{1,64}$/.test(peer)) return { kind: 'error', error: 'Bad member id' };
      const who = to === 'member' ? (peer ? { peer } : g >= 1 ? { guest: g } : null) : ['next', 'all', 'last'].includes(to) ? { to } : null;
      if (!who) return { kind: 'error', error: 'Who gets it?' };
      return { kind: 'bus', command: 'live', args: { op: 'gr-msg', ...(pr === 'text' ? { text } : { preset: pr }), ...who } }; }
    case 'greenroom-talk': { const peer = str(P('peer')), o = str(P('on')) || 'toggle';
      if (peer && !/^[A-Za-z0-9_-]{1,64}$/.test(peer)) return { kind: 'error', error: 'Bad member id' };
      return { kind: 'bus', command: 'live', args: { op: 'gr-talk', ...(peer ? { peer } : {}), on: o === 'true' ? true : o === 'false' ? false : 'toggle' } }; }
    case 'greenroom-output': { const d = str(P('sink')); return /^[A-Za-z0-9+/=_-]{0,128}$/.test(d) ? { kind: 'bus', command: 'live', args: { op: 'gr-sink', id: d } } : { kind: 'error', error: 'Bad output id' }; }
    case 'greenroom-mode': { const m = str(P('mode')) || 'link'; return m === 'link' || m === 'all' || m === 'off' ? { kind: 'bus', command: 'live', args: { op: 'gr-mode', mode: m } } : { kind: 'error', error: 'Bad mode' }; }
    case 'costume': { const c = str(P('id')); return /^[A-Za-z0-9_.-]{0,64}$/.test(c) ? { kind: 'bus', command: 'costume', args: { id: c || null } } : { kind: 'error', error: 'Bad outfit id' }; }
    case 'model-slider': {
      const s = str(P('slider')).trim(), d = str(P('do')) || 'toggle', v = Number(P('value'));
      if (s.length > 128 || /[\x00-\x1f]/.test(s)) return { kind: 'error', error: 'Bad slider name' };
      if (!/^(toggle|step|set|reset|on|off)$/.test(d)) return { kind: 'error', error: 'Bad slider action' };
      return { kind: 'bus', command: 'flat', args: { param: s, op: d, ...(d === 'set' && Number.isFinite(v) ? { value: v } : {}) } };
    }
    case 'accessory': { const c = str(P('id')); return /^[A-Za-z0-9_.-]{0,64}$/.test(c) ? { kind: 'bus', command: 'live', args: { op: 'accessory', id: c } } : { kind: 'error', error: 'Bad accessory id' }; }
    case 'recalibrate': return { kind: 'bus', command: 'live', args: { op: 'recalibrate' } };
    case 'trackloss': { const m = str(P('mode')), part = str(P('part')) || 'all';
      if (!/^(hold|rest|life|cycle)$/.test(m) || !/^(all|face|eyes|body|hands)$/.test(part)) return { kind: 'error', error: 'Bad tracking-loss mode' };
      return { kind: 'bus', command: 'live', args: { op: 'trackloss', mode: m, part } }; }
    case 'hub-ack-next': return { kind: 'hub', action: 'ack-next' };
    case 'hub-thank-next': return { kind: 'hub', action: 'thank-next' };
    case 'hub-ack-all': return { kind: 'hub', action: 'ack-all' };
    case 'hub-skip': return { kind: 'hub', action: 'skip' };
    case 'hub-replay': return { kind: 'hub', action: 'replay' };
    case 'hub-tts': return { kind: 'hub', action: 'tts-toggle' };
    case 'emote-sounds': { const o = str(P('on')) || 'toggle'; return { kind: 'emotesnd', on: o === 'true' ? true : o === 'false' ? false : null }; }
    case 'poll-start': return { kind: 'poll', action: 'start', template: str(P('template')).slice(0, 40) };
    case 'poll-end': return { kind: 'poll', action: 'end', template: '' };
    case 'poll-show': { const o = str(P('on')); return { kind: 'poll', action: o === 'show' || o === 'hide' ? o : 'toggle', template: '' }; }
    case 'subathon': { const d = str(P('do')) || 'toggle'; if (!/^(toggle|pause|resume|add|sub|undo|happy|happy-off|sleep|start)$/.test(d)) return { kind: 'error', error: 'Bad subathon action' }; return { kind: 'goals', action: 'subathon', args: { do: d, minutes: Math.min(1440, Math.max(1, Number(P('minutes')) || 5)), mult: Math.min(10, Math.max(1, Number(P('mult')) || 2)) } }; }
    case 'goal': { const d = str(P('do')) || 'toggle'; if (!/^(toggle|show|hide|add|newstream)$/.test(d)) return { kind: 'error', error: 'Bad goal action' }; const a = Number(P('amount')); return { kind: 'goals', action: 'goal', args: { do: d, goal: str(P('goal')).slice(0, 48), amount: Number.isFinite(a) ? a : 0 } }; }
    case 'wheel-spin': return { kind: 'goals', action: 'wheel', args: {} };
    case 'audience-applause': return { kind: 'audience', action: 'applause' };
    case 'audience-next': return { kind: 'audience', action: 'next' };
    case 'audience-done': return { kind: 'audience', action: 'done' };
    // beta.16 stream extras: validated here, played by the lane that owns the bus command of the same name (docs/b16/LANES.md)
    case 'throw': {
      const w = str(P('what')) || 'emote', it = str(P('item')), fr = str(P('from')) || 'chat', n = Math.round(Number(P('count')));
      if (!/^(emote|prop|image|headpat)$/.test(w)) return { kind: 'error', error: 'Bad throw type' };
      if (it && !EXTRA_ID.test(it)) return { kind: 'error', error: 'Bad item id' };
      if (!/^(chat|raider|redeemer)$/.test(fr)) return { kind: 'error', error: 'Whose emotes: chat, raider or redeemer' };
      return { kind: 'bus', command: 'throw', args: { what: w, count: Number.isFinite(n) ? Math.min(40, Math.max(1, n)) : 1, ...(it ? { item: it } : {}), from: fr } };
    }
    case 'item-scene': {
      const nm = str(P('name')), o = str(P('on')) || 'toggle';
      if (nm && !EXTRA_NAME.test(nm)) return { kind: 'error', error: 'Bad scene name' };
      return { kind: 'bus', command: 'item-scene', args: { name: nm, on: o === 'true' ? true : o === 'false' ? false : 'toggle' } };
    }
    case 'sticker': {
      const o = str(P('op')) || 'random', it = str(P('item')), sec = Number(P('secs'));
      if (!/^(random|add|clear)$/.test(o)) return { kind: 'error', error: 'Bad sticker op' };
      if (it && !EXTRA_ID.test(it)) return { kind: 'error', error: 'Bad item id' };
      return { kind: 'bus', command: 'sticker', args: { op: o, ...(it ? { item: it } : {}), secs: Number.isFinite(sec) ? Math.min(600, Math.max(0, sec)) : 0 } };
    }
    case 'emote-rain': {
      const o = str(P('op')) || 'burst', sec = Number(P('secs')), fr = str(P('from')) || 'chat';
      if (!/^(burst|start|stop)$/.test(o)) return { kind: 'error', error: 'Bad emote rain op' };
      if (!/^(chat|raider|redeemer)$/.test(fr)) return { kind: 'error', error: 'Whose emotes: chat, raider or redeemer' };
      return { kind: 'bus', command: 'emote-rain', args: { op: o, secs: Number.isFinite(sec) ? Math.min(120, Math.max(1, sec)) : 8, from: fr } };
    }
    case 'sfx': {
      const sid = str(P('id')), v = Number(P('volume'));
      if (sid && !EXTRA_ID.test(sid)) return { kind: 'error', error: 'Bad sound id' };
      return { kind: 'bus', command: 'sfx', args: { id: sid, volume: Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 70 } };
    }
    case 'screen-fx': {
      const pr = str(P('preset')) || 'glitch', sec = Number(P('secs'));
      if (!/^(glitch|vhs|pixelate|shake|bloom|bw)$/.test(pr)) return { kind: 'error', error: 'Bad effect' };
      return { kind: 'bus', command: 'screen-fx', args: { preset: pr, secs: Number.isFinite(sec) ? Math.min(60, Math.max(0.2, sec)) : 3 } };
    }
    case 'recorded-emote': { const nm = str(P('name')); return !nm || EXTRA_ID.test(nm) ? { kind: 'bus', command: 'recorded-emote', args: { name: nm } } : { kind: 'error', error: 'Bad emote name' }; }
    case 'cohost-say': return { kind: 'bus', command: 'cohost-say', args: { text: str(P('text')).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 300) } };
    case 'cohost-mute': { const o = str(P('on')) || 'toggle'; return { kind: 'bus', command: 'cohost-mute', args: { on: o === 'true' ? true : o === 'false' ? false : 'toggle' } }; }
    case 'command': {
      const c = str(P('command'));
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(c)) return { kind: 'error', error: 'Bad command name' };
      if (BLOCKED_COMMANDS.has(c)) return { kind: 'error', error: `"${c}" is not available on a button` };
      let args: unknown = {};
      try { args = JSON.parse(str(P('args')) || '{}'); } catch { return { kind: 'error', error: 'Args are not valid JSON' }; }
      if (!args || typeof args !== 'object' || Array.isArray(args)) return { kind: 'error', error: 'Args must be a JSON object' };
      return { kind: 'bus', command: c, args: args as Record<string, unknown> };
    }
  }
  return { kind: 'error', error: `No handler for "${id}"` };
}

/** Is this key lit? null = the action has no state. */
/** The scene camera a mode starts on (src/scene/stage/modes/*: its `camera`; SceneController.setMode) = the Live panel's "Auto". */
export function autoCamera(mode: string): string {
  return mode === 'react' ? 'react' : mode === 'gaming' ? 'group' : mode === 'ttrpg' ? 'wide' : 'talk';
}

export function keyActive(k: Pick<DeckKey, 'action' | 'params'> | null, live: DeckLiveState): boolean | null {
  if (!k) return null;
  const def = ACTION_BY_ID.get(k.action);
  if (!def?.stateful) return null;
  const P = (key: string) => str(pv(def, k.params, key));
  switch (def.id) {
    case 'lighting': return live.lighting === (P('state') || 'show');
    case 'mode': return live.mode === P('mode');
    case 'room': return (live.sceneId ?? '') === P('sceneId');
    case 'cover': return live.cover;
    case 'transition': { const st = P('style'), h = P('hold'); return st && st !== 'keep' ? (live.curtain ?? 'vtp-dark') === st : h === 'false' ? !live.curtainHold : h === 'true' || h === 'toggle' ? !!live.curtainHold : null; }
    case 'camera-move': return Math.abs((live.camMove ?? 1.2) - (Number(P('secs')) || 0)) < 0.051;
    case 'chat-hide': return P('on') === 'false' ? !live.chatHidden : !!live.chatHidden;
    case 'video': return P('action') === 'off' ? !live.videoOn : live.videoOn;
    case 'video-audio': return live.videoAudio;
    case 'camera': {
      const c = P('cam') || 'auto', f = P('focus');
      if (live.mode === 'interview') return false;
      const auto = autoCamera(live.mode);
      if (c === 'auto') return (live.camera ?? auto) === auto && !f && (auto !== 'talk' || (live.focus ?? '@host') === '@host');
      return live.camera === c && (!f || (live.focus ?? '@host') === (f === 'me' ? '@host' : f));
    }
    case 'presence': { const w = P('who') || 'me', k = w === 'me' ? '@host' : w, o = P('on'); const isIn = !(live.out ?? []).includes(k); return o === 'out' ? !isIn : isIn; }
    case 'entrances': { const j = P('join'), w = P('walk'); return j ? live.join === j : w === 'false' ? live.walk === false : live.walk !== false; }
    case 'ambcam': return !!live.ambcam;
    case 'weather': return live.weather === P('weather');
    case 'raid': return live.raid;
    case 'calm': return !!live.calm;
    case 'hub-tts': return live.tts;
    case 'emote-sounds': return P('on') === 'false' ? !live.emoteSounds : !!live.emoteSounds;
    case 'interview': { const s = P('shot') || 'auto'; return s === 'auto' || s === 'manual' ? (live.director ?? 'auto') === s : s === 'pin' ? live.director === 'manual' : /^(turn|pace)-/.test(s) ? false : live.director === 'manual' && live.shot === s; }
    case 'guest-place': {
      const list = live.guests ?? [], peer = P('peer');
      const g = peer ? list.find((x) => x.key === peer) : list[lineupIndex(list, 'guest', Math.round(Number(P('guest'))))];
      const w = P('where'); return !!g && (w === 'toggle' ? g.place === 'studio' : g.place === w); }
    case 'interview-role': {
      const list = live.guests ?? [], who = P('who') || 'guest1', m = /^(guest|cohost)([1-4])$/.exec(who);
      const g = m ? list[lineupIndex(list, m[1] === 'cohost' ? 'cohost' : 'guest', +m[2])] : list.find((x) => x.key === who);
      const r = P('role') || 'toggle'; return !!g && (r === 'guest' ? g.role !== 'cohost' : g.role === 'cohost'); }
  }
  return null;
}

/** Line-up index of the n-th (1-based) co-host / guest (Co-host 1, Guest 2 …), -1 = none. */
export function lineupIndex(list: { role?: string }[], role: 'guest' | 'cohost', n: number): number {
  let k = 0;
  for (let i = 0; i < list.length; i++) if ((list[i].role === 'cohost' ? 'cohost' : 'guest') === role && ++k === n) return i;
  return -1;
}

/** Flatten the saved SceneState (+ Chat Hub TTS) into DeckLiveState. Tolerates any junk. */
export function liveFromScene(scene: unknown, tts: boolean, studio: number): DeckLiveState {
  const s = (scene && typeof scene === 'object' ? scene : {}) as Record<string, any>;
  const o = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, any> : {});
  return {
    sceneId: typeof s.sceneId === 'string' ? s.sceneId : null,
    mode: typeof s.mode === 'string' ? s.mode : 'talk',
    lighting: typeof o(s.lights).state === 'string' ? o(s.lights).state : 'show',
    cover: o(s.capcover).on === true,
    raid: o(s.raid).on === true,
    ...(o(s.raid).calm === true ? { calm: true } : {}),
    videoOn: o(s.video).on === true,
    videoAudio: o(s.video).audio === true,
    ambcam: o(s.ambcam).on === true,
    ...(typeof s.camPick === 'number' && s.camPick > 0 ? { camHand: true } : {}),
    ...(o(s.ttrpg).on === true ? { ttrpgOn: true } : {}),
    weather: typeof o(s.env).weather === 'string' ? o(s.env).weather : 'clear',
    ...(o(s.env).weatherMode === 'cycle' ? { weatherAuto: true } : {}),
    tts: !!tts,
    studio,
    camera: typeof s.camera === 'string' ? s.camera : 'talk',
    focus: typeof s.focus === 'string' ? s.focus : '@host',
    ...(['auto', 'full', 'big', 'medium', 'side'].includes(o(s.stage).react) ? { react: o(s.stage).react as string } : {}),   // (missing = auto)
    out: Object.entries(o(s.present)).filter(([, v]) => v === false).map(([k]) => k).slice(0, 16),
    walk: o(s.entrances).walk !== false,
    join: o(s.entrances).join === 'seated' || o(s.entrances).join === 'outside' ? o(s.entrances).join : 'walk',
    // live-tabs (defaults = shared/curtain.ts DEFAULT_CURTAIN, shared/scene.ts transition 1.2, shared/capcover.ts)
    curtain: typeof o(s.curtain).style === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(o(s.curtain).style) ? o(s.curtain).style : 'vtp-dark',
    curtainDur: typeof o(s.curtain).dur === 'number' && Number.isFinite(o(s.curtain).dur) ? Math.min(2, Math.max(0.25, o(s.curtain).dur)) : 0.6,
    curtainHold: o(s.curtain).hold === true,
    curtainWaiting: o(s.curtain).hold === true && Number(o(s.curtain).confirm) < Number(o(s.curtain).seq),
    camMove: typeof s.transition === 'number' && Number.isFinite(s.transition) ? Math.min(5, Math.max(0, s.transition)) : 1.2,
    chatHidden: o(s.chat).hidden === true,
    coverStyle: typeof o(s.capcover).style === 'string' ? String(o(s.capcover).style).slice(0, 32) : 'cc-cartridge',
    coverText: typeof o(s.capcover).text === 'string' ? String(o(s.capcover).text).slice(0, 60) : '',
    brbStyle: ['breathe', 'sweep', 'dots'].includes(o(s.brb).style) ? o(s.brb).style : 'breathe',
    brbTheme: o(s.brb).theme === 'light' ? 'light' : 'dark',
    brbText: typeof o(s.brb).text === 'string' ? String(o(s.brb).text).slice(0, 40) : '',
    brbBg: (o(o(s.brb).bg).kind === 'image' || o(o(s.brb).bg).kind === 'video') && Number(o(o(s.brb).bg).rev) > 0 ? `${o(o(s.brb).bg).kind}:${Math.round(Number(o(o(s.brb).bg).rev))}` : '',
    ...(o(s.modes).interview ? interviewLive(o(o(s.modes).interview)) : {}),
  };
}

/** livedash: the interview bag's camera + guests (place = where they show: an unset place follows the layout). */
function interviewLive(b: Record<string, any>): Pick<DeckLiveState, 'director' | 'shot' | 'guests'> {
  const gs = Array.isArray(b.guests) ? b.guests.slice(0, 6) : [];
  return {
    director: b.director === 'manual' ? 'manual' : 'auto',
    shot: typeof b.shot === 'string' ? b.shot : 'establishing',
    guests: gs.map((g: any) => {
      const co = g?.role === 'cohost' && g?.kind !== 'video';
      return { name: typeof g?.name === 'string' ? g.name.slice(0, 32) : 'Guest', key: typeof g?.key === 'string' ? g.key : '',
        // (co-hosts sit at the desk)
        place: g?.kind === 'video' ? 'monitor' : co ? 'studio' : g?.place === 'studio' || g?.place === 'monitor' ? g.place : (b.layout === 'seated' ? 'studio' : 'monitor'),
        ...(co ? { role: 'cohost' as const } : {}), ...(g?.kind === 'video' || g?.kind === 'tv' ? { kind: g.kind } : {}) };
    }),
  };
}

/** What a device draws: one entry per key, already resolved (title, icon, colour, lit). */
export interface DeckFace { a: string | null; title: string; icon: string; color: string; on: boolean | null; /** page-go: target page (0-based) */ go?: number }
export interface DeckResolved { name: string; cols: number; rows: number; pages: { name: string; keys: DeckFace[] }[] }

export function resolveLayout(l: DeckLayout, live: DeckLiveState): DeckResolved {
  return {
    name: l.name, cols: l.cols, rows: l.rows,
    pages: l.pages.map((p) => ({ name: p.name, keys: p.keys.map((k): DeckFace => {
      if (!k) return { a: null, title: '', icon: '', color: '#000000', on: null };
      const def = ACTION_BY_ID.get(k.action);
      return { a: k.action, title: k.title ?? def?.label ?? k.action, icon: k.icon ?? def?.icon ?? '', color: k.color ?? '#1d2230', on: keyActive(k, live),
        ...(k.action === 'page-go' ? { go: nextPage('page-go', k.params, 0, l.pages.length) } : {}) };
    }) })),
  };
}

/** Which key of the app layout a physical key at (column, row) shows: the grid is anchored top-left; keys outside the
 *  layout (device bigger than the layout) show nothing. */
export function keyIndexAt(l: { cols: number; rows: number }, column: number, row: number): number {
  if (column < 0 || row < 0 || column >= l.cols || row >= l.rows) return -1;
  return row * l.cols + column;
}

/** Page after a local page action (wraps around). */
export function nextPage(action: string, params: Record<string, unknown> | undefined, page: number, count: number): number {
  if (count <= 0) return 0;
  if (action === 'page-next') return (page + 1) % count;
  if (action === 'page-prev') return (page - 1 + count) % count;
  if (action === 'page-go') return Math.min(count - 1, Math.max(0, Math.round(Number(params?.page ?? 1)) - 1 || 0));
  return page;
}

/** The ws protocol of /ws/deck (server/deck.ts). */
export type DeckServerMsg =
  | { t: 'hello'; actions: DeckActionDef[]; layout: DeckLayout; resolved: DeckResolved; live: DeckLiveState }
  | { t: 'layout'; layout: DeckLayout; resolved: DeckResolved }
  | { t: 'state'; resolved: DeckResolved; live: DeckLiveState }
  | { t: 'result'; id?: string; ok: boolean; error?: string; page?: number };
export type DeckClientMsg =
  | { t: 'press'; page: number; index: number; id?: string }
  | { t: 'run'; action: string; params?: Record<string, unknown>; id?: string };
