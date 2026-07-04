const assert = require("node:assert/strict");
const sync = require("../.github/scripts/notion-issue-sync.js");

const { chooseSyncDirection, diffIssueAndRow, issueForGitHubSource, sameList } = sync._private;

const baseIssue = {
  number: 7,
  title: "Fix sync",
  state: "open",
  issueUrl: "https://github.com/JUNGLE-TEAM1/AskLake/issues/7",
  repoUrl: "https://github.com/JUNGLE-TEAM1/AskLake",
  labels: ["bug", "sync"],
  assignees: ["alice", "bob"],
  projectStatus: "In Progress",
  updatedAt: "2026-06-26T00:10:00.000Z",
  githubUpdatedAt: "2026-06-26T00:10:00.000Z",
};

const baseRow = {
  pageId: "page-7",
  lastEditedAt: "2026-06-26T00:00:00.000Z",
  notionTitle: "#7 Fix sync",
  issueUrl: baseIssue.issueUrl,
  repoUrl: baseIssue.repoUrl,
  state: "open",
  number: 7,
  labels: ["sync", "bug"],
  assignees: ["bob", "alice"],
  projectStatus: "In Progress",
  createdAt: "2026-06-25T00:00:00.000Z",
  updatedAt: "2026-06-26T00:00:00.000Z",
  lastGitHubUpdatedAt: "2026-06-26T00:00:00.000Z",
  lastSyncedAt: "2026-06-26T00:00:00.000Z",
  lastSyncSource: "GitHub",
  syncError: "",
  archived: false,
  inTrash: false,
};

assert.equal(sameList(["b", "a", "a"], ["a", "b"]), true, "labels and assignees are order-insensitive");
assert.deepEqual(diffIssueAndRow({ row: baseRow, issue: baseIssue }), [], "same data should not diff by list order");

assert.equal(
  chooseSyncDirection({
    row: { ...baseRow, notionTitle: "#7 Old title" },
    issue: baseIssue,
  }).direction,
  "github",
  "GitHub-only changes should sync GitHub to Notion",
);

assert.equal(
  chooseSyncDirection({
    row: {
      ...baseRow,
      notionTitle: "#7 Notion title",
      lastEditedAt: "2026-06-26T00:20:00.000Z",
    },
    issue: { ...baseIssue, githubUpdatedAt: "2026-06-26T00:00:00.000Z" },
  }).direction,
  "notion",
  "Notion-only changes should sync Notion to GitHub",
);

assert.equal(
  chooseSyncDirection({
    row: {
      ...baseRow,
      notionTitle: "#7 Notion title",
      lastEditedAt: "2026-06-26T00:10:10.000Z",
    },
    issue: { ...baseIssue, title: "GitHub title", githubUpdatedAt: "2026-06-26T00:10:00.000Z" },
  }).direction,
  "conflict",
  "near-simultaneous differing edits should record conflict instead of overwriting",
);

assert.equal(issueForGitHubSource({ ...baseIssue, state: "closed", projectStatus: "Review" }).projectStatus, "Done");

console.log("notion-issue-sync hotfix smoke checks passed");
