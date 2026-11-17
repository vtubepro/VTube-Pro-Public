// "Connect your chats" wizard: one card per platform — what to paste, Save + connect, a status light that follows the
// real connector, a test event, Disconnect. The only secret is the pasted Rumble link: typed by the performer, sent once
// to this PC's server (config/chat.json) and never shown again. No card asks for a sign-in.
import type { ChatStatus, LivePlatform } from '../../shared/chat.ts';
import { HUB_ACTIONS, HUB_ACTION_LABELS } from '../../shared/chathub.ts';
import { get, h, icon, PLAT_NAME, send, toast } from './util.ts';


export interface PublicCfg {
  kick: { enabled: boolean; channel: string };
  rumble: { enabled: boolean; hasKey: boolean };
  youtube: { enabled: boolean; handle: string; channelId: string; videoId: string };
  twitch?: { enabled: boolean; channel: string };
  tiktok?: { enabled: boolean; user: string; bridge: string; likes: boolean; joins: boolean };
  exists: boolean;
}

const TEST_OF: Record<LivePlatform, string> = { twitch: 'bits', youtube: 'superchat', kick: 'kicks', rumble: 'rant', tiktok: 'tiktok' };

export function stateText(s: ChatStatus['platforms'][LivePlatform] | undefined) {
  if (!s || !s.enabled) return { cls: 'off', txt: 'not connected' };
  const t = s.state === 'live' ? `connected${s.detail ? ` · ${s.detail}` : ''}` : s.state === 'waiting' ? `waiting · ${s.detail || 'not live yet'}` : s.state === 'connecting' ? `connecting… ${s.detail}` : s.state === 'error' ? `problem: ${s.detail}` : 'off';
  return { cls: s.state, txt: t };
}

export function openConnect(getStatus: () => ChatStatus | null, onStatus: (fn: () => void) => () => void) {
  const box = h('div', { class: 'box' });
  const modal = h('div', { class: 'modal', onClick: (e: Event) => { if (e.target === modal) close(); } }, box);
  let cfg: PublicCfg | null = null;
  const lights = new Map<LivePlatform, HTMLElement>();
  const close = () => { off(); modal.remove(); };
  const off = onStatus(() => paintLights());
  const paintLights = () => {
    const st = getStatus();
    for (const [p, el] of lights) { const s = stateText(st?.platforms[p]); el.replaceChildren(h('span', { class: `dot ${s.cls}` }), s.txt); }
  };
  const save = async (patch: Record<string, unknown>, msg = 'Saved — connecting…') => {
    try { cfg = await send<PublicCfg>('/api/chat/config', patch, 'PUT'); toast(msg); render(); } catch (e) { toast(`Save failed: ${(e as Error).message}`); }
  };
  const input = (value: string, ph: string, type = 'text') => h('input', { type, value, placeholder: ph, autocomplete: 'off', spellcheck: false });

  const card = (p: LivePlatform, enabled: boolean, steps: string[], fields: HTMLElement[], collect: () => Record<string, unknown> | null, extra: (HTMLElement | null)[] = []) => {
    const light = h('div', { class: 'st' });
    lights.set(p, light);
    return h('div', { class: 'card' },
      h('h3', null, icon(p), PLAT_NAME[p]), light,
      h('ol', null, ...steps.map((s) => { const li = h('li'); li.innerHTML = s; return li; })),
      ...fields,
      h('div', { class: 'row' },
        h('button', { class: 'pri', onClick: () => { const c = collect(); if (c) void save({ [p]: { ...c, enabled: true } }, `${PLAT_NAME[p]}: saved — connecting…`); } }, enabled ? 'Save + reconnect' : 'Connect'),
        enabled ? h('button', { onClick: () => void save({ [p]: { enabled: false } }, `${PLAT_NAME[p]} disconnected`) }, 'Disconnect') : null,
        h('button', { title: 'A local test event (never sent anywhere, never counted)', onClick: () => void send('/api/chat/test', { what: TEST_OF[p] }).then(() => toast('Test event sent')).catch((e) => toast((e as Error).message)) }, 'Send test')),
      ...extra);
  };

  const render = () => {
    lights.clear();
    const c = cfg;
    if (!c) { box.replaceChildren(h('p', null, 'Loading…')); return; }
    const tw = c.twitch ?? { enabled: false, channel: '' };
    const tt = c.tiktok ?? { enabled: false, user: '', bridge: 'ws://localhost:21213/', likes: false, joins: false };

    const twCh = input(tw.channel, 'your channel name or twitch.tv link');
    const ytIn = input(c.youtube.handle || c.youtube.channelId || c.youtube.videoId, '@handle or channel / live link');
    const kIn = input(c.kick.channel, 'your channel name or kick.com link');
    const rIn = input('', c.rumble.hasKey ? '•••••• saved (paste to replace)' : 'paste the whole Live Stream API URL', 'password');
    const ttUser = input(tt.user, '@username (optional, for the label)');
    const ttBridge = input(tt.bridge, 'ws://localhost:21213/');

    box.replaceChildren(
      h('button', { class: 'x', onClick: close }, '✕ Close'),
      h('h2', null, 'Connect your chats'),
      h('p', { class: 'note' }, 'Read only: VTube Pro never posts in your chat and never moderates. Everything is stored on this PC only (config/chat.json). Each card shows a live status light — green means connected.'),
      h('div', { class: 'cards' },
        card('twitch', tw.enabled, ['Type your Twitch channel name (or paste your twitch.tv link).', 'Press <b>Connect</b>. Chat, bits, subs, gifted subs and raids work right away.'],
          [h('label', null, 'Channel', twCh)], () => (twCh.value.trim() ? { channel: twCh.value.trim() } : (toast('Type your channel name'), null)),
          [h('p', { class: 'note' }, 'Twitch only shares follows and channel-point redeems with apps that sign in, so those are not shown.')]),
        card('youtube', c.youtube.enabled, ['Paste your channel link or @handle (or the link of one live stream).', 'Press <b>Connect</b>. It finds your live stream by itself when you go live (no Google login, no API quota).'],
          [h('label', null, 'Channel / live link', ytIn)], () => (ytIn.value.trim() ? { handle: ytIn.value.trim(), channelId: '', videoId: '' } : (toast('Paste your channel link or @handle'), null)),
          [h('p', { class: 'note' }, 'Shows chat, Super Chats, Super Stickers, memberships (new, milestones, gifted) and Jewels gifts.')]),
        card('kick', c.kick.enabled, ['Type your Kick channel name (or paste your kick.com link).', 'Press <b>Connect</b>. Chat, Kicks, subs, gifted subs, hosts and follows arrive live (+ 7TV emotes).'],
          [h('label', null, 'Channel', kIn)], () => (kIn.value.trim() ? { channel: kIn.value.trim() } : (toast('Type your channel name'), null))),
        card('rumble', c.rumble.enabled, ['On Rumble open <a href="https://rumble.com/account/livestream-api" target="_blank" rel="noopener">Account → Live Stream API</a>.', 'Copy the whole URL it shows (it contains your key) and paste it here — it stays secret on this PC.', 'Press <b>Connect</b>. Chat, Rants, subs, gifted subs and followers arrive every few seconds.'],
          [h('label', null, 'Live Stream API URL', rIn)],
          () => (rIn.value.trim() ? { apiKey: rIn.value.trim() } : c.rumble.hasKey ? {} : (toast('Paste your Live Stream API URL'), null)),
          [c.rumble.hasKey ? h('button', { onClick: () => void save({ clearRumbleKey: true }, 'Rumble key removed') }, 'Remove saved key') : null]),
        card('tiktok', tt.enabled, ['TikTok has no public chat API. Install and open <a href="https://tikfinity.zerody.one/" target="_blank" rel="noopener">TikFinity</a> (free desktop app) and connect it to your TikTok account.', 'Leave the bridge address as it is (TikFinity\'s local WebSocket) and press <b>Connect</b>. The light turns green when TikFinity is running.'],
          [h('label', null, 'TikTok user', ttUser), h('label', null, 'Bridge address', ttBridge)], () => ({ user: ttUser.value.trim(), bridge: ttBridge.value.trim() }),
          [h('p', { class: 'note' }, 'Chat, gifts (coins, counted once at the end of a combo), follows, shares and subscriptions. Any tool that speaks the same format works; tools that can only send web requests can use the ingest URL (Stream Deck & tools).'),
            h('label', { style: 'flex-direction:row;gap:8px;align-items:center' }, h('input', { type: 'checkbox', checked: tt.likes, onChange: (e: Event) => void save({ tiktok: { likes: (e.target as HTMLInputElement).checked } }, 'Saved') }), 'Show likes (batched)'),
            h('label', { style: 'flex-direction:row;gap:8px;align-items:center' }, h('input', { type: 'checkbox', checked: tt.joins, onChange: (e: Event) => void save({ tiktok: { joins: (e.target as HTMLInputElement).checked } }, 'Saved') }), 'Show joins')]),
      ));
    paintLights();
  };
  const load = () => get<PublicCfg>('/api/chat/config').then((c) => { cfg = c; render(); }).catch((e) => { box.replaceChildren(h('button', { class: 'x', onClick: close }, '✕'), h('p', null, `The chat server is not available: ${(e as Error).message}`)); });
  document.body.append(modal);
  render();
  void load();
}

/** Stream Deck & tools: ready-made URLs (with this PC's key) + the ingest API. */
export function openDeck(key: string) {
  const origin = location.port === '5190' ? `${location.protocol}//127.0.0.1:5191` : location.origin;
  const box = h('div', { class: 'box' });
  const modal = h('div', { class: 'modal', onClick: (e: Event) => { if (e.target === modal) modal.remove(); } }, box);
  const row = (a: string, label: string) => {
    const url = `${origin}/api/chathub/do/${a}?key=${key}`;
    const inp = h('input', { type: 'text', value: url, readOnly: true });
    return h('div', { class: 'grid2' }, h('span', null, label), h('div', { class: 'row', style: 'display:flex;gap:6px' }, inp, h('button', { onClick: () => { inp.select(); void navigator.clipboard?.writeText(url).then(() => toast('Copied')).catch(() => document.execCommand('copy')); } }, 'Copy')));
  };
  box.append(
    h('button', { class: 'x', onClick: () => modal.remove() }, '✕ Close'),
    h('h2', null, 'Stream Deck & tools'),
    h('p', { class: 'note' }, 'Stream Deck: add a System → Website action, paste one of these URLs and tick “GET request in background”. Each button then works while you stream. The key in the URL is private to this PC (keep it off stream).'),
    h('div', { class: 'urls' }, ...HUB_ACTIONS.map((a) => row(a, HUB_ACTION_LABELS[a]))),
    h('h3', null, 'Keyboard (this window)'),
    h('p', { class: 'note' }, 'A = acknowledge next · T = thank next on stream · S = skip the message being read · R = replay · + / − = text size'),
    h('h3', null, 'Send events from other tools'),
    h('p', { class: 'note' }, `Streamer.bot, TikTok bridges or your own scripts on this PC can POST JSON to ${origin}/api/chat/ingest — e.g. {"platform":"tiktok","kind":"finance","fkind":"tiktokGift","user":"Viewer","amount":100,"currency":"coins","text":"sent Rose"} · {"platform":"twitch","kind":"event","ev":"follow","user":"Viewer"} · {"platform":"kick","kind":"chat","user":"Viewer","text":"hi"}. Details: docs/CHAT_HUB.md.`),
  );
  document.body.append(modal);
}
