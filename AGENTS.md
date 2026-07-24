# AGENTS.md

## Project Overview

AskLake is a trusted data lake platform that connects data ingestion, processing, Catalog, SQL analysis, Dashboard, and AI-assisted workflows. The canonical application stack is a React/Vite/TypeScript frontend and a FastAPI backend backed by PostgreSQL. Airflow and Spark own finite-batch processing, Trino owns SQL Query Runs, and the active production control planes run in the EKS web/finite-batch and Realtime V1 cells. The EC2 Compose Continuous worker is a rollback standby and optional compatibility lane. The Node ESM server remains a compatibility and verification path, not the default backend runtime.

Source of truth order:

1. `docs/01-product-planning.md`
2. `docs/02-architecture.md`
3. `docs/03-api-reference.md`
4. `docs/04-development-guide.md`
5. `docs/system-guardrails.md`
6. `README.md`
7. Detailed backend docs:
   - `docs/api-contract.md`
   - `docs/backend-integration-readiness.md`
   - `docs/minio-100gb-spark-harness.md`

If documents conflict, follow the numbered order above. Detailed backend docs define request shapes, local fixture setup, and validation commands.

## How Codex Should Work In This Repo

If `AGENTS.local.md` exists, Codex should read it after this file for local-only workflow preferences. That file is ignored by git and must not be treated as shared project policy.

Before writing code, Codex should:

1. Read the planning and architecture docs first.
2. Confirm the current task fits the branch scope.
3. Check whether API/interface docs need to change before coding.
4. Keep changes small and branch-scoped unless the task explicitly requests a vertical slice.
5. Update docs when behavior, data contracts, commands, or conventions change.
6. Keep `README.md` short as the poster-session and project entry document. Put setup and validation details in `docs/04-development-guide.md`, and keep `docs/README.md` as the document portal.
7. Track repository, CI, platform, and validation rules in `docs/system-guardrails.md`.

## GitHub Auth In Codex

GitHub CLI tokens for this machine are stored in the macOS Keychain. The normal
Codex sandbox cannot always read that Keychain entry, so `gh auth status` may
incorrectly report a missing or invalid token inside the sandbox even when the
same account works outside it.

When using GitHub CLI commands for this repository:

- Do not repeat `gh auth login` just because a sandboxed command says the token
  is missing or invalid.
- Re-run GitHub CLI commands that need authentication with escalated
  permissions so `gh` can read the existing Keychain token.
- Use `gh auth status` with escalated permissions to verify the real login
  state.
- Never commit, print, or copy GitHub tokens into repo files, logs, docs, or
  scripts.

## Current Implementation Baseline

- Frontend app: `frontend/`
- Backend app: `backend/`
- Frontend framework: React + Vite + TypeScript
- Default backend runtime: FastAPI at `backend/app/main.py`
- Compatibility backend runtime: Node.js ESM at `backend/src/server.mjs`
- Durable user-facing metadata: PostgreSQL for Job, Run, Catalog, Dashboard, permission, and audit state
- Finite-batch runtime: Airflow orchestration plus Spark processing
- SQL runtime: Trino Query Runs, with documented compatibility paths where enabled
- Continuous runtime: EKS Realtime V1 worker owns Kafka Continuous and Continuous SQL reconciliation
- EC2 compatibility runtime: Compose `continuous-worker` is rollback standby and may run only after an approved owner transfer
- Deployment ownership manifest: `deploy/control-plane-ownership.json`
- Frontend state modules: `frontend/src/state/asklake/`
- Shell fixture data: `frontend/src/data/appShellData.ts`; do not treat it as durable state
- API client: `frontend/src/services/apiClient.ts`
- Pipeline API adapter: `frontend/src/services/pipelineApi.ts`
- Source connector adapter: `frontend/src/services/sourceConnectorService.ts`
- Document portal: `docs/README.md`
- Detailed backend contract: `docs/api-contract.md`
- Backend status checklist: `docs/backend-integration-readiness.md`

## Codex-First Development Order

When extending AskLake, prefer this order:

1. Existing flow and docs inspection
2. Product scope and user-flow update
3. Architecture and interface contract update
4. API adapter or backend endpoint change
5. Frontend loading, error, and rollback behavior
6. Backend validation scripts and fixtures
7. Tests and regression coverage
8. README and docs sync

## Task Sizing Rules

- One feature branch should focus on one clear outcome.
- Keep unrelated frontend UI work, backend API work, and documentation-only work separate unless the task explicitly requires a vertical slice.
- Do not invent source behavior. If a connector is shown as available, it must route through the backend.
- Avoid broad rewrites outside the requested slice.

## Collaboration Rules

- API changes must update `docs/03-api-reference.md` and, when detailed shape changes, `docs/api-contract.md`.
- Backend source or validation changes must update `docs/backend-integration-readiness.md` and `docs/minio-100gb-spark-harness.md` when relevant.
- Architecture, routing, state model, or data ownership changes must update `docs/02-architecture.md`.
- Process, command, branch, or test changes must update `docs/04-development-guide.md`.
- Repository, CI, PR, issue, deploy, or platform guardrail changes must update `docs/system-guardrails.md`.
- `README.md` stays as the poster-session and project entry document, not a setup manual or running log.

## Branch Naming

`main` and `dev` are protected. Do not push directly to either branch. Start normal task branches from an up-to-date `dev` and merge through a PR. Release changes for `main` also use a task branch and PR.

Recommended branch types:

- `feature/<name>`
- `fix/<name>`
- `docs/<name>`
- `test/<name>`
- `chore/<name>`

The issue-first workflow may use `<type>-#<issue-number>` when it matches the repository policy.

## Commands

Prepare and run the representative local gates below. Choose additional commands from `docs/04-development-guide.md` for the changed runtime.

```bash
cd backend
npm ci
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
npm run verify:backward-compatibility
npm run verify:control-plane-ownership

cd ../frontend
npm ci
npm run verify:ui-regressions
npm run build

cd ..
node scripts/verify-docs.mjs
```

`npm run verify` starts the Node compatibility server and requires seeded MinIO fixtures. Use it only after following `docs/source-connector-test-guide.md`; it is not the default FastAPI gate.

## Definition Of Done

A task is complete when:

- Code or documentation is implemented.
- Relevant build, test, or manual verification has been run.
- Related docs are updated.
- API/interface drift is resolved or explicitly called out.
- Known limitations are documented when not fully solved.

## Things Codex Should Avoid

- Making up backend behavior that conflicts with `docs/api-contract.md`.
- Treating frontend-only state as durable persistence.
- Editing unrelated screens during a narrow API or docs task.
- Replacing existing docs with generic templates.
- Committing secrets, tokens, private keys, or real credentials.
