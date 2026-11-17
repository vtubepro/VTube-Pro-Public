import type { Tutorial } from '../types.ts';

/** Invite a guest for an interview: Party → (one-time hosting set-up) → Invite someone → copy the link → let them in. */
export const guest: Tutorial = {
  id: 'guest',
  title: 'Invite a guest',
  blurb: 'Send one link. Your guest joins from any browser, even a phone.',
  icon: 'friends',
  minutes: 3,
  group: 'Your show',
  readMore: 'GUESTS_AND_PARTIES.md',
  steps: [
    {
      id: 'setup', area: 'friends', at: ['party-setup'], skipIf: 'party-ready', ifShown: true,
      title: 'Set up hosting once',
      text: 'Only you, the host, do this once. Press Set up and follow the steps.',
      more: 'It is in **Party**. It connects your Discord account and your own free invite server. About 15 minutes, one time. Guests need nothing. Full steps: Hosting setup.',
      wait: { state: 'party-ready' },
    },
    {
      id: 'invite', area: 'friends', at: ['guest-invite'],
      lost: 'This button shows once hosting is set up. Go back one step and press Set up.',
      title: 'Invite someone',
      text: 'Press Invite someone. We make a link just for your guest.',
      wait: { shows: 'invite-sheet' },
    },
    {
      id: 'copy', at: ['invite-copy'],
      title: 'Send the link',
      text: 'Copy the link and send it to your guest. They need nothing installed.',
      more: 'Guest on a phone next to you? **Show QR code for a phone** shows a code to scan.',
      wait: { click: true },
    },
    {
      id: 'knock',
      title: 'Let them in',
      text: 'When your guest arrives, they knock. Press Let in.',
      more: 'The knock shows in Party and in Live Control (Guests). New guests can wait in the green room until you bring them on.',
    },
    {
      id: 'interview', area: 'onair', at: ['live-modes'],
      title: 'Interview mode',
      text: 'Pick Interview here. You get a camera button for each guest.',
      doc: 'In Live, pick **Interview**. You get a camera button for each guest.',
    },
  ],
  fixes: [
    { problem: '“Connect Discord first”', fix: 'Finish the one-time Set up in Party, and sign in with Discord.' },
    { problem: 'The guest can’t join', fix: 'Links expire. Make a new link and send it again.' },
    { problem: 'There is an echo', fix: 'Both of you should wear headphones.' },
  ],
};
