#!/usr/bin/env bun
/**
 * Pack with Bun, then rewrite selected dependencies in the resulting manifest
 * to same-commit PR-package URLs and repack the verified tarball.
 */
import { $ } from "bun";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fail, required } from "./config.ts";
import type { Package, PrPackagePlan } from "./pr-package-config.ts";
import { DEPENDENCY_SECTIONS, packageUrl, type Manifest } from "./pr-package-manifest.ts";

function rewriteDependencies(plan: PrPackagePlan, dir: string, manifestPath: string): void {
  const selected = new Map<string, Package>(plan.packages.map((p) => [p.name, p]));
  const publishable = new Set(plan.publishable_names);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
  let rewritten = false;

  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = manifest[section];
    if (!dependencies) continue;
    for (const [name, value] of Object.entries(dependencies)) {
      const dependency = selected.get(name);
      if (!dependency && publishable.has(name)) {
        fail(`${manifest.name ?? dir}: publishable dependency ${name} is missing from this run`);
      }
      if (!dependency) continue;
      const url = packageUrl(plan, dependency.install, dependency.commit);
      dependencies[name] = url;
      console.log(`  ${manifest.name ?? dir}: ${section}.${name}: ${value} → ${url}`);
      rewritten = true;
    }
  }
  if (rewritten) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

function normalizeArchiveTree(root: string): string[] {
  const entries: string[] = [];
  const visit = (relative: string) => {
    const absolute = join(root, relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      lutimesSync(absolute, 0, 0);
    } else {
      utimesSync(absolute, 0, 0);
    }
    entries.push(relative);
    if (stat.isDirectory()) {
      for (const child of readdirSync(absolute).sort()) {
        visit(join(relative, child));
      }
    }
  };
  visit("package");
  return entries;
}

const dir = process.argv[2];
if (!dir) fail("Usage: pack-pr-package.ts <package-dir>");

const plan = JSON.parse(required("PLAN")) as PrPackagePlan;
const cwd = resolve(process.cwd(), dir);
const pkg = plan.packages.find((entry) => entry.dir === dir);
if (!pkg) fail(`Package ${dir} is missing from the plan`);

for (const file of readdirSync(cwd).filter((f) => f.endsWith(".tgz"))) {
  unlinkSync(resolve(cwd, file));
}

const result = await $.cwd(cwd)`bun pm pack --destination .`.nothrow();
if (result.exitCode !== 0) {
  fail(`bun pm pack failed with exit code ${result.exitCode}`);
}

let tarballs = readdirSync(cwd).filter((f) => f.endsWith(".tgz"));
if (tarballs.length !== 1) {
  fail(`Expected exactly one tarball, found ${tarballs.length}`);
}

const tarball = resolve(cwd, tarballs[0]!);
const extracted = mkdtempSync(join(tmpdir(), "pr-package-"));
try {
  const unpack = await $`tar -xzf ${tarball} -C ${extracted}`.nothrow();
  if (unpack.exitCode !== 0) {
    fail(`Could not extract ${tarballs[0]}`);
  }

  if (pkg.readme) {
    const readme = resolve(pkg.readme);
    if (!existsSync(readme)) fail(`README ${pkg.readme} does not exist`);
    copyFileSync(readme, join(extracted, "package", "README.md"));
  }
  rewriteDependencies(plan, dir, join(extracted, "package", "package.json"));
  const entries = normalizeArchiveTree(extracted);
  const fileList = join(extracted, "files.txt");
  await Bun.write(fileList, `${entries.join("\n")}\n`);
  unlinkSync(tarball);
  const repack =
    await $`env COPYFILE_DISABLE=1 tar --no-recursion -cf - -C ${extracted} -T ${fileList} | gzip -n > ${tarball}`.nothrow();
  if (repack.exitCode !== 0) {
    fail(`Could not repack ${tarballs[0]}`);
  }
} finally {
  rmSync(extracted, { recursive: true, force: true });
}

tarballs = readdirSync(cwd).filter((f) => f.endsWith(".tgz"));
if (tarballs.length !== 1) {
  fail(`Expected exactly one rewritten tarball, found ${tarballs.length}`);
}
console.log(`Packed and rewrote ${dir}/${tarballs[0]}`);
