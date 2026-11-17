# VTube Pro: "Let phones connect", the read-only check. Prints ONE JSON object: the Windows Firewall rules named
# "VTube Pro" (enabled, action, direction, profile, protocol, local ports) and the connected networks' profiles
# (Public / Private / Domain). Changes nothing and needs no elevation.
# Run by: the helper (server/tracking/phoneNet.ts netQuery), while the studio's phone card is open, at most every few
# minutes (sooner right after the person opens Windows' network settings, or the network changes), as
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy <RemoteSigned|Bypass> -File phone_net_query.ps1
# No input is read.
$ErrorActionPreference = 'SilentlyContinue'
$name = 'VTube Pro'
$rules = @(Get-NetFirewallRule -DisplayName $name | ForEach-Object { $pf = $_ | Get-NetFirewallPortFilter; [pscustomobject]@{ Enabled = [string]$_.Enabled; Action = [string]$_.Action; Direction = [string]$_.Direction; Profile = [string]$_.Profile; Protocol = [string]$pf.Protocol; LocalPort = @($pf.LocalPort) } })
$profiles = @(Get-NetConnectionProfile | ForEach-Object { [pscustomobject]@{ InterfaceAlias = $_.InterfaceAlias; NetworkCategory = [string]$_.NetworkCategory; Name = $_.Name } })
[pscustomobject]@{ rules = $rules; profiles = $profiles } | ConvertTo-Json -Depth 4 -Compress
