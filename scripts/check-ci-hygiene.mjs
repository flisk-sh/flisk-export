import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const JOB_RE = /^ {2}([A-Za-z0-9_-]+):\s*$/;
const USES_RE = /^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#\s*(.*))?$/;

export function checkCiHygiene(workflow) {
  const problems = [];
  const lines = workflow.split(/\r?\n/);
  let inJobs = false;
  let current = null;
  let actionCount = 0;

  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;

    if (/^\S/.test(line)) {
      inJobs = false;
      continue;
    }

    const job = JOB_RE.exec(line);
    if (job) {
      if (current && !current.hasTimeout)
        problems.push(`job ${current.name} has no timeout-minutes`);
      current = { name: job[1], hasTimeout: false };
      continue;
    }

    if (current && /^ {4}timeout-minutes:\s*\d+/.test(line)) current.hasTimeout = true;
  }

  if (current && !current.hasTimeout) problems.push(`job ${current.name} has no timeout-minutes`);

  for (const line of lines) {
    const uses = USES_RE.exec(line);
    if (!uses) continue;
    actionCount++;
    const action = uses[1];
    const comment = uses[2] || "";
    const ref = action.slice(action.lastIndexOf("@") + 1);
    if (!/^[0-9a-f]{40}$/.test(ref)) problems.push(`${action} is not pinned to a commit SHA`);
    if (!/\bv?\d+(?:\.\d+)*\b/.test(comment))
      problems.push(`${action} needs a trailing version comment`);
  }

  if (actionCount === 0) problems.push("workflow has no uses: lines to check");
  return problems;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const problems = checkCiHygiene(workflow);
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
  } else {
    console.log("CI jobs have timeouts and every action is SHA-pinned");
  }
}
