import { describe, expect, test } from "bun:test";
import type { PrPackagePlan } from "./pr-package-config.ts";
import { renderPackageGroups } from "./render-pr-packages.ts";

describe("PR package groups", () => {
  test("preserves group order and renders copyable short install commands", () => {
    const plan = {
      install_host: "pkg.ing",
      publishable_names: ["alchemy", "@distilled.cloud/core"],
      packages: [
        {
          name: "alchemy",
          install: "alchemy",
          short: "abcdef0",
          group: "Alchemy",
        },
        {
          name: "@distilled.cloud/core",
          install: "@distilled.cloud/core",
          short: "1234567",
          group: "Distilled",
        },
      ],
    } as PrPackagePlan;

    const markdown = renderPackageGroups(plan);
    expect(markdown.indexOf("### Alchemy")).toBeLessThan(markdown.indexOf("### Distilled"));
    expect(markdown).toContain(
      "**alchemy**\n```sh\nbun add https://pkg.ing/alchemy/abcdef0\n```",
    );
    expect(markdown).toContain(
      "**@distilled.cloud/core**\n```sh\nbun add https://pkg.ing/@distilled.cloud/core/1234567\n```",
    );
  });
});
