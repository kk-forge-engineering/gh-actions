# AGENTS.md

For AI agents working in this repository. What the workflows and actions do and how a repo calls them: [README.md](README.md).

- Run every command through `mise`. Before a commit, pass the [local check](README.md#checks).
- Callers pin the major tag, such as `@v4`, so a change merged to `main` reaches no caller until the tag moves. Tags move only when the owner asks. A change that breaks a caller ships under the next major tag, and the earlier major tag stays where it is.
- A workflow here runs in every repo that calls it, on the kk-forge runner for a private repo unless it needs a hosted one, as Release npm does. It follows `docs/standards.md` of project-orchestration: each caller passes its own repo's secrets, as the CI caller does with `SONAR_TOKEN`.
- Pick the runner by the repo's visibility, as `release-image.yml` does. `ci.yml` also sends a PR whose head is outside the repo to a hosted runner. A public repo or such a PR never runs on the self-hosted runners, because it would run someone else's code on the kk-forge server. A job with no checkout and no tools, which only reads another job's results, may run on a hosted runner, as CI's `sonar` job does, so it never waits for a kk-forge runner.
- Release image never moves a tag, so a deploy of a version always gets the same image. A person raises the version in the caller's package.
- Release image runs the caller's tools only in its `version` job, which holds a read-only token. Its `release` job holds the registry token and the write token and runs none of them, so a compromised tool cannot reach either.
- Release npm runs every job on a hosted runner, whatever the repo's visibility. Its `publish` job must, because npm accepts the OIDC token only from one. The other jobs run there too, so the workflow needs no runner switch and no libatomic step. Only its `publish` job can mint that token, and it runs none of the caller's tools.
- Release extension runs the caller's tools only in its `build` job, which holds a read-only token. Its `release` job holds the write token, runs none of them and checks the zip's `manifest.json` version against the build job's outputs. It checks out nothing, so it runs on a hosted runner.
- Add no workflow that deploys: an owner deploys from project-orchestration with Touch ID.
