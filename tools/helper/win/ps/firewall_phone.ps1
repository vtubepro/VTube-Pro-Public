# VTube Pro: "Let phones connect". Replaces the Windows Firewall rule named "VTube Pro" with an inbound allow on the
# Private profile for exactly the phone-tracking ports it is given. Nothing else is touched.
# Run by: the helper (server/tracking/phoneNet.ts addFirewallRule), after the person's own UAC "Yes" (elevated), as
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy <RemoteSigned|Bypass> -File firewall_phone.ps1 -Udp 11111,39539 -Tcp 8080
# The ports are comma separated numbers 1-65535 (the helper validates them too); no other input is read.
param(
  [ValidatePattern('^[0-9]{1,5}(,[0-9]{1,5})*$')] [string]$Udp = '',
  [ValidatePattern('^[0-9]{1,5}(,[0-9]{1,5})*$')] [string]$Tcp = ''
)
$ErrorActionPreference = 'Stop'
function Get-Ports([string]$csv) {
  if ($csv -eq '') { return @() }
  $csv.Split(',') | ForEach-Object { $n = [int]$_; if ($n -lt 1 -or $n -gt 65535) { throw "bad port $n" }; $n }
}
$udpPorts = @(Get-Ports $Udp)
$tcpPorts = @(Get-Ports $Tcp)
$name = 'VTube Pro'
$desc = 'Lets your phone' + [char]0x2019 + 's face-tracking app reach VTube Pro on your home network (Private networks only).'
Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($udpPorts.Count) { New-NetFirewallRule -DisplayName $name -Description $desc -Direction Inbound -Action Allow -Profile Private -Protocol UDP -LocalPort $udpPorts | Out-Null }
if ($tcpPorts.Count) { New-NetFirewallRule -DisplayName $name -Description $desc -Direction Inbound -Action Allow -Profile Private -Protocol TCP -LocalPort $tcpPorts | Out-Null }
