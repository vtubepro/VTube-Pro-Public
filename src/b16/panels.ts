// beta.16 panels (docs/b16/LANES.md): a lane's settings screen registers itself here from its mount(); the Live panel's
// "Stream extras" tab (src/ui/live/liveStudio.ts, owned by the rules lane) draws the list. So no other lane edits src/ui/live/*.
// Simple mode first: `simple` panels show by default, the rest sit under "More".
export interface B16PanelHandle { destroy(): void }
export interface B16Panel {
  /** a-z0-9-, unique. */
  id: string;
  /** The words on the tab / card (plain, no jargon). */
  title: string;
  /** One line under the title. */
  blurb: string;
  /** The lane that owns it. */
  lane: string;
  /** Shown in Simple mode. */
  simple?: boolean;
  /** Lower first. */
  order?: number;
  /** Draw the panel into `host`. Called when the user opens it, not before. */
  mount(host: HTMLElement): B16PanelHandle | void;
}

const panels = new Map<string, B16Panel>();
const watchers = new Set<() => void>();

export function registerB16Panel(p: B16Panel): () => void {
  if (!/^[a-z0-9-]{1,32}$/.test(p.id)) throw new Error(`Bad panel id "${p.id}"`);
  panels.set(p.id, p);
  for (const w of [...watchers]) w();
  return () => { if (panels.get(p.id) === p) { panels.delete(p.id); for (const w of [...watchers]) w(); } };
}
export const listB16Panels = (): B16Panel[] => [...panels.values()].sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || a.title.localeCompare(b.title));
/** The Live tab re-draws its list when a lane registers late. Returns the unsubscribe. */
export function onB16Panels(fn: () => void): () => void { watchers.add(fn); return () => { watchers.delete(fn); }; }
