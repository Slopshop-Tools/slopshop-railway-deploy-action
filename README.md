# slopshop-railway-deploy-action

A GitHub Action that declaratively deploys infrastructure to [Railway](https://railway.com) from a `railway-deploy.jsonc` config file.

Designed for the [slopshop](https://slopshop.tools) template ecosystem. Fork a template, add your config, push — your app is live on Railway with databases provisioned and wired up automatically.

## Usage

Add `railway-deploy.jsonc` to the root of your repo:

```jsonc
{
  "version": 1,
  "project": {
    "name": "my-app",
  },
  "databases": [{ "name": "postgres", "type": "postgres" }],
  "services": [
    {
      "name": "api",
      "root": "apps/api",
      "variables": {
        "DATABASE_URL": "${{postgres.DATABASE_URL}}",
        "NODE_ENV": "production",
      },
    },
  ],
}
```

Add a workflow to `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Railway

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Slopshop-Tools/slopshop-railway-deploy-action@main
        with:
          token: ${{ secrets.RAILWAY_API_TOKEN }}
```

Add a `RAILWAY_API_TOKEN` secret to your GitHub repo (or org). This must be an account-level token, not a project token, since the action needs to create projects.

## How It Works

The action is **idempotent** — it runs on every push and converges Railway infrastructure to match your config:

1. **Project**: Creates the Railway project if it doesn't exist (matched by name)
2. **Databases**: Creates any databases that don't exist yet (with explicit names via `-s` flag)
3. **Services**: Creates any services that don't exist yet
4. **Variables**: Sets variables on services (supports Railway's `${{service.VAR}}` reference syntax)
5. **Deploy**: Uploads and deploys each service from its `root` directory

If everything already exists, it skips creation steps and just deploys.

## Config Reference

### Version

```jsonc
"version": 1
```

Required. The action validates this and will refuse incompatible versions.

### Project

```jsonc
"project": {
  "name": "my-app"  // Used to find or create the Railway project
}
```

### Databases

```jsonc
"databases": [
  { "name": "postgres", "type": "postgres" },
  { "name": "cache", "type": "redis" }
]
```

Supported types: `postgres`, `mysql`, `redis`, `mongo`.

The `name` controls the Railway service name, which is used in variable references (e.g., `${{postgres.DATABASE_URL}}`).

### Services

```jsonc
"services": [
  {
    "name": "api",
    "root": "apps/api",
    "variables": {
      "DATABASE_URL": "${{postgres.DATABASE_URL}}",
      "NODE_ENV": "production"
    }
  }
]
```

- `name`: Service name in Railway
- `root`: Path to the service code (relative to repo root). This is the directory that gets deployed.
- `variables`: Optional. Key-value pairs set on the service. Values can use Railway's `${{service.VAR}}` syntax to reference other services.

## Action Inputs

| Input    | Required | Default                | Description                       |
| -------- | -------- | ---------------------- | --------------------------------- |
| `token`  | Yes      | —                      | Railway API token (account-level) |
| `config` | No       | `railway-deploy.jsonc` | Path to the config file           |

## Getting a Railway API Token

1. Go to [Railway](https://railway.com) and sign in
2. Go to Account Settings → Tokens
3. Create a new token (account-level, not project-level)
4. Add it as `RAILWAY_API_TOKEN` in your GitHub repo/org secrets
