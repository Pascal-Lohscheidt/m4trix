import path from 'node:path';
import { transformerTwoslash } from '@shikijs/twoslash';
import type { ShikiTransformer } from 'shiki';
import ts from 'typescript';
import { SNIPPETS_DIR } from './snippets';

/**
 * Twoslash (hover types, `// ^?` queries) for snippets. Compiler options come from
 * `content/snippets/tsconfig.json`, the same config `pnpm docs:snippets` typechecks with, so
 * `@m4trix/core/matrix` resolves to core's source. Server only.
 */

function snippetCompilerOptions(): ts.CompilerOptions {
  const configPath = path.join(SNIPPETS_DIR, 'tsconfig.json');
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error) {
    throw new Error(
      `Snippets tsconfig: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, SNIPPETS_DIR, undefined, configPath);
  const { baseUrl = SNIPPETS_DIR, paths = {} } = parsed.options;
  return {
    ...parsed.options,
    // Absolute paths, so resolution doesn't depend on twoslash's virtual root.
    paths: Object.fromEntries(
      Object.entries(paths).map(([key, targets]) => [
        key,
        targets.map((target) => path.resolve(baseUrl, target)),
      ]),
    ),
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    noEmit: true,
  };
}

let transformer: ShikiTransformer | undefined;

/**
 * Shared transformer: twoslash keeps one TypeScript environment per compiler options, so
 * reusing it makes every snippet after the first fast. Throws on any TypeScript error in the
 * snippet (no `// @errors` expected), which fails the page render in dev and the build.
 */
export function twoslashTransformer(): ShikiTransformer {
  transformer ??= transformerTwoslash({
    langs: ['ts', 'tsx'],
    throws: true,
    twoslashOptions: {
      compilerOptions: snippetCompilerOptions(),
      customTags: [],
    },
    rendererRich: {
      // `// ^?` results as their own line under the code instead of an overlay.
      queryRendering: 'line',
      hast: {
        // Keyboard reachable: focus shows the popup like hover does.
        hoverToken: { properties: { tabindex: 0 } },
      },
    },
  });
  return transformer;
}
