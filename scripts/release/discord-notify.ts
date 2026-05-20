#!/usr/bin/env bun
/**
 * Post a release announcement to Discord as a single embed. The body is
 * read verbatim from the CHANGELOG.md entry the release-notes step just
 * wrote, so Discord matches the GitHub Release copy exactly.
 *
 * The webhook posts under `<RepoName> Releases` (e.g. "Alchemy-Effect
 * Releases", "Distilled Releases"). The embed title uses the first
 * hyphen-segment of the repo name as the project prefix
 * (alchemy-effect → "Alchemy", distilled → "Distilled") and omits the
 * channel suffix for stable `release` channel so you don't get
 * "...(release) released" doubling up.
 *
 *   alchemy-effect + beta → Alchemy v2.0.0-beta.42 (beta) released
 *   distilled + release  → Distilled v0.21.3 released
 *
 * Reads DISCORD_WEBHOOK from the environment. Silently no-ops if unset.
 *
 * Usage: bun discord-notify.ts <tag> <release|beta|alpha|tag>
 *
 * Reads ALCHEMY_REPO for the GitHub repo to link to.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repo } from "./config.ts";
import { extractTagBody, toDiscordBody } from "./discord-body.ts";

const EMBED_DESCRIPTION_LIMIT = 4096;

const tag = process.argv[2];
const channel = process.argv[3];
if (!tag || !channel) {
  console.error("Usage: bun discord-notify.ts <tag> <channel>");
  process.exit(1);
}

const webhook = process.env.DISCORD_WEBHOOK;
if (!webhook) {
  console.log("DISCORD_WEBHOOK not set, skipping Discord notification");
  process.exit(0);
}

const REPO = repo();
const repoSlug = REPO.split("/")[1]!;
const capitalize = (s: string) =>
  s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
// "alchemy-effect" -> "Alchemy-Effect"
const fullRepoName = repoSlug.split("-").map(capitalize).join("-");
// "alchemy-effect" -> "Alchemy"
const projectName = capitalize(repoSlug.split("-")[0]!);
const botName = `${fullRepoName} Releases`;
const titleChannel = channel === "release" ? "" : ` (${channel})`;
const title = `${projectName} ${tag}${titleChannel} released`;

const changelogPath = join(process.cwd(), "CHANGELOG.md");
const changelog = await readFile(changelogPath, "utf-8");
const rawBody = extractTagBody(changelog, tag);
if (rawBody === undefined) {
  console.error(`CHANGELOG.md has no entry for ${tag}`);
  process.exit(1);
}

const body = toDiscordBody(rawBody);

const releaseUrl = `https://github.com/${REPO}/releases/tag/${tag}`;
const description = `${body}\n\n[Full release notes →](${releaseUrl})`;

if (description.length > EMBED_DESCRIPTION_LIMIT) {
  console.error(
    `Changelog (${description.length} chars) exceeds Discord embed description limit (${EMBED_DESCRIPTION_LIMIT}). Trim the changelog or split the release.`,
  );
  process.exit(1);
}

const res = await fetch(webhook, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    username: botName,
    embeds: [
      {
        title,
        url: releaseUrl,
        description,
      },
    ],
    allowed_mentions: { parse: [] },
  }),
});

if (!res.ok) {
  console.error(`Discord webhook failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log(`Posted Discord release notification for ${tag}`);
