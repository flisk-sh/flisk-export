/**
 * Builds a standalone docker-compose.yml from the bring-your-own service.json files of a Flisk project.
 *
 * The result runs with plain `docker compose up` and no Flisk: no external networks, no injected Flisk variables and no
 * generated secrets. `${VAR}` references in `env` pass through for Compose to resolve from the project `.env`. These
 * functions only return text; nothing here starts a container, deploys or calls an API.
 */
import { relative, sep } from "node:path";
import type { Resource } from "./discover.js";
import { ExportError } from "./errors.js";

/** The only resource type the Compose export covers: it is the one whose service.json is a Compose service. */
export const COMPOSE_TYPE = "bring-your-own";

const RESTART_POLICIES = new Set(["no", "on-failure", "unless-stopped", "always"]);
const SERVICE_NAME = /^[a-z0-9][a-z0-9_.-]*$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHM_SIZE = /^\d+(b|k|kb|m|mb|g|gb)?$/i;

export function isComposeExportable(resource: Resource): boolean {
  return resource.type === COMPOSE_TYPE && typeof resource.config.command !== "string";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** A YAML double-quoted scalar. JSON strings are valid ones; `$` is kept so Compose can interpolate. */
function q(value: string): string {
  return JSON.stringify(value);
}

function relPath(from: string, to: string): string {
  const rel = relative(from, to).split(sep).join("/");
  return rel === "" ? "." : rel;
}

/** A host path written for a Compose file in `outDir`: `./x` for children, `../x` for parents. */
function hostPath(outDir: string, absolute: string): string {
  const rel = relPath(outDir, absolute);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function isNamedVolume(source: string): boolean {
  return !/[\\/]/.test(source) && !source.startsWith(".") && !source.startsWith("~");
}

interface Built {
  lines: string[];
  namedVolumes: Set<string>;
}

function serviceLines(resource: Resource, outDir: string, known: ReadonlySet<string>): Built {
  const c = resource.config;
  const name = resource.name;
  if (!SERVICE_NAME.test(name)) {
    throw new ExportError(`"${name}" is not a valid Compose service name`, [
      "Use letters, digits, dashes, dots and underscores",
    ]);
  }
  const lines: string[] = [`  ${name}:`];
  const namedVolumes = new Set<string>();

  const image = typeof c.image === "string" && c.image ? c.image : undefined;
  const dockerfile = typeof c.dockerfile === "string" && c.dockerfile ? c.dockerfile : undefined;
  const buildContext = typeof c.buildContext === "string" ? c.buildContext : undefined;
  if (image) lines.push(`    image: ${q(image)}`);
  if (dockerfile || !image) {
    const context = hostPath(outDir, resolveFrom(resource.path, buildContext ?? "."));
    lines.push("    build:", `      context: ${q(context)}`);
    if (dockerfile) lines.push(`      dockerfile: ${q(dockerfile)}`);
  }

  const container = record(c.container);
  if (container.init !== false) lines.push("    init: true");
  if (typeof c.restart === "string") {
    if (!RESTART_POLICIES.has(c.restart)) {
      throw new ExportError(`${name}: restart "${c.restart}" is not a Compose restart policy`);
    }
    lines.push(`    restart: ${q(c.restart)}`);
  } else {
    lines.push('    restart: "unless-stopped"');
  }

  const sidecarOf = typeof c.sidecarOf === "string" ? c.sidecarOf : undefined;
  if (sidecarOf) {
    if (!known.has(sidecarOf)) {
      throw new ExportError(`${name}: sidecarOf "${sidecarOf}" is not a bring-your-own resource`);
    }
    lines.push(`    network_mode: ${q(`service:${sidecarOf}`)}`);
  }

  const env = record(c.env);
  const envNames = Object.keys(env)
    .filter((k) => ENV_NAME.test(k))
    .sort();
  if (envNames.length > 0) {
    lines.push("    environment:");
    for (const key of envNames) lines.push(`      ${key}: ${q(String(env[key]))}`);
  }

  const volumes = Array.isArray(c.volumes) ? c.volumes : [];
  if (volumes.length > 0) {
    lines.push("    volumes:");
    for (const raw of volumes) {
      const v = record(raw);
      if (typeof v.source !== "string" || typeof v.target !== "string") {
        throw new ExportError(`${name}: a volume needs a source and a target`);
      }
      let source = v.source;
      if (isNamedVolume(source)) {
        namedVolumes.add(source);
      } else {
        source = hostPath(outDir, resolveFrom(resource.path, source));
      }
      lines.push(`      - ${q(`${source}:${v.target}${v.readOnly === true ? ":ro" : ""}`)}`);
    }
  }

  const ports = Array.isArray(c.extraPorts) ? c.extraPorts : [];
  if (ports.length > 0) {
    if (sidecarOf) {
      throw new ExportError(
        `${name}: a sidecar shares another service's network and cannot publish ports`,
      );
    }
    lines.push("    ports:");
    for (const raw of ports) {
      const p = record(raw);
      const port = Number(p.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ExportError(`${name}: extraPorts needs a port from 1 to 65535`);
      }
      const hostPort = p.hostPort === undefined ? port : Number(p.hostPort);
      const bind = typeof p.bind === "string" && p.bind ? p.bind : "127.0.0.1";
      const protocol = p.protocol === "udp" ? "udp" : "tcp";
      lines.push(`      - ${q(`${bind}:${hostPort}:${port}/${protocol}`)}`);
    }
  }

  const dependsOn = strings(c.dependsOn).filter((d) => known.has(d));
  if (dependsOn.length > 0) {
    lines.push("    depends_on:", ...dependsOn.map((d) => `      - ${q(d)}`));
  }

  const capAdd = strings(container.capAdd);
  const capDrop = strings(container.capDrop);
  const securityOpt = strings(container.securityOpt);
  if (capAdd.length > 0) lines.push("    cap_add:", ...capAdd.map((v) => `      - ${q(v)}`));
  if (capDrop.length > 0) lines.push("    cap_drop:", ...capDrop.map((v) => `      - ${q(v)}`));
  if (container.readOnly === true) lines.push("    read_only: true");
  if (typeof container.user === "string") lines.push(`    user: ${q(container.user)}`);
  if (securityOpt.length > 0) {
    lines.push("    security_opt:", ...securityOpt.map((v) => `      - ${q(v)}`));
  }
  if (typeof container.shmSize === "string") {
    if (!SHM_SIZE.test(container.shmSize)) {
      throw new ExportError(`${name}: shmSize "${container.shmSize}" is not a Compose size`);
    }
    lines.push(`    shm_size: ${q(container.shmSize)}`);
  }
  return { lines, namedVolumes };
}

function resolveFrom(base: string, rel: string): string {
  return rel.startsWith("/") ? rel : joinPosix(base, rel);
}

function joinPosix(base: string, rel: string): string {
  const parts = base.split(sep).concat(rel.split("/"));
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return (base.startsWith("/") ? "/" : "") + out.join("/");
}

/** The text of a docker-compose.yml for `resources`, written for a file in `outDir`. */
export function buildCompose(outDir: string, resources: readonly Resource[]): string {
  const services = resources.filter(isComposeExportable);
  if (services.length === 0) {
    throw new ExportError("No bring-your-own resource was found to export", [
      `Exported type: ${COMPOSE_TYPE} (a service.json with an image or a Dockerfile, and no command)`,
    ]);
  }
  const known = new Set(services.map((s) => s.name));
  const body: string[] = [];
  const volumes = new Set<string>();
  for (const service of services) {
    const built = serviceLines(service, outDir, known);
    body.push(...built.lines, "");
    for (const v of built.namedVolumes) volumes.add(v);
  }
  const header = [
    "###############################################################################",
    "# GENERATED by `flisk export compose` from the service.json files. DO NOT EDIT.",
    "# Change service.json and run `flisk export compose --force`; CI can run",
    "# `flisk export compose --check` to fail when this file is out of date.",
    "# Runs with plain `docker compose up`; Flisk is not needed to start it.",
    "###############################################################################",
    "",
    "services:",
  ];
  const tail =
    volumes.size > 0 ? ["volumes:", ...[...volumes].sort().map((v) => `  ${v}:`), ""] : [];
  return [...header, ...body, ...tail].join("\n").replace(/\n{3,}/g, "\n\n");
}
