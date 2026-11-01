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

/** extraPorts `publish`: digits, dots, colons and `${NAME:-default}` / `${NAME-default}`, as flisk core accepts it (flisk#2947). */
const PUBLISH = /^(?:[0-9.:]|\$\{[A-Za-z_][A-Za-z0-9_]*:?-[0-9.:]+\})+$/;
/** An image reference, with Compose variables `${NAME}`, `${NAME:-default}` and `${NAME-default}` kept for Compose to resolve. */
const IMAGE = /^(?:[A-Za-z0-9._/:@-]|\$\{[A-Za-z_][A-Za-z0-9_]*(?::?-[A-Za-z0-9._/:@-]*)?\})+$/;

/** The only resource type the Compose export covers: it is the one whose service.json is a Compose service. */
export const COMPOSE_TYPE = "bring-your-own";

const RESTART_POLICIES = new Set(["no", "on-failure", "unless-stopped", "always"]);
/** `on-failure:N` with a retry limit from 1 to 100. */
const RESTART_LIMIT = /^on-failure:([1-9][0-9]?|100)$/;
/** A Compose duration such as 30s, 1m30s or 500ms. */
const DURATION = /^(?:[0-9]+(?:\.[0-9]+)?(?:h|ms|us|m|s))+$/;
/** A DNS name: letters, digits, '-', '_' and '.'. */
const DNS_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/;
/** An extra_hosts address: host-gateway, IPv4, or IPv6 (optionally in brackets). */
const HOST_ADDRESS =
  /^(?:host-gateway|[0-9]{1,3}(?:\.[0-9]{1,3}){3}|\[?[0-9A-Fa-f.]*:[0-9A-Fa-f.]*:[0-9A-Fa-f:.]*\]?)$/;
const ULIMIT_NAME = /^[a-z]+$/;
const SERVICE_NAME = /^[a-z0-9][a-z0-9_.-]*$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHM_SIZE = /^\d+(b|k|kb|m|mb|g|gb)?$/i;
const TMPFS = /^\/[A-Za-z0-9_./-]*(:[a-z0-9=,_-]+)?$/;
const CPUS = /^[0-9]+(\.[0-9]{1,2})?$/;
const MEMORY = /^[0-9]+([bBkKmMgG][bB]?)?$/;
const PROFILE = /^[a-z0-9][a-z0-9-]*$/;
const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

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
  /** Named volumes, with the Docker name service.json gives each one (or undefined). */
  namedVolumes: Map<string, string | undefined>;
  models: Map<string, string>;
}

function serviceLines(
  resource: Resource,
  outDir: string,
  services: ReadonlyMap<string, Resource>,
): Built {
  const known = services;
  const c = resource.config;
  const name = resource.name;
  if (!SERVICE_NAME.test(name)) {
    throw new ExportError(`"${name}" is not a valid Compose service name`, [
      "Use letters, digits, dashes, dots and underscores",
    ]);
  }
  const lines: string[] = [`  ${name}:`];
  const namedVolumes = new Map<string, string | undefined>();
  const models = new Map<string, string>();

  const image = typeof c.image === "string" && c.image ? c.image : undefined;
  const dockerfile = typeof c.dockerfile === "string" && c.dockerfile ? c.dockerfile : undefined;
  const buildContext = typeof c.buildContext === "string" ? c.buildContext : undefined;
  if (image && !IMAGE.test(image)) {
    throw new ExportError(`${name}: image "${image}" is not an image reference`, [
      "Use letters, digits, . _ / : @ - and Compose variables ${NAME}, ${NAME:-default} or ${NAME-default}",
    ]);
  }
  if (image) lines.push(`    image: ${q(image)}`);
  if (dockerfile || !image) {
    const context = hostPath(outDir, resolveFrom(resource.path, buildContext ?? "."));
    lines.push("    build:", `      context: ${q(context)}`);
    if (dockerfile) lines.push(`      dockerfile: ${q(dockerfile)}`);
  }

  const container = record(c.container);
  if (container.init !== false) lines.push("    init: true");
  if (typeof c.restart === "string") {
    if (!RESTART_POLICIES.has(c.restart) && !RESTART_LIMIT.test(c.restart)) {
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
  // Every exported service is on the default network, so its aliases go there. A sidecar has no network of its own.
  const aliases = strings(container.networkAliases);
  for (const alias of aliases) {
    if (!DNS_NAME.test(alias)) {
      throw new ExportError(`${name}: network alias "${alias}" is not a DNS name`, [
        "Use letters, digits, '-', '_' and '.'",
      ]);
    }
  }
  if (aliases.length > 0 && !sidecarOf) {
    lines.push(
      "    networks:",
      "      default:",
      "        aliases:",
      ...aliases.map((a) => `          - ${q(a)}`),
    );
  }

  const env = record(c.env);
  // Secrets are listed by name only in service.json; Compose reads their values from the project .env.
  const values = new Map<string, string>();
  for (const key of strings(record(c.secrets).required)) values.set(key, `\${${key}}`);
  for (const [key, value] of Object.entries(env)) values.set(key, String(value));
  const envNames = [...values.keys()].filter((k) => ENV_NAME.test(k)).sort();
  if (envNames.length > 0) {
    lines.push("    environment:");
    for (const key of envNames) lines.push(`      ${key}: ${q(values.get(key) ?? "")}`);
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
        const dockerName = typeof v.name === "string" ? v.name : undefined;
        if (dockerName !== undefined && !DOCKER_NAME.test(dockerName)) {
          throw new ExportError(`${name}: volume name "${dockerName}" is not a Docker volume name`);
        }
        namedVolumes.set(source, dockerName ?? namedVolumes.get(source));
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
      const protocol = p.protocol === "udp" ? "udp" : "tcp";
      // `publish` (flisk#2947): the host side as the project's Compose wrote it, e.g. "${APP_HTTP_BIND:-80}"; Compose resolves it.
      if (p.publish !== undefined) {
        if (typeof p.publish !== "string" || !PUBLISH.test(p.publish)) {
          throw new ExportError(
            `${name}: extraPorts publish must be a port, an IPv4 address:port, or \${NAME:-default}`,
          );
        }
        lines.push(`      - ${q(`${p.publish}:${port}/${protocol}`)}`);
        continue;
      }
      const hostPort = p.hostPort === undefined ? port : Number(p.hostPort);
      const bind = p.bind === undefined ? "127.0.0.1" : p.bind;
      if (bind !== "127.0.0.1" && bind !== "0.0.0.0") {
        throw new ExportError(`${name}: extraPorts bind must be 127.0.0.1 or 0.0.0.0`);
      }
      lines.push(`      - ${q(`${bind}:${hostPort}:${port}/${protocol}`)}`);
    }
  }

  const dependsOn = strings(c.dependsOn).filter((d) => known.has(d));
  if (dependsOn.length > 0) {
    lines.push("    depends_on:");
    for (const d of dependsOn) {
      lines.push(
        `      ${d}:`,
        `        condition: ${dependencyCondition(known.get(d) as Resource)}`,
      );
    }
  }
  lines.push(...healthcheckLines(name, c.healthCheck));

  // Docker Model Runner: the service lists model names, the top-level `models` block says which model each is.
  const modelRefs = (Array.isArray(c.models) ? c.models : []).map(record);
  if (modelRefs.length > 0) {
    lines.push("    models:");
    for (const ref of modelRefs) {
      if (typeof ref.name !== "string" || !ENV_NAME.test(ref.name.replace(/[-.]/g, "_"))) {
        throw new ExportError(`${name}: a model needs a name of letters, digits, dashes and dots`);
      }
      if (typeof ref.model !== "string" || !ref.model) {
        throw new ExportError(`${name}: model "${ref.name}" needs a model reference`);
      }
      lines.push(`      - ${q(ref.name)}`);
      models.set(ref.name, ref.model);
    }
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
  if (container.stopGracePeriod !== undefined) {
    const period = container.stopGracePeriod;
    if (typeof period !== "string" || !DURATION.test(period)) {
      throw new ExportError(
        `${name}: stopGracePeriod ${JSON.stringify(period)} is not a duration such as 30s or 1m30s`,
      );
    }
    lines.push(`    stop_grace_period: ${q(period)}`);
  }
  const extraHosts = strings(container.extraHosts);
  for (const host of extraHosts) {
    const at = host.indexOf(":");
    if (at < 1 || !DNS_NAME.test(host.slice(0, at)) || !HOST_ADDRESS.test(host.slice(at + 1))) {
      throw new ExportError(
        `${name}: extraHosts "${host}" is not name:address (an IP or host-gateway)`,
      );
    }
  }
  if (extraHosts.length > 0)
    lines.push("    extra_hosts:", ...extraHosts.map((h) => `      - ${q(h)}`));
  const ulimits = Object.entries(record(container.ulimits));
  if (ulimits.length > 0) {
    lines.push("    ulimits:");
    for (const [limit, value] of ulimits) {
      const pair = record(value);
      if (!ULIMIT_NAME.test(limit)) {
        throw new ExportError(`${name}: ulimit "${limit}" is not a ulimit name`);
      }
      if (typeof value === "number" && Number.isInteger(value)) {
        lines.push(`      ${limit}: ${value}`);
      } else if (Number.isInteger(pair.soft) && Number.isInteger(pair.hard)) {
        lines.push(`      ${limit}:`, `        soft: ${pair.soft}`, `        hard: ${pair.hard}`);
      } else {
        throw new ExportError(
          `${name}: ulimit "${limit}" must be a whole number or { soft, hard } whole numbers`,
        );
      }
    }
  }
  const tmpfs = strings(container.tmpfs);
  if (tmpfs.length > 0) {
    for (const t of tmpfs) {
      if (!TMPFS.test(t))
        throw new ExportError(`${name}: tmpfs "${t}" is not /path or /path:options`);
    }
    lines.push("    tmpfs:", ...tmpfs.map((t) => `      - ${q(t)}`));
  }
  const cpus = container.cpus === undefined ? undefined : String(container.cpus);
  const memory = typeof container.memory === "string" ? container.memory : undefined;
  if (cpus !== undefined && !CPUS.test(cpus))
    throw new ExportError(`${name}: cpus "${cpus}" is not a number of CPUs`);
  if (memory !== undefined && !MEMORY.test(memory))
    throw new ExportError(`${name}: memory "${memory}" is not a size such as 2g`);
  if (cpus !== undefined || memory !== undefined) {
    lines.push(
      "    deploy:",
      "      resources:",
      "        limits:",
      ...(cpus !== undefined ? [`          cpus: ${q(cpus)}`] : []),
      ...(memory !== undefined ? [`          memory: ${q(memory)}`] : []),
    );
  }
  // Paths in envFile are relative to the service directory; a missing file is skipped, as Flisk does.
  const envFiles = strings(c.envFile);
  if (envFiles.length > 0) {
    lines.push("    env_file:");
    for (const file of envFiles) {
      if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(file)) {
        throw new ExportError(`${name}: envFile "${file}" is not a relative path`);
      }
      lines.push(
        `      - path: ${q(hostPath(outDir, resolveFrom(resource.path, file)))}`,
        "        required: false",
      );
    }
  }
  const profiles = strings(c.profiles);
  if (profiles.length > 0) {
    for (const p of profiles) {
      if (!PROFILE.test(p)) throw new ExportError(`${name}: profile "${p}" is not a profile name`);
    }
    lines.push("    profiles:", ...profiles.map((p) => `      - ${q(p)}`));
  }
  return { lines, namedVolumes, models };
}

/** What Compose waits for before starting a dependent: a passing check, a finished one-shot job, or the start. */
function dependencyCondition(dep: Resource): string {
  if (hasProbeCommand(dep.config.healthCheck)) return "service_healthy";
  if (dep.config.restart === "no") return "service_completed_successfully";
  return "service_started";
}

/** Whether the output has a healthcheck for this value: a command, and not turned off. Only then can a dependent wait for service_healthy. */
function hasProbeCommand(value: unknown): boolean {
  if (value === false || record(value).enabled === false) return false;
  return strings(record(value).command).length > 0;
}

/** A Compose `healthcheck` from `healthCheck.command` (exit 0 is ready); `healthCheck: false` turns it off. */
function healthcheckLines(name: string, value: unknown): string[] {
  if (value === false || record(value).enabled === false) {
    return ["    healthcheck:", "      disable: true"];
  }
  const h = record(value);
  const command = strings(h.command);
  if (command.length === 0) return [];
  const lines = ["    healthcheck:", `      test: [${['"CMD"', ...command.map(q)].join(", ")}]`];
  for (const [key, composeKey] of [
    ["interval", "interval"],
    ["timeout", "timeout"],
    ["startPeriod", "start_period"],
  ] as const) {
    if (h[key] === undefined) continue;
    const seconds = Number(h[key]);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new ExportError(`${name}: healthCheck.${key} must be a number of seconds above 0`);
    }
    lines.push(`      ${composeKey}: ${q(`${seconds}s`)}`);
  }
  if (h.retries !== undefined) {
    const retries = Number(h.retries);
    if (!Number.isInteger(retries) || retries < 1) {
      throw new ExportError(`${name}: healthCheck.retries must be a whole number above 0`);
    }
    lines.push(`      retries: ${retries}`);
  }
  return lines;
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
  const known = new Map(services.map((s) => [s.name, s] as const));
  const stacks = new Set(
    services
      .map((s) => s.config.stack)
      .filter((v): v is string => typeof v === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(v)),
  );
  const body: string[] = [];
  const volumes = new Map<string, string | undefined>();
  const models = new Map<string, string>();
  for (const service of services) {
    const built = serviceLines(service, outDir, known);
    body.push(...built.lines, "");
    for (const [v, dockerName] of built.namedVolumes) {
      const known = volumes.get(v);
      if (known && dockerName && known !== dockerName) {
        throw new ExportError(`volume "${v}" is given two names, "${known}" and "${dockerName}"`);
      }
      volumes.set(v, dockerName ?? known);
    }
    for (const [n, m] of built.models) models.set(n, m);
  }
  const header = [
    "###############################################################################",
    "# GENERATED by `flisk export compose` from the service.json files. DO NOT EDIT.",
    "# Change service.json and run `flisk export compose --force`; CI can run",
    "# `flisk export compose --check` to fail when this file is out of date.",
    "# Flisk is not needed to start it. Compose reads .env from this file's folder,",
    "# so from the project root pass the project's .env:",
    "#   docker compose --env-file .env -f .autogenerated/docker-compose.yml up -d",
    "###############################################################################",
    "",
    // Without a name Compose takes the folder's (autogenerated), so containers and unnamed volumes would not match the
    // project the app had before. One stack gives the project its name.
    ...(stacks.size === 1 ? [`name: ${q([...stacks][0] as string)}`, ""] : []),
    "services:",
  ];
  const tail = [
    ...(models.size > 0
      ? [
          "models:",
          ...[...models].sort().flatMap(([n, m]) => [`  ${n}:`, `    model: ${q(m)}`]),
          "",
        ]
      : []),
    // A volume with a name keeps the Docker volume an existing install has, so its data is used as it is.
    ...(volumes.size > 0
      ? [
          "volumes:",
          ...[...volumes]
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([v, dockerName]) =>
              dockerName ? [`  ${v}:`, `    name: ${q(dockerName)}`] : [`  ${v}:`],
            ),
          "",
        ]
      : []),
  ];
  return [...header, ...body, ...tail].join("\n").replace(/\n{3,}/g, "\n\n");
}
