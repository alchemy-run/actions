#!/usr/bin/env bun
/** Compute internal graph and public install tags for a PR-package run. */
import { appendFileSync } from "node:fs";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required env var ${name} is unset or empty`);
  return value;
}

function output(name: string, value: string | string[]): void {
  const encoded = typeof value === "string" ? value : JSON.stringify(value);
  appendFileSync(required("GITHUB_OUTPUT"), `${name}=${encoded}\n`);
}

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
