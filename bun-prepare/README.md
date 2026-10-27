# Overview

Installs Bun, restores the Bun install cache, installs dependencies using `bun install`, and saves the updated cache. Caching accelerates `bun install` by reusing previously downloaded packages when the action is run across workflows.

## Usage

```yml
- name: Prepare Bun
  uses: kk-forge-engineering/gh-actions/bun-prepare@<commit> # v1
  with:
    bun-version: 1.2.17 # Optional, default is 1.2.17
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
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - name: Prepare Bun
        uses: kk-forge-engineering/gh-actions/bun-prepare@<commit> # v1

  lint:
    runs-on: ubuntu-24.04
    needs: install
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - name: Prepare Bun
        uses: kk-forge-engineering/gh-actions/bun-prepare@<commit> # v1

      - name: Lint
        run: bun run lint

  test:
    runs-on: ubuntu-24.04
    needs: install
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - name: Prepare Bun
        uses: kk-forge-engineering/gh-actions/bun-prepare@<commit> # v1

      - name: Test
        run: bun run test
```
