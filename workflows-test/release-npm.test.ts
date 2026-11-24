// Runs the steps of release-npm.yml as written, with a fake gh. Run: `mise run test`.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { stepScript } from './step.ts';

const WORKFLOW = 'release-npm.yml';
const root = mkdtempSync(path.join(tmpdir(), 'release-npm-'));
after(() => rmSync(root, { recursive: true, force: true }));

const bin = path.join(root, 'bin');
mkdirSync(bin);
// The fake gh logs each call.
writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env bash\necho "$*" >>"$FAKE_CALLS"\n');
chmodSync(path.join(bin, 'gh'), 0o755);

/** Runs a step as GitHub runs a bash `run:`, in `cwd`, and returns its exit status, output, outputs and gh calls. */
const runStep = (name: string, cwd: string, env: Record<string, string>) => {
  const dir = mkdtempSync(path.join(root, 'run-'));
  const script = path.join(dir, 'step.sh');
  writeFileSync(script, stepScript(WORKFLOW, name));
  const files = { GITHUB_OUTPUT: 'output', FAKE_CALLS: 'calls' };
  for (const file of Object.values(files)) writeFileSync(path.join(dir, file), '');
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    cwd,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GITHUB_REPOSITORY: 'o/r',
      ...Object.fromEntries(Object.entries(files).map(([key, file]) => [key, path.join(dir, file)])),
      ...env,
    },
    encoding: 'utf8',
  });
  const read = (file: string): string[] => readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean);
  const outputs = Object.fromEntries(read('output').map((line) => line.split(/=(.*)/s).slice(0, 2)));
  return { status: result.status, stdout: result.stdout, outputs, calls: read('calls') };
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

const writePackage = (dir: string, name: string, version: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
};

describe('Pick the version', () => {
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writePackage(repo, '@o/tool', '1.0.0');
  writePackage(path.join(repo, 'packages/viewer'), '@o/viewer', '0.2.0');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first');
  const first = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'tag', 'v1.0.0');
  git(repo, 'tag', 'viewer-v0.1.0');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'second');
  const head = git(repo, 'rev-parse', 'HEAD');

  const pick = (env: Record<string, string> = {}) =>
    runStep('Pick the version', repo, {
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_NAME: 'main',
      DEFAULT_BRANCH: 'main',
      GITHUB_SHA: head,
      PACKAGE_DIR: '.',
      ...env,
    });

  test('tags the package in the repo root v<version>', () => {
    const { status, outputs } = pick({ GITHUB_SHA: first });
    assert.equal(status, 0);
    assert.deepEqual(outputs, { name: '@o/tool', version: '1.0.0', tag: 'v1.0.0', release: 'false' });
  });

  test('releases a package in a folder under its name without the scope as the prefix', () => {
    const { status, outputs } = pick({ PACKAGE_DIR: 'packages/viewer' });
    assert.equal(status, 0);
    assert.deepEqual(outputs, { name: '@o/viewer', version: '0.2.0', tag: 'viewer-v0.2.0', release: 'true' });
  });

  test("ignores another package's tag of the same version", () => {
    writePackage(path.join(repo, 'packages/viewer'), '@o/viewer', '1.0.0');
    try {
      assert.equal(pick({ PACKAGE_DIR: 'packages/viewer' }).outputs.release, 'true');
    } finally {
      writePackage(path.join(repo, 'packages/viewer'), '@o/viewer', '0.2.0');
    }
  });

  test('skips a version tagged on another commit, with a warning that names the folder', () => {
    writePackage(path.join(repo, 'packages/viewer'), '@o/viewer', '0.1.0');
    try {
      const { status, stdout, outputs } = pick({ PACKAGE_DIR: 'packages/viewer' });
      assert.equal(status, 0);
      assert.equal(outputs.release, 'false');
      assert.match(
        stdout,
        new RegExp(`^::warning::viewer-v0\\.1\\.0 is already released from ${first.slice(0, 7)}, .* packages/viewer/package\\.json\\.$`, 'm'),
      );
    } finally {
      writePackage(path.join(repo, 'packages/viewer'), '@o/viewer', '0.2.0');
    }
  });

  test('fails on a branch that is not the default one', () => {
    const { status, stdout } = pick({ GITHUB_REF: 'refs/heads/feature', GITHUB_REF_NAME: 'feature' });
    assert.equal(status, 1);
    assert.match(stdout, /^::error::A release comes from main, not from feature$/m);
  });

  for (const dir of ['../repo', 'packages/../..', '/etc', '-x', 'packages/none', '']) {
    test(`fails on package-dir «${dir}»`, () => {
      const { status, stdout, outputs } = pick({ PACKAGE_DIR: dir });
      assert.equal(status, 1);
      assert.match(stdout, /is no folder of the repo with a package\.json/);
      assert.deepEqual(outputs, {});
    });
  }
});

describe('Check the tarball', () => {
  const check = (tarballs: Record<string, { name: string; version: string }>) => {
    const cwd = mkdtempSync(path.join(root, 'publish-'));
    for (const [file, manifest] of Object.entries(tarballs)) {
      const staging = mkdtempSync(path.join(root, 'pack-'));
      writePackage(path.join(staging, 'package'), manifest.name, manifest.version);
      mkdirSync(path.join(cwd, 'package'), { recursive: true });
      execFileSync('tar', ['-czf', path.join(cwd, 'package', file), '-C', staging, 'package']);
    }
    return runStep('Check the tarball', cwd, { NAME: '@o/viewer', VERSION: '0.2.0' });
  };

  test('passes the one tarball of the package being released', () => {
    const { status, outputs } = check({ 'o-viewer-0.2.0.tgz': { name: '@o/viewer', version: '0.2.0' } });
    assert.equal(status, 0);
    assert.deepEqual(outputs, { path: './package/o-viewer-0.2.0.tgz' });
  });

  test('fails on a tarball of another package', () => {
    const { status, stdout } = check({ 'o-tool-0.2.0.tgz': { name: '@o/tool', version: '0.2.0' } });
    assert.equal(status, 1);
    assert.match(stdout, /^::error::The tarball holds @o\/tool 0\.2\.0, not @o\/viewer 0\.2\.0$/m);
  });

  test('fails on two tarballs', () => {
    const manifest = { name: '@o/viewer', version: '0.2.0' };
    const { status, stdout } = check({ 'a.tgz': manifest, 'b.tgz': manifest });
    assert.equal(status, 1);
    assert.match(stdout, /left 2 tarballs in the package's folder, not one/);
  });
});

describe('Tag the release', () => {
  test('creates the Release under the tag the version job picked', () => {
    const { status, calls } = runStep('Tag the release', root, {
      GITHUB_SHA: 'abc123',
      NAME: '@o/viewer',
      TAG: 'viewer-v0.2.0',
      VERSION: '0.2.0',
    });
    assert.equal(status, 0);
    assert.deepEqual(calls, [
      'release create viewer-v0.2.0 --repo o/r --target abc123 --title viewer-v0.2.0 --notes https://www.npmjs.com/package/@o/viewer/v/0.2.0',
    ]);
  });
});
