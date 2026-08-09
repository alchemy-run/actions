#!/usr/bin/env bun
/** Build and pack every selected PR package on the current runner. */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  fail,
  required,
  type PrPackagePlan,
} from "./config.ts";

async function run(command: string[], cwd = process.cwd()): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    fail(`${command[0]} failed with exit code ${exitCode}`);
  }
}

const plan = JSON.parse(required("PLAN")) as PrPackagePlan;
const buildCommand = required("BUILD_COMMAND");
const packScript = join(import.meta.dir, "pack-pr-package.ts");
const artifactRoot = resolve(".pr-packages");

// Finish every build before pack-pr-package mutates any package manifest.
for (const pkg of plan.packages) {
  console.log(`::group::Build ${pkg.name}`);
  await run(
    ["bash", "-eo", "pipefail", "-c", buildCommand],
    resolve(pkg.dir),
  );
  console.log("::endgroup::");
}

for (const pkg of plan.packages) {
  console.log(`::group::Pack ${pkg.name}`);
  const packageDir = resolve(pkg.dir);
  const manifestPath = join(packageDir, "package.json");
  const manifest = readFileSync(manifestPath);
  try {
    await run(["bun", packScript, pkg.dir]);
  } finally {
    // pack-pr-package rewrites workspace dependencies in place. Matrix jobs
    // previously discarded that mutation with their checkout; restore it here
    // so every sequential pack derives graph-wide duplicate edges from the
    // same manifests.
    writeFileSync(manifestPath, manifest);
  }

  const tarballs = readdirSync(packageDir).filter((file) =>
    file.endsWith(".tgz"),
  );
  if (tarballs.length !== 1) {
    fail(`Expected one tarball for ${pkg.name}, found ${tarballs.length}`);
  }

  const artifactDir = join(artifactRoot, pkg.artifact);
  mkdirSync(artifactDir, { recursive: true });
  renameSync(
    join(packageDir, tarballs[0]!),
    join(artifactDir, tarballs[0]!),
  );
  console.log("::endgroup::");
}
