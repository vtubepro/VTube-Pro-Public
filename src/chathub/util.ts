// Tiny DOM + fetch helpers for the Chat Hub window (no framework; the page must stay light next to the live studio).
import { PLATFORM_COLORS, SUPPORT_PLATFORM_NAMES, type ChatPlatform } from '../../shared/chat.ts';

type Attrs = Record<string, unknown> | null;
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = null, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'style' && typeof v === 'string') el.setAttribute('style', v);
    else if (k === 'class') el.className = String(v);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const J = async <T>(r: Response): Promise<T> => {
  if (!r.ok) { let m = `${r.status}`; try { m = (await r.json()).error ?? m; } catch { /* */ } throw new Error(m); }
  return r.json() as Promise<T>;
};
export const get = <T>(u: string) => fetch(u, { cache: 'no-store' }).then((r) => J<T>(r));
export const send = <T>(u: string, body: unknown = {}, method = 'POST') => fetch(u, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => J<T>(r));

let toastT = 0;
export function toast(msg: string) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  clearTimeout(toastT); toastT = window.setTimeout(() => t.remove(), 3200);
}

export const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(`vtp.hub.${k}`); return v ? JSON.parse(v) as T : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(`vtp.hub.${k}`, JSON.stringify(v)); } catch { /* private window */ } },
};

export const PLAT_NAME: Record<ChatPlatform, string> = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick', rumble: 'Rumble', tiktok: 'TikTok', test: 'Test', ...SUPPORT_PLATFORM_NAMES };

/** Small vector platform marks (no remote logos). */
export function icon(p: ChatPlatform, cls = 'pic'): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', cls);
  const shapes: Partial<Record<ChatPlatform, string>> = {
    twitch: '<path fill="#9146ff" d="M4 2 2 6v14h5v3h3l3-3h4l5-5V2zm16 12-3 3h-5l-3 3v-3H5V4h15z"/><path fill="#9146ff" d="M15 7h2v5h-2zm-5 0h2v5h-2z"/>',
    youtube: '<rect x="1" y="4" width="22" height="16" rx="5" fill="#ff0033"/><path fill="#fff" d="m10 8 6 4-6 4z"/>',
    kick: '<rect x="1" y="1" width="22" height="22" rx="4" fill="#0b0f0a"/><path fill="#53fc18" d="M5 4h4v5h2V7h2V5h2V4h4v5h-2v2h-2v2h2v2h2v5h-4v-1h-2v-2h-2v-2H9v5H5z"/>',
    rumble: '<circle cx="12" cy="12" r="11" fill="#85c742"/><path fill="#fff" d="m9 7 8 5-8 5z"/>',
    tiktok: '<rect x="1" y="1" width="22" height="22" rx="6" fill="#111"/><path fill="#25f4ee" d="M10.5 9.5v6.2a2 2 0 1 1-2-2v-2.3a4.3 4.3 0 1 0 4.3 4.3V8.2a5 5 0 0 0 3 1V7a3 3 0 0 1-3-3h-2.3z" transform="translate(-.6 .4)"/><path fill="#fe2c55" d="M10.5 9.5v6.2a2 2 0 1 1-2-2v-2.3a4.3 4.3 0 1 0 4.3 4.3V8.2a5 5 0 0 0 3 1V7a3 3 0 0 1-3-3h-2.3z" transform="translate(.6 -.4)"/><path fill="#fff" d="M10.5 9.5v6.2a2 2 0 1 1-2-2v-2.3a4.3 4.3 0 1 0 4.3 4.3V8.2a5 5 0 0 0 3 1V7a3 3 0 0 1-3-3h-2.3z"/>',
    test: '<circle cx="12" cy="12" r="10" fill="#9aa4b8"/><path fill="#0e1117" d="M8 7h8v2h-3v8h-2V9H8z"/>',
  };
  // support services (beta.13): a heart in the service's colour (no brand logos)
  const sup = Object.hasOwn(SUPPORT_PLATFORM_NAMES, p) ? PLATFORM_COLORS[p] : '';
  s.innerHTML = shapes[p] ?? (sup ? `<circle cx="12" cy="12" r="11" fill="${sup}"/><path fill="#0e1117" d="M12 18.5 6.3 13a3.4 3.4 0 0 1 4.8-4.8l.9.9.9-.9a3.4 3.4 0 0 1 4.8 4.8z"/>` : shapes.test!);
  return s;
}

/** Remote emote images go through this PC's server (allow-listed CDNs, cached). */
export const emoteSrc = (u: string) => (u.startsWith('/') ? u : `/api/chat/img?u=${encodeURIComponent(u)}`);

export function ago(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}
export const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
