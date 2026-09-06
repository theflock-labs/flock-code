#!/usr/bin/env python3
"""Audit every lockfile; accept only exact, unexpired, reviewed Rust exceptions."""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
AUDIT_VERSION = "0.22.2"


def run(args: list[str], cwd: Path = ROOT) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=False)


def checked_json(result: subprocess.CompletedProcess[str], label: str) -> dict:
    if result.returncode not in (0, 1):
        raise RuntimeError(f"{label} failed: {result.stderr.strip()}")
    try:
        report = json.loads(result.stdout)
    except ValueError as exc:
        raise RuntimeError(f"{label} did not return a valid report") from exc
    if not isinstance(report, dict) or report.get("error"):
        raise RuntimeError(f"{label} returned an error: {report.get('error') if isinstance(report, dict) else report}")
    return report


def rust_findings(report: dict) -> list[dict]:
    if "vulnerabilities" not in report or "warnings" not in report:
        raise ValueError("Incomplete cargo-audit report")
    findings = []
    categories = [("vulnerability", report["vulnerabilities"]["list"]), *report["warnings"].items()]
    for kind, entries in categories:
        for entry in entries:
            advisory = entry.get("advisory") or {}
            package = entry["package"]
            findings.append({"id": advisory.get("id", kind), "package": package["name"],
                             "version": package["version"], "kind": kind,
                             "title": advisory.get("title", kind)})
    return findings


def evaluate(findings: list[dict], policy: dict, active: set[tuple[str, str]],
             today: dt.date) -> tuple[list[str], list[str]]:
    """Fail closed on expiry, malformed policy, scope drift, or new advisories."""
    exceptions = {}
    errors, accepted = [], []
    for item in policy["exceptions"]:
        key = (item["id"], item["package"], item["version"])
        if key in exceptions:
            errors.append(f"Duplicate dependency exception: {key}")
        if any(not item.get(field) for field in ("owner", "reason", "action", "expires")):
            errors.append(f"Incomplete dependency exception: {key}")
        if dt.date.fromisoformat(item["expires"]) <= today:
            errors.append(f"Expired dependency exception: {key}")
        if item["scope"] not in ("not-in-release", "upstream-unmaintained"):
            errors.append(f"Invalid exception scope: {key}")
        if item["scope"] == "not-in-release" and (item["package"], item["version"]) in active:
            errors.append(f"Excluded dependency is now in the release graph: {key}")
        exceptions[key] = item
    observed = set()
    for finding in findings:
        key = (finding["id"], finding["package"], finding["version"])
        observed.add(key)
        item = exceptions.get(key)
        if item is None:
            errors.append(f"Unreviewed {finding['kind']}: {' / '.join(key)} — {finding['title']}")
        elif item["scope"] == "upstream-unmaintained" and finding["kind"] != "unmaintained":
            errors.append(f"Maintenance exception cannot waive a vulnerability: {key}")
        else:
            accepted.append(f"{' / '.join(key)} (expires {item['expires']}; {item['scope']})")
    for key in exceptions.keys() - observed:
        errors.append(f"Remove stale dependency exception: {key}")
    return errors, accepted


def main() -> int:
    errors = []
    for directory in ("apps/flock-desktop", "services/presence-auth"):
        report = checked_json(run(["npm", "audit", "--json"], ROOT / directory), f"npm audit {directory}")
        counts = report.get("metadata", {}).get("vulnerabilities")
        if not isinstance(counts, dict) or "total" not in counts:
            raise ValueError(f"Incomplete npm audit report for {directory}")
        if counts["total"]:
            errors.append(f"{directory}: npm audit found {counts['total']} vulnerabilities")
        else:
            print(f"{directory}: npm audit clean")

    version = run(["cargo", "audit", "--version"])
    if version.returncode:
        install = subprocess.run(["cargo", "install", "cargo-audit", "--locked", "--version", AUDIT_VERSION], cwd=ROOT)
        if install.returncode:
            raise RuntimeError("Unable to install the pinned cargo-audit tool")
        version = run(["cargo", "audit", "--version"])
    # cargo 1.92 passes the subcommand name through; cargo-audit's clap banner
    # consequently repeats '-audit'. Both banners name the same pinned binary.
    if version.returncode or version.stdout.strip() not in (f"cargo-audit {AUDIT_VERSION}", f"cargo-audit-audit {AUDIT_VERSION}"):
        raise RuntimeError(f"Expected cargo-audit {AUDIT_VERSION}; install it with cargo install cargo-audit --locked --version {AUDIT_VERSION} --force")
    policy = json.loads((ROOT / "security/dependency-exceptions.json").read_text())
    active = set()
    for target in policy["release_targets"]:
        tree = run(["cargo", "tree", "--locked", "--workspace", "--target", target, "--prefix", "none", "--format", "{p}"])
        if tree.returncode:
            raise RuntimeError(f"Unable to resolve release dependencies: {tree.stderr}")
        active.update(re.findall(r"^([A-Za-z0-9_-]+) v([^\s]+)", tree.stdout, flags=re.MULTILINE))
    report = checked_json(run(["cargo", "audit", "--json"]), "cargo audit")
    failures, exceptions = evaluate(rust_findings(report), policy, active, dt.date.today())
    errors.extend(failures)
    for exception in exceptions:
        print(f"Reviewed exception: {exception}")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"Dependency gate passed; {len(exceptions)} explicit Rust exceptions remain.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        print(f"Dependency audit failed: {error}", file=sys.stderr)
        sys.exit(1)
