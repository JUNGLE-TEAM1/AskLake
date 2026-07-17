import json
import re
from dataclasses import dataclass
from typing import Mapping


EKS_MVP_FIXTURE_SLOTS_ENV = "ASKLAKE_EKS_MVP_FIXTURE_SLOTS_JSON"
EKS_MVP_FIXTURE_CONSUMER_GROUP = "asklake-eks-mvp-spark-v1"
EKS_MVP_FIXTURE_ICEBERG_TABLE = "eks_mvp_fixture"
EKS_MVP_FIXTURE_MAX_SLOTS = 5

_CONSUMER_GROUP_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,254}")
_ICEBERG_TABLE_PATTERN = re.compile(r"[a-z][a-z0-9_]{0,62}")


class EksFixtureSlotConfigurationError(ValueError):
    pass


@dataclass(frozen=True)
class EksFixtureSlot:
    consumer_group: str
    iceberg_table: str


DEFAULT_EKS_MVP_FIXTURE_SLOT = EksFixtureSlot(
    consumer_group=EKS_MVP_FIXTURE_CONSUMER_GROUP,
    iceberg_table=EKS_MVP_FIXTURE_ICEBERG_TABLE,
)


def load_eks_fixture_slots(
    environment: Mapping[str, str] | None = None,
) -> tuple[EksFixtureSlot, ...]:
    raw = str((environment or {}).get(EKS_MVP_FIXTURE_SLOTS_ENV) or "").strip()
    if not raw:
        return (DEFAULT_EKS_MVP_FIXTURE_SLOT,)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise EksFixtureSlotConfigurationError(
            f"{EKS_MVP_FIXTURE_SLOTS_ENV} must be valid JSON"
        ) from exc
    if not isinstance(payload, list) or not 1 <= len(payload) <= EKS_MVP_FIXTURE_MAX_SLOTS:
        raise EksFixtureSlotConfigurationError(
            f"{EKS_MVP_FIXTURE_SLOTS_ENV} must contain between 1 and "
            f"{EKS_MVP_FIXTURE_MAX_SLOTS} slots"
        )

    slots: list[EksFixtureSlot] = []
    consumer_groups: set[str] = set()
    iceberg_tables: set[str] = set()
    for index, item in enumerate(payload):
        if not isinstance(item, dict) or set(item) != {"consumerGroup", "table"}:
            raise EksFixtureSlotConfigurationError(
                f"{EKS_MVP_FIXTURE_SLOTS_ENV}[{index}] must contain only consumerGroup and table"
            )
        consumer_group = str(item.get("consumerGroup") or "").strip()
        iceberg_table = str(item.get("table") or "").strip()
        if _CONSUMER_GROUP_PATTERN.fullmatch(consumer_group) is None:
            raise EksFixtureSlotConfigurationError(
                f"{EKS_MVP_FIXTURE_SLOTS_ENV}[{index}].consumerGroup is invalid"
            )
        if _ICEBERG_TABLE_PATTERN.fullmatch(iceberg_table) is None:
            raise EksFixtureSlotConfigurationError(
                f"{EKS_MVP_FIXTURE_SLOTS_ENV}[{index}].table is invalid"
            )
        if consumer_group in consumer_groups:
            raise EksFixtureSlotConfigurationError(
                f"{EKS_MVP_FIXTURE_SLOTS_ENV} contains a duplicate consumerGroup"
            )
        if iceberg_table in iceberg_tables:
            raise EksFixtureSlotConfigurationError(
                f"{EKS_MVP_FIXTURE_SLOTS_ENV} contains a duplicate table"
            )
        consumer_groups.add(consumer_group)
        iceberg_tables.add(iceberg_table)
        slots.append(
            EksFixtureSlot(
                consumer_group=consumer_group,
                iceberg_table=iceberg_table,
            )
        )

    if DEFAULT_EKS_MVP_FIXTURE_SLOT not in slots:
        raise EksFixtureSlotConfigurationError(
            f"{EKS_MVP_FIXTURE_SLOTS_ENV} must preserve the default fixture slot"
        )
    return tuple(slots)


def fixture_slot_for_consumer_group(
    consumer_group: str,
    environment: Mapping[str, str] | None = None,
) -> EksFixtureSlot | None:
    normalized = str(consumer_group or "").strip()
    return next(
        (
            slot
            for slot in load_eks_fixture_slots(environment)
            if slot.consumer_group == normalized
        ),
        None,
    )


def serialize_eks_fixture_slots(slots: tuple[EksFixtureSlot, ...]) -> str:
    return json.dumps(
        [
            {
                "consumerGroup": slot.consumer_group,
                "table": slot.iceberg_table,
            }
            for slot in slots
        ],
        separators=(",", ":"),
        sort_keys=True,
    )
