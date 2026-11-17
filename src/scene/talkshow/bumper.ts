// The interview's show-open title card ("bumper"): a curtain style (src/scene/transition/kit.ts contract) played with
// Curtain.test on every OBS page when the host hits "Show open" (the stage-mode bag's bumperSeq bumps). A marquee of
// chasing bulbs closes in over a starry late-night sky, the show title slams in with tonight's guests, then an iris
// opens on the set. Original design (no logos / characters / music of any real show).
//
// The card text travels in CurtainCard.title as "Title|Guest one, Guest two" (Curtain.test takes a room target).
import { CURTAIN_STYLES } from '../transition/styles.ts';
import { clamp01, easeInOut, easeOut, easeOutBack, fitFont, rng, seg, type CurtainFrame, type CurtainStyleDef } from '../transition/kit.ts';

export const TALK_OPEN = 'talk-open';

function draw(f: CurtainFrame) {
  const { ctx, w, h, u, phase, p } = f;
  const [title, guests] = (f.card.title || 'Late Night Live').split('|');
  const R = rng(f.seed || 7);
  const cx = w / 2, cy = h / 2;
  // coverage: 'in' closes an iris from the edges, 'out' opens one from the centre
  const cover = phase === 'in' ? easeInOut(p) : phase === 'out' ? 1 - easeInOut(p) : 1;
  if (cover <= 0.001) return;
  ctx.save();
  if (cover < 0.999) {
    const maxR = Math.hypot(cx, cy);
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.arc(cx, cy, maxR * (1 - cover), 0, Math.PI * 2, true);
    ctx.clip('evenodd');
  }
  // sky: deep blue → violet, stars, a slow spotlight sweep
  const t = f.t;
  const sky = ctx.createRadialGradient(cx, h * 1.1, 0, cx, h * 1.1, h * 1.6);
  sky.addColorStop(0, '#3a1a6b'); sky.addColorStop(0.55, '#150c35'); sky.addColorStop(1, '#05040f');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 180; i++) {
    const x = R() * w, y = R() * h * 0.85, s = (0.6 + R() * 1.8) * u, tw = 0.5 + 0.5 * Math.sin(t * (1 + R() * 3) + i);
    ctx.fillStyle = `rgba(255,255,255,${0.25 + 0.6 * tw})`; ctx.fillRect(x, y, s, s);
  }
  for (const k of [-1, 1]) {
    const a = Math.sin(t * 0.9 + k) * 0.35 + k * 0.25;
    ctx.save(); ctx.translate(cx + k * w * 0.36, h); ctx.rotate(a);
    const beam = ctx.createLinearGradient(0, 0, 0, -h * 1.2); beam.addColorStop(0, 'rgba(255,240,200,0.28)'); beam.addColorStop(1, 'rgba(255,240,200,0)');
    ctx.fillStyle = beam; ctx.beginPath(); ctx.moveTo(-18 * u, 0); ctx.lineTo(18 * u, 0); ctx.lineTo(200 * u, -h * 1.2); ctx.lineTo(-200 * u, -h * 1.2); ctx.fill();
    ctx.restore();
  }
  // the marquee: a rounded frame of chasing bulbs
  const hold = phase === 'hold' ? f.th : phase === 'out' ? 9 : 0;
  const mIn = phase === 'in' ? easeOutBack(seg(p, 0.35, 1)) : 1;
  const mw = w * 0.72 * mIn, mh = h * 0.52 * mIn, mx = cx - mw / 2, my = cy - mh / 2 - h * 0.03;
  if (mIn > 0.01) {
    ctx.fillStyle = '#1b0d2e'; ctx.strokeStyle = '#f5c542'; ctx.lineWidth = 10 * u;
    ctx.beginPath(); ctx.roundRect(mx, my, mw, mh, 36 * u); ctx.fill(); ctx.stroke();
    const n = 46, per = 2 * (mw + mh);
    for (let i = 0; i < n; i++) {
      let d = (i / n) * per, x = mx, y = my;
      if (d < mw) x += d; else if ((d -= mw) < mh) { x += mw; y += d; } else if ((d -= mh) < mw) { x += mw - d; y += mh; } else { d -= mw; y += mh - d; }
      const on = ((i + Math.floor(t * 8)) % 3) === 0;
      ctx.fillStyle = on ? '#fff6c8' : '#8a6a20';
      ctx.shadowColor = '#ffd35c'; ctx.shadowBlur = on ? 16 * u : 0;
      ctx.beginPath(); ctx.arc(x, y, 7 * u, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0;
  }
  // title slam + guests line (from the hold on; during 'in' only once the marquee is up)
  const ts = phase === 'in' ? seg(p, 0.75, 1) * 0.4 : Math.min(1, 0.4 + hold / 0.45);
  if (ts > 0 && mIn > 0.5) {
    const k = easeOutBack(clamp01(ts), 2.2);
    ctx.save(); ctx.translate(cx, my + mh * 0.44); ctx.scale(k, k);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    fitFont(ctx, title.toUpperCase(), '900', 118 * u, 'Impact, "Arial Black", sans-serif', mw * 0.86);
    ctx.lineWidth = 12 * u; ctx.strokeStyle = '#2a0d45'; ctx.strokeText(title.toUpperCase(), 0, 0);
    const tg = ctx.createLinearGradient(0, -60 * u, 0, 60 * u); tg.addColorStop(0, '#fff3b0'); tg.addColorStop(0.5, '#ffc93c'); tg.addColorStop(1, '#ff7a2a');
    ctx.fillStyle = tg; ctx.shadowColor = '#ff9a3c'; ctx.shadowBlur = 24 * u; ctx.fillText(title.toUpperCase(), 0, 0);
    ctx.restore();
  }
  const gs = phase === 'in' ? 0 : easeOut(clamp01((hold - 0.35) / 0.5));
  if (gs > 0 && guests) {
    ctx.save(); ctx.globalAlpha = gs; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9fe8ff'; fitFont(ctx, 'TONIGHT', '800', 34 * u, 'Inter, "Segoe UI", sans-serif', mw * 0.5);
    ctx.fillText('TONIGHT', cx, my + mh * 0.72);
    ctx.fillStyle = '#ffffff'; fitFont(ctx, guests.toUpperCase(), '800', 48 * u, 'Inter, "Segoe UI", sans-serif', mw * 0.84);
    ctx.fillText(guests.toUpperCase(), cx, my + mh * 0.84);
    ctx.restore();
  }
  // ON AIR light under the marquee
  if (mIn > 0.5) {
    const on = phase !== 'in' && Math.floor(t * 2) % 2 === 0;
    ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = on ? '#ff2e2e' : '#4a1010'; ctx.beginPath(); ctx.roundRect(cx - 90 * u, my + mh + 40 * u, 180 * u, 56 * u, 10 * u); ctx.fill();
    ctx.fillStyle = on ? '#fff' : '#a05050'; ctx.font = `900 ${34 * u}px Inter, "Segoe UI", sans-serif`; ctx.fillText('ON AIR', cx, my + mh + 68 * u);
    ctx.restore();
  }
  ctx.restore();
}

export const TALK_OPEN_STYLE: CurtainStyleDef = { id: TALK_OPEN, name: 'Talk show opener', theme: 'vtp', blurb: 'Marquee bulbs + the show title over a late-night sky (Interview mode’s show open)', inMul: 1.3, outMul: 1.5, draw };

// register once (the Transitions tab lists it too — it also works as a room-change card)
if (!CURTAIN_STYLES.some((s) => s.id === TALK_OPEN)) CURTAIN_STYLES.push(TALK_OPEN_STYLE);
