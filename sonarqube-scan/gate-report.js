// Explains a failed SonarQube quality gate in the GitHub step that runs it, so a red gate reads without a SonarQube
// login. action.yml runs it with `actions/github-script`, and gate-report.test.js tests it: `mise run test`.
const { randomUUID } = require('node:crypto');

/** GitHub turns only a step's first 10 errors into annotations. */
const ANNOTATION_LIMIT = 10;
/** The search APIs refuse a page past their 10,000th result. */
const SEARCH_LIMIT = 10000;
const PAGE_SIZE = 100;

// The repo's own tools write reports the scan imports, such as an ESLint report, so a path or message may hold a
// line break or markup. Each finding keeps to one log line and shows in the job summary as plain text.
const oneLine = (text) => String(text).replace(/[\r\n]+/g, ' ');
const escapeHtml = (text) => oneLine(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escapeMarkdown = (text) => escapeHtml(text).replace(/[\\`*_{}[\]()#+\-.!|~]/g, '\\$&');

/**
 * Names each failed condition, then lists every new issue and security hotspot to review as
 * `path:line rule — message`, in the log and the job summary. The first ones also become annotations at their file
 * and line. `reportTask` is the scanner's `.scannerwork/report-task.txt`, and `token` goes to `host` only.
 */
module.exports = async function reportGate({ core, host, token, reportTask }) {
  const get = async (path, query) => {
    const response = await fetch(`${host}${path}?${new URLSearchParams(query)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw Object.assign(new Error(`SonarQube answered ${response.status} to ${path}`), { status: response.status });
    }
    return response.json();
  };
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

  const taskId = reportTask.match(/^ceTaskId=(.*)$/m)?.[1];
  const { task } = await get('/api/ce/task', { id: taskId });
  if (!task.analysisId) {
    core.warning(`The analysis task is ${task.status}, so it has no quality gate result to read`);
    return;
  }
  const { projectStatus } = await get('/api/qualitygates/project_status', { analysisId: task.analysisId });
  const conditions = projectStatus.conditions
    .filter((condition) => condition.status === 'ERROR')
    .map((condition) => `${condition.metricKey} is ${condition.actualValue}, ` +
      `the gate wants it not ${condition.comparator === 'GT' ? 'above' : 'below'} ${condition.errorThreshold}`);
  conditions.forEach((condition) => core.error(condition));
  const summary = core.summary.addRaw('### Quality gate failed\n\n')
    .addRaw(conditions.map((condition) => `- ${condition}\n`).join(''));
  const warn = (message) => {
    core.warning(message);
    summary.addRaw(`\n${escapeMarkdown(message)}\n`);
  };
  // The summary is written even when a search fails, so the failed conditions still reach it.
  try {
    await listFindings({ core, task, summary, warn, getAll, annotationCount: conditions.length });
  } finally {
    await summary.write();
  }
};

/** Lists the new hotspots and issues of the task's analysis, and annotates the first ones. */
const listFindings = async ({ core, task, summary, warn, getAll, annotationCount }) => {
  // The search reads all of a PR's issues, but only a branch's new code period. A PR analysis holds only the PR's
  // code, so all its issues are new.
  const scope = task.pullRequest
    ? { pullRequest: task.pullRequest }
    : { branch: task.branch, inNewCodePeriod: true };
  // Hotspots are read first, so a token without Browse on the project ends in a warning. Without Browse, the hotspot
  // search answers 403 and the issue search answers an empty list.
  let hotspots;
  try {
    hotspots = await getAll({
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
  const issues = await getAll({
    path: '/api/issues/search',
    key: 'issues',
    query: { components: task.componentKey, issueStatuses: 'OPEN,CONFIRMED', ...scope },
  });

  /** Returns the path from the repo root, or the project key for a finding on the whole project. */
  const pathOf = (component) => component.slice(task.componentKey.length + 1) || component;
  // Hotspots come first, so they get GitHub's first annotations. A project has few hotspots and may have many issues.
  const groups = [
    {
      heading: 'security hotspots to review',
      title: 'New hotspot',
      findings: hotspots.items.map((hotspot) => ({ ...hotspot, rule: hotspot.ruleKey })),
    },
    { heading: 'new issues', title: 'New issue', findings: issues.items },
  ].filter((group) => group.findings.length > 0);
  for (const { title, findings } of groups) {
    for (const finding of findings.slice(0, ANNOTATION_LIMIT - annotationCount)) {
      annotationCount += 1;
      core.error(finding.message,
        { title: `${title} ${finding.rule}`, file: pathOf(finding.component), startLine: finding.line });
    }
  }
  // The runner reads a log line that starts with `::` as a command. Stopping commands keeps a path or message from
  // adding annotations of its own.
  const resume = randomUUID();
  core.info(`::stop-commands::${resume}`);
  for (const { heading, findings } of groups) {
    core.info(`${findings.length} ${heading}:`);
    summary.addRaw(`\n#### ${findings.length} ${heading}\n\n`);
    for (const finding of findings) {
      const path = pathOf(finding.component);
      const where = finding.line ? `${path}:${finding.line}` : path;
      core.info(oneLine(`${where} ${finding.rule} — ${finding.message}`));
      summary.addRaw(`- <code>${escapeHtml(where)}</code> ${escapeMarkdown(finding.rule)} — ` +
        `${escapeMarkdown(finding.message)}\n`);
    }
  }
  core.info(`::${resume}::`);
  const left = hotspots.left + issues.left;
  if (left > 0) {
    warn(`${left} more new issues and hotspots are in SonarQube`);
  }
};
