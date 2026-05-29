#!/usr/bin/env bun
/**
 * Rewrite each `workspace:*` dep in one package's package.json to a
 * tarball URL pointing at the SAME branch + same commit's pr-package
 * tarball. Without this, `bun pm pack` resolves `workspace:*` to the
 * sibling's last-published npm version, so installing the pr-package
 * tarball pulls a stale dep from npm instead of the dep we just
 * published from this branch.
 *
 *   "@distilled.cloud/core": "workspace:*"
 *     → "@distilled.cloud/core": "https://pkg.distilled.cloud/core/abc1234"
 *
 * Mutates the package.json in place. We run on ephemeral CI checkouts,
 * so the working-tree dirtying is fine — the file never gets committed.
 *
 * Usage: bun rewrite-pr-package-deps.ts <package-dir>
 *
 * Env:
 *   ALCHEMY_PUBLISHABLE_PACKAGES  full packages JSON array (so we can
 *                                 look up each sibling's `install` path)
 *   ALCHEMY_PR_INSTALL_HOST       e.g. `pkg.distilled.cloud`
 *   ALCHEMY_PR_TAG                e.g. the short SHA used as the
 *                                 pr-package tag for this commit
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Pkg = {
  dir: string;
  name: string;
  install?: string;
  project?: string;
  [key: string]: unknown;
};

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`Required env var ${name} is unset or empty`);
    process.exit(1);
  }
  return v.trim();
}

const packageDirArg = process.argv[2];
if (!packageDirArg) {
  console.error("Usage: bun rewrite-pr-package-deps.ts <package-dir>");
  process.exit(1);
}

const host = required("ALCHEMY_PR_INSTALL_HOST");
const tag = required("ALCHEMY_PR_TAG");

const rawPackages = required("ALCHEMY_PUBLISHABLE_PACKAGES");
const packages = JSON.parse(rawPackages) as Pkg[];
if (!Array.isArray(packages)) {
  console.error("ALCHEMY_PUBLISHABLE_PACKAGES must be a JSON array");
  process.exit(1);
}

// name → install path used in the pr-package URL. Falls back through
// `install` → `project` → `name`, matching the pr-package.yml comment
// step.
const installByName = new Map<string, string>();
for (const p of packages) {
  installByName.set(p.name, p.install ?? p.project ?? p.name);
}

const pkgPath = join(resolve(process.cwd(), packageDirArg), "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

let rewrote = false;
for (const section of DEP_SECTIONS) {
  const deps = pkg[section];
  if (!deps) continue;
  for (const [depName, value] of Object.entries(deps)) {
    if (typeof value !== "string" || !value.startsWith("workspace:")) continue;
    const install = installByName.get(depName);
    if (!install) {
      // workspace dep on a non-publishable sibling — leave alone and
      // let bun pm pack handle (or fail) however it normally would.
      continue;
    }
    const url = `https://${host}/${install}/${tag}`;
    deps[depName] = url;
    console.log(
      `  ${pkg.name ?? packageDirArg}: ${section}.${depName}: ${value} → ${url}`,
    );
    rewrote = true;
  }
}

if (rewrote) {
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
} else {
  console.log(`  ${pkg.name ?? packageDirArg}: no workspace deps to rewrite`);
}
