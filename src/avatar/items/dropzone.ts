// The drop zone on the studio preview: drag a picture (PNG / GIF / WebP / JPEG) or a small .glb over the avatar and two big
// targets appear: "Put it on my avatar" (this lane) and "Make it my avatar" (the existing drop-to-import, untouched: it is only
// not stopped, so src/ui/dropImport.ts still receives the very same drop). Nothing is drawn, and no work is done, unless a file is
// being dragged over the preview: the listeners below do nothing for every other event.
//
// Why two targets: a picture or a model dropped on the page has always meant "import as an avatar" (dropImport.ts, other lanes'
// code, not changed). Over the preview, people also expect "stick it on". Asking in two plain words keeps both working.
export interface DropOpts {
  canvas: HTMLCanvasElement;
  /** `at`: where on the preview the files were dropped, 0..1 from its top-left. */
  files: (files: File[], at?: { x: number; y: number }) => void;
}

const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

export class ItemDropZone {
  private el: HTMLDivElement | null = null;
  private dead = false;

  constructor(private readonly o: DropOpts) {
    window.addEventListener('dragover', this.onOver, true);
    window.addEventListener('dragleave', this.onLeave, true);
    window.addEventListener('drop', this.onDropWindow, true);
    window.addEventListener('dragend', this.hide, true);
  }

  private inside(e: DragEvent) {
    const r = this.o.canvas.getBoundingClientRect();
    return r.width > 40 && r.height > 40 && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  private readonly onOver = (e: DragEvent) => {
    if (this.dead || !hasFiles(e)) return;
    if (!this.inside(e) || document.querySelector('.wiz-back')) { this.hide(); return; }
    this.show();
  };
  private readonly onLeave = (e: DragEvent) => { if (!this.dead && this.el && e.relatedTarget === null && !this.inside(e)) this.hide(); };
  private readonly onDropWindow = () => { setTimeout(this.hide, 0); };
  private readonly hide = () => { this.el?.remove(); this.el = null; };

  private show() {
    const r = this.o.canvas.getBoundingClientRect();
    if (!this.el) {
      const mk = (cls: string, title: string, sub: string) => {
        const t = document.createElement('div');
        t.className = `itm-tile ${cls}`;
        const b = document.createElement('b'); b.textContent = title;
        const s = document.createElement('span'); s.textContent = sub;
        t.append(b, s);
        return t;
      };
      const el = document.createElement('div');
      el.className = 'itm-drop';
      el.setAttribute('role', 'presentation');
      const keep = mk('quiet', 'Make it my avatar', 'Import it as a new avatar (the usual way)');
      const stick = mk('main', 'Put it on my avatar', 'A sticker, a hat or a held sign. It follows you');
      el.append(keep, stick);
      // "Make it my avatar": do nothing here. The page's own import handler takes the drop, exactly as before.
      stick.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; stick.classList.add('over'); });
      stick.addEventListener('dragleave', () => stick.classList.remove('over'));
      stick.addEventListener('drop', (e) => {
        e.preventDefault();   // (a prevented drop is left alone by the import handler)
        stick.classList.remove('over');
        const files = [...(e.dataTransfer?.files ?? [])];
        const cr = this.o.canvas.getBoundingClientRect();
        this.hide();
        if (files.length) this.o.files(files, { x: (e.clientX - cr.left) / Math.max(1, cr.width), y: (e.clientY - cr.top) / Math.max(1, cr.height) });
      });
      keep.addEventListener('dragover', () => stick.classList.remove('over'));
      document.body.append(el);
      this.el = el;
    }
    const s = this.el.style;
    s.left = `${r.left}px`; s.top = `${r.top}px`; s.width = `${r.width}px`; s.height = `${r.height}px`;
  }

  dispose() {
    this.dead = true;
    window.removeEventListener('dragover', this.onOver, true);
    window.removeEventListener('dragleave', this.onLeave, true);
    window.removeEventListener('drop', this.onDropWindow, true);
    window.removeEventListener('dragend', this.hide, true);
    this.hide();
  }
}
