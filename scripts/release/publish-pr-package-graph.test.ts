import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Package } from "./config.ts";
import { ensureTarball, pointTags, tarball } from "./publish-pr-package-graph.ts";

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true });
});

describe("content-addressed PR package publishing", () => {
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
      readme: "README.md",
      submodule: false,
      artifact: "artifact",
      commit: "a".repeat(40),
      short: "aaaaaaa",
      tags: ["aaaaaaa"],
      dependency_tag: `graph-${"a".repeat(40)}`,
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
    expect(requests.at(-1)?.headers.get("x-tarball-hash")).toBe(archive.hash);
    expect(requests.at(-1)?.headers.get("x-tarball-size")).toBe(String(archive.size));
  });
});
