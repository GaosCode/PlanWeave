import { appendFile, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  getGraphViewModel,
  getTaskWorkspace,
  getTaskWorkspaceRunDetail
} from "../desktop/index.js";
import { resetRuntimeState } from "../runSessions/index.js";
import { readJsonFile } from "../json.js";
import { readState } from "../state.js";
import { runAutoRunStep } from "../taskManager/autoRun.js";
import {
  claimNext,
  claimDispatchedBlock,
  createRemoteBlockRuntimePort,
  explainBlock,
  getExecutionStatus,
  resolveBlockDivergence,
  markBlockDiverged,
  getCurrentWork,
  runDoctor,
  remoteBlockFailureInputSchema,
  submitBlockResult,
  unblockBlock
} from "../taskManager/index.js";
import { projectRemoteAcpTimeline } from "../autoRun/remoteAcpEventProjection.js";
import { createTestWorkspace, writeReport } from "./promptTestHelpers.js";

import {
  remoteManifest,
  activeIdentity,
  reportInput,
  claimIdentity,
  activateReadyBlock
} from "./remoteBlockTestHelpers.js";

describe("remote block runtime binding", () => {
  it("keeps remote-owned current work out of local current and claim selection", async () => {
    const { root } = await activateReadyBlock(remoteManifest({ parallel: true }));

    const remoteExecution = {
      identity: { operationId: "operation-001" },
      controlPlane: "collaboration",
      phase: "active",
      status: "owned",
      actionRequired: false,
      source: expect.objectContaining({ revision: expect.any(String) }),
      dispatchAttempt: {
        dispatchId: "dispatch-001",
        executionAttemptId: "attempt-001"
      }
    };
    expect(
      (await getExecutionStatus({ projectRoot: root })).blocks.find(
        (block) => block.ref === "T-001#B-001"
      )?.remoteExecution
    ).toMatchObject(remoteExecution);
    await expect(explainBlock({ projectRoot: root, ref: "T-001#B-001" })).resolves.toMatchObject({
      remoteExecution
    });
    await expect(runDoctor({ projectRoot: root })).resolves.toMatchObject({
      remoteExecutions: [{ ref: "T-001#B-001", execution: remoteExecution }]
    });

    await expect(getCurrentWork({ projectRoot: root })).resolves.toMatchObject({
      currentRefs: ["T-001#B-001"],
      items: [],
      blockingReason: "Current work is remotely owned and cannot be attached as local work."
    });
    await expect(claimNext({ projectRoot: root })).resolves.toEqual({
      kind: "none",
      reason: "no_claimable_blocks"
    });
    await expect(claimNext({ projectRoot: root, parallel: true })).resolves.toEqual({
      kind: "batch",
      refs: ["T-001#B-001"],
      effectiveExecutors: { "T-001#B-001": "codex-acp" },
      reason: "at_capacity"
    });
    const runBlock = vi.fn(async () => {
      throw new Error("remote-owned work must not execute locally");
    });
    const runFeedback = vi.fn(async () => {
      throw new Error("feedback must not execute");
    });
    await expect(
      runAutoRunStep({
        projectRoot: root,
        parallel: true,
        executor: { runBlock, runFeedback }
      })
    ).resolves.toMatchObject({
      kind: "idle",
      claim: { kind: "batch", refs: ["T-001#B-001"], reason: "at_capacity" }
    });
    expect(runBlock).not.toHaveBeenCalled();
    expect(runFeedback).not.toHaveBeenCalled();
    expect((await getExecutionStatus({ projectRoot: root })).currentRefs).toEqual(["T-001#B-001"]);
  });

  it("replays the same operation and rejects foreign preparation or activation", async () => {
    const { root } = await createTestWorkspace(remoteManifest());
    const port = createRemoteBlockRuntimePort({ projectRoot: root });
    const candidate = await port.inspect({ ref: "T-001#B-001" });
    const identity = activeIdentity(candidate);

    const prepared = await port.claim({ ref: "T-001#B-001", ...claimIdentity(identity) });
    expect(await port.claim({ ref: "T-001#B-001", ...claimIdentity(identity) })).toEqual(prepared);
    await expect(
      port.claim({
        ref: "T-001#B-001",
        ...claimIdentity(identity),
        operationId: "operation-foreign"
      })
    ).rejects.toMatchObject({ code: "remote_ownership_operation_conflict" });

    const active = await port.activate({ ref: "T-001#B-001", ...identity });
    expect(await port.activate({ ref: "T-001#B-001", ...identity })).toEqual(active);
    await expect(
      port.activate({
        ref: "T-001#B-001",
        ...identity,
        dispatchId: "dispatch-foreign"
      })
    ).rejects.toMatchObject({ code: "remote_ownership_activation_conflict" });
    await expect(
      port.query({ ref: "T-001#B-001", operationId: "operation-foreign" })
    ).rejects.toMatchObject({ code: "remote_ownership_operation_conflict" });
  });

  it("marks package drift without replacing exact ownership", async () => {
    const { init, port, identity } = await activateReadyBlock();
    await appendFile(
      join(init.workspace.packageDir, "nodes/T-001/blocks/B-001.prompt.md"),
      "\nsource changed\n",
      "utf8"
    );

    const reconciled = await port.reconcile({
      ref: "T-001#B-001",
      operationId: identity.operationId
    });
    expect(reconciled).toMatchObject({
      status: "diverged",
      ownership: identity
    });
    expect(reconciled).not.toHaveProperty("interruption");
    await expect(
      port.complete({
        ref: "T-001#B-001",
        ...identity,
        ...reportInput(Buffer.from("late result\n"))
      })
    ).rejects.toThrow("must be in_progress before submit-result");
  });
});

describe("remote block runtime terminal transitions", () => {
  it("projects remote ACP tool updates through the canonical conversation timeline", () => {
    expect(
      projectRemoteAcpTimeline([
        { cursor: 1, kind: "agent_message", text: "Working remotely" },
        { cursor: 2, kind: "tool_call", callId: "tool-1", title: "Write file", status: "running" },
        { cursor: 3, kind: "tool_call", callId: "tool-1", title: "Write file", status: "completed" }
      ])
    ).toMatchObject([
      { kind: "message", content: "Working remotely" },
      { kind: "tool", callId: "tool-1", title: "Write file", status: "completed" }
    ]);
  });

  it("coalesces streamed remote agent_message chunks into one conversation message", () => {
    expect(
      projectRemoteAcpTimeline([
        { cursor: 1, kind: "agent_message", text: "no " },
        { cursor: 2, kind: "agent_message", text: "trailing " },
        { cursor: 3, kind: "agent_message", text: "newline" }
      ])
    ).toMatchObject([{ kind: "message", content: "no trailing newline" }]);
  });

  it("persists exact report bytes and idempotently replays only the same completion", async () => {
    const { init, port, identity } = await activateReadyBlock();
    const bytes = Buffer.from("# Remote result\n\nExact UTF-8 bytes.\n");
    const input = {
      ref: "T-001#B-001",
      ...identity,
      ...reportInput(bytes)
    };

    await expect(
      port.complete({ ...input, operationId: "operation-foreign" })
    ).rejects.toMatchObject({ code: "remote_ownership_operation_conflict" });
    await expect(
      port.complete({
        ...input,
        reportArtifactRef: `artifact:sha256:${"0".repeat(64)}`
      })
    ).rejects.toMatchObject({ code: "remote_block_result_conflict" });
    await expect(port.complete({ ...input, reportBytes: Buffer.alloc(0) })).rejects.toThrow(
      /must not be empty/i
    );
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    await expect(stat(runRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readState(init.workspace.stateFile)).blocks["T-001#B-001"]).toMatchObject({
      status: "in_progress",
      remoteOwnership: identity
    });
    const completed = await port.complete(input);
    expect(await port.complete(input)).toEqual(completed);
    await expect(
      port.complete({ ...input, operationId: "operation-foreign" })
    ).rejects.toMatchObject({ code: "remote_block_result_conflict" });
    const runDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      completed.runId
    );
    expect(await readFile(join(runDir, "report.md"))).toEqual(bytes);
    const metadata = JSON.parse(await readFile(join(runDir, "metadata.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(metadata).not.toHaveProperty("sourceReportPath");
    expect(metadata).not.toHaveProperty("operationId");
    expect(metadata).not.toHaveProperty("dispatchId");

    const state = await readState(init.workspace.stateFile);
    expect(state.blocks["T-001#B-001"]).toMatchObject({
      status: "completed",
      lastRunId: completed.runId,
      remoteOperationReceipt: {
        outcome: "completed",
        ...identity,
        runId: completed.runId
      }
    });
    expect(state.blocks["T-001#B-001"]).not.toHaveProperty("remoteOwnership");

    await resetRuntimeState({ projectRoot: init.workspace });
    const reset = (await readState(init.workspace.stateFile)).blocks["T-001#B-001"];
    expect(reset.status).toBe("ready");
    expect(reset).not.toHaveProperty("remoteOperationReceipt");
  });

  it("keeps identical reports in distinct remote operation and attempt histories", async () => {
    const { root, init, port, identity } = await activateReadyBlock();
    const ref = "T-001#B-001";
    const bytes = Buffer.from("identical remote result\n");
    const firstInput = { ref, ...identity, ...reportInput(bytes) };
    const first = await port.complete(firstInput);
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    const original = await readFile(join(runRoot, first.runId, "metadata.json"), "utf8");
    await markBlockDiverged({ projectRoot: root, ref, reason: "new operation" });
    await resolveBlockDivergence({ projectRoot: root, ref, reason: "new operation approved" });
    const candidate = await port.inspect({ ref });
    const nextIdentity = {
      ...activeIdentity(candidate),
      operationId: "operation-002",
      dispatchId: "dispatch-002",
      executionAttemptId: "attempt-002"
    };
    await port.claim({ ref, ...claimIdentity(nextIdentity) });
    await port.activate({ ref, ...nextIdentity });
    const stateBefore = await readFile(init.workspace.stateFile, "utf8");
    for (const stale of [
      { dispatchId: identity.dispatchId },
      { executionAttemptId: identity.executionAttemptId }
    ]) {
      await expect(
        port.complete({ ref, ...nextIdentity, ...stale, ...reportInput(bytes) })
      ).rejects.toMatchObject({ code: "remote_ownership_activation_conflict" });
      expect(await readFile(init.workspace.stateFile, "utf8")).toBe(stateBefore);
    }
    const nextInput = {
      ref,
      ...nextIdentity,
      ...reportInput(bytes),
      transcript: {
        ...reportInput(bytes).transcript,
        sessionId: "remote-session-002",
        events: [
          {
            timestamp: "2026-09-27T00:00:00.000Z",
            event: { cursor: 1, kind: "agent_message" as const, text: "second operation evidence" }
          }
        ]
      }
    };
    const second = await port.complete(nextInput);
    expect(second.runId).toBe("RUN-002");
    const secondMetadataBytes = await readFile(
      join(runRoot, second.runId, "metadata.json"),
      "utf8"
    );
    const secondEvents = await readFile(join(runRoot, second.runId, "events.ndjson"), "utf8");
    expect(await port.complete(nextInput)).toEqual(second);
    expect(await readFile(join(runRoot, second.runId, "metadata.json"), "utf8")).toBe(
      secondMetadataBytes
    );
    expect(await readFile(join(runRoot, second.runId, "events.ndjson"), "utf8")).toBe(secondEvents);
    await expect(port.complete(firstInput)).rejects.toMatchObject({
      code: "remote_block_result_conflict"
    });
    expect((await readdir(runRoot)).filter((name) => /^RUN-\d+$/.test(name)).sort()).toEqual([
      "RUN-001",
      "RUN-002"
    ]);
    expect(await readFile(join(runRoot, first.runId, "metadata.json"), "utf8")).toBe(original);
    expect(await readFile(join(runRoot, "RUN-002", "report.md"))).toEqual(bytes);
    const secondMetadata = await readJsonFile<Record<string, unknown>>(
      join(runRoot, "RUN-002", "metadata.json")
    );
    expect(secondMetadata).toMatchObject({
      runId: "RUN-002",
      sessionId: "remote-session-002",
      status: "completed"
    });
    expect(secondMetadata.submissionAttemptId).not.toBe(
      (JSON.parse(original) as Record<string, unknown>).submissionAttemptId
    );
    expect(await readFile(join(runRoot, "RUN-002", "events.ndjson"), "utf8")).toContain(
      "second operation evidence"
    );
    expect(
      await readJsonFile(join(init.workspace.resultsDir, "T-001", "index.json"))
    ).toMatchObject({ latestRunByBlock: { [ref]: "RUN-002" }, counts: { runs: 2 } });
    expect((await readState(init.workspace.stateFile)).blocks[ref]).toMatchObject({
      status: "completed",
      lastRunId: "RUN-002",
      remoteOperationReceipt: { ...nextIdentity, runId: "RUN-002", outcome: "completed" }
    });
  });

  it("materializes remote ACP events as the canonical Task Workspace conversation", async () => {
    const { init, port, identity } = await activateReadyBlock();
    const bytes = Buffer.from("# Remote result\n\nCreated the requested file.\n");
    const completed = await port.complete({
      ref: "T-001#B-001",
      ...identity,
      ...reportInput(bytes),
      transcript: {
        sessionId: "remote-session-001",
        executor: "codex-acp",
        agentId: "codex",
        events: [
          {
            timestamp: "2026-08-05T10:48:45.000Z",
            event: {
              cursor: 1,
              kind: "agent_message",
              text: "I will create the requested file."
            }
          },
          {
            timestamp: "2026-08-05T10:48:48.000Z",
            event: {
              cursor: 2,
              kind: "tool_call",
              callId: "write-file-001",
              title: "Write E:\\code\\planweave-remote-task-a.js",
              status: "completed"
            }
          }
        ]
      }
    });

    const runDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      completed.runId
    );
    const events = await readFile(join(runDir, "events.ndjson"), "utf8");
    expect(events).toContain("I will create the requested file.");
    expect(events).toContain("write-file-001");
    expect(JSON.parse(await readFile(join(runDir, "conversation.json"), "utf8"))).toMatchObject({
      version: "planweave.conversation/v1",
      items: expect.arrayContaining([
        expect.objectContaining({
          kind: "message",
          content: "I will create the requested file."
        })
      ])
    });

    const detail = await getTaskWorkspaceRunDetail({
      projectRoot: init.workspace.rootPath,
      canvasId: "default",
      taskId: "T-001",
      recordId: `T-001#B-001::${completed.runId}`
    });
    expect(detail.record.runnerReadModel?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          timestamp: "2026-08-05T10:48:45.000Z",
          body: expect.objectContaining({
            kind: "message",
            role: "assistant",
            content: "I will create the requested file."
          })
        }),
        expect.objectContaining({
          body: expect.objectContaining({
            kind: "terminal",
            outcome: expect.objectContaining({ state: "succeeded", artifactValidated: true })
          })
        })
      ])
    );
  });

  it("records structured failure, rejects foreign replay, and clears receipt on retry reset", async () => {
    const { init, port, identity } = await activateReadyBlock();
    const failure = {
      code: "executor_failed",
      message: "Remote executor failed.",
      retryable: true
    };
    const input = { ref: "T-001#B-001", ...identity, failure };

    await expect(port.fail({ ...input, operationId: "operation-foreign" })).rejects.toMatchObject({
      code: "remote_ownership_operation_conflict"
    });
    const failed = await port.fail(input);
    expect(failed.retryDecision).toBe("manual_retry_required");
    expect(await port.fail(input)).toEqual(failed);
    await expect(port.fail({ ...input, operationId: "operation-foreign" })).rejects.toMatchObject({
      code: "remote_ownership_terminal_conflict"
    });
    const failedState = (await readState(init.workspace.stateFile)).blocks["T-001#B-001"];
    expect(failedState).toMatchObject({
      status: "blocked",
      blockedReason: "[executor_failed] Remote executor failed.",
      remoteOperationReceipt: { outcome: "failed", ...identity, failure }
    });
    expect(failedState?.lastRunId).toMatch(/^RUN-/);
    const failedRunDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      failedState!.lastRunId!
    );
    await expect(stat(failedRunDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(readFile(join(failedRunDir, "metadata.json"), "utf8")).resolves.toContain(
      "executor_failed"
    );

    await unblockBlock({
      projectRoot: init.workspace,
      ref: "T-001#B-001",
      reason: "Operator approved a new operation generation."
    });
    const reset = (await readState(init.workspace.stateFile)).blocks["T-001#B-001"];
    expect(reset.status).toBe("ready");
    expect(reset).not.toHaveProperty("remoteOperationReceipt");
  });

  it("labels materialized remote failure runs with the endpoint agentId", async () => {
    const { init, port, identity } = await activateReadyBlock();
    await port.fail({
      ref: "T-001#B-001",
      ...identity,
      agentId: "grok",
      failure: {
        code: "remote_execution_failed",
        message: "Remote execution failed.",
        retryable: false
      }
    });
    const lastRunId = (await readState(init.workspace.stateFile)).blocks["T-001#B-001"]?.lastRunId;
    expect(lastRunId).toMatch(/^RUN-/);
    const metadata = JSON.parse(
      await readFile(
        join(
          init.workspace.resultsDir,
          "T-001",
          "blocks",
          "B-001",
          "runs",
          lastRunId!,
          "metadata.json"
        ),
        "utf8"
      )
    ) as { agentId: string; executor: string };
    expect(metadata).toMatchObject({ agentId: "grok", executor: "grok" });
  });

  it.each([
    ["/tmp/private/token.db", "executor_failed", "Remote executor failed.", true],
    [
      "https://internal.example:8443/debug",
      "acp_capability_missing",
      "Remote ACP capability is missing.",
      true
    ],
    [
      "host cancelled at /tmp/private",
      "execution_cancelled",
      "Remote execution was cancelled.",
      false
    ],
    ["lease row in internal db", "lease_expired", "Remote execution lease expired.", true],
    [
      "table users_credentials in postgres",
      "persistence_failed",
      "Remote persistence failed.",
      false
    ],
    ["token=secret-value-123", "authentication_failed", "Remote authentication failed.", false],
    [
      "agent stopped after side effect",
      "acp_incomplete_response",
      "Remote ACP execution ended without a complete response.",
      false
    ],
    ["private process details", "acp_process_error", "Remote ACP process failed.", true],
    ["private protocol frame", "acp_protocol_error", "Remote ACP protocol failed.", false],
    ["private elapsed timing", "acp_operation_timeout", "Remote ACP execution timed out.", true],
    [
      "private missing report diagnostic",
      "report_output_missing",
      "Remote ACP execution completed without report output.",
      true
    ],
    [
      "private oversized report diagnostic",
      "report_output_too_large",
      "Remote ACP report output exceeded its artifact contract.",
      false
    ],
    [
      "ACP execution failed. provider usage limit exceeded",
      "acp_unknown_error",
      "ACP execution failed. provider usage limit exceeded",
      false
    ],
    [
      "ACP execution failed. /Users/private/token.db",
      "acp_unknown_error",
      "ACP execution failed.",
      false
    ],
    ["ordinary host diagnostic", "token_secret_failure", "Remote execution failed.", false]
  ])("maps private failure diagnostic %s to a stable public contract", async (rawMessage, inputCode, publicMessage, retryable) => {
    const { root, init, port, identity } = await activateReadyBlock();
    const code = inputCode === "token_secret_failure" ? "remote_execution_failed" : inputCode;
    const input = {
      ref: "T-001#B-001",
      ...identity,
      failure: { code: inputCode, message: rawMessage, retryable }
    };

    expect(remoteBlockFailureInputSchema.parse(input).failure).toEqual({
      code,
      message: publicMessage,
      retryable
    });
    const result = await port.fail(input);
    expect(result.binding).toMatchObject({
      blockedReason: `[${code}] ${publicMessage}`,
      terminalReceipt: {
        outcome: "failed",
        failure: { code, message: publicMessage, retryable }
      }
    });
    if (rawMessage !== publicMessage) {
      expect(JSON.stringify(result)).not.toContain(rawMessage);
      expect(JSON.stringify(await readState(init.workspace.stateFile))).not.toContain(rawMessage);
    }

    const replayDiagnostic =
      rawMessage === publicMessage
        ? rawMessage
        : inputCode === "acp_unknown_error"
          ? "ACP execution failed. /Users/private/other-token.db"
          : `different private diagnostic for ${inputCode}`;
    const replay = await port.fail({
      ...input,
      failure: {
        ...input.failure,
        code: inputCode === "token_secret_failure" ? "another_private_failure" : inputCode,
        message: replayDiagnostic
      }
    });
    expect(replay).toEqual(result);

    const surfaces = [
      await getExecutionStatus({ projectRoot: root }),
      await explainBlock({ projectRoot: root, ref: input.ref }),
      await runDoctor({ projectRoot: root }),
      await getGraphViewModel(root),
      await getTaskWorkspace({
        projectRoot: root,
        canvasId: "default",
        taskId: "T-001"
      })
    ];
    for (const surface of surfaces) {
      const serialized = JSON.stringify(surface);
      if (rawMessage !== publicMessage) {
        expect(serialized).not.toContain(rawMessage);
      }
      if (replayDiagnostic !== publicMessage) {
        expect(serialized).not.toContain(replayDiagnostic);
      }
    }
  });

  it("distinguishes resumable interruption from source drift and permits exact completion", async () => {
    const { root, port, identity } = await activateReadyBlock();
    const interrupted = await port.markInterrupted({
      ref: "T-001#B-001",
      ...identity,
      interruption: { reason: "transport_lost", resumable: true }
    });
    expect(interrupted.retryDecision).toBe("resume_exact_attempt");
    expect(interrupted.binding).toMatchObject({
      status: "diverged",
      ownership: identity,
      interruption: { reason: "transport_lost", resumable: true }
    });
    expect(await port.reconcile({ ref: "T-001#B-001", operationId: identity.operationId })).toEqual(
      interrupted.binding
    );
    expect((await runDoctor({ projectRoot: root })).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "remote_ownership_interrupted", ref: "T-001#B-001" })
      ])
    );

    const completed = await port.complete({
      ref: "T-001#B-001",
      ...identity,
      ...reportInput(Buffer.from("resumed exact attempt\n"))
    });
    expect(completed.status).toBe("completed");
    const terminal = await port.query({
      ref: "T-001#B-001",
      operationId: identity.operationId
    });
    expect(terminal).toMatchObject({
      status: "completed",
      terminalReceipt: { outcome: "completed", ...identity }
    });
    expect(terminal).not.toHaveProperty("interruption");
  });

  it("fences manual retry replays by active identity and current source", async () => {
    const { init, port, identity } = await activateReadyBlock();
    await port.markInterrupted({
      ref: "T-001#B-001",
      ...identity,
      interruption: { reason: "acp_session_lost", resumable: false }
    });

    const retry = {
      ref: "T-001#B-001",
      ...identity,
      newDispatchId: "dispatch-002",
      newExecutionAttemptId: "attempt-002"
    };
    const retried = await port.retryAttempt(retry);
    expect(retried).toMatchObject({
      status: "in_progress",
      ownership: { ...identity, dispatchId: "dispatch-002", executionAttemptId: "attempt-002" }
    });
    expect(retried).not.toHaveProperty("interruption");
    expect(retried).not.toHaveProperty("divergenceReason");
    await expect(port.retryAttempt(retry)).resolves.toEqual(retried);

    const stateBeforeDrift = await readFile(init.workspace.stateFile, "utf8");
    const promptPath = join(init.workspace.packageDir, "nodes/T-001/prompt.md");
    const originalPrompt = await readFile(promptPath, "utf8");
    await appendFile(promptPath, "\nchanged after retry\n");
    await expect(
      port.retryAttempt({
        ...retry,
        newDispatchId: "dispatch-003",
        newExecutionAttemptId: "attempt-003"
      })
    ).rejects.toMatchObject({ code: "remote_ownership_activation_conflict" });
    await expect(
      port.retryAttempt({ ...retry, operationId: "operation-foreign" })
    ).rejects.toMatchObject({ code: "remote_ownership_operation_conflict" });
    expect(await readFile(init.workspace.stateFile, "utf8")).toBe(stateBeforeDrift);

    await expect(port.retryAttempt(retry)).rejects.toMatchObject({
      code: "remote_block_source_changed"
    });
    await expect(port.query({ ref: retry.ref, operationId: retry.operationId })).resolves.toEqual({
      ...retried,
      status: "diverged",
      divergenceReason: expect.stringContaining("Remote source changed")
    });

    const divergedState = await readFile(init.workspace.stateFile, "utf8");
    const divergedFile = await stat(init.workspace.stateFile);
    await expect(port.retryAttempt(retry)).rejects.toMatchObject({
      code: "remote_block_source_changed"
    });
    await expect(
      port.retryAttempt({ ...retry, operationId: "operation-foreign" })
    ).rejects.toMatchObject({ code: "remote_ownership_operation_conflict" });
    await writeFile(promptPath, originalPrompt, "utf8");
    await expect(port.retryAttempt(retry)).rejects.toMatchObject({
      code: "remote_ownership_status_conflict"
    });
    expect(await readFile(init.workspace.stateFile, "utf8")).toBe(divergedState);
    expect(await stat(init.workspace.stateFile)).toMatchObject({
      ino: divergedFile.ino,
      mtimeMs: divergedFile.mtimeMs
    });
  });

  it("resumes only the exact resumable attempt and clears only its active interruption marker", async () => {
    const { port, identity } = await activateReadyBlock();
    await port.markInterrupted({
      ref: "T-001#B-001",
      ...identity,
      interruption: { reason: "transport_lost", resumable: true }
    });
    await expect(
      port.resumeAttempt({
        ref: "T-001#B-001",
        ...identity,
        executionAttemptId: "attempt-stale"
      })
    ).rejects.toMatchObject({ code: "remote_ownership_activation_conflict" });
    const stillInterrupted = await port.query({
      ref: "T-001#B-001",
      operationId: identity.operationId
    });
    expect(stillInterrupted).toMatchObject({
      status: "diverged",
      interruption: { reason: "transport_lost", resumable: true }
    });

    const resumed = await port.resumeAttempt({ ref: "T-001#B-001", ...identity });
    expect(resumed).toMatchObject({ status: "in_progress", ownership: identity });
    expect(resumed).not.toHaveProperty("interruption");
    expect(resumed).not.toHaveProperty("divergenceReason");
  });

  it("keeps a non-resumable interruption marker when resume is rejected", async () => {
    const { port, identity } = await activateReadyBlock();
    await port.markInterrupted({
      ref: "T-001#B-001",
      ...identity,
      interruption: { reason: "acp_session_lost", resumable: false }
    });
    await expect(port.resumeAttempt({ ref: "T-001#B-001", ...identity })).rejects.toMatchObject({
      code: "remote_ownership_status_conflict"
    });
    await expect(
      port.query({ ref: "T-001#B-001", operationId: identity.operationId })
    ).resolves.toMatchObject({
      status: "diverged",
      interruption: { reason: "acp_session_lost", resumable: false }
    });
  });

  it("rejects retry for resumable interruption and changed source evidence", async () => {
    const resumable = await activateReadyBlock();
    await resumable.port.markInterrupted({
      ref: "T-001#B-001",
      ...resumable.identity,
      interruption: { reason: "transport_lost", resumable: true }
    });
    await expect(
      resumable.port.retryAttempt({
        ref: "T-001#B-001",
        ...resumable.identity,
        newDispatchId: "dispatch-002",
        newExecutionAttemptId: "attempt-002"
      })
    ).rejects.toMatchObject({ code: "remote_ownership_status_conflict" });

    const drifted = await activateReadyBlock();
    await drifted.port.markInterrupted({
      ref: "T-001#B-001",
      ...drifted.identity,
      interruption: { reason: "acp_session_lost", resumable: false }
    });
    await appendFile(
      join(drifted.init.workspace.packageDir, "nodes/T-001/blocks/B-001.prompt.md"),
      "\nchanged before retry\n",
      "utf8"
    );
    await expect(
      drifted.port.retryAttempt({
        ref: "T-001#B-001",
        ...drifted.identity,
        newDispatchId: "dispatch-002",
        newExecutionAttemptId: "attempt-002"
      })
    ).rejects.toMatchObject({ code: "remote_block_source_changed" });
  });

  it("clears interrupted ownership only through explicit divergence resolution", async () => {
    const { root, init, port, identity } = await activateReadyBlock();
    await port.markInterrupted({
      ref: "T-001#B-001",
      ...identity,
      interruption: { reason: "acp_session_lost", resumable: false }
    });

    await resolveBlockDivergence({
      projectRoot: root,
      ref: "T-001#B-001",
      reason: "Operator chose a new operation generation."
    });
    const resolved = (await readState(init.workspace.stateFile)).blocks["T-001#B-001"];
    expect(resolved.status).toBe("ready");
    expect(resolved).not.toHaveProperty("remoteOwnership");
    expect(resolved).not.toHaveProperty("remoteInterruption");
    expect(resolved).not.toHaveProperty("remoteOperationReceipt");
  });

  it.each([
    "acp_session_lost",
    "lease_lost"
  ] as const)("rejects non-resumable %s completion before reusing an identical historical run", async (reason) => {
    const historicalBytes = Buffer.from("historical identical result\n");
    const { root, init } = await createTestWorkspace(remoteManifest());
    await claimDispatchedBlock({ projectRoot: root, ref: "T-001#B-001" });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "historical.md", historicalBytes.toString("utf8"))
    });
    await resetRuntimeState({ projectRoot: root });

    const port = createRemoteBlockRuntimePort({ projectRoot: root });
    const candidate = await port.inspect({ ref: "T-001#B-001" });
    const identity = activeIdentity(candidate);
    await port.claim({ ref: "T-001#B-001", ...claimIdentity(identity) });
    await port.activate({ ref: "T-001#B-001", ...identity });
    await port.markInterrupted({
      ref: "T-001#B-001",
      ...identity,
      interruption: { reason, resumable: false }
    });
    const stateBefore = await readFile(init.workspace.stateFile, "utf8");
    const indexPath = join(init.workspace.resultsDir, "T-001", "index.json");
    const indexBefore = await readFile(indexPath, "utf8");

    await expect(
      port.complete({
        ref: "T-001#B-001",
        ...identity,
        ...reportInput(historicalBytes)
      })
    ).rejects.toThrow("must be in_progress before submit-result");
    expect(await readFile(init.workspace.stateFile, "utf8")).toBe(stateBefore);
    expect(await readFile(indexPath, "utf8")).toBe(indexBefore);
  });

  it("rejects source-diverged remote completion without an interruption before historical lookup", async () => {
    const historicalBytes = Buffer.from("historical source-diverged result\n");
    const { root, init } = await createTestWorkspace(remoteManifest());
    await claimDispatchedBlock({ projectRoot: root, ref: "T-001#B-001" });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "historical-source.md", historicalBytes.toString("utf8"))
    });
    await resetRuntimeState({ projectRoot: root });

    const port = createRemoteBlockRuntimePort({ projectRoot: root });
    const candidate = await port.inspect({ ref: "T-001#B-001" });
    const identity = activeIdentity(candidate);
    await port.claim({ ref: "T-001#B-001", ...claimIdentity(identity) });
    await port.activate({ ref: "T-001#B-001", ...identity });
    await appendFile(
      join(init.workspace.packageDir, "nodes/T-001/blocks/B-001.prompt.md"),
      "\nsource diverged without interruption\n",
      "utf8"
    );
    const diverged = await port.reconcile({
      ref: "T-001#B-001",
      operationId: identity.operationId
    });
    expect(diverged).toMatchObject({ status: "diverged", ownership: identity });
    expect(diverged).not.toHaveProperty("interruption");
    const stateBefore = await readFile(init.workspace.stateFile, "utf8");
    const indexPath = join(init.workspace.resultsDir, "T-001", "index.json");
    const indexBefore = await readFile(indexPath, "utf8");

    await expect(
      port.complete({
        ref: "T-001#B-001",
        ...identity,
        ...reportInput(historicalBytes)
      })
    ).rejects.toThrow("must be in_progress before submit-result");
    expect(await readFile(init.workspace.stateFile, "utf8")).toBe(stateBefore);
    expect(await readFile(indexPath, "utf8")).toBe(indexBefore);
  });
});
