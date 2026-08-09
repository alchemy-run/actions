#!/usr/bin/env bun
/** Pack and collect every selected PR package from an already-built workspace. */
import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { fail, required } from "./config.ts";
import type { PrPackagePlan } from "./pr-package-config.ts";

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
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
const packScript = join(import.meta.dir, "pack-pr-package.ts");
const artifactRoot = resolve(".pr-packages");

for (const pkg of plan.packages) {
  console.log(`::group::Pack ${pkg.name}`);
  const packageDir = resolve(pkg.dir);
  await run(["bun", packScript, pkg.dir]);

  const tarballs = readdirSync(packageDir).filter((file) => file.endsWith(".tgz"));
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
