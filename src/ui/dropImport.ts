// "Just drop a model" (owner: people don't understand how to import a model, and when they do it doesn't work).
// Drop a model file, its folder or a .zip anywhere on the studio (or press an Import button): VTube Pro finds the model,
// opens it (VRM / GLB / .gltf + files / MMD .pmx right here; FBX / OBJ / .blend … through the helper's Blender), and
// BEFORE saving shows a plain-words report: format, skeleton (which bones matched which naming scheme), face shapes,
// size / units / up axis / facing, T- or A-pose, textures (missing ones named), detail vs graphics levels, materials.
// The automatic fixes (stand upright, cm → m, turn around, bone + face-shape matching, texture relinking, old
// materials, a drawn mouth / eyes when there are no face shapes) are listed under "What we fixed", each with a switch.
// Import saves it (POST /api/avatars/import + PUT the profile + a thumbnail: the helper, or this browser's storage in
// a page without the server) and, when there's no usable skeleton, offers VTube Pro's autorig (headless Blender) with progress.
// Nothing reaches the stream until "Wear it now". Truly broken files are refused with one fix-it sentence.
// Logic: shared/modelImport/* (tests: tools/model_import_unit.ts). E2E: tools/model_import_e2e.mjs.
// Mount: mountDropImport(app) once (src/main.ts); importModelButton(app) for any panel; openModelImport(app, files).
import * as THREE from 'three';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import type { App } from '../app.ts';
import type { AvatarProfile, SoftRigConfig } from '../../shared/types.ts';
import { normalizeProfile } from '../../shared/defaults.ts';
import { plainNotes, prepareImport, supportReport, type DroppedFile, type FixToggles, type PlainNote, type Prepared, type ReportLine } from '../../shared/modelImport/prepare.ts';
import { LIMITS, zipFiles } from '../../shared/modelImport/files.ts';
import { sniffImageMime } from '../../shared/modelImport/gltf.ts';
import { applyPatch, autoPlan, type ProfilePatch } from '../onboarding/modelCheck.ts';
import { ModelPreview } from '../onboarding/modelPreview.ts';
import { guessSoftRig } from '../avatar/softRig.ts';
import { findJoints, type JointFind } from '../avatar/poseJoints.ts';
import { findFaceFeatures, type FaceFeatures } from '../avatar/faceFeatures.ts';
import { collectMeshes } from '../avatar/surfacePatch.ts';
import { bakeBlink } from '../../shared/modelImport/faceBake.ts';
import { keepImportFace } from '../../shared/autoFace.ts';
import { parseGlb, writeGlb } from '../../shared/modelImport/gltf.ts';
import { restShape } from '../../shared/modelImport/restCheck.ts';
import { pickRig, poseSweep, type RigScore } from '../avatar/rigCheck.ts';
import { AvatarRuntime } from '../avatar/AvatarRuntime.ts';
import { api, waitJob } from '../api.ts';
import { button, h, toast } from './dom.ts';
import { helperAvailable, openGuide, openHelper } from './onboard/links.ts';
import { EXTRAS_HELP } from '../../shared/helpCatalog.ts';
import { REPORT_URL } from './guide/links.ts';
import { isPhone, pickAccept } from '../mobile/device.ts';
import { phoneImportFormats } from '../mobile/phoneUi.ts';
import { RAR_ON_PHONE } from '../mobile/flatImportWeb.ts';

export interface DropImportOpts {
  /** After a save (refresh the avatar lists). */
  onDone?: (id: string) => void;
}

const ACCEPT = '.vrm,.glb,.gltf,.bin,.fbx,.obj,.mtl,.pmx,.pmd,.blend,.dae,.stl,.ply,.usd,.usda,.usdc,.usdz,.abc,.zip,.png,.jpg,.jpeg,.tga,.bmp,.dds,.webp,.moc3,.json,.gif,.apng,.vtp2,.psd,.psb,.inp,.inx,.save,.pngtp,.pngremix,.veadomini,.veado';
const GUIDE = 'AVATARS_SIMPLE.md#drop-a-model-anywhere';
const RIG_GUIDE = 'ARTIST_AVATARS.md#adding-a-skeleton';

// ---------------------------------------------------------------- 2D models (Live2D / PNG): another lane's importer
type TwoDImporter = (files: File[]) => void;
let twoD: TwoDImporter | null = null;
/** The 2D-avatar importer (Live2D, PNG avatars) registers here; until one does, 2D drops get a "coming soon" note. */
export function setTwoDImporter(fn: TwoDImporter | null) { twoD = fn; }

// ---------------------------------------------------------------- styles
const CSS = `
.dimp-over{position:fixed;inset:0;z-index:58;pointer-events:none;display:grid;place-items:center;background:color-mix(in srgb,var(--bg,#0e1015) 72%,transparent);opacity:0;transition:opacity .12s}
.dimp-over.on{opacity:1}
.dimp-over>div{border:3px dashed var(--accent,#7bd88f);border-radius:28px;padding:44px 56px;text-align:center;background:var(--panel,#161920);box-shadow:var(--shadow,0 10px 30px #0008);max-width:calc(100vw - 32px)}
.dimp-over b{display:block;font-size:24px;margin-bottom:8px;color:var(--text,#eef1f6)}
.dimp-over span{color:var(--dim,#a3abba);font-size:14px}
.dimp-back{position:fixed;inset:0;z-index:61;background:#05070bb8;backdrop-filter:blur(3px);display:grid;place-items:center;padding:20px}
.dimp{position:relative;width:min(1060px,100%);height:min(780px,calc(100vh - 40px));background:var(--panel,#161920);color:var(--text,#eef1f6);border:1px solid var(--line2,#333a4a);border-radius:18px;box-shadow:0 24px 80px #000a;display:grid;grid-template-rows:auto 1fr auto;overflow:hidden;font-size:13.5px;line-height:1.45}
.dimp-head{padding:18px 56px 10px 22px;border-bottom:1px solid var(--line,#262b37)}
.dimp-head h2{margin:0;font-size:19px}
.dimp-head .sub{color:var(--dim,#a3abba);font-size:12.5px;margin-top:3px;word-break:break-all}
.dimp-x{position:absolute;top:12px;right:12px;width:36px;height:36px;border-radius:10px;border:1px solid var(--line2,#333a4a);background:var(--card,#1b1f28);color:var(--text,#eef1f6);font-size:18px;cursor:pointer;z-index:3}
.dimp-body{overflow:auto;padding:16px 22px;min-height:0}
.dimp-foot{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px 22px;border-top:1px solid var(--line,#262b37);background:var(--bg2,#13161d)}
.dimp-foot .grow{flex:1}
.dimp .btn.dimp-big{width:auto;min-height:44px;padding:0 22px;font-size:15px;font-weight:700;border-radius:11px}
.dimp-drop{border:2px dashed var(--line2,#333a4a);border-radius:18px;padding:40px 20px;text-align:center;background:var(--card,#1b1f28);cursor:pointer;display:grid;gap:10px;place-items:center;transition:border-color .15s,background .15s}
.dimp-drop:hover,.dimp-drop.over{border-color:var(--accent,#7bd88f);background:var(--accent-soft,#7bd88f22)}
.dimp-drop .big{font-size:42px;line-height:1}
.dimp-drop b{font-size:18px}
.dimp-formats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;margin:14px 0 4px}
.dimp-formats div{background:var(--card,#1b1f28);border:1px solid var(--line,#262b37);border-radius:10px;padding:8px 10px;font-size:12.5px}
.dimp-formats b{display:block;font-size:13px}
.dimp-formats span{color:var(--dim,#a3abba)}
.dimp-cols{display:grid;grid-template-columns:minmax(260px,340px) 1fr;gap:20px;align-items:start}
.dimp-side{position:sticky;top:0;display:grid;gap:10px}
.dimp .ob-prev{position:relative;width:100%;aspect-ratio:4/5;max-height:calc(100vh - 330px);min-height:220px;background:var(--stage,#1b1d24);border-radius:14px;overflow:hidden;border:1px solid var(--line2,#333a4a)}
.dimp .ob-prev canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none}
.dimp .ob-prev .ob-prev-tag{position:absolute;left:8px;top:8px;font-size:11px;padding:2px 8px;border-radius:99px;background:#0009;color:#fff;pointer-events:none}
.dimp .ob-prev .ob-prev-hint{display:none}
.dimp-prev-wait{display:grid;place-items:center;aspect-ratio:4/5;border-radius:14px;border:1px dashed var(--line2,#333a4a);color:var(--dim,#a3abba);font-size:12.5px;text-align:center;padding:10px}
.dimp h3{margin:16px 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim,#a3abba)}
.dimp h3:first-child{margin-top:0}
.dimp-lines{display:grid;gap:6px}
.dimp-line{display:grid;grid-template-columns:24px 1fr;gap:10px;padding:8px 10px;border-radius:10px;background:var(--card,#1b1f28);border:1px solid var(--line,#262b37)}
.dimp-ic{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:12px}
.dimp-ic.ok{background:var(--ok,#7bd88f);color:var(--accent-ink,#08130b)}
.dimp-ic.warn{background:var(--warn,#ffb454);color:#1a1000}
.dimp-ic.bad{background:var(--err,#ff6b6b);color:#fff}
.dimp-ic.info{background:var(--card3,#2a3040);color:var(--dim,#a3abba)}
.dimp-line b{display:block;font-size:13px}
.dimp-line .d{color:var(--dim,#a3abba);font-size:12.5px}
.dimp-line details{margin-top:4px;font-size:12px}
.dimp-line summary{cursor:pointer;color:var(--accent2,#6cc7f5);font-weight:600;width:max-content}
.dimp-line ul{margin:6px 0 0;padding-left:18px;max-height:180px;overflow:auto;color:var(--dim,#a3abba);columns:2 220px}
.dimp-fix{display:grid;grid-template-columns:24px 1fr;gap:10px;align-items:start;padding:8px 10px;border-radius:10px;background:var(--card,#1b1f28);border:1px solid var(--line,#262b37);cursor:pointer}
.dimp-fix input{width:18px;height:18px;margin:2px 0 0;accent-color:var(--accent,#7bd88f)}
.dimp-fix.off{opacity:.7}
.dimp-fix b{display:block;font-size:13px}.dimp-fix span{color:var(--dim,#a3abba);font-size:12.5px}
.dimp-field{display:grid;gap:5px;margin:0 0 10px}
.dimp-field>span{font-size:12px;font-weight:650;color:var(--dim,#a3abba)}
.dimp-field input,.dimp-field select{min-height:38px;border-radius:10px;border:1px solid var(--line2,#333a4a);background:var(--input,#10131a);color:var(--text,#eef1f6);padding:0 10px;font:inherit}
.dimp-note{color:var(--dim,#a3abba);font-size:12.5px;margin:8px 0}
.dimp-callout{border:1px dashed var(--warn,#ffb454);background:var(--warn-soft,#ffb45422);border-radius:12px;padding:10px 12px;margin:10px 0;display:grid;gap:8px}
.dimp-callout.bad{border-color:var(--err,#ff6b6b);background:var(--err-soft,#ff6b6b22)}
.dimp-callout.ok{border-color:var(--accent,#7bd88f);background:var(--accent-soft,#7bd88f22)}
.dimp-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.dimp-busy{display:grid;place-items:center;gap:14px;text-align:center;padding:40px 10px;color:var(--dim,#a3abba)}
.dimp-busy ol{text-align:left;margin:0;padding-left:20px;font-size:12.5px}
.dimp-spin{display:inline-block;width:22px;height:22px;border:3px solid var(--accent,#7bd88f);border-right-color:transparent;border-radius:50%;animation:dimpspin .8s linear infinite}
@keyframes dimpspin{to{transform:rotate(360deg)}}
.dimp-bar{height:8px;border-radius:99px;background:var(--card3,#2a3040);overflow:hidden;width:min(420px,100%)}
.dimp-bar i{display:block;height:100%;background:var(--accent,#7bd88f);transition:width .4s}
.dimp-done{display:grid;place-items:center;text-align:center;gap:10px;padding:8px 0}
.dimp-done .okc{width:60px;height:60px;border-radius:50%;background:var(--accent,#7bd88f);color:var(--accent-ink,#08130b);display:grid;place-items:center;font-size:32px;font-weight:800}
.dimp-done img{width:170px;aspect-ratio:4/5;object-fit:cover;border-radius:14px;border:1px solid var(--line2,#333a4a);background:var(--stage,#1b1d24)}
.dimp-done ul{text-align:left;margin:0;padding-left:18px;color:var(--dim,#a3abba);font-size:12.5px}
.dimp-say{display:grid;grid-template-columns:24px 1fr;gap:10px;align-items:start;padding:9px 11px;border-radius:10px;background:var(--card,#1b1f28);border:1px solid var(--line,#262b37);font-size:13.5px}
.dimp-say.warn{border-color:color-mix(in srgb,var(--warn,#ffb454) 55%,transparent)}
.dimp-say.bad{border-color:color-mix(in srgb,var(--err,#ff6b6b) 55%,transparent)}
.dimp-details{margin-top:16px;border-top:1px solid var(--line,#262b37);padding-top:10px}
.dimp-details>summary{cursor:pointer;color:var(--accent2,#6cc7f5);font-weight:650;width:max-content}
.dimp-bgnote{position:fixed;right:16px;bottom:16px;z-index:59;width:min(380px,calc(100vw - 32px));background:var(--panel,#161920);color:var(--text,#eef1f6);border:1px solid var(--line2,#333a4a);border-radius:14px;box-shadow:0 12px 40px #0009;padding:12px 44px 4px 14px;font-size:13px}
.dimp-bgnote .dimp-x{top:8px;right:8px;width:28px;height:28px;font-size:14px}
.dimp-views .btn{min-height:30px;padding:0 12px;font-size:12.5px}.dimp-views .btn.on{border-color:var(--accent,#7bd88f);color:var(--text,#eef1f6);background:var(--accent-soft,#7bd88f22)}
.dimp-notes{white-space:pre-wrap;font-size:12px;color:var(--dim,#a3abba);max-height:120px;overflow:auto;background:var(--card,#1b1f28);border:1px solid var(--line,#262b37);border-radius:10px;padding:8px 10px}
@media (prefers-reduced-motion: reduce){.dimp-spin{animation-duration:3s}}
@media (max-width: 760px){.dimp-back{padding:0}.dimp{height:100vh;width:100vw;border-radius:0}.dimp-cols{grid-template-columns:1fr}.dimp-side{position:static}.dimp .ob-prev{aspect-ratio:1/1;max-height:38vh;min-height:180px}.dimp-prev-wait{aspect-ratio:auto;min-height:120px}.dimp-head{padding:14px 52px 8px 16px}.dimp-body{padding:12px 16px}.dimp-foot{padding:10px 16px}.dimp-foot .grow{display:none}.dimp-foot .btn{flex:1 1 auto}.dimp-line ul{columns:1}.dimp-over>div{padding:28px 22px}}
`;
function css() { if (!document.getElementById('vtp-drop-import')) document.head.append(h('style', { id: 'vtp-drop-import' }, CSS)); }

// ---------------------------------------------------------------- reading what was dropped

interface Picked { path: string; file: File }

/** Files + folders from a drop (folders read recursively). Must be called inside the drop event. */
function entriesFromDrop(dt: DataTransfer): Promise<Picked[]> {
  const items = [...(dt.items ?? [])].filter((i) => i.kind === 'file');
  const entries = items.map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() ?? null);
  if (!entries.length || entries.some((e) => !e)) return Promise.resolve([...(dt.files ?? [])].map((f) => ({ path: f.name, file: f })));
  const out: Picked[] = [];
  let count = 0;
  const walk = async (e: FileSystemEntry, prefix: string): Promise<void> => {
    if (++count > LIMITS.files) throw new Error('That folder has too many files (over 4,000). Drop just the model’s own folder.');
    if (e.isFile) {
      const file = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
      out.push({ path: prefix + e.name, file });
      return;
    }
    if (e.isDirectory) {
      if (/^(__MACOSX|\.git|node_modules)$/.test(e.name)) return;
      const reader = (e as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const c of batch) await walk(c, `${prefix}${e.name}/`);
      }
    }
  };
  return (async () => { for (const e of entries) await walk(e!, ''); return out; })();
}

async function readPicked(list: Picked[]): Promise<DroppedFile[]> {
  // a folder dropped on a box that only takes files arrives as an empty "file" with no type
  if (list.length === 1 && list[0].file.size === 0 && !list[0].file.type && !/\.[a-z0-9]+$/i.test(list[0].file.name)) {
    throw new Error('That looks like a folder. Drop it anywhere on the studio (outside this box), or use “Choose a folder…”.');
  }
  const total = list.reduce((n, p) => n + p.file.size, 0);
  if (total > LIMITS.total) throw new Error(`That’s ${Math.round(total / 1048576)} MB: too much to open at once (700 MB at most). Drop just the model and its textures.`);
  return Promise.all(list.map(async (p) => ({ path: p.path, bytes: new Uint8Array(await p.file.arrayBuffer()) })));
}

/** BMP / GIF / WebP / TGA → PNG in the browser (glTF only holds PNG + JPEG). DDS isn't decoded (reported missing). */
async function toPng(bytes: Uint8Array, name: string): Promise<Uint8Array | null> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (/\.tga$/i.test(name) && !sniffImageMime(bytes)) {
    const t = new TGALoader().parse(bytes.slice().buffer as ArrayBuffer) as unknown as { data: Uint8Array; width: number; height: number; flipY?: boolean };
    if (!t?.data || !t.width) return null;
    canvas.width = t.width; canvas.height = t.height;
    const img = ctx.createImageData(t.width, t.height);
    // TGALoader hands rows bottom-up for a texture with flipY: put them top-down for a picture
    for (let y = 0; y < t.height; y++) {
      const src = (t.flipY ? t.height - 1 - y : y) * t.width * 4;
      img.data.set(t.data.subarray(src, src + t.width * 4), y * t.width * 4);
    }
    ctx.putImageData(img, 0, 0);
  } else {
    const mime = sniffImageMime(bytes);
    if (!mime || /dds|ktx/.test(mime)) return null;
    const bmp = await createImageBitmap(new Blob([bytes.slice()], { type: mime }));
    canvas.width = bmp.width; canvas.height = bmp.height;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
  }
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/** The helper converts FBX / OBJ / .blend …: the model (+ its textures / .mtl as a stored zip). */
async function convertOnHelper(main: DroppedFile, side: DroppedFile[]): Promise<{ glb: Uint8Array; missing?: string[] }> {
  const body = side.length ? zipFiles([main, ...side]) : main.bytes;
  const name = side.length ? main.path : main.path.split('/').pop()!;
  const r = await fetch(`/api/import/convert?filename=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: body.slice() });
  const j = await r.json().catch(() => ({})) as { token?: string; missing?: string[]; error?: string };
  if (!r.ok || !j.token) throw new Error(j.error ?? `VTube Pro answered ${r.status}.`);
  const g = await fetch(`/api/import/convert/${encodeURIComponent(j.token)}`);
  if (!g.ok) throw new Error('VTube Pro lost the converted model. Drop the file again.');
  return { glb: new Uint8Array(await g.arrayBuffer()), missing: j.missing };
}

// ---------------------------------------------------------------- the dialog

type Phase = 'pick' | 'busy' | 'report' | 'saving' | 'rig' | 'done' | 'refuse' | 'needs' | 'route2d';
let openDialog: { close(): void; take(files: Picked[]): void } | null = null;
/** For the e2e (tools/model_import_e2e.mjs): what the dialog is showing. */
const state = { phase: 'closed' as Phase | 'closed', status: '', savedId: null as string | null, error: null as string | null };
(window as unknown as { __vtpDropImport?: typeof state }).__vtpDropImport = state;

export function openModelImport(app: App, input?: File[] | Picked[] | null, opts: DropImportOpts = {}) {
  if (openDialog) { if (input?.length) openDialog.take(normalizeInput(input)); return; }
  css();
  document.querySelector('.dimp-bgnote')?.remove(); // a background-rig notice comes back when this dialog closes
  let phase: Phase = 'pick';
  let files: DroppedFile[] = [];
  let rawFiles: File[] = [];
  let rawPicked: Picked[] = [];
  let prepared: Prepared | null = null;
  let toggles: FixToggles = {};
  let choice: string | undefined;
  let name = '';
  let busyText = '';
  let helper = false, blender: boolean | null = null;
  let pv: ModelPreview | null = null;
  let draft: AvatarProfile | null = null;
  let faceFix = true, facePatch: ProfilePatch | null = null, faceWhat: string[] = [];
  /** What the model already has (checked before anything is drawn on), and the sentences about it. */
  let feats: FaceFeatures | null = null, faceKept: string[] = [];
  /** The preview's view: the whole model at a 3/4 angle, or the face. */
  let faceView = false;
  let checked = false;
  let wantRig = true;
  let saved: AvatarProfile | null = null, thumbUrl: string | null = null, rigNote: { ok: boolean; text: string } | null = null;
  /** No usable skeleton: the soft rig built from the joints found on the model (instant, in the browser). */
  let rigPatch: ProfilePatch | null = null, joints: JointFind | null = null, softScore: RigScore | null = null;
  let errText = '';
  let detailsOpen = false;
  let seq = 0;

  const body = h('div', { class: 'dimp-body' });
  const head = h('div', { class: 'dimp-head' });
  const foot = h('div', { class: 'dimp-foot' });
  const closeX = h('button', { class: 'dimp-x', title: 'Close (Esc)', 'aria-label': 'Close', onClick: () => tryClose() }, '✕');
  const card = h('div', { class: 'dimp', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Import a model', 'data-ui': 'drop-import' } as never, closeX, head, body, foot);
  const back = h('div', { class: 'dimp-back', onClick: (e: Event) => { if (e.target === back) tryClose(); } }, card);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); tryClose(); } };
  window.addEventListener('keydown', onKey, true);
  document.body.append(back);
  // drops on the open dialog replace the file (anywhere on it)
  card.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); } });
  card.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    if (phase === 'busy' || phase === 'saving' || phase === 'rig') return;
    void entriesFromDrop(e.dataTransfer).then((l) => take(l)).catch((er) => fail((er as Error).message));
  });

  const setPhase = (p: Phase) => { phase = p; state.phase = p; };
  (window as unknown as { __vtpImportRt?: () => unknown }).__vtpImportRt = () => pv?.rt ?? null; // (debug / e2e: the preview's avatar)
  function tryClose() {
    if (phase === 'saving' || phase === 'rig') { toast('Wait a moment: VTube Pro is still saving your model.', 'info'); return; }
    close();
  }
  const onBg = () => { if (phase === 'done') doneScreen(); };
  bgListeners.add(onBg);
  function close() {
    bgListeners.delete(onBg);
    window.removeEventListener('keydown', onKey, true);
    pv?.dispose(); pv = null;
    back.remove();
    openDialog = null;
    state.phase = 'closed';
    paintBgNotice();
  }
  const paint = (title: string, sub: string | null, kids: (Node | string | null)[], buttons: (Node | null)[]) => {
    head.replaceChildren(h('h2', null, title), sub ? h('div', { class: 'sub' }, sub) : '');
    body.replaceChildren(...kids.filter((k): k is Node | string => k !== null));
    foot.replaceChildren(...buttons.filter((b): b is Node => b !== null));
    (foot.querySelector('.btn.primary') as HTMLElement | null)?.focus({ preventScroll: true });
  };
  const fileInput = h('input', { type: 'file', multiple: true, accept: pickAccept(ACCEPT), style: 'display:none' }) as HTMLInputElement;
  const dirInput = h('input', { type: 'file', style: 'display:none' }) as HTMLInputElement;
  dirInput.setAttribute('webkitdirectory', '');
  fileInput.onchange = () => { const l = [...(fileInput.files ?? [])].map((f) => ({ path: f.name, file: f })); fileInput.value = ''; if (l.length) take(l); };
  dirInput.onchange = () => { const l = [...(dirInput.files ?? [])].map((f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, file: f })); dirInput.value = ''; if (l.length) take(l); };
  card.append(fileInput, dirInput);

  // ---- 1. pick
  function pickScreen() {
    setPhase('pick');
    const drop = h('div', { class: 'dimp-drop', 'data-tut': 'imp-drop', role: 'button', tabindex: 0, onClick: () => fileInput.click(), onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } } },
      h('div', { class: 'big', 'aria-hidden': 'true' }, '⇩'), h('b', null, 'Drop your model here'), h('span', { class: 'dimp-note' }, 'A model file, its whole folder, or a .zip. You can also drop it anywhere on the studio.'));
    drop.addEventListener('dragenter', () => drop.classList.add('over'));
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', () => drop.classList.remove('over'));
    const fmt = (b: string, s: string) => h('div', null, h('b', null, b), h('span', null, s));
    paint('Import a model', 'VTube Pro checks it and fixes what it can before anything is saved. Nothing changes on your stream.', [
      drop,
      isPhone() ? phoneImportFormats(fmt) : h('div', { class: 'dimp-formats' },
        fmt('VRoid / VRM (.vrm)', 'Best for anime avatars. Opens right here.'),
        fmt('glTF (.glb, .gltf)', 'Blender, Unity, Ready Player Me… Opens right here.'),
        fmt('MMD (.pmx)', 'Drop the .zip or folder so the textures come along.'),
        fmt('FBX, OBJ, .blend', 'Converted by Blender in VTube Pro.')),
      isPhone() ? null : h('p', { class: 'dimp-note' }, 'Pro2D and PNG avatars are 2D: drop them too and VTube Pro sends them to the 2D importer. Moving from another 2D app? Drop its model folder or .zip (.model3.json + .moc3, or .inx/.inp) the same way. A PNGTuber Plus, Remix or veadotube save works too: drop the save file.'),
    ], [
      button('Choose files…', () => fileInput.click(), 'primary dimp-big'),
      isPhone() ? null : button('Choose a folder…', () => dirInput.click()), // (phones: a zip or all the files: folders aren't a phone thing)
      h('span', { class: 'grow' }),
      button('How importing works', () => void openGuide(GUIDE, 'the Avatars guide')),
      button('Cancel', close, 'ghost'),
    ]);
  }

  function take(list: Picked[]) {
    rawFiles = list.map((p) => p.file); rawPicked = list;
    toggles = {}; choice = undefined; name = ''; faceFix = true; faceView = false; wantRig = true; saved = null; rigNote = null; thumbUrl = null; detailsOpen = false; rigPatch = null; joints = null; softScore = null;
    void (async () => {
      const my = ++seq;
      busy('Reading what you dropped…');
      try { files = await readPicked(list); } catch (e) { fail((e as Error).message); return; }
      if (my !== seq) return;
      await check(my);
    })();
  }

  function busy(text: string, steps?: string[]) {
    setPhase('busy');
    busyText = text; state.status = text;
    const stepEl = steps ? h('ol', null, ...steps.map((s) => h('li', null, s))) : null;
    paint('Checking your model', rawFiles.length ? `${rawFiles.length === 1 ? rawFiles[0].name : `${rawFiles.length} files`} · ${(rawFiles.reduce((n, f) => n + f.size, 0) / 1048576).toFixed(1)} MB` : null,
      [h('div', { class: 'dimp-busy', 'aria-live': 'polite' }, h('span', { class: 'dimp-spin', 'aria-hidden': 'true' }), h('b', { class: 'dimp-busy-t' }, busyText), stepEl)], [button('Cancel', () => { seq++; close(); }, 'ghost')]);
  }
  const setBusyText = (t: string) => { busyText = t; state.status = t; const el = body.querySelector('.dimp-busy-t'); if (el) el.textContent = t; };

  // ---- 2. check (prepare) + preview
  async function check(my = seq) {
    busy('Checking skeleton, face shapes, size and textures…');
    try { helper = await helperAvailable(); } catch { helper = false; }
    if (helper && blender === null) { try { blender = (await api.status()).blender.available; } catch { blender = null; } }
    if (my !== seq) return;
    let p: Prepared;
    try {
      p = await prepareImport(files, { helper, blender, convert: convertOnHelper, convertImage: toPng, status: setBusyText }, { toggles, choice });
    } catch (e) { fail((e as Error).message); return; }
    if (my !== seq) return;
    prepared = p;
    if (!name) name = p.seed.name;
    if (p.status === 'refuse') { refuseScreen(p); return; }
    if (p.status === 'needs-helper' || p.status === 'needs-blender') { needsScreen(p); return; }
    if (p.status === 'route2d') { route2dScreen(p); return; }
    await preview(my);
  }

  /** Loads the prepared model in a private 3D preview, verifies the studio sees the skeleton, and works out the
   *  automatic face setup (drawn mouth / eyes, hair swing, robot look) with the same plan as "Add my model". */
  async function preview(my: number) {
    const p = prepared!;
    rigPatch = null; joints = null; softScore = null; checked = false;
    if (p.needsRig && p.facts?.container === 'glb') {
      // no usable skeleton: find the head, arms and legs on the model itself (a front render + the body tracker) and
      // give it an instant soft rig on those joints, so it moves with tracking right away (Blender upgrades it later)
      setBusyText('Finding its head, arms and legs…');
      try { joints = await findJoints(p.file!.bytes.slice().buffer as ArrayBuffer); } catch (e) { console.warn('[drop import] joints', e); }
      if (my !== seq) return;
      if (joints && !p.facts.boneMap?.humanoid) rigPatch = { rig: { kind: 'soft', soft: joints.soft } };
    }
    setBusyText('Loading it in 3D…');
    const seedP = draftBase(p);
    pv?.dispose();
    pv = new ModelPreview();
    // (cleared before the load: a model the preview can't open must not keep the last model's face findings, which
    //  save() turns into kept / picked eyes)
    facePatch = null; faceWhat = []; feats = null; faceKept = [];
    try {
      draft = seedP;
      await pv.load(seedP, p.file!.bytes.slice().buffer as ArrayBuffer);
      if (my !== seq) return;
      // before drawing a face on: what does it already have? (modelled eye spheres, painted eyes, a painted mouth)
      let f = pv.facts(p.file!.name);
      if (f && pv.rt && p.facts?.container === 'glb') {
        const caps = f.named.length + f.arkit;
        if (!caps || !f.named.some((x) => /blink/i.test(x))) {
          try { feats = findFaceFeatures(pv.rt.model, collectMeshes(pv.rt.model), pv.rt.humanoid?.getRawBoneNode('head') ?? null, seedP.transform.yaw); } catch (e) { console.warn('[drop import] face check', e); }
        }
        (window as unknown as { __vtpFaceFeatures?: unknown }).__vtpFaceFeatures = feats ? { eyes: feats.eyes, mouth: feats.mouth, eyeMaterials: feats.eyeMaterials, mouthAt: feats.mouthAt } : null;
        if (feats?.eyes === 'geometry' && feats.eyeMaterials.length) {
          // its own modelled eyes: make them blink (morphs baked into the saved file) instead of drawing new ones
          try {
            const doc = parseGlb(p.file!.bytes);
            const added = bakeBlink(doc, feats.eyeMaterials, Math.round(((seedP.transform.yaw % 360) + 360) % 360) !== 180);
            if (added.length) {
              p.file = { name: p.file!.name, bytes: writeGlb(doc).glb };
              p.fixes.push({ id: 'blink', label: 'Made its own eyes blink', detail: `Blink shapes (${added.join(', ')}) added to its modelled eyes (${feats.eyeMaterials.join(', ')}).`, on: true, toggle: null, say: 'It already has eyes, so we made them blink instead of drawing new ones.' });
              await pv.load(seedP, p.file.bytes.slice().buffer as ArrayBuffer);
              if (my !== seq) return;
              f = pv.facts(p.file.name);
            } else faceKept.push('It already has eyes, so we kept them (they won’t blink).');
          } catch (e) { console.warn('[drop import] blink bake', e); faceKept.push('It already has eyes, so we kept them (they won’t blink).'); }
        } else if (feats?.eyes !== 'none' && feats) faceKept.push(feats.eyes === 'painted' ? 'It has painted-on eyes, so we kept them as they are (they won’t blink).' : 'It already has eyes, so we kept them (they won’t blink).');
      }
      if (f) {
        const plan = autoPlan(f, seedP, { helper });
        const patch: ProfilePatch = {};
        for (const it of plan.items) {
          if (it.state !== 'apply' || it.id === 'facing' || it.id === 'shapes') continue;
          if (it.needs) {
            const g = pv.guessFace();
            if (it.needs === 'mouth' && feats?.mouthAt) {
              // a painted / modelled mouth is already there: animate that one, where it is (never a second mouth)
              const m = feats.mouthAt;
              Object.assign(patch, { mouth: { mode: 'procedural', style: 'cavity', center: m.center, width: m.width, openHeight: Math.max(m.height * 2.2, m.width * 0.6), influence: m.width * 1.8 } });
              faceKept.push('It already has a mouth, so we made that one talk.');
            } else if (it.needs === 'mouth' && feats?.mouthSpot) {
              // its own eyes are known: the drawn mouth goes under them, clear of a nose
              const m = feats.mouthSpot;
              Object.assign(patch, { mouth: { mode: 'procedural', style: 'cavity', center: m.center, width: m.width, openHeight: m.width * 0.9, influence: m.width * 2.2 } });
              faceWhat.push('a drawn mouth that talks and smiles');
            } else if (it.needs === 'mouth' && g?.mouth) {
              Object.assign(patch, { mouth: { mode: 'procedural', style: 'cavity', center: g.mouth.center, width: g.mouth.width, openHeight: g.mouth.openHeight, influence: g.mouth.influence } });
              faceWhat.push('a drawn mouth that talks and smiles');
            }
            if (it.needs === 'eyes' && feats && feats.eyes !== 'none') { /* its own eyes stay (see faceKept) */ } else if (it.needs === 'eyes' && g?.eyes?.left && g.eyes.right) {
              const e = (it.patch?.eyes ?? {}) as ProfilePatch;
              Object.assign(patch, { eyes: { mode: 'procedural', protrusion: 0.25, ...e, style: e.style ?? (g.mascot ? 'bulb' : 'inset'), left: g.eyes.left, right: g.eyes.right, size: g.eyes.size } });
              faceWhat.push(e.replaceBaked ? 'tracked eyes over the painted ones' : 'drawn eyes that blink and look around');
            }
          } else if (it.patch && (it.id === 'physics' || it.id === 'look')) {
            Object.assign(patch, it.patch);
            faceWhat.push(it.id === 'physics' ? 'hair and clothes swing' : 'the shiny “toy” look for a robot or prop');
          }
        }
        if (Object.keys(patch).length) facePatch = patch;
      }
      await applyDraft();
      (window as unknown as { __vtpFaceSay?: unknown }).__vtpFaceSay = { kept: faceKept, drawn: faceWhat };
      view();
    } catch (e) {
      if ((e as Error).message === 'superseded') return;
      // the file opened in the checks but not in 3D: say so, still offer to save (the studio may load it)
      console.warn('[drop import] preview', e);
      pv?.dispose(); pv = null;
      p.report.unshift({ id: 'file', label: '3D preview', level: 'warn', detail: `The preview couldn’t open it (${(e as Error).message}). You can still import it; if it doesn’t show, export it again as .glb.` });
    }
    if (my !== seq) return;
    reportScreen();
  }

  /** One piece? (run once the preview is on screen and has drawn a few frames: the avatar finishes setting itself up
   *  on its first updates) The studio's rest height vs the file's, the fixes' rest-shape check, and a pose sweep. */
  async function onePieceCheck(my: number) {
    const p = prepared;
    if (!p?.file || !pv?.rt) return;
    {
        // one piece? the studio's rest shape must be as tall as the file's (no part left behind by a bad scale), and a
        // pose sweep must keep the parts that touch at rest together (tools/model_import_e2e.mjs asserts both)
        try {
          await new Promise((r) => setTimeout(r, 300));
          if (my !== seq || !pv?.rt) return;
          const fileH = restShape(parseGlb(p.file!.bytes)).height;
          const sweep = pv.rt!.humanoid ? poseSweep(pv.rt!) : null;
          if (rigPatch) softScore = sweep;
          // the studio's rest shape: every humanoid bone at rest (the preview may already be idling / swaying)
          let rtH = sweep?.restHeight ?? 0;
          if (!rtH) { const b = new THREE.Box3(); for (const m of collectMeshes(pv.rt!.model)) b.expandByObject(m, true); rtH = (b.max.y - b.min.y) / (pv.rt!.model.getWorldScale(new THREE.Vector3()).y || 1); }
          const worst = (k: 'gap' | 'fly' | 'tear') => (sweep ? Math.max(0, ...sweep.poses.map((x) => x[k])) : 0);
          (window as unknown as { __vtpImportCheck?: unknown }).__vtpImportCheck = { fileH, rtH, integrity: p.integrity, sweep: sweep ? { score: sweep.score, contacts: sweep.contacts, gap: worst('gap'), fly: worst('fly'), tear: worst('tear') } : null };
        } catch (e) { console.warn('[drop import] one-piece check', e); }
      }
  }

  function draftBase(p: Prepared): AvatarProfile {
    const b = normalizeProfile(applyPatch({ id: 'drop-import-preview', name, modelFile: p.file!.name, source: 'import', ...(p.file!.name.endsWith('.vrm') ? { rig: { kind: 'vrm' } } : {}) } as unknown as AvatarProfile, p.seed as ProfilePatch));
    return rigPatch ? normalizeProfile(applyPatch(b, rigPatch)) : b;
  }

  async function applyDraft() {
    if (!pv || !prepared?.file) return;
    const base = draftBase(prepared);
    draft = faceFix && facePatch ? normalizeProfile(applyPatch(base, facePatch)) : base;
    try { await pv.load(draft); view(); } catch { /* superseded */ }
  }

  /** Frame the preview: the whole model (after the scale / axis fixes) at a 3/4 angle with a margin, or the face. */
  function view() {
    const st = pv?.stage, rt = pv?.rt;
    if (!st || !rt) return;
    st.anchor.rotation.set(0, faceView ? 0 : -0.5, 0);
    st.anchor.updateMatrixWorld(true);
    if (faceView) { pv!.frame('head'); return; }
    const box = rt.bounds();
    if (box.isEmpty()) { pv!.frame('full'); return; }
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const cam = st.camera, cv = pv!.canvas;
    const aspect = cv.clientWidth > 0 && cv.clientHeight > 0 ? cv.clientWidth / cv.clientHeight : cam.aspect || 0.8;
    const tan = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const dist = Math.max((size.y * 0.6) / tan, (size.x * 0.6) / (tan * aspect)) + size.z * 0.6;
    cam.aspect = aspect;
    cam.position.set(c.x, c.y + size.y * 0.03, c.z + dist);
    cam.near = Math.max(0.005, dist / 100); cam.far = dist * 20;
    cam.updateProjectionMatrix();
    if (st.controls) { st.controls.target.copy(c); st.controls.update(); } else cam.lookAt(c);
    st.render();
  }

  // ---- 3. the report: plain sentences up front, the technical report + switches behind "Details"
  const ICON: Record<string, string> = { ok: '✓', warn: '!', bad: '✕', info: 'i' };
  const lineEl = (l: ReportLine) => h('div', { class: `dimp-line lvl-${l.level}`, 'data-line': l.id } as never,
    h('span', { class: `dimp-ic ${l.level}`, 'aria-label': l.level }, ICON[l.level]),
    h('div', null, h('b', null, l.label), h('span', { class: 'd' }, l.detail),
      l.more?.length ? h('details', null, h('summary', null, l.id === 'skeleton' ? `Show the ${l.more.length} matched bones` : l.id === 'face' ? 'Show the matched face shapes' : 'Show more'), h('ul', null, ...l.more.slice(0, 200).map((m) => h('li', null, m)))) : null));
  const said = (text: string, level: 'ok' | 'warn' | 'bad' | 'info' = 'ok', step: Node | null = null) => h('div', { class: `dimp-say ${level}` },
    h('span', { class: `dimp-ic ${level}`, 'aria-hidden': 'true' }, ICON[level]), h('div', null, h('span', null, text), step ? h('div', { class: 'dimp-row', style: 'margin-top:6px' }, step) : null));
  const stepButton = (s: PlainNote['step']): Node | null =>
    s === 'folder' ? button('Choose the model’s folder…', () => dirInput.click(), 'primary')
      : s === 'helper' ? button('Open VTube Pro', () => void openHelper(), 'primary')
        : s === 'blender' ? button('Install Blender (one click)', () => void installBlender(), 'primary')
          : s === 'guide' ? button('Show me how', () => void openGuide(GUIDE, 'the Avatars guide'))
            : null;

  function softSay() {
    return joints?.source === 'pose'
      ? 'It had no skeleton, so we gave it one that follows its own head, arms and legs: it moves with you right away.'
      : 'It had no skeleton, so we gave it a simple one: it leans and nods with you right away.';
  }

  function willRig() { return !!prepared?.needsRig && wantRig && helper && blender !== false; }

  function reportScreen() {
    const p = prepared!;
    setPhase('report');
    const nameIn = h('input', { type: 'text', value: name, maxLength: 40, 'aria-label': 'Model name', onInput: (e: Event) => { name = (e.target as HTMLInputElement).value.slice(0, 40); } }) as HTMLInputElement;
    // what we did, one plain sentence each
    const did = p.fixes.filter((x) => x.on && x.say).map((x) => said(x.say!));
    if (rigPatch) did.push(said(softSay()));
    for (const k of faceKept) did.push(said(k));
    if (faceFix && facePatch && faceWhat.length) did.push(said(`We gave it ${faceWhat.join(' and ')}.`));
    const notes = plainNotes({ facts: p.facts, report: p.report, needsRig: p.needsRig && !rigPatch, needsFace: p.needsFace, fileBytes: p.file?.bytes.byteLength ?? 0, helper, blender });
    const noteEls = notes.map((n) => said(n.text, n.level === 'info' ? 'info' : n.level, n.step === 'rig' && !wantRig ? null : stepButton(n.step)));
    if (rigPatch) {
      if (helper && blender !== false) { if (wantRig) noteEls.unshift(said('After saving, Blender also builds a more detailed skeleton in the background and switches to it if it moves better.', 'info')); }
      else noteEls.unshift(said(!helper ? 'VTube Pro can build a more detailed skeleton with Blender.' : 'Blender (free) can build a more detailed skeleton. One click installs it.', 'info', stepButton(!helper ? 'helper' : 'blender')));
    }
    if (!did.length && !notes.length) did.push(said('It’s ready as it is: nothing needed fixing.'));
    // Details: the full check, the switches, the model choice, the author's notes
    const fixEls = p.fixes.map((x) => {
      const cb = h('input', { type: 'checkbox', checked: x.on, disabled: !x.toggle, 'aria-label': x.label }) as HTMLInputElement;
      if (x.toggle) cb.onchange = () => { toggles = { ...toggles, [x.toggle!]: cb.checked }; detailsOpen = true; void check(++seq); };
      return h('label', { class: `dimp-fix ${x.on ? '' : 'off'}` }, cb, h('div', null, h('b', null, x.label), h('span', null, x.detail)));
    });
    if (facePatch) {
      const cb = h('input', { type: 'checkbox', checked: faceFix, 'aria-label': 'Set up the face' }) as HTMLInputElement;
      cb.onchange = () => { faceFix = cb.checked; detailsOpen = true; void applyDraft().then(() => reportScreen()); };
      fixEls.push(h('label', { class: `dimp-fix ${faceFix ? '' : 'off'}` }, cb, h('div', null, h('b', null, 'Set up the face'), h('span', null, `${[...faceWhat.map((w) => `Adds ${w}`), ...faceKept].join('. ')}. Change it any time in Me → Face.`))));
    }
    if (p.needsRig && helper && blender !== false) {
      const cb = h('input', { type: 'checkbox', checked: wantRig, 'aria-label': 'Add a skeleton' }) as HTMLInputElement;
      cb.onchange = () => { wantRig = cb.checked; detailsOpen = true; reportScreen(); };
      fixEls.push(h('label', { class: `dimp-fix ${wantRig ? '' : 'off'}` }, cb, h('div', null, h('b', null, 'Add a skeleton with Blender after saving'), h('span', null, 'Headless Blender on your PC, low priority (the autorig). About a minute.'))));
    }
    const modelSel = p.models.length > 1 ? h('label', { class: 'dimp-field' }, h('span', null, `${p.models.length} models were in the drop. Use:`), h('select', { 'aria-label': 'Which model', onChange: (e: Event) => { choice = (e.target as HTMLSelectElement).value; detailsOpen = true; void check(++seq); } },
      ...p.models.map((m) => h('option', { value: m.path, selected: m.path === p.chosen }, m.path)))) : null;
    const details = h('details', { class: 'dimp-details', open: detailsOpen, onToggle: (e: Event) => { detailsOpen = (e.target as HTMLDetailsElement).open; } },
      h('summary', null, 'Details'),
      modelSel,
      h('h3', null, 'What we checked'), h('div', { class: 'dimp-lines' }, ...p.report.map(lineEl)),
      fixEls.length ? h('h3', null, 'Automatic fixes (untick to keep it as it was)') : null,
      fixEls.length ? h('div', { class: 'dimp-lines' }, ...fixEls) : null,
      p.notes ? h('h3', null, 'The author’s notes (check the terms of use)') : null,
      p.notes ? h('div', { class: 'dimp-notes' }, p.notes) : null,
      h('div', { class: 'dimp-row', style: 'margin-top:12px' }, button('Set it up step by step instead…', () => stepByStep()), button('Send this to support', () => void sendSupport(p))));
    const viewBtns = pv ? h('div', { class: 'dimp-row dimp-views', role: 'group', 'aria-label': 'Preview view' },
      ...([['Whole body', false], ['Face', true]] as const).map(([label, face]) => h('button', { class: `btn ${faceView === face ? 'on' : ''}`, 'aria-pressed': String(faceView === face), onClick: () => { faceView = face; view(); for (const b of viewBtns!.querySelectorAll('button')) { const on = (b.textContent === 'Face') === faceView; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); } } }, label))) : null;
    const side = h('div', { class: 'dimp-side' },
      pv ? pv.el : h('div', { class: 'dimp-prev-wait' }, 'No preview'),
      viewBtns,
      h('label', { class: 'dimp-field' }, h('span', null, 'Name'), nameIn));
    const worst = notes.some((n) => n.level === 'bad') ? 'bad' : notes.some((n) => n.level === 'warn') ? 'warn' : 'ok';
    const sub = worst === 'ok' ? 'It’s ready. Press Import to add it to your avatars.' : 'It works. One thing is limited, see below. Press Import to add it to your avatars.';
    paint(`${name || 'Your model'} is ready to import`, sub, [
      h('div', { class: 'dimp-cols' }, side, h('div', null,
        did.length ? h('h3', null, 'What we did') : null, did.length ? h('div', { class: 'dimp-lines' }, ...did) : null,
        noteEls.length ? h('h3', null, 'Good to know') : null, noteEls.length ? h('div', { class: 'dimp-lines' }, ...noteEls) : null,
        details)),
    ], [
      button(app.observer ? 'Import (off in the observer sandbox)' : 'Import', () => void save(), 'primary dimp-big', 'imp-save'),
      h('span', { class: 'grow' }),
      button('Cancel', close, 'ghost'),
    ]);
    if (app.observer) (foot.querySelector('.btn.primary') as HTMLButtonElement).disabled = true;
    requestAnimationFrame(() => view()); // the preview is in the page now: frame it for its real size
    if (!checked) { checked = true; const my = seq; requestAnimationFrame(() => void onePieceCheck(my)); }
  }

  async function sendSupport(p: Prepared | null) {
    const text = supportReport({ status: p?.status ?? 'error', title: p?.title ?? (errText || undefined), fix: p?.fix ?? (state.error ?? undefined), kind: p?.kind ?? null, facts: p?.facts ?? null, fbx: p?.fbx ?? null, models: p?.models.length ?? 0 });
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked: the page gets it in the URL */ }
    const url = `${REPORT_URL.replace(/\/choose$/, '')}?title=${encodeURIComponent('Model import problem')}&body=${encodeURIComponent(`${text}\n\n(What I tried to import, in my own words: )`)}`;
    window.open(url, '_blank', 'noopener');
    toast('The problem report (no file names, nothing personal) is on your clipboard and in the bug page that opened.', 'info', 9000);
  }

  function stepByStep() {
    const p = prepared;
    if (!p?.file) return;
    const file = new File([p.file.bytes.slice()], p.file.name);
    const seed: ProfilePatch = { ...(p.seed as ProfilePatch), name };
    close();
    void import('./modelWizard.ts').then((m) => m.openModelWizard(app, { file, seed, onDone: opts.onDone }));
  }

  // ---- 4. save
  async function save() {
    const p = prepared;
    if (!p?.file || app.observer) return;
    setPhase('saving');
    const step = (t: string) => paint('Importing…', name, [h('div', { class: 'dimp-busy', 'aria-live': 'polite' }, h('span', { class: 'dimp-spin' }), h('b', null, t))], []);
    try {
      // the picture first, while the preview is still on screen (a detached canvas draws nothing)
      let png: Blob | null = null;
      try { if (pv) { faceView = false; view(); png = await pv.thumbnail(); } } catch { /* the studio makes one later */ }
      step('Adding it to your avatars…');
      const file = new File([p.file.bytes.slice()], p.file.name);
      const base = await api.import(file, name || p.seed.name);
      const d = draft ?? normalizeProfile({ ...base });
      const out = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      for (const k of ['transform', 'eyes', 'mouth', 'brows', 'look', 'physics', 'faceMap', 'body'] as const) {
        const v = (d as unknown as Record<string, unknown>)[k];
        if (v !== undefined && v !== null) out[k] = JSON.parse(JSON.stringify(v));
      }
      // its own eyes kept / "Set up the face" unticked: saved as picked, so the studio's automatic face setup doesn't
      // draw generated eyes / a mouth over them after "Wear it now" (double eyes)
      keepImportFace(out as unknown as Pick<AvatarProfile, 'eyes' | 'mouth'>, { ownEyes: !!feats && feats.eyes !== 'none', optedOut: !faceFix && !!facePatch });
      out.name = name || base.name;
      out.rig = { ...base.rig, ...(d.rig.boneMap ? { boneMap: d.rig.boneMap } : {}), ...(d.rig.mechanical ? { mechanical: true } : {}), ...(rigPatch && d.rig.soft ? { kind: 'soft', soft: d.rig.soft } : {}) };
      saved = await api.save(out as unknown as AvatarProfile);
      step('Making its picture…');
      try {
        if (png) { await api.thumbnail(saved.id, png); thumbUrl = URL.createObjectURL(png); }
      } catch { /* the studio makes one later */ }
      state.savedId = saved.id;
      opts.onDone?.(saved.id);
      app.emit('library');
    } catch (e) {
      const msg = (e as Error).message;
      setPhase('report');
      errText = /\b503\b|helper/i.test(msg) ? 'Saving needs VTube Pro to be running. Start VTube Pro and try again.' : `We couldn’t save it: ${msg}`;
      state.error = errText;
      reportScreen();
      body.prepend(h('div', { class: 'dimp-callout bad' }, h('b', null, 'Not saved yet'), h('span', null, errText),
        h('div', { class: 'dimp-row' }, /VTube Pro to be running/i.test(errText) ? button('Open VTube Pro', () => void openHelper(), 'primary') : button('Try again', () => void save(), 'primary'))));
      return;
    }
    if (willRig()) startBetterRig();
    doneScreen();
  }

  /** Blender's autorig in the background (the import is already saved and moving with the soft rig): when it's done
   *  both rigs go through the pose sweep and the cleaner one stays, with Undo. */
  function startBetterRig() {
    if (!saved) return;
    const rt = pv?.rt;
    const soft: SoftRigConfig | null = joints?.soft ?? rt?.profile.rig.soft ?? saved.rig.soft ?? (rt ? guessSoftRig(rt.model) : null);
    if (!soft) return;
    void betterRig(app, { id: saved.id, name: saved.name, soft, modelFile: saved.modelFile, softScore, hadSoft: !!rigPatch, person: joints ? joints.source === 'pose' : undefined });
  }

  // ---- 5. done
  function doneScreen() {
    const p = prepared!;
    setPhase('done');
    const did = [...p.fixes.filter((x) => x.on && x.say).map((x) => x.say!), ...(rigPatch ? [softSay()] : []), ...faceKept, ...(faceFix && facePatch && faceWhat.length ? [`We gave it ${faceWhat.join(' and ')}.`] : [])];
    paint('Added to your avatars', null, [h('div', { class: 'dimp-done' },
      h('div', { class: 'okc', 'aria-hidden': 'true' }, '✓'),
      h('b', { style: 'font-size:17px' }, `${saved?.name ?? name} is in your avatars.`),
      thumbUrl ? h('img', { src: thumbUrl, alt: `${name}` }) : null,
      bg && saved && bg.id === saved.id ? bgBox(bg, () => startBetterRig()) : null,
      did.length ? h('div', { style: 'max-width:520px' }, h('h3', null, 'What we did'), h('ul', null, ...did.map((x) => h('li', null, x)))) : null,
      h('p', { class: 'dimp-note' }, 'It isn’t on your stream yet. Press “Wear it now” when you’re ready.'))],
    [
      button('Wear it now', () => { const id = saved?.id; close(); if (id) void app.loadAvatar(id).then(() => app.frameCamera()); }, 'primary dimp-big', 'imp-use'),
      button('Import another', () => { seq++; pv?.dispose(); pv = null; pickScreen(); }),
      h('span', { class: 'grow' }),
      button('Close', close, 'ghost'),
    ]);
  }

  // ---- refusals and other ends: what happened + exactly one next step
  function refuseScreen(p: Prepared) {
    setPhase('refuse');
    state.error = p.fix ?? null;
    paint('This can’t be imported', null, [
      h('div', { class: 'dimp-callout bad' }, h('b', null, p.title ?? 'This file can’t be used'), h('span', null, isPhone() && /RAR|7-Zip/.test(p.title ?? '') ? RAR_ON_PHONE : (p.fix ?? ''))),
      h('p', { class: 'dimp-note' }, isPhone() ? 'You can choose another file any time.' : 'You can drop another file here any time.'),
      p.facts ? h('details', { class: 'dimp-details' }, h('summary', null, 'Details'), h('div', { class: 'dimp-lines' }, ...p.report.map(lineEl))) : null,
    ], [button('Show me how', () => void openGuide(GUIDE, 'the Avatars guide'), 'primary dimp-big'), button('Send this to support', () => void sendSupport(p)), h('span', { class: 'grow' }), button('Close', close, 'ghost')]);
  }
  function needsScreen(p: Prepared) {
    setPhase('needs');
    const blenderMissing = p.status === 'needs-blender';
    paint(p.title ?? 'One more step', null, [
      h('div', { class: 'dimp-callout' }, h('b', null, p.title ?? ''), h('span', null, p.fix ?? '')),
      h('p', { class: 'dimp-note' }, 'VRM, GLB, glTF and MMD (.pmx) models open without it.'),
    ], [blenderMissing ? button('Install Blender (one click)', () => void installBlender(), 'primary dimp-big') : button('Open VTube Pro', () => void openHelper(), 'primary dimp-big'),
      button('Check again', () => { blender = null; void check(++seq); }), h('span', { class: 'grow' }), button('Close', close, 'ghost')]);
  }
  function route2dScreen(p: Prepared) {
    setPhase('route2d');
    const pictures = p.twoD?.what === 'image' || (rawFiles.length === 1 && /\.zip$/i.test(rawFiles[0].name) && p.twoD?.what !== 'psd');
    const go = twoD ?? (pictures ? (list: File[]) => void import('./flatPanel.ts').then((m) => m.openFlatImport(app, list)) : null);
    // a PNGTuber Plus / Remix / veadotube save or a VTube Studio file: its own screen (shared/modelImport/pngtuber/glue.ts, beta.16)
    const ui = { help: () => void openGuide(EXTRAS_HELP.pngtuber, 'the Stream extras guide'), importPictures: (list: File[]) => (go ?? ((l: File[]) => void import('./flatPanel.ts').then((m) => m.openFlatImport(app, l))))(list), toast, observer: app.observer };
    if (p.twoD?.what === 'pngtuber' || p.twoD?.what === 'vts') { const dropped = files; close(); void import('../../shared/modelImport/pngtuber/glue.ts').then((m) => m.openPngTuberImport(dropped, ui)); return; }
    if (files.some((f) => /\.vtube\.json$/i.test(f.path) || /\.zip$/i.test(f.path))) { const dropped = files; void import('../../shared/modelImport/pngtuber/glue.ts').then((m) => m.offerVtsRules(dropped, ui)).catch(() => { /* optional */ }); }
    // (a dropped folder keeps its inner paths: a Live2D model's textures sit in a sub-folder its model3.json names)
    if (go) { const list = rawPicked.map((p) => withPath(p.file, p.path)); close(); go(list); return; }
    paint(p.title ?? 'This is a 2D avatar', null, [
      h('div', { class: 'dimp-callout' }, h('b', null, '2D avatars (Pro2D, PNG) are coming in this release.'),
        h('span', null, 'This importer is for 3D models. Your 2D model will open in the 2D importer as soon as it’s in your version of VTube Pro.')),
    ], [button('Close', close, 'primary dimp-big')]);
  }
  function fail(msg: string) {
    setPhase('refuse');
    state.error = msg;
    errText = msg;
    paint('This couldn’t be opened', null, [h('div', { class: 'dimp-callout bad' }, h('b', null, 'Something went wrong while opening it'), h('span', null, msg)),
      h('p', { class: 'dimp-note' }, 'You can drop another file here any time.')],
    [button('Send this to support', () => void sendSupport(prepared), 'primary dimp-big'), button('Show me how', () => void openGuide(GUIDE, 'the Avatars guide')), h('span', { class: 'grow' }), button('Close', close, 'ghost')]);
  }
  async function installBlender() {
    try {
      const r = await fetch('/api/aiconnect/install-blender', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
      const j = await r.json().catch(() => ({}));
      toast(r.ok ? (j.next ?? 'Follow the installer window, then click “Check again”.') : (j.error ?? 'Couldn’t start the installer: download Blender from blender.org.'), r.ok ? 'info' : 'warn', 9000);
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  openDialog = { close, take };
  if (input?.length) take(normalizeInput(input)); else pickScreen();
}

// ---------------------------------------------------------------- the background Blender rig (survives the dialog)

interface BgRig { id: string; name: string; phase: 'running' | 'blender' | 'kept' | 'failed' | 'undone'; text: string; pct: number; undo?: () => Promise<void>; why?: string; scores?: { soft: number | null; blender: number | null; softPoses?: unknown; blenderPoses?: unknown } }
let bg: BgRig | null = null;
const bgListeners = new Set<() => void>();
function setBg(b: BgRig | null) {
  bg = b;
  (window as unknown as { __vtpDropImportRig?: unknown }).__vtpDropImportRig = b ? { id: b.id, phase: b.phase, text: b.text, why: b.why, scores: b.scores } : null;
  for (const f of bgListeners) f();
  paintBgNotice();
}

async function betterRig(app: App, o: { id: string; name: string; soft: SoftRigConfig; modelFile: string; softScore: RigScore | null; hadSoft: boolean; person?: boolean }) {
  const base: BgRig = { id: o.id, name: o.name, phase: 'running', text: 'Blender is building a more detailed skeleton in the background (about a minute). You can keep going.', pct: 0.03 };
  setBg(base);
  const t0 = performance.now();
  const backToSoft = async () => {
    const cur = await api.avatar(o.id);
    await api.save({ ...cur, modelFile: o.modelFile, rig: { ...cur.rig, kind: 'soft', soft: o.soft } });
    app.emit('library');
  };
  try {
    const { jobId } = await api.autorig(o.id, o.soft);
    const j = await waitJob(jobId, (x) => { if (bg?.id === o.id) setBg({ ...base, pct: Math.max(bg.pct, x.progress || Math.min(0.9, 1 - Math.exp(-(performance.now() - t0) / 45_000))) }); });
    if (j.status !== 'succeeded') throw new Error(j.error ?? 'Blender stopped');
    let prof = await api.avatar(o.id);
    // the new skeleton has humanoid names: an old bone matching no longer applies
    if (prof.rig.boneMap) { const { boneMap: _b, ...rest } = prof.rig; prof = await api.save({ ...prof, rig: rest }); }
    setBg({ ...base, pct: 0.95, text: 'Checking which skeleton moves better…' });
    let blenderScore: RigScore | null = null;
    try {
      const rt = await AvatarRuntime.load(normalizeProfile(prof), api.modelUrl(prof), new THREE.Group());
      try { blenderScore = poseSweep(rt); } finally { rt.dispose(); }
    } catch (e) { console.warn('[drop import] blender rig check', e); }
    const pick = o.hadSoft ? pickRig(o.softScore, blenderScore, { person: o.person }) : { use: 'blender' as const, why: '' };
    console.info('[drop import] rig choice', pick, { soft: o.softScore, blender: blenderScore });
    const judged = { why: pick.why, scores: { soft: o.softScore?.score ?? null, blender: blenderScore?.score ?? null, softPoses: o.softScore?.poses, blenderPoses: blenderScore?.poses } };
    if (pick.use === 'soft') {
      await backToSoft();
      setBg({ ...base, ...judged, phase: 'kept', pct: 1, text: 'We kept the simple skeleton: it moved more cleanly than Blender’s.' });
    } else {
      app.emit('library');
      setBg({ ...base, ...judged, phase: 'blender', pct: 1, text: o.hadSoft ? 'Better skeleton ready: now using it.' : 'Blender added a skeleton: head, body, arms and legs now follow you.',
        undo: o.hadSoft ? async () => { await backToSoft(); setBg({ ...base, phase: 'undone', pct: 1, text: 'Back to the simple skeleton.' }); } : undefined });
    }
  } catch (e) {
    console.warn('[drop import] autorig', e);
    setBg({ ...base, phase: 'failed', pct: 1, text: o.hadSoft ? 'Blender couldn’t build a better skeleton this time. Your model keeps its simple one.' : 'Blender couldn’t add a skeleton this time. Your model is saved and leans and nods with you.' });
  }
}

function bgBox(b: BgRig, retry?: () => void): HTMLElement {
  const running = b.phase === 'running';
  return h('div', { class: `dimp-callout ${b.phase === 'failed' ? 'bad' : running ? '' : 'ok'}`, style: 'max-width:520px;text-align:left', 'data-ui': 'drop-import-rig' } as never,
    h('span', null, b.text),
    running ? h('div', { class: 'dimp-bar', role: 'progressbar', 'aria-valuenow': String(Math.round(b.pct * 100)) } as never, h('i', { style: `width:${Math.round(b.pct * 100)}%` })) : null,
    b.undo ? h('div', { class: 'dimp-row' }, button('Undo', () => void b.undo!().catch((e) => toast((e as Error).message, 'warn')))) : null,
    b.phase === 'failed' && retry ? h('div', { class: 'dimp-row' }, button('Try again', retry, 'primary')) : null);
}

let noteTimer = 0;
/** The background rig's notice when the import dialog is closed (bottom right, Undo, goes away by itself). */
function paintBgNotice() {
  document.querySelector('.dimp-bgnote')?.remove();
  window.clearTimeout(noteTimer);
  if (!bg || openDialog) return;
  css();
  const b = bg;
  const el = h('div', { class: 'dimp-bgnote', role: 'status' }, h('button', { class: 'dimp-x', 'aria-label': 'Close', onClick: () => { el.remove(); if (b.phase !== 'running') bg = null; } }, '✕'), h('b', null, b.name), bgBox(b));
  document.body.append(el);
  if (b.phase !== 'running') noteTimer = window.setTimeout(() => { el.remove(); if (bg === b) bg = null; }, 25_000);
}

/** The file with its path inside the dropped folder as webkitRelativePath (what a folder picker gives), for the 2D importer. */
function withPath(f: File, rel: string): File {
  if (!rel.includes('/') || (f as File & { webkitRelativePath?: string }).webkitRelativePath) return f;
  try { Object.defineProperty(f, 'webkitRelativePath', { value: rel, configurable: true }); } catch { /* read-only here: the name alone */ }
  return f;
}

function normalizeInput(input: File[] | Picked[]): Picked[] {
  return (input as (File | Picked)[]).map((x) => (x instanceof File ? { path: x.name, file: x } : x));
}

/** An "Import a model…" button for any panel (UX lane: place it where people look for it). */
export function importModelButton(app: App, label = 'Import a model…', opts: DropImportOpts = {}): HTMLButtonElement {
  return button(label, () => openModelImport(app, null, opts), 'primary') as HTMLButtonElement;
}

// ---------------------------------------------------------------- the drop zone (anywhere on the studio)

let mounted = false;
/** Drop a model file / folder / zip anywhere on the page → the import dialog. Drops that another drop zone handles
 *  (outfits, rooms, reference pictures …) are left alone. Returns an unmount function. */
export function mountDropImport(app: App, opts: DropImportOpts = {}): () => void {
  if (mounted) return () => {};
  mounted = true;
  css();
  const over = h('div', { class: 'dimp-over', 'aria-hidden': 'true' }, h('div', null, h('b', null, 'Drop to import your model'), h('span', null, 'VRM, GLB, FBX, PMX, OBJ… a file, its folder or a .zip')));
  let depth = 0, shown = false;
  const isFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  const show = (on: boolean) => {
    if (on === shown) return;
    shown = on;
    if (on) { document.body.append(over); requestAnimationFrame(() => over.classList.add('on')); } else { over.classList.remove('on'); over.remove(); }
  };
  const free = () => !openDialog && !document.querySelector('.wiz-back');
  const enter = (e: DragEvent) => { if (isFiles(e)) depth++; };
  const leave = (e: DragEvent) => { if (!isFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) show(false); };
  // over another drop zone (outfits, rooms, pictures …) that zone's own handler has accepted the drag first: no overlay.
  // Anywhere else the overlay shows. A file dropped where nothing takes it must never make the browser open it (the
  // studio would navigate away, live).
  const dragover = (e: DragEvent) => {
    if (!isFiles(e)) return;
    if (e.defaultPrevented) { show(false); return; }
    e.preventDefault();
    show(free());
    if (e.dataTransfer) e.dataTransfer.dropEffect = free() || openDialog ? 'copy' : 'none';
  };
  const drop = (e: DragEvent) => {
    depth = 0; show(false);
    if (!isFiles(e) || e.defaultPrevented) return; // another drop zone took it
    e.preventDefault();
    if (document.querySelector('.wiz-back')) return; // a wizard is open: its own drop box is the place
    const dt = e.dataTransfer!;
    void entriesFromDrop(dt).then((l) => { if (l.length) openModelImport(app, l, opts); }).catch((er) => toast((er as Error).message, 'warn', 8000));
  };
  // test hooks (tools/model_import_e2e.mjs): open the dialog with files; the joint finder on given bytes (nothing saved)
  const w = window as unknown as Record<string, unknown>;
  w.__vtpOpenImport = (files?: File[]) => openModelImport(app, files?.length ? files : null, opts);
  w.__vtpRigLab = (bytes: ArrayBuffer) => findJoints(bytes, { picture: true });
  window.addEventListener('dragenter', enter);
  window.addEventListener('dragleave', leave);
  window.addEventListener('dragover', dragover);
  window.addEventListener('drop', drop);
  return () => {
    mounted = false;
    window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave);
    window.removeEventListener('dragover', dragover); window.removeEventListener('drop', drop);
    show(false);
  };
}
