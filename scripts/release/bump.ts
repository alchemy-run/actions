#!/usr/bin/env bun
/**
 * Compute and apply a version bump across all publishable workspace packages.
 *
 * Writes each `<dir>/package.json` and (via `bun install`) `bun.lock`.
 *
 * Prints the chosen version to stdout. All progress messages go to stderr,
 * so callers can capture the version with:
 *     VERSION=$(bun .../bump.ts ...)
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
 * Channels:
 *   release <patch|minor|major|x.y.z>
 *     Stable release. Bumps the named semver part relative to the current
 *     max stable version on npm of the FIRST publishable package, or uses
 *     the explicit version as-is.
 *
 *   beta [N] / alpha [N]
 *     Auto-incrementing pre-release. With no spec, queries npm for the
 *     max ALCHEMY_CURRENT_VERSION-{channel}.N across every publishable
 *     package and increments.
 *
 *     Resume behavior: if a prior release published some packages but not
 *     others, or published everything but the git tag is missing on the
 *     remote, we resume at that N instead of incrementing past it.
 *
 *   tag <version>
 *     Use <version> verbatim.
 *
 * Examples:
 *   bun .../bump.ts release patch
 *   bun .../bump.ts release 2.1.0
 *   bun .../bump.ts beta
 *   bun .../bump.ts beta 15
 *   bun .../bump.ts alpha
 *   bun .../bump.ts tag 2.0.0-experimental.1
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

type Channel = "release" | "beta" | "alpha" | "tag";

const CHANNELS: readonly Channel[] = ["release", "beta", "alpha", "tag"];

function usage(): never {
  console.error(
    "Usage:\n" +
      "  bun bump.ts release <patch|minor|major|x.y.z>\n" +
      "  bun bump.ts beta [N]\n" +
      "  bun bump.ts alpha [N]\n" +
      "  bun bump.ts tag <version>",
  );
  process.exit(1);
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
  channel: "beta" | "alpha",
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
  channel: "beta" | "alpha",
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

function resolveTag(spec: string | undefined): string {
  if (!spec) {
    console.error(
      "tag channel requires an explicit version (e.g. 2.0.0-experimental.1)",
    );
    process.exit(1);
  }
  if (!/^\d+\.\d+\.\d+-[\w.-]+$/.test(spec)) {
    console.error(
      `tag channel version must be x.y.z-<suffix> (always a pre-release); got: ${spec}`,
    );
    process.exit(1);
  }
  console.error(`Using tag version: ${spec}`);
  return spec;
}

const channel = process.argv[2] as Channel | undefined;
const spec = process.argv[3];

if (!channel || !CHANNELS.includes(channel)) {
  usage();
}

let newVersion: string;

const headTagVersion = channel !== "tag" ? await getHeadTagVersion() : null;
if (headTagVersion) {
  console.error(
    `HEAD is already tagged v${headTagVersion}; resuming with this version.`,
  );
  newVersion = headTagVersion;
} else {
  switch (channel) {
    case "release":
      newVersion = await resolveRelease(spec);
      break;
    case "beta":
    case "alpha":
      newVersion = await resolvePrerelease(channel, spec);
      break;
    case "tag":
      newVersion = resolveTag(spec);
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

console.log(newVersion);
