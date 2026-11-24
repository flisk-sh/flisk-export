/**
 * Builds the text of a Render Blueprint (render.yaml) and a Cloudflare Workers config (wrangler.toml) from Flisk
 * service.json files.
 *
 * These functions only return text. Nothing here deploys, creates DNS records or calls a cloud API, and no
 * environment value is ever copied, only the names (Render asks for each value itself because of `sync: false`).
 * The one value written is the service port, which is not a secret.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
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

/**
 * The appTypes that hold data and never serve HTTP, so they are left out of a Blueprint. A service that names one
 * in dependsOn still reads its connection string from the environment, which is why the Blueprint lists
 * DATABASE_URL for it.
 */
const DATA_RESOURCE_TYPES: readonly string[] = ["database", "migrator"];

/**
 * The dependsOn names that mean the shared platform Postgres even when the project declares no `database`
 * resource, the same names the Flisk CLI accepts in shared-platform-postgres.ts.
 */
const SHARED_POSTGRES_NAMES: readonly string[] = ["postgres", "database-management"];

/** The manual step a skipped appType needs on Render, when Render has a place for it at all. */
const SKIPPED_TYPE_ADVICE: Record<string, string> = {
  database: "add a Render Postgres (databases:) and set DATABASE_URL on the services that read it",
  migrator: "run it as a preDeployCommand or a one-off job",
  worker: "add it as a Render background worker (type: worker)",
};

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

/** The name of one dependsOn entry: the string itself, or `name` of a `{ name, condition }` object. */
function dependsOnEntryName(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const name = (entry as { name?: unknown }).name;
    if (typeof name === "string" && name !== "") return name;
  }
  return null;
}

/** Every dependency name a service declares: `dependsOn`, plus the deprecated `dependencies` spelling. */
export function dependsOnNames(config: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const key of ["dependsOn", "dependencies"] as const) {
    const value = config[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const name = dependsOnEntryName(entry);
      if (name !== null) names.push(name);
    }
  }
  return [...new Set(names)];
}

/** The names of the project's data resources, which a service can name in dependsOn. */
function dataResourceNames(resources: readonly Resource[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const resource of resources) {
    if (resource.type !== undefined && DATA_RESOURCE_TYPES.includes(resource.type)) {
      names.add(resource.name);
    }
  }
  return names;
}

/**
 * True when the service names a data resource or the shared Postgres in dependsOn, which is when the Flisk runtime
 * hands it DATABASE_URL. The Blueprint lists the name so Render asks for the value; nothing here derives a URL.
 */
function readsDatabaseUrl(resource: Resource, dataNames: ReadonlySet<string>): boolean {
  return dependsOnNames(resource.config).some(
    (name) => dataNames.has(name) || SHARED_POSTGRES_NAMES.includes(name),
  );
}

/**
 * What to tell the user about a resource the export leaves out: the step still needed on Render, or why there is
 * none. A resource with no appType is told to set one first.
 */
export function skippedResourceAdvice(resource: Resource): string {
  if (resource.type === undefined) {
    return "set appType in its service.json; only resources that serve HTTP are exported";
  }
  return SKIPPED_TYPE_ADVICE[resource.type] ?? "it does not serve HTTP, so it is not exported";
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
  packageManager?: string;
  engines?: Record<string, unknown>;
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
    packageManager: typeof pkg.packageManager === "string" ? pkg.packageManager : undefined,
    engines: record(pkg.engines),
    scripts: record(pkg.scripts),
    dependencies: { ...record(pkg.devDependencies), ...record(pkg.dependencies) },
  };
}

function dockerBuildOf(resource: Resource): { context: string; dockerfile: string } | null {
  const { buildContext, dockerfile: declared } = resource.config;
  const context = resolve(resource.path, typeof buildContext === "string" ? buildContext : ".");
  const dockerfile = resolve(context, typeof declared === "string" ? declared : "Dockerfile");
  return existsSync(dockerfile) ? { context, dockerfile } : null;
}

/** The prebuilt image in service.json, when it names one as a string. */
function imageOf(resource: Resource): string | undefined {
  const image = resource.config.image;
  return typeof image === "string" && image.trim() ? image : undefined;
}

/**
 * A Blueprint has no shell or Compose interpolation, so an image with `${VAR}` cannot be pulled. Fail before writing
 * a URL Render would reject, naming the image so the user can see which variable is still unresolved.
 */
function assertResolvableImage(resource: Resource, image: string): void {
  if (!image.includes("${")) return;
  throw new ExportError(
    `Resource "${resource.name}" image ${quote(image)} still has Compose variables, which a Render Blueprint cannot resolve`,
    [
      "Set image in service.json to a literal image reference, such as nginx:1.27",
      "Or export this resource after its image has been resolved to a fixed version",
    ],
  );
}

/** Whether a resource is exported: it must declare one of EXPORTABLE_TYPES. A resource with no type is not. */
export function isExportable(resource: Resource): boolean {
  return resource.type !== undefined && EXPORTABLE_TYPES.includes(resource.type);
}

/** Refuses a resource that does not serve HTTP, so the export never writes a web service for a library or a job. */
export function assertExportable(resource: Resource): void {
  if (isExportable(resource)) return;
  const what = resource.type ? `a ${resource.type}` : "a resource with no appType";
  const hints = [`Exported types: ${EXPORTABLE_TYPES.join(", ")}`];
  const advice =
    resource.type === undefined
      ? "Set appType in its service.json"
      : SKIPPED_TYPE_ADVICE[resource.type];
  if (advice !== undefined) hints.push(`${advice.charAt(0).toUpperCase()}${advice.slice(1)}`);
  throw new ExportError(
    `Resource "${resource.name}" is ${what}, which does not serve HTTP, so it is not exported`,
    hints,
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

function detectBun(dir: string, pkg: PackageJson): string | null {
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) {
    return extractBunVersion(pkg) ?? "1.3";
  }
  if (pkg.packageManager?.startsWith("bun")) {
    return extractBunVersion(pkg) ?? "1.3";
  }
  const startScript = typeof pkg.scripts.start === "string" ? pkg.scripts.start : "";
  if (/^bun\b/.test(startScript.trim())) {
    return extractBunVersion(pkg) ?? "1.3";
  }
  return null;
}

function extractBunVersion(pkg: PackageJson): string | null {
  if (typeof pkg.packageManager === "string" && pkg.packageManager.startsWith("bun@")) {
    const ver = pkg.packageManager.slice(4).trim();
    if (ver) return ver;
  }
  const engineBun = pkg.engines?.bun;
  if (typeof engineBun === "string") {
    const cleaned = engineBun.replace(/^[^\d]*/, "").trim();
    if (cleaned) return cleaned;
  }
  return null;
}

/** One service block of a Render Blueprint, indented for the `services:` list. */
function renderService(
  repoRoot: string,
  resource: Resource,
  dataNames: ReadonlySet<string>,
): string[] {
  assertExportable(resource);
  const lines = ["  - type: web", `    name: ${quote(deployName(resource.name))}`];
  const docker = dockerBuildOf(resource);
  const pkg = readPackageJson(resource.path);
  const image = imageOf(resource);
  let bunVersion: string | null = null;
  let isStatic = false;
  if (docker) {
    lines.push(
      "    runtime: docker",
      `    dockerfilePath: ${quote(repoPath(repoRoot, docker.dockerfile))}`,
      `    dockerContext: ${quote(repoPath(repoRoot, docker.context))}`,
    );
  } else if (pkg) {
    const hasBuild = typeof pkg.scripts.build === "string";
    const hasStart = typeof pkg.scripts.start === "string";
    if (resource.type === "frontend" && !hasStart) {
      isStatic = true;
      lines.push(
        "    runtime: static",
        `    rootDir: ${quote(relPath(repoRoot, resource.path) || ".")}`,
        `    buildCommand: ${quote(hasBuild ? "npm install && npm run build" : "npm install")}`,
        `    staticPublishPath: ${quote("dist")}`,
      );
    } else if (!hasStart) {
      throw new ExportError(`Resource "${resource.name}" has no start script`, [
        "Add a start script to package.json, add a Dockerfile to the resource directory, or export one resource with --resource",
      ]);
    } else {
      bunVersion = detectBun(resource.path, pkg);
      const buildCmd = bunVersion
        ? hasBuild
          ? "bun install && bun run build"
          : "bun install"
        : hasBuild
          ? "npm install && npm run build"
          : "npm install";
      lines.push(
        "    runtime: node",
        `    rootDir: ${quote(relPath(repoRoot, resource.path) || ".")}`,
        `    buildCommand: ${quote(buildCmd)}`,
        `    startCommand: ${quote(bunVersion ? "bun run start" : "npm start")}`,
      );
    }
  } else if (image !== undefined) {
    assertResolvableImage(resource, image);
    lines.push("    runtime: image", "    image:", `      url: ${quote(image)}`);
  } else {
    throw new ExportError(
      `Resource "${resource.name}" has neither a Dockerfile, a package.json nor an image, so Render has nothing to build`,
      [
        "Add a Dockerfile to the resource directory, or set dockerfile in service.json",
        "Or set image in service.json to a prebuilt image reference for runtime: image",
      ],
    );
  }
  if (!isStatic) {
    const health = resource.config.healthCheckPath;
    lines.push(
      `    healthCheckPath: ${quote(typeof health === "string" && health ? health : DEFAULT_HEALTH_CHECK_PATH)}`,
    );
  }
  const port = isStatic ? undefined : servicePort(resource);
  // Render routes traffic to $PORT (10000 by default), so a service listening on its own port needs PORT set.
  const names = envVarNames(resource).filter(
    (name) => (port === undefined || name !== "PORT") && (!bunVersion || name !== "BUN_VERSION"),
  );
  if (readsDatabaseUrl(resource, dataNames) && !names.includes("DATABASE_URL")) {
    names.push("DATABASE_URL");
    names.sort((a, b) => a.localeCompare(b));
  }
  const hasEnvVars = port !== undefined || bunVersion !== null || names.length > 0;
  if (hasEnvVars) {
    lines.push("    envVars:");
    if (bunVersion !== null)
      lines.push("      - key: BUN_VERSION", `        value: ${quote(bunVersion)}`);
    if (port !== undefined)
      lines.push("      - key: PORT", `        value: ${quote(String(port))}`);
    for (const name of names) lines.push(`      - key: ${name}`, "        sync: false");
  }
  return lines;
}

/**
 * A Render Blueprint for the given resources. `repoRoot` is the git repository root, which Render reads every path
 * against. Every env var is listed by name with `sync: false`, never a value. `catalog` is every discovered
 * resource, exported or not, so a dependsOn on a database or migrator adds the DATABASE_URL name the service reads
 * locally; it defaults to `resources` for callers that already filtered.
 */
export function buildRenderBlueprint(
  repoRoot: string,
  resources: readonly Resource[],
  catalog: readonly Resource[] = resources,
): string {
  assertUniqueDeployNames(resources);
  const dataNames = dataResourceNames(catalog);
  const header = [
    "# Render Blueprint written by `flisk export render` from service.json. Nothing was deployed.",
    "# Review it, commit it at the root of the git repository, then on render.com: New -> Blueprint.",
    "# Render asks for every envVars value marked sync: false; no secret value is in this file.",
    "services:",
  ];
  const blocks = resources.flatMap((resource) => renderService(repoRoot, resource, dataNames));
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
  if (dockerBuildOf(resource)) {
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
