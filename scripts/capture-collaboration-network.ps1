param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9-]{1,48}$')][string]$CaptureId,
  [Parameter(Mandatory=$true)][System.Net.IPAddress]$Peer,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [ValidateRange(1,180)][int]$Seconds = 90,
  [ValidateRange(1,65535)][int]$Port = 443
)
$ErrorActionPreference = 'Stop'
if (Test-Path $OutputDirectory) { throw 'Output directory already exists' }
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$manifest = @{ schemaVersion='planweave.network.capture/v1'; captureId=$CaptureId;
  startedAt=[DateTime]::UtcNow.ToString('o'); platform='Windows'; peer=$Peer.ToString(); port=$Port;
  coverage='Connection states and system-wide TCP counters. Per-flow RTT/retransmission and packet timestamps require simultaneous Server packet capture.' }
$writer = [System.IO.StreamWriter]::new((Join-Path $OutputDirectory 'samples.jsonl'))
try {
  while ($watch.Elapsed.TotalSeconds -lt $Seconds) {
    $sample = @{ atMs=$watch.Elapsed.TotalMilliseconds; atUtc=[DateTime]::UtcNow.ToString('o') }
    try {
      $sample.connections = @(Get-NetTCPConnection | Where-Object {
        $_.RemoteAddress -eq $Peer.ToString() -and ($_.RemotePort -eq $Port -or $_.LocalPort -eq $Port)
      } | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess)
    } catch { $sample.connectionError = $_.Exception.Message }
    # GetIPv4Statistics is system-wide, so other traffic can affect these counters.
    $stats = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetTcpIPv4Statistics()
    $sample.tcpCountersSystemWide = @{ sent=$stats.SegmentsSent; received=$stats.SegmentsReceived;
      resent=$stats.SegmentsResent; errors=$stats.ErrorsReceived }
    $writer.WriteLine(($sample | ConvertTo-Json -Depth 6 -Compress))
    $writer.Flush()
    Start-Sleep -Milliseconds 500
  }
} finally {
  $writer.Dispose()
  $manifest.durationMs = $watch.Elapsed.TotalMilliseconds
  $manifest | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $OutputDirectory 'manifest.json') -Encoding UTF8
}
Write-Output $OutputDirectory
