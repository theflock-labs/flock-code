"""Release integrity primitives. No network, publication or signing secrets."""
import base64
import hashlib
import json
import os
import plistlib
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path, PurePosixPath


def digest(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def validate_version(version):
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise ValueError("Version must be an explicit X.Y.Z release version")
    return version


def payload_names(version):
    validate_version(version)
    return {
        f"flock_{version}_aarch64.dmg", f"flock_{version}.app.tar.gz",
        f"flock_{version}.app.tar.gz.sig", "latest.json", "RELEASE_NOTES.md",
        "bom.cdx.json", "provenance.json",
    }


def write_checksums(directory, version):
    directory = Path(directory)
    lines = [f"{digest(directory / name)}  {name}\n" for name in sorted(payload_names(version))]
    (directory / "SHA256SUMS").write_text("".join(lines))


def verify_checksums(directory, version):
    directory = Path(directory)
    expected = payload_names(version)
    actual = {path.name for path in directory.iterdir()}
    if actual != expected | {"SHA256SUMS", "SHA256SUMS.sig"}:
        raise ValueError("Release directory has missing or unexpected artifacts")
    found = set()
    for line in (directory / "SHA256SUMS").read_text().splitlines():
        match = re.fullmatch(r"([a-f0-9]{64})  ([A-Za-z0-9_.-]+)", line)
        if not match:
            raise ValueError("Invalid checksum entry")
        checksum, name = match.groups()
        if name not in expected or name in found or (directory / name).is_symlink():
            raise ValueError("Unexpected, duplicate or symlink checksum entry")
        if digest(directory / name) != checksum:
            raise ValueError(f"Artifact checksum mismatch: {name}")
        found.add(name)
    if found != expected:
        raise ValueError("Checksum manifest omits release artifacts")


def verify_signature(payload, encoded_signature, encoded_public_key):
    # Tauri wraps the complete minisign public key/signature text in base64.
    # minisign verifies both the payload and its authenticated trusted comment.
    with tempfile.TemporaryDirectory(prefix="flock-signature-") as temporary:
        public_key = Path(temporary) / "public.key"
        signature = Path(temporary) / "payload.sig"
        public_key.write_bytes(base64.b64decode(encoded_public_key.strip(), validate=True))
        signature.write_bytes(base64.b64decode(encoded_signature.strip(), validate=True))
        subprocess.run(["minisign", "-Vm", str(payload), "-p", str(public_key),
                        "-x", str(signature)], check=True, capture_output=True,
                       env={key: value for key, value in os.environ.items()
                            if key in {"HOME", "PATH", "LANG", "LC_ALL", "TMPDIR"}})


def verify_updater(directory, version, public_key):
    directory = Path(directory)
    archive = directory / f"flock_{version}.app.tar.gz"
    signature = (directory / f"{archive.name}.sig").read_text().strip()
    verify_signature(archive, signature, public_key)
    manifest = json.loads((directory / "latest.json").read_text())
    expected = {"darwin-aarch64": {
        "signature": signature,
        "url": f"https://theflock.sh/updates/{archive.name}",
    }}
    if manifest.get("version") != version or manifest.get("platforms") != expected:
        raise ValueError("Updater manifest does not describe the verified payload")
    return inspect_archive(archive, version)


def inspect_archive(archive, version):
    """Validate the complete archive without extracting untrusted paths."""
    required = {
        "flock.app/Contents/Info.plist",
        "flock.app/Contents/MacOS/flock-desktop",
        "flock.app/Contents/MacOS/flock-mcp",
    }
    content = {}
    seen = set()
    symlinks = {}
    hardlinks = {}
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle:
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or not name.parts or name.parts[0] != "flock.app":
                raise ValueError("Unsafe updater archive path")
            normalized = str(name)
            if normalized in seen:
                raise ValueError("Duplicate updater archive entry")
            seen.add(normalized)
            if member.isdev() or member.isfifo():
                raise ValueError("Special file in updater archive")
            if member.issym() or member.islnk():
                target = PurePosixPath(member.linkname)
                parts = list(name.parent.parts if member.issym() else ())
                if target.is_absolute():
                    raise ValueError("Absolute link in updater archive")
                for part in target.parts:
                    if part == "..":
                        if len(parts) <= 1:
                            raise ValueError("Link escapes updater bundle")
                        parts.pop()
                    elif part != ".":
                        parts.append(part)
                if not parts or parts[0] != "flock.app":
                    raise ValueError("Link escapes updater bundle")
                if member.issym():
                    symlinks[normalized] = member.linkname
                    content[normalized] = "symlink:" + member.linkname
                else:
                    hardlinks[normalized] = member.linkname
            if normalized in required:
                if not member.isfile():
                    raise ValueError("Required updater entry is not a regular file")
            if member.isfile() or member.islnk():
                handle = bundle.extractfile(member)
                if normalized == "flock.app/Contents/Info.plist":
                    if member.size > 1024 * 1024:
                        raise ValueError("Unexpectedly large application plist")
                    data = handle.read()
                    info = plistlib.loads(data)
                    if info.get("CFBundleShortVersionString") != version or info.get("CFBundleIdentifier") != "app.flock.desktop":
                        raise ValueError("Updater bundle identity/version mismatch")
                    content[normalized] = hashlib.sha256(data).hexdigest()
                else:
                    content[normalized] = hashlib.file_digest(handle, "sha256").hexdigest()
    if not required <= set(content):
        raise ValueError("Updater archive is missing the app or its fresh sidecar")
    # Lexical '..' checks alone are insufficient: a -> '.' followed by a link
    # to a/../outside resolves outside the app despite looking lexically safe.
    # Resolve the complete link graph, independently of archive entry order.
    for name in seen:
        if any(str(parent) in symlinks for parent in PurePosixPath(name).parents):
            raise ValueError("Archive entry traverses a symlink parent")

    def resolve(parts):
        pending, resolved, expansions = list(parts), [], 0
        while pending:
            part = pending.pop(0)
            if part == ".":
                continue
            if part == "..":
                if len(resolved) <= 1:
                    raise ValueError("Link graph escapes updater bundle")
                resolved.pop()
                continue
            resolved.append(part)
            if not resolved or resolved[0] != "flock.app":
                raise ValueError("Link graph escapes updater bundle")
            name = "/".join(resolved)
            if name in symlinks:
                expansions += 1
                if expansions > 40:
                    raise ValueError("Cyclic or excessively deep updater links")
                resolved.pop()
                pending = list(PurePosixPath(symlinks[name]).parts) + pending
        return resolved

    for name, target in symlinks.items():
        resolve(list(PurePosixPath(name).parent.parts) + list(PurePosixPath(target).parts))
    for target in hardlinks.values():
        resolve(PurePosixPath(target).parts)
    return content
