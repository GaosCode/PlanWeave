import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHostOperator } from "../operator/agentHostOperator.js";
import { writeHostConnectionStatus } from "../transport/connectionStatus.js";
import {
  assertDurableStateReplacementSafe,
  ensureDurableHostIdentity
} from "../state/durableHostIdentity.js";
import type { PrivateStorageSecurityPort } from "../storage/privateStorageSecurity.js";
import {
  AGENT_HOST_CLI_USAGE,
  type AgentHostOperatorService,
  parseAgentHostArgs,
  runAgentHostCli,
  waitForAgentHostSignal
} from "../operator/cli.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

function operator(overrides: Partial<AgentHostOperatorService> = {}): AgentHostOperatorService {
  return {
    initializePreset: vi.fn(),
    preflight: vi.fn(),
    enroll: vi.fn(),
    createDaemon: vi.fn(),
    status: vi.fn(),
    revoke: vi.fn(),
    enrollHandoff: vi.fn(),
    listAgents: vi.fn(),
    reconcileAgentExposure: vi.fn(),
    exposeAgent: vi.fn(),
    hideAgent: vi.fn(),
    installBackground: vi.fn(),
    uninstallBackground: vi.fn(),
    backgroundStatus: vi.fn(),
    restartBackground: vi.fn(),
    backgroundLogs: vi.fn(),
    ...overrides
  };
}

describe("Agent Host operator CLI", () => {
  it("preflights config, stores, workspaces, and profiles without exposing local paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-agent-host-cli-"));
    directories.push(root);
    await mkdir(join(root, "workspace", "project"), { recursive: true });
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "agent-host-config/v1",
        coordinator: { url: "http://127.0.0.1:9999", allowInsecureDevelopment: true },
        dataDirectory: join(root, "data"),
        workspaceRoot: join(root, "workspace"),
        host: { displayName: "test-host", capacity: 1, capabilities: ["acp.test"] },
        workspaces: [{ id: "workspace-1", path: "project" }],
        agentProfiles: [
          {
            id: "profile-1",
            agentId: "agent-1",
            command: "/usr/bin/env",
            args: [],
            environment: []
          }
        ]
      })
    );

    const diagnostics = await new AgentHostOperator().preflight(configPath);
    expect(diagnostics).toMatchObject({
      credential: "missing",
      capabilities: ["acp.test"],
      capacity: 1,
      connection: "offline",
      recoverableExecutions: 0
    });
    expect(JSON.stringify(diagnostics)).not.toContain(root);
  });

  it("reports durable mailbox reconciliation as an actionable status", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-agent-host-reconciliation-"));
    directories.push(root);
    const dataDirectory = join(root, "data");
    const workspaceRoot = join(root, "workspace");
    const configPath = join(root, "config.json");
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        version: "agent-host-config/v1",
        coordinator: { url: "http://127.0.0.1:9999", allowInsecureDevelopment: true },
        dataDirectory,
        workspaceRoot,
        host: { displayName: "test-host", capacity: 1, capabilities: ["acp.test"] },
        workspaces: [],
        agentProfiles: []
      })
    );
    await writeHostConnectionStatus(dataDirectory, {
      state: "reconciliation-required",
      reason: "mailbox_message_retention_horizon_exceeded"
    });

    await expect(new AgentHostOperator().status(configPath)).resolves.toMatchObject({
      connection: "offline",
      actionableError: "mailbox_reconciliation_required"
    });
  });

  it("parses stable commands and rejects incomplete or unknown arguments", () => {
    expect(parseAgentHostArgs(["status", "--config", "/config.json"])).toEqual({
      command: "status",
      configPath: "/config.json",
      code: undefined,
      exposeProfiles: [],
      replace: false
    });
    expect(
      parseAgentHostArgs(["enroll", "--config", "/config.json", "--code", "once", "--replace"])
    ).toMatchObject({ command: "enroll", code: "once", replace: true });
    expect(
      parseAgentHostArgs(["config-init", "--config", "/config.json", "--preset", "codex-acp"])
    ).toEqual({
      command: "config-init",
      configPath: "/config.json",
      preset: "codex-acp",
      code: undefined,
      exposeProfiles: [],
      replace: false
    });
    expect(() => parseAgentHostArgs(["enroll", "--config", "/config.json"])).toThrow(
      "agent_host_cli_enrollment_code_required"
    );
    expect(() => parseAgentHostArgs(["status", "--config", "/config.json", "--unknown"])).toThrow(
      "agent_host_cli_usage"
    );
    expect(() => parseAgentHostArgs(["config-init", "--config", "/config.json"])).toThrow(
      "agent_host_cli_preset_required"
    );
    expect(parseAgentHostArgs(["service", "status", "--config", "/config.json"])).toEqual({
      command: "service-status",
      configPath: "/config.json",
      exposeProfiles: [],
      replace: false
    });
    expect(() => parseAgentHostArgs(["service", "status", "/config.json"])).toThrow(
      "agent_host_cli_config_required"
    );
    expect(() => parseAgentHostArgs(["service", "status", "--config", "relative.json"])).toThrow(
      "agent_host_cli_config_absolute_required"
    );
    expect(() =>
      parseAgentHostArgs(["service", "status", "--config", "/config.json", "--extra"])
    ).toThrow("agent_host_cli_usage");
    expect(
      parseAgentHostArgs([
        "run",
        "--config",
        "/config.json",
        "--background-instance",
        "0123456789abcdef"
      ])
    ).toMatchObject({ command: "run", configPath: "/config.json" });
    expect(() =>
      parseAgentHostArgs(["run", "--config", "/config.json", "--background-instance", "invalid"])
    ).toThrow("agent_host_cli_usage");
  });

  it("routes service lifecycle commands without changing Host diagnostics status", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const methods = {
      installBackground: vi.fn().mockResolvedValue({ state: "running" }),
      uninstallBackground: vi.fn().mockResolvedValue({ state: "not_installed" }),
      backgroundStatus: vi.fn().mockResolvedValue({ state: "stopped" }),
      restartBackground: vi.fn().mockResolvedValue({ state: "running" }),
      backgroundLogs: vi.fn().mockResolvedValue({ source: "systemd-journal" }),
      status: vi.fn().mockResolvedValue({ credential: "active" })
    };
    const service = operator(methods);
    const launcher = {
      executablePath: "/opt/node/bin/node",
      fixedArgs: ["/opt/agent-host/dist/bin.js"]
    };
    for (const action of ["install", "uninstall", "status", "restart", "logs"] as const) {
      await expect(
        runAgentHostCli(["service", action, "--config", "/private/config.json"], {
          operator: service,
          launcher,
          io: { stdout, stderr }
        })
      ).resolves.toBe(0);
    }
    await runAgentHostCli(["status", "--config", "/private/config.json"], {
      operator: service,
      io: { stdout, stderr }
    });

    expect(methods.installBackground).toHaveBeenCalledWith("/private/config.json", launcher);
    expect(methods.uninstallBackground).toHaveBeenCalledWith("/private/config.json");
    expect(methods.backgroundStatus).toHaveBeenCalledWith("/private/config.json");
    expect(methods.restartBackground).toHaveBeenCalledWith("/private/config.json");
    expect(methods.backgroundLogs).toHaveBeenCalledWith("/private/config.json");
    expect(methods.status).toHaveBeenCalledWith("/private/config.json");
    expect(JSON.stringify(stdout.mock.calls)).not.toContain("/private/config.json");
  });

  it("initializes only the fixed ACP preset through the operator service", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const initializePreset = vi.fn().mockResolvedValue({ host: { capabilities: ["acp.codex"] } });
    await expect(
      runAgentHostCli(
        ["config-init", "--config", "/private/config.json", "--preset", "codex-acp"],
        {
          operator: operator({ initializePreset }),
          io: { stdout, stderr }
        }
      )
    ).resolves.toBe(0);
    expect(initializePreset).toHaveBeenCalledWith("/private/config.json", "codex-acp");
    expect(JSON.stringify(stdout.mock.calls)).not.toContain("/private/config.json");
  });

  it("uses service methods and maps usage and operational failures to exit codes", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const service = operator({ status: vi.fn().mockResolvedValue({ credential: "active" }) });
    await expect(
      runAgentHostCli(["status", "--config", "/private/config.json"], {
        operator: service,
        io: { stdout, stderr }
      })
    ).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith('{"credential":"active"}');
    expect(JSON.stringify(stdout.mock.calls)).not.toContain("/private/config.json");
    await expect(runAgentHostCli(["unknown"], { io: { stdout, stderr } })).resolves.toBe(2);
    expect(stderr).toHaveBeenLastCalledWith("agent_host_cli_usage");
  });

  it.each(["--help", "-h"])("prints public usage and exits 0 for %s", async (argument) => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    await expect(runAgentHostCli([argument], { io: { stdout, stderr } })).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(AGENT_HOST_CLI_USAGE);
    expect(stderr).not.toHaveBeenCalled();
    expect(AGENT_HOST_CLI_USAGE).toContain("service install --config <absolute-path>");
    expect(AGENT_HOST_CLI_USAGE).toContain("service logs --config <absolute-path>");
  });

  it("reports usage on stderr and exits 2 when no command is provided", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    await expect(runAgentHostCli([], { io: { stdout, stderr } })).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledExactlyOnceWith("agent_host_cli_usage");
    expect(stdout).not.toHaveBeenCalled();
  });

  it.each(["SIGINT", "SIGTERM"] as const)("shuts down once after %s", async (signal) => {
    const processLike = new EventEmitter();
    const composition = {
      start: vi.fn(),
      shutdown: vi.fn(),
      subscribeStatus: vi.fn((listener) => {
        listener({ state: "stopped" });
        return vi.fn();
      })
    };
    const running = waitForAgentHostSignal(composition, processLike as never);
    await vi.waitFor(() => expect(composition.start).toHaveBeenCalledOnce());
    processLike.emit(signal);
    await running;
    expect(composition.shutdown).toHaveBeenCalledOnce();
    expect(processLike.listenerCount("SIGINT")).toBe(0);
    expect(processLike.listenerCount("SIGTERM")).toBe(0);
  });

  it.each([
    [{ state: "auth-failed", reason: "credential_rejected" } as const, "agent_host_auth_failed"],
    [
      {
        state: "reconciliation-required",
        reason: "mailbox_message_retention_horizon_exceeded"
      } as const,
      "agent_host_mailbox_reconciliation_required"
    ],
    [{ state: "degraded", reason: "protocol_rejected" } as const, "agent_host_transport_degraded"]
  ])("exits when the transport reaches terminal status", async (terminal, expectedError) => {
    let statusListener: ((status: typeof terminal | { state: "stopped" }) => void) | undefined;
    const composition = {
      subscribeStatus: vi.fn((listener) => {
        statusListener = listener;
        listener({ state: "stopped" });
        return vi.fn();
      }),
      start: vi.fn(() => statusListener?.(terminal)),
      shutdown: vi.fn()
    };
    const stderr = vi.fn();
    await expect(
      runAgentHostCli(["run", "--config", "/private/config.json"], {
        operator: operator({ createDaemon: vi.fn().mockResolvedValue(composition) }),
        io: { stdout: vi.fn(), stderr },
        processLike: new EventEmitter() as never
      })
    ).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith(expectedError);
    expect(composition.shutdown).toHaveBeenCalledOnce();
  });

  it("redacts arbitrary exceptions, paths, tokens, and payloads", async () => {
    const stderr = vi.fn();
    const privateValue = "/Users/operator/secret token=pw_host_secret prompt contents";
    const service = operator({ preflight: vi.fn().mockRejectedValue(new Error(privateValue)) });
    await expect(
      runAgentHostCli(["preflight", "--config", "/secret/config.json"], {
        operator: service,
        io: { stdout: vi.fn(), stderr }
      })
    ).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith("agent_host_failed");
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(privateValue);
  });

  it("reports a fixed CA error without exposing its path", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-agent-host-ca-cli-"));
    directories.push(root);
    await mkdir(join(root, "workspace"), { recursive: true });
    const privateCaPath = join(root, "private-ca.pem");
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "agent-host-config/v1",
        coordinator: {
          url: "https://127.0.0.1:7443",
          caCertificatePath: privateCaPath
        },
        dataDirectory: join(root, "data"),
        workspaceRoot: join(root, "workspace"),
        host: { displayName: "test-host", capacity: 1, capabilities: ["acp.test"] },
        workspaces: [],
        agentProfiles: []
      })
    );
    const stderr = vi.fn();
    await expect(
      runAgentHostCli(["preflight", "--config", configPath], {
        io: { stdout: vi.fn(), stderr }
      })
    ).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith("agent_host_ca_certificate_unreadable");
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(privateCaPath);
  });

  it("binds durable stores to one Host and refuses replacement after state exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-agent-host-identity-"));
    directories.push(root);
    const dataDirectory = join(root, "data");
    await ensureDurableHostIdentity(dataDirectory, "host-original", "workspace-001");
    await expect(
      ensureDurableHostIdentity(dataDirectory, "host-original", "workspace-001")
    ).resolves.toBeUndefined();
    await expect(
      ensureDurableHostIdentity(dataDirectory, "host-replacement", "workspace-001")
    ).rejects.toThrow("agent_host_durable_identity_mismatch");
    await expect(assertDurableStateReplacementSafe(dataDirectory)).rejects.toThrow(
      "agent_host_reenrollment_requires_durable_state_export"
    );

    const orphanRoot = join(root, "orphan");
    const orphanData = join(orphanRoot, "data");
    await mkdir(orphanData, { recursive: true, mode: 0o700 });
    await writeFile(join(orphanData, "state.sqlite"), "legacy-state");
    await expect(
      ensureDurableHostIdentity(orphanData, "host-new", "workspace-001")
    ).rejects.toThrow("agent_host_durable_identity_unbound");
    const configPath = join(orphanRoot, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "agent-host-config/v1",
        coordinator: { url: "http://127.0.0.1:9999", allowInsecureDevelopment: true },
        dataDirectory: orphanData,
        workspaceRoot: orphanRoot,
        host: { displayName: "orphan-host", capacity: 1, capabilities: ["acp.test"] },
        workspaces: [],
        agentProfiles: []
      })
    );
    await expect(
      new AgentHostOperator().enroll(configPath, `pw_enroll_${"a".repeat(43)}`)
    ).rejects.toThrow("agent_host_reenrollment_requires_durable_state_export");
  });

  it("uses the platform security policy for durable identity instead of POSIX modes on Windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-agent-host-windows-identity-"));
    directories.push(root);
    const dataDirectory = join(root, "data");
    const prepareDirectory = vi.fn(async (path: string) => mkdir(path, { recursive: true }));
    const secureFile = vi.fn(async () => undefined);
    const security: PrivateStorageSecurityPort = {
      permissionModel: "windows-acl",
      prepareDirectory,
      secureFile
    };

    await expect(
      ensureDurableHostIdentity(dataDirectory, "host-windows", "workspace-001", security)
    ).resolves.toBeUndefined();

    expect(prepareDirectory).toHaveBeenCalledWith(dataDirectory);
    expect(secureFile).toHaveBeenCalledWith(join(dataDirectory, "durable-host.json"));
  });
});
