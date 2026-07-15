import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveAgentDefinition } from "../autoRun/agentRegistry.js";
import { createAcpRunner } from "../autoRun/acpRunner.js";
import { AcpPreflightCleanupError, AcpPreflightPhaseError } from "../autoRun/acpPreflightProbe.js";

const fixture = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));
const profile = {
  adapter: "agent",
  agent: "codex",
  runner: { transport: "acp" }
} as const;

function definition(scenario: string, headlessSafe = false) {
  const base = resolveAgentDefinition("codex");
  return {
    ...base,
    acp: {
      ...base.acp,
      launch: { ...base.acp.launch!, command: process.execPath, args: [fixture, scenario] },
      ...(headlessSafe
        ? {
            authentication: {
              preferredMethodIds: ["mock-login"],
              headlessSafeMethodIds: ["mock-login"]
            }
          }
        : {})
    }
  };
}

async function preflight(
  scenario: string,
  options?: { headlessSafe?: boolean; timeoutMs?: number }
) {
  return createAcpRunner().preflight({
    profile,
    definition: definition(scenario, options?.headlessSafe),
    cwd: "/tmp",
    timeoutMs: options?.timeoutMs ?? 1_000
  });
}

async function withLifecycleTrace<T>(run: (path: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "planweave-acp-preflight-"));
  const path = join(directory, "lifecycle.log");
  await writeFile(path, "", "utf8");
  const previous = process.env.PLANWEAVE_ACP_TEST_LIFECYCLE_FILE;
  process.env.PLANWEAVE_ACP_TEST_LIFECYCLE_FILE = path;
  try {
    const result = await run(path);
    return { result, lifecycle: await readFile(path, "utf8") };
  } finally {
    if (previous === undefined) delete process.env.PLANWEAVE_ACP_TEST_LIFECYCLE_FILE;
    else process.env.PLANWEAVE_ACP_TEST_LIFECYCLE_FILE = previous;
  }
}

async function waitForLifecycle(path: string, event: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const lifecycle = await readFile(path, "utf8");
    if (lifecycle.split("\n").some((line) => line.endsWith(` ${event}`))) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`ACP mock did not record lifecycle event '${event}'.`);
}

function lifecyclePid(lifecycle: string): number {
  const firstLine = lifecycle.split("\n").find((line) => line.length > 0);
  if (firstLine === undefined) throw new Error("ACP lifecycle did not record a child process.");
  const pid = Number(firstLine.split(" ", 1)[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`ACP lifecycle recorded invalid process id '${firstLine}'.`);
  }
  return pid;
}

function expectProcessStopped(lifecycle: string): void {
  const pid = lifecyclePid(lifecycle);
  expect(() => process.kill(pid, 0)).toThrow();
}

describe("ACP authenticated preflight lifecycle", () => {
  it("does not authenticate when no methods are advertised and creates a usable session", async () => {
    const result = await preflight("success");

    expect(result.authentication).toEqual({ status: "not_advertised" });
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "acp_session", status: "passed" })])
    );
    expect(result.negotiatedCapabilities).not.toBeNull();
  });

  it("authenticates with the selected safe method before creating a session", async () => {
    const result = await preflight("authenticated-with-auth-methods", { headlessSafe: true });

    expect(result.authentication).toEqual({ status: "authenticated", methodId: "mock-login" });
    expect(result.availableCapabilities).toContain("authentication");
    expect(result.negotiatedCapabilities).not.toBeNull();
  });

  it("uses only spawn-environment key presence to select env_var authentication", async () => {
    const variable = "PLANWEAVE_T002_TEST_API_KEY";
    const secretValue = "must-not-appear-in-preflight";
    const previous = process.env[variable];
    delete process.env[variable];
    try {
      const missing = await preflight("env-auth");
      expect(missing.authentication).toEqual({
        status: "action_required",
        reason: "missing_credentials",
        methods: [
          {
            id: "env-login",
            name: "Environment login",
            type: "env_var",
            requiredVariables: [variable],
            missingVariables: [variable],
            link: null
          },
          {
            id: "terminal-login",
            name: "Terminal login",
            type: "terminal"
          }
        ]
      });

      process.env[variable] = secretValue;
      const authenticated = await preflight("env-auth");
      expect(authenticated.authentication).toEqual({
        status: "authenticated",
        methodId: "env-login"
      });
      expect(JSON.stringify([missing, authenticated])).not.toContain(secretValue);
      expect(JSON.stringify([missing, authenticated])).not.toContain("mock-auth-meta-secret");
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });

  it("returns actionable auth state without creating a session for an unsafe method", async () => {
    const result = await preflight("action-required");

    expect(result.negotiatedCapabilities).toBeNull();
    expect(result.authentication).toEqual({
      status: "action_required",
      reason: "no_safe_method",
      methods: [{ id: "mock-login", name: "Mock login", type: "agent" }]
    });
    expect(result.availableCapabilities).toContain("authentication");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: "acp_authenticated",
          status: "failed",
          failureCode: "auth_required"
        })
      ])
    );
  });

  it("preserves session auth-required classification when no methods were advertised", async () => {
    const result = await preflight("no-auth-methods-but-session-requires-auth");

    expect(result.authentication).toEqual({
      status: "action_required",
      reason: "no_safe_method",
      methods: []
    });
    expect(result.availableCapabilities).not.toContain("authentication");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ failureCode: "auth_required" })])
    );
  });

  it("allows omitted agentInfo but rejects present partial or invalid agentInfo", async () => {
    await expect(preflight("missing-agent-info")).resolves.toMatchObject({
      agentInfo: null,
      authentication: { status: "not_advertised" }
    });

    for (const scenario of [
      "missing-agent-version",
      "empty-agent-version",
      "invalid-agent-version"
    ]) {
      const result = await preflight(scenario);
      expect(result.checks).toEqual([
        expect.objectContaining({
          check: "acp_initialized",
          status: "failed",
          failureCode: "initialization_failed"
        })
      ]);
    }
  });

  it("preserves authenticate protocol failures as authentication-phase failures", async () => {
    const protocol = await preflight("authenticate-protocol-error", { headlessSafe: true });
    expect(protocol.checks).toEqual([
      expect.objectContaining({
        check: "acp_authenticated",
        failureCode: "initialization_failed",
        message: expect.stringContaining("ACP authentication failed")
      })
    ]);
  });

  it("waits for authentication timeout cleanup and attributes the exact failed check", async () => {
    const timeoutMs = 2_000;
    const { result, lifecycle } = await withLifecycleTrace(() =>
      preflight("authenticate-delayed", {
        headlessSafe: true,
        timeoutMs
      })
    );

    expect(result.checks).toEqual([
      {
        check: "acp_authenticated",
        status: "failed",
        failureCode: "timeout",
        message: `ACP preflight timed out after ${timeoutMs}ms.`
      }
    ]);
    expect(lifecycle).toContain(" authenticate\n");
    expect(lifecycle).not.toContain(" session/new\n");
    expectProcessStopped(lifecycle);
  });

  it("waits for authentication cancellation cleanup and attributes the exact failed check", async () => {
    const controller = new AbortController();
    const { result, lifecycle } = await withLifecycleTrace(async (path) => {
      const pending = createAcpRunner().preflight({
        profile,
        definition: definition("authenticate-delayed", true),
        cwd: "/tmp",
        timeoutMs: 10_000,
        signal: controller.signal
      });
      await waitForLifecycle(path, "authenticate");
      controller.abort(new Error("caller cancelled preflight"));
      return pending;
    });

    expect(result.checks).toEqual([
      {
        check: "acp_authenticated",
        status: "failed",
        failureCode: "cancelled",
        message: expect.stringContaining("caller cancelled preflight")
      }
    ]);
    expect(lifecycle).toContain(" authenticate\n");
    expect(lifecycle).not.toContain(" session/new\n");
    expectProcessStopped(lifecycle);
  });

  it("does not spawn or initialize an Agent for an already-cancelled signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before preflight"));
    const { result, lifecycle } = await withLifecycleTrace(() =>
      createAcpRunner().preflight({
        profile,
        definition: definition("success"),
        cwd: "/tmp",
        timeoutMs: 1_000,
        signal: controller.signal
      })
    );

    expect(result).toMatchObject({
      executionIntegration: null,
      negotiatedCapabilities: null,
      checks: [
        {
          check: "acp_initialized",
          status: "failed",
          failureCode: "cancelled",
          message: expect.stringContaining("cancelled before preflight")
        }
      ]
    });
    expect(lifecycle).toBe("");
  });

  it("keeps the primary phase and cleanup failure together", async () => {
    const primary = new AcpPreflightPhaseError(
      "authentication",
      new Error("authentication rejected")
    );
    const cleanup = new Error("dispose failed");
    const failure = new AcpPreflightCleanupError(primary, cleanup);
    const runner = createAcpRunner({
      probe: async () => {
        throw failure;
      }
    });

    await expect(
      runner.preflight({
        profile,
        definition: definition("success"),
        cwd: "/tmp",
        timeoutMs: 1_000
      })
    ).resolves.toMatchObject({
      checks: [
        {
          check: "acp_authenticated",
          status: "failed",
          failureCode: "initialization_failed",
          message: expect.stringContaining("authentication rejected")
        }
      ]
    });
    expect(failure.errors).toEqual([primary, cleanup]);
  });

  it("calls session close only when the Agent advertises it", async () => {
    await expect(preflight("success")).resolves.toMatchObject({
      negotiatedCapabilities: expect.any(Object)
    });
    const closeFailure = await preflight("close-capable-error");
    expect(closeFailure.checks).toEqual([
      expect.objectContaining({
        check: "acp_session",
        status: "failed",
        message: expect.stringContaining("ACP session failed")
      })
    ]);
  });
});
