from __future__ import annotations

from copy import deepcopy
import unittest

from scripts.verify_eks_realtime_kafka_mvp import DEFAULT_CONTRACT, ROOT, load_contract, validate_contract


class EksRealtimeKafkaMvpContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.contract = load_contract(DEFAULT_CONTRACT)

    def errors_for(self, contract: dict[str, object]) -> list[str]:
        return validate_contract(contract, root=ROOT)

    def test_repository_contract_is_valid_and_fail_closed(self) -> None:
        self.assertEqual(self.errors_for(self.contract), [])

    def test_rejects_decision_drift_or_activation(self) -> None:
        contract = deepcopy(self.contract)
        contract["decision"]["status"] = "undecided"  # type: ignore[index]
        contract["decision"]["selectedPath"] = "v2-kafka-connect-clickhouse"  # type: ignore[index]
        contract["decision"]["activationAllowed"] = True  # type: ignore[index]
        contract["candidates"][0]["enabled"] = True  # type: ignore[index]

        errors = self.errors_for(contract)

        self.assertIn("decision.status must be decided", errors)
        self.assertIn("selectedPath must be the evidence-backed V1 MVP", errors)
        self.assertIn("path selection must not enable EKS activation", errors)
        self.assertTrue(any("must remain disabled" in error for error in errors))

    def test_rejects_duplicate_or_eks_owner_claim(self) -> None:
        contract = deepcopy(self.contract)
        contract["ownership"]["activeClaims"] = ["ec2-continuous-worker", "eks-continuous-worker"]  # type: ignore[index]
        contract["ownership"]["proposedOwner"] = "v2-kafka-connect-clickhouse"  # type: ignore[index]

        errors = self.errors_for(contract)

        self.assertIn("exactly one EC2 active claim is required before transfer", errors)
        self.assertIn("proposedOwner must be the selected EKS V1 worker", errors)

    def test_rejects_assigned_generation_and_shared_identity(self) -> None:
        contract = deepcopy(self.contract)
        contract["runtimeIdentity"]["generation"] = "g1"  # type: ignore[index]
        contract["runtimeIdentity"]["sharedProductionIdentityAllowed"] = True  # type: ignore[index]

        errors = self.errors_for(contract)

        self.assertIn("generation must be assigned only at approved owner transfer", errors)
        self.assertIn("runtime identity must be isolated from shared production", errors)

    def test_rejects_sanitized_inventory_drift(self) -> None:
        contract = deepcopy(self.contract)
        contract["decisionEvidence"]["continuousSparkApplicationCount"] = 1  # type: ignore[index]

        errors = self.errors_for(contract)

        self.assertIn(
            "decisionEvidence.continuousSparkApplicationCount must equal the sanitized decision observation",
            errors,
        )

    def test_rejects_automatic_rollback_or_missing_checkpoint_guard(self) -> None:
        contract = deepcopy(self.contract)
        contract["rollback"]["automatic"] = True  # type: ignore[index]
        contract["rollback"]["forbidden"].remove("delete-or-rewind-checkpoint-to-force-recovery")  # type: ignore[index,union-attr]

        errors = self.errors_for(contract)

        self.assertIn("rollback must be manual and target the preserved EC2 owner", errors)
        self.assertIn("rollback.forbidden is missing a safety invariant", errors)

    def test_rejects_early_workload_enable_or_broad_msk_action(self) -> None:
        contract = deepcopy(self.contract)
        contract["implementation"]["defaultEnabled"] = True  # type: ignore[index]
        contract["implementation"]["mskIamActions"].append("kafka-cluster:*")  # type: ignore[index,union-attr]

        errors = self.errors_for(contract)

        self.assertIn(
            "implementation.defaultEnabled must match the selected V1 static foundation",
            errors,
        )
        self.assertIn(
            "implementation.mskIamActions must be the exact V1 consumer action set",
            errors,
        )

    def test_rejects_claim_that_live_iam_is_ready(self) -> None:
        contract = deepcopy(self.contract)
        contract["liveReadiness"]["activationReady"] = True  # type: ignore[index]
        contract["liveReadiness"]["sparkRealtimeTopicResourceCount"] = 1  # type: ignore[index]
        contract["liveReadiness"]["sparkRealtimeGroupResourceCount"] = 1  # type: ignore[index]

        errors = self.errors_for(contract)

        self.assertIn(
            "liveReadiness.activationReady must preserve the sanitized fail-closed observation",
            errors,
        )
        self.assertIn(
            "liveReadiness.sparkRealtimeTopicResourceCount must preserve the sanitized fail-closed observation",
            errors,
        )
        self.assertIn(
            "liveReadiness.sparkRealtimeGroupResourceCount must preserve the sanitized fail-closed observation",
            errors,
        )

    def test_rejects_cutover_before_fence_or_production_canary_identity(self) -> None:
        contract = deepcopy(self.contract)
        stages = contract["rolloutPlan"]["orderedStages"]  # type: ignore[index]
        stages[4], stages[5] = stages[5], stages[4]  # type: ignore[index]
        contract["rolloutPlan"]["canary"]["sharedProductionIdentityAllowed"] = True  # type: ignore[index]

        errors = self.errors_for(contract)

        self.assertIn(
            "rolloutPlan.orderedStages must preserve the exact fence-before-activate order",
            errors,
        )
        self.assertIn("rollout canary must not reuse a production identity", errors)

    def test_rejects_nondurable_receipt_or_missing_restart_proof(self) -> None:
        contract = deepcopy(self.contract)
        contract["rolloutPlan"]["receiptAuthority"] = "pod-local-filesystem"  # type: ignore[index]
        contract["rolloutPlan"]["successCriteria"].remove(  # type: ignore[index,union-attr]
            "no-offset-regression-after-restart"
        )

        errors = self.errors_for(contract)

        self.assertIn(
            "rolloutPlan.receiptAuthority must be the private durable runtime prefix",
            errors,
        )
        self.assertIn(
            "rolloutPlan.successCriteria is missing exact-one or durable recovery proof",
            errors,
        )

    def test_rejects_missing_repository_evidence_marker(self) -> None:
        contract = deepcopy(self.contract)
        contract["candidates"][0]["evidence"][0] = "backend/scripts/kafka-continuous-kubernetes.mjs::missing-marker"  # type: ignore[index]

        errors = self.errors_for(contract)

        self.assertTrue(any("marker is missing" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
