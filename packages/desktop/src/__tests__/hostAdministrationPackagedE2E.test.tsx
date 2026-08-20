/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { spawnManagedProcess, type ManagedProcessTree } from "@planweave-ai/runtime";
import { agentHostConfigSchema } from "../../../agent-host/src/config/schema.js";
import { parseAgentHostSetupHandoff } from "@planweave-ai/agent-host-protocol";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  RealProcessAcpHarness,
  type ProcessExitSnapshot
} from "../../../server/src/__tests__/support/realProcessAcpHarness.js";
import { OperatorControlService } from "../main/operatorControl/operatorControlService.js";
import type { OperatorSafeStoragePort } from "../main/operatorControl/operatorCredentialVault.js";

const agentHostBinPath = join(process.cwd(), "packages/agent-host/dist/bin.js");
const roots: string[] = [];
const harnesses: RealProcessAcpHarness[] = [];
const processes: RunningProcess[] = [];

type RunningProcess = {
  tree: ManagedProcessTree;
  logs: { stdout: string; stderr: string };
  exit: Promise<ProcessExitSnapshot>;
  exitSnapshot: ProcessExitSnapshot | undefined;
};

const unavailableSafeStorage: OperatorSafeStoragePort = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error("safeStorage_unavailable");
  },
  decryptString: () => {
    throw new Error("safeStorage_unavailable");
  }
};

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function startPackagedHost(configPath: string): RunningProcess {
  const managed = spawnManagedProcess({
    command: process.execPath,
    args: [agentHostBinPath, "run", "--config", configPath],
    env: { ...process.env },
    graceMs: 500
  });
  const logs = { stdout: "", stderr: "" };
  managed.child.stdout.setEncoding("utf8");
  managed.child.stderr.setEncoding("utf8");
  managed.child.stdout.on("data", (chunk: string) => {
    logs.stdout += chunk;
  });
  managed.child.stderr.on("data", (chunk: string) => {
    logs.stderr += chunk;
  });
  let snapshot: ProcessExitSnapshot | undefined;
  const exit = new Promise<ProcessExitSnapshot>((resolve) => {
    managed.child.once("exit", (code, signal) => {
      snapshot = { code, signal };
      resolve(snapshot);
    });
    managed.child.once("error", () => {
      snapshot = { code: null, signal: null };
      resolve(snapshot);
    });
  });
  const processHandle: RunningProcess = {
    tree: managed.tree,
    logs,
    exit,
    get exitSnapshot() {
      return snapshot;
    }
  };
  processes.push(processHandle);
  return processHandle;
}

async function waitForProcessExit(
  processHandle: RunningProcess,
  timeoutMs = 12_000
): Promise<ProcessExitSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle.exitSnapshot) return processHandle.exit;
    await wait(100);
  }
  throw new Error("packaged_host_exit_timeout");
}

async function waitForHost(
  service: OperatorControlService,
  profileId: string,
  displayName: string,
  timeoutMs = 15_000,
  lastSeenAtNot?: string
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = await service.listHosts({ profileId });
    const host = page.items.find(
      (candidate) =>
        candidate.displayName === displayName &&
        candidate.lastSeenAt &&
        (lastSeenAtNot === undefined || candidate.lastSeenAt !== lastSeenAtNot)
    );
    if (host) return host;
    await wait(100);
  }
  throw new Error(`packaged_host_online_timeout:${displayName}`);
}

async function writeHostConfig(
  harness: RealProcessAcpHarness,
  config: Record<string, unknown>,
  name: string
): Promise<string> {
  const path = join(harness.paths.root, name);
  await writeFile(path, JSON.stringify(config, null, 2), "utf8");
  return path;
}

afterEach(async () => {
  cleanup();
  const cleanupErrors: unknown[] = [];
  for (const processHandle of processes.splice(0)) {
    try {
      if (processHandle.tree.isAlive()) await processHandle.tree.terminate("test cleanup");
      await processHandle.exit;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const harness of harnesses.splice(0)) {
    try {
      await harness.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const root of roots.splice(0)) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "host_administration_e2e_cleanup_failed");
  }
});

describe("packaged Host administration control plane", () => {
  it("uses Desktop main operator authority to enroll, reconnect, observe, and revoke a packaged Host", async () => {
    const projectOperatorToken = `pw_operator_${"K".repeat(43)}`;
    const harness = await RealProcessAcpHarness.create({
      hostDisplayName: "Harness Host",
      operatorToken: `pw_operator_${"L".repeat(43)}`,
      projectOperatorToken,
      readinessTimeoutMs: 15_000,
      serverLimits: {
        heartbeatIntervalMs: 1_000,
        hostOfflineAfterMs: 4_000,
        leaseDurationMs: 5_000
      }
    });
    harnesses.push(harness);
    await harness.startServer();
    await harness.waitForServerReadyz();

    const desktopRoot = await mkdtemp(join(tmpdir(), "planweave-desktop-host-admin-"));
    roots.push(desktopRoot);
    const profileId = "desktop-packaged-host";
    const profile = {
      profileId,
      displayName: "UI Generated Host",
      serverBaseUrl: `${harness.origin}/`,
      allowInsecureTransport: true,
      endpoint: {
        topology: "loopback_http",
        serverOrigin: harness.origin,
        allowedClientOrigins: [harness.origin],
        tlsTrust: "not_applicable"
      }
    } as const;
    const service = new OperatorControlService({
      profileStorePaths: { profilesPath: join(desktopRoot, "profiles.json") },
      credentialsPath: join(desktopRoot, "credentials.json"),
      safeStorage: unavailableSafeStorage,
      request: fetch
    });
    await service.ensureMainOwnedServerProfile({
      profile,
      operatorId: "harness-operator",
      operatorToken: harness.operatorToken
    });

    const status = await service.getStatus();
    expect(status.credentialStorage).toBe("unavailable");
    expect(status.nonPersistenceWarning).toContain("session only");
    expect(JSON.stringify(status)).not.toContain(harness.operatorToken);
    expect(await readFile(join(desktopRoot, "profiles.json"), "utf8")).not.toContain(
      harness.operatorToken
    );
    expect(existsSync(join(desktopRoot, "credentials.json"))).toBe(false);

    const roleRejected = await fetch(`${harness.origin}/api/v1/host-enrollments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${projectOperatorToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
      })
    });
    expect(roleRejected.status).toBe(403);
    await expect(roleRejected.json()).resolves.toEqual({ error: "operator_admin_required" });

    const copiedHandoffs: string[] = [];
    const handoff = await service.copyHostBootstrapHandoff(
      {
        profileId,
        request: {
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
        }
      },
      (content) => copiedHandoffs.push(content)
    );
    expect(handoff).toMatchObject({ state: "ready" });
    expect(handoff.workspaceId).toBeUndefined();
    expect(JSON.stringify(handoff)).not.toContain("pw_enroll_");
    expect(copiedHandoffs).toHaveLength(1);
    const copiedHandoff = copiedHandoffs[0]!;
    const encodedHandoff = copiedHandoff.slice("planweave agent-host enroll ".length);
    const parsedHandoff = parseAgentHostSetupHandoff(encodedHandoff);
    const enrollmentCode = parsedHandoff.enrollmentCode;
    const uiConfig = {
      version: "agent-host-config/v1",
      coordinator: {
        url: parsedHandoff.endpoint.serverOrigin,
        allowInsecureDevelopment: true,
        endpoint: parsedHandoff.endpoint
      },
      dataDirectory: join(harness.paths.root, "ui-host-data"),
      workspaceRoot: harness.paths.workspaceRoot,
      host: { displayName: "UI Generated Host", capacity: 1, capabilities: ["acp.test"] },
      workspaces: parsedHandoff.workspaceId
        ? [{ id: parsedHandoff.workspaceId, path: "project" }]
        : [],
      runtimeProjects: [],
      agentProfiles: []
    };
    expect(uiConfig).not.toHaveProperty("enrollmentCode");
    expect(agentHostConfigSchema.parse(uiConfig)).toEqual(uiConfig);

    const generatedConfig = {
      ...uiConfig,
      workspaces: [],
      agentProfiles: []
    };
    const hostConfigPath = await writeHostConfig(harness, generatedConfig, "ui-agent-host.json");
    expect(agentHostConfigSchema.parse(JSON.parse(await readFile(hostConfigPath, "utf8")))).toEqual(
      generatedConfig
    );

    const preflight = await harness.runHostCommand(["preflight", "--config", hostConfigPath]);
    expect(preflight).toMatchObject({ code: 0 });
    expect(JSON.parse(preflight.stdout)).toMatchObject({
      credential: "missing",
      connection: "offline"
    });
    const enrollment = await harness.runHostCommand([
      "enroll",
      "--config",
      hostConfigPath,
      "--code",
      enrollmentCode
    ]);
    expect(enrollment.code).toBe(0);
    expect(JSON.parse(enrollment.stdout)).toMatchObject({ credential: "active" });

    const reusedConfig = {
      ...generatedConfig,
      dataDirectory: join(harness.paths.root, "reused-host-data")
    };
    const reusedConfigPath = await writeHostConfig(harness, reusedConfig, "reused-agent-host.json");
    const reused = await harness.runHostCommand([
      "enroll",
      "--config",
      reusedConfigPath,
      "--code",
      enrollmentCode
    ]);
    expect(reused.code).not.toBe(0);
    expect(reused.stderr).toContain("agent_host_enrollment_rejected");
    expect(reused.stderr).not.toContain(enrollmentCode);

    const expiringGrant = await service.createEnrollmentGrant({
      profileId,
      request: {
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
      }
    });
    await wait(1_500);
    const expiredConfig = {
      ...generatedConfig,
      dataDirectory: join(harness.paths.root, "expired-host-data")
    };
    const expiredConfigPath = await writeHostConfig(
      harness,
      expiredConfig,
      "expired-agent-host.json"
    );
    const expired = await harness.runHostCommand([
      "enroll",
      "--config",
      expiredConfigPath,
      "--code",
      expiringGrant.enrollmentCode
    ]);
    expect(expired.code).not.toBe(0);
    expect(expired.stderr).toContain("agent_host_enrollment_rejected");
    expect(expired.stderr).not.toContain(expiringGrant.enrollmentCode);

    const firstProcess = startPackagedHost(hostConfigPath);
    const firstHost = await waitForHost(service, profileId, "UI Generated Host");
    expect(firstHost.online).toBe(true);
    expect(firstHost.lastSeenAt).toEqual(expect.any(String));
    const firstHostId = firstHost.id;
    expect(firstHost.credentialExpiresAt).toEqual(expect.any(String));

    await firstProcess.tree.terminate("reconnect test");
    await firstProcess.exit;
    await wait(1_100);
    const reconnectProcess = startPackagedHost(hostConfigPath);
    const reconnectedHost = await waitForHost(
      service,
      profileId,
      "UI Generated Host",
      15_000,
      firstHost.lastSeenAt
    );
    expect(reconnectedHost.id).toBe(firstHostId);
    expect(reconnectedHost.lastSeenAt).not.toBe(firstHost.lastSeenAt);

    const revoked = await service.revokeHost({ profileId, hostId: firstHostId });
    expect(revoked).toMatchObject({
      id: firstHostId,
      online: false,
      revokedAt: expect.any(String)
    });
    const exited = await waitForProcessExit(reconnectProcess);
    expect(exited.code).not.toBe(0);
    expect(reconnectProcess.logs.stderr).toContain("agent_host_auth_failed");
    expect(reconnectProcess.logs.stderr).not.toContain(harness.operatorToken);

    const staleReconnect = startPackagedHost(hostConfigPath);
    const staleExit = await waitForProcessExit(staleReconnect);
    expect(staleExit.code).not.toBe(0);
    expect(staleReconnect.logs.stderr).toContain("agent_host_auth_failed");
    expect(
      JSON.parse((await harness.runHostCommand(["status", "--config", hostConfigPath])).stdout)
    ).toMatchObject({ credential: "active" });
  }, 60_000);
});
