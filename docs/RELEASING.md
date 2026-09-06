# Release and repository controls

Production releases require a clean, versioned commit that passed the `CI`
workflow on protected `master`, plus an immutable `vX.Y.Z` tag pointing at that
commit. Live branch PR/CI and immutable-tag protections are checked before
building or publishing; missing protection stops the release. The script never
bumps versions, commits, pushes, modifies the
website checkout, replaces `/Applications/flock.app`, or announces releases.

## Activate the repository controls

The desired API payloads live in
[repository-controls.json](../.github/repository-controls.json). The project uses
an explicit single-maintainer release policy: `remiminnebo` reviews and merges
release PRs after CI passes. A separate reviewer approval is not required, since
a PR author cannot approve their own PR. [CODEOWNERS](../.github/CODEOWNERS)
identifies the maintainer without requiring self-approval.

The release script requires the PR rule to be active, strict GitHub Actions
`CI required`, administrator enforcement, and an update allowlist containing
only `remiminnebo`. Teams, apps and PR-review bypass actors are not permitted;
force pushes and deletion are blocked. It also verifies immutable release tags.
Removing the PR rule, weakening CI or granting another account merge authority
stops the release. The zero-approval policy does not bypass any build, signing,
notarization, packaged smoke or artifact verification step.

Apply the reviewed payloads using a repository administrator account:

```sh
jq .repository .github/repository-controls.json > /tmp/flock-repository.json
gh api --method PATCH repos/theflock-labs/flock-code --input /tmp/flock-repository.json
gh api --method PUT repos/theflock-labs/flock-code/vulnerability-alerts
gh api --method PUT repos/theflock-labs/flock-code/automated-security-fixes
jq .actions_permissions .github/repository-controls.json > /tmp/flock-actions-permissions.json
gh api --method PUT repos/theflock-labs/flock-code/actions/permissions --input /tmp/flock-actions-permissions.json
jq .workflow_permissions .github/repository-controls.json > /tmp/flock-workflow-permissions.json
gh api --method PUT repos/theflock-labs/flock-code/actions/permissions/workflow --input /tmp/flock-workflow-permissions.json
jq .branch_protection .github/repository-controls.json > /tmp/flock-master-protection.json
gh api --method PUT repos/theflock-labs/flock-code/branches/master/protection --input /tmp/flock-master-protection.json
jq .release_tag_ruleset .github/repository-controls.json > /tmp/flock-release-tags.json
gh api --method POST repos/theflock-labs/flock-code/rulesets --input /tmp/flock-release-tags.json
```

Update an existing ruleset by its ID instead of creating duplicates. Verify the
resulting branch protection, rulesets, security-and-analysis and automated
security-fixes API responses. Check that a failing test PR is blocked from
merging and only the maintainer can merge a passing one. Tags can be created by
maintainers, but cannot be rewritten or
deleted. Publishing additionally proves that the tag names a checked master
commit. Ordinary contributor workflows have read-only permissions, immutable
Action SHAs and no signing/deployment secrets; dependency review does not post PR
comments. Dependabot covers Cargo, both npm lockfiles and Actions.

`CI required` covers the macOS workspace and production app build, bounded
frontend tests, service checks/tests, disposable social-authorization database
tests, dependency audit and PR dependency review.
Whitespace errors fail the gate. The existing repository-wide rustfmt backlog is
deferred to a focused normalization change; it is not presented as a passing
format check. Destructive database integration tests must use disposable fixtures.

## Prepare and build

Use Apple Silicon macOS with Xcode Command Line Tools (or full Xcode), the versions in `rust-toolchain.toml` and
`.node-version`, Python 3.11+, GitHub CLI, Docker, and `minisign`. npm is the version
bundled with that exact Node distribution. Install the Developer ID certificate
in the login keychain. The active developer tools must provide the macOS SDK,
`clang`, `notarytool` and `stapler`; the full Xcode application is not required
for this desktop-only target. Set these environment variables explicitly; the script
does not silently source `scripts/release.env`:

- `APPLE_SIGNING_IDENTITY`: `Developer ID Application: … (TEAMID)`.
- `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password), and `APPLE_TEAM_ID`.
- `TAURI_SIGNING_PRIVATE_KEY` and, if encrypted, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- `FLOCK_NOTARY_PROFILE`: the name of a profile already saved using
  `xcrun notarytool store-credentials`; it is used to notarize the DMG without
  putting its password on the command line.
- Public `VITE_*` build configuration required by the desktop, including its
  Flock ID backend configuration. Never put secrets in a `VITE_*` variable.

Merge reviewed release notes and matching version changes in `Cargo.toml`,
`Cargo.lock`, the desktop `package.json`/`package-lock.json`, and
`src-tauri/tauri.conf.json` through the protected PR workflow. After CI passes on
master, create/push the matching version tag and check out that exact clean
commit. Run:

```sh
scripts/release.sh build 0.8.0 --notes /absolute/path/to/notes.md --output /absolute/path/outside/repo/flock-0.8.0
```

The build uses a new detached worktree and fresh build directory. It performs
locked npm installs, security checks, frontend/service/Rust tests, disposable
social-authorization database tests, a fresh release
build of `flock-mcp`, and compilation of the app. The compiler, dependency install
scripts and frontend build receive no signing or GitHub credentials from the
caller's environment. Only the subsequent bundling/signing process receives the
signing credentials, with project lifecycle hooks disabled.

Developer ID, the expected Apple team, stapled app and DMG notarization, Gatekeeper
assessment, the mandatory packaged UI smoke test, updater signature, matching app
and sidecar plus all application resources/symlinks in DMG/updater, and bundle version are verified before the
artifact set is completed. The terminal running the packaged smoke test needs
macOS Accessibility permission. `SKIP_SMOKE`, ad-hoc signing and missing-updater
fallbacks are not supported. The smoke test currently covers startup and window
chrome; it does not establish complete feature/end-to-end coverage.

The directory contains the DMG, updater tarball/signature, `latest.json`, release
notes, a CycloneDX resolved-dependency inventory, and build provenance including
commit, CI run, tools and lockfile hashes. `SHA256SUMS` covers all those files and
is signed with the updater key. This is a signed local build record, not a claim
of hermetic/bit-identical builds or hosted SLSA attestation. The inventory includes
development/build and target-specific dependencies; not all ship at runtime.

## Verify a draft, then publish

```sh
scripts/release.sh draft 0.8.0 --artifacts /absolute/path/flock-0.8.0
scripts/release.sh publish 0.8.0 --artifacts /absolute/path/flock-0.8.0
```

Each command rechecks the clean commit/tag, the latest successful master CI run,
the signed checksum manifest, bundle identity, notarization and updater artifacts.
`draft` uploads the complete set, downloads it again and verifies every byte.
`publish` requires that matching draft, downloads/verifies it again, then promotes
it. Any failed step leaves the release unpublished. A failed draft upload may
leave an incomplete private draft for a maintainer to inspect/remove; it is never
silently reused or promoted.

## Deploy the website updater separately

After GitHub publication, prepare a website change from the same verified output:

1. Copy the versioned DMG to `downloads/` and the versioned updater tarball to
   `updates/`. Keep old versioned files available for in-flight downloads.
2. Deploy and verify those immutable payload URLs before changing a manifest.
3. Copy the exact staged `latest.json` bytes to both the canonical updater and the
   legacy `clarence.minnebo.ai/updates/latest.json` bridge. If both hostnames alias
   the same deployment, one file serves both. Otherwise deploy each bridge
   explicitly. Update download/changelog copy in that reviewed website change.
4. Deploy the manifests. Confirm both HTTPS endpoints return identical bytes,
   the intended version/signature, and the exact verified tarball SHA-256. Verify
   the `/download` response resolves to the versioned DMG.
5. Announce the version to running clients only after those checks pass.

A failed website deployment leaves the previous updater manifest serving its
existing release; rerun the website stage with the immutable artifact set. Do not
rebuild or repoint a manifest to an unverified payload to recover.
