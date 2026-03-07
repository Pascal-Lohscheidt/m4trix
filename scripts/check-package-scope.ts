#!/usr/bin/env node
/**
 * Check if a package should be published based on changed files since the last tag.
 * Exit 0 = continue (publish), exit 1 = skip.
 *
 * Usage: jiti scripts/check-package-scope.ts <scope>
 * Scope: core | evals
 */

import { execSync } from "node:child_process";

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

function main(): void {
  const scope = process.argv[2];
  if (!scope || !(scope in SCOPE_TO_PATH)) {
    console.error(`Usage: jiti scripts/check-package-scope.ts <scope>`);
    console.error(`Scope must be: core | evals | stream | react | ui`);
    process.exit(2);
  }

  const pathPrefix = SCOPE_TO_PATH[scope];
  const tagPrefix = SCOPE_TO_TAG_PREFIX[scope];

  // Get last tag for this package
  const tags = execSync(`git tag -l '${tagPrefix}*' --sort=-version:refname`, {
    encoding: "utf-8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);

  const lastTag = tags[0];

  if (!lastTag) {
    // No tag exists → first release, continue
    process.exit(0);
  }

  // Get changed files since last tag
  const changedFiles = execSync(`git diff --name-only ${lastTag}..HEAD`, {
    encoding: "utf-8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);

  const hasRelevantChanges = changedFiles.some((file) =>
    file.startsWith(pathPrefix)
  );

  if (hasRelevantChanges) {
    process.exit(0);
  }

  process.exit(1);
}

main();
