import re
from typing import Any
from uuid import uuid4

from app.core.auth_context import ActorContext
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
from app.services.semantic_rag_context import build_semantic_rag_context

LOW_SIGNAL_PROMPTS = {"ㅋ", "ㅋㅋ", "ㅋㅋㅋ", "ㅎㅎ", "ㅎㅎㅎ", "ㅇㅋ", "ㅇㅇ", "ㄴㄴ", "lol", "haha", "hehe", "ok", "okay"}


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
            max_sample_rows=self.settings.ai_assistant_max_sample_rows,
        )
        rag_context = self._build_rag_context(request, actor)

        if _is_low_signal_prompt(request.prompt):
            return _build_low_signal_prompt_response()

        if not getattr(self.settings, "ai_assistant_enabled", True):
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
            coerced_response = coerce_assistant_response(raw_payload)
            guarded_response = guard_assistant_response(coerced_response, context)
            guarded_response = _require_visualization_action(request, guarded_response)
            guarded_response = _normalize_visualization_success_message(request, guarded_response)
            return self._attach_rag(self._with_context_warnings(guarded_response, context), rag_context)
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
        request_id = str(uuid4())
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
        context_token = None
        if selected_dataset_ids:
            context_token = issue_ai_context_token(
                request_id=request_id,
                actor=actor,
                allowed_dataset_ids=selected_dataset_ids,
                dataset_permissions={dataset_id: ["query"] for dataset_id in selected_dataset_ids},
            )
        return AiGatewayClient(self.settings).generate_dashboard_response(
            request_id=request_id,
            prompt=assistant_request.prompt,
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

    def _unavailable_response(
        self,
        context: AssistantDashboardContext,
        warning: str,
    ) -> DashboardAssistantResponse:
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
    if request.mode != DashboardAssistantMode.VISUALIZATION_REQUEST:
        return response
    if any(action.type in {"create_widget", "update_widget"} for action in response.actions):
        return response

    warning = "AI가 검증 가능한 위젯 생성·수정 action을 만들지 못했습니다. 대시보드는 변경되지 않았습니다."
    response.message = "시각화 변경 작업을 생성하지 못해 대시보드를 수정하지 않았습니다."
    if warning not in response.warnings:
        response.warnings.append(warning)
    return response
