#!/usr/bin/env bun
/**
 * Compute the private graph tag and public install tags for a PR-package run.
 * The publisher uses these separately so public tags move only after the
 * complete same-commit dependency graph exists.
 *
 * Usage:
 *   bun scripts/release/plan-pr-package-tags.ts
 *
 * Env:
 *   EVENT          GitHub event name
 *   BRANCH         Branch name used as a public tag
 *   SHA            Full commit SHA
 *   PR_NUMBER      Pull request number (required for pull_request events)
 *   GITHUB_OUTPUT  GitHub Actions output file
 *
 * Outputs:
 *   dependency_tag  Private tag used by workspace dependencies
 *   tags             JSON array of public install tags
 *   short            Seven-character commit SHA
 */
import { output, required } from "./config.ts";

const event = required("EVENT");
const branch = required("BRANCH");
const sha = required("SHA");
const short = sha.slice(0, 7);
const tags = [short, sha, branch];

if (event === "pull_request") {
  tags.push(`pr-${required("PR_NUMBER")}`);
}

output("dependency_tag", `graph-${sha}`);
output("tags", tags);
output("short", short);
