# Airflow Orchestration SOT

This document is the source of truth for the AskLake Airflow orchestration work.
If this document conflicts with detailed API or architecture documents, update
those documents in the same phase instead of letting the contract drift.

## 1. Goal

Attach Airflow to AskLake job execution so that a user can click a job run
command, see the created run immediately, and keep seeing the run and DAG step
status update until the run reaches a terminal state.

The first version should wrap the existing Spark execution path with Airflow
orchestration. It should not attempt to build a production-grade DAG generator.

## 2. Phase Plan

### Phase 1. Branch And SOT Baseline

Status: complete.

Scope:

- Start from the latest remote `origin/dev`.
- Create a task branch for Airflow orchestration work.
- Add this SOT document.
- Preserve unrelated local/untracked files.

Acceptance criteria:

- The task branch is based on the latest known `origin/dev` commit.
- This document records the phased execution plan.
- No unrelated worktree changes are staged or committed.

### Phase 2. Contract And Documentation

Scope:

- Define the Airflow v1 execution boundary.
- Define job/run/DAG status mapping.
- Define polling behavior and terminal states.
- Update `docs/02-architecture.md`, `docs/03-api-reference.md`,
  `docs/api-contract.md`, and `docs/backend-integration-readiness.md` when the
  interface changes.

Acceptance criteria:

- `POST /api/etl/jobs/{jobId}/commands` is documented as an asynchronous run
  submission endpoint for `run` and `retry`.
- The status mapping table is documented.
- Deferred scope is explicit.

### Phase 3. Backend Airflow Adapter

Scope:

- Add a small backend adapter/service for Airflow API calls.
- Trigger a DAG run.
- Read DAG run state.
- Read task instance state.
- Keep Airflow connection details in backend environment variables only.

Acceptance criteria:

- Airflow API calls are isolated from `etl_service.py`.
- Missing Airflow configuration fails with a clear backend error.
- Unit-testable mapping helpers exist for status conversion.

### Phase 4. Run Persistence

Scope:

- Extend ETL run persistence with Airflow identifiers and sync metadata.
- Store task state snapshots without breaking the existing frontend response
  contract.

Candidate fields:

- `airflowDagId`
- `airflowDagRunId`
- `airflowRunUrl`
- `taskStates`
- `lastSyncedAt`
- `syncError`

Acceptance criteria:

- Existing `JobRunSummary` fields remain compatible.
- New Airflow fields are optional.
- Hydrated jobs can reconstruct `runsByJobId` and `dagStepsByRunId`.

### Phase 5. Async Command Flow

Scope:

- Change `run` and `retry` from synchronous Spark completion to Airflow run
  submission.
- Return `queued` or `running` immediately.
- Keep `pause` and `cancel` behavior explicit even if real Airflow/Spark
  interruption remains deferred.

Acceptance criteria:

- The command response contains `job`, `run`, and initial `dagSteps`.
- Duplicate run clicks are rejected or guarded.
- Backend errors use the standard error envelope.

### Phase 6. Frontend Polling

Scope:

- Poll running jobs/runs from the ingest list, run history, and DAG views.
- Reconcile server updates with optimistic local state.
- Stop polling terminal runs.

Acceptance criteria:

- A run created by Airflow appears immediately.
- Run History reflects status transitions.
- DAG view reflects task state transitions.
- Polling stops on `success`, `failed`, or `canceled`.

### Phase 7. Local Runtime And Verification

Scope:

- Add local Airflow runtime instructions or compose wiring.
- Add smoke verification for trigger, poll, DAG task mapping, and final catalog
  update.
- Run relevant backend and frontend checks.

Acceptance criteria:

- Airflow local startup is documented.
- A browser smoke can demonstrate run submission and status updates.
- `frontend` build and relevant backend verification pass or known blockers are
  documented.

## 3. Branch Baseline

Phase 1 uses the latest fetched `origin/dev` as the baseline.

Current Phase 1 baseline:

- Branch: `feature/airflow-orchestration`
- Upstream: `origin/dev`
- Baseline commit: `ad7228c7ba2ae8dfcfe65cb606b99c9ed6c2b66d`
- Baseline date: 2026-07-07

## 4. Status Mapping

AskLake keeps its current canonical values. Airflow states are mapped into the
existing frontend/backend contract.

| Airflow state | AskLake run status | AskLake DAG step status |
| --- | --- | --- |
| `queued`, `scheduled`, `deferred`, `up_for_retry` | `queued` | `pending` |
| `running` | `running` | `running` |
| `success` | `success` | `success` |
| `failed`, `upstream_failed` | `failed` | `failed` |
| `skipped`, `removed` | `failed` | `blocked` |
| canceled by AskLake | `canceled` | `blocked` |

If Airflow returns a state not listed here, the backend should keep the run in
`running` and include the raw state in sync metadata until a terminal state is
known.

## 5. V1 Airflow Boundary

In scope:

- One stable Airflow DAG for AskLake ETL execution, for example
  `asklake_etl_job`.
- DAG run configuration passed through `dag_run.conf`.
- Existing Spark runner reused from Airflow task execution.
- AskLake remains the source of truth for user-facing job and dataset metadata.
- Airflow is the source of truth for orchestration state while a run is active.

Out of scope for v1:

- Fully dynamic DAG generation per job.
- Production-grade scheduler ownership.
- Full Airflow permission model.
- Celery/Kubernetes executor hardening.
- Long-term log object storage beyond smoke/debug needs.
- Real Spark interruption for every pause/cancel path.

## 6. API Direction

Existing endpoint retained:

```text
POST /api/etl/jobs/{jobId}/commands
```

For `run` and `retry`, the endpoint should submit work to Airflow and return
quickly with a non-terminal run state.

Polling can start with:

```text
GET /api/etl/jobs/{jobId}
```

A run-specific endpoint may be added if the frontend needs narrower polling:

```text
GET /api/etl/jobs/{jobId}/runs/{runId}
```

## 7. Commit Guidance

Split commits by stable review boundary:

- SOT/contract docs.
- Backend Airflow adapter.
- Persistence/schema changes.
- Command flow changes.
- Frontend polling changes.
- Runtime/verification docs and scripts.

Do not stage unrelated local files when committing a phase.
