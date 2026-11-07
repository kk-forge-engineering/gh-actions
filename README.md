# GitHub actions

Reusable GitHub workflows and actions. Pin them to the major tag, such as `@v3`. `v2` keeps Release image's earlier inputs.

## Workflows

- [CI](/.github/workflows/ci.yml) installs a repo's tools from `mise.toml`, runs `mise run setup` and `mise run check:ci`, then [SonarQube scan](/sonarqube-scan) when the repo has a `sonar-project.properties`, even after a red `check:ci`. Such a repo's `check:ci` writes the coverage reports Sonar reads, and its caller passes `SONAR_TOKEN`. A private repo runs on the self-hosted runner unless its caller passes `hosted: true`, a public one on a hosted runner. The workflow reads the visibility from the event's repository, so call it from `push`, `pull_request` or `workflow_dispatch`. The caller:
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

- [Release image](/.github/workflows/release-image.yml) builds a package's images, pushes them to `dr.kk-forge.com` under the package's version, and publishes a GitHub Release `<tag-prefix>v<version>`. The Release body lists `dr.kk-forge.com/<name>:<version>` for each image. When the git tag already exists, the run ends green without a release, and warns when the tag points at another commit. When an image's version tag is already in the registry, the run fails, since the registry never overwrites a tag. A private repo builds on the self-hosted runner unless its caller passes `hosted: true`, a public one on a hosted runner. Each input's meaning is in the workflow's `inputs`. What the inputs leave out:
  - A trial on the server is a dev release, from a caller job that runs on `workflow_dispatch` with `dev: true`.
  - `hosted` is meant for project-orchestration's runner launcher. The self-hosted runners exist only while the launcher runs, so they cannot build it after it fails. A job that breaks out of its container there could also tamper with it. A caller that passes `hosted` to Release image passes it to CI as well. Its CI then runs while the runners are down. A private repo's hosted run builds without a cache and spends the repo's hosted minutes.
  - the secret `DOCKER_REGISTRY_TOKEN`: the token of the registry user named after the repo

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
      secrets: { DOCKER_REGISTRY_TOKEN: "${{ secrets.DOCKER_REGISTRY_TOKEN }}" }
  ```

project-orchestration deploys the references a Release lists ([Release and deploy](https://github.com/kk-forge-engineering/project-orchestration/blob/main/docs/release-and-deploy.md)).

## Actions

- [SonarQube scan](/sonarqube-scan)

## Checks

`mise run check` runs actionlint, which also runs shellcheck over every `run:` script. The CI workflow runs it on every push to this repo.
