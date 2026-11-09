# GitHub actions

Reusable GitHub workflows and actions. Pin them to the major tag, such as `@v4`. `v3` keeps Release image's `latest` tag and digest references, and `v2` its earlier inputs.

## Workflows

- [CI](/.github/workflows/ci.yml) installs a repo's tools from `mise.toml`, runs `mise run setup` and `mise run check:ci`, then [SonarQube scan](/sonarqube-scan) when the repo has a `sonar-project.properties`, even after a red `check:ci`. Such a repo's `check:ci` writes the coverage reports its `sonar-project.properties` names in `*reportPaths` and `*ReportPaths` keys, each a plain repo-relative file path. Its caller passes `SONAR_TOKEN`. The scan runs in a job of its own that runs none of the repo's tools and alone holds the token. The reports, and the type files `setup` leaves for SonarJS, reach it as artifacts. A private repo runs on the self-hosted runner. A public repo, or a PR whose head is outside the repo, runs on a hosted runner. The workflow reads the visibility from the event's repository, so call it from `push`, `pull_request` or `workflow_dispatch`. SonarQube analyses a push to a branch with an open PR as that PR. For a PR opened after its last push, the caller also triggers on `pull_request` `opened` and `reopened`, as below. A PR whose head is outside the repo gets no secrets, so it skips the scan. The caller:
  ```yaml
  name: CI
  on:
    push:
      branches: ["**"]
    pull_request:
      types: [opened, reopened]
  jobs:
    ci:
      uses: kk-forge-engineering/gh-actions/.github/workflows/ci.yml@v4
      permissions: { contents: read, pull-requests: read }
      secrets: { SONAR_TOKEN: "${{ secrets.SONAR_TOKEN }}" }
  ```

- [Release image](/.github/workflows/release-image.yml) builds a package's images, pushes them to `dr.kk-forge.com` under the package's version, and publishes a GitHub Release `<tag-prefix>v<version>`. The Release body lists `dr.kk-forge.com/<name>:<version>` for each image. When the git tag already exists, the run ends green without a release, and warns when the tag points at another commit. When an image's version tag is already in the registry, the run fails, so an image never changes under its version. A private repo builds on the self-hosted runner, a public one on a hosted runner. Each input's meaning is in the workflow's `inputs`. What the inputs leave out:
  - A trial on the server is a dev release, from a caller job that runs on `workflow_dispatch` with `dev: true`.
  - The secret `DOCKER_REGISTRY_TOKEN` is the token of the registry user named after the repo.

  The caller runs it as a second job of its CI, after `ci`, on the default branch:
  ```yaml
    release:
      needs: ci
      if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
      uses: kk-forge-engineering/gh-actions/.github/workflows/release-image.yml@v4
      permissions: { contents: write }
      with:
        version-task: version
        images: |
          my-service . Dockerfile
      secrets: { DOCKER_REGISTRY_TOKEN: "${{ secrets.DOCKER_REGISTRY_TOKEN }}" }
  ```

project-orchestration deploys the references a Release lists ([Release and deploy](https://github.com/kk-forge-engineering/project-orchestration/blob/main/docs/release-and-deploy.md)).

## Actions

- [SonarQube scan](/sonarqube-scan)

## Checks

`mise run check` runs actionlint, which also runs shellcheck over every `run:` script, and the tests of [gate-report.js](/sonarqube-scan/gate-report.js) against a fake SonarQube. The CI workflow runs it on every push to this repo.
