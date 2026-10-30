# AGENTS.md

For AI agents working in this repository. What the workflows and actions do and how a repo calls them: [README.md](README.md).

- Everything runs through `mise`: it installs actionlint and shellcheck. `mise run check` must be green before a commit ([README.md → Checks](README.md#checks)).
- Callers pin the major tag, such as `@v3`, so a change merged to `main` reaches no caller until the tag moves. Tags move only when the owner asks. A change that breaks a caller ships under the next major tag, and the earlier major tag stays where it is.
- A workflow here runs in every repo that calls it, on the kk-forge runner for a private repo. It follows `docs/standards.md` of project-orchestration: each caller passes its own repo's secrets, as the CI caller does with `SONAR_TOKEN`.
- Pick the runner by the repo's visibility, as `ci.yml` and `release-image.yml` do. A public repo never runs on the self-hosted runners, because a pull request from a fork would run someone else's code on the kk-forge server.
- Release image never moves a tag, so a deploy of a version always gets the same image. A person raises the version in the caller's package, and the workflow warns when a version is already tagged on another commit.
- Release image runs the caller's tools only in its `version` job, which holds a read-only token. Its `release` job holds the registry password and the write token and runs none of them, so a compromised tool cannot reach either.
- Add no workflow that deploys: an owner deploys from project-orchestration with Touch ID.
