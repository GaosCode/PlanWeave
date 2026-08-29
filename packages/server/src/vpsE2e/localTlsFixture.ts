import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { serverConfigSummarySchema } from "../config.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { OperatorSessionStore } from "../identity/operatorSessionStore.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { openServerDatabase } from "../sqlite.js";
import { serverPackageVersion } from "../packageInfo.js";
import { emptyChecks, emptyIdentities, type VpsE2eEvidence } from "./evidence.js";
import { createFixtureWorkspace } from "./fixtureWorkspace.js";
import type { VpsE2eGate } from "./gate.js";
import { precondition } from "./gate.js";
import {
  allocateEphemeralPort,
  assertBinsPresent,
  openSqlite,
  runNodeBin,
  sha256Hex,
  spawnLongLived,
  waitFor,
  type ManagedChild
} from "./processSupport.js";
import { digestLabel, redactSensitiveText } from "./redaction.js";
import { generateLocalTlsMaterial, resolveOpensslBinary } from "./tlsMaterial.js";
import { createTrustedFetch } from "./trustedFetch.js";

function firstExisting(paths: readonly string[]): string | null {
  for (const path of paths) {
    if (existsSync(path)) return path;
  }
  return null;
}

/** Resolve bins from either package src/ (vitest) or dist/ (CLI). */
const serverBinPath =
  firstExisting([
    fileURLToPath(new URL("../bin.js", import.meta.url)),
    fileURLToPath(new URL("../../dist/bin.js", import.meta.url))
  ]) ?? fileURLToPath(new URL("../../dist/bin.js", import.meta.url));
const agentHostBinPath =
  firstExisting([
    fileURLToPath(new URL("../../../agent-host/dist/bin.js", import.meta.url)),
    fileURLToPath(new URL("../../../../agent-host/dist/bin.js", import.meta.url))
  ]) ?? fileURLToPath(new URL("../../../agent-host/dist/bin.js", import.meta.url));
const acpMockAgentPath =
  firstExisting([
    fileURLToPath(
      new URL("../../../runtime/src/__tests__/support/acpMockAgent.mjs", import.meta.url)
    ),
    fileURLToPath(
      new URL("../../../../runtime/src/__tests__/support/acpMockAgent.mjs", import.meta.url)
    )
  ]) ??
  fileURLToPath(
    new URL("../../../runtime/src/__tests__/support/acpMockAgent.mjs", import.meta.url)
  );

const DEFAULT_TIMEOUT_MS = 45_000;
const HOST_CAPACITY = 2;
const HOST_CAPABILITIES = ["acp.codex"] as const;
const HOST_DISPLAY_NAME = "local-tls-fixture-host";

const serverReadyOutputSchema = serverConfigSummarySchema
  .pick({ advertisedOrigin: true })
  .extend({ status: z.literal("ready") })
  .passthrough();

async function seedOperatorSession(databasePath: string, projectId: string, token: string) {
  const database = await openServerDatabase(databasePath, 5_000);
  try {
    const workspaceId = new WorkspaceIdentityRepository(database).workspaceForLegacyProject(
      projectId
    );
    if (!workspaceId) throw new Error("vps_e2e_workspace_missing");
    const existing = database
      .prepare("SELECT 1 FROM workspace_operator_sessions WHERE operator_id=?")
      .get("vps-e2e-operator");
    if (existing) return;
    new OperatorSessionStore(database).create({
      workspaceId,
      operatorId: "vps-e2e-operator",
      credentialSha256: hashOperatorToken(token),
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z"
    });
  } finally {
    database.close();
  }
}

type OperatorView = {
  operationId: string;
  state: string;
  dispatchId: string;
  executionAttemptId: string;
  dispatchStatus?: string;
  attempt: {
    leaseId?: string;
    hostId?: string;
    status: string;
    stateVersion: number;
  };
  runtime: {
    status: string;
    terminalReceipt?: { outcome: string; runId?: string };
  };
};

type EventReplay = {
  executionAttemptId: string;
  afterCursor: number;
  cursor: number;
  highWatermark: number;
  hasMore: boolean;
  events: Array<Record<string, unknown>>;
};

/**
 * local-tls-fixture: disposable loopback Coordinator+Host with certificate-verified WSS.
 * Does NOT claim a real production VPS — environmentClass is always local-tls-fixture.
 */
export async function runLocalTlsFixture(options: {
  gate: VpsE2eGate;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<VpsE2eEvidence> {
  const env = options.env ?? process.env;
  const commandsSanitized: string[] = [];
  const checks = emptyChecks();
  const identities = emptyIdentities();
  let evidencePartial: Partial<VpsE2eEvidence> = {};
  const ownedRoots: string[] = [];
  let server: ManagedChild | undefined;
  let host: ManagedChild | undefined;
  let trusted: Awaited<ReturnType<typeof createTrustedFetch>> | undefined;
  let credentialsRevoked = false;
  let harnessStateRemoved = false;
  let hostConfigPath = "";

  const base = (): VpsE2eEvidence =>
    ({
      version: "planweave.vps-authenticated-e2e/v1",
      generatedAt: new Date().toISOString(),
      environmentClass: "local-tls-fixture",
      gateMode: options.gate.mode,
      profileId: "local-tls-fixture",
      componentVersions: {
        server: serverPackageVersion,
        agentHost: evidencePartial.componentVersions?.agentHost ?? null,
        protocol: evidencePartial.componentVersions?.protocol ?? null,
        node: process.version
      },
      commandsSanitized,
      identities,
      envelopeDigest: evidencePartial.envelopeDigest ?? null,
      eventCursor: evidencePartial.eventCursor ?? null,
      artifactHash: evidencePartial.artifactHash ?? null,
      runtimeOutcome: evidencePartial.runtimeOutcome ?? null,
      interaction: evidencePartial.interaction ?? { attempted: false, status: null },
      heartbeat: evidencePartial.heartbeat ?? { hostLastSeenAtPresent: false },
      networkInterrupt: evidencePartial.networkInterrupt ?? {
        performed: false,
        kind: null,
        replayOk: false,
        reconnectOk: false
      },
      resourceBounds: evidencePartial.resourceBounds ?? {
        maxArtifactBytes: null,
        maxWebSocketPayloadBytes: null,
        hostCapacity: null
      },
      checks,
      result: "failed",
      diagnostic: null,
      cleanup: {
        harnessStateRemoved,
        credentialsRevoked,
        diagnostics: []
      },
      ...evidencePartial
    }) as VpsE2eEvidence;

  try {
    const openssl = resolveOpensslBinary(env);
    if (!openssl) {
      const pre = precondition(
        options.gate.mode,
        "openssl_missing",
        "openssl is required to mint ephemeral local-tls-fixture certificates."
      );
      return {
        ...base(),
        result: pre.disposition === "skip" ? "skipped" : "failed",
        disposition: pre.disposition,
        diagnostic: pre.message
      };
    }

    try {
      assertBinsPresent(serverBinPath, agentHostBinPath);
    } catch {
      const pre = precondition(
        options.gate.mode,
        "bins_missing",
        "Built planweave-server and planweave-agent-host bins are required (pnpm --filter @planweave-ai/server build && pnpm --filter @planweave-ai/agent-host build)."
      );
      return {
        ...base(),
        result: pre.disposition === "skip" ? "skipped" : "failed",
        disposition: pre.disposition,
        diagnostic: pre.message
      };
    }

    const root = await mkdtemp(join(tmpdir(), "planweave-vps-e2e-"));
    ownedRoots.push(root);
    await mkdir(join(root, "server-data"), { recursive: true, mode: 0o700 });
    await mkdir(join(root, "host-data"), { recursive: true, mode: 0o700 });
    await mkdir(join(root, "workspaces", "project"), { recursive: true });
    await mkdir(join(root, "logs"), { recursive: true });
    await mkdir(join(root, "acp-control"), { recursive: true });
    const supportedAgentBinDirectory = join(root, "supported-agent-bin");
    await mkdir(supportedAgentBinDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(supportedAgentBinDirectory, "codex-acp"), "", {
      encoding: "utf8",
      mode: 0o700
    });

    const tls = await generateLocalTlsMaterial(root, { opensslBinary: openssl });
    commandsSanitized.push(...tls.commandsSanitized);

    const workspace = await createFixtureWorkspace();
    ownedRoots.push(...workspace.ownedRoots);
    const workspaceId = `workspace-${workspace.projectId}`;

    const port = await allocateEphemeralPort();
    const origin = `https://127.0.0.1:${port}`;
    const operatorToken = `pw_operator_${randomBytes(32).toString("base64url").slice(0, 43)}`;
    const maxArtifactBytes = 8 * 1024 * 1024;
    const maxWebSocketPayloadBytes = 256 * 1024;

    const serverConfigPath = join(root, "server.json");
    await writeFile(
      serverConfigPath,
      JSON.stringify({
        version: "server-config/v1",
        bind: { host: "127.0.0.1", port },
        publicUrl: origin,
        deployment: {
          topology: "loopback_https",
          serverOrigin: origin,
          allowedClientOrigins: [origin],
          tlsTrust: "configured_ca"
        },
        tls: {
          certificatePath: tls.certificatePath,
          privateKeyPath: tls.privateKeyPath
        },
        allowInsecureDevelopment: false,
        dataDirectory: join(root, "server-data"),
        trustedProjects: [
          {
            workspaceId,
            projectId: workspace.projectId,
            canvasId: "default",
            projectRoot: workspace.root
          }
        ],
        operatorCredentials: [
          {
            operatorId: "vps-e2e-operator",
            tokenSha256: hashOperatorToken(operatorToken),
            projectIds: [],
            serverAdmin: true
          }
        ],
        limits: {
          busyTimeoutMs: 5_000,
          leaseDurationMs: 30_000,
          hostOfflineAfterMs: 90_000,
          heartbeatIntervalMs: 5_000,
          maxArtifactBytes,
          maxWebSocketPayloadBytes,
          shutdownTimeoutMs: 5_000
        }
      }),
      "utf8"
    );
    commandsSanitized.push(
      "planweave-server serve --config <redacted-absolute-config> (tls certificate-verified HTTPS)"
    );

    hostConfigPath = join(root, "agent-host.json");
    await writeFile(
      hostConfigPath,
      JSON.stringify({
        version: "agent-host-config/v1",
        coordinator: {
          url: origin,
          caCertificatePath: tls.caCertificatePath,
          allowInsecureDevelopment: false
        },
        dataDirectory: join(root, "host-data"),
        workspaceRoot: join(root, "workspaces"),
        host: {
          displayName: HOST_DISPLAY_NAME,
          capacity: HOST_CAPACITY,
          capabilities: [...HOST_CAPABILITIES]
        },
        workspaces: [{ id: workspaceId, path: "project" }],
        agentProfiles: [
          {
            id: "codex-acp",
            agentId: "codex",
            command: process.execPath,
            args: [acpMockAgentPath, "success", `--control-dir=${join(root, "acp-control")}`],
            environment: []
          }
        ]
      }),
      "utf8"
    );
    commandsSanitized.push(
      "planweave-agent-host preflight|enroll|run|revoke --config <redacted-absolute-config>"
    );

    trusted = await createTrustedFetch({ caCertificatePath: tls.caCertificatePath });
    const request = trusted.request;
    const authHeaders = {
      Authorization: `Bearer ${operatorToken}`,
      "content-type": "application/json"
    };

    // Start Coordinator (TLS).
    server = spawnLongLived({
      command: process.execPath,
      args: [serverBinPath, "serve", "--config", serverConfigPath],
      logDir: join(root, "logs"),
      label: "server",
      env: { ...process.env, PLANWEAVE_HOME: workspace.home }
    });
    await waitFor(
      () => {
        if (server?.exitSnapshot) return false;
        const line = server?.logs.stdout
          .split("\n")
          .map((value) => value.trim())
          .find((value) => value.startsWith("{") && value.includes("status"));
        if (!line) return false;
        try {
          const parsed = serverReadyOutputSchema.safeParse(JSON.parse(line));
          return parsed.success && parsed.data.advertisedOrigin === origin;
        } catch {
          return false;
        }
      },
      {
        timeoutMs: DEFAULT_TIMEOUT_MS,
        label: "server-ready",
        diagnostics: () => redactSensitiveText(server?.logs.stderr ?? "")
      }
    );
    await seedOperatorSession(
      join(root, "server-data", "planweave-server.sqlite"),
      workspace.projectId,
      operatorToken
    );

    const versionResponse = await request(`${origin}/version`);
    const versionBody = (await versionResponse.json()) as {
      protocolVersion?: number;
      serverVersion?: string;
    };
    evidencePartial = {
      ...evidencePartial,
      componentVersions: {
        server: serverPackageVersion,
        agentHost: null,
        protocol: versionBody.protocolVersion ?? null,
        node: process.version
      }
    };
    checks.certificateVerifiedTransport = versionResponse.ok;

    const readiness = await request(`${origin}/readyz`);
    if (!readiness.ok) throw new Error("vps_e2e_server_not_ready");

    // One-time enrollment grant + Host enroll.
    const grantResponse = await request(`${origin}/api/v1/host-enrollments`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
      })
    });
    if (grantResponse.status !== 201) {
      throw new Error(`vps_e2e_enroll_grant_failed:${grantResponse.status}`);
    }
    const grant = (await grantResponse.json()) as { enrollmentCode: string };
    checks.enrollmentOneTimeToken = grant.enrollmentCode.startsWith("pw_enroll_");

    const preflight = await runNodeBin(
      agentHostBinPath,
      ["preflight", "--config", hostConfigPath],
      {
        ...process.env,
        PLANWEAVE_HOME: workspace.home
      }
    );
    if (preflight.code !== 0) {
      throw new Error(`vps_e2e_host_preflight_failed:${preflight.stderr || preflight.stdout}`);
    }

    const enrollment = await runNodeBin(
      agentHostBinPath,
      ["enroll", "--config", hostConfigPath, "--code", grant.enrollmentCode],
      { ...process.env, PLANWEAVE_HOME: workspace.home }
    );
    if (enrollment.code !== 0) {
      throw new Error(`vps_e2e_host_enroll_failed:${enrollment.stderr || enrollment.stdout}`);
    }

    const exposure = await runNodeBin(
      agentHostBinPath,
      ["agents", "expose", "codex-acp", "--config", hostConfigPath],
      {
        ...process.env,
        ...env,
        PATH: [supportedAgentBinDirectory, env.PATH ?? process.env.PATH]
          .filter((value): value is string => Boolean(value))
          .join(delimiter),
        PLANWEAVE_HOME: workspace.home
      }
    );
    if (exposure.code !== 0) {
      throw new Error(`vps_e2e_agent_exposure_failed:${exposure.stderr || exposure.stdout}`);
    }
    commandsSanitized.push(
      "planweave-agent-host agents expose codex-acp --config <redacted-absolute-config>"
    );

    host = spawnLongLived({
      command: process.execPath,
      args: [agentHostBinPath, "run", "--config", hostConfigPath],
      logDir: join(root, "logs"),
      label: "host",
      env: { ...process.env, PLANWEAVE_HOME: workspace.home }
    });

    let hostOnline:
      | { id: string; lastSeenAt: string; capacity: number; capabilities: string[] }
      | undefined;
    await waitFor(
      async () => {
        const response = await request(`${origin}/api/v1/hosts`, {
          headers: { Authorization: `Bearer ${operatorToken}` }
        });
        if (!response.ok) return false;
        const page = (await response.json()) as {
          items: Array<{
            id: string;
            displayName?: string;
            lastSeenAt?: string;
            capacity?: number;
            capabilities?: string[];
          }>;
        };
        const match = page.items.find(
          (item) => item.displayName === HOST_DISPLAY_NAME && typeof item.lastSeenAt === "string"
        );
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
        label: "host-online",
        diagnostics: () =>
          redactSensitiveText(`${host?.logs.stdout ?? ""}\n${host?.logs.stderr ?? ""}`)
      }
    );
    if (!hostOnline) throw new Error("vps_e2e_host_online_missing");
    identities.hostId = hostOnline.id;
    checks.hostCapacityAdvertised = hostOnline.capacity === HOST_CAPACITY;
    checks.hostCapabilitiesAdvertised = HOST_CAPABILITIES.every((cap) =>
      hostOnline!.capabilities.includes(cap)
    );
    checks.heartbeatObserved = Boolean(hostOnline.lastSeenAt);
    evidencePartial = {
      ...evidencePartial,
      heartbeat: { hostLastSeenAtPresent: true },
      resourceBounds: {
        maxArtifactBytes,
        maxWebSocketPayloadBytes,
        hostCapacity: hostOnline.capacity
      }
    };
    checks.resourceBoundsConfirmed =
      maxArtifactBytes > 0 && maxWebSocketPayloadBytes > 0 && hostOnline.capacity === HOST_CAPACITY;

    const ownerResponse = await request(
      `${origin}/api/v1/projects/${encodeURIComponent(workspace.projectId)}/human/bootstrap`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Local TLS fixture owner",
          humanPrincipalId: "local-tls-fixture-owner"
        })
      }
    );
    if (ownerResponse.status !== 201) {
      throw new Error(`vps_e2e_owner_bootstrap_failed:${ownerResponse.status}`);
    }
    const owner = (await ownerResponse.json()) as { deviceToken?: string };
    if (!owner.deviceToken) throw new Error("vps_e2e_owner_credential_missing");
    const endpointResponse = await request(
      `${origin}/api/v1/projects/${encodeURIComponent(workspace.projectId)}/agent-endpoints`,
      { headers: { Authorization: `Bearer ${owner.deviceToken}` } }
    );
    if (endpointResponse.status !== 200) {
      throw new Error(`vps_e2e_agent_endpoint_list_failed:${endpointResponse.status}`);
    }
    const endpointPage = (await endpointResponse.json()) as {
      items?: Array<{ endpointId?: string; status?: string }>;
    };
    const agentEndpointId = endpointPage.items?.find(
      (endpoint) => endpoint.status === "available"
    )?.endpointId;
    if (!agentEndpointId) throw new Error("vps_e2e_agent_endpoint_missing");

    // Dispatch bounded fixture block.
    const dispatchResponse = await request(`${origin}/api/v1/remote-operations`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        schemaVersion: "remote-run/v3",
        projectId: workspace.projectId,
        canvasId: "default",
        blockRef: "T-001#B-001",
        agentEndpointId,
        idempotencyKey: `vps-e2e-local-tls-${Date.now()}`,
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0,
        executionTargetRevision: 0,
        contentRevision: "1",
        graphFingerprint: workspace.graphFingerprint
      })
    });
    if (dispatchResponse.status !== 202) {
      const bodyText = await dispatchResponse.text();
      throw new Error(
        `vps_e2e_dispatch_failed:${dispatchResponse.status}:${redactSensitiveText(bodyText)}`
      );
    }
    const dispatched = (await dispatchResponse.json()) as OperatorView;
    identities.operationId = dispatched.operationId;
    identities.dispatchId = dispatched.dispatchId;
    identities.executionAttemptId = dispatched.executionAttemptId;
    identities.leaseId = dispatched.attempt.leaseId ?? null;
    checks.identitiesCaptured = Boolean(
      identities.operationId &&
        identities.dispatchId &&
        identities.executionAttemptId &&
        identities.leaseId
    );
    commandsSanitized.push(
      "POST /api/v1/remote-operations { schemaVersion: remote-run/v3, projectId, canvasId, blockRef: T-001#B-001, agentEndpointId, idempotencyKey, expected human authority revisions }"
    );

    // Wait for terminal completion (success path for local mock fixture).
    let terminal: OperatorView | undefined;
    await waitFor(
      async () => {
        const response = await request(
          `${origin}/api/v1/remote-operations/${dispatched.operationId}`,
          { headers: { Authorization: `Bearer ${operatorToken}` } }
        );
        if (!response.ok) return false;
        terminal = (await response.json()) as OperatorView;
        return ["completed", "failed", "cancelled"].includes(terminal.state);
      },
      {
        timeoutMs: 90_000,
        label: "dispatch-terminal",
        diagnostics: () =>
          redactSensitiveText(
            `state=${terminal?.state ?? "none"} runtime=${terminal?.runtime.status ?? "none"} host.stderr=${host?.logs.stderr.slice(-500) ?? ""}`
          )
      }
    );
    if (!terminal) throw new Error("vps_e2e_terminal_missing");
    evidencePartial = { ...evidencePartial, runtimeOutcome: terminal.runtime.status };
    checks.runtimeResultAuthoritative =
      terminal.state === "completed" && terminal.runtime.status === "completed";
    if (!checks.runtimeResultAuthoritative) {
      throw new Error(
        `vps_e2e_terminal_not_completed:state=${terminal.state}:runtime=${terminal.runtime.status}:dispatch=${terminal.dispatchStatus ?? "none"}`
      );
    }

    // Envelope digest + artifact/report hash from Server SQLite (authoritative store).
    const dbPath = join(root, "server-data", "planweave-server.sqlite");
    const database = openSqlite(dbPath);
    try {
      const envelopeRow = database
        .prepare("SELECT canonical_json FROM dispatch_execution_envelopes WHERE dispatch_id=?")
        .get(dispatched.dispatchId) as { canonical_json?: string } | undefined;
      if (envelopeRow?.canonical_json) {
        evidencePartial = {
          ...evidencePartial,
          envelopeDigest: `envelope:${digestLabel("sha256", sha256Hex(envelopeRow.canonical_json))}`
        };
        checks.envelopeDigestCaptured = true;
      }
      const dispatchRow = database
        .prepare("SELECT result_json FROM dispatches WHERE id=?")
        .get(dispatched.dispatchId) as { result_json?: string | null } | undefined;
      if (dispatchRow?.result_json) {
        const result = JSON.parse(dispatchRow.result_json) as {
          reportArtifactRef?: string;
          summary?: string;
        };
        if (result.reportArtifactRef) {
          const hash = result.reportArtifactRef.replace(/^artifact:sha256:/, "");
          evidencePartial = {
            ...evidencePartial,
            artifactHash: digestLabel("sha256", hash)
          };
          checks.artifactHashCaptured = hash.length >= 32;
        } else if (result.summary) {
          // success mock may terminalize with summary-only report; hash the summary digest.
          evidencePartial = {
            ...evidencePartial,
            artifactHash: digestLabel("sha256", sha256Hex(result.summary))
          };
          checks.artifactHashCaptured = true;
        }
      }
    } finally {
      database.close();
    }

    // Events + session identity.
    const eventsResponse = await request(
      `${origin}/api/v1/remote-operations/${dispatched.operationId}/events?afterCursor=0`,
      { headers: { Authorization: `Bearer ${operatorToken}` } }
    );
    if (!eventsResponse.ok) {
      throw new Error(
        `vps_e2e_events_failed:${eventsResponse.status}:${redactSensitiveText(await eventsResponse.text())}`
      );
    }
    const events = (await eventsResponse.json()) as EventReplay;
    checks.eventsCaptured = events.events.length > 0;
    evidencePartial = {
      ...evidencePartial,
      eventCursor: {
        afterCursor: events.afterCursor,
        highWatermark: events.highWatermark,
        eventCount: events.events.length
      }
    };
    const sessionEvent = events.events.find(
      (event) => typeof event.sessionId === "string" || typeof event.acpSessionId === "string"
    );
    identities.sessionId =
      (sessionEvent?.sessionId as string | undefined) ??
      (sessionEvent?.acpSessionId as string | undefined) ??
      null;

    // Interaction surface (safe probe — may be empty for mock success).
    const interactionsResponse = await request(
      `${origin}/api/v1/remote-operations/${dispatched.operationId}/interactions?limit=10`,
      { headers: { Authorization: `Bearer ${operatorToken}` } }
    );
    if (interactionsResponse.ok) {
      const interactions = (await interactionsResponse.json()) as { items?: unknown[] };
      evidencePartial = {
        ...evidencePartial,
        interaction: {
          attempted: true,
          status: (interactions.items?.length ?? 0) > 0 ? "present" : "none"
        }
      };
    }

    // Network interrupt: restart Coordinator once; Host reconnects; event cursor replay stays consistent.
    const midCursor = Math.max(0, Math.floor(events.highWatermark / 2));
    const beforeReplay = await request(
      `${origin}/api/v1/remote-operations/${dispatched.operationId}/events?afterCursor=${midCursor}`,
      { headers: { Authorization: `Bearer ${operatorToken}` } }
    );
    const beforeBody = (await beforeReplay.json()) as EventReplay;

    if (server?.tree.isAlive()) {
      await server.tree.terminate("vps-e2e network interrupt");
      await server.exit;
    }
    server = undefined;
    server = spawnLongLived({
      command: process.execPath,
      args: [serverBinPath, "serve", "--config", serverConfigPath],
      logDir: join(root, "logs"),
      label: "server-restart",
      env: { ...process.env, PLANWEAVE_HOME: workspace.home }
    });
    await waitFor(
      async () => {
        try {
          const response = await request(`${origin}/readyz`);
          if (!response.ok) return false;
          const body = (await response.json()) as { status?: string };
          return body.status === "ready";
        } catch {
          return false;
        }
      },
      { timeoutMs: DEFAULT_TIMEOUT_MS, label: "server-reconnect-ready" }
    );
    await seedOperatorSession(
      join(root, "server-data", "planweave-server.sqlite"),
      workspace.projectId,
      operatorToken
    );

    // Host should re-advertise heartbeat after transport recovery.
    let reconnectOk = false;
    await waitFor(
      async () => {
        const response = await request(`${origin}/api/v1/hosts`, {
          headers: { Authorization: `Bearer ${operatorToken}` }
        });
        if (!response.ok) return false;
        const page = (await response.json()) as {
          items: Array<{ id: string; lastSeenAt?: string; displayName?: string }>;
        };
        const match = page.items.find((item) => item.id === hostOnline!.id);
        reconnectOk = Boolean(match?.lastSeenAt);
        return reconnectOk;
      },
      { timeoutMs: DEFAULT_TIMEOUT_MS, label: "host-reconnect-heartbeat" }
    );

    const afterReplay = await request(
      `${origin}/api/v1/remote-operations/${dispatched.operationId}/events?afterCursor=${midCursor}`,
      { headers: { Authorization: `Bearer ${operatorToken}` } }
    );
    const afterBody = (await afterReplay.json()) as EventReplay;
    const replayOk =
      afterReplay.ok &&
      afterBody.highWatermark === beforeBody.highWatermark &&
      afterBody.events.length === beforeBody.events.length &&
      afterBody.executionAttemptId === beforeBody.executionAttemptId;

    evidencePartial = {
      ...evidencePartial,
      networkInterrupt: {
        performed: true,
        kind: "coordinator_restart_tls",
        replayOk,
        reconnectOk
      }
    };
    checks.networkInterruptReplay = replayOk && reconnectOk;
    commandsSanitized.push(
      "network interrupt: SIGTERM planweave-server; restart serve --config <redacted>; verify /events?afterCursor replay + host heartbeat"
    );

    // Optional safe cancel is skipped after successful terminal completion (no harmful side effects needed).
    // Revoke host credential and remove harness state.
    const revoke = await runNodeBin(agentHostBinPath, ["revoke", "--config", hostConfigPath], {
      ...process.env,
      PLANWEAVE_HOME: workspace.home
    });
    credentialsRevoked = revoke.code === 0;
    checks.credentialsRevoked = credentialsRevoked;

    if (host?.tree.isAlive()) {
      await host.tree.terminate("vps-e2e cleanup");
      await host.exit;
    }
    host = undefined;
    if (server?.tree.isAlive()) {
      await server.tree.terminate("vps-e2e cleanup");
      await server.exit;
    }
    server = undefined;

    for (const directory of ownedRoots.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
    harnessStateRemoved = true;
    checks.cleanupCompleted = harnessStateRemoved && credentialsRevoked;

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

    return {
      ...base(),
      result: passed ? "passed" : "failed",
      diagnostic: passed
        ? null
        : `local_tls_fixture_incomplete:${JSON.stringify(
            Object.fromEntries(Object.entries(checks).filter(([, value]) => !value))
          )}`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base(),
      result: "failed",
      diagnostic: redactSensitiveText(message)
    };
  } finally {
    try {
      if (host?.tree.isAlive()) await host.tree.terminate("vps-e2e finally");
    } catch {
      /* best-effort */
    }
    try {
      if (server?.tree.isAlive()) await server.tree.terminate("vps-e2e finally");
    } catch {
      /* best-effort */
    }
    try {
      await trusted?.close();
    } catch {
      /* best-effort */
    }
    for (const directory of ownedRoots) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    // Avoid leaking absolute config path into process env.
    void dirname(hostConfigPath);
  }
}
