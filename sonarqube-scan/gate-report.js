// Explains a failed SonarQube quality gate in the GitHub step that runs it, so a red gate reads without a SonarQube
// login. action.yml runs it with `actions/github-script`, and gate-report.test.js tests it: `mise run test`.

// GitHub turns only a step's first 10 errors into annotations.
const ANNOTATION_LIMIT = 10;
// The search APIs refuse a page past their 10,000th result.
const SEARCH_LIMIT = 10000;
const PAGE_SIZE = 500;

const escapeHtml = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * Names each failed condition, then lists every new issue and security hotspot to review as
 * `path:line rule — message`, in the log and the job summary. The first ones also become annotations at their file
 * and line. `reportTask` is the scanner's `.scannerwork/report-task.txt`, and `token` goes to `host` only.
 */
module.exports = async function reportGate({ core, host, token, reportTask }) {
  const get = async (path, query, { isForbiddenOk = false } = {}) => {
    const response = await fetch(`${host}${path}?${new URLSearchParams(query)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (isForbiddenOk && response.status === 403) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`SonarQube answered ${response.status} to ${path}`);
    }
    return response.json();
  };
  const getAll = async (path, key, query, options) => {
    const items = [];
    for (let page = 1; ; page += 1) {
      const body = await get(path, { ...query, ps: PAGE_SIZE, p: page }, options);
      if (!body) {
        return null;
      }
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
    summary.addRaw(`\n${escapeHtml(message)}\n`);
  };

  // A PR analysis holds only the PR's code, so all its issues are new. A branch's new issues are those in its new
  // code period.
  const scope = task.pullRequest
    ? { pullRequest: task.pullRequest }
    : { branch: task.branch, inNewCodePeriod: true };
  // Without Browse on the project, hotspots answer 403 while issues answer an empty list, so hotspots are read first.
  const hotspots = await getAll('/api/hotspots/search', 'hotspots',
    { projectKey: task.componentKey, status: 'TO_REVIEW', ...scope }, { isForbiddenOk: true });
  if (!hotspots) {
    warn(`The SonarQube token may not browse ${task.componentKey}, ` +
      'so its new issues and hotspots stay in SonarQube');
    await summary.write();
    return;
  }
  const issues = await getAll('/api/issues/search', 'issues',
    { components: task.componentKey, issueStatuses: 'OPEN,CONFIRMED', ...scope });

  // A component key is <project key>:<path from the project's base directory, the repo root here>.
  const file = (component) => component.slice(task.componentKey.length + 1) || component;
  const groups = [
    {
      heading: 'security hotspots to review',
      title: 'New hotspot',
      findings: hotspots.items.map((it) => ({ ...it, rule: it.ruleKey })),
    },
    { heading: 'new issues', title: 'New issue', findings: issues.items },
  ];
  // Hotspots are few, so they come before issues within GitHub's first annotations.
  let annotations = conditions.length;
  for (const { heading, title, findings } of groups) {
    if (findings.length === 0) {
      continue;
    }
    core.info(`${findings.length} ${heading}:`);
    summary.addRaw(`\n#### ${findings.length} ${heading}\n\n`);
    for (const finding of findings) {
      const path = file(finding.component);
      const where = finding.line ? `${path}:${finding.line}` : path;
      core.info(`${where} ${finding.rule} — ${finding.message}`);
      summary.addRaw(`- \`${where}\` ${finding.rule} — ${escapeHtml(finding.message)}\n`);
      if (annotations < ANNOTATION_LIMIT) {
        annotations += 1;
        core.error(finding.message, { title: `${title} ${finding.rule}`, file: path, startLine: finding.line });
      }
    }
  }
  const left = hotspots.left + issues.left;
  if (left > 0) {
    warn(`${left} more new issues and hotspots are in SonarQube`);
  }
  await summary.write();
};
