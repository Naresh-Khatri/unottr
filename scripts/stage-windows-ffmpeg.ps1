$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$destination = Join-Path $repositoryRoot "resources\bin\win32-x64"
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("unottr-ffmpeg-" + [guid]::NewGuid())
$archive = Join-Path $temporary "ffmpeg.zip"
$releaseTag = "autobuild-2026-07-31-14-10"
$assetName = "ffmpeg-N-125875-g5d4d3bdc61-win64-lgpl-shared.zip"
$downloadUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$releaseTag/$assetName"
$expected = "6a2e25e2280df8f2071c14155a314ef32ec08100d56e5f32e41a9d7fd8b50cd3"

$headers = @{
  Accept = "application/vnd.github+json"
  "User-Agent" = "unottr-windows-preview"
  "X-GitHub-Api-Version" = "2022-11-28"
}
if ($env:GITHUB_TOKEN) {
  $headers.Authorization = "Bearer $env:GITHUB_TOKEN"
}

try {
  New-Item -ItemType Directory -Path $temporary | Out-Null
  Invoke-WebRequest -Uri $downloadUrl -Headers $headers -OutFile $archive
  $actual = (Get-FileHash -Path $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    throw "FFmpeg archive checksum mismatch: expected $expected, got $actual"
  }

  Expand-Archive -Path $archive -DestinationPath $temporary
  $source = Get-ChildItem -Path $temporary -Directory -Filter "ffmpeg-*" | Select-Object -First 1
  if (-not $source) {
    throw "The FFmpeg archive did not contain the expected directory"
  }

  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  $ffmpeg = Join-Path $destination "ffmpeg.exe"
  $ffprobe = Join-Path $destination "ffprobe.exe"
  Copy-Item (Join-Path $source.FullName "bin\ffmpeg.exe") $ffmpeg -Force
  Copy-Item (Join-Path $source.FullName "bin\ffprobe.exe") $ffprobe -Force
  Copy-Item (Join-Path $source.FullName "bin\*.dll") $destination -Force
  # Invoke-WebRequest marks downloaded files as Internet content. Expand-Archive can carry
  # that mark onto the executables, after which Windows may let PowerShell inspect them but
  # reject a later CreateProcess call from Node/Electron. The digest above authenticates the
  # archive; remove the zone metadata before validating and packaging the runtime.
  @($ffmpeg, $ffprobe) + @(Get-ChildItem $destination -File -Filter "*.dll") | Unblock-File
  Copy-Item (Join-Path $source.FullName "LICENSE.txt") (Join-Path $destination "ffmpeg-LICENSE.txt") -Force
  @(
    "release=$releaseTag"
    "asset=$assetName"
    "sha256=$actual"
    "source=$downloadUrl"
  ) | Set-Content -Path (Join-Path $destination "ffmpeg-source.txt") -Encoding utf8

  $ffmpegVersion = & $ffmpeg -version 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Staged ffmpeg.exe failed with exit code $LASTEXITCODE"
  }
  $configuration = $ffmpegVersion | Select-String "configuration:" | Select-Object -First 1
  if (-not $configuration) {
    throw "Could not read the staged FFmpeg configuration"
  }
  if ($configuration.Line -match "--enable-gpl|--enable-nonfree") {
    throw "The staged FFmpeg build is not LGPL-only"
  }
  $ffprobeVersion = & $ffprobe -version 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Staged ffprobe.exe failed with exit code $LASTEXITCODE"
  }
  $ffprobeVersion | Select-Object -First 2
} finally {
  if (Test-Path $temporary) {
    Remove-Item -Recurse -Force $temporary
  }
}
