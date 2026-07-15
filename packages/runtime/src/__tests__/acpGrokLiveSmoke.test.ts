import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  InitializeResponse,
  PromptResponse,
  SessionNotification
} from "@agentclientprotocol/sdk";
import { describe, it } from "vitest";
import {
  coordinateAcpAuthentication,
  type AcpAuthenticationOutcome
} from "../autoRun/acpAuthentication.js";
import {
  AcpOperationTimeoutError,
  createAcpConnection,
  type AcpConnection
} from "../autoRun/acpConnection.js";
import { resolveAgentDefinition } from "../autoRun/agentRegistry.js";
import type { AgentDefinition, AcpLaunchMetadata } from "../autoRun/agentRunner.js";
import { createGrokLiveSmokeAuthGuard } from "./acpGrokLiveSmokeAuthGuard.js";

const execFileAsync = promisify(execFile);
// biome-ignore lint/style/noProcessEnv: This live integration test is explicitly environment-gated.
const liveSmokeEnabled = process.env.PLANWEAVE_LIVE_GROK_ACP === "1";
const operationTimeoutMs = 120_000;
const liveTestTimeoutMs = 180_000;
const safeProcessErrorCodePattern = /^[A-Z][A-Z0-9_]*$/;
const expectedReply = "PLANWEAVE_GROK_SMOKE_OK";
const prompt =
  "This is a live ACP smoke check. Do not read or write local files, call tools, or execute " +
  `commands. Reply with exactly: ${expectedReply}`;

type LiveSmokeStage =
  | "command_version"
  | "initialize"
  | "authentication"
  | "session_new"
  | "prompt"
  | "session_close"
  | "cleanup";

const redactedLiveSmokeFailures = new WeakSet<Error>();

function liveSmokeFailure(stage: LiveSmokeStage, status: string): Error {
  const error = new Error(`Grok ACP live smoke failed at ${stage}: ${status}.`);
  error.name = "GrokLiveSmokeFailure";
  redactedLiveSmokeFailures.add(error);
  return error;
}

class PromptStreamEvidence {
  private activeSessionId: string | null = null;
  private streamedAgentMessage = false;
  private streamedToolActivity = false;
  private sawExpectedReply = false;
  private streamedText = "";

  readonly onSessionUpdate = (notification: SessionNotification): void => {
    if (notification.sessionId !== this.activeSessionId) {
      return;
    }
    const { update } = notification;
    if (update.sessionUpdate === "agent_message_chunk") {
      this.streamedAgentMessage = true;
      if (update.content.type === "text") {
        this.streamedText += update.content.text;
        this.sawExpectedReply ||= this.streamedText.includes(expectedReply);
      }
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.streamedToolActivity = true;
    }
  };

  activate(sessionId: string): void {
    this.activeSessionId = sessionId;
  }

  assertCompleted(response: PromptResponse): void {
    if (!this.streamedAgentMessage) {
      throw liveSmokeFailure("prompt", "agent_message_stream_missing");
    }
    if (!this.sawExpectedReply) {
      throw liveSmokeFailure("prompt", "fixed_reply_missing");
    }
    if (this.streamedToolActivity) {
      throw liveSmokeFailure("prompt", "unexpected_tool_activity");
    }
    if (response.stopReason === "cancelled") {
      throw liveSmokeFailure("prompt", "cancelled_stop_reason");
    }
  }
}

function safeErrorStatus(error: unknown): string {
  if (error instanceof AcpOperationTimeoutError) {
    return "timeout";
  }
  if (error instanceof Error) {
    let code: unknown;
    if ("code" in error) {
      ({ code } = error);
    }
    if (
      (typeof code === "number" && Number.isFinite(code)) ||
      (typeof code === "string" && safeProcessErrorCodePattern.test(code))
    ) {
      return `${error.name || "Error"}(code=${String(code)})`;
    }
    return error.name || "Error";
  }
  return "unknown_error";
}

function wrapFailure(stage: LiveSmokeStage, error: unknown): Error {
  if (error instanceof Error && redactedLiveSmokeFailures.has(error)) {
    return error;
  }
  return liveSmokeFailure(stage, safeErrorStatus(error));
}

async function runStage<T>(stage: LiveSmokeStage, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw wrapFailure(stage, error);
  }
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    // biome-ignore lint/style/noProcessEnv: The child must inherit the user's existing login environment.
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function assertAuthenticationOutcome(
  initialized: InitializeResponse,
  outcome: AcpAuthenticationOutcome,
  delegatedMethodId: string | null
): void {
  if (outcome.kind === "auth_required") {
    throw liveSmokeFailure("authentication", `action_required(${outcome.reason})`);
  }
  if (outcome.kind === "proceed") {
    if ((initialized.authMethods?.length ?? 0) !== 0) {
      throw liveSmokeFailure("authentication", "advertised_method_not_selected");
    }
    if (delegatedMethodId !== null) {
      throw liveSmokeFailure("authentication", "unexpected_authenticate_request");
    }
    return;
  }
  if (delegatedMethodId !== outcome.methodId) {
    throw liveSmokeFailure("authentication", "authentication_method_mismatch");
  }
}

async function verifyCommandVersion(launch: AcpLaunchMetadata): Promise<void> {
  const version = await runStage("command_version", () =>
    execFileAsync(launch.command, ["--version"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000
    })
  );
  if (`${version.stdout}${version.stderr}`.trim().length === 0) {
    throw liveSmokeFailure("command_version", "empty_version_output");
  }
}

async function exerciseConnection(
  connection: AcpConnection,
  definition: AgentDefinition,
  availableEnvironmentVariables: ReadonlySet<string>,
  evidence: PromptStreamEvidence
): Promise<void> {
  const initialized = await runStage("initialize", () => connection.initialize());
  const guardedAuthentication = createGrokLiveSmokeAuthGuard({
    connection,
    authMethods: initialized.authMethods,
    availableEnvironmentVariables,
    reject: (status) => liveSmokeFailure("authentication", status)
  });
  const authentication = await runStage("authentication", () =>
    coordinateAcpAuthentication({
      connection: guardedAuthentication.connection,
      initialized,
      hints: definition.acp.authentication,
      availableEnvironmentVariables
    })
  );
  assertAuthenticationOutcome(
    initialized,
    authentication,
    guardedAuthentication.delegatedMethodId()
  );

  const session = await runStage("session_new", () =>
    connection.newSession({ cwd: process.cwd(), mcpServers: [] })
  );
  evidence.activate(session.sessionId);
  const response = await runStage("prompt", () =>
    connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: prompt }]
    })
  );
  evidence.assertCompleted(response);

  const closeCapability = initialized.agentCapabilities?.sessionCapabilities?.close;
  if (closeCapability !== undefined && closeCapability !== null) {
    await runStage("session_close", () => connection.closeSession(session.sessionId));
  }
}

async function runWithCleanup(
  connection: AcpConnection,
  operation: () => Promise<void>
): Promise<void> {
  let failure: unknown;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  try {
    await connection.dispose();
  } catch (error) {
    failure ??= wrapFailure("cleanup", error);
  }
  if (failure !== undefined) {
    throw failure;
  }
}

async function runGrokLiveSmoke(): Promise<void> {
  const definition = resolveAgentDefinition("grok");
  const { launch } = definition.acp;
  if (!launch) {
    throw liveSmokeFailure("command_version", "launch_metadata_unavailable");
  }
  await verifyCommandVersion(launch);

  const environment = inheritedEnvironment();
  const evidence = new PromptStreamEvidence();
  const connection = createAcpConnection({
    launch: { trusted: true, command: launch.command, args: launch.args },
    cwd: process.cwd(),
    env: environment,
    clientInfo: { name: "planweave-grok-live-smoke", version: "1" },
    onSessionUpdate: evidence.onSessionUpdate,
    onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
    onElicitationRequest: async () => ({ action: "cancel" }),
    defaultTimeoutMs: operationTimeoutMs
  });
  await runWithCleanup(connection, () =>
    exerciseConnection(connection, definition, new Set(Object.keys(environment)), evidence)
  );
}

describe.skipIf(!liveSmokeEnabled)("Grok ACP live smoke", () => {
  it(
    "initializes, authenticates safely, streams a minimal prompt, and terminates",
    runGrokLiveSmoke,
    liveTestTimeoutMs
  );
});
