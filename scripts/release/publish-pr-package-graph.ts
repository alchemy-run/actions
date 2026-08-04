#!/usr/bin/env bun
/**
 * Publish a complete PR-package graph in two passes:
 *
 * 1. Upload every tarball under the deterministic dependency tag used
 *    inside the packed package.json files.
 * 2. After the complete dependency set exists, expose the public full
 *    and short SHA, branch, and PR tags.
 *
 * This keeps public entry points on a usable same-commit graph even if
 * an upload fails partway through.
 */
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

type Package = {
  project: string;
  artifact: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Required env var ${name} is unset or empty`);
  }
  return value;
}

function parsePackages(raw: string): Package[] {
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (pkg) =>
        pkg &&
        typeof pkg === "object" &&
        typeof pkg.project === "string" &&
        typeof pkg.artifact === "string",
    )
  ) {
    throw new Error(
      "CHANGED must be a JSON array of packages with project and artifact fields",
    );
  }
  return parsed as Package[];
}

function parseTags(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((tag) => typeof tag === "string" && tag.length > 0)
  ) {
    throw new Error("TAGS must be a non-empty JSON array of strings");
  }
  return parsed;
}

function tarballFor(artifactRoot: string, pkg: Package): string {
  const artifactDir = join(artifactRoot, pkg.artifact);
  const tarballs = readdirSync(artifactDir)
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => join(artifactDir, file));

  if (tarballs.length !== 1) {
    throw new Error(
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
    "Content-Length": String(file.size),
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
    throw new Error(
      `Failed to publish ${pkg.project}: ${response.status} ` +
        `${response.statusText}${details ? `\n${details}` : ""}`,
    );
  }
}

const packages = parsePackages(required("CHANGED"));
const dependencyTag = required("DEPENDENCY_TAG");
const publicTags = parseTags(required("TAGS"));
const host = required("PR_PACKAGE_HOST");
const token = required("TOKEN");
const ttl = process.env.TTL?.trim() || undefined;
const artifactRoot = process.env.ARTIFACT_ROOT?.trim() || ".pr-packages";

const tarballs = new Map(
  packages.map((pkg) => [pkg.artifact, tarballFor(artifactRoot, pkg)]),
);

console.log("Publishing same-commit dependency graph");
for (const pkg of packages) {
  await upload(host, token, ttl, pkg, tarballs.get(pkg.artifact)!, [
    dependencyTag,
  ]);
}

console.log("Dependency graph complete; exposing public tags");
for (const pkg of packages) {
  await upload(host, token, ttl, pkg, tarballs.get(pkg.artifact)!, publicTags);
}
