import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acpConversationPromptCommandSchema,
  exampleExecutionEnvelopeInput
} from "@planweave-ai/agent-host-protocol";
import { DEFAULT_ACP_SHUTDOWN_POLICY } from "@planweave-ai/runtime";
import { RemoteAcpConversationService } from "../execution/remoteAcpConversationService.js";
import { RemoteAcpExecutor } from "../execution/remoteAcpExecutor.js";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";

const fixtures: Array<{ directory: string; state: AgentHostState }> = [];
const mockAgent = fileURLToPath(
  new URL("../../../runtime/src/__tests__/support/acpMockAgent.mjs", import.meta.url)
);

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.state.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function setup(
  scenario: string,
  pauseAt: string,
  deadlineMs = 2_000,
  connectionMode: "dedicated" | "shared" = "dedicated"
) {
  const directory = await mkdtemp(join(tmpdir(), "acp-deadline-process-"));
  const state = await openAgentHostState(join(directory, "state.sqlite"));
  fixtures.push({ directory, state });
  await writeFile(join(directory, "pause"), "1\n");
  await writeFile(join(directory, "pause-at"), `${pauseAt}\n`);
  const command = acpConversationPromptCommandSchema.parse({
    type: "acp_conversation.prompt",
    protocolVersion: agentHostProtocolVersion,
    operationId: "deadline-op",
    turnId: "deadline-turn",
    executionAttemptId: exampleExecutionEnvelopeInput.execution.attemptId,
    sessionId: "original-session",
    text: "A follow-up",
    expiresAt: new Date(Date.now() + deadlineMs).toISOString(),
    sourceEnvelope: { ...exampleExecutionEnvelopeInput, requiredCapabilities: [] }
  });
  state.receive({
    type: "mailbox.message",
    protocolVersion: agentHostProtocolVersion,
    messageId: "deadline-message",
    previousSequence: 0,
    sequence: 1,
    command
  });
  const executor = new RemoteAcpExecutor({
    workspaceResolver: { resolve: () => ({ cwd: directory }) },
    runtimeWorkspaceResolver: { resolve: () => ({ cwd: directory }) },
    profileResolver: {
      resolve: () => ({
        agentId: exampleExecutionEnvelopeInput.agentId,
        capabilityPolicy: { required: [], optional: [] },
        shutdown:
          connectionMode === "shared"
            ? { eofDrainMs: 100, terminateGraceMs: 100, cleanupDeadlineMs: 450 }
            : DEFAULT_ACP_SHUTDOWN_POLICY,
        connection: { mode: connectionMode },
        launch: {
          command: process.execPath,
          args: [mockAgent, scenario, `--control-dir=${directory}`]
        },
        env: {},
        authentication: {
          hints: { preferredMethodIds: ["mock-login"], headlessSafeMethodIds: ["mock-login"] }
        }
      })
    },
    outbox: { append: async () => undefined },
    hostCapabilities: []
  });
  return {
    directory,
    state,
    command,
    service: new RemoteAcpConversationService(state.conversations, executor)
  };
}

describe("Host absolute deadline with a real mock ACP child", () => {
  it("reaps a shared cold-start child at the whole-turn deadline while authentication is blocked", async () => {
    const fixture = await setup("load-auth-capable", "authenticate", 1_500, "shared");
    await writeFile(join(fixture.directory, "delay-at"), "initialize\n");
    await writeFile(join(fixture.directory, "delay-ms"), "700\n");
    fixture.service.handle(fixture.command);
    await vi.waitFor(
      async () => {
        expect(await readFile(join(fixture.directory, "lifecycle.log"), "utf8")).toContain(
          "paused authenticate"
        );
      },
      { timeout: 2_000, interval: 20 }
    );
    const lifecycle = await readFile(join(fixture.directory, "lifecycle.log"), "utf8");
    const pid = Number(
      lifecycle
        .split("\n")
        .find((line) => line.endsWith("paused authenticate"))
        ?.split(" ")[0]
    );
    await vi.waitFor(
      () => {
        expect(fixture.state.pendingEvents()).toContainEqual(
          expect.objectContaining({
            turnId: fixture.command.turnId,
            payload: {
              kind: "status",
              status: "failed",
              error: "acp_conversation_deadline_exceeded"
            }
          })
        );
      },
      { timeout: 1_900, interval: 25 }
    );
    expect(await readFile(join(fixture.directory, "lifecycle.log"), "utf8")).not.toMatch(
      /^\d+ session\/prompt$/m
    );
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), {
      timeout: 2_000,
      interval: 25
    });
    await fixture.service.stop();
  }, 10_000);

  it("expires an unanswered elicitation after transport recovery without replaying the prompt", async () => {
    const fixture = await setup("load-capable-elicitation", "unused");
    fixture.service.handle(fixture.command);
    await vi.waitFor(
      () => {
        expect(fixture.state.pendingEvents()).toContainEqual(
          expect.objectContaining({
            turnId: fixture.command.turnId,
            payload: expect.objectContaining({
              kind: "interaction",
              request: expect.objectContaining({ kind: "elicitation" })
            })
          })
        );
      },
      { timeout: 5_000, interval: 25 }
    );
    const requestsBeforeRecovery = fixture.state
      .pendingEvents()
      .filter(
        (event) => event.type === "acp_conversation.event" && event.payload.kind === "interaction"
      );
    expect(requestsBeforeRecovery).toHaveLength(1);
    fixture.service.recover();
    expect(
      fixture.state
        .pendingEvents()
        .filter(
          (event) => event.type === "acp_conversation.event" && event.payload.kind === "interaction"
        )
    ).toEqual(requestsBeforeRecovery);
    await vi.waitFor(
      () => {
        expect(fixture.state.pendingEvents()).toContainEqual(
          expect.objectContaining({
            turnId: fixture.command.turnId,
            payload: {
              kind: "status",
              status: "failed",
              error: "acp_conversation_deadline_exceeded"
            }
          })
        );
      },
      { timeout: 15_000, interval: 50 }
    );
    const lifecycle = await readFile(join(fixture.directory, "lifecycle.log"), "utf8");
    expect(lifecycle.match(/^\d+ session\/prompt$/gm)).toHaveLength(1);
    await fixture.service.stop();
  }, 20_000);

  it("terminates a prompt that ignores cancellation before persisting the deadline terminal", async () => {
    const fixture = await setup("load-capable-stubborn-child", "unused");
    fixture.service.handle(fixture.command);
    await vi.waitFor(
      async () => {
        expect(await readFile(join(fixture.directory, "lifecycle.log"), "utf8")).toContain(
          "stubborn prompt"
        );
      },
      { timeout: 5_000, interval: 25 }
    );
    const pid = Number(
      (await readFile(join(fixture.directory, "lifecycle.log"), "utf8"))
        .split("\n")
        .find((line) => line.endsWith("stubborn prompt"))
        ?.split(" ")[0]
    );
    await vi.waitFor(
      () => {
        expect(fixture.state.pendingEvents()).toContainEqual(
          expect.objectContaining({
            turnId: fixture.command.turnId,
            payload: {
              kind: "status",
              status: "failed",
              error: "acp_conversation_deadline_exceeded"
            }
          })
        );
      },
      { timeout: 15_000, interval: 50 }
    );
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), {
      timeout: 5_000,
      interval: 50
    });
    await fixture.service.stop();
  }, 25_000);

  it("retains the permission request identity across recovery and expires an unanswered interaction", async () => {
    const fixture = await setup("load-capable-permission", "unused");
    fixture.service.handle(fixture.command);
    await vi.waitFor(
      () => {
        expect(fixture.state.pendingEvents()).toContainEqual(
          expect.objectContaining({
            turnId: fixture.command.turnId,
            payload: expect.objectContaining({ kind: "interaction" })
          })
        );
      },
      { timeout: 5_000, interval: 25 }
    );
    const interaction = fixture.state
      .pendingEvents()
      .find(
        (event) => event.type === "acp_conversation.event" && event.payload.kind === "interaction"
      );
    expect(interaction).toMatchObject({
      payload: {
        request: {
          kind: "permission",
          options: [{ optionId: "allow", decision: "approve" }]
        }
      }
    });
    const requestsBeforeRecovery = fixture.state
      .pendingEvents()
      .filter(
        (event) => event.type === "acp_conversation.event" && event.payload.kind === "interaction"
      );
    expect(requestsBeforeRecovery).toHaveLength(1);
    fixture.service.recover();
    expect(
      fixture.state
        .pendingEvents()
        .filter(
          (event) => event.type === "acp_conversation.event" && event.payload.kind === "interaction"
        )
    ).toEqual(requestsBeforeRecovery);
    await vi.waitFor(
      () => {
        expect(fixture.state.pendingEvents()).toContainEqual(
          expect.objectContaining({
            turnId: fixture.command.turnId,
            payload: {
              kind: "status",
              status: "failed",
              error: "acp_conversation_deadline_exceeded"
            }
          })
        );
      },
      { timeout: 15_000, interval: 50 }
    );
    expect(fixture.state.pendingEvents()).not.toContainEqual(
      expect.objectContaining({
        turnId: fixture.command.turnId,
        payload: { kind: "status", status: "failed", error: "acp_conversation_host_interrupted" }
      })
    );
    await fixture.service.stop();
  }, 20_000);

  it("uses one deadline across individually short initialize, load, authenticate, and load requests", async () => {
    const fixture = await setup("load-auth-capable", "unused", 950);
    await writeFile(
      join(fixture.directory, "delay-at"),
      "initialize\nsession/load\nauthenticate\n"
    );
    await writeFile(join(fixture.directory, "delay-ms"), "300\n");
    fixture.service.handle(fixture.command);
    await vi.waitFor(
      () => {
        expect(fixture.state.pendingEvents()).toContainEqual(
          expect.objectContaining({
            turnId: fixture.command.turnId,
            payload: {
              kind: "status",
              status: "failed",
              error: "acp_conversation_deadline_exceeded"
            }
          })
        );
      },
      { timeout: 15_000, interval: 50 }
    );
    const lifecycle = await readFile(join(fixture.directory, "lifecycle.log"), "utf8");
    expect(lifecycle).toContain("delay initialize");
    expect(lifecycle).toContain("delay session/load");
    expect(lifecycle).toContain("delay authenticate");
    expect(lifecycle).not.toMatch(/^\d+ session\/prompt$/m);
    await fixture.service.stop();
  }, 20_000);

  it.each([
    ["initialize", "load-capable"],
    ["authenticate", "load-auth-capable"],
    ["session/load", "load-capable"]
  ])(
    "expires while %s is held and reaps the ACP child before releasing the session",
    async (stage, scenario) => {
      const fixture = await setup(scenario, stage);
      fixture.service.handle(fixture.command);
      await vi.waitFor(
        async () => {
          expect(await readFile(join(fixture.directory, "lifecycle.log"), "utf8")).toContain(
            `paused ${stage}`
          );
        },
        { timeout: 5_000, interval: 25 }
      );
      const lifecycle = await readFile(join(fixture.directory, "lifecycle.log"), "utf8");
      const pid = Number(
        lifecycle
          .split("\n")
          .find((line) => line.endsWith(`paused ${stage}`))
          ?.split(" ")[0]
      );
      expect(Number.isSafeInteger(pid)).toBe(true);
      await vi.waitFor(
        () => {
          expect(fixture.state.pendingEvents()).toContainEqual(
            expect.objectContaining({
              turnId: fixture.command.turnId,
              payload: {
                kind: "status",
                status: "failed",
                error: "acp_conversation_deadline_exceeded"
              }
            })
          );
        },
        { timeout: 15_000, interval: 50 }
      );
      expect(fixture.service.isSessionActive(fixture.command.sessionId)).toBe(false);
      expect(await readFile(join(fixture.directory, "lifecycle.log"), "utf8")).not.toMatch(
        /^\d+ session\/prompt$/m
      );
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), {
        timeout: 5_000,
        interval: 50
      });
      await fixture.service.stop();
    },
    25_000
  );
});
