# VTube Pro: "Let my stream PC connect" firewall rule. Replaces the Windows Firewall rule named "VTube Pro (stream PC)"
# with an inbound allow for this program, TCP <Port>, Private profile only, from the local subnet only. Nothing else is touched.
# Run by: the helper (server/streamPc.ts addSpFirewallRule), after the person's own UAC "Yes" (elevated), as
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy <RemoteSigned|Bypass> -File firewall_streampc.ps1 -Port 5191 -Program "C:\...\node.exe"
# -Port is a number 1-65535; -Program is the helper's own node.exe (process.execPath); no other input is read.
param(
  [Parameter(Mandatory = $true)] [ValidateRange(1, 65535)] [int]$Port,
  [Parameter(Mandatory = $true)] [ValidateNotNullOrEmpty()] [ValidateLength(1, 1024)] [string]$Program
)
$ErrorActionPreference = 'Stop'
$name = 'VTube Pro (stream PC)'
$desc = 'Lets your stream PC (OBS) show VTube Pro from this PC over your home network. Private networks and your own subnet only.'
Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $name -Description $desc -Direction Inbound -Action Allow -Profile Private -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet -Program $Program | Out-Null
