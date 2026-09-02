param(
  [Parameter(Mandatory = $true)]
  [string]$Checkpoint
)

$ErrorActionPreference = "Continue"
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$directory = Join-Path $repositoryRoot "resources\bin\win32-x64"
$files = @()

if (Test-Path $directory) {
  foreach ($file in Get-ChildItem $directory -File | Sort-Object Name) {
    try {
      $files += [ordered]@{
        name = $file.Name
        bytes = $file.Length
        sha256 = (Get-FileHash $file.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
      }
    } catch {
      $files += [ordered]@{
        name = $file.Name
        bytes = $file.Length
        error = $_.Exception.Message
      }
    }
  }
}

$defender = @()
try {
  $since = (Get-Date).AddMinutes(-20)
  $defender = @(Get-MpThreatDetection -ErrorAction Stop | Where-Object {
    $_.InitialDetectionTime -ge $since
  } | Sort-Object InitialDetectionTime | ForEach-Object {
    [ordered]@{
      threat_id = $_.ThreatID
      detected_at = $_.InitialDetectionTime
      status_changed_at = $_.LastThreatStatusChangeTime
      action_succeeded = $_.ActionSuccess
      execution_status = $_.CurrentThreatExecutionStatusID
      resources = @($_.Resources)
    }
  })
} catch {
  $defender = @([ordered]@{ error = $_.Exception.Message })
}

[ordered]@{
  checkpoint = $Checkpoint
  checked_at = Get-Date
  directory = $directory
  directory_exists = Test-Path $directory
  ffmpeg_exists = Test-Path (Join-Path $directory "ffmpeg.exe")
  ffprobe_exists = Test-Path (Join-Path $directory "ffprobe.exe")
  files = $files
  recent_defender_detections = $defender
} | ConvertTo-Json -Depth 6
