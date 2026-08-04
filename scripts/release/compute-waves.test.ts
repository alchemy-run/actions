import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "compute-waves.ts");
const temporaryDirectories: string[] = [];

type FixturePackage = {
  dir: string;
  name: string;
  dependencies?: Record<string, string>;
  runner?: string;
};

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runGraph(packages: FixturePackage[], maxWaves?: string) {
  const cwd = mkdtempSync(join(tmpdir(), "compute-waves-"));
  temporaryDirectories.push(cwd);

  for (const pkg of packages) {
    const dir = join(cwd, pkg.dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: pkg.name, dependencies: pkg.dependencies }),
    );
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    ALCHEMY_PUBLISHABLE_PACKAGES: JSON.stringify(
      packages.map(({ dependencies: _, ...pkg }) => pkg),
    ),
  };
  if (maxWaves !== undefined) env.ALCHEMY_MAX_WAVES = maxWaves;
  else delete env.ALCHEMY_MAX_WAVES;

  return Bun.spawnSync([process.execPath, script], { cwd, env });
}

function parseWaves(stdout: Uint8Array) {
  return new TextDecoder()
    .decode(stdout)
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line.slice(line.indexOf("=") + 1)) as FixturePackage[],
    );
}

describe("compute-waves", () => {
  const fiveLevelGraph: FixturePackage[] = [
    {
      dir: "packages/pr",
      name: "pr",
      dependencies: { alchemy: "workspace:*" },
    },
    {
      dir: "packages/alchemy",
      name: "alchemy",
      dependencies: { provider: "workspace:^", vite: "workspace:*" },
    },
    {
      dir: "packages/vite",
      name: "vite",
      dependencies: { runtime: "workspace:~" },
    },
    {
      dir: "packages/provider",
      name: "provider",
      dependencies: { core: "workspace:*" },
    },
    {
      dir: "packages/runtime",
      name: "runtime",
      dependencies: { core: "workspace:*" },
    },
    { dir: "packages/rolldown", name: "rolldown", runner: "large-runner" },
    { dir: "packages/core", name: "core" },
  ];

  test("orders a branched five-level graph and preserves package config", () => {
    const result = runGraph(fiveLevelGraph, "5");

    expect(result.exitCode).toBe(0);
    expect(
      parseWaves(result.stdout).map((wave) => wave.map((pkg) => pkg.name)),
    ).toEqual([
      ["rolldown", "core"],
      ["provider", "runtime"],
      ["vite"],
      ["alchemy"],
      ["pr"],
    ]);
    expect(parseWaves(result.stdout)[0]?.[0]?.runner).toBe("large-runner");
  });

  test("keeps the npm release default capped at two waves", () => {
    const result = runGraph(fiveLevelGraph);

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "Dependency graph depth (5) exceeds MAX_WAVES (2)",
    );
  });

  test("rejects invalid configured limits", () => {
    const result = runGraph([{ dir: "packages/core", name: "core" }], "all");

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "ALCHEMY_MAX_WAVES must be a positive integer",
    );
  });
});
