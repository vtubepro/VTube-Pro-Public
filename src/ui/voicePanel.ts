// Voice / lip-sync, the friendly way (docs/VOICE.md). The neural voice model is on by default: "Standard" (no OBS
// change) runs the FAST model (20 ms of its own lookahead; the mouth shape trails the voice by ~40 ms, the jaw doesn't);
// "Better" adds the lip-sync lookahead (60 ms by default, with the matching OBS Sync Offset how-to) so shapes land on
// time and lips seal / round before the sound. Lookahead >= 80 ms switches to the full model. Detailed controls (mix,
// lookahead value, numbers) live in voiceAdvanced().
import type { App } from '../app.ts';
import { LOOKAHEAD_CHOICES, LOOKAHEAD_KEY } from '../tracking/lipLookahead.ts';
import { button, h, select, slider, toast } from './dom.ts';
import { add, live } from './bits.ts';
import { copyText } from './liveOps.ts';

/** 60 ms: the fast model is on time there (LibriSpeech frame accuracy 78 % vs 79 % for the full model at 90-100 ms) */
const GOOD_LOOKAHEAD = 60;
const setLookahead = (app: App, d: number) => { app.lookahead.delayMs = d; try { localStorage.setItem(LOOKAHEAD_KEY, String(d)); } catch { /* private mode */ } };
const betterOn = (app: App) => app.audio.neuralStatus.on && app.lookahead.delayMs >= GOOD_LOOKAHEAD && app.audio.voiceSettings.filter !== 'off';

/** One switch: neural visemes on (auto mix) + lookahead 60–120 ms (60 if outside) + the noise filter on. */
export async function setBetterLipSync(app: App, on: boolean) {
  if (app.observer) { toast('Observer sandbox: voice settings are not changed here (they would change your real studio).', 'warn', 5000); return; }
  const A = app.audio;
  if (on) {
    if (app.lookahead.delayMs < GOOD_LOOKAHEAD || app.lookahead.delayMs > 120) setLookahead(app, GOOD_LOOKAHEAD);
    if (A.voiceSettings.filter === 'off') { try { await A.setVoiceSettings({ filter: 'standard' }); } catch (e) { toast(`Noise filter: ${(e as Error).message}`, 'err'); } }
    A.setNeural({ on: true, mix: -1 });
    toast(`Better lip sync on. Now set your mic’s Sync Offset in OBS to ${app.lookahead.delayMs} ms (see the steps below).`, 'ok', 7000);
  } else {
    // Standard keeps the (fast) voice model — only the display delay goes, together with the OBS Sync Offset
    if (A.voiceSettings.filter === 'off') { try { await A.setVoiceSettings({ filter: 'standard' }); } catch { /* raw mic: rule engine only */ } }
    A.setNeural({ on: true });
    setLookahead(app, 0);
    toast('Standard lip sync: no mic delay. Set your mic’s Sync Offset in OBS back to 0 ms.', 'info', 7000);
  }
}

function statusText(app: App): { state: 'ok' | 'warn' | 'err' | ''; text: string } {
  const s = app.audio.neuralStatus;
  if (!s.on) return { state: '', text: 'Voice model off — the rule-based lip sync is used (Advanced → turn neural on).' };
  if (!app.audio.active) return { state: 'warn', text: 'Waiting for the microphone: press “Start camera & mic” (or “Turn on the microphone too”) on the Camera & tracking page.' };
  if (s.error) return { state: 'err', text: s.error };
  if (!s.ready) return { state: 'warn', text: 'Loading the voice model…' };
  const mode = app.lookahead.delayMs >= GOOD_LOOKAHEAD ? `on time (${app.lookahead.delayMs} ms lookahead, ${s.model === 'full' ? 'full' : 'fast'} model)` : 'fast model, shapes ~40 ms behind the voice';
  return { state: 'ok', text: `Working · ${mode}${s.personal ? ' · tuned to YOUR voice ✓' : ' · run the 45-second test to tune it to your voice'} · ${Math.round(s.msPerSec)} ms CPU per second` };
}

function obsOffsetHowTo(app: App) {
  const d = app.lookahead.delayMs;
  return h('div', { class: 's-obs' }, h('b', null, `OBS: delay your mic by ${d} ms`), ' — so viewers hear you in sync with the mouth:',
    h('ol', { class: 's-steps', style: 'margin-top:6px' },
      h('li', null, h('span', null, 'OBS → ', h('b', null, 'Audio Mixer'), ' → the ', h('b', null, '⋮ / ⚙'), ' on your microphone → ', h('b', null, 'Advanced Audio Properties'), '.')),
      h('li', null, h('span', null, 'Set ', h('b', null, 'Sync Offset'), ` of the mic to `, h('b', null, `${d} ms`), '. ', button('Copy', () => copyText(String(d), 'Sync Offset'), 'link'))),
      h('li', null, h('span', null, 'Discord / party guests hear you without that delay, so for them the mouth runs a touch late — that’s expected.'))));
}

/** The friendly card (Go Live → Simple, the first-run wizard's voice step). */
export function betterLipSyncCard(app: App, refresh: () => void, opts: { title?: string } = {}): HTMLElement {
  const on = betterOn(app);
  const st = h('p', { class: 'note', style: 'margin:6px 0 0' });
  const paint = () => { const s = statusText(app); st.textContent = s.text; st.style.color = s.state === 'err' ? 'var(--err)' : s.state === 'warn' ? 'var(--warn)' : s.state === 'ok' ? 'var(--ok)' : ''; };
  paint();
  live(() => { if (!st.isConnected) return false; paint(); return true; });
  const card = h('section', { class: 's-card' });
  add(card,
    h('h3', null, h('span', { class: 'grow' }, opts.title ?? '🗣 Better lip sync'), h('span', { class: 's-badge warn' }, 'experimental')),
    h('p', { class: 'lead' }, 'Makes the mouth match your words more closely. Standard works as is. Better needs one small change in OBS (a 60 ms mic delay; we show you how).'),
    h('div', { class: 's-seg', role: 'radiogroup' },
      h('button', { class: !on ? 'on' : '', role: 'radio', 'aria-checked': String(!on), onClick: () => void setBetterLipSync(app, false).then(refresh) }, 'Standard', h('small', null, 'no OBS change')),
      h('button', { class: on ? 'on' : '', role: 'radio', 'aria-checked': String(on), onClick: () => void setBetterLipSync(app, true).then(refresh) }, 'Better', h('small', null, `mic delayed ${app.lookahead.delayMs >= GOOD_LOOKAHEAD && app.lookahead.delayMs <= 120 ? app.lookahead.delayMs : GOOD_LOOKAHEAD} ms`))),
    st,
    on ? obsOffsetHowTo(app) : null,
    h('div', { class: 's-row', style: 'margin-top:8px' },
      button('Reset voice profile', () => {
        if (app.observer) { toast('Observer sandbox: not reset', 'warn'); return; }
        if (!confirm('Forget what VTube Pro learned about your voice (vowels, sounds and the personal voice layer)? Run the 45-second test again afterwards.')) return;
        app.audio.resetProfile(); toast('Voice profile reset — run the expression & voice test to learn it again.', 'ok', 5000); refresh();
      }, 'ghost')));
  return card;
}

/** Tracking → Advanced → Voice: every knob (mix, lookahead, numbers). */
export function voiceAdvanced(app: App, refresh: () => void): HTMLElement {
  const A = app.audio, s = A.neuralStatus;
  const auto = s.mix < 0;
  const la = String(app.lookahead.delayMs);
  const opts = LOOKAHEAD_CHOICES.map((d) => [String(d), d ? `${d} ms` : 'Off'] as [string, string]);
  if (!opts.some(([v]) => v === la)) opts.push([la, `${la} ms`]);
  const nums = h('pre', { class: 'log', style: 'max-height:none' });
  // (clarity: the raw numbers, with an "error:" line, read as broken: they sit in a Details expander, and the one error a
  // user can fix is said in a sentence)
  const fixLine = h('p', { class: 'note', style: 'color:var(--warn)' });
  const paint = () => { const x = A.neuralStatus; const fx = /noise filter/i.test(x.error ?? '') ? 'Turn on the noise filter (Standard or Strong) to use this.' : ''; if (fixLine.textContent !== fx) { fixLine.textContent = fx; fixLine.style.display = fx ? '' : 'none'; } nums.textContent = `on ${x.on} · ready ${x.ready} · personal ${x.personal}\nmix ${x.mix < 0 ? 'auto' : x.mix.toFixed(2)} → used ${x.mixUsed.toFixed(2)} · model delay ${Math.round(x.delayMs)} ms · lag ${Math.round(x.lagMs)} ms\ncost ${Math.round(x.msPerSec)} ms/s · used ${typeof x.used === 'number' ? x.used : JSON.stringify(x.used)}${x.error ? `\nerror: ${x.error}` : ''}\nnoise filter: ${A.voiceSettings.filter} · lookahead ${app.lookahead.delayMs} ms`; };
  paint();
  live(() => { if (!nums.isConnected) return false; paint(); return true; });
  const card = h('section', { class: 's-card' });
  add(card, h('h3', null, 'Neural lip sync (experimental)'),
    h('p', { class: 'lead' }, 'Blends a streaming phone recogniser into the lip-sync engine. Needs the noise filter (Standard / Strong). Lookahead under 80 ms: the fast model (its newest frame, ~40 ms behind at 0 ms); 80 ms and up: the full model for the exact instant the delayed voice frame describes.'),
    h('div', { class: 's-row' }, button(s.on ? 'Turn neural off' : 'Turn neural on', () => { if (app.observer) { toast('Observer sandbox: not changed', 'warn'); return; } A.setNeural({ on: !s.on }); refresh(); }, s.on ? '' : 'primary'),
      button('Use the recommended set-up', () => void setBetterLipSync(app, true).then(refresh))),
    h('label', { class: 'row toggle' }, h('span', { class: 'lbl' }, 'Automatic mix'), h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: auto, onChange: (e: Event) => { if (app.observer) return; A.setNeural({ mix: (e.target as HTMLInputElement).checked ? -1 : 0.5 }); refresh(); } }), h('i'))),
    !auto ? slider('Neural mix', s.mix, 0, 1, 0.05, (v) => { if (!app.observer) A.setNeural({ mix: v }); }, 'How much of the neural visemes is blended in (auto: more once the personal layer is trained)', { def: 0.5 }) : null,
    select('Lip-sync lookahead', la, opts, (v) => { if (app.observer) { toast('Observer sandbox: not changed', 'warn'); return; } setLookahead(app, Number(v) || 0); refresh(); }, 'The mouth is shown this late, in sync with your mic delayed by the same amount in OBS (Sync Offset).'),
    app.lookahead.delayMs > 0 ? obsOffsetHowTo(app) : h('p', { class: 'note' }, 'Lookahead off: no OBS change needed (the fast voice model still shapes the mouth, a little behind the voice).'),
    fixLine,
    h('details', null, h('summary', { class: 'note', style: 'cursor:pointer' }, 'Details'), nums),
    h('div', { class: 's-row' }, button('Reset voice profile', () => { if (app.observer) return; if (confirm('Forget your learned voice profile (incl. the personal neural layer)?')) { A.resetProfile(); toast('Voice profile reset', 'ok'); refresh(); } }, 'danger')),
    h('p', { class: 'note' }, 'The personal layer is trained automatically by the 45-second expression & voice test while neural lip sync is on (stored only on this PC).'));
  return card;
}
