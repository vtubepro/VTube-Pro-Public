// Output pages are SILENT (owner, beta.12: "Studio only, everything"). Every sound of the show plays in the studio
// (src/audio/mixer/showSounds.ts + the audio mixer); an OBS Browser Source, a preview iframe or a ?sceneTest page never
// makes a sound, whatever code runs in it — even an older module or a future one that forgets:
//   * every <audio> / <video> is muted: `muted` can't be turned off, setting a source or play() mutes it first;
//   * every realtime AudioContext's `destination` is a gain of 0 in front of the real one: graphs still run (the
//     narrator's level still moves its mouth), nothing reaches the speakers;
//   * speechSynthesis.speak does nothing.
// src/output.ts imports ./silentPageAuto.ts FIRST, so it is in place before anything else loads; the Trail's OBS view
// calls installPageSilence() at start.
// OfflineAudioContext (render-only, never audible) is untouched.

export interface SilenceReport { installed: boolean; media: number; mutedPlays: number; contexts: number; speech: number; unmuted: number }
const R: SilenceReport = { installed: false, media: 0, mutedPlays: 0, contexts: 0, speech: 0, unmuted: 0 };
const seenMedia = new WeakSet<HTMLMediaElement>();
const allMedia = new Set<WeakRef<HTMLMediaElement>>();

export function installPageSilence(): SilenceReport {
  if (R.installed || typeof window === 'undefined') return R;
  R.installed = true;
  const P = HTMLMediaElement.prototype;
  const mutedD = Object.getOwnPropertyDescriptor(P, 'muted')!;
  const hush = (el: HTMLMediaElement) => {
    if (!seenMedia.has(el)) { seenMedia.add(el); allMedia.add(new WeakRef(el)); R.media++; }
    mutedD.set!.call(el, true);
  };
  Object.defineProperty(P, 'muted', { configurable: true, enumerable: mutedD.enumerable, get() { return mutedD.get!.call(this); }, set(this: HTMLMediaElement) { hush(this); } });
  const dm = Object.getOwnPropertyDescriptor(P, 'defaultMuted');
  if (dm?.set) Object.defineProperty(P, 'defaultMuted', { configurable: true, enumerable: dm.enumerable, get() { return dm.get!.call(this); }, set(this: HTMLMediaElement) { dm.set!.call(this, true); hush(this); } });
  for (const k of ['src', 'srcObject', 'autoplay'] as const) {
    const d = Object.getOwnPropertyDescriptor(P, k) ?? Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, k);
    if (!d?.set) continue;
    Object.defineProperty(P, k, { configurable: true, enumerable: d.enumerable, get() { return d.get!.call(this); }, set(this: HTMLMediaElement, v: unknown) { hush(this); d.set!.call(this, v); } });
  }
  const play = P.play;
  P.play = function (this: HTMLMediaElement) { hush(this); R.mutedPlays++; return play.call(this); };
  // <audio autoplay src=…> written as HTML: mute on creation
  const ce = Document.prototype.createElement;
  Document.prototype.createElement = function (this: Document, tag: string, o?: ElementCreationOptions) {
    const el = ce.call(this, tag, o);
    if (el instanceof HTMLMediaElement) hush(el);
    return el;
  } as typeof Document.prototype.createElement;
  // new Audio(url) sets its source internally (not through the setter): mute it at birth
  const A0 = window.Audio;
  const A1 = function (this: unknown, src?: string) { const a = new A0(); hush(a); if (src !== undefined) a.src = src; return a; } as unknown as typeof Audio;
  A1.prototype = A0.prototype;
  (window as unknown as { Audio: typeof Audio }).Audio = A1;
  // setAttribute('src' | 'autoplay' | 'muted') on a media element: mute first
  const sa = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (this: Element, n: string, v: string) { if (this instanceof HTMLMediaElement) hush(this); return sa.call(this, n, v); };
  // media made in another namespace call, or written as HTML (innerHTML / outerHTML / insertAdjacentHTML): mute them
  // right after the markup is parsed (synchronously, before any autoplay can start)
  const cens = Document.prototype.createElementNS;
  Document.prototype.createElementNS = function (this: Document, ns: string | null, q: string, o?: ElementCreationOptions | string) {
    const el = cens.call(this, ns, q, o as ElementCreationOptions);
    if (el instanceof HTMLMediaElement) hush(el);
    return el;
  } as typeof Document.prototype.createElementNS;
  const hushIn = (root: Element | DocumentFragment | null) => { root?.querySelectorAll?.('audio,video').forEach((m) => hush(m as HTMLMediaElement)); };
  for (const [proto, k] of [[Element.prototype, 'innerHTML'], [Element.prototype, 'outerHTML'], [ShadowRoot.prototype, 'innerHTML']] as const) {
    const d = Object.getOwnPropertyDescriptor(proto, k);
    if (!d?.set) continue;
    Object.defineProperty(proto, k, { configurable: true, enumerable: d.enumerable, get() { return d.get!.call(this); },
      set(this: Element, v: string) { const parent = k === 'outerHTML' ? this.parentElement : null; d.set!.call(this, v); hushIn(parent ?? this); } });
  }
  const iah = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function (this: Element, w: InsertPosition, html: string) { iah.call(this, w, html); hushIn(this.parentElement ?? this); hushIn(this); };
  try { new MutationObserver((recs) => { for (const r of recs) for (const n of r.addedNodes) { if (n instanceof HTMLMediaElement) hush(n); else if (n instanceof Element) n.querySelectorAll('audio,video').forEach((m) => hush(m as HTMLMediaElement)); } }).observe(document.documentElement, { childList: true, subtree: true }); } catch { /* */ }
  // realtime audio graphs: a muted destination
  // (webkitAudioContext: the same class in Chromium; patched too where it is a separate one)
  for (const AC of new Set([(window as unknown as { AudioContext?: typeof AudioContext }).AudioContext, (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext])) {
    if (!AC) continue;
    const destD = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'destination')!;
    const muted = new WeakMap<BaseAudioContext, GainNode>();
    Object.defineProperty(AC.prototype, 'destination', {
      configurable: true, enumerable: destD.enumerable,
      get(this: AudioContext) {
        let g = muted.get(this);
        if (!g) { g = new GainNode(this, { gain: 0 }); g.connect(destD.get!.call(this) as AudioDestinationNode); muted.set(this, g); R.contexts++; }
        return g as unknown as AudioDestinationNode;
      },
    });
  }
  try {
    const ss = window.speechSynthesis;
    if (ss) ss.speak = function () { R.speech++; };
  } catch { /* */ }
  return R;
}

/** Tests / diagnostics: the guard's counts, and how many media elements are unmuted right now (must be 0). */
export function silenceReport(): SilenceReport {
  const els = new Set<HTMLMediaElement>();
  for (const w of allMedia) { const el = w.deref(); if (el) els.add(el); else allMedia.delete(w); }
  for (const el of document.querySelectorAll('audio,video')) els.add(el as HTMLMediaElement);
  let unmuted = 0;
  for (const el of els) if (!el.muted) unmuted++;
  return { ...R, unmuted };
}
