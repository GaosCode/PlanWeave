import { writeState } from "../state.js";
import type { BlockStatus, ExecutionGraphSession, PackageWorkspaceRef } from "../types.js";
import { loadRuntime, refreshDerivedState } from "./runtimeContext.js";
import { blockDependenciesCompleted, getBlock, openFeedbackForReview } from "./selectors.js";

export async function markBlockBlocked(options: { projectRoot: PackageWorkspaceRef; ref: string; reason: string; session?: ExecutionGraphSession }) {
  const context = await loadRuntime(options);
  const { workspace, manifest, graph } = context;
  const block = getBlock(graph, options.ref);
  if (!options.reason.trim()) {
    throw new Error("mark-blocked requires a non-empty reason.");
  }
  context.state.blocks[options.ref] = {
    ...context.state.blocks[options.ref],
    status: "blocked",
    blockedReason: options.reason.trim()
  };
  if (block.type === "review" && openFeedbackForReview(context.state, options.ref)) {
    throw new Error("Cannot mark a review block blocked while it has open feedback.");
  }
  context.state.currentRefs = context.state.currentRefs.filter((ref) => ref !== options.ref);
  await writeState(workspace.stateFile, refreshDerivedState(manifest, context.state));
  return { ref: options.ref, status: "blocked" as BlockStatus, reason: options.reason.trim() };
}

export async function markBlockDiverged(options: { projectRoot: PackageWorkspaceRef; ref: string; reason: string; session?: ExecutionGraphSession }) {
  const context = await loadRuntime(options);
  const { workspace, manifest, graph } = context;
  getBlock(graph, options.ref);
  if (!options.reason.trim()) {
    throw new Error("mark-diverged requires a non-empty reason.");
  }
  context.state.blocks[options.ref] = {
    ...context.state.blocks[options.ref],
    status: "diverged",
    divergenceReason: options.reason.trim()
  };
  context.state.currentRefs = context.state.currentRefs.filter((ref) => ref !== options.ref);
  await writeState(workspace.stateFile, refreshDerivedState(manifest, context.state));
  return { ref: options.ref, status: "diverged" as BlockStatus, reason: options.reason.trim() };
}

export async function unblockBlock(options: { projectRoot: PackageWorkspaceRef; ref: string; reason: string; session?: ExecutionGraphSession }) {
  const context = await loadRuntime(options);
  const { workspace, manifest, graph } = context;
  getBlock(graph, options.ref);
  if (!options.reason.trim()) {
    throw new Error("unblock requires a non-empty reason.");
  }
  const current = context.state.blocks[options.ref];
  if (current?.status !== "blocked") {
    throw new Error(`Block '${options.ref}' is not blocked.`);
  }
  context.state.blocks[options.ref] = {
    ...current,
    status: blockDependenciesCompleted(graph, context.state, options.ref) ? "ready" : "planned",
    blockedReason: null
  };
  await writeState(workspace.stateFile, refreshDerivedState(manifest, context.state));
  return { ref: options.ref, status: context.state.blocks[options.ref].status, reason: options.reason.trim() };
}

export async function resolveBlockDivergence(options: { projectRoot: PackageWorkspaceRef; ref: string; reason: string; session?: ExecutionGraphSession }) {
  const context = await loadRuntime(options);
  const { workspace, manifest, graph } = context;
  getBlock(graph, options.ref);
  const current = context.state.blocks[options.ref];
  if (current?.status !== "diverged") {
    throw new Error(`Block '${options.ref}' is not diverged.`);
  }
  if (!options.reason.trim()) {
    throw new Error("resolve-divergence requires a non-empty reason.");
  }
  context.state.blocks[options.ref] = {
    ...current,
    status: blockDependenciesCompleted(graph, context.state, options.ref) ? "ready" : "planned",
    divergenceReason: null
  };
  await writeState(workspace.stateFile, refreshDerivedState(manifest, context.state));
  return { ref: options.ref, status: context.state.blocks[options.ref].status, reason: options.reason.trim() };
}
