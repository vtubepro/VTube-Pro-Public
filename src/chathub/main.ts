// Host Chat Hub window (chathub.html, docs/CHAT_HUB.md): every connected chat in one big, easy-to-read feed + the events
// queue (tips, subs, gifts, bits, Kicks, Super Chats, TikTok gifts, Rants, raids, follows …) with Acknowledge / Thank on
// stream / Read aloud, and the text-to-speech controls. Open it from Scene tab → Chat & events → "Open Chat Hub"; it is a
// normal browser window, so it can live on a second monitor. It never posts to a platform and never touches the scene.
import '../storageGuard.ts'; // (must stay the first import: a memory-only stand-in when the page may not keep site data)
import '../licenseNotice.ts'; // hosted copies say that VTube Pro is free (LICENSE); never shown on this PC or the home network
import '../net/lanPage.ts'; // a stream PC's page follows the gaming PC's mode
import { CHAT_BOTS, FINANCE_LABELS, LIVE_PLATFORMS, MONEY_KINDS, sanitizeChatEvent, sanitizeTotals, type ChatEvent, type ChatPlatform, type ChatStatus, type ChatTotals } from '../../shared/chat.ts';
import { DEFAULT_TTS, hubGroup, type HubGroup, type HubItem, type HubSnapshot, type HubTtsStatus, type TtsSettings } from '../../shared/chathub.ts';
import { Bus } from '../bus.ts';
import { openConnect, openDeck, stateText } from './connect.ts';
import { CSS } from './style.ts';
import { pollPanel } from '../poll/pollPanel.ts';
import { toggleQuestionsDrawer } from '../ui/audiencePanel.ts';
import { ago, clock, emoteSrc, get, h, icon, PLAT_NAME, send, store, toast } from './util.ts';
import { dockButtonSpec, initDockedPage, isDocked } from '../ui/dockEmbed.ts';
import { engineRow, voiceNote } from './voice.ts';
import { ensureKokoro, kokoroRows } from './kokoro.ts';
import { removedBy } from '../../shared/chatRemove.ts';

document.head.append(h('style', null, CSS));
// docked (a drawer inside the studio, src/ui/dockTools.ts): studio tokens, Esc closes, Chat | Events tabs when narrow
initDockedPage('chathub');
const DOCK_CSS = `
html.vtp-docked:not([data-theme=light]) { --bg: var(--vtpbg, #0e1117); --panel: var(--vtppanel, #161b24); --panel2: var(--vtpcard2, #1d2430); --line: var(--vtpline, #2a3342); --text: var(--vtptext, #eef2f8); --dim: var(--vtpdim, #9aa6b8); }
html.vtp-docked body { font-family: var(--vtpfont-ui, system-ui, "Segoe UI", sans-serif); }
html.vtp-docked header { padding: 8px 10px; gap: 6px; }
html.vtp-docked header h1, html.vtp-docked .totals { display: none; }
html.vtp-docked header button { padding: 4px 9px; font-size: 13px; }
.dk-seg { display: none; gap: 2px; padding: 2px; border-radius: 9px; background: var(--bg); border: 1px solid var(--line); }
.dk-seg button { border: 0; background: transparent; padding: 4px 12px; border-radius: 7px; color: var(--dim); font-weight: 600; }
.dk-seg button.on { background: var(--panel2); color: var(--text); box-shadow: 0 0 0 1px var(--line) inset; }
.dk-seg .n { display: inline-block; min-width: 18px; margin-left: 6px; padding: 1px 5px; border-radius: 8px; background: #c0392b; color: #fff; font-size: 11px; }
@media (max-width: 819px) {
  html.vtp-docked .dk-seg { display: inline-flex; }
  html.vtp-docked main { grid-template-columns: 1fr !important; }
  html.vtp-docked main[data-dk=chat] > .col:nth-child(2), html.vtp-docked main[data-dk=events] > .col:nth-child(1) { display: none !important; }
  html.vtp-docked main[data-dk=events] > .col:nth-child(2) { display: flex !important; border-right: 0; }
  html.vtp-docked footer { display: none; }
}`;
if (isDocked()) document.head.append(h('style', null, DOCK_CSS));

// ---------------------------------------------------------------- state
const MAX_CHAT = 400;
let chat: ChatEvent[] = [];
const chatIds = new Set<string>();
let items: HubItem[] = [];
let tts: TtsSettings = { ...DEFAULT_TTS };
let ttsStatus: HubTtsStatus = { ok: true, error: '', now: null, queue: [], voices: [] };
let status: ChatStatus | null = null;
let totals: ChatTotals | null = null;
let deckKey = '';
const statusSubs = new Set<() => void>();

const prefs = store.get('prefs', {
  fs: 20, plats: {} as Record<string, boolean>, bots: true, cmds: true, hlOnly: false, groups: {} as Record<string, boolean>, unreadOnly: false,
  showChat: true, showEvents: true, pins: [] as ChatEvent[], hlUsers: [] as string[], ttsOpen: false,
});
const savePrefs = () => store.set('prefs', prefs);
const platOn = (p: ChatPlatform) => prefs.plats[p] !== false;
const groupOn = (g: HubGroup) => prefs.groups[g] !== false;
const setFs = (v: number) => { prefs.fs = Math.max(12, Math.min(44, v)); document.documentElement.style.setProperty('--fs', `${prefs.fs}px`); savePrefs(); };
setFs(prefs.fs);

// the host hears TTS here when "Studio only" is picked
// (read-aloud plays in the STUDIO window, through the audio mixer — never here and never on the OBS page: once only)

// ---------------------------------------------------------------- layout
const root = document.getElementById('app')!;
const lightsEl = h('div', { class: 'lights', title: 'Connections — click to set up', onClick: () => openConnect(() => status, (fn) => { statusSubs.add(fn); return () => statusSubs.delete(fn); }) });
const totalsEl = h('div', { class: 'totals' });
const header = h('header', null,
  h('h1', null, 'Chat Hub'), lightsEl, h('div', { class: 'grow' }), totalsEl,
  h('button', { title: 'Smaller text (−)', onClick: () => { setFs(prefs.fs - 2); } }, 'A−'), h('button', { title: 'Bigger text (+)', onClick: () => { setFs(prefs.fs + 2); } }, 'A+'),
  h('button', { class: 'pri', onClick: () => lightsEl.click() }, 'Connect chats'),
  h('button', { title: 'Chat poll: viewers vote on every platform at once', onClick: () => togglePoll() }, '📊 Poll'),
  h('button', { title: 'Viewer questions (!ask): approve, answer, skip', onClick: () => toggleQuestionsDrawer((m) => toast(m)) }, '❓ Questions'),
  h('button', { onClick: () => openDeck(deckKey) }, 'Stream Deck & tools'),
  // docked: "Pop out ↗" (drawer → its own window) / "Dock back" (window → the studio drawer)
  ...((d) => (d ? [h('button', { title: d.title, onClick: d.run }, d.label)] : []))(dockButtonSpec('chathub')));

// chat column
const chatBar = h('div', { class: 'bar' });
const pinsEl = h('div', { class: 'pins' });
const feedEl = h('div', { class: 'feed' });
const newBtn = h('button', { class: 'newbtn', style: 'display:none', onClick: () => { feedEl.scrollTop = feedEl.scrollHeight; } });
const chatCol = h('section', { class: 'col' }, chatBar, pinsEl, feedEl);
feedEl.append(newBtn);

// events column
const evBar = h('div', { class: 'bar' });
const ttsEl = h('div', { class: 'tts' });
const evList = h('div', { class: 'events' });
const evCol = h('section', { class: 'col' }, ttsEl, evBar, evList);
const mainEl = h('main', null, chatCol, evCol);
// docked + narrow: one column at a time (the unread events count shows on the Events tab)
let dkTab: 'chat' | 'events' = store.get<string>('dkTab', 'chat') === 'events' ? 'events' : 'chat';
const dkSeg = h('div', { class: 'dk-seg', role: 'tablist', 'aria-label': 'Show' });
const paintDk = () => {
  mainEl.dataset.dk = dkTab;
  const unread = items.filter((x) => !x.ack && groupOn(hubGroup(x.e))).length;
  dkSeg.replaceChildren(
    h('button', { class: dkTab === 'chat' ? 'on' : '', role: 'tab', 'aria-selected': String(dkTab === 'chat'), onClick: () => { dkTab = 'chat'; store.set('dkTab', dkTab); paintDk(); } }, 'Chat'),
    h('button', { class: dkTab === 'events' ? 'on' : '', role: 'tab', 'aria-selected': String(dkTab === 'events'), onClick: () => { dkTab = 'events'; store.set('dkTab', dkTab); if (!prefs.showEvents) { prefs.showEvents = true; savePrefs(); layout(); } paintDk(); } }, 'Events', unread ? h('span', { class: 'n' }, String(Math.min(99, unread))) : null));
};
if (isDocked()) { header.insertBefore(dkSeg, header.children[1] ?? null); paintDk(); setInterval(paintDk, 1500); }
const footer = h('footer', null, 'Keys: ', h('kbd', null, 'A'), ' acknowledge next · ', h('kbd', null, 'T'), ' thank next on stream · ', h('kbd', null, 'S'), ' skip reading · ', h('kbd', null, 'R'), ' replay · ', h('kbd', null, '+'), '/', h('kbd', null, '−'), ' text size — read only: nothing is ever sent to your chat.');
root.append(h('div', { class: 'app' }, header, mainEl, footer));
// 📊 chat poll drawer (src/poll/pollPanel.ts)
let pollDrawer: HTMLElement | null = null;
function togglePoll() {
  if (!pollDrawer) {
    pollDrawer = h('aside', { style: 'position:fixed;top:56px;right:12px;bottom:40px;width:min(460px,calc(100vw - 24px));overflow:auto;background:#141226f2;border:1px solid #ffffff22;border-radius:14px;padding:12px 14px;z-index:9;box-shadow:0 12px 40px #0009' },
      h('div', { style: 'display:flex;align-items:center;margin-bottom:6px' }, h('b', { style: 'flex:1;font-size:16px' }, '📊 Chat poll'), h('button', { onClick: () => togglePoll() }, 'Close')), pollPanel((m) => toast(m)));
    document.body.append(pollDrawer);
  } else pollDrawer.style.display = pollDrawer.style.display === 'none' ? '' : 'none';
}

// ---------------------------------------------------------------- header
function paintHeader() {
  lightsEl.replaceChildren(...LIVE_PLATFORMS.map((p) => {
    const s = stateText(status?.platforms[p]);
    return h('span', { class: 'light', title: `${PLAT_NAME[p]}: ${s.txt}` }, h('span', { class: `dot ${s.cls}` }), icon(p), PLAT_NAME[p]);
  }));
  const real = items.filter((i) => !i.e.test && i.e.kind === 'finance');
  const by = new Map<string, number>();
  for (const i of real) { const v = i.e.usd || i.e.approxUsd || 0; if (v && i.e.fkind && MONEY_KINDS.has(i.e.fkind)) by.set(i.e.platform, (by.get(i.e.platform) ?? 0) + v); }
  const unread = items.filter((i) => !i.ack).length;
  totalsEl.replaceChildren(
    h('b', null, `$${(totals?.usd ?? 0).toFixed(2)}`), ' this session',
    totals ? ` · ${totals.count} supporters · ${totals.subs} subs` : '',
    by.size ? ` · ${[...by].map(([p, v]) => `${PLAT_NAME[p as ChatPlatform]} $${v.toFixed(2)}`).join(' · ')}` : '',
    unread ? h('span', { style: 'margin-left:10px;color:#ffd84a;font-weight:700' }, `${unread} unread event${unread === 1 ? '' : 's'}`) : '');
  for (const f of statusSubs) f();
}

// ---------------------------------------------------------------- chat feed
function chip(label: string | Node, on: boolean, click: () => void, title = '') {
  return h('button', { class: `chip ${on ? 'on' : 'off'}`, title, onClick: click }, label);
}
function paintChatBar() {
  chatBar.replaceChildren(
    ...LIVE_PLATFORMS.map((p) => chip(icon(p), platOn(p), () => { prefs.plats[p] = !platOn(p); savePrefs(); paintChatBar(); paintFeed(); }, `Show ${PLAT_NAME[p]}`)),
    chip('Hide bots', prefs.bots, () => { prefs.bots = !prefs.bots; savePrefs(); paintChatBar(); paintFeed(); }),
    chip('Hide !commands', prefs.cmds, () => { prefs.cmds = !prefs.cmds; savePrefs(); paintChatBar(); paintFeed(); }),
    chip('Highlights only', prefs.hlOnly, () => { prefs.hlOnly = !prefs.hlOnly; savePrefs(); paintChatBar(); paintFeed(); }, 'Mentions, VIPs, mods, highlighted people, support'),
    h('div', { class: 'grow' }),
    chip('Events column', prefs.showEvents, () => { prefs.showEvents = !prefs.showEvents; savePrefs(); layout(); }));
}
const HL_BADGES = new Set(['moderator', 'broadcaster', 'vip']);
function chatShown(e: ChatEvent) {
  if (!platOn(e.platform)) return false;
  const u = e.user.toLowerCase();
  if (e.kind === 'chat' && prefs.bots && CHAT_BOTS.includes(u)) return false;
  if (e.kind === 'chat' && prefs.cmds && /^\s*!\w/.test(e.text)) return false;
  if (prefs.hlOnly) return e.kind === 'finance' || !!e.mention || !!e.vip || prefs.hlUsers.includes(u) || !!e.badges?.some((b) => HL_BADGES.has(b));
  return true;
}
function msgBody(e: ChatEvent): Node[] {
  if (!e.parts) return [document.createTextNode(e.text)];
  return e.parts.map((p) => (p.t === 'text' ? document.createTextNode(p.v) : h('img', { class: 'em', src: emoteSrc(p.u), alt: p.n, title: p.n, loading: 'lazy' })));
}
function msgEl(e: ChatEvent, pinned = false): HTMLElement {
  const u = e.user.toLowerCase();
  const cls = ['msg', e.kind === 'system' ? 'sys' : '', e.mention ? 'mention' : '', e.vip ? 'vip' : '', prefs.hlUsers.includes(u) ? 'hl' : '', e.kind === 'finance' ? 'fin' : ''].filter(Boolean).join(' ');
  const el = h('div', { class: cls, style: e.tier ? `--tier:${e.tier}` : undefined },
    h('span', { class: 't' }, clock(e.ts)), icon(e.platform),
    h('div', { class: 'body' },
      ...(e.badges ?? []).filter((b) => ['broadcaster', 'moderator', 'vip', 'subscriber', 'member', 'founder', 'verified', 'backer'].includes(b)).map((b) => h('span', { class: `badge ${b}` }, b === 'broadcaster' ? 'HOST' : b === 'moderator' ? 'MOD' : b === 'subscriber' ? 'SUB' : b.toUpperCase())),
      h('span', { class: 'name', style: `color:${e.color ?? '#9ecbff'}` }, e.user),
      e.kind === 'finance' ? h('span', { class: 'amt' }, `${e.label ?? ''} ${e.giftName && e.fkind === 'tiktokGift' ? e.giftName + ' · ' : ''}${e.display && e.display !== 'Member' ? e.display : ''}`) : null,
      ...msgBody(e), e.test ? h('span', { class: 'badge' }, 'TEST') : null),
    h('div', { class: 'acts' },
      h('button', { title: pinned ? 'Unpin' : 'Pin to the top', onClick: () => togglePin(e) }, pinned ? '✕' : '📌'),
      pinned ? null : h('button', { title: 'Highlight everything this person says', onClick: () => { const i = prefs.hlUsers.indexOf(u); if (i >= 0) prefs.hlUsers.splice(i, 1); else prefs.hlUsers.push(u); savePrefs(); paintFeed(); } }, prefs.hlUsers.includes(u) ? '☆' : '★')));
  return el;
}
function togglePin(e: ChatEvent) {
  const i = prefs.pins.findIndex((p) => p.id === e.id);
  if (i >= 0) prefs.pins.splice(i, 1); else { prefs.pins.push(e); if (prefs.pins.length > 5) prefs.pins.shift(); }
  savePrefs(); paintPins();
}
function paintPins() {
  pinsEl.style.display = prefs.pins.length ? '' : 'none';
  pinsEl.replaceChildren(...prefs.pins.map((p) => msgEl(p, true)));
}
let unseen = 0;
const atBottom = () => feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 60;
function paintFeed() {
  const stick = atBottom();
  feedEl.replaceChildren(...chat.filter(chatShown).slice(-250).map((e) => msgEl(e)), newBtn);
  if (stick) { feedEl.scrollTop = feedEl.scrollHeight; unseen = 0; }
  paintNew();
}
function appendChat(list: ChatEvent[]) {
  const stick = atBottom();
  for (const e of list) if (chatShown(e)) { newBtn.before(msgEl(e)); if (!stick) unseen++; }
  while (feedEl.childElementCount > 300) feedEl.firstElementChild?.remove();
  if (stick) feedEl.scrollTop = feedEl.scrollHeight;
  paintNew();
}
function paintNew() { newBtn.style.display = unseen ? '' : 'none'; newBtn.textContent = `↓ ${unseen} new message${unseen === 1 ? '' : 's'}`; }
feedEl.addEventListener('scroll', () => { if (atBottom() && unseen) { unseen = 0; paintNew(); } });

function addChat(list: ChatEvent[]) {
  const fresh: ChatEvent[] = [];
  for (const e of list) {
    if (e.kind === 'delete') { chat = chat.filter((x) => !removedBy(e, x)); feedEl.dataset.dirty = '1'; continue; }
    if (e.kind === 'purge') { chat = chat.filter((x) => !removedBy(e, x)); feedEl.dataset.dirty = '1'; continue; }   // (shared/chatRemove.ts)
    if (e.cue || chatIds.has(e.id)) continue;
    chatIds.add(e.id); chat.push(e); fresh.push(e);
  }
  if (chat.length > MAX_CHAT) { for (const x of chat.splice(0, chat.length - MAX_CHAT)) chatIds.delete(x.id); }
  if (feedEl.dataset.dirty) { delete feedEl.dataset.dirty; paintFeed(); } else if (fresh.length) appendChat(fresh.sort((a, b) => a.ts - b.ts));
}

// ---------------------------------------------------------------- events column
const GROUPS: [HubGroup, string][] = [['money', 'Money'], ['subs', 'Subs'], ['raids', 'Raids'], ['follows', 'Follows'], ['other', 'Other']];
function paintEvBar() {
  evBar.replaceChildren(
    ...GROUPS.map(([g, l]) => chip(l, groupOn(g), () => { prefs.groups[g] = !groupOn(g); savePrefs(); paintEvBar(); paintEvents(); })),
    chip('Unread only', prefs.unreadOnly, () => { prefs.unreadOnly = !prefs.unreadOnly; savePrefs(); paintEvBar(); paintEvents(); }),
    h('div', { class: 'grow' }),
    h('button', { class: 'pri', title: 'A', onClick: () => void act('ack-next') }, '✓ Next'),
    h('button', { title: 'Mark every event read', onClick: () => void act('ack-all') }, '✓ All'));
}
const evShown = (i: HubItem) => groupOn(hubGroup(i.e)) && platOn(i.e.platform) && (!prefs.unreadOnly || !i.ack);
function evWhat(e: ChatEvent): (Node | string)[] {
  if (e.kind === 'system') return [e.ev === 'follow' ? 'New follower' : e.ev === 'share' ? 'Shared the stream' : e.ev === 'like' ? 'Likes' : e.ev === 'join' ? 'Joined' : e.ev === 'host' ? 'Host' : e.ev === 'reward' ? 'Channel points' : e.ev === 'back' ? 'Is now backing you' : 'Event'];
  const amt = e.fkind === 'tiktokGift' && e.giftName ? `${e.giftName} · ${e.display ?? ''}` : e.display && e.display !== 'Member' ? e.display : '';
  const usd = e.fkind && MONEY_KINDS.has(e.fkind) && e.currency !== 'usd' && (e.usd || e.approxUsd) ? ` (≈ $${(e.usd || e.approxUsd || 0).toFixed(2)})` : '';
  return [`${e.label ?? FINANCE_LABELS[e.fkind!] ?? ''} `, h('b', null, amt), usd, e.recipients?.length ? ` → ${e.recipients.slice(0, 5).join(', ')}${e.recipients.length > 5 ? '…' : ''}` : ''];
}
const TTS_LABEL: Record<string, string> = { queued: '🔊 in the reading queue', playing: '🔊 reading now…', done: '🔊 read', skipped: '🔇 skipped', filtered: '🔇 not read (filters)' };
function evEl(i: HubItem): HTMLElement {
  const e = i.e;
  const text = e.kind === 'finance' && e.text && !/^(gifted|resubscribed|subscribed|sent |is raiding|hosted with)/i.test(e.text) ? e.text : '';
  return h('div', { class: `ev${i.ack ? ' acked' : ''}${ttsStatus.now === e.id ? ' playing' : ''}`, style: `--tier:${e.tier ?? (e.kind === 'system' ? '#8fb8ff' : '#ffd84a')}`, 'data-id': e.id },
    h('div', { class: 'strip' }),
    h('div', { class: 'c' },
      h('div', { class: 'who' }, icon(e.platform), ' ', e.user, e.test ? h('span', { class: 'badge', style: 'margin-left:6px' }, 'TEST') : null),
      h('div', { class: 'what' }, ...evWhat(e)),
      text ? h('div', { class: 'txt' }, `“${text}”`) : null,
      h('div', { class: 'meta' }, `${PLAT_NAME[e.platform]} · ${clock(e.ts)} (${ago(e.ts)})`, i.tts ? ` · ${TTS_LABEL[i.tts] ?? ''}` : '', i.thanked ? ' · 📣 thanked on stream' : '')),
    h('div', { class: 'b' },
      h('button', { class: i.ack ? '' : 'pri', title: i.ack ? 'Mark unread' : 'Acknowledge (mark read)', onClick: () => void send('/api/chathub/ack', { id: e.id, ack: !i.ack }).catch((x) => toast((x as Error).message)) }, i.ack ? '↺' : '✓'),
      e.kind === 'finance' ? h('button', { title: 'Thank on stream: replays the alert / celebration in the room (+ acknowledges)', onClick: () => void send('/api/chathub/thank', { id: e.id }).then(() => toast(`Thanking ${e.user} on stream`)).catch((x) => toast((x as Error).message)) }, '📣') : null,
      e.kind === 'finance' && e.text && e.fkind !== 'raid' ? h('button', { title: i.tts === 'done' ? 'Read it again' : 'Read it aloud now', onClick: () => void send('/api/chathub/tts/read', { id: e.id }).catch((x) => toast((x as Error).message)) }, '🔊') : null));
}
function paintEvents() {
  const shown = items.filter(evShown);
  const unread = shown.filter((i) => !i.ack);            // oldest first: the next one to handle is on top
  const read = shown.filter((i) => i.ack).reverse().slice(0, 40);
  evList.replaceChildren(
    h('div', { class: 'sect' }, unread.length ? `To handle (${unread.length}) — oldest first` : 'All caught up ✓'),
    ...unread.map(evEl),
    read.length ? h('div', { class: 'sect' }, 'Done') : '',
    ...read.map(evEl));
  paintHeader();
}

// ---------------------------------------------------------------- text-to-speech panel
function paintTts() {
  const t = tts, s = ttsStatus;
  const nowItem = s.now ? items.find((i) => i.e.id === s.now) : null;
  const set = (p: Partial<TtsSettings>) => void send<TtsSettings>('/api/chathub/tts', p, 'PUT').then((x) => { tts = x; paintTts(); }).catch((e) => toast((e as Error).message));
  const cb = (label: string, v: boolean, f: (v: boolean) => void, title = '') => h('label', { title, style: 'display:flex;gap:6px;align-items:center' }, h('input', { type: 'checkbox', checked: v, onChange: (e: Event) => f((e.target as HTMLInputElement).checked) }), label);
  const numIn = (v: number, min: number, max: number, step: number, f: (v: number) => void) => h('input', { type: 'number', value: String(v), min: String(min), max: String(max), step: String(step), style: 'width:90px', onChange: (e: Event) => f(parseFloat((e.target as HTMLInputElement).value)) });
  const range = (v: number, min: number, max: number, step: number, f: (v: number) => void) => h('input', { type: 'range', value: String(v), min: String(min), max: String(max), step: String(step), onChange: (e: Event) => f(parseFloat((e.target as HTMLInputElement).value)) });
  const settings = prefs.ttsOpen ? h('div', { class: 'grid2' },
    h('span', null, 'Where it plays'), h('span', { style: 'color:var(--dim)' }, 'In your studio window, through the Audio mixer (its own volume and meter). Your stream hears it from there, like your guests. Keep the studio open.'),
    h('span', null, 'Minimum $'), numIn(t.minUsd, 0, 10000, 0.5, (v) => set({ minUsd: v })),
    h('span', null, 'Platforms'), h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' }, ...[...LIVE_PLATFORMS, 'test' as const].map((p) => cb(PLAT_NAME[p], t.platforms[p], (v) => set({ platforms: { ...t.platforms, [p]: v } })))),
    h('span', null, 'What'), h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' },
      cb('Subs / members with a message', t.subs, (v) => set({ subs: v })), cb('Only when they typed a message', t.onlyWithText, (v) => set({ onlyWithText: v })), cb('Say who + amount', t.readName, (v) => set({ readName: v }))),
    h('span', null, 'Filters'), h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' }, cb('Bleep swear words', t.profanity, (v) => set({ profanity: v })), cb('Say “link” for links', t.urls, (v) => set({ urls: v }))),
    h('span', null, 'Max characters'), numIn(t.maxChars, 20, 500, 10, (v) => set({ maxChars: v })),
    ...engineRow(t, set),
    ...(t.engine === 'kokoro' ? kokoroRows(t, set) : []),
    h('span', null, t.engine === 'kokoro' ? 'Backup voice' : 'Computer voice'), h('div', { style: 'display:flex;gap:6px;min-width:0' },
      h('select', { style: 'min-width:0', onChange: (e: Event) => set({ voice: (e.target as HTMLSelectElement).value }) }, h('option', { value: '' }, 'Default Windows voice'), ...s.voices.map((v) => h('option', { value: v, selected: v === t.voice }, v))),
      h('button', { onClick: () => void get<{ voices: string[]; status: HubTtsStatus }>('/api/chathub/tts/voices').then((r) => { ttsStatus = r.status; paintTts(); }).catch((e) => toast((e as Error).message)) }, 'Find voices')),
    t.engine === 'kokoro' ? null : h('span', null, `Speed ${t.rate.toFixed(2)}×`), t.engine === 'kokoro' ? null : range(t.rate, 0.5, 2, 0.05, (v) => set({ rate: v })),
    h('span', null, `Volume ${Math.round(t.volume * 100)}%`), range(t.volume, 0, 1, 0.05, (v) => set({ volume: v })),
    h('span', null, 'Pause between'), numIn(t.gapMs / 1000, 0, 5, 0.1, (v) => set({ gapMs: Math.round(v * 1000) })),
    h('span', null, ''), h('div', { style: 'display:flex;gap:6px' }, h('button', { onClick: () => void send<{ skipped?: boolean; message?: string }>('/api/chathub/tts/say', {}).then((r) => toast(r.skipped ? 'Skipped: nothing this voice can say' : 'Playing in your studio window')).catch((e) => toast((e as Error).message)) }, 'Test voice')),
  ) : null;
  ttsEl.replaceChildren(
    h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
      h('b', null, 'Read support messages aloud'),
      h('button', { class: t.on ? 'on' : '', onClick: () => set({ on: !t.on }) }, t.on ? 'ON' : 'OFF'),
      h('span', { style: 'color:var(--dim)' }, t.on ? `plays in the studio · from $${t.minUsd}${t.engine === 'kokoro' ? ' · Kokoro' : ''}` : 'off (default)'),
      h('div', { class: 'grow' }),
      h('button', { title: 'S', disabled: !s.now, onClick: () => void act('skip') }, '⏭ Skip'),
      h('button', { title: 'R', onClick: () => void act('replay') }, '↻ Replay'),
      h('button', { onClick: () => { prefs.ttsOpen = !prefs.ttsOpen; savePrefs(); paintTts(); if (prefs.ttsOpen && !ttsStatus.voices.length) void get<{ status: HubTtsStatus }>('/api/chathub/tts/voices').then((r) => { ttsStatus = r.status; paintTts(); }).catch(() => {}); } }, prefs.ttsOpen ? 'Hide settings' : 'Settings')),
    nowItem ? h('div', { class: 'now' }, `🔊 Reading: ${nowItem.e.user} — ${nowItem.e.text}`) : s.queue.length ? h('div', { class: 'now' }, `${s.queue.length} waiting`) : "",
    s.error ? h('div', { class: 'note', style: 'color:#ff9b9b' }, `Voice problem: ${s.error}`) : "",
    voiceNote(t, s) ?? "",
    settings ?? "");
  if (prefs.ttsOpen && t.engine === 'kokoro') ensureKokoro(paintTts);
}

// ---------------------------------------------------------------- actions + keys
async function act(a: string) {
  try { await send(`/api/chathub/do/${a}`, {}); } catch (e) { toast((e as Error).message); }
}
document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'a') void act('ack-next'); else if (k === 't') void act('thank-next'); else if (k === 's') void act('skip'); else if (k === 'r') void act('replay');
  else if (k === '+' || k === '=') setFs(prefs.fs + 2); else if (k === '-') setFs(prefs.fs - 2);
  else return;
  e.preventDefault();
});
function layout() { mainEl.className = prefs.showEvents ? '' : 'noev'; evCol.style.display = prefs.showEvents ? '' : 'none'; paintChatBar(); }

// ---------------------------------------------------------------- data
function mergeItems(list: HubItem[]) {
  for (const it of list) {
    const e = sanitizeChatEvent(it.e);
    if (!e) continue;
    const x: HubItem = { e, ack: !!it.ack, thanked: !!it.thanked, tts: it.tts ?? '' };
    const i = items.findIndex((y) => y.e.id === e.id);
    if (i >= 0) items[i] = x; else items.push(x);
  }
  items.sort((a, b) => a.e.ts - b.e.ts);
  if (items.length > 300) items.splice(0, items.length - 300);
  paintEvents();
}
const bus = new Bus('control');
// (re)connected: read the status again (the helper only broadcasts changes; one sent while this socket was down is lost)
bus.onLink((up) => { if (up) void get<ChatStatus>('/api/chat/status').then((st) => { status = st; paintHeader(); }).catch(() => {}); });
bus.on((m) => {
  if (m.type === 'chat') {
    const evs = (Array.isArray(m.evs) ? m.evs : []).map(sanitizeChatEvent).filter((e): e is ChatEvent => !!e);
    const t = sanitizeTotals(m.tot); if (t) totals = t;
    addChat(evs); if (t) paintHeader();
  } else if (m.type === 'chatStatus') { status = m.status; paintHeader(); }
  else if (m.type === 'chathub') {
    const x = m.m;
    if (x.k === 'items') mergeItems(x.items);
    else if (x.k === 'ttsStatus') { ttsStatus = { ...x.s, voices: x.s.voices.length ? x.s.voices : ttsStatus.voices }; if (x.tts) tts = x.tts; paintTts(); paintEvents(); }
  }
});
async function load() {
  try {
    const [r, st, snap] = await Promise.all([
      get<{ evs: unknown[]; tot: unknown }>('/api/chat/recent?n=160'), get<ChatStatus>('/api/chat/status'), get<HubSnapshot>('/api/chathub/state')]);
    totals = sanitizeTotals(r.tot) ?? null;
    addChat((r.evs ?? []).map(sanitizeChatEvent).filter((e): e is ChatEvent => !!e).sort((a, b) => a.ts - b.ts));
    status = st;
    tts = snap.tts; ttsStatus = snap.ttsStatus; deckKey = snap.deckKey;
    items = []; mergeItems(snap.items);
  } catch (e) { toast(`Chat server not reachable: ${(e as Error).message}`); }
  paintHeader(); paintTts();
}
layout(); paintPins(); paintEvBar(); paintTts(); paintEvents();
void load().then(() => {
  // chathub.html?connect=1 opens the setup wizard (Scene tab → "Connect your chats"), ?deck=1 the Stream Deck URLs
  const q = new URLSearchParams(location.search);
  if (q.has('connect')) lightsEl.click(); else if (q.has('deck')) openDeck(deckKey);
});
setInterval(() => { if (!document.hidden) paintEvents(); }, 30_000);   // "3m ago" labels
(window as unknown as { chathub: unknown }).chathub = { get items() { return items; }, get chat() { return chat; }, get tts() { return tts; }, get ttsStatus() { return ttsStatus; }, act };
