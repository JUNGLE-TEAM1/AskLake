#!/usr/bin/env python3
"""Validate the strict merge order for the current refactor PR stack."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PLAN = ROOT / "docs/refactor-2026/final/stacked-pr-merge-plan.json"
ALLOWED_REVIEW_STATES = {"draft", "pending-pr", "ready-for-review"}
REQUIRED_RULES = {
    "deployDuringMerge": False,
    "mergeOneAtATime": True,
    "requireGreenChecks": True,
    "requireReviewApproval": True,
    "revalidateNextDiffAfterMerge": True,
}


def load_plan(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("stacked PR plan must be a JSON object")
    return payload


def _positive_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def validate_plan(plan: Mapping[str, Any]) -> tuple[list[str], list[int], int]:
    errors: list[str] = []
    if plan.get("schemaVersion") != 1:
        errors.append("schemaVersion must be 1")
    target = str(plan.get("targetBranch") or "")
    if target != "dev":
        errors.append("targetBranch must be dev")
    if plan.get("mergeMode") != "strict-sequential":
        errors.append("mergeMode must be strict-sequential")
    if plan.get("productionExecution") != "blocked-pending-manual-evidence":
        errors.append("productionExecution must remain blocked-pending-manual-evidence")

    rules = plan.get("mergeRules")
    if not isinstance(rules, Mapping):
        errors.append("mergeRules must be an object")
    else:
        for key, expected in REQUIRED_RULES.items():
            if rules.get(key) is not expected:
                errors.append(f"mergeRules.{key} must be {str(expected).lower()}")

    expected_count = plan.get("expectedPullRequestCount")
    if not _positive_int(expected_count):
        errors.append("expectedPullRequestCount must be a positive integer")
        expected_count = 0
    entries = plan.get("pullRequests")
    if not isinstance(entries, list):
        errors.append("pullRequests must be a list")
        return sorted(set(errors)), [], 0
    if len(entries) != expected_count:
        errors.append(f"pullRequests must contain exactly {expected_count} entries")
    if [entry.get("order") if isinstance(entry, Mapping) else None for entry in entries] != list(
        range(1, len(entries) + 1)
    ):
        errors.append("pull request order must be contiguous from 1")

    issues: set[int] = set()
    pull_requests: set[int] = set()
    merge_order: list[int] = []
    pending_count = 0
    previous_pull_request: int | None = None
    for index, entry in enumerate(entries):
        field = f"pullRequests[{index}]"
        if not isinstance(entry, Mapping):
            errors.append(f"{field} must be an object")
            continue
        issue = entry.get("issue")
        if not _positive_int(issue):
            errors.append(f"{field}.issue must be a positive integer")
            issue = 0
        elif issue in issues:
            errors.append(f"duplicate issue: {issue}")
        else:
            issues.add(issue)
        if entry.get("branch") != f"refactor-#{issue}":
            errors.append(f"{field}.branch must match refactor-#<issue>")
        if entry.get("base") != target:
            errors.append(f"{field}.base must match targetBranch")
        if not str(entry.get("scope") or "").strip():
            errors.append(f"{field}.scope is required")

        review_state = str(entry.get("declaredReviewState") or "")
        if review_state not in ALLOWED_REVIEW_STATES:
            errors.append(f"{field}.declaredReviewState is unsupported: {review_state or '<missing>'}")
        pull_request = entry.get("pullRequest")
        if pull_request is None:
            pending_count += 1
            if review_state != "pending-pr" or index != len(entries) - 1:
                errors.append(f"{field} may be pending only for the final PR")
        elif not _positive_int(pull_request):
            errors.append(f"{field}.pullRequest must be a positive integer or final pending null")
        else:
            if pull_request in pull_requests:
                errors.append(f"duplicate pull request: {pull_request}")
            pull_requests.add(pull_request)
            merge_order.append(pull_request)
            if review_state == "pending-pr":
                errors.append(f"{field} has a PR number but is still pending-pr")

        expected_dependency = previous_pull_request
        if entry.get("dependsOnPullRequest") != expected_dependency:
            errors.append(
                f"{field}.dependsOnPullRequest must be "
                f"{expected_dependency if expected_dependency is not None else 'null'}"
            )
        if _positive_int(pull_request):
            previous_pull_request = pull_request

    if pending_count > 1:
        errors.append("at most one final PR may be pending")
    return sorted(set(errors)), merge_order, pending_count


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", type=Path, default=DEFAULT_PLAN)
    args = parser.parse_args()
    try:
        plan = load_plan(args.plan)
        errors, merge_order, pending_count = validate_plan(plan)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        errors, merge_order, pending_count = [str(error)], [], 0
    result = {
        "errors": errors,
        "mergeOrder": merge_order,
        "pendingPullRequestCount": pending_count,
        "status": "fail" if errors else "pass",
        "targetBranch": "dev",
    }
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
