# AGENTS.md

## Project Overview

AskLake is currently a React/Vite frontend demo for a trusted data lake platform.
The repository is expected to grow into a frontend + backend + database project, so planning and API contracts should stay ahead of implementation.

Source of truth order:

1. `docs/01-product-planning.md`
2. `docs/02-architecture.md`
3. `docs/03-api-reference.md`
4. `docs/04-development-guide.md`
5. `docs/system-guardrails.md`
6. `README.md`
7. Existing detailed backend docs:
   - `docs/api-contract.md`
   - `docs/backend-integration-readiness.md`

If documents conflict, follow the numbered order above. Existing detailed backend docs remain useful implementation references, but the numbered docs define the current harness entry points.

## How Codex Should Work In This Repo

Before writing code, Codex should:

1. Read the planning and architecture docs first.
2. Confirm the current task fits the frontend baseline or the planned backend integration scope.
3. Check whether API/interface docs need to change before coding.
4. Keep changes small and branch-scoped.
5. Update docs when behavior, data contracts, commands, or conventions change.
6. Keep `README.md` short and useful for first-time setup.
7. Track repository/CI/platform rules in `docs/system-guardrails.md`; keep human workflow rules in this harness.

## Current Implementation Baseline

- Frontend app: `frontend/`
- Framework: React + Vite + TypeScript
- Data state: React state and mock data under `frontend/src/data/`
- API transition layer: `frontend/src/services/mockApi.ts` and `frontend/src/services/apiClient.ts`
- Backend: planned, not implemented in this repository yet
- Detailed backend contract: `docs/api-contract.md`
- Backend readiness checklist: `docs/backend-integration-readiness.md`

## Codex-First Development Order

When extending AskLake, prefer this order:

1. Frontend baseline verification
2. Product scope and user-flow update
3. Architecture and interface contract update
4. API adapter or mock/live boundary change
5. Backend scaffold when requested
6. Core backend endpoints
7. Frontend hydration from backend
8. Error handling, loading states, and rollback behavior
9. Tests and regression coverage
10. README and docs sync

## Task Sizing Rules

- One feature branch should focus on one clear outcome.
- Keep frontend UI work, backend API work, and documentation-only work separate unless the task explicitly requires a vertical slice.
- Do not replace mock data with backend calls until the matching contract and failure behavior are documented.
- Avoid broad rewrites of the Vite app while backend planning is still moving.

## Collaboration Rules

- API changes must update `docs/03-api-reference.md` and, when detailed shape changes, `docs/api-contract.md`.
- Backend readiness or mock-removal changes must update `docs/backend-integration-readiness.md`.
- Architecture, routing, state model, or data ownership changes must update `docs/02-architecture.md`.
- Process, command, branch, or test changes must update `docs/04-development-guide.md`.
- Repository, CI, PR, issue, deploy, or platform guardrail changes must update `docs/system-guardrails.md`.
- `README.md` stays as the entry document and quick start, not a running log.

## Branch Naming

Recommended branch types:

- `feature/<name>`
- `fix/<name>`
- `docs/<name>`
- `test/<name>`
- `chore/<name>`

## Commands

```bash
cd frontend
npm install
npm run dev
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
- Treating mock data as the final persistence model.
- Editing unrelated frontend screens during a narrow API or docs task.
- Replacing existing docs with generic templates.
- Committing secrets, tokens, private keys, or real credentials.
