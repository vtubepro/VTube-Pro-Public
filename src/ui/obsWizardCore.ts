// "Set up OBS" wizard, the screens (lane obs-wizard). One thing per screen, a picture of the exact OBS window, and a
// check that turns green by itself (the helper's GET /api/obs/setup, polled while the wizard is open).
//
// Self-contained (no studio imports): it runs in the studio (src/ui/obsWizard.ts)
// and as VTube Pro's own page /obs/setup (src/obsSetupPage.ts). Every change in OBS is a click,
// previewed first ("We'll add …", POST /api/obs/setup/plan), then applied with the previewed plan id and undoable.
// The OBS password is never shown or typed on a web page: "Find it for me" lets the helper read it on this computer;
// typing it is offered only on pages served by this computer.
import { ART, artScenes, artSource, artTest } from './obsWizardArt.ts';
import {
  LOOKS, RECOMMENDED_SCENES, STEPS, TRANSITION_MS, firstOpenStep, stepChecks,
  type LookId, type ObsSetupState, type Plan, type PlanAction, type StepId,
} from '../../shared/obsSetup.ts';

export interface WizardEnv {
  /** 'local' = the studio on this computer; 'helper' = the full-page /obs/setup. */
  where: 'local' | 'helper';
  startAt?: StepId;
  /** Close the wizard (overlay). Missing on the full-page helper page. */
  close?: () => void;
  /** Web only: open the helper's page on this computer (to type the password there). */
  openHelperPage?: (path: string) => void;
}
export interface WizardHandle { destroy(): void; go(step: StepId): void }

type Child = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> | null = null, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'html') e.innerHTML = String(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}
async function call<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<{ status: number; data: T | null }> {
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(path, { method, cache: 'no-store', signal: ac.signal, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    let data: T | null = null; try { data = await r.json() as T; } catch { /* not json */ }
    return { status: r.status, data };
  } catch { return { status: 0, data: null }; } finally { clearTimeout(tm); }
}
function copy(text: string, done: (ok: boolean) => void) {
  const fallback = () => {
    const ta = el('textarea', { style: 'position:fixed;left:-9999px' }) as HTMLTextAreaElement; ta.value = text;
    document.body.append(ta); ta.select();
    try { done(document.execCommand('copy')); } catch { done(false); } ta.remove();
  };
  try { void navigator.clipboard.writeText(text).then(() => done(true), fallback); } catch { fallback(); }
}
const q = (s: string) => `“${s}”`;
/** replaceChildren without the empty slots. */
const put = (parent: HTMLElement, ...kids: Child[]) => parent.replaceChildren(...kids.filter((k): k is Node | string => k !== null && k !== undefined && k !== false));

export const WIZARD_CSS = `
.ow{--ow-bg:#0b0f12;--ow-card:#11171b;--ow-line:rgb(255 255 255/.09);--ow-line2:rgb(255 255 255/.16);--ow-fg:#eef3ef;--ow-mute:#9aa6a0;--ow-lime:#7bd88f;--ow-lime-hi:#a6f5b4;--ow-sky:#6cc7f5;--ow-amber:#ffcf6a;--ow-err:#ff6b6b;
  color:var(--ow-fg);font:15px/1.5 Geist,ui-sans-serif,system-ui,"Segoe UI",sans-serif;display:grid;grid-template-rows:auto 1fr;grid-template-columns:minmax(0,1fr);min-height:0;height:100%;background:var(--ow-bg)}
.ow *{box-sizing:border-box} .ow [hidden]{display:none!important}
.ow-top,.ow-body{min-width:0}
.ow h2:focus{outline:none}
.ow-top{display:flex;align-items:center;gap:14px;padding:14px 18px;border-bottom:1px solid var(--ow-line)}
.ow-brand{font:700 15px/1 Archivo,ui-sans-serif,system-ui,sans-serif;letter-spacing:-.01em;white-space:nowrap}
.ow-rail{display:flex;gap:4px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none}
.ow-rail button{all:unset;cursor:pointer;display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:99px;font-size:12.5px;color:var(--ow-mute);white-space:nowrap}
.ow-rail button:hover{color:var(--ow-fg);background:rgb(255 255 255/.05)}
.ow-rail button[aria-current="step"]{color:var(--ow-fg);background:rgb(255 255 255/.08)}
.ow-rail i{width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font:700 10.5px/1 ui-monospace,Consolas,monospace;font-style:normal;border:1.5px solid var(--ow-line2);color:var(--ow-mute)}
.ow-rail .ok i{background:var(--ow-lime);border-color:var(--ow-lime);color:#06080a}
.ow-x{all:unset;cursor:pointer;width:34px;height:34px;display:grid;place-items:center;border-radius:10px;color:var(--ow-mute);font-size:22px}.ow-x:hover{background:rgb(255 255 255/.06);color:var(--ow-fg)}
.ow-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.05fr);gap:28px;padding:26px 28px 28px;overflow:auto;min-height:0}
.ow-text{display:flex;flex-direction:column;gap:14px;min-width:0}
.ow-eyebrow{font:500 11px/1 "Geist Mono",ui-monospace,Consolas,monospace;letter-spacing:.2em;text-transform:uppercase;color:var(--ow-lime)}
.ow h2{margin:0;font:700 27px/1.15 Archivo,ui-sans-serif,system-ui,sans-serif;letter-spacing:-.02em}
.ow p{margin:0;color:var(--ow-mute)} .ow p b,.ow li b{color:var(--ow-fg)}
.ow ol.ow-do{margin:0;padding-left:22px;display:grid;gap:7px} .ow ol.ow-do li{padding-left:4px}
.ow-check{display:flex;gap:12px;align-items:center;padding:12px 14px;border-radius:14px;border:1px dashed var(--ow-line2)}
.ow-check b{display:block;font-size:15px} .ow-check span{color:var(--ow-mute);font-size:13.5px}
.ow-check .dot{width:22px;height:22px;flex:none;border-radius:50%;border:2px solid var(--ow-mute);display:grid;place-items:center}
.ow-check.wait .dot{border-color:var(--ow-mute);border-top-color:transparent;animation:ow-spin 1s linear infinite}
.ow-check.ok{border-style:solid;border-color:rgb(123 216 143/.45);background:rgb(123 216 143/.08)}
.ow-check.ok .dot{border-color:var(--ow-lime);background:var(--ow-lime)} .ow-check.ok .dot::after{content:"";width:9px;height:5px;border:solid #06080a;border-width:0 0 2.5px 2.5px;transform:translateY(-1px) rotate(-45deg)}
.ow-check.bad{border-style:solid;border-color:rgb(255 207 106/.45);background:rgb(255 207 106/.07)} .ow-check.bad .dot{border-color:var(--ow-amber)}
@keyframes ow-spin{to{transform:rotate(360deg)}}
.ow-btn{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:10px 18px;border-radius:12px;font-weight:600;font-size:15px;border:1px solid var(--ow-line2);background:rgb(255 255 255/.04);color:var(--ow-fg);text-align:center;transition:background .18s cubic-bezier(.16,1,.3,1),border-color .18s}
.ow-btn:hover{border-color:var(--ow-lime)}
.ow-btn.primary{background:var(--ow-lime);color:#06080a;border-color:transparent;min-height:52px;width:100%;font:700 16px/1.2 Archivo,ui-sans-serif,system-ui,sans-serif}
.ow-btn.primary:hover{background:var(--ow-lime-hi)}
.ow-btn.ghost{border-color:transparent;background:none;color:var(--ow-mute)} .ow-btn.ghost:hover{color:var(--ow-fg)}
.ow-btn.small{min-height:34px;padding:6px 12px;font-size:13.5px;border-radius:10px}
.ow-btn[disabled]{opacity:.55;cursor:progress}
.ow-btn:focus-visible,.ow-chip:focus-visible,.ow-rail button:focus-visible,.ow-x:focus-visible,.ow summary:focus-visible,.ow-sw:focus-visible{outline:2px solid var(--ow-lime);outline-offset:3px;border-radius:12px}
.ow-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center} .ow-row.spread{justify-content:space-between}
.ow-next{font-size:12.5px;color:var(--ow-mute)} .ow-next b{color:var(--ow-lime);font:500 11px/1 "Geist Mono",ui-monospace,monospace;letter-spacing:.14em;margin-right:6px}
.ow-art{margin:0;align-self:start;position:sticky;top:0;display:grid;gap:8px} .ow-art svg{width:100%;height:auto;display:block;border-radius:14px;border:1px solid var(--ow-line)}
.ow-art figcaption{font-size:12.5px;color:var(--ow-mute)}
.ow details{border:1px solid var(--ow-line);border-radius:12px;padding:10px 14px} .ow details[open]{display:grid;gap:10px}
.ow summary{cursor:pointer;color:var(--ow-mute);font-size:14px} .ow summary:hover{color:var(--ow-fg)}
.ow-copy{display:flex;align-items:center;gap:8px;padding:6px 6px 6px 12px;border-radius:10px;background:var(--ow-card);border:1px solid var(--ow-line)}
.ow-copy span{color:var(--ow-mute);font-size:12.5px;width:54px;flex:none} .ow-copy code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 13.5px/1.3 ui-monospace,Consolas,monospace}
.ow-chips{display:flex;flex-wrap:wrap;gap:6px}
.ow-chip{all:unset;cursor:pointer;padding:7px 13px;border-radius:99px;border:1px solid var(--ow-line2);font-size:13.5px;color:var(--ow-fg)}
.ow-chip:hover{border-color:var(--ow-lime)} .ow-chip[aria-checked="true"],.ow-chip[aria-pressed="true"]{background:var(--ow-lime);border-color:var(--ow-lime);color:#06080a;font-weight:600}
.ow-chip.new{border-style:dashed;color:var(--ow-mute)}
.ow-card{border:1px solid var(--ow-line);background:var(--ow-card);border-radius:14px;padding:14px;display:grid;gap:10px}
.ow-card.confirm{border-color:rgb(123 216 143/.5);background:rgb(123 216 143/.06)}
.ow-card ul{margin:0;padding-left:18px;color:var(--ow-mute);font-size:13.5px;display:grid;gap:3px}
.ow-msg{font-size:13.5px;color:var(--ow-mute)} .ow-msg.ok{color:var(--ow-lime)} .ow-msg.err{color:var(--ow-err)}
.ow-seg{display:inline-flex;padding:4px;border-radius:12px;background:var(--ow-card);border:1px solid var(--ow-line);gap:4px}
.ow-seg button{all:unset;cursor:pointer;padding:8px 14px;border-radius:9px;font-size:14px;color:var(--ow-mute)} .ow-seg button[aria-pressed="true"]{background:rgb(255 255 255/.1);color:var(--ow-fg);font-weight:600}
.ow-map{display:grid;gap:10px} .ow-look{display:grid;gap:6px} .ow-look>b{font-size:13.5px} .ow-look>b span{color:var(--ow-mute);font-weight:400}
.ow-toggle{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;align-items:start;padding:12px 14px;border-radius:14px;border:1px solid var(--ow-line);background:var(--ow-card)}
.ow-toggle>div{display:grid;gap:3px} .ow-toggle b{font-size:15px} .ow-toggle small{color:var(--ow-mute);font-size:13px}
.ow-sw{all:unset;cursor:pointer;width:44px;height:26px;border-radius:99px;background:rgb(255 255 255/.14);position:relative;margin-top:1px;transition:background .18s}
.ow-sw::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .18s cubic-bezier(.16,1,.3,1)}
.ow-sw[aria-checked="true"]{background:var(--ow-lime)} .ow-sw[aria-checked="true"]::after{transform:translateX(18px)}
.ow-input{all:unset;box-sizing:border-box;width:100%;padding:11px 12px;border-radius:12px;border:1px solid var(--ow-line2);background:#0a0e11;font-size:15px}
.ow-input:focus{border-color:var(--ow-lime)}
.ow-test{display:grid;gap:8px} .ow-test .ow-btn{justify-content:space-between;width:100%;text-align:left} .ow-test .ow-btn em{font-style:normal;font-size:12.5px;color:var(--ow-lime)}
.ow-big{font:700 34px/1.1 Archivo,ui-sans-serif,system-ui,sans-serif}
.ow-list{margin:0;padding:0;list-style:none;display:grid;gap:6px} .ow-list li{display:flex;gap:10px;align-items:center;font-size:14px} .ow-list li::before{content:"✔";color:var(--ow-lime);font-weight:700}
@media (max-width:860px){.ow-body{grid-template-columns:1fr;padding:18px 16px}.ow-art{position:static}.ow-rail span{display:none}.ow h2{font-size:23px}}
@media (prefers-reduced-motion:reduce){.ow *{transition:none!important;animation:none!important}}
`;

const STEP_INDEX = Object.fromEntries(STEPS.map((s, i) => [s.id, i])) as Record<StepId, number>;
const NEXT_HINT: Record<StepId, string> = {
  install: 'Next: turn on OBS’s remote control.',
  remote: 'Next: connect VTube Pro to OBS.',
  connect: 'Next: add VTube Pro to your OBS scene.',
  source: 'Next: your stream scenes.',
  scenes: 'Next: choose what happens by itself.',
  automation: 'Next: test it.',
  test: 'Next: you’re done.',
  done: '',
};

/** Mount the wizard into `host` (it fills it). */
export function mountObsWizard(host: HTMLElement, env: WizardEnv): WizardHandle {
  if (!document.getElementById('ow-style')) document.head.append(el('style', { id: 'ow-style' }, WIZARD_CSS));
  let st: ObsSetupState | null = null;
  let loaded = false;
  let cur: StepId = env.startAt ?? 'install';
  let alive = true;
  const tested = new Set<string>();
  let testedFrom: string | null = null;      // the scene OBS was on before the first Test press (Put it back)
  let stepUpdate: ((s: ObsSetupState | null) => void) | null = null;
  let picked = false;                         // the user chose a step (don't auto-jump any more)

  const root = el('div', { class: 'ow', role: 'region', 'aria-label': 'Set up OBS' });
  const rail = el('nav', { class: 'ow-rail', 'aria-label': 'Steps' });
  const body = el('div', { class: 'ow-body' });
  root.append(el('div', { class: 'ow-top' }, el('div', { class: 'ow-brand' }, 'Set up OBS'), rail,
    env.close ? el('button', { class: 'ow-x', 'aria-label': 'Close', title: 'Close (you can come back any time)', onClick: () => env.close?.() }, '×') : null));
  root.append(body);
  host.replaceChildren(root);

  const checks = () => stepChecks(st, [...tested]);
  function paintRail() {
    const c = checks();
    rail.replaceChildren(...STEPS.map((s, i) => el('button', {
      class: c[s.id] ? 'ok' : '', 'aria-current': s.id === cur ? 'step' : null, title: s.title,
      'aria-label': `Step ${i + 1}: ${s.title}${c[s.id] ? ' (done)' : ''}`, onClick: () => { picked = true; go(s.id); },
    }, el('i', null, c[s.id] ? '✓' : String(i + 1)), el('span', null, s.short))));
  }

  /** The live check line every step has. */
  function checkLine() {
    const box = el('div', { class: 'ow-check wait', role: 'status', 'aria-live': 'polite' }, el('i', { class: 'dot', 'aria-hidden': 'true' }), el('div', null, el('b'), el('span')));
    return {
      el: box,
      set(kind: 'ok' | 'wait' | 'bad', title: string, line = '') {
        box.className = `ow-check ${kind}`;
        (box.querySelector('b') as HTMLElement).textContent = title;
        (box.querySelector('span') as HTMLElement).textContent = line;
      },
    };
  }
  const msg = () => el('p', { class: 'ow-msg', role: 'status', 'aria-live': 'polite' });
  const setMsg = (m: HTMLElement, kind: '' | 'ok' | 'err', text: string) => { m.className = `ow-msg ${kind}`; m.textContent = text; };
  const nextBtn = (label = 'Next') => el('button', { class: 'ow-btn primary', onClick: () => go(STEPS[STEP_INDEX[cur] + 1]?.id ?? 'done') }, label);

  /** Frame for one step: text column + picture. `primary` is swapped by the step when its check turns green. */
  function frame(id: StepId, lead: Child[], content: Child[], art: string, caption: string, title = STEPS[STEP_INDEX[id]].title) {
    const i = STEP_INDEX[id];
    const back = i > 0 ? el('button', { class: 'ow-btn ghost small', onClick: () => go(STEPS[i - 1].id) }, '← Back') : null;
    const skip = id !== 'done' ? el('button', { class: 'ow-btn ghost small', onClick: () => go(STEPS[i + 1].id) }, 'Skip this step') : null;
    const text = el('section', { class: 'ow-text' },
      el('div', { class: 'ow-eyebrow' }, `Step ${i + 1} of ${STEPS.length}`),
      el('h2', { tabindex: '-1' }, title),
      ...lead.map((x) => (typeof x === 'string' ? el('p', null, x) : x)),
      ...content,
      el('div', { class: 'ow-row spread' }, back, skip),
      NEXT_HINT[id] ? el('div', { class: 'ow-next' }, el('b', null, 'NEXT'), NEXT_HINT[id].replace(/^Next: /, '')) : null);
    body.replaceChildren(text, el('figure', { class: 'ow-art' }, el('div', { html: art }), el('figcaption', null, caption)));
    (text.querySelector('h2') as HTMLElement).focus({ preventScroll: true });
    body.scrollTop = 0;
  }

  // ------------------------------------------------------------ plan → confirm → apply → undo (every OBS write)
  /** Shows the plan sentence + Yes / Cancel. Resolves with the apply result (or null when cancelled). */
  function confirmChange(slot: HTMLElement, a: PlanAction, yesLabel: string, after: (ok: boolean) => void) {
    const m = msg();
    slot.replaceChildren(el('p', { class: 'ow-msg' }, 'Checking OBS…'));
    void call<Plan>('/api/obs/setup/plan', a).then(({ data: plan, status }) => {
      if (!alive) return;
      if (!plan || status !== 200 || !plan.ok) { slot.replaceChildren(el('p', { class: 'ow-msg err' }, plan?.error ?? 'We couldn’t ask OBS. Is it still open? Try again.')); after(false); return; }
      if (plan.nothing) { slot.replaceChildren(el('p', { class: 'ow-msg ok' }, '✔ Already done. Nothing to change.')); after(true); return; }
      const yes = el('button', { class: 'ow-btn primary', onClick: () => void doApply() }, yesLabel);
      const card = el('div', { class: 'ow-card confirm', role: 'group', 'aria-label': 'Check the change' },
        el('p', null, el('b', null, plan.summary)),
        plan.steps.length > 1 ? el('ul', null, ...plan.steps.map((s) => el('li', null, s.text))) : null,
        el('p', { class: 'ow-msg' }, 'You can undo it right after.'),
        yes, el('button', { class: 'ow-btn ghost small', onClick: () => { slot.replaceChildren(); after(false); } }, 'Cancel'), m);
      slot.replaceChildren(card);
      yes.focus();
      async function doApply() {
        (yes as HTMLButtonElement).setAttribute('disabled', ''); yes.textContent = 'Working…';
        const r = await call<{ ok: boolean; did: string[]; undoId: string | null; error?: string; plan?: Plan }>('/api/obs/setup/apply', { ...a, planId: plan!.id });
        if (!alive) return;
        if (r.status === 409 && r.data?.plan) { confirmChange(slot, a, yesLabel, after); return; }   // OBS changed: show the new plan
        if (!r.data?.ok) {
          yes.removeAttribute('disabled'); yes.textContent = 'Try again';
          setMsg(m, 'err', r.data?.error ?? 'OBS didn’t answer. Is it still open?');
          if (r.data?.undoId) slot.append(undoRow(r.data.undoId, 'Undo the part that worked'));
          after(false); return;
        }
        put(slot, el('p', { class: 'ow-msg ok' }, r.data.did.length ? '✔ Done.' : '✔ Already done. Nothing to change.'), r.data.undoId ? undoRow(r.data.undoId) : null);
        void refresh();
        after(true);
      }
    });
  }
  function undoRow(id: string, label = 'Undo') {
    const m = msg();
    const b = el('button', { class: 'ow-btn small', onClick: async () => {
      b.setAttribute('disabled', ''); b.textContent = 'Undoing…';
      const r = await call<{ ok: boolean; did: string[]; kept: string[]; error?: string }>('/api/obs/setup/undo', { id });
      if (!alive) return;
      b.remove();
      setMsg(m, r.data?.ok ? 'ok' : 'err', r.data?.ok ? `✔ Undone. ${[...r.data.did, ...r.data.kept].join(' · ')}` : r.data?.error ?? 'Couldn’t undo. Is OBS still open?');
      void refresh();
    } }, `↶ ${label}`);
    return el('div', { class: 'ow-row' }, b, m);
  }

  // ------------------------------------------------------------ the steps
  function needConnection(c: ReturnType<typeof checkLine>, s: ObsSetupState | null) {
    if (s?.connected) return false;
    c.set('bad', 'VTube Pro can’t reach OBS right now', 'Is OBS open? If it is, go back to step 3 and press Find it for me.');
    return true;
  }

  const steps: Record<StepId, () => void> = {
    install() {
      const c = checkLine();
      const slot = el('div', { class: 'ow-row' });
      frame('install', ['VTube Pro shows your avatar inside OBS, the free app most streamers use.', 'We look for OBS on this computer.'],
        [c.el, slot], ART.install(), 'Get OBS from obsproject.com. It’s free.');
      stepUpdate = (s) => {
        if (!s) { c.set('wait', 'Looking for OBS…'); return; }
        if (s.install.found || s.connected) {
          c.set('ok', 'OBS is on this computer', s.obs?.obsVersion ? `OBS ${s.obs.obsVersion}` : s.install.settings ? 'It has been opened before. Good.' : 'Open it once before the next step.');
          slot.replaceChildren(nextBtn());
        } else {
          c.set('wait', 'We can’t find OBS yet', 'Install it, open it once, then come back. This turns green by itself.');
          slot.replaceChildren(el('a', { class: 'ow-btn primary', href: 'https://obsproject.com/download', target: '_blank', rel: 'noopener noreferrer' }, 'Get OBS (free)'));
        }
      };
    },

    remote() {
      const c = checkLine();
      const slot = el('div', { class: 'ow-row' });
      frame('remote', ['VTube Pro switches your OBS scenes for you. For that, OBS’s remote control has to be on.'], [
        el('ol', { class: 'ow-do' },
          el('li', null, 'In OBS, click ', el('b', null, 'Tools'), ' at the top.'),
          el('li', null, 'Click ', el('b', null, 'WebSocket Server Settings'), '.'),
          el('li', null, 'Tick ', el('b', null, 'Enable WebSocket server'), '.'),
          el('li', null, 'Click ', el('b', null, 'Apply'), ', then ', el('b', null, 'OK'), '.')),
        el('details', null, el('summary', null, 'Why do I need this?'),
          el('p', null, 'OBS only takes orders from apps you allow. This switch lets VTube Pro on your computer press OBS’s buttons for you.'),
          el('p', null, 'It’s protected by a password OBS made for you. You won’t need to type it.')),
        c.el, slot,
      ], ART.remote(), 'OBS: Tools → WebSocket Server Settings → tick “Enable WebSocket server” → Apply.');
      stepUpdate = (s) => {
        if (!s) { c.set('wait', 'Checking OBS…'); return; }
        if (s.remote.enabled || s.connected) { c.set('ok', 'OBS’s remote control is on'); slot.replaceChildren(nextBtn()); }
        else if (!s.remote.found) { c.set('wait', 'Waiting for OBS…', 'Open OBS, then do the four clicks above. This turns green by itself.'); slot.replaceChildren(); }
        else { c.set('wait', 'Waiting for the tick…', 'Tick “Enable WebSocket server”, then press Apply in OBS.'); slot.replaceChildren(); }
      };
    },

    connect() {
      const c = checkLine();
      const m = msg();
      const find = el('button', { class: 'ow-btn primary', onClick: async () => {
        find.setAttribute('disabled', ''); find.textContent = 'Looking…'; setMsg(m, '', '');
        const r = await call<{ connected: boolean; fix: string | null }>('/api/obs/setup/find', {});
        if (!alive) return;
        find.removeAttribute('disabled'); find.textContent = 'Find it for me';
        if (r.data?.connected) setMsg(m, 'ok', '✔ Found it. VTube Pro is connected to OBS.');
        else setMsg(m, 'err', r.data?.fix ?? (r.status === 0 ? 'VTube Pro didn’t answer. Is it still running?' : 'That didn’t work. Is OBS open?'));
        void refresh();
      } }, 'Find it for me');
      const slot = el('div', { class: 'ow-row' }, find);
      const manual = el('details', null, el('summary', null, 'Type it myself instead'));
      const pw = el('input', { class: 'ow-input', type: 'password', autocomplete: 'off', placeholder: 'Paste the Server Password from OBS', 'aria-label': 'OBS Server Password' }) as HTMLInputElement;
      const mm = msg();
      const save = el('button', { class: 'ow-btn', onClick: async () => {
        save.setAttribute('disabled', ''); save.textContent = 'Testing…';
        const n = await call<{ nonce: string }>('/api/obs/local/nonce');
        const r = n.data?.nonce ? await call<{ ok: boolean; fix?: string; error?: string }>('/api/obs/local/save', { password: pw.value, nonce: n.data.nonce }) : null;
        pw.value = '';
        if (!alive) return;
        save.removeAttribute('disabled'); save.textContent = 'Test and save';
        setMsg(mm, r?.data?.ok ? 'ok' : 'err', r?.data?.ok ? '✔ Saved on this computer. Connected.' : r?.data?.fix ?? r?.data?.error ?? 'That didn’t work. Check the password and that OBS is open.');
        void refresh();
      } }, 'Test and save');
      manual.append(el('p', null, 'In OBS: ', el('b', null, 'Tools'), ' → ', el('b', null, 'WebSocket Server Settings'), ' → ', el('b', null, 'Show Connect Info'), ' → next to ', el('b', null, 'Server Password'), ', click ', el('b', null, 'Copy'), '.'),
        pw, save, mm, el('p', { class: 'ow-msg' }, 'It’s saved only on this computer.'));
      frame('connect', ['Now VTube Pro connects to OBS.', 'We read the password from OBS’s own settings on this computer, so you don’t type anything.'],
        [c.el, slot, m, manual], ART.connect(), 'Find it for me reads OBS’s settings on this computer. The password never leaves it.');
      stepUpdate = (s) => {
        if (!s) { c.set('wait', 'Checking…'); return; }
        if (s.connected) { c.set('ok', `Connected to OBS${s.obs?.obsVersion ? ` ${s.obs.obsVersion}` : ''}`, `${s.obs?.scenes.length ?? 0} scene${s.obs?.scenes.length === 1 ? '' : 's'} found. Your password stayed on this computer.`); slot.replaceChildren(nextBtn()); }
        else { c.set('wait', 'Not connected yet', s.fix ?? 'Press Find it for me.'); if (!slot.contains(find)) slot.replaceChildren(find); }
      };
    },

    source() {
      const c = checkLine();
      const live = el('p', { class: 'ow-msg' });
      let scene = st?.obs?.current ?? st?.obs?.scenes[0]?.name ?? '';
      const chips = el('div', { class: 'ow-chips', role: 'radiogroup', 'aria-label': 'OBS scene' });
      const change = el('div');
      const go1 = el('button', { class: 'ow-btn primary', onClick: () => {
        go1.setAttribute('hidden', '');
        confirmChange(change, { action: 'add-source', scene }, `Yes, add it to ${q(scene)}`, () => { go1.removeAttribute('hidden'); });
      } });
      const paintChips = (s: ObsSetupState | null) => {
        const names = s?.obs?.scenes.map((x) => x.name) ?? [];
        if (!names.includes(scene)) scene = s?.obs?.current ?? names[0] ?? '';
        chips.replaceChildren(...names.map((n) => el('button', { class: 'ow-chip', role: 'radio', 'aria-checked': String(n === scene), onClick: () => { scene = n; paintChips(st); } }, n)));
        go1.textContent = scene ? `Add VTube Pro to ${q(scene)}` : 'Add VTube Pro';
      };
      const nx = el('div');
      const size = st?.source ?? { url: 'http://127.0.0.1:5191/output.html', width: 1920, height: 1080 };
      const cm = msg();
      const copyRow = (label: string, value: string) => el('div', { class: 'ow-copy' }, el('span', null, label), el('code', { title: value }, value),
        el('button', { class: 'ow-btn small', onClick: () => copy(value, (ok) => setMsg(cm, ok ? 'ok' : 'err', ok ? `${label} copied. Paste it into OBS (Ctrl+V).` : 'Copy didn’t work. Select it and press Ctrl+C.')) }, 'Copy'));
      const manual = el('details', null, el('summary', null, 'Rather add it yourself?'),
        el('ol', { class: 'ow-do' },
          el('li', null, 'In OBS, under ', el('b', null, 'Sources'), ', click ', el('b', null, '+'), ' → ', el('b', null, 'Browser'), '. Name it ', el('b', null, 'VTube Pro'), ', click ', el('b', null, 'OK'), '.'),
          el('li', null, 'Paste the link and size below.'),
          el('li', null, 'Untick ', el('b', null, 'Shutdown source when not visible'), ' and ', el('b', null, 'Refresh browser when scene becomes active'), '. Click ', el('b', null, 'OK'), '.')),
        copyRow('Link', size.url), copyRow('Width', String(size.width)), copyRow('Height', String(size.height)), cm,
        el('p', { class: 'ow-msg' }, 'The link only works on this computer: it’s VTube Pro, not the website.'));
      frame('source', ['Your avatar appears in OBS as a “Browser Source”. We can add it for you.', 'Pick the scene it goes in.'],
        [chips, go1, change, c.el, live, nx, manual], artSource(size.url, size.width, size.height), 'What we add: a Browser Source called “VTube Pro”, sized like your OBS canvas, with both boxes unticked.');
      paintChips(st);
      stepUpdate = (s) => {
        paintChips(s);
        if (needConnection(c, s)) { go1.setAttribute('disabled', ''); return; }
        go1.removeAttribute('disabled');
        const snap = s!.obs!;
        const inScenes = snap.scenes.filter((x) => x.items.some((i) => snap.vtpInputs.includes(i.name))).map((x) => x.name);
        if (inScenes.length) c.set('ok', `VTube Pro is in ${inScenes.length === 1 ? 'your scene' : 'your scenes'} ${inScenes.slice(0, 3).map(q).join(', ')}${inScenes.length > 3 ? '…' : ''}`, 'You can add it to more scenes in the next step.');
        else c.set('wait', 'VTube Pro isn’t in an OBS scene yet', 'Press the button above. This turns green by itself.');
        const o = s!.outputs;
        live.className = `ow-msg ${o.inObs > 0 ? 'ok' : ''}`;
        live.textContent = o.inObs > 0 ? `✔ OBS is showing VTube Pro${o.size ? ` (${o.size.w}×${o.size.h})` : ''}.` : inScenes.length ? 'OBS loads it when that scene is on. Not showing? Click the scene in OBS once.' : '';
        // one big button per screen: once it's green, Next is the big one and "Add" becomes a normal button
        go1.className = inScenes.length ? 'ow-btn' : 'ow-btn primary';
        if (inScenes.length) { if (!nx.childElementCount) nx.replaceChildren(nextBtn()); } else nx.replaceChildren();
      };
    },

    scenes() {
      const c = checkLine();
      let mode: 'make' | 'own' = 'make';
      const seg = el('div', { class: 'ow-seg', role: 'group', 'aria-label': 'How' });
      const panel = el('div', { class: 'ow-map' });
      const change = el('div');
      const am = msg();
      const saveMap = async (m: Partial<Record<LookId, string>>) => {
        const r = await call('/api/obs/switcher', { sceneMap: m }, 'PUT');
        setMsg(am, r.data ? 'ok' : 'err', r.data ? '✔ Saved.' : 'Couldn’t save. Is VTube Pro still running?');
        void refresh();
      };
      const paintSeg = () => seg.replaceChildren(
        el('button', { 'aria-pressed': String(mode === 'make'), onClick: () => { mode = 'make'; paintSeg(); paint(st); } }, 'Make them for me'),
        el('button', { 'aria-pressed': String(mode === 'own'), onClick: () => { mode = 'own'; paintSeg(); paint(st); } }, 'Use my own scenes'));
      const paint = (s: ObsSetupState | null) => {
        const names = s?.obs?.scenes.map((x) => x.name) ?? [];
        const snap = s?.obs;
        const map = s?.automation.sceneMap ?? {};
        if (mode === 'make') {
          const make = el('button', { class: stepChecks(s, [...tested]).scenes ? 'ow-btn' : 'ow-btn primary', onClick: () => {
            make.setAttribute('hidden', '');
            confirmChange(change, { action: 'scenes', scenes: RECOMMENDED_SCENES }, 'Yes, make them', (ok) => {
              make.removeAttribute('hidden');
              if (ok) void saveMap(Object.fromEntries(LOOKS.map((l) => [l.id, l.scene])));
            });
          } }, 'Make my stream scenes');
          panel.replaceChildren(
            el('p', null, 'We make four scenes with VTube Pro in each. Scenes you already have are kept as they are.'),
            el('div', { class: 'ow-chips' }, ...RECOMMENDED_SCENES.map((n) => el('span', { class: `ow-chip${names.includes(n) ? '' : ' new'}`, 'aria-pressed': String(names.includes(n)) }, names.includes(n) ? `${n} ✔` : `+ ${n}`))),
            make);
        } else {
          const rows = LOOKS.map((l) => el('div', { class: 'ow-look' }, el('b', null, l.label, ' ', el('span', null, `(${l.when})`)),
            el('div', { class: 'ow-chips', role: 'radiogroup', 'aria-label': `OBS scene for ${l.label}` },
              ...names.map((n) => el('button', { class: 'ow-chip', role: 'radio', 'aria-checked': String(map[l.id] === n), onClick: () => void saveMap({ ...map, [l.id]: n }) }, n)),
              el('button', { class: 'ow-chip', role: 'radio', 'aria-checked': String(!map[l.id]), onClick: () => { const m = { ...map }; delete m[l.id]; void saveMap(m); } }, 'Don’t switch'))));
          const missing = snap ? [...new Set(Object.values(map).filter((v): v is string => !!v))].filter((n) => names.includes(n) && !snap.scenes.find((x) => x.name === n)?.items.some((i) => snap.vtpInputs.includes(i.name))) : [];
          const add: HTMLElement | null = missing.length ? el('button', { class: 'ow-btn', onClick: () => { add?.setAttribute('hidden', ''); confirmChange(change, { action: 'add-to-scenes', scenes: missing }, 'Yes, add it', () => add?.removeAttribute('hidden')); } },
            `Add VTube Pro to ${missing.map(q).join(', ')}`) : null;
          put(panel, el('p', null, 'Pick the OBS scene for each look. It saves by itself.'), ...rows,
            missing.length ? el('p', { class: 'ow-msg' }, `VTube Pro isn’t in ${missing.map(q).join(', ')} yet.`) : null, add);
        }
      };
      const nx = el('div');
      frame('scenes', ['Stream scenes are the screens your viewers see.', 'We make one for each thing you do: Talk, React, Gaming, Interview, plus BRB for a break.'],
        [seg, panel, change, am, c.el, nx], artScenes(), 'Your OBS Scenes list, with VTube Pro in each scene.');
      const names0 = st?.obs?.scenes.map((x) => x.name) ?? [];
      mode = Object.keys(st?.automation.sceneMap ?? {}).length && !RECOMMENDED_SCENES.every((n) => names0.includes(n)) ? 'own' : 'make';
      paintSeg(); paint(st);
      let lastKey = '';
      stepUpdate = (s) => {
        const key = JSON.stringify([s?.obs?.scenes, s?.obs?.vtpInputs, s?.automation.sceneMap]);
        if (key !== lastKey && !change.querySelector('.ow-card.confirm')) { lastKey = key; paint(s); }   // never while a preview is open
        if (needConnection(c, s)) return;
        const ok = stepChecks(s, [...tested]).scenes;
        const n = Object.keys(s!.automation.sceneMap).length;
        if (ok) { c.set('ok', 'Your stream scenes are ready', `${n} look${n === 1 ? '' : 's'} have a scene with VTube Pro in it.`); if (!nx.childElementCount) nx.replaceChildren(nextBtn()); }
        else { c.set('wait', n ? 'Almost: a scene still needs VTube Pro' : 'No scenes picked yet', n ? 'Add VTube Pro to the scenes above.' : 'Make them, or pick your own.'); nx.replaceChildren(); }
      };
    },

    automation() {
      const c = checkLine();
      const a0 = st?.automation;
      let switchOn = a0?.reviewed ? a0.switchScenes : true;          // recommended: on
      let remind = !!a0?.recordReminder;                             // off by default
      const sw = (on: boolean, label: string, flip: () => void) => {
        const b = el('button', { class: 'ow-sw', role: 'switch', 'aria-checked': String(on), 'aria-label': label });
        b.addEventListener('click', () => { flip(); b.setAttribute('aria-checked', b.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); });
        return b;
      };
      const t1 = el('div', { class: 'ow-toggle' }, sw(switchOn, 'Switch OBS scenes when I change what I’m doing', () => { switchOn = !switchOn; }),
        el('div', null, el('b', null, 'Switch OBS scenes when I change what I’m doing'), el('small', null, 'Example: you pick Gaming in VTube Pro, and OBS shows your Gaming scene (lights on BRB → your BRB scene).')));
      const t3 = el('div', { class: 'ow-toggle' }, sw(remind, 'Remind me to start and stop recording', () => { remind = !remind; }),
        el('div', null, el('b', null, 'Remind me to start and stop recording'), el('small', null, 'Example: you set the lights to Preshow and OBS isn’t recording, so you get a reminder. It never starts or stops anything by itself.')));
      // transitions: an OBS write (previewed, undoable)
      const trs = st?.obs?.transitions ?? [];
      let trName = st?.obs?.transition?.name && st.obs.transition.name !== 'Cut' ? st.obs.transition.name : trs.includes('Fade') ? 'Fade' : trs[0] ?? '';
      let trMs = st?.obs?.transition?.ms && TRANSITION_MS.includes(st.obs.transition.ms) ? st.obs.transition.ms : 300;
      const trChips = el('div', { class: 'ow-chips', role: 'radiogroup', 'aria-label': 'Transition' });
      const msChips = el('div', { class: 'ow-chips', role: 'radiogroup', 'aria-label': 'Length' });
      const trChange = el('div');
      const useTr = el('button', { class: 'ow-btn', onClick: () => { useTr.setAttribute('hidden', ''); confirmChange(trChange, { action: 'transition', name: trName, ms: trMs }, `Yes, use ${trName}`, () => useTr.removeAttribute('hidden')); } });
      const paintTr = () => {
        trChips.replaceChildren(...trs.filter((n) => n !== 'Cut').slice(0, 8).map((n) => el('button', { class: 'ow-chip', role: 'radio', 'aria-checked': String(n === trName), onClick: () => { trName = n; paintTr(); } }, n)));
        msChips.replaceChildren(...TRANSITION_MS.map((ms) => el('button', { class: 'ow-chip', role: 'radio', 'aria-checked': String(ms === trMs), onClick: () => { trMs = ms; paintTr(); } }, `${ms / 1000} s`)));
        useTr.textContent = `Use ${trName || 'this'}, ${trMs / 1000} s`;
      };
      paintTr();
      const now = el('small');
      const t2 = el('div', { class: 'ow-toggle' }, el('span'), el('div', null, el('b', null, 'Smooth scene changes'),
        el('small', null, 'OBS blends from one scene to the next instead of cutting.'), now, trs.length ? trChips : el('small', null, 'Connect OBS first (step 3) to see its transitions.'), trs.length ? msChips : null, trs.length ? useTr : null, trChange));
      const m = msg();
      const save = el('button', { class: 'ow-btn primary', onClick: async () => {
        save.setAttribute('disabled', '');
        const r = await call('/api/obs/switcher', { switchScenes: switchOn, recordReminder: remind, reviewed: true }, 'PUT');
        if (!alive) return;
        save.removeAttribute('disabled');
        setMsg(m, r.data ? 'ok' : 'err', r.data ? '✔ Saved on VTube Pro.' : 'Couldn’t save. Is VTube Pro still running?');
        void refresh();
      } }, 'Save these');
      const nx = el('div');
      frame('automation', ['Choose what happens by itself while you stream.'], [t1, t2, t3, save, m, c.el, nx], ART.automation(), 'Press a look in VTube Pro, and OBS shows its scene with your transition.');
      stepUpdate = (s) => {
        const tr = s?.obs?.transition;
        now.textContent = tr ? `Now: ${tr.name}${tr.ms ? `, ${tr.ms / 1000} s` : ''}.` : '';
        save.className = s?.automation.reviewed ? 'ow-btn' : 'ow-btn primary';
        if (s?.automation.reviewed) {
          c.set('ok', 'Saved', `${s.automation.switchScenes ? 'OBS follows your looks' : 'OBS doesn’t switch by itself'}. Recording reminders ${s.automation.recordReminder ? 'on' : 'off'}.`);
          if (!nx.childElementCount) nx.replaceChildren(nextBtn());
        } else c.set('wait', 'Not saved yet', 'Press Save these.');
      };
    },

    test() {
      const c = checkLine();
      const list = el('div', { class: 'ow-test' });
      const m = msg();
      const backRow = el('div');
      const nx = el('div');
      const press = async (scene: string, b: HTMLElement) => {
        b.setAttribute('disabled', '');
        if (testedFrom === null) testedFrom = st?.obs?.current ?? null;
        const r = await call<{ ok: boolean; current: string | null; error?: string }>('/api/obs/scene', { sceneName: scene });
        if (!alive) return;
        b.removeAttribute('disabled');
        if (r.data?.ok) { tested.add(scene); setMsg(m, 'ok', `✔ OBS is on ${q(scene)} now. Look at OBS: you should see VTube Pro.`); }
        else setMsg(m, 'err', r.data?.error ?? 'OBS didn’t switch. Is it still open?');
        await refresh();
      };
      frame('test', ['Press each button. OBS switches to that scene, so you can see it work.', 'If you’re live right now, your viewers see this too.'],
        [list, m, backRow, c.el, nx], artTest(), 'OBS switches to the scene you pressed.');
      let lastKey = '';
      stepUpdate = (s) => {
        const map = s?.automation.sceneMap ?? {};
        const scenes = [...new Set(LOOKS.map((l) => map[l.id]).filter((v): v is string => !!v))];
        const key = JSON.stringify([scenes, s?.obs?.current, [...tested]]);
        if (key !== lastKey) {
          lastKey = key;
          list.replaceChildren(...scenes.map((n) => {
            const looks = LOOKS.filter((l) => map[l.id] === n).map((l) => l.label).join(' · ');
            const b = el('button', { class: 'ow-btn', onClick: () => void press(n, b) }, el('span', null, `Show ${q(n)}`, el('small', { style: 'display:block;font-weight:400;color:var(--ow-mute);font-size:12.5px' }, looks)),
              el('em', null, s?.obs?.current === n ? 'On air now' : tested.has(n) ? '✔ worked' : ''));
            return b;
          }));
          if (!scenes.length) list.replaceChildren(el('p', null, 'No scenes picked yet. Go back one step and pick your scenes.'));
          put(backRow, testedFrom && s?.obs?.current !== testedFrom && s?.obs?.scenes.some((x) => x.name === testedFrom)
            ? el('button', { class: 'ow-btn small', onClick: async () => { const r = await call<{ ok: boolean }>('/api/obs/scene', { sceneName: testedFrom }); setMsg(m, r.data?.ok ? 'ok' : 'err', r.data?.ok ? `✔ OBS is back on ${q(testedFrom!)}.` : 'OBS didn’t switch back.'); void refresh(); } }, `↶ Put OBS back on ${q(testedFrom)}`) : null);
        }
        if (needConnection(c, s)) return;
        const ok = stepChecks(s, [...tested]).test;
        if (ok) { c.set('ok', 'It works', `${tested.size} scene${tested.size === 1 ? '' : 's'} switched, and OBS shows VTube Pro.`); if (!nx.childElementCount) nx.replaceChildren(nextBtn('Finish')); }
        else if (s!.outputs.inObs === 0) c.set('bad', 'OBS isn’t showing VTube Pro', 'Click a scene with VTube Pro in OBS. Is its eye icon on in the Sources list?');
        else c.set('wait', tested.size ? 'Try the others too' : 'Press a button above', 'Each one turns OBS to that scene.');
      };
    },

    done() {
      const c = checks();
      const all = STEPS.filter((s) => s.id !== 'done');
      const missing = all.filter((s) => !c[s.id]);
      const undoAll = el('div');
      const groups = st?.undo ?? [];
      if (groups.length) {
        const m = msg();
        const b = el('button', { class: 'ow-btn small', onClick: async () => {
          if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Press again to remove everything we added'; return; }
          b.setAttribute('disabled', '');
          const r = await call<{ ok: boolean; did: string[]; kept: string[]; error?: string }>('/api/obs/setup/undo', { id: 'all' });
          b.remove();
          setMsg(m, r.data?.ok ? 'ok' : 'err', r.data?.ok ? `✔ Undone. ${[...r.data.did, ...r.data.kept].join(' · ')}` : r.data?.error ?? 'Couldn’t undo. Is OBS still open?');
          void refresh();
        } }, '↶ Undo everything we added in OBS');
        undoAll.append(el('details', null, el('summary', null, `Changes we made in OBS (${groups.length})`), el('ul', null, ...groups.map((g) => el('li', null, g.label))), b, m));
      }
      frame('done', [], [
        missing.length ? el('p', null, `Still open: ${missing.map((s) => s.short).join(', ')}. Click one at the top to finish it.`)
          : el('p', null, 'Whatever you do in VTube Pro now shows in OBS. Start streaming in OBS as usual.'),
        el('ul', { class: 'ow-list' }, ...all.filter((s) => c[s.id]).map((s) => el('li', null, s.title))),
        env.close ? el('button', { class: 'ow-btn primary', onClick: () => env.close?.() }, 'Back to VTube Pro') : el('p', { class: 'ow-msg ok' }, 'You can close this tab now.'),
        undoAll,
        el('p', { class: 'ow-msg' }, 'Saved on VTube Pro. Come back any time: Set up OBS.'),
      ], ART.done(), missing.length ? 'A few steps are still open.' : 'All set.', missing.length ? 'Almost there' : 'You’re ready ✔');
      stepUpdate = null;
    },
  };

  function go(id: StepId) {
    cur = id; stepUpdate = null;
    steps[id]();
    paintRail();
    (stepUpdate as ((s: ObsSetupState | null) => void) | null)?.(loaded ? st : null);
  }

  let timer = 0;
  async function refresh() {
    const r = await call<ObsSetupState>('/api/obs/setup');
    if (!alive) return;
    const first = !loaded;
    st = r.status === 200 ? r.data : null; loaded = true;
    if (first && !env.startAt && !picked) { const f = firstOpenStep(st, [...tested]); if (f !== cur) { go(f); return; } }
    paintRail();
    stepUpdate?.(st);
  }
  const loop = async () => {
    if (!alive) return;
    if (document.visibilityState !== 'hidden') await refresh();
    timer = window.setTimeout(() => void loop(), 1500);
  };
  go(cur);
  void loop();
  return {
    destroy() { alive = false; clearTimeout(timer); host.replaceChildren(); },
    go: (s) => { picked = true; go(s); },
  };
}

/** For a tab badge: how far the setup is. */
export async function obsSetupSummary(): Promise<{ ready: boolean; firstOpen: StepId; done: number; of: number } | null> {
  const r = await call<ObsSetupState>('/api/obs/setup');
  if (r.status !== 200 || !r.data) return null;
  const c = stepChecks(r.data, []);
  const done = STEPS.filter((s) => s.id !== 'done' && s.id !== 'test' && c[s.id]).length;
  // "test" needs a click in this session; a finished setup (everything else green + OBS showing VTube Pro) is ready
  const ready = done === 6 && r.data.outputs.inObs > 0;
  return { ready, firstOpen: firstOpenStep(r.data, []), done: ready ? 8 : done, of: 8 };
}
