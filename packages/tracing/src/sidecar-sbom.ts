/**
 * CycloneDX SBOM of the npm packages bundled into the sidecar CLI.
 *
 * The CLI inlines the AWS SDK into one file, so image scanners that look for `package.json` files
 * (Trivy, Grype) cannot see those packages, and neither can `pnpm audit --prod` (the SDK is a
 * devDependency here). The sidecar build writes this list next to the bundle from esbuild's
 * metafile; the image ships it, and scanners read it like any other SBOM.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type BundledPackage = { name: string; version: string };

type Manifest = { name?: string; version?: string };

/**
 * The package directory a bundled file belongs to: the last `node_modules` segment plus the
 * package name (`@scope/name` or `name`). Nested `package.json` files (e.g. `dist-cjs/`) carry no
 * name or version, so the package root is used rather than the nearest manifest.
 */
export function packageRootOf(inputPath: string): string | undefined {
  // esbuild metafile paths always use forward slashes.
  const parts = inputPath.split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at < 0 || !parts[at + 1]) return undefined;
  const end = parts[at + 1].startsWith('@') ? at + 3 : at + 2;
  if (end > parts.length || !parts[end - 1]) return undefined;
  return parts.slice(0, end).join('/');
}

/** Every package version the inputs come from, once each, sorted by name and version. */
export function bundledPackages(
  inputs: Iterable<string>,
  readManifest: (packageRoot: string) => Manifest,
): BundledPackage[] {
  const roots = new Set<string>();
  for (const input of inputs) {
    const root = packageRootOf(input);
    if (root) roots.add(root);
  }
  const packages = new Map<string, BundledPackage>();
  for (const root of roots) {
    const { name, version } = readManifest(root);
    if (!name || !version) throw new Error(`${root}/package.json has no name or version`);
    packages.set(`${name}@${version}`, { name, version });
  }
  return [...packages.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

/** Package URL; the `@` of a scope is percent-encoded, as the purl spec requires. */
const purlOf = ({ name, version }: BundledPackage) =>
  `pkg:npm/${name.replace(/^@/, '%40')}@${version}`;

export function sidecarSbom(packages: ReadonlyArray<BundledPackage>) {
  const app = 'm4trix-tracing-sidecar';
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: { component: { type: 'application', 'bom-ref': app, name: app } },
    components: packages.map((pkg) => ({
      type: 'library',
      'bom-ref': purlOf(pkg),
      name: pkg.name,
      version: pkg.version,
      purl: purlOf(pkg),
    })),
  };
}

/** Reads an esbuild metafile and writes the SBOM; paths are relative to `cwd` (the build directory). */
export function writeSidecarSbom(options: { cwd: string; metafile: string; out: string }): void {
  const { cwd, metafile, out } = options;
  const { inputs } = JSON.parse(readFileSync(join(cwd, metafile), 'utf-8')) as {
    inputs: Record<string, unknown>;
  };
  const packages = bundledPackages(Object.keys(inputs), (root) =>
    JSON.parse(readFileSync(join(cwd, root, 'package.json'), 'utf-8')),
  );
  const outPath = join(cwd, out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(sidecarSbom(packages), null, 2)}\n`);
}
