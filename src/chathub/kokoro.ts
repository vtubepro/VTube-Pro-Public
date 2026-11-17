// Chat Hub → Read aloud → Settings → Voice: "Kokoro (free, on this PC)". A natural-sounding alert voice that runs on this
// computer (Kokoro-82M, Apache-2.0), installed only when the user presses the button. The line is made by the helper
// (server/kokoro.ts) and played through the studio's mixer like every read-aloud line, never by this page. If Kokoro isn't
// installed or fails, this computer's voice reads that line instead.
import type { KokoroTts, TtsSettings } from '../../shared/chathub.ts';
import { DEFAULT_KOKORO } from '../../shared/chathub.ts';
import { get, h, send, toast } from './util.ts';

interface Status { installed: boolean; runtime: boolean; voices: { id: string; label: string }[]; allVoices: { id: string; label: string }[]; sidecar: { running: boolean; starting: boolean; error: string }; lastMs: number; lastError: string }
interface Job { setup: { running: boolean; ok: boolean | null; steps: { step: string; state: string; msg: string; pct?: number }[] } }
const S: { st: Status | null; job: Job['setup'] | null; timer: number; at: number } = { st: null, job: null, timer: 0, at: 0 };
let repaint: () => void = () => {};
const ON_THIS_PC = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

/** (Re)load the status when the settings are painted, at most every 8 s. */
export function ensureKokoro(paint: () => void) {
  repaint = paint;
  if (Date.now() - S.at > 8000) void loadKokoro(paint);
}

async function loadKokoro(paint: () => void) {
  repaint = paint;
  if (!ON_THIS_PC) return;   // (a page that is not on this PC only shows "set it up in the Chat Hub on the PC that runs VTube Pro": nothing to ask VTube Pro)
  S.at = Date.now();
  try { S.st = await get<Status>('/api/kokoro/status'); } catch { S.st = null; }
  try { S.job = (await get<{ setup: Job['setup'] }>('/api/voice/status')).setup; } catch { S.job = null; }
  repaint();
  // while an install runs, keep the steps fresh (the Chat Hub window is open anyway)
  if (S.job?.running && !S.timer) S.timer = window.setInterval(() => { void loadKokoro(repaint); }, 1500);
  if (!S.job?.running && S.timer) { clearInterval(S.timer); S.timer = 0; }
}

async function install() {
  if (!confirm('Download the Kokoro alert voice (about 110 MB) and a small Python runtime from the official sources, with checksums, into the VTube Pro folder?\n\nIt runs on this computer. Nothing else changes.')) return;
  try { await send('/api/voice/setup', { parts: ['runtime', 'kokoro'] }); toast('Installing the alert voice…'); } catch (e) { toast((e as Error).message); }
  void loadKokoro(repaint);
}

/** The Kokoro rows (only when Kokoro is the engine). */
export function kokoroRows(t: TtsSettings, set: (p: Partial<TtsSettings>) => void): Node[] {
  const k: KokoroTts = t.kokoro ?? DEFAULT_KOKORO;
  const setK = (p: Partial<KokoroTts>) => set({ kokoro: { ...k, ...p } });
  const st = S.st;
  if (!ON_THIS_PC) return [h('span', null, 'Kokoro'), h('div', { class: 'note' }, 'The alert voice is installed and set up in the Chat Hub on the computer that runs VTube Pro.')];
  if (!st) return [h('span', null, 'Kokoro'), h('div', { class: 'note' }, 'Checking…')];
  if (!st.installed) {
    const running = !!S.job?.running;
    const steps = (S.job?.steps ?? []).slice(-4);
    return [h('span', null, 'Kokoro'), h('div', null,
      h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
        h('button', { class: 'pri', 'data-kokoro': 'install', disabled: running, onClick: () => void install() }, running ? 'Installing…' : 'Install the Kokoro voice (about 110 MB)'),
        running ? h('button', { onClick: () => void send('/api/voice/setup/cancel').then(() => loadKokoro(repaint)) }, 'Cancel') : null),
      h('div', { class: 'note' }, 'Free, runs on this computer, no account. Until it is installed your computer’s voice reads.'),
      ...steps.map((x) => h('div', { class: 'note', style: x.state === 'error' ? 'color:#ff9b9b' : '' }, `${x.step}: ${x.msg}${x.state === 'run' && x.pct !== undefined ? ` (${Math.round(x.pct * 100)} %)` : ''}`)))];
  }
  const voices = st.voices.length ? st.voices : st.allVoices;
  return [
    h('span', null, 'Kokoro voice'), h('select', { 'aria-label': 'Kokoro voice', 'data-kokoro': 'voice', style: 'min-width:0', onChange: (e: Event) => setK({ voice: (e.target as HTMLSelectElement).value }) },
      ...voices.map((v) => h('option', { value: v.id, selected: v.id === k.voice }, v.label))),
    h('span', null, `Speed ${k.speed.toFixed(2)}×`), h('input', { type: 'range', min: '0.6', max: '1.6', step: '0.05', value: String(k.speed), 'aria-label': 'Kokoro speed', onChange: (e: Event) => setK({ speed: parseFloat((e.target as HTMLInputElement).value) }) }),
    h('span', null, ''), h('div', { class: 'note' }, `Runs on this computer${st.lastMs ? ` (last line took ${(st.lastMs / 1000).toFixed(1)} s)` : ''}. Names it doesn’t know are spelled out. Use “Test voice” to hear it.${st.lastError ? ` Last problem: ${st.lastError}` : ''}`),
  ];
}
