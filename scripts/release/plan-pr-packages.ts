#!/usr/bin/env bun
/**
 * Select and normalize the packages included in a PR-package run. Pull
 * requests use the changed-file graph; pushes and forced runs rebuild all.
 *
 * Usage:
 *   bun scripts/release/plan-pr-packages.ts
 *
 * Env:
 *   EVENT                          GitHub event name
 *   FORCE_LABEL_PRESENT             Whether the force-ci label is present
 *   PACKAGES_JSON                   Configured publishable packages
 *   BASE_SHA / HEAD_SHA             Commits used for pull request diffs
 *   ALCHEMY_PR_REBUILD_ALL_GLOBS    Paths that rebuild every package
 *   GITHUB_OUTPUT                   GitHub Actions output file
 *
 * Outputs:
 *   changed  JSON array of normalized packages to build and publish
 */
import { $ } from "bun";
import { join } from "node:path";
import { fail, jsonArray, output, required } from "./config.ts";

type PackageInput = {
  dir: string;
  name: string;
  project?: string;
  install?: string;
  runner?: string;
};

type Package = {
  dir: string;
  name: string;
  project: string;
  install: string;
  runner: string;
  artifact: string;
};

function parsePackages(raw: string): PackageInput[] {
  const packages = jsonArray<PackageInput>("PACKAGES_JSON", raw);
  if (
    !packages.every(
      (p) =>
        p &&
        typeof p === "object" &&
        typeof p.dir === "string" &&
        typeof p.name === "string",
    )
  ) {
    fail("PACKAGES_JSON packages must have dir and name");
  }
  return packages;
}

function artifactName(dir: string): string {
  // encodeURIComponent leaves !'()* untouched, but GitHub artifact names
  // reject some of them. Encoding the complete RFC 3986 unsafe set keeps
  // this mapping deterministic and collision-free.
  const encoded = encodeURIComponent(dir).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `pr-package-${encoded}`;
}

function normalize(p: PackageInput): Package {
  return {
    dir: p.dir,
    name: p.name,
    project: p.project ?? p.name,
    install: p.install ?? p.project ?? p.name,
    runner: p.runner ?? "ubuntu-latest",
    artifact: artifactName(p.dir),
  };
}

const event = required("EVENT");
const force = process.env.FORCE_LABEL_PRESENT === "true";
const packages = parsePackages(required("PACKAGES_JSON")).map(normalize);

if (event === "push" || force) {
  console.log(
    event === "push"
      ? "Push event — rebuilding every package."
      : "force-ci label present — rebuilding every package.",
  );
  output("changed", packages);
  process.exit(0);
}

const base = required("BASE_SHA");
const head = required("HEAD_SHA");
console.log(`Diffing ${base}..${head}`);
const diffResult = await $`git diff --name-only ${base} ${head}`
  .nothrow()
  .quiet();
if (diffResult.exitCode !== 0) {
  process.stderr.write(diffResult.stderr);
  fail(`git diff failed with exit code ${diffResult.exitCode}`);
}

const diff = diffResult.stdout.toString();
console.log("Changed files:");
for (const file of diff.trim().split(/\r?\n/).filter(Boolean)) {
  console.log(`  ${file}`);
}

const compute = join(import.meta.dir, "compute-changed.ts");
const dirs = JSON.stringify(packages.map((p) => p.dir));
const names = JSON.stringify(packages.map((p) => p.name));
const rebuild = process.env.ALCHEMY_PR_REBUILD_ALL_GLOBS ?? "";
const affectedResult =
  await $`printf %s ${diff} | env ALCHEMY_PUBLISHABLE_DIRS=${dirs} ALCHEMY_PUBLISHABLE_NAMES=${names} ALCHEMY_PR_REBUILD_ALL_GLOBS=${rebuild} bun ${compute}`
    .nothrow()
    .quiet();
if (affectedResult.exitCode !== 0) {
  process.stderr.write(affectedResult.stderr);
  fail(`compute-changed.ts failed with exit code ${affectedResult.exitCode}`);
}

const affectedText = affectedResult.stdout.toString();
console.log(`compute-changed result: ${affectedText.trim()}`);
const affected = JSON.parse(affectedText) as { changed: { dir: string }[] };

const byDir = new Map(packages.map((p) => [p.dir, p]));
const changed = affected.changed.map(({ dir }) => byDir.get(dir)!);
output("changed", changed);
