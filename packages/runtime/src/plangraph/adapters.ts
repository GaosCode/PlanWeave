import {
  commitPlanGraphPackageMutation,
  loadPlanGraphPackage,
  packageFilePath
} from "./packageRepository.js";
import { createSqlitePlanGraphStore } from "./sqliteIndex.js";
import { desktopLayoutCommandStore } from "../desktop/layoutStore.js";
import type { PlanGraphCommandDependencies } from "./ports.js";

export const defaultPlanGraphCommandDependencies: PlanGraphCommandDependencies = {
  repository: {
    load: loadPlanGraphPackage,
    commit: commitPlanGraphPackageMutation,
    packageFilePath: (loaded, packagePath) => packageFilePath(loaded.workspace, packagePath)
  },
  createIndexStore: createSqlitePlanGraphStore,
  layoutStore: desktopLayoutCommandStore
};
