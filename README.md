# actions

Shared CI/CD workflows and scripts for the Alchemy projects:

- [`alchemy-run/alchemy`](https://github.com/alchemy-run/alchemy) (async-alchemy)
- [`alchemy-run/alchemy-effect`](https://github.com/alchemy-run/alchemy-effect)
- [`alchemy-run/distilled`](https://github.com/alchemy-run/distilled)

## Reusable workflows

### `release.yml`

Bump versions across a set of publishable workspace packages, commit + tag,
publish to npm with OIDC trusted publishing, then cut a GitHub Release and
notify Discord.

Channels:

- `release <patch|minor|major|x.y.z>` — stable
- `beta` / `alpha` `[N]` — auto-incrementing pre-release
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
        options: [release, beta, alpha, tag]
      spec:
        type: string
jobs:
  release:
    uses: alchemy-run/actions/.github/workflows/release.yml@main
    with:
      channel: ${{ inputs.channel }}
      spec: ${{ inputs.spec }}
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

Publishes a tarball per package to [`pkg.ing`](https://pkg.ing) on every
push-to-main and PR sync. On PR open/sync, leaves a sticky comment with
install URLs pinned to the head commit.

```yaml
# consumer .github/workflows/pr-package.yml
name: pr-package
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, closed]
jobs:
  pr-package:
    uses: alchemy-run/actions/.github/workflows/pr-package.yml@main
    with:
      packages: |
        [
          { "dir": "packages/alchemy", "project": "alchemy" },
          { "dir": "packages/better-auth", "project": "@alchemy.run/better-auth" },
          { "dir": "packages/pr-package", "project": "@alchemy.run/pr-package" }
        ]
    secrets: inherit
```

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
