#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { required } from "./config.ts";
import type { PrPackagePlan } from "./pr-package-config.ts";
import { renderPackageGroups } from "./render-pr-packages.ts";

const plan = JSON.parse(required("PLAN")) as PrPackagePlan;
const summary = [
  "## PR packages",
  "",
  "Install the packages built from this commit:",
  "",
  renderPackageGroups(plan),
].join("\n");

appendFileSync(required("GITHUB_STEP_SUMMARY"), `${summary}\n`);
console.log("Added PR-package install URLs to the run summary");
