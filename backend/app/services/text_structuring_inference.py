import hashlib
import json
import re
from collections import Counter
from typing import Any
from urllib.parse import urlparse

from app.core.config import Settings
from app.schemas.text_structuring import (
    TextFieldResultMeta,
    TextFieldSpec,
    TextRepeatedGroupSpec,
    TextStructuringDefinition,
    TextStructuringResultRow,
)
from app.services.text_structuring_compiler import build_system_instructions, compile_definition
from app.services.text_structuring_provider import (
    OpenAICompatibleTextProvider,
    TextStructuringProviderError,
)
from app.services.text_structuring_training import predict_student_field

PII_PATTERNS = (
    (re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE), "[EMAIL]"),
    (re.compile(r"(?<!\d)(?:\+?82[- ]?)?0?1[016789][- ]?\d{3,4}[- ]?\d{4}(?!\d)"), "[PHONE]"),
    (re.compile(r"(?<!\d)\d{6}[- ]?[1-4]\d{6}(?!\d)"), "[ID]"),
)

ASPECT_PATTERNS: dict[str, tuple[str, ...]] = {
    "battery": ("배터리", "방전", "충전", "battery", "charge", "charging", "power"),
    "appearance": ("외관", "디자인", "색상", "마감", "appearance", "design", "color", "finish", "look"),
    "display": ("화면", "디스플레이", "액정", "터치", "screen", "display", "touch", "glass"),
    "performance": ("성능", "속도", "버벅", "느리", "performance", "speed", "slow", "lag"),
    "camera": ("카메라", "사진", "camera", "photo"),
    "audio": ("소리", "음질", "스피커", "audio", "sound", "speaker"),
    "shipping": ("배송", "포장", "도착", "shipping", "delivery", "package", "arrived"),
    "price": ("가격", "비싸", "가성비", "price", "expensive", "value"),
    "quality": ("품질", "불량", "고장", "quality", "defect", "broken"),
}

POSITIVE_PATTERN = re.compile(
    r"괜찮|좋(?:아|네|다|은|고)?|만족|예쁘|훌륭|빠르|편하|추천|positive|good|great|excellent|satisfied|love|nice|works? well",
    re.IGNORECASE,
)
NEGATIVE_PATTERN = re.compile(
    r"안\s*좋|좋지\s*않|나쁘|실망|환불|반품|심하|너무\s*(?:빨리|느리)|문제|불량|고장|깨|끊|위험|과열|폭발|소모|닳|negative|bad|poor|broken|defect|refund|return|disappoint|overheat|drain|doesn.?t work|not working|not good",
    re.IGNORECASE,
)
HIGH_SEVERITY_PATTERN = re.compile(
    r"환불|반품|사용\s*불가|전혀\s*안|고장|위험|과열|폭발|화재|부상|너무\s*심|critical|danger|fire|explode|injur|refund|return|unusable|not working",
    re.IGNORECASE,
)
MEDIUM_SEVERITY_PATTERN = re.compile(
    r"문제|불편|느리|소모|닳|실망|defect|issue|problem|slow|drain|disappoint",
    re.IGNORECASE,
)


class TextStructuringInferenceEngine:
    def __init__(self, settings: Settings, student_artifact: dict[str, Any] | None = None):
        self.settings = settings
        self.provider = OpenAICompatibleTextProvider(settings)
        self.student_artifact = student_artifact

    def run(
        self,
        definition: TextStructuringDefinition,
        rows: list[dict[str, Any]],
    ) -> tuple[list[TextStructuringResultRow], list[str], dict[str, int]]:
        prepared = prepare_rows(definition, rows)
        warnings: list[str] = []
        results: list[TextStructuringResultRow] = []
        use_provider, provider_warning = self._provider_route(definition)
        if provider_warning:
            warnings.append(provider_warning)
        if use_provider and definition.routing_policy.max_llm_fraction < 1:
            warnings.append(
                f"maxLlmFraction={definition.routing_policy.max_llm_fraction:.2f} 안정 해시 표본에만 LLM을 사용합니다."
            )

        batch_size = min(definition.routing_policy.batch_size, self.settings.text_structuring_batch_size)
        for offset in range(0, len(prepared), batch_size):
            batch = prepared[offset:offset + batch_size]
            student_rows = (
                student_batch(definition, batch, self.student_artifact)
                if self.student_artifact
                else []
            )
            if definition.routing_policy.mode == "student":
                results.extend(student_rows or heuristic_batch(definition, batch))
                continue
            if definition.routing_policy.mode == "hybrid" and student_rows:
                accepted = {row.source_row_id: row for row in student_rows if not row.review_required}
                fallback_batch = [row for row in batch if row["_asklake_source_row_id"] not in accepted]
                student_by_id = {row.source_row_id: row for row in student_rows}
                fallback_by_id = {
                    row["_asklake_source_row_id"]: student_by_id[row["_asklake_source_row_id"]]
                    for row in fallback_batch
                }
                provider_batch = [
                    row for row in fallback_batch
                    if llm_eligible(definition, row)
                ] if use_provider else []
                if provider_batch:
                    try:
                        provider_rows = self.provider.infer(
                            instructions=build_system_instructions(definition),
                            rows=[provider_payload_row(definition, row) for row in provider_batch],
                            response_schema=compile_definition(definition),
                        )
                        fallback_by_id.update({
                            row.source_row_id: row
                            for row in normalize_provider_batch(definition, provider_batch, provider_rows)
                        })
                    except TextStructuringProviderError as exc:
                        warnings.append(str(exc))
                resolved = {**accepted, **fallback_by_id}
                results.extend(resolved[row["_asklake_source_row_id"]] for row in batch)
                continue
            if use_provider:
                provider_batch = [row for row in batch if llm_eligible(definition, row)]
                fallback_by_id = {
                    row.source_row_id: row
                    for row in heuristic_batch(definition, batch)
                }
                if provider_batch:
                    try:
                        provider_rows = self.provider.infer(
                            instructions=build_system_instructions(definition),
                            rows=[provider_payload_row(definition, row) for row in provider_batch],
                            response_schema=compile_definition(definition),
                        )
                        fallback_by_id.update({
                            row.source_row_id: row
                            for row in normalize_provider_batch(definition, provider_batch, provider_rows)
                        })
                    except TextStructuringProviderError as exc:
                        warnings.append(str(exc))
                results.extend(fallback_by_id[row["_asklake_source_row_id"]] for row in batch)
                continue
            results.extend(heuristic_batch(definition, batch))

        breakdown = dict(Counter(result.route for result in results))
        return results, deduplicate(warnings), breakdown

    def _provider_route(self, definition: TextStructuringDefinition) -> tuple[bool, str | None]:
        policy = definition.routing_policy
        if policy.mode in {"heuristic", "student"}:
            return False, None
        if not self.provider.available:
            if self.student_artifact:
                return False, "LLM 공급자가 없어 champion 전용 모델의 검토 대상 결과를 사용했습니다."
            return False, "구조화 모델이 설정되지 않아 휴리스틱 결과를 검토 대기 상태로 반환했습니다."
        if is_external_url(self.settings.text_structuring_api_url):
            if policy.pii_mode == "block_external":
                return False, "이 명세는 외부 모델 전송을 차단하므로 로컬 휴리스틱을 사용했습니다."
            if not policy.external_provider_allowed or not self.settings.text_structuring_external_provider_allowed:
                return False, "외부 모델 사용 승인이 없어 로컬 휴리스틱을 사용했습니다."
        return True, None


def prepare_rows(
    definition: TextStructuringDefinition,
    rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    prepared: list[dict[str, Any]] = []
    occurrence_by_hash: Counter[str] = Counter()
    for row in rows:
        normalized = dict(row)
        canonical = json.dumps(normalized, ensure_ascii=False, sort_keys=True, default=str)
        source_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        occurrence = occurrence_by_hash[source_hash]
        occurrence_by_hash[source_hash] += 1
        explicit_id = next(
            (
                normalized.get(key)
                for key in ("sourceRowId", "_asklake_source_row_id", "review_id", "id")
                if normalized.get(key) not in (None, "")
            ),
            None,
        )
        normalized["_asklake_source_row_id"] = str(explicit_id or f"row_{source_hash[:20]}_{occurrence}")
        normalized["_asklake_source_hash"] = source_hash
        normalized["_asklake_text"] = "\n".join(
            str(normalized.get(field) or "").strip()
            for field in definition.source_fields
            if str(normalized.get(field) or "").strip()
        )
        prepared.append(normalized)
    return prepared


def llm_eligible(definition: TextStructuringDefinition, row: dict[str, Any]) -> bool:
    fraction = definition.routing_policy.max_llm_fraction
    if fraction >= 1:
        return True
    if fraction <= 0:
        return False
    digest = hashlib.sha256(str(row.get("_asklake_source_row_id") or "").encode("utf-8")).hexdigest()
    return int(digest[:8], 16) / 0xFFFFFFFF <= fraction


def provider_payload_row(
    definition: TextStructuringDefinition,
    row: dict[str, Any],
) -> dict[str, Any]:
    payload = {
        "sourceRowId": row["_asklake_source_row_id"],
        "source": {
            field: row.get(field)
            for field in definition.source_fields
        },
    }
    if definition.routing_policy.pii_mode == "mask":
        payload = mask_pii(payload)
    return payload


def normalize_provider_batch(
    definition: TextStructuringDefinition,
    prepared_rows: list[dict[str, Any]],
    payload: dict[str, Any],
) -> list[TextStructuringResultRow]:
    raw_rows = payload.get("rows")
    if not isinstance(raw_rows, list):
        raise TextStructuringProviderError("Provider response did not include rows.")
    by_id = {
        str(item.get("sourceRowId")): item
        for item in raw_rows
        if isinstance(item, dict) and item.get("sourceRowId") is not None
    }
    normalized: list[TextStructuringResultRow] = []
    for prepared in prepared_rows:
        source_row_id = prepared["_asklake_source_row_id"]
        item = by_id.get(source_row_id)
        if item is None:
            normalized.extend(heuristic_batch(definition, [prepared], reason="모델 응답에서 행이 누락되었습니다."))
            continue
        output, repeated, reasons = validate_output(
            definition,
            item.get("output"),
            item.get("repeatedGroups"),
        )
        field_meta = {
            field.target_name: TextFieldResultMeta(
                route="deterministic" if field.task == "copy" else "llm",
                calibrated=False,
                warnings=[] if field.task == "copy" else ["모델 신뢰도는 아직 보정되지 않았습니다."],
            )
            for field in definition.fields
        }
        normalized.append(
            TextStructuringResultRow(
                source_row_id=source_row_id,
                input=public_input(prepared),
                output=output,
                repeated_groups=repeated,
                field_meta=field_meta,
                review_required=bool(reasons),
                review_reasons=reasons,
                route="llm" if not reasons else "llm_validation_review",
            )
        )
    return normalized


def student_batch(
    definition: TextStructuringDefinition,
    rows: list[dict[str, Any]],
    artifact: dict[str, Any],
) -> list[TextStructuringResultRow]:
    artifact_fields = artifact.get("fields") if isinstance(artifact.get("fields"), dict) else {}
    calibrated = bool(artifact.get("calibrated"))
    output_rows: list[TextStructuringResultRow] = []
    for row in rows:
        text = str(row.get("_asklake_text") or "")
        output: dict[str, Any] = {}
        field_meta: dict[str, TextFieldResultMeta] = {}
        reasons: list[str] = []
        for field in definition.fields:
            if field.task == "copy":
                value = row.get(field.source_field or field.target_name)
                route = "deterministic"
                confidence = None
                warnings: list[str] = []
            elif field.target_name in artifact_fields:
                value, confidence = predict_student_field(artifact_fields[field.target_name], text)
                route = "student"
                warnings = [] if calibrated else ["전용 모델 신뢰도는 아직 보정되지 않았습니다."]
                if not calibrated:
                    reasons.append(f"{field.target_name}: 전용 모델 신뢰도가 보정되지 않았습니다.")
                elif confidence is None or confidence < definition.routing_policy.accept_threshold:
                    reasons.append(f"{field.target_name}: 전용 모델 신뢰도가 자동 승인 기준보다 낮습니다.")
            else:
                value = infer_field(field, text, row)
                route = "heuristic_fallback"
                confidence = None
                warnings = ["이 필드는 전용 모델이 지원하지 않아 휴리스틱을 사용했습니다."]
                reasons.append(f"{field.target_name}: champion 모델이 이 필드를 지원하지 않습니다.")
            output[field.target_name] = coerce_field_value(field, value)[0]
            field_meta[field.target_name] = TextFieldResultMeta(
                route=route,
                confidence=confidence,
                calibrated=calibrated if route == "student" else False,
                evidence=text[:240] if field.evidence_required and text else None,
                warnings=warnings,
            )
        repeated = {
            group.target_name: infer_repeated_group(group, text, row)
            for group in definition.repeated_groups
        }
        if definition.repeated_groups:
            reasons.append("반복 관점 결과는 아직 전용 모델 범위가 아니므로 검토가 필요합니다.")
        _, _, validation_reasons = validate_output(definition, output, repeated)
        reasons.extend(validation_reasons)
        output_rows.append(
            TextStructuringResultRow(
                source_row_id=row["_asklake_source_row_id"],
                input=public_input(row),
                output=output,
                repeated_groups=repeated,
                field_meta=field_meta,
                review_required=bool(reasons),
                review_reasons=deduplicate(reasons),
                route="student" if not reasons else "student_review",
            )
        )
    return output_rows


def heuristic_batch(
    definition: TextStructuringDefinition,
    rows: list[dict[str, Any]],
    *,
    reason: str | None = None,
) -> list[TextStructuringResultRow]:
    output_rows: list[TextStructuringResultRow] = []
    for row in rows:
        text = str(row.get("_asklake_text") or "")
        output: dict[str, Any] = {}
        field_meta: dict[str, TextFieldResultMeta] = {}
        semantic_fields = 0
        for field in definition.fields:
            if field.task == "copy":
                value = row.get(field.source_field or field.target_name)
                route = "deterministic"
                warnings: list[str] = []
            else:
                value = infer_field(field, text, row)
                route = "heuristic_fallback"
                warnings = ["휴리스틱 추정값이며 사람 또는 모델 검토가 필요합니다."]
                semantic_fields += 1
            output[field.target_name] = coerce_field_value(field, value)[0]
            field_meta[field.target_name] = TextFieldResultMeta(
                route=route,
                confidence=None,
                calibrated=False,
                evidence=text[:240] if field.evidence_required and text else None,
                warnings=warnings,
            )
        repeated = {
            group.target_name: infer_repeated_group(group, text, row)
            for group in definition.repeated_groups
        }
        semantic_fields += sum(len(group.fields) for group in definition.repeated_groups)
        reasons = []
        if semantic_fields:
            reasons.append(reason or "모델 또는 검증된 전용 분류기가 없어 휴리스틱 경로를 사용했습니다.")
        _, _, validation_reasons = validate_output(definition, output, repeated)
        reasons.extend(validation_reasons)
        output_rows.append(
            TextStructuringResultRow(
                source_row_id=row["_asklake_source_row_id"],
                input=public_input(row),
                output=output,
                repeated_groups=repeated,
                field_meta=field_meta,
                review_required=bool(reasons),
                review_reasons=deduplicate(reasons),
                route="heuristic_review" if reasons else "deterministic",
            )
        )
    return output_rows


def infer_field(field: TextFieldSpec, text: str, row: dict[str, Any]) -> Any:
    semantic = semantic_kind(field)
    if field.task == "extract_scalar":
        match = re.search(r"[-+]?\d+(?:[.,]\d+)?", text)
        return float(match.group(0).replace(",", "")) if match else unknown_value(field)
    if field.task == "extract_span":
        return text[:240] if text else unknown_value(field)
    if field.task == "free_text":
        return text[:500] if text else unknown_value(field)
    if semantic == "sentiment":
        return sentiment_value(field, text)
    if semantic == "severity":
        return severity_value(field, text)
    if semantic in {"aspect", "issue"}:
        aspects = detect_aspects(text)
        if field.task == "multi_label":
            return [map_aspect_to_label(field, aspect) for aspect in aspects if map_aspect_to_label(field, aspect)]
        return map_aspect_to_label(field, aspects[0]) if aspects else unknown_value(field)
    if field.task == "multi_label":
        return []
    if field.task == "boolean":
        return None if field.nullable else False
    return unknown_value(field)


def infer_repeated_group(
    group: TextRepeatedGroupSpec,
    text: str,
    row: dict[str, Any],
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    clauses = split_clauses(text)
    for clause in clauses:
        aspects = detect_aspects(clause)
        if not aspects:
            continue
        for aspect in aspects:
            item: dict[str, Any] = {}
            for field in group.fields:
                semantic = semantic_kind(field)
                if field.task == "copy":
                    value = row.get(field.source_field or field.target_name)
                elif semantic in {"aspect", "issue"}:
                    value = map_aspect_to_label(field, aspect) or unknown_value(field)
                elif semantic == "sentiment":
                    value = sentiment_value(field, clause)
                elif semantic == "severity":
                    value = severity_value(field, clause)
                elif semantic == "evidence" or field.task == "extract_span":
                    value = clause[:240]
                else:
                    value = infer_field(field, clause, row)
                item[field.target_name] = coerce_field_value(field, value)[0]
            items.append(item)
    return items


def validate_output(
    definition: TextStructuringDefinition,
    raw_output: Any,
    raw_repeated: Any,
) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]], list[str]]:
    output_source = raw_output if isinstance(raw_output, dict) else {}
    repeated_source = raw_repeated if isinstance(raw_repeated, dict) else {}
    output: dict[str, Any] = {}
    repeated: dict[str, list[dict[str, Any]]] = {}
    reasons: list[str] = []

    for field in definition.fields:
        value, warning = coerce_field_value(field, output_source.get(field.target_name))
        output[field.target_name] = value
        if warning:
            reasons.append(f"{field.target_name}: {warning}")
    for group in definition.repeated_groups:
        raw_items = repeated_source.get(group.target_name)
        if not isinstance(raw_items, list):
            raw_items = []
            reasons.append(f"{group.target_name}: 반복 결과가 배열이 아닙니다.")
        group_items: list[dict[str, Any]] = []
        for index, raw_item in enumerate(raw_items):
            if not isinstance(raw_item, dict):
                reasons.append(f"{group.target_name}[{index}]: 객체가 아닙니다.")
                continue
            normalized_item: dict[str, Any] = {}
            for field in group.fields:
                value, warning = coerce_field_value(field, raw_item.get(field.target_name))
                normalized_item[field.target_name] = value
                if warning:
                    reasons.append(f"{group.target_name}[{index}].{field.target_name}: {warning}")
            group_items.append(normalized_item)
        repeated[group.target_name] = group_items
    return output, repeated, deduplicate(reasons)


def coerce_field_value(field: TextFieldSpec, value: Any) -> tuple[Any, str | None]:
    allowed = [label.value for label in field.allowed_values]
    if value is None:
        return (None, None) if field.nullable else (unknown_value(field), "필수 값이 비어 있습니다.")
    if field.task == "multi_label":
        if not isinstance(value, list):
            return [], "다중 선택 값이 배열이 아닙니다."
        normalized = [str(item) for item in value]
        invalid = [item for item in normalized if allowed and item not in allowed]
        return ([item for item in normalized if not allowed or item in allowed], f"허용되지 않은 값: {invalid}" if invalid else None)
    if field.task == "boolean" or field.output_type.casefold() in {"bool", "boolean"}:
        if isinstance(value, bool):
            return value, None
        if str(value).casefold() in {"true", "1", "yes"}:
            return True, None
        if str(value).casefold() in {"false", "0", "no"}:
            return False, None
        return (None if field.nullable else False), "불리언 값이 아닙니다."
    if field.task == "extract_scalar" or any(
        token in field.output_type.casefold() for token in ("int", "float", "double", "decimal", "number")
    ):
        try:
            return float(value), None
        except (TypeError, ValueError):
            return (None if field.nullable else 0), "숫자 값이 아닙니다."
    normalized = str(value)
    if allowed and normalized not in allowed:
        replacement = unknown_value(field)
        return replacement, f"허용되지 않은 값 {normalized!r}입니다."
    return normalized, None


def semantic_kind(field: TextFieldSpec) -> str:
    text = f"{field.field_id} {field.target_name} {field.description}".casefold()
    if any(token in text for token in ("sentiment", "polarity", "감정", "긍정", "부정")):
        return "sentiment"
    if any(token in text for token in ("severity", "priority", "심각", "중대", "위험도")):
        return "severity"
    if any(token in text for token in ("evidence", "근거", "원문", "span")):
        return "evidence"
    if any(token in text for token in ("aspect", "관점", "속성", "feature")):
        return "aspect"
    if any(token in text for token in ("issue", "category", "topic", "이슈", "유형", "종류", "주제")):
        return "issue"
    return "generic"


def sentiment_value(field: TextFieldSpec, text: str) -> Any:
    positive, negative = polarity_flags(text)
    if positive and negative:
        concept = "mixed"
    elif negative:
        concept = "negative"
    elif positive:
        concept = "positive"
    else:
        concept = "neutral"
    aliases = {
        "positive": ("positive", "pos", "긍정", "만족", "좋음"),
        "negative": ("negative", "neg", "부정", "불만", "나쁨"),
        "mixed": ("mixed", "복합", "혼합", "긍정/부정", "both"),
        "neutral": ("neutral", "중립", "보통", "평가없음"),
    }
    return matching_label(field, aliases[concept]) or unknown_value(field)


def severity_value(field: TextFieldSpec, text: str) -> Any:
    _, negative = polarity_flags(text)
    if HIGH_SEVERITY_PATTERN.search(text):
        concept = "high"
    elif MEDIUM_SEVERITY_PATTERN.search(text) or negative:
        concept = "medium"
    else:
        concept = "low"
    aliases = {
        "high": ("critical", "high", "높음", "심각", "긴급", "매우높음"),
        "medium": ("medium", "moderate", "중간", "보통"),
        "low": ("low", "minor", "낮음", "경미"),
    }
    return matching_label(field, aliases[concept]) or unknown_value(field)


def detect_aspects(text: str) -> list[str]:
    lowered = text.casefold()
    return [
        aspect
        for aspect, terms in ASPECT_PATTERNS.items()
        if any(term.casefold() in lowered for term in terms)
    ]


def polarity_flags(text: str) -> tuple[bool, bool]:
    positive_negations = re.compile(r"나쁘지\s*않|안\s*나쁘|문제(?:가)?\s*없|not\s+bad|no\s+problem", re.IGNORECASE)
    negative_negations = re.compile(r"좋지\s*않|안\s*좋|not\s+good", re.IGNORECASE)
    positive = bool(POSITIVE_PATTERN.search(negative_negations.sub("", text))) or bool(positive_negations.search(text))
    negative = bool(NEGATIVE_PATTERN.search(positive_negations.sub("", text))) or bool(negative_negations.search(text))
    return positive, negative


def map_aspect_to_label(field: TextFieldSpec, aspect: str) -> str | None:
    aliases = {
        "battery": ("battery", "배터리", "충전", "전원"),
        "appearance": ("appearance", "design", "외관", "디자인", "마감"),
        "display": ("display", "screen", "화면", "액정"),
        "performance": ("performance", "speed", "성능", "속도"),
        "camera": ("camera", "카메라"),
        "audio": ("audio", "sound", "소리", "음질"),
        "shipping": ("shipping", "delivery", "배송", "포장"),
        "price": ("price", "value", "가격", "가성비"),
        "quality": ("quality", "defect", "품질", "불량"),
    }
    return matching_label(field, aliases.get(aspect, (aspect,))) or (aspect if not field.allowed_values else None)


def matching_label(field: TextFieldSpec, aliases: tuple[str, ...]) -> str | None:
    normalized_aliases = {normalize_token(alias) for alias in aliases}
    for label in field.allowed_values:
        haystack = normalize_token(f"{label.value} {label.description}")
        if any(alias and alias in haystack for alias in normalized_aliases):
            return label.value
    return None


def unknown_value(field: TextFieldSpec) -> Any:
    if field.task == "multi_label":
        return []
    if field.unknown_value is not None:
        allowed = [label.value for label in field.allowed_values]
        if not allowed or field.unknown_value in allowed:
            return field.unknown_value
    return None if field.nullable else "unknown"


def split_clauses(text: str) -> list[str]:
    clauses = re.split(r"\s*(?:[,;.!?]|하지만|그러나|반면에?|but|however|while)\s*", text, flags=re.IGNORECASE)
    return [clause.strip() for clause in clauses if clause.strip()]


def mask_pii(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: mask_pii(item) for key, item in value.items()}
    if isinstance(value, list):
        return [mask_pii(item) for item in value]
    if not isinstance(value, str):
        return value
    masked = value
    for pattern, replacement in PII_PATTERNS:
        masked = pattern.sub(replacement, masked)
    return masked


def is_external_url(url: str) -> bool:
    hostname = (urlparse(url).hostname or "").casefold()
    return hostname not in {"", "localhost", "127.0.0.1", "host.docker.internal"}


def public_input(row: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in row.items() if not key.startswith("_asklake_")}


def normalize_token(value: str) -> str:
    return re.sub(r"[^0-9a-z가-힣]+", "", value.casefold())


def deduplicate(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))
