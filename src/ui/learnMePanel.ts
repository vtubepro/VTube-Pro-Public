// "Keep learning me" card (Go Live → Advanced → Voice, next to "My speaking profile"), plus the one-line opt-in the
// first-run wizard shows. Plain language; the privacy promise in one sentence.
import type { App } from '../app.ts';
import { DEFAULT_STYLE } from '../tracking/speakingProfile.ts';
import { button, h, slider, toast, toggle } from './dom.ts';
import { card, item, live } from './bits.ts';

export const LEARNME_PRIVACY = 'Stays on this PC: it saves numbers about your face and voice (never video or sound), nothing is uploaded, and party guests are never recorded.';

export function learnMeToggle(app: App, onChange?: () => void) {
  return toggle('Help VTube Pro learn how you talk and move (stays on this PC)', app.learnMe.state.on, (v) => { app.learnMe.setOn(v); onChange?.(); }, LEARNME_PRIVACY);
}

export function learnMeCard(app: App, refresh: () => void): HTMLElement {
  const L = app.learnMe;
  const status = h('div', { class: 's-list' });
  const report = h('div', { class: 's-list' });
  const versions = h('div', { class: 's-list' });
  const learnNow = () => {
    if (app.observer) { toast('Observer sandbox: nothing is learned here.', 'warn'); return; }
    if (L.minutes < 1) { toast('Not enough learned yet: stream or practise a few minutes with it on first.', 'warn', 5000); return; }
    const r = L.requestLearn(app.trackingOn, app.speakingProfile?.face?.style ?? DEFAULT_STYLE, app.tune.enunciation ?? 1.3);
    toast(r === 'queued' ? 'Will learn as soon as you turn the camera off (so your live tracking stays smooth).' : r === 'busy' ? 'Already learning…' : 'Learning… (a few seconds)', 'info', 5000);
    paint();
  };
  const del = async () => {
    if (app.observer) { toast('Observer sandbox: nothing is deleted here.', 'warn'); return; }
    if (!confirm('Delete everything VTube Pro learned about you with “Keep learning me”? (Your speaking profile from the 45-second test stays.)')) return;
    await L.deleteEverything();
    toast('Deleted.', 'ok'); paint();
  };
  const paintStatus = () => {
    const s = L.state, mb = L.stored.bytes / (1024 * 1024);
    status.replaceChildren(
      item(s.on ? (s.paused ? 'warn' : 'ok') : '', s.on ? (s.paused ? '⏸' : '●') : '·', s.on ? (s.paused ? 'Paused' : app.trackingOn ? 'Learning while you track' : 'On (learns while the camera tracks you)') : 'Off',
        `${L.minutes.toFixed(L.minutes < 10 ? 1 : 0)} minutes learned · ${mb.toFixed(1)} MB of ${s.capMB} MB (oldest drops off)` + (L.learning ? ' · learning now…' : L.pending ? ' · will learn when the camera stops' : '')));
  };
  const paint = () => {
    paintStatus();
    const s = L.state;
    const last = s.last;
    report.replaceChildren(...(last ? [
      h('div', { class: 'note', style: 'margin:4px 0' }, `What improved (checked on ${Math.round(last.seconds.heldOut / 60)} min it hadn’t seen · ${new Date(last.at).toLocaleString()})`),
      ...(last.error ? [item('err', '✕', 'Learning failed', last.error)] : last.reports.map((r) => item(r.adopted ? 'ok' : '', r.adopted ? '✓' : '·', r.line, r.why ?? ''))),
    ] : [h('div', { class: 'note' }, 'No report yet: it learns after a session with it on (or press “Learn now”).')]));
    const cur = s.current;
    versions.replaceChildren(
      ...[...s.versions].reverse().map((v, i) => item(v.id === cur ? 'ok' : '', v.id === cur ? '✓' : String(s.versions.length - i), `Version from ${new Date(v.at).toLocaleString()}`,
        v.reports.filter((r) => r.adopted).map((r) => r.area).join(' · ') || 'kept earlier settings',
        v.id === cur ? h('span', { class: 's-badge ok' }, 'in use') : button('Use this', () => { L.revertTo(v.id); paint(); }, 'ghost'))),
      item(cur === null ? 'ok' : '', cur === null ? '✓' : '·', 'Standard (nothing personal)', 'how VTube Pro moves for everyone',
        cur === null ? h('span', { class: 's-badge ok' }, 'in use') : button('Use standard', () => { L.revertTo(null); paint(); }, 'ghost')));
  };
  paint();
  const off = L.onChange(() => { if (status.isConnected) paint(); });
  // the ticking counter only (repainting the buttons every 350 ms would eat clicks)
  live(() => { if (!status.isConnected) { off(); return false; } paintStatus(); return true; });
  const st = L.state.strength;
  return card('🌱 Keep learning me (optional)', `Learns your lip sync, blinks and head movement from your own streams and uses it on every avatar. ${LEARNME_PRIVACY} It only switches to a new version when that version is proven better on moments it hadn't seen.`,
    learnMeToggle(app, () => { paint(); refresh(); }),
    status,
    h('div', { class: 's-row', style: 'margin:6px 0' },
      button(L.state.paused ? 'Resume' : 'Pause', () => { L.setPaused(!L.state.paused); paint(); }, 'ghost'),
      button('Learn now', learnNow, 'primary'),
      button('Delete everything', () => { void del(); }, 'ghost')),
    report,
    slider('Lip sync', st.lip, 0, 1, 0.05, (v) => L.setStrength('lip', v), 'How much of your learned mouth style to use (0 = standard)', (v) => `${Math.round(v * 100)}%`),
    slider('Face habits', st.habits, 0, 1, 0.05, (v) => L.setStrength('habits', v), 'Your blink pace when the camera loses your face or you use voice only', (v) => `${Math.round(v * 100)}%`),
    slider('Motion style', st.motion, 0, 1, 0.05, (v) => L.setStrength('motion', v), 'Your head sway, nods, tilts and turns when the camera loses your face', (v) => `${Math.round(v * 100)}%`),
    h('div', { class: 'note', style: 'margin:6px 0 2px' }, 'Versions (the last 3 are kept; one click goes back):'),
    versions);
}
