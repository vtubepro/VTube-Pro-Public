// "When I talk" picker (src/ui/flatPanel.ts): one live tile per action, each showing the avatar's own picture doing it to
// a made-up voice (no sound: a synthetic level curve), so the choice is seen, not read. Click to switch an action on or
// off: the talk-picture swap plus any number of motions. Strength + speed sliders with Reset, and per-expression
// overrides. Saves into profile.flat.talk live (no reload: FlatAvatar reads it every frame).
import type { App } from '../app.ts';
import { VoiceGate } from '../../shared/flatAvatar.ts';
import { TALK_MOTIONS, TALK_MOTION_LABEL, TalkMotor, talkDefaults, talkFor, type FlatTalkConfig, type TalkEffect, type TalkMotion } from '../../shared/flatTalk.ts';
import { button, h, select, slider } from './dom.ts';

const TILE = 92;
type TileId = 'swap' | TalkMotion | 'none';

/** A made-up voice: phrases of syllables with pauses (deterministic in t). */
export function demoVoice(t: number): number {
  const ph = t % 2.6;
  if (ph > 1.8) return 0.02;
  const syl = Math.abs(Math.sin(ph * Math.PI * 3.2));
  return 0.25 + 0.55 * syl * (0.75 + 0.25 * Math.sin(t * 1.3));
}

function loadImg(url: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = url; });
}

/** Draw one tile frame: the picture (talk picture when `talkPic` and talking) with the talk effect applied. */
function drawTile(g: CanvasRenderingContext2D, idle: CanvasImageSource | null, talk: CanvasImageSource | null, talking: boolean, fx: TalkEffect, t: number) {
  const S = TILE;
  g.clearRect(0, 0, S, S);
  const img = (talking && talk) || idle;
  if (!img) return;
  const iw = (img as HTMLImageElement).naturalWidth || (img as HTMLCanvasElement).width || 1, ih = (img as HTMLImageElement).naturalHeight || (img as HTMLCanvasElement).height || 1;
  const k = Math.min((S * 0.78) / iw, (S * 0.78) / ih), w = iw * k, hh = ih * k;
  g.save();
  g.translate(S / 2 + fx.x * w, S - 6 - fx.y * hh);
  g.rotate(-fx.rot);
  g.scale(fx.sx, fx.sy * Math.cos(fx.lean) + 0.0001);
  if (fx.lean > 0.001) g.scale(1 + fx.lean * 0.4, 1);   // (leaning in: a touch wider, as if closer)
  const f: string[] = [];
  if (Math.abs(fx.bright) > 0.005) f.push(`brightness(${(1 + fx.bright).toFixed(3)})`);
  if (fx.glow > 0.02) f.push(`drop-shadow(0 0 ${(5 * fx.glow).toFixed(1)}px rgba(255,236,150,${(0.95 * fx.glow).toFixed(2)}))`);
  g.filter = f.join(' ') || 'none';
  g.drawImage(img, -w / 2, -hh, w, hh);
  g.restore();
  if (fx.sparkle > 0.05) {
    g.fillStyle = 'rgba(255,244,190,0.95)';
    for (let i = 0; i < 5; i++) {
      const a = (t * 0.7 + i * 0.2) % 1, x = S / 2 + Math.sin(i * 2.1 + t) * w * 0.55, y = S - 6 - hh * (0.45 + a * 0.6);
      const r = 2.4 * (1 - a) * Math.min(1, fx.sparkle);
      g.beginPath(); g.moveTo(x, y - r * 2); g.lineTo(x + r * 0.5, y); g.lineTo(x, y + r * 2); g.lineTo(x - r * 0.5, y); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(x - r * 2, y); g.lineTo(x, y + r * 0.5); g.lineTo(x + r * 2, y); g.lineTo(x, y - r * 0.5); g.closePath(); g.fill();
    }
  }
}

/** The picker. */
export function talkPicker(app: App): HTMLElement {
  const p = app.profile, fl = app.runtime?.flat;
  const root = h('div', { class: 'flat-talk' });
  if (!p?.flat || !fl) return root;
  const cfg = (): FlatTalkConfig => app.profile!.flat!.talk;
  const pictures = p.flat.kind === 'png';
  let scope = '';   // '' = every expression, else an expression id (its override)
  const exprs = fl.expressions();
  const save = () => app.edit(() => {}, false);
  const current = () => {
    const c = cfg();
    if (!scope) return { swap: c.swap, motions: c.motions };
    return talkFor(c, scope);
  };
  const setCurrent = (v: { swap: boolean; motions: TalkMotion[] }) => {
    const c = cfg();
    if (!scope) { c.swap = v.swap; c.motions = v.motions; }
    else c.perExpression[scope] = { swap: v.swap, motions: v.motions };
    save(); paintSel();
  };
  // pictures for the previews: the image set's own idle / talk, else the live picture
  let idle: CanvasImageSource | null = null, talk: CanvasImageSource | null = null;
  const lib = (f: string) => `/library/${encodeURIComponent(p.id)}/${f.split('/').map(encodeURIComponent).join('/')}`;
  if (pictures && p.flat.png) {
    void loadImg(lib(p.flat.png.idle)).then((i) => { idle = i; });
    if (p.flat.png.talk) void loadImg(lib(p.flat.png.talk)).then((i) => { talk = i; });
  } else idle = fl.source.canvas;

  const ids: TileId[] = [...(pictures ? ['swap' as const] : []), ...TALK_MOTIONS, 'none'];
  const label = (id: TileId) => (id === 'swap' ? 'Talk picture' : id === 'none' ? 'Nothing' : TALK_MOTION_LABEL[id]);
  const tiles = ids.map((id) => {
    const cv = h('canvas', { width: TILE, height: TILE, 'aria-hidden': 'true' }) as HTMLCanvasElement;
    const el = h('button', { class: 'talk-tile', type: 'button', 'data-talk': id, title: label(id), onClick: () => {
      const v = current();
      if (id === 'none') setCurrent({ swap: pictures ? false : v.swap, motions: [] });
      else if (id === 'swap') setCurrent({ swap: !v.swap, motions: v.motions });
      else setCurrent({ swap: v.swap, motions: v.motions.includes(id) ? v.motions.filter((m) => m !== id) : [...v.motions, id] });
    } }, cv, h('span', null, label(id)));
    const motor = new TalkMotor(), gate = new VoiceGate({ threshold: 0.16, hold: 0.18, attack: 0.03 });
    return { id, el, g: cv.getContext('2d')!, motor, gate };
  });
  const paintSel = () => {
    const v = current();
    for (const t of tiles) {
      const on = t.id === 'swap' ? v.swap : t.id === 'none' ? !v.motions.length && (!pictures || !v.swap) : v.motions.includes(t.id);
      t.el.classList.toggle('on', on);
      t.el.setAttribute('aria-pressed', String(on));
    }
  };
  paintSel();
  // one loop for every tile while the picker is on the page (each tile shows ITS action at the chosen strength / speed)
  let last = performance.now(), t0 = last;
  const tick = (now: number) => {
    if (!root.isConnected) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const t = (now - t0) / 1000, voice = demoVoice(t);
    const c = cfg();
    for (const tl of tiles) {
      const talking = tl.gate.step(voice, dt);
      const one: FlatTalkConfig = { ...c, swap: tl.id === 'swap', motions: tl.id === 'swap' || tl.id === 'none' ? [] : [tl.id], perExpression: {} };
      const fx = tl.motor.step(voice, talking, dt, one, null);
      drawTile(tl.g, idle, tl.id === 'swap' ? talk : null, talking, fx, t);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const c = cfg();
  root.append(
    exprs.length ? select('For', scope, [['', 'Every look'], ...exprs.map((x): [string, string] => [x.id, x.name])], (v) => { scope = v; paintSel(); }, 'Pick an expression to give it its own action (e.g. angry shakes)') : h('span'),
    h('div', { class: 'talk-tiles', role: 'group', 'aria-label': 'When I talk' }, ...tiles.map((t) => t.el)),
    slider('Strength', c.strength, 0, 1, 0.05, (v) => { cfg().strength = v; save(); }),
    slider('Speed', c.speed, 0.25, 3, 0.05, (v) => { cfg().speed = v; save(); }),
    h('div', { class: 'btns' }, button('Reset', () => { const d = talkDefaults(pictures); Object.assign(cfg(), d); save(); app.emit('avatar'); })),
    h('p', { class: 'note' }, 'Louder talking makes a bigger action (up to a limit).'),
  );
  return root;
}

export const TALK_TILE_CSS = `
.flat-talk .talk-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;margin:8px 0 10px}
.flat-talk .talk-tile{display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px 4px 6px;border-radius:10px;border:2px solid var(--line,#2c343e);background:var(--card2,#222932);color:var(--text,#e6e8eb);cursor:pointer;font:600 12px/1.25 inherit}
.flat-talk .talk-tile canvas{width:${TILE}px;height:${TILE}px;max-width:100%;border-radius:8px;background:var(--card3,rgba(127,127,127,.12))}
.flat-talk .talk-tile.on{border-color:var(--accent,#7bd88f);box-shadow:0 0 0 2px color-mix(in srgb, var(--accent,#7bd88f) 30%, transparent)}
.flat-talk .talk-tile span{text-align:center}`;
