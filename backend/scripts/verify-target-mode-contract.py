from app.core.errors import ApiError
from app.services.etl_service import validate_target_contract


def main() -> None:
    validate_target_contract(
        source_type="Stream / Kafka",
        execution_mode="snapshot",
        target_layer="BRONZE",
        target_format="jsonl",
    )
    validate_target_contract(
        source_type="Stream / Kafka",
        execution_mode="continuous",
        target_layer="SILVER",
        target_format="parquet",
    )
    validate_target_contract(
        source_type="File / S3",
        execution_mode="snapshot",
        target_layer="GOLD",
        target_format="parquet",
    )
    assert_error("TARGET_LAYER_UNSUPPORTED", target_layer="GOLD", target_format="jsonl")
    assert_error("TARGET_FORMAT_UNSUPPORTED", target_layer="BRONZE", target_format="parquet")
    assert_error(
        "TARGET_FORMAT_UNSUPPORTED",
        execution_mode="continuous",
        target_layer="BRONZE",
        target_format="jsonl",
    )
    print("verify-target-mode-contract: ok")


def assert_error(
    expected_code: str,
    *,
    execution_mode: str = "snapshot",
    target_layer: str,
    target_format: str,
) -> None:
    try:
        validate_target_contract(
            source_type="Stream / Kafka",
            execution_mode=execution_mode,
            target_layer=target_layer,
            target_format=target_format,
        )
    except ApiError as exc:
        assert exc.code == expected_code, (expected_code, exc.code)
        return
    raise AssertionError(f"Expected {expected_code}")


if __name__ == "__main__":
    main()
