#!/usr/bin/env python3
"""Validate the refactor rollout plan without mutating an environment."""

from __future__ import annotations

import argparse
import json
from datetime import date
from pathlib import Path
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PLAN = ROOT / "docs/refactor-2026/final/release-gates.json"


def load_plan(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("release plan must be a JSON object")
    return payload


def validate_plan(plan: Mapping[str, Any], *, execution: bool) -> dict[str, Any]:
    errors: list[str] = []
    blockers: list[str] = []
    if plan.get("schemaVersion") != 1:
        errors.append("schemaVersion must be 1")
    if plan.get("auditVerdict") not in {"guarded-go", "go"}:
        errors.append("auditVerdict must be guarded-go or go")
    if plan.get("residualP0"):
        errors.append("residual P0 risks are not allowed")

    for risk in plan.get("residualP1", []):
        missing = [key for key in ("id", "owner", "mitigation", "dueDate") if not risk.get(key)]
        if missing:
            errors.append(f"P1 risk {risk.get('id', '<missing>')} lacks {', '.join(missing)}")
            continue
        try:
            date.fromisoformat(str(risk["dueDate"]))
        except ValueError:
            errors.append(f"P1 risk {risk['id']} has invalid dueDate")

    gate_ids: set[str] = set()
    for gate in plan.get("gates", []):
        gate_id = str(gate.get("id", ""))
        if not gate_id or gate_id in gate_ids:
            errors.append(f"gate id is missing or duplicated: {gate_id or '<missing>'}")
            continue
        gate_ids.add(gate_id)
        status = gate.get("status")
        if status not in {"passed", "manual-required", "blocked"}:
            errors.append(f"gate {gate_id} has invalid status {status}")
        if not gate.get("evidence"):
            errors.append(f"gate {gate_id} has no evidence")
        if status != "passed" and not gate.get("operatorAction"):
            errors.append(f"gate {gate_id} needs operatorAction")
        if execution and "production" in gate.get("requiredFor", []) and status != "passed":
            blockers.append(gate_id)

    phases = plan.get("rolloutPhases", [])
    expected_order = list(range(1, len(phases) + 1))
    if [phase.get("order") for phase in phases] != expected_order:
        errors.append("rollout phase order must be contiguous from 1")
    for phase in phases:
        phase_id = phase.get("id", "<missing>")
        for key in ("commandTemplate", "stopCondition", "resumeCondition", "rollbackTemplate"):
            if not phase.get(key):
                errors.append(f"rollout phase {phase_id} lacks {key}")

    for trigger in plan.get("rollbackTriggers", []):
        if not trigger.get("metric") or not trigger.get("threshold") or not trigger.get("rollbackTemplate"):
            errors.append("rollback trigger lacks metric, threshold, or rollbackTemplate")
        if int(trigger.get("decisionMinutes", 999)) > 15:
            errors.append(f"rollback trigger {trigger.get('id', '<missing>')} exceeds 15 minute decision bound")

    status = "fail" if errors else "blocked" if blockers else "pass"
    return {
        "blockers": sorted(blockers),
        "errors": sorted(errors),
        "mode": "production-execution" if execution else "plan",
        "status": status,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", default=str(DEFAULT_PLAN))
    parser.add_argument("--execution", action="store_true", help="Fail closed unless every production gate has evidence.")
    args = parser.parse_args()
    path = Path(args.plan).resolve()
    if ROOT not in path.parents:
        raise SystemExit("plan must stay inside the repository")
    result = validate_plan(load_plan(path), execution=args.execution)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if result["status"] == "pass" else 2 if result["status"] == "blocked" else 1


if __name__ == "__main__":
    raise SystemExit(main())
