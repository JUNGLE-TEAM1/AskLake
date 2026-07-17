from __future__ import annotations

from copy import deepcopy
import unittest

from scripts.refactor_audit.stacked_pr_merge_plan import validate_plan


def entry(order: int, issue: int, pull_request: int | None, dependency: int | None) -> dict[str, object]:
    return {
        "order": order,
        "issue": issue,
        "pullRequest": pull_request,
        "branch": f"refactor-#{issue}",
        "base": "dev",
        "dependsOnPullRequest": dependency,
        "declaredReviewState": "pending-pr" if pull_request is None else "draft",
        "scope": f"scope-{order}",
    }


def valid_plan() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "targetBranch": "dev",
        "expectedPullRequestCount": 3,
        "mergeMode": "strict-sequential",
        "productionExecution": "blocked-pending-manual-evidence",
        "mergeRules": {
            "deployDuringMerge": False,
            "mergeOneAtATime": True,
            "requireGreenChecks": True,
            "requireReviewApproval": True,
            "revalidateNextDiffAfterMerge": True,
        },
        "pullRequests": [
            entry(1, 101, 201, None),
            entry(2, 102, 202, 201),
            entry(3, 103, None, 202),
        ],
    }


class StackedPullRequestMergePlanTests(unittest.TestCase):
    def test_accepts_strict_stack_with_one_pending_final_pr(self) -> None:
        errors, merge_order, pending = validate_plan(valid_plan())

        self.assertEqual(errors, [])
        self.assertEqual(merge_order, [201, 202])
        self.assertEqual(pending, 1)

    def test_accepts_complete_stack_without_pending_pr(self) -> None:
        plan = valid_plan()
        plan["pullRequests"][2]["pullRequest"] = 203  # type: ignore[index]
        plan["pullRequests"][2]["declaredReviewState"] = "draft"  # type: ignore[index]

        errors, merge_order, pending = validate_plan(plan)

        self.assertEqual(errors, [])
        self.assertEqual(merge_order, [201, 202, 203])
        self.assertEqual(pending, 0)

    def test_rejects_count_and_order_drift(self) -> None:
        plan = valid_plan()
        plan["expectedPullRequestCount"] = 4
        plan["pullRequests"][1]["order"] = 3  # type: ignore[index]

        errors, _, _ = validate_plan(plan)

        self.assertTrue(any("exactly 4" in error for error in errors))
        self.assertTrue(any("contiguous" in error for error in errors))

    def test_rejects_branch_base_and_dependency_drift(self) -> None:
        plan = valid_plan()
        plan["pullRequests"][1]["branch"] = "refactor-#999"  # type: ignore[index]
        plan["pullRequests"][1]["base"] = "main"  # type: ignore[index]
        plan["pullRequests"][1]["dependsOnPullRequest"] = None  # type: ignore[index]

        errors, _, _ = validate_plan(plan)

        self.assertTrue(any("branch must match" in error for error in errors))
        self.assertTrue(any("base must match" in error for error in errors))
        self.assertTrue(any("dependsOnPullRequest" in error for error in errors))

    def test_rejects_pending_pr_before_the_final_entry(self) -> None:
        plan = valid_plan()
        plan["pullRequests"][1]["pullRequest"] = None  # type: ignore[index]
        plan["pullRequests"][1]["declaredReviewState"] = "pending-pr"  # type: ignore[index]

        errors, _, pending = validate_plan(plan)

        self.assertTrue(any("pending only for the final PR" in error for error in errors))
        self.assertEqual(pending, 2)

    def test_rejects_merge_or_production_safety_relaxation(self) -> None:
        plan = deepcopy(valid_plan())
        plan["mergeRules"]["deployDuringMerge"] = True  # type: ignore[index]
        plan["mergeRules"]["requireGreenChecks"] = False  # type: ignore[index]
        plan["productionExecution"] = "allowed"

        errors, _, _ = validate_plan(plan)

        self.assertTrue(any("deployDuringMerge" in error for error in errors))
        self.assertTrue(any("requireGreenChecks" in error for error in errors))
        self.assertTrue(any("productionExecution" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
