// API report of @m4trix/core's public surface (one per entry point), made with
// @microsoft/api-extractor from the built declaration files (run `pnpm build` first).
//
//   node scripts/api-report.mjs          check: fails when the surface differs from api/*.api.md
//   node scripts/api-report.mjs --update  rewrite api/*.api.md with the current surface
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Extractor, ExtractorConfig } from '@microsoft/api-extractor';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const update = process.argv.includes('--update');

/** Entry points of the `exports` map, by report name. */
const entries = {
  core: 'dist/index.d.ts',
  'core-matrix': 'dist/matrix/index.d.ts',
  'core-testing': 'dist/testing/index.d.ts',
};

const reportFolder = join(packageDir, 'api');
const tempFolder = mkdtempSync(join(tmpdir(), 'm4trix-core-api-'));
mkdirSync(reportFolder, { recursive: true });

let failed = false;
try {
  for (const [name, entry] of Object.entries(entries)) {
    const config = ExtractorConfig.prepare({
      configObject: {
        projectFolder: packageDir,
        mainEntryPointFilePath: join(packageDir, entry),
        compiler: { tsconfigFilePath: join(packageDir, 'tsconfig.json') },
        apiReport: {
          enabled: true,
          reportFileName: `${name}.api.md`,
          reportFolder,
          reportTempFolder: tempFolder,
        },
        docModel: { enabled: false },
        dtsRollup: { enabled: false },
        tsdocMetadata: { enabled: false },
        messages: {
          compilerMessageReporting: { default: { logLevel: 'warning' } },
          extractorMessageReporting: {
            default: { logLevel: 'warning' },
            // Release tags (@public/@beta) are not used; unexported referenced types are listed
            // in the report as they are.
            'ae-missing-release-tag': { logLevel: 'none' },
            'ae-forgotten-export': { logLevel: 'none', addToApiReportFile: false },
            'ae-internal-missing-underscore': { logLevel: 'none' },
            'ae-unresolved-link': { logLevel: 'none' },
            'ae-undocumented': { logLevel: 'none', addToApiReportFile: false },
          },
          tsdocMessageReporting: { default: { logLevel: 'none' } },
        },
      },
      configObjectFullPath: join(packageDir, 'api-extractor.json'),
      packageJsonFullPath: join(packageDir, 'package.json'),
    });
    const result = Extractor.invoke(config, {
      localBuild: update,
      showVerboseMessages: false,
      messageCallback: (message) => {
        // Our own summary below replaces api-extractor's note about the temp report file.
        if (message.messageId === 'console-api-report-changed') message.handled = true;
      },
    });
    if (!result.succeeded) {
      failed = true;
      if (!update) {
        // What changed, as a diff of the committed report against the current surface.
        spawnSync(
          'diff',
          ['-u', join(reportFolder, `${name}.api.md`), join(tempFolder, `${name}.api.md`)],
          {
            stdio: 'inherit',
          },
        );
      }
      console.error(
        `${name}: the public API changed (${result.errorCount} errors, ${result.warningCount} warnings).` +
          (update ? '' : ' Run `pnpm --filter @m4trix/core api:update` and commit api/*.api.md.'),
      );
    } else if (result.apiReportChanged) {
      console.log(`${name}: api/${name}.api.md updated`);
    } else {
      console.log(`${name}: unchanged`);
    }
  }
} finally {
  rmSync(tempFolder, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
