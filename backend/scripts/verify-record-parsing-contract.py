from app.schemas.etl import RecordParsingDraft, RecordParsingPreviewRequest
from app.services.etl_service import preview_record_parsing


GOOD_LINES = [
    "2026-07-12T09:00:00Z EVT-0001 CUS-001 SES-0001 click / nav_home web KR 52",
    "2026-07-12T09:00:01Z EVT-0002 CUS-002 SES-0001 click /cart add_to_cart ios US 69",
    "2026-07-12T09:00:02Z EVT-0003 CUS-003 SES-0001 click /checkout checkout_button android JP 86",
]


def preview(lines: list[str], parsing: RecordParsingDraft | None = None):
    return preview_record_parsing(RecordParsingPreviewRequest(
        rawLines=lines,
        recordParsing=parsing or RecordParsingDraft(enabled=True),
    ))


def main() -> None:
    inferred = preview(GOOD_LINES)
    assert inferred.can_apply is True
    assert inferred.total_rows == 3
    assert inferred.valid_rows == 3
    assert inferred.record_parsing.expected_field_count == 10
    assert inferred.columns[0].type == "Timestamp"
    assert inferred.columns[-1].type == "Integer"

    configured = inferred.record_parsing.model_copy(update={
        "columns": [
            column.model_copy(update={"name": name})
            for column, name in zip(inferred.record_parsing.columns, [
                "event_time", "event_id", "customer_id", "session_id", "event_type",
                "page_path", "element_id", "device", "region", "latency_ms",
            ], strict=True)
        ]
    })
    named = preview(GOOD_LINES, configured)
    assert named.can_apply is True
    assert [column.target_name for column in named.columns] == [
        "event_time", "event_id", "customer_id", "session_id", "event_type",
        "page_path", "element_id", "device", "region", "latency_ms",
    ]

    invalid = preview([GOOD_LINES[0], GOOD_LINES[1], "2026-07-12T09:00:02Z EVT-0003 CUS-003"])
    assert invalid.can_apply is False
    assert invalid.record_parsing.expected_field_count == 10
    assert invalid.valid_rows == 2
    assert len(invalid.invalid_rows) == 1
    assert invalid.invalid_rows[0].line_number == 3
    assert invalid.invalid_rows[0].actual_field_count == 3

    print("record parsing contract verification passed")


if __name__ == "__main__":
    main()
