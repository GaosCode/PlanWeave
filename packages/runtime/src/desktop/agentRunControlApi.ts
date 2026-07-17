import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { AgentRunControlLocator } from "../autoRun/agentRunControlLocator.js";
import {
  agentRunControlActionSchema,
  type AgentRunControlAction,
  type AgentRunControlErrorCode,
  type AgentRunControlResponse
} from "../autoRun/agentRunControlContract.js";
import { runnerSessionActionIdentitySchema } from "../autoRun/runnerContractSchemas.js";
import { readJsonFile } from "../json.js";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import {
  AgentRunControlRunLocationError,
  locateCanonicalAgentRunControlDirectory
} from "./agentRunControlRunLocator.js";
import {
  desktopAgentRunControlInputSchema,
  desktopAgentRunControlResponseSchema,
  type DesktopAgentRunControlInput,
  type DesktopAgentRunControlResponse
} from "./types/agentRunControlTypes.js";

export type DesktopAgentRunControlApiOptions = {
  locator?: Pick<AgentRunControlLocator, "execute">;
};

export class DesktopAgentRunControlError extends Error {
  constructor(
    readonly code: AgentRunControlErrorCode,
    message: string,
    readonly commandId: string | null
  ) {
    super(message);
    this.name = "DesktopAgentRunControlError";
  }
}

function applicationResponse(response: AgentRunControlResponse): DesktopAgentRunControlResponse {
  return desktopAgentRunControlResponseSchema.parse(
    response.ok
      ? {
          ok: true,
          commandId: response.commandId,
          acceptedAt: response.acceptedAt,
          result: response.result
        }
      : {
          ok: false,
          commandId: response.commandId,
          code: response.code,
          message: response.message
        }
  );
}

function applicationError(
  code: "invalid_identity" | "not_active" | "protocol_mismatch",
  message: string
): DesktopAgentRunControlResponse {
  return desktopAgentRunControlResponseSchema.parse({
    ok: false,
    commandId: null,
    code,
    message
  });
}

export function assertDesktopAgentRunControlAccepted(
  response: DesktopAgentRunControlResponse
): void {
  if (!response.ok) {
    throw new DesktopAgentRunControlError(response.code, response.message, response.commandId);
  }
}

export async function executeDesktopAgentRunControlAtScope(
  rawAction: AgentRunControlAction,
  options: DesktopAgentRunControlApiOptions = {}
): Promise<DesktopAgentRunControlResponse> {
  const parsed = agentRunControlActionSchema.safeParse(rawAction);
  if (!parsed.success) {
    return applicationError(
      parsed.error.issues.some((issue) => issue.path.includes("identity"))
        ? "invalid_identity"
        : "protocol_mismatch",
      "Desktop agent control action does not match the application contract."
    );
  }
  const scope = parsed.data.identity.scope;
  try {
    const [entry, , metadataInput] = await Promise.all([
      lstat(scope),
      realpath(scope),
      readJsonFile<unknown>(`${scope}/metadata.json`)
    ]);
    if (!isAbsolute(scope) || !entry.isDirectory() || entry.isSymbolicLink()) {
      return applicationError("invalid_identity", "Agent control scope is not canonical.");
    }
    const metadata = z
      .object({
        executorRunId: z.string().min(1),
        desktopRunId: z.string().min(1),
        runSessionId: z.string().min(1),
        claimRef: z.string().min(1),
        sessionId: z.string().min(1)
      })
      .passthrough()
      .parse(metadataInput);
    const expected = runnerSessionActionIdentitySchema.parse({ scope, ...metadata });
    const actual = runnerSessionActionIdentitySchema.parse(parsed.data.identity);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      return applicationError(
        "invalid_identity",
        "Agent control identity does not match canonical run metadata."
      );
    }
  } catch {
    return applicationError("not_active", "Agent control canonical run is not available.");
  }
  const locator = options.locator ?? new AgentRunControlLocator();
  return applicationResponse(await locator.execute(scope, parsed.data));
}

export async function executeDesktopAgentRunControl(
  rawInput: DesktopAgentRunControlInput,
  options: DesktopAgentRunControlApiOptions = {}
): Promise<DesktopAgentRunControlResponse> {
  const parsed = desktopAgentRunControlInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return applicationError(
      parsed.error.issues.some((issue) => issue.path.includes("identity"))
        ? "invalid_identity"
        : "protocol_mismatch",
      "Desktop agent control input does not match the application contract."
    );
  }
  let workspace: Awaited<ReturnType<typeof resolveTaskCanvasWorkspace>>;
  try {
    workspace = await resolveTaskCanvasWorkspace(
      parsed.data.ref.projectRoot,
      parsed.data.ref.canvasId
    );
  } catch {
    return applicationError("not_active", "Selected project or canvas could not be resolved.");
  }
  let location: Awaited<ReturnType<typeof locateCanonicalAgentRunControlDirectory>>;
  try {
    location = await locateCanonicalAgentRunControlDirectory(workspace, parsed.data.recordId);
  } catch (error) {
    if (error instanceof AgentRunControlRunLocationError) {
      return applicationError(error.code, error.message);
    }
    return applicationError("not_active", "Run record directory could not be resolved.");
  }
  const identity = parsed.data.action.identity;
  if (
    identity.scope !== location.runDir ||
    identity.executorRunId !== location.executorRunId ||
    identity.claimRef !== location.claimRef
  ) {
    return applicationError(
      "invalid_identity",
      "Agent control identity does not match the selected canonical run record."
    );
  }
  const locator = options.locator ?? new AgentRunControlLocator();
  return applicationResponse(await locator.execute(location.runDir, parsed.data.action));
}
