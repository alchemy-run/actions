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

export function packageUrl(plan: PrPackagePlan, install: string, commit: string): string {
  return `https://${plan.install_host}/${install}/${encodeURIComponent(commit)}`;
}
