#!/usr/bin/env bun
/**
 * Publish dependency tags before public tags so failures never expose partial graphs.
 * Public tags re-upload bytes because the API has no tag-only endpoint.
 */
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  fail,
  required,
  type Package,
  type PrPackagePlan,
} from "./config.ts";
import {
  DEPENDENCY_SECTIONS,
  graphEdgeTag,
  graphUrl,
  type Manifest,
} from "./pr-package-graph.ts";

function findTarball(artifactRoot: string, pkg: Package): string {
  const artifactDir = join(artifactRoot, pkg.artifact);
  const tarballs = readdirSync(artifactDir)
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => join(artifactDir, file));

  if (tarballs.length !== 1) {
    fail(
      `Expected one tarball for ${pkg.project}, found ${tarballs.length}`,
    );
  }
  return tarballs[0]!;
}

function packedManifest(tarball: string): Manifest {
  const result = Bun.spawnSync(
    ["tar", "-xOf", tarball, "package/package.json"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr);
    fail(`Failed to read package/package.json from ${tarball}`);
  }
  return JSON.parse(result.stdout.toString()) as Manifest;
}

async function upload(
  host: string,
  token: string,
  ttl: string | undefined,
  pkg: Package,
  tarball: string,
  tags: string[],
): Promise<void> {
  const file = Bun.file(tarball);
  const projectPath = pkg.project
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/gzip",
    "X-Tags": JSON.stringify(tags),
  };
  if (ttl) headers["X-TTL"] = ttl;

  console.log(
    `Publishing ${pkg.project} (${basename(tarball)}) ` +
      `with tags ${JSON.stringify(tags)} ttl=${ttl ?? "default"}`,
  );
  const response = await fetch(
    `https://${host}/projects/${projectPath}/packages`,
    {
      method: "PUT",
      headers,
      body: file,
    },
  );
  if (!response.ok) {
    const details = await response.text();
    fail(
      `Failed to publish ${pkg.project}: ${response.status} ` +
        `${response.statusText}${details ? `\n${details}` : ""}`,
    );
  }
}

const plan = JSON.parse(required("PLAN")) as PrPackagePlan;
const host = required("PR_PACKAGE_HOST");
const token = required("TOKEN");
const ttl = process.env.TTL?.trim() || undefined;
const artifactRoot = process.env.ARTIFACT_ROOT?.trim() || ".pr-packages";

const entries = plan.packages.map((pkg) => ({
  pkg,
  tarball: findTarball(artifactRoot, pkg),
}));
const byName = new Map(entries.map((entry) => [entry.pkg.name, entry]));
const dependencyTags = new Map(
  entries.map(({ pkg }) => [pkg.name, new Set([plan.dependency_tag])]),
);

for (const { pkg, tarball } of entries) {
  const manifest = packedManifest(tarball);
  for (const section of DEPENDENCY_SECTIONS) {
    for (const [name, value] of Object.entries(manifest[section] ?? {})) {
      const dependency = byName.get(name)?.pkg;
      if (!dependency) continue;
      const tag = graphEdgeTag(plan.dependency_tag, manifest.name ?? pkg.name);
      if (value === graphUrl(plan, dependency.install, tag)) {
        dependencyTags.get(name)!.add(tag);
      }
    }
  }
}

console.log("Publishing same-commit dependency graph");
for (const { pkg, tarball } of entries) {
  await upload(host, token, ttl, pkg, tarball, [
    ...dependencyTags.get(pkg.name)!,
  ]);
}

console.log("Dependency graph complete; exposing public tags");
for (const { pkg, tarball } of entries) {
  await upload(host, token, ttl, pkg, tarball, plan.tags);
}
