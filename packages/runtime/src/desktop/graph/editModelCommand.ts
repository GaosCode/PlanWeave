import { compileTaskGraph } from "../../graph/compileTaskGraph.js";
import { loadPackage } from "../../package/loadPackage.js";
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

async function commandResult(projectRoot: PackageWorkspaceRef, result: PlanGraphCommandResult): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  return {
    ok: result.ok && graph.diagnostics.errors.length === 0,
    affectedTasks: result.ok ? result.affected.tasks : [],
    diagnostics: result.ok ? graph.diagnostics.errors : result.diagnostics,
    graph
  };
}

export async function executeDesktopPlanGraphCommand(
  projectRoot: PackageWorkspaceRef,
  command: Parameters<typeof executePlanGraphCommand>[0]["command"],
  options: { layoutSnapshot?: DesktopLayout | null } = {}
): Promise<GraphEditResult> {
  const result = await executePlanGraphCommand({ projectRoot, command });
  const resultWorkspace = result.ok ? result.workspaceRef : projectRoot;
  await applyLayoutNodeSideEffects(resultWorkspace, result);
  if (result.ok && options.layoutSnapshot) {
    await saveDesktopLayoutDirect(resultWorkspace, options.layoutSnapshot);
  }
  invalidateDesktopProjectProjection(resultWorkspace);
  return commandResult(resultWorkspace, result);
}

export async function undoDesktopPlanGraphCommand(projectRoot: PackageWorkspaceRef): Promise<GraphEditResult> {
  const result = await undoPlanGraphCommand({ projectRoot });
  const resultWorkspace = result.ok ? result.workspaceRef : projectRoot;
  await applyLayoutNodeSideEffects(resultWorkspace, result);
  invalidateDesktopProjectProjection(resultWorkspace);
  return commandResult(resultWorkspace, result);
}

export async function redoDesktopPlanGraphCommand(projectRoot: PackageWorkspaceRef): Promise<GraphEditResult> {
  const result = await redoPlanGraphCommand({ projectRoot });
  const resultWorkspace = result.ok ? result.workspaceRef : projectRoot;
  await applyLayoutNodeSideEffects(resultWorkspace, result);
  invalidateDesktopProjectProjection(resultWorkspace);
  return commandResult(resultWorkspace, result);
}

async function applyLayoutNodeSideEffects(projectRoot: PackageWorkspaceRef, result: PlanGraphCommandResult): Promise<void> {
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
