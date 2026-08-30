# Releasing unottr

Pushing an annotated semantic-version tag starts the release workflow. It builds the Linux
x64 AppImage and the Apple Silicon Mac zip, then publishes both files and their SHA-256
checksums on one GitHub Release.

The Mac build is ad-hoc signed and not notarized. This is intentional. No Apple Developer
Program account or GitHub signing secrets are required.

## Prepare a release

The tag must match the version in `package.json`. For a later patch release, update the
version without creating a tag automatically:

```sh
pnpm version patch --no-git-tag-version
git add package.json
git commit -m "chore(release): v0.1.1"
```

Use `minor` or `major` instead of `patch` when appropriate. For the first release, the
package is already at `0.1.0`, so no version change is needed.

Push the release commit before the tag:

```sh
git push origin main
```

## Write the changelog and push the tag

The tag must be annotated. Its subject becomes the tag title and its body becomes the
Changes section of the GitHub Release. Lightweight tags and tags without a message body
fail validation.

```sh
git tag -a v0.1.0 \
  -m "v0.1.0" \
  -m "- Transcribe and identify speakers locally on Linux and Apple Silicon
- Search recordings and open results at the matching timestamp
- Ask questions across meetings with citations back to the recording"

git push origin v0.1.0
```

Write entries for people using the app. Leave out refactors, dependency updates, and CI
work unless they change the installed application.

The workflow rejects a tag such as `v0.2.0` while `package.json` still says `0.1.0`. It also
publishes prerelease tags such as `v0.2.0-beta.1` as GitHub prereleases.

## Download and verify

Each release contains these four files:

```text
unottr-<version>-x86_64.AppImage
unottr-<version>-x86_64.AppImage.sha256
unottr-<version>-arm64.zip
unottr-<version>-arm64.zip.sha256
```

Verify the AppImage on Linux:

```sh
sha256sum -c unottr-<version>-x86_64.AppImage.sha256
chmod +x unottr-<version>-x86_64.AppImage
./unottr-<version>-x86_64.AppImage
```

Verify the Mac zip before opening it:

```sh
shasum -a 256 -c unottr-<version>-arm64.zip.sha256
```

After extracting the zip and moving `unottr.app` to Applications, Control-click the app and
choose Open. If macOS still blocks this verified build, remove quarantine only from this app:

```sh
xattr -dr com.apple.quarantine "/Applications/unottr.app"
```

Do not disable Gatekeeper globally.

## Build the Mac app locally

Mac users who prefer to build from source can follow `docs/macos-tester-build.md`. The same
staging, native dependency checks, and packaging command run in GitHub Actions.
