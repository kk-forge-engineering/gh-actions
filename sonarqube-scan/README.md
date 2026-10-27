# Overview

Runs SonarQube code analysis.

## Requirements

- `sonar-project.properties` at the repo root. The action adds the branch or pull request and the commit, so the file holds only what belongs to the repo:

```properties
sonar.projectKey=ProjectName

sonar.javascript.lcov.reportPaths=coverage/lcov.info
sonar.testExecutionReportPaths=coverage/test-report.xml

sonar.sources=packages/backend/src,packages/shared/src,packages/web/src
# SonarQube reads a test execution report only for files it indexed as tests.
sonar.exclusions=**/*.test.*,**/*.spec.*
sonar.tests=packages/backend/src,packages/shared/src,packages/web/src
sonar.test.inclusions=**/*.test.*,**/*.spec.*

sonar.coverage.exclusions=packages/backend/src/migrations/*,packages/backend/src/dbUtils.ts
```

- The coverage reports that the file names. The job writes them before this action runs.

## Usage

```yml
- name: SonarQube scan
  uses: kk-forge-engineering/gh-actions/sonarqube-scan@v1
  with:
    sonar-token: ${{ secrets.SONAR_TOKEN }}
    sonar-host-url: ${{ secrets.SONAR_HOST_URL }}
```

## Full example

The [CI workflow](/.github/workflows/ci.yml) runs a repo's checks with coverage and then this action in one job. Its caller is in the [root README](/README.md#workflows).
