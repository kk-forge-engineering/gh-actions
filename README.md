# GitHub actions

Reusable GitHub workflows and actions. Pin them to the major tag, such as `@v1`. The tag moves to each compatible release.

## Workflows

- [CI](/.github/workflows/ci.yml) installs a repo's tools from `mise.toml`, runs `mise run setup` and `mise run check:ci`, then [SonarQube scan](/sonarqube-scan) when the repo has a `sonar-project.properties`. A private repo runs on the self-hosted runner, a public one on a hosted runner. The caller:
  ```yaml
  name: CI
  on:
    push:
      branches: ["**"]
  jobs:
    ci:
      uses: kk-forge-engineering/gh-actions/.github/workflows/ci.yml@v1
      permissions: { contents: read, pull-requests: read }
      secrets: { SONAR_TOKEN: "${{ secrets.SONAR_TOKEN }}" }
  ```
- [Release image](/.github/workflows/release-image.yml) builds a repo's image on a self-hosted runner with its own `buildkitd`, pushes it under the next SemVer and records the digest in a GitHub Release. [Deploy image](/.github/workflows/deploy-image.yml) sends a release's digest over SSH to a forced command on the server, which rolls one Swarm service onto it. The deploy caller passes `secrets: inherit`, so the environment's `DEPLOY_SSH_KEY` reaches the job. Both need the server side they were built for: the runner, the registry and the forced command.

## Actions

- [SonarQube scan](/sonarqube-scan)

## Checks

`mise run check` runs actionlint, which also runs shellcheck over every `run:` script. This repo's pushes run the CI workflow on itself.
