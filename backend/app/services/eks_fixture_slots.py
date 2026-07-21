import os

from fastapi import status

from app.core.errors import ApiError
from scripts.kafka_fixture_slots import (
    EksFixtureSlot,
    EksFixtureSlotConfigurationError,
    fixture_slot_for_consumer_group,
)


def configured_eks_fixture_slot(
    consumer_group: str,
    *,
    job_id: str | None = None,
) -> EksFixtureSlot | None:
    try:
        return fixture_slot_for_consumer_group(consumer_group, os.environ)
    except EksFixtureSlotConfigurationError as exc:
        raise ApiError(
            "EKS_MVP_FIXTURE_SLOTS_INVALID",
            "The EKS fixture slot configuration is invalid.",
            status.HTTP_503_SERVICE_UNAVAILABLE,
            {
                **({"jobId": job_id} if job_id is not None else {}),
                "reason": str(exc),
            },
        ) from exc
