// Live panel thumbnails (room cards, outfit cards, the pop-out's program picture).
//
// Always a real <img>, never a CSS background-image (a failed picture then keeps the placeholder instead of an empty box). The picture sits over a branded placeholder
// (the room icon / the outfit's initials on the brand gradient) and is only shown once it has REALLY loaded, so a
// viewer never sees a broken-image icon. A picture that failed while the helper was still linking is tried once more
// when the link settles; the panel also repaints on every helper state change (liveControl.ts), which makes new <img>s.

export const THUMB_CSS = `
.lc-thumb { position: absolute; inset: 0; display: block; overflow: hidden; }
.lc-thumb-ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: inherit; transition: opacity .25s cubic-bezier(.16, 1, .3, 1); }
.lc-thumb:not(.ok):not(.none) .lc-thumb-ph { background-image: linear-gradient(110deg, transparent 30%, color-mix(in srgb, #7bd88f 10%, transparent) 45%, color-mix(in srgb, #6cc7f5 10%, transparent) 55%, transparent 70%);
  background-size: 250% 100%; animation: lc-thumb-wait 1.6s linear infinite; }
@keyframes lc-thumb-wait { from { background-position: 125% 0; } to { background-position: -125% 0; } }
.lc-thumb img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; opacity: 0; transition: opacity .25s cubic-bezier(.16, 1, .3, 1); }
.lc-thumb.ok img { opacity: 1; }
.lc-thumb.ok .lc-thumb-ph { opacity: 0; }
@media (prefers-reduced-motion: reduce) { .lc-thumb-ph { animation: none !important; } .lc-thumb img, .lc-thumb-ph { transition: none !important; } }
`;

/** A thumbnail over its placeholder. `src` = the app's own same-origin URL (the shim routes it in web mode); null / ''
 *  = just the placeholder. States on the box: (none) loading · `ok` loaded · `none` gave up (placeholder stays). */
export function liveThumb(src: string | null | undefined, placeholder: Node | null, alt = ''): HTMLElement {
  const box = document.createElement('span');
  box.className = 'lc-thumb';
  const ph = document.createElement('span');
  ph.className = 'lc-thumb-ph';
  if (placeholder) ph.append(placeholder);
  box.append(ph);
  if (!src) { box.classList.add('none'); return box; }
  const img = document.createElement('img');
  img.alt = alt;
  img.decoding = 'async';
  img.draggable = false;
  img.dataset.src = src;
  let tries = 0;
  const fail = () => {
    box.classList.remove('ok');
    if (tries++ === 0) {
      // (web mode: the helper may still have been linking — the src setter routes it again once that is decided)
      if (box.isConnected || !box.parentNode) img.src = src;
      return;
    }
    img.remove(); box.classList.add('none');
  };
  img.addEventListener('load', () => { if (img.naturalWidth > 0) box.classList.add('ok'); else fail(); });
  img.addEventListener('error', fail);
  box.append(img);
  img.src = src;
  return box;
}
