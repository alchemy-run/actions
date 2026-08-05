import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { PrPackagePlan } from "./config.ts";

export type Manifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

export const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export function duplicateWorkspaceDependencies(
  plan: PrPackagePlan,
): Set<string> {
  // Every pack matrix job sees the same plan and clean checkout, so each can
  // derive the graph-wide duplicate set without cross-job state.
  const selected = new Set(plan.packages.map((pkg) => pkg.name));
  const counts = new Map<string, number>();

  for (const pkg of plan.packages) {
    const manifest = JSON.parse(
      readFileSync(join(pkg.dir, "package.json"), "utf8"),
    ) as Manifest;
    for (const section of DEPENDENCY_SECTIONS) {
      for (const [name, value] of Object.entries(manifest[section] ?? {})) {
        if (value.startsWith("workspace:") && selected.has(name)) {
          counts.set(name, (counts.get(name) ?? 0) + 1);
        }
      }
    }
  }

  return new Set(
    [...counts].filter(([, count]) => count > 1).map(([name]) => name),
  );
}

export function graphEdgeTag(
  dependencyTag: string,
  parentName: string,
): string {
  // npm scopes add no useful identity here and can make Bun's package-store
  // file name needlessly long. Bound unusually long package names too: Bun
  // uses the tag in a package-store file name with a 255-byte limit.
  const parent = parentName.replace(/^@[^/]+\//, "");
  const identity =
    parent.length <= 80
      ? parent
      : `${parent.slice(0, 80)}-${createHash("sha256")
          .update(parentName)
          .digest("hex")
          .slice(0, 8)}`;
  return `${dependencyTag}-from-${identity}`;
}

export function graphUrl(
  plan: PrPackagePlan,
  install: string,
  tag: string,
): string {
  return `https://${plan.install_host}/${install}/${encodeURIComponent(tag)}`;
}
