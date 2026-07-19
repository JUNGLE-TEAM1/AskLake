import re
from typing import Any
from uuid import uuid4

from app.core.auth_context import ActorContext
from app.core.compatibility import CompatibilityPath, record_compatibility_path
from app.core.config import Settings
from app.core.errors import ApiError
from app.mcp.context import issue_ai_context_token
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.dashboard_runtime_repository import DashboardRuntimeRepository
from app.schemas.dashboard import (
    DashboardAssistantMode,
    DashboardAssistantReportAction,
    DashboardAssistantRequest,
    DashboardAssistantResponse,
)
from app.services.dashboard_assistant_context import (
    AssistantDashboardContext,
    build_assistant_context,
)
from app.services.dashboard_assistant_guard import (
    coerce_assistant_response,
    guard_assistant_response,
)
from app.services.ai_gateway_client import AiGatewayClient
from app.services.ai_evidence import retain_used_rag_evidence
from app.services.ai_generation_audit import (
    evidence_candidate_ids,
    persist_verified_generation_evidence,
    verified_used_evidence_ids,
)
from app.services.semantic_rag_context import build_semantic_rag_context

LOW_SIGNAL_PROMPTS = {
    "ㅋ", "ㅋㅋ", "ㅋㅋㅋ", "ㅎㅎ", "ㅎㅎㅎ", "ㅇㅋ", "ㅇㅇ", "ㄴㄴ",
    "lol", "haha", "hehe", "ok", "okay",
    "아무거나", "진행해줘", "랜덤으로진행해줘", "랜덤으로해줘",
}


class DashboardAssistantService:
    def __init__(
        self,
        runtime_repository: DashboardRuntimeRepository,
        catalog_repository: CatalogRepository,
        settings: Settings,
    ) -> None:
        self.runtime_repository = runtime_repository
        self.catalog_repository = catalog_repository
        self.settings = settings

    def generate_response(
        self,
        request: DashboardAssistantRequest,
        actor: ActorContext,
    ) -> DashboardAssistantResponse:
        context = build_assistant_context(
            request,
            self.runtime_repository,
            self.catalog_repository,
            actor=actor,
            max_sample_rows=self.settings.openai_assistant_max_sample_rows,
        )
        rag_context = self._build_rag_context(request, actor)

        if _is_low_signal_prompt(request.prompt):
            return _build_low_signal_prompt_response()

        if not self.settings.openai_assistant_enabled:
            return self._attach_rag(
                self._unavailable_response(context, "AI Gateway 대시보드 기능이 비활성화되어 요청을 실행하지 않았습니다."),
                rag_context,
            )
        if not getattr(self.settings, "ai_gateway_base_url", None) or not getattr(self.settings, "ai_gateway_service_token", None):
            return self._attach_rag(
                self._unavailable_response(context, "AI Gateway가 설정되지 않아 요청을 실행하지 않았습니다."),
                rag_context,
            )

        try:
            raw_payload = self._request_gateway(request, context, actor, rag_context)
            request_id = str(raw_payload.pop("_requestId", "")).strip()
            coerced_response = coerce_assistant_response(raw_payload)
            guarded_response = guard_assistant_response(coerced_response, context)
            guarded_response = _require_visualization_action(request, guarded_response)
            guarded_response = _normalize_visualization_success_message(request, guarded_response)
            final_response = self._attach_rag(self._with_context_warnings(guarded_response, context), rag_context)
            final_response.request_id = request_id or None
            db = getattr(self.runtime_repository, "db", None)
            if db is not None and request_id:
                persist_verified_generation_evidence(
                    db,
                    actor=actor,
                    candidate_ids=evidence_candidate_ids(rag_context),
                    context_payload={
                        "dashboardId": request.dashboard_id,
                        "datasetIds": [dataset.id for dataset in context.datasets],
                        "mode": request.mode,
                        "prompt": request.prompt,
                        "selectedWidgetId": request.selected_widget_id,
                    },
                    mode="dashboard_assistant",
                    model=str(final_response.model or ""),
                    output_payload={
                        "actions": [
                            action.model_dump(by_alias=True, mode="json")
                            for action in final_response.actions
                        ],
                    },
                    provider=str(final_response.provider or ""),
                    request_id=request_id,
                    used_ids=final_response.used_evidence_ids,
                )
            return final_response
        except (ApiError, TimeoutError, ValueError, OSError) as exc:
            return self._attach_rag(
                self._unavailable_response(
                    context,
                    f"AI Gateway 호출에 실패해 요청을 실행하지 않았습니다. ({exc.__class__.__name__})",
                ),
                rag_context,
            )

    def _request_gateway(
        self,
        assistant_request: DashboardAssistantRequest,
        context: AssistantDashboardContext,
        actor: ActorContext,
        rag_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        selected_dataset_ids = [dataset.id for dataset in context.datasets]
        dashboard_context = context.to_prompt_payload()
        dashboard_context["availableDatasets"] = [
            {
                "id": dataset.id,
                "name": dataset.name,
                "layer": dataset.layer,
                "description": dataset.description,
                "tags": dataset.tags,
            }
            for dataset in context.datasets
        ]
        generation_prompt = assistant_request.prompt
        for attempt in range(2):
            request_id = str(uuid4())
            context_token = None
            if selected_dataset_ids:
                context_token = issue_ai_context_token(
                    request_id=request_id,
                    actor=actor,
                    allowed_dataset_ids=selected_dataset_ids,
                    dataset_permissions={dataset_id: ["query"] for dataset_id in selected_dataset_ids},
                )
            try:
                response = AiGatewayClient(self.settings).generate_dashboard_response(
                    request_id=request_id,
                    prompt=generation_prompt,
                    dashboard_context={
                        "mode": assistant_request.mode,
                        "selectedWidgetId": assistant_request.selected_widget_id,
                        "widgetId": assistant_request.widget_id,
                        **dashboard_context,
                    },
                    selected_dataset_ids=selected_dataset_ids,
                    context_token=context_token,
                    rag_context=rag_context,
                )
            except ApiError as exc:
                should_retry = attempt == 0 and exc.status_code == 502
                if not should_retry:
                    raise
                generation_prompt = (
                    _build_visualization_retry_prompt(assistant_request.prompt)
                    if assistant_request.mode == DashboardAssistantMode.VISUALIZATION_REQUEST
                    else _build_dashboard_question_retry_prompt(assistant_request.prompt)
                )
                continue

            response["_requestId"] = request_id
            return response

        raise ApiError(
            "INTERNAL_ERROR",
            "AI gateway corrective retry did not return a response",
            502,
        )

    def _unavailable_response(
        self,
        context: AssistantDashboardContext,
        warning: str,
    ) -> DashboardAssistantResponse:
        record_compatibility_path(
            CompatibilityPath.DASHBOARD_ASSISTANT_DEGRADED,
            reason=warning,
            context={"availableDatasetCount": len(context.datasets)},
        )
        return DashboardAssistantResponse(
            message="AI Gateway를 사용할 수 없어 요청을 실행하지 않았습니다.",
            actions=[],
            warnings=[*context.warnings, warning],
            provider="unavailable",
        )

    def _build_rag_context(self, request: DashboardAssistantRequest, actor: ActorContext) -> dict[str, Any] | None:
        if not request.semantic_model_id and not request.current_dataset_id:
            return None
        db = getattr(self.runtime_repository, "db", None)
        if db is None:
            return {"sources": [], "retrieval": {"mode": "hybrid", "status": "unavailable", "provenance": "semantic_layer_rag"}}
        return build_semantic_rag_context(
            db=db,
            settings=self.settings,
            actor=actor,
            query=request.prompt,
            dataset_ids=[request.current_dataset_id] if request.current_dataset_id else [],
            semantic_model_id=request.semantic_model_id,
        )

    @staticmethod
    def _attach_rag(response: DashboardAssistantResponse, rag_context: dict[str, Any] | None) -> DashboardAssistantResponse:
        if rag_context:
            used_context = retain_used_rag_evidence(rag_context, response.used_evidence_ids)
            response.sources = list((used_context or {}).get("sources") or [])
            response.retrieval = (used_context or {}).get("retrieval") or {}
            response.used_evidence_ids = verified_used_evidence_ids(used_context)
        return response

    @staticmethod
    def _with_context_warnings(
        response: DashboardAssistantResponse,
        context: AssistantDashboardContext,
    ) -> DashboardAssistantResponse:
        response.warnings = [*context.warnings, *response.warnings]
        return response


def _is_low_signal_prompt(prompt: str) -> bool:
    compact = re.sub(r"\s+", "", prompt.strip().lower())
    if not compact:
        return True
    if compact in LOW_SIGNAL_PROMPTS:
        return True
    if re.fullmatch(r"[ㅋㅎㅠㅜㅇㄱㄴㄷㄹㅁㅂㅅㅈㅊㅌㅍ]+", compact):
        return True
    if re.fullmatch(r"(ha|haha|lol|lmao|rofl)+", compact):
        return True
    return False


def _build_visualization_retry_prompt(prompt: str) -> str:
    return "\n".join((
        prompt,
        "",
        "재시도 지침:",
        "- visualization_request에는 create_widget 또는 update_widget action을 정확히 하나 반환하세요.",
        "- availableDatasets에 있는 datasetId와 columns만 사용하세요.",
        "- 막대그래프 요청에는 유효한 xKey, yKey, aggregation을 포함한 전체 config를 반환하세요.",
        "- 실제로 사용한 RAG 문서가 없으면 usedEvidenceIds를 빈 배열로 반환하세요.",
    ))


def _build_dashboard_question_retry_prompt(prompt: str) -> str:
    return "\n".join((
        prompt,
        "",
        "재시도 지침:",
        "- dashboard_question에는 report action만 반환하거나, 답할 근거가 없으면 actions를 빈 배열로 반환하세요.",
        "- create_widget 또는 update_widget action을 반환하지 마세요.",
        "- 모든 nullable action 필드와 usedEvidenceIds를 strict JSON schema에 맞게 반환하세요.",
        "- 실제로 사용한 RAG 문서가 없으면 usedEvidenceIds를 빈 배열로 반환하세요.",
    ))


def _build_low_signal_prompt_response() -> DashboardAssistantResponse:
    return DashboardAssistantResponse(
        message="Nessie가 분석하거나 수정할 요청을 찾지 못했습니다. 어떤 위젯을 어떻게 바꿀지 조금 더 구체적으로 입력해 주세요.",
        actions=[],
        warnings=["의미가 부족한 짧은 입력이라 대시보드 변경을 적용하지 않았습니다."],
        provider="local-input-guard",
    )


def _normalize_visualization_success_message(
    request: DashboardAssistantRequest,
    response: DashboardAssistantResponse,
) -> DashboardAssistantResponse:
    if request.mode != DashboardAssistantMode.VISUALIZATION_REQUEST or not response.actions:
        return response
    if any(action.type in {"create_widget", "update_widget"} for action in response.actions):
        response.message = "대시보드 편집기에 적용할 시각화 변경을 생성했습니다."
    return response


def _require_visualization_action(
    request: DashboardAssistantRequest,
    response: DashboardAssistantResponse,
) -> DashboardAssistantResponse:
    if request.mode == DashboardAssistantMode.DASHBOARD_QUESTION:
        mutation_actions = [
            action
            for action in response.actions
            if action.type in {"create_widget", "update_widget"}
        ]
        if not mutation_actions:
            return response

        report_actions = [
            action
            for action in response.actions
            if isinstance(action, DashboardAssistantReportAction)
        ]
        response.actions = report_actions
        response.config_patch = None
        response.widget_patch = None
        response.used_evidence_ids = list(dict.fromkeys(
            evidence_id
            for action in report_actions
            for evidence_id in action.used_evidence_ids
        ))
        warning = "질문 모드 응답에 포함된 위젯 변경 action을 제외했습니다. 대시보드는 변경되지 않았습니다."
        if warning not in response.warnings:
            response.warnings.append(warning)
        if not report_actions:
            response.message = "질문 응답에 안전하게 표시할 보고서가 없어 대시보드를 수정하지 않았습니다."
        return response

    if request.mode != DashboardAssistantMode.VISUALIZATION_REQUEST:
        return response
    mutation_actions = [
        action
        for action in response.actions
        if action.type in {"create_widget", "update_widget"}
    ]
    if len(mutation_actions) == 1:
        return response

    warning = (
        "AI가 여러 위젯 변경 action을 한 응답에 생성해 원자적으로 적용할 수 없었습니다. 대시보드는 변경되지 않았습니다."
        if len(mutation_actions) > 1
        else "AI가 검증 가능한 위젯 생성·수정 action을 만들지 못했습니다. 대시보드는 변경되지 않았습니다."
    )
    response.message = "시각화 변경 작업을 안전하게 적용할 수 없어 대시보드를 수정하지 않았습니다."
    response.actions = []
    response.used_evidence_ids = []
    if warning not in response.warnings:
        response.warnings.append(warning)
    return response
