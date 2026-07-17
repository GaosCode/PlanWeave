import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  runnerInteractionActionIdentitySchema,
  runnerInteractionIdentitySchema,
  runnerInteractionIdentityMatches,
  runnerPermissionInteractionDecisionSchema,
  type RunnerInteractionErrorCode,
  type RunnerInteractionActionIdentity,
  type RunnerInteractionIdentity,
  type RunnerInteractionResponseReceipt,
  type RunnerInteractionSnapshot,
  type RunnerPermissionInteractionDecision
} from "../autoRun/runnerInteractionContract.js";
import {
  projectRunnerInteractionAvailability,
  readRunnerInteractionMailboxProjection,
  type RunnerInteractionAvailabilityReason
} from "../autoRun/runnerInteractionAvailability.js";
import {
  PersistentRunnerInteractionStore,
  RunnerInteractionStoreError
} from "../autoRun/runnerInteractionStore.js";
import { optionalReaddir, optionalStat } from "../fs/optionalFile.js";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { readJsonFile } from "../json.js";
import { loadPackage } from "../package/loadPackage.js";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import { blockRunRoot } from "./recordsApi.js";
import { parseRunRecordId, type ParsedRunRecordId } from "./runRecordIdentity.js";
import {
  runnerInteractionAuditSchema,
  runnerInteractionCanvasRefSchema,
  type RunnerInteractionAudit,
  type RunnerInteractionCanvasRef
} from "./types/acpBridgeTypes.js";

export {
  runnerInteractionAuditSchema,
  runnerInteractionCanvasRefSchema
} from "./types/acpBridgeTypes.js";
export type {
  RunnerInteractionAudit,
  RunnerInteractionCanvasRef
} from "./types/acpBridgeTypes.js";

export class RunnerInteractionApiError extends Error {
  constructor(
    readonly code: RunnerInteractionErrorCode,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "RunnerInteractionApiError";
  }
}

function canvasIdForResultsDir(resultsDir: string): string {
  return basename(dirname(resultsDir));
}

function assertContained(root: string, candidate: string): void {
  if (!(isAbsolute(root) && isAbsolute(candidate))) {
    throw new RunnerInteractionApiError(
      "interaction_path_invalid",
      "Runner interaction paths must be absolute."
    );
  }
  const nested = relative(resolve(root), resolve(candidate));
  if (nested === "" || (!nested.startsWith(`..${sep}`) && nested !== ".." && !isAbsolute(nested))) {
    return;
  }
  throw new RunnerInteractionApiError(
    "interaction_path_unsafe",
    "Runner interaction path escapes the selected canvas results directory."
  );
}

async function existingRunDirectories(ref: RunnerInteractionCanvasRef): Promise<{
  projectId: string;
  canvasId: string;
  resultsDir: string;
  runDirs: string[];
}> {
  let workspace: Awaited<ReturnType<typeof resolveTaskCanvasWorkspace>>;
  let manifest: Awaited<ReturnType<typeof loadPackage>>["manifest"];
  try {
    workspace = await resolveTaskCanvasWorkspace(ref.projectRoot, ref.canvasId);
    ({ manifest } = await loadPackage(workspace));
  } catch (error) {
    throw new RunnerInteractionApiError(
      "interaction_not_found",
      "Selected project or canvas could not be resolved.",
      { cause: error instanceof Error ? error.name : "unknown" }
    );
  }
  const runDirs: string[] = [];
  for (const node of manifest.nodes) {
    if (node.type !== "task") continue;
    for (const block of node.blocks) {
      const root = blockRunRoot(workspace.resultsDir, `${node.id}#${block.id}`);
      const entries = await optionalReaddir(root, { withFileTypes: true });
      for (const entry of entries ?? []) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".")) {
          runDirs.push(join(root, entry.name));
        }
      }
    }
  }
  const feedbackRoot = join(workspace.resultsDir, "feedback-runs");
  const feedbackEntries = await optionalReaddir(feedbackRoot, { withFileTypes: true });
  for (const entry of feedbackEntries ?? []) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".")) {
      runDirs.push(join(feedbackRoot, entry.name));
    }
  }
  return {
    projectId: workspace.id,
    canvasId: canvasIdForResultsDir(workspace.resultsDir),
    resultsDir: workspace.resultsDir,
    runDirs
  };
}

async function validateRunDirectory(resultsDir: string, runDir: string): Promise<void> {
  try {
    const [runEntry, realResultsDir, realRunDir] = await Promise.all([
      lstat(runDir),
      realpath(resultsDir),
      realpath(runDir)
    ]);
    if (!runEntry.isDirectory() || runEntry.isSymbolicLink()) {
      throw new RunnerInteractionApiError(
        "interaction_path_invalid",
        "Runner interaction run path must be a canonical directory."
      );
    }
    assertContained(realResultsDir, realRunDir);
  } catch (error) {
    if (error instanceof RunnerInteractionApiError) throw error;
    throw new RunnerInteractionApiError(
      "interaction_path_invalid",
      "Runner interaction canonical run path could not be resolved."
    );
  }
}

async function locateRunDirectory(
  scope: Awaited<ReturnType<typeof existingRunDirectories>>,
  identity: RunnerInteractionIdentity
): Promise<string> {
  parseBlockRef(identity.claimRef);
  const blockCandidate = join(
    blockRunRoot(scope.resultsDir, identity.claimRef),
    identity.executorRunId
  );
  const candidates = [
    blockCandidate,
    join(scope.resultsDir, "feedback-runs", identity.executorRunId)
  ];
  const existing = [];
  for (const candidate of candidates) {
    if ((await optionalStat(candidate))?.isDirectory()) existing.push(candidate);
  }
  if (existing.length !== 1) {
    throw new RunnerInteractionApiError(
      "interaction_not_found",
      "Runner interaction canonical run record was not found."
    );
  }
  await validateRunDirectory(scope.resultsDir, existing[0]!);
  return existing[0]!;
}

function parseActionRecordId(recordId: string): ParsedRunRecordId {
  let parsed: ParsedRunRecordId;
  try {
    parsed = parseRunRecordId(recordId);
  } catch {
    throw new RunnerInteractionApiError(
      "interaction_contract_invalid",
      "Runner interaction record id is invalid."
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(parsed.runId)) {
    throw new RunnerInteractionApiError(
      "interaction_contract_invalid",
      "Runner interaction executor run id is invalid."
    );
  }
  if (parsed.kind === "feedback" && !/^FE-[A-Za-z0-9._:-]+$/.test(parsed.feedbackId)) {
    throw new RunnerInteractionApiError(
      "interaction_contract_invalid",
      "Runner interaction feedback record id is invalid."
    );
  }
  return parsed;
}

async function locateRunDirectoryForAction(
  scope: Awaited<ReturnType<typeof existingRunDirectories>>,
  action: RunnerInteractionActionIdentity
): Promise<string> {
  const parsed = parseActionRecordId(action.recordId);
  const candidate =
    parsed.kind === "block"
      ? join(blockRunRoot(scope.resultsDir, parsed.blockRef), parsed.runId)
      : join(scope.resultsDir, "feedback-runs", parsed.runId);
  if (!(await optionalStat(candidate))?.isDirectory()) {
    throw new RunnerInteractionApiError(
      "interaction_not_found",
      "Runner interaction canonical run record was not found."
    );
  }
  await validateRunDirectory(scope.resultsDir, candidate);
  if (parsed.kind === "feedback") {
    const metadata = await readJsonFile<unknown>(join(candidate, "metadata.json"));
    const feedbackIdentity = z
      .object({ feedbackId: z.literal(parsed.feedbackId) })
      .passthrough()
      .safeParse(metadata);
    if (!feedbackIdentity.success) {
      throw new RunnerInteractionApiError(
        "interaction_identity_mismatch",
        "Runner interaction feedback identity does not match the canonical record."
      );
    }
  }
  return candidate;
}

export async function listPendingRunnerInteractions(
  rawRef: RunnerInteractionCanvasRef
): Promise<RunnerInteractionSnapshot[]> {
  return apiBoundary(async () => {
    const ref = runnerInteractionCanvasRefSchema.parse(rawRef);
    const scope = await existingRunDirectories(ref);
    const pending: RunnerInteractionSnapshot[] = [];
    for (const runDir of scope.runDirs) {
      await validateRunDirectory(scope.resultsDir, runDir);
      const projection = await readRunnerInteractionMailboxProjection({
        runDir,
        scope,
        metadata: {}
      });
      if (projection.diagnostic) {
        throw new RunnerInteractionApiError(
          "interaction_contract_invalid",
          projection.diagnostic.message,
          projection.diagnostic
        );
      }
      for (const interaction of projection.interactions) {
        if (interaction.available && interaction.snapshot) pending.push(interaction.snapshot);
      }
    }
    return pending.sort((left, right) =>
      left.request.requestedAt.localeCompare(right.request.requestedAt)
    );
  });
}

function availabilityError(reason: RunnerInteractionAvailabilityReason): RunnerInteractionApiError {
  if (reason === "owner_replaced") {
    return new RunnerInteractionApiError(
      "interaction_owner_replaced",
      "Runner owner was replaced."
    );
  }
  if (reason === "owner_unavailable") {
    return new RunnerInteractionApiError(
      "interaction_owner_unavailable",
      "Runner owner is unavailable."
    );
  }
  if (reason === "run_terminal") {
    return new RunnerInteractionApiError("interaction_run_terminal", "Runner run is terminal.");
  }
  if (reason === "answered" || reason === "expired") {
    return new RunnerInteractionApiError(
      "interaction_already_answered",
      "Runner interaction is already settled."
    );
  }
  if (reason === "legacy_history") {
    return new RunnerInteractionApiError(
      "interaction_not_found",
      "Runner interaction was not found."
    );
  }
  return new RunnerInteractionApiError(
    "interaction_contract_invalid",
    "Runner interaction persisted contract is invalid."
  );
}

async function apiBoundary<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RunnerInteractionApiError) throw error;
    if (error instanceof RunnerInteractionStoreError) {
      throw new RunnerInteractionApiError(error.code, error.message, error.details);
    }
    if (error instanceof z.ZodError) {
      throw new RunnerInteractionApiError(
        "interaction_contract_invalid",
        "Runner interaction API input or persisted contract is invalid."
      );
    }
    throw new RunnerInteractionApiError(
      "interaction_contract_invalid",
      "Runner interaction API boundary failed contract validation."
    );
  }
}

export async function respondToRunnerInteraction(
  rawRef: RunnerInteractionCanvasRef,
  rawIdentity: RunnerInteractionIdentity,
  rawDecision: RunnerPermissionInteractionDecision,
  rawAudit: RunnerInteractionAudit,
  options: { now?: () => Date; freshnessThresholdMs?: number } = {}
): Promise<RunnerInteractionResponseReceipt> {
  return apiBoundary(async () => {
    const ref = runnerInteractionCanvasRefSchema.parse(rawRef);
    const identity = runnerInteractionIdentitySchema.parse(rawIdentity);
    const decision = runnerPermissionInteractionDecisionSchema.parse(rawDecision);
    const audit = runnerInteractionAuditSchema.parse(rawAudit);
    const scope = await existingRunDirectories(ref);
    const runDir = await locateRunDirectory(scope, identity);
    return respondAtRunDirectory(scope, runDir, identity, decision, audit, options);
  });
}

async function respondAtRunDirectory(
  scope: Awaited<ReturnType<typeof existingRunDirectories>>,
  runDir: string,
  identity: RunnerInteractionIdentity,
  decision: RunnerPermissionInteractionDecision,
  audit: RunnerInteractionAudit,
  options: { now?: () => Date; freshnessThresholdMs?: number }
): Promise<RunnerInteractionResponseReceipt> {
  const [metadataInput, heartbeatInput, snapshot] = await Promise.all([
    readJsonFile<unknown>(join(runDir, "metadata.json")),
    readJsonFile<unknown>(join(runDir, "heartbeat.json")),
    new PersistentRunnerInteractionStore(runDir).readSnapshot(identity.requestId)
  ]);
  if (!runnerInteractionIdentityMatches(snapshot.request.identity, identity)) {
    throw new RunnerInteractionApiError(
      "interaction_identity_mismatch",
      "Runner interaction identity does not match the canonical request."
    );
  }
  const availability = projectRunnerInteractionAvailability({
    scope,
    metadata: metadataInput,
    heartbeat: heartbeatInput,
    snapshot,
    now: options.now,
    thresholdMs: options.freshnessThresholdMs
  });
  if (!availability.available) throw availabilityError(availability.reason!);
  return await new PersistentRunnerInteractionStore(runDir).createResponse({
    version: "planweave.runner-interaction-response/v1",
    identity,
    decision,
    respondedAt: (options.now ?? (() => new Date()))().toISOString(),
    decisionSource: audit.decisionSource,
    reason: audit.reason
  });
}

export async function respondToRunnerInteractionAction(
  rawRef: RunnerInteractionCanvasRef,
  rawAction: RunnerInteractionActionIdentity,
  rawDecision: RunnerPermissionInteractionDecision,
  rawAudit: RunnerInteractionAudit,
  options: { now?: () => Date; freshnessThresholdMs?: number } = {}
): Promise<RunnerInteractionResponseReceipt> {
  return apiBoundary(async () => {
    const ref = runnerInteractionCanvasRefSchema.parse(rawRef);
    const action = runnerInteractionActionIdentitySchema.parse(rawAction);
    const decision = runnerPermissionInteractionDecisionSchema.parse(rawDecision);
    const audit = runnerInteractionAuditSchema.parse(rawAudit);
    const scope = await existingRunDirectories(ref);
    const runDir = await locateRunDirectoryForAction(scope, action);
    const snapshot = await new PersistentRunnerInteractionStore(runDir).readSnapshot(
      action.requestId
    );
    const identity = snapshot.request.identity;
    const parsedRecord = parseActionRecordId(action.recordId);
    const recordMatches =
      identity.executorRunId === parsedRecord.runId &&
      (parsedRecord.kind === "feedback" || identity.claimRef === parsedRecord.blockRef);
    if (!recordMatches) {
      throw new RunnerInteractionApiError(
        "interaction_identity_mismatch",
        "Runner interaction record id does not match the canonical request."
      );
    }
    if (identity.ownerLeaseId !== action.ownerLeaseId) {
      throw new RunnerInteractionApiError(
        "interaction_owner_replaced",
        "Runner interaction owner lease was replaced."
      );
    }
    return respondAtRunDirectory(scope, runDir, identity, decision, audit, options);
  });
}
