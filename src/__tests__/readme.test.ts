import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  name: string;
  bin: Record<string, string>;
};

describe("README CLI examples", () => {
  it("uses the published scoped package for the Compose commands", () => {
    const composeSection = readme.split("\n## Compose\n")[1]?.split("\n## ")[0];

    expect(composeSection).toBeDefined();
    expect(composeSection).toMatch(/^npx @flisk-sh\/flisk-export compose\s+# writes/m);
    expect(composeSection).toMatch(/^npx @flisk-sh\/flisk-export compose --check\s+# exit 1/m);
    expect(composeSection).not.toMatch(/^flisk-export compose(?:\s|$)/m);
    expect(packageJson.name).toBe("@flisk-sh/flisk-export");
    expect(packageJson.bin).toHaveProperty("flisk-export");
  });
});
