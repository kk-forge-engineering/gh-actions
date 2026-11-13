# GitHub actions

Reusable GitHub workflows and actions. Pin them to the major tag, such as `@v4`. `v3` keeps Release image's `latest` tag and digest references, and `v2` its earlier inputs.

## Workflows

- [CI](/.github/workflows/ci.yml) installs a repo's tools from `mise.toml`, runs `mise run setup` and `mise run check:ci`, then [SonarQube scan](/sonarqube-scan) when the repo has a `sonar-project.properties`, even after a red `check:ci`. Such a repo's `check:ci` writes the coverage reports its `sonar-project.properties` names in `*reportPaths` and `*ReportPaths` keys, each a plain repo-relative file path. Its caller passes `SONAR_TOKEN`. The scan runs in a job of its own that runs none of the repo's tools and alone holds the token. The reports, and the type files `setup` leaves for SonarJS, reach it as artifacts. A private repo runs on the self-hosted runner. A public repo, or a PR whose head is outside the repo, runs on a hosted runner. The workflow reads the visibility from the event's repository, so call it from `push`, `pull_request` or `workflow_dispatch`. The caller runs it on a push to `main` and on a PR's `opened`, `synchronize` and `reopened`, as below, so each push to a PR runs it once, as that PR's SonarQube analysis. A manual run on a branch with an open PR is analysed as that PR too. A PR whose head is outside the repo gets no secrets, so it skips the scan. The caller:
  ```yaml
  name: CI
  on:
    push:
      branches: [main]
    pull_request:
      types: [opened, synchronize, reopened]
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

- [Release npm](/.github/workflows/release-npm.yml) publishes the package in the repo root to npm under the version in its `package.json`, X.Y.Z, then publishes a GitHub Release `v<version>` that links to it. A push to the default branch whose version has no tag yet runs the repo's `mise run setup` and `mise run check`, then its `mise run pack`, and publishes the tarball. When the tag already exists, the run ends green without a release, and warns when the tag points at another commit. When the `tag` job fails after the publish, rerun that run's failed jobs, so the tag lands on the published commit. Until the tag exists, a later run with the same version fails at the publish. The repo's `pack` task installs the dependencies without their scripts, builds, and leaves one tarball from `npm pack` in the repo root. npm takes the package through Trusted Publishing, with no token, and adds provenance for a public repo. Every job runs on a hosted runner: npm accepts the OIDC token only from one. What the package needs:
  - On npmjs.com, the package's Trusted Publisher for GitHub Actions names the caller's repo, the workflow filename `release.yml`, the environment `production`, and allows `npm publish`. npm checks the calling workflow, not this one.
  - The caller's repo has the environment `production`, whose required reviewers approve each publish and whose deployment branches are the default branch alone. npm checks no branch, so a `release.yml` on another branch could otherwise reach it.
  - The package's publishing access on npmjs.com requires two-factor authentication and disallows tokens.
  - `repository.url` in `package.json` names the caller's repo.

  The caller, `.github/workflows/release.yml`:
  ```yaml
  name: Release
  on:
    push:
      branches: [main]
  jobs:
    release:
      uses: kk-forge-engineering/gh-actions/.github/workflows/release-npm.yml@v4
      permissions: { contents: write, id-token: write }
  ```

project-orchestration deploys the references a Release lists ([Release and deploy](https://github.com/kk-forge-engineering/project-orchestration/blob/main/docs/release-and-deploy.md)).

## Actions

- [SonarQube scan](/sonarqube-scan)

## Checks

`mise run check` runs the linters and tests in [mise.toml](/mise.toml). The tests run [gate-report.ts](/sonarqube-scan/gate-report.ts) against a fake SonarQube. The CI workflow runs `mise run check:ci` on every push to a PR of this repo and to `main`. `mise run setup` installs `tsc` and the Node types.
