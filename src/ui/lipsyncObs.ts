// "Make lips land on time" in ONE click: the lip-sync lookahead shows the mouth D ms late so it can see the sounds
// coming; OBS must delay the mic by the same D or viewers hear the voice before the mouth. Instead of telling the user
// to dig through OBS's Advanced Audio Properties, this sets every OBS mic's Sync Offset through the helper's OBS set-up
// API (server/obsSetup.ts: snapshot → plan → apply, read back, undo) — the same preview-then-apply path the OBS wizard
// uses. The click is the consent; Undo puts the old offsets back (only on mics nobody touched since).
// Observer sandboxes never change OBS (dry run).
import { h } from './dom.ts';
import type { Plan } from '../../shared/obsSetup.ts';

async function call<T>(url: string, body?: unknown, ms = 15000): Promise<T | null> {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: ac.signal, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    try { return await r.json() as T; } catch { return null; }
  } catch { return null; } finally { clearTimeout(t); }
}

export interface MicDelayResult { ok: boolean; text: string; undoId?: string | null }

type Mic = { name: string; offsetMs: number; virtual?: boolean };

/** Step 1: reach OBS and list its microphones (exact OBS names; virtual cables / mixers flagged). */
export async function obsMics(dry = false): Promise<{ ok: true; mics: Mic[] } | { ok: false; text: string }> {
  let st = await call<{ connected?: boolean; obs?: { mics?: Mic[] } | null }>('/api/obs/setup');
  if (!st?.connected) {
    // (observer sandboxes never look for OBS: "Find it" reads this PC's real OBS settings)
    if (dry) return { ok: false, text: 'Dry run (observer sandbox): OBS isn’t connected here, so nothing to show.' };
    await call('/api/obs/setup/find', {});
    st = await call<{ connected?: boolean; obs?: { mics?: Mic[] } | null }>('/api/obs/setup');
    if (!st?.connected) return { ok: false, text: 'We can’t reach OBS. Is it open? Then press this again. (Or set it by hand, below.)' };
  }
  const mics = st.obs?.mics;
  if (!mics) return { ok: false, text: 'VTube Pro could not read your OBS microphones. Press this again.' };
  if (!mics.length) return { ok: false, text: 'OBS has no microphone source. Add your mic in OBS (Sources → + → Audio Input Capture), then press this again.' };
  return { ok: true, mics };
}

/** Step 2: set the Sync Offset of exactly the `names` the user confirmed. `dry` = say what would happen, change nothing.
 *  `undoId` comes back whenever something in OBS changed, even when a later mic failed. */
export async function setObsMicDelay(ms: number, names: string[], dry = false): Promise<MicDelayResult> {
  const action = { action: 'mic-offset' as const, ms: Math.round(ms), names };
  const plan = await call<Plan>('/api/obs/setup/plan', action);
  if (!plan?.ok) return { ok: false, text: plan?.error ?? 'OBS didn’t answer the way we expected.' };
  if (plan.nothing) return { ok: true, text: ms ? `Already delayed by ${ms} ms in OBS.` : 'Already at no delay in OBS.' };
  if (dry) return { ok: true, text: `Dry run (observer sandbox): ${plan.summary}` };
  const res = await call<{ ok?: boolean; undoId?: string | null; error?: string; did?: string[] }>('/api/obs/setup/apply', { ...action, planId: plan.id });
  const list = names.map((n) => `“${n}”`).join(', ');
  if (!res?.ok) return { ok: false, text: `${res?.error ?? 'OBS didn’t take the change.'}${res?.did?.length ? ` (Changed: ${res.did.length} of ${names.length}.)` : ''}`, undoId: res?.undoId ?? null };
  return { ok: true, text: ms ? `Done: OBS delays ${list} by ${ms} ms, so viewers hear you right on the mouth.` : `Done: ${list} has no delay in OBS now.`, undoId: res.undoId ?? null };
}

/** A "Set it in OBS for me" button: lists OBS's microphones by their exact names (virtual cables unticked), the user
 *  confirms the list, then the result line (with Undo whenever something changed). For the lip-sync guide's OBS card. */
export function obsMicButton(ms: number, dry: boolean): HTMLElement {
  const out = h('div', { class: 'ls-obsres', role: 'status', 'aria-live': 'polite' });
  const b = h('button', { class: 'ls-btn primary', 'data-ui': 'obs-mic-delay' }, ms ? `Set it in OBS for me (${ms} ms)` : 'Set it back in OBS for me') as HTMLButtonElement;
  const undoBtn = (id: string) => {
    const u = h('button', { class: 'ls-link', 'data-ui': 'obs-mic-undo' }, 'Undo') as HTMLButtonElement;
    u.onclick = async () => { const x = await call<{ ok?: boolean; error?: string }>('/api/obs/setup/undo', { id }); out.textContent = x?.ok ? 'Undone: your mic delay in OBS is back as it was.' : `Couldn’t undo: ${x?.error ?? 'OBS didn’t answer'}`; };
    return u;
  };
  b.onclick = async () => {
    b.disabled = true; out.textContent = 'Looking at OBS…';
    const m = await obsMics(dry);
    b.disabled = false;
    if (!m.ok) { out.textContent = m.text; return; }
    const boxes = m.mics.map((mic) => {
      const c = h('input', { type: 'checkbox', checked: !mic.virtual }) as HTMLInputElement;
      return { mic, c, row: h('label', { class: 'ls-obsmic' }, c, ` “${mic.name}”`, mic.virtual ? h('small', null, ' (a virtual cable / mixer: probably not your voice)') : null, mic.offsetMs ? h('small', null, ` now ${mic.offsetMs} ms`) : null) };
    });
    const go = h('button', { class: 'ls-btn primary', 'data-ui': 'obs-mic-confirm' }, ms ? `Delay the ticked ones by ${ms} ms` : 'Set the ticked ones to no delay') as HTMLButtonElement;
    const cancel = h('button', { class: 'ls-link' }, 'Cancel') as HTMLButtonElement;
    cancel.onclick = () => { out.replaceChildren(); };
    go.onclick = async () => {
      const names = boxes.filter((x) => x.c.checked).map((x) => x.mic.name);
      if (!names.length) { out.append(h('p', null, 'Tick at least one microphone.')); return; }
      go.disabled = true;
      const r = await setObsMicDelay(ms, names, dry);
      out.replaceChildren(r.text);
      if (r.undoId) out.append(' ', undoBtn(r.undoId));
    };
    out.replaceChildren(h('p', null, 'Which microphones carry your voice in OBS?'), ...boxes.map((x) => x.row), h('div', { class: 'ls-obsauto' }, go, cancel));
  };
  return h('div', { class: 'ls-obsauto' }, b, out);
}
