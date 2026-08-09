import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Package } from "./pr-package-config.ts";
import {
  ensureTarball,
  pointTags,
  publishPrPackages,
  tarball,
} from "./publish-pr-packages.ts";

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true });
});

describe("content-addressed PR package publishing", () => {
  test("points commit dependencies before public aliases", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-package-publish-test-"));
    temporaryDirectories.push(dir);
    const artifact = join(dir, "artifact");
    mkdirSync(artifact);
    await Bun.write(join(artifact, "package.tgz"), "stable tarball bytes");
    const commit = "a".repeat(40);
    const pkg: Package = {
      dir: "packages/example",
      name: "@scope/example",
      project: "@scope/example",
      install: "@scope/example",
      submodule: false,
      artifact: "artifact",
      commit,
      short: "aaaaaaa",
      tags: ["aaaaaaa", commit, "feature", "pr-1"],
    };

    const pointed: string[][] = [];
    globalThis.fetch = ((input, init) => {
      const request = new Request(input, init);
      if (request.method === "HEAD") {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (request.url.endsWith("/tags")) {
        pointed.push(
          JSON.parse(request.headers.get("alchemy-tags")!) as string[],
        );
      }
      return Promise.resolve(Response.json({ ok: true }));
    }) as typeof fetch;

    await publishPrPackages({
      plan: {
        packages: [pkg],
        publishable_names: [pkg.name],
        install_host: "pkg.example.com",
      },
      host: "pkg.example.com",
      token: "secret",
      artifactRoot: dir,
    });

    expect(pointed).toEqual([[commit], ["aaaaaaa", "feature", "pr-1"]]);
  });

  test("uploads bytes once and keeps moving tag pointers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-package-publish-test-"));
    temporaryDirectories.push(dir);
    const path = join(dir, "package.tgz");
    await Bun.write(path, "stable tarball bytes");
    const archive = tarball(path);
    const pkg: Package = {
      dir: "packages/example",
      name: "@scope/example",
      project: "@scope/example",
      install: "@scope/example",
      submodule: false,
      artifact: "artifact",
      commit: "a".repeat(40),
      short: "aaaaaaa",
      tags: ["aaaaaaa"],
    };

    let exists = false;
    const requests: Request[] = [];
    globalThis.fetch = ((input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "HEAD") {
        return Promise.resolve(new Response(null, { status: exists ? 200 : 404 }));
      }
      if (request.method === "PUT" && request.url.endsWith("/tags")) {
        return Promise.resolve(Response.json({ ok: true }));
      }
      exists = true;
      return Promise.resolve(Response.json({ uploaded: true }));
    }) as typeof fetch;

    await ensureTarball("pkg.example.com", "secret", pkg, archive);
    await pointTags("pkg.example.com", "secret", "1 week", pkg, archive, ["first"]);
    await ensureTarball("pkg.example.com", "secret", pkg, archive);
    await pointTags("pkg.example.com", "secret", "1 week", pkg, archive, ["second"]);

    expect(requests.map((request) => request.method)).toEqual([
      "HEAD",
      "PUT",
      "PUT",
      "HEAD",
      "PUT",
    ]);
    expect(
      requests.filter((request) => request.method === "PUT" && !request.url.endsWith("/tags")),
    ).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      `https://pkg.example.com/projects/%40scope/example/packages/${archive.hash}`,
    );
    expect(requests.at(-1)?.headers.get("alchemy-tarball-hash")).toBe(
      archive.hash,
    );
    expect(requests.at(-1)?.headers.get("alchemy-ttl")).toBe("1 week");
    expect(requests.at(-1)?.headers.has("alchemy-tarball-size")).toBe(false);
  });
});
