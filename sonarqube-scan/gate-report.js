// Explains a failed SonarQube quality gate in the GitHub step that runs it,
// so a red gate reads without a SonarQube login. `action.yml` runs it with
// `actions/github-script`, and `mise run test` runs `gate-report.test.js`.
const { randomUUID } = require('node:crypto');

/** GitHub turns only a step's first 10 errors into annotations. */
const ANNOTATION_LIMIT = 10;
/** The search APIs refuse a page past their 10,000th result. */
const SEARCH_LIMIT = 10000;
const PAGE_SIZE = 100;

// These helpers keep each finding on one log line and show it as plain text
// in the job summary. A path or message can hold a line break or markup,
// because the scan imports reports from the repo's own tools, such as ESLint.
const oneLine = (text) => String(text).replace(/[\r\n]+/g, ' ');
const escapeMarkdown = (text) => oneLine(text)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replace(/[\\`*_{}[\]()#+\-.!|~]/g, '\\$&');

/** Returns a client that reads the SonarQube Web API at `host` with `token`. */
const newSonarQube = ({ host, token }) => {
  const get = async (path, query) => {
    const response = await fetch(`${host}${path}?${new URLSearchParams(query)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw Object.assign(new Error(`SonarQube answered ${response.status} to ${path}`), { status: response.status });
    }
    return response.json();
  };
  /** Returns the items up to the search limit, and the count of items left. */
  const getAll = async ({ path, key, query }) => {
    const items = [];
    for (let page = 1; ; page += 1) {
      const body = await get(path, { ...query, ps: PAGE_SIZE, p: page });
      items.push(...body[key]);
      const total = body.paging.total;
      if (body[key].length === 0 || items.length >= Math.min(total, SEARCH_LIMIT)) {
        return { items, left: total - items.length };
      }
    }
  };
  return { get, getAll };
};

/**
 * Logs each line with workflow commands stopped, so a path or message adds no
 * annotation of its own. The runner reads a log line that starts with `::` as
 * a command.
 */
const logInert = (core, lines) => {
  const resume = randomUUID();
  core.info(`::stop-commands::${resume}`);
  try {
    lines.forEach((line) => core.info(oneLine(line)));
  } finally {
    core.info(`::${resume}::`);
  }
};

/**
 * Names each failed condition, then lists each new issue and hotspot to
 * review as `path:line rule — message` in the log and the job summary, and
 * annotates the first ones. `reportTask` is the scanner's report-task.txt.
 */
module.exports = async function reportGate({ core, host, token, reportTask }) {
  const sonarQube = newSonarQube({ host, token });
  const taskId = reportTask.match(/^ceTaskId=(.*)$/m)?.[1];
  const { task } = await sonarQube.get('/api/ce/task', { id: taskId });
  if (!task.analysisId) {
    core.warning(`The analysis task is ${task.status}, so it has no quality gate result to read`);
    return;
  }
  const { projectStatus } = await sonarQube.get('/api/qualitygates/project_status', { analysisId: task.analysisId });
  const conditions = projectStatus.conditions
    .filter((condition) => condition.status === 'ERROR')
    .map((condition) => `${condition.metricKey} is ${condition.actualValue}, ` +
      `the gate wants it not ${condition.comparator === 'GT' ? 'above' : 'below'} ${condition.errorThreshold}`);
  conditions.forEach((condition) => core.error(condition));
  const summary = core.summary.addRaw('### Quality gate failed\n\n')
    .addRaw(conditions.map((condition) => `- ${condition}\n`).join(''));
  try {
    await listFindings({ core, sonarQube, task, summary, usedAnnotations: conditions.length });
  } finally {
    await summary.write();
  }
};

/**
 * Lists the new hotspots and issues of the task's analysis in the log and
 * the job summary, and annotates the first ones.
 */
const listFindings = async ({ core, sonarQube, task, summary, usedAnnotations }) => {
  const warn = (message) => {
    core.warning(message);
    summary.addRaw(`\n${escapeMarkdown(message)}\n`);
  };
  // The search reads all issues of a PR, but only the new code period of a
  // branch. A PR analysis holds only the PR's changes, so all its issues are
  // new.
  const scope = task.pullRequest
    ? { pullRequest: task.pullRequest }
    : { branch: task.branch, inNewCodePeriod: true };
  // The function reads hotspots first, so a token without Browse gets a
  // warning. Without Browse, the hotspot search answers 403, but the issue
  // search answers an empty list.
  let hotspots;
  try {
    hotspots = await sonarQube.getAll({
      path: '/api/hotspots/search',
      key: 'hotspots',
      query: { projectKey: task.componentKey, status: 'TO_REVIEW', ...scope },
    });
  } catch (error) {
    if (error.status !== 403) {
      throw error;
    }
    warn(`The SonarQube token may not browse ${task.componentKey}, so its new issues and hotspots stay in SonarQube`);
    return;
  }
  const issues = await sonarQube.getAll({
    path: '/api/issues/search',
    key: 'issues',
    query: { components: task.componentKey, issueStatuses: 'OPEN,CONFIRMED', ...scope },
  });

  /**
   * Returns the path from the repo root, or the project key for a finding on
   * the whole project.
   */
  const pathOf = (component) => component.slice(task.componentKey.length + 1) || component;
  // Hotspots come first, so they get GitHub's first annotations. A project has
  // few hotspots, but its many issues could use up all the annotations.
  const groups = [
    {
      heading: 'security hotspots to review',
      title: 'New hotspot',
      findings: hotspots.items.map((hotspot) => ({ ...hotspot, rule: hotspot.ruleKey })),
    },
    { heading: 'new issues', title: 'New issue', findings: issues.items },
  ].filter((group) => group.findings.length > 0);
  const annotated = groups
    .flatMap(({ title, findings }) => findings.map((finding) => ({ ...finding, title: `${title} ${finding.rule}` })))
    .slice(0, Math.max(0, ANNOTATION_LIMIT - usedAnnotations));
  for (const finding of annotated) {
    core.error(finding.message, { title: finding.title, file: pathOf(finding.component), startLine: finding.line });
  }
  const lines = [];
  for (const { heading, findings } of groups) {
    lines.push(`${findings.length} ${heading}:`);
    summary.addRaw(`\n#### ${findings.length} ${heading}\n\n`);
    for (const finding of findings) {
      const path = pathOf(finding.component);
      const where = finding.line ? `${path}:${finding.line}` : path;
      lines.push(`${where} ${finding.rule} — ${finding.message}`);
      summary.addRaw(`- <code>${escapeMarkdown(where)}</code> ${escapeMarkdown(finding.rule)} — ` +
        `${escapeMarkdown(finding.message)}\n`);
    }
  }
  logInert(core, lines);
  const left = hotspots.left + issues.left;
  if (left > 0) {
    warn(`${left} more new issues and hotspots are in SonarQube`);
  }
};
