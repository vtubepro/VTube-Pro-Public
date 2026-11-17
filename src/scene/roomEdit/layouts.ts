// The Room editor's "Layouts" section (docs/ROOM_EDITOR.md §2b, shared/roomLayouts.ts): save how the room looks now under
// a name, load one back into the editor (one undo step; Save puts it on stream with the usual on-air question), rename,
// delete, export / import a layout file, and "Reset to default" (the room as it came). The same calls work against the
// server (server/routes/roomEdits.ts). The section is ONE persistent element: the editor re-renders round it without losing typing.
import { readLayout, type LayoutInfo, type RoomLayout } from '../../../shared/roomLayouts.ts';
import { editCount, editsEmpty, type RoomEdits } from '../../../shared/roomEdits.ts';

export interface LayoutsHost {
  room: string;
  /** The layer the editor shows now (unsaved changes included). */
  edits(): RoomEdits;
  /** Put a layer into the editor (one undo step). */
  load(e: RoomEdits, name: string): void;
  /** The room as it came (one undo step); Save then removes the saved layer. */
  resetToDefault(): void;
  flash(msg: string, ms?: number): void;
  /** A yes / no question; `danger` = the yes button looks like a destructive one. */
  confirm(title: string, text: string, ok: string, danger?: boolean): Promise<boolean>;
}

type El = HTMLElement;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string | null | undefined | false)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = String(v); else if (k === 'style') e.style.cssText = String(v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else e.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
};

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const j = await r.json().catch(() => ({})) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? (r.status === 503 ? 'This needs VTube Pro.' : `Something went wrong (${r.status}). Try again.`));
  return j;
}

const when = (iso: string) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t), now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

export class LayoutsSection {
  readonly root: El;
  private list: LayoutInfo[] = [];
  private loaded = false;
  private error = '';
  private naming: { slug: string | null; value: string } | null = null;
  private busy = false;
  /** Focus the name box on its next render only (the editor re-renders round it). */
  private focusName = false;
  private readonly base: string;

  constructor(private host: LayoutsHost) {
    this.base = `/api/rooms/${encodeURIComponent(host.room)}/presets`;
    this.root = el('div', { class: 're-layouts', 'data-section': 'layouts' });
    this.render();
    void this.refresh();
  }

  async refresh() {
    try { this.list = (await call<{ presets: LayoutInfo[] }>('GET', this.base)).presets ?? []; this.error = ''; }
    catch (e) { this.error = (e as Error).message; }
    this.loaded = true;
    this.render();
  }

  private async run(fn: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true; this.render();
    try { await fn(); } catch (e) { this.host.flash((e as Error).message, 6000); }
    this.busy = false;
    await this.refresh();
  }

  /** "Save as new layout": the name the user typed; the same name as an existing layout replaces it (asked first). */
  async saveAs(name: string) {
    const n = name.trim();
    if (!n) { this.host.flash('Type a name for the layout first.'); return; }
    const e = this.host.edits();
    const same = this.list.find((l) => l.name.toLowerCase() === n.toLowerCase());
    if (same && !(await this.host.confirm('Replace this layout?', `You already have a layout called "${same.name}". Replace it with how the room looks now?`, 'Replace it'))) return;
    await this.run(async () => {
      if (same) await call('PUT', `${this.base}/${same.slug}`, { name: n, edits: e });
      else await call('POST', this.base, { name: n, edits: e });
      this.naming = null;
      this.host.flash(editsEmpty(e) ? `Saved "${n}" (the room as it came).` : `Saved "${n}". Load it any time from Layouts.`);
    });
  }
  async loadOne(slug: string) {
    await this.run(async () => {
      const { preset } = await call<{ preset: RoomLayout }>('GET', `${this.base}/${slug}`);
      this.host.load(preset.edits, preset.name);
    });
  }
  async rename(slug: string, name: string) {
    const n = name.trim();
    if (!n) { this.host.flash('Type a name first.'); return; }
    await this.run(async () => { await call('PUT', `${this.base}/${slug}`, { name: n }); this.naming = null; });
  }
  async remove(slug: string) {
    const l = this.list.find((x) => x.slug === slug);
    if (!l || !(await this.host.confirm('Delete this layout?', `"${l.name}" will be gone for good. The room itself doesn't change.`, 'Delete', true))) return;
    await this.run(async () => { await call('DELETE', `${this.base}/${slug}`); this.host.flash(`Deleted "${l.name}".`); });
  }
  /** Download a layout as a .json file (to keep, or to load on another PC / browser). */
  async exportOne(slug: string) {
    await this.run(async () => {
      const { preset } = await call<{ preset: RoomLayout }>('GET', `${this.base}/${slug}`);
      const blob = new Blob([JSON.stringify(preset, null, 1)], { type: 'application/json' });
      const a = el('a', { href: URL.createObjectURL(blob), download: `${this.host.room}-${preset.slug}.vtplayout.json` }) as HTMLAnchorElement;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
  }
  /** A layout file someone exported: added to this room's layouts (its name kept; a clash gets a new name). */
  async importFile(f: File) {
    await this.run(async () => {
      let raw: unknown;
      try { raw = JSON.parse(await f.text()); } catch { throw new Error('That file is not a layout (it should end in .vtplayout.json).'); }
      const l = readLayout(raw, this.host.room, 'imported');                // (only to check it is a layout file + its name)
      if (!l) throw new Error('That file is not a VTube Pro room layout.');
      const taken = new Set(this.list.map((x) => x.name.toLowerCase()));
      let name = l.name;
      for (let i = 2; taken.has(name.toLowerCase()) && i < 100; i++) name = `${l.name.slice(0, 34)} (${i})`;
      // the file's OWN layer goes to the store: its trimLayout is the only trim, so its count of what was left out is right
      const r = await call<{ note?: string }>('POST', this.base, { name, edits: (raw as { edits?: unknown }).edits ?? null });
      const other = (raw as { room?: unknown }).room;
      // (the store keeps what fits this room and says in plain words what it left out)
      this.host.flash(r.note ? `Added "${name}". ${r.note}` : typeof other === 'string' && other !== this.host.room ? `Added "${name}" (made for another room).` : `Added "${name}".`, 7000);
    });
  }

  render() {
    const b = (label: string, on: () => void, cls = '', title = '', extra: Record<string, unknown> = {}) => el('button', { class: `re-btn ${cls}`, onclick: on, title, disabled: this.busy, ...extra }, label);
    const nameBox = (slug: string | null, placeholder: string, okLabel: string, ok: (v: string) => void) => {
      const inp = el('input', { class: 're-sel', placeholder, maxlength: 40, value: this.naming?.value ?? '', style: 'flex:1;min-width:120px', 'data-layout-name': slug ?? 'new',
        oninput: (e: Event) => { if (this.naming) this.naming.value = (e.target as HTMLInputElement).value; },
        onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') ok((e.target as HTMLInputElement).value); if (e.key === 'Escape') { this.naming = null; this.render(); } } }) as HTMLInputElement;
      if (this.focusName) { this.focusName = false; queueMicrotask(() => { if (inp.isConnected) inp.focus(); }); }
      return el('div', { class: 're-row' }, inp, b(okLabel, () => ok(inp.value), 'go'), b('Cancel', () => { this.naming = null; this.render(); }));
    };
    const rows = this.list.map((l) => {
      if (this.naming?.slug === l.slug) return el('div', { class: 're-lay' }, nameBox(l.slug, 'New name', 'Rename', (v) => void this.rename(l.slug, v)));
      return el('div', { class: 're-lay', 'data-layout': l.slug },
        el('div', { class: 're-lay-top' }, el('span', { class: 'nm' }, l.name), el('span', { class: 'tag' }, `${l.changes ? `${l.changes} change${l.changes === 1 ? '' : 's'}` : 'as it came'}${l.savedAt ? ` · ${when(l.savedAt)}` : ''}`)),
        el('div', { class: 're-row' },
          b('Load', () => void this.loadOne(l.slug), 'on', 'Show this layout here. Press Save to use it on stream.'),
          b('Rename', () => { this.naming = { slug: l.slug, value: l.name }; this.focusName = true; this.render(); }),
          b('Export', () => void this.exportOne(l.slug), '', 'Download it as a file (to keep, or to use on another computer)'),
          b('Delete', () => void this.remove(l.slug), 'warn')));
    });
    const picker = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none', onchange: (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void this.importFile(f); (e.target as HTMLInputElement).value = ''; } }) as HTMLInputElement;
    const cur = editCount(this.host.edits());
    this.root.replaceChildren(
      el('div', { class: 're-h' }, 'Layouts'),
      el('div', { class: 're-note' }, 'Save how the room looks now under a name, and switch back any time. Loading one shows it here; Save puts it on stream.'),
      this.naming?.slug === null ? nameBox(null, 'Name, e.g. Podcast', 'Save layout', (v) => void this.saveAs(v))
        : el('div', { class: 're-row' },
          b('Save as new layout…', () => { this.naming = { slug: null, value: '' }; this.focusName = true; this.render(); }, 'go', cur ? `Keeps your ${cur} change${cur === 1 ? '' : 's'} under a name` : 'Keeps the room as it is now under a name'),
          b('Reset to default', () => void this.resetAsk(), 'warn', 'The room exactly as it came (your layouts are kept)')),
      this.error ? el('div', { class: 're-note bad' }, this.error)
        : !this.loaded ? el('div', { class: 're-note' }, 'Loading your layouts…')
        : rows.length ? el('div', { class: 're-lays' }, ...rows)
        : el('div', { class: 're-note' }, 'No layouts yet. Arrange the room, then press "Save as new layout…".'),
      el('div', { class: 're-row' }, b('Import a layout file…', () => picker.click(), '', 'A .vtplayout.json file exported from VTube Pro'), picker),
    );
  }
  private async resetAsk() {
    if (!(await this.host.confirm('Reset to default?', 'Every change to this room goes: cameras, places, screens, props and the room\'s own objects. Your saved layouts are kept. Nothing changes on stream until you press Save.', 'Reset to default', true))) return;
    this.host.resetToDefault();
  }
}
