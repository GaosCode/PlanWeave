import type { WorkItemPackagePort } from "./workItemFacts.js";

export type WorkRuntimeProjectScope = {
  workspaceId: string;
  projectId: string;
};

export type WorkRuntimeCanvasScope = WorkRuntimeProjectScope & {
  canvasId: string;
};

export type WorkRuntimePackageLease = {
  package: WorkItemPackagePort;
  release(): void | Promise<void>;
};

export interface WorkRuntimeProjectResolverPort {
  listAttachedProjects(): readonly WorkRuntimeProjectScope[];
  resolveProjectPackage(scope: WorkRuntimeProjectScope): WorkItemPackagePort | undefined;
}

export interface WorkRuntimePackageLeasePort {
  acquirePackage(scope: WorkRuntimeCanvasScope): WorkRuntimePackageLease | undefined;
}
