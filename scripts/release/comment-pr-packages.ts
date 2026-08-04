#!/usr/bin/env bun
/** Create or update the sticky PR-package installation comment. */
export {};

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

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required env var ${name} is unset or empty`);
  return value;
}

function parsePackages(raw: string): Package[] {
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (pkg) =>
        pkg &&
        typeof pkg === "object" &&
        typeof pkg.name === "string" &&
        typeof pkg.install === "string",
    )
  ) {
    throw new Error(
      "CHANGED must be a JSON array of packages with name and install",
    );
  }
  return parsed as Package[];
}

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
    throw new Error(
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
const packages = parsePackages(required("CHANGED"));

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
    (comment) =>
      comment.user?.login === BOT_LOGIN && comment.body?.startsWith(MARKER),
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
