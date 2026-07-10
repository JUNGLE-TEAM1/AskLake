import hashlib
import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from app.models import TextStructuringReviewItemModel
from app.schemas.text_structuring import TextFieldSpec, TextStructuringDefinition


SUPPORTED_TASKS = {"classification", "ordinal", "boolean", "multi_label"}


def train_student_artifact(
    *,
    definition: TextStructuringDefinition,
    review_items: list[TextStructuringReviewItemModel],
    task_fields: list[str],
    artifact_path: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    fields_by_name = {
        field.target_name: field
        for field in definition.fields
        if field.task in SUPPORTED_TASKS
    }
    selected = task_fields or list(fields_by_name)
    selected = [name for name in selected if name in fields_by_name]
    if not selected:
        raise ValueError("No supported classification fields were selected.")

    examples = build_training_examples(definition, review_items, fields_by_name, selected)
    if not examples:
        raise ValueError("No reviewed labels are available for the selected fields.")

    artifact_fields: dict[str, Any] = {}
    field_metrics: dict[str, Any] = {}
    for field_name in selected:
        field_examples = examples.get(field_name, [])
        if not field_examples:
            continue
        artifact_fields[field_name] = train_field(fields_by_name[field_name], field_examples)
        label_counts = Counter(label for _, labels in field_examples for label in labels)
        field_metrics[field_name] = {
            "labels": dict(label_counts),
            "trainingRows": len(field_examples),
        }

    if not artifact_fields:
        raise ValueError("Reviewed rows did not contain usable labels.")

    artifact = {
        "artifactVersion": "asklake-text-student-v1",
        "calibrated": False,
        "sourceFields": definition.source_fields,
        "fields": artifact_fields,
    }
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    artifact_path.write_text(json.dumps(artifact, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    metrics = {
        "calibrated": False,
        "evaluationStatus": "not_evaluated",
        "fields": field_metrics,
        "trainingRows": len(review_items),
    }
    return artifact, metrics


def predict_student_field(artifact_field: dict[str, Any], text: str) -> tuple[Any, float | None]:
    labels = artifact_field.get("labels")
    if not isinstance(labels, dict) or not labels:
        return None, None
    tokens = tokenize(text)
    scores: dict[str, float] = {}
    total_documents = max(sum(int(label.get("documentCount") or 0) for label in labels.values()), 1)
    vocabulary_size = max(int(artifact_field.get("vocabularySize") or 1), 1)
    for label_name, label in labels.items():
        document_count = int(label.get("documentCount") or 0)
        token_total = int(label.get("tokenTotal") or 0)
        token_counts = label.get("tokenCounts") if isinstance(label.get("tokenCounts"), dict) else {}
        score = math.log((document_count + 1) / (total_documents + len(labels)))
        denominator = token_total + vocabulary_size
        for token in tokens:
            score += math.log((int(token_counts.get(token) or 0) + 1) / denominator)
        scores[str(label_name)] = score
    best = max(scores, key=scores.get)
    max_score = scores[best]
    exp_scores = {label: math.exp(score - max_score) for label, score in scores.items()}
    confidence = exp_scores[best] / max(sum(exp_scores.values()), 1e-12)
    if artifact_field.get("task") == "multi_label":
        selected = [label for label, probability in normalized_scores(exp_scores).items() if probability >= 0.4]
        return selected or [best], confidence
    if artifact_field.get("task") == "boolean":
        return best.casefold() in {"true", "1", "yes"}, confidence
    return best, confidence


def build_training_examples(
    definition: TextStructuringDefinition,
    review_items: list[TextStructuringReviewItemModel],
    fields_by_name: dict[str, TextFieldSpec],
    selected: list[str],
) -> dict[str, list[tuple[str, list[str]]]]:
    examples: dict[str, list[tuple[str, list[str]]]] = defaultdict(list)
    for item in review_items:
        text = "\n".join(
            str((item.input_snapshot or {}).get(field) or "").strip()
            for field in definition.source_fields
            if str((item.input_snapshot or {}).get(field) or "").strip()
        )
        if not text:
            continue
        labels = reviewed_output(item)
        for field_name in selected:
            value = labels.get(field_name)
            if value is None:
                continue
            values = value if isinstance(value, list) else [value]
            allowed = {label.value for label in fields_by_name[field_name].allowed_values}
            normalized = [str(entry) for entry in values if not allowed or str(entry) in allowed]
            if normalized:
                examples[field_name].append((text, normalized))
    return examples


def reviewed_output(item: TextStructuringReviewItemModel) -> dict[str, Any]:
    payload = item.correction if item.status == "corrected" and item.correction else item.prediction
    if not isinstance(payload, dict):
        return {}
    output = payload.get("output")
    return output if isinstance(output, dict) else payload


def train_field(field: TextFieldSpec, examples: list[tuple[str, list[str]]]) -> dict[str, Any]:
    labels: dict[str, dict[str, Any]] = {}
    vocabulary: set[str] = set()
    token_counts_by_label: dict[str, Counter[str]] = defaultdict(Counter)
    document_counts: Counter[str] = Counter()
    for text, example_labels in examples:
        tokens = tokenize(text)
        vocabulary.update(tokens)
        for label in example_labels:
            document_counts[label] += 1
            token_counts_by_label[label].update(tokens)
    for label, token_counts in token_counts_by_label.items():
        labels[label] = {
            "documentCount": document_counts[label],
            "tokenCounts": dict(token_counts),
            "tokenTotal": sum(token_counts.values()),
        }
    return {
        "task": field.task,
        "labels": labels,
        "vocabularySize": len(vocabulary),
    }


def tokenize(text: str) -> list[str]:
    words = re.findall(r"[0-9a-z]+|[가-힣]+", text.casefold())
    tokens: list[str] = []
    for word in words:
        tokens.append(word)
        if re.fullmatch(r"[가-힣]+", word) and len(word) > 1:
            tokens.extend(word[index:index + 2] for index in range(len(word) - 1))
    return tokens


def normalized_scores(scores: dict[str, float]) -> dict[str, float]:
    total = max(sum(scores.values()), 1e-12)
    return {label: score / total for label, score in scores.items()}


def artifact_filename(spec_id: str, version: int, run_id: str) -> str:
    digest = hashlib.sha256(f"{spec_id}:{version}:{run_id}".encode("utf-8")).hexdigest()[:16]
    return f"{spec_id}-v{version}-{digest}.json"
