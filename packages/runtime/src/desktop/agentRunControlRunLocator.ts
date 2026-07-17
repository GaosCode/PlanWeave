import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { claimRefSchema } from "../autoRun/runnerContractSchemas.js";
import { readJsonFile } from "../json.js";
import type { ProjectWorkspace } from "../types.js";
import { blockRunRoot } from "./recordsApi.js";
import { parseRunRecordId } from "./runRecordIdentity.js";

export type AgentRunControlRunLocation = {
  runDir: string;
  executorRunId: string;
  claimRef: string;
};

export class AgentRunControlRunLocationError extends Error {
  constructor(
    readonly code: "invalid_identity" | "not_active",
    message: string
  ) {
    super(message);
    this.name = "AgentRunControlRunLocationError";
  }
}

const feedbackMetadataIdentitySchema = z
  .object({
    ref: claimRefSchema,
    claimRef: claimRefSchema
  })
  .passthrough()
  .refine((metadata) => metadata.ref === metadata.claimRef, {
    message: "Feedback run metadata identity is inconsistent."
  });

function contained(root: string, candidate: string): boolean {
  if (!(isAbsolute(root) && isAbsolute(candidate))) return false;
  const nested = relative(resolve(root), resolve(candidate));
  return (
    nested === "" || (!nested.startsWith(`..${sep}`) && nested !== ".." && !isAbsolute(nested))
  );
}

export async function locateCanonicalAgentRunControlDirectory(
  workspace: ProjectWorkspace,
  recordId: string
): Promise<AgentRunControlRunLocation> {
  let parsed: ReturnType<typeof parseRunRecordId>;
  try {
    parsed = parseRunRecordId(recordId);
  } catch {
    throw new AgentRunControlRunLocationError(
      "invalid_identity",
      "Run record identity is invalid."
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(parsed.runId)) {
    throw new AgentRunControlRunLocationError("invalid_identity", "Run id is invalid.");
  }
  const runDir =
    parsed.kind === "block"
      ? join(blockRunRoot(workspace.resultsDir, parsed.blockRef), parsed.runId)
      : join(workspace.resultsDir, "feedback-runs", parsed.runId);
  if (!contained(workspace.resultsDir, runDir)) {
    throw new AgentRunControlRunLocationError(
      "invalid_identity",
      "Run record path escapes the selected canvas."
    );
  }
  try {
    const [metadata, realResultsDir, realRunDir] = await Promise.all([
      lstat(runDir),
      realpath(workspace.resultsDir),
      realpath(runDir)
    ]);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !contained(realResultsDir, realRunDir)
    ) {
      throw new AgentRunControlRunLocationError(
        "invalid_identity",
        "Run record path is not a canonical directory."
      );
    }
  } catch (error) {
    if (error instanceof AgentRunControlRunLocationError) throw error;
    throw new AgentRunControlRunLocationError(
      "not_active",
      "Run record directory is not available."
    );
  }

  let claimRef: string;
  if (parsed.kind === "block") {
    claimRef = parsed.blockRef;
  } else {
    try {
      const metadata = feedbackMetadataIdentitySchema.parse(
        await readJsonFile<unknown>(join(runDir, "metadata.json"))
      );
      claimRef = metadata.claimRef;
    } catch {
      throw new AgentRunControlRunLocationError(
        "invalid_identity",
        "Feedback run metadata identity is invalid."
      );
    }
  }
  return { runDir, executorRunId: parsed.runId, claimRef };
}
