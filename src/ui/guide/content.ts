// ux-simplicity: every word the first-run home, the tour and the Help button say, as plain data (tools/guide_unit.ts
// checks it against the voice rules in T\portal\ux\VOICE.md: short sentences, one action, no jargon).

/** Studio area ids (src/ui/simple.ts AreaId), kept as strings so this file has no imports. */
export type GuideArea = 'home' | 'onair' | 'me' | 'live' | 'room' | 'show' | 'chat' | 'games' | 'friends' | 'stream' | 'create' | 'settings';

/** Where "Help for this screen" points: a guide section (the Help viewer's FILE.md#anchor; also mapped to /docs). The
 *  same targets as docs-user's AREA_HELP (shared/helpCatalog.ts), so both Help buttons agree. */
export const AREA_HELP: Record<GuideArea, { simple: string; advanced: string }> = {
  home: { simple: 'SIMPLE_MODE.md#home', advanced: 'SIMPLE_MODE.md#home' },
  onair: { simple: 'LIVE_PANEL.md', advanced: 'LIVE_PANEL.md' },
  me: { simple: 'SIMPLE_MODE.md#me', advanced: 'ADVANCED_MODE.md#me' },
  live: { simple: 'SIMPLE_MODE.md#tracking', advanced: 'ADVANCED_MODE.md#tracking' },
  room: { simple: 'SIMPLE_MODE.md#room', advanced: 'ADVANCED_MODE.md#room' },
  show: { simple: 'ADVANCED_MODE.md#show', advanced: 'ADVANCED_MODE.md#show' },
  chat: { simple: 'CHAT_HUB.md#set-up-my-chat--stream', advanced: 'ADVANCED_MODE.md#chat' },
  games: { simple: 'SIMPLE_MODE.md#games', advanced: 'SIMPLE_MODE.md#games' },
  friends: { simple: 'GUESTS_AND_PARTIES.md', advanced: 'ADVANCED_MODE.md#party' },
  stream: { simple: 'ADVANCED_MODE.md#obs', advanced: 'ADVANCED_MODE.md#obs' },
  create: { simple: 'SIMPLE_MODE.md#create', advanced: 'ADVANCED_MODE.md#create' },
  settings: { simple: 'SIMPLE_MODE.md#settings', advanced: 'ADVANCED_MODE.md#settings' },
};

/** "Where am I / what do I do next": one sentence per area, shown under the area title until dismissed. Home and Live
 *  already lead with their own next step, so they have none. */
export const AREA_NEXT: Partial<Record<GuideArea, string>> = {
  // (clarity: most readers have no stream running yet, so these never say "your stream" as if one were)
  me: 'Click an avatar to wear it. It switches right away, here and in OBS.',
  live: 'Turn on your camera, then look at the screen. Your avatar copies you.',
  room: 'Press Change room and pick one. It switches right away, here and in OBS.',
  show: 'Pick Talk, React or Gaming first. Then place your cams and chat.',
  chat: 'Connect your chat once. Messages and alerts then show in your room.',
  games: 'Pick a game card to start. Friends in your party can play too.',
  friends: 'Friends join with one click. Only you, the host, set it up once.',
  stream: 'Copy the OBS link. In OBS, add it as a Browser Source.',
  create: 'Say how you use AI. We show you each step from there.',
  settings: 'You rarely need this. Change things here when a guide says so.',
};

export type ChoiceId = 'golive' | 'model' | 'room' | 'invite';
export interface Choice { id: ChoiceId; icon: string; title: string; line: string; time: string;
  /** on a phone (src/mobile/device.ts): other words, or not offered at all (it needs a PC) */
  phone?: { title?: string; line?: string; hide?: boolean } }
/** The "What do you want to do?" home: four giant choices, the first one is the big green one. */
export const CHOICES: Choice[] = [
  { id: 'golive', icon: 'live', title: 'Go live now', line: 'Set up your camera, avatar and OBS. You go live from OBS when you’re ready.', time: 'About 5 minutes',
    phone: { title: 'Go live from this phone', line: 'Your avatar fills the screen. Then share your screen in TikTok, YouTube or Twitch.' } },
  { id: 'model', icon: 'me', title: 'Use my own model', line: 'Bring your VRoid, VRM or other 3D model. We set it up for you.', time: 'About 3 minutes',
    phone: { line: 'Your Pro2D model, PNGTuber pictures, or a 2D model from another app. Pick its .zip or its files.' } },
  { id: 'room', icon: 'room', title: 'Pick a room', line: 'Choose a 3D place to stream from. You can switch any time, even mid-stream.', time: 'About 1 minute' },
  { id: 'invite', icon: 'friends', title: 'Invite a guest', line: 'Bring a friend onto your show with one link.', time: 'About 2 minutes',
    phone: { hide: true } },
];

export interface TourStep { id: string; sel: string[]; title: string; text: string; area?: GuideArea }
/** The guided tour: one spotlight + one sentence per step. Steps whose target is not on screen are skipped. */
export const TOUR: TourStep[] = [
  { id: 'rail', sel: ['#tabs'], title: 'The parts of the studio', text: 'Click one to go there. Home is always at the top.', area: 'home' },
  { id: 'next', sel: ['.hm-head', '.hm-cta'], title: 'Your next step', text: 'Home always says the one thing to do next. Press the green button.', area: 'home' },
  { id: 'lights', sel: ['.hm-board'], title: 'What’s working', text: 'Green means working. Grey has a button that fixes it.', area: 'home' },
  // (clarity: this window is not "what viewers see": it has your camera self-view, and OBS adds your room)
  { id: 'stage', sel: ['#viewport'], title: 'Your studio view', text: 'Only you see this window. Viewers see your avatar once you stream from OBS.' },
  { id: 'chips', sel: ['.tb-chips'], title: 'Quick status', text: 'Camera, mic, OBS and room. Click one to fix it.' },
  { id: 'mode', sel: ['#topbar .seg'], title: 'Simple or Advanced', text: 'Simple shows the basics. Stay on Simple to start.' },
  { id: 'help', sel: ['.gd-help'], title: 'Stuck? Press Help', text: 'It opens the guide for the screen you’re on.' },
];

export const STORE = {
  home: 'vtp.guide.home',        // 'done' once the first-run home was answered or skipped
  tour: 'vtp.guide.tour',        // 'done' | 'skipped'
  next: 'vtp.guide.next',        // JSON list of areas whose "next" line was dismissed
} as const;
