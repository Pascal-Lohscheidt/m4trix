#!/usr/bin/env node
/**
 * Push the release tag created by bump-and-tag.ts. Run only after `npm publish` succeeded.
 *
 * Usage: jiti scripts/push-release-tag.ts <scope>
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCOPE_TO_PATH, SCOPE_TO_TAG_PREFIX } from './changelog-config.ts';

const ROOT = join(fileURLToPath(import.meta.url), '../..');

function main(): void {
  const scope = process.argv[2];
  if (!scope || !(scope in SCOPE_TO_PATH)) {
    console.error('Usage: jiti scripts/push-release-tag.ts <scope>');
    console.error(`Scope must be: ${Object.keys(SCOPE_TO_PATH).join(' | ')}`);
    process.exit(2);
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, SCOPE_TO_PATH[scope], 'package.json'), 'utf-8'));
  const tag = `${SCOPE_TO_TAG_PREFIX[scope]}${pkg.version}`;

  const exists = execSync(`git tag -l '${tag}'`, { encoding: 'utf-8', cwd: ROOT }).trim();
  if (!exists) {
    console.error(`Local tag ${tag} not found — run bump-and-tag.ts first.`);
    process.exit(1);
  }

  execSync(`git push origin '${tag}'`, { cwd: ROOT, stdio: 'inherit' });
  console.log(`Pushed release tag ${tag}`);
}

main();
