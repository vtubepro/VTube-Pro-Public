// 5e-compatible rules content, ONLY from the System Reference Document 5.1 (CC-BY-4.0). Nothing here comes from any
// non-SRD Wizards of the Coast product. The attribution below must travel with it (shown in the TTRPG panel → About,
// and in docs/TTRPG.md). The system-agnostic archetypes at the end are original VTube Pro content.

export const SRD_ATTRIBUTION =
  'This work includes material taken from the System Reference Document 5.1 (“SRD 5.1”) by Wizards of the Coast LLC and ' +
  'available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under the Creative ' +
  'Commons Attribution 4.0 International License available at https://creativecommons.org/licenses/by/4.0/legalcode.';

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export type Ability = (typeof ABILITIES)[number];
export const ABILITY_NAMES: Record<Ability, string> = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };

export const SKILLS: Record<string, Ability> = {
  Acrobatics: 'dex', 'Animal Handling': 'wis', Arcana: 'int', Athletics: 'str', Deception: 'cha', History: 'int', Insight: 'wis',
  Intimidation: 'cha', Investigation: 'int', Medicine: 'wis', Nature: 'int', Perception: 'wis', Performance: 'cha', Persuasion: 'cha',
  Religion: 'int', 'Sleight of Hand': 'dex', Stealth: 'dex', Survival: 'wis',
};

export const CONDITIONS = ['Blinded', 'Charmed', 'Deafened', 'Exhaustion', 'Frightened', 'Grappled', 'Incapacitated', 'Invisible', 'Paralyzed', 'Petrified',
  'Poisoned', 'Prone', 'Restrained', 'Stunned', 'Unconscious'] as const;

export interface SrdRace { id: string; name: string; bonus: Partial<Record<Ability, number>>; speed: number; traits: string[]; flex?: number }
export const RACES: SrdRace[] = [
  { id: 'dwarf', name: 'Hill Dwarf', bonus: { con: 2, wis: 1 }, speed: 25, traits: ['Darkvision', 'Dwarven Resilience', 'Dwarven Toughness'] },
  { id: 'elf', name: 'High Elf', bonus: { dex: 2, int: 1 }, speed: 30, traits: ['Darkvision', 'Keen Senses', 'Fey Ancestry', 'Trance', 'Cantrip'] },
  { id: 'halfling', name: 'Lightfoot Halfling', bonus: { dex: 2, cha: 1 }, speed: 25, traits: ['Lucky', 'Brave', 'Halfling Nimbleness', 'Naturally Stealthy'] },
  { id: 'human', name: 'Human', bonus: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 }, speed: 30, traits: ['Extra language'] },
  { id: 'dragonborn', name: 'Dragonborn', bonus: { str: 2, cha: 1 }, speed: 30, traits: ['Draconic Ancestry', 'Breath Weapon', 'Damage Resistance'] },
  { id: 'gnome', name: 'Rock Gnome', bonus: { int: 2, con: 1 }, speed: 25, traits: ['Darkvision', 'Gnome Cunning', 'Tinker'] },
  { id: 'halfelf', name: 'Half-Elf', bonus: { cha: 2 }, flex: 2, speed: 30, traits: ['Darkvision', 'Fey Ancestry', 'Skill Versatility'] },
  { id: 'halforc', name: 'Half-Orc', bonus: { str: 2, con: 1 }, speed: 30, traits: ['Darkvision', 'Menacing', 'Relentless Endurance', 'Savage Attacks'] },
  { id: 'tiefling', name: 'Tiefling', bonus: { cha: 2, int: 1 }, speed: 30, traits: ['Darkvision', 'Hellish Resistance', 'Infernal Legacy'] },
];

export interface SrdAttack { name: string; ability: Ability | 'spell'; dmg: string; type: string; note?: string }
export interface SrdClass {
  id: string; name: string; hd: number; order: Ability[]; saves: Ability[]; skills: string[];
  /** AC: 'unarmored-bar' 10+dex+con, 'unarmored-monk' 10+dex+wis, or armour base + max dex (+ shield). */
  armor: { base: number; maxDex: number | null; shield: boolean; unarmored?: Ability };
  attacks: SrdAttack[]; features: string[]; spell?: Ability;
}
export const CLASSES: SrdClass[] = [
  { id: 'barbarian', name: 'Barbarian', hd: 12, order: ['str', 'con', 'dex', 'wis', 'cha', 'int'], saves: ['str', 'con'], skills: ['Athletics', 'Intimidation'],
    armor: { base: 10, maxDex: null, shield: false, unarmored: 'con' }, attacks: [{ name: 'Greataxe', ability: 'str', dmg: '1d12', type: 'slashing' }, { name: 'Handaxe (thrown)', ability: 'str', dmg: '1d6', type: 'slashing' }], features: ['Rage (2/day, +2 damage)', 'Unarmored Defense'] },
  { id: 'bard', name: 'Bard', hd: 8, order: ['cha', 'dex', 'con', 'wis', 'int', 'str'], saves: ['dex', 'cha'], skills: ['Performance', 'Persuasion', 'Deception'],
    armor: { base: 11, maxDex: null, shield: false }, attacks: [{ name: 'Rapier', ability: 'dex', dmg: '1d8', type: 'piercing' }, { name: 'Vicious Mockery', ability: 'spell', dmg: '1d4', type: 'psychic', note: 'WIS save' }], features: ['Bardic Inspiration (d6)', 'Spellcasting'], spell: 'cha' },
  { id: 'cleric', name: 'Cleric', hd: 8, order: ['wis', 'con', 'str', 'cha', 'dex', 'int'], saves: ['wis', 'cha'], skills: ['Insight', 'Religion'],
    armor: { base: 14, maxDex: 2, shield: true }, attacks: [{ name: 'Mace', ability: 'str', dmg: '1d6', type: 'bludgeoning' }, { name: 'Sacred Flame', ability: 'spell', dmg: '1d8', type: 'radiant', note: 'DEX save' }], features: ['Spellcasting', 'Divine Domain (Life)'], spell: 'wis' },
  { id: 'druid', name: 'Druid', hd: 8, order: ['wis', 'con', 'dex', 'int', 'cha', 'str'], saves: ['int', 'wis'], skills: ['Nature', 'Survival'],
    armor: { base: 11, maxDex: null, shield: true }, attacks: [{ name: 'Scimitar', ability: 'dex', dmg: '1d6', type: 'slashing' }, { name: 'Produce Flame', ability: 'spell', dmg: '1d8', type: 'fire' }], features: ['Druidic', 'Spellcasting'], spell: 'wis' },
  { id: 'fighter', name: 'Fighter', hd: 10, order: ['str', 'con', 'dex', 'wis', 'cha', 'int'], saves: ['str', 'con'], skills: ['Athletics', 'Perception'],
    armor: { base: 16, maxDex: 0, shield: true }, attacks: [{ name: 'Longsword', ability: 'str', dmg: '1d8', type: 'slashing' }, { name: 'Light Crossbow', ability: 'dex', dmg: '1d8', type: 'piercing' }], features: ['Fighting Style (Defense)', 'Second Wind (1d10+level)'] },
  { id: 'monk', name: 'Monk', hd: 8, order: ['dex', 'wis', 'con', 'str', 'int', 'cha'], saves: ['str', 'dex'], skills: ['Acrobatics', 'Stealth'],
    armor: { base: 10, maxDex: null, shield: false, unarmored: 'wis' }, attacks: [{ name: 'Shortsword', ability: 'dex', dmg: '1d6', type: 'piercing' }, { name: 'Unarmed Strike', ability: 'dex', dmg: '1d4', type: 'bludgeoning' }], features: ['Unarmored Defense', 'Martial Arts'] },
  { id: 'paladin', name: 'Paladin', hd: 10, order: ['str', 'cha', 'con', 'wis', 'dex', 'int'], saves: ['wis', 'cha'], skills: ['Athletics', 'Persuasion'],
    armor: { base: 16, maxDex: 0, shield: true }, attacks: [{ name: 'Longsword', ability: 'str', dmg: '1d8', type: 'slashing' }, { name: 'Javelin', ability: 'str', dmg: '1d6', type: 'piercing' }], features: ['Divine Sense', 'Lay on Hands (5 HP)'] },
  { id: 'ranger', name: 'Ranger', hd: 10, order: ['dex', 'wis', 'con', 'str', 'int', 'cha'], saves: ['str', 'dex'], skills: ['Stealth', 'Survival', 'Perception'],
    armor: { base: 14, maxDex: 2, shield: false }, attacks: [{ name: 'Longbow', ability: 'dex', dmg: '1d8', type: 'piercing' }, { name: 'Shortsword', ability: 'dex', dmg: '1d6', type: 'piercing' }], features: ['Favored Enemy', 'Natural Explorer'] },
  { id: 'rogue', name: 'Rogue', hd: 8, order: ['dex', 'con', 'int', 'wis', 'cha', 'str'], saves: ['dex', 'int'], skills: ['Stealth', 'Sleight of Hand', 'Acrobatics', 'Perception'],
    armor: { base: 11, maxDex: null, shield: false }, attacks: [{ name: 'Rapier', ability: 'dex', dmg: '1d8', type: 'piercing', note: '+1d6 Sneak Attack' }, { name: 'Shortbow', ability: 'dex', dmg: '1d6', type: 'piercing' }], features: ['Sneak Attack (1d6)', 'Expertise', "Thieves' Cant"] },
  { id: 'sorcerer', name: 'Sorcerer', hd: 6, order: ['cha', 'con', 'dex', 'wis', 'int', 'str'], saves: ['con', 'cha'], skills: ['Arcana', 'Persuasion'],
    armor: { base: 10, maxDex: null, shield: false }, attacks: [{ name: 'Fire Bolt', ability: 'spell', dmg: '1d10', type: 'fire' }, { name: 'Dagger', ability: 'dex', dmg: '1d4', type: 'piercing' }], features: ['Spellcasting', 'Sorcerous Origin (Draconic)'], spell: 'cha' },
  { id: 'warlock', name: 'Warlock', hd: 8, order: ['cha', 'con', 'dex', 'wis', 'int', 'str'], saves: ['wis', 'cha'], skills: ['Arcana', 'Deception'],
    armor: { base: 11, maxDex: null, shield: false }, attacks: [{ name: 'Eldritch Blast', ability: 'spell', dmg: '1d10', type: 'force' }, { name: 'Dagger', ability: 'dex', dmg: '1d4', type: 'piercing' }], features: ['Otherworldly Patron (Fiend)', 'Pact Magic'], spell: 'cha' },
  { id: 'wizard', name: 'Wizard', hd: 6, order: ['int', 'con', 'dex', 'wis', 'cha', 'str'], saves: ['int', 'wis'], skills: ['Arcana', 'History'],
    armor: { base: 10, maxDex: null, shield: false }, attacks: [{ name: 'Fire Bolt', ability: 'spell', dmg: '1d10', type: 'fire' }, { name: 'Quarterstaff', ability: 'str', dmg: '1d6', type: 'bludgeoning' }], features: ['Spellcasting', 'Arcane Recovery'], spell: 'int' },
];

export interface SrdMonster { id: string; name: string; ac: number; hp: number; hpDice: string; speed: number; cr: string; attacks: { name: string; hit: number; dmg: string; type: string; note?: string }[]; traits?: string[]; stats: [number, number, number, number, number, number] }
/** SRD 5.1 creatures (numbers as published there). */
export const MONSTERS: SrdMonster[] = [
  { id: 'commoner', name: 'Commoner', ac: 10, hp: 4, hpDice: '1d8', speed: 30, cr: '0', stats: [10, 10, 10, 10, 10, 10], attacks: [{ name: 'Club', hit: 2, dmg: '1d4', type: 'bludgeoning' }] },
  { id: 'giant_rat', name: 'Giant Rat', ac: 12, hp: 7, hpDice: '2d6', speed: 30, cr: '1/8', stats: [7, 15, 11, 2, 10, 4], attacks: [{ name: 'Bite', hit: 4, dmg: '1d4+2', type: 'piercing' }], traits: ['Keen Smell', 'Pack Tactics'] },
  { id: 'kobold', name: 'Kobold', ac: 12, hp: 5, hpDice: '2d6-2', speed: 30, cr: '1/8', stats: [7, 15, 9, 8, 7, 8], attacks: [{ name: 'Dagger', hit: 4, dmg: '1d4+2', type: 'piercing' }, { name: 'Sling', hit: 4, dmg: '1d4+2', type: 'bludgeoning' }], traits: ['Sunlight Sensitivity', 'Pack Tactics'] },
  { id: 'bandit', name: 'Bandit', ac: 12, hp: 11, hpDice: '2d8+2', speed: 30, cr: '1/8', stats: [11, 12, 12, 10, 10, 10], attacks: [{ name: 'Scimitar', hit: 3, dmg: '1d6+1', type: 'slashing' }, { name: 'Light Crossbow', hit: 3, dmg: '1d8+1', type: 'piercing' }] },
  { id: 'cultist', name: 'Cultist', ac: 12, hp: 9, hpDice: '2d8', speed: 30, cr: '1/8', stats: [11, 12, 10, 10, 11, 10], attacks: [{ name: 'Scimitar', hit: 3, dmg: '1d6+1', type: 'slashing' }], traits: ['Dark Devotion'] },
  { id: 'guard', name: 'Guard', ac: 16, hp: 11, hpDice: '2d8+2', speed: 30, cr: '1/8', stats: [13, 12, 12, 10, 11, 10], attacks: [{ name: 'Spear', hit: 3, dmg: '1d6+1', type: 'piercing' }] },
  { id: 'goblin', name: 'Goblin', ac: 15, hp: 7, hpDice: '2d6', speed: 30, cr: '1/4', stats: [8, 14, 10, 10, 8, 8], attacks: [{ name: 'Scimitar', hit: 4, dmg: '1d6+2', type: 'slashing' }, { name: 'Shortbow', hit: 4, dmg: '1d6+2', type: 'piercing' }], traits: ['Nimble Escape'] },
  { id: 'skeleton', name: 'Skeleton', ac: 13, hp: 13, hpDice: '2d8+4', speed: 30, cr: '1/4', stats: [10, 14, 15, 6, 8, 5], attacks: [{ name: 'Shortsword', hit: 4, dmg: '1d6+2', type: 'piercing' }, { name: 'Shortbow', hit: 4, dmg: '1d6+2', type: 'piercing' }], traits: ['Vulnerable to bludgeoning'] },
  { id: 'zombie', name: 'Zombie', ac: 8, hp: 22, hpDice: '3d8+9', speed: 20, cr: '1/4', stats: [13, 6, 16, 3, 6, 5], attacks: [{ name: 'Slam', hit: 3, dmg: '1d6+1', type: 'bludgeoning' }], traits: ['Undead Fortitude'] },
  { id: 'wolf', name: 'Wolf', ac: 13, hp: 11, hpDice: '2d8+2', speed: 40, cr: '1/4', stats: [12, 15, 12, 3, 12, 6], attacks: [{ name: 'Bite', hit: 4, dmg: '2d4+2', type: 'piercing', note: 'DC 11 STR save or prone' }], traits: ['Keen Hearing and Smell', 'Pack Tactics'] },
  { id: 'giant_frog', name: 'Giant Frog', ac: 11, hp: 18, hpDice: '4d8', speed: 30, cr: '1/4', stats: [12, 13, 11, 2, 10, 3], attacks: [{ name: 'Bite', hit: 3, dmg: '1d6+1', type: 'piercing', note: 'grapples (escape DC 11)' }], traits: ['Amphibious', 'Standing Leap', 'Swallow'] },
  { id: 'flying_sword', name: 'Flying Sword', ac: 17, hp: 17, hpDice: '5d6', speed: 0, cr: '1/4', stats: [12, 15, 11, 1, 5, 1], attacks: [{ name: 'Longsword', hit: 3, dmg: '1d8+1', type: 'slashing' }], traits: ['Antimagic Susceptibility', 'False Appearance'] },
  { id: 'swarm_rats', name: 'Swarm of Rats', ac: 10, hp: 24, hpDice: '7d8-7', speed: 30, cr: '1/4', stats: [9, 11, 9, 2, 10, 3], attacks: [{ name: 'Bites', hit: 2, dmg: '2d6', type: 'piercing', note: '1d6 at half HP or less' }], traits: ['Swarm'] },
  { id: 'crocodile', name: 'Crocodile', ac: 12, hp: 19, hpDice: '3d10+3', speed: 20, cr: '1/2', stats: [15, 10, 13, 2, 10, 5], attacks: [{ name: 'Bite', hit: 4, dmg: '1d10+2', type: 'piercing', note: 'grapples (escape DC 12)' }], traits: ['Hold Breath'] },
  { id: 'orc', name: 'Orc', ac: 13, hp: 15, hpDice: '2d8+6', speed: 30, cr: '1/2', stats: [16, 12, 16, 7, 11, 10], attacks: [{ name: 'Greataxe', hit: 5, dmg: '1d12+3', type: 'slashing' }, { name: 'Javelin', hit: 5, dmg: '1d6+3', type: 'piercing' }], traits: ['Aggressive'] },
  { id: 'scout', name: 'Scout', ac: 13, hp: 16, hpDice: '3d8+3', speed: 30, cr: '1/2', stats: [11, 14, 12, 11, 13, 11], attacks: [{ name: 'Shortsword', hit: 4, dmg: '1d6+2', type: 'piercing' }, { name: 'Longbow', hit: 4, dmg: '1d8+2', type: 'piercing' }], traits: ['Keen Hearing and Sight'] },
  { id: 'thug', name: 'Thug', ac: 11, hp: 32, hpDice: '5d8+10', speed: 30, cr: '1/2', stats: [15, 11, 14, 10, 10, 11], attacks: [{ name: 'Mace (×2)', hit: 4, dmg: '1d6+2', type: 'bludgeoning' }], traits: ['Pack Tactics'] },
  { id: 'shadow', name: 'Shadow', ac: 12, hp: 16, hpDice: '3d8+3', speed: 40, cr: '1/2', stats: [6, 14, 13, 6, 10, 8], attacks: [{ name: 'Strength Drain', hit: 4, dmg: '2d6+2', type: 'necrotic' }], traits: ['Amorphous', 'Shadow Stealth'] },
  { id: 'ghoul', name: 'Ghoul', ac: 12, hp: 22, hpDice: '5d8', speed: 30, cr: '1', stats: [13, 15, 10, 7, 10, 6], attacks: [{ name: 'Bite', hit: 2, dmg: '2d6+2', type: 'piercing' }, { name: 'Claws', hit: 4, dmg: '2d4+2', type: 'slashing', note: 'DC 10 CON save or paralyzed' }] },
  { id: 'giant_spider', name: 'Giant Spider', ac: 14, hp: 26, hpDice: '4d10+4', speed: 30, cr: '1', stats: [14, 16, 12, 2, 11, 4], attacks: [{ name: 'Bite', hit: 5, dmg: '1d8+3', type: 'piercing', note: '+2d8 poison, DC 11 CON half' }], traits: ['Spider Climb', 'Web Sense', 'Web (recharge 5–6)'] },
  { id: 'animated_armor', name: 'Animated Armor', ac: 18, hp: 33, hpDice: '6d8+6', speed: 25, cr: '1', stats: [14, 11, 13, 1, 3, 1], attacks: [{ name: 'Slam (×2)', hit: 4, dmg: '1d6+2', type: 'bludgeoning' }], traits: ['Antimagic Susceptibility', 'False Appearance'] },
  { id: 'imp', name: 'Imp', ac: 13, hp: 10, hpDice: '3d4+3', speed: 20, cr: '1', stats: [6, 17, 13, 11, 12, 14], attacks: [{ name: 'Sting', hit: 5, dmg: '1d4+3', type: 'piercing', note: '+3d6 poison, DC 11 CON half' }], traits: ['Shapechanger', 'Magic Resistance', 'Invisibility'] },
  { id: 'mimic', name: 'Mimic', ac: 12, hp: 58, hpDice: '9d8+18', speed: 15, cr: '2', stats: [17, 12, 15, 5, 13, 8], attacks: [{ name: 'Pseudopod', hit: 5, dmg: '1d8+3', type: 'bludgeoning' }, { name: 'Bite', hit: 5, dmg: '1d8+3', type: 'piercing', note: '+1d8 acid' }], traits: ['Shapechanger', 'Adhesive', 'False Appearance'] },
  { id: 'ogre', name: 'Ogre', ac: 11, hp: 59, hpDice: '7d10+21', speed: 40, cr: '2', stats: [19, 8, 16, 5, 7, 7], attacks: [{ name: 'Greatclub', hit: 6, dmg: '2d8+4', type: 'bludgeoning' }, { name: 'Javelin', hit: 6, dmg: '2d6+4', type: 'piercing' }] },
  { id: 'gelatinous_cube', name: 'Gelatinous Cube', ac: 6, hp: 84, hpDice: '8d10+40', speed: 15, cr: '2', stats: [14, 3, 20, 1, 6, 1], attacks: [{ name: 'Pseudopod', hit: 4, dmg: '3d6', type: 'acid' }], traits: ['Ooze Cube', 'Transparent', 'Engulf'] },
  { id: 'bandit_captain', name: 'Bandit Captain', ac: 15, hp: 65, hpDice: '10d8+20', speed: 30, cr: '2', stats: [15, 16, 14, 14, 11, 14], attacks: [{ name: 'Scimitar (×2)', hit: 5, dmg: '1d6+3', type: 'slashing' }, { name: 'Dagger', hit: 5, dmg: '1d4+3', type: 'piercing' }], traits: ['Parry'] },
  { id: 'owlbear', name: 'Owlbear', ac: 13, hp: 59, hpDice: '7d10+21', speed: 40, cr: '3', stats: [20, 12, 17, 3, 12, 7], attacks: [{ name: 'Beak', hit: 7, dmg: '1d10+5', type: 'piercing' }, { name: 'Claws', hit: 7, dmg: '2d8+5', type: 'slashing' }], traits: ['Keen Sight and Smell'] },
  { id: 'veteran', name: 'Veteran', ac: 17, hp: 58, hpDice: '9d8+18', speed: 30, cr: '3', stats: [16, 13, 14, 10, 11, 10], attacks: [{ name: 'Longsword (×2)', hit: 5, dmg: '1d8+3', type: 'slashing' }, { name: 'Heavy Crossbow', hit: 3, dmg: '1d10+1', type: 'piercing' }] },
];

// ---------------------------------------------------------------- system-agnostic archetypes (original content)
/** Tiered foes for any setting (sci-fi, modern, kitchens): the GM reskins them ("Scav", "Terminid", "Rogue fry cook"). */
export const ARCHETYPES: { id: string; name: string; ac: number; hp: number; hit: number; dmg: string; note: string }[] = [
  { id: 'minion', name: 'Minion', ac: 11, hp: 6, hit: 3, dmg: '1d6+1', note: 'goes down in one good hit' },
  { id: 'grunt', name: 'Grunt', ac: 13, hp: 12, hit: 4, dmg: '1d8+2', note: 'the rank and file' },
  { id: 'sharpshooter', name: 'Sharpshooter', ac: 13, hp: 10, hit: 5, dmg: '1d10+2', note: 'hangs back, hits hard at range' },
  { id: 'brute', name: 'Brute', ac: 12, hp: 30, hit: 5, dmg: '2d8+3', note: 'slow, big, hits like a truck' },
  { id: 'swarm', name: 'Swarm', ac: 10, hp: 20, hit: 3, dmg: '2d6', note: 'many small things; halve damage at half HP' },
  { id: 'elite', name: 'Elite', ac: 16, hp: 40, hit: 6, dmg: '1d10+4', note: 'two attacks a turn' },
  { id: 'drone', name: 'Drone / Turret', ac: 15, hp: 14, hit: 5, dmg: '2d6', note: 'fixed or hovering, no morale' },
  { id: 'boss', name: 'Boss', ac: 17, hp: 90, hit: 7, dmg: '2d10+4', note: 'three actions a round, one big telegraphed attack' },
];

export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
export const abilityMod = (score: number) => Math.floor((score - 10) / 2);
export const fmtMod = (m: number) => (m >= 0 ? `+${m}` : `${m}`);
