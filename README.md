# actions

Shared CI/CD workflows and scripts for the Alchemy projects:

- [`alchemy-run/alchemy`](https://github.com/alchemy-run/alchemy) (async-alchemy)
- [`alchemy-run/alchemy-effect`](https://github.com/alchemy-run/alchemy-effect)
- [`alchemy-run/distilled`](https://github.com/alchemy-run/distilled)

## Reusable workflows

### `release.yml`

Bump versions across a set of publishable workspace packages, commit + tag,
publish to npm with OIDC trusted publishing **in dependency-graph order
(waves)**, then cut a GitHub Release and notify Discord.

**Single `version` input** describes what to publish; the channel is
inferred from its shape:

| Input               | Channel  | Result                                     |
| ------------------- | -------- | ------------------------------------------ |
| `""` (empty)        | beta     | Next beta from npm (auto-increment)        |
| `patch`/`minor`/`major` | release  | Bump current max stable                |
| `1.2.3`             | release  | Explicit stable version                    |
| `beta` / `beta.N`   | beta     | Next or forced beta on `<current-version>` |
| `alpha` / `alpha.N` | alpha    | Same for alpha                             |
| `rc` / `rc.N`       | rc       | Release candidate on `<current-version>`   |
| `<tag-name>`        | tag      | Version becomes `0.0.0-<tag-name>`; **no** git commit, tag, or GitHub Release |

Tag releases always use `0.0.0-<name>` — semver-shaped tag specs like
`2.0.0-experimental` are rejected. Pass just the name.

**Build modes.** `build-mode: up-front` (default) builds every package
once at the start of the bump job and ships `lib/`/`bin/` as part of
the `bump-files` artifact — fastest when the whole workspace fits on
one runner. `build-mode: per-package` skips that, and each publish job
builds its own package inside the package's dir before packing. Use
per-package when the full build doesn't fit on a single runner or when
you want to route specific packages to bigger runners (see `runner:`
below).

**Per-package config** (in the `packages:` JSON array):

| Field    | Default          | Purpose                                                    |
| -------- | ---------------- | ---------------------------------------------------------- |
| `dir`    | —                | Workspace path (e.g. `packages/aws`)                       |
| `name`   | —                | npm package name (used for the workspace-dep graph)        |
| `runner` | `ubuntu-latest`  | GitHub runner used for that package's publish job          |

Publish order is derived automatically from each `package.json`'s
`workspace:*` deps that point at other publishables. A wave is the set of
packages that don't depend on each other — those publish in parallel.
Wave N+1 starts after every wave ≤ N has succeeded. The array order in
`packages:` doesn't matter.

For `alchemy-effect` (`alchemy` ← `better-auth`, `pr-package`) the DAG
resolves to:

```
wave 1: alchemy
wave 2: @alchemy.run/better-auth, @alchemy.run/pr-package   (parallel)
```

For `distilled` (everything depends on `@distilled.cloud/core`):

```
wave 1: @distilled.cloud/core
wave 2: @distilled.cloud/aws, …/cloudflare, …/neon, …       (parallel)
```

The workflow pre-declares five wave jobs and skips the empty ones —
deeper DAGs require bumping `MAX_WAVES` in `compute-waves.ts` and adding
matching jobs.

Channels:

- `release <patch|minor|major|x.y.z>` — stable
- `beta` / `alpha` / `rc` `[N]` — auto-incrementing pre-release
- `tag <x.y.z-suffix>` — explicit one-off (no commit, no GitHub Release)

```yaml
# consumer .github/workflows/release.yml
name: Release NPM Package
on:
  workflow_dispatch:
    inputs:
      channel:
        type: choice
        default: beta
        options: [release, beta, alpha, rc, tag]
      spec:
        type: string
jobs:
  release:
    uses: alchemy-run/actions/.github/workflows/release.yml@main
    with:
      version: ${{ inputs.version }}
      repo: alchemy-run/alchemy-effect
      current-version: "2.0.0"
      packages: |
        [
          { "dir": "packages/alchemy", "name": "alchemy" },
          { "dir": "packages/better-auth", "name": "@alchemy.run/better-auth" },
          { "dir": "packages/pr-package", "name": "@alchemy.run/pr-package" }
        ]
    secrets: inherit
```

### `pr-package.yml`

Publishes per-package tarballs to a pr-package service (default
[`pkg.ing`](https://pkg.ing)) on every push-to-main and PR sync, and
leaves a sticky PR comment with install URLs pinned to the head commit.

**Partial builds.** Only packages whose own dir OR a transitive
workspace dep's dir changed are rebuilt — the dep graph is derived from
each `package.json`'s `workspace:*` deps, so a touch to `core/` rebuilds
every leaf that depends on it. A `force-ci` PR label overrides and
rebuilds everything; touching `bun.lock`, root `package.json`, or this
workflow's yaml also rebuilds everything.

**PR close is a no-op.** Tags persist past PR close so install URLs
keep resolving long-term — the pkg.ing bucket's TTL handles orphan
cleanup on its own schedule.

```yaml
# consumer .github/workflows/pr-package.yml
name: pr-package
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, closed, labeled]
jobs:
  pr-package:
    uses: alchemy-run/actions/.github/workflows/pr-package.yml@main
    with:
      packages: |
        [
          { "dir": "packages/alchemy",     "name": "alchemy" },
          { "dir": "packages/better-auth", "name": "@alchemy.run/better-auth" },
          { "dir": "packages/pr-package",  "name": "@alchemy.run/pr-package" }
        ]
    secrets: inherit
```

**Per-package config** (all optional except `dir` and `name`):

| Field      | Default          | Meaning                                                  |
| ---------- | ---------------- | -------------------------------------------------------- |
| `dir`      | —                | Workspace path (e.g. `packages/aws`)                    |
| `name`     | —                | npm package name (used for the workspace-dep graph)      |
| `project`  | = `name`         | Project name in the pr-package upload URL                |
| `install`  | = `project`      | Path used in the `bun add` URL on PR comments            |
| `runner`   | `ubuntu-latest`  | Override the GitHub runner (e.g. for huge builds)        |

Top-level inputs include `pr-package-host` (upload target, default
`pkg.ing`), `install-host` (CDN host for PR-comment URLs; defaults to
`pr-package-host`), `build-command` (default `bun run build`, run
per-package), and `force-ci-label` (default `force-ci`).

## Required secrets (inherited from the caller)

| Secret                              | Used by               | Notes                                         |
| ----------------------------------- | --------------------- | --------------------------------------------- |
| `ALCHEMY_VERSION_BOT_ID`            | release + pr-package  | GitHub App id for the bot that commits/tags   |
| `ALCHEMY_VERSION_BOT_PRIVATE_KEY`   | release + pr-package  | GitHub App private key                        |
| `PR_PACKAGE_TOKEN`                  | pr-package            | Bearer token for the pkg.ing service          |
| `DISCORD_WEBHOOK_URL`               | release (optional)    | Skip Discord post if unset                    |
| `GITHUB_TOKEN`                      | release               | Provided automatically                        |

npm publishes use OIDC trusted publishing — no `NPM_TOKEN` required, but each
package must have a Trusted Publisher configured against this repo on the npm
side.

## Scripts

All scripts live under `scripts/release/` and are invoked from the reusable
workflows. They run in the **consumer** repo's working directory and read
config from env vars set by the workflow:

| Env var                         | Meaning                                                    |
| ------------------------------- | ---------------------------------------------------------- |
| `ALCHEMY_PUBLISHABLE_DIRS`      | JSON array of package dirs (e.g. `["packages/alchemy"]`)   |
| `ALCHEMY_PUBLISHABLE_NAMES`     | JSON array of npm names (parallel to dirs)                 |
| `ALCHEMY_CURRENT_VERSION`       | Anchor for prerelease bumps (e.g. `"2.0.0"`)               |
| `ALCHEMY_REPO`                  | `<owner>/<repo>` for changelog/release-note URLs           |

## Layout

```
.github/workflows/
  release.yml           # reusable workflow (workflow_call)
  pr-package.yml        # reusable workflow (workflow_call)
actions/
  setup/action.yml      # composite: setup-node + setup-bun + cache + bun install
scripts/release/
  bump.ts
  publish-package.ts
  release-notes.ts
  github-release.ts
  discord-notify.ts
  discord-body.ts
  render.ts
```
