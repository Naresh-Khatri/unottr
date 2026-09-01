$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$destination = Join-Path $repositoryRoot "resources\bin\win32-x64"
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("unottr-ffmpeg-" + [guid]::NewGuid())
$archive = Join-Path $temporary "ffmpeg.zip"
$assetName = "ffmpeg-master-latest-win64-lgpl.zip"
$apiUrl = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/latest"

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
  $release = Invoke-RestMethod -Uri $apiUrl -Headers $headers
  $asset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
  if (-not $asset) {
    throw "The BtbN release does not contain $assetName"
  }
  if (-not $asset.digest -or -not $asset.digest.StartsWith("sha256:")) {
    throw "GitHub did not return a SHA-256 digest for $assetName"
  }

  Invoke-WebRequest -Uri $asset.browser_download_url -Headers $headers -OutFile $archive
  $expected = $asset.digest.Substring(7).ToLowerInvariant()
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
  # Invoke-WebRequest marks downloaded files as Internet content. Expand-Archive can carry
  # that mark onto the executables, after which Windows may let PowerShell inspect them but
  # reject a later CreateProcess call from Node/Electron. The digest above authenticates the
  # archive; remove the zone metadata before validating and packaging the binaries.
  @($ffmpeg, $ffprobe) | Unblock-File
  Copy-Item (Join-Path $source.FullName "LICENSE.txt") (Join-Path $destination "ffmpeg-LICENSE.txt") -Force
  @(
    "release=$($release.tag_name)"
    "asset=$assetName"
    "sha256=$actual"
    "source=$($asset.browser_download_url)"
  ) | Set-Content -Path (Join-Path $destination "ffmpeg-source.txt") -Encoding utf8

  $configuration = & $ffmpeg -version | Select-String "configuration:" | Select-Object -First 1
  if (-not $configuration) {
    throw "Could not read the staged FFmpeg configuration"
  }
  if ($configuration.Line -match "--enable-gpl|--enable-nonfree") {
    throw "The staged FFmpeg build is not LGPL-only"
  }
  & $ffprobe -version | Select-Object -First 2
} finally {
  if (Test-Path $temporary) {
    Remove-Item -Recurse -Force $temporary
  }
}
