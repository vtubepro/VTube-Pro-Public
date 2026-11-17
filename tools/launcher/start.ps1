<#
  VTube Pro launcher - what "Start VTube Pro.cmd" runs. Plain-language, three steps:
    1. Getting things ready  - first time: the full setup (setup.ps1: Node.js check, app files, build). Later: a quick
                               check that only rebuilds when something changed. A release zip with its own Node.js
                               (runtime\node\node.exe + node_modules + dist) skips this step entirely.
    2. Starting VTube Pro    - starts the server in the background, remembers its PID in .setup-state\server.pid
                               (+ server.json) so "Stop VTube Pro.cmd" stops exactly that process and nothing else.
    3. Opening the studio    - opens http://127.0.0.1:<port>/ in the default browser; on the very first start it offers
                               a desktop shortcut.
  Already running on the port? It just opens the studio.

  Options:  -Port <n>  -NoBrowser  -NoShortcut
  Environment (for tests and power users; defaults unchanged):
    VTP_PORT=5291          use another port (default 5191)
    VTP_NO_BROWSER=1       do not open the browser (prints the address instead)
    VTP_SHORTCUT=yes|no    answer the desktop-shortcut question without asking
    VTP_DESKTOP_DIR=<dir>  where the shortcut goes (default: your Desktop)
  Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.
#>
[CmdletBinding()]
param([int]$Port = 0, [switch]$NoBrowser, [switch]$NoShortcut)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$Root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
Set-Location -LiteralPath $Root
$State = Join-Path $Root '.setup-state'
New-Item -ItemType Directory -Force -Path $State | Out-Null
if ($Port -le 0) { if ($env:VTP_PORT) { $Port = [int]$env:VTP_PORT } else { $Port = 5191 } }
if ($env:VTP_NO_BROWSER -eq '1') { $NoBrowser = $true }
$Base = "http://127.0.0.1:$Port"
$PidFile = Join-Path $State 'server.pid'
$InfoFile = Join-Path $State 'server.json'
$OutLog = Join-Path $State 'server.log'
$ErrLog = Join-Path $State 'server.err.log'

function Say([string]$m, [string]$c = 'Gray') { Write-Host "   $m" -ForegroundColor $c }
function Step([int]$n, [string]$m) { Write-Host ''; Write-Host "  Step $n of 3: $m" -ForegroundColor Cyan }
function Good([string]$m) { Write-Host "   [ok] $m" -ForegroundColor Green }
function Problem([string]$what, [string]$fix, [string]$link = '') {
  Write-Host ''
  Write-Host "  [X] $what" -ForegroundColor Red
  Write-Host "      How to fix it: $fix" -ForegroundColor Yellow
  if ($link) { Write-Host "      More help: $link" -ForegroundColor Yellow }
  Write-Host ''
  exit 1
}

function Is-VTubePro([int]$p) {
  try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$p/api/settings"; return ($r.StatusCode -eq 200 -and $r.Content -match '"comfyUrl"') }
  catch { return $false }
}
# Is the VTube Pro on this port THIS folder's server? (the release VTube Pro Helper answers the same API, but it is a
# different copy: opening "it" would show the helper's landing page, not this studio). Ours = the PID this launcher
# recorded, or a server process whose command line names this folder.
function Is-ThisCopy([int]$p) {
  try {
    $owner = (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess
    if (-not $owner) { return $true }
    $rec = 0; if (Test-Path -LiteralPath $PidFile) { $rec = [int]((Get-Content -LiteralPath $PidFile -Raw).Trim()) }
    if ($rec -and $owner -eq $rec) { return $true }
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction Stop).CommandLine
    if ($cmd -and $cmd.ToLowerInvariant().Contains($Root.ToLowerInvariant())) { return $true }
    $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$rec" -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -eq $owner }
    return [bool]$kids
  } catch { return $true }   # can't tell: behave as before
}
# Another VTube Pro (usually the installed VTube Pro Helper) holds the port: say so plainly, offer to stop it.
function Stop-OtherCopy([int]$p) {
  Write-Host ''
  Say "Another VTube Pro is already running on port $p (probably another copy of VTube Pro)." 'Yellow'
  Say 'This folder''s studio can''t start while it runs.' 'Yellow'
  try { $a = Read-Host '   Stop it and start this one? [Y/n]' } catch { $a = 'n' }
  if ($a -match '^[nN]') { Say "Left it running. Its own studio: $Base/"; exit 0 }
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Method Post -Headers @{ 'x-vtp-shutdown' = '1' } -Uri "http://127.0.0.1:$p/api/helper/shutdown" | Out-Null }
  catch { Say 'It did not stop (it may be live or busy). Close it from its Start menu entry (Stop VTube Pro), then try again.' 'Yellow'; exit 1 }
  for ($i = 0; $i -lt 40 -and -not (Port-Free $p); $i++) { Start-Sleep -Milliseconds 250 }
  if (-not (Port-Free $p)) { Say 'It is still running. Close it from its Start menu entry (Stop VTube Pro), then try again.' 'Yellow'; exit 1 }
  Good 'Stopped the other VTube Pro.'
}
function Port-Free([int]$p) {
  $l = $null
  try { $l = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Parse('127.0.0.1')), $p; $l.Start(); return $true }
  catch { return $false }
  finally { if ($l) { try { $l.Stop() } catch { } } }
}
function Refresh-Path {
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$m;$u"
  $d = "$env:ProgramFiles\nodejs"
  if ((Test-Path -LiteralPath $d) -and -not (($env:Path -split ';') -contains $d)) { $env:Path = "$env:Path;$d" }
}
function Open-Studio {
  if ($NoBrowser) { Say "Open this address in Chrome or Edge:  $Base/" 'White' }
  else { Start-Process "$Base/" }
}
# The server this folder started last time, if it is still that very process (PID + start time + command line).
function Our-Server {
  if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
  $id = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $PidFile -Raw).Trim(), [ref]$id)) { return $null }
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  if (Test-Path -LiteralPath $InfoFile) {
    try {
      $info = Get-Content -LiteralPath $InfoFile -Raw | ConvertFrom-Json
      if ([int]$info.pid -eq $id -and [string]$info.started -ne [string]$p.StartTime.ToFileTimeUtc()) { return $null }
    } catch { }
  }
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
  if (-not $cim -or "$($cim.CommandLine)" -notmatch '(server[\\/]index\.ts|dist-helper[\\/]index\.mjs)') { return $null }
  return $p
}

Write-Host ''
Write-Host '  VTube Pro' -ForegroundColor Magenta
Write-Host '  Early beta - thank you for trying it out!' -ForegroundColor DarkGray

# ------------------------------------------------------------------ already running?
if (Is-VTubePro $Port) {
  if (Is-ThisCopy $Port) {
    Write-Host ''
    Good 'VTube Pro is already running - opening it.'
    Open-Studio
    exit 0
  }
  Stop-OtherCopy $Port
}

# ------------------------------------------------------------------ 1. getting things ready
Step 1 'Getting things ready'
$bundled = Join-Path $Root 'runtime\node\node.exe'
$haveDeps = Test-Path -LiteralPath (Join-Path $Root 'node_modules\tsx')
# A hardened release built with --drop-tsx ships no tsx: its bundled helper (dist-helper\index.mjs) + the production
# node_modules are all it needs (release-crossos). release_manifest.json marks a release (a source install has none).
if (-not $haveDeps -and (Test-Path -LiteralPath (Join-Path $Root 'dist-helper\index.mjs')) -and (Test-Path -LiteralPath (Join-Path $Root 'release_manifest.json')) -and (Test-Path -LiteralPath (Join-Path $Root 'node_modules\express'))) { $haveDeps = $true }
$haveDist = Test-Path -LiteralPath (Join-Path $Root 'dist\index.html')
$node = $null
if ((Test-Path -LiteralPath $bundled) -and $haveDeps -and $haveDist) {
  $node = $bundled
  Good 'Everything is already in place.'
} else {
  $first = -not ($haveDeps -and $haveDist -and (Test-Path -LiteralPath (Join-Path $State 'npm.lock')))
  if ($first) {
    Say 'This only happens once. It can take a few minutes: VTube Pro downloads the parts it needs'
    Say 'and prepares the studio. If Windows asks to install Node.js, say yes.'
  } else { Say 'Checking for changes (a few seconds, longer after an update)...' }
  $setupArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root 'setup.ps1'), '-NoStart', '-NoUpdate', '-Port', "$Port")
  if (-not $first) { $setupArgs += '-Quick' }
  $ps = (Get-Process -Id $PID).Path
  & $ps @setupArgs
  if ($LASTEXITCODE -ne 0) {
    Problem 'Setup could not finish.' 'read the red [X] line above - it says what is missing. Fix that, then double-click "Start VTube Pro" again.' 'README.md, section "Getting started"'
  }
  Refresh-Path
  if (Test-Path -LiteralPath $bundled) { $node = $bundled }
  else { $c = Get-Command node -ErrorAction SilentlyContinue; if ($c) { $node = $c.Source } }
  if (-not $node) { Problem 'Node.js is not installed.' 'install the LTS version, then double-click "Start VTube Pro" again.' 'https://nodejs.org/en/download' }
  Good 'Ready.'
}

# ------------------------------------------------------------------ 2. starting
Step 2 'Starting VTube Pro'
$proc = Our-Server
if ($proc) {
  # this folder's server is alive: on another port (started with VTP_PORT) -> open that one, else it is still starting
  $oldPort = $Port
  try { $oldPort = [int](Get-Content -LiteralPath $InfoFile -Raw | ConvertFrom-Json).port } catch { }
  if ($oldPort -and $oldPort -ne $Port) {
    $Base = "http://127.0.0.1:$oldPort"
    if (Is-VTubePro $oldPort) { Good "VTube Pro is already running (on port $oldPort) - opening it."; Open-Studio; exit 0 }
    $Port = $oldPort
  }
  Say "VTube Pro is already starting (process $($proc.Id)) - waiting for it."
} else {
  foreach ($f in @($PidFile, $InfoFile)) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force } }
  if (-not (Port-Free $Port)) {
    if (Is-VTubePro $Port) { Good 'VTube Pro is already running - opening it.'; Open-Studio; exit 0 }
    Problem "Another program is already using port $Port." "close that program, or start VTube Pro on a different port: open a Command Prompt here and type   set VTP_PORT=5291   then   `"Start VTube Pro.cmd`"" 'README.md, section "Troubleshooting"'
  }
  # Started through WMI so it is truly independent of this window: closing the window (or this script ending) never
  # takes the server down, and it inherits no handles. It gets no environment from us, so the port goes on the line.
  # Prefer the hardened single-file bundle (helper-hardening: dist-helper\index.mjs) when the release ships it; a source
  # install (the owner) has no dist-helper, so it runs the TypeScript through tsx exactly as before.
  if (Test-Path -LiteralPath (Join-Path $Root 'dist-helper\index.mjs')) { $runArgs = 'dist-helper\index.mjs' } else { $runArgs = '--import tsx server/index.ts' }
  # The few VTP_* folder settings a caller may have set for THIS start go on the line too (WMI passes no environment):
  # VTP_CONFIG_HOME / VTP_DATA_HOME / VTP_PORTABLE (where a release keeps its settings, server/paths.ts) and
  # VTP_SPOUT_REGISTRY (a private Spout2 sender list for tests). Plain path characters only; anything else is dropped.
  $fwd = ''
  foreach ($k in 'VTP_CONFIG_HOME', 'VTP_DATA_HOME', 'VTP_PORTABLE', 'VTP_SPOUT_REGISTRY') {
    $v = [Environment]::GetEnvironmentVariable($k)
    if ($v -and $v -match '^[A-Za-z0-9 _.:\\/()-]{1,260}$') { $fwd += "set `"$k=$v`" && " }
  }
  $line = "cmd.exe /d /s /c `"set `"VTP_PORT=$Port`" && $fwd`"$node`" $runArgs 1>`"$OutLog`" 2>`"$ErrLog`"`""
  $proc = $null
  try {
    $si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $line; CurrentDirectory = $Root; ProcessStartupInformation = $si }
    if ($r.ReturnValue -eq 0) { $proc = Get-Process -Id ([int]$r.ProcessId) -ErrorAction SilentlyContinue }
  } catch { }
  if (-not $proc) { Problem 'Windows did not let VTube Pro start.' 'your antivirus may have blocked Node.js. Allow it, then double-click "Start VTube Pro" again.' }
  Set-Content -LiteralPath $PidFile -Value $proc.Id -Encoding ASCII
  $started = ''
  try { $started = [string]$proc.StartTime.ToFileTimeUtc() } catch { }
  Set-Content -LiteralPath $InfoFile -Encoding ASCII -Value (@{ pid = $proc.Id; port = $Port; started = $started; node = $node } | ConvertTo-Json -Compress)
}
$ready = $false
$t0 = Get-Date
while (((Get-Date) - $t0).TotalSeconds -lt 90) {
  Start-Sleep -Milliseconds 500
  if ($proc.HasExited) { break }
  if (Is-VTubePro $Port) { $ready = $true; break }
  $s = [int]((Get-Date) - $t0).TotalSeconds
  if ($s -gt 0 -and $s % 15 -eq 0) { Say "still starting ($s s)..." 'DarkGray'; Start-Sleep -Milliseconds 500 }
}
if (-not $ready) {
  if (Test-Path -LiteralPath $ErrLog) {
    $tail = @(Get-Content -LiteralPath $ErrLog -Tail 12 -ErrorAction SilentlyContinue)
    if ($tail.Count) { Write-Host ''; Say 'Last messages from VTube Pro:' 'DarkGray'; foreach ($l in $tail) { Say "  $l" 'DarkGray' } }
  }
  if ($proc.HasExited) {
    foreach ($f in @($PidFile, $InfoFile)) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force } }
    Problem 'VTube Pro stopped while starting.' 'the lines above say why. Often a restart of the PC or running START_HERE.bat (full setup) fixes it.' "$ErrLog"
  }
  Problem 'VTube Pro is taking too long to start.' 'wait a minute and double-click "Start VTube Pro" again (it will not start a second copy).' "$ErrLog"
}
Good "VTube Pro is running on $Base"

# ------------------------------------------------------------------ 3. opening the studio
Step 3 'Opening the studio'
Open-Studio
if (-not $NoBrowser) { Good 'The studio is opening in your browser (Chrome or Edge work best).' }

$asked = Join-Path $State 'shortcut.asked'
if (-not $NoShortcut -and $env:VTP_SHORTCUT -ne 'skip' -and -not (Test-Path -LiteralPath $asked)) {
  $yes = $false
  if ($env:VTP_SHORTCUT -eq 'yes') { $yes = $true }
  elseif ($env:VTP_SHORTCUT -eq 'no') { $yes = $false }
  else {
    Write-Host ''
    try { $a = Read-Host '   Add a "VTube Pro" shortcut to your desktop? [Y/n]' } catch { $a = 'n' }
    $yes = -not ("$a".Trim() -match '^(n|no)$')
  }
  Set-Content -LiteralPath $asked -Value (Get-Date -Format o) -Encoding ASCII
  if ($yes) {
    try {
      $desk = $env:VTP_DESKTOP_DIR
      if (-not $desk) { $desk = [Environment]::GetFolderPath('Desktop') }
      $ws = New-Object -ComObject WScript.Shell
      $lnk = $ws.CreateShortcut((Join-Path $desk 'VTube Pro.lnk'))
      $lnk.TargetPath = Join-Path $Root 'Start VTube Pro.cmd'
      $lnk.WorkingDirectory = $Root
      $lnk.Description = 'Start VTube Pro and open the studio'
      $ico = Join-Path $Root 'tools\launcher\vtubepro.ico'
      if (Test-Path -LiteralPath $ico) { $lnk.IconLocation = "$ico,0" }
      $lnk.Save()
      Good 'Added "VTube Pro" to your desktop.'
    } catch { Say "Could not add the shortcut ($($_.Exception.Message)). You can always start from this folder." 'Yellow' }
  }
}

Write-Host ''
Write-Host '  VTube Pro is running.' -ForegroundColor Green
Write-Host "  Studio:                  $Base/" -ForegroundColor White
Write-Host "  OBS Browser Source URL:  $Base/output.html?focus=bust   (1920 x 1080)" -ForegroundColor White
Write-Host '  You can close this window: VTube Pro keeps running in the background.' -ForegroundColor DarkGray
Write-Host '  To stop it, double-click "Stop VTube Pro".' -ForegroundColor DarkGray
Write-Host ''
exit 0
