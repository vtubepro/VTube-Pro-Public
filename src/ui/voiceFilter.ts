// Voice lip-sync → noise filter controls + live meters (see src/audio/voice/, docs/VOICE.md).
import type { App } from '../app.ts';
import { button, h, select, slider, toast, toggle } from './dom.ts';
import { DEFAULT_VOICE, type NoiseFilter } from '../audio/voice/voiceFrontEnd.ts';
import { LOOKAHEAD_CHOICES, LOOKAHEAD_KEY } from '../tracking/lipLookahead.ts';
import { captionsControls } from './captionsPanel.ts';

/** dBFS → 0..1 bar (−70 … −10 dBFS). */
const bar = (db: number) => Math.min(1, Math.max(0, (db + 70) / 60));

function meter(label: string) {
  const fill = h('i', { style: 'width:0%' });
  const mark = h('b', { style: 'left:0%;display:none' });
  const val = h('span', null, '–');
  const el = h('div', { class: 'meter' }, h('span', null, label), h('span', { class: 'bar' }, fill, mark), val);
  return {
    el,
    set(frac: number, text: string, color?: string, markAt?: number) {
      fill.style.width = `${Math.round(frac * 100)}%`;
      fill.style.background = color ?? '';
      if (markAt !== undefined) { mark.style.display = ''; mark.style.left = `${Math.round(markAt * 100)}%`; } else mark.style.display = 'none';
      val.textContent = text;
    },
  };
}

const FRIC_NAME: Record<string, string> = { FF: 'F', TH: 'TH', SS: 'S', CH: 'SH' };
const FRIC_VOICED: Record<string, string> = { FF: 'V', TH: 'DH', SS: 'Z', CH: 'ZH' };

export function voiceFilterControls(app: App): HTMLElement[] {
  const A = app.audio, s = A.voiceSettings;
  const set = (patch: Parameters<typeof A.setVoiceSettings>[0]) => {
    void A.setVoiceSettings(patch).catch((e) => toast(`Mic: ${(e as Error).message}`, 'err'));
  };
  const raw = meter('Mic (raw)'), dn = meter('Filtered'), vp = meter('Voice'), gate = meter('Mouth gate'), fr = meter('Hiss (F/S)');
  const status = h('p', { class: 'note' });
  const meters = h('div', { class: 'voice-meters', style: 'margin:4px 0 6px' }, raw.el, dn.el, vp.el, gate.el, fr.el, status);
  let mounted = false, waits = 0;
  const tick = () => {
    if (meters.isConnected) mounted = true;
    else if (mounted || ++waits > 8) { clearInterval(timer); return; } // panel re-rendered / tab switched
    const st = A.fx?.stat;
    if (!A.active) { status.textContent = 'Microphone off.'; for (const m of [raw, dn, vp, gate, fr]) m.set(0, '–'); return; }
    if (!A.fx || !st) {
      status.textContent = A.voiceSettings.filter === 'off' ? 'Noise filter off — raw mic analysis (as before).'
        : A.fxError ? `Noise filter unavailable (${A.fxError}) — using the raw mic.` : 'Starting the noise filter…';
      raw.set(Math.min(1, A.last.level), A.last.level.toFixed(2));
      dn.set(0, '–'); vp.set(0, '–'); fr.set(0, '–');
      gate.set(A.last.level > 0.05 ? 1 : 0, A.last.level > 0.05 ? 'open' : 'shut');
      return;
    }
    raw.set(bar(st.raw), `${Math.round(st.raw)}`, undefined, st.rawFloor > -99 ? bar(st.rawFloor) : undefined);
    dn.set(bar(st.dn), `${Math.round(st.dn)}`, undefined, st.ref > -99 ? bar(st.ref) : undefined);
    const p = st.p >= 0 ? st.p : Math.max(0, st.vad);
    vp.set(p, `${Math.round(p * 100)}%`, p > 0.5 ? '#4caf50' : undefined);
    gate.set(st.gate ? 1 : st.bg ? 0.5 : 0, st.gate ? (st.prov ? 'wait' : 'open') : st.bg ? 'bg' : 'shut', st.bg && !st.gate ? '#e0a030' : undefined);
    const f = A.fricative;
    fr.set(f.conf, f.cls ? (f.voiced ? FRIC_VOICED[f.cls] : FRIC_NAME[f.cls]) : '–');
    const vadTxt = A.fx.vadError ? `Silero VAD failed (${A.fx.vadError}) — RNNoise VAD only` : A.fx.vadReady ? `Silero ${A.fx.vadMs.toFixed(1)} ms/window` : 'loading Silero…';
    status.textContent = `${vadTxt} · your level ${st.ref > -99 ? `${Math.round(st.ref)} dB` : 'learning…'} · gain ${st.gain >= 0 ? '+' : ''}${st.gain.toFixed(0)} dB${st.bg && !st.gate ? ' · ignoring a background voice' : ''}`;
  };
  const timer = setInterval(tick, 100);
  tick();

  const calBtn = button('Calibrate noise (stay quiet 3 s)', async (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    const label = b.textContent;
    b.disabled = true; b.textContent = 'Stay quiet…';
    try {
      const r = await A.calibrateNoise(3);
      toast(`Room noise learned: floor ${Math.round(r.rawFloor)} dBFS${r.pP90 > 0.5 ? ' — a voice was heard (TV / someone talking?); calibrate again in quiet for best results' : ''}. Say a sentence so it learns your voice level.`, r.pP90 > 0.5 ? 'warn' : 'ok', 6500);
    } catch (err) { toast((err as Error).message, 'err'); }
    b.disabled = false; b.textContent = label;
  });

  return [
    select<NoiseFilter>('Noise filter', s.filter, [['standard', 'Standard (recommended)'], ['strong', 'Strong (noisy room)'], ['off', 'Off (raw mic, as before)']], (v) => set({ filter: v }),
      'RNNoise noise suppression + Silero voice detection, all on this PC. The mouth only moves for YOUR voice: keyboard, mouse, fans, hum, breathing, chair creaks and music are ignored. Held F / V / S / SH still show. Adds ≈ 19 ms.'),
    slider('Voice sensitivity', s.sensitivity, 0, 1, 0.05, (v) => set({ sensitivity: v }), 'Low = only clear, close speech moves the mouth. High = whispers and quiet mumbles do too (and more noise gets through).', { def: DEFAULT_VOICE.sensitivity }),
    toggle('Ignore background voices', s.ignoreBg, (v) => set({ ignoreBg: v }), 'Learns how loud YOU are at the mic and ignores quieter voices (TV, stream audio on speakers, people in the room). Turn off (or recalibrate) if you move far from the mic or turn your mic gain down a lot.'),
    meters,
    h('div', { class: 'btns tight' }, calBtn),
    lookaheadControl(app),
    h('details', null, h('summary', null, 'Browser mic processing (advanced)'),
      toggle('Browser noise suppression', s.browserNS, (v) => set({ browserNS: v }), 'Chrome’s own noise suppression before ours. Measured worse for lip-sync (smears F/S, lets more keyboard through) and adds latency.'),
      toggle('Echo cancellation', s.browserEC, (v) => set({ browserEC: v }), 'Only if you use speakers and your stream audio leaks into the mic. Adds ≈ 35 ms.'),
      toggle('Browser auto gain', s.browserAGC, (v) => set({ browserAGC: v }), 'Off by default: the filter normalises your level itself; auto gain also turns up background voices between words.'),
      h('p', { class: 'note' }, 'Changing these briefly reopens the microphone.')),
    captionsControls(app),
  ];
}

/** Lip-sync lookahead: the mouth is shown D ms late, in sync with the mic delayed by D ms in OBS, and uses that
 *  D ms of "future" voice to close / round / part the lips before the sound (like real mouths). */
function lookaheadControl(app: App): HTMLElement {
  const how = h('p', { class: 'note' });
  const show = (d: number) => {
    how.textContent = d > 0
      ? `In OBS: Audio Mixer → ⚙ on your mic → Advanced Audio Properties → Sync Offset = ${d} ms. (Discord / party guests hear your voice without that delay, so there your mouth runs ${d} ms late.)`
      : 'Off: the mouth follows your live voice (no OBS change needed).';
  };
  const cur = String(app.lookahead.delayMs);
  const opts = LOOKAHEAD_CHOICES.map((d) => [String(d), d ? `${d} ms` : 'Off'] as [string, string]);
  if (!opts.some(([v]) => v === cur)) opts.push([cur, `${cur} ms`]);
  const sel = select<string>('Lip-sync lookahead', cur, opts, (v) => {
    const d = Number(v) || 0;
    app.lookahead.delayMs = d;
    try { localStorage.setItem(LOOKAHEAD_KEY, String(d)); } catch { /* private mode */ }
    show(d);
  }, 'Delay your mic in OBS by this much and the avatar gets a head start: lips close before M/B/P, round before OO and part before words, exactly on the audio viewers hear. 80 ms is a good start.');
  show(app.lookahead.delayMs);
  return h('div', null, sel, how);
}
