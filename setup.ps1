<#
  VTube Pro - one-click setup + launcher for Windows (Windows PowerShell 5.1 or PowerShell 7).

  Double-click START_HERE.bat (first time) or START.bat (every time after). Or run directly:
    powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 [options]

  What it does (safe to re-run; it only does what is missing or out of date):
    1. checks Node.js (>= 22.12), npm and Git; offers to install missing ones with winget (asks Y/N per item)
    2. optional: Blender (only for creating / rebuilding avatars)
    4. npm ci (only when package-lock.json changed)
    5. config/settings.json from config/settings.example.json (only if absent - never overwritten)
    6. optional: -Dev (R&D models from their original sites)
    7. npm run build (only when the sources changed since the last build)
    8. starts the server on http://127.0.0.1:<Port>/ and opens the studio in your browser

  Options:
    -Yes         accept the default answer for every question (required items: yes, optional items: no). For CI.
    -Port <n>    server port (default 5191, or $env:VTP_PORT)
    -Quick       launcher mode (START.bat): no tool installs; only rebuild/reinstall when needed
    -NoStart     set everything up but do not start the server
    -NoBrowser   start the server but do not open the browser
    -Detach      start the server in the background (log: .setup-state\server.log, PID: .setup-state\server.pid)
    -Stop        stop a server started with -Detach
    -Dev         also download the optional R&D models (Rhubarb, wav2arkit, Depth Anything, Audio2Face)
    -Gpu         also set up GPU tracking (NVIDIA RTX 50-series only): Python GPU runtime + Audio2Face-3D
                 model + the RTMW body model (OpenMMLab; trained on research-licensed data, see THIRD_PARTY_NOTICES.md) into .gpu\, and (asks first) NVIDIA's AR SDK installer for Maxine. Same as the app's
                 "Set up GPU tracking" button (tools/gpu/gpu_setup.ts; docs/GPU_TRACKING.md)
    -Rebuild     force npm ci + npm run build
    -NoUpdate    accepted for compatibility (setup never fetches updates)
#>
[CmdletBinding()]
param(
  [switch]$Yes,
  [int]$Port = 0,
  [switch]$Quick,
  [switch]$NoStart,
  [switch]$NoBrowser,
  [switch]$Detach,
  [switch]$Stop,
  [switch]$Dev,
  [switch]$Gpu,
  [switch]$Rebuild,
  [switch]$NoUpdate
)

# 'Continue', not 'Stop': in Windows PowerShell 5.1 a native tool writing to stderr (npm/git warnings) would
# otherwise abort the script. Every step checks its own result instead.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'          # Invoke-WebRequest is 10x slower with the progress bar in PS 5.1
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$Root = $PSScriptRoot
Set-Location -LiteralPath $Root
$State = Join-Path $Root '.setup-state'
New-Item -ItemType Directory -Force -Path $State | Out-Null
$MinNode = [version]'22.12.0'
if ($Port -le 0) { if ($env:VTP_PORT) { $Port = [int]$env:VTP_PORT } else { $Port = 5191 } }
$Base = "http://127.0.0.1:$Port"

# ------------------------------------------------------------------ helpers
function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Step([string]$m) { Write-Host ''; Write-Host "== $m" -ForegroundColor Cyan }
function Ok([string]$m) { Write-Host "   [ok] $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "   [!] $m" -ForegroundColor Yellow }
function Fail([string]$m) { Write-Host ''; Write-Host "   [X] $m" -ForegroundColor Red; exit 1 }

function Ask([string]$q, [bool]$default) {
  if ($Yes) { if ($default) { Say "   $q -> yes (-Yes)" } else { Say "   $q -> no (-Yes)" }; return $default }
  $hint = '[y/N]'
  if ($default) { $hint = '[Y/n]' }
  while ($true) {
    $a = Read-Host "   $q $hint"
    if ([string]::IsNullOrWhiteSpace($a)) { return $default }
    if ($a -match '^(y|yes)$') { return $true }
    if ($a -match '^(n|no)$') { return $false }
  }
}

function Has([string]$cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Refresh-Path {
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$m;$u"
  foreach ($d in @("$env:ProgramFiles\nodejs", "$env:ProgramFiles\Git\cmd")) {
    if ((Test-Path -LiteralPath $d) -and -not (($env:Path -split ';') -contains $d)) { $env:Path = "$env:Path;$d" }
  }
}

function Winget-Install([string]$id, [string]$name, [string]$page) {
  if (-not (Has 'winget')) {
    Warn "winget (Windows Package Manager) is not available on this PC."
    Say  "   Opening the official download page for $name - install it, then run START_HERE.bat again."
    Start-Process $page
    return $false
  }
  Say "   Installing $name with winget (this accepts the winget source + package license terms) ..."
  & winget install --id $id -e --source winget --accept-package-agreements --accept-source-agreements
  Refresh-Path
  return ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq -1978335189)   # 0 = installed, 0x8A15002B = already installed
}

function Node-Version {
  if (-not (Has 'node')) { return $null }
  try { $v = & node -v; return [version]("$v".Trim().TrimStart('v')) } catch { return $null }
}

function Sha256([string]$file) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() }

function Read-Stamp([string]$name) {
  $f = Join-Path $State $name
  if (Test-Path -LiteralPath $f) { return (Get-Content -LiteralPath $f -Raw).Trim() }
  return ''
}
function Write-Stamp([string]$name, [string]$value) { Set-Content -LiteralPath (Join-Path $State $name) -Value $value -Encoding ASCII }

function Find-Blender {
  try {
    $s = Get-Content -LiteralPath (Join-Path $Root 'config\settings.json') -Raw -ErrorAction Stop | ConvertFrom-Json
    if ($s.blenderPath -and (Test-Path -LiteralPath $s.blenderPath)) { return $s.blenderPath }
  } catch { }
  if ($env:VTP_BLENDER -and (Test-Path -LiteralPath $env:VTP_BLENDER)) { return $env:VTP_BLENDER }
  $bf = Join-Path $env:ProgramFiles 'Blender Foundation'
  if (Test-Path -LiteralPath $bf) {
    $exe = Get-ChildItem -LiteralPath $bf -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName 'blender.exe' } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($exe) { return $exe }
  }
  $c = Get-Command 'blender' -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return $null
}

function Port-Free([int]$p) {
  $l = $null
  try { $l = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Parse('127.0.0.1')), $p; $l.Start(); return $true }
  catch { return $false }
  finally { if ($l) { try { $l.Stop() } catch { } } }
}

function Is-VTubePro([int]$p) {
  try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$p/api/settings"; return ($r.StatusCode -eq 200 -and $r.Content -match '"comfyUrl"') }
  catch { return $false }
}

# Build key = hash of (path, size, mtime) of everything the client build reads. Cheap: a few thousand stat calls.
function Build-Key {
  $items = New-Object System.Collections.Generic.List[string]
  $dirs = @('src', 'shared', 'public', 'assets\hdri', 'assets\raid', 'assets\space', 'assets\library\anims')
  foreach ($d in $dirs) {
    $p = Join-Path $Root $d
    if (Test-Path -LiteralPath $p) {
      Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
        $items.Add(('{0}|{1}|{2}' -f $_.FullName.Substring($Root.Length), $_.Length, $_.LastWriteTimeUtc.Ticks))
      }
    }
  }
  foreach ($f in @('index.html', 'output.html', 'dj.html', 'vite.config.ts', 'tsconfig.json', 'package-lock.json')) {
    $p = Join-Path $Root $f
    if (Test-Path -LiteralPath $p) { $i = Get-Item -LiteralPath $p; $items.Add(('{0}|{1}|{2}' -f $f, $i.Length, $i.LastWriteTimeUtc.Ticks)) }
  }
  $items.Sort()
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($items -join "`n"))
  return ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant()
}

function Download([string]$url, [string]$dest) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
  $tmp = "$dest.part"
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (Test-Path -LiteralPath $curl) {
    & $curl -L --fail --retry 3 --progress-bar -o $tmp $url
    if ($LASTEXITCODE -ne 0) { throw "download failed ($LASTEXITCODE): $url" }
  } else {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $tmp
  }
  Move-Item -LiteralPath $tmp -Destination $dest -Force
}

function Expand-Zip([string]$zip, [string]$dest) {
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'          # bsdtar ships with Windows 10 1803+ and reads zip
  if (Test-Path -LiteralPath $tar) {
    & $tar -x -f $zip -C $dest
    if ($LASTEXITCODE -eq 0) { return }
    Warn "tar could not unpack the zip; falling back to Expand-Archive (slower)"
  }
  Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force
}

# ------------------------------------------------------------------ stop a detached server
if ($Stop) {
  $pidFile = Join-Path $State 'server.pid'
  if (Test-Path -LiteralPath $pidFile) {
    $sp = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
    & taskkill /PID $sp /T /F | Out-Null
    Remove-Item -LiteralPath $pidFile -Force
    Ok "stopped server (PID $sp)"
  } else { Warn 'no detached server recorded (.setup-state\server.pid)' }
  exit 0
}

Write-Host ''
Write-Host '  VTube Pro setup' -ForegroundColor Magenta
Write-Host "  folder: $Root" -ForegroundColor DarkGray
if ($Quick) { Write-Host '  mode:   quick launch (START.bat)' -ForegroundColor DarkGray }

# ------------------------------------------------------------------ 1. required tools
Step 'Checking required tools'
Refresh-Path
$nv = Node-Version
if ($nv -and $nv -ge $MinNode -and (Has 'npm')) {
  Ok "Node.js $nv + npm"
} else {
  if ($Quick) { Say '   Node.js is missing or too old - running the full setup instead.'; $Quick = $false }
  if ($nv) { Warn "Node.js $nv is too old (need $MinNode or newer, the LTS release is recommended)." }
  else { Warn 'Node.js is not installed (it runs the VTube Pro server and builds the app).' }
  if (Ask 'Install Node.js LTS now?' $true) {
    [void](Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js LTS' 'https://nodejs.org/en/download')
    $nv = Node-Version
  }
  if (-not ($nv -and $nv -ge $MinNode -and (Has 'npm'))) {
    Fail "Node.js $MinNode+ is required. Install the LTS from https://nodejs.org, close this window and run START_HERE.bat again."
  }
  Ok "Node.js $nv + npm"
}

$hasGit = Has 'git'
if ($hasGit) { Ok ((& git --version) -replace '^git version ', 'Git ') }
elseif (-not $Quick) {
  Warn 'Git is not installed (only needed to download updates with one click).'
  if (Ask 'Install Git now?' $true) { $hasGit = Winget-Install 'Git.Git' 'Git' 'https://git-scm.com/download/win'; $hasGit = Has 'git' }
}

# ------------------------------------------------------------------ 2. optional tools
if (-not $Quick) {
  Step 'Checking optional tools'
  $bl = Find-Blender
  if ($bl) { Ok "Blender: $bl" }
  else {
    Say '   Blender is not installed. It is OPTIONAL - only needed to create / rebuild avatars, costumes and rooms'
    Say '   (tracking, the built-in avatars, rooms and OBS output all work without it).'
    if (Ask 'Install Blender now (about 400 MB)?' $false) { [void](Winget-Install 'BlenderFoundation.Blender' 'Blender' 'https://www.blender.org/download/') }
  }
}

# ------------------------------------------------------------------ 4. npm dependencies
Step 'Installing app dependencies'
$lockHash = Sha256 (Join-Path $Root 'package-lock.json')
$nmOk = Test-Path -LiteralPath (Join-Path $Root 'node_modules\.package-lock.json')
if ($Rebuild -or -not $nmOk -or (Read-Stamp 'npm.lock') -ne $lockHash) {
  & npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Warn 'npm ci failed - retrying with npm install'
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Fail 'npm could not install the dependencies (check your internet connection, then run again).' }
  }
  Write-Stamp 'npm.lock' $lockHash
  Ok 'dependencies installed'
} else { Ok 'dependencies already up to date' }

# ------------------------------------------------------------------ 5. config
Step 'Local configuration'
$cfg = Join-Path $Root 'config'
$settings = Join-Path $cfg 'settings.json'
if (-not (Test-Path -LiteralPath $settings)) {
  Copy-Item -LiteralPath (Join-Path $cfg 'settings.example.json') -Destination $settings
  Ok 'created config\settings.json (ComfyUI address and Blender path) - stays on this PC'
} else { Ok 'config\settings.json exists (kept as is)' }
Say '   Chat / OBS / Discord / phone-tracker settings are created by the app when you save them' 'DarkGray'
Say '   (templates: config\*.example.json). None of these files are ever uploaded to git.' 'DarkGray'

# ------------------------------------------------------------------ 6. assets
Step 'Checking built-in assets'
$need = @('public\mediapipe\face_landmarker.task', 'public\mediapipe\wasm\vision_wasm_internal.wasm', 'public\vendor\voice\silero_vad_v5.onnx',
          'assets\builtin\robot\robot.glb', 'assets\hdri\hdri.json', 'assets\library\anims\vrma\index.json')
$missing = @($need | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Root $_)) })
if ($missing.Count) {
  foreach ($m in $missing) { Warn "missing: $m" }
  Fail 'Some shipped files are missing. Download the repository again (git clone or "Download ZIP"), then re-run.'
}
Ok 'tracking models, voice models, avatars, rooms present'

if ($Dev) {
  Step 'Optional R&D downloads (-Dev) from their original sources'
  $dj = Get-Content -LiteralPath (Join-Path $Root 'tools\setup\downloads.json') -Raw | ConvertFrom-Json
  foreach ($g in $dj.groups) {
    Say "   $($g.name) [$($g.license)]"
    foreach ($it in $g.items) {
      $dest = Join-Path $Root ($it.dest -replace '/', '\')
      if ((Test-Path -LiteralPath $dest) -and (Get-Item -LiteralPath $dest).Length -eq $it.size -and (Sha256 $dest) -eq $it.sha256) { continue }
      Download $it.url $dest
      $h = Sha256 $dest
      if ($h -ne $it.sha256) { Remove-Item -LiteralPath $dest -Force; Fail "SHA-256 mismatch for $($it.url)" }
    }
    Ok "$($g.id) ready (tools\vendor)"
  }
}

if ($Gpu) {
  Step 'GPU tracking (NVIDIA RTX 50-series): Python GPU runtime + models (docs\GPU_TRACKING.md)'
  $parts = 'runtime,a2f,rtmw'   # RTMW: downloaded from OpenMMLab on this click; the licence note is in THIRD_PARTY_NOTICES.md
  if (Ask 'Also download and start NVIDIA''s AR SDK installer for the Maxine face features (1.35 GB; Windows asks for admin permission)?' $false) { $parts += ',maxine' }
  & npx tsx tools/gpu/gpu_setup.ts --parts $parts
  if ($LASTEXITCODE -eq 0) { Ok 'GPU tracking set up - turn the features on in Go Live > Advanced > Voice, phone & 2nd camera' }
  else { Warn 'GPU tracking setup did not finish (see above). The app works without it; retry with START_HERE.bat -Gpu or the app''s "Set up GPU tracking" button.' }
}

# ------------------------------------------------------------------ 7. build
Step 'Building the app'
$key = Build-Key
$distIndex = Join-Path $Root 'dist\index.html'
if ($Rebuild -or -not (Test-Path -LiteralPath $distIndex) -or (Read-Stamp 'build.key') -ne $key) {
  & npm run build
  if ($LASTEXITCODE -ne 0) { Fail 'The build failed (see the messages above).' }
  Write-Stamp 'build.key' $key
  Ok 'built dist\'
} else { Ok 'build is up to date' }

# ------------------------------------------------------------------ 8. start
if ($NoStart) { Step 'Done'; Say "   Start later with START.bat (or: npm start). Studio: $Base/"; exit 0 }

Step "Starting VTube Pro on $Base"
if (-not (Port-Free $Port)) {
  if (Is-VTubePro $Port) {
    Ok "VTube Pro is already running on port $Port"
    if (-not $NoBrowser) { Start-Process "$Base/" }
    exit 0
  }
  Fail "Port $Port is used by another program. Close it, or start on another port:  START.bat -Port 5291"
}

$env:VTP_PORT = "$Port"
$nodeExe = (Get-Command node).Source
$serverArgs = @('--import', 'tsx', 'server/index.ts')
$proc = $null
if ($Detach) {
  $log = Join-Path $State 'server.log'
  $proc = Start-Process -FilePath $nodeExe -ArgumentList $serverArgs -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $log -RedirectStandardError (Join-Path $State 'server.err.log')
  Set-Content -LiteralPath (Join-Path $State 'server.pid') -Value $proc.Id -Encoding ASCII
} else {
  $proc = Start-Process -FilePath $nodeExe -ArgumentList $serverArgs -WorkingDirectory $Root -NoNewWindow -PassThru
}

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  if ($proc.HasExited) { break }
  if (Is-VTubePro $Port) { $ready = $true; break }
}
if (-not $ready) { Fail "The server did not start (exit code: $($proc.ExitCode)). See the messages above / .setup-state\server*.log." }

Write-Host ''
Write-Host "  VTube Pro is running." -ForegroundColor Green
Write-Host "  Studio (open in Chrome or Edge):  $Base/" -ForegroundColor White
Write-Host "  OBS Browser Source URL:           $Base/output.html?focus=bust" -ForegroundColor White
Write-Host "      Width 1920, Height 1080, FPS 60 (30 on weaker PCs), untick 'Shutdown source when not visible'." -ForegroundColor DarkGray
Write-Host "      OBS Settings > Advanced > 'Browser Source Hardware Acceleration' must be ON." -ForegroundColor DarkGray
Write-Host "  In the studio: Track tab > pick your camera + microphone > Start tracking." -ForegroundColor DarkGray
if ($Detach) { Write-Host "  Running in the background (PID $($proc.Id)). Stop:  powershell -File setup.ps1 -Stop" -ForegroundColor DarkGray }
else { Write-Host "  Keep this window open while you stream. Close it (or press Ctrl+C) to stop VTube Pro." -ForegroundColor DarkGray }
Write-Host ''

if (-not $NoBrowser) { Start-Process "$Base/" }
if (-not $Detach) { $proc.WaitForExit(); exit $proc.ExitCode }
