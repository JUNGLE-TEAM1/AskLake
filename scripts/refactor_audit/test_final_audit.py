from __future__ import annotations

import unittest

from scripts.refactor_audit.final_audit import build_comparison
from scripts.refactor_audit.release_readiness import validate_plan


class FinalAuditTest(unittest.TestCase):
    def test_comparison_exposes_regression_and_contract_removal(self) -> None:
        metrics = {
            "head": "base",
            "summary": {"files": 1, "loc": 10, "files_over_500_lines": 0, "files_over_1000_lines": 0, "files_over_2000_lines": 0, "files_over_5000_lines": 0},
            "python": {"functions_over_100_lines": 0, "syntax_errors": []},
            "largest_files": [{"file": "backend/app/services/etl_service.py", "loc": 100}],
            "import_graph": {"python_cycles": [], "backend_js_cycles": [], "frontend_cycles": []},
            "term_inventory": {name: {"file_count": 0} for name in ("fallback", "mock", "legacy", "compatibility")},
        }
        current = {**metrics, "head": "current", "summary": {**metrics["summary"], "loc": 12}}
        baseline_contracts = {"api_routes": [{"method": "GET", "path": "/kept"}], "models": {"tables": []}, "frontend": {"route_literals": [], "wizard_flows": []}}
        current_contracts = {"api_routes": [], "models": {"tables": []}, "frontend": {"route_literals": [], "wizard_flows": []}}
        result = build_comparison(metrics, current, baseline_contracts, current_contracts)
        self.assertEqual(result["metrics"]["loc"]["delta"], 2)
        self.assertEqual(result["contracts"]["removed"]["apiRoutes"], ["GET /kept"])
        self.assertFalse(result["hardFacts"]["noRemovedStaticContracts"])

    def test_execution_mode_blocks_manual_production_gate(self) -> None:
        plan = {
            "schemaVersion": 1,
            "auditVerdict": "guarded-go",
            "residualP0": [],
            "residualP1": [{"id": "P1", "owner": "team", "mitigation": "gate", "dueDate": "2026-09-01"}],
            "gates": [{"id": "reboot", "status": "manual-required", "evidence": ["command"], "operatorAction": "run it", "requiredFor": ["production"]}],
            "rolloutPhases": [{"order": 1, "id": "canary", "commandTemplate": "deploy", "stopCondition": "error", "resumeCondition": "healthy", "rollbackTemplate": "rollback"}],
            "rollbackTriggers": [{"id": "errors", "metric": "error", "threshold": "> 0", "decisionMinutes": 10, "rollbackTemplate": "rollback"}],
        }
        self.assertEqual(validate_plan(plan, execution=False)["status"], "pass")
        execution = validate_plan(plan, execution=True)
        self.assertEqual(execution["status"], "blocked")
        self.assertEqual(execution["blockers"], ["reboot"])


if __name__ == "__main__":
    unittest.main()
