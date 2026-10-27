# Overview

Runs SonarQube code analysis.

## Requirements

- `sonar-project.properties` at the repo root. The action adds the branch or pull request and the commit, so the file holds only what belongs to the repo:

```properties
sonar.projectKey=ProjectName

sonar.javascript.lcov.reportPaths=coverage/lcov.info
sonar.testExecutionReportPaths=coverage/test-report.xml

sonar.sources=packages/backend/src,packages/shared/src,packages/web/src
# Test files are indexed as tests, not as sources. SonarQube drops a test execution report for files it did
# not index as tests.
sonar.exclusions=**/*.test.*,**/*.spec.*
sonar.tests=packages/backend/src,packages/shared/src,packages/web/src
sonar.test.inclusions=**/*.test.*,**/*.spec.*

sonar.coverage.exclusions=packages/backend/src/migrations/*,packages/backend/src/dbUtils.ts
```

- The coverage reports the file names, written before the scan

## Usage

```yml
- name: SonarQube scan
  uses: kk-forge-engineering/gh-actions/sonarqube-scan@v1
  with:
    sonar-token: ${{ secrets.SONAR_TOKEN }}
    sonar-host-url: ${{ secrets.SONAR_HOST_URL }}
```

## Full example

```yml
name: CI
on: [push]
jobs:
  install:
    runs-on: ubuntu-24.04
    steps:
      - name: Checkout
        uses: actions/checkout@v7

      - name: Prepare NPM
        uses: kk-forge-engineering/gh-actions/npm-prepare@v1

  test:
    runs-on: ubuntu-24.04
    needs: install
    steps:
      - name: Checkout
        uses: actions/checkout@v7

      - name: Prepare NPM
        uses: kk-forge-engineering/gh-actions/npm-prepare@v1

      - name: Initialize coverage cache
        uses: actions/cache@v6
        with:
          path: ./coverage
          key: ${{ runner.os }}-coverage-${{ github.sha }}

      - name: Test
        run: npm run test

  analyze:
    runs-on: ubuntu-24.04
    needs: test
    steps:
      - name: Checkout
        uses: actions/checkout@v7

      - name: Restore coverage cache
        uses: actions/cache@v6
        with:
          path: ./coverage
          key: ${{ runner.os }}-coverage-${{ github.sha }}

      - name: SonarQube scan
        uses: kk-forge-engineering/gh-actions/sonarqube-scan@v1
        with:
          sonar-token: ${{ secrets.SONAR_TOKEN }}
          sonar-host-url: ${{ secrets.SONAR_HOST_URL }}
```
