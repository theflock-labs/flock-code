#!/usr/bin/env bash
# Build, stage a verified draft, or promote it. See docs/RELEASING.md.
# No version bumps, git pushes, website deploys or local app replacement.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 "$REPO_DIR/scripts/release_pipeline.py" "$@"
