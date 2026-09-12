import copy
import io
import json
import os
import plistlib
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import release_artifacts as artifacts
import release_pipeline as pipeline


class ReleaseIntegrityTests(unittest.TestCase):
    version = "1.2.3"

    def archive(self, path, *, version="1.2.3", sidecar=True, extra=None):
        with tarfile.open(path, "w:gz") as archive:
            files = {
                "flock.app/Contents/Info.plist": plistlib.dumps({
                    "CFBundleShortVersionString": version,
                    "CFBundleIdentifier": "app.flock.desktop",
                }),
                "flock.app/Contents/MacOS/flock-desktop": b"application fixture",
            }
            if sidecar:
                files["flock.app/Contents/MacOS/flock-mcp"] = b"sidecar fixture"
            for name, contents in files.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(contents)
                archive.addfile(entry, io.BytesIO(contents))
            if extra:
                archive.addfile(extra)

    def test_archive_requires_matching_version_and_sidecar(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "app.tar.gz"
            self.archive(archive)
            self.assertEqual(len(artifacts.inspect_archive(archive, self.version)), 3)
            self.archive(archive, version="1.2.2")
            with self.assertRaisesRegex(ValueError, "version mismatch"):
                artifacts.inspect_archive(archive, self.version)
            self.archive(archive, sidecar=False)
            with self.assertRaisesRegex(ValueError, "sidecar"):
                artifacts.inspect_archive(archive, self.version)

    def test_archive_rejects_traversal_links_duplicates_and_devices(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "app.tar.gz"
            entries = [tarfile.TarInfo("flock.app/../../escape"),
                       tarfile.TarInfo("flock.app/Contents/MacOS/flock-mcp")]
            link = tarfile.TarInfo("flock.app/escape")
            link.type = tarfile.SYMTYPE
            link.linkname = "../../outside"
            entries.append(link)
            device = tarfile.TarInfo("flock.app/device")
            device.type = tarfile.CHRTYPE
            entries.append(device)
            for entry in entries:
                with self.subTest(entry=entry.name):
                    self.archive(archive, extra=entry)
                    with self.assertRaises(ValueError):
                        artifacts.inspect_archive(archive, self.version)

    def test_checksums_reject_tampering_omissions_and_unexpected_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for name in artifacts.payload_names(self.version):
                (directory / name).write_bytes(b"fixture")
            (directory / "SHA256SUMS.sig").write_text("signature fixture")
            artifacts.write_checksums(directory, self.version)
            artifacts.verify_checksums(directory, self.version)
            (directory / "latest.json").write_text("tampered")
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                artifacts.verify_checksums(directory, self.version)
            artifacts.write_checksums(directory, self.version)
            checksum_file = directory / "SHA256SUMS"
            original = checksum_file.read_text()
            checksum_file.write_text("\n".join(original.splitlines()[1:]) + "\n")
            with self.assertRaisesRegex(ValueError, "omits"):
                artifacts.verify_checksums(directory, self.version)
            checksum_file.write_text(original)
            (directory / "unverified.dmg").write_bytes(b"unexpected")
            with self.assertRaisesRegex(ValueError, "unexpected"):
                artifacts.verify_checksums(directory, self.version)

    def test_checksums_reject_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for name in artifacts.payload_names(self.version):
                (directory / name).write_bytes(b"fixture")
            (directory / "SHA256SUMS.sig").write_text("signature fixture")
            artifacts.write_checksums(directory, self.version)
            (directory / "RELEASE_NOTES.md").unlink()
            (directory / "RELEASE_NOTES.md").symlink_to("latest.json")
            with self.assertRaisesRegex(ValueError, "symlink"):
                artifacts.verify_checksums(directory, self.version)

    def test_updater_manifest_cannot_reference_another_payload(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.archive(directory / "flock_1.2.3.app.tar.gz")
            (directory / "flock_1.2.3.app.tar.gz.sig").write_text("signed fixture")
            manifest = {"version": self.version, "platforms": {"darwin-aarch64": {
                "signature": "signed fixture", "url": "https://theflock.sh/updates/flock_1.2.3.app.tar.gz"}}}
            (directory / "latest.json").write_text(json.dumps(manifest))
            with patch.object(artifacts, "verify_signature"):
                artifacts.verify_updater(directory, self.version, "public fixture")
                manifest["platforms"]["darwin-aarch64"]["url"] = "https://example.com/old.tar.gz"
                (directory / "latest.json").write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, "verified payload"):
                    artifacts.verify_updater(directory, self.version, "public fixture")

    def test_smoke_runs_verified_extracted_updater_and_cleans_up_on_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "app.tar.gz"
            self.archive(archive)
            Path(str(archive) + ".sig").write_text("signature fixture")
            script = Path("/fixture/smoke.sh")
            environment = {"PATH": "/usr/bin"}
            for fail in (False, True):
                with self.subTest(fail=fail):
                    events = []
                    staged = []

                    def signature(payload, signature, key):
                        self.assertEqual((payload, signature, key),
                                         (archive, "signature fixture", "public fixture"))
                        events.append("signature")

                    def macos(app, team):
                        self.assertEqual(team, "TEAM")
                        self.assertEqual((app / "Contents/MacOS/flock-desktop").read_bytes(),
                                         b"application fixture")
                        self.assertEqual((app / "Contents/MacOS/flock-mcp").read_bytes(),
                                         b"sidecar fixture")
                        staged.append(app)
                        events.append("macos")

                    def smoke(args, *, cwd, env):
                        self.assertEqual(args, [script, staged[0]])
                        self.assertEqual(cwd, staged[0].parent)
                        self.assertNotEqual(cwd, archive.parent)
                        self.assertIs(env, environment)
                        events.append("smoke")
                        if fail:
                            raise subprocess.CalledProcessError(23, args)

                    with patch.object(pipeline, "verify_signature", side_effect=signature), \
                            patch.object(pipeline, "verify_macos", side_effect=macos), \
                            patch.object(pipeline, "run", side_effect=smoke):
                        if fail:
                            with self.assertRaises(subprocess.CalledProcessError) as caught:
                                pipeline.smoke_updater(archive, self.version, "public fixture",
                                                       "TEAM", script, environment)
                            self.assertEqual(caught.exception.returncode, 23)
                        else:
                            pipeline.smoke_updater(archive, self.version, "public fixture",
                                                   "TEAM", script, environment)
                    self.assertEqual(events, ["signature", "macos", "smoke"])
                    self.assertFalse(staged[0].parent.exists())

    def test_smoke_rejects_bad_signature_or_unsafe_archive_before_launch(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "app.tar.gz"
            self.archive(archive)
            Path(str(archive) + ".sig").write_text("signature fixture")
            with patch.object(pipeline, "verify_signature", side_effect=ValueError("bad signature")), \
                    patch.object(pipeline, "verify_macos") as macos, patch.object(pipeline, "run") as run:
                with self.assertRaisesRegex(ValueError, "bad signature"):
                    pipeline.smoke_updater(archive, self.version, "key", "TEAM", "smoke", {})
                macos.assert_not_called()
                run.assert_not_called()
            self.archive(archive, extra=tarfile.TarInfo("flock.app/../../escape"))
            with patch.object(pipeline, "verify_signature"), \
                    patch.object(pipeline, "verify_macos") as macos, patch.object(pipeline, "run") as run:
                with self.assertRaisesRegex(ValueError, "Unsafe updater archive path"):
                    pipeline.smoke_updater(archive, self.version, "key", "TEAM", "smoke", {})
                macos.assert_not_called()
                run.assert_not_called()

    def test_signing_credentials_are_absent_during_compilation(self):
        environment = {"HOME": "/fixture", "PATH": "/usr/bin", "GH_TOKEN": "secret",
                       "TAURI_SIGNING_PRIVATE_KEY": "secret", "APPLE_PASSWORD": "secret",
                       "SUPABASE_SERVICE_ROLE_KEY": "secret", "VITE_SUPABASE_URL": "https://public.example"}
        with patch.dict(os.environ, environment, clear=True), patch.object(pipeline, "run", return_value="123"):
            actual = pipeline.build_environment("commit")
        self.assertNotIn("secret", actual.values())
        self.assertEqual(actual["VITE_SUPABASE_URL"], "https://public.example")
        self.assertEqual(actual["SOURCE_DATE_EPOCH"], "123")

    def test_macos_tools_accept_command_line_tools_and_reject_missing_tools(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "CommandLineTools"
            sdk = root / "SDKs/MacOSX.sdk"
            sdk.mkdir(parents=True)
            paths = {}
            for name in ("clang", "notarytool", "stapler"):
                path = root / "usr/bin" / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("#!/bin/sh\nexit 0\n")
                path.chmod(0o700)
                paths[name] = path

            def resolve(args, **_kwargs):
                if args == ["xcrun", "--sdk", "macosx", "--show-sdk-path"]:
                    return str(sdk)
                self.assertEqual(args[:2], ["xcrun", "--find"])
                return str(paths[args[2]])

            with patch.object(pipeline, "run", side_effect=resolve):
                pipeline.verify_macos_tools()
                paths["notarytool"].chmod(0o600)
                with self.assertRaisesRegex(ValueError, "notarytool"):
                    pipeline.verify_macos_tools()
                paths["notarytool"].chmod(0o700)
                paths["stapler"].unlink()
                with self.assertRaisesRegex(ValueError, "stapler"):
                    pipeline.verify_macos_tools()
                sdk.rmdir()
                with self.assertRaisesRegex(ValueError, "SDK"):
                    pipeline.verify_macos_tools()

    @patch.object(pipeline, "protected_repository")
    def test_publication_requires_matching_remote_tag_and_latest_ci(self, _protected):
        commit = "a" * 40
        good_run = {"head_sha": commit, "head_branch": "master", "status": "completed",
                    "conclusion": "success", "html_url": "https://github.com/fixture/actions/runs/1"}
        responses = [{"object": {"type": "commit", "sha": commit}}, {"status": "identical"},
                     {"workflow_runs": [good_run]}]
        with patch.object(pipeline, "github", side_effect=responses):
            self.assertEqual(pipeline.checked_source(commit, self.version), good_run["html_url"])
        with patch.object(pipeline, "github", return_value={"object": {"type": "commit", "sha": "b" * 40}}):
            with self.assertRaisesRegex(ValueError, "does not match"):
                pipeline.checked_source(commit, self.version)
        failed_run = dict(good_run, conclusion="failure")
        responses[-1] = {"workflow_runs": [failed_run, good_run]}
        with patch.object(pipeline, "github", side_effect=responses):
            with self.assertRaisesRegex(ValueError, "has not passed"):
                pipeline.checked_source(commit, self.version)

    def test_versions_reject_options_paths_and_nonrelease_labels(self):
        for version in ("--draft", "../1.2.3", "1.2.3-beta.1", "01.2.3", "1.2", "1.2.3\n"):
            with self.subTest(version=version), self.assertRaises(ValueError):
                artifacts.validate_version(version)

    def test_link_graph_rejects_escape_through_another_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "app.tar.gz"
            self.archive(archive)
            # Rewrite the fixture uncompressed to append both links, including
            # the case where the first link is declared after its consumer.
            for order in (False, True):
                self.archive(archive)
                with tarfile.open(archive, "r:gz") as original:
                    entries = [(entry, original.extractfile(entry).read()) for entry in original]
                links = []
                for name, target in (("flock.app/alias", "."), ("flock.app/escape", "alias/../outside")):
                    entry = tarfile.TarInfo(name)
                    entry.type, entry.linkname = tarfile.SYMTYPE, target
                    links.append(entry)
                with tarfile.open(archive, "w:gz") as output:
                    for entry, data in entries:
                        output.addfile(entry, io.BytesIO(data))
                    for entry in links if order else reversed(links):
                        output.addfile(entry)
                with self.assertRaisesRegex(ValueError, "Link graph escapes"):
                    artifacts.inspect_archive(archive, self.version)

    def test_publication_requires_live_single_maintainer_pr_ci_and_immutable_tags(self):
        protection = {
            "enforce_admins": {"enabled": True},
            "required_status_checks": {"strict": True, "checks": [{"context": "CI required", "app_id": 15368}]},
            "required_pull_request_reviews": {"required_approving_review_count": 0,
                "require_code_owner_reviews": False, "dismiss_stale_reviews": False, "require_last_push_approval": False},
            "restrictions": {"users": [{"login": "remiminnebo"}], "teams": [], "apps": []},
            "allow_force_pushes": {"enabled": False}, "allow_deletions": {"enabled": False},
        }
        ruleset = {"target": "tag", "enforcement": "active", "bypass_actors": [],
                   "conditions": {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}},
                   "rules": [{"type": "deletion"}, {"type": "update"}]}
        pipeline.validate_repository_controls(protection, [ruleset])
        with self.assertRaisesRegex(ValueError, "release-tag"):
            pipeline.validate_repository_controls(protection, [])
        unsafe_changes = [
            ("enforce_admins", {"enabled": False}),
            ("required_pull_request_reviews", None),
            ("required_pull_request_reviews", {"required_approving_review_count": 0,
                "bypass_pull_request_allowances": {"users": [{"login": "remiminnebo"}]}}),
            ("required_status_checks", {"strict": False, "checks": [{"context": "CI required", "app_id": 15368}]}),
            ("required_status_checks", {"strict": True, "checks": [{"context": "CI required", "app_id": 123}]}),
            ("required_status_checks", {"strict": True, "checks": []}),
            ("restrictions", None),
            ("restrictions", {"users": [{"login": "another-maintainer"}], "teams": [], "apps": []}),
            ("restrictions", {"users": [{"login": "remiminnebo"}, {"login": "another-maintainer"}]}),
            ("restrictions", {"users": [{"login": "remiminnebo"}], "teams": [{"slug": "developers"}]}),
            ("restrictions", {"users": [{"login": "remiminnebo"}], "apps": [{"slug": "release-bot"}]}),
            ("allow_force_pushes", {"enabled": True}),
            ("allow_deletions", {"enabled": True}),
        ]
        for key, value in unsafe_changes:
            with self.subTest(key=key, value=value):
                unsafe = copy.deepcopy(protection)
                unsafe[key] = value
                with self.assertRaisesRegex(ValueError, "master PR/CI"):
                    pipeline.validate_repository_controls(unsafe, [ruleset])
        for kind in ("teams", "apps"):
            unsafe = copy.deepcopy(protection)
            unsafe["required_pull_request_reviews"]["bypass_pull_request_allowances"] = {kind: [{"id": 1}]}
            with self.subTest(bypass=kind), self.assertRaisesRegex(ValueError, "master PR/CI"):
                pipeline.validate_repository_controls(unsafe, [ruleset])
        for key, value in (("enforcement", "disabled"), ("bypass_actors", [{"actor_id": 1}]),
                           ("rules", [{"type": "deletion"}])):
            unsafe = copy.deepcopy(ruleset)
            unsafe[key] = value
            with self.subTest(tag=key), self.assertRaisesRegex(ValueError, "release-tag"):
                pipeline.validate_repository_controls(protection, [unsafe])


if __name__ == "__main__":
    unittest.main()
