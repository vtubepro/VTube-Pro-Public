// "Streaming from a second PC" (Stream PC mode, docs/TWO_PC_STREAMING.md): the card in OBS & stream on the GAMING PC.
// One switch; then the address to open on the stream PC, the pairing code, the connected stream PCs (Forget), the
// firewall / network state with one-click fixes, how it draws (A: on the stream PC, B: here, finished video), and OBS
// control on the stream PC. Everything talks to this PC's server (/api/streampc, server/streamPc.ts); these settings are this PC only.
import { button, clear, h, select, toast, toggle } from './dom.ts';
import { helperPageUrl } from '../net/helper.ts';
import type { SpView } from '../../shared/streamPc.ts';

const API = '/api/streampc';
async function call(method: string, path = '', body?: unknown, click = false): Promise<SpView & { says?: string; ok?: boolean; view?: SpView }> {
  const r = await fetch(API + path, { method, cache: 'no-store', headers: { 'content-type': 'application/json', ...(click ? { 'x-vtp-user-action': '1' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string; says?: string }).error ?? (j as { says?: string }).says ?? `VTube Pro said no (${r.status})`);
  return j as SpView;
}
const ago = (iso: string) => { const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString(); };
async function copy(text: string, what: string) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`, 'ok'); } catch { toast('Select it and press Ctrl+C', 'warn'); }
}

const CSS = `
.sp-big{font:600 16px/1.35 ui-monospace,Consolas,monospace;overflow-wrap:anywhere;padding:10px 12px;border-radius:10px;border:1px solid var(--line,#2c2f3d);background:var(--input,rgba(127,127,127,.08));color:var(--text,inherit);user-select:all;margin:6px 0}
.sp-code{font-size:32px;letter-spacing:.16em;text-align:center}
.sp-state{display:flex;gap:8px;align-items:flex-start;margin:8px 0}.sp-dot{flex:0 0 10px;width:10px;height:10px;border-radius:50%;margin-top:6px;background:var(--faint,#888)}
.sp-dot.ok{background:var(--ok,#3ccf8e)}.sp-dot.warn{background:var(--warn,#f0b429)}.sp-dot.err{background:var(--err,#ff6b5b)}
.sp-pc{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--line,rgba(127,127,127,.2))}
.sp-pc b{display:block}.sp-step{font-weight:700;margin-top:12px}
`;

/** Mount the card into `host` (OBS & stream). It keeps itself up to date while it is on screen. */
export function mountStreamPcCard(host: HTMLElement) {
  if (!document.getElementById('sp-style')) document.head.append(h('style', { id: 'sp-style' }, CSS));
  const body = h('div');
  host.append(h('section', { class: 'sec', 'data-key': 'streaming-from-a-second-pc', 'data-tut': 'streampc' },
    h('h3', { class: 'sec-h' }, 'Streaming from a second PC'),
    h('p', { class: 'note' }, 'OBS on another computer (a stream PC)? Your avatar can show up there over your home network. Only your own computers on the same network can connect.'),
    body));
  let v: SpView | null = null, busy = false, timer = 0, sig = '';
  const run = async (f: () => Promise<unknown>) => { if (busy) return; busy = true; try { await f(); } catch (e) { toast((e as Error).message, 'err', 7000); } finally { busy = false; void refresh(); } };

  function paint() {
    if (!v) return;
    const s = JSON.stringify({ ...v, code: v.code?.code, pcs: v.pcs.map((p) => [p.id, p.online, p.kind, p.name]), sender: v.sender ? [v.sender.running, v.sender.says] : null });
    if (s === sig) { const ex = body.querySelector('[data-sp-exp]'); if (ex && v.code) ex.textContent = `Works for ${Math.ceil(v.code.expiresIn / 60)} more minute${v.code.expiresIn > 60 ? 's' : ''}.`; return; }
    sig = s;
    clear(body);
    body.append(toggle('Let my stream PC connect', v.enabled, (on) => run(async () => { v = await call('PUT', '', { enabled: on }); toast(on ? 'On: your stream PC can connect now.' : 'Off: nothing on your network can reach VTube Pro now.', on ? 'ok' : 'info'); }),
      'Off by default. When on, only a computer on your home network that you connected with the code can show your avatar.'));
    if (!v.enabled) return;
    const kind = v.state === 'listening' ? 'ok' : v.state === 'error' || v.state === 'no-network' ? 'err' : 'warn';
    body.append(h('div', { class: 'sp-state' }, h('span', { class: `sp-dot ${kind}` }), h('span', null, v.says)));
    if (v.state === 'firewall') body.append(h('div', { class: 'btns' },
      button('Let my stream PC through', () => run(async () => { const r = await call('POST', '/firewall', {}, true); toast(r.says ?? 'Done', r.ok ? 'ok' : 'warn', 8000); }), 'primary'),
      button('Try without it', () => run(async () => { v = await call('PUT', '', { skipFirewall: true }, true); }))));
    if (v.state === 'public') body.append(h('div', { class: 'btns' }, button('Open network settings', () => run(async () => { const r = await call('POST', '/network-settings', {}, true); toast(r.says ?? '', 'info', 9000); }), 'primary'),
      button('I switched it', () => run(async () => { v = await call('GET', '?fresh=1'); }))));
    if (v.state === 'listening' && v.pairUrl) {
      body.append(
        h('div', { class: 'sp-step' }, '1. On your stream PC, open this in any web browser'),
        h('div', { class: 'sp-big' }, v.pairUrl),
        h('div', { class: 'btns' }, button('Copy address', () => void copy(v!.pairUrl!, 'Address'))),
        h('div', { class: 'sp-step' }, '2. Type this code there'),
        v.code ? h('div', { class: 'sp-big sp-code' }, v.code.code) : h('p', { class: 'note' }, '…'),
        h('p', { class: 'note', 'data-sp-exp': '' }, v.code ? `Works for ${Math.ceil(v.code.expiresIn / 60)} more minutes.` : ''),
        h('div', { class: 'btns' }, button('New code', () => run(async () => { v = await call('POST', '/code', {}); }))),
        h('div', { class: 'sp-step' }, '3. Paste the link it gives you into OBS on the stream PC'),
        h('p', { class: 'note' }, 'OBS → Sources → + → Browser → paste, Width 1920, Height 1080. Or let VTube Pro do it (below).'),
      );
    }
    // connected stream PCs
    body.append(h('div', { class: 'sp-step' }, v.pcs.length ? 'Connected stream PCs' : 'No stream PC connected yet'));
    for (const p of v.pcs) {
      const what = p.online ? (p.kind === 'view' ? 'showing the video from this PC' : p.kind === 'output' || p.kind === 'obs' ? 'showing your avatar' : 'connected') : `last seen ${ago(p.lastSeen)}`;
      body.append(h('div', { class: 'sp-pc' },
        h('span', null, h('span', { class: `sp-dot ${p.online ? 'ok' : ''}`, style: 'display:inline-block;margin-right:6px' }), h('b', { style: 'display:inline' }, p.name), h('span', { class: 'note' }, ` · ${p.ip || 'set up through OBS'} · ${what}`)),
        button('Forget this stream PC', () => { if (confirm(`Forget “${p.name}”? Its OBS link stops working at once.`)) void run(async () => { const r = await call('DELETE', `/pcs/${encodeURIComponent(p.id)}`) as unknown as { view: SpView }; v = r.view; toast('Forgotten. Its link no longer works.', 'ok'); }); })));
    }
    // how it draws
    body.append(select('How it draws', v.mode, [['A', 'On the stream PC (recommended)'], ['B', 'On this PC, send the finished video']], (m) => run(async () => { v = await call('PUT', '', { mode: m }); toast(m === 'A' ? 'Your stream PC draws the avatar and room itself.' : 'This PC draws and sends finished video. The stream PC switches by itself.', 'ok', 6000); }),
      'On the stream PC: its graphics card draws the room, this PC only tracks you (best for most). On this PC: for a weak stream PC; this PC draws and sends video over your network (uses more of this PC’s graphics card).'));
    body.append(h('p', { class: 'note' }, v.mode === 'A' ? 'The stream PC draws your avatar and room with its own graphics card. This PC only tracks you.' : 'This PC draws your avatar and room and sends the finished video, see-through background included. Uses more of this PC’s graphics card.'));
    if (v.mode === 'B' && v.sender) {
      const st = v.sender.stats as { fps?: number; lat?: { p50?: number } | null; enc?: { encoder?: string; kbps?: number } } | null;
      body.append(h('div', { class: 'sp-state' }, h('span', { class: `sp-dot ${v.sender.running ? 'ok' : 'warn'}` }), h('span', null, v.sender.says,
        st && v.sender.running ? ` ${st.fps ?? 0} frames a second${st.enc?.encoder ? `, ${/MediaFoundation|NVENC|AMF|QSV|Hardware/i.test(st.enc.encoder) ? 'graphics card encoder' : 'CPU encoder'}` : ''}.` : '')));
    }
    // OBS control on the stream PC
    const ip = v.pcs.find((p) => p.online && p.ip)?.ip ?? v.pcs.find((p) => p.ip)?.ip ?? '';
    body.append(h('div', { class: 'sp-step' }, 'OBS on the stream PC'),
      h('p', { class: 'note' }, 'Let VTube Pro control that OBS too (scene switching, the React screen): connect to it, then let VTube Pro add itself.'),
      h('div', { class: 'btns' },
        button('Connect to OBS on my stream PC', () => window.open(helperPageUrl(`/obs/connect${ip ? `?url=${encodeURIComponent(`ws://${ip}:4455`)}` : ''}`), '_blank')),
        button('Set up OBS for me', () => void import('./obsWizard.ts').then((m) => m.openObsWizard()), 'primary')),
      h('p', { class: 'note' }, 'On the stream PC first: OBS → Tools → WebSocket Server Settings → Enable, then Show Connect Info for the password.'));
  }
  let seen = false, born = Date.now();
  async function refresh() {
    window.clearTimeout(timer);
    if (host.isConnected) seen = true;
    else if (seen || Date.now() - born > 10_000) return; // the panel was closed (or never shown): stop asking
    try { v = await call('GET'); paint(); }
    catch { clear(body); sig = ''; body.append(h('p', { class: 'note' }, 'VTube Pro’s engine isn’t answering. Restart VTube Pro.')); }
    timer = window.setTimeout(() => void refresh(), document.hidden ? 8000 : 2000);
  }
  void refresh();
}
