import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * File parallelism is enabled (Vitest default). Isolation notes:
 * - PLANWEAVE_HOME: vitest.setup.ts clears it after each test so files sharing a
 *   worker cannot leak homes; suites that need a home still mkdtemp their own.
 * - MCP HTTP tests already bind listen(0) and read the assigned port; config.port
 *   in those tests is only for health-payload assertions.
 * - tmux: killActiveTmuxSessions() is process-local (in-memory map). With the
 *   forks pool each file gets its own process, and session names include a
 *   runDir hash, so no serial carve-out is required.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve("packages", "desktop", "src", "renderer")
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "packages/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 10_000
  }
});
