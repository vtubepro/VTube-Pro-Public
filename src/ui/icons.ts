// Small stroke icons for the app shell (24×24, currentColor). Hand-drawn paths, no icon font / download.
const P: Record<string, string> = {
  me: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.2 3.6-6.5 8-6.5s8 2.3 8 6.5"/>',
  live: '<circle cx="12" cy="12" r="2.2"/><path d="M8.3 8.3a5.2 5.2 0 0 0 0 7.4M15.7 8.3a5.2 5.2 0 0 1 0 7.4M5.3 5.3a9.4 9.4 0 0 0 0 13.4M18.7 5.3a9.4 9.4 0 0 1 0 13.4"/>',
  room: '<path d="M3.5 10.5 12 3.8l8.5 6.7V20a1 1 0 0 1-1 1h-5v-6h-5v6h-5a1 1 0 0 1-1-1z"/>',
  create: '<path d="M11 3.5l1.9 4.8 4.8 1.9-4.8 1.9L11 17l-1.9-4.9-4.8-1.9 4.8-1.9zM18.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  friends: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20c0-3.6 2.9-5.6 6.5-5.6s6.5 2 6.5 5.6M15.5 5.2a3.4 3.4 0 0 1 0 6.6M17.8 14.7c2.2.6 3.7 2.3 3.7 5.3"/>',
  games: '<path d="M7.5 7.5h9a4.5 4.5 0 0 1 4.4 5.5l-.9 4a2.6 2.6 0 0 1-4.5 1.2L14 16.5h-4l-1.5 1.7A2.6 2.6 0 0 1 4 17l-.9-4a4.5 4.5 0 0 1 4.4-5.5z"/><path d="M8 10.5v3M6.5 12h3"/><circle cx="15.5" cy="11" r=".6" fill="currentColor"/><circle cx="17" cy="13" r=".6" fill="currentColor"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.4c-.7.3-1 .8-1 1.6v.5"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  wand: '<path d="M4 20 15 9M14 4v3M12.5 5.5h3M19 9v3M17.5 10.5h3M18 3.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  // studio layout overhaul: Show & layout, Chat & events, OBS & stream, tracking, search, studio view docking
  show: '<rect x="3" y="4" width="18" height="14" rx="2"/><rect x="5.5" y="11.5" width="5" height="4" rx=".8"/><path d="M13 7.5h5.5M13 10.5h3.5"/>',
  chat: '<path d="M4 5.5h16v10H10l-4.5 3.5v-3.5H4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  stream: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8.5 21h7M12 17v4"/><path d="m10.5 8.5 4 2.5-4 2.5z"/>',
  track: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="11" r="3"/><path d="M7.5 17.5c1-1.8 2.6-2.7 4.5-2.7s3.5.9 4.5 2.7"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  dock: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  mini: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="12" y="12" width="6.5" height="5.5" rx="1" fill="currentColor" stroke="none"/>',
  eye: '<path d="M2.5 12C3.5 9.5 7 5 12 5s8.5 4.5 9.5 7c-1 2.5-4.5 7-9.5 7s-8.5-4.5-9.5-7z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18M10.6 5.2A9.7 9.7 0 0 1 12 5c5 0 8.5 4.5 9.5 7-.4 1-1.2 2.3-2.4 3.6M6.4 6.5C4.4 7.8 3.1 9.8 2.5 12c1 2.5 4.5 7 9.5 7 1.6 0 3-.4 4.3-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  popout: '<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  // premium pass: Home dashboard
  home: '<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/>',
  micoff: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M4 4l16 16"/>',
  sofa: '<path d="M5 11V8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v3"/><path d="M3 13a2 2 0 0 1 4 0v2h10v-2a2 2 0 0 1 4 0v5H3zM6 18v2M18 18v2"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  keys: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7.5 14h9"/>',
  // livepremium: Live console
  brb: '<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5c0 1 1 1 1 2s-1 1-1 2M12 3.5c0 1 1 1 1 2s-1 1-1 2"/>',
  preshow: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2M9.5 2.5h5"/>',
  outro: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  react: '<path d="M13 2.5 5 13.5h6l-1 8 8-11h-6z"/>',
  camera: '<rect x="2.5" y="6.5" width="13" height="11" rx="2"/><path d="m15.5 10.5 6-3.5v10l-6-3.5"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20c0-3.6 2.9-5.6 6.5-5.6s6.5 2 6.5 5.6"/><circle cx="17" cy="9.5" r="2.6"/><path d="M16.5 14.6c2.8.2 5 1.9 5 5"/>',
  poll: '<path d="M4 20V11M10 20V5M16 20v-6M21 20H3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3.1-3.1a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3.1 3.1a4 4 0 0 0 5.7 5.7l1-1"/>',
  tv: '<rect x="3" y="6.5" width="18" height="12.5" rx="2"/><path d="m8.5 2.5 3.5 4 3.5-4"/>',
  seat: '<path d="M6 11V5.5A1.5 1.5 0 0 1 7.5 4h9A1.5 1.5 0 0 1 18 5.5V11"/><path d="M4.5 11h15v4.5h-15zM6.5 15.5V20M17.5 15.5V20"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  curtain: '<path d="M3 3.5h18M5 3.5c0 7 1 12 4 16.5M19 3.5c0 7-1 12-4 16.5M5 20h4M15 20h4"/>',
  prev: '<path d="m14.5 6-6 6 6 6"/>',
  next: '<path d="m9.5 6 6 6-6 6"/>',
  auto: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>',
  thanks: '<path d="M12 20s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.6-7.5 10-7.5 10z"/>',
  skip: '<path d="M5 5.5v13l9-6.5zM18.5 5.5v13"/>',
  speak: '<path d="M4 9.5v5h3.5l4.5 4V5.5l-4.5 4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  kick: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20c0-3.6 2.9-5.6 6.5-5.6 1.5 0 2.9.3 4 1M16 14l5 5M21 14l-5 5"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 7a8 8 0 1 0 11.4 0"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  pin: '<path d="M9 3.5h6l-1 6 3.5 3.5h-11L10 9.5zM12 13v7.5"/>',
  door: '<path d="M5 21V4.5A1.5 1.5 0 0 1 6.5 3h8A1.5 1.5 0 0 1 16 4.5V21M3 21h18M12.5 12h.01"/><path d="M16 6h3v15"/>',
  wide: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 12h12M6 12l2.5-2.5M6 12l2.5 2.5M18 12l-2.5-2.5M18 12l-2.5 2.5"/>',
  two: '<circle cx="8" cy="9" r="2.8"/><circle cx="16" cy="9" r="2.8"/><path d="M3 19c0-3 2.2-4.8 5-4.8s5 1.8 5 4.8M11 19c0-3 2.2-4.8 5-4.8s5 1.8 5 4.8"/>',
  // live-tabs: Transitions (two frames crossing) · Privacy (a shield) · Hide chat (a speech bubble crossed out)
  transition: '<rect x="3" y="5" width="11" height="9" rx="1.5"/><rect x="10" y="10" width="11" height="9" rx="1.5"/><path d="M14 10V8.5M10 14h-1.5"/>',
  shield: '<path d="M12 3l7.5 2.8v5.4c0 4.6-3.2 8.3-7.5 9.8-4.3-1.5-7.5-5.2-7.5-9.8V5.8z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  chatoff: '<path d="M3 3l18 18M8.5 5H19a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-.6 1.2M15 18H9l-4.5 3v-3h-0A1.5 1.5 0 0 1 3.5 16.5v-10c0-.4.1-.7.3-1"/>',
  host: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21c0-4 3.4-6.3 7.5-6.3s7.5 2.3 7.5 6.3"/><path d="m17.5 2.5.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/>',
  // create-gating: the four "How do you want to create?" choices
  aiapp: '<rect x="3" y="4" width="18" height="13" rx="2.5"/><path d="M8 21h8M12 17v4"/><path d="m12 7.3.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.7-8.7M16.5 6.5l2.5 2.5M14 9l2 2"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx=".8"/><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4a1.5 1.5 0 0 1 3 0v7M14 10.5V5.5a1.5 1.5 0 0 1 3 0V13"/><path d="M17 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1.2a6 6 0 0 1-4.6-2.2L4 14.6a1.6 1.6 0 0 1 2.4-2.1L8 14"/>',
  // Hands / Body switches: a standing figure, arms relaxed
  body: '<circle cx="12" cy="4.8" r="2.3"/><path d="M8.2 9.3h7.6M8.2 9.3 6.6 15M15.8 9.3l1.6 5.7M12 9.3v5.9M12 15.2l-2.7 5.6M12 15.2l2.7 5.6"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  // a gift box · Get it (download into a tray) · Back to studio (arrow left)
  // Guides (rail): an open book
  book: '<path d="M12 6.5C10.2 5 7.6 4.5 3.5 4.8v13.4c4.1-.3 6.7.2 8.5 1.7 1.8-1.5 4.4-2 8.5-1.7V4.8c-4.1-.3-6.7.2-8.5 1.7zM12 6.5v13.4"/>',
  gift: '<rect x="3.5" y="8.5" width="17" height="4.5" rx="1"/><path d="M5 13v6.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V13M12 8.5v12"/><path d="M12 8.5C10.5 5 7 4.2 6.6 6.3 6.2 8.3 9.5 8.5 12 8.5zM12 8.5c1.5-3.5 5-4.3 5.4-2.2.4 2-2.9 2.2-5.4 2.2z"/>',
  download: '<path d="M12 3.5v11m0 0-4.2-4.2M12 14.5l4.2-4.2"/><path d="M4 15.5v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  back: '<path d="M19.5 12h-15m0 0 6-6m-6 6 6 6"/>',
  // UX redesign: the notification bell, the Tools menu, a card's fold chevron
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  apps: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>',
  chev: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/>',
  fix: '<path d="M14.7 6.3a4 4 0 0 0-5.2 5.2L4 17v3h3l5.5-5.5a4 4 0 0 0 5.2-5.2l-2.6 2.6-2.4-.6-.6-2.4z"/>',
};
export function icon(name: keyof typeof P | string, size = 20): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', String(size)); s.setAttribute('height', String(size));
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = P[name] ?? P.help;
  return s;
}
