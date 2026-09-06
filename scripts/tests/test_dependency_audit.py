import datetime as dt
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("audit_dependencies", Path(__file__).parents[1] / "audit-dependencies.py")
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


class DependencyGateTests(unittest.TestCase):
    def setUp(self):
        self.finding = {"id": "RUSTSEC-2026-0000", "package": "fixture", "version": "1.0.0",
                        "kind": "vulnerability", "title": "fixture vulnerability"}
        self.item = {**self.finding, "scope": "not-in-release", "expires": "2026-12-01",
                     "owner": "maintainer", "reason": "Unused optional dependency", "action": "Upgrade upstream"}
        self.today = dt.date(2026, 9, 5)

    def evaluate(self, findings=None, active=None):
        return audit.evaluate([self.finding] if findings is None else findings,
                              {"exceptions": [self.item]}, active or set(), self.today)[0]

    def test_unused_exact_dependency_exception_can_pass(self):
        self.assertEqual(self.evaluate(), [])

    def test_activating_an_excluded_dependency_fails(self):
        self.assertTrue(self.evaluate(active={("fixture", "1.0.0")}))

    def test_expired_exception_fails(self):
        self.item["expires"] = "2026-09-05"
        self.assertTrue(self.evaluate())

    def test_new_version_is_not_covered(self):
        self.assertTrue(self.evaluate([{**self.finding, "version": "1.0.1"}]))

    def test_maintenance_exception_cannot_hide_vulnerability(self):
        self.item["scope"] = "upstream-unmaintained"
        self.assertTrue(self.evaluate())

    def test_stale_exception_requires_removal(self):
        self.assertTrue(self.evaluate([]))

    def test_incomplete_audit_report_is_rejected(self):
        with self.assertRaises(ValueError):
            audit.rust_findings({})


if __name__ == "__main__":
    unittest.main()
