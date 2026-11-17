// The model import dialog: "We'll check your model's rigging…" → upload (Blender converts FBX / OBJ / BLEND …) → load →
// a per-item check (skeleton, face shapes, size, detail) with one-click fixes: Re-rig with Blender (the existing bone-heat
// autorig), Set up the face (procedural mouth / eyes), Use as is. No Blender → the one-click installer / blender.org.
// Pure logic: shared/importCheck.ts (tests: tools/importcheck_test.ts). Docs: docs/AVATARS_SIMPLE.md.
import * as THREE from 'three';
import type { App } from '../app.ts';
import type { AvatarProfile } from '../../shared/types.ts';
import { RIG_NOTICE, checkFormat, checkRig, type CheckItem, type Level, type RigFacts } from '../../shared/importCheck.ts';
import { guessSoftRig } from '../avatar/softRig.ts';
import { api, waitJob } from '../api.ts';
import { h, toast } from './dom.ts';

export interface ImportDeps {
  /** Opens the face tools (procedural mouth / eyes) for the loaded avatar. */
  openFace?: () => void;
  /** Called after the avatar changed (import, re-rig): refresh libraries / panels. */
  onDone?: (p: AvatarProfile) => void;
  /** Test hook (observer pages only): replaces the upload. */
  upload?: (f: File) => Promise<AvatarProfile>;
  /** Test hook: force the Blender status instead of asking /api/status. */
  blender?: boolean;
}

const PROBE = ['hips', 'spine', 'chest', 'neck', 'head', 'leftEye', 'rightEye',
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  'leftIndexProximal', 'leftMiddleProximal', 'leftLittleProximal', 'rightIndexProximal', 'rightMiddleProximal', 'rightLittleProximal'];

/** RigFacts from the loaded runtime. */
export function rigFacts(app: App): RigFacts | null {
  const rt = app.runtime;
  if (!rt) return null;
  const hum = rt.humanoid ?? rt.vrm?.humanoid ?? null;
  const bones = hum ? PROBE.filter((n) => { try { return !!hum.getRawBoneNode(n as Parameters<typeof hum.getRawBoneNode>[0]); } catch { return false; } }) : [];
  let height = 0;
  try {
    const box = new THREE.Box3().setFromObject(rt.model);
    const s = rt.model.getWorldScale(new THREE.Vector3()).y || 1;
    if (!box.isEmpty()) height = (box.max.y - box.min.y) / s;
  } catch { /* unmeasurable */ }
  const e = rt.info.expressions;
  return { rig: rt.info.rig, bones, arkit: e.arkit, named: e.named, vrm: e.vrm, triangles: rt.info.triangles, height,
    jaw: !!rt.jawRig, drawnFace: rt.info.proceduralMouth || rt.info.proceduralEyes };
}

const CSS = `
.imp-back{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px}
.imp{background:var(--card,#1a1f26);color:var(--text,#e6e8eb);border:1px solid var(--line,#2c343e);border-radius:14px;max-width:560px;width:100%;
 max-height:calc(100vh - 32px);overflow:auto;padding:18px 20px;box-shadow:0 20px 60px rgba(0,0,0,.45);font-size:14px;line-height:1.45}
.imp h3{margin:0 0 6px;font-size:17px}.imp .imp-file{color:var(--dim,#9aa4af);font-size:12.5px;word-break:break-all}
.imp .imp-notice{background:var(--card2,#222932);border-radius:10px;padding:10px 12px;margin:12px 0}
.imp ul{list-style:none;margin:10px 0;padding:0}.imp li{display:flex;gap:10px;padding:7px 0;border-top:1px solid var(--line,#2c343e)}
.imp li:first-child{border-top:0}.imp .ic{flex:none;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:13px}
.imp .ic.ok{background:#1f4d2e;color:#7bd88f}.imp .ic.warn{background:#4d4118;color:#f5c451}.imp .ic.bad{background:#4d1f1f;color:#f57b7b}
.imp li b{display:block}.imp li span.d{color:var(--dim,#9aa4af)}
.imp .imp-btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.imp .imp-blender{margin-top:10px;padding:10px 12px;border-radius:10px;border:1px dashed var(--line,#2c343e)}
.imp .imp-spin{display:inline-block;width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:impspin .8s linear infinite;vertical-align:-2px;margin-right:8px}
@keyframes impspin{to{transform:rotate(360deg)}}`;
let cssDone = false;
const ICON: Record<Level, string> = { ok: '✓', warn: '!', bad: '✕' };

function row(i: Pick<CheckItem, 'label' | 'level' | 'detail'>) {
  return h('li', null, h('span', { class: `ic ${i.level}`, 'aria-label': i.level }, ICON[i.level]), h('div', null, h('b', null, i.label), h('span', { class: 'd' }, i.detail)));
}
const btn = (text: string, onClick: () => void, cls = '') => h('button', { class: `btn ${cls}`, onClick }, text);

/** Opens the dialog for a dropped / chosen file. */
export function openImportDialog(app: App, file: File, deps: ImportDeps = {}) {
  if (!cssDone) { cssDone = true; document.head.append(h('style', { id: 'vtp-import-dialog' }, CSS)); }
  document.querySelector('.imp-back')?.remove();
  const box = h('div', { class: 'imp', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Import a model' });
  const back = h('div', { class: 'imp-back', onClick: (e: Event) => { if (e.target === back && !busy) close(); } }, box);
  let busy = false;
  let blender: boolean | null = deps.blender ?? null;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); close(); } };
  const close = () => { back.remove(); window.removeEventListener('keydown', onKey, true); };
  window.addEventListener('keydown', onKey, true);
  document.body.append(back);
  const paint = (...kids: (Node | string | null)[]) => { box.replaceChildren(...kids.filter((k): k is Node | string => k !== null)); (box.querySelector('.btn.primary') as HTMLElement | null)?.focus(); };

  const blenderBox = (why: string) => h('div', { class: 'imp-blender' },
    h('b', null, 'Blender isn’t installed'), h('br'), h('span', { class: 'd' }, `${why} Blender is free and runs on your PC.`),
    h('div', { class: 'imp-btns' },
      btn('Install Blender (one click)', async () => {
        try {
          const r = await fetch('/api/aiconnect/install-blender', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
          const j = await r.json().catch(() => ({}));
          toast(r.ok ? (j.next ?? 'Follow the installer window, then click "Check again".') : (j.error ?? 'Couldn’t start the installer — use the download link.'), r.ok ? 'info' : 'warn', 9000);
        } catch (e) { toast((e as Error).message, 'err'); }
      }, 'primary'),
      h('a', { class: 'btn', href: 'https://www.blender.org/download/', target: '_blank', rel: 'noopener' }, 'Download from blender.org'),
      btn('Check again', () => { blender = null; void intro(); })));

  // ---- 1. the notice + format check
  async function intro() {
    paint(h('h3', null, 'Import a model'), h('div', { class: 'imp-file' }, `${file.name} · ${(file.size / 1048576).toFixed(1)} MB`),
      h('p', { class: 'note' }, h('span', { class: 'imp-spin' }), 'Checking what this PC can do…'));
    if (blender === null) {
      try { blender = (await api.status()).blender.available; } catch { blender = null; }
    }
    const fc = checkFormat(file.name, blender);
    const blenderLine = blender === null ? null : row({ label: 'Blender', level: blender ? 'ok' : fc.needsBlender ? 'bad' : 'warn',
      detail: blender ? 'Installed: VTube Pro can convert and re-rig models on this PC.' : fc.needsBlender ? 'Not installed: needed for this file type.' : 'Not installed: not needed for this file, but re-rigging needs it.' });
    paint(h('h3', null, 'Import a model'), h('div', { class: 'imp-file' }, `${file.name} · ${(file.size / 1048576).toFixed(1)} MB`),
      h('div', { class: 'imp-notice' }, RIG_NOTICE),
      h('ul', null, row({ label: 'File type', level: fc.level, detail: fc.message }), blenderLine),
      !fc.canImport && fc.needsBlender ? blenderBox('This file type is converted with Blender.') : null,
      h('div', { class: 'imp-btns' },
        fc.canImport ? btn('Import and check', () => void run(), 'primary') : null,
        btn('Cancel', close, fc.canImport ? 'ghost' : 'primary')),
      h('p', { class: 'note', style: 'margin:10px 0 0' }, 'Any style works: anime, realistic, cartoon, creatures, robots, objects.'));
  }

  // ---- 2. upload + load
  async function run() {
    if (app.observer && !deps.upload) { toast('Observer sandbox: imports are off here.', 'warn'); return; }
    busy = true;
    const conv = checkFormat(file.name, blender).needsBlender;
    paint(h('h3', null, 'Importing…'), h('div', { class: 'imp-file' }, file.name),
      h('p', null, h('span', { class: 'imp-spin' }), conv ? 'Blender is converting your model to GLB (big models take a minute)…' : 'Uploading and loading your model…'));
    try {
      const p = await (deps.upload ?? ((f: File) => api.import(f)))(file);
      await app.loadAvatar(p.id);
      deps.onDone?.(p);
      busy = false;
      result(p);
    } catch (e) {
      busy = false;
      const msg = (e as Error).message;
      paint(h('h3', null, 'That didn’t import'), h('div', { class: 'imp-file' }, file.name),
        h('ul', null, row({ label: 'Error', level: 'bad', detail: msg })),
        /blender not found/i.test(msg) ? blenderBox('Converting this file needs Blender.') : null,
        h('p', { class: 'note' }, 'Tips: export as .glb or .vrm from your 3D program; a .gltf must be a single file. Guide: Help (F1) → Avatars: the easy way.'),
        h('div', { class: 'imp-btns' }, btn('Try again', () => void intro()), btn('Close', close, 'primary')));
    }
  }

  // ---- 3. the check + fixes
  function result(p: AvatarProfile, note?: string) {
    const f = rigFacts(app);
    if (!f) { paint(h('h3', null, 'Imported'), h('p', null, `${p.name} is in your avatars.`), h('div', { class: 'imp-btns' }, btn('Close', close, 'primary'))); return; }
    const c = checkRig(f);
    const allOk = c.items.every((i) => i.level === 'ok');
    const rigBtn = c.needsRig ? btn('Re-rig with Blender', () => void rerig(p), 'primary') : null;
    if (rigBtn && blender === false) (rigBtn as HTMLButtonElement).disabled = true;
    const faceItem = c.items.find((i) => i.key === 'face');
    const faceBtn = deps.openFace && faceItem && faceItem.level !== 'ok' ? btn('Set up the face', () => { close(); deps.openFace!(); }, c.needsRig ? '' : 'primary') : null;
    paint(h('h3', null, `${p.name}: rigging check`), note ? h('p', { class: 'note', style: 'color:#7bd88f' }, note) : null,
      h('p', null, c.summary), h('ul', null, ...c.items.map(row)),
      c.needsRig && blender === false ? blenderBox('Re-rigging uses Blender.') : null,
      c.needsRig ? h('p', { class: 'note' }, 'Re-rig with Blender adds a humanoid skeleton (arms, legs, head) and skin weights on your PC — about 20 seconds to a few minutes. Your original file is kept.') : null,
      h('div', { class: 'imp-btns' }, rigBtn, faceBtn,
        btn(allOk ? 'Done' : 'Use as is (limited tracking)', close, allOk || (!rigBtn && !faceBtn) ? 'primary' : 'ghost')));
  }

  async function rerig(p: AvatarProfile) {
    const rt = app.runtime;
    const soft = app.profile?.rig.soft ?? (rt ? guessSoftRig(rt.model) : null);
    if (!soft) { toast('Load the avatar first', 'warn'); return; }
    if (app.observer && deps.upload) { toast('Observer sandbox: re-rig is shown, not run.', 'warn'); return; }
    busy = true;
    paint(h('h3', null, 'Re-rigging with Blender…'), h('p', null, h('span', { class: 'imp-spin' }), 'Blender is building a skeleton and skin weights on your PC. You can keep streaming; this runs at low priority.'));
    try {
      const { jobId } = await api.autorig(p.id, soft);
      const j = await waitJob(jobId, () => {});
      if (j.status !== 'succeeded') throw new Error(j.error ?? 'Blender re-rig failed');
      await app.loadAvatar(p.id, true);
      const np = app.profile ?? p;
      deps.onDone?.(np);
      busy = false;
      result(np, 'Re-rigged with Blender ✓');
    } catch (e) {
      busy = false;
      paint(h('h3', null, 'Re-rig didn’t work'), h('ul', null, row({ label: 'Blender', level: 'bad', detail: (e as Error).message })),
        h('p', { class: 'note' }, 'You can still use the model as is, or adjust the soft rig under Me → Advanced → Body and try "Improve rig with Blender" there.'),
        h('div', { class: 'imp-btns' }, btn('Back to the check', () => result(p)), btn('Close', close, 'primary')));
    }
  }

  void intro();
}

/** Observer pages only: drive the dialog from a test harness (window.vtpImportTest). Never uploads. */
export function installImportTestHook(app: App) {
  if (!app.observer) return;
  (window as unknown as Record<string, unknown>).vtpImportTest = (name: string, avatarId: string | null, blender?: boolean) => {
    const f = new File([new Uint8Array(1024)], name);
    openImportDialog(app, f, {
      blender, openFace: () => toast('(test) would open the face tools'),
      upload: async () => { if (!avatarId) throw new Error('Conversion to GLB failed: Blender not found. Install Blender or set its path in Settings.'); return api.avatar(avatarId); },
    });
  };
}
