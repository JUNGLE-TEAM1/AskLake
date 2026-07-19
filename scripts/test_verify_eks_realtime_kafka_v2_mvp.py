from copy import deepcopy
import json
from pathlib import Path
import unittest

from scripts.verify_eks_realtime_kafka_v2_mvp import verify


ROOT = Path(__file__).resolve().parents[1]


class EksRealtimeKafkaV2MvpContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.contract = json.loads(
            (ROOT / "deploy" / "eks-realtime-kafka-v2-mvp.json").read_text(encoding="utf-8")
        )

    def test_repository_contract_passes(self) -> None:
        self.assertEqual(verify(self.contract), [])

    def test_activation_cannot_be_claimed_in_phase0(self) -> None:
        candidate = deepcopy(self.contract)
        candidate["decision"]["activationAllowed"] = True
        self.assertTrue(verify(candidate))

    def test_v1_and_v2_concurrency_cannot_be_removed_from_rollback(self) -> None:
        candidate = deepcopy(self.contract)
        candidate["rollback"]["forbidden"].remove("run-v1-and-v2-for-the-same-identity")
        self.assertTrue(verify(candidate))

    def test_local_state_cannot_be_authoritative(self) -> None:
        candidate = deepcopy(self.contract)
        candidate["topology"]["localFilesystemAuthoritative"] = True
        self.assertTrue(verify(candidate))

    def test_internal_topics_must_be_generation_scoped(self) -> None:
        candidate = deepcopy(self.contract)
        candidate["runtimeIdentity"]["connectInternalTopicTemplates"]["offset"] = "asklake-connect-offset"
        self.assertTrue(verify(candidate))

    def test_production_transfer_gate_cannot_open(self) -> None:
        candidate = deepcopy(self.contract)
        candidate["gates"]["productionTransferAllowed"] = True
        self.assertTrue(verify(candidate))

    def test_iam_cannot_be_claimed_as_applied(self) -> None:
        candidate = deepcopy(self.contract)
        candidate["iam"]["applied"] = True
        candidate["iam"]["appliedPodIdentityAssociationCount"] = 1
        self.assertTrue(verify(candidate))

    def test_restore_cannot_render_a_consumer(self) -> None:
        candidate = deepcopy(self.contract)
        candidate["durableState"]["recoveryModeConsumerResources"] = 1
        self.assertTrue(verify(candidate))

    def test_live_restore_cannot_be_claimed_by_static_contract(self) -> None:
        candidate = deepcopy(self.contract)
        candidate["durableState"]["liveRestoreProven"] = True
        self.assertTrue(verify(candidate))

    def test_preflight_cannot_claim_shared_mutation(self) -> None:
        candidate = deepcopy(self.contract)
        candidate["livePreflight"]["sharedMutationPerformed"] = True
        self.assertTrue(verify(candidate))

    def test_missing_live_prerequisite_cannot_be_claimed_present(self) -> None:
        candidate = deepcopy(self.contract)
        candidate["livePreflight"]["snapshotControllerObserved"] = True
        self.assertTrue(verify(candidate))


if __name__ == "__main__":
    unittest.main()
