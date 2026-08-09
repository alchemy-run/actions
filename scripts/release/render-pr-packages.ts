import type { PrPackagePlan } from "./pr-package-config.ts";

export function renderPackageGroups(plan: PrPackagePlan): string {
  const groups = new Map<string, typeof plan.packages>();
  for (const pkg of plan.packages) {
    const group = pkg.group ?? "Packages";
    groups.set(group, [...(groups.get(group) ?? []), pkg]);
  }

  return [...groups]
    .flatMap(([group, packages]) => [
      `### ${group}`,
      "",
      ...packages.flatMap(({ name, install, short }) => [
        `**${name}**`,
        "```sh",
        `bun add https://${plan.install_host}/${install}/${short}`,
        "```",
        "",
      ]),
      "",
    ])
    .join("\n");
}
