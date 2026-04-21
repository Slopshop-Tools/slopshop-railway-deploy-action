# CLAUDE.md

## What This Is

A GitHub Action that reads a declarative `railway-deploy.jsonc` config file and idempotently converges Railway infrastructure to match. Part of the slopshop template ecosystem — provides the Railway deployment equivalent of what `wrangler deploy` does for Cloudflare Workers.

## Architecture

```
src/
├── index.ts      # GitHub Action entrypoint — reads inputs, installs CLI, runs converge
├── config.ts     # Zod schema for railway-deploy.jsonc, version validation, JSONC parsing
├── converge.ts   # Idempotent convergence: project → databases → services → variables → deploy
└── railway.ts    # Typed wrapper around Railway CLI commands (--json output parsing)
```

The action installs the Railway CLI at runtime, then uses it to check existing state and create/update what's needed.

## Development

```bash
npm install           # Install dependencies
npm run typecheck     # TypeScript strict checks
npm run lint          # ESLint (strict-boolean-expressions, import sorting, etc.)
npm run test          # Vitest
npm run build         # ncc build → bundles everything into dist/index.js
```

## Build

Uses `@vercel/ncc` to bundle all source + dependencies into a single `dist/index.js`. GitHub Actions run this file directly (no `npm install` at runtime).

`dist/` is committed to the repo. A CI workflow (`.github/workflows/build.yml`) automatically rebuilds and commits `dist/` when source files change on main.

## Testing

Tests are in `src/__tests__/`:

- `config.test.ts` — Config parsing and validation against fixture files in `fixtures/`
- `converge.test.ts` — Convergence logic with mocked Railway CLI calls

The Railway CLI wrapper (`railway.ts`) is mocked in convergence tests. Real CLI integration testing requires a Railway account and token.

## Config Schema

The config schema lives in `src/config.ts` as Zod schemas. When adding new features:

1. Add the field to the appropriate Zod schema
2. Update `converge.ts` to handle the new field
3. Add test fixtures and test cases
4. Bump the config version if the change is breaking

## TypeScript Conventions

- Strict mode with all the checks enabled (matches slopshop-template conventions)
- `exactOptionalPropertyTypes: false` (differs from some slopshop projects)
- ESLint enforces strict-boolean-expressions, import sorting, curly braces
- Husky + lint-staged runs ESLint and Prettier on commit

## Key Design Decisions

- **Idempotent by design**: Every operation checks if the resource exists before creating it. Running the action twice produces the same result.
- **Named databases**: Databases are created with explicit names via `railway add -d postgres -s my-db-name`. This makes variable references deterministic (`${{my-db-name.DATABASE_URL}}`).
- **Variables always set**: Variables are set on every run, not just on first deploy. This handles config changes without needing to detect drift.
- **Config versioned**: The `version` field allows future breaking changes without silently breaking existing repos.

## Railway CLI Notes

- `railway list --json` returns projects
- `railway status --json` returns services in the linked project
- `railway add -d postgres -s name` creates a named database service
- `railway variable set KEY=VALUE --service name` sets variables (supports `${{ref}}` syntax)
- `railway up --service name --detach` deploys without blocking

The `--json` output shapes are not well-documented by Railway. If the CLI output format changes, `railway.ts` may need updates.
