// The studio side of "Bring your PNGTuber over": the screen shown when a PNGTuber save / VTube Studio file is dropped.
// Browser-only and self-contained (no studio imports): src/ui/dropImport.ts loads it on demand and hands over what it
// needs (`deps`), so a studio that never sees one of these files never loads it. Plain words, one main button.
import type { DroppedFile } from '../files.ts';
import { convertPngTuberDrop, type ImportedLook, type PngTuberImport } from './index.ts';
import type { Raster } from './png.ts';

export interface PngTuberUiDeps {
  /** Hand the named pictures to the 2D-avatar importer (the PNGTuber picture-set import). */
  importPictures(files: File[]): void;
  toast?(msg: string, kind?: 'ok' | 'warn' | 'info' | 'err', ms?: number): void;
  /** The read-only observer studio: nothing is saved there. */
  observer?: boolean;
  /** Open the Help guide for this screen (the "How it works" button). */
  help?(): void;
}

const CSS = `
.pngt-back{position:fixed;inset:0;z-index:61;background:#05070bb8;backdrop-filter:blur(3px);display:grid;place-items:center;padding:16px}
.pngt{position:relative;width:min(760px,100%);max-height:calc(100vh - 32px);display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:var(--panel,#161920);color:var(--text,#eef1f6);border:1px solid var(--line2,#333a4a);border-radius:16px;box-shadow:0 24px 80px #000a;font-size:13.5px;line-height:1.45;overflow:hidden}
.pngt>header{padding:16px 54px 10px 20px;border-bottom:1px solid var(--line,#262b37)}
.pngt>header h2{margin:0;font-size:18px}.pngt>header p{margin:2px 0 0;color:var(--dim,#a3abba);font-size:12.5px}
.pngt .x{position:absolute;top:10px;right:10px;width:34px;height:34px;border-radius:9px;border:1px solid var(--line2,#333a4a);background:var(--card,#1b1f28);color:inherit;font-size:16px;cursor:pointer}
.pngt .body{overflow:auto;padding:14px 20px;display:grid;gap:12px;grid-auto-rows:max-content;align-content:start}
.pngt .foot{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px 20px;border-top:1px solid var(--line,#262b37);background:var(--bg2,#13161d)}
.pngt .foot .grow{flex:1}
.pngt button.b{min-height:38px;padding:0 16px;border-radius:10px;border:1px solid var(--line2,#333a4a);background:var(--card,#1b1f28);color:inherit;font:inherit;cursor:pointer}
.pngt button.b.primary{background:var(--accent,#7bd88f);color:var(--accent-ink,#08130b);border-color:transparent;font-weight:700}
.pngt button.b:focus-visible{outline:2px solid var(--accent2,#6cc7f5);outline-offset:2px}
.pngt .looks{display:flex;gap:10px;overflow:auto;padding-bottom:4px}
.pngt .look{flex:0 0 132px;display:grid;gap:4px;justify-items:center;text-align:center;padding:8px;border-radius:12px;background:var(--card,#1b1f28);border:1px solid var(--line,#262b37)}
.pngt .look .pic{width:112px;height:140px;border-radius:8px;background:repeating-conic-gradient(#2a2f3a 0 25%,#222733 0 50%) 0 0/16px 16px;display:grid;place-items:center;overflow:hidden}
.pngt .look img{max-width:100%;max-height:100%;object-fit:contain}
.pngt .look b{font-size:13px}.pngt .look span{color:var(--dim,#a3abba);font-size:12px}
.pngt kbd{font:600 12px/1.5 ui-monospace,monospace;padding:0 6px;border:1px solid var(--line2,#333a4a);border-radius:5px}
.pngt ul{margin:0;padding-left:18px;color:var(--dim,#a3abba)}
.pngt .box{border:1px solid var(--line,#262b37);border-radius:12px;padding:10px 12px;background:var(--card,#1b1f28);display:grid;gap:6px}
.pngt .box.warn{border-color:color-mix(in srgb,var(--warn,#ffb454) 55%,transparent)}
.pngt .box.bad{border-color:color-mix(in srgb,var(--err,#ff6b6b) 55%,transparent)}
.pngt summary{cursor:pointer;color:var(--accent2,#6cc7f5);font-weight:600;width:max-content}
.pngt-card{position:fixed;right:16px;bottom:16px;z-index:60;width:min(380px,calc(100vw - 32px));background:var(--panel,#161920);color:var(--text,#eef1f6);border:1px solid var(--line2,#333a4a);border-radius:14px;box-shadow:0 12px 40px #0009;padding:12px 14px;font-size:13px;display:grid;gap:8px}
.pngt-card .row{display:flex;gap:8px;flex-wrap:wrap}
`;

type K = Record<string, string | ((e: Event) => void) | boolean | undefined>;
function el<T extends HTMLElement = HTMLElement>(tag: string, attrs: K | null, ...kids: (Node | string | null | undefined | false)[]): T {
  const e = document.createElement(tag) as T;
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c) e.append(c);
  return e;
}
const css = () => { if (!document.getElementById('pngt-css')) document.head.append(el('style', { id: 'pngt-css' }, CSS)); };
const btn = (text: string, on: () => void, cls = '') => el('button', { type: 'button', class: `b ${cls}`.trim(), onClick: () => on() }, text);

/** Pictures that aren't PNG (a JPEG / WebP layer) are decoded by the browser. */
async function canvasDecode(bytes: Uint8Array): Promise<Raster | null> {
  try {
    const bmp = await createImageBitmap(new Blob([bytes.slice().buffer as ArrayBuffer]));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(bmp, 0, 0); bmp.close();
    const d = g.getImageData(0, 0, c.width, c.height);
    c.width = c.height = 0;
    return { w: d.width, h: d.height, data: new Uint8Array(d.data.buffer.slice(0)) };
  } catch { return null; }
}

const mime = (n: string) => (/\.png$/i.test(n) ? 'image/png' : /\.gif$/i.test(n) ? 'image/gif' : /\.webp$/i.test(n) ? 'image/webp' : 'image/jpeg');
function toFile(f: DroppedFile): File {
  const name = f.path.split('/').pop() ?? f.path;
  const file = new File([f.bytes.slice().buffer as ArrayBuffer], name, { type: mime(name) });
  try { Object.defineProperty(file, 'webkitRelativePath', { value: f.path, configurable: true }); } catch { /* the name alone */ }
  return file;
}
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = el<HTMLAnchorElement>('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const APP: Record<string, string> = { plus: 'PNGTuber Plus', remix: 'PNGTuber Remix', veadotube: 'veadotube' };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function lookCard(l: ImportedLook, urls: string[]): HTMLElement {
  const url = URL.createObjectURL(new Blob([l.preview.bytes.slice().buffer as ArrayBuffer], { type: mime(`x.${l.preview.ext}`) }));
  urls.push(url);
  const traits = [l.roles.includes('talk') ? 'talks' : '', l.roles.includes('blink') ? 'blinks' : ''].filter(Boolean).join(' · ');
  return el('div', { class: 'look' },
    el('div', { class: 'pic' }, el('img', { src: url, alt: l.name })),
    el('b', null, l.name),
    el('span', null, l.key ? el('span', null, 'Press ', el('kbd', null, l.key)) : 'Your normal look'),
    traits ? el('span', null, traits) : null);
}

function rulesBox(r: NonNullable<PngTuberImport['rules']>, file: string | null, deps: PngTuberUiDeps): HTMLElement {
  const made = r.rules.length;
  return el('div', { class: 'box' },
    el('b', null, made ? `Your VTube Studio hotkeys: ${plural(made, 'reaction')} ready to review` : 'Your VTube Studio hotkeys'),
    made ? el('ul', null, ...r.rules.slice(0, 8).map((x) => el('li', null, x.name)), made > 8 ? el('li', null, `and ${made - 8} more`) : null) : el('span', null, 'None of its hotkeys has a matching reaction yet.'),
    ...r.notes.map((n) => el('span', null, n)),
    r.skipped.length ? el('details', null, el('summary', null, `${plural(r.skipped.length, 'hotkey')} not brought over`), el('ul', null, ...r.skipped.slice(0, 20).map((s) => el('li', null, `${s.name}: ${s.why}`)))) : null,
    made && file ? el('div', null, btn('Save my reactions file', () => { download('vtube-studio.vtprules.json', file); deps.toast?.('Saved. In Rules, choose Import and pick that file. Everything in it starts switched off.', 'ok', 9000); })) : null);
}

/** The drop screen for a PNGTuber save and / or a VTube Studio model file. */
export async function openPngTuberImport(files: DroppedFile[], deps: PngTuberUiDeps): Promise<void> {
  css();
  document.querySelector('.pngt-back')?.remove();
  const urls: string[] = [];
  const body = el('div', { class: 'body', 'aria-live': 'polite' }), foot = el('div', { class: 'foot' });
  const head = el('header', null, el('h2', null, 'Bringing your PNGTuber over…'), el('p', null, 'Reading what you dropped.'));
  const box = el('div', { class: 'pngt', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Bring your PNGTuber over' },
    el('button', { type: 'button', class: 'x', 'aria-label': 'Close', title: 'Close (Esc)', onClick: () => close() }, '✕'), head, body, foot);
  const back = el('div', { class: 'pngt-back', onClick: (e) => { if (e.target === back) close(); } }, box);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const close = () => { back.remove(); window.removeEventListener('keydown', onKey, true); for (const u of urls.splice(0)) URL.revokeObjectURL(u); };
  window.addEventListener('keydown', onKey, true);
  document.body.append(back);
  body.append(el('p', null, 'This takes a few seconds for a big save.'));
  foot.append(el('span', { class: 'grow' }), btn('Cancel', close));

  let r: PngTuberImport;
  try { r = await convertPngTuberDrop(files, { decodeImage: canvasDecode }); }
  catch (e) { r = { avatar: null, rules: null, rulesFile: null, warnings: [], notes: [], problem: `Something went wrong while reading it: ${(e as Error).message}` }; }
  if (!back.isConnected) return;

  body.replaceChildren(); foot.replaceChildren();
  const a = r.avatar;
  if (a) {
    head.replaceChildren(el('h2', null, `${a.name} is ready to bring over`), el('p', null, `From ${APP[a.source] ?? 'your PNGTuber app'}: ${plural(a.looks.length, 'look')}.`));
    body.append(el('div', { class: 'looks' }, ...a.looks.map((l) => lookCard(l, urls))));
    const first = a.looks[0];
    body.append(el('ul', null,
      el('li', null, first.roles.includes('talk') ? 'The mouth opens when you talk.' : 'It has no mouth-open picture, so it hops a little when you talk.'),
      el('li', null, first.roles.includes('blink') ? 'It blinks.' : 'It has no blink picture.'),
      a.looks.length > 1 ? el('li', null, 'Press the number key shown under a look to switch to it in the studio.') : null));
    if (r.warnings.length || r.notes.length) body.append(el('details', null, el('summary', null, 'Things to check'), el('ul', null, ...[...r.warnings, ...r.notes].slice(0, 8).map((w) => el('li', null, w)))));
  } else {
    head.replaceChildren(el('h2', null, r.rules ? 'Your VTube Studio hotkeys' : 'This couldn’t be brought over'), el('p', null, r.rules ? 'They can become reactions: when a key or a Twitch event happens, your avatar does something.' : ''));
  }
  if (r.problem && !a) body.append(el('div', { class: 'box bad' }, el('b', null, r.problem)));
  if (r.rules) body.append(rulesBox(r.rules, r.rulesFile, deps));
  const add = a ? btn('Add to my avatars', () => {
    if (deps.observer) { deps.toast?.('Observer sandbox: imports are off here.', 'warn'); return; }
    const list = a.files.map(toFile);
    close();
    deps.importPictures(list);
  }, 'primary') : null;
  if (add) foot.append(add);
  if (deps.help) foot.append(btn('How it works', () => deps.help!()));
  foot.append(el('span', { class: 'grow' }), btn('Close', close));
  (add ?? foot.querySelector('button'))?.focus();
}

/** A drop that already goes somewhere else (a Live2D model, pictures) but also holds a VTube Studio file: offer its
 *  hotkeys as reactions, in a small card that never blocks the import. Nothing shows when there is nothing to offer. */
export async function offerVtsRules(files: DroppedFile[], deps: PngTuberUiDeps): Promise<void> {
  if (deps.observer) return;
  let r: PngTuberImport;
  try { r = await convertPngTuberDrop(files, { decodeImage: canvasDecode }); } catch { return; }
  if (!r.rules?.rules.length || !r.rulesFile) return;
  css();
  document.querySelector('.pngt-card')?.remove();
  const file = r.rulesFile, n = r.rules.rules.length;
  const card = el('div', { class: 'pngt-card', role: 'status', 'aria-live': 'polite' },
    el('b', null, `Your VTube Studio hotkeys can be ${plural(n, 'reaction')}`),
    el('span', null, 'When a key or a Twitch event happens, your avatar can react. They all start switched off.'),
    el('div', { class: 'row' },
      btn('Save my reactions file', () => { download('vtube-studio.vtprules.json', file); deps.toast?.('Saved. In Rules, choose Import and pick that file.', 'ok', 9000); card.remove(); }, 'primary'),
      btn('Not now', () => card.remove())));
  document.body.append(card);
}
