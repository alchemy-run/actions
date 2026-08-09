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

export function duplicateSelectedDependencies(plan: PrPackagePlan): Set<string> {
  const selected = new Set(plan.packages.map((pkg) => pkg.name));
  const counts = new Map<string, number>();

  for (const pkg of plan.packages) {
    const manifest = JSON.parse(readFileSync(join(pkg.dir, "package.json"), "utf8")) as Manifest;
    for (const section of DEPENDENCY_SECTIONS) {
      for (const name of Object.keys(manifest[section] ?? {})) {
        if (selected.has(name)) {
          counts.set(name, (counts.get(name) ?? 0) + 1);
        }
      }
    }
  }

  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

export function graphEdgeTag(dependencyTag: string, parentName: string): string {
  // Keep the readable basename short, but hash the full package name so
  // parents with the same basename in different npm scopes stay distinct.
  // Bun uses the tag in a package-store file name with a 255-byte limit.
  const parent = parentName.replace(/^@[^/]+\//, "");
  const hash = createHash("sha256").update(parentName).digest("hex").slice(0, 8);
  const identity = `${parent.slice(0, 80)}-${hash}`;
  return `${dependencyTag}-from-${identity}`;
}

export function graphUrl(plan: PrPackagePlan, install: string, tag: string): string {
  return `https://${plan.install_host}/${install}/${encodeURIComponent(tag)}`;
}
