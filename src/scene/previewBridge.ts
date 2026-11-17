// The studio's room preview in its OWN renderer process (docs/PERFORMANCE.md "Room preview off the tracker's thread").
//
// The preview (output.html?preview=1: the room exactly as OBS renders it) used to be a same-origin iframe: it ran on the
// studio's main thread — the thread that feeds the face tracker — so loading a room in it stalled tracking for up to
// ~2 s (first Room visit, measured). Chrome / Edge (site isolation) and Firefox (Fission) put a CROSS-SITE iframe in its
// own process, and `127.0.0.1` and `localhost` are different sites. So a studio on http://127.0.0.1:5191 loads its
// preview from http://localhost:5191 (and the dev studio on localhost:5190 from 127.0.0.1:5190): the same helper, the
// same files and API, another process. The server's loopback Host / Origin guard (server/localGuard.ts) already accepts
// both names, so nothing on the server changes.
//
// The two pages can no longer call each other, so the PreviewHost / PreviewPage interface (src/scene/previewLink.ts)
// travels over a MessageChannel instead:
//   preview → studio  window.postMessage({vtp:'preview-hello'}, <the studio origin from ?bridge=>)
//   studio → preview  e.source.postMessage({vtp:'preview-port', env}, <the preview origin>, [port])
// Both ends check origins on an explicit allowlist: the studio only answers its own preview origin (the other loopback
// name, same port) from one of its own <iframe>s; the preview only accepts a port from its parent window at the origin
// named in ?bridge=, and only when that is a loopback origin on the preview's own port. Everything after that runs on
// the private port. A window shared for the React screen (a MediaStream can't be posted) reaches the preview over a
// local WebRTC link signalled on the same port (src/scene/screenShare.ts), like the OBS pages get it.
//
// Not used (same-origin, exactly as before): observer / other hosts, pop-out preview
// windows, the set-up wizards' small previews, `localStorage vtp.previewIsolate = '0'`, and after a cross-site preview
// never said hello within 20 s (remembered for this session).
import type { SceneState } from '../../shared/types.ts';
import type { PreviewExtra, PreviewHost, PreviewPage, PreviewReport } from './previewLink.ts';
import { ScreenShareReceiver, ScreenShareSender } from './screenShare.ts';

type ScreenMsg = Extract<import('../../shared/types.ts').BusMessage, { type: 'screen' }>;
/** What the preview needs from the studio's own storage (its own origin has its own storage). */
export interface PreviewEnv { obsW?: string | null; obsH?: string | null; lastAvatar?: string | null }
type ToPreview =
  | { t: 'call'; fn: 'apply' | 'beat' | 'lookPreview' | 'chat' | 'curtainTest' | 'setActive' | 'setFps'; args: unknown[] }
  | { t: 'req'; id: number; fn: 'gfxBench'; args: unknown[] }
  | { t: 'env'; env: PreviewEnv }
  | { t: 'screen'; m: ScreenMsg };
type ToStudio =
  | { t: 'report'; r: PreviewReport }
  | { t: 'res'; id: number; ok: boolean; v?: unknown; err?: string }
  | { t: 'screen'; m: ScreenMsg }
  | { t: 'bye' };

const HELLO = 'vtp-preview-hello', PORT = 'vtp-preview-port';
const LOOP = /^(127\.0\.0\.1|localhost)$/;
const FAIL_KEY = 'vtp.previewIsolate.failed';
const OFF_KEY = 'vtp.previewIsolate';
const ss = { get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* */ } } };

/** The origin the studio loads its shared room preview from, or null = same origin (as before). */
export function previewIsolationOrigin(loc: Pick<Location, 'protocol' | 'hostname' | 'port'> = location,
  get: (k: string) => string | null = (k) => { try { return localStorage.getItem(k); } catch { return null; } }, failed = ss.get(FAIL_KEY) === '1'): string | null {
  if (failed || get(OFF_KEY) === '0') return null;
  if (loc.protocol !== 'http:' || !LOOP.test(loc.hostname) || !loc.port) return null;
  const other = loc.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
  return `http://${other}:${loc.port}`;
}

/** The preview page's URL for `query` (e.g. 'preview=1&fps=20&tier=medium'): cross-site when isolation applies. */
export function previewUrl(query: string, origin: string | null): string {
  if (!origin) return `/output.html?${query}`;
  return `${origin}/output.html?${query}&bridge=${encodeURIComponent(location.origin)}`;
}

/** The preview didn't say hello in time (the other loopback name unreachable, a strict browser setting): same-origin
 *  previews for the rest of this session. */
export function markIsolationFailed() { ss.set(FAIL_KEY, '1'); }

// ---------------------------------------------------------------- the studio's side
let installed = false;
/** Frames whose cross-site preview connected (src/ui/previewFrame.ts falls back to same-origin when one never does). */
export const bridgedFrames = new WeakSet<HTMLIFrameElement>();
/** Diagnostics (tools/preview_bridge_e2e.mjs): links made, hellos ignored (wrong origin / not our frame), capture links. */
export const bridgeStats = { links: 0, refused: 0, open: 0, capture: '' as string };
/** Studio: answer hellos from our cross-site preview frames and connect each one to the scene controller. */
export function installPreviewBridge(connect: PreviewHost['connect'], origin: string | null, studioEnv: () => PreviewEnv) {
  if (installed || !origin) return;
  installed = true;
  const live = new Map<Window, { id: string; end: () => void }>();
  window.addEventListener('message', (e: MessageEvent) => {
    if ((e.data as { vtp?: string } | null)?.vtp !== HELLO) return;
    if (e.origin !== origin || !e.source) { bridgeStats.refused++; return; }
    const src = e.source as Window;
    const frame = [...document.querySelectorAll('iframe')].find((f) => f.contentWindow === src) ?? null;
    if (!frame) { bridgeStats.refused++; return; }        // only our own frames
    const id = String((e.data as { id?: unknown }).id ?? '').slice(0, 40);
    const old = live.get(src);
    if (old?.id === id) return;                           // (a repeated hello, already answered)
    old?.end();                                           // (the same frame loaded again: the old link is done)
    const ch = new MessageChannel(), port = ch.port1;
    let dead = false, seq = 0;
    const pending = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void }>();
    const post = (m: ToPreview) => {
      if (dead || !frame.isConnected) { end(); throw new Error('preview gone'); }
      port.postMessage(m);
    };
    // the window shared for the React screen: a local WebRTC link over this port (only while one is shared)
    const screenIn = new Set<(m: ScreenMsg) => void>();
    let sender: ScreenShareSender | null = null;
    let shown = true;                                    // (the studio's PreviewGate: can anyone see this preview?)
    const page: PreviewPage & { frame: HTMLIFrameElement } = {
      frame,
      apply: (s: SceneState, self: string, ex: PreviewExtra[]) => { post({ t: 'env', env: studioEnv() }); post({ t: 'call', fn: 'apply', args: [s, self, ex] }); },
      setCapture: (stream) => {
        if (dead) return;                                 // (never throws: the controller loops over every page)
        if (stream && !sender) {
          sender = new ScreenShareSender((m) => { try { post({ t: 'screen', m }); } catch { /* gone */ } }, (h) => { const f = (m: ScreenMsg) => h(m); screenIn.add(f); return () => screenIn.delete(f); }, () => true, { preview: true });   // (a small box: capped stream, paused while nobody sees it)
          sender.setVisible(shown);
          sender.onStatus = (st) => { bridgeStats.capture = st.receivers.map((x) => x.state).join(',') || (st.sharing ? 'offered' : ''); };
        }
        sender?.setStream(stream);
      },
      beat: (b) => post({ t: 'call', fn: 'beat', args: [b] }),
      lookPreview: (l) => post({ t: 'call', fn: 'lookPreview', args: [l] }),
      chat: (evs) => post({ t: 'call', fn: 'chat', args: [evs] }),
      curtainTest: (st) => post({ t: 'call', fn: 'curtainTest', args: [st] }),
      setActive: (on, note) => { shown = on; sender?.setVisible(on); post({ t: 'call', fn: 'setActive', args: [on, note ?? null] }); },
      setFps: (fps) => post({ t: 'call', fn: 'setFps', args: [fps] }),
      gfxBench: (o) => new Promise((ok, no) => {
        const id = ++seq;
        pending.set(id, { ok: ok as (v: unknown) => void, no });
        try { post({ t: 'req', id, fn: 'gfxBench', args: [o ?? {}] }); } catch (err) { pending.delete(id); no(err as Error); }
      }),
    };
    const link = connect(page);
    bridgedFrames.add(frame);
    bridgeStats.links++; bridgeStats.open++;
    function end() {
      if (dead) return;
      dead = true;
      bridgeStats.open--;
      live.delete(src);
      for (const p of pending.values()) p.no(new Error('preview gone'));
      pending.clear();
      sender?.dispose(); sender = null;
      try { link.disconnect(); } catch { /* */ }
      try { port.close(); } catch { /* */ }
    }
    live.set(src, { id, end });
    port.onmessage = (ev: MessageEvent<ToStudio>) => {
      const m = ev.data;
      if (!m || typeof m !== 'object') return;
      if (m.t === 'report') { try { link.report(m.r); } catch { /* */ } }
      else if (m.t === 'res') { const p = pending.get(m.id); if (p) { pending.delete(m.id); if (m.ok) p.ok(m.v); else p.no(new Error(m.err ?? 'failed')); } }
      else if (m.t === 'screen') { for (const f of screenIn) f(m.m); }
      else if (m.t === 'bye') end();
    };
    src.postMessage({ vtp: PORT, v: 1, id, env: studioEnv() }, origin, [ch.port2]);
  });
}

// ---------------------------------------------------------------- the preview page's side (output.ts)
/** Preview page: the studio origin from ?bridge=, if it is one this page may talk to (a loopback origin on this page's
 *  own port, not this page's own origin). null = no bridge (same-origin preview, as before). */
export function bridgeOrigin(q: URLSearchParams, loc: Pick<Location, 'origin' | 'port'> = location): string | null {
  const b = q.get('bridge');
  if (!b) return null;
  let u: URL;
  try { u = new URL(b); } catch { return null; }
  if (u.protocol !== 'http:' || !LOOP.test(u.hostname) || u.port !== loc.port || u.origin !== b || u.origin === loc.origin) return null;
  return u.origin;
}

/** Preview page: say hello to the studio at `origin` and serve `page` over the port it answers with. Resolves the link
 *  (report / disconnect) and the studio's env once connected. */
export function connectBridge(origin: string, page: PreviewPage, onEnv: (env: PreviewEnv) => void): Promise<ReturnType<PreviewHost['connect']>> {
  return new Promise((resolve) => {
    const parent = window.parent;
    if (!parent || parent === window) return;
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { vtp?: string; id?: string } | null;
      if (e.origin !== origin || e.source !== parent || d?.vtp !== PORT || d.id !== nonce || !e.ports[0]) return;
      window.removeEventListener('message', onMsg);
      clearInterval(again);
      const port = e.ports[0];
      onEnv((e.data as { env?: PreviewEnv }).env ?? {});
      let rx: ScreenShareReceiver | null = null;
      const screenIn = new Set<(m: ScreenMsg) => void>();
      port.onmessage = async (ev: MessageEvent<ToPreview>) => {
        const m = ev.data;
        if (!m || typeof m !== 'object') return;
        try {
          if (m.t === 'env') onEnv(m.env ?? {});
          else if (m.t === 'call') {
            const a = m.args ?? [];
            if (m.fn === 'apply') page.apply(a[0] as SceneState, a[1] as string, a[2] as PreviewExtra[]);
            else if (m.fn === 'beat') page.beat?.(a[0]);
            else if (m.fn === 'lookPreview') page.lookPreview?.(a[0]);
            else if (m.fn === 'chat') page.chat?.(a[0] as unknown[]);
            else if (m.fn === 'curtainTest') page.curtainTest?.(a[0] as string);
            else if (m.fn === 'setActive') page.setActive?.(!!a[0], (a[1] as string | null) ?? null);
            else if (m.fn === 'setFps') page.setFps?.(typeof a[0] === 'number' ? a[0] : null);
          } else if (m.t === 'req' && m.fn === 'gfxBench') {
            try { port.postMessage({ t: 'res', id: m.id, ok: true, v: await page.gfxBench!(m.args?.[0] as { targetFps?: number }) } satisfies ToStudio); }
            catch (err) { port.postMessage({ t: 'res', id: m.id, ok: false, err: String((err as Error)?.message ?? err) } satisfies ToStudio); }
          } else if (m.t === 'screen') {
            // the studio shares a window: receive it over a local WebRTC link (created on the first message)
            if (!rx) {
              rx = new ScreenShareReceiver((sm) => port.postMessage({ t: 'screen', m: sm } satisfies ToStudio), (h) => { const f = (sm: ScreenMsg) => h(sm); screenIn.add(f); return () => screenIn.delete(f); });
              rx.onStream = (s) => page.setCapture(s);
            }
            for (const f of screenIn) f(m.m);
          }
        } catch (err) { console.warn('[preview bridge]', err); }
      };
      const send = (m: ToStudio) => {
        try { port.postMessage(m); }
        catch { try { port.postMessage(JSON.parse(JSON.stringify(m))); } catch { /* not sendable */ } }
      };
      resolve({ report: (r) => send({ t: 'report', r }), disconnect: () => { rx?.dispose(); send({ t: 'bye' }); try { port.close(); } catch { /* */ } } });
    };
    window.addEventListener('message', onMsg);
    const nonce = Math.random().toString(36).slice(2, 12);
    const hello = () => { try { parent.postMessage({ vtp: HELLO, v: 1, id: nonce }, origin); } catch { /* */ } };
    hello();
    // (the studio's listener may not be up yet when this page is very quick: say it again until answered)
    const again = window.setInterval(hello, 1000);
  });
}
