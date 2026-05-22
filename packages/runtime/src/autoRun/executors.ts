import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { writeJsonFile } from "../json.js";
import { loadPackage, resolvePackageWorkspace } from "../package/loadPackage.js";
import type {
  ClaimResult,
  ExecutorAdapter,
  ExecutorAdapterResult,
  ExecutorProfile,
  ExecutorProfileSummary,
  ManifestTaskNode,
  PackageWorkspaceRef
} from "../types.js";

const builtinExecutors: Record<string, ExecutorProfile> = {
  default: { adapter: "manual" },
  manual: { adapter: "manual" },
  "codex-auto": { adapter: "codex-exec", command: "codex", args: ["exec", "-"] },
  "codex-reviewer": { adapter: "codex-exec", command: "codex", args: ["exec", "-"], role: "reviewer" }
};

type BlockClaim = Extract<ClaimResult, { kind: "block" }>;
type FeedbackClaim = Extract<ClaimResult, { kind: "feedback" }>;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function nextRunId(runRoot: string): Promise<string> {
  try {
    const entries = await readdir(runRoot, { withFileTypes: true });
    const count = entries.filter((entry) => entry.isDirectory() && /^RUN-\d+$/.test(entry.name)).length;
    return `RUN-${String(count + 1).padStart(3, "0")}`;
  } catch {
    return "RUN-001";
  }
}

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

async function prepareBlockRun(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  executorName: string;
  profile: ExecutorProfile;
  prompt: string;
}): Promise<{ runId: string; runDir: string; promptPath: string; metadataPath: string; startedAt: string }> {
  const { workspace } = await loadPackage(options.projectRoot);
  const { taskId, blockId } = parseBlockRef(options.claim.ref);
  const runRoot = join(workspace.resultsDir, taskId, "blocks", blockId, "runs");
  const runId = await nextRunId(runRoot);
  const runDir = join(runRoot, runId);
  const promptPath = join(runDir, "prompt.md");
  const metadataPath = join(runDir, "metadata.json");
  const startedAt = new Date().toISOString();
  await mkdir(runDir, { recursive: true });
  await writeFile(promptPath, options.prompt, "utf8");
  await writeJsonFile(metadataPath, {
    runId,
    ref: options.claim.ref,
    executor: options.executorName,
    adapter: options.profile.adapter,
    startedAt,
    finishedAt: null,
    exitCode: null,
    codexSessionId: null
  });
  return { runId, runDir, promptPath, metadataPath, startedAt };
}

async function finishRunMetadata(path: string, patch: Record<string, unknown>): Promise<void> {
  let previous: Record<string, unknown> = {};
  if (await pathExists(path)) {
    previous = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  }
  await writeJsonFile(path, { ...previous, ...patch });
}

async function execWithStdin(options: {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);
    }
    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({ stdout, stderr, exitCode: timedOut ? 124 : code ?? 1, timedOut });
    });
    child.stdin.end(options.stdin);
  });
}

function assertCodexExecProfile(profile: ExecutorProfile, name: string): Extract<ExecutorProfile, { adapter: "codex-exec" }> {
  if (profile.adapter !== "codex-exec") {
    throw new Error(`Executor profile '${name}' is '${profile.adapter}', not 'codex-exec'.`);
  }
  return profile;
}

function codexExecArgs(profile: Extract<ExecutorProfile, { adapter: "codex-exec" }>): string[] {
  if (!profile.sandbox) {
    return profile.args;
  }
  const stdinPromptIndex = profile.args.lastIndexOf("-");
  const sandboxArgs = ["--sandbox", profile.sandbox];
  if (stdinPromptIndex === -1) {
    return [...profile.args, ...sandboxArgs];
  }
  return [...profile.args.slice(0, stdinPromptIndex), ...sandboxArgs, ...profile.args.slice(stdinPromptIndex)];
}

function codexResumeArgs(profile: Extract<ExecutorProfile, { adapter: "codex-exec" }>, sessionId: string, prompt: string): string[] {
  const execIndex = profile.args.indexOf("exec");
  const prefix = execIndex === -1 ? [] : profile.args.slice(0, execIndex);
  const sandboxArgs = profile.sandbox ? ["--sandbox", profile.sandbox] : [];
  return [...prefix, "exec", ...sandboxArgs, "resume", sessionId, prompt];
}

function extractCodexSessionId(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      for (const key of ["codexSessionId", "sessionId", "session_id", "threadId", "thread_id"]) {
        const value = parsed[key];
        if (typeof value === "string" && value.trim()) {
          return value;
        }
      }
    } catch {
      const match = trimmed.match(/(?:codexSessionId|sessionId|session_id|threadId|thread_id)\s*[:=]\s*([A-Za-z0-9_.:-]+)/);
      if (match) {
        return match[1];
      }
    }
  }
  return null;
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
      const run = await prepareBlockRun({
        projectRoot: options.projectRoot,
        claim,
        executorName: name,
        profile,
        prompt
      });
      if (profile.adapter === "manual") {
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
      const codexProfile = assertCodexExecProfile(profile, name);
      const workspace = await resolvePackageWorkspace(options.projectRoot);
      const result = await execWithStdin({
        command: codexProfile.command,
        args: codexExecArgs(codexProfile),
        cwd: workspace.rootPath,
        stdin: prompt,
        timeoutMs: codexProfile.timeoutMs
      });
      let finalResult = result;
      let codexSessionId = extractCodexSessionId(`${result.stdout}\n${result.stderr}`);
      let resumed = false;
      if (result.exitCode !== 0 && codexSessionId) {
        const resumeResult = await execWithStdin({
          command: codexProfile.command,
          args: codexResumeArgs(codexProfile, codexSessionId, "continue this block and produce the required report"),
          cwd: workspace.rootPath,
          stdin: "",
          timeoutMs: codexProfile.timeoutMs
        });
        finalResult = {
          stdout: [result.stdout.trim(), "--- resume stdout ---", resumeResult.stdout.trim()].filter(Boolean).join("\n"),
          stderr: [result.stderr.trim(), "--- resume stderr ---", resumeResult.stderr.trim()].filter(Boolean).join("\n"),
          exitCode: resumeResult.exitCode,
          timedOut: result.timedOut || resumeResult.timedOut
        };
        codexSessionId = codexSessionId ?? extractCodexSessionId(`${resumeResult.stdout}\n${resumeResult.stderr}`);
        resumed = true;
      }
      const finishedAt = new Date().toISOString();
      await writeFile(join(run.runDir, "stdout.md"), finalResult.stdout, "utf8");
      await writeFile(join(run.runDir, "stderr.log"), finalResult.stderr, "utf8");
      await finishRunMetadata(run.metadataPath, {
        finishedAt,
        exitCode: finalResult.exitCode,
        command: codexProfile.command,
        args: codexExecArgs(codexProfile),
        sandbox: codexProfile.sandbox ?? null,
        role: codexProfile.role ?? null,
        timeoutMs: codexProfile.timeoutMs ?? null,
        timedOut: finalResult.timedOut,
        codexSessionId,
        resumed
      });
      if (finalResult.exitCode !== 0) {
        throw new Error(
          finalResult.timedOut
            ? `Executor '${name}' timed out after ${codexProfile.timeoutMs}ms.`
            : finalResult.stderr.trim() || `Executor '${name}' exited with code ${finalResult.exitCode}.`
        );
      }
      if (claim.blockType === "review") {
        const resultPath = join(run.runDir, "review-result.json");
        const trimmed = finalResult.stdout.trim();
        const parsed = JSON.parse(trimmed);
        await writeJsonFile(resultPath, parsed);
        return { kind: "review", resultPath, runId: run.runId, executor: name, adapter: "codex-exec", codexSessionId, ...finalResult };
      }
      const reportPath = join(run.runDir, "report.md");
      await writeFile(reportPath, finalResult.stdout, "utf8");
      return { kind: "block", reportPath, runId: run.runId, executor: name, adapter: "codex-exec", codexSessionId, ...finalResult };
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
      const codexProfile = assertCodexExecProfile(profile, name);
      return runCodexFeedback({
        projectRoot: workspace.rootPath,
        workspaceResultsDir: workspace.resultsDir,
        claim,
        name,
        profile: codexProfile
      });
    }
  };
}

async function runCodexFeedback(options: {
  projectRoot: string;
  workspaceResultsDir: string;
  claim: FeedbackClaim;
  name: string;
  profile: Extract<ExecutorProfile, { adapter: "codex-exec" }>;
}): Promise<ExecutorAdapterResult> {
  const runRoot = join(options.workspaceResultsDir, "feedback-runs");
  const runId = await nextRunId(runRoot);
  const runDir = join(runRoot, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "prompt.md"), options.claim.content, "utf8");
  const result = await execWithStdin({
    command: options.profile.command,
    args: codexExecArgs(options.profile),
    cwd: options.projectRoot,
    stdin: options.claim.content,
    timeoutMs: options.profile.timeoutMs
  });
  await writeFile(join(runDir, "stdout.md"), result.stdout, "utf8");
  await writeFile(join(runDir, "stderr.log"), result.stderr, "utf8");
  await writeJsonFile(join(runDir, "metadata.json"), {
    runId,
    executor: options.name,
    adapter: "codex-exec",
    startedAt: null,
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    timeoutMs: options.profile.timeoutMs ?? null,
    timedOut: result.timedOut,
    codexSessionId: null
  });
  if (result.exitCode !== 0) {
    throw new Error(
      result.timedOut
        ? `Executor '${options.name}' timed out after ${options.profile.timeoutMs}ms.`
        : result.stderr.trim() || `Executor '${options.name}' exited with code ${result.exitCode}.`
    );
  }
  const reportPath = join(runDir, "report.md");
  await writeFile(reportPath, result.stdout, "utf8");
  return { kind: "feedback", reportPath, runId, executor: options.name, adapter: "codex-exec", ...result };
}

export function createManualExecutorAdapter(options: { projectRoot: PackageWorkspaceRef; executorName?: string }): ExecutorAdapter {
  return createProfiledAdapter({ ...options, expectedAdapter: "manual" });
}

export function createCodexExecAdapter(options: { projectRoot: PackageWorkspaceRef; executorName?: string }): ExecutorAdapter {
  return createProfiledAdapter({ ...options, expectedAdapter: "codex-exec" });
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
