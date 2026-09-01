# Windows preview

The Windows x64 package is an early, unsigned build for known testers. It uses CPU
transcription and CPU speaker diarization. Windows may show an unknown-publisher warning when
the installer starts.

## Create the workflow artifact

Run the `Windows preview` workflow manually in GitHub Actions. The job uses a Windows runner
to install the pinned dependencies, stage FFmpeg and the application icon, run tests and
native smoke checks, build the NSIS installer, and inspect the packaged native files.

The workflow uploads one artifact for 14 days. It contains:

```text
unottr-<version>-windows-x64-preview.exe
unottr-<version>-windows-x64-preview.exe.sha256
```

The normal tag-based release workflow does not publish this preview.

## Verify the download

Keep the installer and checksum file in the same directory. In PowerShell, run:

```powershell
$installer = Get-ChildItem -File "*-windows-x64-preview.exe" | Select-Object -First 1
$expected = (Get-Content "$($installer.FullName).sha256").Split(" ")[0]
$actual = (Get-FileHash $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "Installer checksum mismatch" }
```

Only continue when the hashes match. The installer is unsigned, so SmartScreen may require
`More info`, then `Run anyway`. Do not tell testers to disable SmartScreen.

## Clean-machine check

Use a normal user account on Windows 11 x64. The machine should not have Node.js, pnpm,
FFmpeg, Visual Studio, or the Vulkan SDK installed.

- Install for the current user without elevation.
- Launch UnoTTR and complete first-run setup.
- Choose a folder on a local NTFS drive.
- Download the Small transcription model and speaker models.
- Add a five-minute MP4 or multitrack MKV and wait for CPU processing to finish.
- Confirm that the transcript and speaker labels appear.
- Play the source recording, seek to another point, search the transcript, and export it.
- Close and reopen the app. Confirm that the recording and watched folder remain.
- Install a newer preview over the old version. Confirm that data remains.
- Uninstall UnoTTR. Confirm that `%LOCALAPPDATA%\unottr` remains.

Windows 10 support stays best effort until this checklist passes on Windows 10 22H2 x64.

## Report a problem

UnoTTR does not upload telemetry or crash reports. Open Settings, go to Advanced, and choose
`Open log folder`. Send `unottr.log` with a short description of what happened. Review the
file before sharing it. Do not send recordings, transcripts, database files, or API keys.

Known limits for this preview include Windows autostart, GPU acceleration, fast Sortformer
diarization, installed AI agent CLI discovery, ARM64, OneDrive watch folders, SMB shares,
automatic updates, and code signing.
