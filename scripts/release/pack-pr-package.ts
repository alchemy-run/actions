#!/usr/bin/env bun
/**
 * Rewrite publishable workspace dependencies to same-commit graph URLs before
 * packing one verified tarball.
 */
import { $ } from "bun";
import {
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  fail,
  required,
  type Package,
  type PrPackagePlan,
} from "./config.ts";
import {
  DEPENDENCY_SECTIONS,
  duplicateWorkspaceDependencies,
  graphEdgeTag,
  graphUrl,
  type Manifest,
} from "./pr-package-graph.ts";

function rewriteDependencies(
  plan: PrPackagePlan,
  dir: string,
  manifestPath: string,
): void {
  const selected = new Map<string, Package>(
    plan.packages.map((p) => [p.name, p]),
  );
  const publishable = new Set(plan.publishable_names);
  const duplicates = duplicateWorkspaceDependencies(plan);
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf-8"),
  ) as Manifest;
  const parentName =
    manifest.name ?? plan.packages.find((pkg) => pkg.dir === dir)?.name ?? dir;
  let rewritten = false;

  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = manifest[section];
    if (!dependencies) continue;
    for (const [name, value] of Object.entries(dependencies)) {
      if (!value.startsWith("workspace:")) continue;
      const dependency = selected.get(name);
      if (!dependency && publishable.has(name)) {
        fail(
          `${manifest.name ?? dir}: publishable workspace dependency ${name} is missing from this run`,
        );
      }
      if (!dependency) continue;
      const tag = duplicates.has(name)
        ? graphEdgeTag(plan.dependency_tag, parentName)
        : plan.dependency_tag;
      const url = graphUrl(plan, dependency.install, tag);
      dependencies[name] = url;
      console.log(
        `  ${manifest.name ?? dir}: ${section}.${name}: ${value} → ${url}`,
      );
      rewritten = true;
    }
  }
  if (rewritten) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

const dir = process.argv[2];
if (!dir) fail("Usage: pack-pr-package.ts <package-dir>");

const plan = JSON.parse(required("PLAN")) as PrPackagePlan;
const cwd = resolve(process.cwd(), dir);
rewriteDependencies(plan, dir, join(cwd, "package.json"));

for (const file of readdirSync(cwd).filter((f) => f.endsWith(".tgz"))) {
  unlinkSync(resolve(cwd, file));
}

const result = await $.cwd(cwd)`bun pm pack --destination .`.nothrow();
if (result.exitCode !== 0) {
  fail(`bun pm pack failed with exit code ${result.exitCode}`);
}

const tarballs = readdirSync(cwd).filter((f) => f.endsWith(".tgz"));
if (tarballs.length !== 1) {
  fail(`Expected exactly one tarball, found ${tarballs.length}`);
}
console.log(`Packed ${dir}/${tarballs[0]}`);
