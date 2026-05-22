import type { ValidationIssue } from "../../types.js";

export type DesktopPackageFileSyncResult = {
  ok: boolean;
  primed: boolean;
  fullRefresh: boolean;
  affectedTasks: string[];
  dirtyPromptRefs: string[];
  diagnostics: ValidationIssue[];
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
