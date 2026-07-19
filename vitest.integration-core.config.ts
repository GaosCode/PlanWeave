import { createVitestConfig } from "./vitest.config";
import { testFilesForRoots } from "./vitest.suites";

export default createVitestConfig(
  testFilesForRoots("integration", [
    "packages/desktop/src/__tests__",
    "packages/mcp/src/__tests__",
    "packages/runtime/src/__tests__"
  ])
);
