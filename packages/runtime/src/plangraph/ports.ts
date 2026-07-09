import type {
  PlanGraphCommand,
  PlanGraphAffectedRefs,
  PlanGraphCommandDiagnostic
} from "./commands.js";
import type { PlanGraph } from "./domain/types.js";
import type { PlanPackageGraphMutation } from "../graph/mutation.js";
import type { PackageWorkspaceRef } from "../types.js";
import type { LoadedPlanGraphPackage } from "./packageRepository.js";
import type { UpdateLayoutCommand } from "./commands.js";

export type LoadPlanGraphResult = {
  graph: PlanGraph;
  packageDir: string;
};

export type PlanGraphIndexStore = {
  rebuild(options?: { clearHistory?: boolean }): Promise<PlanGraph>;
  indexChangedPaths(paths: string[], options?: { clearHistory?: boolean }): Promise<PlanGraph>;
  load(): Promise<PlanGraph | null>;
  getProjectionVersion(
    projectionName: string,
    cacheKey: string
  ): Promise<PlanGraphProjectionVersion | null>;
  setProjectionVersion(projection: PlanGraphProjectionVersion): Promise<void>;
  clearProjectionVersions(): Promise<void>;
};

export type PlanGraphProjectionVersion = {
  projectionName: string;
  graphVersion: string;
  projectionVersion: string;
  cacheKey: string;
  updatedAt: string;
};

export type PlanGraphPackageRepository = {
  load(projectRoot: PackageWorkspaceRef): Promise<LoadedPlanGraphPackage>;
  commit(options: {
    projectRoot: PackageWorkspaceRef;
    mutation: PlanPackageGraphMutation;
  }): Promise<PlanGraphCommandDiagnostic[]>;
  packageFilePath(loaded: LoadedPlanGraphPackage, packagePath: string): string;
};

export type PlanGraphOperationLogEntry = {
  id: number;
  workspaceRef: PackageWorkspaceRef;
  graphVersionBefore: string;
  graphVersionAfter: string;
  command: PlanGraphCommand;
  inverse: PlanGraphCommand | PlanGraphCommand[];
  affected: PlanGraphAffectedRefs;
  createdAt: string;
  undoneAt: string | null;
};

export type PlanGraphOperationLog = {
  append(entry: Omit<PlanGraphOperationLogEntry, "id" | "createdAt" | "undoneAt">): Promise<number>;
  latestUndoable(): Promise<PlanGraphOperationLogEntry | null>;
  latestRedoable(): Promise<PlanGraphOperationLogEntry | null>;
  markUndone(id: number): Promise<void>;
  markRedone(id: number): Promise<void>;
  clear(): Promise<void>;
};

export type PlanGraphIndexStoreFactory = (options: {
  projectRoot: PackageWorkspaceRef;
  indexPath?: string;
}) => Promise<PlanGraphIndexStore & { log: PlanGraphOperationLog; indexPath: string }>;

export type PlanGraphLayoutStore = {
  read(
    projectRoot: PackageWorkspaceRef,
    layoutScope: UpdateLayoutCommand["layoutScope"]
  ): Promise<unknown>;
  write(
    projectRoot: PackageWorkspaceRef,
    layoutScope: UpdateLayoutCommand["layoutScope"],
    layout: unknown
  ): Promise<unknown>;
};

export type PlanGraphCommandDependencies = {
  repository: PlanGraphPackageRepository;
  createIndexStore: PlanGraphIndexStoreFactory;
  layoutStore: PlanGraphLayoutStore;
};
