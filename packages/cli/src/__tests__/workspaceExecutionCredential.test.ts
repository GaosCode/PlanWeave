import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CliWorkspaceConnectionProvider,
  ProcessMemoryWorkspaceCredentialProvider
} from "../workspaceExecution/connection.js";
import { WorkspaceExecutionCliError } from "../workspaceExecution/errors.js";
import { workspaceExecutionExitCode } from "../workspaceExecution/errors.js";
import { createWorkspaceJsonTransport } from "../workspaceExecution/httpTransport.js";
import { resolveCliExecutionTarget } from "../workspaceExecution/preflight.js";

const token = `pw_hdev_${"a".repeat(43)}`;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function profileFiles(count: number) {
  const root = await mkdtemp(join(tmpdir(), "planweave-cli-profiles-"));
  const directory = join(root, "desktop", "collaboration");
  await mkdir(directory, { recursive: true });
  const profiles = Array.from({ length: count }, (_, index) => ({
    profileId: `profile-${index}`,
    displayName: `Profile ${index}`,
    serverBaseUrl: "http://127.0.0.1:43110",
    projectId: `project-${index}`,
    allowInsecureTransport: true,
    endpoint: {
      topology: "loopback_http",
      serverOrigin: "http://127.0.0.1:43110",
      allowedClientOrigins: ["http://127.0.0.1:43110"],
      tlsTrust: "not_applicable"
    },
    connectionState: "ready",
    updatedAt: "2030-01-01T00:00:00.000Z"
  }));
  const workspaces = profiles.map((profile, index) => ({
    schemaVersion: "workspace-identity/v1",
    profileId: profile.profileId,
    displayName: `Workspace ${index}`,
    serverBaseUrl: profile.serverBaseUrl,
    workspaceId: `workspace-${index}`,
    allowInsecureTransport: true,
    workspaceDisplayName: `Workspace ${index}`,
    membershipRole: "owner",
    membershipActive: true,
    updatedAt: "2030-01-01T00:00:00.000Z"
  }));
  const collaborationProfiles = join(directory, "profiles.json");
  const workspaceProfiles = join(directory, "workspace-profiles.json");
  await writeFile(
    collaborationProfiles,
    JSON.stringify({ version: 3, profiles, activeProfileId: null })
  );
  await writeFile(
    workspaceProfiles,
    JSON.stringify({ version: 1, profiles: workspaces, activeProfileId: null })
  );
  return { collaborationProfiles, workspaceProfiles };
}

describe("Workspace execution CLI connection and credential", () => {
  it("requires a process-memory credential and never includes its value in errors", () => {
    expect(() => new ProcessMemoryWorkspaceCredentialProvider({}).get()).toThrowError(
      "workspace_credential_required"
    );
    expect(() =>
      new ProcessMemoryWorkspaceCredentialProvider({
        PLANWEAVE_COLLABORATION_DEVICE_TOKEN: "invalid-secret"
      }).get()
    ).toThrowError("workspace_credential_invalid");
    expect(
      new ProcessMemoryWorkspaceCredentialProvider({
        PLANWEAVE_COLLABORATION_DEVICE_TOKEN: token
      }).get()
    ).toBe(token);
  });

  it("selects one profile deterministically and rejects zero or many", async () => {
    const single = new CliWorkspaceConnectionProvider(await profileFiles(1));
    await expect(single.resolve()).resolves.toMatchObject({ profileId: "profile-0" });
    const none = new CliWorkspaceConnectionProvider(await profileFiles(0));
    await expect(none.resolve()).rejects.toMatchObject({ code: "workspace_connection_required" });
    const many = new CliWorkspaceConnectionProvider(await profileFiles(2));
    await expect(many.resolve()).rejects.toMatchObject({
      code: "workspace_connection_selection_required"
    });
    await expect(many.resolve("profile-1")).resolves.toMatchObject({ profileId: "profile-1" });
  });

  it("rejects a Workspace profile whose Server authority differs from its project profile", async () => {
    const paths = await profileFiles(1);
    const document = JSON.parse(await readFile(paths.workspaceProfiles, "utf8"));
    document.profiles[0].serverBaseUrl = "http://127.0.0.1:43111";
    await writeFile(paths.workspaceProfiles, JSON.stringify(document));
    await expect(new CliWorkspaceConnectionProvider(paths).list()).rejects.toMatchObject({
      code: "workspace_connection_invalid"
    });
  });

  it("maps HTTP errors without echoing a credential or response body", async () => {
    const secretBody = `server diagnostic ${token}`;
    const transport = createWorkspaceJsonTransport({
      serverOrigin: "https://server.example",
      credential: token,
      fetch: async () => new Response(secretBody, { status: 403 })
    });
    const schema = { safeParse: () => ({ success: true as const, data: {} }) };
    const failure = await transport.json("GET", "/test", schema).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WorkspaceExecutionCliError);
    expect(failure).toMatchObject({ code: "workspace_http_forbidden", exitCode: 5 });
    expect(String(failure)).not.toContain(token);
    expect(String(failure)).not.toContain(secretBody);
  });

  it("keeps the credential in the Authorization header and validates the response", async () => {
    let authorization: string | null = null;
    const transport = createWorkspaceJsonTransport({
      serverOrigin: "https://server.example",
      credential: token,
      fetch: async (_url, options) => {
        authorization = new Headers(options?.headers).get("authorization");
        return Response.json({ ok: true });
      }
    });
    const result = await transport.json("GET", "/test", {
      safeParse: (value) => ({ success: true as const, data: value })
    });
    expect(result).toEqual({ ok: true });
    expect(authorization).toBe(`Bearer ${token}`);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it.each([
    [400, "human_remote_request_invalid", 2, false],
    [403, "human_cross_project_forbidden", 5, false],
    [409, "agent_endpoint_selection_required", 5, false],
    [500, "human_remote_request_failed", 8, false],
    [503, "human_remote_host_offline", 9, true]
  ] as const)("preserves a safe Server domain error for HTTP %i", async (status, code, exitCode, retryable) => {
    const transport = createWorkspaceJsonTransport({
      serverOrigin: "https://server.example",
      credential: token,
      fetch: async () => Response.json({ error: code }, { status })
    });
    const failure = await transport
      .json("GET", "/test", { safeParse: () => ({ success: true as const, data: {} }) })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code, exitCode, retryable });
    expect(workspaceExecutionExitCode(failure)).toBe(exitCode);
    expect(String(failure)).not.toContain(token);
  });

  it("does not trust a malformed Server error envelope", async () => {
    const secret = `unsafe_${token}`;
    const transport = createWorkspaceJsonTransport({
      serverOrigin: "https://server.example",
      credential: token,
      fetch: async () =>
        Response.json({ error: "human_remote_host_offline", diagnostic: secret }, { status: 503 })
    });
    const failure = await transport
      .json("GET", "/test", { safeParse: () => ({ success: true as const, data: {} }) })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "workspace_http_unavailable", exitCode: 9 });
    expect(String(failure)).not.toContain(secret);
    expect(String(failure)).not.toContain(token);
  });

  it("classifies transport failures and bounded never-resolving requests as retryable", async () => {
    const schema = { safeParse: () => ({ success: true as const, data: {} }) };
    const transportFailure = createWorkspaceJsonTransport({
      serverOrigin: "https://server.example",
      credential: token,
      fetch: async () => Promise.reject(new Error(`network ${token}`))
    });
    await expect(transportFailure.json("GET", "/test", schema)).rejects.toMatchObject({
      code: "workspace_http_unavailable",
      exitCode: 9,
      retryable: true
    });

    const timeout = createWorkspaceJsonTransport({
      serverOrigin: "https://server.example",
      credential: token,
      timeoutMs: 10,
      fetch: async () => new Promise<Response>(() => undefined)
    });
    await expect(timeout.json("GET", "/test", schema)).rejects.toMatchObject({
      code: "workspace_http_unavailable",
      exitCode: 9,
      retryable: true
    });
  });

  it("preserves caller cancellation instead of classifying it as a timeout", async () => {
    const abort = new AbortController();
    const transport = createWorkspaceJsonTransport({
      serverOrigin: "https://server.example",
      credential: token,
      timeoutMs: 1_000,
      fetch: async () => new Promise<Response>(() => undefined)
    });
    const request = transport.json(
      "GET",
      "/test",
      { safeParse: () => ({ success: true as const, data: {} }) },
      { signal: abort.signal }
    );
    abort.abort(new DOMException("caller cancelled", "AbortError"));
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("auto target preflight", () => {
  it("prefers explicit selections without probing local execution", async () => {
    let probes = 0;
    const target = await resolveCliExecutionTarget({
      policy: "auto",
      agentEndpointId: "endpoint-1",
      local: {
        probe: async () => {
          probes += 1;
          return { status: "available" };
        }
      }
    });
    expect(target).toEqual({ policy: "remote", agentEndpointId: "endpoint-1" });
    expect(probes).toBe(0);
  });

  it("preserves an existing explicit selection without probing local execution", async () => {
    let probes = 0;
    await expect(
      resolveCliExecutionTarget({
        policy: "auto",
        selectedAgentEndpointId: "endpoint-selected",
        local: {
          probe: async () => {
            probes += 1;
            return { status: "available" };
          }
        }
      })
    ).resolves.toEqual({ policy: "remote", agentEndpointId: "endpoint-selected" });
    expect(probes).toBe(0);
  });

  it("rejects an endpoint when the target is explicitly local without probing", async () => {
    let probes = 0;
    await expect(
      resolveCliExecutionTarget({
        policy: "local",
        agentEndpointId: "endpoint-1",
        local: {
          probe: async () => {
            probes += 1;
            return { status: "available" };
          }
        }
      })
    ).rejects.toMatchObject({ code: "workspace_execution_usage_invalid" });
    expect(probes).toBe(0);
  });

  it.each([
    ["available", "local"],
    ["unavailable", "remote"]
  ] as const)("maps local %s to %s without launching", async (status, policy) => {
    await expect(
      resolveCliExecutionTarget({
        policy: "auto",
        local: { probe: async () => ({ status }) }
      })
    ).resolves.toEqual({ policy });
  });

  it("does not silently treat a probe error as unavailable", async () => {
    const sideEffects = { probes: 0, catalog: 0, dispatch: 0, sessions: 0 };
    await expect(
      resolveCliExecutionTarget({
        policy: "auto",
        local: {
          probe: async () => {
            sideEffects.probes += 1;
            throw new Error("probe failed");
          }
        }
      })
    ).rejects.toMatchObject({ code: "local_execution_probe_failed" });
    expect(sideEffects).toEqual({ probes: 1, catalog: 0, dispatch: 0, sessions: 0 });
  });
});
