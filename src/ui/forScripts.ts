// clarity pass (VOICE.md rule 5: no raw API calls, JSON, ports or 127.0.0.1 on the main path). Show & layout, Chat &
// events and OBS & stream always show every setting, so Simple users met lines like "POST /api/scene/cover {…}".
// The exact text stays, unchanged, behind a closed expander (dom.ts keeps a <details> open / closed across re-renders).

/** A closed "For Stream Deck & scripts" expander around a note's text / code. */
export function forScripts(...kids: (string | Node)[]): HTMLElement {
  const d = document.createElement('details');
  d.className = 'for-scripts';
  const s = document.createElement('summary');
  s.className = 'note';
  s.textContent = 'For Stream Deck & scripts';
  s.style.cursor = 'pointer';
  const p = document.createElement('p');
  p.className = 'note';
  p.append(...kids);
  d.append(s, p);
  return d;
}
