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

/** The analysis task that `/api/ce/task` returns. */
type Task = {
  status: string;
  componentKey: string;
  analysisId?: string;
  pullRequest?: string;
  branch?: string;
};
/** A quality gate condition that `/api/qualitygates/project_status` returns. */
type Condition = {
  status: string;
  metricKey: string;
  comparator: string;
  actualValue?: string;
  errorThreshold?: string;
};
/** An issue from `/api/issues/search` or a hotspot from `/api/hotspots/search`. */
type Finding = {
  component: string;
  line?: number;
  rule: string;
  message: string;
};
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

// These readers check each field the script uses, so an answer of another
// shape fails with the field's name instead of printing `undefined`.
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
const readList = (value: unknown, key: string): unknown[] => {
  const field = fieldOf(value, key);
  if (!Array.isArray(field)) {
    throw new Error(`SonarQube sent no list ${key}`);
  }
  return field;
};

const readTask = (body: unknown): Task => {
  const task = fieldOf(body, 'task');
  return {
    status: readText(task, 'status'),
    componentKey: readText(task, 'componentKey'),
    analysisId: readOptionalText(task, 'analysisId'),
    pullRequest: readOptionalText(task, 'pullRequest'),
    branch: readOptionalText(task, 'branch'),
  };
};
const readConditions = (body: unknown): Condition[] =>
  readList(fieldOf(body, 'projectStatus'), 'conditions').map((condition) => ({
    status: readText(condition, 'status'),
    metricKey: readText(condition, 'metricKey'),
    comparator: readText(condition, 'comparator'),
    actualValue: readOptionalText(condition, 'actualValue'),
    errorThreshold: readOptionalText(condition, 'errorThreshold'),
  }));
/** Reads a finding whose rule key sits in `ruleField`: `rule` for an issue, `ruleKey` for a hotspot. */
const readFinding = (item: unknown, ruleField: string): Finding => {
  const line = fieldOf(item, 'line');
  return {
    component: readText(item, 'component'),
    line: typeof line === 'number' ? line : undefined,
    rule: readText(item, ruleField),
    message: readText(item, 'message'),
  };
};

/** Returns a client that reads the SonarQube Web API at `host` with `token`. */
const newSonarQube = ({ host, token }: { host: string; token: string }) => {
  const get = async (path: string, query: Query): Promise<unknown> => {
    const response = await fetch(`${host}${path}?${new URLSearchParams(query)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw Object.assign(new Error(`SonarQube answered ${response.status} to ${path}`), { status: response.status });
    }
    const body: unknown = await response.json();
    return body;
  };
  /** Returns the findings up to the search limit, and the count of findings left. */
  const getAll = async ({ path, key, ruleField, query }: { path: string; key: string; ruleField: string; query: Query }) => {
    const items: Finding[] = [];
    for (let page = 1; ; page += 1) {
      const body = await get(path, { ...query, ps: String(PAGE_SIZE), p: String(page) });
      const pageItems = readList(body, key);
      items.push(...pageItems.map((item) => readFinding(item, ruleField)));
      const total = readNumber(fieldOf(body, 'paging'), 'total');
      if (pageItems.length === 0 || items.length >= Math.min(total, SEARCH_LIMIT)) {
        return { items, left: total - items.length };
      }
    }
  };
  return { get, getAll };
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
 * annotates the first ones. `reportTask` is the scanner's report-task.txt.
 */
export const reportGate = async (
  { core, host, token, reportTask }: { core: Core; host: string; token: string; reportTask: string },
): Promise<void> => {
  const sonarQube = newSonarQube({ host, token });
  const taskId = reportTask.match(/^ceTaskId=(.*)$/m)?.[1] ?? '';
  const task = readTask(await sonarQube.get('/api/ce/task', { id: taskId }));
  if (!task.analysisId) {
    core.warning(`The analysis task is ${task.status}, so it has no quality gate result to read`);
    return;
  }
  const conditions = readConditions(await sonarQube.get('/api/qualitygates/project_status', { analysisId: task.analysisId }))
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
  { core: Core; sonarQube: SonarQube; task: Task; summary: Summary; usedAnnotations: number },
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
  let hotspots;
  try {
    hotspots = await sonarQube.getAll({
      path: '/api/hotspots/search',
      key: 'hotspots',
      ruleField: 'ruleKey',
      query: { projectKey: task.componentKey, status: 'TO_REVIEW', ...scope },
    });
  } catch (error) {
    if (fieldOf(error, 'status') !== 403) {
      throw error;
    }
    warn(`The SonarQube token may not browse ${task.componentKey}, so its new issues and hotspots stay in SonarQube`);
    return;
  }
  const issues = await sonarQube.getAll({
    path: '/api/issues/search',
    key: 'issues',
    ruleField: 'rule',
    query: { components: task.componentKey, issueStatuses: 'OPEN,CONFIRMED', ...scope },
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
