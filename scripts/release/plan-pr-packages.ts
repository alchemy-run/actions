#!/usr/bin/env bun
/**
 * Build the plan consumed by every PR-package job: selected packages, tags,
 * dependency tag, short SHA, and install host as one source of truth.
 */
import { $ } from "bun";
import { join } from "node:path";
import {
  fail,
  jsonArray,
  output,
  required,
  type Package,
  type PrPackagePlan,
} from "./config.ts";

type PackageInput = {
  dir: string;
  name: string;
  project?: string;
  install?: string;
};

async function planPackages(
  packages: Package[],
  event: string,
  sha: string,
): Promise<Package[]> {
  if (event === "push" || process.env.FORCE_LABEL_PRESENT === "true") {
    console.log(
      event === "push"
        ? "Push event — rebuilding every package."
        : "force-ci label present — rebuilding every package.",
    );
    return packages;
  }

  const base = required("BASE_SHA");
  console.log(`Diffing ${base}..${sha}`);
  const diffResult = await $`git diff --name-only ${base} ${sha}`
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
  const result =
    await $`printf %s ${diff} | env ALCHEMY_PUBLISHABLE_DIRS=${dirs} ALCHEMY_PUBLISHABLE_NAMES=${names} ALCHEMY_PR_REBUILD_ALL_GLOBS=${rebuild} bun ${compute}`
      .nothrow()
      .quiet();
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr);
    fail(`compute-changed.ts failed with exit code ${result.exitCode}`);
  }

  const text = result.stdout.toString();
  console.log(`compute-changed result: ${text.trim()}`);
  const affected = JSON.parse(text) as { changed: { dir: string }[] };
  return affected.changed.map(
    ({ dir }) => packages.find((p) => p.dir === dir)!,
  );
}

const event = required("EVENT");
const branch = required("BRANCH");
const sha = required("SHA");
const configured = jsonArray<PackageInput>(
  "PACKAGES_JSON",
  required("PACKAGES_JSON"),
);
if (
  !configured.every(
    (p) =>
      p &&
      typeof p === "object" &&
      typeof p.dir === "string" &&
      typeof p.name === "string",
  )
) {
  fail("PACKAGES_JSON packages must have dir and name");
}

const packages: Package[] = configured.map((p) => {
  // encodeURIComponent leaves !'()* bare; GitHub artifact names reject them.
  const encoded = encodeURIComponent(p.dir).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return {
    dir: p.dir,
    name: p.name,
    project: p.project ?? p.name,
    install: p.install ?? p.project ?? p.name,
    artifact: `pr-package-${encoded}`,
  };
});
const selected = await planPackages(packages, event, sha);

const short = sha.slice(0, 7);
const tags = [short, sha, branch];
if (event === "pull_request") tags.push(`pr-${required("PR_NUMBER")}`);

const plan: PrPackagePlan = {
  packages: selected,
  publishable_names: packages.map((p) => p.name),
  tags,
  dependency_tag: `graph-${sha}`,
  short,
  install_host:
    process.env.INSTALL_HOST?.trim() || required("PR_PACKAGE_HOST"),
};
output("plan", plan);
