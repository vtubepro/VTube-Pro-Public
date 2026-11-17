// Opens Stream Deck & controllers (deck.html, docs/STREAM_DECK.md): a drawer in the studio by default, or its own
// window (src/ui/dockTools.ts). The virtual deck is always its own small window (a second monitor / OBS dock).
import { toast } from './dom.ts';
import { openTool } from './dockTools.ts';

export function openDeck(virtual = false) {
  if (!virtual) { openTool('deck'); return; }
  const w = window.open(`/deck.html${virtual ? '?virtual=1' : ''}`, virtual ? 'vtp-vdeck' : 'vtp-deck', virtual ? 'popup=yes,width=620,height=420' : 'popup=yes,width=1320,height=880');
  if (!w) toast('Your browser blocked the pop-up: allow pop-ups for this page, or open /deck.html', 'warn'); else w.focus();
}
