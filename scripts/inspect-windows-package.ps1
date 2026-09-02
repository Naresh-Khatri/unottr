$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$release = Join-Path $repositoryRoot "release"
$unpacked = Join-Path $release "win-unpacked"
$resources = Join-Path $unpacked "resources"
$asarUnpacked = Join-Path $resources "app.asar.unpacked"

function Require-Path([string]$path) {
  if (-not (Test-Path $path)) {
    throw "Missing packaged file: $path"
  }
}

Require-Path (Join-Path $resources "bin\win32-x64\ffmpeg.exe")
Require-Path (Join-Path $resources "bin\win32-x64\ffprobe.exe")
Require-Path (Join-Path $resources "bin\win32-x64\ffmpeg-LICENSE.txt")
Require-Path (Join-Path $asarUnpacked "node_modules\better-sqlite3\prebuilds\win32-x64.node")

foreach ($name in @(
  "avcodec-63.dll",
  "avdevice-63.dll",
  "avfilter-12.dll",
  "avformat-63.dll",
  "avutil-61.dll",
  "swresample-7.dll",
  "swscale-10.dll"
)) {
  Require-Path (Join-Path $resources "bin\win32-x64\$name")
}

foreach ($name in @("ffmpeg.exe", "ffprobe.exe")) {
  $binary = Join-Path $resources "bin\win32-x64\$name"
  $process = Start-Process -FilePath $binary -ArgumentList "-version" -Wait -PassThru -NoNewWindow
  if ($process.ExitCode -ne 0) {
    throw "Packaged $name failed with exit code $($process.ExitCode)"
  }
}

$whisper = Join-Path $asarUnpacked "node_modules\@fugood\node-whisper-win32-x64"
$sherpa = Join-Path $asarUnpacked "node_modules\sherpa-onnx-win-x64"
Require-Path $whisper
Require-Path $sherpa

if (-not (Get-ChildItem $whisper -Recurse -File -Filter "*.node" | Select-Object -First 1)) {
  throw "The Windows Whisper package contains no native addon"
}
foreach ($name in @(
  "onnxruntime.dll",
  "onnxruntime_providers_shared.dll",
  "sherpa-onnx-c-api.dll",
  "sherpa-onnx-cxx-api.dll",
  "sherpa-onnx.node"
)) {
  if (-not (Get-ChildItem $sherpa -Recurse -File -Filter $name | Select-Object -First 1)) {
    throw "The Windows sherpa package is missing $name"
  }
}

$foreign = Get-ChildItem $unpacked -Recurse -File | Where-Object {
  $_.Extension -in @(".so", ".dylib")
}
if ($foreign) {
  throw "Foreign native libraries were packaged: $($foreign.FullName -join ', ')"
}

$installers = @(Get-ChildItem $release -File -Filter "*-windows-x64-preview.exe")
if ($installers.Count -ne 1) {
  throw "Expected one Windows preview installer, found $($installers.Count)"
}

Write-Host "Windows package inspection passed: $($installers[0].Name)"
