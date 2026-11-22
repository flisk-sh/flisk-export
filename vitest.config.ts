import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    // scripts/*.test.mjs are written for node:test and run with `npm run test:scripts`.
    exclude: [...configDefaults.exclude, "scripts/**"],
  },
});
