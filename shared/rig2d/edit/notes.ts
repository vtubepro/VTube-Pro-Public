// The notes the 2D avatar maker shows after opening a file, grouped in plain words. Pure (no DOM).
/** Every note about an opened file in plain groups (reading the file, left out, what the auto-rig did). */
export function noteGroups(fileWarnings: string[], rigNotes: string[]): { title: string; items: string[] }[] {
  const all = [...fileWarnings, ...rigNotes.filter((n) => !/^Auto-rig: \d/.test(n))];
  const seen = new Set<string>(), uniq = all.filter((x) => !seen.has(x) && (seen.add(x), true));
  const groups: { title: string; items: string[] }[] = [
    { title: 'Left out of the avatar', items: uniq.filter((x) => /left out|not applied|not drawn|background|skipped|hidden/i.test(x)) },
    { title: 'Fixed for you', items: uniq.filter((x) => /painted|clipped|scaled|made|cropp/i.test(x) && !/left out/i.test(x)) },
  ];
  const used = new Set(groups.flatMap((g) => g.items));
  groups.push({ title: 'Good to know', items: uniq.filter((x) => !used.has(x)) });
  return groups.filter((g) => g.items.length);
}
