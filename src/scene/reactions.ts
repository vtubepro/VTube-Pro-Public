// Room alert reactions, page side (docs/SCENES.md "Room alert reactions"): plays the host's SceneState.reactions stamps
// (shared/reactions.ts) in the current room on every page — the studio preview, every OBS page, party guests' OBS —
// at the same wall-clock time:
//   clip    → one-shot ALERT_* room clips (src/scene/roomClips.ts), posed at (now − stamp.at): a page that opens late
//             lands mid-clip;
//   cue     → the light engine's 'alert' cue on the room's cue groups (reactions.cueGroups), once per stamp;
//   groups / house / tint → the light engine's override for [at, until);
//   smash   → RaidScene.smash (SMASH_xx props break without the Tagilla event; late pages fast-forward the debris).
// Look / camera / space / raid events are host-owned scene state (src/scene/controller.ts): nothing to do here.
// Attached to the SceneRuntime by the page (output.ts) like the other layers; costs nothing while no stamp is in play.
import type { LightGroupSetting } from '../../shared/types.ts';
import { sanitizeRoomReactions, type ReactionStamp, type RoomReactionsConfig } from '../../shared/reactions.ts';
import type { SceneRuntime } from './SceneRuntime.ts';
import type { RaidScene } from './raid/raidScene.ts';

interface LightsHook {
  cue?: (what: string, opts?: { at?: number; groups?: string[] | null }) => void;
  cues?: readonly string[];
  setOverride?: (o: { groups?: Record<string, LightGroupSetting>; house?: number; tint?: string } | null) => void;
}

/** How late a page may still fire a stamp's light cue (older = it already happened). */
const CUE_LATE_MS = 2500;

export class ReactionScene {
  private rt: SceneRuntime | null = null;
  private cfg: RoomReactionsConfig | null = null;
  /** Stamps whose light cue was fired (or had already happened when this page got the room). */
  private fired = new Set<string>();
  /** Stamps whose smashes were tried (a late page still breaks the props: RaidScene fast-forwards the debris). */
  private smashed = new Set<string>();
  private ovKey = '';
  private clipsOn = false;
  /** Tests: time advances only through update() (clock = epoch ms). */
  manual = false;
  clock = Date.now();
  /** Last few things fired (debug / tests): { id, what, at, late ms }. */
  readonly log: { id: string; what: string; at: number; late: number }[] = [];

  constructor(private raid: RaidScene | null = null) {}

  now() { return this.manual ? this.clock : Date.now(); }

  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    this.rt = rt;
    this.cfg = sanitizeRoomReactions(rt.info.reactions);
    // stamps from before this page (re)loaded the room: their cues already happened elsewhere, don't replay them late
    const now = this.now();
    for (const r of rt.state.reactions ?? []) if (now - r.at > CUE_LATE_MS) this.fired.add(r.id);
  }

  detach() {
    if (this.rt) { this.rt.clips?.setOneShots([]); this.lights()?.setOverride?.(null); }
    this.rt = null; this.cfg = null;
    this.fired.clear(); this.smashed.clear(); this.ovKey = ''; this.clipsOn = false;
  }

  private lights(): LightsHook | null { return (this.rt?.lights as unknown as LightsHook | undefined) ?? null; }

  update(dt: number) {
    const rt = this.rt;
    if (!rt) return;
    if (this.manual) this.clock += dt * 1000;
    const list: ReactionStamp[] = rt.state.reactions ?? [];
    if (!list.length && !this.ovKey && !this.clipsOn) return;           // nothing in play: zero cost
    const now = this.now();
    // one-shot clips: the same list every frame → the same pose (the clip layer stops them when they end)
    const shots: { name: string; at: number }[] = [];
    for (const r of list) for (const c of r.clip ?? []) shots.push({ name: c, at: r.at });
    if (shots.length || this.clipsOn) { rt.clips?.setOneShots(shots); this.clipsOn = shots.length > 0; }
    // light override while a reaction runs (the newest one wins per group)
    let groups: Record<string, LightGroupSetting> | undefined, house: number | undefined, tint: string | undefined;
    for (const r of list) {
      if (now < r.at || now >= r.until) continue;
      if (r.groups) groups = { ...(groups ?? {}), ...r.groups };
      if (r.house !== undefined) house = r.house;
      if (r.tint) tint = r.tint;
    }
    const ov = groups || house !== undefined || tint ? { groups, house, tint } : null;
    const key = ov ? JSON.stringify(ov) : '';
    if (key !== this.ovKey) { this.ovKey = key; this.lights()?.setOverride?.(ov); }
    // once per stamp, when it starts: the light cue + the smashes
    for (const r of list) {
      if (now < r.at) continue;
      const late = now - r.at;
      if (r.smash && !this.smashed.has(r.id)) {
        this.smashed.add(r.id);
        if (this.smashed.size > 64) this.smashed.delete(this.smashed.values().next().value as string);
        for (const name of r.smash) if (this.raid?.smash(name, r.at)) this.note(r.id, `smash:${name}`, r.at, late);
      }
      if (this.fired.has(r.id)) continue;
      this.fired.add(r.id);
      if (this.fired.size > 64) this.fired.delete(this.fired.values().next().value as string);
      if (r.cue === 'alert' && late < CUE_LATE_MS) {
        const L = this.lights();
        // (the epoch clocks agree: the light engine's is performance.timeOrigin-based, stamps are Date.now())
        try { if (L?.cues?.includes('alert')) L.cue?.('alert', { at: r.at, groups: this.cueGroups() }); else L?.cue?.('screenLand'); } catch { /* optional hook */ }
        this.note(r.id, 'cue:alert', r.at, late);
      }
      for (const c of r.clip ?? []) this.note(r.id, `clip:${c}`, r.at, late);
    }
  }

  /** The groups the 'alert' cue pulses (null = the light engine's default: ON AIR + alert / alarm groups). */
  private cueGroups(): string[] | null { return this.cfg?.cueGroups ?? null; }

  private note(id: string, what: string, at: number, late: number) {
    this.log.push({ id, what, at, late: Math.round(late) });
    if (this.log.length > 24) this.log.shift();
  }

  /** Debug / tests (vtpOut.reactions.debug()). */
  debug() {
    const rt = this.rt;
    return {
      room: rt?.info.id ?? null, config: this.cfg, stamps: rt?.state.reactions ?? [], override: this.ovKey ? JSON.parse(this.ovKey) : null,
      clips: rt?.clips ? { oneShots: rt.clips.oneShots, playing: rt.clips.playing } : null, log: [...this.log],
      look: rt?.state.lights.state ?? null, camera: rt?.state.camera ?? null,
    };
  }
}
