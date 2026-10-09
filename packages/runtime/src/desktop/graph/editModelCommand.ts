import { compileTaskGraph } from "../../graph/compileTaskGraph.js";
import { withPackageFileConsistency } from "../../package/packageFileConsistency.js";
import { layoutPathForWorkspace } from "../layoutStore.js";
import { loadPackage, resolvePackageWorkspace } from "../../package/loadPackage.js";
import {
  executePlanGraphCommand,
  redoPlanGraphCommand,
  undoPlanGraphCommand,
  type PlanGraphCommandResult
} from "../../plangraph/index.js";
import type { GraphEditResult, PackageWorkspaceRef } from "../../types.js";
import type { DesktopLayout } from "../types.js";
import { getDesktopLayout, saveDesktopLayoutDirect } from "../layoutApi.js";
import { invalidateDesktopProjectProjection } from "./projectProjectionModel.js";

async function commandResult(
  projectRoot: PackageWorkspaceRef,
  result: PlanGraphCommandResult
): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  return {
    ok: result.ok && graph.diagnostics.errors.length === 0,
    graphVersion: result.graphVersion,
    ...(result.ok ? { committed: { graphVersion: result.graphVersion } } : {}),
    affectedTasks: result.ok ? result.affected.tasks : [],
    diagnostics: result.ok ? graph.diagnostics.errors : result.diagnostics,
    graph
  };
}

async function finishDesktopCommand(
  projectRoot: PackageWorkspaceRef,
  result: PlanGraphCommandResult,
  layoutSnapshot?: DesktopLayout | null
): Promise<GraphEditResult> {
  const resultWorkspace = result.ok ? result.workspaceRef : projectRoot;
  invalidateDesktopProjectProjection(resultWorkspace);
  if (!result.ok) return commandResult(resultWorkspace, result);
  try {
    const workspace = await resolvePackageWorkspace(resultWorkspace);
    await withPackageFileConsistency(
      [workspace.packageDir, layoutPathForWorkspace(workspace)],
      async () => {
        await applyLayoutNodeSideEffects(workspace, result);
        if (layoutSnapshot) await saveDesktopLayoutDirect(workspace, layoutSnapshot);
      }
    );
    return await commandResult(resultWorkspace, result);
  } catch (error) {
    return {
      ok: false,
      graphVersion: result.graphVersion,
      committed: { graphVersion: result.graphVersion },
      affectedTasks: result.affected.tasks,
      diagnostics: [
        {
          code: "desktop_post_commit_failed",
          message: error instanceof Error ? error.message : String(error)
        }
      ]
    };
  }
}

export async function executeDesktopPlanGraphCommand(
  projectRoot: PackageWorkspaceRef,
  command: Parameters<typeof executePlanGraphCommand>[0]["command"],
  options: { layoutSnapshot?: DesktopLayout | null } = {}
): Promise<GraphEditResult> {
  const result = await executePlanGraphCommand({ projectRoot, command });
  return finishDesktopCommand(projectRoot, result, options.layoutSnapshot);
}

export async function undoDesktopPlanGraphCommand(
  projectRoot: PackageWorkspaceRef
): Promise<GraphEditResult> {
  return finishDesktopCommand(projectRoot, await undoPlanGraphCommand({ projectRoot }));
}

export async function redoDesktopPlanGraphCommand(
  projectRoot: PackageWorkspaceRef
): Promise<GraphEditResult> {
  return finishDesktopCommand(projectRoot, await redoPlanGraphCommand({ projectRoot }));
}

async function applyLayoutNodeSideEffects(
  projectRoot: PackageWorkspaceRef,
  result: PlanGraphCommandResult
): Promise<void> {
  if (!result.ok) {
    return;
  }
  const command = result.command;
  if (command.type === "removeTask") {
    const layout = await getDesktopLayout(projectRoot);
    await saveDesktopLayoutDirect(projectRoot, {
      ...layout,
      nodes: layout.nodes.filter((node) => node.nodeId !== command.taskId)
    });
    return;
  }
  if (command.type !== "restoreTask" && command.type !== "addTask") {
    return;
  }
  if (!command.snapshot.layoutNode) {
    return;
  }
  const layout = await getDesktopLayout(projectRoot);
  const layoutNode = command.snapshot.layoutNode;
  await saveDesktopLayoutDirect(projectRoot, {
    ...layout,
    nodes: [...layout.nodes.filter((node) => node.nodeId !== layoutNode.nodeId), layoutNode]
  });
}
