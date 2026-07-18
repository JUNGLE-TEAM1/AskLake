from dataclasses import dataclass
from typing import Any, Literal


@dataclass(frozen=True)
class TrinoCollectorClaim:
    engine: str
    generation: int
    next_uri: str
    recovered: bool
    run_id: str


@dataclass(frozen=True)
class TrinoSubmissionReservation:
    outcome: Literal["created", "existing", "conflict", "limit"]
    payload: dict[str, Any] | None = None
