import assert from "node:assert/strict";
import test from "node:test";
import { checkCiHygiene } from "./check-ci-hygiene.mjs";

test("flags a job without a timeout and a mutable action tag", () => {
  const problems = checkCiHygiene(`name: ci
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo ok
`);
  assert.ok(problems.some((problem) => problem.includes("job test has no timeout-minutes")));
  assert.ok(problems.some((problem) => problem.includes("actions/checkout@v4 is not pinned")));
  assert.ok(
    problems.some((problem) =>
      problem.includes("actions/checkout@v4 needs a trailing version comment"),
    ),
  );
});

test("accepts a bounded job with SHA-pinned actions and version comments", () => {
  const problems = checkCiHygiene(`name: ci
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
      - run: echo ok
`);
  assert.deepEqual(problems, []);
});

test("checks every job, not just the first", () => {
  const problems = checkCiHygiene(`jobs:
  first:
    timeout-minutes: 10
    steps: []
  second:
    steps: []
`);
  assert.deepEqual(problems, [
    "job second has no timeout-minutes",
    "workflow has no uses: lines to check",
  ]);
});
