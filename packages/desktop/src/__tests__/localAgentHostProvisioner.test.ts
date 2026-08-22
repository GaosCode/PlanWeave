import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentHostDefaultPaths, writeHostConnectionStatus } from "@planweave-ai/agent-host";
import { serializeAgentHostSetupHandoff } from "@planweave-ai/agent-host-protocol";
import { DesktopLocalAgentHostProvisioner } from "../main/operatorControl/localAgentHostProvisioner.js";
import { LocalAgentHostRegistrationStore } from "../main/operatorControl/localAgentHostRegistrationStore.js";

const roots: string[] = [];

function fleetHandoff(): string {
  return serializeAgentHostSetupHandoff({
    version: "agent-host-setup/v2",
    endpoint: {
      topology: "private_https",
      serverOrigin: "https://planweave.example.test",
      allowedClientOrigins: ["https://planweave.example.test"],
      tlsTrust: "system_ca"
    },
    enrollmentCode: `pw_enroll_${"a".repeat(43)}`,
    expiresAt: "2030-01-01T00:00:00.000Z",
    credentialExpiresAt: "2030-06-30T00:00:00.000Z",
    credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
    display: { workspaceName: "Owner fleet", serverName: "Private server" }
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Desktop local Agent Host provisioner", () => {
  it("supports macOS through the platform background capability", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-agent-host-macos-"));
    roots.push(root);
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "darwin",
      launcher: { executablePath: "/Applications/PlanWeave.app/PlanWeave" },
      operator: {} as never,
      registrations: new LocalAgentHostRegistrationStore(join(root, "registrations.json"))
    });
    await expect(provisioner.status("profile-a")).resolves.toMatchObject({
      supported: true,
      state: "not_registered"
    });
  });

  it("reports the capability as unavailable when no background adapter exists", async () => {
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "aix",
      launcher: { executablePath: "/opt/PlanWeave/PlanWeave" },
      operator: {} as never
    });
    await expect(provisioner.status("profile-a")).resolves.toMatchObject({
      supported: false,
      state: "not_registered"
    });
  });

  it("persists registration and uses the same PlanWeave executable for background mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-agent-host-"));
    roots.push(root);
    const registrations = new LocalAgentHostRegistrationStore(join(root, "registrations.json"), {
      now: () => new Date("2030-01-01T00:00:00.000Z")
    });
    const agents = [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        detected: true,
        exposed: true,
        ready: true
      },
      {
        profileId: "claude-acp",
        agentId: "claude",
        displayName: "Claude",
        detected: true,
        exposed: false,
        ready: false
      }
    ];
    const operator = {
      enrollHandoff: vi.fn().mockResolvedValue({
        state: "ready",
        workspaceId: "workspace-1",
        credential: "active",
        background: "running",
        configPath: "C:\\private\\config.json",
        agents: [
          { ...agents[0], exposed: false, ready: false },
          { ...agents[1], exposed: true, ready: true }
        ],
        nextSteps: {}
      }),
      reconcileAgentExposure: vi.fn().mockResolvedValue({ agents, reload: "restarted" }),
      installBackground: vi.fn().mockResolvedValue({
        state: "running",
        platform: "windows-user-startup"
      }),
      listAgents: vi.fn().mockResolvedValue(agents),
      requireUsableCredential: vi.fn().mockResolvedValue(undefined),
      backgroundStatus: vi
        .fn()
        .mockResolvedValue({ state: "running", platform: "windows-user-startup" })
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "win32",
      launcher: {
        executablePath: "C:\\Program Files\\PlanWeave\\PlanWeave.exe",
        fixedArgs: ["--agent-host-service"]
      },
      operator,
      registrations
    });

    await expect(
      provisioner.register("profile-a", "opaque-handoff", ["codex-acp"])
    ).resolves.toMatchObject({
      supported: true,
      state: "ready",
      workspaceId: "workspace-1",
      agents
    });
    expect(operator.enrollHandoff).toHaveBeenCalledWith("opaque-handoff", {
      installBackground: false,
      executablePath: "C:\\Program Files\\PlanWeave\\PlanWeave.exe",
      fixedArgs: ["--agent-host-service"]
    });
    expect(operator.reconcileAgentExposure).toHaveBeenCalledWith("C:\\private\\config.json", [
      "codex-acp"
    ]);
    await expect(provisioner.status("profile-a")).resolves.toMatchObject({
      state: "ready",
      workspaceId: "workspace-1",
      agents
    });
    await expect(provisioner.status()).resolves.toMatchObject({
      state: "ready",
      workspaceId: "workspace-1",
      agents
    });
  });

  it("installs the background Host after selected Agent exposure is persisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-agent-host-background-"));
    roots.push(root);
    const registrations = new LocalAgentHostRegistrationStore(join(root, "registrations.json"));
    const agents = [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        detected: true,
        exposed: true,
        ready: true
      }
    ];
    const operator = {
      enrollHandoff: vi.fn().mockResolvedValue({
        state: "ready",
        workspaceId: "workspace-background",
        credential: "active",
        background: "disabled",
        configPath: "C:\\private\\background.json",
        agents: [{ ...agents[0], exposed: false, ready: false }],
        nextSteps: {}
      }),
      reconcileAgentExposure: vi.fn().mockResolvedValue({ agents, reload: "restart_required" }),
      installBackground: vi.fn().mockResolvedValue({
        state: "running",
        platform: "windows-user-startup"
      }),
      listAgents: vi.fn().mockResolvedValue(agents),
      requireUsableCredential: vi.fn().mockResolvedValue(undefined),
      backgroundStatus: vi.fn().mockResolvedValue({
        state: "running",
        platform: "windows-user-startup"
      })
    };
    const launcher = {
      executablePath: "C:\\Program Files\\PlanWeave\\PlanWeave.exe",
      fixedArgs: ["--agent-host-service"]
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "win32",
      launcher,
      operator,
      registrations
    });

    await expect(
      provisioner.register(undefined, "opaque-handoff", ["codex-acp"])
    ).resolves.toMatchObject({
      state: "ready",
      background: "running",
      agents
    });
    expect(operator.enrollHandoff).toHaveBeenCalledWith("opaque-handoff", {
      installBackground: false,
      executablePath: launcher.executablePath,
      fixedArgs: launcher.fixedArgs
    });
    expect(operator.reconcileAgentExposure).toHaveBeenCalledBefore(operator.installBackground);
    expect(operator.installBackground).toHaveBeenCalledWith(
      "C:\\private\\background.json",
      launcher
    );
  });

  it("repairs an enrolled Host without redeeming another handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-agent-host-repair-"));
    roots.push(root);
    const registrations = new LocalAgentHostRegistrationStore(join(root, "registrations.json"));
    await registrations.upsert("profile-a", {
      instanceKey: "workspace-repair",
      workspaceId: "workspace-repair"
    });
    const configPath = resolveAgentHostDefaultPaths("workspace-repair").configPath;
    const agents = [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        detected: true,
        exposed: true,
        ready: true
      }
    ];
    const operator = {
      installBackground: vi.fn().mockResolvedValue({
        state: "running",
        platform: "windows-user-startup"
      }),
      reconcileAgentExposure: vi.fn().mockResolvedValue({ agents, reload: "restarted" }),
      listAgents: vi.fn().mockResolvedValue(agents),
      requireUsableCredential: vi.fn().mockResolvedValue(undefined)
    };
    const launcher = {
      executablePath: "C:\\Program Files\\PlanWeave\\PlanWeave.exe",
      fixedArgs: ["--agent-host-service"]
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "win32",
      launcher,
      operator: operator as never,
      registrations
    });

    await expect(provisioner.repair("profile-a", ["codex-acp"])).resolves.toMatchObject({
      state: "ready",
      background: "running",
      workspaceId: "workspace-repair",
      agents
    });
    expect(operator.reconcileAgentExposure).toHaveBeenCalledWith(configPath, ["codex-acp"]);
    expect(operator.installBackground).toHaveBeenCalledWith(configPath, launcher);
  });

  it("indexes handoff enrollment by Workspace when no operator profile is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-agent-host-handoff-"));
    roots.push(root);
    const registrations = new LocalAgentHostRegistrationStore(join(root, "registrations.json"));
    const agents = [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        detected: true,
        exposed: true,
        ready: true
      }
    ];
    const operator = {
      enrollHandoff: vi.fn().mockResolvedValue({
        state: "ready",
        workspaceId: "workspace-handoff",
        credential: "active",
        background: "running",
        configPath: "C:\\private\\handoff.json",
        agents,
        nextSteps: {}
      }),
      reconcileAgentExposure: vi.fn().mockResolvedValue({ agents, reload: "restarted" }),
      installBackground: vi.fn().mockResolvedValue({
        state: "running",
        platform: "windows-user-startup"
      }),
      listAgents: vi.fn().mockResolvedValue(agents),
      requireUsableCredential: vi.fn().mockResolvedValue(undefined),
      backgroundStatus: vi
        .fn()
        .mockResolvedValue({ state: "running", platform: "windows-user-startup" })
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "win32",
      launcher: { executablePath: "C:\\PlanWeave.exe", fixedArgs: ["--agent-host-service"] },
      operator,
      registrations
    });

    await provisioner.register(undefined, "opaque-handoff", ["codex-acp"]);

    await expect(registrations.get("workspace-handoff")).resolves.toMatchObject({
      instanceKey: "workspace-handoff",
      workspaceId: "workspace-handoff"
    });
    await expect(provisioner.status()).resolves.toMatchObject({
      state: "ready",
      workspaceId: "workspace-handoff"
    });
  });

  it("keeps fleet instance identity separate from Workspace identity after restart and repair", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-agent-host-fleet-"));
    roots.push(root);
    const registrationPath = join(root, "registrations.json");
    const agents = [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        detected: true,
        exposed: true,
        ready: true
      }
    ];
    const operator = {
      enrollHandoff: vi.fn().mockResolvedValue({
        state: "ready",
        credential: "active",
        background: "running",
        configPath: "C:\\private\\fleet.json",
        agents,
        nextSteps: {}
      }),
      reconcileAgentExposure: vi.fn().mockResolvedValue({ agents, reload: "restarted" }),
      installBackground: vi.fn().mockResolvedValue({
        state: "running",
        platform: "windows-user-startup"
      }),
      listAgents: vi.fn().mockResolvedValue(agents),
      requireUsableCredential: vi.fn().mockResolvedValue(undefined),
      backgroundStatus: vi
        .fn()
        .mockResolvedValue({ state: "running", platform: "windows-user-startup" })
    };
    const launcher = {
      executablePath: "C:\\PlanWeave.exe",
      fixedArgs: ["--agent-host-service"]
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "win32",
      launcher,
      operator,
      registrations: new LocalAgentHostRegistrationStore(registrationPath)
    });

    const registered = await provisioner.register("profile-fleet", fleetHandoff(), ["codex-acp"]);
    expect(registered).not.toHaveProperty("workspaceId");
    const registration = await new LocalAgentHostRegistrationStore(registrationPath).get(
      "profile-fleet"
    );
    expect(registration).toMatchObject({
      profileId: "profile-fleet",
      instanceKey: expect.stringMatching(/^fleet-/)
    });
    expect(registration).not.toHaveProperty("workspaceId");
    if (!registration) throw new Error("Expected fleet registration");

    const restarted = new DesktopLocalAgentHostProvisioner({
      platform: "win32",
      launcher,
      operator,
      registrations: new LocalAgentHostRegistrationStore(registrationPath)
    });
    const status = await restarted.status("profile-fleet");
    expect(status).not.toHaveProperty("workspaceId");
    expect(operator.listAgents).toHaveBeenLastCalledWith(
      resolveAgentHostDefaultPaths(registration.instanceKey).configPath
    );
    const repaired = await restarted.repair("profile-fleet", ["codex-acp"]);
    expect(repaired).not.toHaveProperty("workspaceId");
  });

  it("migrates legacy registrations without guessing their Workspace identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-agent-host-migration-"));
    roots.push(root);
    const registrationPath = join(root, "registrations.json");
    await writeFile(
      registrationPath,
      `${JSON.stringify({
        version: 1,
        registrations: [
          {
            profileId: "profile-legacy",
            workspaceId: "workspace-legacy",
            updatedAt: "2030-01-01T00:00:00.000Z"
          }
        ]
      })}\n`,
      "utf8"
    );

    await expect(
      new LocalAgentHostRegistrationStore(registrationPath).get("profile-legacy")
    ).resolves.toMatchObject({
      profileId: "profile-legacy",
      instanceKey: "workspace-legacy"
    });
    expect(
      await new LocalAgentHostRegistrationStore(registrationPath).get("profile-legacy")
    ).not.toHaveProperty("workspaceId");
    expect(JSON.parse(await readFile(registrationPath, "utf8"))).toMatchObject({
      version: 2,
      registrations: [
        {
          profileId: "profile-legacy",
          instanceKey: "workspace-legacy"
        }
      ]
    });
  });

  it.each([
    { label: "Workspace", resolvedWorkspaceId: "workspace-configured" },
    { label: "fleet", resolvedWorkspaceId: undefined }
  ])("restores $label identity for legacy registrations from Agent Host config truth", async ({
    resolvedWorkspaceId
  }) => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-agent-host-v1-truth-"));
    roots.push(root);
    const registrationPath = join(root, "registrations.json");
    const instanceKey = "legacy-instance-key";
    await writeFile(
      registrationPath,
      `${JSON.stringify({
        version: 1,
        registrations: [
          {
            profileId: "profile-legacy",
            workspaceId: instanceKey,
            updatedAt: "2030-01-01T00:00:00.000Z"
          }
        ]
      })}\n`,
      "utf8"
    );
    const agents = [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        detected: true,
        exposed: true,
        ready: true
      }
    ];
    const operator = {
      listAgents: vi.fn().mockResolvedValue(agents),
      requireUsableCredential: vi.fn().mockResolvedValue(undefined),
      resolveWorkspaceId: vi.fn().mockResolvedValue(resolvedWorkspaceId),
      backgroundStatus: vi
        .fn()
        .mockResolvedValue({ state: "running", platform: "windows-user-startup" }),
      reconcileAgentExposure: vi.fn().mockResolvedValue({ agents, reload: "restarted" }),
      installBackground: vi.fn().mockResolvedValue({
        state: "running",
        platform: "windows-user-startup"
      })
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "win32",
      launcher: { executablePath: "C:\\PlanWeave.exe", fixedArgs: ["--agent-host-service"] },
      operator: operator as never,
      registrations: new LocalAgentHostRegistrationStore(registrationPath)
    });

    const status = await provisioner.status("profile-legacy");
    const repaired = await provisioner.repair("profile-legacy", ["codex-acp"]);
    if (resolvedWorkspaceId) {
      expect(status).toMatchObject({ workspaceId: resolvedWorkspaceId });
      expect(repaired).toMatchObject({ workspaceId: resolvedWorkspaceId });
    } else {
      expect(status).not.toHaveProperty("workspaceId");
      expect(repaired).not.toHaveProperty("workspaceId");
    }
    expect(operator.resolveWorkspaceId).toHaveBeenCalledWith(
      resolveAgentHostDefaultPaths(instanceKey).configPath
    );
  });

  it("reports a sanitized enrollment stage and system code", async () => {
    const operator = {
      enrollHandoff: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("private executable path"), { code: "ENOENT" }))
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "win32",
      launcher: { executablePath: "C:\\PlanWeave.exe", fixedArgs: ["--agent-host-service"] },
      operator: operator as never
    });

    await expect(provisioner.register(undefined, "opaque-handoff", ["codex-acp"])).rejects.toThrow(
      "local_agent_host_enrollment_failed_enoent"
    );
  });

  it("reports status-read failures without exposing private process details", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-agent-host-status-"));
    roots.push(root);
    const registrations = new LocalAgentHostRegistrationStore(join(root, "registrations.json"));
    await registrations.upsert("workspace-status", {
      instanceKey: "workspace-status",
      workspaceId: "workspace-status"
    });
    const operator = {
      listAgents: vi.fn().mockResolvedValue([]),
      requireUsableCredential: vi.fn().mockResolvedValue(undefined),
      backgroundStatus: vi.fn().mockRejectedValue(new Error("private scheduled task command"))
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "win32",
      launcher: { executablePath: "C:\\PlanWeave.exe", fixedArgs: ["--agent-host-service"] },
      operator: operator as never,
      registrations
    });

    await expect(provisioner.status()).rejects.toThrow(
      "local_agent_host_background_status_read_failed"
    );
  });

  it("treats a registration whose Agent Host config is missing as not registered", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-agent-host-orphaned-"));
    roots.push(root);
    const registrations = new LocalAgentHostRegistrationStore(join(root, "registrations.json"));
    await registrations.upsert("workspace-orphaned", {
      instanceKey: "workspace-orphaned",
      workspaceId: "workspace-orphaned"
    });
    const missingConfigError = Object.assign(new Error("private missing config path"), {
      code: "ENOENT"
    });
    const operator = {
      listAgents: vi.fn().mockRejectedValue(missingConfigError),
      requireUsableCredential: vi.fn(),
      backgroundStatus: vi.fn()
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "darwin",
      launcher: { executablePath: "/Applications/PlanWeave.app/PlanWeave" },
      operator: operator as never,
      registrations
    });

    await expect(provisioner.status()).resolves.toMatchObject({
      supported: true,
      state: "not_registered"
    });
    expect(operator.requireUsableCredential).not.toHaveBeenCalled();
    expect(operator.backgroundStatus).not.toHaveBeenCalled();
    await expect(registrations.get("workspace-orphaned")).resolves.toBeNull();
  });

  it("restores not_registered when stored Host credentials are unusable", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-agent-host-credential-"));
    roots.push(root);
    const registrations = new LocalAgentHostRegistrationStore(join(root, "registrations.json"));
    await registrations.upsert("profile-a", {
      instanceKey: "workspace-credential",
      workspaceId: "workspace-credential"
    });
    const configPath = resolveAgentHostDefaultPaths("workspace-credential").configPath;
    const operator = {
      listAgents: vi.fn().mockResolvedValue([
        {
          profileId: "pi-acp",
          agentId: "pi",
          displayName: "Pi",
          detected: true,
          exposed: true,
          ready: true
        }
      ]),
      requireUsableCredential: vi
        .fn()
        .mockRejectedValue(new Error("agent_host_credential_unavailable")),
      backgroundStatus: vi.fn(),
      reconcileAgentExposure: vi
        .fn()
        .mockRejectedValue(new Error("agent_host_credential_unavailable")),
      installBackground: vi.fn().mockRejectedValue(new Error("agent_host_credential_unavailable"))
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "win32",
      launcher: { executablePath: "C:\\PlanWeave.exe", fixedArgs: ["--agent-host-service"] },
      operator: operator as never,
      registrations
    });

    await expect(provisioner.status("profile-a")).resolves.toMatchObject({
      supported: true,
      state: "not_registered",
      workspaceId: "workspace-credential",
      agents: [
        expect.objectContaining({
          profileId: "pi-acp",
          exposed: true
        })
      ]
    });
    expect(operator.requireUsableCredential).toHaveBeenCalledWith(configPath);
    expect(operator.backgroundStatus).not.toHaveBeenCalled();
    await expect(registrations.get("profile-a")).resolves.toBeNull();

    await registrations.upsert("profile-a", {
      instanceKey: "workspace-credential",
      workspaceId: "workspace-credential"
    });
    await expect(provisioner.repair("profile-a", ["pi-acp"])).resolves.toMatchObject({
      supported: true,
      state: "not_registered"
    });
    expect(operator.reconcileAgentExposure).toHaveBeenCalledWith(configPath, ["pi-acp"]);
    expect(operator.installBackground).not.toHaveBeenCalled();
    await expect(registrations.get("profile-a")).resolves.toBeNull();
  });

  it("preserves an existing Agent Host error code", async () => {
    const operator = {
      enrollHandoff: vi.fn().mockRejectedValue(new Error("agent_host_enrollment_rejected"))
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "win32",
      launcher: { executablePath: "C:\\PlanWeave.exe", fixedArgs: ["--agent-host-service"] },
      operator: operator as never
    });

    await expect(provisioner.register(undefined, "opaque-handoff", ["codex-acp"])).rejects.toThrow(
      "agent_host_enrollment_rejected"
    );
  });

  it("reports Server connection from the Host connection-status file while the process is running", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-local-agent-host-connection-home-"));
    roots.push(home);
    vi.stubEnv("HOME", home);
    const workspaceId = "workspace-connection";
    const paths = resolveAgentHostDefaultPaths(workspaceId, home);
    await mkdir(paths.dataDirectory, { recursive: true });
    await mkdir(paths.workspaceRoot, { recursive: true });
    await writeFile(
      paths.configPath,
      `${JSON.stringify(
        {
          version: "agent-host-config/v1",
          coordinator: {
            url: "https://mac-server.example",
            allowInsecureDevelopment: false
          },
          dataDirectory: paths.dataDirectory,
          workspaceRoot: paths.workspaceRoot,
          host: { displayName: "Win Host", capacity: 1, capabilities: [] },
          workspaces: [{ id: workspaceId, path: workspaceId }],
          agentProfiles: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeHostConnectionStatus(
      paths.dataDirectory,
      { state: "connected", connectedAt: "2030-01-01T00:00:10.000Z" },
      new Date("2030-01-01T00:00:11.000Z")
    );

    const registrations = new LocalAgentHostRegistrationStore(join(home, "registrations.json"));
    await registrations.upsert("profile-a", { instanceKey: workspaceId, workspaceId });
    const agents = [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        detected: true,
        exposed: true,
        ready: true
      }
    ];
    const operator = {
      listAgents: vi.fn().mockResolvedValue(agents),
      requireUsableCredential: vi.fn().mockResolvedValue(undefined),
      backgroundStatus: vi
        .fn()
        .mockResolvedValue({ state: "running", platform: "windows-user-startup" })
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "win32",
      launcher: { executablePath: "C:\\PlanWeave.exe", fixedArgs: ["--agent-host-service"] },
      operator: operator as never,
      registrations
    });

    await expect(provisioner.status("profile-a")).resolves.toMatchObject({
      state: "ready",
      background: "running",
      serverConnection: {
        state: "connected",
        connectedAt: "2030-01-01T00:00:10.000Z",
        serverOrigin: "https://mac-server.example"
      }
    });
  });

  it("forces Server connection offline when the background process is not running", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-local-agent-host-offline-home-"));
    roots.push(home);
    vi.stubEnv("HOME", home);
    const workspaceId = "workspace-offline";
    const paths = resolveAgentHostDefaultPaths(workspaceId, home);
    await mkdir(paths.dataDirectory, { recursive: true });
    await mkdir(paths.workspaceRoot, { recursive: true });
    await writeFile(
      paths.configPath,
      `${JSON.stringify(
        {
          version: "agent-host-config/v1",
          coordinator: {
            url: "https://mac-server.example",
            allowInsecureDevelopment: false
          },
          dataDirectory: paths.dataDirectory,
          workspaceRoot: paths.workspaceRoot,
          host: { displayName: "Win Host", capacity: 1, capabilities: [] },
          workspaces: [{ id: workspaceId, path: workspaceId }],
          agentProfiles: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeHostConnectionStatus(paths.dataDirectory, {
      state: "connected",
      connectedAt: "2030-01-01T00:00:10.000Z"
    });

    const registrations = new LocalAgentHostRegistrationStore(join(home, "registrations.json"));
    await registrations.upsert("profile-a", { instanceKey: workspaceId, workspaceId });
    const operator = {
      listAgents: vi.fn().mockResolvedValue([]),
      requireUsableCredential: vi.fn().mockResolvedValue(undefined),
      backgroundStatus: vi
        .fn()
        .mockResolvedValue({ state: "stopped", platform: "windows-user-startup" })
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "win32",
      launcher: { executablePath: "C:\\PlanWeave.exe", fixedArgs: ["--agent-host-service"] },
      operator: operator as never,
      registrations
    });

    await expect(provisioner.status("profile-a")).resolves.toMatchObject({
      state: "background_setup_required",
      background: "stopped",
      serverConnection: {
        state: "stopped",
        serverOrigin: "https://mac-server.example"
      }
    });
  });
});
