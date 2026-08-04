#!/usr/bin/env bun
/**
 * Pack one prepared workspace package after its same-commit dependencies have
 * been rewritten, and verify that Bun produced exactly one tarball.
 *
 * Usage:
 *   bun scripts/release/pack-pr-package.ts <package-dir>
 *
 * Outputs:
 *   One .tgz file in <package-dir>
 */
import { $ } from "bun";
import { readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fail } from "./config.ts";

const packageDir = process.argv[2];
if (!packageDir) {
  fail("Usage: pack-pr-package.ts <package-dir>");
}

const cwd = resolve(process.cwd(), packageDir);
for (const file of readdirSync(cwd).filter((file) => file.endsWith(".tgz"))) {
  unlinkSync(resolve(cwd, file));
}

const $pkg = $.cwd(cwd);
const pack = await $pkg`bun pm pack --destination .`.nothrow();
if (pack.exitCode !== 0) {
  fail(`bun pm pack failed with exit code ${pack.exitCode}`);
}

const tarballs = readdirSync(cwd).filter((file) => file.endsWith(".tgz"));
if (tarballs.length !== 1) {
  fail(`Expected exactly one tarball, found ${tarballs.length}`);
}
console.log(`Packed ${packageDir}/${tarballs[0]}`);
