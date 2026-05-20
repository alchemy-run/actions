#!/usr/bin/env bun
/**
 * Topologically sort the configured publishable packages into "waves":
 * a wave is a set of packages that can publish in parallel because none
 * of them depend on each other. Wave N+1 needs every wave ≤ N to have
 * published first.
 *
 * Dependencies are derived from each package.json's
 * dependencies/devDependencies/peerDependencies/optionalDependencies:
 * any entry with a `workspace:*`-style value pointing at a sibling that
 * is itself in the publish set adds an edge.
 *
 * Output: one line of JSON per wave to stdout, plus a single combined
 * JSON 2D array on the final line. The workflow consumes the combined
 * line as a job output.
 *
 *   $ bun compute-waves.ts
 *   wave1=[{"dir":"packages/core","name":"@x/core"}]
 *   wave2=[{"dir":"packages/aws","name":"@x/aws"},{"dir":"packages/cf","name":"@x/cf"}]
 *   wave3=[]
 *   wave4=[]
 *   wave5=[]
 *   waves=[[{...}],[{...},{...}],[],[],[]]
 *
 * Errors out (non-zero exit) if the graph has a cycle.
 *
 * Reads ALCHEMY_PUBLISHABLE_DIRS / ALCHEMY_PUBLISHABLE_NAMES.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publishableDirs, publishableNames } from "./config.ts";

const MAX_WAVES = 5;

const dirs = publishableDirs();
const names = publishableNames();
if (dirs.length !== names.length) {
  console.error(
    "ALCHEMY_PUBLISHABLE_DIRS and ALCHEMY_PUBLISHABLE_NAMES must be parallel arrays",
  );
  process.exit(1);
}

type Package = { dir: string; name: string };
const packages: Package[] = dirs.map((dir, i) => ({ dir, name: names[i]! }));
const nameToPackage = new Map(packages.map((p) => [p.name, p]));

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

// edges[X] = packages that X depends on (X needs these to publish first).
const edges = new Map<string, Set<string>>(
  packages.map((p) => [p.name, new Set()]),
);

for (const pkg of packages) {
  const pkgJsonPath = join(process.cwd(), pkg.dir, "package.json");
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as Record<
    string,
    Record<string, string> | undefined
  >;
  for (const section of DEP_SECTIONS) {
    const deps = pkgJson[section];
    if (!deps) continue;
    for (const [depName, value] of Object.entries(deps)) {
      if (typeof value !== "string" || !value.startsWith("workspace:")) continue;
      if (!nameToPackage.has(depName)) continue; // not in publish set
      if (depName === pkg.name) continue; // self-edge (shouldn't happen)
      edges.get(pkg.name)!.add(depName);
    }
  }
}

// Kahn's algorithm — assign each node to a wave equal to 1 + max wave of
// its dependencies. Iterate until every node has a wave; if a pass makes
// no progress, the graph has a cycle.
const wave = new Map<string, number>();
let progress = true;
while (progress && wave.size < packages.length) {
  progress = false;
  for (const pkg of packages) {
    if (wave.has(pkg.name)) continue;
    const deps = edges.get(pkg.name)!;
    let maxDepWave = 0;
    let ready = true;
    for (const dep of deps) {
      const w = wave.get(dep);
      if (w === undefined) {
        ready = false;
        break;
      }
      if (w > maxDepWave) maxDepWave = w;
    }
    if (ready) {
      wave.set(pkg.name, maxDepWave + 1);
      progress = true;
    }
  }
}

if (wave.size < packages.length) {
  const unresolved = packages.filter((p) => !wave.has(p.name)).map((p) => p.name);
  console.error(
    `Cycle detected in workspace dependency graph among: ${unresolved.join(", ")}`,
  );
  process.exit(1);
}

const maxWave = Math.max(0, ...wave.values());
if (maxWave > MAX_WAVES) {
  console.error(
    `Dependency graph depth (${maxWave}) exceeds MAX_WAVES (${MAX_WAVES}). ` +
      "Bump MAX_WAVES in compute-waves.ts and add matching publish-wave-N jobs to release.yml.",
  );
  process.exit(1);
}

const waves: Package[][] = Array.from({ length: MAX_WAVES }, () => []);
for (const pkg of packages) {
  waves[wave.get(pkg.name)! - 1]!.push(pkg);
}

const lines: string[] = [];
waves.forEach((w, i) => {
  lines.push(`wave${i + 1}=${JSON.stringify(w)}`);
});
lines.push(`waves=${JSON.stringify(waves)}`);
console.log(lines.join("\n"));
