# Overview

Installs Bun, restores the Bun install cache, installs dependencies using `bun install`, and saves the updated cache. Caching accelerates `bun install` by reusing previously downloaded packages when the action is run across workflows.

## Usage

```yml
- name: Prepare Bun
  uses: kk-forge-engineering/gh-actions/bun-prepare@v1
  with:
    bun-version: "1" # Optional, default is 1
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

      - name: Prepare Bun
        uses: kk-forge-engineering/gh-actions/bun-prepare@v1

  lint:
    runs-on: ubuntu-24.04
    needs: install
    steps:
      - name: Checkout
        uses: actions/checkout@v7

      - name: Prepare Bun
        uses: kk-forge-engineering/gh-actions/bun-prepare@v1

      - name: Lint
        run: bun run lint

  test:
    runs-on: ubuntu-24.04
    needs: install
    steps:
      - name: Checkout
        uses: actions/checkout@v7

      - name: Prepare Bun
        uses: kk-forge-engineering/gh-actions/bun-prepare@v1

      - name: Test
        run: bun run test
```
