# VTube Pro: Windows graphics-card reading for the stall guard (when nvidia-smi is not there). Prints one JSON line every
# 5 s: {"u":<dedicated bytes used>,"t":<total bytes>,"g":<busiest 3D engine %, -1 = not measured>,"ga":<its age in ms>}.
# Run by: the helper (server/gpuWatch.ts), as
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy <RemoteSigned|Bypass> -File gpu_counters.ps1 -ParentPid <helper pid>
# Read-only (registry + performance counters). -ParentPid is the helper's process id: the loop ends when it is gone.
# Total memory comes from the display-adapter class key (64-bit qwMemorySize, as server/hwScan.ts reads it).
param(
  [Parameter(Mandatory = $true)] [ValidateRange(1, 2147483647)] [int]$ParentPid
)
$ErrorActionPreference = 'SilentlyContinue'
$pp = $ParentPid
$tot = [int64](@(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0*' | ForEach-Object { $_.'HardwareInformation.qwMemorySize' } | Where-Object { $_ -gt 0 }) | Measure-Object -Maximum).Maximum
# (the helper's start time too: a reused process id must not keep the loop alive)
$st = (Get-Process -Id $pp -ErrorAction SilentlyContinue).StartTime
$n = 0; $g = -1; $ga = [DateTime]::UtcNow
while ($true) {
  $p = Get-Process -Id $pp -ErrorAction SilentlyContinue; if (-not $p -or $p.StartTime -ne $st) { exit }
  $u = (Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory -OperationTimeoutSec 4 | Measure-Object DedicatedUsage -Maximum).Maximum
  # (a query that timed out - the first, cold one can - is no reading: -1 drops the line, not "0 GB used")
  if ($u -eq $null) { $u = -1 }
  # the BUSIEST engine (each engine's load summed over the processes using it), not the sum of every engine: two
  # engines at modest load (or a hybrid PC's two adapters) read as a full card and held stall mode on (review round 1)
  if ($n % 2 -eq 0) { $s = (Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -Filter "Name LIKE '%engtype_3D'" -OperationTimeoutSec 8 | Group-Object { $_.Name -replace '^pid_\d+_','' } | ForEach-Object { ($_.Group | Measure-Object UtilizationPercentage -Sum).Sum } | Measure-Object -Maximum).Maximum; if ($s -ne $null) { $g = [double]$s; $ga = [DateTime]::UtcNow } }
  # (the utilisation's age in ms: the page judges it on that, not on the line's time)
  $age = -1; if ($g -ge 0) { $age = [int64]([DateTime]::UtcNow - $ga).TotalMilliseconds }
  $n++
  [Console]::Out.WriteLine('{"u":' + [int64]$u + ',"t":' + [int64]$tot + ',"g":' + [double]$g + ',"ga":' + $age + '}'); [Console]::Out.Flush()
  Start-Sleep -Seconds 5
}
