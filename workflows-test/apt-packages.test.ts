// Runs the apt-packages step of ci.yml as written, with a fake sudo that records its calls. Run: `mise run test`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { stepScript } from './step.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'apt-packages-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const script = path.join(dir, 'step.sh');
writeFileSync(script, stepScript('ci.yml', 'Install the apt packages the caller names'));
const calls = path.join(dir, 'sudo-calls');
// The fake sudo writes each call on its own line, its arguments separated by spaces.
writeFileSync(path.join(dir, 'sudo'), `#!/bin/sh\necho "$*" >> "${calls}"\n`);
chmodSync(path.join(dir, 'sudo'), 0o755);
// Like apt-cache, the fake lists a virtual name such as libz-dev only under --all-names.
const KNOWN = ['libwebkit2gtk-4.1-dev', 'libxcb1-dev', 'libwayland-dev', 'libyaml-dev', 'g++', 'libstdc++6', 'lib.x', '0ad'];
const PROVIDED = ['libz-dev'];
writeFileSync(
  path.join(dir, 'apt-cache'),
  `#!/bin/sh\nprintf '%s\\n' ${KNOWN.join(' ')}\n[ "$1" = --all-names ] && printf '%s\\n' ${PROVIDED.join(' ')}\nexit 0\n`,
);
chmodSync(path.join(dir, 'apt-cache'), 0o755);
// Like dpkg-query -W, the fake prints the state of each name it knows and fails on a name it does not know.
writeFileSync(
  path.join(dir, 'dpkg-query'),
  `#!/bin/bash\nshift 3\nstatus=0\nfor name; do\n  case $name in\n    libxcb1-dev|libwayland-dev) echo installed ;;\n    libyaml-dev) echo config-files ;;\n    *) status=1 ;;\n  esac\ndone\nexit $status\n`,
);
chmodSync(path.join(dir, 'dpkg-query'), 0o755);

/** Runs the step as GitHub runs a bash `run:`, and returns its exit status, output and sudo calls. */
const runStep = (packages: string) => {
  rmSync(calls, { force: true });
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, APT_PACKAGES: packages },
    encoding: 'utf8',
  });
  let sudo: string[] = [];
  try {
    sudo = readFileSync(calls, 'utf8').trimEnd().split('\n');
  } catch {
    // No file: sudo never ran.
  }
  return { status: result.status, stdout: result.stdout, sudo };
};

const INSTALL = 'apt-get install -y -qq --no-install-recommends --';

test('installs every package of a list on one line', () => {
  const { status, sudo } = runStep('libwebkit2gtk-4.1-dev libxcb1-dev');
  assert.equal(status, 0);
  assert.deepEqual(sudo, [
    'apt-get update -qq',
    `--preserve-env=DEBIAN_FRONTEND ${INSTALL} libwebkit2gtk-4.1-dev libxcb1-dev`,
  ]);
});

test('installs every package of a list over several lines', () => {
  const { status, sudo } = runStep('libwebkit2gtk-4.1-dev libxcb1-dev\nlibwayland-dev\n');
  assert.equal(status, 0);
  assert.equal(sudo.at(-1), `--preserve-env=DEBIAN_FRONTEND ${INSTALL} libwebkit2gtk-4.1-dev libxcb1-dev libwayland-dev`);
});

test('accepts the characters Debian allows in a name', () => {
  const { status, sudo } = runStep('g++ libstdc++6 lib.x 0ad');
  assert.equal(status, 0);
  assert.equal(sudo.at(-1), `--preserve-env=DEBIAN_FRONTEND ${INSTALL} g++ libstdc++6 lib.x 0ad`);
});

test('calls no apt when every package is installed', () => {
  const { status, stdout, sudo } = runStep('libxcb1-dev libwayland-dev');
  assert.equal(status, 0);
  assert.deepEqual(sudo, []);
  assert.match(stdout, /^The runner already has every package\.$/m);
});

test('installs a package left with only its config files', () => {
  const { status, sudo } = runStep('libxcb1-dev libyaml-dev');
  assert.equal(status, 0);
  assert.equal(sudo.at(-1), `--preserve-env=DEBIAN_FRONTEND ${INSTALL} libxcb1-dev libyaml-dev`);
});

test('calls no apt for a list of only spaces', () => {
  const { status, sudo } = runStep('  \n ');
  assert.equal(status, 0);
  assert.deepEqual(sudo, []);
});

test('installs a name a package provides', () => {
  const { status, sudo } = runStep('libz-dev');
  assert.equal(status, 0);
  assert.equal(sudo.at(-1), `--preserve-env=DEBIAN_FRONTEND ${INSTALL} libz-dev`);
});

// apt-get would read the dot as a regex and install every package it matches.
test('fails before installing a name apt knows no package by exactly', () => {
  const { status, stdout, sudo } = runStep('libxcb1-dev libyaml.dev');
  assert.equal(status, 1);
  assert.deepEqual(sudo, ['apt-get update -qq'], 'apt installed although a name matches no package exactly');
  assert.match(stdout, /^::error title=apt-packages::apt knows no package named exactly 'libyaml\.dev'\.$/m);
});

// apt reads the first six as a removal, a version, an architecture, a release, a local file and an option;
// Debian names have no capitals and at least two characters.
for (const bad of ['pkg-', 'pkg=1.0', 'pkg:amd64', 'pkg/noble', './x.deb', '-o', 'Libfoo', 'x']) {
  test(`fails before apt on '${bad}'`, () => {
    const { status, stdout, sudo } = runStep(`libxcb1-dev ${bad} libwayland-dev`);
    assert.equal(status, 1);
    assert.deepEqual(sudo, [], 'apt ran although a name is invalid');
    assert.match(stdout, new RegExp(`^::error title=apt-packages::'${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' is not a Debian package name`, 'm'));
  });
}
