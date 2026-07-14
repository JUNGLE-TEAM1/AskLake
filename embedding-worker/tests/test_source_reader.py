from datetime import datetime, timedelta, timezone

import pytest

from app.source_reader import validate_manifest


def test_source_manifest_is_dataset_bound_and_expiry_checked() -> None:
    manifest = {
        "manifestVersion": 1,
        "datasetId": "reviews",
        "readUrl": "https://minio.example/reviews.jsonl?signature=redacted",
        "format": "jsonl",
        "fingerprint": "sha256:abc",
        "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
    }
    validate_manifest(manifest, dataset_id="reviews")
    with pytest.raises(ValueError, match="does not match"):
        validate_manifest(manifest, dataset_id="other")


def test_expired_source_manifest_is_rejected() -> None:
    manifest = {"manifestVersion": 1, "datasetId": "reviews", "readUrl": "https://minio.example/reviews.jsonl", "format": "jsonl", "fingerprint": "sha256:abc", "expiresAt": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()}
    with pytest.raises(ValueError, match="expired"):
        validate_manifest(manifest, dataset_id="reviews")
