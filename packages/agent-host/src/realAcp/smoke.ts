import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exampleExecutionEnvelopeInput,
  executeBlockCommandSchema,
  executionEnvelopeSchema,
  hashExecutionEnvelope
} from "@planweave-ai/agent-host-protocol";
import {
  ACP_SDK_AUTHORITY,
  executeAcp,
  DEFAULT_ACP_SHUTDOWN_POLICY,
  planWeaveAcpExecutionAuthentication,
  type AcpEngineEvent,
  type AcpEngineResult
} from "@planweave-ai/runtime";
import { AgentHostExecutionError } from "../execution/agentHostExecutor.js";
import { RemoteAcpExecutor } from "../execution/remoteAcpExecutor.js";
import type {
  AgentHostRemoteExecutionIdentity,
  AgentHostRemoteExecutionOutbox,
  AgentHostRemoteExecutionRecord
} from "../execution/remoteAcpPorts.js";
import { agentHostPackageVersion } from "../packageInfo.js";
import type { RealAcpGate } from "./gate.js";
import { preflightRealAcp, type RealAcpPreflightEvidence } from "./preflight.js";
import type { ResolvedRealAcpHostProfile } from "./resolveProfile.js";

/** Bounded, non-destructive smoke prompt. Assert protocol outcomes, not provider prose. */
export const REAL_ACP_SMOKE_PROMPT =
  "PlanWeave real-ACP compatibility check. Do not read or write local files, call tools, or execute commands. Reply with a one-line confirmation that the ACP session is active.";

export type RealAcpSmokeStageResult = {
  terminalState: string;
  sessionId: string | null;
  eventKinds: string[];
  lifecycleStates: string[];
  hasCapabilities: boolean;
  hasSessionStarted: boolean;
  hasTerminal: boolean;
  cleanupAttempted: boolean;
  cleanupCompleted: boolean;
  outputBytes: number;
  reportUploaded: boolean;
};

export type RealAcpSmokeEvidence = {
  version: "planweave.real-acp-host-smoke/v1";
  /** Authoritative evidence timestamp for release-gate TTL; never derived from file mtime. */
  generatedAt: string;
  gateMode: RealAcpGate["mode"];
  preflight: RealAcpPreflightEvidence;
  hostVersion: string;
  stages: {
    hostExecute: RealAcpSmokeStageResult | null;
    cancellation: RealAcpSmokeStageResult | null;
  };
  checks: {
    preflightReady: boolean;
    protocolNegotiated: boolean;
    sessionCreated: boolean;
    normalizedEvents: boolean;
    terminalSucceeded: boolean;
    artifactContract: boolean;
    cancellationObserved: boolean;
    cleanup: boolean;
    noCliFallback: true;
  };
  result: "passed" | "failed" | "skipped";
  disposition?: "skip" | "fail";
  diagnostic: string | null;
};

class MemoryOutbox implements AgentHostRemoteExecutionOutbox {
  readonly records: AgentHostRemoteExecutionRecord[] = [];

  append(record: AgentHostRemoteExecutionRecord): void {
    this.records.push(record);
  }

  forIdentity(identity: AgentHostRemoteExecutionIdentity): AgentHostRemoteExecutionRecord[] {
    return this.records.filter(
      (record) =>
        record.identity.dispatchId === identity.dispatchId &&
        record.identity.leaseId === identity.leaseId &&
        record.identity.executionAttemptId === identity.executionAttemptId
    );
  }
}

function emptyEvidence(kind: string): RealAcpPreflightEvidence {
  return {
    profileId: "unresolved",
    agentId: "unresolved",
    commandPath: "unresolved",
    agentVersion: null,
    verifiedAdapterVersion: "unresolved",
    protocolVersion: ACP_SDK_AUTHORITY.protocolVersion,
    sdkPackageVersion: ACP_SDK_AUTHORITY.packageVersion,
    capabilities: [],
    authenticationStatus: kind,
    agentInfoName: null
  };
}

function summarizeEngine(
  result: AcpEngineResult,
  events: readonly AcpEngineEvent[],
  reportUploaded: boolean
): RealAcpSmokeStageResult {
  return {
    terminalState: result.terminal.state,
    sessionId: result.sessionId,
    eventKinds: events.map((event) => event.kind),
    lifecycleStates: events
      .filter(
        (event): event is Extract<AcpEngineEvent, { kind: "lifecycle" }> =>
          event.kind === "lifecycle"
      )
      .map((event) => event.state),
    hasCapabilities: events.some((event) => event.kind === "capabilities"),
    hasSessionStarted: events.some((event) => event.kind === "session_started"),
    hasTerminal: events.some((event) => event.kind === "terminal"),
    cleanupAttempted: result.cleanup.attempted,
    cleanupCompleted: result.cleanup.completed,
    outputBytes: Buffer.byteLength(result.output, "utf8"),
    reportUploaded
  };
}

async function runHostExecutor(
  profile: ResolvedRealAcpHostProfile,
  cwd: string
): Promise<{ stage: RealAcpSmokeStageResult; errorCode?: string }> {
  const outbox = new MemoryOutbox();
  const dispatchId = `real-acp-smoke-${randomUUID()}`;
  const leaseId = `lease-${randomUUID()}`;
  const executionAttemptId = `attempt-${randomUUID()}`;
  const identity = { dispatchId, leaseId, executionAttemptId };
  const envelope = executionEnvelopeSchema.parse({
    ...exampleExecutionEnvelopeInput,
    agentId: profile.supported.agentId,
    agentProfileId: profile.supported.profileId,
    workspaceId: "smoke-workspace",
    renderedPrompt: REAL_ACP_SMOKE_PROMPT,
    session: {},
    requiredCapabilities: [],
    inputArtifacts: [],
    dependencySummaries: [],
    output: {
      reportRequired: true,
      maxArtifactBytes: 256 * 1024,
      maxArtifactCount: 1
    },
    execution: {
      ...exampleExecutionEnvelopeInput.execution,
      dispatchId,
      attemptId: executionAttemptId
    }
  });
  const command = executeBlockCommandSchema.parse({
    type: "execute_block",
    protocolVersion: 1,
    dispatchId,
    leaseId,
    executionAttemptId,
    leaseExpiresAt: new Date(Date.now() + 180_000).toISOString(),
    envelopeDigest: hashExecutionEnvelope(envelope),
    envelope
  });

  let uploaded = false;
  let uploadedBytes = 0;
  const executor = new RemoteAcpExecutor({
    workspaceResolver: { resolve: async () => ({ cwd }) },
    profileResolver: {
      resolve: async (agentProfileId, agentId) => {
        if (
          agentProfileId !== profile.supported.profileId ||
          agentId !== profile.supported.agentId
        ) {
          throw new Error("agent_host_profile_not_configured");
        }
        return profile.hostProfile;
      }
    },
    outbox,
    hostCapabilities: [],
    limits: {
      operationTimeoutMs: 120_000,
      interactionTimeoutMs: 5_000,
      outputMaxBytes: 256 * 1024
    }
  });

  let errorCode: string | undefined;
  try {
    await executor.execute(command, {
      signal: new AbortController().signal,
      executionKey: `${dispatchId}:${leaseId}:${executionAttemptId}`,
      artifacts: {
        download: async () => ({
          bytes: new Uint8Array(),
          mediaType: "application/octet-stream"
        }),
        upload: async ({ bytes }) => {
          uploaded = bytes.byteLength > 0;
          uploadedBytes = bytes.byteLength;
          return `artifact:sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
        }
      },
      sessionStart: { kind: "new" }
    });
  } catch (error) {
    if (error instanceof AgentHostExecutionError) {
      errorCode = error.failure.code;
    } else {
      errorCode = error instanceof Error ? error.name : "unknown_error";
    }
  }

  const engineEvents = outbox
    .forIdentity(identity)
    .filter((record) => record.kind === "engine_event")
    .map((record) => record.event);
  const terminal = engineEvents.filter((event) => event.kind === "terminal").at(-1);
  const sessionStarted = engineEvents.find((event) => event.kind === "session_started");
  return {
    errorCode,
    stage: {
      terminalState:
        terminal && terminal.kind === "terminal"
          ? terminal.terminal.state
          : errorCode
            ? "failed"
            : "unknown",
      sessionId:
        sessionStarted && sessionStarted.kind === "session_started"
          ? sessionStarted.sessionId
          : null,
      eventKinds: engineEvents.map((event) => event.kind),
      lifecycleStates: engineEvents
        .filter((event) => event.kind === "lifecycle")
        .map((event) => (event.kind === "lifecycle" ? event.state : "")),
      hasCapabilities: engineEvents.some((event) => event.kind === "capabilities"),
      hasSessionStarted: engineEvents.some((event) => event.kind === "session_started"),
      hasTerminal: engineEvents.some((event) => event.kind === "terminal"),
      cleanupAttempted: true,
      cleanupCompleted: engineEvents.some(
        (event) => event.kind === "lifecycle" && event.state === "cleanup"
      ),
      outputBytes: uploadedBytes,
      reportUploaded: uploaded
    }
  };
}

async function runCancellation(
  profile: ResolvedRealAcpHostProfile,
  cwd: string
): Promise<RealAcpSmokeStageResult> {
  const controller = new AbortController();
  const events: AcpEngineEvent[] = [];
  const run = executeAcp({
    launch: {
      trusted: true,
      command: profile.hostProfile.launch.command,
      args: profile.hostProfile.launch.args
    },
    workspace: { cwd },
    env: { ...profile.hostProfile.env },
    clientInfo: {
      name: "PlanWeave Real ACP Smoke Cancel",
      version: agentHostPackageVersion
    },
    shutdown: DEFAULT_ACP_SHUTDOWN_POLICY,
    prompt:
      "PlanWeave cancellation check. Keep the turn open with a long reasoned reply. Do not use tools or touch files.",
    sessionStart: { kind: "new" },
    authentication: planWeaveAcpExecutionAuthentication(profile.hostProfile.authentication),
    interactionBroker: {
      advertiseElicitation: false,
      requestPermission: async () => ({ kind: "cancel" }),
      requestElicitation: async () => ({ action: "cancel" })
    },
    eventSink: async (event) => {
      events.push(event);
      if (event.kind === "session_started" || event.kind === "lifecycle") {
        setTimeout(() => controller.abort(new Error("real_acp_smoke_cancel")), 50);
      }
    },
    signal: controller.signal,
    limits: {
      operationTimeoutMs: 30_000,
      interactionTimeoutMs: 3_000,
      promptMaxBytes: 64 * 1024,
      eventMaxBytes: 1_048_576,
      outputMaxBytes: 64 * 1024,
      inboundMessageMaxBytes: 1_048_576,
      stderrMaxBytes: 64 * 1024
    }
  });
  const timer = setTimeout(() => controller.abort(new Error("real_acp_smoke_cancel")), 1_500);
  try {
    const result = await run;
    return summarizeEngine(result, events, false);
  } finally {
    clearTimeout(timer);
  }
}

export async function runRealAcpSmoke(options: {
  gate: RealAcpGate;
  env?: Readonly<Record<string, string | undefined>>;
  evidencePath?: string;
}): Promise<RealAcpSmokeEvidence> {
  const workspace = await mkdtemp(join(tmpdir(), "planweave-real-acp-"));
  try {
    const preflight = await preflightRealAcp({
      gate: options.gate,
      cwd: workspace,
      env: options.env
    });

    if (preflight.status === "precondition") {
      const evidence: RealAcpSmokeEvidence = {
        version: "planweave.real-acp-host-smoke/v1",
        generatedAt: new Date().toISOString(),
        gateMode: options.gate.mode,
        preflight: preflight.evidence ?? emptyEvidence(preflight.precondition.kind),
        hostVersion: agentHostPackageVersion,
        stages: { hostExecute: null, cancellation: null },
        checks: {
          preflightReady: false,
          protocolNegotiated: false,
          sessionCreated: false,
          normalizedEvents: false,
          terminalSucceeded: false,
          artifactContract: false,
          cancellationObserved: false,
          cleanup: false,
          noCliFallback: true
        },
        result: preflight.precondition.disposition === "skip" ? "skipped" : "failed",
        disposition: preflight.precondition.disposition,
        diagnostic: `[${preflight.precondition.kind}] ${preflight.precondition.message}`
      };
      if (options.evidencePath) {
        await writeFile(options.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600
        });
      }
      return evidence;
    }

    // Host-local profile path through RemoteAcpExecutor (no CLI fallback).
    const hostRun = await runHostExecutor(preflight.profile, workspace);
    // Public ACP cancel/cleanup contract.
    const cancellation = await runCancellation(preflight.profile, workspace);

    const cancelOk =
      cancellation.terminalState === "cancelled" ||
      (cancellation.cleanupCompleted && cancellation.hasTerminal);

    const checks = {
      preflightReady: true,
      protocolNegotiated: hostRun.stage.hasCapabilities,
      sessionCreated:
        hostRun.stage.hasSessionStarted && typeof hostRun.stage.sessionId === "string",
      normalizedEvents: hostRun.stage.eventKinds.includes("lifecycle") && hostRun.stage.hasTerminal,
      terminalSucceeded:
        hostRun.stage.terminalState === "succeeded" && hostRun.errorCode === undefined,
      artifactContract: hostRun.stage.reportUploaded && hostRun.stage.outputBytes > 0,
      cancellationObserved: cancelOk,
      cleanup: hostRun.stage.cleanupCompleted && cancellation.cleanupCompleted,
      noCliFallback: true as const
    };

    const passed = Object.values(checks).every(Boolean);
    const evidence: RealAcpSmokeEvidence = {
      version: "planweave.real-acp-host-smoke/v1",
      generatedAt: new Date().toISOString(),
      gateMode: options.gate.mode,
      preflight: preflight.evidence,
      hostVersion: agentHostPackageVersion,
      stages: {
        hostExecute: hostRun.stage,
        cancellation
      },
      checks,
      result: passed ? "passed" : "failed",
      diagnostic: passed
        ? null
        : `Real ACP smoke checks failed: ${Object.entries(checks)
            .filter(([, value]) => !value)
            .map(([key]) => key)
            .join(", ")}${hostRun.errorCode ? `; hostError=${hostRun.errorCode}` : ""}`
    };

    if (options.evidencePath) {
      await writeFile(options.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
    }
    return evidence;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
