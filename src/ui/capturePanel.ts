// Scene tab → React screen → "Fast window feed": the server captures the window your OBS capture source shows (or one
// picked here) and streams it to the OBS page at ~30 ms (server/screenFeed.ts). Plain-words status, the source picker,
// and a read-only "Check my OBS setup" that lists what to change in OBS — VTube Pro never changes OBS by itself here.
import type { CaptureSettings, CaptureStatus, CaptureWindow, ObsDiagnosis } from '../../shared/capture.ts';
import { button, clear, h, toast } from './dom.ts';

const j = async <T>(r: Response) => { if (!r.ok) throw new Error(`${r.status}`); return r.json() as Promise<T>; };
const COL = { running: 'var(--ok,#4caf50)', starting: 'var(--dim)', idle: 'var(--dim)', error: 'var(--warn,#e0a030)', unavailable: 'var(--warn,#e0a030)' } as const;

export function captureSection(observer: boolean): HTMLElement {
  const box = h('div', { class: 'cap-feed' });
  const status = h('p', { class: 'note' }, 'Checking the fast window feed…');
  const detail = h('div', { class: 'note', style: 'font-size:11px' });
  const srcSel = h('select', { disabled: observer, style: 'width:100%' }) as HTMLSelectElement;
  const winSel = h('select', { disabled: observer, style: 'width:100%' }) as HTMLSelectElement;
  const winRow = h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'Window'), winSel);
  const diag = h('div');
  let cur: CaptureStatus | null = null;
  // "Find ffmpeg again": the Restart feed route looks for ffmpeg anew (server/screenFeed.ts probe) — shown only while
  // ffmpeg is missing / unusable (just installed or upgraded: no helper restart needed)
  const findFf = button('Find ffmpeg again', async () => {
    try {
      const s = await fetch('/api/capture/restart', { method: 'POST' }).then((r) => j<CaptureStatus>(r));
      paint(s);
      const found = !!(s.ffmpeg.path && s.ffmpeg.gfxcapture && s.ffmpeg.encoder);
      toast(found ? `ffmpeg ${s.ffmpeg.version ?? ''} found` : 'Still no usable ffmpeg — see the message above', found ? 'ok' : 'warn');
    } catch { /* */ }
  });
  let windows: CaptureWindow[] = [];

  const save = async (p: Partial<CaptureSettings>) => {
    if (observer) { toast('Observer: not saved', 'warn'); return; }
    try { paint(await fetch('/api/capture', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) }).then((r) => j<CaptureStatus>(r))); }
    catch (e) { toast(`Save failed: ${(e as Error).message}`, 'err'); }
  };
  const loadWindows = async () => {
    try { windows = (await fetch('/api/capture/windows').then((r) => j<{ windows: CaptureWindow[] }>(r))).windows; } catch { windows = []; }
    fillWindows();
  };
  const fillWindows = () => {
    const want = cur?.settings.window ?? '';
    clear(winSel);
    winSel.append(h('option', { value: '' }, windows.length ? '— pick a window —' : '(no windows found — is OBS connected?)'));
    const seen = new Set<string>();
    for (const w of windows) { if (seen.has(w.value)) continue; seen.add(w.value); winSel.append(h('option', { value: w.value }, `[${w.exe}] ${w.title}`.slice(0, 110))); }
    if (want && !seen.has(want)) winSel.append(h('option', { value: want }, `${want.split(':')[0]} (not open now)`));
    winSel.value = want;
  };
  srcSel.addEventListener('change', () => { const v = srcSel.value as CaptureSettings['source']; void save({ source: v }); if (v === 'window' && !windows.length) void loadWindows(); });
  winSel.addEventListener('change', () => { if (winSel.value) void save({ source: 'window', window: winSel.value }); });

  const paint = (s: CaptureStatus) => {
    cur = s;
    status.style.color = COL[s.state];
    status.textContent = `${s.state === 'running' ? '●' : s.state === 'error' || s.state === 'unavailable' ? '⚠' : '○'} ${s.message}`;
    const obsName = s.settings.source === 'obs' && s.obsSource ? ` (“${s.obsSource}”)` : '';
    if (!srcSel.options.length || srcSel.dataset.obs !== obsName) {
      clear(srcSel);
      srcSel.append(h('option', { value: 'obs' }, `Follow my OBS capture source${obsName} — automatic`), h('option', { value: 'window' }, 'A window I pick here'), h('option', { value: 'off' }, 'Off — share a window from this browser instead (slower)'));
      srcSel.dataset.obs = obsName;
    }
    srcSel.value = s.settings.source;
    winRow.style.display = s.settings.source === 'window' ? '' : 'none';
    if (s.settings.source === 'window' && !winSel.options.length) fillWindows();
    clear(detail);
    const bits: string[] = [];
    if (s.target) bits.push(`Captures: ${s.target}`);
    if (s.state === 'running') bits.push(`${s.width}×${s.height} · ${s.fps} fps · ${Math.round(s.kbps / 1000)} Mbit/s${s.latencyMs !== null ? ` · ≈ ${s.latencyMs} ms window → OBS` : ''}`);
    if (s.receivers.length) bits.push(`OBS pages: ${s.receivers.map((r) => `${r.fps} fps shown${r.rx !== undefined ? ` (${r.rx} received)` : ''}, decode ${r.decodeMs.toFixed(1)} ms${r.hw ? ' (hw)' : ''}${r.decErr ? ` · decoder error ×${r.decErrors ?? 1}: ${r.decErr}` : ''}`).join(' · ')}`);
    if (s.ffmpeg.path) bits.push(`ffmpeg ${s.ffmpeg.version ?? '?'}${s.ffmpeg.encoder ? ` · encoder ${s.ffmpeg.encoder}` : ''}${s.ffmpeg.note ? ` · ${s.ffmpeg.note}` : ''}`);
    findFf.style.display = s.settings.source !== 'off' && (!s.ffmpeg.path || !s.ffmpeg.gfxcapture || !s.ffmpeg.encoder) ? '' : 'none';
    detail.append(...bits.flatMap((b, i) => (i ? [h('br'), b] : [b])));
    if (s.state === 'running' && s.latencyMs !== null) detail.append(h('br'), `If the window’s sound runs ahead, set that audio source’s Sync Offset to ${s.latencyMs} ms (OBS → Audio Mixer → ⋮ → Advanced Audio Properties).`);
  };

  const check = async () => {
    clear(diag); diag.append(h('p', { class: 'note' }, 'Looking at OBS (read-only)…'));
    try {
      const d = await fetch('/api/obs/diagnose').then((r) => j<ObsDiagnosis>(r));
      clear(diag);
      const fixes = d.findings.filter((f) => f.fix);
      const col = { ok: 'var(--ok,#4caf50)', info: 'var(--dim)', warn: 'var(--warn,#e0a030)', err: 'var(--err,#e05050)' } as const;
      diag.append(h('div', { class: 'note' }, ...d.findings.map((f) => h('div', { style: `color:${col[f.level]}` }, `${f.level === 'ok' ? '✔' : f.level === 'info' ? 'ℹ' : '⚠'} ${f.text}`))));
      if (fixes.length) diag.append(h('p', { class: 'note' }, h('b', null, 'Fix it in OBS (you do these — VTube Pro doesn’t change OBS while you might be live):')),
        h('ol', { class: 'note', style: 'margin:2px 0 6px 18px;padding:0' }, ...fixes.map((f) => h('li', null, f.fix!))));
      else if (d.ok) diag.append(h('p', { class: 'note', style: 'color:var(--ok,#4caf50)' }, 'OBS looks good.'));
    } catch (e) { clear(diag); diag.append(h('p', { class: 'note' }, `Couldn’t check OBS (${(e as Error).message}).`)); }
  };

  const refresh = () => { if (!box.isConnected) { clearInterval(poll); return; } if (document.hidden) return; /* a hidden / covered studio (a game in front) asks nothing */ fetch('/api/capture').then((r) => j<CaptureStatus>(r)).then(paint).catch(() => { status.textContent = 'Fast window feed unavailable (server not updated yet?)'; }); };
  const poll = setInterval(refresh, 2000);
  setTimeout(refresh, 0);

  box.append(
    h('p', { class: 'note' }, h('b', null, 'Fast window feed'), ' — the window your OBS capture shows, drawn ON the 3D screen at ≈ 30 ms (Windows; needs ffmpeg 8.1+: ', h('code', null, 'winget install ffmpeg'), '). Works after studio reloads; nothing to pick in the browser. It reads your OBS source with the saved OBS password — “Automate OBS” can stay off.'),
    status,
    h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'Source'), srcSel),
    winRow,
    detail,
    h('div', { class: 'btns tight' },
      button('Refresh windows', () => void loadWindows()),
      button('Restart feed', async () => { try { paint(await fetch('/api/capture/restart', { method: 'POST' }).then((r) => j<CaptureStatus>(r))); } catch { /* */ } }),
      button('Check my OBS setup', () => void check()),
      findFf),
    diag);
  winRow.style.display = 'none';
  findFf.style.display = 'none';
  return box;
}
