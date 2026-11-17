// Studio → local server Discord bridge (server/routes/discord.ts). The host session token never reaches the page.
import type { DiscordIdentity } from '../../shared/types.ts';
import type { Party } from '../party.ts';

export interface DiscordStatus {
  configured: boolean; relayUrl: string; clientId: string; redirectUri: string;
  user: DiscordIdentity | null; signedIn: boolean; sessionExp: number;
  autoApprove: boolean; relayOnly: boolean; guildId: string; roleIds: string[]; channelId: string;
  bans: { id: string; name: string }[]; trustedRelays: string[];
  /** "Claim your relay": signed in with Discord, the relay now wants the setup window's claim code. */
  claim?: { name: string } | null;
}
export interface GuildChannels { id: string; name: string; channels: { id: string; name: string }[] }

async function j<T>(r: Response): Promise<T> {
  const b = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(b.error ?? `${r.status}`);
  return b;
}
const post = (url: string, body?: unknown) => fetch(url, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

export const discord = {
  status: () => fetch('/api/discord/status', { cache: 'no-store' }).then((r) => j<DiscordStatus>(r)),
  save: (patch: Partial<DiscordStatus> & { trustRelay?: string; authorizeUrl?: string }) =>
    fetch('/api/discord/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).then((r) => j<DiscordStatus>(r)),
  /** Opens Discord sign-in in a popup (loopback redirect back to this PC's server). */
  login: () => window.open('/api/discord/login', 'vtp-discord', 'width=520,height=780'),
  logout: () => post('/api/discord/logout').then((r) => j<DiscordStatus>(r)),
  /** Type the relay setup window's claim code: the first person who does becomes the relay's host. */
  claim: (code: string) => post('/api/discord/claim', { code }).then((r) => j<DiscordStatus>(r)),
  channels: () => fetch('/api/discord/channels', { cache: 'no-store' }).then((r) => j<{ guilds: GuildChannels[]; bot: boolean }>(r)),
  createRoom: (o: { channelId?: string; post: boolean }) => post('/api/discord/room', o).then((r) => j<{ roomId: string; ticket: string; joinUrl: string; relay: string; posted: boolean; expiresAt: number }>(r)),
  hostTicket: (roomId: string) => post(`/api/discord/room/${roomId}/ticket`).then((r) => j<{ ticket: string }>(r)).then((b) => b.ticket),
  /** guestlink: mint (or revoke) the no-sign-in interview link for my open room. */
  guestLink: (roomId: string, o: { max?: number; minutes?: number; revoke?: boolean }) => post(`/api/discord/room/${roomId}/guestlink`, o).then((r) => j<{ url?: string; discordUrl?: string; expiresAt?: number; max?: number; minutes?: number; ok?: boolean }>(r)),
  ban: (id: string, name: string, remove = false) => post('/api/discord/ban', { id, name, remove }).then((r) => j<DiscordStatus>(r)),
};

/** Host: create a room on the relay (the bot posts the invite if a channel is set) and go live. */
export async function goLive(party: Party, st: DiscordStatus, o: { channelId?: string; post: boolean }) {
  party.autoApprove = st.autoApprove;
  party.relayOnly = st.relayOnly;
  const room = await discord.createRoom(o);
  await party.hostDiscord({ relay: room.relay, roomId: room.roomId, ticket: room.ticket, joinUrl: room.joinUrl, refresh: () => discord.hostTicket(room.roomId) });
  return room;
}

/** Parse a pasted join link (http://127.0.0.1:5191/join#relay=…&t=…). */
export function parseJoinLink(s: string): { relay: string; ticket: string } | null {
  try {
    const u = new URL(s.trim());
    const q = new URLSearchParams(u.hash.slice(1));
    const relay = q.get('relay'), ticket = q.get('t');
    return relay && ticket ? { relay, ticket } : null;
  } catch { return null; }
}

export const avatarUrl = (d: DiscordIdentity | null | undefined) => {
  if (!d || !/^\d{5,25}$/.test(d.id)) return null;
  if (d.avatar && /^(a_)?[a-f0-9]{8,40}$/.test(d.avatar)) return `https://cdn.discordapp.com/avatars/${d.id}/${d.avatar}.png?size=64`;
  // no custom picture: Discord's own default avatar (what Discord itself shows), not a generic letter
  try { return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(d.id) >> 22n) % 6n)}.png`; } catch { return null; }
};
