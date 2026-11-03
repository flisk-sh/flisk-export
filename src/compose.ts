/**
 * Builds a standalone docker-compose.yml from the bring-your-own service.json files of a Flisk project.
 *
 * The result runs with plain `docker compose up` and no Flisk: no external networks, no injected Flisk variables and no
 * generated secrets. `${VAR}` references in `env` pass through for Compose to resolve from the project `.env`. These
 * functions only return text; nothing here starts a container, deploys or calls an API.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Resource } from "./discover.js";
import { ExportError } from "./errors.js";

/** extraPorts `publish`: digits, dots, colons and `${NAME:-default}` / `${NAME-default}`, as flisk core accepts it (flisk#2947). */
const PUBLISH = /^(?:[0-9.:]|\$\{[A-Za-z_][A-Za-z0-9_]*:?-[0-9.:]+\})+$/;
/** An image reference, with Compose variables `${NAME}`, `${NAME:-default}` and `${NAME-default}` kept for Compose to resolve. */
const IMAGE =
  /^(?:[A-Za-z0-9._/:@-]|\$\{[A-Za-z_][A-Za-z0-9_]*(?::?-[A-Za-z0-9._/:@-]+|:?\?[A-Za-z0-9 !#%&()*+,./:;<=>?@[\]^_|~-]*)?\})+$/;
/** A bind source from the environment, `${NAME:-./path}` (flisk 1.4.28): NAME, the operator and the default path. */
const ENV_BIND = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(:?-)(\.{1,2}(?:\/[A-Za-z0-9_.-]+)*\/?)\}$/;
const LOG_DRIVER = /^[a-z0-9][a-z0-9_.-]*$/;
const LOG_OPTION = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** The only resource type the Compose export covers: it is the one whose service.json is a Compose service. */
export const COMPOSE_TYPE = "bring-your-own";

const RESTART_POLICIES = new Set(["no", "on-failure", "unless-stopped", "always"]);
const CONDITIONS = new Set([
  "service_started",
  "service_healthy",
  "service_completed_successfully",
]);
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
const RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function isComposeExportable(resource: Resource): boolean {
  return resource.type === COMPOSE_TYPE && typeof resource.config.command !== "string";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: a control character would break the generated YAML
const CONTROL = /[\u0000-\u001f\u007f]/;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** A YAML double-quoted scalar. JSON strings are valid ones; `$` is kept so Compose can interpolate. */
function q(value: string): string {
  return JSON.stringify(value);
}

function formatMode(mode: unknown): string {
  if (typeof mode === "number") {
    return `0${mode.toString(8)}`;
  }
  if (typeof mode === "string") {
    if (/^[0-7]{3,4}$/.test(mode)) {
      return mode.startsWith("0") ? mode : `0${mode}`;
    }
    return q(mode);
  }
  throw new ExportError(`invalid mode: ${JSON.stringify(mode)}`);
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
  secrets: Map<string, string>;
  configs: Map<string, string>;
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
  const secrets = new Map<string, string>();
  const configs = new Map<string, string>();

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
    // buildArgs (flisk#2983): NAME to a string, which may use Compose variables such as ${NODE_VERSION:-22}.
    const args = Object.entries(record(c.buildArgs));
    for (const [arg, value] of args) {
      if (!ENV_NAME.test(arg) || typeof value !== "string") {
        throw new ExportError(
          `${name}: buildArgs "${arg}" needs a name of letters, digits and _ and a string`,
        );
      }
    }
    if (args.length > 0) {
      lines.push(
        "      args:",
        ...args.map(([arg, value]) => `        ${arg}: ${q(value as string)}`),
      );
    }
  }

  const container = record(c.container);
  if (container.init !== false) lines.push("    init: true");
  if (typeof c.restart === "string") {
    if (!RESTART_POLICIES.has(c.restart) && !RESTART_LIMIT.test(c.restart)) {
      throw new ExportError(`${name}: restart "${c.restart}" is not a Compose restart policy`);
    }
    lines.push(`    restart: ${q(c.restart)}`);
  }
  // No restart in service.json is written as none: Compose's default, as the project's own Compose file had it.

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
      const fromEnv = source.match(ENV_BIND);
      if (v.selinux !== undefined && v.selinux !== "z" && v.selinux !== "Z") {
        throw new ExportError(`${name}: volume selinux must be z or Z`);
      }
      if (fromEnv) {
        // The default is relative to the service directory; Compose reads it relative to this file.
        source = `\${${fromEnv[1]}${fromEnv[2]}${hostPath(outDir, resolveFrom(resource.path, fromEnv[3] as string))}}`;
      } else if (isNamedVolume(source)) {
        const dockerName = typeof v.name === "string" ? v.name : undefined;
        if (dockerName !== undefined && !DOCKER_NAME.test(dockerName)) {
          throw new ExportError(`${name}: volume name "${dockerName}" is not a Docker volume name`);
        }
        namedVolumes.set(source, dockerName ?? namedVolumes.get(source));
      } else {
        source = hostPath(outDir, resolveFrom(resource.path, source));
      }
      const options = [
        ...(v.readOnly === true ? ["ro"] : []),
        ...(typeof v.selinux === "string" ? [v.selinux] : []),
      ];
      lines.push(
        `      - ${q(`${source}:${v.target}${options.length ? `:${options.join(",")}` : ""}`)}`,
      );
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

  // dependsOn entries are names or { name, condition } (flisk#2983); a stated condition wins over the guess.
  const dependsOn = (Array.isArray(c.dependsOn) ? c.dependsOn : [])
    .map((entry) =>
      typeof entry === "string"
        ? { name: entry, condition: undefined }
        : { name: record(entry).name, condition: record(entry).condition },
    )
    .filter(
      (d): d is { name: string; condition: unknown } =>
        typeof d.name === "string" && known.has(d.name),
    );
  if (dependsOn.length > 0) {
    lines.push("    depends_on:");
    for (const d of dependsOn) {
      const dep = known.get(d.name) as Resource;
      if (d.condition !== undefined && !CONDITIONS.has(d.condition as string)) {
        throw new ExportError(
          `${name}: dependsOn "${d.name}" condition is not a Compose condition`,
          ["Use service_started, service_healthy or service_completed_successfully"],
        );
      }
      // service_healthy needs a healthcheck in this file; without one Compose would refuse to start.
      const condition =
        d.condition === undefined
          ? dependencyCondition(dep)
          : d.condition === "service_healthy" && !hasProbeCommand(dep.config.healthCheck)
            ? "service_started"
            : (d.condition as string);
      lines.push(`      ${d.name}:`, `        condition: ${condition}`);
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
  // container.entrypoint / container.command (Flisk 1.4.31): exec-form lists. `$$` and `${VAR}` are written as they are,
  // because Compose reads them again in the file written here. An empty entrypoint drops the image's ENTRYPOINT.
  for (const key of ["entrypoint", "command"] as const) {
    const value = container[key];
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      (value.length === 0 && key === "command") ||
      !value.every((part) => typeof part === "string" && part !== "" && !CONTROL.test(part))
    ) {
      throw new ExportError(
        `${name}: container.${key} ${JSON.stringify(value)} is not a list of non-empty strings without control characters`,
      );
    }
    lines.push(`    ${key}: [${value.map((part) => q(part as string)).join(", ")}]`);
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
  // logging (flisk 1.4.28): a driver and string options, checked so nothing can add a key.
  if (c.logging !== undefined) {
    const logging = record(c.logging);
    const options = Object.entries(record(logging.options));
    if (
      logging.driver !== undefined &&
      (typeof logging.driver !== "string" || !LOG_DRIVER.test(logging.driver))
    ) {
      throw new ExportError(
        `${name}: logging.driver "${String(logging.driver)}" is not a logging driver`,
      );
    }
    for (const [key, value] of options) {
      if (!LOG_OPTION.test(key) || typeof value !== "string") {
        throw new ExportError(
          `${name}: logging option "${key}" needs a name of letters, digits, _ . - and a string`,
        );
      }
    }
    lines.push(
      "    logging:",
      ...(typeof logging.driver === "string" ? [`      driver: ${q(logging.driver)}`] : []),
      ...(options.length
        ? [
            "      options:",
            ...options.map(([key, value]) => `        ${key}: ${q(value as string)}`),
          ]
        : []),
    );
  }
  const profiles = strings(c.profiles);
  if (profiles.length > 0) {
    for (const p of profiles) {
      if (!PROFILE.test(p)) throw new ExportError(`${name}: profile "${p}" is not a profile name`);
    }
    lines.push("    profiles:", ...profiles.map((p) => `      - ${q(p)}`));
  }
  const secretFiles = Array.isArray(record(c.secrets).files)
    ? (record(c.secrets).files as unknown[]).map(record)
    : [];
  if (secretFiles.length > 0) {
    lines.push("    secrets:");
    for (const f of secretFiles) {
      const secName = typeof f.name === "string" ? f.name : "";
      if (!RESOURCE_NAME.test(secName)) {
        throw new ExportError(
          `${name}: secret needs a name of letters, digits, dashes, dots and underscores`,
        );
      }
      if (typeof f.source !== "string" || !f.source) {
        throw new ExportError(`${name}: secret "${secName}" needs a source file path`);
      }
      const hostSource = hostPath(outDir, resolveFrom(resource.path, f.source));
      const existingSec = secrets.get(secName);
      if (existingSec && existingSec !== hostSource) {
        throw new ExportError(
          `${name}: secret "${secName}" is defined with conflicting sources: "${existingSec}" and "${hostSource}"`,
        );
      }
      secrets.set(secName, hostSource);

      const target = typeof f.target === "string" ? f.target : undefined;
      const uid = f.uid !== undefined ? String(f.uid) : undefined;
      const gid = f.gid !== undefined ? String(f.gid) : undefined;
      const mode = f.mode !== undefined ? formatMode(f.mode) : undefined;

      const isShort = (!target || target === `/run/secrets/${secName}`) && !uid && !gid && !mode;
      if (isShort) {
        lines.push(`      - ${q(secName)}`);
      } else {
        lines.push(
          `      - source: ${q(secName)}`,
          ...(target ? [`        target: ${q(target)}`] : []),
          ...(uid !== undefined ? [`        uid: ${q(uid)}`] : []),
          ...(gid !== undefined ? [`        gid: ${q(gid)}`] : []),
          ...(mode !== undefined ? [`        mode: ${mode}`] : []),
        );
      }
    }
  }

  const configFiles = Array.isArray(c.configs) ? (c.configs as unknown[]).map(record) : [];
  if (configFiles.length > 0) {
    lines.push("    configs:");
    for (const f of configFiles) {
      const cfgName = typeof f.name === "string" ? f.name : "";
      if (!RESOURCE_NAME.test(cfgName)) {
        throw new ExportError(
          `${name}: config needs a name of letters, digits, dashes, dots and underscores`,
        );
      }
      if (typeof f.source !== "string" || !f.source) {
        throw new ExportError(`${name}: config "${cfgName}" needs a source file path`);
      }
      const hostSource = hostPath(outDir, resolveFrom(resource.path, f.source));
      const existingCfg = configs.get(cfgName);
      if (existingCfg && existingCfg !== hostSource) {
        throw new ExportError(
          `${name}: config "${cfgName}" is defined with conflicting sources: "${existingCfg}" and "${hostSource}"`,
        );
      }
      configs.set(cfgName, hostSource);

      const target = typeof f.target === "string" ? f.target : undefined;
      const uid = f.uid !== undefined ? String(f.uid) : undefined;
      const gid = f.gid !== undefined ? String(f.gid) : undefined;
      const mode = f.mode !== undefined ? formatMode(f.mode) : undefined;

      const isShort = (!target || target === `/${cfgName}`) && !uid && !gid && !mode;
      if (isShort) {
        lines.push(`      - ${q(cfgName)}`);
      } else {
        lines.push(
          `      - source: ${q(cfgName)}`,
          ...(target ? [`        target: ${q(target)}`] : []),
          ...(uid !== undefined ? [`        uid: ${q(uid)}`] : []),
          ...(gid !== undefined ? [`        gid: ${q(gid)}`] : []),
          ...(mode !== undefined ? [`        mode: ${mode}`] : []),
        );
      }
    }
  }

  return { lines, namedVolumes, models, secrets, configs };
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

/** A Compose project name as `docker compose` accepts it. */
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * `.flisk/project.json` `composeProjectNames`: the project name each stack had as a Compose project before the import
 * (flisk-import records it), so the export keeps its container names (pl_mail-php-1). Empty when absent or unreadable.
 */
export function composeProjectNames(projectRoot: string): Record<string, string> {
  const path = join(projectRoot, ".flisk", "project.json");
  if (!existsSync(path)) return {};
  try {
    const names = record(record(JSON.parse(readFileSync(path, "utf8"))).composeProjectNames);
    return Object.fromEntries(
      Object.entries(names).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && PROJECT_NAME.test(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

/** The text of a docker-compose.yml for `resources`, written for a file in `outDir`. */
export function buildCompose(
  outDir: string,
  resources: readonly Resource[],
  options: { composeProjectNames?: Readonly<Record<string, string>> } = {},
): string {
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
  const projectName = (stack: string) => {
    const recorded = options.composeProjectNames?.[stack];
    return recorded && PROJECT_NAME.test(recorded) ? recorded : stack;
  };
  const body: string[] = [];
  const volumes = new Map<string, string | undefined>();
  const models = new Map<string, string>();
  const secrets = new Map<string, string>();
  const configs = new Map<string, string>();
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
    for (const [s, hostSource] of built.secrets) {
      const known = secrets.get(s);
      if (known && known !== hostSource) {
        throw new ExportError(
          `secret "${s}" is defined with conflicting sources: "${known}" and "${hostSource}"`,
        );
      }
      secrets.set(s, hostSource);
    }
    for (const [c, hostSource] of built.configs) {
      const known = configs.get(c);
      if (known && known !== hostSource) {
        throw new ExportError(
          `config "${c}" is defined with conflicting sources: "${known}" and "${hostSource}"`,
        );
      }
      configs.set(c, hostSource);
    }
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
    // The Compose project name the stack had before the import, when flisk-import recorded it, else the stack.
    ...(stacks.size === 1 ? [`name: ${q(projectName([...stacks][0] as string))}`, ""] : []),
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
    ...(secrets.size > 0
      ? [
          "secrets:",
          ...[...secrets]
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([s, hostSource]) => [
              `  ${s}:`,
              `    file: ${q(hostSource.replace(/\$/g, "$$$$"))}`,
            ]),
          "",
        ]
      : []),
    ...(configs.size > 0
      ? [
          "configs:",
          ...[...configs]
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([c, hostSource]) => [
              `  ${c}:`,
              `    file: ${q(hostSource.replace(/\$/g, "$$$$"))}`,
            ]),
          "",
        ]
      : []),
  ];
  return [...header, ...body, ...tail].join("\n").replace(/\n{3,}/g, "\n\n");
}
