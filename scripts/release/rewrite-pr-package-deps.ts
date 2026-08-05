#!/usr/bin/env bun
/**
 * Compatibility entry point for historical pr-package workflow revisions.
 *
 * Older reusable workflows check this script out from `main`, even when the
 * workflow itself is pinned to an immutable commit. Keep this file available
 * so those callers continue to work while current workflows self-pin their
 * scripts with `job.workflow_sha`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Package = {
  dir: string;
  name: string;
  install?: string;
  project?: string;
  [key: string]: unknown;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`Required env var ${name} is unset or empty`);
    process.exit(1);
  }
  return value.trim();
}

const packageDir = process.argv[2];
if (!packageDir) {
  console.error("Usage: bun rewrite-pr-package-deps.ts <package-dir>");
  process.exit(1);
}

const host = required("ALCHEMY_PR_INSTALL_HOST");
const tag = required("ALCHEMY_PR_TAG");
const packages = JSON.parse(
  required("ALCHEMY_PUBLISHABLE_PACKAGES"),
) as Package[];
if (!Array.isArray(packages)) {
  console.error("ALCHEMY_PUBLISHABLE_PACKAGES must be a JSON array");
  process.exit(1);
}

const installByName = new Map<string, string>();
for (const pkg of packages) {
  installByName.set(pkg.name, pkg.install ?? pkg.project ?? pkg.name);
}

const manifestPath = join(resolve(process.cwd(), packageDir), "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const dependencySections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

let rewritten = false;
for (const section of dependencySections) {
  const dependencies = manifest[section];
  if (!dependencies) continue;
  for (const [name, value] of Object.entries(dependencies)) {
    if (!value.startsWith("workspace:")) continue;
    const install = installByName.get(name);
    if (!install) continue;
    const url = `https://${host}/${install}/${tag}`;
    dependencies[name] = url;
    console.log(
      `  ${manifest.name ?? packageDir}: ${section}.${name}: ${value} → ${url}`,
    );
    rewritten = true;
  }
}

if (rewritten) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
} else {
  console.log(`  ${manifest.name ?? packageDir}: no workspace deps to rewrite`);
}
