import json

from app.llm_client import parse_chat_completion
from app.schemas import DashboardAssistantOutput


def dashboard_action(*, evidence_ids: list[str]) -> dict[str, object]:
    return {
        "type": "report",
        "widgetId": None,
        "markdown": "근거 기반 보고서",
        "widget": None,
        "patch": None,
        "usedEvidenceIds": evidence_ids,
    }


def test_dashboard_output_derives_top_level_evidence_from_actions() -> None:
    output = DashboardAssistantOutput.model_validate({
        "message": "완료",
        "actions": [
            dashboard_action(evidence_ids=["doc-a", "doc-shared"]),
            dashboard_action(evidence_ids=["doc-shared", "doc-b"]),
        ],
        "warnings": [],
        "usedEvidenceIds": ["doc-b", "doc-shared", "doc-a"],
    })

    assert output.used_evidence_ids == ["doc-a", "doc-shared", "doc-b"]


def test_dashboard_output_discards_unscoped_top_level_evidence() -> None:
    output = DashboardAssistantOutput.model_validate({
        "message": "완료",
        "actions": [dashboard_action(evidence_ids=[])],
        "warnings": [],
        "usedEvidenceIds": ["doc-unscoped", "doc-unscoped", ""],
    })

    assert output.used_evidence_ids == []


def test_openai_dashboard_response_contract_normalizes_redundant_fields() -> None:
    provider_output = {
        "message": "지역별 매출 막대그래프를 만들었습니다.",
        "actions": [{
            "type": "create_widget",
            "widgetId": "provider-should-not-set-this",
            "markdown": "provider-should-not-set-this",
            "widget": {
                "title": "지역별 매출",
                "type": "bar_chart",
                "datasetId": "amazon-products",
                "config": {
                    "aggregation": "sum",
                    "body": None,
                    "centerLabel": None,
                    "color": None,
                    "columns": None,
                    "curve": None,
                    "dateUnit": None,
                    "description": None,
                    "error": None,
                    "errorMessage": None,
                    "format": None,
                    "groupKey": None,
                    "labelKey": None,
                    "limit": 20,
                    "max": None,
                    "min": None,
                    "orientation": "vertical",
                    "placeholderKind": None,
                    "prompt": None,
                    "seriesKey": None,
                    "sortDirection": None,
                    "sortKey": None,
                    "stacked": False,
                    "valueKey": "sales",
                    "xKey": "region",
                    "yKey": None,
                },
            },
            "patch": None,
            "usedEvidenceIds": ["chunk-used"],
        }],
        "warnings": [],
        "usedEvidenceIds": ["chunk-unused"],
    }
    payload = {
        "choices": [{
            "message": {
                "content": json.dumps(provider_output, ensure_ascii=False),
            },
        }],
    }

    output = parse_chat_completion(payload, mode="dashboard_assistant")

    assert isinstance(output, DashboardAssistantOutput)
    assert output.used_evidence_ids == ["chunk-used"]
    assert output.actions[0].widget_id is None
    assert output.actions[0].markdown is None
