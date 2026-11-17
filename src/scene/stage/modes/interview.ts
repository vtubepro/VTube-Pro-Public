// Interview mode (talk show): the host at a desk, guests on the in-set monitor or in the guest chairs, a sidekick for
// reaction shots, an auto-director that cuts on who is speaking. Engine: src/scene/talkshow/*; settings: the bag
// SceneState.modes.interview (shared/talkshow.ts); studio panel: src/ui/stage/panels/interview.ts. docs/SCENES.md →
// "Interview mode".
import { registerStageMode, type ModePageCtx } from '../modeCore.ts';
import type { BusMessage } from '../../../../shared/types.ts';
import { INTERVIEW_MODE, planLineup, roomInterviewConfig, sanitizeInterview } from '../../../../shared/talkshow.ts';
import { InterviewScene } from '../../talkshow/engine.ts';
import { Bus } from '../../../bus.ts';

let scene: InterviewScene | null = null;
let bus: Bus | null = null;
let offBus: (() => void) | null = null;

const page = () => {
  if (!scene) {
    const w = window as unknown as { vtpOut?: { curtain?: unknown } };
    const preview = new URLSearchParams(location.search).has('preview');
    scene = new InterviewScene({ look: preview || new URLSearchParams(location.search).get('screen') === 'placeholder' ? 'preview' : 'hole', curtain: (w.vtpOut?.curtain as never) ?? null });
  }
  return scene;
};

/** The studio's messages for this page (bus command 'interview'): the director's cues {cue} (src/ui/stage/interviewHost.ts:
 *  one director for every page) and the video guests' voice meter {v:[…]}. OBS pages listen on their own bus
 *  (ModePageCtx.onBus); the studio's Scene-tab preview has none, so it opens a link of its own while the mode is on.
 *  Test pages (?sceneTest) never open one: their cues come from vtpInterview.cue(). */
function onStudio(m: BusMessage) {
  if (m.type !== 'command' || m.command !== 'interview' || !scene) return;
  const a = (m.args ?? {}) as { v?: unknown; cue?: unknown };
  if (a.v !== undefined && scene.bag.meter) scene.voice.pushVideo(a.v);
  if (a.cue !== undefined) scene.cue(a.cue);
}
function studioLink(onBus: ModePageCtx['onBus']) {
  if (offBus) return;
  if (onBus) { offBus = onBus(onStudio); return; }
  const q = new URLSearchParams(location.search);
  if (!q.has('preview') || q.has('sceneTest')) return;
  bus = new Bus('control');
  offBus = bus.on(onStudio);
}
function studioUnlink() {
  offBus?.(); offBus = null;
  bus?.close(); bus = null;
}

registerStageMode({
  id: INTERVIEW_MODE,
  label: 'Interview',
  icon: '📺',
  order: 40,
  key: 'I',
  hint: 'Talk-show set: guests on the big monitor (or in the guest chairs), an auto-director cutting on who speaks',
  camera: 'talk',
  curtain: true,
  hole: false,
  chat: 'docked',
  enter(ctx) {
    // the host takes the set's desk chair; in the seated layout performer guests take the guest chairs
    const bag = ctx.bag(sanitizeInterview);
    const info = ctx.scenes.find((s) => s.id === ctx.state.sceneId) as unknown as { interview?: unknown } | undefined;
    const cfg = roomInterviewConfig(ctx.state.sceneId ?? '', info?.interview);
    const idx = (name: string | undefined) => { const m = /^SPOT_(\d{2})$/.exec(name ?? ''); return m ? +m[1] - 1 : -1; };
    const seats: Record<string, number> = {};
    const h = idx(cfg.host ?? 'SPOT_01');
    if (h >= 0) seats['@host'] = h;
    // per guest (guestlink): the host's "In studio" guests (or everyone, with the "set all: chairs" layout) get the chairs
    // (co-hosts sit at the desk: the page seats them — src/scene/talkshow/engine.ts, never in a guest chair)
    const chairs = (cfg.guests ?? []).map(idx).filter((i) => i >= 0 && i !== h);
    planLineup(bag).filter((x) => x.role === 'guest' && x.kind !== 'video' && x.g.key && x.place === 'studio').forEach((x, i) => { if (chairs[i] !== undefined && ctx.members.some((m) => m.key === x.g.key)) seats[x.g.key!] = chairs[i]; });
    return Object.keys(seats).length ? { seats } : undefined;
  },
  page: {
    plan(ctx) {
      return { key: 'interview', view: '3d', capture: null, tiles: [], docks: { chat: ctx.docks.chat ? 'auto' : null, support: ctx.docks.support ? 'auto' : null }, label: 'Interview' };
    },
    // the docked chat / support never cover the monitor, projector screens, the faces on the show or the show-open card
    keepOut(ctx) { return scene && scene.rt === ctx.rt ? scene.keepOut(ctx.aspect) : []; },
    attach(rt) { page().attach(rt); },
    detach() { scene?.detach(); studioUnlink(); },
    update(dt, ctx) {
      const s = page();
      if (s.rt !== ctx.rt) s.attach(ctx.rt);
      const bag = ctx.bag((b) => b);
      studioLink(ctx.onBus);
      s.update(dt, bag);
    },
  },
});
