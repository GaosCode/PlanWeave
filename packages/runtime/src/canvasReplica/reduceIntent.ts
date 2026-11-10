import {
  canvasCommandIntentSchema,
  type CanvasCommandIntent
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import { buildCanvasCommandApplication } from "../graph/canvasCommandMutation.js";
import { manifestPromptPaths, type PlanPackageGraphMutationSideEffect } from "../graph/mutation.js";
import { parseCanvasReplicaDocument, type CanvasReplicaDocument } from "./document.js";
import { normalizeContentVersionPromptPath } from "@planweave-ai/collaboration-protocol/content/version";

function applySideEffect(
  prompts: Map<string, string>,
  sideEffect: PlanPackageGraphMutationSideEffect
): void {
  if (sideEffect.kind === "writePrompt") {
    prompts.set(normalizeContentVersionPromptPath(sideEffect.packagePath), sideEffect.markdown);
    return;
  }
  if (sideEffect.kind === "removePrompt") {
    prompts.delete(normalizeContentVersionPromptPath(sideEffect.packagePath));
    return;
  }
  throw new Error("Filesystem prompt link restoration is not supported by canvas replicas.");
}

/** Pure, deterministic application of one accepted collaboration intent. */
export function applyCanvasReplicaIntent(
  input: CanvasReplicaDocument,
  rawIntent: CanvasCommandIntent
): CanvasReplicaDocument {
  const document = parseCanvasReplicaDocument(input);
  const intent = canvasCommandIntentSchema.parse(rawIntent);
  const application = buildCanvasCommandApplication(document.manifest, document.layout, intent);
  const prompts = new Map(Object.entries(document.promptMarkdownByPath));
  const remainingPrompts = new Set(
    manifestPromptPaths(application.graphMutation.nextManifest).map(
      normalizeContentVersionPromptPath
    )
  );
  for (const sideEffect of application.graphMutation.sideEffects) {
    if (
      sideEffect.kind === "removePrompt" &&
      remainingPrompts.has(normalizeContentVersionPromptPath(sideEffect.packagePath))
    ) {
      continue;
    }
    applySideEffect(prompts, sideEffect);
  }
  return parseCanvasReplicaDocument({
    schemaVersion: document.schemaVersion,
    manifest: application.graphMutation.nextManifest,
    promptMarkdownByPath: Object.fromEntries(prompts),
    layout: application.nextLayout
  });
}
