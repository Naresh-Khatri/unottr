# Apple Silicon tester build

This build is for the M1 tester group. It is arm64-only, ad-hoc signed, and not notarized.
Build it on an Apple Silicon Mac running macOS 13 or newer. Do not copy `node_modules`,
`resources/bin`, or a packaged app from Linux.

## Prepare a clean Mac checkout

Install Xcode Command Line Tools, Node, and the repository's pinned pnpm version. Then run:

```sh
pnpm install --frozen-lockfile
pnpm stage:macos:icon
pnpm stage:macos:ffmpeg
pnpm typecheck
pnpm test
pnpm smoke:native
```

The native smoke output must say `platform=darwin arch=arm64 whisper=default`. A failure here
is a dependency problem. Do not move on to packaging until Whisper, sherpa-onnx, and
better-sqlite3 all load.

## Inspect staged FFmpeg

```sh
file resources/bin/darwin-arm64/ffmpeg resources/bin/darwin-arm64/ffprobe
resources/bin/darwin-arm64/ffmpeg -version
shasum -a 256 -c resources/bin/darwin-arm64/ffmpeg-sha256.txt
```

Both files must report arm64 Mach-O. The configuration line must contain neither
`--enable-gpl` nor `--enable-nonfree`.

## Create the tester artifact

Run the Mac arm64 target from the clean Mac checkout:

```sh
pnpm dist --mac --arm64
```

This creates an unpacked `.app` and a zip under `release/`. It does not create a DMG, submit
anything to Apple, or use a Developer ID certificate.

## Inspect the finished app

Set `APP` to the unpacked app path produced by electron-builder, then run:

```sh
APP="release/mac-arm64/unottr.app"
codesign --verify --deep --strict "$APP"
find "$APP" -type f -print0 | xargs -0 file > release/macos-file-report.txt
grep -E 'x86_64|ELF|\.so([.:]|$)' release/macos-file-report.txt
find "$APP" -iname '*vulkan*' -o -iname '*sortformer*'
otool -L "$APP/Contents/Resources/app.asar.unpacked/node_modules/sherpa-onnx-darwin-arm64/sherpa-onnx.node"
```

The two searches must print nothing. Review every `otool -L` dependency and confirm it points
to a system library or a dylib inside the app.

## Open a transferred build

The zip is not notarized. Send its SHA-256 separately so the tester can verify the file before
opening it. If macOS quarantines the verified internal build, the tester can Control-click the
app and choose Open. If that route is unavailable, remove quarantine only from this exact app:

```sh
xattr -dr com.apple.quarantine "/path/to/unottr.app"
```

Never tell testers to disable Gatekeeper globally.

## Offline pipeline run

Use a fresh `UNOTTR_DATA_DIR` for the clean-room pass. Complete setup while online, confirm it
downloads Large V3 Turbo and Small, then disconnect the network. Process WAV, MOV, and MP4
files. The logs must record `actual=large-v3-turbo backend=metal` during the normal path.

Force one Turbo allocation failure. The recording must retry once with
`actual=small backend=metal fallback=small-metal`. Restart before retrying one case to prove
the database keeps the fallback. Cancellation and a generic worker crash must not select Small.

Finish the remaining checks in phase 12.7 of
[`docs/plan/12-macos-arm64.md`](plan/12-macos-arm64.md).
