// Ship crew: the STATIC clip table the planner times episodes with (never read from loaded assets, so a page
// that has not finished loading plans exactly what every other page plans). Mirrors <room>/npc/crew_clip_meta.json
// (tools/npc_crew/crew_anims.py) + the retargeted UAL clips the crew uses (crew_anims_ual.json, tools/retarget/
// retarget_crew.json).
// dur = s, cycle = metres per loop (locomotion: the runtime advances the clip by distance walked), events = s into the clip.

export interface CrewClipMeta { dur: number; loop: boolean; cycle?: number; prop?: string; events?: Record<string, number>; upper?: boolean }

/** tools/npc_crew/crew_anims.py (authored on the crew skeleton) */
export const CREW_CLIPS: Record<string, CrewClipMeta> = {
  idle: { dur: 3.2, loop: true },
  idle_b: { dur: 4.0, loop: true },
  idle_arms: { dur: 3.6, loop: true },
  walk: { dur: 0.62, loop: true, cycle: 0.3793 },
  run: { dur: 0.42, loop: true, cycle: 0.6522 },
  carry: { dur: 0.66, loop: true, cycle: 0.3103, prop: 'chest' },
  carry_idle: { dur: 2.4, loop: true, prop: 'chest' },
  carry_pair: { dur: 0.66, loop: true, cycle: 0.3103 },
  carry_shell: { dur: 0.66, loop: true, cycle: 0.3103, prop: 'shell' },
  shell_ram: { dur: 1.0, loop: false, prop: 'shell', events: { ram: 0.55 } },
  helm_hold: { dur: 2.5, loop: true },
  helm_turn_l: { dur: 1.2, loop: true },
  helm_turn_r: { dur: 1.2, loop: true },
  gun_lay_mid: { dur: 1.0, loop: true },
  gun_lay_up: { dur: 1.0, loop: true },
  gun_lay_down: { dur: 1.0, loop: true },
  flinch_ears: { dur: 0.6, loop: false, upper: true },
  shovel_scoop: { dur: 2.2, loop: true, prop: 'shovel', events: { scoop: 0.55, toss: 1.36 } },
  hammer_wall: { dur: 1.1, loop: true, prop: 'hammer', events: { hit: 0.4 } },
  hammer_low: { dur: 0.9, loop: true, prop: 'hammer', events: { hit: 0.32 } },
  weld_stand: { dur: 2.0, loop: true, prop: 'torch', events: { arc: 0.1 } },
  weld_low: { dur: 2.0, loop: true, prop: 'torch', events: { arc: 0.1 } },
  spyglass_look: { dur: 3.0, loop: true, prop: 'spyglass' },
  point: { dur: 1.6, loop: true, events: { shout: 0.2 } },
  wave_alarm: { dur: 0.8, loop: true, events: { shout: 0.1 } },
  cheer: { dur: 1.0, loop: true },
  jump_cheer: { dur: 0.7, loop: true },
  wave: { dur: 1.4, loop: true },
  laugh: { dur: 1.4, loop: true },
  catch: { dur: 0.8, loop: false, events: { catch: 0.35 } },
  throw_up: { dur: 1.0, loop: false, prop: 'coinbag', events: { release: 0.5 } },
  ladder_climb: { dur: 0.9, loop: true, cycle: 0.5 },
  ladder_slide: { dur: 0.6, loop: true },
  brace: { dur: 0.6, loop: false },
  duck: { dur: 0.8, loop: true },
  haul: { dur: 1.0, loop: true, events: { pull: 0.45 } },
  swab: { dur: 1.4, loop: true, prop: 'mop' },
  polish: { dur: 1.6, loop: true, prop: 'rag' },
  dig: { dur: 1.6, loop: true, prop: 'shovel', events: { dig: 0.5 } },
  lift: { dur: 0.9, loop: false, prop: 'chest', events: { grab: 0.35 } },
  jump_off: { dur: 0.5, loop: false, events: { leave: 0.32 } },
  fall: { dur: 0.5, loop: true },
  land: { dur: 0.7, loop: false, events: { touch: 0.0 } },
  sit_deck: { dur: 3.0, loop: true },
  facepalm: { dur: 1.4, loop: false },
  hit: { dur: 0.45, loop: false, upper: true },
};

/** Quaternius UAL 1 + 2 retargeted onto the crew (strides x0.255: the hip-height ratio) */
export const CREW_UAL_CLIPS: Record<string, CrewClipMeta> = {
  ual_idle: { dur: 2.5, loop: true },
  ual_idle_talking: { dur: 2.9333, loop: true },
  ual_idle_rail: { dur: 2.5, loop: true },
  ual_idle_rail_call: { dur: 2.5, loop: false },
  ual_idle_no: { dur: 2.5, loop: true },
  ual_yes: { dur: 2.5, loop: false },
  ual_dance: { dur: 1.0, loop: true },
  ual_interact: { dur: 2.0, loop: false },
  ual_consume: { dur: 1.3333, loop: false },
  ual_roll: { dur: 1.4667, loop: false, cycle: 1.2741 },
  ual_hit_knockback: { dur: 0.8333, loop: false, cycle: 0.7658 },
  ual_hit_chest: { dur: 0.3333, loop: false },
  ual_jump_start: { dur: 1.3333, loop: false },
  ual_jump: { dur: 2.5, loop: true },
  ual_jump_land: { dur: 1.2667, loop: false },
  ual_fixing_kneeling: { dur: 5.2, loop: false },
  ual_sitting_idle: { dur: 1.6667, loop: true },
  ual_chest_open: { dur: 1.3667, loop: false },
  ual_overhand_throw: { dur: 1.3333, loop: false },
  ual_push: { dur: 2.6667, loop: true, cycle: 0.2042 },
  ual_tree_chopping: { dur: 0.9667, loop: true },
  ual_jog_fwd: { dur: 0.9333, loop: true, cycle: 1.2763 },
  ual_sprint: { dur: 0.6667, loop: true, cycle: 1.4039 },
  ual_walk: { dur: 1.3333, loop: true, cycle: 0.3318 },
  ual_farm_harvest: { dur: 2.5, loop: false },
};

export const clipMeta = (name: string): CrewClipMeta | null => CREW_CLIPS[name] ?? CREW_UAL_CLIPS[name] ?? null;
export const clipDur = (name: string, d = 1): number => clipMeta(name)?.dur ?? d;
export const clipEvent = (name: string, ev: string, d = 0): number => clipMeta(name)?.events?.[ev] ?? d;

/** Locomotion speeds (m/s) the planner moves crew at; the walk / run clips advance by distance (cycle m per loop), so the
 *  feet stay planted at any of these. A puppet scurry: legs 0.23 m long. */
export const CREW_SPEED = { walk: 0.62, run: 1.45, carry: 0.75, carryShell: 0.85, carryPair: 0.9, climb: 0.8, slide: 2.6 } as const;
