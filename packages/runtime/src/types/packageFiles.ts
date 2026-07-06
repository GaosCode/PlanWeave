import type { CompiledExecutionGraph } from "./graph.js";
import type { PlanPackageManifest } from "./manifest.js";

export type PackageFileChange = {
  path: string;
  type: "added" | "changed" | "removed";
};

export type FileFingerprint = {
  path: string;
  hash: string;
  mtimeMs: number;
};

export type PackageFileSnapshot = {
  manifest: PlanPackageManifest;
  graph: CompiledExecutionGraph;
  manifestFile: FileFingerprint;
  promptFiles: Record<string, FileFingerprint>;
};

export type PromptSurface = {
  ref: string;
  path: string;
  markdown: string;
};

export type RefreshPromptsResult = {
  prompts: PromptSurface[];
};

export type PackageContentOwner =
  | { kind: "manifest" }
  | { kind: "task"; ref: string }
  | { kind: "block"; ref: string }
  | { kind: "projectPrompt" }
  | { kind: "unknown" };

export type PackageContentRef = {
  kind: "package_file" | "prompt_source" | "rendered_prompt";
  path?: string;
  ref?: string;
  hash: string;
  sizeBytes: number;
};

export type PackageFileSummary = {
  path: string;
  sizeBytes: number;
  hash: string;
  owner: PackageContentOwner;
  preview: string;
  contentRef: PackageContentRef;
};

export type PackageFileListResult = {
  files: PackageFileSummary[];
  pagination: {
    limit: number;
    cursor: string | null;
    nextCursor: string | null;
    total: number;
    hasMore: boolean;
  };
};

export type PackageContentReadResult = {
  contentRef: PackageContentRef;
  content: string;
  truncated: boolean;
};
