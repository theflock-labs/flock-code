"""Exercise the smoke EXIT trap without requiring macOS UI permissions."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "smoke.sh"
CLEANUP = "cleanup() {" + SCRIPT.read_text().split("cleanup() {", 1)[1].split("\ntrap cleanup EXIT", 1)[0]


class SmokeCleanupTests(unittest.TestCase):
    def run_cleanup(self, failures, status):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary) / "profile"
            work.mkdir()
            (work / "late-webkit-write").write_text("fixture")
            # Model a helper that keeps writing during the first removals.
            shell = CLEANUP + """
APP_PID=""
attempts=0
rm() {
  attempts=$((attempts + 1))
  if [ "$attempts" -le "$FAILURES" ]; then return 1; fi
  command rm "$@"
}
sleep() { :; }
trap cleanup EXIT
exit "$STATUS"
"""
            result = subprocess.run(
                ["bash", "-euc", shell], capture_output=True, text=True,
                env={**os.environ, "WORK": str(work), "FAILURES": str(failures), "STATUS": str(status)},
                timeout=10,
            )
            return result, work.exists()

    def test_delayed_writes_do_not_fail_successful_smoke(self):
        result, remains = self.run_cleanup(failures=2, status=0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(remains)

    def test_cleanup_retry_preserves_failed_smoke(self):
        result, remains = self.run_cleanup(failures=2, status=23)
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertFalse(remains)

    def test_persistent_cleanup_failure_still_fails_release(self):
        result, remains = self.run_cleanup(failures=100, status=0)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(remains)
        self.assertIn("could not remove temporary profile", result.stderr)


if __name__ == "__main__":
    unittest.main()
