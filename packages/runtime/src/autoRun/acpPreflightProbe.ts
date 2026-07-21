import { ACP_SDK_AUTHORITY, createAcpConnection } from "./acpConnection.js";
import type { AcpPreflightProbe } from "./acpRunner.js";
import type { RunnerAuthenticationState, RunnerCapability } from "./runnerContractSchemas.js";
import {
  RequestError,
  type InitializeResponse,
  type NewSessionResponse
} from "@agentclientprotocol/sdk";
import {
  executorAgentInfoSchema,
  invalidExecutorAgentInfoMessage
} from "./executorPreflightTypes.js";
import { sessionConfigurationFromNewSession } from "./acpSessionConfiguration.js";
import {
  coordinateAcpAuthentication,
  AcpAuthenticationRequiredError,
  hasAdvertisedAcpAuthenticationMethods,
  mayProbeSessionDespiteAuthRequired,
  type AcpAuthenticationOutcome
} from "./acpAuthentication.js";
import { agentProcessEnvRecord } from "../process/agentProcessEnv.js";

export { sessionConfigurationFromNewSession } from "./acpSessionConfiguration.js";

export type AcpPreflightPhase = "initialize" | "authentication" | "session";

export class AcpPreflightPhaseError extends Error {
  readonly phase: AcpPreflightPhase;

  constructor(phase: AcpPreflightPhase, error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    super(`ACP ${phase} failed: ${detail}`, { cause: error });
    this.name = "AcpPreflightPhaseError";
    this.phase = phase;
  }
}

export class AcpPreflightCleanupError extends AggregateError {
  readonly phase: AcpPreflightPhase | null;

  constructor(primaryError: unknown, cleanupError: unknown) {
    const primaryMessage =
      primaryError instanceof Error ? primaryError.message : String(primaryError);
    super([primaryError, cleanupError], primaryMessage, { cause: primaryError });
    this.name = "AcpPreflightCleanupError";
    this.phase = primaryError instanceof AcpPreflightPhaseError ? primaryError.phase : null;
  }
}

export function capabilitiesFromInitialize(initialized: InitializeResponse): RunnerCapability[] {
  const capabilities: RunnerCapability[] = [
    "session",
    "prompt",
    "cancel",
    "streaming",
    "tool-updates"
  ];
  const advertised = initialized.agentCapabilities;
  if (advertised?.promptCapabilities?.image === true) capabilities.push("image");
  if (advertised?.promptCapabilities?.embeddedContext === true) {
    capabilities.push("embedded-context");
  }
  if (advertised?.sessionCapabilities?.close != null) capabilities.push("session-close");
  if (advertised?.loadSession === true) capabilities.push("history-load");
  if (hasAdvertisedAcpAuthenticationMethods(initialized)) capabilities.push("authentication");
  return capabilities;
}

function isAuthRequiredError(error: unknown): error is RequestError {
  if (!(error instanceof RequestError) || error.code !== -32000) return false;
  const message = error.message.trim();
  return message === "Authentication required" || message.startsWith("Authentication required:");
}

function authenticationStateFromOutcome(
  outcome: Exclude<AcpAuthenticationOutcome, { kind: "auth_required" }>
): Extract<RunnerAuthenticationState, { status: "not_advertised" | "authenticated" }> {
  return outcome.kind === "authenticated"
    ? { status: "authenticated", methodId: outcome.methodId }
    : { status: "not_advertised" };
}

function authRequiredResult(options: {
  message: string;
  agentInfo: { name: string; version: string } | null;
  capabilities: RunnerCapability[];
  reason: Extract<RunnerAuthenticationState, { status: "action_required" }>["reason"];
  methods: Extract<RunnerAuthenticationState, { status: "action_required" }>["methods"];
}): Extract<Awaited<ReturnType<AcpPreflightProbe>>, { kind: "auth_required" }> {
  return {
    kind: "auth_required",
    message: options.message,
    agentInfo: options.agentInfo,
    authentication: {
      status: "action_required",
      reason: options.reason,
      methods: options.methods
    },
    capabilities: options.capabilities
  };
}

export const probeInstalledAcpAgent: AcpPreflightProbe = async ({ definition, cwd, signal }) => {
  const launch = definition.acp.launch;
  if (!launch) return { kind: "failed", message: "ACP launch metadata is unavailable." };
  // Match desktop agent detection: include common POSIX install dirs so GUI-launched
  // Electron (short PATH) can still resolve Homebrew/npm agent binaries.
  const env = agentProcessEnvRecord();
  const availableEnvironmentVariables = new Set(Object.keys(env));
  const connection = createAcpConnection({
    launch: { trusted: true, command: launch.command, args: launch.args },
    cwd,
    env,
    clientInfo: { name: "PlanWeave", version: "0.1.0" }
  });
  type ProbeResult = Awaited<ReturnType<AcpPreflightProbe>>;
  type ProbeOutcome =
    | { status: "pending" }
    | { status: "returned"; result: ProbeResult }
    | { status: "threw"; error: unknown };
  type CleanupOutcome = { status: "passed" } | { status: "failed"; error: unknown };
  let probeOutcome: ProbeOutcome = { status: "pending" };
  let cleanupOutcome: CleanupOutcome = { status: "passed" };
  try {
    const result = await (async (): Promise<ProbeResult> => {
      let initialized: InitializeResponse;
      try {
        initialized = await connection.initialize({ signal });
      } catch (error) {
        throw new AcpPreflightPhaseError("initialize", error);
      }
      if (initialized.protocolVersion !== ACP_SDK_AUTHORITY.protocolVersion) {
        throw new AcpPreflightPhaseError(
          "initialize",
          new Error(`ACP protocol version '${initialized.protocolVersion}' is not supported.`)
        );
      }
      const capabilities = capabilitiesFromInitialize(initialized);
      const rawAgentInfo = initialized.agentInfo;
      const agentInfo =
        rawAgentInfo === undefined
          ? { success: true as const, data: null }
          : executorAgentInfoSchema.safeParse(
              typeof rawAgentInfo === "object" && rawAgentInfo !== null
                ? { name: rawAgentInfo.name, version: rawAgentInfo.version }
                : rawAgentInfo
            );
      if (!agentInfo.success) {
        return {
          kind: "failed",
          message: invalidExecutorAgentInfoMessage
        };
      }
      let authenticationOutcome: AcpAuthenticationOutcome;
      try {
        authenticationOutcome = await coordinateAcpAuthentication({
          connection,
          initialized,
          hints: definition.acp.authentication,
          availableEnvironmentVariables,
          operationOptions: { signal }
        });
      } catch (error) {
        throw new AcpPreflightPhaseError("authentication", error);
      }

      // When the agent only advertises interactive/agent login methods, still try to open a
      // session: many CLIs (OpenCode, Pi, Claude) already hold credentials from terminal login.
      if (authenticationOutcome.kind === "auth_required") {
        if (!mayProbeSessionDespiteAuthRequired(authenticationOutcome)) {
          const authenticationError = new AcpAuthenticationRequiredError(authenticationOutcome);
          return authRequiredResult({
            message: authenticationError.message,
            agentInfo: agentInfo.data,
            capabilities,
            reason: authenticationOutcome.reason,
            methods: authenticationOutcome.methods
          });
        }
        let probeSession: NewSessionResponse;
        try {
          probeSession = await connection.newSession({ cwd, mcpServers: [] }, { signal });
        } catch {
          const authenticationError = new AcpAuthenticationRequiredError(authenticationOutcome);
          return authRequiredResult({
            message: authenticationError.message,
            agentInfo: agentInfo.data,
            capabilities,
            reason: authenticationOutcome.reason,
            methods: authenticationOutcome.methods
          });
        }
        const recoveredAuth = {
          kind: "authenticated" as const,
          methodId: authenticationOutcome.methods[0]?.id ?? "session"
        };
        if (initialized.agentCapabilities?.sessionCapabilities?.close != null) {
          try {
            await connection.closeSession(probeSession.sessionId, { signal });
          } catch (error) {
            throw new AcpPreflightPhaseError("session", error);
          }
        }
        return {
          kind: "ready",
          agentInfo: agentInfo.data,
          authentication: authenticationStateFromOutcome(recoveredAuth),
          capabilities,
          sessionConfig: sessionConfigurationFromNewSession(probeSession)
        };
      }

      let session: NewSessionResponse;
      try {
        session = await connection.newSession({ cwd, mcpServers: [] }, { signal });
      } catch (error) {
        if (!isAuthRequiredError(error)) {
          throw new AcpPreflightPhaseError("session", error);
        }
        return authRequiredResult({
          message:
            "ACP agent requires authentication but did not advertise a headless-safe method. Authenticate with the agent, then retry.",
          agentInfo: agentInfo.data,
          capabilities,
          reason: "no_safe_method",
          methods: []
        });
      }
      if (initialized.agentCapabilities?.sessionCapabilities?.close != null) {
        try {
          await connection.closeSession(session.sessionId, { signal });
        } catch (error) {
          throw new AcpPreflightPhaseError("session", error);
        }
      }
      return {
        kind: "ready",
        agentInfo: agentInfo.data,
        authentication: authenticationStateFromOutcome(authenticationOutcome),
        capabilities,
        sessionConfig: sessionConfigurationFromNewSession(session)
      };
    })();
    probeOutcome = { status: "returned", result };
  } catch (error) {
    probeOutcome = { status: "threw", error };
  } finally {
    try {
      await connection.dispose();
    } catch (error) {
      cleanupOutcome = { status: "failed", error };
    }
  }
  if (probeOutcome.status === "threw") {
    if (cleanupOutcome.status === "failed") {
      throw new AcpPreflightCleanupError(probeOutcome.error, cleanupOutcome.error);
    }
    throw probeOutcome.error;
  }
  if (cleanupOutcome.status === "failed") {
    throw cleanupOutcome.error;
  }
  if (probeOutcome.status === "returned") {
    return probeOutcome.result;
  }
  throw new Error("ACP preflight completed without a result.");
};
