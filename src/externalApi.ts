// REST client for external tracking sources (server/routes/external.ts).
// Types are imported type-only from the server so the two can't drift (erased at build time).
import type { ExternalConfig, ExternalManager } from '../server/tracking/manager.ts';
import type { SourceStatus } from '../server/tracking/common.ts';
import type { VtsPending, VtsTokenRecord } from '../server/tracking/vtsApi.ts';
import type { PhoneNetView } from '../server/tracking/phoneNet.ts';
import type { LanPick } from '../shared/phoneNet.ts';

export type { ExternalConfig, SourceStatus, VtsPending, PhoneNetView };
export type VtsToken = Omit<VtsTokenRecord, 'hash'>;
export interface ExternalStatus {
  vtsPhone: SourceStatus;
  ifacialmocap: SourceStatus;
  liveLinkFace: SourceStatus;
  vmc: SourceStatus;
  vtsApi: SourceStatus;
  vmcOut: { enabled: boolean; host: string; port: number; sent: number; lastError: string | null };
}
export interface ExternalView { config: ExternalConfig; status: ExternalStatus; /** this PC's ONE LAN IPv4 (shared/phoneNet.ts) */ lan: string[]; lanPick?: LanPick }
export type DetectView = ReturnType<ExternalManager['detectView']>;
export interface PlainResult { ok: boolean; says: string; dryRun?: boolean; url?: string }

/** Deep-partial config patch for PUT /api/external. */
export type ExternalPatch = { [K in keyof ExternalConfig]?: Partial<{ [P in keyof ExternalConfig[K]]: ExternalConfig[K][P] extends object ? Partial<ExternalConfig[K][P]> : ExternalConfig[K][P] }> };

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const b = await res.json(); msg = b.error ?? msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** POST with the user-action header, only while the browser says the user just clicked (navigator.userActivation). */
function userAction(url: string): Promise<Response> {
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  if (ua && !ua.isActive) return Promise.reject(new Error('Press the button again.'));
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-vtp-user-action': '1' }, body: '{}' });
}

export const externalApi = {
  get: () => fetch('/api/external').then((r) => j<ExternalView>(r)),
  update: (patch: ExternalPatch) => fetch('/api/external', json('PUT', patch)).then((r) => j<ExternalView>(r)),
  pending: () => fetch('/api/external/vts/pending').then((r) => j<VtsPending[]>(r)),
  decide: (id: string, allow: boolean) => fetch('/api/external/vts/approve', json('POST', { id, allow })).then((r) => j<{ ok: true }>(r)),
  tokens: () => fetch('/api/external/vts/tokens').then((r) => j<VtsToken[]>(r)),
  revoke: (id: string) => fetch(`/api/external/vts/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => j<{ ok: true }>(r)),
  /** This PC's address, the Windows firewall rule, the network's Public / Private profile. */
  phoneNet: (fresh = false) => fetch(`/api/external/phone-net${fresh ? '?fresh=1' : ''}`).then((r) => j<PhoneNetView>(r)),
  /** "Let phones connect": Windows asks the user (UAC) once. */
  /** "Let phones connect": Windows asks the user (UAC) once. Only from a click on a page on this PC (the helper refuses
   *  a page on another address, and this refuses to send without a real user action). */
  allowFirewall: () => userAction('/api/external/firewall').then((r) => j<PlainResult & { view: PhoneNetView }>(r)),
  openNetworkSettings: () => userAction('/api/external/network-settings').then((r) => j<PlainResult>(r)),
  /** "Find my phone": every known phone port at once; which app sends (server/tracking/phoneDetect.ts). */
  detect: () => fetch('/api/external/detect').then((r) => j<DetectView>(r)),
  detectSet: (on: boolean) => fetch('/api/external/detect', json('POST', { on })).then((r) => j<DetectView>(r)),
  /** "That's not my phone": forget the phone that was locked in. */
  /** "Another phone is sending - use it?" [Use it]. */
  switchPhone: (source: 'vtsPhone' | 'ifacialmocap' | 'liveLinkFace' | 'vmc') => fetch('/api/external/switch-phone', json('POST', { source })).then((r) => j<{ ok: boolean }>(r)),
  forgetPhone: (source: 'vtsPhone' | 'ifacialmocap' | 'liveLinkFace' | 'vmc') => fetch('/api/external/forget-phone', json('POST', { source })).then((r) => j<{ ok: boolean }>(r)),
};
