// The AFK title card on OBS pages ("BE RIGHT BACK" / "STARTING SOON" / the host's own text): a lower-third plate drawn
// as page DOM over the room (OBS captures the whole browser source). Off unless the host picks a title
// (SceneState.afk.overlay). Sized in vh so it reads the same at any canvas size; pointer-events off; fades in / out. A long
// title wraps inside the frame (48 capitals are wider than a 16:9 canvas) instead of running off its edge.
// Cost: while no title shows the card is display:none (its running bar and its compositor layer cost the GPU nothing), and
// there is never a backdrop blur (the plate is simply a darker tint): OBS pages keep every cycle for the room.
const CSS = `
.vtp-afk { position:fixed; left:4.2vh; bottom:5.2vh; max-width:calc(100vw - 8.4vh); z-index:5; pointer-events:none; display:flex; align-items:stretch; gap:0;
  opacity:0; transform:translateY(1.2vh); transition:opacity .6s ease, transform .6s ease; font-family:"Inter","Segoe UI",system-ui,sans-serif; }
.vtp-afk.on { opacity:1; transform:none; }
.vtp-afk:not(.on) .s::after { animation-play-state:paused; }
.vtp-afk .bar { width:0.75vh; border-radius:0.4vh; background:var(--afk-accent,#F5A623); box-shadow:0 0 1.6vh var(--afk-accent,#F5A623); }
.vtp-afk .plate { margin-left:1.2vh; padding:1.3vh 2.6vh 1.5vh 2.2vh; border-radius:1.2vh; background:rgba(10,9,6,.8);
  box-shadow:0 1vh 3vh rgba(0,0,0,.45); }
.vtp-afk .t { color:#fff; font-weight:800; font-size:5.4vh; letter-spacing:.14em; line-height:1.12; overflow-wrap:anywhere; text-shadow:0 .3vh 1vh rgba(0,0,0,.5); }
.vtp-afk .s { margin-top:1vh; height:.5vh; width:14vh; border-radius:.3vh; background:rgba(255,255,255,.12); overflow:hidden; position:relative; }
.vtp-afk .s::after { content:""; position:absolute; top:0; bottom:0; width:40%; left:-40%; border-radius:.3vh; background:var(--afk-accent,#F5A623);
  animation:vtp-afk-run 2.4s ease-in-out infinite; }
@keyframes vtp-afk-run { 0% { left:-40%; } 100% { left:100%; } }
`;

/** Fade-out time (ms) before the card is taken out of the page's layout (a bit over the CSS .6 s transition). */
export const AFK_FADE_MS = 700;

export class AfkOverlay {
  private el: HTMLDivElement | null = null;
  private hideT: ReturnType<typeof setTimeout> | 0 = 0;
  private tEl: HTMLDivElement | null = null;
  private title = '';
  private accent = '';

  /** Show `title` ('' = hide) in the room's accent colour. */
  set(title: string, accent: string) {
    if (title === this.title && accent === this.accent) return;
    this.title = title; this.accent = accent;
    if (!title) {
      const el = this.el;
      if (!el) return;
      el.classList.remove('on');
      // (fade out, then out of the layout: a hidden card must not keep animating or compositing)
      clearTimeout(this.hideT || undefined);
      this.hideT = setTimeout(() => { this.hideT = 0; if (!this.title && this.el === el) el.style.display = 'none'; }, AFK_FADE_MS);
      return;
    }
    if (!this.el) {
      if (!document.getElementById('vtp-afk-css')) { const st = document.createElement('style'); st.id = 'vtp-afk-css'; st.textContent = CSS; document.head.append(st); }
      const el = document.createElement('div'); el.className = 'vtp-afk';
      const bar = document.createElement('div'); bar.className = 'bar';
      const plate = document.createElement('div'); plate.className = 'plate';
      const t = document.createElement('div'); t.className = 't';
      const s = document.createElement('div'); s.className = 's';
      plate.append(t, s); el.append(bar, plate);
      el.style.display = 'none';
      document.body.append(el);
      this.el = el; this.tEl = t;
    }
    clearTimeout(this.hideT || undefined); this.hideT = 0;
    if (this.el.style.display === 'none') { this.el.style.display = ''; void this.el.offsetWidth; }   // (so a card shown after being hidden fades in)
    this.tEl!.textContent = title;
    this.el.style.setProperty('--afk-accent', accent || '#F5A623');
    this.el.classList.add('on');
  }

  get showing() { return this.title; }

  dispose() { clearTimeout(this.hideT || undefined); this.hideT = 0; this.el?.remove(); this.el = null; this.tEl = null; this.title = ''; this.accent = ''; }
}
