#!/usr/bin/env bun
/**
 * Publish a complete PR-package graph without exposing public entry points to
 * a partial same-commit dependency set. Publication happens in two passes:
 *
 * 1. Upload every tarball under the deterministic dependency tag used
 *    inside the packed package.json files.
 * 2. After the complete dependency set exists, expose the public full
 *    and short SHA, branch, and PR tags.
 *
 * This keeps public entry points on a usable same-commit graph even if
 * an upload fails partway through.
 *
 * The second pass deliberately uploads the tarball bytes again because
 * the current PR-package API assigns tags only while handling a package
 * PUT; it does not expose a tag-only assignment endpoint.
 *
 * Usage:
 *   bun scripts/release/publish-pr-package-graph.ts
 *
 * Env:
 *   CHANGED             JSON array of packages and artifact names
 *   DEPENDENCY_TAG      Private tag used by workspace dependencies
 *   TAGS                JSON array of public install tags
 *   PR_PACKAGE_HOST     PR-package service host
 *   TOKEN               PR-package service token
 *   TTL                 Optional package lifetime
 *   ARTIFACT_ROOT       Downloaded artifact root (default: .pr-packages)
 *
 * Outputs:
 *   A complete private dependency graph followed by its public tags
 */
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fail, jsonArray, required } from "./config.ts";

type Package = {
  project: string;
  artifact: string;
};

function tarballFor(artifactRoot: string, pkg: Package): string {
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

function projectPath(project: string): string {
  return project.split("/").map(encodeURIComponent).join("/");
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
    `https://${host}/projects/${projectPath(pkg.project)}/packages`,
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

const packages = jsonArray<Package>("CHANGED", required("CHANGED"));
const dependencyTag = required("DEPENDENCY_TAG");
const publicTags = jsonArray<string>("TAGS", required("TAGS"));
const host = required("PR_PACKAGE_HOST");
const token = required("TOKEN");
const ttl = process.env.TTL?.trim() || undefined;
const artifactRoot = process.env.ARTIFACT_ROOT?.trim() || ".pr-packages";

const entries = packages.map((pkg) => ({
  pkg,
  tarball: tarballFor(artifactRoot, pkg),
}));

console.log("Publishing same-commit dependency graph");
for (const { pkg, tarball } of entries) {
  await upload(host, token, ttl, pkg, tarball, [dependencyTag]);
}

console.log("Dependency graph complete; exposing public tags");
for (const { pkg, tarball } of entries) {
  await upload(host, token, ttl, pkg, tarball, publicTags);
}
