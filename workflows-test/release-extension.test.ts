// Runs the steps of release-extension.yml as written, with a fake mise and a fake gh. Run: `mise run test`.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { stepScript } from './step.ts';

const WORKFLOW = 'release-extension.yml';
const root = mkdtempSync(path.join(tmpdir(), 'release-extension-'));
after(() => rmSync(root, { recursive: true, force: true }));

const bin = path.join(root, 'bin');
mkdirSync(bin);
const fake = (name: string, body: string): void => {
  writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path.join(bin, name), 0o755);
};
// The fake mise prints FAKE_VERSION for any task but FAKE_ZIP_TASK, which runs FAKE_ZIP_RUN, and logs each call.
fake('mise', 'echo "$*" >>"$FAKE_CALLS"\nif [ "${2:-}" = "${FAKE_ZIP_TASK:-}" ]; then eval "$FAKE_ZIP_RUN"; else echo "$FAKE_VERSION"; fi');
// The fake gh logs each call and answers `api` with FAKE_GH_<n> for its n-th api call, failing when the answer
// starts with "!". `release create` prints a URL.
fake(
  'gh',
  [
    'echo "$*" >>"$FAKE_CALLS"',
    'if [ "$1" = api ]; then',
    '  n=$(grep -c "^api " "$FAKE_CALLS"); var="FAKE_GH_$n"; answer=${!var:-}',
    '  if [ "${answer:0:1}" = "!" ]; then echo "${answer:1}" >&2; exit 1; fi',
    '  echo "$answer"',
    'else echo "https://github.com/o/r/releases/tag/web-v1.2.3"; fi',
  ].join('\n'),
);

/** Runs a step as GitHub runs a bash `run:`, in `cwd`, and returns its exit status, output, outputs and fake calls. */
const runStep = (name: string, cwd: string, env: Record<string, string>) => {
  const dir = mkdtempSync(path.join(root, 'run-'));
  const script = path.join(dir, 'step.sh');
  writeFileSync(script, stepScript(WORKFLOW, name));
  const files = { GITHUB_OUTPUT: 'output', GITHUB_STEP_SUMMARY: 'summary', FAKE_CALLS: 'calls' };
  for (const file of Object.values(files)) writeFileSync(path.join(dir, file), '');
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    cwd,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RUNNER_TEMP: dir,
      GITHUB_REPOSITORY: 'o/r',
      RAISE_VERSION: 'Raise the version that mise run web:version prints.',
      ...Object.fromEntries(Object.entries(files).map(([key, file]) => [key, path.join(dir, file)])),
      ...env,
    },
    encoding: 'utf8',
  });
  const read = (file: string): string[] => readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean);
  const outputs = Object.fromEntries(read('output').map((line) => line.split(/=(.*)/s).slice(0, 2)));
  return { status: result.status, stdout: result.stdout, outputs, calls: read('calls'), summary: read('summary') };
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

describe('Pick the version', () => {
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const commit = (message: string): string => {
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', message);
    return git(repo, 'rev-parse', 'HEAD');
  };
  const first = commit('first');
  git(repo, 'tag', 'web-v1.0.0');
  git(repo, 'tag', 'backend-v9.0.0');
  const head = commit('second');

  const pick = (env: Record<string, string> = {}) =>
    runStep('Pick the version', repo, {
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_NAME: 'main',
      DEFAULT_BRANCH: 'main',
      GITHUB_SHA: head,
      VERSION_TASK: 'web:version',
      TAG_PREFIX: 'web-',
      FAKE_VERSION: '1.1.0',
      ...env,
    });

  test('releases a version with no tag, after the last release of the same prefix', () => {
    const { status, outputs, calls } = pick();
    assert.equal(status, 0);
    assert.deepEqual(outputs, { tag: 'web-v1.1.0', version: '1.1.0', previous: 'web-v1.0.0', release: 'true' });
    assert.deepEqual(calls, ['run --quiet web:version']);
  });

  test('releases the first version with no previous release', () => {
    const { outputs } = pick({ TAG_PREFIX: 'ext-' });
    assert.equal(outputs.previous, '');
    assert.equal(outputs.release, 'true');
  });

  test('skips a version tagged on this commit, without a warning', () => {
    const { status, stdout, outputs } = pick({ FAKE_VERSION: '1.0.0', GITHUB_SHA: first });
    assert.equal(status, 0);
    assert.equal(outputs.release, 'false');
    assert.doesNotMatch(stdout, /::warning::/);
  });

  test('skips a version tagged on another commit, with a warning', () => {
    const { status, stdout, outputs } = pick({ FAKE_VERSION: '1.0.0' });
    assert.equal(status, 0);
    assert.equal(outputs.release, 'false');
    assert.match(stdout, new RegExp(`^::warning::web-v1\\.0\\.0 is already released from ${first.slice(0, 7)}, .* Raise the version`, 'm'));
  });

  test('fails on a branch that is not the default one', () => {
    const { status, stdout, calls } = pick({ GITHUB_REF: 'refs/heads/feature', GITHUB_REF_NAME: 'feature' });
    assert.equal(status, 1);
    assert.match(stdout, /^::error::An extension release comes from main, not from feature$/m);
    assert.deepEqual(calls, []);
  });

  for (const version of ['1.2', '1.2.3.4', 'v1.2.3', '']) {
    test(`fails on the printed version «${version}»`, () => {
      const { status, stdout } = pick({ FAKE_VERSION: version });
      assert.equal(status, 1);
      assert.match(stdout, /not one X\.Y\.Z line/);
    });
  }

  for (const [input, value] of [['VERSION_TASK', '-x'], ['VERSION_TASK', 'a b'], ['TAG_PREFIX', 'Web-'], ['TAG_PREFIX', 'a/b']]) {
    test(`fails before mise on ${input} «${value}»`, () => {
      const { status, calls } = pick({ [input]: value });
      assert.equal(status, 1);
      assert.deepEqual(calls, []);
    });
  }
});

describe('Build the zip', () => {
  const build = (zip: string, run: string, task = 'web:zip') => {
    const cwd = mkdtempSync(path.join(root, 'build-'));
    return runStep('Build the zip', cwd, { ZIP_TASK: task, ZIP: zip, FAKE_ZIP_TASK: 'web:zip', FAKE_ZIP_RUN: run });
  };

  test('passes the one file a glob matches', () => {
    const { status, outputs, calls } = build('apps/web/.output/*-chrome.zip', 'mkdir -p apps/web/.output && touch apps/web/.output/x-1.0.0-chrome.zip apps/web/.output/x-1.0.0-sources.zip');
    assert.equal(status, 0);
    assert.deepEqual(outputs, { path: 'apps/web/.output/x-1.0.0-chrome.zip' });
    assert.deepEqual(calls, ['run web:zip']);
  });

  test('passes a plain path', () => {
    const { outputs } = build('apps/web/x.zip', 'mkdir -p apps/web && touch apps/web/x.zip');
    assert.deepEqual(outputs, { path: 'apps/web/x.zip' });
  });

  for (const [what, run] of [['no file', 'true'], ['two files', 'touch a.zip b.zip'], ['a folder', 'mkdir a.zip']]) {
    test(`fails when the glob matches ${what}`, () => {
      const { status, stdout, outputs } = build('*.zip', run);
      assert.equal(status, 1);
      assert.match(stdout, /^::error::mise run web:zip left \d files that match \*\.zip, not one zip$/m);
      assert.deepEqual(outputs, {});
    });
  }

  test('fails before mise on a zip-task that is not a task name', () => {
    const { status, calls } = build('*.zip', 'true', '--help');
    assert.equal(status, 1);
    assert.deepEqual(calls, []);
  });
});

describe('Check the zip', () => {
  /** A folder `extension` holding one zip per entry of `manifests`, each with that manifest.json, or none for null. */
  const artifact = (manifests: (object | null)[]): string => {
    const cwd = mkdtempSync(path.join(root, 'artifact-'));
    mkdirSync(path.join(cwd, 'extension'));
    manifests.forEach((manifest, i) => {
      const content = mkdtempSync(path.join(root, 'content-'));
      writeFileSync(path.join(content, manifest ? 'manifest.json' : 'other.json'), JSON.stringify(manifest ?? {}));
      execFileSync('zip', ['-q', '-r', path.join(cwd, 'extension', `x-${i}.zip`), '.'], { cwd: content });
    });
    return cwd;
  };
  const check = (cwd: string, env: Record<string, string> = {}) =>
    runStep('Check the zip', cwd, { TAG_PREFIX: 'web-', VERSION_TASK: 'web:version', VERSION: '1.2.3', TAG: 'web-v1.2.3', PREVIOUS: 'web-v1.2.2', ...env });

  test('passes a zip whose manifest gives the version', () => {
    const { status, outputs } = check(artifact([{ version: '1.2.3' }]));
    assert.equal(status, 0);
    assert.deepEqual(outputs, { path: 'extension/x-0.zip' });
  });

  test('passes the first release, with no previous one', () => {
    assert.equal(check(artifact([{ version: '1.2.3' }]), { PREVIOUS: '' }).status, 0);
  });

  test('fails on a manifest with another version', () => {
    const { status, stdout } = check(artifact([{ version: '1.2.4' }]));
    assert.equal(status, 1);
    assert.match(stdout, /^::error::The zip's manifest\.json gives the version «1\.2\.4», not 1\.2\.3\. mise run web:version/m);
  });

  test('fails on a zip with no manifest.json', () => {
    const { status, stdout } = check(artifact([null]));
    assert.equal(status, 1);
    assert.match(stdout, /^::error::The zip holds no manifest\.json at its root$/m);
  });

  for (const count of [0, 2]) {
    test(`fails on ${count} zips`, () => {
      const { status, stdout } = check(artifact(Array.from({ length: count }, () => ({ version: '1.2.3' }))));
      assert.equal(status, 1);
      assert.match(stdout, new RegExp(`^::error::The build left ${count} zips, not one$`, 'm'));
    });
  }

  const badOutputs: Record<string, string>[] = [
    { VERSION: '1.2.3-dev.1', TAG: 'web-v1.2.3-dev.1' },
    { TAG: 'web-v1.2.4' },
    { TAG: 'backend-v1.2.3' },
    { PREVIOUS: 'backend-v1.2.2' },
    { PREVIOUS: 'web-v1.2.2 --draft' },
    { PREVIOUS: 'web-vx' },
  ];
  for (const env of badOutputs) {
    test(`fails on the build job's outputs ${JSON.stringify(env)}`, () => {
      const { status, stdout } = check(artifact([{ version: '1.2.3' }]), env);
      assert.equal(status, 1);
      assert.match(stdout, /^::error::The build job passed/m);
    });
  }
});

describe('Check the version is still free', () => {
  const SHA = 'a'.repeat(40);
  const free = (answers: string[]) =>
    runStep('Check the version is still free', root, {
      TAG: 'web-v1.2.3',
      GITHUB_SHA: SHA,
      ...Object.fromEntries(answers.map((answer, i) => [`FAKE_GH_${i + 1}`, answer])),
    });

  test('releases when the tag is not found', () => {
    const { status, outputs, calls } = free(['!gh: Not Found (HTTP 404)']);
    assert.equal(status, 0);
    assert.deepEqual(outputs, { release: 'true' });
    assert.match(calls[0], /^api repos\/o\/r\/git\/ref\/tags\/web-v1\.2\.3 /);
  });

  test('skips a tag on this commit, without a warning', () => {
    const { status, stdout, outputs } = free([`commit ${SHA}`]);
    assert.equal(status, 0);
    assert.deepEqual(outputs, { release: 'false' });
    assert.doesNotMatch(stdout, /::warning::/);
  });

  test('skips a tag on another commit, with a warning', () => {
    const { status, stdout, outputs } = free([`commit ${'b'.repeat(40)}`]);
    assert.equal(status, 0);
    assert.deepEqual(outputs, { release: 'false' });
    assert.match(stdout, /^::warning::web-v1\.2\.3 was released from bbbbbbb while this run waited/m);
  });

  test('follows an annotated tag to its commit', () => {
    const { outputs, stdout, calls } = free([`tag ${'c'.repeat(40)}`, SHA]);
    assert.deepEqual(outputs, { release: 'false' });
    assert.doesNotMatch(stdout, /::warning::/);
    assert.match(calls[1], new RegExp(`^api repos/o/r/git/tags/${'c'.repeat(40)} `));
  });

  test('fails when GitHub answers with another error', () => {
    const { status, stdout, outputs } = free(['!gh: Server Error (HTTP 502)']);
    assert.equal(status, 1);
    assert.match(stdout, /^::error::Could not check the tag web-v1\.2\.3: gh: Server Error \(HTTP 502\)$/m);
    assert.deepEqual(outputs, {});
  });
});

describe('Publish the release', () => {
  const publish = (previous: string) =>
    runStep('Publish the release', root, { TAG: 'web-v1.2.3', VERSION: '1.2.3', PREVIOUS: previous, ZIP: 'extension/x.zip', GITHUB_SHA: 'a'.repeat(40) });
  const CREATE = `release create web-v1.2.3 extension/x.zip --repo o/r --target ${'a'.repeat(40)} --title Extension 1.2.3 --generate-notes`;

  test('lists the changes since the previous release', () => {
    const { status, calls, summary } = publish('web-v1.2.2');
    assert.equal(status, 0);
    assert.deepEqual(calls, [`${CREATE} --notes-start-tag web-v1.2.2`]);
    assert.match(summary[0], /^Released web-v1\.2\.3 with x\.zip: https:\/\/github\.com\//);
  });

  test('lets GitHub pick the start of the first release notes', () => {
    const { status, calls } = publish('');
    assert.equal(status, 0);
    assert.deepEqual(calls, [CREATE]);
  });
});
