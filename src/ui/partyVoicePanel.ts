// Party voice — the APP GUEST's controls (Multiplayer panel, guest section): "Talk in VTube Pro (no Discord)", my mic +
// output device, mute button + hotkey (push-to-talk option — the link page's approach), "Using Discord voice instead".
// The links themselves: src/net/voice/partyVoice.ts. My own OBS pages never play the call (nothing here publishes).
import type { App } from '../app.ts';
import { VOX_OLD_HOST } from '../../shared/partyVoice.ts';
import { comboLabel, comboTypes } from '../../shared/greenroom.ts';
import { button, h, select, toggle } from './dom.ts';

const bar = (w: number) => h('span', { style: 'display:inline-block;width:70px;height:6px;border-radius:3px;background:#0e1119;vertical-align:middle;overflow:hidden;margin-left:6px' },
  h('u', { style: `display:block;height:100%;width:${Math.round(w * 100)}%;background:#7bd88f;transition:width .08s` }));

export function partyVoiceGuest(app: App): HTMLElement | null {
  const P = app.party, V = P.voice, T = P.tv;
  if (P.role !== 'guest') return null;
  const st = V.guestState;
  const box = h('div', { class: 'pv-box', 'data-pv': st, style: 'margin:8px 0;padding:8px 10px;border-radius:10px;background:#1f2533' },
    h('b', null, '🎙 Voice'));
  if (st === 'old-host') {
    box.append(h('p', { class: 'note', style: 'margin:4px 0;color:#f5c451', 'data-pv-old': '1' }, `⚠ ${VOX_OLD_HOST}.`),
      h('p', { class: 'note', style: 'margin:4px 0' }, 'Join their Discord voice call to talk. (In-app voice starts by itself once they update VTube Pro.)'));
    return box;
  }
  box.append(
    toggle('Talk in VTube Pro (no Discord)', V.mode === 'app', (v) => V.setMode(v ? 'app' : 'off'), 'Talk with the host and everyone else in the party right here — no Discord call needed'),
    h('label', { class: 'row', title: 'Already in the host’s Discord call? Tick this so you don’t hear everyone twice' },
      h('input', { type: 'checkbox', checked: V.mode === 'discord', onChange: (e: Event) => V.setMode((e.target as HTMLInputElement).checked ? 'discord' : 'app') }),
      h('span', null, ' Using Discord voice instead')));
  if (st === 'discord') { box.append(h('p', { class: 'note', style: 'margin:4px 0' }, 'You talk in the host’s Discord call. In-app voice is off (no double audio).')); return box; }
  if (st === 'off') { box.append(h('p', { class: 'note', style: 'margin:4px 0' }, 'In-app voice is off: nobody here hears you, and you don’t hear the call.')); return box; }

  const conn = V.connected ? '● Connected' : V.linkState === '—' ? 'Starting…' : `Connecting (${V.linkState})…`;
  const muteLbl = V.ptt ? (V.muted ? `🔇 Hold to talk (${comboLabel(V.combo)})` : '🎙 Talking…') : V.muted ? `🔇 Unmute (${comboLabel(V.combo)})` : `🎙 Mute (${comboLabel(V.combo)})`;
  const mute = h('button', { class: `btn ${V.muted ? 'danger' : 'primary'}`, 'data-pv-mute': '1', style: 'min-width:190px', onClick: () => V.toggleMute() }, muteLbl) as HTMLButtonElement;
  mute.addEventListener('pointerdown', () => V.pttPress(true));
  mute.addEventListener('pointerup', () => V.pttPress(false));
  mute.addEventListener('pointerleave', () => { if (V.ptt && !V.muted) V.pttPress(false); });
  const mic = h('span', { 'data-pv-meter': 'mic' }, bar(V.micLevel()));
  const ear = h('span', { 'data-pv-meter': 'ear' }, bar(V.hostLevel()));
  // live meters while the panel shows them
  const iv = setInterval(() => {
    if (!box.isConnected) { clearInterval(iv); return; }
    (mic.querySelector('u') as HTMLElement).style.width = `${Math.round(V.micLevel() * 100)}%`;
    (ear.querySelector('u') as HTMLElement).style.width = `${Math.round(Math.min(1, V.hostLevel() * 3) * 100)}%`;
  }, 100);
  box.append(...[
    h('p', { class: 'note', style: 'margin:4px 0' }, h('b', { style: `color:${V.connected ? '#7bd88f' : '#f5c451'}` }, conn), V.connected ? ' — you hear the host and everyone else on the call; nobody hears themselves.' : ''),
    h('div', { class: 'btns tight', style: 'align-items:center;flex-wrap:wrap' }, mute,
      h('span', { class: 'note' }, 'Me', mic), h('span', { class: 'note', style: 'margin-left:8px' }, 'Call', ear)),
    V.micError ? h('p', { class: 'note', style: 'margin:4px 0;color:#f5c451' }, `Mic: ${V.micError} — you can still listen.`) : null,
    T.mics.length ? select('My microphone', T.mics.some((m) => m.id === V.micId) ? V.micId : '', [['', 'System default'], ...T.mics.map((m): [string, string] => [m.id, m.label])],
      (v) => void V.setMic(v), 'Which mic the party hears (echo cancellation + noise suppression on)') : null,
    V.sinkOk && T.outputs.length ? select('Play the call on', T.outputs.some((o) => o.id === V.sink) ? V.sink : '', [['', 'Default output'], ...T.outputs.map((o): [string, string] => [o.id, o.label])],
      (v) => V.setSink(v), 'Headphones are best (no echo). Pick an output your stream does NOT capture, or the call ends up on your stream.') : null,
    V.sinkError ? h('p', { class: 'note', style: 'color:#f5c451' }, V.sinkError) : null,
    h('label', { class: 'row', title: 'How loud the call plays for you' }, h('span', { class: 'lbl' }, 'Call volume'),
      h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(V.outVol), style: 'flex:1', onInput: (e: Event) => V.setOutVol(Number((e.target as HTMLInputElement).value)) })),
    h('div', { class: 'btns tight', style: 'align-items:center;flex-wrap:wrap' },
      h('span', { class: 'note' }, 'Mute hotkey: ', h('b', null, V.capturing ? 'press keys…' : comboLabel(V.combo))),
      button(V.capturing ? 'Cancel' : 'Change', () => V.setCapturing(!V.capturing)),
      h('label', { class: 'row', style: 'margin:0', title: 'Stay muted; hold the hotkey (or the button) to talk' },
        h('input', { type: 'checkbox', checked: V.ptt, onChange: (e: Event) => V.setPtt((e.target as HTMLInputElement).checked) }), h('span', null, ' Push-to-talk'))),
    h('p', { class: 'note', style: 'margin:4px 0' }, `The hotkey works while VTube Pro is the focused window${comboTypes(V.combo) ? ' and you are not typing in a box' : ''}. Your own OBS page never plays the call audio.`)].filter((x) => !!x) as HTMLElement[]);
  return box;
}
