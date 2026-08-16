import { ACP_SDK_AUTHORITY, createAcpConnection } from "./acpConnection.js";
import type { AcpPreflightProbe } from "./acpRunner.js";
import type { RunnerAuthenticationState, RunnerCapability } from "./runnerContractSchemas.js";
import {
  RequestError,
  type InitializeResponse,
  type NewSessionResponse
} from "@agentclientprotocol/sdk";
import { sessionConfigurationFromNewSession } from "./acpSessionConfiguration.js";
import {
  coordinateAcpAuthentication,
  AcpAuthenticationRequiredError,
  mayProbeSessionDespiteAuthRequired,
  type AcpAuthenticationOutcome
} from "./acpAuthentication.js";
import {
  availableExecutionHostEnvironmentVariables,
  prepareExecutionHostInvocation
} from "../process/wslExecutionHost.js";
import { AcpCleanupSequencer, createAcpCleanupDeadline } from "./acpExecutionCleanup.js";
import {
  AcpRequiredCapabilityError,
  gateAcpCapabilities,
  type AcpCapabilitySnapshot
} from "./acpCapabilityGate.js";

export { sessionConfigurationFromNewSession } from "./acpSessionConfiguration.js";
export { capabilitiesFromInitialize } from "./acpCapabilityGate.js";

export type AcpPreflightPhase = "initialize" | "capability" | "authentication" | "session";

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
  capabilitySnapshot: AcpCapabilitySnapshot;
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
    capabilities: options.capabilities,
    capabilitySnapshot: options.capabilitySnapshot
  };
}

export const probeInstalledAcpAgent: AcpPreflightProbe = async ({
  profile,
  environment,
  authenticationHints,
  cwd,
  host,
  signal
}) => {
  const launch = profile.launch;
  const env = environment.env;
  const prepared = await prepareExecutionHostInvocation({
    host,
    command: launch.command,
    args: launch.args,
    cwd,
    env
  });
  const availableEnvironmentVariables = availableExecutionHostEnvironmentVariables(host, env);
  const connection = createAcpConnection({
    launch: { trusted: true, command: prepared.command, args: prepared.args },
    cwd,
    spawnCwd: prepared.spawnCwd ?? null,
    env: prepared.spawnEnvironment,
    decorateProcessTree: prepared.decorateProcessTree,
    ...(prepared.cleanupExitedProcessTree
      ? { cleanupExitedProcessTree: prepared.cleanupExitedProcessTree }
      : {}),
    clientInfo: { name: "PlanWeave", version: "0.1.0" },
    shutdown: profile.shutdown
  });
  type ProbeResult = Awaited<ReturnType<AcpPreflightProbe>>;
  type ProbeOutcome =
    | { status: "pending" }
    | { status: "returned"; result: ProbeResult }
    | { status: "threw"; error: unknown };
  type CleanupOutcome = { status: "passed" } | { status: "failed"; error: unknown };
  let probeOutcome: ProbeOutcome = { status: "pending" };
  let cleanupOutcome: CleanupOutcome = { status: "passed" };
  let cleanup: AcpCleanupSequencer | undefined;
  const cleanupSequence = (): AcpCleanupSequencer => {
    cleanup ??= new AcpCleanupSequencer(
      createAcpCleanupDeadline(profile.shutdown.cleanupDeadlineMs)
    );
    return cleanup;
  };
  const closeProbeSession = (sessionId: string): Promise<unknown> => {
    const sequence = cleanupSequence();
    return sequence.run(
      "preflight session close",
      (timeoutMs) =>
        connection.closeSession(sessionId, {
          signal,
          timeoutMs,
          cleanupDeadline: sequence.deadline
        }),
      100
    );
  };
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
      let capabilitySnapshot: AcpCapabilitySnapshot;
      try {
        capabilitySnapshot = gateAcpCapabilities(profile.capabilities, initialized, {
          sessionStart: "new",
          connectionMode: profile.connection.mode
        });
      } catch (error) {
        throw new AcpPreflightPhaseError(
          error instanceof AcpRequiredCapabilityError ? "capability" : "initialize",
          error
        );
      }
      const capabilities = capabilitySnapshot.available;
      const agentInfo = capabilitySnapshot.agentInfo;
      let authenticationOutcome: AcpAuthenticationOutcome;
      try {
        authenticationOutcome = await coordinateAcpAuthentication({
          connection,
          initialized,
          hints: authenticationHints,
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
            agentInfo,
            capabilities,
            capabilitySnapshot,
            reason: authenticationOutcome.reason,
            methods: authenticationOutcome.methods
          });
        }
        let probeSession: NewSessionResponse;
        try {
          probeSession = await connection.newSession(
            { cwd: prepared.sessionCwd, mcpServers: [] },
            { signal }
          );
        } catch {
          const authenticationError = new AcpAuthenticationRequiredError(authenticationOutcome);
          return authRequiredResult({
            message: authenticationError.message,
            agentInfo,
            capabilities,
            capabilitySnapshot,
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
            await closeProbeSession(probeSession.sessionId);
          } catch (error) {
            throw new AcpPreflightPhaseError("session", error);
          }
        }
        return {
          kind: "ready",
          agentInfo,
          authentication: authenticationStateFromOutcome(recoveredAuth),
          capabilities,
          capabilitySnapshot,
          sessionConfig: sessionConfigurationFromNewSession(probeSession)
        };
      }

      let session: NewSessionResponse;
      try {
        session = await connection.newSession(
          { cwd: prepared.sessionCwd, mcpServers: [] },
          { signal }
        );
      } catch (error) {
        if (!isAuthRequiredError(error)) {
          throw new AcpPreflightPhaseError("session", error);
        }
        return authRequiredResult({
          message:
            "ACP agent requires authentication but did not advertise a headless-safe method. Authenticate with the agent, then retry.",
          agentInfo,
          capabilities,
          capabilitySnapshot,
          reason: "no_safe_method",
          methods: []
        });
      }
      if (initialized.agentCapabilities?.sessionCapabilities?.close != null) {
        try {
          await closeProbeSession(session.sessionId);
        } catch (error) {
          throw new AcpPreflightPhaseError("session", error);
        }
      }
      return {
        kind: "ready",
        agentInfo,
        authentication: authenticationStateFromOutcome(authenticationOutcome),
        capabilities,
        capabilitySnapshot,
        sessionConfig: sessionConfigurationFromNewSession(session)
      };
    })();
    probeOutcome = { status: "returned", result };
  } catch (error) {
    probeOutcome = { status: "threw", error };
  } finally {
    try {
      const sequence = cleanupSequence();
      await sequence.run("preflight connection disposal", (timeoutMs) =>
        connection.dispose({ timeoutMs, cleanupDeadline: sequence.deadline })
      );
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
