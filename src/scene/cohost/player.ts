// AI co-host (docs/b16/COHOST.md): plays one `cohost-line` on an OBS / preview page: the chat buddy's mouth moves in the rhythm
// of the words, he hops and smiles for a happy line, and the caption shows. NO SOUND here: this page is silent by design
// (src/audio/silentPage.ts); the voice plays in the studio window (src/audio/mixer/showSounds.ts) from the helper's own message.
//
// Idle = zero cost: a 100 ms timer exists only while a line is being said, the caption element only while it shows.
// The buddy belongs to the chat scene (src/scene/chatBuddy.ts, not edited): the page reaches it through window.vtpOut.chat.scene
// (the debug handle camEval.ts already reads) and uses only its public talk() / cheer(); when the buddy is not on, only the
// caption shows.
import type { CohostLine } from '../../../server/cohost/config.ts';
import { captionMs, MOOD_COLOR, mouthOpenAt, mouthSegments, type Seg } from './lines.ts';

/** What the player needs from the buddy (ChatBuddy has all of it; `talkT` / `lastTalk` are its flap clocks). */
export interface BuddyLike { shown?: boolean; talk(now: number): void; cheer(): void; talkT?: number; lastTalk?: number }

/** The page's chat buddy, or null (chat buddy off, not loaded, or a page without the chat scene). */
export function pageBuddy(win: Window = window): BuddyLike | null {
  try {
    const b = (win as unknown as { vtpOut?: { chat?: { scene?: { buddy?: BuddyLike | null } } } }).vtpOut?.chat?.scene?.buddy;
    return b && typeof b.talk === 'function' ? b : null;
  } catch { return null; }
}

const CAP_ID = 'vtp-cohost-caption';
const TICK_MS = 100;
/** The buddy's own flap lasts 0.75 s and fades; starting it again once it has faded to about 40 % keeps the mouth moving. */
const RETRIGGER_S = 0.3;

export class CohostPlayer {
  private timer = 0;
  private capEl: HTMLElement | null = null;
  private capTimer = 0;
  private seen: string[] = [];
  private startAt = 0;
  private segs: Seg[] = [];
  private endAt = 0;

  constructor(private doc: Document = document, private buddy: () => BuddyLike | null = () => pageBuddy(), private now: () => number = () => Date.now()) {}

  /** Play a line (a line with an id seen a moment ago is ignored). */
  play(line: CohostLine): boolean {
    if (this.seen.includes(line.id)) return false;
    this.seen.push(line.id); if (this.seen.length > 20) this.seen.shift();
    this.stopMouth();
    const t = this.now();
    this.startAt = t; this.endAt = t + line.ms;
    this.segs = mouthSegments(line.text, line.ms);
    const b = this.buddy();
    if (b && line.cheer) { try { b.cheer(); } catch { /* optional */ } }
    if (b) this.timer = window.setInterval(() => this.tick(), TICK_MS);
    if (line.caption) this.showCaption(line);
    return true;
  }

  /** One step of the mouth (public for the unit test). */
  tick() {
    const t = this.now() - this.startAt;
    if (this.now() >= this.endAt) { this.stopMouth(); return; }
    const b = this.buddy();
    if (!b) { this.stopMouth(); return; }
    if (mouthOpenAt(this.segs, t)) this.flap(b);
  }

  private flap(b: BuddyLike) {
    if (typeof b.talkT === 'number') { if (b.talkT > RETRIGGER_S) { b.talkT = 0; b.lastTalk = this.now(); } }
    else b.talk(this.now());
  }

  private stopMouth() { if (this.timer) { clearInterval(this.timer); this.timer = 0; } }

  private showCaption(line: CohostLine) {
    const d = this.doc;
    this.hideCaption();
    const box = d.createElement('div');
    box.id = CAP_ID;
    box.setAttribute('role', 'status');
    box.style.cssText = 'position:fixed;left:50%;bottom:7%;transform:translateX(-50%);max-width:min(80vw,1300px);padding:.45em .9em .55em;border-radius:16px;'
      + 'background:rgba(14,17,24,.84);color:#fff;font:600 clamp(16px,2.5vw,42px)/1.25 "Segoe UI",system-ui,sans-serif;text-align:center;z-index:2147483000;pointer-events:none;'
      + 'text-shadow:0 1px 2px rgba(0,0,0,.6);box-shadow:0 4px 18px rgba(0,0,0,.35);overflow-wrap:anywhere';
    const name = d.createElement('div');
    name.style.cssText = `font-size:.52em;font-weight:700;letter-spacing:.04em;color:${MOOD_COLOR[line.mood] ?? MOOD_COLOR.neutral};margin-bottom:.1em`;
    name.textContent = line.to ? `${line.name} to ${line.to}` : line.name;
    const text = d.createElement('div');
    text.textContent = line.text;                      // (text, never markup)
    box.append(name, text);
    d.body.append(box);
    this.capEl = box;
    this.capTimer = window.setTimeout(() => this.hideCaption(), captionMs(line.ms));
  }

  private hideCaption() {
    if (this.capTimer) { clearTimeout(this.capTimer); this.capTimer = 0; }
    this.capEl?.remove(); this.capEl = null;
  }

  /** Stop at once (muted, switched off, page closing). */
  stop() { this.stopMouth(); this.hideCaption(); }
  get active() { return !!this.timer || !!this.capEl; }
}
