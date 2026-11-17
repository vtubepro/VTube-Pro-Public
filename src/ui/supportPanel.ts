// "Support & store" (beta.13): every way viewers support the show, in one page over the studio.
//   Services   one card per service: Connect → paste the key (on this PC, in VTube Pro's own key page)
//              or "Get my address" for webhooks → "Send a test" → ✓. Plain words, no key ever shown back.
//   Live feed  every tip / order / patron / gift as it arrives, test badges, "while you were away", messages waiting for
//              approval (Approve / Hide), remove (refund), add one by hand.
//   Store      Fourthwall: products on stream (featured or rotating, where), purchase cards, show / hide in the shop,
//              a timed promo code, the featured collection. Every change to the live store is confirmed first.
//   Supporters patrons / members and their chat names (automatic, !link codes, requests to confirm, by hand).
//   Settings   currency, bits value, buyer names, message approval, blocklist, test mode, missed alerts, webhook inbox.
// Opened from the Tools menu (registerSupportTool, one line in src/ui/laneWiring.ts). Data: /api/support/* (the helper,
// server/support/routes.ts) + the bus ({type:'support' | 'support-mod' | 'supportStatus' | 'supportShow' | 'supporters'}).
import type { App } from '../app.ts';
import type { BusMessage } from '../../shared/types.ts';
import { PLATFORM_COLORS, SUPPORT_PLATFORM_NAMES } from '../../shared/chat.ts';
import type { SupportEvent } from '../../shared/support.ts';
import {
  SERVICE_INFO, SUPPORT_SERVICES, moneyText, supportImg,
  type ServiceStatus, type StoreProduct, type StoreSnapshot, type SupportService, type SupportSettings, type SupportStatus,
} from '../../shared/supportConfig.ts';
import { h, toast } from './dom.ts';
import { icon } from './icons.ts';

export type SupportTab = 'services' | 'feed' | 'store' | 'supporters' | 'settings';
type Tab = SupportTab;
interface LoggedEvent extends SupportEvent { voided?: string }
interface Member { linkedId: string; name: string; source: string; tier: string; rank: number; cents?: number; since: string; active: boolean; links: { platform: string; login: string; userId: string; how: string }[] }
interface Claim { id: string; chat: { platform: string; login: string }; said: string; at: number; suggest: string }

const SERVICE_COLOR = (s: string) => (PLATFORM_COLORS as Record<string, string>)[s] ?? '#9146ff';
const sourceName = (s: string) => (SUPPORT_PLATFORM_NAMES as Record<string, string>)[s] ?? ({ twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick', rumble: 'Rumble', tiktok: 'TikTok' } as Record<string, string>)[s] ?? s;
const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'BRL', 'MXN', 'SEK', 'NOK', 'DKK', 'PLN', 'CHF', 'NZD', 'SGD', 'HKD', 'KRW', 'INR', 'PHP', 'ZAR'];

async function call<T = Record<string, unknown>>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j: Record<string, unknown> = {};
  try { j = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new Error(String(j.error || `That didn’t work (${r.status}). Try again.`));
  return j as T;
}

const CSS = `
.sp-back { position: fixed; inset: 0; z-index: 880; background: #0009; display: grid; place-items: center; padding: 16px; }
.sp { width: min(1120px, 100%); height: min(860px, calc(100vh - 32px)); display: grid; grid-template-rows: auto auto minmax(0, 1fr); background: var(--panel); color: var(--text);
  border: 1px solid var(--line2); border-radius: 18px; box-shadow: 0 30px 80px -20px #000c; overflow: hidden; font: 13.5px/1.45 var(--font-ui, "Segoe UI", system-ui, sans-serif); }
.sp-head { display: flex; align-items: center; gap: 12px; padding: 14px 14px 10px 20px; }
.sp-head .ic { width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center; background: color-mix(in srgb, #ff5c8a 18%, transparent); color: #ff7aa2; flex: none; }
.sp-head b { font: 700 19px/1.15 var(--font-display, inherit); display: block; }
.sp-head small { color: var(--dim); font-size: 12.5px; }
.sp-head .sp-sp { flex: 1; }
.sp-btn { height: 34px; padding: 0 13px; border-radius: 9px; border: 1px solid var(--line2); background: var(--card2); color: var(--text); font: 600 13px/1 var(--font-ui, "Segoe UI", system-ui, sans-serif); cursor: pointer; display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
.sp-btn:hover { background: var(--card3); }
.sp-btn.pri { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
.sp-btn.warn { color: var(--err); }
.sp-btn:disabled { opacity: .55; cursor: progress; }
.sp-btn:focus-visible, .sp input:focus-visible, .sp select:focus-visible, .sp textarea:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.sp-x { width: 36px; padding: 0; justify-content: center; }
.sp-tabs { display: flex; gap: 4px; padding: 0 16px; border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: none; }
.sp-tabs button { border: 0; background: none; color: var(--dim); font: 600 13.5px/1 var(--font-ui, "Segoe UI", system-ui, sans-serif); padding: 11px 12px 12px; border-bottom: 2px solid transparent; cursor: pointer; white-space: nowrap; display: inline-flex; gap: 6px; align-items: center; }
.sp-tabs button[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
.sp-tabs .n { background: var(--err); color: #fff; border-radius: 99px; font-size: 11px; padding: 2px 6px; }
.sp-body { overflow: auto; overscroll-behavior: contain; padding: 16px 18px 24px; }
.sp-note { color: var(--dim); font-size: 12.5px; margin: 0 0 12px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.sp-note .pill { border: 1px solid var(--line2); border-radius: 99px; padding: 3px 9px; }
.sp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.sp-card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px; display: grid; gap: 8px; align-content: start; }
.sp-card.live { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.sp-card h3 { margin: 0; font: 700 15px/1.2 var(--font-ui, "Segoe UI", system-ui, sans-serif); display: flex; align-items: center; gap: 9px; }
.sp-dot { width: 11px; height: 11px; border-radius: 50%; flex: none; }
.sp-chip { margin-left: auto; font: 600 11.5px/1 var(--font-ui, "Segoe UI", system-ui, sans-serif); padding: 4px 8px; border-radius: 99px; background: var(--card2); color: var(--dim); white-space: nowrap; }
.sp-chip.live { background: var(--accent-soft); color: var(--accent); }
.sp-chip.error { background: var(--err-soft); color: var(--err); }
.sp-chip.waiting, .sp-chip.connecting { background: var(--warn-soft); color: var(--warn); }
.sp-what { color: var(--dim); margin: 0; }
.sp-detail { margin: 0; font-size: 12.5px; }
.sp-detail.error { color: var(--err); }
.sp-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.sp ol { margin: 2px 0; padding-left: 20px; color: var(--dim); }
.sp label.f { display: grid; gap: 4px; font-size: 12.5px; color: var(--dim); }
.sp input[type=text], .sp input[type=password], .sp input[type=number], .sp select, .sp textarea { font: inherit; color: var(--text); background: var(--input); border: 1px solid var(--line2); border-radius: 9px; padding: 9px 10px; min-width: 0; }
.sp textarea { min-height: 70px; resize: vertical; }
.sp-addr { display: flex; gap: 8px; align-items: center; }
.sp-addr code { flex: 1; min-width: 0; font: 12px ui-monospace, Consolas, monospace; background: var(--input); border: 1px solid var(--line); border-radius: 8px; padding: 8px; word-break: break-all; }
.sp-may { font-size: 11.5px; color: var(--warn); }
.sp-feed { display: grid; gap: 8px; }
.sp-ev { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: start; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
.sp-ev.voided { opacity: .55; }
.sp-ev.voided .who { text-decoration: line-through; }
.sp-ev .who { font-weight: 700; }
.sp-ev .amt { font-weight: 800; color: var(--accent); }
.sp-ev .meta { color: var(--dim); font-size: 12px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.sp-ev .msg { margin-top: 4px; overflow-wrap: anywhere; }
.sp-ev .msg.pending { background: var(--warn-soft); border-radius: 8px; padding: 6px 8px; }
.sp-ev .msg.hidden { color: var(--faint); font-style: italic; }
.sp-ev .thumb { width: 44px; height: 44px; border-radius: 9px; object-fit: cover; background: var(--card2); }
.sp-badge { font: 700 10.5px/1 var(--font-ui, "Segoe UI", system-ui, sans-serif); letter-spacing: .04em; text-transform: uppercase; border-radius: 6px; padding: 3px 6px; background: var(--card3); color: var(--dim); }
.sp-badge.test { background: var(--accent2-soft); color: var(--accent2); }
.sp-badge.away { background: var(--warn-soft); color: var(--warn); }
.sp-empty { text-align: center; color: var(--dim); padding: 40px 12px; display: grid; gap: 12px; justify-items: center; }
.sp-prods { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.sp-prod { background: var(--card); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; display: grid; }
.sp-prod.feat { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.sp-prod img, .sp-prod .ph { width: 100%; aspect-ratio: 1; object-fit: cover; background: var(--card2); display: grid; place-items: center; color: var(--faint); font-size: 30px; }
.sp-prod .b { padding: 10px; display: grid; gap: 6px; }
.sp-prod .nm { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp-prod .pr { color: var(--accent); font-weight: 800; }
.sp-prod .st { font-size: 11.5px; color: var(--dim); }
.sp-section { margin: 18px 0 8px; font: 700 14px/1.2 var(--font-ui, "Segoe UI", system-ui, sans-serif); display: flex; gap: 10px; align-items: center; }
.sp-section small { font-weight: 500; color: var(--dim); }
.sp-opts { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px 16px; }
.sp-tog { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; }
.sp-tog input { margin-top: 3px; width: 17px; height: 17px; accent-color: var(--accent); }
.sp-tog span small { display: block; color: var(--dim); font-size: 12px; }
.sp-seg { display: inline-flex; border: 1px solid var(--line2); border-radius: 9px; overflow: hidden; }
.sp-seg button { white-space: nowrap; border: 0; background: var(--card2); color: var(--dim); padding: 8px 11px; font: 600 12.5px/1 var(--font-ui, "Segoe UI", system-ui, sans-serif); cursor: pointer; }
.sp-seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
.sp-code { font: 800 26px/1 ui-monospace, Consolas, monospace; letter-spacing: .12em; color: var(--accent); }
.sp-confirm { position: fixed; inset: 0; z-index: 890; background: #000a; display: grid; place-items: center; padding: 16px; }
.sp-confirm > div { width: min(440px, 100%); background: var(--panel); border: 1px solid var(--line2); border-radius: 16px; padding: 18px; display: grid; gap: 10px; box-shadow: var(--shadow); color: var(--text); }
.sp-confirm b { font-size: 16px; }
.sp-confirm p { margin: 0; color: var(--dim); }
@media (max-width: 640px) {
  .sp-back { padding: 0; }
  .sp { height: 100vh; border-radius: 0; border: 0; }
  .sp-head { padding: 10px 10px 8px 14px; }
  .sp-head small { display: none; }
  .sp-head .sp-test { display: none; }
  .sp-body { padding: 12px; }
  .sp-grid { grid-template-columns: 1fr; }
  .sp-ev { grid-template-columns: auto minmax(0, 1fr); }
  .sp-ev .acts { grid-column: 1 / -1; }
  .sp-prods { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}`;

let openClose: (() => void) | null = null;

/** Ask before changing the live store (or anything else that can't be undone from here). */
function confirmSheet(title: string, text: string, yes: string): Promise<boolean> {
  return new Promise((res) => {
    const done = (v: boolean) => { el.remove(); window.removeEventListener('keydown', key, true); res(v); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    const el = h('div', { class: 'sp-confirm', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onClick: (e: Event) => { if (e.target === el) done(false); } },
      h('div', null, h('b', null, title), h('p', null, text),
        h('div', { class: 'sp-row', style: 'justify-content:flex-end' }, h('button', { class: 'sp-btn', onClick: () => done(false) }, 'Cancel'), h('button', { class: 'sp-btn pri', onClick: () => done(true) }, yes))));
    document.body.append(el);
    window.addEventListener('keydown', key, true);
    (el.querySelector('.pri') as HTMLButtonElement | null)?.focus();
  });
}

export function openSupport(app: App | null, tab: Tab = 'services') {
  if (openClose) { openClose(); }
  if (!document.getElementById('vtp-sp-css')) document.head.append(h('style', { id: 'vtp-sp-css' }, CSS));
  let cur: Tab = tab;
  let status: SupportStatus | null = null;
  let settings: SupportSettings | null = null;
  let events: LoggedEvent[] = [];
  let store: (StoreSnapshot & { promos: { id: string; code: string; endsAt: string }[] }) | null = null;
  let members: Member[] = [];
  let claims: Claim[] = [];
  let problem = '';
  const openCards = new Set<SupportService>();
  const addresses = new Map<SupportService, string>();
  const body = h('div', { class: 'sp-body' });
  const tabs = h('div', { class: 'sp-tabs', role: 'tablist' });
  const page = h('div', { class: 'sp', role: 'dialog', 'aria-label': 'Support & store', 'data-ui': 'support-store' },
    h('div', { class: 'sp-head' },
      h('span', { class: 'ic' }, icon('gift', 20)),
      h('span', null, h('b', null, 'Support & store'), h('small', null, 'Tips, merch, patrons and wishlists, all in one place')),
      h('span', { class: 'sp-sp' }),
      h('button', { class: 'sp-btn sp-test', title: 'Sends a test from every service: test events never count toward goals', onClick: () => void sendTest('all') }, icon('play', 15), 'Send a test of everything'),
      h('button', { class: 'sp-btn sp-x', 'aria-label': 'Close', title: 'Close (Esc)', onClick: () => close() }, icon('x', 16))),
    tabs, body);
  const back = h('div', { class: 'sp-back', onClick: (e: Event) => { if (e.target === back) close(); } }, page);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.sp-confirm')) { e.preventDefault(); close(); } };
  let offBus: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const close = () => {
    if (openClose !== close) return;
    openClose = null;
    window.removeEventListener('keydown', onKey, true);
    offBus?.(); if (timer) clearInterval(timer);
    back.remove();
  };
  openClose = close;
  document.body.append(back);
  window.addEventListener('keydown', onKey, true);

  // ---------------------------------------------------------------- data
  const load = async () => {
    try {
      [status, settings] = await Promise.all([call<SupportStatus>('/api/support/status'), call<SupportSettings>('/api/support/settings')]);
      problem = '';
    } catch (e) { problem = (e as Error).message; }
    render();
    void loadFeed(); void loadStore(); void loadSupporters();
  };
  const loadFeed = async () => { try { events = ((await call<{ events: LoggedEvent[] }>('/api/support/events?n=150')).events ?? []).reverse(); if (cur === 'feed') render(); renderTabs(); } catch { /* shown by load */ } };
  const loadStore = async () => { try { store = await call('/api/support/store'); if (cur === 'store') render(); } catch { /* */ } };
  const loadSupporters = async () => { try { const r = await call<{ members?: Member[]; claims?: Claim[] }>('/api/support/supporters?full=1'); members = r.members ?? []; claims = r.claims ?? []; if (cur === 'supporters') render(); renderTabs(); } catch { /* */ } };
  if (app) {
    offBus = app.bus.on((m: BusMessage) => {
      if (m.type === 'support') { events = [m.ev, ...events.filter((e) => e.id !== m.ev.id)].slice(0, 200); if (cur === 'feed') render(); renderTabs(); }
      else if (m.type === 'support-mod') { const e = events.find((x) => x.id === m.id); if (e?.message) { e.message = { ...e.message, moderated: m.moderated }; if (cur === 'feed') render(); renderTabs(); } }
      else if (m.type === 'supportStatus') { status = m.s; if (cur === 'services' && !body.contains(document.activeElement)) render(); }
      else if (m.type === 'supporters') { void loadSupporters(); }
      else if (m.type === 'support-void') { const e = events.find((x) => x.id === m.id); if (e) { e.voided = m.why; if (cur === 'feed') render(); } }
    }) as unknown as () => void;
  } else timer = setInterval(() => void loadFeed(), 5000);
  const saveSettings = async (patch: Record<string, unknown>, msg = 'Saved') => {
    try { settings = await call<SupportSettings>('/api/support/settings', 'PUT', patch); toast(msg, 'ok', 1800); render(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const sendTest = async (which: string) => {
    try { const r = await call<{ sent: number }>('/api/support/test', 'POST', { which }); toast(r.sent ? `Test sent (${r.sent}). Watch your stream preview and the Live feed.` : 'Sent.', 'ok'); } catch (e) { toast((e as Error).message, 'err'); }
  };

  // ---------------------------------------------------------------- tabs
  const pending = () => events.filter((e) => e.message?.moderated === 'pending' && !e.voided).length;
  const renderTabs = () => {
    const list: [Tab, string, number][] = [['services', 'Services', 0], ['feed', 'Live feed', pending()], ['store', 'Store', 0], ['supporters', 'Supporters', claims.length], ['settings', 'Settings', 0]];
    tabs.replaceChildren(...list.map(([id, label, n]) => h('button', { role: 'tab', 'aria-selected': String(cur === id), 'data-tab': id, onClick: () => { cur = id; renderTabs(); render(); body.scrollTop = 0; } }, label, n ? h('span', { class: 'n' }, String(n)) : null)));
  };
  const render = () => {
    renderTabs();
    if (problem) { body.replaceChildren(h('div', { class: 'sp-empty' }, h('b', null, 'Support & store isn’t reachable'), h('span', null, problem), h('button', { class: 'sp-btn pri', onClick: () => void load() }, 'Try again'))); return; }
    if (!status || !settings) { body.replaceChildren(h('div', { class: 'sp-empty' }, 'Loading…')); return; }
    const y = body.scrollTop;
    body.replaceChildren(cur === 'services' ? services() : cur === 'feed' ? feed() : cur === 'store' ? storeTab() : cur === 'supporters' ? supporters() : settingsTab());
    body.scrollTop = y;
  };

  // ---------------------------------------------------------------- Services
  const chipOf = (s: ServiceStatus) => !s.enabled ? ['off', 'Not connected'] : s.state === 'live' ? ['live', 'Connected ✓'] : s.state === 'error' ? ['error', 'Needs a fix'] : s.state === 'connecting' ? ['connecting', 'Connecting…'] : ['waiting', 'Almost there'];
  const services = () => {
    const st = status!;
    const note = h('p', { class: 'sp-note' },
      h('span', { class: 'pill' }, `Keys: ${st.vault.label}`),
      st.inbox.state !== 'off' ? h('span', { class: 'pill' }, `Webhooks: ${st.inbox.state === 'connected' ? 'connected ✓' : st.inbox.detail || st.inbox.state}`) : null,
      h('span', null, 'Keys never leave this computer and are never shown again.'));
    return h('div', null, note, h('div', { class: 'sp-grid' }, ...SUPPORT_SERVICES.map((id) => serviceCard(id, st.services[id]))));
  };
  const serviceCard = (id: SupportService, s: ServiceStatus) => {
    const info = SERVICE_INFO[id];
    const [cls, label] = chipOf(s);
    const open = openCards.has(id) || (s.enabled && s.state !== 'live');
    const out = h('p', { class: 'sp-detail', role: 'status' });
    const card = h('div', { class: `sp-card${s.enabled && s.state === 'live' ? ' live' : ''}`, 'data-service': id },
      h('h3', null, h('span', { class: 'sp-dot', style: `background:${SERVICE_COLOR(id)}` }), info.name, h('span', { class: `sp-chip ${cls}` }, label)),
      h('p', { class: 'sp-what' }, info.what),
      s.enabled && s.detail ? h('p', { class: `sp-detail${s.state === 'error' ? ' error' : ''}` }, s.detail) : null,
      info.unofficial ? h('span', { class: 'sp-may' }, 'Unofficial: may break when the service changes.') : null);
    if (!open && !s.enabled) {
      card.append(h('div', { class: 'sp-row' }, h('button', { class: 'sp-btn pri', 'data-act': 'connect', onClick: () => { openCards.add(id); render(); } }, 'Connect'), h('button', { class: 'sp-btn', onClick: () => void sendTest(id) }, 'See a test')));
      return card;
    }
    if (open) card.append(h('ol', null, ...info.steps.map((t) => h('li', null, t))));
    // keys: typed here on this PC
    const inputs: HTMLInputElement[] = [];
    if (open && info.secrets.length) {
      for (const f of info.secrets) {
        const inp = h('input', { type: 'password', autocomplete: 'off', spellcheck: false, placeholder: s.saved.includes(f.key) ? '•••••• saved (paste to replace)' : f.optional ? '(optional)' : 'Paste it here', 'aria-label': f.label }) as HTMLInputElement;
        inp.dataset.key = f.key;
        inputs.push(inp);
        card.append(h('label', { class: 'f' }, h('span', null, f.label, ' · ', f.hint), inp, f.where ? h('a', { href: f.where, target: '_blank', rel: 'noopener noreferrer' }, 'Open the page where you find it ↗') : null));
      }
    }
    if (open && id === 'throne') {
      const cr = h('input', { type: 'text', value: settings!.services.throne.creatorId ?? '', placeholder: 'your Throne username', 'aria-label': 'Your Throne username' }) as HTMLInputElement;
      card.append(h('label', { class: 'f' }, h('span', null, 'Your Throne username · only gifts for you are accepted'), cr));
      cr.addEventListener('change', () => void saveSettings({ services: { throne: { creatorId: cr.value } } }, 'Saved your Throne name'));
    }
    if (id === 'fourthwall' && (open || s.enabled)) {
      const shop = h('input', { type: 'text', value: settings!.services.fourthwall.shopUrl ?? '', placeholder: 'https://yourshop.fourthwall.com', 'aria-label': 'Your shop address' }) as HTMLInputElement;
      card.append(h('label', { class: 'f' }, h('span', null, 'Your shop address · for the “scan to shop” code on stream'), shop));
      shop.addEventListener('change', () => void saveSettings({ services: { fourthwall: { shopUrl: shop.value.trim() } } }, 'Saved your shop address'));
    }
    if (open && info.how.includes('hook')) {
      const addr = h('div', { class: 'sp-addr' });
      const have = addresses.get(id);
      if (have) addr.append(h('code', null, have), h('button', { class: 'sp-btn', onClick: () => { void navigator.clipboard.writeText(have).then(() => toast(`Copied. Paste it into ${info.name}.`, 'ok')).catch(() => toast('Select the address and copy it.', 'warn')); } }, icon('copy', 14), 'Copy'));
      card.append(h('div', { class: 'sp-row' }, h('button', { class: `sp-btn${info.secrets.length ? '' : ' pri'}`, 'data-act': 'address', onClick: async (e: Event) => {
        const b = e.currentTarget as HTMLButtonElement; b.disabled = true;
        try { const r = await call<{ url: string }>('/api/support/inbox', 'POST', { service: id }); addresses.set(id, r.url); if (!settings!.services[id].enabled) await call('/api/support/settings', 'PUT', { services: { [id]: { enabled: true } } }); toast(`Your address is ready. Paste it into ${info.name}.`, 'ok'); settings = await call('/api/support/settings'); }
        catch (err) { toast((err as Error).message, 'err', 7000); }
        b.disabled = false; render();
      } }, s.hook ? 'Show my address' : 'Get my address')), addr);
    }
    const btns = h('div', { class: 'sp-row' });
    if (open && inputs.length) btns.append(h('button', { class: 'sp-btn pri', 'data-act': 'save', onClick: async (e: Event) => {
      const fields: Record<string, string> = {};
      for (const i of inputs) if (i.value.trim()) fields[i.dataset.key!] = i.value.trim();
      if (!Object.keys(fields).length) { out.className = 'sp-detail error'; out.textContent = 'Paste the key first.'; return; }
      const b = e.currentTarget as HTMLButtonElement; b.disabled = true; out.className = 'sp-detail'; out.textContent = 'Checking…';
      try { const r = await call<ServiceStatus>(`/api/support/secrets/${id}`, 'PUT', { fields }); for (const i of inputs) i.value = ''; out.className = `sp-detail${r.state === 'error' ? ' error' : ''}`; out.textContent = r.state === 'error' ? r.detail : `${r.detail || 'Saved ✓'} Now press “Send a test”.`; status = await call('/api/support/status'); settings = await call('/api/support/settings'); openCards.delete(id); if (r.state !== 'error') setTimeout(render, 1200); }
      catch (err) { out.className = 'sp-detail error'; out.textContent = (err as Error).message; }
      b.disabled = false;
    } }, s.saved.length ? 'Save and reconnect' : 'Connect'));
    btns.append(h('button', { class: 'sp-btn', 'data-act': 'test', onClick: () => void sendTest(id) }, 'Send a test'));
    if (!open && s.enabled) btns.append(h('button', { class: 'sp-btn', title: 'Keys, webhook address, steps', onClick: () => { openCards.add(id); render(); } }, info.how.includes('hook') ? 'Address & keys' : 'Change key'));
    if (s.enabled || s.saved.length) btns.append(h('button', { class: 'sp-btn warn', onClick: async () => {
      if (!(await confirmSheet(`Disconnect ${info.name}?`, 'Its keys are removed from this computer. Events you already got stay in your feed and goals.', 'Disconnect'))) return;
      try { await call(`/api/support/secrets/${id}`, 'DELETE'); status = await call('/api/support/status'); settings = await call('/api/support/settings'); render(); } catch (err) { toast((err as Error).message, 'err'); }
    } }, 'Disconnect'));
    else if (open) btns.append(h('button', { class: 'sp-btn', onClick: () => { openCards.delete(id); render(); } }, 'Not now'));
    if (open && s.enabled && openCards.has(id)) btns.append(h('button', { class: 'sp-btn', onClick: () => { openCards.delete(id); render(); } }, 'Done'));
    card.append(btns, out);
    return card;
  };

  // ---------------------------------------------------------------- Live feed
  let feedFilter: 'all' | 'pending' = 'all';
  const money = (e: SupportEvent) => {
    if (e.kind === 'bits') return `${(e.units?.bits ?? e.amount?.minor ?? 0).toLocaleString()} bits`;
    const d = e.display, a = e.amount;
    if (!a && !d) return e.units?.gifted ? `${e.units.gifted} gifted` : e.units?.months && e.kind === 'sub' ? `${e.units.months} months` : '';
    const main = d ? moneyText(d.minor, d.currency) : moneyText(a!.minor, a!.currency);
    return a && d && a.currency !== d.currency ? `${main} (${moneyText(a.minor, a.currency)})` : main;
  };
  const kindOf = (e: SupportEvent) => (e.kind === 'superchat' && e.source === 'rumble' ? 'Rant' : kindWord[e.kind] ?? '');
  const kindWord: Record<string, string> = { tip: 'tip', purchase: 'bought', membership: 'joined', sub: 'subscribed', gift: 'gifted', bits: 'cheered', superchat: 'Super Chat', wishlist_gift: 'gifted from your wishlist', redemption: 'redeemed', other: '' };
  const feed = () => {
    const list = events.filter((e) => feedFilter === 'all' || (e.message?.moderated === 'pending' && !e.voided));
    const head = h('div', { class: 'sp-row', style: 'margin-bottom:12px' },
      h('div', { class: 'sp-seg', role: 'group', 'aria-label': 'Show' },
        h('button', { 'aria-pressed': String(feedFilter === 'all'), onClick: () => { feedFilter = 'all'; render(); } }, 'Everything'),
        h('button', { 'aria-pressed': String(feedFilter === 'pending'), onClick: () => { feedFilter = 'pending'; render(); } }, `Waiting for you (${pending()})`)),
      h('span', { class: 'sp-sp', style: 'flex:1' }),
      h('button', { class: 'sp-btn', onClick: () => addByHand() }, icon('edit', 14), 'Add one by hand'));
    if (!list.length) return h('div', null, head, h('div', { class: 'sp-empty' }, h('b', null, feedFilter === 'pending' ? 'Nothing is waiting for you' : 'No support yet today'), h('span', null, feedFilter === 'pending' ? 'Messages you hold for approval show up here.' : 'Connect a service, or press “Send a test of everything” to see how it looks on stream.'), feedFilter === 'all' ? h('button', { class: 'sp-btn pri', onClick: () => void sendTest('all') }, 'Send a test of everything') : null));
    return h('div', null, head, h('div', { class: 'sp-feed' }, ...list.slice(0, 150).map(evRow)));
  };
  const evRow = (e: LoggedEvent) => {
    const t = new Date(e.receivedAt || e.occurredAt);
    const item = e.item ? `${e.item.qty && e.item.qty > 1 ? `${e.item.qty}× ` : ''}${e.item.name}` : '';
    const thumb = e.item?.imageUrl ? supportImg(e.item.imageUrl) : '';
    const m = e.message;
    const acts = h('div', { class: 'acts sp-row' });
    if (m && !e.voided) {
      if (m.moderated === 'pending') acts.append(h('button', { class: 'sp-btn pri', 'data-act': 'approve', onClick: () => void mod(e.id, 'ok') }, 'Approve'), h('button', { class: 'sp-btn', onClick: () => void mod(e.id, 'hidden') }, 'Hide'));
      else if (m.moderated === 'ok') acts.append(h('button', { class: 'sp-btn', title: 'Hide this message everywhere', onClick: () => void mod(e.id, 'hidden') }, 'Hide message'));
      else acts.append(h('button', { class: 'sp-btn', onClick: () => void mod(e.id, 'ok') }, 'Show message'));
    }
    if (!e.voided && !e.test) acts.append(h('button', { class: 'sp-btn', title: 'Refunded or a mistake: goals stop counting it', onClick: async () => { if (await confirmSheet('Remove this from your goals?', 'Use this for a refund or a mistake. It stays in the feed, crossed out.', 'Remove')) { try { await call('/api/support/void', 'POST', { id: e.id, why: 'removed' }); e.voided = 'removed'; render(); } catch (err) { toast((err as Error).message, 'err'); } } } }, 'Remove'));
    return h('div', { class: `sp-ev${e.voided ? ' voided' : ''}`, 'data-ev': e.id },
      thumb ? h('img', { class: 'thumb', src: thumb, alt: '', loading: 'lazy', onError: (ev: Event) => { (ev.target as HTMLElement).replaceWith(h('span', { class: 'sp-dot', style: `background:${SERVICE_COLOR(e.source)};margin-top:5px` })); } }) : h('span', { class: 'sp-dot', style: `background:${SERVICE_COLOR(e.source)};margin-top:5px`, title: sourceName(e.source) }),
      h('div', null,
        h('div', null, h('span', { class: 'who' }, e.who.name), ' ', kindOf(e), item ? ` ${item}` : '', ' ', h('span', { class: 'amt' }, money(e))),
        h('div', { class: 'meta' }, h('span', null, sourceName(e.source) + (e.via ? ` via ${sourceName(e.via)}` : '')), h('span', null, t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), e.tierName ? h('span', null, e.tierName) : null,
          e.test ? h('span', { class: 'sp-badge test' }, 'Test') : null, e.replayed ? h('span', { class: 'sp-badge away' }, 'While you were away') : null, e.voided ? h('span', { class: 'sp-badge' }, e.voided === 'refund' ? 'Refunded' : 'Removed') : null),
        m ? h('div', { class: `msg ${m.moderated}` }, m.moderated === 'hidden' ? 'Message hidden' : m.text, m.moderated === 'pending' ? h('div', { class: 'meta' }, 'Waiting for your OK before it shows on stream') : null) : null),
      acts);
  };
  const mod = async (id: string, m: 'ok' | 'hidden') => { try { await call('/api/support/moderate', 'POST', { id, moderated: m }); const e = events.find((x) => x.id === id); if (e?.message) e.message = { ...e.message, moderated: m }; render(); } catch (err) { toast((err as Error).message, 'err'); } };
  const addByHand = () => {
    const name = h('input', { type: 'text', placeholder: 'Their name', 'aria-label': 'Name' }) as HTMLInputElement;
    const amt = h('input', { type: 'number', min: '0', step: '0.01', placeholder: `Amount (${settings!.displayCurrency})`, 'aria-label': 'Amount' }) as HTMLInputElement;
    const msg = h('input', { type: 'text', placeholder: 'Message (optional)', 'aria-label': 'Message' }) as HTMLInputElement;
    const el = h('div', { class: 'sp-confirm', role: 'dialog', 'aria-label': 'Add support by hand' }, h('div', null, h('b', null, 'Add support by hand'), h('p', null, 'Cash at an event, a gift by mail… It counts toward your goals and shows like any other.'), name, amt, msg,
      h('div', { class: 'sp-row', style: 'justify-content:flex-end' }, h('button', { class: 'sp-btn', onClick: () => el.remove() }, 'Cancel'), h('button', { class: 'sp-btn pri', onClick: async () => { try { await call('/api/support/manual', 'POST', { name: name.value, amount: parseFloat(amt.value) || 0, message: msg.value }); el.remove(); toast('Added', 'ok'); void loadFeed(); } catch (err) { toast((err as Error).message, 'err'); } } }, 'Add'))));
    document.body.append(el); name.focus();
  };

  // ---------------------------------------------------------------- Store
  const storeTab = () => {
    const st = status!, sc = settings!.showcase;
    const fw = st.services.fourthwall;
    if (!fw.enabled && !(store?.products.length)) return h('div', { class: 'sp-empty' }, h('b', null, 'Connect your Fourthwall store'), h('span', null, 'Show your merch on stream, celebrate every order, and run a quick promo code, right from here.'), h('button', { class: 'sp-btn pri', onClick: () => { cur = 'services'; openCards.add('fourthwall'); render(); } }, 'Connect Fourthwall'));
    const s = store;
    const tog = (label: string, sub: string, v: boolean, patch: (v: boolean) => Record<string, unknown>) => h('label', { class: 'sp-tog' }, h('input', { type: 'checkbox', checked: v, onChange: (e: Event) => void saveSettings(patch((e.target as HTMLInputElement).checked)) }), h('span', null, label, h('small', null, sub)));
    const seg = <T extends string>(label: string, val: T, opts: [T, string][], patch: (v: T) => Record<string, unknown>) => h('div', { class: 'sp-row' }, h('span', { style: 'color:var(--dim);font-size:12.5px;min-width:90px' }, label), h('div', { class: 'sp-seg' }, ...opts.map(([v, t]) => h('button', { 'aria-pressed': String(val === v), onClick: () => void saveSettings(patch(v)) }, t))));
    const opts = h('div', { class: 'sp-opts' },
      tog('Show my products on stream', 'A card with the picture, the price and a scan-to-shop code', sc.on, (v) => ({ showcase: { on: v } })),
      tog('Celebrate purchases', '“Sam just bought this!” with the product for a few seconds', sc.purchases, (v) => ({ showcase: { purchases: v } })),
      tog('Scan-to-shop code', 'A QR code to the product page', sc.qr, (v) => ({ showcase: { qr: v } })),
      seg('What', sc.mode, [['featured', 'One product'], ['carousel', 'Take turns']], (v) => ({ showcase: { mode: v } })),
      seg('Where', sc.where, [['auto', 'Automatic'], ['world', 'In the room'], ['docked', 'Corner card']], (v) => ({ showcase: { where: v } })));
    const grid = h('div', { class: 'sp-prods' }, ...(s?.products ?? []).map((p) => prodCard(p)));
    const promo = promoBox();
    return h('div', null,
      h('p', { class: 'sp-note' }, s?.error ? h('span', { style: 'color:var(--err)' }, s.error) : h('span', null, `${s?.products.length ?? 0} products${s?.at ? ` · updated ${new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`), h('button', { class: 'sp-btn', onClick: async () => { try { store = await call('/api/support/store/refresh', 'POST', {}); render(); } catch (e) { toast((e as Error).message, 'err'); } } }, 'Refresh'), h('button', { class: 'sp-btn', onClick: async () => { try { await call('/api/support/test', 'POST', { which: 'fourthwall' }); toast('A test order is on its way to your stream.', 'ok'); } catch (e) { toast((e as Error).message, 'err'); } } }, 'Test a purchase')),
      h('div', { class: 'sp-section' }, 'On stream'), opts,
      h('div', { class: 'sp-section' }, 'Your products', h('small', null, 'Star = featured · “Shop:” changes your live store')),
      s?.products.length ? grid : h('div', { class: 'sp-empty' }, 'No products yet. Add your API key (Services → Fourthwall) or press Refresh.'),
      h('div', { class: 'sp-section' }, 'Promo code', h('small', null, 'Ends by itself')), promo,
      h('div', { class: 'sp-section' }, 'Featured collection', h('small', null, 'A page in your shop with what you show on stream')), collectionBox());
  };
  const collectionBox = () => {
    const cols = store?.collections ?? [];
    if (!cols.length) return h('p', { class: 'sp-what' }, 'Make a collection in Fourthwall first (Products → Collections), then press Refresh. Then you can fill it from here.');
    const sc = settings!.showcase;
    const shown = (store?.products ?? []).filter((p) => p.listed && !sc.hidden.includes(p.id));
    const pick = h('select', { 'aria-label': 'Collection' }, ...cols.map((c) => h('option', { value: c.id }, c.name || c.slug))) as HTMLSelectElement;
    return h('div', { class: 'sp-card' }, h('div', { class: 'sp-row' }, pick, h('button', { class: 'sp-btn', onClick: async () => {
      const col = cols.find((c) => c.id === pick.value);
      if (!(await confirmSheet('This changes your live store', `Make “${col?.name ?? 'this collection'}” hold exactly the ${shown.length} product${shown.length === 1 ? '' : 's'} you show on stream? Products in it now that aren’t on stream are taken out.`, 'Update the collection'))) return;
      try { await call(`/api/support/store/collection/${encodeURIComponent(pick.value)}`, 'PUT', { offerIds: shown.map((p) => p.id), confirm: true }); toast('Your collection is updated.', 'ok'); } catch (e) { toast((e as Error).message, 'err'); }
    } }, 'Fill it with the products on stream')));
  };
  const prodCard = (p: StoreProduct) => {
    const sc = settings!.showcase;
    const feat = sc.featured ? sc.featured === p.id : store?.products.find((x) => x.available && x.listed)?.id === p.id;
    const hiddenHere = sc.hidden.includes(p.id);
    return h('div', { class: `sp-prod${feat ? ' feat' : ''}`, 'data-product': p.id },
      p.image ? h('img', { src: p.image, alt: '', loading: 'lazy' }) : h('div', { class: 'ph' }, '🛍'),
      h('div', { class: 'b' },
        h('div', { class: 'nm', title: p.name }, p.name),
        h('div', { class: 'pr' }, moneyText(p.priceMinor, p.currency)),
        h('div', { class: 'st' }, [p.listed ? 'In your shop' : 'Hidden in your shop', p.available ? '' : 'Sold out', p.left !== undefined ? `${p.left} left` : ''].filter(Boolean).join(' · ')),
        h('div', { class: 'sp-row' },
          h('button', { class: `sp-btn${feat ? ' pri' : ''}`, title: 'Feature this product on stream', onClick: () => void saveSettings({ showcase: { featured: p.id, mode: 'featured' } }, `${p.name} is featured`) }, feat ? '★ Featured' : '☆ Feature'),
          h('button', { class: 'sp-btn', title: 'Keep it off your stream (your shop is unchanged)', onClick: () => void saveSettings({ showcase: { hidden: hiddenHere ? sc.hidden.filter((x) => x !== p.id) : [...sc.hidden, p.id] } }) }, hiddenHere ? 'Show on stream' : 'Not on stream')),
        h('button', { class: 'sp-btn', onClick: async () => {
          const listed = !p.listed;
          if (!(await confirmSheet('This changes your live store', `${listed ? 'Show' : 'Hide'} “${p.name}” ${listed ? 'in' : 'from'} your Fourthwall shop for everyone?`, listed ? 'Show it in my shop' : 'Hide it in my shop'))) return;
          try { await call(`/api/support/store/product/${encodeURIComponent(p.id)}`, 'POST', { listed, confirm: true }); toast('Your shop is updated.', 'ok'); await loadStore(); } catch (e) { toast((e as Error).message, 'err'); }
        } }, p.listed ? 'Shop: hide it' : 'Shop: show it')));
  };
  const promoBox = () => {
    const code = h('input', { type: 'text', placeholder: 'STREAM10', value: 'STREAM10', 'aria-label': 'Code', style: 'text-transform:uppercase' }) as HTMLInputElement;
    const pct = h('input', { type: 'number', min: '1', max: '100', value: '10', 'aria-label': 'Percent off', style: 'width:80px' }) as HTMLInputElement;
    const mins = h('input', { type: 'number', min: '1', max: '10080', value: '15', 'aria-label': 'Minutes', style: 'width:80px' }) as HTMLInputElement;
    const uses = h('input', { type: 'number', min: '0', value: '20', 'aria-label': 'Uses', style: 'width:80px' }) as HTMLInputElement;
    const live = (store?.promos ?? []).map((p) => h('div', { class: 'sp-row' }, h('b', null, p.code), h('span', { style: 'color:var(--dim)' }, `ends ${new Date(p.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`), h('button', { class: 'sp-btn warn', onClick: async () => { if (!(await confirmSheet('This changes your live store', `End the code ${p.code} now?`, 'End it now'))) return; try { await call(`/api/support/store/promo/${encodeURIComponent(p.id)}`, 'DELETE'); await loadStore(); } catch (e) { toast((e as Error).message, 'err'); } } }, 'End now')));
    return h('div', { class: 'sp-card' },
      h('div', { class: 'sp-row' }, h('label', { class: 'f' }, 'Code', code), h('label', { class: 'f' }, '% off', pct), h('label', { class: 'f' }, 'Minutes', mins), h('label', { class: 'f' }, 'First buyers', uses)),
      h('div', { class: 'sp-row' }, h('button', { class: 'sp-btn pri', onClick: async () => {
        const c = code.value.trim().toUpperCase();
        if (!(await confirmSheet('This changes your live store', `Create the code ${c}: ${pct.value}% off for ${mins.value} minutes${Number(uses.value) > 0 ? `, the first ${uses.value} buyers` : ''}?`, 'Create the code'))) return;
        try { const r = await call<{ code: string; endsAt: string }>('/api/support/store/promo', 'POST', { code: c, percent: Number(pct.value), minutes: Number(mins.value), maxUses: Number(uses.value) || undefined, confirm: true }); toast(`${r.code} is live until ${new Date(r.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`, 'ok', 6000); await loadStore(); }
        catch (e) { toast((e as Error).message, 'err', 7000); }
      } }, 'Create the code')),
      ...live);
  };

  // ---------------------------------------------------------------- Supporters
  const supporters = () => {
    const claimRows = claims.map((c) => {
      const pick = h('select', { 'aria-label': 'Who are they?' }, h('option', { value: '' }, 'Who are they?'), ...members.filter((m) => m.active).map((m) => h('option', { value: m.linkedId, selected: m.linkedId === c.suggest }, `${m.name} · ${sourceName(m.source)} ${m.tier}`))) as HTMLSelectElement;
      return h('div', { class: 'sp-card' }, h('div', null, h('b', null, c.chat.login), ` on ${sourceName(c.chat.platform)} typed !link${c.said ? ` “${c.said}”` : ''}`),
        h('div', { class: 'sp-row' }, pick, h('button', { class: 'sp-btn pri', onClick: async () => { if (!pick.value) { toast('Pick who they are first.', 'warn'); return; } await call('/api/support/supporters/claim', 'POST', { id: c.id, linkedId: pick.value }); void loadSupporters(); } }, 'That’s them ✓'), h('button', { class: 'sp-btn', onClick: async () => { await call('/api/support/supporters/claim', 'POST', { id: c.id, linkedId: null }); void loadSupporters(); } }, 'No')));
    });
    const act = members.filter((m) => m.active);
    const rows = act.map((m) => {
      const links = m.links.map((l) => `${sourceName(l.platform)}: ${l.login || l.userId}`).join(' · ');
      const out = h('div');
      return h('div', { class: 'sp-card', 'data-member': m.linkedId },
        h('h3', null, h('span', { class: 'sp-dot', style: `background:${SERVICE_COLOR(m.source)}` }), m.name || 'Supporter', h('span', { class: 'sp-chip live' }, `${m.tier}${m.cents ? ` · ${moneyText(m.cents, 'USD')}/mo` : ''}`)),
        h('p', { class: 'sp-what' }, `${sourceName(m.source)} since ${m.since ? new Date(m.since).toLocaleDateString() : '—'}`),
        h('p', { class: 'sp-detail' }, links ? `Chat: ${links}` : 'Not linked to a chat name yet'),
        h('div', { class: 'sp-row' },
          h('button', { class: 'sp-btn', onClick: async () => { try { const r = await call<{ code: string }>('/api/support/supporters/code', 'POST', { linkedId: m.linkedId }); out.replaceChildren(h('div', { class: 'sp-code' }, r.code), h('p', { class: 'sp-what' }, `Send it to ${m.name.split(' ')[0] || 'them'}: they type !link ${r.code} in your chat (works for 24 hours).`)); } catch (e) { toast((e as Error).message, 'err'); } } }, 'Make a link code'),
          h('button', { class: 'sp-btn', onClick: () => {
            const plat = h('select', { 'aria-label': 'Platform' }, ...['twitch', 'youtube', 'kick', 'rumble', 'tiktok'].map((p) => h('option', { value: p }, sourceName(p)))) as HTMLSelectElement;
            const nm = h('input', { type: 'text', placeholder: 'Their chat name', 'aria-label': 'Chat name' }) as HTMLInputElement;
            out.replaceChildren(h('div', { class: 'sp-row' }, plat, nm, h('button', { class: 'sp-btn pri', onClick: async () => { await call('/api/support/supporters/manual', 'PUT', { linkedId: m.linkedId, platform: plat.value, name: nm.value }); toast('Linked', 'ok'); void loadSupporters(); } }, 'Save')));
            nm.focus();
          } }, 'Set chat name'),
          m.links.length ? h('button', { class: 'sp-btn warn', onClick: async () => { await call(`/api/support/supporters/${encodeURIComponent(m.linkedId)}`, 'DELETE'); void loadSupporters(); } }, 'Unlink') : null),
        out);
    });
    return h('div', null,
      h('p', { class: 'sp-note' }, 'Supporters’ names can glow in chat by tier. Patrons who linked their Twitch on Patreon are matched by themselves; anyone else types !link in your chat.'),
      claims.length ? h('div', { class: 'sp-section' }, 'Waiting for your OK', h('small', null, 'People who typed !link')) : null,
      claims.length ? h('div', { class: 'sp-grid' }, ...claimRows) : null,
      h('div', { class: 'sp-section' }, `Supporters (${act.length})`),
      act.length ? h('div', { class: 'sp-grid' }, ...rows) : h('div', { class: 'sp-empty' }, h('b', null, 'No supporters linked yet'), h('span', null, 'Connect Patreon (or Ko-fi, Buy Me a Coffee, Fourthwall memberships) in Services. Members show up here.'), h('button', { class: 'sp-btn pri', onClick: () => { cur = 'services'; openCards.add('patreon'); render(); } }, 'Connect Patreon')));
  };

  // ---------------------------------------------------------------- Settings
  const settingsTab = () => {
    const s = settings!;
    const tog = (label: string, sub: string, v: boolean, key: string) => h('label', { class: 'sp-tog' }, h('input', { type: 'checkbox', checked: v, 'data-set': key, onChange: (e: Event) => void saveSettings({ [key]: (e.target as HTMLInputElement).checked }) }), h('span', null, label, h('small', null, sub)));
    const cur2 = h('select', { 'aria-label': 'Currency', onChange: (e: Event) => void saveSettings({ displayCurrency: (e.target as HTMLSelectElement).value }, 'New events use this currency') }, ...[...new Set([s.displayCurrency, ...CURRENCIES])].map((c) => h('option', { value: c, selected: c === s.displayCurrency }, c)));
    const bits = h('input', { type: 'number', min: '0.01', max: '100', step: '0.01', value: String(s.bitCents), style: 'width:90px', 'aria-label': 'Cents per bit', onChange: (e: Event) => void saveSettings({ bitCents: Number((e.target as HTMLInputElement).value) || 1 }) });
    const names = h('div', { class: 'sp-seg', role: 'group', 'aria-label': 'Buyer names' }, ...([['first', 'First name'], ['hidden', 'Hide names'], ['full', 'As they typed it']] as const).map(([v, t]) => h('button', { 'aria-pressed': String(s.buyerNames === v), onClick: () => void saveSettings({ buyerNames: v }) }, t)));
    const block = h('textarea', { 'aria-label': 'Blocked words', placeholder: 'one word per line', value: s.blocklist.join('\n') }) as HTMLTextAreaElement;
    block.addEventListener('change', () => void saveSettings({ blocklist: block.value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean) }, 'Saved your blocked words'));
    const relay = h('input', { type: 'text', value: s.inboxRelay, placeholder: 'Automatic', 'aria-label': 'Webhook inbox address' }) as HTMLInputElement;
    relay.addEventListener('change', () => void saveSettings({ inboxRelay: relay.value.trim() }, 'Saved'));
    return h('div', null,
      h('div', { class: 'sp-section' }, 'Money'),
      h('div', { class: 'sp-opts' },
        h('label', { class: 'f' }, 'Show amounts in', cur2, h('small', null, 'Every tip is converted when it arrives (today’s central-bank rate); the original amount is kept.')),
        h('label', { class: 'f' }, 'One bit is worth (US cents)', bits, h('small', null, '1 cent is the usual value. Goals count what supporters paid (gross).'))),
      h('div', { class: 'sp-section' }, 'Names and messages'),
      h('div', { class: 'sp-opts' },
        h('div', { class: 'f' }, h('span', { style: 'color:var(--dim);font-size:12.5px' }, 'Merch buyers on stream'), names, h('small', { style: 'color:var(--dim)' }, 'E-mails and addresses are never shown. Anyone who chose to stay anonymous is “Someone”.')),
        tog('Filter tip messages', 'Messages with one of your blocked words wait for your OK. Off: no word filter.', s.filterMessages, 'filterMessages'),
        tog('Remove links from tip messages', 'Links, web addresses and e-mail addresses are taken out. Off: shown as typed.', s.stripLinks, 'stripLinks'),
        tog('Hold every message for my OK', 'Off: messages show right away (after the filters above, when they are on).', s.holdMessages, 'holdMessages'),
        s.filterMessages ? h('label', { class: 'f' }, 'Blocked words (held for your OK, never shown)', block) : null),
      h('div', { class: 'sp-section' }, 'Testing and catching up'),
      h('div', { class: 'sp-opts' },
        tog('Test mode: count test events in goals', 'For rehearsals. Off during real streams.', s.testMode, 'testMode'),
        tog('Show the services’ own tests on stream', 'Fourthwall “Send test”, Stripe / Buy Me a Coffee test mode. Off: they only show here. (“Send a test” in this page always shows on stream.)', s.testsOnStream, 'testsOnStream'),
        tog('Play alerts for what I missed', 'Off: tips that came while VTube Pro was closed update your goals quietly.', s.playMissedAlerts, 'playMissedAlerts'),
        tog('Allow unofficial connections', 'Shown with a “may break” label.', s.unofficial, 'unofficial')),
      h('div', { class: 'sp-section' }, 'Webhook inbox', h('small', null, 'Where Ko-fi, Throne and others send events while you’re offline')),
      h('div', { class: 'sp-opts' },
        h('label', { class: 'f' }, 'Inbox server', relay, h('small', null, 'Empty = automatic: your own invite server, once you have set one up (webhooks need it). Deliveries wait there up to 7 days, then are deleted.')),
        h('div', { class: 'f' }, h('span', { style: 'color:var(--dim);font-size:12.5px' }, 'Something wrong?'), h('button', { class: 'sp-btn warn', onClick: async () => { if (!(await confirmSheet('Make new addresses?', 'Your old webhook addresses stop working. You paste the new ones into each service again.', 'Make new addresses'))) return; try { await call('/api/support/inbox/rotate', 'POST', {}); addresses.clear(); toast('New addresses made. Press “Show my address” on each service.', 'ok', 6000); } catch (e) { toast((e as Error).message, 'err'); } } }, 'Make new webhook addresses'))));
  };

  renderTabs();
  render();
  void load();
}
