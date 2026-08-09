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

**`force-latest`** (boolean input) publishes under npm’s `latest` dist-tag
whatever the channel — use it to promote a release candidate to latest. If a
version is already on the registry it moves the existing `latest` tag onto it
instead of skipping.

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

The npm release workflow pre-declares four wave jobs and skips the empty
ones (cloudflare-tools is the deepest consumer today at four:
rolldown-plugin → runtime/framework-core → vite-plugin + frameworks →
astro/waku). Deeper npm release DAGs require adding matching jobs.

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

Reusable workflows automatically load their actions and scripts from the
exact commit GitHub resolved for the workflow reference. This keeps branch,
tag, and SHA callers self-contained. The optional `actions-ref` input exists
only for testing a different scripts revision explicitly.

## PR-package actions

### `actions/pr-package`

Publishes per-package tarballs to a pr-package service (default
[`pkg.ing`](https://pkg.ing)) on every push-to-main and PR sync. A separate
optional action leaves a sticky PR comment with URLs pinned to the head commit.

**Partial publication.** Only packages whose own dir or a transitive workspace
dependency's dir changed are repacked — the graph is derived from each
`package.json`'s `workspace:*` dependencies, so a touch to `core/` republishes
every leaf that depends on it. A `force-ci` PR label overrides and republishes
everything; touching `bun.lock`, root `package.json`, or the consumer workflow
also republishes everything. The caller may build a wider set before invoking
the action.

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
    # Tags remain valid after a PR closes, so no `closed` event is needed.
    types: [opened, synchronize, reopened, labeled]
jobs:
  pr-package:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: alchemy-run/actions/actions/setup@main

      - uses: actions/cache@v5
        with:
          path: .turbo
          key: turbo-${{ runner.os }}-${{ github.repository_id }}-${{ github.sha }}-${{ github.run_attempt }}
          restore-keys: |
            turbo-${{ runner.os }}-${{ github.repository_id }}-${{ github.sha }}-
            turbo-${{ runner.os }}-${{ github.repository_id }}-

      - run: bun run build

      - id: publish
        uses: alchemy-run/actions/actions/pr-package@main
        with:
          packages: |
            [
              { "dir": "packages/alchemy",     "name": "alchemy",                  "group": "Alchemy" },
              { "dir": "packages/better-auth", "name": "@alchemy.run/better-auth", "group": "Alchemy" },
              { "dir": "packages/pr-package",  "name": "@alchemy.run/pr-package",  "group": "Alchemy" }
            ]
          pr-package-token: ${{ secrets.PR_PACKAGE_TOKEN }}

      - if: github.event_name == 'pull_request'
        id: bot-token
        uses: actions/create-github-app-token@v3
        with:
          app-id: ${{ secrets.ALCHEMY_VERSION_BOT_ID }}
          private-key: ${{ secrets.ALCHEMY_VERSION_BOT_PRIVATE_KEY }}

      - if: github.event_name == 'pull_request'
        uses: alchemy-run/actions/actions/pr-package-comment@main
        with:
          plan: ${{ steps.publish.outputs.plan }}
          token: ${{ steps.bot-token.outputs.token }}
```

**Per-package config** (all optional except `dir` and `name`):

| Field      | Default          | Meaning                                                  |
| ---------- | ---------------- | -------------------------------------------------------- |
| `dir`      | —                | Workspace path (e.g. `packages/aws`)                    |
| `name`     | —                | npm package name used to match workspace dependencies     |
| `group`    | `Packages`       | Heading used to group install commands in the PR comment |
| `project`  | = `name`         | Project name in the pr-package upload URL                |
| `install`  | = `project`      | Path used in generated package URLs                       |
| `readme`   | —                | Repository-relative README to inject into the tarball     |
| `submodule` | `false`          | Resolve this package's commit from its Git submodule     |

Action inputs include `pr-package-host` (upload target, default `pkg.ing`),
`install-host` (CDN host for package URLs; defaults to `pr-package-host`), and
`force-ci-label` (default `force-ci`). The caller owns checkout, tool setup,
dependency installation, building, runner selection, and whether to invoke the
separate `pr-package-comment` action.

All selected packages pack and publish in one job on one runner. The action
rewrites configured workspace dependencies to deterministic full-commit URLs,
addresses each archive by `(package, sha256, byte size)`, and uploads it only
when that exact content is absent. It points every package's full commit first,
then exposes short commit, branch, and PR aliases to the backing archive. The
action also adds grouped install tables to the GitHub Actions run summary. It
does not build packages, use package matrices, publish waves, workflow artifacts,
or per-package runner overrides.

Packages use the action's workflow event commit by default. Set
`submodule: true` on a package inside a checked-out Git submodule to use that
submodule's checked-out commit for dependency URLs and install commands.

### `actions/pr-package-comment`

Optionally creates or updates the grouped install table from the publish
action's `plan` output. The caller supplies the token and decides when the
comment should run.

## Required secrets (inherited from the caller)

| Secret                              | Used by               | Notes                                         |
| ----------------------------------- | --------------------- | --------------------------------------------- |
| `ALCHEMY_VERSION_BOT_ID`            | release + pr-package  | GitHub App id for the bot that commits/tags   |
| `ALCHEMY_VERSION_BOT_PRIVATE_KEY`   | release + pr-package  | GitHub App private key                        |
| `PR_PACKAGE_TOKEN`                  | pr-package            | Bearer token for the pkg.ing service          |
| `DISCORD_WEBHOOK_URL`               | release (optional)    | Skip Discord post if unset                    |
| `NPM_TOKEN`                         | release (optional)    | Only for dist-tag moves under `force-latest`  |
| `GITHUB_TOKEN`                      | release               | Provided automatically                        |

npm publishes use OIDC trusted publishing — no `NPM_TOKEN` required for the
publish itself, but each package must have a Trusted Publisher configured
against this repo on the npm side.

OIDC does **not** cover `npm dist-tag add` ([npm/cli#8547]), which
`force-latest` needs to move the channel tag (e.g. `next`) alongside
`latest`. Set `NPM_TOKEN` to a granular access token with read/write access
to the published packages to enable that; without it the secondary tag move
is skipped with a workflow warning that includes the manual command.

[npm/cli#8547]: https://github.com/npm/cli/issues/8547

## Scripts

All scripts live under `scripts/release/` and are invoked from the shared
workflows and actions. They run in the **consumer** repo's working directory;
the public action inputs are mapped to their internal environment variables:

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
actions/
  setup/action.yml              # setup-node + setup-bun + cache + bun install
  pr-package/action.yml         # plan + pack + rewrite + upload
  pr-package-comment/action.yml # optional grouped install comment
scripts/release/
  bump.ts
  publish-package.ts
  pack-pr-packages.ts
  release-notes.ts
  github-release.ts
  discord-notify.ts
  discord-body.ts
  render.ts
```
