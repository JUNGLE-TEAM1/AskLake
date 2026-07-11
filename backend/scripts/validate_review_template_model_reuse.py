#!/usr/bin/env python
"""Validate reusable template-level review structuring models.

This script treats the existing 100 labeled Amazon review rows as the template
labeling sample and the disjoint 100 labeled rows as the large-run validation
sample. It trains reusable artifacts keyed by the final CSV template hash, then
evaluates candidate non-row-LLM methods for one-of-values columns.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import shutil
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import joblib
import numpy as np
from scipy.sparse import csr_matrix, hstack
from sklearn.exceptions import ConvergenceWarning
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score
from sklearn.pipeline import FeatureUnion, Pipeline
from sklearn.svm import LinearSVC
import warnings


warnings.filterwarnings("ignore", category=ConvergenceWarning)


REPO_ROOT = Path(__file__).resolve().parents[2]
EVAL_ROOT = REPO_ROOT / "output" / "nlp-eval"
VALIDATION_ROOT = EVAL_ROOT / "template-model-validation"
PORTABLE_RUNTIME_ROOT = VALIDATION_ROOT / "runtime"
PORTABLE_LATEST_ROOT = PORTABLE_RUNTIME_ROOT / "latest"

OLD_SAMPLE = EVAL_ROOT / "amazon_review_100_sample.jsonl"
OLD_GOLD = EVAL_ROOT / "amazon_review_100_gold.csv"
NEW_SAMPLE = EVAL_ROOT / "weak-signal-cellphones" / "new-100-audit" / "new_100_sample.jsonl"
NEW_GOLD = EVAL_ROOT / "weak-signal-cellphones" / "new-100-audit" / "new_100_gold_assistant.csv"
EMBEDDINGS = EVAL_ROOT / "weak-signal-cellphones" / "new-100-audit" / "emb_sentence-transformers__all-MiniLM-L6-v2.npz"

TEMPLATE_COLUMNS = [
    {
        "allowedValues": ["positive", "mixed", "negative"],
        "method": "one_of_values",
        "sourceField": "text",
        "targetName": "sentiment",
        "type": "String",
    },
    {
        "allowedValues": ["issue", "no_issue"],
        "method": "one_of_values",
        "sourceField": "text",
        "targetName": "issue_present",
        "type": "String",
    },
    {
        "allowedValues": ["action_needed", "low_or_none"],
        "method": "one_of_values",
        "sourceField": "text",
        "targetName": "action_needed",
        "type": "String",
    },
    {
        "instruction": "Extract the source sentence that best supports the output.",
        "method": "instruction",
        "sourceField": "text",
        "targetName": "evidence",
        "type": "String",
    },
    {
        "instruction": "Summarize the row in one short factual sentence.",
        "method": "instruction",
        "sourceField": "text",
        "targetName": "summary",
        "type": "String",
    },
]

DETAILED_PROBE_COLUMNS = ["issue_category", "severity"]

PORTABLE_MODEL_SETTINGS = {
    "action_needed": {"C": 1.0, "classWeight": "balanced", "denseScale": 40.0, "maxFeatures": 8000, "maxIter": 5000, "ngramRange": [1, 2]},
    "issue_present": {
        "C": 5.0,
        "bootstrapRepeat": 8,
        "classWeight": "balanced",
        "denseScale": 80.0,
        "maxFeatures": 1000,
        "maxIter": 10000,
        "ngramRange": [1, 1],
    },
    "sentiment": {"C": 1.0, "classWeight": "balanced", "denseScale": 120.0, "maxFeatures": 8000, "maxIter": 5000, "ngramRange": [1, 2]},
}

PORTABLE_DENSE_PATTERNS = [
    ["negative_signal", r"bad|poor|broken|broke|defective|refund|return|waste|not work|doesn.?t work|stopped|dead|disappointed|wrong|missing|fail"],
    ["positive_signal", r"great|perfect|love|excellent|works well|good|easy|recommend|happy"],
    ["contrast_signal", r"but|however|except|though|although"],
    ["product_issue_signal", r"charge|charger|battery|power|screen|display|fit|wrong|missing"],
]

ISSUE_PRESENT_NO_ISSUE_BOOTSTRAP_TEXTS = [
    "Great cable. Works perfectly with my phone and charges fast.",
    "Excellent product. No problems and works as expected.",
    "Love it. Easy to use and good quality.",
    "Perfect fit. Good case and no issues.",
    "Works well. Happy with this purchase.",
    "Great value and reliable every day.",
    "Good quality, easy installation, recommend it.",
    "Fast charging cable works perfectly.",
    "Exactly what I needed. Great product.",
    "Five stars. No complaints at all.",
    "Works perfectly and arrived quickly.",
    "Solid phone case with good buttons.",
    "Nice accessory, no issue after weeks.",
    "Good charger and reliable power.",
    "Perfect replacement cable.",
]


@dataclass(frozen=True)
class DatasetSplit:
    embeddings: np.ndarray
    ratings: np.ndarray
    rows: list[dict[str, Any]]
    texts: list[str]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="retrain even if the template hash already has a model manifest")
    args = parser.parse_args()

    old_split, new_split = load_splits()
    template_hash = stable_template_hash(TEMPLATE_COLUMNS)
    model_dir = VALIDATION_ROOT / "models" / template_hash
    model_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = model_dir / "manifest.json"

    reused = manifest_path.exists() and not args.force
    if reused:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        manifest = train_artifacts(model_dir, old_split, template_hash)

    candidate_metrics = evaluate_candidates(old_split, new_split)
    portable_manifest = train_portable_runtime_artifacts(model_dir, old_split, new_split, template_hash)
    selected = select_runtime_methods(candidate_metrics)
    preview_rows = build_output_preview(old_split, new_split, selected)
    selected = merge_portable_runtime_selection(selected, portable_manifest)

    VALIDATION_ROOT.mkdir(parents=True, exist_ok=True)
    results = {
        "candidateMetrics": candidate_metrics,
        "evaluationProtocol": {
            "evalRows": len(new_split.rows),
            "gold": str(NEW_GOLD.relative_to(REPO_ROOT)),
            "minimumRows": 100,
            "sampleRows": len(old_split.rows),
            "sampleSource": str(OLD_SAMPLE.relative_to(REPO_ROOT)),
            "validationSource": str(NEW_SAMPLE.relative_to(REPO_ROOT)),
        },
        "modelDir": str(model_dir.relative_to(REPO_ROOT)),
        "portableRuntime": portable_manifest,
        "reused": reused,
        "selectedRuntimeMethods": selected,
        "templateColumns": TEMPLATE_COLUMNS,
        "templateHash": template_hash,
    }
    (VALIDATION_ROOT / "template_model_validation_results.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    write_preview_csv(VALIDATION_ROOT / "template_model_preview_new100.csv", preview_rows)
    write_summary(VALIDATION_ROOT / "template_model_validation_summary.md", results)
    print(json.dumps(results, ensure_ascii=False, indent=2))


def load_splits() -> tuple[DatasetSplit, DatasetSplit]:
    old_rows = join_rows(OLD_SAMPLE, OLD_GOLD)
    new_rows = join_rows(NEW_SAMPLE, NEW_GOLD)
    embeddings = np.load(EMBEDDINGS)
    return (
        DatasetSplit(
            embeddings=np.asarray(embeddings["old"], dtype=np.float32),
            ratings=np.asarray([float(row.get("rating") or 0) for row in old_rows], dtype=np.float32),
            rows=old_rows,
            texts=[review_text(row) for row in old_rows],
        ),
        DatasetSplit(
            embeddings=np.asarray(embeddings["new"], dtype=np.float32),
            ratings=np.asarray([float(row.get("rating") or 0) for row in new_rows], dtype=np.float32),
            rows=new_rows,
            texts=[review_text(row) for row in new_rows],
        ),
    )


def join_rows(sample_path: Path, gold_path: Path) -> list[dict[str, Any]]:
    labels = {row["id"]: row for row in csv.DictReader(gold_path.open(encoding="utf-8"))}
    rows: list[dict[str, Any]] = []
    for line in sample_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        row_id = str(row.get("id") or "")
        if row_id not in labels:
            continue
        merged = {**row, **labels[row_id]}
        merged["doc"] = row.get("doc") or f"{row.get('title', '')}. {row.get('text', '')}".strip()
        rows.append(merged)
    return rows


def stable_template_hash(columns: list[dict[str, Any]]) -> str:
    payload = json.dumps(columns, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def train_artifacts(model_dir: Path, split: DatasetSplit, template_hash: str) -> dict[str, Any]:
    trained_columns: dict[str, Any] = {}
    for field in ["sentiment", "issue_present", "action_needed"]:
        y = labels_for_field(split.rows, field)
        logreg = fit_embedding_logreg(split.embeddings, split.ratings, y)
        joblib.dump(logreg, model_dir / f"{field}.embed_logreg.joblib")

        tfidf = fit_tfidf_svc(split.texts, y)
        joblib.dump(tfidf, model_dir / f"{field}.tfidf_wordchar_svc.joblib")

        centroids = fit_centroids(split.embeddings, y)
        (model_dir / f"{field}.centroids.json").write_text(
            json.dumps(centroids, ensure_ascii=False),
            encoding="utf-8",
        )
        trained_columns[field] = {
            "allowedValues": sorted(set(y.tolist())),
            "artifacts": [
                f"{field}.embed_logreg.joblib",
                f"{field}.tfidf_wordchar_svc.joblib",
                f"{field}.centroids.json",
            ],
            "rows": len(split.rows),
        }
    manifest = {
        "modelKind": "template_reusable_one_of_values",
        "templateHash": template_hash,
        "trainedColumns": trained_columns,
        "trainRows": len(split.rows),
    }
    (model_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def train_portable_runtime_artifacts(
    model_dir: Path,
    old_split: DatasetSplit,
    new_split: DatasetSplit,
    template_hash: str,
) -> dict[str, Any]:
    runtime_dir = model_dir / "runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    if PORTABLE_LATEST_ROOT.exists():
        shutil.rmtree(PORTABLE_LATEST_ROOT)
    PORTABLE_LATEST_ROOT.mkdir(parents=True, exist_ok=True)

    trained: dict[str, Any] = {}
    for field, settings in PORTABLE_MODEL_SETTINGS.items():
        train_rows, train_texts, y_train = portable_training_rows(old_split, field, settings)
        y_eval = labels_for_field(new_split.rows, field)
        train_label_counts = {str(key): int(value) for key, value in Counter([str(value) for value in y_train]).items()}
        ngram_range = settings.get("ngramRange") or [1, 2]
        vectorizer = TfidfVectorizer(
            ngram_range=(int(ngram_range[0]), int(ngram_range[1])),
            max_features=int(settings.get("maxFeatures") or 8000),
            sublinear_tf=True,
            min_df=1,
        )
        train_text_matrix = vectorizer.fit_transform(train_texts)
        eval_text_matrix = vectorizer.transform(new_split.texts)
        train_matrix = hstack([
            train_text_matrix,
            portable_dense_matrix(train_rows, settings["denseScale"]),
        ])
        eval_matrix = hstack([
            eval_text_matrix,
            portable_dense_matrix(new_split.rows, settings["denseScale"]),
        ])
        model = LinearSVC(
            C=settings["C"],
            class_weight=settings.get("classWeight") or None,
            max_iter=settings["maxIter"],
            random_state=7,
        )
        model.fit(train_matrix, y_train)
        predicted = model.predict(eval_matrix)
        metrics = score_predictions("portable_tfidf_linear_svc", field, y_eval, predicted)
        artifact = portable_linear_svc_artifact(
            field=field,
            metrics=metrics,
            model=model,
            settings=settings,
            template_hash=template_hash,
            vectorizer=vectorizer,
        )
        artifact_name = f"{field}.portable_linear_svc.json"
        for target_dir in (runtime_dir, PORTABLE_LATEST_ROOT):
            (target_dir / artifact_name).write_text(
                json.dumps(artifact, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
        trained[field] = {
            "accuracy": metrics["accuracy"],
            "artifact": artifact_name,
            "bootstrapRows": max(len(train_rows) - len(old_split.rows), 0),
            "runtimeTrainLabelCounts": train_label_counts,
            "runtimeTrainRows": len(train_rows),
            "macroF1": metrics["macroF1"],
            "method": "portable_tfidf_linear_svc",
        }

    manifest = {
        "modelKind": "portable_review_text_models",
        "models": trained,
        "runtimeDir": str(runtime_dir.relative_to(REPO_ROOT)),
        "templateHash": template_hash,
        "trainRows": len(old_split.rows),
        "validationRows": len(new_split.rows),
    }
    for target_dir in (runtime_dir, PORTABLE_LATEST_ROOT):
        (target_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        **manifest,
        "latestRuntimeDir": str(PORTABLE_LATEST_ROOT.relative_to(REPO_ROOT)),
    }


def portable_training_rows(
    split: DatasetSplit,
    field: str,
    settings: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[str], np.ndarray]:
    rows = list(split.rows)
    texts = list(split.texts)
    labels = labels_for_field(split.rows, field).astype(str).tolist()
    if field == "issue_present":
        repeat = int(settings.get("bootstrapRepeat") or 0)
        for _ in range(max(repeat, 0)):
            for text in ISSUE_PRESENT_NO_ISSUE_BOOTSTRAP_TEXTS:
                rows.append({"doc": text, "rating": 5})
                texts.append(text)
                labels.append("no_issue")
    return rows, texts, np.asarray(labels)


def portable_dense_matrix(rows: list[dict[str, Any]], scale: float) -> csr_matrix:
    matrix = []
    for row in rows:
        matrix.append(portable_dense_features(row, scale))
    return csr_matrix(np.asarray(matrix, dtype=float))


def portable_dense_features(row: dict[str, Any], scale: float) -> list[float]:
    text = review_text(row).lower()
    rating = float(row.get("rating") or 0)
    values = [
        rating / 5.0,
        1.0 if rating <= 1 else 0.0,
        1.0 if rating <= 2 else 0.0,
        1.0 if rating == 3 else 0.0,
        1.0 if rating >= 4 else 0.0,
        1.0 if rating == 5 else 0.0,
    ]
    for _name, pattern in PORTABLE_DENSE_PATTERNS:
        values.append(1.0 if re.search(pattern, text) else 0.0)
    return [value * scale for value in values]


def portable_linear_svc_artifact(
    *,
    field: str,
    metrics: dict[str, Any],
    model: LinearSVC,
    settings: dict[str, Any],
    template_hash: str,
    vectorizer: TfidfVectorizer,
) -> dict[str, Any]:
    vocabulary = vectorizer.vocabulary_
    ordered_vocab = sorted(vocabulary, key=vocabulary.get)
    return {
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
                *[name for name, _pattern in PORTABLE_DENSE_PATTERNS],
            ],
            "patterns": PORTABLE_DENSE_PATTERNS,
            "scale": settings["denseScale"],
        },
        "intercept": [float(value) for value in np.asarray(model.intercept_, dtype=float).tolist()],
        "metrics": metrics,
        "modelKind": "portable_tfidf_linear_svc",
        "settings": settings,
        "targetName": field,
        "templateHash": template_hash,
        "trainedAt": "generated-by-validate-review-template-model-reuse",
        "vectorizer": {
            "idf": [float(value) for value in vectorizer.idf_.tolist()],
            "maxFeatures": int(settings.get("maxFeatures") or 8000),
            "ngramRange": [int(value) for value in settings.get("ngramRange", [1, 2])],
            "norm": "l2",
            "sublinearTf": True,
            "tokenPattern": r"(?u)\b\w\w+\b",
            "vocabulary": ordered_vocab,
        },
    }


def evaluate_candidates(old_split: DatasetSplit, new_split: DatasetSplit) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for field in ["sentiment", "issue_present", "action_needed", *DETAILED_PROBE_COLUMNS]:
        y_train = labels_for_field(old_split.rows, field)
        y_eval = labels_for_field(new_split.rows, field)
        if field in {"sentiment", "issue_present", "action_needed"}:
            results.append(score_predictions("rating_signal_rule", field, y_eval, rating_signal_predictions(new_split.rows, field)))
        results.append(
            score_predictions(
                "embed_centroid_template",
                field,
                y_eval,
                predict_centroids(fit_centroids_array(old_split.embeddings, y_train), new_split.embeddings),
            )
        )
        results.append(
            score_predictions(
                "embed_logreg_template",
                field,
                y_eval,
                fit_embedding_logreg(old_split.embeddings, old_split.ratings, y_train).predict(
                    embedding_features(new_split.embeddings, new_split.ratings)
                ),
            )
        )
        results.append(
            score_predictions(
                "tfidf_wordchar_svc_template",
                field,
                y_eval,
                fit_tfidf_svc(old_split.texts, y_train).predict(new_split.texts),
            )
        )
    return results


def select_runtime_methods(metrics: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    selected: dict[str, dict[str, Any]] = {}
    runtime_fields = {"sentiment", "issue_present", "action_needed"}
    for field in runtime_fields:
        candidates = [row for row in metrics if row["field"] == field]
        best = max(candidates, key=lambda row: (row["accuracy"], row["macroF1"]))
        selected[field] = {
            "accuracy": best["accuracy"],
            "macroF1": best["macroF1"],
            "method": best["method"],
        }
    return selected


def merge_portable_runtime_selection(
    selected: dict[str, dict[str, Any]],
    portable_manifest: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    merged = {field: dict(detail) for field, detail in selected.items()}
    for field, detail in (portable_manifest.get("models") or {}).items():
        if not isinstance(detail, dict):
            continue
        if detail.get("method") != "portable_tfidf_linear_svc":
            continue
        merged[field] = {
            "accuracy": detail.get("accuracy"),
            "artifact": detail.get("artifact"),
            "macroF1": detail.get("macroF1"),
            "method": "portable_tfidf_linear_svc",
        }
    return merged


def labels_for_field(rows: list[dict[str, Any]], field: str) -> np.ndarray:
    if field == "issue_present":
        return np.asarray(["issue" if row.get("issue_category") != "no_issue" else "no_issue" for row in rows])
    if field == "action_needed":
        return np.asarray([
            "action_needed" if row.get("severity") in {"critical", "high", "medium"} else "low_or_none"
            for row in rows
        ])
    return np.asarray([str(row.get(field) or "") for row in rows])


def review_text(row: dict[str, Any]) -> str:
    return str(row.get("doc") or f"{row.get('title', '')}. {row.get('text', '')}").strip()


def embedding_features(embeddings: np.ndarray, ratings: np.ndarray) -> np.ndarray:
    return np.hstack([embeddings, ratings.reshape(-1, 1) / 5.0])


def fit_embedding_logreg(embeddings: np.ndarray, ratings: np.ndarray, labels: np.ndarray) -> LogisticRegression:
    model = LogisticRegression(max_iter=2000, class_weight="balanced", C=0.5, random_state=7)
    model.fit(embedding_features(embeddings, ratings), labels)
    return model


def fit_tfidf_svc(texts: list[str], labels: np.ndarray) -> Pipeline:
    model = Pipeline([
        ("features", FeatureUnion([
            ("word", TfidfVectorizer(ngram_range=(1, 2), max_features=20000, sublinear_tf=True)),
            ("char", TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), max_features=30000, sublinear_tf=True)),
        ])),
        ("clf", LinearSVC(C=0.4, class_weight="balanced", random_state=7)),
    ])
    model.fit(texts, labels)
    return model


def fit_centroids(embeddings: np.ndarray, labels: np.ndarray) -> dict[str, list[float]]:
    centroids = fit_centroids_array(embeddings, labels)
    return {label: vector.astype(float).tolist() for label, vector in centroids.items()}


def fit_centroids_array(embeddings: np.ndarray, labels: np.ndarray) -> dict[str, np.ndarray]:
    centroids: dict[str, np.ndarray] = {}
    for label in sorted(set(labels.tolist())):
        vector = embeddings[labels == label].mean(axis=0)
        norm = np.linalg.norm(vector)
        centroids[label] = vector / norm if norm else vector
    return centroids


def predict_centroids(centroids: dict[str, np.ndarray], embeddings: np.ndarray) -> np.ndarray:
    labels = sorted(centroids)
    matrix = np.vstack([centroids[label] for label in labels])
    normalized = embeddings.copy()
    norms = np.linalg.norm(normalized, axis=1, keepdims=True)
    norms[norms == 0] = 1
    normalized = normalized / norms
    indexes = (normalized @ matrix.T).argmax(axis=1)
    return np.asarray([labels[index] for index in indexes])


def score_predictions(method: str, field: str, gold: np.ndarray, predicted: np.ndarray) -> dict[str, Any]:
    return {
        "accuracy": round(float(accuracy_score(gold, predicted)), 4),
        "field": field,
        "macroF1": round(float(f1_score(gold, predicted, average="macro", zero_division=0)), 4),
        "method": method,
        "predictedCounts": dict(Counter([str(value) for value in predicted])),
    }


def rating_signal_predictions(rows: list[dict[str, Any]], field: str) -> np.ndarray:
    if field == "sentiment":
        return np.asarray([rating_signal_sentiment(row) for row in rows])
    if field == "issue_present":
        return np.asarray([rating_signal_issue_present(row) for row in rows])
    if field == "action_needed":
        return np.asarray([rating_signal_action_needed(row) for row in rows])
    raise ValueError(f"Unsupported rating signal field: {field}")


def rating_signal_sentiment(row: dict[str, Any]) -> str:
    rating = float(row.get("rating") or 0)
    text = review_text(row).lower()
    if rating <= 2:
        return "negative"
    if rating == 3:
        return "mixed"
    if any(token in text for token in ["but", "however", "except", "issue", "problem", "broke", "broken", "stopped", "not "]):
        return "mixed"
    return "positive"


def rating_signal_issue_present(row: dict[str, Any]) -> str:
    rating = float(row.get("rating") or 0)
    text = review_text(row).lower()
    negative_hint = any(token in text for token in ["but", "problem", "issue", "broke", "broken", "not ", "doesn"])
    return "no_issue" if rating >= 5 and not negative_hint else "issue"


def rating_signal_action_needed(row: dict[str, Any]) -> str:
    rating = float(row.get("rating") or 0)
    text = review_text(row).lower()
    action_hint = any(
        token in text
        for token in [
            "defective",
            "stopped working",
            "not work",
            "does not work",
            "did not work",
            "broke",
            "broken",
            "refund",
            "return",
            "danger",
            "fire",
        ]
    )
    return "action_needed" if rating <= 2 or action_hint else "low_or_none"


def build_output_preview(
    old_split: DatasetSplit,
    new_split: DatasetSplit,
    selected: dict[str, dict[str, Any]],
) -> list[dict[str, str]]:
    predicted = {
        field: predict_field_by_method(field, detail["method"], old_split, new_split)
        for field, detail in selected.items()
    }
    preview: list[dict[str, str]] = []
    for index, row in enumerate(new_split.rows[:25]):
        text = review_text(row)
        sentiment = str(predicted["sentiment"][index])
        issue_present = str(predicted["issue_present"][index])
        action_needed = str(predicted["action_needed"][index])
        evidence = extract_evidence(text)
        preview.append({
            "action_needed": action_needed,
            "asin": str(row.get("asin") or ""),
            "evidence": evidence,
            "issue_present": issue_present,
            "rating": str(row.get("rating") or ""),
            "review_id": str(row.get("id") or ""),
            "sentiment": sentiment,
            "summary": summarize_from_evidence(evidence, sentiment, action_needed),
        })
    return preview


def predict_field_by_method(field: str, method: str, old_split: DatasetSplit, new_split: DatasetSplit) -> np.ndarray:
    if method == "rating_signal_rule":
        return rating_signal_predictions(new_split.rows, field)
    y_train = labels_for_field(old_split.rows, field)
    if method == "embed_centroid_template":
        return predict_centroids(fit_centroids_array(old_split.embeddings, y_train), new_split.embeddings)
    if method == "embed_logreg_template":
        model = fit_embedding_logreg(old_split.embeddings, old_split.ratings, y_train)
        return model.predict(embedding_features(new_split.embeddings, new_split.ratings))
    if method == "tfidf_wordchar_svc_template":
        model = fit_tfidf_svc(old_split.texts, y_train)
        return model.predict(new_split.texts)
    raise ValueError(f"Unsupported selected method: {method}")


def extract_evidence(text: str) -> str:
    sentences = [part.strip() for part in re.split(r"(?<=[.!?])\s+", text) if part.strip()]
    if not sentences:
        return text[:180]
    priority = re.compile(
        r"(defective|stopped working|not work|does not work|did not work|broke|broken|charge|battery|"
        r"screen|fit|wrong|return|refund|great|love|perfect|excellent|problem|issue)",
        re.I,
    )
    return next((sentence for sentence in sentences if priority.search(sentence)), sentences[0])[:240]


def summarize_from_evidence(evidence: str, sentiment: str, action_needed: str) -> str:
    cleaned = evidence.strip().rstrip(".")
    prefix = "Action issue" if action_needed == "action_needed" else sentiment.capitalize()
    return f"{prefix}: {cleaned}."[:260]


def write_preview_csv(path: Path, rows: list[dict[str, str]]) -> None:
    if not rows:
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def write_summary(path: Path, results: dict[str, Any]) -> None:
    lines = [
        "# Template Model Validation",
        "",
        f"- Template hash: `{results['templateHash']}`",
        f"- Reused existing model manifest: `{results['reused']}`",
        f"- Sample rows: `{results['evaluationProtocol']['sampleRows']}`",
        f"- Eval rows: `{results['evaluationProtocol']['evalRows']}`",
        "",
        "## Selected runtime methods",
        "",
    ]
    for field, detail in sorted(results["selectedRuntimeMethods"].items()):
        train_note = ""
        portable_detail = (results.get("portableRuntime", {}).get("models") or {}).get(field) or {}
        if portable_detail:
            train_note = (
                f" / runtime train rows `{portable_detail.get('runtimeTrainRows')}`"
                f" / labels `{portable_detail.get('runtimeTrainLabelCounts')}`"
            )
        lines.append(
            f"- `{field}`: `{detail['method']}` / accuracy `{detail['accuracy']}`"
            f" / macro F1 `{detail['macroF1']}`{train_note}"
        )
    lines.extend(["", "## Candidate metrics", ""])
    for row in results["candidateMetrics"]:
        lines.append(f"- `{row['field']}` / `{row['method']}`: accuracy `{row['accuracy']}`, macro F1 `{row['macroF1']}`")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
