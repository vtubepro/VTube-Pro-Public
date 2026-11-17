// Delete an avatar from "Me" (too many iterations): each own avatar gets a quiet ⋯ menu → "Delete…", an in-page box
// where the user types CONFIRM, then an Undo toast (~10 s) and a "Recently deleted" list for this tab's session.
//   - only what VTube Pro ships (the server says: `shipped`) has no Delete at all (src/ui/avatarDeleteRules.ts; the server
//     refuses it too: 403). An avatar whose file merely says "builtin" is the user's own: Delete shows.
//   - never the avatar on screen (what OBS shows) or the chat buddy: "Switch to another avatar first"
//   - the server moves the folder to library/.trash (server/library.ts trashAvatar); Undo = POST /api/avatars/:id/restore.
// Hooks (one line each): src/ui/simple.ts me() (avatarTileMenu + recentlyDeletedLine), src/ui/panels.ts avatars()
// (avatarCardMenu replaces the old ✕ + window.confirm).
import type { App } from '../app.ts';
import type { AvatarProfile } from '../../shared/types.ts';
import { api } from '../api.ts';
import { h, toast } from './dom.ts';
import { buddyModelOf } from '../../shared/chat.ts';
import { CONFIRM_WORD, addDeleted, confirmMatches, deleteErrorText, deleteVerdict, isProtectedAvatar, restoreOutcome, restoreText,
  sanitizeDeleted, trashNameOf, type DeletedEntry, type InUse } from './avatarDeleteRules.ts';

const CSS = `
.avd-wrap { position: relative; display: flex; min-width: 0; }
.avd-wrap > .s-tile { flex: 1; min-width: 0; }
.avd-wrap > .s-tile .nm { padding-right: 30px; }
.avd-more { position: absolute; right: 4px; bottom: 4px; width: 26px; height: 24px; border-radius: 8px; border: 1px solid transparent; background: transparent;
  color: var(--dim); font: 700 15px/1 system-ui, sans-serif; letter-spacing: 1px; cursor: pointer; display: grid; place-items: center; padding: 0; opacity: .55; }
.avd-more:hover, .avd-more:focus-visible, .avd-more[aria-expanded=true] { opacity: 1; background: var(--card3); border-color: var(--line2); color: var(--text); }
.avd-wrap:hover .avd-more { opacity: .9; }
@media (hover: none) { .avd-more { opacity: .9; } }
.card .avd-more.x { position: absolute; top: 4px; right: 4px; bottom: auto; width: auto; height: auto; padding: 2px 7px; background: #0009; color: #ddd; border: 0; opacity: 1; }
@media (hover: none) { .card .avd-more.x { display: block; } }
.card .avd-more.x:focus-visible { display: block; }
.avd-menu { position: fixed; z-index: 880; min-width: 200px; max-width: min(280px, calc(100vw - 16px)); background: var(--card); color: var(--text); border: 1px solid var(--line2);
  border-radius: 12px; box-shadow: var(--shadow); padding: 5px; display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.avd-menu button { all: unset; box-sizing: border-box; display: block; width: 100%; padding: 8px 10px; border-radius: 8px; cursor: pointer; line-height: 1.3; }
.avd-menu button:hover:not([aria-disabled=true]), .avd-menu button:focus-visible { background: var(--card2); outline: none; }
.avd-menu button.danger { color: var(--err); }
.avd-menu button[aria-disabled=true] { cursor: default; color: var(--faint); }
.avd-menu button small { display: block; color: var(--dim); font-size: 12px; margin-top: 2px; }
.avd-back { position: fixed; inset: 0; z-index: 900; background: #05070bb8; backdrop-filter: blur(3px); display: grid; place-items: center; padding: 16px; }
.avd-dlg { width: min(440px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: var(--card); color: var(--text); border: 1px solid var(--line2);
  border-radius: 16px; box-shadow: var(--shadow); padding: 18px; font-size: 14px; line-height: 1.45; }
.avd-head { display: flex; gap: 12px; align-items: center; margin-bottom: 10px; }
.avd-head .th { width: 64px; height: 64px; flex: none; border-radius: 12px; object-fit: cover; background: radial-gradient(circle at 50% 40%, var(--card3), var(--card2));
  display: grid; place-items: center; font-size: 26px; color: var(--faint); border: 1px solid var(--line); }
.avd-head h3 { margin: 0; font-size: 17px; line-height: 1.25; overflow-wrap: anywhere; }
.avd-head small { color: var(--dim); font-size: 12px; }
.avd-dlg p { margin: 0 0 10px; }
.avd-dlg .note-live { color: var(--dim); font-size: 13px; }
.avd-dlg label { display: block; font-weight: 600; margin: 12px 0 6px; }
.avd-dlg label code { font-weight: 700; }
.avd-dlg input { width: 100%; box-sizing: border-box; padding: 9px 11px; border-radius: 10px; border: 1px solid var(--line2); background: var(--input); color: var(--text);
  font: 600 15px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: 1px; }
.avd-dlg input:focus { outline: 2px solid var(--focus); outline-offset: 1px; }
.avd-btns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; flex-wrap: wrap; }
.avd-btns .btn { min-height: 36px; }
.avd-btns .btn.del { background: var(--err); color: #fff; border-color: transparent; font-weight: 700; transition: none; }
.avd-btns .btn.del:disabled { background: var(--card2); color: var(--faint); border-color: var(--line2); cursor: not-allowed; }
.avd-err { color: var(--err); font-size: 13px; margin: 10px 0 0 !important; }
.avd-err:empty { display: none; }
.avd-list { display: flex; flex-direction: column; gap: 6px; margin: 6px 0 4px; }
.avd-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--card2); }
.avd-row b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.avd-row small { color: var(--dim); font-size: 12px; white-space: nowrap; }
.avd-toast { display: flex; align-items: center; gap: 10px; }
.avd-toast .btn { padding: 4px 12px; font-weight: 700; }
.avd-recent { all: unset; cursor: pointer; color: var(--dim); font-size: 12.5px; margin-top: 8px; display: inline-block; border-bottom: 1px dotted var(--faint); }
.avd-recent:hover, .avd-recent:focus-visible { color: var(--text); }
`;
function css() { if (!document.getElementById('vtp-avd-css')) document.head.append(h('style', { id: 'vtp-avd-css' }, CSS)); }

// ---------------------------------------------------------------- server calls (status 0 = no answer)
interface Answer { status: number; body: unknown }
async function call(method: string, url: string, body?: unknown): Promise<Answer> {
  try {
    const r = await fetch(url, { method, cache: 'no-store', ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    let b: unknown = null;
    try { b = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, body: b };
  } catch { return { status: 0, body: null }; }
}
const errOf = (b: unknown) => (b && typeof b === 'object' && typeof (b as { error?: unknown }).error === 'string' ? (b as { error: string }).error : '');

// ---------------------------------------------------------------- what is in use + the library signal
function inUse(app: App): InUse {
  let buddyId: string | null = null;
  try { const c = app.scene.effective.chat; if (c?.buddy) buddyId = buddyModelOf(c.buddyModel); } catch { /* no scene yet */ }
  return { activeId: app.profile?.id ?? null, buddyId };
}
let watching = false;
/** Every open page hears a delete / restore: the server broadcasts {type:'profile', avatarId} (trashAvatar /
 *  restoreAvatar); the list re-reads (app 'library' → Me + Advanced → Avatars). The avatar on screen is left to app.ts. */
function watchLibrary(app: App) {
  if (watching) return;
  watching = true;
  let t = 0;
  app.bus.on((m) => {
    if (m.type !== 'profile' || m.avatarId === app.profile?.id || m.avatarId.startsWith('party-')) return;
    clearTimeout(t);
    t = window.setTimeout(() => app.emit('library'), 300);
  });
}

// ---------------------------------------------------------------- recently deleted (this tab's session)
const SS_KEY = 'vtp.avatars.recentlyDeleted';
let recent: DeletedEntry[] = (() => { try { return sanitizeDeleted(JSON.parse(sessionStorage.getItem(SS_KEY) || '[]')); } catch { return []; } })();
const thumbs = new Map<string, string>();   // trash name → object URL of the thumbnail (this tab only)
function saveRecent() { try { sessionStorage.setItem(SS_KEY, JSON.stringify(recent)); } catch { /* storage off */ } }
function forget(e: DeletedEntry) {
  recent = recent.filter((x) => !(x.id === e.id && x.trash === e.trash));
  saveRecent();
  const u = thumbs.get(e.trash); if (u) { URL.revokeObjectURL(u); thumbs.delete(e.trash); }
}

// ---------------------------------------------------------------- the ⋯ menu
let menuClose: (() => void) | null = null;
function openMenu(app: App, p: AvatarProfile, anchor: HTMLElement) {
  menuClose?.();
  css();
  const v = deleteVerdict(p, inUse(app), app.observer);
  const close = () => { menu.remove(); anchor.setAttribute('aria-expanded', 'false'); removeEventListener('pointerdown', outside, true); removeEventListener('keydown', key, true); removeEventListener('resize', close); removeEventListener('scroll', onScroll, true); menuClose = null; };
  const outside = (e: Event) => { if (!menu.contains(e.target as Node) && e.target !== anchor) close(); };
  const onScroll = (e: Event) => { if (!menu.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); anchor.focus(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = [...menu.querySelectorAll('button')]; const i = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); e.preventDefault();
    }
  };
  const del = v.ok
    ? h('button', { class: 'danger', role: 'menuitem', 'data-avd': 'delete', onClick: () => { close(); openDeleteDialog(app, p); } }, 'Delete…')
    : h('button', { role: 'menuitem', 'aria-disabled': 'true', 'data-avd': 'delete-blocked', onClick: () => { /* explained below */ } }, 'Delete', h('small', null, v.why === 'active' || v.why === 'buddy' ? 'Switch to another avatar first' : v.text));
  const menu = h('div', { class: 'avd-menu', role: 'menu', 'aria-label': `${p.name}: more` }, del,
    recent.length ? h('button', { role: 'menuitem', 'data-avd': 'recent', onClick: () => { close(); openRecentlyDeleted(app); } }, `Recently deleted (${recent.length})…`) : null);
  document.body.append(menu);
  const r = anchor.getBoundingClientRect(), mw = menu.offsetWidth, mh = menu.offsetHeight;
  // never over the rail: a card near the left edge of the panel would open its menu leftwards, across the rail's buttons (AV-05)
  const minLeft = Math.max(8, (anchor.closest('#panel')?.getBoundingClientRect().left ?? 0) + 6);
  menu.style.left = `${Math.max(minLeft, Math.min(innerWidth - mw - 8, r.right - mw))}px`;
  menu.style.top = `${r.bottom + 4 + mh > innerHeight - 8 ? Math.max(8, r.top - mh - 4) : r.bottom + 4}px`;
  anchor.setAttribute('aria-expanded', 'true');
  addEventListener('pointerdown', outside, true); addEventListener('keydown', key, true); addEventListener('resize', close); addEventListener('scroll', onScroll, true);
  menuClose = close;
  (menu.querySelector('button') as HTMLButtonElement | null)?.focus();
}
function moreButton(app: App, p: AvatarProfile, cls: string): HTMLButtonElement {
  css(); watchLibrary(app);
  return h('button', { type: 'button', class: cls, title: 'More', 'aria-label': `More for ${p.name}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-avd': 'more', 'data-avatar': p.id,
    onClick: (e: Event) => { e.stopPropagation(); e.preventDefault(); const b = e.currentTarget as HTMLElement; if (b.getAttribute('aria-expanded') === 'true') menuClose?.(); else openMenu(app, p, b); } });
}

/** Me's avatar tile with its ⋯ (Delete…). Builtins / samples and observer tabs: the tile as is. (src/ui/simple.ts) */
export function avatarTileMenu(app: App, p: AvatarProfile, tile: HTMLElement): HTMLElement {
  watchLibrary(app);                                                  // (observer tabs too: their list follows deletes)
  if (isProtectedAvatar(p) || app.observer) return tile;
  const more = moreButton(app, p, 'avd-more');
  more.textContent = '⋯';
  return h('div', { class: 'avd-wrap', 'data-avatar': p.id }, tile, more);
}
/** Advanced → Avatars card: its corner button (was ✕ + window.confirm), or null for builtins. (src/ui/panels.ts) */
export function avatarCardMenu(app: App, p: AvatarProfile): HTMLElement | null {
  watchLibrary(app);
  if (isProtectedAvatar(p) || app.observer) return null;
  const more = moreButton(app, p, 'x avd-more');
  more.textContent = '⋯';
  return more;
}
/** A quiet "Recently deleted (n)" line under Me's avatars while this tab deleted any (else null). (src/ui/simple.ts) */
export function recentlyDeletedLine(app: App): HTMLElement | null {
  if (!recent.length || app.observer) return null;
  css(); watchLibrary(app);
  return h('button', { type: 'button', class: 'avd-recent', 'data-avd': 'recent-line', onClick: () => openRecentlyDeleted(app) }, `Recently deleted (${recent.length}) · bring one back`);
}

// ---------------------------------------------------------------- dialogs
function modal(label: string, onClose: () => void): { back: HTMLElement; dlg: HTMLElement; close: () => void } {
  css();
  const prev = document.activeElement as HTMLElement | null;
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  const dlg = h('div', { class: 'avd-dlg', role: 'dialog', 'aria-modal': 'true', 'aria-label': label });
  const back = h('div', { class: 'avd-back', onPointerdown: (e: Event) => { if (e.target === back) close(); } }, dlg);
  let open = true;
  function close() { if (!open) return; open = false; back.remove(); removeEventListener('keydown', key, true); onClose(); prev?.focus?.(); }
  document.body.append(back);
  addEventListener('keydown', key, true);
  return { back, dlg, close };
}
const thumbEl = (src: string | null) => (src ? h('img', { class: 'th', src, alt: '' }) : h('div', { class: 'th', 'aria-hidden': 'true' }, '☺'));
const thumbUrl = (p: AvatarProfile) => (p.thumbnail ? `${api.fileUrl(p, p.thumbnail)}?t=${Date.now()}` : null);

/** Is the show on (camera on, or OBS showing VTube Pro)? The studio's own "in use" check (src/ui/live/liveStudio.ts onAir). */
async function showOn(app: App): Promise<boolean> {
  if (app.trackingOn) return true;
  const s = await call('GET', '/api/setup/status');
  const o = (s.body as { outputs?: { count?: number; inObs?: number } } | null)?.outputs;
  return !!o && ((o.inObs ?? o.count ?? 0) > 0);
}

/** The "type CONFIRM" box. */
export function openDeleteDialog(app: App, p: AvatarProfile) {
  menuClose?.();
  document.querySelector('.avd-back')?.remove();
  const err = h('p', { class: 'avd-err', role: 'alert' });
  const input = h('input', { type: 'text', id: 'avd-confirm', autocomplete: 'off', autocapitalize: 'characters', placeholder: CONFIRM_WORD, 'aria-describedby': 'avd-why', 'data-avd': 'confirm-input' }) as HTMLInputElement;
  input.spellcheck = false;
  const cancel = h('button', { type: 'button', class: 'btn', 'data-avd': 'cancel', onClick: () => m.close() }, 'Cancel');
  const go = h('button', { type: 'button', class: 'btn del', disabled: true, 'data-avd': 'confirm-delete', onClick: () => void submit() }, 'Delete') as HTMLButtonElement;
  const live = h('p', { class: 'note-live', hidden: true }, `You can do this while live: your stream keeps ${app.profile?.name ?? 'your avatar'}.`);
  const m = modal(`Delete ${p.name}?`, () => { /* nothing to undo */ });
  m.dlg.append(
    h('div', { class: 'avd-head' }, thumbEl(thumbUrl(p)), h('div', null, h('h3', null, `Delete ${p.name}?`), h('small', null, p.flat ? '2D avatar' : '3D avatar'))),
    h('p', { id: 'avd-why' }, `This removes ${p.name} from your avatars. It goes to VTube Pro's trash folder, so it can be brought back.`),
    live,
    h('label', { for: 'avd-confirm' }, 'Type ', h('code', null, CONFIRM_WORD), ' to delete it'),
    input, err,
    h('div', { class: 'avd-btns' }, cancel, go));
  const sync = () => { const ok = confirmMatches(input.value); go.disabled = !ok || busy; };
  let busy = false;
  input.addEventListener('input', () => { err.textContent = ''; sync(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (confirmMatches(input.value) && !busy) void submit(); } });
  input.focus();
  void showOn(app).then((on) => { if (on) live.hidden = false; });

  async function submit() {
    if (busy || !confirmMatches(input.value)) return;
    // checked again now: the avatar may have been put on (another switch, a hotkey) while the box was open
    const v = deleteVerdict(p, inUse(app), app.observer);
    if (!v.ok) { err.textContent = v.text; return; }
    busy = true; sync(); go.textContent = 'Deleting…'; cancel.disabled = true;
    // the thumbnail, kept for the Undo toast / Recently deleted (the trash folder isn't served)
    let thumb: string | null = null;
    const tu = thumbUrl(p);
    if (tu) { try { const r = await fetch(tu); if (r.ok) thumb = URL.createObjectURL(await r.blob()); } catch { /* no picture */ } }
    // and once more right before the DELETE (the avatar may have been put on while the picture loaded)
    const v2 = deleteVerdict(p, inUse(app), app.observer);
    if (!v2.ok) { if (thumb) URL.revokeObjectURL(thumb); busy = false; go.textContent = 'Delete'; cancel.disabled = false; err.textContent = v2.text; sync(); return; }
    const a = await call('DELETE', `/api/avatars/${encodeURIComponent(p.id)}`);
    busy = false; go.textContent = 'Delete'; cancel.disabled = false;
    if (a.status < 200 || a.status >= 300) {
      if (thumb) URL.revokeObjectURL(thumb);
      if (a.status === 404) { m.close(); toast(deleteErrorText(404, p.name), 'info', 5000); app.emit('library'); return; }
      err.textContent = deleteErrorText(a.status, p.name, errOf(a.body));
      sync();
      return;
    }
    m.close();
    const trash = trashNameOf((a.body as { movedTo?: unknown } | null)?.movedTo);
    app.emit('library');
    if (!trash) { if (thumb) URL.revokeObjectURL(thumb); toast(`${p.name} was deleted.`, 'ok'); return; }
    const e: DeletedEntry = { id: p.id, name: p.name, trash, at: Date.now() };
    recent = addDeleted(recent, e); saveRecent();
    if (thumb) thumbs.set(trash, thumb);
    undoToast(app, e);
  }
}

/** "Deleted X · Undo" for ~10 s. */
function undoToast(app: App, e: DeletedEntry) {
  css();
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts' }); document.body.append(host); }
  const undo = h('button', { type: 'button', class: 'btn', 'data-avd': 'undo', onClick: () => { gone(); void restore(app, e); } }, 'Undo');
  const t = h('div', { class: 'toast ok avd-toast', role: 'status', 'data-avd': 'undo-toast' }, h('span', null, `${e.name} was deleted.`), undo);
  let timer = 0;
  const gone = () => { clearTimeout(timer); t.classList.add('out'); setTimeout(() => t.remove(), 400); };
  host.append(t);
  // (a pointer on it, or keyboard focus, keeps it up)
  const arm = () => { clearTimeout(timer); timer = window.setTimeout(gone, 10_000); };
  t.addEventListener('pointerenter', () => clearTimeout(timer)); t.addEventListener('pointerleave', arm);
  undo.addEventListener('focus', () => clearTimeout(timer)); undo.addEventListener('blur', arm);
  arm();
}

/** Bring one back (Undo / Recently deleted). true = it is back. */
async function restore(app: App, e: DeletedEntry): Promise<boolean> {
  const a = await call('POST', `/api/avatars/${encodeURIComponent(e.id)}/restore`, { from: e.trash });
  const o = restoreOutcome(a.status, a.body);
  if (o === 'ok' || o === 'taken') {
    forget(e);
    app.emit('library');
    toast(o === 'ok' ? `${e.name} is back in your avatars.` : (restoreText(o, e.name) ?? ''), 'ok');
    return true;
  }
  if (o === 'gone' || o === 'builtin') forget(e);
  toast(restoreText(o, e.name, e.trash) ?? '', 'warn', 6000);
  return false;
}

/** This tab's deleted avatars, each with "Bring back". */
export function openRecentlyDeleted(app: App) {
  menuClose?.();
  document.querySelector('.avd-back')?.remove();
  const m = modal('Recently deleted', () => { /* */ });
  const list = h('div', { class: 'avd-list' });
  const paint = () => {
    list.replaceChildren(...(recent.length ? recent.map((e) => {
      const b = h('button', { type: 'button', class: 'btn', 'data-avd': 'bring-back', onClick: async () => { b.disabled = true; b.textContent = 'Bringing back…'; await restore(app, e); paint(); } }, 'Bring back') as HTMLButtonElement;
      return h('div', { class: 'avd-row', 'data-avatar': e.id }, h('img', { class: 'th', src: thumbs.get(e.trash) ?? '', alt: '', style: thumbs.get(e.trash) ? 'width:36px;height:36px;border-radius:8px;object-fit:cover' : 'display:none' }),
        h('b', null, e.name), h('small', null, ago(e.at)), b);
    }) : [h('p', { class: 'note' }, 'Nothing deleted in this window.')]));
  };
  paint();
  m.dlg.append(
    h('div', { class: 'avd-head' }, h('div', null, h('h3', null, 'Recently deleted'), h('small', null, 'Avatars you deleted in this window'))),
    list,
    h('p', { class: 'note', style: 'margin-top:10px' }, 'Older ones stay in the trash folder until you empty it yourself.'),
    h('div', { class: 'avd-btns' }, h('button', { type: 'button', class: 'btn', 'data-avd': 'close', onClick: () => m.close() }, 'Close')));
  (m.dlg.querySelector('[data-avd=bring-back], [data-avd=close]') as HTMLElement | null)?.focus();
}
function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}
