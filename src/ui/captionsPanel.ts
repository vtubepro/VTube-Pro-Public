// Live captions card (Tracking → Advanced → Voice lip-sync → Live captions). docs/LIVE_CAPTIONS.md
// Free and local: faster-whisper on this PC, fed by the microphone audio this studio already analyses. The engine and a
// speech model are downloaded only when the user presses the install button. The switch is a localStorage flag +
// an event (src/audio/voice/voiceFrontEnd.ts) and the helper's own on/off (PUT /api/captions/config).
import type { App } from '../app.ts';
import { CAPTIONS_EVENT, CAPTIONS_KEY, captionsAllowed } from '../audio/voice/voiceFrontEnd.ts';
import { button, h, select, toast, toggle } from './dom.ts';
import { live } from './bits.ts';
import { capabilityChip, gateButton } from './capabilityView.ts';

interface Status {
  config: { on: boolean; model: string; lang: string; device: string; showTentative: boolean; offsetSec: number };
  state: 'off' | 'needs-setup' | 'starting' | 'waiting' | 'on' | 'error'; detail: string;
  installed: { runtime: boolean; engine: boolean; models: string[]; gpuLibs: boolean };
  models: { id: string; label: string; langs: string; mb: number; note: string; installed: boolean }[];
  engine: { model: string; device: string; compute: string; fallback: string } | null;
  stats: { runs: number; words: number; lagP50Ms: number; lagP95Ms: number; runMs: number; errors: number; lastError: string };
  advice: string; text: string; files: { current: { srt: string; vtt: string } | null; list: { name: string; bytes: number; modified: number }[] };
}
interface Voice { setup: { running: boolean; ok: boolean | null; steps: { step: string; state: string; msg: string; pct?: number }[] }; gpu: { name: string; nvidia: boolean } }

const api = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({})) as T & { error?: string };
  if (!r.ok) throw new Error((j as { error?: string }).error || `HTTP ${r.status}`);
  return j;
};
const send = (url: string, method: string, body?: unknown) => api<Record<string, unknown>>(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

/** Where OBS should load the overlay: the helper's own address (never the dev server's). */
const overlayUrl = () => (location.port === '5191' ? `${location.origin}/captions.html` : 'http://127.0.0.1:5191/captions.html');

/** The install button, disabled with the reason when this PC can't run captions (not enough disk space, one core). */
const gatedInstall = (b: HTMLButtonElement) => { gateButton(b, 'captions'); return b; };

export function captionsControls(app: App): HTMLElement {
  const box = h('details', { class: 'caps' }, h('summary', null, 'Live captions (OBS overlay + subtitle files) ', capabilityChip('captions')));
  const body = h('div');
  box.append(body);
  if (!captionsAllowed()) {
    body.append(h('p', { class: 'note' }, 'Live captions run in VTube Pro on this computer: open the studio from VTube Pro (not an observer window) to use them.'));
    return box;
  }
  let st: Status | null = null, vs: Voice | null = null, busy = false, tick = 0, model = 'base.en';
  const line = h('p', { class: 'note', style: 'margin:6px 0' });
  const steps = h('ol', { class: 's-steps', style: 'margin:6px 0 0' });
  const dyn = h('div');

  const poll = async () => {
    if (busy) return; busy = true;
    try { [st, vs] = await Promise.all([api<Status>('/api/captions/status'), api<Voice>('/api/voice/status')]); } catch { st = null; } finally { busy = false; }
    paint();
  };
  const setOn = async (on: boolean) => {
    if (app.observer) { toast('Observer sandbox: captions are switched on from your real studio.', 'warn'); return; }
    try { localStorage.setItem(CAPTIONS_KEY, on ? '1' : '0'); } catch { /* private mode */ }
    window.dispatchEvent(new Event(CAPTIONS_EVENT));
    try { await send('/api/captions/config', 'PUT', { on }); } catch (e) { toast(`Captions: ${(e as Error).message}`, 'err'); }
    void poll();
  };
  const install = (parts: string[]) => {
    const need = st?.models.find((m) => m.id === model);
    if (!confirm(`Download the caption engine${parts.includes('gpu') ? ' and the NVIDIA GPU libraries (about 1.5 GB)' : ''}?\n\nThis installs a private Python runtime and the “${need?.label ?? model}” speech model (about ${(need?.mb ?? 150) + 450} MB) from the official sources, with checksums, into the VTube Pro folder. Nothing else changes.`)) return;
    void send('/api/voice/setup', 'POST', { parts, model }).then(() => poll()).catch((e) => toast((e as Error).message, 'err'));
  };

  const paint = () => {
    if (!st) { line.textContent = 'VTube Pro is not answering (start VTube Pro from START.bat).'; dyn.replaceChildren(); steps.replaceChildren(); return; }
    const s = st, on = s.config.on;
    const stateTxt: Record<string, string> = {
      off: 'Off.', 'needs-setup': s.detail || 'The caption engine is not installed yet.', starting: s.detail || 'Starting the caption engine…',
      waiting: s.detail || 'On: waiting for microphone audio. Press "Start camera & mic" on the Tracking tab.', on: `On${s.engine ? ` (${s.engine.model} on ${s.engine.device}${s.engine.fallback ? ': ' + s.engine.fallback : ''})` : ''}`, error: s.detail || 'Something went wrong.',
    };
    const lag = s.stats.runs > 3 ? ` · words appear about ${(s.stats.lagP50Ms / 1000).toFixed(1)} seconds after you say them (almost always within ${(s.stats.lagP95Ms / 1000).toFixed(1)} s)${s.stats.runMs > 350 ? ' · this computer is working hard on the speech model: captions are in quick mode' : ''}` : '';
    line.textContent = `${stateTxt[s.state] ?? s.state}${s.state === 'on' ? lag : ''}${s.stats.errors ? ` · ${s.stats.errors} hiccup${s.stats.errors === 1 ? '' : 's'}: ${s.stats.lastError}` : ''}`;
    line.style.color = s.state === 'on' ? 'var(--ok)' : s.state === 'error' ? 'var(--err)' : s.state === 'needs-setup' ? 'var(--warn)' : '';
    const installedModels = s.models.filter((m) => m.installed);
    const ready = s.installed.engine && installedModels.length > 0;
    const kids: (Node | null)[] = [];
    if (!ready) {
      kids.push(
        select('Speech model', model, s.models.map((m) => [m.id, `${m.label} · ${m.mb} MB · ${m.note}`] as [string, string]), (v) => { model = v; }, 'Bigger = more accurate and needs a faster PC. Base is a good start.'),
        h('div', { class: 'btns tight' },
          gatedInstall(button('Install live captions', () => install(['runtime', 'captions']), 'primary')),
          vs?.gpu?.nvidia ? button('+ use my NVIDIA graphics card', () => install(['runtime', 'captions', 'gpu']), 'ghost') : null),
        h('p', { class: 'note' }, 'Nothing is downloaded until you press the button (about 0.6 GB). Runs on this computer: your voice never leaves it.'));
    } else {
      kids.push(
        toggle('Show live captions', on, (v) => void setOn(v), 'Turns the caption engine on and streams your microphone to it (on this PC). Add the overlay below to OBS.'),
        select('Speech model', s.config.model, installedModels.map((m) => [m.id, `${m.label} · ${m.mb} MB`] as [string, string]), (v) => void send('/api/captions/config', 'PUT', { model: v }).then(poll), 'Bigger = more accurate, slower. If the delay shows more than 2 seconds, pick a smaller one.'),
        s.config.model.endsWith('.en') ? null : select('Language', s.config.lang, [['auto', 'Detect'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['it', 'Italian'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['ru', 'Russian']], (v) => void send('/api/captions/config', 'PUT', { lang: v }).then(poll)),
        toggle('Also show words that may still change', s.config.showTentative, (v) => void send('/api/captions/config', 'PUT', { showTentative: v }).then(poll), 'Off (recommended): a word appears only when it is final, so nothing flickers. On: the newest words show dimmed and can change.'),
        s.advice ? h('p', { class: 'note', style: 'color:var(--warn)' }, s.advice) : null,
        h('div', { class: 'btns tight' },
          button('Copy the OBS address', () => { void navigator.clipboard?.writeText(overlayUrl()).then(() => toast('Copied. In OBS: Sources + → Browser → paste it, size 1920 × 1080.', 'ok', 6000), () => toast(overlayUrl(), 'info', 9000)); }),
          button('My recording starts now', () => void send('/api/captions/mark', 'POST').then(() => { toast('New subtitle files started: times count from now.', 'ok'); void poll(); })),
          vs?.gpu?.nvidia && !s.installed.gpuLibs ? button('Use my graphics card', () => install(['runtime', 'captions', 'gpu']), 'ghost') : null),
        h('p', { class: 'note' }, `OBS Browser Source address: ${overlayUrl()} (transparent; text, size and place can be changed in the address, see docs/LIVE_CAPTIONS.md).`),
        s.text ? h('p', { class: 'note' }, `Last words: “${s.text}”`) : null,
        s.files.list.length ? h('details', null, h('summary', null, `Subtitle files (${s.files.list.length})`),
          h('ul', { class: 'note' }, ...s.files.list.slice(0, 10).map((f) => h('li', null, h('a', { href: `/api/captions/files/${encodeURIComponent(f.name)}`, download: f.name }, f.name), ` · ${(f.bytes / 1024).toFixed(1)} KB`)))) : null,
        h('details', null, h('summary', null, 'Remove the caption files and models'), button('Remove', () => { if (confirm('Remove the caption engine models? (Your subtitle files stay.)')) void send('/api/voice/uninstall', 'POST', { part: 'captions' }).then(() => poll()); }, 'danger')));
    }
    dyn.replaceChildren(...kids.filter((k): k is Node => !!k));
    const sup = vs?.setup;
    steps.replaceChildren(...(sup?.steps ?? []).filter(() => sup?.running || sup?.ok !== null).map((x) => h('li', { style: x.state === 'error' ? 'color:var(--err)' : x.state === 'warn' ? 'color:var(--warn)' : '' }, `${({ run: '…', ok: '✓', skip: '✓', warn: '!', error: '✗', info: '·' } as Record<string, string>)[x.state] ?? ''} ${x.step}: ${x.msg}${x.state === 'run' && x.pct !== undefined ? ` (${Math.round(x.pct * 100)} %)` : ''}`)));
  };

  body.append(
    h('p', { class: 'lead' }, 'Subtitles for your stream, made on this computer from the microphone this studio already listens to. Add the overlay to OBS, and every session also saves .srt and .vtt subtitle files for your recordings.'),
    line, dyn, steps);
  void poll();
  live(() => { if (!box.isConnected) return false; if (++tick % 5 === 0) void poll(); return true; });
  return box;
}
