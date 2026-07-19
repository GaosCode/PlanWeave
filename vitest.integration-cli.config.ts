import { createVitestConfig } from "./vitest.config";
import { testFilesForRoots } from "./vitest.suites";

export default createVitestConfig(testFilesForRoots("integration", ["packages/cli/src/__tests__"]));
