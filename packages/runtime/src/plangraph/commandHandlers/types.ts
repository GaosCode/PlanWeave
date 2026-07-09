import { parseBlockRef } from "../../graph/compileTaskGraph.js";
import type { PlanPackageGraphMutation } from "../../graph/mutation.js";
import type { ManifestBlock, ManifestTaskNode, PlanPackageManifest } from "../../types.js";
import type { PlanGraphCommand, PlanGraphCommandDiagnostic } from "../commands.js";
import type { LoadedPlanGraphPackage } from "../packageRepository.js";

export type PlanGraphCommandFamily = "dependency" | "task" | "block" | "review" | "layout";

export type PlanGraphCommandHandler<TCommand extends PlanGraphCommand = PlanGraphCommand> = {
  readonly family: PlanGraphCommandFamily;
  readonly commandTypes: readonly TCommand["type"][];
  handles(command: PlanGraphCommand): command is TCommand;
  mutation(
    loaded: LoadedPlanGraphPackage,
    command: TCommand
  ): PlanPackageGraphMutation | PlanGraphCommandDiagnostic;
  inverse(
    loaded: LoadedPlanGraphPackage,
    command: TCommand
  ): PlanGraphCommand | PlanGraphCommand[] | PlanGraphCommandDiagnostic;
  touchedRefs(
    command: TCommand,
    loaded: LoadedPlanGraphPackage
  ): { tasks: string[]; blocks: string[] };
};

export function diagnostic(
  code: string,
  message: string,
  path?: string
): PlanGraphCommandDiagnostic {
  return { code, message, path };
}

export function isPlanGraphCommandDiagnostic(value: unknown): value is PlanGraphCommandDiagnostic {
  return value !== null && typeof value === "object" && "code" in value && "message" in value;
}

export function snapshotOrDiagnostic<TSnapshot, TCommand extends PlanGraphCommand>(
  value: TSnapshot | PlanGraphCommandDiagnostic,
  build: (snapshot: TSnapshot) => TCommand
): TCommand | PlanGraphCommandDiagnostic {
  return isPlanGraphCommandDiagnostic(value) ? value : build(value);
}

export function taskFromManifest(
  manifest: PlanPackageManifest,
  taskId: string
): ManifestTaskNode | undefined {
  return manifest.nodes.find(
    (node): node is ManifestTaskNode => node.type === "task" && node.id === taskId
  );
}

export function blockFromManifest(
  manifest: PlanPackageManifest,
  blockRef: string
): { task: ManifestTaskNode; block: ManifestBlock } | undefined {
  const { taskId, blockId } = parseBlockRef(blockRef);
  const task = taskFromManifest(manifest, taskId);
  const block = task?.blocks.find((candidate) => candidate.id === blockId);
  return task && block ? { task, block } : undefined;
}

export function promptMarkdown(
  loaded: LoadedPlanGraphPackage,
  packagePath: string
): string | undefined {
  return loaded.promptMarkdownByPath.get(packagePath);
}
