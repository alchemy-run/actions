#!/usr/bin/env bun
/**
 * Decide which publishable packages need to be rebuilt+republished given
 * a list of changed files (one per line on stdin). A package is
 * "affected" if:
 *
 *   - its own dir was touched, OR
 *   - any of its transitive workspace deps' dirs were touched, OR
 *   - a "global" file was touched (lockfile / root package.json / this
 *     workflow). In that case every package is returned.
 *
 * The transitive-dep closure mirrors compute-waves.ts: it reads each
 * package.json and follows `workspace:*` deps that point at other
 * publishables.
 *
 * Usage:
 *   git diff --name-only <base>..<head> | bun compute-changed.ts
 *
 * Outputs (to stdout):
 *   {"all":false,"changed":[{"dir":"packages/aws","name":"@x/aws", ...}, ...]}
 *
 * Reads ALCHEMY_PUBLISHABLE_DIRS / ALCHEMY_PUBLISHABLE_NAMES.
 *
 * Optional ALCHEMY_PR_REBUILD_ALL_GLOBS env var: newline-separated glob
 * prefixes that force rebuild-all when matched, appended to the
 * defaults:
 *
 *   bun.lock
 *   bun.lockb
 *   package.json
 *   .github/workflows/pr-package.yml
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publishableDirs, publishableNames } from "./config.ts";

const DEFAULT_REBUILD_ALL_GLOBS = [
  "bun.lock",
  "bun.lockb",
  "package.json",
  ".github/workflows/pr-package.yml",
];

const dirs = publishableDirs();
const names = publishableNames();
if (dirs.length !== names.length) {
  console.error(
    "ALCHEMY_PUBLISHABLE_DIRS and ALCHEMY_PUBLISHABLE_NAMES must be parallel arrays",
  );
  process.exit(1);
}

type Pkg = { dir: string; name: string };
const packages: Pkg[] = dirs.map((dir, i) => ({ dir, name: names[i]! }));
const nameToPkg = new Map(packages.map((p) => [p.name, p]));

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const directDeps = new Map<string, Set<string>>(
  packages.map((p) => [p.name, new Set()]),
);

for (const pkg of packages) {
  const pj = JSON.parse(
    readFileSync(join(process.cwd(), pkg.dir, "package.json"), "utf-8"),
  ) as Record<string, Record<string, string> | undefined>;
  for (const section of DEP_SECTIONS) {
    const deps = pj[section];
    if (!deps) continue;
    for (const [depName, value] of Object.entries(deps)) {
      if (typeof value !== "string" || !value.startsWith("workspace:")) continue;
      if (!nameToPkg.has(depName) || depName === pkg.name) continue;
      directDeps.get(pkg.name)!.add(depName);
    }
  }
}

// Transitive closure: pkg → set of every pkg it depends on (incl. itself)
const transitiveSelfAndDeps = new Map<string, Set<string>>();
function close(name: string): Set<string> {
  const cached = transitiveSelfAndDeps.get(name);
  if (cached) return cached;
  const out = new Set<string>([name]);
  transitiveSelfAndDeps.set(name, out); // set early to break cycles (shouldn't happen)
  for (const dep of directDeps.get(name) ?? []) {
    for (const d of close(dep)) out.add(d);
  }
  return out;
}
for (const p of packages) close(p.name);

const changedFiles = readFileSync(0, "utf-8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l.length > 0);

const rebuildAllGlobs = [
  ...DEFAULT_REBUILD_ALL_GLOBS,
  ...(process.env.ALCHEMY_PR_REBUILD_ALL_GLOBS?.split(/\r?\n/) ?? []),
]
  .map((g) => g.trim())
  .filter((g) => g.length > 0);

function pathMatchesGlob(path: string, glob: string): boolean {
  // We only ever need two shapes: exact filename ("bun.lock") and a
  // prefix ending in "/**". Plain endsWith/startsWith is enough — no
  // need to pull in a full glob lib.
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -3);
    return path === prefix || path.startsWith(prefix + "/");
  }
  return path === glob;
}

const rebuildAll = changedFiles.some((f) =>
  rebuildAllGlobs.some((g) => pathMatchesGlob(f, g)),
);

let changed: Pkg[];
if (rebuildAll) {
  changed = packages;
} else {
  // Step 1 — packages whose own dir was touched.
  const directlyTouched = new Set(
    packages
      .filter((pkg) =>
        changedFiles.some(
          (f) => f === pkg.dir || f.startsWith(pkg.dir + "/"),
        ),
      )
      .map((p) => p.name),
  );

  // Step 2 — anyone that depends on a directly-touched package needs
  // a rebuild too (their build output may change).
  const needsRebuild = new Set(directlyTouched);
  for (const pkg of packages) {
    for (const dep of close(pkg.name)) {
      if (directlyTouched.has(dep)) {
        needsRebuild.add(pkg.name);
        break;
      }
    }
  }

  // Step 3 — every transitive workspace dep of a package we're
  // rebuilding ALSO needs to be in the publish set so the pr-package
  // URL rewriter has a same-SHA tarball to point at. Without this
  // step, a PR that only touches `packages/cloudflare/` would publish
  // a cloudflare tarball whose rewritten `core` dep points at a URL
  // that was never uploaded.
  const finalSet = new Set(needsRebuild);
  for (const name of needsRebuild) {
    for (const dep of close(name)) finalSet.add(dep);
  }

  changed = packages.filter((p) => finalSet.has(p.name));
}

console.log(
  JSON.stringify({
    all: rebuildAll,
    changed,
  }),
);
