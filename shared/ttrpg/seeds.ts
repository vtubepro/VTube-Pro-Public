// Adventure seeds themed per environment (original content; game-world rooms get affectionate homages — no names,
// text or characters from those games). The AI GM gets the chosen seed in its context; a human GM sees it in the
// panel as a cheat sheet. Seeds for the streamer's personal rooms are personal content like the rooms themselves
// (release scope: only GENERIC ships publicly — see docs/TTRPG.md).

export interface AdventureSeed {
  id: string;
  title: string;
  /** Suggested rules: fantasy rooms default to the 5e preset, modern / sci-fi rooms to the generic system. */
  system: 'generic' | '5e';
  tone: string;
  pitch: string;
  hooks: string[];
  npcs: string[];
  places: string[];
  twist: string;
  maps: string[];
  /** Default GM persona line for this room when the room's scene.json doesn't give one. */
  persona?: string;
}

export const GENERIC_SEEDS: AdventureSeed[] = [
  { id: 'tavern_brawl', title: 'Last Orders at the Gilded Goose', system: '5e', tone: 'rowdy comedy', pitch: 'The party is drinking in a roadside tavern when a hooded courier dies at their table, pressing a sealed box into the nearest hand.',
    hooks: ['three different gangs want the box', 'the box is ticking', 'the barkeep offers free drinks for life to whoever keeps her tavern standing'],
    npcs: ['Brenna the barkeep (retired adventurer, one eye, zero patience)', 'Pip, a nervous gnome courier apprentice', 'Sir Callow, a knight who is definitely not a bandit'],
    places: ['the common room', 'the cellar with a smugglers’ tunnel', 'the stable loft'], twist: 'The box holds a very small, very angry dragon egg that just hatched.', maps: ['tavern', 'street', 'cave'] },
  { id: 'goblin_market', title: 'The Goblin Night Market', system: '5e', tone: 'whimsical danger', pitch: 'Once a year a market appears under the old bridge where goblins sell memories, luck and names. Someone sold one of the party’s names.',
    hooks: ['win the name back in a contest', 'steal it from the ledger of the Market Master', 'trade something just as precious'],
    npcs: ['Grizzlecheek, the Market Master (polite, terrifying)', 'Nettle, a goblin kid who wants to be a hero', 'The Candle Lady, who sells tomorrow’s weather'],
    places: ['stalls of hanging lanterns', 'the ledger tent', 'the bridge’s drowned arches'], twist: 'Grizzlecheek sold his own name centuries ago and wants the party to get it back for him.', maps: ['street', 'swamp', 'cave'] },
  { id: 'haunted_lighthouse', title: 'The Lighthouse That Shines Backwards', system: '5e', tone: 'spooky mystery', pitch: 'Ships keep wrecking on a calm coast; the lighthouse beam now points inland, and the keeper stopped answering letters.',
    hooks: ['the harbour pays for answers', 'a party member’s cousin was on the last ship', 'a ghost begs them for help'],
    npcs: ['Keeper Wyn (missing)', 'Salt-Annie, a salvager who knows too much', 'The Drowned Choir (ghost sailors who sing in rounds)'],
    places: ['the rocks at low tide', 'the lamp room', 'the flooded cellar'], twist: 'The keeper turned the light around to guide the drowned home — and they want the living to come too.', maps: ['cave', 'ruins', 'dungeon'] },
  { id: 'heist_vault', title: 'One Last Job', system: 'generic', tone: 'slick heist', pitch: 'A fixer hires the crew to steal a prototype from a vault that no one has cracked — the job is tonight, the plan is half-finished.',
    hooks: ['each player picks a specialty', 'the fixer is holding their debts', 'a rival crew is going in the same night'],
    npcs: ['Mara Vex, the fixer (smiles like a knife)', 'Guard captain Olu (by the book, bribeable with pastries)', 'The Architect, who built the vault and hates it'],
    places: ['the rooftop entrance', 'the laser corridor', 'the vault itself'], twist: 'The prototype is sentient and wants to be stolen.', maps: ['lab', 'street', 'factory'] },
];

/** Seeds per environment id (the room the party came FROM; `<env>_ttrpg` rooms look up their `ttrpg.of`). */
export const ENV_SEEDS: Record<string, AdventureSeed[]> = {
  eft_factory: [
    { id: 'factory_extract', title: 'Night Shift', system: 'generic', tone: 'tense survival shooter', pitch: 'The crew wakes up inside a dark factory with a stolen drive, one magazine each and a radio telling them the extract closes in twenty minutes.',
      hooks: ['reach the extract before it closes', 'decide who carries the drive', 'something is hunting in the tunnels with a sledgehammer'],
      npcs: ['the Handler (radio voice, dry humour)', 'a wounded scav who begs for a bandage', 'the Hammer (a masked giant that stalks the halls)'],
      places: ['the gate-3 hall', 'the tunnels under the machines', 'the office stairwell'], twist: 'The Handler set them up: the drive is a tracker, and the extract is a trap — the only real exit is the one the scav knows.', maps: ['factory', 'lab', 'dungeon'],
      persona: 'a gruff, sarcastic radio handler talking the team through the raid' },
  ],
  eft_customs_dorms: [
    { id: 'dorms_key', title: 'Room 314', system: 'generic', tone: 'looter-shooter heist', pitch: 'Everyone in the city knows about the locked room on the third floor of the dorms. Tonight the crew has the key — and so does everyone else.',
      hooks: ['get in and out first', 'a rival squad offers a truce', 'the room is not what anyone thinks'],
      npcs: ['Babushka Olya (runs the dorm’s black market from a kettle)', 'Rival squad leader "Lefty"', 'a very confused tenant who never left'],
      places: ['the stairwells', 'the rooftop', 'room 314'], twist: 'Room 314 holds a family photo album — the tenant is the owner, and he just wants his home back.', maps: ['lab', 'street', 'factory'],
      persona: 'a world-weary fixer narrating over a crackling radio' },
  ],
  eft_labs: [
    { id: 'labs_breach', title: 'Clean Room', system: 'generic', tone: 'sci-thriller', pitch: 'A corporate lab went dark during a test; the crew is hired to recover a sample case before the cleaners arrive.',
      hooks: ['the keycard only works once', 'the sample case is humming', 'a scientist is still hiding in the server room'],
      npcs: ['Dr. Ilse Varga (terrified, lying)', 'the security AI VIOLET (polite, lethal)', 'the cleaners (a quiet tactical team)'],
      places: ['the atrium', 'the server room', 'the test chamber'], twist: 'VIOLET caused the blackout to protect the scientists from the company — and asks the crew to help.', maps: ['lab', 'ship', 'factory'],
      persona: 'a calm corporate security AI who narrates with unsettling politeness' },
  ],
  eft_labs_rnd: [
    { id: 'rnd_prototype', title: 'Prototype Nine', system: 'generic', tone: 'weird-science action', pitch: 'In the research wing, eight prototypes failed. Number nine escaped and has taken the coffee machine hostage.',
      hooks: ['recapture the prototype', 'decide whether it deserves freedom', 'save the coffee machine'],
      npcs: ['Prototype Nine (a curious robot dog with a laser)', 'Head of R&D, Dr. Pell (proud, careless)', 'Intern Sam (knows every vent)'],
      places: ['the test bays', 'the ventilation maze', 'the break room'], twist: 'Nine learned everything from the intern and just wants to be a good dog.', maps: ['lab', 'factory', 'ship'] },
  ],
  gzw_crimson_camp: [
    { id: 'camp_convoy', title: 'Red Convoy', system: 'generic', tone: 'jungle military adventure', pitch: 'A supply convoy vanished near the camp, the radio is jammed, and the rain has washed out every road.',
      hooks: ['find the convoy', 'restore the radio relay', 'keep the camp from turning on itself'],
      npcs: ['Sergeant Okafor (tired, fair)', 'a local guide named Tam (knows the old trails)', 'the Jammer (an unseen rival faction operator)'],
      places: ['the camp gate', 'the river crossing', 'the relay hill'], twist: 'The convoy was stolen by the camp’s own quartermaster to sell to the rivals.', maps: ['camp', 'forest', 'swamp'],
      persona: 'a veteran radio operator giving terse sit-reps over a crackling field radio' },
  ],
  gzw_fob: [
    { id: 'fob_night', title: 'Lights Out at the FOB', system: 'generic', tone: 'tactical tension', pitch: 'The forward base loses power at midnight; the generator is sabotaged and something is moving along the perimeter.',
      hooks: ['restore power', 'find the saboteur', 'hold the gate until dawn'],
      npcs: ['Captain Reyes (steady, secretive)', 'Corporal "Sparks" Lindqvist (engineer, jumpy)', 'the Visitor (a stranger at the gate with a white flag)'],
      places: ['the generator shed', 'the watchtowers', 'the motor pool'], twist: 'The Visitor is a deserter warning them of an attack — and the saboteur cut the power to hide the base from it.', maps: ['camp', 'forest', 'factory'] },
  ],
  helldivers_bridge: [
    { id: 'bridge_liberty', title: 'For Liberty (Terms and Conditions Apply)', system: 'generic', tone: 'bombastic military satire', pitch: 'High Command orders the squad to drop onto a bug-infested colony to recover a lost flag of immense symbolic value.',
      hooks: ['plant the flag', 'rescue the colonists', 'survive the orbital support that keeps missing'],
      npcs: ['the Democracy Officer (hologram, relentlessly upbeat)', 'Colonist Pru (farmer, has opinions about the war)', 'the Broodmother (very large, very angry)'],
      places: ['the drop zone', 'the colony silo', 'the hive entrance'], twist: 'The flag was never lost — High Command just wanted footage for a recruitment ad.', maps: ['ship', 'cave', 'camp'],
      persona: 'a relentlessly cheerful propaganda announcer from the ship’s bridge' },
  ],
  lastepoch_end_of_time: [
    { id: 'time_shard', title: 'The Stopped Clock', system: '5e', tone: 'epic time-travel fantasy', pitch: 'At the End of Time a shard of the great clock has cracked, and moments from the past are leaking in — including the party’s past selves.',
      hooks: ['repair the shard in three eras', 'convince their past selves not to meddle', 'stop a void cult racing them'],
      npcs: ['the Keeper of Hours (ancient, forgetful)', 'Echo (a past self of one player, smug)', 'the Void Speaker (cult leader who talks in reverse)'],
      places: ['the Clockwork Plaza', 'a burning city in the past', 'the frozen future'], twist: 'The Void Speaker is the party’s own future, trying to stop a mistake they’re about to make.', maps: ['ruins', 'arena', 'dungeon'],
      persona: 'an ancient timekeeper who speaks slowly and knows how it ends' },
  ],
  poe2_kingsmarch: [
    { id: 'kingsmarch_tithe', title: 'The Harbour Tithe', system: '5e', tone: 'grim fantasy with dark humour', pitch: 'Kingsmarch’s harbour master demands a tithe no one can pay; ships that refuse are dragged under by something below the docks.',
      hooks: ['find what lives under the docks', 'expose the harbour master', 'protect a smuggler’s family'],
      npcs: ['Harbour Master Coll (silver-tongued, cold)', 'Wren (smuggler, three kids, one boat)', 'the Tithe Beast (an eel the size of a street)'],
      places: ['the fish market', 'the sea caves under the docks', 'the harbour master’s tower'], twist: 'The harbour master feeds the beast to keep it from sinking the whole town — someone has to find a better deal.', maps: ['street', 'cave', 'dungeon'],
      persona: 'a grim old sea captain telling a tale in a dockside tavern' },
  ],
  sc_area18: [
    { id: 'area18_cargo', title: 'Hot Cargo', system: 'generic', tone: 'space-trucker noir', pitch: 'A cargo contract out of the landing zone pays triple — no questions asked. The crate starts knocking back.',
      hooks: ['deliver the crate or open it', 'outrun the security patrol', 'a bounty hunter wants the same crate'],
      npcs: ['Broker Kaz (holo-call only, all smiles)', 'Bounty hunter Rook (polite, patient)', 'whatever is in the crate'],
      places: ['the spaceport hangar', 'the neon market', 'a derelict station'], twist: 'The crate holds a smuggled baby space whale; its parent is following the ship.', maps: ['ship', 'street', 'lab'],
      persona: 'the ship’s sarcastic onboard AI' },
  ],
};
ENV_SEEDS.poe2_kingsmarch_v2 = ENV_SEEDS.poe2_kingsmarch;

// A room's own quests: scene.json `quests` (AdventureSeed[]), e.g. moved there by the Creator Console's "My creations"
// so a room keeps its adventures in builds whose code has no entry for it. Built-in seeds win on the same id.
const roomQuestMap = new Map<string, AdventureSeed[]>();
const strs = (v: unknown, max = 12) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 300)).slice(0, max) : []);
/** The valid quests in a room's scene.json (`quests`), cleaned. */
export function roomQuests(info: unknown): AdventureSeed[] {
  const q = info && typeof info === 'object' ? (info as { quests?: unknown }).quests : undefined;
  if (!Array.isArray(q)) return [];
  const out: AdventureSeed[] = [];
  for (const x of q.slice(0, 24)) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    if (typeof o.id !== 'string' || !/^[\w-]{1,48}$/.test(o.id) || typeof o.title !== 'string' || !o.title.trim()) continue;
    const t = (k: string, max = 600) => (typeof o[k] === 'string' ? (o[k] as string).slice(0, max) : '');
    out.push({ id: o.id, title: t('title', 120), system: o.system === '5e' ? '5e' : 'generic', tone: t('tone', 120), pitch: t('pitch'), hooks: strs(o.hooks), npcs: strs(o.npcs),
      places: strs(o.places), twist: t('twist'), maps: strs(o.maps, 6), ...(typeof o.persona === 'string' ? { persona: t('persona', 300) } : {}) });
  }
  return out;
}
/** Remember the rooms' own quests (call with the room list; cheap). */
export function setRoomQuests(rooms: readonly unknown[]) {
  roomQuestMap.clear();
  for (const r of rooms) { const id = r && typeof r === 'object' ? (r as { id?: unknown }).id : null; const q = roomQuests(r); if (typeof id === 'string' && q.length) roomQuestMap.set(id, q); }
}

export function seedsFor(env: string | null | undefined): AdventureSeed[] {
  const own = env ? ENV_SEEDS[env] ?? ENV_SEEDS[env.replace(/_ttrpg$/, '')] ?? [] : [];
  const room = env ? roomQuestMap.get(env) ?? roomQuestMap.get(env.replace(/_ttrpg$/, '')) ?? [] : [];
  const ids = new Set(own.map((s) => s.id));
  return [...own, ...room.filter((s) => !ids.has(s.id)), ...GENERIC_SEEDS];
}
export function findSeed(id: string): AdventureSeed | null {
  for (const list of [GENERIC_SEEDS, ...Object.values(ENV_SEEDS), ...roomQuestMap.values()]) { const s = list.find((x) => x.id === id); if (s) return s; }
  return null;
}
