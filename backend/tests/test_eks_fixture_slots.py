import json
import unittest

from scripts.kafka_fixture_slots import (
    DEFAULT_EKS_MVP_FIXTURE_SLOT,
    EKS_MVP_FIXTURE_SLOTS_ENV,
    EksFixtureSlotConfigurationError,
    fixture_slot_for_consumer_group,
    load_eks_fixture_slots,
    serialize_eks_fixture_slots,
)


class EksFixtureSlotTests(unittest.TestCase):
    def test_missing_configuration_preserves_the_single_day16_slot(self):
        slots = load_eks_fixture_slots({})

        self.assertEqual(slots, (DEFAULT_EKS_MVP_FIXTURE_SLOT,))
        self.assertEqual(
            fixture_slot_for_consumer_group("asklake-eks-mvp-spark-v1", {}),
            DEFAULT_EKS_MVP_FIXTURE_SLOT,
        )

    def test_accepts_four_unique_scale_slots_plus_the_default(self):
        payload = [
            {
                "consumerGroup": "asklake-eks-mvp-spark-v1",
                "table": "eks_mvp_fixture",
            },
            *[
                {
                    "consumerGroup": f"approved-scale-17-{index:02d}",
                    "table": f"eks_mvp_scale_17_{index:02d}",
                }
                for index in range(1, 5)
            ],
        ]

        slots = load_eks_fixture_slots({
            EKS_MVP_FIXTURE_SLOTS_ENV: json.dumps(payload),
        })

        self.assertEqual(len(slots), 5)
        self.assertEqual(
            fixture_slot_for_consumer_group(
                "approved-scale-17-04",
                {EKS_MVP_FIXTURE_SLOTS_ENV: json.dumps(payload)},
            ).iceberg_table,
            "eks_mvp_scale_17_04",
        )
        self.assertEqual(json.loads(serialize_eks_fixture_slots(slots)), payload)

    def test_rejects_invalid_or_overbroad_configuration(self):
        default = {
            "consumerGroup": "asklake-eks-mvp-spark-v1",
            "table": "eks_mvp_fixture",
        }
        cases = (
            "not-json",
            json.dumps({"consumerGroup": "group", "table": "table"}),
            json.dumps([]),
            json.dumps([default] * 6),
            json.dumps([{**default, "prefix": "forbidden"}]),
            json.dumps([{**default, "consumerGroup": "*"}]),
            json.dumps([{**default, "table": "Mixed-Case"}]),
            json.dumps([default, {**default, "consumerGroup": "other"}]),
            json.dumps([default, {**default, "table": "other_table"}]),
            json.dumps([{
                "consumerGroup": "approved-scale-17-01",
                "table": "eks_mvp_scale_17_01",
            }]),
        )
        for raw in cases:
            with self.subTest(raw=raw):
                with self.assertRaises(EksFixtureSlotConfigurationError):
                    load_eks_fixture_slots({EKS_MVP_FIXTURE_SLOTS_ENV: raw})

    def test_unregistered_consumer_group_has_no_slot(self):
        self.assertIsNone(
            fixture_slot_for_consumer_group("unapproved-scale-group", {})
        )


if __name__ == "__main__":
    unittest.main()
