// Runs the apt steps of ci.yml as written, with a fake sudo that records its calls. Run: `mise run test`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { stepScript } from './step.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'apt-packages-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const listScript = path.join(dir, 'list.sh');
writeFileSync(listScript, stepScript('ci.yml', 'List the apt packages'));
const installScript = path.join(dir, 'install.sh');
writeFileSync(installScript, stepScript('ci.yml', 'Install the apt packages'));
const calls = path.join(dir, 'sudo-calls');
const output = path.join(dir, 'github-output');
const aptDir = path.join(dir, 'apt');
// The fake sudo writes each call on its own line, its arguments separated by spaces.
writeFileSync(path.join(dir, 'sudo'), `#!/bin/sh\necho "$*" >> "${calls}"\n`);
chmodSync(path.join(dir, 'sudo'), 0o755);
// Like apt-cache, the fake lists a virtual name such as libz-dev only under --all-names.
const KNOWN = ['libatomic1', 'dirmngr', 'libwebkit2gtk-4.1-dev', 'libxcb1-dev', 'libwayland-dev', 'g++', 'libstdc++6', 'lib.x', '0ad'];
const PROVIDED = ['libz-dev'];
writeFileSync(
  path.join(dir, 'apt-cache'),
  `#!/bin/sh\nprintf '%s\\n' ${KNOWN.join(' ')}\ncase " $* " in *" --all-names "*) printf '%s\\n' ${PROVIDED.join(' ')} ;; esac\nexit 0\n`,
);
chmodSync(path.join(dir, 'apt-cache'), 0o755);

/** Runs a step as GitHub runs a bash `run:`, and returns its exit status, output, sudo calls and GITHUB_OUTPUT. */
const runStep = (script: string, env: Record<string, string>) => {
  rmSync(calls, { force: true });
  rmSync(output, { force: true });
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, GITHUB_OUTPUT: output, ...env },
    encoding: 'utf8',
  });
  const read = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  const sudo = read(calls).trimEnd();
  return { status: result.status, stdout: result.stdout, sudo: sudo === '' ? [] : sudo.split('\n'), output: read(output) };
};

// The workflow puts the packages every Linux job needs ahead of the caller's list.
const listStep = (callerPackages: string) => runStep(listScript, { APT_PACKAGES: `libatomic1 dirmngr ${callerPackages}` });
const installStep = (callerPackages: string, cacheHit = '') =>
  runStep(installScript, { APT_PACKAGES: `libatomic1 dirmngr ${callerPackages}`, APT_DIR: aptDir, CACHE_HIT: cacheHit });

const key = (callerPackages: string): string => {
  const { status, output } = listStep(callerPackages);
  assert.equal(status, 0);
  const found = /^key=(apt-\d+-week\d+)$/m.exec(output);
  assert.ok(found, `no cache key in ${JSON.stringify(output)}`);
  return found[1];
};

const APT = `-o Dir::State::Lists=${aptDir}/lists -o Dir::Cache::Archives=${aptDir}/archives -o APT::Keep-Downloaded-Packages=true -o APT::Sandbox::User=root`;
const UPDATE = `apt-get ${APT} update -qq`;
const INSTALL = `--preserve-env=DEBIAN_FRONTEND apt-get ${APT} install -y -qq --no-install-recommends -- libatomic1 dirmngr`;

test('keys the cache on the set of packages, whatever their order and spacing', () => {
  assert.equal(key('libxcb1-dev libwayland-dev'), key('libwayland-dev\n  libxcb1-dev\n'));
  assert.notEqual(key('libxcb1-dev libwayland-dev'), key('libxcb1-dev'));
});

test('updates and installs every package on a cache miss', () => {
  const { status, sudo } = installStep('libwebkit2gtk-4.1-dev libxcb1-dev\nlibwayland-dev\n');
  assert.equal(status, 0);
  assert.deepEqual(sudo, [UPDATE, `${INSTALL} libwebkit2gtk-4.1-dev libxcb1-dev libwayland-dev`]);
  assert.ok(existsSync(path.join(aptDir, 'lists', 'partial')) && existsSync(path.join(aptDir, 'archives', 'partial')));
});

test('installs from the restored folder without an update on a cache hit', () => {
  const { status, sudo } = installStep('libxcb1-dev', 'true');
  assert.equal(status, 0);
  assert.deepEqual(sudo, [`${INSTALL} libxcb1-dev`]);
});

test('installs only libatomic1 and dirmngr when the caller names no package', () => {
  const { status, sudo } = installStep('');
  assert.equal(status, 0);
  assert.equal(sudo.at(-1), INSTALL);
});

test('accepts the characters Debian allows in a name', () => {
  assert.equal(listStep('g++ libstdc++6 lib.x 0ad').status, 0);
  const { status, sudo } = installStep('g++ libstdc++6 lib.x 0ad');
  assert.equal(status, 0);
  assert.equal(sudo.at(-1), `${INSTALL} g++ libstdc++6 lib.x 0ad`);
});

test('installs a name a package provides', () => {
  const { status, sudo } = installStep('libz-dev');
  assert.equal(status, 0);
  assert.equal(sudo.at(-1), `${INSTALL} libz-dev`);
});

// apt-get would read the dot as a regex and install every package it matches.
test('fails before installing a name apt knows no package by exactly', () => {
  const { status, stdout, sudo } = installStep('libxcb1-dev libyaml.dev');
  assert.equal(status, 1);
  assert.deepEqual(sudo, [UPDATE], 'apt installed although a name matches no package exactly');
  assert.match(stdout, /^::error title=apt-packages::apt knows no package named exactly 'libyaml\.dev'\.$/m);
});

// apt reads the first six as a removal, a version, an architecture, a release, a local file and an option;
// Debian names have no capitals and at least two characters.
for (const bad of ['pkg-', 'pkg=1.0', 'pkg:amd64', 'pkg/noble', './x.deb', '-o', 'Libfoo', 'x']) {
  test(`fails before a cache key on '${bad}'`, () => {
    const { status, stdout, output } = listStep(`libxcb1-dev ${bad} libwayland-dev`);
    assert.equal(status, 1);
    assert.equal(output, '', 'the step gave a cache key although a name is invalid');
    assert.match(stdout, new RegExp(`^::error title=apt-packages::'${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' is not a Debian package name`, 'm'));
  });
}
