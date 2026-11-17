import type { Tutorial } from '../types.ts';

/** Pick a room, then its light, time of day and weather; free rooms; your own room. */
export const room: Tutorial = {
  id: 'room',
  title: 'Pick and change your room',
  blurb: 'Choose a 3D room to stream from, then set its light, time and weather.',
  icon: 'room',
  minutes: 2,
  group: 'Your look',
  readMore: 'ENVIRONMENTS_SIMPLE.md',
  steps: [
    {
      id: 'open', area: 'room', at: ['room-change'],
      title: 'See every room',
      text: 'Press Change room. A list of rooms opens.',
      more: 'It is in **Room** on the left.',
      wait: { shows: 'room-list' },
    },
    {
      id: 'pick', area: 'room', at: ['room-list'],
      title: 'Pick a room',
      text: 'Click a room to use it. It changes on stream right away.',
      more: '**No room** keeps just your avatar on a see-through background: good over a game. **Get more free rooms** at the bottom adds rooms with one click.',
      wait: { click: true },
    },
    {
      id: 'light', area: 'room', at: ['room-lighting'], ifShown: true,
      title: 'Set the mood',
      text: 'Show is your normal light. BRB dims the room while you’re away.',
      more: 'Preshow (before you start), Show, React (dimmed for videos), BRB (be right back) and Outro (the end). Shift+1 to Shift+5 switch them.',
    },
    {
      id: 'quick', area: 'room', at: ['room-quick'], ifShown: true,
      title: 'Time and weather',
      text: 'Some rooms have time of day and weather. Night turns the lamps on.',
      more: 'Who sits where, the cameras and every light are under **Advanced** at the bottom of Room.',
    },
    {
      id: 'own', area: 'room', at: ['ui:add-my-room', '#room-prompter'],
      title: 'Your own room',
      text: 'Have a room file? Press Add my room, or describe one for your AI below.',
    },
  ],
  fixes: [
    { problem: 'The room doesn’t change in OBS', fix: 'Check that OBS shows VTube Pro: the OBS light at the top must be green.' },
    { problem: 'The room is slow or choppy', fix: 'Pick a lighter graphics setting in Settings, or a smaller room.' },
    { problem: 'Change room is greyed out', fix: 'You joined someone’s party: the host picks the room.' },
  ],
};
