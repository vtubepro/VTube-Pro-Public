// Stage mode registry — the core (types + the table). Mode modules (src/scene/stage/modes/*.ts) import
// `registerStageMode` from HERE; everything else imports from ./registry.ts, which also loads every mode module.
// Spec for other workstreams: S\stagemodes\MODE_REGISTRY.md (docs/SCENES.md → "Stage modes").
import type { SceneInfo, SceneState } from '../../../shared/types.ts';
import type { Rect, SceneStageState, StagePlan } from '../../../shared/stage.ts';
import type { SceneRuntime } from '../SceneRuntime.ts';

/** A party member as the controller hooks see it (host first, then join order). */
export interface ModeMember { key: string; name: string; host: boolean; self: boolean; cls?: string }

/** Controller hook context (host / solo studio only; runs inside SceneController.edit on a DRAFT state). */
export interface ModeCtx {
  /** The draft state — mutate freely (camera, focus, lights, your bag …). */
  state: SceneState;
  /** The state before this change (read only). */
  prev: SceneState;
  /** The draft stage layout state (mutable; saved back into state.stage). */
  stage: SceneStageState;
  members: ModeMember[];
  /** Members in the room (present), host first, then join order. */
  present: ModeMember[];
  scenes: SceneInfo[];
  /** This mode's bag (SceneState.modes[id]) through your sanitiser / write it back. */
  bag<T>(sanitize: (raw: unknown) => T): T;
  setBag(v: unknown): void;
}

/** What `enter` may ask for: move the party to a room (the transition curtain plays), seat them. */
export interface ModeRoom {
  room?: string | null;
  /** 'order': host → SPOT_01, guests in join order → SPOT_02 …; 'keep' (default): the room's remembered seats. */
  seats?: 'order' | 'keep' | Record<string, number>;
}

/** A performer as the page hooks see it (ordered: host first, then join order). */
export interface ModePerformer {
  key: string; name: string; host: boolean;
  /** Size class (micro … macro). */
  cls: string;
  /** Has a seat in the room and is present. */
  present: boolean;
  /** Seated / standing at the spot (not walking, model loaded). */
  seated: boolean;
  /** 0..1 talking right now (the last rendered frame's voice / mouth; walking TVs: their voice level). */
  speak: number;
}

export interface ModePageCtx {
  state: SceneState;
  stage: SceneStageState;
  /** Output frame aspect (w / h). */
  aspect: number;
  performers: ModePerformer[];
  room: { id: string; info: SceneInfo; theme: string | null; hasScreen: boolean };
  /** A window is drawn in-page (in-scene capture / fast feed) instead of an OBS passthrough hole. */
  inScene: boolean;
  /** Chat / support docks wanted on this page (the dock settings + whether chat is in use). */
  docks: { chat: boolean; support: boolean };
  rt: SceneRuntime;
  bag<T>(sanitize: (raw: unknown) => T): T;
  /** This page's bus (OBS pages: this PC's studio / server; absent on test pages): subscribe, returns the unsubscribe. */
  onBus?: (fn: (m: import('../../../shared/types.ts').BusMessage) => void) => () => void;
  /** The page's transition curtain (a title card: `curtain.test({id, name, thumb}, style)`). */
  curtain?: { readonly active: boolean; test(target: { id: string | null; name: string; thumb: string | null }, style?: string): void };
}

export interface ModePageHooks {
  /** A screen-space composition for the current state, or null = the normal 3D room render (+ automatic docks). */
  plan?(ctx: ModePageCtx): StagePlan | null;
  attach?(rt: SceneRuntime): void;
  detach?(): void;
  /** Every frame while this mode is the current one. */
  update?(dt: number, ctx: ModePageCtx): void;
  /** Screen areas (fractions of the frame, top-left origin) the docked chat / support panels must NEVER cover in this
   *  frame — an in-set monitor's picture, projector screens, the faces the mode frames. Called every frame after
   *  `update` (so it follows moving cameras); the compositor treats them as hard keep-outs: a dock that touches one is
   *  re-placed at once (free space), shrinks to a ticker strip, or hides instantly. A full-frame rect hides the docks. */
  keepOut?(ctx: ModePageCtx): Rect[];
}

export interface StageModeDef {
  /** SceneState.mode value (shared/stage.ts MODE_ID). */
  id: string;
  label: string;
  icon: string;
  /** Mode bar position (talk 10, react 20, gaming 30 …). */
  order: number;
  /** Studio shortcut Shift+<key> (one letter). */
  key?: string;
  hint?: string;
  /** state.camera set on enter (default 'talk'; leaving a mode that set 'react' goes back to 'talk'). */
  camera?: string;
  /** Play the transition curtain when entering / leaving this mode even without a room change. */
  curtain?: boolean;
  /** This mode shows an OBS passthrough hole (server/obs.ts keeps the capture shown; *Fit my capture* is offered). */
  hole?: boolean;
  /** 'auto': in-world chat rigs when they fit, else docked panels · 'docked': always docked · 'none'. */
  chat?: 'auto' | 'docked' | 'none';
  enter?(ctx: ModeCtx): ModeRoom | void;
  exit?(ctx: ModeCtx): void;
  page?: ModePageHooks;
}

const defs = new Map<string, StageModeDef>();
const subs = new Set<() => void>();

/** Add (or replace — HMR) a mode. */
export function registerStageMode(def: StageModeDef) {
  if (!/^[a-z][a-z0-9-]{1,23}$/.test(def.id)) { console.warn(`[stage] bad mode id '${def.id}'`); return; }
  defs.set(def.id, def);
  for (const f of subs) try { f(); } catch { /* ui */ }
}
export const stageModeDef = (id: string | null | undefined): StageModeDef | null => (id ? defs.get(id) ?? null : null);
/** Every registered mode, mode-bar order. */
export const stageModeList = (): StageModeDef[] => [...defs.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
/** Registry changed (a mode module loaded / hot-reloaded). */
export function onStageModes(f: () => void) { subs.add(f); return () => subs.delete(f); }
