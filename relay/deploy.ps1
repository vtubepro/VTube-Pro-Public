# VTube Pro relay setup: asks for every value, writes wrangler.local.toml, puts the relay online with YOUR Cloudflare
# account, sets the secrets and prints exactly what to paste where. Step by step guide: docs/HOSTING_SETUP.md
#
#   Double-click "Set up my relay.cmd" (same folder), or:
#   powershell -ExecutionPolicy Bypass -File deploy.ps1                 first time, and every update (asks again, Enter keeps)
#   powershell -ExecutionPolicy Bypass -File deploy.ps1 -SecretsOnly    only (re)set the secrets
#   powershell -ExecutionPolicy Bypass -File deploy.ps1 -DryRun         practice run: no sign-in, no network, nothing
#                                                                      uploaded; shows the settings file it would write
# Who may host: nobody types an id. The setup shows a one-time CLAIM CODE; the first person who signs in with Discord
# in VTube Pro and types it becomes the host (only its hash goes to the relay, as the HOST_CLAIM secret).
# -HostIds is an advanced override (those Discord ids may always host). -NewClaimCode makes a new code.
# Values can also be given up front: -HostIds -PublicName -TurnKeyId -Domain -WorkersDev keep|off, and
# -NoPrompt uses only those (plus wrangler.local.toml) without asking.
# Sign-in: you make YOUR OWN Discord application (discord.com/developers/applications). This script asks for its Client
# ID (-ClientId) and then asks you to paste its client secret into wrangler's hidden prompt. Nothing goes through
# anyone else's app or server: the relay is yours (your Cloudflare account) and so is the Discord app.
#
# Secrets are typed into wrangler's own hidden prompt (or, for TICKET_SECRET, made here and handed straight to
# wrangler). No secret is ever written to a file by this script. This file is ASCII on purpose (Windows PowerShell 5.1).
param(
  [switch]$SecretsOnly,
  [switch]$SkipLogin,
  [Alias('WhatIf')][switch]$DryRun,
  [switch]$NoPrompt,
  [switch]$NewClaimCode,
  [string]$ClientId,
  [string]$HostIds,
  [string]$PublicName,
  [string]$TurnKeyId,
  [string]$Domain,
  [ValidateSet('', 'keep', 'off')][string]$WorkersDev = ''
)
# Continue, not Stop: wrangler prints warnings on stderr, which Windows PowerShell 5.1 would turn into a crash.
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
$Template = 'wrangler.toml'
$Local = 'wrangler.local.toml'
$Guide = 'docs\HOSTING_SETUP.md (in VTube Pro: Help -> Hosting setup)'
$LoopbackRedirect = 'http://127.0.0.1:5191/api/discord/callback'

function Say([string]$t, [string]$c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Step([string]$t) { Write-Host ''; Write-Host "== $t ==" -ForegroundColor Cyan }
function Fail([string]$t) { Write-Host ''; Write-Host $t -ForegroundColor Red; Write-Host "Help: $Guide -> Troubleshooting" -ForegroundColor Yellow; exit 1 }

# ------------------------------------------------------------------ checks (same rules as shared/relaySetup.ts)
function Test-ClientId([string]$v) {
  $id = ($v -replace '\s', '')
  if (-not $id) { return 'Paste the Client ID: Discord Developer Portal -> your app -> OAuth2 -> Client ID -> Copy.' }
  if ($id -match '^[\w-]{20,30}\.[\w-]{5,8}\.[\w-]{20,45}$') { return 'That looks like your BOT TOKEN. The Client ID is only digits (OAuth2 -> Client ID). The bot token comes later.' }
  if (($id -match '[A-Za-z_-]') -and $id.Length -ge 24) { return 'That looks like the CLIENT SECRET. The Client ID is only digits (OAuth2 -> Client ID). The secret comes later.' }
  if ($id -notmatch '^\d+$') { return 'The Client ID is only digits. Copy it again: OAuth2 -> Client ID -> Copy.' }
  if ($id.Length -lt 17 -or $id.Length -gt 20) { return "A Client ID is 17 to 20 digits; this one has $($id.Length)." }
  return ''
}
function Test-HostIds([string]$v) {
  $parts = @($v -split '[\s,;]+' | Where-Object { $_ })
  if ($parts.Count -eq 0) { return 'Paste your Discord user id (Discord -> Settings -> Advanced -> Developer Mode on, then right-click yourself -> Copy User ID).' }
  foreach ($p in $parts) {
    if ($p -match '[A-Za-z@]') { return "'$p' is a name, not a user id. Right-click yourself in Discord -> Copy User ID (a long number)." }
    if ($p -notmatch '^\d{17,20}$') { return "'$p' is not a Discord user id (they are 17 to 20 digits)." }
  }
  return ''
}
function Test-Domain([string]$v) {
  if (-not $v) { return '' }
  if ($v -match '\.workers\.dev$') { return 'That is a workers.dev address. A custom domain is one you own, like join.example.com.' }
  if ($v -notmatch '^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$') { return "'$v' is not a valid address. Example: join.example.com" }
  return ''
}
function Test-TurnKeyId([string]$v) {
  if (-not $v) { return '' }
  if ($v -notmatch '^[A-Za-z0-9_-]{16,64}$') { return 'That does not look like a TURN key id (letters and digits, no spaces). Cloudflare -> Realtime -> TURN Server -> your key.' }
  return ''
}
function Clean-Domain([string]$v) { return (($v.Trim().ToLower() -replace '^https?://', '') -replace '/.*$', '') }
function Clean-Ids([string]$v) { return ((@($v -split '[\s,;]+' | Where-Object { $_ }) | Select-Object -Unique) -join ',') }

# Ask until the answer passes the check. Enter keeps the current value (shown in [brackets]).
function Ask([string]$question, [string]$current, [scriptblock]$check, [switch]$Optional, [string]$hint = '') {
  if ($NoPrompt) {
    $e = & $check $current
    if (-not $Optional -and -not $current) { Fail "Missing: $question (give it as a parameter, or run without -NoPrompt)." }
    if ($e) { Fail $e }
    return $current
  }
  while ($true) {
    Write-Host ''
    Write-Host $question -ForegroundColor White
    if ($hint) { Say $hint 'DarkGray' }
    $suffix = ''
    if ($current) { $suffix = " [Enter keeps: $current]" } elseif ($Optional) { $suffix = ' [Enter to skip]' }
    $a = Read-Host ("  >$suffix")
    if ($null -eq $a) { $a = '' }
    $a = $a.Trim().Trim('"').Trim("'")
    if (-not $a) { $a = $current }
    if ($Optional -and $a -eq '-') { return '' }
    if (-not $a -and $Optional) { return '' }
    $e = & $check $a
    if (-not $e) { return $a }
    Say "  $e" 'Yellow'
  }
}
function YesNo([string]$question, [bool]$default) {
  if ($NoPrompt) { return $default }
  $d = 'y/N'; if ($default) { $d = 'Y/n' }
  $a = Read-Host "$question ($d)"
  if (-not $a) { return $default }
  return ($a.Trim().ToLower().StartsWith('y'))
}

# ------------------------------------------------------------------ settings file
function Get-TomlVar([string]$text, [string]$key) {
  $m = [regex]::Match($text, "(?m)^\s*$key\s*=\s*""([^""]*)""")
  if ($m.Success) { return $m.Groups[1].Value } else { return '' }
}
function Set-TomlVar([string]$text, [string]$key, [string]$value) {
  $safe = $value -replace '["\\]', ''
  $rx = "(?m)^(\s*$key\s*=\s*)""[^""]*"""
  if (-not [regex]::IsMatch($text, $rx)) { Fail "The template $Template has no $key line. Get a fresh copy of the relay folder." }
  return [regex]::Replace($text, $rx, { param($m) $m.Groups[1].Value + '"' + $safe + '"' })
}
function Get-RouteHost([string]$text) {
  $m = [regex]::Match($text, '(?ms)^\[\[routes\]\]\s*\r?\npattern\s*=\s*"([^"]+)"')
  if ($m.Success) { return $m.Groups[1].Value } else { return '' }
}
function Build-LocalToml([string]$tpl, [hashtable]$v) {
  $t = $tpl
  foreach ($k in 'DISCORD_CLIENT_ID', 'HOST_USER_IDS', 'PUBLIC_NAME', 'TURN_KEY_ID') { $t = Set-TomlVar $t $k $v[$k] }
  $wd = 'true'; if ($v.Domain -and $v.WorkersDevOff) { $wd = 'false' }
  $t = [regex]::Replace($t, '(?m)^workers_dev\s*=\s*\w+', "workers_dev = $wd")
  $t = [regex]::Replace($t, '(?m)^# This file is the TEMPLATE[^\n]*\n', '')
  # the template's commented route example (and its two comment lines) go; the real route is added below
  $t = [regex]::Replace($t, '(?m)^# Optional: your own address for the relay[^\n]*\n# The domain must be[^\n]*\n', '')
  # drop the commented example; add the real route
  $t = [regex]::Replace($t, '(?m)^# \[\[routes\]\]\r?\n# pattern = .*\r?\n# custom_domain = true\r?\n?', '')
  $t = $t.TrimEnd() + "`r`n"
  if ($v.Domain) { $t += "`r`n# Your own address for the relay (private links). docs/HOSTING_SETUP.md#private-links`r`n[[routes]]`r`npattern = ""$($v.Domain)""`r`ncustom_domain = true`r`n" }
  $head = "# YOUR relay settings (written by deploy.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm')). Stays on this PC: git-ignored, never shipped.`r`n# Run deploy.ps1 again to change them. No secrets in here.`r`n"
  return $head + $t
}

# ------------------------------------------------------------------ wrangler
$Npx = $null
function Wr([string[]]$wargs, [string]$stdin = $null, [switch]$Capture) {
  $shown = "npx wrangler@4 " + ($wargs -join ' ')
  if ($DryRun) { Say "  [practice run] would run: $shown" 'DarkYellow'; return '' }
  $all = @('--yes', 'wrangler@4') + $wargs
  if ($null -ne $stdin) { $out = $stdin | & $Npx @all 2>&1 | Out-String; Say $out 'DarkGray'; return $out }
  if ($Capture) { $out = & $Npx @all 2>&1 | Tee-Object -Variable lines | Out-Host; return (($lines | ForEach-Object { "$_" }) -join "`n") }
  & $Npx @all
  return ''
}

# ================================================================== 0. what you need
Write-Host ''
Write-Host '  VTube Pro relay setup' -ForegroundColor Green
Write-Host '  ---------------------' -ForegroundColor Green
Say '  This puts your own small relay online on YOUR free Cloudflare account. About 5 minutes.'
Say '  Have ready: your own Discord application (discord.com/developers/applications): its Client ID now, its client secret in step 4.'
Say "  Every step is explained in $Guide."
if ($DryRun) { Say '  PRACTICE RUN: nothing is signed in, uploaded or saved in the relay folder.' 'DarkYellow' }

if (-not (Test-Path $Template)) { Fail "Can't find $Template next to this script. Run it from VTube Pro's relay folder." }
$cmd = Get-Command npx.cmd -ErrorAction SilentlyContinue
if (-not $cmd) { $cmd = Get-Command npx -ErrorAction SilentlyContinue }
if ($cmd) { $Npx = $cmd.Source }
elseif ($DryRun) { Say '  (Node.js is not installed. A real run would stop here and ask you to install it.)' 'DarkYellow' }
else {
  Fail ("Node.js is needed to upload the relay (it brings the 'npx' command), and it isn't installed.`n" +
    "  1. Open https://nodejs.org and download the version marked LTS.`n" +
    "  2. Install it (click Next until Finish; the default options are fine).`n" +
    "  3. Close this window and double-click 'Set up my relay.cmd' again.")
}

$Utf8 = New-Object Text.UTF8Encoding($false)
$tpl = [IO.File]::ReadAllText((Join-Path $PSScriptRoot $Template), $Utf8)
$old = ''
if (Test-Path $Local) { $old = [IO.File]::ReadAllText((Join-Path $PSScriptRoot $Local), $Utf8) }
$src = $tpl; if ($old) { $src = $old }

# ================================================================== 1. your values
$v = @{}
if (-not $SecretsOnly) {
  Step '1/4  Your values'
  # your OWN Discord application is required: the relay signs you and your guests in with it (no shared app exists)
  $cur = $ClientId; if (-not $cur) { $cur = Get-TomlVar $src 'DISCORD_CLIENT_ID' }
  Say ''
  Say 'You and your guests sign in with YOUR OWN Discord application. Make one first if you have not:' 'White'
  Say '  discord.com/developers/applications -> New Application -> OAuth2 (its Client ID and Client Secret are on that page).' 'White'
  $v.DISCORD_CLIENT_ID = (Ask "Your Discord app's CLIENT ID (only digits)" $cur ${function:Test-ClientId} -hint 'discord.com/developers/applications -> your app -> OAuth2 -> Client ID -> Copy') -replace '\s', ''
  # advanced override only (kept from an older setup, or given with -HostIds); normally the claim code decides
  $cur = $HostIds; if (-not $cur) { $cur = Get-TomlVar $src 'HOST_USER_IDS' }
  $v.HOST_USER_IDS = ''
  if ($cur) { $e = Test-HostIds $cur; if ($e) { Fail "-HostIds: $e" }; $v.HOST_USER_IDS = Clean-Ids $cur }
  $cur = $PublicName; if (-not $cur) { $cur = Get-TomlVar $src 'PUBLIC_NAME' }
  $v.PUBLIC_NAME = Ask 'Show name guests see (optional; empty = your Discord display name). Type - to clear.' $cur { param($x) if ($x.Length -gt 40) { 'At most 40 characters.' } else { '' } } -Optional
  $cur = $TurnKeyId; if (-not $cur) { $cur = Get-TomlVar $src 'TURN_KEY_ID' }
  $v.TURN_KEY_ID = Ask 'Cloudflare TURN key id (optional, guide step 5; lets every guest connect). Type - to clear.' $cur ${function:Test-TurnKeyId} -Optional
  $cur = $Domain; if (-not $cur) { $cur = Get-RouteHost $src }
  $d = Ask 'Your own address for guest links, e.g. join.example.com (optional, guide: Private links). Type - to clear.' $cur { param($x) Test-Domain (Clean-Domain $x) } -Optional
  $v.Domain = ''; if ($d) { $v.Domain = Clean-Domain $d }
  $v.WorkersDevOff = $false
  if ($v.Domain) {
    $wasOff = [regex]::IsMatch($src, '(?m)^workers_dev\s*=\s*false')
    if ($WorkersDev -eq 'off') { $v.WorkersDevOff = $true }
    elseif ($WorkersDev -eq 'keep') { $v.WorkersDevOff = $false }
    else {
      Say ''
      Say 'Switch OFF the old workers.dev address? Only say yes once the new address works in VTube Pro AND is in' 'White'
      Say 'Discord -> OAuth2 -> Redirects. Until then keep it (both addresses work).' 'White'
      $v.WorkersDevOff = YesNo '  Switch it off now?' $wasOff
    }
  }

  # ---------------------------------------------------------------- write wrangler.local.toml
  $new = Build-LocalToml $tpl $v
  if ($DryRun) {
    $prev = Join-Path $env:TEMP 'vtp-relay-preview.toml'
    [IO.File]::WriteAllText($prev, $new, (New-Object Text.UTF8Encoding($false)))
    Say ''
    Say "[practice run] wrangler.local.toml would be (saved for you to look at: $prev):" 'DarkYellow'
    Say $new 'DarkGray'
  } else {
    if ($old -and $old -ne $new) { Copy-Item $Local "$Local.bak" -Force }
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot $Local), $new, (New-Object Text.UTF8Encoding($false)))
    Say "  Saved your values in relay\$Local (stays on this PC)." 'Green'
  }
} else {
  if (-not $old) { Fail "No $Local yet. Run the setup once without -SecretsOnly first." }
  $v.TURN_KEY_ID = Get-TomlVar $old 'TURN_KEY_ID'
  $v.Domain = Get-RouteHost $old
  $v.DISCORD_CLIENT_ID = Get-TomlVar $old 'DISCORD_CLIENT_ID'
}
$Cfg = $Local

# ================================================================== 2. Cloudflare sign-in
Step '2/4  Sign in to Cloudflare'
if (-not $SkipLogin) {
  $who = ''
  if (-not $DryRun) { $who = (& $Npx --yes wrangler@4 whoami 2>&1 | Out-String) }
  if ($DryRun -or $who -match 'not authenticated|You are not logged in|wrangler login') {
    Say '  A browser window opens: sign in to YOUR Cloudflare account and click Allow. Then come back here.' 'White'
    Wr @('login') | Out-Null
  } else { Say '  Already signed in.' 'Green' }
}

# ================================================================== 3. upload the relay
$Url = ''
if (-not $SecretsOnly) {
  Step '3/4  Putting the relay online'
  $out = Wr @('deploy', '-c', $Cfg) -Capture
  if ($v.Domain) { $Url = "https://$($v.Domain)" }
  $m = [regex]::Match("$out", 'https://[a-z0-9.-]+\.workers\.dev')
  $WdUrl = ''; if ($m.Success) { $WdUrl = $m.Value }
  if (-not $Url) { $Url = $WdUrl }
  if ($DryRun -and -not $Url) { $Url = 'https://vtube-pro-relay.<your-subdomain>.workers.dev' }
  if (-not $DryRun -and "$out" -match '(?i)\[ERROR\]|X \[ERROR') {
    Fail ("The upload failed (the red text above says why). Most common fixes:`n" +
      "  - 'register a workers.dev subdomain': open dash.cloudflare.com -> Workers & Pages once and choose your subdomain (guide step 2), then run this again.`n" +
      "  - 'Authentication error': run this again; sign in to the right Cloudflare account and click Allow.`n" +
      "  - 'custom domain' / 'zone': the domain must be on your Cloudflare account first (guide: Private links).")
  }
  if (-not $Url) {
    Say "  I couldn't read the relay address from the output above." 'Yellow'
    Say '  Find it in Cloudflare: dash.cloudflare.com -> Workers & Pages -> vtube-pro-relay (it ends in .workers.dev).' 'Yellow'
    if (-not $NoPrompt) { $Url = (Read-Host '  Paste it here (or press Enter to skip)').Trim().TrimEnd('/') }
  }
}

# ================================================================== 4. secrets
Step '4/4  Secrets (typed into a hidden prompt; never saved in a file)'
$have = @()
if (-not $DryRun) {
  try {
    $raw = (& $Npx --yes wrangler@4 secret list -c $Cfg 2>$null | Out-String)
    $j = $raw.Substring([Math]::Max(0, $raw.IndexOf('['))) | ConvertFrom-Json
    $have = @($j | ForEach-Object { $_.name })
  } catch { $have = @() }
}
function Want([string]$name, [string]$what) {
  if ($have -notcontains $name) { return $true }
  return (YesNo "  $name is already set. Replace it ($what)?" $false)
}
if (Want 'TICKET_SECRET' 'this signs everyone out, including you') {
  Say '  TICKET_SECRET: made for you (a long random password the relay uses to sign tickets).' 'White'
  $bytes = New-Object byte[] 48
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  Wr @('secret', 'put', 'TICKET_SECRET', '-c', $Cfg) ([Convert]::ToBase64String($bytes)) | Out-Null
}
if (Want 'DISCORD_CLIENT_SECRET' 'only if you pressed Reset Secret in Discord') {
  Say '' ; Say '  DISCORD_CLIENT_SECRET: Discord Developer Portal -> your app -> OAuth2 -> Reset Secret -> Copy.' 'White'
  Say '  Paste it at the prompt below (right-click pastes) and press Enter. It stays hidden.' 'White'
  Wr @('secret', 'put', 'DISCORD_CLIENT_SECRET', '-c', $Cfg) | Out-Null
}
if ((($have -notcontains 'DISCORD_BOT_TOKEN' -and (YesNo "`n  Add the Discord BOT token now (it posts the 'is live - Join' message in your server)?" (-not $NoPrompt))) -or
    ($have -contains 'DISCORD_BOT_TOKEN' -and (YesNo '  DISCORD_BOT_TOKEN is already set. Replace it?' $false)))) {
  Say '  DISCORD_BOT_TOKEN: Developer Portal -> your app -> Bot -> Reset Token -> Copy. Paste it below and press Enter.' 'White'
  Wr @('secret', 'put', 'DISCORD_BOT_TOKEN', '-c', $Cfg) | Out-Null
}
if ($v.TURN_KEY_ID -and (Want 'TURN_KEY_API_TOKEN' 'only if you made a new TURN key')) {
  Say '  TURN_KEY_API_TOKEN: Cloudflare -> Realtime -> TURN Server -> your key -> its API token. Paste it below.' 'White'
  Wr @('secret', 'put', 'TURN_KEY_API_TOKEN', '-c', $Cfg) | Out-Null
}
# ------------------------------------------------------------------ claim code (who becomes the host)
$ClaimCode = ''
$makeClaim = ($have -notcontains 'HOST_CLAIM') -or $NewClaimCode
if (-not $makeClaim -and -not $NoPrompt) {
  $makeClaim = YesNo '  Make a NEW claim code? Only if you lost yours or someone else should become the host (the current host stops being host).' $false
}
if ($makeClaim) {
  $abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  $rb = New-Object byte[] 8
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($rb)
  $chars = $rb | ForEach-Object { $abc[$_ % $abc.Length] }
  $ClaimCode = (-join $chars[0..3]) + '-' + (-join $chars[4..7])
  $norm = $ClaimCode -replace '[^A-Z0-9]', ''
  $sha = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes("vtp-claim-v1|$norm"))
  $hash = -join ($sha | ForEach-Object { $_.ToString('x2') })
  Say '  HOST_CLAIM: a new one-time claim code (only its fingerprint goes to the relay).' 'White'
  Wr @('secret', 'put', 'HOST_CLAIM', '-c', $Cfg) $hash | Out-Null
}
if ($SecretsOnly) {
  Say ''; Say 'Secrets updated.' 'Green'
  if ($ClaimCode) { Write-Host ''; Write-Host "  Your claim code:   $ClaimCode" -ForegroundColor Yellow }
  exit 0
}

# ================================================================== check + what to paste where
$ready = $null
if ($Url -and -not $DryRun) {
  Say ''; Say "  Checking $Url/health ..." 'DarkGray'
  for ($i = 0; $i -lt 8 -and -not $ready; $i++) {
    try { $hl = Invoke-RestMethod "$Url/health" -TimeoutSec 8; $ready = $hl.ready } catch { Start-Sleep -Seconds 4 }
  }
  if (-not $ready) {
    if ($v.Domain) { Say "  $Url doesn't answer yet. A new custom domain can take a few minutes (its certificate is being made). Try again later: open $Url/health in a browser." 'Yellow' }
    else { Say "  The relay doesn't answer yet. Wait a minute, then open $Url/health in a browser." 'Yellow' }
  } else {
    $flag = { param($b) if ($b) { 'OK ' } else { 'NO ' } }
    Say ("  " + (& $flag $ready.clientId) + 'Client ID (your Discord app)'); Say ("  " + (& $flag $ready.clientSecret) + 'Client secret (your Discord app)')
    Say ("  " + (& $flag $ready.ticketSecret) + 'Ticket secret')
    if ($ready.claim -eq 'claimed' -or $ready.hosts -gt 0) { Say '  OK  Host' } else { Say '  ... Host: not claimed yet (type the claim code below in VTube Pro)' 'Yellow' }
    Say ("  " + (& $flag $ready.bot) + 'Bot token (optional)')
    Say ("  " + (& $flag $ready.turn) + 'TURN (optional, recommended)')
  }
}

Write-Host ''
Write-Host '  ================================================================' -ForegroundColor Green
Write-Host '   DONE. Now copy these:' -ForegroundColor Green
Write-Host '  ================================================================' -ForegroundColor Green
Write-Host ''
Write-Host '  1) In Discord (discord.com/developers -> your app -> OAuth2 -> Redirects), these TWO lines:' -ForegroundColor White
Write-Host "       $LoopbackRedirect" -ForegroundColor Yellow
Write-Host "       $Url/cb" -ForegroundColor Yellow
if ($v.Domain -and $WdUrl -and -not $v.WorkersDevOff) { Write-Host "     (keep $WdUrl/cb there too until you switch workers.dev off)" -ForegroundColor DarkGray }
Write-Host '     then click Save Changes.' -ForegroundColor White
Write-Host ''
Write-Host '  2) In VTube Pro (the multiplayer setup helper, step "Paste & test"):' -ForegroundColor White
Write-Host "       Relay address:  $Url" -ForegroundColor Yellow
Write-Host "       Client ID:      $($v.DISCORD_CLIENT_ID)" -ForegroundColor Yellow
if ($ClaimCode) {
  Write-Host ''
  Write-Host '  3) Then click Connect Discord and type this CLAIM CODE. It makes you the host of this relay:' -ForegroundColor White
  Write-Host ''
  Write-Host '        +-------------------------+' -ForegroundColor Yellow
  Write-Host ('        |    ' + (($ClaimCode.ToCharArray()) -join ' ') + '    |') -ForegroundColor Yellow
  Write-Host '        +-------------------------+' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '     Keep this window open until VTube Pro says you are the host. The code works once.' -ForegroundColor White
  Write-Host '     Lost it? Run this setup again and answer y to "Make a NEW claim code".' -ForegroundColor DarkGray
}
if ($Url -and -not $DryRun) { try { Set-Clipboard -Value $Url; Say '     (The relay address is already copied: just paste it.)' 'DarkGray' } catch { } }
if ($Url -match '\.([a-z0-9-]+)\.workers\.dev') {
  Write-Host ''
  Write-Host ("  Privacy: every guest link shows '" + $Matches[1] + "' (your Cloudflare workers.dev name).") -ForegroundColor Yellow
  Write-Host '  If that is your e-mail name or real name, see the guide: Private links.' -ForegroundColor Yellow
}
Write-Host ''
