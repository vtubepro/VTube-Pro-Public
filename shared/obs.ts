// OBS automation (optional, off by default): the server talks obs-websocket v5 (built into OBS 28+) to line the
// react Window Capture up with the passthrough hole and (optionally) switch OBS scenes for Talk / React.
// The password lives only in config/obs.json on this PC — never in scene state, broadcasts or API responses.

/** What the studio sees (no password). */
export interface ObsPublic {
  enabled: boolean;
  /** obs-websocket address (default ws://127.0.0.1:4455). */
  url: string;
  hasPassword: boolean;
  /** VTube Pro may read OBS (the in-scene window feed follows the capture source): a password is saved, OBS needs none,
   *  or the automation is on. Older versions: missing. */
  canRead?: boolean;
  /** The Window Capture (any source) to place over the hole — shown while the hole is open, hidden otherwise. */
  captureSource: string;
  /** Optional: the VTube Pro browser source, when it doesn't fill the whole canvas (its transform maps the rect). */
  browserSource: string;
  /** OBS scene holding the capture (empty = the current program scene, or the React scene when switching). */
  sceneName: string;
  /** Switch the OBS program scene with the mode. */
  switchScenes: boolean;
  talkScene: string;
  reactScene: string;
  /** Optional: OBS program scene name → lighting state ('preshow' | 'show' | 'react' | 'brb' | 'outro'), e.g.
   *  { "Starting Soon": "preshow", "Main": "show" }. Empty = no connection is kept for it. */
  lightingMap: Record<string, string>;
  /** Passthrough on an angled screen: warp the Window Capture onto the hole's exact corners with the optional
   *  obs-shaderfilter plugin (a "VTube Pro corner pin" filter the automation adds to the capture). Off = best rotated box. */
  cornerPin: boolean;
  /** "Set up OBS" wizard (shared/obsSetup.ts): What you're doing (talk / react / gaming / interview) + BRB → OBS scene. */
  sceneMap?: Partial<Record<import('./obsSetup.ts').LookId, string>>;
  /** Remind me to start / stop recording (never starts or stops anything). Off by default. */
  recordReminder?: boolean;
  /** The wizard's automation step was reviewed (saved once). */
  reviewed?: boolean;
  status: {
    connected: boolean; error: string | null; version: string | null; lastAction: string | null; at: string | null; fit?: string | null;
    /** Where the capture was last put (canvas px) + the frame it was mapped from. */
    placed?: string | null;
    /** Setup problems found in OBS (filters reshaping the capture, capture above the browser source, …). */
    warnings?: string[];
    /** Why nothing is happening right now (e.g. the screen is set to In-scene capture), or null. */
    hint?: string | null;
    /** Hole reports received from OBS output pages since the server started. */
    reports?: number;
  };
  /** Recent automation events, newest last. */
  log?: ObsLogEntry[];
}

export interface ObsLogEntry { at: string; level: 'info' | 'ok' | 'warn' | 'err'; msg: string }

/** POST /api/obs/fit: Scene tab → *Fit my capture to the layout* (stage layouts; only on a click). */
export interface ObsFitReport { ok: boolean; error?: string; placed?: string; kind?: string; source?: { width: number; height: number }; box?: { x: number; y: number; w: number; h: number }; warnings: string[] }

/** POST /api/obs/test: place the capture once (like a React hole opening), read it back, restore it. */
export interface ObsTestReport { ok: boolean; steps: string[]; placed?: string; restored?: boolean; warnings: string[]; error?: string }

/** PUT /api/obs body (every field optional; password: set / '' + clearPassword to remove). */
export type ObsUpdate = Partial<Omit<ObsPublic, 'hasPassword' | 'status' | 'canRead'>> & { password?: string; clearPassword?: boolean };

/** POST /api/obs/place: Interview → "Fit my Window Capture → <guest>" (a click): the capture placed on those corners. */
export interface ObsPlaceReport { ok: boolean; error?: string; placed?: string; fit?: string; offPx?: number }

export interface ObsProbe {
  ok: boolean;
  error?: string;
  version?: string;
  scenes?: string[];
  inputs?: { name: string; kind: string }[];
  canvas?: { width: number; height: number };
  current?: string;
  /** obs-shaderfilter (filter kind 'shader_filter') is installed → the perspective corner-pin can be used. */
  shaderFilter?: boolean;
}

// ---------------------------------------------------------------- the studio through the server (lane obs-web)
// The studio page never talks to obs-websocket itself and never sees the OBS password: it calls these
// server routes (guarded by server/localGuard.ts like every route). The password is typed only on the helper's
// own page http://127.0.0.1:5191/obs/connect (or found there, with a click, in OBS's own settings file on this PC).
//   GET  /api/obs/status    → ObsStatus           GET  /api/obs/outputs → OutputsSummary (shared/obsPages.ts)
//   GET  /api/obs/scenes    → ObsScenes (read-only: GetSceneList + GetCurrentProgramScene + GetVideoSettings)
//   GET  /api/obs/scene     → { ok, current }      POST /api/obs/scene { sceneName } → switch (a click only)
//   GET/PUT /api/obs/switcher → ObsSwitcher (the auto scene switcher: Talk / React scenes + OBS scene → lighting)

/** Compact connection status for the "Connect OBS" step. Never carries the password. */
export interface ObsStatus {
  /** OBS automation on (the auto switcher acts only then). */
  enabled: boolean;
  /** A password is saved in the helper (or OBS needs none: `authRequired` false at the last connection). */
  hasPassword: boolean;
  /** Connected to OBS right now / at the last read (≤ 15 s ago). */
  connected: boolean;
  version: string | null;
  obsVersion: string | null;
  error: string | null;
  /** One plain sentence: what to do next (null = all good). */
  fix: string | null;
  /** What the helper's page for the password is (open it top-level, on this PC). */
  connectPage: string;
}

/** Read-only look at OBS's scenes (OBS order: top of OBS's Scenes list first). */
export interface ObsScenes { ok: boolean; scenes: string[]; current: string | null; canvas?: { width: number; height: number } | null; version?: string | null; error?: string; fix?: string }

/** The auto scene switcher: OBS program scene follows the studio's mode; OBS scene → lighting follows OBS. */
export interface ObsSwitcher {
  /** OBS automation is on (needed for anything automatic). */
  enabled: boolean;
  /** Switch the OBS program scene with the mode (Talk / React). */
  switchScenes: boolean;
  talkScene: string;
  reactScene: string;
  /** OBS program scene name → lighting state ('preshow' | 'show' | 'react' | 'brb' | 'outro'). */
  lightingMap: Record<string, string>;
  /** Look → OBS scene (the wizard's map; talkScene / reactScene mirror talk / react). Older versions: missing. */
  sceneMap?: Partial<Record<import('./obsSetup.ts').LookId, string>>;
  recordReminder?: boolean;
  reviewed?: boolean;
}
export type ObsSwitcherUpdate = Partial<ObsSwitcher>;

/** POST /api/obs/local/detect (helper page only): OBS's own obs-websocket settings file on this PC. */
export interface ObsDetect { found: boolean; serverEnabled?: boolean; port?: number; authRequired?: boolean; saved?: boolean; test?: ObsScenes; error?: string; where?: string }
