// "Set up my chat & stream" (lane stream-setup): the pure part of the guided set-up, shared by the studio wizard
// (src/ui/streamSetup/*), the helper's own key page (server/chat/connectPage.ts) and tools/stream_setup_unit.ts.
//
// What it knows, in plain words for someone who has never set up a stream:
//   * every platform VTube Pro can read (shared/chat.ts LIVE_PLATFORMS) and the SIMPLEST real way to connect it
//     (a channel name for Twitch / Kick, a channel link for YouTube, the Live Stream key for Rumble, the TikFinity app
//     for TikTok) — exactly what server/chat/* supports, nothing more;
//   * how to read what the user typed (a name, a link, a pasted URL) into the config the server expects;
//   * the "I can see your chat ✔" verdict: the connector's real state + whether a REAL message from that platform
//     has arrived, turned into one friendly title + one line + a way out;
//   * which alerts each platform sends (follows / subs / gifts / raids / tips) and which test event shows each one;
//   * the steps and how far the user got (for a badge / "2 of 4 done").
// Nothing here talks to a network, a platform or the DOM.
import type { ChatEvent, ChatPlatformStatus, ChatStatus, LivePlatform, SceneChatState } from './chat.ts';

// ---------------------------------------------------------------- platforms
export type Ask = 'channel' | 'link' | 'key' | 'app';
export interface PlatformInfo {
  id: LivePlatform;
  name: string;
  /** Brand colour (tiles, the chat preview). */
  color: string;
  /** What the user gives us. */
  ask: Ask;
  /** The tile's one line: what this needs. */
  need: string;
  /** Input label + placeholder (no input for 'app'). */
  label: string;
  placeholder: string;
  /** One sentence under the input. */
  hint: string;
  /** The value is a secret (typed only on this computer, never on a website). */
  secret: boolean;
  /** Chat only shows while you are live (no offline chat to test with). */
  liveOnly: boolean;
  /** Where to find the thing we ask for (opened in a new tab). */
  findIt?: { label: string; url: string };
}

export const PLATFORM_INFO: Record<LivePlatform, PlatformInfo> = {
  twitch: {
    id: 'twitch', name: 'Twitch', color: '#9146ff', ask: 'channel', need: 'Just your channel name.',
    label: 'Your Twitch channel name', placeholder: 'yourname', hint: 'Your channel name or your twitch.tv link both work.',
    secret: false, liveOnly: false,
  },
  youtube: {
    id: 'youtube', name: 'YouTube', color: '#ff0033', ask: 'link', need: 'Your channel link. No Google sign-in.',
    label: 'Your YouTube channel', placeholder: '@yourname', hint: 'Your @handle or your channel link both work.',
    secret: false, liveOnly: true,
  },
  kick: {
    id: 'kick', name: 'Kick', color: '#53fc18', ask: 'channel', need: 'Just your channel name.',
    label: 'Your Kick channel name', placeholder: 'yourname', hint: 'Your channel name or your kick.com link both work.',
    secret: false, liveOnly: false,
  },
  rumble: {
    id: 'rumble', name: 'Rumble', color: '#85c742', ask: 'key', need: 'Your Live Stream key from Rumble.',
    label: 'Your Rumble Live Stream link', placeholder: 'Paste the whole link from Rumble', hint: 'It stays on your computer and is never shown again.',
    secret: true, liveOnly: true, findIt: { label: 'Open Rumble’s Live Stream page', url: 'https://rumble.com/account/livestream-api' },
  },
  tiktok: {
    id: 'tiktok', name: 'TikTok', color: '#fe2c55', ask: 'app', need: 'The free TikFinity app on your computer.',
    label: 'Your TikTok name (optional)', placeholder: '@yourname', hint: 'TikFinity passes your TikTok LIVE chat to VTube Pro.',
    secret: false, liveOnly: true, findIt: { label: 'Get TikFinity (free)', url: 'https://tikfinity.zerody.one/' },
  },
};
/** Tile order: the biggest platforms first. */
export const SETUP_PLATFORMS: LivePlatform[] = ['twitch', 'youtube', 'kick', 'rumble', 'tiktok'];

// ---------------------------------------------------------------- reading what the user typed
export interface Parsed { ok: boolean; /** The config patch for PUT /api/chat/config (platform key → fields). */ patch?: Record<string, unknown>; /** What we understood ("twitch.tv/yourname"). */ shown?: string; /** One friendly sentence when !ok. */ error?: string }

const trimAt = (s: string) => s.trim().replace(/^@+/, '');
/** Twitch logins: 4-25 letters, digits or _. */
export function twitchChannel(v: string): string {
  return v.trim().replace(/^https?:\/\/(www\.|m\.)?twitch\.tv\//i, '').replace(/^twitch\.tv\//i, '').split(/[/?#]/)[0].replace(/^@/, '').replace(/[^\w]/g, '').toLowerCase().slice(0, 25);
}
/** Kick slugs: letters, digits, _ and -. */
export function kickChannel(v: string): string {
  return v.trim().replace(/^https?:\/\/(www\.)?kick\.com\//i, '').replace(/^kick\.com\//i, '').split(/[/?#]/)[0].replace(/^@/, '').replace(/[^\w-]/g, '').toLowerCase().slice(0, 60);
}
/** YouTube: @handle, a channel / live / watch link, or a bare name (made into an @handle). */
export function youtubeTarget(v: string): { handle?: string; channelId?: string; videoId?: string } | null {
  const s = v.trim();
  if (!s) return null;
  let m: RegExpExecArray | null;
  if ((m = /youtube\.com\/(@[\w.\-]{3,30})/i.exec(s))) return { handle: m[1] };
  if ((m = /youtube\.com\/channel\/(UC[\w-]{20,})/i.exec(s))) return { channelId: m[1] };
  if ((m = /(?:[?&]v=|youtu\.be\/|\/live\/)([\w-]{11})/i.exec(s))) return { videoId: m[1] };
  if (/^https?:\/\//i.test(s) || /youtube\.com|youtu\.be/i.test(s)) return null;    // a link we can't read
  if ((m = /^@?([\w.\-]{3,30})$/.exec(s))) return { handle: `@${m[1]}` };
  return null;
}
/** Rumble: the key, or the whole Live Stream link (…/-livestream-api/get-data?key=XXXX). Same rule as the server. */
export function rumbleKeyOf(v: string): string {
  const m = /[?&]key=([^&\s#]+)/.exec(v);
  let k = v.trim();
  if (m) { try { k = decodeURIComponent(m[1]); } catch { k = m[1]; } }
  return k.replace(/[^\w\-.~]/g, '').slice(0, 300);
}

export function parseInput(p: LivePlatform, raw: string): Parsed {
  const v = raw.trim();
  switch (p) {
    case 'twitch': {
      const c = twitchChannel(v);
      if (!v) return { ok: false, error: 'Type your Twitch channel name first.' };
      if (c.length < 3) return { ok: false, error: 'That doesn’t look like a Twitch name. Check the spelling.' };
      return { ok: true, patch: { twitch: { enabled: true, channel: c } }, shown: `twitch.tv/${c}` };
    }
    case 'kick': {
      const c = kickChannel(v);
      if (!v) return { ok: false, error: 'Type your Kick channel name first.' };
      if (c.length < 2) return { ok: false, error: 'That doesn’t look like a Kick name. Check the spelling.' };
      return { ok: true, patch: { kick: { enabled: true, channel: c } }, shown: `kick.com/${c}` };
    }
    case 'youtube': {
      if (!v) return { ok: false, error: 'Paste your YouTube @handle or channel link first.' };
      const t = youtubeTarget(v);
      if (!t) return { ok: false, error: 'We can’t read that link. Try your @handle instead.' };
      const handle = t.handle ?? '', channelId = t.channelId ?? '', videoId = t.videoId ?? '';
      // the server reads `handle` as a link too: send the cleaned value there and clear the other two
      return { ok: true, patch: { youtube: { enabled: true, handle: handle || (channelId ? `https://www.youtube.com/channel/${channelId}` : `https://youtu.be/${videoId}`), channelId: '', videoId: '' } },
        shown: handle ? `youtube.com/${handle}` : channelId ? 'your YouTube channel' : 'this live stream' };
    }
    case 'rumble': {
      if (!v) return { ok: false, error: 'Paste your Live Stream link from Rumble first.' };
      const k = rumbleKeyOf(v);
      if (k.length < 12) return { ok: false, error: 'That isn’t the whole link. Copy it again from Rumble.' };
      return { ok: true, patch: { rumble: { enabled: true, apiKey: k } }, shown: 'your Rumble channel' };
    }
    case 'tiktok': {
      const u = trimAt(v).replace(/^https?:\/\/(www\.)?tiktok\.com\/@?/i, '').replace(/\/live.*$/i, '').replace(/[^\w.]/g, '').slice(0, 40);
      return { ok: true, patch: { tiktok: { enabled: true, user: u, bridge: '' } }, shown: u ? `@${u} on TikTok` : 'TikTok' };
    }
  }
}

// ---------------------------------------------------------------- "I can see your chat ✔"
/** off = not set up · connecting · ok = connected, no message seen yet · seen = a real message arrived · wait = set up,
 *  shows when you go live · bad = a problem the user can fix. */
export type Light = 'off' | 'connecting' | 'ok' | 'seen' | 'wait' | 'bad';
export interface Verdict { light: Light; title: string; line: string; fix?: 'retype' | 'retry' | 'app' | 'key' }

/** Did a real (non-test) message or event from this platform arrive? */
export function seenReal(p: LivePlatform, events: readonly ChatEvent[], since = 0): boolean {
  return events.some((e) => e.platform === p && !e.test && !e.cue && (e.kind === 'chat' || e.kind === 'system' || e.kind === 'finance') && e.ts >= since);
}

/** The connector's own words → one kind sentence + what to do. Never shows raw errors. */
export function friendlyError(p: LivePlatform, detail: string): Verdict {
  const d = (detail || '').toLowerCase();
  const name = PLATFORM_INFO[p].name;
  if (/no channel|no api key|not configured|no channel configured/.test(d)) return { light: 'bad', title: p === 'rumble' ? 'Your Rumble link is missing' : 'Your channel name is missing', line: p === 'rumble' ? 'Paste your Live Stream link, then press Connect.' : 'Type it in, then press Connect.', fix: p === 'rumble' ? 'key' : 'retype' };
  if (/suspend|banned/.test(d)) return { light: 'bad', title: `${name} says this channel is suspended`, line: 'Check the name, or try another channel.', fix: 'retype' };
  if (/404|not found|does not exist|no such|unknown channel|channel.*missing/.test(d)) return { light: 'bad', title: 'We couldn’t find that channel', line: 'Check the spelling, then try again.', fix: 'retype' };
  if (p === 'rumble' && /401|403|key|unauthori|forbidden/.test(d)) return { light: 'bad', title: 'Rumble didn’t accept that link', line: 'Copy the whole link again from Rumble.', fix: 'key' };
  if (p === 'tiktok' && /bridge|tikfinity|local ws/.test(d)) return { light: 'bad', title: 'We can’t see TikFinity', line: 'Open TikFinity on this computer, then try again.', fix: 'app' };
  if (/timeout|timed out|enotfound|econn|network|fetch failed|socket|getaddrinfo|http 5\d\d/.test(d)) return { light: 'bad', title: `We can’t reach ${name} right now`, line: 'Check your internet, then try again.', fix: 'retry' };
  return { light: 'bad', title: 'Something went wrong', line: 'Try again. If it keeps happening, press Help.', fix: 'retry' };
}

export function verdict(p: LivePlatform, st: ChatPlatformStatus | undefined, events: readonly ChatEvent[] = []): Verdict {
  const info = PLATFORM_INFO[p];
  if (!st || !st.enabled || st.state === 'off') return { light: 'off', title: 'Not connected yet', line: info.need };
  if (st.state === 'error') return friendlyError(p, st.detail);
  if (seenReal(p, events)) return { light: 'seen', title: 'I can see your chat ✔', line: `Messages from ${info.name} now show on your stream.` };
  if (st.state === 'connecting') return { light: 'connecting', title: `Connecting to ${info.name}…`, line: 'This takes a few seconds.' };
  if (st.state === 'waiting') {
    if (p === 'tiktok') return /ended/i.test(st.detail) ? { light: 'wait', title: 'Ready for your next LIVE', line: 'Your chat shows up when you go live on TikTok.' }
      : { light: 'bad', title: 'We can’t see TikFinity', line: 'Open TikFinity on this computer and connect it to TikTok.', fix: 'app' };
    return { light: 'wait', title: 'Connected ✔', line: `Your ${info.name} chat shows up here when you go live.` };
  }
  // live = connected
  if (p === 'tiktok') return { light: 'ok', title: 'TikFinity is connected ✔', line: 'Your chat shows up when you go live on TikTok.' };
  if (info.liveOnly) return { light: 'ok', title: 'Connected ✔', line: `Say hi in your ${info.name} chat to check.` };
  return { light: 'ok', title: 'Connected ✔', line: `Say hi in your ${info.name} chat. It shows up here.` };
}
/** Green enough to move on: a real message seen, connected, or ready for when you go live. */
export const isGood = (v: Verdict) => v.light === 'seen' || v.light === 'ok' || v.light === 'wait';

// ---------------------------------------------------------------- alerts
export type AlertKind = 'follow' | 'sub' | 'gift' | 'raid' | 'tip';
export const ALERT_KINDS: AlertKind[] = ['follow', 'sub', 'gift', 'raid', 'tip'];
export interface AlertInfo { id: AlertKind; title: string; line: string }
export const ALERT_INFO: Record<AlertKind, AlertInfo> = {
  follow: { id: 'follow', title: 'New followers', line: 'A thank-you line in your chat.' },
  sub: { id: 'sub', title: 'Subs & members', line: 'A big card for every new sub or member.' },
  gift: { id: 'gift', title: 'Gifted subs', line: 'One card for a whole gift, with the gifter’s name.' },
  raid: { id: 'raid', title: 'Raids', line: 'A card when another streamer sends their viewers.' },
  tip: { id: 'tip', title: 'Tips & donations', line: 'Bits, Super Chats, Kicks, Rants and gifts.' },
};
/** yes = sent by the platform · no = the platform doesn't send it (to a chat reader without a sign-in). */
export type Support = 'yes' | 'no';
export const ALERT_SUPPORT: Record<LivePlatform, Record<AlertKind, Support>> = {
  twitch: { follow: 'no', sub: 'yes', gift: 'yes', raid: 'yes', tip: 'yes' },
  youtube: { follow: 'no', sub: 'yes', gift: 'yes', raid: 'no', tip: 'yes' },
  kick: { follow: 'yes', sub: 'yes', gift: 'yes', raid: 'yes', tip: 'yes' },
  rumble: { follow: 'yes', sub: 'yes', gift: 'yes', raid: 'no', tip: 'yes' },
  tiktok: { follow: 'yes', sub: 'yes', gift: 'no', raid: 'no', tip: 'yes' },
};
/** The local test event (POST /api/chat/test {what}) that shows this alert, picked for the user's first platform. */
export function alertTest(kind: AlertKind, platforms: readonly LivePlatform[]): string {
  const first = platforms[0] ?? 'twitch';
  if (kind === 'tip') return ({ twitch: 'bits', youtube: 'superchat', kick: 'kicks', rumble: 'rant', tiktok: 'tiktok' } as const)[first];
  if (kind === 'sub') return first === 'youtube' ? 'member' : 'sub';
  return kind;   // follow · gift · raid
}
/** "Twitch, Kick and Rumble send these." / "Your platforms don't send raids." — for the user's platforms only. */
export function alertWho(kind: AlertKind, platforms: readonly LivePlatform[]): { line: string; any: boolean } {
  const yes = platforms.filter((p) => ALERT_SUPPORT[p][kind] === 'yes');
  const names = (l: readonly LivePlatform[]) => l.map((p) => PLATFORM_INFO[p].name).join(l.length > 2 ? ', ' : ' and ').replace(/, ([^,]*)$/, ' and $1');
  if (!platforms.length) return { line: '', any: true };
  if (yes.length === platforms.length) return { line: platforms.length === 1 ? `${names(yes)} sends these.` : 'All your platforms send these.', any: true };
  if (yes.length) return { line: `${names(yes)} ${yes.length === 1 ? 'sends' : 'send'} these.`, any: true };
  return { line: `${names(platforms)} ${platforms.length === 1 ? 'doesn’t' : 'don’t'} send these.`, any: false };
}

/** Minimum tip that gets a big alert (SceneChatState.minAlert), as four plain choices. */
export const MIN_ALERT_CHOICES: { v: number; label: string }[] = [{ v: 0, label: 'Every tip' }, { v: 1, label: '$1 and up' }, { v: 5, label: '$5 and up' }, { v: 10, label: '$10 and up' }];

// ---------------------------------------------------------------- chat on screen
export type ScreenSpot = 'monitor' | 'buddy' | 'side' | 'none';
export interface SpotInfo { id: ScreenSpot; title: string; line: string; needsRoom: boolean }
export const SPOTS: SpotInfo[] = [
  { id: 'monitor', title: 'On a screen in your room', line: 'A chat screen drops down where the camera sees it.', needsRoom: true },
  { id: 'buddy', title: 'A friend holds it', line: 'A character walks in holding a tablet with your chat.', needsRoom: true },
  { id: 'side', title: 'Beside your game or video', line: 'A tidy chat panel next to what you share.', needsRoom: false },
  { id: 'none', title: 'Not on screen', line: 'Only you see chat, in the Chat Hub.', needsRoom: false },
];
/** Which spot the current scene shows (for the step's selection). */
export function spotOf(st: SceneChatState, dockChat: 'auto' | 'always' | 'off'): ScreenSpot {
  if (st.buddy) return 'buddy';
  if (st.monitor) return 'monitor';
  if (dockChat !== 'off') return 'side';
  return 'none';
}
/** Size presets → SceneChatState.size / font / tablet. */
export const SIZE_CHOICES = [{ id: 's', label: 'Small', size: 0.8, font: 0.85, tablet: 0.85 }, { id: 'm', label: 'Medium', size: 1, font: 1, tablet: 1 }, { id: 'l', label: 'Large', size: 1.3, font: 1.25, tablet: 1.35 }] as const;
export type SizeId = typeof SIZE_CHOICES[number]['id'];
export function sizeOf(st: SceneChatState): SizeId {
  let best: SizeId = 'm', d = Infinity;
  for (const c of SIZE_CHOICES) { const x = Math.abs(c.size - st.size) + Math.abs(c.font - st.font); if (x < d) { d = x; best = c.id; } }
  return best;
}

// ---------------------------------------------------------------- steps
/** Stream title / category: no connector can write them (every connector is read only). The step stays hidden and the
 *  last screen shows a Coming soon pill until a write path exists. */
export const TITLE_SUPPORTED = false;
export type StepId = 'platforms' | 'connect' | 'alerts' | 'screen' | 'title' | 'done';
export const STEPS: { id: StepId; title: string; next: string }[] = [
  { id: 'platforms', title: 'Your platforms', next: 'Pick where you stream.' },
  { id: 'connect', title: 'Connect', next: 'Connect each platform and check your chat.' },
  { id: 'alerts', title: 'Alerts', next: 'Try an alert and pick which ones show.' },
  { id: 'screen', title: 'Chat on screen', next: 'Pick where viewers see your chat.' },
  { id: 'title', title: 'Title & category', next: 'Set your stream title.' },
  { id: 'done', title: 'You’re ready', next: 'You’re ready to go live.' },
];
export const visibleSteps = () => STEPS.filter((s) => s.id !== 'title' || TITLE_SUPPORTED);

export interface SetupProgress { platforms: LivePlatform[]; connected: LivePlatform[]; alertsSeen: boolean; screenPicked: boolean }
/** How far the set-up is: for a tab badge ("Chat: 2 of 4 done") and where the wizard opens. */
export function setupSummary(status: ChatStatus | null, events: readonly ChatEvent[], marks: { alerts?: boolean; screen?: boolean } = {}):
  { ready: boolean; done: number; of: number; firstOpen: StepId; platforms: LivePlatform[]; good: LivePlatform[] } {
  const on = status ? SETUP_PLATFORMS.filter((p) => status.platforms[p]?.enabled) : [];
  const good = on.filter((p) => isGood(verdict(p, status!.platforms[p], events)));
  const steps = { platforms: on.length > 0, connect: on.length > 0 && good.length === on.length, alerts: !!marks.alerts, screen: !!marks.screen };
  const done = Object.values(steps).filter(Boolean).length;
  const firstOpen: StepId = !steps.platforms ? 'platforms' : !steps.connect ? 'connect' : !steps.alerts ? 'alerts' : !steps.screen ? 'screen' : 'done';
  return { ready: done === 4, done, of: 4, firstOpen, platforms: on, good };
}

/** Every user-facing sentence of this module (tools/stream_setup_unit.ts runs them through the voice rules). */
export function allWords(): string[] {
  const out: string[] = [];
  for (const p of SETUP_PLATFORMS) { const i = PLATFORM_INFO[p]; out.push(i.need, i.hint); }
  for (const k of ALERT_KINDS) out.push(ALERT_INFO[k].line);
  for (const s of SPOTS) out.push(s.line);
  for (const s of STEPS) out.push(s.next);
  return out;
}
