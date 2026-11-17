// OBS's own scene transition, set through the helper (lane obs-wizard) — for the Live panel's Transitions / OBS tab
// (lane live-tabs) and anything else outside the wizard. Same helper routes as the wizard: the change is planned
// (POST /api/obs/setup/plan), applied with that plan's id (POST /api/obs/setup/apply) and can be undone
// (POST /api/obs/setup/undo). Local only.
import { TRANSITION_MS, type Plan } from '../../shared/obsSetup.ts';

export interface ObsTransitions { ok: boolean; transitions: string[]; current: { name: string; ms: number | null } | null; lengths: number[]; error?: string; fix?: string }
export interface ObsTransitionResult { ok: boolean; summary: string; undoId: string | null; error?: string }

async function post<T>(path: string, body: unknown): Promise<{ status: number; data: T | null }> {
  try {
    const r = await fetch(path, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) as T | null };
  } catch { return { status: 0, data: null }; }
}

/** OBS's transitions + the current one (read-only). null = the helper couldn't be asked (older version / not running). */
export async function getObsTransitions(): Promise<ObsTransitions | null> {
  try {
    const r = await fetch('/api/obs/transitions', { cache: 'no-store' });
    if (!r.ok) return null;
    return { ...(await r.json() as ObsTransitions), lengths: TRANSITION_MS };
  } catch { return null; }
}

/** Set OBS's scene transition + length (one user click). Returns a sentence to show and an id for Undo. */
export async function setObsTransition(name: string, ms: number): Promise<ObsTransitionResult> {
  const a = { action: 'transition', name, ms: Math.round(ms) };
  for (let tries = 0; tries < 2; tries++) {
    const p = await post<Plan>('/api/obs/setup/plan', a);
    if (!p.data?.ok) return { ok: false, summary: '', undoId: null, error: p.data?.error ?? 'VTube Pro couldn’t ask OBS. Is OBS open?' };
    if (p.data.nothing) return { ok: true, summary: `OBS already uses “${name}”.`, undoId: null };
    const r = await post<{ ok: boolean; undoId: string | null; error?: string }>('/api/obs/setup/apply', { ...a, planId: p.data.id });
    if (r.status === 409) continue;                       // OBS changed between the two calls: plan again once
    return r.data?.ok ? { ok: true, summary: `OBS now uses “${name}”, ${Math.round(ms) / 1000} s.`, undoId: r.data.undoId } : { ok: false, summary: '', undoId: null, error: r.data?.error ?? 'OBS didn’t change. Is it still open?' };
  }
  return { ok: false, summary: '', undoId: null, error: 'OBS kept changing. Try again.' };
}

/** Undo the latest change made through the helper (the id from setObsTransition / the wizard). */
export async function undoObsChange(id: string): Promise<{ ok: boolean; error?: string }> {
  const r = await post<{ ok: boolean; error?: string }>('/api/obs/setup/undo', { id });
  return r.data?.ok ? { ok: true } : { ok: false, error: r.data?.error ?? 'Couldn’t undo. Is OBS still open?' };
}
