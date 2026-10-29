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

- [Release image](/.github/workflows/release-image.yml) builds a repo's images, pushes them to `dr.kk-forge.com` under the next SemVer, and publishes one GitHub Release whose body lists `dr.kk-forge.com/<name>@sha256:<digest>` for each image. `images` holds one `<name> <context> <Dockerfile>` per line. The older `image`, `context` and `dockerfile` inputs build one image. A private repo builds on the self-hosted runner with its own `buildkitd`, a public one on a hosted runner. A public repo never runs on the self-hosted runner, because a pull request from a fork would run someone else's code on the kk-forge server. A repo calls it as a second job of its CI caller, after `ci`, on its default branch only. The caller passes the repo's `DOCKER_REGISTRY_PASSWORD`:
  ```yaml
    release:
      needs: ci
      if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
      uses: kk-forge-engineering/gh-actions/.github/workflows/release-image.yml@v2
      permissions: { contents: write }
      with:
        images: |
          my-service . Dockerfile
      secrets: { DOCKER_REGISTRY_PASSWORD: "${{ secrets.DOCKER_REGISTRY_PASSWORD }}" }
  ```

No workflow here deploys. project-orchestration deploys the references a Release lists, with an owner's Touch ID ([Release and deploy](https://github.com/kk-forge-engineering/project-orchestration/blob/main/docs/release-and-deploy.md)).

## Actions

- [SonarQube scan](/sonarqube-scan)

## Checks

`mise run check` runs actionlint, which also runs shellcheck over every `run:` script. The CI workflow runs it on every push to this repo.
