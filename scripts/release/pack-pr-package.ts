#!/usr/bin/env bun
/** Pack one prepared package and verify that Bun produced one tarball. */
import { readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const packageDir = process.argv[2];
if (!packageDir) {
  throw new Error("Usage: pack-pr-package.ts <package-dir>");
}

const cwd = resolve(process.cwd(), packageDir);
for (const file of readdirSync(cwd).filter((file) => file.endsWith(".tgz"))) {
  unlinkSync(resolve(cwd, file));
}

const pack = Bun.spawnSync(
  [process.execPath, "pm", "pack", "--destination", "."],
  {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  },
);
if (pack.exitCode !== 0) {
  throw new Error(`bun pm pack failed with exit code ${pack.exitCode}`);
}

const tarballs = readdirSync(cwd).filter((file) => file.endsWith(".tgz"));
if (tarballs.length !== 1) {
  throw new Error(`Expected exactly one tarball, found ${tarballs.length}`);
}
console.log(`Packed ${packageDir}/${tarballs[0]}`);
