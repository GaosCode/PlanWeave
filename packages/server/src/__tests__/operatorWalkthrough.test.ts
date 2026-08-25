import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { operatorEnrollmentGrantResponseSchema } from "@planweave-ai/agent-host-protocol";
import type { PlanPackageManifest } from "@planweave-ai/runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { latestCentralSchemaVersion } from "../migrations.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { legacyWorkspaceIdForProject } from "./support/legacyWorkspaceId.js";
import { seedOperatorSessions } from "./support/operatorAuthFixture.js";
import {
  buildIsolatedPublicPackageBins,
  PublicBinProcessRegistry,
  type RunningPublicBin
} from "./support/publicPackageBinHarness.js";

const directories: string[] = [];
const mockAgentPath = fileURLToPath(
  new URL("../../../runtime/src/__tests__/support/acpMockAgent.mjs", import.meta.url)
);

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const serverPackageRoot = fileURLToPath(new URL("../..", import.meta.url));
const agentHostPackageRoot = fileURLToPath(new URL("../../../agent-host", import.meta.url));
let publicBinRoot: string | undefined;
let serverBinPath: string;
let agentHostBinPath: string;
const publicBinProcesses = new PublicBinProcessRegistry();

beforeAll(async () => {
  const isolated = await buildIsolatedPublicPackageBins(repositoryRoot, [
    { packageRoot: serverPackageRoot, binName: "planweave-server" },
    { packageRoot: agentHostPackageRoot, binName: "planweave-agent-host" }
  ]);
  publicBinRoot = isolated.root;
  serverBinPath = isolated.binPaths["planweave-server"];
  agentHostBinPath = isolated.binPaths["planweave-agent-host"];
});

afterAll(async () => {
  if (publicBinRoot) {
    await rm(publicBinRoot, { recursive: true, force: true });
  }
});

afterEach(async () => {
  const results = await Promise.allSettled([
    publicBinProcesses.stopAll(),
    ...directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  ]);
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length > 0) {
    throw new AggregateError(errors, "operator_walkthrough_cleanup_failed");
  }
});

function remoteManifest(): PlanPackageManifest {
  const manifest = basicManifest();
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
  };
  manifest.nodes[0].blocks[0].requirements = { capabilities: ["acp.codex"] };
  return manifest;
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("expected_http_port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

type HostCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

/**
 * Invoke a public package binary as a subprocess (planweave-server / planweave-agent-host).
 * Avoids in-process Server CLI imports and Host source imports across package boundaries.
 */
function runPublicBin(binPath: string, argv: readonly string[]): Promise<HostCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...argv], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function runAgentHostBin(argv: readonly string[]): Promise<HostCommandResult> {
  return runPublicBin(agentHostBinPath, argv);
}

function startPublicBin(binPath: string, argv: readonly string[]): RunningPublicBin {
  return publicBinProcesses.start(binPath, argv);
}

async function startServerBin(configPath: string, publicUrl: string): Promise<RunningPublicBin> {
  const running = startPublicBin(serverBinPath, ["serve", "--config", configPath]);
  await vi.waitFor(
    () => {
      const line = running.logs.stdout
        .split("\n")
        .map((value) => value.trim())
        .find((value) => value.startsWith("{") && value.includes("status"));
      if (!line) {
        throw new Error(
          `server_not_ready:${running.logs.stderr || running.logs.stdout || "no_output"}`
        );
      }
      const parsed = JSON.parse(line) as { status?: string; advertisedOrigin?: string };
      expect(parsed).toMatchObject({ status: "ready", advertisedOrigin: publicUrl });
    },
    { timeout: 15_000 }
  );
  return running;
}

function startAgentHostBin(configPath: string): RunningPublicBin {
  return startPublicBin(agentHostBinPath, ["run", "--config", configPath]);
}

async function stopPublicBin(running: RunningPublicBin): Promise<void> {
  await publicBinProcesses.stop(running);
}

describe("remote operator walkthrough", () => {
  it("reaps a process group with a descendant that ignores graceful termination", async () => {
    if (process.platform === "win32") return;
    const registry = new PublicBinProcessRegistry({
      gracefulTimeoutMs: 100,
      forceTimeoutMs: 2_000
    });
    const temporaryRoot = await mkdtemp(join(tmpdir(), "planweave-cleanup-injection-"));
    directories.push(temporaryRoot);
    const descendantPath = join(temporaryRoot, "stubborn-descendant.mjs");
    await writeFile(
      descendantPath,
      "process.on('SIGTERM',()=>{});process.send?.('ready');setInterval(()=>{},1000);"
    );
    const fixturePath = join(temporaryRoot, "parent-bin.mjs");
    await writeFile(
      fixturePath,
      [
        "import { spawn } from 'node:child_process';",
        "const child=spawn(process.execPath,[process.argv[2]],{stdio:['ignore','ignore','ignore','ipc']});",
        "child.once('message',()=>console.log(JSON.stringify({descendantPid:child.pid})));",
        "process.on('SIGTERM',()=>process.exit(0));",
        "setInterval(()=>{},1000);"
      ].join("\n")
    );
    const running = registry.start(fixturePath, [descendantPath]);
    const rootPid = running.child.pid;
    if (!rootPid) throw new Error("cleanup_injection_root_pid_missing");
    let descendantPid: number | undefined;
    await vi.waitFor(() => {
      const line = running.logs.stdout.trim();
      if (!line) throw new Error("cleanup_injection_descendant_not_ready");
      descendantPid = (JSON.parse(line) as { descendantPid: number }).descendantPid;
      expect(descendantPid).toBeGreaterThan(0);
    });
    if (!descendantPid) throw new Error("cleanup_injection_descendant_pid_missing");
    let injectedFailure: Error | undefined;
    try {
      throw new Error("injected_walkthrough_failure");
    } catch (error) {
      injectedFailure = error as Error;
    } finally {
      await registry.stopAll();
    }
    expect(injectedFailure?.message).toBe("injected_walkthrough_failure");
    expect(() => process.kill(rootPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect(() => process.kill(descendantPid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" })
    );
    expect(() => process.kill(-rootPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  }, 5_000);

  it("builds clean public bins, then starts Server and exercises the Host lifecycle", async () => {
    expect(serverBinPath).toContain(publicBinRoot);
    expect(agentHostBinPath).toContain(publicBinRoot);
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const temporaryRoot = await mkdtemp(join(tmpdir(), "planweave-operator-walkthrough-"));
    directories.push(temporaryRoot);
    const hostWorkspaceRoot = join(temporaryRoot, "workspaces");
    await mkdir(join(hostWorkspaceRoot, "project"), { recursive: true });
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const operatorToken = `pw_operator_${"W".repeat(43)}`;
    const serverConfigPath = join(temporaryRoot, "server.json");
    await writeFile(
      serverConfigPath,
      JSON.stringify({
        version: "server-config/v1",
        bind: { host: "127.0.0.1", port },
        publicUrl: origin,
        allowInsecureDevelopment: true,
        dataDirectory: join(temporaryRoot, "server-data"),
        trustedProjects: [
          {
            workspaceId: legacyWorkspaceIdForProject(workspace.init.workspace.id),
            projectId: workspace.init.workspace.id,
            canvasId: "default",
            projectRoot: workspace.root
          }
        ],
        operatorCredentials: [
          {
            operatorId: "walkthrough-operator",
            tokenSha256: hashOperatorToken(operatorToken),
            projectIds: [],
            serverAdmin: true
          }
        ]
      })
    );

    let server = await startServerBin(serverConfigPath, origin);
    await seedOperatorSessions(join(temporaryRoot, "server-data", "planweave-server.sqlite"), [
      {
        operatorId: "walkthrough-operator",
        tokenSha256: hashOperatorToken(operatorToken),
        projectIds: [],
        serverAdmin: true
      }
    ]);
    const authorization = { Authorization: `Bearer ${operatorToken}` };
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    const readiness = await fetch(`${origin}/readyz`);
    expect(readiness.status).toBe(200);
    await expect(readiness.json()).resolves.toEqual({
      status: "ready",
      schemaVersion: latestCentralSchemaVersion
    });
    await expect((await fetch(`${origin}/version`)).json()).resolves.toMatchObject({
      protocolVersion: 1
    });

    const bootstrap = await fetch(
      `${origin}/api/v1/projects/${workspace.init.workspace.id}/human/bootstrap`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Walkthrough Owner",
          humanPrincipalId: "walkthrough-owner"
        })
      }
    );
    expect(bootstrap.status).toBe(201);
    const { deviceToken } = (await bootstrap.json()) as { deviceToken: string };

    const enrollmentExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const grantResponse = await fetch(`${origin}/api/v1/host-enrollments`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: legacyWorkspaceIdForProject(workspace.init.workspace.id),
        expiresAt: enrollmentExpiresAt,
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
        ownerHumanPrincipalId: "walkthrough-owner",
        accessMode: "unrestricted",
        createWorkspaceGrant: true
      })
    });
    expect(grantResponse.status).toBe(201);
    const grant = operatorEnrollmentGrantResponseSchema.parse(await grantResponse.json());
    expect(grant.enrollmentCode).toMatch(/^pw_enroll_/);

    const hostConfigPath = join(temporaryRoot, "agent-host.json");
    await writeFile(
      hostConfigPath,
      JSON.stringify({
        version: "agent-host-config/v1",
        coordinator: { url: origin, allowInsecureDevelopment: true },
        dataDirectory: join(temporaryRoot, "host-data"),
        workspaceRoot: hostWorkspaceRoot,
        host: {
          displayName: "Walkthrough Host",
          capacity: 2,
          capabilities: ["acp.test", "acp.codex"]
        },
        workspaces: [{ id: grant.workspaceId, path: "project" }],
        agentProfiles: [
          {
            id: "codex-acp",
            agentId: "codex",
            command: process.execPath,
            args: [mockAgentPath, "success"],
            environment: []
          }
        ]
      })
    );

    const preflight = await runAgentHostBin(["preflight", "--config", hostConfigPath]);
    expect(preflight.code).toBe(0);
    expect(JSON.parse(preflight.stdout)).toMatchObject({
      credential: "missing",
      capacity: 2,
      connection: "offline"
    });

    const enrollment = await runAgentHostBin([
      "enroll",
      "--config",
      hostConfigPath,
      "--code",
      grant.enrollmentCode
    ]);
    expect(enrollment.code).toBe(0);
    expect(JSON.parse(enrollment.stdout)).toMatchObject({ credential: "active" });

    const exposure = await runAgentHostBin([
      "agents",
      "expose",
      "codex-acp",
      "--config",
      hostConfigPath
    ]);
    expect(exposure.code).toBe(0);
    expect(JSON.parse(exposure.stdout)).toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({ profileId: "codex-acp", exposed: true, ready: true })
      ])
    });

    const status = await runAgentHostBin(["status", "--config", hostConfigPath]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      credential: "active",
      capacity: 2
    });

    const readHost = async () => {
      const response = await fetch(`${origin}/api/v1/hosts`, { headers: authorization });
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        items: Array<{
          id: string;
          capacity: number;
          displayName: string;
          lastSeenAt?: string;
          revokedAt?: string;
        }>;
      };
      return page.items[0];
    };

    let host = startAgentHostBin(hostConfigPath);
    let firstLastSeenAt: string | undefined;
    let hostId: string | undefined;
    await vi.waitFor(
      async () => {
        const observedHost = await readHost();
        expect(observedHost).toMatchObject({
          displayName: "Walkthrough Host",
          capacity: 2,
          lastSeenAt: expect.any(String)
        });
        firstLastSeenAt = observedHost.lastSeenAt;
        hostId = observedHost.id;
      },
      { timeout: 30_000 }
    );
    expect(hostId).toBeTruthy();

    const executionTarget = await fetch(
      `${origin}/api/v1/projects/${workspace.init.workspace.id}/assignments/execution-target`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: "execution-target/v1",
          scope: {
            kind: "block",
            workspaceId: grant.workspaceId,
            projectId: workspace.init.workspace.id,
            canvasId: "default",
            blockRef: "T-001#B-001"
          },
          target: { kind: "exact_host", hostId },
          expectedRevision: 0
        })
      }
    );
    expect(executionTarget.status).toBe(400);
    await expect(executionTarget.json()).resolves.toEqual({ error: "execution_target_read_only" });

    const endpointResponse = await fetch(
      `${origin}/api/v1/projects/${workspace.init.workspace.id}/agent-endpoints`,
      { headers: { Authorization: `Bearer ${deviceToken}` } }
    );
    expect(endpointResponse.status).toBe(200);
    const endpointPage = (await endpointResponse.json()) as {
      items: Array<{ endpointId: string }>;
    };
    expect(endpointPage.items).toHaveLength(1);
    const agentEndpointId = endpointPage.items[0]?.endpointId;
    expect(agentEndpointId).toBeTruthy();

    for (const schemaVersion of ["remote-run/v1", "remote-run/v2"]) {
      const legacyDispatch = await fetch(`${origin}/api/v1/remote-operations`, {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion,
          projectId: workspace.init.workspace.id,
          canvasId: "default",
          blockRef: "T-001#B-001",
          idempotencyKey: `operator-legacy-dispatch-${schemaVersion}`,
          expectedResponsibilityRevision: 0,
          expectedReviewerRevision: 0,
          expectedExecutionTargetRevision: 0
        })
      });
      expect(legacyDispatch.status).toBe(400);
      await expect(legacyDispatch.json()).resolves.toEqual({ error: "remote_run_v3_required" });
    }

    // Operator dispatch proof: HTTP 202 only means the Coordinator accepted the request.
    // Production success requires Host acceptance (leased/running) and a terminal outcome.
    const dispatchResponse = await fetch(`${origin}/api/v1/remote-operations`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "remote-run/v3",
        projectId: workspace.init.workspace.id,
        canvasId: "default",
        blockRef: "T-001#B-001",
        agentEndpointId,
        idempotencyKey: "operator-walkthrough-dispatch",
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0,
        humanPrincipalId: "walkthrough-owner"
      })
    });
    const dispatchBody = await dispatchResponse.json();
    expect(dispatchResponse.status, JSON.stringify(dispatchBody)).toBe(202);
    const dispatched = dispatchBody as {
      operationId: string;
      projectId: string;
      blockRef: string;
      dispatchStatus?: string;
      state?: string;
    };
    expect(dispatched).toMatchObject({
      projectId: workspace.init.workspace.id,
      blockRef: "T-001#B-001",
      operationId: expect.any(String)
    });

    type OperatorOperationView = {
      operationId: string;
      blockRef: string;
      state: string;
      dispatchStatus?: string;
      attempt?: { status?: string; hostId?: string };
      agentEndpoint?: { endpointId: string };
    };

    const observeOperation = async (operationId: string): Promise<OperatorOperationView> => {
      const response = await fetch(
        `${origin}/api/v1/remote-operations/${encodeURIComponent(operationId)}`,
        { headers: authorization }
      );
      expect(response.status).toBe(200);
      return (await response.json()) as OperatorOperationView;
    };

    // Host accepted: dispatch.accepted surfaces as leased/running (may already be terminal).
    const accepted = await vi.waitFor(
      async () => {
        const view = await observeOperation(dispatched.operationId);
        expect(["leased", "running", "completed"]).toContain(view.dispatchStatus);
        return view;
      },
      { timeout: 20_000 }
    );
    expect(accepted.agentEndpoint?.endpointId).toBe(agentEndpointId);
    expect(accepted.attempt?.hostId).toBeUndefined();

    // Terminal: request acceptance is not success; wait for completed/failed/cancelled.
    const terminal = await vi.waitFor(
      async () => {
        const view = await observeOperation(dispatched.operationId);
        expect(["completed", "failed", "cancelled"]).toContain(view.state);
        return view;
      },
      { timeout: 30_000 }
    );
    expect(terminal).toMatchObject({
      operationId: dispatched.operationId,
      blockRef: "T-001#B-001",
      state: "completed",
      dispatchStatus: "completed"
    });

    await stopPublicBin(host);

    host = startAgentHostBin(hostConfigPath);
    await vi.waitFor(
      async () => {
        expect((await readHost()).lastSeenAt).not.toBe(firstLastSeenAt);
      },
      { timeout: 30_000 }
    );
    await stopPublicBin(host);
    await stopPublicBin(server);

    server = await startServerBin(serverConfigPath, origin);
    await expect((await fetch(`${origin}/readyz`)).json()).resolves.toEqual({
      status: "ready",
      schemaVersion: latestCentralSchemaVersion
    });
    const hosts = (await (
      await fetch(`${origin}/api/v1/hosts`, { headers: authorization })
    ).json()) as { items: Array<{ id: string }> };
    const serverRevocation = await fetch(
      `${origin}/api/v1/hosts/${encodeURIComponent(hosts.items[0].id)}/revoke`,
      { method: "POST", headers: authorization }
    );
    expect(serverRevocation.status).toBe(200);
    await expect(serverRevocation.json()).resolves.toMatchObject({
      id: hosts.items[0].id,
      revokedAt: expect.any(String)
    });

    const statusAfterServerRevocation = await runAgentHostBin([
      "status",
      "--config",
      hostConfigPath
    ]);
    expect(statusAfterServerRevocation.code).toBe(0);
    // Local credential store is independent until the Host marks or replaces it.
    expect(JSON.parse(statusAfterServerRevocation.stdout)).toMatchObject({
      credential: "active"
    });
    const localRevocation = await runAgentHostBin(["revoke", "--config", hostConfigPath]);
    expect(localRevocation.code).toBe(0);
    expect(JSON.parse(localRevocation.stdout)).toMatchObject({
      credential: "revoked"
    });
    await stopPublicBin(server);
  }, 60_000);
});
