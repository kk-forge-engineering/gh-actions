# GitHub actions

Reusable GitHub actions and workflows. Pin a caller to the commit of a release tag, with the tag in a comment. The major tag, such as `v1`, moves to each compatible release.

## Actions

- [SonarQube scan](/sonarqube-scan)
- [NPM prepare](/npm-prepare)
- [Bun prepare](/bun-prepare)

## Workflows

- [Sonar](/.github/workflows/sonar.yml) installs a repo's tools from `mise.toml`, runs its tests with coverage and runs [SonarQube scan](/sonarqube-scan). A caller on a self-hosted runner:
  ```yaml
  name: Sonar
  on:
    push:
      branches: ["**"]
  jobs:
    sonar:
      uses: kk-forge-engineering/gh-actions/.github/workflows/sonar.yml@<commit> # v1
      permissions: { contents: read, pull-requests: read }
      with:
        runs-on: '["self-hosted","swarm"]'
        test-command: mise run test:ci
      secrets: { SONAR_TOKEN: "${{ secrets.SONAR_TOKEN }}" }
  ```
  A public repo passes a hosted runner, such as `'"ubuntu-24.04"'`.
- [Release image](/.github/workflows/release-image.yml) builds a repo's image on a self-hosted runner with its own `buildkitd`, pushes it under the next SemVer and records the digest in a GitHub Release. [Deploy image](/.github/workflows/deploy-image.yml) sends a release's digest over SSH to a forced command on the server, which rolls one Swarm service onto it. Both need the server side they were built for: the runner, the registry and the forced command.
