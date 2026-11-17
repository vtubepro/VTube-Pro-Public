// Read-only hardware scan for the Local AI recommender (helper page /local-ai, server/routes/localAi.ts).
// Runs ONLY after the user clicks "Yes, scan my computer". It reads: graphics card model + memory, RAM, processor model +
// core count, free disk space on the home drive, OS name / version. It never reads names, serial numbers, user names,
// files or network details, writes nothing, and the result stays in this process's memory (never on disk, never sent
// anywhere). Every probe is a read-only system query:
//   Windows  nvidia-smi --query-gpu, PowerShell Get-CimInstance Win32_VideoController / Win32_OperatingSystem, and the
//            display-adapter class key HardwareInformation.qwMemorySize (64-bit VRAM; WMI's AdapterRAM stops at 4 GB)
//   macOS    system_profiler SPDisplaysDataType -json (Apple Silicon = unified memory), sw_vers -productVersion
//   Linux    nvidia-smi, rocm-smi --showproductname --showmeminfo vram --json, lspci, /sys/class/drm/*/mem_info_vram_total,
//            /proc/meminfo, /etc/os-release
// The parsers are pure and unit-tested with recorded outputs per OS (tools/local_ai_unit.ts).
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import type { GpuInfo, HwInfo } from '../shared/localAi/recommend.ts';
import { isIntegrated, vendorOf } from '../shared/capability.ts';

const GiB = 1024 ** 3;
const r1 = (n: number) => Math.round(n * 10) / 10;

// vendorOf / isIntegrated live in shared/capability.ts (the browser's no-helper report names cards the same way).
export { vendorOf, isIntegrated };
const VIRTUAL = /basic display|basic render|virtual|remote|parsec|meta(-| )?display|spacedesk|citrix|vmware|hyper-v|idd|dummy/i;

/** `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits` */
export function parseNvidiaSmi(out: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    const [name, mem] = line.split(',').map((s) => s.trim());
    const mib = Number(mem);
    if (!name || !Number.isFinite(mib) || mib <= 0) continue;
    gpus.push({ name, vendor: 'nvidia', vramGB: r1(mib / 1024), source: 'nvidia-smi' });
  }
  return gpus;
}

/** The PowerShell probe's JSON ({controllers, reg, os}); see WIN_SCRIPT. */
export function parseWindowsProbe(json: string): { gpus: GpuInfo[]; osName: string | null } {
  let d: any;
  try { d = JSON.parse(json); } catch { return { gpus: [], osName: null }; }
  const arr = (v: unknown): any[] => (Array.isArray(v) ? v : v ? [v] : []);
  const reg = arr(d?.reg).filter((x) => typeof x?.DriverDesc === 'string');
  const gpus: GpuInfo[] = [];
  for (const c of arr(d?.controllers)) {
    const name = String(c?.Name ?? '').trim();
    if (!name || VIRTUAL.test(name)) continue;
    const regMem = reg.find((x) => x.DriverDesc.trim() === name && typeof x.mem === 'number' && x.mem > 0)?.mem as number | undefined;
    const wmi = typeof c?.AdapterRAM === 'number' && c.AdapterRAM > 0 ? c.AdapterRAM : 0;
    // AdapterRAM is a uint32: anything >= 4 GB reads as ~4 GB (or wraps). Prefer the registry's 64-bit size.
    const bytes = regMem ?? wmi;
    const integrated = isIntegrated(name);
    gpus.push({ name, vendor: vendorOf(name), vramGB: bytes && !integrated ? r1(bytes / GiB) : null, integrated: integrated || undefined, source: regMem ? 'registry' : 'cim' });
  }
  const cap = typeof d?.os?.Caption === 'string' ? d.os.Caption.replace(/^Microsoft\s+/, '').trim() : null;
  const ver = typeof d?.os?.Version === 'string' ? d.os.Version : '';
  return { gpus, osName: cap ? `${cap}${ver ? ` (${ver})` : ''}` : null };
}

/** "8 GB", "1536 MB", "24576 MB" -> GB */
export function sizeToGB(s: unknown): number | null {
  const m = /([\d.]+)\s*(TB|GB|MB)/i.exec(String(s ?? ''));
  if (!m) return null;
  const v = Number(m[1]);
  return r1(m[2].toUpperCase() === 'TB' ? v * 1024 : m[2].toUpperCase() === 'GB' ? v : v / 1024);
}

/** `system_profiler SPDisplaysDataType -json` */
export function parseMacDisplays(json: string): GpuInfo[] {
  let d: any;
  try { d = JSON.parse(json); } catch { return []; }
  const gpus: GpuInfo[] = [];
  for (const g of Array.isArray(d?.SPDisplaysDataType) ? d.SPDisplaysDataType : []) {
    const name = String(g?.sppci_model ?? g?._name ?? '').trim();
    if (!name) continue;
    const apple = /^apple\b/i.test(name) || /apple/i.test(String(g?.spdisplays_vendor ?? ''));
    if (apple) { gpus.push({ name, vendor: 'apple', vramGB: null, unified: true, source: 'system_profiler' }); continue; }
    const dedicated = sizeToGB(g?.spdisplays_vram ?? g?._spdisplays_vram);
    const shared = g?.spdisplays_vram_shared ?? g?._spdisplays_vram_shared;
    gpus.push({ name, vendor: vendorOf(name), vramGB: dedicated, integrated: (!dedicated && !!shared) || isIntegrated(name) || undefined, source: 'system_profiler' });
  }
  return gpus;
}

/** `rocm-smi --showproductname --showmeminfo vram --json` (key names vary between ROCm versions). */
export function parseRocmSmi(json: string): GpuInfo[] {
  let d: any;
  try { d = JSON.parse(json); } catch { return []; }
  const gpus: GpuInfo[] = [];
  for (const [card, v] of Object.entries<any>(d ?? {})) {
    if (!/^card\d+$/i.test(card) || !v || typeof v !== 'object') continue;
    const get = (re: RegExp) => { const k = Object.keys(v).find((x) => re.test(x)); return k ? v[k] : undefined; };
    const series = String(get(/^card series$/i) ?? get(/^card model$/i) ?? get(/product name/i) ?? 'AMD GPU');
    const bracket = /\[([^\]]+)\]\s*$/.exec(series)?.[1];
    const name = bracket && /radeon|instinct|pro/i.test(bracket) ? bracket : series;
    const total = Number(get(/vram total memory/i));
    gpus.push({ name, vendor: 'amd', vramGB: total > 0 ? r1(total / GiB) : null, source: 'rocm-smi' });
  }
  return gpus;
}

/** `lspci` (names only; no VRAM). */
export function parseLspci(out: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\S+\s+(VGA compatible controller|3D controller|Display controller):\s*(.+?)(\s*\(rev [^)]+\))?$/.exec(line.trim());
    if (!m) continue;
    const raw = m[2];
    const bracket = /\[([^\]]*(GeForce|RTX|GTX|Quadro|Radeon|Arc|Instinct)[^\]]*)\]/i.exec(raw)?.[1];
    const name = bracket ? `${raw.split(' ')[0]} ${bracket}` : raw;
    if (VIRTUAL.test(name) || /virtio|qxl|bochs|cirrus|matrox|aspeed/i.test(name)) continue;
    gpus.push({ name, vendor: vendorOf(raw), vramGB: null, integrated: isIntegrated(name) || undefined, source: 'lspci' });
  }
  return gpus;
}

/** /proc/meminfo -> GB */
export function parseMeminfo(txt: string): { totalGB: number | null; availGB: number | null } {
  const kb = (k: string) => { const m = new RegExp(`^${k}:\\s+(\\d+)\\s*kB`, 'm').exec(txt); return m ? r1((Number(m[1]) * 1024) / GiB) : null; };
  return { totalGB: kb('MemTotal'), availGB: kb('MemAvailable') };
}

export function parseOsRelease(txt: string): string | null {
  const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(txt);
  return m ? m[1].trim() : null;
}

/** Merge GPU lists from several probes: the first probe with VRAM wins for the same vendor + similar name. */
export function mergeGpus(...lists: GpuInfo[][]): GpuInfo[] {
  const out: GpuInfo[] = [];
  const key = (g: GpuInfo) => g.name.toLowerCase().replace(/nvidia|corporation|advanced micro devices, inc\.|\[amd\/ati\]|\(r\)|\(tm\)|geforce|amd|radeon|[^a-z0-9]/g, '');
  for (const g of lists.flat()) {
    const same = out.find((o) => o.vendor === g.vendor && (key(o).includes(key(g)) || key(g).includes(key(o))));
    if (!same) out.push({ ...g });
    else if (same.vramGB === null && g.vramGB !== null) Object.assign(same, { vramGB: g.vramGB, source: g.source, integrated: g.integrated });
  }
  return out;
}

// ---------------------------------------------------------------- the scanner (I/O injected so tests can mock it)
export type RunCmd = (cmd: string, args: string[]) => Promise<string | null>;
export interface ScanEnv {
  platform: NodeJS.Platform;
  arch: string;
  totalmemBytes: number;
  cpuModel: string;
  cpuCount: number;
  osRelease: string;
  run: RunCmd;
  readFile: (p: string) => Promise<string | null>;
  listDir: (p: string) => Promise<string[]>;
  freeDiskGB: () => Promise<number | null>;
}

/** Read-only probe for Windows. Outputs {controllers:[{Name,AdapterRAM,DriverVersion}], reg:[{DriverDesc,mem}], os:{Caption,Version}}. */
export const WIN_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  '$c=@(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion)',
  "$r=@(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' | ForEach-Object { [pscustomobject]@{DriverDesc=$_.DriverDesc; mem=$_.'HardwareInformation.qwMemorySize'} })",
  '$o=Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version',
  '[pscustomobject]@{controllers=$c;reg=$r;os=$o} | ConvertTo-Json -Depth 3 -Compress',
].join('; ');

export const defaultRun: RunCmd = (cmd, args) => new Promise((resolve) => {
  try {
    execFile(cmd, args, { timeout: 10_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => resolve(err ? null : String(stdout)));
  } catch { resolve(null); }
});

export function defaultEnv(): ScanEnv {
  const cpus = os.cpus();
  return {
    platform: process.platform, arch: process.arch, totalmemBytes: os.totalmem(),
    cpuModel: (cpus[0]?.model ?? '').replace(/\s+/g, ' ').trim(), cpuCount: cpus.length, osRelease: os.release(),
    run: defaultRun,
    readFile: (p) => fs.readFile(p, 'utf8').catch(() => null),
    listDir: (p) => fs.readdir(p).catch(() => []),
    freeDiskGB: async () => {
      try { const s = await fs.statfs(os.homedir()); return r1((Number(s.bavail) * Number(s.bsize)) / GiB); } catch { return null; }
    },
  };
}

export async function scanHardware(env: ScanEnv = defaultEnv()): Promise<HwInfo> {
  const notes: string[] = [];
  let gpus: GpuInfo[] = [];
  let osName = '';
  let ramGB = r1(env.totalmemBytes / GiB);
  const nvidia = async () => {
    const out = await env.run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']);
    if (out === null) notes.push('nvidia-smi: not found (no NVIDIA driver, or no NVIDIA card)');
    return out ? parseNvidiaSmi(out) : [];
  };
  if (env.platform === 'win32') {
    const [nv, probe] = await Promise.all([
      nvidia(),
      env.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT]),
    ]);
    const w = probe ? parseWindowsProbe(probe) : { gpus: [], osName: null };
    if (!probe) notes.push('Windows graphics query (CIM) did not answer');
    gpus = mergeGpus(nv, w.gpus);
    osName = w.osName ?? `Windows ${env.osRelease}`;
  } else if (env.platform === 'darwin') {
    const [disp, ver] = await Promise.all([env.run('system_profiler', ['SPDisplaysDataType', '-json']), env.run('sw_vers', ['-productVersion'])]);
    if (!disp) notes.push('system_profiler did not answer');
    gpus = disp ? parseMacDisplays(disp) : [];
    if (!gpus.length && env.arch === 'arm64') gpus = [{ name: 'Apple Silicon', vendor: 'apple', vramGB: null, unified: true, source: 'arch' }];
    osName = `macOS ${ver?.trim() || env.osRelease}`;
  } else {
    const [nv, rocm, pci, mem, rel] = await Promise.all([
      nvidia(),
      env.run('rocm-smi', ['--showproductname', '--showmeminfo', 'vram', '--json']),
      env.run('lspci', []),
      env.readFile('/proc/meminfo'),
      env.readFile('/etc/os-release'),
    ]);
    // amdgpu exposes VRAM in sysfs even without ROCm installed
    const sysfs: GpuInfo[] = [];
    for (const card of (await env.listDir('/sys/class/drm')).filter((c) => /^card\d+$/.test(c))) {
      const total = Number((await env.readFile(`/sys/class/drm/${card}/device/mem_info_vram_total`))?.trim());
      if (total > 2 * GiB) sysfs.push({ name: 'AMD Radeon', vendor: 'amd', vramGB: r1(total / GiB), source: 'sysfs' });
    }
    const pciGpus = pci ? parseLspci(pci) : [];
    if (!pci) notes.push('lspci: not found');
    // sysfs has no names: attach its VRAM to the lspci AMD entries in order
    const amdPci = pciGpus.filter((g) => g.vendor === 'amd' && !g.integrated);
    sysfs.forEach((s, i) => { if (amdPci[i]) { amdPci[i].vramGB = s.vramGB; amdPci[i].source = 'lspci+sysfs'; } });
    gpus = mergeGpus(nv, rocm ? parseRocmSmi(rocm) : [], pciGpus, amdPci.length ? [] : sysfs);
    if (mem) { const m = parseMeminfo(mem); if (m.totalGB) ramGB = m.totalGB; }
    osName = (rel && parseOsRelease(rel)) || `Linux ${env.osRelease}`;
  }
  const knownVram = gpus.some((g) => g.vramGB || g.unified);
  if (gpus.length && !knownVram) notes.push('Graphics memory could not be read; you can type it in instead');
  return {
    os: env.platform === 'win32' ? 'windows' : env.platform === 'darwin' ? 'macos' : env.platform === 'linux' ? 'linux' : 'other',
    osName, arch: env.arch,
    cpu: { model: env.cpuModel, cores: env.cpuCount },
    ramGB, gpus, diskFreeGB: await env.freeDiskGB(), notes,
  };
}
