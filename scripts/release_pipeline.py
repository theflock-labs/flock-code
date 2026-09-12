#!/usr/bin/env python3
"""Fail-closed, explicit production packaging and publication."""
import argparse
import datetime
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import uuid
from pathlib import Path
from urllib.parse import quote

from release_artifacts import (digest, inspect_archive, payload_names, validate_version, verify_checksums,
                               verify_signature, verify_updater, write_checksums)

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "theflock-labs/flock-code"
RELEASE_MAINTAINER = "remiminnebo"
APP_REL = Path("apps/flock-desktop")
SIGNING_KEYS = ("APPLE_SIGNING_IDENTITY", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID",
                "TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD")


def run(args, *, cwd=ROOT, env=None, capture=False):
    if env is None:
        env = {key: value for key, value in os.environ.items() if key not in SIGNING_KEYS}
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, check=True,
                            text=True, capture_output=capture)
    return result.stdout.strip() if capture else None


def github(path):
    return json.loads(run(["gh", "api", f"repos/{REPOSITORY}/{path}"], capture=True))


def validate_repository_controls(protection, rulesets):
    checks = protection.get("required_status_checks") or {}
    reviews = protection.get("required_pull_request_reviews")
    restrictions = protection.get("restrictions") or {}
    bypasses = (reviews or {}).get("bypass_pull_request_allowances") or {}
    # The sole maintainer reviews and merges the PR themselves. A separate
    # approval is not required, but neither direct pushes nor another merger
    # may bypass the PR and CI gates.
    if (not protection.get("enforce_admins", {}).get("enabled")
            or not checks.get("strict")
            or not any(check.get("context") == "CI required" and check.get("app_id") == 15368
                       for check in checks.get("checks", []))
            or not isinstance(reviews, dict)
            or [user.get("login") for user in restrictions.get("users", [])] != [RELEASE_MAINTAINER]
            or restrictions.get("teams") or restrictions.get("apps")
            or any(bypasses.get(kind) for kind in ("users", "teams", "apps"))
            or protection.get("allow_force_pushes", {}).get("enabled", True)
            or protection.get("allow_deletions", {}).get("enabled", True)):
        raise ValueError("Required master PR/CI and single-maintainer protections are not fully active")
    for ruleset in rulesets:
        refs = ruleset.get("conditions", {}).get("ref_name", {})
        if (ruleset.get("target") == "tag" and ruleset.get("enforcement") == "active"
                and not ruleset.get("bypass_actors") and not refs.get("exclude")
                and "refs/tags/v*" in refs.get("include", [])
                and {"deletion", "update"} <= {rule["type"] for rule in ruleset.get("rules", [])}):
            return
    raise ValueError("Immutable release-tag protection is not fully active")


def protected_repository():
    try:
        protection = github("branches/master/protection")
    except subprocess.CalledProcessError as error:
        raise ValueError("Cannot verify master protection; activate docs/RELEASING.md controls before release") from error
    rulesets = [github(f"rulesets/{item['id']}") for item in github("rulesets?per_page=100")
                if item.get("target") == "tag" and item.get("enforcement") == "active"]
    validate_repository_controls(protection, rulesets)


def source_commit(version):
    commit = run(["git", "rev-parse", "HEAD"], capture=True)
    if run(["git", "status", "--porcelain", "--untracked-files=all"], capture=True):
        raise ValueError("Release source must be committed and clean")
    tag_commit = run(["git", "rev-parse", f"refs/tags/v{version}^{{commit}}"], capture=True)
    if tag_commit != commit:
        raise ValueError("HEAD must be the exact version tag commit")
    return commit


def checked_source(commit, version):
    protected_repository()
    ref = github(f"git/ref/tags/v{version}")["object"]
    for _ in range(5):
        if ref["type"] != "tag":
            break
        ref = github(f"git/tags/{ref['sha']}")["object"]
    if ref["type"] != "commit" or ref["sha"] != commit:
        raise ValueError("Published release tag does not match the tested commit")
    if github(f"compare/master...{commit}")["status"] not in ("behind", "identical"):
        raise ValueError("Release commit is not on the protected master branch")
    runs = github(f"actions/workflows/ci.yml/runs?head_sha={commit}&event=push&per_page=100")["workflow_runs"]
    runs = [item for item in runs if item["head_sha"] == commit and item["head_branch"] == "master"]
    if not runs or runs[0]["status"] != "completed" or runs[0]["conclusion"] != "success":
        raise ValueError("Latest CI workflow for this exact master commit has not passed")
    return runs[0]["html_url"]


def build_environment(commit):
    # Install scripts, frontend bundling and Rust build.rs code never receive
    # signing keys, GitHub tokens or the rest of the caller's environment.
    keys = {"HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "CARGO_HOME", "RUSTUP_HOME", "DEVELOPER_DIR"}
    result = {key: value for key, value in os.environ.items() if key in keys or key.startswith("VITE_")}
    result.update(CI="true", CARGO_INCREMENTAL="0",
                  SOURCE_DATE_EPOCH=run(["git", "show", "-s", "--format=%ct", commit], capture=True))
    return result


def verify_macos_tools():
    # Desktop-only Tauri builds and notarization work with Command Line Tools.
    # xcodebuild -version would incorrectly require the full Xcode application.
    sdk = Path(run(["xcrun", "--sdk", "macosx", "--show-sdk-path"], capture=True))
    if not sdk.is_dir():
        raise ValueError("The active macOS SDK is missing")
    for tool in ("clang", "notarytool", "stapler"):
        executable = Path(run(["xcrun", "--find", tool], capture=True))
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise ValueError(f"Required macOS release tool missing: {tool}")


def preflight(root, version):
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise ValueError("Production currently targets Apple Silicon macOS only")
    for key in SIGNING_KEYS[:-1] + ("FLOCK_NOTARY_PROFILE",):
        if not os.environ.get(key):
            raise ValueError(f"Production release requires {key}")
    identity = os.environ["APPLE_SIGNING_IDENTITY"]
    if not identity.startswith("Developer ID Application: ") or not identity.endswith(f"({os.environ['APPLE_TEAM_ID']})"):
        raise ValueError("Production requires the matching Developer ID Application identity")
    for command in ("gh", "node", "npm", "cargo", "rustc", "minisign", "codesign", "xcrun", "hdiutil", "spctl", "docker"):
        if not shutil.which(command):
            raise ValueError(f"Required release tool missing: {command}")
    verify_macos_tools()
    run(["docker", "info", "--format", "{{.ServerVersion}}"], capture=True)
    node = run(["node", "--version"], capture=True).removeprefix("v")
    rust = run(["rustc", "--version"], capture=True).split()[1]
    if node != (root / ".node-version").read_text().strip():
        raise ValueError("Use the exact Node version from .node-version")
    if rust != tomllib.loads((root / "rust-toolchain.toml").read_text())["toolchain"]["channel"]:
        raise ValueError("Use the exact Rust version from rust-toolchain.toml")
    workspace = tomllib.loads((root / "Cargo.toml").read_text())["workspace"]["package"]["version"]
    app = json.loads((root / APP_REL / "package.json").read_text())["version"]
    config = json.loads((root / APP_REL / "src-tauri/tauri.conf.json").read_text())
    if workspace != version or app != version or config["version"] != version:
        raise ValueError("Commit the matching Cargo, npm and Tauri version before releasing")
    return config


def verify_identity(bundle, team_id):
    detail = subprocess.run(["codesign", "-dv", "--verbose=4", str(bundle)], check=True,
                            capture_output=True, text=True,
                            env={key: value for key, value in os.environ.items() if key not in SIGNING_KEYS}).stderr
    if f"TeamIdentifier={team_id}\n" not in detail or "Authority=Developer ID Application:" not in detail:
        raise ValueError("Bundle is not signed by the expected Developer ID team")


def verify_macos(app, team_id):
    run(["codesign", "--verify", "--deep", "--strict", app])
    verify_identity(app, team_id)
    run(["xcrun", "stapler", "validate", app])
    run(["spctl", "--assess", "--type", "execute", "--verbose=2", app])


def smoke_updater(archive, version, public_key, team_id, script, env):
    """Exercise the distributed app independently of the build tree."""
    archive = Path(archive)
    verify_signature(archive, Path(str(archive) + ".sig").read_text(), public_key)
    inspect_archive(archive, version)
    # A fresh build can run without exposing accessible windows inside the
    # Cargo output tree. Stage the verified updater as a separate installation;
    # the packaged smoke assertions and failure handling remain mandatory.
    with tempfile.TemporaryDirectory(prefix="flock-smoke-", dir="/tmp") as temporary:
        directory = Path(temporary)
        with tarfile.open(archive, "r:gz") as package:
            package.extractall(directory, filter="data")
        app = directory / "flock.app"
        verify_macos(app, team_id)
        run([script, app], cwd=directory, env=env)


def verify_dmg(dmg, version, team_id, expected_binaries):
    run(["hdiutil", "verify", dmg])
    run(["codesign", "--verify", "--strict", dmg])
    verify_identity(dmg, team_id)
    run(["xcrun", "stapler", "validate", dmg])
    with tempfile.TemporaryDirectory(prefix="flock-dmg-") as temporary:
        mount = Path(temporary) / "mount"
        run(["hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg], capture=True)
        try:
            app = mount / "flock.app"
            verify_macos(app, team_id)
            import plistlib
            info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
            if info.get("CFBundleShortVersionString") != version:
                raise ValueError("DMG app version differs from updater version")
            actual = {}
            for path in app.rglob("*"):
                name = path.relative_to(mount).as_posix()
                if path.is_symlink():
                    actual[name] = "symlink:" + os.readlink(path)
                elif path.is_file():
                    actual[name] = digest(path)
            if actual != expected_binaries:
                raise ValueError("DMG and updater contain different application contents")
        finally:
            run(["hdiutil", "detach", mount])


def inventory(source, version, env):
    metadata = json.loads(run(["cargo", "metadata", "--locked", "--format-version=1"], cwd=source, env=env, capture=True))
    components = []
    for package in metadata["packages"]:
        component = {"type": "library", "name": package["name"], "version": package["version"],
                     "purl": f"pkg:cargo/{package['name']}@{package['version']}"}
        if package.get("license"):
            component["licenses"] = [{"expression": package["license"]}]
        components.append(component)
    for lock_path in (APP_REL / "package-lock.json", Path("services/presence-auth/package-lock.json")):
        lock = json.loads((source / lock_path).read_text())
        for location, package in lock["packages"].items():
            if not location or not package.get("version"):
                continue
            name = package.get("name") or location.split("node_modules/")[-1]
            components.append({"type": "library", "name": name, "version": package["version"],
                               "purl": f"pkg:npm/{quote(name, safe='/')}@{package['version']}",
                               "properties": [{"name": "flock:lockfile", "value": str(lock_path)},
                                              {"name": "flock:development", "value": str(package.get('dev', False)).lower()}]})
    # An inventory of resolved dependencies, including build/dev and all Rust
    # targets. This deliberately does not claim every package ships at runtime.
    return {"bomFormat": "CycloneDX", "specVersion": "1.6", "version": 1,
            "serialNumber": f"urn:uuid:{uuid.uuid4()}",
            "metadata": {"component": {"type": "application", "name": "flock", "version": version}},
            "components": components}


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + "\n")


def build(args):
    version = validate_version(args.version)
    commit = source_commit(version)
    config = preflight(ROOT, version)
    ci_url = checked_source(commit, version)
    notes = Path(args.notes).resolve()
    if not notes.is_file() or not notes.read_text().strip():
        raise ValueError("Nonempty, reviewed release notes are required")
    output = Path(args.output).resolve()
    if output.exists():
        raise ValueError("Use a new output directory; release artifacts are never overwritten")
    if output.is_relative_to(ROOT):
        raise ValueError("Place release artifacts outside the source checkout")
    clean_env = build_environment(commit)
    with tempfile.TemporaryDirectory(prefix="flock-release-") as temporary:
        source = Path(temporary) / "source"
        run(["git", "worktree", "add", "--detach", source, commit])
        try:
            app_dir = source / APP_REL
            service_dir = source / "services/presence-auth"
            run(["npm", "ci"], cwd=app_dir, env=clean_env)
            run(["npm", "ci"], cwd=service_dir, env=clean_env)
            run(["npm", "test", "--", "--maxWorkers=2"], cwd=app_dir, env=clean_env)
            run(["npm", "run", "check"], cwd=service_dir, env=clean_env)
            run(["npm", "test"], cwd=service_dir, env=clean_env)
            run(["python3", "services/flock-id/tests/run.py"], cwd=source, env=clean_env)
            run(["python3", "scripts/audit-dependencies.py"], cwd=source, env=clean_env)
            run(["python3", "-m", "unittest", "discover", "-s", "scripts/tests", "-p", "test_*.py"], cwd=source, env=clean_env)
            run(["cargo", "build", "--locked", "--release", "-p", "flock-mcp"], cwd=source, env=clean_env)
            sidecars = app_dir / "src-tauri/binaries"
            sidecars.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / "target/release/flock-mcp", sidecars / "flock-mcp-aarch64-apple-darwin")
            run(["cargo", "test", "--workspace", "--locked"], cwd=source, env=clean_env)
            tauri = app_dir / "node_modules/.bin/tauri"
            run([tauri, "build", "--no-bundle", "--ci", "--", "--locked"], cwd=app_dir, env=clean_env)
            if run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=source, capture=True):
                raise ValueError("Build changed tracked source or lockfiles")
            signing_env = dict(clean_env)
            signing_env.update({key: os.environ[key] for key in SIGNING_KEYS if key in os.environ})
            # The app/frontend are already compiled. Prevent project lifecycle
            # hooks from running while signing credentials are in the environment.
            bundle_config = {"build": {"beforeBuildCommand": "", "beforeBundleCommand": ""},
                             "bundle": {"createUpdaterArtifacts": True,
                                        "macOS": {"signingIdentity": os.environ["APPLE_SIGNING_IDENTITY"]}}}
            run([tauri, "bundle", "--ci", "--bundles", "app,dmg", "--config", json.dumps(bundle_config)],
                cwd=app_dir, env=signing_env)
            bundle = source / "target/release/bundle"
            app = bundle / "macos/flock.app"
            dmg = bundle / f"dmg/flock_{version}_aarch64.dmg"
            verify_macos(app, os.environ["APPLE_TEAM_ID"])
            # Tauri notarizes/staples the app, but the DMG must also be submitted.
            notary = json.loads(run(["xcrun", "notarytool", "submit", dmg, "--keychain-profile",
                                     os.environ["FLOCK_NOTARY_PROFILE"], "--wait", "--output-format", "json"],
                                    env=clean_env, capture=True))
            if notary.get("status") != "Accepted":
                raise ValueError("Apple rejected DMG notarization")
            run(["xcrun", "stapler", "staple", dmg], env=clean_env)
            smoke_updater(Path(str(app) + ".tar.gz"), version,
                          config["plugins"]["updater"]["pubkey"], os.environ["APPLE_TEAM_ID"],
                          source / "scripts/smoke.sh", clean_env)
            output.mkdir(parents=True)
            shutil.copy2(dmg, output / dmg.name)
            shutil.copy2(str(app) + ".tar.gz", output / f"flock_{version}.app.tar.gz")
            shutil.copy2(str(app) + ".tar.gz.sig", output / f"flock_{version}.app.tar.gz.sig")
            shutil.copy2(notes, output / "RELEASE_NOTES.md")
            signature = (output / f"flock_{version}.app.tar.gz.sig").read_text().strip()
            write_json(output / "latest.json", {"version": version, "notes": notes.read_text().strip(),
                       "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                       "platforms": {"darwin-aarch64": {"signature": signature,
                           "url": f"https://theflock.sh/updates/flock_{version}.app.tar.gz"}}})
            binaries = verify_updater(output, version, config["plugins"]["updater"]["pubkey"])
            verify_dmg(output / dmg.name, version, os.environ["APPLE_TEAM_ID"], binaries)
            write_json(output / "bom.cdx.json", inventory(source, version, clean_env))
            write_json(output / "provenance.json", {
                "schema": "flock-release-build/v1", "repository": f"https://github.com/{REPOSITORY}",
                "commit": commit, "tag": f"v{version}", "version": version, "ci": ci_url,
                "target": "aarch64-apple-darwin", "apple_team_id": os.environ["APPLE_TEAM_ID"],
                "notarization_submission": notary["id"],
                "checks": ["locked-installs", "dependency-audit", "frontend-tests", "service-tests",
                           "rust-workspace-tests", "fresh-sidecar", "packaged-smoke", "developer-id",
                           "notarized-app-and-dmg", "updater-signature", "dmg-updater-binary-identity"],
                "tools": {name: run(command, cwd=source, env=clean_env, capture=True) for name, command in {
                    "rust": ["rustc", "--version"], "cargo": ["cargo", "--version"],
                    "node": ["node", "--version"], "npm": ["npm", "--version"], "minisign": ["minisign", "-v"],
                    "tauri": [tauri, "--version"], "apple_clang": ["xcrun", "clang", "--version"],
                    "macos_sdk": ["xcrun", "--sdk", "macosx", "--show-sdk-version"],
                    "macos": ["sw_vers", "-productVersion"]}.items()},
                "locks": {path: digest(source / path) for path in ["Cargo.lock",
                    "apps/flock-desktop/package-lock.json", "services/presence-auth/package-lock.json"]},
            })
            write_checksums(output, version)
            run([tauri, "signer", "sign", output / "SHA256SUMS"], cwd=app_dir, env=signing_env, capture=True)
            verify_artifacts(output, version, commit, config["plugins"]["updater"]["pubkey"])
        finally:
            run(["git", "worktree", "remove", "--force", source])
    print(f"Verified release staged at {output}. No release or website was published.")


def verify_artifacts(directory, version, commit, public_key):
    directory = Path(directory)
    verify_signature(directory / "SHA256SUMS", (directory / "SHA256SUMS.sig").read_text(), public_key)
    verify_checksums(directory, version)
    provenance = json.loads((directory / "provenance.json").read_text())
    if provenance.get("commit") != commit or provenance.get("version") != version or provenance.get("tag") != f"v{version}":
        raise ValueError("Signed release provenance refers to another commit/version")
    if provenance.get("schema") != "flock-release-build/v1" or provenance.get("repository") != f"https://github.com/{REPOSITORY}":
        raise ValueError("Unrecognized release provenance")
    binaries = verify_updater(directory, version, public_key)
    verify_dmg(directory / f"flock_{version}_aarch64.dmg", version, provenance["apple_team_id"], binaries)


def publish(args):
    version = validate_version(args.version)
    commit = source_commit(version)
    checked_source(commit, version)
    config = json.loads(run(["git", "show", f"{commit}:apps/flock-desktop/src-tauri/tauri.conf.json"], capture=True))
    artifacts = Path(args.artifacts).resolve()
    public_key = config["plugins"]["updater"]["pubkey"]
    verify_artifacts(artifacts, version, commit, public_key)
    tag = f"v{version}"
    if args.command == "draft":
        run(["gh", "release", "create", tag, "--repo", REPOSITORY, "--verify-tag", "--draft",
             "--target", commit, "--title", f"flock {version}", "--notes-file", artifacts / "RELEASE_NOTES.md",
             *[artifacts / name for name in sorted(payload_names(version) | {"SHA256SUMS", "SHA256SUMS.sig"})]])
    release = json.loads(run(["gh", "release", "view", tag, "--repo", REPOSITORY,
                             "--json", "isDraft,tagName,assets"], capture=True))
    if not release["isDraft"] or release["tagName"] != tag:
        raise ValueError("Only the matching draft release can be verified/promoted")
    expected = payload_names(version) | {"SHA256SUMS", "SHA256SUMS.sig"}
    if {asset["name"] for asset in release["assets"]} != expected:
        raise ValueError("Draft has missing or unexpected assets")
    with tempfile.TemporaryDirectory(prefix="flock-release-download-") as temporary:
        run(["gh", "release", "download", tag, "--repo", REPOSITORY, "--dir", temporary])
        verify_artifacts(temporary, version, commit, public_key)
        for name in expected:
            if digest(Path(temporary) / name) != digest(artifacts / name):
                raise ValueError(f"Downloaded draft differs from the local verified artifact: {name}")
    if args.command == "publish":
        checked_source(commit, version)
        run(["gh", "release", "edit", tag, "--repo", REPOSITORY, "--draft=false", "--latest"])
        print(f"Published verified {tag}. Website updater deployment remains separate; see docs/RELEASING.md.")
    else:
        print(f"Draft {tag} uploaded and downloaded artifacts verified. Run publish only when ready.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    build_parser = subcommands.add_parser("build", help="Test and package a clean tagged commit without publishing")
    build_parser.add_argument("version")
    build_parser.add_argument("--notes", required=True)
    build_parser.add_argument("--output", required=True)
    for command in ("draft", "publish"):
        item = subcommands.add_parser(command, help="Verify all artifacts before changing a GitHub release")
        item.add_argument("version")
        item.add_argument("--artifacts", required=True)
    args = parser.parse_args()
    if any(os.environ.get(key) for key in ("SKIP_SMOKE", "ALLOW_GENERATED_NOTES", "ALLOW_INTERNAL_NOTES")):
        parser.error("Legacy production bypass variables are not supported")
    try:
        (build if args.command == "build" else publish)(args)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        # Never print a command/environment containing signing credentials.
        print(f"Release stopped: {error if not isinstance(error, subprocess.CalledProcessError) else 'required command failed'}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
