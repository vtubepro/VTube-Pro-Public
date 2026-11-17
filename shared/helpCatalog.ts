// The in-app Help catalog: which docs/*.md files the studio's Help viewer bundles (src/ui/help/helpViewer.ts), how
// they are grouped, and which section each studio area's "?" button opens. Pure data. Every file listed here must exist
// in docs/ (the viewer bundles them).

export interface HelpDoc { file: string; title: string; blurb: string; group: HelpGroup }
export type HelpGroup = 'Start here' | 'Using the studio' | 'Avatars & rooms' | 'Technical reference';
export const HELP_GROUPS: HelpGroup[] = ['Start here', 'Using the studio', 'Avatars & rooms', 'Technical reference'];

/** Every doc the Help viewer bundles, in reading order. Files that are missing from a build are simply left out. */
export const HELP_DOCS: HelpDoc[] = [
  { file: 'README.md', title: 'All guides', blurb: 'The index: every guide and who it is for', group: 'Start here' },
  { file: 'QUICK_START.md', title: 'Quick Start', blurb: 'From download to live in about 10 minutes', group: 'Start here' },
  { file: 'TUTORIALS.md', title: 'Tutorials', blurb: 'Step by step: setup, your own model, OBS, outfits, rooms, going live, guests, chat, AI', group: 'Start here' },
  { file: 'SIMPLE_MODE.md', title: 'Simple mode', blurb: 'Every area of the studio, button by button', group: 'Using the studio' },
  { file: 'ADVANCED_MODE.md', title: 'Advanced mode', blurb: 'Every setting, what it does and when to touch it', group: 'Using the studio' },
  { file: 'LIVE_PANEL.md', title: 'The Live panel', blurb: 'Everything you change mid-show: cameras, people, voice, polls, Stream Deck', group: 'Using the studio' },
  { file: 'GO_LIVE.md', title: 'Going live', blurb: 'The Go Live button: nothing but your click starts a stream; keys, the setup check, End show', group: 'Using the studio' },
  { file: 'BRB_SCREENS.md', title: 'BRB screens', blurb: 'Be right back: fade to black, your card, guests muted, your own picture or video', group: 'Using the studio' },
  { file: 'GUESTS_AND_PARTIES.md', title: 'Guests & parties', blurb: 'Invite links, the green room, guest voice, parties, TURN, fixes', group: 'Using the studio' },
  { file: 'HOSTING_SETUP.md', title: 'Hosting setup', blurb: 'Your own invite server (Cloudflare) and your own Discord app, step by step', group: 'Using the studio' },
  { file: 'STREAM_DECK.md', title: 'Stream Deck & controllers', blurb: 'Buttons, hotkeys and the HTTP / WebSocket deck', group: 'Using the studio' },
  { file: 'STREAM_EXTRAS.md', title: 'Stream extras', blurb: 'Redeems & reactions, throw, stickers, keys & pads, emote rain, your own emote, sounds & effects, AI co-host, PNGTuber import, VTube Studio plugins', group: 'Using the studio' },
  { file: 'CHAT_HUB.md', title: 'Chat & stream', blurb: 'Connect your chat, try your alerts, put chat on screen; the Chat Hub', group: 'Using the studio' },
  { file: 'MULTICAM.md', title: 'Two webcams', blurb: 'A second camera for stereo face, mouth close-up or hands', group: 'Using the studio' },
  { file: 'VOICE.md', title: 'Voice & lip sync', blurb: 'Noise filter, gate, sensitivity and the voice front end', group: 'Using the studio' },
  { file: 'LIP_SYNC.md', title: 'Best lip sync for me', blurb: 'Pick Basic, Good or Best for your model and computer, then test it', group: 'Using the studio' },
  { file: 'SOUND.md', title: 'Sound on your stream', blurb: 'The audio mixer: guests, read-aloud and show sounds play in the studio; how OBS hears them', group: 'Using the studio' },
  { file: 'PHONE_TRACKING.md', title: 'Use your phone for face tracking', blurb: 'iPhone and Android apps, phone webcams, one-click setup, firewall help', group: 'Using the studio' },
  { file: 'TWO_PC_STREAMING.md', title: 'Streaming from a second PC', blurb: 'OBS on a stream PC: connect it with a code, draw there or here, firewall help', group: 'Using the studio' },
  { file: 'AVATARS_SIMPLE.md', title: 'Avatars: the easy way', blurb: 'Import any model, AI-create, outfits, size, testing', group: 'Avatars & rooms' },
  { file: 'ENVIRONMENTS_SIMPLE.md', title: 'Rooms: the easy way', blurb: 'Pick, add, describe and arrange rooms', group: 'Avatars & rooms' },
  { file: 'PRO2D.md', title: 'Pro2D: 2D avatars', blurb: 'Make one from your own PSD or pictures: keys, sliders, outfits, and moving a model over from another 2D app', group: 'Avatars & rooms' },
  { file: 'MOVING_ROOMS.md', title: 'Moving rooms', blurb: 'Rooms with a world outside or that travel: picking, cameras, tips; how to build one', group: 'Avatars & rooms' },
  { file: 'AVATARS_ADVANCED.md', title: 'Avatars by hand', blurb: 'Formats, rig, face shapes, springs, costumes (in depth)', group: 'Avatars & rooms' },
  { file: 'ENVIRONMENTS_ADVANCED.md', title: 'Rooms by hand', blurb: 'The room contract as a Blender tutorial (in depth)', group: 'Avatars & rooms' },
  { file: 'MAKE_WITH_CLAUDE_OR_CODEX.md', title: 'Make a model with Claude or Codex', blurb: 'Step by step with Opus 5.5 or GPT-6.1: connect, prompts to copy, what to approve', group: 'Avatars & rooms' },
  { file: 'ARTIST_AVATARS.md', title: 'For 3D artists: avatars', blurb: 'Characters, outfits and accessories, step by step in VRoid or Blender', group: 'Avatars & rooms' },
  { file: 'ARTIST_ENVIRONMENTS.md', title: 'For 3D artists: rooms', blurb: 'Build a room step by step: Blender, places, cameras, light, testing', group: 'Avatars & rooms' },
  { file: 'AI_CONNECT.md', title: 'AI connectors', blurb: 'Let Claude, ChatGPT and other AI apps drive the studio', group: 'Technical reference' },
  { file: 'INTEGRATION.md', title: 'Phone & external tracking', blurb: 'VTube Studio phone, iFacialMocap, VMC', group: 'Technical reference' },
  { file: 'GPU_TRACKING.md', title: 'GPU tracking (RTX)', blurb: 'Audio2Face, Maxine and RTMW sidecars and what they cost', group: 'Technical reference' },
];

/** Where a studio area's "?" button points: the Simple view and the Advanced view of each area. */
export const AREA_HELP: Record<string, { simple: string; advanced: string }> = {
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

/** The "?" of each Live > Stream extras screen (src/rules/extrasDrawer.ts opens it; the key is the panel id registered with registerB16Panel),
 *  and of the two beta.16 features that live outside that list: the PNGTuber import screen and the VTube Studio plugins switch (Track tab).
 *  tools/docs_unit.ts checks every anchor and that every registered panel has an entry. */
export const EXTRAS_HELP: Record<string, string> = {
  rules: 'STREAM_EXTRAS.md#redeems--reactions',
  throw: 'STREAM_EXTRAS.md#throw--bonk',
  items: 'STREAM_EXTRAS.md#stickers--items',
  'keys-pads': 'STREAM_EXTRAS.md#keys--pads',
  'emote-rain': 'STREAM_EXTRAS.md#emote-rain',
  'record-emote': 'STREAM_EXTRAS.md#record-my-own-emote',
  soundfx: 'STREAM_EXTRAS.md#sounds--screen-effects',
  cohost: 'STREAM_EXTRAS.md#ai-co-host',
  pngtuber: 'STREAM_EXTRAS.md#bring-your-pngtuber-over',
  vts: 'STREAM_EXTRAS.md#vtube-studio-plugins',
};
/** The "?" on the Stream extras card list itself. */
export const EXTRAS_HELP_INDEX = 'STREAM_EXTRAS.md#open-stream-extras';

/** The "?" of the Party area's "Be a guest on someone else’s show" card (src/ui/guestFeedCard.ts). */
export const GUEST_FEED_HELP = 'GUESTS_AND_PARTIES.md#be-a-guest-on-someone-elses-show';

/** Help for a guided set-up (wizard id → doc#section). */
export const WIZARD_HELP: Record<string, string> = {
  firstRun: 'QUICK_START.md',
  room: 'SIMPLE_MODE.md#room',
  chat: 'CHAT_HUB.md#set-up-my-chat--stream',
  react: 'SIMPLE_MODE.md#the-react-screen',
  phone: 'INTEGRATION.md',
  multicam: 'MULTICAM.md',
  multiplayer: 'HOSTING_SETUP.md',
  guestFeed: GUEST_FEED_HELP, // (not a wizard: listed here so tools/docs_unit.ts checks the anchor)
};

/** The multiplayer setup helper's per-step "Read the guide" links (src/ui/wizards.ts) → docs/HOSTING_SETUP.md sections.
 *  tools/hosting_unit.ts and tools/docs_unit.ts check every anchor. */
export const HOSTING_HELP = {
  overview: 'HOSTING_SETUP.md',
  signIn: 'HOSTING_SETUP.md#how-sign-in-works',
  discord: 'HOSTING_SETUP.md#step-2-make-your-own-discord-app',
  cloudflare: 'HOSTING_SETUP.md#step-1-make-a-free-cloudflare-account',
  relay: 'HOSTING_SETUP.md#step-3-put-your-invite-server-online',
  paste: 'HOSTING_SETUP.md#step-4-tell-the-studio-and-connect',
  turn: 'HOSTING_SETUP.md#step-5-let-every-guest-connect',
  privateLinks: 'HOSTING_SETUP.md#private-links',
  troubleshooting: 'HOSTING_SETUP.md#troubleshooting',
} as const;

/** "FILE.md#anchor" → [file, anchor]. */
export function splitTarget(target: string): [string, string] {
  const i = target.indexOf('#');
  return i < 0 ? [target, ''] : [target.slice(0, i), target.slice(i + 1)];
}
