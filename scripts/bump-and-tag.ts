#!/usr/bin/env node
/**
 * Compute next version from conventional commits, update package.json, create and push git tag.
 * Version is not committed — tags are the source of truth.
 *
 * Usage: jiti scripts/bump-and-tag.ts <scope>
 * Scope: core | evals
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../..");

const SCOPE_TO_PATH: Record<string, string> = {
  core: "packages/core/",
  evals: "packages/evals/",
  stream: "packages/stream/",
  react: "packages/react/",
  ui: "packages/ui/",
};

const SCOPE_TO_TAG_PREFIX: Record<string, string> = {
  core: "@m4trix/core@",
  evals: "@m4trix/evals@",
  stream: "@m4trix/stream@",
  react: "@m4trix/react@",
  ui: "@m4trix/ui@",
};

const SCOPE_TO_PACKAGE_JSON: Record<string, string> = {
  core: "packages/core/package.json",
  evals: "packages/evals/package.json",
  stream: "packages/stream/package.json",
  react: "packages/react/package.json",
  ui: "packages/ui/package.json",
};

type BumpType = "major" | "minor" | "patch" | "none";

const BUMP_PRIORITY: Record<BumpType, number> = {
  major: 3,
  minor: 2,
  patch: 1,
  none: 0,
};

function parseConventionalCommit(message: string): BumpType {
  const firstLine = message.split("\n")[0];
  const hasBreakingInBody =
    /BREAKING CHANGE:/i.test(message) || /^breaking change:/im.test(message);
  const hasExclamation = /^[a-z]+(\([^)]+\))?!:/.test(firstLine);

  if (hasBreakingInBody || hasExclamation) {
    return "major";
  }

  const typeMatch = firstLine.match(/^([a-z]+)(?:\([^)]+\))?!?:\s/i);
  if (!typeMatch) return "none";

  const type = typeMatch[1].toLowerCase();
  switch (type) {
    case "feat":
      return "minor";
    case "fix":
    case "perf":
      return "patch";
    case "docs":
    case "style":
    case "test":
    case "chore":
    case "refactor":
    default:
      return "none";
  }
}

function bumpVersion(version: string, bump: BumpType): string {
  const [major, minor, patch] = version.split(".").map(Number);
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "none":
      return version;
  }
}

function main(): void {
  const scope = process.argv[2];
  if (!scope || !(scope in SCOPE_TO_PATH)) {
    console.error(`Usage: jiti scripts/bump-and-tag.ts <scope>`);
    console.error(`Scope must be: core | evals | stream | react | ui`);
    process.exit(2);
  }

  const pathPrefix = SCOPE_TO_PATH[scope];
  const tagPrefix = SCOPE_TO_TAG_PREFIX[scope];
  const packageJsonPath = join(ROOT, SCOPE_TO_PACKAGE_JSON[scope]);

  // Get last tag for this package
  const tags = execSync(`git tag -l '${tagPrefix}*' --sort=-version:refname`, {
    encoding: "utf-8",
    cwd: ROOT,
  })
    .trim()
    .split("\n")
    .filter(Boolean);

  const lastTag = tags[0];
  let currentVersion: string;

  if (!lastTag) {
    // No tag: read version from package.json
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    currentVersion = pkg.version || "0.1.0";
  } else {
    currentVersion = lastTag.replace(tagPrefix, "");
  }

  // Get commits since last tag that touch this package's path
  const revRange = lastTag ? `${lastTag}..HEAD` : "HEAD";
  const commitHashes = execSync(
    `git log ${revRange} --format=%H -- ${pathPrefix}`,
    { encoding: "utf-8", cwd: ROOT }
  )
    .trim()
    .split("\n")
    .filter(Boolean);

  let maxBump: BumpType = "none";

  for (const hash of commitHashes) {
    const message = execSync(`git log -1 --format=%B ${hash}`, {
      encoding: "utf-8",
      cwd: ROOT,
    });
    const bump = parseConventionalCommit(message);
    if (BUMP_PRIORITY[bump] > BUMP_PRIORITY[maxBump]) {
      maxBump = bump;
    }
  }

  // If we have commits but all are docs/chore/etc, default to patch
  if (maxBump === "none" && commitHashes.length > 0) {
    maxBump = "patch";
  }

  const newVersion = bumpVersion(currentVersion, maxBump);
  const newTag = `${tagPrefix}${newVersion}`;

  // Update package.json
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  pkg.version = newVersion;
  writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n");

  // Create tag
  execSync(`git tag ${newTag}`, { cwd: ROOT });

  // Push tag
  execSync(`git push origin ${newTag}`, { cwd: ROOT });

  console.log(`Bumped to ${newVersion}, created and pushed tag ${newTag}`);
}

main();
