// "Your browser is drawing 3D without your graphics card": the notice for a software GPU (src/stage/gfx/softwareGl.ts).
// Zero-effort rule: the studio has ALREADY switched itself to the light preset; this card says so in one sentence, then
// gives the one most likely fix in one sentence with a Copy button (the browser won't let a page open chrome:// itself).
// Everything else (Flatpak override, drivers, the blocklist flag) is folded under "More ways". One card at the top
// right, no sound. "Got it" hides it for this tab session; "Full quality anyway" stores vtp.softGl = 'off' and reloads.
// Mounted by one line in src/main.ts.
import { SOFT_GL_KEY, SOFT_PRESET, softwareGlHelp, softwareGlQuickFix, type SoftGlState } from '../stage/gfx/softwareGl.ts';
import { button, h, toast } from './dom.ts';

const CSS = `
.softgl-note { position: fixed; top: 64px; right: 16px; z-index: 8990; width: min(420px, calc(100vw - 32px)); max-height: calc(100vh - 96px);
  overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; border-radius: 14px; background: var(--card, #1b1f28);
  color: var(--text, #eef1f6); font-size: 13px; line-height: 1.45; border: 1px solid color-mix(in srgb, var(--warn, #ffb454) 55%, transparent);
  box-shadow: 0 18px 50px -20px rgba(0, 0, 0, .65); }
.softgl-note b { font-size: 14px; }
.softgl-note p { margin: 0; color: var(--dim, #a3abba); }
.softgl-note p.fix { color: var(--text, #eef1f6); }
.softgl-note details { color: var(--dim, #a3abba); }
.softgl-note summary { cursor: pointer; color: var(--text, #eef1f6); }
.softgl-note ol { margin: 8px 0 0; padding-left: 20px; display: grid; gap: 6px; }
.softgl-note code { display: inline-block; margin-top: 3px; padding: 2px 6px; border-radius: 6px; background: var(--card2, #232834); color: var(--text, #eef1f6);
  font: 12px/1.4 ui-monospace, Consolas, Menlo, monospace; user-select: all; word-break: break-all; }
.softgl-note .gpu { margin-top: 6px; font-size: 11.5px; color: var(--faint, #717a8b); word-break: break-word; }
.softgl-note .row { display: flex; flex-wrap: wrap; gap: 8px; }`;

const SEEN = 'vtp.softGl.seen';

/** Plain text of every step (the "More ways" copy; also handy in a bug report). */
export function softwareGlText(s: SoftGlState, ua: string, brave = false): string {
  const steps = softwareGlHelp(ua, brave).map((x, i) => `${i + 1}. ${x.text}${x.code ? `\n   ${x.code}` : ''}`);
  return `VTube Pro: the browser draws 3D without the graphics card (software rendering${s.renderer ? `: ${s.renderer}` : ''}).\n${steps.join('\n')}`;
}

let card: HTMLElement | null = null;

const copy = (text: string, done: string) => {
  void navigator.clipboard?.writeText(text).then(() => toast(done, 'ok'), () => toast('Select the text and copy it by hand.', 'warn'));
};

export function mountSoftwareGlNotice(app: { softGl: SoftGlState }): void {
  const s = app.softGl;
  if (!s.active || card) return;
  try { if (sessionStorage.getItem(SEEN) === '1') return; } catch { /* blocked storage: show it */ }
  if (!document.getElementById('softgl-note-css')) document.head.append(h('style', { id: 'softgl-note-css' }, CSS));
  const ua = navigator.userAgent;
  const brave = !!(navigator as unknown as { brave?: unknown }).brave;
  const quick = softwareGlQuickFix(ua, brave);
  const steps = softwareGlHelp(ua, brave);
  const hide = () => { card?.remove(); card = null; };
  card = h('div', { class: 'softgl-note', role: 'status', 'data-soft-gl': s.software ? 'software' : 'forced' },
    h('b', null, 'Your browser is drawing 3D without your graphics card'),
    h('p', null, `So VTube Pro switched to a light mode by itself (a smaller ${SOFT_PRESET.previewFps} fps preview, tracking on the processor) to keep your computer responsive.`),
    h('p', { class: 'fix' }, quick.text),
    h('div', { class: 'row' },
      quick.code ? button(`Copy ${quick.code}`, () => copy(quick.code!, 'Copied. Paste it into the address bar.'), 'primary') : null,
      button('Got it', () => { try { sessionStorage.setItem(SEEN, '1'); } catch { /* */ } hide(); }, quick.code ? '' : 'primary'),
      button('Full quality anyway', () => {
        try { localStorage.setItem(SOFT_GL_KEY, 'off'); } catch { /* */ }
        location.reload();
      }, 'ghost')),
    h('details', null,
      h('summary', null, 'More ways to fix it'),
      h('ol', null, ...steps.map((x) => h('li', null, x.text, x.code ? h('br') : null, x.code ? h('code', null, x.code) : null))),
      h('div', { class: 'row', style: 'margin-top:8px' }, button('Copy all steps', () => copy(softwareGlText(s, ua, brave), 'Copied the steps.'))),
      s.renderer ? h('div', { class: 'gpu' }, `What the browser reports: ${s.renderer}`) : null));
  document.body.append(card);
}
