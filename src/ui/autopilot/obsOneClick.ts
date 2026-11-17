// Autopilot: "Add to OBS" in ONE click. Every "Set up OBS" button (src/ui/obsWizard.ts openObsWizard, one hook) first
// tries to do the whole job through the helper's existing OBS set-up API (server/obsSetup.ts):
//   find OBS's remote control on this PC (POST /api/obs/setup/find: reads OBS's own settings, no password typing)
//   → preview "add the VTube Pro Browser Source to the scene OBS shows now" (POST /plan) → do it (POST /apply).
// It says what it did in one sentence, with Undo and "More OBS options". Only when something needs the user (OBS not
// installed, not open, its remote control off) does the step-by-step wizard open, right at that step, with the reason.
// The click on "Set up OBS" / "Add to OBS" is the consent; the change is the same one the wizard's own button makes, and
// Undo removes it (POST /undo).
import { h, toast } from '../dom.ts';
import type { ObsSetupState, Plan, StepId } from '../../../shared/obsSetup.ts';

export type OneClick = { open: false } | { open: true; step?: StepId; why?: string };

async function getJson<T>(url: string, body?: unknown, ms = 15000): Promise<{ status: number; data: T | null }> {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: ac.signal, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data: T | null = null; try { data = await r.json() as T; } catch { /* not json */ }
    return { status: r.status, data };
  } catch { return { status: 0, data: null }; } finally { clearTimeout(t); }
}

const CSS = `
.ap-obs{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9050;width:min(560px,calc(100vw - 32px));display:flex;gap:12px;align-items:center;padding:12px 14px;border-radius:14px;
  border:1px solid rgb(123 216 143 / .45);background:var(--bg2,#0b0f12);color:var(--text);box-shadow:0 20px 60px -20px #000c;font-size:14px;animation:ap-obs-in .25s ease-out}
.ap-obs.busy{border-color:var(--line)}.ap-obs .t{flex:1;min-width:0;line-height:1.4}.ap-obs .t small{display:block;color:var(--dim);font-size:12.5px}
.ap-obs button{font:600 13px/1 inherit;border-radius:99px;padding:9px 13px;border:1px solid var(--line);background:var(--panel);color:var(--text);cursor:pointer;white-space:nowrap}
.ap-obs button.primary{background:var(--accent);color:var(--accent-ink,#0b1410);border-color:transparent}
.ap-obs .tick{width:24px;height:24px;border-radius:50%;background:#7bd88f;color:#06100a;display:grid;place-items:center;font:800 14px/1 system-ui;flex:none}
.ap-obs .spin{width:18px;height:18px;border-radius:50%;border:2px solid rgb(123 216 143 / .3);border-top-color:#7bd88f;animation:ap-obs-sp .8s linear infinite;flex:none}
@keyframes ap-obs-sp{to{transform:rotate(360deg)}}@keyframes ap-obs-in{from{opacity:0;transform:translate(-50%,8px)}}
@media (max-width:520px){.ap-obs{flex-wrap:wrap}.ap-obs .t{flex-basis:calc(100% - 40px)}}
`;
let bar: HTMLElement | null = null;
let hideTimer = 0;
/** The card look (the invite card uses it too). */
export function ensureCardStyle() { if (!document.getElementById('ap-obs-style')) document.head.append(h('style', { id: 'ap-obs-style' }, CSS)); }
function show(kids: Node[], busy = false, ms = 0) {
  ensureCardStyle();
  bar?.remove(); clearTimeout(hideTimer);
  bar = h('div', { class: `ap-obs${busy ? ' busy' : ''}`, role: 'status', 'aria-live': 'polite', 'data-ui': 'obs-one-click' }, ...kids);
  document.body.append(bar);
  if (ms) hideTimer = window.setTimeout(() => { bar?.remove(); bar = null; }, ms);
}
const hide = () => { bar?.remove(); bar = null; clearTimeout(hideTimer); };

/** Where the wizard should open when OBS itself needs the user. */
function stepFor(s: ObsSetupState | null): { step: StepId; why: string } {
  if (!s || (!s.install.found && !s.connected)) return { step: 'install', why: 'We can’t find OBS on this computer yet.' };
  if (!s.remote.enabled && !s.connected) return { step: 'remote', why: 'OBS’s remote control is off: one tick in OBS turns it on.' };
  return { step: 'connect', why: 'Is OBS open? Start OBS, then press Set up OBS again.' };
}

let running = false;
/** Try the whole "Add VTube Pro to OBS" in one go. `open: true` = the wizard should open (at `step`). */
export async function addToObs(): Promise<OneClick> {
  if (running) return { open: false };
  running = true;
  try {
    show([h('span', { class: 'spin', 'aria-hidden': 'true' }), h('span', { class: 't' }, 'Adding VTube Pro to OBS…', h('small', null, 'Looking for OBS on this computer.'))], true);
    let st = (await getJson<ObsSetupState>('/api/obs/setup')).data;
    if (!st?.connected) {
      const f = (await getJson<{ connected?: boolean }>('/api/obs/setup/find', {})).data;
      if (!f?.connected) { hide(); return { open: true, ...stepFor(st) }; }
      st = (await getJson<ObsSetupState>('/api/obs/setup')).data;
    }
    const snap = st?.obs;
    if (!st || !snap) { hide(); return { open: true, ...stepFor(st) }; }
    const scene = snap.current ?? snap.scenes[0]?.name;
    if (!scene) { hide(); return { open: true, step: 'source', why: 'OBS has no scene yet: add one in OBS (the + under Scenes), then press Add.' }; }
    const inScene = snap.scenes.find((x) => x.name === scene)?.items.some((i) => snap.vtpInputs.includes(i.name));
    if (inScene) {
      done(`VTube Pro is already in your OBS scene “${scene}”.`, st.outputs.inObs > 0 ? 'OBS shows your avatar.' : 'If OBS shows nothing, right-click the VTube Pro source in OBS → Refresh.', null);
      return { open: false };
    }
    const action = { action: 'add-source' as const, scene };
    const plan = (await getJson<Plan>('/api/obs/setup/plan', action)).data;
    if (!plan?.ok) { hide(); return { open: true, step: 'source', why: plan?.error ?? 'OBS didn’t answer the way we expected.' }; }
    const res = await getJson<{ ok?: boolean; undoId?: string | null; error?: string }>('/api/obs/setup/apply', { ...action, planId: plan.id });
    if (!res.data?.ok) { hide(); return { open: true, step: 'source', why: res.data?.error ?? 'OBS didn’t take the change.' }; }
    done(`Done: VTube Pro is in your OBS scene “${scene}”.`, 'Your viewers see your avatar when you press Start Streaming in OBS.', res.data.undoId ?? null);
    return { open: false };
  } finally { running = false; }
}

function done(title: string, sub: string, undoId: string | null) {
  const more = h('button', { onClick: () => { hide(); void import('../obsWizard.ts').then((m) => m.openObsWizard({ step: 'scenes', full: true })); } }, 'More OBS options');
  const undo = undoId ? h('button', { onClick: async () => {
    const r = await getJson<{ ok?: boolean; error?: string }>('/api/obs/setup/undo', { id: undoId });
    hide();
    toast(r.data?.ok ? 'Undone: VTube Pro is out of OBS again.' : `Couldn’t undo: ${r.data?.error ?? 'OBS didn’t answer'}`, r.data?.ok ? 'ok' : 'warn', 5000);
  } }, 'Undo') : null;
  show([h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓'), h('span', { class: 't' }, title, h('small', null, sub)), ...(undo ? [undo] : []), more, h('button', { class: 'primary', onClick: hide }, 'OK')], false, 15000);
}
