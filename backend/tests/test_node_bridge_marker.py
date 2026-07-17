from app.services.etl_service import marker_payload


def test_marker_payload_preserves_unicode_line_separators_inside_json_strings() -> None:
    payload = (
        'connector log\n'
        'ASKLAKE_SOURCE_CONNECTOR_RESULT='
        '{"review":"first\u0085second\u2028third\u2029fourth","rows":10}\r\n'
    )

    assert marker_payload(payload, "ASKLAKE_SOURCE_CONNECTOR_RESULT") == {
        "review": "first\u0085second\u2028third\u2029fourth",
        "rows": 10,
    }


def test_marker_payload_uses_the_last_ascii_newline_delimited_marker() -> None:
    payload = (
        'ASKLAKE_RESULT={"attempt":1}\n'
        'diagnostic\n'
        'ASKLAKE_RESULT={"attempt":2}\n'
    )

    assert marker_payload(payload, "ASKLAKE_RESULT") == {"attempt": 2}
