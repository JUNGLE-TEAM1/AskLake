const assert = require("node:assert/strict");
const sync = require("../.github/scripts/notion-issue-sync.js");

const {
  ensureMergedPullRequestClosesIssue,
  extractClosingIssueNumbersFromPrBody,
  fetchGitHubIssueOrNull,
  findLinkedIssueNumberFromPullRequest,
  findPreferredPullRequestForIssue,
  issueWasReopenedAfterPullRequestMerge,
  pullRequestClosesIssue,
  wantedProjectStatusForIssueEvent,
} = sync._private;

const config = {
  owner: "JUNGLE-TEAM1",
  repo: "AskLake",
  dryRun: false,
  openedProjectStatus: "Backlog",
  reopenedProjectStatus: "Ready",
  readyProjectStatus: "Ready",
  inProgressProjectStatus: "In progress",
  blockedProjectStatus: "Blocked",
  reviewProjectStatus: "Review",
  previewProjectStatus: "Preview",
};

const detailedIssue = {
  number: 636,
  title: "Fix lifecycle sync",
  state: "open",
  issueUrl: "https://github.com/JUNGLE-TEAM1/AskLake/issues/636",
  body: [
    "- Target Branch: dev",
    "",
    "## 필요한 결정 사항",
    "",
    "- 구현 중 팀 규칙을 확인합니다.",
  ].join("\n"),
  labels: ["bug"],
  assignees: ["seonho12-54"],
  projectStatus: "blocked",
  updatedAt: "2026-07-13T00:00:00.000Z",
  githubUpdatedAt: "2026-07-13T00:00:00.000Z",
};

const mergedPullRequest = {
  number: 637,
  title: "fix: lifecycle sync",
  body: "Refs #12\n\nCloses #636",
  state: "closed",
  merged: true,
  mergedAt: "2026-07-13T01:00:00.000Z",
  updatedAt: "2026-07-13T01:00:00.000Z",
  draft: false,
  labels: [],
  headRefName: "fix-#636",
  baseRefName: "dev",
};

assert.deepEqual(extractClosingIssueNumbersFromPrBody("Closes #636\nFixes #637\nResolves #636"), [636, 637]);
assert.equal(pullRequestClosesIssue(mergedPullRequest, 636), true);
assert.equal(pullRequestClosesIssue({ ...mergedPullRequest, body: "Refs #636" }, 636), false);
assert.equal(
  findLinkedIssueNumberFromPullRequest({ ...mergedPullRequest, body: "Refs #12", headRefName: "fix-#636" }),
  636,
  "the issue-linked branch must win over an unrelated generic body reference",
);
assert.equal(
  findLinkedIssueNumberFromPullRequest({
    ...mergedPullRequest,
    body: "기존 승인 요약 카드 제거 PR #616을 포함합니다.\n\nRefs #611",
    headRefName: "feature/permission-api-integration",
  }),
  611,
  "an explicit Refs footer must win over unrelated PR references in prose",
);

assert.equal(
  wantedProjectStatusForIssueEvent({ issue: detailedIssue, config }),
  "Ready",
  "a normal required-decisions section must not be treated as a blocker",
);
assert.equal(
  wantedProjectStatusForIssueEvent({ issue: { ...detailedIssue, body: "내용 있음", projectStatus: "blocked" }, config }),
  "Backlog",
  "a removed blocking signal must not preserve blocked without enough routing context",
);
assert.equal(
  wantedProjectStatusForIssueEvent({
    issue: {
      ...detailedIssue,
      body: "- Target Branch: dev\n- 초기 상태: Blocked",
      projectStatus: "blocked",
    },
    config,
  }),
  "Ready",
  "an initial status must not reapply Blocked after the issue has entered its lifecycle",
);
assert.equal(
  wantedProjectStatusForIssueEvent({
    issue: { ...detailedIssue, projectStatus: "Done", eventAction: "reopened" },
    config,
  }),
  "Ready",
  "missed reopen recovery must move an open issue out of Done",
);
assert.equal(
  wantedProjectStatusForIssueEvent({ issue: { ...detailedIssue, projectStatus: "Done" }, config }),
  "Ready",
  "an open issue must not remain stuck in Done after a missed reopen event",
);
assert.equal(
  wantedProjectStatusForIssueEvent({
    issue: detailedIssue,
    config,
    pullRequest: { ...mergedPullRequest, merged: false, mergedAt: null },
  }),
  "Ready",
  "closing an unmerged PR must return the issue to a non-Done state",
);
assert.equal(
  wantedProjectStatusForIssueEvent({ issue: detailedIssue, config, pullRequest: mergedPullRequest }),
  "Done",
  "a merged PR with an explicit closing keyword must move the project item to Done",
);
assert.equal(
  wantedProjectStatusForIssueEvent({
    issue: detailedIssue,
    config,
    pullRequest: { ...mergedPullRequest, body: "Refs #636" },
  }),
  "Ready",
  "a generic reference must not close an issue or mark it Done",
);

const preferred = findPreferredPullRequestForIssue(
  [
    { ...mergedPullRequest, number: 640, body: "Closes #999", headRefName: "fix-#999" },
    { ...mergedPullRequest, number: 639, state: "open", merged: false, mergedAt: null },
    mergedPullRequest,
  ],
  636,
);
assert.equal(preferred.number, 637, "missed-event recovery must prefer an explicitly closing merged PR");

assert.equal(
  issueWasReopenedAfterPullRequestMerge(
    [{ event: "reopened", created_at: "2026-07-13T02:00:00.000Z" }],
    mergedPullRequest,
  ),
  true,
  "a deliberate reopen after merge must be preserved",
);
assert.equal(
  issueWasReopenedAfterPullRequestMerge(
    [{ event: "reopened", created_at: "2026-07-13T00:30:00.000Z" }],
    mergedPullRequest,
  ),
  false,
);

async function verifyIssueCloseMutation() {
  const calls = [];
  const github = {
    rest: {
      issues: {
        update: async (input) => {
          calls.push(input);
          return { data: { state: "closed", updated_at: "2026-07-13T01:00:01.000Z" } };
        },
      },
    },
  };

  const first = await ensureMergedPullRequestClosesIssue({
    github,
    config,
    issue: detailedIssue,
    pullRequest: mergedPullRequest,
  });
  assert.equal(first.issueClosed, true);
  assert.equal(first.issue.state, "closed");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    owner: "JUNGLE-TEAM1",
    repo: "AskLake",
    issue_number: 636,
    state: "closed",
    state_reason: "completed",
  });

  const repeated = await ensureMergedPullRequestClosesIssue({
    github,
    config,
    issue: first.issue,
    pullRequest: mergedPullRequest,
  });
  assert.equal(repeated.issueClosed, false);
  assert.equal(calls.length, 1, "closing the same issue must be idempotent");

  const unmerged = await ensureMergedPullRequestClosesIssue({
    github,
    config,
    issue: detailedIssue,
    pullRequest: { ...mergedPullRequest, merged: false, mergedAt: null },
  });
  assert.equal(unmerged.issueClosed, false);
  assert.equal(calls.length, 1);

  const referenceOnly = await ensureMergedPullRequestClosesIssue({
    github,
    config,
    issue: detailedIssue,
    pullRequest: { ...mergedPullRequest, body: "Refs #636" },
  });
  assert.equal(referenceOnly.issueClosed, false);
  assert.equal(calls.length, 1);
}

async function verifyPullRequestsCannotBeMutatedAsIssues() {
  const github = {
    rest: {
      issues: {
        get: async () => ({
          data: {
            number: 616,
            title: "PR, not issue",
            state: "open",
            html_url: "https://github.com/JUNGLE-TEAM1/AskLake/pull/616",
            pull_request: { url: "https://api.github.com/repos/JUNGLE-TEAM1/AskLake/pulls/616" },
          },
        }),
      },
    },
  };
  const item = await fetchGitHubIssueOrNull({ github, config, issueNumber: 616 });
  assert.equal(item, null, "a pull request returned by the Issues API must never be normalized or mutated as an issue");
}

Promise.all([verifyIssueCloseMutation(), verifyPullRequestsCannotBeMutatedAsIssues()])
  .then(() => console.log("notion-issue-sync PR lifecycle smoke checks passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
