// Tests gate-report.js against a fake SonarQube served on localhost. Run: `mise run test`.
const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const reportGate = require('./gate-report.js');

const TOKEN = 'token-1';
const PROJECT = 'demo';
// The fake serves at most this many items a page, whatever `ps` asks, so a list spans several pages.
const PAGE_SIZE = 10;

const issue = (n) => ({
  component: `${PROJECT}:src/file-${n}.ts`,
  line: n,
  rule: `typescript:S${n}`,
  message: `Issue ${n}`,
});

/** Starts a fake SonarQube with these hotspots and issues, and returns its URL and the queries it answered. */
const startSonarQube = async ({ hotspots, issues, isForbidden = false }) => {
  const queries = [];
  const page = (items, query) => {
    const index = Number(query.get('p') ?? 1);
    return {
      paging: { pageIndex: index, pageSize: PAGE_SIZE, total: items.length },
      items: items.slice((index - 1) * PAGE_SIZE, index * PAGE_SIZE),
    };
  };
  const answer = (url) => {
    const query = url.searchParams;
    switch (url.pathname) {
      case '/api/ce/task':
        return { task: { analysisId: 'analysis-1', componentKey: PROJECT, pullRequest: '48' } };
      case '/api/qualitygates/project_status':
        return {
          projectStatus: {
            conditions: [
              { status: 'ERROR', metricKey: 'new_violations', comparator: 'GT', actualValue: '25', errorThreshold: '0' },
              { status: 'OK', metricKey: 'new_coverage', comparator: 'LT', actualValue: '90', errorThreshold: '80' },
            ],
          },
        };
      case '/api/hotspots/search': {
        const { paging, items } = page(hotspots, query);
        return { paging, hotspots: items };
      }
      case '/api/issues/search': {
        const { paging, items } = page(issues, query);
        return { paging, issues: items };
      }
      default:
        return undefined;
    }
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    queries.push(url);
    const body = request.headers.authorization === `Bearer ${TOKEN}` ? answer(url) : undefined;
    const status = isForbidden && url.pathname === '/api/hotspots/search' ? 403 : body ? 200 : 401;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { host: `http://127.0.0.1:${server.address().port}`, queries, close: () => server.close() };
};

/** Records what the script sends to the step, as `@actions/core` would show it. */
const fakeCore = () => {
  const core = {
    errors: [],
    warnings: [],
    log: [],
    error: (message, properties) => core.errors.push({ message, ...properties }),
    warning: (message) => core.warnings.push(message),
    info: (line) => core.log.push(line),
    summary: {
      text: '',
      written: '',
      addRaw(text) {
        this.text += text;
        return this;
      },
      async write() {
        this.written = this.text;
        return this;
      },
    },
  };
  return core;
};

const run = async (sonarQube) => {
  const core = fakeCore();
  try {
    await reportGate({ core, host: sonarQube.host, token: TOKEN, reportTask: 'ceTaskId=task-1\n' });
  } finally {
    sonarQube.close();
  }
  return core;
};

test('lists every hotspot and issue across all pages in the log and the job summary', async () => {
  const issues = Array.from({ length: 23 }, (_, i) => issue(i + 1));
  issues.push({ component: `${PROJECT}:src/ключ.ts`, rule: 'typescript:S100', message: 'Rename <T> & "ключ"' });
  const hotspots = [
    { component: `${PROJECT}:src/auth.ts`, line: 7, ruleKey: 'typescript:S2068', message: 'Review this password' },
  ];
  const sonarQube = await startSonarQube({ hotspots, issues });

  const core = await run(sonarQube);

  const lines = [
    'src/auth.ts:7 typescript:S2068 — Review this password',
    ...issues.slice(0, 23).map((it) => `src/file-${it.line}.ts:${it.line} ${it.rule} — Issue ${it.line}`),
    'src/ключ.ts typescript:S100 — Rename <T> & "ключ"',
  ];
  for (const line of lines) {
    assert.ok(core.log.includes(line), `the log lacks "${line}"`);
    const markdown = line.replace(/^(\S+) /, '`$1` ')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    assert.ok(core.summary.written.includes(markdown), `the job summary lacks "${markdown}"`);
  }
  assert.ok(core.summary.written.includes('new_violations is 25, the gate wants it not above 0'));
  assert.ok(sonarQube.queries.filter((url) => url.pathname === '/api/issues/search').length >= 3);
  for (const url of sonarQube.queries.filter((it) => it.pathname.endsWith('/search'))) {
    assert.equal(url.searchParams.get('pullRequest'), '48');
  }
  assert.deepEqual(core.warnings, []);
});

test('annotates the failed conditions, then hotspots and issues, up to 10 errors with file and line', async () => {
  const issues = Array.from({ length: 23 }, (_, i) => issue(i + 1));
  const hotspots = [
    { component: `${PROJECT}:src/auth.ts`, line: 7, ruleKey: 'typescript:S2068', message: 'Review this password' },
  ];

  const core = await run(await startSonarQube({ hotspots, issues }));

  assert.equal(core.errors.length, 10);
  assert.equal(core.errors[0].message, 'new_violations is 25, the gate wants it not above 0');
  assert.deepEqual(
    core.errors.slice(1, 3).map(({ file, startLine, title }) => ({ file, startLine, title })),
    [
      { file: 'src/auth.ts', startLine: 7, title: 'New hotspot typescript:S2068' },
      { file: 'src/file-1.ts', startLine: 1, title: 'New issue typescript:S1' },
    ],
  );
});

test('warns and lists only the conditions when the token may not browse the project', async () => {
  const core = await run(await startSonarQube({ hotspots: [], issues: [issue(1)], isForbidden: true }));

  assert.deepEqual(core.warnings,
    [`The SonarQube token may not browse ${PROJECT}, so its new issues and hotspots stay in SonarQube`]);
  assert.equal(core.errors.length, 1);
  assert.ok(core.summary.written.includes('new_violations is 25'));
  assert.ok(!core.log.some((line) => line.includes('Issue 1')));
});
