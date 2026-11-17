// beta.16 "throw" lane entry (docs/b16/LANES.md, docs/b16/THROW.md): Throw & Bonk (with headpat).
//
// What mounting does (and nothing else — no timers, no per-frame work until a throw happens):
//   · installs the head flinch hook (src/avatar/hitReact.ts) and the player hook (player.ts) on the avatar's late-update hook;
//   · listens to the bus: `scene` (the host's stamp in SceneState.modes.throw — every page plays the same event), `load` (which
//     avatar is this PC's performer), `command` throw / model-move / model-state, and (studio only) `chat` (which emotes chat sent);
//   · studio only: registers the rule action `throw`, the "Throw & Bonk" panel (Live → Stream extras) and the click-the-head headpat.
//
// Who stamps: the host's studio (scene.canEdit). Who plays: every page that shows this PC's own performer. A party guest's page plays
// the host's throws on the guest's avatar only when the host chose "everyone" AND the guest did not opt out (throwMayApply).
import type { B16Ctx } from '../../b16/mount.ts';
import { registerB16Panel, type B16PanelHandle } from '../../b16/panels.ts';
import type { AvatarRuntime } from '../../avatar/AvatarRuntime.ts';
import { onAvatarLate } from '../../avatar/b16Hooks.ts';
import { installHitReact, isSelfRuntime, modelStateOf, moveModel, setHitSettings, setSelfResolver } from '../../avatar/hitReact.ts';
import { DECK_ACTIONS } from '../../../shared/deck.ts';
import { chatVisible, type ChatEvent } from '../../../shared/chat.ts';
import { commandMessage, MODEL_MOVE_COMMAND, MODEL_STATE_COMMAND, replyOf, sanitizeModelMove } from '../../../shared/b16Commands.ts';
import { registerRuleAction, type RuleEvent } from '../../../shared/streamRules.ts';
import {
  DEFAULT_THROW, EmoteRing, THROW_BAG, THROW_COMMAND, THROW_LIMITS, barrageCount, eventLive, eventStart, pickImgs, sanitizeThrow, sanitizeThrowArgs,
  stampThrow, throwMayApply, unseenEvents, type ThrowArgs, type ThrowBag, type ThrowImg, type UserThrowable,
} from '../../../shared/throwables.ts';
import { ThrowPlayer } from './player.ts';
import { playImpact, soundAllowed, stopSound } from './sound.ts';
import type { ThrowPanelApi } from '../../ui/throwPanel.ts';
import { toast } from '../../ui/dom.ts';
import { installModelClick } from '../../avatar/modelClick.ts';

/** A one-line toast; a page without the toast host (a test) just goes on. */
const say = (s: string) => { try { toast(s, 'ok', 1800); } catch { /* no toast host */ } };
const OPTOUT_KEY = 'vtp.throw.optout';
/** A party member's own switch: "don't let the host throw things at me". Local to this PC, never sent anywhere. */
export const getThrowOptOut = (): boolean => { try { return localStorage.getItem(OPTOUT_KEY) === '1'; } catch { return false; } };
export const setThrowOptOut = (v: boolean) => { try { if (v) localStorage.setItem(OPTOUT_KEY, '1'); else localStorage.removeItem(OPTOUT_KEY); } catch { /* private mode */ } };

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
interface Line { id: string; kind: ChatEvent['kind']; platform: ChatEvent['platform']; user: string; uid?: string }

export function mount(ctx: B16Ctx): () => void {
  const undo: (() => void)[] = [];
  const studio = ctx.role === 'studio' && !!ctx.app;
  const app = ctx.app;
  const player = new ThrowPlayer();
  let selfKey = '@host';
  let selfAvatar = new URLSearchParams(globalThis.location?.search ?? '').get('avatar') ?? '';
  let lastSeq = -1;
  let bag: ThrowBag = { ...DEFAULT_THROW };
  let flashSafe = true;

  // ---- who is "me" on this page
  setSelfResolver((rt: AvatarRuntime) => (studio ? rt === app!.runtime : !!selfAvatar && rt.profile.id === selfAvatar && !/^party-/.test(rt.profile.id)));
  undo.push(() => setSelfResolver(null));
  undo.push(installHitReact());
  undo.push(onAvatarLate((rt) => { if ((player.busy || player.poolBuilt) && isSelfRuntime(rt)) player.tick(rt); }));
  undo.push(() => { player.dispose(); stopSound(); });

  // ---- the host's stamp -> play
  function onBag(raw: unknown, safe: boolean) {
    flashSafe = safe;
    bag = sanitizeThrow(raw);
    setHitSettings({ strength: bag.strength, returnSecs: bag.returnSecs, delayMs: bag.delayMs, ouch: bag.ouch });
    player.onSound = bag.sound && soundAllowed(ctx.role, selfKey) ? playImpact : null;
    const top = bag.evs.length ? bag.evs[bag.evs.length - 1].seq : 0;
    if (top < lastSeq) lastSeq = 0;                               // the host's bag was reset: numbering starts over
    const now = Date.now();
    for (const e of unseenEvents(bag, lastSeq)) {
      lastSeq = Math.max(lastSeq, e.seq);
      const start = eventStart(e.at, now, now);
      if (!eventLive(e, start, now)) continue;                     // an old stamp seen by a page that just opened
      if (!throwMayApply(e.target, selfKey, getThrowOptOut())) continue;
      player.play(e, start, bag, flashSafe, now);
    }
  }
  if (studio) {
    selfKey = app!.scene.selfKey;
    const read = () => { selfKey = app!.scene.selfKey; const s = app!.scene.effective; onBag(s.modes?.[THROW_BAG], s.lights?.safe !== false); };
    undo.push(app!.scene.on((what) => { if (what === 'state') read(); }));
    read();
  }

  // ---- chat memory (studio only): which emotes chat sent lately. RAM only; never shown if the line is hidden, deleted or purged
  const ring = new EmoteRing();
  const lines = new Map<string, Line>();
  let lastRaider = '';
  function onChat(evs: ChatEvent[]) {
    const cs = app!.scene.effective.chat;
    for (const c of evs) {
      if (c.kind === 'delete' || c.kind === 'purge') { ring.remove(c, lines); continue; }
      if (c.kind === 'finance' && c.fkind === 'raid') { lastRaider = c.user; continue; }
      if (c.kind !== 'chat' || (cs && (cs.hidden || !chatVisible(c, cs)))) continue;
      ring.add(c);
      lines.set(c.id, { id: c.id, kind: c.kind, platform: c.platform, user: c.user, ...(c.uid ? { uid: c.uid } : {}) });
      if (lines.size > 300) lines.delete(lines.keys().next().value!);
    }
  }

  // ---- the host's own pictures (helper list), fetched when needed
  let mine: UserThrowable[] | null = null;
  async function myPictures(): Promise<string[]> {
    if (!mine) {
      try { const r = await fetch('/api/throwables'); const j = await r.json() as { mine?: { id: string }[] }; mine = (j.mine ?? []) as UserThrowable[]; } catch { mine = []; }
    }
    return mine.map((m) => m.id);
  }
  const forgetPictures = () => { mine = null; };

  // ---- stamping a throw (the host's studio only)
  async function doThrow(a: ThrowArgs, ev?: RuleEvent | null): Promise<string> {
    const S = app!.scene;
    if (!S.canEdit) return 'Only the host can throw things';
    const cur = sanitizeThrow(S.modeBag(THROW_BAG));
    const seed = ((Math.random() * 2147483646) | 0) + 1;
    const hidden = !!S.effective.chat?.hidden;
    let what = a.what, note = '';
    let emotes: string[] = [];
    if (what === 'emote') {
      if (!hidden) {
        const user = a.from === 'redeemer' ? ev?.user : a.from === 'raider' ? (ev?.kind === 'raid' ? ev.user : lastRaider) : undefined;
        emotes = user ? ring.recent({ user }) : [];
        if (!emotes.length) emotes = ring.recent();
      }
      if (!emotes.length) note = hidden ? 'Chat is hidden, so I threw props instead' : 'No chat emotes yet, so I threw props instead';
    }
    let picked = pickImgs(what, a.item, emotes, seed);
    if (what === 'image' && !picked.imgs.length) {
      const pics = await myPictures();
      if (pics.length) picked = { ...picked, imgs: shuffle(pics, seed).slice(0, THROW_LIMITS.maxImgs).map((v): ThrowImg => ({ k: 'image', v })) };
      else { picked = pickImgs('prop', '', [], seed); what = 'prop'; note = 'You have no pictures of your own yet (Stream extras → Throw & Bonk → Add a picture), so I threw props'; }
    }
    if (picked.fellBack) what = picked.what;
    const info = ev ? ev.kind === 'money' ? { kind: ev.kind, fkind: ev.fkind, amount: ev.amount } : ev.kind === 'giftSub' ? { kind: ev.kind, count: ev.count }
      : ev.kind === 'tiktokGift' ? { kind: ev.kind, coins: ev.coins, count: ev.count } : ev.kind === 'raid' ? { kind: ev.kind, viewers: ev.viewers } : null : null;
    const n = what === 'headpat' ? 1 : barrageCount(a.count, info, cur);
    S.setModeBag(THROW_BAG, stampThrow(cur, { what, n, imgs: picked.imgs, seed }));
    const word = what === 'headpat' ? (a.item === 'boop-finger' ? 'Boop!' : 'Headpat!') : `Throwing ${n} ${n === 1 ? 'thing' : 'things'}`;
    return note ? `${word} (${note})` : word;
  }

  const busy = { at: 0 };
  const api: ThrowPanelApi = {
    bag: () => sanitizeThrow(app!.scene.modeBag(THROW_BAG)),
    setBag: (fn) => { const b = sanitizeThrow(app!.scene.modeBag(THROW_BAG)); const keep = b.evs; fn(b); app!.scene.setModeBag(THROW_BAG, sanitizeThrow({ ...b, evs: keep })); },
    canEdit: () => app!.scene.canEdit,
    throwNow: (a) => doThrow(sanitizeThrowArgs(a), null),
    optOut: { get: getThrowOptOut, set: setThrowOptOut },
    emotesSeen: () => ring.size,
    pictures: { changed: forgetPictures },
    isGuest: () => app!.scene.role === 'guest',
  };

  // ---- the bus
  undo.push(ctx.bus.on((m) => {
    switch (m.type) {
      case 'scene': {
        if (typeof m.self === 'string') selfKey = m.self;
        if (!studio) onBag(m.state?.modes?.[THROW_BAG], m.state?.lights?.safe !== false);
        break;
      }
      case 'load': if (typeof m.avatarId === 'string') selfAvatar = m.avatarId; break;
      case 'chat': if (studio) onChat(m.evs); break;
      case 'command': {
        if (m.command === THROW_COMMAND) { if (studio && app!.scene.canEdit) void doThrow(sanitizeThrowArgs(m.args), null).then(say); }
        else if (m.command === MODEL_MOVE_COMMAND) { const mv = sanitizeModelMove(m.args); if (mv) moveModel(mv); }
        else if (m.command === MODEL_STATE_COMMAND && studio) ctx.bus.send(commandMessage(replyOf(MODEL_STATE_COMMAND), modelStateOf(app!.runtime, typeof rec(m.args).req === 'string' ? rec(m.args).req as string : undefined)));
        break;
      }
    }
  }));

  if (studio) {
    // ---- a rule can throw (Redeems & Reactions: "when Bonk is redeemed, throw 5 things"), headpat included
    const def = DECK_ACTIONS.find((d) => d.id === THROW_COMMAND);
    undo.push(registerRuleAction(THROW_COMMAND, async (rc) => {
      if (!app!.scene.canEdit) return { ok: false, error: 'Only the host can throw things' };
      await doThrow(sanitizeThrowArgs(rc.params), rc.event);
      return { ok: true };
    }, { label: def?.label ?? 'Throw at my head', group: 'Stream extras', icon: def?.icon ?? '🎯', ...(def?.params ? { params: def.params } : {}), where: 'studio' }));

    // ---- the panel (Live → Stream extras)
    undo.push(registerB16Panel({
      id: 'throw', title: 'Throw & Bonk', lane: 'throw', simple: true, order: 30,
      blurb: 'Chat throws things at your head and your avatar flinches. A hand can pat it too.',
      mount(host: HTMLElement) {
        let handle: B16PanelHandle | void, dead = false;
        void import('../../ui/throwPanel.ts').then((m) => { if (!dead) handle = m.mountThrowPanel(host, api); });
        return { destroy() { dead = true; handle?.destroy(); } };
      },
    }));

    // ---- click the avatar's head: a headpat or a boop (off until the host switches it on)
    const canvas = app!.stage.canvas;
    let down: { x: number; y: number; t: number } | null = null;
    const onDown = (e: PointerEvent) => { down = e.button === 0 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null; };
    const onUp = (e: PointerEvent) => {
      const d = down; down = null;
      if (!d || bag.clickPat === 'off' || !app!.scene.canEdit) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 400 || performance.now() - busy.at < 1500) return;   // a drag (orbit) is not a click
      if (!headHit(app!, canvas, e)) return;
      busy.at = performance.now();
      void doThrow({ what: 'headpat', count: 1, item: bag.clickPat === 'boop' ? 'boop-finger' : 'pat-hand', from: 'chat' }, null);
    };
    canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointerup', onUp);
    undo.push(() => { canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp); });

    // ---- the same click also tells VTube Studio plugins (ModelClickedEvent): where, which button, which parts (the helper only forwards it while one is subscribed)
    undo.push(installModelClick({ canvas, camera: () => app!.stage.camera, root: () => app!.runtime?.model ?? null, send: (m) => ctx.bus.send(m) }));
  }

  return () => { for (const u of undo.splice(0).reverse()) { try { u(); } catch { /* best effort */ } } };
}

/** Did the click land on the avatar's head? (the face circle on screen, a little generous) */
function headHit(app: NonNullable<B16Ctx['app']>, canvas: HTMLCanvasElement, e: PointerEvent): boolean {
  const rt = app.runtime;
  const fi = rt?.faceInfo();
  if (!rt || !fi) return false;
  const cam = app.stage.camera, r = canvas.getBoundingClientRect();
  const v = fi.center.clone().project(cam);
  const cx = r.left + ((v.x + 1) / 2) * r.width, cy = r.top + ((1 - v.y) / 2) * r.height;
  const dist = cam.position.distanceTo(fi.center), pxPerM = r.height / (2 * dist * Math.tan((cam.fov * Math.PI) / 360));
  return Math.hypot(e.clientX - cx, e.clientY - cy) <= Math.max(18, fi.size * pxPerM * 0.9);
}

/** A seeded shuffle (the same seed picks the same pictures). */
function shuffle<T>(list: readonly T[], seed: number): T[] {
  const a = list.slice();
  let s = seed | 0;
  for (let i = a.length - 1; i > 0; i--) { s = (Math.imul(s, 1103515245) + 12345) | 0; const j = Math.abs(s >> 8) % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
