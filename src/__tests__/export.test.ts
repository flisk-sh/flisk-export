import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { Resource } from "../discover.js";
import { buildRenderBlueprint, buildWranglerToml, deployName } from "../generate.js";
import { main } from "../main.js";

const SECRET = "sk_live_do-not-write-me-0123456789";

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

function service(config: Record<string, unknown>): string {
  return JSON.stringify(config);
}

/** A Flisk project with a Docker backend, a Node agent, a Worker and a library, every one carrying a secret. */
function exportProject(root = fs.mkdtempSync(path.join(os.tmpdir(), "flisk-export-"))): string {
  writeFiles(root, {
    ".flisk/project.json": "{}",
    "services/api/gateway/service.json": service({
      appName: "gateway",
      appType: "backend",
      port: 3100,
      healthCheckPath: "/ready",
      env: { STRIPE_KEY: SECRET, DATABASE_URL: `postgres://u:${SECRET}@db/app` },
    }),
    "services/api/gateway/Dockerfile": "FROM node:22\n",
    "services/api/helper/service.json": service({
      appName: "helper",
      appType: "agent",
      port: 4801,
      env: { OPENAI_API_KEY: SECRET },
    }),
    "services/api/helper/package.json": JSON.stringify({ scripts: { build: "tsc" } }),
    "services/api/edge/service.json": service({
      appName: "edge",
      appType: "mcp",
      env: { API_TOKEN: SECRET },
    }),
    "services/api/edge/package.json": JSON.stringify({
      main: "./src/worker.ts",
      devDependencies: { wrangler: "^4.0.0" },
    }),
    "services/api/edge/src/worker.ts": "export default {};\n",
    "services/api/shared/service.json": service({
      appName: "shared",
      appType: "library",
      env: { LIB_SECRET: SECRET },
    }),
  });
  return root;
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[], cwd: string): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const status = await main(args, {
    cwd,
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
  });
  return { status, stdout, stderr };
}

function listTree(root: string): string[] {
  return (fs.readdirSync(root, { recursive: true }) as string[]).map(String).sort();
}

function resource(root: string, rel: string, config: Record<string, unknown>): Resource {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  return {
    name: String(config.appName),
    path: dir,
    type: typeof config.appType === "string" ? config.appType : undefined,
    config,
  };
}

describe("flisk-export render", () => {
  it("writes a Render Blueprint with docker and node web services, PORT set from service.json", async () => {
    const root = exportProject();
    const result = await run(["render"], root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Nothing was deployed");

    const yaml = fs.readFileSync(path.join(root, "render.yaml"), "utf-8");
    expect(yaml).toContain(
      [
        "services:",
        "  - type: web",
        '    name: "edge"',
        "    runtime: node",
        '    rootDir: "services/api/edge"',
        '    buildCommand: "npm install"',
        '    startCommand: "npm start"',
        '    healthCheckPath: "/health"',
        "    envVars:",
        "      - key: API_TOKEN",
        "        sync: false",
        "  - type: web",
        '    name: "gateway"',
        "    runtime: docker",
        '    dockerfilePath: "./services/api/gateway/Dockerfile"',
        '    dockerContext: "./services/api/gateway"',
        '    healthCheckPath: "/ready"',
        "    envVars:",
        "      - key: PORT",
        '        value: "3100"',
        "      - key: DATABASE_URL",
        "        sync: false",
        "      - key: STRIPE_KEY",
        "        sync: false",
        "  - type: web",
        '    name: "helper"',
        "    runtime: node",
        '    rootDir: "services/api/helper"',
        '    buildCommand: "npm install && npm run build"',
        '    startCommand: "npm start"',
        '    healthCheckPath: "/health"',
        "    envVars:",
        "      - key: PORT",
        '        value: "4801"',
      ].join("\n"),
    );
    expect(yaml).not.toContain("shared");
    expect(yaml).not.toContain(SECRET);
  });

  it("writes paths relative to the git repository root when the project is in a subfolder", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "flisk-export-repo-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const root = exportProject(path.join(repo, "apps", "shop"));
    fs.mkdirSync(root, { recursive: true });
    const result = await run(["render"], root);
    expect(result.status).toBe(0);
    const yaml = fs.readFileSync(path.join(repo, "render.yaml"), "utf-8");
    expect(yaml).toContain('dockerfilePath: "./apps/shop/services/api/gateway/Dockerfile"');
    expect(yaml).toContain('dockerContext: "./apps/shop/services/api/gateway"');
    expect(yaml).toContain('rootDir: "apps/shop/services/api/edge"');
    expect(fs.existsSync(path.join(root, "render.yaml"))).toBe(false);
  });

  it("exports one resource into --out", async () => {
    const root = exportProject();
    const out = path.join(root, "deploy");
    const result = await run(["render", "--resource", "gateway", "--out", out], root);
    expect(result.status).toBe(0);
    const yaml = fs.readFileSync(path.join(out, "render.yaml"), "utf-8");
    expect(yaml).toContain('name: "gateway"');
    expect(yaml).not.toContain('name: "helper"');
    expect(fs.existsSync(path.join(root, "render.yaml"))).toBe(false);
  });

  it("prints the Blueprint, never a secret, and writes nothing with --dry-run", async () => {
    const root = exportProject();
    const before = listTree(root);
    const result = await run(["render", "--dry-run"], root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Dry run - would write render.yaml");
    expect(result.stdout).toContain("runtime: docker");
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect(listTree(root)).toEqual(before);
  });

  it("refuses to replace an existing render.yaml unless --force", async () => {
    const root = exportProject();
    const file = path.join(root, "render.yaml");
    fs.writeFileSync(file, "# mine\n");
    const refused = await run(["render"], root);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("already exists");
    expect(fs.readFileSync(file, "utf-8")).toBe("# mine\n");
    const forced = await run(["render", "--force"], root);
    expect(forced.status).toBe(0);
    expect(fs.readFileSync(file, "utf-8")).toContain("services:");
  });

  it("refuses a resource that does not serve HTTP", async () => {
    const root = exportProject();
    const result = await run(["render", "--resource", "shared"], root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not serve HTTP");
  });

  it("treats a resource with no appType the same way with and without --resource", async () => {
    const root = exportProject();
    writeFiles(root, {
      "services/api/untyped/service.json": service({ appName: "untyped" }),
      "services/api/untyped/Dockerfile": "FROM node:22\n",
    });
    const all = await run(["render", "--dry-run"], root);
    expect(all.status).toBe(0);
    expect(all.stdout).not.toContain("untyped");
    const one = await run(["render", "--resource", "untyped", "--dry-run"], root);
    expect(one.status).toBe(1);
    expect(one.stderr).toContain("no appType");
  });

  it("refuses two resources that become the same service name", async () => {
    const root = exportProject();
    writeFiles(root, {
      "services/api/a/service.json": service({ appName: "api_v1", appType: "backend" }),
      "services/api/a/Dockerfile": "FROM node:22\n",
      "services/api/b/service.json": service({ appName: "api-v1", appType: "backend" }),
      "services/api/b/Dockerfile": "FROM node:22\n",
    });
    const result = await run(["render"], root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('both become the service name "api-v1"');
    expect(result.stderr).toContain('"api_v1"');
    expect(fs.existsSync(path.join(root, "render.yaml"))).toBe(false);
  });

  it("warns about env names it leaves out", async () => {
    const root = exportProject();
    writeFiles(root, {
      "services/api/odd/service.json": service({
        appName: "odd",
        appType: "backend",
        env: { "MY-KEY": SECRET, GOOD: SECRET },
      }),
      "services/api/odd/Dockerfile": "FROM node:22\n",
    });
    const result = await run(["render", "--resource", "odd", "--dry-run"], root);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("odd: env names left out");
    expect(result.stderr).toContain("MY-KEY");
    expect(result.stdout).toContain("- key: GOOD");
    expect(result.stdout + result.stderr).not.toContain(SECRET);
  });
});

describe("flisk-export wrangler", () => {
  it("writes wrangler.toml next to the resource with a custom-domain route", async () => {
    const root = exportProject();
    const result = await run(
      ["wrangler", "--resource", "edge", "--route", "mcp.example.com"],
      root,
    );
    expect(result.status).toBe(0);
    const toml = fs.readFileSync(path.join(root, "services/api/edge/wrangler.toml"), "utf-8");
    expect(toml).toContain('name = "edge"\nmain = "src/worker.ts"\n');
    expect(toml).toMatch(/^compatibility_date = "\d{4}-\d{2}-\d{2}"$/m);
    expect(toml).toContain('routes = [{ pattern = "mcp.example.com", custom_domain = true }]');
    expect(toml).toContain("#   API_TOKEN");
    expect(toml).not.toContain(SECRET);
  });

  it("writes no routes without --route, and main is relative to --out", async () => {
    const root = exportProject();
    const out = path.join(root, "workers", "edge");
    const result = await run(["wrangler", "--resource", "edge", "--out", out], root);
    expect(result.status).toBe(0);
    const toml = fs.readFileSync(path.join(out, "wrangler.toml"), "utf-8");
    expect(toml).toContain('main = "../../services/api/edge/src/worker.ts"');
    expect(toml).not.toContain("routes");
  });

  it("prints the file, never a secret, and writes nothing with --dry-run", async () => {
    const root = exportProject();
    const before = listTree(root);
    const result = await run(["wrangler", "--resource", "edge", "--dry-run"], root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('name = "edge"');
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect(listTree(root)).toEqual(before);
  });

  it("refuses to replace an existing wrangler.toml unless --force", async () => {
    const root = exportProject();
    const file = path.join(root, "services/api/edge/wrangler.toml");
    fs.writeFileSync(file, "# mine\n");
    expect((await run(["wrangler", "--resource", "edge"], root)).status).toBe(1);
    expect(fs.readFileSync(file, "utf-8")).toBe("# mine\n");
    expect((await run(["wrangler", "--resource", "edge", "--force"], root)).status).toBe(0);
    expect(fs.readFileSync(file, "utf-8")).toContain('name = "edge"');
  });

  it("rejects a --route that is a URL or a wildcard", async () => {
    const root = exportProject();
    const url = await run(
      ["wrangler", "--resource", "edge", "--route", "https://x.example.com/a"],
      root,
    );
    expect(url.status).toBe(1);
    expect(url.stderr).toContain("--route must be a host name");
    const wildcard = await run(
      ["wrangler", "--resource", "edge", "--route", "*.example.com"],
      root,
    );
    expect(wildcard.status).toBe(1);
    expect(wildcard.stderr).toContain("do not accept a wildcard");
    expect(fs.existsSync(path.join(root, "services/api/edge/wrangler.toml"))).toBe(false);
  });

  it("refuses a Docker or non-Worker resource unless --allow-non-worker", async () => {
    const root = exportProject();
    writeFiles(root, { "services/api/gateway/src/index.js": "export default {};\n" });
    const docker = await run(["wrangler", "--resource", "gateway", "--dry-run"], root);
    expect(docker.status).toBe(1);
    expect(docker.stderr).toContain("has a Dockerfile");

    writeFiles(root, {
      "services/api/helper/package.json": JSON.stringify({ dependencies: { express: "^5" } }),
      "services/api/helper/index.js": "export default {};\n",
    });
    const express = await run(["wrangler", "--resource", "helper", "--dry-run"], root);
    expect(express.status).toBe(1);
    expect(express.stderr).toContain("does not look like a Cloudflare Worker");

    const allowed = await run(
      ["wrangler", "--resource", "helper", "--allow-non-worker", "--dry-run"],
      root,
    );
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toContain('main = "index.js"');
  });

  it("reports an unknown resource", async () => {
    const root = exportProject();
    const result = await run(["wrangler", "--resource", "nope"], root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("nope");
  });
});

describe("builders", () => {
  it("never copy a secret value, whatever the env names are", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "flisk-export-b-"));
    const gateway = resource(root, "gateway", {
      appName: "gateway",
      appType: "backend",
      env: { GOOD_NAME: SECRET, "bad name": SECRET, "x\ny": SECRET },
    });
    fs.writeFileSync(path.join(gateway.path, "Dockerfile"), "FROM node:22\n");
    const yaml = buildRenderBlueprint(root, [gateway]);
    expect(yaml).not.toContain(SECRET);
    expect(yaml).toContain("- key: GOOD_NAME");
    expect(yaml).not.toContain("bad name");

    const worker = resource(root, "worker", {
      appName: "worker",
      appType: "backend",
      env: { GOOD_NAME: SECRET },
    });
    fs.writeFileSync(path.join(worker.path, "index.js"), "export default {};\n");
    fs.writeFileSync(
      path.join(worker.path, "package.json"),
      JSON.stringify({ dependencies: { hono: "^4" } }),
    );
    const toml = buildWranglerToml(worker, worker.path, { now: new Date("2026-10-01T12:00:00Z") });
    expect(toml).not.toContain(SECRET);
    expect(toml).toContain('compatibility_date = "2026-10-01"');
    expect(toml).toContain('main = "index.js"');
  });

  it("does not list PORT twice when service.json env also names it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "flisk-export-p-"));
    const api = resource(root, "api", {
      appName: "api",
      appType: "backend",
      port: 3000,
      env: { PORT: "3000" },
    });
    fs.writeFileSync(path.join(api.path, "Dockerfile"), "FROM node:22\n");
    const yaml = buildRenderBlueprint(root, [api]);
    expect(yaml.match(/key: PORT/g)).toHaveLength(1);
    expect(yaml).toContain('value: "3000"');
  });

  it("turns a resource name into one Render and Cloudflare accept", () => {
    expect(deployName("My_API.v2")).toBe("my-api-v2");
    expect(deployName("___")).toBe("service");
  });
});
