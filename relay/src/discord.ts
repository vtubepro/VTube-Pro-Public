// The few Discord REST calls the relay needs. Access tokens are used once and dropped (never stored / logged).
import { discordApi, discordClientId, type Env } from './env.ts';

export interface DiscordUser { id: string; name: string; username: string; avatar: string | null }

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`discord ${r.status}`);
  return (await r.json()) as T;
}

/** Authorization code → access token (confidential client: the secret stays in the Worker). */
export async function exchangeCode(env: Env, code: string, redirectUri: string, verifier?: string): Promise<string> {
  const body = new URLSearchParams({ client_id: discordClientId(env), client_secret: String(env.DISCORD_CLIENT_SECRET ?? '').trim(), grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  if (verifier) body.set('code_verifier', verifier);
  const r = await fetch(`${discordApi(env)}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const t = await j<{ access_token?: string; token_type?: string }>(r);
  if (!t.access_token) throw new Error('no token');
  return t.access_token;
}

export async function me(env: Env, token: string): Promise<DiscordUser> {
  const u = await j<{ id: string; username: string; global_name?: string | null; avatar?: string | null }>(await fetch(`${discordApi(env)}/users/@me`, { headers: { authorization: `Bearer ${token}` } }));
  if (!/^\d{5,25}$/.test(String(u.id))) throw new Error('bad user');
  return { id: String(u.id), username: String(u.username ?? '').slice(0, 40), name: String(u.global_name || u.username || 'Discord user').slice(0, 40), avatar: typeof u.avatar === 'string' && /^(a_)?[a-f0-9]{8,40}$/.test(u.avatar) ? u.avatar : null };
}

/** Is the user in the guild (and, if roles are given, holding one of them)? Needs scope guilds.members.read. */
export async function memberOk(env: Env, token: string, guildId: string, roleIds: string[]): Promise<boolean> {
  const r = await fetch(`${discordApi(env)}/users/@me/guilds/${guildId}/member`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) return false;
  const m = (await r.json()) as { roles?: string[] };
  if (!roleIds.length) return true;
  const have = new Set((m.roles ?? []).map(String));
  return roleIds.some((id) => have.has(id));
}

// ---------------------------------------------------------------- bot
const bot = (env: Env) => ({ authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json' });

export async function botGuildChannels(env: Env): Promise<{ id: string; name: string; channels: { id: string; name: string }[] }[]> {
  if (!env.DISCORD_BOT_TOKEN) return [];
  const guilds = await j<{ id: string; name: string }[]>(await fetch(`${discordApi(env)}/users/@me/guilds`, { headers: bot(env) }));
  const out = [];
  for (const g of guilds.slice(0, 25)) {
    try {
      const ch = await j<{ id: string; name: string; type: number }[]>(await fetch(`${discordApi(env)}/guilds/${g.id}/channels`, { headers: bot(env) }));
      out.push({ id: String(g.id), name: String(g.name).slice(0, 100), channels: ch.filter((c) => c.type === 0 || c.type === 5).map((c) => ({ id: String(c.id), name: String(c.name).slice(0, 100) })) });
    } catch { /* no access */ }
  }
  return out;
}

/** invite-experience: brand lime and a quiet footer on the relay bot's invite card. */
const BRAND = 0x7bd88f;
const FOOT = { text: 'VTube Pro · Beta · this invite stops working when the show ends' };
export interface InviteView { hostName: string; joinUrl: string; members: string[]; expiresAt: number; ended?: boolean }
function inviteBody(v: InviteView) {
  const names = v.members.length ? v.members.map((n) => `• ${n.replace(/[*_`~|>@#\\]/g, '')}`).join('\n') : '—';
  if (v.ended) {
    return { embeds: [{ title: `⏹ ${v.hostName}'s VTube Pro party has ended`, description: 'Thanks for coming! 💚', color: BRAND, footer: FOOT }], components: [] };
  }
  return {
    embeds: [{
      title: `🎙 ${v.hostName} is live in VTube Pro`,
      // invite-experience: 3 plain steps, brand colour, a quiet footer
      description: '**1.** Click **Join** below and sign in with Discord.\n' +
        '**2.** Pick **Open VTube Pro** to bring your avatar, or **Join with my webcam**. Nothing to install.\n' +
        '**3.** The host lets you in. Talk in voice chat as usual.\n\n' +
        '-# Your model is shared only for this session, is never saved on anyone\'s PC and can\'t be exported.',
      color: BRAND,
      footer: FOOT,
      fields: [{ name: `In the party (${v.members.length}/8)`, value: names.slice(0, 1000) }, { name: 'Invite expires', value: `<t:${Math.floor(v.expiresAt / 1000)}:R>` }],
    }],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Join', url: v.joinUrl }] }],
    allowed_mentions: { parse: [] },
  };
}
export async function postInvite(env: Env, channelId: string, v: InviteView): Promise<string | null> {
  if (!env.DISCORD_BOT_TOKEN || !/^\d{5,25}$/.test(channelId)) return null;
  const r = await fetch(`${discordApi(env)}/channels/${channelId}/messages`, { method: 'POST', headers: bot(env), body: JSON.stringify(inviteBody(v)) });
  if (!r.ok) return null;
  return String(((await r.json()) as { id: string }).id);
}
export async function editInvite(env: Env, channelId: string, messageId: string, v: InviteView) {
  if (!env.DISCORD_BOT_TOKEN) return;
  await fetch(`${discordApi(env)}/channels/${channelId}/messages/${messageId}`, { method: 'PATCH', headers: bot(env), body: JSON.stringify(inviteBody(v)) }).catch(() => {});
}
