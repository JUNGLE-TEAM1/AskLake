# Notion Issue Sync

This repository mirrors GitHub Project issues for `JUNGLE-TEAM1/AskLake` into a dedicated Notion database.

## Notion target

- Page: `302호 1팀 나만무 프로젝트`
- Database: `AskLake 깃허브 이슈 (Project 4 연동)`
- Database ID: `6df04edc16184687a6b698ff7becccdf`
- Data source ID: `<uuid-redacted>`
- Board view: `Kanban by Project Status`

## GitHub Project target

- Owner: `JUNGLE-TEAM1`
- Project number: `4`
- Project field: `Status`
- Status options: `Backlog`, `Ready`, `In progress`, `blocked`, `In review`, `Done`

## Required repository secrets

Set these in `Settings > Secrets and variables > Actions > Repository secrets`.

- `NOTION_TOKEN`: Notion integration token with access to the AskLake database.
- `NOTION_DATABASE_ID`: `6df04edc16184687a6b698ff7becccdf`
- `ISSUE_SYNC_PAT`: GitHub personal access token used by the workflow.

`ISSUE_SYNC_PAT` should have access to `JUNGLE-TEAM1/AskLake` issues and `JUNGLE-TEAM1` Project 4. The token needs repository issue write access plus GitHub Projects read/write access. If this secret is missing, the workflow falls back to `GITHUB_TOKEN`, but org-level Project v2 writes may fail.

## Schedule

The workflow runs on:

- Manual dispatch with the `dry_run` input.
- GitHub issue events: open, edit, close, reopen, assign, label, delete.
- GitHub pull request events: open, edit, synchronize, draft/review transition, label, close, and merge.
- Repository dispatch event type: `notion-issue-sync`.
- Cron: `*/5 * * * *`.

GitHub-hosted scheduled workflows are not guaranteed to run exactly every 5 minutes, and 5 minutes is the practical minimum cadence for this sync.

## Status behavior

- Existing Project 4 item status is mirrored into Notion `Project Status`.
- Moving a card in GitHub Project 4 moves the card to the same Notion board column on the next sync.
- New GitHub issues are added to Project 4 and Notion automatically.
- New open issues default to `Backlog`.
- Reopened issues default to `Ready`.
- Closed issues are moved to `Done`.
- A merged PR with an explicit `Closes #N`, `Fixes #N`, or `Resolves #N` footer closes the linked open issue and moves it to `Done`, including PRs merged into `dev`.
- A PR closed without merge, or a merged PR that only says `Refs #N`, does not close the issue.
- Scheduled/manual/repository-dispatch runs list repository PRs and recover a missed merge event. If the issue was deliberately reopened after that merge, the recovery keeps it open and recalculates it as `Ready`.
- Issues labeled `blocked` or `blocker` move to `blocked`.
- Explicit `차단 사유`, `Blocked Reason`, `Dependency`, or `의존 작업` content also moves an issue to `blocked`. A normal `필요한 결정 사항` section is not a blocking signal.
- When every blocking signal is removed, the next event or recovery run recalculates the status instead of preserving the old `blocked` value.
- Issues labeled `review`, `needs review`, or `in review` move to `In review`.

The workflow executes the lifecycle smoke checks before every remote mutation. Pull-request events use the workflow version from the PR base branch, while scheduled runs use the default branch (`main`). Therefore lifecycle automation changes must reach both `dev` and the later `dev -> main` integration before every trigger path is covered.

## Verification

```bash
node tests/notion-issue-sync-hotfix-smoke.js
node tests/notion-issue-sync-pr-lifecycle-smoke.js
```

## First-run check

Run the workflow manually with `dry_run=true` before enabling normal writes. A clean first run should report planned mutations only. After secrets are confirmed, run again with `dry_run=false`.
