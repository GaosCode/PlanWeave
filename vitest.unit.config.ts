import { createVitestConfig } from "./vitest.config";
import { testFilesFor } from "./vitest.suites";

export default createVitestConfig(testFilesFor("unit"));
