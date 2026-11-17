// Display mode 'overlay': the 2D avatar's canvas as a flat layer over the page's 3D view (the OBS output page: over the
// room, so the stream shows the room behind a PNGTuber the classic way). Position / scale / anchor / flip come from
// FlatOverlayDisplay; the source's cheap pose (hop, tilt, sway) is a CSS transform, so the picture is never redrawn
// for it. Pages say where overlays go with setFlatOverlayHost (output.ts: a full-page layer; the studio: its view).
// A page without a host shows overlay avatars as cards instead.
// With `stage` set (a 2.5D overlay id), the overlay's back layers go under the avatar and its front layers over it
// (overlayStage.ts, shared/overlayStage.ts).
import type { FlatOverlayDisplay } from '../../../shared/flatAvatar.ts';
import type { TalkEffect } from '../../../shared/flatTalk.ts';
import type { TrackingFrame } from '../../../shared/types.ts';
import type { FlatPose, FlatSource } from './types.ts';
import { OverlayStage } from './overlayStage.ts';

let host: HTMLElement | null = null;
/** The element overlay avatars are placed in (it must be positioned: relative / absolute / fixed); null = none. */
export function setFlatOverlayHost(el: HTMLElement | null) { host = el; }
export const flatOverlayHost = () => host;

const AX: Record<string, [number, number]> = {
  'top-left': [0, 0], top: [0.5, 0], 'top-right': [1, 0], left: [0, 0.5], center: [0.5, 0.5], right: [1, 0.5],
  'bottom-left': [0, 1], bottom: [0.5, 1], 'bottom-right': [1, 1],
};

/** Where the picture's box goes in a host of size hw × hh (px): pure, for tests. */
export function overlayRect(o: FlatOverlayDisplay, aspect: number, hw: number, hh: number): { left: number; top: number; width: number; height: number } {
  const [ax, ay] = AX[o.anchor] ?? AX['bottom-right'];
  const height = o.scale * hh, width = height * aspect;
  return { left: ax * hw - ax * width + o.x * hw, top: ay * hh - ay * height + o.y * hh, width, height };
}

export class FlatOverlay {
  readonly el: HTMLDivElement;
  private key = '';
  constructor(private src: FlatSource, private o: FlatOverlayDisplay) {
    const el = document.createElement('div');
    el.className = 'vtp-flat-overlay';
    el.style.cssText = 'position:absolute;pointer-events:none;transform-origin:50% 100%;will-change:transform;z-index:5';
    const cv = src.canvas;
    cv.style.cssText = `display:block;width:100%;height:100%;${src.pixelated ? 'image-rendering:pixelated;' : ''}`;
    el.append(cv);
    this.el = el;
    host?.append(el);
    if (o.stage) this.stage = OverlayStage.acquire(o.stage);
  }
  /** The 2.5D overlay around this avatar (o.stage), null = none. */
  readonly stage: OverlayStage | null = null;
  get attached() { return !!this.el.parentElement; }
  /** Per frame: follow the host's size, the composed pose and the talk glow / brightness (DOM writes only when something
   *  changed; sparkles are a room-card effect), and move the 2.5D overlay with the performer's head. */
  sync(p: FlatPose | undefined = this.src.pose, fx?: TalkEffect, frame?: TrackingFrame) {
    const h = host;
    if (!h) return;
    if (this.el.parentElement !== h) h.append(this.el);
    this.stage?.sync(h, frame);
    const hw = h.clientWidth || innerWidth, hh = h.clientHeight || innerHeight;
    const r = overlayRect(this.o, this.src.width / Math.max(1, this.src.height), hw, hh);
    const t = p ? `perspective(${Math.round(r.height * 2.5)}px) translate(${(p.x * r.width).toFixed(1)}px,${(-p.y * r.height).toFixed(1)}px) rotate(${(-p.rot).toFixed(4)}rad) rotateX(${(-(p.lean ?? 0)).toFixed(4)}rad) scale(${(p.sx * (this.o.flip ? -1 : 1)).toFixed(4)},${p.sy.toFixed(4)})`
      : this.o.flip ? 'scale(-1,1)' : 'none';
    const glow = fx?.glow ?? 0, br = fx?.bright ?? 0;
    const light = this.stage?.avatarFilter ?? '';
    const filter = `${light}${Math.abs(br) > 0.005 ? ` brightness(${(1 + br).toFixed(3)})` : ''}${glow > 0.01 ? ` drop-shadow(0 0 ${(r.height * 0.02 * glow).toFixed(1)}px rgba(255,238,160,${(0.9 * glow).toFixed(2)}))` : ''}`.trim() || 'none';
    const key = `${r.left.toFixed(1)}|${r.top.toFixed(1)}|${r.width.toFixed(1)}|${r.height.toFixed(1)}|${t}|${filter}`;
    if (key === this.key) return;
    this.key = key;
    const s = this.el.style;
    s.left = `${r.left}px`; s.top = `${r.top}px`; s.width = `${r.width}px`; s.height = `${r.height}px`; s.transform = t; s.filter = filter;
  }
  dispose() { this.el.remove(); this.stage?.release(); }
}
