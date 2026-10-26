# GitHub actions

Reusable GitHub actions and workflows. Pin them to the major tag, such as `@v1`. The tag moves to each compatible release.

## Actions

- [SonarQube scan](/sonarqube-scan)
- [NPM prepare](/npm-prepare)
- [Bun prepare](/bun-prepare)

## Workflows

- [Sonar](/.github/workflows/sonar.yml) installs a repo's tools from `mise.toml`, runs its tests with coverage and runs [SonarQube scan](/sonarqube-scan). A caller on the kk-forge runner:
  ```yaml
  name: Sonar
  on: [push]
  jobs:
    sonar:
      uses: kk-forge-engineering/github-actions/.github/workflows/sonar.yml@v1
      permissions: { contents: read, pull-requests: read }
      with:
        runs-on: '["self-hosted","swarm"]'
        test-command: mise run test:ci
      secrets: { SONAR_TOKEN: "${{ secrets.SONAR_TOKEN }}" }
  ```
  A public repo passes a hosted runner, such as `'"ubuntu-24.04"'`. The kk-forge runner takes jobs from the org's private repos only.
- [Release image](/.github/workflows/release-image.yml) and [Deploy image](/.github/workflows/deploy-image.yml) release a versioned image to `dr.kk-forge.com` and roll it onto a Swarm service on kk-forge. They run on the kk-forge runner. Their setup and callers are in the project-orchestration README, under "How to release and deploy an image from CI".
