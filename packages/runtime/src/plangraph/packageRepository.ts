import { readFile, stat } from "node:fs/promises";
import { normalizeContentVersionPromptPath } from "@planweave-ai/collaboration-protocol/content/version";
import { join } from "node:path";
import { compilePackageGraphFromPrompts, compilePackageGraph } from "../graph/compileTaskGraph.js";
import { commitPlanPackageGraphMutation } from "../graph/editGraph.js";
import { resolvePackagePath } from "../package/resolvePackagePath.js";
import {
  capturePackagePrompts,
  packagePromptOwners,
  originalPromptPaths,
  promptReferenceKey,
  resolvePackagePromptTargets,
  type PromptReadFailure
} from "../package/promptInventory.js";
import { toPackagePosixPath } from "../package/packagePosixPath.js";
import { loadPackage } from "../package/loadPackage.js";
import { buildPlanGraph } from "./domain/buildPlanGraph.js";
import {
  packageFingerprintFromContent,
  graphVersionFromPackageFingerprint,
  promptPreview,
  sha256Hex,
  stableJson
} from "./hash.js";
import type { PlanPackageGraphMutation } from "../graph/mutation.js";
import type {
  CompiledExecutionGraph,
  PackageWorkspaceRef,
  PlanPackageManifest,
  ProjectWorkspace
} from "../types.js";
import type { PlanGraphCommandDiagnostic } from "./commands.js";
import type { PlanGraph, PromptIndexEntry } from "./domain/types.js";

export type LoadedPlanGraphPackage = {
  workspace: ProjectWorkspace;
  manifest: PlanPackageManifest;
  graph: PlanGraph;
  promptMarkdownByPath: Map<string, string>;
  promptReadFailuresByPath: Map<string, PlanGraphPromptReadFailure>;
};

export type PlanGraphPromptReadFailure = PromptReadFailure;

export type PlanGraphPackageSnapshot = {
  workspace: ProjectWorkspace;
  manifest: PlanPackageManifest;
  compiledGraph: CompiledExecutionGraph;
  promptMarkdownByPath?: ReadonlyMap<string, string>;
  promptDiagnosticsByPath?: ReadonlyMap<string, PlanGraphPromptReadFailure>;
};

type PromptReadFailureResult = {
  diagnostic: PlanGraphCommandDiagnostic;
  failure: PlanGraphPromptReadFailure;
};

function promptReadFailure(packagePath: string, error: unknown): PromptReadFailureResult {
  const readableError =
    error instanceof Error
      ? error
      : new Error(`Prompt '${packagePath}' could not be read: ${String(error)}`);
  const missing = "code" in readableError && readableError.code === "ENOENT";
  return {
    diagnostic: {
      code: "prompt_read_failed",
      message: readableError.message,
      path: packagePath
    },
    failure: missing
      ? { kind: "missing", path: packagePath }
      : { kind: "read_error", path: packagePath, error: readableError }
  };
}

function blockRef(taskId: string, blockId: string): string {
  return `${taskId}#${blockId}`;
}

async function readPromptIndex(
  manifest: PlanPackageManifest,
  packageDir: string,
  capturedPrompts?: ReadonlyMap<string, string>,
  capturedFailures?: ReadonlyMap<string, PlanGraphPromptReadFailure>
): Promise<{
  promptIndex: Map<string, PromptIndexEntry>;
  promptMarkdownByPath: Map<string, string>;
  promptReadFailuresByPath: Map<string, PlanGraphPromptReadFailure>;
  diagnostics: PlanGraphCommandDiagnostic[];
}> {
  const promptIndex = new Map<string, PromptIndexEntry>();
  const promptMarkdownByPath = new Map<string, string>();
  const diagnostics: PlanGraphCommandDiagnostic[] = [];
  const promptReadFailuresByPath = new Map<string, PlanGraphPromptReadFailure>();
  const reads = new Map<string, Promise<string>>();
  const owners = packagePromptOwners(manifest);
  const targets = capturedPrompts
    ? null
    : await resolvePackagePromptTargets(packageDir, owners.keys(), {
        manifestPaths: originalPromptPaths(owners)
      });

  async function add(ownerKind: "task" | "block", ownerRef: string, path: string) {
    const key = toPackagePosixPath(promptReferenceKey(path));
    try {
      let markdown: string | undefined;
      if (capturedPrompts) {
        const failure = capturedFailures?.get(key);
        if (failure) {
          promptReadFailuresByPath.set(path, { ...failure, path });
          return;
        }
        markdown = capturedPrompts.get(
          capturedFailures ? key : normalizeContentVersionPromptPath(path)
        );
        if (markdown === undefined) throw new Error(`Captured prompt '${path}' is missing.`);
      } else {
        const target = targets?.paths.get(key);
        if (!target) {
          const failure = targets?.failures.get(key);
          throw failure?.kind === "read_error"
            ? failure.error
            : new Error(`Prompt '${path}' could not be resolved.`);
        }
        let reading = reads.get(target);
        if (!reading) {
          reading = readFile(target, "utf8");
          reads.set(target, reading);
        }
        markdown = await reading;
      }
      promptIndex.set(path, {
        ownerKind,
        ownerRef,
        path,
        contentHash: sha256Hex(markdown),
        preview: promptPreview(markdown)
      });
      promptMarkdownByPath.set(path, markdown);
    } catch (error) {
      const failure = promptReadFailure(path, error);
      diagnostics.push(failure.diagnostic);
      promptReadFailuresByPath.set(path, failure.failure);
    }
  }

  for (const task of manifest.nodes) {
    await add("task", task.id, task.prompt);
    for (const block of task.blocks) {
      await add("block", blockRef(task.id, block.id), block.prompt);
    }
  }
  return { promptIndex, promptMarkdownByPath, promptReadFailuresByPath, diagnostics };
}

async function readPromptMetadataEntry(options: {
  packageDir: string;
  ownerKind: "task" | "block";
  ownerRef: string;
  packagePath: string;
}): Promise<{ entry: PromptIndexEntry } | PromptReadFailureResult> {
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
    return promptReadFailure(options.packagePath, error);
  }
}

async function readPromptMetadataIndex(
  manifest: PlanPackageManifest,
  packageDir: string
): Promise<{
  promptIndex: Map<string, PromptIndexEntry>;
  promptReadFailuresByPath: Map<string, PlanGraphPromptReadFailure>;
  diagnostics: PlanGraphCommandDiagnostic[];
}> {
  const promptIndex = new Map<string, PromptIndexEntry>();
  const diagnostics: PlanGraphCommandDiagnostic[] = [];
  const promptReadFailuresByPath = new Map<string, PlanGraphPromptReadFailure>();

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
      promptReadFailuresByPath.set(node.prompt, taskPrompt.failure);
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
        promptReadFailuresByPath.set(block.prompt, blockPrompt.failure);
      }
    }
  }

  return { promptIndex, promptReadFailuresByPath, diagnostics };
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

export async function loadPlanGraphPackage(
  projectRoot: PackageWorkspaceRef,
  options: { snapshot?: PlanGraphPackageSnapshot } = {}
): Promise<LoadedPlanGraphPackage> {
  if (options.snapshot) {
    return loadPlanGraphPackageFromSnapshot(options.snapshot);
  }
  const { workspace, manifest } = await loadPackage(projectRoot);
  const owners = packagePromptOwners(manifest);
  const targets = await resolvePackagePromptTargets(workspace.packageDir, owners.keys(), {
    includeOrphans: true,
    manifestPaths: originalPromptPaths(owners)
  });
  const captured = await capturePackagePrompts(targets, "content", owners);
  const compiledGraph = compilePackageGraphFromPrompts(
    manifest,
    owners,
    targets.paths.keys(),
    captured.diagnostics
  );
  return loadPlanGraphPackageFromSnapshot({
    workspace,
    manifest,
    compiledGraph,
    promptMarkdownByPath: captured.markdown,
    promptDiagnosticsByPath: captured.failures
  });
}

export async function loadPlanGraphPackageFromSnapshot(
  input: PlanGraphPackageSnapshot
): Promise<LoadedPlanGraphPackage> {
  const { workspace, manifest, compiledGraph } = input;
  const { promptIndex, promptMarkdownByPath, promptReadFailuresByPath, diagnostics } =
    await readPromptIndex(
      manifest,
      workspace.packageDir,
      input.promptMarkdownByPath,
      input.promptDiagnosticsByPath
    );
  const fingerprint = packageFingerprintFromContent(manifest, promptMarkdownByPath);
  const graph = buildPlanGraph({
    manifest,
    compiledGraph,
    graphVersion: graphVersionFromPackageFingerprint(fingerprint),
    packageFingerprint: fingerprint,
    promptIndex,
    diagnostics
  });
  return { workspace, manifest, graph, promptMarkdownByPath, promptReadFailuresByPath };
}

export async function loadPlanGraphPackageMetadata(
  projectRoot: PackageWorkspaceRef
): Promise<LoadedPlanGraphPackage> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const compiledGraph = await compilePackageGraph(manifest, workspace.packageDir, {
    validatePromptContents: false
  });
  const { promptIndex, promptReadFailuresByPath, diagnostics } = await readPromptMetadataIndex(
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
  return {
    workspace,
    manifest,
    graph,
    promptMarkdownByPath: new Map(),
    promptReadFailuresByPath
  };
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
