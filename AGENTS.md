# AGENTS.md

For AI agents working in this repository. What the workflows and actions do and how a repo calls them: [README.md](README.md).

- Everything runs through `mise`: it installs actionlint and shellcheck. `mise run check` must be green before a commit ([README.md → Checks](README.md#checks)).
- Callers pin the major tag, such as `@v2`, so a change merged to `main` reaches no caller until the tag moves. Tags move only when the owner asks. A change that breaks a caller needs the next major tag.
- A workflow here runs in every repo that calls it, on the kk-forge runner for a private repo. It follows `docs/standards.md` of project-orchestration: each caller passes its own repo's secrets, as the CI caller does with `SONAR_TOKEN`.
- A public repo never runs on the self-hosted runners: a pull request from a fork would run someone else's code on the kk-forge server. Pick the runner by the repo's visibility, as `ci.yml` and `release-image.yml` do.
- A release takes its version from the caller's package. Release image keeps every tag where it is, and asks for a raise when a version is already tagged on another commit. The caller's tools run only in its `version` job, which holds a read-only token. The `release` job, which holds the registry password and the write token, runs none of them.
- Add no workflow that deploys: an owner deploys from project-orchestration with Touch ID.
