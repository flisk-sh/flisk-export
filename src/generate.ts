/**
 * Builds the text of a Render Blueprint (render.yaml) and a Cloudflare Workers config (wrangler.toml) from Flisk
 * service.json files.
 *
 * These functions only return text. Nothing here deploys, creates DNS records or calls a cloud API, and no
 * environment value is ever copied, only the names (Render asks for each value itself because of `sync: false`).
 * The one value written is the service port, which is not a secret.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Resource } from "./discover.js";
import { ExportError } from "./errors.js";

/** The resource types that serve HTTP, which is what a Render web service and a Worker are. */
export const EXPORTABLE_TYPES: readonly string[] = [
  "backend",
  "frontend",
  "agent",
  "mcp",
  "bring-your-own",
];

/** Health check path a service gets when service.json sets none (the same default the Flisk healthcheck uses). */
export const DEFAULT_HEALTH_CHECK_PATH = "/health";

/** Candidate Worker entry points, relative to the resource directory, tried in order when package.json has no main. */
export const WORKER_ENTRY_CANDIDATES: readonly string[] = [
  "src/index.ts",
  "src/index.js",
  "src/worker.ts",
  "src/worker.js",
  "index.ts",
  "index.js",
];

/** A package.json dependency that marks a resource as written for Cloudflare Workers. */
export const WORKER_DEPENDENCIES: readonly string[] = [
  "wrangler",
  "@cloudflare/workers-types",
  "hono",
];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// No wildcard: Cloudflare Custom Domains (custom_domain = true) do not accept one.
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** A name Render and Cloudflare both accept: lowercase letters, digits and dashes. */
export function deployName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "service";
}

function envKeys(resource: Resource): string[] {
  const env = resource.config.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return [];
  return Object.keys(env);
}

/** The environment variable names a service declares in service.json `env`. Values are never read out. */
export function envVarNames(resource: Resource): string[] {
  return envKeys(resource)
    .filter((name) => ENV_NAME.test(name))
    .sort();
}

/** The env names that are not valid variable names and so are left out of the export (the CLI warns about them). */
export function skippedEnvNames(resource: Resource): string[] {
  return envKeys(resource)
    .filter((name) => !ENV_NAME.test(name))
    .sort();
}

/** The port service.json declares, or undefined. */
export function servicePort(resource: Resource): number | undefined {
  const port = resource.config.port;
  const value = typeof port === "string" ? Number(port) : port;
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536
    ? value
    : undefined;
}

/** A string quoted the way both YAML and TOML read it (a JSON string is a valid double-quoted scalar in each). */
function quote(value: string): string {
  return JSON.stringify(value);
}

function relPath(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

/** A repository-relative path written with forward slashes and a leading `./`. */
function repoPath(repoRoot: string, absolute: string): string {
  const rel = relPath(repoRoot, absolute);
  return rel ? `./${rel}` : ".";
}

interface PackageJson {
  main?: string;
  scripts: Record<string, unknown>;
  dependencies: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readPackageJson(dir: string): PackageJson | null {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const pkg = parsed as Record<string, unknown>;
  return {
    main: typeof pkg.main === "string" && pkg.main ? pkg.main : undefined,
    scripts: record(pkg.scripts),
    dependencies: { ...record(pkg.devDependencies), ...record(pkg.dependencies) },
  };
}

function dockerfileOf(resource: Resource): string | null {
  const declared = resource.config.dockerfile;
  const file = join(resource.path, typeof declared === "string" ? declared : "Dockerfile");
  return existsSync(file) ? file : null;
}

/** Whether a resource is exported: it must declare one of EXPORTABLE_TYPES. A resource with no type is not. */
export function isExportable(resource: Resource): boolean {
  return resource.type !== undefined && EXPORTABLE_TYPES.includes(resource.type);
}

/** Refuses a resource that does not serve HTTP, so the export never writes a web service for a library or a job. */
export function assertExportable(resource: Resource): void {
  if (isExportable(resource)) return;
  const what = resource.type ? `a ${resource.type}` : "a resource with no appType";
  throw new ExportError(
    `Resource "${resource.name}" is ${what}, which does not serve HTTP, so it is not exported`,
    [`Exported types: ${EXPORTABLE_TYPES.join(", ")}`, "Set appType in its service.json"],
  );
}

/** Refuses two resources whose deploy names are the same, which Render would reject as one name used twice. */
export function assertUniqueDeployNames(resources: readonly Resource[]): void {
  const seen = new Map<string, string>();
  for (const resource of resources) {
    const name = deployName(resource.name);
    const other = seen.get(name);
    if (other !== undefined) {
      throw new ExportError(
        `Resources "${other}" and "${resource.name}" both become the service name "${name}"`,
        ["Rename one of them (appName in service.json)", "Or export one with --resource <name>"],
      );
    }
    seen.set(name, resource.name);
  }
}

/** One service block of a Render Blueprint, indented for the `services:` list. */
function renderService(repoRoot: string, resource: Resource): string[] {
  assertExportable(resource);
  const lines = ["  - type: web", `    name: ${quote(deployName(resource.name))}`];
  const dockerfile = dockerfileOf(resource);
  const pkg = readPackageJson(resource.path);
  if (dockerfile) {
    lines.push(
      "    runtime: docker",
      `    dockerfilePath: ${quote(repoPath(repoRoot, dockerfile))}`,
      `    dockerContext: ${quote(repoPath(repoRoot, resource.path))}`,
    );
  } else if (pkg) {
    const hasBuild = typeof pkg.scripts.build === "string";
    lines.push(
      "    runtime: node",
      `    rootDir: ${quote(relPath(repoRoot, resource.path) || ".")}`,
      `    buildCommand: ${quote(hasBuild ? "npm install && npm run build" : "npm install")}`,
      `    startCommand: ${quote("npm start")}`,
    );
  } else {
    throw new ExportError(
      `Resource "${resource.name}" has neither a Dockerfile nor a package.json, so Render has nothing to build`,
      ["Add a Dockerfile to the resource directory, or set dockerfile in service.json"],
    );
  }
  const health = resource.config.healthCheckPath;
  lines.push(
    `    healthCheckPath: ${quote(typeof health === "string" && health ? health : DEFAULT_HEALTH_CHECK_PATH)}`,
  );
  const port = servicePort(resource);
  // Render routes traffic to $PORT (10000 by default), so a service listening on its own port needs PORT set.
  const names = envVarNames(resource).filter((name) => port === undefined || name !== "PORT");
  if (port !== undefined || names.length > 0) {
    lines.push("    envVars:");
    if (port !== undefined)
      lines.push("      - key: PORT", `        value: ${quote(String(port))}`);
    for (const name of names) lines.push(`      - key: ${name}`, "        sync: false");
  }
  return lines;
}

/**
 * A Render Blueprint for the given resources. `repoRoot` is the git repository root, which Render reads every path
 * against. Every env var is listed by name with `sync: false`, never a value.
 */
export function buildRenderBlueprint(repoRoot: string, resources: readonly Resource[]): string {
  assertUniqueDeployNames(resources);
  const header = [
    "# Render Blueprint written by `flisk export render` from service.json. Nothing was deployed.",
    "# Review it, commit it at the root of the git repository, then on render.com: New -> Blueprint.",
    "# Render asks for every envVars value marked sync: false; no secret value is in this file.",
    "services:",
  ];
  const blocks = resources.flatMap((resource) => renderService(repoRoot, resource));
  return `${[...header, ...blocks].join("\n")}\n`;
}

/** The Worker entry point, relative to the resource directory. */
export function workerEntry(resource: Resource): string {
  const pkg = readPackageJson(resource.path);
  if (pkg?.main && existsSync(join(resource.path, pkg.main))) {
    return pkg.main.replace(/^\.\//, "");
  }
  const found = WORKER_ENTRY_CANDIDATES.find((candidate) =>
    existsSync(join(resource.path, candidate)),
  );
  if (!found) {
    throw new ExportError(`Resource "${resource.name}" has no Worker entry point`, [
      `Set "main" in its package.json, or add one of: ${WORKER_ENTRY_CANDIDATES.join(", ")}`,
    ]);
  }
  return found;
}

/**
 * Refuses a resource that does not look like a Cloudflare Worker: one with a Dockerfile, or one whose package.json
 * has none of WORKER_DEPENDENCIES. A Docker or Express service cannot run as a Worker, so its wrangler.toml would
 * look valid and then fail.
 */
export function assertWorkerShaped(resource: Resource): void {
  const hints = [
    "Pass --allow-non-worker if it really is a Worker",
    "Use `flisk export render` for a Docker or Node service",
  ];
  if (dockerfileOf(resource)) {
    throw new ExportError(
      `Resource "${resource.name}" has a Dockerfile, so it does not run as a Cloudflare Worker`,
      hints,
    );
  }
  const deps = readPackageJson(resource.path)?.dependencies ?? {};
  if (!WORKER_DEPENDENCIES.some((name) => name in deps)) {
    throw new ExportError(
      `Resource "${resource.name}" does not depend on ${WORKER_DEPENDENCIES.join(", ")}, so it does not look like a Cloudflare Worker`,
      hints,
    );
  }
}

/** Validates a --route value: a bare host name such as api.example.com, no scheme, port, path or wildcard. */
export function assertRouteHost(host: string): void {
  if (!HOSTNAME.test(host)) {
    const hints = host.startsWith("*.")
      ? [
          "Cloudflare Custom Domains do not accept a wildcard; name one host such as api.example.com",
        ]
      : ["Leave out https:// and any path"];
    throw new ExportError(
      `--route must be a host name such as api.example.com, got "${host}"`,
      hints,
    );
  }
}

/**
 * A wrangler.toml for one resource. `outDir` is where the file will be written, so `main` is relative to it.
 * Secrets are listed by name in a comment, for `wrangler secret put`; no value is ever written.
 */
export function buildWranglerToml(
  resource: Resource,
  outDir: string,
  options: { route?: string; now?: Date; allowNonWorker?: boolean } = {},
): string {
  assertExportable(resource);
  if (!options.allowNonWorker) assertWorkerShaped(resource);
  if (options.route) assertRouteHost(options.route);
  const entry = join(resource.path, workerEntry(resource));
  const main = relPath(outDir, entry);
  const date = (options.now ?? new Date()).toISOString().slice(0, 10);
  const lines = [
    "# Written by `flisk export wrangler` from service.json. Nothing was deployed and no DNS record was created.",
    `name = ${quote(deployName(resource.name))}`,
    `main = ${quote(main)}`,
    `compatibility_date = ${quote(date)}`,
  ];
  if (options.route) {
    lines.push("", `routes = [{ pattern = ${quote(options.route)}, custom_domain = true }]`);
  }
  const names = envVarNames(resource);
  if (names.length > 0) {
    lines.push(
      "",
      "# Environment from service.json, by name only. Set each one with `wrangler secret put <NAME>`:",
    );
    for (const name of names) lines.push(`#   ${name}`);
  }
  return `${lines.join("\n")}\n`;
}
