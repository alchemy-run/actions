#!/usr/bin/env bun
/**
 * Compute and apply a version bump across all publishable workspace packages.
 *
 * Writes each `<dir>/package.json` and (via `bun install`) `bun.lock`.
 *
 * Prints two lines to stdout in `key=value` form so callers can pipe
 * directly into `$GITHUB_OUTPUT`:
 *
 *     channel=<release|beta|alpha|tag>
 *     version=<resolved x.y.z[-prerelease]>
 *
 * All progress messages go to stderr.
 *
 * Does NOT commit or push. The release workflow commits only after every
 * package has been published to npm, so an interrupted publish leaves no
 * orphan commit behind.
 *
 * Config (env vars, set by the reusable workflow):
 *   ALCHEMY_PUBLISHABLE_DIRS    JSON array of package dirs
 *   ALCHEMY_PUBLISHABLE_NAMES   JSON array of npm names (parallel to dirs)
 *   ALCHEMY_CURRENT_VERSION     Anchor for prerelease bumps (e.g. "2.0.0")
 *
 * Single positional arg — the version spec. The script infers the
 * release channel from its shape:
 *
 *   ""                empty → beta channel, auto-increment
 *   patch|minor|major release channel, bumps from current max stable
 *   x.y.z             release channel, explicit
 *   beta[.N]          beta channel; with N, force; without, auto-increment
 *   rc[.N]            release-candidate channel; same semantics as beta
 *   alpha[.N]         alpha channel; same semantics as beta
 *   <anything-else>   tag channel — version becomes `0.0.0-<sanitized>`,
 *                     skips git commit/tag/GitHub Release. Explicit
 *                     semver-shaped values (e.g. `2.0.0-experimental.1`)
 *                     are REJECTED — pass just the tag name.
 *
 * Examples:
 *   bun .../bump.ts                            # auto beta
 *   bun .../bump.ts patch                      # release 2.0.0 -> 2.0.1
 *   bun .../bump.ts 2.1.0                      # release explicit
 *   bun .../bump.ts beta                       # next beta
 *   bun .../bump.ts beta.15                    # forced beta.15
 *   bun .../bump.ts alpha                      # next alpha
 *   bun .../bump.ts experimental               # tag → 0.0.0-experimental
 *   bun .../bump.ts my-feature                 # tag → 0.0.0-my-feature
 */
import { $ } from "bun";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  currentVersion,
  publishableDirs,
  publishableNames,
} from "./config.ts";

const PUBLISHABLE_DIRS = publishableDirs();
const PUBLISHABLE_NAMES = publishableNames();
const CURRENT_MAJOR_MINOR_PATCH = currentVersion();

if (PUBLISHABLE_DIRS.length !== PUBLISHABLE_NAMES.length) {
  console.error(
    "ALCHEMY_PUBLISHABLE_DIRS and ALCHEMY_PUBLISHABLE_NAMES must be parallel arrays",
  );
  process.exit(1);
}

type Channel = "release" | "beta" | "alpha" | "rc" | "tag";

type Plan =
  | { channel: "release"; spec: string } // "patch" | "minor" | "major" | "x.y.z"
  | { channel: "beta" | "alpha" | "rc"; spec?: string } // undefined = auto; "N" = forced
  | { channel: "tag"; name: string }; // becomes 0.0.0-<name>

function usage(): never {
  console.error(
    "Usage:\n" +
      "  bun bump.ts                  # next beta (auto-increment)\n" +
      "  bun bump.ts patch|minor|major\n" +
      "  bun bump.ts 1.2.3            # explicit release\n" +
      "  bun bump.ts beta[.N]\n" +
      "  bun bump.ts alpha[.N]\n" +
      "  bun bump.ts rc[.N]\n" +
      "  bun bump.ts <tag-name>       # tag release → 0.0.0-<tag-name>",
  );
  process.exit(1);
}

function parseInput(input: string): Plan {
  // Empty == auto beta. Matches the "beta cut" default in the workflow UI.
  if (input === "" || input === "beta") return { channel: "beta" };
  if (input === "alpha") return { channel: "alpha" };
  if (input === "rc") return { channel: "rc" };

  let m = input.match(/^beta\.(\d+)$/);
  if (m) return { channel: "beta", spec: m[1] };
  m = input.match(/^alpha\.(\d+)$/);
  if (m) return { channel: "alpha", spec: m[1] };
  m = input.match(/^rc\.(\d+)$/);
  if (m) return { channel: "rc", spec: m[1] };

  if (input === "patch" || input === "minor" || input === "major") {
    return { channel: "release", spec: input };
  }
  if (/^\d+\.\d+\.\d+$/.test(input)) {
    return { channel: "release", spec: input };
  }

  // Tag channel — reject anything that LOOKS like a version. The
  // contract is `0.0.0-<name>`; if you want an experimental release,
  // pass just `experimental` (or `experimental-1`), never
  // `2.0.0-experimental` or `0.0.0-experimental`.
  if (/^\d+\.\d+\.\d+/.test(input)) {
    console.error(
      `Invalid version '${input}'. Tag releases are always 0.0.0-<name> — ` +
        "pass just the tag name (e.g. 'experimental' or 'my-feature'), not a semver string.",
    );
    process.exit(1);
  }
  // npm prerelease identifiers (per semver) are [0-9A-Za-z-] dot-segments.
  // We additionally require it to start with a letter so it can't be
  // mistaken for a version-shaped string and stays human-readable.
  if (!/^[a-zA-Z][a-zA-Z0-9.-]*$/.test(input)) {
    console.error(
      `Invalid tag name '${input}'. Must start with a letter and contain only [A-Za-z0-9.-].`,
    );
    process.exit(1);
  }
  return { channel: "tag", name: input };
}

async function fetchNpmVersions(pkg: string): Promise<string[]> {
  try {
    const r = await fetch(`https://registry.npmjs.org/${pkg}`);
    if (!r.ok) return [];
    const data = (await r.json()) as { versions?: Record<string, unknown> };
    return Object.keys(data.versions ?? {});
  } catch {
    return [];
  }
}

function maxPrereleaseN(
  versions: readonly string[],
  channel: "beta" | "alpha" | "rc",
): number {
  const re = new RegExp(`^${CURRENT_MAJOR_MINOR_PATCH}-${channel}\\.(\\d+)$`);
  const ns = versions
    .map((v) => {
      const m = v.match(re);
      return m ? parseInt(m[1]!, 10) : 0;
    })
    .filter((n) => n > 0);
  return ns.length > 0 ? Math.max(...ns) : 0;
}

function maxStable(versions: readonly string[]): string | null {
  const stables = versions.filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  if (stables.length === 0) return null;
  return stables.sort(compareSemver)[stables.length - 1]!;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  }
  return 0;
}

async function getHeadTagVersion(): Promise<string | null> {
  const r = await $`git describe --exact-match --tags HEAD`.nothrow().quiet();
  if (r.exitCode !== 0) return null;
  const tag = r.stdout.toString().trim();
  if (!/^v\d+\.\d+\.\d+(-[\w.-]+)?$/.test(tag)) return null;
  return tag.slice(1);
}

async function remoteTagExists(tag: string): Promise<boolean> {
  const r =
    await $`git ls-remote --exit-code --tags origin ${`refs/tags/${tag}`}`
      .nothrow()
      .quiet();
  return r.exitCode === 0;
}

async function resolveRelease(spec: string | undefined): Promise<string> {
  if (!spec) {
    console.error("release channel requires a spec: patch|minor|major|<x.y.z>");
    process.exit(1);
  }
  if (/^\d+\.\d+\.\d+$/.test(spec)) {
    console.error(`Explicit release version: ${spec}`);
    return spec;
  }
  if (spec !== "patch" && spec !== "minor" && spec !== "major") {
    console.error(
      `Invalid release spec: ${spec}. Use patch|minor|major|<x.y.z>.`,
    );
    process.exit(1);
  }
  // Anchor bumps to the first publishable package's npm history.
  const anchor = PUBLISHABLE_NAMES[0]!;
  const versions = await fetchNpmVersions(anchor);
  const current = maxStable(versions);
  if (!current) {
    console.error(
      `No stable \`${anchor}\` versions on npm; cannot bump relative to current.`,
    );
    process.exit(1);
  }
  const [maj, min, pat] = current.split(".").map((n) => parseInt(n, 10)) as [
    number,
    number,
    number,
  ];
  const bumped =
    spec === "major"
      ? `${maj + 1}.0.0`
      : spec === "minor"
        ? `${maj}.${min + 1}.0`
        : `${maj}.${min}.${pat + 1}`;
  console.error(`Bumping ${spec}: ${current} → ${bumped}`);
  return bumped;
}

async function resolvePrerelease(
  channel: "beta" | "alpha" | "rc",
  spec: string | undefined,
): Promise<string> {
  if (spec !== undefined) {
    if (!/^\d+$/.test(spec)) {
      console.error(
        `${channel} channel spec must be an integer N (got: ${spec})`,
      );
      process.exit(1);
    }
    const explicit = `${CURRENT_MAJOR_MINOR_PATCH}-${channel}.${spec}`;
    console.error(`Explicit ${channel} version: ${explicit}`);
    return explicit;
  }

  console.error(`Resolving next ${channel} version from npm state...`);
  const perPkgMax = await Promise.all(
    PUBLISHABLE_NAMES.map(async (name) => {
      const versions = await fetchNpmVersions(name);
      return maxPrereleaseN(versions, channel);
    }),
  );
  const maxN = Math.max(0, ...perPkgMax);
  const allAtMax = maxN > 0 && perPkgMax.every((n) => n === maxN);

  let nextN: number;
  if (maxN === 0) {
    nextN = 1;
    console.error(
      `No ${channel} versions on npm yet; starting at ${channel}.${nextN}`,
    );
  } else if (!allAtMax) {
    nextN = maxN;
    console.error(
      `Partial publish at ${channel}.${maxN} (per-package: ${JSON.stringify(
        Object.fromEntries(PUBLISHABLE_NAMES.map((n, i) => [n, perPkgMax[i]])),
      )}). Resuming at ${channel}.${nextN}.`,
    );
  } else if (
    !(await remoteTagExists(`v${CURRENT_MAJOR_MINOR_PATCH}-${channel}.${maxN}`))
  ) {
    nextN = maxN;
    console.error(
      `All packages at ${channel}.${maxN} on npm but tag v${CURRENT_MAJOR_MINOR_PATCH}-${channel}.${maxN} missing on remote. Resuming at ${channel}.${nextN}.`,
    );
  } else {
    nextN = maxN + 1;
    console.error(
      `Bumping to next ${channel}: ${CURRENT_MAJOR_MINOR_PATCH}-${channel}.${nextN}`,
    );
  }
  return `${CURRENT_MAJOR_MINOR_PATCH}-${channel}.${nextN}`;
}

function resolveTag(name: string): string {
  const version = `0.0.0-${name}`;
  console.error(`Tag release: ${version}`);
  return version;
}

if (process.argv.length > 3) {
  console.error("Too many arguments — bump.ts takes a single version spec.");
  usage();
}

const input = (process.argv[2] ?? "").trim();
const plan = parseInput(input);

let channel: Channel = plan.channel;
let newVersion: string;

// Durability: if HEAD is already at an exact release tag (a previous
// attempt committed+tagged but failed before npm publish), reuse that
// version instead of computing a new one. Skipped for `tag` — those
// releases are intentionally uncommitted/ephemeral.
const headTagVersion = channel !== "tag" ? await getHeadTagVersion() : null;
if (headTagVersion) {
  console.error(
    `HEAD is already tagged v${headTagVersion}; resuming with this version.`,
  );
  newVersion = headTagVersion;
} else {
  switch (plan.channel) {
    case "release":
      newVersion = await resolveRelease(plan.spec);
      break;
    case "beta":
    case "alpha":
    case "rc":
      newVersion = await resolvePrerelease(plan.channel, plan.spec);
      break;
    case "tag":
      newVersion = resolveTag(plan.name);
      break;
  }
}

for (const dir of PUBLISHABLE_DIRS) {
  const pkgPath = join(process.cwd(), dir, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
  pkg.version = newVersion;
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

console.error("Running bun install to refresh bun.lock workspace versions...");
await $`bun install`.quiet();

console.log(`channel=${channel}`);
console.log(`version=${newVersion}`);
