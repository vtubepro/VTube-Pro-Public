// "Download a backup": the 2D avatar you're wearing as one file you keep (Pro2D .vtp2, or a .zip of your pictures).
// In the browser-only phone mode the model lives only in this browser, and Safari clears a site's files after 7 days without a visit
// unless the studio is on the Home Screen: a backup is how a phone user never loses their model. On a phone the share
// sheet opens (Save to Files / Photos / Drive), elsewhere it downloads.
import type { App } from '../app.ts';
import type { AvatarProfile } from '../../shared/types.ts';
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { button, h, toast } from '../ui/dom.ts';
import { isPhone } from './device.ts';

const libUrl = (id: string, rel: string) => `/library/${encodeURIComponent(id)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
const safeName = (s: string) => s.replace(/[^\w .-]+/g, '_').trim().slice(0, 60) || 'my-avatar';

/** The backup of avatar `id` (null = nothing to save). */
export async function makeBackup(id: string, name: string, kind: string, main: string): Promise<File | null> {
  if (kind === 'rig2d') {
    const r = await fetch(libUrl(id, main));
    if (!r.ok) return null;
    return new File([await r.blob()], `${safeName(name)}.vtp2`, { type: 'application/octet-stream' });
  }
  const lr = await fetch(`/api/avatars/${encodeURIComponent(id)}/files`);
  const list = lr.ok ? ((await lr.json()) as unknown[]).filter((f): f is string => typeof f === 'string' && f !== 'profile.json') : [main];
  const entries: Record<string, Uint8Array> = {};
  for (const f of list.slice(0, 600)) { const r = await fetch(libUrl(id, f)); if (r.ok) entries[f] = new Uint8Array(await r.arrayBuffer()); }
  if (!Object.keys(entries).length) return null;
  const z = zipSync(entries, { level: 0 });
  return new File([z.slice().buffer as ArrayBuffer], `${safeName(name)}.zip`, { type: 'application/zip' });
}

/** Hand a file to the user: the phone's share sheet when it takes files, else a download. */
export async function saveFile(f: File): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (isPhone() && nav.canShare?.({ files: [f] }) && navigator.share) {
    try { await navigator.share({ files: [f], title: f.name }); return 'shared'; }
    catch (e) { if ((e as DOMException)?.name === 'AbortError') return 'cancelled'; /* else: download below */ }
  }
  const u = URL.createObjectURL(f);
  const a = h('a', { href: u, download: f.name, style: 'display:none' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60_000);
  return 'downloaded';
}

/** Save one avatar's backup, saying what happened in one sentence. */
async function backupOne(p: AvatarProfile) {
  const c = p.flat!;
  try {
    const f = await makeBackup(p.id, p.name, c.kind, c.main);
    if (!f) { toast('There was nothing to save for this avatar.', 'warn'); return; }
    const how = await saveFile(f);
    if (how !== 'cancelled') toast(c.kind === 'rig2d' ? `Saved ${p.name}. To bring it back, choose this .vtp2 in Add my model.` : `Saved ${p.name}. To bring it back, choose this .zip in Add my model.`, 'ok', 6000);
  } catch (e) { toast(`The backup couldn’t be made: ${(e as Error).message}`, 'err'); }
}

/** The 2D panel's button (Me): a backup of ANY 2D avatar of yours (not only the one you're wearing). */
export function backupButton(app: App): HTMLElement | null {
  if (app.observer) return null;
  return button('Download a backup…', () => void (async () => {
    let list: AvatarProfile[] = [];
    try { list = ((await (await fetch('/api/avatars')).json()) as AvatarProfile[]).filter((p) => p.flat && p.source !== 'builtin'); } catch { list = []; }
    document.querySelector('.p2-backup-back')?.remove();
    const close = () => back.remove();
    const box = h('div', { class: 'flat-imp', role: 'dialog', 'aria-label': 'Download a backup' },
      h('h3', null, 'Download a backup'),
      h('p', null, list.length ? 'Keep a copy of your 2D avatar as one file. Choose it in Add my model to bring it back, on this or any other device.' : 'No 2D avatars of your own yet. Add one with Add my model.'),
      ...list.map((p) => h('div', { style: 'display:flex;gap:8px;align-items:center;justify-content:space-between;margin:6px 0' },
        h('span', null, p.name), button(p.flat!.kind === 'rig2d' ? 'Download (.vtp2)' : 'Download (.zip)', () => void backupOne(p)))),
      h('div', { class: 'btns' }, button('Close', close, 'primary')));
    const back = h('div', { class: 'flat-imp-back p2-backup-back', onClick: (e: Event) => { if (e.target === back) close(); } }, box);
    document.body.append(back);
  })());
}
