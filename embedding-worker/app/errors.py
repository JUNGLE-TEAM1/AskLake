"""Error classes used to distinguish bad RAG input from transient upstream failures."""


class PermanentRagContractError(ValueError):
    """The request or source violates an immutable RAG data contract."""


class IdempotencyConflictError(PermanentRagContractError):
    """A request key was reused with a different payload."""
