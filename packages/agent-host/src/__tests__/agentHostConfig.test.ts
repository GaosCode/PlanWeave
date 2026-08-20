import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_ACP_SHUTDOWN_POLICY,
  initManagedWorkspace,
  resolveAgentProcessEnvironment
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfiguredAcpProfileResolver,
  ConfiguredWorkspaceResolver,
  resolveAgentHostCapabilities
} from "../config/resolvers.js";
import { observeHostReadiness } from "../config/readiness.js";
import { parseAgentHostConfig } from "../config/schema.js";
import { ConfiguredCanvasRuntimeResolver } from "../runtime/canvasRuntimeResolver.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-host-config-"));
  directories.push(directory);
  const workspaceRoot = join(directory, "workspaces");
  await mkdir(join(workspaceRoot, "project"), { recursive: true });
  return { directory, workspaceRoot };
}

function input(directory: string, workspaceRoot: string) {
  return {
    version: "agent-host-config/v1",
    coordinator: { url: "https://coordinator.example.com", allowInsecureDevelopment: false },
    dataDirectory: join(directory, "data"),
    workspaceRoot,
    host: { displayName: "Build Host", capacity: 2, capabilities: ["linux", "workspace.git"] },
    workspaces: [{ id: "workspace.core", path: "project" }],
    agentProfiles: [
      {
        id: "acp.test",
        agentId: "test-agent",
        command: process.execPath,
        args: ["agent.mjs"],
        environment: [
          { name: "SAFE_API_KEY", required: true },
          { name: "OPTIONAL_VALUE", required: false }
        ]
      }
    ]
  };
}

describe("Agent Host configuration", () => {
  it("defaults, validates, and resolves ACP shutdown policy overrides", async () => {
    const { directory, workspaceRoot } = await setup();
    const base = input(directory, workspaceRoot);
    const defaulted = parseAgentHostConfig(base);
    expect(defaulted.agentProfiles[0].shutdown).toEqual(DEFAULT_ACP_SHUTDOWN_POLICY);
    expect(defaulted.runtimeProjects).toEqual([]);

    const shutdown = { eofDrainMs: 80, terminateGraceMs: 140, cleanupDeadlineMs: 720 };
    const overridden = parseAgentHostConfig({
      ...base,
      agentProfiles: [{ ...base.agentProfiles[0], shutdown }]
    });
    await expect(
      new ConfiguredAcpProfileResolver(overridden, { SAFE_API_KEY: "present" }).resolve(
        "acp.test",
        "test-agent"
      )
    ).resolves.toMatchObject({ shutdown });

    expect(() =>
      parseAgentHostConfig({
        ...base,
        agentProfiles: [
          {
            ...base.agentProfiles[0],
            shutdown: { eofDrainMs: 80, terminateGraceMs: 140, cleanupDeadlineMs: 300 }
          }
        ]
      })
    ).toThrow("cleanupDeadlineMs");
  });

  it("strictly rejects unknown fields, duplicate ids, invalid capacity/capabilities, and insecure URLs", async () => {
    const { directory, workspaceRoot } = await setup();
    const valid = input(directory, workspaceRoot);
    expect(() => parseAgentHostConfig({ ...valid, token: "secret" })).toThrow();
    expect(() =>
      parseAgentHostConfig({ ...valid, workspaces: [...valid.workspaces, valid.workspaces[0]] })
    ).toThrow();
    expect(() =>
      parseAgentHostConfig({
        ...valid,
        runtimeProjects: [
          { workspaceId: "workspace.core", projectId: "project-a", path: "project" },
          { workspaceId: "workspace.core", projectId: "project-a", path: "project-copy" }
        ]
      })
    ).toThrow("Runtime project mappings must be unique");
    for (const path of [
      "/absolute/project",
      "../outside",
      "project/../outside",
      "project\\child"
    ]) {
      expect(() =>
        parseAgentHostConfig({
          ...valid,
          runtimeProjects: [{ workspaceId: "workspace.core", projectId: "project-a", path }]
        })
      ).toThrow("safe relative path");
    }
    expect(() =>
      parseAgentHostConfig({ ...valid, host: { ...valid.host, capacity: 0 } })
    ).toThrow();
    expect(() =>
      parseAgentHostConfig({ ...valid, host: { ...valid.host, capabilities: ["linux", "linux"] } })
    ).toThrow();
    expect(() =>
      parseAgentHostConfig({
        ...valid,
        coordinator: { url: "http://example.com", allowInsecureDevelopment: true }
      })
    ).toThrow();
    expect(() =>
      parseAgentHostConfig({
        ...valid,
        coordinator: { url: "http://127.0.0.1", allowInsecureDevelopment: false }
      })
    ).toThrow();
    expect(
      parseAgentHostConfig({
        ...valid,
        coordinator: { url: "http://127.0.0.1", allowInsecureDevelopment: true }
      })
    ).toBeDefined();
    expect(
      parseAgentHostConfig({ ...valid, coordinator: { url: "wss://coordinator.example.com" } })
    ).toBeDefined();
    expect(() =>
      parseAgentHostConfig({
        ...valid,
        coordinator: {
          url: "https://coordinator.example.com",
          caCertificatePath: "relative-ca.pem"
        }
      })
    ).toThrow();
  });

  it("treats equivalent endpoint origins with or without a trailing slash as the same origin", async () => {
    const { directory, workspaceRoot } = await setup();
    const valid = input(directory, workspaceRoot);

    expect(
      parseAgentHostConfig({
        ...valid,
        coordinator: {
          url: "https://coordinator.example.com/",
          allowInsecureDevelopment: false,
          endpoint: {
            topology: "private_https",
            serverOrigin: "https://coordinator.example.com/",
            allowedClientOrigins: ["https://coordinator.example.com/"],
            tlsTrust: "system_ca"
          }
        }
      })
    ).toBeDefined();
  });

  it("resolves only logical workspace ids and rejects traversal or symlink escape", async () => {
    const { directory, workspaceRoot } = await setup();
    const config = parseAgentHostConfig(input(directory, workspaceRoot));
    const resolver = new ConfiguredWorkspaceResolver(config);
    await expect(resolver.resolve("workspace.core")).resolves.toEqual({
      cwd: await realpath(join(workspaceRoot, "project"))
    });
    await expect(resolver.resolve("../project")).rejects.toThrow("not_configured");
    expect(() =>
      parseAgentHostConfig({
        ...input(directory, workspaceRoot),
        workspaces: [{ id: "unsafe", path: "../outside" }]
      })
    ).toThrow();

    await mkdir(join(directory, "outside"));
    await symlink(join(directory, "outside"), join(workspaceRoot, "escape"));
    const escaped = parseAgentHostConfig({
      ...input(directory, workspaceRoot),
      workspaces: [{ id: "escape", path: "escape" }]
    });
    await expect(new ConfiguredWorkspaceResolver(escaped).resolve("escape")).rejects.toThrow(
      "workspace_escape"
    );
  });

  it("reports only redacted local readiness facts", async () => {
    const { directory, workspaceRoot } = await setup();
    const config = parseAgentHostConfig(input(directory, workspaceRoot));
    await expect(
      observeHostReadiness(config, { SAFE_API_KEY: "present" }, ["acp.test"])
    ).resolves.toEqual({
      workspaceMappings: [{ workspaceId: "workspace.core", status: "ready" }],
      runtimeProjects: [],
      acpProfiles: [
        {
          profileId: "acp.test",
          agentId: "test-agent",
          displayName: "acp.test",
          status: "ready",
          capabilities: ["acp.test-agent"]
        }
      ]
    });
    await expect(observeHostReadiness(config, {}, ["acp.test"])).resolves.toMatchObject({
      acpProfiles: [{ profileId: "acp.test", status: "invalid" }]
    });
  });

  it("resolves exact multi-project Runtime mappings without exposing paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-host-runtime-config-"));
    directories.push(directory);
    const planweaveHome = join(directory, "planweave-home");
    vi.stubEnv("PLANWEAVE_HOME", planweaveHome);
    const first = await initManagedWorkspace({ name: "Runtime First", projectGraph: true });
    const second = await initManagedWorkspace({ name: "Runtime Second", projectGraph: true });
    const base = input(directory, join(planweaveHome, "projects"));
    const config = parseAgentHostConfig({
      ...base,
      workspaces: [],
      runtimeProjects: [
        { workspaceId: "workspace-a", projectId: first.project.id, path: first.project.id },
        { workspaceId: "workspace-a", projectId: second.project.id, path: second.project.id }
      ]
    });
    const resolver = new ConfiguredCanvasRuntimeResolver(config);
    await expect(
      resolver.resolve({
        workspaceId: "workspace-a",
        projectId: first.project.id,
        canvasId: "default"
      })
    ).resolves.toMatchObject({
      scope: { workspaceId: "workspace-a", projectId: first.project.id, canvasId: "default" }
    });
    await expect(
      resolver.resolve({
        workspaceId: "workspace-b",
        projectId: first.project.id,
        canvasId: "default"
      })
    ).rejects.toThrow("runtime_project_not_configured");
    expect(resolveAgentHostCapabilities(config)).toContain("canvas-runtime.v1");
    const readiness = await observeHostReadiness(config, { SAFE_API_KEY: "present" }, []);
    expect(readiness.runtimeProjects).toEqual([
      { workspaceId: "workspace-a", projectId: first.project.id, status: "ready" },
      { workspaceId: "workspace-a", projectId: second.project.id, status: "ready" }
    ]);
    expect(JSON.stringify(readiness)).not.toContain(planweaveHome);

    const outside = join(directory, "outside-runtime-project");
    await mkdir(outside);
    await symlink(outside, join(planweaveHome, "projects", "escaped-runtime"));
    const escaped = parseAgentHostConfig({
      ...base,
      workspaces: [],
      runtimeProjects: [
        {
          workspaceId: "workspace-a",
          projectId: first.project.id,
          path: "escaped-runtime"
        }
      ]
    });
    await expect(
      new ConfiguredCanvasRuntimeResolver(escaped).resolveProject("workspace-a", first.project.id)
    ).rejects.toThrow("runtime_project_escape");
  });

  it("resolves trusted local launch and copies only explicitly allowed environment names", async () => {
    const { directory, workspaceRoot } = await setup();
    const config = parseAgentHostConfig(input(directory, workspaceRoot));
    const resolver = new ConfiguredAcpProfileResolver(config, {
      SAFE_API_KEY: "local-secret",
      UNTRUSTED_OVERRIDE: "ignored"
    });
    await expect(resolver.resolve("acp.test", "test-agent")).resolves.toMatchObject({
      agentId: "test-agent",
      launch: { command: process.execPath, args: ["agent.mjs"] },
      env: expect.objectContaining({ SAFE_API_KEY: "local-secret" })
    });
    const resolved = await resolver.resolve("acp.test", "test-agent");
    expect(resolved.env).not.toHaveProperty("UNTRUSTED_OVERRIDE");
    expect(Object.keys(resolved.env).some((key) => key.toLowerCase() === "path")).toBe(true);
    await expect(resolver.resolve("acp.test", "wrong-agent")).rejects.toThrow("not_configured");
    expect(() =>
      parseAgentHostConfig({
        ...input(directory, workspaceRoot),
        agentProfiles: [
          {
            ...input(directory, workspaceRoot).agentProfiles[0],
            environment: [{ name: "NODE_OPTIONS", required: false }]
          }
        ]
      })
    ).toThrow();
    expect(dirname(process.execPath)).not.toBe("");
  });

  it("uses the Runtime environment authority while preserving the Host resolver boundary", async () => {
    const { directory, workspaceRoot } = await setup();
    const config = parseAgentHostConfig(input(directory, workspaceRoot));
    const ambient = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/host",
      SAFE_API_KEY: "",
      OPTIONAL_VALUE: "optional",
      UNDECLARED_SECRET: "secret-marker"
    };
    const resolved = await new ConfiguredAcpProfileResolver(
      config,
      ambient,
      undefined,
      "linux"
    ).resolve("acp.test", "test-agent");
    const authoritative = resolveAgentProcessEnvironment({
      platform: "linux",
      ambient,
      contract: { variables: config.agentProfiles[0].environment }
    });

    expect(resolved.env).toEqual(authoritative.env);
    expect(resolved.env.SAFE_API_KEY).toBe("");
    expect(resolved.env).not.toHaveProperty("UNDECLARED_SECRET");
    expect(JSON.stringify(resolved)).not.toContain("secret-marker");
  });
});
