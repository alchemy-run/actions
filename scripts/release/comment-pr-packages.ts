#!/usr/bin/env bun
/**
 * Create or update one sticky pull request comment with install commands for
 * every package built from the current commit.
 *
 * Usage:
 *   bun scripts/release/comment-pr-packages.ts
 *
 * Env:
 *   GH_TOKEN      GitHub API token
 *   REPO          Repository in owner/name form
 *   PR_NUMBER     Pull request number
 *   SHORT_SHA     Public PR-package tag used in install commands
 *   INSTALL_HOST  PR-package installation host
 *   CHANGED       JSON array of packages included in this run
 *
 * Outputs:
 *   One created or updated sticky pull request comment
 */
import { fail, jsonArray, required } from "./config.ts";

type Package = {
  name: string;
  install: string;
};

type GitHubComment = {
  id: number;
  body?: string;
  user?: { login?: string };
};

const MARKER = "<!-- pr-package-comment -->";
const BOT_LOGIN = "alchemy-version-bot[bot]";

async function github<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "alchemy-run-actions",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const details = await response.text();
    fail(
      `GitHub API ${init.method ?? "GET"} ${path} failed: ` +
        `${response.status} ${response.statusText}\n${details}`,
    );
  }
  return (await response.json()) as T;
}

const token = required("GH_TOKEN");
const repo = required("REPO");
const prNumber = required("PR_NUMBER");
const sha = required("SHORT_SHA");
const host = required("INSTALL_HOST");
const packages = jsonArray<Package>("CHANGED", required("CHANGED"));

const body = [
  MARKER,
  "",
  "Install the packages built from this commit:",
  "",
  ...packages.flatMap(({ name, install }) => [
    `**${name}**`,
    "```sh",
    `bun add ${name}@https://${host}/${install}/${sha}`,
    "```",
    "",
  ]),
].join("\n");

let existing: GitHubComment | undefined;
for (let page = 1; !existing; page++) {
  const comments = await github<GitHubComment[]>(
    token,
    `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
  );
  existing = comments.find(
    (c) => c.user?.login === BOT_LOGIN && c.body?.startsWith(MARKER),
  );
  if (comments.length < 100) break;
}

await github(
  token,
  existing
    ? `/repos/${repo}/issues/comments/${existing.id}`
    : `/repos/${repo}/issues/${prNumber}/comments`,
  {
    method: existing ? "PATCH" : "POST",
    body: JSON.stringify({ body }),
    headers: { "Content-Type": "application/json" },
  },
);
console.log(
  existing ? "Updated PR-package comment" : "Created PR-package comment",
);
