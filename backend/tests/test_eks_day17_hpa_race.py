from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from scripts import run_eks_day17_hpa_race as race
from scripts.kafka_fixture_slots import EKS_MVP_FIXTURE_CONSUMER_GROUP


class _ScalarResult:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return list(self._rows)


class _Database:
    def __init__(self, runs, jobs):
        self._runs = runs
        self._jobs = jobs

    def scalars(self, _statement):
        return _ScalarResult(self._runs)

    def get(self, _model, job_id):
        return self._jobs.get(job_id)


def _run(job_id, consumer_group):
    return SimpleNamespace(
        job_id=job_id,
        task_states={
            "eksMvpFixture": {
                "sourceBoundary": {
                    "kind": "kafka_snapshot",
                    "topic": race.FIXTURE_TOPIC,
                    "consumerGroup": consumer_group,
                    "expectedCount": 100,
                }
            }
        },
    )


def _job(consumer_group):
    return SimpleNamespace(
        source_config=[
            ["TOPIC / QUEUE NAME", race.FIXTURE_TOPIC],
            ["CONSUMER GROUP ID", consumer_group],
        ],
        iceberg_target={"table": "unused-by-test"},
    )


class Day17HpaRaceFixtureSelectionTests(TestCase):
    @patch.object(
        race,
        "fixture_target",
        side_effect=lambda job: SimpleNamespace(
            table=job.iceberg_target["table"]
        ),
    )
    def test_multi_spark_candidates_do_not_replace_the_bounded_race_fixture(
        self, _fixture_target
    ):
        base_group = EKS_MVP_FIXTURE_CONSUMER_GROUP
        scale_groups = [
            "asklake-eks-mvp-spark-scale17-01",
            "asklake-eks-mvp-spark-scale17-02",
            "asklake-eks-mvp-spark-scale17-03",
        ]
        jobs = {"base": _job(base_group)}
        runs = [_run("base", base_group)]
        for index, group in enumerate(scale_groups, start=1):
            job_id = f"scale-{index}"
            jobs[job_id] = _job(group)
            runs.append(_run(job_id, group))

        selected = race.fixture_jobs(_Database(runs, jobs))

        self.assertEqual(selected, [jobs["base"]])

    @patch.object(
        race,
        "fixture_target",
        return_value=SimpleNamespace(table="eks_mvp_fixture"),
    )
    def test_current_job_group_must_match_the_persisted_base_boundary(
        self, _fixture_target
    ):
        base_group = EKS_MVP_FIXTURE_CONSUMER_GROUP
        jobs = {"base": _job("asklake-eks-mvp-spark-scale17-01")}
        runs = [_run("base", base_group)]

        self.assertEqual(race.fixture_jobs(_Database(runs, jobs)), [])
