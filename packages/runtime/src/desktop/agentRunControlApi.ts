import { AgentRunControlLocator } from "../autoRun/agentRunControlLocator.js";
import type { AgentRunControlResponse } from "../autoRun/agentRunControlContract.js";
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
