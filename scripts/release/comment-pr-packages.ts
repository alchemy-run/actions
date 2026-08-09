#!/usr/bin/env bun
/**
 * Create or update the sticky pull request comment with install commands for
 * every package in the plan.
 */
import { fail, required, type PrPackagePlan } from "./config.ts";

type GitHubComment = {
  id: number;
  body?: string;
  user?: { login?: string };
};

const MARKER = "<!-- pr-package-comment -->";
const BOT_LOGIN = "alchemy-version-bot[bot]";

async function requestGitHub<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
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
const plan = JSON.parse(required("PLAN")) as PrPackagePlan;

const body = [
  MARKER,
  "",
  "Install the packages built from this commit:",
  "",
  "| Package | Install |",
  "| --- | --- |",
  ...plan.packages.map(
    ({ name, install, short }) =>
      `| \`${name}\` | \`bun add https://${plan.install_host}/${install}/${short}\` |`,
  ),
].join("\n");

let existing: GitHubComment | undefined;
for (let page = 1; !existing; page++) {
  const comments = await requestGitHub<GitHubComment[]>(
    token,
    `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
  );
  existing = comments.find((c) => c.user?.login === BOT_LOGIN && c.body?.startsWith(MARKER));
  if (comments.length < 100) break;
}

await requestGitHub(
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
console.log(existing ? "Updated PR-package comment" : "Created PR-package comment");
