from __future__ import annotations

import unittest

from scripts.observe_eks_realtime_kafka_readiness import CONSUMER_ACTIONS, summarize_readiness


def policy(actions: list[str], resources: list[str]) -> dict[str, object]:
    return {"Statement": [{"Effect": "Allow", "Action": actions, "Resource": resources}]}


class ReadinessObservationTests(unittest.TestCase):
    def test_ready_requires_exact_topic_group_runtime_and_associations(self) -> None:
        spark = policy(list(CONSUMER_ACTIONS), [
            "arn:aws:kafka:region:111122223333:cluster/cluster/id",
            "arn:aws:kafka:region:111122223333:topic/cluster/id/asklake.eks-realtime.fixture.g1",
            "arn:aws:kafka:region:111122223333:group/cluster/id/asklake-eks-realtime-v1-g1",
        ])
        runtime_arn = "arn:aws:s3:::output/continuous-runtime/*"
        backend = {"Statement": [
            {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], "Resource": [runtime_arn]},
            {"Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": ["arn:aws:s3:::output"],
             "Condition": {"StringLike": {"s3:prefix": ["continuous-runtime", "continuous-runtime/*"]}}},
        ]}
        report = summarize_readiness(
            spark_associations=1, backend_associations=1,
            spark_documents=[spark], backend_documents=[backend],
            expected_generation="g1", expected_runtime_object_arn=runtime_arn,
        )
        self.assertTrue(report["activationReady"])
        self.assertTrue(report["backendRuntimeListPrefixReady"])
        self.assertEqual(report["blockingReasons"], [])

    def test_current_missing_resources_remain_fail_closed(self) -> None:
        report = summarize_readiness(
            spark_associations=1, backend_associations=1,
            spark_documents=[policy(list(CONSUMER_ACTIONS), ["arn:aws:kafka:region:111122223333:topic/cluster/id/legacy"])],
            backend_documents=[policy(["s3:GetObject"], ["arn:aws:s3:::output/evidence/*"])],
        )
        self.assertFalse(report["activationReady"])
        self.assertEqual(report["sparkRealtimeTopicResourceCount"], 0)
        self.assertEqual(report["sparkRealtimeGroupResourceCount"], 0)
        self.assertEqual(report["backendContinuousRuntimeResourceCount"], 0)

    def test_wildcard_or_duplicate_association_is_blocked(self) -> None:
        report = summarize_readiness(
            spark_associations=2, backend_associations=1,
            spark_documents=[policy(["kafka-cluster:*"], ["*"])],
            backend_documents=[],
        )
        self.assertFalse(report["activationReady"])
        self.assertTrue(report["sparkHasBroadActionOrResource"])
        self.assertIn("Spark Pod Identity association count is not exactly one", report["blockingReasons"])

    def test_mismatched_generation_or_action_resource_is_blocked(self) -> None:
        spark = policy(list(CONSUMER_ACTIONS), [
            "arn:aws:kafka:region:111122223333:topic/cluster/id/asklake.eks-realtime.fixture.g1",
            "arn:aws:kafka:region:111122223333:group/cluster/id/asklake-eks-realtime-v1-g2",
        ])
        report = summarize_readiness(
            spark_associations=1, backend_associations=1,
            spark_documents=[spark], backend_documents=[], expected_generation="g1",
        )
        self.assertFalse(report["sparkRealtimeIdentityActionsReady"])
        self.assertFalse(report["activationReady"])

    def test_cross_cluster_or_wrong_action_resource_is_blocked(self) -> None:
        spark = {"Statement": [
            {"Effect": "Allow", "Action": ["kafka-cluster:Connect"],
             "Resource": ["arn:aws:kafka:region:111122223333:cluster/cluster-a/id-a"]},
            {"Effect": "Allow", "Action": ["kafka-cluster:DescribeTopic"],
             "Resource": ["arn:aws:kafka:region:111122223333:topic/cluster-a/id-a/asklake.eks-realtime.fixture.g1"]},
            {"Effect": "Allow", "Action": ["kafka-cluster:ReadData"],
             "Resource": ["arn:aws:kafka:region:111122223333:group/cluster-b/id-b/asklake-eks-realtime-v1-g1"]},
            {"Effect": "Allow", "Action": ["kafka-cluster:DescribeGroup", "kafka-cluster:AlterGroup"],
             "Resource": ["arn:aws:kafka:region:111122223333:group/cluster-b/id-b/asklake-eks-realtime-v1-g1"]},
        ]}
        report = summarize_readiness(
            spark_associations=1, backend_associations=1,
            spark_documents=[spark], backend_documents=[], expected_generation="g1",
        )
        self.assertFalse(report["sparkRealtimeIdentityActionsReady"])
        self.assertFalse(report["activationReady"])

    def test_explicit_deny_boundary_target_role_and_broad_s3_are_blocked(self) -> None:
        deny = {"Statement": [{"Effect": "Deny", "Action": "kafka-cluster:ReadData", "Resource": "*"}]}
        broad_backend = policy(["s3:GetObject"], ["arn:aws:s3:::*"])
        report = summarize_readiness(
            spark_associations=1, backend_associations=1,
            spark_documents=[deny], backend_documents=[broad_backend],
            spark_permissions_boundary=True, target_role_present=True,
        )
        self.assertTrue(report["relatedExplicitDenyPresent"])
        self.assertTrue(report["permissionsBoundaryPresent"])
        self.assertTrue(report["targetRolePresent"])
        self.assertTrue(report["backendHasBroadActionOrResource"])


if __name__ == "__main__":
    unittest.main()
