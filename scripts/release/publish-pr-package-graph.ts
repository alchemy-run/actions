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

console.log("Publishing same-commit dependency graph");
for (const { pkg, tarball } of entries) {
  await upload(host, token, ttl, pkg, tarball, [plan.dependency_tag]);
}

console.log("Dependency graph complete; exposing public tags");
for (const { pkg, tarball } of entries) {
  await upload(host, token, ttl, pkg, tarball, plan.tags);
}
