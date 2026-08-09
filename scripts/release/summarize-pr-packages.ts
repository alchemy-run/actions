#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { required, type PrPackagePlan } from "./config.ts";
import { renderPackageTables } from "./render-pr-packages.ts";

const plan = JSON.parse(required("PLAN")) as PrPackagePlan;
const summary = [
  "## PR packages",
  "",
  "Install the packages built from this commit:",
  "",
  renderPackageTables(plan),
].join("\n");

appendFileSync(required("GITHUB_STEP_SUMMARY"), `${summary}\n`);
console.log("Added PR-package install URLs to the run summary");
