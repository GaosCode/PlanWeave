import type { ValidationIssue } from "../../types.js";

export type DesktopPackageFileSyncResult = {
  ok: boolean;
  primed: boolean;
  fullRefresh: boolean;
  affectedTasks: string[];
  dirtyPromptRefs: string[];
  refreshedPromptCount: number;
  refreshConcurrency: number | null;
  diagnostics: ValidationIssue[];
};

export type DesktopPackageFileRefreshOptions = {
  changedPaths?: string[];
};

export type DesktopPackageFileSnapshotRef = {
  snapshotId: string;
  projectRoot: string;
  createdAt: string;
  promptFileCount: number;
};

export type DesktopPackageFileChangeEvent = {
  projectRoot: string;
  canvasId?: string | null;
  paths: string[];
  triggeredAt: string;
};
