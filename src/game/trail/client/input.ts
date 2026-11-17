// The Trail — keyboard + mouse → InputFrame (30 Hz to the host) + UI actions. Pointer lock for mouse look.
//   WASD move · mouse look · Space jump · Shift sprint · LMB grab (hunting: shoot) · RMB throw · wheel hold distance
//   E interact (talk, sit, revive, hammer, paddle) · Q grab in hunts · 1–5 vote · H halt · V camera · Tab party/store
//   M map · Enter ready / continue · T epitaph · Esc release the mouse
import { BTN, type InputFrame } from '../../../../shared/trail/wire.ts';

export interface InputHooks {
  vote(i: number): void; halt(): void; camera(): void; ready(): void; tab(on: boolean): void; map(): void; epitaph(): void; escape(): void;
  /** True while a text field has focus (keys go there). */
  typing(): boolean;
  /** Hunting stop: LMB fires instead of grabbing. */
  hunting(): boolean;
  /** v2: hold G = the emote wheel; R = put the stuck wagon back on the road. */
  emote?(on: boolean): void;
  unstuck?(): void;
}

export class GameInput {
  yaw = 0; pitch = -0.1;
  hold = 0;
  /** Third-person camera distance factor (mouse wheel). */
  zoom = 1;
  private keys = new Set<string>();
  private mouse = 0;
  private seq = 0;
  private locked = false;
  sensitivity = Number(localStorage.getItem('vtp.trail.sens') || '0.0023');
  invertY = localStorage.getItem('vtp.trail.invertY') === '1';
  enabled = true;
  /** Mouse look paused (the emote wheel uses the mouse). */
  frozen = false;

  constructor(private el: HTMLElement, private hooks: InputHooks) {
    const kd = (e: KeyboardEvent) => {
      if (!this.enabled || hooks.typing()) return;
      if (e.repeat && !/^Key[WASD]$/.test(e.code)) return;
      this.keys.add(e.code);
      if (e.code === 'Tab') { e.preventDefault(); hooks.tab(true); }
      if (/^Digit[1-5]$/.test(e.code)) hooks.vote(Number(e.code.slice(5)) - 1);
      if (e.code === 'KeyH') hooks.halt();
      if (e.code === 'KeyV') hooks.camera();
      if (e.code === 'KeyM') hooks.map();
      if (e.code === 'Enter') hooks.ready();
      if (e.code === 'KeyT') { e.preventDefault(); hooks.epitaph(); }
      if (e.code === 'Escape') hooks.escape();
      if (e.code === 'KeyG') hooks.emote?.(true);
      if (e.code === 'KeyR') hooks.unstuck?.();
      if (e.code === 'Space') e.preventDefault();
    };
    const ku = (e: KeyboardEvent) => { this.keys.delete(e.code); if (e.code === 'Tab') hooks.tab(false); if (e.code === 'KeyG') hooks.emote?.(false); };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse = 0; });
    el.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (!this.locked) { el.requestPointerLock?.(); return; }
      this.mouse |= e.button === 0 ? 1 : e.button === 2 ? 2 : 0;
    });
    window.addEventListener('mouseup', (e) => { this.mouse &= ~(e.button === 0 ? 1 : e.button === 2 ? 2 : 0); });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === el; if (!this.locked) this.mouse = 0; });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled || this.frozen) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity * (this.invertY ? -1 : 1);
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
    });
    el.addEventListener('wheel', (e) => {
      if (!this.locked) return;
      e.preventDefault();
      // carrying (LMB held): hold distance · else: camera zoom
      if (this.mouse & 1) this.hold = Math.max(0.6, Math.min(4, (this.hold || 1.4) - Math.sign(e.deltaY) * 0.2));
      else this.zoom = Math.max(0.45, Math.min(2.2, this.zoom * (e.deltaY > 0 ? 1.1 : 1 / 1.1)));
    }, { passive: false });
  }
  get pointerLocked() { return this.locked; }

  /** Current intent as an input frame. */
  frame(): InputFrame {
    const k = (c: string) => this.keys.has(c);
    let mx = (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
    let mz = (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0);
    if (!this.enabled || this.hooks.typing()) { mx = 0; mz = 0; }
    let b = 0;
    if (k('Space')) b |= BTN.jump;
    if (k('ShiftLeft') || k('ShiftRight')) b |= BTN.sprint;
    if (k('KeyE')) b |= BTN.use;
    if (k('KeyC') || k('ControlLeft')) b |= BTN.crouch;
    if (k('KeyF')) b |= BTN.ping;
    const hunting = this.hooks.hunting();
    if (this.mouse & 1) b |= hunting ? BTN.fire : BTN.grab;
    if (k('KeyQ')) b |= BTN.grab;
    if (this.mouse & 2) b |= BTN.throw;
    if (this.hooks.typing()) b = 0;
    return { seq: (this.seq = (this.seq + 1) & 0xffff), mx, mz, yaw: this.yaw, pitch: this.pitch, buttons: b, hold: (b & BTN.grab) ? this.hold : 0 };
  }
  release() { if (this.locked) document.exitPointerLock?.(); }
}
