// Tests gate-report.ts against a fake SonarQube served on localhost. Run: `mise run test`.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { reportGate, type Core } from './gate-report.ts';

const TOKEN = 'token-1';
const PROJECT = 'demo';
/**
 * The fake serves at most this many items a page and ignores `ps`.
 * A list longer than this then spans several pages.
 */
const PAGE_SIZE = 10;
const PR_TASK = { status: 'SUCCESS', analysisId: 'analysis-1', componentKey: PROJECT, pullRequest: '48' };
const CONDITION = 'new_violations is 25, the gate wants it not above 0';
const HOTSPOT = { component: `${PROJECT}:src/auth.ts`, line: 7, ruleKey: 'typescript:S2068', message: 'Review this password' };

type Issue = { component: string; line?: number; rule: string; message: string };
type FakeSonarQube = {
  task?: object;
  failedConditions?: number;
  hotspots?: object[];
  issues?: object[];
  hiddenIssues?: number;
  status?: Record<string, number>;
};
type Annotation = { message: string; title?: string; file?: string; startLine?: number };
type FakeCore = Core & {
  errors: Annotation[];
  warnings: string[];
  log: string[];
  summary: Core['summary'] & { text: string; written: string };
};

const newIssue = (n: number): Issue => ({
  component: `${PROJECT}:src/file-${n}.ts`,
  line: n,
  rule: `typescript:S${n}`,
  message: `Issue ${n}`,
});
const newIssues = (count: number): Issue[] => Array.from({ length: count }, (_, i) => newIssue(i + 1));
const newCondition = (metricKey: string) =>
  ({ status: 'ERROR', metricKey, comparator: 'GT', actualValue: '25', errorThreshold: '0' });

/**
 * Starts a fake SonarQube that serves these hotspots and issues.
 * Returns its URL, the requests it answered, and a function that stops it.
 * `status` overrides the HTTP status for a path. `hiddenIssues` counts issues
 * that the total holds but no page serves.
 */
const startSonarQube = async ({
  task = PR_TASK, failedConditions = 1, hotspots = [], issues = [], hiddenIssues = 0, status = {},
}: FakeSonarQube) => {
  const requests: URL[] = [];
  const page = <T>({ items, query, total = items.length }: { items: T[]; query: URLSearchParams; total?: number }) => {
    const index = Number(query.get('p') ?? 1);
    return {
      paging: { pageIndex: index, pageSize: PAGE_SIZE, total },
      items: items.slice((index - 1) * PAGE_SIZE, index * PAGE_SIZE),
    };
  };
  const answer = (url: URL): object | undefined => {
    const query = url.searchParams;
    switch (url.pathname) {
      case '/api/ce/task':
        return { task };
      case '/api/qualitygates/project_status':
        return {
          projectStatus: {
            conditions: [
              newCondition('new_violations'),
              ...Array.from({ length: failedConditions - 1 }, (_, i) => newCondition(`metric_${i}`)),
              { status: 'OK', metricKey: 'new_coverage', comparator: 'LT', actualValue: '90', errorThreshold: '80' },
            ],
          },
        };
      case '/api/hotspots/search': {
        const { paging, items } = page({ items: hotspots, query });
        return { paging, hotspots: items };
      }
      case '/api/issues/search': {
        const { paging, items } = page({ items: issues, query, total: issues.length + hiddenIssues });
        return { paging, issues: items };
      }
      default:
        return undefined;
    }
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    requests.push(url);
    const body = request.headers.authorization === `Bearer ${TOKEN}` ? answer(url) : undefined;
    response.writeHead(status[url.pathname] ?? (body ? 200 : 401), { 'content-type': 'application/json' });
    response.end(JSON.stringify(body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'the fake SonarQube has no port');
  return { host: `http://127.0.0.1:${address.port}`, requests, close: () => server.close() };
};

/** Records what the script sends to the step, as `@actions/core` would show it. */
const newFakeCore = (): FakeCore => {
  const errors: Annotation[] = [];
  const warnings: string[] = [];
  const log: string[] = [];
  const summary: FakeCore['summary'] = {
    text: '',
    written: '',
    addRaw: (text) => {
      summary.text += text;
      return summary;
    },
    write: async () => {
      summary.written = summary.text;
    },
  };
  return {
    errors,
    warnings,
    log,
    error: (message, properties) => errors.push({ message, ...properties }),
    warning: (message) => warnings.push(message),
    info: (line) => log.push(line),
    summary,
  };
};

/**
 * Runs the script on `core` against a fake SonarQube with these options.
 * Returns the requests that the fake answered.
 */
const run = async ({ core, ...options }: FakeSonarQube & { core: FakeCore }): Promise<URL[]> => {
  const sonarQube = await startSonarQube(options);
  try {
    await reportGate({ core, host: sonarQube.host, token: TOKEN, reportTask: 'ceTaskId=task-1\n' });
    return sonarQube.requests;
  } finally {
    sonarQube.close();
  }
};

test('lists every hotspot and issue across all pages in the log and the job summary', async () => {
  const core = newFakeCore();
  const issues = newIssues(23);
  issues.push({ component: `${PROJECT}:src/ключ.ts`, rule: 'typescript:S100', message: 'Rename <T> & "ключ"' });

  const requests = await run({ core, hotspots: [HOTSPOT], issues });

  for (const line of [
    '1 security hotspots to review:',
    'src/auth.ts:7 typescript:S2068 — Review this password',
    '24 new issues:',
    'src/file-1.ts:1 typescript:S1 — Issue 1',
    'src/file-23.ts:23 typescript:S23 — Issue 23',
    'src/ключ.ts typescript:S100 — Rename <T> & "ключ"',
  ]) {
    assert.ok(core.log.includes(line), `the log lacks "${line}"`);
  }
  for (const line of [
    `- ${CONDITION}`,
    '#### 1 security hotspots to review',
    '- <code>src/auth\\.ts:7</code> typescript:S2068 — Review this password',
    '#### 24 new issues',
    '- <code>src/file\\-1\\.ts:1</code> typescript:S1 — Issue 1',
    '- <code>src/file\\-23\\.ts:23</code> typescript:S23 — Issue 23',
    '- <code>src/ключ\\.ts</code> typescript:S100 — Rename &lt;T&gt; &amp; "ключ"',
  ]) {
    assert.ok(core.summary.written.includes(`${line}\n`), `the job summary lacks "${line}"`);
  }
  const searches = requests.filter((url) => url.pathname.endsWith('/search'));
  assert.equal(searches.length, 4);
  for (const url of searches) {
    assert.equal(url.searchParams.get('pullRequest'), '48');
  }
  assert.deepEqual(core.warnings, []);
});

test('annotates the failed conditions, then hotspots and issues, up to 10 errors with file and line', async () => {
  const core = newFakeCore();

  await run({ core, hotspots: [HOTSPOT], issues: newIssues(23) });

  assert.equal(core.errors.length, 10);
  assert.equal(core.errors[0]?.message, CONDITION);
  assert.deepEqual(
    core.errors.slice(1, 3).map(({ file, startLine, title }) => ({ file, startLine, title })),
    [
      { file: 'src/auth.ts', startLine: 7, title: 'New hotspot typescript:S2068' },
      { file: 'src/file-1.ts', startLine: 1, title: 'New issue typescript:S1' },
    ],
  );
});

test('annotates no finding when the failed conditions take all 10 annotations', async () => {
  const core = newFakeCore();

  await run({ core, failedConditions: 11, issues: newIssues(3) });

  assert.equal(core.errors.length, 11);
  assert.ok(core.errors.every((error) => error.file === undefined));
  assert.ok(core.log.includes('src/file-3.ts:3 typescript:S3 — Issue 3'));
});

test('reads a branch analysis in its new code period', async () => {
  const core = newFakeCore();

  const requests = await run({
    core,
    task: { status: 'SUCCESS', analysisId: 'analysis-1', componentKey: PROJECT, branch: 'main' },
    issues: newIssues(1),
  });

  const searches = requests.filter((url) => url.pathname.endsWith('/search'));
  assert.equal(searches.length, 2);
  for (const url of searches) {
    assert.equal(url.searchParams.get('branch'), 'main');
    assert.equal(url.searchParams.get('inNewCodePeriod'), 'true');
    assert.equal(url.searchParams.get('pullRequest'), null);
  }
  assert.ok(core.log.includes('src/file-1.ts:1 typescript:S1 — Issue 1'));
});

test('warns about the findings past what SonarQube serves, in the log and the job summary', async () => {
  const core = newFakeCore();

  await run({ core, issues: newIssues(3), hiddenIssues: 5 });

  const warning = '5 more new issues and hotspots are in SonarQube';
  assert.deepEqual(core.warnings, [warning]);
  assert.ok(core.summary.written.includes(warning));
});

test('warns and lists only the conditions when the token may not browse the project', async () => {
  const core = newFakeCore();

  await run({ core, issues: [newIssue(1)], status: { '/api/hotspots/search': 403 } });

  const warning = `The SonarQube token may not browse ${PROJECT}, so its new issues and hotspots stay in SonarQube`;
  assert.deepEqual(core.warnings, [warning]);
  assert.equal(core.errors.length, 1);
  assert.ok(core.summary.written.includes(`- ${CONDITION}`));
  assert.ok(core.summary.written.includes(warning));
  assert.ok(!core.log.some((line) => line.includes('Issue 1')));
});

test('writes the failed conditions to the job summary when a search fails', async () => {
  const core = newFakeCore();

  await assert.rejects(run({ core, issues: [newIssue(1)], status: { '/api/issues/search': 500 } }),
    /SonarQube answered 500 to \/api\/issues\/search/);

  assert.ok(core.summary.written.includes(`- ${CONDITION}`));
});

test('names the field when SonarQube answers in another shape', async () => {
  const core = newFakeCore();

  await assert.rejects(run({ core, issues: [{ component: `${PROJECT}:src/a.ts`, line: 1, message: 'x' }] }),
    /SonarQube sent no text rule/);
});

test('warns when the analysis task has no analysis', async () => {
  const core = newFakeCore();

  await run({ core, task: { componentKey: PROJECT, status: 'FAILED' } });

  assert.deepEqual(core.warnings, ['The analysis task is FAILED, so it has no quality gate result to read']);
  assert.deepEqual(core.errors, []);
});

test('keeps a path or message with a line break and markup to one inert line', async () => {
  const core = newFakeCore();
  const issue = {
    component: `${PROJECT}:src/[Sign in](https:/evil.example)/__init__.py`,
    line: 3,
    rule: 'eslint:x',
    message: 'x\n::error file=src/auth.ts::Approved\n### Gate passed [login](https://evil.example)',
  };

  await run({ core, issues: [issue] });

  const start = core.log.findIndex((line) => line.startsWith('::stop-commands::'));
  const resume = core.log[start]?.slice('::stop-commands::'.length);
  const end = core.log.indexOf(`::${resume}::`);
  const listed = core.log.findIndex((line) => line.startsWith('src/[Sign in]'));
  assert.ok(start < listed && listed < end, 'the finding is not listed while commands are stopped');
  assert.equal(core.log[listed], 'src/[Sign in](https:/evil.example)/__init__.py:3 eslint:x — ' +
    'x ::error file=src/auth.ts::Approved ### Gate passed [login](https://evil.example)');
  assert.ok(core.summary.written.includes(
    '- <code>src/\\[Sign in\\]\\(https:/evil\\.example\\)/\\_\\_init\\_\\_\\.py:3</code> eslint:x — ' +
    'x ::error file=src/auth\\.ts::Approved \\#\\#\\# Gate passed \\[login\\]\\(https://evil\\.example\\)\n'));
});
