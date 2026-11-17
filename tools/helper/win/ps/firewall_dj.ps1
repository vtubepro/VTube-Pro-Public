# VTube Pro: "DJ sync" firewall rule. Replaces the Windows Firewall rule named "VTube Pro DJ sync" with an inbound allow on
# the Private profile for the ports DJ gear sends to (Pro DJ Link, StageLinQ, Art-Net, sACN; OSC / OS2L when DJ apps on
# another computer are allowed). Nothing else is touched.
# Run by: the helper (server/music/routes.ts POST /api/music/firewall), after the person's own UAC "Yes" (elevated), as
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy <RemoteSigned|Bypass> -File firewall_dj.ps1 -Udp 50000,50001 [-Tcp 7000]
# The ports are comma separated numbers 1-65535 (the helper validates them too); no other input is read.
param(
  [Parameter(Mandatory = $true)] [ValidatePattern('^[0-9]{1,5}(,[0-9]{1,5})*$')] [string]$Udp,
  [ValidatePattern('^[0-9]{1,5}(,[0-9]{1,5})*$')] [string]$Tcp = ''
)
$ErrorActionPreference = 'Stop'
function Get-Ports([string]$csv) {
  if ($csv -eq '') { return @() }
  $csv.Split(',') | ForEach-Object { $n = [int]$_; if ($n -lt 1 -or $n -gt 65535) { throw "bad port $n" }; $n }
}
$udpPorts = @(Get-Ports $Udp)
$tcpPorts = @(Get-Ports $Tcp)
$name = 'VTube Pro DJ sync'
$desc = 'Lets DJ players, mixers and DJ apps on your home network send their beat to VTube Pro (Private networks only).'
Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $name -Description $desc -Direction Inbound -Action Allow -Profile Private -Protocol UDP -LocalPort $udpPorts | Out-Null
if ($tcpPorts.Count) { New-NetFirewallRule -DisplayName $name -Description $desc -Direction Inbound -Action Allow -Profile Private -Protocol TCP -LocalPort $tcpPorts | Out-Null }
