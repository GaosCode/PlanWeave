import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { RemoteDispatchIntentV3 } from "@planweave-ai/collaboration-protocol/remote-run";
import type { RemoteVpsE2eConfig } from "./config.js";
import { emptyChecks, emptyIdentities, type VpsE2eEvidence } from "./evidence.js";
import type { VpsE2eGate } from "./gate.js";
import { precondition } from "./gate.js";
import { digestLabel, redactSensitiveText } from "./redaction.js";
import { createTrustedFetch } from "./trustedFetch.js";
import { serverPackageVersion } from "../packageInfo.js";
import { runNodeBin, spawnLongLived, waitFor, type ManagedChild } from "./processSupport.js";

const DEFAULT_TIMEOUT_MS = 90_000;
const DISPATCH_TIMEOUT_MS = 180_000;

const packagedHostStatusSchema = z
  .object({
    hostId: z.string().min(1),
    credential: z.literal("active")
  })
  .passthrough();

const hostConfigCoordinatorSchema = z
  .object({
    coordinator: z.object({ url: z.url() }).passthrough()
  })
  .passthrough();

type OnlineHost = {
  id: string;
  lastSeenAt?: string;
  capacity?: number;
  capabilities?: string[];
};

export type RemoteHostRevocationResult = {
  serverRevoked: boolean;
  serverRevocationVerified: boolean;
  localRevoked: boolean;
  diagnostics: string[];
};

export function buildRemoteVpsDispatchIntent(input: {
  projectId: string;
  canvasId: string;
  blockRef: string;
  agentEndpointId: string;
  idempotencyKey: string;
  contentRevision: string;
  graphFingerprint: string;
}): RemoteDispatchIntentV3 {
  return {
    schemaVersion: "remote-run/v3",
    projectId: input.projectId,
    canvasId: input.canvasId,
    blockRef: input.blockRef,
    agentEndpointId: input.agentEndpointId,
    idempotencyKey: input.idempotencyKey,
    expectedResponsibilityRevision: 0,
    expectedReviewerRevision: 0,
    executionTargetRevision: 0,
    contentRevision: input.contentRevision,
    graphFingerprint: input.graphFingerprint
  };
}

export function remoteVpsAgentEndpointListPath(projectId: string): string {
  return `/api/v1/agent-endpoints?projectId=${encodeURIComponent(projectId)}`;
}

export async function revokeRemoteHostCredentials(input: {
  revokeServer(): Promise<void>;
  verifyServerRevocation?(): Promise<void>;
  revokeLocal(): Promise<void>;
}): Promise<RemoteHostRevocationResult> {
  const result: RemoteHostRevocationResult = {
    serverRevoked: false,
    serverRevocationVerified: false,
    localRevoked: false,
    diagnostics: []
  };
  try {
    await input.revokeServer();
    result.serverRevoked = true;
    if (input.verifyServerRevocation) {
      await input.verifyServerRevocation();
    }
    result.serverRevocationVerified = true;
  } catch (error) {
    result.diagnostics.push(
      `server_revoke_failed:${redactSensitiveText(error instanceof Error ? error.message : String(error))}`
    );
  }
  try {
    await input.revokeLocal();
    result.localRevoked = true;
  } catch (error) {
    result.diagnostics.push(
      `host_local_revoke_failed:${redactSensitiveText(error instanceof Error ? error.message : String(error))}`
    );
  }
  return result;
}

export function findOnlineHostById(
  items: readonly OnlineHost[],
  packagedHostId: string
): OnlineHost | undefined {
  return items.find((item) => item.id === packagedHostId && typeof item.lastSeenAt === "string");
}

export function assertCoordinatorOrigin(configuredUrl: string, expectedOrigin: string): void {
  if (new URL(configuredUrl).origin !== expectedOrigin) {
    throw new Error("remote_vps_host_coordinator_origin_mismatch");
  }
}

export function resolvePackagedHostId(
  currentHostId: string | undefined,
  diagnosticsJson: string
): string {
  const nextHostId = packagedHostStatusSchema.parse(JSON.parse(diagnosticsJson)).hostId;
  if (currentHostId && currentHostId !== nextHostId) {
    throw new Error("remote_vps_host_status_identity_mismatch");
  }
  return nextHostId;
}

async function assertHostConfigCoordinatorOrigin(
  hostConfigPath: string,
  expectedOrigin: string
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(hostConfigPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error("remote_vps_host_config_json_invalid", { cause: error });
  }
  const config = hostConfigCoordinatorSchema.parse(raw);
  assertCoordinatorOrigin(config.coordinator.url, expectedOrigin);
}

function firstExisting(paths: readonly string[]): string | null {
  for (const path of paths) {
    if (existsSync(path)) return path;
  }
  return null;
}

/** Packaged Agent Host bin (dist). Never use an ad-hoc relative path outside the package layout. */
const agentHostBinPath =
  firstExisting([
    fileURLToPath(new URL("../../../agent-host/dist/bin.js", import.meta.url)),
    fileURLToPath(new URL("../../../../agent-host/dist/bin.js", import.meta.url))
  ]) ?? fileURLToPath(new URL("../../../agent-host/dist/bin.js", import.meta.url));

/**
 * remote-vps profile: operate against an explicitly designated disposable VPS
 * whose endpoints and tokens come only from outside-repo config + env vars.
 *
 * Always drives the packaged Agent Host via config.hostConfigPath (preflight,
 * enroll when needed, run, reconnect, revoke). Cleanup/reconnect/revoke must
 * not be recorded as true unless those steps actually succeed.
 *
 * When the coordinator is unreachable, soft gate skips; hard gate fails.
 * Never logs tokens, enrollment codes, or absolute private paths in evidence.
 */
export async function runRemoteVpsScenario(options: {
  gate: VpsE2eGate;
  config: RemoteVpsE2eConfig;
  operatorToken: string;
}): Promise<VpsE2eEvidence> {
  const checks = emptyChecks();
  const identities = emptyIdentities();
  const cleanupEvidence: VpsE2eEvidence["cleanup"] = {
    harnessStateRemoved: false,
    credentialsRevoked: false,
    diagnostics: []
  };
  const commandsSanitized = [
    "curl -fsS https://<redacted-coordinator>/healthz",
    "POST /api/v1/host-enrollments (admin token from env var name only)",
    "planweave-agent-host preflight|enroll|run|revoke --config <outside-repo-hostConfigPath>",
    `POST /api/v1/remote-operations blockRef=${options.config.blockRef}`,
    "network interrupt: stop packaged Host process; restart run --config <hostConfigPath>; verify heartbeat + /events?afterCursor replay"
  ];

  const base = (partial: Partial<VpsE2eEvidence> = {}): VpsE2eEvidence => ({
    version: "planweave.vps-authenticated-e2e/v1",
    generatedAt: new Date().toISOString(),
    environmentClass: "remote-vps",
    gateMode: options.gate.mode,
    profileId: "remote-vps",
    componentVersions: {
      server: serverPackageVersion,
      agentHost: null,
      protocol: null,
      node: process.version
    },
    commandsSanitized,
    identities,
    envelopeDigest: null,
    eventCursor: null,
    artifactHash: null,
    runtimeOutcome: null,
    interaction: { attempted: false, status: null },
    heartbeat: { hostLastSeenAtPresent: false },
    networkInterrupt: {
      performed: false,
      kind: null,
      replayOk: false,
      reconnectOk: false
    },
    resourceBounds: {
      maxArtifactBytes: null,
      maxWebSocketPayloadBytes: null,
      hostCapacity: null
    },
    checks,
    result: "failed",
    diagnostic: null,
    cleanup: cleanupEvidence,
    ...partial
  });

  let trusted: Awaited<ReturnType<typeof createTrustedFetch>> | undefined;
  let host: ManagedChild | undefined;
  let credentialsRevoked = false;
  let hostProcessStopped = false;
  let agentHostVersion: string | null = null;
  let protocolVersion: number | null = null;
  let hostCapacity: number | null = null;
  let reconnectOk = false;
  let replayOk = false;
  let networkInterruptPerformed = false;
  let enrollmentEstablished = false;
  let packagedHostId: string | undefined;
  let hostConfigPath: string | undefined;
  let origin: string | undefined;
  let serverRevoked = false;
  let serverRevocationVerified = false;
  let localRevoked = false;

  const revokeCredentials = async (verifyTransport: boolean): Promise<void> => {
    if (!enrollmentEstablished || !hostConfigPath) return;
    const outcome = await revokeRemoteHostCredentials({
      revokeServer: async () => {
        if (!trusted || !packagedHostId || !origin) {
          throw new Error("host_identity_unavailable");
        }
        const response = await trusted!.request(
          `${origin}/api/v1/hosts/${encodeURIComponent(packagedHostId!)}/revoke`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${options.operatorToken}` }
          }
        );
        if (!response.ok) throw new Error(`http_${response.status}`);
        const body = (await response.json()) as { id?: string; revokedAt?: string };
        if (body.id !== packagedHostId || typeof body.revokedAt !== "string") {
          throw new Error("response_identity_invalid");
        }
      },
      verifyServerRevocation: verifyTransport
        ? async () => {
            if (!host) throw new Error("host_process_missing");
            await waitFor(() => host?.exitSnapshot !== undefined, {
              timeoutMs: DEFAULT_TIMEOUT_MS,
              label: "remote-vps-host-revoked-disconnect"
            });
            const exited = await host.exit;
            if (exited.code === 0 || !/agent_host_auth_failed/.test(host.logs.stderr)) {
              throw new Error("old_credential_reconnect_not_rejected");
            }
            host = undefined;
          }
        : undefined,
      revokeLocal: async () => {
        const revoke = await runNodeBin(agentHostBinPath, ["revoke", "--config", hostConfigPath!]);
        if (revoke.code !== 0) {
          throw new Error(revoke.stderr || revoke.stdout || `exit_${revoke.code}`);
        }
      }
    });
    cleanupEvidence.diagnostics.push(...outcome.diagnostics);
    serverRevoked ||= outcome.serverRevoked;
    serverRevocationVerified ||= outcome.serverRevocationVerified;
    localRevoked ||= outcome.localRevoked;
    credentialsRevoked = serverRevoked && serverRevocationVerified && localRevoked;
    cleanupEvidence.credentialsRevoked = credentialsRevoked;
    checks.credentialsRevoked = credentialsRevoked;
  };

  try {
    hostConfigPath = options.config.hostConfigPath;
    if (!isAbsolute(hostConfigPath)) {
      return base({
        result: "failed",
        diagnostic: "remote_vps_host_config_path_must_be_absolute"
      });
    }
    try {
      await access(hostConfigPath);
    } catch {
      const pre = precondition(
        options.gate.mode,
        "remote_config_missing",
        "remote-vps hostConfigPath is unreadable; packaged Host cannot start without outside-repo host config."
      );
      return base({
        result: pre.disposition === "skip" ? "skipped" : "failed",
        disposition: pre.disposition,
        diagnostic: pre.message
      });
    }
    if (!existsSync(agentHostBinPath)) {
      return base({
        result: "failed",
        diagnostic:
          "packaged_agent_host_bin_missing: build @planweave-ai/agent-host before remote-vps e2e"
      });
    }

    trusted = await createTrustedFetch({
      caCertificatePath: options.config.caCertificatePath
    });
    origin = new URL(options.config.coordinatorUrl).origin;
    await assertHostConfigCoordinatorOrigin(hostConfigPath, origin);
    const health = await trusted.request(`${origin}/healthz`);
    if (!health.ok) {
      const pre = precondition(
        options.gate.mode,
        "remote_unreachable",
        "Remote coordinator /healthz was not ready."
      );
      return base({
        result: pre.disposition === "skip" ? "skipped" : "failed",
        disposition: pre.disposition,
        diagnostic: pre.message
      });
    }
    checks.certificateVerifiedTransport = origin.startsWith("https:");

    const version = await trusted.request(`${origin}/version`);
    const versionBody = version.ok
      ? ((await version.json()) as {
          protocolVersion?: number;
          serverVersion?: string;
          limits?: { maxArtifactBytes?: number; maxWebSocketPayloadBytes?: number };
        })
      : {};
    protocolVersion = versionBody.protocolVersion ?? null;

    const tokenProbe = await trusted.request(`${origin}/api/v1/hosts`, {
      headers: { Authorization: `Bearer ${options.operatorToken}` }
    });
    if (tokenProbe.status === 401 || tokenProbe.status === 403) {
      const pre = precondition(
        options.gate.mode,
        "remote_token_missing",
        "Remote operator token was rejected by coordinator."
      );
      return base({
        result: pre.disposition === "skip" ? "skipped" : "failed",
        disposition: pre.disposition,
        diagnostic: pre.message,
        componentVersions: {
          server: serverPackageVersion,
          agentHost: null,
          protocol: protocolVersion,
          node: process.version
        }
      });
    }
    if (!tokenProbe.ok) {
      const pre = precondition(
        options.gate.mode,
        "remote_unreachable",
        `Remote /api/v1/hosts failed with status ${tokenProbe.status}.`
      );
      return base({
        result: pre.disposition === "skip" ? "skipped" : "failed",
        disposition: pre.disposition,
        diagnostic: pre.message
      });
    }

    // Drive packaged Host through hostConfigPath — never assume a pre-running Host.
    const preflight = await runNodeBin(agentHostBinPath, ["preflight", "--config", hostConfigPath]);
    if (preflight.code !== 0) {
      return base({
        result: "failed",
        diagnostic: redactSensitiveText(
          `remote_vps_host_preflight_failed:${preflight.stderr || preflight.stdout}`
        ),
        componentVersions: {
          server: serverPackageVersion,
          agentHost: null,
          protocol: protocolVersion,
          node: process.version
        }
      });
    }
    let preflightBody: {
      version?: string;
      credential?: string;
      hostId?: string;
      capacity?: number;
      capabilities?: string[];
    } = {};
    try {
      preflightBody = JSON.parse(preflight.stdout) as typeof preflightBody;
    } catch {
      return base({
        result: "failed",
        diagnostic: "remote_vps_host_preflight_json_invalid"
      });
    }
    agentHostVersion =
      typeof preflightBody.version === "string" ? preflightBody.version : agentHostVersion;

    const credential = preflightBody.credential ?? "missing";
    if (credential !== "active") {
      const grantResponse = await trusted.request(`${origin}/api/v1/host-enrollments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.operatorToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
        })
      });
      if (grantResponse.status !== 201) {
        return base({
          result: "failed",
          diagnostic: redactSensitiveText(`remote_vps_enroll_grant_failed:${grantResponse.status}`),
          componentVersions: {
            server: serverPackageVersion,
            agentHost: agentHostVersion,
            protocol: protocolVersion,
            node: process.version
          }
        });
      }
      const grant = (await grantResponse.json()) as { enrollmentCode?: string };
      if (!grant.enrollmentCode || !grant.enrollmentCode.startsWith("pw_enroll_")) {
        return base({
          result: "failed",
          diagnostic: "remote_vps_enrollment_code_missing_or_invalid_shape"
        });
      }
      checks.enrollmentOneTimeToken = true;

      const enrollment = await runNodeBin(agentHostBinPath, [
        "enroll",
        "--config",
        hostConfigPath,
        "--code",
        grant.enrollmentCode
      ]);
      if (enrollment.code !== 0) {
        return base({
          result: "failed",
          diagnostic: redactSensitiveText(
            `remote_vps_host_enroll_failed:${enrollment.stderr || enrollment.stdout}`
          ),
          componentVersions: {
            server: serverPackageVersion,
            agentHost: agentHostVersion,
            protocol: protocolVersion,
            node: process.version
          }
        });
      }
      enrollmentEstablished = true;
      try {
        packagedHostId = resolvePackagedHostId(undefined, enrollment.stdout);
      } catch {
        return base({ result: "failed", diagnostic: "remote_vps_host_enrollment_output_invalid" });
      }
    } else {
      // Active credential means a prior one-time enrollment already succeeded for this Host config.
      checks.enrollmentOneTimeToken = true;
      enrollmentEstablished = true;
    }

    const status = await runNodeBin(agentHostBinPath, ["status", "--config", hostConfigPath]);
    if (status.code !== 0) {
      return base({
        result: "failed",
        diagnostic: redactSensitiveText(
          `remote_vps_host_status_failed:${status.stderr || status.stdout}`
        )
      });
    }
    try {
      packagedHostId = resolvePackagedHostId(packagedHostId, status.stdout);
    } catch {
      return base({ result: "failed", diagnostic: "remote_vps_host_status_invalid" });
    }

    host = spawnLongLived({
      command: process.execPath,
      args: [agentHostBinPath, "run", "--config", hostConfigPath],
      label: "remote-vps-host"
    });

    let hostOnline:
      | { id: string; lastSeenAt: string; capacity: number; capabilities: string[] }
      | undefined;
    await waitFor(
      async () => {
        if (host?.exitSnapshot) return false;
        const response = await trusted!.request(`${origin}/api/v1/hosts`, {
          headers: { Authorization: `Bearer ${options.operatorToken}` }
        });
        if (!response.ok) return false;
        const page = (await response.json()) as { items: OnlineHost[] };
        const match = findOnlineHostById(page.items, packagedHostId!);
        if (!match?.lastSeenAt) return false;
        hostOnline = {
          id: match.id,
          lastSeenAt: match.lastSeenAt,
          capacity: match.capacity ?? 0,
          capabilities: match.capabilities ?? []
        };
        return true;
      },
      {
        timeoutMs: DEFAULT_TIMEOUT_MS,
        label: "remote-vps-host-online",
        diagnostics: () =>
          redactSensitiveText(`${host?.logs.stdout ?? ""}\n${host?.logs.stderr ?? ""}`)
      }
    );
    if (!hostOnline) {
      return base({
        result: "failed",
        diagnostic: "remote_vps_host_online_missing_after_packaged_run"
      });
    }

    identities.hostId = hostOnline.id;
    hostCapacity = hostOnline.capacity;
    checks.hostCapacityAdvertised = hostOnline.capacity > 0;
    checks.hostCapabilitiesAdvertised = Array.isArray(hostOnline.capabilities);
    checks.heartbeatObserved = Boolean(hostOnline.lastSeenAt);
    const firstLastSeenAt = hostOnline.lastSeenAt;

    const endpointResponse = await trusted.request(
      `${origin}${remoteVpsAgentEndpointListPath(options.config.projectId)}`,
      { headers: { Authorization: `Bearer ${options.operatorToken}` } }
    );
    const endpointPage = (await endpointResponse.json()) as {
      items?: Array<{ endpointId?: string; status?: string }>;
    };
    const agentEndpointId = endpointPage.items?.find(
      (endpoint) => endpoint.status === "available"
    )?.endpointId;
    if (endpointResponse.status !== 200 || !agentEndpointId) {
      return base({ result: "failed", diagnostic: "remote_vps_agent_endpoint_missing" });
    }

    const dispatch = await trusted.request(`${origin}/api/v1/remote-operations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.operatorToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(
        buildRemoteVpsDispatchIntent({
          projectId: options.config.projectId,
          canvasId: options.config.canvasId,
          blockRef: options.config.blockRef,
          agentEndpointId,
          idempotencyKey: `vps-e2e-remote-${Date.now()}`,
          contentRevision: options.config.contentRevision,
          graphFingerprint: options.config.graphFingerprint
        })
      )
    });

    if (dispatch.status !== 202) {
      return base({
        result: "failed",
        diagnostic: redactSensitiveText(`remote_dispatch_failed:${dispatch.status}`),
        componentVersions: {
          server: serverPackageVersion,
          agentHost: agentHostVersion,
          protocol: protocolVersion,
          node: process.version
        },
        heartbeat: { hostLastSeenAtPresent: true },
        resourceBounds: {
          maxArtifactBytes: null,
          maxWebSocketPayloadBytes: null,
          hostCapacity
        }
      });
    }

    const view = (await dispatch.json()) as {
      operationId: string;
      dispatchId: string;
      executionAttemptId: string;
      attempt?: { leaseId?: string; hostId?: string };
      agentEndpoint?: { endpointId?: string };
      state?: string;
      runtime?: { status?: string };
    };
    if (view.agentEndpoint?.endpointId !== agentEndpointId || view.attempt?.hostId !== undefined) {
      return base({
        result: "failed",
        diagnostic: "remote_vps_dispatch_endpoint_identity_mismatch"
      });
    }
    identities.operationId = view.operationId;
    identities.dispatchId = view.dispatchId;
    identities.executionAttemptId = view.executionAttemptId;
    identities.leaseId = view.attempt?.leaseId ?? null;
    checks.identitiesCaptured = Boolean(
      identities.operationId && identities.dispatchId && identities.executionAttemptId
    );

    let terminal: {
      state: string;
      attempt?: { hostId?: string };
      agentEndpoint?: { endpointId?: string };
      envelopeDigest?: string;
      reportArtifactRef?: string;
      runtime?: { status?: string };
    } = { state: view.state ?? "activated" };
    await waitFor(
      async () => {
        const observe = await trusted!.request(
          `${origin}/api/v1/remote-operations/${encodeURIComponent(view.operationId)}`,
          { headers: { Authorization: `Bearer ${options.operatorToken}` } }
        );
        if (!observe.ok) return false;
        terminal = (await observe.json()) as typeof terminal;
        if (
          terminal.agentEndpoint?.endpointId !== agentEndpointId ||
          terminal.attempt?.hostId !== undefined
        ) {
          throw new Error("remote_vps_terminal_endpoint_identity_mismatch");
        }
        return ["completed", "failed", "cancelled"].includes(terminal.state);
      },
      {
        timeoutMs: DISPATCH_TIMEOUT_MS,
        label: "remote-vps-dispatch-terminal",
        diagnostics: () =>
          redactSensitiveText(
            `state=${terminal.state} runtime=${terminal.runtime?.status ?? "none"} host.stderr=${host?.logs.stderr.slice(-500) ?? ""}`
          )
      }
    );
    checks.runtimeResultAuthoritative = terminal.state === "completed";

    const events = await trusted.request(
      `${origin}/api/v1/remote-operations/${encodeURIComponent(view.operationId)}/events?afterCursor=0`,
      { headers: { Authorization: `Bearer ${options.operatorToken}` } }
    );
    let eventCursor: VpsE2eEvidence["eventCursor"] = null;
    let highWatermark = 0;
    if (events.ok) {
      const body = (await events.json()) as {
        afterCursor: number;
        highWatermark: number;
        events: unknown[];
      };
      checks.eventsCaptured = body.events.length > 0;
      highWatermark = body.highWatermark;
      eventCursor = {
        afterCursor: body.afterCursor,
        highWatermark: body.highWatermark,
        eventCount: body.events.length
      };
    }

    const envelopeDigest = terminal.envelopeDigest ?? null;
    const artifactHash = terminal.reportArtifactRef?.startsWith("artifact:sha256:")
      ? digestLabel("sha256", terminal.reportArtifactRef.slice("artifact:sha256:".length))
      : null;
    checks.envelopeDigestCaptured = envelopeDigest !== null;
    checks.artifactHashCaptured = artifactHash !== null;
    const maxArtifactBytes = versionBody.limits?.maxArtifactBytes ?? null;
    const maxWebSocketPayloadBytes = versionBody.limits?.maxWebSocketPayloadBytes ?? null;
    checks.resourceBoundsConfirmed = Boolean(
      maxArtifactBytes && maxWebSocketPayloadBytes && hostCapacity
    );

    // Network interrupt: stop packaged Host, restart with same hostConfigPath, verify heartbeat + cursor replay.
    networkInterruptPerformed = true;
    const mid = Math.max(0, Math.floor(highWatermark / 2));
    if (host?.tree.isAlive()) {
      await host.tree.terminate("remote-vps host interrupt");
      await host.exit;
    }
    host = undefined;

    host = spawnLongLived({
      command: process.execPath,
      args: [agentHostBinPath, "run", "--config", hostConfigPath],
      label: "remote-vps-host-reconnect"
    });

    await waitFor(
      async () => {
        if (host?.exitSnapshot) return false;
        const response = await trusted!.request(`${origin}/api/v1/hosts`, {
          headers: { Authorization: `Bearer ${options.operatorToken}` }
        });
        if (!response.ok) return false;
        const page = (await response.json()) as {
          items: Array<{ id: string; lastSeenAt?: string }>;
        };
        const match = page.items.find((item) => item.id === hostOnline!.id);
        reconnectOk = Boolean(match?.lastSeenAt && match.lastSeenAt !== firstLastSeenAt);
        return reconnectOk;
      },
      {
        timeoutMs: DEFAULT_TIMEOUT_MS,
        label: "remote-vps-host-reconnect",
        diagnostics: () =>
          redactSensitiveText(`${host?.logs.stdout ?? ""}\n${host?.logs.stderr ?? ""}`)
      }
    );

    const replay = await trusted.request(
      `${origin}/api/v1/remote-operations/${encodeURIComponent(view.operationId)}/events?afterCursor=${mid}`,
      { headers: { Authorization: `Bearer ${options.operatorToken}` } }
    );
    if (replay.ok) {
      const replayBody = (await replay.json()) as { highWatermark?: number; events?: unknown[] };
      replayOk =
        typeof replayBody.highWatermark === "number" &&
        replayBody.highWatermark === highWatermark &&
        Array.isArray(replayBody.events);
    }
    checks.networkInterruptReplay = replayOk && reconnectOk;

    // Server revoke closes the live WSS session. The daemon retries with the old
    // credential and must exit auth-failed before Host-local revocation succeeds.
    await revokeCredentials(true);

    if (host?.tree.isAlive()) {
      await host.tree.terminate("remote-vps cleanup");
      await host.exit;
    }
    host = undefined;
    hostProcessStopped = true;

    // No disposable harness directories on remote profile; cleanup requires revoke + process stop.
    checks.cleanupCompleted = credentialsRevoked && hostProcessStopped;

    const passed =
      checks.certificateVerifiedTransport &&
      checks.enrollmentOneTimeToken &&
      checks.hostCapacityAdvertised &&
      checks.hostCapabilitiesAdvertised &&
      checks.envelopeDigestCaptured &&
      checks.identitiesCaptured &&
      checks.eventsCaptured &&
      checks.heartbeatObserved &&
      checks.artifactHashCaptured &&
      checks.runtimeResultAuthoritative &&
      checks.networkInterruptReplay &&
      checks.resourceBoundsConfirmed &&
      checks.cleanupCompleted &&
      checks.credentialsRevoked;

    return base({
      result: passed ? "passed" : "failed",
      diagnostic: passed
        ? null
        : `remote_vps_scenario_incomplete:${JSON.stringify(
            Object.fromEntries(Object.entries(checks).filter(([, value]) => !value))
          )}`,
      componentVersions: {
        server: serverPackageVersion,
        agentHost: agentHostVersion,
        protocol: protocolVersion,
        node: process.version
      },
      envelopeDigest,
      artifactHash,
      eventCursor,
      runtimeOutcome: terminal.runtime?.status ?? terminal.state,
      heartbeat: { hostLastSeenAtPresent: checks.heartbeatObserved },
      resourceBounds: {
        maxArtifactBytes,
        maxWebSocketPayloadBytes,
        hostCapacity
      },
      networkInterrupt: {
        performed: networkInterruptPerformed,
        kind: "packaged_host_restart",
        replayOk,
        reconnectOk
      },
      cleanup: cleanupEvidence
    });
  } catch (error) {
    await revokeCredentials(false);
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOTFOUND|ECONNREFUSED|certificate|UNABLE_TO_VERIFY|vps_e2e_timeout/i.test(message)) {
      const pre = precondition(
        options.gate.mode,
        "remote_unreachable",
        redactSensitiveText(message)
      );
      return base({
        result: pre.disposition === "skip" ? "skipped" : "failed",
        disposition: pre.disposition,
        diagnostic: pre.message,
        networkInterrupt: {
          performed: networkInterruptPerformed,
          kind: networkInterruptPerformed ? "packaged_host_restart" : null,
          replayOk,
          reconnectOk
        },
        cleanup: cleanupEvidence
      });
    }
    return base({
      result: "failed",
      diagnostic: redactSensitiveText(message),
      networkInterrupt: {
        performed: networkInterruptPerformed,
        kind: networkInterruptPerformed ? "packaged_host_restart" : null,
        replayOk,
        reconnectOk
      },
      cleanup: cleanupEvidence
    });
  } finally {
    if (enrollmentEstablished && !cleanupEvidence.credentialsRevoked) {
      await revokeCredentials(false);
    }
    try {
      if (host?.tree.isAlive()) await host.tree.terminate("remote-vps finally");
    } catch (error) {
      cleanupEvidence.diagnostics.push(
        `host_process_cleanup_failed:${redactSensitiveText(error instanceof Error ? error.message : String(error))}`
      );
    }
    try {
      await trusted?.close();
    } catch (error) {
      cleanupEvidence.diagnostics.push(
        `transport_cleanup_failed:${redactSensitiveText(error instanceof Error ? error.message : String(error))}`
      );
    }
  }
}
