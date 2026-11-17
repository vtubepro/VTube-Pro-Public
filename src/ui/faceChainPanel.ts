// Tracking → "If face tracking can't keep up": where the face tracker stands in its fallback chain
// (src/tracking/faceChain.ts: MediaPipe on the graphics card -> MediaPipe on the processor -> OpenSeeFace on the processor),
// the last thing it told the user, and the three buttons: get the light face tracker (5 MB, the user's click), use it now, go back
// to the usual tracker. Nothing here switches by itself: the chain does that (src/app.ts chainStep), and says so in one sentence.
import type { App } from '../app.ts';
import { button, h, section, toast } from './dom.ts';
import { live } from './bits.ts';

const TIER_TEXT: Record<string, string> = {
  'mediapipe-gpu': 'The usual face tracker, on your graphics card.',
  'mediapipe-cpu': 'The usual face tracker, on your processor.',
  openseeface: 'The light face tracker, on your processor.',
};

export function faceChainSection(app: App): HTMLElement {
  const status = h('p', { class: 'note', 'aria-live': 'polite' });
  const said = h('p', { class: 'note' });
  const btns = h('div', { class: 's-row' });
  let busy = '', last = '';
  void app.osf.refresh();   // are the models there? (one GET to VTube Pro)
  const paint = () => {
    const osf = app.osf, inst = osf.installed;
    const tier = osf.running ? 'openseeface' : app.faceChain.tier;
    const st = !app.trackingOn ? 'Turn the camera on to see which tracker follows your face.'
      : app.trackingSource !== 'webcam' && !osf.running ? 'Your face comes from a phone or another app right now.'
      : `${TIER_TEXT[tier]}${osf.running ? ` ${osf.status.hz.toFixed(0)} results a second.` : ''}`;
    const sig = `${st}|${app.chainNote}|${osf.status.state}|${inst}|${busy}|${osf.running}`;
    if (sig === last) return;
    last = sig;
    status.textContent = st;
    said.textContent = app.chainNote || (osf.status.state === 'error' || osf.status.state === 'needs-install' ? osf.status.text : '');
    btns.replaceChildren(
      ...(inst ? [] : [button(busy || 'Get the light face tracker (5 MB)', () => {
        if (app.observer) { toast('Observer sandbox: nothing is downloaded here.', 'warn'); return; }
        busy = 'Downloading…'; last = ''; paint();
        void app.osf.install((got, total) => { busy = `Downloading… ${Math.round((got / Math.max(1, total)) * 100)} %`; last = ''; }).then((r) => {
          busy = ''; last = ''; toast(r.says, r.ok ? 'ok' : 'warn', 8000);
          if (r.ok) app.chainNote = 'The light face tracker is ready. It switches on by itself when your usual tracker cannot keep up.';
          paint();
        });
      }, 'primary')]),
      ...(inst && !osf.running ? [button('Use the light face tracker now', () => {
        if (app.observer) { toast('Observer sandbox: nothing is changed here.', 'warn'); return; }
        if (!app.trackingOn) { toast('Turn the camera on first.', 'warn'); return; }
        void app.startOpenSeeFace('The light face tracker follows your face now.');
      })] : []),
      ...(osf.running ? [button('Try the usual tracker again', () => { if (!app.observer) app.endOpenSeeFace(true); }, 'ghost')] : []),
    );
  };
  paint();
  live(() => { if (!status.isConnected) return false; paint(); return true; });
  return section('If face tracking can’t keep up',
    h('p', { class: 'note' }, 'On a slow PC, or when the usual tracker will not start, VTube Pro can follow your face with a much lighter tracker instead. It switches by itself and tells you in one sentence. It tracks your head, eyes and mouth, but fewer expressions than the usual one.'),
    status, said, btns,
    h('p', { class: 'note' }, 'The light face tracker is OpenSeeFace (BSD 2-Clause, by Emiliana). Its two small models (5 MB) are downloaded from its repository only when you press the button, and checked before they are kept.'));
}
