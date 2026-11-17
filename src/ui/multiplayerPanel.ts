// Multiplayer panel (OBS tab): Discord party (connect, go live / post invite, allow-list, approvals, members with
// Discord names + link quality, kick / ban), guest status + avatar-sharing consent, and the original invite codes
// under "Advanced". Setup steps: docs/MULTIPLAYER_DISCORD.md.
import type { App } from '../app.ts';
import type { SharePolicy } from '../../shared/types.ts';
import type { Delivery, MemberView } from '../party.ts';
import { avatarUrl, discord, goLive, parseJoinLink, type DiscordStatus, type GuildChannels } from '../net/discordClient.ts';
import { peekTicket } from '../net/relayClient.ts';
import { CUSTODY_NOTE, askJoinConsent, policyOptions } from './joinConsent.ts';
import { button, h, rerender, section, select, toast, toggle } from './dom.ts';
import { safeAvatar, safeName } from './streamSafe.ts';
import { TRIS_MAX, TRIS_WARN, fmtTris, trisOfWhy } from '../../shared/modelStats.ts';
import { TV_BAG, sanitizeTvBag, tvLabel } from '../../shared/tv.ts';
import { spoutHealth } from '../../shared/spout.ts';
import { HOST_KEY } from '../../shared/scene.ts';
import { tvAppearSection, tvHostControls } from './tvSetup.ts';
import { guestLinkBox } from './guestLink.ts';
import { openHelp } from './help/helpViewer.ts';
import { shareLink } from '../net/shareLink.ts';
import { PRIVATE_LINKS_HELP, checkClientId, checkRelayUrl, linkPrivacy, privacyWarning } from '../../shared/relaySetup.ts';
import { partyVoiceGuest } from './partyVoicePanel.ts';
import { xfLine, xfWhyText } from '../../shared/partyXfer.ts';
import { GUEST_FEED_HELP } from '../../shared/helpCatalog.ts';
import { GF_TITLE, copyText, mountGuestFeedCard } from './guestFeedCard.ts';

/** Choices for the host's polycount limit (Multiplayer → Max triangles per avatar). */
const TRIS_CHOICES = [20_000, 37_000, 50_000, 70_000, 100_000, 150_000, 200_000, 300_000, 500_000];

/** The party version of MY avatar in its own window (output.html?partyLod=1: the file parties get, animated by my tracking). */
export function previewPartyLod(avatarId: string, max: number, costume: string | null) {
  window.open(`/output.html?avatar=${encodeURIComponent(avatarId)}&partyLod=1&max=${max}&costume=${encodeURIComponent(costume ?? '')}&focus=full`, 'vtp-party-lod', 'width=720,height=900');
}

let status: DiscordStatus | null = null;
let channels: { guilds: GuildChannels[]; bot: boolean } | null = null;
let statusErr = '';

function icon(m: { discord?: { id: string; avatar: string | null } | null; name: string }, size = 26) {
  const url = avatarUrl(m.discord as never);
  const st = `width:${size}px;height:${size}px;border-radius:50%;flex:none;`;
  if (url) return h('img', { src: url, alt: '', referrerpolicy: 'no-referrer', style: st });
  const hue = [...m.name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return h('span', { style: `${st}display:grid;place-items:center;background:hsl(${hue} 45% 35%);color:#fff;font-weight:700;font-size:${size * 0.45}px` }, (m.name[0] ?? '?').toUpperCase());
}
const titled = (b: HTMLElement, t: string) => { b.title = t; return b; };
/** One member's avatar on another member's PC (host view / my own deliveries). */
const deliveryText = (d: Delivery, limit: number) => d.why.startsWith('policy:') || d.why === 'off' ? 'not sent (sharing rule)'
  : xfLine({ st: d.st, kind: 'm', got: d.got, n: d.n, why: d.why, tries: 0, at: 0 }, limit, 'out') || d.st;
const fmtStats = (m: MemberView) => {
  const s = m.stats;
  if (!s) return '';
  if (s.age > 3000) return 'no data';
  return `${s.rtt ? `rtt ${s.rtt} ms · ` : ''}jitter ${s.jitter} ms · loss ${s.loss}% · buffer ${s.delay} ms`;
};

/** greenroom — host: who waits when they join (the waiting guests themselves are managed in Live → People). */
function greenRoomHost(app: App): HTMLElement {
  const P = app.party, G = P.green;
  const waiting = [...P.remotes.keys()].filter((id) => G.hidden(id));
  return h('div', null,
    select('New guests wait in the green room', G.mode, [['link', 'Link guests (default)'], ['all', 'Everyone'], ['off', 'Nobody: straight in']], (v) => G.setMode(v),
      'Waiting guests are connected (you see their camera, mic level and connection in Live → People) but not on the show until you press Bring on'),
    waiting.length ? h('p', { class: 'note' }, `In the green room: ${waiting.map((id) => P.remotes.get(id)?.name ?? 'Guest').join(', ')} — Live → People → Bring on.`) : null);
}
/** greenroom — a VTube Pro app guest: where I am, the host's messages, "I'm ready" + a short message. */
let grDraft = '';
function greenRoomGuest(app: App): HTMLElement | null {
  const P = app.party, G = P.green;
  if (!G.hostKnows) return null;
  const me = G.me;
  const inp = h('input', { type: 'text', maxlength: '100', placeholder: 'Short message to the host (optional)', value: grDraft, onInput: (e: Event) => { grDraft = (e.target as HTMLInputElement).value; } }) as HTMLInputElement;
  const done = (err: string) => { if (err) toast(err, 'warn'); else { grDraft = ''; inp.value = ''; } };
  me.unread = 0;
  return h('div', { style: `margin:8px 0;padding:8px 10px;border-radius:10px;background:${me.wait ? '#1b2a22' : '#2a1618'}` },
    h('p', { style: 'margin:0 0 4px' }, h('b', null, me.wait ? 'You’re in the green room' : 'You’re on the show'),
      me.wait ? ` — ${P.hostInfo?.name ?? 'the host'} brings you on when they’re ready (you’re not on their stream yet).${me.talk ? ' Backstage voice is on.' : ''}` : ''),
    h('div', { class: 'btns tight' },
      button(me.ready ? '✔ Ready (take it back)' : '✋ I’m ready', () => done(G.setReady(!me.ready, inp.value)), me.ready ? 'primary' : undefined),
      inp, button('Send', () => done(G.note(inp.value)))),
    me.msgs.length ? h('details', { open: true }, h('summary', null, `Messages from the host (${me.msgs.length})`),
      ...me.msgs.slice().reverse().map((m) => h('div', { class: 'note' }, `${new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${m.text}`))) : null,
    h('p', { class: 'note' }, P.voice.guestState === 'on' ? 'Muting: the Mute button / hotkey under Voice above.' : 'Muting: your voice goes through Discord, so use Discord’s mute keybind (it works in any window).'));
}

export function multiplayerSection(app: App): HTMLElement {
  const P = app.party;
  const box = h('div');
  const list = h('div');
  const refreshStatus = async () => {
    try { status = await discord.status(); statusErr = ''; } catch (e) { statusErr = (e as Error).message; }
    draw();
  };
  const loadChannels = async () => {
    try { channels = await discord.channels(); } catch (e) { toast(`Channels: ${(e as Error).message}`, 'err'); }
    draw();
  };
  const save = async (patch: Parameters<typeof discord.save>[0]) => {
    try { status = await discord.save(patch); } catch (e) { toast((e as Error).message, 'err', 6000); }
    draw();
  };

  const members = () => {
    if (P.role === 'none') return;
    for (const m of P.view()) {
      const tag = m.me ? ' (you)' : m.host ? ' (host)' : '';
      const why = (w: string, mine: boolean) => w === 'off' ? (mine ? 'NOT sharing your avatar (Share my avatar is off)' : 'avatar not shared — they have “Share my avatar” turned off')
        : w.startsWith('big:') ? `${mine ? 'your' : 'their'} avatar is too big to send (${w.slice(4)} MB, limit 256 MB)`
        : w.startsWith('tris:') ? `${mine ? 'your' : 'their'} model has ${fmtTris(trisOfWhy(w))} triangles — the party limit is ${fmtTris(P.trisLimit)}; ${mine ? 'decimate it or pick a lighter model (or turn on the automatic party version)' : 'they need this update (automatic party version) or a lighter model'}`
          : w === 'load' ? `${mine ? 'your' : 'their'} avatar file couldn’t be read — re-select the avatar`
            : w === 'none' ? (mine ? 'your avatar is still loading' : 'their avatar hasn’t loaded yet')
              : w ? `${mine ? 'not sharing your avatar' : 'avatar not shared'} — ${xfWhyText(w, P.trisLimit)}` : mine ? 'not sharing your avatar' : 'avatar not shared';
      // the resolver's view: "receiving 42 MB / 118 MB", "stalled — retrying (2/5)", "rejected: 214k triangles > 200k limit"
      const xl = xfLine(m.xfer, P.trisLimit, m.me ? 'out' : 'in');
      const moving = !!m.xfer && !['done', 'idle'].includes(m.xfer.st);
      const state = m.me ? (!m.avatar ? why(m.why, true) : P.role === 'guest' && m.xfer?.st === 'done' ? 'sharing your avatar — the host has it ✔' : moving ? `sharing your avatar — ${xl}` : 'sharing your avatar')
        : !m.avatar ? why(m.why, false) : m.ready ? (moving ? `on your OBS · ${xl}` : 'on your OBS') : xl || (m.receiving ? 'receiving avatar…' : 'waiting for avatar');
      const stuck = !m.me && m.avatar && !m.ready && (!m.xfer || ['failed', 'waiting', 'retrying', 'outdated'].includes(m.xfer.st));
      const lipKey = `vtp.mp.lip.${m.discord?.id ?? m.id}`;
      const lip = h('input', { type: 'number', min: '-100', max: '400', step: '10', value: localStorage.getItem(lipKey) || '0', style: 'width:64px', title: 'Lip delay (ms): line their mouth up with their Discord voice',
        onChange: (e: Event) => localStorage.setItem(lipKey, String(Math.max(-100, Math.min(400, Number((e.target as HTMLInputElement).value) || 0)))) });
      const controls = !m.me ? h('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:3px' },
        m.tv ? null : [h('span', { class: 'note', style: 'margin:0' }, 'Lip delay'), lip, h('span', { class: 'note', style: 'margin:0' }, 'ms')],
        m.tv ? null : P.role === 'host' ? titled(button('Ask them to resend', () => P.askResend(m.id)), 'Ask their app to send its avatar again (it also does this by itself when nothing arrives)') : stuck ? button('Ask again', () => P.askResend(m.id)) : null,
        P.role === 'host' ? button('Kick', () => P.kick(m.id), 'danger') : null,
        P.role === 'host' && m.discord ? button('Ban', () => {
          if (!confirm(`Ban ${m.name} from your parties?`)) return;
          P.kick(m.id, true);
          void discord.ban(m.discord!.id, m.name).then((s) => { status = s; draw(); });
        }, 'danger') : null) : null;
      list.append(h('div', { style: 'display:flex;gap:8px;align-items:flex-start;padding:7px 0;border-top:1px solid #ffffff10' },
        icon(m),
        h('div', { style: 'flex:1;min-width:0' },
          h('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap' }, h('b', null, m.name + tag),
            m.discord && /^link[0-9a-f]+$/.test(m.discord.id) ? h('span', { class: 'chip warn', title: 'Joined with your no-sign-in interview link: they typed this name themselves' }, 'link guest · not verified')
              : m.discord ? h('span', { class: 'chip ok', title: m.verified ? 'Discord identity verified by the relay' : 'Discord' }, m.discord.username ? `@${m.discord.username}` : 'Discord ✔') : h('span', { class: 'chip' }, 'invite code'),
            // (data-tick: link stats, transfer progress and "speaking" change every second; the list keeps its
            // rows and only these texts change, instead of the whole list being swapped each second)
            h('span', { 'data-tick': '', style: 'color:#6ee7a0' }, m.speaking ? '● speaking' : ''),
            m.outdated ? h('span', { class: 'chip', style: 'color:#f5c451', title: 'Their VTube Pro is older than yours: avatar transfers can’t be confirmed or resent automatically. Ask them to update.' }, 'older app') : null),
          m.tv ? h('div', { class: 'note', style: 'margin:2px 0 0' }, `${tvLabel(m.tv, (sanitizeTvBag(app.scene.modeBag(TV_BAG)).looks[m.me && P.role === 'host' ? HOST_KEY : m.id]) ?? m.tv.look)} · ${m.me ? 'your picture' : 'their picture'} goes to ${m.share === 'party' ? 'everyone here' : m.share === 'guild' ? 'server members only' : 'the host only'} (live video, never stored)`)
            : h('div', { class: 'note', 'data-tick': '', style: `margin:2px 0 0${m.xfer?.st === 'failed' || m.xfer?.st === 'outdated' ? ';color:#f5a45b' : ''}` }, `🔒 ${m.me ? 'your' : `${m.name}’s`} model · ${state} · ${m.share === 'party' ? 'everyone here' : m.share === 'guild' ? 'server members only' : 'host only'}`),
          m.deliveries.length ? h('div', { class: 'note', 'data-tick': '', style: 'margin:0;font-variant-numeric:tabular-nums' }, `→ ${m.deliveries.map((d) => `${d.name}: ${deliveryText(d, P.trisLimit)}`).join(' · ')}`) : null,
          m.me && P.shareMine ? h('div', { class: 'btns tight', style: 'margin-top:3px' }, titled(button('Resend my avatar', () => P.resendMine()), 'Send your avatar again (use it if someone says they can’t see you)')) : null,
          m.tv ? tvFeedLine(P, m.id, m.me, m.tv) : m.stats ? h('div', { class: 'note', 'data-tick': '', style: 'margin:0;font-variant-numeric:tabular-nums' }, fmtStats(m)) : null,
          controls),
      ));
    }
  };

  const drawList = () => rerender(list, members);

  const build = () => {
    const st = status;
    const add = (...n: (Node | string | null | false | undefined)[]) => box.append(...n.filter((x): x is Node | string => !!x));
    // ---------------------------------------------------------------- setup
    const setup = h('details', { open: !!st && !st.configured },
      h('summary', null, 'Discord setup (one time)'),
      h('p', { class: 'note' }, 'Needs two things of your own, both free: an invite server on your Cloudflare account, and a Discord application you create (you and your guests sign in with it). Guests only need VTube Pro running (or a browser, for interview links). ',
        button('📖 Hosting setup guide', () => openHelp('HOSTING_SETUP.md'))),
    );
    const relayIn = h('input', { type: 'text', value: st?.relayUrl ?? '', placeholder: 'https://vtube-pro-relay.<name>.workers.dev' });
    const clientIn = h('input', { type: 'text', value: st?.clientId ?? '', placeholder: 'Client ID of your own Discord app (OAuth2 page)' });
    setup.append(
      // (plain words: the guides call it "your invite server")
      h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'Your invite server address'), relayIn),
      h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'Your Discord app’s Client ID'), clientIn),
      h('p', { class: 'note' }, 'In your Discord app → OAuth2 → Redirects add this one: ', h('code', null, st?.redirectUri ?? 'http://127.0.0.1:5191/api/discord/callback'), ' (the client secret goes into your invite server, never into this app).'),
      h('div', { class: 'btns' }, button('Save', () => {
        // friendly checks first (the server re-checks): an empty pair clears the setup
        if (!relayIn.value.trim() && !clientIn.value.trim()) { void save({ relayUrl: '', clientId: '' }); return; }
        const rc = checkRelayUrl(relayIn.value), cc = checkClientId(clientIn.value);
        if (!rc.ok) { toast(rc.error, 'warn', 8000); return; }
        if (!cc.ok) { toast(cc.error, 'warn', 8000); return; }
        void save({ relayUrl: rc.origin, clientId: cc.id });
      }, 'primary')),
      st?.relayUrl && privacyWarning(linkPrivacy(st.relayUrl)) ? h('p', { class: 'note', style: 'color:#f5c451' }, '🔒 ', privacyWarning(linkPrivacy(st.relayUrl)), ' ', button('Private links', () => openHelp(PRIVATE_LINKS_HELP))) : '',
      st?.relayUrl ? h('p', { class: 'note' }, 'Guests need this Redirect in your Discord app → OAuth2 too: ', h('code', null, `${st.relayUrl.replace(/\/+$/, '')}/cb`)) : '',
      toggle('Hide my internet address from guests', !!st?.relayOnly, (v) => void save({ relayOnly: v }), 'Guests never see your internet address: everything goes through your invite server (turn it on in Set up my invite server; adds a little delay).'),
    );
    // (the browser version: "needs the helper" is a normal note, not a red "Server:" error)
    if (statusErr) box.append(h('p', { class: 'note', style: 'color:#f57' }, `Couldn’t read your party set-up: ${statusErr}`));

    // ---------------------------------------------------------------- joining a friend (most people): no Discord setup needed
    if (P.role === 'none' && !st?.signedIn) {
      box.append(h('div', { style: 'padding:8px 10px;background:#23324a;border-radius:8px;margin:0 0 8px' },
        h('b', null, 'Joining a friend? '),
        'You don’t need to set up or connect Discord — that’s only for the host. Keep VTube Pro open on this computer, click the ',
        h('b', null, 'Join link'), ' your host shares, sign in with Discord in the browser tab that opens, then press ', h('b', null, 'Join'), ' here.'));
    }

    // ---------------------------------------------------------------- host
    if (P.role !== 'guest') {
      if (!st?.configured) box.append(h('p', { class: 'note' }, 'Hosting: set up Discord below (one time) to host parties with a Join button in your server.'));
      else if (!st.signedIn && st.claim) {
        // claim your relay: the first sign-in on a fresh relay asks for the setup window's claim code
        const code = h('input', { type: 'text', placeholder: 'claim code, e.g. K7QF-M2XR', 'aria-label': 'Claim code', autocomplete: 'off', style: 'text-transform:uppercase;letter-spacing:2px' }) as HTMLInputElement;
        const claimIt = () => void discord.claim(code.value).then((s) => { status = s; toast('You’re the host of your relay ✓', 'ok'); draw(); }).catch((e) => toast((e as Error).message, 'warn', 8000));
        box.append(h('p', null, 'Signed in as ', safeName(st.claim.name, 'your Discord account'), '. Type the claim code the relay setup window showed:'),
          h('div', { class: 'btns' }, code, button('Make me the host', claimIt, 'primary')));
      } else if (!st.signedIn) {
        box.append(h('div', { class: 'btns' }, button('Connect Discord (hosts only)', () => { discord.login(); toast('Finish signing in in the Discord window', 'info', 6000); }, 'primary')),
          h('p', { class: 'note' }, 'Only the host signs in here (scope: identify). The first time, you type the claim code the relay setup showed. Nothing secret is stored on this PC.'));
      } else {
        box.append(h('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:6px' }, safeAvatar(30), // stream-safe: no Discord picture, name or @handle until the eye is pressed (src/ui/streamSafe.ts)
          h('div', { style: 'flex:1' }, 'Signed in as ', safeName(st.user?.username ? `${st.user?.name ?? '?'} (@${st.user.username})` : st.user?.name ?? '?', 'your Discord account')),
          button('Sign out', () => void discord.logout().then((s) => { status = s; draw(); }))));
        if (P.role === 'none') {
          const guilds = channels?.guilds ?? [];
          const chOpts: [string, string][] = [['', '— don’t post (copy the link yourself) —'], ...guilds.flatMap((g) => g.channels.map((c): [string, string] => [c.id, `${g.name} › #${c.name}`]))];
          if (st.channelId && !chOpts.some(([v]) => v === st.channelId)) chOpts.push([st.channelId, `channel ${st.channelId}`]);
          const gOpts: [string, string][] = [['', 'Anyone with the link (Discord sign-in only)'], ...guilds.map((g): [string, string] => [g.id, `Members of ${g.name}`])];
          if (st.guildId && !gOpts.some(([v]) => v === st.guildId)) gOpts.push([st.guildId, `Members of server ${st.guildId}`]);
          const roles = h('input', { type: 'text', value: st.roleIds.join(', '), placeholder: 'role ids (optional, comma-separated)', onChange: (e: Event) => void save({ roleIds: (e.target as HTMLInputElement).value as never }) });
          add(
            select('Post invite in', st.channelId, chOpts, (v) => void save({ channelId: v }), 'The bot posts "🎙 you are live in VTube Pro — Join" here'),
            channels ? null : h('div', { class: 'btns tight' }, button('Load my channels', () => void loadChannels())),
            channels && !channels.bot ? h('p', { class: 'note', style: 'color:#f5c451' }, 'Your relay has no bot token, so nothing gets posted in Discord: after Go live, copy the join link and paste it in Discord yourself.') : null,
            channels?.bot && !guilds.length ? h('p', { class: 'note', style: 'color:#f5c451' }, 'Your bot isn’t in any Discord server yet, so it can’t post the Join button. Invite it: Discord Developer Portal → your app → OAuth2 → URL Generator → scope “bot”, permissions View Channels + Send Messages + Embed Links → open the URL → pick your server → Load my channels again. Until then, copy the join link after Go live and paste it in Discord yourself.') : null,
            select('Who may join', st.guildId, gOpts, (v) => void save({ guildId: v }), 'Checked by the relay when they sign in (scope guilds.members.read)'),
            st.guildId ? h('label', { class: 'row', title: 'Only members holding one of these roles (right-click a role → Copy Role ID)' }, h('span', { class: 'lbl' }, 'Required role'), roles) : null,
            toggle('Auto-approve', st.autoApprove, (v) => { P.autoApprove = v; void save({ autoApprove: v }); }, 'Let allowed people straight in (off = you approve each knock)'),
            toggle('Send my avatar to my guests', P.shareMine, (v) => P.setSharing(v, P.sharePolicy), 'Off = your guests see a stand-in for you: your model and the costume you wear never leave this PC (turning it off during a party makes everyone drop it at once). On = each guest gets a sealed copy in memory that is wiped when the party ends.'),
            select('My avatar goes to', P.sharePolicy === 'guild' ? 'guild' : 'party', [['party', 'Everyone I let in'], ['guild', 'Only verified server members']] as [SharePolicy, string][], (v) => P.setSharing(P.shareMine, v)),
            h('div', { class: 'btns' },
              button('Go live · post invite', async () => {
                try { const r = await goLive(P, st, { channelId: st.channelId, post: !!st.channelId }); toast(r.posted ? 'Invite posted in Discord ✔' : 'Live — copy the join link below', 'ok'); } catch (e) { toast(`Go live failed: ${(e as Error).message}`, 'err', 7000); }
              }, 'primary')),
            guestLinkBox(app, () => draw()),
            st.bans.length ? h('details', null, h('summary', null, `Banned (${st.bans.length})`), ...st.bans.map((b) => h('div', { class: 'row' }, h('span', null, b.name || b.id), button('Unban', () => void discord.ban(b.id, b.name, true).then((s) => { status = s; draw(); }))))) : null,
          );
        } else if (P.via === 'discord') {
          add(h('p', { class: 'note' }, h('b', null, 'Live on Discord. '), `${P.remotes.size}/7 guests.`),
            P.joinUrl ? h('div', { class: 'btns tight' }, button('Copy join link', () => { void navigator.clipboard.writeText(shareLink(P.joinUrl)); toast('Join link copied', 'ok'); })) : null,
            P.joinUrl ? h('p', { class: 'note' }, 'Join link: ', h('code', { style: 'user-select:all' }, shareLink(P.joinUrl))) : null,
            // no hosted bot: your own bot (the bot token on your invite server) posts the card; otherwise paste the link yourself
            P.joinUrl ? h('p', { class: 'note' }, 'Post it in Discord: paste the link in any channel. (If your invite server has your Discord bot’s token, “Go live · post invite” posts a card with a Join button for you.)') : null,
            P.joinUrl ? h('details', null, h('summary', null, 'Guests can’t get in? Check this'),
              h('p', { class: 'note' }, '1. Open the join link yourself in a browser. Discord must show your profile and ask to let your Discord app access your account. If it says ',
                h('b', null, 'Invalid OAuth2 redirect_uri'), ' (a plain card with no profile), add ', h('code', { style: 'user-select:all' }, `${(() => { try { return new URL(P.joinUrl).origin; } catch { return 'https://<your relay>'; } })()}/cb`),
                ' under Discord Developer Portal → your app → OAuth2 → Redirects, and Save. (Don’t press Authorize on your own test: you are the host.)'),
              h('p', { class: 'note' }, '2. Guests need VTube Pro open on their computer before they click Join, and must be signed in to discord.com in that browser (if not, Discord shows its login page first).'),
              h('p', { class: 'note' }, '3. “Couldn’t connect — firewall / NAT” here means their network blocks direct connections. Open Set up my invite server and press Turn it on. ', button('Show me how', () => openHelp('HOSTING_SETUP.md#step-5-let-every-guest-connect'))),
              h('p', { class: 'note' }, '4. Reloading this studio no longer ends the party: it rejoins the same room (the link stays valid while the room is open). Pressing “End party” ends it; after that make a new link.')) : null,
            toggle('Auto-approve', P.autoApprove, (v) => { P.autoApprove = v; void save({ autoApprove: v }); }),
            greenRoomHost(app),
            guestLinkBox(app, () => draw()));
          for (const k of P.knocks) box.append(h('div', { style: 'display:flex;gap:8px;align-items:center;padding:6px;background:#2a2f3d;border-radius:8px;margin:4px 0' },
            icon({ discord: k.user, name: k.user?.name ?? '?' }), h('div', { style: 'flex:1' }, h('b', null, k.user?.name ?? 'Someone'), ' wants to join', k.guildOk ? h('span', { class: 'chip ok', style: 'margin-left:6px' }, 'server member') : null, k.link ? h('span', { class: 'chip warn', style: 'margin-left:6px', title: 'Came in with your no-sign-in interview link: they typed this name themselves' }, 'link guest · name not verified') : null),
            button('Let in', () => void P.approve(k), 'primary'), button('Deny', () => P.deny(k))));
        }
      }
    }

    // ---------------------------------------------------------------- guest
    if (P.role === 'guest') {
      box.append(h('p', { class: 'note' }, P.via === 'discord' ? ['Joined ', h('b', null, P.hostInfo?.name ?? 'the host'), ' via Discord', P.myDiscord ? ` as @${P.myDiscord.username || P.myDiscord.name}` : '', '.'] : 'You joined with an invite code.'),
        toggle('Share my avatar', P.shareMine, (v) => P.setSharing(v), 'Off = everyone drops your model immediately (you stay in the party)'),
        select('Who else sees it', P.sharePolicy, policyOptions(P.hostInfo?.name ?? 'the host'), (v) => P.setSharing(P.shareMine, v)),
        partyVoiceGuest(app) ?? '',
        greenRoomGuest(app) ?? '');
    }
    if (P.role === 'none') {
      const link = h('input', { type: 'text', placeholder: 'Paste the join link your host sent' });
      box.append(h('details', { open: !st?.signedIn }, h('summary', null, 'Joining someone? (paste a join link)'),
        h('p', { class: 'note' }, 'Normally you just click Join in Discord and VTube Pro asks you. If the page could not reach VTube Pro, paste its link here.'),
        link, h('div', { class: 'btns tight' }, button('Join', () => {
          const j = parseJoinLink(link.value);
          if (!j) { toast('That is not a VTube Pro join link', 'err'); return; }
          const t = peekTicket(j.ticket);
          void askJoinConsent(P, { relay: j.relay, ticket: j.ticket, hostName: String(t.hn ?? 'the host'), you: String(t.n ?? ''), trusted: !!status?.trustedRelays.includes(j.relay) || status?.relayUrl === j.relay });
        }))));
    }

    // ---------------------------------------------------------------- polycount limit (host sets it; guests see it)
    box.append(polycount(P));

    // ---------------------------------------------------------------- members
    if (P.role !== 'none') box.append(h('div', { class: 'note', style: 'margin-top:8px' }, h('b', null, 'In the party')), list, tvHostControls(app) ?? '', h('div', { class: 'btns' },
      titled(button('Copy diagnostics', () => { void navigator.clipboard.writeText(P.diagnostics()).then(() => toast('Party diagnostics copied — paste them to whoever helps you (no keys, links or models inside)', 'ok', 6000), () => toast('Couldn’t copy (clipboard blocked)', 'err')); }), 'Connection + avatar transfer state of everyone here, for troubleshooting'),
      button(P.role === 'host' ? 'End party' : 'Leave party', () => P.leave(), 'danger')));
    if (P.status) box.append(h('p', { class: 'note' }, P.status));

    // ---------------------------------------------------------------- advanced: invite codes
    box.append(advancedCodes(app));
    box.append(setup);
  };
  function draw() { rerender(box, build); drawList(); }

  // live updates while the panel is on screen
  const onParty = () => draw();
  P.listeners.add(onParty);
  const iv = setInterval(() => { if (!box.isConnected) { P.listeners.delete(onParty); clearInterval(iv); return; } drawList(); }, 1000);
  app.bus.on((m) => { if (m.type === 'command' && m.command === 'discord-changed' && box.isConnected) void refreshStatus(); });
  build();
  void refreshStatus();
  // "Be a guest on someone else's show": the guest browser source card (needs no Discord; src/ui/guestFeedCard.ts). It asks the server only while it is on screen.
  const guestFeed = h('div');
  if (app.observer) guestFeed.append(h('p', { class: 'note' }, `${GF_TITLE}: turn it on in the real studio window, not in a test window.`)); // (an observer window never changes what is live)
  else mountGuestFeedCard(guestFeed, {
    notify: (m, k, ms) => toast(m, k, ms), copy: copyText,
    openHelp: () => openHelp(GUEST_FEED_HELP),
  });
  return section('Multiplayer — Discord party (up to 8)', tvAppearSection(app), box,
    h('p', { class: 'note' }, 'Everyone runs VTube Pro on their own PC and talks in Discord voice as usual; every member’s OBS shows the whole party. Avatars and movement go straight between your computers, encrypted. Your invite server only introduces them.'),
    h('details', null, h('summary', null, 'What happens to shared avatars'), h('p', { class: 'note' }, CUSTODY_NOTE)),
    guestFeed);
}

/** A TV member's picture as this studio receives it (or, for me, sends it): resolution · fps · bitrate. */
function tvFeedLine(P: import('../party.ts').Party, id: string, me: boolean, tv?: import('../../shared/tv.ts').TvInfo | null): HTMLElement | null {
  const st = P.tvLinks.stats;
  const f = me ? st.up : st.feeds[id];
  const has = P.tvLinks.feeds.has(id);
  const txt = f ? `${me ? 'sending' : 'picture'} ${f.width}×${f.height} · ${f.fps} fps · ${f.kbps} kbit/s${me && st.up?.limited ? ` · limited by ${st.up.limited}` : ''}`
    : has ? 'picture connected' : me ? 'picture not sent yet' : 'no picture yet';
  // Spout2 performers: where the model comes from + alpha on / off + the fps at its source (mine) or arriving here
  const sp = tv?.spout;
  const rx = me ? P.tv.source.spoutRx : null;
  const health = sp ? `${spoutHealth({ native: sp.native, alpha: sp.alpha, fps: rx ? rx.stats.fps : f?.fps })}${rx && rx.stats.state !== 'live' ? ` · ${rx.stats.state}` : ''} · ` : '';
  return h('div', { class: 'note', 'data-tick': '', style: `margin:0;font-variant-numeric:tabular-nums${sp && !sp.alpha && sp.native ? ';color:#f5c451' : ''}` }, `${sp ? '✨' : '📺'} ${health}${txt}`);
}

/** The party's polycount limit: the host picks it, guests see the host's; plus my own model's count once known. */
function polycount(P: import('../party.ts').Party): HTMLElement {
  const box = h('div', { style: 'margin-top:6px' });
  const mine = P.myTrisTotal;
  const lim = P.trisLimit;
  if (P.role !== 'guest') {
    const opts: [string, string][] = TRIS_CHOICES.map((n) => [String(n), `${fmtTris(n)} triangles${n === TRIS_MAX ? ' (default)' : ''}`]);
    if (!TRIS_CHOICES.includes(P.maxTris)) opts.push([String(P.maxTris), `${fmtTris(P.maxTris)} triangles`]);
    box.append(select('Most detailed avatar allowed', String(P.maxTris), opts, (v) => P.setMaxTris(Number(v)),
      'Avatars (model + worn costume) above this are not sent / not accepted in your party — everyone renders everyone. Heavier avatars share an automatic party version instead.'));
  } else box.append(h('p', { class: 'note' }, `This party’s limit: ${fmtTris(lim)} triangles per avatar (set by the host).`));
  box.append(toggle('Automatic party version', P.autoLod, (v) => P.setAutoLod(v),
    'Over the limit, parties get a reduced copy of your model (face, eyes, mouth shapes, rig and textures kept; body and clothes simplified first). Your original is never changed.'));
  const src = P.srcTris.m + (P.myTris.c ? P.srcTris.c : 0);
  const id = P.myAvatar?.id;
  const preview = id ? button('Preview', () => previewPartyLod(id, lim, P.myAvatar?.costume ?? null)) : null;
  if (P.lodState === 'ready' && P.lod) {
    box.append(h('p', { class: 'note', style: 'color:#7bd88f' }, `Your model has ${fmtTris(src)} triangles — parties use an automatic ${fmtTris(mine)}-triangle version.`),
      h('div', { class: 'btns tight' }, preview, button('Regenerate', () => P.regenerateLod())),
      ...P.lod.warnings.map((w) => h('p', { class: 'note', style: 'color:#f5c451;margin:0' }, w)));
  } else if (P.lodState === 'working') box.append(h('p', { class: 'note' }, `Your model has ${fmtTris(src)} triangles — making a party version under ${fmtTris(lim)}…`));
  else if (P.lodState === 'failed') box.append(h('p', { class: 'note', style: 'color:#f57' }, `Your model has ${fmtTris(src)} triangles — the party limit is ${fmtTris(lim)}, and the party version failed (${P.lodError}). Nobody receives your avatar; decimate it or pick a lighter model.`),
    h('div', { class: 'btns tight' }, button('Try again', () => P.regenerateLod())));
  else if (mine > 0) {
    const col = mine > lim ? '#f57' : mine > TRIS_WARN ? '#f5c451' : '';
    box.append(h('p', { class: 'note', style: col ? `color:${col}` : '' }, `Your model: ${fmtTris(mine)} triangles`,
      mine > lim ? ` — the party limit is ${fmtTris(lim)}; decimate it or pick a lighter model (or turn on the automatic party version). Nobody receives it now.`
        : mine > TRIS_WARN ? ` — heavy (warning above ${fmtTris(TRIS_WARN)}, limit ${fmtTris(lim)}); guests with weaker PCs may drop frames.` : ` ✔ (limit ${fmtTris(lim)})`));
  }
  return box;
}

/** Codes survive the panel re-rendering (status changes re-render it right after a code is made). */
const draft = { out: '', in: '' };
/** The original copy/paste codes (no Discord, no relay; public STUN only). */
function advancedCodes(app: App): HTMLElement {
  const P = app.party;
  const d = h('details', null, h('summary', null, 'Advanced: invite codes (no Discord)'));
  const name = h('input', { type: 'text', value: P.name, maxlength: '40', onChange: (e: Event) => { P.name = (e.target as HTMLInputElement).value.slice(0, 40) || 'Me'; localStorage.setItem('vtp.partyName', P.name); } });
  d.append(h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'Your name'), name));
  const codeOut = h('textarea', { readonly: true, rows: '3', style: 'width:100%;font-size:11px', placeholder: 'Your code appears here', value: draft.out }) as HTMLTextAreaElement;
  const codeIn = h('textarea', { rows: '3', style: 'width:100%;font-size:11px', placeholder: 'Paste the code you received here', value: draft.in, onInput: (e: Event) => (draft.in = (e.target as HTMLTextAreaElement).value) }) as HTMLTextAreaElement;
  const copy = () => { codeOut.select(); void navigator.clipboard.writeText(codeOut.value); toast('Code copied — send it to your friend', 'ok'); };
  if (P.role !== 'guest') {
    d.append(h('p', { class: 'note' }, P.role === 'host' ? `Hosting — ${P.remotes.size}/7 guests. Invite one more:` : 'Host: make an invite code per friend; they send back a reply code.'),
      h('div', { class: 'btns' },
        button(P.role === 'host' ? 'New invite code' : 'Host with codes', async () => { try { codeOut.value = draft.out = await P.createInvite(); copy(); } catch (e) { toast((e as Error).message, 'err'); } }),
        button('Connect reply', async () => { try { await P.acceptReply(codeIn.value); codeIn.value = draft.in = ''; } catch (e) { toast((e as Error).message, 'err'); } }),
      ), toggle('Send my avatar to my guests', P.shareMine, (v) => P.setSharing(v, P.sharePolicy), 'Off = your guests see a stand-in for you: your model and the costume you wear never leave this PC (turning it off during a party makes everyone drop it at once). On = each guest gets a sealed copy in memory that is wiped when the party ends.'), codeOut, codeIn);
  }
  if (P.role === 'none') {
    const share = h('input', { type: 'checkbox', checked: P.shareMine });
    d.append(h('p', { class: 'note' }, "Join: paste the host's invite code, click Join, send them the reply code."),
      h('label', { style: 'display:flex;gap:6px;align-items:center' }, share, 'Share my avatar with the host for this session'),
      h('div', { class: 'btns' }, button('Join with invite', async () => { try { codeOut.value = draft.out = await P.join(codeIn.value, share.checked); codeIn.value = draft.in = ''; copy(); } catch (e) { toast((e as Error).message, 'err'); } })));
  } else if (P.role === 'guest' && P.via === 'code') d.append(codeOut, codeIn);
  d.append(h('p', { class: 'note' }, 'Codes connect directly (public STUN only): very strict networks can block them — the Discord flow adds TURN. Peers see each other’s IP address unless you use the Discord flow with “Hide my IP”.'));
  return d;
}
