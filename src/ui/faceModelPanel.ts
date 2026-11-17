// "My face model" card (Go Live -> Advanced -> Voice, right after "Keep learning me"): OPT-IN, OFF until the performer teaches it.
// A guided ~2.5 minute routine teaches a small network THIS face (crops stay in RAM, nothing is uploaded, only the weights are kept);
// it is used only if it beat the webcam's own tracking on frames it never saw, and only for the channels where it did.
// tracking/faceNet/, docs/FACE_MODEL.md.
import type { App } from '../app.ts';
import { button, h, slider, toast, toggle } from './dom.ts';
import { card, item, live } from './bits.ts';
import { capabilityChip } from './capabilityView.ts';

export const FACEMODEL_PRIVACY = 'Your face crops stay in memory during the routine and are wiped when it ends; nothing is uploaded. What is kept on this PC is the trained network (about 80 KB) plus the average and spread of your own face measurements it was trained on, and how well it did. Party guests and observer tabs never go through it.';

const TEACHER_NAME = { arkit: 'your phone\'s face tracking', maxine: 'NVIDIA Maxine', prompted: 'the prompts and the webcam' } as const;

const nodes = (...a: (Node | null | undefined)[]): Node[] => a.filter((x): x is Node => !!x);

export function faceModelCard(app: App, refresh: () => void): HTMLElement {
  const F = app.faceModel, M = F.mgr;
  const status = h('div', { class: 's-list' });
  const stage = h('div', { class: 's-list' });
  const versions = h('div', { class: 's-list' });
  const controls = h('div', { class: 's-row', style: 'margin:6px 0' });
  const useRow = h('div');
  void F.init().then(() => { if (status.isConnected) paintAll(); });

  const teach = async () => {
    const r = await F.startTeach();
    if (!r.ok) toast(r.why, 'warn', 6000);
    paintAll();
  };
  const del = async () => {
    if (app.observer) { toast('Observer sandbox: nothing is deleted here.', 'warn'); return; }
    if (!confirm('Delete your face model (every version) from this PC? Tracking goes back to the standard model.')) return;
    await F.deleteAll();
    toast('Deleted.', 'ok'); paintAll();
  };
  const paintStage = () => {
    const s = F.state, p = s.progress;
    if (s.phase === 'teaching' && p?.step) {
      const pct = Math.round(p.progress * 100), ring = `background:conic-gradient(var(--accent,#4aa3ff) ${pct * 3.6}deg,rgba(255,255,255,.12) 0);`;
      const settle = p.stepProgress < 0.3 ? ' (getting into it…)' : '';
      stage.replaceChildren(h('div', { style: 'display:flex;gap:14px;align-items:center;margin:8px 0' },
        h('div', { style: `width:84px;height:84px;border-radius:50%;flex:none;display:grid;place-items:center;${ring}` }, h('div', { style: 'width:66px;height:66px;border-radius:50%;background:var(--panel,#1b1f27);display:grid;place-items:center;font-weight:600' }, `${Math.ceil(p.total * (1 - p.progress))} s`)),
        h('div', null, h('div', { style: 'font-size:22px;font-weight:700' }, p.step.prompt.say + settle), h('div', { class: 'note' }, p.step.prompt.sub),
          h('div', { class: 'note', style: 'margin-top:4px' }, `Step ${p.index + 1} of ${p.steps} · ${p.frames} frames so far · ${s.sentence}`))));
    } else if (s.phase === 'waiting' || s.phase === 'training') {
      const t = s.train;
      stage.replaceChildren(...nodes(item('', '…', s.phase === 'waiting' ? 'Waiting to train' : 'Training on this PC', s.message || (t ? `epoch ${t.epoch} of ${t.epochs}` : '')),
        s.phase === 'training' && t ? h('progress', { max: String(t.epochs), value: String(t.epoch), style: 'width:100%' }) : null));
    } else if (s.message) {
      stage.replaceChildren(item(M.last?.adopted ? 'ok' : s.phase === 'result' ? 'warn' : '', M.last?.adopted ? '✓' : s.phase === 'result' ? '!' : '·', M.last?.adopted ? 'Taught and adopted' : s.phase === 'result' ? 'Not adopted' : 'Face model', s.message));
    } else stage.replaceChildren();
  };
  const paintAll = () => {
    const s = F.state, sup = F.support(), busy = s.phase === 'teaching' || s.phase === 'training' || s.phase === 'waiting';
    const cur = M.current;
    status.replaceChildren(...nodes(
      item(F.running ? (app.tracker.faceNetRunning ? 'ok' : 'warn') : '', F.running ? (app.tracker.faceNetRunning ? '●' : '⏸') : '·', F.running ? (app.tracker.faceNetRunning ? 'In use' : 'On, paused while tracking is busy') : cur ? 'Off' : 'Not taught yet',
        cur ? `Version from ${new Date(cur.at).toLocaleString()} · taught by ${TEACHER_NAME[cur.stats.teacher]} · used on ${cur.stats.nAdopted} of ${cur.stats.moving} channels it was checked on`
          : 'Press “Teach my face”. It takes about 2.5 minutes with the camera on, then about a minute of training.'),
      F.maxineOn && F.running ? item('', 'i', 'Maxine is also on', 'The face model wins the channels it was adopted for; Maxine keeps the rest.') : null,
      !sup.ok && app.trackingOn ? item('warn', '!', 'Not available with this camera path', sup.why) : null));
    paintStage();
    useRow.replaceChildren(
      toggle('Use my face model', M.prefs.use && !!cur, (v) => { if (app.observer) { toast('Observer sandbox: not changed.', 'warn'); return; } M.setUse(v); paintAll(); }, 'Off = standard tracking. Switching on only affects the channels that beat MediaPipe when it was checked.'),
      slider('How much of it', M.prefs.share, 0, 1, 0.05, (v) => M.setShare(v), '1 = the model\'s value on its channels, 0 = standard tracking', (v) => `${Math.round(v * 100)}%`));
    const disabled = !cur || !sup.ok || app.observer;
    for (const i of useRow.querySelectorAll('input')) (i as HTMLInputElement).disabled = disabled;
    controls.replaceChildren(...nodes(
      busy && s.phase !== 'waiting' ? button(s.phase === 'teaching' ? 'Cancel the routine' : 'Cancel training', () => { F.cancel(); paintAll(); }, 'ghost') : button(cur ? 'Teach again' : 'Teach my face', () => { void teach(); }, 'primary'),
      cur ? button('Delete', () => { void del(); }, 'ghost') : null));
    const tb = controls.firstChild as HTMLButtonElement | null;
    if (tb && !busy && (!sup.ok || app.observer)) { tb.disabled = true; tb.title = app.observer ? 'Observer sandbox' : sup.why; }
    const ch = cur?.stats.channels.filter((c) => c.used) ?? [];
    versions.replaceChildren(...nodes(
      ...(ch.length ? [h('div', { class: 'note', style: 'margin:4px 0' }, `Taken from the model (r vs the teacher on frames it never saw; the standard tracking in brackets): ${ch.slice(0, 14).map((c) => `${c.name} ${c.rNet.toFixed(2)} (${c.rMp.toFixed(2)})`).join(' · ')}${ch.length > 14 ? ` · +${ch.length - 14} more` : ''}`)] : []),
      ...[...M.versions].reverse().map((v, i) => item(v.id === M.prefs.current && M.prefs.use ? 'ok' : '', v.id === M.prefs.current ? (M.prefs.use ? '✓' : '○') : String(M.versions.length - i), `Version from ${new Date(v.at).toLocaleString()}`,
        `${TEACHER_NAME[v.stats.teacher]} · ${v.stats.nAdopted} of ${v.stats.moving} channels · ${v.stats.frames.train} frames trained`,
        v.id === M.prefs.current ? (M.prefs.use ? h('span', { class: 's-badge ok' }, 'in use') : button('Switch on', () => { M.setUse(true); paintAll(); }, 'ghost')) : button('Use this', () => { M.revertTo(v.id); paintAll(); }, 'ghost'))),
      M.versions.length ? item(M.prefs.current === null ? 'ok' : '', M.prefs.current === null ? '✓' : '·', 'Standard (nothing personal)', 'how VTube Pro tracks for everyone',
        M.prefs.current === null ? h('span', { class: 's-badge ok' }, 'in use') : button('Use standard', () => { M.revertTo(null); paintAll(); }, 'ghost')) : null));
  };
  paintAll();
  const off = F.onChange(() => { if (status.isConnected) paintAll(); else off(); });
  // the ring ticks (a repaint of the buttons every 350 ms would eat clicks: only the stage)
  live(() => { if (!status.isConnected) { off(); return false; } paintStage(); return true; });
  return card('🧠 My face model (optional)', 'A small network taught on YOUR face, in a guided routine of about 2.5 minutes, trained on this PC. It is used only where it beat the webcam\'s standard tracking on moments it never saw (eyes, brows, mouth); everything else stays standard. A phone with face tracking as the teacher makes it much better. ' + FACEMODEL_PRIVACY,
    capabilityChip('face-model'), status, stage, controls, useRow, versions,
    h('div', { class: 'note', style: 'margin:6px 0 2px' }, 'Needs the camera on. The routine only reads the face tracker\'s frames: it never changes your avatar or what goes to OBS. The last 3 versions are kept; one click goes back.'));
}
