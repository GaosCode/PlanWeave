import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { compilePackageGraph } from "../graph/compileTaskGraph.js";
import { commitPlanPackageGraphMutation } from "../graph/editGraph.js";
import { resolvePackagePath } from "../package/resolvePackagePath.js";
import { loadPackage } from "../package/loadPackage.js";
import { buildPlanGraph } from "./domain/buildPlanGraph.js";
import { promptPreview, sha256Hex, stableJson } from "./hash.js";
import type { PlanPackageGraphMutation } from "../graph/mutation.js";
import type { PackageWorkspaceRef, PlanPackageManifest, ProjectWorkspace } from "../types.js";
import type { PlanGraphCommandDiagnostic } from "./commands.js";
import type { PlanGraph, PromptIndexEntry } from "./domain/types.js";

export type LoadedPlanGraphPackage = {
  workspace: ProjectWorkspace;
  manifest: PlanPackageManifest;
  graph: PlanGraph;
  promptMarkdownByPath: Map<string, string>;
};

function blockRef(taskId: string, blockId: string): string {
  return `${taskId}#${blockId}`;
}

async function readPromptEntry(options: {
  packageDir: string;
  ownerKind: "task" | "block";
  ownerRef: string;
  packagePath: string;
}): Promise<
  { entry: PromptIndexEntry; markdown: string } | { diagnostic: PlanGraphCommandDiagnostic }
> {
  try {
    const absolutePath = await resolvePackagePath(options.packageDir, options.packagePath);
    const markdown = await readFile(absolutePath, "utf8");
    return {
      markdown,
      entry: {
        ownerKind: options.ownerKind,
        ownerRef: options.ownerRef,
        path: options.packagePath,
        contentHash: sha256Hex(markdown),
        preview: promptPreview(markdown)
      }
    };
  } catch (error) {
    return {
      diagnostic: {
        code: "prompt_read_failed",
        message:
          error instanceof Error
            ? error.message
            : `Prompt '${options.packagePath}' could not be read.`,
        path: options.packagePath
      }
    };
  }
}

async function readPromptIndex(
  manifest: PlanPackageManifest,
  packageDir: string
): Promise<{
  promptIndex: Map<string, PromptIndexEntry>;
  promptMarkdownByPath: Map<string, string>;
  diagnostics: PlanGraphCommandDiagnostic[];
}> {
  const promptIndex = new Map<string, PromptIndexEntry>();
  const promptMarkdownByPath = new Map<string, string>();
  const diagnostics: PlanGraphCommandDiagnostic[] = [];

  for (const node of manifest.nodes) {
    if (node.type !== "task") {
      continue;
    }
    const taskPrompt = await readPromptEntry({
      packageDir,
      ownerKind: "task",
      ownerRef: node.id,
      packagePath: node.prompt
    });
    if ("entry" in taskPrompt) {
      promptIndex.set(node.prompt, taskPrompt.entry);
      promptMarkdownByPath.set(node.prompt, taskPrompt.markdown);
    } else {
      diagnostics.push(taskPrompt.diagnostic);
    }

    for (const block of node.blocks) {
      const ref = blockRef(node.id, block.id);
      const blockPrompt = await readPromptEntry({
        packageDir,
        ownerKind: "block",
        ownerRef: ref,
        packagePath: block.prompt
      });
      if ("entry" in blockPrompt) {
        promptIndex.set(block.prompt, blockPrompt.entry);
        promptMarkdownByPath.set(block.prompt, blockPrompt.markdown);
      } else {
        diagnostics.push(blockPrompt.diagnostic);
      }
    }
  }

  return { promptIndex, promptMarkdownByPath, diagnostics };
}

async function readPromptMetadataEntry(options: {
  packageDir: string;
  ownerKind: "task" | "block";
  ownerRef: string;
  packagePath: string;
}): Promise<{ entry: PromptIndexEntry } | { diagnostic: PlanGraphCommandDiagnostic }> {
  try {
    const absolutePath = await resolvePackagePath(options.packageDir, options.packagePath);
    const metadata = await stat(absolutePath);
    return {
      entry: {
        ownerKind: options.ownerKind,
        ownerRef: options.ownerRef,
        path: options.packagePath,
        contentHash: sha256Hex(
          stableJson({
            path: options.packagePath,
            ctimeMs: metadata.ctimeMs,
            mtimeMs: metadata.mtimeMs,
            size: metadata.size
          })
        ),
        preview: ""
      }
    };
  } catch (error) {
    return {
      diagnostic: {
        code: "prompt_read_failed",
        message:
          error instanceof Error
            ? error.message
            : `Prompt '${options.packagePath}' could not be read.`,
        path: options.packagePath
      }
    };
  }
}

async function readPromptMetadataIndex(
  manifest: PlanPackageManifest,
  packageDir: string
): Promise<{
  promptIndex: Map<string, PromptIndexEntry>;
  diagnostics: PlanGraphCommandDiagnostic[];
}> {
  const promptIndex = new Map<string, PromptIndexEntry>();
  const diagnostics: PlanGraphCommandDiagnostic[] = [];

  for (const node of manifest.nodes) {
    if (node.type !== "task") {
      continue;
    }
    const taskPrompt = await readPromptMetadataEntry({
      packageDir,
      ownerKind: "task",
      ownerRef: node.id,
      packagePath: node.prompt
    });
    if ("entry" in taskPrompt) {
      promptIndex.set(node.prompt, taskPrompt.entry);
    } else {
      diagnostics.push(taskPrompt.diagnostic);
    }

    for (const block of node.blocks) {
      const ref = blockRef(node.id, block.id);
      const blockPrompt = await readPromptMetadataEntry({
        packageDir,
        ownerKind: "block",
        ownerRef: ref,
        packagePath: block.prompt
      });
      if ("entry" in blockPrompt) {
        promptIndex.set(block.prompt, blockPrompt.entry);
      } else {
        diagnostics.push(blockPrompt.diagnostic);
      }
    }
  }

  return { promptIndex, diagnostics };
}

function packageFingerprint(
  manifest: PlanPackageManifest,
  promptMarkdownByPath: Map<string, string>
): string {
  const prompts = [...promptMarkdownByPath.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return sha256Hex(stableJson({ manifest, prompts }));
}

function packageMetadataFingerprint(
  manifest: PlanPackageManifest,
  promptIndex: Map<string, PromptIndexEntry>
): string {
  const prompts = [...promptIndex.entries()]
    .map(([path, entry]) => ({ path, contentHash: entry.contentHash }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return sha256Hex(stableJson({ manifest, prompts }));
}

export function graphVersionFromPackageFingerprint(fingerprint: string): string {
  return `pgv-${fingerprint}`;
}

export async function loadPlanGraphPackage(
  projectRoot: PackageWorkspaceRef
): Promise<LoadedPlanGraphPackage> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const compiledGraph = await compilePackageGraph(manifest, workspace.packageDir);
  const { promptIndex, promptMarkdownByPath, diagnostics } = await readPromptIndex(
    manifest,
    workspace.packageDir
  );
  const fingerprint = `pkg-${packageFingerprint(manifest, promptMarkdownByPath)}`;
  const graph = buildPlanGraph({
    manifest,
    compiledGraph,
    graphVersion: graphVersionFromPackageFingerprint(fingerprint),
    packageFingerprint: fingerprint,
    promptIndex,
    diagnostics
  });
  return { workspace, manifest, graph, promptMarkdownByPath };
}

export async function loadPlanGraphPackageMetadata(
  projectRoot: PackageWorkspaceRef
): Promise<LoadedPlanGraphPackage> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const compiledGraph = await compilePackageGraph(manifest, workspace.packageDir, {
    validatePromptContents: false
  });
  const { promptIndex, diagnostics } = await readPromptMetadataIndex(
    manifest,
    workspace.packageDir
  );
  const fingerprint = `pkg-${packageMetadataFingerprint(manifest, promptIndex)}`;
  const graph = buildPlanGraph({
    manifest,
    compiledGraph,
    graphVersion: graphVersionFromPackageFingerprint(fingerprint),
    packageFingerprint: fingerprint,
    promptIndex,
    diagnostics
  });
  return { workspace, manifest, graph, promptMarkdownByPath: new Map() };
}

export async function commitPlanGraphPackageMutation(options: {
  projectRoot: PackageWorkspaceRef;
  mutation: PlanPackageGraphMutation;
}): Promise<PlanGraphCommandDiagnostic[]> {
  const result = await commitPlanPackageGraphMutation(options);
  return result.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    message: diagnostic.message,
    path: diagnostic.path
  }));
}

export async function readPackagePromptMarkdown(
  workspace: ProjectWorkspace,
  packagePath: string
): Promise<string> {
  const promptPath = await resolvePackagePath(workspace.packageDir, packagePath);
  return readFile(promptPath, "utf8");
}

export function packageFilePath(workspace: ProjectWorkspace, packagePath: string): string {
  return join(workspace.packageDir, packagePath);
}
