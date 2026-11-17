import type { Tutorial } from '../types.ts';

/** Going live: you stream from OBS; Live Control is the show's remote (what you're doing, the lights, Start / End show). */
export const goLive: Tutorial = {
  id: 'go-live',
  title: 'Go live with your show',
  blurb: 'What “live” means here, the show modes, and the lights from start to end.',
  icon: 'live',
  minutes: 2,
  group: 'Your show',
  readMore: 'LIVE_PANEL.md',
  steps: [
    {
      id: 'air', area: 'onair', at: ['live-air'],
      title: 'You go live in OBS',
      text: 'You start streaming in OBS, like always. This light says In OBS when OBS shows you.',
      doc: 'You start streaming in OBS, like always: **Live** (Alt+L) is your show’s remote control. The light at its top says IN OBS when OBS shows you; NOT IN OBS means viewers can’t see you yet (do **Show your avatar in OBS** first).',
    },
    {
      id: 'modes', area: 'onair', at: ['live-modes'],
      title: 'What are you doing?',
      text: 'Pick Talk, React, Gaming, Interview or Tabletop. The cameras and layout follow.',
      more: '**Talk**: just chatting in your room. **React**: a video or stream on a big screen. **Gaming**: your game big, you in a corner. **Interview**: guests, with a camera switcher. **Tabletop game**: a game night at the table.',
    },
    {
      id: 'lights', area: 'onair', at: ['live-lights'],
      title: 'The lights',
      text: 'Preshow before you start, Show while you’re on. BRB for breaks, Outro at the end.',
      more: '**Preshow**: house lights off, a light show. **Show**: your normal lights. **React**: dimmed, facing the screen. **BRB**: fades to black, mutes guests, shows your Be Right Back card. **Outro**: warm afterparty lights. Shift+1 to Shift+5 switch them.',
    },
    {
      id: 'start', area: 'onair', at: ['live-start-show', 'live-end-show'],
      title: 'Start the show',
      text: 'Press Start show for the main lights. Then press Start Streaming in OBS.',
    },
    {
      id: 'end', area: 'onair', at: ['live-end-show', 'live-start-show'],
      title: 'At the end',
      text: 'Press End show twice for the outro lights. Then stop streaming in OBS.',
    },
  ],
  fixes: [
    { problem: 'It says Not in OBS', fix: 'Add VTube Pro to OBS first: the Show your avatar in OBS tutorial.' },
    { problem: 'Start show didn’t start my stream', fix: 'That’s right: it only changes the lights. Press Start Streaming in OBS.' },
    { problem: 'The lights don’t change', fix: 'The lights belong to a room. Pick a room first (the Pick and change your room tutorial).' },
  ],
};
