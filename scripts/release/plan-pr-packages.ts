#!/usr/bin/env bun
/** Select and normalize the packages included in a PR-package run. */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

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

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required env var ${name} is unset or empty`);
  return value;
}

function parsePackages(raw: string): PackageInput[] {
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (pkg) =>
        pkg &&
        typeof pkg === "object" &&
        typeof pkg.dir === "string" &&
        typeof pkg.name === "string",
    )
  ) {
    throw new Error(
      "PACKAGES_JSON must be a JSON array of packages with dir and name",
    );
  }
  return parsed as PackageInput[];
}

function artifactName(dir: string): string {
  // encodeURIComponent leaves !'()* untouched, but GitHub artifact
  // names reject some of them. Encoding the complete RFC 3986 unsafe
  // set keeps this mapping deterministic and collision-free.
  const encoded = encodeURIComponent(dir).replace(
    /[!'()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `pr-package-${encoded}`;
}

function normalize(pkg: PackageInput): Package {
  return {
    dir: pkg.dir,
    name: pkg.name,
    project: pkg.project ?? pkg.name,
    install: pkg.install ?? pkg.project ?? pkg.name,
    runner: pkg.runner ?? "ubuntu-latest",
    artifact: artifactName(pkg.dir),
  };
}

function output(name: string, value: unknown): void {
  appendFileSync(
    required("GITHUB_OUTPUT"),
    `${name}=${JSON.stringify(value)}\n`,
  );
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
const diffResult = Bun.spawnSync(["git", "diff", "--name-only", base, head], {
  stdout: "pipe",
  stderr: "inherit",
});
if (diffResult.exitCode !== 0) {
  throw new Error(`git diff failed with exit code ${diffResult.exitCode}`);
}

const diff = diffResult.stdout.toString();
console.log("Changed files:");
for (const file of diff.trim().split(/\r?\n/).filter(Boolean)) {
  console.log(`  ${file}`);
}

const compute = Bun.spawn(
  [process.execPath, join(import.meta.dir, "compute-changed.ts")],
  {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: {
      ...process.env,
      ALCHEMY_PUBLISHABLE_DIRS: JSON.stringify(packages.map((pkg) => pkg.dir)),
      ALCHEMY_PUBLISHABLE_NAMES: JSON.stringify(
        packages.map((pkg) => pkg.name),
      ),
      ALCHEMY_PR_REBUILD_ALL_GLOBS:
        process.env.ALCHEMY_PR_REBUILD_ALL_GLOBS ?? "",
    },
  },
);
compute.stdin.write(diff);
compute.stdin.end();
const affectedText = await new Response(compute.stdout).text();
const computeExit = await compute.exited;
if (computeExit !== 0) {
  throw new Error(`compute-changed.ts failed with exit code ${computeExit}`);
}
console.log(`compute-changed result: ${affectedText.trim()}`);

const affected = JSON.parse(affectedText) as {
  changed: Array<{ dir: string }>;
};
const byDir = new Map(packages.map((pkg) => [pkg.dir, pkg]));
const changed = affected.changed.map(({ dir }) => {
  const pkg = byDir.get(dir);
  if (!pkg) {
    throw new Error(`compute-changed returned unknown package dir: ${dir}`);
  }
  return pkg;
});
output("changed", changed);
