// The studio's ONLY way to AI: through the VTube Pro server on this PC. The studio page never calls an AI company, never
// holds a key and never asks for one: VTube Pro has no AI keys. The server's own AI page (a tab on 127.0.0.1) connects the
// AI apps and the model on this PC.
import { toast } from '../ui/dom.ts';

export const DEFAULT_HELPER_ORIGIN = 'http://127.0.0.1:5191';
const LOOPBACK = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)*\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i;
const loopbackOrigin = (s: string | null | undefined): string | null => {
  if (!s) return null;
  try { const u = new URL(s); return u.protocol === 'http:' && LOOPBACK.test(u.hostname) ? u.origin : null; } catch { return null; }
};

/** The helper's address: the default, or a LOOPBACK override (?helper= / localStorage), never anything else. */
export function helperOrigin(): string {
  let o: string | null = null;
  try { o = loopbackOrigin(new URLSearchParams(location.search).get('helper')); } catch { /* no URL */ }
  if (!o) { try { o = loopbackOrigin(localStorage.getItem('vtp.helper.origin')); } catch { /* storage off */ } }
  if (!o && location.port === '5191') o = location.origin;
  return o ?? DEFAULT_HELPER_ORIGIN;
}

/** The helper's "Connect an AI in 3 steps" page (optionally straight to one AI). */
export const helperAiUrl = (id?: string) => `${helperOrigin()}/aiconnect/connect${id ? `#${encodeURIComponent(id)}` : ''}`;

/** Open the helper's AI page as its own tab (a plain navigation: nothing from this page goes along). */
export function openHelperAi(id?: string): boolean {
  // (window.open with "noopener" ALWAYS returns null, so it can't tell a blocked pop-up from an opened one: that made
  // every Connect press warn "blocked". Open it plainly, then cut the link back to this page.)
  const w = window.open(helperAiUrl(id), '_blank');
  if (w) { try { w.opener = null; } catch { /* cross-origin already */ } }
  else toast('Your browser blocked the new tab. Allow pop-ups for this page, or open VTube Pro on your computer.', 'warn', 6000);
  return !!w;
}

// ---------------------------------------------------------------- the narrow AI API (same calls in local and web mode)
export interface AiConnectorInfo {
  id: string; name: string; kind: 'desktop' | 'remote' | 'local'; blurb: string; supported: boolean; ready: boolean;
  lastTest: { ok: boolean; at: number; title: string } | null; model?: string;
}
export interface AiEvent { t: number; kind: string; text?: string; tool?: string; image?: string }

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const t = await r.text();
  let j: any = null;
  try { j = JSON.parse(t); } catch { /* not JSON */ }
  if (!r.ok) throw Object.assign(new Error(j?.error ?? `VTube Pro answered ${r.status}`), { status: r.status, code: j?.code, helper: !!j?.helper });
  return j as T;
}
export const aiApi = {
  connectors: () => call<{ connectors: AiConnectorInfo[] }>('GET', '/api/ai/connectors').then((r) => r.connectors),
  test: (id: string) => call<{ ok: boolean; title: string; detail?: string; fix?: string }>('POST', `/api/ai/connectors/${encodeURIComponent(id)}/test`, {}),
  chat: (connector: string, message: string, sessionId?: string) => call<{ sessionId: string; model: string }>('POST', '/api/ai/chat', { connector, message, sessionId }),
  poll: (sessionId: string, since: number) => call<{ busy: boolean; events: AiEvent[]; next: number; model: string }>('GET', `/api/ai/chat/${encodeURIComponent(sessionId)}?since=${since}`),
};
/** AIs the studio itself can chat with (a model on this PC); desktop apps / Grok Bot chat in their own app. */
export const chatCapable = (c: AiConnectorInfo) => c.kind === 'local' && c.ready;
