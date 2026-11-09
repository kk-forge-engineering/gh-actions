# SonarQube scan

Runs SonarQube analysis, then fails the job when the Quality Gate is red. On a red gate, the action lists why in the step's log and the job summary: each failed condition, then every new issue and security hotspot to review as `path:line rule — message`. The failed conditions and the first findings also become annotations, up to GitHub's 10 a step, each finding at its file and line. To list the findings, `sonar-token` needs Browse on the project.

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

- The coverage reports that the file names, in the workspace before this action runs.
- A checkout with `fetch-depth: 0`. SonarQube reads the history to tell new code from old.
- `pull-requests: read` on the job. On a push, the action looks up the open pull request for the commit.

## Usage

```yml
- name: SonarQube scan
  uses: kk-forge-engineering/gh-actions/sonarqube-scan@v4
  with:
    sonar-token: ${{ secrets.SONAR_TOKEN }}
    sonar-host-url: ${{ secrets.SONAR_HOST_URL }}
```

## Full example

The [CI workflow](/.github/workflows/ci.yml) runs this action in a job of its own, after the repo's `check:ci` in another job. It passes the repo's `SONAR_TOKEN`. Its caller is in the [root README](/README.md#workflows).
