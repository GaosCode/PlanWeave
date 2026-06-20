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
