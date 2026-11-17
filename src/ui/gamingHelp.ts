// "Gaming at 60 FPS" card in the Scene tab's Game / Window capture step (src/ui/stagePanel.ts). Plain words, one click each:
//   * the Game Capture shows nothing → ONE question "This game blocks Game Capture. Switch to Display Capture?" (a Display or
//     Window Capture goes where the Game Capture was, the Game Capture is hidden, never deleted; the choice is remembered per
//     game, and Undo puts everything back);
//   * what makes the stream heavier next to a game (a 4K monitor shrunk every frame, a CPU encoder, a page drawing 60 fps on
//     a 30 fps canvas …) with the click that fixes it when OBS lets a program change it;
//   * "OBS is not run as administrator" with the steps (VTube Pro never elevates anything).
// The decisions are pure (shared/gamingCapture.ts); the helper does the OBS work (server/obsGaming.ts). The card asks the
// helper every few seconds only while it is on screen and the studio is visible.
import type { App } from '../app.ts';
import { screenPathAdvice, type Advice, type GamingStatus } from '../../shared/gamingCapture.ts';
import { capabilityNow } from '../net/capability.ts';
import { button, h, toast } from './dom.ts';

let status: GamingStatus | null = null;
let askedAt = 0, busy = false, timer = 0, adminOpen = false;
let host: HTMLElement | null = null;
let lastRepaint: (() => void) | null = null;
const POLL_MS = 5000;

async function api<T>(url: string, body?: unknown): Promise<{ status: number; data: T | null }> {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20_000);
  try {
    const r = await fetch(url, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: ac.signal, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data: T | null = null; try { data = await r.json() as T; } catch { /* not json */ }
    return { status: r.status, data };
  } catch { return { status: 0, data: null }; } finally { clearTimeout(t); }
}
const vendor = (): string => {
  const g = capabilityNow()?.report.gpus.find((x) => !x.integrated) ?? capabilityNow()?.report.gpus[0];
  return g && (g.vendor === 'nvidia' || g.vendor === 'amd' || g.vendor === 'intel') ? g.vendor : '';
};
async function refresh(app: App) {
  if (askedAt && Date.now() - askedAt < 1500) return;
  askedAt = Date.now();
  const v = vendor();
  const r = await api<GamingStatus>(`/api/obs/gaming${v ? `?vendor=${v}` : ''}`);
  if (r.data && 'ok' in r.data) { status = r.data; app.scene.poke(); }
}
function start(app: App) {
  if (timer) return;
  timer = window.setInterval(() => {
    // stops by itself once the card is gone from the page (another tab) — and while the studio is hidden
    if (!host || !host.isConnected) { clearInterval(timer); timer = 0; host = null; return; }
    if (document.hidden) return;
    void refresh(app);
  }, POLL_MS);
}

async function run<T extends { ok?: boolean; error?: string }>(label: string, f: () => Promise<{ data: T | null }>, app: App, okText: string) {
  if (busy) return;
  busy = true; lastRepaint?.();
  try {
    const r = await f();
    toast(r.data?.ok ? okText : r.data?.error ?? `${label}: no answer from VTube Pro`, r.data?.ok ? 'ok' : 'warn', r.data?.ok ? 3500 : 6000);
  } finally { busy = false; askedAt = 0; await refresh(app); lastRepaint?.(); }
}

async function switchNow(app: App, source: string) {
  if (busy) return;
  const plan = (await api<{ ok: boolean; id: string; text: string; error?: string }>('/api/obs/gaming/plan', { source })).data;
  if (!plan?.ok) { toast(plan?.error ?? 'Couldn’t prepare the switch', 'warn', 6000); return; }
  await run('Switch', () => api<{ ok: boolean; error?: string }>('/api/obs/gaming/apply', { planId: plan.id, source }), app, 'Done. Your Game Capture is hidden (not deleted); Undo puts it back.');
}

const adviceRow = (app: App, a: Advice): HTMLElement => h('div', { class: 'note', style: `margin:6px 0;${a.level === 'warn' ? 'color:var(--warn,#e0a030)' : ''}`, 'data-advice': a.id },
  a.level === 'warn' ? '⚠ ' : 'ℹ ', a.text,
  a.fix ? h('div', { class: 'btns tight', style: 'margin-top:4px' }, button(a.fix.label, () => {
    const v = vendor();
    void run('Fix', () => api<{ ok: boolean; error?: string }>('/api/obs/gaming/fix', { action: a.fix!.action, ...(v ? { vendor: v } : {}) }), app, 'Done. Undo is right there if you don’t like it.');
  }, 'primary')) : a.manual ? h('div', { style: 'opacity:.8;margin-top:2px' }, a.manual) : null);

/** The card. Renders what VTube Pro last said; asks again while it is on screen. Nothing in it for an observer sandbox, or when OBS isn't connected (the capture step above says how to connect). */
export function gamingHelp(app: App, repaint: () => void): HTMLElement {
  host = h('div', { class: 'stg-gaming', 'data-ui': 'gaming-help' });
  lastRepaint = repaint;
  if (app.observer) return host;
  start(app);
  if (!status || Date.now() - askedAt > POLL_MS) void refresh(app);
  const s = status;
  if (!s || !s.connected) return host;
  const eff = app.scene.effective;
  const sc = (eff as { screen?: { mode?: string; scanlines?: boolean; glass?: boolean } }).screen;
  const adv: Advice[] = [
    ...s.advice,
    ...screenPathAdvice({ kind: s.display ? 'monitor_capture' : '', shown: s.display ? { w: s.display.w, h: s.display.h } : null, screenMode: sc?.mode ?? 'auto', fx: !!(sc?.scanlines || sc?.glass), obsAuto: s.automation, mode: eff.mode }),
  ];
  const rows: Node[] = [];
  if (s.offer.kind === 'ask' && s.capture) {
    rows.push(h('div', { class: 'note', style: 'margin:6px 0;font-weight:600' }, '🎮 ', s.offer.text),
      h('div', { class: 'btns tight' },
        button('Yes, switch', () => void switchNow(app, s.capture!.source), 'primary'),
        button('Not now', () => { void api('/api/obs/gaming/snooze', { source: s.capture!.source, minutes: 30 }).then(() => refresh(app)); }),
      ),
      h('div', { class: 'note', style: 'opacity:.75' }, 'Nothing is deleted: the Game Capture stays in OBS, hidden. Undo puts it back. Next time this game does the same, it switches by itself.'));
  } else if (s.offer.kind === 'auto') rows.push(h('div', { class: 'note', style: 'margin:6px 0' }, '🎮 ', s.offer.text, ' Switching now…'));
  else if (s.offer.kind === 'no-game' || (s.offer.kind === 'wait' && s.offer.text)) rows.push(h('div', { class: 'note', style: 'margin:6px 0' }, '🎮 ', s.offer.text));
  if (s.fallback) rows.push(h('div', { class: 'note', style: 'margin:6px 0' }, `✔ Using ${s.fallback.kind === 'monitor_capture' ? 'a Display Capture' : 'a Window Capture'} (“${s.fallback.input}”) because Game Capture showed nothing. “${s.fallback.gameCapture}” is hidden, not deleted.`));
  if (s.undo) rows.push(h('div', { class: 'btns tight' }, button(`Undo: ${s.undo.label}`, () => { void run('Undo', () => api<{ ok: boolean; error?: string }>('/api/obs/gaming/undo', { id: s.undo!.id }), app, 'Undone.'); })));
  for (const a of adv) rows.push(adviceRow(app, a));
  if (s.admin.notAdmin) {
    rows.push(h('div', { class: 'note', style: 'margin:6px 0;color:var(--warn,#e0a030)' }, '⚠ OBS is not running as administrator, so a game that fills the graphics card gets the card before OBS does. ',
      button(adminOpen ? 'Hide the steps' : 'Show me how', () => { adminOpen = !adminOpen; repaint(); })),
    );
    if (adminOpen) rows.push(h('ol', { class: 'note', style: 'margin:4px 0 4px 18px;padding:0' }, ...s.admin.steps.map((t) => h('li', null, t))));
  }
  if (!rows.length) return host;
  host.append(h('div', { class: 'stg-row', style: 'display:block;border-top:1px solid var(--line);margin-top:8px;padding-top:6px' },
    h('b', null, 'Gaming at 60 FPS'), busy ? h('span', { class: 'note', style: 'margin-left:8px' }, 'working…') : null, ...rows));
  return host;
}
