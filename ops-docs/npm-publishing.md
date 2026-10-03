# npm publishing

How `@m4trix/*` packages get released, how npm authentication is set up, and what to do when a
release fails.

## Release flow

Releases are fully automated on pushes to `main` (`.circleci/config.yml`, workflow
`test-and-build`). Versions are derived from conventional commits; git tags are the source of
truth, `package.json` versions are never committed.

```text
test ─┐
audit ┴─> build ─> publish-core, publish-evals, publish-stream, publish-react, publish-ui
                   publish-tracing ─> publish-trace-viewer
                                   └> publish-tracing-sidecar (GHCR image)
```

Each `publish-<scope>` job runs, in order:

1. **Check scope** — `scripts/check-package-scope.ts <scope>`: halts the job when nothing under
   `packages/<scope>/` changed since the last `@m4trix/<scope>@*` tag.
2. **Bump** — `scripts/bump-and-tag.ts <scope>`: computes the next version from commits touching
   the package since the last tag (`feat` → minor, `fix`/`perf` → patch, `!`/`BREAKING CHANGE` →
   major, which is a minor bump while pre-1.0; anything else → patch), writes it into
   `package.json` and creates the tag **locally only**.
3. **Build** the package.
4. **Trusted publishing** — the `npm-trusted-publishing` command fetches a CircleCI OIDC token.
5. **Publish** — `npm publish` (via `pnpm run <scope>:publish` → turbo → `publish-package`).
6. **Push the tag** — `scripts/push-release-tag.ts <scope>`, only after the publish succeeded.

Pushing the tag last matters: the scope check compares against the newest tag, so a tag without a
published version would make every later run skip that release.

The audit job (`scripts/audit-deployed-packages.ts`) blocks the build only on high/critical
advisories in **production** dependencies of published packages; devDependencies, `website/` and
`examples/` are ignored. Transient registry errors are retried; if no report can be fetched the
job fails with exit code 2 ("re-run the job").

## Authentication: npm trusted publishing (OIDC)

There is **no npm token** in CI. Publish jobs authenticate with
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers) using CircleCI OIDC:

- `npm-trusted-publishing` installs npm ≥ 11.5.1, runs
  `circleci run oidc get --claims '{"aud": "npm:registry.npmjs.org"}'` and exports the result as
  `NPM_ID_TOKEN`. During `npm publish`, npm exchanges it for a short-lived publish token.
- Publish jobs run on `cimg/node:22.23.3` (trusted publishing needs Node ≥ 22.14).
- `turbo.json` lists `NPM_ID_TOKEN` **and `CIRCLECI`** in `passThroughEnv` for every
  `*#publish-package` task. Turbo runs in strict env mode and would otherwise drop both: npm only
  attempts the OIDC exchange when it detects CircleCI via the `CIRCLECI` variable (`ci-info`);
  without it `npm publish` fails with `ENEEDAUTH`. Publish tasks also set `"cache": false` so a
  cache hit can never skip a real publish.
- npm does not generate provenance attestations for CircleCI publishes (only for GitHub Actions).

### CircleCI identifiers

These are not secrets; they identify which pipeline npm trusts.

| Field | Value | Where to find it |
| --- | --- | --- |
| Organization ID | `6c5bad79-40e6-4cc6-ad52-dfed0fef5099` | CircleCI → Organization Settings → Overview |
| Project ID | `9f47e90c-eac1-47ae-8785-d4be250ff083` | Project Settings → Overview |
| Pipeline definition ID | `f9ce7b70-176e-5f93-8bb9-4fdc754112b6` | Project Settings → Project Setup |
| VCS origin | `github.com/Pascal-Lohscheidt/m4trix` | — |
| Context ID (optional) | UUID of the `NPM` context | Organization Settings → Contexts → `NPM` (in the URL) |

### Configuring trusted publishers

Every published package needs a CircleCI trusted publisher on npmjs.com. Use the CLI
(`npm trust`, npm ≥ 11.15.0) from a maintainer machine. Requirements:

- logged in to npm as a maintainer of the package, with account-level 2FA enabled (you may be
  prompted for an OTP per package);
- npm 11 when running on Node 20 (npm 12 requires Node ≥ 22.22) — hence `npx -y npm@11`.

```bash
npx -y npm@11 whoami || npx -y npm@11 login

for pkg in core evals stream react tracing trace-viewer ui; do
  echo "== @m4trix/$pkg"
  npx -y npm@11 trust circleci "@m4trix/$pkg" \
    --org-id 6c5bad79-40e6-4cc6-ad52-dfed0fef5099 \
    --project-id 9f47e90c-eac1-47ae-8785-d4be250ff083 \
    --pipeline-definition-id f9ce7b70-176e-5f93-8bb9-4fdc754112b6 \
    --vcs-origin github.com/Pascal-Lohscheidt/m4trix \
    --allow-publish --yes
done
```

Add `--context-id <uuid>` to restrict publishing to jobs that use the `NPM` context (all publish
jobs do). The same settings are visible/editable per package on npmjs.com under
**Settings → Trusted Publisher**.

After the first successful OIDC release:

1. Revoke the old npm automation/granular tokens.
2. Remove `NPM_TOKEN` from the CircleCI `NPM` context (nothing reads it anymore).
3. Optionally set each package to **Require 2FA and disallow tokens** — trusted publishing keeps
   working with that setting.

## Adding a new published package

1. Add the scope to the maps in `scripts/changelog-config.ts`, `scripts/bump-and-tag.ts` and
   `scripts/check-package-scope.ts`, plus `release:*` / `<scope>:build` / `<scope>:publish`
   scripts in the root `package.json`.
2. Add `<pkg>#build` and `<pkg>#publish-package` tasks to `turbo.json`; the publish task needs
   `"cache": false` and `"passThroughEnv": ["NPM_ID_TOKEN", "CIRCLECI"]`.
3. Add a `publish-<scope>` job (copy an existing one, including `npm-trusted-publishing` and
   `push-release-tag`) and wire it into the workflow.
4. Trusted publishers can only be configured for packages that already exist on npm. Publish the
   first version manually from a maintainer machine (`npm publish --access public` in the package
   directory), push a matching `@m4trix/<scope>@<version>` tag, then run the `npm trust circleci`
   command above for the new package.

## Troubleshooting

### `npm publish` fails with ENEEDAUTH ("requires you to be logged in")

npm did not attempt trusted publishing. Either `CIRCLECI` or `NPM_ID_TOKEN` did not reach the
`npm publish` process (check `passThroughEnv` in `turbo.json` — turbo's strict env mode drops
undeclared variables), or the job's npm is older than 11.5.1.

### `npm publish` fails with E404 / E401

npm reports missing publish rights as **404** for scoped packages. Check that the package has a
CircleCI trusted publisher with the IDs above (a wrong pipeline definition ID or VCS origin is the
usual culprit). Because the tag is pushed only after a successful publish, a failed job leaves
nothing behind — fix the trusted publisher and **re-run the workflow from failed**.

### `could not obtain a CircleCI OIDC token`

`circleci run oidc get` only works on CircleCI cloud. Check the job runs on cloud resources (not a
self-hosted runner) and that the CLI in the image is current.

### A tag exists but the version is not on npm

Happened with the old pipeline, which pushed tags before publishing. The next run will skip the
package. Compare and, if needed, delete the orphan tag so the next run re-bumps the same version:

```bash
npm view @m4trix/<scope> version               # what npm has
git fetch --tags && git tag -l '@m4trix/<scope>@*' --sort=-version:refname | head -3

git push origin --delete '@m4trix/<scope>@<version>'
git tag -d '@m4trix/<scope>@<version>'
```

Then push to `main` or re-run the workflow.

### Version published but the tag push failed

npm has the version, git does not. The next run would try to publish the same version again and
fail with "cannot publish over the previously published version". Create and push the tag
manually on the commit that was released:

```bash
git tag '@m4trix/<scope>@<version>' <released-commit-sha>
git push origin '@m4trix/<scope>@<version>'
```
