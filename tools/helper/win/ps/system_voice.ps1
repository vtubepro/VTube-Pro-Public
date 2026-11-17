# VTube Pro: "This PC's voices" worker for the AI game master (Windows SAPI / System.Speech: offline, no installs).
# A long-lived worker. First line out: "VOICES name~culture~gender|...". Then, for each line on stdin (base64 of a JSON
# request { id, voice, file, ssml }) it writes the spoken audio to the WAV file named in the request (always our own temp
# folder) and answers "OK <id>" or "ERR <id> <message>". It ends when stdin closes.
# Run by: the helper (server/ttrpg/systemVoice.ts), as
#   powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy <RemoteSigned|Bypass> -File system_voice.ps1
# The spoken text never touches a command line: it only arrives on stdin.
param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Speech
$syn = New-Object System.Speech.Synthesis.SpeechSynthesizer
[Console]::Out.WriteLine('VOICES ' + (($syn.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '~' + $_.VoiceInfo.Culture + '~' + $_.VoiceInfo.Gender }) -join '|'))
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $req = $null
  try {
    $req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
    if ($req.voice) { try { $syn.SelectVoice($req.voice) } catch { } }
    $syn.SetOutputToWaveFile($req.file)
    $syn.SpeakSsml($req.ssml)
    $syn.SetOutputToNull()
    [Console]::Out.WriteLine('OK ' + $req.id)
  } catch {
    try { $syn.SetOutputToNull() } catch { }
    $id = if ($req) { $req.id } else { '?' }
    [Console]::Out.WriteLine('ERR ' + $id + ' ' + ($_.Exception.Message -replace '\s+', ' '))
  }
  [Console]::Out.Flush()
}
