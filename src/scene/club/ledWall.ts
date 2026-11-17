// The club's LED wall (CLUB_LEDWALL, a UV 0..1 plane): procedural beat-synced visuals in LED pixels + a text layer
// (the VTube Pro logo, supporters' names, the chat ticker). One shader, one small canvas redrawn only when its content
// changes; the scrolling / pulsing happens in the shader, so it costs one draw and no per-frame uploads.
import * as THREE from 'three';
import { govChannel, pageGovernor, type FlashGovernor, type GovChannel } from '../../../shared/flashGovernor.ts';

/** Whole-frame brightness of each visual as a + b·kick (the shader's kick multipliers: tunnel, equalizer,
 *  kaleidoscope, streaks, plasma) and of the text layer; the celebration flash adds 0.8 white. */
const WALL_AB: [number, number][] = [[0.4, 0.6], [0.7, 0.5], [0.6, 0.8], [1, 0.06], [0.45, 0.35]];
/** The kick / flash the wall may show now: its whole-frame brightness never turns faster than the governor allows. */
export function governWall(gov: FlashGovernor, ch: GovChannel, i: { kick: number; flash: number; mode: number; next: number; mix: number; text: number; energy?: number }): { kick: number; flash: number } {
  const ab = (m: number) => WALL_AB[Math.max(0, Math.min(4, Math.round(m)))];
  const [a0, b0] = ab(i.mode), [a1, b1] = ab(i.next), w = Math.max(0, Math.min(1, i.mix)), tx = Math.max(0, Math.min(1, i.text)) * 0.3;
  const a = (a0 + (a1 - a0) * w) * (1 - tx) + 1.2 * tx + 0.2 * (i.energy ?? 0), b = Math.max(0.01, (b0 + (b1 - b0) * w) * (1 - tx) + 0.6 * tx);
  const L = a + b * i.kick + 0.8 * i.flash;
  const y = gov.step(ch, L);
  if (y === L) return { kick: i.kick, flash: i.flash };
  if (y < a + b * i.kick) return { kick: Math.max(0, (y - a) / b), flash: 0 };
  return { kick: i.kick, flash: Math.max(0, (y - a - b * i.kick) / 0.8) };
}

export interface WallInput {
  t: number; beat: number; kick: number; energy: number;
  /** the beat the bar heights / hashes step on (default `beat`; half time under the flash limit at fast tempos) */
  step?: number;
  /** palette pair (linear colours) */
  a: THREE.Color; b: THREE.Color;
  /** visual 0..4 (+ the next one blended in by `mix`) */
  mode: number; next: number; mix: number;
  /** text layer strength 0..1, flash 0..1 (celebrations) */
  text: number; flash: number;
}

const VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAG = `
precision highp float;
varying vec2 vUv;
uniform float uT, uBeat, uStep, uKick, uEnergy, uMode, uNext, uMix, uTextAmt, uFlash, uAspect, uScroll;
uniform vec3 uA, uB;
uniform sampler2D uText;
#define PI 3.14159265
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec3 visual(float m, vec2 uv, vec2 px) {
  vec2 c = (uv - 0.5) * vec2(uAspect, 1.0);
  float r = length(c), a = atan(c.y, c.x);
  float bp = fract(uBeat);
  if (m < 0.5) {                 // frog-eye tunnel: rings flying out on the beat + two blinking eyes
    float ring = fract(r * 3.0 - uBeat * 0.5);
    float v = smoothstep(0.1, 0.0, abs(ring - 0.5) - 0.12) * (0.4 + 0.6 * uKick);
    vec3 col = mix(uA, uB, fract(r * 1.5 - uBeat * 0.25)) * v;
    for (int i = 0; i < 2; i++) {
      vec2 e = c - vec2(i == 0 ? -0.55 : 0.55, 0.05);
      float blink = step(0.93, fract(uBeat / 8.0 + float(i) * 0.02)) ;
      float eye = smoothstep(0.33, 0.3, length(e * vec2(1.0, 1.0 + blink * 6.0)));
      float pupil = smoothstep(0.13, 0.1, length(e - vec2(0.05 * sin(uT), 0.0)));
      col = mix(col, vec3(1.0) * (0.9 + 0.3 * uKick), eye * (1.0 - pupil));
      col = mix(col, vec3(0.02), pupil * eye);
    }
    return col;
  }
  if (m < 1.5) {                 // equalizer bars
    float n = 32.0; float i = floor(uv.x * n);
    float h = 0.15 + 0.7 * uEnergy * (0.5 + 0.5 * sin(i * 1.7 + uT * 3.0 + hash(vec2(i, floor(uStep * 2.0))) * 3.0)) + 0.25 * uKick * exp(-abs(i - n * 0.5) * 0.1);
    float bar = step(uv.y, h) * step(0.15, fract(uv.x * n));
    return mix(uB, uA, uv.y / max(0.01, h)) * bar * (0.7 + 0.5 * uKick) + uB * 0.05;
  }
  if (m < 2.5) {                 // lily-pad kaleidoscope
    float k = 6.0; float aa = mod(a + uT * 0.2, 2.0 * PI / k) - PI / k;
    vec2 p = vec2(cos(aa), sin(aa)) * r;
    float pad = smoothstep(0.02, 0.0, abs(length(p - vec2(0.35 + 0.08 * sin(uBeat * PI), 0.0)) - 0.12));
    float vein = smoothstep(0.012, 0.0, abs(p.y)) * step(r, 0.8);
    vec3 col = mix(uA, uB, 0.5 + 0.5 * sin(r * 8.0 - uBeat * PI));
    return col * (pad + vein * 0.6) * (0.6 + 0.8 * uKick) + col * 0.08;
  }
  if (m < 3.5) {                 // warp streaks
    float s = hash(vec2(floor(a * 30.0), 1.0));
    float z = fract(s + uT * (0.35 + 0.6 * uEnergy));
    float streak = smoothstep(0.03, 0.0, abs(r - z * 1.4)) * step(0.5, s);
    return mix(uA, uB, s) * streak * 1.6 + mix(uA, uB, r) * 0.06 * (1.0 + uKick);
  }
  // plasma waves
  float v = sin(c.x * 6.0 + uT) + sin(c.y * 5.0 - uT * 1.3) + sin((c.x + c.y) * 4.0 + uBeat * PI);
  return mix(uA, uB, 0.5 + 0.25 * v) * (0.45 + 0.35 * uKick + 0.2 * uEnergy);
}
void main() {
  // LED pixel grid: sample the picture at pixel centres, round dots with a dark grille
  vec2 grid = vec2(floor(112.0 * uAspect), 112.0);
  vec2 vuv = vec2(vUv.x, 1.0 - vUv.y);          // glTF UVs have v = 0 at the top
  vec2 cell = floor(vuv * grid);
  vec2 uv = (cell + 0.5) / grid;
  vec2 f = fract(vuv * grid) - 0.5;
  float dot = smoothstep(0.5, 0.32, length(f));
  vec3 col = mix(visual(uMode, uv, cell), visual(uNext, uv, cell), uMix);
  // text layer (logo / names / chat ticker): the canvas scrolls horizontally in its ticker band
  vec2 tuv = uv;
  if (uv.y < 0.16) tuv.x = fract(uv.x + uScroll);
  vec4 tx = texture2D(uText, tuv);
  col = mix(col * (1.0 - 0.75 * uTextAmt * tx.a), tx.rgb * (1.2 + 0.6 * uKick), tx.a * uTextAmt);
  col += vec3(1.0) * uFlash * 0.8;
  gl_FragColor = vec4(col * dot * 1.7 + col * 0.06, 1.0);
}`;

export class LedWall {
  readonly material: THREE.ShaderMaterial;
  private canvas = document.createElement('canvas');
  private tex: THREE.CanvasTexture;
  private key = '';
  /** frog art for the logo card (e.g. the room's poster atlas cell) */
  private art: { img: CanvasImageSource; sx: number; sy: number; sw: number; sh: number } | null = null;
  setArt(img: CanvasImageSource, sx: number, sy: number, sw: number, sh: number) { this.art = { img, sx, sy, sw, sh }; this.key = ''; }
  private scroll = 0;
  constructor(aspect: number) {
    this.canvas.width = Math.round(360 * Math.min(4, Math.max(1.2, aspect))); this.canvas.height = 360;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.wrapS = THREE.RepeatWrapping;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, toneMapped: false,
      uniforms: {
        uT: { value: 0 }, uBeat: { value: 0 }, uStep: { value: 0 }, uKick: { value: 0 }, uEnergy: { value: 0 }, uMode: { value: 0 }, uNext: { value: 1 }, uMix: { value: 0 },
        uTextAmt: { value: 1 }, uFlash: { value: 0 }, uAspect: { value: aspect }, uScroll: { value: 0 },
        uA: { value: new THREE.Color() }, uB: { value: new THREE.Color() }, uText: { value: this.tex },
      },
    });
    this.material.name = 'club:ledwall';
    this.draw({ kind: 'logo' });
  }

  /** the text layer: 'logo' (THE Studio ZONE), 'shout' (a big line + a small one), + an optional chat ticker */
  draw(c: { kind: 'logo' | 'shout'; big?: string; small?: string; color?: string; ticker?: string }) {
    const key = JSON.stringify(c);
    if (key === this.key) return;
    this.key = key;
    const g = this.canvas.getContext('2d')!;
    const W = this.canvas.width, H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    const glow = (txt: string, x: number, y: number, font: string, col: string, blur = 18) => {
      g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.shadowColor = col; g.shadowBlur = blur; g.fillStyle = col; g.fillText(txt, x, y);
      g.shadowBlur = 0; g.fillStyle = '#ffffff'; g.globalAlpha = 0.55; g.fillText(txt, x, y); g.globalAlpha = 1;
    };
    const band = c.ticker ? H * 0.84 : H;
    if (c.kind === 'logo' && this.art) {
      const a = this.art, hh = band * 0.92, ww = hh * a.sw / a.sh;
      g.globalAlpha = 0.95; g.drawImage(a.img, a.sx, a.sy, a.sw, a.sh, 8, band * 0.04, ww, hh);
      g.save(); g.translate(W - 8, band * 0.04); g.scale(-1, 1); g.drawImage(a.img, a.sx, a.sy, a.sw, a.sh, 0, 0, ww, hh); g.restore(); g.globalAlpha = 1;
    }
    if (c.kind === 'logo') {
      glow('THE', W * 0.2, band * 0.2, 'bold 70px Impact, "Arial Black", sans-serif', '#ff3fd2');
      glow('VTUBE PRO', W * 0.5, band * 0.52, 'bold 170px Impact, "Arial Black", sans-serif', '#8dff3a', 26);
      glow('ZONE', W * 0.8, band * 0.86, 'bold 70px Impact, "Arial Black", sans-serif', '#ff3fd2');
    } else {
      const big = (c.big ?? '').toUpperCase();
      let size = 150; g.font = `bold ${size}px Impact, "Arial Black", sans-serif`;
      while (size > 40 && g.measureText(big).width > W * 0.94) { size -= 6; g.font = `bold ${size}px Impact, "Arial Black", sans-serif`; }
      glow(big, W / 2, band * 0.45, g.font, c.color ?? '#ffd84a', 30);
      if (c.small) glow(c.small, W / 2, band * 0.82, 'bold 54px Impact, "Arial Black", sans-serif', '#ffffff', 14);
    }
    if (c.ticker) {
      g.font = 'bold 40px "Segoe UI", Arial, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(0, H * 0.84, W, H * 0.16);
      g.fillStyle = '#35e3ff'; g.shadowColor = '#35e3ff'; g.shadowBlur = 10;
      g.fillText(c.ticker, 16, H * 0.92); g.shadowBlur = 0;
    }
    this.tex.needsUpdate = true;
  }

  /** photosensitivity: the whole wall is one output on the page's governor (shared/flashGovernor.ts) */
  private ch = govChannel('club LED wall');
  update(i: WallInput, dt: number, gov: FlashGovernor = pageGovernor(performance.timeOrigin + performance.now())) {
    const u = this.material.uniforms;
    const g = governWall(gov, this.ch, i);
    u.uT.value = i.t; u.uBeat.value = i.beat; u.uStep.value = i.step ?? i.beat; u.uKick.value = g.kick; u.uEnergy.value = i.energy;
    u.uMode.value = i.mode; u.uNext.value = i.next; u.uMix.value = i.mix; u.uTextAmt.value = i.text; u.uFlash.value = g.flash;
    (u.uA.value as THREE.Color).copy(i.a); (u.uB.value as THREE.Color).copy(i.b);
    this.scroll = (i.t * 0.05) % 1; u.uScroll.value = this.scroll; void dt;
  }
  dispose() { this.material.dispose(); this.tex.dispose(); }
}
