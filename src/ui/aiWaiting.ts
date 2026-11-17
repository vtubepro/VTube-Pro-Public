// "Your AI is waiting for your OK" (2026-10-03 report: blender_run_python waited on the helper's approval page, the
// page never opened and the studio showed nothing). The helper sends 'ai-approvals' on the bus whenever its waiting
// list changes (server/index.ts); the studio also asks once when it starts (GET /api/ai/pending, helper 1.0.0-beta.7+).
// One small card at the top right until the user decides. Approving stays on the helper's own page (local only): the
// button opens it. Makes no sound.
import { TOOL_WORDS } from '../../shared/createConnect.ts';
import { button, h, toast } from './dom.ts';
import { openTool } from './dockTools.ts';

/** The approval list: the docked page on this computer. */
function openApprovals() {
  openTool('aiconnect');
}

export interface AiWaitingItem { tool?: string; client?: string }

const CSS = `
.ai-waiting { position: fixed; top: 64px; right: 16px; z-index: 9000; width: min(340px, calc(100vw - 32px)); display: flex; flex-direction: column;
  gap: 6px; padding: 14px 16px; border-radius: 14px; background: var(--card, #1b1f28); color: var(--text, #eef1f6); font-size: 13px; line-height: 1.45;
  border: 1px solid color-mix(in srgb, var(--warn, #ffb454) 55%, transparent); box-shadow: 0 18px 50px -20px rgba(0, 0, 0, .65); }
.ai-waiting b { font-size: 14px; }
.ai-waiting span { color: var(--dim, #a3abba); }
.ai-waiting .row { display: flex; gap: 8px; margin-top: 4px; }`;

let card: HTMLElement | null = null;
let later = false; // "Later": hidden until the waiting list changes again
let lastSig = '';

/** n = how many requests wait; items = the first few (tool + app). `changed` = a new list from the helper. */
export function showAiWaiting(n: number, items: AiWaitingItem[] = [], changed = true): void {
  const first = items[0] ?? {};
  const sig = `${n}|${first.tool ?? ''}|${first.client ?? ''}`;
  if (changed && sig !== lastSig) later = false;
  lastSig = sig;
  if (n <= 0 || later) { card?.remove(); card = null; return; }
  if (card && card.dataset.sig === sig) return; // same list: keep the card as it is (no flash every 30 s)
  card?.remove(); card = null;
  if (!document.getElementById('ai-waiting-css')) document.head.append(h('style', { id: 'ai-waiting-css' }, CSS));
  const w = TOOL_WORDS[String(first.tool ?? '')] ?? 'Make a change';
  const what = w.charAt(0).toLowerCase() + w.slice(1);
  const who = String(first.client ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Your AI';
  card = h('div', { class: 'ai-waiting', role: 'alert', 'data-ai-waiting': String(n), 'data-sig': sig },
    h('b', null, 'Your AI is waiting for your OK'),
    h('span', null, `${who} wants to: ${what}.${n > 1 ? ` And ${n - 1} more.` : ''} It waits 5 minutes.`),
    h('div', { class: 'row' },
      button('Open approvals', () => openApprovals(), 'primary'),
      button('Later', () => { later = true; card?.remove(); card = null; }, 'ghost')));
  document.body.append(card);
}

/** At start and every 30 s: an AI that was already waiting before this page opened, or a notice the bus missed
 *  (`changed` false keeps a "Later"). Older versions have no such route: nothing changes. */
export async function checkAiWaiting(changed = true): Promise<void> {
  try {
    const r = await fetch('/api/ai/pending', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json() as { v?: number; items?: { kind?: string; tool?: string; from?: string }[] };
    const ap = j?.v === 1 && Array.isArray(j.items) ? j.items.filter((x) => x?.kind === 'approval') : [];
    showAiWaiting(ap.length, ap.map((x) => ({ tool: x.tool, client: x.from })), changed);
  } catch { /* no helper yet: the bus notice arrives when one connects */ }
}
