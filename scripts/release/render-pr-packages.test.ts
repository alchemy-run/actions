import { describe, expect, test } from "bun:test";
import type { PrPackagePlan } from "./pr-package-config.ts";
import { renderPackageTables } from "./render-pr-packages.ts";

describe("PR package tables", () => {
  test("preserves group order and renders short install URLs", () => {
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

    const markdown = renderPackageTables(plan);
    expect(markdown.indexOf("### Alchemy")).toBeLessThan(markdown.indexOf("### Distilled"));
    expect(markdown).toContain("`bun add https://pkg.ing/alchemy/abcdef0`");
    expect(markdown).toContain("`bun add https://pkg.ing/@distilled.cloud/core/1234567`");
  });
});
