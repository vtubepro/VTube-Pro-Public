// Chat Hub → Read aloud → Settings: the voice engine choice ("This computer's voices", free, the default; or Kokoro, a
// free voice that runs on this PC) and the one plain status line about the voice. No account, no key: both voices run here.
import type { HubTtsStatus, TtsSettings } from '../../shared/chathub.ts';
import { h } from './util.ts';

/** The "Voice engine" row (always shown in the settings). */
export function engineRow(t: TtsSettings, set: (p: Partial<TtsSettings>) => void): Node[] {
  const seg = (v: TtsSettings['engine'], label: string) => h('button', { class: t.engine === v ? 'on' : '', 'aria-pressed': String(t.engine === v), 'data-engine': v, onClick: () => { if (t.engine !== v) set({ engine: v }); } }, label);
  return [h('span', null, 'Voice'), h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, seg('system', 'This computer’s voices (free)'), seg('kokoro', 'Kokoro (free, natural)'))];
}

/** One plain line about the voice (Kokoro not ready, so this computer's voice read the line), for the read-aloud bar. */
export function voiceNote(t: TtsSettings, s: HubTtsStatus): Node | null {
  const v = s.voice;
  if (t.engine === 'kokoro' && v?.note && Date.now() - v.noteAt < 30 * 60_000 && /Kokoro/.test(v.note)) return h('div', { class: 'note', 'data-voice-note': 'kokoro', style: 'color:#ffb27a' }, v.note);
  return null;
}
