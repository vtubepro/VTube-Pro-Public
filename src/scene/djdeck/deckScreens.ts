// DJ decks: what the screens show — the deck number, track title / artist, tempo and pitch, a scrolling 3-band
// waveform with the playhead in the middle, and the whole-track overview with the playhead. When the Track library
// knows the track on air (shared/trackShow.ts sections + DJ sync's deck follower) the overview is that track's real
// shape (its sections' energy, the drops marked); otherwise a waveform drawn from the music input as it plays.
// Canvases are repainted ~12 times a second (the engine decides), never while hidden.

export interface DeckScreenData {
  /** Deck number 1-4. */
  n: number;
  title: string;
  artist: string;
  bpm: number;
  /** Pitch, −0.08 … +0.08. */
  pitch: number;
  playing: boolean;
  onAir: boolean;
  /** 0..1 position in the track (NaN = unknown). */
  pos: number;
  /** The live waveform: newest last, 3 bands per sample (lo, mid, hi) 0..1. */
  wave: Float32Array;
  waveN: number;
  /** The known track's shape: [start 0..1, end 0..1, energy 0..1] per section, drops (0..1). */
  sections: [number, number, number][] | null;
  drops: number[];
  /** Beat phase 0..1 (the beat counter blinks). */
  beat: number;
  /** "Drop in N" (beats) when the track library knows it. */
  dropIn: number;
  accent: string;
}

const BAND = ['#2f7dff', '#ffb02e', '#f2f4ff'];
function clip(x: CanvasRenderingContext2D, s: string, max: number) {
  if (x.measureText(s).width <= max) return s;
  let t = s; while (t.length > 1 && x.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

/** The scrolling waveform (centre = now) in a box. */
function liveWave(x: CanvasRenderingContext2D, d: DeckScreenData, X: number, Y: number, W: number, H: number) {
  x.fillStyle = '#05070c'; x.fillRect(X, Y, W, H);
  const mid = Y + H / 2, n = d.waveN, half = W / 2;
  // past on the left of the playhead, the future (unknown) dimmed to the right — like a DJ app with the track ahead
  for (let px = 0; px < W; px += 2) {
    const age = (half - px) / 2;   // samples back from now (2 px per sample)
    let lo = 0, mi = 0, hi = 0;
    if (age >= 0 && age < n) { const i = (n - 1 - Math.floor(age)) * 3; lo = d.wave[i]; mi = d.wave[i + 1]; hi = d.wave[i + 2]; }
    else if (age < 0 && d.sections) {
      const p = d.pos + (-age) * 0.0004; const sec = d.sections.find((s) => p >= s[0] && p < s[1]);
      const e = sec ? sec[2] : 0.3; const r = Math.sin(px * 0.7) * 0.5 + 0.5;
      lo = e * (0.6 + 0.4 * r); mi = e * 0.5 * (0.5 + 0.5 * Math.cos(px * 0.31)); hi = e * 0.3 * r;
    }
    const a = age < 0 ? 0.35 : 1;
    const hs = [lo, mi, hi].map((v) => Math.min(1, v) * (H / 2 - 2));
    for (let b = 0; b < 3; b++) { if (hs[b] < 0.5) continue; x.globalAlpha = a * (b === 2 ? 0.9 : 0.85); x.fillStyle = BAND[b]; x.fillRect(X + px, mid - hs[b], 2, hs[b] * 2); }
  }
  x.globalAlpha = 1;
  x.fillStyle = '#ff2a3a'; x.fillRect(X + half - 1, Y, 2, H);
}

/** The whole-track overview with the playhead. */
function overview(x: CanvasRenderingContext2D, d: DeckScreenData, X: number, Y: number, W: number, H: number) {
  x.fillStyle = '#0a0d14'; x.fillRect(X, Y, W, H);
  const mid = Y + H / 2;
  for (let px = 0; px < W; px += 2) {
    const p = px / W;
    let e = 0.35 + 0.15 * Math.sin(p * 40);
    if (d.sections) { const s = d.sections.find((q) => p >= q[0] && p < q[1]); e = s ? s[2] : 0.2; e *= 0.75 + 0.25 * Math.abs(Math.sin(px * 0.9)); }
    const played = Number.isFinite(d.pos) && p < d.pos;
    x.fillStyle = played ? '#3b4253' : '#4f8cff';
    const hh = e * (H / 2 - 1);
    x.fillRect(X + px, mid - hh, 2, hh * 2);
  }
  x.fillStyle = '#ff3fd2';
  for (const dp of d.drops) x.fillRect(X + dp * W - 1, Y, 2, 5);
  if (Number.isFinite(d.pos)) { x.fillStyle = '#ffffff'; x.fillRect(X + d.pos * W - 1, Y - 2, 2, H + 4); }
}

function header(x: CanvasRenderingContext2D, d: DeckScreenData, X: number, Y: number, W: number, big: number) {
  x.fillStyle = d.onAir ? d.accent : '#2a2f3b';
  x.fillRect(X, Y, big * 1.6, big * 1.6);
  x.fillStyle = '#05070c'; x.font = `bold ${Math.round(big * 1.2)}px system-ui, sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(String(d.n), X + big * 0.8, Y + big * 0.85);
  x.textAlign = 'left'; x.textBaseline = 'alphabetic';
  const tx = X + big * 2;
  x.fillStyle = '#f4f6ff'; x.font = `600 ${Math.round(big)}px system-ui, sans-serif`;
  x.fillText(clip(x, d.title || (d.playing ? 'Playing' : 'No track'), W - big * 6.5), tx, Y + big * 0.95);
  x.fillStyle = '#9aa3b5'; x.font = `${Math.round(big * 0.72)}px system-ui, sans-serif`;
  x.fillText(clip(x, d.artist, W - big * 6.5), tx, Y + big * 1.75);
  x.textAlign = 'right';
  x.fillStyle = '#f4f6ff'; x.font = `bold ${Math.round(big * 1.1)}px system-ui, sans-serif`;
  x.fillText(d.bpm > 0 ? d.bpm.toFixed(1) : '--.-', X + W - 4, Y + big * 1.0);
  x.fillStyle = Math.abs(d.pitch) < 0.0005 ? '#39ff6a' : '#ffb02e'; x.font = `${Math.round(big * 0.7)}px system-ui, sans-serif`;
  x.fillText(`${d.pitch >= 0 ? '+' : ''}${(d.pitch * 100).toFixed(1)}%`, X + W - 4, Y + big * 1.75);
  x.textAlign = 'left';
}

/** A player's screen (two-player booth). */
export function paintPlayer(c: HTMLCanvasElement, d: DeckScreenData) {
  const x = c.getContext('2d'); if (!x) return;
  const W = c.width, H = c.height;
  x.fillStyle = '#080a10'; x.fillRect(0, 0, W, H);
  header(x, d, 8, 8, W - 16, Math.round(H * 0.1));
  liveWave(x, d, 8, H * 0.32, W - 16, H * 0.4);
  overview(x, d, 8, H * 0.78, W - 16, H * 0.13);
  // beat counter + play state
  x.fillStyle = d.playing ? '#39ff6a' : '#ffb02e'; x.font = `bold ${Math.round(H * 0.06)}px system-ui, sans-serif`;
  x.fillText(d.playing ? '▶' : '❚❚', 10, H * 0.3 - 4);
  for (let b = 0; b < 4; b++) { x.fillStyle = Math.floor(d.beat * 4) % 4 === b && d.playing ? '#ff3fd2' : '#2a2f3b'; x.fillRect(W * 0.2 + b * 14, H * 0.25, 10, 6); }
  if (d.dropIn > 0 && d.dropIn < 64) { x.fillStyle = '#ff3fd2'; x.textAlign = 'right'; x.fillText(`DROP IN ${Math.ceil(d.dropIn)}`, W - 10, H * 0.3 - 4); x.textAlign = 'left'; }
}

/** The DJ app on the laptop (one-piece controller): two decks stacked, like any DJ app's performance view. */
export function paintLaptop(c: HTMLCanvasElement, a: DeckScreenData, b: DeckScreenData) {
  const x = c.getContext('2d'); if (!x) return;
  const W = c.width, H = c.height;
  x.fillStyle = '#0b0d13'; x.fillRect(0, 0, W, H);
  const big = Math.round(H * 0.06);
  header(x, a, 6, 6, W / 2 - 12, big);
  header(x, b, W / 2 + 6, 6, W / 2 - 12, big);
  liveWave(x, a, 6, H * 0.2, W - 12, H * 0.22);
  liveWave(x, b, 6, H * 0.44, W - 12, H * 0.22);
  overview(x, a, 6, H * 0.7, W / 2 - 12, H * 0.08);
  overview(x, b, W / 2 + 6, H * 0.7, W / 2 - 12, H * 0.08);
  // a dim browser strip (no fake track list: just the shape of one)
  for (let r = 0; r < 3; r++) { x.fillStyle = r === 0 ? '#1c2232' : '#141824'; x.fillRect(6, H * 0.82 + r * H * 0.055, W - 12, H * 0.045); }
}

/** The booth's front panel, for the audience: the title on air big, its waveform strip under it. */
export function paintFacade(c: HTMLCanvasElement, d: DeckScreenData, t: number) {
  const x = c.getContext('2d'); if (!x) return;
  const W = c.width, H = c.height;
  x.fillStyle = '#05060a'; x.fillRect(0, 0, W, H);
  const title = [d.title, d.artist].filter(Boolean).join(' · ') || 'LIVE';
  x.font = `800 ${Math.round(H * 0.42)}px system-ui, sans-serif`; x.textBaseline = 'middle';
  const tw = x.measureText(title).width;
  const grad = x.createLinearGradient(0, 0, W, 0); grad.addColorStop(0, d.accent); grad.addColorStop(1, '#35e3ff');
  x.fillStyle = grad;
  if (tw <= W - 40) { x.textAlign = 'center'; x.fillText(title, W / 2, H * 0.36); x.textAlign = 'left'; }
  else { const gap = 120, off = (t * 90) % (tw + gap); x.fillText(title, 20 - off, H * 0.36); x.fillText(title, 20 - off + tw + gap, H * 0.36); }
  liveWave(x, { ...d, sections: null }, 0, H * 0.72, W, H * 0.26);
}
