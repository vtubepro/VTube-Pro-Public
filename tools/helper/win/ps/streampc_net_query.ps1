# VTube Pro: "Let my stream PC connect", the read-only check. Prints ONE JSON object: the Windows Firewall rules named
# "VTube Pro (stream PC)" (enabled, action, direction, profile, protocol, local ports, remote addresses, program) and the
# connected networks' profiles (Public / Private / Domain). Changes nothing and needs no elevation.
# Run by: the helper (server/streamPc.ts spNetQuery), while "Let my stream PC connect" is on, at most every few minutes
# (sooner right after the person opens Windows' network settings from the card, or the network changes), as
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy <RemoteSigned|Bypass> -File streampc_net_query.ps1
# No input is read.
$ErrorActionPreference = 'SilentlyContinue'
$name = 'VTube Pro (stream PC)'
$rules = @(Get-NetFirewallRule -DisplayName $name | ForEach-Object { $pf = $_ | Get-NetFirewallPortFilter; $af = $_ | Get-NetFirewallAddressFilter; $ap = $_ | Get-NetFirewallApplicationFilter; [pscustomobject]@{ Enabled = [string]$_.Enabled; Action = [string]$_.Action; Direction = [string]$_.Direction; Profile = [string]$_.Profile; Protocol = [string]$pf.Protocol; LocalPort = @($pf.LocalPort); RemoteAddress = @($af.RemoteAddress); Program = [string]$ap.Program } })
$profiles = @(Get-NetConnectionProfile | ForEach-Object { [pscustomobject]@{ InterfaceAlias = $_.InterfaceAlias; NetworkCategory = [string]$_.NetworkCategory; Name = $_.Name } })
[pscustomobject]@{ rules = $rules; profiles = $profiles } | ConvertTo-Json -Depth 4 -Compress
