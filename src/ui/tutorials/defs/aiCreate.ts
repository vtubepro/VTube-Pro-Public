import type { Tutorial } from '../types.ts';

/** Make things with AI: Create → (helper) → How do you use AI? → connect your AI app → ask it → approve. Apps first. */
export const aiCreate: Tutorial = {
  id: 'ai-create',
  title: 'Make things with AI',
  blurb: 'Connect the Claude, ChatGPT or Grok app. Then ask it for an avatar, outfit or room.',
  icon: 'create',
  minutes: 4,
  group: 'Make things',
  readMore: 'MAKE_WITH_CLAUDE_OR_CODEX.md',
  steps: [
    {
      id: 'how', area: 'create', at: ['cg-paths'], ifShown: true,
      title: 'How do you use AI?',
      text: 'Pick one. The Claude, ChatGPT or Grok app is the easiest.',
      more: 'It is in **Create** on the left. No AI yet? **I don’t have an AI app** shows free choices.',
      wait: { click: true },
    },
    {
      id: 'connect', area: 'create', at: ['cg-apps'], ifShown: true,
      title: 'Connect your AI app',
      text: 'Open your app’s row and press Connect. Then restart the app.',
    },
    {
      id: 'say', area: 'create', at: ['cg-ask'], ifShown: true,
      title: 'Say hello, then ask',
      text: 'Paste this into a new chat in your AI app. Then ask for an outfit, avatar or room.',
      doc: 'Under **What do I say?**, press **Copy** and paste it into a new chat in your AI app. Then ask in plain words, like “make me an outfit with a pirate hat”.',
    },
    {
      id: 'ok',
      title: 'Press Approve',
      text: 'When your AI wants to change something, the studio asks you. Press Approve.',
      more: 'The studio shows **Your AI is waiting for your OK**. Nothing changes on your stream until you say so. What it is making shows up in Create.',
    },
  ],
  fixes: [
    { problem: 'My AI app doesn’t see VTube Pro', fix: 'Restart the AI app after pressing Connect, then start a new chat.' },
    { problem: 'Nothing happens after I ask', fix: 'Look for “Your AI is waiting for your OK” and press Approve.' },
    { problem: 'It says VTube Pro isn’t running', fix: 'Start VTube Pro on your computer, then press Check again.' },
  ],
};
