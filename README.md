# flisk-export

Write a Render Blueprint (`render.yaml`) or a Cloudflare `wrangler.toml` from the `service.json` files of a [Flisk](https://github.com/flisk-sh/flisk) project.

It writes files only. It never deploys, never creates DNS records, never calls a cloud API, and writes environment variable **names**, never values. The Flisk CLI runs it at a pinned version as `flisk export`.

## Use

```sh
npx @flisk-sh/flisk-export render [dir] [--resource <name>] [--out <dir>] [--dry-run] [--force]
npx @flisk-sh/flisk-export wrangler [dir] --resource <name> [--route <host>] [--out <dir>] [--allow-non-worker] [--dry-run] [--force]
```

Or, from a Flisk project: `flisk export render --dry-run`.

### render

- Exports every resource whose `appType` is `backend`, `frontend`, `agent`, `mcp` or `bring-your-own` (a resource with no `appType` is not exported), or one with `--resource`.
- A resource with a Dockerfile becomes `runtime: docker`; one with a `package.json` becomes `runtime: node`.
- The `service.json` `port` is written as `PORT`, because Render routes traffic to `$PORT`.
- Every other env name is written with `sync: false`, so Render asks for the value. Names that are not valid variable names are left out with a warning.
- `healthCheckPath` comes from `service.json` (default `/health`).
- Paths are relative to the **git repository root**, which is where Render reads them, and the file is written there by default. `--out` moves the file but not the paths.
- Two resources that become the same service name (`api_v1` and `api-v1`) are refused.

### wrangler

- One resource. `main` comes from `package.json` `main`, or the first of `src/index.ts`, `src/index.js`, `src/worker.ts`, `src/worker.js`, `index.ts`, `index.js`.
- A resource with a Dockerfile, or without a `wrangler`, `@cloudflare/workers-types` or `hono` dependency, is refused unless `--allow-non-worker`.
- `--route api.example.com` writes a Custom Domain route. Wildcards are refused: Custom Domains do not accept them.
- Env names are listed in a comment for `wrangler secret put`.

## Develop

```sh
npm install
npm run typecheck && npm run lint && npm run build && npm test
```

## License

MIT
