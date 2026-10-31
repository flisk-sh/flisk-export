/**
 * Finds the Flisk project root and the service.json files in it. This is a small read-only copy of how the Flisk
 * CLI discovers resources: it never writes, never runs anything but `git rev-parse` and never calls a network.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ExportError } from "./errors.js";

/** A service.json and where it sits. */
export interface Resource {
  name: string;
  /** Absolute path of the resource directory (the folder that holds service.json). */
  path: string;
  /** appType from service.json, or undefined when it sets none. */
  type?: string;
  config: Record<string, unknown>;
}

const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", "vendor"]);
const MAX_DEPTH = 5;

/** The nearest directory at or above `start` holding `.flisk/project.json`, or `start` itself when there is none. */
export function findProjectRoot(start: string): string {
  // The real path, so paths compare with what `git rev-parse` prints (macOS /var is a link to /private/var).
  const from = existsSync(start) ? realpathSync(resolve(start)) : resolve(start);
  let dir = from;
  while (true) {
    if (existsSync(join(dir, ".flisk", "project.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

/**
 * The root of the git repository holding `dir`, or `dir` when it is not in one. Render reads every path in a
 * Blueprint relative to the repository root, so the Blueprint is written against this.
 */
export function findRepoRoot(dir: string): string {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? resolve(out) : dir;
  } catch {
    return dir;
  }
}

function findServiceJsonFiles(dir: string, depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
      results.push(...findServiceJsonFiles(full, depth + 1));
    } else if (entry.isFile() && entry.name === "service.json") {
      results.push(full);
    }
  }
  return results;
}

/** Every resource under the project root. A service.json that is not a JSON object with appName is skipped. */
export function discoverResources(
  projectRoot: string,
  warn: (message: string) => void = () => {},
): Resource[] {
  const resources: Resource[] = [];
  for (const file of findServiceJsonFiles(projectRoot)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      warn(`skipped ${file}: invalid JSON`);
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warn(`skipped ${file}: not a JSON object`);
      continue;
    }
    const config = parsed as Record<string, unknown>;
    if (typeof config.appName !== "string" || !config.appName) {
      warn(`skipped ${file}: missing appName`);
      continue;
    }
    resources.push({
      name: config.appName,
      path: dirname(file),
      type: typeof config.appType === "string" && config.appType ? config.appType : undefined,
      config,
    });
  }
  return resources.sort((a, b) => a.name.localeCompare(b.name));
}

export function findResource(resources: readonly Resource[], name: string): Resource {
  const found = resources.find((resource) => resource.name === name);
  if (!found) {
    throw new ExportError(`No resource named "${name}" was found`, [
      `Resources found: ${resources.map((resource) => resource.name).join(", ") || "none"}`,
    ]);
  }
  return found;
}
