#!/usr/bin/env bun
/**
 * Publish one workspace package to npm, idempotently.
 *
 * - Skips if {name}@{version} is already on the registry.
 * - Rewrites `workspace:*` in dependency sections to a concrete version:
 *   publishable siblings resolve to the (freshly bumped) version in their
 *   package.json; other workspace members (e.g. submodule packages like
 *   @distilled.cloud/*) resolve to the installed member's version via
 *   node_modules. `bun pm pack`'s own substitution resolves `workspace:*`
 *   via bun.lock, which can lag behind a fresh version bump.
 * - Selects the npm dist-tag based on the release channel:
 *     release → latest
 *     beta|alpha|rc → next
 *     tag → derived from the version's prerelease suffix (e.g.
 *           2.0.0-experimental.1 → experimental-1)
 *
 * ALCHEMY_FORCE_LATEST=true publishes under `latest` and then moves the
 * channel's own tag (e.g. `next` for beta) onto the version too, so
 * prerelease tags don't go stale when a prerelease is forced onto
 * `latest`. When {name}@{version} is already on the registry, it moves
 * both tags instead of skipping.
 *
 * Only the publish-time `--tag` is covered by npm OIDC trusted
 * publishing; `npm dist-tag add` is not (npm/cli#8547) and needs a real
 * token. Secondary tag moves therefore use ALCHEMY_NPM_TOKEN when set,
 * and otherwise degrade to a workflow warning with the manual command —
 * a missing token never fails the release.
 *
 * Usage: bun publish-package.ts <package-dir> <channel>
 *
 * Reads ALCHEMY_PUBLISHABLE_DIRS to know which siblings count.
 */
import { $ } from "bun";
import {
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { publishableDirs } from "./config.ts";

type DepMap = Record<string, string>;
type PackageJson = {
  name: string;
  version: string;
  dependencies?: DepMap;
  devDependencies?: DepMap;
  peerDependencies?: DepMap;
  optionalDependencies?: DepMap;
};

type Channel = "release" | "beta" | "alpha" | "rc" | "tag";

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const satisfies readonly (keyof PackageJson)[];

const CHANNELS: readonly Channel[] = [
  "release",
  "beta",
  "alpha",
  "rc",
  "tag",
];

const packageArg = process.argv[2];
const channel = process.argv[3] as Channel | undefined;
if (!packageArg || !channel || !CHANNELS.includes(channel)) {
  console.error(
    "Usage: bun publish-package.ts <package-dir> <release|beta|alpha|rc|tag>",
  );
  process.exit(1);
}

const repoRoot = process.cwd();
const packageDir = resolve(repoRoot, packageArg);
const pkgPath = join(packageDir, "package.json");

if (!existsSync(pkgPath)) {
  console.error(`No package.json at ${pkgPath}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as PackageJson;
const { name, version } = pkg;

console.log(`--- Publishing ${name}@${version} (channel: ${channel}) ---`);

const forceLatest = process.env.ALCHEMY_FORCE_LATEST === "true";

// The tag the channel would use on its own, independent of force-latest.
const channelTag =
  channel === "release"
    ? "latest"
    : channel === "beta" || channel === "alpha" || channel === "rc"
      ? "next"
      : version.replace(/^\d+\.\d+\.\d+-/, "").replace(/\./g, "-");

// `latest` wins the publish-time --tag under force-latest because that's
// the only tag OIDC can set; the channel tag is moved afterwards on a
// best-effort basis. If that move fails, default installs are still
// correct and only the channel tag lags.
const publishTag = forceLatest ? "latest" : channelTag;
const extraTags =
  forceLatest && channelTag !== "latest" ? [channelTag] : [];

const npmToken = process.env.ALCHEMY_NPM_TOKEN?.trim() || undefined;

/**
 * Move a dist-tag onto {name}@{version}. npm OIDC trusted publishing only
 * covers `npm publish` — a bare `npm dist-tag add` in CI gets E401
 * (npm/cli#8547) — so this authenticates with ALCHEMY_NPM_TOKEN when set
 * (via the ${NODE_AUTH_TOKEN} reference setup-node wrote into .npmrc) and
 * downgrades failures to a workflow warning instead of failing the release.
 */
async function addDistTag(tag: string): Promise<void> {
  const spec = `${name}@${version}`;
  const cmd = $`npm dist-tag add ${spec} ${tag}`.nothrow();
  const result = await (npmToken
    ? cmd.env({ ...process.env, NODE_AUTH_TOKEN: npmToken })
    : cmd);
  if (result.exitCode === 0) {
    console.log(`dist-tag ${tag} → ${spec}`);
    return;
  }
  const hint = npmToken
    ? "the configured npm token was rejected"
    : "npm OIDC does not cover dist-tag (npm/cli#8547); configure an NPM_TOKEN secret";
  console.log(
    `::warning title=dist-tag ${tag} not moved::${hint}. Run manually: npm dist-tag add ${spec} ${tag}`,
  );
}

const existing = await $`npm view ${`${name}@${version}`} version`
  .nothrow()
  .quiet();
if (existing.exitCode === 0 && existing.stdout.toString().trim().length > 0) {
  if (forceLatest) {
    // The tarball is already on npm; all that's left is to move the tags.
    // Move the channel's own tag too: leaving it behind would strand e.g.
    // `next` on an older prerelease than `latest`.
    console.log(
      `${name}@${version} already published; forcing dist-tag latest`,
    );
    await addDistTag("latest");
    for (const tag of extraTags) {
      await addDistTag(tag);
    }
    process.exit(0);
  }
  console.log(`${name}@${version} already published, skipping`);
  process.exit(0);
}

// Non-sibling workspace members (e.g. packages from a git submodule)
// are symlinked into node_modules by `bun install` — sometimes the
// package's own, sometimes the root's — and their package.json carries
// the version that's expected to exist on npm. Walk node_modules from
// the package dir up to the repo root.
function workspaceMemberVersion(dep: string): string | undefined {
  for (let dir = packageDir; ; dir = resolve(dir, "..")) {
    const memberPkgPath = join(dir, "node_modules", dep, "package.json");
    if (existsSync(memberPkgPath)) {
      const member = JSON.parse(readFileSync(memberPkgPath, "utf-8")) as {
        version?: string;
      };
      return member.version;
    }
    if (dir === repoRoot || resolve(dir, "..") === dir) return undefined;
  }
}

const siblingVersions = new Map<string, string>();
for (const dir of publishableDirs()) {
  const siblingPkgPath = join(repoRoot, dir, "package.json");
  if (!existsSync(siblingPkgPath)) continue;
  const sibling = JSON.parse(readFileSync(siblingPkgPath, "utf-8")) as {
    name?: string;
    version?: string;
  };
  if (sibling.name && sibling.version) {
    siblingVersions.set(sibling.name, sibling.version);
  }
}

let rewrote = false;
for (const section of DEP_SECTIONS) {
  const deps = pkg[section];
  if (!deps) continue;
  for (const [dep, value] of Object.entries(deps)) {
    if (typeof value !== "string" || !value.startsWith("workspace:")) continue;
    const spec = value.slice("workspace:".length);
    const concrete = siblingVersions.get(dep) ?? workspaceMemberVersion(dep);
    if (!concrete) {
      console.error(
        `${name}: ${section}.${dep} is ${value} but neither a configured publishable package nor an installed workspace member provides ${dep}`,
      );
      process.exit(1);
    }
    const rewritten =
      spec === "*" || spec === ""
        ? concrete
        : spec === "^"
          ? `^${concrete}`
          : spec === "~"
            ? `~${concrete}`
            : spec;
    deps[dep] = rewritten;
    console.log(`  ${section}.${dep}: ${value} → ${rewritten}`);
    rewrote = true;
  }
}

if (rewrote) {
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

const $pkg = $.cwd(packageDir);
await $pkg`bun pm pack --destination .`;

const tarballs = readdirSync(packageDir).filter((f) => f.endsWith(".tgz"));
if (tarballs.length !== 1) {
  console.error(
    `Expected exactly one .tgz in ${packageDir}, found ${tarballs.length}: ${tarballs.join(", ")}`,
  );
  process.exit(1);
}
const tarball = tarballs[0]!;

console.log(`Publishing tarball: ${tarball} (dist-tag: ${publishTag})`);

await $pkg`npm publish ${tarball} --access public --tag ${publishTag}`;

// Force-latest is additive: after publishing under `latest`, move the
// channel tag (e.g. `next`) too so it doesn't strand on an older version.
for (const tag of extraTags) {
  await addDistTag(tag);
}

unlinkSync(join(packageDir, tarball));

console.log(`--- Published ${name}@${version} ---`);
