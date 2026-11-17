// Tutorials: the shape of one guided walkthrough. Pure data (no imports from the app), so a tutorial file is easy to read
// and change, tools/tutorials_unit.ts can check every word and every hook, and tools/tutorials_docs.ts can print the
// same steps as the written guide (docs/TUTORIALS.md).

/** Studio areas (src/ui/simple.ts AreaId), kept as strings so tutorial files import nothing from the app. */
export type TutArea = 'home' | 'onair' | 'me' | 'live' | 'room' | 'show' | 'chat' | 'games' | 'friends' | 'stream' | 'create' | 'settings';

/** Things the studio can tell are done (src/ui/tutorials/state.ts reads them from the app). */
export type TutState =
  | 'camera-on'     // the camera is on (tracking running)
  | 'face-found'    // the camera sees a face
  | 'mic-on'        // the microphone is on
  | 'avatar-on'     // an avatar is on screen
  | 'avatar-added'  // the avatar library grew since this tutorial started
  | 'outfit-on'     // the avatar wears an outfit (not the default look)
  | 'room-on'       // a room is showing (not the see-through background)
  | 'in-obs'        // OBS shows the studio's Browser Source
  | 'mode-react'    // the show is in React mode
  | 'sharing'       // a window is shared to the react screen
  | 'cover-on'      // "Hide my screen" is on
  | 'cover-off'     // "Hide my screen" is off
  | 'brb-on'        // a BRB screen is up
  | 'brb-off'       // no BRB screen is up
  | 'host'          // this studio hosts a party (guests can join)
  | 'party-ready'   // hosting is set up (Discord connected and signed in)
  | 'chat-on'       // a chat is connected
  | 'live-open'     // Live Control is the area on screen
  | 'wizard-open'   // a guided set-up window is open
  | 'wizard-closed';// no guided set-up window is open

/** What the step waits for before it moves on by itself. No `wait` = a reading step: the person presses Next. */
export type TutWait =
  | { click: true }        // a click on the highlighted thing
  | { state: TutState }    // the studio says it is done
  | { shows: string };     // this hook appears (a window or a menu opened)

/** Where the step's spotlight goes. A hook name: `name` = [data-tut~="name"], `ui:name` = [data-ui="name"], `#id` = an
 *  element id. The first one on screen wins. tools/tutorials_unit.ts checks each one exists in the studio's code. */
export type TutHook = string;

export interface TutStep {
  /** Unique in this tutorial (progress is stored by index, the id names the step in tests and docs). */
  id: string;
  /** Go to this area first. */
  area?: TutArea;
  /** Open this area's Advanced view at this sub-tab first (src/ui/shell.ts AREAS legacy ids). */
  adv?: string;
  /** What to point at (first visible wins). None = a bubble in the middle. */
  at?: TutHook[];
  /** A few words. */
  title: string;
  /** One plain sentence (two at most). People are "allergic to technology": no jargon. */
  text: string;
  /** What moves the step on by itself. */
  wait?: TutWait;
  /** Skip this step when this is already true (e.g. the camera is already on). */
  skipIf?: TutState;
  /** This also finishes the step (another way the person may have got there, e.g. the model saved straight away). */
  orDone?: TutState;
  /** …or this hook appearing finishes it too (the next page of a set-up window: the person went on by themselves). */
  orShows?: TutHook;
  /** A "click here" step that only finds the way (a rail button): when its target isn't on screen (a phone-sized
   *  window), go there instead and move on. */
  orGo?: { area: TutArea; adv?: string };
  /** Leave this step out when its target isn't on screen after a moment (things that only some studios show). */
  ifShown?: boolean;
  /** Zero effort: the step opens this guided set-up itself (src/ui/wizards.ts id), at this page. */
  open?: { wizard: string; at?: string };
  /** Zero effort: the step presses this navigation tab itself first (a Live Control pane tab, `#lc-tab-…`). */
  press?: TutHook;
  /** What to say when the target can't be found (default: close any open window, or scroll). One plain sentence. */
  lost?: string;
  /** Written guide only: a longer line under the step (docs/TUTORIALS.md). */
  more?: string;
  /** Written guide only: says `text` without pointing ("here", "this light"), for the page that has no spotlight. */
  doc?: string;
}

export interface TutFix { problem: string; fix: string }

export interface Tutorial {
  id: string;
  /** The hub card and the docs heading. */
  title: string;
  /** One line under the title. */
  blurb: string;
  /** src/ui/icons.ts name. */
  icon: string;
  minutes: number;
  group: 'Start here' | 'Your look' | 'Your show' | 'Make things';
  steps: TutStep[];
  /** "If something goes wrong": shown on the last step and in the written guide. */
  fixes?: TutFix[];
  /** A longer guide for the curious (FILE.md#anchor in docs/). */
  readMore?: string;
}
