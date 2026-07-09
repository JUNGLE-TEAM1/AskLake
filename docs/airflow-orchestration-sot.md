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

Status: complete.

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

Phase 2 output:

- Architecture, public API, detailed API contract, backend readiness, and
  development guide documents now describe the same Airflow v1 target contract.

### Phase 3. Backend Airflow Adapter

Status: complete.

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

Phase 3 output:

- `backend/app/services/airflow_client.py` isolates Airflow public API calls.
- The adapter uses Airflow 3 public `/api/v2` DAG Run and Task Instance paths.
- `airflow_run_status`, `airflow_step_status`, and
  `airflow_run_is_terminal` are covered by backend unit tests.
- At Phase 3, `etl_service.py` still used the current Spark runner. Phase 5
  later switched `run` and `retry` command flow to Airflow submit.

### Phase 4. Run Persistence

Status: complete.

Scope:

- Extend ETL run persistence with Airflow identifiers and sync metadata.
- Store task state snapshots without breaking the existing frontend response
  contract.

Candidate fields:

- `airflowDagId`
- `airflowDagRunId`
- `airflowRunUrl`
- `airflowState`
- `taskStates`
- `lastSyncedAt`
- `syncError`

Acceptance criteria:

- Existing `JobRunSummary` fields remain compatible.
- New Airflow fields are optional.
- Hydrated jobs can reconstruct `runsByJobId` and `dagStepsByRunId`.

Phase 4 output:

- `etl_runs` can persist optional Airflow DAG id, DAG Run id, UI URL, raw
  Airflow state, task state snapshots, sync timestamp, and sync error.
- `JobRunSummary` exposes the same metadata as optional camelCase fields.
- `etl_repository.ensure_schema` adds the new run columns to existing local
  metadata databases.
- Phase 5 writes Airflow submit metadata into these fields for `run` and
  `retry` command responses.

### Phase 5. Async Command Flow

Status: complete.

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

Phase 5 output:

- `run` and `retry` now submit an Airflow DAG Run through
  `backend/app/services/airflow_client.py` instead of waiting for the local
  Spark runner to finish.
- The command response persists and returns a non-terminal `JobRunSummary`
  with Airflow DAG id, DAG Run id, UI URL, raw Airflow state, and sync
  timestamp.
- The response includes initial DAG steps led by `Airflow DAG Run 접수`; Task
  Instance-level updates remain Phase 6 polling work.
- Duplicate `run` and `retry` commands are rejected while the job is already
  `running`.
- `pause` and `cancel` remain explicit local state transitions; real
  Airflow/Spark interrupt remains deferred.

### Phase 6. Frontend Polling

Status: implemented. Live Airflow smoke verification remains Phase 7 scope.

Scope:

- Poll running jobs/runs from the ingest list, run history, and DAG views.
- Reconcile server updates with optimistic local state.
- Stop polling terminal runs.

Acceptance criteria:

- A run created by Airflow appears immediately.
- Run History reflects status transitions.
- DAG view reflects task state transitions.
- Polling stops on `success`, `failed`, or `canceled`.

Phase 6 output:

- `GET /api/etl/jobs/{jobId}` now syncs active Airflow DAG Run and Task
  Instance state into persisted `JobRunSummary`, `taskStates`, and
  `dagStepsByRunId` before returning the job.
- Frontend live mode polls jobs with `queued` or `running` runs through
  `GET /api/etl/jobs/{jobId}` and reconciles the result into
  `runsByJobId`, `selectedRunIdByJobId`, and `dagStepsByRunId`.
- Polling stops naturally when no job has an active `queued` or `running` run.
- Airflow sync failures are preserved in run `syncError` and surfaced through
  frontend sync-failure feedback without breaking the whole job hydrate.

### Phase 7. Local Runtime And Verification

Status: implemented. Local Airflow compose wiring and the smoke DAG are now
available; live smoke still requires running Docker services and restarting the
backend with Airflow env.

Scope:

- Add local Airflow runtime instructions or compose wiring.
- Add smoke verification for trigger, poll, DAG task mapping, and final catalog
  update.
- Run relevant backend and frontend checks.

Acceptance criteria:

- Airflow local startup is documented, or the missing runtime wiring is recorded
  as the blocker.
- A browser smoke can demonstrate run submission and status updates when
  `AIRFLOW_API_BASE_URL` points at a reachable Airflow API.
- `frontend` build and relevant backend verification pass or known blockers are
  documented.

Phase 7 output:

- The local `docker-compose.yml` includes an Airflow API server, scheduler,
  DAG processor, Airflow metadata Postgres, and the stable `asklake_etl_job`
  smoke DAG under `airflow/dags/`.
- Backend Airflow configuration fails clearly with `AIRFLOW_CONFIG_MISSING`
  when `AIRFLOW_API_BASE_URL` is not set.
- Verified checks on 2026-07-09:
  - `backend`: `npm run verify`
  - `backend`: Airflow status mapping/config smoke through
    `app.services.airflow_client`
  - `backend`: `PYTHONPYCACHEPREFIX=/private/tmp/asklake-clean-pycache ./.venv/bin/python -c 'import app.main; print("import-ok")'`
  - `frontend`: `npm run build`
  - live server checks: `GET /api/health`, `GET /api/etl/jobs`, and browser load
    at `http://127.0.0.1:5174/`

Local Airflow runtime options:

1. Run the repo-local Airflow services with `docker compose up airflow-init`
   followed by `docker compose up -d airflow-apiserver airflow-scheduler
   airflow-dag-processor`.
2. Point the backend at that Airflow API by setting the environment variables
   below before starting FastAPI.

Required backend environment variables for live Airflow:

```bash
AIRFLOW_API_BASE_URL=http://127.0.0.1:8081
AIRFLOW_DAG_ID=asklake_etl_job
AIRFLOW_UI_BASE_URL=http://127.0.0.1:8081
# Use either token auth or username/password auth, depending on the Airflow API.
AIRFLOW_API_TOKEN=
AIRFLOW_USERNAME=
AIRFLOW_PASSWORD=
AIRFLOW_REQUEST_TIMEOUT_SECONDS=10
```

Manual smoke once Airflow is reachable:

1. Start Postgres/MinIO and the FastAPI backend.
2. Start Airflow with a DAG named `asklake_etl_job`.
3. Start the frontend in live mode.
4. Create or select an ETL job and run it.
5. Confirm the new run appears immediately in Run History.
6. Confirm `GET /api/etl/jobs/{jobId}` polling updates the selected run and DAG
   modal from Airflow DAG Run and Task Instance state.
7. Confirm polling stops after `success`, `failed`, or `canceled`.
8. For a failed DAG run, confirm the failed task and `syncError`/error summary
   are visible.

## 3. Branch Baseline

Phase 1 uses the latest fetched `origin/dev` as the baseline.

Current Phase 1 baseline:

- Branch: `feature/issue-320-airflow-run-polling`
- Upstream: `origin/dev`
- Baseline commit: `93dfb455e2da09a2aa0021657789f52bdc5343be`
- Baseline date: 2026-07-09

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

## 8. DAG Deployment Strategy

Status: documented for issue #383.

The current `asklake_etl_job` DAG is a local smoke DAG. It proves that AskLake
can submit a DAG Run, poll Airflow DAG Run and Task Instance state, and reflect
the same run in the Jobs list, Run History, and DAG modal. It is not yet the
production ETL DAG deployment model.

### 8.1 Current local development mode

Local development uses a repository volume mount:

```text
./airflow/dags
  -> /opt/airflow/dags
```

This is acceptable for local and dev smoke work because a developer can edit a
DAG file and let the local Airflow DAG processor pick it up quickly. It is not
acceptable as the only production deployment mechanism because a manual file
copy or mutable server checkout can introduce unreviewed DAG code, DAG import
errors, and unclear rollback state.

### 8.2 Recommended first production shape

AskLake should start with one stable DAG, `asklake_etl_job`, rather than
generating one Airflow DAG file for every AskLake job. Job-specific settings
should be passed through `dag_run.conf`.

Recommended `dag_run.conf` boundary:

```json
{
  "command": "run",
  "jobId": "JOB-...",
  "runId": "run_...",
  "submittedAt": "2026-07-09T00:00:00Z",
  "job": {
    "sourceType": "MongoDB",
    "sourceConfig": [],
    "targetPath": "s3://...",
    "transformSteps": [],
    "qualityRules": []
  }
}
```

This keeps Airflow responsible for orchestration and AskLake responsible for job
definition, validation, and UI state.

### 8.3 Target DAG shape

The smoke DAG can evolve into the production ETL DAG with these stable task
boundaries:

```text
validate_run_conf
  -> prepare_source_input
  -> submit_spark_job
  -> collect_spark_result
  -> run_quality_checks
  -> publish_output_dataset
  -> update_catalog
  -> record_lineage
```

Rules:

- Use XCom only for small metadata such as row counts, output paths, error
  summaries, and run ids. Do not pass datasets through XCom.
- Write output paths with `runId` or another idempotency key so retries do not
  overwrite unrelated runs.
- Keep source credentials, Spark connection details, and catalog credentials in
  Airflow Connections, Variables, or deployment secrets instead of DAG code.
- Keep task ids stable because AskLake maps Airflow Task Instance state back
  into DAG modal steps.

### 8.4 Environment deployment levels

| Environment | Deployment mode | Purpose |
| --- | --- | --- |
| local/dev | repo volume mount from `airflow/dags` | fast smoke and UI polling verification |
| staging | Git-based deploy or CI copy of reviewed DAG files | verify DAG import, smoke runs, and AskLake/Airflow state consistency before prod |
| production | Airflow image with DAGs included, or Airflow Git Sync pinned to a reviewed branch/tag | reproducible DAG version, rollback, and multi-service consistency |

### 8.5 Deployment options

Option A. Server Git pull

- The server checkout is updated through `git fetch`, `git checkout`, and
  `git pull --ff-only`.
- Airflow reads `airflow/dags` from that checkout.
- This is simplest for staging but needs a strict clean-worktree and rollback
  checklist before production use.

Option B. Airflow image includes DAGs

- Build an Airflow image that copies `airflow/dags` into the image.
- Deploy image tags to staging/prod.
- This gives the clearest rollback story because the DAG version is tied to an
  immutable image tag.

Option C. Airflow Git Sync

- Airflow syncs DAG files from a Git branch or tag.
- This is production-friendly when credentials, sync interval, branch pinning,
  and rollback rules are managed carefully.

### 8.6 Required gates before staging/prod

Every staging/prod DAG deployment should pass:

1. DAG import/parse check with no import errors.
2. Compose or deployment manifest config render check.
3. Smoke DAG Run trigger against the target Airflow API.
4. Task Instance status check for every mapped AskLake step.
5. AskLake `GET /api/etl/jobs/{jobId}` polling check against the same run id.
6. Rollback note that identifies the previous DAG version or image tag.

### 8.7 Rollback rule

If a deployed DAG fails to import or produces incorrect orchestration behavior,
rollback must restore the previous reviewed DAG version before retrying user
jobs. Do not hot-edit files inside a running Airflow container or mutable
production DAG folder without recording the source commit, reason, and follow-up
PR.
