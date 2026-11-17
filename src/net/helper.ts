// Where this page's server is. VTube Pro is a purely local app: every page is served by the VTube Pro server on this PC
// (localhost / 127.0.0.1, or the optional Stream PC page over the home network), so /api, /library and /ws always go to the
// page's own origin and nothing here patches fetch, WebSocket or links.
const LOOPBACK = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)*\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i;
const DEFAULT_HELPER_ORIGIN = 'http://127.0.0.1:5191';
const ORIGIN_KEY = 'vtp.helper.origin';

const store = {
  get(s: Storage | undefined, k: string): string | null { try { return s?.getItem(k) ?? null; } catch { return null; } },
};
const ls = (() => { try { return window.localStorage; } catch { return undefined; } })();
const ss = (() => { try { return window.sessionStorage; } catch { return undefined; } })();

function isLoopbackOrigin(o: string): boolean {
  try { const u = new URL(o); return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.test(u.hostname) && u.origin === o.replace(/\/$/, ''); } catch { return false; }
}

/** A page a STREAM PC loads from the gaming PC's server over the home network (http://192.168.x.y:5191/output.html,
 *  Stream PC mode: server/streamPc.ts, docs/TWO_PC_STREAMING.md). Same-origin URLs, its cookie carries the pairing. */
export const LAN_PAGE = location.protocol === 'http:' && !LOOPBACK.test(location.hostname)
  && (/^(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01])|169\.254)\.\d{1,3}\.\d{1,3}$/.test(location.hostname) || /^[a-z0-9][a-z0-9-]{0,62}(\.(local|lan|home))?$/i.test(location.hostname));

/** This PC's server (default http://127.0.0.1:5191; only a loopback address saved in storage replaces it). */
export const HELPER_ORIGIN: string = [store.get(ss, ORIGIN_KEY), store.get(ls, ORIGIN_KEY)].find((o): o is string => !!o && isLoopbackOrigin(o)) ?? DEFAULT_HELPER_ORIGIN;
/** Address of a page of this server, for a link the user opens in a new tab. */
export const helperPageUrl = (path: string) => `${HELPER_ORIGIN}${path}`;
