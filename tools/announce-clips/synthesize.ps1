# Synthesizes the Thai word clips used by the payment announcement with the Windows
# OneCore voice "Microsoft Pattara" (Settings > Time & language > Speech > Add voices > Thai).
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/announce-clips/synthesize.ps1 -OutDir <raw dir>
# Then: node tools/announce-clips/process.mjs <raw dir>   (trim, compress, normalize -> web/public/announce)
param([Parameter(Mandatory = $true)][string]$OutDir)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }

# clip file name -> Thai text (kept in sync with web/src/pos/announceNumber.ts)
$clips = [ordered]@{
    'received' = 'ได้รับเงิน'; 'baht' = 'บาท'; 'satang' = 'สตางค์'; 'queue' = 'คิว'
    'd0' = 'ศูนย์'; 'd1' = 'หนึ่ง'; 'd2' = 'สอง'; 'd3' = 'สาม'; 'd4' = 'สี่'
    'd5' = 'ห้า'; 'd6' = 'หก'; 'd7' = 'เจ็ด'; 'd8' = 'แปด'; 'd9' = 'เก้า'
    'sip' = 'สิบ'; 'yi' = 'ยี่'; 'et' = 'เอ็ด'
    'roi' = 'ร้อย'; 'phan' = 'พัน'; 'muen' = 'หมื่น'; 'saen' = 'แสน'
}
$voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.Language -eq 'th-TH' } | Select-Object -First 1
if (-not $voice) { throw 'No th-TH voice installed' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$synth.Voice = $voice
# The Thai voice is slow (a bare "ได้รับเงิน" takes ~2 s): speak faster, pitch unchanged.
$synth.Options.SpeakingRate = 1.35
foreach ($name in $clips.Keys) {
    # a trailing period makes the Thai voice read the bare word once, briefly (without it single words come out long, sometimes twice)
    $stream = Await ($synth.SynthesizeTextToStreamAsync($clips[$name] + '.')) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
    $in = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
    $path = Join-Path $OutDir "$name.wav"
    $fs = [System.IO.File]::Create($path)
    $in.CopyTo($fs); $fs.Close(); $in.Close()
    "{0,-9} {1} bytes  ({2})" -f $name, (Get-Item $path).Length, $clips[$name]
}
"voice: $($voice.DisplayName)"
