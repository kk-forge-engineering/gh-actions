# GitHub actions

Reusable GitHub workflows and actions. Pin them to the major tag, such as `@v4`. `v3` keeps Release image's `latest` tag and digest references, and `v2` its earlier inputs.

## Workflows

- [CI](/.github/workflows/ci.yml) installs a repo's tools from `mise.toml`, runs `mise run setup` and `mise run check:ci`, then [SonarQube scan](/sonarqube-scan) when the repo has a `sonar-project.properties`, even after a red `check:ci`. Such a repo's `check:ci` writes the coverage reports its `sonar-project.properties` names in `*reportPaths` and `*ReportPaths` keys, each a plain repo-relative file path. Its caller passes `SONAR_TOKEN`. The scan runs at the end of the `ci` job, on the reports and files `check:ci` and `setup` left there, so CI and the scan share one runner and pass no artifacts. Only the token check and the scan read the token, but `setup` and `check:ci` run before the scan in the same job and could reach it. That is accepted: each repo's token is its own, with Scan and Browse on that repo's SonarQube project alone. The `sonar` job reports the scan as the `ci / sonar` check. It reads only the `ci` job's outputs, so it runs on a hosted runner, for a private repo too, at about one billed minute a run. Rerunning `sonar` alone repeats its old result, so a scan rerun, say after marking a false positive in SonarQube, reruns every job. The `ci` job caches the Go modules, the Go build cache, golangci-lint's cache and the npm downloads, keyed on every `go.sum` and `package-lock.json`. Only a run on the default branch saves the Go caches, so a PR's copy never pushes the default branch's out of the repo's 10 GB. It sets `GOFLAGS=-count=1`, so every test still runs. The `ci` job stops after 60 minutes, so a run that hangs frees its runner. A private repo's `ci` job runs on the self-hosted runner. A public repo, or a PR whose head is outside the repo, runs on a hosted runner. The workflow reads the visibility from the event's repository, so call it from `push`, `pull_request` or `workflow_dispatch`. The caller runs it on a push to `main` and on a PR's `opened`, `synchronize` and `reopened`, as below, so each push to a PR runs it once, as that PR's SonarQube analysis. A manual run on a branch with an open PR is analysed as that PR too. A PR whose head is outside the repo gets no secrets, so it skips the scan. A repo whose tools build against system libraries names their Ubuntu packages in the `apt-packages` input, separated by spaces or lines, each by its exact Debian name. CI puts them in before the tools, together with `libatomic1`, which Node's binary needs, and `dirmngr`, which the scan needs. It caches apt's indexes and downloads, keyed on the list and renewed each week, and saves them only on the default branch. A run that finds them reaches no apt mirror, and a new package in the list needs no other change. The caller:
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

- [Release extension](/.github/workflows/release-extension.yml) builds a browser extension's production zip and publishes it as a GitHub Release `<tag-prefix>v<version>`, `web-v<version>` by default, for an owner to upload to the Chrome Web Store. A push to the default branch whose version has no tag yet runs the caller's `mise run setup`, then its `zip-task`, and releases the one file that `zip` names. The Release's notes list the pull requests since the last tag of the same prefix. When the tag already exists, the run ends green without a release, and warns when the tag points at another commit. The zip's `manifest.json` must give the version that `version-task` prints, or the run fails. The build runs on the self-hosted runner for a private repo and on a hosted one for a public repo; the release job always runs on a hosted runner. Each input's meaning is in the workflow's `inputs`. What the caller's tasks do:
  - `version-task` prints the extension's version, X.Y.Z, and nothing else, such as `node -p "require('./package.json').version"` in the extension's folder.
  - `zip-task` builds the production zip, from dependencies `setup` installed, and publishes nothing.

  The caller runs it as a job of its CI, after `ci`, on the default branch:
  ```yaml
    release-extension:
      needs: ci
      if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
      uses: kk-forge-engineering/gh-actions/.github/workflows/release-extension.yml@v4
      permissions: { contents: write }
      with:
        version-task: web:version
        zip-task: web:zip
        zip: apps/web/.output/*-chrome.zip
  ```

project-orchestration deploys the references a Release lists ([Release and deploy](https://github.com/kk-forge-engineering/project-orchestration/blob/main/docs/release-and-deploy.md)).

## Actions

- [SonarQube scan](/sonarqube-scan)

## Checks

`mise run check` runs the linters and tests in [mise.toml](/mise.toml). The tests run [gate-report.ts](/sonarqube-scan/gate-report.ts) against a fake SonarQube, the apt-packages step of [ci.yml](/.github/workflows/ci.yml) against a fake sudo, and the steps of [release-extension.yml](/.github/workflows/release-extension.yml) against a fake mise and a fake gh. The CI workflow runs `mise run check:ci` on every push to a PR of this repo and to `main`. `mise run setup` installs `tsc` and the Node types.
