# GitHub actions

Reusable GitHub workflows and actions. Pin them to the major tag, such as `@v2`. The tag moves to each compatible release.

## Workflows

- [CI](/.github/workflows/ci.yml) installs a repo's tools from `mise.toml`, runs `mise run setup` and `mise run check:ci`, then [SonarQube scan](/sonarqube-scan) when the repo has a `sonar-project.properties`, even after a red `check:ci`. Such a repo's `check:ci` writes the coverage reports Sonar reads, and its caller passes `SONAR_TOKEN`. A private repo runs on the self-hosted runner, a public one on a hosted runner. The workflow reads the visibility from the event's repository, so call it from `push`, `pull_request` or `workflow_dispatch`. The caller:
  ```yaml
  name: CI
  on:
    push:
      branches: ["**"]
  jobs:
    ci:
      uses: kk-forge-engineering/gh-actions/.github/workflows/ci.yml@v2
      permissions: { contents: read, pull-requests: read }
      secrets: { SONAR_TOKEN: "${{ secrets.SONAR_TOKEN }}" }
  ```
- [Release image](/.github/workflows/release-image.yml) builds a repo's image on the self-hosted runner with its own `buildkitd`, pushes it under the next SemVer and records the digest in a GitHub Release.
- [Deploy image](/.github/workflows/deploy-image.yml) sends a release's digest over SSH to a forced command on the server, which rolls one Swarm service onto it. The caller passes `secrets: inherit`, so the environment's `DEPLOY_SSH_KEY` reaches the job.

Release image and Deploy image work only with the kk-forge server: its runner, its registry and its forced command.

## Actions

- [SonarQube scan](/sonarqube-scan)

## Checks

`mise run check` runs actionlint, which also runs shellcheck over every `run:` script. The CI workflow runs it on every push to this repo.
