# sunken-trove (m4trix monorepo)

pnpm workspace. Packages live under `packages/` (`@m4trix/*`).

- **Lint / format:** Biome (`biome.json` at repo root)
- **Build / test:** `pnpm exec turbo run build` / `pnpm test`
- **Scoped instructions:** `.claude/rules/` (path-targeted rules load when working on matching files)

Run package-specific scripts with `pnpm --filter @m4trix/<package> <script>`.
