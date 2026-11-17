// Scene tab → "Chat & events": platform connections (Kick / Rumble / YouTube — read only), Import from an earlier overlay,
// the in-world props (chat monitor, support board, the chat buddy), placement, text size, filters, alerts, the
// goal bar and local test events. Connection settings live on this PC's server (config/chat.json — the Rumble key is
// never shown again); the prop options are part of the host's scene state (every OBS page + guests render them).
import type { App } from '../app.ts';
import { DEFAULT_CHAT_STATE, type ChatPlatformStatus, type SceneChatState } from '../../shared/chat.ts';
import { button, h, rerender, section, select, slider, toast, toggle } from './dom.ts';
import { openTool } from './dockTools.ts';
import { buddyName, buddyPicker } from './buddyPicker.ts';
import { chatBoxSection } from './chatBoxPanel.ts';
import { chatWhereChoice } from './chatWhere.ts';
import { emotesSection } from './emotesPanel.ts';

interface PublicCfg {
  kick: { enabled: boolean; channel: string; sevenTv: boolean };
  rumble: { enabled: boolean; hasKey: boolean; pollIntervalMs: number; announceFollowers: boolean };
  youtube: { enabled: boolean; handle: string; channelId: string; videoId: string };
  names: string[]; vips: string[]; emotes: boolean; exists: boolean; overlayDir?: string;
}
interface OverlayPreview { ok: boolean; error?: string; dir: string; kick?: string; youtube?: string; rumbleKey: boolean; vips: number; enabled: string[] }

const j = async <T>(r: Response) => { if (!r.ok) { let m = `${r.status}`; try { m = (await r.json()).error ?? m; } catch { /* */ } throw new Error(m); } return r.json() as Promise<T>; };
const post = <T>(url: string, body: unknown, method = 'POST') => fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<T>(r));

const CSS = `
.chat-st { display:grid; grid-template-columns: 22px 78px 1fr; gap:4px 6px; align-items:center; font-size:12.5px; margin:4px 0 8px; }
.chat-st .dot { width:10px; height:10px; border-radius:50%; background:#3a4254; justify-self:center; }
.chat-st .dot.live { background:#35d46a; box-shadow:0 0 6px #35d46a; } .chat-st .dot.connecting, .chat-st .dot.waiting { background:#e9c440; } .chat-st .dot.error { background:#ff5c5c; }
.chat-st .pn { font-weight:700; } .chat-st .det { color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.chat-cfg input[type=text], .chat-cfg input[type=password], .chat-cfg input[type=number] { width:100%; }
.chat-tests { display:flex; flex-wrap:wrap; gap:4px; }
.chat-tests .btn { padding:3px 8px; font-size:12px; }
`;
let cssDone = false;

/** The host Chat Hub (chathub.html): a drawer in the studio by default, or its own window (src/ui/dockTools.ts). */
export function openChatHub(connect = false) { openTool('chathub', connect ? 'connect=1' : ''); }

export function chatSection(app: App): HTMLElement {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const S = app.scene;
  const observer = S.observer;
  const box = h('div');
  let cfg: PublicCfg | null = null;
  let overlay: OverlayPreview | null = null;
  let overlayDir = '';
  const draft: Record<string, Record<string, unknown>> = { kick: {}, rumble: {}, youtube: {} };

  const loadCfg = () => fetch('/api/chat/config').then((r) => j<PublicCfg>(r)).then((c) => { cfg = c; overlayDir ||= c.overlayDir ?? ''; render(); }).catch(() => { render(); });
  const saveCfg = async (patch: Record<string, unknown>) => {
    if (observer) { toast('Observer: chat settings are not saved', 'warn'); return; }
    try { cfg = { ...(await post<PublicCfg>('/api/chat/config', patch, 'PUT')), overlayDir: cfg?.overlayDir }; draft.kick = {}; draft.rumble = {}; draft.youtube = {}; toast('Chat connections saved', 'ok'); render(); }
    catch (e) { toast(`Save failed: ${(e as Error).message}`, 'err'); }
  };

  // live part (connection lights, totals, recent support): re-rendered on chat events, never touches the inputs below
  const live = h('div');
  const renderLive = () => rerender(live, () => {
    const status = S.chat.status;
    const row = (p: 'kick' | 'rumble' | 'youtube' | 'twitch' | 'tiktok', label: string) => {
      const s: ChatPlatformStatus | undefined = status?.platforms[p];
      const state = s?.enabled ? s.state : 'off';
      const txt = !s || !s.enabled ? 'off' : state === 'live' ? `connected${s.detail ? ` · ${s.detail}` : ''}` : state === 'waiting' ? `waiting · ${s.detail || 'not live'}` : state === 'connecting' ? `connecting… ${s.detail}` : state === 'error' ? `⚠ ${s.detail}` : 'off';
      return [h('span', { class: `dot ${state}` }), h('span', { class: 'pn' }, label), h('span', { class: 'det', title: txt }, txt)];
    };
    // stream-setup: the guided set-up is the main way in; everything below stays for the details
    live.append(h('div', { class: 'btns tight' }, button('Set up my chat & stream', () => void import('./streamSetup/index.ts').then((m) => m.openStreamSetup(app)), 'primary'), button('Open Chat Hub (chat + events)', () => openChatHub())),
      h('p', { class: 'note' }, 'All your chats in one place — a panel beside the stage, or “Pop out ↗” for its own window on another screen — with support + stream events to acknowledge, text-to-speech and the easy “Connect your chats” setup for Twitch, YouTube, Kick, Rumble and TikTok.'));
    live.append(h('div', { class: 'chat-st' }, ...row('twitch', 'Twitch'), ...row('youtube', 'YouTube'), ...row('kick', 'Kick'), ...row('rumble', 'Rumble'), ...row('tiktok', 'TikTok')));
    // (only when the chat config was read and is empty: without the helper there are no channel fields below)
    if (cfg && !cfg.exists) live.append(h('p', { class: 'note' }, 'Nothing is connected yet. Fill in the channels below. Read only: VTube Pro never posts in chat or moderates.'));
    const t = S.chat.totals;
    const recent = S.chat.support.slice(-4).reverse();
    if (t || recent.length) live.append(h('div', { class: 'note' },
      t ? h('div', null, h('b', null, `This session: $${t.usd.toFixed(2)}`), ` · ${t.count} supporters · ${t.subs} subs`) : null,
      ...recent.map((e) => h('div', null, `${e.platform} · ${e.user} · ${e.label ?? ''}${e.display && e.display !== 'Member' ? ` ${e.display}` : ''}${e.approxUsd ? ` (≈$${e.approxUsd.toFixed(2)})` : ''}${e.test ? ' (test)' : ''}`))));
  });

  // the chat buddy: which model, tablet size, tablet text
  const buddyOpts = (st: SceneChatState) => {
    const who = buddyName(st.buddyModel);
    const edit = S.canEdit;
    const set = (p: Partial<SceneChatState>) => { if (edit) S.setChat(p); };
    const lines = Math.max(2, Math.round((7.4 * (st.tablet ?? 1) - 0.85) / ((st.tabletText ?? 1) * st.font)));
    const roam = (st.buddyMode ?? 'roam') !== 'stay';
    return h('div', null,
      buddyPicker({ current: st.buddyModel, disabled: !S.canEdit, onPick: (id) => set({ buddyModel: id }), refresh: () => { if (box.isConnected) render(); } }),
      select('Behaviour', st.buddyMode ?? 'roam', [['roam', 'Roam around (default)'], ['stay', 'Stay put (tablet always up)']], (v) => set({ buddyMode: v as SceneChatState['buddyMode'] }), `Roam: ${who} wanders around the room, does little bits and raises the tablet (where it is readable) when chat arrives. Stay put: one spot per shot, tablet always up.`),
      roam ? select('Wander range', st.buddyRange ?? 'room', [['room', 'Whole room (anywhere in the shot)'], ['near', 'Near me']], (v) => set({ buddyRange: v as SceneChatState['buddyRange'] }), `Where ${who} may wander: anywhere the camera sees, or within about 3 m of you.`) : null,
      slider('Tablet size', st.tablet ?? 1, 0.6, 2.5, 0.05, (v) => set({ tablet: v }), 'A bigger tablet holds more chat at the same text size (above 1.25× it is held with both hands). The buddy finds a spot where it is still readable.', (v) => `${v.toFixed(2)}×`, { def: DEFAULT_CHAT_STATE.tablet }),
      slider('Tablet text', st.tabletText ?? 1, 0.5, 1.6, 0.05, (v) => set({ tabletText: v }), 'Smaller = more lines on the tablet; bigger = easier to read. Smaller text needs the tablet bigger on screen.', (v) => `${v.toFixed(2)}×`, { def: DEFAULT_CHAT_STATE.tabletText }),
      h('p', { class: 'note' }, `About ${lines} lines of chat fit on the tablet.`));
  };

  const render = () => rerender(box, () => {
    const st: SceneChatState = S.effective.chat ?? DEFAULT_CHAT_STATE;
    const edit = S.canEdit;
    const set = (p: Partial<SceneChatState>) => { if (edit) S.setChat(p); };
    renderLive();

    const imp = ''; // public build: no overlay import (owner-only)

    // ---- connections
    const txt = (p: 'kick' | 'youtube', key: string, label: string, value: string, hint: string) =>
      h('label', { class: 'row', title: hint }, h('span', { class: 'lbl' }, label), h('input', { type: 'text', value, placeholder: hint, disabled: observer, onChange: (e: Event) => { draft[p][key] = (e.target as HTMLInputElement).value.trim(); } }));
    const en = (p: 'kick' | 'rumble' | 'youtube', label: string, v: boolean) => toggle(label, v, (x) => { draft[p].enabled = x; }, 'Connect this platform (read only)');
    const c = cfg;
    const conns = c ? h('div', { class: 'chat-cfg' },
      en('kick', 'Kick', c.kick.enabled), txt('kick', 'channel', 'Channel', c.kick.channel, 'your Kick channel slug'),
      en('youtube', 'YouTube', c.youtube.enabled), txt('youtube', 'handle', 'Handle', c.youtube.handle, '@handle (or a channel id / video id below)'),
      txt('youtube', 'channelId', 'Channel id', c.youtube.channelId, 'UC… (optional)'), txt('youtube', 'videoId', 'Video id', c.youtube.videoId, 'pin one live video (optional)'),
      en('rumble', 'Rumble', c.rumble.enabled),
      h('label', { class: 'row', title: 'Rumble → Account → Live Stream API: the key part of the URL. Stored only in config/chat.json on this PC.' }, h('span', { class: 'lbl' }, 'API key'),
        h('input', { type: 'password', autocomplete: 'off', disabled: observer, placeholder: c.rumble.hasKey ? '•••••• saved (type to change)' : 'Live Stream API key', onChange: (e: Event) => { draft.rumble.apiKey = (e.target as HTMLInputElement).value.trim(); } })),
      h('div', { class: 'btns tight' },
        button('Save + connect', () => void saveCfg(draft), 'primary'),
        button('Disconnect all', () => void saveCfg({ kick: { enabled: false }, rumble: { enabled: false }, youtube: { enabled: false } }))),
      h('p', { class: 'note' }, 'Kick: public chat socket · YouTube: the public live chat (no sign-in, no quota) · Rumble: your Live Stream API key. Nothing is ever sent to chat.'),
    ) : h('p', { class: 'note' }, 'Can’t reach the chat service right now. Restart VTube Pro and try again.');

    // ---- in-world props (host's scene)
    const props = h('div', null,
      toggle('Chat monitor', st.monitor, (v) => set({ monitor: v }), 'A monitor drops down in the room where the current camera sees it (never over a face or the react screen)'),
      select('Support board', st.panel, [['off', 'Off'], ['panel', 'Neon SUPPORT board'], ['monitor', 'On the chat monitor']], (v) => set({ panel: v }), 'Recent support + a big in-world alert (confetti, lights) for Super Chats, Rants, Kicks, subs …'),
      toggle('💬 Chat buddy', st.buddy, (v) => set({ buddy: v }), `${buddyName(st.buddyModel)} walks in holding a tablet with your chat: wanders around the room and holds the tablet up when chat arrives (or, Stay put, stands in one spot with it up). Only when a shot shows no floor at all does the buddy peek in from a bottom corner.`),
      st.buddy ? buddyOpts(st) : null,
      select('Place on', st.side, [['auto', 'Auto (best side for the shot)'], ['left', 'Left of the frame'], ['right', 'Right of the frame']], (v) => set({ side: v })),
      slider('Monitor size', st.size, 0.6, 1.6, 0.05, (v) => set({ size: v }), undefined, { def: DEFAULT_CHAT_STATE.size, unit: '×' }),
      slider('Text size', st.font, 0.7, 1.6, 0.05, (v) => set({ font: v }), undefined, { def: DEFAULT_CHAT_STATE.font, unit: '×' }),
      toggle('Only drop while chat is active', st.autoDrop, (v) => set({ autoDrop: v }), 'The monitor rolls up after a quiet spell and drops again on the next message'),
      st.autoDrop ? slider('Quiet after (s)', st.idleSecs, 15, 300, 5, (v) => set({ idleSecs: Math.round(v) }), undefined, (v) => v.toFixed(0), { def: DEFAULT_CHAT_STATE.idleSecs, hard: [10, 900] }) : null,
    );
    const filters = h('div', { class: 'chat-cfg' },
      toggle('Hide !commands', st.hideCommands, (v) => set({ hideCommands: v })),
      toggle('Hide bots', st.hideBots, (v) => set({ hideBots: v }), 'Nightbot, StreamElements, Botrix, … plus the names below'),
      h('label', { class: 'row', title: 'Extra bot names, comma separated' }, h('span', { class: 'lbl' }, 'More bots'), h('input', { type: 'text', value: st.bots.join(', '), disabled: !edit, onChange: (e: Event) => set({ bots: (e.target as HTMLInputElement).value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) }) })),
      h('label', { class: 'row', title: 'Alerts for money events worth at least this (USD; Kicks / Jewels at their payout value). 0 = every one.' }, h('span', { class: 'lbl' }, 'Min alert $'), h('input', { type: 'number', min: 0, step: 1, value: st.minAlert, disabled: !edit, onChange: (e: Event) => set({ minAlert: Math.max(0, parseFloat((e.target as HTMLInputElement).value) || 0) }) })),
      toggle('Alert subs / members / gifts', st.alertSubs, (v) => set({ alertSubs: v })),
      toggle('Show ≈ USD for other currencies', st.converted, (v) => set({ converted: v }), 'Approximate (static rates) — the original currency is always shown'),
      toggle('Goal bar', st.goal.on, (v) => set({ goal: { ...st.goal, on: v } })),
      st.goal.on ? h('div', null,
        h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'Goal label'), h('input', { type: 'text', value: st.goal.label, maxLength: 40, disabled: !edit, onChange: (e: Event) => set({ goal: { ...st.goal, label: (e.target as HTMLInputElement).value } }) })),
        h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'Goal $'), h('input', { type: 'number', min: 1, value: st.goal.target, disabled: !edit, onChange: (e: Event) => set({ goal: { ...st.goal, target: Math.max(1, parseFloat((e.target as HTMLInputElement).value) || 100) } }) })),
        h('div', { class: 'btns tight' }, button('Reset session totals', () => { if (observer) return; void post('/api/chat/totals/reset', {}).then(() => toast('Totals reset', 'ok')); }))) : null,
    );
    for (const el of [props, filters]) for (const i of el.querySelectorAll('input, select')) if (!edit) (i as HTMLInputElement).disabled = true;

    // ---- tests (local only)
    const test = (what: string, label: string) => button(label, async () => {
      if (observer) { S.previewChat(what); return; }
      try { await post('/api/chat/test', { what }); } catch (e) { toast((e as Error).message, 'err'); }
    });
    const tests = h('div', null,
      h('div', { class: 'chat-tests' }, test('chat', 'Test chat'), test('superchat', 'Test Super Chat'), test('rant', 'Test Rant'), test('kicks', 'Test Kicks'), test('gift', 'Test gift subs'), test('member', 'Test member'), test('sub', 'Test resub')),
      h('p', { class: 'note' }, observer ? 'Observer: test events only play in this preview.' : 'Test events are local: they show on this PC\u2019s OBS + preview only (never sent to chat, never to party guests, never counted).'));

    box.append(
      h('h4', { style: 'margin:10px 0 4px' }, 'In the room'), props,
      h('h4', { style: 'margin:10px 0 4px' }, 'Filters & alerts'), filters,
      h('h4', { style: 'margin:10px 0 4px' }, 'Test'), tests,
      h('h4', { style: 'margin:10px 0 4px' }, 'Connections'), imp, conns,
    );
  });
  S.on((what) => { if (box.isConnected && what === 'state') render(); });
  S.chat.on(() => { if (live.isConnected) renderLive(); });
  void loadCfg();
  render();
  return section('Chat & events', live, chatWhereChoice(app), chatBoxSection(app, { live: true }), emotesSection(app), box);   // (On screen | In the room: src/ui/chatWhere.ts; chat box place / size: src/ui/chatBoxPanel.ts)
}
