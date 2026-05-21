import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve("packages", "desktop", "src", "renderer")
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "packages/**/*.test.tsx"],
    testTimeout: 10_000
  }
});
