// "Support & store" in the Tools menu (beta.13): the entry is registered from src/ui/laneWiring.ts with one call; the
// page itself (src/ui/supportPanel.ts) loads only when opened. window.__vtpSupport.open('store') opens a tab (tests).
import type { App } from '../app.ts';
import { toast } from './dom.ts';
import { registerTool } from './toolsMenu.ts';
import type { SupportTab } from './supportPanel.ts';

export function openSupportLazy(app: App | null, tab?: SupportTab) {
  void import('./supportPanel.ts').then((m) => m.openSupport(app, tab)).catch(() => toast('Support & store didn’t open. Reload the page and try again.', 'warn', 6000));
}

export function registerSupportTool(app: App) {
  registerTool({ id: 'support', icon: 'gift', title: 'Support & store', short: 'Tips, merch, patrons', line: 'Fourthwall, Throne, Patreon, Ko-fi, Stripe tips, Buy Me a Coffee and more, on stream.', run: () => openSupportLazy(app) });
  (window as unknown as { __vtpSupport?: unknown }).__vtpSupport = { open: (t?: SupportTab) => openSupportLazy(app, t) };
}
