# SonarQube scan

Runs SonarQube analysis, then fails the job when the Quality Gate is red.

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
- A checkout with `fetch-depth: 0`. SonarQube reads the history to tell new code from old.
- `pull-requests: read` on the job. The action looks up the open pull request for the commit.

## Usage

```yml
- name: SonarQube scan
  uses: kk-forge-engineering/gh-actions/sonarqube-scan@v2
  with:
    sonar-token: ${{ secrets.SONAR_TOKEN }}
    sonar-host-url: ${{ secrets.SONAR_HOST_URL }}
```

## Full example

The [CI workflow](/.github/workflows/ci.yml) runs this action after the repo's `check:ci`. Its caller is in the [root README](/README.md#workflows).
