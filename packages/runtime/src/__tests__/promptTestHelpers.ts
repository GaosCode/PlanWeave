import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace } from "../initWorkspace.js";
import { writeJsonFile } from "../json.js";
import { canonicalProjectCanvasNode, writeProjectGraph } from "../projectGraph/index.js";
import { listExecutorProfiles } from "../autoRun/executors.js";
import { trustCommand } from "../taskManager/hookTrustStore.js";
import type {
  InitWorkspaceResult,
  PlanPackageManifest,
  ReviewHookDefinition,
  ReviewVerdict
} from "../types.js";

export function basicManifest(
  options: {
    parallel?: boolean;
    maxConcurrent?: number;
    reviewHook?: ReviewHookDefinition | null;
    reviewMaxFeedbackCycles?: number;
    taskDependsOn?: string[];
    includeSecondTask?: boolean;
  } = {}
): PlanPackageManifest {
  const secondTask = options.includeSecondTask
    ? [
        {
          id: "T-002",
          type: "task" as const,
          title: "Second task",
          prompt: "nodes/T-002/prompt.md",
          acceptance: ["Second implementation is complete."],
          blocks: [
            {
              id: "B-001",
              type: "implementation" as const,
              title: "Implement second task",
              prompt: "nodes/T-002/blocks/B-001.prompt.md",
              depends_on: [],
              parallel: { locks: ["second"] }
            },
            {
              id: "R-001",
              type: "review" as const,
              title: "Review second task",
              prompt: "nodes/T-002/blocks/R-001.prompt.md",
              depends_on: ["B-001"],
              review: {
                required: true,
                maxFeedbackCycles: options.reviewMaxFeedbackCycles ?? 1,
                hook: null
              }
            }
          ]
        }
      ]
    : [];

  const edges =
    options.taskDependsOn?.map((dependency) => ({
      from: "T-001",
      to: dependency,
      type: "depends_on" as const
    })) ?? [];

  return {
    version: "plan-package/v1",
    project: {
      title: "Test Plan",
      description: "Block-level runtime test plan."
    },
    execution: {
      parallel: {
        enabled: options.parallel ?? false,
        maxConcurrent: options.maxConcurrent ?? 1
      }
    },
    review: {
      maxFeedbackCycles: options.reviewMaxFeedbackCycles ?? 1,
      completionPolicy: "strict"
    },
    nodes: [
      {
        id: "T-001",
        type: "task",
        title: "Implement test task",
        prompt: "nodes/T-001/prompt.md",
        acceptance: ["Implementation is complete.", "Review passes."],
        blocks: [
          {
            id: "B-001",
            type: "implementation",
            title: "Implement task",
            prompt: "nodes/T-001/blocks/B-001.prompt.md",
            depends_on: [],
            parallel: { locks: ["shared"] }
          },
          {
            id: "R-001",
            type: "review",
            title: "Review task",
            prompt: "nodes/T-001/blocks/R-001.prompt.md",
            depends_on: ["B-001"],
            review: {
              required: true,
              maxFeedbackCycles: options.reviewMaxFeedbackCycles ?? 1,
              hook: options.reviewHook ?? null
            }
          }
        ]
      },
      ...secondTask
    ],
    edges
  };
}

export async function createTestWorkspace(
  manifest: PlanPackageManifest = basicManifest(),
  options: { trustPackageExecutors?: boolean } = {}
): Promise<{
  home: string;
  root: string;
  init: InitWorkspaceResult;
}> {
  const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
  const root = await mkdtemp(join(tmpdir(), "planweave-project-"));
  process.env.PLANWEAVE_HOME = home;
  const init = await initWorkspace({ projectRoot: root });
  await writeJsonFile(init.workspace.manifestFile, manifest);
  await writePromptFiles(init.workspace.packageDir, manifest);
  await writeProjectGraph(init.workspace, {
    version: "plan-project/v1",
    canvases: [canonicalProjectCanvasNode({ id: "default", title: manifest.project.title })],
    edges: [],
    crossTaskEdges: []
  });
  if (options.trustPackageExecutors !== false) {
    const profiles = await listExecutorProfiles({ projectRoot: root });
    for (const profile of profiles) {
      if (profile.source !== "package" || profile.adapter === "manual" || !("command" in profile)) {
        continue;
      }
      await trustCommand(root, profile.command, profile.args);
    }
  }
  return { home, root, init };
}

export async function writePromptFiles(
  packageDir: string,
  manifest: PlanPackageManifest
): Promise<void> {
  for (const node of manifest.nodes) {
    if (node.type !== "task") {
      continue;
    }
    await mkdir(join(packageDir, "nodes", node.id, "blocks"), { recursive: true });
    await writeFile(join(packageDir, node.prompt), `# ${node.id} task prompt\n`, "utf8");
    for (const block of node.blocks) {
      await writeFile(
        join(packageDir, block.prompt),
        `# ${node.id}#${block.id} ${block.type} prompt\n`,
        "utf8"
      );
    }
  }
}

export async function writeReport(
  root: string,
  name: string,
  content = "report\n"
): Promise<string> {
  const path = join(root, name);
  await writeFile(path, content, "utf8");
  return path;
}

export async function writeReviewResult(
  root: string,
  verdict: ReviewVerdict,
  content: string,
  ref = "T-001#R-001"
): Promise<string> {
  const path = join(root, `${verdict}-${Date.now()}-${Math.random()}.json`);
  await writeFile(
    path,
    JSON.stringify({
      reviewBlockRef: ref,
      taskId: ref.split("#")[0],
      verdict,
      content
    }),
    "utf8"
  );
  return path;
}
