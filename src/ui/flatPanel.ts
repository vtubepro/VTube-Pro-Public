// 2D avatars in the studio — ONE entry point for the UX lane: flatPanel(app) returns the block for the Avatars tab:
//   * "Add a 2D avatar…" (pictures, a folder of pictures, GIFs, or a zip of a model folder for installed plug-in kinds)
//     → openFlatImport. Zero settings: roles come from file names or, unnamed, from how the pictures look
//     (shared/flatSimilarity.ts); whole body vs head-and-shoulders and its grounding are read from the picture at load;
//     the result is said in one sentence.
//   * "Make a 2D room from pictures…" → openFlat2dRoom (shared/flat2dRoom.ts);
//   * a 2D avatar is loaded: how it shows (one choice), "When I talk" (live animated tiles: src/ui/flatTalkTiles.ts),
//     expressions with their hotkeys, and everything else behind "More".
// Hotkeys: flatHotkey(e, app) (main.ts keydown: one line). Drops: flatDrop (panels.ts drop zone: one line).
// Docs: docs/FLAT_AVATARS.md.
import type { App } from '../app.ts';
import type { AvatarProfile } from '../../shared/types.ts';
import { FLAT_ANCHORS, voiceLevel, type FlatAnchor, type FlatAvatarConfig, type FlatDisplayMode, type FlatFraming, type FlatGrounding } from '../../shared/flatAvatar.ts';
import { FLAT_ACCEPT, FLAT_IMAGE_EXT, pictureRole } from '../../shared/flatImport.ts';
import { guessRoles, type PictureSample } from '../../shared/flatSimilarity.ts';
import { TV_SKINS } from '../../shared/tv.ts';
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { flatKinds } from '../avatar/flat/registry.ts';
import '../avatar/flat/kinds.ts';
import { button, color, h, section, select, slider, toast, toggle } from './dom.ts';
import { rig2dPanel } from './rig2dPanel.ts';
import { hiqTextureSection } from './hiqPanel.ts';
import { reservedKeyEvent } from '../../shared/studioKeys.ts';
import { clearFlatExpressions, expressionKeyChip, flatExpressionOn, rig2dSliderHotkey, toggleFlatExpression } from './rig2dSliders.ts';
import { TALK_TILE_CSS, talkPicker } from './flatTalkTiles.ts';
import { checkFlatUploadSize, pruneBigZip, skipForFlat } from './flatUploadPrep.ts';
import { isPhone, pickAccept } from '../mobile/device.ts';
import { backupButton } from '../mobile/backup.ts';
import { overlayStageSection } from './overlayStagePanel.ts';

const CSS = `
.flat2d .btns{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0}
.flat2d .meter{position:relative;height:10px;border-radius:5px;background:var(--card2,#222932);overflow:hidden;margin:4px 0 4px}
.flat2d .meter i{position:absolute;left:0;top:0;bottom:0;background:#7bd88f;border-radius:5px}
.flat2d .meter b{position:absolute;top:-2px;bottom:-2px;width:2px;background:#f5c451}
.flat2d .summary{margin:6px 0 10px;color:var(--dim,#9aa4af)}
.flat2d .keys{display:grid;grid-template-columns:1fr auto auto;gap:6px 10px;align-items:center;margin:6px 0}
.flat2d .keys kbd{font:600 12px/1.6 ui-monospace,monospace;padding:0 6px;border:1px solid var(--line,#2c343e);border-radius:5px;min-width:28px;text-align:center}
.flat2d .keys .on{color:#7bd88f}
.flat2d .more{margin-top:6px}
.flat-imp-back{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px}
.flat-imp{background:var(--card,#1a1f26);color:var(--text,#e6e8eb);border:1px solid var(--line,#2c343e);border-radius:14px;max-width:560px;width:100%;
 max-height:calc(100vh - 32px);overflow:auto;padding:18px 20px;box-shadow:0 20px 60px rgba(0,0,0,.45);font-size:14px;line-height:1.45}
.flat-imp h3{margin:0 0 8px;font-size:17px}.flat-imp ul{margin:8px 0;padding-left:18px}.flat-imp .btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.flat-imp .drop{border:2px dashed var(--line,#2c343e);border-radius:12px;padding:22px;text-align:center;cursor:pointer;margin:10px 0}
.flat-imp .drop.over{border-color:#7bd88f}
.flat-imp img.done{display:block;max-height:160px;margin:6px auto 10px}
${TALK_TILE_CSS}`;
let cssDone = false;
function css() { if (!cssDone) { cssDone = true; document.head.append(h('style', { id: 'vtp-flat-panel' }, CSS)); } }

const MODE_LABEL: [FlatDisplayMode, string][] = [
  ['card', 'Standing in the room'],
  ['overlay', 'Flat over the stream'],
  ['tv', 'On a walking TV'],
  ['screen', 'On a monitor at my spot'],
];
const ROLE_WORD: Record<string, string> = { idle: 'quiet', talk: 'talking', blink: 'blinking', talkBlink: 'talking with eyes closed' };
const isPicture = (f: File) => FLAT_IMAGE_EXT.some((e) => f.name.toLowerCase().endsWith(e));
const isZip = (f: File) => /\.zip$/i.test(f.name);

// ---------------------------------------------------------------- hotkeys
/** Studio keydown: a 2D avatar's expression / motion hotkey (no modifiers; not while typing). true = handled. */
export function flatHotkey(e: KeyboardEvent, app: App): boolean {
  if (reservedKeyEvent(e)) return false; // H / C / F, Shift+1-5, F1, Ctrl+K, browser keys …: the studio's, never a model's (shared/studioKeys.ts)
  if (rig2dSliderHotkey(e, app)) return true; // Pro2D model sliders / outfits on keys (src/ui/rig2dSliders.ts)
  const fl = app.runtime?.flat;
  if (!fl || e.ctrlKey || e.altKey || e.metaKey || e.repeat) return false;
  // (a number on the keypad or on the number row: either fires the expression — VTube Studio models save either)
  const num = (c: string | undefined) => /^(?:Digit|Numpad)([0-9])$/.exec(c ?? '')?.[1] ?? null;
  const ex = fl.expressions().find((x) => x.key === e.code) ?? (num(e.code) ? fl.expressions().find((x) => num(x.key) === num(e.code)) : undefined);
  if (ex) { e.preventDefault(); app.setFlatExpression(app.flatCue.s === ex.id ? null : ex.id); toast(app.flatCue.s ? `${ex.name}` : 'Default look', 'ok', 900); return true; }
  const mo = fl.motions().find((x) => x.key === e.code);
  if (mo) { e.preventDefault(); app.playFlatMotion(mo.group, mo.index); return true; }
  return false;
}

// ---------------------------------------------------------------- drops (files and folders)
type Entry = { isFile: boolean; isDirectory: boolean; name: string; fullPath: string; file?: (cb: (f: File) => void, err: (e: unknown) => void) => void; createReader?: () => { readEntries: (cb: (e: Entry[]) => void, err: (e: unknown) => void) => void } };
/** Every file of a drop, folders included (read recursively, at most 600 files). */
export async function filesFromDrop(dt: DataTransfer | null): Promise<File[]> {
  if (!dt) return [];
  const entries = [...dt.items ?? []].map((i) => (i.webkitGetAsEntry?.() ?? null) as unknown as Entry | null).filter((e): e is Entry => !!e);
  if (!entries.length) return [...dt.files];
  const out: File[] = [];
  const walk = async (e: Entry, depth: number): Promise<void> => {
    if (out.length >= 600 || depth > 6) return;
    // (files keep their path in the folder: a Live2D model's textures sit in a sub-folder its model3.json names, and
    //  several of them share a name; art sources / video never count toward the cap)
    if (e.isFile && e.file) { if (skipForFlat(e.fullPath)) return; const f = await new Promise<File | null>((res) => e.file!(res, () => res(null))); if (f) { const rel = e.fullPath.replace(/^\/+/, ''); if (rel.includes('/')) { try { Object.defineProperty(f, 'webkitRelativePath', { value: rel, configurable: true }); } catch { /* the name alone */ } } out.push(f); } return; }
    if (e.isDirectory && e.createReader) {
      const r = e.createReader();
      for (;;) {
        const batch = await new Promise<Entry[]>((res) => r.readEntries(res, () => res([])));
        if (!batch.length) break;
        for (const c of batch) await walk(c, depth + 1);
      }
    }
  };
  for (const e of entries) await walk(e, 0);
  return out;
}
/** The Avatars tab's model drop zone: pictures / a folder of pictures / a zip → the 2D import; anything else → `other`. */
export async function flatDrop(e: DragEvent, app: App, other: (f: File) => void) {
  const files = await filesFromDrop(e.dataTransfer);
  if (files.some((f) => isPicture(f) || isZip(f))) openFlatImport(app, files);
  else if (files[0]) other(files[0]);
}

// ---------------------------------------------------------------- import
/** Small grey thumbnails of the pictures (bottom-aligned, same size) for the look-alike role guess. */
export async function pictureSamples(files: File[]): Promise<PictureSample[]> {
  const W = 96, H = 120, out: PictureSample[] = [];
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  for (const f of files) {
    try {
      const b = await createImageBitmap(f);
      const k = Math.min(W / b.width, H / b.height);
      g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
      g.drawImage(b, (W - b.width * k) / 2, H - b.height * k, b.width * k, b.height * k);
      b.close();
      const d = g.getImageData(0, 0, W, H).data, v = new Float32Array(W * H);
      for (let i = 0; i < v.length; i++) v[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
      out.push({ name: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, w: W, h: H, value: v });
    } catch { /* not decodable here: the server says so */ }
  }
  c.width = c.height = 0;
  return out;
}

async function upload(files: File[], name: string): Promise<{ profile: AvatarProfile; warnings: string[]; roles: Record<string, string> }> {
  let body: Blob, filename: string;
  const pics = files.filter(isPicture);
  // pictures without a role in their name: work it out from how they look
  const unnamed = pics.filter((f) => !pictureRole(f.name));
  const roles = unnamed.length >= 2 && unnamed.length <= 4 && !files.some(isZip) ? guessRoles(await pictureSamples(unnamed)) : {};
  if (files.length === 1) { body = (await pruneBigZip(files[0])) ?? files[0]; filename = files[0].name; }
  else {
    const entries: Record<string, Uint8Array> = {};
    for (const f of files) { const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name; if (!skipForFlat(rel)) entries[rel] = new Uint8Array(await f.arrayBuffer()); }
    const z = zipSync(entries, { level: 0 });
    body = new Blob([z.slice().buffer as ArrayBuffer], { type: 'application/zip' }); filename = 'pictures.zip';
  }
  checkFlatUploadSize(body);
  const r = await fetch(`/api/avatars/import-flat?filename=${encodeURIComponent(filename)}&name=${encodeURIComponent(name)}&roles=${encodeURIComponent(JSON.stringify(roles))}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `${r.status}`);
  return j as { profile: AvatarProfile; warnings: string[]; roles: Record<string, string> };
}

function dialog(title: string, build: (box: HTMLElement, close: () => void) => void) {
  css();
  document.querySelector('.flat-imp-back')?.remove();
  const box = h('div', { class: 'flat-imp', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const back = h('div', { class: 'flat-imp-back', onClick: (e: Event) => { if (e.target === back) close(); } }, box);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const close = () => { back.remove(); window.removeEventListener('keydown', onKey, true); };
  window.addEventListener('keydown', onKey, true);
  document.body.append(back);
  build(box, close);
}

function pickZone(accept: string, onFiles: (f: File[]) => void, text: string) {
  const input = h('input', { type: 'file', accept, multiple: true, style: 'display:none' });
  const zone = h('div', { class: 'drop', tabindex: '0', role: 'button' }, text);
  zone.onclick = () => input.click();
  zone.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
  input.onchange = () => { if (input.files?.length) onFiles([...input.files]); };
  zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('over'); };
  zone.ondragleave = () => zone.classList.remove('over');
  zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove('over'); void filesFromDrop(e.dataTransfer).then((f) => { if (f.length) onFiles(f); }); };
  return h('div', null, zone, input);
}

/** One plain sentence: what VTube Pro made of the pictures. */
function doneSentence(app: App, roles: Record<string, string>, kind?: string): string {
  const found = Object.keys(roles).map((r) => ROLE_WORD[r]).filter(Boolean);
  const fl = app.runtime?.flat;
  const how = fl ? (fl.framing === 'bust' ? 'It shows head and shoulders: on the seat when you sit, on a pedestal when you stand.' : 'It stands on the floor at your spot, like the other performers.') : '';
  // a rigged model (a converted Live2D / Inochi2D, a .vtp2) is not "a picture that hops": it moves with the face
  if (kind && kind !== 'png') return `It moves with you: its head, eyes, mouth and hair follow your face and voice by themselves. ${how}`.trim();
  const pics = found.length > 1 ? `Found your ${found.slice(0, -1).join(', ')} and ${found[found.length - 1]} pictures.` : 'Found your picture: it hops when you talk.';
  return `${pics} ${how}`.trim();
}

/** "Add a 2D avatar": pictures (named or not, GIFs welcome), a folder of them, or a zip. */
export function openFlatImport(app: App, files?: File[]) {
  dialog('Add a 2D avatar', (box, close) => {
    const others = flatKinds().filter((k) => k.kind !== 'png' && (k.available?.().ok ?? true)).map((k) => k.label);
    const run = async (fs: File[]) => {
      if (app.observer) { toast('Observer sandbox: imports are off here.', 'warn'); return; }
      box.replaceChildren(h('h3', null, 'Adding your 2D avatar…'), h('p', null, `${fs.length} file${fs.length > 1 ? 's' : ''}: working out which picture is which.`));
      try {
        const folder = ((fs[0] as File & { webkitRelativePath?: string }).webkitRelativePath || '').split('/')[0];
        // (loose files picked on a phone: the model's own name, not its texture's)
        const m3 = fs.find((f) => /\.model3\.json$/i.test(f.name))?.name.replace(/\.model3\.json$/i, '');
        const name = folder || m3 || (fs.length === 1 ? fs[0].name.replace(/\.[^.]+$/, '') : fs.find(isPicture)?.name.replace(/[_ -]?(idle|talk|open|closed|blink|\d+)?\.[^.]+$/i, '') || '2D avatar');
        const { profile, warnings, roles } = await upload(fs, name.slice(0, 40) || '2D avatar');
        await app.loadAvatar(profile.id);
        app.emit('library');
        const thumb = profile.thumbnail ? h('img', { class: 'done', src: `/library/${encodeURIComponent(profile.id)}/${encodeURIComponent(profile.thumbnail)}`, alt: '' }) : null;
        box.replaceChildren(h('h3', null, `${profile.name} is ready`), ...(thumb ? [thumb] : []),
          h('p', null, doneSentence(app, roles, (profile as { flat?: { kind?: string } }).flat?.kind)),
          ...(warnings.filter((w) => !/hops while you talk/.test(w)).length ? [h('ul', { class: 'note' }, ...warnings.filter((w) => !/hops while you talk/.test(w)).slice(0, 4).map((w) => h('li', null, w)))] : []),
          h('div', { class: 'btns' }, button('Done', close, 'primary')));
      } catch (e) {
        box.replaceChildren(h('h3', null, 'That didn’t work'), h('p', null, (e as Error).message),
          fs.some(isPicture) && !fs.some(isZip) && !fs.some((f) => /\.model3\.json$/i.test(f.name)) ? h('p', { class: 'note' }, 'Tip: drop two pictures of your character, one with the mouth closed and one with it open.') : '',
          h('div', { class: 'btns' }, button('Try again', () => { close(); openFlatImport(app); }, 'primary'), button('Close', close)));
      }
    };
    box.append(h('h3', null, 'Add a 2D avatar'),
      h('p', null, 'Drop pictures of your character: mouth closed and mouth open, and if you have them, eyes closed. A folder or a zip works too, and GIFs move.'),
      ...(others.length ? [h('p', { class: 'note' }, 'Moving from another 2D app? Drop its exported model folder or .zip too (.model3.json + .moc3, or .inx/.inp).')] : []),
      pickZone(pickAccept(FLAT_ACCEPT), (fs) => void run(fs), isPhone() ? 'Tap to choose your pictures, your model’s .zip, or all of its files' : 'Drop pictures or a folder here, or click to choose'),
      h('div', { class: 'btns' }, button('Cancel', close)));
    if (files?.length) void run(files);
  });
}

/** "Make a 2D room from pictures": layer pictures (far → near) + an optional ground picture. */
export function openFlat2dRoom(app: App) {
  dialog('Make a 2D room', (box, close) => {
    const nameIn = h('input', { type: 'text', placeholder: 'Room name', style: 'width:100%' }) as HTMLInputElement;
    let spots = 4;
    const run = async (fs: File[]) => {
      if (app.observer) { toast('Observer sandbox: rooms are not added here.', 'warn'); return; }
      box.replaceChildren(h('h3', null, 'Making your 2D room…'));
      try {
        const entries: Record<string, Uint8Array> = {};
        for (const f of fs) entries[f.name] = new Uint8Array(await f.arrayBuffer());
        const body = fs.length === 1 ? fs[0] : new Blob([zipSync(entries, { level: 0 }).slice().buffer as ArrayBuffer]);
        const r = await fetch(`/api/rooms/import-flat2d?name=${encodeURIComponent(nameIn.value.trim() || '2D room')}&spots=${spots}&filename=${encodeURIComponent(fs[0].name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body });
        const j = await r.json().catch(() => ({})) as { error?: string; name?: string; layers?: number };
        if (!r.ok) throw new Error(j.error ?? `${r.status}`);
        box.replaceChildren(h('h3', null, `${j.name} is ready`), h('p', null, `${j.layers} layer${j.layers === 1 ? '' : 's'}. Pick it in Scene → Rooms; your 2D (or 3D) avatar stands in front of the layers.`),
          h('div', { class: 'btns' }, button('Done', close, 'primary')));
      } catch (e) {
        box.replaceChildren(h('h3', null, 'That didn’t work'), h('p', null, (e as Error).message), h('div', { class: 'btns' }, button('Close', close, 'primary')));
      }
    };
    box.append(h('h3', null, 'Make a 2D room'),
      h('p', null, 'Layer pictures make a flat stage with depth: the far ones move less than the near ones when the camera moves.'),
      h('ul', null, h('li', null, 'Number them from far to near: 1_sky.png, 2_mountains.png, 3_trees.png'), h('li', null, 'Transparent PNG / WebP for every layer but the farthest'),
        h('li', null, 'ground.png (optional): tiled under everyone; clouds.png scrolls')),
      nameIn,
      select('Places to stand', '4', [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['6', '6'], ['8', '8']], (v) => { spots = +v; }),
      pickZone('.png,.webp,.jpg,.jpeg,.zip', (fs) => void run(fs), 'Drop your layer pictures (or a .zip) here, or click to choose'),
      h('div', { class: 'btns' }, button('Cancel', close)));
  });
}

// ---------------------------------------------------------------- the panel
function flatEdit(app: App, fn: (c: FlatAvatarConfig) => void, rebuild = true) {
  app.edit((p) => { if (p.flat) fn(p.flat); }, rebuild);
}
let moreOpen = false;

/** How the card is shown, in words (the summary line). */
function framingWords(app: App): string {
  const fl = app.runtime?.flat, c = app.profile?.flat?.display.card;
  if (!fl || !c) return '';
  if (fl.mode !== 'card') return '';
  const auto = c.framing === 'auto' ? ' (found automatically)' : '';
  if (fl.framing === 'full') return `Whole body${auto}: it stands on the floor at your spot.`;
  const g = c.grounding;
  const where = g === 'fade' ? 'its bottom edge fades out' : g === 'none' ? 'shown as is' : g === 'pedestal' ? 'on a pedestal' : 'on the seat when you sit, on a pedestal when you stand';
  return `Head and shoulders${auto}: ${where}.`;
}

/** The Avatars-tab block: add buttons + (a 2D avatar is loaded) its options. */
export function flatPanel(app: App): HTMLElement {
  css();
  const root = h('div', { class: 'flat2d' });
  root.append(h('div', { class: 'btns' },
    button('Add a 2D avatar (PNG / GIF)…', () => openFlatImport(app)),
    button('Make a 2D room…', () => openFlat2dRoom(app)), backupButton(app)));
  const p = app.profile, fl = app.runtime?.flat;
  const c = p?.flat;
  if (!p || !c || !fl) return root;
  const d = c.display;

  // ---- the essentials
  const meterBar = h('i'), meterMark = h('b', { style: `left:${(c.png?.gate.threshold ?? 0.16) * 100}%` });
  const state = h('span', { class: 'note' }, '');
  const tick = () => {
    if (!root.isConnected) return;
    meterBar.style.width = `${Math.round(voiceLevel(app.frame) * 100)}%`;
    const st = (fl.source as unknown as { state?: { picture?: string } }).state;
    state.textContent = `${fl.talking ? 'Talking' : 'Quiet'}${st?.picture ? ` · ${st.picture}` : ''}`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  root.append(section('2D avatar',
    select('Show it', d.mode, MODE_LABEL, (v) => flatEdit(app, (x) => { x.display.mode = v; })),
    h('p', { class: 'summary' }, framingWords(app)),
    h('div', { class: 'meter', title: 'Your voice now; the yellow line is where talking starts' }, meterBar, meterMark), state));
  const ov = overlayStageSection(app); if (ov) root.append(ov); // 2.5D overlay around me: scenery behind, desk in front (src/ui/overlayStagePanel.ts)
  root.append(section('When I talk', talkPicker(app)));
  const rig = rig2dPanel(app); if (rig) root.append(rig); // 2D rigs / converted Live2D models: mouth, head, physics (src/ui/rig2dPanel.ts)
  const hq = hiqTextureSection(app); if (hq) root.append(hq); // 2D rigs: picture quality / compressed textures (src/ui/hiqPanel.ts)

  const exprs = fl.expressions(), motions = fl.motions();
  if (exprs.length || motions.length) {
    const grid = h('div', { class: 'keys' });
    // (Pro2D models: expressions toggle and stack like VTube Studio's — src/ui/rig2dSliders.ts; picture avatars: one at a time)
    const stack = fl.source.kind === 'rig2d';
    const isOn = (id: string) => (stack ? flatExpressionOn(app, id) : app.flatCue.s === id);
    const paint = () => {
      grid.replaceChildren(
        h('span', { class: (app.flatCue.s ?? null) === null && !app.flatCue.x?.length ? 'on' : '' }, 'Default look'), h('kbd', null, '–'), button('Show', () => { if (stack) clearFlatExpressions(app); else app.setFlatExpression(null); paint(); }),
        ...fl.expressions().flatMap((x) => [h('span', { class: isOn(x.id) ? 'on' : '' }, x.name), stack ? expressionKeyChip(app, x, paint) : h('kbd', null, x.key?.replace(/^(Key|Digit)/, '') ?? '–'),
          button(isOn(x.id) ? 'Hide' : 'Show', () => { if (stack) toggleFlatExpression(app, x.id); else app.setFlatExpression(app.flatCue.s === x.id ? null : x.id); paint(); })]),
        ...motions.flatMap((m) => [h('span', null, m.name), h('kbd', null, m.key?.replace(/^(Key|Digit)/, '') ?? '–'), button('Play', () => app.playFlatMotion(m.group, m.index))]));
    };
    paint();
    root.append(section('Expressions', grid, h('p', { class: 'note' }, stack ? 'Press a key in the studio to switch that one on, again to switch it off; several can be on together (like VTube Studio). OBS and party guests see the same.'
      : 'Press the key in the studio to switch; press it again for the default look. OBS and party guests see the same.')));
  }

  // ---- More: everything else
  const more = h('div', { class: 'more', style: moreOpen ? '' : 'display:none' });
  const moreBtn = button(moreOpen ? 'Fewer options' : 'More…', () => { moreOpen = !moreOpen; more.style.display = moreOpen ? '' : 'none'; moreBtn.textContent = moreOpen ? 'Fewer options' : 'More…'; });
  root.append(h('div', { class: 'btns' }, moreBtn), more);
  const card: (Node | null)[] = [];
  if (d.mode === 'card') card.push(
    select<FlatFraming>('Picture shows', d.card.framing, [['auto', `Find out from the picture (${fl.framing === 'bust' ? 'head and shoulders' : 'whole body'})`], ['full', 'Whole body'], ['bust', 'Head and shoulders']], (v) => flatEdit(app, (x) => { x.display.card.framing = v; })),
    fl.framing === 'bust' ? select<FlatGrounding>('Head and shoulders', d.card.grounding, [['auto', 'On the seat or a pedestal'], ['pedestal', 'Always on a pedestal'], ['fade', 'Bottom fades out'], ['none', 'As it is']], (v) => flatEdit(app, (x) => { x.display.card.grounding = v; })) : null,
    fl.framing === 'bust' ? color('Pedestal colour', d.card.pedestalColor, (v) => flatEdit(app, (x) => { x.display.card.pedestalColor = v; })) : null,
    select('Facing', d.card.facing, [['camera', 'Turns to every camera'], ['fixed', 'Faces the front of my spot']], (v) => flatEdit(app, (x) => { x.display.card.facing = v; })),
    slider('Outline', d.card.outline, 0, 1, 0.05, (v) => flatEdit(app, (x) => { x.display.card.outline = v; })),
    color('Outline colour', d.card.outlineColor, (v) => flatEdit(app, (x) => { x.display.card.outlineColor = v; })),
    slider('Drop shadow', d.card.shadow, 0, 1, 0.05, (v) => flatEdit(app, (x) => { x.display.card.shadow = v; })),
    slider('Room light', d.card.tint, 0, 1, 0.05, (v) => flatEdit(app, (x) => { x.display.card.tint = v; }), 'How much the room’s lights colour the picture'),
    fl.framing === 'full' ? toggle('Shadow on the floor', d.card.ground, (v) => flatEdit(app, (x) => { x.display.card.ground = v; })) : null,
  );
  if (d.mode === 'overlay') card.push(
    select('Corner', d.overlay.anchor, FLAT_ANCHORS.map((a): [FlatAnchor, string] => [a, a.replace('-', ' ')]), (v) => flatEdit(app, (x) => { x.display.overlay.anchor = v; })),
    slider('Size', d.overlay.scale, 0.1, 1.2, 0.01, (v) => flatEdit(app, (x) => { x.display.overlay.scale = v; })),
    slider('Left / right', d.overlay.x, -0.5, 0.5, 0.01, (v) => flatEdit(app, (x) => { x.display.overlay.x = v; })),
    slider('Up / down', d.overlay.y, -0.5, 0.5, 0.01, (v) => flatEdit(app, (x) => { x.display.overlay.y = v; })),
    toggle('Mirror', d.overlay.flip, (v) => flatEdit(app, (x) => { x.display.overlay.flip = v; })),
  );
  if (d.mode === 'tv' || d.mode === 'screen') card.push(
    d.mode === 'tv' ? select('TV', d.tv.skin || TV_SKINS[0].id, TV_SKINS.map((s): [string, string] => [s.id, s.name]), (v) => flatEdit(app, (x) => { x.display.tv.skin = v; })) : null,
    color('Screen background', d.tv.backdrop === 'none' ? '#05070a' : d.tv.backdrop, (v) => flatEdit(app, (x) => { x.display.tv.backdrop = v; })),
  );
  more.append(section('How it looks', ...card.filter((x): x is Node => !!x)));
  if (c.png) {
    const g = c.png;
    more.append(section('Talking and blinking',
      slider('Talk switch at', g.gate.threshold, 0.02, 0.8, 0.01, (v) => { meterMark.style.left = `${v * 100}%`; flatEdit(app, (x) => { x.png!.gate.threshold = v; }, false); }, 'Voice level that counts as talking'),
      slider('Hold (s)', g.gate.hold, 0, 1, 0.01, (v) => flatEdit(app, (x) => { x.png!.gate.hold = v; }, false), 'Keeps the talking picture through short pauses'),
      slider('Delay (s)', g.gate.attack, 0, 0.3, 0.01, (v) => flatEdit(app, (x) => { x.png!.gate.attack = v; }, false), 'Voice needed this long before it switches (ignores clicks)'),
      slider('Blink every (s)', g.blinkTimer.every, 1, 12, 0.5, (v) => flatEdit(app, (x) => { x.png!.blinkTimer.every = v; }, false), 'When the camera is off (with the camera on, your own blinks show)'),
      slider('Head tilt', g.follow.tilt, 0, 2, 0.05, (v) => flatEdit(app, (x) => { x.png!.follow.tilt = v; }, false), 'Follows your head with the camera on'),
      slider('Sway', g.follow.sway, 0, 2, 0.05, (v) => flatEdit(app, (x) => { x.png!.follow.sway = v; }, false)),
      toggle('Pixel art (sharp pixels)', g.pixelated, (v) => flatEdit(app, (x) => { x.png!.pixelated = v; }))));
  }
  return root;
}
