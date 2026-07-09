import { execFile } from "node:child_process";
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";

export const execFileAsync = promisify(execFile);
export const repoRoot = resolve(import.meta.dirname, "../../../../..");
export const cliWorkflowTimeoutMs = 120_000;

export async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("pnpm", ["--silent", "--filter", "@planweave-ai/cli", "planweave", ...args], {
    cwd: repoRoot,
    env
  });
}

export async function runShellCommand(command: string, env: NodeJS.ProcessEnv, cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("sh", ["-c", command], {
    cwd,
    env
  });
}

export type CliFailure = Error & {
  code: number;
  stdout: string;
  stderr: string;
};

export function isCliFailure(error: unknown): error is CliFailure {
  const candidate = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
  return error instanceof Error && typeof candidate.code === "number" && typeof candidate.stdout === "string" && typeof candidate.stderr === "string";
}

export async function runCliExpectFailure(args: string[], env: NodeJS.ProcessEnv): Promise<CliFailure> {
  try {
    await runCli(args, env);
  } catch (error) {
    if (isCliFailure(error)) {
      return error;
    }
    throw error;
  }
  throw new Error(`Expected planweave ${args.join(" ")} to fail.`);
}

export function withoutInitCwd(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.INIT_CWD;
  return next;
}

export function shellQuoteArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

export async function installPlanweaveShim(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const shimPath = join(binDir, "planweave");
  await writeFile(
    shimPath,
    `#!/bin/sh\nexec ${shellQuoteArg(join(repoRoot, "node_modules", ".bin", "tsx"))} ${shellQuoteArg(join(repoRoot, "packages", "cli", "src", "index.ts"))} "$@"\n`,
    "utf8"
  );
  await chmod(shimPath, 0o755);
}

export type ExampleStatus = {
  tasks: Array<{ taskId: string; status: string; openFeedbackCount: number }>;
  blocks: Array<{ ref: string; status: string }>;
  currentRefs: string[];
  currentFeedbackId: string | null;
  currentReviewBlockRef: string | null;
  openFeedback: Array<unknown>;
  counts: {
    tasks: Record<string, number>;
    blocks: Record<string, number>;
    feedback: Record<string, number>;
  };
  orphanState: Array<unknown>;
  orphanResults: Array<unknown>;
};

export type ValidationReport = {
  ok: boolean;
  errors: Array<{ code: string }>;
  warnings: Array<{ code: string }>;
};

export type GraphQualityJsonReport = {
  ok: boolean;
  diagnostics: Array<{ code: string }>;
};

export type CreateCanvasWorkspaceJsonResult = {
  canvasId: string;
  title: string;
  created: boolean;
  activated: boolean;
  projectGraphPath: string;
  canvasRoot: string;
  packageDir: string;
  manifestPath: string;
  taskPromptsDir: string;
  blockPromptsDir: string;
  statePath: string;
  resultsDir: string;
  canvasValidationCommand: string;
  projectValidationCommand: string;
  qualityCommand: string;
};

export type GraphTestBlock = {
  id: string;
  prompt: string;
  type?: string;
  [key: string]: unknown;
};

export type GraphTestTask = {
  id: string;
  title: string;
  prompt: string;
  blocks: GraphTestBlock[];
  [key: string]: unknown;
};

export type GraphTestManifest = {
  nodes: GraphTestTask[];
  edges: Array<{ from: string; to: string; type: "depends_on" }>;
  [key: string]: unknown;
};

export function expectCompletedExampleStatus(status: ExampleStatus): void {
  expect(status.tasks.find((task) => task.taskId === "T-001")).toMatchObject({
    taskId: "T-001",
    status: "implemented",
    openFeedbackCount: 0
  });
  expect(status.blocks.find((block) => block.ref === "T-001#B-001")).toMatchObject({
    ref: "T-001#B-001",
    status: "completed"
  });
  expect(status.blocks.find((block) => block.ref === "T-001#R-001")).toMatchObject({
    ref: "T-001#R-001",
    status: "completed"
  });
  expect(status.currentRefs).toEqual([]);
  expect(status.currentFeedbackId).toBeNull();
  expect(status.currentReviewBlockRef).toBeNull();
  expect(status.openFeedback).toEqual([]);
  expect(status.counts.tasks.implemented).toBe(1);
  expect(status.counts.blocks.completed).toBe(2);
  expect(status.counts.feedback).toMatchObject({
    open: 0,
    in_progress: 0,
    resolved: 1,
    dismissed: 0
  });
  expect(status.orphanState).toEqual([]);
  expect(status.orphanResults).toEqual([]);
}

export function expectNoOrphanValidation(report: ValidationReport): void {
  expect(report.ok).toBe(true);
  expect(report.warnings.filter((warning) => warning.code === "orphan_state" || warning.code === "orphan_result")).toEqual([]);
}

export async function installTwoTaskGraphPackage(packageDir: string): Promise<void> {
  await cp(join(repoRoot, "examples/basic-plan-package/package"), packageDir, {
    recursive: true,
    force: true
  });
  const manifestPath = join(packageDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as GraphTestManifest;
  const firstTask = manifest.nodes[0];
  if (!firstTask) {
    throw new Error("Expected the basic package manifest to contain T-001.");
  }

  await cp(join(packageDir, "nodes", "T-001"), join(packageDir, "nodes", "T-002"), {
    recursive: true,
    force: true
  });
  const secondTask: GraphTestTask = {
    ...firstTask,
    id: "T-002",
    title: "Second graph task",
    prompt: "nodes/T-002/prompt.md",
    blocks: firstTask.blocks.map((block) => ({
      ...block,
      prompt: `nodes/T-002/blocks/${block.id}.prompt.md`
    }))
  };
  manifest.nodes = [firstTask, secondTask];
  manifest.edges = [{ from: "T-002", to: "T-001", type: "depends_on" }];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
