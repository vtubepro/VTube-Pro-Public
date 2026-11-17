// Wardrobe tab: wear / import / delete costumes and edit costume labels live. New costumes come from your own AI app (through
// VTube Pro's tools) or from Blender: VTube Pro itself holds no AI key.
import type { App } from '../app.ts';
import { api } from '../api.ts';
import type { CostumeDef } from '../../shared/types.ts';
import { button, h, rerender as rebuild, section, toast } from './dom.ts';
import { costumeLocked } from '../../shared/ownAvatar.ts';

let blenderOk: boolean | null = null;

export function wardrobe(app: App, el: HTMLElement) {
  // keeps scroll / focus / open sections, leaves the DOM alone when nothing changed; never paints over another tab
  const rerender = () => { if (!el.dataset.ui || el.dataset.ui === 'wardrobe') rebuild(el, () => wardrobe(app, el)); };
  el.append(h('h2', null, 'Wardrobe'));
  const p = app.profile;
  if (!p) { el.append(h('p', { class: 'note' }, 'Load or create an avatar first (Me → Advanced → Avatars).')); return; }
  if (blenderOk === null) void api.status().then((s) => { blenderOk = s.blender.available; if (el.isConnected) rerender(); }).catch(() => (blenderOk = false));
  const worn = p.costume ?? null;

  // ---- grid ----
  const card = (c: CostumeDef | null, i: number) => {
    const on = (c?.id ?? null) === worn;
    const thumb = c?.thumbnail
      ? h('img', { src: `${api.pathUrl(p.id, c.thumbnail)}?t=${thumbStamp}`, alt: c.name })
      : h('div', { class: 'ph' }, c ? '👕' : '∅');
    // (locked only when VTube Pro ships the avatar: a costume a creator script marked 'builtin' on the user's own avatar is theirs;
    // an older version does not say, and then the costume's own source decides, as before)
    const del = c && !costumeLocked(p, c) ? h('button', {
      class: 'x', title: 'Move to trash',
      onClick: async (e: Event) => {
        e.stopPropagation();
        if (!confirm(`Move costume "${c.name}" to the trash folder? (Recoverable from library/.trash)`)) return;
        try { await api.removeCostume(p.id, c.id); toast(`Moved ${c.name} to the trash`, 'ok'); await app.reloadProfile(); }
        catch (err) { toast((err as Error).message, 'err'); }
      },
    }, '✕') : null;
    const render = c && !c.thumbnail && blenderOk ? h('button', {
      class: 'x', title: 'Render a thumbnail with Blender', style: 'left:4px;right:auto;display:block',
      onClick: async (e: Event) => {
        e.stopPropagation();
        try { await api.renderCostumeThumb(p.id, c.id); toast('Rendering thumbnail… (~15 s)'); } catch (err) { toast((err as Error).message, 'err'); }
      },
    }, '📷') : null;
    const key = i <= 9 ? `Ctrl+${i}` : '';
    return h('div', { class: `card ${on ? 'on' : ''}`, title: key ? `${key} (or Alt+${i})` : '', onClick: () => void app.setCostume(c?.id ?? null) },
      thumb, del, render,
      h('div', { class: 'meta' }, c?.name ?? 'None', h('small', null, `${c ? c.source ?? 'costume' : 'base model'}${key ? ' · ' + key : ''}`)));
  };
  const outfits = p.costumes.filter((c) => c.kind !== 'accessory');
  const grid = h('div', { class: 'grid', style: 'grid-template-columns:repeat(3,1fr)', 'data-tut': 'wardrobe-list' }, card(null, 0), ...outfits.map((c, i) => card(c, i + 1)));
  el.append(grid);
  // ---- accessories: toggle any number on top of the outfit ----
  const accs = p.costumes.filter((c) => c.kind === 'accessory');
  if (accs.length) {
    const wearing = new Set(p.accessories ?? []);
    el.append(h('h3', null, 'Accessories'), h('div', { class: 'grid', style: 'grid-template-columns:repeat(3,1fr)' }, ...accs.map((c) => {
      const on = wearing.has(c.id);
      const thumb = c.thumbnail ? h('img', { src: `${api.pathUrl(p.id, c.thumbnail)}?t=${thumbStamp}`, alt: c.name }) : h('div', { class: 'ph' }, '🕶');
      return h('div', { class: `card ${on ? 'on' : ''}`, onClick: () => void app.setAccessory(c.id, !on).then(rerender) },
        thumb, h('div', { class: 'meta' }, c.name, h('small', null, on ? 'wearing · click to remove' : 'click to wear')));
    })));
  }
  if (!p.costumes.length) el.append(h('p', { class: 'note' }, 'No costumes yet — import a costume GLB below.'));
  const rt = app.runtime;
  if (worn && rt && !rt.costume) el.append(h('p', { class: 'note', style: 'color:var(--warn)' }, '⚠ The selected costume failed to load — see warnings.'));

  // ---- labels ----
  const withLabels = p.costumes.filter((c) => c.labels?.length);
  if (withLabels.length) {
    const sec = section('Labels'); sec.dataset.tut = 'wardrobe-labels';
    for (const c of withLabels) {
      sec.append(h('div', { class: 'note', style: 'margin-top:6px' }, h('b', null, c.name), c.id === worn ? ' (worn — updates live)' : ''));
      for (const l of c.labels!) {
        const ta = h('textarea', {
          rows: Math.max(1, l.text.split('\n').length), value: l.text, placeholder: l.material, style: 'min-height:0',
          onInput: (e: Event) => app.setCostumeLabel(c.id, l.material, (e.target as HTMLTextAreaElement).value),
        });
        sec.append(h('label', { class: 'row' }, h('span', { class: 'lbl' }, l.material), ta));
      }
    }
    sec.append(h('p', { class: 'note' }, 'Enter = new line. The text auto-fits the label.'));
    el.append(sec);
  }

  // ---- import ----
  const file = h('input', { type: 'file', accept: '.glb', style: 'display:none' });
  const doImport = async (f: File) => {
    toast(`Importing ${f.name}…`);
    try {
      const r = await api.importCostume(p.id, f);
      for (const w of r.warnings) toast(w, 'warn', 7000);
      toast(`Added ${r.costume.name}`, 'ok');
      await app.reloadProfile();
      await app.setCostume(r.costume.id);
    } catch (e) { toast(`Import failed: ${(e as Error).message}`, 'err', 8000); }
  };
  file.onchange = () => { if (file.files?.[0]) void doImport(file.files[0]); };
  const drop = h('div', { class: 'drop', 'data-tut': 'wardrobe-import', onClick: () => file.click() }, h('b', null, 'Import costume GLB…'), h('br'), 'Rigged to the same bone names as this avatar (blender/costume_kit.py)');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer?.files?.[0]; if (f) void doImport(f); };
  el.append(section('Import', drop, file));

  // ---- new costumes ----
  el.append(section('Make a new costume',
    h('p', { class: 'note', 'data-tut': 'wardrobe-prompt' }, 'Ask your AI app (Claude, ChatGPT, Grok ...) in Create: it builds the outfit in Blender with blender/costume_kit.py and adds it here (you approve what changes your stream). Or build it yourself in Blender and import the GLB above.'),
  ));
}

/** Bumped so thumbnails re-fetch after the server renders a new one. */
let thumbStamp = Date.now();
export function bumpWardrobeThumbs() { thumbStamp = Date.now(); }
