import type { PrPackagePlan } from "./pr-package-config.ts";

export function renderPackageTables(plan: PrPackagePlan): string {
  const groups = new Map<string, typeof plan.packages>();
  for (const pkg of plan.packages) {
    const group = pkg.group ?? "Packages";
    groups.set(group, [...(groups.get(group) ?? []), pkg]);
  }

  return [...groups]
    .flatMap(([group, packages]) => [
      `### ${group}`,
      "",
      "| Package | Install |",
      "| --- | --- |",
      ...packages.map(
        ({ name, install, short }) =>
          `| \`${name}\` | \`bun add https://${plan.install_host}/${install}/${short}\` |`,
      ),
      "",
    ])
    .join("\n");
}
