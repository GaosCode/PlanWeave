import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPackage, resolvePackageWorkspace } from "../package/loadPackage.js";
import type {
  ClaimResult,
  ExecutorAdapter,
  ExecutorProfile,
  ExecutorProfileSummary,
  ManifestTaskNode,
  PackageWorkspaceRef
} from "../types.js";
import { runCodexBlock, runCodexFeedback } from "./codexExecutor.js";
import { execWithStdin, nextRunId, prepareBlockRun, type BlockClaim } from "./executorShared.js";
import { runLocalReviewBlock, runLocalReviewFeedback } from "./localReviewExecutor.js";
import { runOpencodeBlock, runOpencodeFeedback } from "./opencodeExecutor.js";

const builtinExecutors: Record<string, ExecutorProfile> = {
  default: { adapter: "manual" },
  manual: { adapter: "manual" },
  "codex-auto": { adapter: "codex-exec", command: "codex", args: ["exec", "-"] },
  "codex-reviewer": { adapter: "codex-exec", command: "codex", args: ["exec", "-"], role: "reviewer" }
};

function taskNodeForClaim(manifest: Awaited<ReturnType<typeof loadPackage>>["manifest"], claim: BlockClaim): ManifestTaskNode {
  const node = manifest.nodes.find((item) => item.type === "task" && item.id === claim.taskId);
  if (node?.type !== "task") {
    throw new Error(`Task '${claim.taskId}' does not exist.`);
  }
  return node;
}

function resolveBlockExecutorName(manifest: Awaited<ReturnType<typeof loadPackage>>["manifest"], claim: BlockClaim, override?: string): string {
  const task = taskNodeForClaim(manifest, claim);
  const block = task.blocks.find((item) => item.id === claim.blockId);
  if (!block) {
    throw new Error(`Block '${claim.ref}' does not exist.`);
  }
  return override ?? block.executor ?? task.executor ?? manifest.execution.defaultExecutor ?? "default";
}

function profilesByName(manifest: Awaited<ReturnType<typeof loadPackage>>["manifest"]): Record<string, ExecutorProfile> {
  return {
    ...builtinExecutors,
    ...(manifest.executors ?? {})
  };
}

async function resolveProfileForClaim(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  executorName?: string;
}): Promise<{ name: string; profile: ExecutorProfile }> {
  const { manifest } = await loadPackage(options.projectRoot);
  const name = resolveBlockExecutorName(manifest, options.claim, options.executorName);
  const profile = profilesByName(manifest)[name];
  if (!profile) {
    throw new Error(`Executor profile '${name}' does not exist.`);
  }
  return { name, profile };
}

function createProfiledAdapter(options: {
  projectRoot: PackageWorkspaceRef;
  executorName?: string;
  expectedAdapter?: ExecutorProfile["adapter"];
}): ExecutorAdapter {
  return {
    async runBlock({ claim, prompt }) {
      const { name, profile } = await resolveProfileForClaim({
        projectRoot: options.projectRoot,
        claim,
        executorName: options.executorName
      });
      if (options.expectedAdapter && profile.adapter !== options.expectedAdapter) {
        throw new Error(`Executor profile '${name}' is '${profile.adapter}', not '${options.expectedAdapter}'.`);
      }
      if (profile.adapter === "manual") {
        const run = await prepareBlockRun({
          projectRoot: options.projectRoot,
          claim,
          executorName: name,
          profile,
          prompt
        });
        return {
          kind: "manual",
          executor: name,
          adapter: "manual",
          promptPath: run.promptPath,
          runDir: run.runDir,
          runId: run.runId,
          nextCommand:
            claim.blockType === "review"
              ? `planweave submit-review ${claim.ref} --result <review-result.json>`
              : `planweave submit-result ${claim.ref} --report <report.md>`
        };
      }
      if (profile.adapter === "codex-exec") {
        return runCodexBlock({ projectRoot: options.projectRoot, claim, prompt, executorName: name, profile });
      }
      if (profile.adapter === "opencode-exec") {
        return runOpencodeBlock({ projectRoot: options.projectRoot, claim, prompt, executorName: name, profile });
      }
      return runLocalReviewBlock({ projectRoot: options.projectRoot, claim, prompt, executorName: name, profile });
    },
    async runFeedback({ claim }) {
      const { manifest, workspace } = await loadPackage(options.projectRoot);
      const name = options.executorName ?? manifest.execution.defaultExecutor ?? "default";
      const profile = profilesByName(manifest)[name];
      if (!profile) {
        throw new Error(`Executor profile '${name}' does not exist.`);
      }
      if (options.expectedAdapter && profile.adapter !== options.expectedAdapter) {
        throw new Error(`Executor profile '${name}' is '${profile.adapter}', not '${options.expectedAdapter}'.`);
      }
      if (profile.adapter === "manual") {
        const feedbackRoot = join(workspace.resultsDir, "feedback-runs");
        const runId = await nextRunId(feedbackRoot);
        const runDir = join(feedbackRoot, runId);
        await mkdir(runDir, { recursive: true });
        const promptPath = join(runDir, "feedback.md");
        await writeFile(promptPath, claim.content, "utf8");
        return {
          kind: "manual",
          executor: name,
          adapter: "manual",
          promptPath,
          runDir,
          runId,
          nextCommand: "planweave submit-feedback --report <report.md>"
        };
      }
      if (profile.adapter === "codex-exec") {
        return runCodexFeedback({
          projectRoot: workspace.rootPath,
          workspaceResultsDir: workspace.resultsDir,
          claim,
          executorName: name,
          profile
        });
      }
      if (profile.adapter === "opencode-exec") {
        return runOpencodeFeedback({
          projectRoot: workspace.rootPath,
          workspaceResultsDir: workspace.resultsDir,
          claim,
          executorName: name,
          profile
        });
      }
      return runLocalReviewFeedback({
        projectRoot: workspace.rootPath,
        workspaceResultsDir: workspace.resultsDir,
        claim,
        executorName: name,
        profile
      });
    }
  };
}

export function createManualExecutorAdapter(options: { projectRoot: PackageWorkspaceRef; executorName?: string }): ExecutorAdapter {
  return createProfiledAdapter({ ...options, expectedAdapter: "manual" });
}

export function createCodexExecAdapter(options: { projectRoot: PackageWorkspaceRef; executorName?: string }): ExecutorAdapter {
  return createProfiledAdapter({ ...options, expectedAdapter: "codex-exec" });
}

export function createOpencodeExecAdapter(options: { projectRoot: PackageWorkspaceRef; executorName?: string }): ExecutorAdapter {
  return createProfiledAdapter({ ...options, expectedAdapter: "opencode-exec" });
}

export function createLocalReviewAdapter(options: { projectRoot: PackageWorkspaceRef; executorName?: string }): ExecutorAdapter {
  return createProfiledAdapter({ ...options, expectedAdapter: "local-review" });
}

export function createExecutorAdapter(options: { projectRoot: PackageWorkspaceRef; executorName?: string }): ExecutorAdapter {
  return createProfiledAdapter(options);
}

export async function listExecutorProfiles(options: { projectRoot: PackageWorkspaceRef }): Promise<ExecutorProfileSummary[]> {
  const { manifest } = await loadPackage(options.projectRoot);
  const packageProfiles = manifest.executors ?? {};
  const summaries: ExecutorProfileSummary[] = Object.entries(builtinExecutors).map(([name, profile]) => ({
    name,
    source: "builtin",
    ...profile
  }));
  for (const [name, profile] of Object.entries(packageProfiles)) {
    const existing = summaries.findIndex((summary) => summary.name === name);
    const summary: ExecutorProfileSummary = { name, source: "package", ...profile };
    if (existing >= 0) {
      summaries[existing] = summary;
    } else {
      summaries.push(summary);
    }
  }
  return summaries;
}

export async function testExecutorProfile(options: { projectRoot: PackageWorkspaceRef; executorName: string }): Promise<{
  name: string;
  adapter: ExecutorProfile["adapter"];
  ok: boolean;
  message: string;
}> {
  const profiles = await listExecutorProfiles({ projectRoot: options.projectRoot });
  const profile = profiles.find((item) => item.name === options.executorName);
  if (!profile) {
    return { name: options.executorName, adapter: "manual", ok: false, message: `Executor profile '${options.executorName}' does not exist.` };
  }
  if (profile.adapter === "manual") {
    return { name: profile.name, adapter: profile.adapter, ok: true, message: "manual executor is always available" };
  }
  const result = await execWithStdin({
    command: profile.command,
    args: ["--version"],
    cwd: (await resolvePackageWorkspace(options.projectRoot)).rootPath,
    stdin: ""
  });
  return {
    name: profile.name,
    adapter: profile.adapter,
    ok: result.exitCode === 0,
    message: result.exitCode === 0 ? result.stdout.trim() : result.stderr.trim() || `exited with code ${result.exitCode}`
  };
}
