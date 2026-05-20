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
 * prefixes that force rebuild-all when matched. Default:
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

const rebuildAllGlobs = (
  process.env.ALCHEMY_PR_REBUILD_ALL_GLOBS?.split(/\r?\n/) ??
  DEFAULT_REBUILD_ALL_GLOBS
)
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
  // For each package, affected if any changed file lives under itself
  // or under one of its transitive workspace deps.
  changed = packages.filter((pkg) => {
    const affectedDirs = [...close(pkg.name)].map(
      (n) => nameToPkg.get(n)!.dir,
    );
    return changedFiles.some((f) =>
      affectedDirs.some((d) => f === d || f.startsWith(d + "/")),
    );
  });
}

console.log(
  JSON.stringify({
    all: rebuildAll,
    changed,
  }),
);
