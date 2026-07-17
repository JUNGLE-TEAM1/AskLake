from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import sys
import time
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np
from scipy.sparse import csr_matrix, hstack
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score
from sklearn.model_selection import train_test_split
from sklearn.svm import LinearSVC


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RUNTIME_ROOT = REPO_ROOT / "output" / "nlp-eval" / "text-structuring" / "runtime"
DEFAULT_LATEST_ROOT = REPO_ROOT / "backend" / "tmp" / "review-text-models" / "latest"

DENSE_PATTERNS = [
    ("negative_word", r"\b(bad|terrible|awful|broken|defective|disappointed|waste|poor|horrible)\b"),
    ("positive_word", r"\b(great|good|excellent|perfect|love|loved|amazing|works|recommend)\b"),
    ("battery_or_power", r"\b(battery|charge|charging|charger|power|drain|dies?)\b"),
    ("screen_or_display", r"\b(screen|display|crack|scratched|touchscreen|lcd)\b"),
    ("shipping_or_delivery", r"\b(shipping|delivery|arrived|package|packaging|late|lost)\b"),
    ("safety_or_heat", r"\b(overheat|hot|burn|smoke|fire|danger|unsafe)\b"),
    ("return_or_refund", r"\b(return|refund|replace|replacement|warranty|support)\b"),
]


def main() -> int:
    parser = argparse.ArgumentParser(description="Train portable text-structuring classifiers.")
    parser.add_argument("--input", help="JSON request file. Reads stdin when omitted.")
    parser.add_argument("--output-dir", help="Artifact output directory.")
    parser.add_argument("--latest-dir", help="Directory Spark scans for reusable portable models.")
    args = parser.parse_args()

    request = read_request(args.input)
    output_dir = Path(args.output_dir or request.get("outputDir") or DEFAULT_RUNTIME_ROOT / run_id()).resolve()
    latest_dir = Path(args.latest_dir or request.get("latestDir") or DEFAULT_LATEST_ROOT).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    latest_dir.mkdir(parents=True, exist_ok=True)

    columns = [column for column in request.get("columns", []) if text_method(column) == "one_of_values"]
    train_rows = request.get("trainRows") or []
    eval_rows = request.get("evalRows") or []
    if not isinstance(train_rows, list) or len(train_rows) < 2:
        raise ValueError("trainRows must contain at least two labeled rows.")
    label_source = str(request.get("labelSource") or "").strip().lower()
    if label_source not in {"ai_gateway", "human_labeled"}:
        raise ValueError("labelSource must be ai_gateway or human_labeled.")
    label_models = [str(value).strip() for value in request.get("labelModels") or [] if str(value).strip()]
    if label_source == "ai_gateway" and not label_models:
        raise ValueError("AI Gateway labeled training rows require at least one provider model identifier.")

    trained = {}
    required_targets = []
    minimum_quality = float(request.get("minimumQuality") or request.get("minimumMacroF1") or 0.75)
    minimum_class_rows = max(2, int(request.get("minimumClassRows") or 2))
    require_all_allowed_values = request.get("requireAllAllowedValues") is not False
    for column in columns:
        target = normalize_name(column.get("targetName") or column.get("name") or column.get("outputColumn"))
        allowed_values = [str(value) for value in column.get("allowedValues") or [] if str(value).strip()]
        if not target or not allowed_values:
            continue
        required_targets.append(target)
        try:
            train_payload = labeled_examples(train_rows, target, allowed_values, request)
            eval_payload = labeled_examples(eval_rows, target, allowed_values, request) if eval_rows else None
        except ValueError as exc:
            trained[target] = {
                "allowedValues": allowed_values,
                "reason": str(exc),
                "status": "failed_label_data",
                "trainRows": 0,
            }
            continue
        label_counts = Counter(train_payload["labels"])
        insufficient_classes = [
            value
            for value in allowed_values
            if label_counts.get(value, 0) < minimum_class_rows
        ]
        if require_all_allowed_values and insufficient_classes:
            trained[target] = {
                "allowedValues": allowed_values,
                "classCounts": {str(key): int(value) for key, value in label_counts.items()},
                "missingOrSparseClasses": insufficient_classes,
                "minimumClassRows": minimum_class_rows,
                "reason": "all_allowed_value_classes_require_minimum_rows",
                "status": "failed_class_coverage",
                "trainRows": len(train_payload["labels"]),
            }
            continue
        if len(set(train_payload["labels"])) < 2:
            trained[target] = {
                "status": "skipped",
                "reason": "at_least_two_label_classes_required",
                "trainRows": len(train_payload["labels"]),
            }
            continue
        artifact, metrics, candidate_evaluations = train_column_model(target, allowed_values, train_payload, eval_payload, request)
        artifact_name = f"{target}.portable_linear_svc.json"
        (output_dir / artifact_name).write_text(json.dumps(artifact, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        validation_counts = metrics.get("validationLabelCounts") or {}
        validation_covers_all_classes = all(int(validation_counts.get(value) or 0) > 0 for value in allowed_values)
        quality_passed = (
            metrics["accuracy"] >= minimum_quality
            and metrics["macroF1"] >= minimum_quality
            and validation_covers_all_classes
        )
        trained[target] = {
            "allowedValues": allowed_values,
            "artifact": artifact_name if quality_passed else "",
            "candidateArtifact": artifact_name,
            "candidateEvaluations": candidate_evaluations,
            "minimumQuality": minimum_quality,
            "metrics": metrics,
            "modelKind": artifact["modelKind"],
            "selectedCandidate": metrics.get("candidate"),
            "status": "trained" if quality_passed else "failed_quality_gate",
            "trainRows": metrics["trainRows"],
            "validationCoversAllClasses": validation_covers_all_classes,
            "validationRows": metrics["validationRows"],
        }

    promoted = bool(required_targets) and all(
        isinstance(trained.get(target), dict) and trained[target].get("status") == "trained"
        for target in required_targets
    )
    manifest = {
        "createdAt": utc_now(),
        "labelModels": label_models,
        "labelSource": label_source,
        "latestRuntimeDir": str(latest_dir),
        "modelKind": "portable_text_structuring_models",
        "outputDir": str(output_dir),
        "promotionStatus": "promoted" if promoted else "not_promoted",
        "source": request.get("source") if isinstance(request.get("source"), dict) else {},
        "templateName": str(request.get("templateName") or request.get("name") or "text_structuring_template"),
        "trainedModels": trained,
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    if promoted:
        artifact_digests = {}
        for target in required_targets:
            artifact_name = str(trained[target]["artifact"])
            artifact_digests[artifact_name] = sha256_file(output_dir / artifact_name)
            trained[target]["artifactSha256"] = artifact_digests[artifact_name]
        manifest["artifactSha256s"] = artifact_digests
        (output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        with publication_lock(latest_dir):
            staged_paths = []
            for target in required_targets:
                artifact_name = str(trained[target]["artifact"])
                temporary_path = latest_dir / f".{artifact_name}.{uuid4().hex}.tmp"
                shutil.copyfile(output_dir / artifact_name, temporary_path)
                staged_paths.append((temporary_path, latest_dir / artifact_name))
            for temporary_path, destination_path in staged_paths:
                os.replace(temporary_path, destination_path)
            manifest_temp = latest_dir / f".manifest.{uuid4().hex}.tmp"
            manifest_temp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(manifest_temp, latest_dir / "manifest.json")
    print(json.dumps(manifest, ensure_ascii=False))
    return 0


def read_request(input_path: str | None) -> dict[str, Any]:
    if input_path:
        text = Path(input_path).read_text(encoding="utf-8-sig")
    else:
        raw = sys.stdin.buffer.read()
        if b"\x00" in raw[:100]:
            text = raw.decode("utf-16", errors="ignore")
        else:
            text = raw.decode("utf-8-sig", errors="ignore")
    payload = json.loads(text or "{}")
    if not isinstance(payload, dict):
        raise ValueError("Training request must be a JSON object.")
    return payload


def train_column_model(
    target: str,
    allowed_values: list[str],
    train_payload: dict[str, Any],
    eval_payload: dict[str, Any] | None,
    request: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    train_rows = train_payload["rows"]
    train_texts = train_payload["texts"]
    train_labels = np.asarray(train_payload["labels"], dtype=str)
    if eval_payload:
        eval_rows = eval_payload["rows"]
        eval_texts = eval_payload["texts"]
        eval_labels = np.asarray(eval_payload["labels"], dtype=str)
        fit_texts = train_texts
        fit_rows = train_rows
        fit_labels = train_labels
    else:
        label_counts = Counter(train_labels)
        class_count = len(label_counts)
        stratify = train_labels if min(label_counts.values()) >= 2 else None
        requested_validation_rows = max(class_count, int(math.ceil(len(train_labels) * 0.25)))
        maximum_validation_rows = len(train_labels) - class_count
        validation_rows = min(requested_validation_rows, maximum_validation_rows)
        if stratify is None or validation_rows < class_count:
            raise ValueError(
                f"Target '{target}' requires at least two rows per class for class-covered validation."
            )
        split = train_test_split(
            train_rows,
            train_texts,
            train_labels,
            test_size=validation_rows,
            random_state=11,
            stratify=stratify,
        )
        fit_rows, eval_rows, fit_texts, eval_texts, fit_labels, eval_labels = split

    vectorizer = TfidfVectorizer(ngram_range=(1, 2), max_features=int(request.get("maxFeatures") or 12000), sublinear_tf=True, min_df=1)
    fit_text_matrix = vectorizer.fit_transform(fit_texts)
    eval_text_matrix = vectorizer.transform(eval_texts)
    dense_scale = float(request.get("denseScale") or 0.6)
    fit_matrix = hstack([fit_text_matrix, dense_matrix(fit_rows, dense_scale)])
    eval_matrix = hstack([eval_text_matrix, dense_matrix(eval_rows, dense_scale)])
    candidate_evaluations = []
    best = None
    for candidate in model_candidates(request):
        model = candidate["model"]
        try:
            model.fit(fit_matrix, fit_labels)
            predicted = model.predict(eval_matrix)
            metrics = {
                "accuracy": float(accuracy_score(eval_labels, predicted)),
                "candidate": candidate["name"],
                "macroF1": float(f1_score(eval_labels, predicted, average="macro", zero_division=0)),
                "method": candidate["name"],
                "modelKind": candidate["modelKind"],
                "trainRows": int(len(fit_labels)),
                "validationRows": int(len(eval_labels)),
                "validationLabelCounts": {str(key): int(value) for key, value in Counter(eval_labels).items()},
            }
            evaluation = {
                "accuracy": metrics["accuracy"],
                "candidate": candidate["name"],
                "macroF1": metrics["macroF1"],
                "modelKind": candidate["modelKind"],
                "status": "evaluated",
                "validationRows": metrics["validationRows"],
            }
            candidate_evaluations.append(evaluation)
            ranking = (metrics["macroF1"], metrics["accuracy"], -len(candidate_evaluations))
            if best is None or ranking > best["ranking"]:
                best = {
                    "candidate": candidate,
                    "metrics": metrics,
                    "model": model,
                    "ranking": ranking,
                }
        except Exception as exc:
            candidate_evaluations.append({
                "candidate": candidate["name"],
                "error": str(exc),
                "modelKind": candidate["modelKind"],
                "status": "failed",
            })
    if best is None:
        raise ValueError(f"No trainable candidate model succeeded for target '{target}'.")
    artifact = portable_artifact(
        target,
        allowed_values,
        best["model"],
        vectorizer,
        best["metrics"],
        dense_scale,
        best["candidate"]["modelKind"],
        request,
    )
    artifact["candidateEvaluations"] = candidate_evaluations
    return artifact, best["metrics"], candidate_evaluations


def model_candidates(request: dict[str, Any]) -> list[dict[str, Any]]:
    max_iter = int(request.get("maxIter") or 8000)
    base_c = float(request.get("C") or 0.6)
    return [
        {
            "model": LinearSVC(C=base_c, class_weight="balanced", max_iter=max_iter, random_state=7),
            "modelKind": "portable_tfidf_linear_svc",
            "name": "tfidf_linear_svc",
        },
        {
            "model": LinearSVC(C=max(base_c * 1.5, 1.0), class_weight="balanced", max_iter=max_iter, random_state=17),
            "modelKind": "portable_tfidf_linear_svc",
            "name": "tfidf_linear_svc_high_c",
        },
        {
            "model": LogisticRegression(C=max(base_c, 1.0), class_weight="balanced", max_iter=max_iter, random_state=29, solver="liblinear"),
            "modelKind": "portable_tfidf_logistic_regression",
            "name": "tfidf_logistic_regression",
        },
    ]


def labeled_examples(rows: list[dict[str, Any]], target: str, allowed_values: list[str], request: dict[str, Any]) -> dict[str, Any]:
    output_rows = []
    texts = []
    labels = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        label = row_label(row, target)
        label = canonical_allowed_value(label, allowed_values)
        if not label:
            continue
        output_rows.append(row)
        texts.append(row_text(row, request))
        labels.append(label)
    if not labels:
        raise ValueError(f"No labeled rows found for target '{target}'.")
    return {"rows": output_rows, "texts": texts, "labels": labels}


def row_label(row: dict[str, Any], target: str) -> str:
    labels = row.get("labels")
    if isinstance(labels, dict) and labels.get(target) is not None:
        return str(labels.get(target))
    outputs = row.get("outputs")
    if isinstance(outputs, dict) and outputs.get(target) is not None:
        return str(outputs.get(target))
    if row.get(target) is not None:
        return str(row.get(target))
    return ""


def row_text(row: dict[str, Any], request: dict[str, Any]) -> str:
    text_field = str(request.get("textField") or "text")
    title_field = str(request.get("titleField") or "title")
    text = row.get(text_field) or row.get("reviewText") or row.get("raw") or row.get("payload") or row.get("body") or ""
    title = row.get(title_field) or row.get("summary") or ""
    return clean_text(f"{title} {text}")


def dense_matrix(rows: list[dict[str, Any]], scale: float) -> csr_matrix:
    return csr_matrix(np.asarray([dense_features(row, scale) for row in rows], dtype=float))


def dense_features(row: dict[str, Any], scale: float) -> list[float]:
    text = row_text(row, {}).lower()
    rating = to_float(row.get("rating") or row.get("overall") or row.get("stars"))
    has_rating = rating > 0
    values = [
        rating / 5.0 if has_rating else 0.0,
        1.0 if has_rating and rating <= 1 else 0.0,
        1.0 if has_rating and rating <= 2 else 0.0,
        1.0 if has_rating and rating == 3 else 0.0,
        1.0 if has_rating and rating >= 4 else 0.0,
        1.0 if has_rating and rating == 5 else 0.0,
    ]
    for _name, pattern in DENSE_PATTERNS:
        values.append(1.0 if re.search(pattern, text) else 0.0)
    return [value * scale for value in values]


def portable_artifact(
    target: str,
    allowed_values: list[str],
    model: Any,
    vectorizer: TfidfVectorizer,
    metrics: dict[str, Any],
    dense_scale: float,
    model_kind: str,
    request: dict[str, Any],
) -> dict[str, Any]:
    vocabulary = vectorizer.vocabulary_
    ordered_vocab = sorted(vocabulary, key=vocabulary.get)
    return {
        "allowedValues": allowed_values,
        "classes": [str(value) for value in model.classes_.tolist()],
        "coef": [[float(value) for value in row] for row in np.asarray(model.coef_, dtype=float).tolist()],
        "dense": {
            "featureNames": [
                "rating_div_5",
                "rating_lte_1",
                "rating_lte_2",
                "rating_eq_3",
                "rating_gte_4",
                "rating_eq_5",
                *[name for name, _pattern in DENSE_PATTERNS],
            ],
            "patterns": DENSE_PATTERNS,
            "scale": dense_scale,
        },
        "intercept": [float(value) for value in np.asarray(model.intercept_, dtype=float).tolist()],
        "metrics": metrics,
        "modelKind": model_kind,
        "provenance": {
            "labelModels": [str(value) for value in request.get("labelModels") or []],
            "labelSource": str(request.get("labelSource") or "unknown"),
            "source": request.get("source") if isinstance(request.get("source"), dict) else {},
        },
        "targetName": target,
        "trainedAt": utc_now(),
        "vectorizer": {
            "idf": [float(value) for value in vectorizer.idf_.tolist()],
            "maxFeatures": int(vectorizer.max_features or 12000),
            "ngramRange": [1, 2],
            "norm": "l2",
            "sublinearTf": True,
            "tokenPattern": r"(?u)\b\w\w+\b",
            "vocabulary": ordered_vocab,
        },
    }


def canonical_allowed_value(value: Any, allowed_values: list[str]) -> str:
    normalized = str(value or "").strip().lower()
    for allowed in allowed_values:
        if str(allowed).strip().lower() == normalized:
            return str(allowed)
    return ""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@contextmanager
def publication_lock(latest_dir: Path):
    lock_dir = latest_dir.parent / ".review-model-publish.lock"
    deadline = time.monotonic() + 30.0
    while True:
        try:
            lock_dir.mkdir()
            break
        except FileExistsError:
            try:
                stale = time.time() - lock_dir.stat().st_mtime > 900
            except OSError:
                stale = False
            if stale:
                try:
                    lock_dir.rmdir()
                except OSError:
                    pass
                continue
            if time.monotonic() >= deadline:
                raise TimeoutError("Timed out waiting for the review model publication lock.")
            time.sleep(0.1)
    try:
        yield
    finally:
        try:
            lock_dir.rmdir()
        except OSError:
            pass


def text_method(column: dict[str, Any]) -> str:
    value = str(column.get("method") or column.get("analysisMethod") or "").strip().lower()
    aliases = {"classification": "one_of_values", "classify": "one_of_values", "copy_or_extract_field": "copy", "custom_instruction": "instruction"}
    return aliases.get(value, value)


def normalize_name(value: Any) -> str:
    return re.sub(r"_+", "_", re.sub(r"[^a-zA-Z0-9_]+", "_", str(value or "").strip()).strip("_")).lower()


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def to_float(value: Any) -> float:
    try:
        number = float(value)
        return number if math.isfinite(number) else 0.0
    except Exception:
        return 0.0


def run_id() -> str:
    return "run_" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"error": str(exc), "status": "failed"}, ensure_ascii=False), file=sys.stderr)
        raise
