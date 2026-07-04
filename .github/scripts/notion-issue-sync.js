const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = process.env.NOTION_VERSION || "2022-06-28";
const SYNC_GRACE_MS = Number(process.env.SYNC_GRACE_MS || 30_000);
const CLOSED_PROJECT_STATUS = "Done";
const NOTION_SYNC_MARKER_RE = /<!--\s*notion-sync:page-id=([a-zA-Z0-9-]+)\s*-->/i;

module.exports = async function sync({ github, context, core }) {
  const config = buildConfig(context);
  const notion = createNotionClient(config);

  core.info(`Syncing ${config.repoFullName} with GitHub Project ${config.projectOwner}/${config.projectNumber}`);
  if (config.dryRun) {
    core.info("Dry run enabled. Planned mutations will be logged without writing to GitHub or Notion.");
  }

  const project = await fetchProject({ github, config });
  const projectIssues = normalizeProjectIssues(project, config);
  const notionRows = await fetchNotionRows({ notion, config });
  const notionIndex = buildNotionIndex(notionRows, config);

  const seenNotionPages = new Set();
  let createdNotion = 0;
  let updatedNotion = 0;
  let updatedGitHub = 0;
  let createdIssues = 0;
  let addedToProject = 0;
  let reopenedProjectItems = 0;
  let removedProjectItems = 0;
  let archivedNotion = 0;
  let restoredNotion = 0;
  let conflicts = 0;
  let updatedMarkers = 0;

  const deletedIssue = issueFromDeletedEvent(context, config);
  if (deletedIssue) {
    const rows = notionIndex.rowsByIssueUrl.get(deletedIssue.issueUrl) || [];
    for (const row of rows) {
      if (!isDeletedNotionRow(row) && (await archiveNotionPage({ notion, config, pageId: row.pageId }))) {
        archivedNotion += 1;
      }
      seenNotionPages.add(row.pageId);
    }
  }

  for (const [issueUrl, rows] of notionIndex.duplicateRowsByIssueUrl) {
    if (deletedIssue?.issueUrl === issueUrl) {
      continue;
    }
    const message = `Conflict: duplicate Notion rows share Issue URL ${issueUrl}. Refusing to choose one row automatically.`;
    for (const row of rows) {
      seenNotionPages.add(row.pageId);
      if (await markNotionConflict({ notion, config, row, message })) {
        conflicts += 1;
      }
    }
  }

  const reopenedIssue = issueFromReopenedEvent(context, config);
  if (reopenedIssue && !projectIssues.some((issue) => issue.issueUrl === reopenedIssue.issueUrl)) {
    const match = await findNotionMatchForIssue({ notion, config, index: notionIndex, issue: reopenedIssue });
    const row = match.row;
    const projectIssue = await ensureProjectItem({
      github,
      config,
      project,
      issue: reopenedIssue,
      wantedStatus: config.reopenedProjectStatus,
    });
    reopenedProjectItems += 1;
    if (projectIssue.wasAddedToProject || projectIssue.projectStatusUpdated) {
      updatedGitHub += 1;
    }

    if (row) {
      seenNotionPages.add(row.pageId);
      const activeRow = await restoreRowIfArchived({ notion, config, row });
      if (activeRow.restored) {
        restoredNotion += 1;
      }
      if (await ensureGitHubIssueHasNotionMarker({ github, config, issue: projectIssue, pageId: activeRow.row.pageId })) {
        updatedMarkers += 1;
      }
      if (
        await updateNotionIssuePage({
          notion,
          config,
          pageId: activeRow.row.pageId,
          row: activeRow.row,
          issue: projectIssue,
          source: "GitHub",
        })
      ) {
        updatedNotion += 1;
      }
    }
  }

  for (const issue of projectIssues) {
    const match = await findNotionMatchForIssue({ notion, config, index: notionIndex, issue });

    if (match.conflictRows) {
      const rowsToMark = match.conflictRows.filter((row) => !seenNotionPages.has(row.pageId));
      if (!rowsToMark.length) {
        continue;
      }
      const message = `Conflict: multiple Notion rows match ${issue.issueUrl}. githubChangedAt=${issue.githubUpdatedAt}`;
      for (const row of rowsToMark) {
        seenNotionPages.add(row.pageId);
        if (await markNotionConflict({ notion, config, row, message })) {
          conflicts += 1;
        }
      }
      continue;
    }

    let row = match.row;
    let githubIssue = issueForGitHubSource(issue);

    if (!row) {
      githubIssue = await ensureClosedProjectStatus({ github, config, project, issue: githubIssue });
      if (githubIssue.projectStatusUpdated) {
        updatedGitHub += 1;
      }

      const page = await createNotionIssuePage({ notion, config, issue: githubIssue, source: "GitHub" });
      if (await ensureGitHubIssueHasNotionMarker({ github, config, issue: githubIssue, pageId: page.id })) {
        updatedMarkers += 1;
        if (
          await updateNotionIssuePage({
            notion,
            config,
            pageId: page.id,
            issue: githubIssue,
            source: "GitHub",
          })
        ) {
          updatedNotion += 1;
        }
      }
      createdNotion += 1;
      continue;
    }

    seenNotionPages.add(row.pageId);
    const activeRow = await restoreRowIfArchived({ notion, config, row });
    row = activeRow.row;
    if (activeRow.restored) {
      restoredNotion += 1;
    }
    if (row.inTrash) {
      const message = `Conflict: Notion row ${row.pageId} is in trash while GitHub Project item ${issue.issueUrl} still exists. Keeping the Project item.`;
      if (await markNotionConflict({ notion, config, row, message })) {
        conflicts += 1;
      }
      continue;
    }

    const markerUpdated = await ensureGitHubIssueHasNotionMarker({ github, config, issue: githubIssue, pageId: row.pageId });
    if (markerUpdated) {
      updatedMarkers += 1;
    }

    const decision = chooseSyncDirection({ row, issue: githubIssue });
    core.info(`Sync decision for ${githubIssue.issueUrl}: ${decision.direction} (${decision.reason})`);

    if (decision.direction === "conflict") {
      if (await markSyncConflict({ notion, config, row, issue: githubIssue, decision })) {
        conflicts += 1;
      }
      continue;
    }

    if (decision.direction === "notion") {
      const result = await syncNotionToGitHub({ github, notion, config, project, row, issue: githubIssue });
      if (result.updatedGitHub) {
        updatedGitHub += 1;
      }
      if (result.updatedNotion) {
        updatedNotion += 1;
      }
    } else if (decision.direction === "github") {
      githubIssue = await ensureClosedProjectStatus({ github, config, project, issue: githubIssue });
      if (githubIssue.projectStatusUpdated) {
        updatedGitHub += 1;
      }
      if (await updateNotionIssuePage({ notion, config, pageId: row.pageId, row, issue: githubIssue, source: "GitHub" })) {
        updatedNotion += 1;
      }
    } else if (markerUpdated) {
      if (await updateNotionIssuePage({ notion, config, pageId: row.pageId, row, issue: githubIssue, source: "GitHub" })) {
        updatedNotion += 1;
      }
    }
  }

  for (const row of notionRows) {
    if (seenNotionPages.has(row.pageId)) {
      continue;
    }

    if (row.issueUrl) {
      const parsed = parseIssueUrl(row.issueUrl);
      if (!parsed || parsed.owner !== config.owner || parsed.repo !== config.repo) {
        continue;
      }

      const issue = await fetchGitHubIssueOrNull({ github, config, issueNumber: parsed.number });
      if (!issue) {
        const message = `Conflict: GitHub issue ${row.issueUrl} was not found during sync. Not archiving Notion without an explicit GitHub issues.deleted event.`;
        if (await markNotionConflict({ notion, config, row, message })) {
          conflicts += 1;
        }
        continue;
      }

      const activeRow = await restoreRowIfArchived({ notion, config, row });
      const restoredRow = activeRow.row;
      if (activeRow.restored) {
        restoredNotion += 1;
      }
      if (restoredRow.inTrash) {
        const message = `Conflict: Notion row ${restoredRow.pageId} is in trash while GitHub issue ${row.issueUrl} still exists.`;
        if (await markNotionConflict({ notion, config, row: restoredRow, message })) {
          conflicts += 1;
        }
        continue;
      }

      const githubIssue = issueForGitHubSource(issue);
      const decision = chooseSyncDirection({ row: restoredRow, issue: githubIssue });
      const wantedStatus = wantedProjectStatusForMissingProjectItem({ row: restoredRow, issue: githubIssue, decision });
      const projectIssue = await ensureProjectItem({ github, config, project, issue: githubIssue, wantedStatus });
      if (projectIssue.wasAddedToProject) {
        addedToProject += 1;
      }
      if (projectIssue.wasAddedToProject || projectIssue.projectStatusUpdated) {
        updatedGitHub += 1;
      }
      if (await ensureGitHubIssueHasNotionMarker({ github, config, issue: projectIssue, pageId: restoredRow.pageId })) {
        updatedMarkers += 1;
      }
      if (decision.direction === "conflict") {
        if (await markSyncConflict({ notion, config, row: restoredRow, issue: projectIssue, decision })) {
          conflicts += 1;
        }
        continue;
      }
      if (decision.direction === "notion") {
        const result = await syncNotionToGitHub({ github, notion, config, project, row: restoredRow, issue: projectIssue });
        if (result.updatedGitHub) {
          updatedGitHub += 1;
        }
        if (result.updatedNotion) {
          updatedNotion += 1;
        }
      } else if (
        await updateNotionIssuePage({
          notion,
          config,
          pageId: restoredRow.pageId,
          row: restoredRow,
          issue: projectIssue,
          source: "GitHub",
        })
      ) {
        updatedNotion += 1;
      }
      continue;
    }

    if (row.repoUrl === config.repoUrl && row.notionTitle && !isDeletedNotionRow(row)) {
      const issue = await createGitHubIssueFromNotion({ github, config, row });
      const projectIssue = await ensureProjectItem({ github, config, project, issue, wantedStatus: row.projectStatus });
      if (projectIssue.wasAddedToProject) {
        addedToProject += 1;
      }
      if (await updateNotionIssuePage({ notion, config, pageId: row.pageId, row, issue: projectIssue, source: "Notion" })) {
        updatedNotion += 1;
      }
      createdIssues += 1;
    }
  }

  core.info(
    [
      `Created Notion pages: ${createdNotion}`,
      `Updated Notion pages: ${updatedNotion}`,
      `Updated GitHub issues/project items: ${updatedGitHub}`,
      `Created GitHub issues from Notion: ${createdIssues}`,
      `Added existing issues to project: ${addedToProject}`,
      `Reopened GitHub issues re-added to project: ${reopenedProjectItems}`,
      `Removed GitHub Project items: ${removedProjectItems}`,
      `Archived Notion pages: ${archivedNotion}`,
      `Restored Notion pages: ${restoredNotion}`,
      `Conflicts recorded: ${conflicts}`,
      `Updated GitHub sync markers: ${updatedMarkers}`,
    ].join("\n"),
  );
};

function buildConfig(context) {
  const notionToken = process.env.NOTION_TOKEN;
  const notionDatabaseId = process.env.NOTION_DATABASE_ID;

  if (!notionToken) {
    throw new Error("Missing NOTION_TOKEN secret.");
  }

  if (!notionDatabaseId) {
    throw new Error("Missing NOTION_DATABASE_ID secret.");
  }

  const owner = process.env.GITHUB_REPOSITORY_OWNER || context.repo.owner;
  const repo = context.repo.repo;
  const projectOwner = process.env.GITHUB_PROJECT_OWNER || owner;
  const projectNumber = Number(process.env.GITHUB_PROJECT_NUMBER || 3);

  if (!Number.isInteger(projectNumber) || projectNumber < 1) {
    throw new Error(`Invalid GITHUB_PROJECT_NUMBER: ${process.env.GITHUB_PROJECT_NUMBER}`);
  }

  return {
    notionToken,
    notionDatabaseId,
    owner,
    repo,
    repoFullName: `${owner}/${repo}`,
    repoUrl: `https://github.com/${owner}/${repo}`,
    projectOwner,
    projectNumber,
    dryRun: parseBoolean(process.env.DRY_RUN),
    githubStatusField: process.env.GITHUB_PROJECT_STATUS_FIELD || "Status",
    reopenedProjectStatus: process.env.GITHUB_PROJECT_REOPENED_STATUS || "Ready",
    fallbackStatusOptionIds: parseStatusOptionIds(process.env.GITHUB_PROJECT_STATUS_OPTION_IDS),
    projectStatusAliases: parseStatusAliases(process.env.GITHUB_PROJECT_STATUS_ALIASES),
    props: {
      title: process.env.NOTION_TITLE_PROPERTY || "Issue",
      issueUrl: process.env.NOTION_ISSUE_URL_PROPERTY || "Issue URL",
      repo: process.env.NOTION_REPO_PROPERTY || "Repo",
      state: process.env.NOTION_STATE_PROPERTY || "State",
      number: process.env.NOTION_NUMBER_PROPERTY || "Number",
      labels: process.env.NOTION_LABELS_PROPERTY || "Labels",
      assignees: process.env.NOTION_ASSIGNEES_PROPERTY || "Assignees",
      projectStatus: process.env.NOTION_PROJECT_STATUS_PROPERTY || "Project Status",
      created: process.env.NOTION_CREATED_PROPERTY || "Created",
      updated: process.env.NOTION_UPDATED_PROPERTY || "Updated",
      lastGitHubUpdated: process.env.NOTION_LAST_GITHUB_UPDATED_PROPERTY || "Last GitHub Updated",
      lastSyncedAt: process.env.NOTION_LAST_SYNCED_AT_PROPERTY || "Last Synced At",
      lastSyncSource: process.env.NOTION_LAST_SYNC_SOURCE_PROPERTY || "Last Sync Source",
      syncError: process.env.NOTION_SYNC_ERROR_PROPERTY || "Sync Error",
    },
  };
}

function createNotionClient(config) {
  return async function notionRequest(path, options = {}) {
    const response = await fetch(`${NOTION_API_BASE}${path}`, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${config.notionToken}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`Notion API ${response.status} ${response.statusText}: ${text}`);
      error.status = response.status;
      throw error;
    }

    return response.json();
  };
}

async function fetchProject({ github, config }) {
  const query = `
    query($owner: String!, $number: Int!, $after: String) {
      organization(login: $owner) {
        projectV2(number: $number) {
          ...ProjectParts
        }
      }
    }

    fragment ProjectParts on ProjectV2 {
      id
      title
      fields(first: 100) {
        nodes {
          ... on ProjectV2Field {
            id
            name
            dataType
          }
          ... on ProjectV2SingleSelectField {
            id
            name
            dataType
            options {
              id
              name
            }
          }
          ... on ProjectV2IterationField {
            id
            name
            dataType
          }
        }
      }
      items(first: 100, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          createdAt
          updatedAt
          content {
            ... on Issue {
              id
              number
              title
              state
              url
              body
              createdAt
              updatedAt
              repository {
                name
                nameWithOwner
                url
                owner {
                  login
                }
              }
              assignees(first: 50) {
                nodes {
                  login
                }
              }
              labels(first: 50) {
                nodes {
                  name
                }
              }
            }
          }
          fieldValues(first: 100) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                optionId
                updatedAt
                field {
                  ... on ProjectV2FieldCommon {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  let project = null;
  let after = null;
  const items = [];

  do {
    const result = await github.graphql(query, {
      owner: config.projectOwner,
      number: config.projectNumber,
      after,
    });

    const pageProject = result.organization?.projectV2;
    if (!pageProject) {
      throw new Error(`Could not find organization project ${config.projectOwner}/${config.projectNumber}.`);
    }

    if (!project) {
      project = pageProject;
    }

    items.push(...pageProject.items.nodes);
    after = pageProject.items.pageInfo.hasNextPage ? pageProject.items.pageInfo.endCursor : null;
  } while (after);

  const statusField = project.fields.nodes.find((field) => field?.name === config.githubStatusField);
  if (!statusField) {
    throw new Error(`Project field "${config.githubStatusField}" was not found.`);
  }

  return {
    id: project.id,
    title: project.title,
    fields: project.fields.nodes,
    items,
    statusField,
    fallbackStatusOptionIds: config.fallbackStatusOptionIds,
    projectStatusAliases: config.projectStatusAliases,
    statusOptionsByName: new Map(
      (statusField.options || []).map((option) => [normalizeProjectStatusName(option.name), option]),
    ),
  };
}

function normalizeProjectIssues(project, config) {
  return project.items
    .filter((item) => item.content?.repository?.nameWithOwner === config.repoFullName)
    .map((item) => normalizeProjectIssue({ item, project, config }));
}

function normalizeProjectIssue({ item, project, config }) {
  const issue = item.content;
  const statusValue = (item.fieldValues.nodes || []).find((value) => value?.field?.name === config.githubStatusField);
  const githubUpdatedAt = maxIso(issue.updatedAt, item.updatedAt, statusValue?.updatedAt);

  return {
    nodeId: issue.id,
    projectItemId: item.id,
    number: issue.number,
    title: issue.title,
    state: issue.state.toLowerCase(),
    issueUrl: issue.url,
    projectItemCreatedAt: item.createdAt,
    projectItemUpdatedAt: item.updatedAt,
    body: issue.body || "",
    notionPageId: readNotionPageIdFromIssueBody(issue.body),
    repoUrl: issue.repository.url,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    githubUpdatedAt,
    labels: issue.labels.nodes.map((label) => label.name),
    assignees: issue.assignees.nodes.map((assignee) => assignee.login),
    projectStatus: statusValue?.name || null,
    projectStatusOptionId: statusValue?.optionId || null,
  };
}

async function fetchNotionRows({ notion, config }) {
  const rows = [];
  let startCursor = undefined;

  do {
    const body = {
      page_size: 100,
      filter: {
        or: [
          {
            property: config.props.repo,
            url: {
              equals: config.repoUrl,
            },
          },
          {
            property: config.props.issueUrl,
            url: {
              contains: `${config.repoFullName}/issues/`,
            },
          },
        ],
      },
    };

    if (startCursor) {
      body.start_cursor = startCursor;
    }

    const page = await notion(`/databases/${config.notionDatabaseId}/query`, {
      method: "POST",
      body,
    });

    rows.push(...page.results.map((result) => normalizeNotionRow(result, config)));
    startCursor = page.has_more ? page.next_cursor : undefined;
  } while (startCursor);

  return rows;
}

function normalizeNotionRow(page, config) {
  const props = config.props;

  return {
    pageId: page.id,
    lastEditedAt: page.last_edited_time,
    notionTitle: readTitle(page, props.title),
    issueUrl: readUrl(page, props.issueUrl),
    repoUrl: readUrl(page, props.repo),
    state: normalizeState(readSelect(page, props.state)),
    number: readNumber(page, props.number),
    labels: splitList(readText(page, props.labels)),
    assignees: splitList(readText(page, props.assignees)),
    projectStatus: readSelect(page, props.projectStatus),
    createdAt: readDate(page, props.created),
    updatedAt: readDate(page, props.updated),
    lastGitHubUpdatedAt: readDate(page, props.lastGitHubUpdated),
    lastSyncedAt: readDate(page, props.lastSyncedAt),
    lastSyncSource: readSelect(page, props.lastSyncSource),
    syncError: readText(page, props.syncError),
    archived: Boolean(page.archived),
    inTrash: Boolean(page.in_trash),
  };
}

function buildNotionIndex(rows, config) {
  const rowsByIssueUrl = new Map();
  const rowByPageId = new Map();
  const rowsByRepoNumber = new Map();

  for (const row of rows) {
    rowByPageId.set(normalizePageId(row.pageId), row);

    if (row.issueUrl) {
      addMapList(rowsByIssueUrl, row.issueUrl, row);
    }

    const repoNumberKey = notionRepoNumberKey(row, config);
    if (repoNumberKey) {
      addMapList(rowsByRepoNumber, repoNumberKey, row);
    }
  }

  return {
    rows,
    rowsByIssueUrl,
    rowByPageId,
    rowsByRepoNumber,
    duplicateRowsByIssueUrl: duplicateMapEntries(rowsByIssueUrl),
    duplicateRowsByRepoNumber: duplicateMapEntries(rowsByRepoNumber),
  };
}

async function findNotionMatchForIssue({ notion, config, index, issue }) {
  const urlRows = index.rowsByIssueUrl.get(issue.issueUrl) || [];
  if (urlRows.length > 1) {
    return { conflictRows: urlRows };
  }

  if (urlRows.length === 1) {
    return { row: urlRows[0] };
  }

  if (issue.notionPageId) {
    const markerPageId = normalizePageId(issue.notionPageId);
    const indexedRow = index.rowByPageId.get(markerPageId);
    if (indexedRow) {
      return { row: indexedRow };
    }

    const fetchedRow = await fetchNotionPageByIdOrNull({ notion, config, pageId: issue.notionPageId });
    if (fetchedRow) {
      index.rowByPageId.set(normalizePageId(fetchedRow.pageId), fetchedRow);
      if (fetchedRow.issueUrl) {
        addMapList(index.rowsByIssueUrl, fetchedRow.issueUrl, fetchedRow);
      }
      return { row: fetchedRow };
    }
  }

  const repoNumberRows = index.rowsByRepoNumber.get(issueRepoNumberKey(issue)) || [];
  if (repoNumberRows.length > 1) {
    return { conflictRows: repoNumberRows };
  }

  return { row: repoNumberRows[0] || null };
}

async function fetchNotionPageByIdOrNull({ notion, config, pageId }) {
  try {
    const page = await notion(`/pages/${pageId}`);
    return normalizeNotionRow(page, config);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

function addMapList(map, key, value) {
  if (!key) {
    return;
  }

  const values = map.get(key) || [];
  values.push(value);
  map.set(key, values);
}

function duplicateMapEntries(map) {
  return new Map([...map.entries()].filter(([, values]) => values.length > 1));
}

function notionRepoNumberKey(row, config) {
  if (!row.number) {
    return null;
  }

  if (row.repoUrl && row.repoUrl !== config.repoUrl) {
    return null;
  }

  return `${config.repoUrl}#${row.number}`;
}

function issueRepoNumberKey(issue) {
  return `${issue.repoUrl}#${issue.number}`;
}

function normalizePageId(pageId) {
  return String(pageId || "").replace(/-/g, "").toLowerCase();
}

function chooseSyncDirection({ row, issue }) {
  const githubChangedAt = issue.githubUpdatedAt || issue.updatedAt;
  const notionChangedAt = row.lastEditedAt;
  const diffFields = diffIssueAndRow({ row, issue });
  const hasDiff = diffFields.length > 0;
  const githubChanged = hasGitHubChangedSinceLastSync({ row, issue });
  const notionChanged = hasNotionChangedSinceLastSync(row);
  const base = {
    direction: "none",
    githubChangedAt,
    notionChangedAt,
    reason: "already in sync",
    diffFields,
  };

  if (!hasDiff) {
    return base;
  }

  if (githubChanged && notionChanged) {
    const comparison = compareIsoWithGrace(githubChangedAt, notionChangedAt);
    if (comparison > 0) {
      return { ...base, direction: "github", reason: "both changed; GitHub is newer" };
    }
    if (comparison < 0) {
      return { ...base, direction: "notion", reason: "both changed; Notion is newer" };
    }

    return { ...base, direction: "conflict", reason: "both changed within sync grace window" };
  }

  if (githubChanged) {
    return { ...base, direction: "github", reason: "GitHub changed since last sync" };
  }

  if (notionChanged) {
    return { ...base, direction: "notion", reason: "Notion changed since last sync" };
  }

  return { ...base, reason: "data differs, but neither side changed since last sync" };
}

function hasGitHubChangedSinceLastSync({ row, issue }) {
  if (!row.lastGitHubUpdatedAt) {
    return true;
  }

  return isAfter(issue.githubUpdatedAt, row.lastGitHubUpdatedAt);
}

function hasNotionChangedSinceLastSync(row) {
  if (!row.lastEditedAt) {
    return false;
  }

  if (!row.lastSyncedAt) {
    return true;
  }

  return isAfter(row.lastEditedAt, row.lastSyncedAt);
}

function diffIssueAndRow({ row, issue }) {
  const fields = [];
  const rowTitle = stripIssuePrefix(row.notionTitle, issue.number);

  if ((rowTitle || "") !== (issue.title || "")) {
    fields.push("title");
  }
  if (row.issueUrl !== issue.issueUrl) {
    fields.push("issueUrl");
  }
  if ((row.repoUrl || "") !== (issue.repoUrl || "")) {
    fields.push("repo");
  }
  if (row.state !== issue.state) {
    fields.push("state");
  }
  if (row.number !== issue.number) {
    fields.push("number");
  }
  if (!sameList(row.labels, issue.labels)) {
    fields.push("labels");
  }
  if (!sameList(row.assignees, issue.assignees)) {
    fields.push("assignees");
  }
  if (!sameProjectStatus(row.projectStatus, issue.projectStatus)) {
    fields.push("projectStatus");
  }

  return fields;
}

async function syncNotionToGitHub({ github, notion, config, project, row, issue }) {
  const title = stripIssuePrefix(row.notionTitle, issue.number);
  const labels = row.labels;
  const assignees = row.assignees;
  const issuePatch = {};

  if (title && title !== issue.title) {
    issuePatch.title = title;
  }
  if (row.state && row.state !== issue.state) {
    issuePatch.state = row.state;
  }
  if (!sameList(labels, issue.labels)) {
    issuePatch.labels = sortUnique(labels);
  }
  if (!sameList(assignees, issue.assignees)) {
    issuePatch.assignees = sortUnique(assignees);
  }

  let data = null;
  let updatedGitHub = false;

  if (Object.keys(issuePatch).length > 0) {
    if (config.dryRun) {
      console.log(`[dry-run] Would update GitHub issue ${issue.issueUrl}: ${Object.keys(issuePatch).join(", ")}`);
      data = {
        title: issuePatch.title || issue.title,
        state: issuePatch.state || issue.state,
        labels: (issuePatch.labels || issue.labels).map((name) => ({ name })),
        assignees: (issuePatch.assignees || issue.assignees).map((login) => ({ login })),
        updated_at: new Date().toISOString(),
      };
    } else {
      const response = await github.rest.issues.update({
        owner: config.owner,
        repo: config.repo,
        issue_number: issue.number,
        ...issuePatch,
      });
      data = response.data;
    }
    updatedGitHub = true;
  }

  let projectStatus = issue.projectStatus;
  if (row.projectStatus && !sameProjectStatus(row.projectStatus, issue.projectStatus)) {
    const syncedStatus = await updateProjectStatus({
      github,
      config,
      project,
      projectItemId: issue.projectItemId,
      currentStatusName: issue.projectStatus,
      statusName: row.projectStatus,
    });
    projectStatus = syncedStatus || row.projectStatus;
    updatedGitHub = Boolean(syncedStatus) || updatedGitHub;
  }

  const updatedIssue = {
    ...issue,
    title: data?.title || issue.title,
    state: data?.state || issue.state,
    labels: data?.labels?.map((label) => label.name) || issue.labels,
    assignees: data?.assignees?.map((assignee) => assignee.login) || issue.assignees,
    updatedAt: data?.updated_at || issue.updatedAt,
    githubUpdatedAt: updatedGitHub ? new Date().toISOString() : issue.githubUpdatedAt,
    projectStatus,
  };

  const updatedNotion = await updateNotionIssuePage({
    notion,
    config,
    pageId: row.pageId,
    row,
    issue: updatedIssue,
    source: "Notion",
  });

  return {
    updatedGitHub,
    updatedNotion,
  };
}

async function updateProjectStatus({ github, config, project, projectItemId, currentStatusName, statusName }) {
  if (!projectItemId || !statusName || sameProjectStatus(currentStatusName, statusName)) {
    return null;
  }

  const normalizedStatusName = normalizeProjectStatusName(statusName);
  const aliasedStatusName = project.projectStatusAliases.get(normalizedStatusName) || statusName;
  const normalizedAliasedStatusName = normalizeProjectStatusName(aliasedStatusName);
  const option = project.statusOptionsByName.get(normalizedAliasedStatusName);
  const fallbackOptionId = project.fallbackStatusOptionIds?.get(normalizedAliasedStatusName);
  const optionId = option?.id || fallbackOptionId;

  if (!optionId) {
    const knownOptions = [...project.statusOptionsByName.keys()].join(", ") || "(none)";
    console.warn(`Skipping unknown project status "${statusName}". Known GitHub options: ${knownOptions}`);
    return null;
  }

  if (!option) {
    console.warn(`Using fallback option id for project status "${aliasedStatusName}".`);
  }

  if (config.dryRun) {
    console.log(`[dry-run] Would update Project status for item ${projectItemId} to "${aliasedStatusName}".`);
    return aliasedStatusName;
  }

  await github.graphql(
    `
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(
          input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: { singleSelectOptionId: $optionId }
          }
        ) {
          projectV2Item {
            id
          }
        }
      }
    `,
    {
      projectId: project.id,
      itemId: projectItemId,
      fieldId: project.statusField.id,
      optionId,
    },
  );

  return aliasedStatusName;
}

async function fetchGitHubIssue({ github, config, issueNumber }) {
  const { data } = await github.rest.issues.get({
    owner: config.owner,
    repo: config.repo,
    issue_number: issueNumber,
  });

  return issueFromRest(data, config);
}

async function fetchGitHubIssueOrNull({ github, config, issueNumber }) {
  try {
    return await fetchGitHubIssue({ github, config, issueNumber });
  } catch (error) {
    if (error.status === 404 || error.status === 410) {
      return null;
    }

    throw error;
  }
}

async function createGitHubIssueFromNotion({ github, config, row }) {
  if (config.dryRun) {
    console.log(`[dry-run] Would create GitHub issue from Notion page ${row.pageId}.`);
    return issueFromRest(
      {
        node_id: `dry-run-issue-${row.pageId}`,
        number: row.number || 0,
        title: stripIssuePrefix(row.notionTitle, row.number),
        state: row.state || "open",
        html_url: `${config.repoUrl}/issues/dry-run-${row.pageId}`,
        body: buildNotionSyncMarker(row.pageId),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        labels: row.labels.map((name) => ({ name })),
        assignees: row.assignees.map((login) => ({ login })),
      },
      config,
    );
  }

  const { data } = await github.rest.issues.create({
    owner: config.owner,
    repo: config.repo,
    title: stripIssuePrefix(row.notionTitle, row.number),
    body: buildNotionSyncMarker(row.pageId),
    labels: row.labels,
    assignees: row.assignees,
  });

  return issueFromRest(data, config);
}

async function ensureProjectItem({ github, config, project, issue, wantedStatus }) {
  const existing = project.items.find((item) => item.content?.url === issue.issueUrl);
  let projectItemId = existing?.id;
  let wasAddedToProject = false;

  if (!projectItemId) {
    if (config.dryRun) {
      console.log(`[dry-run] Would add GitHub issue ${issue.issueUrl} to Project ${config.projectOwner}/${config.projectNumber}.`);
      projectItemId = `dry-run-project-item-${issue.number}`;
    } else {
      const result = await github.graphql(
        `
          mutation($projectId: ID!, $contentId: ID!) {
            addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
              item {
                id
              }
            }
          }
        `,
        {
          projectId: project.id,
          contentId: issue.nodeId,
        },
      );

      projectItemId = result.addProjectV2ItemById.item.id;
    }

    wasAddedToProject = true;
    project.items.push({
      id: projectItemId,
      content: {
        url: issue.issueUrl,
      },
    });
  }

  let projectStatusUpdated = false;
  let projectStatus = issue.projectStatus || null;
  if (wantedStatus) {
    const syncedStatus = await updateProjectStatus({
      github,
      config,
      project,
      projectItemId,
      currentStatusName: wasAddedToProject ? null : issue.originalProjectStatus ?? issue.projectStatus,
      statusName: wantedStatus,
    });
    projectStatus = syncedStatus || wantedStatus;
    projectStatusUpdated = Boolean(syncedStatus);
  }

  return {
    ...issue,
    projectItemId,
    projectStatus,
    githubUpdatedAt: wasAddedToProject || projectStatusUpdated ? new Date().toISOString() : issue.githubUpdatedAt,
    wasAddedToProject,
    projectStatusUpdated,
  };
}

function issueForGitHubSource(issue) {
  if (issue.state !== "closed") {
    return issue;
  }

  return {
    ...issue,
    originalProjectStatus: issue.projectStatus,
    projectStatus: CLOSED_PROJECT_STATUS,
  };
}

async function ensureClosedProjectStatus({ github, config, project, issue }) {
  const currentStatusName = issue.originalProjectStatus ?? issue.projectStatus;
  if (issue.state !== "closed" || sameProjectStatus(currentStatusName, CLOSED_PROJECT_STATUS)) {
    return issue;
  }

  const syncedStatus = await updateProjectStatus({
    github,
    config,
    project,
    projectItemId: issue.projectItemId,
    currentStatusName,
    statusName: CLOSED_PROJECT_STATUS,
  });

  if (!syncedStatus) {
    return issue;
  }

  return {
    ...issue,
    projectStatus: syncedStatus,
    githubUpdatedAt: new Date().toISOString(),
    projectStatusUpdated: true,
  };
}

function wantedProjectStatusForMissingProjectItem({ row, issue, decision }) {
  if (decision.direction === "notion") {
    return row.projectStatus || (row.state === "closed" ? CLOSED_PROJECT_STATUS : null);
  }

  if (issue.state === "closed") {
    return CLOSED_PROJECT_STATUS;
  }

  return issue.projectStatus || row.projectStatus || null;
}

function issueFromRest(issue, config) {
  return {
    nodeId: issue.node_id,
    projectItemId: null,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    issueUrl: issue.html_url,
    body: issue.body || "",
    notionPageId: readNotionPageIdFromIssueBody(issue.body),
    repoUrl: config.repoUrl,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    githubUpdatedAt: issue.updated_at,
    labels: (issue.labels || []).map((label) => (typeof label === "string" ? label : label.name)).filter(Boolean),
    assignees: (issue.assignees || []).map((assignee) => assignee.login).filter(Boolean),
    projectStatus: null,
    projectStatusOptionId: null,
  };
}

function issueFromDeletedEvent(context, config) {
  if (context.eventName !== "issues" || context.payload.action !== "deleted" || !context.payload.issue) {
    return null;
  }

  return issueFromWebhookIssue(context.payload.issue, config);
}

function issueFromReopenedEvent(context, config) {
  if (context.eventName !== "issues" || context.payload.action !== "reopened" || !context.payload.issue) {
    return null;
  }

  return issueFromWebhookIssue(context.payload.issue, config);
}

function issueFromWebhookIssue(issue, config) {
  return {
    nodeId: issue.node_id || null,
    projectItemId: null,
    number: issue.number,
    title: issue.title,
    state: issue.state || "open",
    issueUrl: issue.html_url,
    body: issue.body || "",
    notionPageId: readNotionPageIdFromIssueBody(issue.body),
    repoUrl: config.repoUrl,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    githubUpdatedAt: new Date().toISOString(),
    labels: (issue.labels || []).map((label) => label.name).filter(Boolean),
    assignees: (issue.assignees || []).map((assignee) => assignee.login).filter(Boolean),
    projectStatus: null,
    projectStatusOptionId: null,
  };
}

function isDeletedNotionRow(row) {
  return Boolean(row.archived || row.inTrash);
}

async function ensureGitHubIssueHasNotionMarker({ github, config, issue, pageId }) {
  if (!pageId || issue.notionPageId === pageId) {
    return false;
  }

  const body = upsertNotionSyncMarker(issue.body, pageId);
  if (body === issue.body) {
    return false;
  }

  if (config.dryRun) {
    console.log(`[dry-run] Would update Notion sync marker on GitHub issue ${issue.issueUrl}.`);
    issue.body = body;
    issue.notionPageId = pageId;
    issue.githubUpdatedAt = new Date().toISOString();
    return true;
  }

  await github.rest.issues.update({
    owner: config.owner,
    repo: config.repo,
    issue_number: issue.number,
    body,
  });

  issue.body = body;
  issue.notionPageId = pageId;
  issue.githubUpdatedAt = new Date().toISOString();
  return true;
}

function readNotionPageIdFromIssueBody(body) {
  return NOTION_SYNC_MARKER_RE.exec(body || "")?.[1] || null;
}

function buildNotionSyncMarker(pageId) {
  return `<!-- notion-sync:page-id=${pageId} -->`;
}

function upsertNotionSyncMarker(body, pageId) {
  const marker = buildNotionSyncMarker(pageId);
  const content = body || "";

  if (NOTION_SYNC_MARKER_RE.test(content)) {
    return content.replace(NOTION_SYNC_MARKER_RE, marker);
  }

  return content ? `${content.trimEnd()}\n\n${marker}` : marker;
}

async function createNotionIssuePage({ notion, config, issue, source }) {
  if (config.dryRun) {
    console.log(`[dry-run] Would create Notion page for GitHub issue ${issue.issueUrl}.`);
    return {
      id: issue.notionPageId || `dry-run-notion-page-${issue.number}`,
    };
  }

  return notion("/pages", {
    method: "POST",
    body: {
      parent: {
        database_id: config.notionDatabaseId,
      },
      properties: buildNotionProperties({ config, issue, source }),
    },
  });
}

async function archiveNotionPage({ notion, config, pageId }) {
  if (config.dryRun) {
    console.log(`[dry-run] Would archive Notion page ${pageId}.`);
    return true;
  }

  await notion(`/pages/${pageId}`, {
    method: "PATCH",
    body: {
      archived: true,
    },
  });

  return true;
}

async function restoreNotionPage({ notion, config, pageId }) {
  if (config.dryRun) {
    console.log(`[dry-run] Would restore archived Notion page ${pageId}.`);
    return true;
  }

  await notion(`/pages/${pageId}`, {
    method: "PATCH",
    body: {
      archived: false,
    },
  });

  return true;
}

async function restoreRowIfArchived({ notion, config, row }) {
  if (!row.archived || row.inTrash) {
    return { row, restored: false };
  }

  await restoreNotionPage({ notion, config, pageId: row.pageId });
  return {
    row: {
      ...row,
      archived: false,
    },
    restored: true,
  };
}

async function markSyncConflict({ notion, config, row, issue, decision }) {
  const message = [
    `Conflict: ${decision.reason}`,
    `githubChangedAt=${decision.githubChangedAt || "unknown"}`,
    `notionChangedAt=${decision.notionChangedAt || "unknown"}`,
    `fields=${decision.diffFields.join(", ") || "unknown"}`,
    `issue=${issue.issueUrl}`,
  ].join("; ");

  return markNotionConflict({ notion, config, row, message });
}

async function markNotionConflict({ notion, config, row, message }) {
  if (!row || row.inTrash) {
    console.warn(`Cannot write sync conflict to missing or trashed Notion row: ${message}`);
    return false;
  }

  const nextMessage = message.slice(0, 2000);
  if (row.lastSyncSource === "Conflict" && row.syncError === nextMessage) {
    return false;
  }

  if (config.dryRun) {
    console.log(`[dry-run] Would mark Notion page ${row.pageId} as Conflict: ${nextMessage}`);
    return true;
  }

  await notion(`/pages/${row.pageId}`, {
    method: "PATCH",
    body: {
      properties: {
        [config.props.lastSyncSource]: selectValue("Conflict"),
        [config.props.syncError]: richTextValue(nextMessage),
      },
    },
  });

  return true;
}

async function updateNotionIssuePage({ notion, config, pageId, row, issue, source }) {
  if (row && !notionIssuePageNeedsUpdate({ config, row, issue, source })) {
    return false;
  }

  if (config.dryRun) {
    console.log(`[dry-run] Would update Notion page ${pageId} from ${source} for ${issue.issueUrl}.`);
    return true;
  }

  await notion(`/pages/${pageId}`, {
    method: "PATCH",
    body: {
      properties: buildNotionProperties({ config, issue, source }),
    },
  });

  return true;
}

function buildNotionProperties({ config, issue, source }) {
  const props = config.props;
  const now = new Date().toISOString();
  const properties = {
    [props.title]: titleValue(`#${issue.number} ${issue.title}`),
    [props.issueUrl]: urlValue(issue.issueUrl),
    [props.repo]: urlValue(issue.repoUrl || config.repoUrl),
    [props.state]: selectValue(issue.state),
    [props.number]: numberValue(issue.number),
    [props.labels]: richTextValue(formatList(issue.labels)),
    [props.assignees]: richTextValue(formatList(issue.assignees)),
    [props.created]: dateValue(issue.createdAt),
    [props.updated]: dateValue(issue.updatedAt),
    [props.lastGitHubUpdated]: dateValue(issue.githubUpdatedAt),
    [props.lastSyncedAt]: dateValue(now),
    [props.lastSyncSource]: selectValue(source),
    [props.syncError]: richTextValue(""),
  };

  if (issue.projectStatus) {
    properties[props.projectStatus] = selectValue(issue.projectStatus);
  }

  return properties;
}

function notionIssuePageNeedsUpdate({ row, issue, source }) {
  if (row.inTrash) {
    return false;
  }

  const expectedTitle = `#${issue.number} ${issue.title}`;
  return (
    row.archived ||
    row.notionTitle !== expectedTitle ||
    row.issueUrl !== issue.issueUrl ||
    (row.repoUrl || "") !== (issue.repoUrl || "") ||
    row.state !== issue.state ||
    row.number !== issue.number ||
    !sameList(row.labels, issue.labels) ||
    !sameList(row.assignees, issue.assignees) ||
    !sameProjectStatus(row.projectStatus, issue.projectStatus) ||
    !sameIso(row.createdAt, issue.createdAt) ||
    !sameIso(row.updatedAt, issue.updatedAt) ||
    !sameIso(row.lastGitHubUpdatedAt, issue.githubUpdatedAt) ||
    row.lastSyncSource !== source ||
    Boolean(row.syncError)
  );
}

function titleValue(content) {
  return {
    title: [
      {
        text: {
          content: content.slice(0, 2000),
        },
      },
    ],
  };
}

function richTextValue(content) {
  return {
    rich_text: content
      ? [
          {
            text: {
              content: content.slice(0, 2000),
            },
          },
        ]
      : [],
  };
}

function urlValue(url) {
  return {
    url: url || null,
  };
}

function selectValue(name) {
  return {
    select: name ? { name } : null,
  };
}

function numberValue(number) {
  return {
    number,
  };
}

function dateValue(iso) {
  return {
    date: iso ? { start: iso } : null,
  };
}

function readTitle(page, name) {
  const prop = page.properties?.[name];
  return (prop?.title || []).map((part) => part.plain_text).join("");
}

function readText(page, name) {
  const prop = page.properties?.[name];
  return (prop?.rich_text || []).map((part) => part.plain_text).join("");
}

function readUrl(page, name) {
  return page.properties?.[name]?.url || null;
}

function readSelect(page, name) {
  return page.properties?.[name]?.select?.name || null;
}

function readNumber(page, name) {
  return page.properties?.[name]?.number ?? null;
}

function readDate(page, name) {
  return page.properties?.[name]?.date?.start || null;
}

function splitList(value) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatList(values) {
  return sortUnique(values).join(", ");
}

function sortUnique(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function sameList(left, right) {
  const leftValues = sortUnique(left);
  const rightValues = sortUnique(right);
  return leftValues.length === rightValues.length && leftValues.every((value, index) => value === rightValues[index]);
}

function sameProjectStatus(left, right) {
  if (!left && !right) {
    return true;
  }

  return normalizeProjectStatusName(left) === normalizeProjectStatusName(right);
}

function sameIso(left, right) {
  if (!left && !right) {
    return true;
  }

  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}

function stripIssuePrefix(title, number) {
  const escapedNumber = number ? String(number).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "\\d+";
  return (title || "").replace(new RegExp(`^#${escapedNumber}\\s+`), "").trim();
}

function normalizeState(value) {
  if (!value) {
    return null;
  }

  const state = value.toLowerCase();
  return state === "closed" ? "closed" : "open";
}

function parseIssueUrl(url) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(url || "");
  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
    number: Number(match[3]),
  };
}

function parseStatusOptionIds(value) {
  return parseStatusMap(value);
}

function parseStatusAliases(value) {
  const aliases = parseStatusMap(value);

  if (!aliases.has(normalizeProjectStatusName("비전"))) {
    aliases.set(normalizeProjectStatusName("비전"), "Backlog");
  }

  return aliases;
}

function parseStatusMap(value) {
  const map = new Map();
  if (!value) {
    return map;
  }

  const parsed = JSON.parse(value);
  for (const [name, mappedValue] of Object.entries(parsed)) {
    map.set(normalizeProjectStatusName(name), mappedValue);
  }

  return map;
}

function normalizeProjectStatusName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isAfter(left, right) {
  if (!left || !right) {
    return false;
  }

  return new Date(left).getTime() > new Date(right).getTime() + SYNC_GRACE_MS;
}

function compareIsoWithGrace(left, right) {
  if (!left || !right) {
    return 0;
  }

  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    return 0;
  }

  const diff = leftTime - rightTime;
  if (Math.abs(diff) <= SYNC_GRACE_MS) {
    return 0;
  }

  return diff > 0 ? 1 : -1;
}

function maxIso(...values) {
  const times = values
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));

  if (!times.length) {
    return new Date().toISOString();
  }

  return new Date(Math.max(...times)).toISOString();
}

function isNotFoundError(error) {
  return error?.status === 404 || error?.status === 410;
}

function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

module.exports._private = {
  chooseSyncDirection,
  diffIssueAndRow,
  issueForGitHubSource,
  sameList,
};
