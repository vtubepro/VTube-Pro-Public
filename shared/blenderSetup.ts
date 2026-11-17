// "Set up AI creation" (lane toolsetup, beta.12): the pure half of finding Blender on every OS and saying how to get it.
// No node / DOM imports (the helper, the Tools page and tools/ai_setup_unit.ts share it). The I/O half (running
// `blender --version`, reading Steam's library list, the Windows registry, Spotlight, /etc/os-release) is
// server/aiSetup.ts; the catalogue entry (official hosts, winget / brew commands, consent) stays shared/toolsCatalog.ts.
//
// Owner, beta.12: "The helper ... needs to also help install Blender and the MCP server so that work can actually be
// done. A lot of people are fucking this up." So: look everywhere people really put Blender (installer, winget, Steam,
// Microsoft Store, an unzipped download, /Applications, a dmg never dragged out, snap, Flatpak, a tarball, distro
// packages, Nix), say plainly when a copy is too old or cannot be started by another program, and give each Linux family
// the install that actually works there (immutable distros like Bazzite / SteamOS: Flatpak or the official tarball).
import type { ToolOs } from './toolsCatalog.ts';
import { compareVersions, versionParts } from './toolsDetect.ts';

/** Oldest Blender that works for importing models (= the catalogue's detect.minVersion). */
export const BLENDER_MIN = '4.2';
/** The version VTube Pro's Blender kit is tested with. Newer usually works; we say "not tested yet". */
export const BLENDER_TESTED = '5.1';

export type BlenderSource =
  | 'settings' | 'env' | 'path' | 'program-files' | 'winget' | 'store' | 'steam' | 'scoop' | 'portable' | 'registry'
  | 'applications' | 'spotlight' | 'dmg' | 'brew' | 'snap' | 'flatpak' | 'distro' | 'tarball' | 'nix';

export const SOURCE_LABEL: Record<BlenderSource, string> = {
  settings: 'the path saved in VTube Pro', env: 'the VTP_BLENDER setting', path: 'your PATH', 'program-files': 'the Blender installer',
  winget: 'winget', store: 'the Microsoft Store', steam: 'Steam', scoop: 'Scoop', portable: 'an unzipped download', registry: 'the Blender installer',
  applications: 'Applications', spotlight: 'Spotlight', dmg: 'the Blender disk image', brew: 'Homebrew', snap: 'Snap', flatpak: 'Flatpak',
  distro: 'your Linux packages', tarball: 'the blender.org download', nix: 'Nix',
};

export interface BlenderPlace { path: string; source: BlenderSource }

/** The Microsoft Store package family (its app execution aliases live in %LOCALAPPDATA%\Microsoft\WindowsApps\<family>). */
export const STORE_FAMILY = 'BlenderFoundation.Blender_ppwjx1n5r4v9t';

/**
 * Where people really have Blender (tokens as in shared/toolsCatalog.ts: %VAR%, a leading ~, one `*` per segment).
 * Order = preference when several copies exist and none is saved. Steam libraries on other drives come from Steam's
 * libraryfolders.vdf (parseSteamLibraries), Windows installs on other drives from the uninstall registry, macOS from
 * Spotlight (server/aiSetup.ts).
 */
export const BLENDER_PLACES: Record<ToolOs, BlenderPlace[]> = {
  win: [
    { path: '%ProgramFiles%\\Blender Foundation\\Blender*\\blender.exe', source: 'program-files' },
    { path: '%ProgramFiles(x86)%\\Blender Foundation\\Blender*\\blender.exe', source: 'program-files' },
    { path: '%LOCALAPPDATA%\\Programs\\Blender Foundation\\Blender*\\blender.exe', source: 'program-files' },
    { path: '%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\blender.exe', source: 'winget' },
    { path: '%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\BlenderFoundation.Blender*\\blender-*\\blender.exe', source: 'winget' },
    { path: '%ProgramFiles(x86)%\\Steam\\steamapps\\common\\Blender\\blender.exe', source: 'steam' },
    { path: '%ProgramFiles%\\Steam\\steamapps\\common\\Blender\\blender.exe', source: 'steam' },
    { path: '~\\scoop\\apps\\blender\\current\\blender.exe', source: 'scoop' },
    { path: '~\\Downloads\\blender-*\\blender.exe', source: 'portable' },
    { path: '~\\Downloads\\blender-*\\blender-*\\blender.exe', source: 'portable' },
    { path: '~\\Desktop\\blender-*\\blender.exe', source: 'portable' },
    { path: '~\\Documents\\blender-*\\blender.exe', source: 'portable' },
    { path: '~\\blender-*\\blender.exe', source: 'portable' },
    { path: '%SystemDrive%\\blender*\\blender.exe', source: 'portable' },
    { path: '%ProgramFiles%\\blender-*\\blender.exe', source: 'portable' },
    // the Store copy: since Blender 3.4 its alias is blender-launcher.exe; a blender.exe alias may exist too. Other programs
    // are often refused when they start it ("Access is denied"): the --version check tells (server/aiSetup.ts)
    { path: `%LOCALAPPDATA%\\Microsoft\\WindowsApps\\${STORE_FAMILY}\\blender.exe`, source: 'store' },
  ],
  mac: [
    { path: '/Applications/Blender.app/Contents/MacOS/Blender', source: 'applications' },
    { path: '/Applications/Blender*.app/Contents/MacOS/Blender', source: 'applications' },
    { path: '~/Applications/Blender*.app/Contents/MacOS/Blender', source: 'applications' },
    { path: '~/Library/Application Support/Steam/steamapps/common/Blender/Blender.app/Contents/MacOS/Blender', source: 'steam' },
    { path: '~/Downloads/Blender*.app/Contents/MacOS/Blender', source: 'portable' },
    { path: '~/Desktop/Blender*.app/Contents/MacOS/Blender', source: 'portable' },
    // opened the .dmg but never dragged Blender out: it runs, but vanishes when the disk image is ejected
    { path: '/Volumes/Blender*/Blender.app/Contents/MacOS/Blender', source: 'dmg' },
  ],
  linux: [
    { path: '/snap/bin/blender', source: 'snap' },
    { path: '/var/lib/flatpak/exports/bin/org.blender.Blender', source: 'flatpak' },
    { path: '~/.local/share/flatpak/exports/bin/org.blender.Blender', source: 'flatpak' },
    { path: '/usr/bin/blender', source: 'distro' },
    { path: '/usr/local/bin/blender', source: 'distro' },
    { path: '/run/current-system/sw/bin/blender', source: 'nix' },
    { path: '~/.nix-profile/bin/blender', source: 'nix' },
    { path: '~/Applications/blender*/blender', source: 'tarball' },
    { path: '~/blender*/blender', source: 'tarball' },
    { path: '~/Downloads/blender-*/blender', source: 'tarball' },
    { path: '~/.local/opt/blender*/blender', source: 'tarball' },
    { path: '~/.local/bin/blender', source: 'tarball' },
    { path: '/opt/blender*/blender', source: 'tarball' },
    { path: '~/.steam/steam/steamapps/common/Blender/blender', source: 'steam' },
    { path: '~/.local/share/Steam/steamapps/common/Blender/blender', source: 'steam' },
    { path: '~/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/Blender/blender', source: 'steam' },
  ],
};

/** Steam's library list file per OS (other drives' libraries are listed in it). */
export const STEAM_VDF: Record<ToolOs, string[]> = {
  win: ['%ProgramFiles(x86)%\\Steam\\steamapps\\libraryfolders.vdf', '%ProgramFiles%\\Steam\\steamapps\\libraryfolders.vdf'],
  mac: ['~/Library/Application Support/Steam/steamapps/libraryfolders.vdf'],
  linux: ['~/.steam/steam/steamapps/libraryfolders.vdf', '~/.local/share/Steam/steamapps/libraryfolders.vdf', '~/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/libraryfolders.vdf'],
};
/** Blender inside one Steam library folder. */
export function steamBlenderExe(library: string, os: ToolOs): string {
  const lib = library.replace(/[\\/]+$/, '');
  if (os === 'win') return `${lib}\\steamapps\\common\\Blender\\blender.exe`;
  if (os === 'mac') return `${lib}/steamapps/common/Blender/Blender.app/Contents/MacOS/Blender`;
  return `${lib}/steamapps/common/Blender/blender`;
}

// ---------------------------------------------------------------- parsers (unit-tested with real-looking text)
/** Steam's libraryfolders.vdf: every `"path"  "<folder>"` (Windows paths come with doubled backslashes). */
export function parseSteamLibraries(vdf: string): string[] {
  const out: string[] = [];
  for (const m of String(vdf ?? '').matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/gi)) {
    const p = m[1].replace(/\\\\/g, '\\');
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** One value from `reg query <key> /v <name>` output (REG_SZ / REG_EXPAND_SZ). */
export function parseRegValue(out: string, name: string): string | null {
  const re = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+REG_(?:EXPAND_)?SZ\\s+(.+?)\\s*$`, 'im');
  const m = re.exec(String(out ?? ''));
  return m ? m[1] : null;
}
/** The keys in `reg query <uninstall key> /s /f Blender /d` output whose DisplayName says Blender (not add-ons / launchers). */
export function parseRegUninstallKeys(out: string): string[] {
  const keys: string[] = [];
  let cur = '';
  for (const raw of String(out ?? '').split(/\r?\n/)) {
    const l = raw.trimEnd();
    if (/^HKEY_/i.test(l)) { cur = l.trim(); continue; }
    const m = /^\s*DisplayName\s+REG_SZ\s+(.+)$/i.exec(l);
    if (m && cur && /^blender(\s+\d|\s*$)/i.test(m[1].trim()) && !keys.includes(cur)) keys.push(cur);
  }
  return keys;
}
/** Spotlight (`mdfind kMDItemCFBundleIdentifier == org.blenderfoundation.blender`): app bundles -> their Blender binary. */
export function parseMdfind(out: string): string[] {
  return String(out ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /\.app$/i.test(l) && l.startsWith('/') && !l.includes('/.Trash/'))
    .map((app) => `${app}/Contents/MacOS/Blender`);
}

// ---------------------------------------------------------------- versions
export type Compat = 'ok' | 'newer' | 'old' | 'unknown';
/** Can VTube Pro use this Blender? `newer` works but is not tested yet; `old` must be updated. */
export function blenderCompat(version: string | undefined): { level: Compat; text: string } {
  if (!version || !versionParts(version).length) return { level: 'unknown', text: 'We could not read its version.' };
  if (compareVersions(version, BLENDER_MIN) < 0) return { level: 'old', text: `Blender ${version} is too old: VTube Pro needs ${BLENDER_MIN} or newer (${BLENDER_TESTED} is best).` };
  const [ma, mi] = versionParts(version), [ta, ti] = versionParts(BLENDER_TESTED);
  if (ma > ta || (ma === ta && (mi ?? 0) > (ti ?? 0))) return { level: 'newer', text: `Blender ${version} is newer than the ${BLENDER_TESTED} VTube Pro is tested with. It usually works; the self-test below tells.` };
  return { level: 'ok', text: ma === ta && (mi ?? 0) === (ti ?? 0) ? `Blender ${version}: the version VTube Pro is tested with.` : `Blender ${version} works with VTube Pro.` };
}

export interface BlenderInstall {
  path: string;
  source: BlenderSource;
  /** `--version` answered (the program can really be started by VTube Pro). */
  runs: boolean;
  version?: string;
  compat: Compat;
  /** One plain sentence (why it cannot be used, or a caveat). */
  note?: string;
}

const usable = (b: BlenderInstall) => b.runs && (b.compat === 'ok' || b.compat === 'newer') && b.source !== 'dmg';
/**
 * The Blender VTube Pro should use: the saved one when it still works, else the tested version, else the newest that
 * works (a version newer than tested only when nothing tested-or-older works). null = none usable.
 */
export function pickBlender(list: readonly BlenderInstall[], savedPath?: string, win = false): BlenderInstall | null {
  const same = (a: string, b: string) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
  const saved = savedPath ? list.find((b) => same(b.path, savedPath)) : undefined;
  if (saved && usable(saved)) return saved;
  const ok = list.filter(usable);
  const tested = ok.filter((b) => b.compat === 'ok').sort((a, b) => compareVersions(b.version ?? '0', a.version ?? '0'));
  if (tested.length) return tested[0];                                                       // newest tested-or-older
  return ok.filter((b) => b.compat === 'newer').sort((a, b) => compareVersions(a.version ?? '0', b.version ?? '0'))[0] ?? null; // closest newer
}

// ---------------------------------------------------------------- Linux: which family, and what install works there
export interface OsRelease { id: string; idLike: string[]; variantId: string; name: string; prettyName: string; versionId: string }
/** /etc/os-release (or /usr/lib/os-release) text -> the fields we use. */
export function parseOsRelease(text: string): OsRelease {
  const v: Record<string, string> = {};
  for (const l of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(l);
    if (m) v[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return { id: (v.ID ?? '').toLowerCase(), idLike: (v.ID_LIKE ?? '').toLowerCase().split(/\s+/).filter(Boolean), variantId: (v.VARIANT_ID ?? '').toLowerCase(),
    name: v.NAME ?? '', prettyName: v.PRETTY_NAME ?? v.NAME ?? '', versionId: v.VERSION_ID ?? '' };
}

export type LinuxFamily = 'ubuntu' | 'mint' | 'debian' | 'fedora' | 'arch' | 'suse' | 'nixos' | 'other';
export interface LinuxFlavor { family: LinuxFamily; immutable: boolean; steamos: boolean; label: string }

const IMMUTABLE_IDS = /^(bazzite|bluefin|aurora|ublue.*|steamos|holoiso|chimeraos|endless|vanilla|kinoite|silverblue|fedora-(silverblue|kinoite)|opensuse-(microos|aeon|kalpa)|aeon|kalpa|blendos|nixos)$/;
const IMMUTABLE_VARIANTS = /^(silverblue|kinoite|sericea|onyx|cosmic-atomic|atomic|iot|coreos|.*-atomic|bazzite.*|steamdeck)$/;
/** `ostree` = /run/ostree-booted exists (Fedora Atomic, Bazzite, Bluefin, Endless ...): system folders are read-only. */
export function linuxFlavor(r: OsRelease, ostree = false): LinuxFlavor {
  const ids = [r.id, ...r.idLike];
  const has = (x: string) => ids.includes(x);
  const family: LinuxFamily = r.id === 'nixos' ? 'nixos' : r.id === 'linuxmint' || r.id === 'mint' ? 'mint' : has('ubuntu') ? 'ubuntu' : has('debian') ? 'debian'
    : has('fedora') || has('rhel') || has('centos') ? 'fedora' : has('arch') || r.id === 'steamos' ? 'arch' : ids.some((x) => x.startsWith('opensuse') || x === 'suse' || x === 'sles') ? 'suse' : 'other';
  const steamos = r.id === 'steamos' || r.variantId === 'steamdeck';
  const immutable = ostree || steamos || IMMUTABLE_IDS.test(r.id) || IMMUTABLE_VARIANTS.test(r.variantId);
  return { family, immutable, steamos, label: r.prettyName || r.name || 'Linux' };
}

export interface InstallStep { text: string; command?: string; url?: string }
export interface LinuxPlan {
  /** One plain sentence: what fits this computer. */
  intro: string;
  /** The recommended way, then the alternatives (each copy-only: the helper never runs Linux commands). */
  ways: { title: string; steps: InstallStep[]; recommended?: boolean }[];
}

const BL_DL = 'https://www.blender.org/download/';
const FLATHUB = 'https://flathub.org/apps/org.blender.Blender';
const SNAP = 'https://snapcraft.io/blender';
const tarball = (dir = '~/Applications'): { title: string; steps: InstallStep[] } => ({
  title: 'The official download (no install, no password)',
  steps: [
    { text: 'Download “Blender for Linux” (.tar.xz) from blender.org.', url: BL_DL },
    { text: 'Unpack it into your home folder:', command: `mkdir -p ${dir} && tar -xf ~/Downloads/blender-*-linux-x64.tar.xz -C ${dir}` },
    { text: 'Come back here and press “Check again”: VTube Pro finds it there by itself.' },
  ],
});
const flatpak = (user: boolean, store?: string): { title: string; steps: InstallStep[] } => ({
  title: 'Flatpak (from Flathub)',
  steps: [
    ...(store ? [{ text: `Easiest: open ${store}, search for “Blender” and install the Flathub one.` }] : []),
    { text: store ? 'Or copy this into a terminal:' : 'Copy this into a terminal:', command: `flatpak install ${user ? '--user ' : ''}flathub org.blender.Blender` },
    { text: 'Flathub’s Blender page:', url: FLATHUB },
    { text: 'Come back here and press “Check again”.' },
  ],
});

/** The Blender install that works on this Linux (the helper shows commands to copy; it never runs them). */
export function linuxBlenderPlan(f: LinuxFlavor): LinuxPlan {
  if (f.family === 'nixos') return {
    intro: `${f.label} keeps programs in Nix: add Blender there (the blender.org download does not run on NixOS).`,
    ways: [
      { title: 'Nix', recommended: true, steps: [{ text: 'Copy this into a terminal (or add pkgs.blender to your configuration.nix):', command: 'nix profile install nixpkgs#blender' }, { text: 'Come back here and press “Check again”.' }] },
      flatpak(true),
    ],
  };
  if (f.immutable) {
    const store = f.steamos ? 'Discover (switch the Deck to Desktop Mode first)' : 'your app store (Bazaar, Discover or Software)';
    return {
      intro: `${f.label} has a read-only system, so system packages (and sudo installs) are not the way: use Flatpak or the official download.`,
      ways: [{ ...flatpak(true, store), recommended: true }, tarball()],
    };
  }
  switch (f.family) {
    case 'ubuntu': return {
      intro: `On ${f.label}, the Snap is the easy, up-to-date Blender (the apt one is too old for VTube Pro).`,
      ways: [
        { title: 'Snap', recommended: true, steps: [{ text: 'Copy this into a terminal (it asks for your password):', command: 'sudo snap install blender --classic' }, { text: 'Blender’s Snap page:', url: SNAP }, { text: 'Come back here and press “Check again”.' }] },
        flatpak(false), tarball(),
      ],
    };
    case 'mint': return { intro: `${f.label} comes with Flathub: install Blender from the Software Manager (Flatpak).`, ways: [{ ...flatpak(false, 'the Software Manager'), recommended: true }, tarball()] };
    case 'debian': return { intro: `On ${f.label}, the official download is the simplest up-to-date Blender (Debian’s own may be too old).`, ways: [{ ...tarball(), recommended: true }, flatpak(false)] };
    case 'fedora': return {
      intro: `${f.label} has an up-to-date Blender in its own packages (Fedora 41 or newer).`,
      ways: [
        { title: 'Fedora packages', recommended: true, steps: [{ text: 'Copy this into a terminal (it asks for your password):', command: 'sudo dnf install blender' }, { text: 'Come back here and press “Check again”.' }] },
        flatpak(false), tarball(),
      ],
    };
    case 'arch': return {
      intro: `${f.label} has the newest Blender in its own packages.`,
      ways: [{ title: 'pacman', recommended: true, steps: [{ text: 'Copy this into a terminal (it asks for your password):', command: 'sudo pacman -S blender' }, { text: 'Come back here and press “Check again”.' }] }, flatpak(false), tarball()],
    };
    case 'suse': return {
      intro: `On ${f.label}, install Blender from openSUSE’s packages (Tumbleweed is up to date; on Leap use Flatpak).`,
      ways: [{ title: 'zypper', recommended: true, steps: [{ text: 'Copy this into a terminal (it asks for your password):', command: 'sudo zypper install blender' }, { text: 'Come back here and press “Check again”.' }] }, flatpak(false), tarball()],
    };
    default: return { intro: 'Flatpak or the official download work on almost every Linux.', ways: [{ ...flatpak(false), recommended: true }, tarball()] };
  }
}

/** Every link a plan shows (unit-tested: official hosts only). */
export const LINUX_PLAN_HOSTS = ['www.blender.org', 'flathub.org', 'snapcraft.io'];
