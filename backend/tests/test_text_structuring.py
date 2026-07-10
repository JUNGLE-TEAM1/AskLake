import json
import tempfile
import unittest
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.models import CatalogDatasetModel
from app.schemas.text_structuring import (
    CreateTextStructuringSpecRequest,
    CreateTextTrainingRunRequest,
    TextStructuringPreviewRequest,
    TextStructuringSpecRef,
    TextStructuringSuggestionRequest,
    UpdateTextReviewItemRequest,
)
from app.services import text_structuring_service
from app.services.etl_service import merge_artifact_dataset_history
from app.services.text_structuring_compiler import compile_definition, definition_fingerprint
from app.services.text_structuring_inference import TextStructuringInferenceEngine, llm_eligible, mask_pii, prepare_rows


class TextStructuringGoldenTest(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = Settings(
            openai_api_key=None,
            text_structuring_api_key=None,
            text_structuring_external_provider_allowed=False,
        )
        self.definition = text_structuring_service.suggest_definition(
            TextStructuringSuggestionRequest(source_fields=["text"]),
            self.settings,
        ).definition
        self.engine = TextStructuringInferenceEngine(self.settings)

    def infer(self, text: str):
        rows, _, _ = self.engine.run(self.definition, [{"id": "row-1", "text": text}])
        return rows[0]

    def test_mixed_aspects_are_not_collapsed(self) -> None:
        row = self.infer("배터리 소모가 너무심하네요, 외관은 괜찮은 것 같아요")
        self.assertEqual("mixed", row.output["overall_sentiment"])
        self.assertEqual(["battery", "appearance"], row.output["issue_types"])
        self.assertEqual(
            [
                {"aspect": "battery", "sentiment": "negative", "severity": "high", "evidence": "배터리 소모가 너무심하네요"},
                {"aspect": "appearance", "sentiment": "positive", "severity": "low", "evidence": "외관은 괜찮은 것 같아요"},
            ],
            row.repeated_groups["aspects"],
        )

    def test_positive_battery_mention_is_not_critical(self) -> None:
        row = self.infer("배터리가 오래가서 정말 좋아요")
        self.assertEqual("positive", row.output["overall_sentiment"])
        self.assertEqual("low", row.output["severity"])
        self.assertEqual("battery", row.repeated_groups["aspects"][0]["aspect"])

    def test_negation_is_interpreted_in_context(self) -> None:
        self.assertEqual("positive", self.infer("배터리가 나쁘지 않고 좋아요").output["overall_sentiment"])
        self.assertEqual("negative", self.infer("디자인이 좋지 않아요").output["overall_sentiment"])

    def test_english_mixed_review(self) -> None:
        row = self.infer("The battery drains fast, but the design looks great.")
        self.assertEqual("mixed", row.output["overall_sentiment"])
        self.assertEqual(["battery", "appearance"], row.output["issue_types"])

    def test_duplicate_text_keeps_distinct_row_identity(self) -> None:
        rows, _, _ = self.engine.run(self.definition, [{"text": "좋아요"}, {"text": "좋아요"}])
        self.assertNotEqual(rows[0].source_row_id, rows[1].source_row_id)

    def test_pii_is_masked_before_external_payload(self) -> None:
        masked = mask_pii({"text": "mail me at user@example.com or 010-1234-5678"})
        self.assertEqual("mail me at [EMAIL] or [PHONE]", masked["text"])

    def test_definition_fingerprint_and_schema_are_deterministic(self) -> None:
        first = definition_fingerprint(self.definition)
        second = definition_fingerprint(self.definition.model_copy(deep=True))
        self.assertEqual(first, second)
        schema = compile_definition(self.definition)
        output_schema = schema["properties"]["rows"]["items"]["properties"]["output"]
        self.assertIn("overall_sentiment", output_schema["required"])
        changed = self.definition.model_copy(deep=True)
        changed.fields[0].description = "changed"
        self.assertNotEqual(first, definition_fingerprint(changed))

    def test_llm_fraction_routing_is_stable(self) -> None:
        definition = self.definition.model_copy(deep=True)
        definition.routing_policy.max_llm_fraction = 0.25
        rows = prepare_rows(definition, [{"id": f"row-{index}", "text": "sample"} for index in range(100)])
        first = [row["_asklake_source_row_id"] for row in rows if llm_eligible(definition, row)]
        second = [row["_asklake_source_row_id"] for row in rows if llm_eligible(definition, row)]
        self.assertEqual(first, second)
        self.assertGreater(len(first), 10)
        self.assertLess(len(first), 40)


class TextStructuringLifecycleTest(unittest.TestCase):
    def test_reviewed_rows_create_a_student_candidate(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        actor = ActorContext(name="tester", role="admin")
        with tempfile.TemporaryDirectory() as directory, Session(engine) as db:
            settings = Settings(
                openai_api_key=None,
                text_structuring_api_key=None,
                text_structuring_model_dir=directory,
            )
            definition = text_structuring_service.suggest_definition(
                TextStructuringSuggestionRequest(source_fields=["text"]),
                settings,
            ).definition
            spec = text_structuring_service.create_spec(
                db,
                CreateTextStructuringSpecRequest(name="review", definition=definition),
                actor,
            )
            version = text_structuring_service.publish_version(db, spec.id, 1, actor)
            spec_ref = TextStructuringSpecRef(
                spec_id=spec.id,
                version=1,
                fingerprint=version.fingerprint,
            )
            preview = text_structuring_service.preview(
                db,
                TextStructuringPreviewRequest(
                    spec_ref=spec_ref,
                    rows=[{"id": "r1", "text": "배터리가 너무 빨리 닳아요"}],
                    persist_review_items=True,
                ),
                actor,
                settings,
            )
            review = text_structuring_service.list_review_items(
                db,
                spec.id,
                actor,
                item_status="pending",
                limit=10,
            )[0]
            text_structuring_service.update_review_item(
                db,
                review.id,
                UpdateTextReviewItemRequest(status="corrected", correction=preview.rows[0].output),
                actor,
            )
            training = text_structuring_service.create_training_run(
                db,
                CreateTextTrainingRunRequest(spec_id=spec.id, spec_version=1),
                actor,
                settings,
            )
            self.assertEqual("success", training.status)
            self.assertIsNotNone(training.model_id)
            model = text_structuring_service.list_models(db, spec.id, actor)[0]
            artifact = json.loads(Path(model.artifact_uri).read_text(encoding="utf-8"))
            self.assertEqual("asklake-text-student-v1", artifact["artifactVersion"])
            self.assertFalse(model.metrics["calibrated"])
            text_structuring_service.promote_model(db, model.id, actor)
            student_preview = text_structuring_service.preview(
                db,
                TextStructuringPreviewRequest(
                    spec_ref=spec_ref,
                    rows=[{"id": "r2", "text": "배터리가 너무 빨리 닳아요"}],
                ),
                actor,
                settings,
            )
            self.assertEqual("student_review", student_preview.rows[0].route)
            self.assertEqual("student", student_preview.rows[0].field_meta["overall_sentiment"].route)


class SparkBatchContractTest(unittest.TestCase):
    def test_v2_runtime_uses_partition_batches(self) -> None:
        source = Path(__file__).resolve().parents[1] / "scripts" / "spark_job_run.py"
        text = source.read_text(encoding="utf-8")
        self.assertIn("prepared.rdd.mapPartitions(map_partition)", text)
        self.assertIn("call_text_structuring_batch_api", text)
        self.assertIn('artifact_report("quarantine"', text)

    def test_artifact_materialization_history_is_idempotent(self) -> None:
        run1 = {"createdAt": "2026-01-01", "rowCount": 2, "runId": "run-1", "status": "success", "storageSizeBytes": 10}
        run2 = {"createdAt": "2026-01-02", "rowCount": 3, "runId": "run-2", "status": "success", "storageSizeBytes": 20}
        existing = CatalogDatasetModel(id="ds__aspects", payload={"materializationRuns": [run1]})
        current = CatalogDatasetModel(id="ds__aspects", payload={"lastUpdated": "2026-01-02", "materializationRuns": [run2]})
        merge_artifact_dataset_history(existing, current)
        merge_artifact_dataset_history(existing, current)
        self.assertEqual(["run-2", "run-1"], [run["runId"] for run in current.payload["materializationRuns"]])
        self.assertEqual("5행", current.payload["rows"])


if __name__ == "__main__":
    unittest.main()
