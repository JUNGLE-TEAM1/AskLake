# AGENTS.md

## Project Overview

AskLake is a React/Vite frontend plus local Node backend for a trusted data lake platform. The current Pair A person-1 slice covers Source, Schema, and Create with real backend calls.

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

Before writing code, Codex should:

1. Read the planning and architecture docs first.
2. Confirm the current task fits the branch scope.
3. Check whether API/interface docs need to change before coding.
4. Keep changes small and branch-scoped unless the task explicitly requests a vertical slice.
5. Update docs when behavior, data contracts, commands, or conventions change.
6. Keep `README.md` short and useful for first-time setup.
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
- Backend runtime: Node.js ESM HTTP server
- Data state: React state hydrated from backend endpoints
- Shell data: `frontend/src/data/appShellData.ts`
- API client: `frontend/src/services/apiClient.ts`
- Pipeline API adapter: `frontend/src/services/pipelineApi.ts`
- Source connector adapter: `frontend/src/services/sourceConnectorService.ts`
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
- `README.md` stays as the entry document and quick start, not a running log.

## Branch Naming

`main` is protected. Do not push directly to `main`; open a PR from a task branch for every `main` change.

Recommended branch types:

- `feature/<name>`
- `fix/<name>`
- `docs/<name>`
- `test/<name>`
- `chore/<name>`

## Commands

```powershell
cd backend
npm install
npm run verify
npm run sources:fixtures
$env:ASKLAKE_VERIFY_KAFKA = "true"
npm run verify:sources

cd ..\frontend
npm install
npm run build
```

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
