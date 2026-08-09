#!/usr/bin/env bun
/**
 * Publish commit pointers before public aliases so dependencies resolve before
 * a branch or PR URL exposes the package set.
 * Tarballs are content-addressed, so unchanged packages only move tag pointers.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fail, required } from "./config.ts";
import type { Package, PrPackagePlan } from "./pr-package-config.ts";

function findTarball(artifactRoot: string, pkg: Package): string {
  const artifactDir = join(artifactRoot, pkg.artifact);
  const tarballs = readdirSync(artifactDir)
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => join(artifactDir, file));

  if (tarballs.length !== 1) {
    fail(`Expected one tarball for ${pkg.project}, found ${tarballs.length}`);
  }
  return tarballs[0]!;
}

export type Tarball = {
  path: string;
  hash: string;
  size: number;
};

export function tarball(path: string): Tarball {
  return {
    path,
    hash: createHash("sha256").update(readFileSync(path)).digest("hex"),
    size: statSync(path).size,
  };
}

function projectUrl(host: string, project: string): string {
  const path = project.split("/").map(encodeURIComponent).join("/");
  return `https://${host}/projects/${path}`;
}

export async function ensureTarball(
  host: string,
  token: string,
  pkg: Package,
  archive: Tarball,
): Promise<void> {
  const url = `${projectUrl(host, pkg.project)}/packages/${archive.hash}/${archive.size}`;
  const authorization = { Authorization: `Bearer ${token}` };
  const probe = await fetch(url, { method: "HEAD", headers: authorization });
  if (probe.ok) {
    console.log(`Reusing ${pkg.project} (${archive.hash.slice(0, 12)}, ${archive.size} bytes)`);
    return;
  }
  if (probe.status !== 404) {
    const details = await probe.text();
    fail(
      `Failed to probe ${pkg.project}: ${probe.status} ` +
        `${probe.statusText}${details ? `\n${details}` : ""}`,
    );
  }

  console.log(
    `Uploading ${pkg.project} (${basename(archive.path)}, ` +
      `${archive.hash.slice(0, 12)}, ${archive.size} bytes)`,
  );
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      ...authorization,
      "Content-Type": "application/gzip",
      "Content-Length": String(archive.size),
    },
    body: Bun.file(archive.path),
  });
  if (!response.ok) {
    const details = await response.text();
    fail(
      `Failed to upload ${pkg.project}: ${response.status} ` +
        `${response.statusText}${details ? `\n${details}` : ""}`,
    );
  }
}

export async function pointTags(
  host: string,
  token: string,
  ttl: string | undefined,
  pkg: Package,
  archive: Tarball,
  tags: string[],
): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "X-Tags": JSON.stringify(tags),
    "X-Tarball-Hash": archive.hash,
    "X-Tarball-Size": String(archive.size),
  };
  if (ttl) headers["X-TTL"] = ttl;

  console.log(
    `Pointing ${pkg.project} tags ${JSON.stringify(tags)} at ` +
      `(${archive.hash.slice(0, 12)}, ${archive.size} bytes) ttl=${ttl ?? "default"}`,
  );
  const response = await fetch(`${projectUrl(host, pkg.project)}/tags`, {
    method: "PUT",
    headers,
  });
  if (!response.ok) {
    const details = await response.text();
    fail(
      `Failed to point tags for ${pkg.project}: ${response.status} ` +
        `${response.statusText}${details ? `\n${details}` : ""}`,
    );
  }
}

export async function publishPrPackages(options: {
  plan: PrPackagePlan;
  host: string;
  token: string;
  ttl?: string;
  artifactRoot: string;
}): Promise<void> {
  const entries = options.plan.packages.map((pkg) => ({
    pkg,
    tarball: tarball(findTarball(options.artifactRoot, pkg)),
  }));

  console.log("Ensuring content-addressed tarballs exist");
  await Promise.all(
    entries.map(({ pkg, tarball }) => ensureTarball(options.host, options.token, pkg, tarball)),
  );

  console.log("Pointing dependency commits");
  await Promise.all(
    entries.map(({ pkg, tarball }) =>
      pointTags(options.host, options.token, options.ttl, pkg, tarball, [pkg.commit]),
    ),
  );

  console.log("Dependency commits complete; exposing public aliases");
  await Promise.all(
    entries.map(({ pkg, tarball }) =>
      pointTags(
        options.host,
        options.token,
        options.ttl,
        pkg,
        tarball,
        pkg.tags.filter((tag) => tag !== pkg.commit),
      ),
    ),
  );
}

if (import.meta.main) {
  await publishPrPackages({
    plan: JSON.parse(required("PLAN")) as PrPackagePlan,
    host: required("PR_PACKAGE_HOST"),
    token: required("TOKEN"),
    ttl: process.env.TTL?.trim() || undefined,
    artifactRoot: process.env.ARTIFACT_ROOT?.trim() || ".pr-packages",
  });
}
