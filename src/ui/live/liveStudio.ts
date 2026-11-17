// Live Control, studio side (livedash):
//   • liveStatus: what only the studio knows (party + knocks, outfits, emotes, size, tracking / mic / OBS health),
//     published on the local bus ~1 Hz for pop-outs (never from an observer tab);
//   • the bus command 'live' (sent by the deck registry: knock approve / deny, kick, end party, guest link,
//     accessory toggle, recalibrate) — run here because the party and the tracker live in this page;
//   • the mini-bar (the pinned quick actions, shown in every other area while the camera is on or OBS shows VTube Pro;
//     its light says which: CAMERA ON / IN OBS, never a bare "ON AIR");
//   • Focus mode (stored as "streaming mode": set-up menus fade back; nothing is removed) and the Alt+L hotkey.
import type { App } from '../../app.ts';
import { EMOTES } from '../../avatar/emotes.ts';
import { avatarSize } from '../../../shared/avatarSize.ts';
import { autoCamTitle, quickActive } from '../../../shared/cameraHelp.ts';
import { LIVE_STATUS_CMD, parseCommand, sanitizeStatus, type CmdHit, type LiveSpout, type LiveStatus } from '../../../shared/liveControl.ts';
import { copyInterviewLink, revokeGuestLink } from '../guestLink.ts';
import { openTool } from '../dockTools.ts';
import { pollObs } from '../simple.ts';
import { toast } from '../dom.ts';
import { api } from '../../api.ts';
import { icon } from '../icons.ts';
import { GFX_NAMES, type GfxChoice, type SceneGfxState } from '../../../shared/graphics.ts';
import { deckClient } from './deckClient.ts';
import { AIR_TEXT, LIGHTS, airState, el, ensureLiveCss, loadLayout, mountLiveControl, openLiveTab, type LiveSource } from './liveControl.ts';
import { comboLabel, loadHideScreenKey } from '../../../shared/hotkey.ts';
import { liveHitsForQuery } from '../../../shared/liveTabs.ts';
import { openNamed } from '../wizards.ts';
import { TRACK_LOSS_LABEL, TRACK_LOSS_PARTS, sanitizeTrackLoss, type TrackLossMode, type TrackLossPart } from '../../../shared/trackLoss.ts';
import { ThumbGrabber, connOf } from '../../net/greenRoom.ts';
import { isGreenMode, presetText, type GreenEntry } from '../../../shared/greenroom.ts';
import { cleanLookPatch, lookMissed, lookOfScene, lookToSceneArgs } from '../../../shared/liveLook.ts';
import { TRACK_PART_TEXT } from '../../../shared/trackParts.ts';
import { livePictureFps } from '../previewRate.ts';
import { freshShot, type ReactShotReport } from '../../../shared/reactShot.ts';
import { postDeckAsk } from '../broadcast/goLiveTab.ts';

const testing = () => new URLSearchParams(location.search).has('livetest');

/** Quality presets for the health strip (docs/PERFORMANCE.md). */
function gfxStatus(app: App): LiveStatus['gfx'] {
  const sc = app.scene as unknown as { gfx?: SceneGfxState; report?: { gfx?: { level?: string } } | null } | undefined;
  const g = sc?.gfx;
  if (!g) return undefined;
  const nm = (c: string) => GFX_NAMES[c as GfxChoice] ?? c;
  return { obs: nm(g.obs), preview: nm(g.preview), now: sc?.report?.gfx?.level ? nm(sc.report.gfx.level) : '', lower: g.autoLower !== false, scale: g.obsScale ?? 1 };
}

/** Spout2 health of a party member (me: my own receiver; others: the feed arriving here). */
function spoutOf(app: App, id: string, me: boolean, sp: { native: boolean; alpha: boolean; app: string }): LiveSpout {
  const P = app.party;
  if (me) { const x = P.tv.source.spoutRx?.stats; return { ...sp, fps: x?.fps ?? 0, live: x ? x.state === 'live' : P.tv.source.live }; }
  const f = P.tvLinks.stats.feeds[id];
  return { ...sp, fps: f?.fps ?? 0, live: !!f && f.fps > 0 };
}

/** greenroom: tech-check thumbnails of waiting guests' cameras (RAM only; see ThumbGrabber). */
const thumbs = new ThumbGrabber();
/** Guest-camera thumbnails are only grabbed while a Live Control view that shows them asks (the studio's own Live area, a
 *  pop-out or an observer tab, each through LiveSource.wantThumbs, every second or so): a lease of 4 s. Nothing open = no
 *  hidden <video> per guest, no canvas readback, no picture in the 500 ms status. */
let thumbsUntil = 0;
const wantThumbs = () => { thumbsUntil = Date.now() + 4000; };
const thumbsWanted = () => Date.now() < thumbsUntil;
/** greenroom: one member's green room state + (while waiting) their camera thumbnail, mic level and connection. */
function greenOf(app: App, id: string): Pick<LiveStatus['party']['members'][number], 'gr'> {
  const P = app.party;
  if (P.role !== 'host') return {};
  const wait = P.green.backstage(id);
  const feed = P.tvLinks.feeds.get(id);
  const li = P.linkInfo(id);
  const media = wait ? { ...(feed ? { thumb: (thumbsWanted() ? thumbs.get(id, feed) : '') || undefined, level: Math.round(Math.min(1, feed.level) * 100) / 100 } : {}), conn: connOf({ pc: li?.pc ?? '', rtt: li?.rtt ?? 0, feed: P.tvLinks.stats.feeds[id] ?? null }) } : {};
  const gr = P.green.view(id, media);
  return gr ? { gr } : {};
}

/** moderation: what the host decided for a guest + their volume + (on air, with a camera) a small live preview. The
 *  preview is always the REAL picture (blurred by the panel while hidden), so the host sees when it's safe to bring back. */
function modOf(app: App, id: string): Pick<LiveStatus['party']['members'][number], 'mod' | 'vol' | 'cam'> {
  const P = app.party;
  if (P.role !== 'host') return {};
  const v = P.mod.view(id), feed = P.tvLinks.feeds.get(id);
  const cam = feed && !P.green.backstage(id) && thumbsWanted() ? thumbs.get(id, feed) : '';
  return { ...(v ? { mod: v } : {}), vol: P.mod.vol(id) ?? P.tv.voiceVol(id), ...(cam ? { cam } : {}) };
}

/** partyvoice: how an app guest talks (the People tile's VOICE / DISCORD / OLD APP tag). */
function voxOf(P: App['party'], id: string): Pick<LiveStatus['party']['members'][number], 'vox'> {
  const v = P.voxOf(id);
  return v === 'vox' ? { vox: 'app' } : v === 'wait' || v === 'discord' || v === 'off' || v === 'old' ? { vox: v } : {};
}

export function studioStatus(app: App): LiveStatus {
  const s = app.stats as typeof app.stats & { trackFps?: number };
  const p = app.profile, P = app.party;
  const sz = avatarSize(p);
  // (green room: waiting guests' tech check; moderation: every guest with a camera, so the host can see what they're doing)
  thumbs.keep(new Set(P.role === 'host' && thumbsWanted() ? [...P.remotes.keys()].filter((id) => P.green.backstage(id) || P.tvLinks.feeds.has(id)) : []));
  const lvl = (app.audio as unknown as { last?: { level?: number } }).last?.level ?? 0;
  const voices = P.tv.allVoices();
  return {
    v: 1, tracking: app.trackingOn, face: !!s.tracked, trackFps: s.trackFps ?? 0, fps: livePictureFps(s), mic: app.audio.active, micLevel: Math.min(1, lvl * 1.6), obs: pollObs(),
    party: {
      role: P.role,
      members: P.view().map((m) => ({ id: m.id, name: m.name, host: m.host, me: m.me, speaking: !P.mod.micOff(m.id) && (m.speaking || (P.voice.talking(m.id) && P.voiceGate(m.id) !== 'off') || (voices.has(m.id) && P.voiceGate(m.id) === 'air' && (P.tvLinks.feeds.get(m.id)?.level ?? 0) > 0.08)), tv: !!m.tv, verified: m.verified, ...(voices.has(m.id) ? { voice: true, muted: P.tv.voiceVol(m.id) <= 0 } : {}), ...voxOf(P, m.id), ...(m.tv?.spout ? { spout: spoutOf(app, m.id, m.me, m.tv.spout) } : {}), ...(m.me ? {} : greenOf(app, m.id)), ...(m.me ? {} : modOf(app, m.id)) })),
      knocks: P.knocks.map((k) => ({ peer: k.peer, name: k.user?.name ?? 'Someone', link: !!k.link })),
      joins: P.joinStates().map((j) => ({ peer: j.peer, name: j.name, link: j.link, state: j.state, secs: j.secs, lost: j.lost })),
      ...(P.turnReady === null ? {} : { turn: P.turnReady }),
      ...(P.role === 'host' ? { green: { mode: P.green.mode, sinks: P.tv.outputs, sink: P.tv.backSink, sinkOk: P.tv.sinkOk, ...(P.tv.backError ? { error: P.tv.backError } : {}) } } : {}),
      ...(P.role === 'host' ? { mod: { hold: P.mod.hold, undo: P.mod.book.history.length, ...(P.mod.lastChange ? { last: { label: P.mod.lastChange.label, at: P.mod.lastChange.at, kind: P.mod.lastChange.kind } } : {}) } } : {}),
    },
    me: {
      ...(P.tv.appear === 'tv' && P.tv.source.live && P.tv.source.settings.via ? { spout: spoutOf(app, P.myId, true, P.tv.source.info().spout ?? { native: false, alpha: false, app: '' }) } : {}),
      avatar: p?.name ?? '', size: sz.cls, height: sz.height, outfit: p?.costume ?? null,
      outfits: (p?.costumes ?? []).filter((c) => c.kind !== 'accessory').map((c) => ({ id: c.id, name: c.name, ...(c.thumbnail && p ? { thumb: api.pathUrl(p.id, c.thumbnail) } : {}) })),
      accessories: (p?.costumes ?? []).filter((c) => c.kind === 'accessory').map((c) => ({ id: c.id, name: c.name, on: (p?.accessories ?? []).includes(c.id) })),
    },
    emotes: EMOTES.map((e) => ({ id: e.id, label: e.label })),
    gfx: gfxStatus(app),
    ...((app.scene.scenes.find((x) => x.id === app.scene.effective.sceneId) as unknown as { ttrpg?: unknown } | undefined)?.ttrpg ? { table: true } : {}),
    cams: ((app.scene as unknown as { report?: { room?: { cameras?: string[] } } | null }).report?.room?.cameras ?? []).filter((c) => /^CAM_/.test(c)),
    voice: { hear: P.tv.hear, talkback: P.tv.returnVoice.on, error: P.tv.returnVoice.error, mic: P.tv.returnVoice.label ?? '', level: P.tv.returnLevel(), mics: P.tv.mics, micSel: P.tv.returnVoice.mic, mix: P.voice.mixInfo() },
    // React: is the React screen in the live camera's shot? (the studio preview measures it; stale = unknown)
    ...(() => { const sh = freshShot((app.scene as unknown as { report?: { shot?: ReactShotReport | null } | null }).report?.shot); return sh ? { reactShot: sh } : {}; })(),
  };
}

/** The 'live' bus command (shared/deck.ts planRun): things only this page can do. */
async function liveCommand(app: App, a: Record<string, unknown>) {
  const P = app.party;
  switch (a.op) {
    case 'approve': { const k = (typeof a.peer === 'string' && P.knocks.find((x) => x.peer === a.peer)) || P.knocks[0]; if (k) await P.approve(k); else toast('Nobody is knocking', 'info', 1500); break; }
    case 'deny': { const k = (typeof a.peer === 'string' && P.knocks.find((x) => x.peer === a.peer)) || P.knocks[0]; if (k) P.deny(k); break; }
    case 'kick': {
      const others = P.view().filter((m) => !m.me);
      const m = typeof a.peer === 'string' ? others.find((x) => x.id === a.peer) : others[Math.round(Number(a.guest)) - 1];
      const ban = a.ban === true, link = !!m && /^link/.test(P.remotes.get(m.id)?.discord?.id ?? '');
      if (m && P.role === 'host') {
        P.kick(m.id, ban);
        toast(ban ? `Removed and blocked ${m.name}${link ? ' (this browser tab can’t come back; to stop the link for everyone: Turn link off)' : ''}` : `Removed ${m.name}`, 'ok', ban && link ? 5000 : 2000);
        if (a.revoke === true) await revokeGuestLink(app);
      } else toast(P.role === 'host' ? 'No such party member' : 'Only the host can kick', 'warn', 2000);
      break;
    }
    // moderation (shared/moderation.ts): instant, no confirm, Undo-able
    case 'mute': case 'cam': case 'vol': case 'cut': case 'cutall': case 'modundo': case 'modhold': case 'linkoff': await modCommand(app, a); break;
    case 'end': if (P.role !== 'none') { P.leave('The host ended the party'); toast('Party ended', 'ok', 2000); } break;
    // ---- greenroom (shared/deck.ts greenroom-*): bring on / back / next guest, messages, backstage voice, settings
    case 'gr-on': case 'gr-back': case 'gr-next': case 'gr-msg': case 'gr-talk': case 'gr-mode': case 'gr-sink': greenCommand(app, a); break;
    case 'guestlink': await copyInterviewLink(app); break;
    // a pop-out / observer tab that shows guest thumbnails asks for them (see wantThumbs)
    case 'thumbs': wantThumbs(); break;
    // link guests' voices: hear them in the studio / send mine back ({on: bool | 'toggle'})
    case 'mixresume': { P.voice.resumeMix(); setTimeout(() => toast(P.voice.mixState === 'running' ? 'Guests can hear each other now' : 'Still paused: click once inside the studio window (the pop-out can’t start it)', P.voice.mixState === 'running' ? 'ok' : 'warn', 3200), 300); break; }
    // (an old "Also on OBS" key: guests play only in the studio now — owner rule — so it changes nothing)
    case 'obsvoice': toast('Guests play only here in the studio: VTube Pro never sends their voice to OBS', 'info', 3200); break;
    case 'hear': { const on = a.on === 'toggle' || a.on === undefined ? !P.tv.hear : !!a.on; P.tv.setHear(on); toast(on ? 'You hear your guests here (headphones!)' : 'Guests are off in the studio — VTube Pro plays them nowhere else (never on the OBS page)', on ? 'ok' : 'warn', 3600); break; }
    case 'talkmic': {   // talk-back mic ('' = same as lip sync)
      const id = typeof a.id === 'string' ? a.id : '';
      await P.tv.setTalkbackMic(id);
      const nm = id ? P.tv.mics.find((m) => m.id === id)?.label ?? 'that mic' : 'the same mic as lip sync';
      if (P.tv.returnVoice.error) toast(`Mic for guests: ${P.tv.returnVoice.error}`, 'err', 5000); else toast(`Link guests hear: ${nm}`, 'ok', 2200);
      break;
    }
    case 'talkback': {
      const on = a.on === 'toggle' || a.on === undefined ? !P.tv.returnVoice.on : !!a.on;
      await P.tv.setTalkback(on);
      if (P.tv.returnVoice.error) toast(`Mic for guests: ${P.tv.returnVoice.error}`, 'err', 5000); else toast(on ? 'Link guests hear you' : 'Link guests no longer hear you', 'ok', 2200);
      break;
    }
    case 'accessory': if (typeof a.id === 'string') await app.setAccessory(a.id, !(app.profile?.accessories ?? []).includes(a.id)); break;
    case 'recalibrate':
      if (!app.trackingOn) { toast('Start tracking first', 'warn'); break; }
      toast('Recalibrating — relax your face and look at the camera', 'info', 2600); app.face.calibrate(2.5); break;
    case 'trackloss': {
      // per avatar profile (profile.tracking.trackLoss); body / hands have no voice life (it means rest there)
      const cur = sanitizeTrackLoss(app.profile?.tracking.trackLoss);
      const parts: TrackLossPart[] = a.part === 'all' || typeof a.part !== 'string' ? [...TRACK_LOSS_PARTS] : TRACK_LOSS_PARTS.filter((p) => p === a.part);
      const order: TrackLossMode[] = ['hold', 'rest', 'life'];
      const mode: TrackLossMode = a.mode === 'cycle' ? order[(order.indexOf(cur.modes[parts[0] ?? 'face']) + 1) % 3] : (order.includes(a.mode as TrackLossMode) ? a.mode as TrackLossMode : 'hold');
      if (!app.profile || !parts.length) break;
      app.edit((p) => { const c = sanitizeTrackLoss(p.tracking.trackLoss); for (const k of parts) c.modes[k] = mode; p.tracking.trackLoss = c; }, false);
      toast(`When tracking is lost: ${TRACK_LOSS_LABEL[mode]}${parts.length === 1 ? ` (${parts[0]})` : ''}`, 'ok', 2000);
      break;
    }
  }
}

/** greenroom / moderation: send `id` back to the green room — in a room with walk-ins on they walk out first (their voice
 *  goes backstage at once). */
function holdInGreen(app: App, id: string) {
  const sc = app.scene, G = app.party.green;
  const st = sc.effective, walk = st.entrances?.walk !== false;
  const inRoom = !!st.sceneId && st.present[id] !== false && st.spots[id] !== undefined;
  if (inRoom && walk) { sc.setPresent(id, false, 'walk'); return G.back(id, 3500); }
  return G.back(id);
}

/** moderation: the 'live' ops (camera / mute / volume / cut / cut all / undo). Enforced in this page (the party lives here). */
export async function modCommand(app: App, a: Record<string, unknown>) {
  const P = app.party, M = P.mod;
  if (P.role !== 'host') { toast('Only the host can turn guests’ cameras and mics off', 'warn', 2400); return; }
  const others = P.view().filter((m) => !m.me);
  const id = typeof a.peer === 'string' && a.peer ? a.peer : Number(a.guest) >= 1 ? others[Math.round(Number(a.guest)) - 1]?.id ?? '' : '';
  const name = others.find((m) => m.id === id)?.name ?? 'Guest';
  const want = (cur: boolean) => (a.on === 'toggle' || a.on === undefined ? !cur : !!a.on);
  const need = () => { if (!id || !P.remotes.has(id)) { toast('No such guest', 'warn', 1800); return false; } return true; };
  const done = (msg: string) => toast(`${msg} · Undo in Live → People`, 'ok', 2600);
  switch (a.op) {
    case 'cam': {
      if (!need()) return;
      const hide = want(M.camOff(id));
      if (M.setCam(id, hide)) done(hide ? `${name}: camera hidden from the show${P.tvOf(id) ? '' : ' (avatar out of the room)'}` : `${name}: camera back on`);
      return;
    }
    case 'mute': {
      if (!need()) return;
      const mute = want(M.micOff(id));
      if (M.setMic(id, mute)) {
        done(`${name}: ${mute ? 'muted' : 'unmuted'}`);
        // (their voice through Discord never touches VTube Pro: say so instead of pretending)
        if (mute && P.voxOf(id) === 'discord') toast(`${name} talks through Discord: also server-mute them there (right-click → Server Mute)`, 'warn', 6000);
      }
      return;
    }
    case 'vol': { if (!need()) return; M.setVol(id, Number(a.vol)); return; }
    case 'cut': {
      if (!need()) return;
      const cut = want(M.isCut(id));
      if (cut) {
        M.cut(id);
        if (M.hold && !P.green.hidden(id)) holdInGreen(app, id);
        done(`${name}: camera and mic cut${M.hold ? ' · held in the green room' : ''}`);
      } else if (M.restore(id)) done(`${name}: back on`);
      return;
    }
    case 'cutall': {
      const back = a.on === false || (a.on === 'toggle' && others.length > 0 && others.every((m) => M.isCut(m.id)));
      if (!others.length) { toast('No guests to cut', 'info', 1600); return; }
      if (M.cutAll(back)) {
        if (!back && M.hold) for (const m of others) if (!P.green.hidden(m.id)) holdInGreen(app, m.id);
        done(back ? 'Every guest is back on' : `Cut all guests (${others.length}): cameras and mics off`);
      } else toast(back ? 'Nobody is cut' : 'Everyone is already cut', 'info', 1600);
      return;
    }
    case 'modundo': { const c = M.undo(); toast(c ? `Undone: ${c.label}` : 'Nothing to undo', c ? 'ok' : 'info', 2200); return; }
    case 'modhold': { const on = a.on === 'toggle' || a.on === undefined ? !M.hold : !!a.on; M.setHold(on); toast(on ? 'Cut also sends the guest back to the green room' : 'Cut keeps the guest in place (camera card + muted)', 'ok', 2400); return; }
    case 'linkoff': await revokeGuestLink(app); return;
  }
}

/** greenroom: the 'live' ops of the green room (the party + the scene live in this page). */
export function greenCommand(app: App, a: Record<string, unknown>) {
  const P = app.party, G = P.green;
  if (P.role !== 'host') { toast('Only the host has a green room', 'warn', 2200); return; }
  const others = P.view().filter((m) => !m.me);
  const nameOf = (id: string) => others.find((m) => m.id === id)?.name ?? G.entry(id)?.name ?? 'Guest';
  /** The member a command names (peer id / party member #), else the default pick. */
  const who = (dflt: () => GreenEntry | null): string => typeof a.peer === 'string' && a.peer ? a.peer : Number(a.guest) >= 1 ? others[Math.round(Number(a.guest)) - 1]?.id ?? '' : dflt()?.id ?? '';
  const sendBack = (id: string) => holdInGreen(app, id);
  switch (a.op) {
    case 'gr-on': {
      const id = who(() => G.next());
      if (!id) { toast('Nobody is waiting in the green room', 'info', 2000); break; }
      if (!G.hidden(id)) { toast(`${nameOf(id)} is already on`, 'info', 1800); break; }
      if (G.bringOn(id)) toast(`${nameOf(id)} is coming on`, 'ok', 2200);
      break;
    }
    case 'gr-back': {
      const id = who(() => G.lastOn());
      if (!id || !P.remotes.has(id)) { toast('No guest on air to send back', 'info', 2000); break; }
      if (G.hidden(id)) { toast(`${nameOf(id)} is already in the green room`, 'info', 1800); break; }
      if (sendBack(id)) toast(`${nameOf(id)} → green room`, 'ok', 2000);
      break;
    }
    case 'gr-next': {
      const nx = G.next(), last = G.lastOn();
      if (!nx?.id) { toast('Nobody is waiting in the green room', 'info', 2000); break; }
      if (last?.id) sendBack(last.id);
      G.bringOn(nx.id);
      toast(`${last?.id ? `${nameOf(last.id)} → green room · ` : ''}${nameOf(nx.id)} is coming on`, 'ok', 2600);
      break;
    }
    case 'gr-msg': {
      const text = typeof a.text === 'string' ? a.text : '', preset = typeof a.preset === 'string' ? a.preset : '';
      const ids = a.to === 'all' ? [...G.book.entries.values()].filter((e) => e.stage === 'wait' && e.id).map((e) => e.id!)
        : a.to === 'last' ? [G.lastOn()?.id ?? ''] : a.to === 'next' ? [G.next()?.id ?? ''] : [who(() => null)];
      const to = ids.filter(Boolean);
      if (!to.length) { toast(a.to === 'last' ? 'No guest on air' : 'Nobody is waiting in the green room', 'info', 2000); break; }
      const errs = to.map((id) => [id, G.message(id, text, preset)] as const).filter(([, e]) => e);
      const msg = preset ? presetText(preset) : text;
      if (errs.length === to.length) toast(errs[0][1], 'warn', 3500);
      else toast(`Sent “${msg.slice(0, 60)}” to ${to.length === 1 ? nameOf(to[0]) : `${to.length - errs.length} guests`}${errs.length ? ` (${errs.length} couldn’t get it)` : ''}`, 'ok', 2400);
      break;
    }
    case 'gr-talk': {
      const id = who(() => [...G.book.entries.values()].find((e) => e.stage === 'wait' && e.id) ?? null);
      if (!id) { toast('Nobody is waiting in the green room', 'info', 2000); break; }
      const on = a.on === 'toggle' || a.on === undefined ? !G.entry(id)?.talk : !!a.on;
      if (!G.setTalk(id, on)) { toast('Backstage voice is only for guests waiting in the green room', 'warn', 2600); break; }
      if (!P.tvLinks.voices.has(id) && on) toast(`${nameOf(id)} has no voice on the link (they talk in Discord, or their mic is off): you’ll only be heard`, 'warn', 4000);
      else if (on && (!P.tv.sinkOk || !P.tv.backSink)) toast(P.tv.sinkOk ? 'Backstage voice plays on your DEFAULT output — if OBS captures Desktop Audio, pick headphones OBS doesn’t capture (People → Backstage output)' : 'This browser can’t pick an output: backstage voice plays on the default output (OBS Desktop Audio may capture it)', 'warn', 6000);
      else toast(on ? `Talking backstage with ${nameOf(id)} (only you two)` : `Backstage voice with ${nameOf(id)} off`, 'ok', 2200);
      break;
    }
    case 'gr-mode': if (isGreenMode(a.mode)) { G.setMode(a.mode); toast(a.mode === 'off' ? 'New guests come straight in' : a.mode === 'all' ? 'Every new guest waits in the green room' : 'New link guests wait in the green room', 'ok', 2400); } break;
    case 'gr-sink': { const id = typeof a.id === 'string' ? a.id : ''; P.tv.setBackSink(id); toast(`Backstage voice plays on: ${id ? P.tv.outputs.find((d) => d.id === id)?.label ?? 'that output' : 'the default output'}`, 'ok', 2400); break; }
  }
}

// ---------------------------------------------------------------- streaming mode
const SM_KEY = 'vtp.live.streaming';
const smGet = () => { try { return localStorage.getItem(SM_KEY) === '1'; } catch { return false; } };
function smApply(on: boolean) { document.body.classList.toggle('vtp-streaming', on); }
// (clarity: shown as "Focus mode": a button called "Streaming" read as "start streaming". It never touches the stream.)
export const streamingMode = { get: smGet, set(on: boolean) { try { localStorage.setItem(SM_KEY, on ? '1' : '0'); } catch { /* off */ } smApply(on); document.dispatchEvent(new CustomEvent('vtp-live-layout')); toast(on ? 'Focus mode on: set-up menus fade back (still one click away). Your stream isn’t affected.' : 'Focus mode off', 'info', 2800); } };
const SM_CSS = `
body.vtp-streaming .rail-btn[data-setup] { opacity: .32; filter: grayscale(1); }
body.vtp-streaming .rail-btn[data-setup]:hover, body.vtp-streaming .rail-btn[data-setup].on { opacity: 1; filter: none; }
body.vtp-streaming #topbar .seg { opacity: .4; }
/* livepremium: the mini-bar (camera on / in OBS), styled like the console */
.lc-mini { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px; margin: 0 0 8px; border-radius: 12px; background: var(--lc-bg2); box-shadow: var(--lc-shadow); font-size: 12.5px; }
.lc-mini .lc-air { height: 24px; font-size: 10.5px; padding: 0 10px 0 8px; cursor: pointer; border: 0; }
.lc-mini .lc-btn { height: 24px; padding: 0 9px; font-size: 12px; border-radius: 6px; }
.lc-mini .sep { width: 1px; height: 16px; background: var(--lc-edge2); margin: 0 2px; }
.lc-mini-states { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--lc-bg1); box-shadow: 0 0 0 1px var(--lc-edge) inset; }
/* (clarity: the lit lighting state is the accent, not the red "on air" tally; red means only "OBS is showing VTube Pro") */
.lc-mini-states .lc-btn.on { background: color-mix(in srgb, var(--lc-acc) 22%, var(--lc-bg3)); box-shadow: 0 0 0 1px var(--lc-acc) inset; }
.lc-mini .lc-lbl { font-size: 10px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; color: var(--lc-faint); margin: 0 2px 0 4px; }
/* livepremium: Live takes the whole workspace; the studio view becomes the console's PROGRAM monitor */
body.lc-console:not(.clean) #app { grid-template-columns: var(--rail-w) 1fr !important; }
body.lc-console:not(.clean) .pane-div { display: none !important; }
body.lc-console:not(.clean):not(.vp-hidden) #viewport { position: fixed !important; left: var(--pgm-x, 0) !important; top: var(--pgm-y, 0) !important; right: auto !important; bottom: auto !important;
  width: var(--pgm-w, 480px) !important; height: var(--pgm-h, 270px) !important; z-index: 60; border-radius: 10px; overflow: hidden; box-shadow: none !important; }
body.lc-console:not(.clean) #viewport :is(.viewbar, .vp-grab) { display: none !important; }
body.lc-console:not(.clean) #hud .meters { display: none !important; }
/* clarity: the studio view is the big picture in Live; the webcam self-view never goes to OBS, so it isn't drawn there
   (people saw their own camera inside a red "ON AIR" frame and thought it was being broadcast) */
body.lc-console:not(.clean) #campip { display: none !important; }
body.lc-console:not(.clean) .area-body[data-ui="simple:onair"] { overflow: hidden !important; display: flex; flex-direction: column; }
body.lc-console:not(.clean) .area-body[data-ui="simple:onair"] > .lc { flex: 1; }
body.lc-console:not(.clean) .area-head :is(h2, .sub) { display: none !important; }
body.lc-console:not(.clean) .area-head { padding-top: 10px !important; padding-bottom: 6px !important; min-height: 0 !important; }
body:not(.lc-console) #viewport > :is(.lc-pgm-tag, .lc-lt) { display: none; }
.rail-btn.onair-live { box-shadow: inset 3px 0 0 #ff5a5a; }
.rail-btn.onair-cam { box-shadow: inset 3px 0 0 var(--accent, #7bd88f); }
`;

export interface LiveStudio {
  /** Render the Live area into `body`. */
  view(body: HTMLElement): void;
  /** The on-air mini-bar element (the shell puts it above other areas). */
  miniBar: HTMLElement;
  /** Ctrl+K: actions matching the typed text (shell's search box). */
  actions(q: string): { t: string; where: string; run(): void }[];
  /** The studio is in use = the camera is on or OBS shows VTube Pro (mini-bar; the helper holds updates). Not "live". */
  onAir(): boolean;
  /** OBS is showing VTube Pro right now (an output page inside OBS; older versions: any output page). */
  inObs(): boolean;
  /** The live status (this studio's own, or the real studio's mirrored into an observer tab): the show dock reads it. */
  status(): LiveStatus;
}

export function initLiveStudio(app: App, go: () => void): LiveStudio {
  ensureLiveCss();
  document.head.append(el('style', { id: 'vtp-live-studio' }, SM_CSS));
  smApply(smGet());
  const canRun = !app.observer || testing();
  const deck = deckClient();
  let status = studioStatus(app);
  const subs = new Set<() => void>();
  let lastPub = '', pubAt = 0;
  window.setInterval(() => {
    if (!(app.observer && Date.now() - mirrorAt < 3000)) status = studioStatus(app);
    const sig = JSON.stringify({ ...status, trackFps: 0, fps: 0, micLevel: 0 });
    for (const s of subs) s();
    paintMini(); // (its light follows the camera / OBS; cheap when nothing changed)
    if (app.observer && !testing()) return; // an observer tab never speaks for the studio
    const now = Date.now();
    if (sig !== lastPub || now - pubAt > 1000) { lastPub = sig; pubAt = now; app.bus.send({ type: 'command', command: LIVE_STATUS_CMD, args: status }); }
  }, 500);
  // livepremium: an observer tab mirrors the real studio's status (party, outfits, health) instead of its own empty one
  let mirrorAt = 0;
  if (app.observer) app.bus.on((m) => {
    if (m.type !== 'command' || m.command !== LIVE_STATUS_CMD) return;
    status = sanitizeStatus(m.args); mirrorAt = Date.now(); for (const s of subs) s();
  });
  app.bus.on((m) => {
    if (m.type !== 'command' || m.command !== 'live') return;
    if (app.observer && !testing()) return;
    void liveCommand(app, (m.args ?? {}) as Record<string, unknown>).catch((e) => toast(`Live: ${(e as Error).message}`, 'err'));
  });
  // A Stream Deck Go Live key press: the helper ASKS (server/deck.ts), the studio opens the Go Live tab with a card. This can only
  // open a card (or take it down): the stream starts only if the person clicks on that card, and the helper checks the real key press.
  app.bus.on((m) => {
    if (m.type !== 'command' || app.observer) return;
    if (m.command === 'golive-cancel') { postDeckAsk(null); return; }
    if (m.command !== 'golive-ask') return;
    const a = (m.args ?? {}) as { pressedAt?: unknown; expiresAt?: unknown };
    if (typeof a.pressedAt !== 'number' || typeof a.expiresAt !== 'number') return;
    postDeckAsk({ pressedAt: a.pressedAt, expiresAt: a.expiresAt });
    openLiveTab('golive'); go();
  });
  window.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && e.code === 'KeyL') { e.preventDefault(); go(); }
  });
  // greenroom: a guest says they're READY / sends a note → a studio toast (the People tile shows the badge + text too);
  // an app guest gets the host's messages as a toast (+ Multiplayer panel history)
  if (!app.observer) {
    app.party.green.onGuest = (ev) => {
      const e = ev.entry, where = e.stage === 'wait' ? ' (green room)' : '';
      if (ev.kind === 'ready') { if (e.ready?.on) toast(`${e.name} is READY${where}${e.ready.text ? `: “${e.ready.text}”` : ''}`, 'ok', 6000); else toast(`${e.name} is no longer ready`, 'info', 2500); }
      else if (ev.kind === 'note' && e.note) toast(`${e.name}${where}: “${e.note.text}”`, 'info', 7000);
    };
    app.party.green.onMessage = (text) => toast(`Message from ${app.party.hostInfo?.name ?? 'the host'}: ${text}`, 'info', 9000);
    // clarity: your mic starts going to a link guest by itself: say so, and where to turn it off
    app.party.tv.onAutoTalk = () => toast('Your guest can hear you now. Turn it off in Live → Audio → They hear me.', 'info', 7000);
  }

  // live-tabs BRB (shared/brb.ts): while the lighting is BRB, every guest is silent on stream and in the other guests'
  // mixes (a layer in src/net/moderation.ts — the host's own per-guest mutes are untouched and come back exactly)
  const brbSync = () => {
    const on = app.scene.effective.lights?.state === 'brb', P = app.party;
    if (on === P.mod.brbQuiet) return;
    P.mod.setBrbQuiet(on);
    const n = P.role === 'host' ? P.view().filter((m) => !m.me).length : 0;
    if (n) toast(on ? `BRB: your ${n === 1 ? 'guest is' : `${n} guests are`} muted on stream until you're back` : 'Back from BRB: guests can be heard again (the ones you muted stay muted)', 'info', 3200);
  };
  app.scene.on((what) => { if (what === 'state') brbSync(); });
  brbSync();

  // (tests only, ?observer=1&livetest: read the studio's own hider / BRB state — tools/live_look_e2e.mjs)
  if (testing()) (window as unknown as { vtpLookState?: () => unknown }).vtpLookState = () => ({ capcover: app.scene.effective.capcover ?? null, brb: app.scene.effective.brb ?? null });
  let observerAsk = 0;
  const src = (): LiveSource => ({
    status: () => status, onStatus: (cb) => { subs.add(cb); }, canRun, popout: false, streaming: streamingMode,
    // (this studio asks itself; an observer tab asks the real studio over the bus, at most every 1.5 s)
    wantThumbs: () => {
      if (!app.observer) { wantThumbs(); return; }
      const t = Date.now(); if (t - observerAsk < 1500) return;
      observerAsk = t; app.bus.send({ type: 'command', command: 'live', args: { op: 'thumbs' } });
    },
    copyLink: () => void copyInterviewLink(app), openChat: () => openTool('chathub'), toast: (msg, kind = 'info') => toast(msg, kind === 'info' ? 'info' : kind, 3000),
    program: programMonitor,
    // live-tabs: OBS tab → "Set up OBS automation" when the obs-wizard isn't there (yet): the studio's own OBS set-up
    obsWizard: () => { openNamed(app, 'firstRun', 'obs'); },
    // live-layout (owner bug: the hider / BRB pickers fell back to the first one): the look lives in THIS studio's scene
    // state — set and read back here, whatever version the helper is (shared/liveLook.ts explains the old path)
    look: {
      get: () => lookOfScene(app.scene.effective),
      set: (p) => {
        if (!canRun) return { ok: false, error: 'Read-only here (observer tab).' };
        if (!app.scene.canEdit) return { ok: false, error: 'Only the host can change this.' };
        const c = cleanLookPatch(p); if (!c.ok) return c;
        app.scene.command(lookToSceneArgs(c.patch));
        const miss = lookMissed(c.patch, lookOfScene(app.scene.effective));
        return miss.length ? { ok: false, error: `The ${miss.join(', ')} didn’t change. Try again.` } : { ok: true };
      },
      saveError: () => app.scene.saveError,
      on: (cb) => app.scene.on((w) => { if (w === 'state' || w === 'save') cb(); }),
    },
    // the Hands / Body switches (shared/trackParts.ts): the tracker lives in this page, so Me flips them right here
    tracking: {
      get: () => app.parts,
      set: (part, on) => { const n = app.setTrackPart(part, on); toast(n[part] ? TRACK_PART_TEXT[part].on : TRACK_PART_TEXT[part].off, 'ok', 2200); },
      on: (cb) => { const off = app.on((w) => { if (w === 'tracking') cb(); }); return () => { off(); }; },
    },
  });
  /** livepremium: the studio view (the ONE renderer) is laid over the console's PROGRAM frame; undone when Live closes. */
  function programMonitor(frame: HTMLElement, overlays: HTMLElement[]) {
    const root = document.documentElement.style, B = document.body;
    const vp = document.getElementById('viewport');
    if (vp) vp.append(...overlays); // tally tags + lower third ride on the studio view itself
    let last: number[] | null = null;
    const place = () => {
      const r = frame.getBoundingClientRect();
      if (r.width < 8) return;
      const k = [r.left, r.top, r.width, r.height].map(Math.round);
      // a Live panel rebuild can shift the frame by a pixel; moving + resizing the studio view (and the window resize
      // that re-lays the studio out) for that made it blink (owner 2026-10-02: "things keep refreshing on the studio
      // screen when I'm in a party")
      if (last && k.every((v, i) => Math.abs(v - last![i]) <= 1)) return;
      last = k;
      root.setProperty('--pgm-x', `${k[0]}px`); root.setProperty('--pgm-y', `${k[1]}px`);
      root.setProperty('--pgm-w', `${k[2]}px`); root.setProperty('--pgm-h', `${k[3]}px`);
      window.dispatchEvent(new Event('resize'));
    };
    B.classList.add('lc-console');
    const ro = new ResizeObserver(place); ro.observe(frame); ro.observe(document.body);
    const t = window.setInterval(place, 500);
    requestAnimationFrame(place);
    return () => {
      ro.disconnect(); clearInterval(t); B.classList.remove('lc-console'); frame.append(...overlays);
      for (const v of ['--pgm-x', '--pgm-y', '--pgm-w', '--pgm-h']) root.removeProperty(v);
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    };
  }
  let mounted: { destroy(): void } | null = null;
  let extrasOff: (() => void) | null = null;

  // ---- mini-bar
  const miniBar = el('div', { class: 'lc-mini', role: 'toolbar', 'aria-label': 'Show quick actions' });
  let miniSig = '';
  /** What a quick button does, in plain words (the mini-bar shows only the short label). */
  const quickTitle = (action: string, label: string) => {
    switch (action) {
      case 'cover': { let ls: Storage | null = null; try { ls = localStorage; } catch { /* blocked */ } return `Hide my screen (${comboLabel(loadHideScreenKey(ls))}): covers your game or window capture`; }
      case 'interview': { const lv = deck.live(); return label === 'Auto cam' ? autoCamTitle(lv.mode, lv.director) : lv.mode === 'interview' ? `Camera: ${label}` : `Interview mode only: camera ${label}`; }
      case 'hub-tts': return 'Reads donation messages out loud';
      case 'hub-ack-next': return 'Marks the next highlighted chat message as done';
      case 'poll-start': return `Starts a chat poll (${label})`;
      case 'poll-end': return 'Ends the chat poll';
      case 'recalibrate': return 'Sets your neutral face again: look at the screen with a relaxed face';
      case 'knock-approve': return 'Lets in the guest who is knocking';
      default: return label;
    }
  };
  const paintMini = () => {
    const L = loadLayout(), live = deck.live();
    const as = airState(status), at = AIR_TEXT[as];
    const sig = JSON.stringify([L.quick, live, smGet(), as]);
    if (sig === miniSig) return; miniSig = sig;
    // the light: IN OBS (red) or CAMERA ON (calm) — exactly what it refers to, with the plain explanation on hover
    miniBar.replaceChildren(el('button', { class: `lc-air${as === 'obs' ? ' on' : ' cam'}`, 'data-air': as, title: `${at.tip.replace(/\.$/, '')}. ${at.hint} Click for Live Control (Alt+L).`, onClick: go }, el('i'), at.label),
      el('span', { class: 'sep' }),
      // docked: all five scene buttons, always (they used to depend on what was pinned: Preshow / Outro never were)
      el('span', { class: 'lc-lbl', title: 'Room lights only: they don’t start or stop your stream' }, 'Lights'),
      el('div', { class: 'lc-mini-states', role: 'group', 'aria-label': 'Room lights' }, ...LIGHTS.map((l) => {
        const on = live.lighting === l.id;
        return el('button', { class: `lc-btn${on ? ' on' : ''}`, 'data-action': 'lighting', 'data-state': l.id, 'aria-pressed': String(on), title: `${l.label}: ${l.sub}`, onClick: () => { if (!canRun) { toast('Read-only (observer tab)', 'warn'); return; } void deck.run('lighting', { state: l.id }).then((r) => { if (!r.ok) toast(`${l.label}: ${r.error}`, 'err'); }); } }, l.short);
      })),
      el('span', { class: 'sep' }),
      ...L.quick.filter((q) => q.action !== 'lighting').slice(0, 8).map((q) => {
        const on = quickActive(q.action, q.params, live);   // ("Auto cam" = the Interview director: dark outside Interview)
        return el('button', { class: `lc-btn${on ? ' on' : ''}`, 'data-action': q.action, 'aria-pressed': String(!!on), title: quickTitle(q.action, q.label), onClick: () => { if (!canRun) { toast('Read-only (observer tab)', 'warn'); return; } void deck.run(q.action, q.params).then((r) => { if (!r.ok) toast(`${q.label}: ${r.error}`, 'err'); }); } }, q.label);
      }),
      el('span', { style: 'flex:1' }),
      el('button', { class: `lc-btn${smGet() ? ' on' : ''}`, title: 'Focus mode: dims the set-up menus so the show buttons stand out. It doesn’t start or stop your stream.', 'aria-pressed': String(smGet()), onClick: () => streamingMode.set(!smGet()) }, icon('stream', 14), 'Focus mode'),
      el('button', { class: 'lc-btn', title: 'Open Live Control (Alt+L)', onClick: go }, icon('live', 14), 'Live'));
  };
  deck.on(paintMini);
  document.addEventListener('vtp-live-layout', () => { miniSig = ''; paintMini(); });
  paintMini();

  const ctxRooms = () => app.scene.scenes.map((s) => ({ id: s.id, name: s.name }));
  let templates: string[] = [];
  const loadTemplates = () => void fetch('/api/poll/state').then((r) => r.json()).then((j: { templates?: { name: string }[] }) => { templates = (j.templates ?? []).map((t) => t.name); }).catch(() => {});
  loadTemplates();
  return {
    view(body) {
      mounted?.destroy();
      mounted = mountLiveControl(body, src());
      // beta.16 "Stream extras" (src/rules/extrasDrawer.ts): redeems & reactions, throw, stickers ... one button, built only when opened
      extrasOff?.(); extrasOff = null;
      void import('../../rules/extrasDrawer.ts').then((x) => { extrasOff?.(); extrasOff = body.contains(document.querySelector('.lc')) && !app.observer ? x.mountExtrasButton() : null; });
      // re-mounting on the next view(): the old one goes when the body is cleared
      const m = mounted;
      new MutationObserver((_, obs) => { if (!body.contains(document.querySelector('.lc'))) { m.destroy(); obs.disconnect(); extrasOff?.(); extrasOff = null; if (mounted === m) mounted = null; } }).observe(body, { childList: true });
    },
    miniBar,
    actions(q) {
      if (q.length < 3) return [];
      // live-tabs: "transitions", "hide my screen", "obs" … → open that Live tab
      const tabs = liveHitsForQuery(q).map((d) => ({ t: `Live → ${d.label}`, where: d.hint, run: () => { openLiveTab(d.id); go(); } }));
      // beta.16: "stream extras", "redeems", "rules", "channel points" -> the Stream extras panel
      const extras = /stream extras|redeem|reaction|channel point|rules/i.test(q)
        ? [{ t: 'Live → Stream extras: Redeems & reactions', where: 'When chat redeems or donates, your avatar reacts', run: () => { go(); void import('../../rules/extrasDrawer.ts').then((x) => x.openStreamExtras('rules')); } }] : [];
      tabs.push(...extras);
      if (!templates.length) loadTemplates();
      const hits: CmdHit[] = parseCommand(q, { rooms: ctxRooms(), templates, outfits: status.me.outfits, emotes: status.emotes, mode: app.scene.effective.mode });
      return [...tabs, ...hits.map((x) => ({
        t: `▶ ${x.label}`, where: 'Run now',
        run: () => {
          if (!canRun) { toast('Read-only (observer tab)', 'warn'); return; }
          if (x.danger && !confirm(`${x.label}?`)) return;
          void deck.run(x.action, x.params).then((r) => toast(r.ok ? `✓ ${x.label}` : `${x.label}: ${r.error}`, r.ok ? 'ok' : 'err', 1800));
        },
      }))];
    },
    onAir: () => app.trackingOn || pollObs() > 0,
    inObs: () => pollObs() > 0,
    status: () => status,
  };
}
