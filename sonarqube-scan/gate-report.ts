// Explains a failed SonarQube quality gate in the GitHub step that runs it,
// so a red gate reads without a SonarQube login. `action.yml` runs it with
// `actions/github-script`, whose Node strips the types on `require`, and
// `mise run test` runs `gate-report.test.ts`.
import { randomUUID } from 'node:crypto';

/** The part of `@actions/core` this script uses, which `actions/github-script` passes in. */
export type Core = {
  info: (message: string) => void;
  warning: (message: string) => void;
  error: (message: string, properties?: { title?: string; file?: string; startLine?: number }) => void;
  summary: Summary;
};
type Summary = {
  addRaw: (text: string) => Summary;
  write: () => Promise<unknown>;
};

/** The fields of the `/api/ce/task` answer that the script reads. */
type TaskResponse = {
  task: {
    status: string;
    componentKey: string;
    analysisId?: string;
    pullRequest?: string;
    branch?: string;
  };
};
/** The fields of the `/api/qualitygates/project_status` answer that the script reads. */
type ProjectStatusResponse = {
  projectStatus: {
    conditions: {
      status: string;
      metricKey: string;
      comparator: string;
      // SonarQube leaves out the value of a condition it could not measure.
      actualValue?: string;
      errorThreshold: string;
    }[];
  };
};
type Paging = { total: number };
/** The fields of the `/api/issues/search` answer that the script reads. */
type IssuesResponse = {
  paging: Paging;
  issues: { component: string; line?: number; rule: string; message: string }[];
};
/** The fields of the `/api/hotspots/search` answer that the script reads. */
type HotspotsResponse = {
  paging: Paging;
  hotspots: { component: string; line?: number; ruleKey: string; message: string }[];
};
/** An issue or a hotspot, under the issue's field names. */
type Finding = IssuesResponse['issues'][number];
type Query = Record<string, string>;

/** GitHub turns only a step's first 10 errors into annotations. */
const ANNOTATION_LIMIT = 10;
/** The search APIs refuse a page past their 10,000th result. */
const SEARCH_LIMIT = 10000;
const PAGE_SIZE = 100;

// These helpers keep each finding on one log line and show it as plain text
// in the job summary. A path or message can hold a line break or markup,
// because the scan imports reports from the repo's own tools, such as ESLint.
const oneLine = (text: string): string => text.replace(/[\r\n]+/g, ' ');
const escapeMarkdown = (text: string): string => oneLine(text)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replace(/[\\`*_{}[\]()#+\-.!|~]/g, '\\$&');

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
const readText = (value: unknown, key: string): string => {
  const field = fieldOf(value, key);
  if (typeof field !== 'string') {
    throw new Error(`SonarQube sent no text ${key}`);
  }
  return field;
};
const readOptionalText = (value: unknown, key: string): string | undefined => {
  const field = fieldOf(value, key);
  return typeof field === 'string' ? field : undefined;
};
const readNumber = (value: unknown, key: string): number => {
  const field = fieldOf(value, key);
  if (typeof field !== 'number') {
    throw new Error(`SonarQube sent no number ${key}`);
  }
  return field;
};
const readOptionalNumber = (value: unknown, key: string): number | undefined => {
  const field = fieldOf(value, key);
  return typeof field === 'number' ? field : undefined;
};
const readList = (value: unknown, key: string): unknown[] => {
  const field = fieldOf(value, key);
  if (!Array.isArray(field)) {
    throw new Error(`SonarQube sent no list ${key}`);
  }
  return field;
};

const readTaskResponse = (body: unknown): TaskResponse => {
  const task = fieldOf(body, 'task');
  return {
    task: {
      status: readText(task, 'status'),
      componentKey: readText(task, 'componentKey'),
      analysisId: readOptionalText(task, 'analysisId'),
      pullRequest: readOptionalText(task, 'pullRequest'),
      branch: readOptionalText(task, 'branch'),
    },
  };
};
const readProjectStatusResponse = (body: unknown): ProjectStatusResponse => ({
  projectStatus: {
    conditions: readList(fieldOf(body, 'projectStatus'), 'conditions').map((condition) => ({
      status: readText(condition, 'status'),
      metricKey: readText(condition, 'metricKey'),
      comparator: readText(condition, 'comparator'),
      actualValue: readOptionalText(condition, 'actualValue'),
      errorThreshold: readText(condition, 'errorThreshold'),
    })),
  },
});
const readPaging = (body: unknown): Paging => ({ total: readNumber(fieldOf(body, 'paging'), 'total') });
const readIssuesResponse = (body: unknown): IssuesResponse => ({
  paging: readPaging(body),
  issues: readList(body, 'issues').map((issue) => ({
    component: readText(issue, 'component'),
    line: readOptionalNumber(issue, 'line'),
    rule: readText(issue, 'rule'),
    message: readText(issue, 'message'),
  })),
});
const readHotspotsResponse = (body: unknown): HotspotsResponse => ({
  paging: readPaging(body),
  hotspots: readList(body, 'hotspots').map((hotspot) => ({
    component: readText(hotspot, 'component'),
    line: readOptionalNumber(hotspot, 'line'),
    ruleKey: readText(hotspot, 'ruleKey'),
    message: readText(hotspot, 'message'),
  })),
});

const newSonarQube = ({ host, token }: { host: string; token: string }) => {
  const get = async (path: string, query: Query): Promise<unknown> => {
    const response = await fetch(`${host}${path}?${new URLSearchParams(query)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw Object.assign(new Error(`SonarQube answered ${response.status} to ${path}`), { status: response.status });
    }
    return response.json();
  };
  /** Reads every page of a search up to the search limit. Returns the findings and the count left. */
  const searchFindings = async (
    { path, query, readPage }:
    { path: string; query: Query; readPage: (body: unknown) => { paging: Paging; findings: Finding[] } },
  ) => {
    const items: Finding[] = [];
    for (let page = 1; ; page += 1) {
      const { paging, findings } = readPage(await get(path, { ...query, ps: String(PAGE_SIZE), p: String(page) }));
      items.push(...findings);
      if (findings.length === 0 || items.length >= Math.min(paging.total, SEARCH_LIMIT)) {
        return { items, left: paging.total - items.length };
      }
    }
  };
  return { get, searchFindings };
};
type SonarQube = ReturnType<typeof newSonarQube>;

/**
 * Logs each line with workflow commands stopped, so a path or message adds no
 * annotation of its own. The runner reads a log line that starts with `::` as
 * a command.
 */
const logInert = (core: Core, lines: string[]): void => {
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
 * annotates the first ones. `reportTask` is the text of report-task.txt.
 */
export const reportGate = async (
  { core, host, token, reportTask }: { core: Core; host: string; token: string; reportTask: string },
): Promise<void> => {
  const sonarQube = newSonarQube({ host, token });
  const taskId = reportTask.match(/^ceTaskId=(.*)$/m)?.[1] ?? '';
  const { task } = readTaskResponse(await sonarQube.get('/api/ce/task', { id: taskId }));
  if (!task.analysisId) {
    core.warning(`The analysis task is ${task.status}, so it has no quality gate result to read`);
    return;
  }
  const { projectStatus } = readProjectStatusResponse(
    await sonarQube.get('/api/qualitygates/project_status', { analysisId: task.analysisId }),
  );
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
const listFindings = async (
  { core, sonarQube, task, summary, usedAnnotations }:
  { core: Core; sonarQube: SonarQube; task: TaskResponse['task']; summary: Summary; usedAnnotations: number },
): Promise<void> => {
  const warn = (message: string): void => {
    core.warning(message);
    summary.addRaw(`\n${escapeMarkdown(message)}\n`);
  };
  // The search reads all issues of a PR, but only the new code period of a
  // branch. A PR analysis holds only the PR's changes, so all its issues are
  // new.
  const scope: Query = task.pullRequest
    ? { pullRequest: task.pullRequest }
    : { branch: task.branch ?? '', inNewCodePeriod: 'true' };
  // The function reads hotspots first, so a token without Browse gets a
  // warning. Without Browse, the hotspot search answers 403, but the issue
  // search answers an empty list.
  const hotspots = await sonarQube.searchFindings({
    path: '/api/hotspots/search',
    query: { projectKey: task.componentKey, status: 'TO_REVIEW', ...scope },
    readPage: (body) => {
      const response = readHotspotsResponse(body);
      return {
        paging: response.paging,
        findings: response.hotspots.map(({ ruleKey, ...hotspot }) => ({ ...hotspot, rule: ruleKey })),
      };
    },
  }).catch((error: unknown) => {
    if (fieldOf(error, 'status') !== 403) {
      throw error;
    }
    return undefined;
  });
  if (!hotspots) {
    warn(`The SonarQube token may not browse ${task.componentKey}, so its new issues and hotspots stay in SonarQube`);
    return;
  }
  const issues = await sonarQube.searchFindings({
    path: '/api/issues/search',
    query: { components: task.componentKey, issueStatuses: 'OPEN,CONFIRMED', ...scope },
    readPage: (body) => {
      const response = readIssuesResponse(body);
      return { paging: response.paging, findings: response.issues };
    },
  });

  /**
   * Returns the path from the repo root, or the project key for a finding on
   * the whole project.
   */
  const pathOf = (component: string): string => component.slice(task.componentKey.length + 1) || component;
  // Hotspots come first, so they get GitHub's first annotations. A project has
  // few hotspots, but its many issues could use up all the annotations.
  const groups = [
    { heading: 'security hotspots to review', title: 'New hotspot', findings: hotspots.items },
    { heading: 'new issues', title: 'New issue', findings: issues.items },
  ].filter((group) => group.findings.length > 0);
  const annotated = groups
    .flatMap(({ title, findings }) => findings.map((finding) => ({ ...finding, title: `${title} ${finding.rule}` })))
    .slice(0, Math.max(0, ANNOTATION_LIMIT - usedAnnotations));
  for (const finding of annotated) {
    core.error(finding.message, { title: finding.title, file: pathOf(finding.component), startLine: finding.line });
  }
  const lines: string[] = [];
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
