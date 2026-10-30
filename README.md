# GitHub actions

Reusable GitHub workflows and actions. Pin them to the major tag, such as `@v3`. The tag moves to each compatible release. `v3` changed Release image's inputs, and `v2` keeps the earlier ones.

## Workflows

- [CI](/.github/workflows/ci.yml) installs a repo's tools from `mise.toml`, runs `mise run setup` and `mise run check:ci`, then [SonarQube scan](/sonarqube-scan) when the repo has a `sonar-project.properties`, even after a red `check:ci`. Such a repo's `check:ci` writes the coverage reports Sonar reads, and its caller passes `SONAR_TOKEN`. A private repo runs on the self-hosted runner, a public one on a hosted runner. The workflow reads the visibility from the event's repository, so call it from `push`, `pull_request` or `workflow_dispatch`. The caller:
  ```yaml
  name: CI
  on:
    push:
      branches: ["**"]
  jobs:
    ci:
      uses: kk-forge-engineering/gh-actions/.github/workflows/ci.yml@v3
      permissions: { contents: read, pull-requests: read }
      secrets: { SONAR_TOKEN: "${{ secrets.SONAR_TOKEN }}" }
  ```

- [Release image](/.github/workflows/release-image.yml) builds a package's images, pushes them to `dr.kk-forge.com` under the package's version, and publishes a GitHub Release `<tag-prefix>v<version>`. The Release body lists `dr.kk-forge.com/<name>@sha256:<digest>` for each image. When that tag already exists, the run ends green without a release, and warns when the tag points at another commit. A private repo builds on the self-hosted runner, a public one on a hosted runner. Its inputs:
  - `images`, required: one `<name> <context> <Dockerfile>` per line, `<name>` being the image's repository in `dr.kk-forge.com`
  - `version-task`, required: the caller's mise task that prints the version, `X.Y.Z`
  - `tag-prefix`: goes before `v<version>`, such as `backend-` in a repo of several packages
  - `dev`: releases `<version>-dev.<run number>` from any branch, where a stable release comes only from the default branch
  - the secret `DOCKER_REGISTRY_PASSWORD`: the password of the registry user named after the repo

  The caller runs it as a second job of its CI, after `ci`, on the default branch:
  ```yaml
    release:
      needs: ci
      if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
      uses: kk-forge-engineering/gh-actions/.github/workflows/release-image.yml@v3
      permissions: { contents: write }
      with:
        version-task: version
        images: |
          my-service . Dockerfile
      secrets: { DOCKER_REGISTRY_PASSWORD: "${{ secrets.DOCKER_REGISTRY_PASSWORD }}" }
  ```

project-orchestration deploys the references a Release lists ([Release and deploy](https://github.com/kk-forge-engineering/project-orchestration/blob/main/docs/release-and-deploy.md)).

## Actions

- [SonarQube scan](/sonarqube-scan)

## Checks

`mise run check` runs actionlint, which also runs shellcheck over every `run:` script. The CI workflow runs it on every push to this repo.
