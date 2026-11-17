// The live-caption overlay (captions.html, an OBS Browser Source): committed words arrive over /ws/captions and are only
// ever appended (shared/captions.ts CaptionView), so a word on screen never changes. No sound, no input, no camera, no
// microphone: it only listens. Options come from the address (all optional, all bounded; the text is set with
// textContent, never as HTML).
import { CaptionView, type CaptionMsg } from '../../shared/captions.ts';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number, lo: number, hi: number) => { const v = Number(q.get(k)); return q.has(k) && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const hex = (k: string, d: string) => { const v = (q.get(k) ?? '').replace(/^#/, ''); return /^[0-9a-f]{6}$/i.test(v) ? `#${v}` : d; };
const FONTS: Record<string, string> = { sans: 'system-ui, "Segoe UI", Roboto, Arial, sans-serif', serif: 'Georgia, "Times New Roman", serif', mono: 'Consolas, "Courier New", monospace', rounded: '"Trebuchet MS", "Segoe UI", sans-serif' };

const size = num('size', 44, 12, 200);
const lines = Math.round(num('lines', 2, 1, 4));
const chars = Math.round(num('chars', 38, 12, 90));
const bg = num('bg', 0.5, 0, 1);
const color = hex('color', '#ffffff');
const alignName = q.get('align') === 'left' || q.get('align') === 'right' ? q.get('align')! : 'center';
const align = ({ left: 'flex-start', right: 'flex-end', center: 'flex-start' } as Record<string, string>)[alignName];
const top = q.get('valign') === 'top';

const root = document.getElementById('cap')!;
root.style.fontSize = `${size}px`;
root.style.color = color;
root.style.alignItems = align;
// centred: a FIXED-width block in the middle (a line of `chars` characters always fits: "ch" is the width of a zero, wider than the
// average letter) and every line starts at the block's left edge, so committed words never move sideways as the line grows
if (alignName === 'center') { root.style.left = '50%'; root.style.right = 'auto'; root.style.width = `min(92%, calc(${chars}ch + 1.2em))`; root.style.transform = 'translateX(-50%)'; }
root.style.fontFamily = FONTS[q.get('font') ?? 'sans'] ?? FONTS.sans;
if (top) root.style.top = `${num('margin', 4, 0, 40)}%`; else root.style.bottom = `${num('margin', 5, 0, 40)}%`;

const view = new CaptionView({ maxChars: chars, maxLines: lines, idleMs: num('idle', 4500, 1000, 60000), showTentative: q.get('tentative') === '1' });
let shown = '';

function paint() {
  const r = view.render(Date.now());
  const sig = JSON.stringify([r.lines, r.tentative]);
  if (sig === shown) return;
  // lines already on screen are left alone; only a new last line or a longer last line is touched
  const old = shown ? (JSON.parse(shown) as [string[], string]) : [[], ''] as [string[], string];
  shown = sig;
  const kids = [...root.children] as HTMLElement[];
  const want = [...r.lines.map((t) => ({ t, tent: false })), ...(r.tentative ? [{ t: r.tentative, tent: true }] : [])];
  while (kids.length > want.length) kids.pop()!.remove();
  want.forEach((w, i) => {
    let el = kids[i];
    const fresh = !el;
    if (!el) { el = document.createElement('div'); el.className = 'ln'; root.appendChild(el); kids[i] = el; }
    if (el.textContent !== w.t) {
      // (a line that only grew keeps its place; a line that now says something else — the lines scrolled — fades in gently)
      const was = el.textContent ?? '';
      el.textContent = w.t;
      if (was && !w.tent && !el.classList.contains('tent') && !w.t.startsWith(was)) { el.classList.remove('swap'); void (el as { offsetWidth?: number }).offsetWidth; el.classList.add('swap'); }
    }
    el.classList.toggle('tent', w.tent);
    el.style.background = bg > 0 ? `rgba(0,0,0,${bg})` : 'transparent';
    if (fresh && !old[0].includes(w.t)) el.classList.add('fade');
  });
}
setInterval(paint, 80);

function onMsg(m: CaptionMsg) {
  const now = Date.now();
  // (hello: only words said a moment ago; they count from when they were said, so an old sentence is never brought back)
  if (m.type === 'hello') { view.clear(); if (m.text) view.push(m.text.split(/\s+/).map((w) => ({ w })), now - Math.min(60000, Math.max(0, m.ageMs ?? 2500))); }
  else if (m.type === 'cap') { view.push(m.words, now); view.setTentative(m.tentative, now); }
  else if (m.type === 'clear') view.clear();
  paint();
}

let backoff = 1000;
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/captions`);
  ws.onopen = () => { backoff = 1000; };
  ws.onmessage = (e) => { try { onMsg(JSON.parse(String(e.data)) as CaptionMsg); } catch { /* not ours */ } };
  ws.onclose = () => { setTimeout(connect, backoff); backoff = Math.min(15000, backoff * 1.7); };
  ws.onerror = () => ws.close();
}
connect();
